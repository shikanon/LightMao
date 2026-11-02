import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { apiRuntime } from '../apps/api/config.ts';
import { acquireApiLease } from '../apps/api/lease.ts';
import { createApi } from '../apps/api/server.ts';

test('production settings reject insecure or ambiguous deployment before creating data, without echoing private values', () => {
  const base = {
    NODE_ENV: 'production',
    LIGHTMAO_DATA_DIR: '/var/lib/lightmao',
    LIGHTMAO_ADMIN_EMAIL: 'admin@example.test',
    LIGHTMAO_ADMIN_PASSWORD: 'production-test-private-value',
    LIGHTMAO_SECURE_COOKIES: 'true',
    LIGHTMAO_DEMO: 'false',
    LIGHTMAO_TRUST_PROXY: 'loopback',
    LIGHTMAO_WEB_ORIGINS: 'https://agent.example.test',
  };
  const cfg = apiRuntime(base);
  assert.equal(cfg.listen.host, '127.0.0.1');
  assert.equal(cfg.options.trustProxy, 'loopback');
  assert(cfg.options.webRoot?.endsWith('/dist/web/'));
  for (const change of [
    { LIGHTMAO_DEMO: 'true' },
    { LIGHTMAO_SECURE_COOKIES: 'false' },
    { LIGHTMAO_DATA_DIR: '.lightmao' },
    { LIGHTMAO_DATA_DIR: process.cwd() },
    { LIGHTMAO_ADMIN_PASSWORD: '' },
    { LIGHTMAO_TRUST_PROXY: 'true' },
    { LIGHTMAO_WEB_ORIGINS: 'http://example.test' },
    { LIGHTMAO_WEB_ORIGINS: 'https://example.test/path' },
    { LIGHTMAO_STORAGE: 'osss' },
    { LIGHTMAO_STORAGE: 'oss' },
    { ARK_BASE_URL: 'https://production-test-private-value@example.test/api' },
    { ARK_BASE_URL: 'http://example.test' },
    { API_PORT: '-1' },
    { API_PORT: '12.1' },
    { LIGHTMAO_DEMO: 'TRUE' },
  ])
    assert.throws(
      () => apiRuntime({ ...base, ...change }),
      (e: Error) => !e.message.includes(base.LIGHTMAO_ADMIN_PASSWORD),
    );
  assert.equal(
    apiRuntime({ ...base, API_PORT: '0', ARK_BASE_URL: 'http://127.0.0.1:3333' }).listen.port,
    0,
  );
  assert.equal(apiRuntime({}).options.demo, false);
});

test('API ownership is exclusive and a rejected second owner cannot release or modify the live lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lm-api-lease-'));
  const first = acquireApiLease(root);
  try {
    const db = new DatabaseSync(join(root, 'server.sqlite'), { readOnly: true });
    const before = db.prepare("SELECT data FROM records WHERE kind='server-runtime-lease'").get();
    assert.throws(() => acquireApiLease(root), /already has a live API/);
    assert.deepEqual(
      db.prepare("SELECT data FROM records WHERE kind='server-runtime-lease'").get(),
      before,
    );
    first();
    first();
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM records WHERE kind='server-runtime-lease'").get()!.n,
      0,
    );
    const second = acquireApiLease(root);
    second();
    db.close();
  } finally {
    first();
    await rm(root, { recursive: true, force: true });
  }
});

test('only an explicitly trusted loopback proxy supplies HTTPS origin and per-client auth limits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lm-api-proxy-'));
  const api = await createApi({
    dataDir: root,
    demo: true,
    secureCookies: true,
    trustProxy: 'loopback',
    allowedOrigins: [],
  });
  try {
    const headers = {
      host: 'agent.example.test',
      origin: 'https://agent.example.test',
      'x-forwarded-proto': 'https',
      'x-forwarded-for': '203.0.113.8',
    };
    const good = await api.app.inject({
      method: 'POST',
      url: '/api/auth/demo',
      headers,
      remoteAddress: '127.0.0.1',
      payload: {},
    });
    assert.equal(good.statusCode, 200);
    assert.match(good.headers['set-cookie'] as string, /; Secure/);
    const spoof = await api.app.inject({
      method: 'POST',
      url: '/api/auth/demo',
      headers,
      remoteAddress: '203.0.113.1',
      payload: {},
    });
    assert.equal(spoof.statusCode, 403);
    for (let i = 0; i < 29; i++)
      assert.equal(
        (
          await api.app.inject({
            method: 'POST',
            url: '/api/auth/refresh',
            remoteAddress: '127.0.0.1',
            headers,
            payload: {},
          })
        ).statusCode,
        401,
      );
    assert.equal(
      (
        await api.app.inject({
          method: 'POST',
          url: '/api/auth/refresh',
          remoteAddress: '127.0.0.1',
          headers,
          payload: {},
        })
      ).statusCode,
      429,
    );
    assert.equal(
      (
        await api.app.inject({
          method: 'POST',
          url: '/api/auth/refresh',
          remoteAddress: '127.0.0.1',
          headers: { ...headers, 'x-forwarded-for': '203.0.113.9' },
          payload: {},
        })
      ).statusCode,
      401,
    );
  } finally {
    await api.app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('API shutdown aborts an unfinished live model stream and commits an unknown result before closing SQLite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lm-api-shutdown-'));
  let calls = 0;
  const upstream = createServer(async (req, res) => {
    for await (const _ of req) {
      /* drain */
    }
    calls++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"still running"}}]}\n\n');
  });
  await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
  const api = await createApi({
    dataDir: root,
    demo: true,
    arkKey: 'shutdown-protocol-fixture',
    arkBase: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
  });
  await api.app.listen({ host: '127.0.0.1', port: 0 });
  try {
    const login = (
      await api.app.inject({ url: '/api/auth/demo', method: 'POST', payload: {} })
    ).json();
    const reply = await fetch(
      `http://127.0.0.1:${(api.app.server.address() as { port: number }).port}/api/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + login.token },
        body: JSON.stringify({
          model: 'doubao',
          stream: true,
          messages: [{ role: 'user', content: 'hold' }],
        }),
      },
    );
    const consume = reply.text().catch(() => 'interrupted');
    assert.equal(calls, 1);
    await Promise.race([
      api.app.close(),
      delay(5000).then(() => {
        throw Error('API shutdown hung on the live model');
      }),
    ]);
    await consume;
    const saved = new DatabaseSync(join(root, 'server.sqlite'), { readOnly: true });
    const usage = JSON.parse(
      saved.prepare("SELECT data FROM records WHERE kind='usage'").get()!.data as string,
    );
    assert.equal(usage.status, 'interrupted');
    assert.equal(usage.totalTokens, undefined);
    assert.equal(usage.failureReason, undefined);
    saved.close();
  } finally {
    await api.app.close();
    upstream.closeAllConnections();
    await new Promise<void>((done) => upstream.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});

test('API shutdown closes an accepted preconnect socket with no HTTP request instead of waiting for a keepalive timeout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lm-api-preconnect-'));
  const api = await createApi({ dataDir: root });
  await api.app.listen({ host: '127.0.0.1', port: 0 });
  const socket = connect((api.app.server.address() as { port: number }).port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const start = Date.now(),
    closing = api.app.close();
  try {
    await Promise.race([
      closing,
      delay(2000).then(() => {
        throw Error('API waited on an unused pool connection');
      }),
    ]);
    assert(Date.now() - start < 1500);
  } finally {
    socket.destroy();
    await closing;
    await rm(root, { recursive: true, force: true });
  }
});
