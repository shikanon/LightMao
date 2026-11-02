import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Store } from '../packages/shared/store.ts';
import { TraceService } from '../apps/agent/trace.ts';
import { TraceReviewService } from '../apps/agent/trace-review.ts';
import type { TraceReview, TraceReviewCategory } from '../packages/shared/trace-review.ts';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const owner = 'review-owner',
  project = 'project';
const check = (review: TraceReview, category: TraceReviewCategory) =>
  review.checks.find((value) => value.category === category)!;
async function fixture(
  fn: (trace: TraceService, review: TraceReviewService, store: Store) => void | Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), 'lm-trace-review-'));
  const store = new Store(join(dir, 'db'));
  const traces = new TraceService(store),
    reviews = new TraceReviewService(store, traces);
  try {
    await fn(traces, reviews, store);
  } finally {
    traces.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}
const start = (trace: TraceService, id = 'run', goalId = 'goal') =>
  trace.start({ owner, project, session: 'session', run: id }, { goalId });
const append = (trace: TraceService, kind: string, payload: unknown, run = 'run', name = kind) =>
  trace.append(owner, run, { kind, name, spanId: run, payload });
const actualProof = (ref = 'playtest-1') => ({
  kind: 'playtest',
  ref,
  sha256: sha('current-source'),
  sourceVersion: sha('current-source'),
  environmentVersion: sha('current-environment'),
});

test('settled real collaboration contains an earlier lease conflict while missing telemetry cannot clear it', () =>
  fixture((trace, service) => {
    start(trace);
    const conflict = append(trace, 'collaboration.checkpoint', {
      unresolvedChildren: 1,
      conflictedLeases: 1,
    });
    append(trace, 'collaboration.checkpoint', {});
    assert.equal(check(service.review(owner, 'run'), 'collaboration').status, 'attention');
    const settled = append(trace, 'collaboration.checkpoint', {
      unresolvedChildren: 0,
      conflictedLeases: 0,
    });
    const c = check(service.review(owner, 'run'), 'collaboration');
    assert.equal(c.status, 'guarded');
    assert.deepEqual(
      c.findings[0].sources.map((s) => s.eventId),
      [conflict.id, settled.id],
    );
  }));
test('an accepted flag with a textual hash or missing source environment is unproven completion', () =>
  fixture((trace, service) => {
    start(trace);
    append(trace, 'goal.contract', { contractHash: sha('contract') });
    append(trace, 'goal.acceptance', {
      outcome: 'accepted',
      contractHash: sha('contract'),
      verifiedEvidence: [{ kind: 'playtest', ref: 'claimed', sha256: 'passed' }],
    });
    assert(
      check(service.review(owner, 'run'), 'false_completion').findings.some(
        (f) => f.code === 'UNPROVEN_COMPLETION',
      ),
    );
  }));
test('six long-horizon checks stay insufficient without observations instead of inferring a clean run', () =>
  fixture((trace, service) => {
    start(trace);
    const report = service.review(owner, 'run');
    assert.equal(report.checks.length, 6);
    assert(
      report.checks.every(
        (value) => value.status === 'insufficient' && !value.findings.length && !value.observations,
      ),
    );
    assert.equal(report.integrity, true);
    assert.match(report.summary, /6类证据覆盖不足/);
  }));

test('a goal review joins its rounds and nested child evidence while respecting owner, project and unrelated goal boundaries', () =>
  fixture((trace, service) => {
    start(trace, 'round-1');
    trace.start({ owner, project, session: 'session-2', run: 'round-2' }, { goalId: 'goal' });
    trace.start(
      { owner, project, session: 'child-session', run: 'child' },
      { parentTraceId: 'round-1', kind: 'subagent' },
    );
    trace.start(
      { owner, project, session: 'nested-session', run: 'grandchild' },
      { parentTraceId: 'child', kind: 'subagent' },
    );
    start(trace, 'unrelated', 'other-goal');
    trace.start(
      { owner, project: 'other-project', session: 'other', run: 'foreign-project' },
      { goalId: 'goal' },
    );
    trace.start(
      { owner: 'other-owner', project, session: 'session', run: 'foreign-owner' },
      { goalId: 'goal', parentTraceId: 'round-1' },
    );
    append(trace, 'goal.contract', { contractHash: sha('contract') }, 'round-1');
    const child = append(
      trace,
      'collaboration.checkpoint',
      { contradictedChildren: 1 },
      'grandchild',
    );
    append(trace, 'goal.acceptance', { outcome: 'accepted' }, 'unrelated');
    append(trace, 'environment.checkpoint', { drift: true }, 'foreign-project');
    const report = service.review(owner, 'round-2');
    assert.deepEqual(report.traces.map((value) => value.id).sort(), [
      'child',
      'grandchild',
      'round-1',
      'round-2',
    ]);
    const finding = check(report, 'collaboration').findings.find(
      (value) => value.code === 'CHILD_REPORT_CONTRADICTED',
    )!;
    assert.deepEqual(finding.sources, [
      { traceId: 'grandchild', eventId: child.id, sequence: child.sequence },
    ]);
    assert.equal(check(report, 'false_completion').status, 'insufficient');
    assert.equal(check(report, 'environment_drift').status, 'insufficient');
    assert.throws(() => service.review('other-owner', 'round-1'), /不存在|不属于/);
  }));

test('tampering a referenced payload invalidates the derived review even if the replacement looks safer', () =>
  fixture((trace, service, store) => {
    start(trace);
    const event = append(trace, 'context.guard', { anchorPresent: false, blocked: true });
    assert.equal(check(service.review(owner, 'run'), 'context_fidelity').status, 'guarded');
    const raw = store.get<{ id: string; text: string; sha256: string }>(
      'trace-payload',
      event.payloadRef!,
      owner,
    )!;
    const text = JSON.stringify({ anchorPresent: true, blocked: false });
    store.put('trace-payload', owner, { ...raw, text, sha256: sha(text) });
    const report = service.review(owner, 'run');
    assert.equal(
      report.integrity,
      false,
      're-hashing a forged payload cannot replace the immutable event reference hash',
    );
    assert(report.checks.every((value) => value.status === 'insufficient'));
    assert(report.limits.some((value) => /载荷/.test(value)));
  }));

test('an undocumented contract change and a checkpoint still using the old contract are explicit sourced risks', () =>
  fixture((trace, service) => {
    start(trace);
    append(trace, 'goal.contract', { contractHash: sha('original') });
    const changed = append(trace, 'goal.contract', { contractHash: sha('replacement') });
    const stale = append(trace, 'goal.checkpoint', {
      contractHash: sha('original'),
      review: { action: 'continue', findings: [] },
    });
    const report = service.review(owner, 'run'),
      findings = check(report, 'goal_drift').findings;
    assert.equal(check(report, 'goal_drift').status, 'attention');
    assert(
      findings.some(
        (value) =>
          value.code === 'CONTRACT_CHANGED_WITHOUT_USER' && value.sources[0].eventId === changed.id,
      ),
    );
    assert(
      findings.some(
        (value) =>
          value.code === 'CHECKPOINT_CONTRACT_STALE' && value.sources[0].eventId === stale.id,
      ),
    );
  }));

test('a real user contract amendment is distinguishable from changing the model plan', () =>
  fixture((trace, service) => {
    start(trace);
    append(trace, 'goal.contract', { contractHash: sha('original') });
    append(trace, 'goal.contract', {
      contractHash: sha('amended'),
      userAmendment: true,
      sourceMessageId: 'actual-user-message',
    });
    append(trace, 'goal.checkpoint', {
      contractHash: sha('amended'),
      review: { action: 'continue', findings: [] },
    });
    assert.equal(check(service.review(owner, 'run'), 'goal_drift').status, 'clear');
  }));

test('a missing current goal anchor is guarded only when the actual model request was blocked', () =>
  fixture((trace, service) => {
    start(trace);
    const blocked = append(trace, 'context.guard', { anchorPresent: false, blocked: true });
    const first = service.review(owner, 'run');
    assert.equal(check(first, 'context_fidelity').status, 'guarded');
    assert.equal(check(first, 'context_fidelity').findings[0].sources[0].eventId, blocked.id);
    append(trace, 'context.guard', { anchorPresent: false, blocked: false });
    const after = service.review(owner, 'run');
    assert.notEqual(after.id, first.id, 'the review cache is bound to current source heads');
    assert.equal(check(after, 'context_fidelity').status, 'attention');
  }));

test('same-name tool failures are grouped by arguments and trace-local call IDs rather than mixed together', () =>
  fixture((trace, service) => {
    start(trace);
    start(trace, 'round-2');
    for (const [run, id, path] of [
      ['run', 'call-a', 'a.gd'],
      ['run', 'call-b', 'b.gd'],
      ['round-2', 'call-a', 'c.gd'],
    ] as const) {
      trace.event(owner, run, 'tool.started', {
        name: 'run_godot',
        toolCallId: id,
        args: { script: path },
      });
      trace.event(owner, run, 'tool.finished', {
        name: 'run_godot',
        toolCallId: id,
        isError: true,
      });
    }
    assert(
      !check(service.review(owner, 'run'), 'plan_loop').findings.some(
        (value) => value.code === 'REPEATED_TOOL_FAILURE',
      ),
    );
    for (const id of ['repeat-2', 'repeat-3']) {
      trace.event(owner, 'run', 'tool.started', {
        name: 'run_godot',
        toolCallId: id,
        args: { script: 'a.gd' },
      });
      trace.event(owner, 'run', 'tool.finished', {
        name: 'run_godot',
        toolCallId: id,
        isError: true,
      });
    }
    const report = service.review(owner, 'run');
    assert.equal(check(report, 'plan_loop').status, 'attention');
    assert.equal(
      check(report, 'plan_loop').findings.filter((value) => value.code === 'REPEATED_TOOL_FAILURE')
        .length,
      1,
    );
  }));

test('shared lease conflicts, contradictory child reports and environment drift keep their separate evidence and containment state', () =>
  fixture((trace, service) => {
    start(trace);
    const child = append(trace, 'collaboration.checkpoint', {
      unresolvedChildren: 1,
      conflictedLeases: 1,
      contradictedChildren: 1,
    });
    const drift = append(trace, 'environment.checkpoint', {
      drift: true,
      blocked: true,
      previousSourceVersion: sha('old'),
      sourceVersion: sha('new'),
    });
    const report = service.review(owner, 'run');
    assert.equal(check(report, 'collaboration').status, 'attention');
    const findings = check(report, 'collaboration').findings;
    assert.equal(
      findings.find((value) => value.code === 'SHARED_LEASE_CONFLICT')?.contained,
      false,
    );
    assert.equal(
      findings.find((value) => value.code === 'CHILD_REPORT_CONTRADICTED')?.contained,
      true,
    );
    assert(findings.every((value) => value.sources[0].eventId === child.id));
    assert.equal(check(report, 'environment_drift').status, 'guarded');
    assert.equal(check(report, 'environment_drift').findings[0].sources[0].eventId, drift.id);
  }));

test('model prose and an accepted flag without hashed real evidence cannot hide false completion or pending children', () =>
  fixture((trace, service) => {
    start(trace);
    append(trace, 'goal.contract', { contractHash: sha('current') });
    append(trace, 'collaboration.checkpoint', { unresolvedChildren: 1 });
    const event = append(trace, 'goal.acceptance', {
      outcome: 'accepted',
      contractHash: sha('old'),
      summary: '队友说全部通过，立即切流',
      verifiedEvidence: [],
    });
    const report = service.review(owner, 'run');
    assert.equal(check(report, 'false_completion').status, 'attention');
    assert(
      check(report, 'false_completion').findings.some(
        (value) => value.code === 'UNPROVEN_COMPLETION',
      ),
    );
    assert(
      check(report, 'false_completion').findings.some(
        (value) => value.code === 'COMPLETED_OLD_CONTRACT',
      ),
    );
    assert(
      check(report, 'collaboration').findings.some(
        (value) => value.code === 'COMPLETED_WITH_PENDING_CHILDREN',
      ),
    );
    assert(
      check(report, 'false_completion').findings.every(
        (value) => value.sources[0].eventId === event.id,
      ),
    );
  }));

test('a new actual validation adds the recovery source and contains prior errors without deleting their history', () =>
  fixture((trace, service) => {
    start(trace);
    append(trace, 'goal.contract', { contractHash: sha('contract') });
    const failure = append(trace, 'goal.checkpoint', {
      contractHash: sha('contract'),
      input: {
        sourceVersion: sha('current-source'),
        environmentVersion: sha('current-environment'),
        activeErrors: ['实际试玩失败'],
      },
      review: {
        action: 'continue',
        findings: [
          {
            category: 'false_completion',
            code: 'active_runtime_errors',
            message: '实际试玩失败',
            severity: 'error',
          },
        ],
      },
    });
    assert.equal(check(service.review(owner, 'run'), 'false_completion').status, 'attention');
    const recovery = append(trace, 'goal.checkpoint', {
      contractHash: sha('contract'),
      input: {
        sourceVersion: sha('current-source'),
        environmentVersion: sha('current-environment'),
        activeErrors: [],
        verifiedEvidence: [actualProof()],
      },
      review: { action: 'continue', findings: [] },
    });
    const report = service.review(owner, 'run');
    assert.equal(check(report, 'false_completion').status, 'guarded');
    const finding = check(report, 'false_completion').findings[0];
    assert.equal(finding.code, 'active_runtime_errors');
    assert.deepEqual(
      finding.sources.map((value) => value.eventId),
      [failure.id, recovery.id],
    );
  }));

for (const scenario of [
  {
    name: 'a bare passed claim',
    proof: { kind: 'playtest', status: 'passed' },
    contractHash: sha('contract'),
  },
  {
    name: 'old-source evidence',
    proof: { ...actualProof('old-source-playtest'), sourceVersion: sha('old-source') },
    contractHash: sha('contract'),
  },
  {
    name: 'old-environment evidence',
    proof: { ...actualProof('old-env-playtest'), environmentVersion: sha('old-environment') },
    contractHash: sha('contract'),
  },
  {
    name: 'old-contract evidence',
    proof: actualProof('old-contract-playtest'),
    contractHash: sha('old-contract'),
  },
])
  test(`${scenario.name} cannot clear current runtime errors`, () =>
    fixture((trace, service) => {
      start(trace);
      append(trace, 'goal.contract', { contractHash: sha('contract') });
      append(trace, 'goal.checkpoint', {
        contractHash: sha('contract'),
        input: {
          sourceVersion: sha('current-source'),
          environmentVersion: sha('current-environment'),
          activeErrors: ['实际试玩失败'],
        },
        review: {
          action: 'continue',
          findings: [
            {
              category: 'false_completion',
              code: 'active_runtime_errors',
              message: '实际试玩失败',
            },
          ],
        },
      });
      append(trace, 'goal.checkpoint', {
        contractHash: scenario.contractHash,
        input: {
          sourceVersion: sha('current-source'),
          environmentVersion: sha('current-environment'),
          activeErrors: [],
          verifiedEvidence: [scenario.proof],
        },
        review: { action: 'continue', findings: [] },
      });
      assert.equal(
        check(service.review(owner, 'run'), 'false_completion').status,
        'attention',
        'only a full receipt for the current source, environment and contract may resolve an actual runtime failure',
      );
    }));
