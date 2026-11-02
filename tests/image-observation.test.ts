import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate } from 'node:timers/promises';
import { Store } from '../packages/shared/store.ts';
import {
  perceptionInput,
  type PerceptionInput,
  type PerceptionJob,
} from '../packages/shared/perception.ts';
import { ReferenceMediaService } from '../apps/agent/reference-media.ts';
import type { ProjectService } from '../apps/agent/projects.ts';
import type { IsolatedExecutor } from '../apps/agent/isolation.ts';
import { TraceService } from '../apps/agent/trace.ts';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
  'base64',
);
const owner = 'alice',
  project = 'project',
  session = 'session-a',
  run = 'run-a';
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
interface Wire {
  method: string;
  url: URL;
  authorization?: string;
  body?: PerceptionInput;
}
function gate() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { enter, release, entered, released };
}
async function fixture(
  fn: (context: {
    service: ReferenceMediaService;
    freshService: () => ReferenceMediaService;
    observe: (
      service?: ReferenceMediaService,
      options?: {
        owner?: string;
        project?: string;
        sourceId?: string;
        sourceVersion?: string;
        bytes?: Buffer;
        session?: string;
        run?: string;
      },
    ) => Promise<PerceptionJob>;
    wire: Wire[];
    grants: Set<string>;
    holdNextPost: () => ReturnType<typeof gate>;
    dropNextPost: (persist: boolean) => void;
    replyWithOtherProject: () => void;
    traces: TraceService;
  }) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), 'lm-image-observation-'));
  const store = new Store(join(dir, 'db')),
    traces = new TraceService(store);
  const wire: Wire[] = [],
    grants = new Set([`${owner}:${project}`]);
  const jobs = new Map<string, { owner: string; job: PerceptionJob }>();
  const held: ReturnType<typeof gate>[] = [];
  let nextGate: ReturnType<typeof gate> | undefined;
  let drop: { persist: boolean } | undefined,
    otherProject = false;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url!, 'http://fixture.local'),
        method = request.method!;
      const token = request.headers.authorization;
      const caller = token?.match(/^Bearer (alice|bob)-token$/)?.[1];
      let body: PerceptionInput | undefined;
      if (method === 'POST') {
        let text = '';
        for await (const chunk of request) text += chunk;
        body = perceptionInput.parse(JSON.parse(text));
      }
      wire.push({ method, url, authorization: token, body });
      response.setHeader('content-type', 'application/json');
      if (!caller) {
        response.writeHead(401);
        response.end('{"error":"fixture unauthorized"}');
        return;
      }
      if (method === 'POST' && url.pathname === '/api/perception') {
        const input = body!,
          time = new Date().toISOString();
        const job: PerceptionJob = {
          id: 'job-' + wire.filter((value) => value.method === 'POST').length,
          projectId: input.projectId,
          sessionId: input.sessionId,
          runId: input.runId,
          requestId: input.requestId,
          purpose: input.purpose,
          model: 'dedicated-seed-evolving-fixture',
          status: 'completed',
          createdAt: time,
          updatedAt: time,
          inputSha256: sha(JSON.stringify(input)),
          sourceVersion: input.sourceVersion,
          traceId: input.traceId,
          inputManifest: input.frames.map((frame) => ({
            id: frame.id,
            kind: 'image',
            sha256: sha(Buffer.from(frame.data, 'base64')),
            bytes: Buffer.from(frame.data, 'base64').length,
            seconds: frame.seconds,
          })),
          result: {
            summary: 'Observed only the supplied frame',
            observations: [
              { evidenceId: 'actual-frame', text: 'One actual frame was supplied', confidence: 1 },
            ],
            unknowns: ['Audio and continuous play were not observed'],
          },
        };
        const dropped = drop,
          heldGate = nextGate;
        drop = undefined;
        nextGate = undefined;
        if (!dropped || dropped.persist) jobs.set(job.id, { owner: caller, job });
        heldGate?.enter();
        await heldGate?.released;
        if (dropped) {
          response.destroy();
          return;
        }
        response.end(JSON.stringify(job));
        return;
      }
      if (method === 'GET' && url.pathname === '/api/perception') {
        response.end(
          JSON.stringify(
            [...jobs.values()]
              .filter(
                (value) =>
                  value.owner === caller &&
                  value.job.projectId === url.searchParams.get('projectId') &&
                  value.job.sessionId === url.searchParams.get('sessionId'),
              )
              .map((value) => value.job),
          ),
        );
        return;
      }
      if (method === 'GET' && url.pathname.startsWith('/api/perception/')) {
        const entry = jobs.get(decodeURIComponent(url.pathname.slice('/api/perception/'.length)));
        if (!entry || entry.owner !== caller) {
          response.writeHead(404);
          response.end('{"error":"private job not found"}');
          return;
        }
        response.end(
          JSON.stringify(otherProject ? { ...entry.job, projectId: 'another-project' } : entry.job),
        );
        return;
      }
      response.writeHead(404);
      response.end('{"error":"unexpected route"}');
    } catch (error) {
      response.writeHead(500);
      response.end(
        JSON.stringify({ error: error instanceof Error ? error.message : 'fixture failed' }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const apiUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const services: ReferenceMediaService[] = [];
  const projects = {
    requireAccess: async (projectId: string, userId: string) => {
      if (!grants.has(`${userId}:${projectId}`))
        throw Object.assign(Error('project access denied'), { statusCode: 403 });
    },
  } as unknown as ProjectService;
  const executor = {
    file: async () => {
      throw Error('Image observation must not generate or modify files');
    },
    spawn: async () => {
      throw Error('Image observation must not run a generator or decoder');
    },
  } as unknown as IsolatedExecutor;
  const freshService = () => {
    const service = new ReferenceMediaService(
      store,
      dir,
      projects,
      executor,
      apiUrl,
      traces,
      '/usr/bin/true',
    );
    services.push(service);
    return service;
  };
  const service = freshService();
  traces.start({ owner, project, session, run });
  const observe = (
    target = service,
    options: {
      owner?: string;
      project?: string;
      sourceId?: string;
      sourceVersion?: string;
      bytes?: Buffer;
      session?: string;
      run?: string;
    } = {},
  ) =>
    target.understandImage(
      options.owner || owner,
      options.project || project,
      options.sourceId || 'capture-1',
      options.sourceVersion || sha('source-v1'),
      options.bytes || png,
      'image/png',
      (options.owner || owner) + '-token',
      options.session || session,
      options.run || run,
    );
  try {
    await fn({
      service,
      freshService,
      observe,
      wire,
      grants,
      holdNextPost: () => {
        const heldGate = gate();
        held.push(heldGate);
        nextGate = heldGate;
        return heldGate;
      },
      dropNextPost: (persist) => {
        drop = { persist };
      },
      replyWithOtherProject: () => {
        otherProject = true;
      },
      traces,
    });
  } finally {
    for (const heldGate of held) heldGate.release();
    for (const instance of services) await instance.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    traces.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('the same concurrent capture uses one dedicated vision intent and transports exact actual image bytes', () =>
  fixture(async ({ observe, wire, holdNextPost, traces }) => {
    const held = holdNextPost(),
      first = observe();
    await held.entered;
    const second = observe();
    try {
      await setImmediate();
      assert.equal(wire.filter((value) => value.method === 'POST').length, 1);
    } finally {
      held.release();
    }
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.id, b.id);
    assert.equal(a.model, 'dedicated-seed-evolving-fixture');
    const request = wire.find((value) => value.method === 'POST')!;
    assert.equal(request.url.pathname, '/api/perception');
    assert.equal(request.authorization, 'Bearer alice-token');
    assert.equal(
      request.body?.purpose,
      'vision',
      'text-agent screenshots use the independent multimodal route',
    );
    assert.equal(request.body?.sourceVersion, sha('source-v1'));
    assert.equal(request.body?.traceId, run);
    assert.deepEqual(request.body?.audios, []);
    assert.deepEqual(Buffer.from(request.body!.frames[0].data, 'base64'), png);
    assert.match(request.body!.question, /单帧不能证明连续玩法或音频/);
    assert.equal(wire.filter((value) => value.method === 'POST').length, 1);
    assert(traces.events(owner, run).events.some((value) => value.kind === 'observation'));
  }));

test('a persisted image job survives a new service instance and is queried rather than submitted again', () =>
  fixture(async ({ observe, wire, freshService }) => {
    const original = await observe(),
      count = wire.length;
    const reopened = await observe(freshService(), { session: 'later-session', run: 'later-run' });
    assert.equal(reopened.id, original.id);
    assert.equal(wire.filter((value) => value.method === 'POST').length, 1);
    assert(wire.slice(count).every((value) => value.method === 'GET'));
    assert.equal(wire.at(-1)?.url.pathname, '/api/perception/' + original.id);
    assert.equal(wire.at(-1)?.url.searchParams.get('wait'), '25');
  }));

test('a lost POST response reconciles the original request and session after restart without another POST', () =>
  fixture(async ({ observe, wire, dropNextPost, freshService }) => {
    dropNextPost(true);
    await assert.rejects(observe(), /fetch|network|socket|terminated/i);
    const original = wire.find((value) => value.method === 'POST')!.body!;
    const restored = await observe(freshService(), { session: 'later-session', run: 'later-run' });
    assert.equal(restored.requestId, original.requestId);
    assert.equal(wire.filter((value) => value.method === 'POST').length, 1);
    const reconciliation = wire.find(
      (value) => value.method === 'GET' && value.url.pathname === '/api/perception',
    )!;
    assert.equal(
      reconciliation.url.searchParams.get('sessionId'),
      session,
      'recovery searches the original submission scope',
    );
    assert.equal(reconciliation.url.searchParams.get('projectId'), project);
    assert(
      wire.some(
        (value) =>
          value.method === 'GET' && value.url.pathname === '/api/perception/' + restored.id,
      ),
    );
  }));

test('a lost submission with no discoverable job stays unknown across retries without a second paid intent', () =>
  fixture(async ({ observe, wire, dropNextPost, freshService }) => {
    dropNextPost(false);
    await assert.rejects(observe(), /fetch|network|socket|terminated/i);
    const restarted = freshService();
    await assert.rejects(observe(restarted), /待核对|未重复/);
    await assert.rejects(observe(restarted), /待核对|未重复/);
    assert.equal(wire.filter((value) => value.method === 'POST').length, 1);
    assert.equal(
      wire.filter((value) => value.method === 'GET' && value.url.pathname === '/api/perception')
        .length,
      2,
    );
  }));

test('current owner and project access are checked even when an observation is already cached', () =>
  fixture(async ({ observe, wire, grants }) => {
    await observe();
    const count = wire.length;
    await assert.rejects(observe(undefined, { owner: 'bob' }), /access denied/);
    await assert.rejects(observe(undefined, { project: 'other-project' }), /access denied/);
    grants.delete(`${owner}:${project}`);
    await assert.rejects(observe(), /access denied/);
    assert.equal(
      wire.length,
      count,
      "denied cached reads cannot contact the backend or reveal another account's job",
    );
  }));

test('authorized owners with the same capture identifier get separate private observation intents', () =>
  fixture(async ({ observe, wire, grants }) => {
    const alice = await observe();
    grants.add(`bob:${project}`);
    const bob = await observe(undefined, { owner: 'bob' });
    assert.notEqual(bob.id, alice.id);
    assert.notEqual(bob.requestId, alice.requestId);
    assert.equal(wire.filter((value) => value.method === 'POST').length, 2);
    assert.equal(wire.at(-1)?.authorization, 'Bearer bob-token');
  }));

test('a backend job for another project is rejected and is never repaired by reposting the image', () =>
  fixture(async ({ observe, wire, replyWithOtherProject }) => {
    await observe();
    replyWithOtherProject();
    await assert.rejects(observe(), /不属于当前项目/);
    await assert.rejects(observe(), /不属于当前项目/);
    assert.equal(wire.filter((value) => value.method === 'POST').length, 1);
  }));

test('changing bytes under an existing capture/version rejects the old observation; a genuinely new capture gets a new job', () =>
  fixture(async ({ observe, wire }) => {
    const original = await observe();
    await assert.rejects(
      observe(undefined, { bytes: Buffer.concat([png, Buffer.from('changed')]) }),
      /内容已变化|证据.*变化/,
    );
    assert.equal(wire.filter((value) => value.method === 'POST').length, 1);
    const fresh = await observe(undefined, { sourceId: 'capture-2' });
    assert.notEqual(fresh.id, original.id);
    assert.notEqual(fresh.requestId, original.requestId);
    assert.equal(wire.filter((value) => value.method === 'POST').length, 2);
  }));

test('a changed concurrent capture cannot borrow the in-flight observation of different bytes', () =>
  fixture(async ({ observe, wire, holdNextPost }) => {
    const held = holdNextPost(),
      first = observe();
    await held.entered;
    const second = observe(undefined, {
      bytes: Buffer.concat([png, Buffer.from('not-the-same-capture')]),
    }).then(
      (job) => ({ job, error: undefined }),
      (error) => ({ job: undefined, error }),
    );
    try {
      await setImmediate();
    } finally {
      held.release();
    }
    const [original, changed] = await Promise.all([first, second]);
    assert(original.id);
    assert(
      changed.error instanceof Error,
      'an in-flight cache hit must validate the supplied bytes before joining it',
    );
    assert.equal((changed.error as Error & { statusCode: number }).statusCode, 409);
    assert.match(changed.error.message, /内容已变化|证据.*变化/);
    assert.equal(wire.filter((value) => value.method === 'POST').length, 1);
  }));
