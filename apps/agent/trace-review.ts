import { createHash } from 'node:crypto';
import type { Store } from '../../packages/shared/store.ts';
import type { TraceEvent, TraceHead } from '../../packages/shared/trace.ts';
import {
  traceReviewCategories,
  type TraceReview,
  type TraceFinding,
  type TraceReviewCategory,
} from '../../packages/shared/trace-review.ts';
import type { TraceService } from './trace.ts';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const aliases: Record<string, TraceReviewCategory> = {
  goal_drift: 'goal_drift',
  context_fidelity: 'context_fidelity',
  context_confusion: 'context_fidelity',
  plan_loop: 'plan_loop',
  collaboration: 'collaboration',
  concurrency: 'collaboration',
  environment_drift: 'environment_drift',
  false_completion: 'false_completion',
};
/** Deterministic review of durable observations. Missing telemetry never becomes a green check. */
export class TraceReviewService {
  constructor(
    private store: Store,
    private traces: TraceService,
  ) {}
  review(owner: string, id: string): TraceReview {
    const root = this.traces.head(owner, id);
    const all = this.store
      .list<TraceHead>('trace-head', owner)
      .filter((h) => h.projectId === root.projectId);
    const ids = new Set(
      root.goalId ? all.filter((h) => h.goalId === root.goalId).map((h) => h.id) : [id],
    );
    ids.add(id);
    for (let depth = 0; depth < 12; depth++) {
      let changed = false;
      for (const head of all)
        if (head.parentTraceId && ids.has(head.parentTraceId) && !ids.has(head.id)) {
          ids.add(head.id);
          changed = true;
        }
      if (!changed) break;
    }
    const heads = all.filter((h) => ids.has(h.id)).slice(-256);
    const report: TraceReview = {
      id: hash([owner, 'long-horizon-v1', heads.map((h) => [h.id, h.sequence, h.lastHash])]),
      rulesVersion: 'long-horizon-v1',
      createdAt: new Date().toISOString(),
      goalId: root.goalId,
      traces: heads.map((h) => ({ id: h.id, sequence: h.sequence, lastHash: h.lastHash })),
      integrity: true,
      truncated: ids.size > heads.length,
      checks: traceReviewCategories.map((c) => ({
        category: c.id,
        label: c.label,
        status: 'insufficient',
        observations: 0,
        findings: [],
      })),
      summary: '',
      limits: [
        '仅核对已记录的契约、请求、工具和验收依据；未覆盖的语义漂移不能由日志自动证明不存在。',
        '模型文字、游戏自报状态和子任务报告均不单独构成已验收事实。',
        '校验事件链和本次采信的载荷；未读取的大载荷不做完整内容审计。',
      ],
    };
    const observe = (category: TraceReviewCategory) => {
      report.checks.find((c) => c.category === category)!.observations++;
    };
    const finding = (
      category: TraceReviewCategory,
      code: string,
      message: string,
      event: TraceEvent,
      contained = false,
      severity: TraceFinding['severity'] = 'warning',
    ) => {
      const check = report.checks.find((c) => c.category === category)!;
      if (
        check.findings.some((f) => f.code === code && f.sources.some((s) => s.eventId === event.id))
      )
        return;
      check.findings.push({
        id: hash([event.id, code]),
        category,
        code,
        message: message.slice(0, 700),
        contained,
        severity,
        sources: [{ traceId: event.traceId, eventId: event.id, sequence: event.sequence }],
      });
    };
    const events: TraceEvent[] = [];
    for (const head of heads) {
      try {
        events.push(...this.traces.events(owner, head.id).events);
      } catch {
        report.integrity = false;
        report.limits.push(`轨迹 ${head.id} 完整性校验失败，不采信该轨迹。`);
      }
    }
    const order = new Map(
      (
        this.store.db
          .prepare("SELECT id FROM records WHERE kind='trace-event' AND owner=? ORDER BY rowid")
          .all(owner) as { id: string }[]
      ).map((v, i) => [v.id, i]),
    );
    events.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    let lastContract = '',
      pendingChildren = 0;
    const repeated = new Map<string, TraceEvent[]>();
    const toolArguments = new Map<string, unknown>();
    const readStreak: TraceEvent[] = [];
    for (const event of events.slice(-16000)) {
      if (
        ![
          'goal.contract',
          'context.guard',
          'context.compacted',
          'goal.checkpoint',
          'environment.checkpoint',
          'collaboration.checkpoint',
          'goal.acceptance',
          'tool.started',
          'tool.finished',
        ].includes(event.kind)
      )
        continue;
      let payload: any = {};
      if (event.payloadRef) {
        try {
          payload = this.traces.payloadValue(owner, event.traceId, event.payloadRef);
        } catch {
          report.integrity = false;
          report.limits.push(`事件 #${event.sequence} 的载荷校验失败。`);
          continue;
        }
      }
      if (event.kind === 'goal.contract') {
        observe('goal_drift');
        if (lastContract && payload.contractHash !== lastContract && !payload.userAmendment)
          finding(
            'goal_drift',
            'CONTRACT_CHANGED_WITHOUT_USER',
            '目标契约变化缺少真实用户修订来源。',
            event,
            false,
            'critical',
          );
        lastContract = payload.contractHash || lastContract;
      }
      if (event.kind === 'context.guard') {
        observe('context_fidelity');
        if (payload.anchorPresent === false)
          finding(
            'context_fidelity',
            'MISSING_GOAL_ANCHOR',
            '实际模型请求缺少当前目标契约，已阻止发送。',
            event,
            payload.blocked === true,
            'critical',
          );
      }
      if (event.kind === 'context.compacted') {
        observe('context_fidelity');
        if (payload.summaryRef && !payload.sourceRefs?.length && !payload.sourceMessageIds?.length)
          finding(
            'context_fidelity',
            'SUMMARY_PROVENANCE_MISSING',
            '历史整理缺少原消息来源，需要回读核实。',
            event,
          );
      }
      if (event.kind === 'goal.checkpoint') {
        observe('goal_drift');
        observe('plan_loop');
        if (payload.contractHash && lastContract && payload.contractHash !== lastContract)
          finding(
            'goal_drift',
            'CHECKPOINT_CONTRACT_STALE',
            '执行检查点与当前用户契约不一致。',
            event,
            payload.review?.action === 'rebase',
            'critical',
          );
        for (const item of payload.review?.findings || []) {
          const category = aliases[item.category];
          if (!category) continue;
          observe(category);
          finding(
            category,
            item.code || 'RUNTIME_GUARD',
            item.message || '运行保护需要核查',
            event,
            ['verify', 'change_strategy', 'rebase', 'blocked', 'budget_limited'].includes(
              payload.review?.action,
            ),
            item.severity === 'critical' ? 'critical' : 'warning',
          );
        }
        if (
          payload.contractHash === lastContract &&
          lastContract &&
          payload.input?.sourceVersion &&
          payload.input?.environmentVersion &&
          payload.input?.verifiedEvidence?.some(
            (v: any) =>
              ['playtest', 'engine-job'].includes(v.kind) &&
              v.ref &&
              /^[0-9a-f]{64}$/.test(v.sha256 || '') &&
              v.sourceVersion === payload.input.sourceVersion &&
              v.environmentVersion === payload.input.environmentVersion,
          ) &&
          Array.isArray(payload.input?.activeErrors) &&
          !payload.input.activeErrors.length
        ) {
          for (const check of report.checks)
            for (const f of check.findings)
              if (
                [
                  'active_runtime_errors',
                  'REPEATED_TOOL_FAILURE',
                  'repeated_failure',
                  'READ_ONLY_STALL',
                ].includes(f.code)
              ) {
                f.contained = true;
                f.sources.push({
                  traceId: event.traceId,
                  eventId: event.id,
                  sequence: event.sequence,
                });
              }
        }
      }
      if (event.kind === 'environment.checkpoint') {
        observe('environment_drift');
        if (payload.drift)
          finding(
            'environment_drift',
            'ENVIRONMENT_CHANGED',
            '检测到外部源码、模型路由或权限变化，旧证据需要重新验证。',
            event,
            payload.rebased === true || payload.blocked === true,
          );
      }
      if (event.kind === 'collaboration.checkpoint') {
        observe('collaboration');
        pendingChildren = (payload.unresolvedChildren || 0) + (payload.conflictedLeases || 0);
        if (payload.unresolvedChildren === 0 && payload.conflictedLeases === 0) {
          for (const f of report.checks.find((c) => c.category === 'collaboration')!.findings)
            if (
              ['SHARED_LEASE_CONFLICT', 'unsettled_collaboration'].includes(f.code) &&
              !f.contained
            ) {
              f.contained = true;
              f.sources.push({
                traceId: event.traceId,
                eventId: event.id,
                sequence: event.sequence,
              });
            }
        }
        if (payload.conflictedLeases)
          finding(
            'collaboration',
            'SHARED_LEASE_CONFLICT',
            '共享文件租约存在冲突。',
            event,
            payload.blocked === true,
            'critical',
          );
        if (payload.contradictedChildren)
          finding(
            'collaboration',
            'CHILD_REPORT_CONTRADICTED',
            '子任务报告与实时核验矛盾，不能采信其完成状态。',
            event,
            true,
            'critical',
          );
      }
      if (event.kind === 'goal.acceptance') {
        observe('false_completion');
        if (payload.outcome === 'rejected')
          finding(
            'false_completion',
            'ACCEPTANCE_REJECTED',
            payload.reason || '提交的完成依据不足，已阻止目标完成。',
            event,
            true,
          );
        if (payload.outcome === 'accepted') {
          if (
            !payload.verifiedEvidence?.length ||
            payload.verifiedEvidence.some(
              (e: any) =>
                !e.ref ||
                !/^[0-9a-f]{64}$/.test(e.sha256 || '') ||
                !/^[0-9a-f]{64}$/.test(e.sourceVersion || '') ||
                !/^[0-9a-f]{64}$/.test(e.environmentVersion || ''),
            )
          )
            finding(
              'false_completion',
              'UNPROVEN_COMPLETION',
              '目标被标为完成，但没有带版本哈希的实际验收证据。',
              event,
              false,
              'critical',
            );
          if (pendingChildren)
            finding(
              'collaboration',
              'COMPLETED_WITH_PENDING_CHILDREN',
              '目标完成时仍有未核验子任务或文件冲突。',
              event,
              false,
              'critical',
            );
          if (payload.contractHash && lastContract && payload.contractHash !== lastContract)
            finding(
              'false_completion',
              'COMPLETED_OLD_CONTRACT',
              '验收对应旧版目标约束。',
              event,
              false,
              'critical',
            );
        }
      }
      if (event.kind === 'tool.started')
        toolArguments.set(event.traceId + '\0' + payload.toolCallId, payload.args);
      if (event.kind === 'tool.finished') {
        const args =
            payload.args || toolArguments.get(event.traceId + '\0' + payload.toolCallId) || {},
          failed = event.status === 'failed' || payload.isError;
        const fingerprint = event.name + '\0' + hash(args);
        if (failed) {
          const list = repeated.get(fingerprint) || [];
          list.push(event);
          repeated.set(fingerprint, list);
          if (list.length === 3) {
            observe('plan_loop');
            finding(
              'plan_loop',
              'REPEATED_TOOL_FAILURE',
              '同一工具和参数至少失败三次，需要改变策略并复验。',
              event,
            );
          }
        }
        if (
          [
            'read_file',
            'list_files',
            'inspect_project',
            'read_tool_result',
            'read_skill_resource',
          ].includes(event.name)
        )
          readStreak.push(event);
        else readStreak.length = 0;
        if (root.goalId && readStreak.length === 8) {
          observe('plan_loop');
          finding(
            'plan_loop',
            'READ_ONLY_STALL',
            '连续八次读取，没有观察到修改或实际运行验证；需要确认这些读取是否仍有必要。',
            event,
          );
        }
      }
    }
    if (events.length > 16000) {
      report.truncated = true;
      report.limits.push('本次审阅仅处理最近16,000条事件。');
    }
    for (const check of report.checks) {
      check.findings = check.findings.slice(-40);
      check.status =
        !report.integrity || report.truncated
          ? 'insufficient'
          : check.findings.some((f) => !f.contained)
            ? 'attention'
            : check.findings.length
              ? 'guarded'
              : check.observations
                ? 'clear'
                : 'insufficient';
    }
    const risks = report.checks.filter((c) => c.status === 'attention').length;
    const missing = report.checks.filter((c) => c.status === 'insufficient').length;
    report.summary = `${report.traces.length}段运行，${events.length}条事件；${risks}类待处理，${missing}类证据覆盖不足。`;
    // Derived cache is keyed by every source head; it cannot silently reuse an old review.
    this.store.put('trace-review', owner, report);
    return report;
  }
}
