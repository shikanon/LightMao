import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile, readFile, cp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApi } from '../apps/api/server.ts';
import { createLocalAgent } from '../apps/agent/server.ts';
import { IsolatedExecutor } from '../apps/agent/isolation.ts';
import { safeUser } from '../apps/api/auth.ts';

// Explicit, bounded live verification. Never repeats a media submission to poll it.
const stage = process.argv[2];
if (!['playtests', 'games', 'media'].includes(stage))
  throw Error('Choose playtests, games or media.');
process.loadEnvFile();
if (!process.env.ARK_API_KEY) throw Error('Configure the private backend environment first.');
const resumeDir = process.env.LIGHTMAO_VERIFY_RESUME_DIR;
if (resumeDir && stage !== 'games')
  throw Error('Only known game progress can be resumed by this verifier.');
const previousReceipt = resumeDir
  ? JSON.parse(await readFile(join(resolve(resumeDir), 'receipt.json'), 'utf8'))
  : undefined;
const id = previousReceipt?.id || randomUUID(),
  dir = resumeDir
    ? resolve(resumeDir)
    : resolve('.lightmao/verification/upgrade-' + stage + '-' + id);
const gallery = resolve(
  '/Users/bytedance/.codex/visualizations/2026/11/02/lightmao-upgrade',
  stage + '-' + id,
);
await mkdir(dir, { recursive: true, mode: 0o700 });
await mkdir(gallery, { recursive: true, mode: 0o700 });
const cap =
  stage === 'media'
    ? { chat: 0, decision: 0, image: 1, video: 1 }
    : stage === 'games'
      ? { chat: 28, decision: 24, image: 0, video: 0 }
      : { chat: 2, decision: 10, image: 0, video: 0 };
const counts = previousReceipt?.counts || {
  chat: 0,
  decision: 0,
  image: 0,
  video: 0,
  videoQueries: 0,
};
if (previousReceipt)
  cap.chat = Math.min(
    56,
    previousReceipt.cap.chat + Number(process.env.LIGHTMAO_VERIFY_EXTRA_CHAT || 0),
  );
const receipt = previousReceipt || {
  id,
  stage,
  dir,
  gallery,
  at: new Date().toISOString(),
  cap,
  counts,
  results: [],
  passed: false,
};
receipt.cap = cap;
receipt.passed = false;
if (previousReceipt) {
  receipt.resumes ||= [];
  receipt.resumes.push({ at: new Date().toISOString(), previousError: receipt.error, cap });
  delete receipt.error;
}
const receiptPath = join(dir, 'receipt.json');
const save = () => writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
await save();
const base = new URL(process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3');
const sockets = new Set();
const relay = createServer((req, res) => {
  void (async () => {
    const path = req.url;
    const kind =
      path === '/api/v1/systemone'
        ? 'decision'
        : path.endsWith('/chat/completions')
          ? 'chat'
          : path.endsWith('/images/generations')
            ? 'image'
            : req.method === 'POST' && path.endsWith('/contents/generations/tasks')
              ? 'video'
              : undefined;
    if (kind) {
      if (counts[kind] >= cap[kind]) {
        res.writeHead(429).end('{"error":"verification_request_cap"}');
        return;
      }
      counts[kind]++;
      await save();
    } else if (req.method === 'GET' && path.includes('/contents/generations/tasks/'))
      counts.videoQueries++;
    else {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (kind === 'chat') {
      const input = JSON.parse(Buffer.concat(chunks).toString());
      const calls = input.messages
        .flatMap((message) => message.tool_calls || [])
        .map((call) => call.id);
      const results = input.messages
        .filter((message) => message.role === 'tool')
        .map((message) => message.tool_call_id);
      receipt.lastChatShape = {
        bytes: Buffer.concat(chunks).length,
        messages: input.messages.length,
        maxTokens: input.max_tokens,
        tools: input.tools?.length || 0,
        missingResults: calls.filter((id) => !results.includes(id)).length,
        unmatchedResults: results.filter((id) => !calls.includes(id)).length,
      };
      await save();
    }
    const target = new URL(base);
    target.pathname =
      kind === 'decision'
        ? '/api/v1/systemone'
        : base.pathname.replace(/\/$/, '') + path.replace(/^\/api\/v3/, '');
    const headers = {
      authorization: 'Bearer ' + process.env.ARK_API_KEY,
      'content-type': 'application/json',
      ...(kind === 'decision' ? { 'ark-beta-systemone-api': 'true' } : {}),
    };
    const response = await fetch(target, {
      method: req.method,
      headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
      redirect: 'error',
    });
    if (!response.ok) {
      const raw = await response.text();
      let details;
      try {
        const parsed = JSON.parse(raw);
        details = { code: parsed.error?.code, type: parsed.error?.type };
      } catch {}
      receipt.upstreamErrors ||= [];
      receipt.upstreamErrors.push({
        at: new Date().toISOString(),
        status: response.status,
        ...details,
      });
      await save();
      res.writeHead(response.status, { 'content-type': 'application/json' }).end(raw);
      return;
    }
    res.writeHead(response.status, {
      'content-type': response.headers.get('content-type') || 'application/json',
    });
    if (response.body)
      for await (const chunk of response.body) {
        if (res.destroyed) break;
        res.write(chunk);
      }
    res.end();
  })().catch(async (error) => {
    receipt.transportErrors ||= [];
    receipt.transportErrors.push({
      at: new Date().toISOString(),
      name: error.name,
      code: error.cause?.code || error.code,
    });
    await save();
    if (!res.headersSent) res.writeHead(502);
    res.end('{"error":"verification_transport_incomplete"}');
  });
});
relay.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});
await new Promise((done) => relay.listen(0, '127.0.0.1', done));
const api = await createApi({
  dataDir: dir,
  arkKey: 'server-side-verification-relay',
  arkBase: `http://127.0.0.1:${relay.address().port}/api/v3`,
  modelId: process.env.ARK_MODEL_ID,
  decisionModelId: process.env.ARK_SYSTEM_ONE_MODEL_ID,
  imageModelId: process.env.ARK_IMAGE_MODEL_ID,
  videoModelId: process.env.ARK_VIDEO_MODEL_ID,
  generationPollMs: 4000,
});
await api.app.listen({ host: '127.0.0.1', port: 0 });
const local = await createLocalAgent({
  dataDir: dir,
  apiUrl: `http://127.0.0.1:${api.app.server.address().port}`,
  godotPath: resolve('.lightmao/tools/godot/4.7.2/Godot.app'),
});
let login;
async function request(app, method, url, payload) {
  const response = await app.inject({
    method,
    url,
    headers: login ? { authorization: 'Bearer ' + login.token } : {},
    ...(payload === undefined ? {} : { payload }),
  });
  assert(
    response.statusCode >= 200 && response.statusCode < 300,
    `${method} ${url}: HTTP ${response.statusCode}`,
  );
  return response.json();
}
async function project(kind, title) {
  const p = await request(local.app, 'POST', '/local/projects', {
    name: title,
    engine: kind === 'browser' ? 'Web' : 'Godot',
    description: 'Isolated live verification ' + id,
  });
  const s = await request(local.app, 'POST', '/local/sessions', { projectId: p.id, title });
  return { p, s };
}
async function grant(p) {
  const prepared = await request(local.app, 'POST', `/local/projects/${p.id}/engine/prepare`, {});
  await request(local.app, 'POST', `/local/projects/${p.id}/engine`, { grantId: prepared.grantId });
}
async function capture(job, label) {
  if (job.screenshotSha256) {
    const path = join(gallery, label + '.png');
    const bytes = await local.playtests.screenshot(login.user.id, job.id);
    await writeFile(path, bytes);
    return path;
  }
}
try {
  if (previousReceipt) {
    assert(
      !api.store
        .list('usage')
        .some((u) => ['running', 'unknown', 'interrupted'].includes(u.status)),
      'An unknown live request must be reconciled before resuming',
    );
    const { owner } = local.store.db
      .prepare("SELECT owner FROM records WHERE kind='project' AND id=?")
      .get(previousReceipt.results[0].projectId);
    const user = api.store.get('user', owner);
    login = api.auth.login(safeUser(user), 'Resume isolated upgrade verification');
    await request(local.app, 'POST', '/local/authorization', {});
  } else
    login = await request(api.app, 'POST', '/api/auth/register', {
      name: 'Live Upgrade QA',
      email: `upgrade-${id}@example.test`,
      password: randomUUID() + '-Verify1',
    });
  await request(api.app, 'GET', '/api/bootstrap');
  for (const plugin of stage === 'media'
    ? ['image-generation', 'video-generation', 'writer']
    : ['workspace', 'writer', 'godot', 'playtest'])
    await request(api.app, 'PATCH', '/api/plugins/' + plugin, { installed: true, enabled: true });
  if (stage === 'playtests') {
    for (const kind of ['browser', 'godot']) {
      const { p, s } = await project(kind, 'System One live ' + kind);
      if (kind === 'browser')
        await writeFile(
          join(p.root, 'index.html'),
          `<!doctype html><meta charset="utf-8"><title>System One live game</title><style>body{background:#0e1625;color:#fff;font:28px system-ui;text-align:center;padding:70px}button{font-size:24px;padding:20px}</style><h1>星光收集测试场</h1><button id="start">开始游戏</button><p id="score"></p><script type="application/json" data-lightmao-playtest></script><script>let phase='menu',score=0;function publish(){document.querySelector('#score').textContent='星光 '+score;document.querySelector('[data-lightmao-playtest]').textContent=JSON.stringify({state:{phase,score},actions:phase==='playing'?[{id:'collect',label:'按空格收集一颗星光',key:'SPACE',holdMs:80}]:[]})}document.querySelector('#start').onclick=()=>{phase='playing';document.querySelector('#start').disabled=true;publish()};addEventListener('keydown',e=>{if(e.key===' '&&phase==='playing'&&!e.repeat){score++;publish()}});publish();</script>`,
        );
      else {
        await cp(resolve('examples/godot-startrail'), p.root, { recursive: true });
        await grant(p);
      }
      const input = {
        requestId: id + ':' + kind,
        goal:
          kind === 'browser'
            ? '点击开始游戏，然后按一次空格，score至少1才完成。'
            : '向右移动，player_x至少150才完成。',
        maxSteps: 5,
        assertions: [
          {
            field: kind === 'browser' ? 'score' : 'player_x',
            op: 'gte',
            value: kind === 'browser' ? 1 : 150,
          },
        ],
      };
      const initial =
        kind === 'browser'
          ? await local.playtests.start(
              login.user.id,
              p.id,
              s.id,
              input,
              login.token,
              async () => {},
            )
          : await local.playtests.startGodot(
              login.user.id,
              p.id,
              s.id,
              { ...input, visible: true },
              login.token,
              async () => {},
            );
      const final = await local.playtests.wait(login.user.id, initial.id);
      const shot = await capture(final, kind + '-actual');
      receipt.results.push({
        kind,
        projectId: p.id,
        sessionId: s.id,
        job: final,
        screenshot: shot,
      });
      await save();
      assert.equal(final.status, 'passed', final.error);
      assert(final.inputActions > 0);
      assert(shot);
    }
  } else if (stage === 'games') {
    const kinds = process.env.LIGHTMAO_VERIFY_GAME_KIND
      ? [process.env.LIGHTMAO_VERIFY_GAME_KIND]
      : ['browser', 'godot'];
    assert(kinds.every((kind) => ['browser', 'godot'].includes(kind)));
    receipt.requestedKinds = kinds;
    for (const kind of kinds) {
      const old = receipt.results.find((r) => r.kind === kind);
      const { p, s } = old
        ? {
            p: local.store.get('project', old.projectId, login.user.id),
            s: await request(local.app, 'GET', '/local/sessions/' + old.sessionId),
          }
        : await project(kind, kind === 'browser' ? '星轨冲刺 Web' : '星轨守卫 Godot');
      if (kind === 'godot' && !old) {
        await writeFile(
          join(p.root, 'project.godot'),
          '[application]\nconfig/name="Empty verification project"\n',
        );
        await grant(p);
      }
      const prompt =
        kind === 'browser'
          ? '做一个能直接玩的浏览器小游戏：星轨冲刺。玩家左右移动躲避陨石、收集星光，带连击与冲刺冷却，有得分、胜负、清楚的操作提示和重开。画面精致一些。完成后实际试玩、修复发现的问题，保留验证证据。'
          : '用 Godot 做一个能直接玩的原生小游戏：星轨守卫。玩家左右移动接住星光、躲避陨石，带连击和护盾，有得分、胜负、清楚的操作提示和重开。用程序图形先做好核心玩法。完成后打开实际原生画面试玩、修复问题并保留截图和验证证据。';
      const started = old
        ? { id: old.firstRunId }
        : await request(local.app, 'POST', `/local/sessions/${s.id}/runs`, {
            prompt,
            mode: 'ark',
            workMode: 'goal',
            goalOptions: { maxRounds: 3, evidencePolicy: 'playtest' },
          });
      const result = old || {
        kind,
        projectId: p.id,
        sessionId: s.id,
        firstRunId: started.id,
        prompt,
        status: 'running',
      };
      if (!old) receipt.results.push(result);
      else if (old.status !== 'completed') {
        const g = local.workflows.goal(login.user.id, s.id);
        if (g.rounds >= g.maxRounds && Number(process.env.LIGHTMAO_VERIFY_EXTRA_ROUNDS || 0) > 0)
          local.workflows.extendBudget(
            login.user.id,
            s.id,
            g.revision,
            Math.min(10, g.maxRounds + Number(process.env.LIGHTMAO_VERIFY_EXTRA_ROUNDS)),
          );
        else local.workflows.control(login.user.id, s.id, 'resume', g.revision);
      }
      await save();
      const end = Date.now() + 900000;
      for (;;) {
        await delay(1400);
        const view = local.workflows.view(login.user.id, s.id);
        if (view.goal && view.goal.status !== 'active' && !view.goal.currentRunId) {
          result.workflow = view;
          break;
        }
        if (Date.now() > end) {
          const g = view.goal;
          if (g) local.workflows.control(login.user.id, s.id, 'pause', g.revision);
          throw Error('Bounded natural game verification timed out');
        }
      }
      result.runs = local.store.list('run', login.user.id).filter((run) => run.sessionId === s.id);
      result.jobs = local.playtests.list(login.user.id, p.id);
      result.screenshots = [];
      for (const job of result.jobs) {
        const shot = await capture(job, kind + '-' + job.id);
        if (shot) result.screenshots.push(shot);
      }
      result.status = result.workflow.goal.status;
      await save();
      assert.equal(
        result.status,
        'completed',
        'Natural game Goal did not earn actual playtest evidence',
      );
      assert(result.jobs.some((job) => job.status === 'passed' && job.inputActions > 0));
    }
  } else {
    const { p, s } = await project('browser', '多模型生成素材验收');
    const create = async (kind, referenceAssetId) => {
      const job = await request(api.app, 'POST', '/api/generations', {
        requestId: id + ':' + kind,
        projectId: p.id,
        sessionId: s.id,
        kind,
        name: kind === 'image' ? '星轨守卫角色' : '星轨守卫护盾大招',
        prompt:
          kind === 'image'
            ? 'Original cute sci-fi game guardian character, full body, mint teal armor with warm amber visor, small floating star companion, clean readable silhouette, premium 2D game concept art, soft off-white background, no lettering or logos.'
            : 'The original teal-armored game guardian raises an amber energy shield; starlight particles spiral around the character, then the shield expands in one clear pulse. Steady camera, smooth readable action, preserve character appearance, clean dark space background, no text or logos.',
        ...(referenceAssetId ? { referenceAssetId } : {}),
        ...(kind === 'video' ? { duration: 4, ratio: '16:9' } : {}),
      });
      const result = { kind, projectId: p.id, sessionId: s.id, jobId: job.id, status: job.status };
      receipt.results.push(result);
      await save();
      const end = Date.now() + 12 * 60000;
      for (;;) {
        const current = api.generations.get(login.user.id, job.id);
        result.job = current;
        result.status = current.status;
        await save();
        if (['completed', 'failed', 'unknown'].includes(current.status)) break;
        if (Date.now() > end)
          throw Error('Generation remains pending: inspect same job ID; never resubmit');
        await delay(4000);
      }
      assert.equal(
        result.status,
        'completed',
        'Generation did not finish; inspect existing job, no repeat submit',
      );
      const asset = result.job.asset,
        bytes = await api.assets.read(api.assets.get(login.user.id, asset.id));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256);
      result.file = join(gallery, asset.name);
      await writeFile(result.file, bytes);
      const executor = new IsolatedExecutor(join(dir, 'import-verification'));
      await executor.ready();
      result.import = await executor.file(p.root, true, 'import_asset', {
        path: 'generated/' + asset.name,
        base64: bytes.toString('base64'),
        mime: asset.mime,
        sha256: asset.sha256,
      });
      assert.deepEqual(await readFile(join(p.root, 'generated', asset.name)), bytes);
      await save();
      return result.job;
    };
    const image = await create('image');
    await create('video', image.asset.id);
  }
  receipt.passed = true;
} catch (e) {
  receipt.error =
    e instanceof assert.AssertionError
      ? e.message
      : 'Live verification did not finish; inspect persisted job/run metadata before resuming.';
  process.exitCode = 1;
} finally {
  receipt.usage = api.store
    .list('usage')
    .map(
      ({
        id,
        model,
        capability,
        status,
        promptTokens,
        completionTokens,
        totalTokens,
        durationMs,
        upstreamStatus,
      }) => ({
        id,
        model,
        capability,
        status,
        promptTokens,
        completionTokens,
        totalTokens,
        durationMs,
        upstreamStatus,
      }),
    );
  await local.app.close();
  await api.app.close();
  for (const socket of sockets) socket.destroy();
  await new Promise((done) => relay.close(done));
  await save();
}
console.log(
  JSON.stringify({
    receipt: receiptPath,
    passed: receipt.passed,
    counts,
    error: receipt.error,
    results: receipt.results.map(({ kind, status, job, screenshot, file }) => ({
      kind,
      status: status || job?.status,
      screenshot,
      file,
    })),
  }),
);
