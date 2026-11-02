import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../packages/shared/store.ts';
import { WorkflowService } from '../apps/agent/workflows.ts';
import type { Run } from '../packages/shared/types.ts';
async function fixture(fn: (service: WorkflowService, store: Store) => Promise<void> | void) {
  const dir = await mkdtemp(join(tmpdir(), 'lm-workflow-')),
    store = new Store(join(dir, 'local.sqlite'));
  try {
    await fn(new WorkflowService(store), store);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}
const run = (id: string, goalId: string, status: Run['status'] = 'completed'): Run => ({
  id,
  goalId,
  sessionId: 'session',
  projectId: 'project',
  status,
  mode: 'ark',
  prompt: '自然目标',
  startedAt: new Date().toISOString(),
  text: '尚未完成',
  toolCount: 1,
});
test('Plan persists owner-scoped acceptance steps, forbids invented completion in readonly mode and requires exact approval revision', () =>
  fixture((s) => {
    const p = s.plan(
      'alice',
      'session',
      'project',
      {
        objective: '做一个冲刺游戏',
        steps: [
          {
            id: 'build',
            text: '实现移动与冲刺',
            status: 'pending',
            acceptance: '实际输入能移动并有冲刺冷却',
          },
        ],
      },
      true,
    );
    assert.equal(s.view('bob', 'session').plan, undefined);
    assert.throws(() => s.approvePlan('alice', 'session', p.revision + 1));
    assert(s.approvePlan('alice', 'session', p.revision).approvedAt);
    assert.throws(() =>
      s.plan(
        'alice',
        'session',
        'project',
        { objective: 'x', steps: [{ id: 'x', text: 'x', status: 'completed', acceptance: 'x' }] },
        true,
      ),
    );
  }));
test('Goal round budget is durable, is never completion, and cannot be bypassed by continue', () =>
  fixture((s) => {
    let g = s.create('alice', 'session', 'project', '完成可玩游戏', 'ark', {
      maxRounds: 2,
      evidencePolicy: 'runtime',
    });
    s.begin('alice', g.id, 'r1');
    s.finishRun('alice', run('r1', g.id));
    g = s.goal('alice', 'session')!;
    assert.equal(g.status, 'active');
    assert(g.nextRunAt);
    assert.throws(() =>
      s.complete('alice', 'session', [{ kind: 'file', ref: 'main.gd', summary: 'exists' }]),
    );
    s.begin('alice', g.id, 'r2');
    s.finishRun('alice', run('r2', g.id));
    g = s.goal('alice', 'session')!;
    assert.equal(g.status, 'budget_limited');
    assert.equal(g.rounds, 2);
    assert.throws(() => s.begin('alice', g.id, 'r3'));
    assert.throws(() => s.control('alice', 'session', 'resume', g.revision));
    assert.equal(s.view('bob', 'session').goal, undefined);
  }));
test('paused or restarted goals retain objective without replaying unknown effects or dispatching idle continuations', () =>
  fixture((s, store) => {
    const g = s.create('alice', 'session', 'project', '保留当前目标', 'ark', {
      maxRounds: 3,
      evidencePolicy: 'artifact',
    });
    const current = s.begin('alice', g.id, 'r1');
    assert.throws(() => s.control('alice', 'session', 'pause', current.revision - 1));
    s.control('alice', 'session', 'pause', current.revision);
    s.finishRun('alice', run('r1', g.id, 'cancelled'));
    const paused = s.goal('alice', 'session')!;
    assert.equal(paused.status, 'paused');
    assert.equal(s.due().length, 0);
    s.control('alice', 'session', 'resume', paused.revision);
    const restarted = new WorkflowService(store);
    const restored = restarted.goal('alice', 'session')!;
    assert.equal(restored.status, 'interrupted');
    assert.equal(restored.objective, '保留当前目标');
    assert.equal(restored.rounds, 1);
    assert.equal(restarted.due().length, 0);
  }));
test('capability requests wait for explicit approval, are owner scoped and do not authorize tools by themselves', () =>
  fixture((s) => {
    const g = s.create('alice', 'session', 'project', '实现游戏', 'ark', {
      maxRounds: 3,
      evidencePolicy: 'artifact',
    });
    s.begin('alice', g.id, 'r1');
    const r = s.request('alice', 'session', 'project', 'writer', '需要写入游戏代码');
    assert.equal(s.goal('alice', 'session')!.status, 'waiting_permission');
    assert.equal(s.view('bob', 'session').requests.length, 0);
    assert.throws(() => s.resolve('bob', 'session', r.id, true));
    assert.equal(s.request('alice', 'session', 'project', 'writer', 'still needed').id, r.id);
    s.finishRun('alice', run('r1', g.id));
    assert.equal(s.due().length, 0);
    s.resolve('alice', 'session', r.id, true);
    assert.equal(s.goal('alice', 'session')!.status, 'active');
    assert.equal(s.due().length, 1);
  }));

test('declining a capability pauses the goal, and extra rounds never bypass an unresolved permission', () =>
  fixture((s) => {
    const goal = s.create('alice', 'session', 'project', '实现游戏', 'ark', {
      maxRounds: 1,
      evidencePolicy: 'artifact',
    });
    s.begin('alice', goal.id, 'r1');
    const request = s.request('alice', 'session', 'project', 'writer', '需要写入');
    s.finishRun('alice', run('r1', goal.id));
    let current = s.goal('alice', 'session')!;
    s.extendBudget('alice', 'session', current.revision, 2);
    assert.equal(s.goal('alice', 'session')!.status, 'waiting_permission');
    assert.equal(s.due().length, 0);
    s.resolve('alice', 'session', request.id, false);
    current = s.goal('alice', 'session')!;
    assert.equal(current.status, 'paused');
    assert.equal(s.due().length, 0);
    assert.equal(s.view('alice', 'session').requests.length, 0);
    s.control('alice', 'session', 'resume', current.revision);
    assert.equal(s.due().length, 1);
  }));
