import { readFile, writeFile, chmod, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { readPrivateConfig } from './private-config.mjs';

const source = process.argv[2] || 'docs/password.md';
const ignored = execFileSync('git', ['check-ignore', '--no-index', source], {
  encoding: 'utf8',
}).trim();
if (!ignored) throw new Error('The private credentials file must be ignored by Git.');
const config = await readPrivateConfig(source);
if (!config.ARK_API_KEY || config.ARK_API_KEY.length < 20)
  throw new Error('No valid Ark key found in the private file.');
let existing = '';
try {
  existing = await readFile('.env', 'utf8');
} catch {}
const lines = existing.split(/\r?\n/).filter(Boolean);
for (const [key, value] of Object.entries(config)) {
  if (!value) continue;
  const index = lines.findIndex((line) => line.startsWith(`${key}=`));
  const encoded = `${key}=${JSON.stringify(value)}`;
  if (index === -1) lines.push(encoded);
  else lines[index] = encoded;
}
for (const [key, value] of Object.entries({
  ARK_MODEL_ID: 'deepseek-v4-1-flash-261017',
  ARK_CONTEXT_WINDOW_TOKENS: '1024000',
  ARK_MAX_OUTPUT_TOKENS: '128000',
  ARK_VISION_MODEL_ID: 'doubao-seed-evolving',
  ARK_AUDIO_MODEL_ID: 'doubao-seed-2-1-lite-260915',
  ARK_BASE_URL: 'https://ark.cn-beijing.volces.com/api/v3',
  LIGHTMAO_STORAGE: config.OSS_BUCKET ? 'oss' : 'local',
  OSS_PREFIX: 'lightmao/v1/',
}))
  if (!lines.some((line) => line.startsWith(`${key}=`))) lines.push(`${key}=${value}`);
await writeFile('.env', lines.join('\n') + '\n', { mode: 0o600 });
await chmod('.env', 0o600);
console.log(
  JSON.stringify({
    configured: Object.entries(config)
      .filter(([, value]) => !!value)
      .map(([key]) => key),
    destination: '.env',
    values: 'hidden',
  }),
);
