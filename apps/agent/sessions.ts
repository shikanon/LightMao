import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { Store } from '../../packages/shared/store.ts';
import {
  now,
  type ChatMessage,
  type Run,
  type Session,
  type SessionPage,
  type SessionView,
  type SessionSummary,
  type SessionHistoryPage,
} from '../../packages/shared/types.ts';

const fail = (statusCode: number, message: string, code = 'SESSION_INVALID'): never => {
  throw Object.assign(new Error(message), { statusCode, code });
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const idsHash = (messages: ChatMessage[]) =>
  hash(JSON.stringify(messages.map((message) => message.id)));
type Scope = { ownerId: string; projectId: string; sessionId: string; runId: string };
interface Checkpoint {
  id: string;
  projectId: string;
  sessionId: string;
  messageId: string;
  messageHash: string;
  refs: string[];
  sha256: string;
  status: Run['status'];
  at: string;
  origin: 'recorded' | 'reconstructed';
  version: 1;
  projectRevision?: number;
}
interface Blob {
  id: string;
  projectId: string;
  message: AgentMessage;
  sha256: string;
}
interface Options {
  store: Store;
  key: Buffer;
  normalize: (messages: AgentMessage[], scope: Scope, runIds: Set<string>) => AgentMessage[];
  checkRef: (ref: string, owner: string, project: string, runIds: Set<string>) => void;
}
export class SessionService {
  constructor(private options: Options) {}
  get(id: string, owner: string) {
    return (
      this.options.store.get<Session>('session', id, owner) ||
      fail(404, '会话不存在', 'SESSION_NOT_FOUND')
    );
  }
  view(session: Session): SessionView {
    const { transcript: _, ...value } = session;
    return value;
  }
  history(
    owner: string,
    sessionId: string,
    input: {
      messageId?: string;
      runId?: string;
      query?: string;
      offset?: number;
      limit?: number;
    } = {},
  ): SessionHistoryPage {
    const session = this.get(sessionId, owner);
    let data: unknown;
    let source: SessionHistoryPage['source'];
    if (input.messageId) {
      const message = session.messages.find((m) => m.id === input.messageId);
      if (!message) return fail(404, '历史消息不属于当前会话', 'SESSION_HISTORY_NOT_FOUND');
      data = message!.text;
      source = { id: message!.id, role: message!.role, at: message!.at, runId: message!.runId };
    } else if (input.runId) {
      const point = session.messages.findLastIndex(
        (m) => m.runId === input.runId && m.role === 'assistant',
      );
      const run = this.options.store.get<Run>('run', input.runId, owner);
      if (point < 0 || !run || run.projectId !== session.projectId || run.status === 'running')
        return fail(404, '历史轮次不属于当前会话的已结束记录', 'SESSION_HISTORY_NOT_FOUND');
      const checkpoint = this.options.store.get<Checkpoint>(
        'session-checkpoint',
        input.runId,
        owner,
      );
      if (!checkpoint)
        return fail(409, '该历史轮次没有可验证的原始上下文', 'SESSION_CHECKPOINT_UNAVAILABLE');
      data = {
        type: 'historical_checkpoint',
        referenceOnly: true,
        runId: run.id,
        status: run.status,
        messages: this.load(owner, checkpoint, session.messages.slice(0, point + 1)),
      };
    } else {
      const matching = session.messages.filter(
        (m) => !input.query || m.text.toLocaleLowerCase().includes(input.query.toLocaleLowerCase()),
      );
      data = {
        type: 'historical_index',
        referenceOnly: true,
        count: matching.length,
        messages: matching
          .slice(-8)
          .reverse()
          .map((m) => ({
            id: m.id,
            runId: m.runId,
            role: m.role,
            at: m.at,
            preview: m.text.slice(0, 180),
          })),
      };
    }
    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2),
      limit = Math.max(1, Math.min(4000, input.limit ?? 2000));
    let offset = Math.min(text.length, Math.max(0, input.offset ?? 0)),
      found = true;
    if (input.query && (input.messageId || input.runId)) {
      const index = text.toLocaleLowerCase().indexOf(input.query.toLocaleLowerCase(), offset);
      found = index >= 0;
      if (found) offset = Math.max(0, index - 120);
    }
    const end = Math.min(text.length, offset + limit);
    return {
      text: found ? text.slice(offset, end) : '',
      offset,
      nextOffset: found && end < text.length ? end : null,
      totalChars: text.length,
      found,
      sha256: hash(text),
      source,
    };
  }
  summary(session: Session, query = ''): SessionSummary {
    const { messages, transcript: _, ...base } = session;
    const matching =
      query && messages.find((m) => m.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    const text = (matching || messages.at(-1))?.text || '';
    const index = query
      ? Math.max(0, text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) - 60)
      : 0;
    return {
      ...base,
      messageCount: messages.length,
      preview:
        (index ? '…' : '') +
        text.slice(index, index + 180) +
        (text.length > index + 180 ? '…' : ''),
    };
  }
  counts(owner: string) {
    const rows = this.options.store.db
      .prepare(
        "SELECT json_extract(data,'$.projectId') AS projectId,count(*) AS total,sum(json_extract(data,'$.archivedAt') IS NULL) AS active FROM records WHERE kind='session' AND owner=? GROUP BY json_extract(data,'$.projectId')",
      )
      .all(owner) as { projectId: string; total: number; active: number }[];
    return Object.fromEntries(
      rows.map((row) => [
        row.projectId,
        { total: row.total, active: row.active, archived: row.total - row.active },
      ]),
    );
  }
  list(
    owner: string,
    input: {
      projectId?: string;
      state?: 'active' | 'archived' | 'all';
      query?: string;
      limit?: number;
      cursor?: string;
    } = {},
  ): SessionPage {
    const state = input.state || 'active',
      query = (input.query || '').trim(),
      limit = Math.min(50, Math.max(1, input.limit || 25));
    const filter = hash(JSON.stringify([owner, input.projectId || '', state, query]));
    const where = ['kind=?', 'owner=?'],
      params: (string | number)[] = ['session', owner];
    if (input.projectId) {
      where.push("json_extract(data,'$.projectId')=?");
      params.push(input.projectId);
    }
    if (state !== 'all')
      where.push(
        `json_extract(data,'$.archivedAt') IS ${state === 'active' ? 'NULL' : 'NOT NULL'}`,
      );
    if (query) {
      where.push(
        "(json_extract(data,'$.title') LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM json_each(json_extract(records.data,'$.messages')) m WHERE json_extract(m.value,'$.text') LIKE ? ESCAPE '\\'))",
      );
      const term = '%' + query.replace(/[\\%_]/g, '\\$&') + '%';
      params.push(term, term);
    }
    const count = (
      this.options.store.db
        .prepare(`SELECT count(*) AS n FROM records WHERE ${where.join(' AND ')}`)
        .get(...params) as { n: number }
    ).n;
    const pin = "coalesce(json_extract(data,'$.pinned'),0)",
      stamp = "json_extract(data,'$.updatedAt')";
    if (input.cursor) {
      try {
        const [payload, signature, ...extra] = input.cursor.split('.');
        if (
          extra.length ||
          !/^[a-f0-9]{64}$/.test(signature) ||
          !timingSafeEqual(
            Buffer.from(signature, 'hex'),
            createHmac('sha256', this.options.key).update(payload).digest(),
          )
        )
          throw Error();
        const value = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
          filter: string;
          pin: number;
          stamp: string;
          id: string;
        };
        if (
          value.filter !== filter ||
          ![0, 1].includes(value.pin) ||
          typeof value.stamp !== 'string' ||
          value.stamp.length > 40 ||
          typeof value.id !== 'string' ||
          value.id.length > 128
        )
          throw Error();
        where.push(`(${pin}<? OR (${pin}=? AND (${stamp}<? OR (${stamp}=? AND id<?))))`);
        params.push(value.pin, value.pin, value.stamp, value.stamp, value.id);
      } catch {
        fail(400, '分页位置已失效，请重新加载会话列表', 'SESSION_CURSOR_INVALID');
      }
    }
    const rows = this.options.store.db
      .prepare(
        `SELECT data FROM records WHERE ${where.join(' AND ')} ORDER BY ${pin} DESC,${stamp} DESC,id DESC LIMIT ?`,
      )
      .all(...params, limit + 1) as { data: string }[];
    const entries = rows.slice(0, limit).map((row) => JSON.parse(row.data) as Session);
    const last = entries.at(-1);
    let nextCursor: string | null = null;
    if (rows.length > limit && last) {
      const payload = Buffer.from(
        JSON.stringify({ filter, pin: last.pinned ? 1 : 0, stamp: last.updatedAt, id: last.id }),
      ).toString('base64url');
      nextCursor =
        payload + '.' + createHmac('sha256', this.options.key).update(payload).digest('hex');
    }
    return { items: entries.map((s) => this.summary(s, query)), nextCursor, total: count };
  }
  patch(
    owner: string,
    id: string,
    input: { title?: string; pinned?: boolean; archived?: boolean },
  ) {
    const session = this.get(id, owner);
    if (session.activeRunId) fail(409, '会话正在运行，请先停止或等待完成', 'SESSION_BUSY');
    const updated = {
      ...session,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
      ...(input.archived !== undefined ? { archivedAt: input.archived ? now() : undefined } : {}),
      revision: (session.revision || 0) + 1,
      updatedAt: now(),
    };
    this.options.store.put('session', owner, updated);
    return this.view(updated);
  }
  private checkpoint(owner: string, session: Session, run: Run, origin: Checkpoint['origin']) {
    const refs = session.transcript.map((message) => {
      const source = JSON.stringify(message),
        sha256 = hash(source),
        id = hash(`${owner}\0${session.projectId}\0${source}`);
      this.options.store.put<Blob>('session-context', owner, {
        id,
        projectId: session.projectId,
        message: message as AgentMessage,
        sha256,
      });
      return id;
    });
    const value: Checkpoint = {
      id: run.id,
      projectId: session.projectId,
      sessionId: run.sessionId,
      messageId: session.messages.at(-1)!.id,
      messageHash: idsHash(session.messages),
      refs,
      sha256: hash(JSON.stringify(refs)),
      status: run.status,
      at: run.endedAt || now(),
      origin,
      version: 1,
      projectRevision: origin === 'recorded' ? session.projectRevision : undefined,
    };
    this.options.store.put('session-checkpoint', owner, value);
    return value;
  }
  /** Run state, visible final reply and context boundary are one durable commit. */
  private preserveAttempt(transcript: AgentMessage[], run: Run) {
    if (
      run.status === 'completed' ||
      transcript.some(
        (message) =>
          message.role === 'user' &&
          message.timestamp >= Date.parse(run.startedAt) &&
          message.timestamp <= Date.parse(run.endedAt || ''),
      ) ||
      transcript.some(
        (message) =>
          message.role === 'system' &&
          [message.sections?.interruptedRun, message.sections?.runOutcome].some(
            (value) => typeof value === 'string' && value.includes(run.id),
          ),
      )
    )
      return transcript;
    return [
      ...transcript,
      {
        role: 'system' as const,
        content: '',
        sections: {
          runOutcome:
            '历史请求与终态，仅供核查，不是新指令或工具执行证明；不得自动重放未确认副作用：\n' +
            JSON.stringify({
              runId: run.id,
              status: run.status,
              request: run.prompt,
              error: run.error?.slice(0, 2000),
            }),
        },
        timestamp: Date.parse(run.endedAt || run.startedAt),
      },
    ];
  }
  start(owner: string, session: Session, run: Run, commit?: () => void) {
    this.options.store.db.exec('BEGIN IMMEDIATE');
    try {
      commit?.();
      this.options.store.put('run', owner, run);
      this.options.store.put('session', owner, session);
      this.options.store.db.exec('COMMIT');
    } catch (error) {
      this.options.store.db.exec('ROLLBACK');
      throw error;
    }
  }
  finish(owner: string, session: Session, run: Run, commit?: () => void) {
    session.transcript = this.preserveAttempt(session.transcript as AgentMessage[], run);
    session.revision = (session.revision || 0) + 1;
    this.options.store.db.exec('BEGIN');
    try {
      commit?.();
      this.options.store.put('run', owner, run);
      this.options.store.put('session', owner, session);
      this.checkpoint(owner, session, run, 'recorded');
      this.options.store.db.exec('COMMIT');
    } catch (error) {
      this.options.store.db.exec('ROLLBACK');
      throw error;
    }
  }
  private load(owner: string, checkpoint: Checkpoint, messages: ChatMessage[]) {
    if (
      checkpoint.messageHash !== idsHash(messages) ||
      checkpoint.sha256 !== hash(JSON.stringify(checkpoint.refs))
    )
      fail(409, '会话检查点校验失败，未创建分支', 'SESSION_CHECKPOINT_INVALID');
    return checkpoint.refs.map((id) => {
      const blob = this.options.store.get<Blob>('session-context', id, owner);
      if (
        !blob ||
        blob.projectId !== checkpoint.projectId ||
        blob.sha256 !== hash(JSON.stringify(blob.message)) ||
        id !== hash(`${owner}\0${checkpoint.projectId}\0${JSON.stringify(blob.message)}`)
      )
        return fail(409, '会话检查点缺失或损坏，未创建分支', 'SESSION_CHECKPOINT_INVALID');
      return structuredClone(blob.message);
    });
  }
  /** Legacy transcripts have no run IDs. Accept only a verified prompt boundary. */
  private legacy(owner: string, source: Session, messages: ChatMessage[], run: Run) {
    const transcript = (source.transcript as AgentMessage[]).filter(
      (m) => !(m.role === 'assistant' && m.provider === 'lightmao-context'),
    );
    let prefix: AgentMessage[];
    if (!source.activeRunId && messages.length === source.messages.length)
      prefix = structuredClone(transcript);
    else {
      const candidates = transcript.flatMap((message, index) => {
        if (message.role !== 'user') return [];
        const text =
          typeof message.content === 'string'
            ? message.content
            : message.content
                .filter((c) => c.type === 'text')
                .map((c) => c.text)
                .join('\n');
        return text === run.prompt &&
          message.timestamp >= Date.parse(run.startedAt) &&
          message.timestamp <= Date.parse(run.endedAt || '')
          ? [index]
          : [];
      });
      if (candidates.length !== 1)
        fail(409, '此旧版轮次缺少可验证的上下文边界，未创建分支', 'SESSION_CHECKPOINT_UNAVAILABLE');
      const start = candidates[0];
      let end = transcript.findIndex((message, index) => index > start && message.role === 'user');
      if (end < 0) fail(409, '旧版轮次缺少后续边界，未创建分支', 'SESSION_CHECKPOINT_UNAVAILABLE');
      const before = transcript[end - 1];
      if (
        before?.role !== 'system' ||
        !before.sections ||
        !Object.hasOwn(before.sections, 'selectedContext')
      )
        fail(409, '旧版上下文边界格式不受支持，未创建分支', 'SESSION_CHECKPOINT_UNAVAILABLE');
      end--;
      prefix = structuredClone(transcript.slice(0, end));
      const final = prefix.at(-1);
      if (final?.role !== 'assistant' || final.content.some((part) => part.type === 'toolCall'))
        fail(409, '旧版轮次未保留完整结果，未创建分支', 'SESSION_CHECKPOINT_UNAVAILABLE');
    }
    const runIds = new Set(messages.flatMap((m) => (m.runId ? [m.runId] : [])));
    for (const message of prefix)
      if (message.role === 'toolResult') {
        const ref = (message.details as { archiveRef?: string } | undefined)?.archiveRef;
        if (ref) this.options.checkRef(ref, owner, source.projectId, runIds);
      }
    return this.options.normalize(
      this.preserveAttempt(prefix, run),
      { ownerId: owner, projectId: source.projectId, sessionId: source.id, runId: run.id },
      runIds,
    );
  }
  fork(
    owner: string,
    id: string,
    input: { messageId?: string; title?: string; requestId?: string },
  ) {
    const source = this.get(id, owner);
    const operation = input.requestId ? hash(`${owner}\0${input.requestId}`) : undefined,
      fingerprint = hash(JSON.stringify([id, input.messageId || null, input.title || null]));
    if (operation) {
      const previous = this.options.store.get<{
        id: string;
        fingerprint: string;
        sessionId: string;
      }>('session-fork-operation', operation, owner);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          fail(409, '分叉请求已用于其他位置，请重新操作', 'SESSION_FORK_REQUEST_CONFLICT');
        return this.view(this.get(previous.sessionId, owner));
      }
    }
    if (!input.messageId && source.activeRunId)
      fail(409, '请在当前轮次结束后分叉，或选择已完成的较早轮次', 'SESSION_BUSY');
    const end = input.messageId
      ? source.messages.findIndex((m) => m.id === input.messageId)
      : source.messages.length - 1;
    if (input.messageId && end < 0)
      fail(404, '分叉轮次不存在于当前会话', 'SESSION_FORK_POINT_INVALID');
    const messages = structuredClone(source.messages.slice(0, end + 1)),
      point = messages.at(-1);
    if (point && point.role !== 'assistant')
      fail(400, '只能从已结束的回答轮次分叉', 'SESSION_FORK_POINT_INVALID');
    let transcript: AgentMessage[] = [],
      origin: Session['forkContext'],
      projectRevision: number | undefined;
    if (point?.runId) {
      const run = this.options.store.get<Run>('run', point.runId, owner);
      if (!run || run.projectId !== source.projectId || run.status === 'running' || !run.endedAt)
        fail(409, '该轮次尚未结束，无法分叉', 'SESSION_FORK_POINT_INVALID');
      let checkpoint = this.options.store.get<Checkpoint>('session-checkpoint', point.runId, owner);
      if (checkpoint) {
        if (checkpoint.projectId !== source.projectId || checkpoint.messageId !== point.id)
          fail(409, '分叉检查点不匹配', 'SESSION_CHECKPOINT_INVALID');
        transcript = this.load(owner, checkpoint, messages);
        origin = checkpoint.origin;
        projectRevision = checkpoint.projectRevision;
      } else {
        transcript = this.legacy(owner, source, messages, run!);
        origin = 'reconstructed';
        this.options.store.db.exec('BEGIN');
        try {
          checkpoint = this.checkpoint(
            owner,
            { ...source, messages, transcript },
            run!,
            'reconstructed',
          );
          this.options.store.db.exec('COMMIT');
        } catch (error) {
          this.options.store.db.exec('ROLLBACK');
          throw error;
        }
      }
    } else if (point?.sample) {
      origin = 'sample';
      transcript = [
        {
          role: 'system',
          content: '',
          sections: {
            sampleConversation:
              '示例对话，仅供参考，不代表用户本轮指令或真实工具执行：\n' +
              JSON.stringify(messages.map((m) => ({ role: m.role, text: m.text }))),
          },
          timestamp: Date.now(),
        },
      ];
    } else if (point) fail(409, '此轮次没有可验证的运行记录', 'SESSION_CHECKPOINT_UNAVAILABLE');
    const time = now();
    const branch: Session = {
      id: randomUUID(),
      projectId: source.projectId,
      title: input.title || `${source.title.slice(0, 94)} · 分支`,
      messages,
      transcript,
      parentId: source.id,
      forkPoint: point?.id,
      forkRunId: point?.runId,
      forkSourceTitle: source.title,
      forkContext: origin,
      projectRevision,
      status: 'idle',
      createdAt: time,
      updatedAt: time,
      revision: 1,
    };
    this.options.store.db.exec('BEGIN');
    try {
      this.options.store.put('session', owner, branch);
      if (operation)
        this.options.store.put('session-fork-operation', owner, {
          id: operation,
          fingerprint,
          sessionId: branch.id,
        });
      this.options.store.db.exec('COMMIT');
    } catch (error) {
      this.options.store.db.exec('ROLLBACK');
      throw error;
    }
    return this.view(branch);
  }
}
