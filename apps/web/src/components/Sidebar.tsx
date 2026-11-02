import { useState, useCallback, useRef, useEffect } from 'react';
import {
  House,
  Puzzle,
  Lightbulb,
  Cloud,
  Clock3,
  Plus,
  Settings,
  ChevronDown,
  ChevronRight,
  Folder,
  PanelLeftClose,
  ShieldCheck,
  LogOut,
  History,
  Pin,
  Gamepad2,
  Shapes,
} from 'lucide-react';
import { Logo, Spinner } from './UI';
import { useWorkspace, type Page } from '../context';
import { ProjectEditor } from '../features/Projects';
import { desktopShortcutLabels, useDesktopShortcuts } from '../features/useDesktopShortcuts';
const nav: { id: Page; label: string; icon: typeof House }[] = [
  { id: 'workspace', label: '工作台', icon: House },
  { id: 'sessions', label: '历史会话', icon: History },
];
const tools: { id: Page; label: string; icon: typeof House }[] = [
  { id: 'engines', label: '运行与验证', icon: Gamepad2 },
  { id: 'plugins', label: '插件', icon: Puzzle },
  { id: 'skills', label: '技能', icon: Lightbulb },
  { id: 'assets', label: '资料空间', icon: Cloud },
  { id: 'schedules', label: '定时任务', icon: Clock3 },
];
export function Sidebar({ close }: { close: () => void }) {
  const w = useWorkspace(),
    [modal, setModal] = useState(false),
    [collapsed, setCollapsed] = useState<string[]>([]),
    [account, setAccount] = useState(false),
    [toolsOpen, setToolsOpen] = useState(false);
  const toolsButton = useRef<HTMLButtonElement>(null),
    toolsRoot = useRef<HTMLDivElement>(null),
    currentTool = tools.find((item) => item.id === w.page);
  useEffect(() => {
    if (!toolsOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (!toolsRoot.current?.contains(event.target as Node)) setToolsOpen(false);
    };
    window.addEventListener('pointerdown', dismiss);
    return () => window.removeEventListener('pointerdown', dismiss);
  }, [toolsOpen]);
  const closeModal = useCallback(() => setModal(false), []);
  useDesktopShortcuts({
    onFocusComposer: () => {
      setToolsOpen(false);
      setAccount(false);
      w.setPage('workspace');
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLTextAreaElement>('textarea[aria-label="发送消息"]')
          ?.focus({ preventScroll: true }),
      );
    },
    onNewSession: () => w.newSession(),
    onEscape: () => {
      setToolsOpen(false);
      setAccount(false);
    },
    disabled: w.creatingSession,
  });
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <Logo />
        <button className="icon-button mobile-only" aria-label="收起导航" onClick={close}>
          <PanelLeftClose size={18} />
        </button>
      </div>
      <button
        className="new-chat"
        aria-label="新建会话"
        disabled={w.creatingSession}
        onClick={() => void w.newSession()}
      >
        {w.creatingSession ? <Spinner /> : <Plus size={18} />}
        新建会话<span aria-hidden="true">{desktopShortcutLabels().newSession}</span>
      </button>
      <nav aria-label="主导航">
        {nav.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={`nav-item ${w.page === id ? 'active' : ''}`}
            onClick={() => {
              w.setPage(id);
              close();
            }}
          >
            <Icon size={19} strokeWidth={1.7} />
            {label}
          </button>
        ))}
      </nav>
      <div className="projects-caption">
        <button
          className="project-manage-link"
          onClick={() => {
            w.setPage('projects');
            close();
          }}
          aria-label="管理项目"
        >
          项目
          <ChevronRight size={13} />
        </button>
        <button className="icon-button" aria-label="新建项目" onClick={() => setModal(true)}>
          <Plus size={16} />
        </button>
      </div>
      <div className="project-tree">
        {w.local.projects
          .filter((p) => p.status !== 'archived')
          .map((p) => {
            const isClosed = collapsed.includes(p.id);
            return (
              <div key={p.id} className="project-group">
                <button
                  className="project-name"
                  onClick={() =>
                    setCollapsed((old) =>
                      isClosed ? old.filter((id) => id !== p.id) : [...old, p.id],
                    )
                  }
                >
                  {isClosed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  <Folder size={16} />
                  <span>{p.name}</span>
                </button>
                {!isClosed && (
                  <div className="session-tree">
                    {w.local.sessions
                      .filter((s) => s.projectId === p.id && !s.archivedAt)
                      .toSorted(
                        (a, b) =>
                          Number(!!b.pinned) - Number(!!a.pinned) ||
                          b.updatedAt.localeCompare(a.updatedAt) ||
                          b.id.localeCompare(a.id),
                      )
                      .slice(0, 20)
                      .map((s) => (
                        <button
                          key={s.id}
                          className={`session-item ${w.activeSessionId === s.id && w.page === 'workspace' ? 'selected' : ''}`}
                          onClick={() => {
                            w.openSession(s.id);
                            close();
                          }}
                        >
                          <i className={s.status === 'running' ? 'pulse' : ''} />
                          <span>{s.title}</span>
                          {s.pinned && <Pin size={11} />}
                        </button>
                      ))}
                    <button
                      className="add-session"
                      disabled={w.creatingSession || p.access === 'revoked'}
                      onClick={() => void w.newSession(p.id)}
                    >
                      <Plus size={13} />
                      新会话
                    </button>
                  </div>
                )}
              </div>
            );
          })}
      </div>
      <div className="sidebar-bottom">
        <div
          className="sidebar-tools"
          ref={toolsRoot}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && toolsOpen) {
              event.stopPropagation();
              setToolsOpen(false);
              toolsButton.current?.focus();
            }
          }}
        >
          <button
            ref={toolsButton}
            className={`nav-item ${currentTool ? 'active' : ''}`}
            aria-label="工具与资源"
            aria-expanded={toolsOpen}
            aria-controls="sidebar-tools-menu"
            onClick={() => setToolsOpen((value) => !value)}
          >
            <Shapes size={18} />
            <span>工具{currentTool ? ` · ${currentTool.label}` : ''}</span>
            {toolsOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
          <div
            id="sidebar-tools-menu"
            className="sidebar-tools-menu"
            hidden={!toolsOpen}
            role="group"
            aria-label="工具与资源列表"
          >
            {tools.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                className={`nav-item ${w.page === id ? 'active' : ''}`}
                onClick={() => {
                  w.setPage(id);
                  setToolsOpen(false);
                  close();
                }}
              >
                <Icon size={16} strokeWidth={1.7} />
                {label}
                {id === 'schedules' && w.local.schedules.length > 0 && (
                  <em>{w.local.schedules.length}</em>
                )}
              </button>
            ))}
          </div>
        </div>
        <button
          className={`nav-item ${w.page === 'settings' ? 'active' : ''}`}
          onClick={() => w.setPage('settings')}
        >
          <Settings size={19} />
          设置
        </button>
        <div className="account-wrap">
          <button className="account" onClick={() => setAccount(!account)}>
            <div className="avatar">{w.cloud.user.name.slice(0, 1)}</div>
            <div>
              <strong>{w.cloud.user.name}</strong>
              <small>{w.cloud.demoAllowed ? '本地原型工作空间' : '个人工作空间'}</small>
            </div>
            <ChevronDown size={14} />
          </button>
          {account && (
            <div className="account-menu">
              {w.cloud.user.role === 'admin' && (
                <button
                  onClick={() => {
                    w.setPage('admin');
                    setAccount(false);
                  }}
                >
                  <ShieldCheck size={16} />
                  管理后台
                </button>
              )}
              <button onClick={w.logout}>
                <LogOut size={16} />
                退出登录
              </button>
            </div>
          )}
        </div>
      </div>
      {modal && <ProjectEditor mode="create" onClose={closeModal} />}
    </aside>
  );
}
