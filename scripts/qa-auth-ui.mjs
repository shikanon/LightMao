import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createApi } from '../apps/api/server.ts';
import { createLocalAgent } from '../apps/agent/server.ts';
import { TaskJournal } from '../apps/agent/task-journal.ts';
import desktop from '../apps/desktop/proxy.cjs';

// The Browser plugin is unavailable in this workspace. Use the installed
// Playwright Chromium with an isolated profile; never read a user's profile.
const verificationId = randomUUID();
const dataDir = await mkdtemp(join(tmpdir(), 'lightmao-auth-ui-'));
const artifacts = resolve(
  process.env.LIGHTMAO_QA_ARTIFACT_DIR ||
    join(tmpdir(), `lightmao-auth-ui-artifacts-${verificationId}`),
);
await mkdir(artifacts, { recursive: true });
let time = Date.now();
const api = await createApi({
  dataDir,
  secureCookies: true,
  auth: { now: () => time, accessTtlMs: 1000 },
});
await api.app.listen({ host: '127.0.0.1', port: 0 });
const apiBase = `http://127.0.0.1:${api.app.server.address().port}`;
const local = await createLocalAgent({ dataDir, apiUrl: apiBase, tickMs: 3600000 });
await local.app.listen({ host: '127.0.0.1', port: 0 });
const agentBase = `http://127.0.0.1:${local.app.server.address().port}`;
const proxy = desktop.createDesktopServer({ webRoot: resolve('dist/web'), apiBase, agentBase });
await new Promise((done) => proxy.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${proxy.address().port}`;
const mcpServer = createServer(async (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const message = JSON.parse(Buffer.concat(chunks).toString());
  if (message.id === undefined) {
    res.writeHead(202).end();
    return;
  }
  const result =
    message.method === 'initialize'
      ? {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'UI fixture', version: '1' },
        }
      : {
          tools: [
            {
              name: 'asset_lookup',
              description: '读取联调素材索引。',
              inputSchema: { type: 'object', properties: {}, additionalProperties: false },
              annotations: { readOnlyHint: true },
            },
          ],
        };
  res
    .writeHead(200, { 'Content-Type': 'application/json' })
    .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
});
await new Promise((done) => mcpServer.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
page.setDefaultTimeout(12000);
const errors = [],
  unexpectedResponses = [],
  completed = [];
let refreshRequests = 0,
  permitExpiry = false;
context.on('page', (target) => {
  target.on('pageerror', (e) => errors.push(e.message));
  target.on('response', (response) => {
    const url = new URL(response.url());
    if (!['http:', 'https:'].includes(url.protocol) || response.status() < 400) return;
    if (response.status() === 401 && (permitExpiry || url.pathname === '/api/auth/refresh')) return;
    unexpectedResponses.push({ status: response.status(), path: url.pathname });
  });
});
// The first page was created before registering the context event.
page.on('pageerror', (e) => errors.push(e.message));
page.on('response', (response) => {
  const url = new URL(response.url());
  if (
    response.status() >= 400 &&
    !(response.status() === 401 && (permitExpiry || url.pathname === '/api/auth/refresh'))
  )
    unexpectedResponses.push({ status: response.status(), path: url.pathname });
});
context.on('request', (request) => {
  if (new URL(request.url()).pathname === '/api/auth/refresh') refreshRequests++;
});
const email = 'browser-qa@example.test',
  password = 'Browser-QA-fixture-2026';
let userId, taskId;
const record = (name) => {
  completed.push(name);
  console.log(JSON.stringify({ passed: name }));
};
async function settings(target = page) {
  if (await target.getByRole('button', { name: '展开导航', exact: true }).isVisible())
    await target.getByRole('button', { name: '展开导航', exact: true }).click();
  await target.getByRole('button', { name: '设置', exact: true }).click();
  await target.getByRole('heading', { name: '账号与安全', exact: true }).waitFor();
}
async function login() {
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('navigation', { name: '主导航' }).waitFor();
}
async function until(check, message) {
  for (let i = 0; i < 120; i++) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(message);
}
let dueSequence = 0;
async function runDue() {
  const task = local.store.get('schedule', taskId, userId);
  assert(task.enabled);
  local.store.put('schedule', userId, {
    ...task,
    nextRunAt: new Date(++dueSequence).toISOString(),
  });
  const previous = local.store.list('run', userId).filter((r) => r.taskId === taskId).length;
  await local.tick();
  await until(
    () =>
      local.store.list('run', userId).filter((r) => r.taskId === taskId && r.status === 'completed')
        .length > previous,
    'Scheduled Agent did not complete',
  );
}
async function screenshot(name) {
  await page.screenshot({
    path: join(artifacts, `${name}.jpg`),
    type: 'jpeg',
    quality: 85,
    animations: 'disabled',
  });
}
try {
  assert.equal(
    (await fetch(`${base}/api/health`, { headers: { Origin: 'https://untrusted.example' } }))
      .status,
    403,
  );
  const foreignHost = await new Promise((done, reject) => {
    const request = httpRequest(
      `${base}/api/health`,
      { headers: { Host: 'untrusted.example' } },
      (response) => {
        response.resume();
        done(response.statusCode);
      },
    );
    request.on('error', reject);
    request.end();
  });
  assert.equal(foreignHost, 403, 'proxy rejects a foreign Host header');
  await page.goto(base);
  await page.getByRole('button', { name: '还没有账号？注册', exact: true }).click();
  await page.getByLabel('称呼', { exact: true }).fill('界面联调');
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '创建账号', exact: true }).click();
  await page.getByRole('navigation', { name: '主导航' }).waitFor();
  userId = api.store.list('user').find((u) => u.email === email).id;
  const cookie = (await context.cookies(`${base}/api/auth/refresh`)).find(
    (c) => c.name === 'lightmao_refresh',
  );
  assert(
    cookie?.httpOnly && !cookie.secure && cookie.sameSite === 'Strict',
    'the loopback cookie preserves HttpOnly/SameSite without an HTTPS-only flag',
  );
  assert(!(await page.evaluate(() => document.cookie)).includes('lightmao_refresh'));
  record('UI registration and HttpOnly loopback cookie through the actual desktop proxy');
  await settings();
  permitExpiry = true;
  const before = refreshRequests;
  time += 1100;
  await page.getByRole('button', { name: '刷新状态', exact: true }).click();
  await page.getByText('授权状态已更新', { exact: true }).waitFor();
  assert.equal(refreshRequests - before, 1, 'parallel requests must share one refresh');
  record('Expired access token renews once while the settings page remains usable');

  const other = await context.newPage();
  await other.goto(base);
  await settings(other);
  assert.equal(api.store.list('auth-session', userId).filter((s) => !s.revokedAt).length, 1);
  await Promise.all([
    page.getByRole('button', { name: '刷新状态', exact: true }).click(),
    other.getByRole('button', { name: '刷新状态', exact: true }).click(),
  ]);
  await other.close();
  await page.reload();
  await settings();
  record('Cookie-only new window and reload restore the same login session');

  await page.getByRole('button', { name: '授权本机', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '授权本机', exact: true }).click();
  await page.getByRole('button', { name: '更新授权', exact: true }).waitFor();
  await page.getByRole('heading', { name: '账号与安全' }).scrollIntoViewIfNeeded();
  await screenshot('authorization-desktop');
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: /^定时任务/ })
    .click();
  await page.getByRole('button', { name: '创建任务', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('任务名称', { exact: true }).fill('授权续期联调');
  await dialog.getByLabel('交给 Agent 的任务', { exact: true }).fill('检查项目目录并汇总结果。');
  await dialog.getByLabel('运行频率', { exact: true }).selectOption('interval');
  await dialog.getByLabel('间隔（分钟）', { exact: true }).fill('60');
  await dialog.getByRole('button', { name: '保存任务', exact: true }).click();
  await page.getByRole('heading', { name: '授权续期联调', exact: true }).waitFor();
  taskId = local.store.list('schedule', userId)[0].id;
  await settings();
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await page.getByRole('heading', { name: '欢迎回到 LightMao' }).waitFor();
  time += 1100;
  await runDue();
  record('UI-created scheduled Agent completes after access expiry and explicit web logout');

  await login();
  await settings();
  await page.getByRole('button', { name: /^撤销设备/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: '撤销授权', exact: true }).click();
  await until(
    () => api.store.list('auth-device', userId).some((d) => d.revokedAt),
    'Device was not revoked',
  );
  const task = local.store.get('schedule', taskId, userId);
  local.store.put('schedule', userId, { ...task, nextRunAt: new Date(0).toISOString() });
  await local.tick();
  assert.equal(local.store.get('schedule', taskId, userId).authorization, 'required');
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: /^定时任务/ })
    .click();
  await page.getByRole('button', { name: '重新授权', exact: true }).waitFor();
  await page.getByRole('button', { name: '重新授权', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '授权并启用', exact: true }).click();
  await until(() => local.store.get('schedule', taskId, userId).enabled, 'Task did not resume');
  await runDue();
  await page.getByRole('heading', { name: '授权续期联调' }).waitFor();
  record('Device revocation pauses the task and explicit UI reauthorization restores execution');

  await settings();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    () => document.querySelector('.sidebar-holder').getBoundingClientRect().right <= 0,
  );
  await page.getByRole('heading', { name: '账号与安全' }).scrollIntoViewIfNeeded();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(overflow, false, 'Account security page must fit the narrow viewport');
  for (const name of ['修改称呼', '修改密码', '更新授权']) {
    const box = await page.getByRole('button', { name, exact: true }).boundingBox();
    assert(
      box && box.x >= 0 && box.x + box.width <= 390,
      `${name} must stay inside the mobile viewport`,
    );
  }
  await screenshot('authorization-mobile');
  await page.getByRole('button', { name: '修改称呼', exact: true }).click();
  await page.getByRole('dialog').getByLabel('称呼', { exact: true }).fill('创作者联调');
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('称呼已保存', { exact: true }).waitFor();
  record('Narrow settings layout and profile editing remain functional');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: '管理项目', exact: true }).click();
  const manager = page.locator('.projects-page');
  await manager.getByRole('button', { name: '新建项目', exact: true }).click();
  await page.getByRole('dialog').getByLabel('项目名称', { exact: true }).fill('晨光山谷');
  await page
    .getByRole('dialog')
    .getByLabel('项目简介', { exact: true })
    .fill('验证项目生命周期的独立工程。');
  await page.getByRole('dialog').getByRole('button', { name: '创建并开始', exact: true }).click();
  await page.getByRole('textbox', { name: '发送消息', exact: true }).waitFor();
  await page.getByRole('button', { name: '管理当前项目', exact: true }).click();
  await manager.getByRole('button', { name: '编辑项目晨光山谷', exact: true }).click();
  await page.getByRole('dialog').getByLabel('项目名称', { exact: true }).fill('晨光山谷 · 编辑版');
  await page.getByRole('dialog').getByRole('button', { name: '保存修改', exact: true }).click();
  await manager.getByRole('heading', { name: '晨光山谷 · 编辑版', exact: true }).waitFor();
  await manager.getByRole('button', { name: '归档项目晨光山谷 · 编辑版', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认归档', exact: true }).click();
  await manager.getByRole('button', { name: /^已归档/ }).click();
  await manager.getByRole('button', { name: '恢复项目晨光山谷 · 编辑版', exact: true }).click();
  await manager.getByRole('button', { name: /^进行中/ }).click();
  await manager.getByRole('heading', { name: '晨光山谷 · 编辑版', exact: true }).waitFor();
  await manager.getByRole('button', { name: '断开项目晨光山谷 · 编辑版', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认断开', exact: true }).click();
  await manager.getByText('目录已断开', { exact: true }).waitFor();
  await screenshot('projects-desktop');
  const disconnected = manager
    .locator('.project-card')
    .filter({ has: page.getByRole('heading', { name: '晨光山谷 · 编辑版', exact: true }) });
  await disconnected.getByRole('button', { name: '查看会话', exact: true }).click();
  assert(await page.getByRole('textbox', { name: '发送消息', exact: true }).isDisabled());
  await page.getByRole('button', { name: '管理当前项目', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    () => document.querySelector('.sidebar-holder').getBoundingClientRect().right <= 0,
  );
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await screenshot('projects-mobile');
  record(
    'Project create, rename, archive, restore and disconnect preserve the conversation and block further execution',
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: '插件', exact: true }).click();
  await page.getByRole('button', { name: 'MCP 连接', exact: true }).click();
  await page.getByRole('button', { name: '添加 MCP 连接', exact: true }).click();
  let modal = page.getByRole('dialog');
  await modal.getByLabel('连接名称', { exact: true }).fill('远程素材联调');
  await modal.getByLabel('MCP 连接方式').selectOption('http');
  await modal.getByLabel('服务地址').fill(`http://127.0.0.1:${mcpServer.address().port}/mcp`);
  await modal.getByRole('button', { name: '添加连接', exact: true }).click();
  await page.getByText('插件已添加，探测工具后可选择授权', { exact: true }).waitFor();
  await page.getByRole('button', { name: '探测并授权', exact: true }).click();
  modal = page.getByRole('dialog');
  await modal.getByRole('checkbox', { name: /asset_lookup/ }).check();
  await screenshot('mcp-remote-review');
  await modal.getByRole('button', { name: '允许并启用所选工具', exact: true }).click();
  await page.getByText('已启用所选 MCP 工具', { exact: true }).waitFor();
  await screenshot('mcp-remote-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    () => document.querySelector('.sidebar-holder').getBoundingClientRect().right <= 0,
  );
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
    'MCP list must fit narrow viewport',
  );
  await screenshot('mcp-remote-mobile');
  await page.getByRole('button', { name: '编辑连接', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByLabel('连接名称', { exact: true })
    .fill('远程素材联调 · 已编辑');
  await page.getByRole('dialog').getByRole('button', { name: '保存连接', exact: true }).click();
  await page.getByText('连接已保存，请重新探测并授权工具', { exact: true }).waitFor();
  await page.getByRole('button', { name: '卸载', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认卸载', exact: true }).click();
  await page.getByText('MCP 插件已卸载', { exact: true }).waitFor();
  record(
    'MCP HTTP connection create, probe, selected-tool approval, editing and uninstall work at desktop and narrow widths',
  );
  const journal = new TaskJournal(local.store);
  const originalTask = local.store.get('schedule', taskId, userId);
  const queueTask = { ...originalTask, id: randomUUID(), name: '等待状态更新验证', enabled: false };
  local.store.put('schedule', userId, queueTask);
  const pendingOlder = journal.enqueue(userId, queueTask.id, 'manual');
  for (let i = 0; i < 29; i++) {
    const receipt = journal.enqueue(userId, taskId, 'manual');
    journal.failed(userId, receipt.id, {
      statusCode: 400,
      message: `浏览器联调失败 ${i + 1}：尚未开始执行`,
    });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: /^定时任务/ }).click();
  await page.getByRole('button', { name: /运行记录/ }).click();
  await page.getByText('浏览器联调失败 29：尚未开始执行', { exact: true }).waitFor();
  assert.equal(await page.locator('tbody tr').count(), 25);
  await screenshot('task-history-desktop');
  await page.getByRole('button', { name: '加载更早记录', exact: true }).click();
  const queuedRow = page.locator('tbody tr').filter({ hasText: '等待状态更新验证' });
  await queuedRow.getByText('等待执行', { exact: true }).waitFor();
  journal.failed(userId, pendingOlder.id, {
    statusCode: 400,
    message: '较早队列已失败，状态已刷新',
  });
  await queuedRow.getByText('较早队列已失败，状态已刷新', { exact: true }).waitFor();
  assert.equal(
    await page.locator('tbody tr').count(),
    local.store.list('task-occurrence', userId).length,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    () => document.querySelector('.sidebar-holder').getBoundingClientRect().right <= 0,
  );
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.locator('.page-scroll').evaluate((node) => (node.scrollTop = 0));
  await screenshot('task-history-mobile');
  record(
    'Task receipts show pre-run failures, paginate beyond 25, refresh older queued states and fit a 390px viewport',
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpectedResponses, []);
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  record('No JavaScript errors, unexpected HTTP failures or framework overlay');
} catch (error) {
  await screenshot('failure').catch(() => {});
  process.exitCode = 1;
  console.error(error.message);
} finally {
  const receipt = {
    verificationId,
    at: new Date().toISOString(),
    passed: !process.exitCode,
    completed,
    errors,
    unexpectedResponses,
    artifacts,
  };
  await writeFile(join(artifacts, 'receipt.json'), JSON.stringify(receipt, null, 2));
  await browser.close();
  mcpServer.closeAllConnections();
  await new Promise((done) => mcpServer.close(done));
  await new Promise((done) => proxy.close(done));
  await local.app.close();
  await api.app.close();
  await rm(dataDir, { recursive: true, force: true });
  console.log(JSON.stringify(receipt));
}
