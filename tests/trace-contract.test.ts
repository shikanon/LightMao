import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { Store } from '../packages/shared/store.ts';
import { TraceService } from '../apps/agent/trace.ts';
import { arkStream, gatewayModel } from '../apps/agent/provider.ts';
import { durableGoalSection } from '../apps/agent/request-context.ts';
import { normalizeContext } from '@earendil-works/pi-ai';

test('actual wire rejects hashes in user text, stale constraints and escaped pseudo anchors before HTTP', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lm-wire-anchor-'));
  const store = new Store(join(dir, 'db')),
    traces = new TraceService(store);
  const goal = {
    id: 'goal',
    objective: '完成战中构筑',
    contractHash: 'current-hash',
    userConstraints: [{ text: '必须恢复战斗', sourceMessageId: 'user-2' }],
  };
  store.put('agent-goal', 'alice', goal);
  let count = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
    }
    count++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      'data: ' +
        JSON.stringify({
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'Actual request accepted' },
              finish_reason: 'stop',
            },
          ],
        }) +
        '\n\ndata: [DONE]\n\n',
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const model = gatewayModel(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  async function send(run: string, system: string, user: string) {
    traces.start(
      { owner: 'alice', project: 'project', session: 'session', run },
      { goalId: goal.id },
    );
    return traces
      .wrap(
        'alice',
        run,
        arkStream('fixture'),
      )(
        model,
        normalizeContext({
          messages: [
            { role: 'system', content: system, timestamp: 1 },
            { role: 'user', content: user, timestamp: 2 },
          ],
        }),
      )
      .result();
  }
  try {
    const envelope = durableGoalSection({ ...goal, goalId: goal.id });
    const userOnly = await send('user-only', 'Preserve user goal', envelope);
    assert.equal(userOnly.stopReason, 'error');
    assert.equal(count, 0);
    const hashOnly = await send('hash-only', goal.contractHash, '继续');
    assert.equal(hashOnly.stopReason, 'error');
    assert.equal(count, 0);
    const stale = await send(
      'stale',
      durableGoalSection({ ...goal, goalId: goal.id, userConstraints: [] }),
      envelope,
    );
    assert.equal(stale.stopReason, 'error');
    assert.equal(count, 0);
    const valid = await send('valid', envelope, '核对当前工程');
    assert.equal(valid.stopReason, 'stop');
    assert.equal(count, 1);
    const guards = traces.events('alice', 'valid').events.filter((e) => e.kind === 'context.guard');
    assert.equal(guards.length, 1);
    assert.equal(guards[0].status, 'verified');
    assert.equal(
      traces.events('alice', 'stale').events.some((e) => e.kind === 'model.request'),
      false,
    );
  } finally {
    traces.close();
    store.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});
