import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { Store } from '../packages/shared/store.ts';
import type { CloudBootstrap, GoalEvidence } from '../packages/shared/types.ts';
import type { EngineSnapshot } from '../apps/agent/engine-snapshot.ts';
import type { IsolatedExecutor } from '../apps/agent/isolation.ts';
import { WorkflowService } from '../apps/agent/workflows.ts';
import { TraceService } from '../apps/agent/trace.ts';
import { GoalObserver } from '../apps/agent/goal-observer.ts';

const owner = 'observer-owner',
  session = 'session',
  project = 'project',
  run = 'run';
const objective = '实现战中随机选技，五波敌人与Boss，并实际试玩核验';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const bootstrap = (): CloudBootstrap => ({
  user: {
    id: owner,
    name: 'Fixture',
    email: 'fixture@example.test',
    role: 'member',
    status: 'active',
    createdAt: '2026-11-02T00:00:00.000Z',
  },
  permissions: { mode: 'full', revision: 1 },
  plugins: [],
  skills: [],
  assets: [],
  model: {
    alias: 'ark',
    label: 'DeepSeek',
    modelId: 'deepseek-fixture',
    enabled: true,
    revision: 1,
  },
  arkConfigured: false,
  demoAllowed: false,
});

/** Only the isolated read-only fingerprint boundary is fake; workflow and trace persistence are real. */
class Fingerprints {
  files: Record<string, string> = { 'main.gd': 'original', 'ui.gd': 'original UI' };
  calls = 0;
  active = 0;
  maximumActive = 0;
  private gates: { entered: () => void; released: Promise<void> }[] = [];
  snapshot(): EngineSnapshot {
    const files = Object.entries(this.files)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, text]) => ({ path, bytes: Buffer.byteLength(text), sha256: sha(text) }));
    return {
      files,
      totalBytes: files.reduce((total, file) => total + file.bytes, 0),
      sha256: sha(JSON.stringify(files)),
      excluded: [],
      excludedCount: 0,
    };
  }
  holdNext() {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.gates.push({ entered, released });
    return { started, release };
  }
  async file<T>(
    _root: string,
    writable: boolean,
    operation: string,
    args: unknown,
    signal: AbortSignal,
  ): Promise<T> {
    assert.equal(writable, false, 'observation must never write the project');
    assert.equal(operation, 'fingerprint_project');
    assert.deepEqual(args, {});
    signal.throwIfAborted();
    this.calls++;
    this.active++;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    const snapshot = this.snapshot(),
      gate = this.gates.shift();
    try {
      gate?.entered();
      await gate?.released;
      signal.throwIfAborted();
      return snapshot as T;
    } finally {
      this.active--;
    }
  }
}

async function fixture(
  fn: (context: {
    observer: GoalObserver;
    workflows: WorkflowService;
    traces: TraceService;
    source: Fingerprints;
    cloud: CloudBootstrap;
    stops: string[];
  }) => Promise<void>,
  expectedPaths?: (name: string, args: unknown) => string[],
) {
  const dir = await mkdtemp(join(tmpdir(), 'lm-goal-observer-'));
  const store = new Store(join(dir, 'db')),
    workflows = new WorkflowService(store),
    traces = new TraceService(store);
  const created = workflows.create(owner, session, project, objective, 'ark', {
    evidencePolicy: 'playtest',
  });
  const goal = workflows.begin(owner, created.id, run);
  traces.start({ owner, project, session, run }, { goalId: goal.id });
  const source = new Fingerprints(),
    cloud = bootstrap(),
    stops: string[] = [];
  const observer = new GoalObserver({
    owner,
    session,
    run,
    goal,
    root: join(dir, 'project'),
    backend: 'https://backend.example.test',
    projectRevision: 1,
    executor: source as unknown as IsolatedExecutor,
    workflows,
    traces,
    signal: new AbortController().signal,
    stop: (reason) => {
      stops.push(reason);
    },
    collaboration: () => ({ unresolvedChildren: 0, conflictedLeases: 0, contradictedChildren: 0 }),
    expectedPaths,
  });
  try {
    await observer.start(cloud);
    await fn({ observer, workflows, traces, source, cloud, stops });
  } finally {
    observer.dispose();
    traces.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}
const evidence = (source: Fingerprints, ref = 'actual-playtest'): GoalEvidence => ({
  kind: 'playtest',
  ref,
  sha256: source.snapshot().sha256,
  summary: 'Trusted verifier fixture: real inputs and assertions already checked by the caller',
});

test('in-flight writes to their declared paths remain own changes when their observations finish in another order', () =>
  fixture(async ({ observer, workflows, source, cloud, stops }) => {
    const first = { path: './main.gd', content: 'first write' },
      second = { path: 'ui.gd', content: 'second write' };
    assert.equal((await observer.before('write_file', first, cloud)).allowed, true);
    source.files['main.gd'] = first.content;
    assert.equal(
      (await observer.before('write_file', second, cloud)).allowed,
      true,
      'an unfinished own write is not external interference',
    );
    source.files['ui.gd'] = second.content;
    await observer.after('write_file', first, true, undefined);
    await observer.after('write_file', second, true, undefined);
    const goal = workflows.goal(owner, session)!;
    assert.equal(goal.status, 'active');
    assert.equal(goal.runtime?.sourceVersion, source.snapshot().sha256);
    assert(!goal.runtime?.findings.some((value) => value.category === 'environment_drift'));
    assert.equal(observer.rebaseRequested, false);
    assert.deepEqual(stops, []);
  }));

test('an unrelated file changed between tools stops the old path and records the real external version', () =>
  fixture(async ({ observer, workflows, source, cloud, traces }) => {
    source.files['outside.gd'] = 'another application changed the project';
    const guard = await observer.before(
      'write_file',
      { path: 'main.gd', content: 'unsafe old plan' },
      cloud,
    );
    assert.equal(guard.allowed, false);
    assert.equal(guard.action, 'rebase');
    assert.equal(observer.rebaseRequested, true);
    assert.equal(workflows.goal(owner, session)?.runtime?.sourceVersion, source.snapshot().sha256);
    assert.equal(
      (await observer.before('read_file', { path: 'outside.gd' }, cloud)).allowed,
      true,
      'rebase permits investigation',
    );
    assert.equal(
      (await observer.before('write_file', { path: 'main.gd', content: 'still old plan' }, cloud))
        .allowed,
      false,
    );
    const drift = traces
      .events(owner, run)
      .events.find((value) => value.kind === 'environment.checkpoint')!;
    assert(drift);
    assert.equal(
      (traces.payloadValue(owner, run, drift.payloadRef!) as { sourceVersion: string })
        .sourceVersion,
      source.snapshot().sha256,
    );
  }));

test('a subagent merge can change only its exact expected paths without masking an unrelated edit', () =>
  fixture(
    async ({ observer, workflows, source, cloud, traces }) => {
      const args = { taskId: 'verified-child' };
      assert.equal((await observer.before('apply_subagent_changes', args, cloud)).allowed, true);
      source.files['main.gd'] = 'approved child changes';
      source.files['ui.gd'] = 'external application changed this file';
      await observer.after('apply_subagent_changes', args, true, undefined);
      assert.equal(observer.rebaseRequested, true);
      assert.equal(workflows.goal(owner, session)?.runtime?.action, 'rebase');
      const drift = traces
        .events(owner, run)
        .events.find((value) => value.kind === 'environment.checkpoint')!;
      const payload = traces.payloadValue(owner, run, drift.payloadRef!) as {
        expected: string[];
        changedPaths: string[];
      };
      assert.deepEqual(payload.expected, ['main.gd']);
      assert(payload.changedPaths.includes('ui.gd'));
    },
    (name) => (name === 'apply_subagent_changes' ? ['./main.gd'] : []),
  ));

test('the same subagent merge with only the attested paths does not trigger a false environment incident', () =>
  fixture(
    async ({ observer, workflows, source, cloud }) => {
      assert.equal(
        (await observer.before('apply_subagent_changes', { taskId: 'verified-child' }, cloud))
          .allowed,
        true,
      );
      source.files['main.gd'] = 'approved implementation';
      source.files['ui.gd'] = 'approved UI implementation';
      await observer.after('apply_subagent_changes', { taskId: 'verified-child' }, true, undefined);
      assert.equal(observer.rebaseRequested, false);
      assert.equal(workflows.goal(owner, session)?.runtime?.action, 'continue');
    },
    (name) => (name === 'apply_subagent_changes' ? ['main.gd', 'ui.gd'] : []),
  ));

test('overlapping before, after and acceptance requests collect source snapshots serially and preserve current proof', () =>
  fixture(async ({ observer, workflows, source, cloud }) => {
    const gate = source.holdNext();
    const before = observer.before('run_browser_playtest', { entry: 'index.html' }, cloud);
    await gate.started;
    const after = observer.after('run_browser_playtest', { entry: 'index.html' }, true, undefined);
    const acceptance = observer.acceptance([evidence(source)], cloud);
    try {
      await setImmediate();
      assert.equal(source.calls, 2, 'only initial and the held before snapshot may have started');
      assert.equal(
        source.maximumActive,
        1,
        'a slower older snapshot cannot overwrite a newer observation',
      );
    } finally {
      gate.release();
    }
    const [guard, , checked] = await Promise.all([before, after, acceptance]);
    assert.equal(guard.allowed, true);
    assert.equal(source.calls, 4);
    assert.equal(source.maximumActive, 1);
    assert.equal(checked[0].sourceVersion, source.snapshot().sha256);
    assert.equal(
      workflows.complete(owner, session, checked, workflows.goal(owner, session)!.contractHash)
        .status,
      'completed',
    );
  }));

for (const drift of ['permission', 'source', 'project-revision'] as const)
  test(`final ${drift} drift revokes a still-settling completion while retaining its historical receipt`, () =>
    fixture(async ({ observer, workflows, source, cloud }) => {
      const checked = await observer.acceptance([evidence(source)], cloud);
      const accepted = workflows.complete(
        owner,
        session,
        checked,
        workflows.goal(owner, session)!.contractHash,
      );
      assert.equal(accepted.status, 'completed');
      assert.equal(accepted.currentRunId, run);
      const changed = structuredClone(cloud);
      if (drift === 'permission') changed.permissions = { mode: 'custom', revision: 2 };
      if (drift === 'source') source.files['main.gd'] = 'changed after the actual verifier ran';
      await observer.finish(changed, drift === 'project-revision' ? 2 : 1);
      const current = workflows.goal(owner, session)!;
      assert.equal(current.status, 'active');
      assert.equal(current.runtime?.action, 'rebase');
      assert.deepEqual(current.evidence, []);
      assert.deepEqual(current.runtime?.verifiedEvidence, []);
      assert.equal(
        current.completion?.contractHash,
        accepted.contractHash,
        'the older completion is retained as history, not current acceptance',
      );
      assert(current.invalidation?.reason);
      assert.equal(observer.rebaseRequested, true);
      assert.throws(
        () => workflows.complete(owner, session, checked, current.contractHash),
        /重新核对|尚不能|环境/,
      );
    }));

test('asset bundle writes allow only the explicit new output directory, and still detect unrelated changes', () =>
  fixture(async ({ observer, source, cloud }) => {
    const args = { outputDir: 'assets/walk-v1', sourcePath: 'sheet.png' };
    assert.equal((await observer.before('prepare_game_asset', args, cloud)).allowed, true);
    source.files['assets/walk-v1/frame-000.png'] = 'actual frame';
    source.files['assets/walk-v1/manifest.json'] = 'actual manifest';
    await observer.after('prepare_game_asset', args, true, undefined);
    assert.equal(observer.rebaseRequested, false);
    const next = { ...args, outputDir: 'assets/walk-v2' };
    assert.equal((await observer.before('prepare_game_asset', next, cloud)).allowed, true);
    source.files['assets/walk-v2/frame-000.png'] = 'next frame';
    source.files['main.gd'] = 'external change while processing';
    await observer.after('prepare_game_asset', next, true, undefined);
    assert.equal(observer.rebaseRequested, true);
  }));

test('a generated asset quality failure cannot be cleared by unrelated engine success or accepted as finished', () =>
  fixture(async ({ observer, source, cloud, workflows }) => {
    const args = { outputDir: 'assets/invalid-alpha' };
    assert.equal((await observer.before('prepare_game_asset', args, cloud)).allowed, true);
    source.files['assets/invalid-alpha/manifest.json'] = 'qa failed';
    await observer.after('prepare_game_asset', args, true, undefined, [], false, undefined, {
      passed: false,
      key: 'assets/invalid-alpha',
      reason: 'fourth icon has no foreground',
    });
    assert.equal(
      observer.rebaseRequested,
      false,
      'own write with QA failure is not external drift',
    );
    assert(
      workflows
        .goal(owner, session)
        ?.runtime?.activeErrors?.some((e) => e.includes('素材检查未通过')),
    );
    await observer.after('run_godot', {}, true, undefined, [
      { kind: 'engine-job', ref: 'import-only', sha256: source.snapshot().sha256 },
    ]);
    assert(
      workflows
        .goal(owner, session)
        ?.runtime?.activeErrors?.some((e) => e.includes('素材检查未通过')),
      'engine import cannot bless a missing icon',
    );
    assert.throws(
      () => workflows.complete(owner, session, [evidence(source)]),
      /实际错误|验证器|尚不能|环境/,
    );
    await observer.after(
      'prepare_game_asset',
      { outputDir: 'assets/unrelated-sprite' },
      true,
      undefined,
      [],
      false,
      undefined,
      { passed: true, key: 'assets/unrelated-sprite' },
    );
    assert(
      workflows
        .goal(owner, session)
        ?.runtime?.activeErrors?.some((e) => e.includes('assets/invalid-alpha')),
      'a good unrelated asset cannot clear the broken icon',
    );
    await observer.after(
      'prepare_game_asset',
      { outputDir: 'assets/fixed' },
      true,
      undefined,
      [],
      false,
      undefined,
      { passed: true, key: 'assets/fixed', supersedes: 'assets/invalid-alpha' },
    );
    assert.deepEqual(workflows.goal(owner, session)?.runtime?.activeErrors, []);
  }));

test('reads and cosmetic writes preserve runtime errors until an actual verified playtest clears them', () =>
  fixture(async ({ observer, workflows, source, cloud }) => {
    const failure = 'TypeError: actual game input could not resume battle';
    await observer.after('run_browser_playtest', { entry: 'index.html' }, false, failure);
    await observer.after('read_file', { path: 'main.gd' }, true, undefined);
    const args = { path: 'ui.gd', content: 'change a label' };
    assert.equal((await observer.before('edit_file', args, cloud)).allowed, true);
    source.files['ui.gd'] = args.content;
    await observer.after('edit_file', args, true, undefined);
    assert.deepEqual(workflows.goal(owner, session)?.runtime?.activeErrors, [failure]);
    assert.throws(
      () => workflows.complete(owner, session, [evidence(source)]),
      /实际错误|环境|验证器/,
    );

    assert.equal(
      (await observer.before('run_browser_playtest', { entry: 'index.html' }, cloud)).allowed,
      true,
    );
    const passed = evidence(source, 'playtest-after-fix');
    await observer.after('run_browser_playtest', { entry: 'index.html' }, true, undefined, [
      { kind: 'playtest', ref: passed.ref, sha256: passed.sha256! },
    ]);
    assert.deepEqual(workflows.goal(owner, session)?.runtime?.activeErrors, []);
    const checked = await observer.acceptance([passed], cloud);
    assert.equal(
      workflows.complete(owner, session, checked, workflows.goal(owner, session)!.contractHash)
        .status,
      'completed',
    );
  }));
