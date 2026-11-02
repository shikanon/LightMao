import type { RunEvent, User } from '../../../packages/shared/types';
let authToken = sessionStorage.getItem('lightmao.token') || '';
let authUserId = sessionStorage.getItem('lightmao.user') || '';
let authVersion = 0;
export const currentAuthUser = () => authUserId;
export const currentAccessToken = () => authToken;
export const setAuthUser = (id: string) => {
  authUserId = id;
  sessionStorage.setItem('lightmao.user', id);
};
export const setToken = (token: string, userId?: string) => {
  if (!token || (userId && authUserId && userId !== authUserId))
    window.dispatchEvent(new Event('lightmao:auth-cleared'));
  authVersion++;
  authToken = token;
  token
    ? sessionStorage.setItem('lightmao.token', token)
    : sessionStorage.removeItem('lightmao.token');
  if (userId) setAuthUser(userId);
  if (!token) {
    authUserId = '';
    sessionStorage.removeItem('lightmao.user');
  }
};
export const hasToken = () => !!authToken;
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
const expired = (message = '登录已失效，请重新登录') =>
  window.dispatchEvent(new CustomEvent('lightmao:auth-expired', { detail: message }));
async function responseError(response: Response) {
  const body = await response.json().catch(() => ({}));
  return new ApiError(body.error || `请求失败 (${response.status})`, response.status, body.code);
}
let refreshing: Promise<boolean> | undefined;
export async function refreshAccess(): Promise<boolean> {
  if (refreshing) return refreshing;
  const version = authVersion;
  const refresh = async () => {
    if (version !== authVersion) return hasToken();
    const expected = authUserId;
    const response = await fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      if (version !== authVersion) return hasToken();
      const error = await responseError(response);
      if (response.status === 401 || error.code === 'ACCOUNT_DISABLED') {
        setToken('');
        return false;
      }
      throw error;
    }
    const data = (await response.json()) as { token: string; user: User };
    if (version !== authVersion) return hasToken();
    if (expected && expected !== data.user.id) {
      setToken('');
      expired('账号已在其他窗口切换，请重新登录');
      return false;
    }
    setToken(data.token, data.user.id);
    return true;
  };
  const work = (async () =>
    await (navigator.locks
      ? navigator.locks.request('lightmao-auth-refresh', refresh)
      : refresh()))();
  refreshing = work;
  try {
    return await work;
  } finally {
    if (refreshing === work) refreshing = undefined;
  }
}
export async function authenticatedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const sentToken = authToken,
    expectedUser = authUserId;
  const send = () => {
    const headers = new Headers(init.headers);
    if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type'))
      headers.set('Content-Type', 'application/json');
    headers.set('Authorization', `Bearer ${authToken}`);
    return fetch(path, { ...init, credentials: 'same-origin', headers });
  };
  let response = await send();
  if (response.status === 401 && !path.startsWith('/api/auth/') && path !== '/api/health') {
    const body = await response
      .clone()
      .json()
      .catch(() => ({}));
    if (!body.code || ['AUTH_REQUIRED', 'AUTH_EXPIRED', 'REFRESH_REUSED'].includes(body.code)) {
      if (expectedUser && authUserId && expectedUser !== authUserId)
        return Response.json(
          { error: '账号已切换，请重新执行此操作', code: 'ACCOUNT_CHANGED' },
          { status: 401 },
        );
      if (sentToken && !authToken) return response;
      if (authToken && sentToken !== authToken) {
        init.signal?.throwIfAborted();
        return send();
      }
      if (await refreshAccess()) {
        if (expectedUser && expectedUser !== authUserId)
          return Response.json(
            { error: '账号已切换，请重新执行此操作', code: 'ACCOUNT_CHANGED' },
            { status: 401 },
          );
        init.signal?.throwIfAborted();
        response = await send();
      } else expired();
    }
  }
  if (response.status === 403) {
    const error = await response
      .clone()
      .json()
      .catch(() => ({}));
    if (error.code === 'ACCOUNT_DISABLED') {
      setToken('');
      expired(error.error);
    }
  }
  return response;
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await authenticatedFetch(path, init);
  if (!response.ok) {
    throw await responseError(response);
  }
  return response.json();
}
export const post = <T>(path: string, data: unknown = {}) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(data) });
export const patch = <T>(path: string, data: unknown) =>
  api<T>(path, { method: 'PATCH', body: JSON.stringify(data) });
export async function assetMediaUrl(id: string, signal: AbortSignal) {
  const response = await authenticatedFetch(`/api/assets/${id}/content`, {
    signal,
  });
  if (!response.ok) throw new Error('媒体预览读取失败，可下载原文件查看');
  return URL.createObjectURL(await response.blob());
}
export async function downloadAsset(id: string, name: string) {
  const r = await authenticatedFetch(`/api/assets/${id}/download`);
  if (!r.ok) throw new Error('下载失败');
  const url = URL.createObjectURL(await r.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function skillResourceUrl(id: string, path: string, version?: string) {
  const response = await authenticatedFetch(
    `/local/skills/${encodeURIComponent(id)}/resource?path=${encodeURIComponent(path)}&download=true${version ? `&version=${encodeURIComponent(version)}` : ''}`,
  );
  if (!response.ok) throw await responseError(response);
  return URL.createObjectURL(await response.blob());
}
export async function downloadSkillResource(id: string, path: string, version?: string) {
  const url = await skillResourceUrl(id, path, version);
  const link = document.createElement('a');
  link.href = url;
  link.download = path.split('/').at(-1)!;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function engineArtifactBlob(jobId: string, artifactId: string, signal?: AbortSignal) {
  const response = await authenticatedFetch(
    `/local/engine-jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(artifactId)}`,
    { signal },
  );
  if (!response.ok) throw await responseError(response);
  return response.blob();
}
export async function downloadEngineArtifact(jobId: string, artifactId: string, name: string) {
  const url = URL.createObjectURL(await engineArtifactBlob(jobId, artifactId));
  const link = document.createElement('a');
  link.href = url;
  link.download = name.split('/').at(-1)!;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function retryDelay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
export async function watchRun(
  id: string,
  onEvent: (event: RunEvent) => void,
  signal: AbortSignal,
  onReconnect?: () => void,
) {
  let cursor = 0,
    attempt = 0;
  while (!signal.aborted) {
    try {
      const response = await authenticatedFetch(`/local/runs/${id}/stream?after=${cursor}`, {
        signal,
      });
      if (!response.ok) throw await responseError(response);
      if (!response.body) throw new Error('Event stream is unavailable');
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let buffer = '',
        finished = false;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const blocks = buffer.split('\n\n');
          buffer = blocks.pop() || '';
          for (const block of blocks) {
            const line = block.split('\n').find((value) => value.startsWith('data: '));
            if (!line) continue;
            const event = JSON.parse(line.slice(6)) as RunEvent;
            if (event.seq <= cursor) continue;
            cursor = event.seq;
            onEvent(event);
            if (event.type === 'run.finished') finished = true;
          }
          if (finished) break;
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      if (finished) return;
      const run = await api<{ status: string; error?: string }>(`/local/runs/${id}`, { signal });
      if (run.status !== 'running') {
        onEvent({
          id: `${id}:recovered`,
          runId: id,
          seq: cursor,
          type: 'run.finished',
          at: new Date().toISOString(),
          data: { status: run.status, error: run.error || null },
        });
        return;
      }
    } catch (error) {
      signal.throwIfAborted();
      if (
        error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        ![408, 429].includes(error.status)
      )
        throw error;
    }
    if (!attempt) onReconnect?.();
    await retryDelay(Math.min(5000, 250 * 2 ** Math.min(attempt++, 5)), signal);
  }
}
