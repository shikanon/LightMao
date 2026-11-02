import { useState, useRef, type FormEvent } from 'react';
import { Archive, ArchiveRestore, Pin, PinOff, GitBranch, Info } from 'lucide-react';
import type { SessionView, SessionSummary } from '../../../../packages/shared/types';
import { useWorkspace } from '../context';
import { post, patch } from '../api';
import { Modal, Spinner } from '../components/UI';

export function ForkSessionDialog({
  session,
  messageId,
  onClose,
}: {
  session: SessionView;
  messageId?: string;
  onClose: () => void;
}) {
  const w = useWorkspace(),
    points = session.messages.filter((message) => message.role === 'assistant');
  const [point, setPoint] = useState(messageId || points.at(-1)?.id || ''),
    [busy, setBusy] = useState(false);
  const operation = useRef({ id: crypto.randomUUID(), body: '' });
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = String(new FormData(event.currentTarget).get('title') || '').trim();
    setBusy(true);
    const body = JSON.stringify([session.id, point, title]);
    if (operation.current.body && operation.current.body !== body)
      operation.current = { id: crypto.randomUUID(), body };
    else operation.current.body = body;
    try {
      const result = await w.perform(async () => {
        const value = await post<SessionView>(`/local/sessions/${session.id}/fork`, {
          messageId: point,
          title,
          requestId: operation.current.id,
        });
        await w.refresh();
        w.openSession(value.id);
        return value;
      }, '已创建独立会话分支');
      if (result) onClose();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="从选定轮次分叉"
      description="只复制这轮及之前的对话，不重新执行历史工具。"
      onClose={onClose}
    >
      <form onSubmit={(event) => void submit(event)}>
        <label>
          分叉位置
          <select
            aria-label="分叉位置"
            value={point}
            onChange={(event) => setPoint(event.target.value)}
            disabled={busy}
          >
            {points.map((message, index) => (
              <option key={message.id} value={message.id}>
                {message.sample ? '示例回答' : `第 ${index + 1} 轮回答`} ·{' '}
                {message.text.replace(/[#*\n]/g, ' ').slice(0, 55)}
              </option>
            ))}
          </select>
        </label>
        <label>
          分支名称
          <input
            name="title"
            defaultValue={`${session.title.slice(0, 94)} · 分支`}
            required
            maxLength={100}
            disabled={busy}
          />
        </label>
        <div className="setting-note">
          <Info size={17} />
          <p>
            新分支共享当前项目文件，不恢复旧文件版本。对话和后续执行记录分别保存，旧工具结果继续按引用查看。
          </p>
        </div>
        <footer>
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={busy || !point}>
            {busy ? <Spinner /> : <GitBranch size={16} />}创建分支
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export function ManageSessionDialog({
  session,
  onClose,
  onChanged,
}: {
  session: SessionView | SessionSummary;
  onClose: () => void;
  onChanged?: () => Promise<void>;
}) {
  const w = useWorkspace(),
    [value, setValue] = useState(session),
    [busy, setBusy] = useState(false);
  async function update(
    input: { title?: string; pinned?: boolean; archived?: boolean },
    message: string,
    close = false,
  ) {
    setBusy(true);
    try {
      const updated = await w.perform(async () => {
        const next = await patch<SessionView>(`/local/sessions/${value.id}`, input);
        setValue(next);
        await Promise.all([w.refresh(), onChanged?.()]);
        return next;
      }, message);
      if (updated && close) onClose();
    } finally {
      setBusy(false);
    }
  }
  function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void update(
      { title: String(new FormData(event.currentTarget).get('title') || '').trim() },
      '会话名称已保存',
    );
  }
  return (
    <Modal title="管理会话" description={value.title} onClose={onClose}>
      <form onSubmit={rename}>
        <label>
          会话名称
          <input
            name="title"
            defaultValue={value.title}
            required
            maxLength={100}
            disabled={busy || !!value.activeRunId}
          />
        </label>
        <button className="button secondary small-button" disabled={busy || !!value.activeRunId}>
          保存名称
        </button>
      </form>
      <div className="session-manage-actions">
        <button
          className="session-manage-action"
          disabled={busy || !!value.activeRunId}
          onClick={() =>
            void update({ pinned: !value.pinned }, value.pinned ? '已取消置顶' : '会话已置顶')
          }
        >
          {value.pinned ? <PinOff size={19} /> : <Pin size={19} />}
          <span>
            <strong>{value.pinned ? '取消置顶' : '置顶会话'}</strong>
            <small>在历史与侧边栏中优先显示</small>
          </span>
        </button>
        <button
          className="session-manage-action"
          disabled={busy || !!value.activeRunId}
          onClick={() =>
            void update(
              { archived: !value.archivedAt },
              value.archivedAt ? '会话已恢复' : '会话已归档',
              true,
            )
          }
        >
          {value.archivedAt ? <ArchiveRestore size={19} /> : <Archive size={19} />}
          <span>
            <strong>{value.archivedAt ? '恢复会话' : '归档会话'}</strong>
            <small>
              {value.archivedAt
                ? '恢复后可继续对话，不会自动执行'
                : '隐藏侧边栏记录，保留消息和执行详情'}
            </small>
          </span>
        </button>
      </div>
      {value.activeRunId && (
        <p className="form-hint">当前正在执行，请先停止或等待结束后修改会话。</p>
      )}
      <footer>
        <button className="button secondary" onClick={onClose} disabled={busy}>
          关闭
        </button>
      </footer>
    </Modal>
  );
}
