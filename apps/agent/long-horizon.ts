import { createHash } from 'node:crypto';
import type {
  GoalCheckpointInput,
  GoalRecoveryAction,
  GoalRiskFinding,
  GoalRuntimeState,
} from '../../packages/shared/long-horizon.ts';

export const goalDigest = (value: unknown) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
const mutations = new Set([
  'write_file',
  'edit_file',
  'import_generated_asset',
  'prepare_game_asset',
  'apply_subagent_changes',
  'rollback_shared_changes',
]);
const investigations = new Set([
  'update_plan',
  'list_files',
  'read_file',
  'inspect_project',
  'read_tool_result',
  'read_session_history',
  'read_skill_resource',
  'discover_capabilities',
  'request_capability',
  'load_capabilities',
  'list_references',
  'inspect_playtest_capture',
  'inspect_ground_truth',
  'capture_ground_truth',
  'cancel_subagent',
  'rollback_shared_changes',
  'read_engine_log',
  'read_playtest_log',
  'get_media_job',
  'get_perception_result',
  'get_subagent_result',
  'inspect_subagent',
  'inspect_shared_state',
]);
export function normalizedFailure(value: string) {
  return value
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '<id>')
    .replace(/\b[0-9a-f]{32,}\b/gi, '<hash>')
    .replace(/:\d+(?::\d+)?/g, ':<line>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}
const sourceInspections = new Set([
  'read_file',
  'list_files',
  'inspect_project',
  'read_tool_result',
  'read_engine_log',
  'read_playtest_log',
  'read_session_history',
  'read_skill_resource',
]);
export function acceptsRecoveryOperation(action: GoalRecoveryAction, name: string) {
  if (action === 'blocked' || action === 'budget_limited') return false;
  if (action === 'rebase') return investigations.has(name);
  return true;
}
/** No model wording, token count or number of tools is treated as verified progress. */
export function reviewCheckpoint(
  previous: GoalRuntimeState | undefined,
  input: GoalCheckpointInput,
  options: {
    checkpointId: string;
    at: string;
    planRevision: number;
    evidencePolicy: 'artifact' | 'runtime' | 'playtest';
  },
): GoalRuntimeState {
  const findings: GoalRiskFinding[] = [];
  const finding = (
    category: GoalRiskFinding['category'],
    code: string,
    severity: GoalRiskFinding['severity'],
    message: string,
  ) => findings.push({ category, code, severity, message, refs: [options.checkpointId] });
  const source = input.sourceVersion ?? previous?.sourceVersion;
  const environment = input.environmentVersion ?? previous?.environmentVersion;
  const sourceChanged = !!(
    previous?.sourceVersion &&
    input.sourceVersion &&
    previous.sourceVersion !== input.sourceVersion
  );
  const environmentChanged = !!(
    previous?.environmentVersion &&
    input.environmentVersion &&
    previous.environmentVersion !== input.environmentVersion
  );
  const expectedWrite =
    sourceChanged && !!input.operation?.succeeded && mutations.has(input.operation.name);
  const externalChange =
    input.externalChange === true || environmentChanged || (sourceChanged && !expectedWrite);
  const retained = sourceChanged || environmentChanged ? [] : previous?.verifiedEvidence || [];
  const verifiedEvidence = [...retained];
  let fresh = 0;
  let freshValidation = 0;
  for (const evidence of input.verifiedEvidence || []) {
    if (
      (evidence.sourceVersion && source && evidence.sourceVersion !== source) ||
      (evidence.environmentVersion && environment && evidence.environmentVersion !== environment)
    ) {
      finding(
        'false_completion',
        'stale_evidence_rejected',
        'error',
        '观测属于旧源码或旧环境，未计入当前验收。',
      );
      continue;
    }
    if (
      !verifiedEvidence.some(
        (v) => v.kind === evidence.kind && v.ref === evidence.ref && v.sha256 === evidence.sha256,
      )
    ) {
      verifiedEvidence.push(evidence);
      fresh++;
      if (
        options.evidencePolicy === 'artifact' ||
        evidence.kind === 'playtest' ||
        (options.evidencePolicy === 'runtime' && evidence.kind === 'engine-job')
      )
        freshValidation++;
    }
  }
  const operationSignature = input.operation
    ? goalDigest({ name: input.operation.name, args: input.operation.argsSha256, source })
    : previous?.operationSignature;
  const repeatedOperation = input.operation
    ? operationSignature === previous?.operationSignature
      ? (previous?.repeatedOperation || 0) + 1
      : 1
    : previous?.repeatedOperation || 0;
  const rawFailure =
    input.operation?.succeeded === false
      ? input.operation.error || input.activeErrors?.[0] || 'tool_failed'
      : undefined;
  const failureSignature = rawFailure
    ? goalDigest(normalizedFailure(rawFailure))
    : previous?.failureSignature;
  const repeatedFailure = rawFailure
    ? failureSignature === previous?.failureSignature
      ? (previous?.repeatedFailure || 0) + 1
      : 1
    : freshValidation
      ? 0
      : previous?.repeatedFailure || 0;
  const observedResults = [...(previous?.observedResults || [])];
  const inspected =
    input.operation?.succeeded &&
    input.operation.resultSha256 &&
    sourceInspections.has(input.operation.name)
      ? goalDigest({
          source,
          name: input.operation.name,
          args: input.operation.argsSha256,
          result: input.operation.resultSha256,
        })
      : undefined;
  const freshInspection = !!inspected && !observedResults.includes(inspected);
  if (freshInspection) observedResults.push(inspected!);
  const progressed = sourceChanged || fresh > 0 || freshInspection;
  const noProgressCheckpoints = progressed
    ? 0
    : (previous?.noProgressCheckpoints || 0) + (input.operation ? 1 : 0);
  const validationDebt = freshValidation
    ? 0
    : (previous?.validationDebt || 0) + (expectedWrite ? 1 : 0);
  const cycle = [
    ...(previous?.cycle || []),
    ...(input.operation
      ? [goalDigest({ operation: operationSignature, failed: !!rawFailure })]
      : []),
  ].slice(-18);
  const repeatingCycle = [2, 3, 4].some(
    (width) =>
      cycle.length >= width * 3 &&
      [1, 2].every(
        (n) => cycle.slice(-width).join() === cycle.slice(-(n + 1) * width, -n * width).join(),
      ),
  );
  const activeErrors = (input.activeErrors ?? previous?.activeErrors ?? []).slice(0, 8);
  let action: GoalRecoveryAction = previous?.action === 'rebase' ? 'rebase' : 'continue';
  if (previous?.action === 'blocked') action = 'blocked';
  if (externalChange) {
    action = 'rebase';
    finding(
      'environment_drift',
      'environment_changed',
      'warning',
      '实际源码或执行环境发生外部变化；旧证据失效，先重新检查并更新当前计划。',
    );
  }
  if (repeatedOperation >= 3 && !progressed) {
    if (action !== 'rebase') action = 'change_strategy';
    finding(
      'plan_loop',
      'repeated_operation',
      'warning',
      '相同版本上重复同一操作，没有新增实证；应读取精确失败点或采用新的验证路径。',
    );
  }
  if ((repeatedFailure >= 3 || repeatingCycle) && !freshValidation) {
    if (action !== 'rebase') action = 'change_strategy';
    finding(
      'plan_loop',
      'repeated_failure',
      'warning',
      '相同失败或操作循环反复出现；写入新文件不能掩盖未修复的错误。',
    );
  }
  if (
    (repeatedFailure >= 5 ||
      noProgressCheckpoints >= 16 ||
      (repeatingCycle && noProgressCheckpoints >= 12)) &&
    !freshValidation
  ) {
    action = 'blocked';
    finding(
      'plan_loop',
      'loop_stopped',
      'error',
      '反复失败或无进展循环已达到停止条件；保留全部记录，等待明确调整路径后恢复。',
    );
  }
  if (validationDebt >= 4 && options.evidencePolicy !== 'artifact' && action === 'continue') {
    action = 'verify';
    finding(
      'false_completion',
      'validation_debt',
      'warning',
      '源码已连续变更，尚无当前版本运行证据；优先实际运行或试玩。',
    );
  }
  const unresolvedChildren = input.unresolvedChildren ?? previous?.unresolvedChildren ?? 0;
  const conflictedLeases = input.conflictedLeases ?? previous?.conflictedLeases ?? 0;
  if (unresolvedChildren || conflictedLeases)
    finding(
      'collaboration',
      'unsettled_collaboration',
      conflictedLeases ? 'error' : 'warning',
      '子任务或共享租约尚未核对完成，主目标不可完成。',
    );
  if (activeErrors.length)
    finding(
      'false_completion',
      'active_runtime_errors',
      'error',
      '当前运行仍有实际错误，不接受文字成功汇报。',
    );
  return {
    checkpointId: options.checkpointId,
    sourceVersion: source,
    environmentVersion: environment,
    action,
    operationSignature,
    repeatedOperation,
    failureSignature,
    repeatedFailure,
    noProgressCheckpoints,
    validationDebt,
    verifiedEvidence: verifiedEvidence.slice(-16),
    activeErrors,
    unresolvedChildren,
    conflictedLeases,
    strategyRevision: options.planRevision,
    cycle,
    observedResults: observedResults.slice(-64),
    findings,
    lastProgressAt: progressed ? options.at : previous?.lastProgressAt,
    lastProgressCheckpointId: progressed
      ? options.checkpointId
      : previous?.lastProgressCheckpointId,
  };
}
