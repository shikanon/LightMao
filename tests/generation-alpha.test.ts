import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApi } from '../apps/api/server.ts';
import { encodePng, decodePng } from '../packages/shared/rgba-png.ts';

test(
  'transparent generation uses a real alpha template, checks references before billing, preserves idempotency and rejects opaque outputs',
  { timeout: 15000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lm-alpha-api-'));
    const pixels = new Uint8Array(32 * 32 * 4);
    for (let y = 8; y < 24; y++)
      for (let x = 8; x < 24; x++) pixels.set([240, 40, 90, 255], (y * 32 + x) * 4);
    const transparent = encodePng({ width: 32, height: 32, data: pixels });
    const solid = pixels.slice();
    for (let i = 3; i < solid.length; i += 4) solid[i] = 255;
    const opaque = encodePng({ width: 32, height: 32, data: solid });
    const calls: any[] = [];
    let returnOpaque = false;
    const upstream = createServer(async (req, res) => {
      let raw = '';
      for await (const c of req) raw += c;
      calls.push(JSON.parse(raw));
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          data: [{ b64_json: (returnOpaque ? opaque : transparent).toString('base64') }],
        }),
      );
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const api = await createApi({
      dataDir: dir,
      demo: true,
      arkKey: 'alpha-fixture-only',
      arkBase: `http://127.0.0.1:${(upstream.address() as any).port}/api/v3`,
      generationPollMs: 10,
    });
    try {
      const login = (
        await api.app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} })
      ).json();
      const headers = { authorization: 'Bearer ' + login.token };
      await api.app.inject({ method: 'GET', url: '/api/bootstrap', headers });
      const input = {
        requestId: randomUUID(),
        kind: 'image',
        name: 'sprite',
        prompt: 'eight poses',
        projectId: randomUUID(),
        sessionId: randomUUID(),
        background: 'transparent',
        size: '2048x1024',
      };
      const send = async (body: unknown) => {
        const r = await api.app.inject({
          method: 'POST',
          url: '/api/generations',
          headers,
          payload: body as any,
        });
        assert.equal(r.statusCode, 202, r.body);
        return r.json();
      };
      const settle = async (id: string) => {
        for (let i = 0; i < 300; i++) {
          const j = api.generations.get(login.user.id, id);
          if (['completed', 'failed', 'unknown'].includes(j.status)) return j;
          await delay(10);
        }
        throw Error('not settled');
      };
      const first = await send(input),
        done = await settle(first.id);
      assert.equal(done.status, 'completed', done.error);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].background, 'transparent');
      assert.equal(calls[0].size, '2048x1024');
      assert.equal(calls[0].output_format, 'png');
      const template = decodePng(Buffer.from(calls[0].image.split(',')[1], 'base64'));
      assert.equal(template.width, 1024);
      assert(template.data.every((v) => v === 0));
      assert.equal((await send(input)).id, first.id);
      assert.equal(calls.length, 1);
      returnOpaque = true;
      const invalid = await settle((await send({ ...input, requestId: randomUUID() })).id);
      assert.equal(invalid.status, 'failed');
      assert.match(invalid.error!, /Alpha/);
      assert(!invalid.asset);
      assert.equal(calls.length, 2);
      const opaqueJob = await settle(
        (await send({ ...input, requestId: randomUUID(), background: 'opaque' })).id,
      );
      assert.equal(opaqueJob.status, 'completed');
      assert.equal(calls.length, 3);
      const invalidRef = await settle(
        (await send({ ...input, requestId: randomUUID(), referenceAssetId: opaqueJob.asset!.id }))
          .id,
      );
      assert.equal(invalidRef.status, 'failed');
      assert.match(invalidRef.error!, /未提交/);
      assert.equal(calls.length, 3, 'opaque reference never billed');
      const video = await api.app.inject({
        method: 'POST',
        url: '/api/generations',
        headers,
        payload: { ...input, requestId: randomUUID(), kind: 'video' },
      });
      assert.equal(video.statusCode, 400);
      const invalidSize = await api.app.inject({
        method: 'POST',
        url: '/api/generations',
        headers,
        payload: { ...input, requestId: randomUUID(), size: '32x32' },
      });
      assert.equal(invalidSize.statusCode, 400);
      assert.equal(calls.length, 3, 'invalid geometry is rejected before paid submit');
      assert(!JSON.stringify(done).includes('base64'));
      assert(!JSON.stringify(done).includes('alpha-fixture-only'));
    } finally {
      await api.app.close();
      await new Promise<void>((r) => upstream.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
