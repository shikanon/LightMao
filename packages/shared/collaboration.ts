export interface CollaborationRole {
  id: string;
  name: string;
  kind: 'implementer' | 'reviewer' | 'tester';
  writePaths: string[];
}
export interface CollaborationPlan {
  id: string;
  projectId: string;
  objective: string;
  milestones: string[];
  roles: CollaborationRole[];
  window: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface SharedLease {
  id: string;
  projectId: string;
  path: string;
  holder: string;
  token: number;
  expiresAt: string;
  releasedAt?: string;
}
export interface SubAgentTask {
  id: string;
  parentRunId: string;
  parentToolCallId?: string;
  sessionId: string;
  projectId: string;
  window: number;
  role: CollaborationRole;
  objective: string;
  acceptance: string;
  writePaths: string[];
  dependsOn: string[];
  maxTurns: 3 | 4;
  turns: number;
  status:
    | 'queued'
    | 'running'
    | 'reported'
    | 'verified'
    | 'merged'
    | 'stale'
    | 'contradicted'
    | 'cancelled'
    | 'interrupted';
  summary: string;
  baseSha256?: string;
  branchSha256?: string;
  changes: { path: string; before: string | null; after: string }[];
  leases: { id: string; token: number }[];
  evidenceId?: string;
  monitorSourceId?: string;
  verifiedRunId?: string;
  verifiedAt?: string;
  verifiedProjectSha256?: string;
  checkpointId?: string;
  createdAt: string;
  updatedAt: string;
}
export interface SharedCheckpoint {
  id: string;
  taskId: string;
  projectId: string;
  status: 'applying' | 'applied' | 'unknown' | 'rolled_back';
  files: {
    path: string;
    before: string | null;
    beforeSha256: string | null;
    afterSha256: string;
  }[];
  createdAt: string;
  updatedAt: string;
}
export interface MonitorSource {
  id: string;
  projectId: string;
  name: string;
  pageUrl: string;
  healthUrl: string;
  checks: { path: string; op: 'equals' | 'lte'; value: string | number | boolean }[];
  maxAgeSeconds: number;
  protectedPaths?: string[];
  createdAt: string;
}
export interface GroundTruthEvidence {
  id: string;
  sourceId: string;
  projectId: string;
  sessionId: string;
  runId: string;
  capturedAt: string;
  expiresAt: string;
  screenshotSha256: string;
  healthy: boolean;
  checks: { name: string; passed: boolean; actual: string }[];
  pageErrors: string[];
  inspectedRunId?: string;
  deliveredAt?: string;
}
export interface CollaborationView {
  plan?: CollaborationPlan;
  tasks: SubAgentTask[];
  leases: SharedLease[];
  sources: MonitorSource[];
  evidence: GroundTruthEvidence[];
  checkpoints: Omit<SharedCheckpoint, 'files'>[];
}
