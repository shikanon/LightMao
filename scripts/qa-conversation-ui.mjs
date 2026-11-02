import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createServer as reserveServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, _electron } from 'playwright';
import { createApi } from '../apps/api/server.ts';
import { createLocalAgent } from '../apps/agent/server.ts';
import { Store } from '../packages/shared/store.ts';
import { seedConversation } from '../tests/fixtures/conversation.ts';
import desktop from '../apps/desktop/proxy.cjs';

// Browser plugin not available; isolated Playwright and, in native mode, an
// actual owned Electron utilityProcess Agent. No user Chrome or paid provider.
const native = process.argv.includes('--electron'),
  require = createRequire(import.meta.url);
const id = randomUUID(),
  root = await mkdtemp(join(tmpdir(), 'lm-history-ui-')),
  dataDir = join(root, 'runtime');
const artifacts = resolve(process.env.LIGHTMAO_QA_ARTIFACT_DIR || join(root, 'artifacts'));
await mkdir(artifacts, { recursive: true });
const marker = 'UI_HISTORY_' + id.slice(0, 8),
  completed = [],
  requests = [],
  errors = [],
  consoleMessages = [],
  responses = [],
  contextRequests = [],
  sourceRequests = [];
const text = (message) =>
  typeof message.content === 'string'
    ? message.content
    : message.content
        ?.filter((v) => v.type === 'text')
        .map((v) => v.text)
        .join('\n') || '';
const upstream = createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const body = JSON.parse(raw);
  requests.push(body);
  const summary = body.messages.some((m) => text(m).includes('LIGHTMAO_SUMMARY_V1'));
  let content;
  if (summary) {
    const input = JSON.parse(text(body.messages.filter((m) => m.role === 'user').at(-1)));
    const user = input.sourceParts.find((v) => v.role === 'user');
    content = JSON.stringify({
      items: input.previous?.length
        ? input.previous
        : [
            {
              kind: 'constraint',
              text: marker + '：先检查项目，保留原始工程。',
              sourceIds: [user.messageId],
            },
          ],
    });
  } else content = 'CONVERSATION_UI_VERIFIED：历史目标已核对，未写入项目。';
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const frame = (delta, finish) =>
    `data: ${JSON.stringify({ id: 'history-ui', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  res.write(frame({ role: 'assistant', content }, null));
  res.write(frame({}, 'stop'));
  res.end(
    'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":40,"total_tokens":1040}}\n\ndata: [DONE]\n\n',
  );
});
await new Promise((done) => upstream.listen(0, '127.0.0.1', done));
const api = await createApi({
  dataDir,
  demo: true,
  arkKey: 'history-ui-protocol',
  arkBase: `http://127.0.0.1:${upstream.address().port}`,
});
await api.app.listen({ host: '127.0.0.1', port: 0 });
const apiBase = `http://127.0.0.1:${api.app.server.address().port}`;
let app,
  browser,
  page,
  proxy,
  local,
  db,
  base,
  passed = false,
  expectedDeniedPath = '',
  preferences;
const record = (name) => {
  completed.push(name);
  console.log(JSON.stringify({ passed: name }));
};
const summaries = () =>
  requests.filter((b) => b.messages.some((m) => text(m).includes('LIGHTMAO_SUMMARY_V1')));
async function until(fn, message) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    if (await fn()) return;
    await delay(40);
  }
  throw Error(message);
}
async function shot(name) {
  await page.screenshot({
    path: join(artifacts, name + '.jpg'),
    type: 'jpeg',
    quality: 85,
    animations: 'disabled',
  });
}
async function send(sessionId, prompt) {
  await page.getByRole('textbox', { name: '发送消息', exact: true }).fill(prompt);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await until(
    () =>
      db
        .list('run', owner)
        .some((v) => v.sessionId === sessionId && v.prompt === prompt && v.status !== 'running'),
    'UI history run did not settle',
  );
  const run = db.list('run', owner).find((v) => v.sessionId === sessionId && v.prompt === prompt);
  assert.equal(run.status, 'completed', run.error);
  await until(
    async () =>
      (await page
        .locator('.message.assistant')
        .filter({ hasText: 'CONVERSATION_UI_VERIFIED' })
        .count()) > 0 &&
      !(await page.getByRole('button', { name: '停止运行', exact: true }).isVisible()),
    'Final reply did not settle',
  );
  return run;
}
let owner;
try {
  if (native) {
    const reserve = reserveServer();
    await new Promise((done) => reserve.listen(0, '127.0.0.1', done));
    const port = reserve.address().port;
    await new Promise((done) => reserve.close(done));
    const env = {
      ...process.env,
      LIGHTMAO_API_URL: apiBase,
      LIGHTMAO_DATA_DIR: dataDir,
      AGENT_PORT: String(port),
      LIGHTMAO_QA_PROFILE: join(root, 'profile'),
      LIGHTMAO_USER_DATA_DIR: join(root, 'profile'),
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
    await page.waitForURL((url) => url.protocol === 'http:' && url.hostname === '127.0.0.1', {
      timeout: 30000,
    });
    await page.waitForLoadState('load');
    base = new URL(page.url()).origin;
    preferences = await app.evaluate(({ BrowserWindow }) => {
      const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return {
        electron: process.versions.electron,
        sandbox: p.sandbox,
        contextIsolation: p.contextIsolation,
        nodeIntegration: p.nodeIntegration,
      };
    });
    assert(preferences.sandbox && preferences.contextIsolation && !preferences.nodeIntegration);
    assert((await page.evaluate(() => window.lightmaoDesktop.runtimeStatus())).ownsAgent);
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
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (['error', 'warning'].includes(m.type()))
      consoleMessages.push({ text: m.text(), url: m.location().url });
  });
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (/\/local\/sessions\/[^/]+\/context\//.test(path)) contextRequests.push(path);
    if (/\/local\/sessions\/[^/]+\/history$/.test(path)) sourceRequests.push(path);
  });
  page.on('response', (r) => {
    const path = new URL(r.url()).pathname;
    if (
      r.status() >= 400 &&
      !(r.status() === 401 && path === '/api/auth/refresh') &&
      !(r.status() === 404 && path === expectedDeniedPath)
    )
      responses.push({ path, status: r.status() });
  });
  await page.goto(base + '/admin');
  await page.getByRole('heading', { name: '管理工作空间', exact: true }).waitFor();
  await page.getByRole('tab', { name: '模型配置', exact: true }).click();
  const budget = page.getByLabel('上下文使用预算（tokens）', { exact: true });
  await budget.fill('32768');
  await page.getByRole('spinbutton', { name: '单次输出上限', exact: true }).fill('8192');
  await page.getByRole('button', { name: '保存模型配置', exact: true }).click();
  await until(
    () => api.store.get('config', 'model').contextWindowTokens === 32768,
    'Budget was not persisted',
  );
  await page.reload();
  await page.getByRole('heading', { name: '管理工作空间', exact: true }).waitFor();
  await page.getByRole('tab', { name: '模型配置', exact: true }).click();
  assert.equal(await budget.inputValue(), '32768');
  await shot('context-model-budget');
  record('Admin context budget saves with real versioned API state and survives reload');
  await page.goto(base + '/');
  await page.getByRole('navigation', { name: '主导航' }).waitFor();
  owner = api.store.list('user').find((v) => v.email === 'demo@lightmao.local').id;
  db = new Store(join(dataDir, 'local.sqlite'));
  const creation = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/local/sessions' && r.request().method() === 'POST',
  );
  await page
    .getByRole('button', { name: /^新建会话/ })
    .first()
    .click();
  const session = await (await creation).json();
  await page.waitForFunction(
    ({ sessionId, owner }) => sessionStorage.getItem(`lightmao.active.${owner}`) === sessionId,
    { sessionId: session.id, owner },
  );
  const seeded = seedConversation(db, owner, session.id, 8, 2100, marker);
  const originals = db.get('session', session.id, owner).messages;
  await page.reload();
  await page.getByRole('textbox', { name: '发送消息', exact: true }).waitFor();
  assert.match(await page.title(), /LightMao/);
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  const run = await send(session.id, 'UI_CURRENT_REQUEST 检查历史目标并继续，不写入文件。');
  assert(run.historyContext?.summaryRef);
  assert(summaries().length >= 1);
  assert.deepEqual(
    db.get('session', session.id, owner).messages.slice(0, originals.length),
    originals,
  );
  const trace = page.locator('.execution-trace[aria-label="执行记录"]').last();
  assert.equal(await trace.locator('.execution-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(contextRequests.length, 0);
  assert.equal(sourceRequests.length, 0);
  await shot('context-run-collapsed');
  await trace.locator('.execution-toggle').click();
  await trace.getByRole('button', { name: '查看历史整理', exact: true }).waitFor();
  assert.equal(contextRequests.length, 0);
  await trace.getByRole('button', { name: '查看历史整理', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '历史整理' });
  await modal.getByText(new RegExp(marker)).waitFor();
  assert.equal(contextRequests.length, 1);
  assert.equal(sourceRequests.length, 0);
  await modal.getByRole('button', { name: '查看用户原文', exact: true }).first().click();
  await until(
    async () =>
      (await modal.locator('.memory-original pre').textContent()) ===
      seeded[0].user.text.slice(0, 2000),
    'Original first page mismatch',
  );
  await modal.getByRole('button', { name: '下一段', exact: true }).click();
  await until(
    async () =>
      (await modal.locator('.memory-original pre').textContent()) ===
      seeded[0].user.text.slice(2000, 4000),
    'Original second page mismatch',
  );
  await shot('context-original-source');
  record(
    'Actual Pi compacts independently while execution stays collapsed; summary and exact original pages load only after explicit UI expansion',
  );
  if (!native) {
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert(await modal.getByRole('button', { name: '上一段', exact: true }).isVisible());
    await shot('context-source-narrow');
    await page.setViewportSize({ width: 1280, height: 900 });
    record('390px summary/source dialog wraps controls and pages without horizontal overflow');
  }
  await modal.getByRole('button', { name: '关闭对话框', exact: true }).click();
  const count = summaries().length;
  await page.reload();
  await page.getByRole('textbox', { name: '发送消息', exact: true }).waitFor();
  assert.equal(await page.locator('.execution-toggle[aria-expanded="true"]').count(), 0);
  await send(session.id, 'UI_AFTER_RELOAD 继续检查现有目标。');
  assert.equal(summaries().length, count);
  record(
    'Reload restores closed traces and a later real Pi request reuses persisted summary without another summary model call',
  );
  await page.getByRole('button', { name: '从第 1 轮回答分叉', exact: true }).click();
  const fork = page.getByRole('dialog');
  await fork.getByLabel('分支名称', { exact: true }).fill('早期上下文分支');
  await fork.getByRole('button', { name: '创建分支', exact: true }).click();
  await page.locator('.breadcrumb strong').filter({ hasText: '早期上下文分支' }).waitFor();
  const branch = db.list('session', owner).find((v) => v.title === '早期上下文分支');
  assert(branch);
  await send(branch.id, 'UI_BRANCH_REQUEST 只依据本分支历史。');
  assert.equal(summaries().length, count);
  assert(!JSON.stringify(requests.at(-1)).includes(seeded[7].reply.text));
  assert.equal(await page.getByRole('button', { name: '查看历史整理', exact: true }).count(), 0);
  expectedDeniedPath = `/local/sessions/${branch.id}/context/${run.historyContext.summaryRef}`;
  assert.equal(
    await page.evaluate(
      async ({ path }) =>
        (
          await fetch(path, {
            headers: { authorization: 'Bearer ' + sessionStorage.getItem('lightmao.token') },
          })
        ).status,
      { path: expectedDeniedPath },
    ),
    404,
  );
  await shot('context-early-fork');
  record(
    'UI forks at an early reply, excludes later parent context, and API rejects the inaccessible later summary',
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(responses, []);
  assert.deepEqual(
    consoleMessages.filter((v) => {
      if (!v.url) return true;
      const path = new URL(v.url).pathname;
      return !(
        (path === '/api/auth/refresh' && /status of 401/.test(v.text)) ||
        (path === expectedDeniedPath && /status of 404/.test(v.text))
      );
    }),
    [],
  );
  record(
    'Page identity, nonblank state, no overlay, console health and interaction checks pass in an isolated profile',
  );
  passed = true;
} catch (error) {
  if (page) await shot('failure').catch(() => {});
  throw error;
} finally {
  if (app) await app.close();
  if (browser) await browser.close();
  if (local) await local.app.close();
  if (proxy) {
    proxy.closeAllConnections();
    await new Promise((done) => proxy.close(done));
  }
  db?.close();
  await api.app.close();
  upstream.closeAllConnections();
  await new Promise((done) => upstream.close(done));
  await writeFile(
    join(artifacts, 'receipt.json'),
    JSON.stringify(
      {
        id,
        at: new Date().toISOString(),
        native,
        passed,
        completed,
        errors,
        consoleMessages,
        responses,
        preferences,
        modelCalls: requests.length,
        summaryCalls: summaries().length,
        contextRequests: contextRequests.length,
        sourceRequests: sourceRequests.length,
        viewports: native ? ['native desktop'] : ['1280x900', '390x844'],
        scope:
          'Isolated protocol upstream and explicitly seeded historical fixtures; actual Pi, browser and owned native utilityProcess. No paid model or user Chrome.',
        artifacts,
      },
      null,
      2,
    ) + '\n',
  );
  if (passed) await rm(root, { recursive: true, force: true });
}
