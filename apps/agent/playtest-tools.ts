import { Type } from 'typebox';
import { z } from 'zod';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { PlaytestService } from './playtests.ts';
export function createPlaytestTools(options: {
  service: PlaytestService;
  owner: string;
  project: string;
  session: string;
  run: string;
  token: string;
  allowed: string[];
  runs: Set<string>;
  authorize: () => Promise<void>;
  authorizeGodot: () => Promise<void>;
  defaultViewport?: { width: number; height: number };
}): AgentTool[] {
  const result = (value: unknown, failed = false) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    details: failed ? { failed: true } : {},
  });
  const tools: AgentTool[] = [
    {
      name: 'start_game_preview',
      label: '打开可玩作品预览',
      executionMode: 'sequential',
      description:
        '为当前项目HTML游戏创建独立来源的可玩预览，限定工程副本和本地资源，不允许外部网络或Node。返回15分钟有效URL。页面应自包含，不依赖CDN。Godot原生工程使用run_godot验证，不用此工具假装原生运行。',
      parameters: Type.Object({ entry: Type.Optional(Type.String({ maxLength: 300 })) }),
      execute: async (_, raw, signal) => {
        try {
          const args = z
            .object({ entry: z.string().default('index.html') })
            .strict()
            .parse(raw);
          return result(
            await options.service.createPreview(
              options.owner,
              options.project,
              args.entry,
              options.authorize,
              signal,
            ),
          );
        } catch (e) {
          return result({ error: e instanceof Error ? e.message : '预览启动失败' }, true);
        }
      },
    },
    {
      name: 'run_browser_playtest',
      label: '使用方舟System One自动试玩',
      executionMode: 'sequential',
      description:
        '在独立Electron渲染器中用Jev式动态操作/目标决策自动试玩本地HTML游戏。方舟System One一次选择操作和目标；TYPE_TEXT由独立文本模型填写。执行前核对真实节点、版本、遮挡，不执行模型脚本或selector。Canvas游戏应在<script type="application/json" data-lightmao-playtest>维护{state:{score,phase,...},actions:[{id,label,key,holdMs}]}，key只允许UP/DOWN/LEFT/RIGHT/W/A/S/D/SPACE/ENTER/ESCAPE/R/E/SHIFT/0–9，holdMs20~500；输入使用真实游戏键盘事件。断言来自实际游戏状态；传至少一项有意义断言，例如score>=1、phase=won。技术通过不代表高可玩性。最多64步、180秒；结果未知不自动重复输入。',
      parameters: Type.Object({
        entry: Type.Optional(Type.String()),
        goal: Type.String({ maxLength: 3000 }),
        maxSteps: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
        viewport: Type.Optional(
          Type.Object({
            width: Type.Integer({ minimum: 240, maximum: 1920 }),
            height: Type.Integer({ minimum: 240, maximum: 1920 }),
          }),
        ),
        assertions: Type.Array(
          Type.Object({
            field: Type.String(),
            op: Type.Union([
              Type.Literal('eq'),
              Type.Literal('ne'),
              Type.Literal('gte'),
              Type.Literal('lte'),
              Type.Literal('truthy'),
            ]),
            value: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Boolean()])),
          }),
          { minItems: 1, maxItems: 12 },
        ),
      }),
      execute: async (id, args, signal) => {
        try {
          const job = await options.service.start(
            options.owner,
            options.project,
            options.session,
            {
              ...(options.defaultViewport ? { viewport: options.defaultViewport } : {}),
              ...(args as Record<string, unknown>),
              requestId: options.run + ':' + id,
            },
            options.token,
            options.authorize,
            options.run,
          );
          const final = await options.service.wait(options.owner, job.id, signal);
          return result(
            { ...final, source: 'actual-browser-input-and-system-one', logRef: final.id },
            final.status !== 'passed',
          );
        } catch (e) {
          return result({ error: e instanceof Error ? e.message : '试玩未完成' }, true);
        }
      },
    },
    {
      name: 'run_godot_playtest',
      label: '使用方舟System One试玩Godot',
      executionMode: 'sequential',
      description:
        '在已授权Godot的隔离工程副本中保持真实主场景，用方舟System One选择观察到的按键、实际推进引擎帧并验证状态；不是DOM浏览器点击。主场景根节点需提供lightmao_observe()->Dictionary（真实玩法状态如player_x/score/phase）和lightmao_actions()->Array，每项{id,label,key,frames}，key限UP/DOWN/LEFT/RIGHT/W/A/S/D/SPACE/ENTER/ESCAPE/R/E/SHIFT/0–9，frames1~120。固定驱动会注入InputEventKey，不执行模型脚本。visible=true尝试实际原生渲染并保留截图，默认无窗口；原工程不由引擎修改。必须给至少一项有意义状态断言，不能用导入成功冒充试玩通过。最多64步、总计180秒（引擎另有120秒子预算）；结果未知不自动重放输入。',
      parameters: Type.Object({
        goal: Type.String({ maxLength: 3000 }),
        maxSteps: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
        visible: Type.Optional(Type.Boolean()),
        assertions: Type.Array(
          Type.Object({
            field: Type.String(),
            op: Type.Union([
              Type.Literal('eq'),
              Type.Literal('ne'),
              Type.Literal('gte'),
              Type.Literal('lte'),
              Type.Literal('truthy'),
            ]),
            value: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Boolean()])),
          }),
          { minItems: 1, maxItems: 12 },
        ),
      }),
      execute: async (id, args, signal) => {
        try {
          const job = await options.service.startGodot(
            options.owner,
            options.project,
            options.session,
            { ...(args as Record<string, unknown>), requestId: options.run + ':' + id },
            options.token,
            options.authorizeGodot,
            options.run,
          );
          const final = await options.service.wait(options.owner, job.id, signal);
          return result(
            { ...final, source: 'actual-godot-input-and-system-one', logRef: final.id },
            final.status !== 'passed',
          );
        } catch (e) {
          return result({ error: e instanceof Error ? e.message : '原生试玩未完成' }, true);
        }
      },
    },
    {
      name: 'read_playtest_log',
      label: '读取自动试玩轨迹',
      description:
        '按实际试玩ID分页读取当前会话可追溯的观察、决策、动作和断言轨迹，每次最多4000字符。',
      parameters: Type.Object({
        jobId: Type.String(),
        offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 2000000 })),
      }),
      execute: async (_, raw, signal) => {
        try {
          signal?.throwIfAborted();
          const args = z
            .object({ jobId: z.uuid(), offset: z.number().int().min(0).max(2000000).default(0) })
            .strict()
            .parse(raw);
          const job = options.service.get(options.owner, args.jobId);
          if (job.projectId !== options.project || !job.runId || !options.runs.has(job.runId))
            throw Error('试玩记录不属于当前会话范围');
          return result(await options.service.trace(options.owner, job.id, args.offset));
        } catch (e) {
          return result({ error: e instanceof Error ? e.message : '轨迹读取失败' }, true);
        }
      },
    },
  ];
  return tools.filter((t) => options.allowed.includes(t.name));
}
