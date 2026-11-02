import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApi } from '../apps/api/server.ts';
import { createLocalAgent } from '../apps/agent/server.ts';
process.loadEnvFile();
const dir = resolve(
    process.env.LIGHTMAO_GENERATED_CASE ||
      '.lightmao/verification/reference-game-e38dc0ec-1ccd-4363-96d1-96fa8c92833f',
  ),
  original = JSON.parse(await readFile(join(dir, 'receipt.json'), 'utf8')),
  id = randomUUID(),
  out = join(dir, 'component-playtest-' + id),
  gallery = resolve(
    '/Users/bytedance/.codex/visualizations/2026/11/02/lightmao-perception/generated-playtest-' +
      id,
  );
await mkdir(out, { recursive: true });
await mkdir(gallery, { recursive: true });
const receipt = {
  id,
  trigger:
    'Developer component verification of unchanged Agent-produced source; not an autonomous Goal completion.',
  maxDecisionRequests: 5,
  maxVisualRequests: 1,
  sourceCase: dir,
  passed: false,
};
let api, local;
try {
  api = await createApi({
    dataDir: join(dir, 'api'),
    demo: true,
    arkKey: process.env.ARK_API_KEY,
    arkBase: process.env.ARK_BASE_URL,
    modelId: process.env.ARK_MODEL_ID,
    decisionModelId: process.env.ARK_SYSTEM_ONE_MODEL_ID,
    visionModelId: process.env.ARK_VISION_MODEL_ID,
  });
  await api.app.listen({ host: '127.0.0.1', port: 0 });
  local = await createLocalAgent({
    dataDir: join(dir, 'agent'),
    apiUrl: `http://127.0.0.1:${api.app.server.address().port}`,
    tickMs: 60000,
  });
  const login = (
      await api.app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} })
    ).json(),
    owner = login.user.id;
  const before = new Set(api.store.list('usage').map((u) => u.id)),
    authorize = async () => {
      const response = await api.app.inject({
        method: 'GET',
        url: '/api/bootstrap',
        headers: { authorization: 'Bearer ' + login.token },
      });
      if (!response.json().plugins.some((p) => p.id === 'playtest' && p.enabled && p.installed))
        throw Error('Playtest permission unavailable');
    };
  const initial = await local.playtests.start(
      owner,
      original.project.id,
      original.sessionId,
      {
        requestId: id,
        goal: '连续选择两个战前技能，检查预选轮次能否进入第2轮；两次选择后若仍在第1轮请报告阻塞，不要无限重复。仅检查当前真实画面和状态，不伪造分数。',
        maxSteps: 5,
        viewport: { width: 480, height: 1040 },
        assertions: [{ field: 'pre_round', op: 'gte', value: 2 }],
      },
      login.token,
      authorize,
    ),
    job = await local.playtests.wait(owner, initial.id);
  receipt.playtest = job;
  if (job.screenshotSha256)
    await writeFile(
      join(gallery, 'actual-final.png'),
      await local.playtests.screenshot(owner, job.id),
    );
  for (const c of job.captures || [])
    await writeFile(
      join(gallery, c.id + '.jpg'),
      (await local.playtests.capture(owner, job.id, c.id)).bytes,
    );
  let score = await local.references.evaluate(
    owner,
    original.project.id,
    original.reference.id,
    job.id,
    login.token,
    original.sessionId,
    job.id,
    local.playtests,
  );
  while (['queued', 'running'].includes(score.status))
    score = await api.perception.wait(owner, score.id, 25);
  if (score.status === 'failed')
    try {
      score = api.perception.revalidate(owner, score.id);
    } catch {}
  receipt.visualAssessment = score;
  receipt.usages = api.store.list('usage').filter((u) => !before.has(u.id));
  receipt.passed = job.status === 'passed' && score.status === 'completed';
  receipt.traceIntegrity = local.traces.page(owner, job.id).integrity;
} catch (e) {
  receipt.error = e.message;
} finally {
  await local?.app.close();
  await api?.app.close();
  await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
  console.log(
    JSON.stringify({
      receipt: join(out, 'receipt.json'),
      gallery,
      passed: receipt.passed,
      playtest: receipt.playtest?.status,
      error: receipt.error || receipt.playtest?.error,
      visualScore: receipt.visualAssessment?.visualScore,
    }),
  );
}
