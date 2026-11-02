import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, cp, writeFile, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApi } from '../apps/api/server.ts';
import { createLocalAgent } from '../apps/agent/server.ts';
import type { Project, SessionView, EngineGrant } from '../packages/shared/types.ts';
const html = `<!doctype html><meta charset="utf-8"><title>Native browser playtest</title><button id="start">开始游戏</button><p id="score"></p><script type="application/json" data-lightmao-playtest></script>
<script>let phase='menu',score=0;function publish(){document.querySelector('#score').textContent='分数 '+score;document.querySelector('[data-lightmao-playtest]').textContent=JSON.stringify({state:{phase,score},actions:phase==='playing'?[{id:'collect',label:'按空格收集星星',key:'SPACE',holdMs:60}]:[]})}document.querySelector('#start').onclick=()=>{phase='playing';document.querySelector('#start').disabled=true;publish()};addEventListener('keydown',e=>{if(e.key===' '&&phase==='playing'){score++;publish()}});publish();</script>`;
test(
  'browser runtime failures retain exact source diagnostics and stop before any paid decision',
  { skip: process.platform !== 'darwin', timeout: 25000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'lm-runtime-failure-'));
    let requests = 0;
    const upstream = createServer((_req, res) => {
      requests++;
      res.writeHead(500).end('must not call');
    });
    await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
    const api = await createApi({
      dataDir: root,
      demo: true,
      arkKey: 'no-paid-fixture',
      arkBase: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
    });
    await api.app.listen({ host: '127.0.0.1', port: 0 });
    const local = await createLocalAgent({
      dataDir: root,
      apiUrl: `http://127.0.0.1:${(api.app.server.address() as { port: number }).port}`,
    });
    try {
      const login = (
          await api.app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} })
        ).json(),
        headers = { authorization: 'Bearer ' + login.token };
      const project = (
        await local.app.inject({
          method: 'POST',
          url: '/local/projects',
          headers,
          payload: { name: 'Broken runtime', description: '', engine: 'Web' },
        })
      ).json<Project>();
      await writeFile(
        join(project.root, 'index.html'),
        '<!doctype html>\n<title>Runtime error</title>\n<p>loading</p>\n<script>missingStartupSymbol()</script>\n',
      );
      const session = (
        await local.app.inject({
          method: 'POST',
          url: '/local/sessions',
          headers,
          payload: { projectId: project.id },
        })
      ).json<SessionView>();
      const initial = await local.playtests.start(
        login.user.id,
        project.id,
        session.id,
        {
          requestId: randomUUID(),
          entry: 'index.html',
          goal: '开始游戏',
          maxSteps: 3,
          assertions: [{ field: 'score', op: 'gte', value: 1 }],
        },
        login.token,
        async () => {},
      );
      const final = await local.playtests.wait(login.user.id, initial.id);
      assert.equal(final.status, 'failed');
      assert.match(final.error || '', /missingStartupSymbol/);
      assert.match(final.error || '', /index\.html:4/);
      assert.equal(requests, 0);
      assert.equal(api.store.list('usage').length, 0);
    } finally {
      await local.app.close();
      await api.app.close();
      upstream.closeAllConnections();
      await new Promise<void>((done) => upstream.close(() => done()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
const godot = resolve('.lightmao/tools/godot/4.7.2/Godot.app');
let godotAvailable = process.platform === 'darwin';
try {
  await access(godot);
} catch {
  godotAvailable = false;
}
for (const kind of ['browser', 'godot'] as const)
  test(
    `${kind} actual game inputs and Ark-compatible multihead decisions produce independently checked evidence`,
    { skip: kind === 'godot' ? !godotAvailable : process.platform !== 'darwin', timeout: 40000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'lm-playtest-full-'));
      let decisions = 0;
      const upstream = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(Buffer.from(c));
        const input = JSON.parse(Buffer.concat(chunks).toString());
        decisions++;
        const state = input.state.game_state || {};
        const operation =
          kind === 'godot'
            ? state.player_x > 120
              ? 'DONE'
              : 'PRESS_KEY'
            : state.score >= 1
              ? 'DONE'
              : state.phase === 'menu'
                ? 'CLICK'
                : 'PRESS_KEY';
        const answers = Object.fromEntries(
          Object.entries(input.questions).map(([id, q]: [string, any]) => {
            const keys = Object.keys(q.criteria);
            let selected =
              id === 'operation'
                ? operation
                : keys.find((key) =>
                    String(q.criteria[key].label).includes(kind === 'godot' ? '向右' : '开始游戏'),
                  ) || keys[0];
            return [
              id,
              {
                type: 'choice',
                choice: selected,
                confidence: 1,
                probabilities: Object.fromEntries(
                  keys.map((key) => [key, key === selected ? 1 : 0]),
                ),
              },
            ];
          }),
        );
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            model: 'ark-system-one-protocol-fixture',
            answers,
            usage: { input_tokens: 80, output_tokens: 0 },
          }),
        );
      });
      await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
      const api = await createApi({
        dataDir: root,
        demo: true,
        arkKey: 'playtest-fixture-key',
        arkBase: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/api/v3`,
      });
      await api.app.listen({ host: '127.0.0.1', port: 0 });
      const local = await createLocalAgent({
        dataDir: root,
        apiUrl: `http://127.0.0.1:${(api.app.server.address() as { port: number }).port}`,
        godotPath: godot,
      });
      try {
        const login = (
            await api.app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} })
          ).json(),
          headers = { authorization: 'Bearer ' + login.token };
        const created = await local.app.inject({
          method: 'POST',
          url: '/local/projects',
          headers,
          payload: {
            name: 'Game ' + kind,
            engine: kind === 'browser' ? 'Web' : 'Godot',
            description: 'Actual input evidence with protocol model',
          },
        });
        assert.equal(created.statusCode, 200, created.body);
        const project = created.json<Project>();
        const session = (
          await local.app.inject({
            method: 'POST',
            url: '/local/sessions',
            headers,
            payload: { projectId: project.id },
          })
        ).json<SessionView>();
        if (kind === 'browser') await writeFile(join(project.root, 'index.html'), html);
        else {
          await cp(resolve('examples/godot-startrail'), project.root, { recursive: true });
          const grant = (
            await local.app.inject({
              method: 'POST',
              url: `/local/projects/${project.id}/engine/prepare`,
              headers,
              payload: {},
            })
          ).json<EngineGrant>();
          const confirmed = await local.app.inject({
            method: 'POST',
            url: `/local/projects/${project.id}/engine`,
            headers,
            payload: { grantId: grant.grantId },
          });
          assert.equal(confirmed.statusCode, 200, confirmed.body);
        }
        const payload = {
          requestId: randomUUID(),
          goal:
            kind === 'browser'
              ? '开始游戏并按空格收集一颗星星，分数至少1再完成'
              : '向右移动，player_x超过120再完成',
          maxSteps: 5,
          assertions: [
            {
              field: kind === 'browser' ? 'score' : 'player_x',
              op: 'gte',
              value: kind === 'browser' ? 1 : 150,
            },
          ],
        };
        const visible = kind === 'godot' && process.env.LIGHTMAO_GODOT_VISIBLE_TEST === 'true';
        const initial =
          kind === 'browser'
            ? await local.playtests.start(
                login.user.id,
                project.id,
                session.id,
                { ...payload, entry: 'index.html' },
                login.token,
                async () => {},
              )
            : await local.playtests.startGodot(
                login.user.id,
                project.id,
                session.id,
                { ...payload, visible },
                login.token,
                async () => {},
              );
        const final = await local.playtests.wait(login.user.id, initial.id);
        if (final.status !== 'passed' && final.engineJobId)
          console.error(
            JSON.stringify({
              engine: local.engines.get(login.user.id, final.engineJobId),
              log: local.engines.logs(login.user.id, final.engineJobId, { limit: 4000 }).text,
            }),
          );
        assert.equal(final.status, 'passed', JSON.stringify(final));
        assert(final.inputActions >= 1);
        assert(final.assertions.every((a) => a.passed));
        assert.equal(final.requestIds.length, decisions);
        assert.equal(decisions, kind === 'browser' ? 3 : 2);
        assert.throws(() => local.playtests.get('unrelated-owner', final.id));
        if (kind === 'browser' || visible) {
          assert(final.screenshotSha256);
          const screenshot = await local.playtests.screenshot(login.user.id, final.id);
          assert(screenshot.subarray(1, 4).equals(Buffer.from('PNG')));
          if (process.env.LIGHTMAO_QA_ARTIFACT_DIR) {
            await mkdir(process.env.LIGHTMAO_QA_ARTIFACT_DIR, { recursive: true });
            await writeFile(
              join(process.env.LIGHTMAO_QA_ARTIFACT_DIR, kind + '-protocol-playtest.png'),
              screenshot,
            );
          }
        }
        const trace = await local.playtests.trace(login.user.id, final.id, 0);
        assert(trace.totalChars > 0);
        assert(!trace.text.includes('playtest-fixture-key'));
      } finally {
        await local.app.close();
        await api.app.close();
        await new Promise<void>((done) => upstream.close(() => done()));
        await rm(root, { recursive: true, force: true });
      }
    },
  );
