import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test(
  'sandbox accepts an executable absolute shell even when PATH lookup is unavailable, while still enforcing file isolation',
  { skip: process.platform !== 'darwin', timeout: 15000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'lm-absolute-shell-'));
    const project = join(root, 'project'),
      missing = join(root, 'missing-path');
    await mkdir(project);
    await mkdir(missing);
    await writeFile(join(project, 'proof.txt'), 'absolute-shell-fixture');
    await writeFile(join(root, 'private.txt'), 'outside-stays-private');
    const module = new URL('../apps/agent/isolation.ts', import.meta.url).href;
    const source = `import assert from 'node:assert/strict';import{IsolatedExecutor}from ${JSON.stringify(module)};const ex=new IsolatedExecutor(${JSON.stringify(join(root, 'runtime'))});try{assert.equal((await ex.ready()).available,true,ex.status.error);process.env.PATH=${JSON.stringify(missing)};assert.equal(await ex.file(${JSON.stringify(project)},false,'read_file',{path:'proof.txt'}),'absolute-shell-fixture');const outside=await ex.runJSON(ex.executable,['-e',${JSON.stringify(`const fs=require('node:fs');try{fs.readFileSync(${JSON.stringify(join(root, 'private.txt'))});console.log(true)}catch{console.log(false)}`)}],{root:${JSON.stringify(project)},writable:false});assert.equal(outside,false);console.log('absolute-shell-and-boundary-ok');}finally{await ex.close();}`;
    try {
      const result = await promisify(execFile)(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', source],
        { timeout: 12000, maxBuffer: 16384 },
      );
      assert(result.stdout.includes('absolute-shell-and-boundary-ok'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
