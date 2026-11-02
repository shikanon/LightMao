import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApi } from '../apps/api/server.ts';
import { IsolatedExecutor } from '../apps/agent/isolation.ts';
import { prepareGameAsset } from '../apps/agent/game-asset-tools.ts';
import { decodePng } from '../packages/shared/rgba-png.ts';

// Explicit bounded live validation. Resume a saved directory; never submit again to poll.
if (!process.argv.includes('--run'))
  throw Error('Explicit --run required; caps: five images, one 4s video.');
process.loadEnvFile();
if (!process.env.ARK_API_KEY) throw Error('Configure the backend Ark key first.');
const dir = resolve(
  process.env.LIGHTMAO_GAME_ASSET_VERIFY_DIR ||
    '.lightmao/verification/game-assets-' + randomUUID(),
);
await mkdir(dir, { recursive: true, mode: 0o700 });
const root = join(dir, 'project');
await mkdir(root, { recursive: true });
const receiptPath = join(dir, 'receipt.json');
let receipt;
try {
  receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
} catch {
  receipt = {
    id: randomUUID(),
    dir,
    root,
    createdAt: new Date().toISOString(),
    caps: { image: 5, video: 1 },
    jobs: {},
    outputs: {},
    technicalPassed: false,
    visualAccepted: false,
    engineAccepted: false,
  };
}
const save = () => writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
await save();
const api = await createApi({
  dataDir: join(dir, 'backend'),
  demo: true,
  arkKey: process.env.ARK_API_KEY,
  arkBase: process.env.ARK_BASE_URL,
  imageModelId: process.env.ARK_IMAGE_MODEL_ID,
  videoModelId: process.env.ARK_VIDEO_MODEL_ID,
  generationPollMs: 3000,
});
const executor = new IsolatedExecutor(join(dir, 'agent'));
let login;
async function request(method, url, payload) {
  const r = await api.app.inject({
    method,
    url,
    headers: login ? { authorization: 'Bearer ' + login.token } : {},
    ...(payload === undefined ? {} : { payload }),
  });
  if (r.statusCode < 200 || r.statusCode > 299)
    throw Error(`${method} ${url} HTTP ${r.statusCode}`);
  return r.json();
}
const character =
  '同一位国风Q版仙侠少女剑客，蓝黑色双丸子发髻，象牙白与朱红色短袍，金色发饰，红色靴子，手持一柄金色短剑。全身2D游戏精灵，正交固定三分之二侧面视角，干净精致的商业手游美术，无绿色、无蓝绿色服饰或特效，无文字、无水印。';
async function generate(label, kind, prompt, extra = {}) {
  const all = await request('GET', '/api/generations');
  const requestId = receipt.id + ':' + label;
  let job = all.find((j) => j.requestId === requestId);
  if (!job) {
    assert(all.filter((j) => j.kind === kind).length < receipt.caps[kind], 'generation cap');
    job = await request('POST', '/api/generations', {
      requestId,
      kind,
      projectId: receipt.projectId,
      sessionId: receipt.sessionId,
      name: label,
      prompt,
      ...extra,
    });
  }
  const end = Date.now() + 12 * 60000;
  while (!['completed', 'failed', 'unknown'].includes(job.status) && Date.now() < end) {
    receipt.jobs[label] = job;
    await save();
    await delay(3000);
    job = await request('GET', '/api/generations/' + job.id);
  }
  receipt.jobs[label] = job;
  await save();
  if (job.status !== 'completed')
    throw Error(
      label + ': ' + job.status + ' ' + (job.error || 'saved task; resume by same directory'),
    );
  const response = await api.app.inject({
    method: 'GET',
    url: '/api/assets/' + job.asset.id + '/download',
    headers: { authorization: 'Bearer ' + login.token },
  });
  assert.equal(response.statusCode, 200);
  const bytes = response.rawPayload;
  assert.equal(createHash('sha256').update(bytes).digest('hex'), job.asset.sha256);
  const path = label + (kind === 'image' ? '.png' : '.mp4');
  await writeFile(join(root, path), bytes, { mode: 0o600 });
  return { job, path, bytes };
}
async function prepare(label, input) {
  const previous = receipt.outputs[label];
  if (previous) {
    const bytes = await readFile(join(root, previous.manifestPath));
    const m = JSON.parse(bytes.toString());
    assert(
      !previous.manifestSha256 ||
        createHash('sha256').update(bytes).digest('hex') === previous.manifestSha256,
      'saved manifest changed',
    );
    for (const [key, value] of Object.entries(input))
      assert.deepEqual(m.config[key], value, 'saved asset configuration changed');
    assert.equal(
      createHash('sha256')
        .update(await readFile(join(root, input.sourcePath)))
        .digest('hex'),
      m.source.sha256,
      'saved source changed',
    );
    return previous;
  }
  const output = await prepareGameAsset({ root, executor, input: { ...input, outputDir: label } });
  receipt.outputs[label] = output;
  await save();
  return output;
}
try {
  login = await request('POST', '/api/auth/demo', {});
  await request('GET', '/api/bootstrap');
  receipt.projectId ||= randomUUID();
  receipt.sessionId ||= randomUUID();
  await save();
  // Same reference and layout for A/B. Alpha and green variants are independent paid tasks.
  const base = await generate(
    'character-alpha',
    'image',
    character + ' 仅一个人物站立待机，人物居中，脚底在画布85%高度，透明背景，禁止绘制棋盘格。',
    { background: 'transparent', size: '1K' },
  );
  const ref = base.job.asset.id;
  const grid =
    '生成严格4列2行共8格的原地走路动画序列帧，逐行从左到右为动作连续8相位，每格画布相同、人物同尺寸同位置、脚底85%高度。没有边框、分隔线或文字，不能有任何部位越格，相邻格留白充足。';
  const alpha = await generate(
    'walk-alpha',
    'image',
    character + grid + '透明背景，不要绘制棋盘格。',
    { background: 'transparent', referenceAssetId: ref, size: '2K' },
  );
  const green = await generate(
    'walk-green',
    'image',
    character + grid + '所有背景统一纯绿色RGB(0,255,0)，包括格间留白。无阴影、无地面、无环境。',
    { background: 'opaque', referenceAssetId: ref, size: '2K' },
  );
  await prepare('walk-alpha-assets', {
    sourcePath: alpha.path,
    kind: 'sprite_sheet',
    columns: 4,
    rows: 2,
    background: 'alpha',
    pivot: { x: 0.5, y: 0.85 },
    feather: 0.5,
  });
  await prepare('walk-green-assets', {
    sourcePath: green.path,
    kind: 'sprite_sheet',
    columns: 4,
    rows: 2,
    background: 'chroma',
    pivot: { x: 0.5, y: 0.85 },
    feather: 0.5,
  });
  const icon = await generate(
    'icons-alpha',
    'image',
    '国风仙侠手游技能图标合集，严格2列2行共4个正方形图标，依次金色飞剑、朱红火莲、蓝色冰盾、紫色雷球，统一精致Q版绘制风格，每格一个主体，无底板、无边框、无文字、无水印，四周留出15%透明安全边距，真正透明背景不绘制棋盘格。',
    { background: 'transparent', size: '1K' },
  );
  await prepare('icon-assets', {
    sourcePath: icon.path,
    kind: 'icon_sheet',
    columns: 2,
    rows: 2,
    background: 'alpha',
    names: ['sword', 'fire-lotus', 'ice-shield', 'thunder-orb'],
  });
  const pose = await generate(
    'ultimate-green-reference',
    'image',
    character +
      '仅一个人物站立，全身居中脚底85%画布高度，周围保留30%施法空间，所有背景为纯绿色RGB(0,255,0)，无地面无阴影。',
    { background: 'opaque', referenceAssetId: ref, size: '1K' },
  );
  const video = await generate(
    'ultimate-video',
    'video',
    '参考图角色施放金红色飞剑大招，4秒：短暂蓄力、挥剑、金色剑气爆发、动作收回。固定正交镜头不推拉不移动不旋转，角色双脚根部始终固定在原图位置；无整体平移和缩放。特效完整位于画面内，所有背景始终纯绿色RGB(0,255,0)，不要绿色特效、不要环境地面阴影、不要任何文字。',
    { referenceAssetId: pose.job.asset.id, duration: 4, ratio: '1:1' },
  );
  await prepare('ultimate-assets-chroma-v2', {
    sourcePath: video.path,
    kind: 'ultimate_video',
    fps: 12,
    background: 'chroma',
    pivot: { x: 0.5, y: 0.85 },
    feather: 0.5,
    similarity: 0.28,
  });
  receipt.comparison = {
    sameCharacterReference: ref,
    sameGrid: { columns: 4, rows: 2 },
    alpha: receipt.outputs['walk-alpha-assets'],
    chroma: receipt.outputs['walk-green-assets'],
    selection: 'pending visual inspection; pixel QA alone is not aesthetic acceptance',
  };
  receipt.technicalPassed = Object.values(receipt.outputs).every((o) => o.technicalPassed);
  if (receipt.error) {
    receipt.previousErrors ||= [];
    receipt.previousErrors.push({ error: receipt.error, resolvedAt: new Date().toISOString() });
    delete receipt.error;
  }
  await save();
  console.log(
    JSON.stringify({
      dir,
      jobs: Object.fromEntries(
        Object.entries(receipt.jobs).map(([k, j]) => [
          k,
          { id: j.id, status: j.status, model: j.model, upstreamTaskId: j.upstreamTaskId },
        ]),
      ),
      outputs: receipt.outputs,
      technicalPassed: receipt.technicalPassed,
    }),
  );
} catch (error) {
  receipt.error = error.message;
  await save();
  console.error(
    JSON.stringify({
      dir,
      error: error.message,
      jobs: Object.fromEntries(
        Object.entries(receipt.jobs).map(([k, j]) => [k, { id: j.id, status: j.status }]),
      ),
    }),
  );
  process.exitCode = 1;
} finally {
  await executor.close();
  await api.app.close();
}
