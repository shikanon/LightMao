import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentGoal, CloudBootstrap, GoalEvidence } from '../../packages/shared/types.ts';
import type {
  GoalCheckpointInput,
  GoalVerifiedObservation,
} from '../../packages/shared/long-horizon.ts';
import type { EngineSnapshot } from './engine-snapshot.ts';
import type { IsolatedExecutor } from './isolation.ts';
import type { WorkflowService } from './workflows.ts';
import type { TraceService } from './trace.ts';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const writes = new Set([
  'write_file',
  'edit_file',
  'import_generated_asset',
  'prepare_game_asset',
  'apply_subagent_changes',
  'rollback_shared_changes',
]);
const probes = new Set([
  'run_browser_playtest',
  'run_godot_playtest',
  'run_godot',
  'complete_goal',
]);
export function goalEnvironment(
  bootstrap: CloudBootstrap,
  backend: string,
  projectRevision: number,
) {
  return digest({
    backend,
    projectRevision,
    model: bootstrap.model,
    permissions: bootstrap.permissions,
    plugins: bootstrap.plugins
      .map((p) => ({ id: p.id, installed: p.installed, enabled: p.enabled, tools: p.tools }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    skills: bootstrap.skills
      .filter((s) => s.enabled)
      .map((s) => ({ id: s.id, updatedAt: s.updatedAt }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
}
/** Real source manifests stay outside the model's prose and can invalidate old observations. */
export class GoalObserver {
  private snapshot?: EngineSnapshot;
  private environmentVersion?: string;
  private activeErrors: string[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private lastBootstrap?: CloudBootstrap;
  private pendingWrites = new Map<string, number>();
  private observationQueue: Promise<unknown> = Promise.resolve();
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.observationQueue.then(fn);
    this.observationQueue = next.catch(() => {});
    return next;
  }
  rebaseRequested = false;
  constructor(
    private o: {
      owner: string;
      session: string;
      run: string;
      goal: AgentGoal;
      root: string;
      backend: string;
      projectRevision: number;
      executor: IsolatedExecutor;
      workflows: WorkflowService;
      traces: TraceService;
      signal: AbortSignal;
      stop: (reason: string) => void;
      collaboration: () => {
        unresolvedChildren: number;
        conflictedLeases: number;
        contradictedChildren: number;
      };
      expectedPaths?: (name: string, args: unknown) => string[];
    },
  ) {}
  private async source(): Promise<EngineSnapshot> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.o.executor.file<EngineSnapshot>(
          this.o.root,
          false,
          'fingerprint_project',
          {},
          this.o.signal,
        );
      } catch (e) {
        if (
          this.o.signal.aborted ||
          attempt >= 2 ||
          !/采集.*变化|采集.*修改|文件.*变化|工程.*修改/.test(e instanceof Error ? e.message : '')
        )
          throw e;
        await delay(30, undefined, { signal: this.o.signal });
      }
    }
  }
  private paths(before: EngineSnapshot | undefined, after: EngineSnapshot | undefined) {
    if (!before || !after) return [];
    return after.files
      .filter((f) => before.files.find((v) => v.path === f.path)?.sha256 !== f.sha256)
      .map((f) => f.path)
      .concat(
        before.files.filter((f) => !after.files.some((v) => v.path === f.path)).map((f) => f.path),
      );
  }
  private writePaths(name: string, args: unknown) {
    if (name === 'prepare_game_asset') {
      const path = (args as { outputDir?: unknown })?.outputDir;
      if (
        typeof path !== 'string' ||
        !path ||
        path.endsWith('/') ||
        path.startsWith('/') ||
        path.split('/').some((p) => !p || p.startsWith('.') || /[\\\u0000-\u001f]/.test(p))
      )
        return [];
      return [path + '/'];
    }
    if (this.o.expectedPaths)
      return this.o.expectedPaths(name, args).map((p) => p.replace(/^\.\//, ''));
    const a = args as { path?: string; targetPath?: string };
    const path = a?.path || a?.targetPath;
    return path ? [path.replace(/^\.\//, '')] : [];
  }
  private pendingPath(path: string) {
    return [...this.pendingWrites.keys()].some(
      (p) => p === path || (p.endsWith('/') && path.startsWith(p)),
    );
  }
  private record(input: GoalCheckpointInput) {
    const result = this.o.workflows.checkpoint(this.o.owner, this.o.goal.id, this.o.run, input);
    this.o.traces.append(this.o.owner, this.o.run, {
      kind: 'goal.checkpoint',
      name: '真实执行检查点',
      spanId: this.o.run,
      status: result.review.action,
      payload: {
        contractHash: result.goal.contractHash,
        checkpointId: result.checkpoint.id,
        input,
        review: result.review,
      },
    });
    if (['blocked', 'budget_limited'].includes(result.goal.status))
      this.o.stop(result.goal.reason || '目标执行保护已停止本轮');
    return result;
  }
  private collaboration() {
    const state = this.o.collaboration();
    this.o.traces.append(this.o.owner, this.o.run, {
      kind: 'collaboration.checkpoint',
      name: '主子任务与共享状态核对',
      spanId: this.o.run,
      payload: state,
    });
    return state;
  }
  async start(bootstrap: CloudBootstrap) {
    this.lastBootstrap = bootstrap;
    this.snapshot = await this.source();
    this.environmentVersion = goalEnvironment(bootstrap, this.o.backend, this.o.projectRevision);
    const current = this.o.workflows.goal(this.o.owner, this.o.session)!;
    this.activeErrors = current.runtime?.activeErrors || [];
    this.record({
      phase: 'start',
      sourceVersion: this.snapshot.sha256,
      environmentVersion: this.environmentVersion,
      activeErrors: this.activeErrors,
      ...this.collaboration(),
    });
    const consumed =
      (current.activeElapsedMs || 0) +
      (current.currentRoundStartedAt
        ? Math.max(0, Date.now() - Date.parse(current.currentRoundStartedAt))
        : 0);
    const remaining = Math.max(1, (current.maxMinutes ?? 60) * 60000 - consumed);
    this.timer = setTimeout(() => {
      if (this.o.workflows.goal(this.o.owner, this.o.session)?.status !== 'active') return;
      try {
        this.record({
          phase: 'finish',
          sourceVersion: this.snapshot?.sha256,
          environmentVersion: this.environmentVersion,
        });
      } catch {
        /* Keep interruption visible even if persisted integrity is broken. */
      } finally {
        if (this.o.workflows.goal(this.o.owner, this.o.session)?.status !== 'completed')
          this.o.stop('目标主动执行时间预算已到，未标记完成。');
      }
    }, remaining);
    this.timer.unref();
  }
  before(name: string, args: unknown, current: CloudBootstrap) {
    return this.serial(() => this.beforeNow(name, args, current));
  }
  private async beforeNow(name: string, args: unknown, current: CloudBootstrap) {
    this.lastBootstrap = current;
    const environment = goalEnvironment(current, this.o.backend, this.o.projectRevision);
    const next =
      writes.has(name) || probes.has(name) || name.startsWith('mcp_')
        ? await this.source()
        : this.snapshot;
    const changed = this.paths(this.snapshot, next);
    const pendingOwnChange = changed.length > 0 && changed.every((p) => this.pendingPath(p));
    const drift =
      (!!this.snapshot && !!next && next.sha256 !== this.snapshot.sha256 && !pendingOwnChange) ||
      (!!this.environmentVersion && environment !== this.environmentVersion);
    if (drift) {
      this.o.traces.append(this.o.owner, this.o.run, {
        kind: 'environment.checkpoint',
        name: '外部变化使旧观察失效',
        spanId: this.o.run,
        status: 'blocked',
        payload: {
          drift: true,
          blocked: true,
          sourceVersion: next?.sha256,
          previousSourceVersion: this.snapshot?.sha256,
          environmentVersion: environment,
          previousEnvironmentVersion: this.environmentVersion,
        },
      });
      this.snapshot = next;
      this.environmentVersion = environment;
      this.rebaseRequested = true;
      this.record({
        phase: 'start',
        sourceVersion: next?.sha256,
        environmentVersion: environment,
        externalChange: true,
        ...this.collaboration(),
      });
      return {
        allowed: false,
        action: 'rebase' as const,
        reason: '工程或模型/权限环境已变化；已保存状态，下一轮重新核对实际文件与计划后继续。',
      };
    }
    const guarded = this.o.workflows.guard(this.o.owner, this.o.goal.id, {
      name,
      argsSha256: digest(args),
    });
    if (guarded.allowed && writes.has(name))
      for (const path of this.writePaths(name, args))
        this.pendingWrites.set(path, (this.pendingWrites.get(path) || 0) + 1);
    return guarded;
  }
  after(
    name: string,
    args: unknown,
    succeeded: boolean,
    error: string | undefined,
    verified: GoalVerifiedObservation[] = [],
    waiting = false,
    resultSha256?: string,
    quality?: { passed: boolean; reason?: string; key?: string; supersedes?: string },
  ) {
    return this.serial(() =>
      this.afterNow(name, args, succeeded, error, verified, waiting, resultSha256, quality),
    );
  }
  private async afterNow(
    name: string,
    args: unknown,
    succeeded: boolean,
    error: string | undefined,
    verified: GoalVerifiedObservation[] = [],
    waiting = false,
    resultSha256?: string,
    quality?: { passed: boolean; reason?: string; key?: string; supersedes?: string },
  ) {
    const before = this.snapshot;
    if (writes.has(name) || probes.has(name) || name.startsWith('mcp_'))
      this.snapshot = await this.source();
    const changed = this.paths(before, this.snapshot);
    const expected = this.writePaths(name, args);
    const unexpected =
      writes.has(name) &&
      changed.some(
        (path) =>
          !expected.some((p) => p === path || (p.endsWith('/') && path.startsWith(p))) &&
          !this.pendingPath(path),
      );
    if (writes.has(name))
      for (const path of expected) {
        const remaining = (this.pendingWrites.get(path) || 0) - 1;
        if (remaining > 0) this.pendingWrites.set(path, remaining);
        else this.pendingWrites.delete(path);
      }
    if (unexpected) this.rebaseRequested = true;
    if ((!succeeded || error) && probes.has(name)) this.activeErrors = [error || '实际运行未通过'];
    if (name === 'prepare_game_asset' && quality) {
      const prefix = '素材检查未通过：',
        key = quality.key || 'unknown';
      this.activeErrors = this.activeErrors.filter((e) => {
        if (!e.startsWith(prefix)) return true;
        try {
          const saved = JSON.parse(e.slice(prefix.length));
          return (
            saved.key !== key &&
            !(quality.passed && quality.supersedes && saved.key === quality.supersedes)
          );
        } catch {
          return true;
        }
      });
      if (!quality.passed)
        this.activeErrors.push(
          prefix +
            JSON.stringify({
              key,
              reason: quality.reason || '透明像素、空帧、裁边或中心轴需要修复',
            }),
        );
    }
    if (verified.some((v) => v.kind === 'engine-job' || v.kind === 'playtest'))
      this.activeErrors = this.activeErrors.filter((e) => e.startsWith('素材检查未通过：'));
    const observation = verified.map((v) => ({
      ...v,
      sourceVersion: this.snapshot!.sha256,
      environmentVersion: this.environmentVersion,
    }));
    const result = this.record({
      phase: 'tool',
      sourceVersion: this.snapshot?.sha256,
      environmentVersion: this.environmentVersion,
      externalChange: unexpected,
      // Waiting on an already-durable asynchronous intent is not a new failure or verified progress.
      ...(waiting
        ? {}
        : { operation: { name, argsSha256: digest(args), resultSha256, succeeded, error } }),
      verifiedEvidence: observation,
      activeErrors: this.activeErrors,
      ...this.collaboration(),
    });
    if (unexpected)
      this.o.traces.append(this.o.owner, this.o.run, {
        kind: 'environment.checkpoint',
        name: '写入期间出现额外文件变化',
        spanId: this.o.run,
        status: 'blocked',
        payload: { drift: true, blocked: true, changedPaths: changed.slice(0, 40), expected },
      });
    return result;
  }
  acceptance(evidence: GoalEvidence[], current: CloudBootstrap) {
    return this.serial(() => this.acceptanceNow(evidence, current));
  }
  private async acceptanceNow(evidence: GoalEvidence[], current: CloudBootstrap) {
    const next = await this.source(),
      environment = goalEnvironment(current, this.o.backend, this.o.projectRevision);
    if (this.snapshot?.sha256 !== next.sha256 || this.environmentVersion !== environment) {
      this.snapshot = next;
      this.environmentVersion = environment;
      this.rebaseRequested = true;
      this.record({
        phase: 'acceptance',
        sourceVersion: next.sha256,
        environmentVersion: environment,
        externalChange: true,
        verifiedEvidence: [],
      });
      throw Error('验收期间源码或环境发生变化，不能把旧通过证据用于当前版本。');
    }
    const checked = evidence.map((e) => ({
      ...e,
      sourceVersion: next.sha256,
      environmentVersion: environment,
      verifiedAt: new Date().toISOString(),
      runId: this.o.run,
    }));
    if (
      this.o.goal.evidencePolicy === 'artifact' ||
      checked.some((e) => e.kind === 'engine-job' || e.kind === 'playtest')
    )
      this.activeErrors = [];
    this.record({
      phase: 'acceptance',
      sourceVersion: next.sha256,
      environmentVersion: environment,
      activeErrors: this.activeErrors,
      ...this.collaboration(),
      verifiedEvidence: checked.map((e) => ({
        kind: e.kind,
        ref: e.ref,
        sha256: e.sha256!,
        sourceVersion: next.sha256,
        environmentVersion: environment,
      })),
    });
    return checked;
  }
  finish(current: CloudBootstrap, projectRevision = this.o.projectRevision) {
    return this.serial(() => this.finishNow(current, projectRevision));
  }
  private async finishNow(current: CloudBootstrap, projectRevision = this.o.projectRevision) {
    clearTimeout(this.timer);
    if (this.o.signal.aborted) return;
    const next = await this.source();
    const environment = goalEnvironment(current, this.o.backend, projectRevision);
    if (this.snapshot?.sha256 !== next.sha256 || this.environmentVersion !== environment) {
      this.o.workflows.invalidateEvidence(
        this.o.owner,
        this.o.session,
        '验收结束前检测到工程被外部修改，须重新核验。',
      );
      this.rebaseRequested = true;
    }
    this.snapshot = next;
    this.environmentVersion = environment;
    this.record({
      phase: 'finish',
      sourceVersion: next.sha256,
      environmentVersion: this.environmentVersion,
      activeErrors: this.activeErrors,
      ...this.collaboration(),
    });
  }
  dispose() {
    clearTimeout(this.timer);
  }
}
