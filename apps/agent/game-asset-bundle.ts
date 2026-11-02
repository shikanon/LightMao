import { constants } from 'node:fs';
import { open, mkdir, lstat, unlink, rmdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { projectPath } from './sandbox.ts';
import { resourcePath } from './resource-leases.ts';

export interface AssetBundleFile {
  path: string;
  base64: string;
  sha256: string;
}
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Trusted worker operation: create a new, bounded asset directory. Never replace existing bytes. */
export async function commitGameAssetBundle(
  root: string,
  outputDir: string,
  files: AssetBundleFile[],
) {
  resourcePath(outputDir);
  if (outputDir.endsWith('/') || files.length < 3 || files.length > 270)
    throw Error('素材输出须为新的目录，文件数3~270');
  let total = 0;
  const names = new Set<string>();
  const decoded = files.map((f) => {
    if (
      !/^[a-zA-Z0-9_-]+\.(png|json|html|gd|txt)$/.test(f.path) ||
      names.has(f.path) ||
      !/^[a-f0-9]{64}$/.test(f.sha256) ||
      f.base64.length > 24 * 1024 * 1024 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(f.base64)
    )
      throw Error('素材包文件名或数据无效');
    names.add(f.path);
    const bytes = Buffer.from(f.base64, 'base64');
    total += bytes.length;
    if (!bytes.length || total > 64 * 1024 * 1024 || digest(bytes) !== f.sha256)
      throw Error('素材包超过64MiB或字节校验失败');
    return { ...f, bytes };
  });
  if (!names.has('manifest.json')) throw Error('素材包缺少清单');
  const destination = await projectPath(root, outputDir, true);
  try {
    await mkdir(destination, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const info = await lstat(destination);
    if (!info.isDirectory() || info.isSymbolicLink()) throw Error('素材目标不是普通目录');
    const entries = await readdir(destination);
    if (entries.length !== decoded.length || entries.some((name) => !names.has(name)))
      throw Error('输出目录已有不同或未完成的素材，请使用新的outputDir');
    for (const f of decoded) {
      const handle = await open(
        await projectPath(root, outputDir + '/' + f.path),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const s = await handle.stat();
        if (
          !s.isFile() ||
          s.nlink !== 1 ||
          s.size !== f.bytes.length ||
          digest(await handle.readFile()) !== f.sha256
        )
          throw Error('输出目录已有不同素材，请使用新的outputDir');
      } finally {
        await handle.close();
      }
    }
    return { outputDir, files: decoded.length, bytes: total, reused: true };
  }
  const owned: string[] = [];
  try {
    // Manifest is the commit marker and is written only after all frame/atlas bytes are durable.
    for (const f of [
      ...decoded.filter((f) => f.path !== 'manifest.json'),
      decoded.find((f) => f.path === 'manifest.json')!,
    ]) {
      const path = await projectPath(root, outputDir + '/' + f.path, true);
      const handle = await open(path, 'wx', 0o600);
      owned.push(path);
      try {
        await handle.writeFile(f.bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    return { outputDir, files: decoded.length, bytes: total, reused: false };
  } catch (e) {
    for (const path of owned.reverse()) await unlink(path).catch(() => {});
    await rmdir(destination).catch(() => {});
    throw e;
  }
}
