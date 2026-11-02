import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import staticFiles from '@fastify/static';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Readable } from 'node:stream';
import type { Socket } from 'node:net';
import { z, ZodError } from 'zod';
import { Store } from '../../packages/shared/store.ts';
import {
  LocalObjectStorage,
  OssObjectStorage,
  type OssOptions,
  type ObjectStorage,
} from './object-storage.ts';
import { AssetService, registerAssetRoutes } from './assets.ts';
import { AdminService, registerAdminRoutes } from './admin.ts';
import { registerDecisionRoutes } from './decisions.ts';
import { GenerationService, registerGenerationRoutes } from './generations.ts';
import { registerCapabilityModels } from './capability-models.ts';
import { PermissionService, type PermissionMode } from './permissions.ts';
import { PerceptionService, registerPerceptionRoutes } from './perception.ts';
import {
  AuthService,
  safeUser,
  readRefreshCookie,
  refreshCookie,
  type StoredUser,
  type Principal,
  type AuthOptions,
} from './auth.ts';
import {
  catalog,
  defaultSkills,
  upgradeSkills,
  sampleDesign,
} from '../../packages/shared/catalog.ts';
import { skillSummary } from '../../packages/skills/format.ts';
import {
  DEFAULT_AGENT_MODEL,
  MAX_CONFIGURED_OUTPUT,
  modelDefaults,
  outputTokenBudget,
} from '../../packages/shared/model-budget.ts';
import {
  now,
  type User,
  type Plugin,
  type Skill,
  type Asset,
  type ModelConfig,
  type Audit,
  type Usage,
} from '../../packages/shared/types.ts';

export interface ApiOptions {
  dataDir: string;
  demo?: boolean;
  arkKey?: string;
  arkBase?: string;
  modelId?: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  decisionModelId?: string;
  imageModelId?: string;
  videoModelId?: string;
  visionModelId?: string;
  audioModelId?: string;
  generationPollMs?: number;
  adminEmail?: string;
  adminPassword?: string;
  serveWeb?: boolean;
  webRoot?: string;
  trustProxy?: false | 'loopback';
  storage?: 'local' | 'oss';
  oss?: OssOptions;
  objectStorage?: ObjectStorage;
  auth?: AuthOptions;
  secureCookies?: boolean;
  allowedOrigins?: string[];
  modelTimeoutMs?: number;
  permissionMode?: PermissionMode;
}
function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode });
}
const skillSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(300),
  content: z.string().min(1).max(30000),
  category: z.string().max(30).default('自定义'),
  enabled: z.boolean().default(true),
});
const skillPatchSchema = skillSchema
  .extend({ category: z.string().max(30), enabled: z.boolean() })
  .partial()
  .extend({ revision: z.number().int().min(0).optional() })
  .strict();

export async function createApi(options: ApiOptions) {
  const app = Fastify({
    logger: false,
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: options.trustProxy || false,
  });
  const store = new Store(join(options.dataDir, 'server.sqlite'));
  const auth = new AuthService(store, options.auth);
  auth.prune();
  const authMaintenance = setInterval(() => auth.prune(), 3600000);
  authMaintenance.unref();
  const objects = join(options.dataDir, 'objects');
  await mkdir(objects, { recursive: true, mode: 0o700 });
  const localObjects = new LocalObjectStorage(objects);
  const primaryObjects =
    options.objectStorage ||
    (options.storage === 'oss'
      ? new OssObjectStorage(
          options.oss || { region: '', bucket: '', accessKeyId: '', accessKeySecret: '' },
        )
      : localObjects);
  const assets = new AssetService(store, localObjects, primaryObjects);
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 3 } });
  const audit = (userId: string, action: string, detail: string) =>
    store.put<Audit>('audit', 'system', {
      id: randomUUID(),
      actor: userId,
      action,
      detail,
      at: now(),
    });
  const model = () => store.get<ModelConfig & { id: string }>('config', 'model')!;
  if (!model())
    store.put('config', 'system', {
      id: 'model',
      alias: 'doubao',
      label: modelDefaults(options.modelId).label,
      modelId: options.modelId || DEFAULT_AGENT_MODEL,
      enabled: true,
      contextWindowTokens:
        options.contextWindowTokens ?? modelDefaults(options.modelId).contextWindowTokens,
      maxOutputTokens: options.maxOutputTokens ?? modelDefaults(options.modelId).maxOutputTokens,
    });
  if (
    options.adminEmail &&
    options.adminPassword &&
    !store.list<StoredUser>('user').some((u) => u.email === options.adminEmail!.toLowerCase())
  ) {
    if (options.adminPassword.length < 12)
      throw new Error('Administrator password must be at least 12 characters');
    await auth.createUser(
      'Administrator',
      options.adminEmail.toLowerCase(),
      options.adminPassword,
      'admin',
    );
  }
  const principals = new WeakMap<object, Principal>();
  const rate = new Map<string, { start: number; count: number }>();
  const modelActive = new Map<string, number>();
  const modelControllers = new Set<AbortController>();
  const modelSettlements = new Set<Promise<void>>();
  let closing = false;
  // A pool may preconnect a TCP socket without ever issuing an HTTP request.
  // Node's idle HTTP connection cleanup does not settle every such socket.
  const socketRequests = new Map<Socket, number>();
  app.server.on('connection', (socket) => {
    if (closing) {
      socket.destroy();
      return;
    }
    socketRequests.set(socket, 0);
    socket.once('close', () => socketRequests.delete(socket));
  });
  app.server.on('request', (request, response) => {
    const socket = request.socket;
    socketRequests.set(socket, (socketRequests.get(socket) || 0) + 1);
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      const count = Math.max(0, (socketRequests.get(socket) || 1) - 1);
      if (!socket.destroyed) socketRequests.set(socket, count);
      if (closing && !count) socket.destroy();
    };
    response.once('finish', done);
    response.once('close', done);
  });
  app.addHook('preClose', async () => {
    closing = true;
    for (const controller of modelControllers) controller.abort();
    for (const [socket, requests] of socketRequests) if (!requests) socket.destroy();
    await Promise.all(modelSettlements);
  });
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    if (req.url.startsWith('/api/admin/')) reply.header('Cache-Control', 'no-store');
    const path = req.url.split('?')[0];
    if (
      [
        '/api/auth/demo',
        '/api/auth/register',
        '/api/auth/login',
        '/api/auth/refresh',
        '/api/health',
      ].includes(path)
    ) {
      if (req.method === 'POST') {
        const key = req.ip;
        let r = rate.get(key);
        if (!r || Date.now() - r.start > 60000) {
          r = { start: Date.now(), count: 0 };
          rate.set(key, r);
        }
        if (++r.count > 30) fail(429, '请求过于频繁，请稍后再试');
        if (rate.size > 10000) rate.clear();
      }
      return;
    }
    const principal = auth.authenticate(req.headers.authorization);
    auth.authorize(principal, path, req.method);
    const user = principal.user;
    principals.set(req, principal);
    if (req.url.startsWith('/api/admin/') && user.role !== 'admin') fail(403, '需要管理员权限');
  });
  const actor = (req: object) => principals.get(req)!.user;
  const principal = (req: object) => principals.get(req)!;
  const decisions = registerDecisionRoutes(app, store, actor, options);
  const generations = new GenerationService(store, assets, {
    ...options,
    pollMs: options.generationPollMs,
    authorize: (owner, kind) => {
      if (!plugins(owner).some((p) => p.id === kind + '-generation' && p.installed && p.enabled))
        fail(403, '请先启用对应生成插件');
    },
  });
  registerGenerationRoutes(app, generations, actor);
  const admin = new AdminService(store, auth, options.dataDir, model, audit, !!options.arkKey);
  const permissions = new PermissionService(
    store,
    (id) => admin.policy(id).available,
    audit,
    options.permissionMode,
  );
  const perception = new PerceptionService(store, {
    ...options,
    authorize: (owner) => {
      if (!plugins(owner).some((p) => p.id === 'perception' && p.installed && p.enabled))
        fail(403, '视觉与音频理解插件已停用');
    },
  });
  registerPerceptionRoutes(app, perception, actor);
  app.addHook('preClose', async () => perception.close());
  registerCapabilityModels(app, store, actor, !!options.arkKey, audit);
  app.setErrorHandler((error, _, reply) => {
    const e = error as Error & { statusCode?: number; code?: string };
    reply.code(error instanceof ZodError ? 400 : e.statusCode || 500).send({
      error:
        error instanceof ZodError
          ? error.issues.map((i) => i.message).join('；')
          : e.statusCode
            ? e.message
            : '服务暂时不可用，请重试',
      ...(e.statusCode && e.code ? { code: e.code } : {}),
    });
  });
  const seedPending = new Map<string, Promise<void>>();
  function seedAccount(user: User) {
    if (store.get('seed', user.id, user.id) || store.get('account-seed', user.id, user.id)) return;
    store.db.exec('BEGIN');
    try {
      for (const p of catalog) {
        const id = `${user.id}:${p.id}`;
        if (!store.get('plugin', id, user.id))
          store.put('plugin', user.id, { ...p, id, catalogId: p.id });
      }
      for (const s of defaultSkills)
        store.put('skill', user.id, { ...s, id: randomUUID(), updatedAt: now() });
      store.put('account-seed', user.id, { id: user.id });
      store.db.exec('COMMIT');
    } catch (error) {
      store.db.exec('ROLLBACK');
      throw error;
    }
  }
  function seedUpgradeSkills(user: User) {
    const id = user.id + ':game-workflow-v3';
    if (store.get('skill-upgrade', id, user.id)) return;
    store.db.exec('BEGIN');
    try {
      const existing = store.list<Skill>('skill', user.id);
      for (const skill of upgradeSkills) {
        if (!existing.some((value) => value.name === skill.name))
          store.put('skill', user.id, { ...skill, id: randomUUID(), updatedAt: now() });
      }
      store.put('skill-upgrade', user.id, { id });
      store.db.exec('COMMIT');
    } catch (error) {
      store.db.exec('ROLLBACK');
      throw error;
    }
  }
  async function seed(user: User) {
    if (store.get('seed', user.id, user.id) || store.get('account-seed', user.id, user.id))
      seedUpgradeSkills(user);
    if (store.get('seed', user.id, user.id)) return;
    if (seedPending.has(user.id)) return seedPending.get(user.id);
    const work = (async () => {
      seedAccount(user);
      // Automatic example objects belong to explicit demo mode. Production
      // login and first workspace access do not depend on cloud writes.
      if (options.demo) {
        const content = Buffer.from(sampleDesign);
        await assets.upload(user.id, '森林入口 · 关卡设计.md', 'text/markdown', content);
      }
      store.put('seed', user.id, { id: user.id });
    })();
    seedPending.set(user.id, work);
    try {
      await work;
    } finally {
      seedPending.delete(user.id);
    }
  }
  function plugins(userId: string): Plugin[] {
    return permissions.plugins(userId);
  }
  app.get('/api/health', async () => ({
    ok: true,
    service: 'LightMao API',
    protocolVersion: 1,
    demoAllowed: !!options.demo,
    features: {
      accountBootstrap: true,
      systemOne: true,
      generations: true,
      capabilityModels: true,
      permissionDefaults: true,
      perception: true,
    },
  }));
  const loginResponse = (
    user: User,
    req: import('fastify').FastifyRequest,
    reply: import('fastify').FastifyReply,
  ) => {
    const response = auth.login(
      user,
      req.headers['user-agent']?.slice(0, 120) || 'LightMao client',
    );
    reply
      .header('Cache-Control', 'no-store')
      .header(
        'Set-Cookie',
        refreshCookie(response.refreshToken, response.cookieMaxAge, !!options.secureCookies),
      );
    return { token: response.token, expiresAt: response.expiresAt, user: response.user };
  };
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/auth/')) return;
    const origin = req.headers.origin;
    const allowed = options.allowedOrigins || ['http://127.0.0.1:4317', 'http://localhost:4317'];
    if (origin && origin !== `${req.protocol}://${req.headers.host}` && !allowed.includes(origin))
      fail(403, '不受信任的登录来源');
  });
  app.post('/api/auth/demo', async (req, reply) => {
    if (!options.demo) fail(403, '演示入口未启用');
    let user = store.list<StoredUser>('user').find((u) => u.email === 'demo@lightmao.local');
    if (!user)
      user = await auth.createUser(
        '开发者',
        'demo@lightmao.local',
        randomBytes(32).toString('hex'),
        'admin',
      );
    if (user.status !== 'active') fail(403, '账号已停用');
    await seed(user);
    return loginResponse(user, req, reply);
  });
  app.post('/api/auth/register', async (req, reply) => {
    const input = z
      .object({
        name: z.string().trim().min(1).max(60),
        email: z.email().max(200),
        password: z.string().min(12).max(200),
      })
      .parse(req.body);
    const user = await auth.createUser(
      input.name,
      input.email.toLowerCase(),
      input.password,
      'member',
    );
    seedAccount(user);
    audit(user.id, 'user.register', '创建账号');
    return loginResponse(user, req, reply);
  });
  app.post('/api/auth/login', async (req, reply) => {
    const { email, password } = z
      .object({ email: z.email(), password: z.string().min(1).max(200) })
      .parse(req.body);
    const user = await auth.verifyPassword(email, password);
    seedAccount(user);
    audit(user.id, 'user.login', '登录');
    return loginResponse(user, req, reply);
  });
  app.post('/api/auth/refresh', async (req, reply) => {
    z.object({}).strict().parse(req.body);
    const response = auth.refresh(readRefreshCookie(req.headers.cookie));
    reply.header('Cache-Control', 'no-store');
    if (response.refreshToken)
      reply.header(
        'Set-Cookie',
        refreshCookie(response.refreshToken, response.cookieMaxAge, !!options.secureCookies),
      );
    return { token: response.token, expiresAt: response.expiresAt, user: response.user };
  });
  app.post('/api/auth/upgrade', async (req, reply) => {
    const current = principal(req);
    if (
      current.token.kind ||
      current.token.sessionId ||
      store.get('auth-upgrade', current.token.id)
    )
      return reply.code(409).send({ error: '此登录无需升级', code: 'ALREADY_UPGRADED' });
    const response = loginResponse(current.user, req, reply);
    store.put('auth-upgrade', 'system', { id: current.token.id, at: now() });
    return response;
  });
  app.get('/api/me', async (req) => actor(req));
  app.get('/api/account/local-session', async (req) => actor(req));
  app.post('/api/logout', async (req, reply) => {
    auth.logout(principal(req));
    reply.header('Set-Cookie', refreshCookie('', 0, !!options.secureCookies));
    audit(actor(req).id, 'user.logout', '退出当前登录；设备授权独立管理');
    return { ok: true };
  });
  app.post('/api/auth/device', async (req, reply) => {
    const input = z
      .object({ deviceId: z.uuid(), label: z.string().trim().min(1).max(80) })
      .parse(req.body);
    const result = auth.device(principal(req), input.deviceId, input.label);
    reply.header('Cache-Control', 'no-store');
    audit(actor(req).id, 'device.authorize', input.label);
    return result;
  });
  app.get('/api/account/sessions', async (req) =>
    auth.sessions(actor(req).id, principal(req).token.sessionId),
  );
  app.delete<{ Params: { id: string } }>('/api/account/sessions/:id', async (req) => {
    auth.revokeSession(actor(req).id, req.params.id);
    return { ok: true };
  });
  app.get('/api/account/devices', async (req) => auth.devices(actor(req).id));
  app.delete<{ Params: { id: string } }>('/api/account/devices/:id', async (req) => {
    auth.revokeDevice(actor(req).id, req.params.id);
    audit(actor(req).id, 'device.revoke', req.params.id);
    return { ok: true };
  });
  app.patch('/api/account/profile', async (req) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(60) }).parse(req.body);
    const user = store.get<StoredUser>('user', actor(req).id)!;
    store.put('user', 'system', { ...user, name });
    return safeUser({ ...user, name });
  });
  app.post('/api/account/password', async (req, reply) => {
    const input = z
      .object({
        currentPassword: z.string().min(1).max(200),
        password: z.string().min(12).max(200),
      })
      .parse(req.body);
    const user = await auth.changePassword(actor(req).id, input.currentPassword, input.password);
    audit(user.id, 'user.password', '密码已修改；旧登录及设备授权已撤销');
    return loginResponse(user, req, reply);
  });
  app.get('/api/account/bootstrap', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return {
      user: actor(req),
      plugins: [],
      skills: [],
      assets: [],
      folders: [],
      storage: assets.info(actor(req).id),
      model: model(),
      arkConfigured: !!options.arkKey,
      demoAllowed: !!options.demo,
      permissions: permissions.info(actor(req).id),
      features: {
        systemOne: true,
        generations: true,
        capabilityModels: true,
        permissionDefaults: true,
        perception: true,
      },
    };
  });
  app.get('/api/bootstrap', async (req) => {
    const user = actor(req);
    await seed(user);
    return {
      user,
      plugins: plugins(user.id),
      skills: store.list<Skill>('skill', user.id).map((s) => skillSummary(s)),
      assets: assets.list(user.id),
      folders: assets.folders(user.id),
      storage: assets.info(user.id),
      model: model(),
      arkConfigured: !!options.arkKey,
      demoAllowed: !!options.demo,
      permissions: permissions.info(user.id),
      features: {
        systemOne: true,
        generations: true,
        capabilityModels: true,
        permissionDefaults: true,
        perception: true,
      },
    };
  });
  app.get('/api/permissions', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return permissions.info(actor(req).id);
  });
  app.patch('/api/permissions', async (req, reply) => {
    const change = z
      .object({ mode: z.enum(['full', 'custom']), revision: z.number().int().min(0) })
      .strict()
      .parse(req.body);
    reply.header('Cache-Control', 'no-store');
    return permissions.setMode(actor(req).id, change.mode, change.revision);
  });
  app.patch<{ Params: { id: string } }>('/api/plugins/:id', async (req) => {
    const patch = z
      .object({ installed: z.boolean().optional(), enabled: z.boolean().optional() })
      .strict()
      .parse(req.body);
    return permissions.patchPlugin(actor(req).id, req.params.id, patch);
  });
  app.post('/api/skills', async (req) => {
    const s = {
      ...skillSchema.strict().parse(req.body),
      id: randomUUID(),
      updatedAt: now(),
      revision: 1,
    };
    store.put('skill', actor(req).id, s);
    audit(actor(req).id, 'skill.create', s.name);
    return s;
  });
  app.get<{ Params: { id: string } }>('/api/skills/:id', async (req) => {
    const s = store.get<Skill>('skill', req.params.id, actor(req).id) || fail(404, '技能不存在');
    return { ...s, ...skillSummary(s), content: s.content };
  });
  app.patch<{ Params: { id: string } }>('/api/skills/:id', async (req) => {
    const s = store.get<Skill>('skill', req.params.id, actor(req).id);
    if (!s) return fail(404, '技能不存在');
    const { revision, ...change } = skillPatchSchema.parse(req.body);
    if (revision !== undefined && revision !== (s.revision || 0))
      fail(409, '技能已被修改，请重新打开编辑');
    const next = { ...s, ...change, revision: (s.revision || 0) + 1, updatedAt: now() };
    store.put('skill', actor(req).id, next);
    audit(actor(req).id, 'skill.update', s.name);
    return next;
  });
  app.delete<{ Params: { id: string } }>('/api/skills/:id', async (req) => {
    store.remove('skill', req.params.id, actor(req).id);
    return { ok: true };
  });
  registerAssetRoutes(app, assets, actor, audit);
  registerAdminRoutes(app, admin, actor);
  app.post('/api/v1/chat/completions', async (req, reply) => {
    if (closing) return fail(503, '模型服务正在退出，请稍后明确重试');
    const user = actor(req);
    const cfg = model();
    if (!cfg.enabled) return fail(403, '管理员已停用模型');
    if (!options.arkKey) return fail(503, '方舟尚未配置，请在后端设置 ARK_API_KEY');
    const input = z
      .object({
        model: z.literal('doubao'),
        messages: z.array(z.record(z.string(), z.unknown())).min(1).max(300),
        stream: z.boolean().optional(),
        tools: z.array(z.record(z.string(), z.unknown())).max(64).optional(),
        tool_choice: z.unknown().optional(),
        max_tokens: z.number().int().positive().max(MAX_CONFIGURED_OUTPUT).optional(),
        max_completion_tokens: z.number().int().positive().max(MAX_CONFIGURED_OUTPUT).optional(),
        reasoning_effort: z
          .enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
          .optional(),
        temperature: z.number().min(0).max(2).optional(),
        stream_options: z.unknown().optional(),
      })
      .strip()
      .refine(
        (v) => v.max_tokens === undefined || v.max_completion_tokens === undefined,
        'max_tokens 与 max_completion_tokens 不能同时设置',
      )
      .parse(req.body);
    const count = modelActive.get(user.id) || 0;
    if (count >= 3) return fail(429, '最多同时运行 3 个模型请求');
    const recent = store
      .list<Usage>('usage')
      .filter(
        (u) =>
          u.userId === user.id &&
          (u.capability || 'chat') === 'chat' &&
          Date.now() - Date.parse(u.at) < 60000,
      );
    if (recent.length >= 30) return fail(429, '模型请求达到每分钟 30 次限制');
    const started = Date.now();
    const id = randomUUID();
    const abort = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, options.modelTimeoutMs ?? 180000);
    timer.unref();
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) abort.abort();
    });
    const usage: Usage = {
      capability: 'chat',
      ...(/^[-\w]{1,128}$/.test(String(req.headers['x-lightmao-trace-id'] || ''))
        ? { traceId: String(req.headers['x-lightmao-trace-id']) }
        : {}),
      ...(/^[-\w]{1,128}$/.test(String(req.headers['x-lightmao-span-id'] || ''))
        ? { spanId: String(req.headers['x-lightmao-span-id']) }
        : {}),
      id,
      userId: user.id,
      model: cfg.modelId,
      status: 'running',
      durationMs: 0,
      at: now(),
    };
    store.put('usage', 'system', usage);
    modelActive.set(user.id, count + 1);
    modelControllers.add(abort);
    let settleModel!: () => void;
    const settledModel = new Promise<void>((resolve) => {
      settleModel = resolve;
    });
    modelSettlements.add(settledModel);
    reply.header('X-Request-ID', id);
    const account = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      const input = value as Record<string, unknown>;
      for (const [source, target] of [
        ['total_tokens', 'totalTokens'],
        ['prompt_tokens', 'promptTokens'],
        ['completion_tokens', 'completionTokens'],
      ] as const) {
        const n = input[source];
        if (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0) usage[target] = n;
      }
    };
    const failed = (reason: Usage['failureReason']) => {
      if (closing) {
        usage.status = 'interrupted';
        delete usage.failureReason;
        return;
      }
      usage.status = timedOut ? 'failed' : abort.signal.aborted ? 'cancelled' : 'failed';
      usage.failureReason = timedOut
        ? 'timeout'
        : abort.signal.aborted
          ? 'client_cancelled'
          : reason;
    };
    let finalized = false;
    const finalize = () => {
      if (finalized) return;
      finalized = true;
      clearTimeout(timer);
      modelControllers.delete(abort);
      modelActive.set(user.id, Math.max(0, (modelActive.get(user.id) || 1) - 1));
      usage.durationMs = Date.now() - started;
      try {
        store.put('usage', 'system', usage);
      } finally {
        modelSettlements.delete(settledModel);
        settleModel();
      }
    };
    try {
      const response = await fetch(
        `${(options.arkBase || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${options.arkKey}`,
          },
          body: JSON.stringify({
            ...Object.fromEntries(
              Object.entries(input).filter(([key]) => key !== 'max_completion_tokens'),
            ),
            model: cfg.modelId,
            max_tokens: Math.min(
              input.max_tokens ||
                input.max_completion_tokens ||
                cfg.maxOutputTokens ||
                modelDefaults(cfg.modelId).maxOutputTokens,
              outputTokenBudget(
                cfg.contextWindowTokens ?? modelDefaults(cfg.modelId).contextWindowTokens,
                cfg.maxOutputTokens ?? modelDefaults(cfg.modelId).maxOutputTokens,
                cfg.modelId,
              ),
            ),
            thinking: {
              type:
                cfg.modelId.startsWith('deepseek-') && input.reasoning_effort !== 'none'
                  ? 'enabled'
                  : 'disabled',
            },
          }),
          signal: abort.signal,
        },
      );
      usage.upstreamStatus = response.status;
      if (!response.ok || !response.body) {
        usage.status = `upstream_${response.status}`;
        usage.failureReason = 'upstream_error';
        await response.body?.cancel().catch(() => {});
        return reply
          .code(response.status >= 400 ? response.status : 502)
          .send({ error: `方舟接口返回 ${response.status}，请检查模型配置与配额`, requestId: id });
      }
      if (input.stream) {
        reply.type('text/event-stream').header('Cache-Control', 'no-cache');
        // Parse usage without buffering the response; only numeric accounting is retained.
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = '',
          complete = false;
        async function* chunks() {
          try {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              pending += decoder.decode(chunk.value, { stream: true });
              if (pending.length > 512000)
                throw new Error('Upstream event exceeded its accounting limit');
              const lines = pending.split('\n');
              pending = lines.pop() || '';
              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  if (line.slice(6).trim() === '[DONE]') complete = true;
                  try {
                    const d = JSON.parse(line.slice(6));
                    account(d.usage);
                  } catch {}
                }
              }
              yield chunk.value;
              if (complete) break;
            }
            if (!complete && !abort.signal.aborted)
              throw new Error('Upstream stream ended before completion');
            if (complete) usage.status = 'completed';
            else failed('stream_incomplete');
          } catch (error) {
            // DONE is authoritative for model accounting, even if the SDK
            // closes its HTTP reader before the upstream socket reaches EOF.
            if (complete) usage.status = 'completed';
            else failed('stream_incomplete');
            if (!complete) throw error;
          } finally {
            if (usage.status === 'running')
              if (complete) usage.status = 'completed';
              else failed('stream_incomplete');
            finalize();
            abort.abort();
            await reader.cancel().catch(() => {});
            reader.releaseLock();
          }
        }
        return reply.send(Readable.from(chunks()));
      }
      const result = (await response.json()) as { usage?: { total_tokens?: number } };
      account(result.usage);
      usage.status = 'completed';
      return reply.send(result);
    } catch {
      failed('network_error');
      return reply
        .code(502)
        .send({ error: '模型请求未完成，请检查服务端网络与配置', requestId: id });
    } finally {
      if (usage.status !== 'running') {
        finalize();
      }
    }
  });
  const webRoot = options.webRoot || resolve('dist/web');
  if (options.serveWeb && existsSync(join(webRoot, 'index.html'))) {
    await app.register(staticFiles, { root: webRoot });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/')
        ? reply.code(404).send({ error: '接口不存在' })
        : reply.sendFile('index.html'),
    );
  }
  app.addHook('onClose', async () => {
    clearInterval(authMaintenance);
    store.close();
  });
  return { app, store, assets, auth, decisions, generations, perception };
}
