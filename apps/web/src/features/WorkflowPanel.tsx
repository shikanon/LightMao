import { useEffect, useState, useRef } from 'react';
import { ListChecks, Target, Pause, Play, PlugZap } from 'lucide-react';
import { api, post, patch } from '../api';
import { useWorkspace } from '../context';
import type { AgentPlan, WorkflowView } from '../../../../packages/shared/types';

const goalLabels = {
  active: '进行中',
  paused: '已暂停',
  waiting_permission: '等待启用能力',
  completed: '证据已核对',
  blocked: '等待处理',
  budget_limited: '轮数预算已到',
  interrupted: '待核对后恢复',
};
export function WorkflowPanel({
  sessionId,
  activeRunId,
  messageCount,
  onExecute,
}: {
  sessionId: string;
  activeRunId?: string;
  messageCount: number;
  onExecute: (plan: AgentPlan) => Promise<void>;
}) {
  const w = useWorkspace();
  const [view, setView] = useState<WorkflowView>();
  const [version, setVersion] = useState(0);
  const observedRun = useRef<string | undefined>(undefined);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const next = await api<WorkflowView>(`/local/sessions/${sessionId}/workflow`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setView(next);
        setError('');
        const latestRun = next.goal?.currentRunId || next.goal?.lastRunId;
        if (latestRun && latestRun !== observedRun.current) {
          observedRun.current = latestRun;
          await w.refresh();
        }
        if (activeRunId || next.goal?.status === 'active')
          timer = setTimeout(() => void refresh(), 1800);
      } catch (e) {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '工作流暂不可用');
      }
    }
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [sessionId, activeRunId, messageCount, version, w.refresh]);
  const act = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      setView(await api<WorkflowView>(`/local/sessions/${sessionId}/workflow`));
      setVersion((value) => value + 1);
      setError('');
      await w.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };
  const goal = view?.goal,
    plan = view?.plan;
  if (!goal && !plan && !view?.requests.length && !error) return null;
  return (
    <div className="workflow-panel" aria-label="计划与目标">
      {error && (
        <p role="alert" className="workflow-error">
          {error}
        </p>
      )}
      {goal && (
        <div className={`goal-strip goal-${goal.status}`}>
          <Target size={16} />
          <div>
            <strong>Goal · {goalLabels[goal.status]}</strong>
            <span title={goal.objective}>{goal.objective}</span>
            {goal.reason && <small>{goal.reason}</small>}
          </div>
          <span className="goal-budget">
            {goal.rounds} / {goal.maxRounds} 轮
          </span>
          {(goal.status === 'budget_limited' ||
            (goal.rounds >= goal.maxRounds && goal.status !== 'completed')) &&
            goal.maxRounds < 10 && (
              <button
                className="text-button"
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    post(`/local/sessions/${sessionId}/goal/budget`, {
                      revision: goal.revision,
                      maxRounds: goal.maxRounds + 1,
                    }),
                  )
                }
              >
                增加一轮并继续
              </button>
            )}
          {goal.status === 'active' ? (
            <button
              className="icon-button"
              aria-label="暂停目标"
              disabled={busy}
              onClick={() =>
                void act(() =>
                  post(`/local/sessions/${sessionId}/goal/control`, {
                    action: 'pause',
                    revision: goal.revision,
                  }),
                )
              }
            >
              <Pause size={16} />
            </button>
          ) : (
            !['completed', 'budget_limited', 'waiting_permission'].includes(goal.status) && (
              <button
                className="icon-button"
                aria-label="恢复目标"
                disabled={busy || !!goal.currentRunId || goal.rounds >= goal.maxRounds}
                onClick={() =>
                  void act(() =>
                    post(`/local/sessions/${sessionId}/goal/control`, {
                      action: 'resume',
                      revision: goal.revision,
                    }),
                  )
                }
              >
                <Play size={16} />
              </button>
            )
          )}
        </div>
      )}
      {!!goal?.evidence.length && (
        <details className="goal-evidence">
          <summary>验收证据 · {goal.evidence.length} 项</summary>
          <ul>
            {goal.evidence.map((evidence) => (
              <li key={evidence.kind + evidence.ref}>
                <strong>
                  {{
                    file: '文件回读',
                    'engine-job': '实际引擎运行',
                    playtest: '实际输入试玩',
                    'media-job': '生成素材',
                    'visual-assessment': '视觉评分',
                  }[evidence.kind] || evidence.kind}
                </strong>{' '}
                · <code>{evidence.ref}</code>
                <p>{evidence.summary}</p>
              </li>
            ))}
          </ul>
        </details>
      )}
      {plan && (
        <details className="plan-card" open={!plan.approvedAt || undefined}>
          <summary>
            <ListChecks size={16} />
            <strong>实施计划</strong>
            <span>
              {plan.steps.filter((s) => s.status === 'completed').length} / {plan.steps.length}
            </span>
          </summary>
          <p>{plan.objective}</p>
          <ol>
            {plan.steps.map((step) => (
              <li key={step.id} className={`plan-${step.status}`}>
                <span>
                  {step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '◉' : '○'}
                </span>
                <div>
                  {step.text}
                  <small>验收：{step.acceptance}</small>
                </div>
              </li>
            ))}
          </ol>
          {!plan.approvedAt && (
            <button
              className="button secondary small"
              disabled={busy || !!activeRunId}
              onClick={() => void act(() => onExecute(plan))}
            >
              执行此计划
            </button>
          )}
        </details>
      )}
      {view?.requests.map((request) => {
        const plugin = w.cloud.plugins.find((p) => p.id === request.pluginId);
        return (
          <div className="capability-request" key={request.id}>
            <PlugZap size={17} />
            <div>
              <strong>需要{plugin?.name || request.pluginId}</strong>
              <p>{request.reason}</p>
            </div>
            <button
              className="button secondary small"
              disabled={busy || plugin?.available === false}
              onClick={() =>
                void act(async () => {
                  await patch(`/api/plugins/${encodeURIComponent(request.pluginId)}`, {
                    installed: true,
                    enabled: true,
                  });
                  await post(`/local/sessions/${sessionId}/capabilities/${request.id}`, {
                    approved: true,
                  });
                })
              }
            >
              启用
            </button>
            <button
              className="text-button"
              disabled={busy}
              onClick={() =>
                void act(() =>
                  post(`/local/sessions/${sessionId}/capabilities/${request.id}`, {
                    approved: false,
                  }),
                )
              }
            >
              暂不
            </button>
          </div>
        );
      })}
    </div>
  );
}
