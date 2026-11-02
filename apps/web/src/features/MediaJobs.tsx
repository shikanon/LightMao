import { useEffect, useState } from 'react';
import { Image, Film, Download, RefreshCw } from 'lucide-react';
import { api, post, assetMediaUrl, downloadAsset } from '../api';
import { useWorkspace } from '../context';
import type { Asset, GenerationJob } from '../../../../packages/shared/types';
const labels = {
  created: '已保存任务',
  submitting: '正在提交',
  queued: '排队中',
  running: '正在生成',
  ingesting: '正在保存产物',
  completed: '已完成',
  failed: '生成失败',
  unknown: '结果待核对',
};
function MediaPreview({ asset }: { asset: Asset }) {
  const [url, setUrl] = useState(''),
    [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    let current = '';
    void assetMediaUrl(asset.id, abort.signal)
      .then((value) => {
        current = value;
        if (abort.signal.aborted) URL.revokeObjectURL(value);
        else setUrl(value);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => {
      abort.abort();
      if (current) URL.revokeObjectURL(current);
    };
  }, [asset.id]);
  if (error) return <p role="alert">{error}</p>;
  if (!url) return <p className="form-hint">正在载入产物…</p>;
  return asset.mime.startsWith('image/') ? (
    <img className="generated-preview" src={url} alt={asset.name} />
  ) : (
    <video className="generated-preview" controls src={url} preload="metadata" />
  );
}
export function MediaJobs({ sessionId, active }: { sessionId: string; active: boolean }) {
  const w = useWorkspace(),
    [jobs, setJobs] = useState<GenerationJob[]>([]),
    [error, setError] = useState(''),
    [selected, setSelected] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const next = await api<GenerationJob[]>(
          '/api/generations?sessionId=' + encodeURIComponent(sessionId),
          { signal: abort.signal },
        );
        if (abort.signal.aborted) return;
        setJobs(next);
        setError('');
        if (active || next.some((j) => !['completed', 'failed', 'unknown'].includes(j.status)))
          timer = setTimeout(() => void refresh(), 2200);
      } catch (e) {
        if (!abort.signal.aborted) setError(e instanceof Error ? e.message : '任务暂不可用');
      }
    }
    if (w.cloud.features?.generations) void refresh();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [sessionId, active, w.cloud.features?.generations]);
  return (
    <div className="media-job-list" aria-label="生成素材任务">
      <h2>生成素材</h2>
      <p className="form-hint">
        在对话中描述角色图片、大招表现或过场。生成完成后可预览、下载或由 Agent 导入当前项目。
      </p>
      {!w.cloud.features?.generations && (
        <p role="status">当前后端尚不支持素材生成，请升级后端后使用。</p>
      )}
      {error && <p role="alert">{error}</p>}
      {!jobs.length && !error && (
        <div className="media-job-empty">
          <Image size={30} />
          <p>尚无生成任务</p>
          <span>角色图片与视频会保留各自的生成记录。</span>
        </div>
      )}
      {jobs.map((job) => (
        <article className="media-job-card" key={job.id}>
          <header>
            {job.kind === 'image' ? <Image size={18} /> : <Film size={18} />}
            <strong>{job.name}</strong>
            <span>{labels[job.status]}</span>
          </header>
          <p className="form-hint">
            {job.kind === 'image' ? '角色 / 场景图片' : 'Seedance 2.5 视频'} ·{' '}
            {new Date(job.createdAt).toLocaleTimeString('zh-CN')}
          </p>
          {job.error && (
            <p role="alert" className="workflow-error">
              {job.error}
            </p>
          )}
          {job.asset && (
            <>
              <div className="media-job-actions">
                <button
                  className="text-button"
                  onClick={() => setSelected(selected === job.id ? '' : job.id)}
                >
                  {selected === job.id ? '收起预览' : '预览产物'}
                </button>
                <button
                  className="text-button"
                  onClick={() =>
                    void w.perform(
                      () => downloadAsset(job.asset!.id, job.asset!.name),
                      '已开始下载',
                    )
                  }
                >
                  <Download size={14} />
                  下载
                </button>
              </div>
              {selected === job.id && <MediaPreview key={job.asset.id} asset={job.asset} />}
            </>
          )}
          {job.status === 'unknown' && (
            <button
              className="text-button"
              onClick={() =>
                void w.perform(async () => {
                  const next = await post<GenerationJob>(`/api/generations/${job.id}/reconcile`);
                  setJobs((old) => old.map((v) => (v.id === next.id ? next : v)));
                }, '已核对同一任务，未重新生成')
              }
            >
              <RefreshCw size={14} />
              核对已有产物
            </button>
          )}
          <details>
            <summary>任务记录</summary>
            <code>{job.id}</code>
            <p>{job.model}</p>
          </details>
        </article>
      ))}
    </div>
  );
}
