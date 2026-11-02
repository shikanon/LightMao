import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Store } from '../../packages/shared/store.ts';

/** Single-instance deployment: never change another live API's accounting. */
export function acquireApiLease(dataDir: string) {
  const store = new Store(join(dataDir, 'server.sqlite'));
  const instanceId = randomUUID();
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const previous = store.get<{ id: string; pid: number }>(
      'server-runtime-lease',
      'api',
      'system',
    );
    if (previous) {
      let alive = true;
      if (Number.isSafeInteger(previous.pid) && previous.pid > 0) {
        try {
          process.kill(previous.pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
        }
      }
      if (alive)
        throw Error(
          'This data directory already has a live API; no existing request was recovered or taken over',
        );
    }
    store.put('server-runtime-lease', 'system', {
      id: 'api',
      pid: process.pid,
      instanceId,
      acquiredAt: new Date().toISOString(),
    });
    store.db.exec('COMMIT');
  } catch (error) {
    store.db.exec('ROLLBACK');
    store.close();
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (
      store.get<{ id: string; instanceId: string }>('server-runtime-lease', 'api', 'system')
        ?.instanceId === instanceId
    )
      store.remove('server-runtime-lease', 'api', 'system');
    store.close();
  };
}
