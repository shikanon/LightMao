import { readFile, mkdir, rename, realpath, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import type { IsolatedExecutor } from './isolation.ts';

export async function captureMediaFile(
  executor: IsolatedExecutor,
  root: string,
  path: string,
  target: string,
  signal: AbortSignal,
) {
  const source = await readFile(resolve(import.meta.dirname, '../../dist/runtime/file-worker.cjs'));
  const process = await executor.spawn(
    executor.executable,
    [],
    { root, writable: false, sensitive: false },
    { source, extension: 'cjs' },
  );
  const chunks: Buffer[] = [];
  let count = 0;
  const abort = () => process.terminate(),
    timer = setTimeout(abort, 30000);
  signal.addEventListener('abort', abort, { once: true });
  process.child.stdout.on('data', (b: Buffer) => {
    count += b.length;
    if (count > 20000) abort();
    else chunks.push(b);
  });
  process.child.stderr.resume();
  process.child.stdin.on('error', () => {});
  process.child.stdin.end(
    JSON.stringify({ root, operation: 'snapshot_media_file', args: { path } }),
  );
  try {
    const result = await process.done;
    signal.throwIfAborted();
    if (result.code !== 0 || count > 20000) throw Error('媒体采集未完成');
    const data = JSON.parse(Buffer.concat(chunks).toString());
    if (!data.ok) throw Error(data.error || '媒体采集失败');
    await rename(join(process.scratch, 'media'), target);
    return data.value as { bytes: number; sha256: string };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    await process.close();
  }
}
export async function detectFfmpeg(configured?: string) {
  const require = createRequire(import.meta.url);
  const candidates = [
    configured,
    process.env.LIGHTMAO_FFMPEG_PATH,
    resolve(import.meta.dirname, '../../dist/tools/ffmpeg'),
    join(homedir(), '.local/pylibs/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v7.1'),
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
  ];
  for (const path of candidates.filter((v): v is string => !!v))
    try {
      const canonical = await realpath(path),
        s = await lstat(canonical);
      if (s.isFile() && s.mode & 0o111)
        return {
          path: canonical,
          sha256: createHash('sha256')
            .update(await readFile(canonical))
            .digest('hex'),
        };
    } catch {}
  return undefined;
}
export async function runMediaProcess(
  executor: IsolatedExecutor,
  binary: { path: string; sha256: string },
  root: string,
  args: string[],
  signal?: AbortSignal,
  timeoutMs = 120000,
) {
  if (
    createHash('sha256')
      .update(await readFile(binary.path))
      .digest('hex') !== binary.sha256
  )
    throw Error('媒体运行器版本已变化，请重新启动后核对');
  const proc = await executor.spawn(binary.path, ['-nostdin', '-hide_banner', ...args], {
    root,
    writable: true,
    readPaths: [binary.path],
    sensitive: true,
    outputBytes: 256000,
    timeoutMs,
  });
  const chunks: Buffer[] = [];
  let bytes = 0,
    timedOut = false;
  const abort = () => proc.terminate();
  const timer = setTimeout(() => {
    timedOut = true;
    abort();
  }, timeoutMs);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  proc.child.stdout.resume();
  proc.child.stderr.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 256000) abort();
    else chunks.push(chunk);
  });
  proc.child.stdin.end();
  try {
    const result = await proc.done;
    signal?.throwIfAborted();
    const stderr = Buffer.concat(chunks).toString();
    if (timedOut || result.code !== 0 || bytes > 256000)
      throw Error((timedOut ? '媒体处理超时：' : '媒体处理失败：') + stderr.slice(-1400));
    return stderr;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    await proc.close();
  }
}
export async function probeMedia(
  executor: IsolatedExecutor,
  binary: { path: string; sha256: string },
  root: string,
  filename = 'original',
  signal?: AbortSignal,
) {
  const log = await runMediaProcess(
    executor,
    binary,
    root,
    ['-i', filename, '-t', '0', '-f', 'null', '-'],
    signal,
    15000,
  );
  const duration = log.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/),
    video = log.match(/Video:.*?\b(\d{2,5})x(\d{2,5})\b/);
  const seconds = duration
    ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])
    : 0;
  if (!seconds || seconds > 1800) throw Error('参考媒体须具有30分钟以内的可确认时长');
  return {
    durationSeconds: seconds,
    width: video ? Number(video[1]) : undefined,
    height: video ? Number(video[2]) : undefined,
    hasAudio: /Audio:/.test(log),
    hasVideo: !!video,
  };
}
