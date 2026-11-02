import { IsolatedExecutor, type ExecutionPolicy } from './isolation.ts';

// Own only the proxy. The Agent launches and reaps the sandboxed process itself.
let executor: IsolatedExecutor | undefined;
let closing = false;
async function close() {
  closing = true;
  await executor?.close();
  if (process.connected) process.disconnect();
}
process.once('disconnect', () => void close());
process.once('SIGTERM', () => void close());
process.once('message', (data: unknown) => {
  void (async () => {
    const request = data as {
      command: string;
      args: string[];
      policy: ExecutionPolicy;
      scratch: string;
      dataDir: string;
    };
    executor = new IsolatedExecutor(request.dataDir, {
      domains: request.policy.domains || [],
    });
    try {
      const status = await executor.ready();
      if (!status.available) throw new Error(status.error || '隔离代理不可用');
      if (closing) return;
      const wrapped = await executor.prepare(
        request.command,
        request.args,
        request.policy,
        request.scratch,
      );
      if (!closing) process.send?.({ wrapped });
    } catch (error) {
      if (process.connected)
        process.send?.({ error: error instanceof Error ? error.message : '隔离代理启动失败' });
      await close();
    }
  })();
});
