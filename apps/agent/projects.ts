import { mkdir, realpath, lstat, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve, relative, sep, join, basename, parse } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Store } from '../../packages/shared/store.ts';
import { now, type Project, type ProjectDirectoryGrant } from '../../packages/shared/types.ts';
import { projectPath } from './sandbox.ts';

const fail = (statusCode: number, message: string, code: string): never => {
  throw Object.assign(new Error(message), { statusCode, code });
};
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const contains = (parent: string, child: string) => {
  const path = relative(parent, child);
  return !path || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
};
type Grant = Omit<ProjectDirectoryGrant, 'grantId'> & {
  id: string;
  rootIdentity: { dev: string; ino: string };
  usedProjectId?: string;
};

export class ProjectService {
  constructor(
    readonly store: Store,
    readonly dataDir: string,
  ) {}

  get(id: string, userId: string): Project {
    const project = this.store.get<Project>('project', id, userId);
    if (!project) return fail(404, '项目不存在', 'PROJECT_NOT_FOUND');
    return { source: 'created', status: 'active', access: 'write', revision: 0, ...project };
  }
  list(userId: string) {
    return this.store
      .list<Project & { internalTaskId?: string }>('project', userId)
      .filter((p) => !p.internalTaskId)
      .map((p) => this.get(p.id, userId));
  }
  async identity(root: string) {
    const canonical = await realpath(root);
    const stat = await lstat(canonical, { bigint: true });
    if (!stat.isDirectory()) return fail(400, '请选择项目文件夹', 'PROJECT_DIRECTORY_INVALID');
    return { root: canonical, rootIdentity: { dev: String(stat.dev), ino: String(stat.ino) } };
  }
  async create(userId: string, input: { name: string; description: string; engine: string }) {
    const id = randomUUID(),
      root = resolve(this.dataDir, 'workspaces', userId, id);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(
      join(root, 'README.md'),
      `# ${input.name}\n\n${input.description || '一个新的游戏项目。'}\n\n引擎：${input.engine}\n`,
      { mode: 0o600 },
    );
    return this.store.put<Project>('project', userId, {
      id,
      ...input,
      ...(await this.identity(root)),
      source: 'created',
      status: 'active',
      access: 'write',
      revision: 1,
      createdAt: now(),
      updatedAt: now(),
    });
  }
  async requireAccess(id: string, userId: string, write = false, expectedRoot?: string) {
    let project = this.get(id, userId);
    if (project.status === 'archived')
      return fail(409, '项目已归档，请先恢复项目', 'PROJECT_ARCHIVED');
    if (project.access === 'revoked')
      return fail(403, '项目目录已断开，请在项目管理中重新授权', 'PROJECT_AUTH_REQUIRED');
    if (write && project.access !== 'write')
      return fail(403, '此项目为只读，请在桌面端授权读写', 'PROJECT_READ_ONLY');
    let current;
    try {
      current = await this.identity(project.root);
    } catch {
      return fail(409, '项目目录不可用，请在项目管理中重新连接', 'PROJECT_DIRECTORY_UNAVAILABLE');
    }
    if (!project.rootIdentity) {
      // Legacy prototypes only created managed directories. Do not silently
      // trust a legacy record that points outside its owner's workspace.
      const owned = resolve(this.dataDir, 'workspaces', userId);
      if (!contains(owned, current.root) || current.root === owned)
        return fail(403, '该目录需要在桌面端重新授权', 'PROJECT_AUTH_REQUIRED');
      if (this.get(id, userId).revision !== project.revision)
        return fail(409, '项目授权刚刚变更，请重试', 'PROJECT_AUTH_CHANGED');
      project = { ...project, ...current, revision: (project.revision || 0) + 1 };
      this.store.put('project', userId, project);
    }
    if (
      current.root !== project.root ||
      current.rootIdentity.dev !== project.rootIdentity!.dev ||
      current.rootIdentity.ino !== project.rootIdentity!.ino ||
      (expectedRoot && project.root !== expectedRoot)
    )
      return fail(409, '项目目录已被替换或移动，请在桌面端重新连接', 'PROJECT_DIRECTORY_CHANGED');
    if (this.get(id, userId).revision !== project.revision)
      return fail(409, '项目授权刚刚变更，请重试', 'PROJECT_AUTH_CHANGED');
    return project;
  }
  async useFullAccess(id: string, userId: string) {
    const project = await this.requireAccess(id, userId);
    if (project.access !== 'read') return project;
    return this.store.put('project', userId, {
      ...project,
      access: 'write' as const,
      revision: (project.revision || 0) + 1,
      updatedAt: now(),
    });
  }
  private assertNoOverlap(root: string, exceptId?: string) {
    const rows = this.store.db.prepare('SELECT data FROM records WHERE kind=?').all('project') as {
      data: string;
    }[];
    for (const row of rows) {
      const other = JSON.parse(row.data) as Project;
      if (other.id !== exceptId && (contains(other.root, root) || contains(root, other.root)))
        return fail(
          409,
          '目录与已连接项目重叠，请直接打开已有项目或选择独立目录',
          'PROJECT_DIRECTORY_OVERLAP',
        );
    }
  }
  async grant(
    userId: string,
    directory: string,
    access: 'read' | 'write',
    projectId?: string,
  ): Promise<ProjectDirectoryGrant> {
    if (!isAbsolute(directory) || directory.includes('\0'))
      return fail(400, '请选择有效的项目目录', 'PROJECT_DIRECTORY_INVALID');
    const existing = projectId ? this.get(projectId, userId) : undefined;
    let selected;
    try {
      selected = await this.identity(directory);
    } catch {
      return fail(400, '所选目录不可用，请重新选择项目文件夹', 'PROJECT_DIRECTORY_INVALID');
    }
    const root = selected.root;
    const blockedRoots = [
      parse(root).root,
      homedir(),
      '/Users',
      '/Applications',
      '/System',
      '/Library',
      '/usr',
      '/bin',
      '/sbin',
      '/private',
      '/private/tmp',
      '/private/var',
      '/private/etc',
      '/etc',
      '/tmp',
      '/var',
      '/Volumes',
    ];
    if (blockedRoots.includes(root) || basename(root).startsWith('.'))
      return fail(400, '请选择具体的游戏项目文件夹', 'PROJECT_DIRECTORY_INVALID');
    const privateRoot = await realpath(this.dataDir);
    if ((contains(privateRoot, root) || contains(root, privateRoot)) && existing?.root !== root)
      return fail(400, '运行数据目录不能作为导入项目', 'PROJECT_DIRECTORY_INVALID');
    this.assertNoOverlap(root, projectId);
    const entries = await readdir(root, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile()).map((e) => e.name);
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    const engine = files.includes('project.godot')
      ? 'Godot'
      : dirs.includes('Assets') && dirs.includes('ProjectSettings')
        ? 'Unity'
        : files.some((f) => f.endsWith('.uproject'))
          ? 'Unreal'
          : files.includes('index.html')
            ? 'Web'
            : '通用';
    const token = randomBytes(32).toString('base64url'),
      expiresAt = new Date(Date.now() + 5 * 60000).toISOString();
    this.store.put<Grant>('project-grant', userId, {
      id: digest(token),
      ...selected,
      name: basename(root),
      engine,
      access,
      expiresAt,
      projectId,
    });
    for (const grant of this.store.list<Grant>('project-grant', userId))
      if (Date.parse(grant.expiresAt) < Date.now() - 86400000)
        this.store.remove('project-grant', grant.id, userId);
    return { grantId: token, root, name: basename(root), engine, access, expiresAt, projectId };
  }
  async connect(
    userId: string,
    token: string,
    input: { name?: string; description?: string },
    projectId?: string,
    busy?: () => boolean,
  ) {
    const grantId = digest(token);
    let grant = this.store.get<Grant>('project-grant', grantId, userId);
    if (!grant || grant.projectId !== projectId)
      return fail(403, '请通过桌面文件夹选择器授权此目录', 'PROJECT_GRANT_REQUIRED');
    if (grant.usedProjectId) return this.get(grant.usedProjectId, userId);
    if (Date.parse(grant.expiresAt) <= Date.now())
      return fail(409, '目录选择已过期，请重新选择', 'PROJECT_GRANT_EXPIRED');
    const selected = await this.identity(grant.root);
    if (
      selected.root !== grant.root ||
      selected.rootIdentity.dev !== grant.rootIdentity.dev ||
      selected.rootIdentity.ino !== grant.rootIdentity.ino
    )
      return fail(409, '所选目录已改变，请重新选择', 'PROJECT_DIRECTORY_CHANGED');
    // Recheck after async filesystem work so concurrent submissions consume a
    // grant once and cannot create two projects for the same folder.
    grant = this.store.get<Grant>('project-grant', grantId, userId)!;
    if (grant.usedProjectId) return this.get(grant.usedProjectId, userId);
    if (Date.parse(grant.expiresAt) <= Date.now())
      return fail(409, '目录选择已过期，请重新选择', 'PROJECT_GRANT_EXPIRED');
    if (busy?.()) return fail(409, '请先停止项目中的运行，再更换目录授权', 'PROJECT_BUSY');
    this.assertNoOverlap(grant.root, projectId);
    const old = projectId ? this.get(projectId, userId) : undefined;
    const project: Project = {
      ...old,
      id: old?.id || randomUUID(),
      name: input.name || old?.name || grant.name,
      description: input.description ?? old?.description ?? '',
      engine: grant.engine,
      root: grant.root,
      rootIdentity: grant.rootIdentity,
      source: old?.source || 'imported',
      access: grant.access,
      status: old?.status || 'active',
      createdAt: old?.createdAt || now(),
      updatedAt: now(),
      revision: (old?.revision || 0) + 1,
    };
    this.store.db.exec('BEGIN');
    try {
      this.store.put('project', userId, project);
      this.store.put('project-grant', userId, { ...grant, usedProjectId: project.id });
      this.store.db.exec('COMMIT');
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
    return project;
  }
  patch(
    userId: string,
    id: string,
    patch: {
      name?: string;
      description?: string;
      status?: 'active' | 'archived';
      access?: 'revoked';
    },
  ) {
    const project = this.get(id, userId);
    return this.store.put<Project>('project', userId, {
      ...project,
      ...patch,
      revision: (project.revision || 0) + 1,
      updatedAt: now(),
    });
  }
  async nativeTarget(userId: string, id: string, path?: string) {
    const project = await this.requireAccess(id, userId);
    return { path: path ? await projectPath(project.root, path) : project.root };
  }
}
