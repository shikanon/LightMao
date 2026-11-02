import { randomUUID, createHash } from 'node:crypto';
import { mkdir, stat, readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, extname, basename } from 'node:path';
import type { Store } from '../../packages/shared/store.ts';
import type { ProjectArtifact } from '../../packages/shared/artifacts.ts';
import type { ProjectService } from './projects.ts';
import type { IsolatedExecutor } from './isolation.ts';
import { captureMediaFile, detectFfmpeg, runMediaProcess } from './media-runtime.ts';
const fail = (statusCode: number, message: string): never => {
  throw Object.assign(Error(message), { statusCode });
};
export class ProjectArtifacts {
  constructor(
    private store: Store,
    private dataDir: string,
    private projects: ProjectService,
    private executor: IsolatedExecutor,
    private ffmpegPath?: string,
  ) {}
  private folder(owner: string, id: string) {
    return join(
      this.dataDir,
      'project-artifacts',
      createHash('sha256').update(owner).digest('hex'),
      id,
    );
  }
  get(owner: string, id: string) {
    const item =
      this.store.get<ProjectArtifact>('project-artifact', id, owner) || fail(404, '预览快照不存在');
    if (Date.parse(item.expiresAt) < Date.now()) fail(410, '预览快照已过期，请重新打开文件');
    return item;
  }
  async create(owner: string, projectId: string, path: string) {
    const project = await this.projects.requireAccess(projectId, owner),
      id = randomUUID(),
      directory = this.folder(owner, id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const meta = await captureMediaFile(
        this.executor,
        project.root,
        path,
        join(directory, 'data'),
        new AbortController().signal,
      ),
      ext = extname(path).toLowerCase();
    let mime = 'text/plain; charset=utf-8',
      kind: ProjectArtifact['kind'] = 'text';
    const images: { [key: string]: string } = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
    };
    if (images[ext]) {
      mime = images[ext];
      kind = 'image';
    } else if (['.mp4', '.mov', '.qt', '.webm'].includes(ext)) {
      mime = ext === '.webm' ? 'video/webm' : 'video/mp4';
      kind = 'video';
      if (['.mov', '.qt'].includes(ext)) {
        const binary = await detectFfmpeg(this.ffmpegPath);
        if (!binary) fail(503, 'QuickTime预览需要本机媒体运行器');
        await runMediaProcess(this.executor, binary!, join(directory, 'data'), [
          '-y',
          '-i',
          'content',
          '-map',
          '0:v:0',
          '-map',
          '0:a:0?',
          '-c',
          'copy',
          '-movflags',
          '+faststart',
          'preview.mp4',
        ]);
      }
    } else if (['.wav', '.mp3', '.m4a', '.aac', '.ogg'].includes(ext)) {
      mime = (
        {
          '.wav': 'audio/wav',
          '.mp3': 'audio/mpeg',
          '.m4a': 'audio/mp4',
          '.aac': 'audio/aac',
          '.ogg': 'audio/ogg',
        } as { [k: string]: string }
      )[ext];
      kind = 'audio';
    } else if (['.glb', '.gltf', '.obj'].includes(ext)) {
      kind = 'model';
      mime = ext === '.glb' ? 'model/gltf-binary' : 'text/plain';
      if (meta.bytes > 32 * 1024 * 1024) fail(413, '交互式3D预览当前最大32MiB');
    }
    if (kind === 'text' && meta.bytes > 2 * 1024 * 1024) fail(413, '文本预览最大2MiB');
    return this.store.put<ProjectArtifact>('project-artifact', owner, {
      id,
      projectId,
      path,
      name: basename(path),
      kind,
      mime,
      ...meta,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });
  }
  async content(owner: string, id: string) {
    const item = this.get(owner, id);
    await this.projects.requireAccess(item.projectId, owner);
    const path = join(
        this.folder(owner, id),
        'data',
        item.kind === 'video' && /\.(mov|qt)$/i.test(item.name) ? 'preview.mp4' : 'content',
      ),
      metadata = await stat(path);
    return { item, stream: createReadStream(path), bytes: metadata.size };
  }
  async text(owner: string, id: string) {
    const item = this.get(owner, id);
    if (item.kind !== 'text') fail(400, '不是文本文件');
    const b = await readFile(join(this.folder(owner, id), 'data', 'content'));
    if (createHash('sha256').update(b).digest('hex') !== item.sha256) fail(409, '预览版本校验失败');
    return b.toString('utf8');
  }
}
