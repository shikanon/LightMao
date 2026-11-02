import { useEffect, useState, lazy, Suspense } from 'react';
import { ChevronRight, Check, X, Clock3, FileText } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { api } from '../api';
import { Spinner } from '../components/UI';
const HistoryMemory = lazy(() =>
  import('./HistoryMemory').then((module) => ({ default: module.HistoryMemory })),
);
import type {
  RunActivity,
  RunEvent,
  ToolDetail,
  ToolDetailPage,
} from '../../../../packages/shared/types';

export const toolLabels: Record<string, string> = {
  run_godot: '在 Godot 中验证工程',
  read_engine_log: '读取引擎日志',
  list_files: '读取项目目录',
  read_file: '读取项目文件',
  inspect_project: '检查游戏项目',
  edit_file: '精确编辑文件',
  write_file: '写入项目文件',
  asset_inventory: '整理素材清单',
  read_tool_result: '回读执行详情',
  read_skill_resource: '按需读取技能资源',
  update_plan: '更新实施计划',
  discover_capabilities: '发现可用能力',
  request_capability: '请求启用能力',
  complete_goal: '核对目标证据',
  generate_image: '创建图片生成任务',
  generate_video: '创建视频生成任务',
  wait_media_job: '等待同一媒体任务',
  get_media_job: '读取媒体任务状态',
  import_generated_asset: '导入生成素材',
  start_game_preview: '启动可玩预览',
  run_browser_playtest: '自动试玩浏览器游戏',
  run_godot_playtest: '自动试玩Godot原生游戏',
  read_playtest_log: '读取试玩轨迹',
  read_session_history: '回读会话原文',
  load_capabilities: '按需加载已授权能力',
  plan_subagents: '规划子 Agent 分工',
  delegate_subagent: '分派独立子 Agent',
  get_subagent_result: '读取待核验汇报',
  verify_subagent_result: '核对实时状态与文件版本',
  apply_subagent_changes: '合并已核验副本',
  cancel_subagent: '撤销子任务并回收租约',
  advance_subagent_window: '滚动下一组任务',
  read_subagent_log: '回读子任务详情',
  list_monitor_sources: '读取项目监控源',
  capture_ground_truth: '独立采集实时截图',
  rollback_shared_changes: '恢复记录的配置并释放锁',
};
function elapsed(start?: string, end?: string) {
  if (!start) return '执行过程';
  const seconds = Math.max(
    0,
    Math.floor(((end ? Date.parse(end) : Date.now()) - Date.parse(start)) / 1000),
  );
  if (!Number.isFinite(seconds)) return '执行过程';
  return `用时 ${seconds < 1 ? '不到 1 秒' : seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`}`;
}

export function ExecutionTrace({
  runId,
  activity,
  open,
  onToggle,
  liveEvents,
  liveText = '',
}: {
  runId: string;
  activity?: RunActivity;
  open: boolean;
  onToggle: () => void;
  liveEvents?: RunEvent[];
  liveText?: string;
}) {
  const [saved, setSaved] = useState<RunEvent[]>([]),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false);
  const [, setClock] = useState(0);
  const running = !!liveEvents || activity?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setClock((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);
  useEffect(() => {
    if (!open || liveEvents) return;
    const abort = new AbortController();
    setLoading(true);
    setError('');
    void api<RunEvent[]>(`/local/runs/${runId}/events`, { signal: abort.signal })
      .then((events) => {
        if (!abort.signal.aborted) setSaved(events);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [runId, open, !!liveEvents]);
  const events = liveEvents || saved;
  const starts = events.filter((e) => e.type === 'tool.started');
  const count = running ? starts.length : (activity?.toolCount ?? starts.length);
  const errors = running
    ? events.filter((e) => e.type === 'tool.finished' && e.data.isError).length
    : activity?.toolErrorCount || 0;
  const failed = activity?.status === 'failed' || activity?.status === 'interrupted';
  const start = activity?.startedAt || events.find((e) => e.type === 'run.started')?.at;
  return (
    <section className={`execution-trace ${open ? 'expanded' : ''}`} aria-label="执行记录">
      <button
        className="execution-toggle"
        aria-expanded={open}
        aria-controls={`trace-${runId}`}
        onClick={onToggle}
      >
        {running ? <Spinner /> : <Clock3 size={14} />}
        <span>{running ? '正在执行' : elapsed(start, activity?.endedAt)}</span>
        {running && start && <small>{elapsed(start)}</small>}
        {count > 0 && <small>{count} 项工具</small>}
        {(errors > 0 || failed) && (
          <small className="execution-warning">{errors ? `${errors} 项失败` : '未完成'}</small>
        )}
        {activity?.status === 'cancelled' && <small>已停止</small>}
        <ChevronRight className="execution-chevron" size={15} />
      </button>
      {open && (
        <div id={`trace-${runId}`} className="execution-body">
          {loading ? (
            <div className="trace-loading">
              <Spinner /> 正在读取执行记录…
            </div>
          ) : error ? (
            <p role="alert" className="execution-warning">
              {error}，收起后可重新展开加载。
            </p>
          ) : (
            <>
              {events
                .filter((e) =>
                  ['context.loaded', 'progress.message', 'tool.started'].includes(e.type),
                )
                .map((e) => {
                  if (e.type === 'progress.message')
                    return (
                      <div className="trace-progress" key={e.id}>
                        <ReactMarkdown>{String(e.data.text)}</ReactMarkdown>
                      </div>
                    );
                  if (e.type === 'context.loaded')
                    return (
                      <p key={e.id} className="trace-context">
                        <FileText size={14} /> 已载入项目上下文
                        {(e.data.skills as string[] | undefined)?.length
                          ? ` · ${(e.data.skills as string[]).join('、')}`
                          : ''}
                      </p>
                    );
                  const end = events.find(
                    (x) => x.type === 'tool.finished' && x.data.toolCallId === e.data.toolCallId,
                  );
                  return <ToolStep key={e.id} start={e} end={end} running={running} />;
                })}
              {events.some((e) => e.type === 'context.compacting') &&
                !events.some((e) => e.type === 'context.compacted') && (
                  <p className="trace-context">
                    历史整理{running ? '进行中' : '未完成'}，原对话与已保存进度保留。
                  </p>
                )}
              {(() => {
                const last = events.findLast((e) => e.type === 'context.compacted');
                const ref =
                  activity?.historyContext?.summaryRef || (last?.data.ref as string | undefined);
                return ref ? (
                  <div className="trace-context history-context-note">
                    较早历史已整理，原对话保留。
                    <Suspense fallback={<Spinner />}>
                      <HistoryMemory reference={ref} />
                    </Suspense>
                  </div>
                ) : null;
              })()}
              {running && liveText && (
                <div className="trace-progress streaming">
                  <ReactMarkdown>{liveText}</ReactMarkdown>
                </div>
              )}
              {!events.length && !running && <p className="muted">这次运行没有工具记录。</p>}
              {activity?.error && <p className="execution-warning">{activity.error}</p>}
              <p className="trace-storage-note">
                主对话仅接收工具摘要；原始输入与输出按需加载。
                {activity?.toolContext &&
                  activity.toolContext.originalChars > activity.toolContext.retainedChars && (
                    <span>
                      本轮工具记录：{activity.toolContext.originalChars.toLocaleString()} →{' '}
                      {activity.toolContext.retainedChars.toLocaleString()} 字符
                    </span>
                  )}
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function ToolStep({ start, end, running }: { start: RunEvent; end?: RunEvent; running: boolean }) {
  const [open, setOpen] = useState(false),
    [page, setPage] = useState<ToolDetailPage>(),
    [loading, setLoading] = useState(false),
    [error, setError] = useState('');
  const detail = (end?.data.detail || start.data.detail) as ToolDetail | undefined;
  const load = async (offset: number) => {
    if (!detail) return;
    setLoading(true);
    setError('');
    try {
      setPage(
        await api<ToolDetailPage>(`/local/tool-results/${detail.id}?offset=${offset}&limit=2000`),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (open && detail) void load(0);
  }, [open, detail?.id, detail?.sha256]);
  const name = String(start.data.label || toolLabels[String(start.data.name)] || start.data.name);
  const bad = !!end?.data.isError;
  return (
    <div className={`trace-tool ${open ? 'open' : ''}`}>
      <button
        className="trace-tool-toggle"
        aria-expanded={open}
        aria-label={`${name}详情`}
        onClick={() => setOpen(!open)}
      >
        <span className={`trace-tool-icon ${bad ? 'error' : ''}`}>
          {end ? (
            bad ? (
              <X size={13} />
            ) : (
              <Check size={13} />
            )
          ) : running ? (
            <Spinner />
          ) : (
            <Clock3 size={13} />
          )}
        </span>
        <strong>{name}</strong>
        <small>{end ? (bad ? '失败' : '完成') : running ? '执行中' : '结果未确认'}</small>
        <ChevronRight size={13} />
      </button>
      {open && (
        <div className="trace-tool-detail" aria-busy={loading}>
          {detail && <p className="trace-result-summary">{detail.summary}</p>}
          <div className="trace-raw-heading">
            <span>原始输入与输出</span>
            {detail && <span title={detail.sha256}>SHA-256 {detail.sha256.slice(0, 10)}…</span>}
          </div>
          {loading && !page ? (
            <p className="trace-loading">
              <Spinner /> 正在读取详情…
            </p>
          ) : error ? (
            <p role="alert" className="execution-warning">
              {error}
              <button className="text-button" onClick={() => void load(page?.offset || 0)}>
                重试
              </button>
            </p>
          ) : page ? (
            <>
              <pre className="trace-raw">{page.text}</pre>
              <div className="trace-pager">
                <span>
                  {page.offset + 1}–{page.offset + page.text.length} / {page.totalChars} 字符
                </span>
                <button
                  disabled={loading || !page.offset}
                  onClick={() => void load(Math.max(0, page.offset - 2000))}
                >
                  上一段
                </button>
                <button
                  disabled={loading || page.nextOffset === null}
                  onClick={() => void load(page.nextOffset!)}
                >
                  下一段
                </button>
              </div>
            </>
          ) : (
            <pre className="trace-raw">
              {JSON.stringify(start.data.args, null, 2)}
              {!end ? '\n尚未收到执行结果。' : ''}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export function SampleExecution({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <section className={`execution-trace ${open ? 'expanded' : ''}`} aria-label="示例执行记录">
      <button className="execution-toggle" aria-expanded={open} onClick={onToggle}>
        <Clock3 size={14} />
        <span>执行过程</span>
        <small>3 个步骤 · 示例</small>
        <ChevronRight className="execution-chevron" size={15} />
      </button>
      {open && (
        <div className="execution-body sample-execution">
          {[
            ['阅读项目设计文档', '项目背景与目标'],
            ['参考关卡设计技能', '空间、动线与教学'],
            ['整理关卡草案', '初步设计示例'],
          ].map(([name, description]) => (
            <div key={name}>
              <Check size={14} />
              <span>{name}</span>
              <small>{description}</small>
            </div>
          ))}
          <p className="trace-storage-note">内置流程示例，不是实际工具执行记录。</p>
        </div>
      )}
    </section>
  );
}

// V0.1 demo replies embedded raw JSON in their answer. Keep the saved original intact,
// while displaying a concise result; the original tool payload remains in the trace.
export function visibleAnswer(text: string, mode: string) {
  if (mode !== 'demo' || !text.startsWith('### 项目上下文已就绪') || !text.includes('```json'))
    return text;
  const context =
    text.match(
      /已(?:载入|选择)技能：[\s\S]*?(?=本次为静态检查|这是演示(?: provider|模式)|$)/,
    )?.[0] ||
    text.match(/已引用资料：[\s\S]*?(?=本次为静态检查|这是演示(?: provider|模式)|$)/)?.[0] ||
    '';
  return `### 项目上下文已就绪\n\n已完成项目目录与引擎配置检查，详细结果保存在上方执行记录中。\n\n${context}本次为静态检查，尚未执行游戏引擎。`;
}
