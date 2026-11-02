import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  conversationStateKey,
  writeConversationDraft,
  readConversationDraft,
  clearConversationOwner,
  writeConversationPosition,
  readConversationPosition,
} from '../apps/web/src/features/desktop-session-state.ts';
class Storage {
  values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  getItem(k: string) {
    return this.values.get(k) || null;
  }
  setItem(k: string, v: string) {
    this.values.set(k, v);
  }
  removeItem(k: string) {
    this.values.delete(k);
  }
  key(i: number) {
    return [...this.values.keys()][i] || null;
  }
}
test('desktop draft metadata stays isolated across backend/account/session and never persists image bytes or blob URLs', () => {
  const storage = new Storage(),
    a = { backendId: 'backend-A', ownerId: 'alice', projectId: 'game', sessionId: 'design' },
    key = conversationStateKey(a);
  writeConversationDraft(storage, key, {
    text: '保留草稿',
    updatedAt: 101,
    attachments: [
      {
        id: 'upload-id',
        kind: 'asset',
        name: '画面.png',
        mime: 'image/png',
        bytes: 123,
        status: 'uploading',
        previewUrl: 'blob:private-image',
        rawBytes: 'data:image/png;base64,never-save-this',
      } as any,
    ],
  });
  assert(!storage.getItem(key)?.includes('blob:'));
  assert(!storage.getItem(key)?.includes('never-save-this'));
  assert.equal(readConversationDraft(storage, key).text, '保留草稿');
  assert.equal(readConversationDraft(storage, key).attachments[0].status, 'unknown');
  for (const change of [
    { backendId: 'backend-B' },
    { ownerId: 'bob' },
    { projectId: 'other' },
    { sessionId: 'other' },
  ])
    assert.equal(
      readConversationDraft(storage, conversationStateKey({ ...a, ...change })).text,
      '',
    );
  const b = conversationStateKey({ ...a, ownerId: 'bob', projectId: 'alice' });
  writeConversationDraft(storage, b, { text: 'Bob draft', attachments: [], updatedAt: 102 });
  writeConversationPosition(storage, key, {
    top: 241,
    following: false,
    focused: true,
    selectionStart: 1,
    selectionEnd: 3,
  });
  assert.equal(readConversationPosition(storage, key)?.top, 241);
  clearConversationOwner(storage, 'alice');
  assert.equal(readConversationDraft(storage, key).text, '');
  assert.equal(readConversationPosition(storage, key), undefined);
  assert.equal(
    readConversationDraft(storage, b).text,
    'Bob draft',
    'owner names inside another project key must not clear that owner',
  );
});
