export const traceReviewCategories = [
  { id: 'goal_drift', label: '目标与约束' },
  { id: 'context_fidelity', label: '上下文与事实' },
  { id: 'plan_loop', label: '计划与无效循环' },
  { id: 'collaboration', label: '并发与子 Agent' },
  { id: 'environment_drift', label: '环境变化' },
  { id: 'false_completion', label: '验收与完成' },
] as const;
export type TraceReviewCategory = (typeof traceReviewCategories)[number]['id'];
export interface TraceFinding {
  id: string;
  category: TraceReviewCategory;
  severity: 'info' | 'warning' | 'critical';
  code: string;
  message: string;
  contained: boolean;
  sources: { traceId: string; eventId: string; sequence: number }[];
}
export interface TraceReview {
  id: string;
  rulesVersion: 'long-horizon-v1';
  createdAt: string;
  goalId?: string;
  traces: { id: string; sequence: number; lastHash: string }[];
  integrity: boolean;
  truncated: boolean;
  checks: {
    category: TraceReviewCategory;
    label: string;
    status: 'clear' | 'guarded' | 'attention' | 'insufficient';
    observations: number;
    findings: TraceFinding[];
  }[];
  summary: string;
  limits: string[];
}
