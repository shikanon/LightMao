import type { Plugin, Skill } from './types.ts';
export const catalog: Plugin[] = [
  {
    id: 'perception',
    name: '视觉与音频理解',
    description:
      '理解当前项目选择的参考录屏、截图和真实音频；用实际运行画面比较作品，保存来源、覆盖范围与评分依据。',
    category: '运行与验证',
    version: '1.0.0',
    publisher: 'LightMao',
    icon: 'Eye',
    color: 'blue',
    capabilities: [
      '读取项目选择的参考媒体',
      '通过后端调用付费视觉和音频模型',
      '基于真实画面评审作品',
    ],
    tools: [
      'list_references',
      'analyze_reference',
      'analyze_attachment',
      'get_perception_result',
      'evaluate_game_visuals',
      'inspect_playtest_capture',
    ],
    installed: false,
    enabled: false,
  },
  {
    id: 'collaboration',
    name: 'Sub-Agent 协作',
    description:
      '独立Pi子任务、3–4轮滚动规划、私有工程副本、实时截图核验与共享租约。主Agent核验后合并，可回滚系统记录的变更。',
    category: '开发工具',
    version: '1.0.0',
    publisher: 'LightMao',
    icon: 'Users',
    color: 'violet',
    capabilities: [
      '在当前账号模型额度内并行运行最多2个子Agent',
      '角色限制与独立上下文',
      '按版本合并工程',
      '只读抓取项目已注册监控',
      '回滚本系统记录的配置',
    ],
    tools: [
      'plan_subagents',
      'delegate_subagent',
      'get_subagent_result',
      'verify_subagent_result',
      'apply_subagent_changes',
      'cancel_subagent',
      'advance_subagent_window',
      'read_subagent_log',
      'list_monitor_sources',
      'capture_ground_truth',
      'rollback_shared_changes',
    ],
    installed: true,
    enabled: true,
  },
  {
    id: 'playtest',
    name: '作品预览与自动试玩',
    description:
      '在浏览器预览或已授权Godot副本中运行游戏，用方舟System One选择实际控件或声明按键，保存轨迹和状态断言。',
    category: '运行与验证',
    version: '1.0.0',
    publisher: 'LightMao',
    icon: 'Gamepad2',
    color: 'green',
    capabilities: [
      '运行隔离的本地HTML游戏',
      '使用方舟System One进行付费决策',
      '向自有试玩窗口发送观察到的输入',
      '保存试玩证据',
    ],
    tools: [
      'start_game_preview',
      'run_browser_playtest',
      'run_godot_playtest',
      'read_playtest_log',
    ],
    installed: false,
    enabled: false,
  },
  {
    id: 'image-generation',
    name: '角色与场景图片',
    description:
      '通过后端方舟 Seedream 生成角色、序列帧与图标，保留任务和来源；可将工程中的图片整理为带透明通道、锚点与检查报告的游戏素材。',
    category: '素材生成',
    version: '1.0.0',
    publisher: 'LightMao',
    icon: 'Image',
    color: 'violet',
    capabilities: [
      '调用付费图片模型',
      '读取选定参考图',
      '保存生成图片至资料空间',
      '按项目写授权整理透明序列帧与图标',
    ],
    tools: [
      'generate_image',
      'get_media_job',
      'wait_media_job',
      'import_generated_asset',
      'prepare_game_asset',
    ],
    installed: false,
    enabled: false,
  },
  {
    id: 'video-generation',
    name: '大招与过场视频',
    description:
      '使用 Seedance 2.5 创建并查询同一视频任务；按项目写授权将演出视频整理为带透明帧、角色锚点和检查报告的游戏动画。',
    category: '素材生成',
    version: '1.0.0',
    publisher: 'LightMao',
    icon: 'Film',
    color: 'blue',
    capabilities: [
      '调用付费视频模型',
      '读取选定首帧图片',
      '查询和保存同一生成任务',
      '按项目写授权整理透明大招动画',
    ],
    tools: [
      'generate_video',
      'get_media_job',
      'wait_media_job',
      'import_generated_asset',
      'prepare_game_asset',
    ],
    installed: false,
    enabled: false,
  },
  {
    id: 'godot',
    name: 'Godot 引擎验证',
    description:
      '在独立工程副本中导入资源、运行场景与测试脚本，保留真实引擎日志和产物。需要另行授权本机引擎。',
    category: '游戏引擎',
    version: '1.0.0',
    publisher: 'LightMao',
    icon: 'Gamepad2',
    color: 'blue',
    capabilities: [
      '执行授权工程副本中的代码',
      '读取引擎日志和产物',
      '不改写原工程；禁止网络和子进程',
    ],
    tools: ['run_godot', 'read_engine_log'],
    installed: false,
    enabled: false,
  },
  {
    id: 'workspace',
    name: '项目文件',
    description: '让 Agent 读取项目目录、理解代码与设计文档。所有访问都限定在当前项目内。',
    category: '开发工具',
    version: '1.0.0',
    publisher: 'LightMao',
    icon: 'FolderCode',
    color: 'violet',
    capabilities: ['读取项目文件', '列出项目目录'],
    tools: ['list_files', 'read_file'],
    installed: true,
    enabled: true,
  },
  {
    id: 'writer',
    name: '文件创作',
    description: '将关卡方案、代码与配置写入项目。写操作按项目排队执行。',
    category: '开发工具',
    version: '1.0.0',
    publisher: 'LightMao',
    icon: 'FilePenLine',
    color: 'blue',
    capabilities: ['写入项目文件'],
    tools: ['write_file', 'edit_file'],
    installed: false,
    enabled: false,
  },
  {
    id: 'inspector',
    name: '游戏项目检查',
    description: '读取项目清单与目录，识别引擎配置，帮助开始一次有依据的代码审查。',
    category: '质量检查',
    version: '1.0.0',
    publisher: 'LightMao',
    icon: 'ScanLine',
    color: 'green',
    capabilities: ['读取项目清单'],
    tools: ['inspect_project'],
    installed: true,
    enabled: true,
  },
  {
    id: 'assets',
    name: '素材清单',
    description: '统计项目中的图片、音频与模型文件，为素材命名和资源整理建立清单。',
    category: '素材工具',
    version: '1.0.0',
    publisher: 'LightMao',
    icon: 'Shapes',
    color: 'orange',
    capabilities: ['读取项目文件名'],
    tools: ['asset_inventory'],
    installed: false,
    enabled: false,
  },
];
const gameAssetPreparation = `## 生成任务与工程交付
用户用日常语言描述即可，不要求用户说插件名或工具名。先读当前项目与用户选定参考，将数量、动作/图标清单、画风与目标引擎转为参数；未说明的低风险细节采用本技能默认值并记录。按当前会话授权直接执行；工具声明未加载时按需 load_capabilities 的 image/video/project 能力，真正缺权限才调用 request_capability，不能通过脚本绕过项目写授权。
generate_image 支持 background:"transparent"|"opaque"，size可为"1K"/"2K"或明确像素宽高；网格优先明确宽高，如4列2行方格用"2048x1024"，2列2行用"1024x1024"，防模型自选比例。默认size:"2K"。透明支路只使用真实带alpha的PNG图生图；没有参考时后端提供透明模板，有referenceAssetId时先核对参考实际alpha。普通RGB/RGBA全不透明参考不冒充透明参考，不把本地路径当assetId；这类参考可用于纯色绿幕支路。仅使用用户选定或本会话合法生成的参考，不私自上传私人工程素材。
generate_image / generate_video 只提交一次。取得稳定 jobId 后，用 get_media_job / wait_media_job 查询同一任务，核对真实状态、产物引用与字节；提交、排队、unknown 都不是完成，unknown先查原任务，不重新提交收费生成。completed 且产物实际可读后，用 import_generated_asset 导入当前工程，校验返回的实际相对路径/来源/哈希，再将该路径作为 sourcePath；不猜造路径，不覆盖不同内容。
prepare_game_asset 使用sourcePath、outputDir、kind、fps、background、keyColor、feather、pivot。静图网格另传columns、rows、count；ultimate_video不传这三项，按真实时长与fps取全帧，最多128帧，不能静默截断。kind只取sprite_sheet / icon_sheet / ultimate_video；fps为1–30，默认12；background取auto / alpha / chroma，keyColor默认"#00ff00"，feather为0–2默认0.5。keyMetric可取rgb或chroma；视频默认chroma，忽略绿幕亮度漂移并保留白/灰/近黑前景，静图默认rgb。以当前schema为准，outputDir使用新版本目录。frameAnchors须为0–1归一化的同一角色root实测位置，每帧一个；不按特效包围盒推测。names为唯一ASCII资源slug，中文名另存对照。检查每格真实Alpha，若RGB有图却Alpha全透明、越格、白色分隔边或特效截边，不能把技术失败素材当完成；回看原图后调整明确尺寸/构图或新版本重做，不对unknown任务重复提交。
重做失败素材用新outputDir，可用replaces指向同类型旧失败目录；只有新包QA通过才解除对应旧缺陷，不能用另一份好素材清掉失败。
## 透明、锚点和实际验收
“看起来没背景”、文件名.png、RGBA通道存在或提示词中写了透明，都不能证明透明。检查实际解码像素的 alpha 分布、非空内容、完整性和边缘：全不透明的候选不能冒充透明；全透明空图也不能通过。读 prepare_game_asset 返回的真实QA报告与technicalPassed，核对 manifest.json、PNG frames、PNG atlas、preview.html 都实际存在且可读取。透明模式失败须修正来源/生成/抠像后重新检查，不能把背景染成黑色假装透明。
用 preview.html 或真实画布在黑、白、棋盘三种背景检查每一帧的绿边、白边、黑边、洞、锯齿、半透明光晕和裁断。绿幕必须为纯色无阴影背景，角色/特效避免keyColor及其近色；必要时更换背景色并同步keyColor。需要比较直透明与绿幕时，保持同一角色参考、画风、动作、columns/rows/count、相位和画布；保存两路实际decoded alpha、边缘与完整性证据后择优，不能只看模型声明、单帧或文件体积。没有合法alpha参考的支路列为未执行，不冒称同条件比较。
使用manifest实际记录的帧尺寸、顺序、fps与pivot，所有帧保留同一完整画布。禁止逐帧裁边，禁止按包含特效的bbox重新居中。Canvas以固定worldRoot绘制，左上角为worldRoot减去pivot乘当前帧宽高；不要每帧根据不透明边界修改worldRoot。Godot把角色根节点作为移动和受击位置，Sprite2D/AnimatedSprite2D为其子节点；居中精灵的offset为(0.5-pivot)乘固定帧尺寸。图片、动画、特效挂在相同worldRoot，实际移动由代码控制；需要落地不随角色的效果必须明确标为worldLocked并单独记录出生时的世界位置。
technicalPassed只代表报告覆盖的文件、网格、alpha和锚点元数据等技术检查，不等于美术好看、动作正确、角色一致或游戏内通过。alignment.metadataVerified不能证明角色身体无漂移；characterRootVerified:false必须报告角色root尚未核验，不能把预览轴线稳定当作角色稳定的证据。把素材放入当前Canvas/Godot工程，实际播放/移动/转向，在黑白背景与战斗场景检查角色root、脚底和特效是否漂移，保存当前版本截图或录屏；视觉评审、游戏内验收、仍未覆盖项分别报告。不能因生成任务成功或技术QA通过就提交全部目标完成。`;

export const upgradeSkills: Skill[] = [
  {
    id: 'browser-game-loop',
    name: '浏览器游戏制作与试玩',
    description: '一句话描述小游戏，完成自包含作品、真实键盘试玩、断言和修复复验。',
    category: '程序',
    enabled: true,
    updatedAt: '2026-11-02T00:00:00.000Z',
    content: `# 浏览器游戏制作与试玩
修改已有代码时按报错行读取，优先用 edit_file 精确替换唯一片段，保留其余代码；不要从归档摘录重写整个文件。先观察工程。将用户的一句话转为有移动、节奏或资源选择，即时反馈、得分或胜负和重开的完整核心循环，避免只有按钮计数。使用本机自包含 HTML/CSS/JS 与 Canvas，不能依赖 CDN。复杂游戏拆为页面、样式、状态逻辑与绘制模块，单次写入遵循当前工具schema的32000字符上限；先保存能打开的页面和最小核心循环并实际运行，再分模块补完。原型可用程序图形；参考复刻视觉差距明显时按需使用已授权图片模型制作并导入素材，不把占位图当美术还原。先保存简短计划，然后写文件并实际试玩。
为自动化暴露游戏运行时状态：<script type="application/json" data-lightmao-playtest>，持续更新 {state:{phase,score,player_x,...},actions:[{id,label,key,holdMs}]}。key 仅 UP/DOWN/LEFT/RIGHT/W/A/S/D/SPACE/ENTER/ESCAPE/R/E/SHIFT/0–9，holdMs 20~500；标签清楚说明方向和效果。监听真实 keydown/keyup，不为测试动作伪造胜利。状态来自实际游戏变量。
调用自动试玩传自然语言目标、有意义且可复现的状态断言和合理步数；验证输入反馈、得分/胜负及重开。失败读取日志修复，再跑当前版本。返回可玩预览和证据；Goal 模式以本目标产生的真实 playtest ID 提交 complete_goal。不得把静态阅读或编译称为试玩，技术通过不代表高可玩性。缺少能力用 request_capability，由用户在界面启用。`,
  },
  {
    id: 'godot-game-loop',
    name: 'Godot原生游戏制作与试玩',
    description: '创建可运行的Godot游戏，以真实引擎输入、逐帧状态和截图验证并修复。',
    category: '程序',
    enabled: true,
    updatedAt: '2026-11-02T00:00:00.000Z',
    content: `# Godot 原生游戏制作与试玩
Godot 4 对 Variant 推断严格，字典值、min/abs 结果应显式转型或用 minf/absf，并明确局部变量类型。修复时按报错行读取，优先 edit_file 精确替换。先检查工程和版本；优先 Godot 4 自包含 2D 项目。实现有移动、挑战、反馈、得分或胜负和重开的核心循环，简单图形可用 _draw。project.godot 必须配置 application/run/main_scene、窗口大小和 gl_compatibility 渲染，不能只写文档。先写文件，再用真实引擎导入/运行及日志修复解析和运行错误。
自动试玩固定驱动实例化项目 main_scene。主场景根节点提供 lightmao_observe() -> Dictionary，返回真实 phase/score/player_x 等状态；提供 lightmao_actions() -> Array，返回 [{id,label,key,frames}]。key 仅 UP/DOWN/LEFT/RIGHT/W/A/S/D/SPACE/ENTER/ESCAPE/R/E/SHIFT/0–9，frames 1~120。实际 InputEventKey 送入真实引擎；游戏使用 _input/_unhandled_input 或 Input 读取对应按键，不能把测试动作当直接改分/获胜后门。按帧推进逻辑，截图验收用 visible:true 打开独立原生窗口（自动测试静音）。
run_godot_playtest 传目标、有意义状态断言和合理步数；读日志修复，再复验当前代码，保留实际 PNG。Godot 与自动试玩插件都需用户启用，引擎路径在诊断页授权，不通过 shell 绕过。MP4 导入只是媒体文件，Godot VideoStreamPlayer 还需支持的格式适配，不将导入称为播放验证。Goal 以本目标当前版本真实 playtest ID 调用 complete_goal。`,
  },
  {
    id: 'reference-roguelite-validation',
    name: '参考游戏复刻与构筑验收',
    description:
      '从参考录屏规划游戏，核对战前构筑保留、战中选技叠加、Boss、存档与实际视觉，避免只过菜单或自报胜利。',
    category: '质量检查',
    enabled: true,
    updatedAt: '2026-11-02T15:00:00.000Z',
    content: `# 参考游戏复刻与构筑验收
先分别理解用户明确引用的录屏画面与音轨；抽样观察不能补造未覆盖规则。把用户要求写成持久验收大纲，局部计划不能减少原目标。先制作能运行的核心循环，用真实输入试玩，再按实际报错定点修复。
Roguelite有跨阶段状态不变量。若要求战前5轮每轮2选，进入战斗后仍须保留10次选择对应的技能/等级效果；检查开始战斗是否错误地重新newRun而抹掉构筑。战中至少再次出现随机选技，选择要实际改变技能层数或数值，并恢复推进；不能只有弹窗、按钮计数或前置菜单。使用前后状态、实际输入、对应截图共同核对，游戏自报JSON不是独立成功证据。
为验收暴露来自实际变量的累计preselectPicks、inBattleChoices、技能层数、wave/bossLayer、总伤害和phase，不能写常量通过。按用户要求断言：战前10次选择保留、战中至少两次选技叠加并续战、5波推进、多层血条Boss、胜利与重开；局外等级/星级/抽卡等保存后重新载入仍在。不要把drafts>=1或只有phase=victory当作全部构筑通过。复杂流程可显式申请最多64步，仍受180秒总预算约束；有自动推进时等待观察，不反复切换倍速或暂停。
先看真实运行日志，按报错行与直接依赖读取，避免整份工程反复回读。单模块写入以当前工具schema为准（当前32000字符），历史参数只保留完整内容或独立归档，不能复制占位对象。截图要覆盖预选、实际战斗、战中选择、Boss与结算；缺阶段列未知。使用独立视觉模型对比参考与当前真实截图；低分修复后重玩并重新评分，不能沿用旧源码成绩。参考角色与场景差距明显时，可按需使用已授权图片模型并导入真实素材；仅分析参考视频不生成新视频。
完成时提供当前版本试玩、视觉评分与仍未覆盖项目。技术运行、模型视觉分和用户可玩性评价分别报告。子Agent报告须主Agent核对真实文件/截图，未完成或预算耗尽不声称交付全部目标。`,
  },
  {
    id: 'game-media-pipeline',
    name: '游戏角色与技能演出素材',
    description: '自动选择Seedream图片或Seedance 2.5视频，保留可追溯的任务和产物。',
    category: '美术',
    enabled: true,
    updatedAt: '2026-11-02T00:00:00.000Z',
    content: `# 游戏生成素材
将立绘、场景、大招和过场需求转为视觉一致的提示词。静图选择 generate_image，视频选择 generate_video，默认短片4秒720p。参考图仅限用户明确选定或本会话生成图片，不能私自上传工程中的私人素材。缺少插件在界面请求启用。
生成立即返回稳定任务ID；get_media_job 或 wait_media_job 查询同一任务。保留真实排队/生成/入库阶段，不给虚构百分比，不反复 generate 轮询。unknown 时先核对已有产物，绝不重新提交收费任务。完成可预览下载；写入工程需项目写授权，使用 import_generated_asset 校验字节，不覆盖已有不同内容。视频生成成功不等于游戏内播放成功，需按引擎格式复验。素材质量由用户评审。`,
  },
  {
    id: 'character-sprite-sequence',
    name: '角色动画序列帧制作',
    description:
      '说“让这个角色跑起来”“做一套走跑攻击序列帧”即可：生成或使用参考素材，整理透明PNG帧、atlas和锚点，在Canvas/Godot实际播放验证。',
    category: '美术',
    enabled: true,
    updatedAt: '2026-11-03T00:00:00.000Z',
    content: `# 角色动画序列帧制作
适用短指令：“给这个角色做一套跑步动画”“生成8帧待机和攻击”。自行识别任务，不要求用户点选技能。先检查已有角色参考和素材；已有正确序列帧则直接整理，不重复收费生成。没有明确数量时采用16帧、4列4行、12fps、2K，角色pivot默认{x:0.5,y:0.85}，先制作一段可检查的动作，其他动作按同一基准分开输出。
## 动作与生成
先写逐帧相位表：走跑区分接触、下沉、经过、抬起和左右交替；攻击区分起势、蓄力、出手、命中、收势。每格对应一个按时间顺序的真实相位，不能复制同一姿势充帧；循环动作首尾衔接，非循环动作保留结束姿势。默认原地动画，root motion由游戏代码控制，不把角色横穿画布当移动逻辑。
提示词固定同一角色身份、服装、身材、朝向、视角、镜头、焦距、角色比例和地面基线；全身可见，留出武器与动作边距，禁止镜头推拉/旋转/切镜。要求精确columns×rows网格、每格同尺寸、无格线无帧号无文字、从左到右再从上到下。脚底迈步不等于root上下跳动。优先真实透明PNG支路；合法alpha参考缺失或透明效果不好时用同角色纯绿背景支路，并实际检查抠像结果。
完成任务并导入后，调用prepare_game_asset，例如{sourcePath:"assets/hero/run_source.png",outputDir:"assets/hero/run_v1",kind:"sprite_sheet",columns:4,rows:4,count:16,fps:12,background:"alpha",pivot:{x:0.5,y:0.85}}。绿幕来源改用background:"chroma"、keyColor:"#00ff00"、feather:0.5；不靠auto掩盖错误来源。实际帧数与相位表一致，网格错位、缺帧、多角色、动作不连贯或身体/武器出界须重新生成或经授权手动修正，不能把多余内容裁掉后冒充原设计。
## 角色绑定
逐帧检查虚拟地面上的角色root，不用每帧不同的迈步脚或武器bbox作为锚点。若确有生成位置漂移，用实测frameAnchors和报告核对；不能通过逐帧裁边或运行时随意居中隐藏漂移。把manifest绑定固定角色根节点，在实际Canvas/Godot中播放待机→移动→攻击→恢复，检查脚底、武器与碰撞体是否一致。交付动作相位表、素材来源、manifest、帧/atlas、可交互预览、QA报告与游戏内检查证据。
${gameAssetPreparation}`,
  },
  {
    id: 'character-ultimate-alpha',
    name: '角色大招透明动画制作',
    description:
      '说“给这个角色做透明大招动画”“让大招特效跟着角色走”即可：同一角色参考、稳定视频任务、实际抠像与锚点整理，再验证角色root和演出对齐。',
    category: '美术',
    enabled: true,
    updatedAt: '2026-11-03T00:00:00.000Z',
    content: `# 角色大招透明动画制作
适用短指令：“给这个角色做一个透明大招”“把大招视频变成游戏动画并跟着角色走”。检查已有角色立绘、基础动画和用户引用视频；能用现有来源就先整理，不要求用户写插件名。默认4秒、720p、12fps，角色pivot为{x:0.5,y:0.85}，沿用基础角色的虚拟地面与worldRoot。
## 演出生成与透明处理
先规划起势→蓄力→爆发/命中→消散/收势的逐帧相位，固定镜头、视角、朝向、角色比例和位置，完整保留人物、武器、光效与边距，不出现剪辑、远近推拉、场景背景、字幕或水印。默认原地演出，冲刺/位移由游戏代码root motion控制。使用用户选定或本会话合法生成的同一角色参考；明确是“含角色的完整大招动作”还是“只包含独立特效”，避免换人或叠出第二个角色。
生成视频用generate_video一次并保存稳定jobId，wait_media_job/get_media_job查询同一任务，completed且实际产物可读后import_generated_asset。不要把视频提示词写“透明”就宣称有alpha；先检查实际decoded alpha。若不含真实透明通道，使用纯色绿幕来源与background:"chroma"提取透明PNG帧；不要在游戏里直接播放不透明绿幕或黑底视频冒充透明演出。
对4秒来源可用prepare_game_asset的{sourcePath:"assets/hero/ultimate_source.webm",outputDir:"assets/hero/ultimate_v1",kind:"ultimate_video",fps:12,background:"chroma",keyColor:"#00ff00",feather:0.5,pivot:{x:0.5,y:0.85}}。视频不传columns/rows/count，按真实时长完整取帧并读取manifest排布；4秒12fps预计约48帧，但实际以报告为准。超过128帧时降低fps或先明确缩短源片，不能改count偷偷跳过。直接透明PNG序列候选使用kind:"sprite_sheet"与alpha来源；A/B比较时对齐同角色、同相位、同实际count/输出grid、同单帧画布与fps，再以真实alpha/边缘/完整性证据择优。
## 同一个角色root
完整角色大招帧应替换基础角色动画，不能再叠一层完整角色导致双影；独立特效作为同一根节点的子节点叠加。大招、待机、移动和碰撞体共享worldRoot，pivot与脚底基线相同，禁止按巨大光效bbox居中、逐帧裁边或换镜头掩盖抖动。固定落地阵法/命中火花明确worldLocked，只在出生时记录世界位置；不能让本应跟身的武器光效留在原地。
在黑白棋盘以及游戏场景逐帧检查绿边、黑边、光晕、缺帧、角色/武器裁断和相位连贯；实际执行站立放大招、移动中释放、方向切换和结束回待机，记录锚点是否漂移。视频文件导入不等于引擎可播放，优先使用工具交付的PNG序列；若另交视频播放资源，要单独验证对应引擎编码。交付manifest、透明帧/atlas、preview.html、QA报告及游戏内演出证据。
${gameAssetPreparation}`,
  },
  {
    id: 'batch-game-icons',
    name: '批量游戏图标制作',
    description:
      '说“做一套仙侠技能图标”“批量出装备和道具图标”即可：统一风格、精确方形网格、一格一图、逐项命名、透明像素检查与实际游戏尺寸预览。',
    category: '美术',
    enabled: true,
    updatedAt: '2026-11-03T00:00:00.000Z',
    content: `# 批量游戏图标制作
适用短指令：“做16个国风技能图标”“按这份清单批量做装备图标”。从用户清单或当前游戏内容提取精确count与语义，不要求用户显式调用插件。清单不足时先给出具体名称与合理默认样式，不把未说明的技能效果当既定事实；需要用户选择的美术方向可先交可检查的小批次。默认2K、4列4行16个；静态图标pivot默认{x:0.5,y:0.5}，不按角色脚底锚点设置。
## 统一视觉与精确网格
先生成names数组与row-major清单：从左到右、再从上到下，每个名称唯一并对应一个图标，names.length必须等于count。names使用1–60个ASCII字母/数字/下划线/短横线的资源slug，例如fire_sword；另存中文显示名与slug对照，不把中文或路径直接传入names。约定一致的国风/材质/描边、光照方向、色彩、边框、安全边距与主体占比，无文字、字母、数字、标签、水印或格线；一格一图，不把多个技能合在一格，不通过复制同一图标凑数。
根据真实画布宽高规划columns×rows，保证每格square。2K只是生成尺寸档，不能据此假定实际像素、方形单元或整除关系。数量不足满格时仅允许清单末尾明确空白格，不计入count与names；其余格不能空缺。直接透明支路使用background:"transparent"，若有参考须为真实alpha PNG；普通参考可用background:"opaque"的纯绿幕支路并实际抠像。
生成与导入完成后调用prepare_game_asset，例如{sourcePath:"assets/icons/skills_source.png",outputDir:"assets/icons/skills_v1",kind:"icon_sheet",columns:4,rows:4,count:16,background:"alpha",pivot:{x:0.5,y:0.5},names:[按清单顺序的16个名称]}。实际调用时names必须是具体字符串数组，不把示例占位文字交给工具。绿幕来源改background:"chroma"、keyColor:"#00ff00"、feather:0.5。读取真实分格结果与QA报告，逐格核对名称、语义、内容完整性、方形尺寸与边缘；多图一格、跨格、缺图、重复、裁断、非方形或错误语义必须重生成或经授权手动调整后重新prepare，不能只改count/names让错误结果通过。
## 游戏内检查
在黑、白、棋盘三底检查透明、半透明边缘和绿边；按实际游戏32/64/128像素等目标尺寸预览，核对识别度、视觉权重、按钮边界和禁用态。导入Canvas/Godot的图标控件时按manifest的row-major帧与名称绑定，不凭生成图肉眼顺序猜测；不为统一大小逐图裁边导致视觉缩放不一。保存逐项核对清单、manifest、独立PNG、atlas、preview.html和实际UI截图。技术QA通过、名称语义/美术评审和游戏内可读性分开报告。
${gameAssetPreparation}`,
  },
];
export const defaultSkills: Skill[] = [
  {
    id: 'level-design',
    name: '关卡设计',
    description: '把玩法目标转化为探索路径、节奏与可验收的关卡方案。',
    category: '策划',
    enabled: true,
    updatedAt: '2026-11-01T00:00:00.000Z',
    content:
      '# 关卡设计\n\n先阅读项目文档，确认目标玩家、核心机制和限制。\n输出体验目标、空间动线、分段节奏、教学反馈和验收清单。\n优先用环境引导替代长篇教程。明确哪些结论是假设，哪些已经在引擎中验证。',
  },
  {
    id: 'code-review',
    name: '游戏代码审查',
    description: '关注帧循环、资源生命周期和可复现的逻辑问题。',
    category: '程序',
    enabled: true,
    updatedAt: '2026-11-01T00:00:00.000Z',
    content:
      '# 游戏代码审查\n\n先检查项目引擎与目录结构，再读取相关代码。\n优先检查帧循环分配、状态机、资源释放和边界条件。\n仅报告有文件依据的缺陷，并给出复现步骤和验证建议。不要将静态阅读称为运行验证。',
  },
  {
    id: 'asset-naming',
    name: '素材整理规范',
    description: '建立角色、场景、音效与版本一致的资源命名。',
    category: '美术',
    enabled: true,
    updatedAt: '2026-11-01T00:00:00.000Z',
    content:
      '# 素材整理规范\n\n读取素材清单，按角色、场景、界面、音效分类。\n建议采用 type_subject_variant_version 命名。\n保留来源和授权备注；不推断第三方资源的商用许可。',
  },
  ...upgradeSkills,
];
export const sampleDesign =
  '# 森林入口\n\n星露秘境 · 关卡 01\n\n## 一次不被打断的探索\n从一条林间小径开始，在微光与植物的陪伴下，玩家将在探索中自然学会移动、收集与交互。\n\n- 体验时长：5–8 分钟\n- 核心玩法：探索 · 收集\n- 情绪曲线：好奇 → 发现\n\n## 关卡节奏\n1. 初入森林：沿着林间小径前进，在萤火的引导下熟悉移动。\n2. 岔路与星露：在小径岔路发现被植物环绕的发光点。\n3. 遇见守林人：在大树下与守林人对话，获得下一个目标。\n\n## 验收清单\n- 玩家能在不弹出教程的情况下找到第一条路径。\n- 收集有明确的视听反馈。\n- 对话结束后下一个目标可被理解。\n\n此文档是内置示例，未在游戏引擎中验证。\n';
