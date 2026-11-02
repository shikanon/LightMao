import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createApi } from '../apps/api/server.ts';
import { createLocalAgent } from '../apps/agent/server.ts';
import { BrowserDriver } from '../apps/agent/browser-driver.ts';
// Deterministic input checks of the already generated artifacts. No model credentials.
// This does not mark the interrupted live Agent goals complete.
const id = randomUUID(),
  dir = resolve('.lightmao/verification/generated-offline-' + id),
  gallery = resolve(
    '/Users/bytedance/.codex/visualizations/2026/11/02/lightmao-upgrade/generated-offline-' + id,
  );
await mkdir(dir, { recursive: true, mode: 0o700 });
await mkdir(gallery, { recursive: true, mode: 0o700 });
const receipt = {
  id,
  dir,
  gallery,
  at: new Date().toISOString(),
  decisionProvider: 'none; deterministic observed controls',
  modelRequests: 0,
  passed: false,
  results: [],
};
const save = () =>
  writeFile(join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
await save();
const api = await createApi({ dataDir: dir, demo: true });
await api.app.listen({ host: '127.0.0.1', port: 0 });
const local = await createLocalAgent({
  dataDir: dir,
  apiUrl: `http://127.0.0.1:${api.app.server.address().port}`,
  godotPath: resolve('.lightmao/tools/godot/4.7.2/Godot.app'),
});
let driver;
try {
  const login = (
      await api.app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} })
    ).json(),
    headers = { authorization: 'Bearer ' + login.token };
  const call = async (method, url, payload) => {
    const r = await local.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };
  for (const kind of ['browser', 'godot']) {
    const sourceReceipt =
      kind === 'browser'
        ? '.lightmao/verification/upgrade-games-1b946304-2b04-448a-b449-69def31ff994'
        : '.lightmao/verification/upgrade-games-00e7c4f0-cbe9-474d-abc9-05babe194d85';
    const source = JSON.parse(
      await readFile(join(sourceReceipt, 'receipt.json'), 'utf8'),
    ).results.find((r) => r.kind === kind);
    const db = new DatabaseSync(join(sourceReceipt, 'local.sqlite'), { readOnly: true });
    const original = JSON.parse(
      db.prepare("SELECT data FROM records WHERE kind='project' AND id=?").get(source.projectId)
        .data,
    );
    db.close();
    const p = await call('POST', '/local/projects', {
      name: kind === 'browser' ? '星轨冲刺（生成作品检查）' : '星轨守卫（修复副本检查）',
      engine: kind === 'browser' ? 'Web' : 'Godot',
      description:
        'Already-generated artifact; deterministic local checks. Original files preserved.',
    });
    await cp(original.root, p.root, { recursive: true });
    const result = {
      kind,
      projectId: p.id,
      root: p.root,
      sourceReceipt,
      originalProjectId: source.projectId,
      states: [],
      developerFixes: [],
    };
    receipt.results.push(result);
    await save();
    if (kind === 'browser') {
      const file = join(p.root, 'game.js'),
        before = await readFile(file, 'utf8');
      const broken = "${phase==='won'?'成功穿越星轨！'}",
        replacement = "${phase==='won'?'成功穿越星轨！':'航行结束'}";
      if (before.includes(broken)) {
        const fixed = before.replace(broken, replacement);
        await writeFile(file, fixed);
        result.developerFixes.push({
          file: 'game.js',
          reason:
            'Repair the reported incomplete conditional expression in a copy; not an autonomous Agent repair.',
          beforeSha256: createHash('sha256').update(before).digest('hex'),
          afterSha256: createHash('sha256').update(fixed).digest('hex'),
        });
      }
      let html = await readFile(join(p.root, 'index.html'), 'utf8');
      const htmlBefore = html;
      for (const [oldId, newId] of [
        ['playtest-data', 'playtestState'],
        ['overlayTitle', 'finalTitle'],
        ['overlayText', 'finalDetail'],
        ['cooldownFill', 'dashFill'],
        ['goal', 'time'],
      ])
        html = html.replace('id="' + oldId + '"', 'id="' + newId + '"');
      html = html
        .replace('<span>冲刺能量</span>', '<span id="dashText">冲刺能量</span>')
        .replace('class="hud-card wide"', 'class="hud-card wide" id="dashCard"')
        .replace('width="960" height="600"', 'width="900" height="640"')
        .replace(
          '</section>',
          '<div class="hud-card"><span>最佳</span><strong id="best">0</strong></div></section>',
        )
        .replace('90秒', '75秒')
        .replace('至少收集 12 颗星光', '累计至少 650 分');
      await writeFile(join(p.root, 'index.html'), html);
      let js = await readFile(file, 'utf8');
      js = js
        .replace(
          "ov.classList.toggle('show',phase!=='playing')",
          "ov.classList.toggle('hidden',phase==='playing')",
        )
        .replace("if(k==='r'&&phase!=='playing') reset()", "if(k==='r') reset()");
      await writeFile(file, js);
      result.developerFixes.push({
        file: 'index.html + game.js',
        reason:
          'Align HUD/state IDs and canvas size, overlay visibility, and advertised restart behavior in the review copy.',
        beforeSha256: createHash('sha256').update(htmlBefore).digest('hex'),
        afterSha256: createHash('sha256').update(html).digest('hex'),
      });
      const preview = await local.playtests.createPreview(
        login.user.id,
        p.id,
        'index.html',
        async () => {},
      );
      driver = new BrowserDriver(join(dir, 'browser-profile'));
      let o = (await driver.init(preview.url, true)).observation;
      result.states.push(o.gameState);
      const initialShot = await driver.screenshot();
      result.runtimeErrors = initialShot.errors;
      await save();
      assert.deepEqual(initialShot.errors, []);
      const perform = async (find) => {
        const action = o.actions.find(find);
        assert(action, 'Required real control not found');
        o = (await driver.act(o.id, action.id)).observation;
        result.states.push(o.gameState);
        return o.gameState;
      };
      await perform((a) => a.operation === 'CLICK' && /开始/.test(a.label));
      assert.equal(o.gameState.phase, 'playing');
      const x = o.gameState.player_x;
      await perform((a) => a.operation === 'PRESS_KEY' && a.key === 'RIGHT');
      assert(o.gameState.player_x > x + 20, 'Actual right input did not move player');
      await perform((a) => a.operation === 'PRESS_KEY' && a.key === 'SPACE');
      assert(o.gameState.dash_cooldown > 0, 'Actual dash input did not start cooldown');
      const shot = await driver.screenshot();
      assert.deepEqual(shot.errors, []);
      result.screenshot = join(gallery, 'browser-generated-actual.png');
      await writeFile(result.screenshot, Buffer.from(shot.base64, 'base64'));
      await perform((a) => a.operation === 'PRESS_KEY' && a.key === 'R');
      assert.equal(o.gameState.phase, 'playing');
      assert.equal(o.gameState.score, 0);
      assert.equal(o.gameState.dash_cooldown, 0);
      await driver.close();
      driver = undefined;
      await local.playtests.closePreview(login.user.id, preview.id);
    } else {
      const file = join(p.root, 'main.gd'),
        before = await readFile(file, 'utf8');
      let fixed = before;
      for (const [name, type] of [
        ['dangerous', 'bool'],
        ['speed', 'float'],
        ['in_x', 'bool'],
        ['in_y', 'bool'],
        ['gain', 'int'],
      ])
        fixed = fixed.replaceAll(
          new RegExp('var ' + name + '\\s*:=', 'g'),
          'var ' + name + ': ' + type + ' =',
        );
      fixed = fixed.replace(
        '"生命 %s" % ["♥", "♥", "♥"]',
        '"生命 %s" % ["♥".repeat(lives) + "♡".repeat(maxi(0, MAX_LIVES-lives))]',
      );
      if (fixed !== before) {
        await writeFile(file, fixed);
        result.developerFixes.push({
          file: 'main.gd',
          reason:
            'Explicit GDScript types for the reported inference errors; developer repair in a copy, not a successful autonomous model repair.',
          beforeSha256: createHash('sha256').update(before).digest('hex'),
          afterSha256: createHash('sha256').update(fixed).digest('hex'),
        });
      }
      const grant = await call('POST', `/local/projects/${p.id}/engine/prepare`, {});
      await call('POST', `/local/projects/${p.id}/engine`, { grantId: grant.grantId });
      const job = await local.engines.start(
        login.user.id,
        p.id,
        {
          action: 'playtest',
          visible: true,
          frames: 3600,
          timeoutSeconds: 60,
          requestId: id + ':native',
        },
        async () => {},
      );
      let o;
      try {
        o = await local.engines.godotObservation(login.user.id, job.id);
      } catch (error) {
        result.engine = local.engines.get(login.user.id, job.id);
        result.log = local.engines.logs(login.user.id, job.id, { limit: 4000 }).text;
        await save();
        throw error;
      }
      result.states.push(o.state);
      const perform = async (id) => {
        await local.engines.godotInput(login.user.id, job.id, o.id, id);
        o = await local.engines.godotObservation(login.user.id, job.id, o.id);
        result.states.push(o.state);
      };
      await perform('start');
      assert.equal(o.state.phase, 'playing');
      const x = o.state.player_x;
      await perform('right');
      assert(o.state.player_x > x + 20);
      await perform('left_long');
      assert(o.state.player_x < x);
      await perform('restart');
      assert.equal(o.state.phase, 'playing');
      assert.equal(o.state.score, 0);
      assert.equal(o.state.lives, 3);
      await local.engines.godotInput(login.user.id, job.id, o.id, undefined, true);
      const final = await local.engines.wait(login.user.id, job.id);
      result.engine = final;
      assert.equal(final.status, 'completed', JSON.stringify(final));
      const png = final.artifacts.find((a) => a.path === 'native-playtest.png');
      assert(png);
      const data = await local.engines.artifact(login.user.id, job.id, png.id);
      result.screenshot = join(gallery, 'godot-generated-repaired-actual.png');
      await writeFile(result.screenshot, data.bytes);
      assert.equal(
        await readFile(join(original.root, 'main.gd'), 'utf8'),
        before,
        'Original generated source changed',
      );
    }
    result.passed = true;
    result.reviewProject = join(gallery, kind + '-project');
    await cp(p.root, result.reviewProject, { recursive: true });
    await save();
  }
  receipt.passed = true;
} catch (error) {
  receipt.error = error instanceof Error ? error.message : 'Local generated artifact check failed';
  process.exitCode = 1;
} finally {
  await driver?.close();
  await local.app.close();
  await api.app.close();
  await save();
}
console.log(
  JSON.stringify({
    receipt: join(dir, 'receipt.json'),
    passed: receipt.passed,
    error: receipt.error,
    results: receipt.results.map(({ kind, passed, screenshot, reviewProject, developerFixes }) => ({
      kind,
      passed,
      screenshot,
      reviewProject,
      developerFixes,
    })),
  }),
);
