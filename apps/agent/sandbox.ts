import { constants, realpathSync } from 'node:fs';
import { lstat, realpath, readdir, open, mkdir, rename, unlink, link } from 'node:fs/promises';
import { relative, resolve, join, dirname, sep, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { IsolatedExecutor } from './isolation.ts';
import { assertExecutableArguments } from './tool-context.ts';

const queues = new Map<string, Promise<unknown>>();
const denied = (message: string): never => {
  throw Object.assign(new Error(message), { statusCode: 403, code: 'PROJECT_PATH_FORBIDDEN' });
};
const blocked = (part: string) =>
  part.startsWith('.') ||
  /^(password|secrets?)(\.(md|txt|json|ya?ml|toml|env))?$/i.test(part) ||
  ['node_modules', 'credentials', 'id_rsa', 'id_ed25519'].includes(part.toLowerCase());
export async function projectPath(root: string, path: string, create = false) {
  if (!path || isAbsolute(path) || path.includes('\0') || path.includes('\\'))
    denied('只允许项目内的相对路径');
  const parts = path.split('/').filter((p) => p && p !== '.');
  if (parts.some((p) => p === '..' || blocked(p))) denied('路径超出许可范围');
  const canonical = await realpath(root);
  const destination = resolve(canonical, ...parts);
  const rel = relative(canonical, destination);
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) denied('路径超出项目目录');
  let cursor = canonical;
  for (let i = 0; i < parts.length; i++) {
    cursor = join(cursor, parts[i]);
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) denied('不允许访问符号链接');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!create) throw error;
      if (i < parts.length - 1) await mkdir(cursor, { mode: 0o700 });
    }
  }
  return destination;
}
export async function listFiles(root: string, path = '.') {
  const dir = await projectPath(root, path);
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => !blocked(e.name) && !e.isSymbolicLink())
    .slice(0, 150)
    .map((e) => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' }));
}
export async function readProjectFile(root: string, path: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const destination = await projectPath(root, path);
  const file = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 128000) throw new Error('只允许读取 128 KB 以内的普通文件');
    signal?.throwIfAborted();
    return await file.readFile('utf8');
  } finally {
    await file.close();
  }
}
export async function projectFileDigest(root: string, path: string) {
  const file = await open(await projectPath(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > 64 * 1024 * 1024)
      throw Error('仅校验64MB内普通文件');
    const sha = createHash('sha256'),
      buffer = Buffer.alloc(1024 * 1024);
    let total = 0;
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, total);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > before.size) throw Error('校验期间文件变化');
      sha.update(buffer.subarray(0, bytesRead));
    }
    const after = await file.stat();
    if (
      total !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw Error('校验期间文件变化');
    return { path, bytes: total, sha256: sha.digest('hex') };
  } finally {
    await file.close();
  }
}
export async function editProjectFile(
  root: string,
  path: string,
  oldText: string,
  newText: string,
  expectedSha256?: string,
) {
  if (!oldText || oldText.length > 8000 || newText.length > 32000)
    throw Error('编辑需要非空且有界的精确原文片段');
  const before = await readProjectFile(root, path),
    index = before.indexOf(oldText),
    sha256 = createHash('sha256').update(before).digest('hex');
  if (expectedSha256 && expectedSha256 !== sha256) throw Error('文件版本已变化，请回读后编辑');
  if (index < 0 || before.indexOf(oldText, index + 1) !== -1)
    throw Error('原文片段未找到或不唯一，编辑未执行；请提供唯一上下文');
  const after = before.slice(0, index) + newText + before.slice(index + oldText.length);
  const result = await writeProjectFile(root, path, after, undefined, sha256);
  return {
    ...result,
    previousSha256: sha256,
    sha256: createHash('sha256').update(after).digest('hex'),
  };
}
export async function writeProjectFile(
  root: string,
  path: string,
  content: string,
  signal?: AbortSignal,
  expectedSha256?: string | null,
) {
  // Reserve the canonical project's queue before yielding. Concurrent realpath
  // promises may resolve out of invocation order and otherwise reorder writes.
  const canonical = realpathSync(root);
  const previous = queues.get(canonical) || Promise.resolve();
  const work = previous
    .catch(() => {})
    .then(async () => {
      signal?.throwIfAborted();
      if (Buffer.byteLength(content) > 128000) throw new Error('单个文件最多 128 KB');
      const destination = await projectPath(canonical, path, true);
      const temp = join(dirname(destination), `.lightmao-${randomUUID()}.tmp`);
      const file = await open(temp, 'wx', 0o600);
      try {
        await file.writeFile(content);
        await file.sync();
        await file.close();
        signal?.throwIfAborted();
        await projectPath(canonical, path, true);
        if (
          expectedSha256 &&
          createHash('sha256')
            .update(await readProjectFile(canonical, path, signal))
            .digest('hex') !== expectedSha256
        )
          throw Error('文件已变化，编辑未提交；请回读当前内容后重试');
        signal?.throwIfAborted();
        if (expectedSha256 === null) {
          // link is an atomic no-clobber creation; a competing creator wins safely.
          await link(temp, destination);
          await unlink(temp);
        } else await rename(temp, destination);
      } catch (error) {
        await file.close().catch(() => {});
        await unlink(temp).catch(() => {});
        throw error;
      }
      return { path, bytes: Buffer.byteLength(content) };
    });
  queues.set(canonical, work);
  try {
    return await work;
  } finally {
    if (queues.get(canonical) === work) queues.delete(canonical);
  }
}
const result = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  details: {},
});
export async function importProjectAsset(
  root: string,
  args: { path: string; base64: string; sha256: string; mime: string },
  signal?: AbortSignal,
) {
  const canonical = realpathSync(root);
  const previous = queues.get(canonical) || Promise.resolve();
  const work = previous
    .catch(() => {})
    .then(async () => {
      signal?.throwIfAborted();
      const extensions: Record<string, RegExp> = {
        'image/png': /\.png$/i,
        'image/jpeg': /\.jpe?g$/i,
        'image/webp': /\.webp$/i,
        'video/mp4': /\.mp4$/i,
      };
      if (
        !extensions[args.mime]?.test(args.path) ||
        !/^[a-f0-9]{64}$/.test(args.sha256) ||
        args.base64.length > 28 * 1024 * 1024 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(args.base64)
      )
        throw Error('素材类型、路径或数据格式不符合导入范围');
      const bytes = Buffer.from(args.base64, 'base64');
      if (
        !bytes.length ||
        bytes.length > 20 * 1024 * 1024 ||
        createHash('sha256').update(bytes).digest('hex') !== args.sha256
      )
        throw Error('素材字节大小或哈希校验失败');
      const destination = await projectPath(canonical, args.path, true);
      try {
        const existing = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const info = await existing.stat();
          if (
            !info.isFile() ||
            info.nlink !== 1 ||
            info.size !== bytes.length ||
            createHash('sha256')
              .update(await existing.readFile())
              .digest('hex') !== args.sha256
          )
            throw Error('目标已存在且内容不同，请选择新的素材路径');
          return { path: args.path, bytes: bytes.length, sha256: args.sha256, reused: true };
        } finally {
          await existing.close();
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      const temp = join(dirname(destination), `.lightmao-${randomUUID()}.tmp`);
      const file = await open(temp, 'wx', 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
        await file.close();
        signal?.throwIfAborted();
        await projectPath(canonical, args.path, true);
        await link(temp, destination); // Atomic no-clobber commit.
      } finally {
        await file.close().catch(() => {});
        await unlink(temp).catch(() => {});
      }
      return { path: args.path, bytes: bytes.length, sha256: args.sha256, reused: false };
    });
  queues.set(canonical, work);
  try {
    return await work;
  } finally {
    if (queues.get(canonical) === work) queues.delete(canonical);
  }
}
export function createProjectTools(
  root: string,
  allowed: string[],
  executor: IsolatedExecutor,
): AgentTool[] {
  const execute = async (
    operation: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => {
    try {
      const value = await executor.file(
        root,
        ['write_file', 'edit_file'].includes(operation),
        operation,
        args,
        signal,
      );
      if (operation === 'read_file_page') {
        const { text, ...metadata } = value as { text: string; [key: string]: unknown };
        return {
          content: [
            {
              type: 'text' as const,
              text:
                JSON.stringify(metadata) +
                '\n<file_contents untrusted="true">\n' +
                text +
                '\n</file_contents>',
            },
          ],
          details: { filePage: true },
        };
      }
      return result(value);
    } catch (error) {
      const e = error as Error & { code?: string };
      return {
        content: [{ type: 'text' as const, text: e.message }],
        details: {
          failed: true,
          outcome: signal?.aborted || /^TOOL_/.test(e.code || '') ? 'unknown' : 'failed',
        },
      };
    }
  };
  const all: AgentTool[] = [
    {
      name: 'list_files',
      label: '读取项目目录',
      description: '列出项目内一个目录的文件，隐藏目录和符号链接不可见。',
      parameters: Type.Object({ path: Type.Optional(Type.String()) }),
      execute: async (_, p, signal) => {
        signal?.throwIfAborted();
        return execute('list_files', p as Record<string, unknown>, signal);
      },
    },
    {
      name: 'read_file',
      label: '读取项目文件',
      description:
        'Read file; large outputs are summarized with error hints. For exact source set line or offset plus limit (max 4000 chars), follow nextOffset. Never rewrite from a compressed excerpt.',
      parameters: Type.Object({
        path: Type.String(),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 4000 })),
        line: Type.Optional(Type.Integer({ minimum: 1 })),
      }),
      execute: async (_, p, signal) => {
        const args = p as Record<string, unknown>;
        return execute(
          args.offset !== undefined || args.limit !== undefined || args.line !== undefined
            ? 'read_file_page'
            : 'read_file',
          args,
          signal,
        );
      },
    },
    {
      name: 'write_file',
      label: '写入项目文件',
      description: '写入项目内文本文件。只在用户要求创建或修改文件时使用。',
      parameters: Type.Object(
        {
          path: Type.String(),
          content: Type.String({
            maxLength: 32000,
            description:
              'Write a complete module, maximum 32000 characters per call. Split HTML/CSS/logic/rendering into separate files; never shorten code with archive placeholders or ellipses. For an existing file prefer exact edit_file changes.',
          }),
        },
        { additionalProperties: false },
      ),
      executionMode: 'sequential',
      execute: async (_, p, signal) => {
        assertExecutableArguments(p);
        const value = p as { path: string; content: string };
        if (
          /\.(html|css|[cm]?js|json|gd|tscn|godot)$/i.test(value.path) &&
          value.content.trimEnd().endsWith('…')
        )
          return {
            content: [
              {
                type: 'text',
                text: '代码以归档省略号结尾，拒绝写入不完整参数。请重新生成完整的小模块；原文件未修改。',
              },
            ],
            details: { failed: true },
          };
        return execute('write_file', p as Record<string, unknown>, signal);
      },
    },
    {
      name: 'edit_file',
      label: '精确编辑项目文件',
      executionMode: 'sequential',
      description:
        'Replace one unique exact oldText with newText. Preserves other code; rejects missing or ambiguous anchors and changed SHA. Read the reported error line first. Never use archived excerpts as whole-file content.',
      parameters: Type.Object({
        path: Type.String(),
        oldText: Type.String({ minLength: 1, maxLength: 8000 }),
        newText: Type.String({ maxLength: 32000 }),
        expectedSha256: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
      }),
      execute: async (_, p, signal) => execute('edit_file', p as Record<string, unknown>, signal),
    },
    {
      name: 'inspect_project',
      label: '检查游戏项目',
      description: '读取根目录清单，识别游戏引擎配置。只做静态检查。',
      parameters: Type.Object({}),
      execute: async (_, __, signal) => {
        signal?.throwIfAborted();
        return execute('inspect_project', {}, signal);
      },
    },
    {
      name: 'asset_inventory',
      label: '整理素材清单',
      description: '列出项目根目录及 assets 子目录的素材文件。',
      parameters: Type.Object({}),
      execute: async (_, __, signal) => {
        signal?.throwIfAborted();
        return execute('asset_inventory', {}, signal);
      },
    },
  ];
  return all.filter((t) => allowed.includes(t.name));
}
