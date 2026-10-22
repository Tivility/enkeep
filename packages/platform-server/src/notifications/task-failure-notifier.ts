/**
 * Task failure notifications on the task's own route ("task_route" channel).
 *
 * Pure helpers used by TaskNotificationService:
 * - route resolution (payload.delivery → IM chat bound to the anchor session → in-app message),
 * - scans for failed runs and missed runs that still need a notification,
 * - the Chinese, self-contained notification text.
 *
 * @module @enkeep/platform-server/notifications
 */

import type { DatabaseSync } from 'node:sqlite';
import type { TaskNotificationEventType } from '@enkeep/platform-core';
import { resolveTaskOriginDelivery } from '@enkeep/platform-operations';

export const TASK_ROUTE_EVENTS: TaskNotificationEventType[] = ['failed', 'timeout'];
export const DEFAULT_MISSED_RUN_THRESHOLD_MS = 30 * 60 * 1000;
export const DEFAULT_FAILURE_LOOKBACK_MS = 24 * 60 * 60 * 1000;
export const TASK_ROUTE_MIGRATION_VERSION = 45;

export type TaskRouteTarget =
  | {
      kind: 'im';
      source: 'delivery' | 'anchor';
      channel: 'lark' | 'wechat';
      accountId: string;
      nativeContextId: string;
      sessionId: string | null;
    }
  | {
      kind: 'in_app';
      sessionId: string | null;
    };

export type TaskRouteNoticeKind = 'run_failure' | 'missed_run';

export interface TaskRouteTaskContext {
  id: string;
  userId: string;
  title: string;
  status: string;
  payload: Record<string, unknown>;
  scheduleType: string;
  timezone: string;
  nextRunAt: string | null;
  dueDate: string | null;
  scheduleEnabled: boolean;
  schedulePaused: boolean;
  claimCount: number;
  maxRetries: number;
}

export interface FailedRunRow {
  id: string;
  taskId: string;
  userId: string;
  status: string;
  errorCode: string | null;
  error: string | null;
  scheduledFor: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface MissedRunRow {
  taskId: string;
  userId: string;
  dueAt: string;
}

export function runRouteKey(runId: string): string {
  return `task_route:run:${runId}`;
}

export function missedRouteKey(taskId: string, dueAt: string): string {
  return `task_route:missed:${taskId}:${dueAt}`;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function toIso(value: string | null): string | null {
  if (!value) return null;
  // SQLite CURRENT_TIMESTAMP is "YYYY-MM-DD HH:MM:SS" in UTC
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Lower bound for scans: never older than the lookback window, and never before the task_route
 * migration was applied (so enabling the feature does not replay old failures).
 */
export function computeScanFloor(db: DatabaseSync, now: Date, lookbackMs: number): string {
  let floorMs = now.getTime() - lookbackMs;
  try {
    const row = db.prepare('SELECT applied_at FROM _schema_migrations WHERE version = ?').get(TASK_ROUTE_MIGRATION_VERSION) as
      | { applied_at?: string }
      | undefined;
    const appliedIso = toIso(str(row?.applied_at));
    if (appliedIso) {
      floorMs = Math.max(floorMs, Date.parse(appliedIso));
    }
  } catch {
    // Migration table missing in minimal databases: keep the lookback floor
  }
  return new Date(floorMs).toISOString();
}

export function loadTaskContext(db: DatabaseSync, taskId: string, userId: string): TaskRouteTaskContext | null {
  const row = db.prepare(`
    SELECT t.id, t.user_id, t.title, t.status, t.payload, t.schedule_type, t.timezone,
           t.next_run_at, t.due_date, t.claim_count, t.max_retries,
           s.schedule_type AS s_schedule_type, s.next_run_at AS s_next_run_at, s.timezone AS s_timezone,
           s.enabled AS s_enabled, s.paused_at AS s_paused_at
    FROM platform_tasks t
    LEFT JOIN task_schedules s ON s.task_id = t.id
    WHERE t.id = ? AND t.user_id = ?
    LIMIT 1
  `).get(taskId, userId) as Record<string, unknown> | undefined;
  if (!row) return null;

  let payload: Record<string, unknown> = {};
  if (typeof row.payload === 'string') {
    try {
      const parsed = JSON.parse(row.payload);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed;
    } catch {
      // Keep empty payload
    }
  }

  return {
    id: String(row.id),
    userId: String(row.user_id),
    title: String(row.title ?? ''),
    status: String(row.status ?? ''),
    payload,
    scheduleType: str(row.s_schedule_type) ?? str(row.schedule_type) ?? 'once',
    timezone: str(row.s_timezone) ?? str(row.timezone) ?? 'UTC',
    nextRunAt: str(row.s_next_run_at) ?? str(row.next_run_at),
    dueDate: str(row.due_date),
    scheduleEnabled: row.s_enabled === null || row.s_enabled === undefined ? true : Number(row.s_enabled) === 1,
    schedulePaused: Boolean(str(row.s_paused_at)),
    claimCount: Number(row.claim_count ?? 0),
    maxRetries: Number(row.max_retries ?? 0),
  };
}

function isActiveSession(db: DatabaseSync, userId: string, sessionId: string | null): boolean {
  if (!sessionId) return false;
  try {
    const row = db.prepare(
      'SELECT status FROM session_routes WHERE id = ? AND user_id = ? LIMIT 1'
    ).get(sessionId, userId) as { status?: string } | undefined;
    return Boolean(row) && row?.status !== 'archived';
  } catch {
    return false;
  }
}

/**
 * Accepts payload.delivery only when the account belongs to the user, is active and has a binding
 * for the chat (same checks as the success-output path of the task worker).
 */
function validateExplicitDelivery(
  db: DatabaseSync,
  userId: string,
  delivery: { channel: string; accountId: string; nativeContextId: string }
): boolean {
  try {
    const account = db.prepare(
      'SELECT status, type FROM channel_accounts WHERE id = ? AND user_id = ? LIMIT 1'
    ).get(delivery.accountId, userId) as { status?: string; type?: string } | undefined;
    if (!account || account.status !== 'active') return false;
    if (account.type && account.type !== delivery.channel) return false;

    const baseContext = delivery.nativeContextId.includes(':')
      ? delivery.nativeContextId.split(':')[0]
      : delivery.nativeContextId;
    const binding = db.prepare(`
      SELECT id FROM channel_bindings
      WHERE user_id = ? AND account_id = ? AND (native_context_id = ? OR native_context_id = ?)
      LIMIT 1
    `).get(userId, delivery.accountId, delivery.nativeContextId, baseContext);
    return Boolean(binding);
  } catch {
    return false;
  }
}

/**
 * Resolves where a failure notification of this task goes.
 * 1. payload.delivery (lark/wechat) when it is a valid route of this user;
 * 2. the lark/wechat chat bound to the anchor session (or the unique chat bound to its space);
 * 3. an in-app message in the anchor session.
 */
export function resolveTaskRouteTarget(db: DatabaseSync, task: TaskRouteTaskContext): TaskRouteTarget {
  const payload = task.payload;
  const anchorSessionId = str(payload.sessionId);
  const sessionId = isActiveSession(db, task.userId, anchorSessionId) ? anchorSessionId : null;

  const delivery = payload.delivery as Record<string, unknown> | undefined;
  if (delivery && typeof delivery === 'object') {
    const channel = str(delivery.channel);
    const accountId = str(delivery.accountId);
    const nativeContextId = str(delivery.nativeContextId);
    if (
      (channel === 'lark' || channel === 'wechat') &&
      accountId &&
      nativeContextId &&
      validateExplicitDelivery(db, task.userId, { channel, accountId, nativeContextId })
    ) {
      return { kind: 'im', source: 'delivery', channel, accountId, nativeContextId, sessionId };
    }
  }

  if (anchorSessionId) {
    const origin = resolveTaskOriginDelivery(db, task.userId, {
      sessionId: anchorSessionId,
      spaceId: str(payload.spaceId) ?? undefined,
    });
    if (origin && (origin.channel === 'lark' || origin.channel === 'wechat')) {
      return {
        kind: 'im',
        source: 'anchor',
        channel: origin.channel,
        accountId: origin.accountId,
        nativeContextId: origin.nativeContextId,
        sessionId,
      };
    }
  }

  return { kind: 'in_app', sessionId };
}

function mapRunRow(r: Record<string, unknown>): FailedRunRow {
  return {
    id: String(r.id),
    taskId: String(r.task_id),
    userId: String(r.user_id),
    status: String(r.status),
    errorCode: str(r.error_code),
    error: str(r.error),
    scheduledFor: str(r.scheduled_for),
    startedAt: str(r.started_at),
    completedAt: str(r.completed_at),
  };
}

/**
 * Failed runs that ended after `sinceIso` and have no task_route delivery yet.
 * Tasks whose task_route subscription is disabled are skipped in SQL.
 */
export function findUnnotifiedFailedRuns(db: DatabaseSync, sinceIso: string, limit = 50): FailedRunRow[] {
  const rows = db.prepare(`
    SELECT r.id, r.task_id, r.user_id, r.status, r.error_code, r.error, r.scheduled_for, r.started_at, r.completed_at
    FROM task_runs r
    JOIN users u ON u.id = r.user_id AND u.status = 'active'
    WHERE r.status IN ('failed', 'timeout', 'lease_lost')
      AND r.completed_at IS NOT NULL
      AND r.completed_at >= ?
      AND NOT EXISTS (
        SELECT 1 FROM task_notification_deliveries d WHERE d.idempotency_key = 'task_route:run:' || r.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM task_notification_subscriptions s
        WHERE s.task_id = r.task_id AND s.channel = 'task_route' AND s.enabled = 0
      )
    ORDER BY r.completed_at ASC
    LIMIT ?
  `).all(sinceIso, limit) as Array<Record<string, unknown>>;
  return rows.map(mapRunRow);
}

export function loadRun(db: DatabaseSync, runId: string, userId: string): FailedRunRow | null {
  const r = db.prepare(`
    SELECT id, task_id, user_id, status, error_code, error, scheduled_for, started_at, completed_at
    FROM task_runs WHERE id = ? AND user_id = ? LIMIT 1
  `).get(runId, userId) as Record<string, unknown> | undefined;
  return r ? mapRunRow(r) : null;
}

/**
 * Enabled, unpaused pending tasks of active users whose due time passed more than the threshold
 * ago (and is not older than the scan floor) while no run has started since.
 */
export function findMissedRuns(
  db: DatabaseSync,
  now: Date,
  thresholdMs: number,
  sinceIso: string,
  limit = 50
): MissedRunRow[] {
  const cutoffIso = new Date(now.getTime() - thresholdMs).toISOString();
  const rows = db.prepare(`
    SELECT task_id, user_id, due_at FROM (
      SELECT t.id AS task_id, t.user_id AS user_id,
             COALESCE(s.next_run_at, t.next_run_at, t.due_date) AS due_at
      FROM platform_tasks t
      JOIN users u ON u.id = t.user_id AND u.status = 'active'
      LEFT JOIN task_schedules s ON s.task_id = t.id
      WHERE t.status = 'pending'
        AND (s.enabled IS NULL OR s.enabled = 1)
        AND s.paused_at IS NULL
    ) c
    WHERE c.due_at IS NOT NULL
      AND c.due_at <= ?
      AND c.due_at >= ?
      AND NOT EXISTS (
        SELECT 1 FROM task_runs r
        WHERE r.task_id = c.task_id
          AND (
            r.status IN ('claimed', 'running')
            OR COALESCE(r.started_at, r.scheduled_for) >= c.due_at
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM task_notification_deliveries d
        WHERE d.idempotency_key = 'task_route:missed:' || c.task_id || ':' || c.due_at
      )
      AND NOT EXISTS (
        SELECT 1 FROM task_notification_subscriptions ns
        WHERE ns.task_id = c.task_id AND ns.channel = 'task_route' AND ns.enabled = 0
      )
    ORDER BY c.due_at ASC
    LIMIT ?
  `).all(cutoffIso, sinceIso, limit) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    taskId: String(r.task_id),
    userId: String(r.user_id),
    dueAt: String(r.due_at),
  }));
}

/**
 * Formats an ISO instant in the task's time zone, e.g. "2026-01-02 03:30（Asia/Shanghai）".
 */
export function formatInTimeZone(iso: string | null, timeZone: string): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const format = (tz: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(ms));
  let tz = timeZone || 'UTC';
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = format(tz);
  } catch {
    tz = 'UTC';
    parts = format(tz);
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}（${tz}）`;
}

export function classifyRunFailure(run: Pick<FailedRunRow, 'status' | 'errorCode' | 'error'>): {
  event: TaskNotificationEventType;
  explanation: string;
} {
  const code = (run.errorCode ?? '').toUpperCase();
  const err = (run.error ?? '').toLowerCase();
  if (run.status === 'timeout' || /timed out/.test(err)) {
    return {
      event: 'timeout',
      explanation: '这次运行超过了允许的最长运行时间，平台把它判定为超时并终止了，所以没有产出结果。',
    };
  }
  if (run.status === 'lease_lost' || code.includes('LEASE') || /lease expired/.test(err)) {
    return {
      event: 'timeout',
      explanation:
        '这次运行开始后，执行端长时间没有回应（可能运行太久超出了时间上限，也可能执行进程中途中断或平台重启），平台判定为超时并结束了这次运行，所以没有产出结果。',
    };
  }
  return {
    event: 'failed',
    explanation: '这次运行已经开始，但执行过程中出错，没有正常完成，所以没有产出结果。',
  };
}

function describeErrorExcerpt(run: Pick<FailedRunRow, 'errorCode' | 'error'>): string | null {
  const error = (run.error ?? '').trim();
  if (!error || error === run.errorCode) return null;
  const oneLine = error.replace(/\s+/g, ' ');
  return oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine;
}

function isRecurring(task: TaskRouteTaskContext): boolean {
  return task.scheduleType === 'cron' || task.scheduleType === 'interval';
}

function describeNextRun(task: TaskRouteTaskContext, kind: TaskRouteNoticeKind): string {
  if (!task.scheduleEnabled || task.schedulePaused) {
    return '这个任务目前已暂停，不会自动运行。';
  }
  if (kind === 'missed_run') {
    return '这次运行仍在等待调度，平台恢复调度后会尽快补跑；着急的话可以按下面的方法手动重跑。';
  }
  if (isRecurring(task)) {
    const next = formatInTimeZone(task.nextRunAt, task.timezone);
    return next ? `${next}，按原计划自动运行。` : '暂未排定下一次运行时间。';
  }
  if (task.status === 'pending') {
    const next = formatInTimeZone(task.nextRunAt ?? task.dueDate, task.timezone);
    return next ? `平台会自动重试，预计 ${next} 再次运行。` : '平台会自动重试这次任务。';
  }
  return '这是一次性任务，不会再自动运行。';
}

function describeManualRerun(task: TaskRouteTaskContext): string {
  if (!isRecurring(task) && (task.status === 'failed' || task.status === 'completed' || task.status === 'cancelled')) {
    return '一次性任务已经结束，不能直接重跑；需要的话请重新创建一个同样的任务。';
  }
  return `打开 Enkeep 网页的「任务流水」页面，找到「${task.title}」，点「立即执行」（接口：POST /api/manage/tasks/${task.id}/run）。`;
}

export interface TaskRouteMessage {
  title: string;
  text: string;
  event: TaskNotificationEventType;
}

export function buildRunFailureMessage(task: TaskRouteTaskContext, run: FailedRunRow): TaskRouteMessage {
  const { event, explanation } = classifyRunFailure(run);
  const scheduled = formatInTimeZone(run.scheduledFor ?? run.startedAt, task.timezone) ?? '未知';
  const excerpt = describeErrorExcerpt(run);
  const heading = event === 'timeout' ? '运行超时' : '运行失败';
  const lines = [
    `**定时任务「${task.title}」${heading}**`,
    '',
    `- 原定运行时间：${scheduled}`,
    `- 发生了什么：${explanation}`,
  ];
  if (excerpt) {
    lines.push(`- 错误摘要：${excerpt}`);
  }
  lines.push(`- 下次运行：${describeNextRun(task, 'run_failure')}`);
  lines.push(`- 手动重跑：${describeManualRerun(task)}`);
  lines.push('');
  const ids = [`任务 ID：${task.id}`, `运行 ID：${run.id}`];
  if (run.errorCode) ids.push(`错误码：${run.errorCode}`);
  lines.push(`（${ids.join('；')}）`);
  return { title: `定时任务${heading}：${task.title}`, text: lines.join('\n'), event };
}

export function buildMissedRunMessage(
  task: TaskRouteTaskContext,
  dueAt: string,
  now: Date
): TaskRouteMessage {
  const scheduled = formatInTimeZone(dueAt, task.timezone) ?? dueAt;
  const lateMinutes = Math.max(0, Math.floor((now.getTime() - Date.parse(dueAt)) / 60000));
  const lines = [
    `**定时任务「${task.title}」没有按时运行**`,
    '',
    `- 原定运行时间：${scheduled}`,
    `- 发生了什么：已经过了原定时间 ${lateMinutes} 分钟，这次运行还没有开始。常见原因是平台当时在忙别的任务、调度被卡住，或平台刚停过机。`,
    `- 下次运行：${describeNextRun(task, 'missed_run')}`,
    `- 手动重跑：${describeManualRerun(task)}`,
    '',
    `（任务 ID：${task.id}）`,
  ];
  return { title: `定时任务未按时运行：${task.title}`, text: lines.join('\n'), event: 'timeout' };
}
