import { createHash, randomUUID } from 'node:crypto';
import type { StreamFunction } from '@earendil-works/pi-ai';
import type { Store } from '../../packages/shared/store.ts';
import type { TraceHead, TraceEvent, TracePage } from '../../packages/shared/trace.ts';
const hash = (v: unknown) =>
  createHash('sha256')
    .update(typeof v === 'string' ? v : JSON.stringify(v))
    .digest('hex');
const now = () => new Date().toISOString();
type Scope = { owner: string; project: string; session: string; run: string };
export class TraceService {
  private steps = new Map<string, string>();
  private tools = new Map<string, string>();
  private closed = false;
  constructor(private store: Store) {
    // Read-only query consumers cannot rewrite history. Derived heads remain mutable.
    store.db
      .exec(`CREATE TRIGGER IF NOT EXISTS immutable_trace_event_update BEFORE UPDATE ON records WHEN OLD.kind='trace-event' BEGIN SELECT RAISE(ABORT,'immutable trace event'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_trace_event_delete BEFORE DELETE ON records WHEN OLD.kind='trace-event' BEGIN SELECT RAISE(ABORT,'immutable trace event'); END;`);
    for (const head of store.list<TraceHead>('trace-head'))
      if (head.status === 'running')
        this.append(head.ownerId, head.id, {
          kind: 'run.interrupted',
          name: '服务重启，未重放原请求',
          status: 'interrupted',
          spanId: head.id,
        });
  }
  start(
    scope: Scope,
    options: {
      parentTraceId?: string;
      parentSpanId?: string;
      goalId?: string;
      kind?: TraceHead['kind'];
    } = {},
  ) {
    const existing = this.store.get<TraceHead>('trace-head', scope.run, scope.owner);
    if (existing) return existing;
    const head: TraceHead = {
      id: scope.run,
      ownerId: scope.owner,
      projectId: scope.project,
      sessionId: scope.session,
      runId: scope.run,
      parentTraceId: options.parentTraceId,
      parentSpanId: options.parentSpanId,
      goalId: options.goalId,
      kind: options.kind || 'run',
      createdAt: now(),
      updatedAt: now(),
      sequence: 0,
      lastHash: '',
      status: 'running',
    };
    this.store.put('trace-head', scope.owner, head);
    this.append(scope.owner, scope.run, {
      kind: 'run.started',
      name: options.kind === 'subagent' ? '独立子 Agent' : '主 Agent',
      spanId: scope.run,
      parentSpanId: options.parentSpanId,
      status: 'running',
    });
    return head;
  }
  head(owner: string, id: string) {
    const head = this.store.get<TraceHead>('trace-head', id, owner);
    if (!head) throw Object.assign(Error('运行轨迹不存在或不属于当前账号'), { statusCode: 404 });
    return head;
  }
  private pack(owner: string, value: unknown): unknown {
    if (Array.isArray(value)) return value.map((v) => this.pack(owner, v));
    if (!value || typeof value !== 'object') {
      if (typeof value === 'string' && /^data:[\w/+.-]+;base64,/.test(value)) {
        const p = value.indexOf(','),
          mime = value.slice(5, value.indexOf(';'));
        return this.blob(owner, value.slice(p + 1), mime, 'data-url');
      }
      return value;
    }
    const obj = value as Record<string, unknown>,
      result: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(obj)) {
      if (
        /^(authorization|cookie|set-cookie|api[_-]?key|password|token|secret|access[_-]?token|refresh[_-]?token|reasoning_content|thinking|thought_signature)$/i.test(
          key,
        )
      ) {
        result[key] = '[redacted]';
        continue;
      }
      if (
        key === 'data' &&
        typeof v === 'string' &&
        (typeof obj.mimeType === 'string' ||
          typeof obj.mime === 'string' ||
          typeof obj.format === 'string') &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(v)
      ) {
        result[key] = this.blob(
          owner,
          v,
          String(obj.mimeType || obj.mime || 'audio/' + obj.format),
          'base64',
        );
        continue;
      }
      result[key] = this.pack(owner, v);
    }
    return result;
  }
  private blob(owner: string, data: string, mime: string, encoding: string) {
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length > 6 * 1024 * 1024) throw Error('轨迹媒体超过记录预算');
    const sha256 = createHash('sha256').update(bytes).digest('hex'),
      id = hash(owner + '\0' + sha256);
    if (!this.store.get('trace-blob', id, owner))
      this.store.put('trace-blob', owner, { id, data, mime, sha256, bytes: bytes.length });
    return { $media: id, mime, bytes: bytes.length, sha256, encoding };
  }
  payload(owner: string, value: unknown): { id: string; sha256: string } {
    const text = JSON.stringify(value);
    if (text.length > 8 * 1024 * 1024)
      return this.payload(owner, {
        omitted: true,
        reason: 'trace_payload_budget',
        originalChars: text.length,
        sha256: hash(text),
      });
    const packed = this.pack(owner, value),
      id = randomUUID(),
      storedText = JSON.stringify(packed, null, 2),
      sha256 = hash(storedText);
    this.store.put('trace-payload', owner, { id, text: storedText, sha256 });
    return { id, sha256 };
  }
  append(
    owner: string,
    id: string,
    input: Omit<TraceEvent, 'id' | 'traceId' | 'sequence' | 'at' | 'previousHash' | 'hash'> & {
      payload?: unknown;
    },
  ) {
    const head = this.head(owner, id),
      { payload, ...fields } = input;
    const stored = payload === undefined ? undefined : this.payload(owner, payload);
    const unsigned = {
      ...fields,
      id: randomUUID(),
      traceId: id,
      sequence: head.sequence + 1,
      at: now(),
      previousHash: head.lastHash,
      ...(stored ? { payloadRef: stored.id, payloadSha256: stored.sha256 } : {}),
    };
    const event: TraceEvent = { ...unsigned, hash: hash(unsigned) };
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.store.put('trace-event', owner, event);
      this.store.put('trace-head', owner, {
        ...head,
        sequence: event.sequence,
        lastHash: event.hash,
        updatedAt: event.at,
        ...(event.kind.startsWith('run.') && event.kind !== 'run.started'
          ? { status: event.status || 'interrupted' }
          : {}),
      });
      this.store.db.exec('COMMIT');
    } catch (e) {
      this.store.db.exec('ROLLBACK');
      throw e;
    }
    return event;
  }
  list(owner: string, session: string) {
    const all = this.store.list<TraceHead>('trace-head', owner),
      ids = new Set(all.filter((h) => h.sessionId === session).map((h) => h.id));
    for (let depth = 0; depth < 8; depth++) {
      let changed = false;
      for (const head of all)
        if (head.parentTraceId && ids.has(head.parentTraceId) && !ids.has(head.id)) {
          ids.add(head.id);
          changed = true;
        }
      if (!changed) break;
    }
    return all
      .filter((h) => ids.has(h.id))
      .slice(-256)
      .reverse()
      .map(({ ownerId: _, ...h }) => h);
  }
  events(owner: string, id: string) {
    const head = this.head(owner, id),
      all = this.store
        .list<TraceEvent>('trace-event', owner)
        .filter((e) => e.traceId === id)
        .sort((a, b) => a.sequence - b.sequence);
    let previous = '';
    const integrity =
      all.every((e, index) => {
        const { hash: expected, ...body } = e;
        const valid =
          e.sequence === index + 1 && e.previousHash === previous && hash(body) === expected;
        previous = e.hash;
        return valid;
      }) &&
      all.length === head.sequence &&
      previous === head.lastHash;
    if (!integrity)
      throw Object.assign(Error('轨迹哈希或序号不一致，未展示不完整证据'), { statusCode: 409 });
    return { head, events: all, integrity };
  }
  page(owner: string, id: string, after = 0, limit = 80): TracePage {
    const { head, events: all, integrity } = this.events(owner, id);
    const events = all
        .filter((e) => e.sequence > after)
        .slice(0, Math.min(100, Math.max(1, limit))),
      last = events.at(-1)?.sequence || after;
    const { ownerId: _, ...view } = head;
    return { head: view, events, nextAfter: last, hasMore: last < head.sequence, integrity };
  }
  payloadValue(owner: string, id: string, ref: string): unknown {
    this.head(owner, id);
    const row = this.store.db
      .prepare(
        "SELECT data FROM records WHERE kind='trace-event' AND owner=? AND json_extract(data,'$.traceId')=? AND json_extract(data,'$.payloadRef')=? LIMIT 1",
      )
      .get(owner, id, ref) as { data: string } | undefined;
    if (!row) throw Object.assign(Error('载荷不属于该轨迹'), { statusCode: 404 });
    const event = JSON.parse(row.data) as TraceEvent;
    const payload = this.store.get<{ text: string; sha256: string }>('trace-payload', ref, owner);
    if (!payload || hash(payload.text) !== payload.sha256 || payload.sha256 !== event.payloadSha256)
      throw Object.assign(Error('轨迹载荷哈希不符'), { statusCode: 409 });
    return JSON.parse(payload.text);
  }
  read(owner: string, id: string, ref: string, offset = 0) {
    const page = this.page(owner, id, 0, 100);
    if (
      !this.store
        .list<TraceEvent>('trace-event', owner)
        .some((e) => e.traceId === id && e.payloadRef === ref)
    )
      throw Object.assign(Error('载荷不属于该轨迹'), { statusCode: 404 });
    const payload = this.store.get<{ text: string; sha256: string }>('trace-payload', ref, owner)!;
    if (hash(payload.text) !== payload.sha256)
      throw Object.assign(Error('轨迹载荷哈希不符'), { statusCode: 409 });
    const end = Math.min(payload.text.length, offset + 6000);
    return {
      text: payload.text.slice(offset, end),
      totalChars: payload.text.length,
      nextOffset: end < payload.text.length ? end : null,
      sha256: payload.sha256,
      integrity: page.integrity,
    };
  }
  media(owner: string, id: string, blobId: string) {
    this.head(owner, id);
    const referenced = this.store
      .list<TraceEvent>('trace-event', owner)
      .filter((e) => e.traceId === id && e.payloadRef)
      .some((e) =>
        this.store
          .get<{ text: string }>('trace-payload', e.payloadRef!, owner)
          ?.text.includes('"$media": "' + blobId + '"'),
      );
    if (!referenced) throw Object.assign(Error('媒体不属于该轨迹'), { statusCode: 404 });
    const blob = this.store.get<{ data: string; mime: string; sha256: string }>(
      'trace-blob',
      blobId,
      owner,
    )!;
    const bytes = Buffer.from(blob.data, 'base64');
    if (createHash('sha256').update(bytes).digest('hex') !== blob.sha256)
      throw Error('轨迹媒体校验失败');
    return { bytes, mime: blob.mime };
  }
  toolSpan(id: string, callId: string) {
    return this.tools.get(id + '\0' + callId) || hash(id + '\0tool\0' + callId);
  }
  event(owner: string, id: string, type: string, data: Record<string, unknown>) {
    if (
      !this.store.get('trace-head', id, owner) ||
      ['text.delta', 'text.started', 'run.started'].includes(type)
    )
      return;
    const tool = String(data.toolCallId || ''),
      isTool = type.startsWith('tool.'),
      spanId = isTool ? this.toolSpan(id, tool) : id;
    if (type === 'tool.started') this.tools.set(id + '\0' + tool, spanId);
    const detail = data.detail as { id?: string; summary?: string } | undefined;
    this.append(owner, id, {
      kind: type,
      name: isTool ? String(data.name) : type,
      spanId,
      parentSpanId: isTool ? this.steps.get(id) : undefined,
      status:
        type === 'tool.finished'
          ? data.isError
            ? 'failed'
            : 'completed'
          : type === 'run.finished'
            ? String(data.status)
            : 'running',
      toolDetailRef: detail?.id,
      summary: detail?.summary?.slice(0, 500),
      payload:
        type === 'context.loaded' || type.startsWith('context.') || !isTool
          ? data
          : { toolCallId: tool, toolDetailRef: detail?.id, args: data.args, isError: data.isError },
    });
  }
  wrap(owner: string, id: string, fn: StreamFunction, phase = 'conversation'): StreamFunction {
    return (model, context, options) => {
      const spanId = randomUUID(),
        started = Date.now();
      this.steps.set(id, spanId);
      this.append(owner, id, {
        kind: 'model.attempt.started',
        name: phase,
        spanId,
        parentSpanId: id,
        status: 'running',
        payload: { model: model.id, provider: model.provider, phase },
      });
      let transported = false;
      const stream = fn(model, context, {
        ...options,
        headers: { ...options?.headers, 'X-Lightmao-Trace-ID': id, 'X-Lightmao-Span-ID': spanId },
        onPayload: async (payload, m) => {
          const replacement = await options?.onPayload?.(payload, m);
          const wire = replacement === undefined ? payload : replacement;
          const head = this.head(owner, id);
          const goal = head.goalId
            ? this.store.get<{
                contractHash?: string;
                objective: string;
                userConstraints?: unknown[];
              }>('agent-goal', head.goalId, owner)
            : undefined;
          if (phase === 'conversation' && head.kind === 'run' && goal?.contractHash) {
            const messages =
              (wire as { messages?: { role: string; content: unknown }[] }).messages || [];
            const system = messages
              .filter((v) => ['system', 'developer'].includes(v.role))
              .map((v) => (typeof v.content === 'string' ? v.content : JSON.stringify(v.content)))
              .join('\n');
            const anchorPresent = [
              ...system.matchAll(
                /<lightmao-goal-contract>\s*(\{[\s\S]*?\})\s*<\/lightmao-goal-contract>/g,
              ),
            ].some((match) => {
              try {
                const p = JSON.parse(match[1]);
                return (
                  p.goalId === head.goalId &&
                  p.contractHash === goal.contractHash &&
                  p.objective === goal.objective &&
                  JSON.stringify(p.userConstraints || []) ===
                    JSON.stringify(goal.userConstraints || [])
                );
              } catch {
                return false;
              }
            });
            this.append(owner, id, {
              kind: 'context.guard',
              name: '当前目标进入实际请求',
              spanId,
              parentSpanId: id,
              status: anchorPresent ? 'verified' : 'blocked',
              payload: {
                contractHash: goal.contractHash,
                anchorPresent,
                blocked: !anchorPresent,
                phase,
              },
            });
            if (!anchorPresent)
              throw Error('当前目标契约未进入模型请求，已阻止上下文漂移；本次未发送上游。');
          }
          transported = true;
          this.append(owner, id, {
            kind: 'model.request',
            name: '实际发送的模型输入',
            spanId,
            parentSpanId: id,
            status: 'running',
            payload: wire,
          });
          return replacement;
        },
        onResponse: async (response, m) => {
          this.append(owner, id, {
            kind: 'model.response',
            name: '网关响应',
            spanId,
            parentSpanId: id,
            status: response.status < 400 ? 'received' : 'failed',
            payload: { status: response.status, requestId: response.headers['x-request-id'] },
          });
          await options?.onResponse?.(response, m);
        },
      });
      void stream
        .result()
        .then((message) => {
          if (this.closed) return;
          if (!transported)
            this.append(owner, id, {
              kind: 'model.context',
              name: '本地Provider上下文（无HTTP请求）',
              spanId,
              parentSpanId: id,
              payload: { model: model.id, messages: context.messages },
            });
          this.append(owner, id, {
            kind: 'model.attempt.finished',
            name: phase,
            spanId,
            parentSpanId: id,
            status:
              message.stopReason === 'length'
                ? 'truncated'
                : ['error', 'aborted'].includes(message.stopReason)
                  ? message.stopReason
                  : 'completed',
            durationMs: Date.now() - started,
            payload: {
              content: message.content.filter((c) => c.type !== 'thinking'),
              stopReason: message.stopReason,
              usage: message.usage,
              error: message.errorMessage,
            },
          });
        })
        .catch(() => {
          if (this.closed) return;
          this.append(owner, id, {
            kind: 'model.attempt.finished',
            name: phase,
            spanId,
            parentSpanId: id,
            status: 'unknown',
            durationMs: Date.now() - started,
          });
        });
      return stream;
    };
  }
  observation(owner: string, run: string, name: string, value: unknown, parentSpanId?: string) {
    if (!this.store.get('trace-head', run, owner)) return;
    this.append(owner, run, {
      kind: 'observation',
      name,
      spanId: randomUUID(),
      parentSpanId: parentSpanId || this.steps.get(run) || run,
      status: 'observed',
      payload: value,
    });
  }
  close() {
    this.closed = true;
  }
}
