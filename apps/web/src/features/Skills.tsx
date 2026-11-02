import { useState, useCallback, useRef } from 'react';
import {
  Plus,
  Lightbulb,
  ArrowUpRight,
  Search,
  BookOpen,
  Code2,
  Palette,
  FolderInput,
  FileUp,
  Files,
  RefreshCw,
} from 'lucide-react';
import { useWorkspace } from '../context';
import { api, post, patch, currentAuthUser } from '../api';
import { hasNativeSkillImport, selectSkillDirectory } from '../desktop';
import { PageHeading, SearchBox, Toggle, Modal, Empty, formatTime } from '../components/UI';
import { SkillResources, skillSize } from './SkillResources';
import type { Skill, SkillSummary, SkillImportPreview } from '../../../../packages/shared/types';
const endpoint = (skill: SkillSummary) =>
  `${skill.origin === 'local' ? '/local' : '/api'}/skills/${encodeURIComponent(skill.id)}`;
export function Skills() {
  const w = useWorkspace();
  const [query, setQuery] = useState(''),
    [source, setSource] = useState('all');
  const [editor, setEditor] = useState<Skill | null | undefined>();
  const [busy, setBusy] = useState(false),
    [loadingId, setLoadingId] = useState('');
  const [preview, setPreview] = useState<SkillImportPreview>(),
    [resources, setResources] = useState<SkillSummary>();
  const [deleting, setDeleting] = useState<SkillSummary>();
  const folderInput = useRef<HTMLInputElement>(null),
    markdownInput = useRef<HTMLInputElement>(null),
    replacement = useRef<string | undefined>(undefined),
    previewOwner = useRef('');
  const close = useCallback(() => setEditor(undefined), []);
  const closePreview = useCallback(() => {
      const grant = preview?.grantId;
      setPreview(undefined);
      if (grant && currentAuthUser() === previewOwner.current)
        void api(`/local/skill-stages/${encodeURIComponent(grant)}`, { method: 'DELETE' }).catch(
          () => {},
        );
    }, [preview?.grantId]),
    closeResources = useCallback(() => setResources(undefined), []),
    closeDelete = useCallback(() => setDeleting(undefined), []);
  const list = w.skills.filter(
    (skill) =>
      (source === 'all' || (skill.origin || 'cloud') === source) &&
      (skill.name + skill.description).toLowerCase().includes(query.toLowerCase()),
  );
  const openEditor = async (skill: SkillSummary) => {
    setLoadingId(skill.id);
    await w.perform(async () => setEditor(await api<Skill>(endpoint(skill))));
    setLoadingId('');
  };
  const prepareImport = async (replaceId?: string) => {
    replacement.current = replaceId;
    if (!hasNativeSkillImport()) {
      folderInput.current?.click();
      return;
    }
    setBusy(true);
    await w.perform(async () => {
      const value = await selectSkillDirectory(replaceId);
      if (value) {
        previewOwner.current = currentAuthUser();
        setPreview(value);
      }
    });
    setBusy(false);
  };
  const uploadFolder = async (input: HTMLInputElement) => {
    const files = [...(input.files || [])];
    input.value = '';
    if (!files.length) return;
    const owner = currentAuthUser(),
      target = replacement.current;
    setBusy(true);
    await w.perform(async () => {
      if (
        files.length > 128 ||
        files.some((file) => file.size > 2 * 1048576) ||
        files.reduce((sum, file) => sum + file.size, 0) > 8 * 1048576
      )
        throw new Error('技能包最多 128 个文件、总计 8 MB，单文件最多 2 MB');
      const rootName = files[0].webkitRelativePath.split('/')[0];
      if (!rootName || !files.every((file) => file.webkitRelativePath.startsWith(rootName + '/')))
        throw new Error('请选择包含 SKILL.md 的完整技能目录');
      const prepared = [];
      for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = '';
        for (let start = 0; start < bytes.length; start += 32768)
          binary += String.fromCharCode(...bytes.subarray(start, start + 32768));
        prepared.push({
          path: file.webkitRelativePath.slice(rootName.length + 1),
          base64: btoa(binary),
        });
      }
      if (currentAuthUser() !== owner) throw new Error('账号已切换，请重新选择技能目录');
      const value = await post<SkillImportPreview>('/local/skills/prepare', {
        rootName,
        replaceId: target,
        files: prepared,
      });
      if (currentAuthUser() !== owner) return;
      previewOwner.current = owner;
      setPreview(value);
    });
    setBusy(false);
  };
  return (
    <div className="page-scroll">
      <div className="page-content">
        <PageHeading
          title="把经验，变成技能。"
          description="保留你的工作方法，按需要读取指引与资源。"
          action={
            <div className="skill-page-actions">
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => void prepareImport()}
              >
                <FolderInput size={16} />
                导入技能包
              </button>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => markdownInput.current?.click()}
              >
                <FileUp size={16} />
                导入 Markdown
              </button>
              <button className="button primary" disabled={busy} onClick={() => setEditor(null)}>
                <Plus size={17} />
                创建技能
              </button>
            </div>
          }
        />
        <input
          hidden
          type="file"
          multiple
          aria-label="选择技能包目录"
          ref={(node) => {
            folderInput.current = node;
            node?.setAttribute('webkitdirectory', '');
          }}
          onChange={(e) => void uploadFolder(e.currentTarget)}
        />
        <input
          hidden
          type="file"
          accept=".md,.markdown"
          aria-label="选择 Markdown 技能"
          ref={markdownInput}
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = '';
            if (!file) return;
            const owner = currentAuthUser();
            void w.perform(async () => {
              if (file.size > 120000) throw new Error('Markdown 技能最多 30,000 字符');
              const content = await file.text();
              if (content.length > 30000) throw new Error('Markdown 技能最多 30,000 字符');
              if (currentAuthUser() !== owner) return;
              setEditor({
                id: '',
                name: file.name.replace(/\.(md|markdown)$/i, '').slice(0, 80),
                description: '',
                category: '自定义',
                content,
                enabled: true,
                origin: 'cloud',
                updatedAt: new Date().toISOString(),
              });
            });
          }}
        />
        <div className="collection-toolbar">
          <div className="tabs">
            {[
              ['all', '全部'],
              ['local', '本机'],
              ['cloud', '云端'],
            ].map(([value, label]) => (
              <button
                key={value}
                className={source === value ? 'selected' : ''}
                onClick={() => setSource(value)}
              >
                {label}
                <span>
                  {
                    w.skills.filter(
                      (skill) => value === 'all' || (skill.origin || 'cloud') === value,
                    ).length
                  }
                </span>
              </button>
            ))}
          </div>
          <SearchBox value={query} onChange={setQuery} placeholder="搜索技能…" />
        </div>
        {busy && (
          <p className="form-hint" role="status">
            正在检查技能包…
          </p>
        )}
        <div className="skills-list">
          {list.map((skill) => {
            const Icon =
              skill.category === '策划'
                ? BookOpen
                : skill.category === '程序'
                  ? Code2
                  : skill.category === '美术'
                    ? Palette
                    : Lightbulb;
            return (
              <article key={skill.id} className="skill-row">
                <div
                  className={`plugin-icon ${skill.category === '美术' ? 'orange' : skill.category === '程序' ? 'blue' : 'violet'}`}
                >
                  <Icon size={25} strokeWidth={1.5} />
                </div>
                <button
                  className="skill-content"
                  disabled={loadingId === skill.id}
                  onClick={() => void openEditor(skill)}
                >
                  <div>
                    <h2>{skill.name}</h2>
                    <span>{skill.category}</span>
                  </div>
                  <p>{skill.description}</p>
                  <small>
                    {skill.origin === 'local'
                      ? `本机技能包 · ${skill.fileCount} 个文件`
                      : '云端 Markdown'}{' '}
                    · 更新于 {formatTime(skill.updatedAt)}
                  </small>
                </button>
                <div className="skill-row-actions">
                  <Toggle
                    checked={skill.enabled}
                    label={`启用${skill.name}`}
                    onChange={() =>
                      void w.perform(
                        async () => {
                          await patch(endpoint(skill), {
                            enabled: !skill.enabled,
                            ...(skill.revision !== undefined ? { revision: skill.revision } : {}),
                          });
                          await w.refresh();
                        },
                        skill.enabled ? '技能已停用' : '技能已启用',
                      )
                    }
                  />
                  {skill.origin === 'local' && (
                    <>
                      <button
                        className="icon-button"
                        aria-label={`查看技能资源${skill.name}`}
                        onClick={() => setResources(skill)}
                      >
                        <Files size={17} />
                      </button>
                      <button
                        className="icon-button"
                        aria-label={`更新技能包${skill.name}`}
                        disabled={busy}
                        onClick={() => void prepareImport(skill.id)}
                      >
                        <RefreshCw size={16} />
                      </button>
                    </>
                  )}
                  <button
                    className="icon-button"
                    aria-label={`编辑${skill.name}`}
                    disabled={loadingId === skill.id}
                    onClick={() => void openEditor(skill)}
                  >
                    <ArrowUpRight size={18} />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
        {!list.length && (
          <Empty
            icon={<Search size={28} />}
            title="还没有匹配的技能"
            description="创建 Markdown 技能，或导入含 SKILL.md 的技能文件夹。"
          />
        )}
        <div className="skill-tip">
          <Lightbulb size={20} />
          <div>
            <strong>技能，是你给 Agent 的工作手册</strong>
            <p>
              在会话中点击「＋」选择已启用技能。Agent
              先读取指引，再按需读取资源。本机技能包保存在此设备；创建或导入的 Markdown
              保存到当前账号。按需读取的技能内容会进入当前模型的上下文。
            </p>
          </div>
        </div>
      </div>
      {resources && <SkillResources skill={resources} onClose={closeResources} />}
      {preview && (
        <Modal
          title={preview.replaceId ? '更新本机技能包' : '导入本机技能包'}
          description={`${preview.files.length} 个文件 · ${skillSize(preview.totalBytes)} · 保存在此设备`}
          onClose={closePreview}
          wide
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const values = new FormData(e.currentTarget);
              setBusy(true);
              void w
                .perform(async () => {
                  if (currentAuthUser() !== previewOwner.current)
                    throw new Error('账号已切换，请重新选择技能目录');
                  const value = await post<{ skill: SkillSummary; duplicate: boolean }>(
                    '/local/skills/import',
                    {
                      grantId: preview.grantId,
                      name: values.get('name'),
                      category: values.get('category'),
                      enabled: values.get('enabled') === 'on',
                    },
                  );
                  await w.refresh();
                  closePreview();
                  w.notify(value.duplicate ? '技能包已存在，保留现有设置' : '技能包已导入');
                })
                .finally(() => setBusy(false));
            }}
          >
            <div className="form-grid">
              <label>
                显示名称
                <input
                  name="name"
                  required
                  maxLength={80}
                  defaultValue={
                    preview.replaceId
                      ? w.skills.find((skill) => skill.id === preview.replaceId)?.name
                      : preview.name
                  }
                />
              </label>
              <label>
                分类
                <select
                  aria-label="分类"
                  name="category"
                  defaultValue={
                    preview.replaceId
                      ? w.skills.find((skill) => skill.id === preview.replaceId)?.category
                      : '自定义'
                  }
                >
                  {['策划', '程序', '美术', '测试', '自定义'].map((category) => (
                    <option key={category}>{category}</option>
                  ))}
                </select>
              </label>
            </div>
            <p className="skill-import-description">{preview.description}</p>
            <details className="skill-instructions">
              <summary>查看 SKILL.md 指引</summary>
              <pre>{preview.instructions}</pre>
            </details>
            <div className="skill-import-files" aria-label="技能包文件清单">
              {preview.files.map((file) => (
                <div key={file.path}>
                  <span>{file.path}</span>
                  <small>{skillSize(file.bytes)}</small>
                </div>
              ))}
            </div>
            {preview.ignored.length > 0 && (
              <p className="form-hint">已忽略仓库或缓存项：{preview.ignored.join('、')}</p>
            )}
            <label className="checkbox-label">
              <input
                name="enabled"
                type="checkbox"
                defaultChecked={
                  preview.replaceId
                    ? w.skills.find((skill) => skill.id === preview.replaceId)?.enabled
                    : true
                }
              />
              导入后启用，可在会话中选择
            </label>
            <p className="form-hint">
              支持指引、参考文档和素材。脚本作为资源文本保存，执行权限由独立工具控制。每包最多 128
              个文件、总计 8 MB，单文件最多 2 MB。
            </p>
            <footer>
              <button type="button" className="button secondary" onClick={closePreview}>
                取消
              </button>
              <button className="button primary" disabled={busy}>
                {busy ? '导入中…' : preview.replaceId ? '确认更新' : '确认导入'}
              </button>
            </footer>
          </form>
        </Modal>
      )}
      {editor !== undefined && (
        <Modal
          title={editor?.id ? '编辑技能' : '创建技能'}
          description={
            editor?.origin === 'local'
              ? '编辑本机副本的 SKILL.md；描述来自 frontmatter，资源文件保持原样。'
              : '使用 Markdown 编写工作指导，保存到当前账号。'
          }
          onClose={close}
          wide
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setBusy(true);
              const values = Object.fromEntries(new FormData(e.currentTarget));
              void w
                .perform(async () => {
                  const data =
                    editor?.origin === 'local'
                      ? {
                          name: values.name,
                          category: values.category,
                          content: values.content,
                          revision: editor.revision || 0,
                        }
                      : {
                          ...values,
                          ...(editor?.id ? { revision: editor.revision || 0 } : { enabled: true }),
                        };
                  if (editor?.id) await patch(endpoint(editor), data);
                  else await post('/api/skills', data);
                  await w.refresh();
                  close();
                }, '技能已保存')
                .finally(() => setBusy(false));
            }}
          >
            <div className="form-grid">
              <label>
                技能名称
                <input
                  required
                  maxLength={80}
                  name="name"
                  defaultValue={editor?.name}
                  placeholder="例如：战斗系统设计"
                />
              </label>
              <label>
                分类
                <select
                  aria-label="分类"
                  name="category"
                  defaultValue={editor?.category || '自定义'}
                >
                  {['策划', '程序', '美术', '测试', '自定义'].map((category) => (
                    <option key={category}>{category}</option>
                  ))}
                </select>
              </label>
            </div>
            {editor?.origin !== 'local' && (
              <label>
                一句话描述
                <input
                  name="description"
                  maxLength={300}
                  defaultValue={editor?.description}
                  placeholder="这个技能能帮助 Agent 做什么？"
                />
              </label>
            )}
            <label>
              技能内容{' '}
              <span className="label-hint">
                {editor?.origin === 'local' ? 'SKILL.md' : 'Markdown'}
              </span>
              <textarea
                className="code-editor"
                rows={12}
                name="content"
                required
                maxLength={30000}
                defaultValue={
                  editor?.content ||
                  '# 工作目标\n\n## 执行步骤\n1. 先了解项目背景与约束。\n2. 给出可验证的结果。\n\n## 验收标准\n'
                }
                spellCheck={false}
              />
            </label>
            <footer>
              {editor?.id && (
                <button
                  type="button"
                  className="button danger-quiet"
                  onClick={() => {
                    setDeleting(editor);
                    close();
                  }}
                >
                  删除技能
                </button>
              )}
              <button type="button" className="button secondary" onClick={close}>
                取消
              </button>
              <button className="button primary" disabled={busy}>
                {busy ? '保存中…' : '保存技能'}
              </button>
            </footer>
          </form>
        </Modal>
      )}
      {deleting && (
        <Modal
          title="删除这个技能？"
          description={`「${deleting.name}」将从${deleting.origin === 'local' ? '本机技能列表' : '当前账号'}移除，既有会话和执行归档保留。`}
          onClose={closeDelete}
        >
          <footer>
            <button className="button secondary" onClick={closeDelete}>
              取消
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void w
                  .perform(async () => {
                    await api(endpoint(deleting), { method: 'DELETE' });
                    await w.refresh();
                    closeDelete();
                    close();
                  }, '技能已删除')
                  .finally(() => setBusy(false));
              }}
            >
              确认删除
            </button>
          </footer>
        </Modal>
      )}
    </div>
  );
}
