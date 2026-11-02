import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from '../packages/shared/store.ts';
import { TaskJournal } from '../apps/agent/task-journal.ts';
import { SessionService } from '../apps/agent/sessions.ts';
import type { Schedule, Session, Run } from '../packages/shared/types.ts';
const owner = 'owner';
const task = (): Schedule & { ownerId: string } => ({
  id: randomUUID(),
  ownerId: owner,
  name: 'Nightly check',
  prompt: 'Read project',
  projectId: 'project',
  frequency: 'interval',
  intervalMinutes: 60,
  time: '09:00',
  timezone: 'UTC',
  enabled: true,
  mode: 'demo',
  nextRunAt: new Date(0).toISOString(),
  createdAt: new Date(0).toISOString(),
  revision: 1,
});

test('trigger and next time commit atomically; the same occurrence cannot be recreated, and a queued snapshot survives restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lightmao-journal-'));
  let store = new Store(join(dir, 'db.sqlite'));
  let journal = new TaskJournal(store);
  const current = task();
  store.put('schedule', owner, current);
  try {
    store.db.exec(
      "CREATE TRIGGER reject_task_update BEFORE UPDATE ON records WHEN NEW.kind='schedule' BEGIN SELECT RAISE(ABORT,'injected persistence failure'); END",
    );
    assert.throws(
      () => journal.enqueue(owner, current.id, 'scheduled'),
      /injected persistence failure/,
    );
    assert.equal(store.list('task-occurrence').length, 0);
    assert.equal(store.get<Schedule>('schedule', current.id)!.nextRunAt, current.nextRunAt);
    store.db.exec('DROP TRIGGER reject_task_update');
    const queued = journal.enqueue(owner, current.id, 'scheduled')!;
    assert.equal(queued.status, 'queued');
    assert(Date.parse(store.get<Schedule>('schedule', current.id)!.nextRunAt) > Date.now());
    store.close();
    store = new Store(join(dir, 'db.sqlite'));
    journal = new TaskJournal(store);
    assert.deepEqual(journal.pending()[0], queued);
    store.put('schedule', owner, {
      ...current,
      prompt: 'Later prompt must not enter this snapshot',
    });
    assert.equal(journal.enqueue(owner, current.id, 'scheduled')!.id, queued.id);
    assert.equal(store.list('task-occurrence').length, 1);
    assert.equal(journal.pending()[0].prompt, 'Read project');
    const foreign = { ...task(), ownerId: 'other' };
    store.put('schedule', 'other', foreign);
    journal.enqueue('other', foreign.id, 'scheduled');
    assert.equal(journal.history(owner, {}).items.length, 1);
    assert.throws(() => journal.history('other', { before: queued.id }), /分页/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('run/session/occurrence handoff rolls back together; completed receipt and checkpoint also commit together', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lightmao-handoff-'));
  const store = new Store(join(dir, 'db.sqlite'));
  const journal = new TaskJournal(store);
  const sessions = new SessionService({
    store,
    key: Buffer.alloc(32),
    normalize: (m) => m,
    checkRef: () => {},
  });
  const current = task();
  store.put('schedule', owner, current);
  const occurrence = journal.enqueue(owner, current.id, 'scheduled')!;
  const session: Session = {
    id: randomUUID(),
    projectId: current.projectId,
    title: 'Task',
    messages: [],
    transcript: [],
    status: 'running',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const run: Run = {
    id: randomUUID(),
    sessionId: session.id,
    projectId: current.projectId,
    mode: 'demo',
    prompt: current.prompt,
    status: 'running',
    startedAt: new Date().toISOString(),
    text: '',
    taskId: current.id,
    taskOccurrenceId: occurrence.id,
  };
  try {
    store.db.exec(
      "CREATE TRIGGER reject_session BEFORE INSERT ON records WHEN NEW.kind='session' BEGIN SELECT RAISE(ABORT,'injected session failure'); END",
    );
    assert.throws(
      () => sessions.start(owner, session, run, () => journal.started(owner, occurrence.id, run)),
      /injected session failure/,
    );
    assert.equal(journal.get(owner, occurrence.id)!.status, 'queued');
    assert.equal(store.list('run').length, 0);
    assert.equal(store.list('session').length, 0);
    store.db.exec('DROP TRIGGER reject_session');
    sessions.start(owner, session, run, () => journal.started(owner, occurrence.id, run));
    assert.equal(journal.get(owner, occurrence.id)!.runId, run.id);
    const next = {
      ...store.get<Schedule & { ownerId: string }>('schedule', current.id)!,
      nextRunAt: new Date(1).toISOString(),
    };
    store.put('schedule', owner, next);
    assert.equal(journal.enqueue(owner, current.id, 'scheduled')!.status, 'skipped');
    assert.throws(() => journal.enqueue(owner, current.id, 'manual'), /等待或运行/);
    run.status = 'completed';
    run.endedAt = new Date().toISOString();
    session.status = 'completed';
    session.messages.push({
      id: randomUUID(),
      role: 'assistant',
      text: 'Done',
      mode: 'demo',
      at: run.endedAt,
      runId: run.id,
    });
    store.db.exec(
      "CREATE TRIGGER reject_checkpoint BEFORE INSERT ON records WHEN NEW.kind='session-checkpoint' BEGIN SELECT RAISE(ABORT,'injected checkpoint failure'); END",
    );
    assert.throws(
      () => sessions.finish(owner, session, run, () => journal.finished(owner, run)),
      /injected checkpoint failure/,
    );
    assert.equal(journal.get(owner, occurrence.id)!.status, 'running');
    assert.equal(store.get<Run>('run', run.id)!.status, 'running');
    store.db.exec('DROP TRIGGER reject_checkpoint');
    sessions.finish(owner, session, run, () => journal.finished(owner, run));
    assert.equal(journal.get(owner, occurrence.id)!.status, 'completed');
    assert.equal(store.get<Schedule>('schedule', current.id)!.lastStatus, 'completed');
    assert(store.get('session-checkpoint', run.id));
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('manual request retry is idempotent; transient failures retain queued work, edits cancel it, history pages without duplicates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lightmao-task-history-'));
  const store = new Store(join(dir, 'db.sqlite'));
  let time = Date.now();
  const journal = new TaskJournal(store, () => time);
  const current = task();
  current.enabled = false;
  store.put('schedule', owner, current);
  try {
    const requestId = randomUUID();
    const occurrence = journal.enqueue(owner, current.id, 'manual', requestId)!;
    assert.equal(journal.enqueue(owner, current.id, 'manual', requestId)!.id, occurrence.id);
    journal.failed(owner, occurrence.id, { statusCode: 503, message: 'Backend offline' });
    assert.equal(journal.get(owner, occurrence.id)!.status, 'queued');
    assert.equal(journal.pending().length, 0);
    time += 5001;
    assert.equal(journal.pending().length, 1);
    journal.update({ ...current, revision: 2 }, 'Changed by user');
    assert.equal(journal.get(owner, occurrence.id)!.status, 'cancelled');
    for (let i = 0; i < 28; i++) {
      const row = journal.enqueue(owner, current.id, 'manual', randomUUID())!;
      journal.failed(owner, row.id, { statusCode: 400, message: 'Fixture failure before run' });
    }
    const first = journal.history(owner, { limit: 25 });
    const second = journal.history(owner, { before: first.nextCursor!, limit: 25 });
    assert.equal(first.items.length, 25);
    assert.equal(second.items.length, 4);
    assert.equal(new Set([...first.items, ...second.items].map((o) => o.id)).size, 29);
    const pending = journal.enqueue(owner, current.id, 'manual')!;
    journal.failed(owner, pending.id, { statusCode: 401 });
    assert.equal(journal.get(owner, pending.id)!.status, 'authorization_required');
    assert.equal(store.get<Schedule>('schedule', current.id)!.authorization, 'required');
    assert.equal(store.get<Schedule>('schedule', current.id)!.enabled, false);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('daily triggers use a local calendar-day key across a repeated DST hour; a nonexistent local time moves to the next day', async () => {
  const { nextOccurrence } = await import('../apps/agent/scheduler.ts');
  const daily = {
    ...task(),
    frequency: 'daily' as const,
    time: '01:30',
    timezone: 'America/New_York',
    nextRunAt: '2026-11-01T05:30:00.000Z',
  };
  assert.equal(nextOccurrence(daily, new Date('2026-11-01T05:30:00Z')), '2026-11-02T06:30:00.000Z');
  assert.equal(
    nextOccurrence({ ...daily, time: '02:30' }, new Date('2026-03-08T06:00:00Z')),
    '2026-03-09T06:30:00.000Z',
  );
  const dir = await mkdtemp(join(tmpdir(), 'lightmao-dst-'));
  const store = new Store(join(dir, 'db.sqlite'));
  let time = Date.parse('2026-11-01T06:10:00Z');
  const journal = new TaskJournal(store, () => time);
  store.put('schedule', owner, daily);
  try {
    const first = journal.enqueue(owner, daily.id, 'scheduled')!;
    // Restart between the two 01:30 local times: the same planned local day must not run twice.
    journal.cancelQueued(owner, daily.id, 'Fixture: first slot already handled');
    time = Date.parse('2026-11-01T06:30:00Z');
    store.put('schedule', owner, { ...daily, nextRunAt: '2026-11-01T06:30:00.000Z' });
    assert.equal(journal.enqueue(owner, daily.id, 'scheduled')!.id, first.id);
    assert.equal(journal.history(owner, {}).items.length, 1);
    assert.equal(store.get<Schedule>('schedule', daily.id)!.nextRunAt, '2026-11-02T06:30:00.000Z');
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
