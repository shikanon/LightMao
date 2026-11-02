import { createApi } from './server.ts';
import { apiRuntime } from './config.ts';
import { acquireApiLease } from './lease.ts';
import type { Usage } from '../../packages/shared/types.ts';
import { installServiceShutdown } from '../../packages/shared/service-lifecycle.ts';

// Production is configured by the service manager / Node --env-file. It must
// never silently load a .env from whichever directory launched the release.
if (process.env.LIGHTMAO_ENV_FILE) {
  try {
    process.loadEnvFile(process.env.LIGHTMAO_ENV_FILE);
  } catch {
    throw new Error('Unable to load LIGHTMAO_ENV_FILE');
  }
} else if (process.env.NODE_ENV !== 'production') {
  try {
    process.loadEnvFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error('Unable to load API development environment file');
  }
}
const runtime = apiRuntime(process.env);
const release = acquireApiLease(runtime.options.dataDir);
let service: Awaited<ReturnType<typeof createApi>> | undefined;
try {
  service = await createApi(runtime.options);
  // A dead process's results are unknown; they are never replayed or charged as
  // completed. Only the proven sole owner may recover these durable receipts.
  for (const value of service.store.list<Usage>('usage'))
    if (value.status === 'running') {
      const recovered = { ...value, status: 'interrupted' };
      delete recovered.failureReason;
      service.store.put('usage', 'system', recovered);
    }
  await service.app.listen(runtime.listen);
  console.log(`LightMao API: ${service.app.listeningOrigin}`);
  installServiceShutdown(async () => {
    await service!.app.close();
    release();
  });
} catch (error) {
  await service?.app.close().catch(() => {});
  release();
  throw error;
}
