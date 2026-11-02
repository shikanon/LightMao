import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
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
const id = randomUUID();
const dir = await mkdtemp(join(tmpdir(), 'lightmao-scheduled-live-'));
const receipt = {
  id,
  at: new Date().toISOString(),
  dataDir: dir,
  model: process.env.ARK_MODEL_ID,
  passed: false,
  checks: {},
};
const path = resolve(`.lightmao/verification/scheduled-live-${id}.json`);
const api = await createApi({
  dataDir: dir,
  demo: true,
  arkKey: process.env.ARK_API_KEY,
  arkBase: process.env.ARK_BASE_URL,
  modelId: process.env.ARK_MODEL_ID,
});
await api.app.listen({ host: '127.0.0.1', port: 0 });
const apiBase = `http://127.0.0.1:${api.app.server.address().port}`;
let child, agentBase, token, owner, db;
async function launch() {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/^(ARK_|OSS_|DOUBAO_|LIGHTMAO_ADMIN_)/.test(key)) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  const module = new URL('../apps/agent/server.ts', import.meta.url).href;
  const source = `import {createLocalAgent} from ${JSON.stringify(module)};const local=await createLocalAgent({dataDir:${JSON.stringify(dir)},apiUrl:${JSON.stringify(apiBase)}});await local.app.listen({host:'127.0.0.1',port:0});process.send({port:local.app.server.address().port});process.on('SIGTERM',()=>void local.app.close().then(()=>process.exit(0)));`;
  child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout.resume();
  child.stderr.resume();
  const ready = await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('Isolated local Agent did not start')), 15000);
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
async function request(route, body) {
  const response = await fetch((route.startsWith('/local/') ? agentBase : apiBase) + route, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${token || ''}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert(response.ok, `Request failed ${response.status}: ${route}`);
  return response.json();
}
async function until(check, message) {
  for (let i = 0; i < 240; i++) {
    if (check()) return;
    await delay(500);
  }
  throw new Error(message);
}
try {
  await launch();
  const login = await request('/api/auth/demo', {});
  token = login.token;
  owner = login.user.id;
  const project = (await request('/local/bootstrap')).projects[0];
  const marker = `SCHEDULED_${id.slice(0, 8)}`;
  const file = join(project.root, 'README.md');
  await writeFile(
    file,
    `# 定时任务真实联调\n校验短语：${marker}\n此文件用于读取验证，请保持原样。\n`,
    { mode: 0o600 },
  );
  const hash = createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
  const task = await request('/local/schedules', {
    name: '真实方舟定时读取验证',
    projectId: project.id,
    prompt:
      '请必须实际使用 read_file 工具读取 README.md，找出文档中的校验短语并在最终回答中原样输出。只读取，不修改文件，不执行引擎。',
    mode: 'ark',
    frequency: 'interval',
    intervalMinutes: 60,
    time: '09:00',
    timezone: 'Asia/Shanghai',
    enabled: true,
  });
  receipt.taskId = task.id;
  const plannedAt = new Date(Date.now() - 2000).toISOString();
  db = new Store(join(dir, 'local.sqlite'));
  db.put('schedule', owner, { ...db.get('schedule', task.id, owner), nextRunAt: plannedAt });
  await until(
    () => db.list('run', owner).some((run) => run.taskId === task.id && run.status !== 'running'),
    'Real scheduled model run did not settle',
  );
  const run = db.list('run', owner).find((run) => run.taskId === task.id);
  receipt.runId = run.id;
  receipt.runStatus = run.status;
  assert.equal(run.status, 'completed');
  assert(run.text.includes(marker));
  const events = db
    .list('event', owner)
    .filter((event) => event.runId === run.id && event.type === 'tool.finished');
  receipt.tools = events.map((event) => event.data.name);
  assert(receipt.tools.includes('read_file'));
  assert(!receipt.tools.includes('write_file'));
  assert.equal(
    createHash('sha256')
      .update(await readFile(file))
      .digest('hex'),
    hash,
  );
  receipt.checks.realTimerArkRead = true;
  receipt.checks.filesUnchanged = true;
  const occurrence = db.get('task-occurrence', run.taskOccurrenceId, owner);
  assert.equal(occurrence.status, 'completed');
  assert.equal(occurrence.scheduledAt, plannedAt);
  receipt.checks.terminalReceiptAndRunAgree = true;
  await stop();
  db.put('schedule', owner, { ...db.get('schedule', task.id, owner), nextRunAt: plannedAt });
  const calls = api.store.list('usage').filter((usage) => usage.userId === owner).length;
  await launch();
  await until(
    () => Date.parse(db.get('schedule', task.id, owner).nextRunAt) > Date.now(),
    'Restart did not reconcile the consumed occurrence',
  );
  assert.equal(db.list('task-occurrence', owner).filter((o) => o.taskId === task.id).length, 1);
  assert.equal(db.list('run', owner).filter((r) => r.taskId === task.id).length, 1);
  assert.equal(api.store.list('usage').filter((usage) => usage.userId === owner).length, calls);
  receipt.checks.restartDoesNotRepeatConsumedOccurrence = true;
  receipt.modelRequests = api.store
    .list('usage')
    .filter((usage) => usage.userId === owner)
    .map((usage) => ({ status: usage.status, totalTokens: usage.totalTokens }));
  assert(
    receipt.modelRequests.length > 0 &&
      receipt.modelRequests.every((row) => row.status === 'completed'),
  );
  receipt.totalTokens = receipt.modelRequests.reduce((sum, row) => sum + (row.totalTokens || 0), 0);
  receipt.fileSha256 = hash;
  receipt.noGameEngineExecution = true;
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
  await writeFile(path, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ ...receipt, receipt: path }));
}
