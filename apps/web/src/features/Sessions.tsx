import { useState, useEffect, useRef, useCallback } from 'react';
import {
  History,
  Plus,
  MessageSquare,
  MoreHorizontal,
  Pin,
  GitBranch,
  Archive,
  Search,
} from 'lucide-react';
import type { SessionPage, SessionSummary } from '../../../../packages/shared/types';
import { useWorkspace } from '../context';
import { api } from '../api';
import { PageHeading, SearchBox, Empty, Spinner, Status, formatTime } from '../components/UI';
import { ManageSessionDialog } from './SessionActions';

const statusLabels: Record<string, string> = {
  running: '运行中',
  completed: '已完成',
  failed: '执行失败',
  cancelled: '已停止',
  interrupted: '曾中断',
  idle: '未运行',
};
export function Sessions() {
  const w = useWorkspace(),
    [state, setState] = useState<'active' | 'archived'>('active'),
    [query, setQuery] = useState(''),
    [search, setSearch] = useState(''),
    [projectId, setProjectId] = useState('');
  const [items, setItems] = useState<SessionSummary[]>([]),
    [total, setTotal] = useState(0),
    [cursor, setCursor] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [more, setMore] = useState(false),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0),
    [managed, setManaged] = useState<SessionSummary>();
  const generation = useRef(0),
    pending = useRef(false),
    close = useCallback(() => setManaged(undefined), []);
  const reload = useCallback(async () => {
    setRevision((value) => value + 1);
  }, []);
  useEffect(() => {
    const timeout = setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(timeout);
  }, [query]);
  const params = new URLSearchParams({
    state,
    query: search,
    limit: '25',
    ...(projectId ? { projectId } : {}),
  }).toString();
  useEffect(() => {
    const current = ++generation.current,
      controller = new AbortController();
    setLoading(true);
    setError('');
    setItems([]);
    setCursor(null);
    setMore(false);
    pending.current = false;
    void api<SessionPage>(`/local/sessions?${params}`, { signal: controller.signal })
      .then((value) => {
        if (current === generation.current && !controller.signal.aborted) {
          setItems(value.items);
          setTotal(value.total);
          setCursor(value.nextCursor);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted && current === generation.current) setError(e.message);
      })
      .finally(() => {
        if (current === generation.current && !controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [params, revision]);
  async function loadMore() {
    if (!cursor || pending.current) return;
    pending.current = true;
    setMore(true);
    const current = generation.current;
    try {
      const value = await api<SessionPage>(
        `/local/sessions?${params}&cursor=${encodeURIComponent(cursor)}`,
      );
      if (current === generation.current) {
        setItems((previous) => [
          ...new Map([...previous, ...value.items].map((item) => [item.id, item])).values(),
        ]);
        setCursor(value.nextCursor);
        setTotal(value.total);
      }
    } catch (e) {
      if (current === generation.current) setError((e as Error).message);
    } finally {
      if (current === generation.current) {
        pending.current = false;
        setMore(false);
      }
    }
  }
  return (
    <div className="page-scroll">
      <div className="page-content session-history-page">
        <PageHeading
          title="会话历史"
          description="按项目查找对话，继续、分叉或归档之前的工作。"
          action={
            <button
              className="button primary"
              disabled={w.creatingSession}
              onClick={() => void w.newSession()}
            >
              <Plus size={16} />
              新建会话
            </button>
          }
        />
        <div className="collection-toolbar session-history-toolbar">
          <div className="tabs">
            {(
              [
                ['active', '最近会话'],
                ['archived', '已归档'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                className={state === value ? 'selected' : ''}
                onClick={() => setState(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <SearchBox value={query} onChange={setQuery} placeholder="搜索会话名称或消息…" />
        </div>
        <div className="session-history-filters">
          <label>
            项目
            <select
              aria-label="筛选会话项目"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
            >
              <option value="">全部项目</option>
              {w.local.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.status === 'archived' ? ' · 已归档' : ''}
                </option>
              ))}
            </select>
          </label>
          <span>{loading ? '正在查找…' : `${total} 个会话`}</span>
        </div>
        {error && (
          <div className="session-history-error" role="alert">
            <p>{error}</p>
            <button className="button secondary small-button" onClick={() => void reload()}>
              重新加载
            </button>
          </div>
        )}
        {loading ? (
          <div className="session-history-loading">
            <Spinner />
            读取会话记录…
          </div>
        ) : !items.length && !error ? (
          <Empty
            icon={
              query ? (
                <Search size={26} />
              ) : state === 'archived' ? (
                <Archive size={26} />
              ) : (
                <History size={26} />
              )
            }
            title={
              query
                ? '没有匹配的会话'
                : state === 'archived'
                  ? '还没有归档会话'
                  : '从一段新对话开始'
            }
            description={
              query
                ? '试试其他词，或切换项目和归档筛选。'
                : '会话与执行记录会保存在本机，可随时回来继续。'
            }
          />
        ) : (
          <div className="session-history-list">
            {items.map((item) => {
              const project = w.local.projects.find((p) => p.id === item.projectId);
              return (
                <article className="session-history-row" key={item.id} data-session-id={item.id}>
                  <button
                    className="session-history-open"
                    onClick={() => w.openSession(item.id)}
                    aria-label={`打开会话${item.title}`}
                  >
                    <span className="session-history-icon">
                      <MessageSquare size={21} />
                    </span>
                    <span className="session-history-body">
                      <strong>
                        {item.pinned && <Pin size={13} />}
                        <span>{item.title}</span>
                      </strong>
                      <span className="session-history-preview">
                        {item.preview.replace(/^[#*>\s]+/, '') || '尚无消息'}
                      </span>
                      <span className="session-history-meta">
                        <span>{project?.name || '项目记录'}</span>
                        <span>{item.messageCount} 条消息</span>
                        {item.parentId && (
                          <span>
                            <GitBranch size={11} />
                            会话分支
                          </span>
                        )}
                        <time>{formatTime(item.updatedAt)}</time>
                      </span>
                    </span>
                  </button>
                  <div className="session-history-controls">
                    <Status
                      tone={
                        item.status === 'running'
                          ? 'green'
                          : item.status === 'failed' || item.status === 'interrupted'
                            ? 'orange'
                            : 'neutral'
                      }
                    >
                      {item.archivedAt ? '已归档' : statusLabels[item.status] || item.status}
                    </Status>
                    <button
                      className="icon-button"
                      aria-label={`管理会话${item.title}`}
                      onClick={() => setManaged(item)}
                    >
                      <MoreHorizontal size={19} />
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
        {cursor && (
          <div className="session-history-more">
            <button
              className="button secondary"
              disabled={more || loading}
              onClick={() => void loadMore()}
            >
              {more && <Spinner />}加载更多会话
            </button>
          </div>
        )}
        <p className="collection-footnote">
          归档不会删除项目文件或执行详情。分叉对话历史独立，项目文件保持共享。
        </p>
        {managed && <ManageSessionDialog session={managed} onClose={close} onChanged={reload} />}
      </div>
    </div>
  );
}
