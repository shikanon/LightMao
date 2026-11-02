import { backup } from 'node:sqlite';
import { mkdir, chmod, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Store } from '../packages/shared/store.ts';
import { LocalObjectStorage, OssObjectStorage } from '../apps/api/object-storage.ts';

process.loadEnvFile();
const dataDir = process.env.LIGHTMAO_DATA_DIR || resolve('.lightmao');
const store = new Store(join(dataDir, 'server.sqlite'));
const rows = store.db
  .prepare("SELECT owner,data FROM records WHERE kind='asset'")
  .all()
  .map((r) => ({ owner: r.owner, asset: JSON.parse(r.data) }))
  .filter((r) => r.asset.object?.driver !== 'oss');
const summary = {
  assets: rows.length,
  bytes: rows.reduce((n, r) => n + r.asset.size, 0),
  apply: process.argv.includes('--apply'),
};
console.log(JSON.stringify(summary));
if (!summary.apply) {
  store.close();
  process.exit(0);
}
const receipt = { id: randomUUID(), at: new Date().toISOString(), migrated: [], failed: [] };
await mkdir(join(dataDir, 'verification'), { recursive: true });
const backupPath = join(dataDir, 'verification', `server-before-oss-${receipt.id}.sqlite`);
await backup(store.db, backupPath);
await chmod(backupPath, 0o600);
const local = new LocalObjectStorage(join(dataDir, 'objects'));
const cloud = new OssObjectStorage({
  region: process.env.OSS_REGION,
  bucket: process.env.OSS_BUCKET,
  accessKeyId: process.env.OSS_ACCESS_KEY_ID,
  accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
  prefix: process.env.OSS_PREFIX,
});
for (const { owner, asset } of rows) {
  const key = `${owner}/${asset.id}`;
  try {
    const bytes = await local.get(asset.object?.key || asset.id);
    assertHash(bytes, asset);
    let existing;
    try {
      existing = await cloud.get(key);
    } catch (e) {
      if (e.status !== 404 && e.code !== 'NoSuchKey') throw e;
    }
    const previous = store.get('asset-migration', asset.id, owner);
    if (!existing) {
      if (previous?.status === 'unknown')
        throw new Error(
          'Previous outcome remains unknown; inspect the original object before retrying.',
        );
      store.put('asset-migration', owner, {
        id: asset.id,
        key,
        status: 'unknown',
        at: new Date().toISOString(),
      });
      await cloud.put(key, bytes, asset.mime);
      existing = await cloud.get(key);
    }
    assertHash(existing, asset);
    store.put('asset', owner, { ...asset, object: { driver: 'oss', key } });
    store.put('asset-migration', owner, {
      id: asset.id,
      key,
      status: 'verified',
      at: new Date().toISOString(),
    });
    receipt.migrated.push({ id: asset.id, sha256: asset.sha256, size: asset.size });
  } catch (e) {
    receipt.failed.push({ id: asset.id, code: e.code || e.name });
    process.exitCode = 1;
  }
}
store.close();
await writeFile(
  join(dataDir, 'verification', `oss-migration-${receipt.id}.json`),
  JSON.stringify(receipt, null, 2),
  { mode: 0o600 },
);
console.log(
  JSON.stringify({
    migrated: receipt.migrated.length,
    failed: receipt.failed.length,
    backup: backupPath,
    localOriginalsRetained: true,
  }),
);
function assertHash(data, asset) {
  if (
    data.length !== asset.size ||
    createHash('sha256').update(data).digest('hex') !== asset.sha256
  )
    throw new Error('Stored bytes do not match the recorded hash.');
}
