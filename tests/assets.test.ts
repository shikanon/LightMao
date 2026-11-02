import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createApi } from '../apps/api/server.ts';
import type { ObjectStorage } from '../apps/api/object-storage.ts';
import { AssetService } from '../apps/api/assets.ts';
import type { Asset, AssetFolder, CloudBootstrap } from '../packages/shared/types.ts';

class TestStorage implements ObjectStorage {
  readonly driver = 'oss';
  objects = new Map<string, Buffer>();
  writes = 0;
  uncertain = false;
  async put(key: string, data: Buffer) {
    this.writes++;
    await delay(10);
    this.objects.set(key, data);
    if (this.uncertain) throw new Error('lost response after commit');
  }
  async get(key: string) {
    const data = this.objects.get(key);
    if (!data) throw Object.assign(new Error('not found'), { code: 'NoSuchKey', status: 404 });
    return data;
  }
  async stream(key: string) {
    return Readable.from(await this.get(key));
  }
  async remove(key: string) {
    this.objects.delete(key);
  }
}
test('conversation uploads retain one owner-bound intent across explicit retries and reconcile unknown storage outcomes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lm-conversation-upload-')),
    storage = new TestStorage();
  const api = await createApi({ dataDir: dir, demo: true, objectStorage: storage });
  await api.app.listen({ host: '127.0.0.1', port: 0 });
  const base = api.app.listeningOrigin;
  const alice = (
    await api.app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} })
  ).json();
  const bob = await api.auth.createUser(
    'Upload Bob',
    'upload-bob@example.test',
    'Upload-test-pass-2026',
    'member',
  );
  const bobLogin = (
    await api.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: bob.email, password: 'Upload-test-pass-2026' },
    })
  ).json();
  const upload = async (
    intent: string,
    token = alice.token,
    name = 'proof.txt',
    mime = 'text/plain',
    text = 'actual-file',
  ) => {
    const body = new FormData();
    body.append('file', new Blob([text], { type: mime }), name);
    return fetch(base + '/api/assets', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'x-lightmao-upload-intent': intent },
      body,
    });
  };
  try {
    const intent = randomUUID(),
      first = await upload(intent),
      before = storage.writes;
    assert.equal(first.status, 200);
    assert.equal(((await first.json()) as Asset).id, intent);
    assert.equal((await upload(intent)).status, 200);
    assert.equal(storage.writes, before);
    assert.equal((await upload(intent, alice.token, 'changed.txt')).status, 409);
    assert.equal((await upload(intent, alice.token, 'proof.txt', 'application/json')).status, 409);
    assert.equal(
      (await upload(intent, alice.token, 'proof.txt', 'text/plain', 'different')).status,
      409,
    );
    assert.equal((await upload(intent, bobLogin.token)).status, 409);
    assert.equal(storage.writes, before);
    const unknown = randomUUID();
    storage.uncertain = true;
    assert.equal((await upload(unknown)).status, 503);
    const writes = storage.writes;
    assert.equal((await upload(unknown)).status, 409);
    assert.equal(storage.writes, writes);
    storage.uncertain = false;
    const reconcile = await api.app.inject({
      method: 'POST',
      url: '/api/assets/reconcile',
      headers: { authorization: 'Bearer ' + alice.token },
      payload: {},
    });
    assert.equal(reconcile.statusCode, 200);
    assert.equal((await upload(unknown)).status, 200);
    assert.equal(storage.writes, writes);
  } finally {
    await api.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('cloud library lifecycle: folder isolation, move, authenticated media, trash, restore and purge', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lightmao-assets-')),
    storage = new TestStorage();
  const server = await createApi({ dataDir: dir, demo: true, objectStorage: storage });
  await server.app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(server.app.server.address() as { port: number }).port}`;
  const call = async <T>(path: string, token = '', body?: unknown, method?: string): Promise<T> => {
    const r = await fetch(base + path, {
      method: method || (body ? 'POST' : 'GET'),
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? (body instanceof FormData ? body : JSON.stringify(body)) : undefined,
    });
    const data = await r.json();
    if (!r.ok) throw Object.assign(new Error(data.error), { status: r.status });
    return data as T;
  };
  try {
    const alice = await call<{ token: string }>('/api/auth/demo', '', {});
    const bob = await call<{ token: string }>('/api/auth/register', '', {
      name: 'Bob',
      email: 'bob@example.test',
      password: 'test-password-12345',
    });
    const root = await call<AssetFolder>('/api/asset-folders', alice.token, { name: '关卡' });
    const child = await call<AssetFolder>('/api/asset-folders', alice.token, {
      name: '参考',
      parentId: root.id,
    });
    await assert.rejects(
      () => call(`/api/asset-folders/${root.id}`, alice.token, { parentId: child.id }, 'PATCH'),
      { status: 409 },
    );
    await assert.rejects(
      () => call('/api/asset-folders', bob.token, { name: 'escape', parentId: root.id }),
      { status: 404 },
    );
    const data = new FormData();
    data.append('folderId', child.id);
    data.append('file', new Blob(['preview-fixture'], { type: 'image/png' }), 'test.png');
    const asset = await call<Asset>('/api/assets', alice.token, data);
    assert.equal(asset.folderId, child.id);
    assert(!('object' in asset));
    const raw = await fetch(`${base}/api/assets/${asset.id}/content`, {
      headers: { Authorization: `Bearer ${alice.token}` },
    });
    assert.equal(raw.headers.get('content-type'), 'image/png');
    assert.equal(await raw.text(), 'preview-fixture');
    await assert.rejects(() => call(`/api/assets/${asset.id}/preview`, bob.token), { status: 404 });
    await assert.rejects(() => call(`/api/assets/${asset.id}`, bob.token, {}, 'PATCH'), {
      status: 404,
    });
    await assert.rejects(
      () => call(`/api/assets/${asset.id}`, alice.token, { folderId: 'missing' }, 'PATCH'),
      { status: 404 },
    );
    await call(
      `/api/assets/${asset.id}`,
      alice.token,
      { name: 'renamed.png', folderId: null },
      'PATCH',
    );
    let bootstrap = await call<CloudBootstrap>('/api/bootstrap', alice.token);
    assert.equal(bootstrap.storage?.driver, 'oss');
    assert.equal(bootstrap.assets.find((a) => a.id === asset.id)?.folderId, undefined);
    await call(`/api/assets/${asset.id}`, alice.token, undefined, 'DELETE');
    await assert.rejects(() => call(`/api/assets/${asset.id}/preview`, alice.token), {
      status: 404,
    });
    assert((await call<Asset[]>('/api/assets/trash', alice.token)).some((a) => a.id === asset.id));
    await assert.rejects(() => call(`/api/assets/${asset.id}/restore`, bob.token, {}), {
      status: 404,
    });
    await call(`/api/assets/${asset.id}/restore`, alice.token, {});
    const download = await fetch(`${base}/api/assets/${asset.id}/download`, {
      headers: { Authorization: `Bearer ${alice.token}` },
    });
    assert.equal(await download.text(), 'preview-fixture');
    await call(`/api/assets/${asset.id}`, alice.token, undefined, 'DELETE');
    const count = storage.objects.size;
    await call(`/api/assets/${asset.id}/purge`, alice.token, undefined, 'DELETE');
    assert.equal(storage.objects.size, count - 1);
    bootstrap = await call<CloudBootstrap>('/api/bootstrap', alice.token);
    assert(!bootstrap.assets.some((a) => a.id === asset.id));
    await call(`/api/asset-folders/${child.id}`, alice.token, undefined, 'DELETE');
    await call(`/api/asset-folders/${root.id}`, alice.token, undefined, 'DELETE');
  } finally {
    await server.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('ambiguous object upload is reconciled by hash without repeating a PUT; quota is serialized', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lightmao-storage-')),
    storage = new TestStorage();
  const server = await createApi({ dataDir: dir, objectStorage: storage });
  try {
    storage.uncertain = true;
    await assert.rejects(
      () => server.assets.upload('alice', 'pending.md', 'text/plain', Buffer.from('written once')),
      { statusCode: 503 },
    );
    const writes = storage.writes;
    const recovered = new AssetService(server.store, server.assets.local, storage);
    await recovered.reconcile('alice');
    assert.equal(storage.writes, writes);
    assert.equal(recovered.list('alice').length, 1);
    assert.equal(server.store.list('asset-transfer', 'alice').length, 0);
    await assert.rejects(
      () => recovered.upload('missing', 'not-written.md', 'text/plain', Buffer.from('missing')),
      { statusCode: 503 },
    );
    storage.objects.clear();
    const beforeReconcile = storage.writes;
    await recovered.reconcile('missing');
    assert.equal(storage.writes, beforeReconcile);
    assert.equal(
      server.store.list<{ status: string }>('asset-transfer', 'missing')[0].status,
      'failed',
    );
    storage.uncertain = false;
    server.store.put('asset', 'quota-user', {
      id: 'filler',
      name: 'reserved',
      size: recovered.quotaBytes - 15,
    });
    const before = storage.writes;
    const uploads = await Promise.allSettled(
      [1, 2].map((n) =>
        recovered.upload('quota-user', `file-${n}.txt`, 'text/plain', Buffer.alloc(10)),
      ),
    );
    assert.equal(uploads.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(storage.writes, before + 1);
  } finally {
    await server.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
