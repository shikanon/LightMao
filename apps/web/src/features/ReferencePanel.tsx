import { useCallback, useEffect, useRef, useState } from 'react';
import { api, post } from '../api';
import { MediaPlayer, useMediaUrl } from './ArtifactViewer';
import type { ReferenceMedia, PerceptionJob } from '../../../../packages/shared/perception';
import type { PlaytestJob } from '../../../../packages/shared/types';
const status: Record<string, string> = {
  preparing: '本机解码中',
  ready: '可用',
  failed: '失败',
  interrupted: '已中断',
  unknown: '结果未知',
  queued: '排队中',
  running: '模型理解中',
  completed: '已完成',
};
function Thumbnail({
  reference,
  frame,
  onSeek,
}: {
  reference: string;
  frame: ReferenceMedia['frames'][number];
  onSeek: (t: number) => void;
}) {
  const { url } = useMediaUrl(`/local/references/${reference}/frames/${frame.id}`);
  return (
    <button
      className="reference-frame"
      onClick={() => onSeek(frame.seconds)}
      title={'定位到 ' + frame.seconds.toFixed(1) + ' 秒'}
    >
      {url && <img src={url} alt={'参考画面 ' + frame.seconds.toFixed(1) + ' 秒'} />}
      <span>{frame.seconds.toFixed(1)}s</span>
    </button>
  );
}
function ReferencePreview({ reference }: { reference: ReferenceMedia }) {
  const { url, error } = useMediaUrl(`/local/references/${reference.id}/preview`),
    host = useRef<HTMLDivElement>(null);
  return (
    <div ref={host}>
      {error ? (
        <p className="inline-error">{error}</p>
      ) : url ? (
        <MediaPlayer url={url} kind={reference.width ? 'video' : 'audio'} name={reference.name} />
      ) : (
        <p className="form-hint">正在读取本机媒体…</p>
      )}
      <div className="reference-frames">
        {reference.frames.map((frame) => (
          <Thumbnail
            key={frame.id}
            reference={reference.id}
            frame={frame}
            onSeek={(t) => {
              const video = host.current?.querySelector('video');
              if (video) video.currentTime = t;
            }}
          />
        ))}
      </div>
    </div>
  );
}
function PerceptionResult({
  job,
  onRevalidate,
  disabled,
}: {
  job: PerceptionJob;
  onRevalidate: () => void;
  disabled: boolean;
}) {
  return (
    <article className="perception-result">
      <div className="media-toolbar">
        <strong>
          {job.purpose === 'score'
            ? '作品视觉评分'
            : job.purpose === 'audio'
              ? '实际音频理解'
              : '录屏视觉理解'}
        </strong>
        <span>{status[job.status] || job.status}</span>
      </div>
      <p className="form-hint">
        {job.model} · {job.inputManifest.length} 份证据
      </p>
      {job.error && (
        <p className="inline-error" role="alert">
          {job.error}
        </p>
      )}
      {job.status === 'failed' && (
        <button className="text-button" disabled={disabled} onClick={onRevalidate}>
          重新校验原始结果（不调用模型）
        </button>
      )}
      {job.result && (
        <>
          <p>{job.result.summary}</p>
          {job.visualScore !== undefined && (
            <div className="visual-score">
              <strong>{job.visualScore}</strong>
              <span>/100 · 视觉评分</span>
              <small>不替代玩法、音频与用户品质验收</small>
            </div>
          )}
          {job.result.scores?.map((score) => (
            <div key={score.criterion} className="score-row">
              <b>
                {
                  {
                    reference: '参考还原',
                    hierarchy: '视觉层级',
                    feedback: '战斗反馈',
                    coherence: '阶段一致性',
                  }[score.criterion]
                }{' '}
                {score.score}
              </b>
              <p>{score.reason}</p>
              <small>证据：{score.evidenceIds.join('、')}</small>
            </div>
          ))}
          {job.result.transcript && <blockquote>{job.result.transcript}</blockquote>}
          <details>
            <summary>查看观察依据</summary>
            {job.result.observations.map((o, i) => (
              <p key={i}>
                <small>
                  {o.evidenceId}
                  {o.startSeconds === undefined ? '' : ` · ${o.startSeconds}s`}
                </small>
                <br />
                {o.text}
              </p>
            ))}
          </details>
          {job.result.unknowns.length > 0 && (
            <div className="form-hint">
              <b>尚未覆盖</b>
              {job.result.unknowns.map((v, i) => (
                <p key={i}>{v}</p>
              ))}
            </div>
          )}
        </>
      )}
    </article>
  );
}
export function ReferencePanel({
  projectId,
  sessionId,
  onAttach,
}: {
  projectId: string;
  sessionId: string;
  onAttach?: (id: string) => Promise<void> | void;
}) {
  const [references, setReferences] = useState<ReferenceMedia[]>([]),
    [selected, setSelected] = useState(''),
    [jobs, setJobs] = useState<Record<string, PerceptionJob>>({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null),
    selectedRef = references.find((r) => r.id === selected);
  const reload = useCallback(async () => {
    const values = await api<ReferenceMedia[]>(`/local/projects/${projectId}/references`);
    setReferences(values);
    setSelected((old) => (values.some((v) => v.id === old) ? old : values[0]?.id || ''));
  }, [projectId]);
  useEffect(() => {
    let active = true;
    void reload().catch((e) => {
      if (active) setError(e.message);
    });
    return () => {
      active = false;
    };
  }, [reload]);
  const preparing = references.some((r) => r.status === 'preparing');
  useEffect(() => {
    if (!preparing) return;
    const timer = setInterval(() => void reload().catch(() => {}), 2500);
    return () => clearInterval(timer);
  }, [preparing, reload]);
  useEffect(() => {
    if (!selectedRef) return;
    const c = new AbortController();
    for (const analysis of selectedRef.analyses || [])
      void api<PerceptionJob>(`/local/projects/${projectId}/perception/${analysis.jobId}`, {
        signal: c.signal,
      })
        .then((job) => {
          if (!c.signal.aborted) setJobs((old) => ({ ...old, [job.id]: job }));
        })
        .catch(() => {});
    return () => c.abort();
  }, [selectedRef?.id, projectId, selectedRef?.analyses?.length]);
  const pending = Object.values(jobs)
    .filter((j) => ['running', 'queued'].includes(j.status))
    .map((j) => j.id)
    .sort()
    .join(',');
  useEffect(() => {
    if (!pending) return;
    const c = new AbortController(),
      timer = setInterval(() => {
        for (const id of pending.split(','))
          void api<PerceptionJob>(`/local/projects/${projectId}/perception/${id}`, {
            signal: c.signal,
          })
            .then((job) => {
              if (!c.signal.aborted) setJobs((old) => ({ ...old, [id]: job }));
            })
            .catch(() => {});
      }, 2000);
    return () => {
      c.abort();
      clearInterval(timer);
    };
  }, [pending, projectId]);
  const act = async (fn: () => Promise<void>) => {
    setError('');
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="reference-panel">
      <div className="media-toolbar">
        <h3>参考资料</h3>
        <button className="button secondary" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? '正在处理…' : '添加录屏 / 音频'}
        </button>
        <input
          ref={input}
          type="file"
          hidden
          accept="video/*,audio/*,.qt,.mov"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file)
              void act(async () => {
                if (file.size > 256 * 1024 * 1024) throw Error('参考文件最大256MiB');
                const body = new FormData();
                body.append('file', file);
                const ref = await api<ReferenceMedia>(`/local/projects/${projectId}/references`, {
                  method: 'POST',
                  body,
                });
                await reload();
                setSelected(ref.id);
              });
          }}
        />
      </div>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      {references.length ? (
        <label className="reference-select">
          当前参考
          <select
            aria-label="当前参考"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            {references.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} · {status[r.status]}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="empty-note">添加游戏录屏后，可以直接让 Agent 理解、复刻并对比作品。</p>
      )}
      {selectedRef && (
        <>
          <details className="reference-metadata">
            <summary>录屏详情 · {selectedRef.durationSeconds?.toFixed(0) || '--'} 秒</summary>
            <p className="form-hint">
              {(selectedRef.bytes / 1024 / 1024).toFixed(1)} MiB ·{' '}
              {selectedRef.durationSeconds?.toFixed(1) || '--'} 秒{' '}
              {selectedRef.width && `· ${selectedRef.width} × ${selectedRef.height}`} · SHA{' '}
              {selectedRef.sha256.slice(0, 12)}
            </p>
            <p className="form-hint">
              原文件保存在本机。理解时仅向已配置的后端发送采样画面或音频。
            </p>
          </details>
          {selectedRef.error && <p className="inline-error">{selectedRef.error}</p>}
          {selectedRef.status === 'ready' && (
            <>
              <ReferencePreview key={selectedRef.id} reference={selectedRef} />
              <div className="reference-actions">
                {onAttach && (
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await onAttach(selectedRef.id);
                      })
                    }
                  >
                    引用到消息
                  </button>
                )}
                {(['vision', 'audio'] as const).map((purpose) => (
                  <button
                    className="button secondary"
                    key={purpose}
                    disabled={
                      busy ||
                      (purpose === 'audio' ? !selectedRef.hasAudio : !selectedRef.frames.length)
                    }
                    onClick={() =>
                      void act(async () => {
                        const job = await post<PerceptionJob>(
                          `/local/references/${selectedRef.id}/analyze`,
                          { purpose, sessionId },
                        );
                        setJobs((old) => ({ ...old, [job.id]: job }));
                        await reload();
                      })
                    }
                  >
                    {purpose === 'vision' ? '理解实际画面' : '听取实际音轨'}
                  </button>
                ))}
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      const playtests = await api<PlaytestJob[]>(
                          `/local/projects/${projectId}/playtests`,
                        ),
                        latest = playtests
                          .filter(
                            (p) =>
                              p.status !== 'running' &&
                              p.sessionId === sessionId &&
                              p.screenshotSha256,
                          )
                          .at(-1);
                      if (!latest) throw Error('请先在本会话实际试玩作品，取得截图后再评分');
                      const job = await post<PerceptionJob>(
                        `/local/projects/${projectId}/visual-assessments`,
                        { sessionId, referenceId: selectedRef.id, playtestId: latest.id },
                      );
                      setJobs((old) => ({ ...old, [job.id]: job }));
                    })
                  }
                >
                  对比最近试玩并评分
                </button>
              </div>
            </>
          )}
        </>
      )}
      {Object.values(jobs)
        .filter(
          (j) => j.purpose === 'score' || selectedRef?.analyses?.some((a) => a.jobId === j.id),
        )
        .map((job) => (
          <PerceptionResult
            key={job.id}
            job={job}
            disabled={busy}
            onRevalidate={() =>
              void act(async () => {
                const checked = await post<PerceptionJob>(
                  `/local/projects/${projectId}/perception/${job.id}/revalidate`,
                );
                setJobs((old) => ({ ...old, [job.id]: checked }));
              })
            }
          />
        ))}
    </div>
  );
}
