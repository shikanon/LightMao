import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, access } from 'node:fs/promises';
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
// Browser plugin not available. The target flow is: Engine page -> sample ->
// explicit project authorization -> actual Godot test -> logs/artifacts -> stop.
// Native mode uses its own Electron profile; only the OS chooser result is substituted.
const native = process.argv.includes('--electron'),
  require = createRequire(import.meta.url);
const godotPath = resolve(
  process.env.LIGHTMAO_TEST_GODOT_PATH || '.lightmao/tools/godot/4.7.2/Godot.app',
);
await access(godotPath);
const root = await mkdtemp(join(tmpdir(), 'lightmao-engine-ui-')),
  dataDir = join(root, 'runtime');
const artifacts = resolve(
  process.env.LIGHTMAO_QA_ARTIFACT_DIR || join(tmpdir(), `lm-engine-artifacts-${Date.now()}`),
);
await mkdir(artifacts, { recursive: true });
const api = await createApi({ dataDir, demo: true });
await api.app.listen({ host: '127.0.0.1', port: 0 });
const apiBase = `http://127.0.0.1:${api.app.server.address().port}`;
let local, proxy, app, browser, page, db, base, owner;
const errors = [],
  consoleErrors = [],
  responses = [],
  completed = [];
const sha = (value) => createHash('sha256').update(value).digest('hex');
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
async function until(check, message, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(message);
}
async function navigate() {
  const toggle = page.getByRole('button', { name: '展开导航', exact: true });
  if (await toggle.isVisible()) await toggle.click();
  await page.getByRole('button', { name: '运行与验证', exact: true }).click();
  await page.getByRole('tab', { name: 'Godot 诊断', exact: true }).click();
  await page.getByRole('heading', { name: '让代码，在引擎里跑起来。' }).waitFor();
}
async function choose() {
  await page
    .getByRole('button', { name: native ? '选择 Godot 程序' : '使用本机预配置', exact: true })
    .click();
  const modal = page.getByRole('dialog');
  await modal.getByRole('heading', { name: '确认项目引擎授权' }).waitFor();
  return modal;
}
try {
  if (native) {
    const reservation = createServer();
    await new Promise((done) => reservation.listen(0, '127.0.0.1', done));
    const port = reservation.address().port;
    await new Promise((done) => reservation.close(done));
    const env = {
      ...process.env,
      LIGHTMAO_API_URL: apiBase,
      LIGHTMAO_DATA_DIR: dataDir,
      LIGHTMAO_GODOT_PATH: godotPath,
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
    await app.evaluate(({ dialog }, path) => {
      globalThis.enginePickers = [];
      dialog.showOpenDialog = async (_, options) => {
        globalThis.enginePickers.push(options);
        return { canceled: false, filePaths: [path] };
      };
    }, godotPath);
  } else {
    local = await createLocalAgent({ dataDir, apiUrl: apiBase, godotPath });
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
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (response.status() >= 400 && !(response.status() === 401 && path === '/api/auth/refresh'))
      responses.push({ path, status: response.status() });
  });
  if (!native) await page.goto(base);
  await page.getByRole('navigation', { name: '主导航' }).waitFor();
  base = page.url();
  assert.equal(await page.title(), 'LightMao · 游戏创作工作台');
  assert((await page.locator('body').innerText()).length > 100);
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  if (native) {
    const runtime = await page.evaluate(() => window.lightmaoDesktop.runtimeStatus());
    assert(runtime.ownsAgent && runtime.agentOnline);
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  }
  owner = (
    await fetch(apiBase + '/api/auth/demo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }).then((response) => response.json())
  ).user.id;
  db = new Store(join(dataDir, 'local.sqlite'));
  await navigate();
  await page.getByRole('button', { name: '创建示例工程', exact: true }).click();
  await until(
    () => db.list('project', owner).some((project) => project.name === '星光小径 · Godot 示例'),
    'Sample project was not created',
  );
  const project = db
    .list('project', owner)
    .find((project) => project.name === '星光小径 · Godot 示例');
  await until(
    async () =>
      (await page.getByRole('combobox', { name: '引擎验证项目', exact: true }).inputValue()) ===
      project.id,
    'Sample project was not selected',
  );
  const scriptPath = join(project.root, 'tests/smoke.gd');
  const source = await readFile(scriptPath, 'utf8');
  const withLogs = source.replace(
    '\tprint("LIGHTMAO_TESTS:',
    '\tprint("UI_LOG_START")\n\tfor index in range(180):\n\t\tprint("UI_LOG_%04d: actual Godot execution and bounded log pagination." % index)\n\tprint("UI_LOG_END")\n\tprint("LIGHTMAO_TESTS:',
  );
  assert.notEqual(withLogs, source);
  await writeFile(scriptPath, withLogs);
  record(
    'Creates a real, separately owned Godot sample with scripts and tests; selects it without changing existing projects',
  );
  let modal = await choose();
  assert.equal(
    await modal.getByRole('button', { name: '确认授权', exact: true }).isEnabled(),
    false,
  );
  await modal.getByRole('button', { name: '取消', exact: true }).click();
  await until(
    () => db.list('engine-grant', owner).filter((grant) => !grant.used).length === 0,
    'Cancelled grant remained active',
  );
  assert.equal(db.list('engine-connection', owner).length, 0);
  modal = await choose();
  await shot('engine-authorization');
  await modal.getByRole('checkbox', { name: '允许此项目在隔离副本中执行代码' }).check();
  await modal.getByRole('button', { name: '确认授权', exact: true }).click();
  await page.locator('.engine-connection').getByText('已授权', { exact: true }).waitFor();
  if (native)
    assert.equal(
      (await app.evaluate(() => globalThis.enginePickers))[0].title,
      '选择用于工程验证的 Godot 标准版',
    );
  assert.equal(
    await page.getByRole('button', { name: '开始验证', exact: true }).isEnabled(),
    false,
  );
  await page.getByRole('button', { name: '开启验证插件', exact: true }).click();
  await until(
    async () => page.getByRole('button', { name: '开始验证', exact: true }).isEnabled(),
    'Plugin install did not enable the separately authorized engine',
  );
  record(
    native
      ? 'Real native selector IPC previews the engine; cancellation discards the grant and execution requires explicit consent plus the plugin'
      : 'Fixed local engine preparation requires explicit consent; cancellation discards the grant and plugin installation alone does not grant execution',
  );
  await page.getByRole('combobox', { name: '引擎操作', exact: true }).selectOption('script');
  await page.getByRole('button', { name: '开始验证', exact: true }).click();
  await until(
    () => db.list('engine-job', owner).some((job) => job.status === 'completed'),
    'Actual Godot test did not complete',
  );
  const job = db.list('engine-job', owner)[0];
  assert.equal(job.verification, 'tests_passed');
  assert.equal(job.phases.length, 2);
  assert.equal(sha(await readFile(scriptPath)), sha(withLogs));
  await assert.rejects(access(join(project.root, '.godot')));
  await page
    .locator('.engine-job-list article')
    .first()
    .getByText('已完成', { exact: true })
    .waitFor();
  await shot('engine-history-desktop');
  await page
    .locator('.engine-job-list article')
    .first()
    .getByRole('button', { name: '查看记录', exact: true })
    .click();
  modal = page.getByRole('dialog');
  await modal.getByText('项目测试报告通过', { exact: false }).waitFor();
  await modal.getByRole('button', { name: '查看输入清单', exact: true }).click();
  await modal.locator('.engine-input-list').getByText('state.gd', { exact: true }).waitFor();
  while (!(await modal.locator('.engine-log').innerText()).includes('UI_LOG_END')) {
    await modal.getByRole('button', { name: '继续读取日志', exact: true }).click();
    await until(
      async () => !(await modal.getByRole('button', { name: '读取中…', exact: true }).count()),
      'Log page did not finish loading',
    );
  }
  await modal.locator('.engine-phase-table').scrollIntoViewIfNeeded();
  await shot('engine-log-and-inputs');
  const report = job.artifacts.find((file) => file.path === 'test-results.json');
  const row = modal.locator('.engine-artifacts > div').filter({ hasText: 'test-results.json' });
  await row.getByRole('button', { name: '预览', exact: true }).click();
  await modal
    .locator('.engine-artifact-preview pre')
    .filter({ hasText: 'initial stars' })
    .waitFor();
  if (native) {
    const destination = join(artifacts, 'downloaded-test-results.json');
    await app.evaluate(({ BrowserWindow }, destination) => {
      BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_, item) =>
        item.setSavePath(destination),
      );
    }, destination);
    await row.getByRole('button', { name: '下载test-results.json', exact: true }).click();
    await until(
      () =>
        stat(destination)
          .then((info) => info.size === report.bytes)
          .catch(() => false),
      'Native artifact download did not finish',
    );
    assert.equal(sha(await readFile(destination)), report.sha256);
  } else {
    const pendingDownload = page.waitForEvent('download');
    await row.getByRole('button', { name: '下载test-results.json', exact: true }).click();
    assert.equal(sha(await readFile(await (await pendingDownload).path())), report.sha256);
  }
  await modal
    .locator('.engine-artifacts > div')
    .filter({ hasText: 'test-status.png' })
    .getByRole('button', { name: '预览', exact: true })
    .click();
  await until(
    () =>
      modal
        .getByRole('img', { name: 'test-status.png', exact: true })
        .evaluate((image) => image.complete && image.naturalWidth === 240),
    'Generated PNG did not decode',
  );
  await modal.locator('.engine-artifact-preview').scrollIntoViewIfNeeded();
  await shot('engine-artifacts');
  await modal.getByRole('button', { name: '关闭', exact: true }).click();
  record(
    'Actual Godot runs six assertions; history, input hashes, paginated full logs, byte-exact JSON download and generated PNG decoding are verified',
  );
  const toggle = page.getByRole('switch', { name: '允许此项目执行引擎', exact: true });
  await toggle.click();
  await until(
    async () => (await toggle.getAttribute('aria-checked')) === 'false',
    'Engine disable did not persist',
  );
  await page.reload();
  await navigate();
  await page.getByRole('combobox', { name: '引擎验证项目', exact: true }).selectOption(project.id);
  await until(
    async () =>
      (await page
        .getByRole('switch', { name: '允许此项目执行引擎', exact: true })
        .getAttribute('aria-checked')) === 'false',
    'Reload lost disabled state',
  );
  assert.equal(db.list('engine-job', owner).length, 1);
  assert.equal(
    await page.getByRole('button', { name: '开始验证', exact: true }).isEnabled(),
    false,
  );
  record(
    'Reload preserves disabled project permission and prior history without replaying an engine job',
  );
  await page.getByRole('switch', { name: '允许此项目执行引擎', exact: true }).click();
  await until(
    async () => await page.getByRole('button', { name: '开始验证', exact: true }).isEnabled(),
    'Engine permission was not re-enabled',
  );
  await writeFile(
    join(project.root, 'tests/loop.gd'),
    'extends SceneTree\nfunc _init():\n\twhile true:\n\t\tpass\n',
  );
  await page.getByRole('combobox', { name: '引擎操作', exact: true }).selectOption('script');
  await page.getByRole('textbox', { name: '测试脚本路径', exact: true }).fill('tests/loop.gd');
  await page.getByRole('button', { name: '开始验证', exact: true }).click();
  await until(
    () => db.list('engine-job', owner).some((job) => job.stage === 'script' && !!job.enginePid),
    'Loop script was not actually launched',
  );
  await page
    .locator('.engine-job-list article')
    .first()
    .getByRole('button', { name: '停止', exact: true })
    .click();
  await until(
    () => db.list('engine-job', owner).some((job) => job.status === 'cancelled'),
    'Stop did not terminate the actual loop',
  );
  await page
    .locator('.engine-job-list article')
    .first()
    .getByText('已停止', { exact: true })
    .waitFor();
  record('Stop interrupts an actually running script; the engine history records cancellation');
  if (!native) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.page-scroll').evaluate((node) => {
      node.scrollTop = 0;
    });
    assert(await page.getByRole('combobox', { name: '引擎验证项目' }).isVisible());
    assert(await page.getByRole('textbox', { name: '测试脚本路径' }).isVisible());
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await shot('engine-mobile');
    await page
      .locator('.engine-job-list article')
      .nth(1)
      .getByRole('button', { name: '查看记录', exact: true })
      .click();
    modal = page.getByRole('dialog');
    await modal.locator('.engine-phase-table').waitFor();
    const box = await modal.boundingBox();
    assert(box.x >= 0 && box.width <= 390);
    await modal.locator('.engine-phase-table').scrollIntoViewIfNeeded();
    await shot('engine-record-mobile');
    await modal.getByRole('button', { name: '关闭', exact: true }).click();
    await page.setViewportSize({ width: 1280, height: 900 });
    record('390px layout preserves engine controls and a bounded, readable run-details dialog');
  }
  await page.getByRole('button', { name: '断开连接', exact: true }).click();
  await page.getByRole('heading', { name: '连接本机 Godot', exact: true }).waitFor();
  assert.equal(db.list('engine-connection', owner).length, 0);
  assert.equal(db.list('engine-job', owner).length, 2);
  assert(db.get('engine-log', job.id, owner).text.includes('UI_LOG_END'));
  record(
    'Disconnect removes execution permission while retaining completed and cancelled receipts and full logs',
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(responses, []);
  const relevantConsole = consoleErrors.filter(
    (text) => !/401.*Unauthorized|Failed to load resource.*401/.test(text),
  );
  assert.deepEqual(relevantConsole, []);
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
} catch (error) {
  process.exitCode = 1;
  console.error(error.stack);
  await shot('failure').catch(() => {});
} finally {
  db?.close();
  await browser?.close();
  await app?.close();
  if (proxy) {
    proxy.closeAllConnections();
    await new Promise((done) => proxy.close(done));
  }
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
        base,
        browser: 'Browser plugin not available; isolated Playwright Chromium/Electron',
        completed,
        errors,
        responses,
        consoleErrors,
        artifacts,
        scope:
          'Real Godot headless engine, no paid model calls. Native uses real utilityProcess/preload/IPC; OS picker result substituted. Generated PNG is a test diagnostic, not gameplay visual acceptance.',
      },
      null,
      2,
    ),
  );
  await rm(root, { recursive: true, force: true });
}
