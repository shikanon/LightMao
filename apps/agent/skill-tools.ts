import { Type } from 'typebox';
import { z } from 'zod';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Skill, SkillSummary } from '../../packages/shared/types.ts';
import type { LocalSkills } from './skills.ts';
import {
  skillSummary,
  textPage,
  resourcePath,
  SKILL_LIMITS,
  skillError as fail,
} from '../../packages/skills/format.ts';

export function createSkillReader(
  selected: SkillSummary[],
  local: LocalSkills,
  owner: string,
  cloud: (id: string) => Promise<Skill>,
): AgentTool {
  return {
    name: 'read_skill_resource',
    label: '读取可用技能资源',
    description:
      '读取本轮自动发现或用户选中技能的 SKILL.md 或资源文本。按任务自行选择，先读取 SKILL.md。只读，每页最多4000字符；不会执行脚本或授予新权限。技能ID和版本来自本轮可用技能元数据。',
    parameters: Type.Object({
      skillId: Type.String({ maxLength: 128 }),
      path: Type.Optional(Type.String({ maxLength: 240 })),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 4 * 1024 * 1024 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: SKILL_LIMITS.pageChars })),
    }),
    execute: async (_, args, signal) => {
      try {
        signal?.throwIfAborted();
        const input = z
          .object({
            skillId: z.string().min(1).max(128),
            path: z.string().max(240).optional(),
            offset: z
              .number()
              .int()
              .min(0)
              .max(4 * 1024 * 1024)
              .optional(),
            limit: z.number().int().min(1).max(4000).optional(),
          })
          .strict()
          .parse(args);
        const selectedSkill =
          selected.find((skill) => skill.id === input.skillId) || fail(403, '这个技能未在本轮选择');
        const path = resourcePath(input.path || 'SKILL.md');
        let result: unknown;
        if (selectedSkill.origin === 'local')
          result = await local.page(owner, selectedSkill.id, path, input, selectedSkill.sha256);
        else {
          if (path !== 'SKILL.md') fail(404, '云端 Markdown 技能只有 SKILL.md 正文');
          const current = await cloud(selectedSkill.id);
          if (!current.enabled || skillSummary(current).sha256 !== selectedSkill.sha256)
            fail(409, '技能已更新或停用，请重新选择后开始下一轮', 'SKILL_CHANGED');
          result = {
            path,
            sha256: selectedSkill.sha256,
            ...textPage(Buffer.from(current.content), input),
          };
        }
        signal?.throwIfAborted();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                source: 'selected-skill-resource',
                skillId: selectedSkill.id,
                version: selectedSkill.sha256,
                data: result,
              }),
            },
          ],
          details: {},
        };
      } catch (error) {
        return {
          content: [
            { type: 'text', text: error instanceof Error ? error.message : '技能读取失败' },
          ],
          details: { failed: true, outcome: signal?.aborted ? 'unknown' : 'failed' },
        };
      }
    },
  };
}
