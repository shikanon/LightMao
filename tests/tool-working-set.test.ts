import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../packages/shared/store.ts';
import { ToolContextArchive, TOOL_CONTEXT_LIMITS } from '../apps/agent/tool-context.ts';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
test('exact source pages have a bounded working set independent of summarized tool history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lm-working-set-')),
    store = new Store(join(dir, 'db')),
    archive = new ToolContextArchive(store),
    scope = { ownerId: 'a', projectId: 'p', sessionId: 's', runId: 'r' },
    messages: AgentMessage[] = [];
  try {
    for (let i = 0; i < 8; i++) {
      const call = {
          type: 'toolCall' as const,
          id: 'read-' + i,
          name: 'read_file',
          arguments: { path: 'game.js', offset: i * 3800, limit: 3800 },
        },
        text = `SOURCE_PAGE_${i}\n` + 'x'.repeat(3780),
        at = Date.now() + i;
      const detail = archive.save(
        scope,
        call,
        { content: [{ type: 'text', text }], details: { filePage: true } },
        false,
        new Date(at).toISOString(),
      );
      messages.push(
        {
          role: 'assistant',
          api: 'openai-completions',
          provider: 'fixture',
          model: 'fixture',
          timestamp: at,
          stopReason: 'toolUse',
          content: [call],
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
        {
          role: 'toolResult',
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: 'text', text }],
          isError: false,
          timestamp: at + 1,
        },
      );
      assert.equal(detail.exactPage, true);
      if (i === 3) {
        const first = archive.normalize(messages, scope),
          visible = JSON.stringify(first);
        for (let page = 0; page < 4; page++)
          assert(
            visible.includes('SOURCE_PAGE_' + page),
            'A complete four-page source working set must remain visible',
          );
        assert(first.filter((m) => m.role === 'toolResult').length === 4);
      }
    }
    const normalized = archive.normalize(messages, scope),
      results = normalized.filter((m) => m.role === 'toolResult');
    assert(results.length > 0 && results.length < 8);
    const chars = results.reduce(
      (n, m) => n + m.content.map((c) => (c.type === 'text' ? c.text : '')).join('').length,
      0,
    );
    assert(chars <= TOOL_CONTEXT_LIMITS.workingSet);
    assert.deepEqual(archive.normalize(normalized, scope), normalized);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
