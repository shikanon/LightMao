import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access, cp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createApi } from '../apps/api/server.ts';
import { createLocalAgent } from '../apps/agent/server.ts';
import type { EngineGrant, Project } from '../packages/shared/types.ts';
const godot = resolve('.lightmao/tools/godot/4.7.2/Godot.app');
let available = process.platform === 'darwin';
try {
  await access(godot);
} catch {
  available = false;
}
test(
  'native Godot playtest holds the real scene, applies only observed physical keys, advances frames and rejects stale input',
  { skip: !available, timeout: 30000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'lm-godot-input-'));
    const api = await createApi({ dataDir: root, demo: true });
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
      const create = await local.app.inject({
        method: 'POST',
        url: '/local/projects',
        headers,
        payload: {
          name: 'Native input',
          engine: 'Godot',
          description: 'Isolated native frame test',
        },
      });
      assert.equal(create.statusCode, 200, create.body);
      const project = create.json<Project>();
      await cp(resolve('examples/godot-startrail'), project.root, { recursive: true });
      const before = await readFile(join(project.root, 'main.gd'));
      const grant = (
        await local.app.inject({
          method: 'POST',
          url: `/local/projects/${project.id}/engine/prepare`,
          headers,
          payload: {},
        })
      ).json<EngineGrant>();
      const confirm = await local.app.inject({
        method: 'POST',
        url: `/local/projects/${project.id}/engine`,
        headers,
        payload: { grantId: grant.grantId },
      });
      assert.equal(confirm.statusCode, 200, confirm.body);
      const job = await local.engines.start(
        login.user.id,
        project.id,
        { action: 'playtest', requestId: randomUUID(), frames: 3600, timeoutSeconds: 20 },
        async () => {},
      );
      let initial;
      try {
        initial = await local.engines.godotObservation(login.user.id, job.id);
      } catch (e) {
        throw Error(
          String(e) +
            ' ' +
            JSON.stringify(local.engines.get(login.user.id, job.id)) +
            ' ' +
            local.engines.logs(login.user.id, job.id, { limit: 4000 }).text,
        );
      }
      assert.equal(initial.state.player_x, 120);
      assert(initial.actions.some((a) => a.id === 'right'));
      await local.engines.godotInput(login.user.id, job.id, initial.id, 'right');
      const next = await local.engines.godotObservation(login.user.id, job.id, initial.id);
      assert(
        Number(next.state.player_x) > 120,
        'Godot physical key input must actually move the game state',
      );
      assert.equal(next.state.driver_inputs, 1);
      await assert.rejects(() =>
        local.engines.godotInput(login.user.id, job.id, initial.id, 'right'),
      );
      await assert.rejects(() =>
        local.engines.godotInput(login.user.id, job.id, next.id, 'unobserved'),
      );
      await local.engines.godotInput(login.user.id, job.id, next.id, undefined, true);
      const final = await local.engines.wait(login.user.id, job.id);
      assert.equal(final.status, 'completed', JSON.stringify(final));
      assert.equal(final.verification, 'unreported');
      assert.deepEqual(
        final.phases.map((p) => [p.name, p.code]),
        [
          ['import', 0],
          ['playtest', 0],
        ],
      );
      assert(final.artifacts.some((a) => a.path === 'playtest-observations.json'));
      assert.deepEqual(await readFile(join(project.root, 'main.gd')), before);
    } finally {
      await local.app.close();
      await api.app.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
