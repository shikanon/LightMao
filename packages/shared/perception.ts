import { z } from 'zod';
const data = z
  .string()
  .min(8)
  .max(5500000)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/);
export const perceptionInput = z
  .object({
    requestId: z.string().min(1).max(180),
    projectId: z.string().min(1).max(128),
    sessionId: z.string().max(128).optional(),
    runId: z.string().max(128).optional(),
    purpose: z.enum(['vision', 'audio', 'score']),
    question: z.string().trim().min(1).max(6000),
    frames: z
      .array(
        z
          .object({
            id: z.string().regex(/^[\w-]{1,80}$/),
            seconds: z.number().min(0).max(86400),
            mime: z.enum(['image/jpeg', 'image/png']),
            data,
          })
          .strict(),
      )
      .max(12)
      .default([]),
    audios: z
      .array(
        z
          .object({
            id: z.string().regex(/^[\w-]{1,80}$/),
            offsetSeconds: z.number().min(0).max(86400),
            durationSeconds: z.number().positive().max(90),
            format: z.enum(['wav', 'mp3', 'm4a', 'aac']),
            data,
          })
          .strict(),
      )
      .max(2)
      .default([]),
    sourceVersion: z.string().max(128).optional(),
    referenceVersion: z.string().max(128).optional(),
    traceId: z.string().max(128).optional(),
    spanId: z.string().max(128).optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.purpose === 'audio'
        ? v.audios.length > 0 && !v.frames.length
        : v.frames.length > 0 && !v.audios.length,
    '视觉和声音分别请求，不能由画面推测听到了声音',
  )
  .refine(
    (v) =>
      v.purpose !== 'score' ||
      (v.frames.some((f) => f.id.startsWith('reference-')) &&
        v.frames.some((f) => f.id.startsWith('actual-')) &&
        !!v.sourceVersion &&
        !!v.referenceVersion),
    '视觉评分需要参考帧、实际作品帧及双方版本',
  );
export type PerceptionInput = z.infer<typeof perceptionInput>;
export const visualCriteria = [
  { id: 'reference', label: '参考还原与题材', weight: 30 },
  { id: 'hierarchy', label: '构图、层级与可读性', weight: 25 },
  { id: 'feedback', label: '战斗与技能视觉反馈', weight: 25 },
  { id: 'coherence', label: '阶段一致性与完成度', weight: 20 },
] as const;
export const visualRubricVersion = 'game-visual-v2';
export const visualRubricGuidance = `四项分数各自独立，不把一张空白开场当作所有实际图像为空白。0仅用于该维度在全部实际画面中完全缺失、无法显示或完全相反；缺采样列unknowns，不能伪造看到了。
reference：0-24为仅抽象形状或几乎没有参考视觉特征；25-49为部分题材/配色/布局相似但人物与场景差距大；50-69为主要内容对应而风格/细节仍有明显差距；70-84为多数角色、场景和主要视觉匹配；85-100为高度还原且细节完整。
hierarchy：0-24为大部分内容不可见或不可读；25-49为能读但重点和布局混乱；50-69为主要HUD/卡牌/弹窗清晰但层级或主体弱；70-84为层次清晰、比例和对比合理；85-100为精细且一致的高质量呈现。
feedback：0-24为没有可见战斗或只有文字计数；25-49为已有简单弹道/命中/伤害表现；50-69为多种技能、敌人和Boss反馈可辨但密度/强度不足；70-84为接近参考的密集且清楚的技能反馈；85-100为高度还原的强视觉演出。
coherence：0-24为没有连贯可见场景；25-49为少量孤立界面；50-69为多个主要阶段一致但有空白或明显断层；70-84为所见主要阶段衔接完整且一致；85-100为细节和风格持续完整。只评价实际可见证据，功能、随机性和音频另列未知。
整数分数必须与对应理由和这些区间一致；不能默认填写0或把百分制误作0-1。`;
export const perceptionResult = z
  .object({
    summary: z.string().min(1).max(3000),
    observations: z
      .array(
        z
          .object({
            evidenceId: z.string().max(80),
            text: z.string().min(1).max(1400),
            confidence: z.number().min(0).max(1),
            startSeconds: z.number().min(0).optional(),
            endSeconds: z.number().min(0).optional(),
          })
          .strict(),
      )
      .max(32),
    unknowns: z.array(z.string().max(600)).max(16),
    transcript: z.string().max(10000).optional(),
    scores: z
      .array(
        z
          .object({
            criterion: z.enum(['reference', 'hierarchy', 'feedback', 'coherence']),
            score: z.number().int().min(0).max(100),
            evidenceIds: z.array(z.string().max(80)).min(1).max(12),
            reason: z.string().min(1).max(1200),
            // Seed-Evolving sometimes states the existing 100-point denominator explicitly.
            // Accept that exact annotation; other scales and unknown fields still fail.
            score_denominator: z.literal(100).optional(),
          })
          .strict(),
      )
      .max(4)
      .optional(),
  })
  .strict();
export type PerceptionResult = z.infer<typeof perceptionResult>;
export interface PerceptionJob {
  id: string;
  projectId: string;
  sessionId?: string;
  runId?: string;
  requestId: string;
  purpose: 'vision' | 'audio' | 'score';
  model: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'unknown' | 'interrupted';
  createdAt: string;
  updatedAt: string;
  inputSha256: string;
  sourceVersion?: string;
  referenceVersion?: string;
  traceId?: string;
  spanId?: string;
  inputManifest: {
    id: string;
    kind: 'image' | 'audio';
    sha256: string;
    bytes: number;
    seconds: number;
    durationSeconds?: number;
  }[];
  result?: PerceptionResult;
  visualScore?: number;
  rubricVersion?: string;
  error?: string;
  usageId?: string;
  outputSha256?: string;
  normalizationNotes?: string[];
}
export interface ReferenceMedia {
  id: string;
  projectId: string;
  name: string;
  mime: string;
  bytes: number;
  sha256: string;
  createdAt: string;
  status: 'preparing' | 'ready' | 'failed' | 'interrupted';
  durationSeconds?: number;
  width?: number;
  height?: number;
  hasAudio?: boolean;
  frames: { id: string; seconds: number; sha256: string; bytes: number }[];
  audios: {
    id: string;
    offsetSeconds: number;
    durationSeconds: number;
    sha256: string;
    bytes: number;
  }[];
  error?: string;
  analyses?: { purpose: 'vision' | 'audio'; jobId: string; status: string; summary?: string }[];
}
