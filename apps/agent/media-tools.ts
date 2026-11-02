import { Type } from 'typebox';
import { z } from 'zod';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { GenerationJob } from '../../packages/shared/types.ts';
import { createHash } from 'node:crypto';
import type { IsolatedExecutor } from './isolation.ts';
import { imageSize } from '../../packages/shared/image-size.ts';

export function createMediaTools(options: {
  apiUrl: string;
  token: string;
  projectId: string;
  sessionId: string;
  runId: string;
  allowed: string[];
  runIds: Set<string>;
  assetIds: Set<string>;
  report: (job: GenerationJob) => void;
  root: string;
  executor: IsolatedExecutor;
}): AgentTool[] {
  const result = (value: unknown, failed = false) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    details: failed ? { failed: true } : {},
  });
  async function call<T>(
    path: string,
    signal: AbortSignal | undefined,
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(options.apiUrl + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        authorization: `Bearer ${options.token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(35000)]),
      redirect: 'error',
    });
    const value = await response.json();
    if (!response.ok) throw Error(value.error || '媒体任务请求未完成');
    return value;
  }
  async function owned(id: string, signal?: AbortSignal) {
    const job = await call<GenerationJob>('/api/generations/' + encodeURIComponent(id), signal);
    if (
      job.projectId !== options.projectId ||
      (job.sessionId !== options.sessionId && !options.runIds.has(job.requestId.split(':')[0]))
    )
      throw Error('媒体任务不属于当前会话可追溯范围');
    return job;
  }
  const tools: AgentTool[] = [];
  for (const kind of ['image', 'video'] as const)
    tools.push({
      name: 'generate_' + kind,
      label: kind === 'image' ? '生成角色或场景图片' : '生成大招或过场视频',
      executionMode: 'sequential',
      description:
        kind === 'image'
          ? '使用已启用的方舟图片插件创建一次付费生成任务，返回jobId。background:transparent要求真实Alpha参考PNG；无参考时后台提供透明模板图生图。支持size:1K/2K。参考图必须为用户选定资料或当前会话生成产物。结果进入资料空间；不把提交称为生成完成。'
          : '使用Seedance2.5创建一次付费视频任务，默认4秒720p，最长12秒；支持用户选定或本会话生成图片作为首帧。返回同一jobId，用wait_media_job等待；未知结果不可再次生成。视频是媒体素材，不是骨骼动画或战斗代码。',
      parameters: Type.Object({
        prompt: Type.String({ maxLength: 6000 }),
        name: Type.String({ maxLength: 120 }),
        referenceAssetId: Type.Optional(Type.String()),
        ...(kind === 'video'
          ? {
              duration: Type.Optional(Type.Integer({ minimum: 4, maximum: 12 })),
              ratio: Type.Optional(
                Type.Union([Type.Literal('16:9'), Type.Literal('9:16'), Type.Literal('1:1')]),
              ),
            }
          : {}),
        ...(kind === 'image'
          ? {
              background: Type.Optional(
                Type.Union([Type.Literal('transparent'), Type.Literal('opaque')]),
              ),
              size: Type.Optional(
                Type.String({
                  maxLength: 16,
                  description: '1K/2K或明确宽x高，例如4列2行方格用2048x1024；总像素921600~4624220',
                }),
              ),
            }
          : {}),
      }),
      execute: async (id, raw, signal) => {
        try {
          signal?.throwIfAborted();
          const args = z
            .object({
              prompt: z.string().trim().min(1).max(6000),
              name: z.string().trim().min(1).max(120),
              referenceAssetId: z.uuid().optional(),
              background: z.enum(['transparent', 'opaque']).optional(),
              size: imageSize.optional(),
              duration: z.number().int().min(4).max(12).optional(),
              ratio: z.enum(['16:9', '9:16', '1:1']).optional(),
            })
            .strict()
            .parse(raw);
          if (args.referenceAssetId && !options.assetIds.has(args.referenceAssetId)) {
            const jobs = await call<GenerationJob[]>(
              '/api/generations?sessionId=' + encodeURIComponent(options.sessionId),
              signal,
            );
            if (
              !jobs.some((j) => j.asset?.id === args.referenceAssetId && j.status === 'completed')
            )
              throw Error('参考图未由用户选择，也不是当前会话生成的产物');
          }
          const job = await call<GenerationJob>('/api/generations', signal, {
            ...args,
            kind,
            projectId: options.projectId,
            sessionId: options.sessionId,
            requestId: options.runId + ':' + id,
          });
          options.report(job);
          return result({
            jobId: job.id,
            status: job.status,
            note: '后端已保存同一任务；使用wait_media_job等待或get_media_job查看，勿重复创建。',
          });
        } catch (e) {
          return result(
            { error: e instanceof Error ? e.message : '生成提交未完成', outcome: 'unknown' },
            true,
          );
        }
      },
    });
  for (const wait of [false, true])
    tools.push({
      name: wait ? 'wait_media_job' : 'get_media_job',
      label: wait ? '等待同一媒体任务' : '查看媒体任务',
      description: wait
        ? '有界等待已有任务，最多120秒，不调用创建接口；停止等待不会取消或退费上游任务。仍在生成时返回同一ID和真实阶段。'
        : '读取已有任务的真实阶段和产物引用，不重复提交、不编造完成百分比。',
      parameters: Type.Object({
        jobId: Type.String(),
        ...(wait ? { seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })) } : {}),
      }),
      execute: async (_, raw, signal) => {
        try {
          const args = z
            .object({ jobId: z.uuid(), seconds: z.number().int().min(1).max(120).optional() })
            .strict()
            .parse(raw);
          let job = await owned(args.jobId, signal);
          options.report(job);
          const end = Date.now() + (wait ? (args.seconds ?? 90) * 1000 : 0);
          while (
            wait &&
            Date.now() < end &&
            ['created', 'submitting', 'queued', 'running', 'ingesting'].includes(job.status)
          ) {
            signal?.throwIfAborted();
            job = await call<GenerationJob>(
              `/api/generations/${job.id}?wait=${Math.min(25000, Math.max(0, end - Date.now()))}`,
              signal,
            );
            options.report(job);
          }
          return result(
            {
              jobId: job.id,
              kind: job.kind,
              status: job.status,
              asset: job.asset,
              error: job.error,
              source: 'ark-generation-task',
            },
            ['failed', 'unknown'].includes(job.status),
          );
        } catch (e) {
          return result(
            { error: e instanceof Error ? e.message : '任务查询未完成', outcome: 'unknown' },
            true,
          );
        }
      },
    });
  tools.push({
    name: 'import_generated_asset',
    label: '将生成素材导入项目',
    executionMode: 'sequential',
    description:
      '把当前会话已完成任务的图片/视频按字节校验导入项目相对路径。需要文件创作插件和目录写授权，不覆盖内容不同的既有文件。只支持PNG/JPEG/WebP/MP4。',
    parameters: Type.Object({ jobId: Type.String(), path: Type.String({ maxLength: 400 }) }),
    execute: async (_, raw, signal) => {
      try {
        const args = z
          .object({ jobId: z.uuid(), path: z.string().min(1).max(400) })
          .strict()
          .parse(raw);
        const job = await owned(args.jobId, signal);
        if (job.status !== 'completed' || !job.asset) throw Error('生成产物尚未完成');
        const response = await fetch(options.apiUrl + `/api/assets/${job.asset.id}/download`, {
          headers: { authorization: `Bearer ${options.token}` },
          signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30000)]),
          redirect: 'error',
        });
        if (!response.ok || !response.body) throw Error('生成素材下载未完成');
        const reader = response.body.getReader();
        let length = 0;
        const chunks: Uint8Array[] = [];
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            length += next.value.byteLength;
            if (length > 20 * 1024 * 1024) throw Error('生成素材超出20MB导入上限');
            chunks.push(next.value);
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        const bytes = Buffer.concat(chunks);
        if (
          bytes.length !== job.asset.size ||
          createHash('sha256').update(bytes).digest('hex') !== job.asset.sha256
        )
          throw Error('生成素材与已记录字节不一致');
        return result(
          await options.executor.file(
            options.root,
            true,
            'import_asset',
            {
              path: args.path,
              base64: bytes.toString('base64'),
              mime: job.asset.mime,
              sha256: job.asset.sha256,
            },
            signal,
          ),
        );
      } catch (e) {
        return result({ error: e instanceof Error ? e.message : '素材导入未完成' }, true);
      }
    },
  });
  return tools.filter((t) => options.allowed.includes(t.name));
}
