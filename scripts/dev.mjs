import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import './build-runtime.mjs';
try {
  process.loadEnvFile();
} catch {}
const node = process.execPath;
const cloudEnv = {
  ...process.env,
  LIGHTMAO_DEMO: process.env.LIGHTMAO_DEMO || 'true',
  LIGHTMAO_API_URL:
    process.env.LIGHTMAO_API_URL || `http://127.0.0.1:${process.env.API_PORT || 4318}`,
};
const localEnv = { ...cloudEnv };
for (const key of Object.keys(localEnv))
  if (/^(ARK_|OSS_|DOUBAO_|LIGHTMAO_ADMIN_)/.test(key)) delete localEnv[key];
const specs = [
  ['API', ['--import', 'tsx', 'apps/api/index.ts'], cloudEnv],
  ['Agent', ['--import', 'tsx', 'apps/agent/index.ts'], localEnv],
  ['UI', ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], localEnv],
];
const children = specs.map(([name, args, env]) => {
  const child = spawn(node, args, { cwd: resolve('.'), env, stdio: 'inherit' });
  child.on('error', (e) => console.error(`${name}: ${e.message}`));
  return child;
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
for (const child of children)
  child.on('exit', (code) => {
    if (!stopping && code !== 0) {
      process.exitCode = code || 1;
      stop();
    }
  });
await Promise.all(children.map((c) => once(c, 'exit')));
