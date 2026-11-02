import { useState, useCallback } from 'react';
import {
  Folder,
  FolderOpen,
  Plus,
  FolderInput,
  Archive,
  MoreHorizontal,
  ShieldCheck,
  Unplug,
  RefreshCw,
} from 'lucide-react';
import { useWorkspace } from '../context';
import { api, post, patch } from '../api';
import { hasDesktopActions, selectProjectDirectory, revealProjectPath } from '../desktop';
import { PageHeading, Modal, Spinner, Status, SearchBox, Empty } from '../components/UI';
import type { Project, ProjectDirectoryGrant, Session } from '../../../../packages/shared/types';

export function ProjectEditor({
  mode,
  project,
  onClose,
}: {
  mode: 'create' | 'import' | 'connect' | 'edit';
  project?: Project;
  onClose: () => void;
}) {
  const w = useWorkspace();
  const [busy, setBusy] = useState(false),
    [access, setAccess] = useState<'read' | 'write'>('read'),
    [selection, setSelection] = useState<ProjectDirectoryGrant>();
  const directoryMode = mode === 'import' || mode === 'connect';
  const title =
    mode === 'create'
      ? '创建项目'
      : mode === 'import'
        ? '导入已有项目'
        : mode === 'edit'
          ? '编辑项目'
          : '重新连接项目目录';
  return (
    <Modal
      title={title}
      description={
        directoryMode
          ? '直接连接本地工程，文件保留在原目录。'
          : '让想法、文件和对话围绕同一个项目展开。'
      }
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          const values = Object.fromEntries(new FormData(event.currentTarget));
          void w
            .perform(
              async () => {
                let result: Project;
                if (mode === 'edit')
                  result = await patch(`/local/projects/${project!.id}`, {
                    name: values.name,
                    description: values.description,
                  });
                else if (mode === 'connect')
                  result = await post(`/local/projects/${project!.id}/connect`, {
                    grantId: selection!.grantId,
                  });
                else if (mode === 'import')
                  result = await post('/local/projects/import', {
                    name: values.name,
                    description: values.description,
                    grantId: selection!.grantId,
                  });
                else result = await post('/local/projects', values);
                if (mode === 'create' || mode === 'import') {
                  const session = await post<Session>('/local/sessions', { projectId: result.id });
                  await w.refresh();
                  w.openSession(session.id);
                } else await w.refresh();
                onClose();
              },
              mode === 'connect'
                ? '项目目录已重新授权'
                : mode === 'edit'
                  ? '项目已更新'
                  : mode === 'import'
                    ? '项目已连接'
                    : '项目已创建',
            )
            .finally(() => setBusy(false));
        }}
      >
        {mode !== 'connect' && (
          <>
            <label>
              项目名称
              <input
                name="name"
                defaultValue={project?.name}
                placeholder="例如：云端冒险"
                required
                maxLength={60}
              />
            </label>
            <label>
              项目简介
              <textarea
                name="description"
                defaultValue={project?.description}
                placeholder="描述玩法、风格或目标…"
                rows={2}
                maxLength={300}
              />
            </label>
          </>
        )}
        {mode === 'create' && (
          <label>
            游戏引擎
            <select name="engine" aria-label="游戏引擎">
              <option value="Web">浏览器小游戏</option>
              <option>Godot</option>
              <option>Unity</option>
              <option>Unreal</option>
              <option>通用</option>
            </select>
          </label>
        )}
        {directoryMode && (
          <>
            <fieldset className="project-access-picker">
              <legend>Agent 的目录权限</legend>
              {(['read', 'write'] as const).map((value) => (
                <label key={value}>
                  <input
                    type="radio"
                    name="directoryAccess"
                    checked={access === value}
                    value={value}
                    onChange={() => {
                      setAccess(value);
                      setSelection(undefined);
                    }}
                  />
                  <span>
                    <strong>{value === 'read' ? '只读' : '允许读写'}</strong>
                    <small>
                      {value === 'read'
                        ? '读取代码和资料，不修改文件'
                        : '可按你的要求创建或修改项目文件'}
                    </small>
                  </span>
                </label>
              ))}
            </fieldset>
            <button
              type="button"
              className="button secondary project-folder-choice"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void w
                  .perform(async () => {
                    const result = await selectProjectDirectory(access, project?.id);
                    if (result) setSelection(result);
                  })
                  .finally(() => setBusy(false));
              }}
            >
              <FolderOpen size={17} />
              {busy ? '正在选择…' : selection ? '重新选择文件夹' : '选择本地文件夹'}
            </button>
            {selection && (
              <div className="project-selected-directory">
                <strong>
                  {selection.name}
                  <Status tone="green">{selection.engine}</Status>
                </strong>
                <code>{selection.root}</code>
                <p>{selection.access === 'read' ? '只读授权' : '读写授权'} · 选择后 5 分钟内确认</p>
              </div>
            )}
            <p className="form-hint">
              {hasDesktopActions()
                ? '授权仅限所选目录。与 Agent 工作时，相关文件内容可能发送给你选择的模型。'
                : '本地目录需要通过 LightMao 桌面端的文件夹选择器授权。'}
            </p>
          </>
        )}
        {mode === 'create' && <p className="form-hint">将在本地独立工作目录中创建项目。</p>}
        <footer>
          <button type="button" className="button secondary" onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={busy || (directoryMode && !selection)}>
            {busy ? <Spinner /> : null}
            {mode === 'connect'
              ? '确认连接'
              : mode === 'import'
                ? '连接项目'
                : mode === 'edit'
                  ? '保存修改'
                  : '创建并开始'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export function Projects() {
  const w = useWorkspace();
  const [query, setQuery] = useState(''),
    [tab, setTab] = useState<'active' | 'archived'>('active');
  const [editor, setEditor] = useState<{
    mode: 'create' | 'import' | 'edit' | 'connect';
    project?: Project;
  }>();
  const [confirm, setConfirm] = useState<{ project: Project; action: 'archive' | 'revoke' }>(),
    [busy, setBusy] = useState(false);
  const closeEditor = useCallback(() => setEditor(undefined), []),
    closeConfirm = useCallback(() => setConfirm(undefined), []);
  const projects = w.local.projects.filter(
    (p) =>
      (p.status || 'active') === tab &&
      `${p.name} ${p.description} ${p.engine}`.toLowerCase().includes(query.toLowerCase()),
  );
  async function open(project: Project) {
    const result = await api<{ items: { id: string }[] }>(
      `/local/sessions?projectId=${encodeURIComponent(project.id)}&state=${project.status === 'archived' || project.access === 'revoked' ? 'all' : 'active'}&limit=1`,
    );
    const session = result.items[0];
    if (session) w.openSession(session.id);
    else await w.newSession(project.id);
  }
  return (
    <div className="page-scroll">
      <div className="page-content projects-page">
        <PageHeading
          title="把项目，带到工作台。"
          description="连接已有游戏工程，或为下一个想法创建一个新目录。"
          action={
            <div className="project-page-actions">
              <button className="button secondary" onClick={() => setEditor({ mode: 'import' })}>
                <FolderInput size={17} />
                导入已有项目
              </button>
              <button className="button primary" onClick={() => setEditor({ mode: 'create' })}>
                <Plus size={17} />
                新建项目
              </button>
            </div>
          }
        />
        <div className="collection-toolbar">
          <div className="tabs">
            {(['active', 'archived'] as const).map((value) => (
              <button
                key={value}
                className={tab === value ? 'selected' : ''}
                onClick={() => setTab(value)}
              >
                {value === 'active' ? '进行中' : '已归档'}
                <span>
                  {w.local.projects.filter((p) => (p.status || 'active') === value).length}
                </span>
              </button>
            ))}
          </div>
          <SearchBox value={query} onChange={setQuery} placeholder="搜索项目…" />
        </div>
        <div className="project-card-list">
          {projects.map((p) => (
            <article className="project-card" key={p.id}>
              <div className="project-card-top">
                <div className="project-card-icon">
                  <Folder size={25} strokeWidth={1.5} />
                </div>
                <div>
                  <h2>{p.name}</h2>
                  <p>{p.description || '为这个项目留下一句话。'}</p>
                </div>
                <Status tone={p.access === 'revoked' ? 'neutral' : 'green'}>
                  {p.access === 'revoked' ? '目录已断开' : p.access === 'read' ? '只读' : '可读写'}
                </Status>
              </div>
              <div className="project-card-meta">
                <span>{p.engine}</span>
                <span>{p.source === 'imported' ? '已导入工程' : '工作台创建'}</span>
                <span>
                  {w.local.sessionCounts?.[p.id]?.total ??
                    w.local.sessions.filter((s) => s.projectId === p.id).length}{' '}
                  个会话
                </span>
              </div>
              <code className="project-root-path" title={p.root}>
                {p.root}
              </code>
              <div className="project-card-footer">
                <button
                  className="button secondary small-button"
                  disabled={
                    !(
                      w.local.sessionCounts?.[p.id]?.total ??
                      w.local.sessions.filter((s) => s.projectId === p.id).length
                    ) &&
                    (tab === 'archived' || p.access === 'revoked')
                  }
                  onClick={() => void w.perform(() => open(p))}
                >
                  {tab === 'archived' || p.access === 'revoked' ? '查看会话' : '打开项目'}
                </button>
                <div>
                  {tab === 'archived' ? (
                    <button
                      className="text-button"
                      aria-label={`恢复项目${p.name}`}
                      onClick={() =>
                        void w.perform(async () => {
                          await patch(`/local/projects/${p.id}`, { status: 'active' });
                          await w.refresh();
                        }, '项目已恢复，定时任务可手动重新启用')
                      }
                    >
                      <RefreshCw size={14} />
                      恢复项目
                    </button>
                  ) : (
                    <>
                      <button
                        className="icon-button"
                        title="在文件管理器中显示"
                        aria-label={`定位项目${p.name}`}
                        disabled={!hasDesktopActions() || p.access === 'revoked'}
                        onClick={() => void w.perform(() => revealProjectPath(p.id))}
                      >
                        <FolderOpen size={16} />
                      </button>
                      <button
                        className="icon-button"
                        title="目录授权"
                        aria-label={`目录授权${p.name}`}
                        onClick={() => setEditor({ mode: 'connect', project: p })}
                      >
                        <ShieldCheck size={16} />
                      </button>
                      <button
                        className="icon-button"
                        title="断开目录"
                        aria-label={`断开项目${p.name}`}
                        disabled={p.access === 'revoked'}
                        onClick={() => setConfirm({ project: p, action: 'revoke' })}
                      >
                        <Unplug size={16} />
                      </button>
                      <button
                        className="icon-button"
                        title="归档项目"
                        aria-label={`归档项目${p.name}`}
                        onClick={() => setConfirm({ project: p, action: 'archive' })}
                      >
                        <Archive size={16} />
                      </button>
                    </>
                  )}
                  <button
                    className="icon-button"
                    title="编辑项目"
                    aria-label={`编辑项目${p.name}`}
                    onClick={() => setEditor({ mode: 'edit', project: p })}
                  >
                    <MoreHorizontal size={18} />
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
        {!projects.length && (
          <Empty
            icon={<Folder size={30} />}
            title={
              query ? '没有找到相关项目' : tab === 'archived' ? '还没有归档项目' : '从一个项目开始'
            }
            description={
              tab === 'archived'
                ? '归档会保留本地文件与会话，恢复后可以继续工作。'
                : '创建新项目，或在桌面端连接已有工程。'
            }
          />
        )}
      </div>
      {editor && <ProjectEditor {...editor} onClose={closeEditor} />}
      {confirm && (
        <Modal
          title={confirm.action === 'archive' ? '归档这个项目？' : '断开项目目录？'}
          description={`「${confirm.project.name}」的文件与会话会保留，当前运行将停止，定时任务会暂停。`}
          onClose={closeConfirm}
        >
          <p className="form-hint">
            {confirm.action === 'archive'
              ? '归档后可在“已归档”中恢复。'
              : '重新通过桌面端选择目录并授权后，Agent 才能继续访问文件。'}
          </p>
          <footer>
            <button className="button secondary" onClick={closeConfirm}>
              取消
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void w
                  .perform(
                    async () => {
                      await patch(
                        `/local/projects/${confirm.project.id}`,
                        confirm.action === 'archive'
                          ? { status: 'archived' }
                          : { access: 'revoked' },
                      );
                      await w.refresh();
                      closeConfirm();
                    },
                    confirm.action === 'archive' ? '项目已归档' : '目录已断开',
                  )
                  .finally(() => setBusy(false));
              }}
            >
              {confirm.action === 'archive' ? '确认归档' : '确认断开'}
            </button>
          </footer>
        </Modal>
      )}
    </div>
  );
}
