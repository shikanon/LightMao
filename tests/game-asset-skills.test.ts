import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upgradeSkills } from '../packages/shared/catalog.ts';

test('asset skills fit one resource page and keep decoded-alpha, fixed-root and separate acceptance requirements together', () => {
  const ids = ['character-sprite-sequence', 'character-ultimate-alpha', 'batch-game-icons'];
  for (const id of ids) {
    const skill = upgradeSkills.find((value) => value.id === id)!;
    assert(skill);
    assert(skill.enabled);
    // read_skill_resource has a 4,000-character page: no critical rule is hidden
    // beyond the initial read for these short, self-contained workflows.
    assert(skill.content.length <= 4000, skill.name + ' needs more than one resource page');
    for (const term of [
      'jobId',
      'get_media_job',
      'wait_media_job',
      'import_generated_asset',
      'prepare_game_asset',
      'decoded alpha',
      'technicalPassed',
      'characterRootVerified:false',
      'manifest.json',
      'preview.html',
      'frameAnchors',
      'worldRoot',
      'worldLocked',
      'Canvas',
      'Godot',
    ])
      assert(skill.content.includes(term), `${skill.name} lost ${term}`);
    assert(skill.content.includes('禁止逐帧裁边'));
    assert(skill.content.includes('bbox重新居中'));
    assert(skill.content.includes('不要求用户说插件名'));
    assert(skill.content.includes('不重新提交收费生成'));
    assert(
      skill.content.includes('技术') &&
        skill.content.includes('视觉评审') &&
        skill.content.includes('游戏内验收'),
    );
  }
  const sprite = upgradeSkills.find((value) => value.id === ids[0])!;
  const ultimate = upgradeSkills.find((value) => value.id === ids[1])!;
  const icons = upgradeSkills.find((value) => value.id === ids[2])!;
  assert(sprite.content.includes('逐帧相位表') && sprite.content.includes('kind:"sprite_sheet"'));
  assert(
    ultimate.content.includes('kind:"ultimate_video"') &&
      ultimate.content.includes('不能再叠一层完整角色'),
  );
  assert(
    icons.content.includes('names.length必须等于count') &&
      icons.content.includes('row-major') &&
      icons.content.includes('square'),
  );
  assert(icons.content.includes('不能只改count/names'));
});
