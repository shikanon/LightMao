import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, writeFile, access, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { createApi } from '../apps/api/server.ts';
import { createLocalAgent } from '../apps/agent/server.ts';
import { Store } from '../packages/shared/store.ts';
import type { EngineGrant, EngineJob, Project } from '../packages/shared/types.ts';
const godotPath =
  process.env.LIGHTMAO_TEST_GODOT_PATH || resolve('.lightmao/tools/godot/4.7.2/Godot.app');
let available = process.platform === 'darwin';
try {
  await access(godotPath);
} catch {
  available = false;
}
test(
  'SIGKILL of the real Agent disconnects and reaps the live engine; restart retains interruption without replay',
  { skip: !available, timeout: 45000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'lm-engine-crash-'));
    const api = await createApi({ dataDir: root, demo: true });
    await api.app.listen({ host: '127.0.0.1', port: 0 });
    const apiBase = `http://127.0.0.1:${(api.app.server.address() as { port: number }).port}`;
    const local = await createLocalAgent({ dataDir: root, apiUrl: apiBase, godotPath });
    const login = (
      await api.app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} })
    ).json<{ token: string; user: { id: string } }>();
    const headers = { authorization: `Bearer ${login.token}` };
    let child: ChildProcess | undefined,
      observer: Store | undefined,
      closed = false;
    const reservation = createServer();
    await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((done) => reservation.close(() => done()));
    const agentBase = `http://127.0.0.1:${port}`;
    async function until(
      check: () => boolean | Promise<boolean>,
      message: string,
      timeout = 15000,
    ) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await check()) return;
        await delay(40);
      }
      throw new Error(message);
    }
    const terminal = (pid: number) => {
      try {
        return execFileSync('ps', ['-p', String(pid), '-o', 'stat='], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        })
          .trim()
          .startsWith('Z');
      } catch (error) {
        if ((error as { status?: number }).status === 1) return true;
        throw error;
      }
    };
    async function launch() {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        LIGHTMAO_DATA_DIR: root,
        LIGHTMAO_API_URL: apiBase,
        AGENT_PORT: String(port),
        LIGHTMAO_GODOT_PATH: godotPath,
        NODE_NO_WARNINGS: '1',
      };
      for (const key of Object.keys(env))
        if (/^(ARK_|OSS_|DOUBAO_|LIGHTMAO_ADMIN_)/.test(key)) delete env[key];
      delete env.ELECTRON_RUN_AS_NODE;
      child = spawn(process.execPath, ['--import', 'tsx', 'apps/agent/index.ts'], {
        cwd: resolve('.'),
        env,
        stdio: 'ignore',
      });
      await until(async () => {
        if (child!.exitCode !== null || child!.signalCode !== null)
          throw new Error('Test Agent exited before ready');
        try {
          return (await fetch(agentBase + '/local/health')).ok;
        } catch {
          return false;
        }
      }, 'Test Agent did not start');
    }
    async function request<T>(path: string, body?: unknown) {
      const response = await fetch(agentBase + path, {
        method: body ? 'POST' : 'GET',
        headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      assert.equal(response.ok, true, `Local request ${path}: ${response.status}`);
      return response.json() as Promise<T>;
    }
    try {
      const projectResponse = await local.app.inject({
        method: 'POST',
        url: '/local/projects',
        headers,
        payload: {
          name: 'Engine crash fixture',
          engine: 'Godot',
          description: 'Only fault-test owned processes',
        },
      });
      assert.equal(projectResponse.statusCode, 200);
      const project = projectResponse.json<Project>();
      await cp(resolve('examples/godot-startrail'), project.root, { recursive: true });
      await writeFile(
        join(project.root, 'tests/loop.gd'),
        'extends SceneTree\nfunc _init():\n\twhile true:\n\t\tpass\n',
      );
      assert.equal(
        (
          await api.app.inject({
            method: 'PATCH',
            url: '/api/plugins/godot',
            headers,
            payload: { installed: true, enabled: true },
          })
        ).statusCode,
        200,
      );
      const grant = (
        await local.app.inject({
          method: 'POST',
          url: `/local/projects/${project.id}/engine/prepare`,
          headers,
          payload: {},
        })
      ).json<EngineGrant>();
      assert.equal(
        (
          await local.app.inject({
            method: 'POST',
            url: `/local/projects/${project.id}/engine`,
            headers,
            payload: { grantId: grant.grantId },
          })
        ).statusCode,
        200,
      );
      await local.app.close();
      closed = true;
      observer = new Store(join(root, 'local.sqlite'));
      await launch();
      const input = { action: 'script', script: 'tests/loop.gd', requestId: randomUUID() };
      const initial = await request<EngineJob>(`/local/projects/${project.id}/engine-jobs`, input);
      let running: EngineJob & { workerPid?: number; enginePid?: number };
      await until(() => {
        running = observer!.get('engine-job', initial.id, login.user.id)!;
        return running.stage === 'script' && !!running.enginePid && !!running.workerPid;
      }, 'Real test engine was not running');
      const enginePid = running!.enginePid!,
        workerPid = running!.workerPid!;
      const command = execFileSync('ps', ['-p', String(enginePid), '-o', 'command='], {
        encoding: 'utf8',
      });
      assert(command.includes('res://tests/loop.gd'));
      const envText = execFileSync('ps', ['eww', '-p', String(workerPid), '-o', 'command='], {
        encoding: 'utf8',
      });
      assert.equal(/(?:^|\s)(?:ARK_|OSS_|DOUBAO_|LIGHTMAO_ADMIN_)[A-Z0-9_]*=/.test(envText), false);
      const exit = once(child!, 'exit');
      child!.kill('SIGKILL');
      await exit;
      await until(
        () => terminal(enginePid) && terminal(workerPid),
        'Agent crash left a live engine or supervisor',
        5000,
      );
      const jobCount = observer.list('engine-job', login.user.id).length;
      await launch();
      const recovered = await request<EngineJob>(`/local/engine-jobs/${initial.id}`);
      assert.equal(recovered.status, 'interrupted');
      assert.equal(recovered.verification, 'not_run');
      const retry = await request<EngineJob>(`/local/projects/${project.id}/engine-jobs`, input);
      assert.equal(retry.id, initial.id);
      assert.equal(retry.status, 'interrupted');
      assert.equal(observer.list('engine-job', login.user.id).length, jobCount);
      assert.equal(
        observer
          .list<EngineJob>('engine-job', login.user.id)
          .filter((job) => job.status === 'running').length,
        0,
      );
      await assert.rejects(access(join(project.root, '.godot')));
      const cleanExit = once(child!, 'exit');
      child!.kill('SIGTERM');
      await cleanExit;
      assert.equal(observer.get('runtime-lease', 'agent', 'system'), undefined);
    } finally {
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        const exit = once(child, 'exit');
        child.kill('SIGTERM');
        await exit;
      }
      observer?.close();
      if (!closed) await local.app.close();
      api.app.server.closeAllConnections();
      await api.app.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
