import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID, randomInt, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { createApi } from '../apps/api/server.ts';
const exec = promisify(execFile);
function wavSeconds(bytes) {
  let byteRate = 0,
    dataBytes = 0;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const kind = bytes.toString('ascii', offset, offset + 4),
      size = bytes.readUInt32LE(offset + 4),
      start = offset + 8;
    if (kind === 'fmt ' && size >= 16) byteRate = bytes.readUInt32LE(start + 8);
    if (kind === 'data') dataBytes = Math.min(size, bytes.length - start);
    offset = start + size + (size % 2);
  }
  if (!byteRate || !dataBytes) throw Error('WAV duration unavailable');
  return dataBytes / byteRate;
}
process.loadEnvFile();
if (!process.env.ARK_API_KEY) throw Error('Backend Ark configuration required');
const id = randomUUID(),
  root = resolve('.lightmao/verification/perception-live-' + id),
  inputs = resolve('.lightmao/verification/perception-reference-20261102');
await mkdir(root, { recursive: true, mode: 0o700 });
const api = await createApi({
  dataDir: root,
  demo: true,
  arkKey: process.env.ARK_API_KEY,
  arkBase: process.env.ARK_BASE_URL,
  modelId: process.env.ARK_MODEL_ID,
  visionModelId: process.env.ARK_VISION_MODEL_ID,
  audioModelId: process.env.ARK_AUDIO_MODEL_ID,
});
await api.app.listen({ host: '127.0.0.1', port: 0 });
const login = (await api.app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} })).json(),
  headers = { authorization: 'Bearer ' + login.token };
const receipt = {
  id,
  at: new Date().toISOString(),
  root,
  maxPaidRequests: 6,
  requests: 0,
  results: [],
  checks: [],
  passed: false,
};
const save = () =>
  writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
const sha = (b) => createHash('sha256').update(b).digest('hex');
async function submit(label, purpose, payload) {
  if (receipt.requests >= receipt.maxPaidRequests)
    throw Error('Perception verification request cap reached');
  receipt.requests++;
  const response = await api.app.inject({
    method: 'POST',
    url: '/api/perception',
    headers,
    payload: {
      requestId: id + ':' + label,
      projectId: 'reference-game-verification',
      purpose,
      question: payload.question,
      frames: payload.frames || [],
      audios: payload.audios || [],
    },
  });
  assert.equal(response.statusCode, 202, 'Perception request not accepted: ' + response.statusCode);
  let job = response.json();
  while (['queued', 'running'].includes(job.status))
    job = await api.perception.wait(login.user.id, job.id, 25);
  receipt.results.push({ label, job });
  await save();
  return job;
}
try {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  const code = String(randomInt(10000, 99999));
  await page.setContent(
    `<body style="margin:0;background:#172538;font:32px system-ui;color:white"><div style="padding:30px"><div style="width:0;height:0;border-left:35px solid transparent;border-right:35px solid transparent;border-bottom:60px solid #ba75ff"></div><p>校验编号 ${code}</p><button style="background:#f3bb64;padding:12px 35px;border:0;border-radius:12px;font-size:28px">开始闯关</button></div></body>`,
  );
  const png = await page.screenshot();
  await writeFile(join(root, 'visual-control.png'), png);
  await browser.close();
  const control = await submit('blind-image-control', 'vision', {
    question: '读取校验编号和按钮文字，描述左上图形的颜色及形状。只依据图像。',
    frames: [{ id: 'image-control', seconds: 0, mime: 'image/png', data: png.toString('base64') }],
  });
  const controlText = JSON.stringify(control.result || {});
  receipt.checks.push({
    name: 'blind image code',
    passed: control.status === 'completed' && controlText.includes(code),
    expected: code,
    sourceSha256: sha(png),
  });
  await save();
  const referenceFrames = [];
  for (const t of [0, 36, 72, 108, 144]) {
    const bytes = await readFile(join(inputs, 'frame-' + String(t).padStart(3, '0') + '.jpg'));
    referenceFrames.push({
      id: 'reference-' + t,
      seconds: t,
      mime: 'image/jpeg',
      data: bytes.toString('base64'),
    });
  }
  const vision = await submit('reference-visual', 'vision', {
    question:
      '按时间描述这段录屏的布局、人物、战斗表现、可见交互及阶段变化。区分实际可见事实和推断；不能根据题材补造玩法规则。',
    frames: referenceFrames,
  });
  receipt.checks.push({
    name: 'reference image semantics',
    passed: vision.status === 'completed' && vision.result.observations.length >= 3,
  });
  await save();
  const audio = await readFile(join(inputs, 'audio-first-30s.wav'));
  const sound = await submit('reference-audio-only', 'audio', {
    question:
      '只听音频，描述音乐、音效和是否有人声，若有清晰语音请转写；按时间标记主要声音。不要根据任何游戏题材猜测画面或声音。',
    audios: [
      {
        id: 'audio-reference',
        offsetSeconds: 0,
        durationSeconds: 30,
        format: 'wav',
        data: audio.toString('base64'),
      },
    ],
  });
  receipt.checks.push({
    name: 'real audio-only accepted and described',
    passed: sound.status === 'completed' && sound.result.observations.length > 0,
    sourceSha256: sha(audio),
  });
  await save();
  const phrase = '校验口令是青竹七四二。现在开始第二波敌人，护盾已经准备好了。';
  try {
    await exec(
      '/usr/bin/say',
      ['-v', 'Tingting', '-o', join(root, 'speech-control.aiff'), phrase],
      { timeout: 20000 },
    );
    await exec(
      '/Users/bytedance/.local/pylibs/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v7.1',
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        join(root, 'speech-control.aiff'),
        '-ac',
        '1',
        '-ar',
        '16000',
        '-y',
        join(root, 'speech-control.wav'),
      ],
      { timeout: 15000 },
    );
    const wav = await readFile(join(root, 'speech-control.wav'));
    const speech = await submit('blind-speech-control', 'audio', {
      question: '请逐字转写听到的清晰语音，不补写没听到的内容。',
      audios: [
        {
          id: 'audio-control',
          offsetSeconds: 0,
          durationSeconds: wavSeconds(wav),
          format: 'wav',
          data: wav.toString('base64'),
        },
      ],
    });
    const text = JSON.stringify(speech.result || {});
    receipt.checks.push({
      name: 'blind spoken content',
      passed: speech.status === 'completed' && /青竹/.test(text) && /第二波/.test(text),
      expected: phrase,
      sourceSha256: sha(wav),
    });
  } catch (error) {
    receipt.checks.push({ name: 'blind spoken content', passed: false, error: error.message });
  }
  const silence = Buffer.alloc(44 + 16000 * 2 * 3);
  silence.write('RIFF');
  silence.writeUInt32LE(silence.length - 8, 4);
  silence.write('WAVEfmt ', 8);
  silence.writeUInt32LE(16, 16);
  silence.writeUInt16LE(1, 20);
  silence.writeUInt16LE(1, 22);
  silence.writeUInt32LE(16000, 24);
  silence.writeUInt32LE(32000, 28);
  silence.writeUInt16LE(2, 32);
  silence.writeUInt16LE(16, 34);
  silence.write('data', 36);
  silence.writeUInt32LE(silence.length - 44, 40);
  const quiet = await submit('silent-negative-control', 'audio', {
    question: '判断是否存在可听声音、音乐或语音；不要补造内容。',
    audios: [
      {
        id: 'audio-silence',
        offsetSeconds: 0,
        durationSeconds: 3,
        format: 'wav',
        data: silence.toString('base64'),
      },
    ],
  });
  receipt.checks.push({
    name: 'silence negative control',
    passed:
      quiet.status === 'completed' &&
      /静音|无声|没有|未听|未检测|未包含|不包含|安静|静默|静寂/.test(
        JSON.stringify(quiet.result),
      ) &&
      !(quiet.result.transcript || '').replace(/[\s无暂无未听到语音]/g, '').length,
  });
  receipt.passed = receipt.checks.every((c) => c.passed);
  await save();
  console.log(
    JSON.stringify({
      receipt: join(root, 'receipt.json'),
      passed: receipt.passed,
      checks: receipt.checks.map((c) => ({ name: c.name, passed: c.passed })),
      requests: receipt.requests,
    }),
  );
} finally {
  await api.app.close();
  await save();
}
