import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { TraceReview as Review } from '../../../../packages/shared/trace-review';
import './trace-review.css';

const status = {
  clear: '记录内一致',
  guarded: '问题已拦截',
  attention: '需要处理',
  insufficient: '证据不足',
};

export function TraceReview({
  trace,
  sequence,
  onLocate,
}: {
  trace: string;
  sequence?: number;
  onLocate: (trace: string, event: string, sequence: number) => void;
}) {
  const [result, setResult] = useState<{ trace: string; value: Review }>(),
    [failure, setFailure] = useState<{ trace: string; message: string }>(),
    [pending, setPending] = useState('');
  const generation = useRef(0),
    controller = useRef<AbortController | undefined>(undefined),
    currentTrace = useRef(trace);
  currentTrace.current = trace;
  useEffect(() => {
    generation.current++;
    controller.current?.abort();
    setResult(undefined);
    setFailure(undefined);
    setPending('');
    return () => {
      generation.current++;
      controller.current?.abort();
    };
  }, [trace]);
  const review = result?.trace === trace ? result.value : undefined,
    error = failure?.trace === trace ? failure.message : '',
    busy = pending === trace;
  const snapshot = review?.traces.find((head) => head.id === trace);
  const outdated = snapshot && sequence !== undefined && sequence > snapshot.sequence;
  async function load() {
    const request = ++generation.current,
      source = trace,
      abort = new AbortController();
    controller.current?.abort();
    controller.current = abort;
    const valid = () =>
      !abort.signal.aborted && generation.current === request && currentTrace.current === source;
    setPending(source);
    setFailure(undefined);
    try {
      const value = await api<Review>(`/local/traces/${source}/review`, {
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30000)]),
      });
      if (valid()) setResult({ trace: source, value });
    } catch (e) {
      if (valid())
        setFailure({ trace: source, message: e instanceof Error ? e.message : '审阅未完成' });
    } finally {
      if (valid()) setPending('');
    }
  }
  return (
    <section className="trace-review" aria-label="长程运行审阅" aria-busy={busy}>
      <button className="button secondary" disabled={busy} onClick={() => void load()}>
        {busy ? '正在核对记录…' : review ? '重新审阅' : '审阅长程运行'}
      </button>
      {error && <p role="alert">{error}</p>}
      {review && (
        <>
          <p className="form-hint">{review.summary}</p>
          <p className="trace-review-snapshot">
            审阅于 {new Date(review.createdAt).toLocaleTimeString()}，基于当时的记录。
            {outdated && <span role="status">记录已有更新，请重新审阅。</span>}
          </p>
          {(!review.integrity || review.truncated) && (
            <p className="inline-error" role="status">
              {!review.integrity ? '部分记录未通过完整性校验。' : '记录超出本次审阅范围。'}
              请结合审阅范围核对缺失依据。
            </p>
          )}
          <div className="trace-review-checks">
            {review.checks.map((check) => (
              <details
                key={check.category}
                className={'trace-review-check ' + check.status}
                data-category={check.category}
              >
                <summary>
                  <strong>{check.label}</strong>
                  <span>{status[check.status]}</span>
                </summary>
                <p className="form-hint">
                  已核对 {check.observations} 项记录；{check.findings.length} 项发现。
                </p>
                {check.findings.map((finding) => (
                  <div key={finding.id} className="trace-review-finding">
                    <p>{finding.message}</p>
                    <small>
                      {finding.contained ? '已拦截或已重新核验' : '仍需核对'} · {finding.code}
                    </small>
                    <div className="trace-review-sources">
                      {finding.sources.map((source) => (
                        <button
                          className="text-button"
                          key={source.traceId + ':' + source.eventId}
                          onClick={() => onLocate(source.traceId, source.eventId, source.sequence)}
                        >
                          定位事件 #{source.sequence}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </details>
            ))}
          </div>
          <details className="trace-review-limits">
            <summary>审阅范围</summary>
            {review.limits.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </details>
        </>
      )}
    </section>
  );
}
