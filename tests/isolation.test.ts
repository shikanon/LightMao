import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { IsolatedExecutor, decodeSandboxArgv } from '../apps/agent/isolation.ts';

test('sandbox argv is decoded without evaluating substitutions, redirects or extra commands', () => {
  assert.deepEqual(decodeSandboxArgv("env A='one two' cmd 'a'\"'\"'b' ''"), [
    'env',
    'A=one two',
    'cmd',
    "a'b",
    '',
  ]);
  for (const value of ['echo $(id)', 'echo x;id', 'cmd >file', 'cmd `id`', "cmd 'unfinished"])
    assert.throws(() => decodeSandboxArgv(value));
});

test(
  'macOS tools enforce OS read/write/network/process boundaries, bounded output, cancellation and per-project write order',
  { skip: process.platform !== 'darwin', timeout: 45000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lightmao-isolation-'));
    const project = join(dir, 'project');
    await mkdir(project);
    await writeFile(join(project, 'visible.txt'), 'visible');
    await writeFile(join(project, '.env'), 'private-canary');
    await writeFile(join(dir, 'outside.txt'), 'outside-canary');
    const executor = new IsolatedExecutor(join(dir, 'runtime'));
    const http = createServer((_, res) => res.end('approved-domain-canary'));
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const port = (http.address() as { port: number }).port;
    process.env.LIGHTMAO_TEST_BOUNDARY_CANARY = 'host-environment-canary';
    try {
      assert.equal((await executor.ready()).available, true, executor.status.error);
      const node = executor.executable;
      const policy = { root: project, writable: false };
      const result = await executor.runJSON<Record<string, unknown>>(
        node,
        [
          '-e',
          `
      const fs=require('node:fs'),cp=require('node:child_process');
      const r={visible:fs.readFileSync('visible.txt','utf8'),env:process.env.LIGHTMAO_TEST_BOUNDARY_CANARY||null};
      for(const [k,p] of [['hidden','.env'],['outside',${JSON.stringify(join(dir, 'outside.txt'))}]])try{fs.readFileSync(p);r[k]=true}catch{r[k]=false}
      try{fs.writeFileSync('forbidden.txt','x');r.write=true}catch{r.write=false}
      const child=cp.spawnSync('/bin/echo',['bad']);r.fork=!child.error;
      try{fs.writeFileSync(require('node:path').join(require('node:os').tmpdir(),'scratch-check'),'private');r.scratch=true}catch{r.scratch=false}
      console.log(JSON.stringify(r));`,
        ],
        policy,
      );
      assert.deepEqual(result, {
        visible: 'visible',
        env: null,
        hidden: false,
        outside: false,
        write: false,
        fork: false,
        scratch: true,
      });
      await assert.rejects(access(join(project, 'forbidden.txt')));
      const raw = await executor.runJSON<boolean>(
        node,
        [
          '-e',
          `const s=require('node:net').connect(${port},'127.0.0.1');s.on('error',()=>{console.log(false);s.destroy()});s.on('connect',()=>{console.log(true);s.destroy()});s.setTimeout(2000,()=>{console.log(false);s.destroy()})`,
        ],
        policy,
      );
      assert.equal(raw, false);
      const fetchCode = `fetch('http://127.0.0.1:${port}/').then(async r=>console.log(JSON.stringify({ok:r.ok,text:await r.text()}))).catch(e=>console.log(JSON.stringify({ok:false,error:e.message,cause:e.cause?.message})))`;
      const allowed = await executor.runJSON<{ ok: boolean; text?: string }>(
        node,
        ['-e', fetchCode],
        { ...policy, domains: ['127.0.0.1'] },
      );
      assert.equal(allowed.ok, true);
      assert.equal(allowed.text, 'approved-domain-canary');
      const denied = await executor.runJSON<{ ok: boolean }>(node, ['-e', fetchCode], {
        ...policy,
        domains: ['example.invalid'],
      });
      assert.equal(denied.ok, false);
      const [permit, forbid] = await Promise.all([
        executor.runJSON<{ ok: boolean }>(node, ['-e', fetchCode], {
          ...policy,
          domains: ['127.0.0.1'],
        }),
        executor.runJSON<{ ok: boolean }>(node, ['-e', fetchCode], {
          ...policy,
          domains: ['example.invalid'],
        }),
      ]);
      assert.equal(permit.ok, true);
      assert.equal(forbid.ok, false);
      const permitted = await executor.spawn(
        node,
        [
          '-e',
          'console.log(JSON.stringify({proxy:process.env.HTTP_PROXY}));setInterval(()=>{},1000)',
        ],
        { ...policy, domains: ['127.0.0.1'] },
      );
      try {
        const proxy = await new Promise<string>((resolve, reject) => {
          permitted.child.stdout.once('data', (chunk) => {
            try {
              resolve(JSON.parse(chunk.toString()).proxy);
            } catch (error) {
              reject(error);
            }
          });
        });
        const stolenPort = Number(new URL(proxy).port);
        const crossed = await executor.runJSON<boolean>(
          node,
          [
            '-e',
            `const s=require('node:net').connect(${stolenPort},'127.0.0.1');s.on('error',()=>{console.log(false);s.destroy()});s.on('connect',()=>{console.log(true);s.destroy()});s.setTimeout(1000,()=>{console.log(false);s.destroy()})`,
          ],
          { ...policy, domains: ['example.invalid'] },
        );
        assert.equal(
          crossed,
          false,
          'another running instance cannot reach the permitted proxy even with its port',
        );
      } finally {
        await permitted.close();
      }
      await assert.rejects(
        executor.runJSON(node, ['-e', 'setInterval(()=>{},1000)'], { ...policy, timeoutMs: 150 }),
        { code: 'TOOL_TIMEOUT' },
      );
      await assert.rejects(
        executor.runJSON(node, ['-e', 'process.stdout.write("x".repeat(100000))'], {
          ...policy,
          outputBytes: 100,
        }),
        { code: 'TOOL_OUTPUT_LIMIT' },
      );
      const controller = new AbortController();
      const pending = executor.runJSON(
        node,
        ['-e', 'setInterval(()=>{},1000)'],
        policy,
        undefined,
        controller.signal,
      );
      setTimeout(() => controller.abort(), 80);
      await assert.rejects(pending, { name: 'AbortError' });
      await Promise.all(
        ['first', 'second', 'last'].map((content) =>
          executor.file(project, true, 'write_file', { path: 'ordered.txt', content }),
        ),
      );
      assert.equal(await readFile(join(project, 'ordered.txt'), 'utf8'), 'last');
      assert.equal(
        await executor.file(project, false, 'read_file', { path: 'ordered.txt' }),
        'last',
      );
      await assert.rejects(
        executor.file(project, false, 'read_file', { path: '.env' }),
        /许可范围/,
      );
    } finally {
      delete process.env.LIGHTMAO_TEST_BOUNDARY_CANARY;
      await executor.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
