import { mkdir, mkdtemp, rm, realpath, readFile, lstat, cp, writeFile } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { fork, execFileSync } from 'node:child_process';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../../packages/shared/store.ts';
import {
  now,
  type EngineConnection,
  type EngineGrant,
  type EngineJob,
  type EngineJobSummary,
  type GodotObservation,
} from '../../packages/shared/types.ts';
import type { ProjectService } from './projects.ts';
import type { IsolatedExecutor } from './isolation.ts';
import type { EngineSnapshot } from './engine-snapshot.ts';
import { textPage } from '../../packages/skills/format.ts';
import {
  engineRunSchema,
  captureProcess,
  type EngineRunInput,
  type EnginePhaseResult,
} from './engine-runner.ts';
import {
  engineFail as fail,
  selectedGodot,
  captureEngineSnapshot,
  copyGodotRuntime,
  collectEngineArtifacts,
  verifiedArtifactBytes,
} from './engine-files.ts';
import { godotPlaytestHarness } from './godot-playtest-harness.ts';

type Connection = Omit<EngineConnection, 'needsAuthorization'> & { executable: string };
type Grant = Omit<EngineGrant, 'grantId'> & {
  id: string;
  executable: string;
  projectRevision: number;
  connectionRevision: number;
  used?: boolean;
};
type Job = EngineJob & {
  inputHash: string;
  workerPid?: number;
  enginePid?: number;
  connectionRevision: number;
};
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const viewJob = (job: Job): EngineJob => {
  const {
    inputHash: _hash,
    workerPid: _pid,
    enginePid: _engine,
    connectionRevision: _revision,
    ...value
  } = job;
  return value;
};
export class EngineService {
  private playtestChannels = new Map<
    string,
    {
      owner: string;
      observation?: GodotObservation;
      expected: number;
      pending: boolean;
      send?: (action: { actionId?: string; quit?: boolean }) => void;
    }
  >();
  private active = new Map<
    string,
    { owner: string; projectId: string; controller: AbortController; done: Promise<void> }
  >();
  private closing = false;
  constructor(
    readonly store: Store,
    readonly dataDir: string,
    readonly executor: IsolatedExecutor,
    readonly projects: ProjectService,
    readonly detectedPath?: string,
  ) {}
  private folder(owner: string, id?: string) {
    return join(this.dataDir, 'engine-jobs', digest(owner), ...(id ? [id] : []));
  }
  async createSample(owner: string) {
    const source = resolve(import.meta.dirname, '../../dist/examples/godot-startrail');
    if (!(await lstat(source)).isDirectory()) fail(503, '示例工程未构建，请重新构建应用');
    const project = await this.projects.create(owner, {
      name: '星光小径 · Godot 示例',
      engine: 'Godot',
      description: '移动、收集星星与重置；包含实际引擎测试。',
    });
    await cp(source, project.root, { recursive: true });
    return project;
  }
  connection(owner: string, projectId: string): EngineConnection | null {
    const project = this.projects.get(projectId, owner);
    const connection = this.store.get<Connection>('engine-connection', projectId, owner);
    if (!connection) return null;
    const { executable: _path, ...metadata } = connection;
    return {
      ...metadata,
      needsAuthorization:
        connection.projectRevision !== (project.revision || 0) ||
        project.status === 'archived' ||
        project.access === 'revoked',
    };
  }
  inheritConnection(owner: string, parentId: string, branchId: string) {
    const approved = this.connection(owner, parentId);
    if (!approved?.enabled || approved.needsAuthorization) return;
    const connection = this.store.get<Connection>('engine-connection', parentId, owner)!;
    const branch = this.projects.get(branchId, owner);
    this.store.put('engine-connection', owner, {
      ...connection,
      id: branchId,
      projectId: branchId,
      projectRevision: branch.revision || 0,
    });
  }
  async useConfiguredEngine(owner: string, projectId: string) {
    const connection = this.connection(owner, projectId);
    if (connection) return connection; // Explicit disabled or stale choices are preserved.
    if (!this.detectedPath) return null;
    const grant = await this.prepare(owner, projectId);
    return this.confirm(owner, projectId, grant.grantId);
  }
  async prepare(owner: string, projectId: string, path = this.detectedPath): Promise<EngineGrant> {
    if (this.closing) fail(503, '本地 Agent 正在退出');
    if (!this.executor.status.available) fail(503, '当前平台的引擎隔离不可用');
    if (!path) fail(400, '请在桌面端选择 Godot 程序，或配置本机引擎路径');
    const project = await this.projects.requireAccess(projectId, owner);
    await this.executor.file(project.root, false, 'read_file', { path: 'project.godot' });
    let selected;
    try {
      selected = await selectedGodot(path!);
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode) throw error;
      return fail(400, '所选 Godot 程序不可用，请重新选择');
    }
    const probes = join(this.dataDir, 'engine-probes');
    await mkdir(probes, { recursive: true, mode: 0o700 });
    const probe = await realpath(await mkdtemp(join(probes, 'probe-')));
    let version: string;
    try {
      const bundle = dirname(selected.executable).endsWith('/Contents/MacOS')
        ? resolve(dirname(selected.executable), '../..')
        : undefined;
      const result = await captureProcess(this.executor, selected.executable, ['--version'], {
        root: probe,
        writable: false,
        readPaths: bundle ? [bundle] : [],
        timeoutMs: 8000,
        outputBytes: 8192,
      });
      version = result.stdout.trim();
      if (
        result.reason ||
        result.code !== 0 ||
        !/^4\.\d+(?:\.\d+)?\.[\w.-]{1,100}$/.test(version) ||
        /mono|dotnet/i.test(version)
      )
        fail(400, '需要可运行的 Godot 4 标准版；当前不自动安装 .NET 或第三方运行环境');
    } finally {
      await rm(probe, { recursive: true, force: true });
    }
    if ((await this.projects.requireAccess(projectId, owner)).revision !== project.revision)
      fail(409, '项目授权已改变，请重新连接引擎');
    for (const grant of this.store.list<Grant>('engine-grant', owner))
      if (Date.parse(grant.expiresAt) < Date.now())
        this.store.remove('engine-grant', grant.id, owner);
    if (this.store.list<Grant>('engine-grant', owner).filter((grant) => !grant.used).length >= 20)
      fail(429, '待确认的引擎连接过多');
    const token = randomBytes(32).toString('base64url');
    const value: Grant = {
      id: digest(token),
      projectId,
      version: version!,
      executable: selected.executable,
      executableName: basename(selected.executable),
      sha256: selected.sha256,
      expiresAt: new Date(Date.now() + 300000).toISOString(),
      scope: '执行工程副本中的导入、场景与测试脚本；副本可写，原工程不写入，禁止网络和子进程。',
      projectRevision: project.revision || 0,
      connectionRevision:
        this.store.get<Connection>('engine-connection', projectId, owner)?.revision || 0,
    };
    this.store.put('engine-grant', owner, value);
    const {
      id: _id,
      executable: _executable,
      projectRevision: _project,
      connectionRevision: _connection,
      ...metadata
    } = value;
    return { ...metadata, grantId: token };
  }
  async confirm(owner: string, projectId: string, token: string) {
    const id = digest(token);
    const getGrant = () => this.store.get<Grant>('engine-grant', id, owner);
    let grant = getGrant();
    if (!grant || grant.projectId !== projectId) fail(403, '引擎选择授权无效');
    if (grant!.used) return this.connection(owner, projectId);
    if (Date.parse(grant!.expiresAt) <= Date.now()) fail(409, '引擎选择已过期，请重新选择');
    const selected = await selectedGodot(grant!.executable);
    if (selected.sha256 !== grant!.sha256)
      fail(409, '引擎程序已改变，请重新选择', 'ENGINE_BINARY_CHANGED');
    const project = await this.projects.requireAccess(projectId, owner);
    grant = getGrant()!;
    if (grant.used) return this.connection(owner, projectId);
    if (Date.parse(grant.expiresAt) <= Date.now()) fail(409, '引擎选择已过期，请重新选择');
    const current = this.store.get<Connection>('engine-connection', projectId, owner);
    if (
      grant.projectRevision !== (project.revision || 0) ||
      grant.connectionRevision !== (current?.revision || 0)
    )
      fail(409, '项目或引擎连接已改变，请重新选择');
    if (this.activeForProject(owner, projectId)) fail(409, '请先停止此项目的引擎任务');
    const connection: Connection = {
      id: projectId,
      projectId,
      engine: 'godot',
      version: grant.version,
      executableName: grant.executableName,
      executable: grant.executable,
      sha256: grant.sha256,
      enabled: true,
      revision: (current?.revision || 0) + 1,
      projectRevision: project.revision || 0,
      updatedAt: now(),
    };
    this.store.db.exec('BEGIN');
    try {
      this.store.put('engine-connection', owner, connection);
      this.store.put('engine-grant', owner, { ...grant, used: true });
      this.store.db.exec('COMMIT');
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
    return this.connection(owner, projectId);
  }
  discardGrant(owner: string, token: string) {
    const id = digest(token),
      grant = this.store.get<Grant>('engine-grant', id, owner);
    if (grant && !grant.used) this.store.remove('engine-grant', id, owner);
    return { ok: true };
  }
  async enable(owner: string, projectId: string, enabled: boolean, revision: number) {
    const connection =
      this.store.get<Connection>('engine-connection', projectId, owner) ||
      fail(404, '项目尚未连接引擎');
    if (connection.revision !== revision) fail(409, '引擎连接已改变，请刷新后重试');
    if (enabled) {
      await this.projects.requireAccess(projectId, owner);
      if (this.connection(owner, projectId)!.needsAuthorization)
        fail(409, '项目已改变，请重新选择引擎并授权');
    }
    if (this.store.get<Connection>('engine-connection', projectId, owner)?.revision !== revision)
      fail(409, '引擎连接已改变');
    this.store.put('engine-connection', owner, {
      ...connection,
      enabled,
      revision: revision + 1,
      updatedAt: now(),
    });
    if (!enabled) this.cancelProject(owner, projectId);
    return this.connection(owner, projectId);
  }
  disconnect(owner: string, projectId: string) {
    this.projects.get(projectId, owner);
    this.cancelProject(owner, projectId);
    this.store.remove('engine-connection', projectId, owner);
    // Invalidate every old unconfirmed choice so deletion cannot resurrect a grant.
    for (const grant of this.store
      .list<Grant>('engine-grant', owner)
      .filter((grant) => grant.projectId === projectId))
      this.store.remove('engine-grant', grant.id, owner);
    return { ok: true };
  }
  activeForProject(owner: string, projectId: string) {
    return [...this.active.values()].some(
      (value) => value.owner === owner && value.projectId === projectId,
    );
  }
  cancelProject(owner: string, projectId: string) {
    for (const value of this.active.values())
      if (value.owner === owner && value.projectId === projectId) value.controller.abort();
  }
  get(owner: string, id: string) {
    return viewJob(this.store.get<Job>('engine-job', id, owner) || fail(404, '引擎运行不存在'));
  }
  async godotObservation(
    owner: string,
    id: string,
    after?: string,
    signal?: AbortSignal,
  ): Promise<GodotObservation> {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const job = this.get(owner, id);
      if (job.action !== 'playtest' || job.status !== 'running')
        fail(409, job.error || '原生试玩已结束');
      const channel = this.playtestChannels.get(id);
      if (
        channel?.owner === owner &&
        channel.observation &&
        (!after || channel.observation.id !== after) &&
        !channel.pending
      )
        return channel.observation;
      await delay(30);
    }
    return fail(408, '原生游戏没有返回下一份有效观察');
  }
  async godotInput(
    owner: string,
    id: string,
    observationId: string,
    actionId?: string,
    quit = false,
  ) {
    const job = this.get(owner, id),
      channel = this.playtestChannels.get(id);
    if (
      job.action !== 'playtest' ||
      job.status !== 'running' ||
      !channel?.send ||
      channel.owner !== owner ||
      channel.pending ||
      channel.observation?.id !== observationId
    )
      fail(409, '原生试玩观察已过期，未重复输入');
    if (!quit && !channel!.observation!.actions.some((a) => a.id === actionId))
      fail(400, '输入不属于已观察动作');
    this.store.put('godot-playtest-input', owner, {
      id: id + ':' + observationId,
      jobId: id,
      observationId,
      actionId,
      quit,
      state: 'submitted',
      at: now(),
    });
    channel!.pending = true;
    channel!.expected++;
    channel!.send!({ actionId, quit });
  }
  list(owner: string, projectId: string) {
    this.projects.get(projectId, owner);
    return this.store
      .list<Job>('engine-job', owner)
      .filter((job) => job.projectId === projectId)
      .slice(-50)
      .reverse()
      .map((job): EngineJobSummary => ({
        id: job.id,
        projectId: job.projectId,
        runId: job.runId,
        action: job.action,
        script: job.script,
        status: job.status,
        stage: job.stage,
        version: job.version,
        startedAt: job.startedAt,
        endedAt: job.endedAt,
        error: job.error?.slice(0, 200),
        snapshot: job.snapshot,
        verification: job.verification,
      }));
  }
  stop(owner: string, id: string) {
    this.get(owner, id);
    this.active.get(id)?.controller.abort();
    return this.get(owner, id);
  }
  logs(
    owner: string,
    id: string,
    input: { offset?: number; limit?: number },
    allowedRuns?: Set<string>,
  ) {
    const job = this.get(owner, id);
    if (allowedRuns && (!job.runId || !allowedRuns.has(job.runId)))
      fail(403, '该引擎日志不属于本会话的运行');
    const value = this.store.get<{ id: string; text: string }>('engine-log', id, owner);
    return { jobId: id, status: job.status, ...textPage(Buffer.from(value?.text || ''), input) };
  }
  inputs(owner: string, id: string, offset: number, limit: number) {
    this.get(owner, id);
    const saved = this.store.get<EngineSnapshot & { id: string }>('engine-input', id, owner);
    return {
      items: saved?.files.slice(offset, offset + limit) || [],
      total: saved?.files.length || 0,
      excluded: saved?.excluded || [],
    };
  }
  async artifact(owner: string, id: string, artifactId: string) {
    const job = this.get(owner, id),
      metadata =
        job.artifacts.find((artifact) => artifact.id === artifactId) || fail(404, '产物不存在');
    const path = join(this.folder(owner, id), 'artifacts', metadata.sha256);
    return { metadata, bytes: await verifiedArtifactBytes(path, metadata) };
  }
  async start(
    owner: string,
    projectId: string,
    raw: unknown,
    authorize: () => Promise<void>,
    runId?: string,
    expectedRevision?: number,
  ) {
    const input = engineRunSchema.parse(raw);
    const requestKey = digest(`${projectId}\0${runId || ''}\0${input.requestId}`),
      inputHash = digest(JSON.stringify(input));
    const existing = this.store.get<{ id: string; jobId: string; inputHash: string }>(
      'engine-request',
      requestKey,
      owner,
    );
    if (existing) {
      if (existing.inputHash !== inputHash) fail(409, '同一请求不能用于不同的引擎操作');
      return this.get(owner, existing.jobId);
    }
    if (this.closing) fail(503, '本地 Agent 正在退出');
    await authorize();
    const project = await this.projects.requireAccess(projectId, owner);
    const repeated = this.store.get<{ id: string; jobId: string; inputHash: string }>(
      'engine-request',
      requestKey,
      owner,
    );
    if (repeated) {
      if (repeated.inputHash !== inputHash) fail(409, '同一请求不能用于不同的引擎操作');
      return this.get(owner, repeated.jobId);
    }
    if (this.closing) fail(503, '本地 Agent 正在退出');
    const connection =
      this.store.get<Connection>('engine-connection', projectId, owner) ||
      fail(403, '请先为此项目连接并授权 Godot');
    if (
      !connection.enabled ||
      this.connection(owner, projectId)!.needsAuthorization ||
      (expectedRevision !== undefined && expectedRevision !== connection.revision)
    )
      fail(403, '引擎连接停用或已改变，请重新授权');
    if (this.activeForProject(owner, projectId) || this.active.size >= 3)
      fail(409, '此项目已有引擎任务，或本机引擎并发已达上限');
    const id = randomUUID(),
      job: Job = {
        id,
        projectId,
        runId,
        ...input,
        inputHash,
        connectionRevision: connection.revision,
        status: 'running',
        stage: 'snapshot',
        version: connection.version,
        executableSha256: connection.sha256,
        startedAt: now(),
        phases: [],
        artifacts: [],
        diagnostics: [],
        verification: 'not_run',
      };
    this.store.db.exec('BEGIN');
    try {
      this.store.put('engine-job', owner, job);
      this.store.put('engine-request', owner, { id: requestKey, jobId: id, inputHash });
      this.store.db.exec('COMMIT');
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
    const controller = new AbortController();
    if (input.action === 'playtest')
      this.playtestChannels.set(id, { owner, expected: 0, pending: false });
    const done = Promise.resolve()
      .then(() =>
        this.perform(owner, job, input, project.root, connection, authorize, controller.signal),
      )
      .finally(() => this.active.delete(id));
    this.active.set(id, { owner, projectId, controller, done });
    void done.catch(() => {});
    return viewJob(job);
  }
  async wait(owner: string, id: string, signal?: AbortSignal) {
    this.get(owner, id);
    const abort = () => this.active.get(id)?.controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      await this.active.get(id)?.done;
      return this.get(owner, id);
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }
  private async perform(
    owner: string,
    job: Job,
    input: EngineRunInput,
    source: string,
    connection: Connection,
    authorize: () => Promise<void>,
    signal: AbortSignal,
  ) {
    const directory = this.folder(owner, job.id),
      workspace = join(directory, 'project'),
      runtime = join(directory, 'runtime');
    let log = '';
    const save = () => this.store.put('engine-job', owner, job);
    const deadline = Date.now() + input.timeoutSeconds * 1000;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const snapshot = await this.executor.exclusive(source, () =>
        captureEngineSnapshot(this.executor, source, workspace, deadline - Date.now(), signal),
      );
      this.store.put('engine-input', owner, { id: job.id, ...snapshot });
      job.snapshot = {
        sha256: snapshot.sha256,
        fileCount: snapshot.files.length,
        totalBytes: snapshot.totalBytes,
        excludedCount: snapshot.excludedCount,
      };
      save();
      signal.throwIfAborted();
      const current = await this.projects.requireAccess(job.projectId, owner);
      if (
        current.revision !== connection.projectRevision ||
        this.store.get<Connection>('engine-connection', job.projectId, owner)?.revision !==
          connection.revision
      )
        fail(409, '工程或引擎授权在采集后发生变化');
      await authorize();
      if (input.action === 'playtest') {
        await writeFile(join(workspace, 'lightmao_autoplay_driver.gd'), godotPlaytestHarness, {
          flag: 'wx',
          mode: 0o600,
        });
        this.store.put('engine-driver', owner, {
          id: job.id,
          sha256: digest(godotPlaytestHarness),
          source: 'LightMao fixed playtest driver',
        });
      }
      const binary = await copyGodotRuntime(connection.executable, connection.sha256, runtime);
      signal.throwIfAborted();
      const canonicalProject = await realpath(workspace),
        canonicalRuntime = await realpath(runtime);
      const canonicalBinary = await realpath(binary);
      if (deadline <= Date.now()) fail(408, '工程准备超过运行时限', 'ENGINE_TIMEOUT');
      const env: NodeJS.ProcessEnv = {
        PATH: '/usr/bin:/bin',
        LANG: 'C.UTF-8',
        NODE_NO_WARNINGS: '1',
      };
      if (process.env.LIGHTMAO_SANDBOX_NODE_IS_ELECTRON === 'true') {
        env.ELECTRON_RUN_AS_NODE = '1';
        env.LIGHTMAO_SANDBOX_NODE = this.executor.executable;
        env.LIGHTMAO_SANDBOX_NODE_IS_ELECTRON = 'true';
      }
      const child = fork(
        resolve(import.meta.dirname, '../../dist/agent/engine-worker.js'),
        [job.id],
        {
          execPath: this.executor.executable,
          execArgv: [],
          env,
          cwd: resolve('.'),
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        },
      );
      job.workerPid = child.pid;
      const channel = this.playtestChannels.get(job.id);
      if (channel)
        channel.send = (action) => {
          if (!child.connected) fail(409, '原生试玩执行器已断开，结果未确认');
          child.send({ type: 'playtest-action', ...action });
        };
      save();
      let final: { reason?: string; error?: string } | undefined;
      const abort = () => {
        if (child.connected) child.send({ type: 'cancel' });
      };
      signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, Math.max(1, deadline - Date.now()) + 1000);
      let workerError = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        if (workerError.length < 1000) workerError += chunk.toString('utf8');
      });
      try {
        await new Promise<void>((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', (code) =>
            final
              ? resolve()
              : reject(
                  Object.assign(new Error('引擎监督进程中断，结果未确认'), {
                    code: 'ENGINE_WORKER_INTERRUPTED',
                  }),
                ),
          );
          child.on('message', (raw: unknown) => {
            const message = raw as {
              type: string;
              stage?: Job['stage'];
              value?: EnginePhaseResult;
              reason?: string;
              error?: string;
              pid?: number;
              observation?: unknown;
            };
            if (message.type === 'stage') {
              job.stage = message.stage!;
              save();
            } else if (
              message.type === 'engine-process' &&
              Number.isSafeInteger(message.pid) &&
              message.pid! > 1
            ) {
              job.enginePid = message.pid;
              save();
            } else if (message.type === 'playtest-observation' && channel) {
              const parsed = z
                .object({
                  id: z.string().regex(/^\d{1,2}$/),
                  state: z.record(z.string(), z.unknown()),
                  actions: z
                    .array(
                      z.object({
                        id: z.string().regex(/^[\w-]{1,60}$/),
                        label: z.string().max(300),
                        key: z.enum([
                          'UP',
                          'DOWN',
                          'LEFT',
                          'RIGHT',
                          'W',
                          'A',
                          'S',
                          'D',
                          'SPACE',
                          'ENTER',
                          'ESCAPE',
                          'R',
                          'E',
                          'SHIFT',
                          '0',
                          '1',
                          '2',
                          '3',
                          '4',
                          '5',
                          '6',
                          '7',
                          '8',
                          '9',
                        ]),
                        frames: z.number().int().min(1).max(120),
                      }),
                    )
                    .max(24),
                })
                .safeParse(message.observation);
              if (
                parsed.success &&
                Number(parsed.data.id) === channel.expected &&
                new Set(parsed.data.actions.map((a) => a.id)).size === parsed.data.actions.length
              ) {
                channel.observation = { ...parsed.data, id: job.id + ':' + parsed.data.id };
                channel.pending = false;
                if (channel.expected > 0) {
                  const inputId = job.id + ':' + job.id + ':' + String(channel.expected - 1);
                  const prior = this.store.get<{ id: string }>(
                    'godot-playtest-input',
                    inputId,
                    owner,
                  );
                  if (prior)
                    this.store.put('godot-playtest-input', owner, {
                      ...prior,
                      state: 'completed',
                      observedAt: now(),
                    });
                }
                this.store.put('godot-playtest-observation', owner, {
                  ...channel.observation,
                  jobId: job.id,
                });
              } else {
                job.error = '原生试玩观察不符合受支持的动作/状态协议';
                abort();
              }
            } else if (message.type === 'phase') {
              delete job.enginePid;
              const value = message.value!;
              job.phases.push(value.phase);
              job.diagnostics.push(...value.diagnostics);
              log += `\n[${value.phase.name} / stdout]\n${value.stdout}\n[${value.phase.name} / stderr]\n${value.stderr}\n`;
              this.store.put('engine-log', owner, { id: job.id, text: log });
              save();
            } else if (message.type === 'done')
              final = { reason: message.reason, error: message.error };
          });
          child.send({
            type: 'start',
            dataDir: join(directory, 'supervisor'),
            project: canonicalProject,
            runtime: canonicalRuntime,
            binary: canonicalBinary,
            input,
            deadline,
          });
          if (signal.aborted) abort();
        });
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (child.connected) child.disconnect();
      }
      delete job.workerPid;
      const expected = input.action === 'validate' ? ['import'] : ['import', input.action];
      if (
        !final ||
        (!final.reason &&
          (job.phases.length !== expected.length ||
            job.phases.some(
              (phase, index) =>
                phase.name !== expected[index] || phase.code !== 0 || phase.errorCount > 0,
            )))
      )
        fail(503, '引擎阶段证据不完整，运行结果未确认', 'ENGINE_WORKER_INTERRUPTED');
      if (final?.reason) {
        job.code = final.reason;
        job.error =
          final.error ||
          (
            {
              cancelled: '用户停止了引擎运行',
              timeout: '引擎运行超时',
              output_limit: '引擎输出超过上限',
              engine_failed: '引擎报告错误，请查看日志',
            } as Record<string, string>
          )[final.reason] ||
          '引擎未正常完成';
        job.status = final.reason === 'cancelled' ? 'cancelled' : 'failed';
      } else {
        job.status = 'completed';
        job.verification =
          input.action === 'script' || input.action === 'playtest' ? 'unreported' : 'process_only';
      }
      job.artifacts = await collectEngineArtifacts(workspace, join(directory, 'artifacts'));
      const report = job.artifacts.find((value) => value.path === 'test-results.json');
      if (input.action === 'script' && report) {
        const bytes = await verifiedArtifactBytes(
          join(directory, 'artifacts', report.sha256),
          report,
        );
        if (bytes.length > 128000) fail(400, '测试报告超过 128 KB');
        const data = JSON.parse(bytes.toString('utf8')) as {
          schema?: number;
          tests?: { name: string; passed: boolean }[];
        };
        if (
          data.schema !== 1 ||
          !Array.isArray(data.tests) ||
          !data.tests.length ||
          data.tests.length > 1000 ||
          data.tests.some(
            (test) => typeof test.name !== 'string' || typeof test.passed !== 'boolean',
          )
        )
          fail(400, '测试报告格式无效');
        job.verification =
          data.tests!.every((test) => test.passed) && job.status === 'completed'
            ? 'tests_passed'
            : 'tests_failed';
        if (job.verification === 'tests_failed') {
          job.status = 'failed';
          job.error ||= '项目测试报告包含未通过的断言';
        }
      }
    } catch (error) {
      const value = error as Error & { code?: string };
      job.status = signal.aborted
        ? 'cancelled'
        : value.code === 'ENGINE_WORKER_INTERRUPTED'
          ? 'interrupted'
          : 'failed';
      job.error = signal.aborted
        ? '用户停止了引擎运行；原工程未由引擎改写'
        : value.message.slice(0, 600);
      job.code = value.code;
    } finally {
      this.playtestChannels.delete(job.id);
      await this.reapEngine(owner, job);
      job.stage = 'finished';
      job.endedAt = now();
      delete job.workerPid;
      delete job.enginePid;
      this.store.put('engine-log', owner, { id: job.id, text: log });
      save();
      await Promise.allSettled(
        ['project', 'runtime', 'supervisor'].map((name) =>
          rm(join(directory, name), { recursive: true, force: true }),
        ),
      );
    }
  }
  async recover() {
    const rows = this.store.db
      .prepare("SELECT owner,data FROM records WHERE kind='engine-job'")
      .all() as { owner: string; data: string }[];
    for (const row of rows) {
      const job = JSON.parse(row.data) as Job;
      if (job.status !== 'running') continue;
      await this.reapEngine(row.owner, job);
      if (job.workerPid)
        try {
          const command = execFileSync('ps', ['-p', String(job.workerPid), '-o', 'command='], {
            encoding: 'utf8',
          }).trim();
          if (command.includes('/engine-worker.js ') && command.endsWith(' ' + job.id)) {
            process.kill(job.workerPid, 'SIGTERM');
            for (let index = 0; index < 40; index++) {
              try {
                process.kill(job.workerPid, 0);
                await delay(50);
              } catch {
                break;
              }
            }
          }
        } catch {}
      job.status = 'interrupted';
      job.stage = 'finished';
      job.endedAt = now();
      job.error = '本地 Agent 曾退出；引擎结果未确认，不自动重跑。';
      delete job.workerPid;
      delete job.enginePid;
      this.store.put('engine-job', row.owner, job);
      const directory = this.folder(row.owner, job.id);
      await Promise.allSettled(
        ['project', 'runtime', 'supervisor'].map((name) =>
          rm(join(directory, name), { recursive: true, force: true }),
        ),
      );
    }
  }
  async close() {
    this.closing = true;
    for (const control of this.active.values()) control.controller.abort();
    await Promise.allSettled([...this.active.values()].map((control) => control.done));
  }
  private async reapEngine(owner: string, job: Job) {
    if (!job.enginePid) return;
    try {
      const directory = await realpath(this.folder(owner, job.id));
      const command = execFileSync('ps', ['-p', String(job.enginePid), '-o', 'command='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (!command.includes(directory + '/runtime/') || !command.includes(directory + '/project'))
        return;
      const group = Number(
        execFileSync('ps', ['-p', String(job.enginePid), '-o', 'pgid='], {
          encoding: 'utf8',
        }).trim(),
      );
      process.kill(group === job.enginePid ? -job.enginePid : job.enginePid, 'SIGKILL');
      for (let index = 0; index < 40; index++) {
        try {
          const state = execFileSync('ps', ['-p', String(job.enginePid), '-o', 'stat='], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
          }).trim();
          if (!state || state.startsWith('Z')) break;
          await delay(50);
        } catch {
          break;
        }
      }
    } catch {}
  }
}
