import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { createApi } from '../apps/api/server.ts';
import { createLocalAgent } from '../apps/agent/server.ts';
import type {
  Session,
  SessionView,
  SessionPage,
  LocalBootstrap,
  Run,
} from '../packages/shared/types.ts';

test('selected-round forks preserve immutable model context, lineage and receipts across concurrent runs and restart; history remains owner scoped', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'lightmao-sessions-'));
  const requests: Record<string, unknown>[] = [];
  let releaseHold: () => void = () => {},
    held = false;
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    const messages = body.messages as { role: string; content: unknown }[],
      last = messages.findLastIndex((m) => m.role === 'user'),
      prompt = JSON.stringify(messages[last]?.content);
    if (prompt.includes('HOLD_REQUEST')) {
      held = true;
      await new Promise<void>((resolve) => {
        releaseHold = resolve;
        res.once('close', resolve);
      });
      if (res.destroyed) return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const phase = prompt.includes('BRANCH_REQUEST')
      ? 'branch'
      : prompt.includes('FUTURE_REQUEST')
        ? 'future'
        : 'first';
    const hasResult = messages.slice(last + 1).some((m) => m.role === 'tool');
    const chunk = (delta: unknown, finish: string | null) =>
      `data: ${JSON.stringify({ id: 'session-fixture', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'test-endpoint', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const args =
      phase === 'branch'
        ? { query: '' }
        : {
            path: 'state.txt',
            content: phase === 'first' ? 'FIRST_TOOL_BODY' : 'FUTURE_TOOL_BODY',
          };
    res.write(
      chunk(
        hasResult
          ? {
              role: 'assistant',
              content:
                phase === 'first'
                  ? 'FIRST_REPLY'
                  : phase === 'future'
                    ? 'FUTURE_REPLY'
                    : 'BRANCH_REPLY',
            }
          : {
              role: 'assistant',
              content: '正在处理。',
              tool_calls: [
                {
                  index: 0,
                  id: 'reused-call',
                  type: 'function',
                  function: {
                    name: phase === 'branch' ? 'read_tool_result' : 'write_file',
                    arguments: JSON.stringify(args),
                  },
                },
              ],
            },
        null,
      ),
    );
    res.write(chunk({}, hasResult ? 'stop' : 'tool_calls'));
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const api = await createApi({
    dataDir: dir,
    demo: true,
    arkKey: 'test-session-key',
    arkBase: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
    modelId: 'test-endpoint',
  });
  await api.app.listen({ host: '127.0.0.1', port: 0 });
  const apiBase = `http://127.0.0.1:${(api.app.server.address() as { port: number }).port}`;
  let local = await createLocalAgent({ dataDir: dir, apiUrl: apiBase, tickMs: 3600000 });
  const login = (
    await api.app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} })
  ).json<{ token: string; user: { id: string } }>();
  const other = (
    await api.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        name: 'Other',
        email: 'session-other@example.test',
        password: 'sessions-fixture-2026',
      },
    })
  ).json<{ token: string; user: { id: string } }>();
  async function call(
    path: string,
    body?: unknown,
    method?: 'POST' | 'PATCH',
    token = login.token,
  ) {
    return local.app.inject({
      method: method || (body ? 'POST' : 'GET'),
      url: path,
      headers: { authorization: `Bearer ${token}` },
      ...(body ? { payload: body } : {}),
    });
  }
  async function good<T>(path: string, body?: unknown, method?: 'POST' | 'PATCH') {
    const r = await call(path, body, method);
    assert(r.statusCode < 300, r.body);
    return r.json<T>();
  }
  async function wait(id: string) {
    for (let i = 0; i < 200; i++) {
      const run = await good<Run>(`/local/runs/${id}`);
      if (run.status !== 'running') return run;
      await delay(15);
    }
    throw Error('Run did not settle');
  }
  try {
    const bootstrap = await good<LocalBootstrap>('/local/bootstrap'),
      project = bootstrap.projects[0];
    await api.app.inject({
      method: 'PATCH',
      url: '/api/plugins/writer',
      headers: { authorization: `Bearer ${login.token}` },
      payload: { installed: true, enabled: true },
    });
    const source = await good<SessionView>('/local/sessions', {
      projectId: project.id,
      title: '保存分支边界',
    });
    const first = await good<Run>(`/local/sessions/${source.id}/runs`, {
      mode: 'ark',
      prompt: 'FIRST_REQUEST 请创建 state.txt，内容 FIRST_TOOL_BODY。',
    });
    assert.equal((await wait(first.id)).status, 'completed');
    const firstView = await good<SessionView>(`/local/sessions/${source.id}`),
      point = firstView.messages.at(-1)!.id;
    const form = new FormData();
    form.append(
      'file',
      new Blob(['FUTURE_REFERENCE_ONLY'], { type: 'text/plain' }),
      'later-reference.txt',
    );
    const asset = (await fetch(apiBase + '/api/assets', {
      method: 'POST',
      headers: { Authorization: `Bearer ${login.token}` },
      body: form,
    }).then((response) => response.json())) as { id: string };
    assert(asset.id);
    const future = await good<Run>(`/local/sessions/${source.id}/runs`, {
      mode: 'ark',
      prompt: 'FUTURE_REQUEST 请修改 state.txt，内容 FUTURE_TOOL_BODY。',
      assetIds: [asset.id],
    });
    assert.equal((await wait(future.id)).status, 'completed');
    assert(
      JSON.stringify(
        local.store.get<Session>('session', source.id, login.user.id)!.transcript,
      ).includes('FUTURE_REFERENCE_ONLY'),
    );
    const secondView = await good<SessionView>(`/local/sessions/${source.id}`);
    let branch: SessionView;
    await t.test(
      'fork at an earlier final reply excludes later messages and selected context without rerunning files or tools',
      async () => {
        const tools = local.store.list('tool-detail', login.user.id).length,
          runs = local.store.list('run', login.user.id).length;
        const request = { messageId: point, title: '第一轮 · 独立分支', requestId: randomUUID() };
        branch = await good<SessionView>(`/local/sessions/${source.id}/fork`, request);
        assert.equal(
          (await good<SessionView>(`/local/sessions/${source.id}/fork`, request)).id,
          branch.id,
          'retrying a fork request returns the same branch',
        );
        assert.equal(
          (
            await call(`/local/sessions/${source.id}/fork`, {
              ...request,
              title: 'different operation',
            })
          ).statusCode,
          409,
        );
        assert.deepEqual(branch.messages, firstView.messages);
        assert.equal(branch.parentId, source.id);
        assert.equal(branch.forkPoint, point);
        assert.equal(branch.forkContext, 'recorded');
        assert.equal(branch.activeRunId, undefined);
        assert.equal(local.store.list('run', login.user.id).length, runs);
        assert.equal(local.store.list('tool-detail', login.user.id).length, tools);
        assert.equal(
          await readFile(join(project.root, 'state.txt'), 'utf8'),
          'FUTURE_TOOL_BODY',
          'forking a conversation does not roll back project files',
        );
        const stored = local.store.get<Session>('session', branch.id, login.user.id)!;
        assert(JSON.stringify(stored.transcript).includes('FIRST_REPLY'));
        assert(!JSON.stringify(stored.transcript).includes('FUTURE_'));
        const checkpoints = local.store
          .list<{ id: string; refs: string[] }>('session-checkpoint', login.user.id)
          .filter((c) => [first.id, future.id].includes(c.id));
        assert.equal(checkpoints.length, 2);
        assert(
          local.store.list('session-context', login.user.id).length <
            checkpoints.reduce((n, c) => n + c.refs.length, 0),
          'unchanged model messages are deduplicated',
        );
        const next = await good<Run>(`/local/sessions/${branch.id}/runs`, {
          mode: 'ark',
          prompt: 'BRANCH_REQUEST 请回读此会话可见的执行索引，不改动文件。',
        });
        assert.equal((await wait(next.id)).status, 'completed');
        const branchRequests = requests.filter((r) =>
          JSON.stringify((r.messages as unknown[]).at(-1)).includes('BRANCH_REQUEST'),
        );
        assert(branchRequests.length > 0);
        assert(!JSON.stringify(branchRequests[0].messages).includes('FUTURE_'));
        const storedBranch = local.store.get<Session>('session', branch.id, login.user.id)!;
        assert(
          !JSON.stringify(storedBranch.transcript).includes(future.id),
          'default archive search cannot pull in later parent runs',
        );
        assert.deepEqual(
          (await good<SessionView>(`/local/sessions/${source.id}`)).messages,
          secondView.messages,
        );
      },
    );
    await t.test(
      'parent can keep running while an older completed turn forks; mutations and latest-only forks refuse busy sessions',
      async () => {
        const run = await good<Run>(`/local/sessions/${source.id}/runs`, {
          mode: 'ark',
          prompt: 'HOLD_REQUEST 等待执行。',
        });
        for (let i = 0; i < 100 && !held; i++) await delay(10);
        assert(held);
        assert.equal((await call(`/local/sessions/${source.id}/fork`, {})).statusCode, 409);
        for (const payload of [{ title: 'busy rename' }, { pinned: true }, { archived: true }])
          assert.equal(
            (await call(`/local/sessions/${source.id}`, payload, 'PATCH')).statusCode,
            409,
          );
        const copy = await good<SessionView>(`/local/sessions/${source.id}/fork`, {
          messageId: point,
        });
        assert.equal(copy.messages.length, 2);
        assert.equal(copy.activeRunId, undefined);
        await good(`/local/runs/${run.id}/stop`, {});
        releaseHold();
        assert.equal((await wait(run.id)).status, 'cancelled');
      },
    );
    await t.test(
      'invalid points, another owner and corrupt checkpoint blobs never create a branch',
      async () => {
        const before = local.store.list('session', login.user.id).length;
        assert.equal(
          (await call(`/local/sessions/${source.id}/fork`, { messageId: firstView.messages[0].id }))
            .statusCode,
          400,
        );
        assert.equal(
          (await call(`/local/sessions/${source.id}/fork`, { messageId: 'missing' })).statusCode,
          404,
        );
        assert.equal(
          (
            await call(
              `/local/sessions/${source.id}/fork`,
              { messageId: point },
              'POST',
              other.token,
            )
          ).statusCode,
          404,
        );
        const checkpoint = local.store.get<{ id: string; refs: string[] }>(
          'session-checkpoint',
          first.id,
          login.user.id,
        )!;
        const blob = local.store.get<{ id: string; message: unknown }>(
          'session-context',
          checkpoint.refs[0],
          login.user.id,
        )!;
        local.store.put('session-context', login.user.id, {
          ...blob,
          message: { role: 'user', content: 'tampered' },
        });
        assert.equal(
          (await call(`/local/sessions/${source.id}/fork`, { messageId: point })).statusCode,
          409,
        );
        local.store.put('session-context', login.user.id, blob);
        assert.equal(local.store.list('session', login.user.id).length, before);
      },
    );
    await t.test(
      'legacy round migration checks prompt boundaries and omits future archive entries',
      async () => {
        local.store.remove('session-checkpoint', first.id, login.user.id);
        const restored = await good<SessionView>(`/local/sessions/${source.id}/fork`, {
          messageId: point,
        });
        assert.equal(restored.forkContext, 'reconstructed');
        assert(
          !JSON.stringify(
            local.store.get<Session>('session', restored.id, login.user.id)!.transcript,
          ).includes('FUTURE_'),
        );
        local.store.remove('session-checkpoint', first.id, login.user.id);
        const original = local.store.get<Session>('session', source.id, login.user.id)!;
        local.store.put('session', login.user.id, {
          ...original,
          transcript: original.transcript.filter((m) => (m as { role: string }).role !== 'system'),
        });
        assert.equal(
          (await call(`/local/sessions/${source.id}/fork`, { messageId: point })).statusCode,
          409,
        );
        local.store.put('session', login.user.id, original);
      },
    );
    await t.test(
      'search, signed pagination, pinning, archive and restore preserve history and never resume automatically',
      async () => {
        const named = await good<SessionView>(
          `/local/sessions/${branch.id}`,
          { title: '百分比_100% · 历史', pinned: true },
          'PATCH',
        );
        assert.equal(named.pinned, true);
        const search = await good<SessionPage>(
          '/local/sessions?query=' + encodeURIComponent('_100%'),
        );
        assert.deepEqual(
          search.items.map((s) => s.id),
          [branch.id],
        );
        assert(!Object.hasOwn(search.items[0], 'messages'));
        const byText = await good<SessionPage>('/local/sessions?query=FIRST_REQUEST');
        assert(byText.total > 1);
        assert(byText.items.every((item) => item.preview.includes('FIRST_REQUEST')));
        const firstPage = await good<SessionPage>('/local/sessions?limit=1');
        assert.equal(firstPage.items[0].id, branch.id);
        assert(firstPage.nextCursor);
        assert.equal(
          (
            await call(
              '/local/sessions?state=archived&cursor=' + encodeURIComponent(firstPage.nextCursor!),
            )
          ).statusCode,
          400,
        );
        const ids: string[] = [];
        let cursor: string | null = null;
        do {
          const page: SessionPage = await good<SessionPage>(
            '/local/sessions?limit=1' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
          );
          ids.push(...page.items.map((item) => item.id));
          cursor = page.nextCursor;
        } while (cursor);
        assert.equal(new Set(ids).size, firstPage.total);
        assert.equal(ids.length, firstPage.total);
        const archived = await good<SessionView>(
          `/local/sessions/${branch.id}`,
          { archived: true },
          'PATCH',
        );
        assert(archived.archivedAt);
        assert.equal(
          (
            await call(`/local/sessions/${branch.id}/runs`, {
              mode: 'demo',
              prompt: 'must not run',
            })
          ).statusCode,
          409,
        );
        assert(
          (await good<SessionPage>('/local/sessions?state=archived')).items.some(
            (s) => s.id === branch.id,
          ),
        );
        const ownSelected = await good<LocalBootstrap>('/local/bootstrap?sessionId=' + branch.id);
        assert(ownSelected.sessions.some((s) => s.id === branch.id && s.archivedAt));
        assert(
          ownSelected.sessions.every(
            (s) => !Object.hasOwn(s, 'messages') && !Object.hasOwn(s, 'transcript'),
          ),
        );
        const otherPage = (
          await call('/local/sessions', undefined, undefined, other.token)
        ).json<SessionPage>();
        assert(!otherPage.items.some((s) => ids.includes(s.id)));
        const count = local.store.list('run', login.user.id).length;
        await good<SessionView>(`/local/sessions/${branch.id}`, { archived: false }, 'PATCH');
        assert.equal(local.store.list('run', login.user.id).length, count);
      },
    );
    await t.test(
      'failures before model initialization retain the prior request as reference context without executing it',
      async () => {
        const before = local.store.list('tool-detail', login.user.id).length;
        const run = await good<Run>(`/local/sessions/${branch.id}/runs`, {
          mode: 'demo',
          prompt: 'FAILED_EARLY_REQUEST 请创建另外一份方案，但必须使用所选技能。',
          skillIds: ['unavailable-skill'],
        });
        assert.equal((await wait(run.id)).status, 'failed');
        assert.equal(local.store.list('tool-detail', login.user.id).length, before);
        const stored = local.store.get<Session>('session', branch.id, login.user.id)!;
        assert(JSON.stringify(stored.transcript).includes('FAILED_EARLY_REQUEST'));
        const fork = await good<SessionView>(`/local/sessions/${branch.id}/fork`, {
          messageId: stored.messages.at(-1)!.id,
        });
        assert(
          JSON.stringify(
            local.store.get<Session>('session', fork.id, login.user.id)!.transcript,
          ).includes('历史请求与终态，仅供核查'),
        );
      },
    );
    await t.test(
      'daemon restart retains branch checkpoints, metadata and the ability to continue through the real Pi provider adapter',
      async () => {
        await local.app.close();
        local = await createLocalAgent({ dataDir: dir, apiUrl: apiBase, tickMs: 3600000 });
        const saved = await good<SessionView>(`/local/sessions/${branch.id}`);
        assert.equal(saved.pinned, true);
        assert(saved.messages.some((message) => message.text === 'BRANCH_REPLY'));
        const copy = await good<SessionView>(`/local/sessions/${branch.id}/fork`, {
          messageId: point,
        });
        assert.equal(copy.messages.length, 2);
        const run = await good<Run>(`/local/sessions/${copy.id}/runs`, {
          mode: 'ark',
          prompt: 'BRANCH_REQUEST 请继续核查执行索引。',
        });
        assert.equal((await wait(run.id)).status, 'completed');
      },
    );
  } finally {
    releaseHold();
    await local.app.close();
    await api.app.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
