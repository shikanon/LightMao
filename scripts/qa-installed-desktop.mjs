import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { _electron, chromium } from 'playwright';
import { createApi } from '../apps/api/server.ts';
import { Store } from '../packages/shared/store.ts';
import { seedConversation } from '../tests/fixtures/conversation.ts';

// Browser plugin not available. Only the actual mounted test app's PID and CDP
// ports are inspected; user's Chrome and development LightMao are untouched.
const run = promisify(execFile),
  pkg = JSON.parse(await readFile('release/latest-desktop.json', 'utf8'));
const id = randomUUID(),
  root = await realpath(await mkdtemp(join(tmpdir(), 'lightmao-installed-')));
const artifacts = resolve(
  process.env.LIGHTMAO_QA_ARTIFACT_DIR || join(tmpdir(), 'lightmao-installed-artifacts-' + id),
);
await mkdir(artifacts, { recursive: true });
const mount = join(root, 'Read Only Distribution'),
  profile = join(root, 'Installed Profile'),
  launch = join(root, 'Unrelated Launch Directory');
await mkdir(mount);
await mkdir(launch);
const executable = join(mount, 'LightMao.app/Contents/MacOS/LightMao'),
  completed = [],
  errors = [],
  consoleMessages = [],
  responses = [],
  connections = [],
  sessionPosts = [],
  viewportWrites = [];
let app,
  browser,
  page,
  currentPid,
  mounted = false,
  passed = false,
  holdCalls = 0,
  summaryCalls = 0,
  providerCalls = 0;
let nativeState, nativeShortcuts, nativeStatePreparation, failureReason;
const record = (name) => {
  completed.push(name);
  console.log(JSON.stringify({ passed: name }));
};
const upstream = createServer((req, res) => {
  void (async () => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    providerCalls++;
    const text = (message) =>
      typeof message?.content === 'string'
        ? message.content
        : message?.content
            ?.filter((v) => v.type === 'text')
            .map((v) => v.text)
            .join('\n') || '';
    const prompt = text(body.messages.filter((v) => v.role === 'user').at(-1));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, reason = null) =>
      `data: ${JSON.stringify({ id: 'installed-fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
    if (body.messages.some((m) => text(m).includes('LIGHTMAO_SUMMARY_V1'))) {
      summaryCalls++;
      assert(!body.tools?.length);
      const input = JSON.parse(prompt);
      const source = input.sourceParts.find((v) => v.role === 'user');
      const items = input.previous?.length
        ? input.previous
        : [
            {
              kind: 'constraint',
              text: '保留安装版历史约束，原文可回读。',
              sourceIds: [source.messageId],
            },
          ];
      res.write(chunk({ role: 'assistant', content: JSON.stringify({ items }) }));
      res.write(chunk({}, 'stop'));
      res.end(
        'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":40,"total_tokens":1040}}\n\ndata: [DONE]\n\n',
      );
      return;
    }
    if (prompt.includes('安装版历史验证')) {
      assert(JSON.stringify(body.messages).includes('历史摘要（参考数据'));
      res.write(
        chunk({
          role: 'assistant',
          content: 'INSTALLED_CONTEXT_VERIFIED：已整理较早历史，原文保留。',
        }),
      );
      res.write(chunk({}, 'stop'));
      res.end(
        'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":40,"total_tokens":1040}}\n\ndata: [DONE]\n\n',
      );
      return;
    }
    if (prompt.includes('保持运行')) {
      holdCalls++;
      res.write(chunk({ role: 'assistant', content: '正在运行，等待显式停止。' }));
      return;
    }
    const hasResult = body.messages.some((v) => v.role === 'tool');
    res.write(
      chunk(
        hasResult
          ? { role: 'assistant', content: 'INSTALLED_PI_VERIFIED：已读取安装版工程目录。' }
          : {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'installed-list-files',
                  type: 'function',
                  function: { name: 'list_files', arguments: '{"path":"."}' },
                },
              ],
            },
      ),
    );
    res.write(chunk({}, hasResult ? 'stop' : 'tool_calls'));
    res.write(`data: ${JSON.stringify({ choices: [], usage: { total_tokens: 11 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  })().catch(() => res.destroy());
});
await new Promise((done) => upstream.listen(0, '127.0.0.1', done));
const servers = [],
  received = [[], []],
  loginDiagnostics = [];
for (let index = 0; index < 2; index++) {
  const cloud = await createApi({
    dataDir: join(root, 'cloud-' + index),
    arkKey: 'installed-local-fixture-key',
    // Explicit stress-test budget: eight seeded rounds must trigger compaction.
    // The production 1M / 128000 default is verified separately, without forcing summaries.
    contextWindowTokens: 64000,
    maxOutputTokens: 8192,
    arkBase: `http://127.0.0.1:${upstream.address().port}`,
  });
  cloud.app.addHook('onRequest', async (req) => {
    received[index].push({
      path: req.url,
      auth: req.headers.authorization,
      cookie: req.headers.cookie,
    });
  });
  cloud.app.addHook('preHandler', async (req) => {
    if (req.url === '/api/auth/login')
      loginDiagnostics.push({
        backend: index,
        emailMatches: req.body?.email === 'installed@example.test',
        passwordMatches: req.body?.password === 'Installed-Fixture-2026',
        passwordLength: typeof req.body?.password === 'string' ? req.body.password.length : 0,
      });
  });
  await cloud.app.listen({ host: '127.0.0.1', port: 0 });
  servers.push(cloud);
}
const [a, b] = servers,
  baseA = `http://127.0.0.1:${a.app.server.address().port}`,
  baseB = `http://127.0.0.1:${b.app.server.address().port}`;
const password = 'Installed-Fixture-2026',
  user = await a.auth.createUser('安装验证成员', 'installed@example.test', password, 'member');
b.store.put('user', 'system', a.store.get('user', user.id));
const userData = (base) =>
  join(profile, 'workspaces', createHash('sha256').update(base).digest('hex'));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === 'ESRCH') return false;
    throw e;
  }
};
async function until(fn, message, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await delay(50);
  }
  throw Error(message);
}
function ownPid() {
  const rows = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n');
  return rows
    .map((line) => line.trim().match(/^(\d+)\s+(.+)$/))
    .find((v) => v && v[2].startsWith(executable + ' '))?.[1];
}
function observe(target) {
  target.setDefaultTimeout(20000);
  target.on('request', (request) => {
    if (
      request.method() !== 'PUT' ||
      !/\/ui-state\/viewport$/.test(new URL(request.url()).pathname)
    )
      return;
    try {
      const body = request.postDataJSON();
      viewportWrites.push({
        at: new Date().toISOString(),
        path: new URL(request.url()).pathname,
        revision: body.revision,
        value: body.value,
      });
    } catch {}
  });
  target.on('pageerror', (e) => errors.push(e.message));
  target.on('console', (m) => {
    if (['error', 'warning'].includes(m.type()))
      consoleMessages.push({ type: m.type(), text: m.text(), url: m.location().url });
  });
  target.on('response', (r) => {
    const path = new URL(r.url()).pathname;
    if (path === '/local/sessions' && r.request().method() === 'POST')
      sessionPosts.push({ origin: new URL(r.url()).origin, status: r.status() });
    if (r.status() >= 400 && !(r.status() === 401 && path === '/api/auth/refresh'))
      responses.push({ path, status: r.status() });
  });
}
async function attachAfterRestart(oldPid, oldOrigin) {
  if (browser) {
    await browser.close().catch(() => {});
    browser = undefined;
  }
  await until(() => !alive(oldPid), 'The previous main process did not actually exit');
  const pid = Number(
    await until(() => {
      const value = ownPid();
      return value && Number(value) !== oldPid ? value : false;
    }, 'Automatic relaunch did not start a new main process'),
  );
  currentPid = pid;
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
    const ports = [
      ...new Set(
        output
          .split('\n')
          .map((v) => v.match(/^n127\.0\.0\.1:(\d+)$/)?.[1])
          .filter(Boolean),
      ),
    ];
    for (const port of ports) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/version`, {
          signal: AbortSignal.timeout(500),
        });
        const v = await r.json();
        if (v.webSocketDebuggerUrl && /Chrome|Electron/.test(v.Browser || ''))
          return v.webSocketDebuggerUrl;
      } catch {}
    }
    return false;
  }, 'No renderer CDP port on the verified relaunched app');
  browser = await chromium.connectOverCDP(endpoint);
  page = await until(
    () =>
      browser
        .contexts()
        .flatMap((v) => v.pages())
        .find((v) => v.url().startsWith('http://127.0.0.1:')),
    'Relaunched renderer not ready',
  );
  observe(page);
  const origin = new URL(page.url()).origin;
  assert.notEqual(origin, oldOrigin, 'A real main restart must create a new renderer origin');
  assert(!['4317', '4318', '4319'].includes(new URL(origin).port));
  connections.push({
    pid,
    previousPid: oldPid,
    previousExited: true,
    origin,
    previousOrigin: oldOrigin,
  });
}
async function saveConnection(base) {
  await page.getByLabel('后端服务地址', { exact: true }).fill(base);
  await page.getByRole('button', { name: '检查连接', exact: true }).click();
  await page.getByText(/连接可用 · LightMao API/).waitFor();
  const oldPid = currentPid;
  const oldOrigin = new URL(page.url()).origin;
  await page.getByRole('button', { name: '保存并重新打开', exact: true }).click();
  await attachAfterRestart(oldPid, oldOrigin);
}
async function login() {
  await page.getByLabel('邮箱', { exact: true }).fill(user.email);
  await page.getByLabel('密码', { exact: true }).fill(password);
  assert(
    (await page.getByLabel('邮箱', { exact: true }).inputValue()) === user.email,
    'Fixture email input was not set exactly',
  );
  assert(
    (await page.getByLabel('密码', { exact: true }).inputValue()) === password,
    'Fixture password input was not set exactly',
  );
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('navigation', { name: '主导航' }).waitFor();
}
async function json(path, body, method) {
  return page.evaluate(
    async ({ path, body, method }) => {
      const r = await fetch(path, {
        method: method || (body ? 'POST' : 'GET'),
        headers: {
          authorization: 'Bearer ' + sessionStorage.getItem('lightmao.token'),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: r.status, data: await r.json() };
    },
    { path, body, method },
  );
}
async function createProject(name) {
  await page.getByRole('button', { name: '管理项目', exact: true }).click();
  await page
    .locator('.projects-page')
    .getByRole('button', { name: '新建项目', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: '创建项目' });
  await dialog.getByLabel('项目名称', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: '创建并开始', exact: true }).click();
  await page.getByRole('textbox', { name: '发送消息', exact: true }).waitFor();
}
async function settings() {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('heading', { name: '账号与安全' }).waitFor();
  await page.getByLabel('后端服务地址', { exact: true }).waitFor();
}
async function shot(name) {
  await page.screenshot({
    path: join(artifacts, name),
    type: 'jpeg',
    quality: 85,
    animations: 'disabled',
  });
}

async function launchControlled(env) {
  app = await _electron.launch({
    executablePath: executable,
    args: [],
    cwd: launch,
    env,
    timeout: 30000,
  });
  currentPid = app.process().pid;
  page = await app.firstWindow();
  observe(page);
}

async function restartForNativeInput(env) {
  // Renderer CDP Input.dispatchKeyEvent bypasses Electron before-input-event.
  // Reopen this exact mounted app/profile to retain a real main-process handle
  // and inject through webContents.sendInputEvent instead of a JS key handler.
  const previousPid = currentPid,
    previousOrigin = new URL(page.url()).origin;
  if (browser) {
    await browser.close().catch(() => {});
    browser = undefined;
  }
  process.kill(previousPid, 'SIGTERM');
  await until(() => !alive(previousPid), 'Installed main did not exit before native-input reopen');
  await app?.close().catch(() => {});
  app = undefined;
  await launchControlled(env);
  await page.getByRole('navigation', { name: '主导航' }).waitFor();
  assert.notEqual(currentPid, previousPid);
  const origin = new URL(page.url()).origin;
  assert.notEqual(origin, previousOrigin);
  connections.push({
    pid: currentPid,
    previousPid,
    previousExited: true,
    origin,
    previousOrigin,
    reason: 'native-input-main-handle',
  });
}

async function nativeChord(key, modifiers = []) {
  await app.evaluate(
    ({ BrowserWindow }, { key, modifiers }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      contents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers });
      contents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers });
    },
    { key, modifiers: ['meta', ...modifiers] },
  );
}

// These are local QA artifacts, not a claim that an Agent generated a game.
// Use the real installed renderer to encode a short, playable, self-contained
// video so the test never downloads media or depends on a system ffmpeg.
async function writeNativeStateFixtures(project) {
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext('2d');
    const paint = (frame) => {
      context.fillStyle = '#eeeafa';
      context.fillRect(0, 0, 320, 180);
      context.fillStyle = '#7560c6';
      context.fillRect(24 + (frame % 24) * 5, 85, 50, 50);
      context.fillStyle = '#282535';
      context.font = '18px sans-serif';
      context.fillText('LightMao native state QA', 22, 42);
    };
    paint(0);
    const stream = canvas.captureStream(8),
      recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' }),
      chunks = [];
    const done = new Promise((resolve, reject) => {
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      recorder.onerror = () => reject(Error('Native QA video encoding failed'));
      recorder.onstop = resolve;
    });
    recorder.start();
    let frame = 0;
    const timer = setInterval(() => paint(++frame), 125);
    await new Promise((resolve) => setTimeout(resolve, 3400));
    clearInterval(timer);
    recorder.stop();
    await done;
    for (const track of stream.getTracks()) track.stop();
    return Array.from(new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer()));
  });
  assert(bytes.length > 100, 'Native QA recorder returned no usable video');
  const names = {
    document: 'native-state-note.md',
    image: 'native-state-art.svg',
    video: 'native-state-video.webm',
    web: 'native-state-game.html',
    model: 'native-state-scene.obj',
  };
  await Promise.all([
    writeFile(
      join(project.root, names.document),
      '# 原生恢复验收文档\n\n' + '保留草稿、阅读位置与多产物视图。\n\n'.repeat(30),
    ),
    writeFile(
      join(project.root, names.image),
      '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="700"><rect width="480" height="700" fill="#eeeafa"/><circle cx="240" cy="260" r="120" fill="#8874cd"/><text x="100" y="470" font-size="36" fill="#282535">LightMao QA</text></svg>',
    ),
    writeFile(join(project.root, names.video), Buffer.from(bytes)),
    writeFile(
      join(project.root, names.web),
      '<!doctype html><meta charset="utf-8"><title>原生网页恢复验收</title><style>body{font:18px system-ui;padding:40px;color:#282535}button{padding:16px}</style><h1>隔离网页产物</h1><button onclick="this.textContent=\'交互已验证\'">开始试玩</button>',
    ),
    writeFile(
      join(project.root, names.model),
      'o NativeStateTriangle\nv -1 -1 0\nv 1 -1 0\nv 0 1 0\nf 1 2 3\n',
    ),
  ]);
  return names;
}

async function prepareNativeState(project, sessionId) {
  await page.getByRole('button', { name: '工作台', exact: true }).click();
  const names = await writeNativeStateFixtures(project);
  // Refresh the real file listing after writing fixtures into this owned test project.
  await page.reload();
  const editor = page.getByRole('textbox', { name: '发送消息', exact: true });
  await until(async () => !(await editor.isDisabled()), 'Native state composer did not restore');
  assert.equal(
    await page.evaluate((owner) => sessionStorage.getItem('lightmao.active.' + owner), user.id),
    sessionId,
  );
  const open = async (name) => {
    await page.getByRole('button', { name: /^文件/ }).click();
    await page.locator('.file-browser').getByRole('button', { name, exact: true }).click();
    await page.getByRole('tab', { name, exact: true }).waitFor();
  };
  await open(names.document);
  await page.getByRole('heading', { name: '原生恢复验收文档', exact: true }).waitFor();
  await open(names.image);
  await page.getByLabel('图片缩放', { exact: true }).fill('1.75');
  await page.getByLabel('图片缩放', { exact: true }).dispatchEvent('input');
  await page.getByLabel('图片缩放', { exact: true }).dispatchEvent('change');
  await open(names.web);
  await page
    .frameLocator(`iframe[title="${names.web}"]`)
    .getByRole('button', { name: '开始试玩', exact: true })
    .click();
  await page
    .frameLocator(`iframe[title="${names.web}"]`)
    .getByRole('button', { name: '交互已验证', exact: true })
    .waitFor();
  await open(names.model);
  await page.getByText('1 个网格 · 0 段动画', { exact: true }).waitFor();
  await open(names.video);
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 1);
  await page.locator('video:visible').evaluate((video) => {
    video.pause();
    video.currentTime = 1.25;
  });
  await page.waitForFunction(
    () => Math.abs(document.querySelector('video')?.currentTime - 1.25) < 0.15,
  );
  const draft = 'NATIVE_DRAFT_' + id + '：保留正在编辑的构筑约束，尚未发送。';
  await editor.fill(draft);
  const viewport = page.locator('.messages');
  await viewport.evaluate((node) => {
    node.scrollTop = 850;
    node.dispatchEvent(new Event('scroll'));
  });
  const top = await viewport.evaluate((node) => node.scrollTop);
  assert(
    top > 300 &&
      (await page.getByRole('button', { name: '回到最新消息', exact: true }).isVisible()),
  );
  // Settle the native scroll event, then deliberately exercise a new scroll →
  // focus/select within one JS task. This must beat the 120ms save timer; waiting
  // longer before focusing would conceal the stale snapshot overwrite bug.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  const rapidEdit = await page.evaluate(() => {
    const messages = document.querySelector('.messages'),
      composer = document.querySelector('textarea[aria-label="发送消息"]');
    composer.blur();
    const start = performance.now();
    messages.dispatchEvent(new Event('scroll'));
    composer.focus({ preventScroll: true });
    composer.setSelectionRange(8, 25);
    composer.dispatchEvent(new Event('select'));
    return {
      elapsedMs: performance.now() - start,
      top: messages.scrollTop,
      focused: document.activeElement === composer,
      selectionStart: composer.selectionStart,
      selectionEnd: composer.selectionEnd,
    };
  });
  assert(
    rapidEdit.elapsedMs < 120 &&
      rapidEdit.focused &&
      rapidEdit.selectionStart === 8 &&
      rapidEdit.selectionEnd === 25,
    'QA did not exercise focus/select before the old scroll timer',
  );
  nativeStatePreparation = { sessionId, rapidEdit };
  await until(async () => {
    const [conversation, position, layout] = await Promise.all(
      ['conversation', 'viewport', 'artifacts'].map((namespace) =>
        json(`/local/sessions/${sessionId}/ui-state/${namespace}`),
      ),
    );
    nativeStatePreparation.saved = {
      conversation: conversation.data,
      viewport: position.data,
      artifacts: layout.data,
    };
    return (
      conversation.data.value?.text === draft &&
      position.data.value?.following === false &&
      position.data.value?.focused === true &&
      position.data.value?.selectionStart === 8 &&
      position.data.value?.selectionEnd === 25 &&
      Math.abs(position.data.value.top - top) < 2 &&
      layout.data.value?.tabs.length === 5 &&
      layout.data.value.active === names.video &&
      layout.data.value.tabs.some(
        (tab) => tab.path === names.image && tab.view.image?.zoom === 1.75,
      ) &&
      layout.data.value.tabs.some(
        (tab) => tab.path === names.video && Math.abs(tab.view.mediaTime - 1.25) < 0.15,
      )
    );
  }, 'Native draft, selection, reading position and artifact metadata were not committed');
  nativeState = {
    sessionId,
    names,
    draft,
    top,
    selectionStart: 8,
    selectionEnd: 25,
    before: { pid: currentPid, origin: new URL(page.url()).origin },
    beforeProviderCalls: providerCalls,
  };
  await shot('installed-native-state-before.jpg');
  record(
    'Installed UI commits a real draft/selection, non-following reading position and five artifact tabs with image zoom/video progress before process exit',
  );
  await settings();
}

async function verifyNativeState() {
  assert(nativeState, 'Native restore setup is missing');
  assert(!alive(nativeState.before.pid), 'Original installed main is still running');
  assert.notEqual(currentPid, nativeState.before.pid);
  assert.notEqual(new URL(page.url()).origin, nativeState.before.origin);
  const editor = page.getByRole('textbox', { name: '发送消息', exact: true });
  await until(
    async () => !(await editor.isDisabled()) && (await editor.inputValue()) === nativeState.draft,
    'Native main restart did not restore the draft',
  );
  assert.equal(
    await page.evaluate((owner) => sessionStorage.getItem('lightmao.active.' + owner), user.id),
    nativeState.sessionId,
  );
  await until(
    async () =>
      editor.evaluate(
        (node) =>
          document.activeElement === node && node.selectionStart === 8 && node.selectionEnd === 25,
      ),
    'Native restart did not restore composer focus and selection',
  );
  await until(
    async () =>
      Math.abs(
        (await page.locator('.messages').evaluate((node) => node.scrollTop)) - nativeState.top,
      ) < 3,
    'Native restart changed the reader position',
  );
  assert(await page.getByRole('button', { name: '回到最新消息', exact: true }).isVisible());
  const tabs = page.getByRole('tablist', { name: '打开的产物', exact: true });
  await tabs.waitFor();
  assert.equal(await tabs.getByRole('tab').count(), 5);
  for (const name of Object.values(nativeState.names))
    assert.equal(await tabs.getByRole('tab', { name, exact: true }).count(), 1);
  assert.equal(
    await tabs
      .getByRole('tab', { name: nativeState.names.video, exact: true })
      .getAttribute('aria-selected'),
    'true',
  );
  await page.waitForFunction(() => {
    const video = document.querySelector('video');
    return video?.readyState >= 1 && video.paused && Math.abs(video.currentTime - 1.25) < 0.2;
  });
  await shot('installed-native-state-restored.jpg');
  await tabs.getByRole('tab', { name: nativeState.names.image, exact: true }).click();
  await until(
    async () => (await page.getByLabel('图片缩放', { exact: true }).inputValue()) === '1.75',
    'Native restart lost image zoom',
  );
  await tabs.getByRole('tab', { name: nativeState.names.document, exact: true }).click();
  await page.getByRole('heading', { name: '原生恢复验收文档', exact: true }).waitFor();
  await tabs.getByRole('tab', { name: nativeState.names.web, exact: true }).click();
  await page
    .frameLocator(`iframe[title="${nativeState.names.web}"]`)
    .getByRole('button', { name: '开始试玩', exact: true })
    .click();
  await page
    .frameLocator(`iframe[title="${nativeState.names.web}"]`)
    .getByRole('button', { name: '交互已验证', exact: true })
    .waitFor();
  await tabs.getByRole('tab', { name: nativeState.names.model, exact: true }).click();
  await page.getByText('1 个网格 · 0 段动画', { exact: true }).waitFor();
  await tabs.getByRole('tab', { name: nativeState.names.image, exact: true }).click();
  await until(async () => {
    const image = page.getByRole('img', { name: nativeState.names.image, exact: true });
    return (
      (await image.count()) === 1 &&
      (await image.evaluate((node) => node.complete && node.naturalWidth === 480)) &&
      (await page.getByLabel('图片缩放', { exact: true }).inputValue()) === '1.75'
    );
  }, 'Restored image did not finish loading before the artifact screenshot');
  assert.equal(
    providerCalls,
    nativeState.beforeProviderCalls,
    'Restoring UI state replayed a provider call',
  );
  nativeState.after = {
    pid: currentPid,
    origin: new URL(page.url()).origin,
    originalMainExited: true,
    restored: [
      'draft',
      'focus',
      'selection',
      'readingPosition',
      'fiveArtifactTabs',
      'imageZoom',
      'videoProgress',
    ],
    webAndModelReopened: true,
  };
  await shot('installed-native-artifacts-restored.jpg');
  record(
    'Actual installed-main exit/new PID/new origin restores the draft, caret selection, reading position and five usable artifact tabs without replaying requests',
  );
}
try {
  await run('/usr/bin/hdiutil', [
    'attach',
    pkg.dmg,
    '-readonly',
    '-nobrowse',
    '-mountpoint',
    mount,
  ]);
  mounted = true;
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', join(mount, 'LightMao.app')]);
  await assert.rejects(
    () => writeFile(join(mount, 'LightMao.app/Contents/Resources/qa-no-write'), 'must fail'),
    { code: 'EROFS' },
  );
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/^(ARK_|OSS_|DOUBAO_|LIGHTMAO_|NODE_OPTIONS$|NODE_PATH$|ELECTRON_RUN_AS_NODE$)/.test(key))
      delete env[key];
  Object.assign(env, {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LIGHTMAO_USER_DATA_DIR: profile,
    ARK_API_KEY: 'MUST_NOT_REACH_RENDERER_' + id,
  });
  await launchControlled(env);
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
  assert.equal(
    await app.evaluate(() =>
      Object.keys(process.env).some((key) => /^(ARK_|OSS_|DOUBAO_|LIGHTMAO_ADMIN_)/.test(key)),
    ),
    false,
  );
  const rendererPid = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.getOSProcessId(),
  );
  const rendererEnv = execFileSync('ps', ['eww', '-p', String(rendererPid), '-o', 'command='], {
    encoding: 'utf8',
  });
  assert(!rendererEnv.includes('MUST_NOT_REACH_RENDERER_'));
  await page.getByRole('heading', { name: '连接你的工作空间', exact: true }).waitFor();
  assert.match(await page.title(), /LightMao/);
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  assert.equal(received[0].length + received[1].length, 0);
  const desktopViewport = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
  }));
  const address = page.getByLabel('后端服务地址', { exact: true });
  assert((await address.boundingBox()).width > 450);
  await shot('installed-first-connection.jpg');
  await page.setViewportSize({ width: 390, height: 844 });
  assert((await address.boundingBox()).width > 250);
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    'Connection form overflows the narrow viewport',
  );
  await shot('installed-first-connection-narrow.jpg');
  await page.setViewportSize(desktopViewport);
  const state = await page.evaluate(() => window.lightmaoDesktop.backendStatus());
  assert(state.ok && !state.value.configured && state.value.packaged && !state.value.readOnly);
  record(
    'Signed local app starts from a read-only DMG outside the source tree, without system Node/pnpm or inherited server keys',
  );
  await page.getByLabel('后端服务地址', { exact: true }).fill('http://remote.example.test');
  await page.getByRole('button', { name: '检查连接', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '远程后端需要 HTTPS' }).waitFor();
  assert.equal(received[0].length + received[1].length, 0);
  await saveConnection(baseA);
  await login();
  await shot('installed-workspace-a.jpg');
  const runtime = await page.evaluate(() => window.lightmaoDesktop.runtimeStatus());
  assert(runtime.ownsAgent && runtime.agentOnline);
  const preferences = await page.evaluate(() => ({
    require: typeof window.require,
    process: typeof window.process,
  }));
  assert.deepEqual(preferences, { require: 'undefined', process: 'undefined' });
  const bootstrap = await json('/local/bootstrap');
  assert(bootstrap.data.runtime.isolation.available);
  assert.equal(
    bootstrap.data.runtime.uiState,
    true,
    'This DMG does not expose durable desktop UI state',
  );
  assert(!new URL(page.url()).port.match(/^(4317|4318|4319)$/));
  record(
    'First connection validates URL, saves atomically and actually relaunches into the authenticated workspace with an owned random-port Agent',
  );
  await restartForNativeInput(env);
  await createProject('安装版专属 A');
  const localA = await json('/local/bootstrap');
  const projectA = localA.data.projects.find((v) => v.name === '安装版专属 A');
  assert(projectA.root.startsWith(userData(baseA)));
  await until(
    async () => !(await page.getByRole('textbox', { name: '发送消息', exact: true }).isDisabled()),
    'Native composer not ready',
  );
  await page.evaluate(() => {
    window.__qaNativeShortcuts = [];
    window.lightmaoDesktop.onDesktopShortcut((action) => window.__qaNativeShortcuts.push(action));
  });
  await page.getByRole('button', { name: '切换预览面板', exact: true }).focus();
  await nativeChord('L');
  await until(
    async () =>
      page
        .getByRole('textbox', { name: '发送消息', exact: true })
        .evaluate((node) => document.activeElement === node),
    'Packaged Cmd+L did not focus the composer',
  );
  assert.deepEqual(await page.evaluate(() => window.__qaNativeShortcuts), ['focus-composer']);
  record(
    'One actual Cmd+L input traverses the packaged main/preload bridge and focuses the composer exactly once',
  );
  await page.getByRole('textbox', { name: '发送消息', exact: true }).fill('检查安装版工程');
  const created = page.waitForResponse(
    (r) =>
      /\/local\/sessions\/[^/]+\/runs$/.test(new URL(r.url()).pathname) &&
      r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const firstRun = await (await created).json();
  const final = await until(async () => {
    const v = (await json('/local/runs/' + firstRun.id)).data;
    return v.status !== 'running' ? v : false;
  }, 'Installed Pi loop did not finish');
  assert.equal(final.status, 'completed', final.error);
  assert.equal(final.toolCount, 1);
  assert.equal(final.toolErrorCount, 0);
  await page.getByText(/INSTALLED_PI_VERIFIED/).waitFor();
  const trace = page.locator('.execution-trace[aria-label="执行记录"] .execution-toggle').first();
  assert.equal(await trace.getAttribute('aria-expanded'), 'false');
  await trace.click();
  await page.locator('.execution-body').waitFor();
  await trace.click();
  await shot('installed-pi-tools.jpg');
  record(
    'Installed Pi performs a real OS-isolated file tool through the authenticated protocol gateway; execution remains collapsed by default',
  );
  const sessionsBeforeShortcut = (await json('/local/bootstrap')).data.sessions
    .filter((session) => session.projectId === projectA.id)
    .map((session) => session.id);
  const postCountBeforeShortcut = sessionPosts.length;
  const sessionCreation = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/local/sessions' && r.request().method() === 'POST',
  );
  await nativeChord('N', ['shift']);
  const historySession = await (await sessionCreation).json();
  await page.waitForFunction(
    ({ owner, id }) => sessionStorage.getItem(`lightmao.active.${owner}`) === id,
    { owner: user.id, id: historySession.id },
  );
  await delay(500);
  const shortcutActions = await page.evaluate(() => window.__qaNativeShortcuts);
  assert.deepEqual(shortcutActions, ['focus-composer', 'new-session']);
  assert.equal(
    sessionPosts.length - postCountBeforeShortcut,
    1,
    'One native new-session chord posted more than once',
  );
  const newSessions = (await json('/local/bootstrap')).data.sessions.filter(
    (session) => session.projectId === projectA.id && !sessionsBeforeShortcut.includes(session.id),
  );
  assert.deepEqual(
    newSessions.map((session) => session.id),
    [historySession.id],
  );
  nativeShortcuts = {
    chordsSent: ['Cmd+L', 'Shift+Cmd+N'],
    delivery:
      'Mounted installed main webContents.sendInputEvent → before-input-event → isolated preload',
    preloadActions: shortcutActions,
    sessionPosts: sessionPosts.length - postCountBeforeShortcut,
    newSessionIds: newSessions.map((session) => session.id),
  };
  record(
    'One actual Shift+Cmd+N input creates and selects exactly one persisted session, with one preload action and one POST',
  );
  const historyDb = new Store(join(userData(baseA), 'local.sqlite'));
  const seeded = seedConversation(
    historyDb,
    user.id,
    historySession.id,
    8,
    3400,
    'INSTALLED_ORIGINAL_' + id,
  );
  historyDb.close();
  await page.reload();
  await page
    .getByRole('textbox', { name: '发送消息', exact: true })
    .fill('安装版历史验证：核对历史，不执行工具。');
  const historyStart = page.waitForResponse(
    (r) =>
      /\/local\/sessions\/[^/]+\/runs$/.test(new URL(r.url()).pathname) &&
      r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const historyRun = await (await historyStart).json();
  const historyFinal = await until(async () => {
    const v = (await json('/local/runs/' + historyRun.id)).data;
    return v.status !== 'running' ? v : false;
  }, 'Installed history projection did not finish');
  assert.equal(historyFinal.status, 'completed', historyFinal.error);
  assert(historyFinal.historyContext?.summaryRef);
  assert(summaryCalls > 0);
  await page.getByText(/INSTALLED_CONTEXT_VERIFIED/).waitFor();
  const historyTrace = page.locator('.execution-trace[aria-label="执行记录"]').last();
  assert.equal(
    await historyTrace.locator('.execution-toggle').getAttribute('aria-expanded'),
    'false',
  );
  await historyTrace.locator('.execution-toggle').click();
  await historyTrace.getByRole('button', { name: '查看历史整理', exact: true }).click();
  const memory = page.getByRole('dialog', { name: '历史整理' });
  await memory.getByRole('button', { name: '查看用户原文', exact: true }).click();
  await until(
    async () =>
      (await memory.locator('.memory-original pre').textContent()) ===
      seeded[0].user.text.slice(0, 2000),
    'Installed source readback mismatch',
  );
  await shot('installed-context-original.jpg');
  await memory.getByRole('button', { name: '关闭对话框', exact: true }).click();
  record(
    'Packaged utilityProcess runs a separate tool-less history summarizer, retains collapsed execution, and loads exact source text from the installed UI',
  );
  await page.getByRole('textbox', { name: '发送消息', exact: true }).fill('保持运行，等待停止');
  const pending = page.waitForResponse(
    (r) =>
      /\/local\/sessions\/[^/]+\/runs$/.test(new URL(r.url()).pathname) &&
      r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const busyRun = await (await pending).json();
  await until(() => holdCalls === 1, 'Hold fixture was not reached');
  await settings();
  await page.getByLabel('后端服务地址', { exact: true }).fill(baseB);
  await page.getByRole('button', { name: '检查连接', exact: true }).click();
  await page.getByText(/连接可用 · LightMao API/).waitFor();
  await page.getByRole('button', { name: '保存并重新打开', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '当前有运行或等待中的任务' }).waitFor();
  assert.equal((await json('/local/runs/' + busyRun.id)).data.status, 'running');
  assert.equal((await json('/local/runs/' + busyRun.id + '/stop', {}, 'POST')).status, 200);
  await until(
    async () => (await json('/local/runs/' + busyRun.id)).data.status !== 'running',
    'Busy run failed to stop',
  );
  record(
    'Switching refuses an actual live model run and preserves it; explicit stop settles the run before retry',
  );
  await prepareNativeState(projectA, historySession.id);
  const callsBeforeSwitch = providerCalls;
  await saveConnection(baseB);
  await login();
  const localB = await json('/local/bootstrap');
  assert(!localB.data.projects.some((v) => v.name === '安装版专属 A'));
  await createProject('安装版专属 B');
  await until(
    async () => !(await page.getByRole('textbox', { name: '发送消息', exact: true }).isDisabled()),
    'Backend B draft restore did not settle',
  );
  assert.equal(await page.getByRole('textbox', { name: '发送消息', exact: true }).inputValue(), '');
  assert.equal(await page.getByRole('tablist', { name: '打开的产物', exact: true }).count(), 0);
  const createdB = (await json('/local/bootstrap')).data.projects.find(
    (v) => v.name === '安装版专属 B',
  );
  assert(createdB.root.startsWith(userData(baseB)));
  const aSecrets = new Set(
    received[0]
      .flatMap((v) => [v.auth?.length > 10 ? v.auth : undefined, v.cookie])
      .filter(Boolean),
  );
  assert(
    !received[1].some(
      (v) => (v.auth && aSecrets.has(v.auth)) || (v.cookie && aSecrets.has(v.cookie)),
    ),
  );
  record(
    'Backend B with the same user ID receives a separate project database, browser partition and device authorization; A credentials never cross',
  );
  await settings();
  await saveConnection(baseA);
  await page.getByRole('navigation', { name: '主导航' }).waitFor();
  const restored = await json('/local/bootstrap');
  assert(restored.data.projects.some((v) => v.id === projectA.id));
  assert(!restored.data.projects.some((v) => v.name === '安装版专属 B'));
  assert.equal((await json('/local/runs/' + firstRun.id)).data.status, 'completed');
  assert.equal((await json('/local/runs/' + busyRun.id)).data.status, 'cancelled');
  assert.equal(providerCalls, callsBeforeSwitch);
  const restoredMemory = (
    await json(
      `/local/sessions/${historySession.id}/context/${historyFinal.historyContext.summaryRef}`,
    )
  ).data;
  assert.equal(restoredMemory.id, historyFinal.historyContext.summaryRef);
  assert(restoredMemory.sourceMessages > 0);
  assert.match(await page.title(), /LightMao/);
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  await shot('installed-restored-workspace.jpg');
  record(
    'Returning to backend A restores durable history and completed/cancelled receipts without replaying model requests or tools',
  );
  await verifyNativeState();
  const pid = currentPid;
  process.kill(pid, 'SIGTERM');
  await until(() => !alive(pid), 'Installed desktop did not exit');
  currentPid = undefined;
  for (const base of [baseA, baseB]) {
    const db = new DatabaseSync(join(userData(base), 'local.sqlite'), { readOnly: true });
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM records WHERE kind='runtime-lease'").get().n,
      0,
    );
    db.close();
  }
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', join(mount, 'LightMao.app')]);
  assert.deepEqual(errors, []);
  assert.deepEqual(responses, []);
  const unexpectedConsole = consoleMessages.filter(
    (m) =>
      !(
        m.url &&
        new URL(m.url).pathname === '/api/auth/refresh' &&
        /Failed to load resource: the server responded with a status of 401/.test(m.text)
      ),
  );
  assert.deepEqual(unexpectedConsole, []);
  record(
    'Graceful installed-app exit releases owned Agent leases; readonly bundle signature, console, HTTP and renderer health remain valid',
  );
  passed = true;
} catch (error) {
  failureReason = error.stack || error.message;
  if (page) await shot('failure.jpg').catch(() => {});
  throw error;
} finally {
  if (currentPid && alive(currentPid)) {
    process.kill(currentPid, 'SIGTERM');
    await until(() => !alive(currentPid), 'QA process cleanup did not finish').catch(() => {});
  }
  if (browser) await browser.close().catch(() => {});
  if (app) await app.close().catch(() => {});
  const extra = ownPid();
  if (extra && alive(Number(extra))) {
    process.kill(Number(extra), 'SIGTERM');
    await until(() => !alive(Number(extra)), 'Relaunched QA app cleanup failed').catch(() => {});
  }
  for (const server of servers) {
    server.app.server.closeAllConnections();
    await server.app.close();
  }
  upstream.closeAllConnections();
  await new Promise((done) => upstream.close(() => done()));
  if (mounted) await run('/usr/bin/hdiutil', ['detach', mount]).catch(() => {});
  await writeFile(
    join(artifacts, 'receipt.json'),
    JSON.stringify(
      {
        id,
        at: new Date().toISOString(),
        passed,
        packageId: pkg.id,
        dmgSha256: pkg.dmgSha256,
        completed,
        connections,
        nativeShortcuts,
        nativeState,
        nativeStatePreparation,
        viewportWrites,
        failureReason,
        errors,
        consoleMessages,
        responses,
        providerCalls,
        holdCalls,
        summaryCalls,
        loginDiagnostics,
        scope:
          'Actual packaged app from readonly DMG, real OS relaunch and owned-CDP reconnect. Independent local backends/protocol provider; no paid model or user Chrome. Not an Apple notarization or public deployment check.',
        artifacts,
      },
      null,
      2,
    ) + '\n',
  );
  if (passed) await rm(root, { recursive: true, force: true });
}
