import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDecipheriv } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createApi } from '../apps/api/server.ts';
import { createLocalAgent } from '../apps/agent/server.ts';
import type {
  DeviceAuthorization,
  LocalBootstrap,
  LocalAuthorization,
  Run,
  Schedule,
  User,
} from '../packages/shared/types.ts';

test('durable task credentials survive access expiry/logout/restart; revocation pauses tasks until explicit reauthorization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lightmao-task-auth-'));
  let time = Date.now();
  const api = await createApi({
    dataDir: root,
    demo: true,
    auth: { now: () => time, accessTtlMs: 1000 },
  });
  await api.app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(api.app.server.address() as { port: number }).port}`;
  let local = await createLocalAgent({ dataDir: root, apiUrl: base, tickMs: 60000 });
  await local.app.listen({ host: '127.0.0.1', port: 0 });
  let localBase = `http://127.0.0.1:${(local.app.server.address() as { port: number }).port}`;
  async function call<T>(
    path: string,
    token = '',
    body?: unknown,
    method?: string,
    cookie?: string,
  ): Promise<{ data: T; cookie: string }> {
    const response = await fetch((path.startsWith('/local/') ? localBase : base) + path, {
      method: method || (body ? 'POST' : 'GET'),
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = await response.json();
    if (!response.ok)
      throw Object.assign(new Error(result.error), { status: response.status, code: result.code });
    return { data: result as T, cookie: (response.headers.get('set-cookie') || '').split(';')[0] };
  }
  async function settle(id: string, owner: string) {
    for (let i = 0; i < 100; i++) {
      const run = local.store.get<Run>('run', id, owner)!;
      if (run.status !== 'running') return run;
      await delay(20);
    }
    throw new Error('Task did not settle');
  }
  let targetCalls = 0;
  const other = createServer((_, res) => {
    targetCalls++;
    res.end('{}');
  });
  try {
    const first = await call<{ token: string; user: User }>('/api/auth/demo', '', {}),
      a = first.data;
    const observer = await call<{ token: string; user: User }>('/api/auth/demo', '', {});
    const project = (await call<LocalBootstrap>('/local/bootstrap', a.token)).data.projects[0];
    const task = (
      await call<Schedule>('/local/schedules', a.token, {
        name: 'Durable test',
        prompt: '检查项目',
        projectId: project.id,
        frequency: 'interval',
        time: '09:00',
        intervalMinutes: 60,
        timezone: 'UTC',
        mode: 'demo',
        enabled: true,
      })
    ).data;
    const credential = local.store.get<{ encrypted: string; grant: DeviceAuthorization }>(
      'backend-credential',
      a.user.id,
      a.user.id,
    )!;
    const key = await readFile(join(root, 'device.key')),
      buffer = Buffer.from(credential.encrypted, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12));
    decipher.setAuthTag(buffer.subarray(12, 28));
    const deviceToken = Buffer.concat([
      decipher.update(buffer.subarray(28)),
      decipher.final(),
    ]).toString();
    assert(!JSON.stringify(local.store.list('backend-credential')).includes(deviceToken));
    await assert.rejects(() => call('/local/bootstrap', deviceToken), {
      status: 403,
      code: 'DEVICE_SCOPE_DENIED',
    });
    assert(!JSON.stringify(local.store.list('credential')).includes(a.token));
    assert.equal((await stat(join(root, 'device.key'))).mode & 0o777, 0o600);
    const status = (await call<LocalAuthorization>('/local/authorization', a.token)).data;
    assert.equal(status.status, 'ready');
    assert(!JSON.stringify(status).includes(credential.encrypted));
    time += 1001;
    await assert.rejects(() => call('/api/me', a.token), { status: 401 });
    let dueSequence = 0;
    const due = () => {
      const t = local.store.get<Schedule & { ownerId: string }>('schedule', task.id, a.user.id)!;
      local.store.put('schedule', a.user.id, {
        ...t,
        enabled: true,
        nextRunAt: new Date(++dueSequence).toISOString(),
      });
    };
    due();
    await local.tick();
    let runs = local.store.list<Run>('run', a.user.id).filter((r) => r.taskId === task.id);
    assert.equal(runs.length, 1);
    assert.equal((await settle(runs[0].id, a.user.id)).status, 'completed');
    const refreshed = await call<{ token: string }>(
      '/api/auth/refresh',
      '',
      {},
      undefined,
      first.cookie,
    );
    await call('/api/logout', refreshed.data.token, {});
    due();
    await local.tick();
    runs = local.store.list<Run>('run', a.user.id).filter((r) => r.taskId === task.id);
    assert.equal(runs.length, 2);
    assert.equal((await settle(runs[1].id, a.user.id)).status, 'completed');
    const owner = (
      await call<{ token: string }>('/api/auth/refresh', '', {}, undefined, observer.cookie)
    ).data;
    await call(`/api/account/devices/${credential.grant.id}`, owner.token, undefined, 'DELETE');
    due();
    await local.tick();
    const paused = local.store.get<Schedule>('schedule', task.id, a.user.id)!;
    assert.equal(paused.authorization, 'required');
    assert.equal(paused.enabled, false);
    assert.equal(paused.lastStatus, 'authorization_required');
    assert.equal(
      local.store.list<Run>('run', a.user.id).filter((r) => r.taskId === task.id).length,
      2,
    );
    const session = (
      await call<{ id: string }>('/local/sessions', owner.token, { projectId: project.id })
    ).data;
    const attempt = (
      await call<Run>(`/local/sessions/${session.id}/runs`, owner.token, {
        prompt: '不应恢复被撤销授权',
        mode: 'demo',
      })
    ).data;
    assert.equal((await settle(attempt.id, a.user.id)).status, 'failed');
    assert(
      (await call<DeviceAuthorization[]>('/api/account/devices', owner.token)).data.find(
        (d) => d.id === credential.grant.id,
      )?.revokedAt,
    );
    const authorized = (
      await call<Schedule>(`/local/schedules/${task.id}/authorize`, owner.token, { enabled: true })
    ).data;
    assert.equal(authorized.authorization, 'ready');
    assert.equal(authorized.enabled, true);
    due();
    await local.tick();
    runs = local.store.list<Run>('run', a.user.id).filter((r) => r.taskId === task.id);
    assert.equal(runs.length, 3);
    assert.equal((await settle(runs[2].id, a.user.id)).status, 'completed');
    await local.app.close();
    local = await createLocalAgent({ dataDir: root, apiUrl: base, tickMs: 60000 });
    await local.app.listen({ host: '127.0.0.1', port: 0 });
    localBase = `http://127.0.0.1:${(local.app.server.address() as { port: number }).port}`;
    assert.equal(
      (await call<LocalAuthorization>('/local/authorization', owner.token)).data.deviceId,
      status.deviceId,
    );
    time += 1001;
    due();
    await local.tick();
    runs = local.store.list<Run>('run', a.user.id).filter((r) => r.taskId === task.id);
    assert.equal(runs.length, 4);
    assert.equal((await settle(runs[3].id, a.user.id)).status, 'completed');
    await local.app.close();
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
    local = await createLocalAgent({
      dataDir: root,
      apiUrl: `http://127.0.0.1:${(other.address() as { port: number }).port}`,
      tickMs: 60000,
    });
    due();
    await local.tick();
    assert.equal(targetCalls, 0, 'credentials for one backend must never be forwarded to another');
    assert.equal(
      local.store.get<Schedule>('schedule', task.id, a.user.id)!.authorization,
      'required',
    );
  } finally {
    await local.app.close();
    await api.app.close();
    if (other.listening) await new Promise<void>((r) => other.close(() => r()));
    await rm(root, { recursive: true, force: true });
  }
});
