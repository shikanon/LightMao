import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApi } from '../apps/api/server.ts';
import { createLocalAgent } from '../apps/agent/server.ts';
import type { Project, Session, Run, RunEvent } from '../packages/shared/types.ts';

test(
  'global plugin withdrawal blocks an already proposed Pi tool and removes it from the next run',
  { timeout: 20000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lightmao-admin-pi-'));
    const proof = 'UNREAD_FILE_' + randomUUID();
    let withdraw: () => Promise<void>,
      calls = 0;
    const seen: { tools: string[]; text: string }[] = [];
    const upstream = createServer((req, res) => {
      void (async () => {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw),
          tools = (body.tools || []).map((t: { function: { name: string } }) => t.function.name);
        seen.push({ tools, text: JSON.stringify(body.messages) });
        calls++;
        if (calls === 1) await withdraw();
        const delta =
          calls === 1
            ? {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: 'withdrawn-call',
                    type: 'function',
                    function: {
                      name: 'read_file',
                      arguments: JSON.stringify({ path: 'policy-proof.txt' }),
                    },
                  },
                ],
              }
            : { role: 'assistant', content: 'POLICY_CHECKED' };
        const chunk = (delta: unknown, finish_reason: string | null) =>
          `data: ${JSON.stringify({ id: 'admin-pi-fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(chunk(delta, null));
        res.write(chunk({}, calls === 1 ? 'tool_calls' : 'stop'));
        res.end('data: [DONE]\n\n');
      })().catch(() => {
        res.writeHead(500).end();
      });
    });
    await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
    const api = await createApi({
      dataDir: dir,
      demo: true,
      arkKey: 'admin-pi-local-fixture',
      arkBase: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
    });
    await api.app.listen({ host: '127.0.0.1', port: 0 });
    const local = await createLocalAgent({
      dataDir: dir,
      apiUrl: `http://127.0.0.1:${(api.app.server.address() as { port: number }).port}`,
    });
    const login = (
      await api.app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} })
    ).json();
    const headers = { authorization: `Bearer ${login.token}` };
    const good = async <T>(url: string, payload?: unknown) => {
      const r = await local.app.inject({
        url,
        headers,
        method: payload ? 'POST' : 'GET',
        ...(payload ? { payload: payload as object } : {}),
      });
      assert.equal(r.statusCode, 200, r.body);
      return r.json<T>();
    };
    withdraw = async () => {
      const r = await api.app.inject({
        url: '/api/admin/plugins/workspace',
        method: 'PATCH',
        headers,
        payload: { available: false, revision: 0 },
      });
      assert.equal(r.statusCode, 200, r.body);
    };
    try {
      const project = await good<Project>('/local/projects', {
        name: 'Policy fixture',
        engine: 'Godot',
      });
      await writeFile(join(project.root, 'policy-proof.txt'), proof);
      const session = await good<Session>('/local/sessions', { projectId: project.id });
      for (let round = 0; round < 2; round++) {
        const started = await good<Run>(`/local/sessions/${session.id}/runs`, {
          mode: 'ark',
          prompt: '读取 policy-proof.txt，若工具被撤销则报告实际状态。',
        });
        let final: Run = started;
        for (let i = 0; i < 300 && final.status === 'running'; i++) {
          await delay(20);
          final = await good<Run>(`/local/runs/${started.id}`);
        }
        assert.equal(final.status, 'completed', final.error);
        assert.match(final.text, /POLICY_CHECKED/);
        if (round === 0) assert.equal(final.toolErrorCount, 1);
        const events = await good<RunEvent[]>(`/local/runs/${started.id}/events`);
        if (round === 1)
          assert(
            !(events.find((e) => e.type === 'context.loaded')?.data.tools as string[]).includes(
              'read_file',
            ),
          );
      }
      assert.equal(calls, 3);
      assert(seen[0].tools.includes('read_file'));
      assert(seen[1].text.includes('插件已停用'));
      assert(!seen[2].tools.includes('read_file'));
      assert(
        !seen.some((v) => v.text.includes(proof)),
        'withdrawn tool must not read or forward the file body',
      );
    } finally {
      await local.app.close();
      await api.app.close();
      upstream.closeAllConnections();
      await new Promise<void>((done) => upstream.close(() => done()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
