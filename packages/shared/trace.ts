export interface TraceHead {
  id: string;
  ownerId: string;
  projectId: string;
  sessionId: string;
  runId: string;
  parentTraceId?: string;
  parentSpanId?: string;
  goalId?: string;
  kind: 'run' | 'subagent' | 'playtest';
  createdAt: string;
  updatedAt: string;
  sequence: number;
  lastHash: string;
  status: string;
}
export interface TraceEvent {
  id: string;
  traceId: string;
  sequence: number;
  spanId: string;
  parentSpanId?: string;
  kind: string;
  name: string;
  at: string;
  status?: string;
  summary?: string;
  durationMs?: number;
  payloadRef?: string;
  payloadSha256?: string;
  toolDetailRef?: string;
  sourceEventIds?: string[];
  previousHash: string;
  hash: string;
}
export interface TracePage {
  head: Omit<TraceHead, 'ownerId'>;
  events: TraceEvent[];
  nextAfter: number;
  hasMore: boolean;
  integrity: boolean;
}
