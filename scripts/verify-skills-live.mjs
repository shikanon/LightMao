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
const dir = await mkdtemp(join(tmpdir(), 'lightmao-skills-live-'));
const receipt = {
  id,
  at: new Date().toISOString(),
  dataDir: dir,
  model: process.env.ARK_MODEL_ID,
  passed: false,
  checks: {},
};
const path = resolve(`.lightmao/verification/skills-live-${id}.json`);
const api = await createApi({
  dataDir: dir,
  demo: true,
  arkKey: process.env.ARK_API_KEY,
  arkBase: process.env.ARK_BASE_URL,
  modelId: process.env.ARK_MODEL_ID,
});
const observed = [];
const guideMarker = `GUIDE_LOADED_${id.slice(0, 8)}`,
  marker = `SKILL_VERIFIED_${id.slice(0, 8)}`;
api.app.addHook('preHandler', async (req) => {
  if (req.url !== '/api/v1/chat/completions') return;
  const text = JSON.stringify(req.body.messages);
  observed.push({
    chars: text.length,
    guide: text.includes(guideMarker),
    reference: text.includes(marker),
  });
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
  const referencePath = `references/fixture-${id.slice(0, 8)}.md`;
  const instructions = `---\nname: live-game-check\ndescription: A game-development review guide with one reference file.\n---\n# ${guideMarker}\n先使用 read_skill_resource 读取本技能的 ${referencePath}。从该资源提取校验短语，并在最终回答中原样输出。仅验证技能读取，不修改工程，不执行脚本，不运行引擎。\n`;
  const reference = `# 技能资源联调\n校验短语：${marker}\n这次检查只验证指引和参考资料的读取，尚未运行游戏引擎。\n`;
  const preview = await request('/local/skills/prepare', {
    rootName: 'live-game-check',
    files: [
      { path: 'SKILL.md', base64: Buffer.from(instructions).toString('base64') },
      { path: referencePath, base64: Buffer.from(reference).toString('base64') },
    ],
  });
  const imported = await request('/local/skills/import', {
    grantId: preview.grantId,
    name: '真实技能读取验证',
    category: '测试',
    enabled: true,
  });
  receipt.skillId = imported.skill.id;
  receipt.skillVersion = imported.skill.sha256;
  const session = await request('/local/sessions', {
    projectId: project.id,
    title: '真实方舟技能资源联调',
  });
  const run = await request(`/local/sessions/${session.id}/runs`, {
    mode: 'ark',
    prompt:
      '请使用我选中的技能。必须先读取 SKILL.md，再按指引读取其参考资源，最后原样输出参考资料中的校验短语。只读取资料，不修改工程，不执行脚本，不运行引擎。',
    skillIds: [imported.skill.id],
  });
  db = new Store(join(dir, 'local.sqlite'));
  await until(
    () => db.get('run', run.id, owner).status !== 'running',
    'Real skill run did not settle',
  );
  const final = db.get('run', run.id, owner);
  receipt.runId = final.id;
  receipt.runStatus = final.status;
  assert.equal(final.status, 'completed');
  assert(final.text.includes(marker));
  assert.equal(final.toolErrorCount, 0);
  const details = db.list('tool-detail', owner).filter((detail) => detail.runId === run.id);
  receipt.tools = details.map((detail) => detail.name);
  assert(
    details.some(
      (detail) => detail.name === 'read_skill_resource' && detail.argsSummary.includes('SKILL.md'),
    ),
  );
  assert(
    details.some(
      (detail) =>
        detail.name === 'read_skill_resource' && detail.argsSummary.includes(referencePath),
    ),
  );
  assert(!receipt.tools.includes('write_file'));
  receipt.checks.realGuideAndResourceRead = true;
  assert(observed.length > 0 && !observed[0].guide && !observed[0].reference);
  assert(observed.some((body) => body.guide) && observed.some((body) => body.reference));
  receipt.modelContext = observed;
  receipt.checks.progressiveModelContext = true;
  await stop();
  await launch();
  const restored = (await request('/local/skills')).find((skill) => skill.id === imported.skill.id);
  assert.equal(restored.sha256, imported.skill.sha256);
  const page = await request(
    `/local/skills/${encodeURIComponent(imported.skill.id)}/resource?path=${encodeURIComponent(referencePath)}`,
  );
  assert.equal(page.text, reference);
  receipt.checks.restartRetainsSkillAndResource = true;
  const requestsBeforeDelete = api.store
    .list('usage')
    .filter((usage) => usage.userId === owner).length;
  const deleted = await fetch(
    agentBase + `/local/skills/${encodeURIComponent(imported.skill.id)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
  );
  assert(deleted.ok);
  const attempt = await request(`/local/sessions/${session.id}/runs`, {
    mode: 'ark',
    prompt: 'Check deleted skill selection rejection',
    skillIds: [imported.skill.id],
  });
  await until(
    () => db.get('run', attempt.id, owner).status !== 'running',
    'Deleted skill guard did not settle',
  );
  assert.equal(db.get('run', attempt.id, owner).status, 'failed');
  assert.equal(db.get('run', attempt.id, owner).toolCount, 0);
  assert.equal(
    api.store.list('usage').filter((usage) => usage.userId === owner).length,
    requestsBeforeDelete,
  );
  assert(db.list('tool-payload', owner).some((payload) => payload.text.includes(marker)));
  receipt.checks.deletedSelectionRefusedBeforeModel = true;
  receipt.checks.historicalReadArchiveRetained = true;
  receipt.modelRequests = api.store
    .list('usage')
    .filter((usage) => usage.userId === owner)
    .map((usage) => ({ status: usage.status, totalTokens: usage.totalTokens }));
  assert(receipt.modelRequests.every((request) => request.status === 'completed'));
  receipt.totalTokens = receipt.modelRequests.reduce((sum, row) => sum + (row.totalTokens || 0), 0);
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
