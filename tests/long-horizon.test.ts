import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../packages/shared/store.ts';
import { WorkflowService, workflowTools } from '../apps/agent/workflows.ts';
import { goalDigest } from '../apps/agent/long-horizon.ts';
import type { AgentGoal, GoalEvidence, Run } from '../packages/shared/types.ts';
const owner = 'alice',
  session = 'session',
  project = 'project';
const source = goalDigest('source-1'),
  environment = goalDigest('environment-1');
const objective = '战前五轮预选，然后战中选择技能，五波Boss与结算';
async function fixture(
  fn: (
    service: WorkflowService,
    store: Store,
    advance: (ms: number) => void,
  ) => Promise<void> | void,
) {
  const dir = await mkdtemp(join(tmpdir(), 'lm-long-goal-')),
    store = new Store(join(dir, 'local.sqlite'));
  let clock = Date.now();
  try {
    await fn(new WorkflowService(store, () => clock), store, (ms) => {
      clock += ms;
    });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}
const create = (s: WorkflowService, options: object = {}) =>
  s.create(owner, session, project, objective, 'ark', { evidencePolicy: 'playtest', ...options });
const step = (id = 'battle') => ({
  id,
  text: '实现战中选技并恢复战斗',
  status: 'pending' as const,
  acceptance: '真实输入选择技能后层数变化，恢复战斗',
});
const proof = (ref = 'probe-1', version = source): GoalEvidence => ({
  kind: 'playtest',
  ref,
  sha256: version,
  sourceVersion: version,
  environmentVersion: environment,
  summary: 'Fixture representing the trusted playtest verifier, not a model report',
});
const running = (g: AgentGoal, id = 'run-1') =>
  ({
    id,
    goalId: g.id,
    sessionId: session,
    projectId: project,
    mode: 'ark',
    status: 'completed',
    prompt: objective,
    startedAt: new Date().toISOString(),
    text: 'reported',
    toolCount: 1,
  }) as Run;
test('goal contract and global acceptance survive rolling plans and reject model retargeting or cached goal tampering', () =>
  fixture((s, store) => {
    const g = create(s);
    assert.equal(g.maxRounds, 12);
    assert.equal(g.maxMinutes, 60);
    const first = s.plan(owner, session, project, { objective, steps: [step()] });
    assert.equal(first.acceptanceAnchors?.[0].id, 'battle');
    s.plan(owner, session, project, { objective, steps: [step('polish')] });
    assert.equal(
      s.runtimePolicy(owner, session)?.acceptanceAnchors[0].id,
      'battle',
      'local plan cannot erase global acceptance',
    );
    assert.throws(
      () => s.plan(owner, session, project, { objective: '写一份介绍即可', steps: [step()] }),
      /不能改写/,
    );
    assert.throws(
      () => store.db.prepare("UPDATE records SET data='{}' WHERE kind='goal-contract'").run(),
      /immutable goal/,
    );
    assert.throws(() => store.remove('goal-outline', g.id, owner), /immutable goal/);
    store.put('agent-goal', owner, {
      ...s.goal(owner, session)!,
      objective: 'tampered-cache-target',
    });
    assert.throws(() => s.begin(owner, g.id, 'run-1'), /偏离/);
    assert.equal(s.goal('bob', session), undefined);
  }));
test('real user amendments append a new immutable contract while stale plan and completion results are rejected', () =>
  fixture((s) => {
    const g = create(s);
    s.begin(owner, g.id, 'run-1');
    s.plan(owner, session, project, { objective, steps: [step()] });
    const accepted = proof();
    s.checkpoint(owner, g.id, 'run-1', {
      phase: 'acceptance',
      sourceVersion: source,
      environmentVersion: environment,
      verifiedEvidence: [accepted as Required<typeof accepted>],
    });
    const changed = s.amend(
      owner,
      session,
      '战中至少出现两次随机选技，不能只做战前菜单',
      'user-message-2',
    );
    assert.equal(changed.objective, objective);
    assert.equal(changed.contractVersion, 2);
    assert.notEqual(changed.contractHash, g.contractHash);
    assert.deepEqual(changed.runtime?.verifiedEvidence, []);
    assert.equal(s.amend(owner, session, '继续').contractVersion, 2);
    assert.equal(
      s.amend(owner, session, changed.userConstraints![0].text, 'user-message-2').contractVersion,
      2,
    );
    assert.throws(() => s.amend(owner, session, '替换已保存原文', 'user-message-2'), /消息ID/);
    assert.throws(
      () =>
        s.plan(owner, session, project, {
          objective,
          contractHash: g.contractHash,
          steps: [step()],
        }),
      /版本已更新/,
    );
    s.plan(owner, session, project, {
      objective,
      contractHash: changed.contractHash,
      steps: [step()],
    });
    assert.throws(() => s.complete(owner, session, [accepted], g.contractHash), /契约已变化/);
    assert.throws(() => s.complete(owner, session, [accepted], changed.contractHash), /真实验证器/);
    const fresh = proof('probe-after-amendment');
    s.checkpoint(owner, g.id, 'run-1', {
      phase: 'acceptance',
      sourceVersion: source,
      environmentVersion: environment,
      verifiedEvidence: [fresh as Required<typeof fresh>],
      activeErrors: [],
    });
    assert.equal(s.complete(owner, session, [fresh], changed.contractHash).status, 'completed');
  }));
test('five recurring actual failures stop despite file changes and updates to line numbers', () =>
  fixture((s) => {
    const g = create(s);
    s.begin(owner, g.id, 'run-1');
    s.checkpoint(owner, g.id, 'run-1', {
      phase: 'start',
      sourceVersion: source,
      environmentVersion: environment,
    });
    let current = source;
    for (let i = 1; i <= 5; i++) {
      current = goalDigest('source-' + (i + 1));
      s.checkpoint(owner, g.id, 'run-1', {
        phase: 'tool',
        sourceVersion: current,
        environmentVersion: environment,
        operation: { name: 'edit_file', argsSha256: goalDigest('fix-' + i), succeeded: true },
      });
      const cp = s.checkpoint(owner, g.id, 'run-1', {
        phase: 'tool',
        sourceVersion: current,
        environmentVersion: environment,
        operation: {
          name: 'run_browser_playtest',
          argsSha256: goalDigest('same-test'),
          succeeded: false,
          error: `TypeError Cannot set properties of null at game.js:${30 + i}`,
        },
        activeErrors: ['DOM write failed'],
      });
      if (i === 3) assert.equal(cp.review.action, 'change_strategy');
    }
    assert.equal(s.goal(owner, session)?.status, 'blocked');
    assert.equal(s.guard(owner, g.id).allowed, false);
    assert.throws(() => s.complete(owner, session, [proof('fake-pass', current)]), /当前不能完成/);
  }));
test('repeated cached reads require a different operation and are not counted as progress', () =>
  fixture((s) => {
    const g = create(s);
    s.begin(owner, g.id, 'run-1');
    const operation = {
      name: 'read_file',
      argsSha256: goalDigest('same-file-page'),
      succeeded: true,
    };
    for (let i = 0; i < 3; i++)
      s.checkpoint(owner, g.id, 'run-1', {
        phase: 'tool',
        sourceVersion: source,
        environmentVersion: environment,
        operation,
      });
    assert.equal(s.guard(owner, g.id, operation).allowed, false);
    assert.equal(
      s.guard(owner, g.id, { name: 'read_file', argsSha256: goalDigest('specific-error-page') })
        .allowed,
      true,
    );
    assert.equal(s.goal(owner, session)?.runtime?.lastProgressCheckpointId, undefined);
  }));
test('external source drift invalidates old results, blocks direct writes and requires rebase before fresh validation', () =>
  fixture((s) => {
    const g = create(s);
    s.begin(owner, g.id, 'run-1');
    s.plan(owner, session, project, { objective, steps: [step()] });
    const accepted = proof();
    s.checkpoint(owner, g.id, 'run-1', {
      phase: 'acceptance',
      sourceVersion: source,
      environmentVersion: environment,
      verifiedEvidence: [accepted as Required<typeof accepted>],
    });
    const next = goalDigest('external-edit');
    const drift = s.checkpoint(owner, g.id, 'run-1', {
      phase: 'start',
      sourceVersion: next,
      environmentVersion: environment,
    });
    assert.equal(drift.review.action, 'rebase');
    assert.deepEqual(drift.goal.runtime?.verifiedEvidence, []);
    assert.equal(
      s.guard(owner, g.id, { name: 'write_file', argsSha256: goalDigest('old-plan-write') })
        .allowed,
      false,
    );
    assert.equal(
      s.guard(owner, g.id, { name: 'read_file', argsSha256: goalDigest('inspect-current') })
        .allowed,
      true,
    );
    assert.throws(() => s.complete(owner, session, [accepted]), /重新核对/);
    s.plan(owner, session, project, { objective, steps: [step('rebase')] });
    s.checkpoint(owner, g.id, 'run-1', {
      phase: 'acceptance',
      sourceVersion: next,
      environmentVersion: environment,
      verifiedEvidence: [accepted as Required<typeof accepted>],
    });
    assert.throws(() => s.complete(owner, session, [accepted]), /当前源码/);
    const fresh = proof('new-test', next);
    s.checkpoint(owner, g.id, 'run-1', {
      phase: 'acceptance',
      sourceVersion: next,
      environmentVersion: environment,
      verifiedEvidence: [fresh as Required<typeof fresh>],
      activeErrors: [],
    });
    assert.equal(s.complete(owner, session, [fresh]).status, 'completed');
  }));
test('runtime errors, unverified children and conflicting leases veto a reported pass', () =>
  fixture((s) => {
    const g = create(s);
    s.begin(owner, g.id, 'run-1');
    const accepted = proof();
    for (const blocker of [
      { activeErrors: ['browser exception'] },
      { unresolvedChildren: 1, activeErrors: [] },
      { conflictedLeases: 1, unresolvedChildren: 0 },
    ]) {
      s.checkpoint(owner, g.id, 'run-1', {
        phase: 'acceptance',
        sourceVersion: source,
        environmentVersion: environment,
        verifiedEvidence: [accepted as Required<typeof accepted>],
        ...blocker,
      });
      assert.throws(() => s.complete(owner, session, [accepted]), /实际错误|共享资源/);
    }
    s.checkpoint(owner, g.id, 'run-1', {
      phase: 'acceptance',
      sourceVersion: source,
      environmentVersion: environment,
      verifiedEvidence: [accepted as Required<typeof accepted>],
      activeErrors: [],
      unresolvedChildren: 0,
      conflictedLeases: 0,
    });
    assert.equal(s.complete(owner, session, [accepted]).status, 'completed');
    assert.equal(s.guard(owner, g.id).allowed, false);
    assert.equal(
      s.goal(owner, session)?.status,
      'completed',
      'a guard cannot downgrade terminal success',
    );
  }));
test('active execution time budget stops work and only an explicit increase preserves and extends consumed time', () =>
  fixture((s, _store, advance) => {
    const g = create(s, { maxMinutes: 1 });
    s.begin(owner, g.id, 'run-1');
    s.checkpoint(owner, g.id, 'run-1', {
      phase: 'start',
      sourceVersion: source,
      environmentVersion: environment,
    });
    advance(61000);
    assert.equal(s.guard(owner, g.id).action, 'budget_limited');
    s.finishRun(owner, running(g));
    const limited = s.goal(owner, session)!;
    assert.equal(limited.status, 'budget_limited');
    assert.equal(limited.activeElapsedMs, 61000);
    assert.throws(() => s.control(owner, session, 'resume', limited.revision), /预算/);
    assert.throws(() => s.create(owner, session, project, '继续', 'ark', {}), /重置/);
    const extended = s.extendBudget(owner, session, limited.revision, limited.maxRounds, 2);
    assert.equal(extended.activeElapsedMs, 61000);
    assert.equal(extended.maxMinutes, 2);
    assert.equal(extended.status, 'active');
  }));
test('restart preserves immutable constraints and interrupted intent, while checkpoint history is private and immutable', () =>
  fixture((s, store) => {
    const g = create(s);
    s.begin(owner, g.id, 'run-1');
    const cp = s.checkpoint(owner, g.id, 'run-1', {
      phase: 'start',
      sourceVersion: source,
      environmentVersion: environment,
    });
    assert.equal(s.checkpoints(owner, session)[0].id, cp.checkpoint.id);
    assert.throws(() => s.checkpoints('bob', session), /不存在/);
    assert.throws(() => store.remove('goal-checkpoint', cp.checkpoint.id, owner), /immutable goal/);
    const restart = new WorkflowService(store);
    const restored = restart.goal(owner, session)!;
    assert.equal(restored.status, 'interrupted');
    assert.equal(restored.contractHash, g.contractHash);
    assert.equal(restart.due().length, 0);
  }));
test('an actual user amendment during asynchronous evidence verification rejects the old completion attempt', () =>
  fixture(async (s) => {
    const g = create(s, { evidencePolicy: 'artifact' });
    const tool = workflowTools(s, owner, session, project, false, [], async () => {
      s.amend(owner, session, '再增加一个可验证条件', 'new-user-message');
      return [{ kind: 'file', ref: 'main.js', sha256: source, summary: 'actual hash fixture' }];
    }).find((t) => t.name === 'complete_goal')!;
    const result = await tool.execute(
      'call',
      { evidence: [{ kind: 'file', ref: 'main.js' }] },
      new AbortController().signal,
    );
    assert.equal((result.details as { failed: boolean }).failed, true);
    assert.match((result.content[0] as { text: string }).text, /契约已变化/);
    assert.notEqual(s.goal(owner, session)?.status, 'completed');
    assert.equal(s.goal(owner, session)?.contractVersion, 2);
    assert.equal(g.contractVersion, 1);
  }));

test('an own write with an additional externally changed path still requires environment rebase', () =>
  fixture((s) => {
    const g = create(s);
    s.begin(owner, g.id, 'run-1');
    s.checkpoint(owner, g.id, 'run-1', {
      phase: 'start',
      sourceVersion: source,
      environmentVersion: environment,
    });
    const changed = s.checkpoint(owner, g.id, 'run-1', {
      phase: 'tool',
      sourceVersion: goalDigest('own-and-external-change'),
      environmentVersion: environment,
      externalChange: true,
      operation: { name: 'edit_file', argsSha256: goalDigest('my-file'), succeeded: true },
    });
    assert.equal(changed.review.action, 'rebase');
    assert(changed.review.findings.some((v) => v.code === 'environment_changed'));
  }));

test('final readback can revoke an unsettled completion, but later edits never restart a historical completed goal', () =>
  fixture((s) => {
    const g = create(s);
    s.begin(owner, g.id, 'run-1');
    const accepted = proof();
    s.checkpoint(owner, g.id, 'run-1', {
      phase: 'acceptance',
      sourceVersion: source,
      environmentVersion: environment,
      verifiedEvidence: [accepted as Required<typeof accepted>],
    });
    const completed = s.complete(owner, session, [accepted]);
    assert.equal(completed.completion?.sourceVersion, source);
    const invalid = s.invalidateEvidence(
      owner,
      session,
      'Final real readback detected source changes after acceptance',
    );
    assert.equal(invalid.status, 'active');
    assert.deepEqual(invalid.evidence, []);
    assert.equal(invalid.runtime?.action, 'rebase');
    s.plan(owner, session, project, { objective, steps: [step()] });
    s.checkpoint(owner, g.id, 'run-1', {
      phase: 'acceptance',
      sourceVersion: source,
      environmentVersion: environment,
      verifiedEvidence: [accepted as Required<typeof accepted>],
      activeErrors: [],
    });
    s.complete(owner, session, [accepted]);
    s.finishRun(owner, running(g));
    const historical = s.goal(owner, session)!;
    assert.equal(historical.status, 'completed');
    assert.equal(historical.currentRunId, undefined);
    assert.equal(
      s.invalidateEvidence(owner, session, 'Future user edit').revision,
      historical.revision,
    );
    assert.equal(s.goal(owner, session)?.status, 'completed');
  }));

test('a four-round rolling window preserves global acceptance and requires a new local plan before more writes', () =>
  fixture((s, _store, advance) => {
    const g = create(s, { maxRounds: 8, evidencePolicy: 'artifact' });
    s.plan(owner, session, project, { objective, steps: [step()] });
    for (let round = 1; round <= 4; round++) {
      s.begin(owner, g.id, 'run-' + round);
      if (round === 1)
        s.checkpoint(owner, g.id, 'run-1', {
          phase: 'start',
          sourceVersion: source,
          environmentVersion: environment,
        });
      advance(10);
      s.checkpoint(owner, g.id, 'run-' + round, {
        phase: 'tool',
        sourceVersion: goalDigest('version-' + round),
        environmentVersion: environment,
        operation: { name: 'write_file', argsSha256: goalDigest('file-' + round), succeeded: true },
      });
      s.finishRun(owner, running(g, 'run-' + round));
    }
    s.begin(owner, g.id, 'run-5');
    assert.equal(s.runtimePolicy(owner, session)?.needsPlanRefresh, true);
    assert.equal(
      s.guard(owner, g.id, { name: 'write_file', argsSha256: goalDigest('next-file') }).allowed,
      false,
    );
    const next = s.plan(owner, session, project, { objective, steps: [step('new-window')] });
    assert.equal(next.window, 2);
    assert.equal(next.acceptanceAnchors?.[0].id, 'battle');
    assert.equal(
      s.guard(owner, g.id, { name: 'write_file', argsSha256: goalDigest('next-file') }).allowed,
      true,
    );
  }));

test('a forged mutable goal projection cannot erase errors or add proof to the immutable checkpoint', () =>
  fixture((s, store) => {
    const g = create(s);
    s.begin(owner, g.id, 'run-1');
    s.checkpoint(owner, g.id, 'run-1', {
      phase: 'tool',
      sourceVersion: source,
      environmentVersion: environment,
      activeErrors: ['actual browser crash'],
      conflictedLeases: 1,
    });
    const cached = s.goal(owner, session)!;
    assert.deepEqual(s.runtimePolicy(owner,session)?.activeErrors,['actual browser crash']);
    store.put('agent-goal', owner, {
      ...cached,
      runtime: {
        ...cached.runtime!,
        activeErrors: [],
        conflictedLeases: 0,
        verifiedEvidence: [proof() as Required<GoalEvidence>],
      },
    });
    assert.deepEqual(s.runtimePolicy(owner,session)?.activeErrors,['actual browser crash'],'immutable runtime observations survive a falsely clean mutable cache');
    assert.throws(() => s.complete(owner, session, [proof()]), /实际错误|共享资源/);
    assert.notEqual(s.goal(owner, session)?.status, 'completed');
  }));

test('legacy goals get a disclosed baseline contract without fabricating old verification or replaying work', () =>
  fixture((_s, store) => {
    const legacy = {
      id: 'legacy-goal',
      sessionId: session,
      projectId: project,
      objective,
      provider: 'ark',
      evidencePolicy: 'playtest',
      status: 'paused',
      maxRounds: 3,
      rounds: 1,
      noProgressRounds: 0,
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      evidence: [],
    } as AgentGoal;
    store.put('agent-goal', owner, { ...legacy, ownerId: owner });
    const restored = new WorkflowService(store);
    const goal = restored.goal(owner, session)!;
    assert.equal(goal.contractProvenance, 'legacy-baseline');
    assert.equal(goal.status, 'paused');
    assert.equal(restored.checkpoints(owner, session).length, 0);
    assert.equal(restored.due().length, 0);
    assert.deepEqual(goal.evidence, []);
  }));

test('fresh file hashes cannot reset repeated runtime failure for a playtest goal', () =>
  fixture((s) => {
    const g = create(s);
    s.begin(owner, g.id, 'run-1');
    s.checkpoint(owner, g.id, 'run-1', {
      phase: 'start',
      sourceVersion: source,
      environmentVersion: environment,
    });
    for (let i = 1; i <= 5; i++) {
      const version = goalDigest('version-' + i);
      s.checkpoint(owner, g.id, 'run-1', {
        phase: 'tool',
        sourceVersion: version,
        environmentVersion: environment,
        operation: { name: 'edit_file', argsSha256: goalDigest('change-' + i), succeeded: true },
        verifiedEvidence: [
          {
            kind: 'file',
            ref: 'file-' + i,
            sha256: version,
            sourceVersion: version,
            environmentVersion: environment,
          },
        ],
      });
      s.checkpoint(owner, g.id, 'run-1', {
        phase: 'tool',
        sourceVersion: version,
        environmentVersion: environment,
        operation: {
          name: 'run_browser_playtest',
          argsSha256: goalDigest('run'),
          succeeded: false,
          error: 'The same runtime assertion failed',
        },
        activeErrors: ['failed'],
      });
    }
    assert.equal(s.goal(owner, session)?.status, 'blocked');
    assert.equal(s.goal(owner, session)?.runtime?.repeatedFailure, 5);
  }));

test('a completion accepted within budget is not downgraded when final readback crosses the deadline', () =>
  fixture((s, _store, advance) => {
    const g = create(s, { maxMinutes: 1 });
    s.begin(owner, g.id, 'run-1');
    advance(59900);
    const accepted = proof();
    s.checkpoint(owner, g.id, 'run-1', {
      phase: 'acceptance',
      sourceVersion: source,
      environmentVersion: environment,
      verifiedEvidence: [accepted as Required<typeof accepted>],
      activeErrors: [],
    });
    s.complete(owner, session, [accepted]);
    advance(200);
    const final = s.checkpoint(owner, g.id, 'run-1', {
      phase: 'finish',
      sourceVersion: source,
      environmentVersion: environment,
    });
    assert.equal(final.goal.status, 'completed');
    for (let i = 0; i < 5; i++)
      s.checkpoint(owner, g.id, 'run-1', {
        phase: 'tool',
        sourceVersion: source,
        environmentVersion: environment,
        operation: {
          name: 'write_file',
          argsSha256: goalDigest('denied-after-completion'),
          succeeded: false,
          error: 'Goal already completed; side effect rejected',
        },
      });
    assert.equal(
      s.goal(owner, session)?.status,
      'completed',
      'rejected attempts cannot replace an accepted timepoint verdict',
    );
    s.finishRun(owner, running(g));
    assert.equal(s.goal(owner, session)?.status, 'completed');
  }));

test('restart clears dead current-run IDs while preserving paused intent and unsettled completion history', () =>
  fixture((s, store) => {
    const goals = ['paused', 'waiting_permission', 'completed'].map((status) => {
      const scope = 'session-' + status;
      const g = s.create(owner, scope, project, objective, 'ark', { evidencePolicy: 'artifact' });
      s.begin(owner, g.id, 'run-' + status);
      if (status === 'paused') s.control(owner, scope, 'pause', s.goal(owner, scope)!.revision);
      else if (status === 'waiting_permission')
        s.request(owner, scope, project, 'writer', 'Wait for explicit access');
      else
        s.complete(owner, scope, [
          {
            kind: 'file',
            ref: 'verified-file',
            sha256: source,
            summary: 'trusted file verifier fixture',
          },
        ]);
      return { scope, status, g };
    });
    const restored = new WorkflowService(store);
    for (const { scope, status, g } of goals) {
      const next = restored.goal(owner, scope)!;
      assert.equal(next.currentRunId, undefined);
      assert.equal(next.contractHash, g.contractHash);
      assert.equal(next.status, status === 'paused' ? 'paused' : 'interrupted');
      if (status === 'completed') {
        assert(next.completion);
        assert.deepEqual(next.evidence, []);
      }
    }
    assert.equal(restored.due().length, 0);
  }));

test('distinct real source-read results count as inspection progress without becoming completion proof', () =>
  fixture((s) => {
    const g = create(s);
    s.begin(owner, g.id, 'run-1');
    for (let i = 0; i < 20; i++)
      s.checkpoint(owner, g.id, 'run-1', {
        phase: 'tool',
        sourceVersion: source,
        environmentVersion: environment,
        operation: {
          name: 'read_file',
          argsSha256: goalDigest('file-' + i),
          resultSha256: goalDigest('actual source bytes ' + i),
          succeeded: true,
        },
      });
    assert.equal(s.goal(owner, session)?.status, 'active');
    assert.equal(s.goal(owner, session)?.runtime?.noProgressCheckpoints, 0);
    assert.deepEqual(s.goal(owner, session)?.runtime?.verifiedEvidence, []);
    assert.throws(() => s.complete(owner, session, [proof()]), /真实验证器/);
  }));

test('repeated plan editing cannot reset a no-progress read loop', () =>
  fixture((s) => {
    const g = create(s);
    s.begin(owner, g.id, 'run-1');
    for (let i = 1; i <= 16; i++) {
      s.checkpoint(owner, g.id, 'run-1', {
        phase: 'tool',
        sourceVersion: source,
        environmentVersion: environment,
        operation: { name: 'read_file', argsSha256: goalDigest('cached-page'), succeeded: true },
      });
      if (i < 16 && i % 3 === 0)
        s.plan(owner, session, project, { objective, steps: [step('plan-' + i)] });
    }
    assert.equal(s.goal(owner, session)?.status, 'blocked');
    assert.equal(s.goal(owner, session)?.runtime?.noProgressCheckpoints, 16);
  }));

test('an entire stale goal projection cannot roll back a newer immutable user constraint contract', () =>
  fixture((s, store) => {
    const original = create(s);
    const oldProjection = structuredClone(s.goal(owner, session)!);
    const amended = s.amend(owner, session, '战斗中必须再次选技能，并且验证第二次选技能恢复战斗', 'user-amendment');
    assert.equal(amended.contractVersion, 2);
    store.put('agent-goal', owner, oldProjection);
    assert.throws(() => s.runtimePolicy(owner, session), /最新|版本|契约/);
    assert.throws(() => s.begin(owner, original.id, 'must-not-run'), /最新|版本|契约/);
  }));
