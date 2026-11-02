import assert from 'node:assert/strict';
import { DatabaseSync, backup } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import {
  mkdir,
  lstat,
  readdir,
  copyFile,
  chmod,
  readFile,
  writeFile,
  realpath,
} from 'node:fs/promises';
import { resolve, join, sep, dirname, basename } from 'node:path';

// Offline maintenance only. Never overwrite an existing destination, follow an
// object link, or read cloud credentials. The API uses the same exclusive lease.
const [operation, ...args] = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--data-dir', '--backup', '--output'].includes(args[i]) || !args[i + 1] || flags[args[i]])
    throw Error(
      'Usage: backend-data.mjs backup --data-dir DIR --output NEW_DIR | restore --backup DIR --output NEW_DIR',
    );
  flags[args[i]] = resolve(args[i + 1]);
}
const allowed = (path) =>
  /^(?:server\.sqlite|admin-cursor\.key|objects\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*)$/.test(path);
async function ordinary(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.nlink !== 1)
    throw Error('Maintenance requires ordinary, unlinked files');
  return info;
}
async function safeFile(root, name) {
  if (!allowed(name)) throw Error('Invalid backup path');
  const canonical = await realpath(root),
    path = join(canonical, name);
  if ((await realpath(path)) !== path) throw Error('Linked backup paths are not supported');
  await ordinary(path);
  return path;
}
async function hash(path) {
  await ordinary(path);
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}
async function collect(root, directory = 'objects') {
  const info = await lstat(join(root, directory));
  if (!info.isDirectory() || info.isSymbolicLink())
    throw Error('Linked object directories are not supported');
  const files = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const name = directory + '/' + entry.name;
    if (entry.isSymbolicLink()) throw Error('Linked objects are not supported by maintenance');
    if (entry.isDirectory()) files.push(...(await collect(root, name)));
    else {
      if (!allowed(name)) throw Error('Unexpected object filename');
      await ordinary(join(root, name));
      files.push(name);
    }
  }
  return files;
}
async function copy(root, target, name) {
  if (!allowed(name)) throw Error('Invalid backup path');
  await safeFile(root, name);
  await mkdir(dirname(join(target, name)), { recursive: true, mode: 0o700 });
  await copyFile(join(root, name), join(target, name), constants.COPYFILE_EXCL);
  await chmod(join(target, name), 0o600);
}
async function verifyObjects(db, root) {
  let local = 0,
    remote = 0;
  for (const row of db.prepare("SELECT data FROM records WHERE kind='asset'").all()) {
    const asset = JSON.parse(row.data),
      ref = asset.object || { driver: 'local', key: asset.id };
    if (ref.driver === 'oss') {
      remote++;
      continue;
    }
    const name = 'objects/' + ref.key;
    if (!allowed(name)) throw Error('Invalid local object reference');
    const path = await safeFile(root, name),
      info = await ordinary(path);
    assert.equal(info.size, asset.size, 'Object size mismatch');
    if (asset.sha256) assert.equal(await hash(path), asset.sha256, 'Object digest mismatch');
    local++;
  }
  return { local, remoteReferences: remote, remoteBytesBackedUp: false };
}
function integrity(db) {
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
}
const requestedOutput = flags['--output'],
  input = flags[operation === 'backup' ? '--data-dir' : '--backup'];
if (
  !requestedOutput ||
  !input ||
  !['backup', 'restore'].includes(operation) ||
  Object.keys(flags).length !== 2
)
  throw Error('Expected backup/restore, the matching source flag and --output NEW_DIR');
const output = join(await realpath(dirname(requestedOutput)), basename(requestedOutput));
const source = await realpath(input);
if (output === source || output.startsWith(source + sep) || source.startsWith(output + sep))
  throw Error('Source and destination must be separate directories');
if (operation === 'backup') {
  await safeFile(source, 'server.sqlite');
  const db = new DatabaseSync(join(source, 'server.sqlite'));
  db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
  const instanceId = randomUUID();
  try {
    const old = db
      .prepare("SELECT data FROM records WHERE kind='server-runtime-lease' AND id='api'")
      .get();
    if (old) {
      const value = JSON.parse(old.data);
      let alive = true;
      if (Number.isSafeInteger(value.pid) && value.pid > 0) {
        try {
          process.kill(value.pid, 0);
        } catch (e) {
          if (e.code === 'ESRCH') alive = false;
        }
      }
      if (alive) throw Error('Stop the API before creating a full data backup');
    }
    db.prepare(
      "INSERT INTO records(kind,id,owner,data) VALUES('server-runtime-lease','api','system',?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
    ).run(JSON.stringify({ id: 'api', pid: process.pid, instanceId, operation: 'backup' }));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    db.close();
    throw error;
  }
  try {
    await mkdir(output, { mode: 0o700 });
    await backup(db, join(output, 'server.sqlite'));
    await chmod(join(output, 'server.sqlite'), 0o600);
    for (const name of ['admin-cursor.key', ...(await collect(source))])
      await copy(source, output, name);
    const saved = new DatabaseSync(join(output, 'server.sqlite'), { readOnly: true });
    let objects;
    try {
      integrity(saved);
      objects = await verifyObjects(saved, output);
    } finally {
      saved.close();
    }
    const names = ['server.sqlite', 'admin-cursor.key', ...(await collect(output))],
      files = [];
    for (const path of names)
      files.push({
        path,
        bytes: (await ordinary(join(output, path))).size,
        sha256: await hash(join(output, path)),
      });
    const manifest = {
      format: 1,
      at: new Date().toISOString(),
      files,
      objects,
      environmentIncluded: false,
    };
    await writeFile(
      join(output, 'backup-manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n',
      { mode: 0o600, flag: 'wx' },
    );
    console.log(
      JSON.stringify({ operation, output, files: files.length, objects, verified: true }),
    );
  } finally {
    const current = db
      .prepare("SELECT data FROM records WHERE kind='server-runtime-lease' AND id='api'")
      .get();
    if (current && JSON.parse(current.data).instanceId === instanceId)
      db.prepare("DELETE FROM records WHERE kind='server-runtime-lease' AND id='api'").run();
    db.close();
  }
} else {
  await ordinary(join(source, 'backup-manifest.json'));
  const manifest = JSON.parse(await readFile(join(source, 'backup-manifest.json'), 'utf8'));
  assert.equal(manifest.format, 1, 'Unsupported backup format');
  assert(
    Array.isArray(manifest.files) && manifest.files.length >= 2 && manifest.files.length <= 1000000,
  );
  const seen = new Set();
  for (const entry of manifest.files) {
    if (!allowed(entry.path) || seen.has(entry.path))
      throw Error('Invalid or duplicate backup path');
    seen.add(entry.path);
    await safeFile(source, entry.path);
    assert.equal(
      (await ordinary(join(source, entry.path))).size,
      entry.bytes,
      'Backup size mismatch',
    );
    assert.equal(await hash(join(source, entry.path)), entry.sha256, 'Backup digest mismatch');
  }
  assert(seen.has('server.sqlite') && seen.has('admin-cursor.key'), 'Incomplete backup');
  await mkdir(output, { mode: 0o700 });
  for (const entry of manifest.files) await copy(source, output, entry.path);
  await mkdir(join(output, 'objects'), { recursive: true, mode: 0o700 });
  const restored = new DatabaseSync(join(output, 'server.sqlite'));
  let objects;
  try {
    integrity(restored);
    // Only the new independent copy is modified; source receipts stay intact.
    restored.prepare("DELETE FROM records WHERE kind='server-runtime-lease' AND id='api'").run();
    objects = await verifyObjects(restored, output);
    restored.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    restored.close();
  }
  console.log(
    JSON.stringify({
      operation,
      output,
      files: manifest.files.length,
      objects,
      verified: true,
      sourceUnchanged: true,
    }),
  );
}
