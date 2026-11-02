import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createApi } from '../apps/api/server.ts';
import type { DeviceAuthorization, LoginSession, User } from '../packages/shared/types.ts';

const cookie = (header: string | string[] | undefined) => String(header || '').split(';')[0];
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
type Login = { token: string; user: User; expiresAt: string };

test('access expiry, HttpOnly refresh rotation, concurrent-tab grace and replay revocation persist correctly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lightmao-refresh-'));
  let time = Date.now();
  let server = await createApi({
    dataDir: dir,
    demo: true,
    secureCookies: true,
    auth: { now: () => time, accessTtlMs: 1000, refreshGraceMs: 5000 },
  });
  try {
    const response = await server.app.inject({
        method: 'POST',
        url: '/api/auth/demo',
        payload: {},
      }),
      login = response.json<Login>(),
      firstCookie = cookie(response.headers['set-cookie']);
    assert.match(String(response.headers['set-cookie']), /HttpOnly; SameSite=Strict/);
    assert.match(String(response.headers['set-cookie']), /; Secure/);
    assert(!('refreshToken' in login));
    assert.equal(response.headers['cache-control'], 'no-store');
    time += 1001;
    assert.equal(
      (await server.app.inject({ url: '/api/me', headers: auth(login.token) })).statusCode,
      401,
    );
    const refresh = await server.app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { cookie: firstCookie },
      payload: {},
    });
    assert.equal(refresh.statusCode, 200);
    const rotated = refresh.json<Login>(),
      secondCookie = cookie(refresh.headers['set-cookie']);
    assert.notEqual(firstCookie, secondCookie);
    assert.equal(
      (await server.app.inject({ url: '/api/me', headers: auth(rotated.token) })).statusCode,
      200,
    );
    const same = await server.app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { cookie: firstCookie },
      payload: {},
    });
    assert.equal(same.statusCode, 200);
    assert.equal(
      same.headers['set-cookie'],
      undefined,
      'parallel response must not overwrite the new cookie',
    );
    await server.app.close();
    server = await createApi({
      dataDir: dir,
      demo: true,
      auth: { now: () => time, accessTtlMs: 1000, refreshGraceMs: 5000 },
    });
    const continued = await server.app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { cookie: secondCookie },
      payload: {},
    });
    assert.equal(continued.statusCode, 200);
    const current = continued.json<Login>();
    const replay = await server.app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { cookie: firstCookie },
      payload: {},
    });
    assert.equal(replay.statusCode, 401);
    assert.equal(
      replay.json().code,
      'REFRESH_REUSED',
      'only the immediately previous token gets grace',
    );
    assert.equal(
      (await server.app.inject({ url: '/api/me', headers: auth(current.token) })).statusCode,
      401,
    );
    assert.equal(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/auth/refresh',
          headers: { cookie: cookie(continued.headers['set-cookie']) },
          payload: {},
        })
      ).statusCode,
      401,
    );
    const serialized =
      JSON.stringify(server.store.list('token')) +
      JSON.stringify(server.store.list('auth-refresh'));
    for (const raw of [login.token, rotated.token, current.token, firstCookie.split('=')[1]])
      assert(!serialized.includes(raw));
    const origin = await server.app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { origin: 'https://untrusted.example', cookie: firstCookie },
      payload: {},
    });
    assert.equal(origin.statusCode, 403);
  } finally {
    await server.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('device authorization survives web logout, stays scoped and owner-isolated, and revocation invalidates its issuer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lightmao-device-'));
  const server = await createApi({ dataDir: dir, demo: true });
  try {
    const first = await server.app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} }),
      a = first.json<Login>();
    const second = await server.app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} }),
      a2 = second.json<Login>();
    const member = (
      await server.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { name: 'Member', email: 'member@example.test', password: 'fixture-password-123' },
      })
    ).json<Login>();
    const granted = await server.app.inject({
      method: 'POST',
      url: '/api/auth/device',
      headers: auth(a.token),
      payload: { deviceId: randomUUID(), label: 'Test laptop' },
    });
    assert.equal(granted.statusCode, 200);
    const device = granted.json<{ token: string; grant: DeviceAuthorization }>();
    assert.equal(
      (await server.app.inject({ url: '/api/bootstrap', headers: auth(device.token) })).statusCode,
      200,
    );
    for (const [method, url] of [
      ['GET', '/api/admin/overview'],
      ['GET', '/api/account/sessions'],
      ['PATCH', '/api/account/profile'],
      ['POST', '/api/auth/device'],
      ['POST', '/api/assets'],
    ] as const) {
      const r = await server.app.inject({
        method,
        url,
        headers: auth(device.token),
        ...(method === 'POST' || method === 'PATCH' ? { payload: {} } : {}),
      });
      assert.equal(r.statusCode, 403, `${method} ${url} must be denied`);
    }
    const model = await server.app.inject({
      method: 'POST',
      url: '/api/v1/chat/completions',
      headers: auth(device.token),
      payload: { model: 'doubao', messages: [{ role: 'user', content: 'test' }] },
    });
    assert.equal(
      model.statusCode,
      503,
      'device can reach model route, which is deliberately unconfigured',
    );
    assert.equal(
      (
        await server.app.inject({
          method: 'DELETE',
          url: `/api/account/devices/${device.grant.id}`,
          headers: auth(member.token),
        })
      ).statusCode,
      404,
    );
    await server.app.inject({
      method: 'POST',
      url: '/api/logout',
      headers: auth(a.token),
      payload: {},
    });
    assert.equal(
      (await server.app.inject({ url: '/api/me', headers: auth(a.token) })).statusCode,
      401,
    );
    assert.equal(
      (await server.app.inject({ url: '/api/me', headers: auth(device.token) })).statusCode,
      200,
      'background execution is independent of web logout',
    );
    const devices = await server.app.inject({
      url: '/api/account/devices',
      headers: auth(a2.token),
    });
    assert(!devices.body.includes(device.token));
    assert(!devices.body.includes('tokenHash'));
    assert(!devices.body.includes('issuerTokenId'));
    assert.equal(
      (
        await server.app.inject({
          method: 'DELETE',
          url: `/api/account/devices/${device.grant.id}`,
          headers: auth(a2.token),
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await server.app.inject({ url: '/api/me', headers: auth(device.token) })).statusCode,
      401,
    );
    assert.equal(
      (await server.app.inject({ url: '/api/me', headers: auth(a2.token) })).statusCode,
      200,
      'another login stays active',
    );
    const renewed = (
      await server.app.inject({
        method: 'POST',
        url: '/api/auth/device',
        headers: auth(a2.token),
        payload: { deviceId: device.grant.deviceId, label: 'Renewed laptop' },
      })
    ).json<{ token: string; grant: DeviceAuthorization }>();
    assert.equal(renewed.grant.id, device.grant.id);
    await server.app.inject({
      method: 'DELETE',
      url: `/api/account/devices/${device.grant.id}`,
      headers: auth(member.token),
    });
    assert.equal(
      (await server.app.inject({ url: '/api/me', headers: auth(renewed.token) })).statusCode,
      200,
    );
    // A separate same-user login revokes the device and the login that authorized it.
    const owner = (
      await server.app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} })
    ).json<Login>();
    await server.app.inject({
      method: 'DELETE',
      url: `/api/account/devices/${device.grant.id}`,
      headers: auth(owner.token),
    });
    assert.equal(
      (await server.app.inject({ url: '/api/me', headers: auth(a2.token) })).statusCode,
      401,
    );
  } finally {
    await server.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a device remains usable and revocable after its expired issuing web session has been pruned', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lightmao-device-retention-'));
  let time = Date.now();
  const server = await createApi({ dataDir: dir, demo: true, auth: { now: () => time } });
  try {
    const login = (
      await server.app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} })
    ).json<Login>();
    const granted = await server.app.inject({
      method: 'POST',
      url: '/api/auth/device',
      headers: auth(login.token),
      payload: { deviceId: randomUUID(), label: 'Long-lived laptop' },
    });
    const device = granted.json<{ token: string; grant: DeviceAuthorization }>();
    time += 31 * 86400000;
    server.auth.prune();
    assert.equal(server.store.list('auth-session', login.user.id).length, 0);
    assert.equal(
      (await server.app.inject({ url: '/api/me', headers: auth(device.token) })).statusCode,
      200,
    );
    const owner = (
      await server.app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} })
    ).json<Login>();
    assert.equal(
      (
        await server.app.inject({
          method: 'DELETE',
          url: `/api/account/devices/${device.grant.id}`,
          headers: auth(owner.token),
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await server.app.inject({ url: '/api/me', headers: auth(device.token) })).statusCode,
      401,
    );
  } finally {
    await server.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('profile, password rotation, login-session revocation and one-time legacy migration keep account ownership', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lightmao-account-'));
  const server = await createApi({ dataDir: dir, demo: true });
  try {
    const original = await server.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          name: 'Alice',
          email: 'alice@example.test',
          password: 'fixture-original-password',
        },
      }),
      a = original.json<Login>();
    const device = (
      await server.app.inject({
        method: 'POST',
        url: '/api/auth/device',
        headers: auth(a.token),
        payload: { deviceId: randomUUID(), label: 'Alice laptop' },
      })
    ).json<{ token: string; grant: DeviceAuthorization }>();
    const wrong = await server.app.inject({
      method: 'POST',
      url: '/api/account/password',
      headers: auth(a.token),
      payload: { currentPassword: 'incorrect', password: 'fixture-new-password' },
    });
    assert.equal(wrong.statusCode, 401);
    assert.equal(wrong.json().code, 'INVALID_CREDENTIALS');
    const changed = await server.app.inject({
      method: 'POST',
      url: '/api/account/password',
      headers: auth(a.token),
      payload: { currentPassword: 'fixture-original-password', password: 'fixture-new-password' },
    });
    assert.equal(changed.statusCode, 200);
    const fresh = changed.json<Login>();
    assert.equal(fresh.user.id, a.user.id);
    assert.equal(
      (await server.app.inject({ url: '/api/me', headers: auth(a.token) })).statusCode,
      401,
    );
    assert.equal(
      (await server.app.inject({ url: '/api/me', headers: auth(device.token) })).statusCode,
      401,
    );
    assert.equal(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/auth/refresh',
          headers: { cookie: cookie(original.headers['set-cookie']) },
          payload: {},
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { email: a.user.email, password: 'fixture-original-password' },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { email: a.user.email, password: 'fixture-new-password' },
        })
      ).statusCode,
      200,
    );
    const updated = await server.app.inject({
      method: 'PATCH',
      url: '/api/account/profile',
      headers: auth(fresh.token),
      payload: { name: 'Alice Studio' },
    });
    assert.equal(updated.json().name, 'Alice Studio');
    assert(!updated.body.includes('passwordHash'));
    const sessions = (
      await server.app.inject({ url: '/api/account/sessions', headers: auth(fresh.token) })
    ).json<LoginSession[]>();
    const other = sessions.find((s) => !s.current)!;
    assert(other);
    assert.equal(
      (
        await server.app.inject({
          method: 'DELETE',
          url: `/api/account/sessions/${other.id}`,
          headers: auth(fresh.token),
        })
      ).statusCode,
      200,
    );
    const legacy = 'legacy-fixture-token-with-enough-randomness';
    server.store.put('token', 'system', {
      id: createHash('sha256').update(legacy).digest('hex'),
      userId: a.user.id,
      expires: Date.now() + 86400000,
    });
    const upgrade = await server.app.inject({
      method: 'POST',
      url: '/api/auth/upgrade',
      headers: auth(legacy),
      payload: {},
    });
    assert.equal(upgrade.statusCode, 200);
    assert(upgrade.headers['set-cookie']);
    assert.equal(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/auth/upgrade',
          headers: auth(legacy),
          payload: {},
        })
      ).statusCode,
      409,
    );
  } finally {
    await server.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
