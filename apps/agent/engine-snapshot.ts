import { constants } from 'node:fs';
import { lstat, open, opendir, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const engineSnapshotLimits = {
  files: 4096,
  entries: 16384,
  bytes: 512 * 1024 * 1024,
  file: 64 * 1024 * 1024,
};
export interface EngineSnapshot {
  files: { path: string; bytes: number; sha256: string }[];
  totalBytes: number;
  sha256: string;
  excluded: string[];
  excludedCount: number;
}
const fail = (message: string): never => {
  throw Object.assign(new Error(message), { statusCode: 400, code: 'ENGINE_SNAPSHOT_REJECTED' });
};
const blocked = (name: string) =>
  name.startsWith('.') ||
  /^(password|secrets?)(\..*)?$/i.test(name) ||
  ['node_modules', 'credentials', 'id_rsa', 'id_ed25519', 'lightmao_artifacts'].includes(
    name.toLowerCase(),
  );
const fingerprint = (stat: Awaited<ReturnType<typeof lstat>>) =>
  [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');

/** Runs inside the trusted, read-only file worker; output is confined to its scratch. */
export async function snapshotEngineProject(
  root: string,
  requireGodot = true,
  copyFiles = true,
): Promise<EngineSnapshot> {
  root = await realpath(root);
  const scratch = process.env.TMPDIR;
  if (!scratch) fail('工程采集器缺少独立临时目录');
  const target = join(scratch!, 'project');
  if (copyFiles) await mkdir(target, { mode: 0o700 });
  const files: EngineSnapshot['files'] = [],
    excluded: string[] = [];
  const checks: { path: string; fingerprint: string }[] = [];
  let totalBytes = 0,
    entries = 0,
    excludedCount = 0;
  async function walk(path: string, destination: string, relative = '', depth = 0) {
    if (depth > 16) fail('工程目录层级超过 16 层');
    const directory = await lstat(path);
    if (!directory.isDirectory() || directory.isSymbolicLink()) fail('工程包含不支持的目录或链接');
    checks.push({ path, fingerprint: fingerprint(directory) });
    const handle = await opendir(path, { bufferSize: 32 });
    for await (const entry of handle) {
      if (++entries > engineSnapshotLimits.entries) fail('工程目录项超过采集上限');
      const name = entry.name;
      const resource = relative ? `${relative}/${name}` : name;
      if (blocked(name) && name !== '.gdignore') {
        excludedCount++;
        if (excluded.length < 100) excluded.push(resource);
        continue;
      }
      if (resource.length > 400 || /[\\\u0000-\u001f\u007f]/.test(name) || name === '..')
        fail('工程包含无法安全采集的文件名');
      const source = join(path, name),
        output = join(destination, name);
      const info = await lstat(source);
      if (info.isSymbolicLink()) fail(`工程包含符号链接：${resource}`);
      if (info.isDirectory()) {
        if (copyFiles) await mkdir(output, { mode: 0o700 });
        await walk(source, output, resource, depth + 1);
        continue;
      }
      if (!info.isFile() || info.nlink !== 1) fail(`工程包含非普通文件或硬链接：${resource}`);
      if (
        files.length >= engineSnapshotLimits.files ||
        info.size > engineSnapshotLimits.file ||
        totalBytes + info.size > engineSnapshotLimits.bytes
      )
        fail('工程超出采集预算：最多 4096 文件、512 MiB，单文件 64 MiB');
      const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
      let outputFile;
      try {
        const before = await input.stat();
        if (fingerprint(before) !== fingerprint(info) || before.nlink !== 1)
          fail('工程文件在采集前发生变化');
        if (copyFiles) outputFile = await open(output, 'wx', 0o600);
        const hash = createHash('sha256');
        const buffer = Buffer.alloc(128 * 1024);
        let offset = 0;
        while (true) {
          const { bytesRead } = await input.read(buffer, 0, buffer.length, offset);
          if (!bytesRead) break;
          offset += bytesRead;
          if (offset > info.size || totalBytes + offset > engineSnapshotLimits.bytes)
            fail('工程文件在采集时增长');
          const chunk = buffer.subarray(0, bytesRead);
          hash.update(chunk);
          if (outputFile) await outputFile.writeFile(chunk);
        }
        if (offset !== info.size || fingerprint(await input.stat()) !== fingerprint(info))
          fail('工程文件在采集时发生变化，请重试');
        totalBytes += offset;
        files.push({ path: resource, bytes: offset, sha256: hash.digest('hex') });
        checks.push({ path: source, fingerprint: fingerprint(info) });
      } finally {
        await outputFile?.close();
        await input.close();
      }
    }
  }
  await walk(root, target);
  for (const check of checks)
    if (fingerprint(await lstat(check.path)) !== check.fingerprint)
      fail('工程在采集过程中被修改，请重试');
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (requireGodot && !files.some((file) => file.path === 'project.godot'))
    fail('当前工程缺少 project.godot');
  return {
    files,
    totalBytes,
    sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    excluded,
    excludedCount,
  };
}
