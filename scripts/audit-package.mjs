import { createReadStream } from 'node:fs';
import { lstat, realpath, readdir, readFile, readlink, rm, symlink } from 'node:fs/promises';
import { resolve, relative, sep, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { readPrivateConfig, secretNames } from './private-config.mjs';
/** Rebase Packager's absolute staging links before signing the locked graph. */
export async function normalizePackageLinks(directory, source) {
  const root = await realpath(directory),
    aliases = [resolve(source), await realpath(source)];
  let changed = 0;
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) {
        const located = resolve(dirname(child), await readlink(child));
        const from = aliases.find((base) => located === base || located.startsWith(base + sep));
        const target = from ? join(root, relative(from, located)) : located;
        if (target !== root && !target.startsWith(root + sep))
          throw Error(`Unmapped external dependency link: ${relative(root, child)}`);
        await rm(child);
        await symlink(relative(dirname(child), target) || '.', child);
        changed++;
      } else if (entry.isDirectory()) await walk(child);
    }
  }
  await walk(root);
  return changed;
}

async function configuredSecrets() {
  const values = new Set(
    secretNames.map((name) => process.env[name]).filter((value) => value && value.length >= 8),
  );
  try {
    const config = await readPrivateConfig();
    for (const name of secretNames) if (config[name]?.length >= 8) values.add(config[name]);
  } catch {}
  try {
    for (const line of (await readFile('.env', 'utf8')).split(/\r?\n/)) {
      if (!secretNames.some((name) => line.startsWith(name + '='))) continue;
      const raw = line.slice(line.indexOf('=') + 1).trim();
      let value;
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw.replace(/^['"]|['"]$/g, '');
      }
      if (typeof value === 'string' && value.length >= 8) values.add(value);
    }
  } catch {}
  return [...values].map((value) => Buffer.from(value));
}
export async function auditPackage(directory, { sourceTree = false } = {}) {
  const root = await realpath(directory),
    secrets = await configuredSecrets(),
    overlap = Math.max(1, ...secrets.map((value) => value.length));
  const visited = new Set(),
    files = [];
  let bytes = 0,
    links = 0;
  async function walk(path) {
    const name = relative(root, path),
      info = await lstat(path);
    if (
      /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.lightmao|\.git)(?:\/|$)|(?:^|\/)password\.md$|\.(?:sqlite|sqlite-wal|sqlite-shm)$/.test(
        name,
      )
    )
      throw Error(`Private path in package: ${name}`);
    const resolved = await realpath(path);
    if (resolved !== root && !resolved.startsWith(root + sep))
      throw Error(`External package link: ${name}`);
    if (info.isSymbolicLink()) {
      links++;
      if (visited.has(resolved)) return;
      return walk(resolved);
    }
    if (visited.has(resolved)) return;
    visited.add(resolved);
    if (info.isDirectory()) {
      for (const entry of await readdir(path)) await walk(join(path, entry));
      return;
    }
    if (!info.isFile()) throw Error(`Special file in package: ${name}`);
    if (
      sourceTree &&
      !/^(?:node_modules\/|apps\/desktop\/|dist\/(?:agent|runtime|plugins|examples|web)\/|package\.json$|README\.md$|LICENSE$)/.test(
        name,
      )
    )
      throw Error(`Unexpected application file: ${name}`);
    bytes += info.size;
    if (bytes > 2 * 1024 ** 3) throw Error('Package exceeds planned 2 GiB scan limit');
    const hash = createHash('sha256');
    let tail = Buffer.alloc(0);
    for await (const chunk of createReadStream(path, { highWaterMark: 256 * 1024 })) {
      hash.update(chunk);
      const block = Buffer.concat([tail, chunk]);
      if (secrets.some((value) => block.includes(value)))
        throw Error(`Configured secret in package: ${name}`);
      tail = block.subarray(Math.max(0, block.length - overlap));
    }
    files.push({ path: name, bytes: info.size, sha256: hash.digest('hex') });
  }
  await walk(root);
  return {
    files,
    bytes,
    links,
    configuredSecretsAbsent: true,
    privatePathsAbsent: true,
    allLinksInsidePackage: true,
  };
}
