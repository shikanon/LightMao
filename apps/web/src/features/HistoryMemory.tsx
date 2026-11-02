import { useEffect, useState } from 'react';
import { api } from '../api';
import { useWorkspace } from '../context';
import { Modal, Spinner } from '../components/UI';
import type { ConversationMemoryView, SessionHistoryPage } from '../../../../packages/shared/types';

const names = {
  goal: '目标',
  constraint: '约束',
  decision: '决策',
  reported: '已报告结果',
  pending: '待处理',
};
export function HistoryMemory({ reference }: { reference: string }) {
  const { session } = useWorkspace();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="text-button" onClick={() => setOpen(true)}>
        查看历史整理
      </button>
      {open && session && (
        <MemoryDialog
          key={session.id + reference}
          sessionId={session.id}
          reference={reference}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
function MemoryDialog({
  sessionId,
  reference,
  onClose,
}: {
  sessionId: string;
  reference: string;
  onClose: () => void;
}) {
  const [value, setValue] = useState<ConversationMemoryView>(),
    [error, setError] = useState(''),
    [source, setSource] = useState(''),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setError('');
    void api<ConversationMemoryView>(`/local/sessions/${sessionId}/context/${reference}`, {
      signal: abort.signal,
    })
      .then((v) => {
        if (!abort.signal.aborted) setValue(v);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [sessionId, reference, retry]);
  return (
    <Modal
      title="历史整理"
      description="摘要仅供继续工作时参考；原始对话仍保留，可按来源核查。"
      onClose={onClose}
      wide
    >
      {error ? (
        <p className="form-error" role="alert">
          {error}
          <button className="text-button" onClick={() => setRetry((v) => v + 1)}>
            重试
          </button>
        </p>
      ) : !value ? (
        <Spinner />
      ) : (
        <div className="history-memory">
          <p className="form-hint">
            已整理 {value.sourceMessages} 条历史消息 ·{' '}
            {value.mode === 'demo' ? '演示规则摘录' : '模型摘要'} · 原始工具记录独立保存。
          </p>
          {value.items.map((item, index) => (
            <article key={index}>
              <strong>{names[item.kind]}</strong>
              <p>{item.text}</p>
              <div className="memory-source-buttons">
                {item.sourceIds.map((id) => {
                  const original = value.sources.find((v) => v.id === id);
                  return (
                    <button
                      type="button"
                      className="text-button"
                      key={id}
                      onClick={() => setSource(id)}
                    >
                      {original?.role === 'user' ? '查看用户原文' : '查看助手原文'}
                    </button>
                  );
                })}
              </div>
            </article>
          ))}
          {source && (
            <SourcePage key={sessionId + source} sessionId={sessionId} messageId={source} />
          )}
        </div>
      )}
    </Modal>
  );
}
function SourcePage({ sessionId, messageId }: { sessionId: string; messageId: string }) {
  const [offset, setOffset] = useState(0),
    [value, setValue] = useState<{ offset: number; page: SessionHistoryPage }>(),
    [error, setError] = useState(''),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setError('');
    void api<SessionHistoryPage>(
      `/local/sessions/${sessionId}/history?messageId=${encodeURIComponent(messageId)}&offset=${offset}&limit=2000`,
      { signal: abort.signal },
    )
      .then((page) => {
        if (!abort.signal.aborted) setValue({ offset, page });
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [sessionId, messageId, offset, retry]);
  const page = value?.offset === offset ? value.page : undefined;
  return (
    <section className="memory-original" aria-label="历史来源原文">
      <h3>{page?.source?.role === 'user' ? '用户原文' : '来源原文'}</h3>
      {error ? (
        <p role="alert">
          {error}
          <button className="text-button" onClick={() => setRetry((v) => v + 1)}>
            重试
          </button>
        </p>
      ) : !page ? (
        <Spinner />
      ) : (
        <>
          <pre className="trace-raw">{page.text}</pre>
          <div className="trace-pager">
            <span>
              {page.offset + 1}–{page.offset + page.text.length} / {page.totalChars} 字符
            </span>
            <button
              disabled={!page.offset}
              onClick={() => setOffset(Math.max(0, page.offset - 2000))}
            >
              上一段
            </button>
            <button disabled={page.nextOffset === null} onClick={() => setOffset(page.nextOffset!)}>
              下一段
            </button>
          </div>
        </>
      )}
    </section>
  );
}
