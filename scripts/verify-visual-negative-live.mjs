import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { createApi } from '../apps/api/server.ts';
process.loadEnvFile();
const id = randomUUID(),
  dir = resolve('.lightmao/verification/visual-negative-' + id);
await mkdir(dir, { recursive: true, mode: 0o700 });
let browser, api;
const receipt = { id, requests: 0, maxRequests: 1, passed: false };
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 480, height: 1040 } });
  await page.setContent('<!doctype html><body style="margin:0;background:white"></body>');
  const actual = await page.screenshot();
  await writeFile(join(dir, 'actual.png'), actual);
  await browser.close();
  browser = undefined;
  const reference = await readFile(
      resolve('.lightmao/verification/perception-reference-20261102/frame-072.jpg'),
    ),
    sha = (b) => createHash('sha256').update(b).digest('hex');
  api = await createApi({
    dataDir: dir,
    demo: true,
    arkKey: process.env.ARK_API_KEY,
    arkBase: process.env.ARK_BASE_URL,
    visionModelId: process.env.ARK_VISION_MODEL_ID,
    modelId: process.env.ARK_MODEL_ID,
  });
  const login = (
    await api.app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} })
  ).json();
  receipt.requests++;
  const response = await api.app.inject({
    method: 'POST',
    url: '/api/perception',
    headers: { authorization: 'Bearer ' + login.token },
    payload: {
      requestId: id,
      projectId: 'visual-evaluator-control',
      purpose: 'score',
      question:
        '比较参考与实际作品的可见视觉表现，严格按量表评价，不从期望补造内容；没有可见依据的玩法或声音列为未知。',
      sourceVersion: sha(actual),
      referenceVersion: sha(reference),
      frames: [
        {
          id: 'reference-frame-0',
          seconds: 72,
          mime: 'image/jpeg',
          data: reference.toString('base64'),
        },
        { id: 'actual-frame-0', seconds: 0, mime: 'image/png', data: actual.toString('base64') },
      ],
    },
  });
  if (response.statusCode !== 202) throw Error('Score request rejected: ' + response.statusCode);
  let job = response.json();
  while (['queued', 'running'].includes(job.status))
    job = await api.perception.wait(login.user.id, job.id, 25);
  receipt.job = job;
  receipt.passed = job.status === 'completed' && job.visualScore <= 25;
} catch (e) {
  receipt.error = e.message;
  process.exitCode = 1;
} finally {
  await browser?.close();
  await api?.app.close();
  await writeFile(join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(
    JSON.stringify({
      receipt: join(dir, 'receipt.json'),
      passed: receipt.passed,
      score: receipt.job?.visualScore,
      error: receipt.error,
    }),
  );
}
