import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { createApi } from '../apps/api/server.ts';
import { Store } from '../packages/shared/store.ts';
import { IsolatedExecutor } from '../apps/agent/isolation.ts';
import { detectFfmpeg } from '../apps/agent/media-runtime.ts';
import {
  ConversationAttachmentService,
  createConversationAttachmentTools,
} from '../apps/agent/conversation-attachments.ts';
function crc32(bytes: Buffer) {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ -1) >>> 0;
}
function png() {
  const chunk = (name: string, data: Buffer) => {
    const type = Buffer.from(name),
      length = Buffer.alloc(4),
      crc = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
    return Buffer.concat([length, type, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(64, 0);
  header.writeUInt32BE(48, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc(48 * (1 + 64 * 3));
  for (let y = 0; y < 48; y++)
    for (let x = 0; x < 64; x++) {
      const offset = y * 193 + 1 + x * 3;
      pixels[offset] = 40;
      pixels[offset + 1] = 170;
      pixels[offset + 2] = 220;
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
test(
  'actual image attachment bytes become a bounded sandbox-derived frame, persist one intent and recover a lost submit response without replay',
  { skip: process.platform !== 'darwin', timeout: 60000 },
  async (t) => {
    const decoder = await detectFfmpeg();
    if (!decoder) {
      t.skip('FFmpeg unavailable');
      return;
    }
    const root = await mkdtemp(join(tmpdir(), 'lm-image-attachment-')),
      store = new Store(join(root, 'local.sqlite')),
      executor = new IsolatedExecutor(join(root, 'runtime'));
    await executor.ready();
    let calls = 0,
      assetId = '',
      wire: any,
      dropSubmit = false;
    const upstream = createServer(async (req, res) => {
      let raw = '';
      for await (const c of req) raw += c;
      wire = JSON.parse(raw);
      calls++;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: 'Actual attached frame received',
                  observations: [
                    {
                      evidenceId: 'actual-attachment-' + assetId,
                      text: 'Protocol fixture observes actual JPEG bytes',
                      confidence: 1,
                    },
                  ],
                  unknowns: ['No audio supplied'],
                }),
              },
            },
          ],
          usage: { total_tokens: 20 },
        }),
      );
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const api = await createApi({
      dataDir: join(root, 'api'),
      demo: true,
      arkKey: 'attachment-protocol-key',
      arkBase: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
    });
    api.app.addHook('onSend', async (req, _, payload) => {
      if (dropSubmit && req.url === '/api/perception' && req.method === 'POST') {
        dropSubmit = false;
        req.raw.socket.destroy();
      }
      return payload;
    });
    await api.app.listen({ host: '127.0.0.1', port: 0 });
    const login = (
        await api.app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} })
      ).json(),
      bytes = png(),
      service = new ConversationAttachmentService({
        store,
        dataDir: root,
        apiUrl: api.app.listeningOrigin,
        executor,
        ffmpegPath: decoder.path,
      });
    const scope = {
      ownerId: login.user.id,
      token: login.token,
      projectId: 'project-attachment',
      sessionId: 'session-attachment',
      runId: 'run-attachment',
    };
    async function upload(name: string, mime: string, data: Buffer) {
      const form = new FormData();
      form.append('file', new Blob([data as any], { type: mime }), name);
      const r = await fetch(api.app.listeningOrigin + '/api/assets', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + login.token },
        body: form,
      });
      assert(r.ok);
      return r.json() as Promise<{ id: string; sha256: string }>;
    }
    try {
      const asset = await upload('actual.png', 'image/png', bytes);
      assetId = asset.id;
      const first = (await service.inspect(scope, { assetId })) as any;
      assert(first.id);
      assert.equal(
        first.attachment.sample.sourceSha256,
        createHash('sha256').update(bytes).digest('hex'),
      );
      assert.deepEqual([first.attachment.sample.width, first.attachment.sample.height], [64, 48]);
      const result = await api.app.inject({
        url: '/api/perception/' + first.id + '?wait=5',
        headers: { authorization: 'Bearer ' + login.token },
      });
      assert.equal(result.json().status, 'completed');
      assert.equal(wire.model, 'doubao-seed-evolving');
      assert(
        wire.messages[1].content.some(
          (c: any) =>
            c.type === 'image_url' && c.image_url.url.startsWith('data:image/jpeg;base64,'),
        ),
      );
      assert.equal(((await service.inspect(scope, { assetId })) as any).id, first.id);
      assert.equal(calls, 1);
      const download = await fetch(api.app.listeningOrigin + `/api/assets/${assetId}/download`, {
        headers: { authorization: 'Bearer ' + login.token },
      });
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
      dropSubmit = true;
      await assert.rejects(
        service.inspect(scope, { assetId, question: 'A separately requested second inspection' }),
      );
      const resumed = (await service.inspect(scope, {
        assetId,
        question: 'A separately requested second inspection',
      })) as any;
      assert(resumed.id);
      await api.app.inject({
        url: '/api/perception/' + resumed.id + '?wait=5',
        headers: { authorization: 'Bearer ' + login.token },
      });
      assert.equal(calls, 2, 'unknown paid submission must be read, not replayed');
      const document = await upload(
        'notes.md',
        'text/markdown',
        Buffer.from('line-one\nline-two\n'),
      );
      const page = (await service.inspect(scope, {
        assetId: document.id,
        offset: 9,
        limit: 8,
      })) as any;
      assert.equal(page.text, 'line-two');
      const tool = createConversationAttachmentTools({
        ...scope,
        service,
        assetIds: new Set([assetId]),
        allowed: ['analyze_attachment'],
      })[0];
      const rejected = await tool.execute('outside', { assetId: document.id }, undefined);
      assert((rejected.details as any).failed);
      assert.equal(calls, 2);
    } finally {
      await service.close();
      await executor.close();
      await api.app.close();
      store.close();
      upstream.closeAllConnections();
      await new Promise<void>((r) => upstream.close(() => r()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
