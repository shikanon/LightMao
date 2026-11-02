import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectAssessmentCaptures } from '../apps/agent/reference-media.ts';
import { ReferenceMediaService } from '../apps/agent/reference-media.ts';
import { PlaytestService } from '../apps/agent/playtests.ts';
import { TraceService } from '../apps/agent/trace.ts';
import { Store } from '../packages/shared/store.ts';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { ProjectService } from '../apps/agent/projects.ts';
import type { IsolatedExecutor } from '../apps/agent/isolation.ts';
import type { PlaytestJob } from '../packages/shared/types.ts';
import {
  perceptionInput,
  type PerceptionInput,
  type PerceptionJob,
} from '../packages/shared/perception.ts';

const stageData = [
  [0, 'title', 0, 1, 0, 0],
  [1, 'meta', 0, 1, 0, 0],
  [3, 'preselect', 1, 1, 0, 0],
  [8, 'preselect', 1, 2, 0, 2],
  [9, 'preselect', 1, 3, 0, 4],
  [14, 'preselect', 1, 5, 0, 8],
  [16, 'battle', 1, 6, 0, 10],
  [17, 'draft', 1, 6, 0, 10],
  [18, 'battle', 2, 6, 0, 11],
  [20, 'draft', 2, 6, 0, 11],
  [21, 'battle', 3, 6, 0, 12],
  [23, 'draft', 3, 6, 0, 12],
  [26, 'battle', 4, 6, 0, 13],
  [27, 'battle', 5, 6, 3, 13],
  [28, 'victory', 5, 6, 3, 13],
  [29, 'victory', 5, 6, 3, 13],
] as const;
const stages = stageData.map(([step, phase, wave, preRound, bossLayer, drafts]) => ({
  id: 'capture-' + step,
  seconds: step,
  phase,
  wave,
  preRound,
  bossLayer,
  drafts,
}));
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
test('visual assessment selects phase evidence across late gameplay without overflowing the frame budget or rewriting originals', () => {
  const captures = Array.from({ length: 40 }, (_, i) => ({
    id: 'capture-' + i,
    seconds: i,
    phase: ['title', 'home', 'preselect', 'battle', 'upgrade', 'boss', 'victory'][
      Math.min(6, Math.floor(i / 6))
    ],
    sha256: String(i),
  }));
  const before = structuredClone(captures);
  const picked = selectAssessmentCaptures(captures, 5);
  assert.equal(picked.length, 5);
  assert.equal(picked[0].phase, 'title');
  assert.equal(picked.at(-1)?.phase, 'victory');
  assert(picked.some((c) => c.phase === 'boss'));
  assert.equal(new Set(picked.map((c) => c.id)).size, 5);
  assert.deepEqual(captures, before);
  assert(
    picked.every((c) => captures.includes(c)),
    'every selection refers to an existing unmodified actual capture',
  );
  const single = selectAssessmentCaptures(
    captures.filter((c) => c.phase === 'battle'),
    5,
  );
  assert(
    single.some((c) => c.id === 'capture-23'),
    'same phase still retains the recent frame',
  );
  assert.deepEqual(selectAssessmentCaptures([], 5), []);
});

test('bound numeric markers locate a late Boss that shares the battle phase without preferring outcome or high-score claims', () => {
  const before = structuredClone(stages);
  const markers = new Map(stages.map((stage) => [stage.id, stage]));
  const picked = selectAssessmentCaptures(stages, 6, markers);
  assert.deepEqual(
    picked.map((value) => value.id),
    ['capture-0', 'capture-14', 'capture-23', 'capture-26', 'capture-27', 'capture-29'],
  );
  assert(
    picked.includes(stages.find((value) => value.id === 'capture-27')!),
    'victory retaining bossLayer=3 must not substitute for a visible Boss fight',
  );
  assert.deepEqual(stages, before);
  assert.equal(selectAssessmentCaptures(stages, 0, markers).length, 0);
  assert.equal(selectAssessmentCaptures(stages, 100, markers).length, 6);
});

async function assessmentFixture(
  fn: (context: {
    service: ReferenceMediaService;
    playtests: PlaytestService;
    traces: TraceService;
    store: Store;
    job: PlaytestJob;
    wire: { method: string; url: URL; body?: PerceptionInput }[];
    evaluate: () => Promise<PerceptionJob>;
    dropNext: (retain: boolean) => void;
    appendBoss: (overrides: object) => void;
    corruptCapture: () => Promise<void>;
  }) => Promise<void>,
  omitBoss = false,
) {
  const dir = await mkdtemp(join(tmpdir(), 'lm-assessment-v2-')),
    store = new Store(join(dir, 'db'));
  const owner = 'owner',
    project = 'project',
    referenceId = 'reference',
    run = 'run',
    session = 'session';
  const traces = new TraceService(store),
    source = digest('actual source'),
    reference = digest('reference source');
  const projects = {
    requireAccess: async () => ({ root: join(dir, 'project') }),
  } as unknown as ProjectService;
  const snapshot = {
    files: [{ path: 'index.html', bytes: 4, sha256: source }],
    totalBytes: 4,
    sha256: source,
    excluded: [],
    excludedCount: 0,
  };
  const executor = { file: async () => snapshot } as unknown as IsolatedExecutor;
  const captures = stages.map((stage) => {
    const bytes = Buffer.from('fixture JPEG ' + stage.id);
    return {
      id: stage.id,
      phase: stage.phase,
      seconds: stage.seconds,
      bytes: bytes.length,
      sha256: digest(bytes),
    };
  });
  const finalBytes = Buffer.from('fixture final PNG');
  const job: PlaytestJob = {
    id: 'playtest',
    projectId: project,
    sessionId: session,
    runId: run,
    requestId: 'original-playtest',
    status: 'passed',
    goal: 'Actual fixture',
    startedAt: '2026-11-02T00:00:00Z',
    endedAt: '2026-11-02T00:00:30Z',
    finalCaptureSeconds: 29.75,
    previewId: 'preview',
    sourceSha256: source,
    steps: 29,
    inputActions: 14,
    requestIds: [],
    captures,
    screenshotSha256: digest(finalBytes),
    assertions: [],
  };
  store.put('playtest', owner, job);
  store.put('game-preview', owner, { id: 'preview', snapshot });
  const folder = join(dir, 'playtests', owner, job.id),
    refs = join(dir, 'reference-media', digest(owner), referenceId);
  await mkdir(folder, { recursive: true });
  await mkdir(refs, { recursive: true });
  for (const capture of captures)
    await writeFile(join(folder, capture.id + '.jpg'), 'fixture JPEG ' + capture.id);
  await writeFile(join(folder, 'screenshot.png'), finalBytes);
  const referenceFrames = Array.from({ length: 12 }, (_, index) => {
    const bytes = Buffer.from('fixture reference ' + index);
    return { id: 'frame-' + index, seconds: index, bytes: bytes.length, sha256: digest(bytes) };
  });
  for (const frame of referenceFrames)
    await writeFile(join(refs, frame.id + '.jpg'), 'fixture reference ' + frame.id.slice(6));
  store.put('reference-media', owner, {
    id: referenceId,
    ownerId: owner,
    projectId: project,
    name: 'reference recording',
    mime: 'video/mp4',
    bytes: 10,
    sha256: reference,
    status: 'ready',
    createdAt: job.startedAt,
    frames: referenceFrames,
    audios: [],
  });
  traces.start({ owner, project, session, run });
  const observation = (stage: (typeof stages)[number], overrides: object = {}) =>
    traces.observation(owner, run, '浏览器实际观测', {
      playtestId: job.id,
      sourceVersion: source,
      capture: captures.find((value) => value.id === stage.id),
      observation: { gameState: stage },
      ...overrides,
    });
  for (const stage of stages) if (!omitBoss || stage.id !== 'capture-27') observation(stage);
  const wire: { method: string; url: URL; body?: PerceptionInput }[] = [];
  let dropped: { retain: boolean } | undefined;
  let score: PerceptionJob | undefined;
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const url = new URL(request.url!, 'http://fixture.local'),
      method = request.method!,
      body = text ? perceptionInput.parse(JSON.parse(text)) : undefined;
    wire.push({ method, url, body });
    response.setHeader('content-type', 'application/json');
    if (method === 'POST') {
      const input = body!,
        at = new Date().toISOString();
      const result: PerceptionJob = {
        id: 'score-v2',
        projectId: project,
        sessionId: input.sessionId,
        requestId: input.requestId,
        purpose: 'score',
        model: 'local-vision-fixture',
        status: 'completed',
        sourceVersion: input.sourceVersion,
        referenceVersion: input.referenceVersion,
        createdAt: at,
        updatedAt: at,
        inputSha256: digest(JSON.stringify(input)),
        inputManifest: [],
        visualScore: 46,
      };
      const drop = dropped;
      dropped = undefined;
      if (!drop || drop.retain) score = result;
      if (drop) {
        response.destroy();
        return;
      }
      response.end(JSON.stringify(result));
      return;
    }
    response.end(
      JSON.stringify(url.pathname === '/api/perception' ? (score ? [score] : []) : score),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const apiUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const service = new ReferenceMediaService(
    store,
    dir,
    projects,
    executor,
    apiUrl,
    traces,
    '/usr/bin/true',
  );
  const playtests = new PlaytestService(store, dir, executor, projects, apiUrl);
  const evaluate = () =>
    service.evaluate(
      owner,
      project,
      referenceId,
      job.id,
      'local-unbilled',
      session,
      run,
      playtests,
    );
  try {
    await fn({
      service,
      playtests,
      traces,
      store,
      job,
      wire,
      evaluate,
      dropNext: (retain) => {
        dropped = { retain };
      },
      appendBoss: (overrides) => {
        observation(
          stages.find((stage) => stage.id === 'capture-27')!,
          overrides,
        );
      },
      corruptCapture: async () => {
        await writeFile(join(folder, 'capture-27.jpg'), 'tampered image');
      },
    });
  } finally {
    await service.close();
    await playtests.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    traces.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('v2 scores the bound late gameplay with no more than 5 references, 6 real captures and the independently checked final PNG', () =>
  assessmentFixture(async ({ evaluate, wire, store, job }) => {
    store.put('visual-assessment', 'owner', {
      id: 'visual:' + digest(digest('reference source') + ':' + job.sourceSha256 + ':' + job.id),
      jobId: 'old-v1-score',
    });
    const result = await evaluate();
    assert.equal(result.visualScore, 46, 'sampling never rewrites the model score');
    const sent = wire.find((value) => value.method === 'POST')!.body!;
    assert.match(sent.requestId, /game-visual-v3/);
    assert.equal(sent.frames.length, 12);
    assert.equal(sent.frames.filter((frame) => frame.id.startsWith('reference-')).length, 5);
    assert.deepEqual(
      sent.frames
        .filter((frame) => frame.id.startsWith('actual-') && frame.id !== 'actual-final')
        .map((frame) => frame.id),
      [
        'actual-capture-0',
        'actual-capture-14',
        'actual-capture-23',
        'actual-capture-26',
        'actual-capture-27',
        'actual-capture-29',
      ],
    );
    assert.equal(sent.frames.at(-1)?.id, 'actual-final');
    assert.equal(sent.frames.at(-1)?.seconds, 29.75);
    assert.equal(Buffer.from(sent.frames.at(-1)!.data, 'base64').toString(), 'fixture final PNG');
    assert.match(sent.question, /标记仅定位|仅供定位/);
    assert(sent.question.includes('"bossLayer":3'));
    await evaluate();
    assert.equal(
      wire.filter((value) => value.method === 'POST').length,
      1,
      'the versioned existing score is GET-only',
    );
  }));

test('foreign-playtest or stale-source marker receipts cannot promote a battle frame into Boss evidence', () =>
  assessmentFixture(async ({ evaluate, wire, appendBoss }) => {
    appendBoss({ playtestId: 'foreign-job' });
    appendBoss({ sourceVersion: digest('old-source') });
    await evaluate();
    assert(
      !wire
        .find((value) => value.method === 'POST')!
        .body!.frames.some((frame) => frame.id === 'actual-capture-27'),
    );
  }, true));

test('capture file tampering rejects scoring before a model POST despite a matching immutable marker receipt', () =>
  assessmentFixture(async ({ evaluate, wire, corruptCapture }) => {
    await corruptCapture();
    await assert.rejects(evaluate(), /哈希不符|清单不符/);
    assert.equal(wire.filter((value) => value.method === 'POST').length, 0);
  }));

test('a lost v2 submission response is reconciled by original requestId without repeating the score POST', () =>
  assessmentFixture(async ({ evaluate, wire, dropNext }) => {
    dropNext(true);
    await assert.rejects(evaluate(), /fetch|network|socket/i);
    const restored = await evaluate();
    assert.equal(restored.id, 'score-v2');
    assert.equal(wire.filter((value) => value.method === 'POST').length, 1);
    assert(
      wire.some((value) => value.method === 'GET' && value.url.pathname === '/api/perception'),
    );
  }));

test('an undiscoverable v2 score submission remains unknown across retries and is never reposted', () =>
  assessmentFixture(async ({ evaluate, wire, dropNext }) => {
    dropNext(false);
    await assert.rejects(evaluate(), /fetch|network|socket/i);
    await assert.rejects(evaluate(), /待核对|未知/);
    await assert.rejects(evaluate(), /待核对|未知/);
    assert.equal(wire.filter((value) => value.method === 'POST').length, 1);
  }));
