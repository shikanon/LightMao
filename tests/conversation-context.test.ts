import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApi } from '../apps/api/server.ts';
import { createLocalAgent } from '../apps/agent/server.ts';
import type { Session, Run } from '../packages/shared/types.ts';
import { seedConversation } from './fixtures/conversation.ts';
import { CONTEXT_POLICY } from '../apps/agent/conversation-context.ts';

type Body = {
  messages: {
    role: string;
    content: string | { type: string; text?: string }[];
    tool_calls?: unknown[];
  }[];
  tools?: { function: { name: string } }[];
};
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const text = (message: Body['messages'][number]) =>
  typeof message.content === 'string'
    ? message.content
    : message.content
        ?.filter((v) => v.type === 'text')
        .map((v) => v.text || '')
        .join('\n') || '';
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'lm-conversation-'));
  const requests: Body[] = [];
  let summaryMode: 'normal' | 'invalid' | 'forged' | 'wide' | 'overlong' | 'hold' | 'error' =
    'normal';
  const marker = 'PRIVATE_HISTORY_' + randomUUID();
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body: Body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    const summary = body.messages.some((m) => text(m).includes('LIGHTMAO_SUMMARY_V1'));
    if (summary && summaryMode === 'error') {
      res.writeHead(500, { 'content-type': 'application/json', 'retry-after': '0' });
      res.end('{"error":"protocol failure"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = (delta: unknown, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: 'context-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    let content: string;
    if (summary) {
      if (summaryMode === 'hold') {
        res.write(frame({ role: 'assistant', content: '{"items":' }));
        return;
      }
      const input = JSON.parse(text(body.messages.filter((m) => m.role === 'user').at(-1)!));
      const user = input.sourceParts.find((v: { role: string }) => v.role === 'user');
      const items = input.previous?.length
        ? input.previous
        : [
            {
              kind: 'constraint',
              text: user?.text.includes(marker) ? marker + ' 不修改原始工程。' : '保留用户约束。',
              sourceIds: [user?.messageId || input.sourceParts[0].messageId],
            },
          ];
      content =
        summaryMode === 'invalid'
          ? 'this is not json'
          : JSON.stringify({
              items:
                summaryMode === 'forged'
                  ? [{ kind: 'goal', text: 'forged', sourceIds: ['not-a-real-source'] }]
                  : summaryMode === 'wide'
                    ? [{ ...items[0], sourceIds: Array(5).fill(items[0].sourceIds[0]) }]
                    : summaryMode === 'overlong'
                      ? Array.from({ length: 8 }, () => ({ ...items[0], text: 'a'.repeat(590) }))
                      : items,
            });
    } else {
      const lastUser = body.messages.findLastIndex((m) => m.role === 'user');
      const prompt = text(body.messages[lastUser]);
      if (
        prompt.includes('RECALL_HISTORY') &&
        !body.messages.slice(lastUser + 1).some((m) => m.role === 'tool')
      ) {
        res.write(
          frame({
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'read-history',
                type: 'function',
                function: {
                  name: 'read_session_history',
                  arguments: JSON.stringify({ query: marker }),
                },
              },
            ],
          }),
        );
        res.write(frame({}, 'tool_calls'));
        res.end('data: [DONE]\n\n');
        return;
      }
      if (
        prompt.includes('RECALL_MESSAGE') &&
        !body.messages.slice(lastUser + 1).some((m) => m.role === 'tool')
      ) {
        res.write(
          frame({
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'read-history-body',
                type: 'function',
                function: {
                  name: 'read_session_history',
                  arguments: JSON.stringify({ messageId: prompt.split(' ').at(-1), limit: 4000 }),
                },
              },
            ],
          }),
        );
        res.write(frame({}, 'tool_calls'));
        res.end('data: [DONE]\n\n');
        return;
      }
      content = 'LONG_CONTEXT_VERIFIED';
    }
    res.write(frame({ role: 'assistant', content }));
    res.write(frame({}, 'stop'));
    res.end(
      'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":40,"total_tokens":1040}}\n\ndata: [DONE]\n\n',
    );
  });
  await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
  const api = await createApi({
    dataDir: directory,
    demo: true,
    arkKey: 'context-protocol-key',
    maxOutputTokens: 8192,
    arkBase: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
  });
  await api.app.listen({ host: '127.0.0.1', port: 0 });
  const apiUrl = `http://127.0.0.1:${(api.app.server.address() as { port: number }).port}`;
  let local = await createLocalAgent({ dataDir: directory, apiUrl, tickMs: 3600000 });
  const login = (
    await api.app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} })
  ).json();
  const owner = login.user.id,
    token = login.token;
  const headers = { authorization: 'Bearer ' + token };
  const call = (url: string, payload?: unknown, method?: 'POST' | 'PATCH') =>
    local.app.inject({
      url,
      method: method || (payload ? 'POST' : 'GET'),
      headers,
      ...(payload ? { payload } : {}),
    });
  const good = async (url: string, payload?: unknown, method?: 'POST' | 'PATCH') => {
    const r = await call(url, payload, method);
    assert(r.statusCode < 300, r.body);
    return r.json();
  };
  const project = (await good('/local/bootstrap')).projects[0];
  const create = async () => good('/local/sessions', { projectId: project.id });
  const wait = async (id: string, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run: Run = await good('/local/runs/' + id);
      if (run.status !== 'running') return run;
      await delay(10);
    }
    throw Error('Context run did not settle');
  };
  const send = async (id: string, prompt: string) => {
    const run = await good('/local/sessions/' + id + '/runs', { prompt, mode: 'ark' });
    return wait(run.id);
  };
  const summaries = () =>
    requests.filter((b) => b.messages.some((m) => text(m).includes('LIGHTMAO_SUMMARY_V1')));
  return {
    directory,
    api,
    owner,
    marker,
    requests,
    create,
    good,
    call,
    send,
    wait,
    summaries,
    get local() {
      return local;
    },
    mode(value: typeof summaryMode) {
      summaryMode = value;
    },
    async budget(n: number) {
      const r = await api.app.inject({
        url: '/api/admin/model',
        method: 'PATCH',
        headers,
        payload: { contextWindowTokens: n, maxOutputTokens: Math.min(8192, Math.floor(n / 4)) },
      });
      assert.equal(r.statusCode, 200, r.body);
    },
    async restart() {
      await local.app.close();
      local = await createLocalAgent({ dataDir: directory, apiUrl, tickMs: 3600000 });
    },
    async close() {
      await local.app.close();
      await api.app.close();
      upstream.closeAllConnections();
      await new Promise<void>((done) => upstream.close(() => done()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('actual Pi summarizes long conversation separately, preserves raw checkpoints, scopes recall and reuses memory after restart and fork', async () => {
  const f = await fixture();
  try {
    await f.budget(32768);
    const session = await f.create();
    const seeded = seedConversation(f.local.store, f.owner, session.id, 8, 1800, f.marker);
    const before = f.local.store.get<Session>('session', session.id, f.owner)!;
    const snapshots = f.local.store.list('session-checkpoint', f.owner).map(digest);
    const raw = digest(before);
    const result = await f.send(
      session.id,
      'CURRENT_REQUEST_KEEP_EXACT 检查历史目标后继续，不写文件。',
    );
    assert.equal(result.status, 'completed', result.error);
    assert(f.summaries().length >= 1 && f.summaries().length <= 4);
    assert(result.historyContext?.summaryRef);
    const main = f.requests
      .filter((b) => !b.messages.some((m) => text(m).includes('LIGHTMAO_SUMMARY_V1')))
      .at(-1)!;
    assert(main.messages.length < 15);
    assert(JSON.stringify(main).includes('CURRENT_REQUEST_KEEP_EXACT'));
    assert(JSON.stringify(main).includes(f.marker));
    assert(!JSON.stringify(main).includes(seeded[3].reply.text));
    assert(
      f.summaries().every((b) => !b.tools?.length),
      'Summary worker never receives tools',
    );
    const attempts = f.local.store.list<{ state: string; text: string }>(
      'conversation-attempt',
      f.owner,
    );
    assert(attempts.length > 0 && attempts.every((v) => v.state === 'validated' && v.text));
    const saved = f.local.store.get<Session>('session', session.id, f.owner)!;
    assert.deepEqual(saved.messages.slice(0, before.messages.length), before.messages);
    assert(JSON.stringify(saved.transcript).includes(seeded[3].reply.text));
    assert(!JSON.stringify(saved.transcript).includes('conversation-memory-v1'));
    assert.equal(
      f.local.store
        .list('session-checkpoint', f.owner)
        .slice(0, snapshots.length)
        .map(digest)
        .join(),
      snapshots.join(),
    );
    assert.equal(digest(before), raw);
    const summaryCount = f.summaries().length;
    const recalled = await f.send(session.id, 'RECALL_HISTORY');
    assert.equal(recalled.status, 'completed', recalled.error);
    assert.equal(recalled.toolCount, 1);
    assert.equal(f.summaries().length, summaryCount);
    const read = await f.send(session.id, 'RECALL_MESSAGE ' + seeded[0].user.id);
    assert.equal(read.status, 'completed', read.error);
    const last = f.requests.at(-1)!;
    assert(last.messages.some((m) => m.role === 'tool' && text(m).includes(seeded[0].user.text)));
    await f.restart();
    assert.equal((await f.send(session.id, '继续检查已有结论')).status, 'completed');
    assert.equal(f.summaries().length, summaryCount);
    const branch = await f.good('/local/sessions/' + session.id + '/fork', {
      messageId: seeded[0].reply.id,
      requestId: randomUUID(),
    });
    assert.equal(
      (await f.call(`/local/sessions/${branch.id}/context/${result.historyContext!.summaryRef}`))
        .statusCode,
      404,
    );
    assert.equal(
      (await f.call(`/local/sessions/${branch.id}/history?messageId=${seeded[7].user.id}`))
        .statusCode,
      404,
    );
    assert.equal(
      (await f.call(`/local/sessions/${branch.id}/history?runId=${seeded[7].runId}`)).statusCode,
      404,
    );
    assert.equal((await f.send(branch.id, 'EARLY_FORK_REQUEST')).status, 'completed');
    const branchRequest = JSON.stringify(f.requests.at(-1));
    assert(!branchRequest.includes(seeded[7].reply.text));
    assert(!branchRequest.includes('conversation-memory-v1'));
    // A checkpoint from a real Pi request begins with a system message. Pi's
    // constructor preserves it, so current policy must also be supplied as a
    // per-run section rather than relying only on initialState.systemPrompt.
    const realReply = saved.messages.find((m) => m.role === 'assistant' && m.runId === result.id)!;
    const realBranch = await f.good('/local/sessions/' + session.id + '/fork', {
      messageId: realReply.id,
      requestId: randomUUID(),
    });
    assert.equal((await f.send(realBranch.id, 'REAL_CHECKPOINT_BRANCH')).status, 'completed');
    const realPolicy = text(f.requests.at(-1)!.messages.find((m) => m.role === 'system')!);
    assert.match(realPolicy, /仅在用户明确要求时写入文件/);
    assert.match(realPolicy, /本会话为对话分支，共享当前项目文件/);
    const empty = await f.create();
    assert.equal(
      (await f.call(`/local/sessions/${empty.id}/history?messageId=${seeded[0].user.id}`))
        .statusCode,
      404,
    );
    const member = (
      await f.api.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          name: 'Other owner',
          email: randomUUID() + '@example.test',
          password: 'Other-owner-fixture-2026',
        },
      })
    ).json();
    for (const url of [
      `/local/sessions/${session.id}/context/${result.historyContext!.summaryRef}`,
      `/local/sessions/${session.id}/history?messageId=${seeded[0].user.id}`,
      `/local/sessions/${session.id}/history?runId=${seeded[0].runId}`,
    ]) {
      const denied = await f.local.app.inject({
        url,
        headers: { authorization: 'Bearer ' + member.token },
      });
      assert.equal(denied.statusCode, 404);
      assert(!denied.body.includes(f.marker));
    }
    const checkpoint = await f.good(
      `/local/sessions/${session.id}/history?runId=${seeded[0].runId}&query=${encodeURIComponent(f.marker)}&limit=4000`,
    );
    assert(checkpoint.found && checkpoint.text.includes(f.marker));
  } finally {
    await f.close();
  }
});

test('summary timeout aborts its actual Pi gateway request once and preserves original history for explicit continuation', async () => {
  const f = await fixture();
  try {
    await f.budget(32768);
    const session = await f.create();
    seedConversation(f.local.store, f.owner, session.id, 8, 1800, f.marker);
    const messages = f.local.store.get<Session>('session', session.id, f.owner)!.messages;
    const snapshots = f.local.store.list('session-checkpoint', f.owner).map(digest);
    f.mode('hold');
    const startedAt = Date.now();
    const run = await f.good('/local/sessions/' + session.id + '/runs', {
      mode: 'ark',
      prompt: 'TIMEOUT_SUMMARY_REQUEST',
    });
    const final = await f.wait(run.id, CONTEXT_POLICY.summaryTimeoutMs + 15000);
    assert.equal(final.status, 'failed');
    assert.match(final.error!, /历史整理超时/);
    assert(Date.now() - startedAt >= CONTEXT_POLICY.summaryTimeoutMs - 1000);
    assert.equal(f.requests.length, 1, 'A timed-out model request must not be retried');
    assert.deepEqual(
      f.local.store
        .get<Session>('session', session.id, f.owner)!
        .messages.slice(0, messages.length),
      messages,
    );
    assert.deepEqual(
      f.local.store.list('session-checkpoint', f.owner).slice(0, snapshots.length).map(digest),
      snapshots,
    );
    assert.equal(f.local.store.list('conversation-memory', f.owner).length, 0);
    for (
      let i = 0;
      i < 200 && f.api.store.list<{ status: string }>('usage').some((v) => v.status === 'running');
      i++
    )
      await delay(10);
    assert(!f.api.store.list<{ status: string }>('usage').some((v) => v.status === 'running'));
    await f.restart();
    assert.equal(f.requests.length, 1, 'A restart must not replay the interrupted summary');
    f.mode('normal');
    const continued = await f.send(session.id, '明确继续整理历史');
    assert.equal(continued.status, 'completed', continued.error);
    assert(continued.historyContext?.summaryRef);
    const main = f.requests.at(-1)!;
    assert.match(JSON.stringify(main), /失败、取消或结果未确认/);
  } finally {
    await f.close();
  }
});

test('message-count compaction runs before the 300-message gateway boundary; short conversations add no summary calls', async () => {
  const f = await fixture();
  try {
    const short = await f.create();
    assert.equal((await f.send(short.id, '简单检查')).status, 'completed');
    assert.equal(f.summaries().length, 0);
    const sample = f.local.store
      .list<Session>('session', f.owner)
      .find((s) => s.messages.some((m) => m.sample && m.role === 'assistant'))!;
    assert(sample);
    const sampleReply = sample.messages.find((m) => m.sample && m.role === 'assistant')!;
    const sampleBranch = await f.good('/local/sessions/' + sample.id + '/fork', {
      messageId: sampleReply.id,
      requestId: randomUUID(),
    });
    assert.equal((await f.send(sampleBranch.id, 'SAMPLE_BRANCH_REQUEST')).status, 'completed');
    const policy = text(f.requests.at(-1)!.messages.find((m) => m.role === 'system')!);
    assert.match(policy, /示例对话，仅供参考/);
    assert.match(policy, /仅在用户明确要求时写入文件/);
    assert.match(policy, /本会话为对话分支/);
    assert.equal(f.summaries().length, 0);
    const long = await f.create();
    seedConversation(f.local.store, f.owner, long.id, 155, 8, f.marker);
    const result = await f.send(long.id, 'COUNT_BOUNDARY_REQUEST');
    assert.equal(result.status, 'completed', result.error);
    assert(f.summaries().length > 0);
    assert(f.requests.at(-1)!.messages.length < 30);
    assert.equal(f.local.store.get<Session>('session', long.id, f.owner)!.messages.length, 312);
  } finally {
    await f.close();
  }
});

test('invalid/forged summaries and cancellation never fall back to silent history truncation or retry the model', async () => {
  const f = await fixture();
  try {
    await f.budget(32768);
    for (const mode of ['invalid', 'forged', 'wide', 'overlong', 'error'] as const) {
      const session = await f.create();
      seedConversation(f.local.store, f.owner, session.id, 8, 1800, f.marker);
      const prefix = f.local.store.get<Session>('session', session.id, f.owner)!.messages;
      const count = f.requests.length;
      f.mode(mode);
      const result = await f.send(session.id, 'INVALID_SUMMARY_REQUEST');
      assert.equal(result.status, 'failed');
      assert.equal(f.requests.length, count + 1);
      assert(!result.historyContext?.summaryRef);
      const attempt = f.local.store
        .list<{ runId: string; state: string; text?: string }>('conversation-attempt', f.owner)
        .find((v) => v.runId === result.id)!;
      assert.equal(attempt.state, 'failed');
      if (mode !== 'error') assert(attempt.text);
      if (mode === 'wide') assert.match(result.error!, /sourceIds:too_big/);
      if (mode === 'overlong') assert.match(result.error!, /超过 4000 字符/);
      assert(!result.error!.includes(f.marker));
      assert.deepEqual(
        f.local.store
          .get<Session>('session', session.id, f.owner)!
          .messages.slice(0, prefix.length),
        prefix,
      );
    }
    f.mode('hold');
    const session = await f.create();
    seedConversation(f.local.store, f.owner, session.id, 8, 1800, f.marker);
    const old = f.requests.length,
      started = await f.good('/local/sessions/' + session.id + '/runs', {
        mode: 'ark',
        prompt: 'CANCEL_SUMMARY_REQUEST',
      });
    for (let i = 0; i < 200 && f.requests.length === old; i++) await delay(10);
    assert.equal(f.requests.length, old + 1);
    const stoppedAt = Date.now();
    await f.good('/local/runs/' + started.id + '/stop', {});
    assert.equal((await f.wait(started.id)).status, 'cancelled');
    assert(
      f.local.store
        .list<{ runId: string; state: string }>('conversation-attempt', f.owner)
        .some((v) => v.runId === started.id && v.state === 'cancelled'),
    );
    assert(Date.now() - stoppedAt < 3000, 'Cancelling the summary must settle promptly');
    for (
      let i = 0;
      i < 200 &&
      f.api.store.list<{ id: string; status: string }>('usage').some((v) => v.status === 'running');
      i++
    )
      await delay(10);
    assert(
      !f.api.store
        .list<{ id: string; status: string }>('usage')
        .some((v) => v.status === 'running'),
      'Cancelled summary left an upstream model request running',
    );
    assert.equal(f.requests.length, old + 1);
  } finally {
    await f.close();
  }
});

test('bounded summary batches persist verified progress and resume without repeating completed batches or historical tools', async () => {
  const f = await fixture();
  try {
    await f.budget(16384);
    const session = await f.create();
    seedConversation(f.local.store, f.owner, session.id, 15, 3000, f.marker);
    let result: Run | undefined;
    for (let attempts = 0; attempts < 6; attempts++) {
      result = await f.send(session.id, '继续整理并检查历史');
      if (result.status === 'completed') break;
      assert.equal(result.status, 'failed', result.error);
      assert.match(result.error!, /已保存四批/);
      await f.restart();
    }
    assert.equal(result?.status, 'completed', result?.error);
    const unitHashes = f
      .summaries()
      .flatMap((b) =>
        JSON.parse(text(b.messages.filter((m) => m.role === 'user').at(-1)!)).sourceParts.map(
          (v: { hash: string }) => v.hash,
        ),
      );
    assert.equal(
      new Set(unitHashes).size,
      unitHashes.length,
      'A completed batch was requested again',
    );
    assert(f.local.store.list('conversation-work', f.owner).length > 4);
    assert(f.local.store.list<Run>('run', f.owner).every((r) => !r.toolCount));
  } finally {
    await f.close();
  }
});

test('summary commit failure preserves completed work, corrupted memory is rejected, and original input is never silently shortened', async () => {
  const f = await fixture();
  try {
    await f.budget(32768);
    const session = await f.create();
    const old = seedConversation(f.local.store, f.owner, session.id, 8, 1800, f.marker);
    f.local.store.db.exec(
      "CREATE TRIGGER fail_summary BEFORE INSERT ON records WHEN NEW.kind='conversation-memory' BEGIN SELECT RAISE(ABORT,'injected-summary-commit'); END",
    );
    const failed = await f.send(session.id, '检查完整历史');
    assert.equal(failed.status, 'failed');
    const count = f.summaries().length;
    const completedUnits = new Set(
      f
        .summaries()
        .flatMap((body) =>
          JSON.parse(text(body.messages.filter((m) => m.role === 'user').at(-1)!)).sourceParts.map(
            (unit: { hash: string }) => unit.hash,
          ),
        ),
    );
    assert(f.local.store.list('conversation-work', f.owner).length > 0);
    assert.equal(f.local.store.list('conversation-memory', f.owner).length, 0);
    f.local.store.db.exec('DROP TRIGGER fail_summary');
    const retried = await f.send(session.id, '明确继续检查历史');
    assert.equal(retried.status, 'completed', retried.error);
    for (const body of f.summaries().slice(count))
      for (const unit of JSON.parse(text(body.messages.filter((m) => m.role === 'user').at(-1)!))
        .sourceParts)
        assert(!completedUnits.has(unit.hash), 'A committed summary batch was requested again');
    const ref = retried.historyContext!.summaryRef!;
    const memory = f.local.store.get<{ id: string; items: { text: string }[] }>(
      'conversation-memory',
      ref,
      f.owner,
    )!;
    memory.items[0].text = 'tampered memory';
    f.local.store.put('conversation-memory', f.owner, memory);
    assert.equal((await f.call(`/local/sessions/${session.id}/context/${ref}`)).statusCode, 409);
    const requests = f.requests.length,
      rejected = await f.send(session.id, '核查受损摘要');
    assert.equal(rejected.status, 'failed');
    assert.match(rejected.error!, /校验失败/);
    assert.equal(f.requests.length, requests);
    assert.equal(
      (await f.good(`/local/sessions/${session.id}/history?messageId=${old[0].user.id}&limit=4000`))
        .text,
      old[0].user.text,
    );
    await f.budget(16384);
    const large = await f.create(),
      before = f.requests.length;
    const input = 'CURRENT_INPUT_PRESERVE_' + 'a'.repeat(15950);
    const over = await f.send(large.id, input);
    assert.equal(over.status, 'failed');
    assert.match(over.error!, /超出上下文预算/);
    assert.equal(f.requests.length, before);
    const source = f.local.store.get<Session>('session', large.id, f.owner)!.messages[0];
    assert.equal(source.text, input);
  } finally {
    await f.close();
  }
});

test('large configured model windows still compact before the gateway request-byte limit', async () => {
  const f = await fixture();
  try {
    await f.budget(2000000);
    const session = await f.create();
    seedConversation(f.local.store, f.owner, session.id, 51, 15000, f.marker);
    const result = await f.send(session.id, 'REQUEST_BYTES_BOUNDARY');
    assert.equal(result.status, 'completed', result.error);
    assert(f.summaries().length >= 1);
    assert(Buffer.byteLength(JSON.stringify(f.requests.at(-1))) < 200000);
    assert(f.requests.every((body) => Buffer.byteLength(JSON.stringify(body)) < 1900000));
    assert.equal(f.local.store.get<Session>('session', session.id, f.owner)!.messages.length, 104);
  } finally {
    await f.close();
  }
});
