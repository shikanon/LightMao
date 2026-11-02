import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants, openSync, closeSync, readFileSync, writeFileSync, fstatSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Store } from '../../packages/shared/store.ts';
import { catalog } from '../../packages/shared/catalog.ts';
import {
  MAX_CONFIGURED_OUTPUT,
  modelDefaults,
  outputTokenBudget,
} from '../../packages/shared/model-budget.ts';
import type {
  User,
  ModelConfig,
  AdminOverview,
  AdminPage,
  AdminUsage,
  AdminAudit,
  AdminPlugin,
  AdminIdentity,
  Usage,
  Audit,
} from '../../packages/shared/types.ts';
import type { AuthService, StoredUser } from './auth.ts';

const fail = (statusCode: number, message: string): never => {
  throw Object.assign(new Error(message), { statusCode });
};
const fields = {
  q: z.string().trim().max(200).default(''),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(2000).optional(),
};
const userQuery = z
  .object({
    ...fields,
    status: z.enum(['all', 'active', 'disabled']).default('all'),
    role: z.enum(['all', 'admin', 'member']).default('all'),
  })
  .strict();
const historyQuery = z
  .object({
    ...fields,
    status: z
      .enum(['all', 'running', 'completed', 'failed', 'cancelled', 'interrupted'])
      .default('all'),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
  })
  .strict();
const auditQuery = z.object(fields).strict();
type Query = z.infer<typeof historyQuery> & { role?: string };
type Policy = { id: string; available: boolean; revision: number };
const viewUser = (u: StoredUser): User => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  status: u.status,
  createdAt: u.createdAt,
  revision: u.revision || 0,
});
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export class AdminService {
  private key: Buffer;
  constructor(
    private store: Store,
    private auth: AuthService,
    dataDir: string,
    private model: () => ModelConfig,
    private audit: (actor: string, action: string, detail: string) => unknown,
    private arkConfigured: boolean,
  ) {
    const path = join(dataDir, 'admin-cursor.key');
    try {
      writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1 || info.size !== 32 || info.mode & 0o077)
        throw new Error('Invalid administrator cursor key');
      this.key = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  policy(id: string): Policy {
    return (
      this.store.get<Policy>('plugin-policy', id, 'system') || { id, available: true, revision: 0 }
    );
  }
  private transaction<T>(fn: () => T): T {
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.store.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
  }
  private identity(id: string): AdminIdentity | undefined {
    const u = this.store.get<StoredUser>('user', id);
    return u ? { id: u.id, name: u.name, email: u.email } : undefined;
  }
  private usage(value: Usage): AdminUsage {
    return {
      id: value.id,
      userId: value.userId,
      model: value.model,
      status: value.status,
      durationMs: value.durationMs,
      at: value.at,
      totalTokens: value.totalTokens,
      promptTokens: value.promptTokens,
      completionTokens: value.completionTokens,
      upstreamStatus: value.upstreamStatus,
      failureReason: value.failureReason,
      capability: value.capability,
      traceId: value.traceId,
      spanId: value.spanId,
      audioTokens: value.audioTokens,
      user: this.identity(value.userId),
    };
  }
  private auditView(value: Audit): AdminAudit {
    return {
      id: value.id,
      actor: value.actor,
      action: value.action.slice(0, 100),
      detail: value.detail.slice(0, 1200),
      at: value.at,
      user: this.identity(value.actor),
    };
  }
  usageDetails(id: string): AdminUsage {
    return this.usage(this.store.get<Usage>('usage', id, 'system') || fail(404, '调用记录不存在'));
  }
  private count(kind: string, condition = '1', args: (string | number)[] = []): number {
    return (
      this.store.db
        .prepare(`SELECT count(*) AS n FROM records WHERE kind=? AND ${condition}`)
        .get(kind, ...args) as { n: number }
    ).n;
  }
  overview(summaryOnly = false) {
    const tokenCondition =
      "json_type(data,'$.totalTokens')='integer' AND json_extract(data,'$.totalTokens')>=0 AND json_extract(data,'$.totalTokens')<=9007199254740991";
    const total = (
      this.store.db
        .prepare(
          `SELECT coalesce(sum(json_extract(data,'$.totalTokens')),0) AS n FROM records WHERE kind='usage' AND ${tokenCondition}`,
        )
        .get() as { n: number }
    ).n;
    const bytes = (
      this.store.db
        .prepare(
          "SELECT coalesce(sum(json_extract(data,'$.size')),0) AS n FROM records WHERE kind='asset'",
        )
        .get() as { n: number }
    ).n;
    const data: AdminOverview = {
      model: { ...this.model(), revision: this.model().revision || 0 },
      arkConfigured: this.arkConfigured,
      totals: {
        users: this.count('user'),
        activeUsers: this.count('user', "json_extract(data,'$.status')='active'"),
        modelRequests: this.count('usage'),
        runningRequests: this.count(
          'usage',
          "json_extract(data,'$.status') IN ('running','submitted')",
        ),
        failedRequests: this.count(
          'usage',
          "json_extract(data,'$.status') NOT IN ('running','submitted','completed','cancelled')",
        ),
        totalTokens: total,
        tokenRequests: this.count('usage', tokenCondition),
        assets: this.count('asset'),
        storageBytes: bytes,
      },
    };
    // Keep the old read-only contract bounded for existing clients. New UI uses
    // totals and separate paginated endpoints, never the legacy page lengths.
    if (summaryOnly) return data;
    const recent = <T>(kind: string) =>
      this.store.db
        .prepare('SELECT data FROM records WHERE kind=? ORDER BY rowid DESC LIMIT 100')
        .all(kind)
        .map((r) => JSON.parse(r.data as string) as T);
    return {
      ...data,
      users: recent<StoredUser>('user').map(viewUser),
      usage: recent<Usage>('usage').map((v) => this.usage(v)),
      audits: recent<Audit>('audit').map((v) => this.auditView(v)),
      assets: data.totals.assets,
      storageBytes: bytes,
    };
  }
  page(
    kind: 'user' | 'usage' | 'audit',
    owner: string,
    input: unknown,
  ): AdminPage<User | AdminUsage | AdminAudit> {
    const parsed =
      kind === 'user'
        ? userQuery.parse(input)
        : kind === 'usage'
          ? historyQuery.parse(input)
          : auditQuery.parse(input);
    const { cursor, ...query } = parsed;
    const { q, limit } = query;
    const filter = digest(JSON.stringify([kind, query]));
    const where = ['r.kind=?'];
    const args: (string | number)[] = [kind];
    const value = query as Query;
    if (q) {
      const searchable =
        kind === 'user'
          ? "coalesce(json_extract(r.data,'$.name'),'') || ' ' || coalesce(json_extract(r.data,'$.email'),'')"
          : kind === 'usage'
            ? "r.id || ' ' || coalesce(json_extract(r.data,'$.model'),'') || ' ' || coalesce(json_extract(r.data,'$.userId'),'')"
            : "coalesce(json_extract(r.data,'$.action'),'') || ' ' || coalesce(json_extract(r.data,'$.detail'),'') || ' ' || coalesce(json_extract(r.data,'$.actor'),'')";
      where.push(
        `(instr(lower(${searchable}),lower(?))>0${kind === 'user' ? '' : " OR EXISTS (SELECT 1 FROM records u WHERE u.kind='user' AND u.id=json_extract(r.data,'$." + (kind === 'usage' ? 'userId' : 'actor') + "') AND instr(lower(coalesce(json_extract(u.data,'$.name'),'') || ' ' || coalesce(json_extract(u.data,'$.email'),'')),lower(?))>0)"})`,
      );
      args.push(q);
      if (kind !== 'user') args.push(q);
    }
    if (value.status && value.status !== 'all') {
      where.push(
        value.status === 'failed'
          ? "json_extract(r.data,'$.status') NOT IN ('running','submitted','completed','cancelled')"
          : value.status === 'running'
            ? "json_extract(r.data,'$.status') IN ('running','submitted')"
            : "json_extract(r.data,'$.status')=?",
      );
      if (value.status !== 'failed' && value.status !== 'running') args.push(value.status);
    }
    if (value.role && value.role !== 'all') {
      where.push("json_extract(r.data,'$.role')=?");
      args.push(value.role);
    }
    if (value.from) {
      where.push("json_extract(r.data,'$.at')>=?");
      args.push(new Date(value.from).toISOString());
    }
    if (value.to) {
      where.push("json_extract(r.data,'$.at')<=?");
      args.push(new Date(value.to).toISOString());
    }
    if (value.from && value.to && Date.parse(value.from) > Date.parse(value.to))
      fail(400, '开始时间不能晚于结束时间');
    let ceiling = (
        this.store.db.prepare('SELECT coalesce(max(rowid),0) AS n FROM records').get() as {
          n: number;
        }
      ).n,
      before = ceiling + 1;
    if (cursor) {
      try {
        const [body, signature, ...extra] = cursor.split('.');
        if (
          extra.length ||
          !/^[a-f0-9]{64}$/.test(signature) ||
          !timingSafeEqual(
            Buffer.from(signature, 'hex'),
            createHmac('sha256', this.key).update(body).digest(),
          )
        )
          throw Error();
        const decoded = z
          .object({
            v: z.literal(1),
            owner: z.string(),
            filter: z.string(),
            ceiling: z.number().int().min(0),
            before: z.number().int().min(0),
          })
          .strict()
          .parse(JSON.parse(Buffer.from(body, 'base64url').toString()));
        if (
          decoded.owner !== owner ||
          decoded.filter !== filter ||
          decoded.before > decoded.ceiling + 1
        )
          throw Error();
        ceiling = decoded.ceiling;
        before = decoded.before;
      } catch {
        fail(400, '分页位置已失效，请刷新列表');
      }
    }
    where.push('r.rowid<=?');
    args.push(ceiling);
    const clause = where.join(' AND ');
    const total = (
      this.store.db.prepare(`SELECT count(*) AS n FROM records r WHERE ${clause}`).get(...args) as {
        n: number;
      }
    ).n;
    const rows = this.store.db
      .prepare(
        `SELECT r.rowid AS rid,r.data FROM records r WHERE ${clause} AND r.rowid<? ORDER BY r.rowid DESC LIMIT ?`,
      )
      .all(...args, before, limit + 1) as { rid: number; data: string }[];
    const items = rows.slice(0, limit).map((row) => {
      const v = JSON.parse(row.data);
      return kind === 'user' ? viewUser(v) : kind === 'usage' ? this.usage(v) : this.auditView(v);
    });
    let nextCursor: string | undefined;
    if (rows.length > limit) {
      const body = Buffer.from(
        JSON.stringify({ v: 1, owner, filter, ceiling, before: rows[limit - 1].rid }),
      ).toString('base64url');
      nextCursor = body + '.' + createHmac('sha256', this.key).update(body).digest('hex');
    }
    return { items, total, nextCursor };
  }
  updateUser(owner: string, id: string, body: unknown) {
    const change = z
      .object({
        status: z.enum(['active', 'disabled']),
        revision: z.number().int().min(0).optional(),
      })
      .strict()
      .parse(body);
    return this.transaction(() => {
      const target = this.store.get<StoredUser>('user', id) || fail(404, '用户不存在');
      if (change.revision !== undefined && change.revision !== (target.revision || 0))
        fail(409, '用户状态已更改，请刷新列表');
      if (id === owner && change.status === 'disabled') fail(409, '不能停用当前管理员');
      if (change.status === target.status) return viewUser(target);
      const next = { ...target, status: change.status, revision: (target.revision || 0) + 1 };
      this.store.put('user', 'system', next);
      if (change.status === 'disabled') this.auth.revokeUser(id);
      this.audit(owner, 'user.status', `${target.email}: ${change.status}`);
      return viewUser(next);
    });
  }
  updateModel(owner: string, body: unknown) {
    const change = z
      .object({
        label: z.string().trim().min(1).max(80).optional(),
        modelId: z
          .string()
          .regex(/^[a-zA-Z0-9._-]{1,150}$/)
          .optional(),
        enabled: z.boolean().optional(),
        contextWindowTokens: z.number().int().min(16384).max(2000000).optional(),
        maxOutputTokens: z.number().int().min(1024).max(MAX_CONFIGURED_OUTPUT).optional(),
        revision: z.number().int().min(0).optional(),
      })
      .strict()
      .refine(
        (v) =>
          v.label !== undefined ||
          v.modelId !== undefined ||
          v.enabled !== undefined ||
          v.contextWindowTokens !== undefined ||
          v.maxOutputTokens !== undefined,
        '请选择要修改的配置',
      )
      .parse(body);
    return this.transaction(() => {
      const current = this.model();
      if (change.revision !== undefined && change.revision !== (current.revision || 0))
        fail(409, '模型配置已更改，请重新载入配置后保存');
      const next = { ...current, ...change, id: 'model', revision: (current.revision || 0) + 1 };
      const defaults = modelDefaults(next.modelId);
      const requested = next.maxOutputTokens ?? defaults.maxOutputTokens;
      if (
        outputTokenBudget(
          next.contextWindowTokens ?? defaults.contextWindowTokens,
          requested,
          next.modelId,
        ) < requested
      )
        fail(400, '输出上限超过模型支持范围或上下文预算；请同时核对模型、上下文和输出长度');
      this.store.put('config', 'system', next);
      this.audit(
        owner,
        'model.update',
        `${next.modelId}: ${next.enabled ? 'enabled' : 'disabled'}`,
      );
      return next;
    });
  }
  plugins(): AdminPlugin[] {
    return catalog.map((p) => {
      const rows = this.store.db
        .prepare(
          "SELECT coalesce(sum(json_extract(data,'$.installed')=1),0) AS installed,coalesce(sum(json_extract(data,'$.installed')=1 AND json_extract(data,'$.enabled')=1),0) AS enabled FROM records WHERE kind='plugin' AND json_extract(data,'$.catalogId')=?",
        )
        .get(p.id) as { installed: number; enabled: number };
      return {
        ...this.policy(p.id),
        name: p.name,
        version: p.version,
        tools: p.tools,
        installedUsers: rows.installed,
        enabledUsers: rows.enabled,
      };
    });
  }
  updatePlugin(owner: string, id: string, body: unknown) {
    if (!catalog.some((p) => p.id === id)) fail(404, '插件不存在');
    const change = z
      .object({ available: z.boolean(), revision: z.number().int().min(0) })
      .strict()
      .parse(body);
    return this.transaction(() => {
      const current = this.policy(id);
      if (change.revision !== current.revision) fail(409, '插件目录已更改，请刷新列表');
      const next = { id, available: change.available, revision: current.revision + 1 };
      this.store.put('plugin-policy', 'system', next);
      this.audit(
        owner,
        'plugin.availability',
        `${id}: ${next.available ? 'available' : 'unavailable'}`,
      );
      return next;
    });
  }
}

export function registerAdminRoutes(
  app: FastifyInstance,
  admin: AdminService,
  actor: (req: FastifyRequest) => User,
) {
  const owner = (req: FastifyRequest) => {
    const u = actor(req);
    if (u.role !== 'admin') fail(403, '需要管理员权限');
    return u.id;
  };
  app.get('/api/admin/overview', async (req) => {
    owner(req);
    const q = z
      .object({ summary: z.literal('true').optional() })
      .strict()
      .parse(req.query);
    return admin.overview(q.summary === 'true');
  });
  for (const [path, kind] of [
    ['users', 'user'],
    ['usage', 'usage'],
    ['audits', 'audit'],
  ] as const)
    app.get(`/api/admin/${path}`, async (req) => admin.page(kind, owner(req), req.query));
  app.patch<{ Params: { id: string } }>('/api/admin/users/:id', async (req) =>
    admin.updateUser(owner(req), req.params.id, req.body),
  );
  app.patch('/api/admin/model', async (req) => admin.updateModel(owner(req), req.body));
  app.get('/api/admin/plugins', async (req) => {
    owner(req);
    return admin.plugins();
  });
  app.get<{ Params: { id: string } }>('/api/admin/usage/:id', async (req) => {
    owner(req);
    return admin.usageDetails(req.params.id);
  });
  app.patch<{ Params: { id: string } }>('/api/admin/plugins/:id', async (req) =>
    admin.updatePlugin(owner(req), req.params.id, req.body),
  );
}
