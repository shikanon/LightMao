import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPrivateConfig, secretNames } from './private-config.mjs';

const files = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { encoding: 'utf8' },
)
  .split('\0')
  .filter(Boolean);
if (process.argv.includes('--artifacts')) {
  const walk = async (path) => {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) files.push(child);
    }
  };
  await walk('dist');
}
const violations = [];
let historyObjects = [];
if (process.argv.includes('--history') || process.argv.includes('--pre-push')) {
  // Git passes the exact ref updates on stdin. Internal local backup refs are not
  // part of an ordinary branch push, but must be checked if explicitly pushed.
  const refs = process.argv.includes('--pre-push')
    ? readFileSync(0, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => line.trim().split(/\s+/)[1])
        .filter((ref) => ref && !/^0+$/.test(ref))
    : ['HEAD'];
  if (refs.some((ref) => ref !== 'HEAD' && !/^[a-f0-9]{40,64}$/.test(ref)))
    throw new Error('Invalid push ref input');
  const history = refs.length
    ? execFileSync('git', ['rev-list', '--objects', ...refs], {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
      })
    : '';
  historyObjects = history
    .split('\n')
    .filter(Boolean)
    .map((line) => ({ id: line.split(' ')[0], path: line.slice(line.indexOf(' ') + 1) }));
  for (const line of history.split('\n')) {
    const path = line.slice(line.indexOf(' ') + 1);
    if (/(^|\/)password(?:\.[^/]*)?$|(^|\/)\.env$/i.test(path))
      violations.push(`${path}: private file exists in Git history`);
  }
}
const secrets = new Set(
  secretNames.map((name) => process.env[name]).filter((v) => v && v.length >= 16),
);
try {
  for (const value of Object.values(await readPrivateConfig()))
    if (value && value.length >= 20) secrets.add(value);
} catch {}

try {
  for (const line of (await readFile('.env', 'utf8')).split(/\r?\n/)) {
    if (!secretNames.some((key) => line.startsWith(`${key}=`))) continue;
    const raw = line.slice(line.indexOf('=') + 1).trim();
    let value = raw;
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw.replace(/^['"]|['"]$/g, '');
    }
    if (value.length >= 16) secrets.add(value);
  }
} catch {}
if (historyObjects.length && secrets.size) {
  const types = execFileSync('git', ['cat-file', '--batch-check=%(objecttype) %(objectsize)'], {
    input: historyObjects.map((o) => o.id).join('\n') + '\n',
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  })
    .trim()
    .split('\n');
  for (let i = 0; i < historyObjects.length; i++) {
    const [type, size] = types[i].split(' ');
    if (type !== 'blob' || Number(size) > 8 * 1024 * 1024) continue;
    const value = execFileSync('git', ['cat-file', 'blob', historyObjects[i].id], {
      maxBuffer: 9 * 1024 * 1024,
    });
    if (value.includes(0)) continue;
    if ([...secrets].some((secret) => value.toString('utf8').includes(secret)))
      violations.push(`${historyObjects[i].path}: contains a configured secret in Git history`);
  }
}
for (const file of files) {
  if (
    /(^|\/)password(?:\.[^/]*)?$|(^|\/)\.env(?:\..*)?$|(^|\/)\.secrets\//i.test(file) &&
    !file.endsWith('.env.example')
  ) {
    violations.push(`${file}: private file is visible to Git`);
    continue;
  }
  const buffer = await readFile(file).catch(() => null);
  if (!buffer || buffer.includes(0)) continue;
  const text = buffer.toString('utf8');
  if ([...secrets].some((secret) => text.includes(secret)))
    violations.push(`${file}: contains a configured secret`);
}
if (violations.length) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else console.log(`Secret check passed (${files.length} files inspected; private values hidden).`);
