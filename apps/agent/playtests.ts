import { createServer, type Server } from 'node:http';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Store } from '../../packages/shared/store.ts';
import { now, type GamePreview, type PlaytestJob } from '../../packages/shared/types.ts';
import {
  jevQuestions,
  jevDecision,
  observationSchema,
  type DecisionResponse,
  type DecisionObservation,
} from '../../packages/shared/system-one.ts';
import type { ProjectService } from './projects.ts';
import type { IsolatedExecutor } from './isolation.ts';
import { captureEngineSnapshot, verifiedArtifactBytes } from './engine-files.ts';
import type { EngineSnapshot } from './engine-snapshot.ts';
import { BrowserDriver } from './browser-driver.ts';
import type { EngineService } from './engines.ts';
const fail = (statusCode: number, message: string): never => {
  throw Object.assign(Error(message), { statusCode });
};
const digest = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const entrySchema = z
  .string()
  .min(1)
  .max(300)
  .refine(
    (s) =>
      s.endsWith('.html') &&
      !s.startsWith('/') &&
      !s.split('/').some((v) => v === '..' || v.startsWith('.')) &&
      !/[\\\u0000-\u001f]/.test(s),
    '需要项目内相对HTML路径',
  );
export const playtestInput = z
  .object({
    entry: entrySchema.default('index.html'),
    goal: z.string().trim().min(1).max(3000),
    requestId: z.string().min(1).max(200),
    maxSteps: z.number().int().min(1).max(64).default(12),
    viewport: z
      .object({
        width: z.number().int().min(240).max(1920),
        height: z.number().int().min(240).max(1920),
      })
      .strict()
      .optional(),
    assertions: z
      .array(
        z
          .object({
            field: z.string().regex(/^[A-Za-z_]\w*(\.[A-Za-z_]\w*){0,5}$/),
            op: z.enum(['eq', 'ne', 'gte', 'lte', 'truthy']),
            value: z.union([z.string().max(300), z.number(), z.boolean()]).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict();
type Preview = GamePreview & { ownerId: string; folder: string; snapshot: EngineSnapshot };
type Active = { owner: string; project: string; controller: AbortController; done: Promise<void> };
type PlaytestCapture = NonNullable<PlaytestJob['captures']>[number];
type CaptureSampling = {
  markers: Map<string, string>;
  lastMarker?: string;
  lastStep?: number;
  lastAt?: number;
};
function captureMarker(observation: DecisionObservation) {
  const state = observation.gameState;
  const markers: Record<string, string | number> = {};
  if (typeof state?.phase === 'string') markers.phase = state.phase.slice(0, 80);
  for (const field of ['wave', 'preRound', 'bossLayer', 'drafts']) {
    const value = state?.[field];
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1024)
      markers[field] = value;
  }
  return JSON.stringify(markers);
}
function spread<T>(values: T[], limit: number): T[] {
  if (values.length <= limit) return values;
  if (limit <= 0) return [];
  if (limit === 1) return [values.at(-1)!];
  return Array.from(
    { length: limit },
    (_, index) => values[Math.round((index * (values.length - 1)) / (limit - 1))],
  );
}
/** Phase representatives and distinct milestones share the bounded space with a moving recent window. */
function retainedCaptures(captures: PlaytestCapture[], markers: Map<string, string>) {
  if (captures.length <= 16) return captures;
  const kept = new Set(captures.slice(-4).map((capture) => capture.id));
  const phases = new Map<string, PlaytestCapture>();
  const latestPhases = new Map<string, PlaytestCapture>();
  for (const capture of captures) {
    if (!phases.has(capture.phase || '')) phases.set(capture.phase || '', capture);
    latestPhases.set(capture.phase || '', capture);
  }
  for (const capture of spread([...phases.values()], 8)) kept.add(capture.id);
  // Keep the end of the previous battle/selection phase as well as its initial representative.
  for (const capture of [...latestPhases.values()].reverse()) {
    if (kept.size >= 12) break;
    kept.add(capture.id);
  }
  const selectedMarkers = new Set([...kept].map((id) => markers.get(id)));
  const milestones = new Map<string, PlaytestCapture>();
  for (const capture of captures) {
    const marker = markers.get(capture.id) || '';
    if (!selectedMarkers.has(marker)) milestones.set(marker, capture);
  }
  for (const capture of spread([...milestones.values()], 16 - kept.size)) kept.add(capture.id);
  for (const capture of captures.toReversed()) {
    if (kept.size >= 16) break;
    kept.add(capture.id);
  }
  return captures.filter((capture) => kept.has(capture.id));
}
function verifyAssertions(job: PlaytestJob, state: Record<string, unknown> | undefined) {
  for (const assertion of job.assertions) {
    let actual: unknown = state;
    for (const key of assertion.field.split('.'))
      actual =
        actual && typeof actual === 'object' && Object.hasOwn(actual, key)
          ? (actual as Record<string, unknown>)[key]
          : undefined;
    assertion.passed =
      assertion.op === 'truthy'
        ? !!actual
        : assertion.op === 'eq'
          ? actual === assertion.value
          : assertion.op === 'ne'
            ? actual !== undefined && actual !== assertion.value
            : typeof actual === 'number' &&
              typeof assertion.value === 'number' &&
              (assertion.op === 'gte' ? actual >= assertion.value : actual <= assertion.value);
  }
}
export class PlaytestService {
  observe?: (owner: string, job: PlaytestJob, name: string, payload: unknown) => void;
  private servers = new Map<string, { server: Server; timer: ReturnType<typeof setTimeout> }>();
  private active = new Map<string, Active>();
  private closing = false;
  private previewQueue = Promise.resolve();
  private queuedPreviews = 0;
  constructor(
    private store: Store,
    private dataDir: string,
    private executor: IsolatedExecutor,
    private projects: ProjectService,
    private apiUrl: string,
    private electronPath?: string,
    private engines?: EngineService,
  ) {
    for (const row of store.list<Preview>('game-preview'))
      if (row.active) store.put('game-preview', row.ownerId, { ...row, active: false });
    for (const row of store.list<PlaytestJob & { ownerId: string }>('playtest'))
      if (row.status === 'running')
        store.put('playtest', row.ownerId, {
          ...row,
          status: 'interrupted',
          endedAt: now(),
          error: '上次试玩进程中断，未自动重放动作或模型请求。',
        });
  }
  async startGodot(
    owner: string,
    projectId: string,
    sessionId: string,
    raw: unknown,
    token: string,
    authorize: () => Promise<void>,
    runId?: string,
  ) {
    if (this.closing) fail(503, '试玩服务正在退出');
    if (!this.engines) fail(503, '原生引擎服务不可用');
    const input = playtestInput
      .omit({ entry: true })
      .extend({ visible: z.boolean().default(false) })
      .parse(raw);
    const previous = this.store
      .list<PlaytestJob>('playtest', owner)
      .find((j) => j.projectId === projectId && j.requestId === input.requestId);
    if (previous) {
      if (previous.goal !== input.goal) fail(409, '同一试玩请求的目标已变化');
      return this.get(owner, previous.id);
    }
    if (
      [...this.active.values()].some((a) => a.project === projectId && a.owner === owner) ||
      this.active.size >= 2
    )
      fail(409, '已有试玩在执行，请先等待或停止');
    await authorize();
    await this.projects.requireAccess(projectId, owner);
    if (
      this.closing ||
      [...this.active.values()].some((a) => a.project === projectId && a.owner === owner) ||
      this.active.size >= 2
    )
      fail(409, '已有试玩在执行或服务正在退出');
    const job: PlaytestJob = {
      id: randomUUID(),
      projectId,
      sessionId,
      runId,
      requestId: input.requestId,
      status: 'running',
      goal: input.goal,
      startedAt: now(),
      previewId: '',
      sourceSha256: '',
      steps: 0,
      inputActions: 0,
      requestIds: [],
      assertions: input.assertions,
      rendering: input.visible ? 'native-window' : 'headless',
      audio: 'muted',
    };
    this.store.put('playtest', owner, { ...job, ownerId: owner });
    const controller = new AbortController();
    const done = Promise.resolve()
      .then(() => this.performGodot(owner, job, input, token, authorize, controller.signal))
      .finally(() => this.active.delete(job.id));
    this.active.set(job.id, { owner, project: projectId, controller, done });
    void done.catch(() => {});
    return job;
  }
  private async performGodot(
    owner: string,
    job: PlaytestJob,
    input: Omit<z.infer<typeof playtestInput>, 'entry'> & { visible?: boolean },
    token: string,
    authorize: () => Promise<void>,
    signal: AbortSignal,
  ) {
    const directory = this.folder(owner, job.id),
      trace: unknown[] = [],
      history: unknown[] = [];
    const executionSignal = AbortSignal.any([signal, AbortSignal.timeout(180000)]);
    const save = () => this.store.put('playtest', owner, { ...job, ownerId: owner });
    let engineId: string | undefined;
    let abortEngine: (() => void) | undefined;
    const engines = this.engines!;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const engine = await engines.start(
        owner,
        job.projectId,
        {
          action: 'playtest',
          frames: 3600,
          timeoutSeconds: 120,
          visible: input.visible,
          requestId: 'playtest:' + job.id,
        },
        authorize,
        job.runId,
      );
      engineId = engine.id;
      job.engineJobId = engine.id;
      save();
      abortEngine = () => engines.stop(owner, engine.id);
      executionSignal.addEventListener('abort', abortEngine, { once: true });
      if (executionSignal.aborted) abortEngine();
      let observed = await engines.godotObservation(owner, engine.id, undefined, executionSignal),
        done = false;
      job.sourceSha256 = engines.get(owner, engine.id).snapshot!.sha256;
      save();
      for (let step = 0; step < input.maxSteps; step++) {
        executionSignal.throwIfAborted();
        await authorize();
        await this.projects.requireAccess(job.projectId, owner);
        job.steps++;
        save();
        const observation: DecisionObservation = {
          id: observed.id,
          url: 'godot://authorized-project/' + job.projectId,
          title: 'Godot 原生游戏场景',
          text: '真实引擎中的当前游戏状态；只允许已观察按键动作。',
          gameState: observed.state,
          actions: observed.actions.map((a) => ({
            id: 'godot:' + a.id,
            label: a.label + `（推进${a.frames}帧）`,
            operation: 'PRESS_KEY',
            key: a.key as any,
            holdMs: Math.min(500, Math.max(20, Math.round((a.frames * 1000) / 60))),
          })),
        };
        const request = jevQuestions(observation, input.goal, history);
        const spanId = job.id + '-' + job.steps;
        this.observe?.(owner, job, 'model.decision.request', { spanId, observation, request });
        const response = await fetch(this.apiUrl + '/api/v1/systemone', {
          method: 'POST',
          redirect: 'error',
          headers: {
            authorization: 'Bearer ' + token,
            'content-type': 'application/json',
            'X-Lightmao-Trace-ID': job.runId || job.id,
            'X-Lightmao-Span-ID': spanId,
          },
          body: JSON.stringify(request),
          signal: AbortSignal.any([executionSignal, AbortSignal.timeout(30000)]),
        });
        if (!response.ok) throw Error('方舟原生试玩决策请求未完成，未重复输入');
        const data = (await response.json()) as DecisionResponse;
        this.observe?.(owner, job, 'model.decision.response', { spanId, response: data });
        if (data.requestId) job.requestIds.push(data.requestId);
        save();
        const decision = jevDecision(request, data, observation);
        trace.push({ at: now(), observation, decision, requestId: data.requestId });
        if (decision.operation === 'DONE') {
          done = true;
          break;
        }
        if (decision.operation === 'BLOCKED') throw Error('决策模型判断当前原生按键无法推进目标');
        const action = observed.actions.find((a) => 'godot:' + a.id === decision.action!.id);
        if (!action) throw Error('原生动作不在当前观察集合');
        const old = observed.id;
        executionSignal.throwIfAborted();
        await engines.godotInput(owner, engine.id, old, action.id);
        job.inputActions++;
        save();
        observed = await engines.godotObservation(owner, engine.id, old, executionSignal);
        history.push({ action: action.label, state: observed.state });
      }
      verifyAssertions(job, observed.state);
      await engines.godotInput(owner, engine.id, observed.id, undefined, true);
      const final = await engines.wait(owner, engine.id, executionSignal);
      trace.push({ finalState: observed.state, engineStatus: final.status, phases: final.phases });
      const artifact = final.artifacts.find((a) => a.path === 'native-playtest.png');
      if (artifact) {
        const { bytes } = await engines.artifact(owner, engine.id, artifact.id);
        await writeFile(join(directory, 'screenshot.png'), bytes, { mode: 0o600 });
        job.screenshotSha256 = digest(bytes);
      }
      if (
        !done ||
        !job.inputActions ||
        job.assertions.some((a) => !a.passed) ||
        final.status !== 'completed'
      )
        throw Error(!done ? '原生试玩已到达步数预算' : '原生输入、状态断言或引擎阶段未通过');
      job.status = 'passed';
    } catch (error) {
      job.status = executionSignal.aborted ? 'interrupted' : 'failed';
      job.error = error instanceof Error ? error.message : '原生试玩未完成';
      if (engineId) {
        const engine = engines.get(owner, engineId);
        const diagnostics = engine.diagnostics
          .filter((line) => !line.startsWith('环境告警'))
          .slice(0, 3)
          .join('\n');
        if (diagnostics) job.error = (job.error + '\n' + diagnostics).slice(0, 1600);
        engines.stop(owner, engineId);
        await engines.wait(owner, engineId).catch(() => {});
      }
    } finally {
      if (abortEngine) executionSignal.removeEventListener('abort', abortEngine);
      job.endedAt = now();
      save();
      this.observe?.(owner, job, 'playtest.finished', { playtest: job });
      await writeFile(join(directory, 'trace.json'), JSON.stringify(trace, null, 2), {
        mode: 0o600,
      });
    }
  }
  private folder(owner: string, id: string) {
    return join(this.dataDir, 'playtests', owner, id);
  }
  private previewView({ ownerId: _, folder: __, snapshot: ___, ...view }: Preview): GamePreview {
    return view;
  }
  preview(owner: string, id: string) {
    return this.previewView(
      this.store.get<Preview>('game-preview', id, owner) || fail(404, '作品预览不存在'),
    );
  }
  async createPreview(
    owner: string,
    projectId: string,
    entry: string,
    authorize: () => Promise<void>,
    signal = new AbortController().signal,
  ): Promise<GamePreview> {
    if (this.closing || this.queuedPreviews >= 4) fail(409, '预览服务正在退出或准备队列已满');
    this.queuedPreviews++;
    const work = this.previewQueue
      .catch(() => {})
      .then(() => this.preparePreview(owner, projectId, entry, authorize, signal));
    this.previewQueue = work.then(
      () => {},
      () => {},
    );
    try {
      return await work;
    } finally {
      this.queuedPreviews--;
    }
  }
  private async preparePreview(
    owner: string,
    projectId: string,
    entry: string,
    authorize: () => Promise<void>,
    signal: AbortSignal,
  ) {
    if (this.closing) fail(503, '预览服务正在退出');
    entrySchema.parse(entry);
    await authorize();
    const project = await this.projects.requireAccess(projectId, owner);
    if (this.servers.size >= 4) fail(409, '请先关闭一个已有预览');
    const id = randomUUID(),
      folder = this.folder(owner, id);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const snapshot = await this.executor.exclusive(project.root, () =>
      captureEngineSnapshot(
        this.executor,
        project.root,
        join(folder, 'project'),
        20000,
        signal,
        'web',
      ),
    );
    if (!snapshot.files.some((f) => f.path === entry)) fail(404, '预览入口文件不存在');
    await this.projects.requireAccess(projectId, owner, false, project.root);
    await authorize();
    const token = randomBytes(24).toString('hex'),
      prefix = '/' + token + '/',
      files = new Map(snapshot.files.map((f) => [f.path, f]));
    const types: Record<string, string> = {
      html: 'text/html; charset=utf-8',
      js: 'text/javascript; charset=utf-8',
      mjs: 'text/javascript; charset=utf-8',
      css: 'text/css; charset=utf-8',
      json: 'application/json',
      wasm: 'application/wasm',
      pck: 'application/octet-stream',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      svg: 'image/svg+xml',
      gif: 'image/gif',
      mp4: 'video/mp4',
      webm: 'video/webm',
      mp3: 'audio/mpeg',
      ogg: 'audio/ogg',
      wav: 'audio/wav',
      woff: 'font/woff',
      woff2: 'font/woff2',
      ttf: 'font/ttf',
    };
    const server = createServer((req, res) => {
      void (async () => {
        const host = '127.0.0.1:' + ((server.address() as { port: number })?.port || '');
        if (req.headers.host !== host || !['GET', 'HEAD'].includes(req.method || '')) {
          res.writeHead(403).end();
          return;
        }
        const url = new URL(req.url || '/', 'http://' + host);
        if (!url.pathname.startsWith(prefix)) {
          res.writeHead(404).end();
          return;
        }
        let path;
        try {
          path = decodeURIComponent(url.pathname.slice(prefix.length)) || entry;
        } catch {
          res.writeHead(400).end();
          return;
        }
        const metadata = files.get(path),
          mime = types[path.split('.').at(-1)!.toLowerCase()];
        if (!metadata || !mime) {
          res.writeHead(404).end();
          return;
        }
        const bytes = await verifiedArtifactBytes(join(folder, 'project', path), metadata);
        res.writeHead(200, {
          'content-type': mime,
          'content-length': bytes.length,
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff',
          'content-security-policy':
            "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'",
        });
        res.end(req.method === 'HEAD' ? undefined : bytes);
      })().catch(() => {
        if (!res.headersSent) res.writeHead(409);
        res.end();
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}${prefix}${entry}`;
    const record: Preview = {
      id,
      projectId,
      entry,
      url,
      sourceSha256: snapshot.sha256,
      expiresAt: new Date(Date.now() + 15 * 60000).toISOString(),
      active: true,
      ownerId: owner,
      folder,
      snapshot,
    };
    this.store.put('game-preview', owner, record);
    const timer = setTimeout(() => void this.closePreview(owner, id), 15 * 60000);
    timer.unref();
    this.servers.set(id, { server, timer });
    return this.previewView(record);
  }
  async closePreview(owner: string, id: string) {
    const row = this.store.get<Preview>('game-preview', id, owner) || fail(404, '预览不存在');
    const live = this.servers.get(id);
    if (live) {
      clearTimeout(live.timer);
      live.server.closeAllConnections();
      await new Promise<void>((done) => live.server.close(() => done()));
      this.servers.delete(id);
    }
    this.store.put('game-preview', owner, { ...row, active: false });
    return { closed: true };
  }
  get(owner: string, id: string) {
    const row =
      this.store.get<PlaytestJob & { ownerId?: string }>('playtest', id, owner) ||
      fail(404, '试玩记录不存在');
    const { ownerId: _, ...view } = row;
    return view;
  }
  list(owner: string, projectId: string) {
    this.projects.get(projectId, owner);
    return this.store
      .list<PlaytestJob>('playtest', owner)
      .filter((j) => j.projectId === projectId)
      .slice(-30)
      .reverse()
      .map((j) => this.get(owner, j.id));
  }
  async verifyVersion(owner: string, id: string, root: string, signal?: AbortSignal) {
    const job = this.get(owner, id);
    const before = job.engineJobId
      ? this.store.get<EngineSnapshot>('engine-input', job.engineJobId, owner)
      : this.store.get<Preview>('game-preview', job.previewId, owner)?.snapshot;
    return this.verifySnapshot(before, root, signal);
  }
  async verifyEngineVersion(owner: string, id: string, root: string, signal?: AbortSignal) {
    return this.verifySnapshot(
      this.store.get<EngineSnapshot>('engine-input', id, owner),
      root,
      signal,
    );
  }
  private async verifySnapshot(
    before: EngineSnapshot | undefined,
    root: string,
    signal?: AbortSignal,
  ) {
    if (!before) fail(409, '缺少验证输入清单');
    const after = await this.executor.file<EngineSnapshot>(root, false, 'snapshot_web', {}, signal);
    const runtime = (value: EngineSnapshot) =>
      digest(
        JSON.stringify(
          value.files.filter((f) =>
            /\.(html|js|mjs|css|json|wasm|pck|gd|tscn|tres|godot|cfg|png|jpe?g|webp|svg|gif|mp4|webm|mp3|ogg|wav|ttf|woff2?)$/i.test(
              f.path,
            ),
          ),
        ),
      );
    if (runtime(before!) !== runtime(after)) fail(409, '代码或资源在试玩后变化，请复验当前版本');
  }
  async start(
    owner: string,
    projectId: string,
    sessionId: string,
    raw: unknown,
    token: string,
    authorize: () => Promise<void>,
    runId?: string,
  ) {
    if (this.closing) fail(503, '试玩服务正在退出');
    const input = playtestInput.parse(raw);
    const previous = this.store
      .list<PlaytestJob>('playtest', owner)
      .find((j) => j.projectId === projectId && j.requestId === input.requestId);
    if (previous) {
      if (previous.goal !== input.goal) fail(409, '同一试玩请求的目标已变化');
      return this.get(owner, previous.id);
    }
    if (
      [...this.active.values()].some((a) => a.project === projectId && a.owner === owner) ||
      this.active.size >= 2
    )
      fail(409, '已有试玩在执行，请先等待或停止');
    const preview = await this.createPreview(owner, projectId, input.entry, authorize);
    if (
      [...this.active.values()].some((a) => a.project === projectId && a.owner === owner) ||
      this.active.size >= 2
    ) {
      await this.closePreview(owner, preview.id);
      fail(409, '已有试玩在执行');
    }
    const job: PlaytestJob = {
      id: randomUUID(),
      projectId,
      sessionId,
      runId,
      requestId: input.requestId,
      status: 'running',
      goal: input.goal,
      startedAt: now(),
      previewId: preview.id,
      sourceSha256: preview.sourceSha256,
      steps: 0,
      inputActions: 0,
      requestIds: [],
      assertions: input.assertions,
      rendering: 'browser-window',
      audio: 'muted',
    };
    this.store.put('playtest', owner, { ...job, ownerId: owner });
    const controller = new AbortController();
    const done = Promise.resolve()
      .then(() => this.perform(owner, job, input, preview, token, authorize, controller.signal))
      .finally(() => this.active.delete(job.id));
    this.active.set(job.id, { owner, project: projectId, controller, done });
    void done.catch(() => {});
    return job;
  }
  private async perform(
    owner: string,
    job: PlaytestJob,
    input: z.infer<typeof playtestInput>,
    preview: GamePreview,
    token: string,
    authorize: () => Promise<void>,
    signal: AbortSignal,
  ) {
    const directory = this.folder(owner, job.id),
      trace: unknown[] = [],
      history: unknown[] = [];
    let driver: BrowserDriver | undefined;
    const deadline = AbortSignal.timeout(180000),
      combined = AbortSignal.any([signal, deadline]);
    const textCache = new Map<string, string>();
    const sampling: CaptureSampling = { markers: new Map() };
    const save = () => this.store.put('playtest', owner, { ...job, ownerId: owner });
    const post = async <T>(path: string, body: unknown): Promise<T> => {
      combined.throwIfAborted();
      const spanId = job.id + '-' + job.steps;
      this.observe?.(owner, job, 'model.decision.request', { spanId, path, request: body });
      const response = await fetch(this.apiUrl + path, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + token,
          'content-type': 'application/json',
          'X-Lightmao-Trace-ID': job.runId || job.id,
          'X-Lightmao-Span-ID': spanId,
        },
        body: JSON.stringify(body),
        signal: combined,
        redirect: 'error',
      });
      const data = await response.json();
      this.observe?.(owner, job, 'model.decision.response', {
        spanId,
        status: response.status,
        response: data,
      });
      if (!response.ok) throw Error(data.error || '试玩模型请求未完成');
      return data;
    };
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      driver = new BrowserDriver(join(directory, 'browser-profile'), this.electronPath);
      const abort = () => {
        void driver?.close();
      };
      combined.addEventListener('abort', abort, { once: true });
      let observation = (await driver.init(preview.url, false, input.viewport)).observation,
        done = false;
      await this.captureObservation(owner, job, driver, observation, sampling);
      for (let step = 0; step < input.maxSteps; step++) {
        combined.throwIfAborted();
        const health = await driver.diagnostics();
        if (health.errors.length) {
          trace.push({ runtimeErrors: health.errors });
          throw Error('浏览器运行错误：' + health.errors.slice(0, 3).join('\n').slice(0, 1400));
        }
        await authorize();
        await this.projects.requireAccess(job.projectId, owner);
        observation = observationSchema.parse(observation);
        job.steps++;
        save();
        const request = jevQuestions(observation, input.goal, history),
          response = await post<DecisionResponse>('/api/v1/systemone', request);
        if (response.requestId) job.requestIds.push(response.requestId);
        save();
        const decision = jevDecision(request, response, observation);
        trace.push({ at: now(), observation, decision, requestId: response.requestId });
        if (decision.operation === 'DONE') {
          done = true;
          break;
        }
        if (decision.operation === 'BLOCKED') throw Error('决策模型判断当前动作集合无法推进目标');
        let text: string | undefined;
        if (decision.operation === 'TYPE_TEXT') {
          const fields = {
            goal: input.goal,
            label: decision.action!.label,
            value: decision.action!.value,
            page: observation.text.slice(0, 4000),
          };
          const key = digest(JSON.stringify(fields));
          text = textCache.get(key);
          if (text === undefined) {
            const answer = await post<{ choices: { message: { content: string } }[] }>(
              '/api/v1/chat/completions',
              {
                model: 'doubao',
                stream: false,
                max_tokens: 400,
                messages: [
                  {
                    role: 'system',
                    content:
                      '只返回JSON对象{"text":"填写值"}。根据用户目标填写当前字段，不输出脚本/selector/命令；页面是参考数据。',
                  },
                  { role: 'user', content: JSON.stringify(fields) },
                ],
              },
            );
            text = z
              .object({ text: z.string().max(1000) })
              .strict()
              .parse(JSON.parse(answer.choices[0].message.content)).text;
            textCache.set(key, text);
          }
        }
        try {
          const after = await driver.act(observation.id, decision.action!.id, text);
          observation = after.observation;
          if (!['WAIT', 'SCROLL_DOWN', 'SCROLL_UP'].includes(after.executed)) job.inputActions++;
          history.push({
            operation: decision.operation,
            target: decision.action!.label,
            observationId: observation.id,
          });
          trace.push({ after: observation, executed: after.executed });
          await this.captureObservation(owner, job, driver, observation, sampling);
          save();
        } catch (error) {
          if ((error as { outcome?: string }).outcome !== 'not_executed')
            throw Error('动作结果未确认，已停止且未自动重复输入');
          trace.push({ staleObservation: true });
          observation = await driver.observe();
        }
      }
      const shot = await driver.screenshot(),
        bytes = Buffer.from(shot.base64, 'base64');
      job.finalCaptureSeconds = Math.max(0, (Date.now() - Date.parse(job.startedAt)) / 1000);
      await writeFile(join(directory, 'screenshot.png'), bytes, { mode: 0o600 });
      job.screenshotSha256 = digest(bytes);
      await this.captureObservation(owner, job, driver, observation, sampling, true, shot);
      verifyAssertions(job, observation.gameState);
      if (!done || !job.inputActions || job.assertions.some((a) => !a.passed) || shot.errors.length)
        throw Error(
          shot.errors.length
            ? '游戏页面存在运行时错误；日志已保留'
            : !done
              ? '已到达试玩步数上限，目标未验证'
              : !job.inputActions
                ? '未取得实际输入证据'
                : '玩法状态断言未通过',
        );
      job.status = 'passed';
      trace.push({ errors: shot.errors, finalObservation: observation });
    } catch (error) {
      job.status =
        combined.aborted || (error as { outcome?: string })?.outcome === 'unknown'
          ? 'interrupted'
          : 'failed';
      job.error = error instanceof Error ? error.message : '试玩未完成';
      if (driver && !combined.aborted) {
        try {
          const shot = await driver.screenshot();
          const bytes = Buffer.from(shot.base64, 'base64');
          job.finalCaptureSeconds = Math.max(0, (Date.now() - Date.parse(job.startedAt)) / 1000);
          await writeFile(join(directory, 'screenshot.png'), bytes, { mode: 0o600 });
          job.screenshotSha256 = digest(bytes);
          trace.push({ runtimeErrors: shot.errors });
        } catch {}
      }
    } finally {
      job.endedAt = now();
      save();
      this.observe?.(owner, job, 'playtest.finished', { playtest: job });
      await writeFile(join(directory, 'trace.json'), JSON.stringify(trace, null, 2), {
        mode: 0o600,
      });
      await driver?.close();
      await this.closePreview(owner, preview.id);
    }
  }
  async wait(owner: string, id: string, signal?: AbortSignal) {
    this.get(owner, id);
    const active = this.active.get(id);
    const abort = () => active?.controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      await active?.done;
      return this.get(owner, id);
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }
  stop(owner: string, id: string) {
    this.get(owner, id);
    this.active.get(id)?.controller.abort();
    return { stopping: true };
  }
  async screenshot(owner: string, id: string) {
    const job = this.get(owner, id);
    const bytes = await readFile(join(this.folder(owner, id), 'screenshot.png'));
    if (digest(bytes) !== job.screenshotSha256) fail(409, '试玩截图哈希不一致');
    return bytes;
  }
  private async captureObservation(
    owner: string,
    job: PlaytestJob,
    driver: BrowserDriver,
    observation: DecisionObservation,
    sampling: CaptureSampling,
    force = false,
    suppliedShot?: Awaited<ReturnType<BrowserDriver['screenshot']>>,
  ) {
    const id = 'capture-' + job.steps;
    // A declared capture is immutable, including when final readback happens at the same step.
    if (job.captures?.some((capture) => capture.id === id) || sampling.lastStep === job.steps)
      return;
    const marker = captureMarker(observation);
    if (
      !force &&
      sampling.lastMarker === marker &&
      job.steps - (sampling.lastStep ?? 0) < 3 &&
      Date.now() - (sampling.lastAt ?? 0) < 2000
    )
      return;
    const shot = suppliedShot || (await driver.screenshot()),
      bytes = Buffer.from(shot.thumbnail || shot.base64, 'base64');
    if (bytes.length > 768000) return;
    const capture = {
      id,
      seconds:
        suppliedShot && job.finalCaptureSeconds !== undefined
          ? job.finalCaptureSeconds
          : Math.max(0, (Date.now() - Date.parse(job.startedAt)) / 1000),
      phase:
        typeof observation.gameState?.phase === 'string'
          ? observation.gameState.phase.slice(0, 80)
          : undefined,
      sha256: digest(bytes),
      bytes: bytes.length,
    };
    await writeFile(join(this.folder(owner, job.id), capture.id + '.jpg'), bytes, {
      mode: 0o600,
      flag: 'wx',
    });
    sampling.markers.set(id, marker);
    sampling.lastMarker = marker;
    sampling.lastStep = job.steps;
    sampling.lastAt = Date.now();
    const candidates = [...(job.captures || []), capture];
    job.captures = retainedCaptures(candidates, sampling.markers);
    const retired = candidates.filter(
      (candidate) => !job.captures!.some((kept) => kept.id === candidate.id),
    );
    this.store.put('playtest', owner, { ...job, ownerId: owner });
    this.observe?.(owner, job, '浏览器实际观测', {
      playtestId: job.id,
      sourceVersion: job.sourceSha256,
      capture,
      observation,
      image: { type: 'image', data: bytes.toString('base64'), mimeType: 'image/jpeg' },
    });
    await Promise.all(
      retired.map(async (retiredCapture) => {
        await rm(join(this.folder(owner, job.id), retiredCapture.id + '.jpg'), { force: true });
        sampling.markers.delete(retiredCapture.id);
      }),
    );
  }
  async capture(owner: string, id: string, captureId: string) {
    const job = this.get(owner, id),
      capture = job.captures?.find((c) => c.id === captureId);
    if (!capture) fail(404, '该试玩观测帧不存在');
    const bytes = await readFile(join(this.folder(owner, id), captureId + '.jpg'));
    if (bytes.length !== capture!.bytes || digest(bytes) !== capture!.sha256)
      fail(409, '试玩观测帧哈希不符');
    return { bytes, metadata: capture! };
  }
  async trace(owner: string, id: string, offset: number) {
    this.get(owner, id);
    const text = await readFile(join(this.folder(owner, id), 'trace.json'), 'utf8');
    return {
      text: text.slice(offset, offset + 4000),
      offset,
      nextOffset: offset + 4000 < text.length ? offset + 4000 : null,
      totalChars: text.length,
    };
  }
  async close() {
    this.closing = true;
    await this.previewQueue;
    for (const a of this.active.values()) a.controller.abort();
    await Promise.allSettled([...this.active.values()].map((a) => a.done));
    for (const [id] of this.servers) {
      const row = this.store.get<Preview>('game-preview', id)!;
      await this.closePreview(row.ownerId, id);
    }
  }
}
