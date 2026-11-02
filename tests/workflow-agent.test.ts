import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApi } from '../apps/api/server.ts';
import { createLocalAgent } from '../apps/agent/server.ts';
import type {
  AgentGoal,
  CloudBootstrap,
  LocalBootstrap,
  Run,
  SessionView,
} from '../packages/shared/types.ts';

test(
  'natural Plan request discovers skills without selecting IDs and enforces readonly tools through the actual Pi loop',
  { skip: process.platform !== 'darwin', timeout: 30000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lm-plan-pi-'));
    let calls = 0,
      skillId = '';
    const seen: string[][] = [];
    const upstream = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      seen.push((body.tools || []).map((t: any) => t.function.name));
      const call = (name: string, args: unknown) => ({
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'workflow-tool-' + calls,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      });

      const current = calls++;
      const delta =
        current === 0
          ? call('read_skill_resource', { skillId, path: 'SKILL.md' })
          : current === 1
            ? call('write_file', { path: 'should-not-exist.txt', content: 'forbidden' })
            : current === 2
              ? call('update_plan', {
                  objective: '制作冲刺游戏',
                  steps: [
                    {
                      id: 'build',
                      text: '实现移动和冲刺',
                      status: 'pending',
                      acceptance: '输入后位置和冷却实际变化',
                    },
                  ],
                })
              : { role: 'assistant', content: '计划已保存；确认后再执行。' };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'plan-fixture',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'fixture',
            choices: [{ index: 0, delta, finish_reason: null }],
          }) +
          '\n\n',
      );
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'plan-fixture',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'fixture',
            choices: [
              { index: 0, delta: {}, finish_reason: 'tool_calls' in delta ? 'tool_calls' : 'stop' },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
          }) +
          '\n\n',
      );
      res.end('data: [DONE]\n\n');
    });
    await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
    const api = await createApi({
      dataDir: dir,
      demo: true,
      arkKey: 'workflow-fixture-key',
      arkBase: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
    });
    await api.app.listen({ host: '127.0.0.1', port: 0 });
    const local = await createLocalAgent({
      dataDir: dir,
      apiUrl: `http://127.0.0.1:${(api.app.server.address() as { port: number }).port}`,
    });
    try {
      const login = (
        await api.app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} })
      ).json();
      const headers = { authorization: 'Bearer ' + login.token };
      const cloud = (
        await api.app.inject({ method: 'GET', url: '/api/bootstrap', headers })
      ).json<CloudBootstrap>();
      skillId = cloud.skills[0].id;
      await api.app.inject({
        method: 'PATCH',
        url: '/api/plugins/writer',
        headers,
        payload: { installed: true, enabled: true },
      });
      const bootstrap = (
        await local.app.inject({ method: 'GET', url: '/local/bootstrap', headers })
      ).json<LocalBootstrap>();
      const project = bootstrap.projects[0];
      const session = (
        await local.app.inject({
          method: 'POST',
          url: '/local/sessions',
          headers,
          payload: { projectId: project.id },
        })
      ).json<SessionView>();
      const started = await local.app.inject({
        method: 'POST',
        url: `/local/sessions/${session.id}/runs`,
        headers,
        payload: {
          prompt: '给这个游戏规划移动和冲刺，先不要实现。',
          mode: 'ark',
          workMode: 'plan',
        },
      });
      assert.equal(started.statusCode, 200, started.body);
      const run = started.json<Run>();
      const deadline = Date.now() + 12000;
      let final = run;
      while (final.status === 'running' && Date.now() < deadline) {
        await delay(40);
        final = (
          await local.app.inject({ method: 'GET', url: '/local/runs/' + run.id, headers })
        ).json<Run>();
      }
      assert.equal(final.status, 'completed', final.error);
      assert.equal(final.workMode, 'plan');
      assert.equal(calls, 4);
      assert(
        seen.every(
          (tools) => tools.includes('read_skill_resource') && tools.includes('update_plan'),
        ),
      );
      assert(
        seen.every(
          (tools) =>
            !tools.includes('write_file') &&
            !tools.includes('run_godot') &&
            !tools.includes('generate_image'),
        ),
      );
      await assert.rejects(() => access(join(project.root, 'should-not-exist.txt')));
      const flow = await local.app.inject({
        method: 'GET',
        url: `/local/sessions/${session.id}/workflow`,
        headers,
      });
      assert.equal(flow.statusCode, 200);
      assert.equal(flow.json().plan.steps[0].status, 'pending');
      const events = local.store
        .list<{ runId: string; type: string; data: any }>('event', login.user.id)
        .filter((e) => e.runId === run.id);
      assert(
        events.some(
          (e) =>
            e.type === 'context.loaded' &&
            e.data.automaticSkillDiscovery &&
            e.data.selectedSkills.length === 0,
        ),
      );
      assert(
        events.some(
          (e) =>
            e.type === 'tool.finished' && e.data.name === 'read_skill_resource' && !e.data.isError,
        ),
      );
    } finally {
      await local.app.close();
      await api.app.close();
      await new Promise<void>((done) => upstream.close(() => done()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  'actual Pi Goal continues at idle, verifies files, blocks post-completion edits and honors pause and explicit budget increases',
  { skip: process.platform !== 'darwin', timeout: 25000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lm-goal-pi-'));
    let calls = 0;
    let scaffoldCalls = 0;
    const upstream = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      calls++;
      const content = (m: any) =>
        typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      const budget = body.messages.some(
        (m: any) => m.role === 'user' && content(m).includes('BUDGET_ONLY'),
      );
      const last = body.messages.at(-1),
        lastTool = body.messages.findLast((m: any) => m.role === 'tool');
      const lastToolName =
        lastTool?.name ||
        body.messages
          .flatMap((m: any) => m.tool_calls || [])
          .find((t: any) => t.id === lastTool?.tool_call_id)?.function.name;
      let tool: [string, unknown] | undefined;
      const scaffold = body.messages.some(
        (m: any) => m.role === 'user' && content(m).includes('SCAFFOLD_TEST'),
      );
      if (scaffold) {
        const n = ++scaffoldCalls;
        tool =
          n <= 4
            ? [
                'write_file',
                { path: `scaffold-${n}.js`, content: 'const core = true;\n'.repeat(400) },
              ]
            : ['read_file', { path: 'scaffold-1.js', offset: (n - 5) * 700, limit: 1000 }];
      } else if (!budget) {
        if (calls <= 12)
          tool = [
            'write_file',
            {
              path: `progress-${calls}.md`,
              content:
                `真实轮次进展 ${calls}` +
                (calls === 1 ? '\nconst completeModule = true;'.repeat(300) : ''),
            },
          ];
        else if (last.role === 'user')
          tool = ['write_file', { path: 'goal.txt', content: 'actual-persisted-evidence' }];
        else if (lastToolName === 'write_file') tool = ['read_file', { path: 'goal.txt' }];
        else if (lastToolName === 'read_file')
          tool = ['complete_goal', { evidence: [{ kind: 'file', ref: 'goal.txt' }] }];
        else if (lastToolName === 'complete_goal')
          tool = ['write_file', { path: 'post-completion.txt', content: 'must not execute' }];
      }
      const delta = tool
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'goal-' + calls,
                type: 'function',
                function: { name: tool[0], arguments: JSON.stringify(tool[1]) },
              },
            ],
          }
        : { role: 'assistant', content: '本轮已记录。' };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [d, finish] of [
        [delta, null],
        [{}, tool ? 'tool_calls' : 'stop'],
      ])
        res.write(
          'data: ' +
            JSON.stringify({
              id: 'goal-fixture',
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: d, finish_reason: finish }],
              ...(finish
                ? { usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }
                : {}),
            }) +
            '\n\n',
        );
      res.end('data: [DONE]\n\n');
    });
    await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
    const api = await createApi({
      dataDir: dir,
      demo: true,
      arkKey: 'goal-fixture',
      arkBase: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
    });
    await api.app.listen({ host: '127.0.0.1', port: 0 });
    const local = await createLocalAgent({
      dataDir: dir,
      apiUrl: `http://127.0.0.1:${(api.app.server.address() as { port: number }).port}`,
      tickMs: 25,
    });
    try {
      const login = (
          await api.app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} })
        ).json(),
        owner = login.user.id,
        headers = { authorization: 'Bearer ' + login.token };
      await api.app.inject({
        method: 'PATCH',
        url: '/api/plugins/writer',
        headers,
        payload: { installed: true, enabled: true },
      });
      const project = (
        await local.app.inject({ method: 'GET', url: '/local/bootstrap', headers })
      ).json<LocalBootstrap>().projects[0];
      const create = async () =>
        (
          await local.app.inject({
            method: 'POST',
            url: '/local/sessions',
            headers,
            payload: { projectId: project.id },
          })
        ).json<SessionView>();
      const wait = async (check: () => boolean) => {
        const end = Date.now() + 20000;
        while (!check() && Date.now() < end) await delay(20);
        assert(
          check(),
          'goal state was not reached: ' +
            JSON.stringify({
              goals: local.store
                .list<AgentGoal>('agent-goal', owner)
                .map((g) => ({
                  status: g.status,
                  rounds: g.rounds,
                  reason: g.reason,
                  action: g.runtime?.action,
                })),
              runs: local.store
                .list<Run>('run', owner)
                .slice(-3)
                .map((r) => ({ status: r.status, error: r.error, tools: r.toolCount })),
              tools: local.store
                .list<{ name: string; summary: string }>('tool-detail', owner)
                .slice(-5),
            }),
        );
      };
      const session = await create();
      assert.equal(
        (
          await local.app.inject({
            method: 'POST',
            url: `/local/sessions/${session.id}/runs`,
            headers,
            payload: {
              prompt: '保存产物，然后继续核对并完成目标。',
              mode: 'ark',
              workMode: 'goal',
              goalOptions: { maxRounds: 3, evidencePolicy: 'artifact' },
            },
          })
        ).statusCode,
        200,
      );
      await wait(() => {
        const g = local.workflows.goal(owner, session.id);
        return g?.status === 'completed' && !g.currentRunId;
      });
      const goal = local.workflows.goal(owner, session.id)!;
      assert.equal(goal.rounds, 2);
      assert.equal(goal.evidence[0].kind, 'file');
      assert(
        (await readFile(join(project.root, 'progress-1.md'), 'utf8')).length > 6000,
        'actual Pi accepts a complete module beyond the obsolete 6000 character limit',
      );
      assert.equal(
        await readFile(join(project.root, 'goal.txt'), 'utf8'),
        'actual-persisted-evidence',
      );
      await assert.rejects(() => access(join(project.root, 'post-completion.txt')));
      const budget = await create();
      await local.app.inject({
        method: 'POST',
        url: `/local/sessions/${budget.id}/runs`,
        headers,
        payload: {
          prompt: 'BUDGET_ONLY 保存持续目标',
          mode: 'ark',
          workMode: 'goal',
          goalOptions: { maxRounds: 2, evidencePolicy: 'runtime' },
        },
      });
      await wait(() => {
        const g = local.workflows.goal(owner, budget.id);
        return g?.rounds === 1 && !g.currentRunId;
      });
      let g = local.workflows.goal(owner, budget.id)!;
      local.workflows.control(owner, budget.id, 'pause', g.revision);
      const before = calls;
      await delay(1100);
      assert.equal(calls, before);
      g = local.workflows.goal(owner, budget.id)!;
      local.workflows.control(owner, budget.id, 'resume', g.revision);
      await wait(() => local.workflows.goal(owner, budget.id)?.status === 'budget_limited');
      g = local.workflows.goal(owner, budget.id)!;
      assert.equal(g.rounds, 2);
      assert.equal(g.evidence.length, 0);
      local.workflows.extendBudget(owner, budget.id, g.revision, 3);
      await wait(() => local.workflows.goal(owner, budget.id)?.status === 'budget_limited');
      assert.equal(local.workflows.goal(owner, budget.id)!.rounds, 3);
      assert.equal(local.workflows.goal(owner, budget.id)!.evidence.length, 0);
      const scaffoldSession = await create();
      await local.app.inject({
        method: 'POST',
        url: `/local/sessions/${scaffoldSession.id}/runs`,
        headers,
        payload: {
          prompt:
            '创建游戏 SCAFFOLD_TEST；先完成必要模块并精确读取分段源码，未实际试玩不得声称完成。',
          mode: 'ark',
          workMode: 'goal',
          goalOptions: { maxRounds: 1, evidencePolicy: 'playtest' },
        },
      });
      await wait(
        () => local.workflows.goal(owner, scaffoldSession.id)?.status === 'budget_limited',
      );
      const scaffoldRun = local.store
        .list<Run>('run', owner)
        .find((r) => r.sessionId === scaffoldSession.id)!;
      assert.equal(scaffoldCalls, 12);
      assert.equal(
        scaffoldRun.toolErrorCount,
        0,
        'validation debt must not remove authorized tools mid-scaffold or during distinct exact source-page reads',
      );
      assert.equal(scaffoldRun.toolCount, 12);
      assert.equal(
        local.workflows.goal(owner, scaffoldSession.id)!.evidence.length,
        0,
        'source progress alone never completes a playtest goal',
      );
    } finally {
      await local.app.close();
      await api.app.close();
      await new Promise<void>((done) => upstream.close(() => done()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
