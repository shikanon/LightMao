import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createApi } from '../apps/api/server.ts';
import { createLocalAgent } from '../apps/agent/server.ts';
import { Store } from '../packages/shared/store.ts';
import { seedConversation } from '../tests/fixtures/conversation.ts';
import desktop from '../apps/desktop/proxy.cjs';

// Browser plugin is unavailable. Use a private Playwright process, the actual
// workbench and authenticated UI-state service. No user Chrome or model calls.
const root = await mkdtemp(join(tmpdir(), 'lm-viewport-focus-race-'));
const gallery = resolve(
  process.env.LIGHTMAO_QA_ARTIFACT_DIR ||
    '/Users/bytedance/.codex/visualizations/2026/11/02/lightmao-desktop-long-horizon/viewport-focus-race',
);
const webRoot = resolve(process.env.LIGHTMAO_QA_WEB_ROOT || 'dist/web');
await mkdir(gallery, { recursive: true });
const receipt = {
  passed: false,
  completed: [],
  errors: [],
  modelRequests: [],
  snapshots: {},
  browser:
    'Browser plugin unavailable; private Playwright Chromium, actual production UI/API/Agent.',
};
let api, local, proxy, browser, page, owner, token, session;
const draft = 'NATIVE_DRAFT_' + randomUUID() + '：保留正在编辑的构筑约束，尚未发送。';
async function until(check, message) {
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    if (await check()) return;
    await delay(30);
  }
  throw Error(message);
}
async function call(path, payload) {
  const response = await local.app.inject({
    method: payload ? 'POST' : 'GET',
    url: path,
    headers: { authorization: 'Bearer ' + token },
    payload,
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}
async function launchBrowser() {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1512, height: 960 } });
  await context.addInitScript(
    ({ token, owner, session }) => {
      if (window.top !== window || location.protocol !== 'http:') return;
      sessionStorage.setItem('lightmao.token', token);
      sessionStorage.setItem('lightmao.user', owner);
      sessionStorage.setItem('lightmao.active.' + owner, session);
    },
    { token, owner, session: session.id },
  );
  page = await context.newPage();
  page.on('pageerror', (error) => receipt.errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/v1/'))
      receipt.modelRequests.push(new URL(request.url()).pathname);
  });
  proxy = desktop.createDesktopServer({
    webRoot,
    apiBase: api.app.listeningOrigin,
    agentBase: local.app.listeningOrigin,
  });
  await new Promise((done) => proxy.listen(0, '127.0.0.1', done));
  await page.goto('http://127.0.0.1:' + proxy.address().port);
  await until(
    async () =>
      (await page.getByRole('textbox', { name: '发送消息', exact: true }).count()) &&
      !(await page.getByRole('textbox', { name: '发送消息', exact: true }).isDisabled()),
    'Composer did not restore',
  );
}
const editor = () => page.getByRole('textbox', { name: '发送消息', exact: true });
async function readDom() {
  return page.evaluate(() => {
    const input = document.querySelector('textarea[aria-label="发送消息"]'),
      messages = document.querySelector('.messages');
    return {
      text: input.value,
      top: messages.scrollTop,
      focused: document.activeElement === input,
      selectionStart: input.selectionStart,
      selectionEnd: input.selectionEnd,
    };
  });
}
function assertPosition(value) {
  assert.equal(value.focused, true);
  assert.equal(value.selectionStart, 8);
  assert.equal(value.selectionEnd, 25);
  assert(Math.abs(value.top - 850) < 3, 'Reading position changed: ' + JSON.stringify(value));
}
async function assertRestored(name) {
  await until(
    async () => (await editor().inputValue()) === draft && (await readDom()).focused,
    name + ' did not restore input',
  );
  await delay(450); // Past both the 120ms scroll timer and 220ms mirror debounce.
  const actual = await readDom();
  assert.equal(actual.text, draft);
  assertPosition(actual);
  const stored = await call('/local/sessions/' + session.id + '/ui-state/viewport');
  assertPosition(stored.value);
  receipt.snapshots[name] = { actual, stored };
  receipt.completed.push(name);
}
try {
  api = await createApi({ dataDir: join(root, 'api'), demo: true });
  await api.app.listen({ host: '127.0.0.1', port: 0 });
  local = await createLocalAgent({
    dataDir: join(root, 'agent'),
    apiUrl: api.app.listeningOrigin,
    tickMs: 3600000,
  });
  await local.app.listen({ host: '127.0.0.1', port: 0 });
  const login = (
    await api.app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} })
  ).json();
  token = login.token;
  owner = login.user.id;
  const project = (await call('/local/bootstrap')).projects[0];
  session = await call('/local/sessions', { projectId: project.id, title: '焦点与滚动保存竞态' });
  await call('/local/sessions', { projectId: project.id, title: '保存竞态的另一个会话' });
  const db = new Store(join(root, 'agent/local.sqlite'));
  seedConversation(db, owner, session.id, 32, 160, 'VIEWPORT_TIMING_FIXTURE');
  db.close();
  await launchBrowser();
  await editor().fill(draft);
  await page.locator('.messages').evaluate((node) => {
    node.scrollTop = 850;
    node.dispatchEvent(new Event('scroll'));
  });
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
  receipt.rapidEdit = await page.evaluate(() => {
    const messages = document.querySelector('.messages'),
      composer = document.querySelector('textarea[aria-label="发送消息"]');
    composer.blur();
    const started = performance.now();
    messages.dispatchEvent(new Event('scroll'));
    composer.focus({ preventScroll: true });
    composer.setSelectionRange(8, 25);
    composer.dispatchEvent(new Event('select'));
    return {
      elapsedMs: performance.now() - started,
      focused: document.activeElement === composer,
      selectionStart: composer.selectionStart,
      selectionEnd: composer.selectionEnd,
    };
  });
  assert(receipt.rapidEdit.elapsedMs < 120, 'The fixture failed to beat the old scroll timer');
  await delay(650); // Check after the old timer could overwrite the later edit.
  receipt.snapshots.afterTimer = {
    actual: await readDom(),
    stored: await call('/local/sessions/' + session.id + '/ui-state/viewport'),
  };
  assertPosition(receipt.snapshots.afterTimer.actual);
  assertPosition(receipt.snapshots.afterTimer.stored.value);
  assert.equal(receipt.snapshots.afterTimer.stored.value.following, false);
  receipt.completed.push(
    'Scroll → focus/select within 120ms survives the delayed save in durable state',
  );
  await page.screenshot({ path: join(gallery, 'before-reload.png') });
  await page.locator('.session-item').filter({ hasText: '保存竞态的另一个会话' }).click();
  await until(
    async () => (await editor().count()) && !(await editor().isDisabled()),
    'Other session did not open',
  );
  await page.locator('.session-item').filter({ hasText: '焦点与滚动保存竞态' }).click();
  await assertRestored('sessionSwitch');
  await page.reload();
  await assertRestored('reload');
  const oldOrigin = new URL(page.url()).origin;
  await browser.close();
  browser = undefined;
  await new Promise((done) => proxy.close(done));
  proxy = undefined;
  await launchBrowser();
  assert.notEqual(new URL(page.url()).origin, oldOrigin);
  await assertRestored('newBrowserAndOrigin');
  await page.screenshot({ path: join(gallery, 'restored-new-browser.png') });
  assert.deepEqual(receipt.errors, []);
  assert.deepEqual(receipt.modelRequests, []);
  receipt.passed = true;
} catch (error) {
  receipt.errors.push(error.stack || error.message);
  if (page && !page.isClosed())
    await page.screenshot({ path: join(gallery, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  if (proxy) await new Promise((done) => proxy.close(done));
  await local?.app.close();
  await api?.app.close();
  await writeFile(join(gallery, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(
    JSON.stringify({
      passed: receipt.passed,
      completed: receipt.completed,
      errors: receipt.errors,
      gallery,
    }),
  );
}
