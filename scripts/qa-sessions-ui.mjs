import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, _electron } from 'playwright';
import { createApi } from '../apps/api/server.ts';
import { createLocalAgent } from '../apps/agent/server.ts';
import desktop from '../apps/desktop/proxy.cjs';

// Browser plugin not available. Use installed Playwright and isolated profiles.
const native = process.argv.includes('--electron'),
  require = createRequire(import.meta.url);
const dataDir = await mkdtemp(join(tmpdir(), 'lm-session-ui-'));
const artifacts =
  process.env.LIGHTMAO_QA_ARTIFACT_DIR || join(tmpdir(), `lm-session-ui-artifacts-${Date.now()}`);
await mkdir(artifacts, { recursive: true });
const api = await createApi({ dataDir, demo: true });
await api.app.listen({ host: '127.0.0.1', port: 0 });
const apiBase = `http://127.0.0.1:${api.app.server.address().port}`;
const local = await createLocalAgent({ dataDir, apiUrl: apiBase, tickMs: 3600000 });
await local.app.listen({ host: '127.0.0.1', port: 0 });
const agentBase = `http://127.0.0.1:${local.app.server.address().port}`;
let browser, context, app, page, proxy;
const errors = [],
  unexpectedResponses = [],
  completed = [];
const record = (name) => {
  completed.push(name);
  console.log(JSON.stringify({ passed: name }));
};
const screenshot = async (name) =>
  page.screenshot({
    path: join(artifacts, name + '.jpg'),
    type: 'jpeg',
    quality: 85,
    animations: 'disabled',
  });
async function until(work, message) {
  for (let i = 0; i < 150; i++) {
    if (await work()) return;
    await delay(30);
  }
  throw Error(message);
}
async function history() {
  if (await page.getByRole('button', { name: '展开导航', exact: true }).isVisible())
    await page.getByRole('button', { name: '展开导航', exact: true }).click();
  await page.getByRole('button', { name: '历史会话', exact: true }).click();
  await page.getByRole('heading', { name: '会话历史', exact: true }).waitFor();
}
async function send(sessionId, prompt) {
  const before = local.store.list('run').length;
  await page.getByRole('textbox', { name: '发送消息', exact: true }).fill(prompt);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await until(() => local.store.list('run').length > before, 'Run did not start');
  await until(
    () =>
      local.store
        .list('run')
        .some(
          (run) =>
            run.sessionId === sessionId && run.prompt === prompt && run.status === 'completed',
        ),
    'Run did not complete',
  );
  await until(
    async () => (await page.locator('.message.user').filter({ hasText: prompt }).count()) > 0,
    'Stored prompt did not render',
  );
  await until(
    async () => !(await page.getByRole('button', { name: '停止运行', exact: true }).isVisible()),
    'UI remained running',
  );
}
try {
  if (native) {
    const env = {
      ...process.env,
      LIGHTMAO_API_URL: apiBase,
      LIGHTMAO_DATA_DIR: dataDir,
      AGENT_PORT: String(local.app.server.address().port),
      LIGHTMAO_QA_PROFILE: join(dataDir, 'electron-profile'),
    };
    for (const key of Object.keys(env))
      if (/^(ARK_|OSS_|DOUBAO_|LIGHTMAO_ADMIN_)/.test(key)) delete env[key];
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({
      executablePath: require('electron'),
      args: ['scripts/qa-desktop-entry.cjs'],
      cwd: resolve('.'),
      env,
    });
    page = await app.firstWindow();
  } else {
    proxy = desktop.createDesktopServer({ webRoot: resolve('dist/web'), apiBase, agentBase });
    await new Promise((done) => proxy.listen(0, '127.0.0.1', done));
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    await page.goto(`http://127.0.0.1:${proxy.address().port}/`);
  }
  page.setDefaultTimeout(12000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (
      response.status() >= 400 &&
      !(response.status() === 401 && new URL(response.url()).pathname === '/api/auth/refresh')
    )
      unexpectedResponses.push({
        status: response.status(),
        path: new URL(response.url()).pathname,
      });
  });
  await page.getByRole('navigation', { name: '主导航' }).waitFor();
  assert.match(await page.title(), /LightMao/);
  assert.match(page.url(), /^http:\/\/127\.0\.0\.1:/);
  const user = api.store.list('user').find((user) => user.email === 'demo@lightmao.local');
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/local/sessions' &&
      response.request().method() === 'POST',
  );
  await page
    .getByRole('button', { name: /^新建会话/ })
    .first()
    .click();
  const source = await (await created).json();
  await page.waitForFunction(
    ({ id, owner }) => sessionStorage.getItem(`lightmao.active.${owner}`) === id,
    { id: source.id, owner: user.id },
  );
  await send(source.id, '检查移动系统方案，保存第一阶段记录。');
  await send(source.id, 'FUTURE_UI_ONLY 后续再考虑战斗系统，先检查项目。');
  await until(
    async () => (await page.locator('.message.assistant').count()) === 2,
    'Expected two final replies',
  );
  assert.equal(await page.locator('.execution-toggle[aria-expanded="false"]').count(), 2);
  const sourceView = local.store.get('session', source.id, user.id),
    point = sourceView.messages[1].id,
    runCount = local.store.list('run', user.id).length,
    toolCount = local.store.list('tool-detail', user.id).length;
  await page.getByRole('button', { name: '从第 1 轮回答分叉', exact: true }).click();
  let modal = page.getByRole('dialog');
  assert.equal(await modal.getByLabel('分叉位置', { exact: true }).inputValue(), point);
  await modal.getByLabel('分支名称', { exact: true }).fill('移动系统 · 方案B');
  await screenshot('session-fork-desktop');
  await modal.getByRole('button', { name: '创建分支', exact: true }).click();
  await page.getByText('已创建独立会话分支', { exact: true }).waitFor();
  const branch = local.store
    .list('session', user.id)
    .find((session) => session.title === '移动系统 · 方案B');
  assert(branch);
  assert.equal(branch.messages.length, 2);
  await page.locator('.breadcrumb strong').filter({ hasText: '移动系统 · 方案B' }).waitFor();
  assert.equal(await page.locator('.message.user').count(), 1);
  assert.equal(
    await page
      .getByText('FUTURE_UI_ONLY 后续再考虑战斗系统，先检查项目。', { exact: true })
      .count(),
    0,
  );
  assert.equal(local.store.list('run', user.id).length, runCount);
  assert.equal(local.store.list('tool-detail', user.id).length, toolCount);
  await page.locator('.execution-toggle').click();
  await page.locator('.execution-body').waitFor();
  await screenshot('session-branch-inherited-trace');
  await page.getByRole('button', { name: '查看来源轮次', exact: true }).click();
  await page.waitForFunction(
    (id) => !!document.getElementById('message-' + id)?.classList.contains('focused-message'),
    point,
  );
  assert.equal(await page.locator('.message.user').count(), 2);
  record(
    'Two real Pi turns fork at the first reply; later history is excluded, no tools replay, inherited trace expands and source navigation locates the original round',
  );
  await history();
  const search = page.getByRole('textbox', { name: '搜索会话名称或消息…', exact: true });
  await search.fill('移动系统 · 方案B');
  await until(
    async () => (await page.locator('.session-history-row').count()) === 1,
    'Search did not narrow history',
  );
  await page.getByRole('button', { name: '管理会话移动系统 · 方案B', exact: true }).click();
  modal = page.getByRole('dialog');
  await modal.getByLabel('会话名称', { exact: true }).fill('移动系统 · 方案B（已编辑）');
  await modal.getByRole('button', { name: '保存名称', exact: true }).click();
  await page.getByText('会话名称已保存', { exact: true }).waitFor();
  await modal.getByRole('button', { name: /置顶会话/ }).click();
  await page.getByText('会话已置顶', { exact: true }).waitFor();
  await modal.getByRole('button', { name: '关闭', exact: true }).click();
  await page
    .getByRole('button', { name: '管理会话移动系统 · 方案B（已编辑）', exact: true })
    .waitFor();
  await screenshot('session-history-desktop');
  assert.equal(local.store.get('session', branch.id, user.id).pinned, true);
  await page
    .getByRole('button', { name: '管理会话移动系统 · 方案B（已编辑）', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /归档会话/ })
    .click();
  await page.getByText('会话已归档', { exact: true }).waitFor();
  await page.getByRole('button', { name: '已归档', exact: true }).click();
  await page
    .getByRole('button', { name: '打开会话移动系统 · 方案B（已编辑）', exact: true })
    .click();
  assert(await page.getByRole('textbox', { name: '发送消息', exact: true }).isDisabled());
  await page.reload();
  await page.getByRole('button', { name: '恢复会话', exact: true }).waitFor();
  assert(await page.getByRole('textbox', { name: '发送消息', exact: true }).isDisabled());
  await page.getByRole('button', { name: '恢复会话', exact: true }).click();
  await page.getByText('会话已恢复', { exact: true }).waitFor();
  await until(
    async () => await page.getByRole('textbox', { name: '发送消息', exact: true }).isEnabled(),
    'Restored conversation stayed disabled',
  );
  assert.equal(local.store.list('run', user.id).length, runCount);
  await send(branch.id, '沿方案B继续核查移动控制，不修改文件。');
  assert.equal(local.store.get('session', source.id, user.id).messages.length, 4);
  assert.equal(local.store.get('session', branch.id, user.id).messages.length, 4);
  record(
    'History search, rename, pin, archive, reload, restore and independent branch continuation persist correctly; restore does not auto-run',
  );
  await history();
  await page
    .getByRole('textbox', { name: '搜索会话名称或消息…', exact: true })
    .fill('FUTURE_UI_ONLY');
  await until(
    async () => (await page.locator('.session-history-row').count()) === 1,
    'Body search failed',
  );
  assert.equal(
    await page.locator('.session-history-row').getAttribute('data-session-id'),
    source.id,
  );
  const project = local.store.get('project', source.projectId, user.id);
  for (let i = 0; i < 60; i++)
    local.store.put('session', user.id, {
      id: randomUUID(),
      projectId: project.id,
      title: `分页会话 ${String(i + 1).padStart(3, '0')}`,
      messages: [],
      transcript: [],
      status: 'idle',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      revision: 1,
    });
  await page.getByRole('textbox', { name: '搜索会话名称或消息…', exact: true }).fill('');
  await until(
    async () => (await page.locator('.session-history-row').count()) === 25,
    'First history page did not load',
  );
  await page.getByRole('button', { name: '加载更多会话', exact: true }).click();
  await until(
    async () => (await page.locator('.session-history-row').count()) === 50,
    'Second history page did not load',
  );
  await page.getByRole('button', { name: '加载更多会话', exact: true }).click();
  await until(
    async () => (await page.locator('.session-history-row').count()) === 64,
    'Final history page did not load',
  );
  assert.equal(await page.getByRole('button', { name: '加载更多会话', exact: true }).count(), 0);
  record(
    'Message-body search and three cursor pages reach all 64 sessions without duplicating rows',
  );
  const gate = { release: () => {} };
  const delayed = new Promise((resolve) => {
    gate.release = resolve;
  });
  await page.route(`**/local/sessions/${source.id}`, async (route) => {
    const response = await route.fetch();
    await delayed;
    await route.fulfill({ response }).catch(() => {});
  });
  await page.getByRole('button', { name: `打开会话${sourceView.title}`, exact: true }).click();
  await page.locator('.session-item').filter({ hasText: '移动系统 · 方案B（已编辑）' }).click();
  await page
    .locator('.breadcrumb strong')
    .filter({ hasText: '移动系统 · 方案B（已编辑）' })
    .waitFor();
  gate.release();
  await delay(80);
  assert((await page.locator('.breadcrumb strong').innerText()).includes('方案B'));
  await page.unroute(`**/local/sessions/${source.id}`);
  record('A delayed response from the previously selected chat cannot overwrite the current chat');
  if (!native) {
    await history();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(
      () => document.querySelector('.sidebar-holder').getBoundingClientRect().right <= 0,
    );
    await page.getByRole('heading', { name: '会话历史', exact: true }).scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    for (const button of await page.locator('.session-history-controls button').all()) {
      const box = await button.boundingBox();
      assert(
        box && box.x >= 0 && box.x + box.width <= 390,
        'history controls must fit the narrow viewport',
      );
    }
    await screenshot('session-history-mobile');
    await page
      .getByRole('button', { name: '打开会话移动系统 · 方案B（已编辑）', exact: true })
      .click();
    await page.getByRole('button', { name: '分叉会话', exact: true }).click();
    await page.getByRole('dialog').getByLabel('分叉位置', { exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await screenshot('session-fork-mobile');
    await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
    record('History and selected-round dialog fit a 390px viewport with usable controls');
  }
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpectedResponses, []);
  record(
    'Page identity, populated content, framework overlay, console, screenshot and interaction checks pass',
  );
} catch (error) {
  process.exitCode = 1;
  console.error(error.message);
  await screenshot('failure').catch(() => {});
} finally {
  await writeFile(
    join(artifacts, 'receipt.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        passed: !process.exitCode,
        native,
        completed,
        errors,
        unexpectedResponses,
        artifacts,
      },
      null,
      2,
    ),
  );
  await app?.close();
  await browser?.close();
  if (proxy) await new Promise((done) => proxy.close(done));
  await local.app.close();
  await api.app.close();
  await rm(dataDir, { recursive: true, force: true });
  console.log(
    JSON.stringify({
      passed: !process.exitCode,
      completed,
      errors,
      unexpectedResponses,
      artifacts,
    }),
  );
}
