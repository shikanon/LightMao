export type GoalRiskCategory =
  | 'goal_drift'
  | 'context_fidelity'
  | 'plan_loop'
  | 'collaboration'
  | 'environment_drift'
  | 'false_completion';
export type GoalRecoveryAction =
  'continue' | 'verify' | 'change_strategy' | 'rebase' | 'blocked' | 'budget_limited';
export interface GoalRiskFinding {
  category: GoalRiskCategory;
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  refs: string[];
}
export interface GoalAcceptanceAnchor {
  id: string;
  text: string;
  acceptance: string;
}
export interface GoalVerifiedObservation {
  kind: 'file' | 'engine-job' | 'playtest' | 'media-job' | 'visual-assessment';
  ref: string;
  sha256: string;
  sourceVersion?: string;
  environmentVersion?: string;
}
/** Only the local runtime constructs this object from actual tool/version checks. */
export interface GoalCheckpointInput {
  phase: 'start' | 'tool' | 'finish' | 'acceptance';
  sourceVersion?: string;
  environmentVersion?: string;
  externalChange?: boolean;
  operation?: {
    name: string;
    argsSha256: string;
    resultSha256?: string;
    succeeded: boolean;
    error?: string;
  };
  verifiedEvidence?: GoalVerifiedObservation[];
  activeErrors?: string[];
  unresolvedChildren?: number;
  conflictedLeases?: number;
}
export interface GoalRuntimeState {
  checkpointId: string;
  sourceVersion?: string;
  environmentVersion?: string;
  action: GoalRecoveryAction;
  operationSignature?: string;
  repeatedOperation: number;
  failureSignature?: string;
  repeatedFailure: number;
  noProgressCheckpoints: number;
  validationDebt: number;
  verifiedEvidence: GoalVerifiedObservation[];
  activeErrors: string[];
  unresolvedChildren: number;
  conflictedLeases: number;
  strategyRevision: number;
  cycle: string[];
  observedResults?: string[];
  findings: GoalRiskFinding[];
  lastProgressAt?: string;
  lastProgressCheckpointId?: string;
}
export interface GoalCheckpoint {
  id: string;
  goalId: string;
  sessionId: string;
  projectId: string;
  runId: string;
  sequence: number;
  at: string;
  contractHash: string;
  input: GoalCheckpointInput;
  runtime: GoalRuntimeState;
  sha256: string;
}
