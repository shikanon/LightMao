import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';
import './build-runtime.mjs';
await Promise.all(
  ['api', 'agent'].map(async (name) => {
    const result = await build({
      entryPoints: [`apps/${name}/index.ts`],
      outdir: `dist/${name}`,
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      target: 'node24',
      sourcemap: true,
      metafile: true,
    });
    if (name === 'api') {
      const dependencies = new Set();
      for (const output of Object.values(result.metafile.outputs))
        for (const item of output.imports)
          if (item.external && !item.path.startsWith('node:'))
            dependencies.add(
              item.path.startsWith('@')
                ? item.path.split('/').slice(0, 2).join('/')
                : item.path.split('/')[0],
            );
      await writeFile(
        'dist/api/dependencies.json',
        JSON.stringify([...dependencies].sort(), null, 2) + '\n',
      );
    }
  }),
);
console.log('API and local Agent built.');
