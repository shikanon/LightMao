import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApi } from '../apps/api/server.ts';
import { createLocalAgent } from '../apps/agent/server.ts';
import { Store } from '../packages/shared/store.ts';
import { TaskJournal } from '../apps/agent/task-journal.ts';
import type { LocalBootstrap, Run, Schedule, TaskOccurrence } from '../packages/shared/types.ts';

test(
  'a real Agent process killed after a file write recovers its interrupted task without replay; queued work resumes once',
  { timeout: 30000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lightmao-task-crash-'));
    let requests = 0,
      held = false,
      child: ChildProcess | undefined,
      base = '';
    const upstream = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const part of req) chunks.push(part);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests++;
      const messages = body.messages as { role: string }[];
      const last = messages.findLastIndex((m) => m.role === 'user');
      if (messages.slice(last + 1).some((m) => m.role === 'tool')) {
        held = true;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.flushHeaders();
        await new Promise<void>((done) => res.once('close', done));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = (delta: unknown, reason: string | null) =>
        `data: ${JSON.stringify({ id: 'crash-fixture', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fixture-model', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
      res.write(
        chunk(
          {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'write-once',
                type: 'function',
                function: {
                  name: 'write_file',
                  arguments: JSON.stringify({
                    path: 'one-time.txt',
                    content: 'SIDE_EFFECT_BEFORE_CRASH',
                  }),
                },
              },
            ],
          },
          null,
        ),
      );
      res.write(chunk({}, 'tool_calls'));
      res.end('data: [DONE]\n\n');
    });
    await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
    const api = await createApi({
      dataDir: dir,
      demo: true,
      arkKey: 'crash-fixture-key',
      arkBase: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
      modelId: 'fixture-model',
    });
    await api.app.listen({ host: '127.0.0.1', port: 0 });
    const apiBase = `http://127.0.0.1:${(api.app.server.address() as { port: number }).port}`;
    const login = (
      await api.app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} })
    ).json<{ token: string; user: { id: string } }>();
    const auth = { authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' };
    async function launch() {
      const env = { ...process.env };
      for (const key of Object.keys(env))
        if (/^(ARK_|OSS_|DOUBAO_|LIGHTMAO_ADMIN_)/.test(key)) delete env[key];
      const module = new URL('../apps/agent/server.ts', import.meta.url).href;
      const source = `import { createLocalAgent } from ${JSON.stringify(module)}; const local=await createLocalAgent({dataDir:${JSON.stringify(dir)},apiUrl:${JSON.stringify(apiBase)},tickMs:60000}); await local.app.listen({host:'127.0.0.1',port:0}); process.send({port:local.app.server.address().port}); process.on('SIGTERM',()=>void local.app.close().then(()=>process.exit(0)));`;
      child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
        env,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      let diagnostics = '';
      child.stderr!.on('data', (data) => {
        diagnostics = (diagnostics + data).slice(-3000);
      });
      const ready = await new Promise<{ port: number }>((done, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Agent did not start: ' + diagnostics)),
          10000,
        );
        child!.once('message', (value) => {
          clearTimeout(timer);
          done(value as { port: number });
        });
        child!.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`Agent exited ${code}: ${diagnostics}`));
        });
      });
      base = `http://127.0.0.1:${ready.port}`;
    }
    async function stop(signal: NodeJS.Signals) {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill(signal);
      await exited;
    }
    async function request<T>(
      path: string,
      body?: unknown,
      headers: Record<string, string> = auth,
    ) {
      const response = await fetch(base + path, {
        method: body ? 'POST' : 'GET',
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      const result = await response.json();
      assert(response.ok, `${path}: ${JSON.stringify(result)}`);
      return result as T;
    }
    async function until(check: () => Promise<boolean>) {
      for (let i = 0; i < 200; i++) {
        if (await check()) return;
        await delay(15);
      }
      throw new Error('Task state did not arrive');
    }
    try {
      await launch();
      const project = (await request<LocalBootstrap>('/local/bootstrap')).projects[0];
      await api.app.inject({
        method: 'PATCH',
        url: '/api/plugins/writer',
        headers: auth,
        payload: { installed: true, enabled: true },
      });
      const config = {
        name: 'Crash check',
        prompt: 'Write the fixture file once',
        projectId: project.id,
        frequency: 'interval',
        intervalMinutes: 60,
        time: '09:00',
        timezone: 'UTC',
        enabled: false,
        mode: 'ark',
      };
      const task = await request<Schedule>('/local/schedules', config);
      const key = (await readFile(join(dir, 'desktop-control.key'))).toString('hex');
      assert.equal(
        (await fetch(base + '/local/native/wake', { method: 'POST', headers: auth, body: '{}' }))
          .status,
        403,
      );
      const requestId = randomUUID();
      const before = (await request<LocalBootstrap>('/local/bootstrap')).sessionCounts![project.id]
        .total;
      const replies = await Promise.all(
        [1, 2, 3].map(() =>
          request<{ occurrence: TaskOccurrence }>(`/local/schedules/${task.id}/run`, { requestId }),
        ),
      );
      assert.equal(new Set(replies.map((r) => r.occurrence.id)).size, 1);
      const occurrence = replies[0].occurrence;
      await until(
        async () =>
          held &&
          (await readFile(join(project.root, 'one-time.txt'), 'utf8').catch(() => '')) ===
            'SIDE_EFFECT_BEFORE_CRASH',
      );
      const history = await request<{ items: TaskOccurrence[] }>('/local/task-occurrences');
      assert.equal(history.items.length, 1);
      assert.equal(history.items[0].status, 'running');
      assert.equal(
        (await request<LocalBootstrap>('/local/bootstrap')).sessionCounts![project.id].total,
        before + 1,
      );
      assert.equal(requests, 2);
      await assert.rejects(() => createLocalAgent({ dataDir: dir, apiUrl: apiBase }), {
        code: 'AGENT_ALREADY_RUNNING',
      });
      assert.equal(
        (await request<Run>(`/local/runs/${history.items[0].runId}`)).status,
        'running',
        'a second daemon must not recover work owned by a live daemon',
      );
      await stop('SIGKILL');
      await launch();
      const recovered = (await request<{ items: TaskOccurrence[] }>('/local/task-occurrences'))
        .items[0];
      assert.equal(recovered.id, occurrence.id);
      assert.equal(recovered.status, 'interrupted');
      assert.equal((await request<Run>(`/local/runs/${recovered.runId}`)).status, 'interrupted');
      assert.equal((await request<Schedule[]>('/local/schedules'))[0].lastStatus, 'interrupted');
      await request('/local/native/wake', {}, { ...auth, 'x-lightmao-desktop-key': key });
      assert.equal(requests, 2, 'recovery must not call the model or repeat the prior file write');
      assert.equal(
        await readFile(join(project.root, 'one-time.txt'), 'utf8'),
        'SIDE_EFFECT_BEFORE_CRASH',
      );
      const queuedTask = await request<Schedule>('/local/schedules', {
        ...config,
        name: 'Queued check',
        mode: 'demo',
        enabled: true,
      });
      await stop('SIGTERM');
      const db = new Store(join(dir, 'local.sqlite'));
      const journal = new TaskJournal(db);
      db.put('schedule', login.user.id, {
        ...db.get<Schedule>('schedule', queuedTask.id)!,
        nextRunAt: new Date(0).toISOString(),
      });
      const queued = journal.enqueue(login.user.id, queuedTask.id, 'scheduled')!;
      assert.equal(queued.status, 'queued');
      db.close();
      await launch();
      await request('/local/native/wake', {}, { ...auth, 'x-lightmao-desktop-key': key });
      await until(async () =>
        (await request<{ items: TaskOccurrence[] }>('/local/task-occurrences')).items.some(
          (o) => o.id === queued.id && o.status === 'completed',
        ),
      );
      await request('/local/native/wake', {}, { ...auth, 'x-lightmao-desktop-key': key });
      const final = (await request<{ items: TaskOccurrence[] }>('/local/task-occurrences')).items;
      assert.equal(final.filter((o) => o.taskId === queuedTask.id).length, 1);
      assert.equal(final.find((o) => o.id === recovered.id)!.status, 'interrupted');
      assert.equal(requests, 2);
    } finally {
      await stop('SIGKILL');
      api.app.server.closeAllConnections();
      await api.app.close();
      upstream.closeAllConnections();
      await new Promise<void>((done) => upstream.close(() => done()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
