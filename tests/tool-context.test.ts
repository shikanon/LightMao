import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import { Store } from '../packages/shared/store.ts';
import { ToolContextArchive, TOOL_CONTEXT_LIMITS } from '../apps/agent/tool-context.ts';

const scope = { ownerId: 'alice', projectId: 'forest', sessionId: 'design', runId: 'run-1' };
const stamp = Date.parse('2026-11-01T00:00:00Z');
function assistant(call: ToolCall, timestamp = stamp): AssistantMessage {
  return {
    role: 'assistant',
    api: 'openai-completions',
    provider: 'test',
    model: 'test',
    timestamp,
    content: [{ type: 'text', text: '正在检查项目。' }, call],
    stopReason: 'toolUse',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
function result(call: ToolCall, text: string, timestamp = stamp): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: 'text', text }],
    isError: false,
    timestamp,
  };
}

test('tool archive preserves full large arguments/results, bounds model text, pages exact evidence and scopes access', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lightmao-archive-'));
  let store = new Store(join(root, 'test.sqlite'));
  try {
    let archive = new ToolContextArchive(store);
    const source = Array.from({ length: 1500 }, (_, i) => `line ${i}: ${'asset-data '.repeat(6)}`);
    source[745] = 'ERROR E204: assets/player.png failed validation';
    source[900] = 'MIDDLE_EVIDENCE: collider=wrong-size';
    const fullText = source.join('\n');
    const call: ToolCall = {
      type: 'toolCall',
      id: 'read-1',
      name: 'read_file',
      arguments: { path: 'assets/player.png', input: 'large argument '.repeat(4000) },
    };
    archive.begin(scope, call, new Date(stamp).toISOString());
    assert.equal(archive.list(scope.ownerId, scope.projectId)[0].state, 'running');
    const detail = archive.save(
      scope,
      call,
      { content: [{ type: 'text', text: fullText }], details: { exitCode: 1 } },
      true,
      new Date(stamp).toISOString(),
    );
    assert.equal(detail.state, 'failed');
    const bounded = archive.result(detail).content[0];
    assert.equal(bounded.type, 'text');
    assert(bounded.type === 'text' && bounded.text.length <= TOOL_CONTEXT_LIMITS.result);
    assert.match(detail.summary, /ERROR E204/);
    assert(!detail.summary.includes('MIDDLE_EVIDENCE'));
    const page = archive.read(scope.ownerId, scope.projectId, detail.id, {
      query: 'MIDDLE_EVIDENCE',
      limit: 4000,
    });
    assert(page.text.includes('MIDDLE_EVIDENCE: collider=wrong-size'));
    assert(page.text.length <= 4000);
    assert.equal(
      archive.read(scope.ownerId, scope.projectId, detail.id, { query: 'absent-key' }).found,
      false,
    );
    assert.throws(() => archive.read('bob', scope.projectId, detail.id), { statusCode: 404 });
    assert.throws(() => archive.read(scope.ownerId, 'other-project', detail.id), {
      statusCode: 404,
    });
    let raw = '',
      offset: number | null = 0;
    while (offset !== null) {
      const chunk = archive.read(scope.ownerId, scope.projectId, detail.id, {
        offset,
        limit: 4000,
      });
      raw += chunk.text;
      offset = chunk.nextOffset;
    }
    assert.equal(createHash('sha256').update(raw).digest('hex'), detail.sha256);
    assert.deepEqual(JSON.parse(raw).arguments, call.arguments);
    assert.equal(JSON.parse(raw).result.content[0].text, fullText);
    store.close();
    store = new Store(join(root, 'test.sqlite'));
    archive = new ToolContextArchive(store);
    const read = await archive
      .reader({ ...scope, sessionId: 'fork' })
      .execute('read-again', { ref: detail.id, query: 'MIDDLE_EVIDENCE', limit: 1000 });
    assert(read.content[0].type === 'text' && read.content[0].text.includes('MIDDLE_EVIDENCE'));
    assert(read.content[0].type === 'text' && read.content[0].text.includes('原始状态：失败'));
    assert.equal(
      archive.list(scope.ownerId, scope.projectId).length,
      1,
      'read must not rerun a tool',
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('tool-history window keeps protocol pairs, original provenance and user goals across reused ids, forks and compaction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lightmao-context-'));
  const store = new Store(join(root, 'test.sqlite'));
  try {
    const archive = new ToolContextArchive(store);
    const messages: AgentMessage[] = [
      { role: 'user', content: '保留玩家移动的需求', timestamp: stamp },
    ];
    const runs = new Set<string>();
    const rounds = 36;
    for (let i = 0; i < rounds; i++) {
      const runId = `run-${i}`,
        timestamp = stamp + i * 10000;
      runs.add(runId);
      const call: ToolCall = {
        type: 'toolCall',
        id: 'provider-reused-id',
        name: 'read_file',
        arguments: { path: `file-${i}.md`, content: `argument-${i} `.repeat(500) },
      };
      const text = `file-${i}\n${'asset-details\n'.repeat(1500)}\nend-${i}`;
      const toolResult = result(call, text, timestamp + 2);
      // This is the legacy-event migration path: raw transcript with existing archives.
      archive.save(
        { ...scope, runId },
        call,
        { content: toolResult.content, details: {} },
        false,
        new Date(timestamp + 2).toISOString(),
      );
      messages.push(assistant(call, timestamp), toolResult);
    }
    const final = {
      ...assistant({ type: 'toolCall', id: 'unused', name: 'unused', arguments: {} }),
      content: [{ type: 'text' as const, text: '保留最终设计决策' }],
      stopReason: 'stop' as const,
    };
    messages.push(final, { role: 'user', content: '继续制作第一关', timestamp: stamp + 200000 });
    const normalized = archive.normalize(
      messages,
      { ...scope, sessionId: 'fork', runId: 'fork-run' },
      runs,
    );
    assert.equal(
      archive.list(scope.ownerId, scope.projectId).length,
      rounds,
      'must reuse original run archives',
    );
    assert(normalized.some((m) => m === messages[0]));
    assert(normalized.some((m) => m === final));
    assert(normalized.some((m) => m === messages.at(-1)));
    const kept = normalized.filter((m) => m.role === 'toolResult');
    assert(kept.length > 0 && kept.length < rounds);
    let toolChars = 0;
    normalized.forEach((m, i) => {
      if (m.role !== 'toolResult') return;
      const previous = normalized[i - 1];
      assert.equal(previous.role, 'assistant');
      if (previous.role !== 'assistant') return;
      const call = previous.content.find((c) => c.type === 'toolCall');
      assert(call?.type === 'toolCall');
      const ref = (m.details as { archiveRef: string }).archiveRef;
      const d = archive.find(scope.ownerId, scope.projectId, ref);
      assert(d.argsSummary.includes(String(call.arguments.path)));
      assert.equal(d.runId, `run-${String(call.arguments.path).match(/\d+/)![0]}`);
      toolChars +=
        JSON.stringify(call.arguments).length +
        m.content.map((c) => (c.type === 'text' ? c.text : '')).join('').length;
    });
    assert(toolChars <= TOOL_CONTEXT_LIMITS.toolHistory);
    const indices = normalized.filter(
      (m) => m.role === 'assistant' && m.provider === 'lightmao-context',
    );
    assert.equal(indices.length, 1);
    assert.deepEqual(
      archive.normalize(normalized, { ...scope, sessionId: 'fork', runId: 'fork-run' }, runs),
      normalized,
    );
    assert(
      !JSON.stringify(normalized).includes(
        'asset-details\\nasset-details\\nasset-details\\nasset-details\\nasset-details\\nasset-details\\nasset-details\\nasset-details\\nasset-details\\nasset-details\\nasset-details\\n',
      ),
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('unresolved calls preserve arguments and uncertainty without sending orphaned provider messages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lightmao-pending-'));
  const store = new Store(join(root, 'test.sqlite'));
  try {
    const archive = new ToolContextArchive(store);
    const call: ToolCall = {
      type: 'toolCall',
      id: 'interrupted-write',
      name: 'write_file',
      arguments: { path: 'level.json', content: 'full source '.repeat(2000) },
    };
    const out = archive.normalize(
      [{ role: 'user', content: '写入关卡', timestamp: stamp }, assistant(call)],
      scope,
    );
    assert(
      !out.some((m) => m.role === 'assistant' && m.content.some((c) => c.type === 'toolCall')),
    );
    const detail = archive.list(scope.ownerId, scope.projectId)[0];
    assert.match(JSON.stringify(out), /结果未确认/);
    assert(archive.read(scope.ownerId, scope.projectId, detail.id).text.includes('full source'));
    const page = await archive.reader(scope).execute('read-pending', { ref: detail.id });
    assert(
      page.content[0].type === 'text' && page.content[0].text.includes('原始状态：结果未确认'),
    );
    const uncertain = archive.save(
      scope,
      call,
      {
        content: [{ type: 'text', text: 'transport interrupted' }],
        details: { outcome: 'unknown', execution: { stderr: 'original diagnostic receipt' } },
      },
      true,
      new Date(stamp).toISOString(),
    );
    const replayed = archive.save(
      scope,
      call,
      archive.result(uncertain),
      true,
      new Date(stamp + 1).toISOString(),
    );
    assert.equal(replayed.state, 'unknown');
    assert.equal(replayed.sha256, uncertain.sha256);
    assert(
      archive.read(scope.ownerId, scope.projectId, replayed.id, {
        query: 'original diagnostic receipt',
      }).found,
      'Pi end events retain the original unknown result rather than overwriting it with its own summary',
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
