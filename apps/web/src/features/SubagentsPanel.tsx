import { useEffect, useState } from 'react';
import { Users, ShieldCheck, X, Image as ImageIcon, FileText } from 'lucide-react';
import type { CollaborationView, SubAgentTask } from '../../../../packages/shared/collaboration';
import { api, post, authenticatedFetch } from '../api';

const labels: Record<SubAgentTask['status'], string> = {
  queued: '等待开始',
  running: '独立执行中',
  reported: '已汇报 · 待主 Agent 核验',
  verified: '文件版本已核对',
  merged: '已合并 · 待主工程验收',
  stale: '旧副本 · 合并被拒绝',
  contradicted: '实时证据未通过',
  cancelled: '已撤销并回收租约',
  interrupted: '已中断 · 需核对',
};
export function SubagentsPanel({
  sessionId,
  projectId,
  activeRunId,
  messageCount,
  revealEmpty = false,
  compact = false,
  onOpen,
}: {
  sessionId: string;
  projectId: string;
  activeRunId?: string;
  messageCount: number;
  revealEmpty?: boolean;
  compact?: boolean;
  onOpen?: () => void;
}) {
  const [view, setView] = useState<CollaborationView>();
  const [error, setError] = useState(''),
    [version, setVersion] = useState(0),
    [busy, setBusy] = useState(false);
  const [log, setLog] = useState<{ taskId: string; text: string; nextOffset: number | null }>();
  const [image, setImage] = useState<{ url: string; caption: string }>();
  const [name, setName] = useState('服务监控'),
    [pageUrl, setPageUrl] = useState(''),
    [healthUrl, setHealthUrl] = useState('');
  const [field, setField] = useState('healthy'),
    [expected, setExpected] = useState('true');
  const [protectedPaths, setProtectedPaths] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await api<CollaborationView>(`/local/sessions/${sessionId}/collaboration`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setView(next);
        if (activeRunId || next.tasks.some((t) => ['queued', 'running'].includes(t.status)))
          timer = setTimeout(() => void refresh(), 1800);
      } catch (e) {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : '协作状态暂不可用');
      }
    };
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [sessionId, activeRunId, messageCount, version]);
  useEffect(
    () => () => {
      if (image) URL.revokeObjectURL(image.url);
    },
    [image],
  );
  const act = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      setError('');
      setVersion((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };
  const tasks = view?.tasks || [],
    waiting = tasks.filter((t) => ['reported', 'stale', 'contradicted'].includes(t.status)).length;
  const running = tasks.filter((task) => ['queued', 'running'].includes(task.status)).length;
  if (
    !revealEmpty &&
    !error &&
    !tasks.some((task) =>
      ['queued', 'running', 'reported', 'stale', 'contradicted', 'interrupted'].includes(
        task.status,
      ),
    )
  )
    return null;
  if (compact)
    return (
      <button
        className="collaboration-status text-button"
        aria-label="查看协作任务"
        onClick={onOpen}
      >
        <Users size={13} />
        {running
          ? `${running} 个协作任务进行中`
          : waiting
            ? `${waiting} 个协作结果待核验`
            : error
              ? '协作状态暂不可用'
              : '协作任务需要关注'}
        <span aria-hidden="true">›</span>
      </button>
    );
  return (
    <details className="subagents-panel" aria-label="Sub-Agent 协作">
      <summary>
        <Users size={15} />
        <strong>Sub-Agent 协作</strong>
        <span aria-live="polite">
          {tasks.length
            ? `${tasks.filter((t) => ['queued', 'running'].includes(t.status)).length} 进行中${waiting ? ` · ${waiting} 待核验` : ''}`
            : '独立任务 · 实时核验'}
        </span>
      </summary>
      <div className="subagents-content">
        <p className="muted">
          主 Agent 自动分派角色，每个任务 3–4 轮、每窗口最多 4
          项。子任务在独立副本工作，汇报经当前文件与实时证据核对后合并。
        </p>
        {error && (
          <p role="alert" className="workflow-error">
            {error}
          </p>
        )}
        {view?.plan && (
          <div className="subagent-plan">
            <strong>
              窗口 {view.plan.window} · {view.plan.objective}
            </strong>
            <p>
              {view.plan.roles
                .map(
                  (r) =>
                    `${r.name}（${r.kind === 'implementer' ? '实现' : r.kind === 'reviewer' ? '审阅' : '测试'}）`,
                )
                .join(' / ')}
            </p>
          </div>
        )}
        {tasks.map((task) => (
          <article key={task.id} className={`subagent-task subagent-${task.status}`}>
            <div>
              <strong>{task.role.name}</strong>
              <span>{labels[task.status]}</span>
              <small>
                {task.turns} / {task.maxTurns} 轮
              </small>
              {[
                'queued',
                'running',
                'reported',
                'stale',
                'contradicted',
                'interrupted',
                'verified',
              ].includes(task.status) && (
                <button
                  className="icon-button"
                  aria-label={`撤销子任务 ${task.role.name}`}
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await post(`/local/projects/${projectId}/subagents/${task.id}/cancel`, {});
                    })
                  }
                >
                  <X size={14} />
                </button>
              )}
            </div>
            <p>{task.objective}</p>
            <details>
              <summary>查看汇报与变更 · {task.changes.length} 文件</summary>
              <blockquote>{task.summary}</blockquote>
              <small>文字汇报待核实；文件版本核对不代表运行或上线验收。</small>
              {!!task.writePaths.length && (
                <p className="muted">写入范围：{task.writePaths.join('、')}</p>
              )}
              {task.changes.map((c) => (
                <code key={c.path}>
                  {c.path} · {c.before?.slice(0, 8) || '新文件'} → {c.after.slice(0, 8)}
                </code>
              ))}
              <button
                className="text-button"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const page = await api<{ text: string; nextOffset: number | null }>(
                      `/local/projects/${projectId}/subagents/${task.id}/log`,
                    );
                    setLog({ taskId: task.id, ...page });
                  })
                }
              >
                <FileText size={13} />
                回读独立执行记录
              </button>
            </details>
          </article>
        ))}
        {log && (
          <div className="subagent-log">
            <pre>{log.text}</pre>
            <button className="text-button" onClick={() => setLog(undefined)}>
              收起原始记录
            </button>
            {log.nextOffset !== null && (
              <button
                className="text-button"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const page = await api<{ text: string; nextOffset: number | null }>(
                      `/local/projects/${projectId}/subagents/${log.taskId}/log?offset=${log.nextOffset}`,
                    );
                    setLog({ taskId: log.taskId, ...page });
                  })
                }
              >
                下一页
              </button>
            )}
          </div>
        )}
        {!!view?.leases.length && (
          <p className="muted">
            当前租约：{view.leases.map((l) => `${l.path} · #${l.token}`).join('；')}
          </p>
        )}
        {!!view?.evidence.length && (
          <details className="ground-truth-list">
            <summary>
              <ShieldCheck size={14} />
              独立采集的实时证据 · {view.evidence.length}
            </summary>
            {view.evidence
              .toReversed()
              .slice(0, 5)
              .map((e) => (
                <div key={e.id}>
                  <strong className={e.healthy ? '' : 'workflow-error'}>
                    {e.healthy ? '健康检查通过' : '健康检查失败 · 禁止关键合并'}
                  </strong>
                  <small>
                    {new Date(e.capturedAt).toLocaleString()} ·{' '}
                    {Date.parse(e.expiresAt) <= Date.now() ? '已过期' : '采集时有效'}
                  </small>
                  <p>
                    {e.checks
                      .map((c) => `${c.passed ? '✓' : '×'} ${c.name}: ${c.actual}`)
                      .join('；')}
                  </p>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        const response = await authenticatedFetch(
                          `/local/projects/${projectId}/ground-truth/${e.id}/screenshot`,
                        );
                        if (!response.ok) throw Error('截图读取失败');
                        setImage({
                          url: URL.createObjectURL(await response.blob()),
                          caption: `实时监控 · ${new Date(e.capturedAt).toLocaleString()} · SHA ${e.screenshotSha256.slice(0, 12)}`,
                        });
                      })
                    }
                  >
                    <ImageIcon size={13} />
                    查看真实截图
                  </button>
                </div>
              ))}
          </details>
        )}
        {image && (
          <figure className="ground-truth-image">
            <img src={image.url} alt="主 Agent 独立采集的监控截图" />
            <figcaption>{image.caption}</figcaption>
            <button className="text-button" onClick={() => setImage(undefined)}>
              收起截图
            </button>
          </figure>
        )}
        <details className="monitor-settings">
          <summary>项目监控源 · {view?.sources.length || 0}</summary>
          <p className="muted">
            配置后主 Agent
            可重新打开页面并独立检查健康接口。只使用项目授权的同源地址；不共享个人浏览器登录态。
          </p>
          {view?.sources.map((source) => (
            <p key={source.id}>
              {source.name} · {source.pageUrl}
              <button
                className="text-button"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await api(`/local/projects/${projectId}/monitor-sources/${source.id}`, {
                      method: 'DELETE',
                    });
                  })
                }
              >
                移除
              </button>
            </p>
          ))}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                let value: string | number | boolean;
                try {
                  value = JSON.parse(expected);
                } catch {
                  value = expected;
                }
                if (!['string', 'number', 'boolean'].includes(typeof value))
                  throw Error('期望值须是布尔、数字或文本');
                await post(`/local/projects/${projectId}/monitor-sources`, {
                  name,
                  pageUrl,
                  healthUrl,
                  checks: [{ path: field, op: 'equals', value }],
                  maxAgeSeconds: 30,
                  protectedPaths: protectedPaths
                    .split(/[,，\n]/)
                    .map((v) => v.trim())
                    .filter(Boolean),
                });
                setPageUrl('');
                setHealthUrl('');
              });
            }}
          >
            <label>
              监控名称
              <input
                className="input"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              监控页面
              <input
                className="input"
                type="url"
                required
                value={pageUrl}
                placeholder="https://monitor.example.com/status"
                onChange={(e) => setPageUrl(e.target.value)}
              />
            </label>
            <label>
              同源健康接口
              <input
                className="input"
                type="url"
                required
                value={healthUrl}
                placeholder="https://monitor.example.com/health"
                onChange={(e) => setHealthUrl(e.target.value)}
              />
            </label>
            <label>
              受保护的配置路径（可选，逗号分隔）
              <input
                className="input"
                value={protectedPaths}
                placeholder="config/release.json, deploy/"
                onChange={(e) => setProtectedPaths(e.target.value)}
              />
            </label>
            <div className="monitor-rule">
              <label>
                JSON 校验字段
                <input
                  className="input"
                  required
                  value={field}
                  onChange={(e) => setField(e.target.value)}
                />
              </label>
              <label>
                等于
                <input
                  className="input"
                  required
                  value={expected}
                  onChange={(e) => setExpected(e.target.value)}
                />
              </label>
            </div>
            <button className="secondary-button" disabled={busy}>
              保存监控源
            </button>
          </form>
        </details>
      </div>
    </details>
  );
}
