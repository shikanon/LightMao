import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { Store } from '../../packages/shared/store.ts';
import {
  now,
  type Asset,
  type AssetFolder,
  type User,
  type StorageInfo,
} from '../../packages/shared/types.ts';
import type { ObjectRef, ObjectStorage } from './object-storage.ts';

export type StoredAsset = Asset & { object?: ObjectRef };
const fail = (statusCode: number, message: string): never => {
  throw Object.assign(new Error(message), { statusCode });
};
export const safeAsset = ({ object: _, ...asset }: StoredAsset): Asset => asset;
const mimeForPreview = (name: string) => {
  const ext = name.split('.').at(-1)?.toLowerCase() || '';
  return (
    {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      gif: 'image/gif',
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      ogg: 'audio/ogg',
      mp4: 'video/mp4',
      webm: 'video/webm',
    } as Record<string, string>
  )[ext];
};

export class AssetService {
  private locks = new Map<string, Promise<unknown>>();
  constructor(
    readonly store: Store,
    readonly local: ObjectStorage,
    readonly primary: ObjectStorage = local,
  ) {
    for (const transfer of store.list<{ id: string; ownerId: string; status: string }>(
      'asset-transfer',
    )) {
      if (transfer.status === 'uploading')
        store.put('asset-transfer', transfer.ownerId, { ...transfer, status: 'unknown' });
    }
  }
  readonly quotaBytes = 200 * 1024 * 1024;
  readonly fileLimitBytes = 20 * 1024 * 1024;
  info(userId?: string): StorageInfo {
    return {
      driver: this.primary.driver,
      label: this.primary.driver === 'oss' ? '阿里云 OSS' : '本地存储',
      quotaBytes: this.quotaBytes,
      fileLimitBytes: this.fileLimitBytes,
      usedBytes: userId
        ? this.store.list<Asset>('asset', userId).reduce((n, a) => n + a.size, 0)
        : undefined,
    };
  }
  list(userId: string, deleted = false) {
    return this.store
      .list<StoredAsset>('asset', userId)
      .filter((a) => !!a.deletedAt === deleted)
      .map(safeAsset);
  }
  folders(userId: string) {
    return this.store.list<AssetFolder>('asset-folder', userId);
  }
  get(userId: string, id: string, deleted = false) {
    const a = this.store.get<StoredAsset>('asset', id, userId);
    if (!a || !!a.deletedAt !== deleted) return fail(404, '资料不存在');
    return a;
  }
  folder(userId: string, id?: string) {
    if (!id) return undefined;
    return this.store.get<AssetFolder>('asset-folder', id, userId) || fail(404, '文件夹不存在');
  }
  storage(asset: StoredAsset) {
    const ref = asset.object || { driver: 'local' as const, key: asset.id };
    const driver = ref.driver === 'local' ? this.local : this.primary;
    if (driver.driver !== ref.driver)
      return fail(503, '此资料的云存储当前不可用，请检查服务端配置');
    return { driver, ref };
  }
  async read(asset: StoredAsset) {
    const { driver, ref } = this.storage(asset);
    return driver.get(ref.key);
  }
  async stream(asset: StoredAsset) {
    const { driver, ref } = this.storage(asset);
    return driver.stream(ref.key);
  }
  async upload(
    userId: string,
    name: string,
    mime: string,
    data: Buffer,
    folderId?: string,
    intentId?: string,
  ) {
    const previous = this.locks.get(userId) || Promise.resolve();
    const work = previous
      .catch(() => {})
      .then(async () => {
        if (intentId) {
          z.uuid().parse(intentId);
          const existing = this.store.get<StoredAsset>('asset', intentId, userId);
          if (existing) {
            if (
              existing.deletedAt ||
              existing.sha256 !== createHash('sha256').update(data).digest('hex') ||
              existing.name !==
                (name.replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 180) || '未命名文件') ||
              existing.mime !== mime
            )
              return fail(409, '该上传意图对应的文件名、类型、内容或删除状态已变化');
            return safeAsset(existing);
          }
          if (
            this.store.get('asset', intentId) ||
            (this.store.get('asset-transfer', intentId) &&
              !this.store.get('asset-transfer', intentId, userId))
          )
            return fail(409, '上传意图已被使用，请重新选择文件');
          if (this.store.get('asset-transfer', intentId, userId))
            return fail(409, '产物上传结果尚未核对，未重复提交');
        }
        this.folder(userId, folderId);
        if (data.length > this.fileLimitBytes) return fail(413, '单个文件最多 20 MB');
        const used =
          this.store.list<Asset>('asset', userId).reduce((n, a) => n + a.size, 0) +
          this.store
            .list<{ asset: Asset; status: string }>('asset-transfer', userId)
            .filter((t) => t.status !== 'failed')
            .reduce((n, t) => n + t.asset.size, 0);
        if (used + data.length > this.quotaBytes)
          return fail(413, '资料空间已满，请清理回收站或联系管理员');
        const id = intentId || randomUUID();
        const asset: StoredAsset = {
          id,
          name: name.replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 180) || '未命名文件',
          mime,
          size: data.length,
          sha256: createHash('sha256').update(data).digest('hex'),
          createdAt: now(),
          folderId,
          object: { driver: this.primary.driver, key: `${userId}/${id}` },
        };
        // Keep the intended object key even if a network failure leaves the PUT outcome unknown.
        this.store.put('asset-transfer', userId, {
          id,
          ownerId: userId,
          asset,
          status: 'uploading',
          at: now(),
        });
        try {
          await this.primary.put(asset.object!.key, data, mime);
        } catch {
          this.store.put('asset-transfer', userId, {
            id,
            ownerId: userId,
            asset,
            status: 'unknown',
            at: now(),
          });
          return fail(503, '上传结果待核对，请刷新资料空间后查看；不要重复提交同一文件');
        }
        this.store.put('asset', userId, asset);
        this.store.remove('asset-transfer', id, userId);
        return safeAsset(asset);
      });
    this.locks.set(userId, work);
    try {
      return await work;
    } finally {
      if (this.locks.get(userId) === work) this.locks.delete(userId);
    }
  }
  async reconcile(userId: string, onlyId?: string) {
    for (const transfer of this.store.list<{ id: string; asset: StoredAsset; status: string }>(
      'asset-transfer',
      userId,
    )) {
      if (transfer.status !== 'unknown' || (onlyId && transfer.id !== onlyId)) continue;
      try {
        const data = await this.read(transfer.asset);
        if (
          data.length !== transfer.asset.size ||
          createHash('sha256').update(data).digest('hex') !== transfer.asset.sha256
        )
          continue;
        this.store.put('asset', userId, transfer.asset);
        this.store.remove('asset-transfer', transfer.id, userId);
      } catch (error) {
        const e = error as { status?: number; code?: string };
        if (e.status === 404 || e.code === 'NoSuchKey' || e.code === 'ENOENT')
          this.store.put('asset-transfer', userId, { ...transfer, status: 'failed' });
        /* Other unverified transfers stay visible; refreshing never repeats a PUT. */
      }
    }
  }
}

export function registerAssetRoutes(
  app: FastifyInstance,
  service: AssetService,
  actor: (req: FastifyRequest) => User,
  audit: (userId: string, action: string, detail: string) => unknown,
) {
  const { store } = service;
  app.post('/api/assets', async (req) => {
    const user = actor(req),
      file = await req.file();
    if (!file) return fail(400, '请选择一个文件');
    const data = await file.toBuffer();
    const field = file.fields.folderId;
    const folderId =
      field && !Array.isArray(field) && 'value' in field
        ? z.string().max(100).parse(field.value) || undefined
        : undefined;
    const header = req.headers['x-lightmao-upload-intent'];
    const intent = header === undefined ? undefined : z.uuid().parse(header);
    const asset = await service.upload(
      user.id,
      file.filename,
      file.mimetype,
      data,
      folderId,
      intent,
    );
    audit(user.id, 'asset.upload', asset.name);
    return asset;
  });
  app.get('/api/assets/trash', async (req) => service.list(actor(req).id, true));
  app.get('/api/assets/transfers', async (req) =>
    store
      .list<{ id: string; asset: StoredAsset; status: string; at: string }>(
        'asset-transfer',
        actor(req).id,
      )
      .map((t) => ({
        id: t.id,
        name: t.asset.name,
        size: t.asset.size,
        status: t.status,
        at: t.at,
      })),
  );
  app.post('/api/assets/reconcile', async (req) => {
    await service.reconcile(actor(req).id);
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>('/api/assets/transfers/:id', async (req) => {
    const userId = actor(req).id,
      t = store.get<{ id: string; status: string }>('asset-transfer', req.params.id, userId);
    if (!t) return fail(404, '上传记录不存在');
    if (t.status !== 'failed') return fail(409, '请先核查原对象，结果未确认时不能丢弃记录');
    store.remove('asset-transfer', t.id, userId);
    return { ok: true };
  });
  app.post('/api/asset-folders', async (req) => {
    const input = z
      .object({ name: z.string().trim().min(1).max(80), parentId: z.string().optional() })
      .parse(req.body);
    service.folder(actor(req).id, input.parentId);
    const folder: AssetFolder = { id: randomUUID(), ...input, createdAt: now() };
    store.put('asset-folder', actor(req).id, folder);
    audit(actor(req).id, 'asset.folder.create', folder.name);
    return folder;
  });
  app.patch<{ Params: { id: string } }>('/api/asset-folders/:id', async (req) => {
    const userId = actor(req).id,
      folder = service.folder(userId, req.params.id)!;
    const input = z
      .object({
        name: z.string().trim().min(1).max(80).optional(),
        parentId: z.string().nullable().optional(),
      })
      .parse(req.body);
    let parent = service.folder(userId, input.parentId || undefined);
    for (let depth = 0; parent; depth++) {
      if (parent.id === folder.id || depth > 100)
        return fail(409, '文件夹不能移动到自身或子文件夹');
      parent = service.folder(userId, parent.parentId);
    }
    const next = {
      ...folder,
      ...input,
      parentId: input.parentId === null ? undefined : (input.parentId ?? folder.parentId),
    };
    store.put('asset-folder', userId, next);
    return next;
  });
  app.delete<{ Params: { id: string } }>('/api/asset-folders/:id', async (req) => {
    const userId = actor(req).id,
      folder = service.folder(userId, req.params.id)!;
    if (
      service.folders(userId).some((f) => f.parentId === folder.id) ||
      store.list<Asset>('asset', userId).some((a) => a.folderId === folder.id)
    )
      return fail(409, '请先移走文件与子文件夹，包括回收站中的文件');
    store.remove('asset-folder', folder.id, userId);
    return { ok: true };
  });
  app.patch<{ Params: { id: string } }>('/api/assets/:id', async (req) => {
    const userId = actor(req).id,
      a = service.get(userId, req.params.id);
    const input = z
      .object({
        name: z
          .string()
          .trim()
          .min(1)
          .max(180)
          .refine((s) => !/[\\/\u0000-\u001f]/.test(s))
          .optional(),
        folderId: z.string().nullable().optional(),
      })
      .strict()
      .parse(req.body);
    service.folder(userId, input.folderId || undefined);
    const next = {
      ...a,
      ...input,
      folderId: input.folderId === null ? undefined : (input.folderId ?? a.folderId),
      updatedAt: now(),
    };
    store.put('asset', userId, next);
    audit(userId, 'asset.update', next.name);
    return safeAsset(next);
  });
  app.get<{ Params: { id: string } }>('/api/assets/:id/preview', async (req) => {
    const a = service.get(actor(req).id, req.params.id);
    if (!/\.(md|txt|json|csv|ts|js|cs|gd|yaml|yml|shader|glsl|godot)$/i.test(a.name))
      return { text: null, asset: safeAsset(a), previewMime: mimeForPreview(a.name) || null };
    const data = await service.read(a);
    return {
      text: data.subarray(0, 64000).toString('utf8'),
      truncated: data.length > 64000,
      asset: safeAsset(a),
    };
  });
  app.get<{ Params: { id: string } }>('/api/assets/:id/content', async (req, reply) => {
    const a = service.get(actor(req).id, req.params.id),
      mime = mimeForPreview(a.name);
    if (!mime) return fail(415, '此格式请下载查看');
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, no-store')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .type(mime);
    return reply.send(await service.stream(a));
  });
  app.get<{ Params: { id: string } }>('/api/assets/:id/download', async (req, reply) => {
    const a = service.get(actor(req).id, req.params.id);
    reply
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(a.name)}`)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, no-store')
      .type('application/octet-stream');
    return reply.send(await service.stream(a));
  });
  app.delete<{ Params: { id: string } }>('/api/assets/:id', async (req) => {
    const userId = actor(req).id,
      a = service.get(userId, req.params.id);
    store.put('asset', userId, { ...a, deletedAt: now() });
    audit(userId, 'asset.trash', a.name);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/assets/:id/restore', async (req) => {
    const userId = actor(req).id,
      a = service.get(userId, req.params.id, true);
    store.put('asset', userId, { ...a, deletedAt: undefined });
    audit(userId, 'asset.restore', a.name);
    return safeAsset({ ...a, deletedAt: undefined });
  });
  app.delete<{ Params: { id: string } }>('/api/assets/:id/purge', async (req) => {
    const userId = actor(req).id,
      a = service.get(userId, req.params.id, true),
      { driver, ref } = service.storage(a);
    await driver.remove(ref.key);
    store.remove('asset', a.id, userId);
    audit(userId, 'asset.purge', a.name);
    return { ok: true };
  });
}
