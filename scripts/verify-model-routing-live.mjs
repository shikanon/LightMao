import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApi } from '../apps/api/server.ts';
import { DEFAULT_AGENT_MODEL, DEFAULT_VISION_MODEL } from '../packages/shared/model-budget.ts';

process.loadEnvFile();
assert(process.env.ARK_API_KEY, 'Configure the backend key first');
const id = randomUUID(),
  root = resolve('.lightmao/verification/model-routing-live-' + id);
await mkdir(root, { recursive: true, mode: 0o700 });
const receipt = {
  id,
  at: new Date().toISOString(),
  passed: false,
  caps: { chat: 6, vision: 1 },
  requests: [],
  checks: {},
};
const save = () =>
  writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
let api, child, token, agentBase, runId;
const base = new URL(process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3');
const relay = createServer((req, res) => {
  void (async () => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw),
      kind = body.stream ? 'chat' : 'vision';
    if (receipt.requests.filter((v) => v.kind === kind).length >= receipt.caps[kind]) {
      res.writeHead(429).end('{"error":"local_verification_budget"}');
      return;
    }
    const request = {
      kind,
      model: body.model,
      maxTokens: body.max_tokens,
      thinking: body.thinking?.type,
      reasoningEffort: body.reasoning_effort,
      reasoningReplay: body.messages.some((m) => !!m.reasoning_content),
      requestSha256: createHash('sha256').update(raw).digest('hex'),
    };
    receipt.requests.push(request);
    await save();
    const controller = new AbortController();
    res.once('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    const response = await fetch(base.href.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + process.env.ARK_API_KEY,
        'content-type': 'application/json',
      },
      body: raw,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]),
    });
    request.upstreamStatus = response.status;
    await save();
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
    res.end('{"error":"transport_incomplete_no_retry"}');
  });
});
await new Promise((r) => relay.listen(0, '127.0.0.1', r));
async function request(path, body) {
  const response = await fetch(
    (path.startsWith('/local/') ? agentBase : api.app.listeningOrigin) + path,
    {
      method: body ? 'POST' : 'GET',
      headers: {
        authorization: 'Bearer ' + (token || ''),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    },
  );
  assert(response.ok, `${path}: HTTP ${response.status}`);
  return response.json();
}
try {
  api = await createApi({
    dataDir: join(root, 'api'),
    demo: true,
    arkKey: 'private-relay-fixture',
    arkBase: `http://127.0.0.1:${relay.address().port}/api/v3`,
    modelId: DEFAULT_AGENT_MODEL,
    contextWindowTokens: 1024000,
    maxOutputTokens: 128000,
    visionModelId: DEFAULT_VISION_MODEL,
  });
  await api.app.listen({ host: '127.0.0.1', port: 0 });
  const env = { ...process.env };
  for (const name of Object.keys(env))
    if (/^(ARK_|OSS_|DOUBAO_|LIGHTMAO_ADMIN_)/.test(name)) delete env[name];
  const module = new URL('../apps/agent/server.ts', import.meta.url).href;
  const source = `import {createLocalAgent} from ${JSON.stringify(module)};const local=await createLocalAgent({dataDir:${JSON.stringify(join(root, 'agent'))},apiUrl:${JSON.stringify(api.app.listeningOrigin)},tickMs:60000});await local.app.listen({host:'127.0.0.1',port:0});process.send({port:local.app.server.address().port});process.on('SIGTERM',()=>void local.app.close().then(()=>process.exit(0)));`;
  child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout.resume();
  child.stderr.resume();
  const ready = await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(Error('Agent startup timeout')), 15000);
    child.once('message', (value) => {
      clearTimeout(timer);
      done(value);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(Error('Agent exited ' + code));
    });
  });
  agentBase = `http://127.0.0.1:${ready.port}`;
  assert(
    !/(?:^|\s)(?:ARK_|OSS_|DOUBAO_|LIGHTMAO_ADMIN_)[A-Z0-9_]*=/.test(
      execFileSync('ps', ['eww', '-p', String(child.pid), '-o', 'command='], { encoding: 'utf8' }),
    ),
  );
  receipt.checks.agentKeyAbsent = true;
  const login = await request('/api/auth/demo', {});
  token = login.token;
  const project = (await request('/local/bootstrap')).projects[0],
    marker = 'ROUTE_' + randomUUID();
  await writeFile(join(project.root, 'README.md'), `校验码：${marker}\n`);
  const session = await request('/local/sessions', {
    projectId: project.id,
    title: 'DeepSeek 路由实测',
  });
  const run = await request(`/local/sessions/${session.id}/runs`, {
    mode: 'ark',
    workMode: 'act',
    prompt:
      '读取 README.md，将其中校验码逐字写入 routing-proof.txt，再回读确认。不要运行引擎；最后简短说明核验结果。',
  });
  runId = run.id;
  receipt.runId = run.id;
  receipt.projectId = project.id;
  await save();
  let finished;
  for (let i = 0; i < 720; i++) {
    finished = await request(`/local/runs/${run.id}`);
    if (finished.status !== 'running') break;
    await delay(500);
  }
  receipt.runStatus = finished?.status;
  assert.equal(finished?.status, 'completed', finished?.error || 'Run did not complete');
  assert((await readFile(join(project.root, 'routing-proof.txt'), 'utf8')).includes(marker));
  const events = await request(`/local/runs/${run.id}/events`),
    tools = events
      .filter((v) => v.type === 'tool.finished' && !v.data.isError)
      .map((v) => v.data.name);
  assert(tools.includes('read_file') && tools.includes('write_file'));
  receipt.checks.actualFileReadWrite = true;
  receipt.toolCalls = tools;
  const chat = receipt.requests.filter((v) => v.kind === 'chat');
  assert(
    chat.length >= 2 &&
      chat.every(
        (v) =>
          v.model === DEFAULT_AGENT_MODEL && v.maxTokens === 128000 && v.upstreamStatus === 200,
      ),
  );
  assert(
    chat.slice(1).some((v) => v.reasoningReplay),
    'DeepSeek reasoning was not replayed through the application compression layer',
  );
  receipt.checks.actualDeepSeek128000AndReplay = true;
  const image = await readFile(
    '.lightmao/verification/perception-live-e64a063c-084d-4631-b441-95391742a0c6/visual-control.png',
  );
  const job = await request('/api/perception', {
    requestId: 'routing-vision-' + id,
    projectId: project.id,
    purpose: 'vision',
    question: '描述图中真实可见的数字、形状和文字。不要推测画面之外的内容。',
    frames: [
      { id: 'actual-blind-control', seconds: 0, mime: 'image/png', data: image.toString('base64') },
    ],
  });
  receipt.visionJobId = job.id;
  await save();
  let observed;
  for (let i = 0; i < 8; i++) {
    observed = await request(`/api/perception/${job.id}?wait=20`);
    if (!['queued', 'running'].includes(observed.status)) break;
  }
  receipt.visionStatus = observed?.status;
  receipt.visionResult = observed?.result;
  assert.equal(observed?.status, 'completed', observed?.error);
  assert(JSON.stringify(observed.result).includes('91978'));
  assert.equal(observed.model, DEFAULT_VISION_MODEL);
  receipt.checks.actualSeedEvolvingBlindVision = true;
  receipt.usage = api.store.list('usage').map((v) => ({
    id: v.id,
    model: v.model,
    capability: v.capability || 'chat',
    status: v.status,
    totalTokens: v.totalTokens,
    durationMs: v.durationMs,
  }));
  receipt.passed = true;
} catch (e) {
  receipt.error = e.message;
  process.exitCode = 1;
} finally {
  if (runId && agentBase && token) await request(`/local/runs/${runId}/stop`, {}).catch(() => {});
  if (child && child.exitCode === null && child.signalCode === null) {
    const done = once(child, 'exit');
    child.kill('SIGTERM');
    await done;
  }
  if (api)
    receipt.usage = api.store.list('usage').map((v) => ({
      id: v.id,
      model: v.model,
      capability: v.capability || 'chat',
      status: v.status,
      totalTokens: v.totalTokens,
      durationMs: v.durationMs,
    }));
  await api?.app.close();
  relay.closeAllConnections();
  await new Promise((r) => relay.close(() => r()));
  await save();
  console.log(
    JSON.stringify({
      passed: receipt.passed,
      path: join(root, 'receipt.json'),
      requests: receipt.requests.length,
      checks: receipt.checks,
      error: receipt.error,
    }),
  );
}
