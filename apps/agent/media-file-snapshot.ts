import { constants } from 'node:fs';
import { open, mkdir, lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { projectPath } from './sandbox.ts';
/** Fixed reader in the OS sandbox; large files never pass through model context. */
export async function snapshotMediaFile(root: string, path: string) {
  const source = await projectPath(root, path),
    scratch = process.env.TMPDIR;
  if (!scratch) throw Error('媒体采集缺少私有临时目录');
  const folder = join(scratch, 'media');
  await mkdir(folder, { mode: 0o700 });
  const output = await open(join(folder, 'content'), 'wx', 0o600),
    input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await input.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > 256 * 1024 * 1024)
      throw Error('仅支持256MiB内普通媒体文件');
    const hash = createHash('sha256'),
      buffer = Buffer.alloc(256 * 1024);
    let offset = 0;
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      offset += bytesRead;
      if (offset > before.size) throw Error('媒体采集中发生变化');
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      await output.writeFile(chunk);
    }
    const after = await input.stat(),
      current = await lstat(source);
    if (
      offset !== before.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.ino !== current.ino ||
      before.dev !== current.dev ||
      (await realpath(source)) !== source
    )
      throw Error('媒体文件在采集时变化或被替换');
    await output.sync();
    return { bytes: offset, sha256: hash.digest('hex') };
  } finally {
    await input.close();
    await output.close();
  }
}
