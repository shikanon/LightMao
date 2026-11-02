import { createHash } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { projectPath, readProjectFile, writeProjectFile, projectFileDigest } from './sandbox.ts';
import { resourcePath } from './resource-leases.ts';

export interface FileChange {
  path: string;
  expected: string | null;
  content: string | null;
}
export async function applyFileChanges(root: string, changes: FileChange[]) {
  if (
    !changes.length ||
    changes.length > 16 ||
    new Set(changes.map((c) => c.path)).size !== changes.length ||
    JSON.stringify(changes).length > 512000
  )
    throw Error('共享变更最多16个唯一文件、512KB');
  for (const change of changes) {
    resourcePath(change.path);
    if (
      change.path.endsWith('/') ||
      (change.content !== null && Buffer.byteLength(change.content) > 128000)
    )
      throw Error('共享变更只能写入128KB内普通文件');
    let actual: string | null;
    try {
      actual = (await projectFileDigest(root, change.path)).sha256;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      actual = null;
    }
    if (actual !== change.expected) throw Error(`文件版本已变化，拒绝覆盖：${change.path}`);
  }
  const applied: { path: string; before: string | null; after: string | null }[] = [];
  try {
    for (const change of changes) {
      let before: string | null = null;
      if (change.expected !== null) before = await readProjectFile(root, change.path);
      if (change.content === null) {
        if (change.expected === null) throw Error('不能删除不存在的文件');
        if ((await projectFileDigest(root, change.path)).sha256 !== change.expected)
          throw Error('删除前文件已变化');
        await unlink(await projectPath(root, change.path));
      } else await writeProjectFile(root, change.path, change.content, undefined, change.expected);
      applied.push({
        path: change.path,
        before,
        after:
          change.content === null
            ? null
            : createHash('sha256').update(change.content).digest('hex'),
      });
    }
    return { applied: applied.map(({ path, after }) => ({ path, sha256: after })) };
  } catch (e) {
    // Only undo bytes we still own; never erase an unrelated writer's newer content.
    const unresolved: string[] = [];
    for (const file of applied.reverse()) {
      try {
        let current: string | null;
        try {
          current = (await projectFileDigest(root, file.path)).sha256;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          current = null;
        }
        if (current !== file.after) throw Error('已有其他修改');
        if (file.before === null) await unlink(await projectPath(root, file.path));
        else await writeProjectFile(root, file.path, file.before, undefined, file.after);
      } catch {
        unresolved.push(file.path);
      }
    }
    throw Error(
      (e instanceof Error ? e.message : '共享变更失败') +
        (unresolved.length
          ? `；以下文件需核对：${unresolved.join(', ')}`
          : '；本次已写入的文件已回滚'),
    );
  }
}
