import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApi } from '../apps/api/server.ts';
import { upgradeSkills } from '../packages/shared/catalog.ts';
import type { Skill } from '../packages/shared/types.ts';

const additions = upgradeSkills.filter((skill) =>
  ['character-sprite-sequence', 'character-ultimate-alpha', 'batch-game-icons'].includes(skill.id),
);

test('v3 backfills the three asset workflows once without changing v2 skills, edits, disabled plugins or user-created records', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lm-skill-v3-'));
  let api = await createApi({ dataDir: dir, demo: true });
  try {
    const login = (
      await api.app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} })
    ).json();
    const owner = login.user.id,
      headers = { authorization: 'Bearer ' + login.token };
    const read = async () => {
      const response = await api.app.inject({ method: 'GET', url: '/api/bootstrap', headers });
      assert.equal(response.statusCode, 200, response.body);
      return response.json();
    };
    await read();
    assert.equal(additions.length, 3);
    const existing = api.store.list<Skill>('skill', owner);
    for (const skill of existing.filter((value) => additions.some((s) => s.name === value.name)))
      api.store.remove('skill', skill.id, owner);
    const browser = existing.find((skill) => skill.name === '浏览器游戏制作与试玩')!;
    const edited = {
      ...browser,
      content: '用户自定义内容，保持精确字节\n保留我的角色root和动作习惯。',
      enabled: false,
      revision: 19,
      updatedAt: '2026-10-01T00:00:00.000Z',
    };
    const userSkill = { ...edited, id: randomUUID(), name: '我的国风美术偏好', revision: 3 };
    api.store.put('skill', owner, edited);
    api.store.put('skill', owner, userSkill);
    const disabledPlugin = await api.app.inject({
      method: 'PATCH',
      url: '/api/plugins/image-generation',
      headers,
      payload: { enabled: false },
    });
    assert.equal(disabledPlugin.statusCode, 200, disabledPlugin.body);
    const pluginRows = api.store.list('plugin', owner);
    const oldSkills = api.store.list<Skill>('skill', owner);
    api.store.remove('skill-upgrade', owner + ':game-workflow-v3', owner);
    for (const version of ['v1', 'v2'])
      api.store.put('skill-upgrade', owner, {
        id: owner + ':game-workflow-' + version,
        appliedAt: '2026-11-01T00:00:00.000Z',
      });
    const oldMarkers = api.store.list<{ id: string }>('skill-upgrade', owner);

    const bootstrap = await read();
    const added = api.store
      .list<Skill>('skill', owner)
      .filter((skill) => additions.some((s) => s.name === skill.name));
    assert.equal(added.length, 3);
    for (const source of additions) {
      const matches = added.filter((skill) => skill.name === source.name);
      assert.equal(matches.length, 1);
      assert.equal(matches[0].content, source.content);
      assert.equal(matches[0].enabled, true);
    }
    for (const old of oldSkills) assert.deepEqual(api.store.get('skill', old.id, owner), old);
    for (const marker of oldMarkers)
      assert.deepEqual(api.store.get('skill-upgrade', marker.id, owner), marker);
    assert(api.store.get('skill-upgrade', owner + ':game-workflow-v3', owner));
    assert.deepEqual(api.store.list('plugin', owner), pluginRows);
    assert.equal(
      bootstrap.plugins.find((plugin: { id: string }) => plugin.id === 'image-generation').enabled,
      false,
    );
    for (const id of ['image-generation', 'video-generation'])
      assert(
        bootstrap.plugins
          .find((plugin: { id: string }) => plugin.id === id)
          .tools.includes('prepare_game_asset'),
      );

    // The migration is durable, and later explicit user choices are not undone.
    const disabled = { ...added[0], enabled: false, content: '我已修改的序列帧流程', revision: 4 };
    api.store.put('skill', owner, disabled);
    api.store.remove('skill', added[1].id, owner);
    const chosen = api.store.list<Skill>('skill', owner);
    await read();
    assert.deepEqual(api.store.list<Skill>('skill', owner), chosen);
    await api.app.close();
    api = await createApi({ dataDir: dir, demo: true });
    const resumed = (
      await api.app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} })
    ).json();
    assert.equal(resumed.user.id, owner);
    headers.authorization = 'Bearer ' + resumed.token;
    await read();
    assert.deepEqual(api.store.list<Skill>('skill', owner), chosen);
    assert.deepEqual(api.store.list('plugin', owner), pluginRows);
    assert.equal(api.store.list<Skill>('skill', 'unrelated').length, 0);
  } finally {
    await api.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('v3 keeps a disabled custom skill with a built-in name and backfills the missing reference-game workflow', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lm-skill-v3-name-'));
  const api = await createApi({ dataDir: dir, demo: true });
  try {
    const login = (
      await api.app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} })
    ).json();
    const owner = login.user.id,
      headers = { authorization: 'Bearer ' + login.token };
    await api.app.inject({ method: 'GET', url: '/api/bootstrap', headers });
    for (const skill of api.store.list<Skill>('skill', owner))
      if (additions.some((s) => s.name === skill.name) || skill.name === '参考游戏复刻与构筑验收')
        api.store.remove('skill', skill.id, owner);
    const custom: Skill = {
      ...additions[0],
      id: randomUUID(),
      enabled: false,
      revision: 7,
      content: '这是用户自行编写的同名流程，不能被内置正文替换。',
      updatedAt: '2026-10-01T00:00:00.000Z',
    };
    api.store.put('skill', owner, custom);
    api.store.remove('skill-upgrade', owner + ':game-workflow-v3', owner);
    api.store.put('skill-upgrade', owner, { id: owner + ':game-workflow-v1' });
    const response = await api.app.inject({ method: 'GET', url: '/api/bootstrap', headers });
    assert.equal(response.statusCode, 200, response.body);
    const skills = api.store.list<Skill>('skill', owner);
    assert.deepEqual(api.store.get('skill', custom.id, owner), custom);
    assert.equal(skills.filter((skill) => skill.name === custom.name).length, 1);
    for (const source of additions.slice(1))
      assert.equal(skills.filter((skill) => skill.name === source.name).length, 1);
    const reference = skills.filter((skill) => skill.name === '参考游戏复刻与构筑验收');
    assert.equal(reference.length, 1);
    assert(reference[0].content.includes('newRun'));
    await api.app.inject({ method: 'GET', url: '/api/bootstrap', headers });
    assert.deepEqual(api.store.list<Skill>('skill', owner), skills);
  } finally {
    await api.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('fresh accounts receive one enabled copy of each asset workflow and current image/video preparation declarations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lm-skill-v3-new-'));
  const api = await createApi({ dataDir: dir, demo: true });
  try {
    const login = (
      await api.app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} })
    ).json();
    const headers = { authorization: 'Bearer ' + login.token };
    const response = await api.app.inject({ method: 'GET', url: '/api/bootstrap', headers });
    assert.equal(response.statusCode, 200, response.body);
    const bootstrap = response.json();
    for (const source of additions) {
      const skills = bootstrap.skills.filter((skill: Skill) => skill.name === source.name);
      assert.equal(skills.length, 1);
      assert.equal(skills[0].enabled, true);
      const resource = await api.app.inject({
        method: 'GET',
        url: '/api/skills/' + skills[0].id,
        headers,
      });
      assert.equal(resource.statusCode, 200, resource.body);
      assert.equal(resource.json().content, source.content);
    }
    for (const id of ['image-generation', 'video-generation'])
      assert(
        bootstrap.plugins
          .find((plugin: { id: string }) => plugin.id === id)
          .tools.includes('prepare_game_asset'),
      );
  } finally {
    await api.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
