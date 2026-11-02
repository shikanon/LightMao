import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright';
import { auditPackage } from './audit-package.mjs';

// Browser plugin not available. This archive and its test database are isolated;
// no root API/Agent, user Chrome, cloud account or paid model is used.
const run = promisify(execFile),
  id = randomUUID();
const pkg = JSON.parse(await readFile('release/latest-backend.json', 'utf8'));
const root = await realpath(await mkdtemp(join(tmpdir(), 'lightmao-backend-qa-')));
const artifacts = resolve(process.env.LIGHTMAO_QA_ARTIFACT_DIR || join(root, 'artifacts'));
await mkdir(artifacts, { recursive: true });
const bundle = join(root, 'lightmao-backend'),
  data = join(root, 'Data Outside Release'),
  launch = join(root, 'Unrelated Cwd');
await mkdir(launch);
await writeFile(
  join(launch, '.env'),
  'LIGHTMAO_DEMO=true\nARK_API_KEY=poisoned-working-directory\n',
);
const completed = [],
  errors = [],
  consoleMessages = [],
  responses = [],
  localRequests = [];
let passed = false,
  child,
  base,
  browser,
  page,
  modelCalls = 0,
  holdCalls = 0;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const record = (name) => {
  completed.push(name);
  console.log(JSON.stringify({ passed: name }));
};
const upstream = createServer(async (req, res) => {
  try {
    assert.equal(req.headers.authorization, 'Bearer package-protocol-fixture');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw);
    modelCalls++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"BACKEND_PACKAGE_STREAM_OK"}}]}\n\n');
    if (input.messages[0].content === 'hold') {
      holdCalls++;
      return;
    }
    res.end('data: {"choices":[],"usage":{"total_tokens":11}}\n\ndata: [DONE]\n\n');
  } catch {
    res.destroy();
  }
});
await new Promise((done) => upstream.listen(0, '127.0.0.1', done));
const env = { ...process.env };
for (const key of Object.keys(env))
  if (/^(ARK_|OSS_|DOUBAO_|LIGHTMAO_|API_PORT$|NODE_OPTIONS$|NODE_PATH$)/.test(key))
    delete env[key];
Object.assign(env, {
  NODE_ENV: 'production',
  API_PORT: '0',
  LIGHTMAO_DATA_DIR: data,
  LIGHTMAO_ADMIN_EMAIL: 'backend-admin@example.test',
  LIGHTMAO_ADMIN_PASSWORD: 'Backend-Fixture-2026',
  LIGHTMAO_SECURE_COOKIES: 'true',
  LIGHTMAO_DEMO: 'false',
  LIGHTMAO_TRUST_PROXY: 'loopback',
  LIGHTMAO_WEB_ORIGINS: 'https://agent.example.test',
  ARK_API_KEY: 'package-protocol-fixture',
  ARK_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
});
const entry = join(bundle, 'dist/api/index.js'),
  helper = join(bundle, 'tools/backend-data.mjs');
async function until(fn, message, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await delay(50);
  }
  throw Error(message);
}
function launchApi(directory) {
  const process = spawn(globalThis.process.execPath, [entry], {
    cwd: launch,
    env: { ...env, LIGHTMAO_DATA_DIR: directory },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  process.output = '';
  for (const stream of [process.stdout, process.stderr])
    stream.on('data', (chunk) => {
      process.output = (process.output + chunk).slice(-20000);
    });
  process.done = new Promise((done, reject) => {
    process.once('error', reject);
    process.once('exit', (code, signal) => done({ code, signal }));
  });
  return process;
}
async function start(directory = data) {
  child = launchApi(directory);
  base = await until(() => {
    if (child.exitCode !== null) throw Error('Packaged API startup failed: ' + child.output);
    return child.output.match(/LightMao API: (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
  }, 'Packaged API did not reach ready');
  const res = await fetch(base + '/api/health'),
    v = await res.json();
  assert.equal(res.status, 200);
  assert.equal(v.protocolVersion, 1);
  assert.equal(v.demoAllowed, false);
}
async function stop(signal = 'SIGTERM') {
  const owned = child;
  child = undefined;
  owned.kill(signal);
  const result = await Promise.race([
    owned.done,
    delay(10000).then(() => {
      throw Error('Packaged API did not stop');
    }),
  ]);
  if (signal === 'SIGTERM') assert.equal(result.code, 0, owned.output);
  else assert.equal(result.signal, signal);
  return owned.output;
}
async function json(path, token, body, method) {
  const res = await fetch(base + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: {
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, data: await res.json(), headers: res.headers };
}
async function model(token, prompt) {
  return fetch(base + '/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'doubao',
      stream: true,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
}
function usage(directory) {
  const db = new DatabaseSync(join(directory, 'server.sqlite'), { readOnly: true });
  try {
    return db
      .prepare("SELECT data FROM records WHERE kind='usage'")
      .all()
      .map((v) => JSON.parse(v.data));
  } finally {
    db.close();
  }
}
async function adminLogin() {
  const login = await json('/api/auth/login', undefined, {
    email: env.LIGHTMAO_ADMIN_EMAIL,
    password: env.LIGHTMAO_ADMIN_PASSWORD,
  });
  assert.equal(login.status, 200);
  return login.data.token;
}
try {
  assert.equal(hash(await readFile(pkg.archive)), pkg.sha256);
  await run('tar', ['-xzf', pkg.archive, '-C', root], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  const audit = await auditPackage(bundle);
  assert.equal(audit.files.length, pkg.audit.files);
  const bad = await run(process.execPath, [entry], {
    cwd: launch,
    env: {
      ...env,
      LIGHTMAO_SECURE_COOKIES: 'false',
      LIGHTMAO_DATA_DIR: join(root, 'must-not-exist'),
    },
  }).then(
    () => false,
    (error) => error.code === 1 && !error.stderr.includes(env.LIGHTMAO_ADMIN_PASSWORD),
  );
  assert(bad);
  await assert.rejects(() => readFile(join(root, 'must-not-exist/server.sqlite')), {
    code: 'ENOENT',
  });
  await start();
  assert.equal((await json('/api/auth/demo', undefined, {})).status, 403);
  record(
    'Extracted, audited backend runs outside the source tree and launch directory; production validation precedes database creation and ignores an unrelated .env',
  );
  const token = await adminLogin();
  const member = await json('/api/auth/register', undefined, {
    name: '发布包成员',
    email: 'backend-member@example.test',
    password: 'Member-Fixture-2026',
  });
  assert.equal(member.status, 200);
  assert.equal((await json('/api/admin/overview', member.data.token)).status, 403);
  assert.equal((await json('/api/admin/overview', token)).status, 200);
  const form = new FormData(),
    bytes = Buffer.from('游戏工程资料 · backend package ' + id);
  form.append('file', new Blob([bytes], { type: 'text/plain' }), 'backend-verification.txt');
  const uploaded = await fetch(base + '/api/assets', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token },
    body: form,
  });
  assert.equal(uploaded.status, 200);
  const asset = await uploaded.json();
  assert.equal(
    (
      await fetch(base + '/api/assets/' + asset.id + '/download', {
        headers: { authorization: 'Bearer ' + member.data.token },
      })
    ).status,
    404,
  );
  const result = await model(token, 'complete');
  assert.equal(result.status, 200);
  assert.match(await result.text(), /BACKEND_PACKAGE_STREAM_OK/);
  assert.equal(usage(data).find((v) => v.status === 'completed').totalTokens, 11);
  record(
    'Real packaged authentication, member authorization, local cloud-drive bytes and streamed gateway accounting work with a local protocol upstream',
  );
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (['error', 'warning'].includes(m.type()))
      consoleMessages.push({ type: m.type(), text: m.text(), url: m.location().url });
  });
  page.on('request', (r) => {
    if (new URL(r.url()).pathname.startsWith('/local/')) localRequests.push(r.url());
  });
  page.on('response', (r) => {
    const path = new URL(r.url()).pathname;
    if (r.status() >= 400 && !(r.status() === 401 && path === '/api/auth/refresh'))
      responses.push({ path, status: r.status() });
  });
  await page.goto(base + '/admin');
  await page.getByLabel('邮箱', { exact: true }).fill(env.LIGHTMAO_ADMIN_EMAIL);
  await page.getByLabel('密码', { exact: true }).fill(env.LIGHTMAO_ADMIN_PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('heading', { name: '管理工作空间', exact: true }).waitFor();
  assert.match(await page.title(), /LightMao/);
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  await page.screenshot({
    path: join(artifacts, 'backend-admin-desktop.jpg'),
    type: 'jpeg',
    quality: 85,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({
    path: join(artifacts, 'backend-admin-narrow.jpg'),
    type: 'jpeg',
    quality: 85,
  });
  assert.deepEqual(localRequests, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(responses, []);
  assert.deepEqual(
    consoleMessages.filter(
      (m) =>
        !(m.url && new URL(m.url).pathname === '/api/auth/refresh' && /status of 401/.test(m.text)),
    ),
    [],
  );
  await browser.close();
  browser = undefined;
  record(
    'Actual archive serves independent /admin with real login, desktop/narrow layouts, no local-Agent requests, no unexpected console/HTTP errors or framework overlay',
  );
  const pending = await model(token, 'hold'),
    consuming = pending.text().catch(() => 'interrupted');
  await until(() => holdCalls === 1, 'Upstream hold not reached');
  const concurrent = launchApi(data);
  const denied = await concurrent.done;
  assert.equal(denied.code, 1);
  assert.match(concurrent.output, /already has a live API/);
  assert.equal(usage(data).filter((v) => v.status === 'running').length, 1);
  await assert.rejects(
    () =>
      run(process.execPath, [
        helper,
        'backup',
        '--data-dir',
        data,
        '--output',
        join(root, 'rejected-live-backup'),
      ]),
    (error) => error.code === 1,
  );
  const started = Date.now();
  await stop();
  const stopMs = Date.now() - started;
  assert(stopMs < 5000);
  await consuming;
  assert.equal(usage(data).filter((v) => v.status === 'interrupted').length, 1);
  await start();
  assert.equal(modelCalls, 2);
  assert.equal(usage(data).filter((v) => v.status === 'running').length, 0);
  record(
    'A second real process and live backup cannot take over the API; SIGTERM settles a live stream, restarts preserve receipts and never replay model requests',
  );
  const crashToken = await adminLogin(),
    crash = await model(crashToken, 'hold'),
    crashReading = crash.text().catch(() => 'crashed');
  await until(() => holdCalls === 2, 'Crash fixture hold not reached');
  await stop('SIGKILL');
  await crashReading;
  assert.equal(usage(data).filter((v) => v.status === 'running').length, 1);
  await start();
  assert.equal(modelCalls, 3);
  assert.equal(usage(data).filter((v) => v.status === 'running').length, 0);
  assert.equal(usage(data).filter((v) => v.status === 'interrupted').length, 2);
  await stop();
  record(
    'SIGKILL leaves unknown accounting; the next exclusive process marks it interrupted without claiming completion or issuing another upstream call',
  );
  const backup = join(root, 'Verified Backup'),
    restored = join(root, 'Restored Copy');
  await run(process.execPath, [helper, 'backup', '--data-dir', data, '--output', backup]);
  const manifest = JSON.parse(await readFile(join(backup, 'backup-manifest.json'), 'utf8'));
  assert.equal(manifest.objects.local, 1); // production creates only the explicitly uploaded file
  const snapshotHash = hash(await readFile(join(backup, 'server.sqlite')));
  await assert.rejects(
    () => run(process.execPath, [helper, 'restore', '--backup', backup, '--output', data]),
    (e) => e.code === 1,
  );
  await run(process.execPath, [helper, 'restore', '--backup', backup, '--output', restored]);
  assert.equal(hash(await readFile(join(backup, 'server.sqlite'))), snapshotHash);
  await start(restored);
  const restoredToken = await adminLogin();
  const download = await fetch(base + '/api/assets/' + asset.id + '/download', {
    headers: { authorization: 'Bearer ' + restoredToken },
  });
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  assert.equal(usage(restored).length, 3);
  assert.equal(modelCalls, 3);
  await stop();
  record(
    'Stopped-service backup verifies SQLite, cursor key and every local object; restore uses a fresh directory, preserves source hashes and reopens accounts, bytes and unknown receipts',
  );
  const object = manifest.files.find((v) => v.path.startsWith('objects/'));
  await writeFile(join(backup, object.path), 'corrupt');
  await assert.rejects(
    () =>
      run(process.execPath, [
        helper,
        'restore',
        '--backup',
        backup,
        '--output',
        join(root, 'corrupt-restore'),
      ]),
    (e) => e.code === 1,
  );
  await assert.rejects(() => readFile(join(root, 'corrupt-restore/server.sqlite')), {
    code: 'ENOENT',
  });
  assert.equal(hash(await readFile(pkg.archive)), pkg.sha256);
  record('Damaged backup is rejected before creating restore data; archive bytes remain unchanged');
  passed = true;
} catch (error) {
  if (page) await page.screenshot({ path: join(artifacts, 'failure.jpg') }).catch(() => {});
  throw error;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (child) await stop().catch(() => {});
  upstream.closeAllConnections();
  await new Promise((done) => upstream.close(done));
  await writeFile(
    join(artifacts, 'receipt.json'),
    JSON.stringify(
      {
        id,
        at: new Date().toISOString(),
        passed,
        packageId: pkg.id,
        archiveSha256: pkg.sha256,
        completed,
        errors,
        consoleMessages,
        responses,
        localRequests,
        modelCalls,
        holdCalls,
        scope:
          'Actual extracted Node 24 backend on macOS; independent databases and local protocol upstream, real signals/crash/restore and browser. No Linux systemd/Nginx/TLS/public or paid-cloud claim.',
        artifacts,
      },
      null,
      2,
    ) + '\n',
  );
  if (passed) await rm(root, { recursive: true, force: true });
}
