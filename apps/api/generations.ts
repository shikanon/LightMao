import type { FastifyInstance } from 'fastify';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import type { Store } from '../../packages/shared/store.ts';
import { now, type GenerationJob, type User, type Usage } from '../../packages/shared/types.ts';
import type { AssetService } from './assets.ts';
import { safeAsset } from './assets.ts';
import { boundedJson } from './decisions.ts';
import { decodePng, encodePng } from '../../packages/shared/rgba-png.ts';
import { imageSize } from '../../packages/shared/image-size.ts';

const fail = (statusCode: number, message: string): never => {
  throw Object.assign(new Error(message), { statusCode });
};
export const generationInput = z
  .object({
    requestId: z.string().regex(/^[\w:-]{1,160}$/),
    kind: z.enum(['image', 'video']),
    projectId: z.uuid(),
    sessionId: z.uuid(),
    name: z.string().trim().min(1).max(120),
    prompt: z.string().trim().min(1).max(6000),
    referenceAssetId: z.uuid().optional(),
    background: z.enum(['transparent', 'opaque']).optional(),
    size: imageSize.optional(),
    duration: z.number().int().min(4).max(12).default(4),
    ratio: z.enum(['16:9', '9:16', '1:1']).default('16:9'),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.kind === 'video' && (input.background !== undefined || input.size !== undefined))
      ctx.addIssue({ code: 'custom', message: 'background/size仅用于图片生成' });
  });
type GenerationInput = z.infer<typeof generationInput>;
type Job = GenerationJob & {
  ownerId: string;
  input: GenerationInput;
  inputHash: string;
  assetId: string;
  resultPath?: string;
  resultSha256?: string;
  resultMime?: string;
  sourceUrl?: string;
  pollAfter?: number;
};
export interface GenerationOptions {
  arkKey?: string;
  arkBase?: string;
  imageModelId?: string;
  videoModelId?: string;
  dataDir: string;
  pollMs?: number;
  authorize?: (owner: string, kind: 'image' | 'video') => void;
}
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const view = ({
  ownerId: _,
  input: __,
  inputHash: ___,
  assetId: ____,
  resultPath: _p,
  resultSha256: _h,
  resultMime: _m,
  sourceUrl: _s,
  pollAfter: _a,
  ...job
}: Job): GenerationJob => job;
const pending = new Set<GenerationJob['status']>([
  'created',
  'submitting',
  'queued',
  'running',
  'ingesting',
]);
function mediaType(data: Buffer, kind: 'image' | 'video') {
  if (
    kind === 'image' &&
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'image/png';
  if (kind === 'image' && data[0] === 255 && data[1] === 216 && data[2] === 255)
    return 'image/jpeg';
  if (kind === 'video' && data.length > 12 && data.toString('ascii', 4, 8) === 'ftyp')
    return 'video/mp4';
  throw Error('生成产物的媒体类型与请求不符');
}
async function boundedBytes(response: Response, limit: number) {
  if (!response.ok || !response.body) throw Error('产物下载未完成');
  if (Number(response.headers.get('content-length')) > limit)
    throw Error('产物超过资料空间单文件限制');
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) throw Error('产物超过资料空间单文件限制');
      chunks.push(next.value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export class GenerationService {
  private active = new Map<string, Promise<void>>();
  private controllers = new Set<AbortController>();
  private closing = false;
  private timer: ReturnType<typeof setInterval>;
  constructor(
    private store: Store,
    private assets: AssetService,
    private options: GenerationOptions,
  ) {
    for (const kind of ['image', 'video'] as const)
      if (!store.get('config', kind + '-model'))
        store.put('config', 'system', {
          id: kind + '-model',
          enabled: true,
          modelId:
            kind === 'image'
              ? options.imageModelId || 'doubao-seedream-5-0-pro-260628'
              : options.videoModelId || 'doubao-seedance-2-5-260628',
        });
    for (const job of store.list<Job>('generation')) {
      if (job.status === 'submitting')
        this.save({
          ...job,
          status: 'unknown',
          error: '服务在提交期间中断，未自动重新创建收费任务。',
        });
      if (job.status === 'ingesting')
        this.save({ ...job, status: 'unknown', error: '产物入库期间中断，请核对同一上传意图。' });
    }
    this.timer = setInterval(() => this.tick(), options.pollMs ?? 2500);
    this.timer.unref();
  }
  private save(job: Job) {
    return this.store.put('generation', job.ownerId, { ...job, updatedAt: now() });
  }
  info() {
    return Object.fromEntries(
      (['image', 'video'] as const).map((kind) => {
        const config = this.route(kind);
        return [
          kind,
          {
            alias: kind,
            modelId: config.modelId,
            enabled: config.enabled,
            configured: !!this.options.arkKey,
          },
        ];
      }),
    );
  }
  private route(kind: 'image' | 'video') {
    return this.store.get<{ id: string; modelId: string; enabled: boolean }>(
      'config',
      kind + '-model',
    )!;
  }
  get(owner: string, id: string) {
    return view(this.owned(owner, id));
  }
  private owned(owner: string, id: string) {
    return this.store.get<Job>('generation', id, owner) || fail(404, '生成任务不存在');
  }
  list(owner: string, session?: string) {
    return this.store
      .list<Job>('generation', owner)
      .filter((j) => !session || j.sessionId === session)
      .filter((j, i, all) => i >= all.length - 50 || !['completed', 'failed'].includes(j.status))
      .reverse()
      .map(view);
  }
  create(owner: string, raw: unknown) {
    const input = generationInput.parse(raw),
      inputHash = hash(JSON.stringify(input));
    const existing = this.store
      .list<Job>('generation', owner)
      .find((j) => j.requestId === input.requestId);
    if (existing) {
      if (existing.inputHash !== inputHash) fail(409, '同一生成请求 ID 的内容已变化');
      return view(existing);
    }
    const uncertain = this.store
      .list<Job>('generation', owner)
      .find(
        (j) =>
          j.status === 'unknown' &&
          j.sessionId === input.sessionId &&
          j.kind === input.kind &&
          j.input.prompt === input.prompt &&
          j.input.referenceAssetId === input.referenceAssetId &&
          j.input.duration === input.duration &&
          j.input.ratio === input.ratio,
      );
    if (uncertain) return view(uncertain);
    if (this.closing) fail(503, '生成服务正在退出');
    this.options.authorize?.(owner, input.kind);
    const config = this.route(input.kind);
    if (!config.enabled || !this.options.arkKey) fail(503, '对应方舟生成模型尚未配置或已停用');
    const jobs = this.store.list<Job>('generation', owner);
    if (jobs.filter((j) => pending.has(j.status)).length >= 2)
      fail(429, '最多同时运行两个媒体生成任务');
    if (jobs.filter((j) => Date.now() - Date.parse(j.createdAt) < 60000).length >= 10)
      fail(429, '媒体生成请求过于频繁');
    if ((this.assets.info(owner).usedBytes || 0) >= this.assets.quotaBytes)
      fail(413, '资料空间已满，请先整理空间');
    if (input.referenceAssetId) {
      const asset = this.assets.get(owner, input.referenceAssetId);
      if (
        !['image/png', 'image/jpeg', 'image/webp'].includes(asset.mime) ||
        asset.size > 8 * 1024 * 1024
      )
        fail(400, '参考资料必须是8MB内PNG/JPEG/WebP图片');
    }
    const job = this.save({
      id: randomUUID(),
      ownerId: owner,
      projectId: input.projectId,
      sessionId: input.sessionId,
      kind: input.kind,
      name: input.name,
      model: config.modelId,
      status: 'created',
      createdAt: now(),
      updatedAt: now(),
      requestId: input.requestId,
      input,
      inputHash,
      assetId: randomUUID(),
    });
    queueMicrotask(() => this.tick());
    return view(job);
  }
  private endpoint(path: string) {
    return `${(this.options.arkBase || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/$/, '')}/${path}`;
  }
  private async request(path: string, body: unknown, controller: AbortController) {
    const response = await fetch(this.endpoint(path), {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${this.options.arkKey}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Object.assign(Error('方舟生成请求被拒绝'), { upstreamStatus: response.status });
    }
    return boundedJson(response, 30 * 1024 * 1024);
  }
  private async reference(job: Job) {
    if (!job.input.referenceAssetId) {
      // Ark transparent mode requires image-to-image with an alpha PNG. This is a
      // deterministic blank template, not an upload of any unselected project file.
      if (job.kind === 'image' && job.input.background === 'transparent')
        return (
          'data:image/png;base64,' +
          encodePng({ width: 1024, height: 1024, data: new Uint8Array(1024 * 1024 * 4) }).toString(
            'base64',
          )
        );
      return undefined;
    }
    const asset = this.assets.get(job.ownerId, job.input.referenceAssetId);
    const bytes = await this.assets.read(asset);
    if (job.kind === 'image' && job.input.background === 'transparent') {
      if (asset.mime !== 'image/png')
        throw Object.assign(
          Error('方舟透明模式参考图须为带真实Alpha的PNG，请先抠图或使用透明模板'),
          { preSubmit: true },
        );
      let image;
      try {
        image = decodePng(bytes);
      } catch {
        throw Object.assign(Error('透明参考PNG无法安全解码，未提交付费生成'), { preSubmit: true });
      }
      let transparent = false;
      for (let i = 3; i < image.data.length; i += 4)
        if (image.data[i] < 255) {
          transparent = true;
          break;
        }
      if (!transparent)
        throw Object.assign(Error('参考PNG没有透明像素，未提交付费生成；请先抠图或使用透明模板'), {
          preSubmit: true,
        });
    }
    return `data:${asset.mime};base64,${bytes.toString('base64')}`;
  }
  private async cache(job: Job, bytes: Buffer) {
    if (!bytes.length || bytes.length > this.assets.fileLimitBytes)
      throw Error('生成产物大小不符合资料限制');
    if (job.kind === 'image' && job.input.background === 'transparent') {
      try {
        const image = decodePng(bytes);
        let clear = 0,
          solid = 0;
        for (let i = 3; i < image.data.length; i += 4) {
          if (image.data[i] < 255) clear++;
          if (image.data[i] > 0) solid++;
        }
        if (!clear || !solid) throw Error('透明输出未包含有效的前景与透明像素');
      } catch {
        throw Object.assign(Error('方舟返回图片未通过真实Alpha检查，未将其标为透明素材'), {
          knownOutput: true,
        });
      }
    }
    const mime = mediaType(bytes, job.kind),
      dir = join(this.options.dataDir, 'generation-cache');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, job.id + '.bin'),
      temp = path + '.' + randomUUID() + '.tmp';
    job = this.save({
      ...job,
      resultPath: path,
      resultMime: mime,
      resultSha256: hash(bytes),
      status: 'ingesting',
    });
    const file = await open(temp, 'wx', 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
      await file.close();
      await rename(temp, path);
    } finally {
      await file.close().catch(() => {});
      await unlink(temp).catch(() => {});
    }
    return job;
  }
  private async ingest(job: Job) {
    const bytes = await readFile(job.resultPath!);
    if (hash(bytes) !== job.resultSha256) throw Error('生成产物缓存哈希不一致');
    const ext =
      job.resultMime === 'image/png' ? 'png' : job.resultMime === 'image/jpeg' ? 'jpg' : 'mp4';
    const name = job.name.replace(/\.(png|jpg|jpeg|mp4)$/i, '') + '.' + ext;
    const asset = await this.assets.upload(
      job.ownerId,
      name,
      job.resultMime!,
      bytes,
      undefined,
      job.assetId,
    );
    this.save({ ...job, status: 'completed', asset, error: undefined, sourceUrl: undefined });
  }
  private async download(job: Job, controller: AbortController) {
    const url = new URL(job.sourceUrl!);
    const fixture =
      this.options.arkBase &&
      url.origin === new URL(this.options.arkBase).origin &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (
      url.username ||
      url.password ||
      (!fixture &&
        (url.protocol !== 'https:' ||
          !['volces.com', 'byteimg.com', 'doubaocdn.com', 'volccdn.com', 'ibytedtos.com'].some(
            (h) => url.hostname === h || url.hostname.endsWith('.' + h),
          )))
    )
      throw Error('产物下载地址不属于已支持的方舟来源');
    return boundedBytes(
      await fetch(url, { redirect: 'error', signal: controller.signal, headers: {} }),
      this.assets.fileLimitBytes,
    );
  }
  private async work(initial: Job) {
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 180000);
    timeout.unref();
    let job = this.owned(initial.ownerId, initial.id),
      usage: Usage | undefined;
    try {
      if (job.status === 'created') {
        // Persist before any provider POST. Unknown submissions never re-enter this branch.
        job = this.save({ ...job, status: 'submitting' });
        usage = {
          id: job.id,
          userId: job.ownerId,
          model: job.model,
          capability: job.kind,
          status: 'running',
          durationMs: 0,
          at: now(),
        };
        this.store.put('usage', 'system', usage);
        const reference = await this.reference(job);
        if (job.kind === 'image') {
          const raw = await this.request(
            'images/generations',
            {
              model: job.model,
              prompt: job.input.prompt,
              size: job.input.size || '2K',
              output_format: 'png',
              ...(job.input.background ? { background: job.input.background } : {}),
              response_format: 'b64_json',
              watermark: false,
              ...(reference ? { image: reference } : {}),
            },
            controller,
          );
          const result = z
            .object({
              data: z
                .array(
                  z.object({
                    b64_json: z
                      .string()
                      .min(8)
                      .max(28 * 1024 * 1024),
                  }),
                )
                .length(1),
              usage: z
                .object({ total_tokens: z.number().int().nonnegative().optional() })
                .optional(),
            })
            .parse(raw);
          const encoded = result.data[0].b64_json;
          if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw Error('图片响应不是有效Base64');
          usage.status = 'completed';
          usage.totalTokens = result.usage?.total_tokens;
          job = await this.cache(job, Buffer.from(encoded, 'base64'));
        } else {
          const content: unknown[] = [{ type: 'text', text: job.input.prompt }];
          if (reference)
            content.push({ type: 'image_url', image_url: { url: reference }, role: 'first_frame' });
          const raw = await this.request(
            'contents/generations/tasks',
            {
              model: job.model,
              content,
              duration: job.input.duration,
              resolution: '720p',
              ratio: reference ? 'adaptive' : job.input.ratio,
              watermark: false,
              generate_audio: false,
            },
            controller,
          );
          const { id } = z.object({ id: z.string().regex(/^[\w-]{1,160}$/) }).parse(raw);
          job = this.save({
            ...job,
            upstreamTaskId: id,
            status: 'queued',
            pollAfter: Date.now() + (this.options.pollMs ?? 2500),
          });
          usage.status = 'submitted';
        }
      } else if (job.upstreamTaskId && ['queued', 'running'].includes(job.status)) {
        const raw = await this.request(
          'contents/generations/tasks/' + encodeURIComponent(job.upstreamTaskId),
          undefined,
          controller,
        );
        const result = z
          .object({
            id: z.string(),
            status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired']),
            content: z.object({ video_url: z.string().optional() }).optional(),
            usage: z.object({ total_tokens: z.number().int().nonnegative().optional() }).optional(),
          })
          .parse(raw);
        if (result.id !== job.upstreamTaskId) throw Error('上游返回了不同任务ID');
        usage = this.store.get<Usage>('usage', job.id);
        if (['failed', 'cancelled', 'expired'].includes(result.status)) {
          this.save({
            ...job,
            status: 'failed',
            error: '方舟视频任务终止（' + result.status + '）',
          });
          if (usage) usage.status = 'failed';
          return;
        }
        if (result.status === 'succeeded') {
          if (usage) usage.status = 'completed';
          if (!result.content?.video_url) throw Error('视频完成但未返回产物地址');
          job = this.save({ ...job, sourceUrl: result.content.video_url, status: 'ingesting' });
          job = await this.cache(job, await this.download(job, controller));
        } else
          job = this.save({
            ...job,
            status: result.status as 'queued' | 'running',
            pollAfter: Date.now() + (this.options.pollMs ?? 2500),
          });
        if (usage && result.usage?.total_tokens !== undefined)
          usage.totalTokens = result.usage.total_tokens;
      }
      if (job.status === 'ingesting') await this.ingest(job);
      const current = this.owned(job.ownerId, job.id);
      usage ||= this.store.get<Usage>('usage', job.id);
      if (usage && current.status === 'completed') usage.status = 'completed';
    } catch (error) {
      const status = (error as { upstreamStatus?: number }).upstreamStatus;
      const definiteLocalFailure =
        (error as { preSubmit?: boolean; knownOutput?: boolean }).preSubmit ||
        (error as { knownOutput?: boolean }).knownOutput;
      const current = this.owned(job.ownerId, job.id);
      if (current.status === 'submitting')
        this.save({
          ...current,
          status: status || definiteLocalFailure ? 'failed' : 'unknown',
          error: definiteLocalFailure
            ? (error as Error).message
            : status
              ? `方舟生成提交被拒绝（HTTP ${status}）`
              : '生成提交结果未确认，未自动重复收费提交。',
        });
      else if (current.status === 'ingesting')
        this.save({
          ...current,
          status: 'unknown',
          error: '产物尚未完成入库；请核对同一任务，不要重新生成。',
        });
      else if (current.upstreamTaskId)
        this.save({
          ...current,
          pollAfter: Date.now() + 10000,
          error: '本次查询未完成，将只查询已有任务ID，不重新创建。',
        });
      usage ||= this.store.get<Usage>('usage', job.id);
      if (
        usage &&
        usage.status !== 'completed' &&
        ['failed', 'unknown'].includes(this.owned(job.ownerId, job.id).status)
      )
        usage.status = this.owned(job.ownerId, job.id).status;
      if (usage && status) {
        usage.upstreamStatus = status;
        usage.failureReason = 'upstream_error';
      }
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
      if (usage) {
        usage.durationMs = Date.now() - Date.parse(usage.at);
        this.store.put('usage', 'system', usage);
      }
    }
  }
  tick() {
    if (this.closing) return;
    for (const job of this.store.list<Job>('generation'))
      if (
        this.active.size < 4 &&
        ['created', 'queued', 'running', 'ingesting'].includes(job.status) &&
        !this.active.has(job.id) &&
        (!job.pollAfter || job.pollAfter <= Date.now())
      ) {
        const promise = this.work(job).finally(() => this.active.delete(job.id));
        this.active.set(job.id, promise);
      }
  }
  async reconcile(owner: string, id: string) {
    let job = this.owned(owner, id);
    if (job.status !== 'unknown' || !job.resultPath) return view(job);
    await this.assets.reconcile(owner, job.assetId);
    const asset = this.store.get<{ id: string; sha256: string }>('asset', job.assetId, owner);
    if (asset && asset.sha256 === job.resultSha256)
      job = this.save({
        ...job,
        status: 'completed',
        asset: safeAsset(this.assets.get(owner, job.assetId)),
        error: undefined,
      });
    return view(job);
  }
  async wait(owner: string, id: string, ms: number) {
    const deadline = Date.now() + Math.min(ms, 25000);
    do {
      const job = this.get(owner, id);
      if (!pending.has(job.status) || Date.now() >= deadline) return job;
      await delay(200);
    } while (!this.closing);
    return this.get(owner, id);
  }
  async close() {
    this.closing = true;
    clearInterval(this.timer);
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.active.values()]);
  }
}
export function registerGenerationRoutes(
  app: FastifyInstance,
  service: GenerationService,
  actor: (req: object) => User,
) {
  app.post('/api/generations', async (req, reply) => {
    reply.header('Cache-Control', 'no-store').code(202);
    return service.create(actor(req).id, req.body);
  });
  app.get<{ Querystring: { sessionId?: string } }>('/api/generations', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const q = z.object({ sessionId: z.uuid().optional() }).parse(req.query);
    return service.list(actor(req).id, q.sessionId);
  });
  app.get<{ Params: { id: string }; Querystring: { wait?: string } }>(
    '/api/generations/:id',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      const q = z
        .object({ wait: z.coerce.number().int().min(0).max(25000).default(0) })
        .parse(req.query);
      return q.wait
        ? service.wait(actor(req).id, req.params.id, q.wait)
        : service.get(actor(req).id, req.params.id);
    },
  );
  app.post<{ Params: { id: string } }>('/api/generations/:id/reconcile', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return service.reconcile(actor(req).id, req.params.id);
  });
  app.addHook('preClose', async () => service.close());
}
