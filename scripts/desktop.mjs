import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { constants } from 'node:os';
const require = createRequire(import.meta.url);
if (!existsSync('dist/web/index.html') || !existsSync('dist/agent/index.js')) {
  console.error('Run pnpm build before pnpm desktop.');
  process.exit(1);
}
const electron = require('electron');
const clientEnv = { ...process.env, LIGHTMAO_DEMO: process.env.LIGHTMAO_DEMO || 'true' };
for (const key of Object.keys(clientEnv))
  if (/^(ARK_|OSS_|DOUBAO_|LIGHTMAO_ADMIN_)/.test(key)) delete clientEnv[key];
const child = spawn(electron, ['apps/desktop/main.cjs'], {
  stdio: 'inherit',
  env: clientEnv,
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 128 + (constants.signals[signal] || 1) : 1);
});
let stopSignal;
const forward = (signal) => {
  stopSignal ||= signal;
  if (child.pid && child.exitCode === null && child.signalCode === null) child.kill(stopSignal);
};
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => forward(signal));
child.once('spawn', () => {
  if (stopSignal) forward(stopSignal);
});
child.once('error', () => {
  console.error('LightMao desktop could not start');
  process.exitCode = 1;
});
