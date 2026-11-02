import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, _electron } from 'playwright';
import { createApi } from '../apps/api/server.ts';
import { createLocalAgent } from '../apps/agent/server.ts';
import { Store } from '../packages/shared/store.ts';
import { seedConversation } from '../tests/fixtures/conversation.ts';
import { detectFfmpeg } from '../apps/agent/media-runtime.ts';
import desktop from '../apps/desktop/proxy.cjs';
// Browser plugin not available. Isolated Playwright and real source Electron main/preload.
// Protocol responses are explicit fixtures; no user Chrome, paid model, or existing data is used.
const root = await mkdtemp(join(tmpdir(), 'lm-desktop-input-'));
const gallery = resolve(
  process.env.LIGHTMAO_QA_ARTIFACT_DIR ||
    '/Users/bytedance/.codex/visualizations/2026/11/02/lightmao-desktop-long-horizon/input',
);
const webRoot = resolve(process.env.LIGHTMAO_QA_WEB_ROOT || 'dist/web');
await mkdir(gallery, { recursive: true });
const completed = [],
  errors = [],
  requests = [],
  counts = { chat: 0, vision: 0 };
let api, local, proxy, browser, nativeApp, page, owner, token, hold;
let holdActive = false,
  imageAssetId = '',
  failedUpload = false,
  passed = false;
const upstream = createServer((req, res) => {
  void (async () => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    if (!body.stream) {
      counts.vision++;
      const text = JSON.stringify(body.messages),
        evidenceId = text.match(/actual-attachment-[a-f0-9-]+/)?.[0];
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: 'UI协议夹具已收到实际附件图像，非真实模型质量评估。',
                  observations: [
                    {
                      evidenceId,
                      text: '真实JPEG字节通过鉴权后端进入独立视觉路由',
                      confidence: 1,
                    },
                  ],
                  unknowns: ['此用例不评估模型语义能力'],
                }),
              },
            },
          ],
          usage: { total_tokens: 20 },
        }),
      );
      return;
    }
    counts.chat++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null) =>
      'data: ' +
      JSON.stringify({
        id: 'input-protocol',
        object: 'chat.completion.chunk',
        model: body.model,
        choices: [{ index: 0, delta, finish_reason }],
      }) +
      '\n\n';
    const text = body.messages
      .filter((m) => m.role === 'user')
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');
    const called = (name) =>
      body.messages.some(
        (m) => m.role === 'assistant' && m.tool_calls?.some((t) => t.function?.name === name),
      );
    if (text.includes('INPUT_HOLD')) {
      holdActive = true;
      let n = 0;
      const timer = setInterval(() => {
        if (res.destroyed) {
          clearInterval(timer);
          return;
        }
        res.write(chunk({ content: `持续输出第${++n}条，阅读旧消息时不应自动跳回底部。\n\n` }));
      }, 50);
      hold = () => {
        clearInterval(timer);
        if (!res.destroyed) {
          res.write(chunk({}, 'stop'));
          res.end('data: [DONE]\n\n');
        }
      };
      return;
    }
    let delta;
    if (text.includes('INPUT_VISION') && !called('analyze_attachment'))
      delta = {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'input-attachment',
            type: 'function',
            function: {
              name: 'analyze_attachment',
              arguments: JSON.stringify({ assetId: imageAssetId }),
            },
          },
        ],
      };
    else if (text.includes('INPUT_VISION') && !called('get_perception_result')) {
      const job = api.store.list('perception-job', owner).at(-1);
      delta = {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'input-result',
            type: 'function',
            function: {
              name: 'get_perception_result',
              arguments: JSON.stringify({ jobId: job.id, waitSeconds: 5 }),
            },
          },
        ],
      };
    } else
      delta = {
        role: 'assistant',
        content: 'INPUT_PROTOCOL_COMPLETED：实际附件已通过工具读取；本次是协议验收。',
      };
    res.write(chunk(delta));
    res.write(chunk({}, delta.tool_calls ? 'tool_calls' : 'stop'));
    res.end('data: {"choices":[],"usage":{"total_tokens":40}}\n\ndata: [DONE]\n\n');
  })().catch((e) => {
    errors.push('upstream fixture: ' + e.message);
    res.destroy();
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const record = (name) => {
  completed.push(name);
  console.log(JSON.stringify({ passed: name }));
};
const require = createRequire(import.meta.url);
async function until(check, message, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await delay(50);
  }
  throw Error(message);
}
async function localCall(path, body) {
  const r = await local.app.inject({
    method: body ? 'POST' : 'GET',
    url: path,
    headers: { authorization: 'Bearer ' + token },
    payload: body,
  });
  assert(r.statusCode < 300, r.body);
  return r.json();
}
async function selectSession(title) {
  await page.locator('.session-item').filter({ hasText: title }).first().click();
  await page.getByRole('textbox', { name: '发送消息', exact: true }).waitFor();
  await until(
    async () => !(await page.getByRole('textbox', { name: '发送消息', exact: true }).isDisabled()),
    'Draft restore did not settle',
  );
}
try {
  api = await createApi({
    dataDir: join(root, 'api'),
    demo: true,
    arkKey: 'input-protocol-fixture-key',
    arkBase: `http://127.0.0.1:${upstream.address().port}`,
  });
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
  const projects = (await localCall('/local/bootstrap')).projects,
    project = projects[0];
  const a = await localCall('/local/sessions', { projectId: project.id, title: '输入体验A' }),
    b = await localCall('/local/sessions', { projectId: project.id, title: '输入体验B' });
  await localCall('/local/sessions', { projectId: projects[1].id, title: '另一个项目的输入' });
  const db = new Store(join(root, 'agent/local.sqlite'));
  seedConversation(db, owner, a.id, 32, 160, 'INPUT_HISTORY');
  db.close();
  proxy = desktop.createDesktopServer({
    webRoot,
    apiBase: api.app.listeningOrigin,
    agentBase: local.app.listeningOrigin,
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${proxy.address().port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1512, height: 960 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (req) => {
    if (
      /\/local\/sessions\/[^/]+\/runs$/.test(new URL(req.url()).pathname) &&
      req.method() === 'POST'
    )
      requests.push(req.postDataJSON());
  });
  await page.addInitScript(
    ({ token, owner, session }) => {
      if (window.top !== window || location.protocol !== 'http:') return;
      sessionStorage.setItem('lightmao.token', token);
      sessionStorage.setItem('lightmao.user', owner);
      if (!sessionStorage.getItem('lightmao.active.' + owner))
        sessionStorage.setItem('lightmao.active.' + owner, session);
    },
    { token, owner, session: a.id },
  );
  await page.goto(base);
  await page.getByRole('textbox', { name: '发送消息', exact: true }).waitFor();
  await until(
    async () => !(await page.getByRole('textbox', { name: '发送消息', exact: true }).isDisabled()),
    'Composer did not become usable',
  );
  assert.equal(await page.title(), 'LightMao · 游戏创作工作台');
  assert(await page.getByRole('navigation', { name: '主导航' }).isVisible());
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  record('Intended page renders a nonblank workspace without a framework overlay');
  const editor = page.getByRole('textbox', { name: '发送消息', exact: true });
  await editor.fill('A的草稿，保留光标');
  await editor.evaluate((e) => {
    e.setSelectionRange(2, 4);
    e.dispatchEvent(new Event('select', { bubbles: true }));
  });
  await selectSession('输入体验B');
  await editor.fill('B的独立草稿');
  await selectSession('另一个项目的输入');
  await editor.fill('另一个项目的草稿');
  await selectSession('输入体验A');
  assert.equal(await editor.inputValue(), 'A的草稿，保留光标');
  assert.deepEqual(
    await editor.evaluate((e) => [e.selectionStart, e.selectionEnd, document.activeElement === e]),
    [2, 4, true],
  );
  record('Changing sessions and projects restores isolated draft text, focus and caret state');
  const beforeIme = requests.length;
  await editor.evaluate((e) => {
    e.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '中' }));
    e.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    e.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' }));
  });
  await delay(150);
  assert.equal(requests.length, beforeIme);
  record('IME composition Enter never sends a message');
  await page.getByRole('button', { name: '切换预览面板', exact: true }).focus();
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(mod + '+Shift+L');
  assert(await editor.evaluate((e) => document.activeElement === e));
  const prevented = await editor.evaluate(
    (e) =>
      !e.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'l',
          code: 'KeyL',
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
  );
  assert.equal(prevented, false);
  record('Web focus shortcut works while the ordinary browser address-bar shortcut is preserved');
  const sessionsBeforeShortcut = local.store.list('session', owner).length;
  const createdByShortcut = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/local/sessions' && r.request().method() === 'POST',
  );
  await page.keyboard.press(mod + '+Alt+N');
  const shortcutSession = await (await createdByShortcut).json();
  await until(
    async () =>
      page.evaluate(({ owner, id }) => sessionStorage.getItem('lightmao.active.' + owner) === id, {
        owner,
        id: shortcutSession.id,
      }),
    'Shortcut did not open its new session',
  );
  await delay(150);
  assert.equal(local.store.list('session', owner).length, sessionsBeforeShortcut + 1);
  await selectSession('输入体验A');
  record('The web new-session shortcut creates exactly one session and keeps the original draft');
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(
      new File(['# Drag proof\nDOC_BYTE_MARKER\n'], 'drag-proof.md', { type: 'text/markdown' }),
    );
    document
      .querySelector('.workbench')
      .dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await page
    .getByRole('listitem')
    .filter({ hasText: 'drag-proof.md' })
    .getByText('已添加', { exact: true })
    .waitFor();
  assert(api.store.list('asset', owner).some((v) => v.name === 'drag-proof.md'));
  await page.getByRole('button', { name: '移除附件 drag-proof.md', exact: true }).click();
  assert.equal(await page.getByRole('listitem').filter({ hasText: 'drag-proof.md' }).count(), 0);
  record(
    'HTML5 file drop uploads actual document bytes and removing a reference preserves the stored source',
  );
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 96;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#347fa2';
    ctx.fillRect(0, 0, 160, 96);
    ctx.fillStyle = 'white';
    ctx.font = '20px sans-serif';
    ctx.fillText('CLIP_742', 12, 50);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  });
  await editor.focus();
  await page.keyboard.press(mod + '+V');
  const clip = page.getByRole('listitem').filter({ hasText: '截图-' });
  await clip.getByText('已添加', { exact: true }).waitFor();
  imageAssetId = api.store.list('asset', owner).findLast((v) => v.name.startsWith('截图-')).id;
  await editor.fill('INPUT_VISION 请查看粘贴的截图。');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const run = await until(
    async () => {
      const run = local.store.list('run', owner).findLast((v) => v.prompt.includes('INPUT_VISION'));
      return run?.status !== 'running' ? run : undefined;
    },
    'Attachment Agent run did not settle',
    30000,
  );
  assert.equal(run.status, 'completed', run.error);
  assert.equal(counts.vision, 1);
  assert(requests.at(-1).assetIds.includes(imageAssetId));
  record(
    'Clipboard screenshot becomes a real message asset and reaches the independent vision tool through the actual Pi loop',
  );
  await page.route('**/api/assets', async (route) => {
    if (!failedUpload) {
      failedUpload = true;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: '{"error":"temporary fixture failure before upload"}',
      });
    } else await route.continue();
  });
  await page.getByRole('button', { name: '添加技能或资料', exact: true }).click();
  await page.getByRole('button', { name: '上传图片、文件或参考录屏', exact: true }).click();
  await page.getByLabel('添加对话附件', { exact: true }).setInputFiles({
    name: 'retry-proof.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('retry original bytes'),
  });
  const retryRow = page.getByRole('listitem').filter({ hasText: 'retry-proof.txt' });
  await retryRow.getByRole('button', { name: '重试附件 retry-proof.txt' }).waitFor();
  await editor.fill('不要在附件未就绪时发送');
  assert(await page.getByRole('button', { name: '发送消息', exact: true }).isDisabled());
  await retryRow.getByRole('button', { name: '重试附件 retry-proof.txt' }).click();
  await retryRow.getByText('已添加', { exact: true }).waitFor();
  assert.equal(
    api.store.list('asset', owner).filter((v) => v.name === 'retry-proof.txt').length,
    1,
  );
  await page.unroute('**/api/assets');
  await page.getByRole('button', { name: '移除附件 retry-proof.txt', exact: true }).click();
  record(
    'An unfinished attachment blocks send; explicit retry reconciles the intent and yields exactly one stored asset',
  );
  let uploadCaptured = false,
    releaseUpload;
  const uploadGate = new Promise((r) => (releaseUpload = r));
  await page.route('**/api/assets', async (route) => {
    uploadCaptured = true;
    await uploadGate;
    await route.abort('aborted').catch(() => {});
  });
  await page
    .getByLabel('添加对话附件', { exact: true })
    .setInputFiles({
      name: 'cancel-proof.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('cancel pending upload'),
    });
  await until(() => uploadCaptured, 'Upload did not start');
  assert(
    await page
      .getByRole('listitem')
      .filter({ hasText: 'cancel-proof.txt' })
      .getByText('上传中', { exact: true })
      .isVisible(),
  );
  await page.getByRole('button', { name: '移除附件 cancel-proof.txt', exact: true }).click();
  releaseUpload();
  await delay(150);
  assert.equal(await page.getByRole('listitem').filter({ hasText: 'cancel-proof.txt' }).count(), 0);
  assert(!api.store.list('asset', owner).some((v) => v.name === 'cancel-proof.txt'));
  await page.unroute('**/api/assets');
  record(
    'Removing an in-flight attachment cancels waiting and a late error never brings the row back',
  );
  const decoder = await detectFfmpeg();
  assert(decoder, 'Reference video QA requires the installed decoder');
  const videoPath = join(root, 'input-reference.mp4');
  await promisify(execFile)(
    decoder.path,
    [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=160x96:r=8:d=1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      videoPath,
    ],
    { timeout: 10000 },
  );
  const videoBytes = await readFile(videoPath);
  await page.evaluate(
    (bytes) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(bytes)], 'input-reference.mp4', { type: 'video/mp4' }));
      document
        .querySelector('.workbench')
        .dispatchEvent(
          new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }),
        );
    },
    [...videoBytes],
  );
  const videoRow = page.getByRole('listitem').filter({ hasText: 'input-reference.mp4' });
  await videoRow.getByText('已添加', { exact: true }).waitFor({ timeout: 30000 });
  const reference = local.store
    .list('reference-media', owner)
    .find((v) => v.name === 'input-reference.mp4');
  assert(reference?.frames.length > 0);
  assert.equal(reference.bytes, videoBytes.length);
  await editor.fill('INPUT_REFERENCE 以当前明确引用的参考视频为准。');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await until(
    () =>
      local.store
        .list('run', owner)
        .find((v) => v.prompt.startsWith('INPUT_REFERENCE') && v.status === 'completed'),
    'Explicit video reference run did not complete',
  );
  assert.deepEqual(requests.at(-1).referenceIds, [reference.id]);
  assert.deepEqual(
    local.store.get('session', a.id, owner).messages.findLast((v) => v.role === 'user')
      .referenceIds,
    [reference.id],
  );
  record(
    'Dropping a real video decodes frames and binds its exact reference ID to the sent and replayable user message',
  );
  let releaseResponse;
  const responseGate = new Promise((r) => (releaseResponse = r));
  let responseReady = false;
  await page.route('**/local/sessions/' + a.id + '/runs', async (route) => {
    const response = await route.fetch();
    responseReady = true;
    await responseGate;
    await route.fulfill({ response });
  });
  await until(
    async () => !(await page.getByRole('button', { name: '停止运行', exact: true }).count()),
    'Previous run still busy',
  );
  await editor.fill('INPUT_DRAFT_RACE 原会话发送');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await until(() => responseReady, 'Send response not held');
  await editor.fill('发送期间新增的草稿');
  await selectSession('输入体验B');
  await editor.fill('B的新草稿，不能被A清空');
  releaseResponse();
  await delay(350);
  assert.equal(await editor.inputValue(), 'B的新草稿，不能被A清空');
  await page.unroute('**/local/sessions/' + a.id + '/runs');
  await selectSession('输入体验A');
  assert.equal(await editor.inputValue(), '发送期间新增的草稿');
  record(
    'A delayed send response preserves newer edits and never clears the draft of another session',
  );
  await editor.fill('INPUT_HOLD 检查阅读旧消息时的滚动');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await until(() => holdActive, 'Stream did not begin');
  await page.getByRole('button', { name: '添加技能或资料', exact: true }).click();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(), 0);
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['cancel'], 'cancel.txt', { type: 'text/plain' }));
    document
      .querySelector('.workbench')
      .dispatchEvent(
        new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }),
      );
  });
  await page.getByText('松开以添加到当前消息', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByText('松开以添加到当前消息', { exact: true }).count(), 0);
  assert(
    local.store.list('run', owner).find((v) => v.prompt.startsWith('INPUT_HOLD')).status ===
      'running',
  );
  record('Escape closes the context picker and exits drag mode without cancelling a running Agent');
  const toggle = page.locator('.execution-trace').last().locator('.execution-toggle');
  if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
  await delay(200);
  await page.locator('.messages').evaluate((e) => (e.scrollTop = e.scrollHeight));
  await page.locator('.messages').hover();
  await page.mouse.wheel(0, -720);
  await delay(200);
  const top = await page.locator('.messages').evaluate((e) => e.scrollTop);
  await delay(500);
  assert(Math.abs((await page.locator('.messages').evaluate((e) => e.scrollTop)) - top) < 5);
  assert(
    await page
      .locator('.messages')
      .evaluate((e) => e.scrollHeight - e.clientHeight - e.scrollTop > 100),
  );
  await selectSession('输入体验B');
  await selectSession('输入体验A');
  await delay(300);
  assert(Math.abs((await page.locator('.messages').evaluate((e) => e.scrollTop)) - top) < 5);
  record('Returning to a running session restores its reading position');
  hold();
  record(
    'Real wheel scrolling to earlier messages during expanded streaming output is not pulled back to the bottom',
  );
  await until(
    async () => !(await page.getByRole('button', { name: '停止运行', exact: true }).count()),
    'Held stream did not complete',
  );
  await editor.fill('跨reload保留的草稿');
  await delay(450);
  await page.reload();
  await until(
    async () => (await editor.inputValue()) === '跨reload保留的草稿',
    'Reload lost durable draft',
  );
  await page.screenshot({ path: join(gallery, 'input-desktop.png') });
  await page.setViewportSize({ width: 900, height: 900 });
  await page.screenshot({ path: join(gallery, 'input-narrow.png') });
  record('Durable draft survives reload and the 900px workspace stays usable');
  if (process.argv.includes('--native')) {
    // Optional full source main/preload check. Root performs native release validation separately.
    const stage = join(root, 'native-stage'),
      profile = join(root, 'native-profile');
    await mkdir(join(stage, 'apps'), { recursive: true });
    await mkdir(join(stage, 'dist'), { recursive: true });
    await cp(resolve('apps/desktop'), join(stage, 'apps/desktop'), { recursive: true });
    await cp(webRoot, join(stage, 'dist/web'), { recursive: true });
    const env = {
      ...process.env,
      LIGHTMAO_API_URL: api.app.listeningOrigin,
      API_PORT: String(api.app.server.address().port),
      AGENT_PORT: String(local.app.server.address().port),
      LIGHTMAO_USER_DATA_DIR: profile,
      LIGHTMAO_DATA_DIR: join(root, 'agent'),
      LIGHTMAO_DEMO: 'false',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    for (const name of Object.keys(env))
      if (/^(ARK_|OSS_|DOUBAO_|LIGHTMAO_ADMIN_)/.test(name)) delete env[name];
    async function launchNative() {
      nativeApp = await _electron.launch({
        executablePath: require('electron'),
        args: [join(stage, 'apps/desktop/main.cjs')],
        env,
      });
      page = await nativeApp.firstWindow();
      page.on('pageerror', (e) => errors.push(e.message));
      return page;
    }
    await launchNative();
    await page.getByRole('navigation', { name: '主导航' }).waitFor();
    const nativeEditor = () => page.getByRole('textbox', { name: '发送消息', exact: true });
    await until(async () => !(await nativeEditor().isDisabled()), 'Native draft not ready');
    await page.getByRole('button', { name: '切换预览面板', exact: true }).focus();
    await page.keyboard.press(mod + '+L');
    await until(
      async () => nativeEditor().evaluate((e) => document.activeElement === e),
      'Native focus shortcut did not work',
    );
    const created = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/local/sessions' && r.request().method() === 'POST',
    );
    await page.keyboard.press(mod + '+Shift+N');
    const nativeSession = await (await created).json();
    await until(
      async () => !(await nativeEditor().isDisabled()),
      'Native new session did not settle',
    );
    await until(
      async () =>
        page.evaluate(
          ({ owner, session }) => sessionStorage.getItem('lightmao.active.' + owner) === session,
          { owner, session: nativeSession.id },
        ),
      'Native did not select the newly created session',
    );
    await nativeEditor().fill('原生重启后的持久草稿');
    await until(
      () =>
        local.store
          .list('desktop-ui-state', owner)
          .some((v) => v.value?.text === '原生重启后的持久草稿'),
      'Native draft not committed',
    );
    await delay(350);
    const oldOrigin = new URL(page.url()).origin;
    await nativeApp.close();
    nativeApp = undefined;
    await launchNative();
    await nativeEditor().waitFor();
    await until(
      async () => (await nativeEditor().inputValue()) === '原生重启后的持久草稿',
      'Native relaunch lost draft',
      20000,
    );
    assert.notEqual(new URL(page.url()).origin, oldOrigin);
    await page.screenshot({ path: join(gallery, 'input-native-restored.png') });
    record(
      'Actual source Electron main/preload handles both native shortcuts and restores the draft after a real random-origin relaunch',
    );
  }
  assert.equal(errors.length, 0, errors.join('\n'));
  passed = true;
} catch (error) {
  errors.push(error.stack || error.message);
  if (page && !page.isClosed())
    await page.screenshot({ path: join(gallery, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  hold?.();
  await nativeApp?.close().catch(() => {});
  await browser?.close();
  if (proxy) await new Promise((r) => proxy.close(() => r()));
  await local?.app.close();
  await api?.app.close();
  upstream.closeAllConnections();
  await new Promise((r) => upstream.close(() => r()));
  await writeFile(
    join(gallery, 'receipt.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        passed,
        completed,
        errors,
        requests: requests.map((r) => ({
          mode: r.workMode,
          assets: r.assetIds,
          references: r.referenceIds,
        })),
        modelCalls: counts,
        webRoot,
        browser: 'Browser plugin not available; isolated Playwright + real Electron',
        scope:
          'Desktop interaction and protocol routing; not a game-quality or real-model semantic benchmark.',
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed, completed: completed.length, errors, gallery }));
}
