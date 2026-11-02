import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, stat, rename, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createApi } from '../apps/api/server.ts';
import { createLocalAgent } from '../apps/agent/server.ts';
import type {
  Project,
  ProjectDirectoryGrant,
  Run,
  RunEvent,
  Session,
  Schedule,
} from '../packages/shared/types.ts';

test('native project actions reject another window, subframe, origin and arbitrary renderer paths before opening a picker', async () => {
  const require = createRequire(import.meta.url);
  const { registerDesktopActions } = require('../apps/desktop/actions.cjs');
  const handlers = new Map<
    string,
    (event: unknown, input: unknown) => Promise<{ status: number }>
  >();
  const frame = { url: 'http://127.0.0.1:9000/' },
    contents = { mainFrame: frame };
  let dialogs = 0;
  registerDesktopActions({
    ipcMain: {
      handle: (name: string, fn: (event: unknown, input: unknown) => Promise<{ status: number }>) =>
        handlers.set(name, fn),
    },
    win: { webContents: contents },
    dialog: {
      showOpenDialog: () => {
        dialogs++;
      },
    },
    shell: {},
    origin: 'http://127.0.0.1:9000',
    agentBase: 'http://127.0.0.1:9001',
    dataDir: '/not-used',
  });
  for (const handler of handlers.values()) {
    await assert.rejects(() => handler({ sender: {}, senderFrame: frame }, {}), /Untrusted/);
    await assert.rejects(
      () => handler({ sender: contents, senderFrame: { url: frame.url } }, {}),
      /Untrusted/,
    );
    frame.url = 'https://untrusted.example/';
    await assert.rejects(() => handler({ sender: contents, senderFrame: frame }, {}), /Untrusted/);
    frame.url = 'http://127.0.0.1:9000/';
  }
  const result = await handlers.get('lightmao:select-project-directory')!(
    { sender: contents, senderFrame: frame },
    { token: 'a'.repeat(32), access: 'write', directory: '/etc' },
  );
  assert.equal(result.status, 400);
  assert.equal(dialogs, 0);
  const executable = await handlers.get('lightmao:open-project-document')!(
    { sender: contents, senderFrame: frame },
    { token: 'a'.repeat(32), projectId: '00000000-0000-4000-8000-000000000000', path: 'script.py' },
  );
  assert.equal(executable.status, 400);
});

test('native directory grants enforce owner, read-only tools, idempotent import, revocation, archive and durable reconnection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lightmao-projects-'));
  const dataDir = join(root, 'runtime'),
    folder = join(root, 'games', 'Forest');
  await mkdir(folder, { recursive: true });
  await mkdir(join(folder, 'scripts'));
  await writeFile(join(folder, 'project.godot'), 'config_version=5\n');
  await writeFile(join(folder, 'scripts', 'player.gd'), 'extends Node\n');
  await writeFile(join(folder, 'README.md'), '# Existing game\n');
  const canonicalFolder = await realpath(folder);
  const api = await createApi({ dataDir, demo: true, permissionMode: 'custom' });
  await api.app.listen({ host: '127.0.0.1', port: 0 });
  const apiBase = `http://127.0.0.1:${(api.app.server.address() as { port: number }).port}`;
  let local = await createLocalAgent({ dataDir, apiUrl: apiBase, tickMs: 3600000 });
  const first = (
    await api.app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} })
  ).json<{ token: string; user: { id: string } }>();
  const other = (
    await api.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        name: 'Other',
        email: 'other-project@example.test',
        password: 'project-fixture-password',
      },
    })
  ).json<{ token: string; user: { id: string } }>();
  const key = (await readFile(join(dataDir, 'desktop-control.key'))).toString('hex');
  const call = (
    url: string,
    payload?: unknown,
    method?: 'POST' | 'PATCH' | 'GET',
    token = first.token,
    native = false,
  ) =>
    local.app.inject({
      method: method || (payload === undefined ? 'GET' : 'POST'),
      url,
      payload: payload === undefined ? undefined : JSON.stringify(payload),
      headers: {
        Authorization: `Bearer ${token}`,
        ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(native ? { 'X-Lightmao-Desktop-Key': key } : {}),
      },
    });
  const grant = async (access: 'read' | 'write', projectId?: string, directory = folder) => {
    const response = await call(
      '/local/project-grants',
      { directory, access, projectId },
      'POST',
      first.token,
      true,
    );
    assert.equal(response.statusCode, 200, response.body);
    return response.json<ProjectDirectoryGrant>();
  };
  const settle = async (id: string) => {
    for (let i = 0; i < 150; i++) {
      const run = local.store.get<Run>('run', id, first.user.id)!;
      if (run.status !== 'running') return run;
      await delay(20);
    }
    throw new Error('Run did not settle');
  };
  try {
    await call('/local/bootstrap');
    assert.equal((await stat(join(dataDir, 'desktop-control.key'))).mode & 0o777, 0o600);
    assert.equal(
      (await call('/local/project-grants', { directory: folder, access: 'write' })).statusCode,
      403,
    );
    const selected = await grant('read');
    assert.equal(selected.engine, 'Godot');
    assert.equal(selected.access, 'read');
    assert(!JSON.stringify(local.store.list('project-grant')).includes(selected.grantId));
    assert.equal(
      (
        await call(
          '/local/projects/import',
          { name: 'Unauthorized', grantId: selected.grantId },
          'POST',
          other.token,
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await call('/local/projects/import', {
          name: 'Raw path',
          root: folder,
          grantId: selected.grantId,
        })
      ).statusCode,
      400,
    );
    const imports = await Promise.all(
      [1, 2].map(() =>
        call('/local/projects/import', { name: 'Imported Forest', grantId: selected.grantId }),
      ),
    );
    assert(imports.every((r) => r.statusCode === 200));
    const project = imports[0].json<Project>();
    assert.equal(imports[1].json<Project>().id, project.id);
    assert.equal(project.root, canonicalFolder);
    assert.equal(project.source, 'imported');
    assert.equal(project.access, 'read');
    const expired = await grant('read', project.id);
    const expiredId = createHash('sha256').update(expired.grantId).digest('hex');
    const expiredRecord = local.store.get<{ id: string; expiresAt: string }>(
      'project-grant',
      expiredId,
      first.user.id,
    )!;
    local.store.put('project-grant', first.user.id, {
      ...expiredRecord,
      expiresAt: new Date(0).toISOString(),
    });
    assert.equal(
      (await call(`/local/projects/${project.id}/connect`, { grantId: expired.grantId }))
        .statusCode,
      409,
    );
    assert.equal(
      (
        await call(
          '/local/project-grants',
          { directory: folder, access: 'read' },
          'POST',
          other.token,
          true,
        )
      ).statusCode,
      409,
    );
    assert.equal(await readFile(join(folder, 'README.md'), 'utf8'), '# Existing game\n');
    assert.equal(
      (await call(`/local/projects/${project.id}`, { access: 'write' }, 'PATCH')).statusCode,
      400,
    );
    assert.equal(
      (await call(`/local/projects/${project.id}/files`, undefined, 'GET', other.token)).statusCode,
      404,
    );
    assert.equal(
      (await call(`/local/projects/${project.id}/files?path=scripts`)).json<{ name: string }[]>()[0]
        .name,
      'player.gd',
    );
    assert.equal((await call(`/local/projects/${project.id}/native-target`, {})).statusCode, 403);
    const target = await call(
      `/local/projects/${project.id}/native-target`,
      { path: 'scripts/player.gd' },
      'POST',
      first.token,
      true,
    );
    assert.equal(target.json<{ path: string }>().path, join(canonicalFolder, 'scripts/player.gd'));
    const overlap = await call(
      '/local/project-grants',
      { directory: join(folder, 'scripts'), access: 'read' },
      'POST',
      first.token,
      true,
    );
    assert.equal(overlap.statusCode, 409);
    await api.app.inject({
      method: 'PATCH',
      url: '/api/plugins/writer',
      headers: { Authorization: `Bearer ${first.token}` },
      payload: { installed: true, enabled: true },
    });
    const session = (await call('/local/sessions', { projectId: project.id })).json<Session>();
    const run = (
      await call(`/local/sessions/${session.id}/runs`, {
        prompt: 'Inspect imported game',
        mode: 'demo',
      })
    ).json<Run>();
    assert.equal((await settle(run.id)).status, 'completed');
    const context = local.store
      .list<RunEvent>('event', first.user.id)
      .find((e) => e.runId === run.id && e.type === 'context.loaded')!;
    assert(
      !(context.data.tools as string[]).includes('write_file'),
      'read-only import must remove the write tool even when the plugin is enabled',
    );
    const task = (
      await call('/local/schedules', {
        projectId: project.id,
        name: 'Project check',
        prompt: 'Inspect',
        frequency: 'interval',
        intervalMinutes: 60,
        time: '09:00',
        timezone: 'UTC',
        mode: 'demo',
        enabled: true,
      })
    ).json<Schedule>();
    const attempts = await Promise.all(
      [1, 2, 3].map(() =>
        call(`/local/sessions/${session.id}/runs`, { prompt: 'Inspect again', mode: 'demo' }),
      ),
    );
    assert.deepEqual(attempts.map((r) => r.statusCode).sort(), [200, 409, 409]);
    const second = attempts.find((r) => r.statusCode === 200)!.json<Run>();
    const reconnect = await grant('write', project.id);
    assert.equal(
      (await call(`/local/projects/${project.id}/connect`, { grantId: reconnect.grantId }))
        .statusCode,
      409,
      'directory replacement must wait for active work',
    );
    assert.equal(
      (await call(`/local/projects/${project.id}`, { status: 'archived' }, 'PATCH')).statusCode,
      200,
    );
    assert.equal((await settle(second.id)).status, 'cancelled');
    assert.equal(local.store.get<Schedule>('schedule', task.id, first.user.id)!.enabled, false);
    assert.equal((await call(`/local/projects/${project.id}/file?path=README.md`)).statusCode, 409);
    assert.equal((await call(`/local/sessions/${session.id}`)).json<Session>().messages.length, 4);
    assert.equal((await call('/local/sessions', { projectId: project.id })).statusCode, 409);
    assert.equal(
      (
        await call(
          `/local/projects/${project.id}`,
          { status: 'active', name: 'Renamed Forest' },
          'PATCH',
        )
      ).statusCode,
      200,
    );
    const writable = await call(`/local/projects/${project.id}/connect`, {
      grantId: reconnect.grantId,
    });
    assert.equal(writable.json<Project>().access, 'write');
    assert.equal(
      local.store.get<Schedule>('schedule', task.id, first.user.id)!.enabled,
      false,
      'restoring a project never silently enables its schedules',
    );
    await call(`/local/projects/${project.id}`, { access: 'revoked' }, 'PATCH');
    assert.equal((await call(`/local/projects/${project.id}/files`)).statusCode, 403);
    assert.equal(
      (
        await call(`/local/projects/${project.id}/connect`, { grantId: reconnect.grantId })
      ).json<Project>().access,
      'revoked',
      'replaying a consumed grant cannot restore revoked access',
    );
    const fresh = await grant('read', project.id);
    await call(`/local/projects/${project.id}/connect`, { grantId: fresh.grantId });
    await local.app.close();
    local = await createLocalAgent({ dataDir, apiUrl: apiBase, tickMs: 3600000 });
    assert.equal((await call(`/local/projects/${project.id}/files`)).statusCode, 200);
    assert.equal(
      (await call(`/local/bootstrap`))
        .json<{ projects: Project[] }>()
        .projects.find((p) => p.id === project.id)!.name,
      'Renamed Forest',
    );
    await rename(folder, `${folder}-moved`);
    await mkdir(folder);
    await writeFile(join(folder, 'README.md'), 'replacement directory');
    assert.equal(
      (await call(`/local/projects/${project.id}/file?path=README.md`)).statusCode,
      409,
      'replacing a directory at the same path requires new authorization',
    );
    const moved = await grant('read', project.id, `${folder}-moved`);
    await call(`/local/projects/${project.id}/connect`, { grantId: moved.grantId });
    assert.equal(
      (await call(`/local/projects/${project.id}/file?path=README.md`)).json<{ text: string }>()
        .text,
      '# Existing game\n',
    );
  } finally {
    await local.app.close();
    await api.app.close();
    await rm(root, { recursive: true, force: true });
  }
});
