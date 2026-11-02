import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { IsolatedExecutor } from './isolation.ts';
import {
  captureProcess,
  engineDiagnostics,
  type EngineWorkerRequest,
  type EnginePhaseResult,
} from './engine-runner.ts';

// This trusted supervisor owns the sandboxed engine. An Agent crash closes IPC;
// this process then kills its engine and removes its own sandbox scratch.
let executor: IsolatedExecutor | undefined;
let started = false,
  active: Promise<void> | undefined;
const controller = new AbortController();
const abort = () => controller.abort();
process.once('disconnect', abort);
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, abort);
const send = (data: unknown) => {
  if (process.connected) process.send?.(data);
};
process.on('message', (data: unknown) => {
  if ((data as { type?: string })?.type === 'cancel') {
    abort();
    return;
  }
  if (started || (data as { type?: string })?.type !== 'start') return;
  started = true;
  const request = data as EngineWorkerRequest;
  active = (async () => {
    try {
      executor = new IsolatedExecutor(request.dataDir);
      if (!(await executor.ready()).available)
        throw new Error(executor.status.error || '引擎隔离不可用');
      controller.signal.throwIfAborted();
      await mkdir(join(request.runtime, 'editor_data'), { mode: 0o700 });
      const actions =
        request.input.action === 'validate'
          ? (['import'] as const)
          : (['import', request.input.action] as const);
      for (const name of actions) {
        controller.signal.throwIfAborted();
        send({ type: 'stage', stage: name });
        const remaining = request.deadline - Date.now();
        if (remaining <= 0) {
          send({ type: 'done', reason: 'timeout' });
          return;
        }
        const args = [
          ...(name === 'import' || !request.input.visible ? ['--headless'] : []),
          '--path',
          request.project,
          '--log-file',
          join(request.runtime, 'editor_data', `${name}.log`),
        ];
        if (name === 'import') args.push('--import');
        else {
          args.push(
            '--quit-after',
            String(request.input.frames),
            name === 'run' && request.input.visible ? '--max-fps' : '--fixed-fps',
            '60',
          );
          if (name === 'script') args.push('--script', `res://${request.input.script}`);
          if (name === 'playtest') args.push('--script', 'res://lightmao_autoplay_driver.gd');
          if (name === 'playtest' || request.input.visible) args.push('--audio-driver', 'Dummy');
        }
        const result = await captureProcess(
          executor,
          request.binary,
          args,
          {
            root: request.project,
            writable: true,
            sensitive: false,
            readPaths: [request.runtime],
            writePaths: [join(request.runtime, 'editor_data')],
            timeoutMs: remaining,
            outputBytes: 256 * 1024,
            graphics: name !== 'import' && request.input.visible,
          },
          controller.signal,
          (pid) => send({ type: 'engine-process', pid }),
          name === 'playtest'
            ? {
                onLine: (line) => {
                  if (line.startsWith('LIGHTMAO_PLAYTEST_OBSERVATION:')) {
                    const raw = line.slice('LIGHTMAO_PLAYTEST_OBSERVATION:'.length);
                    if (raw.length <= 24000) {
                      try {
                        send({ type: 'playtest-observation', observation: JSON.parse(raw) });
                      } catch {}
                    }
                  }
                },
                subscribe: (write) => {
                  const handle = (raw: unknown) => {
                    const message = raw as { type?: string; actionId?: string; quit?: boolean };
                    if (
                      message.type === 'playtest-action' &&
                      (message.quit === true ||
                        (typeof message.actionId === 'string' &&
                          /^[\w-]{1,60}$/.test(message.actionId)))
                    )
                      write({ actionId: message.actionId, quit: message.quit === true });
                  };
                  process.on('message', handle);
                  return () => {
                    process.off('message', handle);
                  };
                },
              }
            : undefined,
        );
        const { errorCount, warningCount, diagnostics } = engineDiagnostics(
          result.stdout,
          result.stderr,
        );
        const value: EnginePhaseResult = {
          phase: {
            name,
            code: result.code,
            signal: result.signal,
            durationMs: result.durationMs,
            errorCount,
            warningCount,
          },
          stdout: result.stdout,
          stderr: result.stderr,
          diagnostics,
          reason: result.reason,
        };
        send({ type: 'phase', value });
        if (result.reason || result.code !== 0 || errorCount) {
          send({ type: 'done', reason: result.reason || 'engine_failed' });
          return;
        }
      }
      send({ type: 'done' });
    } catch (error) {
      send({
        type: 'done',
        reason: controller.signal.aborted ? 'cancelled' : 'worker_failed',
        error: error instanceof Error ? error.message : '引擎监督进程失败',
      });
    } finally {
      await executor?.close();
      if (process.connected) process.disconnect();
    }
  })();
  void active.catch(() => {
    process.exitCode = 1;
  });
});
