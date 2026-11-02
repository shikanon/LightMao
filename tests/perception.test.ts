import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { Store } from '../packages/shared/store.ts';
import { PerceptionService, validatePerceptionOutput } from '../apps/api/perception.ts';
import { visualCriteria } from '../packages/shared/perception.ts';
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const frame = (id = 'actual-frame') => ({ id, seconds: 0, mime: 'image/png', data: png });
const base = {
  requestId: 'request',
  projectId: 'project',
  purpose: 'vision',
  question: 'Describe only actual input',
  frames: [frame()],
};
test('an explicit 100-point score denominator is accepted without rescaling or weakening evidence checks', () => {
  const job = {
    purpose: 'score',
    inputManifest: [
      { id: 'actual-frame', kind: 'image', seconds: 0, sha256: 'a'.repeat(64), bytes: 10 },
    ],
  } as any;
  const raw = {
    summary: 'Observed current image',
    observations: [],
    unknowns: ['Still frames only'],
    scores: visualCriteria.map((c) => ({
      criterion: c.id,
      score: 40,
      evidenceIds: ['actual-frame'],
      reason: 'Actual frame evidence',
      score_denominator: 100,
    })),
  };
  assert.equal(validatePerceptionOutput(job, JSON.stringify(raw)).visualScore, 40);
  assert.equal(validatePerceptionOutput(job, JSON.stringify(raw)).rubricVersion, 'game-visual-v1');
  assert.equal(
    validatePerceptionOutput({ ...job, rubricVersion: 'game-visual-v2' }, JSON.stringify(raw))
      .rubricVersion,
    'game-visual-v2',
    'revalidation must not relabel old outputs as a newer rubric',
  );
  assert.throws(() =>
    validatePerceptionOutput(
      job,
      JSON.stringify({
        ...raw,
        scores: raw.scores.map((c) => ({ ...c, score_denominator: 1000 })),
      }),
    ),
  );
  assert.throws(
    () =>
      validatePerceptionOutput(
        job,
        JSON.stringify({
          ...raw,
          scores: raw.scores.map((c) => ({ ...c, evidenceIds: ['invented-frame'] })),
        }),
      ),
    /证据/,
  );
  assert.throws(() => validatePerceptionOutput(job, JSON.stringify({ ...raw, passed: true })));
});
test('audio evidence tolerates decimal representation error and rejects actual out-of-range timestamps', () => {
  const job = {
    purpose: 'audio',
    inputManifest: [
      { id: 'audio-1', kind: 'audio', seconds: 147.67000000000002, durationSeconds: 20 },
    ],
  } as any;
  const raw = (start: number, end: number) =>
    JSON.stringify({
      summary: 'Actual audio sample',
      observations: [
        {
          evidenceId: 'audio-1',
          text: 'Heard sound',
          confidence: 1,
          startSeconds: start,
          endSeconds: end,
        },
      ],
      unknowns: [],
    });
  assert(validatePerceptionOutput(job, raw(147.67, 167.67)).result);
  assert.throws(() => validatePerceptionOutput(job, raw(147.5, 167.67)), /实际采样范围/);
  assert.throws(() => validatePerceptionOutput(job, raw(150, 149)), /实际采样范围/);
});
test('only an exactly redundant timestamp alias is normalized and the original response hash remains authoritative', () => {
  const job = {
    purpose: 'vision',
    inputManifest: [{ id: 'actual-frame', kind: 'image', seconds: 13.678 }],
  } as any;
  const make = (alias: number) =>
    JSON.stringify({
      summary: 'Actual sampled image',
      observations: [
        {
          evidenceId: 'actual-frame',
          text: 'Observed a card',
          confidence: 0.95,
          startSeconds: 13.678,
          startSeconds_legacy: alias,
          endSeconds: 13.678,
        },
      ],
      unknowns: [],
    });
  const text = make(13.678),
    result = validatePerceptionOutput(job, text);
  assert.equal(result.result.observations[0].startSeconds, 13.678);
  assert.equal(result.normalizationNotes?.length, 1);
  assert(!('startSeconds_legacy' in result.result.observations[0]));
  assert.throws(
    () => validatePerceptionOutput(job, make(0)),
    'conflicting legacy timestamps cannot override actual evidence time',
  );
});
test('perception separates actual modalities, persists one intent and scopes private results', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lm-perception-test-')),
    store = new Store(join(dir, 'db'));
  let count = 0,
    wire: any;
  const upstream = createServer(async (req, res) => {
    let text = '';
    for await (const c of req) text += c;
    wire = JSON.parse(text);
    count++;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: 'Observed fixture',
                observations: [
                  { evidenceId: 'actual-frame', text: 'One image received', confidence: 1 },
                ],
                unknowns: ['No audio evidence'],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 9, completion_tokens: 10, total_tokens: 19 },
      }),
    );
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const service = new PerceptionService(store, {
    arkKey: 'fixture',
    arkBase: `http://127.0.0.1:${(upstream.address() as any).port}`,
    authorize: () => {},
  });
  try {
    const job = await service.submit('alice', base),
      done = await service.wait('alice', job.id, 5);
    assert.equal(done.status, 'completed');
    assert.equal(
      wire.model,
      'doubao-seed-evolving',
      'vision must not inherit the chat model route',
    );
    assert(wire.messages[1].content.some((c: any) => c.type === 'image_url'));
    assert.equal(count, 1);
    assert.equal((await service.submit('alice', base)).id, job.id);
    assert.equal(count, 1);
    await assert.rejects(service.submit('alice', { ...base, question: 'Changed' }), /同一请求ID/);
    assert.throws(() => service.get('bob', job.id), /不存在/);
    await assert.rejects(
      service.submit('alice', { ...base, requestId: 'audio-mix', purpose: 'audio' }),
      /分别请求/,
    );
    await assert.rejects(
      service.submit('alice', { ...base, requestId: 'no-version-score', purpose: 'score' }),
      /双方版本/,
    );
    assert.equal(count, 1);
  } finally {
    await service.close();
    await new Promise<void>((r) => upstream.close(() => r()));
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('visual scores require cited actual evidence and are computed on the server; unknown requests do not replay after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lm-score-test-')),
    store = new Store(join(dir, 'db'));
  let bad = false,
    count = 0;
  const upstream = createServer(async (req, res) => {
    for await (const _ of req) {
    }
    count++;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: 'Low quality fixture',
                observations: [],
                unknowns: ['Only still frames'],
                scores: visualCriteria.map((c, i) => ({
                  criterion: c.id,
                  score: [20, 40, 60, 80][i],
                  evidenceIds: [bad ? 'reference-frame' : 'actual-frame'],
                  reason: 'Cited visible evidence',
                })),
              }),
            },
          },
        ],
      }),
    );
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const options = {
      arkKey: 'fixture',
      arkBase: `http://127.0.0.1:${(upstream.address() as any).port}`,
      authorize: () => {},
    },
    service = new PerceptionService(store, options);
  try {
    const input = {
      ...base,
      purpose: 'score',
      sourceVersion: 'actual-v1',
      referenceVersion: 'ref-v1',
      frames: [frame(), frame('reference-frame')],
    };
    const job = await service.submit('alice', input),
      done = await service.wait('alice', job.id, 5);
    assert.equal(done.status, 'completed');
    assert.equal(done.visualScore, 47);
    bad = true;
    const invalid = await service.submit('alice', { ...input, requestId: 'bad-score' });
    assert.equal((await service.wait('alice', invalid.id, 5)).status, 'failed');
    const row = store.get<any>('perception-job', job.id, 'alice');
    store.put('perception-job', 'alice', { ...row, status: 'running' });
    const restarted = new PerceptionService(store, options);
    assert.equal(restarted.get('alice', job.id).status, 'unknown');
    assert.equal((await restarted.submit('alice', input)).id, job.id);
    assert.equal(count, 2);
    await restarted.close();
  } finally {
    await service.close();
    await new Promise<void>((r) => upstream.close(() => r()));
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
