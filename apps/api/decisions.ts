import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  decisionRequest,
  type DecisionRequest,
  type DecisionResponse,
} from '../../packages/shared/system-one.ts';
import { now, type Usage, type User } from '../../packages/shared/types.ts';
import type { Store } from '../../packages/shared/store.ts';

const fail = (statusCode: number, message: string): never => {
  throw Object.assign(new Error(message), { statusCode });
};
export function systemOneUrl(base = 'https://ark.cn-beijing.volces.com/api/v3') {
  const url = new URL(base);
  url.pathname = url.pathname.replace(/\/api\/v3\/?$/, '').replace(/\/$/, '') + '/api/v1/systemone';
  return url.href;
}
export async function boundedJson(response: Response, limit = 2 * 1024 * 1024) {
  if (!response.body) throw Error('模型响应为空');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) throw Error('模型响应超过限制');
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export interface DecisionOptions {
  arkKey?: string;
  arkBase?: string;
  decisionModelId?: string;
  timeoutMs?: number;
}
export function registerDecisionRoutes(
  app: FastifyInstance,
  store: Store,
  actor: (req: object) => User,
  options: DecisionOptions,
) {
  const active = new Map<string, number>();
  const recent = new Map<string, { count: number; since: number }>();
  const requests = new Map<AbortController, Promise<void>>();
  let closing = false;
  const config = () =>
    store.get<{ id: string; modelId: string; enabled: boolean }>('config', 'decision-model')!;
  if (!config())
    store.put('config', 'system', {
      id: 'decision-model',
      modelId: options.decisionModelId || 'doubao-seed-2-1-lite-260915',
      enabled: true,
    });
  async function evaluate(
    owner: string,
    raw: unknown,
    disconnected?: AbortSignal,
    correlation: { traceId?: string; spanId?: string } = {},
  ): Promise<DecisionResponse> {
    const input = decisionRequest.parse(raw);
    const route = config();
    if (closing) fail(503, '服务正在退出');
    if (!route.enabled || !options.arkKey) fail(503, '方舟 System One 未配置或已停用');
    if (!['system-one', route.modelId].includes(input.model))
      fail(400, '请使用已配置的 System One 模型别名');
    if ((active.get(owner) || 0) >= 2) fail(429, 'System One 并发请求已达上限');
    const rate = recent.get(owner);
    const window = rate && Date.now() - rate.since < 60000 ? rate : { count: 0, since: Date.now() };
    if (++window.count > 90) fail(429, 'System One 请求过于频繁');
    recent.set(owner, window);
    if (recent.size > 10000)
      for (const [key, v] of recent) if (Date.now() - v.since >= 60000) recent.delete(key);
    active.set(owner, (active.get(owner) || 0) + 1);
    const controller = new AbortController(),
      started = Date.now(),
      id = randomUUID();
    let release!: () => void;
    requests.set(
      controller,
      new Promise<void>((done) => {
        release = done;
      }),
    );
    const usage: Usage = {
      id,
      userId: owner,
      model: route.modelId,
      capability: 'decision',
      status: 'running',
      durationMs: 0,
      at: now(),
      ...correlation,
    };
    store.put('usage', 'system', usage);
    const abort = () => controller.abort();
    disconnected?.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort();
    }, options.timeoutMs ?? 30000);
    try {
      if (disconnected?.aborted) controller.abort();
      const response = await fetch(systemOneUrl(options.arkBase), {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.arkKey}`,
          'ark-beta-systemone-api': 'true',
        },
        body: JSON.stringify({ ...input, model: route.modelId } satisfies DecisionRequest),
      });
      usage.upstreamStatus = response.status;
      if (!response.ok) {
        await response.body?.cancel();
        usage.status = `upstream_${response.status}`;
        usage.failureReason = 'upstream_error';
        fail(502, `System One 请求被上游拒绝（HTTP ${response.status}）`);
      }
      const result = z
        .object({
          model: z.string().max(160),
          answers: z.record(z.string(), z.unknown()),
          usage: z
            .object({
              input_tokens: z.number().int().nonnegative().optional(),
              output_tokens: z.number().int().nonnegative().optional(),
            })
            .optional(),
        })
        .parse(await boundedJson(response));
      if (Object.keys(input.questions).some((key) => !Object.hasOwn(result.answers, key)))
        throw Error('模型未返回全部问题');
      usage.promptTokens = result.usage?.input_tokens;
      usage.completionTokens = result.usage?.output_tokens;
      if (usage.promptTokens !== undefined && usage.completionTokens !== undefined)
        usage.totalTokens = usage.promptTokens + usage.completionTokens;
      usage.status = 'completed';
      return {
        ...result,
        answers: Object.fromEntries(
          Object.keys(input.questions).map((key) => [key, result.answers[key]]),
        ),
        requestId: id,
      };
    } catch (error) {
      if (usage.status === 'running') {
        usage.status = closing ? 'interrupted' : 'failed';
        usage.failureReason = timedOut
          ? 'timeout'
          : controller.signal.aborted
            ? 'client_cancelled'
            : 'network_error';
      }
      if ((error as { statusCode?: number }).statusCode) throw error;
      return fail(502, 'System One 请求未完成；未执行动作，请核对调用记录');
    } finally {
      clearTimeout(timer);
      disconnected?.removeEventListener('abort', abort);
      usage.durationMs = Date.now() - started;
      store.put('usage', 'system', usage);
      active.set(owner, Math.max(0, (active.get(owner) || 1) - 1));
      if (!active.get(owner)) active.delete(owner);
      requests.delete(controller);
      release();
    }
  }
  app.post('/api/v1/systemone', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const controller = new AbortController();
    const closed = () => {
      if (!reply.raw.writableFinished) controller.abort();
    };
    reply.raw.on('close', closed);
    try {
      const valid = (value: unknown) =>
        typeof value === 'string' && /^[-\w]{1,128}$/.test(value) ? value : undefined;
      return await evaluate(actor(req).id, req.body, controller.signal, {
        traceId: valid(req.headers['x-lightmao-trace-id']),
        spanId: valid(req.headers['x-lightmao-span-id']),
      });
    } finally {
      reply.raw.off('close', closed);
    }
  });
  app.addHook('preClose', async () => {
    closing = true;
    const pending = [...requests.values()];
    for (const controller of requests.keys()) controller.abort();
    await Promise.all(pending);
  });
  return {
    evaluate,
    info: () => ({ alias: 'system-one', ...config(), configured: !!options.arkKey }),
  };
}
