import { useEffect, useState } from 'react';
import {
  FileText,
  Film,
  Image,
  LoaderCircle,
  RefreshCw,
  X,
  CloudUpload,
  AlertCircle,
} from 'lucide-react';
import { assetMediaUrl } from '../api';
import { desktopShortcutLabels } from './useDesktopShortcuts';
import type { useDesktopComposer } from './useDesktopComposer';
import type { ConversationAttachment } from './desktop-session-state';
import './conversation-attachments.css';
type Composer = ReturnType<typeof useDesktopComposer>;
function Thumbnail({ item }: { item: ConversationAttachment }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (item.previewUrl || !item.assetId || !item.mime.startsWith('image/')) return;
    const abort = new AbortController();
    let value: string | undefined;
    void assetMediaUrl(item.assetId, abort.signal)
      .then((next) => {
        value = next;
        if (abort.signal.aborted) URL.revokeObjectURL(next);
        else setUrl(next);
      })
      .catch(() => {});
    return () => {
      abort.abort();
      if (value) URL.revokeObjectURL(value);
    };
  }, [item.assetId, item.previewUrl, item.mime]);
  if (item.previewUrl || url) return <img src={item.previewUrl || url} alt={item.name} />;
  return item.kind === 'reference' ? (
    <Film size={20} />
  ) : item.mime.startsWith('image/') ? (
    <Image size={20} />
  ) : (
    <FileText size={20} />
  );
}
const labels = {
  uploading: '上传中',
  processing: '资料处理中',
  ready: '已添加',
  error: '未完成',
  unknown: '待核对',
};
export function ConversationAttachments({ composer }: { composer: Composer }) {
  return (
    <>
      <input
        ref={composer.fileInputRef}
        className="conversation-file-input"
        aria-label="添加对话附件"
        type="file"
        multiple
        onChange={(event) => {
          if (event.target.files) composer.addFiles(event.target.files);
          event.target.value = '';
        }}
      />
      {!!composer.attachments.length && (
        <div className="conversation-attachments" aria-label="本条消息附件" role="list">
          {composer.attachments.map((item) => (
            <div
              className={'conversation-attachment attachment-' + item.status}
              role="listitem"
              key={item.id}
            >
              <div className="attachment-thumb">
                <Thumbnail item={item} />
              </div>
              <div className="attachment-copy">
                <strong title={item.name}>{item.name}</strong>
                <span>
                  {['uploading', 'processing'].includes(item.status) && (
                    <LoaderCircle className="spin" size={12} />
                  )}
                  {item.status === 'unknown' || item.status === 'error' ? (
                    <AlertCircle size={12} />
                  ) : null}
                  {labels[item.status]}
                  {item.error && <small title={item.error}>{item.error}</small>}
                </span>
              </div>
              {(item.status === 'error' || item.status === 'unknown') && (
                <button
                  type="button"
                  className="attachment-action"
                  aria-label={'重试附件 ' + item.name}
                  title="先核对原上传，再重试"
                  onClick={() => composer.retryAttachment(item.id)}
                >
                  <RefreshCw size={14} />
                </button>
              )}
              <button
                type="button"
                className="attachment-action"
                aria-label={'移除附件 ' + item.name}
                title="仅移除本条消息引用"
                onClick={() => composer.removeAttachment(item.id)}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      {composer.dragging && (
        <div className="conversation-drop-overlay" aria-live="polite">
          <CloudUpload size={32} />
          <strong>松开以添加到当前消息</strong>
          <span>图片、文档或参考录屏 · Esc 取消</span>
        </div>
      )}
    </>
  );
}
export function ComposerShortcutHint() {
  const labels = desktopShortcutLabels();
  return (
    <span
      className="composer-shortcut-hint"
      title={`${labels.focus} 聚焦输入 · ${labels.newSession} 新会话 · Shift+Enter 换行`}
    >
      可拖入文件或粘贴截图 <kbd>{labels.focus}</kbd>
    </span>
  );
}
