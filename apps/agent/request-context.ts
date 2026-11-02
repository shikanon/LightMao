import { getCurrentSystemMessage } from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
/** The SDK returns a synthesized system message, never the original array member. */
export function refreshSystemSections(
  messages: AgentMessage[],
  sections: Record<string, string> = {},
): AgentMessage[] {
  const head = getCurrentSystemMessage(messages);
  if (!head) return messages;
  return [
    {
      ...head,
      content: head.sections?.agentPolicy ? '' : head.content,
      sections: { ...head.sections, ...sections },
    },
    ...messages.filter((m) => m.role !== 'system'),
  ];
}
export function durableGoalSection(policy: unknown) {
  return (
    '<lightmao-goal-contract>\n' +
    JSON.stringify(policy).replace(/</g, '\\u003c') +
    '\n</lightmao-goal-contract>'
  );
}
