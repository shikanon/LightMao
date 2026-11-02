import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { PanelLeft, ArrowRight, X, Cat, ShieldCheck } from 'lucide-react';
import type {
  CloudBootstrap,
  LocalBootstrap,
  Session,
  SessionView,
} from '../../../packages/shared/types';
import {
  api,
  post,
  setToken,
  hasToken,
  refreshAccess,
  setAuthUser,
  currentAuthUser,
  ApiError,
} from './api';
import { Workspace, type Page } from './context';
import { Logo, Toast, Spinner } from './components/UI';
import { Sidebar } from './components/Sidebar';
import { Workbench } from './features/Workbench';
import { Plugins } from './features/Plugins';
import { Skills } from './features/Skills';
import { Assets } from './features/Assets';
import { Schedules } from './features/Schedules';
import { Settings } from './features/Settings';
import { Projects } from './features/Projects';
import { Sessions } from './features/Sessions';
import { hasBackendSettings, desktopBackendStatus, type BackendConnectionStatus } from './desktop';
import { BackendConnection } from './features/BackendConnection';
const Admin = lazy(() => import('./features/Admin'));
const GameStudio = lazy(() => import('./features/GameStudio'));
let initialLogin: Promise<void> | undefined;
let adminBootstrapPath: Promise<string> | undefined;
function adminMetadata() {
  // Cache the public capability only; user data is fetched with the current
  // credential on each refresh. Older compatible backends keep their route.
  adminBootstrapPath ||= api<{ features?: { accountBootstrap?: boolean } }>('/api/health')
    .then((v) => (v.features?.accountBootstrap ? '/api/account/bootstrap' : '/api/bootstrap'))
    .catch((error) => {
      adminBootstrapPath = undefined;
      throw error;
    });
  return adminBootstrapPath.then((path) => api<CloudBootstrap>(path));
}
async function initialize() {
  if (!initialLogin)
    initialLogin = (async () => {
      if (hasToken() && !currentAuthUser()) {
        try {
          const upgraded = await post<{ token: string; user: { id: string } }>('/api/auth/upgrade');
          setToken(upgraded.token, upgraded.user.id);
        } catch (error) {
          if (!(error instanceof ApiError) || ![401, 409].includes(error.status)) throw error;
        }
      }
      if (!hasToken()) {
        if (await refreshAccess()) return;
        const health = await api<{ demoAllowed: boolean }>('/api/health');
        if (health.demoAllowed) {
          const data = await post<{ token: string; user: { id: string } }>('/api/auth/demo');
          setToken(data.token, data.user.id);
        }
      }
    })();
  return initialLogin;
}

export function App() {
  const [backend, setBackend] = useState<BackendConnectionStatus>(),
    [editing, setEditing] = useState(false),
    [error, setError] = useState('');
  const native = hasBackendSettings();
  useEffect(() => {
    if (!native) return;
    let active = true;
    void desktopBackendStatus()
      .then((value) => {
        if (active) setBackend(value);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    const configure = () => setEditing(true);
    window.addEventListener('lightmao:configure-backend', configure);
    return () => {
      active = false;
      window.removeEventListener('lightmao:configure-backend', configure);
    };
  }, [native]);
  if (native && (!backend || !backend.configured || editing)) {
    if (!backend && !error)
      return (
        <div className="loading-screen">
          <Logo />
          <Spinner />
        </div>
      );
    return (
      <BackendConnection
        setup
        onCancel={backend?.configured ? () => setEditing(false) : undefined}
      />
    );
  }
  return <WorkspaceApp />;
}
function WorkspaceApp() {
  const [adminOnly] = useState(() => location.pathname.startsWith('/admin'));
  const [cloud, setCloud] = useState<CloudBootstrap>(),
    [local, setLocal] = useState<LocalBootstrap>(),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [toast, setToast] = useState('');
  const [page, setPage] = useState<Page>(
      location.pathname.startsWith('/admin') ? 'admin' : 'workspace',
    ),
    [activeSessionId, setActiveSessionId] = useState(''),
    [navOpen, setNavOpen] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [focus, setFocus] = useState<{ sessionId: string; messageId?: string }>();
  const selection = useRef({ id: '', owner: '' }),
    refreshVersion = useRef(0);
  const sessionCache = useRef<{ owner: string; value: SessionView } | undefined>(undefined);
  const [sessionData, setSessionData] = useState<{ owner: string; value: SessionView }>(),
    [sessionLoading, setSessionLoading] = useState(false),
    [sessionError, setSessionError] = useState('');
  const select = useCallback((id: string, owner: string) => {
    selection.current = { id, owner };
    setActiveSessionId(id);
  }, []);
  const acceptSession = useCallback((owner: string, value: SessionView) => {
    if (
      currentAuthUser() !== owner ||
      selection.current.owner !== owner ||
      selection.current.id !== value.id
    )
      return;
    const previous = sessionCache.current;
    if (
      previous?.owner === owner &&
      previous.value.id === value.id &&
      (previous.value.revision || 0) > (value.revision || 0)
    ) {
      setSessionLoading(false);
      setSessionError('');
      return;
    }
    const next = { owner, value };
    sessionCache.current = next;
    setSessionData(next);
    setSessionLoading(false);
    setSessionError('');
  }, []);
  const notify = useCallback((text: string) => setToast(text), []);
  useEffect(() => {
    const invalid = (event: Event) => {
      setToken('');
      setCloud(undefined);
      setLocal(undefined);
      setError((event as CustomEvent<string>).detail || '请重新登录');
    };
    window.addEventListener('lightmao:auth-expired', invalid);
    return () => window.removeEventListener('lightmao:auth-expired', invalid);
  }, []);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(''), 3200);
      return () => clearTimeout(t);
    }
  }, [toast]);
  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current,
      owner = currentAuthUser(),
      selected = selection.current.owner === owner ? selection.current.id : '';
    const view =
      selected && !adminOnly
        ? api<SessionView>(`/local/sessions/${encodeURIComponent(selected)}`)
            .then((value) => ({ value, error: '' }))
            .catch((error) => ({ value: undefined, error: error.message as string }))
        : Promise.resolve({ value: undefined, error: '' });
    const [c, l, detail] = await Promise.all([
      adminOnly ? adminMetadata() : api<CloudBootstrap>('/api/bootstrap'),
      adminOnly
        ? Promise.resolve<LocalBootstrap>({
            projects: [],
            sessions: [],
            schedules: [],
            runtime: { framework: '', sandbox: '', online: false },
          })
        : api<LocalBootstrap>(
            `/local/bootstrap${selected ? '?sessionId=' + encodeURIComponent(selected) : ''}`,
          ),
      view,
    ]);
    if (
      version !== refreshVersion.current ||
      !hasToken() ||
      (currentAuthUser() && currentAuthUser() !== c.user.id)
    )
      return;
    setAuthUser(c.user.id);
    setCloud(c);
    setLocal(l);
    const saved = sessionStorage.getItem(`lightmao.active.${c.user.id}`);
    if (selection.current.owner !== c.user.id || !selection.current.id)
      select(saved || l.sessions.find((s) => !s.archivedAt)?.id || '', c.user.id);
    if (detail.value) acceptSession(c.user.id, detail.value);
    else if (
      detail.error &&
      selection.current.id === selected &&
      selection.current.owner === c.user.id
    ) {
      setSessionError(detail.error);
      setSessionLoading(false);
    }
  }, [adminOnly, select, acceptSession]);
  useEffect(() => {
    if (adminOnly || !activeSessionId || !cloud || selection.current.owner !== cloud.user.id) {
      setSessionLoading(false);
      return;
    }
    const owner = cloud.user.id,
      id = activeSessionId,
      controller = new AbortController();
    setSessionLoading(true);
    setSessionError('');
    void api<SessionView>(`/local/sessions/${encodeURIComponent(id)}`, {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) acceptSession(owner, value);
      })
      .catch((error) => {
        if (!controller.signal.aborted && currentAuthUser() === owner) {
          setSessionLoading(false);
          setSessionError(error.message);
        }
      });
    return () => controller.abort();
  }, [activeSessionId, cloud?.user.id, adminOnly, acceptSession]);
  useEffect(() => {
    if (cloud && activeSessionId)
      sessionStorage.setItem(`lightmao.active.${cloud.user.id}`, activeSessionId);
  }, [cloud?.user.id, activeSessionId]);
  useEffect(() => {
    void initialize()
      .then(() => (hasToken() ? refresh() : undefined))
      .catch((e) => {
        setError(e.message);
        setToken('');
      })
      .finally(() => setLoading(false));
  }, [refresh]);
  const openSession = useCallback(
    (id: string, messageId?: string) => {
      setFocus({ sessionId: id, messageId });
      if (selection.current.id === id && selection.current.owner === currentAuthUser()) {
        setPage('workspace');
        void refresh().catch((error) => setSessionError(error.message));
        return;
      }
      select(id, currentAuthUser());
      setSessionLoading(true);
      setSessionError('');
      setPage('workspace');
    },
    [select, refresh],
  );
  const perform = useCallback(
    async <T,>(work: () => Promise<T>, success?: string) => {
      try {
        const result = await work();
        if (success) notify(success);
        return result;
      } catch (e) {
        setError(e instanceof Error ? e.message : '操作失败，请重试');
        return undefined;
      }
    },
    [notify],
  );
  const newSession = useCallback(
    async (projectId?: string) => {
      if (!local?.runtime.online || creatingSession) return;
      const usable = local.projects.filter(
        (p) => p.status !== 'archived' && p.access !== 'revoked',
      );
      const current = local.sessions.find((s) => s.id === activeSessionId);
      const selected =
        usable.find((p) => p.id === (projectId || current?.projectId)) ||
        (!projectId ? usable[0] : undefined);
      if (!selected) {
        setPage('projects');
        notify('请先创建项目，或重新连接项目目录');
        return;
      }
      setCreatingSession(true);
      try {
        await perform(async () => {
          const s = await post<Session>('/local/sessions', {
            projectId: selected.id,
          });
          await refresh();
          openSession(s.id);
        });
      } finally {
        setCreatingSession(false);
      }
    },
    [local, activeSessionId, perform, refresh, openSession, creatingSession, notify],
  );
  const logout = async () => {
    try {
      await api('/api/logout', { method: 'POST', body: '{}', signal: AbortSignal.timeout(5000) });
    } catch {
    } finally {
      setToken('');
      setCloud(undefined);
      setLocal(undefined);
    }
  };
  const setPageRoute = (p: Page) => {
    setPage(p);
    history.replaceState(null, '', p === 'admin' ? '/admin' : '/');
  };
  const finishLogin = async () => {
    setLoading(true);
    try {
      await refresh();
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  if (loading)
    return (
      <div className="loading-screen">
        <Logo />
        <Spinner />
        <p>正在打开你的工作空间…</p>
      </div>
    );
  if (!cloud || !local) return <Login error={error} onLogin={finishLogin} />;
  const session =
    sessionData?.owner === cloud.user.id && sessionData.value.id === activeSessionId
      ? sessionData.value
      : undefined;
  return (
    <Workspace.Provider
      value={{
        cloud,
        local,
        skills: [...cloud.skills, ...(local.skills || [])],
        session,
        sessionLoading,
        sessionError,
        focusMessageId: focus?.sessionId === activeSessionId ? focus.messageId : undefined,
        activeSessionId,
        page,
        setPage: setPageRoute,
        openSession,
        refresh,
        notify,
        perform,
        newSession,
        creatingSession,
        logout,
      }}
    >
      <div
        className={`app-shell ${navigator.userAgent.includes('Electron') && navigator.platform.startsWith('Mac') ? 'native-mac' : ''}`}
      >
        {adminOnly ? (
          <header className="admin-topbar">
            <Logo small />
            <span>管理控制台</span>
            <div>
              <span>{cloud.user.name}</span>
              <button className="button secondary" onClick={logout}>
                退出登录
              </button>
            </div>
          </header>
        ) : (
          <div className="titlebar">
            <div className="traffic-lights">
              <i />
              <i />
              <i />
            </div>
            <span>
              <Cat size={14} />
              LightMao
            </span>
            <div className="titlebar-right">
              <span className="local-indicator" />
              本地工作空间
            </div>
          </div>
        )}
        <div className="app-body">
          {!adminOnly && navOpen && <div className="nav-scrim" onClick={() => setNavOpen(false)} />}
          {!adminOnly && (
            <div className={`sidebar-holder ${navOpen ? 'open' : ''}`}>
              <Sidebar close={() => setNavOpen(false)} />
            </div>
          )}
          <main className="main-area">
            {!adminOnly && (
              <div className="mobile-toolbar">
                <button
                  className="icon-button"
                  aria-label="展开导航"
                  onClick={() => setNavOpen(true)}
                >
                  <PanelLeft size={20} />
                </button>
                <Logo small />
              </div>
            )}
            {page === 'workspace' && <Workbench />}
            {page === 'projects' && <Projects />}
            {page === 'engines' && (
              <Suspense
                fallback={
                  <div className="loading-screen">
                    <Spinner />
                  </div>
                }
              >
                <GameStudio />
              </Suspense>
            )}
            {page === 'sessions' && <Sessions />}
            {page === 'plugins' && <Plugins />}
            {page === 'skills' && <Skills />}
            {page === 'assets' && <Assets />}
            {page === 'schedules' && <Schedules />}
            {page === 'settings' && <Settings />}
            {page === 'admin' && (
              <Suspense
                fallback={
                  <div className="loading-screen">
                    <Spinner />
                  </div>
                }
              >
                <Admin />
              </Suspense>
            )}
          </main>
        </div>
      </div>
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button className="icon-button" aria-label="关闭错误提示" onClick={() => setError('')}>
            <X size={17} />
          </button>
        </div>
      )}
      {toast && <Toast text={toast} />}
    </Workspace.Provider>
  );
}
function Login({ onLogin, error }: { onLogin: () => Promise<void>; error: string }) {
  const [register, setRegister] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(error);
  return (
    <div className="login-page">
      <section className="login-intro">
        <Logo />
        <div>
          <h1>
            每一个世界，
            <br />
            从一个想法开始。
          </h1>
          <p>
            把创意、代码与素材放在一起。
            <br />
            与你的游戏开发 Agent，一起创造。
          </p>
        </div>
        <img src="/assets/forest.png" alt="阳光穿过森林，旅人走向一座古老的拱门" />
      </section>
      <section className="login-form">
        <div>
          <h2>{register ? '创建你的工作空间' : '欢迎回到 LightMao'}</h2>
          <p>{register ? '开启下一段游戏创作旅程' : '登录以继续你的项目与会话'}</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setBusy(true);
              setMessage('');
              const data = Object.fromEntries(new FormData(e.currentTarget));
              void post<{ token: string; user: { id: string } }>(
                register ? '/api/auth/register' : '/api/auth/login',
                data,
              )
                .then(async (r) => {
                  setToken(r.token, r.user.id);
                  await onLogin();
                })
                .catch((e) => setMessage(e.message))
                .finally(() => setBusy(false));
            }}
          >
            {register && (
              <label>
                称呼
                <input name="name" required placeholder="如何称呼你" autoComplete="name" />
              </label>
            )}
            <label>
              邮箱
              <input
                name="email"
                type="email"
                required
                placeholder="you@example.com"
                autoComplete="email"
              />
            </label>
            <label>
              密码
              <input
                name="password"
                type="password"
                required
                minLength={register ? 12 : 1}
                placeholder={register ? '至少 12 个字符' : '输入密码'}
                autoComplete={register ? 'new-password' : 'current-password'}
              />
            </label>
            {message && (
              <p className="inline-error" role="alert">
                {message}
              </p>
            )}
            <button className="button primary full" disabled={busy}>
              {busy ? <Spinner /> : register ? '创建账号' : '登录'}
              <ArrowRight size={17} />
            </button>
          </form>
          <button className="text-button" onClick={() => setRegister(!register)}>
            {register ? '已有账号？返回登录' : '还没有账号？注册'}
          </button>
          <div className="login-note">
            <ShieldCheck size={16} />
            模型密钥由后端保管
          </div>
          {hasBackendSettings() && (
            <button
              type="button"
              className="text-button"
              onClick={() => window.dispatchEvent(new Event('lightmao:configure-backend'))}
            >
              后端连接设置
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
