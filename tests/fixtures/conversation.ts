import { randomUUID } from 'node:crypto';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { Store } from '../../packages/shared/store.ts';
import { SessionService } from '../../apps/agent/sessions.ts';
import { ToolContextArchive } from '../../apps/agent/tool-context.ts';
import type { Session, Run, ChatMessage } from '../../packages/shared/types.ts';

/** Seed honest protocol fixtures via the real checkpoint commit path; no model
 * generated these historical rounds. Tests inspect actual later Pi requests. */
export function seedConversation(
  store: Store,
  owner: string,
  sessionId: string,
  count = 8,
  width = 1600,
  marker = 'HISTORY_ONLY_CONSTRAINT',
) {
  const archive = new ToolContextArchive(store);
  const sessions = new SessionService({
    store,
    key: Buffer.alloc(32, 1),
    normalize: archive.normalize.bind(archive),
    checkRef: (ref, user, project, runs) => {
      const value = archive.find(user, project, ref);
      if (!runs.has(value.runId)) throw Error('Hidden tool reference');
    },
  });
  const session = store.get<Session>('session', sessionId, owner)!;
  const seeded: { runId: string; user: ChatMessage; reply: ChatMessage }[] = [];
  for (let index = 0; index < count; index++) {
    const runId = randomUUID(),
      start = Date.now() - (count - index) * 1000;
    const text = `${index === 0 ? marker + ' 用户约束：不要修改原始工程，先检查再处理。' : '历史请求 ' + index} ${'context-data-'.repeat(Math.ceil(width / 13)).slice(0, width)}`;
    const user: ChatMessage = {
      id: randomUUID(),
      role: 'user',
      text,
      at: new Date(start).toISOString(),
      runId,
      mode: 'ark',
    };
    const reply: ChatMessage = {
      id: randomUUID(),
      role: 'assistant',
      text: `历史答复 ${index}：这里只报告检查结果。${'reported-context-'.repeat(Math.ceil(width / 17)).slice(0, width)}`,
      at: new Date(start + 100).toISOString(),
      runId,
      mode: 'ark',
    };
    const run: Run = {
      id: runId,
      sessionId,
      projectId: session.projectId,
      prompt: text,
      mode: 'ark',
      status: 'completed',
      text: reply.text,
      startedAt: user.at,
      endedAt: reply.at,
      toolCount: 0,
      toolErrorCount: 0,
    };
    session.messages.push(user, reply);
    session.transcript.push(
      {
        role: 'user',
        content: text,
        timestamp: start,
        lightmaoRunId: runId,
        lightmaoMessageId: user.id,
      } as AgentMessage,
      {
        role: 'assistant',
        api: 'openai-completions',
        provider: 'protocol-fixture',
        model: 'fixture',
        content: [{ type: 'text', text: reply.text }],
        stopReason: 'stop',
        timestamp: start + 100,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      } satisfies AssistantMessage,
    );
    session.status = 'completed';
    session.updatedAt = reply.at;
    sessions.finish(owner, session, run);
    seeded.push({ runId, user, reply });
  }
  return seeded;
}
