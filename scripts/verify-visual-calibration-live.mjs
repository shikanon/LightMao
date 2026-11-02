import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { createApi } from '../apps/api/server.ts';
// Browser plugin is unavailable. Real isolated screenshots and exactly two backend vision intents.
process.loadEnvFile();
if (!process.env.ARK_API_KEY) throw Error('Server Ark credentials are not configured');
const id = randomUUID(),
  dir = resolve('.lightmao/verification/visual-calibration-' + id);
await mkdir(dir, { recursive: true, mode: 0o700 });
const env = { ...process.env };
for (const key of Object.keys(env))
  if (/^(ARK_|OSS_|DOUBAO_|LIGHTMAO_ADMIN_|LIGHTMAO_ENV_FILE)/.test(key)) delete env[key];
const hash = (b) => createHash('sha256').update(b).digest('hex');
const receipt = {
  id,
  startedAt: new Date().toISOString(),
  provider: 'real Ark through backend',
  requestCap: 2,
  requests: 0,
  results: [],
  passed: false,
};
let browser, api;
try {
  const source = resolve(
    process.env.LIGHTMAO_CALIBRATION_REFERENCE ||
      '.lightmao/verification/perception-reference-20261102/frame-000.jpg',
  );
  const reference = await readFile(source);
  browser = await chromium.launch({ headless: true, env });
  const page = await browser.newPage({ viewport: { width: 480, height: 1040 } });
  await page.setContent(
    '<html><body style="margin:0;background:#000;width:100vw;height:100vh"></body></html>',
  );
  const blank = await page.screenshot({ path: join(dir, 'blank-control.png') });
  await browser.close();
  browser = undefined;
  api = await createApi({
    dataDir: join(dir, 'api'),
    demo: true,
    arkKey: process.env.ARK_API_KEY,
    arkBase: process.env.ARK_BASE_URL,
    visionModelId: process.env.ARK_VISION_MODEL_ID,
  });
  const login = (
    await api.app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} })
  ).json();
  receipt.referenceSha256 = hash(reference);
  for (const [label, bytes, mime] of [
    ['identical', reference, 'image/jpeg'],
    ['blank', blank, 'image/png'],
  ]) {
    const n = receipt.requests++;
    const started = await api.perception.submit(login.user.id, {
      requestId: `calibration:${id}:${n}`,
      projectId: 'calibration',
      purpose: 'score',
      question:
        '按四维量表比较实际图像与参考。只依据输入内容；单帧不能证明玩法或音频。各项分数要对应理由和量表区间。',
      sourceVersion: hash(bytes),
      referenceVersion: hash(reference),
      frames: [
        {
          id: 'reference-evidence',
          seconds: 0,
          mime: 'image/jpeg',
          data: reference.toString('base64'),
        },
        { id: 'actual-evidence', seconds: 0, mime, data: bytes.toString('base64') },
      ],
      audios: [],
    });
    let job = started;
    while (['queued', 'running'].includes(job.status))
      job = await api.perception.wait(login.user.id, job.id, 25);
    const criterion = job.result?.scores?.find((s) => s.criterion === 'reference')?.score;
    const passed =
      job.status === 'completed' &&
      typeof criterion === 'number' &&
      (label === 'identical' ? criterion >= 85 : criterion <= 10);
    receipt.results.push({ label, passed, job });
    await writeFile(join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
  }
  receipt.passed = receipt.requests === 2 && receipt.results.every((r) => r.passed);
} catch (e) {
  receipt.error = e.message;
  process.exitCode = 1;
} finally {
  await browser?.close();
  await api?.app.close();
  receipt.endedAt = new Date().toISOString();
  await writeFile(join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
  console.log(
    JSON.stringify({
      receipt: join(dir, 'receipt.json'),
      passed: receipt.passed,
      requests: receipt.requests,
      results: receipt.results.map((r) => ({
        label: r.label,
        passed: r.passed,
        status: r.job.status,
        referenceScore: r.job.result?.scores?.find((s) => s.criterion === 'reference')?.score,
      })),
    }),
  );
}
