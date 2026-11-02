import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, _electron } from 'playwright';
import { createApi } from '../apps/api/server.ts';
import { createLocalAgent } from '../apps/agent/server.ts';
import { Store } from '../packages/shared/store.ts';
import desktop from '../apps/desktop/proxy.cjs';
// Browser plugin not available. Both modes use isolated profiles; native mode
// owns the real Electron utilityProcess Agent. Only the OS picker result is mocked.
const native = process.argv.includes('--electron'),
  require = createRequire(import.meta.url);
const root = await mkdtemp(join(tmpdir(), 'lightmao-skills-ui-')),
  dataDir = join(root, 'runtime'),
  folder = join(root, 'game-review');
const artifacts = resolve(
  process.env.LIGHTMAO_QA_ARTIFACT_DIR || join(tmpdir(), `lightmao-skills-artifacts-${Date.now()}`),
);
await mkdir(artifacts, { recursive: true });
await mkdir(folder);
const source = `---\nname: game-review\ndescription: Review game files using the bundled checklist.\n---\n# SKILL_UI_CANARY\n先读取 references/checklist.md，再检查项目，区分静态检查与引擎执行。\n`;
const reference =
  'REFERENCE_FIRST_MARKER\n' +
  '检查命名、导入设置和授权范围。\n'.repeat(300) +
  'REFERENCE_MIDDLE_MARKER\n' +
  '检查尚未验证的事项。\n'.repeat(300);
const entries = [
  ['SKILL.md', Buffer.from(source)],
  ['references/checklist.md', Buffer.from(reference)],
  [
    'scripts/example.mjs',
    Buffer.from(
      `import { writeFileSync } from 'node:fs';writeFileSync(${JSON.stringify(join(root, 'executed.flag'))},'MUST_NOT_RUN');`,
    ),
  ],
  [
    'assets/sample.gif',
    Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64'),
  ],
];
for (const [path, bytes] of entries) {
  await mkdir(join(folder, path, '..'), { recursive: true });
  await writeFile(join(folder, path), bytes);
}
const api = await createApi({ dataDir, demo: true });
await api.app.listen({ host: '127.0.0.1', port: 0 });
const apiBase = `http://127.0.0.1:${api.app.server.address().port}`;
let local, proxy, browser, app, page, db, base;
const errors = [],
  responses = [],
  completed = [];
let expectedFailure = false;
const record = (name) => {
  completed.push(name);
  console.log(JSON.stringify({ passed: name }));
};
const shot = (name) =>
  page.screenshot({
    path: join(artifacts, `${name}.jpg`),
    type: 'jpeg',
    quality: 85,
    animations: 'disabled',
  });
async function until(check, message) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await delay(40);
  }
  throw new Error(message);
}
async function navigate(label) {
  const toggle = page.getByRole('button', { name: '展开导航', exact: true });
  if (await toggle.isVisible()) await toggle.click();
  await page.getByRole('button', { name: label, exact: true }).click();
}
async function importFolder() {
  if (native) await page.getByRole('button', { name: '导入技能包', exact: true }).click();
  else {
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '导入技能包', exact: true }).click();
    await (await chooser).setFiles(folder);
  }
  await page.getByRole('dialog').getByRole('button', { name: '确认导入', exact: true }).waitFor();
}
try {
  if (native) {
    const server = createServer();
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const port = server.address().port;
    await new Promise((done) => server.close(done));
    const env = {
      ...process.env,
      LIGHTMAO_API_URL: apiBase,
      LIGHTMAO_DATA_DIR: dataDir,
      AGENT_PORT: String(port),
      LIGHTMAO_QA_PROFILE: join(root, 'profile'),
    };
    for (const key of Object.keys(env))
      if (/^(ARK_|OSS_|DOUBAO_|LIGHTMAO_ADMIN_)/.test(key)) delete env[key];
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({
      executablePath: require('electron'),
      args: ['scripts/qa-desktop-entry.cjs'],
      cwd: resolve('.'),
      env,
      timeout: 30000,
    });
    page = await app.firstWindow();
    await app.evaluate(({ dialog }, folder) => {
      globalThis.skillPickers = [];
      dialog.showOpenDialog = async (_, options) => {
        globalThis.skillPickers.push(options);
        return { canceled: false, filePaths: [folder] };
      };
    }, folder);
  } else {
    local = await createLocalAgent({ dataDir, apiUrl: apiBase, tickMs: 60000 });
    await local.app.listen({ host: '127.0.0.1', port: 0 });
    proxy = desktop.createDesktopServer({
      webRoot: resolve('dist/web'),
      apiBase,
      agentBase: `http://127.0.0.1:${local.app.server.address().port}`,
    });
    await new Promise((done) => proxy.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${proxy.address().port}`;
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  }
  page.setDefaultTimeout(12000);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (
      response.status() >= 400 &&
      !(response.status() === 401 && path === '/api/auth/refresh') &&
      !expectedFailure
    )
      responses.push({ path, status: response.status() });
  });
  if (!native) await page.goto(base);
  await page.getByRole('navigation', { name: '主导航' }).waitFor();
  base = page.url();
  assert.equal(await page.title(), 'LightMao · 游戏创作工作台');
  assert((await page.locator('body').innerText()).length > 100);
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  if (native) {
    const status = await page.evaluate(() => window.lightmaoDesktop.runtimeStatus());
    assert(status.ownsAgent && status.agentOnline);
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  }
  const auth = await fetch(apiBase + '/api/auth/demo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }).then((r) => r.json());
  db = new Store(join(dataDir, 'local.sqlite'));
  const owner = auth.user.id;
  const initialCloudSkills = api.store.list('skill', owner).length,
    initialCloudAssets = api.store.list('asset', owner).length;
  await navigate('技能');
  await page.getByRole('button', { name: '创建技能', exact: true }).click();
  let modal = page.getByRole('dialog');
  await modal.getByLabel('技能名称', { exact: true }).fill('云端检查手册');
  await modal.getByLabel('分类', { exact: true }).selectOption('程序');
  await modal.getByLabel('一句话描述', { exact: true }).fill('验证云端 Markdown 编辑与启停');
  await modal
    .getByRole('textbox', { name: /技能内容/ })
    .fill('# CLOUD_UI_BODY\n验证时保留技能的启停状态。');
  await modal.getByRole('button', { name: '保存技能', exact: true }).click();
  let cloudRow = page
    .locator('.skill-row')
    .filter({ has: page.getByRole('heading', { name: '云端检查手册', exact: true }) });
  await cloudRow.waitFor();
  await cloudRow.getByRole('switch').click();
  await until(
    async () => (await cloudRow.getByRole('switch').getAttribute('aria-checked')) === 'false',
    'Cloud toggle did not disable',
  );
  await cloudRow.getByRole('button', { name: '编辑云端检查手册', exact: true }).click();
  modal = page.getByRole('dialog');
  await modal
    .getByRole('textbox', { name: /技能内容/ })
    .fill('# CLOUD_UI_EDITED\n编辑后仍保持停用。');
  await modal.getByRole('button', { name: '保存技能', exact: true }).click();
  await cloudRow.waitFor();
  assert.equal(await cloudRow.getByRole('switch').getAttribute('aria-checked'), 'false');
  assert(await cloudRow.getByText('程序', { exact: true }).isVisible());
  record(
    'Cloud Markdown create, lazy editor detail, disable and edit preserve category and disabled state',
  );
  await importFolder();
  modal = page.getByRole('dialog');
  await modal.getByLabel('显示名称', { exact: true }).fill('项目检查手册');
  await modal.getByLabel('分类', { exact: true }).selectOption('测试');
  await modal.getByText('查看 SKILL.md 指引', { exact: true }).click();
  await modal.locator('pre').filter({ hasText: 'SKILL_UI_CANARY' }).waitFor();
  assert.equal(await modal.locator('.skill-import-files > div').count(), 4);
  await shot('skill-import-preview');
  await modal.getByRole('button', { name: '确认导入', exact: true }).click();
  await page.getByText('技能包已导入', { exact: true }).waitFor();
  await page.getByRole('button', { name: /^本机/ }).click();
  let row = page
    .locator('.skill-row')
    .filter({ has: page.getByRole('heading', { name: '项目检查手册', exact: true }) });
  await row.waitFor();
  await row.getByText(/本机技能包.*4 个文件/).waitFor();
  const id = db.list('local-skill', owner)[0].id;
  assert.equal(api.store.list('skill', owner).length, initialCloudSkills + 1);
  assert.equal(api.store.list('asset', owner).length, initialCloudAssets);
  assert.equal(await readFile(join(folder, 'SKILL.md'), 'utf8'), source);
  if (native)
    assert.equal(
      (await app.evaluate(() => globalThis.skillPickers))[0].title,
      '导入本机 SKILL.md 技能包',
    );
  record(
    native
      ? 'Actual native picker IPC imports an OS-isolated directory snapshot into local storage; the cloud only retains its Markdown entries'
      : 'Browser directory input prepares and confirms a local skill snapshot; files do not become cloud assets',
  );
  await row.getByRole('button', { name: '查看技能资源项目检查手册', exact: true }).click();
  modal = page.getByRole('dialog');
  await modal.locator('pre').filter({ hasText: 'SKILL_UI_CANARY' }).waitFor();
  await modal
    .getByRole('combobox', { name: '资源文件', exact: true })
    .selectOption('references/checklist.md');
  await modal.locator('pre').filter({ hasText: 'REFERENCE_FIRST_MARKER' }).waitFor();
  await modal.getByRole('button', { name: '继续读取', exact: true }).click();
  await modal.locator('pre').filter({ hasText: 'REFERENCE_MIDDLE_MARKER' }).waitFor();
  assert.equal(await modal.locator('pre').innerText(), reference.slice(0, 8000));
  await shot('skill-resource-text');
  if (native) {
    const destination = join(artifacts, 'downloaded-checklist.md');
    await app.evaluate(({ BrowserWindow }, destination) => {
      BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_, item) =>
        item.setSavePath(destination),
      );
    }, destination);
    await modal.getByRole('button', { name: '下载文件', exact: true }).click();
    await until(
      async () =>
        await stat(destination)
          .then((s) => s.size === Buffer.byteLength(reference))
          .catch(() => false),
      'Native resource download did not finish',
    );
    assert.equal(await readFile(destination, 'utf8'), reference);
  } else {
    const download = page.waitForEvent('download');
    await modal.getByRole('button', { name: '下载文件', exact: true }).click();
    assert.equal(await readFile(await (await download).path(), 'utf8'), reference);
  }
  await modal
    .getByRole('combobox', { name: '资源文件', exact: true })
    .selectOption('scripts/example.mjs');
  await modal.locator('pre').filter({ hasText: 'MUST_NOT_RUN' }).waitFor();
  assert.equal(
    await stat(join(root, 'executed.flag'))
      .then(() => true)
      .catch(() => false),
    false,
  );
  await modal
    .getByRole('combobox', { name: '资源文件', exact: true })
    .selectOption('assets/sample.gif');
  await modal.getByRole('img').waitFor();
  await until(
    () => modal.getByRole('img').evaluate((image) => image.complete && image.naturalWidth === 1),
    'Image resource did not decode',
  );
  await modal.getByRole('button', { name: '关闭', exact: true }).click();
  record(
    'Resources page text, page continuation, exact download, script-as-text preview and authenticated image decoding work',
  );
  await writeFile(join(folder, 'SKILL.md'), source.replace('SKILL_UI_CANARY', 'SKILL_UI_V2'));
  if (native)
    await row.getByRole('button', { name: '更新技能包项目检查手册', exact: true }).click();
  else {
    await row.getByRole('button', { name: '更新技能包项目检查手册', exact: true }).click();
    await page.getByLabel('选择技能包目录', { exact: true }).setInputFiles(folder);
  }
  modal = page.getByRole('dialog');
  await modal.getByRole('button', { name: '确认更新', exact: true }).click();
  await page.getByText('技能包已导入', { exact: true }).waitFor();
  assert.equal(db.list('local-skill', owner).length, 1);
  assert.equal(db.list('local-skill', owner)[0].id, id);
  assert.equal(db.list('local-skill', owner)[0].revision, 2);
  await row.getByRole('button', { name: '编辑项目检查手册', exact: true }).click();
  modal = page.getByRole('dialog');
  await modal
    .getByRole('textbox', { name: /技能内容/ })
    .fill(source.replace('SKILL_UI_CANARY', 'SKILL_UI_EDITED'));
  await modal.getByRole('button', { name: '保存技能', exact: true }).click();
  await row.waitFor();
  assert.equal(db.list('local-skill', owner)[0].fileCount, 4);
  await shot('skills-local-desktop');
  record(
    'Package replacement retains its ID; SKILL.md editing creates a new version and preserves companion resources',
  );
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await page.getByRole('textbox', { name: '发送消息', exact: true }).waitFor();
  await page.getByRole('button', { name: '添加技能或资料', exact: true }).click();
  modal = page.getByRole('dialog');
  await modal.getByRole('checkbox', { name: /项目检查手册/ }).check();
  await modal.getByRole('button', { name: '完成选择', exact: true }).click();
  await page.getByRole('textbox', { name: '发送消息', exact: true }).fill('按所选手册检查项目结构');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await until(
    () =>
      db
        .list('run', owner)
        .some((run) => run.prompt === '按所选手册检查项目结构' && run.status === 'completed'),
    'Selected skill run did not finish',
  );
  const run = db.list('run', owner).find((run) => run.prompt === '按所选手册检查项目结构');
  assert.equal(run.toolErrorCount, 0);
  const detail = db
    .list('tool-detail', owner)
    .find((detail) => detail.runId === run.id && detail.name === 'read_skill_resource');
  assert(detail.summary.includes('SKILL_UI_EDITED'));
  const trace = page.locator('.execution-toggle').last();
  await trace.waitFor();
  assert.equal(await trace.getAttribute('aria-expanded'), 'false');
  await trace.click();
  await page.getByText('读取所选技能资源', { exact: false }).first().waitFor();
  await shot('skill-selected-execution');
  record(
    'Composer selects the local skill; actual Pi reads its edited version and execution is collapsed until expanded',
  );
  await navigate('技能');
  await page.getByRole('button', { name: /^本机/ }).click();
  row = page
    .locator('.skill-row')
    .filter({ has: page.getByRole('heading', { name: '项目检查手册', exact: true }) });
  await row.getByRole('switch').click();
  await until(
    async () => (await row.getByRole('switch').getAttribute('aria-checked')) === 'false',
    'Local toggle did not disable',
  );
  await page.reload();
  await page.getByRole('navigation', { name: '主导航' }).waitFor();
  await navigate('技能');
  await page.getByRole('button', { name: /^本机/ }).click();
  row = page
    .locator('.skill-row')
    .filter({ has: page.getByRole('heading', { name: '项目检查手册', exact: true }) });
  await row.waitFor();
  assert.equal(await row.getByRole('switch').getAttribute('aria-checked'), 'false');
  if (!native) {
    await page.setViewportSize({ width: 390, height: 844 });
    await until(
      () =>
        page.locator('.sidebar-holder').evaluate((node) => node.getBoundingClientRect().right <= 0),
      'Mobile navigation did not collapse',
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    for (const name of [
      '导入技能包',
      '导入 Markdown',
      '创建技能',
      '查看技能资源项目检查手册',
      '更新技能包项目检查手册',
      '编辑项目检查手册',
    ]) {
      const box = await page.getByRole('button', { name, exact: true }).boundingBox();
      assert(box && box.x >= 0 && box.x + box.width <= 390, `${name} must be inside viewport`);
    }
    await shot('skills-local-mobile');
    await row.getByRole('button', { name: '查看技能资源项目检查手册', exact: true }).click();
    modal = page.getByRole('dialog');
    await modal.locator('pre').filter({ hasText: 'SKILL_UI_EDITED' }).waitFor();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await shot('skill-resource-mobile');
    await modal.getByRole('button', { name: '关闭', exact: true }).click();
    record(
      '390px list controls and resource preview stay visible; reload preserves disabled package state',
    );
  }
  await row.getByRole('button', { name: '编辑项目检查手册', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '删除技能', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认删除', exact: true }).click();
  await page.getByText('技能已删除', { exact: true }).waitFor();
  assert.equal(db.list('local-skill', owner).length, 0);
  assert(db.get('run', run.id, owner));
  assert(db.list('tool-detail', owner).some((detail) => detail.runId === run.id));
  record(
    'Deleting the package removes future access while preserving the prior session and tool archive',
  );
  await importFolder();
  assert.equal(db.list('skill-stage', owner).filter((stage) => !stage.importedId).length, 1);
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  await until(
    () => db.list('skill-stage', owner).filter((stage) => !stage.importedId).length === 0,
    'Cancelled preview did not discard staging data',
  );
  assert.equal(db.list('local-skill', owner).length, 0);
  record(
    'Cancelling a directory preview discards its unconfirmed snapshot and leaves installed state unchanged',
  );
  await page.getByLabel('选择 Markdown 技能', { exact: true }).setInputFiles({
    name: '单文件流程.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# MARKDOWN_IMPORT_CANARY\n先检查事实，再给出建议。'),
  });
  modal = page.getByRole('dialog');
  assert.equal(await modal.getByLabel('技能名称', { exact: true }).inputValue(), '单文件流程');
  assert(
    (await modal.getByRole('textbox', { name: /技能内容/ }).inputValue()).includes(
      'MARKDOWN_IMPORT_CANARY',
    ),
  );
  await modal.getByRole('button', { name: '保存技能', exact: true }).click();
  await page.getByText('技能已保存', { exact: true }).waitFor();
  await page.getByRole('button', { name: /^云端/ }).click();
  await page.getByRole('heading', { name: '单文件流程', exact: true }).waitFor();
  assert(
    api.store
      .list('skill', owner)
      .some(
        (skill) => skill.name === '单文件流程' && skill.content.includes('MARKDOWN_IMPORT_CANARY'),
      ),
  );
  record(
    'Markdown file import opens a reviewable editor and persists the confirmed guide to the account',
  );
  assert.equal(
    await stat(join(root, 'executed.flag'))
      .then(() => true)
      .catch(() => false),
    false,
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(responses, []);
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
} catch (error) {
  process.exitCode = 1;
  console.error(error.stack);
  await shot('failure').catch(() => {});
} finally {
  db?.close();
  await browser?.close();
  await app?.close();
  if (proxy) await new Promise((done) => proxy.close(done));
  await local?.app.close();
  api.app.server.closeAllConnections();
  await api.app.close();
  await writeFile(
    join(artifacts, 'receipt.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        passed: !process.exitCode,
        native,
        completed,
        errors,
        responses,
        artifacts,
        scope: native
          ? 'Actual Electron/utilityProcess/preload/IPC and sandboxed snapshot; OS picker result substituted'
          : 'Browser plugin not available; isolated Playwright Chromium, desktop proxy and real Pi demo tools',
      },
      null,
      2,
    ),
  );
  await rm(root, { recursive: true, force: true });
}
