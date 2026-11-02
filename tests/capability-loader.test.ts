import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { capabilityLoader } from '../apps/agent/capability-loader.ts';
const pool = [
  'read_file',
  'write_file',
  'generate_image',
  'generate_video',
  'prepare_game_asset',
  'analyze_reference',
  'run_browser_playtest',
].map((name) => ({ name })) as AgentTool[];
test('ordinary reference-game instructions expose authorized creation, vision, playtest and image skills without mistaking reference video for a video-generation request', () => {
  const names = capabilityLoader(pool, '复刻参考录屏里的游戏，保留角色与战斗风格', false)
    .select()
    .map((t) => t.name);
  for (const name of ['write_file', 'generate_image', 'analyze_reference', 'run_browser_playtest'])
    assert(names.includes(name));
  assert(!names.includes('generate_video'));
  assert(
    capabilityLoader(pool, '为角色生成大招动画和过场CG视频', false)
      .select()
      .some((t) => t.name === 'generate_video'),
  );
  const plan = capabilityLoader(pool, '复刻参考录屏里的游戏', true)
    .select()
    .map((t) => t.name);
  assert(
    !plan.includes('write_file') &&
      !plan.includes('generate_image') &&
      !plan.includes('generate_video'),
  );
  assert(
    capabilityLoader(pool, '保存当前产物', false)
      .select()
      .some((t) => t.name === 'write_file'),
  );
  for (const intent of ['制作角色走路序列帧', '生成一组游戏图标', '将大招动画抠成透明背景']) {
    const tools = capabilityLoader(pool, intent, false)
      .select()
      .map((t) => t.name);
    assert(tools.includes('prepare_game_asset'), intent);
  }
  assert(
    !capabilityLoader(pool, '生成透明角色序列帧', true)
      .select()
      .some((t) => t.name === 'prepare_game_asset'),
  );
});
