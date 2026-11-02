import type { Store } from '../../packages/shared/store.ts';
import { catalog } from '../../packages/shared/catalog.ts';
import type { Plugin } from '../../packages/shared/types.ts';

export type PermissionMode = 'full' | 'custom';
export interface PermissionState {
  mode: PermissionMode;
  revision: number;
}
type StoredPermissions = PermissionState & { id: string };
type StoredPlugin = Plugin & { catalogId: string };
type PluginChange = { installed?: boolean; enabled?: boolean };

function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode });
}

/** Account preferences only: platform availability remains an independent ceiling. */
export class PermissionService {
  constructor(
    private store: Store,
    private available: (id: string) => boolean,
    private audit: (owner: string, action: string, detail: string) => unknown,
    private defaultMode: PermissionMode = 'full',
  ) {}

  info(owner: string): PermissionState {
    const saved = this.store.get<StoredPermissions>('permissions', owner, owner);
    return saved
      ? { mode: saved.mode, revision: saved.revision }
      : { mode: this.defaultMode, revision: 0 };
  }

  plugins(owner: string): Plugin[] {
    const full = this.info(owner).mode === 'full';
    const stored = new Map(
      this.store.list<StoredPlugin>('plugin', owner).map((value) => [value.catalogId, value]),
    );
    return catalog.map((base) => {
      const saved = stored.get(base.id);
      // Use current catalogue metadata and keep only account selections from old rows.
      const installed = full || !!saved?.installed;
      const enabled = full || !!saved?.enabled;
      const available = this.available(base.id);
      return { ...base, installed, enabled: installed && enabled && available, available };
    });
  }

  private transaction<T>(work: () => T): T {
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.store.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
  }

  private savePlugin(owner: string, plugin: Plugin) {
    const { available: _, ...selection } = plugin;
    return this.store.put<StoredPlugin>('plugin', owner, {
      ...selection,
      id: `${owner}:${plugin.id}`,
      catalogId: plugin.id,
    });
  }

  private saveMode(owner: string, mode: PermissionMode, revision: number) {
    const state = { mode, revision: revision + 1 };
    this.store.put<StoredPermissions>('permissions', owner, { id: owner, ...state });
    this.audit(owner, 'permissions.update', `${mode} / revision ${state.revision}`);
    return state;
  }

  private materialize(owner: string) {
    for (const plugin of this.plugins(owner)) this.savePlugin(owner, plugin);
  }

  setMode(owner: string, mode: PermissionMode, revision: number): PermissionState {
    return this.transaction(() => {
      const current = this.info(owner);
      if (revision !== current.revision) fail(409, '权限设置已被修改，请刷新后重试');
      if (current.mode === 'full' && mode === 'custom') this.materialize(owner);
      // Persist explicit choices even when they equal the deployment default.
      return this.saveMode(owner, mode, current.revision);
    });
  }

  patchPlugin(owner: string, id: string, change: PluginChange): Plugin {
    if (!catalog.some((plugin) => plugin.id === id)) fail(404, '插件不存在');
    return this.transaction(() => {
      const current = this.info(owner);
      if (current.mode === 'full' && (change.enabled === false || change.installed === false)) {
        // Old disabled values must not reappear when one plugin is turned off.
        this.materialize(owner);
        this.saveMode(owner, 'custom', current.revision);
      }
      const plugin = this.plugins(owner).find((value) => value.id === id)!;
      const next = { ...plugin, ...change };
      if (!next.installed) next.enabled = false;
      if (next.enabled && !next.available) fail(403, '管理员已下架此插件');
      this.savePlugin(owner, next);
      this.audit(
        owner,
        'plugin.update',
        `${plugin.name}: ${next.installed ? '已安装' : '未安装'} / ${next.enabled ? '已启用' : '已停用'}`,
      );
      return next;
    });
  }
}
