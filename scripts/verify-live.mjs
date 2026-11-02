import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createApi } from '../apps/api/server.ts';
import { createLocalAgent } from '../apps/agent/server.ts';

process.loadEnvFile();
const at = new Date().toISOString(),
  verificationId = randomUUID();
const root = await mkdtemp(join(tmpdir(), 'lightmao-live-'));
const api = await createApi({
  dataDir: root,
  demo: true,
  arkKey: process.env.ARK_API_KEY,
  arkBase: process.env.ARK_BASE_URL,
  modelId: process.env.ARK_MODEL_ID,
  storage: 'oss',
  oss: {
    region: process.env.OSS_REGION,
    bucket: process.env.OSS_BUCKET,
    accessKeyId: process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    prefix: process.env.OSS_PREFIX,
  },
});
await api.app.listen({ host: '127.0.0.1', port: 0 });
const apiBase = `http://127.0.0.1:${api.app.server.address().port}`;
let local = await createLocalAgent({ dataDir: root, apiUrl: apiBase, tickMs: 60000 });
await local.app.listen({ host: '127.0.0.1', port: 0 });
let localBase = `http://127.0.0.1:${local.app.server.address().port}`;
let token = '',
  owner = '';
const receipt = {
  at,
  verificationId,
  dataDir: root,
  model: process.env.ARK_MODEL_ID,
  checks: {},
  runId: null,
  cloudCleanup: false,
};
async function request(path, body, method, extraHeaders = {}) {
  const r = await fetch((path.startsWith('/local/') ? localBase : apiBase) + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: {
      Authorization: `Bearer ${token}`,
      ...extraHeaders,
      ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? (body instanceof FormData ? body : JSON.stringify(body)) : undefined,
  });
  if (!r.ok) throw new Error(`Verification request failed (${r.status}) at ${path.split('?')[0]}`);
  return r.json();
}
try {
  const login = await request('/api/auth/demo', {});
  token = login.token;
  owner = login.user.id;
  const cloud = await request('/api/bootstrap');
  assert.equal(cloud.storage.driver, 'oss');
  const form = new FormData(),
    text = `# Live cloud fixture\nVerification ${verificationId}\n`;
  form.append('file', new Blob([text], { type: 'text/markdown' }), 'live-cloud-fixture.md');
  const asset = await request('/api/assets', form);
  const bytes = await fetch(`${apiBase}/api/assets/${asset.id}/download`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then((r) => r.text());
  assert.equal(bytes, text);
  assert.equal(asset.sha256, createHash('sha256').update(text).digest('hex'));
  receipt.checks.ossUploadDownload = true;
  let project = (await request('/local/bootstrap')).projects[0];
  if (process.argv.includes('--imported')) {
    const folder = await mkdtemp(join(tmpdir(), 'lightmao-imported-live-'));
    await writeFile(
      join(folder, 'README.md'),
      '# Existing Godot project\nRead/write verification fixture.\n',
    );
    await writeFile(join(folder, 'project.godot'), 'config_version=5\n');
    const desktopKey = (await readFile(join(root, 'desktop-control.key'))).toString('hex');
    const grant = await request(
      '/local/project-grants',
      { directory: folder, access: 'write' },
      'POST',
      { 'X-Lightmao-Desktop-Key': desktopKey },
    );
    project = await request('/local/projects/import', {
      grantId: grant.grantId,
      name: 'Imported live game',
      description: 'Isolated real-provider verification fixture',
    });
    assert.equal(project.source, 'imported');
    assert.equal(project.access, 'write');
    receipt.checks.importedProjectGrant = true;
    receipt.projectRoot = project.root;
  }
  await request('/api/plugins/writer', { installed: true, enabled: true }, 'PATCH');
  if (process.argv.includes('--mcp')) {
    const key = (await readFile(join(root, 'desktop-control.key'))).toString('hex');
    const grant = await request(
      '/local/mcp-file-grants',
      { projectId: project.id, path: resolve('dist/plugins/game-assets.cjs') },
      'POST',
      { 'X-Lightmao-Desktop-Key': key },
    );
    const plugin = await request('/local/mcp-plugins', {
      projectId: project.id,
      name: '素材巡检 MCP',
      transport: 'stdio',
      access: 'read',
      domains: [],
      grantId: grant.grantId,
    });
    const probe = await request(`/local/mcp-plugins/${plugin.id}/probe`, {});
    assert.equal(probe.lastProbe.ok, true);
    await request(`/local/mcp-plugins/${plugin.id}/approve`, {
      catalogHash: probe.catalogHash,
      tools: ['game_asset_inventory'],
    });
    const health = await request('/local/health');
    assert.equal(health.sandbox.available, true);
    receipt.checks.osIsolation = true;
    receipt.mcpPlugin = { id: plugin.id, sha256: grant.sha256, tool: 'game_asset_inventory' };
  }
  const session = await request('/local/sessions', {
    projectId: project.id,
    title: '真实方舟工具联调',
  });
  const run = await request(`/local/sessions/${session.id}/runs`, {
    mode: 'ark',
    prompt:
      (process.argv.includes('--mcp')
        ? '请必须实际调用已授权的「素材巡检 MCP」game_asset_inventory 工具，path 填 "."，读取当前工程根目录素材清单。然后'
        : '') +
      '请先并发调用 list_files 和 inspect_project 检查当前游戏工程，然后读取 README.md，再创建 qa/live-check.gd，内容为 Godot 4 的最小 Node 脚本，在 _ready 中输出 LightMao live verified。写入后使用 read_file 回读确认。最后用中文汇总已验证的文件操作；不要声称执行过游戏引擎。',
    assetIds: [asset.id],
  });
  receipt.runId = run.id;
  console.log(JSON.stringify({ phase: 'agent-running', runId: run.id, model: receipt.model }));
  let finished;
  for (let i = 0; i < 720; i++) {
    finished = await request(`/local/runs/${run.id}`);
    if (finished.status !== 'running') break;
    await delay(250);
  }
  assert.equal(finished.status, 'completed', finished.error);
  const source = await readFile(join(project.root, 'qa/live-check.gd'), 'utf8');
  assert.match(source, /extends Node/);
  assert.match(source, /func _ready/);
  assert.match(source, /LightMao live verified/);
  const events = await request(`/local/runs/${run.id}/events`),
    completed = events.filter((e) => e.type === 'tool.finished' && !e.data.isError);
  assert(completed.some((e) => e.data.name === 'write_file'));
  assert(completed.some((e) => e.data.name === 'read_file'));
  receipt.checks.arkAuthenticatedAgent = true;
  if (process.argv.includes('--mcp')) {
    assert(
      completed.some(
        (event) => event.data.name.startsWith('mcp_') && event.data.detail.state === 'completed',
      ),
    );
    receipt.checks.realArkMcpTool = true;
  }
  receipt.checks.realProjectWriteRead = true;
  receipt.checks.toolArchive = completed.every((e) => !!e.data.detail?.id);
  if (process.argv.includes('--sessions')) {
    const firstView = await request(`/local/sessions/${session.id}`),
      point = firstView.messages.at(-1).id,
      canary = 'FUTURE_SESSION_CANARY_' + verificationId;
    const later = await request(`/local/sessions/${session.id}/runs`, {
      mode: 'ark',
      prompt: `仅记录这个后续轮次标记：${canary}。请只回复一句确认，不调用工具，不修改文件。`,
    });
    let laterDone;
    for (let i = 0; i < 720; i++) {
      laterDone = await request(`/local/runs/${later.id}`);
      if (laterDone.status !== 'running') break;
      await delay(250);
    }
    assert.equal(laterDone.status, 'completed', laterDone.error);
    const before = local.store.list('run', owner).length;
    const input = { messageId: point, title: '真实方舟 · 第一轮分支', requestId: randomUUID() };
    const branch = await request(`/local/sessions/${session.id}/fork`, input),
      retry = await request(`/local/sessions/${session.id}/fork`, input);
    assert.equal(branch.id, retry.id);
    assert.deepEqual(branch.messages, firstView.messages);
    assert.equal(branch.forkContext, 'recorded');
    assert.equal(local.store.list('run', owner).length, before);
    assert(
      !JSON.stringify(local.store.get('session', branch.id, owner).transcript).includes(canary),
    );
    await local.app.close();
    local = await createLocalAgent({ dataDir: root, apiUrl: apiBase, tickMs: 60000 });
    await local.app.listen({ host: '127.0.0.1', port: 0 });
    localBase = `http://127.0.0.1:${local.app.server.address().port}`;
    const restored = await request(`/local/sessions/${branch.id}`);
    assert.deepEqual(restored.messages, firstView.messages);
    const continued = await request(`/local/sessions/${branch.id}/runs`, {
      mode: 'ark',
      prompt:
        '必须调用 read_file 读取 qa/live-check.gd，以当前磁盘内容确认 _ready 中的输出。只检查，不修改文件，不执行引擎。',
    });
    let continuedDone;
    for (let i = 0; i < 720; i++) {
      continuedDone = await request(`/local/runs/${continued.id}`);
      if (continuedDone.status !== 'running') break;
      await delay(250);
    }
    assert.equal(continuedDone.status, 'completed', continuedDone.error);
    const branchEvents = await request(`/local/runs/${continued.id}/events`),
      tools = branchEvents.filter((event) => event.type === 'tool.finished');
    assert(tools.some((event) => event.data.name === 'read_file' && !event.data.isError));
    assert(!tools.some((event) => event.data.name === 'write_file'));
    assert.equal(
      (await request(`/local/sessions/${session.id}`)).messages.length,
      firstView.messages.length + 2,
    );
    receipt.checks.selectedRoundFork = true;
    receipt.checks.forkRetryIdempotent = true;
    receipt.checks.forkResumeAfterRestart = true;
    receipt.sessionFork = {
      sourceSession: session.id,
      firstRun: run.id,
      laterRun: later.id,
      branchSession: branch.id,
      continuedRun: continued.id,
      futureContextExcluded: true,
      toolCalls: tools.map((event) => event.data.name),
      answer: continuedDone.text,
    };
  }
  const overview = await request('/api/admin/overview');
  receipt.usage = overview.usage.map((u) => ({
    model: u.model,
    status: u.status,
    totalTokens: u.totalTokens,
    durationMs: u.durationMs,
  }));
  receipt.toolCalls = completed.map((e) => ({ name: e.data.name, ref: e.data.detail.id }));
  receipt.answer = finished.text;
} catch (error) {
  receipt.error = String(error.message).replaceAll(
    process.env.ARK_API_KEY || '__absent__',
    '[REDACTED]',
  );
  process.exitCode = 1;
} finally {
  if (owner && token) {
    const assets = api.assets.list(owner);
    let allRemoved = true;
    for (const asset of assets) {
      try {
        await request(`/api/assets/${asset.id}`, undefined, 'DELETE');
        await request(`/api/assets/${asset.id}/purge`, undefined, 'DELETE');
      } catch {
        allRemoved = false;
      }
    }
    receipt.cloudCleanup = allRemoved;
  }
  await local.app.close();
  await api.app.close();
  await mkdir('.lightmao/verification', { recursive: true });
  await writeFile(
    `.lightmao/verification/live-system-${verificationId}.json`,
    JSON.stringify(receipt, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(receipt));
}
