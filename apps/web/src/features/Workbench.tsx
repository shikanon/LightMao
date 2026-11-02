import { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react';
import {
  Cat,
  GitBranch,
  PanelRight,
  ChevronRight,
  Plus,
  ArrowUp,
  Square,
  FileText,
  Lightbulb,
  Folder,
  Box,
  ArrowUpRight,
  X,
  Image,
  Code2,
  Sparkles,
  ChevronDown,
  Paperclip,
  MoreHorizontal,
  ArchiveRestore,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { useWorkspace } from '../context';
import { api, post, watchRun } from '../api';
import { Modal, Spinner, formatTime } from '../components/UI';
import type {
  Run,
  RunEvent,
  Session,
  Mode,
  WorkMode,
  RunActivity,
  AgentPlan,
} from '../../../../packages/shared/types';
import { WorkflowPanel } from './WorkflowPanel';
import { SubagentsPanel } from './SubagentsPanel';
import { MediaJobs } from './MediaJobs';
import { ArtifactTabs, useArtifactTabs } from './ArtifactTabs';
import { MAX_ARTIFACT_TABS, openArtifact, type WorkspaceSection } from './workspace-tabs';
import { useDesktopComposer } from './useDesktopComposer';
import { useConversationViewport } from './useConversationViewport';
import { ConversationAttachments, ComposerShortcutHint } from './ConversationAttachments';
import { MAX_DRAFT_LENGTH } from './desktop-session-state';
import { ReferencePanel } from './ReferencePanel';
import { TracePanel } from './TracePanel';
import {
  ExecutionTrace,
  SampleExecution,
  toolLabels as labels,
  visibleAnswer,
} from './ExecutionTrace';
import { ForkSessionDialog, ManageSessionDialog } from './SessionActions';
const Markdown = memo(ReactMarkdown);
export function Workbench() {
  const w = useWorkspace(),
    s = w.session,
    project = w.local.projects.find((p) => p.id === s?.projectId);
  const workflowSupported = w.local.runtime.workflowModes === true;
  const longGoalsSupported =
    (w.local.runtime as typeof w.local.runtime & { longHorizon?: boolean }).longHorizon === true;
  const goalRoundLimit = longGoalsSupported ? 100 : 10;
  const [mode, setMode] = useState<Mode>(w.cloud.arkConfigured ? 'ark' : 'demo'),
    [workMode, setWorkMode] = useState<WorkMode>('act'),
    [goalRounds, setGoalRounds] = useState(12),
    [goalMinutes, setGoalMinutes] = useState(60),
    [visualMinScore, setVisualMinScore] = useState(70),
    [evidencePolicy, setEvidencePolicy] = useState<'artifact' | 'runtime' | 'playtest'>('runtime'),
    [busy, setBusy] = useState(false),
    [runEvents, setRunEvents] = useState<RunEvent[]>([]),
    [streamText, setStreamText] = useState(''),
    [morePanel, setMorePanel] = useState(false),
    [picker, setPicker] = useState(false),
    [skillIds, setSkillIds] = useState<string[]>([]),
    [assetIds, setAssetIds] = useState<string[]>([]),
    [files, setFiles] = useState<{ name: string; type: string }[]>([]);
  const [activities, setActivities] = useState<Record<string, RunActivity>>({});
  const [location, setLocation] = useState({ projectId: '', path: '.' });
  const directory = location.projectId === project?.id ? location.path : '.';
  const [fileError, setFileError] = useState('');
  const persistentUi =
    (w.local.runtime as typeof w.local.runtime & { uiState?: boolean }).uiState === true;
  const backendId = w.local.runtime.deviceId
    ? `device:${w.local.runtime.deviceId}`
    : window.location.origin;
  const artifactTabs = useArtifactTabs(
    {
      backend: backendId,
      owner: w.cloud.user.id,
      project: project?.id || '',
      session: s?.id || w.activeSessionId,
    },
    persistentUi,
  );
  const preview = artifactTabs.value.panelOpen,
    tab = artifactTabs.value.section;
  const setPreview = (value: boolean) =>
    artifactTabs.update((previous) => ({ ...previous, panelOpen: value }));
  const setTab = (value: WorkspaceSection) => {
    artifactTabs.update((previous) => ({ ...previous, section: value }));
    setMorePanel(false);
  };
  const unavailable =
    project?.status === 'archived' ||
    project?.access === 'revoked' ||
    !!s?.archivedAt ||
    !!w.sessionError;
  const [fork, setFork] = useState<{ messageId?: string }>(),
    [manage, setManage] = useState(false);
  const closeFork = useCallback(() => setFork(undefined), []),
    closeManage = useCallback(() => setManage(false), []);
  const expandedRuns = useMemo(
    () => new Set(artifactTabs.value.expandedRuns),
    [artifactTabs.value.expandedRuns],
  );
  const toggleRun = (id: string) =>
    artifactTabs.update((previous) => {
      const next = new Set(previous.expandedRuns);
      next.has(id) ? next.delete(id) : next.add(id);
      return { ...previous, expandedRuns: [...next].slice(-100) };
    });
  const composer = useRef<HTMLTextAreaElement>(null),
    moreTools = useRef<HTMLDivElement>(null);
  const conversationScope = {
    backendId,
    ownerId: w.cloud.user.id,
    projectId: project?.id || '',
    sessionId: s?.id || w.activeSessionId,
  };
  const input = useDesktopComposer({
    scope: conversationScope,
    composerRef: composer,
    onNewSession: () => w.newSession(),
    onEscape: () => {
      setMorePanel(false);
      setPicker(false);
    },
    disabled: unavailable || w.creatingSession || !s,
    notify: w.notify,
    persistent: persistentUi,
  });
  const { prompt, setPrompt } = input;
  const viewport = useConversationViewport({
    scope: conversationScope,
    composerRef: composer,
    persistent: persistentUi,
    notify: w.notify,
  });
  const closePicker = useCallback(() => setPicker(false), []);
  useEffect(() => {
    if (!morePanel) return;
    const close = (event: PointerEvent) => {
      if (!moreTools.current?.contains(event.target as Node)) setMorePanel(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [morePanel]);
  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 1020px)');
    const adapt = () => {
      if (narrow.matches) setPreview(false);
    };
    narrow.addEventListener('change', adapt);
    return () => narrow.removeEventListener('change', adapt);
  }, [artifactTabs.key, artifactTabs.update]);
  useEffect(() => {
    setWorkMode(s?.workMode || 'act');
  }, [s?.id, s?.workMode]);
  useEffect(() => {
    setGoalRounds(longGoalsSupported ? 12 : 3);
  }, [longGoalsSupported]);
  useEffect(() => {
    setRunEvents([]);
    setStreamText('');
    setMorePanel(false);
    setSkillIds([]);
    setAssetIds([]);
    setActivities({});
    setFork(undefined);
    setManage(false);
  }, [s?.id]);
  useEffect(() => {
    if (s?.id && w.focusMessageId)
      document.getElementById(`message-${w.focusMessageId}`)?.scrollIntoView({ block: 'center' });
  }, [s?.id, w.focusMessageId, s?.messages.length]);
  useEffect(() => {
    if (!s) return;
    const abort = new AbortController();
    void api<RunActivity[]>(`/local/sessions/${s.id}/activity`, { signal: abort.signal })
      .then((runs) => {
        if (!abort.signal.aborted)
          setActivities(Object.fromEntries(runs.map((run) => [run.id, run])));
      })
      .catch(() => {});
    return () => abort.abort();
  }, [s?.id, s?.activeRunId, s?.messages.length]);
  useEffect(() => {
    if (!project) return;
    if (project.status === 'archived' || project.access === 'revoked') {
      setFiles([]);
      setFileError('项目已归档或目录已断开，请在项目管理中恢复。');
      return;
    }
    const abort = new AbortController();
    setFileError('');
    void api<{ name: string; type: string }[]>(
      `/local/projects/${project.id}/files?path=${encodeURIComponent(directory)}`,
      { signal: abort.signal },
    )
      .then((result) => {
        if (!abort.signal.aborted) setFiles(result);
      })
      .catch((error) => {
        if (!abort.signal.aborted) {
          setFiles([]);
          setFileError(error.message);
        }
      });
    return () => abort.abort();
  }, [project?.id, project?.revision, unavailable, directory, s?.status]);
  useEffect(() => {
    if (!s?.activeRunId) {
      setStreamText('');
      return;
    }
    const abort = new AbortController();
    setRunEvents([]);
    setStreamText('');
    void watchRun(
      s.activeRunId,
      (e) => {
        if (e.type !== 'text.delta')
          setRunEvents((old) => (old.some((x) => x.id === e.id) ? old : [...old, e]));
        if (e.type === 'text.started' || e.type === 'progress.message') setStreamText('');
        if (e.type === 'text.delta') setStreamText((old) => old + String(e.data.delta));
        if (e.type === 'run.finished') {
          void w.refresh().catch(() => {});
        }
      },
      abort.signal,
      () => w.notify('运行连接中断，正在恢复执行记录'),
    ).catch((e) => {
      if (!abort.signal.aborted) {
        w.notify('连接已断开，正在恢复运行状态');
        void w.refresh().catch(() => {});
      }
    });
    return () => abort.abort();
  }, [s?.activeRunId, w.refresh, w.notify]);
  useEffect(() => {
    if (!s?.activeRunId) return;
    const timer = setInterval(() => {
      void api<Run>(`/local/runs/${s.activeRunId}`)
        .then((run) => (run.status !== 'running' ? w.refresh() : undefined))
        .catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [s?.activeRunId, w.refresh]);
  useEffect(() => {
    if (!s?.activeRunId && tab === 'activity') {
      const id = s?.messages.at(-1)?.runId;
      if (id)
        void api<RunEvent[]>(`/local/runs/${id}/events`)
          .then(setRunEvents)
          .catch(() => {});
    }
  }, [s?.id, s?.activeRunId, s?.messages.length, tab]);
  const sendPrompt = async (text: string, selectedMode: WorkMode, clear = false) => {
    if (!text.trim() || !s || busy || s.activeRunId || unavailable || w.creatingSession) return;
    if (!input.canSend) {
      w.notify('请等待附件处理完成，或移除未完成的附件后发送。');
      return;
    }
    const selectedAssets = [...new Set([...assetIds, ...input.assetIds])];
    if (selectedAssets.length > 8) {
      w.notify('一条消息最多引用8份资料，请减少已选资料后发送。');
      return;
    }
    if (selectedMode !== 'act' && !workflowSupported) {
      w.notify('当前本地 Agent 不支持 Plan / Goal，请先升级后再发送；此次指令未执行。');
      return;
    }
    setBusy(true);
    const clearSent = input.prepareSend();
    await w.perform(async () => {
      await post<Run>(`/local/sessions/${s.id}/runs`, {
        prompt: text,
        mode,
        workMode: selectedMode,
        skillIds,
        assetIds: selectedAssets,
        ...(input.referenceIds.length ? { referenceIds: input.referenceIds } : {}),
        ...(selectedMode === 'goal'
          ? {
              goalOptions: {
                maxRounds: Math.min(goalRoundLimit, goalRounds),
                ...(longGoalsSupported ? { maxMinutes: goalMinutes } : {}),
                evidencePolicy,
                ...(w.local.runtime.referenceMedia ? { visualMinScore } : {}),
              },
            }
          : {}),
      });
      if (clear) clearSent();
      await w.refresh();
    });
    setBusy(false);
  };
  const send = () => sendPrompt(prompt, workMode, true);
  const executePlan = async (plan: AgentPlan) => {
    await post(`/local/sessions/${s!.id}/plan/approve`, { revision: plan.revision });
    setWorkMode('act');
    await sendPrompt(
      '按刚才已确认的实施计划开始实现，自动选择需要的技能和能力，实际运行验证并修复未通过项。',
      'act',
    );
  };
  const openFile = (name: string) => {
    if (!project) return;
    if (artifactTabs.restoring) {
      w.notify('正在恢复这个会话的工作区，请稍后打开文件。');
      return;
    }
    if (
      artifactTabs.value.tabs.length >= MAX_ARTIFACT_TABS &&
      !artifactTabs.value.tabs.some((item) => item.path === name)
    ) {
      w.notify('最多同时打开8个产物，请先关闭一个标签。');
      return;
    }
    artifactTabs.update((previous) => ({
      ...openArtifact(previous, name),
      section: 'preview',
      panelOpen: true,
    }));
  };
  const roundNumbers = new Map(
    (s?.messages || [])
      .filter((message) => message.role === 'assistant')
      .map((message, index) => [message.id, index + 1]),
  );
  if (!s)
    return (
      <div className="loading-screen">
        {w.sessionLoading ? <Spinner /> : <Folder size={32} />}
        <h2>
          {w.sessionLoading
            ? '正在恢复会话…'
            : w.sessionError
              ? '会话暂时无法载入'
              : '从一个项目开始'}
        </h2>
        <p>{w.sessionError || (w.sessionLoading ? '正在读取已保存的消息与执行状态。' : '')}</p>
        {w.sessionError && (
          <button className="button secondary" onClick={() => void w.perform(w.refresh)}>
            重新加载
          </button>
        )}
        <button className="button secondary" onClick={() => w.setPage('projects')}>
          选择或创建项目
        </button>
      </div>
    );
  const isSample = s.messages.some((m) => m.sample);
  return (
    <div className={`workbench ${preview ? 'with-preview' : ''}`} {...input.dropProps}>
      <section className="conversation">
        <header className="conversation-header">
          <div className="breadcrumb">
            <Folder size={16} />
            <span>{project?.name}</span>
            <ChevronRight size={13} />
            <strong>{s.title}</strong>
          </div>
          <div>
            {project?.access === 'read' && <span className="mode-label">只读项目</span>}
            <button
              className="icon-button"
              title="管理项目"
              aria-label="管理当前项目"
              onClick={() => w.setPage('projects')}
            >
              <Folder size={17} />
            </button>
            <button
              className="icon-button"
              title="从选定轮次分叉"
              aria-label="分叉会话"
              disabled={!s.messages.some((message) => message.role === 'assistant')}
              onClick={() => setFork({})}
            >
              <GitBranch size={17} />
            </button>
            <button
              className="icon-button"
              aria-label="会话操作"
              title="重命名、置顶与归档"
              onClick={() => setManage(true)}
            >
              <MoreHorizontal size={18} />
            </button>
            <button
              className="icon-button"
              title="切换预览"
              aria-label="切换预览面板"
              onClick={() => setPreview(!preview)}
            >
              <PanelRight size={18} />
            </button>
          </div>
        </header>
        <div className="messages" key={s.id} ref={viewport.scrollRef} onScroll={viewport.onScroll}>
          {w.sessionError && (
            <div className="session-history-error" role="alert">
              <p>{w.sessionError}</p>
              <button
                className="button secondary small-button"
                onClick={() => void w.perform(w.refresh)}
              >
                重新加载会话
              </button>
            </div>
          )}
          {s.parentId && (
            <div className="branch-note">
              <GitBranch size={14} />
              <span>
                从「{s.forkSourceTitle || '已有会话'}」分叉 · 对话独立，项目文件共享
                {s.forkContext === 'reconstructed' ? ' · 旧版上下文已恢复' : ''}
              </span>
              <button
                className="text-button"
                onClick={() => w.openSession(s.parentId!, s.forkPoint)}
              >
                查看来源轮次
              </button>
            </div>
          )}
          {s.archivedAt && (
            <div className="session-archive-note">
              <span>此会话已归档，消息与执行详情仍可查看。</span>
              <button
                className="button secondary small-button"
                onClick={() =>
                  void w.perform(async () => {
                    await api(`/local/sessions/${s.id}`, {
                      method: 'PATCH',
                      body: JSON.stringify({ archived: false }),
                    });
                    await w.refresh();
                  }, '会话已恢复')
                }
              >
                <ArchiveRestore size={14} />
                恢复会话
              </button>
            </div>
          )}
          {s.messages.length === 0 ? (
            <div className="welcome">
              <div className="welcome-mark">
                <Cat size={38} strokeWidth={1.2} />
              </div>
              <h1>从一个想法，开始创造。</h1>
              <p>
                设计一个关卡，完善一段代码，
                <br />
                或给你的下一个世界一点灵感。
              </p>
              <div className="suggestions">
                {[
                  { icon: Code2, text: '检查当前项目的目录和引擎配置' },
                  { icon: Lightbulb, text: '帮我设计一个循序渐进的新手关卡' },
                  { icon: Image, text: '整理这个项目的素材命名规范' },
                ].map(({ icon: Icon, text }) => (
                  <button
                    key={text}
                    onClick={() => {
                      setPrompt(text);
                      composer.current?.focus();
                    }}
                  >
                    <Icon size={17} />
                    {text}
                    <ArrowUpRight size={14} />
                  </button>
                ))}
              </div>
            </div>
          ) : (
            s.messages.map((m, i) => (
              <div
                key={m.id}
                id={`message-${m.id}`}
                className={`message ${m.role}${w.focusMessageId === m.id ? ' focused-message' : ''}`}
              >
                {m.role === 'user' ? (
                  <>
                    <div className="user-bubble">{m.text}</div>
                    {m.assetIds?.length ? (
                      <span className="message-meta">
                        <Paperclip size={12} />
                        {m.assetIds.length} 份引用资料
                      </span>
                    ) : null}
                    {m.referenceIds?.length ? (
                      <button
                        className="message-meta text-button"
                        onClick={() => {
                          setTab('reference');
                          setPreview(true);
                        }}
                      >
                        <Paperclip size={12} />
                        {m.referenceIds.length} 份参考资料
                      </button>
                    ) : null}
                  </>
                ) : (
                  <>
                    <div className="agent-heading">
                      <span className="agent-avatar">
                        <Cat size={20} strokeWidth={1.5} />
                      </span>
                      <strong>LightMao</strong>
                      <span className="mode-label">
                        {m.sample ? '示例会话' : m.mode === 'demo' ? '演示' : 'Agent'}
                      </span>
                      {m.runId &&
                        activities[m.runId]?.workMode &&
                        activities[m.runId].workMode !== 'act' && (
                          <span className="mode-label">
                            {activities[m.runId].workMode === 'plan' ? 'Plan' : 'Goal'}
                          </span>
                        )}
                      <time>{formatTime(m.at)}</time>
                    </div>
                    <div className="assistant-body">
                      {m.sample ? (
                        <SampleExecution
                          open={expandedRuns.has(m.id)}
                          onToggle={() => toggleRun(m.id)}
                        />
                      ) : (
                        m.runId && (
                          <ExecutionTrace
                            runId={m.runId}
                            activity={activities[m.runId]}
                            open={expandedRuns.has(m.runId)}
                            onToggle={() => toggleRun(m.runId!)}
                          />
                        )
                      )}
                      <Markdown>{visibleAnswer(m.text, m.mode)}</Markdown>
                      <div className="message-actions">
                        <button
                          className="text-button"
                          aria-label={`从第 ${roundNumbers.get(m.id)} 轮回答分叉`}
                          onClick={() => setFork({ messageId: m.id })}
                        >
                          <GitBranch size={13} />
                          从此处分叉
                        </button>
                      </div>
                      {m.sample && (
                        <>
                          <button className="document-link" onClick={() => openFile('关卡设计.md')}>
                            <span>
                              <FileText size={23} />
                            </span>
                            <div>
                              <strong>森林入口 · 关卡设计.md</strong>
                              <small>Markdown · 设计草案</small>
                            </div>
                            <ArrowUpRight size={17} />
                          </button>
                          <p className="sample-intro">第一关「森林入口」的核心思路：</p>
                          <div className="numbered-ideas">
                            {[
                              [
                                '用萤火引导移动',
                                '通过发光的萤虫和柔和的光线，让玩家在自然的节奏中前进。',
                              ],
                              [
                                '在岔路发现第一枚星露',
                                '在小径的岔口留下一个被植物环绕的清晰目标，鼓励第一次探索。',
                              ],
                              [
                                '与树下的守林人交互',
                                '一段简短的对话，介绍这个世界，也为下一次发现留下线索。',
                              ],
                            ].map(([a, b], i) => (
                              <div key={a}>
                                <span>{i + 1}</span>
                                <div>
                                  <strong>{a}</strong>
                                  <p>{b}</p>
                                </div>
                              </div>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  </>
                )}
              </div>
            ))
          )}
          {s.activeRunId && (
            <div className="message assistant">
              <div className="agent-heading">
                <span className="agent-avatar">
                  <Cat size={20} />
                </span>
                <strong>LightMao</strong>
                <span className="mode-label">{mode === 'demo' ? '演示' : '执行中'}</span>
              </div>
              <div className="assistant-body">
                <ExecutionTrace
                  runId={s.activeRunId}
                  activity={activities[s.activeRunId]}
                  open={expandedRuns.has(s.activeRunId)}
                  onToggle={() => toggleRun(s.activeRunId!)}
                  liveEvents={runEvents}
                  liveText={streamText}
                />
              </div>
            </div>
          )}
          {['failed', 'interrupted', 'cancelled'].includes(s.status) && (
            <div className="run-notice">
              {s.status === 'failed'
                ? '本轮未成功完成，请检查上方错误后重试。'
                : s.status === 'interrupted'
                  ? '上次运行被中断。已保留历史，发送消息可从保存的上下文继续。'
                  : '本轮已停止，已完成的步骤与消息仍保留。'}
            </div>
          )}
          <div />
        </div>
        {!viewport.following && (
          <button className="jump-latest text-button" onClick={viewport.scrollToLatest}>
            <ChevronDown size={13} />
            回到最新消息
          </button>
        )}
        <div className="composer-region">
          {w.local.runtime.subAgents && !(preview && tab === 'collaboration') && (
            <SubagentsPanel
              key={`subagents-${s.id}`}
              sessionId={s.id}
              projectId={s.projectId}
              activeRunId={s.activeRunId}
              messageCount={s.messages.length}
              compact
              onOpen={() => {
                setTab('collaboration');
                setPreview(true);
              }}
            />
          )}
          {workflowSupported && (
            <WorkflowPanel
              key={s.id}
              sessionId={s.id}
              activeRunId={s.activeRunId}
              messageCount={s.messages.length}
              onExecute={executePlan}
            />
          )}
          {workMode === 'goal' && (
            <details className="goal-options-panel">
              <summary>
                目标设置 · {goalRounds} 轮{longGoalsSupported ? ` · ${goalMinutes} 分钟` : ''}
              </summary>
              <div className="goal-options">
                <label>
                  轮数预算{' '}
                  <input
                    aria-label="目标轮数预算"
                    type="number"
                    min="1"
                    max={goalRoundLimit}
                    value={goalRounds}
                    onChange={(e) =>
                      setGoalRounds(
                        Math.max(1, Math.min(goalRoundLimit, Number(e.target.value) || 1)),
                      )
                    }
                    disabled={!!s.activeRunId}
                  />
                </label>
                {longGoalsSupported && (
                  <label>
                    时间预算{' '}
                    <input
                      aria-label="目标时间预算（分钟）"
                      type="number"
                      min="1"
                      max="1440"
                      value={goalMinutes}
                      onChange={(event) =>
                        setGoalMinutes(Math.max(1, Math.min(1440, Number(event.target.value) || 1)))
                      }
                      disabled={!!s.activeRunId}
                    />{' '}
                    分钟
                  </label>
                )}
                <label>
                  完成依据{' '}
                  <select
                    aria-label="目标验收方式"
                    value={evidencePolicy}
                    onChange={(e) => setEvidencePolicy(e.target.value as typeof evidencePolicy)}
                    disabled={!!s.activeRunId}
                  >
                    <option value="artifact">文件产物</option>
                    <option value="runtime">实际运行</option>
                    <option value="playtest">自动试玩</option>
                  </select>
                </label>
                <span>按目标持续推进；预算到达时保留进度</span>
                {w.local.runtime.referenceMedia && evidencePolicy === 'playtest' && (
                  <label>
                    参考作品视觉门槛{' '}
                    <input
                      aria-label="参考作品视觉最低分"
                      type="number"
                      min="0"
                      max="100"
                      value={visualMinScore}
                      onChange={(e) =>
                        setVisualMinScore(Math.max(0, Math.min(100, Number(e.target.value) || 0)))
                      }
                      disabled={!!s.activeRunId}
                    />
                  </label>
                )}
              </div>
            </details>
          )}
          {(skillIds.length > 0 || assetIds.length > 0) && (
            <div className="context-chips">
              {skillIds.map((id) => (
                <button key={id} onClick={() => setSkillIds((old) => old.filter((x) => x !== id))}>
                  <Lightbulb size={12} />
                  {w.skills.find((s) => s.id === id)?.name}
                  <X size={12} />
                </button>
              ))}
              {assetIds.map((id) => (
                <button key={id} onClick={() => setAssetIds((old) => old.filter((x) => x !== id))}>
                  <Paperclip size={12} />
                  {w.cloud.assets.find((a) => a.id === id)?.name}
                  <X size={12} />
                </button>
              ))}
            </div>
          )}
          <div className="composer">
            <ConversationAttachments composer={input} />
            <textarea
              {...input.pasteProps}
              maxLength={MAX_DRAFT_LENGTH}
              ref={composer}
              aria-label="发送消息"
              placeholder={
                w.creatingSession
                  ? '正在创建会话…'
                  : unavailable
                    ? w.sessionError
                      ? '请先重新载入会话'
                      : s.archivedAt
                        ? '此会话已归档，恢复后可继续'
                        : '请先在项目管理中恢复目录授权'
                    : workMode === 'plan'
                      ? '描述目标，先制定计划…'
                      : workMode === 'goal'
                        ? '描述希望持续完成并验收的目标…'
                        : '描述你想创造的世界…'
              }
              disabled={unavailable || w.creatingSession || input.restoring}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={2}
            />
            <div className="composer-toolbar">
              <button
                className="icon-button outlined"
                title="添加技能或资料"
                aria-label="添加技能或资料"
                onClick={() => setPicker(true)}
              >
                <Plus size={19} />
              </button>
              <label className="model-select work-mode-select">
                <select
                  aria-label="工作模式"
                  value={workMode}
                  onChange={(e) => setWorkMode(e.target.value as WorkMode)}
                  disabled={!!s.activeRunId}
                >
                  <option value="act">执行</option>
                  <option value="plan" disabled={!workflowSupported}>
                    Plan · 只读{!workflowSupported ? '（需升级）' : ''}
                  </option>
                  <option value="goal" disabled={!workflowSupported}>
                    Goal · 持续完成{!workflowSupported ? '（需升级）' : ''}
                  </option>
                </select>
                <ChevronDown size={12} />
              </label>
              <label
                className="model-select current-model"
                title={
                  mode === 'ark'
                    ? `当前模型路由：${w.cloud.model.modelId}${w.cloud.model.enabled ? '' : ' · 已停用'}`
                    : '静态演示，不调用真实模型'
                }
              >
                <Box size={14} />
                <select
                  aria-label="模型模式"
                  value={mode}
                  onChange={(e) => setMode(e.target.value as Mode)}
                  disabled={!!s.activeRunId}
                >
                  <option value="demo">演示模式</option>
                  <option value="ark">
                    {w.cloud.model.label || w.cloud.model.modelId}
                    {w.cloud.model.enabled ? '' : ' · 已停用'}
                  </option>
                </select>
                <ChevronDown size={12} />
              </label>
              <span className="workspace-chip" title={project?.name || '本地工作区'}>
                <Folder size={14} />
                {project?.name || '本地工作区'}
              </span>
              {s.activeRunId ? (
                <button
                  className="send-button stop"
                  aria-label="停止运行"
                  onClick={() =>
                    void w.perform(() => post(`/local/runs/${s.activeRunId}/stop`), '正在停止运行')
                  }
                >
                  <Square size={15} fill="currentColor" />
                </button>
              ) : (
                <button
                  className="send-button"
                  aria-label="发送消息"
                  disabled={
                    !prompt.trim() ||
                    busy ||
                    unavailable ||
                    w.creatingSession ||
                    !input.canSend ||
                    input.restoring
                  }
                  onClick={() => void send()}
                >
                  {busy ? <Spinner /> : <ArrowUp size={20} />}
                </button>
              )}
            </div>
          </div>
          <div className="composer-caption">
            <span>
              {workMode === 'plan'
                ? '只调查与规划 · 确认后再执行'
                : 'Enter 发送 · Shift+Enter 换行'}
            </span>
            <ComposerShortcutHint />
          </div>
        </div>
      </section>
      <aside className="preview-panel" hidden={!preview}>
        <header className="preview-tabs">
          {(
            [
              { id: 'preview', label: '预览' },
              { id: 'files', label: '文件' },
              { id: 'reference', label: '参考录屏' },
            ] as const
          )
            .filter((t) => t.id !== 'reference' || w.local.runtime.referenceMedia)
            .map((t) => (
              <button
                className={tab === t.id ? 'active' : ''}
                key={t.id}
                onClick={() => setTab(t.id)}
              >
                {t.label}
                {t.id === 'files' && <small>{files.length}</small>}
              </button>
            ))}
          <div
            className="workspace-more-wrap"
            ref={moreTools}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && morePanel) {
                event.stopPropagation();
                setMorePanel(false);
                moreTools.current?.querySelector('button')?.focus();
              }
            }}
          >
            <button
              className={
                ['activity', 'media', 'trace', 'collaboration'].includes(tab)
                  ? 'active workspace-more-button'
                  : 'workspace-more-button'
              }
              aria-label="更多工作区工具"
              aria-expanded={morePanel}
              onClick={() => setMorePanel((value) => !value)}
            >
              {{ activity: '活动', media: '生成素材', trace: 'Trace', collaboration: '协作' }[
                tab as 'activity' | 'media' | 'trace' | 'collaboration'
              ] || '更多'}
              <ChevronDown size={12} />
            </button>
            {morePanel && (
              <div className="workspace-more-menu" role="group" aria-label="工作区工具">
                {(
                  [
                    { id: 'media', label: '生成素材', enabled: true },
                    {
                      id: 'collaboration',
                      label: '协作任务',
                      enabled: w.local.runtime.subAgents,
                    },
                    { id: 'trace', label: 'Trace', enabled: w.local.runtime.traces },
                    { id: 'activity', label: '活动记录', enabled: true },
                  ] as const
                )
                  .filter((item) => item.enabled)
                  .map((item) => (
                    <button
                      key={item.id}
                      className={tab === item.id ? 'active' : ''}
                      onClick={() => setTab(item.id)}
                    >
                      {item.label}
                    </button>
                  ))}
              </div>
            )}
          </div>
          <button
            className="icon-button close-preview"
            aria-label="关闭预览面板"
            onClick={() => setPreview(false)}
          >
            <X size={16} />
          </button>
        </header>
        {artifactTabs.notice && (
          <div className="layout-sync-notice" role="status">
            <span>{artifactTabs.notice}</span>
            <button className="text-button" onClick={() => void artifactTabs.resync()}>
              保存当前窗口布局
            </button>
          </div>
        )}
        <div
          className={`preview-scroll ${tab === 'preview' && artifactTabs.value.tabs.length ? 'artifact-host' : ''}`}
        >
          {!unavailable && project && artifactTabs.value.tabs.length > 0 && (
            <div className="artifact-keepalive" hidden={tab !== 'preview'}>
              <ArtifactTabs
                key={artifactTabs.key}
                projectId={project.id}
                state={artifactTabs.value}
                update={artifactTabs.update}
                perform={w.perform}
                visible={preview && tab === 'preview'}
              />
            </div>
          )}
          {tab === 'collaboration' && project ? (
            <SubagentsPanel
              key={`collaboration-${s.id}`}
              projectId={project.id}
              sessionId={s.id}
              activeRunId={s.activeRunId}
              messageCount={s.messages.length}
              revealEmpty
            />
          ) : tab === 'reference' && project ? (
            <ReferencePanel
              key={s.id}
              projectId={project.id}
              sessionId={s.id}
              onAttach={(id) => input.attachReference(id)}
            />
          ) : tab === 'trace' ? (
            <TracePanel key={s.id} sessionId={s.id} active={!!s.activeRunId} />
          ) : tab === 'media' ? (
            <MediaJobs key={s.id} sessionId={s.id} active={!!s.activeRunId} />
          ) : tab === 'preview' ? (
            unavailable ? (
              <div className="preview-empty">
                <Folder size={28} />
                <h3>项目预览暂不可用</h3>
                <p>恢复项目授权后，可继续查看已打开的产物。</p>
              </div>
            ) : artifactTabs.value.tabs.length && project ? null : isSample ? (
              <ConceptPreview />
            ) : (
              <div className="preview-empty">
                <FileText size={32} />
                <h3>让想法成为作品</h3>
                <p>打开项目文件后，在标签间切换查看。</p>
                <button className="button secondary" onClick={() => setTab('files')}>
                  浏览项目文件
                </button>
              </div>
            )
          ) : tab === 'files' ? (
            <div className="file-browser">
              <div className="file-browser-heading">
                <Folder size={16} />
                <button
                  onClick={() => project && setLocation({ projectId: project.id, path: '.' })}
                >
                  {project?.name}
                </button>
              </div>
              <div className="project-file-path">
                <span>{directory === '.' ? '项目根目录' : directory}</span>
                <button
                  className="text-button"
                  disabled={directory === '.'}
                  onClick={() =>
                    project &&
                    setLocation({
                      projectId: project.id,
                      path: directory.includes('/')
                        ? directory.slice(0, directory.lastIndexOf('/'))
                        : '.',
                    })
                  }
                >
                  返回上级目录
                </button>
              </div>
              {fileError && (
                <p className="inline-error" role="alert">
                  {fileError}
                </p>
              )}
              {files.map((f) => (
                <button
                  key={f.name}
                  disabled={artifactTabs.restoring}
                  onClick={() => {
                    const path = directory === '.' ? f.name : `${directory}/${f.name}`;
                    if (f.type === 'directory' && project)
                      setLocation({ projectId: project.id, path });
                    else openFile(path);
                  }}
                >
                  {f.type === 'directory' ? <Folder size={17} /> : <FileText size={17} />}
                  <span>{f.name}</span>
                  {f.type === 'file' && <ArrowUpRight size={14} />}
                </button>
              ))}
              <p className="form-hint">可浏览已授权项目的子目录。符号链接与敏感文件不显示。</p>
            </div>
          ) : (
            <div className="activity-panel">
              <h3>本次运行</h3>
              {runEvents.length ? (
                <>
                  {runEvents
                    .filter((e) => e.type !== 'text.delta')
                    .map((e) => (
                      <div className="activity-row" key={e.id}>
                        <i />
                        <div>
                          <strong>
                            {e.type === 'run.started'
                              ? '运行开始'
                              : e.type === 'run.finished'
                                ? `运行结束 · ${String(e.data.status)}`
                                : e.type === 'context.loaded'
                                  ? '项目上下文已载入'
                                  : e.type === 'progress.message'
                                    ? '更新执行进度'
                                    : e.type === 'text.started'
                                      ? '整理本轮回复'
                                      : `${labels[String(e.data.name)] || e.type} · ${e.type === 'tool.finished' ? '已返回' : '开始'}`}
                          </strong>
                          <small>{formatTime(e.at)}</small>
                        </div>
                      </div>
                    ))}
                </>
              ) : (
                <p className="muted">发送消息后，这里会记录真实的工具执行过程。</p>
              )}
            </div>
          )}
        </div>
      </aside>
      {fork && <ForkSessionDialog session={s} messageId={fork.messageId} onClose={closeFork} />}
      {manage && <ManageSessionDialog session={s} onClose={closeManage} />}
      {picker && (
        <Modal
          title="添加上下文"
          description="选中的技能与文本资料会用于下一轮对话。"
          onClose={closePicker}
        >
          <div className="context-picker">
            <button
              className="button secondary"
              onClick={() => {
                closePicker();
                input.openFiles();
              }}
            >
              <Paperclip size={15} />
              上传图片、文件或参考录屏
            </button>
            <h3>
              <Lightbulb size={17} />
              技能
            </h3>
            {w.skills
              .filter((s) => s.enabled)
              .map((s) => (
                <label key={s.id}>
                  <input
                    type="checkbox"
                    checked={skillIds.includes(s.id)}
                    onChange={(e) =>
                      setSkillIds((old) =>
                        e.target.checked ? [...old, s.id] : old.filter((id) => id !== s.id),
                      )
                    }
                  />
                  <span>
                    <strong>{s.name}</strong>
                    <small>{s.description}</small>
                  </span>
                </label>
              ))}
            <h3>
              <Paperclip size={17} />
              资料空间
            </h3>
            {w.cloud.assets.map((a) => (
              <label key={a.id}>
                <input
                  type="checkbox"
                  checked={assetIds.includes(a.id)}
                  onChange={(e) =>
                    setAssetIds((old) =>
                      e.target.checked ? [...old, a.id] : old.filter((id) => id !== a.id),
                    )
                  }
                />
                <span>{a.name}</span>
              </label>
            ))}
          </div>
          <footer>
            <button className="button primary" onClick={closePicker}>
              完成选择
            </button>
          </footer>
        </Modal>
      )}
    </div>
  );
}
function ConceptPreview() {
  return (
    <article className="preview-document">
      <div className="preview-doc-heading">
        <span className="doc-overline">关卡设计 / 01</span>
        <h1>森林入口</h1>
        <p>星露秘境 · 从微光开始的旅程</p>
      </div>
      <div className="concept-image">
        <img src="/assets/forest.png" alt="森林关卡概念图：微光、林间小径和一位小旅人" />
        <span>关卡氛围参考</span>
      </div>
      <section className="concept-description">
        <h2>一次不被打断的探索</h2>
        <p>
          从一条林间小径开始，在微光与植物的陪伴下，
          <br className="large-only" />
          玩家将在探索中自然学会移动、收集与交互。
        </p>
        <div className="level-specs">
          <div>
            <span>体验时长</span>
            <strong>5–8 分钟</strong>
          </div>
          <div>
            <span>核心玩法</span>
            <strong>探索 · 收集</strong>
          </div>
          <div>
            <span>情绪曲线</span>
            <strong>好奇 → 发现</strong>
          </div>
        </div>
      </section>
      <section className="level-flow">
        <h2>关卡节奏</h2>
        {[
          ['初入森林', '沿着林间小径前进，跟随萤火熟悉移动，感受森林的气息。'],
          ['岔路与星露', '发现被植物环绕的发光点，收集第一枚星露，获得及时反馈。'],
          ['遇见守林人', '在大树下开启第一次对话，为接下来的探索留下一个目标。'],
        ].map(([a, b], i) => (
          <div key={a}>
            <span>{i + 1}</span>
            <div>
              <h3>{a}</h3>
              <p>{b}</p>
            </div>
          </div>
        ))}
      </section>
      <div className="document-footer">
        <Sparkles size={13} />
        内置设计示例 · 尚未在引擎中验证
      </div>
    </article>
  );
}
