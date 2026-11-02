import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApi } from '../apps/api/server.ts';
import { setTimeout as delay } from 'node:timers/promises';

test('stream completion releases exactly one gateway concurrency slot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lightmao-concurrency-'));
  const releases: (() => void)[] = [];
  const upstream = createServer(async (req, res) => {
    for await (const _ of req) {
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"start"}}]}\n\n');
    releases.push(() => {
      if (!res.writableEnded) res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const server = await createApi({
    dataDir: root,
    demo: true,
    arkKey: 'test-key',
    arkBase: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
  });
  await server.app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(server.app.server.address() as { port: number }).port}`;
  try {
    const auth = await server.app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} });
    const token = auth.json().token;
    const open = () =>
      fetch(`${base}/api/v1/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'doubao',
          messages: [{ role: 'user', content: 'test' }],
          stream: true,
        }),
      });
    const first = await open(),
      second = await open(),
      third = await open();
    assert.equal((await open()).status, 429);
    releases[0]();
    await first.text();
    const fourth = await open();
    assert.equal(fourth.status, 200);
    assert.equal((await open()).status, 429, 'one completion must not free two slots');
    releases.slice(1).forEach((release) => release());
    await Promise.all([second.text(), third.text(), fourth.text()]);
  } finally {
    releases.forEach((release) => release());
    await server.app.close();
    await new Promise<void>((r) => upstream.close(() => r()));
    await rm(root, { recursive: true, force: true });
  }
});

test('model completion survives a consumer disconnect after DONE; a disconnect before DONE remains cancelled', async () => {
  const started = performance.now();
  const dir = await mkdtemp(join(tmpdir(), 'lm-stream-completion-'));
  const upstream = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const complete = JSON.parse(body).messages[0].content === 'complete';
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"answer"}}]}\n\n');
    if (complete)
      res.write(
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":123}}\n\ndata: [DONE]\n\n',
      );
    // Keep HTTP open after the protocol terminator to reproduce SDK early close.
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const api = await createApi({
    dataDir: dir,
    demo: true,
    arkKey: 'test-completion-key',
    arkBase: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
  });
  await api.app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(api.app.server.address() as { port: number }).port}`;
  const token = (
    await api.app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} })
  ).json().token;
  try {
    for (const complete of [true, false]) {
      const response = await fetch(base + '/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'doubao',
          messages: [{ role: 'user', content: complete ? 'complete' : 'partial' }],
          stream: true,
        }),
      });
      const reader = response.body!.getReader();
      let received = '';
      while (complete ? !received.includes('[DONE]') : !received.includes('answer')) {
        const chunk = await reader.read();
        assert(!chunk.done);
        received += new TextDecoder().decode(chunk.value);
      }
      await reader.cancel();
      const requestId = response.headers.get('x-request-id')!;
      let usage: { id: string; status: string; totalTokens?: number } | undefined;
      for (let i = 0; i < 100; i++) {
        usage = api.store.get('usage', requestId);
        if (usage?.status !== 'running') break;
        await delay(10);
      }
      assert.equal(usage?.status, complete ? 'completed' : 'cancelled');
      if (complete) assert.equal(usage?.totalTokens, 123);
    }
  } finally {
    api.app.server.closeAllConnections();
    await api.app.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
  assert(
    performance.now() - started < 5000,
    'completed protocol streams must not wait for the upstream HTTP idle timeout',
  );
});
