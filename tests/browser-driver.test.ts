import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { BrowserDriver } from '../apps/agent/browser-driver.ts';
import { jevQuestions, jevDecision } from '../packages/shared/system-one.ts';
test(
  'owned Electron observes actual nodes, types/clicks/presses keys, and rejects stale, unobserved and occluded targets',
  { skip: process.platform !== 'darwin', timeout: 30000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'lm-browser-guard-'));
    const prefix = '/' + randomBytes(24).toString('hex') + '/';
    const html = `<!doctype html><meta charset="utf-8"><title>LightMao Native Input Fixture</title>
  <input aria-label="玩家名称"><button id="start">开始游戏</button><button id="cover">遮挡开始按钮</button><p id="status">菜单</p><script type="application/json" data-lightmao-playtest></script>
  <script>let score=0,phase='menu';function update(){document.querySelector('[data-lightmao-playtest]').textContent=JSON.stringify({state:{score,phase},actions:[{id:'collect',label:'按空格收集星星',key:'SPACE',holdMs:80}]});document.querySelector('#status').textContent=phase+' '+score}
  document.querySelector('#start').onclick=()=>{phase='playing';update()};document.querySelector('#cover').onclick=()=>{let e=document.createElement('div');e.style='position:fixed;inset:0;background:#fffe;z-index:99';e.textContent='遮挡层';document.body.append(e)};
  addEventListener('keydown',e=>{if(e.key===' '&&phase==='playing'){score++;update()}});update();</script>`;
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' });
      res.end(html);
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const driver = new BrowserDriver(join(root, 'profile'));
    try {
      const ready = await driver.init(
        `http://127.0.0.1:${(server.address() as { port: number }).port}${prefix}index.html`,
      );
      assert(ready.sandbox && ready.contextIsolation && !ready.nodeIntegration);
      assert.equal(ready.observation.title, 'LightMao Native Input Fixture');
      let observation = ready.observation;
      const fill = observation.actions.find((a) => a.operation === 'TYPE_TEXT')!;
      assert(fill);
      observation = (await driver.act(observation.id, fill.id, '小猫')).observation;
      assert.equal(observation.actions.find((a) => a.id === fill.id)?.value, '小猫');
      await assert.rejects(
        () => driver.act(ready.observation.id, fill.id, 'old'),
        (e: any) => e.outcome === 'not_executed',
      );
      const start = observation.actions.find((a) => a.label === '开始游戏')!;
      observation = (await driver.act(observation.id, start.id)).observation;
      assert.equal(observation.gameState?.phase, 'playing');
      const press = observation.actions.find((a) => a.operation === 'PRESS_KEY')!;
      observation = (await driver.act(observation.id, press.id)).observation;
      assert.equal(
        observation.gameState?.score,
        1,
        'Actual keyboard input reaches the game handler',
      );
      await assert.rejects(() => driver.act(observation.id, 'unobserved:eval'));
      const cover = observation.actions.find((a) => a.label === '遮挡开始按钮')!;
      observation = (await driver.act(observation.id, cover.id)).observation;
      await assert.rejects(
        () => driver.act(observation.id, start.id),
        (e: any) => e.outcome === 'not_executed',
      );
      const screenshot = await driver.screenshot();
      assert(Buffer.from(screenshot.base64, 'base64').subarray(1, 4).equals(Buffer.from('PNG')));
      assert.deepEqual(screenshot.errors, []);
    } finally {
      await driver.close();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
test(
  'real Electron WAIT advances an autonomous scene without replaying a reversible control',
  {
    skip: process.platform !== 'darwin',
    timeout: 30000,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'lm-browser-wait-')),
      prefix = '/' + randomBytes(24).toString('hex') + '/';
    const html = `<!doctype html><meta charset="utf-8"><title>Autonomous progress and WAIT fixture</title>
  <h1>自动推进协议夹具</h1><p>按2切换播放速度；已开始自动推进，等待即可继续。</p><p id="state"></p>
  <script type="application/json" data-lightmao-playtest></script><script>
  let progress=0,timeScale=1,toggleCount=0;
  function update(){const state={phase:progress>=100?'won':'playing',auto:true,progress,timeScale,toggleCount};document.querySelector('[data-lightmao-playtest]').textContent=JSON.stringify({state,actions:[{id:'tempo',label:'切换播放速度',key:'2',holdMs:20}]});document.querySelector('#state').textContent=JSON.stringify(state)}
  addEventListener('keydown',e=>{if(e.key==='2'){timeScale=timeScale===1?4:1;toggleCount++;update()}});
  setInterval(()=>{progress+=timeScale;update()},50);update();</script>`;
    const server = createServer((_req, res) =>
      res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }).end(html),
    );
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const driver = new BrowserDriver(join(root, 'profile'));
    const waits: { elapsedMs: number; progress: unknown }[] = [];
    try {
      let observation = (
        await driver.init(
          `http://127.0.0.1:${(server.address() as { port: number }).port}${prefix}index.html`,
        )
      ).observation;
      assert.deepEqual(observation.recentActions, []);
      const tempo = observation.actions.find((a) => a.id === 'game:tempo')!;
      const before = observation.id;
      observation = (await driver.act(observation.id, tempo.id)).observation;
      assert.equal(observation.gameState?.timeScale, 4);
      const effect = observation.recentActions!.at(-1)!;
      assert.equal(effect.actionId, tempo.id);
      assert.equal(effect.observationId, before);
      assert.equal(effect.afterObservationId, observation.id);
      assert.equal(effect.beforeGameState?.timeScale, 1);
      assert.equal(effect.afterGameState?.timeScale, 4);
      assert(effect.changedKeys.includes('timeScale'));
      const choice = (id: string, candidates: string[]) => ({
        choice: id,
        confidence: 1,
        probabilities: Object.fromEntries(candidates.map((v) => [v, v === id ? 1 : 0])),
      });
      for (let step = 0; step < 2 && observation.gameState?.phase !== 'won'; step++) {
        const request = jevQuestions(observation, '等待自动流程结束，已经加速后不要来回切换', [
          { target: '旧的速度标签' },
        ]);
        const decision = jevDecision(
          request,
          {
            model: 'explicit-local-fixture',
            answers: {
              operation: choice('WAIT', ['WAIT', 'PRESS_KEY', 'DONE', 'BLOCKED']),
              wait_target: choice('wait', ['wait']),
            },
          },
          observation,
        );
        assert.equal(decision.action?.operation, 'WAIT');
        const progressBefore = Number(observation.gameState?.progress),
          started = Date.now();
        observation = (await driver.act(observation.id, decision.action!.id)).observation;
        const elapsedMs = Date.now() - started;
        assert(elapsedMs >= 950, `WAIT returned prematurely in ${elapsedMs}ms`);
        assert(
          Number(observation.gameState?.progress) > progressBefore,
          'Actual timer progresses while no input is dispatched',
        );
        assert.equal(observation.gameState?.timeScale, 4);
        assert.equal(
          observation.gameState?.toggleCount,
          1,
          'Waiting never replays the earlier reversible input',
        );
        assert.equal(observation.recentActions!.at(-1)!.operation, 'WAIT');
        assert(observation.recentActions!.at(-1)!.changedKeys.includes('progress'));
        waits.push({ elapsedMs, progress: observation.gameState?.progress });
      }
      assert.equal(observation.gameState?.phase, 'won');
      assert.equal(observation.recentActions!.filter((a) => a.operation === 'PRESS_KEY').length, 1);
      const screenshot = await driver.screenshot();
      assert.deepEqual(screenshot.errors, []);
      if (process.env.LIGHTMAO_QA_ARTIFACT_DIR) {
        await mkdir(process.env.LIGHTMAO_QA_ARTIFACT_DIR, { recursive: true });
        await writeFile(
          join(process.env.LIGHTMAO_QA_ARTIFACT_DIR, 'native-wait.png'),
          Buffer.from(screenshot.base64, 'base64'),
        );
        await writeFile(
          join(process.env.LIGHTMAO_QA_ARTIFACT_DIR, 'native-wait.json'),
          JSON.stringify(
            {
              passed: true,
              waits,
              finalState: observation.gameState,
              history: observation.recentActions,
              scope:
                'Real Electron input/timer evidence with an explicit local decision fixture; not a paid System One decision quality benchmark.',
            },
            null,
            2,
          ),
        );
      }
    } finally {
      await driver.close();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
