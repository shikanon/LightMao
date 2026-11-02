import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';
import { createApi } from '../apps/api/server.ts';
import { Store } from '../packages/shared/store.ts';
import { TaskJournal } from '../apps/agent/task-journal.ts';
// Browser plugin not available. Native Electron uses its isolated QA profile;
// no installed Chrome profile, OS sleep, or login startup setting is changed.
const require = createRequire(import.meta.url);
const dir = await mkdtemp(join(tmpdir(), 'lm-background-'));
const artifacts = resolve(
  process.env.LIGHTMAO_QA_ARTIFACT_DIR || join(tmpdir(), `lm-background-artifacts-${Date.now()}`),
);
await mkdir(artifacts, { recursive: true });
const api = await createApi({ dataDir: dir, demo: true });
await api.app.listen({ host: '127.0.0.1', port: 0 });
const apiBase = `http://127.0.0.1:${api.app.server.address().port}`;
const reservation = createServer();
await new Promise((done) => reservation.listen(0, '127.0.0.1', done));
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const env = {
  ...process.env,
  LIGHTMAO_API_URL: apiBase,
  LIGHTMAO_DATA_DIR: dir,
  AGENT_PORT: String(port),
  LIGHTMAO_QA_PROFILE: join(dir, 'profile'),
};
for (const key of Object.keys(env))
  if (/^(ARK_|OSS_|DOUBAO_|LIGHTMAO_ADMIN_)/.test(key)) delete env[key];
delete env.ELECTRON_RUN_AS_NODE;
let app,
  window,
  db,
  agentBase = `http://127.0.0.1:${port}`,
  token,
  owner;
const errors = [],
  failures = [],
  completed = [];
const record = (name) => {
  completed.push(name);
  console.log(JSON.stringify({ passed: name }));
};
async function launch() {
  app = await electron.launch({
    executablePath: require('electron'),
    args: ['scripts/qa-desktop-entry.cjs'],
    cwd: resolve('.'),
    env,
    timeout: 30000,
  });
  window = await app.firstWindow();
  window.setDefaultTimeout(12000);
  window.on('pageerror', (e) => errors.push(e.message));
  window.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (response.status() >= 400 && !(response.status() === 401 && path === '/api/auth/refresh'))
      failures.push({ path, status: response.status() });
  });
  await window.getByRole('navigation', { name: '主导航' }).waitFor();
  assert.equal(await window.title(), 'LightMao · 游戏创作工作台');
  assert.equal(await window.locator('vite-error-overlay').count(), 0);
  assert((await window.locator('body').innerText()).length > 100);
  const login = await fetch(apiBase + '/api/auth/demo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }).then((r) => r.json());
  token = login.token;
  owner = login.user.id;
}
async function request(path, body) {
  const response = await fetch(agentBase + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await response.json();
  assert(response.ok, `${path}: ${value.error}`);
  return value;
}
async function until(check, message) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(message);
}
async function setting() {
  await window.getByRole('button', { name: '设置', exact: true }).click();
  await window.getByRole('heading', { name: '桌面后台运行' }).waitFor();
}
async function quitByWindow() {
  const closed = app.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed;
  app = undefined;
  await until(async () => {
    try {
      await fetch(agentBase + '/local/health');
      return false;
    } catch {
      return true;
    }
  }, 'Owned Agent must exit with explicit application quit');
}
try {
  await launch();
  await setting();
  const runtime = await window.evaluate(() => window.lightmaoDesktop.runtimeStatus());
  assert(runtime.trayAvailable && runtime.keepRunning && runtime.ownsAgent && runtime.agentOnline);
  assert.equal(await window.evaluate(() => typeof window.require), 'undefined');
  record('Actual native tray, isolated renderer, owned Agent and background preference are ready');
  const project = (await request('/local/bootstrap')).projects[0];
  const task = await request('/local/schedules', {
    name: '后台项目检查',
    prompt: '检查当前项目结构',
    projectId: project.id,
    frequency: 'interval',
    intervalMinutes: 60,
    time: '09:00',
    timezone: 'Asia/Shanghai',
    mode: 'demo',
    enabled: true,
  });
  db = new Store(join(dir, 'local.sqlite'));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  assert.equal(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
    false,
  );
  db.put('schedule', owner, {
    ...db.get('schedule', task.id, owner),
    nextRunAt: new Date(0).toISOString(),
  });
  await until(
    () =>
      db
        .list('task-occurrence', owner)
        .some((o) => o.taskId === task.id && o.status === 'completed'),
    'Timer did not execute while window was hidden',
  );
  assert.equal(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
    false,
  );
  const occurrence = db.list('task-occurrence', owner)[0];
  assert.equal(db.get('run', occurrence.runId, owner).status, 'completed');
  assert(
    db.list('event', owner).some((e) => e.runId === occurrence.runId && e.type === 'tool.finished'),
  );
  record(
    'Closing the native window hides it; the live scheduler completes a real Pi tool run without a renderer',
  );
  const second = spawn(require('electron'), ['scripts/qa-desktop-entry.cjs'], {
    cwd: resolve('.'),
    env,
    stdio: 'ignore',
  });
  const [exit] = await Promise.race([
    once(second, 'exit'),
    delay(8000).then(() => {
      second.kill();
      throw new Error('Second instance did not exit');
    }),
  ]);
  assert.equal(exit, 0);
  await until(
    () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
    'Second launch did not restore the original window',
  );
  assert.equal(db.list('task-occurrence', owner).length, 1);
  record(
    'Second launch exits and restores the existing window without starting a duplicate scheduler',
  );
  const journal = new TaskJournal(db);
  const due = { ...db.get('schedule', task.id, owner), nextRunAt: new Date(1).toISOString() };
  db.put('schedule', owner, due);
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'));
  await until(
    () => db.list('task-occurrence', owner).filter((o) => o.status === 'completed').length === 2,
    'Resume event did not dispatch the due task',
  );
  assert((await window.evaluate(() => window.lightmaoDesktop.runtimeStatus())).resumeAt);
  record(
    'A simulated Electron resume event invokes the authenticated wake path and coalesces overdue work once',
  );
  for (let i = 0; i < 29; i++) {
    const o = journal.enqueue(owner, task.id, 'manual');
    journal.failed(owner, o.id, { statusCode: 400, message: `QA 触发失败 ${i + 1}：运行尚未创建` });
  }
  await window.getByRole('button', { name: '定时任务', exact: true }).click();
  await window.getByRole('button', { name: /运行记录/ }).click();
  await window.getByText('QA 触发失败 29：运行尚未创建', { exact: true }).waitFor();
  assert.equal(await window.locator('tbody tr').count(), 25);
  await window.getByRole('button', { name: '加载更早记录', exact: true }).click();
  await until(
    async () => (await window.locator('tbody tr').count()) === 31,
    'History did not load the next page',
  );
  assert.equal(await window.getByRole('button', { name: '查看会话', exact: true }).count(), 2);
  await window.locator('.page-scroll').evaluate((node) => (node.scrollTop = 0));
  await window.screenshot({
    path: join(artifacts, 'task-occurrence-history.jpg'),
    type: 'jpeg',
    quality: 85,
    animations: 'disabled',
  });
  record(
    'History displays pre-run failures and paginates all 31 receipts; only actual runs link to a session',
  );
  await setting();
  const toggle = window.getByRole('switch', { name: '关闭窗口后继续运行', exact: true });
  await toggle.click();
  await until(
    async () => (await toggle.getAttribute('aria-checked')) === 'false',
    'Background preference did not update',
  );
  const preferences = JSON.parse(
    await readFile(join(env.LIGHTMAO_QA_PROFILE, 'desktop-settings.json'), 'utf8'),
  );
  assert.equal(preferences.keepRunning, false);
  await window.getByRole('heading', { name: '桌面后台运行' }).scrollIntoViewIfNeeded();
  await window.screenshot({
    path: join(artifacts, 'desktop-background-settings.jpg'),
    type: 'jpeg',
    quality: 85,
    animations: 'disabled',
  });
  db.close();
  db = undefined;
  await quitByWindow();
  assert((await fetch(apiBase + '/api/health')).ok, 'External API must remain running');
  record(
    'Disabling background persists to disk; closing the window gracefully stops only the owned Agent',
  );
  await launch();
  await setting();
  const restored = window.getByRole('switch', { name: '关闭窗口后继续运行', exact: true });
  assert.equal(await restored.getAttribute('aria-checked'), 'false');
  await restored.click();
  await until(
    async () => (await restored.getAttribute('aria-checked')) === 'true',
    'Preference was not re-enabled',
  );
  const closed = app.waitForEvent('close');
  await app.evaluate(({ app }) => app.quit());
  await closed;
  app = undefined;
  await until(async () => {
    try {
      await fetch(agentBase + '/local/health');
      return false;
    } catch {
      return true;
    }
  }, 'Explicit quit must close owned runtime');
  record(
    'Relaunch restores preferences and history; explicit quit exits even with background enabled',
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(failures, []);
} catch (error) {
  process.exitCode = 1;
  console.error(error.stack);
  await window?.screenshot({ path: join(artifacts, 'failure.jpg'), type: 'jpeg' }).catch(() => {});
} finally {
  db?.close();
  if (app) await app.close().catch(() => {});
  api.app.server.closeAllConnections();
  await api.app.close();
  await writeFile(
    join(artifacts, 'receipt.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        passed: !process.exitCode,
        browser: 'Browser plugin not available; native Electron/Playwright with isolated profile',
        completed,
        errors,
        failures,
        artifacts,
        scope:
          'Demo model with real Pi tools. Native tray and close/quit exercised; OS resume event simulated. Physical sleep, login startup and native menu clicks not automated.',
      },
      null,
      2,
    ),
  );
  await rm(dir, { recursive: true, force: true });
}
