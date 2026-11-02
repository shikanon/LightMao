import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApi } from '../apps/api/server.ts';
import { Store } from '../packages/shared/store.ts';
import { seedConversation } from '../tests/fixtures/conversation.ts';

// This is an explicitly seeded history fixture followed by real paid Ark
// requests. It neither imports a user's conversation nor changes root data.
process.loadEnvFile();
assert(process.env.ARK_API_KEY && process.env.ARK_MODEL_ID, 'Configure the private backend first');
const id = randomUUID();
const directory = await mkdtemp(join(tmpdir(), 'lightmao-context-live-'));
const receiptPath = resolve(`.lightmao/verification/context-live-${id}.json`);
const marker = 'LIVE_HISTORY_' + randomUUID();
const receipt = {
  id,
  at: new Date().toISOString(),
  dataDir: directory,
  model: process.env.ARK_MODEL_ID,
  passed: false,
  scope:
    'Explicitly seeded historical fixtures; later summary, tool recall and continuation use real Ark. No user history, OSS or game execution.',
  requestCap: 5,
  checks: {},
};
const requests = [];
const api = await createApi({
  dataDir: directory,
  demo: true,
  arkKey: process.env.ARK_API_KEY,
  arkBase: process.env.ARK_BASE_URL,
  modelId: process.env.ARK_MODEL_ID,
});
const content = (message) =>
  typeof message.content === 'string'
    ? message.content
    : message.content
        ?.filter((v) => v.type === 'text')
        .map((v) => v.text)
        .join('\n') || '';
api.app.addHook('preHandler', async (req) => {
  if (req.url !== '/api/v1/chat/completions') return;
  if (requests.length >= receipt.requestCap)
    throw Object.assign(new Error('Live verification request cap reached'), { statusCode: 429 });
  const body = req.body;
  const serialized = JSON.stringify(body);
  requests.push({
    bytes: Buffer.byteLength(serialized),
    messages: body.messages.length,
    summary: body.messages.some((m) => content(m).includes('LIGHTMAO_SUMMARY_V1')),
    tools: body.tools?.map((v) => v.function.name) || [],
    markerPresent: serialized.includes(marker),
    memoryReference: serialized.includes('历史摘要（参考数据'),
  });
});
await api.app.listen({ host: '127.0.0.1', port: 0 });
const apiBase = `http://127.0.0.1:${api.app.server.address().port}`;
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
let child, agentBase, token, owner, db;
async function launch() {
  const env = { ...process.env };
  for (const name of Object.keys(env))
    if (/^(ARK_|OSS_|DOUBAO_|LIGHTMAO_ADMIN_)/.test(name)) delete env[name];
  delete env.ELECTRON_RUN_AS_NODE;
  const module = new URL('../apps/agent/server.ts', import.meta.url).href;
  const source = `import {createLocalAgent} from ${JSON.stringify(module)};const local=await createLocalAgent({dataDir:${JSON.stringify(directory)},apiUrl:${JSON.stringify(apiBase)},tickMs:3600000});await local.app.listen({host:'127.0.0.1',port:0});process.send({port:local.app.server.address().port});process.on('SIGTERM',()=>void local.app.close().then(()=>process.exit(0)));`;
  child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout.resume();
  child.stderr.resume();
  const ready = await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(Error('Isolated Agent did not start')), 15000);
    child.once('message', (v) => {
      clearTimeout(timer);
      done(v);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(Error(`Isolated Agent exited ${code}`));
    });
    child.once('error', reject);
  });
  agentBase = `http://127.0.0.1:${ready.port}`;
  const exposed = /(?:^|\s)(?:ARK_|OSS_|DOUBAO_|LIGHTMAO_ADMIN_)[A-Z0-9_]*=/.test(
    execFileSync('ps', ['eww', '-p', String(child.pid), '-o', 'command='], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    }),
  );
  assert.equal(exposed, false);
  receipt.checks.agentServerCredentialEnvAbsent = true;
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const done = once(child, 'exit');
  child.kill('SIGTERM');
  await done;
}
async function request(path, payload) {
  const response = await fetch((path.startsWith('/local/') ? agentBase : apiBase) + path, {
    method: payload ? 'POST' : 'GET',
    headers: {
      authorization: 'Bearer ' + (token || ''),
      ...(payload ? { 'content-type': 'application/json' } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  assert(response.ok, `Verification request failed ${response.status}: ${path}`);
  return response.json();
}
async function send(sessionId, prompt) {
  const run = await request(`/local/sessions/${sessionId}/runs`, { prompt, mode: 'ark' });
  (receipt.runIds ||= []).push(run.id);
  // Persist intent before waiting. A timeout never resubmits this operation.
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const current = db.get('run', run.id, owner);
    if (current.status !== 'running') return current;
    await delay(100);
  }
  throw Error(
    'Real context run did not settle; its receipt is retained, no automatic resubmission',
  );
}
try {
  await mkdir(resolve('.lightmao/verification'), { recursive: true, mode: 0o700 });
  await launch();
  const login = await request('/api/auth/demo', {});
  token = login.token;
  owner = login.user.id;
  const project = (await request('/local/bootstrap')).projects[0];
  const session = await request('/local/sessions', {
    projectId: project.id,
    title: '真实方舟历史整理验证',
  });
  receipt.sessionId = session.id;
  db = new Store(join(directory, 'local.sqlite'));
  const seeded = seedConversation(db, owner, session.id, 8, 3400, '历史验收口令：' + marker);
  const original = db.get('session', session.id, owner).messages;
  const checkpoints = db.list('session-checkpoint', owner).map(hash);
  receipt.seededHistory = { rounds: 8, messages: original.length, fixture: true };
  const result = await send(
    session.id,
    `只核对历史资料。请使用 read_session_history 回读消息 ID ${seeded[0].user.id} 的用户原文，找到历史验收口令，原样输出口令，再说明“仅核对历史，未运行游戏”。不要修改工程，不运行引擎，不调用其他工具。`,
  );
  receipt.firstRun = {
    id: result.id,
    status: result.status,
    historyContext: result.historyContext,
  };
  assert.equal(result.status, 'completed', result.error);
  assert(
    result.text.includes(marker),
    'The final answer omitted the marker available only in old history',
  );
  assert(result.historyContext?.summaryRef);
  const summaries = requests.filter((v) => v.summary);
  assert(summaries.length > 0 && summaries.every((v) => v.tools.length === 0));
  const main = requests.filter((v) => !v.summary);
  assert(main.length >= 2 && main.every((v) => v.memoryReference));
  assert(main.every((v) => v.bytes < 45000));
  assert.deepEqual(
    db.get('session', session.id, owner).messages.slice(0, original.length),
    original,
  );
  assert.deepEqual(
    db.list('session-checkpoint', owner).slice(0, checkpoints.length).map(hash),
    checkpoints,
  );
  const details = db.list('tool-detail', owner).filter((v) => v.runId === result.id);
  assert(details.length >= 1 && details.every((v) => v.name === 'read_session_history'));
  assert.equal(result.toolErrorCount || 0, 0);
  receipt.tools = details.map((v) => v.name);
  const memory = await request(
    `/local/sessions/${session.id}/context/${result.historyContext.summaryRef}`,
  );
  const ids = new Set(original.map((v) => v.id));
  assert(memory.items.every((v) => v.sourceIds.length && v.sourceIds.every((id) => ids.has(id))));
  const page = await request(
    `/local/sessions/${session.id}/history?messageId=${seeded[0].user.id}&limit=4000`,
  );
  assert.equal(page.text, seeded[0].user.text);
  receipt.checks.realSummaryAndToolRecall = true;
  receipt.checks.originalHistoryAndCheckpointsPreserved = true;
  receipt.checks.typedSummarySourcesVerified = true;
  receipt.checks.providerRequestBounded = true;
  const count = requests.length;
  await stop();
  await launch();
  const restored = await request(`/local/sessions/${session.id}/context/${memory.id}`);
  assert.deepEqual(restored, memory);
  assert.equal(requests.length, count);
  const continued = await send(
    session.id,
    '继续核对：只简短确认此前的历史验收口令；不要执行工具或修改工程。',
  );
  receipt.continuation = {
    id: continued.id,
    status: continued.status,
    historyContext: continued.historyContext,
  };
  assert.equal(continued.status, 'completed', continued.error);
  assert(continued.text.includes(marker));
  assert.equal(requests.filter((v) => v.summary).length, summaries.length);
  assert.equal(continued.historyContext.summaryCalls, 0);
  assert.equal(continued.historyContext.summaryRef, memory.id);
  assert.equal(continued.toolCount || 0, 0);
  receipt.checks.restartAndExplicitContinuationReuseSummary = true;
  assert.equal(db.list('engine-job', owner).length, 0);
  receipt.checks.noGameEngineOrWriteTools = true;
  receipt.passed = true;
} catch (error) {
  receipt.error = error.message;
  process.exitCode = 1;
} finally {
  await stop();
  if (db && owner)
    receipt.runStatuses = db
      .list('run', owner)
      .filter((v) => receipt.runIds?.includes(v.id))
      .map((v) => ({ id: v.id, status: v.status, error: v.error }));
  receipt.modelRequests = requests;
  if (db && owner)
    receipt.summaryAttempts = db.list('conversation-attempt', owner).map((v) => ({
      id: v.id,
      state: v.state,
      batch: v.batch,
      totalChars: v.totalChars,
      textHash: v.textHash,
      failure: v.failure,
    }));
  receipt.usage = api.store
    .list('usage')
    .filter((v) => v.userId === owner)
    .map((v) => ({
      id: v.id,
      status: v.status,
      promptTokens: v.promptTokens,
      completionTokens: v.completionTokens,
      totalTokens: v.totalTokens,
    }));
  receipt.totalTokens = receipt.usage.reduce((n, v) => n + (v.totalTokens || 0), 0);
  if (receipt.usage.some((v) => v.status !== 'completed')) {
    receipt.passed = false;
    process.exitCode = 1;
  }
  db?.close();
  await api.app.close();
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ ...receipt, receipt: receiptPath }));
}
