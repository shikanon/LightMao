import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../packages/shared/store.ts';
import { TraceService } from '../apps/agent/trace.ts';
test('trace event chain is immutable, owner scoped and detects payload tampering', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lm-trace-test-')),
    store = new Store(join(dir, 'db')),
    trace = new TraceService(store);
  try {
    trace.start({ owner: 'a', project: 'p', session: 's', run: 'r' });
    const event = trace.append('a', 'r', {
      kind: 'model.request',
      name: 'actual request',
      spanId: 'step',
      parentSpanId: 'r',
      payload: {
        authorization: 'secret',
        apiKey: 'private',
        access_token: 'private',
        messages: [{ content: 'visible' }],
        image: { mime: 'image/png', data: Buffer.from('actual-capture').toString('base64') },
      },
    });
    assert.equal(trace.page('a', 'r').integrity, true);
    assert.throws(() => trace.page('b', 'r'), /不存在/);
    assert.throws(() => store.remove('trace-event', event.id, 'a'), /immutable/);
    assert.throws(
      () => store.put('trace-event', 'a', { ...event, name: 'rewritten' }),
      /immutable/,
    );
    const payload = trace.read('a', 'r', event.payloadRef!);
    assert(!payload.text.includes('private'));
    assert(!payload.text.includes('"secret"'));
    const blob = JSON.parse(payload.text).image.data.$media;
    assert.equal(trace.media('a', 'r', blob).bytes.toString(), 'actual-capture');
    trace.start({ owner: 'a', project: 'p', session: 's', run: 'other' });
    assert.throws(() => trace.read('a', 'other', event.payloadRef!), /不属于/);
    assert.throws(() => trace.media('a', 'other', blob), /不属于/);
    const raw = store.get<any>('trace-payload', event.payloadRef!, 'a');
    store.put('trace-payload', 'a', { ...raw, text: 'tampered' });
    assert.throws(() => trace.read('a', 'r', event.payloadRef!), /哈希/);
  } finally {
    trace.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('trace restart records interruption and pagination retains sequence and parent links', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lm-trace-restart-')),
    store = new Store(join(dir, 'db'));
  const trace = new TraceService(store);
  try {
    trace.start({ owner: 'a', project: 'p', session: 's', run: 'r' });
    trace.event('a', 'r', 'tool.started', { toolCallId: 'call', name: 'read_file' });
    trace.start(
      { owner: 'a', project: 'child', session: 'task', run: 'child' },
      { kind: 'subagent', parentTraceId: 'r', parentSpanId: trace.toolSpan('r', 'call') },
    );
    assert.equal(trace.head('a', 'child').parentSpanId, trace.toolSpan('r', 'call'));
    const restarted = new TraceService(store);
    assert.equal(restarted.head('a', 'r').status, 'interrupted');
    const first = restarted.page('a', 'r', 0, 1),
      next = restarted.page('a', 'r', first.nextAfter, 100);
    assert(first.hasMore);
    assert.equal(next.events[0].sequence, 2);
    assert.equal(next.events.at(-1)?.kind, 'run.interrupted');
    assert.equal(first.events[0].hash, next.events[0].previousHash);
    restarted.close();
  } finally {
    trace.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
