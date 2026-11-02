import { randomUUID } from 'node:crypto';
import { Store } from '../../packages/shared/store.ts';

/** One daemon per local database. Live or uninspectable owners are never stolen. */
export function acquireRuntimeLease(store: Store) {
  const instanceId = randomUUID();
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const previous = store.get<{ id: string; pid: number; instanceId: string }>(
      'runtime-lease',
      'agent',
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
        throw Object.assign(
          new Error('此数据目录已有本地 Agent 运行，请连接现有服务；未接管其任务或历史。'),
          { statusCode: 409, code: 'AGENT_ALREADY_RUNNING' },
        );
    }
    store.put('runtime-lease', 'system', {
      id: 'agent',
      pid: process.pid,
      instanceId,
      acquiredAt: new Date().toISOString(),
    });
    store.db.exec('COMMIT');
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
  return () => {
    if (
      store.get<{ id: string; instanceId: string }>('runtime-lease', 'agent', 'system')
        ?.instanceId === instanceId
    )
      store.remove('runtime-lease', 'agent', 'system');
  };
}
