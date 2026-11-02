import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useMediaUrl } from './ArtifactViewer';
import type { TraceHead, TraceEvent, TracePage } from '../../../../packages/shared/trace';
import { TraceReview } from './TraceReview';
import { useWorkspace } from '../context';

type TraceTarget = { event: string; sequence: number };
type TracePayload = { text: string; nextOffset: number | null; sha256: string };
const message = (error: unknown) => (error instanceof Error ? error.message : '轨迹读取失败');

function TraceImage({ trace, blob }: { trace: string; blob: string }) {
  const { url, error } = useMediaUrl(`/local/traces/${trace}/media/${blob}`);
  return error ? (
    <p>{error}</p>
  ) : url ? (
    <img className="trace-observation" src={url} alt="轨迹中保存的实际观测" />
  ) : null;
}

function Payload({ trace, event }: { trace: string; event: TraceEvent }) {
  const [value, setValue] = useState<TracePayload>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const generation = useRef(0),
    controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const request = ++generation.current,
      abort = new AbortController();
    controller.current = abort;
    setValue(undefined);
    setError('');
    setBusy(true);
    if (event.payloadRef)
      void api<TracePayload>(`/local/traces/${trace}/payloads/${event.payloadRef}`, {
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]),
      })
        .then((result) => {
          if (!abort.signal.aborted && request === generation.current) setValue(result);
        })
        .catch((e) => {
          if (!abort.signal.aborted && request === generation.current) setError(message(e));
        })
        .finally(() => {
          if (!abort.signal.aborted && request === generation.current) setBusy(false);
        });
    return () => {
      generation.current++;
      abort.abort();
    };
  }, [trace, event.payloadRef]);
  async function readMore() {
    if (!value || value.nextOffset === null || busy) return;
    const request = generation.current,
      offset = value.nextOffset,
      abort = controller.current;
    if (!abort || abort.signal.aborted) return;
    setBusy(true);
    setError('');
    try {
      const next = await api<TracePayload>(
        `/local/traces/${trace}/payloads/${event.payloadRef}?offset=${offset}`,
        { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]) },
      );
      if (!abort.signal.aborted && request === generation.current)
        setValue((previous) =>
          previous?.nextOffset === offset ? { ...next, text: previous.text + next.text } : previous,
        );
    } catch (e) {
      if (!abort.signal.aborted && request === generation.current) setError(message(e));
    } finally {
      if (!abort.signal.aborted && request === generation.current) setBusy(false);
    }
  }
  const media = [
    ...new Set(
      [...(value?.text || '').matchAll(/"\$media":\s*"([a-f0-9]{64})"/g)].map((match) => match[1]),
    ),
  ];
  return (
    <div className="trace-payload" aria-busy={busy}>
      {error && <p role="alert">{error}</p>}
      {busy && !value && <p className="form-hint">正在读取原始记录…</p>}
      {media.map((blob) => (
        <TraceImage key={blob} trace={trace} blob={blob} />
      ))}
      {value && (
        <>
          <small>载荷 SHA {value.sha256.slice(0, 16)}</small>
          <pre>{value.text}</pre>
          {value.nextOffset !== null && (
            <button className="button secondary" disabled={busy} onClick={() => void readMore()}>
              {busy ? '正在读取…' : '继续读取详情'}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function mergePage(
  previous: TracePage | undefined,
  next: TracePage,
  startAfter: number,
): TracePage {
  const events = [
    ...new Map(
      [...(previous?.events || []), ...next.events].map((event) => [event.id, event]),
    ).values(),
  ].sort((a, b) => a.sequence - b.sequence);
  const nextAfter = events.at(-1)?.sequence || startAfter;
  const head = previous && previous.head.sequence > next.head.sequence ? previous.head : next.head;
  return {
    head,
    events,
    nextAfter,
    hasMore: nextAfter < head.sequence,
    integrity: next.integrity && (previous?.integrity ?? true),
  };
}

function TraceRun({
  trace,
  active,
  target,
  reviewSupported,
  onLocate,
}: {
  trace: string;
  active: boolean;
  target?: TraceTarget;
  reviewSupported: boolean;
  onLocate: (trace: string, event?: string, sequence?: number) => void;
}) {
  const queryKey = trace + ':' + (target?.event || ''),
    startAfter = target ? Math.max(0, target.sequence - 15) : 0;
  const [state, setState] = useState<{ key: string; page: TracePage }>(),
    [detail, setDetail] = useState(target?.event || ''),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [filter, setFilter] = useState('all');
  const generation = useRef(0),
    current = useRef<{ key: string; page?: TracePage }>({ key: queryKey }),
    readNext = useRef<(() => Promise<void>) | undefined>(undefined);
  const timeline = useRef<HTMLDivElement>(null);
  const page = state?.key === queryKey ? state.page : undefined;
  const located = !!target && !!page?.events.some((event) => event.id === target.event);
  useEffect(() => setDetail(target?.event || ''), [queryKey, target]);
  useEffect(() => {
    const request = ++generation.current,
      abort = new AbortController();
    let inFlight = false;
    if (current.current.key !== queryKey) {
      current.current = { key: queryKey };
      setState(undefined);
    }
    setError('');
    const valid = () =>
      !abort.signal.aborted && request === generation.current && current.current.key === queryKey;
    async function load(more = false) {
      if (inFlight || !valid()) return;
      inFlight = true;
      setLoading(true);
      const previous = current.current.page,
        after =
          more || (previous && !previous.hasMore)
            ? (previous?.nextAfter ?? startAfter)
            : startAfter;
      try {
        const next = await api<TracePage>(`/local/traces/${trace}?after=${after}`, {
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]),
        });
        if (valid() && next.head.id === trace) {
          const merged = mergePage(current.current.page, next, startAfter);
          current.current = { key: queryKey, page: merged };
          setState({ key: queryKey, page: merged });
          setError('');
        }
      } catch (e) {
        if (valid()) setError(message(e));
      } finally {
        inFlight = false;
        if (valid()) setLoading(false);
      }
    }
    const more = () => load(true);
    readNext.current = more;
    void load();
    const timer = active ? setInterval(() => void load(), 4000) : undefined;
    return () => {
      generation.current++;
      abort.abort();
      clearInterval(timer);
      if (readNext.current === more) readNext.current = undefined;
    };
  }, [trace, active, queryKey, startAfter, target?.event]);
  useEffect(() => {
    if (!target || !page?.events.some((event) => event.id === target.event)) return;
    const event = document.getElementById('trace-event-' + target.event);
    if (event && timeline.current?.contains(event)) {
      event.scrollIntoView({ block: 'nearest' });
      event.querySelector<HTMLButtonElement>('.trace-event-toggle')?.focus({ preventScroll: true });
    }
  }, [target, located]);
  return (
    <>
      {reviewSupported && (
        <TraceReview trace={trace} sequence={page?.head.sequence} onLocate={onLocate} />
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="media-toolbar">
        <span>
          {page
            ? page.integrity
              ? '事件链校验通过'
              : '事件链校验未通过'
            : loading
              ? '正在读取轨迹…'
              : '轨迹尚未载入'}
          {page && ` · ${page.head.sequence} 条`}
        </span>
        <select
          aria-label="轨迹类型"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        >
          <option value="all">全部事件</option>
          <option value="model">模型请求</option>
          <option value="tool">工具调用</option>
          <option value="observation">实际观测</option>
          <option value="context">上下文整理</option>
          <option value="goal">目标检查</option>
          <option value="environment">环境检查</option>
          <option value="collaboration">协作检查</option>
        </select>
      </div>
      {page?.head.parentTraceId && (
        <button className="text-button" onClick={() => onLocate(page.head.parentTraceId!)}>
          返回父运行
        </button>
      )}
      {target && (
        <p className="trace-location" role="status">
          {located ? '已定位事件' : error ? '未能定位事件' : '正在定位事件'} #{target.sequence}
          <button className="text-button" onClick={() => onLocate(trace)}>
            查看完整轨迹
          </button>
        </p>
      )}
      <div className="trace-timeline" ref={timeline} aria-busy={loading}>
        {page?.events
          .filter(
            (event) =>
              filter === 'all' || event.kind.startsWith(filter) || target?.event === event.id,
          )
          .map((event) => (
            <div
              key={event.id}
              id={'trace-event-' + event.id}
              className={'trace-event' + (target?.event === event.id ? ' located' : '')}
            >
              <button
                className="trace-event-toggle"
                aria-expanded={detail === event.id}
                onClick={() => setDetail((old) => (old === event.id ? '' : event.id))}
              >
                <small>
                  #{event.sequence} · {event.kind}
                </small>
                <strong>{event.name}</strong>
                <span>
                  {event.status}
                  {event.durationMs === undefined
                    ? ''
                    : ` · ${(event.durationMs / 1000).toFixed(2)}s`}
                </span>
              </button>
              {detail === event.id && (
                <>
                  <p className="form-hint">
                    节点 {event.spanId.slice(0, 12)}
                    {event.parentSpanId && ` ← ${event.parentSpanId.slice(0, 12)}`}
                  </p>
                  {event.summary && <p>{event.summary}</p>}
                  {event.payloadRef && (
                    <Payload key={trace + ':' + event.id} trace={trace} event={event} />
                  )}
                </>
              )}
            </div>
          ))}
      </div>
      {page?.hasMore && (
        <button
          className="button secondary"
          disabled={loading}
          onClick={() => void readNext.current?.()}
        >
          {loading ? '正在读取事件…' : '加载更多事件'}
        </button>
      )}
    </>
  );
}

function TraceSession({ sessionId, active }: { sessionId: string; active: boolean }) {
  const workspace = useWorkspace();
  const [heads, setHeads] = useState<Omit<TraceHead, 'ownerId'>[]>([]),
    [selection, setSelection] = useState<{ id: string; target?: TraceTarget }>({ id: '' }),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true);
  const generation = useRef(0);
  useEffect(() => {
    const request = ++generation.current,
      abort = new AbortController();
    let inFlight = false;
    const valid = () => !abort.signal.aborted && generation.current === request;
    async function load() {
      if (inFlight || !valid()) return;
      inFlight = true;
      try {
        const result = await api<Omit<TraceHead, 'ownerId'>[]>(
          `/local/sessions/${sessionId}/traces`,
          {
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]),
          },
        );
        if (valid()) {
          setHeads(result);
          // Review evidence may belong to an older or related run outside this list's window.
          setSelection((previous) => (previous.id ? previous : { id: result[0]?.id || '' }));
          setError('');
        }
      } catch (e) {
        if (valid()) setError(message(e));
      } finally {
        inFlight = false;
        if (valid()) setLoading(false);
      }
    }
    void load();
    const timer = active ? setInterval(() => void load(), 4000) : undefined;
    return () => {
      generation.current++;
      abort.abort();
      clearInterval(timer);
    };
  }, [sessionId, active]);
  const locate = (trace: string, event?: string, sequence?: number) =>
    setSelection({ id: trace, target: event && sequence ? { event, sequence } : undefined });
  return (
    <div className="trace-panel">
      <h3>运行轨迹</h3>
      <p className="form-hint">请求、工具、子任务和实际观测按因果关系记录。原始详情按需展开。</p>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {heads.length || selection.id ? (
        <>
          <select
            aria-label="选择运行轨迹"
            value={selection.id}
            onChange={(event) => locate(event.target.value)}
          >
            {selection.id && !heads.some((head) => head.id === selection.id) && (
              <option value={selection.id}>审阅中的关联运行</option>
            )}
            {heads.map((head) => (
              <option value={head.id} key={head.id}>
                {new Date(head.createdAt).toLocaleTimeString()} · {head.kind} · {head.status}
              </option>
            ))}
          </select>
          {selection.id && (
            <TraceRun
              key={selection.id}
              trace={selection.id}
              active={active}
              target={selection.target}
              reviewSupported={workspace.local.runtime.traceReview === true}
              onLocate={locate}
            />
          )}
        </>
      ) : (
        <p className="empty-note">
          {loading
            ? '正在读取运行轨迹…'
            : '发送一次对话后，这里会显示可追溯的运行记录。旧运行不补造模型输入。'}
        </p>
      )}
    </div>
  );
}

export function TracePanel(props: { sessionId: string; active: boolean }) {
  const workspace = useWorkspace();
  return (
    <TraceSession
      key={[workspace.local.runtime.deviceId, workspace.cloud.user.id, props.sessionId].join(':')}
      {...props}
    />
  );
}
