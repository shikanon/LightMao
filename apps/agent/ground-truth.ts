import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Store } from '../../packages/shared/store.ts';
import type { GroundTruthEvidence, MonitorSource } from '../../packages/shared/collaboration.ts';
import { BrowserDriver } from './browser-driver.ts';
import { resourcePath, overlaps } from './resource-leases.ts';

const url = z
  .url()
  .max(2048)
  .refine((value) => {
    const u = new URL(value);
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.hash;
  }, '监控地址只支持无凭据的 HTTP(S) URL');
export const monitorInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    pageUrl: url,
    healthUrl: url,
    checks: z
      .array(
        z
          .object({
            path: z.string().regex(/^[\w.-]{1,120}$/),
            op: z.enum(['equals', 'lte']),
            value: z.union([z.string().max(200), z.number().finite(), z.boolean()]),
          })
          .strict(),
      )
      .min(1)
      .max(12),
    maxAgeSeconds: z.number().int().min(5).max(120).default(30),
    protectedPaths: z
      .array(
        z.string().refine((value) => {
          try {
            resourcePath(value);
            return true;
          } catch {
            return false;
          }
        }),
      )
      .max(16)
      .default([]),
  })
  .strict()
  .refine(
    (v) => new URL(v.pageUrl).origin === new URL(v.healthUrl).origin,
    '页面和健康接口必须来自相同来源',
  );
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const fail = (message: string): never => {
  throw Object.assign(Error(message), { statusCode: 409 });
};
/** Independent, fresh collection. Neither child reports nor uploaded screenshots are accepted. */
export class GroundTruthService {
  private active = new Set<BrowserDriver>();
  private closing = false;
  constructor(
    private store: Store,
    private dataDir: string,
    private electronPath?: string,
  ) {}
  sources(owner: string, project: string) {
    return this.store
      .list<MonitorSource>('monitor-source', owner)
      .filter((v) => v.projectId === project);
  }
  register(owner: string, projectId: string, raw: unknown) {
    const input = monitorInput.parse(raw);
    if (this.sources(owner, projectId).length >= 8) fail('一个项目最多配置 8 个监控源');
    return this.store.put<MonitorSource>('monitor-source', owner, {
      ...input,
      id: randomUUID(),
      projectId,
      createdAt: new Date().toISOString(),
    });
  }
  remove(owner: string, project: string, id: string) {
    const source = this.source(owner, project, id);
    this.store.remove('monitor-source', source.id, owner);
  }
  source(owner: string, project: string, id: string) {
    const source = this.store.get<MonitorSource>('monitor-source', id, owner);
    if (!source || source.projectId !== project) return fail('监控源不存在或不属于该项目');
    return source;
  }
  list(owner: string, project: string) {
    return this.store
      .list<GroundTruthEvidence>('ground-truth', owner)
      .filter((v) => v.projectId === project)
      .slice(-20);
  }
  get(owner: string, project: string, id: string) {
    const evidence = this.store.get<GroundTruthEvidence>('ground-truth', id, owner);
    if (!evidence || evidence.projectId !== project) return fail('证据不属于当前项目');
    return evidence;
  }
  private folder(owner: string, id: string) {
    return join(this.dataDir, 'ground-truth', owner, id);
  }
  async capture(
    owner: string,
    project: string,
    session: string,
    run: string,
    id: string,
    signal: AbortSignal,
  ) {
    const source = this.source(owner, project, id);
    if (this.closing || this.active.size >= 2) fail('监控采集正在退出或已达到并发上限');
    const evidenceId = randomUUID(),
      folder = this.folder(owner, evidenceId);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const driver = new BrowserDriver(join(folder, 'profile'), this.electronPath);
    this.active.add(driver);
    const abort = () => void driver.close();
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      await driver.initMonitor(source.pageUrl);
      const image = await driver.monitorScreenshot();
      signal.throwIfAborted();
      if (new URL(image.url).origin !== new URL(source.pageUrl).origin)
        fail('监控页面发生越界跳转');
      const checks: GroundTruthEvidence['checks'] = [];
      let body: unknown;
      try {
        const response = await fetch(source.healthUrl, {
          redirect: 'error',
          headers: { 'cache-control': 'no-cache, no-store', pragma: 'no-cache' },
          signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
        });
        checks.push({ name: 'HTTP', passed: response.ok, actual: String(response.status) });
        const parts: Buffer[] = [];
        let size = 0;
        if (!response.body) throw Error('健康接口没有响应内容');
        const reader = response.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 65536) throw Error('健康响应超过64KB');
            parts.push(Buffer.from(value));
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        const bytes = Buffer.concat(parts);
        body = JSON.parse(bytes.toString('utf8'));
      } catch (e) {
        checks.push({
          name: '健康接口',
          passed: false,
          actual: signal.aborted ? '采集中断' : '请求或 JSON 校验失败',
        });
      }
      for (const check of source.checks) {
        let actual: unknown = body;
        for (const key of check.path.split('.'))
          actual =
            actual && typeof actual === 'object' && Object.hasOwn(actual, key)
              ? (actual as Record<string, unknown>)[key]
              : undefined;
        const passed =
          check.op === 'equals'
            ? actual === check.value
            : typeof actual === 'number' &&
              typeof check.value === 'number' &&
              actual <= check.value;
        checks.push({
          name: check.path + ' ' + check.op + ' ' + String(check.value),
          passed,
          actual: JSON.stringify(actual)?.slice(0, 200) ?? 'missing',
        });
      }
      signal.throwIfAborted();
      const png = Buffer.from(image.base64, 'base64'),
        thumb = Buffer.from(image.thumbnail, 'base64');
      if (
        png.length > 5 * 1024 * 1024 ||
        thumb.length > 512000 ||
        png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
      )
        fail('截图校验或大小超出预算');
      const capturedAt = new Date().toISOString();
      await writeFile(join(folder, 'screenshot.png'), png, { mode: 0o600, flag: 'wx' });
      await writeFile(join(folder, 'thumbnail.jpg'), thumb, { mode: 0o600, flag: 'wx' });
      return this.store.put<GroundTruthEvidence>('ground-truth', owner, {
        id: evidenceId,
        sourceId: id,
        projectId: project,
        sessionId: session,
        runId: run,
        capturedAt,
        expiresAt: new Date(Date.parse(capturedAt) + source.maxAgeSeconds * 1000).toISOString(),
        screenshotSha256: sha(png),
        healthy: checks.length > 1 && checks.every((c) => c.passed) && image.errors.length === 0,
        checks,
        pageErrors: image.errors,
      });
    } finally {
      signal.removeEventListener('abort', abort);
      await driver.close();
      this.active.delete(driver);
      await rm(join(folder, 'profile'), { recursive: true, force: true });
    }
  }
  async screenshot(owner: string, project: string, id: string) {
    const evidence = this.get(owner, project, id),
      bytes = await readFile(join(this.folder(owner, id), 'screenshot.png'));
    if (sha(bytes) !== evidence.screenshotSha256) fail('截图原文校验失败');
    return bytes;
  }
  async image(owner: string, project: string, run: string, id: string) {
    const evidence = this.get(owner, project, id);
    if (evidence.runId !== run || Date.parse(evidence.expiresAt) <= Date.now())
      fail('截图过期或并非主 Agent 本轮独立采集，请重新采集');
    await this.screenshot(owner, project, id);
    return {
      type: 'image' as const,
      data: (await readFile(join(this.folder(owner, id), 'thumbnail.jpg'))).toString('base64'),
      mimeType: 'image/jpeg',
    };
  }
  delivered(owner: string, project: string, run: string, id: string) {
    const evidence = this.get(owner, project, id);
    if (evidence.runId !== run || Date.parse(evidence.expiresAt) <= Date.now())
      fail('图像未在有效期内交付主 Agent');
    this.store.put('ground-truth', owner, {
      ...evidence,
      inspectedRunId: run,
      deliveredAt: new Date().toISOString(),
    });
  }
  requireHealthy(owner: string, project: string, run: string, source: string, id?: string) {
    if (!id) return fail('关键合并必须独立采集并查看实时监控截图');
    const evidence = this.get(owner, project, id);
    this.source(owner, project, source);
    if (
      evidence.sourceId !== source ||
      evidence.runId !== run ||
      evidence.inspectedRunId !== run ||
      !evidence.deliveredAt ||
      Date.parse(evidence.expiresAt) <= Date.now()
    )
      fail('实时截图缺少本轮主 Agent 查验或已过期');
    if (!evidence.healthy)
      fail('实时健康检查失败；子 Agent 的正常汇报不可覆盖真实故障，禁止关键合并');
    return evidence;
  }
  requireChangesHealthy(owner: string, project: string, run: string, paths: string[]) {
    for (const source of this.sources(owner, project)) {
      if (!(source.protectedPaths || []).some((p) => paths.some((path) => overlaps(p, path))))
        continue;
      const evidence = this.list(owner, project).findLast(
        (e) => e.sourceId === source.id && e.runId === run,
      );
      this.requireHealthy(owner, project, run, source.id, evidence?.id);
    }
  }
  async close() {
    this.closing = true;
    await Promise.all([...this.active].map((driver) => driver.close()));
  }
}
