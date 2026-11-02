import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'sessionStorage', {
  value: {
    getItem: (k: string) => storage.get(k) || null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  },
  configurable: true,
});
Object.defineProperty(globalThis, 'window', { value: new EventTarget(), configurable: true });
const client = await import('../apps/web/src/api.ts');
const original = globalThis.fetch;
const json = (data: unknown, status = 200) => Response.json(data, { status });

test('parallel expired requests perform one refresh and late 401s reuse the renewed access token', async () => {
  let refreshed = 0,
    writes = 0;
  client.setToken('expired-access', 'alice');
  globalThis.fetch = async (input, init) => {
    if (String(input) === '/api/auth/refresh') {
      refreshed++;
      await delay(10);
      return json({ token: 'fresh-access', user: { id: 'alice' } });
    }
    const token = new Headers(init?.headers).get('Authorization');
    if (token === 'Bearer expired-access') {
      if (String(input).endsWith('late')) await delay(40);
      return json({ error: 'expired', code: 'AUTH_EXPIRED' }, 401);
    }
    assert.equal(token, 'Bearer fresh-access');
    writes++;
    return json({ ok: true });
  };
  try {
    const results = await Promise.all(
      ['/api/work/one', '/local/work/two', '/api/work/late'].map((path) =>
        client.api<{ ok: boolean }>(path, { method: 'POST', body: '{}' }),
      ),
    );
    assert(results.every((r) => r.ok));
    assert.equal(refreshed, 1);
    assert.equal(writes, 3);
    assert.equal(storage.get('lightmao.token'), 'fresh-access');
    assert.equal(storage.size, 2, 'only access token and user id are saved');
  } finally {
    globalThis.fetch = original;
    client.setToken('');
  }
});

test('refresh cannot replay a mutation under a different account or clear a session on transient failure', async () => {
  let writes = 0;
  client.setToken('old-access', 'alice');
  globalThis.fetch = async (input) => {
    if (String(input) === '/api/auth/refresh')
      return json({ token: 'bob-access', user: { id: 'bob' } });
    writes++;
    return json({ error: 'expired', code: 'AUTH_EXPIRED' }, 401);
  };
  try {
    await assert.rejects(() => client.api('/api/work', { method: 'POST', body: '{}' }), {
      status: 401,
    });
    assert.equal(writes, 1);
    assert.equal(client.hasToken(), false);
    client.setToken('keep-session', 'alice');
    globalThis.fetch = async (input) =>
      String(input) === '/api/auth/refresh'
        ? json({ error: 'temporarily unavailable' }, 503)
        : json({ error: 'expired', code: 'AUTH_EXPIRED' }, 401);
    await assert.rejects(() => client.api('/api/work'), { status: 503 });
    assert.equal(storage.get('lightmao.token'), 'keep-session');
  } finally {
    globalThis.fetch = original;
    client.setToken('');
  }
});

test('password validation errors never rotate refresh tokens, and explicit logout does not resurrect a session', async () => {
  let refreshed = 0;
  client.setToken('valid-access', 'alice');
  globalThis.fetch = async (input) => {
    if (String(input) === '/api/auth/refresh') {
      refreshed++;
      return json({ token: 'unwanted', user: { id: 'alice' } });
    }
    if (String(input) === '/api/delayed') {
      await delay(15);
      return json({ error: 'expired', code: 'AUTH_EXPIRED' }, 401);
    }
    return json({ error: 'wrong password', code: 'INVALID_CREDENTIALS' }, 401);
  };
  try {
    await assert.rejects(
      () => client.api('/api/account/password', { method: 'POST', body: '{}' }),
      { code: 'INVALID_CREDENTIALS' },
    );
    assert.equal(refreshed, 0);
    const pending = client.api('/api/delayed');
    client.setToken('');
    await assert.rejects(() => pending, { status: 401 });
    assert.equal(refreshed, 0);
    assert.equal(client.hasToken(), false);
  } finally {
    globalThis.fetch = original;
    client.setToken('');
  }
});

test('an in-flight refresh cannot restore an explicitly logged-out session or replay under a newly signed-in account', async () => {
  try {
    for (const switchAccount of [false, true]) {
      client.setToken('alice-access', 'alice');
      let writes = 0;
      let resume!: (value: Response) => void;
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      globalThis.fetch = async (input) => {
        if (String(input) === '/api/auth/refresh') {
          started();
          return new Promise<Response>((resolve) => {
            resume = resolve;
          });
        }
        writes++;
        return json({ error: 'expired', code: 'AUTH_EXPIRED' }, 401);
      };
      const pending = client.api('/api/mutation', { method: 'POST', body: '{}' });
      await ready;
      client.setToken('');
      if (switchAccount) client.setToken('bob-access', 'bob');
      resume(json({ token: 'late-alice-access', user: { id: 'alice' } }));
      await assert.rejects(() => pending, { status: 401 });
      assert.equal(writes, 1);
      assert.equal(storage.get('lightmao.token'), switchAccount ? 'bob-access' : undefined);
    }
  } finally {
    globalThis.fetch = original;
    client.setToken('');
  }
});

test('event stream reconnects from the durable cursor and never repeats delivered tool events', async () => {
  client.setToken('event-access', 'alice');
  const urls: string[] = [];
  let streams = 0;
  const seen: number[] = [];
  const event = (seq: number, type: string) =>
    `data: ${JSON.stringify({ id: `run:${seq}`, runId: 'run', seq, type, at: new Date().toISOString(), data: {} })}\n\n`;
  globalThis.fetch = async (input) => {
    const path = String(input);
    urls.push(path);
    if (path.includes('/stream')) {
      streams++;
      return new Response(
        streams === 1
          ? event(1, 'tool.started')
          : event(1, 'tool.started') + event(2, 'tool.finished') + event(3, 'run.finished'),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    }
    return json({ status: 'running' });
  };
  try {
    await client.watchRun('run', (e) => seen.push(e.seq), new AbortController().signal);
    assert.deepEqual(seen, [1, 2, 3]);
    assert.equal(streams, 2);
    assert(urls.includes('/local/runs/run/stream?after=1'));
  } finally {
    globalThis.fetch = original;
    client.setToken('');
  }
});
