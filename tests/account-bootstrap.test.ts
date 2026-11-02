import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApi } from '../apps/api/server.ts';
import type { ObjectStorage } from '../apps/api/object-storage.ts';
import type { CloudBootstrap, Plugin, Skill, User } from '../packages/shared/types.ts';
import { catalog, defaultSkills } from '../packages/shared/catalog.ts';

class UnavailableStorage implements ObjectStorage {
  readonly driver = 'oss';
  writes = 0;
  reads = 0;
  async put() {
    this.writes++;
    throw Error('Object storage deliberately unavailable');
  }
  async get(): Promise<Buffer> {
    this.reads++;
    throw Error('Object storage deliberately unavailable');
  }
  async stream(): Promise<never> {
    this.reads++;
    throw Error('Object storage deliberately unavailable');
  }
  async remove() {
    throw Error('Object storage deliberately unavailable');
  }
}
const password = 'Account-bootstrap-fixture-2026';
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'lightmao-account-bootstrap-'));
  const storage = new UnavailableStorage();
  const api = await createApi({
    dataDir: dir,
    objectStorage: storage,
    adminEmail: 'admin@example.test',
    adminPassword: password,
    permissionMode: 'custom', // Explicit saved selections; normal startup is tested separately.
  });
  return {
    ...api,
    storage,
    async close() {
      await api.app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('account login and standalone admin bootstrap remain available with failed storage and do not create cloud samples or reconcile unrelated uploads', async () => {
  const f = await fixture();
  try {
    const login = await f.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@example.test', password },
    });
    assert.equal(login.statusCode, 200, login.body);
    const auth = login.json();
    // A preexisting ambiguous upload must not turn account startup into remote
    // object reconciliation. It remains pending for the resource workspace.
    f.store.put('asset-transfer', auth.user.id, {
      id: randomUUID(),
      ownerId: auth.user.id,
      status: 'unknown',
      asset: {
        id: randomUUID(),
        name: 'pending.md',
        object: { driver: 'oss', key: auth.user.id + '/' + randomUUID() },
      },
    });
    const account = await f.app.inject({
      url: '/api/account/bootstrap',
      headers: { authorization: 'Bearer ' + auth.token },
    });
    assert.equal(account.statusCode, 200, account.body);
    assert.equal(account.headers['cache-control'], 'no-store');
    const body = account.json<CloudBootstrap>();
    assert.equal(body.user.id, auth.user.id);
    assert.equal(body.user.role, 'admin');
    assert.deepEqual(body.assets, []);
    assert.equal(
      (
        await f.app.inject({
          url: '/api/admin/overview?summary=true',
          headers: { authorization: 'Bearer ' + auth.token },
        })
      ).statusCode,
      200,
    );
    assert.equal(f.storage.writes, 0);
    assert.equal(f.storage.reads, 0);
    assert.equal(f.store.list('asset').length, 0);
    assert.equal(f.store.list('asset-transfer').length, 1);
    assert(!account.body.includes(password));
  } finally {
    await f.close();
  }
});

test('registration seeds only durable metadata; concurrent first workspace bootstrap preserves selections and adds no automatic production cloud writes', async () => {
  const f = await fixture();
  try {
    const registered = await f.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { name: 'Member', email: 'member@example.test', password },
    });
    assert.equal(registered.statusCode, 200, registered.body);
    const auth = registered.json(),
      headers = { authorization: 'Bearer ' + auth.token };
    const writer = f.store
      .list<Plugin & { catalogId: string }>('plugin', auth.user.id)
      .find((v) => v.catalogId === 'writer')!;
    assert(writer);
    f.store.put('plugin', auth.user.id, { ...writer, installed: true, enabled: false });
    const [a, b] = await Promise.all([
      f.app.inject({ url: '/api/bootstrap', headers }),
      f.app.inject({ url: '/api/bootstrap', headers }),
    ]);
    assert.equal(a.statusCode, 200, a.body);
    assert.equal(b.statusCode, 200, b.body);
    const bootstrap = a.json<CloudBootstrap>();
    assert.equal(bootstrap.assets.length, 0);
    assert.equal(f.storage.writes, 0);
    assert.equal(f.storage.reads, 0);
    assert.equal(f.store.list<Skill>('skill', auth.user.id).length, defaultSkills.length);
    assert.equal(f.store.list<Plugin>('plugin', auth.user.id).length, catalog.length);
    assert.equal(bootstrap.plugins.find((v) => v.id === 'writer')?.installed, true);
    assert.equal(bootstrap.plugins.find((v) => v.id === 'writer')?.enabled, false);
    const account = await f.app.inject({ url: '/api/account/bootstrap', headers });
    assert.equal(account.statusCode, 200);
    const device = f.auth.device(
      f.auth.authenticate(headers.authorization),
      randomUUID(),
      'fixture device',
    );
    assert.equal(
      (
        await f.app.inject({
          url: '/api/account/bootstrap',
          headers: { authorization: 'Bearer ' + device.token },
        })
      ).statusCode,
      403,
    );
    const login = await f.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'member@example.test', password },
    });
    assert.equal(login.statusCode, 200);
    assert.equal(f.store.list<Skill>('skill', auth.user.id).length, defaultSkills.length);
    assert.equal(f.store.list<User>('user').length, 2);
  } finally {
    await f.close();
  }
});
