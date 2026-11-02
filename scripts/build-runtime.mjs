import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
await mkdir('dist/examples', { recursive: true });
await rm('dist/examples/godot-startrail', { recursive: true, force: true });
await cp('examples/godot-startrail', 'dist/examples/godot-startrail', {
  recursive: true,
  filter: (path) => !/(?:^|\/)(?:\.godot|lightmao_artifacts)(?:\/|$)/.test(path),
});
await build({
  entryPoints: ['apps/plugins/game-assets.ts'],
  outfile: 'dist/plugins/game-assets.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  logLevel: 'silent',
});
await build({
  entryPoints: ['apps/agent/file-worker.ts'],
  outfile: 'dist/runtime/file-worker.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  logLevel: 'silent',
});
await build({
  entryPoints: ['apps/agent/isolation-broker.ts'],
  outfile: 'dist/agent/isolation-broker.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  target: 'node24',
  logLevel: 'silent',
});
await build({
  entryPoints: ['apps/agent/engine-worker.ts'],
  outfile: 'dist/agent/engine-worker.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  target: 'node24',
  logLevel: 'silent',
});
