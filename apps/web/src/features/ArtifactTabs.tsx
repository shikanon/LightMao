import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Folder, RefreshCw, X } from 'lucide-react';
import { ArtifactViewer } from './ArtifactViewer';
import { api, currentAuthUser } from '../api';
import { hasDesktopActions, openProjectDocument, revealProjectPath } from '../desktop';
import {
  artifactStorageKey,
  closeArtifact,
  emptyArtifactTabs,
  readArtifactTabs,
  updateArtifactView,
  type ArtifactTabState,
  type ArtifactViewState,
  type WorkspaceScope,
} from './workspace-tabs';

type StoredLayout = { revision: number; value: unknown; updatedAt?: string };
export function useArtifactTabs(scope: WorkspaceScope, persistent = false) {
  const key = artifactStorageKey(scope);
  const initial = useMemo(() => {
    try {
      const saved = localStorage.getItem(key),
        meta = saved ? JSON.parse(saved)._sync : undefined;
      return {
        value: saved
          ? readArtifactTabs(saved)
          : {
              ...emptyArtifactTabs(),
              panelOpen: !window.matchMedia('(max-width: 1020px)').matches,
            },
        revision: Number.isInteger(meta?.revision) ? Math.max(0, meta.revision) : 0,
        pending: meta?.pending === true,
      };
    } catch {
      return { value: emptyArtifactTabs(), revision: 0, pending: false };
    }
  }, [key]);
  const [record, setRecord] = useState({ key, value: initial.value });
  const value = record.key === key ? record.value : initial.value;
  const [syncTick, setSyncTick] = useState(0),
    [notice, setNotice] = useState({ key, text: '' });
  const activeKey = useRef(key);
  activeKey.current = key;
  const sync = useMemo(
    () => ({
      revision: initial.revision,
      version: initial.pending ? 1 : 0,
      saved: 0,
      hydrated: !persistent,
      busy: false,
      conflict: false,
      value: initial.value,
    }),
    [key, persistent],
  );
  sync.value = value;
  const writeCache = useCallback(() => {
    try {
      localStorage.setItem(
        key,
        JSON.stringify({
          ...sync.value,
          _sync: { revision: sync.revision, pending: sync.version > sync.saved },
        }),
      );
    } catch {
      /* A full local cache never prevents previewing. */
    }
  }, [key, sync]);
  const saveRemote = useCallback(async (): Promise<void> => {
    if (
      !persistent ||
      !scope.session ||
      !sync.hydrated ||
      sync.busy ||
      sync.conflict ||
      sync.version <= sync.saved ||
      currentAuthUser() !== scope.owner
    )
      return;
    const version = sync.version,
      snapshot = sync.value;
    sync.busy = true;
    try {
      const result = await api<StoredLayout>(
        `/local/sessions/${scope.session}/ui-state/artifacts`,
        {
          method: 'PUT',
          body: JSON.stringify({ revision: sync.revision, value: snapshot }),
          signal: AbortSignal.timeout(6000),
        },
      );
      sync.revision = result.revision;
      sync.saved = version;
      if (activeKey.current === key) setNotice({ key, text: '' });
    } catch (error) {
      sync.conflict = true;
      if (activeKey.current === key)
        setNotice({
          key,
          text:
            (error as { status?: number }).status === 409
              ? '另一个窗口更新了布局；当前调整已保留。'
              : '布局已暂存在当前窗口。',
        });
    } finally {
      sync.busy = false;
      writeCache();
      if (activeKey.current === key) setSyncTick((tick) => tick + 1);
      else if (sync.version > sync.saved && !sync.conflict) queueMicrotask(() => void saveRemote());
    }
  }, [persistent, scope.session, scope.owner, key, sync, writeCache]);
  const update = useCallback(
    (change: (state: ArtifactTabState) => ArtifactTabState) => {
      if (activeKey.current !== key) {
        // Old media pause events save their own scope and cannot replace another chat.
        try {
          sync.value = change(readArtifactTabs(localStorage.getItem(key)));
          sync.version++;
          writeCache();
          void saveRemote();
        } catch {
          /* Scoped metadata only. */
        }
        return;
      }
      sync.version++;
      setRecord((previous) => ({
        key,
        value: change(previous.key === key ? previous.value : sync.value),
      }));
    },
    [key, sync, writeCache, saveRemote],
  );
  useEffect(() => {
    if (!persistent || !scope.session || !scope.owner) return;
    const controller = new AbortController(),
      startedAtVersion = sync.version;
    let live = true;
    void api<StoredLayout>(`/local/sessions/${scope.session}/ui-state/artifacts`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(6000)]),
    })
      .then((remote) => {
        if (!live || currentAuthUser() !== scope.owner) return;
        const remoteValue = remote.value
          ? readArtifactTabs(JSON.stringify(remote.value))
          : undefined;
        if (sync.version === startedAtVersion && !initial.pending && remoteValue) {
          sync.value = remoteValue;
          setRecord({ key, value: remoteValue });
        } else if (
          sync.version > sync.saved &&
          remote.value &&
          remote.revision !== sync.revision &&
          JSON.stringify(remoteValue) !== JSON.stringify(sync.value)
        ) {
          sync.conflict = true;
          setNotice({ key, text: '另一个窗口更新了布局；当前调整已保留。' });
        } else if (remoteValue && JSON.stringify(remoteValue) === JSON.stringify(sync.value))
          sync.saved = sync.version;
        sync.revision = remote.revision;
        sync.hydrated = true;
        writeCache();
        setSyncTick((tick) => tick + 1);
      })
      .catch(() => {
        if (live && !controller.signal.aborted) {
          sync.hydrated = true;
          sync.conflict = true;
          setNotice({ key, text: '布局已暂存在当前窗口。' });
          setSyncTick((tick) => tick + 1);
        }
      });
    return () => {
      live = false;
      controller.abort();
      writeCache();
      void saveRemote();
    };
  }, [key, persistent, scope.session, scope.owner]);
  useEffect(() => {
    const cacheTimer = setTimeout(writeCache, 120),
      remoteTimer = setTimeout(() => void saveRemote(), 450);
    const flush = () => {
      writeCache();
      void saveRemote();
    };
    window.addEventListener('beforeunload', flush);
    return () => {
      clearTimeout(cacheTimer);
      clearTimeout(remoteTimer);
      window.removeEventListener('beforeunload', flush);
    };
  }, [key, value, syncTick, writeCache, saveRemote]);
  const resync = useCallback(async () => {
    if (!persistent || currentAuthUser() !== scope.owner) return;
    try {
      const remote = await api<StoredLayout>(`/local/sessions/${scope.session}/ui-state/artifacts`);
      sync.revision = remote.revision;
      sync.hydrated = true;
      sync.conflict = false;
      sync.version++;
      await saveRemote();
    } catch {
      if (activeKey.current === key) setNotice({ key, text: '暂时无法同步，当前布局仍保留。' });
    }
  }, [persistent, scope.owner, scope.session, sync, saveRemote, key]);
  return {
    key,
    value,
    update,
    notice: notice.key === key ? notice.text : '',
    resync,
    restoring: persistent && !!scope.session && !sync.hydrated,
  };
}

export function ArtifactTabs({
  projectId,
  state,
  update,
  perform,
  visible = true,
}: {
  projectId: string;
  state: ArtifactTabState;
  update: (change: (state: ArtifactTabState) => ArtifactTabState) => void;
  perform: <T>(work: () => Promise<T>, success?: string) => Promise<T | undefined>;
  visible?: boolean;
}) {
  const [visited, setVisited] = useState<string[]>(() => (state.active ? [state.active] : []));
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => {
    if (visible)
      buttons.current.get(state.active)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [state.active, visible]);
  useEffect(() => {
    if (state.active)
      setVisited((previous) =>
        [
          ...previous.filter(
            (path) => path !== state.active && state.tabs.some((tab) => tab.path === path),
          ),
          state.active,
        ].slice(-3),
      );
  }, [state.active, state.tabs.length]);
  // New tabs mount immediately; inactive heavy viewers are not preloaded.
  const mounted = new Set(
    [
      ...visited.filter((path) => state.tabs.some((tab) => tab.path === path)),
      ...(state.active ? [state.active] : []),
    ].slice(-3),
  );
  const select = (path: string) => update((value) => ({ ...value, active: path }));
  const close = (path: string) => {
    const next = closeArtifact(state, path);
    update((value) => closeArtifact(value, path));
    queueMicrotask(() => buttons.current.get(next.active)?.focus());
  };
  const changeView = useCallback(
    (path: string, view: ArtifactViewState) =>
      update((value) => updateArtifactView(value, path, view)),
    [update],
  );
  return (
    <div className="artifact-workspace">
      <div className="artifact-tab-strip" role="tablist" aria-label="打开的产物">
        {state.tabs.map((tab, index) => (
          <div
            className={`artifact-tab ${state.active === tab.path ? 'active' : ''}`}
            key={tab.path}
          >
            <button
              ref={(element) => {
                if (element) buttons.current.set(tab.path, element);
                else buttons.current.delete(tab.path);
              }}
              role="tab"
              aria-selected={state.active === tab.path}
              aria-label={tab.path}
              tabIndex={state.active === tab.path ? 0 : -1}
              title={tab.path}
              onClick={() => select(tab.path)}
              onKeyDown={(event) => {
                let next: number | undefined;
                if (event.key === 'ArrowLeft')
                  next = (index + state.tabs.length - 1) % state.tabs.length;
                if (event.key === 'ArrowRight') next = (index + 1) % state.tabs.length;
                if (event.key === 'Home') next = 0;
                if (event.key === 'End') next = state.tabs.length - 1;
                if (next !== undefined) {
                  event.preventDefault();
                  const path = state.tabs[next].path;
                  select(path);
                  buttons.current.get(path)?.focus();
                }
                if (event.key === 'Delete') {
                  event.preventDefault();
                  close(tab.path);
                }
              }}
            >
              <FileText size={13} />
              <span>{tab.path.split('/').at(-1)}</span>
            </button>
            <button
              className="artifact-tab-close"
              aria-label={`关闭 ${tab.path}`}
              title="关闭产物标签"
              onClick={() => close(tab.path)}
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
      {state.tabs
        .filter((tab) => mounted.has(tab.path))
        .map((tab) => (
          <ArtifactPane
            key={projectId + ':' + tab.path}
            projectId={projectId}
            tab={tab}
            active={visible && state.active === tab.path}
            changeView={changeView}
            refresh={() =>
              update((value) => ({
                ...value,
                tabs: value.tabs.map((item) =>
                  item.path === tab.path
                    ? { ...item, revision: item.revision + 1, view: {} }
                    : item,
                ),
              }))
            }
            perform={perform}
          />
        ))}
    </div>
  );
}

function ArtifactPane({
  projectId,
  tab,
  active,
  changeView,
  refresh,
  perform,
}: {
  projectId: string;
  tab: ArtifactTabState['tabs'][number];
  active: boolean;
  changeView: (path: string, view: ArtifactViewState) => void;
  refresh: () => void;
  perform: <T>(work: () => Promise<T>, success?: string) => Promise<T | undefined>;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const initialScroll = useRef(tab.view.scrollTop || 0);
  const onViewStateChange = useCallback(
    (view: ArtifactViewState) => changeView(tab.path, view),
    [tab.path, changeView],
  );
  useEffect(() => {
    if (active && scroll.current && initialScroll.current) {
      scroll.current.scrollTop = initialScroll.current;
      const timer = setTimeout(() => {
        if (scroll.current) scroll.current.scrollTop = initialScroll.current;
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [active]);
  return (
    <div
      className="artifact-tab-pane"
      role="tabpanel"
      aria-label={tab.path}
      hidden={!active}
      ref={scroll}
      onScroll={(event) => {
        initialScroll.current = event.currentTarget.scrollTop;
        onViewStateChange({ scrollTop: event.currentTarget.scrollTop });
      }}
    >
      <article className="artifact-document">
        <div className="preview-file-name">
          <span className="artifact-path" title={tab.path}>
            {tab.path}
          </span>
          {hasDesktopActions() && /\.(txt|md|markdown|json|csv)$/i.test(tab.path) && (
            <button
              className="text-button"
              onClick={() => void perform(() => openProjectDocument(projectId, tab.path))}
            >
              外部打开
            </button>
          )}
          {hasDesktopActions() && (
            <button
              className="icon-button"
              aria-label="在文件管理器中显示文件"
              onClick={() => void perform(() => revealProjectPath(projectId, tab.path))}
            >
              <Folder size={14} />
            </button>
          )}
          <button className="icon-button" aria-label="更新预览" title="更新预览" onClick={refresh}>
            <RefreshCw size={14} />
          </button>
        </div>
        <ArtifactViewer
          key={projectId + tab.path + tab.revision}
          projectId={projectId}
          path={tab.path}
          active={active}
          viewState={tab.view}
          onViewStateChange={onViewStateChange}
        />
      </article>
    </div>
  );
}
