import { createServer } from 'node:http';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApi } from '../apps/api/server.ts';
import { createLocalAgent } from '../apps/agent/server.ts';
// Real provider through the authenticated backend. No source files are prefilled or repaired by this verifier.
process.loadEnvFile();
if (!process.env.ARK_API_KEY) throw Error('Configure server Ark credentials');
const resume = process.env.LIGHTMAO_REFERENCE_RESUME,
  scoreOnly = process.env.LIGHTMAO_REFERENCE_SCORE_ONLY === '1',
  previous = resume
    ? JSON.parse(await readFile(join(resolve(resume), 'receipt.json'), 'utf8'))
    : undefined;
if (scoreOnly && !previous) throw Error('Score-only review requires an existing reference case');
const id = previous?.id || randomUUID(),
  dir = resume ? resolve(resume) : resolve('.lightmao/verification/reference-game-' + id),
  gallery =
    previous?.gallery ||
    resolve('/Users/bytedance/.codex/visualizations/2026/11/02/lightmao-perception/game-' + id);
await mkdir(dir, { recursive: true, mode: 0o700 });
await mkdir(gallery, { recursive: true });
const receipt = previous || {
  id,
  dir,
  gallery,
  startedAt: new Date().toISOString(),
  caps: { chat: 60, decision: 64, vision: 10, audio: 1, image: 1 },
  counts: { chat: 0, decision: 0, vision: 0, audio: 0, image: 0 },
  results: [],
  passed: false,
};
if (previous) {
  const extra = Number(process.env.LIGHTMAO_REFERENCE_EXTRA_CHAT || 0);
  const extraDecision = Number(process.env.LIGHTMAO_REFERENCE_EXTRA_DECISION || 0);
  if (!Number.isInteger(extra) || extra < 0 || extra > 24)
    throw Error('Extra chat verification budget must be 0..24');
  if (!Number.isInteger(extraDecision) || extraDecision < 0 || extraDecision > 64)
    throw Error('Extra decision verification budget must be 0..64');
  const previousChatCap = receipt.caps.chat;
  const previousDecisionCap = receipt.caps.decision;
  receipt.caps.chat = Math.min(128, previousChatCap + extra);
  receipt.caps.decision = Math.min(192, previousDecisionCap + extraDecision);
  receipt.resumes ||= [];
  receipt.resumes.push({
    at: new Date().toISOString(),
    previousChatCap,
    chatCap: receipt.caps.chat,
    previousDecisionCap,
    decisionCap: receipt.caps.decision,
    scope: scoreOnly
      ? 'score-only; does not resume Goal or submit chat requests'
      : 'goal-continuation',
    policyVersion: 'bounded-modules-and-rolling-evidence-v2',
    reason:
      'Explicit bounded verification continuation after trace-led harness fixes; retain the original goal, actual files and receipts. Never repeat unknown perception or generation submissions.',
  });
  receipt.passed = false;
  delete receipt.error;
}
const save = () =>
  writeFile(join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
await save();
const upstream = new URL(process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3');
let api, local;
const relay = createServer((req, res) => {
  void (async () => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const path = req.url,
      kind =
        path === '/api/v1/systemone'
          ? 'decision'
          : path.endsWith('/images/generations')
            ? 'image'
            : path.endsWith('/chat/completions')
              ? body.stream
                ? 'chat'
                : body.messages?.some(
                      (m) =>
                        Array.isArray(m.content) && m.content.some((c) => c.type === 'input_audio'),
                    )
                  ? 'audio'
                  : 'vision'
              : undefined;
    if (!kind || receipt.counts[kind] >= receipt.caps[kind]) {
      res
        .writeHead(429, { 'content-type': 'application/json' })
        .end('{"error":"bounded_verification_request_cap"}');
      return;
    }
    receipt.counts[kind]++;
    await save();
    console.log(JSON.stringify({ request: kind, counts: receipt.counts }));
    const url =
      kind === 'decision'
        ? new URL('/api/v1/systemone', upstream)
        : new URL(upstream.href.replace(/\/$/, '') + '/' + path.split('/api/v3/')[1]);
    const headers = {
      'content-type': 'application/json',
      authorization: 'Bearer ' + process.env.ARK_API_KEY,
      ...(kind === 'decision' ? { 'ark-beta-systemone-api': 'true' } : {}),
    };
    const response = await fetch(url, {
      method: req.method,
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000),
    });
    res.writeHead(response.status, {
      'content-type': response.headers.get('content-type') || 'application/json',
    });
    if (response.body)
      for await (const chunk of response.body) {
        if (res.destroyed) break;
        res.write(chunk);
      }
    res.end();
  })().catch((e) => {
    receipt.transportError = e.message;
    void save();
    if (!res.headersSent) res.writeHead(502);
    res.end('{"error":"live_transport_incomplete"}');
  });
});
await new Promise((r) => relay.listen(0, '127.0.0.1', r));
try {
  api = await createApi({
    dataDir: join(dir, 'api'),
    demo: true,
    arkKey: 'backend-only-local-relay',
    arkBase: `http://127.0.0.1:${relay.address().port}/api/v3`,
    modelId: process.env.ARK_MODEL_ID,
    decisionModelId: process.env.ARK_SYSTEM_ONE_MODEL_ID,
    visionModelId: process.env.ARK_VISION_MODEL_ID,
    audioModelId: process.env.ARK_AUDIO_MODEL_ID,
    imageModelId: process.env.ARK_IMAGE_MODEL_ID,
  });
  await api.app.listen({ host: '127.0.0.1', port: 0 });
  local = await createLocalAgent({
    dataDir: join(dir, 'agent'),
    apiUrl: `http://127.0.0.1:${api.app.server.address().port}`,
    godotPath: resolve('.lightmao/tools/godot/4.7.2/Godot.app'),
    tickMs: 60000,
    ffmpegPath: process.env.LIGHTMAO_FFMPEG_PATH,
  });
  const login = (
      await api.app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} })
    ).json(),
    owner = login.user.id,
    headers = { authorization: 'Bearer ' + login.token };
  async function call(method, url, payload) {
    const r = await local.app.inject({
      method,
      url,
      headers,
      ...(payload === undefined ? {} : { payload }),
    });
    if (r.statusCode >= 300)
      throw Error(`${method} ${url}: ${r.statusCode} ${r.body.slice(0, 400)}`);
    return r.json();
  }
  receipt.owner = owner;
  const project = previous
      ? receipt.project
      : await call('POST', '/local/projects', {
          name: '万象仙途 · 参考录屏复刻',
          engine: 'Web',
          description: '真实 Agent 从自然语言和用户参考录屏制作，保留每版实际试玩和视觉评分',
        }),
    session = previous
      ? await call('GET', '/local/sessions/' + receipt.sessionId)
      : await call('POST', '/local/sessions', {
          projectId: project.id,
          title: '仙侠Roguelite · 战前与战中构筑',
        });
  receipt.project = project;
  receipt.sessionId = session.id;
  const reference = previous
    ? receipt.reference
    : await local.references.importSelectedFile(
        owner,
        project.id,
        '/Users/bytedance/Downloads/飞书20261102-164454.qt',
      );
  receipt.reference = await local.references.wait(owner, reference.id);
  if (receipt.reference.status !== 'ready') throw Error(receipt.reference.error);
  await save();
  if (previous) {
    for (const job of api.perception.list(owner, project.id))
      if (job.status === 'failed')
        try {
          api.perception.revalidate(owner, job.id);
        } catch {}
    if (!scoreOnly) {
      const old = local.workflows.goal(owner, session.id);
      local.workflows.control(owner, session.id, 'resume', old.revision);
    }
  }
  const prompt = `基于项目中的参考游戏录屏，制作能直接打开游玩的浏览器游戏。\n\n国风 Q 版仙侠题材的「 Roguelite 技能构筑 + 重度数值养成」爬塔手游，可自动可手选。\n单局三段式：战前 5 轮技能预选（每轮选 2 个，可看广告刷新）→ 5 波敌人自动推进 → 第 5 波多层血条 BOSS → 胜利结算。\n双层成长：局内靠随机技能词条提供每局不同的 Build 乐趣；局外靠门客永久等级、星级、阵营加成和角色抽取提供长期养成线。\n爽感来源：满屏弹幕特效配合千万至亿级伤害跳字，零操作门槛、强视觉反馈，目标受众是碎片化挂机休闲玩家和国风题材用户。\n\n补充：战前五轮预选之后，战斗中途仍要弹出随机技能选择，选择后叠加构筑并恢复战斗。广告刷新用明确标注的本地演示。请实际试玩并修复，再与录屏画面对比评分；不能只检查预选或胜利页。`;
  receipt.prompt = prompt;
  const started = scoreOnly
    ? { id: receipt.runs?.at(-1)?.id || receipt.firstRunId }
    : await call('POST', `/local/sessions/${session.id}/runs`, {
        prompt: previous
          ? process.env.LIGHTMAO_REFERENCE_REVIEW_FINDING
            ? '继续当前目标。审阅线索（尚需你核对实际源码与运行，不是通过结论）：' +
              process.env.LIGHTMAO_REFERENCE_REVIEW_FINDING
            : '继续'
          : prompt,
        mode: 'ark',
        workMode: 'goal',
        referenceIds: [reference.id],
        goalOptions: { maxRounds: 12, maxMinutes: 20, evidencePolicy: 'playtest' },
      });
  receipt.firstRunId ||= started.id;
  await save();
  const end = Date.now() + 20 * 60000;
  let last = 0;
  for (;;) {
    await delay(1800);
    await local.tick();
    const goal = local.workflows.goal(owner, session.id),
      runs = local.store.list('run', owner).filter((r) => r.sessionId === session.id);
    receipt.workflow = local.workflows.view(owner, session.id);
    receipt.runs = runs;
    receipt.playtests = local.playtests.list(owner, project.id);
    if (Date.now() - last > 20000) {
      console.log(
        JSON.stringify({
          progress: {
            status: goal?.status,
            rounds: goal?.rounds,
            tools: runs.reduce((n, r) => n + r.toolCount, 0),
            playtests: receipt.playtests.map((p) => ({
              id: p.id,
              status: p.status,
              actions: p.inputActions,
              error: p.error,
            })),
          },
        }),
      );
      last = Date.now();
      await save();
    }
    if (goal && goal.status !== 'active' && !goal.currentRunId) break;
    if (Date.now() > end) {
      if (goal?.status === 'active')
        local.workflows.control(owner, session.id, 'pause', goal.revision);
      throw Error('Reference game live run reached bounded wall time');
    }
  }
  receipt.perception = api.perception.list(owner, project.id);
  const traceHeads = local.store
    .list('trace-head', owner)
    .filter((h) => h.sessionId === session.id);
  if (traceHeads.length) {
    receipt.traceReview = await call('GET', `/local/traces/${traceHeads.at(-1).id}/review`);
    await writeFile(join(dir, 'trace-review.json'), JSON.stringify(receipt.traceReview, null, 2));
  }
  for (const job of receipt.playtests) {
    if (job.screenshotSha256)
      await writeFile(
        join(gallery, job.id + '.png'),
        await local.playtests.screenshot(owner, job.id),
      );
    for (const capture of job.captures || [])
      await writeFile(
        join(gallery, job.id + '-' + capture.id + '.jpg'),
        (await local.playtests.capture(owner, job.id, capture.id)).bytes,
      );
  }
  const current = receipt.playtests
    .filter((p) => p.status === 'passed' && p.inputActions)
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
    .at(-1);
  const candidate = receipt.playtests
    .filter((p) => p.screenshotSha256 && p.inputActions)
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
    .at(-1);
  if (candidate) {
    try {
      let score = await local.references.evaluate(
        owner,
        project.id,
        reference.id,
        candidate.id,
        login.token,
        session.id,
        started.id,
        local.playtests,
      );
      while (['queued', 'running'].includes(score.status))
        score = await api.perception.wait(owner, score.id, 25);
      receipt.assessmentHistory ||= [];
      if (
        receipt.visualAssessment &&
        !receipt.assessmentHistory.some((v) => v.id === receipt.visualAssessment.id)
      )
        receipt.assessmentHistory.push(receipt.visualAssessment);
      receipt.visualAssessment = score;
      receipt.scoringPlaytestId = candidate.id;
    } catch (e) {
      receipt.scoringError = e.message;
    }
  }
  receipt.passed =
    receipt.workflow.goal?.status === 'completed' &&
    !!current &&
    receipt.scoringPlaytestId === current.id &&
    receipt.visualAssessment?.status === 'completed' &&
    receipt.visualAssessment.visualScore >= (receipt.workflow.goal?.visualMinScore ?? 70);
  receipt.perception = api.perception.list(owner, project.id);
  if (traceHeads.length) {
    receipt.traceReview = await call('GET', `/local/traces/${traceHeads.at(-1).id}/review`);
    await writeFile(join(dir, 'trace-review.json'), JSON.stringify(receipt.traceReview, null, 2));
  }
  receipt.endedAt = new Date().toISOString();
  await save();
  console.log(
    JSON.stringify({
      receipt: join(dir, 'receipt.json'),
      passed: receipt.passed,
      counts: receipt.counts,
      goal: receipt.workflow.goal?.status,
      visualScore: receipt.visualAssessment?.visualScore,
    }),
  );
} catch (e) {
  receipt.error = e.message;
  await save();
  console.log(
    JSON.stringify({
      receipt: join(dir, 'receipt.json'),
      error: e.message,
      counts: receipt.counts,
    }),
  );
  process.exitCode = 1;
} finally {
  await local?.app.close();
  await api?.app.close();
  relay.closeAllConnections();
  await new Promise((r) => relay.close(() => r()));
  await save();
}
