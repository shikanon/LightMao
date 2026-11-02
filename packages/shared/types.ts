export type Mode = 'demo' | 'ark';
export type WorkMode = 'act' | 'plan' | 'goal';
import type { GoalAcceptanceAnchor, GoalRuntimeState } from './long-horizon.ts';
export interface AgentPlan {
  id: string;
  sessionId: string;
  projectId: string;
  objective: string;
  steps: {
    id: string;
    text: string;
    status: 'pending' | 'in_progress' | 'completed';
    acceptance: string;
  }[];
  revision: number;
  updatedAt: string;
  approvedAt?: string;
  goalId?: string;
  contractHash?: string;
  window?: number;
  acceptanceAnchors?: GoalAcceptanceAnchor[];
}
export interface GoalEvidence {
  kind: 'file' | 'engine-job' | 'playtest' | 'media-job' | 'visual-assessment';
  ref: string;
  summary: string;
  sha256?: string;
  runId?: string;
  verifiedAt?: string;
  sourceVersion?: string;
  environmentVersion?: string;
}
export interface AgentGoal {
  id: string;
  sessionId: string;
  projectId: string;
  objective: string;
  provider: Mode;
  evidencePolicy: 'artifact' | 'runtime' | 'playtest';
  visualMinScore?: number;
  status:
    | 'active'
    | 'paused'
    | 'waiting_permission'
    | 'completed'
    | 'blocked'
    | 'budget_limited'
    | 'interrupted';
  maxRounds: number;
  maxMinutes?: number;
  activeElapsedMs?: number;
  currentRoundStartedAt?: string;
  roundStartedProgressId?: string;
  contractHash?: string;
  contractProvenance?: 'user-request' | 'legacy-baseline';
  contractVersion?: number;
  userConstraints?: { text: string; at: string; sourceMessageId?: string }[];
  outlineHash?: string;
  acceptanceAnchors?: GoalAcceptanceAnchor[];
  checkpointCount?: number;
  runtime?: GoalRuntimeState;
  rounds: number;
  noProgressRounds: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  currentRunId?: string;
  nextRunAt?: string;
  lastRunId?: string;
  reason?: string;
  evidence: GoalEvidence[];
  completion?: {
    at: string;
    contractHash: string;
    sourceVersion?: string;
    environmentVersion?: string;
  };
  invalidation?: { at: string; reason: string; previousContractHash?: string };
}
export interface CapabilityRequest {
  id: string;
  sessionId: string;
  projectId: string;
  pluginId: string;
  reason: string;
  state: 'pending' | 'resolved' | 'declined';
  createdAt: string;
}
export interface WorkflowView {
  plan?: AgentPlan;
  goal?: AgentGoal;
  requests: CapabilityRequest[];
}
export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface User {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'member';
  status: 'active' | 'disabled';
  createdAt: string;
  revision?: number;
}
export interface LoginSession {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  current: boolean;
}
export interface DeviceAuthorization {
  id: string;
  deviceId: string;
  label: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  revokedAt?: string;
}
export interface LocalAuthorization {
  deviceId: string;
  grantId?: string;
  expiresAt?: string;
  status: 'ready' | 'required';
}
export interface Project {
  id: string;
  name: string;
  description: string;
  engine: string;
  root: string;
  createdAt: string;
  updatedAt?: string;
  source?: 'created' | 'imported';
  status?: 'active' | 'archived';
  access?: 'read' | 'write' | 'revoked';
  revision?: number;
  rootIdentity?: { dev: string; ino: string };
}
export interface ProjectDirectoryGrant {
  grantId: string;
  root: string;
  name: string;
  engine: string;
  access: 'read' | 'write';
  expiresAt: string;
  projectId?: string;
}
export interface EngineConnection {
  id: string;
  projectId: string;
  engine: 'godot';
  version: string;
  executableName: string;
  sha256: string;
  enabled: boolean;
  revision: number;
  projectRevision: number;
  needsAuthorization: boolean;
  updatedAt: string;
}
export interface EngineGrant {
  grantId: string;
  projectId: string;
  version: string;
  executableName: string;
  sha256: string;
  expiresAt: string;
  scope: string;
}
export interface EngineArtifact {
  id: string;
  path: string;
  bytes: number;
  sha256: string;
  mime: string;
}
export interface EnginePhase {
  name: 'import' | 'run' | 'script' | 'playtest';
  code: number | null;
  signal: string | null;
  durationMs: number;
  errorCount: number;
  warningCount: number;
}
export interface EngineJob {
  id: string;
  projectId: string;
  runId?: string;
  action: 'validate' | 'run' | 'script' | 'playtest';
  script?: string;
  frames: number;
  timeoutSeconds: number;
  requestId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  stage: 'snapshot' | 'import' | 'run' | 'script' | 'playtest' | 'finished';
  version: string;
  executableSha256: string;
  startedAt: string;
  endedAt?: string;
  error?: string;
  code?: string;
  snapshot?: { sha256: string; fileCount: number; totalBytes: number; excludedCount: number };
  phases: EnginePhase[];
  artifacts: EngineArtifact[];
  diagnostics: string[];
  verification: 'not_run' | 'process_only' | 'tests_passed' | 'tests_failed' | 'unreported';
}
export type EngineJobSummary = Pick<
  EngineJob,
  | 'id'
  | 'projectId'
  | 'runId'
  | 'action'
  | 'script'
  | 'status'
  | 'stage'
  | 'version'
  | 'startedAt'
  | 'endedAt'
  | 'error'
  | 'snapshot'
  | 'verification'
>;
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  at: string;
  mode: Mode;
  runId?: string;
  sample?: boolean;
  assetIds?: string[];
  referenceIds?: string[];
}
export interface Session {
  id: string;
  projectId: string;
  title: string;
  messages: ChatMessage[];
  transcript: unknown[];
  parentId?: string;
  forkPoint?: string;
  activeRunId?: string;
  status: RunStatus | 'idle';
  workMode?: WorkMode;
  createdAt: string;
  updatedAt: string;
  projectRevision?: number;
  revision?: number;
  archivedAt?: string;
  pinned?: boolean;
  forkRunId?: string;
  forkSourceTitle?: string;
  forkContext?: 'recorded' | 'reconstructed' | 'sample';
}
export type SessionView = Omit<Session, 'transcript'>;
export type SessionSummary = Omit<SessionView, 'messages'> & {
  messageCount: number;
  preview: string;
};
export interface SessionPage {
  items: SessionSummary[];
  nextCursor: string | null;
  total: number;
}
export interface Run {
  assetIds?: string[];
  referenceIds?: string[];
  id: string;
  sessionId: string;
  projectId: string;
  status: RunStatus;
  mode: Mode;
  workMode?: WorkMode;
  goalId?: string;
  prompt: string;
  startedAt: string;
  endedAt?: string;
  error?: string;
  text: string;
  taskId?: string;
  taskOccurrenceId?: string;
  toolCount?: number;
  toolErrorCount?: number;
  toolContext?: { originalChars: number; retainedChars: number };
  historyContext?: HistoryContextStats;
}
export interface HistoryContextStats {
  estimatedTokens: number;
  budgetTokens: number;
  estimateSource: 'bytes' | 'observed';
  messageCount: number;
  sourceMessages: number;
  retainedMessages: number;
  summaryRef?: string;
  summaryCalls: number;
}
export interface ConversationMemoryItem {
  kind: 'goal' | 'constraint' | 'decision' | 'reported' | 'pending';
  text: string;
  sourceIds: string[];
}
export interface ConversationMemoryView {
  id: string;
  at: string;
  items: ConversationMemoryItem[];
  sourceMessages: number;
  sources: { id: string; role: ChatMessage['role']; preview: string; runId?: string }[];
  mode: Mode;
}
export interface SessionHistoryPage {
  text: string;
  offset: number;
  nextOffset: number | null;
  totalChars: number;
  found: boolean;
  sha256: string;
  source?: { id: string; role: ChatMessage['role']; at: string; runId?: string };
}
export type RunActivity = Omit<Run, 'prompt' | 'text'>;
export interface ToolDetail {
  exactPage?: boolean;
  id: string;
  ownerId: string;
  projectId: string;
  sessionId: string;
  runId: string;
  toolCallId: string;
  name: string;
  argsSummary: string;
  summary: string;
  isError: boolean;
  state: 'running' | 'completed' | 'failed' | 'unknown';
  originalChars: number;
  retainedChars: number;
  payloadChars: number;
  sha256: string;
  at: string;
  version: 1;
}
export interface ToolDetailPage {
  detail: ToolDetail;
  text: string;
  offset: number;
  nextOffset: number | null;
  totalChars: number;
  found: boolean;
}
export interface RunEvent {
  id: string;
  runId: string;
  seq: number;
  type: string;
  at: string;
  data: Record<string, unknown>;
}
export interface Plugin {
  id: string;
  name: string;
  description: string;
  category: string;
  version: string;
  publisher: string;
  icon: string;
  color: string;
  capabilities: string[];
  tools: string[];
  installed: boolean;
  enabled: boolean;
  available?: boolean;
}
export interface Skill {
  id: string;
  name: string;
  description: string;
  content: string;
  enabled: boolean;
  category: string;
  updatedAt: string;
  origin?: 'cloud' | 'local';
  format?: 'markdown' | 'agent-skill';
  revision?: number;
  sha256?: string;
  slug?: string;
  fileCount?: number;
  totalBytes?: number;
}
export type SkillSummary = Omit<Skill, 'content'>;
export interface SkillResource {
  path: string;
  bytes: number;
  sha256: string;
  mime: string;
}
export interface SkillImportPreview {
  grantId: string;
  name: string;
  description: string;
  instructions: string;
  files: SkillResource[];
  totalBytes: number;
  sha256: string;
  expiresAt: string;
  ignored: string[];
  replaceId?: string;
}
export interface Asset {
  id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  projectId?: string;
  createdAt: string;
  updatedAt?: string;
  folderId?: string;
  deletedAt?: string;
}
export interface AssetFolder {
  id: string;
  name: string;
  parentId?: string;
  createdAt: string;
}
export interface StorageInfo {
  driver: 'local' | 'oss';
  label: string;
  quotaBytes: number;
  fileLimitBytes: number;
  usedBytes?: number;
}
export interface GenerationJob {
  id: string;
  projectId: string;
  sessionId: string;
  kind: 'image' | 'video';
  name: string;
  model: string;
  status:
    | 'created'
    | 'submitting'
    | 'queued'
    | 'running'
    | 'ingesting'
    | 'completed'
    | 'failed'
    | 'unknown';
  createdAt: string;
  updatedAt: string;
  upstreamTaskId?: string;
  asset?: Asset;
  error?: string;
  requestId: string;
}
export interface GamePreview {
  id: string;
  projectId: string;
  entry: string;
  url: string;
  sourceSha256: string;
  expiresAt: string;
  active: boolean;
}
export interface PlaytestJob {
  id: string;
  projectId: string;
  sessionId: string;
  runId?: string;
  requestId: string;
  status: 'running' | 'passed' | 'failed' | 'interrupted';
  goal: string;
  startedAt: string;
  endedAt?: string;
  previewId: string;
  sourceSha256: string;
  steps: number;
  inputActions: number;
  requestIds: string[];
  screenshotSha256?: string;
  captures?: { id: string; seconds: number; phase?: string; sha256: string; bytes: number }[];
  finalCaptureSeconds?: number;
  assertions: {
    field: string;
    op: 'eq' | 'ne' | 'gte' | 'lte' | 'truthy';
    value?: string | number | boolean;
    passed?: boolean;
  }[];
  error?: string;
  engineJobId?: string;
  rendering?: 'headless' | 'native-window' | 'browser-window';
  audio?: 'muted';
}
export interface GodotObservation {
  id: string;
  state: Record<string, unknown>;
  actions: { id: string; label: string; key: string; frames: number }[];
}
export interface Schedule {
  id: string;
  name: string;
  prompt: string;
  projectId: string;
  frequency: 'daily' | 'interval';
  time: string;
  intervalMinutes: number;
  timezone: string;
  mode: Mode;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt?: string;
  lastStatus?: string;
  lastSessionId?: string;
  createdAt: string;
  authorization?: 'ready' | 'required';
  authorizationExpiresAt?: string;
  lastError?: string;
  revision?: number;
  lastOccurrenceId?: string;
}
export interface TaskOccurrence {
  id: string;
  taskId: string;
  taskName: string;
  projectId: string;
  prompt: string;
  mode: Mode;
  source: 'scheduled' | 'manual';
  scheduledAt: string;
  createdAt: string;
  status: RunStatus | 'queued' | 'skipped' | 'authorization_required' | 'project_unavailable';
  sessionId?: string;
  runId?: string;
  startedAt?: string;
  endedAt?: string;
  error?: string;
  attempts?: number;
  nextAttemptAt?: string;
}
export interface ModelConfig {
  alias: string;
  label: string;
  modelId: string;
  enabled: boolean;
  revision?: number;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
}
export interface Audit {
  id: string;
  actor: string;
  action: string;
  detail: string;
  at: string;
}
export interface Usage {
  id: string;
  userId: string;
  model: string;
  capability?: 'chat' | 'decision' | 'image' | 'video' | 'vision' | 'audio';
  traceId?: string;
  spanId?: string;
  audioTokens?: number;
  status: string;
  durationMs: number;
  totalTokens?: number;
  at: string;
  promptTokens?: number;
  completionTokens?: number;
  upstreamStatus?: number;
  failureReason?:
    'upstream_error' | 'network_error' | 'stream_incomplete' | 'client_cancelled' | 'timeout';
}
export interface AdminPage<T> {
  items: T[];
  total: number;
  nextCursor?: string;
}
export interface AdminIdentity {
  id: string;
  name: string;
  email: string;
}
export type AdminUsage = Usage & { user?: AdminIdentity };
export type AdminAudit = Audit & { user?: AdminIdentity };
export interface AdminPlugin {
  id: string;
  name: string;
  version: string;
  tools: string[];
  available: boolean;
  revision: number;
  installedUsers: number;
  enabledUsers: number;
}
export interface AdminOverview {
  model: ModelConfig;
  arkConfigured: boolean;
  totals: {
    users: number;
    activeUsers: number;
    modelRequests: number;
    runningRequests: number;
    failedRequests: number;
    totalTokens: number;
    tokenRequests: number;
    assets: number;
    storageBytes: number;
  };
}
export interface CloudBootstrap {
  permissions?: { mode: 'full' | 'custom'; revision: number };
  user: User;
  plugins: Plugin[];
  skills: SkillSummary[];
  assets: Asset[];
  model: ModelConfig;
  arkConfigured: boolean;
  demoAllowed: boolean;
  features?: {
    systemOne?: boolean;
    generations?: boolean;
    capabilityModels?: boolean;
    permissionDefaults?: boolean;
    perception?: boolean;
  };
  folders?: AssetFolder[];
  storage?: StorageInfo;
}
export interface LocalBootstrap {
  projects: Project[];
  sessions: SessionSummary[];
  sessionCounts?: Record<string, { active: number; archived: number; total: number }>;
  schedules: Schedule[];
  skills?: SkillSummary[];
  runtime: {
    framework: string;
    sandbox: string;
    online: boolean;
    deviceId?: string;
    workflowModes?: boolean;
    gamePlaytests?: boolean;
    subAgents?: boolean;
    traces?: boolean;
    referenceMedia?: boolean;
    artifactPreview?: boolean;
    uiState?: boolean;
    longHorizon?: boolean;
    traceReview?: boolean;
    isolation?: { available: boolean; platform: string; engine: string; error?: string };
  };
}
export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  readOnly: boolean;
}
export interface McpPlugin {
  id: string;
  projectId: string;
  name: string;
  transport: 'stdio' | 'http';
  access: 'read' | 'write';
  domains: string[];
  endpoint?: string;
  filename?: string;
  sha256?: string;
  enabled: boolean;
  revision: number;
  tools: McpToolInfo[];
  approvedTools: string[];
  catalogHash?: string;
  hasCredentials: boolean;
  lastProbe?: { ok: boolean; at: string; error?: string };
}
export interface McpFileGrant {
  grantId: string;
  filename: string;
  sha256: string;
  bytes: number;
  expiresAt: string;
}
export const now = () => new Date().toISOString();
