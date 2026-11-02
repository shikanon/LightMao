import { createHash } from 'node:crypto';
import type { Store } from '../../packages/shared/store.ts';
import type { SharedLease } from '../../packages/shared/collaboration.ts';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export const overlaps = (a: string, b: string) =>
  a === b || (a.endsWith('/') && b.startsWith(a)) || (b.endsWith('/') && a.startsWith(b));
export function resourcePath(path: string) {
  if (
    !path ||
    path.length > 400 ||
    path.startsWith('/') ||
    /[\\\u0000-\u001f]/.test(path) ||
    path
      .split('/')
      .some(
        (p, i, parts) =>
          (!p && i !== parts.length - 1) ||
          p === '..' ||
          p.startsWith('.') ||
          /^(password|secrets?)(\.|$)/i.test(p),
      )
  )
    throw Error('资源路径必须是项目内的文件或以 / 结尾的目录，不能含隐藏或敏感路径');
  return path;
}
export class ResourceLeases {
  constructor(
    private store: Store,
    private clock = Date.now,
  ) {}
  list(owner: string, project: string) {
    return this.store
      .list<SharedLease>('shared-lease', owner)
      .filter(
        (l) => l.projectId === project && !l.releasedAt && Date.parse(l.expiresAt) > this.clock(),
      );
  }
  acquire(owner: string, project: string, holder: string, paths: string[], ttlMs = 90000) {
    const unique = [...new Set(paths.map(resourcePath))];
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const active = this.list(owner, project);
      for (const path of unique)
        if (active.some((l) => l.holder !== holder && overlaps(path, l.path)))
          throw Error(`资源正在由另一任务使用：${path}`);
      const leases = unique.map((path) => {
        const id = hash(`${project}\0${path}`),
          before = this.store.get<SharedLease>('shared-lease', id, owner);
        const lease: SharedLease = {
          id,
          projectId: project,
          path,
          holder,
          token: (before?.token || 0) + 1,
          expiresAt: new Date(this.clock() + ttlMs).toISOString(),
        };
        return this.store.put('shared-lease', owner, lease);
      });
      this.store.db.exec('COMMIT');
      return leases;
    } catch (e) {
      this.store.db.exec('ROLLBACK');
      throw e;
    }
  }
  assert(owner: string, holder: string, refs: { id: string; token: number }[]) {
    for (const ref of refs) {
      const lease = this.store.get<SharedLease>('shared-lease', ref.id, owner);
      if (
        !lease ||
        lease.holder !== holder ||
        lease.token !== ref.token ||
        lease.releasedAt ||
        Date.parse(lease.expiresAt) <= this.clock()
      )
        throw Error('资源租约已失效，旧 worker 不可提交');
    }
  }
  renew(owner: string, holder: string, refs: { id: string; token: number }[]) {
    this.assert(owner, holder, refs);
    for (const ref of refs) {
      const lease = this.store.get<SharedLease>('shared-lease', ref.id, owner)!;
      this.store.put('shared-lease', owner, {
        ...lease,
        expiresAt: new Date(this.clock() + 90000).toISOString(),
      });
    }
  }
  release(owner: string, holder: string, refs: { id: string; token: number }[]) {
    for (const ref of refs) {
      const lease = this.store.get<SharedLease>('shared-lease', ref.id, owner);
      if (lease?.holder === holder && lease.token === ref.token && !lease.releasedAt)
        this.store.put('shared-lease', owner, {
          ...lease,
          releasedAt: new Date(this.clock()).toISOString(),
        });
    }
  }
  assertMainWrite(owner: string, project: string, path: string) {
    resourcePath(path);
    if (this.list(owner, project).some((l) => overlaps(l.path, path)))
      throw Error('子任务持有该资源租约；先等待、取消或收回任务再写入');
  }
}
