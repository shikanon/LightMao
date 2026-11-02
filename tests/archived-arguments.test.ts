import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactArguments, assertExecutableArguments } from '../apps/agent/tool-context.ts';
import { createProjectTools } from '../apps/agent/sandbox.ts';
import type { IsolatedExecutor } from '../apps/agent/isolation.ts';
test('historical argument reduction omits source rather than presenting cut code or stringified structured arguments', () => {
  const source = {
      path: 'js/game.js',
      content: 'const complete = true;\n'.repeat(100),
      steps: [{ id: 'a', text: 'complete' }],
    },
    reduced = compactArguments(source) as any;
  assert.equal(reduced.path, source.path);
  assert(!('content' in reduced));
  assert.deepEqual(reduced.steps, source.steps);
  assert.equal(source.content, 'const complete = true;\n'.repeat(100));
  assert.throws(() => assertExecutableArguments(reduced), /占位符不能执行/);
  assert.throws(() => assertExecutableArguments({ nested: [reduced] }), /占位符不能执行/);
  assert.doesNotThrow(() => assertExecutableArguments(source));
});
test('writing an archive placeholder cannot change the project; complete source reaches the real executor intact', async () => {
  let writes = 0,
    seen: unknown;
  const executor = {
    file: async (_root: string, _write: boolean, _op: string, args: unknown) => {
      writes++;
      seen = args;
      return { bytes: 1 };
    },
  } as unknown as IsolatedExecutor;
  const tool = createProjectTools('/project', ['write_file'], executor)[0],
    controller = new AbortController();
  await assert.rejects(
    tool.execute(
      'bad',
      { path: 'game.js', content: 'cut…', _archived: 'summary' } as any,
      controller.signal,
    ),
    /占位符不能执行/,
  );
  const failed = await tool.execute(
    'cut',
    { path: 'game.js', content: 'const game = …' },
    controller.signal,
  );
  assert.equal((failed.details as any).failed, true);
  assert.equal(writes, 0);
  const args = { path: 'game.js', content: 'const game = true;\n'.repeat(100) };
  await tool.execute('good', args, controller.signal);
  assert.equal(writes, 1);
  assert.deepEqual(seen, args);
});
