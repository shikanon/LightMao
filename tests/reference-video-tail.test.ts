import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../packages/shared/store.ts';
import { ReferenceMediaService } from '../apps/agent/reference-media.ts';
import { IsolatedExecutor } from '../apps/agent/isolation.ts';
import { detectFfmpeg, runMediaProcess } from '../apps/agent/media-runtime.ts';
import type { ProjectService } from '../apps/agent/projects.ts';
import type { TraceService } from '../apps/agent/trace.ts';

test(
  'short low-fps video recovers an empty tail seek and records actual source PTS',
  {
    skip: process.platform !== 'darwin',
    timeout: 60000,
  },
  async (t) => {
    const decoder = await detectFfmpeg();
    if (!decoder) {
      t.skip('FFmpeg unavailable');
      return;
    }
    const root = await mkdtemp(join(tmpdir(), 'lm-reference-tail-')),
      store = new Store(join(root, 'local.sqlite')),
      executor = new IsolatedExecutor(join(root, 'runtime')),
      owner = randomUUID(),
      project = randomUUID();
    await executor.ready();
    const references = new ReferenceMediaService(
      store,
      root,
      { requireAccess: async () => {} } as unknown as ProjectService,
      executor,
      'http://127.0.0.1:1',
      {} as TraceService,
      decoder.path,
    );
    try {
      await runMediaProcess(executor, decoder, root, [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:s=160x96:r=8:d=1',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        'short.mp4',
      ]);
      const original = await readFile(join(root, 'short.mp4')),
        uploaded = await references.upload(
          owner,
          project,
          'short.mp4',
          'video/mp4',
          (async function* () {
            yield original;
          })(),
        ),
        ready = await references.wait(owner, uploaded.id);
      assert.equal(ready.status, 'ready', ready.error);
      assert.equal(ready.frames.length, 2);
      assert.equal(ready.frames[0].seconds, 0);
      // Container tail 0.9s has no frame: actual final frame is 0.875s.
      // The bounded earlier seek at 0.4s decodes the actual 0.5s frame.
      assert.equal(ready.frames[1].seconds, 0.5);
      assert.notEqual(ready.frames[1].seconds, 0.9);
      for (const frame of ready.frames) {
        const bytes = await references.bytes(owner, ready.id, 'frame', frame.id);
        assert.equal(bytes.subarray(0, 2).toString('hex'), 'ffd8');
        assert.equal(createHash('sha256').update(bytes).digest('hex'), frame.sha256);
      }
      const source = await readFile(
        join(
          root,
          'reference-media',
          createHash('sha256').update(owner).digest('hex'),
          ready.id,
          'original',
        ),
      );
      assert.deepEqual(source, original);
      assert.equal(ready.sha256, createHash('sha256').update(original).digest('hex'));
    } finally {
      await references.close();
      await executor.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
