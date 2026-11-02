import { constants } from 'node:fs';
import {
  open,
  lstat,
  mkdir,
  readFile,
  rename,
  realpath,
  copyFile,
  chmod,
  readdir,
  cp,
} from 'node:fs/promises';
import { dirname, basename, isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { IsolatedExecutor } from './isolation.ts';
import type { EngineSnapshot } from './engine-snapshot.ts';
import type { EngineArtifact } from '../../packages/shared/types.ts';
import { resourceMime } from '../../packages/skills/format.ts';

export const engineFail = (
  statusCode: number,
  message: string,
  code = 'ENGINE_REJECTED',
): never => {
  throw Object.assign(new Error(message), { statusCode, code });
};
export async function verifiedArtifactBytes(
  path: string,
  metadata: Pick<EngineArtifact, 'bytes' | 'sha256'>,
) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size !== metadata.bytes ||
      info.size > 64 * 1024 * 1024
    )
      engineFail(409, '产物文件校验失败');
    const bytes = Buffer.alloc(info.size);
    let position = 0;
    while (position < bytes.length) {
      const next = await file.read(bytes, position, bytes.length - position, position);
      if (!next.bytesRead) break;
      position += next.bytesRead;
    }
    const after = await file.stat();
    if (
      position !== bytes.length ||
      info.mtimeMs !== after.mtimeMs ||
      info.ctimeMs !== after.ctimeMs ||
      info.size !== after.size ||
      createHash('sha256').update(bytes).digest('hex') !== metadata.sha256
    )
      engineFail(409, '产物字节校验失败');
    return bytes;
  } finally {
    await file.close();
  }
}
export async function fileDigest(path: string, maximum: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > maximum)
      engineFail(400, '文件类型、链接或大小不受支持');
    const hash = createHash('sha256'),
      buffer = Buffer.alloc(1024 * 1024);
    let offset = 0;
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      offset += bytesRead;
      if (offset > info.size) engineFail(409, '文件读取期间发生变化');
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await file.stat();
    if (
      offset !== info.size ||
      info.mtimeMs !== after.mtimeMs ||
      info.ctimeMs !== after.ctimeMs ||
      info.nlink !== after.nlink
    )
      engineFail(409, '文件读取期间发生变化');
    return { sha256: hash.digest('hex'), bytes: offset };
  } finally {
    await file.close();
  }
}
export async function selectedGodot(path: string) {
  if (!isAbsolute(path) || path.includes('\0')) engineFail(400, '请选择 Godot 可执行程序');
  if ((await lstat(path)).isDirectory()) path = join(path, 'Contents/MacOS/Godot');
  const executable = await realpath(path);
  if (!/^godot(?:[_-][\w.-]+)?(?:\.exe)?$/i.test(basename(executable)))
    engineFail(400, '请选择 Godot 标准版程序或 Godot.app');
  const info = await lstat(executable);
  if (!info.isFile() || !(info.mode & 0o111)) engineFail(400, '所选程序不可执行');
  return { executable, ...(await fileDigest(executable, 1024 * 1024 * 1024)) };
}

export async function captureEngineSnapshot(
  executor: IsolatedExecutor,
  root: string,
  workspace: string,
  timeoutMs: number,
  signal: AbortSignal,
  kind: 'godot' | 'web' = 'godot',
): Promise<EngineSnapshot> {
  signal.throwIfAborted();
  const source = await readFile(resolve(import.meta.dirname, '../../dist/runtime/file-worker.cjs'));
  const proc = await executor.spawn(
    executor.executable,
    [],
    { root, writable: false, sensitive: false },
    { source, extension: 'cjs' },
  );
  let bytes = 0,
    timedOut = false,
    exceeded = false;
  const chunks: Buffer[] = [];
  const abort = () => proc.terminate();
  const timer = setTimeout(
    () => {
      timedOut = true;
      proc.terminate();
    },
    Math.max(1, timeoutMs),
  );
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  proc.child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) {
      exceeded = true;
      proc.terminate();
    } else chunks.push(chunk);
  });
  proc.child.stderr.resume();
  proc.child.stdin.on('error', () => {});
  proc.child.stdin.end(
    JSON.stringify({
      root,
      operation: kind === 'web' ? 'snapshot_web' : 'snapshot_project',
      args: {},
    }),
  );
  try {
    const result = await proc.done;
    signal.throwIfAborted();
    if (timedOut) engineFail(408, '工程采集超时', 'ENGINE_TIMEOUT');
    if (exceeded || result.code !== 0) engineFail(400, '工程采集器未正常完成');
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value.ok) engineFail(400, value.error || '工程采集被拒绝', value.code);
    await rename(join(proc.scratch, 'project'), workspace);
    return value.value as EngineSnapshot;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    await proc.close();
  }
}

export async function copyGodotRuntime(executable: string, expected: string, runtime: string) {
  await mkdir(runtime, { mode: 0o700 });
  let binary: string;
  if (process.platform === 'darwin') {
    if (!dirname(executable).endsWith('/Contents/MacOS'))
      engineFail(400, 'macOS 需要保留完整的 Godot.app 签名包');
    const sourceBundle = resolve(dirname(executable), '../..');
    let count = 0,
      bytes = 0;
    async function checkBundle(folder: string, depth = 0) {
      if (depth > 12) engineFail(400, '引擎包目录层级过深');
      for (const item of await readdir(folder, { withFileTypes: true })) {
        if (++count > 1024) engineFail(400, '引擎包文件数量超过上限');
        const path = join(folder, item.name),
          info = await lstat(path);
        if (info.isSymbolicLink()) engineFail(400, '此版引擎连接不支持含链接的程序包');
        if (info.isDirectory()) await checkBundle(path, depth + 1);
        else {
          if (!info.isFile() || info.nlink !== 1 || (bytes += info.size) > 1024 * 1024 * 1024)
            engineFail(400, '引擎包超过 1 GiB 或包含不支持的文件');
        }
      }
    }
    await checkBundle(sourceBundle);
    const bundle = join(runtime, 'Godot.app');
    await cp(sourceBundle, bundle, {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
      force: false,
      errorOnExist: true,
    });
    try {
      execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], {
        stdio: 'pipe',
        timeout: 15000,
      });
    } catch {
      engineFail(400, 'Godot 程序包签名校验失败，请选择完整的标准版');
    }
    binary = join(bundle, 'Contents/MacOS', basename(executable));
  } else {
    binary = join(runtime, 'Godot');
    await copyFile(executable, binary, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
  }
  if ((await fileDigest(binary, 1024 * 1024 * 1024)).sha256 !== expected)
    engineFail(409, 'Godot 程序已改变，请重新选择并授权', 'ENGINE_BINARY_CHANGED');
  await chmod(binary, 0o500);
  // Godot's supported self-contained mode places editor cache/temp below this
  // marker, avoiding macOS NSTemporaryDirectory outside the sandbox.
  const marker = await open(join(runtime, '_sc_'), 'wx', 0o400);
  await marker.close();
  return binary;
}

export async function collectEngineArtifacts(
  workspace: string,
  destination: string,
): Promise<EngineArtifact[]> {
  const source = join(workspace, 'lightmao_artifacts');
  try {
    const info = await lstat(source);
    if (!info.isDirectory() || info.isSymbolicLink()) engineFail(400, '产物目录包含链接或非目录');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  await mkdir(destination, { recursive: true, mode: 0o700 });
  let total = 0,
    visited = 0;
  const artifacts: EngineArtifact[] = [];
  async function visit(folder: string, prefix = '', depth = 0) {
    if (depth > 8) engineFail(400, '产物目录层级过深');
    const entries = await readdir(folder, { withFileTypes: true });
    if (entries.length > 128) engineFail(400, '产物目录项超过限制');
    for (const entry of entries) {
      if (++visited > 256) engineFail(400, '产物目录项超过限制');
      if (entry.name.startsWith('.') || /[\\:\u0000-\u001f]/.test(entry.name))
        engineFail(400, '产物包含不支持的文件名');
      const path = join(folder, entry.name),
        name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (name.length > 240) engineFail(400, '产物文件名过长');
      const info = await lstat(path);
      if (info.isSymbolicLink()) engineFail(400, '产物不可包含链接');
      if (info.isDirectory()) {
        await visit(path, name, depth + 1);
        continue;
      }
      if (
        artifacts.length >= 64 ||
        !info.isFile() ||
        info.nlink !== 1 ||
        total + info.size > 64 * 1024 * 1024
      )
        engineFail(400, '产物超过 64 文件/64 MiB 或包含不支持的链接');
      const checked = await fileDigest(path, 64 * 1024 * 1024);
      const blob = join(destination, checked.sha256);
      try {
        await copyFile(path, blob, constants.COPYFILE_EXCL);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      await chmod(blob, 0o600);
      if ((await fileDigest(blob, 64 * 1024 * 1024)).sha256 !== checked.sha256)
        engineFail(409, '产物字节在保存时发生变化');
      total += checked.bytes;
      artifacts.push({
        id: createHash('sha256')
          .update(name + '\0' + checked.sha256)
          .digest('hex'),
        path: name,
        ...checked,
        mime: resourceMime(name),
      });
    }
  }
  await visit(source);
  return artifacts;
}
