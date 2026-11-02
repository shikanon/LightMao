import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Store } from '../../packages/shared/store.ts';
import type { Project, Mode } from '../../packages/shared/types.ts';
import type {
  CollaborationPlan,
  CollaborationRole,
  CollaborationView,
  SubAgentTask,
  SharedCheckpoint,
} from '../../packages/shared/collaboration.ts';
import type { EngineSnapshot } from './engine-snapshot.ts';
import type { IsolatedExecutor } from './isolation.ts';
import type { ProjectService } from './projects.ts';
import type { GroundTruthService } from './ground-truth.ts';
import { captureEngineSnapshot } from './engine-files.ts';
import { ResourceLeases, resourcePath, overlaps } from './resource-leases.ts';
import type { FileChange } from './shared-file-changes.ts';

const path = z.string().refine((value) => {
  try {
    resourcePath(value);
    return true;
  } catch {
    return false;
  }
}, '路径无效');
const role = z
  .object({
    id: z.string().regex(/^[\w-]{1,40}$/),
    name: z.string().trim().min(1).max(60),
    kind: z.enum(['implementer', 'reviewer', 'tester']),
    writePaths: z.array(path).max(16),
  })
  .strict()
  .refine((v) => v.kind === 'implementer' || !v.writePaths.length, '审阅和测试角色不能写工程');
export const collaborationPlanInput = z
  .object({
    objective: z.string().trim().min(1).max(3000),
    milestones: z.array(z.string().trim().min(1).max(300)).min(1).max(12),
    roles: z.array(role).min(1).max(6),
    revision: z.number().int().min(0).optional(),
  })
  .strict()
  .refine((v) => new Set(v.roles.map((r) => r.id)).size === v.roles.length, '角色ID需唯一');
export const delegateInput = z
  .object({
    roleId: z.string().max(40),
    objective: z.string().trim().min(1).max(4000),
    acceptance: z.string().trim().min(1).max(1000),
    writePaths: z.array(path).max(16).default([]),
    dependsOn: z.array(z.uuid()).max(4).default([]),
    maxTurns: z.union([z.literal(3), z.literal(4)]).default(4),
    monitorSourceId: z.uuid().optional(),
  })
  .strict();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const stamp = () => new Date().toISOString();
const fail = (message: string): never => {
  throw Object.assign(Error(message), { statusCode: 409 });
};
const settled = (task: SubAgentTask) =>
  task.status === 'cancelled' ||
  task.status === 'merged' ||
  (task.status === 'verified' && !task.changes.length);
type StoredTask = SubAgentTask & { ownerId: string; branchProjectId?: string };
export interface ChildContext {
  owner: string;
  token: string;
  mode: Mode;
  task: SubAgentTask;
  project: Project;
  signal: AbortSignal;
  assertLive: () => Promise<void>;
  saveTranscript: (messages: AgentMessage[], turns: number) => void;
  report: (type: string, data: unknown) => void;
}
interface Options {
  store: Store;
  dataDir: string;
  projects: ProjectService;
  executor: IsolatedExecutor;
  groundTruth: GroundTruthService;
  runChild: (context: ChildContext) => Promise<{ summary: string; turns: number }>;
  report?: (parent: string, owner: string, type: string, data: unknown) => void;
}
export class CollaborationService {
  readonly leases: ResourceLeases;
  private active = new Map<
    string,
    { controller: AbortController; promise: Promise<void>; owner: string; parent: string }
  >();
  private merging = new Map<string, AbortController>();
  private closing = false;
  constructor(private options: Options) {
    this.leases = new ResourceLeases(options.store);
    for (const task of options.store.list<StoredTask>('subagent-task'))
      if (['queued', 'running'].includes(task.status)) {
        this.save(task.ownerId, {
          ...task,
          status: 'interrupted',
          summary: '本地服务重启，未自动重放子任务；先核对副本和原始记录。',
        });
        this.leases.release(task.ownerId, task.id, task.leases);
      }
    for (const point of options.store.list<SharedCheckpoint & { ownerId: string }>(
      'shared-checkpoint',
    ))
      if (point.status === 'applying')
        options.store.put('shared-checkpoint', point.ownerId, {
          ...point,
          status: 'unknown',
          updatedAt: stamp(),
        });
  }
  private save(owner: string, task: SubAgentTask) {
    return this.options.store.put<StoredTask>('subagent-task', owner, {
      ...task,
      ownerId: owner,
      updatedAt: stamp(),
    });
  }
  get(owner: string, project: string, id: string) {
    const value = this.options.store.get<StoredTask>('subagent-task', id, owner);
    if (!value || value.projectId !== project) return fail('子任务不属于当前项目');
    return value;
  }
  tasks(owner: string, session: string) {
    return this.options.store
      .list<StoredTask>('subagent-task', owner)
      .filter((t) => t.sessionId === session);
  }
  plan(owner: string, session: string) {
    return this.options.store.get<CollaborationPlan>('collaboration-plan', session, owner);
  }
  setPlan(owner: string, session: string, project: string, raw: unknown) {
    const input = collaborationPlanInput.parse(raw),
      previous = this.plan(owner, session);
    if (previous && input.revision !== previous.revision) fail('协作规划版本已变化，请回读');
    if (this.tasks(owner, session).some((t) => !settled(t)))
      fail('当前窗口尚有待核验任务，不能覆盖全局规划');
    const { revision: _, ...body } = input;
    return this.options.store.put<CollaborationPlan>('collaboration-plan', owner, {
      ...body,
      id: session,
      projectId: project,
      revision: (previous?.revision || 0) + 1,
      window: previous ? previous.window + 1 : 1,
      createdAt: previous?.createdAt || stamp(),
      updatedAt: stamp(),
    });
  }
  nextWindow(owner: string, session: string, revision: number) {
    const plan = this.plan(owner, session) || fail('请先规划协作大纲和角色权限');
    if (plan.revision !== revision) fail('协作规划版本已变化');
    const tasks = this.tasks(owner, session).filter((t) => t.window === plan.window);
    if (!tasks.length || tasks.some((t) => !settled(t)))
      fail('当前窗口的任务需先核验、合并或取消；不能继承未经核实的汇报');
    return this.options.store.put('collaboration-plan', owner, {
      ...plan,
      window: plan.window + 1,
      revision: plan.revision + 1,
      updatedAt: stamp(),
    });
  }
  view(owner: string, session: string, project: string): CollaborationView {
    return {
      plan: this.plan(owner, session),
      tasks: this.tasks(owner, session)
        .slice(-24)
        .map((t) => this.publicTask(t)),
      leases: this.leases.list(owner, project),
      sources: this.options.groundTruth.sources(owner, project),
      evidence: this.options.groundTruth.list(owner, project),
      checkpoints: this.options.store
        .list<SharedCheckpoint>('shared-checkpoint', owner)
        .filter((p) => p.projectId === project)
        .slice(-16)
        .map(({ files: _, ...p }) => p),
    };
  }
  publicTask(task: SubAgentTask): SubAgentTask {
    // Do not expose filesystem roots, transcripts or internal ownership in the main conversation.
    const { ownerId: _, branchProjectId: __, ...value } = task as StoredTask;
    return value;
  }
  async delegate(
    owner: string,
    token: string,
    session: string,
    projectId: string,
    parentRunId: string,
    mode: Mode,
    raw: unknown,
    parentToolCallId?: string,
  ) {
    if (this.closing || [...this.active.values()].filter((v) => v.owner === owner).length >= 2)
      fail('子 Agent 最多并行2个，当前没有空闲席位');
    const input = delegateInput.parse(raw),
      plan = this.plan(owner, session) || fail('先保存全局大纲和角色权限，再分派3–4轮任务');
    const selected =
      plan.roles.find((r) => r.id === input.roleId) || fail('角色不在当前全局规划中');
    if (this.tasks(owner, session).filter((t) => t.window === plan.window).length >= 4)
      fail('一个滚动窗口最多4个任务，先核验后进入下一窗口');
    if (
      input.writePaths.some(
        (p) =>
          !selected.writePaths.some(
            (allow) => allow === p || (allow.endsWith('/') && p.startsWith(allow)),
          ),
      )
    )
      fail('子任务写入范围超出角色权限');
    for (const id of input.dependsOn) {
      const dependency = this.get(owner, projectId, id);
      if (
        dependency.sessionId !== session ||
        !settled(dependency) ||
        dependency.status === 'cancelled'
      )
        fail('依赖任务尚未由主 Agent 核验并合并');
    }
    if (input.monitorSourceId)
      this.options.groundTruth.source(owner, projectId, input.monitorSourceId);
    const project = await this.options.projects.requireAccess(
      projectId,
      owner,
      !!input.writePaths.length,
    );
    if (
      this.closing ||
      [...this.active.values()].filter((v) => v.owner === owner).length >= 2 ||
      this.tasks(owner, session).filter((t) => t.window === plan.window).length >= 4 ||
      this.plan(owner, session)?.revision !== plan.revision
    )
      fail('协作窗口或并发状态已变化，请回读后分派');
    const id = randomUUID(),
      task: StoredTask = {
        id,
        ownerId: owner,
        parentRunId,
        parentToolCallId,
        sessionId: session,
        projectId,
        window: plan.window,
        role: selected,
        objective: input.objective,
        acceptance: input.acceptance,
        writePaths: input.writePaths,
        dependsOn: input.dependsOn,
        maxTurns: input.maxTurns,
        turns: 0,
        status: 'queued',
        summary: '独立任务已创建，报告需要主 Agent 核对。',
        changes: [],
        leases: [],
        monitorSourceId: input.monitorSourceId,
        createdAt: stamp(),
        updatedAt: stamp(),
      };
    task.leases = this.leases
      .acquire(owner, projectId, id, input.writePaths)
      .map(({ id, token }) => ({ id, token }));
    this.save(owner, task);
    const controller = new AbortController();
    const control = { controller, owner, parent: parentRunId, promise: Promise.resolve() };
    this.active.set(id, control);
    control.promise = this.perform(task, project, token, mode, controller.signal).finally(() => {
      this.active.delete(id);
      const final = this.get(owner, projectId, id);
      this.leases.release(owner, id, final.leases);
      this.options.report?.(parentRunId, owner, 'subagent.finished', this.publicTask(final));
    });
    void control.promise.catch(() => {});
    return this.publicTask(task);
  }
  private async perform(
    task: StoredTask,
    project: Project,
    token: string,
    mode: Mode,
    signal: AbortSignal,
  ) {
    const { ownerId: owner, id } = task,
      directory = join(this.options.dataDir, 'collaboration', owner, id);
    const heartbeat = setInterval(() => {
      try {
        this.leases.renew(owner, id, task.leases);
      } catch {
        this.active.get(id)?.controller.abort();
      }
    }, 20000);
    heartbeat.unref();
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const root = join(directory, 'project');
      const snapshot = await this.options.executor.exclusive(project.root, () =>
        captureEngineSnapshot(this.options.executor, project.root, root, 20000, signal, 'web'),
      );
      signal.throwIfAborted();
      this.options.store.put('subagent-base', owner, { id, snapshot });
      const branch = this.options.store.put<Project & { internalTaskId: string }>(
        'project',
        owner,
        {
          ...project,
          ...(await this.options.projects.identity(root)),
          id,
          internalTaskId: id,
          source: 'created',
          revision: 1,
          access: task.writePaths.length ? 'write' : 'read',
          createdAt: stamp(),
          updatedAt: stamp(),
        },
      );
      task = this.save(owner, {
        ...task,
        status: 'running',
        baseSha256: snapshot.sha256,
        branchProjectId: id,
      } as StoredTask);
      const assertLive = async () => {
        signal.throwIfAborted();
        if (this.get(owner, project.id, id).status !== 'running')
          fail('任务已撤销或已结束，旧执行不可继续');
        this.leases.assert(owner, id, task.leases);
        await this.options.projects.requireAccess(
          project.id,
          owner,
          !!task.writePaths.length,
          project.root,
        );
      };
      const result = await this.options.runChild({
        owner,
        token,
        task: this.publicTask(task),
        project: branch,
        mode,
        signal,
        assertLive,
        report: (type, data) =>
          this.options.report?.(task.parentRunId, owner, type, { taskId: id, data }),
        saveTranscript: (messages, turns) => {
          if (this.get(owner, project.id, id).status !== 'running') return;
          this.options.store.put('subagent-transcript', owner, { id, messages });
          task = this.save(owner, { ...task, turns });
        },
      });
      await assertLive();
      const after = await this.options.executor.file<EngineSnapshot>(
          root,
          false,
          'snapshot_web',
          {},
          signal,
        ),
        base = new Map(snapshot.files.map((f) => [f.path, f.sha256]));
      if (snapshot.files.some((f) => !after.files.some((a) => a.path === f.path)))
        fail('子任务删除了文件；当前版本不自动合并删除');
      const changes = after.files
        .filter((f) => base.get(f.path) !== f.sha256)
        .map((f) => ({ path: f.path, before: base.get(f.path) || null, after: f.sha256 }));
      if (
        changes.some((c) => !task.writePaths.some((p) => overlaps(p, c.path))) ||
        changes.length > 16
      )
        fail('副本变更超出角色范围或16文件合并预算');
      task = this.save(owner, {
        ...task,
        status: 'reported',
        turns: result.turns,
        summary:
          result.summary.slice(0, 1200) || '本轮已达预算，需主 Agent 核对现有进度后滚动分派。',
        branchSha256: after.sha256,
        changes,
      });
    } catch (e) {
      const current = this.get(owner, project.id, id);
      if (current.status !== 'cancelled')
        this.save(owner, {
          ...current,
          status: 'interrupted',
          summary: signal.aborted
            ? '子任务已中断，未合并到主工程。'
            : (e instanceof Error ? e.message : '子任务失败').slice(0, 1200),
        });
    } finally {
      clearInterval(heartbeat);
    }
  }
  async wait(owner: string, project: string, id: string, seconds: number, signal?: AbortSignal) {
    this.get(owner, project, id);
    const active = this.active.get(id);
    if (active && seconds)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(done, Math.min(25, seconds) * 1000);
        const abort = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          reject(Error('等待已中止'));
        };
        function done() {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          resolve();
        }
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        void active.promise.then(done, done);
      });
    return this.publicTask(this.get(owner, project, id));
  }
  async cancel(owner: string, project: string, id: string) {
    const task = this.get(owner, project, id);
    this.save(owner, {
      ...task,
      status: 'cancelled',
      summary: '任务已撤销，租约已回收；副本保留供核对。',
    });
    this.leases.release(owner, id, task.leases); // Fence first, then wait for cooperative shutdown.
    this.active.get(id)?.controller.abort();
    this.merging.get(id)?.abort();
    await this.active.get(id)?.promise;
    return this.publicTask(this.get(owner, project, id));
  }
  async verify(owner: string, projectId: string, run: string, id: string, evidenceId?: string) {
    let task = this.get(owner, projectId, id);
    if (!['reported', 'verified'].includes(task.status)) fail('只可核验已汇报、未合并的子任务');
    const project = await this.options.projects.requireAccess(projectId, owner);
    if (task.monitorSourceId) {
      try {
        this.options.groundTruth.requireHealthy(
          owner,
          projectId,
          run,
          task.monitorSourceId,
          evidenceId,
        );
      } catch (e) {
        this.save(owner, {
          ...task,
          status: 'contradicted',
          summary: '实时证据未通过，子任务文字结论不予采信；可取消任务或回滚已有变更。',
        });
        throw e;
      }
    }
    this.options.groundTruth.requireChangesHealthy(
      owner,
      projectId,
      run,
      task.changes.map((c) => c.path),
    );
    const current = await this.options.executor.file<EngineSnapshot>(
      project.root,
      false,
      'snapshot_web',
      {},
    );
    const base = this.options.store.get<{ id: string; snapshot: EngineSnapshot }>(
      'subagent-base',
      id,
      owner,
    )!.snapshot;
    const relevant = task.changes.length
      ? task.changes
      : base.files.map((f) => ({ path: f.path, before: f.sha256, after: f.sha256 }));
    if (
      relevant.some(
        (c) => (current.files.find((f) => f.path === c.path)?.sha256 || null) !== c.before,
      )
    ) {
      this.save(owner, {
        ...task,
        status: 'stale',
        summary: '主工程已变化，旧副本不能覆盖当前文件；请重新分派。',
      });
      fail('主工程版本与子任务起点不符，拒绝合并');
    }
    task = this.save(owner, {
      ...task,
      status: 'verified',
      evidenceId,
      verifiedRunId: run,
      verifiedAt: stamp(),
      verifiedProjectSha256: current.sha256,
    });
    return {
      ...this.publicTask(task),
      verification: task.monitorSourceId
        ? '当前文件版本和独立监控已核对；合并前仍重查有效期'
        : '仅当前文件版本已核对；文字中的运行、上线或质量结论不构成验收',
    };
  }
  async merge(owner: string, projectId: string, run: string, id: string, signal: AbortSignal) {
    let task = this.get(owner, projectId, id);
    if (task.status !== 'verified' || task.verifiedRunId !== run || !task.changes.length)
      fail('先由主 Agent 本轮核验有变更的子任务，再合并');
    if (this.merging.has(id)) fail('该任务已有合并正在执行');
    if (task.monitorSourceId)
      this.options.groundTruth.requireHealthy(
        owner,
        projectId,
        run,
        task.monitorSourceId,
        task.evidenceId,
      );
    this.options.groundTruth.requireChangesHealthy(
      owner,
      projectId,
      run,
      task.changes.map((c) => c.path),
    );
    const project = await this.options.projects.requireAccess(projectId, owner, true),
      branch = this.options.projects.get(id, owner);
    const current = await this.options.executor.file<EngineSnapshot>(
        project.root,
        false,
        'snapshot_web',
        {},
        signal,
      ),
      staged = await this.options.executor.file<EngineSnapshot>(
        branch.root,
        false,
        'snapshot_web',
        {},
        signal,
      );
    if (current.sha256 !== task.verifiedProjectSha256 || staged.sha256 !== task.branchSha256)
      fail('核验后的主工程或副本已变化，合并未执行');
    const leaseRefs = this.leases.acquire(
      owner,
      projectId,
      id,
      task.changes.map((c) => c.path),
    );
    const controller = new AbortController(),
      combined = AbortSignal.any([signal, controller.signal]);
    this.merging.set(id, controller);
    const files: SharedCheckpoint['files'] = [],
      changes: FileChange[] = [];
    let point: SharedCheckpoint | undefined;
    try {
      for (const change of task.changes) {
        const content = await this.options.executor.file<string>(
          branch.root,
          false,
          'read_file',
          { path: change.path },
          combined,
        );
        if (hash(content) !== change.after) fail('子任务内容不匹配已核验哈希');
        const before =
          change.before === null
            ? null
            : await this.options.executor.file<string>(
                project.root,
                false,
                'read_file',
                { path: change.path },
                combined,
              );
        if ((before === null ? null : hash(before)) !== change.before)
          fail('主工程刚刚变化，合并未提交');
        files.push({
          path: change.path,
          before,
          beforeSha256: change.before,
          afterSha256: change.after,
        });
        changes.push({ path: change.path, content, expected: change.before });
      }
      point = {
        id: randomUUID(),
        taskId: id,
        projectId,
        status: 'applying',
        files,
        createdAt: stamp(),
        updatedAt: stamp(),
      };
      this.options.store.put('shared-checkpoint', owner, { ...point, ownerId: owner });
      task = this.save(owner, { ...task, checkpointId: point.id });
      this.leases.assert(owner, id, leaseRefs);
      if (this.get(owner, projectId, id).status !== 'verified') fail('任务在提交前被撤销');
      if (task.monitorSourceId)
        this.options.groundTruth.requireHealthy(
          owner,
          projectId,
          run,
          task.monitorSourceId,
          task.evidenceId,
        );
      this.options.groundTruth.requireChangesHealthy(
        owner,
        projectId,
        run,
        task.changes.map((c) => c.path),
      );
      await this.options.executor.file(project.root, true, 'apply_changes', { changes }, combined);
      this.options.store.put('shared-checkpoint', owner, {
        ...point,
        status: 'applied',
        ownerId: owner,
        updatedAt: stamp(),
      });
      return this.publicTask(
        this.save(owner, {
          ...task,
          status: 'merged',
          summary: '变更已按当前文件哈希合并；主目标仍需在主工程实际运行和验收。',
        }),
      );
    } catch (e) {
      if (point)
        this.options.store.put('shared-checkpoint', owner, {
          ...point,
          status: 'unknown',
          ownerId: owner,
          updatedAt: stamp(),
        });
      throw e;
    } finally {
      this.merging.delete(id);
      this.leases.release(owner, id, leaseRefs);
    }
  }
  async rollback(owner: string, projectId: string, checkpointId: string, signal?: AbortSignal) {
    const point = this.options.store.get<SharedCheckpoint>(
      'shared-checkpoint',
      checkpointId,
      owner,
    );
    if (!point || point.projectId !== projectId) fail('回滚记录不属于该项目');
    if (point!.status === 'rolled_back') return { id: point!.id, status: 'rolled_back' };
    await this.cancel(owner, projectId, point!.taskId);
    const project = await this.options.projects.requireAccess(projectId, owner, true),
      holder = 'rollback:' + point!.id;
    const leases = this.leases.acquire(
      owner,
      projectId,
      holder,
      point!.files.map((f) => f.path),
    );
    try {
      this.leases.assert(owner, holder, leases);
      await this.options.executor.file(
        project.root,
        true,
        'apply_changes',
        {
          changes: point!.files.map((f) => ({
            path: f.path,
            expected: f.afterSha256,
            content: f.before,
          })),
        },
        signal,
      );
      this.options.store.put('shared-checkpoint', owner, {
        ...point!,
        status: 'rolled_back',
        ownerId: owner,
        updatedAt: stamp(),
      });
      return {
        id: point!.id,
        status: 'rolled_back',
        restored: point!.files.map((f) => f.path),
        leasesReleased: true,
      };
    } finally {
      this.leases.release(owner, holder, leases);
    }
  }
  transcript(owner: string, project: string, id: string, offset = 0, detailRef?: string) {
    this.get(owner, project, id);
    if (detailRef) {
      const detail = this.options.store.get<{ projectId: string; runId: string }>(
        'tool-detail',
        detailRef,
        owner,
      );
      if (!detail || detail.projectId !== id || detail.runId !== id)
        fail('原始工具记录不属于该子任务');
    }
    const text = detailRef
        ? this.options.store.get<{ text: string }>('tool-payload', detailRef, owner)?.text ||
          fail('原始工具载荷不存在')
        : JSON.stringify(
            this.options.store.get('subagent-transcript', id, owner) || { messages: [] },
            null,
            2,
          ),
      end = Math.min(text.length, offset + 4000);
    return {
      text: text.slice(offset, end),
      totalChars: text.length,
      nextOffset: end < text.length ? end : null,
      sha256: hash(text),
      untrustedReport: true,
    };
  }
  hasActive(owner: string, session: string) {
    return this.tasks(owner, session).some((t) => ['queued', 'running'].includes(t.status));
  }
  async cancelParent(parent: string) {
    await Promise.all(
      [...this.active.entries()]
        .filter(([, c]) => c.parent === parent)
        .map(([id, c]) =>
          this.cancel(
            c.owner,
            this.options.store.get<StoredTask>('subagent-task', id, c.owner)!.projectId,
            id,
          ),
        ),
    );
  }
  async close() {
    this.closing = true;
    for (const c of this.active.values()) c.controller.abort();
    await Promise.allSettled([...this.active.values()].map((c) => c.promise));
    for (const c of this.merging.values()) c.abort();
  }
}
