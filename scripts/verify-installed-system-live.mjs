import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  stat,
  access,
  realpath,
  rename,
} from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron, chromium } from 'playwright';
import OSS from 'ali-oss';

// Browser plugin not available. Only this run's readonly mounted app, profile,
// API process and verified CDP endpoint are controlled; user Chrome is untouched.
// --protocol exercises the identical UI/engine path without paid cloud services.
const protocol = process.argv.includes('--protocol');
if (!protocol) process.loadEnvFile();
const id = randomUUID(),
  run = promisify(execFile);
const root = await realpath(await mkdtemp(join(tmpdir(), 'lightmao-installed-system-')));
const artifacts = resolve(process.env.LIGHTMAO_QA_ARTIFACT_DIR || join(root, 'artifacts'));
await mkdir(artifacts, { recursive: true });
await mkdir('.lightmao/verification', { recursive: true, mode: 0o700 });
const receiptPath = resolve(
  `.lightmao/verification/installed-system-${protocol ? 'protocol' : 'live'}-${id}.json`,
);
const desktopPackage = JSON.parse(await readFile('release/latest-desktop.json', 'utf8'));
const backendPackage = JSON.parse(await readFile('release/latest-backend.json', 'utf8'));
const mount = join(root, 'Readonly Distribution'),
  profile = join(root, 'Desktop Profile');
const bundle = join(root, 'lightmao-backend'),
  serverData = join(root, 'Backend Data');
const launchDirectory = join(root, 'Unrelated Launch Directory');
const executable = join(mount, 'LightMao.app/Contents/MacOS/LightMao');
const godotPath = resolve(
  process.env.LIGHTMAO_TEST_GODOT_PATH || '.lightmao/tools/godot/4.7.2/Godot.app',
);
const password = randomUUID() + '-Member1',
  adminPassword = randomUUID() + '-Admin1';
const email = `installed-${id}@example.test`,
  adminEmail = `admin-${id}@example.test`;
const assetName = `installed-reference-${id.slice(0, 8)}.md`,
  skillName = '安装版游戏检查';
const testCloudPrefix =
  (process.env.OSS_PREFIX || 'lightmao/v1/').replace(/\/$/, '') + '/verification/' + id + '/';
const assetMarker = 'CLOUD_' + randomUUID(),
  skillMarker = 'SKILL_' + randomUUID();
const targetFile = 'qa/installed-live.gd';
const assetText = `# 游戏检查资料\n资料校验短语：${assetMarker}\n只允许新增 ${targetFile}，保留已有工程文件。\n`;
const skillText = `# 安装版游戏检查\n技能校验短语：${skillMarker}\n先检查工程，按用户要求编写真实 Godot 断言并运行，回读日志后汇报。不得把静态代码检查称为玩家体验验收，不改写已有工程文件。\n`;
const fixtureScript = `extends SceneTree\n\nfunc _init() -> void:\n\tvar state = preload("res://state.gd").new()\n\tif state.stars.size() != 5 or state.collected != 0:\n\t\tpush_error("Initial game state did not match")\n\t\tquit(1)\n\t\treturn\n\tstate.player = state.stars[0]\n\tstate.move(Vector2.ZERO, 0)\n\tif state.collected != 1 or state.stars.size() != 4:\n\t\tpush_error("Game star collection failed")\n\t\tquit(1)\n\t\treturn\n\tprint("PACKAGED_GAME_CHECK_OK ${assetMarker} ${skillMarker}")\n\tquit(0)\n`;
const receipt = {
  id,
  at: new Date().toISOString(),
  protocol,
  passed: false,
  root,
  artifacts,
  desktopPackage: { id: desktopPackage.id, sha256: desktopPackage.dmgSha256 },
  backendPackage: { id: backendPackage.id, sha256: backendPackage.sha256 },
  requestCap: 12,
  completed: [],
  checks: {},
  runs: [],
  requests: [],
  cleanup: [],
  scope: protocol
    ? 'Actual distribution packages, Electron, Pi, local object storage and Godot; model responses are protocol fixtures.'
    : 'Actual distribution packages, Electron, Pi, Ark and OSS with isolated accounts/data. Backend runs on local macOS; no public TLS/Linux/Apple notarization claim.',
};
let app,
  browser,
  page,
  currentPid,
  adminBrowser,
  adminPage,
  backend,
  apiBase,
  localData,
  owner,
  memberToken;
let mounted = false,
  skillId,
  project,
  allowExpectedMemberDenial = false,
  startedCap = false;
const errors = [],
  consoleMessages = [],
  unexpectedResponses = [];
const digest = (data) => createHash('sha256').update(data).digest('hex');
async function fileHash(path) {
  const h = createHash('sha256');
  for await (const data of createReadStream(path)) h.update(data);
  return h.digest('hex');
}
let saveQueue = Promise.resolve();
function save() {
  saveQueue = saveQueue.then(async () => {
    await writeFile(receiptPath + '.tmp', JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
    await rename(receiptPath + '.tmp', receiptPath);
  });
  return saveQueue;
}
async function record(name) {
  receipt.completed.push(name);
  await save();
  console.log(JSON.stringify({ passed: name }));
}
async function until(fn, message, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await delay(80);
  }
  throw Error(message);
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === 'ESRCH') return false;
    throw e;
  }
};
function rows(path, kind, user) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (
      user
        ? db.prepare('SELECT data FROM records WHERE kind=? AND owner=?').all(kind, user)
        : db.prepare('SELECT data FROM records WHERE kind=?').all(kind)
    ).map((v) => JSON.parse(v.data));
  } finally {
    db.close();
  }
}
const cloudRows = (kind, user) => rows(join(serverData, 'server.sqlite'), kind, user);
const localRows = (kind) =>
  localData
    ? rows(join(localData, 'local.sqlite'), kind, kind === 'runtime-lease' ? undefined : owner)
    : [];
function noServerCredentials(pid) {
  const env = execFileSync('ps', ['eww', '-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  assert(
    !/(?:^|\s)(?:ARK_|OSS_|DOUBAO_|LIGHTMAO_ADMIN_)[A-Z0-9_]*=/.test(env),
    'A client process inherited a server credential variable',
  );
}
const text = (m) =>
  typeof m?.content === 'string'
    ? m.content
    : m?.content
        ?.filter((v) => v.type === 'text')
        .map((v) => v.text)
        .join('\n') || '';
function fixtureResponse(body, response) {
  const last = body.messages.findLastIndex((m) => m.role === 'user'),
    prompt = text(body.messages[last]);
  const recent = body.messages.slice(last + 1);
  const called = recent.flatMap((m) => m.tool_calls || []).map((v) => v.function.name);
  let tools = [],
    content;
  if (prompt.includes('MAIN_SYSTEM_LIVE')) {
    if (!called.length)
      tools = [
        ['read_skill_resource', { skillId, path: 'SKILL.md' }],
        ['list_files', { path: '.' }],
        ['inspect_project', {}],
        ['read_file', { path: 'state.gd' }],
      ];
    else if (!called.includes('write_file'))
      tools = [['write_file', { path: targetFile, content: fixtureScript }]];
    else if (!called.includes('run_godot'))
      tools = [
        ['read_file', { path: targetFile }],
        ['run_godot', { action: 'script', script: targetFile, timeoutSeconds: 45 }],
      ];
    else if (!called.includes('read_engine_log'))
      tools = [['read_engine_log', { jobId: localRows('engine-job').at(-1).id, limit: 4000 }]];
    else
      content = `PACKAGED_GAME_CHECK_OK ${assetMarker} ${skillMarker}；真实 Godot 中的项目断言通过，未做玩家体验验收。`;
  } else if (!called.includes('read_file')) tools = [['read_file', { path: targetFile }]];
  else content = `PACKAGED_READ_ONLY_OK ${assetMarker} ${skillMarker}；未写入文件或重跑引擎。`;
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const frame = (delta, finish = null) =>
    `data: ${JSON.stringify({ id: 'packaged-protocol', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  if (tools.length)
    response.write(
      frame({
        role: 'assistant',
        tool_calls: tools.map(([name, args], index) => ({
          index,
          id: randomUUID(),
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        })),
      }),
    );
  else response.write(frame({ role: 'assistant', content }));
  response.write(frame({}, tools.length ? 'tool_calls' : 'stop'));
  response.end(
    'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":40,"total_tokens":1040}}\n\ndata: [DONE]\n\n',
  );
}
const upstream = createServer((request, response) => {
  void (async () => {
    if (request.method !== 'POST' || request.url !== '/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    if (receipt.requests.length >= receipt.requestCap) {
      response
        .writeHead(429, { 'content-type': 'application/json' })
        .end('{"error":"Verification request cap reached"}');
      return;
    }
    const chunks = [];
    let size = 0;
    for await (const data of request) {
      size += data.length;
      if (size > 2 * 1024 ** 2) throw Error('Verification upstream request exceeded its limit');
      chunks.push(data);
    }
    const raw = Buffer.concat(chunks),
      body = JSON.parse(raw.toString());
    const observed = {
      index: receipt.requests.length + 1,
      at: new Date().toISOString(),
      bytes: raw.length,
      messages: body.messages.length,
      asset: raw.includes(Buffer.from(assetMarker)),
      skill: raw.includes(Buffer.from(skillMarker)),
      state: 'started',
    };
    receipt.requests.push(observed);
    await save();
    if (protocol) {
      fixtureResponse(body, response);
      observed.state = 'protocol_completed';
      await save();
      return;
    }
    startedCap = true;
    const abort = new AbortController();
    response.once('close', () => {
      if (!response.writableEnded) abort.abort();
    });
    try {
      const remote = await fetch(
        `${(process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: request.headers.authorization,
          },
          body: raw,
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(180000)]),
          redirect: 'error',
        },
      );
      observed.upstreamStatus = remote.status;
      response.writeHead(remote.status, {
        'content-type': remote.headers.get('content-type') || 'text/event-stream',
      });
      for await (const data of remote.body) {
        if (response.destroyed) break;
        response.write(data);
      }
      response.end();
      observed.state = abort.signal.aborted ? 'client_cancelled' : 'stream_forwarded';
    } catch {
      observed.state = abort.signal.aborted ? 'client_cancelled' : 'forward_failed';
      response.destroy();
    } finally {
      await save();
    }
  })().catch(() => response.destroy());
});
function observe(target, label) {
  target.setDefaultTimeout(20000);
  target.on('pageerror', (e) => errors.push({ label, text: e.message }));
  target.on('console', (m) => {
    if (['error', 'warning'].includes(m.type()))
      consoleMessages.push({ label, text: m.text(), url: m.location().url });
  });
  target.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (
      response.status() >= 400 &&
      !(response.status() === 401 && path === '/api/auth/refresh') &&
      !(allowExpectedMemberDenial && response.status() === 403 && path.startsWith('/api/admin/'))
    )
      unexpectedResponses.push({ label, path, status: response.status() });
  });
}
async function screenshot(name, target = page) {
  await target.screenshot({
    path: join(artifacts, name + '.jpg'),
    type: 'jpeg',
    quality: 85,
    animations: 'disabled',
  });
}
const ownPid = () =>
  execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    .map((v) => v.trim().match(/^(\d+)\s+(.+)$/))
    .find((v) => v && v[2].startsWith(executable + ' '))?.[1];
async function attachAfterRelaunch(oldPid) {
  const pid = Number(
    await until(() => {
      const v = ownPid();
      return v && Number(v) !== oldPid ? v : false;
    }, 'Owned app did not automatically relaunch'),
  );
  currentPid = pid;
  noServerCredentials(pid);
  const endpoint = await until(async () => {
    let output;
    try {
      output = execFileSync(
        'lsof',
        ['-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-nP', '-Fn'],
        { encoding: 'utf8' },
      );
    } catch {
      return false;
    }
    for (const port of [
      ...new Set(
        output
          .split('\n')
          .map((v) => v.match(/^n127\.0\.0\.1:(\d+)$/)?.[1])
          .filter(Boolean),
      ),
    ]) {
      try {
        const value = await fetch(`http://127.0.0.1:${port}/json/version`, {
          signal: AbortSignal.timeout(500),
        }).then((r) => r.json());
        if (value.webSocketDebuggerUrl && /Chrome|Electron/.test(value.Browser || ''))
          return value.webSocketDebuggerUrl;
      } catch {}
    }
    return false;
  }, 'No verified owned app CDP endpoint');
  browser = await chromium.connectOverCDP(endpoint);
  page = await until(
    () =>
      browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url().startsWith('http://127.0.0.1:')),
    'Relaunched renderer did not become ready',
  );
  observe(page, 'desktop');
}
function clientEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/^(ARK_|OSS_|DOUBAO_|LIGHTMAO_|NODE_OPTIONS$|NODE_PATH$|ELECTRON_RUN_AS_NODE$)/.test(key))
      delete env[key];
  return {
    ...env,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LIGHTMAO_USER_DATA_DIR: profile,
    LIGHTMAO_GODOT_PATH: godotPath,
  };
}
async function launchApp() {
  app = await _electron.launch({
    executablePath: executable,
    args: [],
    cwd: launchDirectory,
    env: clientEnvironment(),
    timeout: 30000,
  });
  currentPid = app.process().pid;
  noServerCredentials(currentPid);
  page = await app.firstWindow();
  observe(page, 'desktop');
  await page.waitForURL((u) => u.protocol === 'http:' && u.hostname === '127.0.0.1', {
    timeout: 30000,
  });
  await page.waitForLoadState('load');
}
async function closeApp() {
  if (currentPid && alive(currentPid)) {
    process.kill(currentPid, 'SIGTERM');
    await until(() => !alive(currentPid), 'Owned app did not gracefully exit');
  }
  currentPid = undefined;
  if (browser) await browser.close().catch(() => {});
  browser = undefined;
  if (app) await app.close().catch(() => {});
  app = undefined;
}
async function ui(path, body, method) {
  return page.evaluate(
    async ({ path, body, method }) => {
      const response = await fetch(path, {
        method: method || (body ? 'POST' : 'GET'),
        headers: {
          authorization: 'Bearer ' + sessionStorage.getItem('lightmao.token'),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, data: await response.json() };
    },
    { path, body, method },
  );
}
async function api(path, token, body, method) {
  const response = await fetch(apiBase + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: {
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60000),
  });
  assert(response.ok, `API verification failed ${response.status}: ${path}`);
  return response.json();
}
async function navigate(name) {
  const toggle = page.getByRole('button', { name: '展开导航', exact: true });
  if (await toggle.isVisible()) await toggle.click();
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: new RegExp('^' + name) })
    .click();
}
async function waitRun(runId) {
  const result = await until(
    () => {
      const v = localRows('run').find((v) => v.id === runId);
      return v && v.status !== 'running' ? v : false;
    },
    'Recorded run has not settled; no automatic resubmission',
    240000,
  );
  const item = receipt.runs.find((v) => v.id === runId);
  if (item)
    Object.assign(item, {
      status: result.status,
      error: result.error,
      tools: localRows('tool-detail')
        .filter((v) => v.runId === runId)
        .map((v) => v.name),
    });
  await save();
  assert.equal(result.status, 'completed', result.error);
  return result;
}
async function send(prompt) {
  await page.getByRole('textbox', { name: '发送消息', exact: true }).fill(prompt);
  const pending = page.waitForResponse(
    (r) =>
      /\/local\/sessions\/[^/]+\/runs$/.test(new URL(r.url()).pathname) &&
      r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const response = await pending;
  assert.equal(response.status(), 200);
  const created = await response.json();
  receipt.runs.push({ id: created.id, sessionId: created.sessionId, status: 'recorded' });
  await save();
  return waitRun(created.id);
}
async function snapshot(path, prefix = '') {
  const files = {};
  for (const entry of await readdir(path, { withFileTypes: true })) {
    assert(!entry.isSymbolicLink());
    const name = prefix + entry.name;
    if (entry.isDirectory())
      Object.assign(files, await snapshot(join(path, entry.name), name + '/'));
    else files[name] = await fileHash(join(path, entry.name));
  }
  return files;
}

// The paid path is deliberately below all package/config and UI setup gates.
try {
  assert(process.platform === 'darwin' && process.arch === 'arm64');
  if (!protocol)
    assert(
      [
        'ARK_API_KEY',
        'ARK_MODEL_ID',
        'OSS_REGION',
        'OSS_BUCKET',
        'OSS_ACCESS_KEY_ID',
        'OSS_ACCESS_KEY_SECRET',
      ].every((k) => !!process.env[k]),
      'Private backend settings incomplete',
    );
  await access(godotPath);
  assert.equal(await fileHash(desktopPackage.dmg), desktopPackage.dmgSha256);
  assert.equal(await fileHash(backendPackage.archive), backendPackage.sha256);
  await mkdir(mount);
  await mkdir(launchDirectory);
  await run('tar', ['-xzf', backendPackage.archive, '-C', root], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  await run('/usr/bin/hdiutil', [
    'attach',
    desktopPackage.dmg,
    '-readonly',
    '-nobrowse',
    '-mountpoint',
    mount,
  ]);
  mounted = true;
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', join(mount, 'LightMao.app')]);
  await new Promise((done) => upstream.listen(0, '127.0.0.1', done));
  const serverEnv = { ...process.env };
  for (const key of Object.keys(serverEnv))
    if (/^(ARK_|OSS_|DOUBAO_|LIGHTMAO_|NODE_OPTIONS$|NODE_PATH$)/.test(key)) delete serverEnv[key];
  Object.assign(serverEnv, {
    NODE_ENV: 'production',
    API_PORT: '0',
    LIGHTMAO_DATA_DIR: serverData,
    LIGHTMAO_DEMO: 'false',
    LIGHTMAO_SECURE_COOKIES: 'true',
    LIGHTMAO_TRUST_PROXY: 'loopback',
    LIGHTMAO_ADMIN_EMAIL: adminEmail,
    LIGHTMAO_ADMIN_PASSWORD: adminPassword,
    LIGHTMAO_STORAGE: protocol ? 'local' : 'oss',
    ARK_API_KEY: protocol ? 'installed-system-protocol' : process.env.ARK_API_KEY,
    ARK_MODEL_ID: protocol ? 'installed-system-protocol' : process.env.ARK_MODEL_ID,
    ARK_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
  });
  if (!protocol)
    for (const key of ['OSS_REGION', 'OSS_BUCKET', 'OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET'])
      serverEnv[key] = process.env[key];
  if (!protocol) serverEnv.OSS_PREFIX = testCloudPrefix;
  receipt.cloudPrefixIsolated = !protocol;
  backend = spawn(process.execPath, [join(bundle, 'dist/api/index.js')], {
    cwd: launchDirectory,
    env: serverEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  backend.output = '';
  for (const stream of [backend.stdout, backend.stderr])
    stream.on('data', (data) => {
      backend.output = (backend.output + data).slice(-6000);
    });
  backend.done = new Promise((done, reject) => {
    backend.once('error', reject);
    backend.once('exit', (code, signal) => done({ code, signal }));
  });
  apiBase = await until(() => {
    if (backend.exitCode !== null) throw Error('Owned backend exited during startup');
    return backend.output.match(/LightMao API: (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
  }, 'Packaged backend did not start');
  const health = await fetch(apiBase + '/api/health').then((r) => r.json());
  assert.equal(health.demoAllowed, false);
  assert.equal(health.protocolVersion, 1);
  receipt.api = {
    pid: backend.pid,
    base: apiBase,
    production: true,
    storage: protocol ? 'local' : 'oss',
    authStorageIndependent: health.features?.accountBootstrap === true,
  };
  await record(
    'Verified immutable distribution bytes; actual packaged backend starts in production outside source and data directories',
  );
  await launchApp();
  await page.getByRole('heading', { name: '连接你的工作空间', exact: true }).waitFor();
  await page.getByLabel('后端服务地址', { exact: true }).fill(apiBase);
  await page.getByRole('button', { name: '检查连接', exact: true }).click();
  await page.getByText(/连接可用 · LightMao API/).waitFor();
  const oldPid = currentPid;
  await page.getByRole('button', { name: '保存并重新打开', exact: true }).click();
  await attachAfterRelaunch(oldPid);
  await page.getByRole('button', { name: '还没有账号？注册', exact: true }).click();
  await page.getByLabel('称呼', { exact: true }).fill('安装版真实联调');
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '创建账号', exact: true }).click();
  await page.getByRole('navigation', { name: '主导航' }).waitFor({ timeout: 60000 });
  memberToken = await page.evaluate(() => sessionStorage.getItem('lightmao.token'));
  owner = (await api('/api/me', memberToken)).id;
  const memberDenied = await fetch(apiBase + '/api/admin/overview', {
    headers: { authorization: 'Bearer ' + memberToken },
  });
  assert.equal(memberDenied.status, 403);
  await memberDenied.body?.cancel();
  localData = join(profile, 'workspaces', digest(apiBase));
  receipt.owner = owner;
  const bootstrap = (await ui('/local/bootstrap')).data;
  assert(bootstrap.runtime.isolation.available);
  const runtime = await page.evaluate(() => window.lightmaoDesktop.runtimeStatus());
  assert(runtime.ownsAgent && runtime.agentOnline);
  const preferences = await page.evaluate(() => ({
    require: typeof window.require,
    process: typeof window.process,
  }));
  assert.deepEqual(preferences, { require: 'undefined', process: 'undefined' });
  const agentLease = localRows('runtime-lease')[0];
  noServerCredentials(agentLease.pid);
  receipt.checks.clientServerCredentialVariablesAbsent = true;
  receipt.checks.productionMemberRegistration = true;
  receipt.checks.memberCannotAccessAdmin = true;
  await record(
    'Actual installed app saves its backend, relaunches and registers a member; owned Agent is isolated and contains no server credential variables',
  );
  // Reopen after the OS relaunch to direct Electron's real download event to
  // an owned file, without substituting the download or invoking a save UI.
  await closeApp();
  await launchApp();
  await page.getByRole('navigation', { name: '主导航' }).waitFor({ timeout: 60000 });
  memberToken = await page.evaluate(() => sessionStorage.getItem('lightmao.token'));
  const nativePreferences = await app.evaluate(({ BrowserWindow }) => {
    const v = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {
      contextIsolation: v.contextIsolation,
      sandbox: v.sandbox,
      nodeIntegration: v.nodeIntegration,
    };
  });
  assert.deepEqual(nativePreferences, {
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
  });
  receipt.nativePreferences = nativePreferences;
  const downloadDirectory = join(root, 'Downloads');
  await mkdir(downloadDirectory);
  await navigate('引擎验证');
  await page.getByRole('button', { name: '创建示例工程', exact: true }).click();
  project = await until(
    () => localRows('project').find((v) => v.name === '星光小径 · Godot 示例'),
    'Sample project was not created',
  );
  assert(project.root.startsWith(localData));
  await until(
    async () =>
      (await page.getByRole('combobox', { name: '引擎验证项目', exact: true }).inputValue()) ===
      project.id,
    'Engine project selection did not settle',
  );
  const originalFiles = await snapshot(project.root);
  await page.getByRole('button', { name: '使用本机预配置', exact: true }).click();
  let modal = page.getByRole('dialog');
  await modal.getByRole('heading', { name: '确认项目引擎授权', exact: true }).waitFor();
  await modal.getByRole('checkbox', { name: '允许此项目在隔离副本中执行代码' }).check();
  await modal.getByRole('button', { name: '确认授权', exact: true }).click();
  await page.locator('.engine-connection').getByText('已授权', { exact: true }).waitFor();
  await page.getByRole('button', { name: '开启验证插件', exact: true }).click();
  await until(
    async () => page.getByRole('button', { name: '开始验证', exact: true }).isEnabled(),
    'Engine plugin was not enabled',
  );
  await navigate('插件');
  await page
    .locator('.plugin-card')
    .filter({ has: page.getByRole('heading', { name: '文件创作', exact: true }) })
    .getByRole('button', { name: '安装插件', exact: true })
    .click();
  await until(
    () =>
      cloudRows('plugin', owner).some((v) => v.catalogId === 'writer' && v.installed && v.enabled),
    'Writer plugin state was not saved',
  );
  await record(
    'UI creates a separate Godot project, confirms the configured engine execution scope and installs actual engine/file-writing plugins',
  );
  await navigate('技能');
  await page.getByRole('button', { name: '创建技能', exact: true }).click();
  modal = page.getByRole('dialog');
  await modal.getByLabel('技能名称', { exact: true }).fill(skillName);
  await modal.getByLabel('分类', { exact: true }).selectOption('程序');
  await modal.getByLabel('一句话描述', { exact: true }).fill('真实工程检查，保留来源和验证边界');
  await modal.getByRole('textbox', { name: /技能内容/ }).fill(skillText);
  await modal.getByRole('button', { name: '保存技能', exact: true }).click();
  const skill = await until(
    () => cloudRows('skill', owner).find((v) => v.name === skillName),
    'Skill was not saved',
  );
  skillId = skill.id;
  await navigate('资料空间');
  const upload = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/assets' && r.request().method() === 'POST',
    { timeout: 60000 },
  );
  await page
    .getByLabel('上传资料文件', { exact: true })
    .setInputFiles({ name: assetName, mimeType: 'text/markdown', buffer: Buffer.from(assetText) });
  const uploadResult = await upload;
  assert.equal(uploadResult.status(), 200);
  const asset = await uploadResult.json();
  receipt.assetId = asset.id;
  assert.equal(asset.sha256, digest(assetText));
  const assetRow = page.locator('tr').filter({ has: page.getByText(assetName, { exact: true }) });
  const downloaded = join(downloadDirectory, assetName);
  await app.evaluate(({ BrowserWindow }, destination) => {
    BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_, item) =>
      item.setSavePath(destination),
    );
  }, downloaded);
  await assetRow.getByRole('button', { name: '下载' + assetName, exact: true }).click();
  await until(
    async () =>
      (await stat(downloaded).catch(() => ({ size: 0 }))).size === Buffer.byteLength(assetText),
    'Installed UI download did not complete',
  );
  assert.equal(await fileHash(downloaded), asset.sha256);
  const cloud = await api('/api/bootstrap', memberToken);
  assert.equal(cloud.storage.driver, protocol ? 'local' : 'oss');
  const stored = cloudRows('asset', owner).find((v) => v.id === asset.id);
  assert.equal(stored.object.driver, protocol ? 'local' : 'oss');
  if (!protocol) {
    const url = `https://${process.env.OSS_BUCKET}.${process.env.OSS_REGION.startsWith('oss-') ? process.env.OSS_REGION : 'oss-' + process.env.OSS_REGION}.aliyuncs.com/${testCloudPrefix}${stored.object.key}`;
    const denied = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000) });
    assert.equal(denied.status, 403);
    await denied.body?.cancel();
    receipt.checks.unsignedCloudObjectDenied = true;
  }
  await record(
    protocol
      ? 'Installed UI creates a real cloud-skill record and round-trips exact local-storage download bytes'
      : 'Installed UI creates a cloud skill, uploads to real private OSS, denies unsigned access and downloads exact original bytes',
  );
  const creation = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/local/sessions' && r.request().method() === 'POST',
  );
  await page
    .locator('.project-group')
    .filter({ has: page.getByRole('button', { name: project.name, exact: true }) })
    .getByRole('button', { name: '新会话', exact: true })
    .click();
  const session = await (await creation).json();
  receipt.sessionId = session.id;
  assert.equal(session.projectId, project.id);
  await page.waitForFunction(
    ({ owner, sessionId }) => sessionStorage.getItem(`lightmao.active.${owner}`) === sessionId,
    { owner, sessionId: session.id },
  );
  await page.getByRole('button', { name: '添加技能或资料', exact: true }).click();
  modal = page.getByRole('dialog');
  await modal.getByRole('checkbox', { name: new RegExp(skillName) }).check();
  await modal.getByRole('checkbox', { name: new RegExp(assetName) }).check();
  await modal.getByRole('button', { name: '完成选择', exact: true }).click();
  const mainPrompt = `MAIN_SYSTEM_LIVE：使用当前选中的技能和资料完成实际 Godot 工程检查。先 read_skill_resource 读取所选 SKILL.md 取得技能校验短语；资料中的资料校验短语已附加，不能猜测。并发检查目录/引擎配置并读取 state.gd。只新增 ${targetFile}，extends SceneTree；依据真实 state.gd 检查初始 5 颗星且 collected=0，再把 player 放到第一颗星、调用 move(Vector2.ZERO,0)，检查 collected=1 且剩 4 颗星。任一检查不通过要 push_error 并 quit(1)；通过后 print 一行 PACKAGED_GAME_CHECK_OK 和上述两个原样短语，再 quit(0)。不要修改其他文件或伪造测试报告。read_file 回读新文件后，用 run_godot action=script、script=${targetFile}、timeoutSeconds=45 实际运行；随后 read_engine_log 回读此次日志。最终简短汇报两个原样短语、实际检查状态与日志标记，说明尚未做玩家体验验收。不执行其他引擎作业；需要精确详情时可回读归档。`;
  await save();
  const main = await send(mainPrompt);
  assert(main.text.includes(assetMarker) && main.text.includes(skillMarker));
  const tools = localRows('tool-detail').filter((v) => v.runId === main.id);
  for (const name of [
    'read_skill_resource',
    'list_files',
    'inspect_project',
    'read_file',
    'write_file',
    'run_godot',
    'read_engine_log',
  ])
    assert(
      tools.some((v) => v.name === name && !v.isError),
      'Required real tool missing: ' + name,
    );
  assert.equal(main.toolErrorCount || 0, 0);
  assert.equal(tools.filter((v) => v.name === 'write_file').length, 1);
  assert(
    receipt.requests[0].asset && !receipt.requests[0].skill,
    'Skill body must load progressively, while explicitly selected asset is available',
  );
  assert(receipt.requests.some((v) => v.skill));
  const filesAfter = await snapshot(project.root);
  for (const [name, value] of Object.entries(originalFiles))
    assert.equal(filesAfter[name], value, 'An existing project file changed: ' + name);
  assert.deepEqual(
    Object.keys(filesAfter).filter((name) => !Object.hasOwn(originalFiles, name)),
    [targetFile],
  );
  const generated = await readFile(join(project.root, targetFile), 'utf8');
  assert(
    generated.includes('extends SceneTree') &&
      generated.includes('state.gd') &&
      generated.includes(assetMarker) &&
      generated.includes(skillMarker),
  );
  const jobs = localRows('engine-job').filter((v) => v.runId === main.id);
  assert.equal(jobs.length, 1);
  const job = jobs[0];
  assert.equal(job.status, 'completed');
  assert(job.phases.length >= 2 && job.phases.every((v) => v.code === 0 && v.errorCount === 0));
  receipt.gameVerification = {
    jobId: job.id,
    verification: job.verification,
    phases: job.phases,
    snapshot: job.snapshot,
    generatedFile: join(project.root, targetFile),
    generatedSha256: digest(generated),
    originalFilesUnchanged: true,
  };
  if (job.workerPid && alive(job.workerPid)) noServerCredentials(job.workerPid);
  await page.getByRole('textbox', { name: '发送消息', exact: true }).waitFor();
  await until(
    async () => !(await page.getByRole('button', { name: '停止运行', exact: true }).isVisible()),
    'Final UI state did not settle',
  );
  const trace = page.locator('.execution-trace[aria-label="执行记录"]').last();
  assert.equal(await trace.locator('.execution-toggle').getAttribute('aria-expanded'), 'false');
  await screenshot('real-agent-collapsed');
  await trace.locator('.execution-toggle').click();
  await trace.locator('.execution-body').waitFor();
  await screenshot('real-agent-expanded');
  await navigate('引擎验证');
  await page.getByRole('combobox', { name: '引擎验证项目', exact: true }).selectOption(project.id);
  await page
    .locator('.engine-job-list article')
    .first()
    .getByRole('button', { name: '查看记录', exact: true })
    .click();
  modal = page.getByRole('dialog');
  await modal.locator('.engine-log').filter({ hasText: 'PACKAGED_GAME_CHECK_OK' }).waitFor();
  const log = await modal.locator('.engine-log').innerText();
  assert(log.includes(assetMarker) && log.includes(skillMarker));
  await screenshot('real-engine-log');
  await modal.getByRole('button', { name: '关闭', exact: true }).click();
  receipt.checks.realSelectedContextAndGameExecution = !protocol;
  await record(
    protocol
      ? 'Actual installed Pi executes its fixture-directed skill/file tools and Godot assertions; default collapsed trace and real logs are inspectable'
      : 'Actual Ark progressively reads selected skill/OSS context, writes one game check, reads it back and executes actual Godot assertions; installed UI exposes collapsed trace and exact logs',
  );
  const sourceSession = localRows('session').find((v) => v.id === session.id),
    point = sourceSession.messages.find((v) => v.runId === main.id && v.role === 'assistant');
  const callsBeforeRestart = receipt.requests.length;
  await closeApp();
  assert.equal(localRows('runtime-lease').length, 0);
  await launchApp();
  await page.getByRole('navigation', { name: '主导航' }).waitFor({ timeout: 60000 });
  memberToken = await page.evaluate(() => sessionStorage.getItem('lightmao.token'));
  assert.deepEqual(
    localRows('session').find((v) => v.id === session.id).messages,
    sourceSession.messages,
  );
  assert.equal(receipt.requests.length, callsBeforeRestart);
  assert.equal(await fileHash(join(project.root, targetFile)), digest(generated));
  // Open the persisted session through its actual rendered sidebar.
  await page.locator('.session-item').filter({ hasText: sourceSession.title }).first().click();
  await page.getByRole('button', { name: '从第 1 轮回答分叉', exact: true }).click();
  modal = page.getByRole('dialog');
  await modal.getByLabel('分支名称', { exact: true }).fill('安装版真实历史分支');
  const forked = page.waitForResponse(
    (r) =>
      /\/local\/sessions\/[^/]+\/fork$/.test(new URL(r.url()).pathname) &&
      r.request().method() === 'POST',
  );
  await modal.getByRole('button', { name: '创建分支', exact: true }).click();
  const branch = await (await forked).json();
  assert.equal(branch.forkPoint, point.id);
  assert.deepEqual(branch.messages, sourceSession.messages);
  const continuation = await send(
    `BRANCH_SYSTEM_LIVE：请只调用 read_file 读取 ${targetFile}，返回其中两个校验短语并简短确认。不要写入文件或重新运行引擎。`,
  );
  assert(continuation.text.includes(assetMarker) && continuation.text.includes(skillMarker));
  assert(
    localRows('tool-detail')
      .filter((v) => v.runId === continuation.id)
      .every((v) => v.name === 'read_file'),
  );
  assert.equal(localRows('engine-job').length, jobs.length);
  assert.equal(await fileHash(join(project.root, targetFile)), digest(generated));
  assert.deepEqual(
    localRows('session').find((v) => v.id === session.id).messages,
    sourceSession.messages,
  );
  receipt.checks.nativeRestartAndBranchNoReplay = true;
  await record(
    'Graceful installed-app restart retains the real conversation and files; UI forks its completed turn and a new model run only reads, without replaying engine/write effects',
  );
  await navigate('定时任务');
  await page.getByRole('button', { name: '创建任务', exact: true }).click();
  modal = page.getByRole('dialog');
  const taskName = '安装版真实只读任务';
  await modal.getByLabel('任务名称', { exact: true }).fill(taskName);
  await modal
    .getByLabel('交给 Agent 的任务', { exact: true })
    .fill(
      `TASK_SYSTEM_LIVE：只用 read_file 读取 ${targetFile}，原样返回其中两个校验短语。不要写文件或运行引擎。`,
    );
  await modal.getByLabel('所属项目', { exact: true }).selectOption(project.id);
  await modal.getByLabel('模型模式', { exact: true }).selectOption('ark');
  await modal.getByLabel('运行频率', { exact: true }).selectOption('interval');
  await modal.getByLabel('间隔（分钟）', { exact: true }).fill('1440');
  await modal.getByRole('button', { name: '保存任务', exact: true }).click();
  const task = await until(
    () => localRows('schedule').find((v) => v.name === taskName),
    'Task was not persisted',
  );
  receipt.taskId = task.id;
  await page.getByRole('switch', { name: '启用任务' + taskName, exact: true }).click();
  await until(
    () => localRows('schedule').find((v) => v.id === task.id).enabled === false,
    'Future automatic task was not paused',
  );
  const manual = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === `/local/schedules/${task.id}/run` &&
      r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '立即运行' + taskName, exact: true }).click();
  const scheduled = await (await manual).json();
  const occurrence = await until(
    () => localRows('task-occurrence').find((v) => v.id === scheduled.occurrence.id && v.runId),
    'Manual occurrence did not dispatch',
  );
  receipt.runs.push({
    id: occurrence.runId,
    sessionId: occurrence.sessionId,
    status: 'recorded',
    taskId: task.id,
  });
  await save();
  const taskRun = await waitRun(occurrence.runId);
  assert(taskRun.text.includes(assetMarker) && taskRun.text.includes(skillMarker));
  assert.equal(
    localRows('task-occurrence').find((v) => v.id === occurrence.id).status,
    'completed',
  );
  assert(
    localRows('tool-detail')
      .filter((v) => v.runId === taskRun.id)
      .every((v) => v.name === 'read_file'),
  );
  assert.equal(localRows('schedule').find((v) => v.id === task.id).enabled, false);
  await navigate('定时任务');
  await page.getByRole('button', { name: /^运行记录/ }).click();
  await page
    .locator('tbody tr')
    .filter({ hasText: taskName })
    .getByText('已完成', { exact: true })
    .waitFor();
  await screenshot('real-scheduled-receipt');
  receipt.checks.realDeviceAuthorizedManualTask = !protocol;
  await record(
    'Installed UI creates and pauses a durable task, explicitly runs it once using device authorization, and displays its completed independent session without file/engine side effects',
  );
  await until(
    () =>
      cloudRows('usage')
        .filter((v) => v.userId === owner)
        .every((v) => v.status !== 'running'),
    'Backend model accounting has not settled',
  );
  const usage = cloudRows('usage').filter((v) => v.userId === owner);
  assert.equal(usage.length, receipt.requests.length);
  assert(
    usage.every(
      (v) => v.status === 'completed' && Number.isSafeInteger(v.totalTokens) && v.totalTokens > 0,
    ),
  );
  receipt.usage = usage.map((v) => ({
    id: v.id,
    model: v.model,
    status: v.status,
    promptTokens: v.promptTokens,
    completionTokens: v.completionTokens,
    totalTokens: v.totalTokens,
  }));
  receipt.totalTokens = usage.reduce((sum, v) => sum + v.totalTokens, 0);
  const admin = await api('/api/auth/login', undefined, {
    email: adminEmail,
    password: adminPassword,
  });
  const overview = await api('/api/admin/overview?summary=true', admin.token);
  assert.equal(overview.totals.modelRequests, usage.length);
  assert.equal(overview.totals.totalTokens, receipt.totalTokens);
  adminBrowser = await chromium.launch({ headless: true });
  adminPage = await adminBrowser.newPage({ viewport: { width: 1280, height: 900 } });
  observe(adminPage, 'admin');
  await adminPage.goto(apiBase + '/admin');
  await adminPage.getByLabel('邮箱', { exact: true }).fill(adminEmail);
  await adminPage.getByLabel('密码', { exact: true }).fill(adminPassword);
  await adminPage.getByRole('button', { name: '登录', exact: true }).click();
  await adminPage.getByRole('heading', { name: '管理工作空间', exact: true }).waitFor();
  await adminPage.getByRole('tab', { name: '调用记录', exact: true }).click();
  await adminPage.getByText(`共 ${usage.length} 条 · 第 1 页`, { exact: true }).waitFor();
  assert.equal(await adminPage.locator('tbody tr').count(), usage.length);
  await screenshot('real-admin-usage', adminPage);
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpectedResponses, []);
  for (const target of [page, adminPage]) {
    assert.match(await target.title(), /LightMao/);
    assert((await target.locator('body').innerText()).length > 100);
    assert.equal(await target.locator('vite-error-overlay').count(), 0);
  }
  assert.deepEqual(
    consoleMessages.filter(
      (v) =>
        !(v.url && new URL(v.url).pathname === '/api/auth/refresh' && /status of 401/.test(v.text)),
    ),
    [],
  );
  receipt.checks.actualAccountingAndStandaloneAdmin = true;
  await record(
    'Packaged standalone admin displays the actual member model requests and exact upstream numeric usage; page identity, nonblank state, console/network and interaction checks pass',
  );
  receipt.passed = true;
} catch (error) {
  receipt.error = error.message;
  process.exitCode = 1;
  if (page) await screenshot('failure').catch(() => {});
} finally {
  if (localData && owner && page) {
    for (const active of localRows('run').filter((v) => v.status === 'running'))
      await ui(`/local/runs/${active.id}/stop`, {}, 'POST').catch(() => {});
  }
  if (apiBase && owner) {
    try {
      const accounts = [
        { email, password },
        { email: adminEmail, password: adminPassword },
      ];
      for (const account of accounts) {
        const user = cloudRows('user').find((v) => v.email === account.email);
        if (!user) continue;
        const pending = cloudRows('asset-transfer', user.id);
        if (pending.length && !receipt.api.authStorageIndependent)
          throw Error(
            'Older backend has an ambiguous onboarding upload; do not repeat login or PUT',
          );
        const login = await api('/api/auth/login', undefined, account);
        const owned = cloudRows('asset', user.id);
        for (const asset of owned) {
          if (!asset.deletedAt)
            await api(`/api/assets/${asset.id}`, login.token, undefined, 'DELETE');
          await api(`/api/assets/${asset.id}/purge`, login.token, undefined, 'DELETE');
          const result = { id: asset.id, driver: asset.object.driver, purged: true };
          if (!protocol) {
            const client = new OSS({
              region: process.env.OSS_REGION.startsWith('oss-')
                ? process.env.OSS_REGION
                : 'oss-' + process.env.OSS_REGION,
              bucket: process.env.OSS_BUCKET,
              accessKeyId: process.env.OSS_ACCESS_KEY_ID,
              accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
              secure: true,
              authorizationV4: true,
              timeout: 15000,
            });
            let absent = false;
            try {
              await client.head(testCloudPrefix + asset.object.key);
            } catch (error) {
              absent = error.status === 404;
            }
            assert(absent, 'An owned verification cloud object still exists');
            result.absenceVerified = true;
          }
          receipt.cleanup.push({ ...result, accountRole: user.role });
        }
      }
      const transfers = cloudRows('asset-transfer');
      receipt.pendingTransfers = transfers.map((v) => ({ id: v.id, status: v.status }));
      assert.equal(
        transfers.length,
        0,
        'Unknown upload intent retained; do not automatically repeat it',
      );
      assert.equal(cloudRows('asset').length, 0);
      receipt.cloudCleanup = true;
    } catch {
      receipt.cloudCleanup = false;
      receipt.passed = false;
      receipt.cleanupError =
        'Owned cloud cleanup needs inspection; unknown operations were not repeated';
      process.exitCode = 1;
    }
  }
  receipt.errors = errors;
  receipt.consoleMessages = consoleMessages;
  receipt.unexpectedResponses = unexpectedResponses;
  await closeApp().catch(() => {});
  if (adminBrowser) await adminBrowser.close().catch(() => {});
  if (backend && backend.exitCode === null && backend.signalCode === null) {
    backend.kill('SIGTERM');
    const ended = await backend.done;
    receipt.backendExit = ended;
  }
  upstream.closeAllConnections();
  await new Promise((done) => upstream.close(done));
  if (mounted) await run('/usr/bin/hdiutil', ['detach', mount]).catch(() => {});
  await save();
  await writeFile(join(artifacts, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      id,
      protocol,
      passed: receipt.passed,
      completed: receipt.completed,
      requests: receipt.requests.length,
      startedRealModel: startedCap,
      receipt: receiptPath,
      artifacts,
      error: receipt.error,
    }),
  );
}
