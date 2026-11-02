import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createApi } from '../apps/api/server.ts';
import type { ApiOptions } from '../apps/api/server.ts';
import type { Usage, User, ModelConfig } from '../packages/shared/types.ts';

const headers = (token: string) => ({ authorization: `Bearer ${token}` });
async function fixture(options: Partial<ApiOptions> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'lightmao-admin-'));
  const api = await createApi({
    dataDir: dir,
    adminEmail: 'admin@example.test',
    adminPassword: 'Admin-fixture-pass-2026',
    ...options,
  });
  const admin = (
    await api.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@example.test', password: 'Admin-fixture-pass-2026' },
    })
  ).json();
  const member = (
    await api.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        name: 'Member',
        email: 'member@example.test',
        password: 'Member-fixture-pass-2026',
      },
    })
  ).json();
  const call = (url: string, body?: unknown, token = admin.token) =>
    api.app.inject({
      method: body === undefined ? 'GET' : 'PATCH',
      url,
      headers: headers(token),
      payload: body as object,
    });
  return {
    ...api,
    dir,
    admin,
    member,
    call,
    async close() {
      await api.app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
test('admin endpoints reject members and devices, expose bounded metadata and accurate totals beyond 100 records', async () => {
  const f = await fixture();
  try {
    const device = f.auth.device(
      f.auth.authenticate(`Bearer ${f.member.token}`),
      randomUUID(),
      'test device',
    );
    for (const url of [
      '/api/admin/overview',
      '/api/admin/users',
      '/api/admin/usage',
      '/api/admin/usage/missing',
      '/api/admin/audits',
      '/api/admin/plugins',
    ]) {
      assert.equal((await f.call(url, undefined, f.member.token)).statusCode, 403, url);
      assert.equal((await f.call(url, undefined, device.token)).statusCode, 403, url);
      assert.equal((await f.app.inject({ url })).statusCode, 401, url);
    }
    for (let i = 0; i < 135; i++)
      f.store.put<Usage>('usage', 'system', {
        id: `usage-${i}`,
        userId: f.member.user.id,
        model: 'fixture-model',
        status: i % 3 ? 'completed' : 'upstream_429',
        at: new Date(Date.now() - i * 60000).toISOString(),
        durationMs: 12,
        ...(i % 2 ? { totalTokens: 7 } : {}),
      });
    const summary = await f.call('/api/admin/overview?summary=true');
    assert.equal(summary.headers['cache-control'], 'no-store');
    assert.equal(summary.json().totals.modelRequests, 135);
    assert.equal(summary.json().totals.failedRequests, 45);
    assert.equal(summary.json().totals.totalTokens, 67 * 7);
    assert.equal(summary.json().totals.tokenRequests, 67);
    assert.equal(summary.json().users, undefined);
    const legacy = (await f.call('/api/admin/overview')).json();
    assert.equal(legacy.usage.length, 100);
    const all: string[] = [];
    let cursor = '';
    let page = 0;
    do {
      const query = new URLSearchParams({ limit: '17', ...(cursor ? { cursor } : {}) });
      const response = await f.call(`/api/admin/usage?${query}`);
      assert.equal(response.statusCode, 200, response.body);
      const body = response.json();
      assert.equal(body.total, 135);
      all.push(...body.items.map((v: Usage) => v.id));
      cursor = body.nextCursor || '';
      if (page++ === 0)
        f.store.put('usage', 'system', {
          id: 'later',
          userId: f.member.user.id,
          model: 'fixture-model',
          status: 'completed',
          at: new Date().toISOString(),
          durationMs: 1,
        });
    } while (cursor);
    assert.equal(all.length, 135);
    assert.equal(new Set(all).size, 135);
    assert(!all.includes('later'));
    const filtered = (
      await f.call('/api/admin/usage?q=member%40example.test&status=failed')
    ).json();
    assert.equal(filtered.total, 45);
    const id = (await f.call('/api/admin/usage?q=usage-134')).json().items[0].id;
    assert.equal((await f.call(`/api/admin/usage/${id}`)).json().user.email, 'member@example.test');
    for (const url of ['/api/admin/users', '/api/admin/usage', '/api/admin/audits']) {
      const text = (await f.call(url)).body;
      assert(!text.includes('passwordHash'));
      assert(!text.includes('salt'));
      assert(!text.includes(f.admin.token));
    }
  } finally {
    await f.close();
  }
});
test('admin pagination binds filters and identity, rejects tampering and persists its cursor across restart', async () => {
  const f = await fixture();
  let reopened: Awaited<ReturnType<typeof createApi>> | undefined;
  try {
    for (let i = 0; i < 8; i++)
      f.store.put('audit', 'system', {
        id: String(i),
        actor: f.admin.user.id,
        action: 'fixture.event',
        detail: 'test',
        at: new Date().toISOString(),
      });
    const first = (await f.call('/api/admin/audits?limit=3')).json();
    assert(first.nextCursor);
    for (const query of [
      new URLSearchParams({ limit: '3', cursor: first.nextCursor + 'x' }),
      new URLSearchParams({ limit: '3', q: 'other', cursor: first.nextCursor }),
    ])
      assert.equal((await f.call(`/api/admin/audits?${query}`)).statusCode, 400);
    const another = await f.auth.createUser(
      'Other',
      'other@example.test',
      'Other-fixture-pass-2026',
      'admin',
    );
    const other = f.auth.login(another, 'test');
    const nextUrl =
      '/api/admin/audits?' + new URLSearchParams({ limit: '3', cursor: first.nextCursor });
    assert.equal((await f.call(nextUrl, undefined, other.token)).statusCode, 400);
    await f.app.close();
    reopened = await createApi({ dataDir: f.dir });
    const next = await reopened.app.inject({ url: nextUrl, headers: headers(f.admin.token) });
    assert.equal(next.statusCode, 200, next.body);
    assert.equal(next.json().items.length, 3);
    assert(
      !next
        .json()
        .items.some((a: { id: string }) => first.items.some((b: { id: string }) => a.id === b.id)),
    );
    assert.equal(
      (
        await reopened.app.inject({
          url: '/api/admin/usage?from=2026-11-02T00:00:00Z&to=2026-11-01T00:00:00Z',
          headers: headers(f.admin.token),
        })
      ).statusCode,
      400,
    );
  } finally {
    if (reopened) await reopened.app.close();
    else await f.app.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
test('account disable and revocations roll back together, then restore requires fresh credentials', async () => {
  const f = await fixture();
  try {
    const device = f.auth.device(
      f.auth.authenticate(`Bearer ${f.member.token}`),
      randomUUID(),
      'test',
    );
    const before = f.store.list('token');
    const put = f.store.put.bind(f.store);
    f.store.put = ((kind: string, ...args: unknown[]) => {
      if (kind === 'audit') throw Error('fault injection');
      return (put as Function)(kind, ...args);
    }) as typeof f.store.put;
    assert.equal(
      (await f.call(`/api/admin/users/${f.member.user.id}`, { status: 'disabled', revision: 0 }))
        .statusCode,
      500,
    );
    f.store.put = put;
    assert.equal(f.store.get<User>('user', f.member.user.id)!.status, 'active');
    assert.deepEqual(f.store.list('token'), before);
    assert.equal((await f.call('/api/me', undefined, f.member.token)).statusCode, 200);
    assert.equal(
      (await f.call(`/api/admin/users/${f.admin.user.id}`, { status: 'disabled' })).statusCode,
      409,
    );
    assert.equal(
      (await f.call(`/api/admin/users/${f.member.user.id}`, { status: 'disabled', role: 'admin' }))
        .statusCode,
      400,
    );
    assert.equal(
      (await f.call(`/api/admin/users/${f.member.user.id}`, { status: 'disabled', revision: 0 }))
        .statusCode,
      200,
    );
    assert.equal((await f.call('/api/me', undefined, f.member.token)).statusCode, 403);
    assert.equal((await f.call('/api/me', undefined, device.token)).statusCode, 403);
    assert.equal(
      (await f.call(`/api/admin/users/${f.member.user.id}`, { status: 'active', revision: 0 }))
        .statusCode,
      409,
    );
    assert.equal(
      (await f.call(`/api/admin/users/${f.member.user.id}`, { status: 'active', revision: 1 }))
        .statusCode,
      200,
    );
    assert.equal((await f.call('/api/me', undefined, f.member.token)).statusCode, 401);
    const login = await f.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: f.member.user.email, password: 'Member-fixture-pass-2026' },
    });
    assert.equal(login.statusCode, 200);
  } finally {
    await f.close();
  }
});
test('model and plugin policies use conflict checks, atomic audit, and preserve each user selection', async () => {
  const f = await fixture();
  try {
    const cfg = (await f.call('/api/admin/overview?summary=true')).json().model;
    assert.equal(cfg.contextWindowTokens, 1_024_000);
    for (const contextWindowTokens of [16383, 2000001, 16384.5, '32768'])
      assert.equal(
        (await f.call('/api/admin/model', { contextWindowTokens, revision: 0 })).statusCode,
        400,
      );
    assert.equal(
      (
        await f.call('/api/admin/model', {
          label: 'New',
          contextWindowTokens: 32768,
          maxOutputTokens: 8192,
          revision: 0,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await f.call('/api/admin/model', { enabled: false, revision: 0 })).statusCode,
      409,
    );
    assert.equal(
      (await f.call('/api/admin/model', { modelId: 'http://forbidden' })).statusCode,
      400,
    );
    assert.equal((await f.call('/api/admin/model', { apiKey: 'must-not-accept' })).statusCode, 400);
    const current = f.store.get<ModelConfig>('config', 'model');
    assert.equal(current?.contextWindowTokens, 32768);
    const put = f.store.put.bind(f.store);
    f.store.put = ((kind: string, ...args: unknown[]) => {
      if (kind === 'audit') throw Error('fault injection');
      return (put as Function)(kind, ...args);
    }) as typeof f.store.put;
    assert.equal(
      (await f.call('/api/admin/model', { enabled: false, revision: 1 })).statusCode,
      500,
    );
    assert.deepEqual(f.store.get('config', 'model'), current);
    assert.equal(
      (await f.call('/api/admin/plugins/workspace', { available: false, revision: 0 })).statusCode,
      500,
    );
    assert.equal(f.store.get('plugin-policy', 'workspace'), undefined);
    f.store.put = put;
    await f.call('/api/bootstrap', undefined, f.member.token);
    const selected = f.store.get('plugin', `${f.member.user.id}:workspace`);
    assert.equal(
      (await f.call('/api/admin/plugins/workspace', { available: false, revision: 0 })).statusCode,
      200,
    );
    const cloud = (await f.call('/api/bootstrap', undefined, f.member.token)).json();
    const p = cloud.plugins.find((v: { id: string }) => v.id === 'workspace');
    assert.equal(p.available, false);
    assert.equal(p.enabled, false);
    assert.equal(p.installed, true);
    assert.equal(
      (await f.call('/api/plugins/workspace', { enabled: true }, f.member.token)).statusCode,
      403,
    );
    assert.deepEqual(f.store.get('plugin', `${f.member.user.id}:workspace`), selected);
    assert.equal(
      (await f.call('/api/admin/plugins/workspace', { available: true, revision: 0 })).statusCode,
      409,
    );
    assert.equal(
      (await f.call('/api/admin/plugins/workspace', { available: true, revision: 1 })).statusCode,
      200,
    );
    assert.equal(
      (await f.call('/api/bootstrap', undefined, f.member.token))
        .json()
        .plugins.find((v: { id: string }) => v.id === 'workspace').enabled,
      true,
    );
    assert.equal(
      (await f.call('/api/admin/overview?summary=true')).json().model.modelId,
      cfg.modelId,
    );
  } finally {
    await f.close();
  }
});
test('gateway diagnostics retain only numeric usage and fixed causes for upstream error, incomplete stream, timeout and cancellation', async () => {
  const secret = 'DO-NOT-LOG-UPSTREAM-BODY-' + randomUUID();
  let calls = 0;
  const upstream = createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    const name = JSON.parse(raw).messages[0].content;
    calls++;
    if (name === 'upstream-error') {
      res
        .writeHead(429, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: secret }));
      return;
    }
    if (name === 'timeout') return;
    if (name === 'ok') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: secret } }],
          usage: { total_tokens: 11, prompt_tokens: 7, completion_tokens: 4 },
        }),
      );
      return;
    }
    if (name === 'unknown') {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ choices: [], usage: { total_tokens: -4, prompt_tokens: secret } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
    if (name === 'incomplete') res.end();
  });
  await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
  const f = await fixture({
    arkKey: secret,
    arkBase: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
    modelTimeoutMs: 250,
  });
  await f.app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(f.app.server.address() as { port: number }).port}`;
  try {
    for (const [name, expected] of [
      ['ok', undefined],
      ['upstream-error', 'upstream_error'],
      ['unknown', undefined],
      ['incomplete', 'stream_incomplete'],
      ['timeout', 'timeout'],
      ['cancel', 'client_cancelled'],
    ] as const) {
      const response = await fetch(base + '/api/v1/chat/completions', {
        method: 'POST',
        headers: { ...headers(f.admin.token), 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'doubao',
          messages: [{ role: 'user', content: name }],
          stream: ['incomplete', 'cancel'].includes(name),
        }),
      });
      const id = response.headers.get('x-request-id');
      assert(id);
      if (name === 'cancel') {
        const reader = response.body!.getReader();
        await reader.read();
        await reader.cancel();
      } else await response.text().catch(() => {});
      let row: Usage | undefined;
      for (let i = 0; i < 100; i++) {
        row = f.store.get('usage', id);
        if (row?.status !== 'running') break;
        await delay(10);
      }
      assert.equal(row?.failureReason, expected, name);
      assert.notEqual(row?.status, 'running');
      if (name === 'ok') {
        assert.equal(row?.totalTokens, 11);
        assert.equal(row?.promptTokens, 7);
        assert.equal(row?.completionTokens, 4);
      }
      if (name === 'unknown') assert.equal(row?.totalTokens, undefined);
      const detail = await f.call(`/api/admin/usage/${id}`);
      assert.equal(detail.statusCode, 200);
      assert(!detail.body.includes(secret));
    }
    assert.equal(calls, 6);
    const before = calls;
    await f.call('/api/admin/model', { enabled: false, revision: 0 });
    const blocked = await fetch(base + '/api/v1/chat/completions', {
      method: 'POST',
      headers: { ...headers(f.admin.token), 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'doubao', messages: [{ role: 'user', content: 'blocked' }] }),
    });
    assert.equal(blocked.status, 403);
    assert.equal(calls, before);
    assert(!JSON.stringify(f.store.list('usage')).includes(secret));
  } finally {
    f.app.server.closeAllConnections();
    await f.close();
    upstream.closeAllConnections();
    await new Promise<void>((done) => upstream.close(() => done()));
  }
});
