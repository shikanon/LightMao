import { Type } from 'typebox';
import { z } from 'zod';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { IsolatedExecutor } from './isolation.ts';
import { captureMediaFile, detectFfmpeg, runMediaProcess } from './media-runtime.ts';
import { resourcePath } from './resource-leases.ts';
import {
  decodePng,
  encodePng,
  cropGrid,
  prepareFrame,
  type RgbaImage,
} from './game-asset-pixels.ts';
import type { AssetBundleFile } from './game-asset-bundle.ts';

const point = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict();
export const gameAssetInput = z
  .object({
    sourcePath: z.string().min(1).max(400),
    outputDir: z.string().min(1).max(300),
    replaces: z.string().min(1).max(300).optional(),
    kind: z.enum(['sprite_sheet', 'icon_sheet', 'ultimate_video']),
    columns: z.number().int().min(1).max(16).default(1),
    rows: z.number().int().min(1).max(16).default(1),
    count: z.number().int().min(1).max(128).optional(),
    margin: z.number().int().min(0).max(128).default(0),
    spacing: z.number().int().min(0).max(128).default(0),
    fps: z.number().int().min(1).max(30).default(12),
    background: z.enum(['auto', 'alpha', 'chroma']).default('auto'),
    keyColor: z
      .string()
      .regex(/^#[a-fA-F0-9]{6}$/)
      .default('#00ff00'),
    keyMetric: z.enum(['rgb', 'chroma']).optional(),
    similarity: z.number().min(0.01).max(0.6).optional(),
    blend: z.number().min(0.01).max(0.4).default(0.12),
    feather: z.number().min(0).max(2).default(0.5),
    pivot: point.optional(),
    frameAnchors: z.array(point).min(1).max(128).optional(),
    names: z
      .array(z.string().regex(/^[A-Za-z0-9_-]{1,60}$/))
      .min(1)
      .max(128)
      .optional(),
  })
  .strict()
  .transform((input) => ({
    ...input,
    similarity: input.similarity ?? (input.kind === 'ultimate_video' ? 0.28 : 0.18),
  }));
export type GameAssetInput = z.input<typeof gameAssetInput>;
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function previewHtml(manifest: Record<string, any>) {
  // All labels come from validated names; no model-produced executable text is interpolated.
  const data = JSON.stringify(manifest).replaceAll('<', '\\u003c');
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>透明素材与中心轴预览</title><style>
body{margin:24px;font:15px system-ui;background:#edeef0;color:#25282b}main{max-width:1000px;margin:auto}button,select{margin:6px;padding:8px}canvas{max-width:100%;border:1px solid #a9adb2;background:#fff}p{line-height:1.7}code{word-break:break-all}.warn{color:#875b14}</style><main><h2>透明素材与中心轴预览</h2><p id="summary"></p><button id="play">暂停</button><select id="bg"><option value="checker">棋盘</option><option value="black">黑底</option><option value="white">白底</option><option value="game">模拟游戏移动</option></select><select id="frame"></select><label><input type="checkbox" id="axis" checked>显示中心轴</label><br><canvas width="960" height="640"></canvas><p class="warn">像素检查不代表动作流畅、角色一致性或游戏内美术验收。固定轴线只证明绘制使用统一锚点；源图角色本身漂移时需要提供逐帧 frameAnchors 再校准。</p></main><script>
const m=${data},c=document.querySelector('canvas'),ctx=c.getContext('2d'),bg=document.querySelector('#bg'),sel=document.querySelector('#frame');let play=true,index=0,last=0;const images=m.frames.map(f=>{let i=new Image;i.src=f.file;return i});m.frames.forEach((f,n)=>sel.add(new Option(f.name,n)));document.querySelector('#summary').textContent=m.frames.length+' 帧 · '+m.frameSize.width+'×'+m.frameSize.height+' · '+m.fps+' FPS · 像素检查'+(m.qa.technicalPassed?'通过':'待处理');document.querySelector('#play').onclick=()=>{play=!play;document.querySelector('#play').textContent=play?'暂停':'播放'};sel.onchange=()=>{index=+sel.value;play=false};function loop(t){if(play&&t-last>1000/m.fps){index=(index+1)%images.length;sel.value=index;last=t}let mode=bg.value;ctx.fillStyle=mode==='black'?'#08090c':mode==='game'?'#23322b':'#fff';ctx.fillRect(0,0,c.width,c.height);if(mode==='checker')for(let y=0;y<c.height;y+=24)for(let x=0;x<c.width;x+=24){ctx.fillStyle=((x+y)/24)%2?'#d5d7da':'#f6f6f6';ctx.fillRect(x,y,24,24)}let p=m.pivot.pixels,scale=Math.min(1.5,540/m.frameSize.height,700/m.frameSize.width),x=mode==='game'?480+180*Math.sin(t/1500):480,y=530,flip=mode==='game'&&Math.cos(t/1500)<0?-1:1;ctx.save();ctx.translate(x,y);ctx.scale(flip*scale,scale);if(images[index]?.complete)ctx.drawImage(images[index],-p.x,-p.y);ctx.restore();if(document.querySelector('#axis').checked){ctx.strokeStyle='#fa5269';ctx.beginPath();ctx.moveTo(x,20);ctx.lineTo(x,620);ctx.moveTo(x-18,y);ctx.lineTo(x+18,y);ctx.stroke();ctx.fillStyle='#fa5269';ctx.fillText('角色 root / 大招共用锚点',x+8,32)}requestAnimationFrame(loop)}requestAnimationFrame(loop);</script></html>`;
}

/** Deterministic, local postprocessing. Paid generation remains a separate durable backend task. */
export async function prepareGameAsset(options: {
  root: string;
  executor: IsolatedExecutor;
  input: GameAssetInput;
  signal?: AbortSignal;
  beforeCommit?: () => Promise<void>;
}) {
  const input = gameAssetInput.parse(options.input);
  resourcePath(input.sourcePath);
  resourcePath(input.outputDir);
  if (input.replaces) {
    resourcePath(input.replaces);
    if (input.replaces === input.outputDir || input.replaces.endsWith('/'))
      throw Error('替代旧素材时必须使用新的outputDir');
    const previous = await options.executor.file<string>(
      options.root,
      false,
      'read_file',
      { path: input.replaces + '/manifest.json' },
      options.signal,
    );
    const manifest = JSON.parse(previous);
    if (
      manifest.pipelineVersion !== 'game-assets-v1' ||
      manifest.kind !== input.kind ||
      manifest.qa?.technicalPassed !== false
    )
      throw Error('replaces必须指向本工程同类型且检查未通过的素材包，原文件会保留');
  }
  if (input.outputDir.endsWith('/') || input.sourcePath.startsWith(input.outputDir + '/'))
    throw Error('sourcePath不能位于输出目录内，outputDir不要以/结尾');
  if (input.kind !== 'ultimate_video' && input.columns * input.rows > 128)
    throw Error('单批最多128帧');
  if (
    input.kind === 'ultimate_video' &&
    (input.columns !== 1 || input.rows !== 1 || input.count !== undefined)
  )
    throw Error('视频按真实时长和fps提取完整帧，不使用grid/count截断视频');
  const signal = AbortSignal.any([
    ...(options.signal ? [options.signal] : []),
    AbortSignal.timeout(180000),
  ]);
  const isolation = await options.executor.ready();
  if (!isolation.available)
    throw Error(isolation.error || '素材处理隔离运行器不可用，尚未写入工程');
  const binary = await detectFfmpeg();
  if (!binary) throw Error('未发现FFmpeg，请在诊断中配置LIGHTMAO_FFMPEG_PATH；尚未写入工程');
  const scratch = await mkdtemp(join(tmpdir(), 'lightmao-game-asset-'));
  try {
    const source = await captureMediaFile(
      options.executor,
      options.root,
      input.sourcePath,
      join(scratch, 'source'),
      signal,
    );
    await mkdir(join(scratch, 'decoded'));
    await runMediaProcess(
      options.executor,
      binary,
      scratch,
      [
        '-v',
        'error',
        '-max_pixels',
        '16777216',
        '-i',
        'source/content',
        '-an',
        '-sn',
        '-dn',
        '-vf',
        input.kind === 'ultimate_video'
          ? `fps=${input.fps},scale=w='min(512,iw)':h='min(512,ih)':force_original_aspect_ratio=decrease`
          : 'format=rgba',
        '-frames:v',
        input.kind === 'ultimate_video' ? '129' : '1',
        '-pix_fmt',
        'rgba',
        '-threads',
        '1',
        'decoded/frame-%03d.png',
      ],
      signal,
    );
    const decodedPaths = (await readdir(join(scratch, 'decoded')))
      .filter((f) => /^frame-\d+\.png$/.test(f))
      .sort();
    if (!decodedPaths.length || decodedPaths.length > 128)
      throw Error('素材没有可解码帧或超过128帧；请缩短视频或降低fps，不可默默截断');
    let imageFrames: RgbaImage[] | undefined;
    if (input.kind !== 'ultimate_video')
      imageFrames = cropGrid(
        decodePng(await readFile(join(scratch, 'decoded', decodedPaths[0]))),
        input,
      );
    const count = imageFrames?.length || decodedPaths.length;
    if (input.names && (input.names.length !== count || new Set(input.names).size !== count))
      throw Error('names必须与帧数相同且唯一，按行优先排列');
    if (input.frameAnchors && input.frameAnchors.length !== count)
      throw Error('frameAnchors必须与实际帧数相同');
    const pivot = input.pivot || { x: 0.5, y: input.kind === 'icon_sheet' ? 0.5 : 0.85 };
    const files: { path: string; bytes: Buffer }[] = [],
      frames: Record<string, any>[] = [],
      atlases: Record<string, any>[] = [],
      qa: any[] = [];
    let atlas: RgbaImage | undefined,
      page = -1,
      cellWidth = 0,
      cellHeight = 0,
      perRow = 0,
      pageCount = 0,
      totalBytes = 0;
    const add = (path: string, bytes: Buffer) => {
      totalBytes += bytes.length;
      if (totalBytes > 64 * 1024 * 1024) throw Error('素材包超过64MiB，请减少帧数/分辨率');
      files.push({ path, bytes });
    };
    const flush = () => {
      if (atlas) {
        const path = `atlas-${String(page).padStart(3, '0')}.png`;
        const bytes = encodePng(atlas);
        add(path, bytes);
        atlases.push({ file: path, width: atlas.width, height: atlas.height, sha256: hash(bytes) });
      }
    };
    for (let i = 0; i < count; i++) {
      signal.throwIfAborted();
      const raw = imageFrames
        ? imageFrames[i]
        : decodePng(await readFile(join(scratch, 'decoded', decodedPaths[i])));
      if (raw.width > 2048 || raw.height > 2048)
        throw Error('单帧最大2048px，请增加网格或降低输入尺寸');
      if (input.kind === 'icon_sheet' && raw.width !== raw.height)
        throw Error('图标格子必须是正方形；调整grid、margin或spacing');
      let processed;
      const frameOptions = {
        ...input,
        keyMetric:
          input.keyMetric ||
          (input.kind === 'ultimate_video' ? ('chroma' as const) : ('rgb' as const)),
        anchor: input.frameAnchors?.[i],
        targetAnchor: pivot,
      };
      try {
        processed = prepareFrame(raw, frameOptions);
      } catch (error) {
        // Full-screen flashes sometimes obscure every key pixel. Preserve the frame
        // for review instead of deleting it or inventing alpha; QA remains failed.
        if (
          input.kind !== 'ultimate_video' ||
          input.background === 'alpha' ||
          !(error instanceof Error) ||
          !/没有可确认的keyColor|边界没有接近keyColor/.test(error.message)
        )
          throw error;
        processed = prepareFrame(raw, { ...frameOptions, background: 'alpha' });
        processed.qa.warnings.push(
          `第${i}帧没有可确认色幕；原帧保留为不透明，需检查特效遮挡/背景变化，不能计为透明验收通过。`,
        );
      }
      if (!i) {
        cellWidth = raw.width;
        cellHeight = raw.height;
        perRow = Math.max(1, Math.floor(2048 / cellWidth));
        pageCount = perRow * Math.max(1, Math.floor(2048 / cellHeight));
      } else if (raw.width !== cellWidth || raw.height !== cellHeight)
        throw Error('动画帧画布尺寸不一致');
      if (i % pageCount === 0) {
        flush();
        page++;
        const cells = Math.min(count - i, pageCount);
        atlas = {
          width: Math.min(perRow, cells) * cellWidth,
          height: Math.ceil(cells / perRow) * cellHeight,
          data: new Uint8Array(
            Math.min(perRow, cells) * cellWidth * Math.ceil(cells / perRow) * cellHeight * 4,
          ),
        };
      }
      const local = i % pageCount,
        x = (local % perRow) * cellWidth,
        y = Math.floor(local / perRow) * cellHeight;
      for (let row = 0; row < cellHeight; row++)
        atlas!.data.set(
          processed.image.data.subarray(row * cellWidth * 4, (row + 1) * cellWidth * 4),
          ((y + row) * atlas!.width + x) * 4,
        );
      const bytes = encodePng(processed.image),
        name =
          input.names?.[i] ||
          (input.kind === 'icon_sheet' ? 'icon-' : 'frame-') + String(i).padStart(3, '0'),
        file = name + '.png';
      if (/^(manifest|qa|atlas-\d+)$/.test(name)) throw Error('names使用了素材包保留名称');
      add(file, bytes);
      qa.push(processed.qa);
      frames.push({
        index: i,
        name,
        file,
        sha256: hash(bytes),
        atlas: `atlas-${String(page).padStart(3, '0')}.png`,
        rect: { x, y, width: cellWidth, height: cellHeight },
        durationMs: 1000 / input.fps,
        pivot: { x: pivot.x * cellWidth, y: pivot.y * cellHeight },
        offset: processed.qa.translation,
      });
    }
    flush();
    const warnings = [...new Set(qa.flatMap((q) => q.warnings))];
    const technicalPassed = qa.every(
      (q) =>
        !q.empty &&
        q.alphaMin === 0 &&
        q.alphaMax >= 128 &&
        q.transparentRatio > 0.01 &&
        q.clippedPixels === 0 &&
        q.edgeTouchPixels === 0,
    );
    const report = {
      technicalPassed,
      frames: qa,
      warnings,
      visualAcceptance: 'pending',
      engineAcceptance: 'not_run',
      alignment: {
        strategy: input.frameAnchors ? 'explicit-frame-anchors' : 'fixed-canvas',
        metadataVerified: true,
        explicitAnchorsApplied: !!input.frameAnchors,
        characterRootVerified: false,
        note: input.frameAnchors
          ? '提供的逐帧锚点已按整数像素注册；锚点语义仍需视觉复核'
          : '保留统一画布与绘制锚点；未自动推断角色身体root，须查看中心轴预览确认源动作是否漂移',
      },
    };
    const manifest = {
      version: 1,
      pipelineVersion: 'game-assets-v1',
      kind: input.kind,
      source: { path: input.sourcePath, ...source },
      config: input,
      fps: input.fps,
      frameSize: { width: cellWidth, height: cellHeight },
      pivot: { normalized: pivot, pixels: { x: pivot.x * cellWidth, y: pivot.y * cellHeight } },
      coordinateSystem: 'top-left-y-down',
      alphaMode: 'straight',
      colorSpace: 'srgb',
      frames,
      atlases,
      qa: report,
    };
    add('qa.json', Buffer.from(JSON.stringify(report, null, 2) + '\n'));
    add('preview.html', Buffer.from(previewHtml(manifest)));
    add(
      'godot-import.gd',
      Buffer.from(
        `extends Node\n# Godot 4: attach to a child of the character's shared root; import PNG textures first.\nfunc load_animation(sprite: AnimatedSprite2D, manifest_path: String) -> void:\n\tvar data: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(manifest_path))\n\tvar frames := SpriteFrames.new()\n\tframes.set_animation_speed("default", float(data.fps))\n\tframes.set_animation_loop("default", data.kind != "ultimate_video")\n\tfor frame: Dictionary in data.frames:\n\t\tframes.add_frame("default", load(manifest_path.get_base_dir().path_join(frame.file)))\n\tsprite.sprite_frames = frames\n\tsprite.centered = true\n\tsprite.offset = Vector2(float(data.frameSize.width)/2.0-float(data.pivot.pixels.x), float(data.frameSize.height)/2.0-float(data.pivot.pixels.y))\n\tsprite.play("default")\n`,
      ),
    );
    add('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
    await options.beforeCommit?.();
    signal.throwIfAborted();
    const committed = await options.executor.file(
      options.root,
      true,
      'commit_game_asset_bundle',
      {
        outputDir: input.outputDir,
        files: files.map((f): AssetBundleFile => ({
          path: f.path,
          base64: f.bytes.toString('base64'),
          sha256: hash(f.bytes),
        })),
      },
      signal,
    );
    return {
      ...(committed as object),
      manifestPath: input.outputDir + '/manifest.json',
      previewPath: input.outputDir + '/preview.html',
      frameCount: count,
      qualityKey: input.outputDir,
      ...(input.replaces && technicalPassed ? { supersedes: input.replaces } : {}),
      sourceSha256: source.sha256,
      manifestSha256: hash(files.find((f) => f.path === 'manifest.json')!.bytes),
      qaSummary: {
        emptyFrames: qa.flatMap((q, i) => (q.empty ? [i] : [])),
        edgeTouchFrames: qa.flatMap((q, i) => (q.edgeTouchPixels ? [i] : [])),
        clippedFrames: qa.flatMap((q, i) => (q.clippedPixels ? [i] : [])),
        opaqueFrames: qa.flatMap((q, i) => (q.alphaMin === 255 ? [i] : [])),
      },
      technicalPassed,
      alignment: report.alignment,
      warnings,
      note: 'PNG序列及图集已按真实alpha检查；视觉质量和实际游戏内表现需另行验收。',
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export function createGameAssetTools(options: {
  root: string;
  executor: IsolatedExecutor;
  allowed: string[];
  beforeCommit?: (outputDir: string) => Promise<void>;
}): AgentTool[] {
  if (!options.allowed.includes('prepare_game_asset')) return [];
  const pointType = Type.Object({
    x: Type.Number({ minimum: 0, maximum: 1 }),
    y: Type.Number({ minimum: 0, maximum: 1 }),
  });
  return [
    {
      name: 'prepare_game_asset',
      label: '制作透明动画与图标素材',
      executionMode: 'sequential',
      description:
        '本地处理已导入项目的角色序列帧、图标网格或大招视频：真实Alpha保留/绿幕抠图去溢色、轻度边缘羽化、按格切分、可选逐帧锚点注册，输出PNG序列、图集、中心轴预览、Godot导入脚本和带哈希清单。仅写新的outputDir，不覆盖；结果technicalPassed不代表美术或游戏验收。视频最多128帧，最大512px，静图单帧最大2048px。',
      parameters: Type.Object({
        sourcePath: Type.String(),
        outputDir: Type.String(),
        replaces: Type.Optional(
          Type.String({
            description:
              '可选：明确替代同类型检查失败的旧素材包目录，保留旧文件；只有新包检查通过才解除旧包缺陷',
          }),
        ),
        kind: Type.Union(
          ['sprite_sheet', 'icon_sheet', 'ultimate_video'].map((v) => Type.Literal(v)),
        ),
        columns: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
        rows: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
        count: Type.Optional(Type.Integer({ minimum: 1, maximum: 128 })),
        margin: Type.Optional(Type.Integer({ minimum: 0, maximum: 128 })),
        spacing: Type.Optional(Type.Integer({ minimum: 0, maximum: 128 })),
        fps: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
        background: Type.Optional(
          Type.Union(['auto', 'alpha', 'chroma'].map((v) => Type.Literal(v))),
        ),
        keyColor: Type.Optional(Type.String()),
        keyMetric: Type.Optional(Type.Union([Type.Literal('rgb'), Type.Literal('chroma')])),
        similarity: Type.Optional(Type.Number()),
        blend: Type.Optional(Type.Number()),
        feather: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
        pivot: Type.Optional(pointType),
        frameAnchors: Type.Optional(Type.Array(pointType, { maxItems: 128 })),
        names: Type.Optional(Type.Array(Type.String(), { maxItems: 128 })),
      }),
      execute: async (_, raw, signal) => {
        try {
          const input = gameAssetInput.parse(raw);
          const value = await prepareGameAsset({
            ...options,
            input,
            signal,
            beforeCommit: async () => options.beforeCommit?.(input.outputDir),
          });
          return { content: [{ type: 'text', text: JSON.stringify(value) }], details: {} };
        } catch (e) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: e instanceof Error ? e.message : '素材处理失败',
                  complete: false,
                }),
              },
            ],
            details: { failed: true },
          };
        }
      },
    },
  ];
}
