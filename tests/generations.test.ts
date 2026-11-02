import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApi } from '../apps/api/server.ts';
import type { GenerationJob } from '../packages/shared/types.ts';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jPmcAAAAASUVORK5CYII=',
  'base64',
);
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(32)]);
async function until(fn: () => Promise<GenerationJob>, status: string) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const job = await fn();
    if (job.status === status) return job;
    await delay(20);
  }
  throw Error('Expected generation state ' + status);
}
test(
  'image/video tasks use one durable submit, native phases, exact bytes, owner isolation and stable idempotency through restart',
  { timeout: 20000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lm-media-'));
    const calls: { method: string; path: string; body?: any }[] = [];
    let reads = 0;
    const upstream = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      calls.push({ method: req.method!, path: req.url!, body });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/v3/images/generations') {
        res.end(
          JSON.stringify({
            data: [{ b64_json: png.toString('base64') }],
            usage: { total_tokens: 12 },
          }),
        );
        return;
      }
      if (req.method === 'POST') {
        res.end(JSON.stringify({ id: 'video-task-1' }));
        return;
      }
      if (req.url === '/video.mp4') {
        res.setHeader('content-type', 'video/mp4');
        res.end(mp4);
        return;
      }
      reads++;
      res.end(
        JSON.stringify(
          reads < 2
            ? { id: 'video-task-1', status: 'running' }
            : {
                id: 'video-task-1',
                status: 'succeeded',
                content: {
                  video_url: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/video.mp4`,
                },
                usage: { total_tokens: 27 },
              },
        ),
      );
    });
    await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
    const options = {
      permissionMode: 'custom' as const, // Negative permission case; normal startup is full.
      dataDir: dir,
      demo: true,
      arkKey: 'media-protocol-fixture',
      arkBase: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/api/v3`,
      generationPollMs: 20,
    };
    let api = await createApi(options);
    try {
      const login = (
        await api.app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} })
      ).json();
      const headers = { authorization: 'Bearer ' + login.token };
      const send = async (body: unknown) => {
        const r = await api.app.inject({
          method: 'POST',
          url: '/api/generations',
          headers,
          payload: body as any,
        });
        assert.equal(r.statusCode, 202, r.body);
        return r.json<GenerationJob>();
      };
      const input = {
        requestId: randomUUID(),
        kind: 'image',
        name: '游戏角色',
        projectId: randomUUID(),
        sessionId: randomUUID(),
        prompt: 'one character',
      };
      const denied = await api.app.inject({
        method: 'POST',
        url: '/api/generations',
        headers,
        payload: input,
      });
      assert.equal(denied.statusCode, 403);
      for (const id of ['image-generation', 'video-generation'])
        assert.equal(
          (
            await api.app.inject({
              method: 'PATCH',
              url: '/api/plugins/' + id,
              headers,
              payload: { installed: true, enabled: true },
            })
          ).statusCode,
          200,
        );
      const first = await send(input);
      assert.equal(first.status, 'created');
      const image = await until(
        async () => api.generations.get(login.user.id, first.id),
        'completed',
      );
      assert.equal((await send(input)).id, first.id);
      assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
      const bytes = await api.assets.read(api.assets.get(login.user.id, image.asset!.id));
      assert.deepEqual(bytes, png);
      const changed = await api.app.inject({
        method: 'POST',
        url: '/api/generations',
        headers,
        payload: { ...input, prompt: 'different' },
      });
      assert.equal(changed.statusCode, 409);
      assert.throws(() => api.generations.get('other-user', first.id));
      const videoInput = {
        ...input,
        requestId: randomUUID(),
        kind: 'video',
        name: '角色大招',
        referenceAssetId: image.asset!.id,
        duration: 4,
      };
      const videoStart = await send(videoInput);
      const video = await until(
        async () => api.generations.get(login.user.id, videoStart.id),
        'completed',
      );
      assert.deepEqual(await api.assets.read(api.assets.get(login.user.id, video.asset!.id)), mp4);
      const videoSubmit = calls.find((c) => c.method === 'POST' && c.path.includes('/tasks'))!;
      assert.equal(videoSubmit.body.model, 'doubao-seedance-2-5-260628');
      assert.equal(videoSubmit.body.ratio, 'adaptive');
      assert(videoSubmit.body.content[1].image_url.url.startsWith('data:image/png;base64,'));
      assert.equal(calls.filter((c) => c.method === 'POST' && c.path.includes('/tasks')).length, 1);
      const publicText = JSON.stringify(video);
      assert(!publicText.includes('sourceUrl'));
      assert(!publicText.includes('base64'));
      assert(!publicText.includes('media-protocol-fixture'));
      await api.app.close();
      api = await createApi(options);
      assert.equal(api.generations.get(login.user.id, first.id).status, 'completed');
      await delay(50);
      assert.equal(
        calls.filter((c) => c.method === 'POST').length,
        2,
        'Restart never resubmits completed work',
      );
      assert.deepEqual(
        api.store
          .list<{ status: string; totalTokens: number }>('usage')
          .map((v) => [v.status, v.totalTokens]),
        [
          ['completed', 12],
          ['completed', 27],
        ],
      );
    } finally {
      await api.app.close();
      await new Promise<void>((done) => upstream.close(() => done()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
test(
  'unknown generation submissions survive restart and new model call IDs without another paid POST',
  { timeout: 10000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lm-media-unknown-'));
    let posts = 0;
    const upstream = createServer((req) => {
      posts++;
      req.socket.destroy();
    });
    await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
    const options = {
      dataDir: dir,
      demo: true,
      arkKey: 'fixture',
      arkBase: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/api/v3`,
      generationPollMs: 20,
    };
    let api = await createApi(options);
    try {
      const login = (
        await api.app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} })
      ).json();
      const headers = { authorization: 'Bearer ' + login.token };
      await api.app.inject({
        method: 'PATCH',
        url: '/api/plugins/image-generation',
        headers,
        payload: { installed: true, enabled: true },
      });
      const input = {
        requestId: randomUUID(),
        kind: 'image',
        name: '角色',
        projectId: randomUUID(),
        sessionId: randomUUID(),
        prompt: 'one character',
      };
      const job = (
        await api.app.inject({ method: 'POST', url: '/api/generations', headers, payload: input })
      ).json<GenerationJob>();
      await until(async () => api.generations.get(login.user.id, job.id), 'unknown');
      assert.equal(posts, 1);
      await api.app.close();
      api = await createApi(options);
      assert.equal(
        api.generations.create(login.user.id, { ...input, requestId: randomUUID() }).id,
        job.id,
      );
      await delay(80);
      assert.equal(posts, 1);
      assert.equal(api.generations.get(login.user.id, job.id).status, 'unknown');
    } finally {
      await api.app.close();
      await new Promise<void>((done) => upstream.close(() => done()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  'a known video task resumes queries after backend restart without another generation POST',
  { timeout: 12000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lm-video-resume-'));
    let posts = 0,
      queries = 0,
      ready = false;
    const upstream = createServer(async (req, res) => {
      for await (const _ of req) {
      }
      if (req.url === '/video.mp4') {
        res.setHeader('content-type', 'video/mp4');
        res.end(mp4);
        return;
      }
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST') {
        posts++;
        res.end(JSON.stringify({ id: 'known-resumable-video' }));
        return;
      }
      queries++;
      res.end(
        JSON.stringify(
          ready
            ? {
                id: 'known-resumable-video',
                status: 'succeeded',
                content: {
                  video_url: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/video.mp4`,
                },
              }
            : { id: 'known-resumable-video', status: 'running' },
        ),
      );
    });
    await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
    const options = {
      dataDir: dir,
      demo: true,
      arkKey: 'fixture-video',
      arkBase: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/api/v3`,
      generationPollMs: 40,
    };
    let api = await createApi(options);
    try {
      const login = (
          await api.app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} })
        ).json(),
        headers = { authorization: 'Bearer ' + login.token };
      await api.app.inject({
        method: 'PATCH',
        url: '/api/plugins/video-generation',
        headers,
        payload: { installed: true, enabled: true },
      });
      const initial = api.generations.create(login.user.id, {
        requestId: randomUUID(),
        projectId: randomUUID(),
        sessionId: randomUUID(),
        kind: 'video',
        prompt: 'shield animation',
        name: 'shield',
        duration: 4,
      });
      for (let n = 0; n < 100 && queries < 1; n++) await delay(20);
      assert.equal(posts, 1);
      assert(queries >= 1);
      await api.app.close();
      ready = true;
      api = await createApi(options);
      const final = await until(
        async () => api.generations.get(login.user.id, initial.id),
        'completed',
      );
      assert.equal(final.upstreamTaskId, 'known-resumable-video');
      assert.equal(posts, 1);
      assert(queries >= 2);
      assert.deepEqual(await api.assets.read(api.assets.get(login.user.id, final.asset!.id)), mp4);
    } finally {
      await api.app.close();
      await new Promise<void>((done) => upstream.close(() => done()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
