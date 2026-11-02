import { createHash, randomUUID } from 'node:crypto';
import { Store } from '../../packages/shared/store.ts';
import type { Run, Schedule, TaskOccurrence } from '../../packages/shared/types.ts';
import { nextOccurrence } from './scheduler.ts';

type Owned<T> = T & { ownerId: string };
function fail(status: number, message: string, code = 'TASK_BUSY'): never {
  throw Object.assign(new Error(message), { statusCode: status, code });
}

/** Durable trigger receipts. Only queued work can be dispatched after a restart. */
export class TaskJournal {
  constructor(
    private store: Store,
    private clock = () => Date.now(),
  ) {}
  private stamp() {
    return new Date(this.clock()).toISOString();
  }
  private transaction<T>(work: () => T): T {
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      this.store.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
  }
  get(owner: string, id: string) {
    return this.store.get<Owned<TaskOccurrence>>('task-occurrence', id, owner);
  }
  busy(owner: string, taskId: string) {
    return !!this.store.db
      .prepare(
        "SELECT 1 FROM records WHERE kind='task-occurrence' AND owner=? AND json_extract(data,'$.taskId')=? AND json_extract(data,'$.status') IN ('queued','running') LIMIT 1",
      )
      .get(owner, taskId);
  }
  enqueue(owner: string, taskId: string, source: TaskOccurrence['source'], requestId?: string) {
    return this.transaction(() => {
      const task =
        this.store.get<Owned<Schedule>>('schedule', taskId, owner) || fail(404, '任务不存在');
      const scheduledAt = source === 'scheduled' ? task.nextRunAt : this.stamp();
      const slot =
        task.frequency === 'daily'
          ? new Intl.DateTimeFormat('en-CA', {
              timeZone: task.timezone,
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
            }).format(new Date(scheduledAt))
          : scheduledAt;
      const id =
        source === 'scheduled' || requestId
          ? createHash('sha256')
              .update(
                JSON.stringify([
                  owner,
                  taskId,
                  source,
                  source === 'scheduled' ? [task.revision || 0, slot] : requestId,
                ]),
              )
              .digest('hex')
          : randomUUID();
      const previous = this.get(owner, id);
      if (previous) {
        if (source === 'scheduled' && Date.parse(scheduledAt) <= this.clock())
          this.store.put('schedule', owner, {
            ...task,
            nextRunAt: nextOccurrence(task, new Date(this.clock())),
          });
        return previous;
      }
      if (source === 'scheduled' && (!task.enabled || Date.parse(scheduledAt) > this.clock()))
        return undefined;
      const busy =
        this.busy(owner, taskId) ||
        this.store.db
          .prepare(
            "SELECT 1 FROM records WHERE kind='run' AND owner=? AND json_extract(data,'$.taskId')=? AND json_extract(data,'$.status')='running' LIMIT 1",
          )
          .get(owner, taskId);
      if (busy && source === 'manual') fail(409, '这个任务已在等待或运行，请先查看运行记录');
      const occurrence: Owned<TaskOccurrence> = {
        id,
        ownerId: owner,
        taskId,
        taskName: task.name,
        projectId: task.projectId,
        prompt: task.prompt,
        mode: task.mode,
        source,
        scheduledAt,
        createdAt: this.stamp(),
        status: busy ? 'skipped' : 'queued',
        ...(busy ? { endedAt: this.stamp(), error: '上一轮仍在等待或运行，本次触发已跳过。' } : {}),
      };
      if (source === 'scheduled') task.nextRunAt = nextOccurrence(task, new Date(this.clock()));
      if (!busy) {
        task.lastOccurrenceId = id;
        task.lastStatus = 'queued';
        task.lastError = undefined;
      }
      this.store.put('task-occurrence', owner, occurrence);
      this.store.put('schedule', owner, task);
      return occurrence;
    });
  }
  /** Called inside the same transaction that creates the run and its session. */
  started(owner: string, id: string, run: Run) {
    const occurrence = this.get(owner, id);
    const task =
      occurrence && this.store.get<Owned<Schedule>>('schedule', occurrence.taskId, owner);
    if (
      !occurrence ||
      occurrence.status !== 'queued' ||
      !task ||
      (occurrence.source === 'scheduled' && !task.enabled)
    )
      fail(409, '触发记录已取消或已被执行', 'TASK_DISPATCH_CANCELLED');
    if (
      this.store.db
        .prepare(
          "SELECT 1 FROM records WHERE kind='task-occurrence' AND owner=? AND id<>? AND json_extract(data,'$.taskId')=? AND json_extract(data,'$.status')='running' LIMIT 1",
        )
        .get(owner, id, task.id)
    )
      fail(409, '这个任务正在运行');
    this.store.put('task-occurrence', owner, {
      ...occurrence,
      status: 'running',
      sessionId: run.sessionId,
      runId: run.id,
      startedAt: run.startedAt,
      error: undefined,
      nextAttemptAt: undefined,
    });
    this.store.put('schedule', owner, {
      ...task,
      lastOccurrenceId: id,
      lastStatus: 'running',
      lastRunAt: run.startedAt,
      lastSessionId: run.sessionId,
      lastError: undefined,
    });
  }
  /** Called with the run/checkpoint transaction, including interrupted-run recovery. */
  finished(owner: string, run: Run) {
    const occurrence = run.taskOccurrenceId && this.get(owner, run.taskOccurrenceId);
    if (!occurrence || occurrence.runId !== run.id) return;
    this.store.put('task-occurrence', owner, {
      ...occurrence,
      status: run.status,
      endedAt: run.endedAt || this.stamp(),
      error: run.error,
    });
    const task = this.store.get<Owned<Schedule>>('schedule', occurrence.taskId, owner);
    if (task?.lastOccurrenceId === occurrence.id)
      this.store.put('schedule', owner, {
        ...task,
        lastStatus: run.status,
        lastError: run.error,
        lastSessionId: run.sessionId,
      });
  }
  pending() {
    const rows = this.store.db
      .prepare(
        "SELECT data FROM records WHERE kind='task-occurrence' AND json_extract(data,'$.status')='queued' AND (json_extract(data,'$.nextAttemptAt') IS NULL OR json_extract(data,'$.nextAttemptAt')<=?) ORDER BY rowid LIMIT 50",
      )
      .all(this.stamp()) as { data: string }[];
    return rows.map((row) => JSON.parse(row.data) as Owned<TaskOccurrence>);
  }
  failed(
    owner: string,
    id: string,
    error: { statusCode?: number; code?: string; message?: string },
  ) {
    this.transaction(() => {
      const occurrence = this.get(owner, id);
      if (!occurrence || occurrence.status !== 'queued') return;
      const required =
        error.code === 'DEVICE_AUTH_REQUIRED' ||
        ([401, 403].includes(error.statusCode || 0) && !error.code?.startsWith('PROJECT_'));
      const unavailable = error.code?.startsWith('PROJECT_');
      const transient =
        !required &&
        !unavailable &&
        (!error.statusCode || error.statusCode === 429 || error.statusCode >= 500);
      const attempts = (occurrence.attempts || 0) + 1;
      const status = required
        ? 'authorization_required'
        : unavailable
          ? 'project_unavailable'
          : transient
            ? 'queued'
            : 'failed';
      const message = required
        ? '本机授权已失效，请重新登录后授权'
        : error.message || '任务执行失败';
      this.store.put('task-occurrence', owner, {
        ...occurrence,
        status,
        error: message,
        attempts,
        ...(transient
          ? {
              nextAttemptAt: new Date(
                this.clock() + Math.min(300000, 5000 * 2 ** Math.min(attempts - 1, 6)),
              ).toISOString(),
            }
          : { endedAt: this.stamp() }),
      });
      const task = this.store.get<Owned<Schedule>>('schedule', occurrence.taskId, owner);
      if (!task) return;
      this.store.put('schedule', owner, {
        ...task,
        ...(required || unavailable ? { enabled: false } : {}),
        ...(required ? { authorization: 'required' as const } : {}),
        ...(task.lastOccurrenceId === id ? { lastStatus: status, lastError: message } : {}),
      });
      if (required || unavailable)
        this.cancelQueued(
          owner,
          task.id,
          message,
          status === 'authorization_required' ? 'authorization_required' : 'project_unavailable',
        );
    });
  }
  // Caller may use this within a larger task mutation transaction.
  cancelQueued(
    owner: string,
    taskId: string,
    reason: string,
    status: TaskOccurrence['status'] = 'cancelled',
  ) {
    for (const occurrence of this.store
      .list<Owned<TaskOccurrence>>('task-occurrence', owner)
      .filter((o) => o.taskId === taskId && o.status === 'queued'))
      this.store.put('task-occurrence', owner, {
        ...occurrence,
        status,
        error: reason,
        endedAt: this.stamp(),
      });
  }
  update(task: Owned<Schedule>, reason: string) {
    return this.transaction(() => {
      this.cancelQueued(task.ownerId, task.id, reason);
      return this.store.put('schedule', task.ownerId, task);
    });
  }
  recover() {
    this.transaction(() => {
      for (const occurrence of this.store
        .list<Owned<TaskOccurrence>>('task-occurrence')
        .filter((o) => o.status === 'running')) {
        const run =
          occurrence.runId && this.store.get<Run>('run', occurrence.runId, occurrence.ownerId);
        if (run && run.status !== 'running') this.finished(occurrence.ownerId, run);
        else {
          const error = '服务曾退出，此次执行结果未确认；不会自动重跑，请检查会话及项目文件。';
          this.store.put('task-occurrence', occurrence.ownerId, {
            ...occurrence,
            status: 'interrupted',
            endedAt: this.stamp(),
            error,
          });
          const task = this.store.get<Owned<Schedule>>(
            'schedule',
            occurrence.taskId,
            occurrence.ownerId,
          );
          if (task?.lastOccurrenceId === occurrence.id)
            this.store.put('schedule', occurrence.ownerId, {
              ...task,
              lastStatus: 'interrupted',
              lastError: error,
            });
        }
      }
      for (const task of this.store
        .list<Owned<Schedule>>('schedule')
        .filter((t) => t.lastStatus === 'running' && !t.lastOccurrenceId))
        this.store.put('schedule', task.ownerId, {
          ...task,
          lastStatus: 'interrupted',
          lastError: '旧版任务曾中断，请先检查项目与运行记录；不会自动重跑。',
        });
    });
  }
  history(owner: string, input: { taskId?: string; limit?: number; before?: string }) {
    const where = ["kind='task-occurrence'", 'owner=?'],
      params: (string | number)[] = [owner];
    if (input.taskId) {
      where.push("json_extract(data,'$.taskId')=?");
      params.push(input.taskId);
    }
    if (input.before) {
      const position = this.store.db
        .prepare("SELECT rowid FROM records WHERE kind='task-occurrence' AND owner=? AND id=?")
        .get(owner, input.before);
      if (!position) fail(400, '运行记录分页位置无效');
      where.push('rowid<?');
      params.push(Number(position.rowid));
    }
    const limit = Math.min(50, input.limit || 25);
    const rows = this.store.db
      .prepare(`SELECT data FROM records WHERE ${where.join(' AND ')} ORDER BY rowid DESC LIMIT ?`)
      .all(...params, limit + 1) as { data: string }[];
    const items = rows.slice(0, limit).map((r) => JSON.parse(r.data) as TaskOccurrence);
    return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null };
  }
}
