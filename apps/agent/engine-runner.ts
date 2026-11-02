import { z } from 'zod';
import type { EnginePhase } from '../../packages/shared/types.ts';
import type { IsolatedExecutor, ExecutionPolicy } from './isolation.ts';

export const engineRunSchema = z
  .object({
    action: z.enum(['validate', 'run', 'script', 'playtest']),
    script: z.string().min(1).max(400).optional(),
    frames: z.number().int().min(1).max(3600).default(180),
    timeoutSeconds: z.number().int().min(1).max(120).default(30),
    requestId: z.string().min(1).max(200),
    visible: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.action === 'script') !== !!value.script)
      ctx.addIssue({ code: 'custom', message: '仅测试脚本操作需要项目内的 .gd 路径' });
    if (
      value.script &&
      (!value.script.endsWith('.gd') ||
        value.script.startsWith('/') ||
        value.script.split('/').some((p) => p === '..' || p.startsWith('.')) ||
        /[\\:\u0000-\u001f]/.test(value.script))
    )
      ctx.addIssue({ code: 'custom', message: '测试脚本必须是项目内的相对 .gd 路径' });
  });
export type EngineRunInput = z.infer<typeof engineRunSchema>;
export interface CapturedProcess {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  reason?: 'timeout' | 'output_limit' | 'cancelled';
}
export const stripAnsi = (text: string) =>
  text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
export function engineDiagnostics(stdout: string, stderr: string) {
  const lines = stripAnsi(stdout + '\n' + stderr).split('\n');
  const diagnostics: string[] = [];
  let errorCount = 0,
    warningCount = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // Godot macOS falls back to bundled CA roots in this offline sandbox.
    // Keep this exact platform diagnostic visible as an environment warning.
    if (
      line === 'ERROR: Condition "ret != noErr" is true. Returning: ""' &&
      /at: get_system_ca_certificates \(platform\/macos\/os_macos\.mm:\d+\)/.test(
        lines[i + 1] || '',
      )
    ) {
      warningCount++;
      if (diagnostics.length < 100)
        diagnostics.push('环境告警：离线沙箱无法读取 macOS 系统证书服务；网络权限未开放。');
      i++;
      continue;
    }
    if (/^(SCRIPT ERROR:|ERROR:)|\b(Parse Error|Failed to load script):/.test(line)) {
      errorCount++;
      if (diagnostics.length < 100) {
        const location = (lines[i + 1] || '').trim();
        diagnostics.push(
          (line + (/^at:|^res:\/\//.test(location) ? '\n' + location : '')).slice(0, 600),
        );
      }
    } else if (/^WARNING:/.test(line)) {
      warningCount++;
      if (diagnostics.length < 100) diagnostics.push(line.slice(0, 600));
    }
  }
  return { errorCount, warningCount, diagnostics };
}

export async function captureProcess(
  executor: IsolatedExecutor,
  command: string,
  args: string[],
  policy: ExecutionPolicy,
  signal?: AbortSignal,
  onSpawn?: (pid: number) => void,
  interactive?: {
    onLine: (line: string) => void;
    subscribe: (write: (value: unknown) => void) => () => void;
  },
): Promise<CapturedProcess> {
  signal?.throwIfAborted();
  const proc = await executor.spawn(command, args, policy);
  if (proc.child.pid) onSpawn?.(proc.child.pid);
  const started = Date.now(),
    limit = policy.outputBytes || 256 * 1024;
  const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
  let bytes = 0,
    reason: CapturedProcess['reason'];
  let lineBuffer = '';
  const stop = (value: NonNullable<CapturedProcess['reason']>) => {
    reason ||= value;
    proc.terminate();
  };
  const abort = () => stop('cancelled');
  const timeout = setTimeout(() => stop('timeout'), policy.timeoutMs || 30000);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  for (const stream of ['stdout', 'stderr'] as const)
    proc.child[stream].on('data', (chunk: Buffer) => {
      if (bytes + chunk.length > limit) stop('output_limit');
      else {
        chunks[stream].push(chunk);
        bytes += chunk.length;
        if (stream === 'stdout' && interactive) {
          lineBuffer += chunk.toString('utf8');
          const lines = lineBuffer.split('\n');
          lineBuffer = lines.pop() || '';
          for (const line of lines) interactive.onLine(line);
        }
      }
    });
  proc.child.stdin.on('error', () => {});
  const unsubscribe = interactive?.subscribe((value) => {
    if (!proc.child.stdin.destroyed) proc.child.stdin.write(JSON.stringify(value) + '\n');
  });
  if (!interactive) proc.child.stdin.end();
  try {
    const result = await proc.done;
    return {
      ...result,
      durationMs: Date.now() - started,
      stdout: stripAnsi(Buffer.concat(chunks.stdout).toString('utf8')),
      stderr: stripAnsi(Buffer.concat(chunks.stderr).toString('utf8')),
      ...(reason ? { reason } : {}),
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
    unsubscribe?.();
    await proc.close();
  }
}

export interface EngineWorkerRequest {
  type: 'start';
  dataDir: string;
  project: string;
  runtime: string;
  binary: string;
  input: EngineRunInput;
  deadline: number;
}
export interface EnginePhaseResult {
  phase: EnginePhase;
  stdout: string;
  stderr: string;
  diagnostics: string[];
  reason?: CapturedProcess['reason'];
}
