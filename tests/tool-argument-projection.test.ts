import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../packages/shared/store.ts';
import {
  ToolContextArchive,
  compactArguments,
  TOOL_CONTEXT_LIMITS,
} from '../apps/agent/tool-context.ts';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ToolCall } from '@earendil-works/pi-ai';
test('bounded model history retains exact executable arguments or drops whole pairs, and migrates prior archived placeholders', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lm-tool-projection-')),
    store = new Store(join(dir, 'db'));
  const scope = { ownerId: 'alice', projectId: 'p', sessionId: 's', runId: 'r' },
    archive = new ToolContextArchive(store);
  const call: ToolCall = {
    type: 'toolCall',
    id: 'module',
    name: 'write_file',
    arguments: { path: 'battle.js', content: 'const complete = true;\n'.repeat(150) },
  };
  const result = {
    content: [{ type: 'text' as const, text: '{"path":"battle.js","bytes":3300}' }],
    details: {},
  };
  const detail = archive.save(scope, call, result, false, new Date().toISOString());
  const pair = (c: ToolCall): AgentMessage[] => [
    { role: 'user', content: '保存完整战斗模块', timestamp: 1 },
    {
      role: 'assistant',
      api: 'openai-completions',
      provider: 'fixture',
      model: 'fixture',
      timestamp: 2,
      stopReason: 'toolUse',
      content: [c],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
    {
      role: 'toolResult',
      toolCallId: c.id,
      toolName: c.name,
      ...archive.result(detail),
      isError: false,
      timestamp: 3,
    },
  ];
  try {
    const messages = pair(call),
      before = structuredClone(messages);
    const actual = archive.normalize(messages, scope);
    const projected = actual.find(
      (m) => m.role === 'assistant' && m.content.some((c) => c.type === 'toolCall'),
    );
    assert(projected?.role === 'assistant');
    assert.deepEqual(
      projected.content.find((c) => c.type === 'toolCall')?.arguments,
      call.arguments,
    );
    assert(!JSON.stringify(actual).includes('_archived'));
    assert.deepEqual(
      messages,
      before,
      'preparing history does not mutate the SDK executing message',
    );
    const legacy = archive.normalize(
      pair({ ...call, arguments: compactArguments(call.arguments) as ToolCall['arguments'] }),
      scope,
    );
    assert.deepEqual(
      legacy,
      actual,
      'old compacted transcripts are restored from verified raw parameters',
    );
    assert.deepEqual(archive.normalize(actual, scope), actual);
    const oversized = {
      ...call,
      id: 'too-big',
      arguments: { path: 'large.js', content: 'x'.repeat(TOOL_CONTEXT_LIMITS.toolHistory + 1000) },
    };
    const big = archive.save(scope, oversized, result, false, new Date().toISOString());
    const rawPair = pair(oversized);
    if (rawPair[2].role === 'toolResult') Object.assign(rawPair[2], archive.result(big));
    const bounded = archive.normalize(rawPair, scope);
    assert(!bounded.some((m) => m.role === 'toolResult'));
    assert(
      !bounded.some((m) => m.role === 'assistant' && m.content.some((c) => c.type === 'toolCall')),
      'never retain a callable JSON object with omitted mandatory arguments',
    );
    assert(JSON.stringify(bounded).includes('执行记录索引'));
    assert.deepEqual(
      JSON.parse(store.get<{ text: string }>('tool-payload', big.id, scope.ownerId)!.text)
        .arguments,
      oversized.arguments,
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
