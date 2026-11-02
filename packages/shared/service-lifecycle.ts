/** Both standalone Node and Electron utility processes must finish database cleanup. */
export function installServiceShutdown(close: () => Promise<unknown>) {
  let stopping: Promise<void> | undefined;
  const stop = () => {
    if (!stopping) {
      console.log('LightMao service stopping');
      stopping = close().then(
        () => {
          console.log('LightMao service stopped');
          process.exit(0);
        },
        () => {
          console.error('Service shutdown did not finish cleanly');
          process.exit(1);
        },
      );
    }
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, stop);
  const parentPort = (
    process as NodeJS.Process & {
      parentPort?: { on: (name: 'message', listener: (event: { data: unknown }) => void) => void };
    }
  ).parentPort;
  parentPort?.on('message', ({ data }) => {
    if (data && typeof data === 'object' && 'type' in data && data.type === 'lightmao:shutdown')
      stop();
  });
}
