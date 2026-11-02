import { useEffect, useState, useCallback, useRef } from 'react';
import { Download, FileText, Loader2 } from 'lucide-react';
import { api, skillResourceUrl, downloadSkillResource } from '../api';
import { Modal } from '../components/UI';
import { useWorkspace } from '../context';
import type { SkillResource, SkillSummary } from '../../../../packages/shared/types';
export const skillSize = (value: number) =>
  value < 1024
    ? `${value} B`
    : value < 1048576
      ? `${(value / 1024).toFixed(1)} KB`
      : `${(value / 1048576).toFixed(1)} MB`;
export function SkillResources({ skill, onClose }: { skill: SkillSummary; onClose: () => void }) {
  const w = useWorkspace();
  const [files, setFiles] = useState<SkillResource[]>([]),
    [path, setPath] = useState('SKILL.md');
  const [page, setPage] = useState<{
    text: string;
    totalChars: number;
    nextOffset: number | null;
  }>();
  const [image, setImage] = useState(''),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [more, setMore] = useState(false);
  const generation = useRef(0);
  const close = useCallback(onClose, [onClose]);
  useEffect(() => {
    const abort = new AbortController();
    void api<SkillResource[]>(`/local/skills/${encodeURIComponent(skill.id)}/files`, {
      signal: abort.signal,
    })
      .then(setFiles)
      .catch((e) => {
        if (!abort.signal.aborted) {
          setError(e.message);
          setLoading(false);
        }
      });
    return () => abort.abort();
  }, [skill.id]);
  const file = files.find((file) => file.path === path);
  useEffect(() => {
    if (!file) return;
    generation.current++;
    let active = true,
      url = '';
    const abort = new AbortController();
    setLoading(true);
    setError('');
    setPage(undefined);
    setImage('');
    setMore(false);
    const load = async () => {
      if (file.mime.startsWith('image/')) {
        url = await skillResourceUrl(skill.id, path, skill.sha256);
        if (active) setImage(url);
        else URL.revokeObjectURL(url);
      } else if (file.mime.startsWith('text/')) {
        const value = await api<{ text: string; totalChars: number; nextOffset: number | null }>(
          `/local/skills/${encodeURIComponent(skill.id)}/resource?path=${encodeURIComponent(path)}&version=${skill.sha256}`,
          { signal: abort.signal },
        );
        if (active) setPage(value);
      }
    };
    void load()
      .catch((e) => {
        if (active) {
          setError(e.message);
          setLoading(false);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      generation.current++;
      abort.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [skill.id, skill.sha256, path, file]);
  return (
    <Modal
      title={`${skill.name} · 资源`}
      description="本机副本，资源在需要时读取。脚本按文本预览，执行由独立工具权限控制。"
      onClose={close}
      wide
    >
      <div className="skill-resource-toolbar">
        <label>
          资源文件
          <select aria-label="资源文件" value={path} onChange={(e) => setPath(e.target.value)}>
            {files.map((file) => (
              <option key={file.path} value={file.path}>
                {file.path}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button secondary"
          disabled={!file}
          onClick={() =>
            void w.perform(() => downloadSkillResource(skill.id, path, skill.sha256), '已开始下载')
          }
        >
          <Download size={15} />
          下载文件
        </button>
      </div>
      {file && (
        <p className="form-hint">
          {skillSize(file.bytes)} · 版本 {file.sha256.slice(0, 12)}
          {page ? ` · 共 ${page.totalChars.toLocaleString()} 字符` : ''}
        </p>
      )}
      <div className="skill-resource-preview" aria-busy={loading}>
        {loading ? (
          <p>
            <Loader2 className="spin" size={18} />
            正在读取资源…
          </p>
        ) : error ? (
          <p role="alert">{error}</p>
        ) : image ? (
          <img src={image} alt={path} onError={() => setError('图片无法解码，可下载原文件查看')} />
        ) : page ? (
          <pre>{page.text}</pre>
        ) : (
          <p>
            <FileText size={22} />
            此格式可下载后使用。
          </p>
        )}
      </div>
      {page?.nextOffset !== null && page?.nextOffset !== undefined && (
        <button
          className="button secondary"
          disabled={more}
          onClick={() => {
            const expected = generation.current;
            setMore(true);
            void w
              .perform(async () => {
                const next = await api<{
                  text: string;
                  totalChars: number;
                  nextOffset: number | null;
                }>(
                  `/local/skills/${encodeURIComponent(skill.id)}/resource?path=${encodeURIComponent(path)}&offset=${page.nextOffset}&version=${skill.sha256}`,
                );
                if (expected !== generation.current) return;
                setPage((current) =>
                  current ? { ...next, text: current.text + next.text } : next,
                );
              })
              .finally(() => {
                if (expected === generation.current) setMore(false);
              });
          }}
        >
          {more ? '读取中…' : '继续读取'}
        </button>
      )}
      <footer>
        <button className="button secondary" onClick={close}>
          关闭
        </button>
      </footer>
    </Modal>
  );
}
