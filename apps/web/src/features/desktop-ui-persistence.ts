import { api, currentAuthUser } from '../api';
import type { ConversationScope } from './desktop-session-state';
interface Stored {
  revision: number;
  value: Record<string, unknown> | null;
  updatedAt?: string;
}
export interface UiStateMirror {
  ready: Promise<Stored>;
  write: (value: Record<string, unknown>) => void;
  flush: () => void;
  dispose: () => void;
}
/** Serial CAS saves coalesce edits. A conflict keeps both local and server state intact. */
export function createUiStateMirror(
  scope: ConversationScope,
  namespace: 'conversation' | 'viewport',
  callbacks: {
    restored: (value: Record<string, unknown> | null) => void;
    error?: (message: string) => void;
  },
): UiStateMirror {
  const owner = scope.ownerId,
    path = `/local/sessions/${encodeURIComponent(scope.sessionId)}/ui-state/${namespace}`;
  let revision = 0,
    loaded = false,
    closing = false,
    disposed = false,
    conflicted = false,
    paused = false,
    inFlight = false,
    pending: Record<string, unknown> | undefined,
    timer: ReturnType<typeof setTimeout> | undefined;
  const allowed = () => !disposed && currentAuthUser() === owner;
  const flush = () => {
    clearTimeout(timer);
    if (!allowed() || !loaded || conflicted || paused || inFlight || !pending) return;
    const value = pending;
    pending = undefined;
    inFlight = true;
    void api<Stored>(path, {
      method: 'PUT',
      body: JSON.stringify({ revision, value }),
      keepalive: true,
      signal: AbortSignal.timeout(12000),
    })
      .then((result) => {
        if (allowed()) revision = result.revision;
      })
      .catch((error) => {
        if (!allowed()) return;
        pending ??= value;
        paused = true;
        if (error.status === 409) conflicted = true;
        callbacks.error?.(
          conflicted
            ? '另一个窗口已更改此会话状态；本窗口输入已保留，未覆盖远端。'
            : '会话状态暂只保留在本窗口，继续编辑或重新打开会话可再核对。',
        );
      })
      .finally(() => {
        inFlight = false;
        if (allowed() && pending && !conflicted && !paused) {
          if (closing) flush();
          else timer = setTimeout(flush, 240);
        } else if (closing) disposed = true;
      });
  };
  const ready = api<Stored>(path, { signal: AbortSignal.timeout(12000) })
    .then((result) => {
      if (!allowed()) return result;
      revision = result.revision;
      loaded = true;
      if (!pending) callbacks.restored(result.value);
      else flush();
      if (closing && !inFlight && !pending) disposed = true;
      return result;
    })
    .catch((error) => {
      paused = true;
      if (allowed()) callbacks.error?.('草稿恢复暂不可用，当前输入仍保留在本窗口。');
      throw error;
    });
  void ready.catch(() => {});
  const write = (value: Record<string, unknown>) => {
    if (!allowed()) return;
    pending = value;
    if (!conflicted) paused = false;
    clearTimeout(timer);
    if (closing) flush();
    else timer = setTimeout(flush, 220);
  };
  return {
    ready,
    write,
    flush,
    dispose: () => {
      closing = true;
      flush();
      clearTimeout(timer);
      if (!inFlight && (!pending || paused || conflicted)) disposed = true;
    },
  };
}
