import {
  getCurrentTools,
  type AssistantMessage,
  type Model,
  type StreamFunction,
  type SimpleStreamOptions,
  type ToolCall,
} from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_AGENT_MODEL,
  modelDefaults,
  outputTokenBudget,
} from '../../packages/shared/model-budget.ts';

export function gatewayModel(
  apiUrl: string,
  contextWindow?: number,
  maxOutputTokens?: number,
  modelId = DEFAULT_AGENT_MODEL,
): Model<'openai-completions'> {
  const defaults = modelDefaults(modelId);
  contextWindow ??= defaults.contextWindowTokens;
  maxOutputTokens ??= defaults.maxOutputTokens;
  return {
    id: 'doubao',
    name: defaults.label,
    api: 'openai-completions',
    // Physical routing identity keeps another model's reasoning out of replay.
    provider: 'lightmao:' + modelId,
    baseUrl: `${apiUrl}/api/v1`,
    reasoning: modelId.startsWith('deepseek-'),
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: outputTokenBudget(contextWindow, maxOutputTokens, modelId),
    compat: {
      supportsDeveloperRole: false,
      supportsStore: false,
      maxTokensField: 'max_tokens',
      supportsUsageInStreaming: true,
    },
  };
}
export const arkStream =
  (token: string): StreamFunction =>
  (model, context, options) => {
    const simple = options as SimpleStreamOptions | undefined;
    return streamSimple(model as Model<'openai-completions'>, context, {
      ...simple,
      reasoning: model.reasoning ? simple?.reasoning || 'high' : simple?.reasoning,
      apiKey: token,
      maxTokens: model.maxTokens,
      maxRetries: 0,
      maxRetryDelayMs: 0,
    });
  };

/** Deterministic test/demo provider. Uses Pi's real tool loop, never pretends to be a model. */
export function demoStream(
  skillNames: string[],
  assetNames: string[],
  skillIds: string[] = [],
): StreamFunction {
  let turns = 0;
  return (model, context, options) => {
    const stream = new AssistantMessageEventStream();
    const message: AssistantMessage = {
      role: 'assistant',
      content: [],
      api: model.api,
      provider: 'lightmao-demo',
      model: 'demo',
      timestamp: Date.now(),
      stopReason: 'stop',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    void (async () => {
      try {
        stream.push({ type: 'start', partial: message });
        await delay(120, undefined, { signal: options?.signal });
        const available = getCurrentTools(context.messages).map((t) => t.name);
        const names = ['list_files', 'inspect_project'].filter((t) => available.includes(t));
        if (skillIds.length && available.includes('read_skill_resource'))
          names.push('read_skill_resource');
        if (turns++ === 0 && names.length) {
          for (const name of names) {
            const tc: ToolCall = {
              type: 'toolCall',
              id: randomUUID(),
              name,
              arguments:
                name === 'read_skill_resource'
                  ? { skillId: skillIds[0], path: 'SKILL.md' }
                  : name === 'list_files'
                    ? { path: '.' }
                    : {},
            };
            const i = message.content.length;
            message.content.push(tc);
            stream.push({ type: 'toolcall_start', contentIndex: i, partial: message });
            stream.push({ type: 'toolcall_end', contentIndex: i, toolCall: tc, partial: message });
          }
          message.stopReason = 'toolUse';
          stream.push({ type: 'done', reason: 'toolUse', message });
          stream.end(message);
          return;
        }
        const lastUser = context.messages.findLastIndex((m) => m.role === 'user');
        const toolResults = names.length
          ? context.messages.slice(lastUser + 1).filter((m) => m.role === 'toolResult')
          : [];
        const successful = toolResults.filter((m) => m.role === 'toolResult' && !m.isError);
        const text = `### ${successful.length ? '项目上下文已就绪' : '开始你的下一步创作'}\n\n${names.length ? `已完成 ${successful.length} 项读取与检查。目录与引擎信息已保存在执行记录中，可展开查看。` : '当前未启用文件读取工具。可以到「插件」启用项目文件。'}\n\n${skillNames.length ? `已选择技能：${skillNames.join('、')}。\n\n` : ''}${assetNames.length ? `已引用资料：${assetNames.join('、')}。\n\n` : ''}本次为静态检查，尚未执行游戏引擎。\n\n这是演示模式；切换到「方舟模型」后，可继续进行具体的设计、编程与文件修改。`;
        message.content.push({ type: 'text', text: '' });
        stream.push({ type: 'text_start', contentIndex: 0, partial: message });
        for (let i = 0; i < text.length; i += 20) {
          await delay(14, undefined, { signal: options?.signal });
          const chunk = text.slice(i, i + 20);
          (message.content[0] as { type: 'text'; text: string }).text += chunk;
          stream.push({ type: 'text_delta', contentIndex: 0, delta: chunk, partial: message });
        }
        stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: message });
        stream.push({ type: 'done', reason: 'stop', message });
        stream.end(message);
      } catch (error) {
        message.stopReason = options?.signal?.aborted ? 'aborted' : 'error';
        message.errorMessage = error instanceof Error ? error.message : '演示运行失败';
        stream.push({ type: 'error', reason: message.stopReason, error: message });
        stream.end(message);
      }
    })();
    return stream;
  };
}
