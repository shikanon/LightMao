import { useState, useCallback, useEffect, useRef } from 'react';
import {
  Clock3,
  Plus,
  Play,
  Pause,
  MoreHorizontal,
  ArrowUpRight,
  CalendarClock,
  FileCode2,
  FolderSearch,
  FileText,
  Trash2,
} from 'lucide-react';
import { useWorkspace } from '../context';
import { api, post, patch } from '../api';
import { PageHeading, Toggle, Modal, Status, formatTime, Empty } from '../components/UI';
import type { Schedule, Run, SessionView, TaskOccurrence } from '../../../../packages/shared/types';
const statusNames: Record<string, string> = {
  queued: '等待执行',
  skipped: '已跳过重叠',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已停止',
  interrupted: '已中断',
  authorization_required: '需要重新授权',
  project_unavailable: '项目需要恢复',
};
export function Schedules() {
  const w = useWorkspace(),
    [editor, setEditor] = useState<Partial<Schedule> | undefined>(),
    [busy, setBusy] = useState(false),
    [tab, setTab] = useState('定时任务'),
    [historyState, setHistoryState] = useState<{
      items: TaskOccurrence[];
      nextCursor: string | null;
    }>({ items: [], nextCursor: null }),
    [loadError, setLoadError] = useState(false),
    [legacy, setLegacy] = useState<Run[]>([]),
    [loadingMore, setLoadingMore] = useState(false),
    [frequency, setFrequency] = useState('daily');
  const history = historyState.items,
    nextCursor = historyState.nextCursor;
  const pendingHistory = useRef<string[]>([]);
  pendingHistory.current = history
    .filter((row) => row.status === 'queued' || row.status === 'running')
    .slice(0, 50)
    .map((row) => row.id);
  const [reauthorize, setReauthorize] = useState<Schedule>();
  const [tasks, setTasks] = useState(w.local.schedules);
  useEffect(() => setTasks(w.local.schedules), [w.local.schedules]);
  const closeAuthorization = useCallback(() => setReauthorize(undefined), []);
  const close = useCallback(() => setEditor(undefined), []);
  const edit = (s: Partial<Schedule>) => {
    setEditor(s);
    setFrequency(s.frequency || 'daily');
  };
  useEffect(() => {
    let active = true,
      generation = 0;
    const load = () => {
      const request = ++generation;
      void api<Schedule[]>('/local/schedules')
        .then((result) => {
          if (active && request === generation) setTasks(result);
        })
        .catch(() => {});
      void Promise.all([
        api<{ items: TaskOccurrence[]; nextCursor: string | null }>(
          '/local/task-occurrences?limit=25',
        ),
        api<Run[]>('/local/history'),
        Promise.all(
          pendingHistory.current.map((id) => api<TaskOccurrence>(`/local/task-occurrences/${id}`)),
        ),
      ])
        .then(([page, runs, pending]) => {
          if (!active || request !== generation) return;
          setLoadError(false);
          setLegacy(runs.filter((run) => run.taskId && !run.taskOccurrenceId));
          setHistoryState((previous) => {
            const known = new Set(previous.items.map((item) => item.id));
            const overlap = page.items.some((item) => known.has(item.id));
            const base = overlap ? previous.items : [];
            const items = [
              ...new Map(
                [...base, ...page.items, ...pending.filter((item) => known.has(item.id))].map(
                  (item) => [item.id, item],
                ),
              ).values(),
            ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
            return {
              items,
              nextCursor:
                overlap && previous.items.length >= page.items.length
                  ? previous.nextCursor
                  : page.nextCursor,
            };
          });
        })
        .catch(() => {
          if (active && request === generation) setLoadError(true);
        });
    };
    load();
    const t = setInterval(load, 3000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [w.local.schedules]);
  const historyRows = [
    ...history.map((row) => ({ ...row, displayAt: row.scheduledAt })),
    ...legacy.map((run) => ({
      ...run,
      taskName: tasks.find((t) => t.id === run.taskId)?.name || '旧版任务',
      source: 'legacy',
      displayAt: run.startedAt,
    })),
  ].sort((a, b) => b.displayAt.localeCompare(a.displayAt));
  const start = async (task: Schedule) =>
    w.perform(async () => {
      const r = await post<{ session?: SessionView; occurrence: TaskOccurrence }>(
        `/local/schedules/${task.id}/run`,
        { requestId: crypto.randomUUID() },
      );
      await w.refresh();
      if (r.session) w.openSession(r.session.id);
      else w.notify('任务已进入等待队列，可在运行记录查看');
    }, '任务已启动');
  return (
    <div className="page-scroll">
      <div className="page-content">
        <PageHeading
          title="给创作，留一点自动驾驶。"
          description="把例行检查交给 Agent，把专注留给真正有趣的事。"
          action={
            <button className="button primary" onClick={() => edit({})}>
              <Plus size={17} />
              创建任务
            </button>
          }
        />
        <div className="scheduler-status">
          <span className="online-dot" />
          <strong>{loadError ? '任务状态暂时无法更新' : '本地调度已就绪'}</strong>
          <span>关闭桌面窗口可收起到托盘；休眠后合并补跑一次</span>
          <small>按任务时区执行</small>
        </div>
        <div className="collection-toolbar">
          <div className="tabs">
            {['定时任务', '运行记录'].map((t) => (
              <button className={tab === t ? 'selected' : ''} key={t} onClick={() => setTab(t)}>
                {t}
                <span>{t === '定时任务' ? tasks.length : historyRows.length}</span>
              </button>
            ))}
          </div>
        </div>
        {tab === '定时任务' ? (
          <>
            {tasks.length ? (
              <div className="schedule-list">
                {tasks.map((s) => (
                  <article key={s.id} className="schedule-row">
                    <div className="plugin-icon violet">
                      <Clock3 size={25} strokeWidth={1.5} />
                    </div>
                    <button className="schedule-content" onClick={() => edit(s)}>
                      <h2>{s.name}</h2>
                      <p>
                        {s.frequency === 'daily'
                          ? `每天 ${s.time}`
                          : `每 ${s.intervalMinutes} 分钟`}{' '}
                        · {s.timezone} · {w.local.projects.find((p) => p.id === s.projectId)?.name}
                      </p>
                      <small>
                        {s.enabled ? `下次运行 ${formatTime(s.nextRunAt)}` : '已暂停自动运行'}
                        {s.lastStatus ? ` · 上次${statusNames[s.lastStatus] || s.lastStatus}` : ''}
                      </small>
                      {s.lastError && <small className="execution-warning">{s.lastError}</small>}
                    </button>
                    <span className="mode-label">{s.mode === 'demo' ? '演示' : '方舟'}</span>
                    {s.authorization === 'required' ? (
                      <button
                        className="button secondary small-button"
                        onClick={() => setReauthorize(s)}
                      >
                        重新授权
                      </button>
                    ) : (
                      <Toggle
                        checked={s.enabled}
                        label={`启用任务${s.name}`}
                        onChange={() =>
                          void w.perform(
                            async () => {
                              await patch(`/local/schedules/${s.id}`, { enabled: !s.enabled });
                              await w.refresh();
                            },
                            s.enabled ? '任务已暂停' : '任务已启用',
                          )
                        }
                      />
                    )}
                    <button
                      className="icon-button"
                      title="立即运行"
                      aria-label={`立即运行${s.name}`}
                      disabled={s.authorization === 'required'}
                      onClick={() => void start(s)}
                    >
                      <Play size={17} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label={`编辑任务${s.name}`}
                      onClick={() => edit(s)}
                    >
                      <MoreHorizontal size={18} />
                    </button>
                  </article>
                ))}
              </div>
            ) : (
              <div className="schedule-empty">
                <div className="clock-orbit">
                  <CalendarClock size={40} strokeWidth={1.1} />
                </div>
                <h2>有些工作，可以提前安排好。</h2>
                <p>
                  创建你的第一个定时任务，
                  <br />
                  让项目检查和资料整理按时开始。
                </p>
                <button className="button secondary" onClick={() => edit({})}>
                  <Plus size={16} />
                  创建定时任务
                </button>
              </div>
            )}
            <div className="templates-heading">从一个常用工作流开始</div>
            <div className="schedule-templates">
              {[
                {
                  icon: FileCode2,
                  title: '每日项目检查',
                  text: '检查项目结构，整理待验证的问题。',
                  prompt: '检查当前项目目录与引擎配置，给出今天可以处理的事项。',
                },
                {
                  icon: FolderSearch,
                  title: '素材清单整理',
                  text: '把新素材整理成一份清晰的清单。',
                  prompt: '检查当前游戏项目的素材目录，整理可见文件和命名建议。',
                },
                {
                  icon: FileText,
                  title: '设计文档回顾',
                  text: '回看项目目标，让创作保持方向。',
                  prompt: '读取项目说明和设计文档，梳理已知目标与需要进一步确认的内容。',
                },
              ].map(({ icon: Icon, title, text, prompt }) => (
                <button key={title} onClick={() => edit({ name: title, prompt })}>
                  <Icon size={22} strokeWidth={1.5} />
                  <strong>{title}</strong>
                  <p>{text}</p>
                  <ArrowUpRight size={16} />
                </button>
              ))}
            </div>
          </>
        ) : historyRows.length ? (
          <div className="table-wrap">
            <table className="task-history-table">
              <thead>
                <tr>
                  <th>任务</th>
                  <th>状态</th>
                  <th>触发时间</th>
                  <th>来源</th>
                  <th>模式</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {historyRows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.taskName}</td>
                    <td>
                      <Status
                        tone={
                          r.status === 'completed'
                            ? 'green'
                            : r.status === 'failed'
                              ? 'red'
                              : 'neutral'
                        }
                      >
                        {statusNames[r.status] || r.status}
                      </Status>
                      {r.error && <small className="task-history-error">{r.error}</small>}
                    </td>
                    <td>{formatTime(r.displayAt)}</td>
                    <td>
                      {r.source === 'scheduled'
                        ? '计划触发'
                        : r.source === 'manual'
                          ? '立即运行'
                          : '旧版记录'}
                    </td>
                    <td>{r.mode === 'demo' ? '演示' : '方舟'}</td>
                    <td>
                      {r.sessionId ? (
                        <button className="text-button" onClick={() => w.openSession(r.sessionId!)}>
                          查看会话 <ArrowUpRight size={14} />
                        </button>
                      ) : (
                        <span className="task-no-session">未开始执行</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {nextCursor && (
              <button
                className="button secondary task-history-more"
                disabled={loadingMore}
                onClick={() => {
                  setLoadingMore(true);
                  void w
                    .perform(async () => {
                      const page = await api<{
                        items: TaskOccurrence[];
                        nextCursor: string | null;
                      }>(
                        `/local/task-occurrences?limit=25&before=${encodeURIComponent(nextCursor)}`,
                      );
                      setHistoryState((previous) => ({
                        items: [
                          ...new Map(
                            [...previous.items, ...page.items].map((item) => [item.id, item]),
                          ).values(),
                        ].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
                        nextCursor: page.nextCursor,
                      }));
                    })
                    .finally(() => setLoadingMore(false));
                }}
              >
                {loadingMore ? '读取中…' : '加载更早记录'}
              </button>
            )}
          </div>
        ) : (
          <Empty
            icon={<Clock3 size={30} />}
            title="还没有运行记录"
            description="立即运行一个任务，或等待下次计划时间。"
          />
        )}
      </div>
      {reauthorize && (
        <Modal
          title="重新授权并启用任务？"
          description={`将为本机更新执行凭证并启用「${reauthorize.name}」，允许模型调用与资料读取。`}
          onClose={closeAuthorization}
        >
          <footer>
            <button className="button secondary" onClick={closeAuthorization}>
              取消
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void w
                  .perform(async () => {
                    await post(`/local/schedules/${reauthorize.id}/authorize`, { enabled: true });
                    await w.refresh();
                    closeAuthorization();
                  }, '任务已重新授权并启用')
                  .finally(() => setBusy(false));
              }}
            >
              授权并启用
            </button>
          </footer>
        </Modal>
      )}
      {editor && (
        <Modal
          title={editor.id ? '编辑定时任务' : '创建定时任务'}
          description="每次触发都会创建独立会话，保留完整运行记录。"
          onClose={close}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setBusy(true);
              const values = Object.fromEntries(new FormData(e.currentTarget));
              const data = {
                ...values,
                intervalMinutes: Number(values.intervalMinutes || 60),
                time: values.time || '09:00',
                enabled: editor.enabled ?? true,
              };
              void w
                .perform(async () => {
                  if (editor.id) await patch(`/local/schedules/${editor.id}`, data);
                  else await post('/local/schedules', data);
                  await w.refresh();
                  close();
                }, '定时任务已保存')
                .finally(() => setBusy(false));
            }}
          >
            <label>
              任务名称
              <input
                name="name"
                required
                maxLength={80}
                defaultValue={editor.name}
                placeholder="例如：每日项目检查"
              />
            </label>
            <label>
              交给 Agent 的任务
              <textarea
                name="prompt"
                required
                rows={3}
                defaultValue={editor.prompt}
                placeholder="描述每次运行时需要完成的工作…"
              />
            </label>
            <div className="form-grid">
              <label>
                所属项目
                <select
                  aria-label="所属项目"
                  name="projectId"
                  defaultValue={editor.projectId || w.session?.projectId}
                >
                  {w.local.projects
                    .filter((p) => p.status !== 'archived' && p.access !== 'revoked')
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                模型模式
                <select
                  aria-label="模型模式"
                  name="mode"
                  defaultValue={editor.mode || (w.cloud.arkConfigured ? 'ark' : 'demo')}
                >
                  <option value="demo">演示模式</option>
                  <option value="ark">方舟模型</option>
                </select>
              </label>
            </div>
            <div className="form-grid">
              <label>
                运行频率
                <select
                  aria-label="运行频率"
                  name="frequency"
                  value={frequency}
                  onChange={(e) => setFrequency(e.target.value)}
                >
                  <option value="daily">每天</option>
                  <option value="interval">固定间隔</option>
                </select>
              </label>
              {frequency === 'daily' ? (
                <label>
                  运行时间
                  <input name="time" type="time" required defaultValue={editor.time || '09:00'} />
                </label>
              ) : (
                <label>
                  间隔（分钟）
                  <input
                    name="intervalMinutes"
                    type="number"
                    required
                    min={1}
                    max={43200}
                    defaultValue={editor.intervalMinutes || 60}
                  />
                </label>
              )}
            </div>
            <label>
              时区
              <select
                aria-label="时区"
                name="timezone"
                defaultValue={editor.timezone || 'Asia/Shanghai'}
              >
                <option>Asia/Shanghai</option>
                <option>UTC</option>
                <option>America/New_York</option>
              </select>
            </label>
            <p className="form-hint">
              设备休眠或退出期间暂停执行，恢复后合并补跑一次。尚未开始的队列可恢复，已开始后中断的运行不会自动重跑。任务正在等待或运行时会跳过重叠触发。本机凭证独立于网页登录；撤销设备或修改密码后需要重新授权。
            </p>
            <footer>
              {editor.id && (
                <button
                  className="button danger-quiet"
                  type="button"
                  onClick={() =>
                    void w.perform(async () => {
                      await api(`/local/schedules/${editor.id}`, { method: 'DELETE' });
                      await w.refresh();
                      close();
                    }, '定时任务已删除')
                  }
                >
                  删除任务
                </button>
              )}
              <button className="button secondary" type="button" onClick={close}>
                取消
              </button>
              <button className="button primary" disabled={busy}>
                {busy ? '保存中…' : '保存任务'}
              </button>
            </footer>
          </form>
        </Modal>
      )}
    </div>
  );
}
