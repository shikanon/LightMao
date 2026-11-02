import { useState, useRef, useCallback, useEffect } from 'react';
import {
  Upload,
  Cloud,
  FileText,
  Image,
  File,
  Download,
  Trash2,
  Search,
  HardDrive,
  FolderPlus,
  Folder,
  ChevronRight,
  ArrowLeft,
  Pencil,
  RotateCcw,
  Music,
  Film,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { useWorkspace } from '../context';
import { api, post, patch, downloadAsset, assetMediaUrl } from '../api';
import {
  PageHeading,
  SearchBox,
  Empty,
  Modal,
  Spinner,
  formatSize,
  formatTime,
} from '../components/UI';
import type { Asset, AssetFolder } from '../../../../packages/shared/types';

const category = (name: string) =>
  /\.(png|jpg|jpeg|webp|gif)$/i.test(name)
    ? '图片'
    : /\.(mp3|wav|ogg)$/i.test(name)
      ? '音频'
      : /\.(mp4|webm)$/i.test(name)
        ? '视频'
        : /\.(md|txt|pdf|docx|json|csv|ts|js|cs|gd|yaml|shader|godot)$/i.test(name)
          ? '文档'
          : '其他';
const icons = { 图片: Image, 文档: FileText, 音频: Music, 视频: Film, 其他: File };
function folderPath(folder: AssetFolder, folders: AssetFolder[]) {
  const names = [folder.name];
  let p = folder.parentId;
  for (let n = 0; p && n < 50; n++) {
    const parent = folders.find((f) => f.id === p);
    if (!parent) break;
    names.unshift(parent.name);
    p = parent.parentId;
  }
  return names.join(' / ');
}

export function AssetLibrary() {
  const w = useWorkspace();
  const [query, setQuery] = useState(''),
    [filter, setFilter] = useState('全部文件'),
    [folderId, setFolderId] = useState<string>(),
    [trash, setTrash] = useState(false),
    [deleted, setDeleted] = useState<Asset[]>([]),
    [busy, setBusy] = useState(false),
    [dragging, setDragging] = useState(false),
    [preview, setPreview] = useState<Asset>(),
    [edit, setEdit] = useState<Asset>(),
    [removing, setRemoving] = useState<Asset>(),
    [purging, setPurging] = useState<Asset>(),
    [folderEdit, setFolderEdit] = useState<AssetFolder | 'new'>(),
    [transfers, setTransfers] = useState<{ id: string; name: string; status: string }[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const folders = w.cloud.folders || [],
    current = folders.find((f) => f.id === folderId);
  const closePreview = useCallback(() => setPreview(undefined), []),
    closeEdit = useCallback(() => setEdit(undefined), []),
    closeRemove = useCallback(() => setRemoving(undefined), []),
    closePurge = useCallback(() => setPurging(undefined), []),
    closeFolder = useCallback(() => setFolderEdit(undefined), []);
  const loadTrash = async () => setDeleted(await api<Asset[]>('/api/assets/trash'));
  useEffect(() => {
    if (trash) void w.perform(loadTrash);
  }, [trash]);
  useEffect(() => {
    void api<typeof transfers>('/api/assets/transfers')
      .then(setTransfers)
      .catch(() => {});
  }, [w.cloud.assets.length]);
  const refresh = async () => {
    await w.refresh();
    if (trash) await loadTrash();
    void api<typeof transfers>('/api/assets/transfers')
      .then(setTransfers)
      .catch(() => {});
  };
  const upload = async (file: globalThis.File | undefined) => {
    if (!file) return;
    if (file.size > (w.cloud.storage?.fileLimitBytes || 20 * 1024 * 1024)) {
      w.notify('单个文件不能超过 20 MB');
      return;
    }
    setBusy(true);
    await w.perform(async () => {
      const body = new FormData();
      if (folderId) body.append('folderId', folderId);
      body.append('file', file);
      await api('/api/assets', { method: 'POST', body });
      await refresh();
    }, '资料已上传');
    setBusy(false);
    if (input.current) input.current.value = '';
    void api<typeof transfers>('/api/assets/transfers')
      .then(setTransfers)
      .catch(() => {});
  };
  const visible = (trash ? deleted : w.cloud.assets).filter(
    (a) =>
      (trash || !!query || a.folderId === folderId) &&
      (filter === '全部文件' || category(a.name) === filter) &&
      a.name.toLowerCase().includes(query.toLowerCase()),
  );
  const children = !trash && !query ? folders.filter((f) => f.parentId === folderId) : [];
  const used = w.cloud.storage?.usedBytes ?? w.cloud.assets.reduce((n, a) => n + a.size, 0);
  return (
    <div
      className={`page-scroll ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => {
        if (!trash) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (!trash) void upload(e.dataTransfer.files[0]);
      }}
    >
      <div className="page-content">
        <PageHeading
          title="让灵感，有处可寻。"
          description="设计文档、参考图片与游戏素材，随时整理和引用。"
          action={
            <div className="library-actions">
              <button
                className="button secondary"
                onClick={() => setFolderEdit('new')}
                disabled={trash}
              >
                <FolderPlus size={16} />
                新建文件夹
              </button>
              <button
                className="button primary"
                disabled={busy || trash}
                onClick={() => input.current?.click()}
              >
                <Upload size={16} />
                {busy ? '上传中…' : '上传资料'}
              </button>
            </div>
          }
        />
        <input
          type="file"
          ref={input}
          hidden
          aria-label="上传资料文件"
          onChange={(e) => void upload(e.target.files?.[0])}
        />
        <div className="space-summary">
          <div className="space-illustration">
            <Cloud size={35} strokeWidth={1.2} />
          </div>
          <div>
            <strong>我的资料空间</strong>
            <p>{w.cloud.assets.length} 份资料 · 在对话中随时引用</p>
          </div>
          <div className="storage-meter">
            <div>
              <span>
                {formatSize(used)} / {formatSize(w.cloud.storage?.quotaBytes || 200 * 1024 * 1024)}
              </span>
              <HardDrive size={13} />
            </div>
            <progress value={used} max={w.cloud.storage?.quotaBytes || 200 * 1024 * 1024} />
            <small>{w.cloud.storage?.label || '本地存储'} · 含回收站占用</small>
          </div>
        </div>
        {transfers.length > 0 && (
          <div className="library-transfer" role="status">
            <span>
              {transfers.filter((t) => t.status !== 'failed').length} 项上传结果待核对，
              {transfers.filter((t) => t.status === 'failed').length}{' '}
              项已确认未写入。核查不会重复上传。
            </span>
            <button
              className="text-button"
              onClick={() =>
                void w.perform(async () => {
                  await post('/api/assets/reconcile');
                  await refresh();
                }, '已核查上传记录')
              }
            >
              核查结果
            </button>
            {transfers.some((t) => t.status === 'failed') && (
              <button
                className="text-button"
                onClick={() =>
                  void w.perform(async () => {
                    for (const transfer of transfers.filter((t) => t.status === 'failed'))
                      await api(`/api/assets/transfers/${transfer.id}`, { method: 'DELETE' });
                    await refresh();
                  }, '已清理失败记录，可重新选择文件上传')
                }
              >
                清理失败记录
              </button>
            )}
          </div>
        )}
        <div className="library-location">
          <button
            onClick={() => {
              setTrash(false);
              setFolderId(undefined);
              setQuery('');
            }}
          >
            全部资料
          </button>
          {current && !trash && (
            <>
              <ChevronRight size={13} />
              <span>{folderPath(current, folders)}</span>
              <button
                className="icon-button"
                aria-label="编辑当前文件夹"
                onClick={() => setFolderEdit(current)}
              >
                <Pencil size={14} />
              </button>
            </>
          )}
          <button
            className={`library-trash ${trash ? 'selected' : ''}`}
            onClick={() => {
              setTrash(!trash);
              setQuery('');
              setFilter('全部文件');
            }}
          >
            <Trash2 size={14} />
            {trash ? '返回资料' : '回收站'}
          </button>
        </div>
        {trash && (
          <div className="library-bin-note">文件移入回收站后仍可恢复；永久删除后释放空间。</div>
        )}
        {!trash && current && (
          <button className="back-link" onClick={() => setFolderId(current.parentId)}>
            <ArrowLeft size={14} />
            上一级
          </button>
        )}
        {children.length > 0 && (
          <div className="library-folders">
            {children.map((f) => (
              <div key={f.id}>
                <button onClick={() => setFolderId(f.id)}>
                  <Folder size={24} />
                  <strong>{f.name}</strong>
                  <small>{w.cloud.assets.filter((a) => a.folderId === f.id).length} 份资料</small>
                </button>
                <button
                  className="icon-button"
                  aria-label={`编辑文件夹${f.name}`}
                  onClick={() => setFolderEdit(f)}
                >
                  <Pencil size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="collection-toolbar">
          <div className="tabs">
            {['全部文件', '文档', '图片', '音频', '视频', '其他'].map((t) => (
              <button
                key={t}
                className={filter === t ? 'selected' : ''}
                onClick={() => setFilter(t)}
              >
                {t}
              </button>
            ))}
          </div>
          <SearchBox
            value={query}
            onChange={setQuery}
            placeholder={trash ? '搜索回收站…' : '搜索全部资料…'}
          />
        </div>
        {visible.length ? (
          <div className="table-wrap">
            <table className="asset-table">
              <thead>
                <tr>
                  <th>文件名称</th>
                  <th>类型</th>
                  <th>大小</th>
                  <th>{trash ? '删除时间' : '添加时间'}</th>
                  <th>
                    <span className="sr-only">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((a) => {
                  const Icon = icons[category(a.name)];
                  return (
                    <tr key={a.id}>
                      <td>
                        <button
                          className="file-name-cell"
                          disabled={trash}
                          onClick={() => setPreview(a)}
                        >
                          <span
                            className={`file-type-icon ${category(a.name) === '图片' ? 'green' : 'blue'}`}
                          >
                            <Icon size={20} />
                          </span>
                          <strong>{a.name}</strong>
                        </button>
                      </td>
                      <td>{a.name.split('.').at(-1)?.toUpperCase()}</td>
                      <td>{formatSize(a.size)}</td>
                      <td>{formatTime(trash ? a.deletedAt! : a.createdAt)}</td>
                      <td>
                        <div className="row-actions">
                          {trash ? (
                            <>
                              <button
                                className="icon-button"
                                aria-label={`恢复${a.name}`}
                                onClick={() =>
                                  void w.perform(async () => {
                                    await post(`/api/assets/${a.id}/restore`);
                                    await refresh();
                                  }, '资料已恢复')
                                }
                              >
                                <RotateCcw size={16} />
                              </button>
                              <button
                                className="icon-button"
                                aria-label={`永久删除${a.name}`}
                                onClick={() => setPurging(a)}
                              >
                                <Trash2 size={16} />
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                className="icon-button"
                                aria-label={`编辑${a.name}`}
                                onClick={() => setEdit(a)}
                              >
                                <Pencil size={16} />
                              </button>
                              <button
                                className="icon-button"
                                aria-label={`下载${a.name}`}
                                onClick={() =>
                                  void w.perform(() => downloadAsset(a.id, a.name), '已开始下载')
                                }
                              >
                                <Download size={16} />
                              </button>
                              <button
                                className="icon-button"
                                aria-label={`删除${a.name}`}
                                onClick={() => setRemoving(a)}
                              >
                                <Trash2 size={16} />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            icon={<Search size={28} />}
            title={trash ? '回收站是空的' : query ? '没有找到资料' : '这个文件夹还没有资料'}
            description={
              trash ? '已删除的文件会出现在这里。' : '上传一份文档或素材，开始整理你的工作空间。'
            }
          />
        )}
        {!trash && (
          <button
            className="upload-dropzone"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            <Upload size={22} />
            <span>拖拽文件到这里，或点击上传</span>
            <small>单文件最大 20 MB · 按当前文件夹收纳</small>
          </button>
        )}
      </div>
      {dragging && (
        <div className="drop-overlay">
          <Cloud size={48} />
          <h2>松开，收纳这份灵感</h2>
        </div>
      )}
      {preview && <Preview asset={preview} onClose={closePreview} />}
      {edit && (
        <Modal title="整理资料" description="修改文件名或移动到其他文件夹。" onClose={closeEdit}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const values = Object.fromEntries(new FormData(e.currentTarget));
              void w.perform(async () => {
                await patch(`/api/assets/${edit.id}`, {
                  name: values.name,
                  folderId: values.folderId || null,
                });
                await refresh();
                closeEdit();
              }, '资料已更新');
            }}
          >
            <label>
              文件名称
              <input
                name="name"
                aria-label="文件名称"
                defaultValue={edit.name}
                required
                maxLength={180}
              />
            </label>
            <label>
              所在文件夹
              <select name="folderId" aria-label="所在文件夹" defaultValue={edit.folderId || ''}>
                <option value="">全部资料</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {folderPath(f, folders)}
                  </option>
                ))}
              </select>
            </label>
            <footer>
              <button type="button" className="button secondary" onClick={closeEdit}>
                取消
              </button>
              <button className="button primary">保存</button>
            </footer>
          </form>
        </Modal>
      )}
      {folderEdit && (
        <Modal title={folderEdit === 'new' ? '新建文件夹' : '编辑文件夹'} onClose={closeFolder}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const values = Object.fromEntries(new FormData(e.currentTarget));
              void w.perform(async () => {
                if (folderEdit === 'new')
                  await post('/api/asset-folders', { name: values.name, parentId: folderId });
                else await patch(`/api/asset-folders/${folderEdit.id}`, { name: values.name });
                await refresh();
                closeFolder();
              }, '文件夹已保存');
            }}
          >
            <label>
              文件夹名称
              <input
                name="name"
                aria-label="文件夹名称"
                defaultValue={folderEdit === 'new' ? '' : folderEdit.name}
                required
                maxLength={80}
              />
            </label>
            <footer>
              {folderEdit !== 'new' && (
                <button
                  type="button"
                  className="button danger-quiet"
                  onClick={() =>
                    void w.perform(async () => {
                      await api(`/api/asset-folders/${folderEdit.id}`, { method: 'DELETE' });
                      if (folderId === folderEdit.id) setFolderId(folderEdit.parentId);
                      await refresh();
                      closeFolder();
                    }, '空文件夹已删除')
                  }
                >
                  删除空文件夹
                </button>
              )}
              <button type="button" className="button secondary" onClick={closeFolder}>
                取消
              </button>
              <button className="button primary">保存</button>
            </footer>
          </form>
        </Modal>
      )}
      {removing && (
        <Modal
          title="移入回收站？"
          description={`「${removing.name}」可从回收站恢复。`}
          onClose={closeRemove}
        >
          <footer>
            <button className="button secondary" onClick={closeRemove}>
              保留资料
            </button>
            <button
              className="button danger"
              onClick={() =>
                void w.perform(async () => {
                  await api(`/api/assets/${removing.id}`, { method: 'DELETE' });
                  await refresh();
                  closeRemove();
                }, '已移入回收站')
              }
            >
              移入回收站
            </button>
          </footer>
        </Modal>
      )}
      {purging && (
        <Modal
          title="永久删除这份资料？"
          description={`「${purging.name}」将从存储中移除，无法恢复。`}
          onClose={closePurge}
        >
          <footer>
            <button className="button secondary" onClick={closePurge}>
              保留
            </button>
            <button
              className="button danger"
              onClick={() =>
                void w.perform(async () => {
                  await api(`/api/assets/${purging.id}/purge`, { method: 'DELETE' });
                  await refresh();
                  closePurge();
                }, '已永久删除')
              }
            >
              永久删除
            </button>
          </footer>
        </Modal>
      )}
    </div>
  );
}

function Preview({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const w = useWorkspace();
  const [content, setContent] = useState<{
      text: string | null;
      truncated?: boolean;
      previewMime?: string | null;
    }>(),
    [url, setUrl] = useState(''),
    [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    let media = '';
    void api<{ text: string | null; truncated?: boolean; previewMime?: string | null }>(
      `/api/assets/${asset.id}/preview`,
      { signal: abort.signal },
    )
      .then(async (data) => {
        if (abort.signal.aborted) return;
        setContent(data);
        if (data.previewMime) {
          media = await assetMediaUrl(asset.id, abort.signal);
          if (abort.signal.aborted) URL.revokeObjectURL(media);
          else setUrl(media);
        }
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => {
      abort.abort();
      if (media) URL.revokeObjectURL(media);
    };
  }, [asset.id]);
  return (
    <Modal
      title={asset.name}
      description={`${formatSize(asset.size)} · 原文件已校验保存`}
      onClose={onClose}
      wide
    >
      <div className="asset-preview">
        {error ? (
          <p className="inline-error" role="alert">
            {error}
          </p>
        ) : !content ? (
          <div className="loading-screen">
            <Spinner />
          </div>
        ) : content.text !== null ? (
          <>
            {content.truncated && (
              <p className="form-hint">当前显示前 64 KB，下载可查看完整内容。</p>
            )}
            {/\.md$/i.test(asset.name) ? (
              <ReactMarkdown>{content.text}</ReactMarkdown>
            ) : (
              <pre className="asset-code">{content.text}</pre>
            )}
          </>
        ) : content.previewMime ? (
          url ? (
            <>
              {content.previewMime.startsWith('image/') ? (
                <img className="asset-media" src={url} alt={asset.name} />
              ) : content.previewMime.startsWith('audio/') ? (
                <audio className="asset-media" src={url} controls />
              ) : (
                <video className="asset-media" src={url} controls preload="metadata" />
              )}
            </>
          ) : (
            <div className="loading-screen">
              <Spinner />
            </div>
          )
        ) : (
          <Empty
            icon={<File size={30} />}
            title="下载原文件查看"
            description="此格式保留原件，可在相应应用中打开。"
          />
        )}
      </div>
      <footer>
        <button
          className="button secondary"
          onClick={() => void w.perform(() => downloadAsset(asset.id, asset.name))}
        >
          <Download size={16} />
          下载原文件
        </button>
        <button className="button primary" onClick={onClose}>
          完成
        </button>
      </footer>
    </Modal>
  );
}
