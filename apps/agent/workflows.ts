import { randomUUID } from 'node:crypto';
import { Type } from 'typebox';
import { z } from 'zod';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Store } from '../../packages/shared/store.ts';
import type {
  GoalAcceptanceAnchor,
  GoalCheckpoint,
  GoalCheckpointInput,
  GoalRecoveryAction,
} from '../../packages/shared/long-horizon.ts';
import { goalDigest, reviewCheckpoint, acceptsRecoveryOperation } from './long-horizon.ts';
import {
  type AgentPlan,
  type AgentGoal,
  type CapabilityRequest,
  type GoalEvidence,
  type Mode,
  type Run,
  type WorkflowView,
  type Plugin,
} from '../../packages/shared/types.ts';

const fail = (statusCode: number, message: string): never => {
  throw Object.assign(new Error(message), { statusCode });
};
type GoalContract = {
  id: string;
  goalId: string;
  sessionId: string;
  projectId: string;
  objective: string;
  evidencePolicy: AgentGoal['evidencePolicy'];
  visualMinScore: number;
  version: number;
  previousHash?: string;
  provenance: 'user-request' | 'legacy-baseline';
  createdAt: string;
  userConstraints: NonNullable<AgentGoal['userConstraints']>;
  sha256: string;
};
type GoalOutline = {
  id: string;
  goalId: string;
  objective: string;
  anchors: GoalAcceptanceAnchor[];
  provenance: 'approved-plan' | 'initial-model-plan';
  at: string;
  sha256: string;
};
const hashed = <T extends object>(value: T) => ({ ...value, sha256: goalDigest(value) });
const checkHash = (value: { sha256: string }) => {
  const { sha256, ...body } = value;
  if (sha256 !== goalDigest(body)) fail(409, '目标检查点或契约哈希不匹配，已停止使用该记录');
};
export const planInput = z
  .object({
    objective: z.string().trim().min(1).max(4000),
    contractHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    steps: z
      .array(
        z
          .object({
            id: z.string().regex(/^[\w-]{1,60}$/),
            text: z.string().trim().min(1).max(400),
            status: z.enum(['pending', 'in_progress', 'completed']),
            acceptance: z.string().trim().min(1).max(600),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict()
  .refine(
    (v) =>
      new Set(v.steps.map((s) => s.id)).size === v.steps.length &&
      v.steps.filter((s) => s.status === 'in_progress').length <= 1,
    '步骤 ID 必须唯一，同时最多一项进行中',
  );
export const goalOptions = z
  .object({
    maxRounds: z.number().int().min(1).max(100).default(12),
    maxMinutes: z.number().int().min(1).max(1440).default(60),
    evidencePolicy: z.enum(['artifact', 'runtime', 'playtest']).default('runtime'),
    visualMinScore: z.number().int().min(0).max(100).default(70),
  })
  .strict();
export class WorkflowService {
  constructor(
    private store: Store,
    private clock = Date.now,
  ) {
    store.db
      .exec(`CREATE TRIGGER IF NOT EXISTS immutable_goal_records_update BEFORE UPDATE ON records WHEN OLD.kind IN ('goal-contract','goal-outline','goal-checkpoint') BEGIN SELECT RAISE(ABORT,'immutable goal record'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_goal_records_delete BEFORE DELETE ON records WHEN OLD.kind IN ('goal-contract','goal-outline','goal-checkpoint') BEGIN SELECT RAISE(ABORT,'immutable goal record'); END;`);
    // An existing objective is durable; interrupted effects require an explicit resume.
    for (const goal of store.list<AgentGoal & { ownerId: string }>('agent-goal')) {
      try {
        const checked = this.canonical(goal.ownerId, goal);
        if (goal.status === 'active' || goal.currentRunId)
          this.save(goal.ownerId, {
            ...checked,
            activeElapsedMs: Math.max(
              checked.activeElapsedMs || 0,
              Math.min((checked.maxMinutes ?? 60) * 60000, this.elapsed(checked)),
            ),
            currentRoundStartedAt: undefined,
            status: ['active', 'waiting_permission', 'completed'].includes(goal.status)
              ? 'interrupted'
              : goal.status,
            currentRunId: undefined,
            nextRunAt: undefined,
            evidence: goal.currentRunId ? [] : checked.evidence,
            runtime:
              goal.currentRunId && checked.runtime
                ? { ...checked.runtime, action: 'rebase', verifiedEvidence: [] }
                : checked.runtime,
            reason:
              goal.status === 'paused'
                ? '保留用户暂停；本地 Agent 重启后须核对旧运行结果再恢复。'
                : '本地 Agent 重启或验收尚未收尾；先核对上次结果，再显式恢复，不重放未知副作用。',
          });
        else if (!goal.contractHash)
          store.put('agent-goal', goal.ownerId, { ...checked, ownerId: goal.ownerId });
      } catch {
        store.put('agent-goal', goal.ownerId, {
          ...goal,
          status: 'blocked',
          nextRunAt: undefined,
          currentRunId: undefined,
          reason: '目标契约校验失败，保留原记录等待核对。',
        });
      }
    }
  }
  private at() {
    return new Date(this.clock()).toISOString();
  }
  private elapsed(goal: AgentGoal) {
    return (
      (goal.activeElapsedMs || 0) +
      (goal.currentRunId && goal.currentRoundStartedAt
        ? Math.max(0, this.clock() - Date.parse(goal.currentRoundStartedAt))
        : 0)
    );
  }
  private overBudget(goal: AgentGoal, begin = false) {
    return (
      this.elapsed(goal) >= (goal.maxMinutes ?? 60) * 60000 ||
      ((begin || !goal.currentRunId) && goal.rounds >= goal.maxRounds)
    );
  }
  private canonical(
    owner: string,
    goal: AgentGoal,
    provenance: GoalContract['provenance'] = 'legacy-baseline',
  ): AgentGoal {
    const version = goal.contractVersion || 1;
    const contracts = this.store
      .list<GoalContract>('goal-contract', owner)
      .filter((value) => value.goalId === goal.id)
      .sort((a, b) => a.version - b.version);
    if (contracts.length && contracts.at(-1)!.version !== version)
      fail(409, '目标缓存不是最新用户契约，不能回滚已追加的约束');
    for (let i = 0; i < contracts.length; i++) {
      checkHash(contracts[i]);
      if (contracts[i].version !== i + 1 || contracts[i].previousHash !== contracts[i - 1]?.sha256)
        fail(409, '不可变目标契约链不完整，不能继续执行或验收');
    }
    let contract = this.store.get<GoalContract>('goal-contract', `${goal.id}:v${version}`, owner);
    if (!contract) {
      if (goal.contractHash) fail(409, '不可变目标契约缺失，不能从可变缓存重新生成');
      contract = hashed({
        id: `${goal.id}:v${version}`,
        goalId: goal.id,
        sessionId: goal.sessionId,
        projectId: goal.projectId,
        objective: goal.objective,
        evidencePolicy: goal.evidencePolicy,
        visualMinScore: goal.visualMinScore ?? 70,
        version,
        provenance,
        createdAt: this.at(),
        userConstraints: goal.userConstraints || [],
      });
      this.store.put('goal-contract', owner, contract);
    }
    checkHash(contract);
    if (
      contract.goalId !== goal.id ||
      contract.sessionId !== goal.sessionId ||
      contract.projectId !== goal.projectId ||
      contract.objective !== goal.objective ||
      contract.evidencePolicy !== goal.evidencePolicy ||
      contract.visualMinScore !== (goal.visualMinScore ?? 70) ||
      (goal.contractHash && goal.contractHash !== contract.sha256) ||
      goalDigest(goal.userConstraints || []) !== goalDigest(contract.userConstraints)
    )
      fail(409, '目标或约束偏离不可变用户契约；不能继续执行或验收');
    const outline = this.store.get<GoalOutline>('goal-outline', goal.id, owner);
    if (outline) {
      checkHash(outline);
      if (outline.goalId !== goal.id || (goal.outlineHash && goal.outlineHash !== outline.sha256))
        fail(409, '全局验收大纲已变化，不能静默替换');
    }
    return {
      ...goal,
      contractHash: contract.sha256,
      contractVersion: contract.version,
      contractProvenance: contract.provenance,
      userConstraints: contract.userConstraints,
      maxMinutes: goal.maxMinutes ?? 60,
      activeElapsedMs: goal.activeElapsedMs || 0,
      ...(outline ? { outlineHash: outline.sha256, acceptanceAnchors: outline.anchors } : {}),
    };
  }
  private save(owner: string, goal: AgentGoal): AgentGoal {
    const checked = this.canonical(owner, goal);
    return this.store.put('agent-goal', owner, {
      ...checked,
      ownerId: owner,
      revision: goal.revision + 1,
      updatedAt: this.at(),
    });
  }
  goal(owner: string, session: string) {
    return this.store.list<AgentGoal>('agent-goal', owner).findLast((g) => g.sessionId === session);
  }
  /** A user message may append constraints; a model tool cannot call this method. */
  amend(owner: string, session: string, text: string, sourceMessageId?: string) {
    const original = this.goal(owner, session) || fail(404, '目标不存在');
    const g = this.canonical(owner, original);
    if (g.status === 'completed') fail(409, '已完成目标不能追加约束，请明确创建新目标');
    const constraint = z.string().trim().min(1).max(6000).parse(text);
    if (/^(?:继续|继续当前目标|continue|resume)[。.!！\s]*$/i.test(constraint)) return g;
    if ((g.userConstraints?.length || 0) >= 32)
      fail(409, '追加约束较多，请明确整理并创建新目标；原文未被截断');
    const prior =
      sourceMessageId && g.userConstraints?.find((v) => v.sourceMessageId === sourceMessageId);
    if (prior) {
      if (prior.text !== constraint) fail(409, '同一用户消息ID的约束内容已变化，不能静默覆盖原文');
      return g;
    }
    const version = (g.contractVersion || 1) + 1;
    const previous = this.store.get<GoalContract>(
      'goal-contract',
      `${g.id}:v${g.contractVersion}`,
      owner,
    )!;
    const userConstraints = [
      ...(g.userConstraints || []),
      { text: constraint, at: this.at(), ...(sourceMessageId ? { sourceMessageId } : {}) },
    ];
    const contract = hashed({
      id: `${g.id}:v${version}`,
      goalId: g.id,
      sessionId: g.sessionId,
      projectId: g.projectId,
      objective: g.objective,
      evidencePolicy: g.evidencePolicy,
      visualMinScore: g.visualMinScore ?? 70,
      version,
      previousHash: previous.sha256,
      provenance: previous.provenance,
      createdAt: this.at(),
      userConstraints,
    });
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.store.put('goal-contract', owner, contract);
      const updated = this.save(owner, {
        ...g,
        contractHash: contract.sha256,
        contractVersion: version,
        userConstraints,
        evidence: [],
        runtime: g.runtime
          ? {
              ...g.runtime,
              action: 'rebase',
              verifiedEvidence: [],
              findings: [
                {
                  category: 'goal_drift',
                  code: 'user_constraint_appended',
                  severity: 'info',
                  message: '真实用户消息追加了约束；旧版验收结果不自动适用于当前契约。',
                  refs: [sourceMessageId || contract.id],
                },
              ],
            }
          : undefined,
        reason: '用户已追加约束，下一步需按当前契约重新检查计划与验收。',
      });
      this.store.db.exec('COMMIT');
      return updated;
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
  }
  runtimePolicy(owner: string, session: string) {
    const raw = this.goal(owner, session);
    if (!raw) return undefined;
    const g = this.canonical(owner, raw),
      plan = this.store.get<AgentPlan>('agent-plan', session, owner);
    const contract = this.store.get<GoalContract>(
      'goal-contract',
      `${g.id}:v${g.contractVersion}`,
      owner,
    )!;
    const observed = this.checkpoints(owner, session, 1)[0];
    return {
      goalId: g.id,
      objective: g.objective,
      contractHash: g.contractHash!,
      contractVersion: g.contractVersion!,
      contractProvenance: g.contractProvenance,
      userConstraints: g.userConstraints || [],
      acceptanceAnchors: g.acceptanceAnchors || [],
      contractUpdatedAt: contract.createdAt,
      round: g.rounds,
      maxRounds: g.maxRounds,
      maxMinutes: g.maxMinutes!,
      remainingMinutes: Math.max(0, Math.ceil((g.maxMinutes! * 60000 - this.elapsed(g)) / 60000)),
      window: Math.floor(Math.max(0, g.rounds - 1) / 4) + 1,
      needsPlanRefresh:
        g.rounds > 4 &&
        (!plan ||
          plan.window !== Math.floor(Math.max(0, g.rounds - 1) / 4) + 1 ||
          plan.contractHash !== g.contractHash),
      currentPlanRevision: plan?.revision || 0,
      action: g.runtime?.action || 'continue',
      sourceVersion: g.runtime?.sourceVersion,
      environmentVersion: g.runtime?.environmentVersion,
      findings: g.runtime?.findings || [],
      activeErrors:
        observed?.contractHash === g.contractHash
          ? observed.runtime.activeErrors
          : g.runtime?.activeErrors || [],
      validationDebt: g.runtime?.validationDebt || 0,
      instruction:
        '用户原目标与追加约束是授权来源；较新用户约束可明确修订较早要求，模型计划与历史摘要不能替换它们。保留全局验收大纲，每3–4轮更新当前窗口的具体步骤。工具次数或文字汇报不代表已验证进展。',
    };
  }
  guard(owner: string, id: string, operation?: { name: string; argsSha256: string }) {
    const raw = this.store.get<AgentGoal>('agent-goal', id, owner) || fail(404, '目标不存在');
    const g = this.canonical(owner, raw);
    if (g.status !== 'active')
      return {
        allowed: false,
        action: (g.status === 'blocked'
          ? 'blocked'
          : g.status === 'budget_limited'
            ? 'budget_limited'
            : 'continue') as GoalRecoveryAction,
        reason: g.reason || '目标当前未运行',
      };
    if (this.overBudget(g)) {
      if (g.status === 'active')
        this.save(owner, {
          ...g,
          status: 'budget_limited',
          nextRunAt: undefined,
          reason: '目标轮次或主动执行时间预算已用尽，未标记完成。',
        });
      return {
        allowed: false,
        action: 'budget_limited' as GoalRecoveryAction,
        reason: '目标预算已到，须由用户明确增加预算。',
      };
    }
    const action = g.runtime?.action || 'continue';
    const plan = this.store.get<AgentPlan>('agent-plan', g.sessionId, owner);
    const window = Math.floor(Math.max(0, g.rounds - 1) / 4) + 1;
    if (
      g.rounds > 4 &&
      operation &&
      (!plan || plan.window !== window || plan.contractHash !== g.contractHash) &&
      !acceptsRecoveryOperation('rebase', operation.name)
    )
      return {
        allowed: false,
        action: 'change_strategy' as GoalRecoveryAction,
        reason: '当前4轮计划窗口已结束；请保留全局验收大纲，先update_plan更新本窗口的具体步骤。',
      };
    if (operation && !acceptsRecoveryOperation(action, operation.name))
      return {
        allowed: false,
        action,
        reason: '环境已变化，先重新读取真实状态并更新当前计划，不直接继续旧操作。',
      };
    const currentSignature = operation
      ? goalDigest({
          name: operation.name,
          args: operation.argsSha256,
          source: g.runtime?.sourceVersion,
        })
      : undefined;
    if (
      operation &&
      action === 'change_strategy' &&
      currentSignature === g.runtime?.operationSignature &&
      (g.runtime?.repeatedOperation || 0) >= 3
    )
      return {
        allowed: false,
        action,
        reason: '同一版本的相同操作没有新证据，请改用精确检查或新的验证策略。',
      };
    return {
      allowed: action !== 'blocked',
      action,
      ...(action === 'blocked' ? { reason: g.reason || '循环已停止，需明确调整后恢复' } : {}),
    };
  }
  checkpoint(owner: string, id: string, runId: string, input: GoalCheckpointInput) {
    const raw = this.store.get<AgentGoal>('agent-goal', id, owner) || fail(404, '目标不存在');
    const g = this.canonical(owner, raw);
    if (g.currentRunId !== runId) fail(409, '检查点不属于本目标当前运行');
    for (const digest of [
      input.sourceVersion,
      input.environmentVersion,
      input.operation?.argsSha256,
      input.operation?.resultSha256,
    ])
      if (digest !== undefined && !/^[a-f0-9]{64}$/.test(digest))
        fail(400, '运行版本必须是实际SHA-256指纹');
    if ((input.verifiedEvidence?.length || 0) > 16 || (input.activeErrors?.length || 0) > 8)
      fail(400, '检查点观测数量超限');
    for (const evidence of input.verifiedEvidence || [])
      if (!evidence.ref || !/^[a-f0-9]{64}$/.test(evidence.sha256))
        fail(400, '已核验观测缺少内容哈希');
    const checkpointId = randomUUID(),
      at = this.at(),
      plan = this.store.get<AgentPlan>('agent-plan', g.sessionId, owner);
    const runtime = reviewCheckpoint(g.runtime, input, {
      checkpointId,
      at,
      planRevision: plan?.revision || 0,
      evidencePolicy: g.evidencePolicy,
    });
    if (g.status === 'active' && this.overBudget(g)) runtime.action = 'budget_limited';
    const checkpoint: GoalCheckpoint = hashed({
      id: checkpointId,
      goalId: g.id,
      sessionId: g.sessionId,
      projectId: g.projectId,
      runId,
      sequence: (g.checkpointCount || 0) + 1,
      at,
      contractHash: g.contractHash!,
      input,
      runtime,
    });
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.store.put('goal-checkpoint', owner, checkpoint);
      const action = runtime.action;
      const goal = this.save(owner, {
        ...g,
        runtime,
        checkpointCount: checkpoint.sequence,
        ...(g.status === 'active' && (action === 'blocked' || action === 'budget_limited')
          ? {
              status: action,
              nextRunAt: undefined,
              reason:
                runtime.findings.findLast((v) => v.severity === 'error')?.message ||
                '已到达目标执行预算。',
            }
          : {}),
      });
      this.store.db.exec('COMMIT');
      return { goal, checkpoint, review: { action, findings: runtime.findings } };
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
  }
  checkpoints(owner: string, session: string, limit = 20) {
    const g = this.goal(owner, session) || fail(404, '目标不存在');
    return (
      this.store.db
        .prepare(
          "SELECT data FROM records WHERE kind='goal-checkpoint' AND owner=? AND json_extract(data,'$.goalId')=? ORDER BY rowid DESC LIMIT ?",
        )
        .all(owner, g.id, Math.min(100, Math.max(1, limit))) as { data: string }[]
    ).map((row) => {
      const value = JSON.parse(row.data) as GoalCheckpoint;
      checkHash(value);
      return value;
    });
  }
  view(owner: string, session: string): WorkflowView {
    const goal = this.goal(owner, session);
    return {
      plan: this.store.get<AgentPlan>('agent-plan', session, owner),
      goal,
      requests: this.store
        .list<CapabilityRequest>('capability-request', owner)
        .filter((v) => v.sessionId === session && v.state === 'pending'),
    };
  }
  plan(owner: string, session: string, project: string, raw: unknown, planning = false) {
    const input = planInput.parse(raw);
    if (planning && input.steps.some((v) => v.status === 'completed'))
      fail(400, 'Plan 模式不能将尚未执行的步骤标为已完成');
    const previous = this.store.get<AgentPlan>('agent-plan', session, owner);
    const currentGoal = this.goal(owner, session);
    const goal = currentGoal?.status === 'active' ? this.canonical(owner, currentGoal) : undefined;
    if (goal && goal.projectId !== project) fail(409, '计划不属于当前目标工程');
    const oldOutline = goal
      ? this.store.get<GoalOutline>('goal-outline', goal.id, owner)
      : undefined;
    if (goal && input.objective !== goal.objective && input.objective !== oldOutline?.objective)
      fail(409, '模型计划不能改写用户原始目标；请保持当前目标或已批准大纲的objective');
    if (
      goal &&
      ((input.contractHash && input.contractHash !== goal.contractHash) ||
        ((goal.contractVersion || 1) > 1 && input.contractHash !== goal.contractHash))
    )
      fail(409, '用户约束版本已更新，请读取当前contractHash后重新规划');
    if (goal && !oldOutline) {
      const approved = previous?.approvedAt ? previous : undefined;
      const outline = hashed({
        id: goal.id,
        goalId: goal.id,
        objective: approved?.objective || input.objective,
        anchors: (approved?.steps || input.steps).map(({ id, text, acceptance }) => ({
          id,
          text,
          acceptance,
        })),
        provenance: approved ? ('approved-plan' as const) : ('initial-model-plan' as const),
        at: this.at(),
      });
      this.store.put('goal-outline', owner, outline);
    }
    const sameDefinition =
      previous &&
      previous.objective === input.objective &&
      goalDigest(previous.steps.map(({ id, text, acceptance }) => ({ id, text, acceptance }))) ===
        goalDigest(input.steps.map(({ id, text, acceptance }) => ({ id, text, acceptance })));
    const saved = this.store.put('agent-plan', owner, {
      id: session,
      sessionId: session,
      projectId: project,
      ...input,
      revision: (previous?.revision || 0) + 1,
      updatedAt: this.at(),
      approvedAt: planning || !sameDefinition ? undefined : previous?.approvedAt,
      ...(goal
        ? {
            goalId: goal.id,
            contractHash: goal.contractHash,
            window: Math.floor(Math.max(0, goal.rounds - 1) / 4) + 1,
            acceptanceAnchors:
              this.store.get<GoalOutline>('goal-outline', goal.id, owner)?.anchors || [],
          }
        : {}),
    } satisfies AgentPlan);
    if (goal?.runtime && ['rebase', 'change_strategy'].includes(goal.runtime.action))
      this.save(owner, {
        ...goal,
        runtime: {
          ...goal.runtime,
          action: 'verify',
          strategyRevision: saved.revision,
          repeatedOperation: 0,
        },
      });
    return saved;
  }
  approvePlan(owner: string, session: string, revision: number) {
    const plan = this.store.get<AgentPlan>('agent-plan', session, owner) || fail(404, '计划不存在');
    if (plan.revision !== revision) fail(409, '计划已更新，请查看最新计划');
    return this.store.put('agent-plan', owner, {
      ...plan,
      approvedAt: this.at(),
      revision: plan.revision + 1,
    });
  }
  create(
    owner: string,
    session: string,
    project: string,
    objective: string,
    provider: Mode,
    raw: unknown,
  ) {
    const existing = this.goal(owner, session);
    if (existing && !['completed', 'blocked', 'budget_limited'].includes(existing.status))
      fail(409, '会话已有目标，请继续、暂停或恢复当前目标');
    if (
      existing &&
      existing.status !== 'completed' &&
      (objective.trim() === existing.objective ||
        /^(?:继续|继续当前目标|continue|resume)[。.!！\s]*$/i.test(objective.trim()))
    )
      fail(409, '当前目标尚未完成；请明确恢复或增加已有预算，不能创建新目标重置已消耗预算');
    const value = this.canonical(
      owner,
      {
        id: randomUUID(),
        sessionId: session,
        projectId: project,
        objective: z.string().trim().min(1).max(4000).parse(objective),
        provider,
        ...goalOptions.parse(raw),
        status: 'active',
        rounds: 0,
        noProgressRounds: 0,
        revision: 0,
        activeElapsedMs: 0,
        createdAt: this.at(),
        updatedAt: this.at(),
        evidence: [],
      },
      'user-request',
    );
    const plan = this.store.get<AgentPlan>('agent-plan', session, owner);
    if (plan?.approvedAt)
      this.store.put(
        'goal-outline',
        owner,
        hashed({
          id: value.id,
          goalId: value.id,
          objective: plan.objective,
          anchors: plan.steps.map(({ id, text, acceptance }) => ({ id, text, acceptance })),
          provenance: 'approved-plan' as const,
          at: this.at(),
        }),
      );
    return this.save(owner, value);
  }
  begin(owner: string, id: string, runId: string) {
    const g = this.canonical(
      owner,
      this.store.get<AgentGoal>('agent-goal', id, owner) || fail(404, '目标不存在'),
    );
    if (g.status !== 'active' || g.currentRunId) fail(409, '目标当前不能开始下一轮');
    if (this.overBudget(g, true)) {
      this.save(owner, {
        ...g,
        status: 'budget_limited',
        nextRunAt: undefined,
        reason: '目标预算已到，不能再开始新的运行。',
      });
      fail(409, '目标轮次或时间预算已到，请由用户明确增加预算');
    }
    return this.save(owner, {
      ...g,
      rounds: g.rounds + 1,
      currentRunId: runId,
      currentRoundStartedAt: this.at(),
      roundStartedProgressId: g.runtime?.lastProgressCheckpointId,
      nextRunAt: undefined,
      reason: undefined,
    });
  }
  finishRun(owner: string, run: Run) {
    if (!run.goalId) return;
    const current = this.store.get<AgentGoal>('agent-goal', run.goalId, owner);
    if (!current || current.currentRunId !== run.id) return;
    const g = this.canonical(owner, current);
    const next = {
      ...g,
      activeElapsedMs: this.elapsed(g),
      currentRoundStartedAt: undefined,
      currentRunId: undefined,
      lastRunId: run.id,
      nextRunAt: undefined,
    };
    if (g.status !== 'active') return this.save(owner, next);
    if (run.status !== 'completed')
      return this.save(owner, {
        ...next,
        status: run.status === 'cancelled' ? 'paused' : 'interrupted',
        reason: run.error || '本轮中断；核对归档后手动恢复，不自动重放副作用。',
      });
    if (this.overBudget(next))
      return this.save(owner, {
        ...next,
        status: 'budget_limited',
        reason: '已到达目标轮数或主动执行时间预算；未将其标为完成。',
      });
    // Legacy/no-checkpoint runs retain the old bounded behavior. New runtime
    // checkpoints use actual source/evidence progress instead of tool count.
    next.noProgressRounds = g.runtime
      ? g.runtime.lastProgressCheckpointId &&
        g.runtime.lastProgressCheckpointId !== g.roundStartedProgressId
        ? 0
        : g.noProgressRounds + 1
      : run.toolCount
        ? 0
        : g.noProgressRounds + 1;
    if (next.noProgressRounds >= 2)
      return this.save(owner, {
        ...next,
        status: 'blocked',
        reason: '连续两轮没有工具证据，目标等待补充信息或调整路径。',
      });
    return this.save(owner, { ...next, nextRunAt: new Date(this.clock() + 1000).toISOString() });
  }
  control(owner: string, session: string, action: 'pause' | 'resume', revision: number) {
    const g = this.canonical(owner, this.goal(owner, session) || fail(404, '目标不存在'));
    if (g.revision !== revision) fail(409, '目标状态已变化，请刷新后操作');
    if (g.status === 'completed') fail(409, '目标已完成，不能重新激活');
    if (action === 'resume') {
      if (g.status === 'completed' || g.currentRunId) fail(409, '目标已完成或上一轮尚未停止');
      if (this.overBudget(g, true)) fail(409, '已到达轮数或时间预算，请明确增加预算后继续');
      const waiting = this.view(owner, session).requests.length > 0;
      return this.save(owner, {
        ...g,
        status: waiting ? 'waiting_permission' : 'active',
        nextRunAt: waiting ? undefined : this.at(),
        reason: waiting ? '等待用户启用所需能力。' : undefined,
        runtime: g.runtime
          ? {
              ...g.runtime,
              action: 'rebase',
              repeatedOperation: 0,
              repeatedFailure: 0,
              noProgressCheckpoints: 0,
              cycle: [],
              verifiedEvidence: [],
            }
          : undefined,
      });
    }
    return this.save(owner, {
      ...g,
      status: 'paused',
      nextRunAt: undefined,
      reason: '用户暂停目标。',
    });
  }
  waitForMedia(owner: string, session: string, uncertain: boolean) {
    const g = this.goal(owner, session) || fail(404, '目标不存在');
    if (g.status !== 'active' || g.currentRunId) return g;
    return this.save(owner, {
      ...g,
      status: uncertain ? 'interrupted' : 'active',
      nextRunAt: uncertain ? undefined : new Date(this.clock() + 15000).toISOString(),
      reason: uncertain
        ? '生成任务结果待核对；先核对已有任务，再恢复目标，不自动重新收费。'
        : '等待当前媒体任务完成，暂不消耗新的模型轮数。',
    });
  }
  extendBudget(
    owner: string,
    session: string,
    revision: number,
    maxRounds: number,
    maxMinutes?: number,
  ) {
    const g = this.canonical(owner, this.goal(owner, session) || fail(404, '目标不存在'));
    if (g.revision !== revision || g.currentRunId || g.status === 'completed')
      fail(409, '目标状态已变化或仍在运行');
    const minutes = maxMinutes ?? g.maxMinutes ?? 60;
    if (
      !Number.isInteger(maxRounds) ||
      maxRounds < g.maxRounds ||
      maxRounds > 100 ||
      !Number.isInteger(minutes) ||
      minutes < (g.maxMinutes ?? 60) ||
      minutes > 1440 ||
      (maxRounds === g.maxRounds && minutes === (g.maxMinutes ?? 60))
    )
      fail(400, '预算必须明确增加，最多100轮、1440分钟；不能自动降低或重置已消耗预算');
    const waiting = this.view(owner, session).requests.length > 0;
    return this.save(owner, {
      ...g,
      maxRounds,
      maxMinutes: minutes,
      status: waiting
        ? 'waiting_permission'
        : g.runtime?.action === 'blocked'
          ? 'blocked'
          : 'active',
      nextRunAt: waiting || g.runtime?.action === 'blocked' ? undefined : this.at(),
      runtime:
        g.runtime?.action === 'budget_limited' ? { ...g.runtime, action: 'rebase' } : g.runtime,
      reason: waiting
        ? '预算已增加，等待用户启用所需能力。'
        : g.runtime?.action === 'blocked'
          ? '预算已增加；无效循环仍需明确调整后恢复。'
          : undefined,
    });
  }
  complete(
    owner: string,
    session: string,
    evidence: GoalEvidence[],
    expectedContractHash?: string,
  ) {
    const g = this.canonical(owner, this.goal(owner, session) || fail(404, '目标不存在'));
    if (g.status !== 'active') fail(409, '目标当前不能完成');
    if (
      (expectedContractHash && expectedContractHash !== g.contractHash) ||
      ((g.contractVersion || 1) > 1 && expectedContractHash !== g.contractHash)
    )
      fail(409, '验收期间用户契约已变化，旧验收不可自动沿用');
    if (this.overBudget(g)) fail(409, '目标执行预算已到；预算耗尽不是完成');
    if (evidence.some((v) => !v.sha256 || !/^[a-f0-9]{64}$/.test(v.sha256)))
      fail(409, '验收证据缺少实际内容哈希，不能由文字汇报代替');
    const latestCheckpoint = this.checkpoints(owner, session, 1)[0];
    if (
      latestCheckpoint &&
      (!g.runtime ||
        latestCheckpoint.id !== g.runtime.checkpointId ||
        latestCheckpoint.contractHash !== g.contractHash)
    )
      fail(409, '当前契约缺少对应的真实验证器检查点，旧缓存不能代替验收');
    if (g.runtime) {
      if (['rebase', 'blocked', 'budget_limited'].includes(g.runtime.action))
        fail(409, '当前需要重新核对环境或调整执行路径，尚不能完成');
      if (
        g.runtime.activeErrors.length ||
        g.runtime.unresolvedChildren ||
        g.runtime.conflictedLeases ||
        latestCheckpoint?.runtime.activeErrors.length ||
        latestCheckpoint?.runtime.unresolvedChildren ||
        latestCheckpoint?.runtime.conflictedLeases
      )
        fail(409, '仍有实际错误、未核验子任务或共享资源冲突，目标未完成');
      for (const item of evidence) {
        if (
          (g.runtime.sourceVersion && item.sourceVersion !== g.runtime.sourceVersion) ||
          (g.runtime.environmentVersion && item.environmentVersion !== g.runtime.environmentVersion)
        )
          fail(409, '验收证据不属于当前源码和执行环境');
        if (
          !g.runtime.verifiedEvidence.some(
            (v) => v.kind === item.kind && v.ref === item.ref && v.sha256 === item.sha256,
          ) ||
          (latestCheckpoint &&
            !latestCheckpoint.runtime.verifiedEvidence.some(
              (v) => v.kind === item.kind && v.ref === item.ref && v.sha256 === item.sha256,
            ))
        )
          fail(409, '该证据尚未经过当前运行的真实验证器检查');
      }
    }
    if (
      !evidence.length ||
      (g.evidencePolicy === 'runtime' &&
        !evidence.some((v) => v.kind === 'engine-job' || v.kind === 'playtest')) ||
      (g.evidencePolicy === 'playtest' && !evidence.some((v) => v.kind === 'playtest'))
    )
      fail(409, '尚未取得目标要求的实际验收证据');
    return this.save(owner, {
      ...g,
      status: 'completed',
      nextRunAt: undefined,
      evidence,
      completion: {
        at: this.at(),
        contractHash: g.contractHash!,
        sourceVersion: g.runtime?.sourceVersion,
        environmentVersion: g.runtime?.environmentVersion,
      },
      reason: '已核对实际产物与验收证据。',
    });
  }
  /** Only a trusted final readback may revoke a still-settling completion. */
  invalidateEvidence(owner: string, session: string, reason: string) {
    const g = this.canonical(owner, this.goal(owner, session) || fail(404, '目标不存在'));
    if (g.status === 'completed' && !g.currentRunId) return g;
    const why = z.string().trim().min(1).max(1000).parse(reason);
    return this.save(owner, {
      ...g,
      status: g.status === 'completed' ? 'active' : g.status,
      evidence: [],
      nextRunAt: undefined,
      reason: why,
      invalidation: {
        at: this.at(),
        reason: why,
        previousContractHash: g.completion?.contractHash,
      },
      runtime: g.runtime
        ? {
            ...g.runtime,
            action: 'rebase',
            verifiedEvidence: [],
            findings: [
              {
                category: 'false_completion',
                code: 'completion_invalidated',
                severity: 'error',
                message: why,
                refs: [g.runtime.checkpointId],
              },
            ],
          }
        : undefined,
    });
  }
  request(owner: string, session: string, project: string, pluginId: string, reason: string) {
    const existing = this.view(owner, session).requests.find((v) => v.pluginId === pluginId);
    const request =
      existing ||
      this.store.put('capability-request', owner, {
        id: randomUUID(),
        sessionId: session,
        projectId: project,
        pluginId,
        reason,
        state: 'pending',
        createdAt: this.at(),
      } satisfies CapabilityRequest);
    const g = this.goal(owner, session);
    if (g?.status === 'active')
      this.save(owner, {
        ...g,
        status: 'waiting_permission',
        nextRunAt: undefined,
        reason: '等待用户在界面启用所需能力。',
      });
    return request;
  }
  resolve(owner: string, session: string, id: string, approved: boolean) {
    const r =
      this.store.get<CapabilityRequest>('capability-request', id, owner) ||
      fail(404, '能力请求不存在');
    if (r.sessionId !== session || r.state !== 'pending')
      fail(409, '能力请求已处理或不属于当前会话');
    this.store.put('capability-request', owner, {
      ...r,
      state: approved ? 'resolved' : 'declined',
    });
    // Approval is explicit user intent; a still-running turn settles before dispatch.
    const g = this.goal(owner, session);
    if (!approved && g?.status === 'waiting_permission')
      this.save(owner, {
        ...g,
        status: 'paused',
        nextRunAt: undefined,
        reason: '所需能力暂未启用，目标已暂停；可调整范围后恢复。',
      });
    if (
      approved &&
      g?.status === 'waiting_permission' &&
      !this.view(owner, session).requests.length
    )
      this.save(owner, {
        ...g,
        status: this.overBudget(g, true) ? 'budget_limited' : 'active',
        nextRunAt: this.overBudget(g, true) ? undefined : this.at(),
        reason: this.overBudget(g, true)
          ? '能力已启用；当前执行预算已到，请明确增加预算。'
          : undefined,
      });
    return this.view(owner, session);
  }
  due(): (AgentGoal & { ownerId: string })[] {
    return this.store
      .list<AgentGoal & { ownerId: string }>('agent-goal')
      .filter(
        (g) => g.status === 'active' && !g.currentRunId && g.nextRunAt && g.nextRunAt <= this.at(),
      );
  }
}
export function workflowTools(
  service: WorkflowService,
  owner: string,
  session: string,
  project: string,
  planning: boolean,
  plugins: Plugin[],
  verify: (evidence: { kind: string; ref: string }[]) => Promise<GoalEvidence[]>,
): AgentTool[] {
  const result = (value: unknown, failed = false) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    details: failed ? { failed: true } : {},
  });
  const safely =
    (fn: (...args: any[]) => Promise<unknown> | unknown): AgentTool['execute'] =>
    async (_, args, signal) => {
      try {
        signal?.throwIfAborted();
        return result(await fn(args));
      } catch (e) {
        return result({ error: e instanceof Error ? e.message : '工作流操作失败' }, true);
      }
    };
  const tools: AgentTool[] = [
    {
      name: 'update_plan',
      label: '更新实施计划',
      executionMode: 'sequential',
      description:
        '保存当前会话的实施步骤和逐步验收条件。Goal模式不能改写用户目标；每3–4轮滚动当前具体步骤，既有全局验收大纲保留。用户追加约束后须传当前contractHash。一次最多12项，同时最多一项进行中。Plan模式不可伪称步骤已执行。',
      parameters: Type.Object({
        objective: Type.String({ maxLength: 4000 }),
        contractHash: Type.Optional(Type.String({ maxLength: 64 })),
        steps: Type.Array(
          Type.Object({
            id: Type.String(),
            text: Type.String(),
            status: Type.Union([
              Type.Literal('pending'),
              Type.Literal('in_progress'),
              Type.Literal('completed'),
            ]),
            acceptance: Type.String(),
          }),
          { minItems: 1, maxItems: 12 },
        ),
      }),
      execute: safely((args) => service.plan(owner, session, project, args, planning)),
    },
    {
      name: 'discover_capabilities',
      label: '发现可用能力',
      description:
        '查看本轮可用或缺少的插件能力。用户无需知道工具名；已停用能力不能自动打开，缺少时可request_capability请求界面启用。',
      parameters: Type.Object({}),
      execute: safely(() => ({
        plugins: plugins.map(({ id, name, description, tools, installed, enabled, available }) => ({
          id,
          name,
          description,
          tools,
          installed,
          enabled,
          available,
        })),
      })),
    },
    {
      name: 'request_capability',
      label: '请求启用所需能力',
      executionMode: 'sequential',
      description:
        '为用户目标请求启用一个已知插件，在界面展示按钮。仅创建请求，不授予权限或执行工具；不能要求用户在提示词里列工具名。',
      parameters: Type.Object({ pluginId: Type.String(), reason: Type.String({ maxLength: 400 }) }),
      execute: safely((raw) => {
        const args = z
          .object({ pluginId: z.string(), reason: z.string().min(1).max(400) })
          .strict()
          .parse(raw);
        const plugin = plugins.find((p) => p.id === args.pluginId) || fail(400, '未知插件');
        if (plugin.available === false) fail(403, '该能力已被管理员下架');
        return plugin.installed && plugin.enabled
          ? {
              enabled: true,
              pluginId: plugin.id,
              note: '如仍不可用，请在运行与验证中检查项目/引擎授权。',
            }
          : service.request(owner, session, project, plugin.id, args.reason);
      }),
    },
  ];
  if (!planning && service.goal(owner, session)?.status === 'active')
    tools.push({
      name: 'complete_goal',
      label: '核对目标完成证据',
      executionMode: 'sequential',
      description:
        '只有实际产物或运行/试玩证据满足目标验收方式时才可完成目标。ref为当前项目内文件路径、已完成media-job素材任务ID、实际引擎任务或试玩ID；服务端重新核查归属与当前哈希，不能用最终回复、子任务汇报或自报成功代替。',
      parameters: Type.Object({
        contractHash: Type.Optional(Type.String({ maxLength: 64 })),
        evidence: Type.Array(
          Type.Object({
            kind: Type.Union([
              Type.Literal('file'),
              Type.Literal('engine-job'),
              Type.Literal('playtest'),
              Type.Literal('media-job'),
              Type.Literal('visual-assessment'),
            ]),
            ref: Type.String({ maxLength: 400 }),
          }),
          { minItems: 1, maxItems: 8 },
        ),
      }),
      execute: safely(async (raw) => {
        const args = z
          .object({
            contractHash: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional(),
            evidence: z
              .array(
                z
                  .object({
                    kind: z.enum([
                      'file',
                      'engine-job',
                      'playtest',
                      'media-job',
                      'visual-assessment',
                    ]),
                    ref: z.string().min(1).max(400),
                  })
                  .strict(),
              )
              .min(1)
              .max(8),
          })
          .strict()
          .parse(raw);
        const goal = service.goal(owner, session) || fail(409, '目标不存在');
        const expectedHash = goal.contractHash;
        if (
          (args.contractHash && args.contractHash !== expectedHash) ||
          ((goal.contractVersion || 1) > 1 && args.contractHash !== expectedHash)
        )
          fail(409, '请按当前用户约束重新核对，并提交最新contractHash');
        return service.complete(owner, session, await verify(args.evidence), expectedHash);
      }),
    });
  return tools.filter(
    (tool) =>
      tool.name !== 'complete_goal' ||
      (!planning && service.goal(owner, session)?.status === 'active'),
  );
}
