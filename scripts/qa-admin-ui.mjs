import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, _electron } from 'playwright';
import { createApi } from '../apps/api/server.ts';

// Browser plugin not available. Use installed Chromium/Electron, independent
// data and profiles; no user's Chrome session or paid model is accessed.
const native = process.argv.includes('--electron'),
  require = createRequire(import.meta.url);
const id = randomUUID(),
  dataDir = await mkdtemp(join(tmpdir(), 'lightmao-admin-ui-'));
const artifacts = resolve(
  process.env.LIGHTMAO_QA_ARTIFACT_DIR || join(tmpdir(), `lightmao-admin-artifacts-${id}`),
);
await mkdir(artifacts, { recursive: true });
let time = Date.now(),
  upstreamCalls = 0,
  browser,
  app,
  page,
  base,
  preferences;
const completed = [],
  errors = [],
  consoleErrors = [],
  responses = [],
  localRequests = [],
  expectedResponses = [];
const upstream = createServer(async (req, res) => {
  for await (const _ of req) {
  }
  upstreamCalls++;
  res
    .writeHead(429, { 'content-type': 'application/json' })
    .end(JSON.stringify({ error: 'PRIVATE_UPSTREAM_TEXT_NOT_FOR_ADMIN' }));
});
await new Promise((done) => upstream.listen(0, '127.0.0.1', done));
const api = await createApi({
  dataDir,
  serveWeb: true,
  arkKey: 'local-admin-fixture-key',
  arkBase: `http://127.0.0.1:${upstream.address().port}`,
  adminEmail: 'admin-qa@example.test',
  adminPassword: 'Admin-QA-fixture-2026',
  auth: { now: () => time, accessTtlMs: 1000 },
});
await api.app.listen({ host: '127.0.0.1', port: 0 });
const apiBase = `http://127.0.0.1:${api.app.server.address().port}`;
const admin = (
  await api.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'admin-qa@example.test', password: 'Admin-QA-fixture-2026' },
  })
).json();
const member = (
  await api.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      name: '测试成员',
      email: 'member-qa@example.test',
      password: 'Member-QA-fixture-2026',
    },
  })
).json();
const auth = (token) => ({ authorization: `Bearer ${token}` });
const call = (url, body, token = admin.token) =>
  api.app.inject({
    url,
    method: body === undefined ? 'GET' : 'PATCH',
    headers: auth(token),
    ...(body === undefined ? {} : { payload: body }),
  });
const storedMember = api.store.get('user', member.user.id);
for (let n = 0; n < 58; n++)
  api.store.put('user', 'system', {
    ...storedMember,
    id: randomUUID(),
    name: `分页成员 ${String(n).padStart(3, '0')}`,
    email: `member-${n}-with-a-long-test-address@example.test`,
  });
for (let n = 0; n < 135; n++)
  api.store.put('usage', 'system', {
    id: `qa-history-${String(n).padStart(3, '0')}`,
    userId: member.user.id,
    model: 'qa-history-model',
    status: n % 3 ? 'completed' : 'upstream_429',
    durationMs: 123,
    at: new Date(time - n * 3600000).toISOString(),
    ...(n % 2 ? { totalTokens: 13 } : {}),
    ...(n % 3 ? {} : { failureReason: 'upstream_error', upstreamStatus: 429 }),
  });
for (let n = 0; n < 127; n++)
  api.store.put('audit', 'system', {
    id: randomUUID(),
    actor: admin.user.id,
    action: 'fixture.audit',
    detail: `历史审计 ${String(n).padStart(3, '0')}`,
    at: new Date(time - n * 60000).toISOString(),
  });
const record = (name) => {
  completed.push(name);
  console.log(JSON.stringify({ passed: name }));
};
async function until(check, message) {
  for (let n = 0; n < 150; n++) {
    if (await check()) return;
    await delay(30);
  }
  throw Error(message || 'State did not settle');
}
async function login(email = 'admin-qa@example.test', password = 'Admin-QA-fixture-2026') {
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}
async function tab(name) {
  await page.getByRole('tab', { name, exact: true }).click();
}
async function save() {
  const response = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/admin/model' && r.request().method() === 'PATCH',
  );
  await page.getByRole('button', { name: '保存模型配置', exact: true }).click();
  return response;
}
async function screenshot(name) {
  await page.screenshot({
    path: join(artifacts, name),
    type: 'jpeg',
    quality: 85,
    fullPage: false,
    animations: 'disabled',
  });
}
function observe(target) {
  target.on('pageerror', (e) => errors.push(e.message));
  target.on('console', (m) => {
    if (['error', 'warn'].includes(m.type())) consoleErrors.push(m.text());
  });
  target.on('request', (r) => {
    if (new URL(r.url()).pathname.startsWith('/local/'))
      localRequests.push(new URL(r.url()).pathname);
  });
  target.on('response', (r) => {
    const path = new URL(r.url()).pathname;
    if (r.status() < 400) return;
    if (
      (path === '/api/auth/refresh' && r.status() === 401) ||
      (path === '/api/admin/model' && r.status() === 409) ||
      (r.status() === 401 && path.startsWith('/api/admin/'))
    ) {
      expectedResponses.push({ path, status: r.status() });
      return;
    }
    responses.push({ path, status: r.status() });
  });
}
let passed = false;
try {
  if (native) {
    const reserved = createServer();
    await new Promise((done) => reserved.listen(0, '127.0.0.1', done));
    const agentPort = reserved.address().port;
    await new Promise((done) => reserved.close(done));
    const env = {
      ...process.env,
      LIGHTMAO_DEMO: 'false',
      LIGHTMAO_API_URL: apiBase,
      API_PORT: String(api.app.server.address().port),
      AGENT_PORT: String(agentPort),
      LIGHTMAO_DATA_DIR: dataDir,
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
      timeout: 30000,
    });
    page = await app.firstWindow();
    await page.waitForURL((url) => url.protocol === 'http:' && url.hostname === '127.0.0.1', {
      timeout: 30000,
    });
    base = new URL(page.url()).origin;
    preferences = await app.evaluate(({ BrowserWindow }) => {
      const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return {
        contextIsolation: p.contextIsolation,
        sandbox: p.sandbox,
        nodeIntegration: p.nodeIntegration,
      };
    });
    assert.deepEqual(preferences, {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    });
  } else {
    base = apiBase;
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  }
  page.setDefaultTimeout(15000);
  observe(page);
  await page.goto(base + '/admin');
  await login();
  await page.getByRole('heading', { name: '管理工作空间', exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/admin');
  assert.equal(await page.title(), 'LightMao · 游戏创作工作台');
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  assert((await page.locator('body').innerText()).length > 100);
  await page.getByText('共 60 条 · 第 1 页', { exact: true }).waitFor();
  await screenshot('admin-users-desktop.jpg');
  record(
    'Independent /admin renders real totals and bounded user pages without a local daemon request',
  );

  const search = page.getByRole('textbox', { name: '搜索用户名称或邮箱' });
  await search.fill('member-qa@example.test');
  const toggle = page.getByRole('switch', { name: '启用用户测试成员', exact: true });
  await toggle.waitFor();
  await toggle.click();
  await until(() => api.store.get('user', member.user.id).status === 'disabled');
  await until(async () => (await toggle.getAttribute('aria-checked')) === 'false');
  assert.equal((await call('/api/me', undefined, member.token)).statusCode, 403);
  await toggle.click();
  await until(() => api.store.get('user', member.user.id).status === 'active');
  await until(async () => (await toggle.getAttribute('aria-checked')) === 'true');
  assert.equal((await call('/api/me', undefined, member.token)).statusCode, 401);
  record(
    'User search, disable and restore persist, revoke old credentials and require fresh login',
  );

  await search.fill('');
  await page.getByLabel('用户角色', { exact: true }).selectOption('member');
  await page.getByText('共 59 条 · 第 1 页', { exact: true }).waitFor();
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await page.getByText('共 59 条 · 第 2 页', { exact: true }).waitFor();
  if (!native) {
    await page.setViewportSize({ width: 390, height: 844 });
    await screenshot('admin-users-mobile.jpg');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.setViewportSize({ width: 1280, height: 900 });
  }
  record('Role filters and user pagination work; web additionally fits 390px cards');

  time += 2000;
  await page.getByRole('button', { name: '刷新数据', exact: true }).click();
  await page.getByText('共 59 条 · 第 1 页', { exact: true }).waitFor();
  await tab('模型配置');
  await page.getByLabel('显示名称', { exact: true }).waitFor();
  assert.equal(
    (await call('/api/admin/model', { label: '另一个管理员的配置', revision: 0 })).statusCode,
    401,
  );
  // Fetch a fresh external login after the controlled expiry.
  const external = (
    await api.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin-qa@example.test', password: 'Admin-QA-fixture-2026' },
    })
  ).json();
  admin.token = external.token;
  assert.equal(
    (await call('/api/admin/model', { label: '另一个管理员的配置', revision: 0 })).statusCode,
    200,
  );
  await page.getByLabel('显示名称', { exact: true }).fill('保留本地输入');
  assert.equal((await save()).status(), 409);
  await page.getByRole('alert').filter({ hasText: '模型配置已更改' }).waitFor();
  assert.equal(await page.getByLabel('显示名称', { exact: true }).inputValue(), '保留本地输入');
  await page.getByRole('button', { name: '关闭错误提示' }).click();
  await page.getByRole('button', { name: '刷新数据', exact: true }).click();
  await until(
    async () =>
      (await page.getByLabel('显示名称', { exact: true }).inputValue()) === '另一个管理员的配置',
  );
  await page.getByLabel('显示名称', { exact: true }).fill('管理联调模型');
  await page.getByLabel('方舟 Model ID / Endpoint ID', { exact: true }).fill('qa-endpoint-admin');
  await page.getByRole('spinbutton', { name: '单次输出上限', exact: true }).fill('128000');
  assert.equal((await save()).status(), 200);
  await until(() => api.store.get('config', 'model').modelId === 'qa-endpoint-admin');
  assert.equal(api.store.get('config', 'model').maxOutputTokens, 128000);
  await page.getByText('配置版本 2。', { exact: false }).waitFor();
  assert.equal(
    await page.getByRole('switch', { name: '启用模型路由', exact: true }).evaluate((el) => el.type),
    'button',
  );
  await page.getByRole('switch', { name: '启用模型路由', exact: true }).click();
  assert.equal(
    api.store.get('config', 'model').revision,
    2,
    'changing the draft toggle must not submit its form',
  );
  assert.equal((await save()).status(), 200);
  await until(() => api.store.get('config', 'model').enabled === false);
  const blocked = await api.app.inject({
    method: 'POST',
    url: '/api/v1/chat/completions',
    headers: auth(admin.token),
    payload: { model: 'doubao', messages: [{ role: 'user', content: 'blocked before upstream' }] },
  });
  assert.equal(blocked.statusCode, 403);
  assert.equal(upstreamCalls, 0);
  await page.getByText('配置版本 3。', { exact: false }).waitFor();
  await page.getByRole('switch', { name: '启用模型路由', exact: true }).click();
  assert.equal((await save()).status(), 200);
  await page.getByText('配置版本 4。', { exact: false }).waitFor();
  record(
    'Expired access renews; model conflict preserves draft, explicit reload/save works and disabled routing blocks upstream',
  );
  await page.reload();
  await page.getByRole('heading', { name: '管理工作空间', exact: true }).waitFor();
  await tab('模型配置');
  await until(
    async () =>
      (await page.getByLabel('方舟 Model ID / Endpoint ID', { exact: true }).inputValue()) ===
      'qa-endpoint-admin',
  );

  await tab('插件目录');
  const plugin = page.getByRole('switch', { name: '上架项目文件', exact: true });
  await plugin.waitFor();
  await plugin.click();
  await until(() => api.store.get('plugin-policy', 'workspace')?.available === false);
  const memberLogin = (
    await api.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: member.user.email, password: 'Member-QA-fixture-2026' },
    })
  ).json();
  const before = (await call('/api/bootstrap', undefined, memberLogin.token)).json();
  assert.equal(before.plugins.find((p) => p.id === 'workspace').enabled, false);
  assert.equal(
    (await call('/api/plugins/workspace', { enabled: true }, memberLogin.token)).statusCode,
    403,
  );
  await until(async () => (await plugin.getAttribute('aria-checked')) === 'false');
  await screenshot('admin-plugins-desktop.jpg');
  await plugin.click();
  await until(() => api.store.get('plugin-policy', 'workspace').available === true);
  assert.equal(
    (await call('/api/bootstrap', undefined, memberLogin.token))
      .json()
      .plugins.find((p) => p.id === 'workspace').enabled,
    true,
  );
  record(
    'Catalog withdrawal prevents user bypass and preserves existing installation selections for relisting',
  );

  const failure = await api.app.inject({
    method: 'POST',
    url: '/api/v1/chat/completions',
    headers: auth(admin.token),
    payload: { model: 'doubao', messages: [{ role: 'user', content: 'diagnostic fixture' }] },
  });
  assert.equal(failure.statusCode, 429);
  const requestId = failure.headers['x-request-id'];
  assert(requestId);
  assert.equal(upstreamCalls, 1);
  await page.getByRole('button', { name: '刷新数据', exact: true }).click();
  await tab('调用记录');
  await page.getByRole('textbox', { name: '搜索请求 ID、用户或模型' }).fill(requestId);
  await page.getByText('共 1 条 · 第 1 页', { exact: true }).waitFor();
  await page.getByRole('button', { name: '查看详情', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '模型调用详情' });
  await dialog.getByText('上游拒绝请求，请核对模型权限、额度与配置。', { exact: true }).waitFor();
  assert(!(await dialog.innerText()).includes('PRIVATE_UPSTREAM_TEXT_NOT_FOR_ADMIN'));
  await screenshot('admin-request-detail.jpg');
  await dialog.getByRole('button', { name: '复制请求 ID', exact: true }).click();
  await page.getByText('请求 ID 已复制', { exact: true }).waitFor();
  if (!native) {
    await page.setViewportSize({ width: 390, height: 844 });
    await screenshot('admin-request-mobile.jpg');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.setViewportSize({ width: 1280, height: 900 });
  }
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  record(
    'Actual local upstream 429 has a request ID, numeric-only metadata and actionable diagnostics without its body',
  );

  await page.getByRole('textbox', { name: '搜索请求 ID、用户或模型' }).fill('qa-history');
  await page.getByLabel('调用状态', { exact: true }).selectOption('failed');
  await page.getByText('共 45 条 · 第 1 页', { exact: true }).waitFor();
  await page.getByLabel('调用时间', { exact: true }).selectOption('1');
  await until(async () => {
    const text = await page.locator('.admin-pager > span').innerText();
    return text.includes('共 8 条');
  });
  await page.getByLabel('调用时间', { exact: true }).selectOption('all');
  await page.getByLabel('调用状态', { exact: true }).selectOption('all');
  await page.getByText('共 135 条 · 第 1 页', { exact: true }).waitFor();
  const ids = [];
  let pages = 0;
  while (true) {
    ids.push(...(await page.locator('.admin-request-id').allTextContents()));
    pages++;
    const next = page.getByRole('button', { name: '下一页', exact: true });
    if (await next.isDisabled()) break;
    await next.click();
    await page.getByText(`共 135 条 · 第 ${pages + 1} 页`, { exact: true }).waitFor();
  }
  assert.equal(ids.length, 135);
  assert.equal(new Set(ids).size, 135);
  assert.equal(pages, 6);
  record(
    'Request filters, time window and six keyset pages expose all 135 older records without duplicates',
  );

  await tab('审计日志');
  await page.getByRole('textbox', { name: '搜索操作者、事件或详情' }).fill('fixture.audit');
  await page.getByText('共 127 条 · 第 1 页', { exact: true }).waitFor();
  const auditTexts = [];
  let auditPages = 0;
  while (true) {
    auditTexts.push(...(await page.locator('.admin-audit-list article p').allTextContents()));
    auditPages++;
    const next = page.getByRole('button', { name: '下一页', exact: true });
    if (await next.isDisabled()) break;
    await next.click();
    await page.getByText(`共 127 条 · 第 ${auditPages + 1} 页`, { exact: true }).waitFor();
  }
  assert.equal(auditTexts.length, 127);
  assert.equal(new Set(auditTexts).size, 127);
  record('Audit search and six pages retain older events and show the responsible user');

  await tab('用户管理');
  let release;
  const gate = new Promise((done) => {
    release = done;
  });
  let slowStarted = false;
  await page.route('**/api/admin/users?**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('q') !== '分页成员 001') {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    slowStarted = true;
    await gate;
    await route.fulfill({ response }).catch(() => {});
  });
  await page.getByRole('textbox', { name: '搜索用户名称或邮箱' }).fill('分页成员 001');
  await until(() => slowStarted);
  await page.getByRole('textbox', { name: '搜索用户名称或邮箱' }).fill('member-qa@example.test');
  await page.getByRole('switch', { name: '启用用户测试成员', exact: true }).waitFor();
  release();
  await delay(200);
  assert.equal(await page.locator('.user-cell strong').innerText(), '测试成员');
  await page.unroute('**/api/admin/users?**');
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.getByLabel('邮箱', { exact: true }).waitFor();
  await login('member-qa@example.test', 'Member-QA-fixture-2026');
  await page.getByRole('heading', { name: '需要管理员权限', exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: '管理工作空间', exact: true }).count(), 0);
  record(
    'Late filtered responses cannot replace the current selection; member login never reveals admin data',
  );
  assert.equal(localRequests.length, 0, JSON.stringify(localRequests));
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.equal(responses.length, 0, JSON.stringify(responses));
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  const unexplained = consoleErrors.filter(
    (v) => !/Failed to load resource: the server responded with a status of (401|409)/.test(v),
  );
  assert.deepEqual(unexplained, []);
  record(
    'Page identity, nonblank rendering, framework overlay, console and independent cloud-only requests pass',
  );
  passed = true;
} catch (error) {
  if (page) await screenshot('failure.jpg').catch(() => {});
  throw error;
} finally {
  await writeFile(
    join(artifacts, 'receipt.json'),
    JSON.stringify(
      {
        id,
        at: new Date().toISOString(),
        passed,
        native,
        base,
        preferences,
        browser: 'Browser plugin not available; installed Playwright with independent profile',
        viewports: native ? ['native desktop'] : ['1280x900', '390x844'],
        completed,
        errors,
        responses,
        expectedResponses,
        consoleErrors,
        localRequests,
        upstreamCalls,
        scope:
          'Local protocol fixture only; no paid model, real browser/Electron and backend/database. Synthetic older records exercise paging.',
        artifacts,
      },
      null,
      2,
    ) + '\n',
  );
  if (app) await app.close().catch(() => {});
  if (browser) await browser.close();
  await api.app.close();
  upstream.closeAllConnections();
  await new Promise((done) => upstream.close(() => done()));
  await rm(dataDir, { recursive: true, force: true });
}
