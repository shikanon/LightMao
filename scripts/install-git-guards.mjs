import { execFileSync } from 'node:child_process';
import { readFile, writeFile, chmod, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

let configured = '';
try {
  configured = execFileSync('git', ['config', '--get', 'core.hooksPath'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
} catch {}
if (configured)
  throw new Error('Existing hooksPath is configured; install the secret guard in that hook chain.');
const hooks = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
  encoding: 'utf8',
}).trim();
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
await mkdir(hooks, { recursive: true });
for (const name of ['pre-commit', 'pre-push']) {
  const path = resolve(hooks, name),
    marker = '# LightMao local secret guard';
  const previous = await readFile(path, 'utf8').catch(() => null);
  if (previous && !previous.includes(marker))
    throw new Error(`Existing ${name} hook was preserved; add the guard to its chain.`);
  await writeFile(
    path,
    `#!/bin/sh\n${marker}\nroot=$(git rev-parse --show-toplevel) || exit 1\ncd "$root" || exit 1\nexec ${quote(process.execPath)} scripts/check-secrets.mjs${name === 'pre-push' ? ' --pre-push' : ''}\n`,
    { mode: 0o700 },
  );
  await chmod(path, 0o700);
}
console.log('Installed repository-local pre-commit and pre-push secret guards.');
