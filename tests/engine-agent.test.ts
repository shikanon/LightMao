import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, cp, rm, access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createApi } from '../apps/api/server.ts';
import { createLocalAgent } from '../apps/agent/server.ts';
import type { Project, EngineGrant, EngineJob, Run, Session } from '../packages/shared/types.ts';
const godotPath =
  process.env.LIGHTMAO_TEST_GODOT_PATH || resolve('.lightmao/tools/godot/4.7.2/Godot.app');
let available = process.platform === 'darwin';
try {
  await access(godotPath);
} catch {
  available = false;
}

test(
  'actual Pi loop executes real Godot behind the authenticated model gateway, reads scoped logs, and keeps execution folded data separate',
  { skip: !available, timeout: 45000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'lm-engine-pi-'));
    const observed: { toolNames: string[]; hasEngineResult: boolean; hasLogEvidence: boolean }[] =
      [];
    const upstream = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          tools?: { function: { name: string } }[];
          messages: { role: string; content?: string }[];
        };
        const results = body.messages.filter((message) => message.role === 'tool');
        const toolNames = (body.tools || []).map((tool) => tool.function.name);
        observed.push({
          toolNames,
          hasEngineResult: results.some((message) => message.content?.includes('tests_passed')),
          hasLogEvidence: results.some((message) => message.content?.includes('LIGHTMAO_TESTS')),
        });
        const tool = results.length === 0 ? 'run_godot' : 'read_engine_log';
        const jobId = results.length
          ? results[0].content?.match(/"logRef"\s*:\s*"([a-f0-9-]{36})"/)?.[1]
          : undefined;
        if (results.length === 1 && !jobId)
          throw new Error('Compressed engine output lost the precise log reference');
        const delta =
          results.length >= 2 || !toolNames.includes('run_godot')
            ? {
                role: 'assistant',
                content: toolNames.includes('run_godot')
                  ? 'ENGINE_PI_VERIFIED: 已读取实际引擎报告与日志。'
                  : 'ENGINE_NOT_AUTHORIZED: 本轮未授予引擎工具。',
              }
            : {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: `engine-call-${results.length}`,
                    type: 'function',
                    function: {
                      name: tool,
                      arguments: JSON.stringify(
                        tool === 'run_godot'
                          ? { action: 'script', script: 'tests/smoke.gd' }
                          : { jobId, offset: 0, limit: 4000 },
                      ),
                    },
                  },
                ],
              };
        const chunk = (delta: unknown, reason: string | null) =>
          `data: ${JSON.stringify({ id: 'engine-protocol-fixture', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'engine-fixture', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(chunk(delta, null));
        res.write(chunk({}, 'tool_calls' in delta ? 'tool_calls' : 'stop'));
        res.end('data: [DONE]\n\n');
      })().catch((error) => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: { message: error.message } }));
      });
    });
    await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
    const api = await createApi({
      dataDir: root,
      demo: true,
      arkKey: 'engine-protocol-fixture-key',
      arkBase: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
      modelId: 'engine-fixture',
    });
    await api.app.listen({ host: '127.0.0.1', port: 0 });
    const local = await createLocalAgent({
      dataDir: root,
      apiUrl: `http://127.0.0.1:${(api.app.server.address() as { port: number }).port}`,
      godotPath,
    });
    const login = (
      await api.app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} })
    ).json<{ token: string; user: { id: string } }>();
    async function good<T>(path: string, payload?: unknown, method?: 'POST' | 'PATCH') {
      const response = await (path.startsWith('/api/') ? api.app : local.app).inject({
        method: method || (payload ? 'POST' : 'GET'),
        url: path,
        headers: { authorization: `Bearer ${login.token}` },
        ...(payload ? { payload } : {}),
      });
      assert(response.statusCode < 300, response.body);
      return response.json<T>();
    }
    async function run(session: Session) {
      const initial = await good<Run>(`/local/sessions/${session.id}/runs`, {
        mode: 'ark',
        prompt: '请在 Godot 中运行 tests/smoke.gd，读取实际日志，区分项目断言与玩家体验验收。',
      });
      for (let count = 0; count < 600; count++) {
        const value = local.store.get<Run>('run', initial.id, login.user.id)!;
        if (value.status !== 'running') return value;
        await delay(30);
      }
      throw new Error('Engine Pi run did not settle');
    }
    try {
      const project = await good<Project>('/local/projects', {
        name: 'Engine Pi fixture',
        engine: 'Godot',
        description: 'Actual Pi and actual engine, protocol model fixture',
      });
      await cp(resolve('examples/godot-startrail'), project.root, { recursive: true });
      await good('/api/plugins/godot', { installed: true, enabled: true }, 'PATCH');
      const grant = await good<EngineGrant>(`/local/projects/${project.id}/engine/prepare`, {});
      await good(`/local/projects/${project.id}/engine`, { grantId: grant.grantId });
      const session = await good<Session>('/local/sessions', {
        projectId: project.id,
        title: 'Engine Pi',
      });
      const final = await run(session);
      assert.equal(final.status, 'completed', JSON.stringify(final));
      assert.equal(final.toolErrorCount, 0);
      assert(final.text.includes('ENGINE_PI_VERIFIED'));
      const jobs = local.store
        .list<EngineJob>('engine-job', login.user.id)
        .filter((job) => job.runId === final.id);
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0].verification, 'tests_passed');
      assert.equal(observed.length, 3);
      assert.equal(observed[0].hasLogEvidence, false);
      assert.equal(observed[2].hasLogEvidence, true);
      const details = local.store
        .list<{ name: string; runId: string; state: string }>('tool-detail', login.user.id)
        .filter((value) => value.runId === final.id);
      assert.deepEqual(
        details.map((value) => value.name),
        ['run_godot', 'read_engine_log'],
      );
      assert(details.every((value) => value.state === 'completed'));
      assert.throws(
        () => local.engines.logs(login.user.id, jobs[0].id, {}, new Set(['unrelated-run'])),
        { statusCode: 403 },
      );
      const context = local.store.get<Session>('session', session.id, login.user.id)!;
      assert(!context.messages.some((message) => message.text.includes('first_scan_filesystem')));
      assert(context.messages.at(-1)!.text.includes('ENGINE_PI_VERIFIED'));
      const files = await readFile(join(project.root, 'tests/smoke.gd'), 'utf8');
      assert(files.includes('initial stars'));
      await good('/api/plugins/godot', { enabled: false }, 'PATCH');
      const fresh = await good<Session>('/local/sessions', {
        projectId: project.id,
        title: 'No engine permission',
      });
      const blocked = await run(fresh);
      assert.equal(blocked.status, 'completed');
      assert(blocked.text.includes('ENGINE_NOT_AUTHORIZED'));
      assert.equal(local.store.list('engine-job', login.user.id).length, 1);
      assert(!observed.at(-1)!.toolNames.includes('run_godot'));
    } finally {
      await local.app.close();
      api.app.server.closeAllConnections();
      await api.app.close();
      upstream.closeAllConnections();
      await new Promise<void>((done) => upstream.close(() => done()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
