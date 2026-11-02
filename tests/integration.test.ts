import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { Agent, type AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { createApi } from '../apps/api/server.ts';
import { createLocalAgent } from '../apps/agent/server.ts';
import { demoStream, gatewayModel } from '../apps/agent/provider.ts';
import { readProjectFile, writeProjectFile, listFiles } from '../apps/agent/sandbox.ts';
import { nextOccurrence } from '../apps/agent/scheduler.ts';
import type {
  CloudBootstrap,
  LocalBootstrap,
  Session,
  Run,
  Schedule,
  RunEvent,
  User,
  Asset,
  ToolDetailPage,
  RunActivity,
} from '../packages/shared/types.ts';

test('file-tool boundary: traversal, symlink, secrets, bounded reads and serialized writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lightmao-sandbox-'));
  const project = join(root, 'project');
  await mkdir(project);
  try {
    await writeFile(join(root, 'outside.txt'), 'private');
    await writeFile(join(project, '.env'), 'secret');
    await mkdir(join(project, 'docs'));
    await writeFile(join(project, 'docs', 'password.md'), 'private test fixture');
    await symlink(join(root, 'outside.txt'), join(project, 'escape.txt'));
    await symlink(root, join(project, 'escape-dir'));
    for (const path of [
      '../outside.txt',
      '/etc/passwd',
      '.env',
      'docs/password.md',
      'escape.txt',
      'escape-dir/outside.txt',
    ])
      await assert.rejects(() => readProjectFile(project, path));
    await assert.rejects(() => writeProjectFile(project, 'escape-dir/stolen.txt', 'no'));
    await Promise.all([
      writeProjectFile(project, 'docs/test.md', 'one'),
      writeProjectFile(project, 'docs/test.md', 'two'),
    ]);
    assert.equal(await readProjectFile(project, 'docs/test.md'), 'two');
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        writeProjectFile(i % 2 ? `${project}/` : project, 'docs/ordered.md', String(i)),
      ),
    );
    assert.equal(await readProjectFile(project, 'docs/ordered.md'), '11');
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(() => writeProjectFile(project, 'cancelled.txt', 'no', abort.signal));
    await writeFile(join(project, 'huge.txt'), Buffer.alloc(128001));
    await assert.rejects(() => readProjectFile(project, 'huge.txt'));
    const names = (await listFiles(project)).map((f) => f.name);
    assert(!names.includes('.env'));
    assert(!names.includes('escape.txt'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('actual Pi Agent executes read-only tool calls concurrently', async () => {
  let active = 0,
    maxActive = 0;
  const tools: AgentTool[] = ['list_files', 'inspect_project'].map((name) => ({
    name,
    label: name,
    description: name,
    parameters: Type.Object({ path: Type.Optional(Type.String()) }),
    execute: async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(50);
      active--;
      return { content: [{ type: 'text', text: 'verified' }], details: {} };
    },
  }));
  const agent = new Agent({
    initialState: { systemPrompt: 'Test', model: gatewayModel('http://127.0.0.1'), tools },
    streamFn: demoStream([], []),
    toolExecution: 'parallel',
  });
  await agent.prompt('Read project');
  assert.equal(maxActive, 2);
  assert.equal(agent.state.messages.filter((m) => m.role === 'toolResult').length, 2);
});

test('scheduler uses explicit IANA timezone, interval and DST-aware daily times', () => {
  assert.equal(
    nextOccurrence(
      { frequency: 'daily', time: '09:00', intervalMinutes: 60, timezone: 'Asia/Shanghai' },
      new Date('2026-11-01T00:30:00Z'),
    ),
    '2026-11-01T01:00:00.000Z',
  );
  assert.equal(
    nextOccurrence(
      { frequency: 'interval', time: '09:00', intervalMinutes: 5, timezone: 'UTC' },
      new Date('2026-11-01T00:00:00Z'),
    ),
    '2026-11-01T00:05:00.000Z',
  );
  const n = nextOccurrence(
    { frequency: 'daily', time: '09:00', intervalMinutes: 60, timezone: 'America/New_York' },
    new Date('2026-11-01T00:00:00Z'),
  );
  assert.equal(n, '2026-11-01T14:00:00.000Z');
});

test('full service flow: auth, owners, resources, sessions, stop, fork, scheduling, restart, Ark proxy', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lightmao-services-'));
  let nativeCalls = 0;
  const longRequests: { messages: { role: string; content: unknown }[] }[] = [];
  const upstream = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-only-ark-key');
    let body = '';
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    assert.equal(data.model, 'test-endpoint');
    assert.equal(data.stream, true);
    nativeCalls++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (JSON.stringify(data.messages).includes('长结果压缩验证')) {
      longRequests.push(data);
      const hasResult = data.messages.some((m: { role: string }) => m.role === 'tool');
      const chunk = (delta: unknown, reason: string | null) =>
        `data: ${JSON.stringify({ id: 'test-large', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'test-endpoint', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
      res.write(
        chunk(
          hasResult
            ? { role: 'assistant', content: '检查完成，发现纹理校验失败；原文已保留。' }
            : {
                role: 'assistant',
                content: '正在读取长日志，完成后给出结论。',
                tool_calls: [
                  {
                    index: 0,
                    id: 'large-read',
                    type: 'function',
                    function: {
                      name: 'read_file',
                      arguments: JSON.stringify({ path: 'large-log.txt' }),
                    },
                  },
                ],
              },
          null,
        ),
      );
      res.write(chunk({}, hasResult ? 'stop' : 'tool_calls'));
      res.end('data: [DONE]\n\n');
      return;
    }
    if (JSON.stringify(data.messages).includes('模拟上游断流')) {
      res.end(
        `data: ${JSON.stringify({ id: 'test-cut', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'test-endpoint', choices: [{ index: 0, delta: { role: 'assistant', content: '不完整内容' }, finish_reason: null }] })}\n\n`,
      );
      return;
    }
    res.write(
      `data: ${JSON.stringify({ id: 'test-completion', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'test-endpoint', choices: [{ index: 0, delta: { role: 'assistant', content: '方舟协议替身已验证。' }, finish_reason: null }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ id: 'test-completion', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'test-endpoint', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } })}\n\n`,
    );
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamPort = (upstream.address() as { port: number }).port;
  const apiServer = await createApi({
    dataDir: root,
    demo: true,
    arkKey: 'test-only-ark-key',
    arkBase: `http://127.0.0.1:${upstreamPort}`,
    modelId: 'test-endpoint',
  });
  await apiServer.app.listen({ port: 0, host: '127.0.0.1' });
  const apiBase = `http://127.0.0.1:${(apiServer.app.server.address() as { port: number }).port}`;
  let local = await createLocalAgent({ dataDir: root, apiUrl: apiBase, tickMs: 60000 });
  await local.app.listen({ port: 0, host: '127.0.0.1' });
  let localBase = `http://127.0.0.1:${(local.app.server.address() as { port: number }).port}`;
  const request = async <T>(
    path: string,
    token = '',
    body?: unknown,
    method?: string,
  ): Promise<T> => {
    const response = await fetch(`${path.startsWith('/local/') ? localBase : apiBase}${path}`, {
      method: method || (body ? 'POST' : 'GET'),
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? (body instanceof FormData ? body : JSON.stringify(body)) : undefined,
    });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error), { status: response.status });
    return result as T;
  };
  const waitRun = async (id: string, token: string) => {
    for (let i = 0; i < 120; i++) {
      const r = await request<Run>(`/local/runs/${id}`, token);
      if (r.status !== 'running') return r;
      await delay(50);
    }
    throw new Error('Run did not settle');
  };
  try {
    const admin = await request<{ token: string; user: User }>('/api/auth/demo', '', {});
    const member = await request<{ token: string; user: User }>('/api/auth/register', '', {
      name: '测试成员',
      email: 'member@example.test',
      password: 'test-password-1234',
    });
    await t.test('authentication and administrator boundaries', async () => {
      await assert.rejects(() => request('/api/bootstrap'), { status: 401 });
      await assert.rejects(() => request('/api/admin/overview', member.token), { status: 403 });
      const login = await request<{ user: User }>('/api/auth/login', '', {
        email: 'member@example.test',
        password: 'test-password-1234',
      });
      assert.equal(login.user.id, member.user.id);
      await assert.rejects(
        () => request('/api/auth/login', '', { email: 'member@example.test', password: 'wrong' }),
        { status: 401 },
      );
    });
    const bootstrap = await request<LocalBootstrap>('/local/bootstrap', admin.token);
    const project = bootstrap.projects[0];
    const cloud = await request<CloudBootstrap>('/api/bootstrap', admin.token);
    await t.test('assets round-trip and owner isolation', async () => {
      const form = new FormData();
      form.append(
        'file',
        new Blob(['# 文档\n真实上传内容'], { type: 'text/markdown' }),
        'design.md',
      );
      const asset = await request<Asset>('/api/assets', admin.token, form);
      const download = await fetch(`${apiBase}/api/assets/${asset.id}/download`, {
        headers: { Authorization: `Bearer ${admin.token}` },
      });
      assert.equal(await download.text(), '# 文档\n真实上传内容');
      await assert.rejects(() => request(`/api/assets/${asset.id}/preview`, member.token), {
        status: 404,
      });
      await assert.rejects(() => request(`/local/projects/${project.id}/files`, member.token), {
        status: 404,
      });
      await assert.rejects(() =>
        request(`/local/projects/${project.id}/file?path=..%2Foutside`, admin.token),
      );
      assert.equal(
        (await request<{ text: string }>(`/api/assets/${asset.id}/preview`, admin.token)).text,
        '# 文档\n真实上传内容',
      );
      await request(`/api/assets/${asset.id}`, admin.token, undefined, 'DELETE');
    });
    let session = await request<Session>('/local/sessions', admin.token, {
      projectId: project.id,
      title: '集成验证',
    });
    await t.test('Pi runtime, selected skill and durable events', async () => {
      const run = await request<Run>(`/local/sessions/${session.id}/runs`, admin.token, {
        prompt: '检查项目结构',
        mode: 'demo',
        skillIds: [cloud.skills[0].id],
      });
      const r = await waitRun(run.id, admin.token);
      assert.equal(r.status, 'completed', r.error);
      assert(r.text.includes('项目上下文已就绪'));
      const stream = await fetch(`${localBase}/local/runs/${run.id}/stream`, {
        headers: { Authorization: `Bearer ${admin.token}` },
      });
      const text = await stream.text();
      assert(text.includes('tool.started'));
      assert(text.includes('run.finished'));
      const events = await request<RunEvent[]>(`/local/runs/${run.id}/events`, admin.token);
      assert(
        events.some(
          (e) =>
            e.type === 'context.loaded' &&
            (e.data.skills as string[]).includes(cloud.skills[0].name),
        ),
      );
      session = await request<Session>(`/local/sessions/${session.id}`, admin.token);
      assert.equal(session.messages.length, 2);
    });
    await t.test(
      'fork creates independent history; disabled plugin removes its tools',
      async () => {
        const fork = await request<Session>(`/local/sessions/${session.id}/fork`, admin.token, {});
        assert.equal(fork.parentId, session.id);
        assert.deepEqual(fork.messages, session.messages);
        await request('/api/plugins/workspace', admin.token, { enabled: false }, 'PATCH');
        const run = await request<Run>(`/local/sessions/${fork.id}/runs`, admin.token, {
          prompt: '再次检查',
          mode: 'demo',
        });
        assert.equal((await waitRun(run.id, admin.token)).status, 'completed');
        const events = await request<RunEvent[]>(`/local/runs/${run.id}/events`, admin.token);
        assert(!events.some((e) => e.type === 'tool.started' && e.data.name === 'list_files'));
        assert.equal(
          (await request<Session>(`/local/sessions/${session.id}`, admin.token)).messages.length,
          2,
        );
        assert.equal(
          (await request<Session>(`/local/sessions/${fork.id}`, admin.token)).messages.length,
          4,
        );
        await request('/api/plugins/workspace', admin.token, { enabled: true }, 'PATCH');
      },
    );
    await t.test('cancel settles run and prevents overlapping requests', async () => {
      const run = await request<Run>(`/local/sessions/${session.id}/runs`, admin.token, {
        prompt: '运行然后停止',
        mode: 'demo',
      });
      await assert.rejects(
        () =>
          request(`/local/sessions/${session.id}/runs`, admin.token, {
            prompt: '不应重入',
            mode: 'demo',
          }),
        { status: 409 },
      );
      await request(`/local/runs/${run.id}/stop`, admin.token, {});
      assert.equal((await waitRun(run.id, admin.token)).status, 'cancelled');
    });
    await t.test('due task executes once and records its session', async () => {
      const task = await request<Schedule>('/local/schedules', admin.token, {
        name: '检查',
        prompt: '检查项目',
        projectId: project.id,
        frequency: 'interval',
        time: '09:00',
        intervalMinutes: 60,
        timezone: 'Asia/Shanghai',
        mode: 'demo',
        enabled: true,
      });
      const owned = local.store.get<Schedule & { ownerId: string }>(
        'schedule',
        task.id,
        admin.user.id,
      )!;
      local.store.put('schedule', admin.user.id, {
        ...owned,
        nextRunAt: new Date(0).toISOString(),
      });
      await Promise.all([local.tick(), local.tick()]);
      const runs = local.store.list<Run>('run', admin.user.id).filter((r) => r.taskId === task.id);
      assert.equal(runs.length, 1);
      assert.equal((await waitRun(runs[0].id, admin.token)).status, 'completed');
      const saved = local.store.get<Schedule>('schedule', task.id, admin.user.id)!;
      assert.equal(saved.lastStatus, 'completed');
      assert(saved.lastSessionId);
      assert(Date.parse(saved.nextRunAt) > Date.now());
      await request(`/local/schedules/${task.id}`, admin.token, { enabled: false }, 'PATCH');
    });
    await t.test(
      'live provider adapter uses authenticated backend proxy (mock upstream)',
      async () => {
        const s = await request<Session>('/local/sessions', admin.token, { projectId: project.id });
        const run = await request<Run>(`/local/sessions/${s.id}/runs`, admin.token, {
          prompt: '协议验证',
          mode: 'ark',
        });
        const r = await waitRun(run.id, admin.token);
        assert.equal(r.status, 'completed', r.error);
        assert.match(r.text, /方舟协议替身已验证/);
        assert.equal(nativeCalls, 1);
        const overview = await request<{ usage: { totalTokens?: number }[] }>(
          '/api/admin/overview',
          admin.token,
        );
        assert.equal(overview.usage[0].totalTokens, 10);
        await assert.rejects(
          () =>
            request('/api/v1/chat/completions', member.token, {
              model: 'arbitrary',
              messages: [{ role: 'user', content: 'no' }],
            }),
          { status: 400 },
        );
      },
    );
    await t.test('truncated upstream stream is marked failed rather than completed', async () => {
      const response = await fetch(`${apiBase}/api/v1/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'doubao',
          messages: [{ role: 'user', content: '模拟上游断流' }],
          stream: true,
        }),
      });
      await response.text().catch(() => undefined);
      const overview = await request<{ usage: { status: string }[] }>(
        '/api/admin/overview',
        admin.token,
      );
      assert.equal(overview.usage[0].status, 'failed');
    });
    let archivedRef = '';
    await t.test(
      'large tools are reduced before real Pi gateway requests; trace, final answer and raw archive stay separate',
      async () => {
        const text = `${'render log asset loaded\n'.repeat(1800)}ERROR: texture failed validation\nMIDDLE_ONLY_EVIDENCE_987\n${'render log asset loaded\n'.repeat(1800)}`;
        await writeFile(join(project.root, 'large-log.txt'), text);
        const s = await request<Session>('/local/sessions', admin.token, { projectId: project.id });
        const run = await request<Run>(`/local/sessions/${s.id}/runs`, admin.token, {
          prompt: '长结果压缩验证',
          mode: 'ark',
        });
        const finished = await waitRun(run.id, admin.token);
        assert.equal(finished.status, 'completed', finished.error);
        assert.equal(longRequests.length, 2);
        const sent = JSON.stringify(longRequests[1].messages);
        assert(sent.length < 10000, `provider received ${sent.length} chars`);
        assert(!sent.includes('MIDDLE_ONLY_EVIDENCE_987'));
        assert(
          sent.includes('ERROR: texture failed validation'),
          JSON.stringify(longRequests[1].messages.filter((message) => message.role === 'tool')),
        );
        assert(sent.includes('详情引用'));
        assert.equal(finished.text, '检查完成，发现纹理校验失败；原文已保留。');
        const events = await request<RunEvent[]>(`/local/runs/${run.id}/events`, admin.token);
        assert(
          events.some(
            (e) => e.type === 'progress.message' && String(e.data.text).includes('正在读取长日志'),
          ),
        );
        assert(!JSON.stringify(events).includes('MIDDLE_ONLY_EVIDENCE_987'));
        const tool = events.find((e) => e.type === 'tool.finished')!;
        archivedRef = (tool.data.detail as { id: string }).id;
        const page = await request<ToolDetailPage>(
          `/local/tool-results/${archivedRef}?query=MIDDLE_ONLY_EVIDENCE_987&limit=1000`,
          admin.token,
        );
        assert(page.text.includes('MIDDLE_ONLY_EVIDENCE_987'));
        assert(page.text.length <= 1000);
        assert(finished.toolContext!.retainedChars < finished.toolContext!.originalChars / 10);
        const activity = await request<RunActivity[]>(
          `/local/sessions/${s.id}/activity`,
          admin.token,
        );
        assert.equal(activity[0].toolCount, 1);
        assert(!('text' in activity[0]) && !('prompt' in activity[0]));
        await assert.rejects(() => request(`/local/tool-results/${archivedRef}`, member.token), {
          status: 404,
        });
        await assert.rejects(
          () => request(`/local/tool-results/${archivedRef}?limit=999999`, admin.token),
          { status: 400 },
        );
        const fork = await request<Session>(`/local/sessions/${s.id}/fork`, admin.token, {});
        const inherited = await request<RunActivity[]>(
          `/local/sessions/${fork.id}/activity`,
          admin.token,
        );
        assert.equal(inherited[0].id, run.id);
        const continuation = await request<Run>(`/local/sessions/${fork.id}/runs`, admin.token, {
          prompt: '继续分析原始证据',
          mode: 'ark',
        });
        assert.equal((await waitRun(continuation.id, admin.token)).status, 'completed');
        assert.equal(longRequests.length, 3);
        assert(!JSON.stringify(longRequests[2].messages).includes('MIDDLE_ONLY_EVIDENCE_987'));
      },
    );
    await t.test('durable history and interrupted-run recovery after daemon restart', async () => {
      const before = await request<Session>(`/local/sessions/${session.id}`, admin.token);
      const interruptedId = 'restart-test';
      local.store.put('run', admin.user.id, {
        id: interruptedId,
        ownerId: admin.user.id,
        sessionId: session.id,
        projectId: project.id,
        status: 'running',
        mode: 'demo',
        prompt: 'interrupted',
        startedAt: new Date().toISOString(),
        text: '',
      });
      const stored = local.store.get<Session>('session', session.id, admin.user.id)!;
      local.store.put('session', admin.user.id, {
        ...stored,
        activeRunId: interruptedId,
        status: 'running',
      });
      await local.app.close();
      local = await createLocalAgent({ dataDir: root, apiUrl: apiBase, tickMs: 60000 });
      await local.app.listen({ port: 0, host: '127.0.0.1' });
      localBase = `http://127.0.0.1:${(local.app.server.address() as { port: number }).port}`;
      const after = await request<Session>(`/local/sessions/${session.id}`, admin.token);
      const recoveredPage = await request<ToolDetailPage>(
        `/local/tool-results/${archivedRef}?query=MIDDLE_ONLY_EVIDENCE_987`,
        admin.token,
      );
      assert(recoveredPage.text.includes('MIDDLE_ONLY_EVIDENCE_987'));
      assert.deepEqual(after.messages.slice(0, before.messages.length), before.messages);
      assert.deepEqual(
        after.messages.slice(-2).map((message) => ({ role: message.role, runId: message.runId })),
        [
          { role: 'user', runId: interruptedId },
          { role: 'assistant', runId: interruptedId },
        ],
      );
      assert.match(after.messages.at(-1)!.text, /运行已中断/);
      assert.equal(after.status, 'interrupted');
      assert.equal(after.activeRunId, undefined);
      assert.equal(
        (await request<Run>(`/local/runs/${interruptedId}`, admin.token)).status,
        'interrupted',
      );
      const run = await request<Run>(`/local/sessions/${session.id}/runs`, admin.token, {
        prompt: '从保留的上下文继续检查',
        mode: 'demo',
      });
      assert.equal((await waitRun(run.id, admin.token)).status, 'completed');
    });
    await t.test('disabled users and revoked tokens take effect immediately', async () => {
      await request(
        `/api/admin/users/${member.user.id}`,
        admin.token,
        { status: 'disabled' },
        'PATCH',
      );
      await assert.rejects(() => request('/api/me', member.token), { status: 403 });
      await assert.rejects(() => request('/local/bootstrap', member.token), { status: 403 });
      await request('/api/logout', admin.token, {});
      await assert.rejects(() => request('/api/me', admin.token), { status: 401 });
    });
  } finally {
    await local.app.close();
    await apiServer.app.close();
    await new Promise<void>((r) => upstream.close(() => r()));
    await rm(root, { recursive: true, force: true });
  }
});
