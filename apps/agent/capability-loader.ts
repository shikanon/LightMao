import { Type } from 'typebox';
import { z } from 'zod';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { collaborationToolNames } from './collaboration-tools.ts';

/** Loading declarations never grants permissions; every call still rechecks current policy. */
export function capabilityLoader(
  pool: AgentTool[],
  intent: string,
  planning: boolean,
  project: (tools: AgentTool[]) => AgentTool[] = (tools) => tools,
) {
  const groups: Record<string, string[]> = {
    project: ['write_file', 'edit_file', 'asset_inventory'],
    collaboration: collaborationToolNames,
    perception: [
      'list_references',
      'analyze_reference',
      'analyze_attachment',
      'get_perception_result',
      'evaluate_game_visuals',
      'inspect_playtest_capture',
    ],
    image: [
      'generate_image',
      'get_media_job',
      'wait_media_job',
      'import_generated_asset',
      'prepare_game_asset',
    ],
    video: [
      'generate_video',
      'get_media_job',
      'wait_media_job',
      'import_generated_asset',
      'prepare_game_asset',
    ],
    game: [
      'start_game_preview',
      'run_browser_playtest',
      'run_godot_playtest',
      'read_playtest_log',
      'run_godot',
      'read_engine_log',
    ],
  };
  const deferred = new Set(Object.values(groups).flat());
  const loaded = new Set<string>();
  if (!planning) {
    if (
      !/不写|不要写|只读|仅阅读|read.?only/i.test(intent) &&
      /创建|实现|修复|修改|生成|开发|复刻|还原|写入|写文件|保存|添加|补齐|做一个|制作|build|create|implement|fix|edit|write|save/i.test(
        intent,
      )
    )
      loaded.add('project');
    if (/sub.?agents?|多\s*agent|子\s*agent|协作|分工/i.test(intent)) loaded.add('collaboration');
    if (
      /图片|立绘|角色图|贴图|序列帧|图标|透明|角色.{0,8}(走|跑|待机|动画)|sprite|seedream/i.test(
        intent,
      ) ||
      (/参考|复刻|还原|reference/i.test(intent) && /游戏|godot|game/i.test(intent))
    )
      loaded.add('image');
    if (/生成.{0,24}视频|制作.{0,24}视频|视频生成|大招动画|过场|seedance|\bCG\b/i.test(intent))
      loaded.add('video');
    if (/游戏|godot|试玩|playtest|game/i.test(intent)) loaded.add('game');
    if (/参考|视觉|音频|录屏|评分|感知|序列帧|图标|透明|reference|perception/i.test(intent))
      loaded.add('perception');
  }
  const loader: AgentTool = {
    name: 'load_capabilities',
    label: '按需加载能力',
    description:
      'Load already-authorized tools on demand: project (write/edit files, asset inventory), game (browser/Godot playtests), image, video, collaboration (Sub-Agents, leases, live evidence). Select capabilities from natural-language intent; do not ask users for tool names. Loading never executes or grants permissions. Available next turn.',
    parameters: Type.Object({
      groups: Type.Array(Type.Union(Object.keys(groups).map((v) => Type.Literal(v))), {
        minItems: 1,
        maxItems: 4,
      }),
    }),
    execute: async (_, args) => {
      const input = z
        .object({
          groups: z
            .array(z.enum(['project', 'game', 'image', 'video', 'collaboration', 'perception']))
            .min(1)
            .max(4),
        })
        .strict()
        .parse(args);
      if (planning) throw Error('Plan模式只读，不加载执行能力');
      for (const group of input.groups) loaded.add(group);
      const available = select().map((t) => t.name),
        withheld = pool
          .filter(
            (t) =>
              [...loaded].some((g) => groups[g].includes(t.name)) && !available.includes(t.name),
          )
          .map((t) => t.name);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              loaded: [...loaded],
              available,
              ...(withheld.length
                ? {
                    temporarilyWithheld: withheld,
                    note: '能力已加载；当前阶段要求先实际试玩，重复load不能恢复暂缓的读取或写入。请使用当前available中的真实试玩工具取得错误或状态证据。',
                  }
                : {}),
            }),
          },
        ],
        details: {},
      };
    },
  };
  function select() {
    const names = new Set([...loaded].flatMap((g) => groups[g]));
    return project([
      ...pool.filter((t) => !deferred.has(t.name) || names.has(t.name)),
      ...(!planning ? [loader] : []),
    ]);
  }
  return { select };
}
