import { constants } from 'node:fs';
import type { IsolatedExecutor } from './isolation.ts';
import type { ProjectService } from './projects.ts';
import {
  open,
  lstat,
  readdir,
  mkdir,
  writeFile,
  readFile,
  unlink,
  realpath,
} from 'node:fs/promises';
import { join, basename, resolve, relative, isAbsolute, sep } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store } from '../../packages/shared/store.ts';
import type { Skill, SkillImportPreview, SkillResource } from '../../packages/shared/types.ts';
import {
  digest,
  SKILL_LIMITS,
  parseSkill,
  resourcePath,
  packageDigest,
  skillSummary,
  skillError as fail,
  resourceMime,
  textPage,
} from '../../packages/skills/format.ts';

type LocalSkill = Skill & { manifest: SkillResource[]; bundleHash: string };
type Stage = {
  id: string;
  name: string;
  description: string;
  manifest: SkillResource[];
  totalBytes: number;
  bundleHash: string;
  expiresAt: string;
  ignored: string[];
  replaceId?: string;
  expectedRevision?: number;
  importedId?: string;
  createdAt: string;
};
type RawFile = { path: string; bytes: Buffer };
export const uploadSkillSchema = z
  .object({
    rootName: z.string().min(1).max(64),
    replaceId: z.string().min(1).max(128).optional(),
    files: z
      .array(
        z
          .object({
            path: z.string().max(240),
            base64: z.string().max(Math.ceil(SKILL_LIMITS.fileBytes / 3) * 4),
          })
          .strict(),
      )
      .min(1)
      .max(SKILL_LIMITS.files),
  })
  .strict();
export const importSkillSchema = z
  .object({
    grantId: z.string().min(20).max(128),
    name: z.string().trim().min(1).max(80).optional(),
    category: z.string().trim().min(1).max(30).default('自定义'),
    enabled: z.boolean().default(true),
  })
  .strict();
export const patchLocalSkillSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    category: z.string().trim().min(1).max(30).optional(),
    content: z.string().min(1).max(SKILL_LIMITS.instructionChars).optional(),
    enabled: z.boolean().optional(),
    revision: z.number().int().min(0).optional(),
  })
  .strict();
export class LocalSkills {
  private queues = new Map<string, Promise<unknown>>();
  constructor(
    private store: Store,
    private dataDir: string,
    private executor: IsolatedExecutor,
    private projects: ProjectService,
  ) {}
  private async exclusive<T>(owner: string, work: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(owner) || Promise.resolve();
    const next = prior.catch(() => {}).then(work);
    this.queues.set(owner, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(owner) === next) this.queues.delete(owner);
    }
  }
  private root(owner: string) {
    return join(this.dataDir, 'skill-bundles', digest(owner));
  }
  list(owner: string) {
    return this.store.list<LocalSkill>('local-skill', owner).map((s) => skillSummary(s, 'local'));
  }
  get(owner: string, id: string): LocalSkill {
    return (
      this.store.get<LocalSkill>('local-skill', id, owner) ||
      fail(404, '本机技能不存在', 'SKILL_NOT_FOUND')
    );
  }
  private async bytes(owner: string, file: SkillResource) {
    const handle = await open(
      join(this.root(owner), file.sha256),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    ).catch(() => fail(409, '技能副本缺失或不可读取，请重新导入', 'SKILL_INTEGRITY'));
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size !== file.bytes ||
        stat.size > SKILL_LIMITS.fileBytes
      )
        fail(409, '技能资源校验失败', 'SKILL_INTEGRITY');
      const buffer = Buffer.alloc(file.bytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const bytes = buffer.subarray(0, bytesRead);
      if (bytesRead !== file.bytes || digest(bytes) !== file.sha256)
        fail(409, '技能资源已改变，请重新导入', 'SKILL_INTEGRITY');
      return bytes;
    } finally {
      await handle.close();
    }
  }
  async file(owner: string, id: string, path: string, expected?: string) {
    const skill = this.get(owner, id);
    if (expected && skillSummary(skill, 'local').sha256 !== expected)
      fail(409, '技能已更新，请重新打开资源列表', 'SKILL_CHANGED');
    const normalized = resourcePath(path);
    const file = skill.manifest.find((f) => f.path === normalized) || fail(404, '技能资源不存在');
    return { file, bytes: await this.bytes(owner, file) };
  }
  async page(
    owner: string,
    id: string,
    path: string,
    input: { offset?: number; limit?: number },
    expected?: string,
    requireEnabled = true,
  ) {
    const skill = this.get(owner, id);
    if (
      expected &&
      ((requireEnabled && !skill.enabled) || skillSummary(skill, 'local').sha256 !== expected)
    )
      fail(409, '技能已更新或停用，请重新选择后开始下一轮', 'SKILL_CHANGED');
    const result = await this.file(owner, id, path, expected);
    return { ...result.file, ...textPage(result.bytes, input) };
  }
  private async build(owner: string, rootName: string | undefined, raw: RawFile[]) {
    if (!raw.length || raw.length > SKILL_LIMITS.files) fail(400, '技能包需要 1–128 个文件');
    const seen = new Set<string>();
    let totalBytes = 0;
    const files = raw.map((file) => {
      const path = resourcePath(file.path),
        key = path.toLocaleLowerCase('en-US');
      if (seen.has(key)) fail(400, '技能包存在重复或大小写冲突路径');
      seen.add(key);
      if (file.bytes.length > SKILL_LIMITS.fileBytes) fail(400, '技能单文件最多 2 MB');
      totalBytes += file.bytes.length;
      return {
        path,
        bytes: file.bytes.length,
        sha256: digest(file.bytes),
        mime: resourceMime(path),
      };
    });
    if (totalBytes > SKILL_LIMITS.totalBytes) fail(400, '技能包总大小最多 8 MB');
    const main =
      raw.find((file) => file.path.normalize('NFC') === 'SKILL.md') ||
      fail(400, '技能包根目录需要 SKILL.md');
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(main.bytes);
    } catch {
      fail(400, 'SKILL.md 必须是 UTF-8 文本');
    }
    const metadata = parseSkill(content, rootName);
    const retained = new Map<string, number>();
    for (const skill of this.store.list<LocalSkill>('local-skill', owner))
      for (const file of skill.manifest) retained.set(file.sha256, file.bytes);
    for (const stage of this.store
      .list<Stage>('skill-stage', owner)
      .filter((s) => !s.importedId && Date.parse(s.expiresAt) > Date.now()))
      for (const file of stage.manifest) retained.set(file.sha256, file.bytes);
    for (const file of files) retained.set(file.sha256, file.bytes);
    if ([...retained.values()].reduce((a, b) => a + b, 0) > 128 * 1024 * 1024)
      fail(409, '本机技能空间已达到 128 MB，请整理后重试');
    await mkdir(this.root(owner), { recursive: true, mode: 0o700 });
    for (let i = 0; i < files.length; i++) {
      try {
        await writeFile(join(this.root(owner), files[i].sha256), raw[i].bytes, {
          mode: 0o600,
          flag: 'wx',
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await this.bytes(owner, files[i]);
      }
    }
    return {
      metadata,
      manifest: files.sort((a, b) => a.path.localeCompare(b.path)),
      totalBytes,
      bundleHash: packageDigest(files),
    };
  }
  private async prepare(
    owner: string,
    rootName: string,
    files: RawFile[],
    ignored: string[],
    replaceId?: string,
  ): Promise<SkillImportPreview> {
    return this.exclusive(owner, async () => {
      const previous = replaceId ? this.get(owner, replaceId) : undefined;
      await this.collect(owner);
      for (const stage of this.store.list<Stage>('skill-stage', owner))
        if (Date.parse(stage.expiresAt) < Date.now() - 86400000)
          this.store.remove('skill-stage', stage.id, owner);
      if (
        this.store
          .list<Stage>('skill-stage', owner)
          .filter((stage) => !stage.importedId && Date.parse(stage.expiresAt) > Date.now())
          .length >= 20
      )
        fail(409, '待导入预览过多，请关闭旧预览或稍后重试');
      const built = await this.build(owner, rootName, files);
      const grantId = randomBytes(32).toString('base64url');
      const stage: Stage = {
        id: digest(grantId),
        name: built.metadata.name,
        description: built.metadata.description,
        manifest: built.manifest,
        totalBytes: built.totalBytes,
        bundleHash: built.bundleHash,
        expiresAt: new Date(Date.now() + 5 * 60000).toISOString(),
        ignored,
        replaceId,
        expectedRevision: previous?.revision,
        createdAt: new Date().toISOString(),
      };
      this.store.put('skill-stage', owner, stage);
      return {
        grantId,
        name: stage.name,
        description: stage.description,
        instructions: built.metadata.content,
        files: stage.manifest,
        totalBytes: stage.totalBytes,
        sha256: stage.bundleHash,
        expiresAt: stage.expiresAt,
        ignored,
        replaceId,
      };
    });
  }
  async upload(owner: string, input: z.infer<typeof uploadSkillSchema>) {
    const files = input.files.map((file) => {
      if (
        file.base64.length % 4 !== 0 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.base64)
      )
        fail(400, '技能文件编码无效');
      return { path: file.path, bytes: Buffer.from(file.base64, 'base64') };
    });
    return this.prepare(owner, input.rootName, files, [], input.replaceId);
  }
  async directory(owner: string, inputPath: string, replaceId?: string) {
    if (!inputPath || inputPath.includes('\0')) fail(400, '技能目录无效');
    const chosen = resolve(inputPath);
    const stat = await lstat(chosen);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      fail(400, '请选择普通技能目录，不允许符号链接');
    const root = await realpath(chosen),
      data = await realpath(this.dataDir),
      rel = relative(data, root);
    if (!rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))) {
      const project = this.projects
        .list(owner)
        .find((project) => root === project.root || root.startsWith(project.root + sep));
      if (!project) fail(400, '只能从当前账号已授权的项目目录读取技能，不能导入工作台私有数据');
      await this.projects.requireAccess(project!.id, owner);
    }
    const snapshot = await this.executor.file<{
      rootName: string;
      files: { path: string; base64: string }[];
      ignored: string[];
    }>(root, false, 'snapshot_skill', {});
    return this.prepare(
      owner,
      snapshot.rootName,
      snapshot.files.map((file) => ({
        path: file.path,
        bytes: Buffer.from(file.base64, 'base64'),
      })),
      snapshot.ignored,
      replaceId,
    );
  }

  async import(owner: string, input: z.infer<typeof importSkillSchema>) {
    return this.exclusive(owner, async () => {
      const stage =
        this.store.get<Stage>('skill-stage', digest(input.grantId), owner) ||
        fail(404, '技能导入预览不存在');
      if (stage.importedId) return { skill: this.get(owner, stage.importedId), duplicate: true };
      if (Date.parse(stage.expiresAt) <= Date.now())
        fail(409, '导入预览已过期，请重新选择技能目录');
      const previous = stage.replaceId ? this.get(owner, stage.replaceId) : undefined;
      if (previous && previous.revision !== stage.expectedRevision)
        fail(409, '技能已被修改，请重新预览后更新', 'SKILL_CHANGED');
      if (packageDigest(stage.manifest) !== stage.bundleHash)
        fail(409, '技能预览校验失败', 'SKILL_INTEGRITY');
      for (const file of stage.manifest) await this.bytes(owner, file);
      const file = stage.manifest.find((f) => f.path === 'SKILL.md')!;
      const parsed = parseSkill((await this.bytes(owner, file)).toString('utf8'));
      const duplicate =
        !previous &&
        this.store
          .list<LocalSkill>('local-skill', owner)
          .find((s) => s.bundleHash === stage.bundleHash);
      if (duplicate) {
        this.store.put('skill-stage', owner, { ...stage, importedId: duplicate.id });
        return { skill: duplicate, duplicate: true };
      }
      if (!previous && this.list(owner).length >= 200) fail(409, '本机技能数量已达 200 项');
      const skill: LocalSkill = {
        id: previous?.id || `local:${randomUUID()}`,
        name: input.name || previous?.name || parsed.name,
        description: parsed.description,
        slug: parsed.name,
        content: parsed.content,
        category: input.category,
        enabled: input.enabled,
        origin: 'local',
        format: 'agent-skill',
        revision: (previous?.revision || 0) + 1,
        updatedAt: new Date().toISOString(),
        manifest: stage.manifest,
        bundleHash: stage.bundleHash,
        fileCount: stage.manifest.length,
        totalBytes: stage.totalBytes,
      };
      skill.sha256 = digest(
        JSON.stringify([skill.name, skill.description, skill.category, skill.bundleHash]),
      );
      this.store.db.exec('BEGIN IMMEDIATE');
      try {
        this.store.put('local-skill', owner, skill);
        this.store.put('skill-stage', owner, { ...stage, importedId: skill.id });
        this.store.db.exec('COMMIT');
      } catch (error) {
        this.store.db.exec('ROLLBACK');
        throw error;
      }
      return { skill, duplicate: false };
    });
  }
  async patch(owner: string, id: string, input: z.infer<typeof patchLocalSkillSchema>) {
    return this.exclusive(owner, async () => {
      const current = this.get(owner, id);
      if (input.revision !== undefined && input.revision !== (current.revision || 0))
        fail(409, '技能已被修改，请重新打开编辑', 'SKILL_CHANGED');
      const { revision: _, ...change } = input;
      let next = {
        ...current,
        ...change,
        revision: (current.revision || 0) + 1,
        updatedAt: new Date().toISOString(),
      };
      if (input.content !== undefined) {
        const files = await Promise.all(
          current.manifest.map(async (file) => ({
            path: file.path,
            bytes:
              file.path === 'SKILL.md'
                ? Buffer.from(input.content!)
                : await this.bytes(owner, file),
          })),
        );
        const built = await this.build(owner, undefined, files);
        next = {
          ...next,
          description: built.metadata.description,
          slug: built.metadata.name,
          manifest: built.manifest,
          bundleHash: built.bundleHash,
          totalBytes: built.totalBytes,
        };
      }
      next.sha256 = digest(
        JSON.stringify([next.name, next.description, next.category, next.bundleHash]),
      );
      return this.store.put('local-skill', owner, next);
    });
  }
  private async collect(owner: string) {
    const retained = new Set<string>();
    for (const skill of this.store.list<LocalSkill>('local-skill', owner))
      for (const file of skill.manifest) retained.add(file.sha256);
    for (const stage of this.store
      .list<Stage>('skill-stage', owner)
      .filter((stage) => !stage.importedId && Date.parse(stage.expiresAt) > Date.now()))
      for (const file of stage.manifest) retained.add(file.sha256);
    const files = await readdir(this.root(owner)).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const file of files)
      if (/^[a-f0-9]{64}$/.test(file) && !retained.has(file))
        await unlink(join(this.root(owner), file));
    this.store.remove('skill-cleanup', owner, owner);
  }
  async remove(owner: string, id: string) {
    return this.exclusive(owner, async () => {
      this.get(owner, id);
      this.store.remove('local-skill', id, owner);
      try {
        await this.collect(owner);
        return { ok: true };
      } catch {
        this.store.put('skill-cleanup', owner, { id: owner, pendingAt: new Date().toISOString() });
        return { ok: true, cleanupPending: true };
      }
    });
  }
  async discard(owner: string, grantId: string) {
    return this.exclusive(owner, async () => {
      const stage = this.store.get<Stage>('skill-stage', digest(grantId), owner);
      if (stage && !stage.importedId) this.store.remove('skill-stage', stage.id, owner);
      await this.collect(owner);
      return { ok: true };
    });
  }
}
