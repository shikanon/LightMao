import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  access,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  symlink,
  unlink,
  open,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createApi } from '../apps/api/server.ts';
import { createLocalAgent } from '../apps/agent/server.ts';
import { engineRunSchema, engineDiagnostics } from '../apps/agent/engine-runner.ts';
import type {
  EngineConnection,
  EngineGrant,
  EngineJob,
  Project,
} from '../packages/shared/types.ts';

const godotPath =
  process.env.LIGHTMAO_TEST_GODOT_PATH || resolve('.lightmao/tools/godot/4.7.2/Godot.app');
let realGodot = process.platform === 'darwin';
try {
  await access(godotPath);
} catch {
  realGodot = false;
}
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
test('engine commands reject arbitrary paths/arguments and distinguish real project errors from the exact offline CA warning', () => {
  const base = { action: 'script', script: 'tests/smoke.gd', requestId: 'fixture' };
  assert.equal(engineRunSchema.parse(base).frames, 180);
  for (const value of [
    { ...base, script: '../private.gd' },
    { ...base, script: '/tmp/code.gd' },
    { ...base, script: 'a\\b.gd' },
    { ...base, action: 'shell' },
    { ...base, argv: ['--editor'] },
    { ...base, frames: 0 },
    { ...base, timeoutSeconds: 121 },
  ])
    assert.throws(() => engineRunSchema.parse(value));
  assert.equal(engineDiagnostics('', 'ERROR: game failure\nSCRIPT ERROR: broken\n').errorCount, 2);
  const special = engineDiagnostics(
    '',
    'ERROR: Condition "ret != noErr" is true. Returning: ""\n   at: get_system_ca_certificates (platform/macos/os_macos.mm:1035)\n',
  );
  assert.equal(special.errorCount, 0);
  assert.equal(special.warningCount, 1);
  assert.equal(
    engineDiagnostics(
      '',
      'ERROR: Condition "ret != noErr" is true. Returning: ""\n   at: user_script (res://game.gd:1)',
    ).errorCount,
    1,
  );
});

test(
  'actual Godot connection, immutable project copies, errors, cancellation, isolation and durable receipts',
  { skip: !realGodot, timeout: 120000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'lightmao-engines-'));
    const api = await createApi({ dataDir: root, demo: true });
    await api.app.listen({ host: '127.0.0.1', port: 0 });
    const options = {
      dataDir: root,
      apiUrl: `http://127.0.0.1:${(api.app.server.address() as { port: number }).port}`,
      godotPath,
    };
    let local = await createLocalAgent(options);
    const owner = (
      await api.app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} })
    ).json<{ token: string; user: { id: string } }>();
    const other = (
      await api.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          name: 'Engine other',
          email: 'engine-other@example.test',
          password: 'Engine-fixture-other-2026',
        },
      })
    ).json<{ token: string; user: { id: string } }>();
    async function call(
      path: string,
      body?: unknown,
      method?: 'POST' | 'PATCH' | 'DELETE',
      token = owner.token,
      extra = {},
    ) {
      return (path.startsWith('/api/') ? api.app : local.app).inject({
        method: method || (body ? 'POST' : 'GET'),
        url: path,
        headers: { authorization: `Bearer ${token}`, ...extra },
        ...(body ? { payload: body } : {}),
      });
    }
    async function good<T>(
      path: string,
      body?: unknown,
      method?: 'POST' | 'PATCH' | 'DELETE',
      extra = {},
    ) {
      const response = await call(path, body, method, owner.token, extra);
      assert(response.statusCode < 300, response.body);
      return response.json<T>();
    }
    async function until(
      check: () => boolean | Promise<boolean>,
      message: string,
      timeout = 10000,
    ) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await check()) return;
        await delay(30);
      }
      throw new Error(message);
    }
    const project = await good<Project>('/local/projects', {
      name: 'Actual Godot fixture',
      engine: 'Godot',
      description: 'Own temporary game',
    });
    const base = `/local/projects/${project.id}`;
    await cp(resolve('examples/godot-startrail'), project.root, { recursive: true });
    await writeFile(join(project.root, '.env'), 'ENGINE_SOURCE_PRIVATE_CANARY');
    const initial = sha(await readFile(join(project.root, 'state.gd')));
    let connection: EngineConnection, completed: EngineJob;
    try {
      await t.test(
        'cloud installation is insufficient; native path grant is private and confirmation is owner scoped and idempotent',
        async () => {
          assert.equal(
            (await call('/local/engine-file-grants', { projectId: project.id, path: godotPath }))
              .statusCode,
            403,
          );
          assert.equal(
            (await call(base + '/engine-jobs', { action: 'validate', requestId: randomUUID() }))
              .statusCode,
            403,
          );
          await good('/api/plugins/godot', { installed: true, enabled: true }, 'PATCH');
          assert.equal(
            (await call(base + '/engine-jobs', { action: 'validate', requestId: randomUUID() }))
              .statusCode,
            403,
          );
          const preview = await good<EngineGrant>(base + '/engine/prepare', {});
          assert.match(preview.version, /^4\./);
          assert.equal(
            (await call(base + '/engine', { grantId: preview.grantId }, 'POST', other.token))
              .statusCode,
            403,
          );
          connection = await good<EngineConnection>(base + '/engine', { grantId: preview.grantId });
          assert.equal(connection.enabled, true);
          assert.equal(connection.needsAuthorization, false);
          assert.equal(
            (await good<EngineConnection>(base + '/engine', { grantId: preview.grantId })).revision,
            connection.revision,
          );
          assert(!JSON.stringify(connection).includes('executable"'));
        },
      );
      await t.test(
        'real resource import and scene run use a fingerprinted copy and leave the original files and cache unchanged',
        async () => {
          const job = await good<EngineJob>(base + '/engine-jobs', {
            action: 'run',
            frames: 10,
            requestId: randomUUID(),
          });
          completed = await local.engines.wait(owner.user.id, job.id);
          assert.equal(completed.status, 'completed', JSON.stringify(completed));
          assert.equal(completed.verification, 'process_only');
          assert.deepEqual(
            completed.phases.map((phase) => phase.name),
            ['import', 'run'],
          );
          assert(completed.phases.every((phase) => phase.errorCount === 0 && phase.code === 0));
          assert(completed.snapshot!.excludedCount >= 1);
          const inputs = await good<{ items: { path: string }[] }>(
            `/local/engine-jobs/${job.id}/inputs`,
          );
          assert(!inputs.items.some((file) => file.path === '.env'));
          assert.equal(sha(await readFile(join(project.root, 'state.gd'))), initial);
          await assert.rejects(access(join(project.root, '.godot')));
          await assert.rejects(access(join(project.root, 'lightmao_artifacts')));
          const log = local.engines.logs(owner.user.id, job.id, { limit: 4000 });
          assert(log.text.includes('LIGHTMAO_SCENE_READY'));
          assert(!log.text.includes('ENGINE_SOURCE_PRIVATE_CANARY'));
        },
      );
      await t.test(
        'real project test script reports six assertions and produces exact authenticated artifacts',
        async () => {
          const job = await good<EngineJob>(base + '/engine-jobs', {
            action: 'script',
            script: 'tests/smoke.gd',
            requestId: randomUUID(),
          });
          const result = await local.engines.wait(owner.user.id, job.id);
          assert.equal(result.status, 'completed', JSON.stringify(result));
          assert.equal(result.verification, 'tests_passed');
          const report = result.artifacts.find((file) => file.path === 'test-results.json')!;
          const response = await call(`/local/engine-jobs/${job.id}/artifacts/${report.id}`);
          assert.equal(response.statusCode, 200);
          assert.equal(sha(response.rawPayload), report.sha256);
          assert.equal(JSON.parse(response.body).tests.length, 6);
          assert.equal(
            (await call(`/local/engine-jobs/${job.id}`, undefined, undefined, other.token))
              .statusCode,
            404,
          );
          assert.equal(
            (
              await call(
                `/local/engine-jobs/${job.id}/artifacts/${report.id}`,
                undefined,
                undefined,
                other.token,
              )
            ).statusCode,
            404,
          );
          const input = local.store.get<{ files: unknown[] }>(
            'engine-input',
            job.id,
            owner.user.id,
          )!;
          assert(input.files.length >= 6);
          const blob = join(
            root,
            'engine-jobs',
            sha(owner.user.id),
            job.id,
            'artifacts',
            report.sha256,
          );
          const original = await readFile(blob);
          await writeFile(blob, 'tampered');
          assert.equal(
            (await call(`/local/engine-jobs/${job.id}/artifacts/${report.id}`)).statusCode,
            409,
          );
          await writeFile(blob, original);
        },
      );
      await t.test(
        'request retries are concurrent and idempotent, and database failure cannot dispatch an unrecorded engine job',
        async () => {
          const input = { action: 'validate', requestId: randomUUID() };
          const values = await Promise.all(
            Array.from({ length: 4 }, () => good<EngineJob>(base + '/engine-jobs', input)),
          );
          assert.equal(new Set(values.map((value) => value.id)).size, 1);
          assert.equal((await local.engines.wait(owner.user.id, values[0].id)).status, 'completed');
          assert.equal(
            (await call(base + '/engine-jobs', { ...input, action: 'run' })).statusCode,
            409,
          );
          const count = local.store.list('engine-job', owner.user.id).length;
          const original = local.store.put.bind(local.store);
          local.store.put = ((kind, owner, value) => {
            if (kind === 'engine-request') throw new Error('engine journal fixture failure');
            return original(kind, owner, value);
          }) as typeof local.store.put;
          try {
            assert.equal(
              (await call(base + '/engine-jobs', { action: 'validate', requestId: randomUUID() }))
                .statusCode,
              500,
            );
          } finally {
            local.store.put = original;
          }
          assert.equal(local.store.list('engine-job', owner.user.id).length, count);
          assert.equal(local.engines.activeForProject(owner.user.id, project.id), false);
        },
      );
      await t.test(
        'known project errors fail even when Godot exits zero; symlinks are rejected before engine execution',
        async () => {
          await writeFile(
            join(project.root, 'tests/failure.gd'),
            'extends SceneTree\nfunc _init():\n\tpush_error("EXPECTED_ENGINE_ERROR")\n\tquit(0)\n',
          );
          const job = await good<EngineJob>(base + '/engine-jobs', {
            action: 'script',
            script: 'tests/failure.gd',
            requestId: randomUUID(),
          });
          const failed = await local.engines.wait(owner.user.id, job.id);
          assert.equal(failed.status, 'failed');
          assert(
            failed.phases.some(
              (phase) => phase.name === 'script' && phase.code === 0 && phase.errorCount > 0,
            ),
          );
          assert(failed.diagnostics.some((line) => line.includes('EXPECTED_ENGINE_ERROR')));
          await symlink(join(root, 'server.sqlite'), join(project.root, 'bad-link'));
          const bad = await good<EngineJob>(base + '/engine-jobs', {
            action: 'validate',
            requestId: randomUUID(),
          });
          const rejected = await local.engines.wait(owner.user.id, bad.id);
          assert.equal(rejected.status, 'failed');
          assert.equal(rejected.phases.length, 0);
          await unlink(join(project.root, 'bad-link'));
        },
      );
      await t.test(
        'stop terminates an actual running script and timeout does not treat frame limits as a watchdog',
        async () => {
          await writeFile(
            join(project.root, 'tests/loop.gd'),
            'extends SceneTree\nfunc _init():\n\twhile true:\n\t\tpass\n',
          );
          const job = await good<EngineJob>(base + '/engine-jobs', {
            action: 'script',
            script: 'tests/loop.gd',
            requestId: randomUUID(),
          });
          let enginePid = 0;
          await until(
            () => {
              const record = local.store.get<EngineJob & { workerPid?: number }>(
                'engine-job',
                job.id,
                owner.user.id,
              )!;
              if (record.stage !== 'script' || !record.workerPid) return false;
              try {
                const children = execFileSync('pgrep', ['-P', String(record.workerPid)], {
                  encoding: 'utf8',
                })
                  .trim()
                  .split(/\s+/)
                  .map(Number);
                for (const pid of children) {
                  const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
                    encoding: 'utf8',
                  });
                  if (command.includes('tests/loop.gd')) {
                    enginePid = pid;
                    return true;
                  }
                }
              } catch {}
              return false;
            },
            'Actual loop script did not start',
            25000,
          );
          await good(`/local/engine-jobs/${job.id}/stop`, {});
          assert.equal((await local.engines.wait(owner.user.id, job.id)).status, 'cancelled');
          assert.throws(() => process.kill(enginePid, 0), { code: 'ESRCH' });
          const timeout = await good<EngineJob>(base + '/engine-jobs', {
            action: 'script',
            script: 'tests/loop.gd',
            timeoutSeconds: 10,
            requestId: randomUUID(),
          });
          const timedOut = await local.engines.wait(owner.user.id, timeout.id);
          assert.equal(timedOut.status, 'failed', JSON.stringify(timedOut));
          assert.equal(timedOut.code, 'timeout');
          assert(
            timedOut.phases.some((phase) => phase.name === 'script' && phase.signal === 'SIGKILL'),
          );
        },
      );
      await t.test(
        'engine code cannot read the source or private files, inherit host secrets, write outside its copy, fork, or connect to a local server',
        async () => {
          let connections = 0;
          const listener = createServer((socket) => {
            connections++;
            socket.destroy();
          });
          await new Promise<void>((done) => listener.listen(0, '127.0.0.1', done));
          const port = (listener.address() as { port: number }).port;
          const outside = join(root, 'outside-canary.txt'),
            sourceWrite = join(project.root, 'outside-write.txt');
          await writeFile(outside, 'HOST_FILE_SHOULD_STAY_PRIVATE');
          process.env.LIGHTMAO_TEST_ENGINE_SECRET = 'HOST_ENV_SHOULD_STAY_PRIVATE';
          await writeFile(
            join(project.root, 'tests/isolation.gd'),
            `extends SceneTree
func _init():
\tcall_deferred("verify")
func verify():
\tvar secret_read = FileAccess.file_exists("res://.env")
\tvar source_read = FileAccess.file_exists(${JSON.stringify(join(project.root, 'state.gd'))})
\tvar outside_read = FileAccess.file_exists(${JSON.stringify(outside)})
\tvar host_write = FileAccess.open(${JSON.stringify(sourceWrite)}, FileAccess.WRITE)
\tvar fork_output = []
\tvar fork_exit = OS.execute("/bin/echo", ["MUST_NOT_RUN"], fork_output)
\tvar self_output = []
\tvar self_exit = OS.execute(OS.get_executable_path(), ["--version"], self_output)
\tvar peer = StreamPeerTCP.new()
\tpeer.connect_to_host("127.0.0.1", ${port})
\tawait create_timer(0.2).timeout
\tpeer.poll()
\tvar connected = peer.get_status() == StreamPeerTCP.STATUS_CONNECTED
\tvar save = FileAccess.open("user://saved.txt", FileAccess.WRITE)
\tvar output = {"secretRead":secret_read,"sourceRead":source_read,"outsideRead":outside_read,"hostWrite":host_write != null,"forkExit":fork_exit,"forkOutput":fork_output,"selfExit":self_exit,"selfOutput":self_output,"connected":connected,"hostEnvironment":OS.get_environment("LIGHTMAO_TEST_ENGINE_SECRET"),"saveWorks":save != null}
\tDirAccess.make_dir_recursive_absolute("res://lightmao_artifacts")
\tvar report = FileAccess.open("res://lightmao_artifacts/isolation.json",FileAccess.WRITE)
\treport.store_string(JSON.stringify(output))
\treport.close()
\tquit(0)
`,
          );
          try {
            const job = await good<EngineJob>(base + '/engine-jobs', {
              action: 'script',
              script: 'tests/isolation.gd',
              requestId: randomUUID(),
            });
            const result = await local.engines.wait(owner.user.id, job.id);
            const report = result.artifacts.find((file) => file.path === 'isolation.json');
            assert(report, JSON.stringify(result));
            const bytes = await local.engines.artifact(owner.user.id, job.id, report.id);
            const { forkExit, forkOutput, selfExit, selfOutput, ...evidence } = JSON.parse(
              bytes.bytes.toString(),
            );
            assert.notEqual(forkExit, 0);
            assert.notEqual(selfExit, 0);
            assert.equal(forkOutput.join(''), '');
            assert.equal(selfOutput.join(''), '');
            assert.deepEqual(evidence, {
              secretRead: false,
              sourceRead: false,
              outsideRead: false,
              hostWrite: false,
              connected: false,
              hostEnvironment: '',
              saveWorks: true,
            });
            assert.equal(connections, 0);
            await assert.rejects(access(sourceWrite));
            assert.equal(sha(await readFile(join(project.root, 'state.gd'))), initial);
          } finally {
            delete process.env.LIGHTMAO_TEST_ENGINE_SECRET;
            await new Promise<void>((done) => listener.close(() => done()));
          }
        },
      );
      await t.test(
        'supervisor crash leaves an interrupted receipt and the Agent reaps the specifically recorded engine process',
        async () => {
          const job = await good<EngineJob>(base + '/engine-jobs', {
            action: 'script',
            script: 'tests/loop.gd',
            requestId: randomUUID(),
          });
          let record: EngineJob & { workerPid?: number; enginePid?: number };
          await until(
            () => {
              record = local.store.get('engine-job', job.id, owner.user.id)!;
              return record.stage === 'script' && !!record.workerPid && !!record.enginePid;
            },
            'Supervisor did not launch the script',
            25000,
          );
          process.kill(record!.workerPid!, 'SIGKILL');
          const interrupted = await local.engines.wait(owner.user.id, job.id);
          assert.equal(interrupted.status, 'interrupted');
          assert.equal(interrupted.code, 'ENGINE_WORKER_INTERRUPTED');
          try {
            const state = execFileSync('ps', ['-p', String(record!.enginePid), '-o', 'stat='], {
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'ignore'],
            }).trim();
            assert(state.startsWith('Z'), 'A live engine survived supervisor failure');
          } catch (error) {
            if ((error as { status?: number }).status !== 1) throw error;
          }
          assert.equal(
            local.store
              .list<EngineJob>('engine-job', owner.user.id)
              .filter((value) => value.id === job.id).length,
            1,
          );
        },
      );
      await t.test(
        'expired, changed binary and failed grant commits cannot activate a new runtime',
        async () => {
          const expired = await good<EngineGrant>(base + '/engine/prepare', {});
          const stored = local.store.get<{ id: string; expiresAt: string }>(
            'engine-grant',
            sha(expired.grantId),
            owner.user.id,
          )!;
          local.store.put('engine-grant', owner.user.id, {
            ...stored,
            expiresAt: new Date(0).toISOString(),
          });
          assert.equal(
            (await call(base + '/engine', { grantId: expired.grantId })).statusCode,
            409,
          );
          const preview = await good<EngineGrant>(base + '/engine/prepare', {});
          const revision = (await good<EngineConnection>(base + '/engine')).revision;
          const original = local.store.put.bind(local.store);
          local.store.put = ((kind, owner, value) => {
            if (kind === 'engine-grant') throw new Error('Grant fixture commit failure');
            return original(kind, owner, value);
          }) as typeof local.store.put;
          try {
            assert.equal(
              (await call(base + '/engine', { grantId: preview.grantId })).statusCode,
              500,
            );
          } finally {
            local.store.put = original;
          }
          assert.equal((await good<EngineConnection>(base + '/engine')).revision, revision);
          assert.equal(
            local.store.get<{ used?: boolean }>(
              'engine-grant',
              sha(preview.grantId),
              owner.user.id,
            )!.used,
            undefined,
          );
          const copy = join(root, 'GodotFixture.app');
          await cp(godotPath, copy, { recursive: true, mode: 2 });
          const key = (await readFile(join(root, 'desktop-control.key'))).toString('hex');
          const changed = await good<EngineGrant>(
            '/local/engine-file-grants',
            { projectId: project.id, path: copy },
            'POST',
            { 'x-lightmao-desktop-key': key },
          );
          const file = await open(join(copy, 'Contents/MacOS/Godot'), 'r+');
          try {
            await file.write(Buffer.from('tampered'), 0, 8, 0);
          } finally {
            await file.close();
          }
          assert.equal(
            (await call(base + '/engine', { grantId: changed.grantId })).statusCode,
            409,
          );
          assert.equal((await good<EngineConnection>(base + '/engine')).revision, revision);
        },
      );
      await t.test(
        'permission revocation and project revision changes prevent new execution, while prior history survives restart',
        async () => {
          connection = await good<EngineConnection>(
            base + '/engine',
            { enabled: false, revision: connection.revision },
            'PATCH',
          );
          assert.equal(
            (await call(base + '/engine-jobs', { action: 'validate', requestId: randomUUID() }))
              .statusCode,
            403,
          );
          await good(base, { name: 'Changed project label' }, 'PATCH');
          assert.equal((await good<EngineConnection>(base + '/engine')).needsAuthorization, true);
          assert.equal(
            (
              await call(
                base + '/engine',
                { enabled: true, revision: connection.revision },
                'PATCH',
              )
            ).statusCode,
            409,
          );
          await local.app.close();
          local = await createLocalAgent(options);
          assert.equal(
            (await good<EngineJob>(`/local/engine-jobs/${completed.id}`)).status,
            'completed',
          );
          assert(
            local.engines
              .logs(owner.user.id, completed.id, { limit: 4000 })
              .text.includes('LIGHTMAO_SCENE_READY'),
          );
          await good(base + '/engine', undefined, 'DELETE');
          assert.equal(
            (await good<EngineJob>(`/local/engine-jobs/${completed.id}`)).status,
            'completed',
          );
        },
      );
      await t.test(
        'shutdown during in-flight authorization cannot enqueue a new engine job',
        async () => {
          const preview = await good<EngineGrant>(base + '/engine/prepare', {});
          await good<EngineConnection>(base + '/engine', { grantId: preview.grantId });
          const before = local.store.list('engine-job', owner.user.id).length;
          let entered = false,
            release!: () => void;
          const gate = new Promise<void>((done) => {
            release = done;
          });
          const pending = local.engines.start(
            owner.user.id,
            project.id,
            { action: 'validate', requestId: randomUUID() },
            async () => {
              entered = true;
              await gate;
            },
          );
          await until(() => entered, 'authorization did not start');
          await local.engines.close();
          release();
          await assert.rejects(pending, { statusCode: 503 });
          assert.equal(local.store.list('engine-job', owner.user.id).length, before);
        },
      );
    } finally {
      await local.app.close();
      api.app.server.closeAllConnections();
      await api.app.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
