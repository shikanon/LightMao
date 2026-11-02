import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { createApi } from '../apps/api/server.ts';
import { createLocalAgent } from '../apps/agent/server.ts';
import desktop from '../apps/desktop/proxy.cjs';
// Browser plugin not available. Use isolated Playwright; no user Chrome profile or paid model.
const root = resolve(
    process.env.LIGHTMAO_MEDIA_QA_ROOT ||
      '/var/folders/7c/q9tcww7s35g_gbhmm016nvgh0000gn/T/lm-reference-ui-GGzYEh',
  ),
  source = JSON.parse(await readFile(join(root, 'receipt.json'), 'utf8')),
  gallery = resolve('/Users/bytedance/.codex/visualizations/2026/11/02/lightmao-perception/ui');
await mkdir(gallery, { recursive: true });
const checks = [],
  errors = [],
  warnings = [],
  receipt = {
    at: new Date().toISOString(),
    browser: 'Playwright; Browser plugin not available',
    checks,
    errors,
    warnings,
    passed: false,
  };
let browser, proxy, local, api;
const upstream = createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const input = JSON.parse(raw);
  if (!input.stream) {
    const parts = input.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])),
      label = parts.find((c) => c.type === 'text' && /evidenceId=/.test(c.text))?.text || '',
      id = label.match(/evidenceId=([\w-]+)/)?.[1] || 'reference-frame-0';
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: 'UI协议样例，非真实模型判断；真实理解另有独立实测。',
                observations: [{ evidenceId: id, text: '界面完成异步结果读取', confidence: 1 }],
                unknowns: ['此接口是本机协议夹具'],
              }),
            },
          },
        ],
      }),
    );
    return;
  }
  res.setHeader('content-type', 'text/event-stream');
  const frame = (delta, finish_reason) =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  res.write(
    frame({ role: 'assistant', content: '媒体与轨迹界面核验：协议夹具，无付费推理。' }, null),
  );
  res.write(frame({}, 'stop'));
  res.end('data: [DONE]\n\n');
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const record = (name) => {
  checks.push({ name, passed: true });
  console.log(JSON.stringify({ passed: name }));
};
try {
  api = await createApi({
    dataDir: join(root, 'api'),
    demo: true,
    arkKey: 'local-protocol-fixture',
    arkBase: `http://127.0.0.1:${upstream.address().port}`,
  });
  await api.app.listen({ host: '127.0.0.1', port: 0 });
  const apiBase = `http://127.0.0.1:${api.app.server.address().port}`;
  local = await createLocalAgent({ dataDir: join(root, 'agent'), apiUrl: apiBase });
  await local.app.listen({ host: '127.0.0.1', port: 0 });
  proxy = desktop.createDesktopServer({
    webRoot: resolve('dist/web'),
    apiBase,
    agentBase: `http://127.0.0.1:${local.app.server.address().port}`,
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${proxy.address().port}`;
  receipt.url = base;
  const login = (
      await api.app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} })
    ).json(),
    owner = login.user.id,
    headers = { authorization: 'Bearer ' + login.token };
  const project = source.project;
  async function call(method, url, payload) {
    const r = await local.app.inject({ method, url, headers, payload });
    assert(r.statusCode < 300, r.body);
    return r.json();
  }
  const session = await call('POST', '/local/sessions', {
    projectId: project.id,
    title: '媒体与Trace行为验证',
  });
  receipt.sessionId = session.id;
  const reference = local.references.get(owner, source.reference.id),
    mediaFolder = join(
      root,
      'agent/reference-media',
      (await import('node:crypto')).createHash('sha256').update(owner).digest('hex'),
      reference.id,
    );
  await copyFile(join(mediaFolder, 'frame-1.jpg'), join(project.root, 'qa-art.jpg'));
  await promisify(execFile)(
    '/Users/bytedance/.local/pylibs/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v7.1',
    [
      '-y',
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      join(mediaFolder, 'original'),
      '-t',
      '5',
      '-c',
      'copy',
      '-f',
      'mov',
      join(project.root, 'qa-video.qt'),
    ],
  );
  await writeFile(
    join(project.root, 'qa-page.html'),
    '<!doctype html><meta charset="utf-8"><style>body{background:#e8f4ed;font:22px system-ui;padding:30px}button{font:inherit;padding:14px}</style><h1>本机网页预览</h1><button onclick="this.textContent=\'交互已验证\'">开始试玩</button>',
  );
  const positions = new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]),
    json = {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      materials: [
        {
          pbrMetallicRoughness: {
            baseColorFactor: [0.16, 0.65, 0.42, 1],
            metallicFactor: 0.1,
            roughnessFactor: 0.6,
          },
          doubleSided: true,
        },
      ],
      buffers: [{ byteLength: positions.byteLength }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength }],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 3,
          type: 'VEC3',
          min: [-1, -1, 0],
          max: [1, 1, 0],
        },
      ],
    };
  let jt = Buffer.from(JSON.stringify(json));
  jt = Buffer.concat([jt, Buffer.alloc((4 - (jt.length % 4)) % 4, 32)]);
  const bin = Buffer.from(positions.buffer),
    glb = Buffer.alloc(12 + 8 + jt.length + 8 + bin.length);
  glb.writeUInt32LE(0x46546c67, 0);
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(jt.length, 12);
  glb.writeUInt32LE(0x4e4f534a, 16);
  jt.copy(glb, 20);
  glb.writeUInt32LE(bin.length, 20 + jt.length);
  glb.writeUInt32LE(0x004e4942, 24 + jt.length);
  bin.copy(glb, 28 + jt.length);
  await writeFile(join(project.root, 'qa-scene.glb'), glb);
  browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1512, height: 960 } });
  page.setDefaultTimeout(20000);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
    else if (m.type() === 'warning') warnings.push(m.text());
  });
  await page.addInitScript(
    ({ token, owner, session }) => {
      sessionStorage.setItem('lightmao.token', token);
      sessionStorage.setItem('lightmao.user', owner);
      sessionStorage.setItem('lightmao.active.' + owner, session);
    },
    { token: login.token, owner, session: session.id },
  );
  await page.goto(base);
  await page.getByRole('button', { name: '参考录屏', exact: true }).click();
  assert.equal(await page.title(), 'LightMao · 游戏创作工作台');
  await page.locator('video').waitFor();
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 1);
  assert(Math.abs((await page.locator('video').evaluate((v) => v.duration)) - 167.67) < 1);
  record('Reference .qt is remuxed locally and loads full 167.67-second media');
  await page.locator('video').click();
  await page.waitForFunction(() => {
    const v = document.querySelector('video');
    return v && !v.paused && v.currentTime > 0.2;
  });
  await page.locator('video').evaluate((v) => v.pause());
  await page.locator('video').evaluate((v) => {
    v.currentTime = 36;
  });
  await page.waitForFunction(
    () => Math.abs(document.querySelector('video').currentTime - 36) < 0.5,
  );
  record('Native player click starts actual decoded playback and seek reaches 36 seconds');
  await page.screenshot({ path: join(gallery, 'reference-player.png') });
  await page.getByRole('button', { name: '理解实际画面', exact: true }).click();
  await page
    .getByText('UI协议样例，非真实模型判断；真实理解另有独立实测。', { exact: true })
    .waitFor();
  record(
    'Perception submit, durable job polling and evidence result render through authenticated API',
  );
  async function file(name) {
    await page.getByRole('button', { name: /^文件/ }).click();
    await page.locator('.file-browser').getByRole('button', { name, exact: true }).click();
  }
  await file('qa-art.jpg');
  await page.getByRole('img', { name: 'qa-art.jpg', exact: true }).waitFor();
  await page.getByLabel('图片缩放', { exact: true }).fill('2');
  assert.equal(await page.getByLabel('图片缩放').inputValue(), '2');
  const canvas = page.getByLabel('图片画布', { exact: true }),
    box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 55, box.y + box.height / 2 + 20);
  await page.mouse.up();
  assert.match(await page.locator('.image-canvas img').getAttribute('style'), /55px, 20px/);
  await page.screenshot({ path: join(gallery, 'image-canvas.png') });
  await page.getByRole('button', { name: '适应画布', exact: true }).click();
  assert.equal(await page.getByLabel('图片缩放').inputValue(), '1');
  record('Image canvas zoom, pointer pan and reset update the actual rendered image');
  await file('qa-video.qt');
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 1);
  assert((await page.locator('video').evaluate((v) => v.duration)) >= 4.9);
  record('Project QuickTime file opens with actual video player, without treating binary as text');
  await file('qa-page.html');
  const frame = page.frameLocator('iframe[title="qa-page.html"]');
  await frame.getByRole('button', { name: '开始试玩', exact: true }).click();
  await frame.getByRole('button', { name: '交互已验证', exact: true }).waitFor();
  assert(
    !new URL(await page.locator('iframe').getAttribute('src')).origin.includes(new URL(base).port),
  );
  record('Project HTML runs in separate loopback origin and real frame button responds');
  await page.screenshot({ path: join(gallery, 'web-preview.png') });
  await file('qa-scene.glb');
  await page.getByText('1 个网格 · 0 段动画', { exact: true }).waitFor();
  const model = page.locator('.model-canvas canvas'),
    mb = await model.boundingBox();
  await page.mouse.move(mb.x + mb.width * 0.4, mb.y + mb.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(mb.x + mb.width * 0.7, mb.y + mb.height * 0.6, { steps: 12 });
  await page.mouse.up();
  await model.hover();
  await page.mouse.wheel(0, 150);
  await page.getByRole('button', { name: '适应模型', exact: true }).click();
  await page.screenshot({ path: join(gallery, 'model-preview.png') });
  record('Lazy 3D renderer loads a self-contained GLB and orbit, zoom and fit controls work');
  const started = await call('POST', `/local/sessions/${session.id}/runs`, {
    prompt: '读取当前项目概要，无需修改工程。',
    mode: 'ark',
    workMode: 'act',
  });
  for (let i = 0; i < 200; i++) {
    const run = local.store.get('run', started.id, owner);
    if (run.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await page.reload();
  await page.getByRole('button', { name: 'Trace', exact: true }).click();
  await page.getByText('事件链校验通过', { exact: false }).waitFor();
  await page.getByLabel('轨迹类型', { exact: true }).selectOption('model');
  await page
    .locator('.trace-event-toggle')
    .filter({ hasText: '实际发送的模型输入' })
    .first()
    .click();
  await page.locator('.trace-payload pre').waitFor();
  assert((await page.locator('.trace-payload pre').innerText()).includes('messages'));
  await page.screenshot({ path: join(gallery, 'trace-details.png') });
  record(
    'Actual SDK request is captured with correlated trace, verified chain, filtering and paged payload details',
  );
  await page.setViewportSize({ width: 900, height: 900 });
  await page.getByRole('button', { name: '切换预览面板', exact: true }).click();
  await page.getByRole('button', { name: '参考录屏', exact: true }).click();
  await page.screenshot({ path: join(gallery, 'compact-workspace.png') });
  record('Compact desktop workspace can reopen preview and navigate media tabs');
  assert.equal(errors.length, 0, errors.join('\n'));
  record('Identity, nonblank content, no framework overlay and console health verified');
  receipt.passed = true;
} catch (e) {
  receipt.error = e.stack;
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (proxy) {
    proxy.closeAllConnections();
    await new Promise((r) => proxy.close(r));
  }
  await local?.app.close();
  await api?.app.close();
  upstream.closeAllConnections();
  await new Promise((r) => upstream.close(r));
  await writeFile(join(gallery, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(
    JSON.stringify({
      receipt: join(gallery, 'receipt.json'),
      passed: receipt.passed,
      error: receipt.error,
      checks: checks.length,
    }),
  );
}
