import { constants } from 'node:fs';
import { open, lstat, opendir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { SKILL_LIMITS, resourcePath, skillError as fail } from '../../packages/skills/format.ts';

/** Runs in the read-only OS-isolated file worker, never in an imported script. */
export async function snapshotSkillDirectory(root: string) {
  if (!(await lstat(join(root, 'SKILL.md')).catch(() => undefined))?.isFile())
    fail(400, '所选目录的根层需要 SKILL.md');
  const files: { path: string; base64: string }[] = [],
    ignored: string[] = [];
  let scanned = 0,
    total = 0;
  async function walk(directory: string, prefix = '') {
    for await (const entry of await opendir(directory, { bufferSize: 32 })) {
      if (++scanned > 512) fail(400, '技能目录过大，请仅选择技能包目录');
      const relative = prefix + entry.name;
      if (['.git', '.DS_Store', 'node_modules', '__pycache__'].includes(entry.name)) {
        ignored.push(relative);
        continue;
      }
      const path = resourcePath(relative),
        absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) fail(400, '技能包不允许符号链接');
      if (entry.isDirectory()) {
        await walk(absolute, path + '/');
        continue;
      }
      if (!entry.isFile() || files.length >= SKILL_LIMITS.files)
        fail(400, '技能包只支持 128 个以内的普通文件');
      const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > SKILL_LIMITS.fileBytes)
          fail(400, '技能资源需要 2 MB 以内的普通文件，不允许硬链接');
        const buffer = Buffer.alloc(stat.size + 1),
          { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        total += bytesRead;
        if (bytesRead !== stat.size || total > SKILL_LIMITS.totalBytes)
          fail(400, '技能包发生变动或超过总计 8 MB 上限');
        files.push({ path, base64: buffer.subarray(0, bytesRead).toString('base64') });
      } finally {
        await handle.close();
      }
    }
  }
  await walk(root);
  return { rootName: basename(root), files, ignored };
}
