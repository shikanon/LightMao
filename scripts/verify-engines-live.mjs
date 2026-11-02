import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApi } from '../apps/api/server.ts';
import { Store } from '../packages/shared/store.ts';
process.loadEnvFile();
assert(process.env.ARK_API_KEY && process.env.ARK_MODEL_ID, 'Configure the private backend first');
const godotPath = resolve(
  process.env.LIGHTMAO_TEST_GODOT_PATH || '.lightmao/tools/godot/4.7.2/Godot.app',
);
await access(godotPath);
const id = randomUUID(),
  proof = randomUUID();
const dir = await mkdtemp(join(tmpdir(), 'lightmao-engines-live-'));
const receiptPath = resolve(`.lightmao/verification/engines-live-${id}.json`);
const receipt = {
  id,
  at: new Date().toISOString(),
  dataDir: dir,
  model: process.env.ARK_MODEL_ID,
  passed: false,
  checks: {},
};
const observed = [];
const api = await createApi({
  dataDir: dir,
  demo: true,
  arkKey: process.env.ARK_API_KEY,
  arkBase: process.env.ARK_BASE_URL,
  modelId: process.env.ARK_MODEL_ID,
});
api.app.addHook('preHandler', async (req) => {
  if (req.url !== '/api/v1/chat/completions') return;
  if (observed.length >= 6)
    throw Object.assign(new Error('Live verification request cap reached'), { statusCode: 429 });
  const messages = JSON.stringify(req.body.messages);
  observed.push({
    chars: messages.length,
    proof: messages.includes(proof),
    bulkTail: messages.includes('ENGINE_BULK_TAIL_' + id),
  });
});
await api.app.listen({ host: '127.0.0.1', port: 0 });
const apiBase = `http://127.0.0.1:${api.app.server.address().port}`;
let child, agentBase, token, owner, db;
const sha = (value) => createHash('sha256').update(value).digest('hex');
const secretEnvPresent = (pid) =>
  /(?:^|\s)(?:ARK_|OSS_|DOUBAO_|LIGHTMAO_ADMIN_)[A-Z0-9_]*=/.test(
    execFileSync('ps', ['eww', '-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    }),
  );
async function launch() {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/^(ARK_|OSS_|DOUBAO_|LIGHTMAO_ADMIN_)/.test(key)) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  const module = new URL('../apps/agent/server.ts', import.meta.url).href;
  const source = `import {createLocalAgent} from ${JSON.stringify(module)};const local=await createLocalAgent({dataDir:${JSON.stringify(dir)},apiUrl:${JSON.stringify(apiBase)},godotPath:${JSON.stringify(godotPath)}});await local.app.listen({host:'127.0.0.1',port:0});process.send({port:local.app.server.address().port});process.on('SIGTERM',()=>void local.app.close().then(()=>process.exit(0)));`;
  child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout.resume();
  child.stderr.resume();
  const ready = await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('Isolated Agent did not start')), 15000);
    child.once('message', (value) => {
      clearTimeout(timer);
      done(value);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Isolated Agent exited ${code}`));
    });
  });
  agentBase = `http://127.0.0.1:${ready.port}`;
  assert.equal(secretEnvPresent(child.pid), false);
  receipt.checks.agentServerCredentialEnvAbsent = true;
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit');
  child.kill('SIGTERM');
  await exit;
}
async function request(path, body, method) {
  const response = await fetch((path.startsWith('/local/') ? agentBase : apiBase) + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: {
      Authorization: `Bearer ${token || ''}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert(response.ok, `Request ${path}: ${response.status}`);
  return response.json();
}
try {
  await launch();
  const login = await request('/api/auth/demo', {});
  token = login.token;
  owner = login.user.id;
  const project = await request('/local/engines/sample-project', {});
  const scriptPath = `tests/live-${id.slice(0, 8)}.gd`;
  const original = await readFile(join(project.root, 'tests/smoke.gd'), 'utf8');
  const source = original.replace(
    '\tprint("LIGHTMAO_TESTS:',
    `\tprint("LIVE_ENGINE_PROOF: ${proof}")\n\tfor index in range(400):\n\t\tprint("ENGINE_BULK_LOG_%04d: this detail should remain in the archived log." % index)\n\tprint("ENGINE_BULK_TAIL_${id}")\n\tprint("LIGHTMAO_TESTS:`,
  );
  assert.notEqual(original, source);
  await writeFile(join(project.root, scriptPath), source);
  const sourceSHA = sha(Buffer.from(source));
  await request('/api/plugins/godot', { installed: true, enabled: true }, 'PATCH');
  const preview = await request(`/local/projects/${project.id}/engine/prepare`, {});
  const connection = await request(`/local/projects/${project.id}/engine`, {
    grantId: preview.grantId,
  });
  receipt.engineVersion = connection.version;
  receipt.engineExecutableSha256 = connection.sha256;
  const session = await request('/local/sessions', {
    projectId: project.id,
    title: '真实方舟与 Godot 联调',
  });
  const run = await request(`/local/sessions/${session.id}/runs`, {
    mode: 'ark',
    prompt: `请只调用 run_godot 和 read_engine_log 完成本次联调：先以 script 操作执行 ${scriptPath}，timeoutSeconds=45；执行完成后按返回的 logRef 读取首段日志，提取 LIVE_ENGINE_PROOF: 后面的校验短语并在最终答复中原样输出。日志很长，只读取含校验短语的片段，不需要遍历日志。请根据实际 verification 汇报项目断言状态，不要读取或改写源码，不把测试通过称为玩家体验验收。`,
  });
  db = new Store(join(dir, 'local.sqlite'));
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const job = db.list('engine-job', owner).find((job) => job.runId === run.id);
    if (job?.workerPid && receipt.checks.workerServerCredentialEnvAbsent === undefined) {
      try {
        assert.equal(secretEnvPresent(job.workerPid), false);
        receipt.checks.workerServerCredentialEnvAbsent = true;
      } catch (error) {
        if (error.status !== 1) throw error;
      }
    }
    if (db.get('run', run.id, owner).status !== 'running') break;
    await delay(100);
  }
  const final = db.get('run', run.id, owner);
  receipt.runId = run.id;
  receipt.runStatus = final.status;
  assert.equal(final.status, 'completed');
  assert(final.text.includes(proof));
  assert.equal(final.toolErrorCount, 0);
  const jobs = db.list('engine-job', owner).filter((job) => job.runId === run.id);
  assert.equal(jobs.length, 1);
  const job = jobs[0];
  receipt.engineJobId = job.id;
  receipt.engineJobStatus = job.status;
  receipt.phases = job.phases;
  receipt.snapshot = job.snapshot;
  receipt.verification = job.verification;
  assert.equal(job.status, 'completed');
  assert.equal(job.verification, 'tests_passed');
  assert(job.phases.every((phase) => phase.code === 0 && phase.errorCount === 0));
  assert.equal(receipt.checks.workerServerCredentialEnvAbsent, true);
  const report = job.artifacts.find((file) => file.path === 'test-results.json');
  const download = await fetch(agentBase + `/local/engine-jobs/${job.id}/artifacts/${report.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert(download.ok);
  const bytes = Buffer.from(await download.arrayBuffer());
  assert.equal(sha(bytes), report.sha256);
  const tests = JSON.parse(bytes.toString()).tests;
  assert.equal(tests.length, 6);
  assert(tests.every((test) => test.passed));
  receipt.testAssertions = tests.map((test) => ({ name: test.name, passed: test.passed }));
  receipt.artifacts = job.artifacts;
  receipt.checks.realGodotAssertionsAndArtifactBytes = true;
  receipt.tools = db
    .list('tool-detail', owner)
    .filter((detail) => detail.runId === run.id)
    .map((detail) => detail.name);
  assert(receipt.tools.includes('run_godot') && receipt.tools.includes('read_engine_log'));
  assert(!receipt.tools.includes('write_file') && !receipt.tools.includes('read_file'));
  assert(
    observed.length >= 3 &&
      !observed[0].proof &&
      !observed[1].proof &&
      observed.some((value) => value.proof),
  );
  assert(observed.every((value) => !value.bulkTail));
  receipt.modelContext = observed;
  receipt.checks.fullLogStayedOutsideMainContext = true;
  assert.equal(sha(await readFile(join(project.root, scriptPath))), sourceSHA);
  await assert.rejects(access(join(project.root, '.godot')));
  receipt.checks.originalProjectUnchanged = true;
  const logBefore = db.get('engine-log', job.id, owner).text,
    requestsBefore = api.store.list('usage').filter((usage) => usage.userId === owner).length;
  await stop();
  await launch();
  const restored = await request(`/local/engine-jobs/${job.id}`);
  assert.equal(restored.status, 'completed');
  assert.equal(db.get('engine-log', job.id, owner).text, logBefore);
  assert.equal(db.list('engine-job', owner).length, jobs.length);
  assert.equal(
    api.store.list('usage').filter((usage) => usage.userId === owner).length,
    requestsBefore,
  );
  receipt.checks.restartRetainsReceiptWithoutReplay = true;
  const current = await request(`/local/projects/${project.id}/engine`);
  await request(
    `/local/projects/${project.id}/engine`,
    { enabled: false, revision: current.revision },
    'PATCH',
  );
  const blocked = await fetch(agentBase + `/local/projects/${project.id}/engine-jobs`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'validate', requestId: randomUUID() }),
  });
  assert.equal(blocked.status, 403);
  assert.equal(
    api.store.list('usage').filter((usage) => usage.userId === owner).length,
    requestsBefore,
  );
  receipt.checks.disabledConnectionRefusedBeforeExecution = true;
  receipt.modelRequests = api.store
    .list('usage')
    .filter((usage) => usage.userId === owner)
    .map((usage) => ({ status: usage.status, totalTokens: usage.totalTokens }));
  assert(receipt.modelRequests.every((usage) => usage.status === 'completed'));
  receipt.totalTokens = receipt.modelRequests.reduce(
    (sum, value) => sum + (value.totalTokens || 0),
    0,
  );
  receipt.passed = true;
} catch (error) {
  receipt.error = error.message;
  process.exitCode = 1;
} finally {
  await stop();
  db?.close();
  api.app.server.closeAllConnections();
  await api.app.close();
  await mkdir(resolve('.lightmao/verification'), { recursive: true, mode: 0o700 });
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ ...receipt, receipt: receiptPath }));
}
