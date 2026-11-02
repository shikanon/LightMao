import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Store } from '../../packages/shared/store.ts';
const namespace = z.enum(['artifacts', 'conversation', 'viewport']);
const fail = (statusCode: number, message: string): never => {
  throw Object.assign(Error(message), { statusCode });
};
function checkValue(value: unknown, depth = 0) {
  if (depth > 8) fail(400, '工作区状态层级过深');
  if (typeof value === 'string') {
    if (/^(?:blob:https?:\/\/|data:(?:image|video|audio)\/[^;,]+;base64,)/i.test(value))
      fail(400, '工作区只保存引用，不能保存媒体数据或临时URL');
    if (value.length > 16000) fail(400, '工作区文本过长');
  } else if (Array.isArray(value)) {
    if (value.length > 100) fail(400, '工作区状态条目过多');
    for (const item of value) checkValue(item, depth + 1);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key) || key.length > 100)
        fail(400, '工作区字段无效');
      checkValue(item, depth + 1);
    }
  } else if (typeof value === 'number' && !Number.isFinite(value)) fail(400, '工作区数值无效');
}
export function registerDesktopUiState(
  app: FastifyInstance,
  options: {
    store: Store;
    backend: string;
    actor: (req: object) => { id: string };
    access: (owner: string, session: string) => Promise<{ projectId: string }>;
  },
) {
  type State = { id: string; revision: number; value: Record<string, unknown>; updatedAt: string };
  const scope = async (req: { params: { id: string; namespace: string } }) => {
    const owner = options.actor(req).id;
    const ns = namespace.parse(req.params.namespace);
    const session = z.uuid().parse(req.params.id);
    const { projectId } = await options.access(owner, session);
    const id = createHash('sha256')
      .update(JSON.stringify([options.backend, owner, projectId, session, ns]))
      .digest('hex');
    return { owner, id };
  };
  app.get<{ Params: { id: string; namespace: string } }>(
    '/local/sessions/:id/ui-state/:namespace',
    async (req, reply) => {
      const { owner, id } = await scope(req);
      reply.header('Cache-Control', 'no-store');
      const value = options.store.get<State>('desktop-ui-state', id, owner);
      return value
        ? { revision: value.revision, value: value.value, updatedAt: value.updatedAt }
        : { revision: 0, value: null };
    },
  );
  app.put<{ Params: { id: string; namespace: string } }>(
    '/local/sessions/:id/ui-state/:namespace',
    { bodyLimit: 96 * 1024 },
    async (req) => {
      const { owner, id } = await scope(req);
      const input = z
        .object({
          revision: z.number().int().nonnegative(),
          value: z.record(z.string(), z.unknown()),
        })
        .strict()
        .parse(req.body);
      if (Buffer.byteLength(JSON.stringify(input.value)) > 64 * 1024)
        fail(400, '工作区状态超过64KiB');
      checkValue(input.value);
      options.store.db.exec('BEGIN IMMEDIATE');
      try {
        const previous = options.store.get<State>('desktop-ui-state', id, owner);
        if ((previous?.revision || 0) !== input.revision)
          fail(409, '工作区状态已更新，本地草稿保留；请重新核对后保存');
        const next = options.store.put('desktop-ui-state', owner, {
          id,
          value: input.value,
          revision: input.revision + 1,
          updatedAt: new Date().toISOString(),
        });
        options.store.db.exec('COMMIT');
        return { revision: next.revision, value: next.value, updatedAt: next.updatedAt };
      } catch (e) {
        options.store.db.exec('ROLLBACK');
        throw e;
      }
    },
  );
}
