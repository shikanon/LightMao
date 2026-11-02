import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, readFile, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createApi } from '../apps/api/server.ts';
import { IsolatedExecutor } from '../apps/agent/isolation.ts';
import type { ObjectStorage } from '../apps/api/object-storage.ts';
import type { GenerationJob } from '../packages/shared/types.ts';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jPmcAAAAASUVORK5CYII=',
  'base64',
);
test(
  'media asset reconciliation resolves the same cloud PUT after restart without resubmitting a paid model',
  { timeout: 15000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lm-generation-reconcile-'));
    const objects = new Map<string, Buffer>();
    let posts = 0,
      puts = 0;
    const storage: ObjectStorage = {
      driver: 'oss',
      async put(key, bytes) {
        puts++;
        objects.set(key, bytes);
        throw Error('response lost after commit');
      },
      async get(key) {
        const bytes = objects.get(key);
        if (!bytes) throw Error('not found');
        return bytes;
      },
      async stream(key) {
        return Readable.from(objects.get(key)!);
      },
      async remove(key) {
        objects.delete(key);
      },
    };
    const upstream = createServer(async (req, res) => {
      for await (const _ of req) {
      }
      posts++;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
    });
    await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
    const options = {
      dataDir: dir,
      arkKey: 'fixture',
      arkBase: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/api/v3`,
      demo: true,
      objectStorage: storage,
      generationPollMs: 20,
    };
    let api = await createApi(options);
    try {
      const login = (
        await api.app.inject({
          method: 'POST',
          url: '/api/auth/register',
          payload: {
            name: 'Media verification',
            email: 'media@example.test',
            password: 'a-valid-test-password',
          },
        })
      ).json();
      const headers = { authorization: 'Bearer ' + login.token };
      await api.app.inject({
        method: 'PATCH',
        url: '/api/plugins/image-generation',
        headers,
        payload: { installed: true, enabled: true },
      });
      const input = {
        kind: 'image',
        requestId: randomUUID(),
        projectId: randomUUID(),
        sessionId: randomUUID(),
        name: 'character',
        prompt: 'original character',
      };
      const initial = api.generations.create(login.user.id, input);
      let job: GenerationJob = initial;
      for (let n = 0; n < 100 && job.status !== 'unknown'; n++) {
        await delay(20);
        job = api.generations.get(login.user.id, initial.id);
      }
      assert.equal(job.status, 'unknown');
      assert.equal(posts, 1);
      assert.equal(puts, 1);
      assert.equal(
        api.store.get<{ status: string }>('usage', job.id, 'system')?.status,
        'completed',
        'a known upstream success is not changed into a generation failure by a cloud PUT timeout',
      );
      await api.app.close();
      api = await createApi(options);
      assert.equal(
        api.generations.create(login.user.id, { ...input, requestId: randomUUID() }).id,
        job.id,
      );
      const reconciled = await api.generations.reconcile(login.user.id, job.id);
      assert.equal(reconciled.status, 'completed');
      assert.equal(posts, 1);
      assert.equal(puts, 1);
      assert.deepEqual(
        await api.assets.read(api.assets.get(login.user.id, reconciled.asset!.id)),
        png,
      );
    } finally {
      await api.app.close();
      await new Promise<void>((done) => upstream.close(() => done()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
test('capability routes require admin identity, preserve conflicting drafts, audit exactly once and advertise compatibility', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lm-capabilities-'));
  const api = await createApi({ dataDir: dir, demo: true });
  try {
    const admin = (
      await api.app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} })
    ).json();
    const headers = { authorization: 'Bearer ' + admin.token };
    const member = (
      await api.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          name: 'Member',
          email: 'member@example.test',
          password: 'a-valid-test-password',
        },
      })
    ).json();
    assert.equal(
      (
        await api.app.inject({
          method: 'GET',
          url: '/api/admin/capability-models',
          headers: { authorization: 'Bearer ' + member.token },
        })
      ).statusCode,
      403,
    );
    const list = (
      await api.app.inject({ method: 'GET', url: '/api/admin/capability-models', headers })
    ).json();
    assert.deepEqual(list.map((v: { kind: string }) => v.kind).sort(), [
      'audio',
      'decision',
      'image',
      'video',
      'vision',
    ]);
    const input = { modelId: 'doubao-custom-system-one', enabled: false, revision: 0 };
    assert.equal(
      (
        await api.app.inject({
          method: 'PATCH',
          url: '/api/admin/capability-models/decision',
          headers,
          payload: input,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await api.app.inject({
          method: 'PATCH',
          url: '/api/admin/capability-models/decision',
          headers,
          payload: { ...input, enabled: true },
        })
      ).statusCode,
      409,
    );
    assert.equal(
      api.store
        .list<{ action: string }>('audit')
        .filter((a) => a.action === 'capability-model.update').length,
      1,
    );
    assert.equal(
      (await api.app.inject({ method: 'GET', url: '/api/bootstrap', headers })).json().features
        .systemOne,
      true,
    );
    assert.equal(
      (await api.app.inject({ method: 'GET', url: '/api/account/bootstrap', headers })).json()
        .features.generations,
      true,
    );
  } finally {
    await api.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test(
  'binary imports and optional graphics keep the OS file, network and process boundaries',
  { skip: process.platform !== 'darwin', timeout: 20000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lm-binary-graphics-'));
    const root = join(dir, 'project');
    await mkdir(root);
    await writeFile(join(dir, 'private-canary.txt'), 'outside-canary');
    const ex = new IsolatedExecutor(join(dir, 'runtime'));
    const http = createServer((_, res) => res.end('must not connect'));
    await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
    try {
      assert((await ex.ready()).available);
      const args = {
        path: 'generated/character.png',
        base64: png.toString('base64'),
        mime: 'image/png',
        sha256: createHash('sha256').update(png).digest('hex'),
      };
      await ex.file(root, true, 'import_asset', args);
      await ex.file(root, true, 'import_asset', args);
      assert.deepEqual(await readFile(join(root, args.path)), png);
      const binaryHash = await ex.file<{ sha256: string; bytes: number }>(
        root,
        false,
        'hash_file',
        { path: args.path },
      );
      assert.equal(binaryHash.sha256, args.sha256);
      assert.equal(binaryHash.bytes, png.length);
      const source = 'first line\nconst target = 1;\nlast line\n';
      await ex.file(root, true, 'write_file', { path: 'code.js', content: source });
      const page = await ex.file<{ text: string; sha256: string; offset: number }>(
        root,
        false,
        'read_file_page',
        { path: 'code.js', line: 2, limit: 17 },
      );
      assert.equal(page.text, 'const target = 1;');
      assert.equal(page.offset, 11);
      await ex.file(root, true, 'edit_file', {
        path: 'code.js',
        oldText: 'target = 1',
        newText: 'target = 2',
        expectedSha256: page.sha256,
      });
      await assert.rejects(
        ex.file(root, true, 'edit_file', {
          path: 'code.js',
          oldText: 'target = 2',
          newText: 'target = 3',
          expectedSha256: page.sha256,
        }),
        /版本/,
      );
      assert.equal(
        await readFile(join(root, 'code.js'), 'utf8'),
        source.replace('target = 1', 'target = 2'),
      );
      await ex.file(root, true, 'write_file', { path: 'ambiguous.txt', content: 'aaaa' });
      await assert.rejects(
        ex.file(root, true, 'edit_file', { path: 'ambiguous.txt', oldText: 'aa', newText: 'b' }),
        /不唯一/,
      );
      const different = Buffer.concat([png, Buffer.from('changed')]);
      await assert.rejects(() =>
        ex.file(root, true, 'import_asset', {
          ...args,
          base64: different.toString('base64'),
          sha256: createHash('sha256').update(different).digest('hex'),
        }),
      );
      await assert.rejects(() =>
        ex.file(root, true, 'import_asset', { ...args, path: '../escape.png' }),
      );
      await symlink(dir, join(root, 'outside'));
      await assert.rejects(() =>
        ex.file(root, true, 'import_asset', { ...args, path: 'outside/no.png' }),
      );
      const result = await ex.runJSON(
        ex.executable,
        [
          '-e',
          `const fs=require('node:fs'),cp=require('node:child_process'),net=require('node:net');let r={};try{fs.readFileSync(${JSON.stringify(join(dir, 'private-canary.txt'))});r.outside=true}catch{r.outside=false}try{fs.writeFileSync('blocked.txt','x');r.write=true}catch{r.write=false}r.fork=!cp.spawnSync('/bin/echo',['bad']).error;const s=net.connect(${(http.address() as { port: number }).port},'127.0.0.1');s.on('error',()=>{r.network=false;console.log(JSON.stringify(r));s.destroy()});s.on('connect',()=>{r.network=true;console.log(JSON.stringify(r));s.destroy()});`,
        ],
        { root, writable: false, graphics: true },
      );
      assert.deepEqual(result, { outside: false, write: false, fork: false, network: false });
      assert.deepEqual(await readFile(join(root, args.path)), png);
    } finally {
      await ex.close();
      await new Promise<void>((done) => http.close(() => done()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
