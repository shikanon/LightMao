import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import type { Skill, SkillResource, SkillSummary } from '../shared/types.ts';
export const SKILL_LIMITS = {
  files: 128,
  fileBytes: 2 * 1024 * 1024,
  totalBytes: 8 * 1024 * 1024,
  instructionChars: 30000,
  pageChars: 4000,
};
export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function skillError(statusCode: number, message: string, code = 'SKILL_INVALID'): never {
  throw Object.assign(new Error(message), { statusCode, code });
}
export function resourcePath(value: string) {
  const path = value.normalize('NFC');
  if (
    !path ||
    path.length > 240 ||
    /[\\\x00-\x1f\x7f:]/.test(path) ||
    path.startsWith('/') ||
    path.endsWith('/')
  )
    skillError(400, '技能资源需要有效的相对路径');
  const parts = path.split('/');
  if (
    parts.length > 8 ||
    parts.some(
      (part) =>
        !part ||
        part.startsWith('.') ||
        /^(password|secrets?|credentials)(\.|$)/i.test(part) ||
        /^(id_rsa|id_ed25519)$/i.test(part) ||
        /[. ]$/.test(part),
    )
  )
    skillError(400, '技能包包含不允许的路径或敏感文件');
  return path;
}
export function parseSkill(source: string, rootName?: string) {
  const text = source.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const front = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  if (!front || front[1].length > 8192 || text.length > SKILL_LIMITS.instructionChars)
    skillError(400, 'SKILL.md 需要 YAML frontmatter，全文最多 30,000 字符，元数据最多 8,192 字符');
  const document = parseDocument(front[1], {
    schema: 'failsafe',
    uniqueKeys: true,
    prettyErrors: false,
  });
  if (document.errors.length || document.warnings.length)
    skillError(400, 'SKILL.md 的 YAML 元数据无效或包含不支持的标签');
  let value: unknown;
  try {
    value = document.toJS({ mapAsMap: true, maxAliasCount: 0 });
  } catch {
    skillError(400, 'SKILL.md 元数据不支持别名或递归结构');
  }
  if (!(value instanceof Map)) skillError(400, 'SKILL.md 元数据必须是字段映射');
  const name = value.get('name'),
    description = value.get('description');
  if (typeof name !== 'string' || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
    skillError(400, '技能 name 需要 1–64 位小写字母、数字和单连字符');
  if (rootName !== undefined && rootName !== name)
    skillError(400, '技能目录名称需要与 SKILL.md 的 name 一致');
  if (typeof description !== 'string' || !description.trim() || description.length > 1024)
    skillError(400, '技能 description 需要 1–1,024 字符');
  const compatibility = value.get('compatibility');
  if (
    compatibility !== undefined &&
    (typeof compatibility !== 'string' || !compatibility || compatibility.length > 500)
  )
    skillError(400, '技能 compatibility 字段无效');
  const metadata = value.get('metadata');
  if (
    metadata !== undefined &&
    (!(metadata instanceof Map) ||
      [...metadata].some(([key, val]) => typeof key !== 'string' || typeof val !== 'string'))
  )
    skillError(400, '技能 metadata 需要字符串字段映射');
  if (!text.slice(front[0].length).trim()) skillError(400, 'SKILL.md 需要正文指引');
  return { name, description: description.trim(), content: source };
}
export function resourceMime(path: string) {
  const extension = path.toLowerCase().split('.').at(-1);
  const image = (
    {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      gif: 'image/gif',
    } as Record<string, string>
  )[extension || ''];
  return (
    image ||
    (/^(md|markdown|txt|json|ya?ml|toml|js|mjs|cjs|ts|tsx|py|gd|cs|glsl|shader|svg|html|css|csv|xml|ini|sh)$/.test(
      extension || '',
    )
      ? 'text/plain; charset=utf-8'
      : 'application/octet-stream')
  );
}
export function packageDigest(files: SkillResource[]) {
  return digest(
    JSON.stringify([...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))),
  );
}
export function skillSummary(skill: Skill, origin: 'local' | 'cloud' = 'cloud'): SkillSummary {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    enabled: skill.enabled,
    category: skill.category,
    updatedAt: skill.updatedAt,
    origin,
    format: skill.format || 'markdown',
    revision: skill.revision || 0,
    sha256:
      origin === 'local' && skill.sha256
        ? skill.sha256
        : digest(JSON.stringify([skill.name, skill.description, skill.category, skill.content])),
    slug: skill.slug,
    fileCount: skill.fileCount || 1,
    totalBytes: skill.totalBytes ?? Buffer.byteLength(skill.content),
  };
}
export function textPage(bytes: Buffer, input: { offset?: number; limit?: number }) {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    skillError(415, '二进制资源请在技能详情预览或下载，不能作为文本读取');
  }
  if (text.includes('\0')) skillError(415, '此资源不能作为文本读取');
  const offset = input.offset || 0,
    limit = Math.min(SKILL_LIMITS.pageChars, input.limit || SKILL_LIMITS.pageChars);
  return {
    offset,
    totalChars: text.length,
    nextOffset: offset + limit < text.length ? offset + limit : null,
    text: text.slice(offset, offset + limit),
  };
}
