import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
  type DragEvent,
  type ClipboardEvent,
} from 'react';
import { api, ApiError, currentAuthUser } from '../api';
import type { Asset } from '../../../../packages/shared/types';
import type { ReferenceMedia } from '../../../../packages/shared/perception';
import {
  conversationStateKey,
  readConversationDraft,
  writeConversationDraft,
  serializeConversationDraft,
  clearConversationOwner,
  EMPTY_DRAFT,
  MAX_ATTACHMENTS,
  MAX_DRAFT_LENGTH,
  type ConversationScope,
  type ConversationAttachment,
  type ConversationDraft,
} from './desktop-session-state';
import { useDesktopShortcuts } from './useDesktopShortcuts';
import { createUiStateMirror, type UiStateMirror } from './desktop-ui-persistence';

const cache = new Map<string, ConversationDraft>(),
  listeners = new Set<() => void>();
const mirrors = new Map<string, UiStateMirror>();
const mirrorUsers = new Map<string, number>();
function releaseMirror(key: string) {
  const mirror = mirrors.get(key);
  if (!mirror) return;
  mirror.flush();
  if (!(mirrorUsers.get(key) || 0) && !read(key).attachments.some((a) => controllers.has(a.id))) {
    mirror.dispose();
    mirrors.delete(key);
  }
}
const files = new Map<string, File>(),
  previews = new Map<string, string>(),
  controllers = new Map<string, AbortController>();
let epoch = 0;
let activeUploads = 0;
const emit = () => {
  for (const listener of listeners) listener();
};
function read(key: string) {
  if (!cache.has(key)) cache.set(key, readConversationDraft(sessionStorage, key));
  return cache.get(key)!;
}
function update(key: string, fn: (d: ConversationDraft) => ConversationDraft) {
  const value = { ...fn(read(key)), updatedAt: Date.now() };
  cache.set(key, value);
  writeConversationDraft(sessionStorage, key, value);
  mirrors.get(key)?.write(serializeConversationDraft(value) as unknown as Record<string, unknown>);
  emit();
}
function clear() {
  epoch++;
  for (const mirror of mirrors.values()) mirror.dispose();
  mirrors.clear();
  mirrorUsers.clear();
  for (const control of controllers.values()) control.abort();
  controllers.clear();
  for (const url of previews.values()) URL.revokeObjectURL(url);
  previews.clear();
  files.clear();
  cache.clear();
  clearConversationOwner(sessionStorage);
  emit();
}
if (typeof window !== 'undefined') window.addEventListener('lightmao:auth-cleared', clear);
const mediaFile = (file: File) =>
  /^(video|audio)\//.test(file.type) || /\.(mp4|mov|qt|webm|m4a|mp3|wav|aac|ogg)$/i.test(file.name);
const imageFile = (file: File) =>
  /^image\/(png|jpeg|webp|gif)$/.test(file.type) || /\.(png|jpe?g|webp|gif)$/i.test(file.name);
const accepted = (file: File) =>
  mediaFile(file) ||
  imageFile(file) ||
  /\.(md|txt|json|csv|ts|tsx|js|jsx|cs|gd|yaml|yml|shader|glsl|godot|html|css|pdf|docx|xlsx)$/i.test(
    file.name,
  );
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((done, reject) => {
    const id = setTimeout(finish, ms);
    function finish() {
      signal.removeEventListener('abort', abort);
      done();
    }
    function abort() {
      clearTimeout(id);
      reject(signal.reason || Error('已停止等待'));
    }
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
export interface DesktopComposerOptions {
  scope: ConversationScope;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  onNewSession: () => Promise<void> | void;
  onEscape?: () => void;
  disabled?: boolean;
  notify: (message: string) => void;
  persistent?: boolean;
}
export function useDesktopComposer(options: DesktopComposerOptions) {
  const { scope, composerRef } = options,
    key = conversationStateKey(scope),
    latest = useRef(options);
  latest.current = options;
  const currentKey = useRef(key);
  currentKey.current = key;
  const snapshot = useSyncExternalStore(
    useCallback((listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }, []),
    useCallback(() => read(key), [key]),
    () => EMPTY_DRAFT,
  );
  const [dragging, setDragging] = useState(false);
  const [restoringKey, setRestoringKey] = useState(options.persistent ? key : '');
  const dragDepth = useRef(0),
    fileInputRef = useRef<HTMLInputElement>(null);
  const changeRow = useCallback(
    (target: string, id: string, patch: Partial<ConversationAttachment>) =>
      update(target, (d) => ({
        ...d,
        attachments: d.attachments.map((a) => (a.id === id ? { ...a, ...patch } : a)),
      })),
    [],
  );
  useEffect(() => {
    if (!options.persistent || !scope.sessionId) {
      setRestoringKey('');
      return;
    }
    setRestoringKey(key);
    const original = read(key),
      startEpoch = epoch;
    mirrorUsers.set(key, (mirrorUsers.get(key) || 0) + 1);
    const mirror =
      mirrors.get(key) ||
      createUiStateMirror(scope, 'conversation', {
        restored: (value) => {
          if (startEpoch !== epoch || currentAuthUser() !== scope.ownerId || read(key) !== original)
            return;
          if (!value) {
            if (original.text || original.attachments.length)
              mirror.write(
                serializeConversationDraft(original) as unknown as Record<string, unknown>,
              );
            return;
          }
          const parsed = readConversationDraft(
            {
              getItem: () => JSON.stringify(value),
              setItem() {},
              removeItem() {},
              key: () => null,
              length: 0,
            },
            key,
          );
          const comparable = (d: ConversationDraft) =>
            JSON.stringify({ text: d.text, attachments: d.attachments });
          if (
            original.updatedAt > parsed.updatedAt &&
            comparable(original) !== comparable(parsed) &&
            (original.text || original.attachments.length)
          ) {
            mirror.write(
              serializeConversationDraft(original) as unknown as Record<string, unknown>,
            );
            return;
          }
          cache.set(key, parsed);
          writeConversationDraft(sessionStorage, key, parsed);
          emit();
        },
        error: (message) => {
          if (currentKey.current === key) latest.current.notify(message);
        },
      });
    mirrors.set(key, mirror);
    void mirror.ready
      .finally(() => {
        if (currentKey.current === key) setRestoringKey('');
      })
      .catch(() => {});
    return () => {
      mirrorUsers.set(key, Math.max(0, (mirrorUsers.get(key) || 1) - 1));
      releaseMirror(key);
    };
  }, [key, options.persistent, scope.sessionId, scope.ownerId]);
  const upload = useCallback(
    async (targetKey: string, targetScope: ConversationScope, id: string, probeOnly = false) => {
      const target = read(targetKey).attachments.find((a) => a.id === id);
      if (!target) return;
      if (controllers.has(id)) return;
      const control = new AbortController(),
        capturedEpoch = epoch;
      controllers.set(id, control);
      const valid = () => capturedEpoch === epoch && currentAuthUser() === targetScope.ownerId;
      const patch = (value: Partial<ConversationAttachment>) => {
        if (valid()) {
          if (value.status === 'ready') {
            files.delete(id);
            const url = previews.get(id);
            if (url) URL.revokeObjectURL(url);
            previews.delete(id);
          }
          changeRow(targetKey, id, value);
        }
      };
      let acquired = false;
      try {
        while (activeUploads >= 2) await sleep(80, control.signal);
        control.signal.throwIfAborted();
        activeUploads++;
        acquired = true;
        let reference: ReferenceMedia | undefined;
        if (target.referenceId && (target.status !== 'uploading' || !files.has(id))) {
          try {
            reference = await api<ReferenceMedia>('/local/references/' + target.referenceId, {
              signal: control.signal,
            });
          } catch (error) {
            if (!(error instanceof ApiError) || error.status !== 404) throw error;
            if (probeOnly) {
              patch({
                status: 'error',
                error: '未找到已完成参考上传，请重新添加原文件或点击重试。',
              });
              return;
            }
          }
        }
        if (target.kind === 'asset' && (target.status === 'unknown' || probeOnly)) {
          try {
            const previous = await api<{ asset: Asset }>(`/api/assets/${id}/preview`, {
              signal: control.signal,
            });
            patch({
              status: 'ready',
              assetId: previous.asset.id,
              sha256: previous.asset.sha256,
              error: undefined,
            });
            return;
          } catch (error) {
            if (!(error instanceof ApiError) || error.status !== 404) throw error;
            const transfers = await api<{ id: string; status: string }[]>('/api/assets/transfers', {
              signal: control.signal,
            });
            if (transfers.some((t) => t.id === id)) {
              patch({
                status: 'unknown',
                error: '上传结果尚待核对，未重复上传；可稍后重试或在资料空间核查。',
              });
              return;
            }
            if (probeOnly) {
              patch({ status: 'error', error: '未找到已完成上传，请重新选择原文件或点击重试。' });
              return;
            }
          }
        }
        if (!reference) {
          const file = files.get(id);
          if (!file) {
            patch({ status: 'error', error: '原文件未留在内存中，请重新添加。' });
            return;
          }
          patch({ status: 'uploading', error: undefined });
          const body = new FormData();
          body.append('file', file);
          if (target.kind === 'asset') {
            const asset = await api<Asset>('/api/assets', {
              method: 'POST',
              body,
              headers: { 'x-lightmao-upload-intent': id },
              signal: control.signal,
            });
            patch({ status: 'ready', assetId: asset.id, sha256: asset.sha256, error: undefined });
            return;
          }
          reference = await api<ReferenceMedia>(
            `/local/projects/${targetScope.projectId}/references`,
            {
              method: 'POST',
              body,
              headers: { 'x-lightmao-upload-intent': id },
              signal: control.signal,
            },
          );
          patch({
            referenceId: reference.id,
            status: reference.status === 'ready' ? 'ready' : 'processing',
            sha256: reference.sha256,
          });
        }
        while (reference.status === 'preparing') {
          patch({ status: 'processing' });
          await sleep(700, control.signal);
          reference = await api<ReferenceMedia>('/local/references/' + reference.id, {
            signal: control.signal,
          });
        }
        if (reference.status !== 'ready') throw Error(reference.error || '参考媒体尚未处理完成');
        patch({
          referenceId: reference.id,
          sha256: reference.sha256,
          status: 'ready',
          error: undefined,
        });
      } catch (error) {
        if (valid())
          patch({
            status: control.signal.aborted
              ? 'unknown'
              : error instanceof ApiError && error.status >= 400 && error.status < 500
                ? 'error'
                : 'unknown',
            error: control.signal.aborted
              ? '已停止等待；下次先核对原上传结果。'
              : error instanceof Error
                ? error.message
                : '附件处理失败',
          });
      } finally {
        if (acquired) activeUploads--;
        if (controllers.get(id) === control) controllers.delete(id);
        releaseMirror(targetKey);
      }
    },
    [changeRow],
  );
  useEffect(() => {
    if (options.persistent && (!mirrors.has(key) || restoringKey === key)) return;
    for (const a of read(key).attachments)
      if (
        (a.status === 'unknown' && a.kind === 'asset') ||
        (a.kind === 'reference' && a.referenceId && a.status !== 'ready')
      )
        void upload(key, scope, a.id, true);
    return () => {
      if (!currentAuthUser() || currentAuthUser() !== scope.ownerId) clear();
    };
  }, [key, scope.ownerId, upload, options.persistent, restoringKey]);
  useDesktopShortcuts({
    onFocusComposer: () => composerRef.current?.focus({ preventScroll: true }),
    onNewSession: () => latest.current.onNewSession(),
    onEscape: () => {
      setDragging(false);
      dragDepth.current = 0;
      latest.current.onEscape?.();
    },
    disabled: options.disabled,
  });
  const addFiles = useCallback(
    (incoming: File[] | FileList) => {
      const value = latest.current,
        targetScope = value.scope,
        targetKey = conversationStateKey(targetScope);
      if (value.persistent && (!mirrors.has(targetKey) || restoringKey === targetKey)) {
        value.notify('正在恢复本会话草稿，请稍后添加附件。');
        return;
      }
      if (
        value.disabled ||
        !targetScope.sessionId ||
        !targetScope.projectId ||
        currentAuthUser() !== targetScope.ownerId
      )
        return;
      const rows = read(targetKey).attachments,
        remaining = MAX_ATTACHMENTS - rows.length;
      const candidates = Array.from(incoming);
      if (candidates.length > remaining) value.notify('一条消息最多添加8个附件；超出部分未添加。');
      for (const file of candidates.slice(0, remaining)) {
        const kind = mediaFile(file) ? 'reference' : 'asset';
        const bytesLimit = kind === 'reference' ? 256 * 1024 * 1024 : 20 * 1024 * 1024;
        if (!accepted(file) || !file.size || file.size > bytesLimit) {
          value.notify(
            !accepted(file)
              ? '暂不支持该格式，请添加图片、文档、代码、视频或音频。'
              : !file.size
                ? '空文件不能作为附件。'
                : `${file.name} 超过${kind === 'reference' ? '256' : '20'}MiB限制。`,
          );
          continue;
        }
        const id = crypto.randomUUID();
        files.set(id, file);
        if (imageFile(file)) previews.set(id, URL.createObjectURL(file));
        update(targetKey, (d) => ({
          ...d,
          attachments: [
            ...d.attachments,
            {
              id,
              name: file.name.slice(0, 180),
              mime: file.type,
              bytes: file.size,
              kind,
              status: 'uploading',
              ...(kind === 'reference' ? { referenceId: id } : {}),
            },
          ],
        }));
        void upload(targetKey, targetScope, id);
      }
    },
    [upload, restoringKey],
  );
  const removeAttachment = useCallback(
    (id: string) => {
      controllers.get(id)?.abort();
      files.delete(id);
      const url = previews.get(id);
      if (url) URL.revokeObjectURL(url);
      previews.delete(id);
      update(currentKey.current, (d) => ({
        ...d,
        attachments: d.attachments.filter((a) => a.id !== id),
      }));
      composerRef.current?.focus();
    },
    [composerRef],
  );
  const attachReference = useCallback(
    async (referenceId: string) => {
      const value = latest.current,
        captured = epoch,
        targetScope = value.scope,
        targetKey = conversationStateKey(targetScope);
      if (value.disabled || currentAuthUser() !== targetScope.ownerId) return;
      const ref = await api<ReferenceMedia>('/local/references/' + encodeURIComponent(referenceId));
      if (
        captured !== epoch ||
        currentAuthUser() !== targetScope.ownerId ||
        ref.projectId !== targetScope.projectId
      )
        throw Error('参考资料不属于当前项目');
      if (read(targetKey).attachments.some((a) => a.referenceId === ref.id)) {
        value.notify('这份参考已引用到当前消息。');
        return;
      }
      if (read(targetKey).attachments.length >= MAX_ATTACHMENTS) {
        value.notify('一条消息最多添加8个附件。');
        return;
      }
      const id = crypto.randomUUID();
      update(targetKey, (d) => ({
        ...d,
        attachments: [
          ...d.attachments,
          {
            id,
            kind: 'reference',
            referenceId: ref.id,
            name: ref.name,
            mime: ref.mime,
            bytes: ref.bytes,
            sha256: ref.sha256,
            status: ref.status === 'ready' ? 'ready' : 'processing',
          },
        ],
      }));
      if (ref.status !== 'ready') void upload(targetKey, targetScope, id, true);
      if (currentKey.current === targetKey) composerRef.current?.focus({ preventScroll: true });
    },
    [upload, composerRef],
  );
  const retryAttachment = useCallback(
    (id: string) => {
      void upload(currentKey.current, latest.current.scope, id);
    },
    [upload],
  );
  const setPrompt = useCallback(
    (text: string) =>
      update(currentKey.current, (d) => ({ ...d, text: text.slice(0, MAX_DRAFT_LENGTH) })),
    [],
  );
  const prepareSend = useCallback(() => {
    const sentKey = currentKey.current,
      sent = read(sentKey),
      sentIds = new Set(sent.attachments.map((a) => a.id));
    return () => {
      for (const a of sent.attachments) {
        files.delete(a.id);
        const url = previews.get(a.id);
        if (url) URL.revokeObjectURL(url);
        previews.delete(a.id);
      }
      update(sentKey, (current) => ({
        ...current,
        text: current.text === sent.text ? '' : current.text,
        attachments: current.attachments.filter((a) => !sentIds.has(a.id)),
      }));
      if (currentKey.current === sentKey) composerRef.current?.focus({ preventScroll: true });
    };
  }, [composerRef]);
  const clearAfterSend = useCallback(() => prepareSend()(), [prepareSend]);
  const attachments = snapshot.attachments.map((a) => ({ ...a, previewUrl: previews.get(a.id) }));
  const restoring = !!options.persistent && (!mirrors.has(key) || restoringKey === key);
  return {
    prompt: snapshot.text,
    setPrompt,
    attachments,
    assetIds: attachments.flatMap((a) => (a.status === 'ready' && a.assetId ? [a.assetId] : [])),
    referenceIds: attachments.flatMap((a) =>
      a.status === 'ready' && a.referenceId ? [a.referenceId] : [],
    ),
    canSend: !restoring && attachments.every((a) => a.status === 'ready'),
    restoring,
    uploading: attachments.some((a) => ['uploading', 'processing'].includes(a.status)),
    addFiles,
    attachReference,
    removeAttachment,
    retryAttachment,
    clearAfterSend,
    prepareSend,
    dragging,
    fileInputRef,
    openFiles: () => fileInputRef.current?.click(),
    dropProps: {
      onDragEnter: (event: DragEvent) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        dragDepth.current++;
        setDragging(true);
      },
      onDragOver: (event: DragEvent) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = latest.current.disabled ? 'none' : 'copy';
      },
      onDragLeave: (event: DragEvent) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      },
      onDrop: (event: DragEvent) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        event.stopPropagation();
        dragDepth.current = 0;
        setDragging(false);
        addFiles(event.dataTransfer.files);
      },
    },
    pasteProps: {
      onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => {
        const images = Array.from(event.clipboardData.items)
          .filter((v) => v.kind === 'file' && v.type.startsWith('image/'))
          .map((v) => v.getAsFile())
          .filter((v): v is File => !!v);
        if (!images.length) return;
        event.preventDefault();
        addFiles(
          images.map(
            (f, i) =>
              new File(
                [f],
                `截图-${new Date().toISOString().replace(/[:.]/g, '-')}-${i + 1}.${f.type === 'image/jpeg' ? 'jpg' : 'png'}`,
                { type: f.type || 'image/png' },
              ),
          ),
        );
      },
    },
  };
}
