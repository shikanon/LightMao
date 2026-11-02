import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApi, type ApiOptions } from '../apps/api/server.ts';
import { apiRuntime } from '../apps/api/config.ts';
import { catalog } from '../packages/shared/catalog.ts';
import type { Audit, CloudBootstrap, Plugin, User } from '../packages/shared/types.ts';

type Login = { token: string; user: User };
async function fixture(options: Partial<ApiOptions> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'lightmao-permissions-'));
  let api = await createApi({ ...options, dataDir: dir, demo: true });
  const response = await api.app.inject({
    method: 'POST',
    url: '/api/auth/demo',
    payload: {},
  });
  assert.equal(response.statusCode, 200, response.body);
  const login = response.json<Login>();
  return {
    get api() {
      return api;
    },
    login,
    call(url: string, payload?: object, token = login.token, method?: 'GET' | 'POST' | 'PATCH') {
      return api.app.inject({
        method: method || (payload === undefined ? 'GET' : 'PATCH'),
        url,
        headers: token ? { authorization: `Bearer ${token}` } : {},
        payload,
      });
    },
    async restart(overrides: Partial<ApiOptions> = {}) {
      await api.app.close();
      api = await createApi({ ...options, ...overrides, dataDir: dir, demo: true });
    },
    async close() {
      await api.app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('fresh startup grants all registered built-ins without executing unconfigured providers', async () => {
  const f = await fixture();
  try {
    for (const path of ['/api/bootstrap', '/api/account/bootstrap']) {
      const response = await f.call(path);
      assert.equal(response.statusCode, 200, response.body);
      const cloud = response.json<CloudBootstrap>();
      assert.deepEqual(cloud.permissions, { mode: 'full', revision: 0 });
      assert.equal(cloud.features?.permissionDefaults, true);
      if (path === '/api/bootstrap') {
        assert.equal(cloud.plugins.length, catalog.length);
        assert(cloud.plugins.every((p) => p.available && p.installed && p.enabled));
        for (const base of catalog)
          assert.deepEqual(cloud.plugins.find((p) => p.id === base.id)?.tools, base.tools);
      }
    }
    assert.equal((await f.call('/api/health')).json().features.permissionDefaults, true);
    for (const kind of ['image', 'video']) {
      const response = await f.call(
        '/api/generations',
        {
          requestId: randomUUID(),
          kind,
          name: '权限验证素材',
          projectId: randomUUID(),
          sessionId: randomUUID(),
          prompt: 'game asset protocol fixture',
        },
        f.login.token,
        'POST',
      );
      // Full permissions do not substitute for a configured model or start paid work.
      assert.equal(response.statusCode, 503, response.body);
    }
    assert.equal(f.api.store.list('generation').length, 0);
    assert.equal(f.api.store.list('usage').length, 0);
  } finally {
    await f.close();
  }
});

test('disabling one plugin snapshots effective full choices atomically and custom choices survive restart', async () => {
  const f = await fixture();
  try {
    const owner = f.login.user.id;
    // A pre-upgrade account has disabled rows and obsolete catalogue metadata.
    for (const base of catalog)
      f.api.store.put('plugin', owner, {
        ...base,
        id: `${owner}:${base.id}`,
        catalogId: base.id,
        name: 'obsolete catalogue label',
        tools: ['obsolete_tool'],
        installed: false,
        enabled: false,
      });
    const full = (await f.call('/api/bootstrap')).json<CloudBootstrap>();
    assert(full.plugins.every((p) => p.enabled));
    assert.equal(full.plugins.find((p) => p.id === 'writer')?.name, '文件创作');
    const audits = f.api.store.list<Audit>('audit').length;
    f.api.store.db.exec(`CREATE TRIGGER permission_write_fault BEFORE INSERT ON records
      WHEN NEW.kind = 'permissions' BEGIN SELECT RAISE(ABORT, 'test write fault'); END;`);
    const failed = await f.call('/api/plugins/writer', { enabled: false });
    assert.equal(failed.statusCode, 500);
    assert.deepEqual((await f.call('/api/permissions')).json(), { mode: 'full', revision: 0 });
    assert.equal(
      f.api.store.get<Plugin>('plugin', `${owner}:image-generation`, owner)?.enabled,
      false,
    );
    assert.equal(f.api.store.list<Audit>('audit').length, audits);
    f.api.store.db.exec('DROP TRIGGER permission_write_fault');

    const disabled = await f.call('/api/plugins/writer', { enabled: false });
    assert.equal(disabled.statusCode, 200, disabled.body);
    assert.equal(disabled.json().enabled, false);
    assert.deepEqual((await f.call('/api/permissions')).json(), { mode: 'custom', revision: 1 });
    await f.restart({ permissionMode: 'full' });
    const cloud = (await f.call('/api/bootstrap')).json<CloudBootstrap>();
    assert.deepEqual(cloud.permissions, { mode: 'custom', revision: 1 });
    for (const plugin of cloud.plugins) {
      assert.equal(plugin.installed, true, plugin.id);
      assert.equal(plugin.enabled, plugin.id !== 'writer', plugin.id);
      assert.notEqual(plugin.tools[0], 'obsolete_tool');
    }
    const saved = f.api.store.list<Audit>('audit').filter((a) => a.action === 'permissions.update');
    assert.equal(saved.length, 1);
    assert.equal(saved[0].actor, owner);
  } finally {
    await f.close();
  }
});

test('permission mode requires user authentication, checks revisions, isolates accounts, and audits changes', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call('/api/permissions', undefined, '')).statusCode, 401);
    assert.equal(
      (await f.call('/api/permissions', { mode: 'full', revision: 0 }, '')).statusCode,
      401,
    );
    const device = f.api.auth.device(
      f.api.auth.authenticate(`Bearer ${f.login.token}`),
      randomUUID(),
      'permissions protocol fixture',
    );
    const denied = await f.call('/api/permissions', { mode: 'full', revision: 0 }, device.token);
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.json().code, 'DEVICE_SCOPE_DENIED');
    for (const payload of [
      { mode: 'full' },
      { mode: 'other', revision: 0 },
      { mode: 'full', revision: -1 },
      { mode: 'full', revision: 0, owner: 'someone-else' },
    ])
      assert.equal((await f.call('/api/permissions', payload)).statusCode, 400);
    const first = await f.call('/api/permissions', { mode: 'custom', revision: 0 });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.headers['cache-control'], 'no-store');
    assert.deepEqual(first.json(), { mode: 'custom', revision: 1 });
    const stale = await f.call('/api/permissions', { mode: 'full', revision: 0 });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.deepEqual((await f.call('/api/permissions')).json(), { mode: 'custom', revision: 1 });

    const registration = await f.call(
      '/api/auth/register',
      {
        name: 'Another account',
        email: 'other@example.test',
        password: 'Account-fixture-pass-2026',
      },
      '',
      'POST',
    );
    assert.equal(registration.statusCode, 200, registration.body);
    const other = registration.json<Login>();
    assert.deepEqual((await f.call('/api/permissions', undefined, other.token)).json(), {
      mode: 'full',
      revision: 0,
    });
    const current = await f.call('/api/permissions', { mode: 'full', revision: 1 });
    assert.deepEqual(current.json(), { mode: 'full', revision: 2 });
    assert.equal(
      f.api.store.list<Audit>('audit').filter((a) => a.action === 'permissions.update').length,
      2,
    );
    await f.restart({ permissionMode: 'custom' });
    assert.deepEqual((await f.call('/api/permissions')).json(), { mode: 'full', revision: 2 });
  } finally {
    await f.close();
  }
});

test('organization withdrawal still disables tools in full mode and cannot be overridden by account settings', async () => {
  const f = await fixture();
  try {
    const withdrawn = await f.call('/api/admin/plugins/image-generation', {
      available: false,
      revision: 0,
    });
    assert.equal(withdrawn.statusCode, 200, withdrawn.body);
    const cloud = (await f.call('/api/bootstrap')).json<CloudBootstrap>();
    const image = cloud.plugins.find((p) => p.id === 'image-generation')!;
    assert.equal(image.available, false);
    assert.equal(image.enabled, false);
    assert.equal(cloud.plugins.find((p) => p.id === 'video-generation')?.enabled, true);
    assert.equal(
      (await f.call('/api/plugins/image-generation', { enabled: true })).statusCode,
      403,
    );
    assert.equal((await f.call('/api/permissions', { mode: 'full', revision: 0 })).statusCode, 200);
    assert.equal(
      (await f.call('/api/bootstrap'))
        .json<CloudBootstrap>()
        .plugins.find((p) => p.id === 'image-generation')?.enabled,
      false,
    );
    const restored = await f.call('/api/admin/plugins/image-generation', {
      available: true,
      revision: 1,
    });
    assert.equal(restored.statusCode, 200, restored.body);
    assert.equal(
      (await f.call('/api/bootstrap'))
        .json<CloudBootstrap>()
        .plugins.find((p) => p.id === 'image-generation')?.enabled,
      true,
    );
  } finally {
    await f.close();
  }
});

test('explicit custom fixture mode keeps restricted catalogue choices and runtime defaults to full', async () => {
  assert.equal(apiRuntime({}).options.permissionMode, 'full');
  assert.equal(apiRuntime({ LIGHTMAO_PERMISSION_MODE: 'custom' }).options.permissionMode, 'custom');
  assert.throws(() => apiRuntime({ LIGHTMAO_PERMISSION_MODE: 'invalid-private-value' }), {
    message: 'LIGHTMAO_PERMISSION_MODE must be full or custom',
  });
  const f = await fixture({ permissionMode: 'custom' });
  try {
    const cloud = (await f.call('/api/bootstrap')).json<CloudBootstrap>();
    assert.deepEqual(cloud.permissions, { mode: 'custom', revision: 0 });
    for (const base of catalog) {
      const plugin = cloud.plugins.find((p) => p.id === base.id)!;
      assert.equal(plugin.installed, base.installed, base.id);
      assert.equal(plugin.enabled, base.enabled, base.id);
    }
  } finally {
    await f.close();
  }
});
