import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, readdir, cp, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createApi } from '../apps/api/server.ts';
import { createLocalAgent } from '../apps/agent/server.ts';
import { playtestInput } from '../apps/agent/playtests.ts';
import { createPlaytestTools } from '../apps/agent/playtest-tools.ts';
import type { EngineGrant, PlaytestJob, Project, SessionView } from '../packages/shared/types.ts';
import type { DecisionRequest } from '../packages/shared/system-one.ts';
import type { PlaytestService } from '../apps/agent/playtests.ts';

const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const game = `<!doctype html><meta charset="utf-8"><title>Late stage capture fixture</title>
<style>body{font:24px sans-serif;padding:40px;color:#fff;background:#28204d}h1{font-size:48px}</style>
<h1 id="phase"></h1><div id="details"></div><script type="application/json" data-lightmao-playtest></script>
<script>
let inputs=0;
function publish(){
 const phase=inputs<12?'preselect':[15,19,23,27].includes(inputs)?'draft':inputs<28?'battle':inputs<32?'boss':'won';
 const state={phase,inputs,preRound:inputs<12?Math.floor(inputs/2)+1:6,wave:inputs<12?0:Math.min(5,1+Math.floor((inputs-12)/3)),bossLayer:inputs>=28&&inputs<32?32-inputs:0,drafts:inputs<15?0:inputs<19?1:inputs<23?2:inputs<27?3:4};
 document.querySelector('#phase').textContent=phase;
 document.querySelector('#details').textContent=JSON.stringify(state);
 document.body.style.background=phase==='boss'?'#722036':phase==='won'?'#19533a':'#28204d';
 document.querySelector('[data-lightmao-playtest]').textContent=JSON.stringify({state,actions:phase==='won'?[]:[{id:'advance',label:'按空格推进实际关卡',key:'SPACE',holdMs:20}]});
}
addEventListener('keydown',event=>{if(event.key===' '&&!event.repeat&&inputs<32){inputs++;publish()}});publish();
</script>`;

test('browser and native tools accept explicit budgets through 64 steps without expanding the default or accepting 65', () => {
  const base = {
    goal: 'win',
    requestId: 'budget',
    assertions: [{ field: 'phase', op: 'eq', value: 'won' }],
  };
  assert.equal(playtestInput.parse(base).maxSteps, 12);
  for (const maxSteps of [1, 20, 21, 64])
    assert.equal(playtestInput.parse({ ...base, maxSteps }).maxSteps, maxSteps);
  assert.throws(() => playtestInput.parse({ ...base, maxSteps: 65 }));
  const tools = createPlaytestTools({
    service: {} as PlaytestService,
    owner: 'owner',
    project: 'project',
    session: 'session',
    run: 'run',
    token: 'local-fixture',
    allowed: ['run_browser_playtest', 'run_godot_playtest'],
    runs: new Set(),
    authorize: async () => {},
    authorizeGodot: async () => {},
  });
  for (const name of ['run_browser_playtest', 'run_godot_playtest']) {
    const tool = tools.find((value) => value.name === name)!;
    assert.equal(
      (tool.parameters as { properties: { maxSteps: { maximum: number } } }).properties.maxSteps
        .maximum,
      64,
    );
    assert.match(tool.description, /64步/);
    assert.match(tool.description, /180秒/);
    assert.match(tool.description, /未知/);
  }
});

const godot = resolve('.lightmao/tools/godot/4.7.2/Godot.app');
let godotAvailable = process.platform === 'darwin';
try {
  await access(godot);
} catch {
  godotAvailable = false;
}
for (const kind of ['browser', 'godot'] as const)
  test(
    `${kind} actually advances beyond step 20; late browser battle, boss and victory frames survive the bounded window`,
    { skip: kind === 'godot' ? !godotAvailable : process.platform !== 'darwin', timeout: 90000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'lm-late-playtest-'));
      let decisions = 0;
      let stopAtBudget = false;
      const upstream = createServer(async (request, response) => {
        let raw = '';
        for await (const chunk of request) raw += chunk;
        const input = JSON.parse(raw) as DecisionRequest;
        decisions++;
        const state = (input.state as { game_state?: Record<string, unknown> }).game_state || {};
        const done =
          kind === 'browser'
            ? state.phase === 'won'
            : !stopAtBudget && Number(state.driver_inputs) >= 63;
        const answers = Object.fromEntries(
          Object.entries(input.questions).map(([id, question]) => {
            assert.equal(question.type, 'choice');
            if (question.type !== 'choice') throw Error('fixture requires choices');
            const keys = Object.keys(question.criteria);
            const selected =
              id === 'operation'
                ? done
                  ? 'DONE'
                  : 'PRESS_KEY'
                : keys.find((key) =>
                    String((question.criteria[key] as { label?: string }).label).includes(
                      kind === 'godot' ? '向右' : '推进实际关卡',
                    ),
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
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            model: 'local-system-one-fixture',
            answers,
            usage: { input_tokens: 10, output_tokens: 0 },
          }),
        );
      });
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
      const api = await createApi({
        dataDir: root,
        demo: true,
        arkKey: 'local-unbilled-fixture',
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
        ).json();
        const headers = { authorization: 'Bearer ' + login.token };
        const project = (
          await local.app.inject({
            method: 'POST',
            url: '/local/projects',
            headers,
            payload: {
              name: 'Long actual inputs',
              engine: kind === 'browser' ? 'Web' : 'Godot',
              description: 'Bounded local protocol fixture',
            },
          })
        ).json<Project>();
        const session = (
          await local.app.inject({
            method: 'POST',
            url: '/local/sessions',
            headers,
            payload: { projectId: project.id },
          })
        ).json<SessionView>();
        if (kind === 'browser') await writeFile(join(project.root, 'index.html'), game);
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
              ? '完成预选、实际推进战斗、选技、Boss和胜利'
              : '实际向右操作63次后完成',
          maxSteps: 64,
          assertions: [
            {
              field: kind === 'browser' ? 'phase' : 'driver_inputs',
              op: kind === 'browser' ? 'eq' : 'gte',
              value: kind === 'browser' ? 'won' : 63,
            },
          ],
        };
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
                payload,
                login.token,
                async () => {},
              );
        const final = await local.playtests.wait(login.user.id, initial.id);
        assert.equal(final.status, 'passed', JSON.stringify(final));
        assert(final.steps > 20);
        assert.equal(final.steps, kind === 'browser' ? 33 : 64);
        assert.equal(final.inputActions, kind === 'browser' ? 32 : 63);
        assert.equal(decisions, final.steps);
        assert(final.assertions.every((value) => value.passed));
        if (kind === 'godot') {
          stopAtBudget = true;
          const previousDecisions = decisions;
          // A separate real owner keeps the 90 requests/minute production limit intact.
          const budgetLogin = (
            await api.app.inject({
              method: 'POST',
              url: '/api/auth/register',
              payload: {
                name: 'Native budget fixture',
                email: randomUUID() + '@example.test',
                password: 'local-fixture-password-123',
              },
            })
          ).json();
          const budgetHeaders = { authorization: 'Bearer ' + budgetLogin.token };
          const budgetProject = (
            await local.app.inject({
              method: 'POST',
              url: '/local/projects',
              headers: budgetHeaders,
              payload: {
                name: 'Native upper boundary',
                engine: 'Godot',
                description: 'Real 64-input protocol boundary',
              },
            })
          ).json<Project>();
          const budgetSession = (
            await local.app.inject({
              method: 'POST',
              url: '/local/sessions',
              headers: budgetHeaders,
              payload: { projectId: budgetProject.id },
            })
          ).json<SessionView>();
          await cp(resolve('examples/godot-startrail'), budgetProject.root, { recursive: true });
          const budgetGrant = (
            await local.app.inject({
              method: 'POST',
              url: `/local/projects/${budgetProject.id}/engine/prepare`,
              headers: budgetHeaders,
              payload: {},
            })
          ).json<EngineGrant>();
          const budgetConfirmed = await local.app.inject({
            method: 'POST',
            url: `/local/projects/${budgetProject.id}/engine`,
            headers: budgetHeaders,
            payload: { grantId: budgetGrant.grantId },
          });
          assert.equal(budgetConfirmed.statusCode, 200, budgetConfirmed.body);
          const budgetInput = {
            ...payload,
            requestId: randomUUID(),
            goal: '达到64次实际输入后保留最终观察，但不能宣称已完成',
            assertions: [{ field: 'driver_inputs', op: 'gte', value: 64 }],
          };
          const next = await local.playtests.startGodot(
            budgetLogin.user.id,
            budgetProject.id,
            budgetSession.id,
            budgetInput,
            budgetLogin.token,
            async () => {},
          );
          const limited = await local.playtests.wait(budgetLogin.user.id, next.id);
          assert.equal(limited.status, 'failed', JSON.stringify(limited));
          assert.match(limited.error || '', /步数预算/, JSON.stringify(limited));
          assert.equal(limited.steps, 64);
          assert.equal(limited.inputActions, 64);
          assert(
            limited.assertions.every((value) => value.passed),
            'the 64th real input must still have a final observation',
          );
          assert.equal(
            decisions - previousDecisions,
            64,
            'no 65th decision or physical input is attempted',
          );
          assert.equal(
            local.engines.get(budgetLogin.user.id, limited.engineJobId!).status,
            'completed',
            'the final quit must be accepted by the fixed harness',
          );
          const resumed = await local.playtests.startGodot(
            budgetLogin.user.id,
            budgetProject.id,
            budgetSession.id,
            budgetInput,
            budgetLogin.token,
            async () => {},
          );
          assert.equal(resumed.id, limited.id);
          assert.equal(
            decisions - previousDecisions,
            64,
            'reading a settled intent never replays prior game input',
          );
          return;
        }

        const captures = final.captures!;
        assert(captures.length <= 16 && captures.length > 8);
        assert.equal(new Set(captures.map((value) => value.id)).size, captures.length);
        for (const phase of ['preselect', 'battle', 'draft', 'boss', 'won'])
          assert(
            captures.some((value) => value.phase === phase),
            phase + ' needs a retained representative',
          );
        assert(
          captures.some((value) => value.id === 'capture-33'),
          'the DONE-step final readback is a new real capture, not a reused array index',
        );
        const events = local.traces.events(login.user.id, final.id).events;
        const observations = events
          .filter((value) => value.kind === 'observation' && value.name === '浏览器实际观测')
          .map(
            (value) =>
              local.traces.payloadValue(login.user.id, final.id, value.payloadRef!) as {
                capture: NonNullable<PlaytestJob['captures']>[number];
                image: { data: { $media: string } };
                observation: {
                  gameState: { wave: number; phase: string; preRound: number; bossLayer: number };
                };
              },
          );
        assert(
          observations.length > 16,
          'late captures must continue after the original fixed-window limit',
        );
        assert.equal(
          new Set(observations.map((value) => value.capture.id)).size,
          observations.length,
          'published IDs never repeat after eviction or final readback',
        );
        const retainedIds = new Set(captures.map((value) => value.id));
        const retained = observations.filter((value) => retainedIds.has(value.capture.id));
        assert(
          retained.some(
            (value) =>
              value.observation.gameState.phase === 'battle' &&
              value.observation.gameState.wave >= 4,
          ),
        );
        assert(retained.some((value) => value.observation.gameState.phase === 'boss'));
        assert(retained.some((value) => value.observation.gameState.phase === 'won'));
        assert(
          observations.findIndex((value) => value.observation.gameState.phase === 'boss') >= 16,
          'the fixture reaches Boss after early captures filled the former limit',
        );
        const elapsed = (Date.parse(final.endedAt!) - Date.parse(final.startedAt)) / 1000;
        assert(
          typeof final.finalCaptureSeconds === 'number' &&
            final.finalCaptureSeconds > 0 &&
            final.finalCaptureSeconds <= elapsed,
        );
        assert(captures.every((value) => value.seconds >= 0 && value.seconds <= elapsed));
        for (let index = 1; index < captures.length; index++) {
          assert(captures[index].seconds >= captures[index - 1].seconds);
          assert(Number(captures[index].id.slice(8)) > Number(captures[index - 1].id.slice(8)));
        }
        const folder = join(root, 'playtests', login.user.id, final.id);
        assert.equal(
          (await readdir(folder)).filter((value) => /^capture-\d+\.jpg$/.test(value)).length,
          captures.length,
        );
        for (const capture of captures) {
          const actual = await local.playtests.capture(login.user.id, final.id, capture.id);
          assert.equal(digest(actual.bytes), capture.sha256);
          assert.equal(actual.bytes.length, capture.bytes);
          assert.deepEqual(
            observations.find((value) => value.capture.id === capture.id)!.capture,
            capture,
            'retained manifests match the first immutable Trace receipt',
          );
        }
        const retired = observations.find((value) => !retainedIds.has(value.capture.id))!;
        assert(retired, 'the test must exercise real eviction');
        await assert.rejects(
          local.playtests.capture(login.user.id, final.id, retired.capture.id),
          /不存在/,
        );
        await assert.rejects(readFile(join(folder, retired.capture.id + '.jpg')));
        const archivedImage = local.traces.media(
          login.user.id,
          final.id,
          retired.image.data.$media,
        );
        assert.equal(
          digest(archivedImage.bytes),
          retired.capture.sha256,
          'eviction removes the preview file but preserves the original Trace evidence',
        );
        const tampered = captures.find((value) => value.phase === 'battle')!;
        await writeFile(join(folder, tampered.id + '.jpg'), 'forged screenshot');
        await assert.rejects(
          local.playtests.capture(login.user.id, final.id, tampered.id),
          /哈希不符/,
        );
        const screenshot = await local.playtests.screenshot(login.user.id, final.id);
        assert.equal(digest(screenshot), final.screenshotSha256);
      } finally {
        await local.app.close();
        await api.app.close();
        upstream.closeAllConnections();
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      }
    },
  );
