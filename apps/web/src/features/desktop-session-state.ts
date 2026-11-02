export interface ConversationScope {
  backendId?: string;
  ownerId: string;
  projectId: string;
  sessionId: string;
}
export type AttachmentState = 'uploading' | 'processing' | 'ready' | 'error' | 'unknown';
export interface ConversationAttachment {
  id: string;
  kind: 'asset' | 'reference';
  name: string;
  mime: string;
  bytes: number;
  status: AttachmentState;
  assetId?: string;
  referenceId?: string;
  sha256?: string;
  error?: string;
  previewUrl?: string;
}
export interface ConversationDraft {
  text: string;
  attachments: ConversationAttachment[];
  updatedAt: number;
}
export interface ConversationPosition {
  top: number;
  following: boolean;
  focused: boolean;
  selectionStart?: number;
  selectionEnd?: number;
}
const PREFIX = 'lightmao.desktop-conversation.v1:';
export const MAX_ATTACHMENTS = 8;
export const MAX_DRAFT_LENGTH = 12000;
export const EMPTY_DRAFT: ConversationDraft = Object.freeze({
  text: '',
  attachments: [],
  updatedAt: 0,
});
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;
export function conversationStateKey(scope: ConversationScope) {
  return (
    PREFIX +
    JSON.stringify([scope.backendId || '', scope.ownerId, scope.projectId, scope.sessionId])
  );
}
function attachment(value: unknown): ConversationAttachment | undefined {
  if (!value || typeof value !== 'object') return;
  const a = value as Record<string, unknown>;
  if (
    typeof a.id !== 'string' ||
    a.id.length > 100 ||
    !['asset', 'reference'].includes(String(a.kind)) ||
    typeof a.name !== 'string' ||
    !Number.isFinite(a.bytes)
  )
    return;
  const status = ['ready', 'error', 'unknown'].includes(String(a.status))
    ? (a.status as AttachmentState)
    : 'unknown';
  return {
    id: a.id,
    kind: a.kind as 'asset' | 'reference',
    name: a.name.slice(0, 180),
    mime: typeof a.mime === 'string' ? a.mime.slice(0, 160) : '',
    bytes: Number(a.bytes),
    status,
    ...(typeof a.assetId === 'string' ? { assetId: a.assetId.slice(0, 100) } : {}),
    ...(typeof a.referenceId === 'string' ? { referenceId: a.referenceId.slice(0, 100) } : {}),
    ...(typeof a.sha256 === 'string' ? { sha256: a.sha256.slice(0, 64) } : {}),
    ...(status === 'unknown'
      ? { error: '处理曾中断，将先核对已有上传结果。' }
      : typeof a.error === 'string'
        ? { error: a.error.slice(0, 300) }
        : {}),
  };
}
export function readConversationDraft(storage: StorageLike, key: string): ConversationDraft {
  try {
    const raw = storage.getItem(key);
    if (!raw || raw.length > 32000) return EMPTY_DRAFT;
    const value = JSON.parse(raw);
    if (typeof value.text !== 'string' || !Array.isArray(value.attachments)) return EMPTY_DRAFT;
    return {
      text: value.text.slice(0, MAX_DRAFT_LENGTH),
      attachments: value.attachments
        .slice(0, MAX_ATTACHMENTS)
        .map(attachment)
        .filter((a: ConversationAttachment | undefined): a is ConversationAttachment => !!a),
      updatedAt: Number(value.updatedAt) || 0,
    };
  } catch {
    return EMPTY_DRAFT;
  }
}
export function serializeConversationDraft(value: ConversationDraft) {
  return {
    text: value.text.slice(0, MAX_DRAFT_LENGTH),
    attachments: value.attachments
      .slice(0, MAX_ATTACHMENTS)
      .map(attachment)
      .filter((a): a is ConversationAttachment => !!a),
    updatedAt: value.updatedAt || Date.now(),
  };
}
export function writeConversationDraft(
  storage: StorageLike,
  key: string,
  value: ConversationDraft,
) {
  // Persist only textual draft + bounded IDs/metadata. File bytes/object URLs stay in memory.
  const safe = serializeConversationDraft(value);
  try {
    storage.setItem(key, JSON.stringify(safe));
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k?.startsWith(PREFIX) && !k.endsWith(':position')) keys.push(k);
    }
    if (keys.length > 48) {
      const old = keys
        .filter((k) => k !== key)
        .map((k) => ({ key: k, at: readConversationDraft(storage, k).updatedAt }))
        .sort((a, b) => a.at - b.at);
      for (const row of old.slice(0, keys.length - 48)) {
        storage.removeItem(row.key);
        storage.removeItem(row.key + ':position');
      }
    }
  } catch {
    /* A full/disabled browser store never prevents composing. */
  }
}
export function clearConversationOwner(storage: StorageLike, ownerId?: string) {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(PREFIX)) keys.push(key);
  }
  for (const key of keys) {
    try {
      const scope = JSON.parse(key.slice(PREFIX.length).replace(/:position$/, ''));
      if (!ownerId || scope[1] === ownerId) storage.removeItem(key);
    } catch {
      storage.removeItem(key);
    }
  }
}
export function readConversationPosition(
  storage: StorageLike,
  key: string,
): ConversationPosition | undefined {
  try {
    const p = JSON.parse(storage.getItem(key + ':position') || 'null');
    if (!p || !Number.isFinite(p.top) || typeof p.following !== 'boolean') return;
    return {
      top: Math.max(0, p.top),
      following: p.following,
      focused: p.focused === true,
      ...(Number.isInteger(p.selectionStart)
        ? { selectionStart: Math.max(0, Math.min(16000, p.selectionStart)) }
        : {}),
      ...(Number.isInteger(p.selectionEnd)
        ? { selectionEnd: Math.max(0, Math.min(16000, p.selectionEnd)) }
        : {}),
    };
  } catch {
    return;
  }
}
export function writeConversationPosition(
  storage: StorageLike,
  key: string,
  value: ConversationPosition,
) {
  try {
    storage.setItem(key + ':position', JSON.stringify(value));
  } catch {}
}
