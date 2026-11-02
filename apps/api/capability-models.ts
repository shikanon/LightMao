import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Store } from '../../packages/shared/store.ts';
import type { User } from '../../packages/shared/types.ts';
export function registerCapabilityModels(
  app: FastifyInstance,
  store: Store,
  actor: (req: object) => User,
  configured: boolean,
  audit: (user: string, action: string, detail: string) => unknown,
) {
  const kinds = ['decision', 'image', 'video', 'vision', 'audio'] as const;
  const read = (kind: (typeof kinds)[number]) => {
    const value = store.get<{ id: string; modelId: string; enabled: boolean; revision?: number }>(
      'config',
      kind + '-model',
    )!;
    return {
      kind,
      modelId: value.modelId,
      enabled: value.enabled,
      revision: value.revision || 0,
      configured,
    };
  };
  app.get('/api/admin/capability-models', async () => kinds.map(read));
  app.patch<{ Params: { kind: string } }>('/api/admin/capability-models/:kind', async (req) => {
    const kind = z.enum(kinds).parse(req.params.kind),
      input = z
        .object({
          modelId: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9][\w.-]{0,159}$/),
          enabled: z.boolean(),
          revision: z.number().int().min(0),
        })
        .strict()
        .parse(req.body);
    store.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = read(kind);
      if (previous.revision !== input.revision)
        throw Object.assign(Error('模型路由已变化，草稿已保留；请刷新后重新核对'), {
          statusCode: 409,
        });
      store.put('config', 'system', {
        id: kind + '-model',
        modelId: input.modelId,
        enabled: input.enabled,
        revision: previous.revision + 1,
      });
      audit(actor(req).id, 'capability-model.update', kind + ' 路由已更新');
      store.db.exec('COMMIT');
      return read(kind);
    } catch (error) {
      store.db.exec('ROLLBACK');
      throw error;
    }
  });
}
