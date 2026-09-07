import type { DatabaseSync } from 'node:sqlite';
import type {
  TenantScopedTaskRepository,
  Task,
  CreateTaskInput,
  TaskQueryOptions,
  TaskRecoveryResult,
  AgentPromptTaskPayload,
  AgentPromptDispatchResult,
  TaskSchedule,
  TaskRun,
  TaskRunQueryOptions,
  TaskRunsListResult,
  TaskScheduleType,
} from '@enkeep/platform-operations';
import {
  validateAgentPromptPayload,
  validateAgentPromptResult,
  generateTaskId,
  generateScheduleId,
  generateRunId,
  validateTaskId,
  validateRunId,
  validateIdempotencyKey,
  validateClaimantId,
  validateCanonicalDueDate,
  validateTaskTitle,
  validateTaskPriority,
  validateScheduleType,
  validateCronExpression,
  validateIntervalSeconds,
  validateMisfirePolicy,
  validateOverlapPolicy,
  computeNextRun,
  TASK_PROTOCOL_ERROR_CODES,
  TaskNotFoundError,
  TaskAlreadyClaimedError,
  TaskAlreadyCompletedError,
  TaskLeaseExpiredError,
  TaskConflictError,
  ValidationError,
  PlatformOperationsError,
} from '@enkeep/platform-operations';
import {
  parsePlatformTaskRow,
  parseTaskScheduleRow,
  parseTaskRunRow,
  queryOne,
  queryAll,
  getString,
  getNullableString,
  getNullableNumber,
  withImmediateTransactionSync,
  type DbParam,
  type DbRow,
} from '../utils/db.js';

export class SqliteTenantScopedTaskRepository implements TenantScopedTaskRepository {
  readonly userId: string;
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync, userId: string) {
    this.db = db;
    this.userId = userId;
  }

  private hasScheduleSchema(): boolean {
    try {
      this.db.prepare('SELECT schedule_type FROM platform_tasks LIMIT 0').all();
      return true;
    } catch {
      return false;
    }
  }

  private attachScheduleAndRun(task: Task | null): Task | null {
    if (!task) return null;
    if (!this.hasScheduleSchema()) return task;

    try {
      const scheduleStmt = this.db.prepare('SELECT * FROM task_schedules WHERE task_id = ? AND user_id = ?');
      const schedule = queryOne(scheduleStmt, parseTaskScheduleRow, task.id, this.userId);
      task.schedule = schedule;

      const runStmt = this.db.prepare(`
        SELECT * FROM task_runs
        WHERE task_id = ? AND user_id = ?
        ORDER BY attempt_number DESC, created_at DESC
        LIMIT 1
      `);
      const run = queryOne(runStmt, parseTaskRunRow, task.id, this.userId);
      task.currentRun = run;
    } catch {
      // Ignore if schema tables are missing
    }

    return task;
  }

  async create(input: CreateTaskInput): Promise<Task> {
    const title = validateTaskTitle(input.title);

    let id: string;
    if (input.id !== undefined) {
      id = validateTaskId(input.id);
    } else {
      id = generateTaskId();
    }

    let idempotencyKey: string | null = null;
    if (input.idempotencyKey !== undefined && input.idempotencyKey !== null) {
      idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
    }

    const priority = input.priority !== undefined && input.priority !== null
      ? validateTaskPriority(input.priority)
      : 'medium';

    const leaseDurationMs = input.leaseDurationMs || 60_000;
    const maxRetries = input.maxRetries ?? 3;

    // Validate payload against restricted agent_prompt contract (strictly required)
    if (input.payload === undefined || input.payload === null) {
      throw new ValidationError('Task payload is required and must be an agent_prompt payload');
    }
    const validatedPayload = validateAgentPromptPayload(input.payload);
    const payloadStr = JSON.stringify(validatedPayload);

    const scheduleType: TaskScheduleType = validateScheduleType(input.scheduleType);
    let cronExpression: string | null = null;
    let intervalSeconds: number | null = null;
    let normalizedDueDate: string | null = null;

    if (scheduleType === 'once') {
      if (input.dueDate !== undefined && input.dueDate !== null) {
        normalizedDueDate = validateCanonicalDueDate(input.dueDate);
      }
    } else if (scheduleType === 'cron') {
      cronExpression = validateCronExpression(input.cronExpression);
    } else if (scheduleType === 'interval') {
      intervalSeconds = validateIntervalSeconds(input.intervalSeconds);
    }

    const misfirePolicy = input.misfirePolicy ? validateMisfirePolicy(input.misfirePolicy) : 'coalesce';
    const overlapPolicy = input.overlapPolicy ? validateOverlapPolicy(input.overlapPolicy) : 'skip';
    const timezone = input.timezone ?? 'UTC';

    const now = new Date();
    const nowIso = now.toISOString();

    const nextRunAt = computeNextRun(
      {
        scheduleType,
        cronExpression,
        intervalSeconds,
        dueDate: normalizedDueDate,
        enabled: true,
      },
      now
    );

    const scheduleId = generateScheduleId();
    const hasSched = this.hasScheduleSchema();

    try {
      withImmediateTransactionSync(this.db, () => {
        if (hasSched) {
          this.db.prepare(`
            INSERT INTO platform_tasks (
              id, user_id, idempotency_key, title, description, assignee, priority,
              status, payload, lease_duration_ms, max_retries, due_date,
              schedule_type, cron_expression, interval_seconds, next_run_at, timezone,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            id,
            this.userId,
            idempotencyKey,
            title,
            input.description ?? null,
            input.assignee ?? null,
            priority,
            payloadStr,
            leaseDurationMs,
            maxRetries,
            normalizedDueDate,
            scheduleType,
            cronExpression,
            intervalSeconds,
            nextRunAt,
            timezone,
            nowIso,
            nowIso
          );

          this.db.prepare(`
            INSERT INTO task_schedules (
              id, task_id, user_id, schedule_type, cron_expression, interval_seconds,
              next_run_at, timezone, enabled, misfire_policy, overlap_policy,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
          `).run(
            scheduleId,
            id,
            this.userId,
            scheduleType,
            cronExpression,
            intervalSeconds,
            nextRunAt,
            timezone,
            misfirePolicy,
            overlapPolicy,
            nowIso,
            nowIso
          );
        } else {
          this.db.prepare(`
            INSERT INTO platform_tasks (
              id, user_id, idempotency_key, title, description, assignee, priority,
              status, payload, lease_duration_ms, max_retries, due_date,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
          `).run(
            id,
            this.userId,
            idempotencyKey,
            title,
            input.description ?? null,
            input.assignee ?? null,
            priority,
            payloadStr,
            leaseDurationMs,
            maxRetries,
            normalizedDueDate,
            nowIso,
            nowIso
          );
        }
      });
    } catch (err: unknown) {
      if (
        typeof err === 'object' &&
        err !== null &&
        'errcode' in err &&
        typeof (err as { errcode: unknown }).errcode === 'number'
      ) {
        const errcode = (err as { errcode: number }).errcode;
        // SQLite constraint error codes: 2067 (SQLITE_CONSTRAINT_UNIQUE), 1555 (SQLITE_CONSTRAINT_PRIMARYKEY), 19 (SQLITE_CONSTRAINT)
        if (errcode === 2067 || errcode === 1555 || errcode === 19) {
          throw new TaskConflictError(
            id,
            'Task with idempotency key already exists for tenant'
          );
        }
      }
      throw new PlatformOperationsError(
        'Database operation failed',
        TASK_PROTOCOL_ERROR_CODES.UNKNOWN_ERROR
      );
    }

    const created = await this.findById(id);
    if (!created) {
      throw new Error('Failed to retrieve newly created task');
    }
    return created;
  }

  async findById(id: string): Promise<Task | null> {
    const validId = validateTaskId(id);
    const stmt = this.db.prepare('SELECT * FROM platform_tasks WHERE id = ? AND user_id = ?');
    const task = queryOne(stmt, parsePlatformTaskRow, validId, this.userId);
    return this.attachScheduleAndRun(task);
  }

  async findByIdempotencyKey(key: string): Promise<Task | null> {
    const validKey = validateIdempotencyKey(key);
    const stmt = this.db.prepare('SELECT * FROM platform_tasks WHERE user_id = ? AND idempotency_key = ?');
    const task = queryOne(stmt, parsePlatformTaskRow, this.userId, validKey);
    return this.attachScheduleAndRun(task);
  }

  async claim(input: {
    claimantId: string;
    leaseDurationMs: number;
    preferredTaskId?: string;
    now?: Date | string;
  }): Promise<Task | null> {
    const claimantId = validateClaimantId(input.claimantId);
    const preferredTaskId = input.preferredTaskId !== undefined && input.preferredTaskId !== null
      ? validateTaskId(input.preferredTaskId)
      : undefined;

    const clock = input.now ? (typeof input.now === 'string' ? new Date(input.now) : input.now) : new Date();
    const nowIso = clock.toISOString();
    const leaseExpiresAt = new Date(clock.getTime() + input.leaseDurationMs).toISOString();

    const hasSched = this.hasScheduleSchema();

    return withImmediateTransactionSync(this.db, () => {
      let targetTaskId: string | null = null;

      if (preferredTaskId) {
        let row: Record<string, unknown> | undefined;
        if (hasSched) {
          row = this.db.prepare(`
            SELECT t.id, t.status, t.claimant_id, t.lease_expires_at, t.claim_count, t.max_retries,
                   t.due_date, t.schedule_type, t.cron_expression, t.interval_seconds, t.next_run_at,
                   s.enabled as schedule_enabled, s.paused_at as schedule_paused_at, s.overlap_policy
            FROM platform_tasks t
            LEFT JOIN task_schedules s ON t.id = s.task_id
            WHERE t.id = ? AND t.user_id = ?
          `).get(preferredTaskId, this.userId) as Record<string, unknown> | undefined;
        } else {
          row = this.db.prepare(`
            SELECT t.id, t.status, t.claimant_id, t.lease_expires_at, t.claim_count, t.max_retries,
                   t.due_date
            FROM platform_tasks t
            WHERE t.id = ? AND t.user_id = ?
          `).get(preferredTaskId, this.userId) as Record<string, unknown> | undefined;
        }

        if (!row) {
          throw new TaskNotFoundError(preferredTaskId);
        }

        const taskStatus = String(row.status);
        if (taskStatus === 'completed' || taskStatus === 'failed' || taskStatus === 'cancelled') {
          throw new TaskAlreadyCompletedError(preferredTaskId);
        }

        // If schedule is explicitly paused
        if (hasSched && (row.schedule_enabled === 0 || row.schedule_paused_at)) {
          return null;
        }

        // Check if lease is currently active
        const leaseExp = row.lease_expires_at ? String(row.lease_expires_at) : null;
        const isLeaseActive = leaseExp && new Date(leaseExp).getTime() > clock.getTime();

        const rowOverlapPolicy = row.overlap_policy ? validateOverlapPolicy(row.overlap_policy) : 'skip';
        if ((taskStatus === 'claimed' || taskStatus === 'running') && isLeaseActive) {
          if (hasSched && rowOverlapPolicy === 'skip') {
            return null;
          }
          throw new TaskAlreadyClaimedError(preferredTaskId, String(row.claimant_id || 'unknown'));
        }

        // Overlap policy check: if overlap_policy is 'skip', check if an active run is in progress
        if (hasSched) {
          const overlapPolicy = rowOverlapPolicy;
          if (overlapPolicy === 'skip') {
            const activeRun = this.db.prepare(`
              SELECT id FROM task_runs
              WHERE task_id = ? AND user_id = ?
                AND status IN ('claimed', 'running')
                AND lease_expires_at IS NOT NULL
                AND lease_expires_at > ?
              LIMIT 1
            `).get(preferredTaskId, this.userId, nowIso);
            if (activeRun) {
              return null; // Skip claiming due to overlap policy
            }
          }
        }

        // Check due / next_run_at eligibility
        const due = row.next_run_at ? String(row.next_run_at) : (row.due_date ? String(row.due_date) : null);
        if (due && new Date(due).getTime() > clock.getTime()) {
          return null; // Not due yet
        }

        targetTaskId = preferredTaskId;
      } else {
        // General queue: pick highest priority due task
        if (hasSched) {
          const candidate = this.db.prepare(`
            SELECT t.id, t.schedule_type, t.cron_expression, t.interval_seconds, t.next_run_at, t.due_date,
                   s.overlap_policy
            FROM platform_tasks t
            LEFT JOIN task_schedules s ON t.id = s.task_id
            WHERE t.user_id = ?
              AND (s.enabled IS NULL OR s.enabled = 1)
              AND s.paused_at IS NULL
              AND (
                (t.status = 'pending' AND (
                  (t.next_run_at IS NULL AND t.due_date IS NULL)
                  OR (t.next_run_at IS NOT NULL AND t.next_run_at <= ?)
                  OR (t.next_run_at IS NULL AND t.due_date IS NOT NULL AND t.due_date <= ?)
                ))
                OR (
                  (t.status = 'claimed' OR t.status = 'running')
                  AND t.lease_expires_at IS NOT NULL
                  AND t.lease_expires_at <= ?
                  AND t.claim_count < t.max_retries
                  AND (
                    (t.next_run_at IS NULL AND t.due_date IS NULL)
                    OR (t.next_run_at IS NOT NULL AND t.next_run_at <= ?)
                    OR (t.next_run_at IS NULL AND t.due_date IS NOT NULL AND t.due_date <= ?)
                  )
                )
              )
              AND NOT EXISTS (
                SELECT 1 FROM task_runs r
                WHERE r.task_id = t.id AND r.user_id = t.user_id
                  AND r.status IN ('claimed', 'running')
                  AND r.lease_expires_at IS NOT NULL
                  AND r.lease_expires_at > ?
                  AND COALESCE(s.overlap_policy, 'skip') = 'skip'
              )
            ORDER BY
              CASE t.priority
                WHEN 'urgent' THEN 1
                WHEN 'high' THEN 2
                WHEN 'medium' THEN 3
                WHEN 'low' THEN 4
                ELSE 5
              END ASC,
              CASE
                WHEN t.next_run_at IS NOT NULL THEN t.next_run_at
                WHEN t.due_date IS NOT NULL THEN t.due_date
                ELSE '9999-99-99T99:99:99.999Z'
              END ASC,
              t.created_at ASC
            LIMIT 1
          `).get(this.userId, nowIso, nowIso, nowIso, nowIso, nowIso, nowIso) as { id: string } | undefined;

          if (candidate) {
            targetTaskId = candidate.id;
          }
        } else {
          const candidate = this.db.prepare(`
            SELECT id FROM platform_tasks
            WHERE user_id = ?
              AND (
                (status = 'pending' AND (due_date IS NULL OR due_date <= ?))
                OR (
                  (status = 'claimed' OR status = 'running')
                  AND lease_expires_at IS NOT NULL
                  AND lease_expires_at <= ?
                  AND claim_count < max_retries
                  AND (due_date IS NULL OR due_date <= ?)
                )
              )
            ORDER BY
              CASE priority
                WHEN 'urgent' THEN 1
                WHEN 'high' THEN 2
                WHEN 'medium' THEN 3
                WHEN 'low' THEN 4
                ELSE 5
              END ASC,
              CASE WHEN due_date IS NOT NULL THEN due_date ELSE '9999-99-99T99:99:99.999Z' END ASC,
              created_at ASC
            LIMIT 1
          `).get(this.userId, nowIso, nowIso, nowIso) as { id: string } | undefined;

          if (candidate) {
            targetTaskId = candidate.id;
          }
        }
      }

      if (!targetTaskId) {
        return null;
      }

      // Fetch task and schedule details
      const taskRow = this.db.prepare('SELECT * FROM platform_tasks WHERE id = ? AND user_id = ?').get(targetTaskId, this.userId) as DbRow;

      if (hasSched) {
        const schedRow = this.db.prepare('SELECT * FROM task_schedules WHERE task_id = ? AND user_id = ?').get(targetTaskId, this.userId) as DbRow | undefined;
        const scheduleType = (getString(taskRow, 'schedule_type') as TaskScheduleType) ?? 'once';
        const scheduledFor = getNullableString(taskRow, 'next_run_at') ?? getNullableString(taskRow, 'due_date') ?? nowIso;

        // Count prior attempts to determine attempt_number
        const countRow = this.db.prepare('SELECT COUNT(*) as count FROM task_runs WHERE task_id = ? AND user_id = ?').get(targetTaskId, this.userId) as { count: number };
        const attemptNumber = (countRow ? Number(countRow.count) : 0) + 1;

        // Create new task_run row
        const runId = generateRunId();
        this.db.prepare(`
          INSERT INTO task_runs (
            id, task_id, schedule_id, user_id, attempt_number, status, claimant_id,
            lease_expires_at, scheduled_for, started_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'claimed', ?, ?, ?, ?, ?, ?)
        `).run(
          runId,
          targetTaskId,
          schedRow ? getString(schedRow, 'id') : null,
          this.userId,
          attemptNumber,
          claimantId,
          leaseExpiresAt,
          scheduledFor,
          nowIso,
          nowIso,
          nowIso
        );

        // Compute subsequent recurrence for cron/interval schedules immediately to prevent drift
        let subsequentNextRunAt: string | null = null;
        if (scheduleType === 'cron' || scheduleType === 'interval') {
          const cronExpr = getNullableString(taskRow, 'cron_expression');
          const intervalSec = getNullableNumber(taskRow, 'interval_seconds');
          subsequentNextRunAt = computeNextRun(
            {
              scheduleType,
              cronExpression: cronExpr,
              intervalSeconds: intervalSec,
              enabled: true,
            },
            clock
          );
        }

        this.db.prepare(`
          UPDATE platform_tasks
          SET status = 'claimed',
              claimant_id = ?,
              lease_expires_at = ?,
              lease_duration_ms = ?,
              claim_count = claim_count + 1,
              next_run_at = ?,
              updated_at = ?
          WHERE id = ? AND user_id = ?
        `).run(
          claimantId,
          leaseExpiresAt,
          input.leaseDurationMs,
          subsequentNextRunAt ?? getNullableString(taskRow, 'next_run_at'),
          nowIso,
          targetTaskId,
          this.userId
        );

        if (schedRow) {
          this.db.prepare(`
            UPDATE task_schedules
            SET next_run_at = ?,
                last_run_at = ?,
                updated_at = ?
            WHERE task_id = ? AND user_id = ?
          `).run(
            subsequentNextRunAt ?? getNullableString(schedRow, 'next_run_at'),
            nowIso,
            nowIso,
            targetTaskId,
            this.userId
          );
        }
      } else {
        // Legacy claim
        this.db.prepare(`
          UPDATE platform_tasks
          SET status = 'claimed',
              claimant_id = ?,
              lease_expires_at = ?,
              lease_duration_ms = ?,
              claim_count = claim_count + 1,
              updated_at = ?
          WHERE id = ? AND user_id = ?
        `).run(
          claimantId,
          leaseExpiresAt,
          input.leaseDurationMs,
          nowIso,
          targetTaskId,
          this.userId
        );
      }

      const updatedTaskRow = this.db.prepare('SELECT * FROM platform_tasks WHERE id = ? AND user_id = ?').get(targetTaskId, this.userId) as DbRow;
      const claimedTask = parsePlatformTaskRow(updatedTaskRow);
      return this.attachScheduleAndRun(claimedTask);
    });
  }

  async renewLease(id: string, claimantId: string, leaseDurationMs: number, runId?: string): Promise<Task> {
    const validId = validateTaskId(id);
    const validClaimantId = validateClaimantId(claimantId);

    const now = new Date();
    const nowIso = now.toISOString();
    const newExpiresAt = new Date(now.getTime() + leaseDurationMs).toISOString();

    const hasSched = this.hasScheduleSchema();

    return withImmediateTransactionSync(this.db, () => {
      const renewStmt = this.db.prepare(`
        UPDATE platform_tasks
        SET lease_expires_at = ?,
            lease_duration_ms = ?,
            updated_at = ?
        WHERE id = ?
          AND user_id = ?
          AND claimant_id = ?
          AND status IN ('claimed', 'running')
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at > ?
        RETURNING *
      `);

      const updatedRow = renewStmt.get(
        newExpiresAt,
        leaseDurationMs,
        nowIso,
        validId,
        this.userId,
        validClaimantId,
        nowIso
      ) as DbRow | undefined;

      if (updatedRow) {
        if (hasSched) {
          this.db.prepare(`
            UPDATE task_runs
            SET lease_expires_at = ?,
                updated_at = ?
            WHERE task_id = ? AND user_id = ?
              AND claimant_id = ?
              AND status IN ('claimed', 'running')
              AND lease_expires_at > ?
              ${runId ? 'AND id = ?' : ''}
          `).run(
            ...(runId
              ? [newExpiresAt, nowIso, validId, this.userId, validClaimantId, nowIso, runId]
              : [newExpiresAt, nowIso, validId, this.userId, validClaimantId, nowIso])
          );
        }

        const task = parsePlatformTaskRow(updatedRow);
        return this.attachScheduleAndRun(task)!;
      }

      // If changes === 0, inspect record to classify exact error
      const existing = this.db.prepare('SELECT * FROM platform_tasks WHERE id = ? AND user_id = ?').get(validId, this.userId) as DbRow | undefined;
      if (!existing) {
        throw new TaskNotFoundError(validId);
      }
      const st = String(existing.status);
      if (st === 'completed' || st === 'failed' || st === 'cancelled') {
        throw new TaskAlreadyCompletedError(validId);
      }
      if (existing.claimant_id !== validClaimantId) {
        throw new TaskAlreadyClaimedError(validId, String(existing.claimant_id || 'unknown'));
      }
      if (!existing.lease_expires_at || new Date(String(existing.lease_expires_at)).getTime() <= now.getTime()) {
        throw new TaskLeaseExpiredError(validId);
      }

      throw new TaskAlreadyClaimedError(validId, String(existing.claimant_id || 'unknown'));
    });
  }

  async complete(
    id: string,
    claimantId: string,
    result: AgentPromptDispatchResult,
    runId?: string,
    tokenUsage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number }
  ): Promise<Task> {
    const validId = validateTaskId(id);
    const validClaimantId = validateClaimantId(claimantId);
    const validatedResult = validateAgentPromptResult(result);

    const now = new Date();
    const nowIso = now.toISOString();
    const resultStr = JSON.stringify(validatedResult);
    const hasSched = this.hasScheduleSchema();

    return withImmediateTransactionSync(this.db, () => {
      const taskRow = this.db.prepare('SELECT * FROM platform_tasks WHERE id = ? AND user_id = ?').get(validId, this.userId) as DbRow | undefined;
      if (!taskRow) {
        throw new TaskNotFoundError(validId);
      }

      const scheduleType = hasSched ? ((getString(taskRow, 'schedule_type') as TaskScheduleType) ?? 'once') : 'once';
      const isRecurring = scheduleType === 'cron' || scheduleType === 'interval';

      // For once tasks: final status is completed
      // For recurring tasks: task returns to 'pending' (schedulable for next recurrence), lease is cleared
      const nextTaskStatus = isRecurring ? 'pending' : 'completed';

      const completeStmt = this.db.prepare(`
        UPDATE platform_tasks
        SET status = ?,
            result = ?,
            error = NULL,
            claimant_id = NULL,
            lease_expires_at = NULL,
            updated_at = ?,
            completed_at = ?
        WHERE id = ?
          AND user_id = ?
          AND claimant_id = ?
          AND status IN ('claimed', 'running')
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at > ?
        RETURNING *
      `);

      const updatedRow = completeStmt.get(
        nextTaskStatus,
        resultStr,
        nowIso,
        isRecurring ? null : nowIso,
        validId,
        this.userId,
        validClaimantId,
        nowIso
      ) as DbRow | undefined;

      if (updatedRow) {
        if (hasSched) {
          this.db.prepare(`
            UPDATE task_runs
            SET status = 'completed',
                completed_at = ?,
                delivery_id = ?,
                turn_id = ?,
                session_id = ?,
                prompt_tokens = ?,
                completion_tokens = ?,
                total_tokens = ?,
                updated_at = ?
            WHERE task_id = ? AND user_id = ?
              AND claimant_id = ?
              AND status IN ('claimed', 'running')
              ${runId ? 'AND id = ?' : ''}
          `).run(
            ...(runId
              ? [
                  nowIso,
                  validatedResult.messageId ?? null,
                  validatedResult.turnId ?? null,
                  validatedResult.sessionId ?? null,
                  tokenUsage?.promptTokens ?? 0,
                  tokenUsage?.completionTokens ?? 0,
                  tokenUsage?.totalTokens ?? 0,
                  nowIso,
                  validId,
                  this.userId,
                  validClaimantId,
                  runId,
                ]
              : [
                  nowIso,
                  validatedResult.messageId ?? null,
                  validatedResult.turnId ?? null,
                  validatedResult.sessionId ?? null,
                  tokenUsage?.promptTokens ?? 0,
                  tokenUsage?.completionTokens ?? 0,
                  tokenUsage?.totalTokens ?? 0,
                  nowIso,
                  validId,
                  this.userId,
                  validClaimantId,
                ])
          );
        }

        const task = parsePlatformTaskRow(updatedRow);
        return this.attachScheduleAndRun(task)!;
      }

      // Check failure cause
      const st = String(taskRow.status);
      if (st === 'completed' || st === 'failed' || st === 'cancelled') {
        throw new TaskAlreadyCompletedError(validId);
      }
      if (taskRow.claimant_id !== validClaimantId) {
        throw new TaskAlreadyClaimedError(validId, String(taskRow.claimant_id || 'unknown'));
      }
      if (!taskRow.lease_expires_at || new Date(String(taskRow.lease_expires_at)).getTime() <= now.getTime()) {
        throw new TaskLeaseExpiredError(validId);
      }

      throw new TaskAlreadyCompletedError(validId);
    });
  }

  async fail(
    id: string,
    claimantId: string,
    error: string,
    retryable?: boolean,
    runId?: string,
    errorCode?: string
  ): Promise<Task> {
    const validId = validateTaskId(id);
    const validClaimantId = validateClaimantId(claimantId);

    const now = new Date();
    const nowIso = now.toISOString();
    const isRetryableInt = retryable === false ? 0 : 1;
    const hasSched = this.hasScheduleSchema();

    return withImmediateTransactionSync(this.db, () => {
      const taskRow = this.db.prepare('SELECT * FROM platform_tasks WHERE id = ? AND user_id = ?').get(validId, this.userId) as DbRow | undefined;
      if (!taskRow) {
        throw new TaskNotFoundError(validId);
      }

      const scheduleType = hasSched ? ((getString(taskRow, 'schedule_type') as TaskScheduleType) ?? 'once') : 'once';
      const isRecurring = scheduleType === 'cron' || scheduleType === 'interval';

      const finalStatusExpr = isRecurring
        ? `'pending'`
        : `CASE WHEN (? = 0 OR claim_count >= max_retries) THEN 'failed' ELSE 'pending' END`;

      const failStmt = this.db.prepare(`
        UPDATE platform_tasks
        SET status = ${finalStatusExpr},
            claimant_id = NULL,
            lease_expires_at = NULL,
            error = ?,
            updated_at = ?,
            completed_at = CASE
              WHEN (? = 0 OR claim_count >= max_retries) AND ? = 0 THEN ?
              ELSE NULL
            END
        WHERE id = ?
          AND user_id = ?
          AND claimant_id = ?
          AND status IN ('claimed', 'running')
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at > ?
        RETURNING *
      `);

      const params = isRecurring
        ? [error, nowIso, isRetryableInt, 1, nowIso, validId, this.userId, validClaimantId, nowIso]
        : [isRetryableInt, error, nowIso, isRetryableInt, 0, nowIso, validId, this.userId, validClaimantId, nowIso];

      const updatedRow = failStmt.get(...params) as DbRow | undefined;

      if (updatedRow) {
        if (hasSched) {
          this.db.prepare(`
            UPDATE task_runs
            SET status = 'failed',
                completed_at = ?,
                error_code = ?,
                error = ?,
                updated_at = ?
            WHERE task_id = ? AND user_id = ?
              AND claimant_id = ?
              AND status IN ('claimed', 'running')
              ${runId ? 'AND id = ?' : ''}
          `).run(
            ...(runId
              ? [nowIso, errorCode ?? TASK_PROTOCOL_ERROR_CODES.EXECUTION_FAILED, error, nowIso, validId, this.userId, validClaimantId, runId]
              : [nowIso, errorCode ?? TASK_PROTOCOL_ERROR_CODES.EXECUTION_FAILED, error, nowIso, validId, this.userId, validClaimantId])
          );
        }

        const task = parsePlatformTaskRow(updatedRow);
        return this.attachScheduleAndRun(task)!;
      }

      // Check exact error
      const st = String(taskRow.status);
      if (st === 'completed' || st === 'failed' || st === 'cancelled') {
        throw new TaskAlreadyCompletedError(validId);
      }
      if (taskRow.claimant_id !== validClaimantId) {
        throw new TaskAlreadyClaimedError(validId, String(taskRow.claimant_id || 'unknown'));
      }
      if (!taskRow.lease_expires_at || new Date(String(taskRow.lease_expires_at)).getTime() <= now.getTime()) {
        throw new TaskLeaseExpiredError(validId);
      }

      throw new TaskAlreadyCompletedError(validId);
    });
  }

  async cancel(id: string): Promise<Task> {
    const validId = validateTaskId(id);
    const now = new Date().toISOString();
    const hasSched = this.hasScheduleSchema();

    return withImmediateTransactionSync(this.db, () => {
      const cancelStmt = this.db.prepare(`
        UPDATE platform_tasks
        SET status = 'cancelled',
            error = ?,
            claimant_id = NULL,
            lease_expires_at = NULL,
            updated_at = ?,
            completed_at = ?
        WHERE id = ?
          AND user_id = ?
          AND status NOT IN ('completed', 'failed', 'cancelled')
        RETURNING *
      `);

      const updatedRow = cancelStmt.get(
        TASK_PROTOCOL_ERROR_CODES.CANCELLED,
        now,
        now,
        validId,
        this.userId
      ) as DbRow | undefined;

      if (hasSched) {
        this.db.prepare(`
          UPDATE task_schedules
          SET enabled = 0,
              paused_at = ?,
              updated_at = ?
          WHERE task_id = ? AND user_id = ?
        `).run(now, now, validId, this.userId);

        this.db.prepare(`
          UPDATE task_runs
          SET status = 'cancelled',
              error_code = ?,
              error = ?,
              completed_at = ?,
              updated_at = ?
          WHERE task_id = ? AND user_id = ?
            AND status IN ('pending', 'claimed', 'running')
        `).run(TASK_PROTOCOL_ERROR_CODES.CANCELLED, TASK_PROTOCOL_ERROR_CODES.CANCELLED, now, now, validId, this.userId);
      }

      if (updatedRow) {
        const task = parsePlatformTaskRow(updatedRow);
        return this.attachScheduleAndRun(task)!;
      }

      const existing = this.db.prepare('SELECT * FROM platform_tasks WHERE id = ? AND user_id = ?').get(validId, this.userId) as DbRow | undefined;
      if (!existing) {
        throw new TaskNotFoundError(validId);
      }
      const st = String(existing.status);
      if (st === 'completed' || st === 'failed' || st === 'cancelled') {
        throw new TaskAlreadyCompletedError(validId);
      }
      const task = parsePlatformTaskRow(existing);
      return this.attachScheduleAndRun(task)!;
    });
  }

  async pause(id: string): Promise<Task> {
    const validId = validateTaskId(id);
    const now = new Date().toISOString();

    return withImmediateTransactionSync(this.db, () => {
      const taskRow = this.db.prepare('SELECT * FROM platform_tasks WHERE id = ? AND user_id = ?').get(validId, this.userId) as DbRow | undefined;
      if (!taskRow) {
        throw new TaskNotFoundError(validId);
      }

      if (this.hasScheduleSchema()) {
        this.db.prepare(`
          UPDATE task_schedules
          SET enabled = 0,
              paused_at = ?,
              updated_at = ?
          WHERE task_id = ? AND user_id = ?
        `).run(now, now, validId, this.userId);
      }

      this.db.prepare(`
        UPDATE platform_tasks
        SET updated_at = ?
        WHERE id = ? AND user_id = ?
      `).run(now, validId, this.userId);

      const refreshed = this.db.prepare('SELECT * FROM platform_tasks WHERE id = ? AND user_id = ?').get(validId, this.userId) as DbRow;
      const task = parsePlatformTaskRow(refreshed);
      return this.attachScheduleAndRun(task)!;
    });
  }

  async resume(id: string, now?: Date | string): Promise<Task> {
    const validId = validateTaskId(id);
    const clock = now ? (typeof now === 'string' ? new Date(now) : now) : new Date();
    const nowIso = clock.toISOString();

    return withImmediateTransactionSync(this.db, () => {
      const taskRow = this.db.prepare('SELECT * FROM platform_tasks WHERE id = ? AND user_id = ?').get(validId, this.userId) as DbRow | undefined;
      if (!taskRow) {
        throw new TaskNotFoundError(validId);
      }

      if (this.hasScheduleSchema()) {
        const scheduleType = (getString(taskRow, 'schedule_type') as TaskScheduleType) ?? 'once';
        const cronExpr = getNullableString(taskRow, 'cron_expression');
        const intervalSec = getNullableNumber(taskRow, 'interval_seconds');
        const dueDate = getNullableString(taskRow, 'due_date');

        const nextRunAt = computeNextRun(
          {
            scheduleType,
            cronExpression: cronExpr,
            intervalSeconds: intervalSec,
            dueDate,
            enabled: true,
          },
          clock
        );

        this.db.prepare(`
          UPDATE task_schedules
          SET enabled = 1,
              paused_at = NULL,
              next_run_at = ?,
              updated_at = ?
          WHERE task_id = ? AND user_id = ?
        `).run(nextRunAt, nowIso, validId, this.userId);

        this.db.prepare(`
          UPDATE platform_tasks
          SET next_run_at = ?,
              updated_at = ?
          WHERE id = ? AND user_id = ?
        `).run(nextRunAt, nowIso, validId, this.userId);
      }

      const refreshed = this.db.prepare('SELECT * FROM platform_tasks WHERE id = ? AND user_id = ?').get(validId, this.userId) as DbRow;
      const task = parsePlatformTaskRow(refreshed);
      return this.attachScheduleAndRun(task)!;
    });
  }

  async recoverExpiredLeases(nowIso?: string): Promise<TaskRecoveryResult> {
    const currentTime = nowIso ?? new Date().toISOString();
    const hasSched = this.hasScheduleSchema();

    return withImmediateTransactionSync(this.db, () => {
      const recoverStmt = this.db.prepare(`
        UPDATE platform_tasks
        SET status = CASE
              WHEN claim_count >= max_retries THEN 'failed'
              ELSE 'pending'
            END,
            claimant_id = CASE
              WHEN claim_count >= max_retries THEN claimant_id
              ELSE NULL
            END,
            lease_expires_at = NULL,
            updated_at = ?,
            completed_at = CASE
              WHEN claim_count >= max_retries THEN ?
              ELSE NULL
            END,
            error = CASE
              WHEN claim_count >= max_retries THEN 'Task lease expired: max retries exhausted'
              ELSE error
            END
        WHERE user_id = ?
          AND (status = 'claimed' OR status = 'running')
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= ?
        RETURNING id
      `);

      const rows = recoverStmt.all(currentTime, currentTime, this.userId, currentTime) as { id: string }[];
      const taskIds = rows.map((r) => r.id);

      if (hasSched) {
        this.db.prepare(`
          UPDATE task_runs
          SET status = 'failed',
              error_code = ?,
              error = 'Execution lease expired',
              completed_at = ?,
              updated_at = ?
          WHERE user_id = ?
            AND status IN ('claimed', 'running')
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at <= ?
        `).run(TASK_PROTOCOL_ERROR_CODES.LEASE_EXPIRED, currentTime, currentTime, this.userId, currentTime);
      }

      return {
        recoveredCount: taskIds.length,
        taskIds,
        retriedIds: taskIds,
        failedIds: [],
      };
    });
  }

  async list(options?: TaskQueryOptions): Promise<Task[]> {
    let sql = 'SELECT * FROM platform_tasks WHERE user_id = ?';
    const params: DbParam[] = [this.userId];

    if (options?.status) {
      const statuses = Array.isArray(options.status) ? options.status : [options.status];
      sql += ` AND status IN (${statuses.map(() => '?').join(', ')})`;
      params.push(...statuses);
    }
    if (options?.assignee) {
      sql += ' AND assignee = ?';
      params.push(options.assignee);
    }
    if (options?.priority) {
      sql += ' AND priority = ?';
      params.push(options.priority);
    }
    if (options?.scheduleType && this.hasScheduleSchema()) {
      sql += ' AND schedule_type = ?';
      params.push(options.scheduleType);
    }

    sql += ' ORDER BY created_at DESC';

    if (options?.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(options.limit);
      if (options?.offset !== undefined) {
        sql += ' OFFSET ?';
        params.push(options.offset);
      }
    }

    const stmt = this.db.prepare(sql);
    const tasks = queryAll(stmt, parsePlatformTaskRow, ...params);
    return tasks.map((t) => this.attachScheduleAndRun(t)!);
  }

  async getSchedule(taskId: string): Promise<TaskSchedule | null> {
    if (!this.hasScheduleSchema()) return null;
    const validTaskId = validateTaskId(taskId);
    const stmt = this.db.prepare('SELECT * FROM task_schedules WHERE task_id = ? AND user_id = ?');
    return queryOne(stmt, parseTaskScheduleRow, validTaskId, this.userId);
  }

  async listRuns(taskId: string, options?: TaskRunQueryOptions): Promise<TaskRunsListResult> {
    if (!this.hasScheduleSchema()) {
      return { items: [], total: 0, limit: options?.limit ?? 50, offset: options?.offset ?? 0 };
    }
    const validTaskId = validateTaskId(taskId);
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    let countSql = 'SELECT COUNT(*) as total FROM task_runs WHERE task_id = ? AND user_id = ?';
    const countParams: DbParam[] = [validTaskId, this.userId];

    let listSql = 'SELECT * FROM task_runs WHERE task_id = ? AND user_id = ?';
    const listParams: DbParam[] = [validTaskId, this.userId];

    if (options?.status) {
      const statuses = Array.isArray(options.status) ? options.status : [options.status];
      const placeholders = statuses.map(() => '?').join(', ');
      countSql += ` AND status IN (${placeholders})`;
      countParams.push(...statuses);
      listSql += ` AND status IN (${placeholders})`;
      listParams.push(...statuses);
    }

    listSql += ' ORDER BY attempt_number DESC, created_at DESC LIMIT ? OFFSET ?';
    listParams.push(limit, offset);

    const countRow = this.db.prepare(countSql).get(...countParams) as { total: number } | undefined;
    const total = countRow ? Number(countRow.total) : 0;

    const listStmt = this.db.prepare(listSql);
    const items = queryAll(listStmt, parseTaskRunRow, ...listParams);

    return {
      items,
      total,
      limit,
      offset,
    };
  }

  async getRun(runId: string): Promise<TaskRun | null> {
    if (!this.hasScheduleSchema()) return null;
    const validRunId = validateRunId(runId);
    const stmt = this.db.prepare('SELECT * FROM task_runs WHERE id = ? AND user_id = ?');
    return queryOne(stmt, parseTaskRunRow, validRunId, this.userId);
  }

  async createManualRun(
    taskId: string,
    claimantId: string = 'manual_trigger',
    leaseDurationMs: number = 60_000,
    now?: Date | string
  ): Promise<{ task: Task; run: TaskRun }> {
    const validTaskId = validateTaskId(taskId);
    const clock = now ? (typeof now === 'string' ? new Date(now) : now) : new Date();
    const nowIso = clock.toISOString();
    const leaseExpiresAt = new Date(clock.getTime() + leaseDurationMs).toISOString();

    return withImmediateTransactionSync(this.db, () => {
      const taskRow = this.db.prepare('SELECT * FROM platform_tasks WHERE id = ? AND user_id = ?').get(validTaskId, this.userId) as DbRow | undefined;
      if (!taskRow) {
        throw new TaskNotFoundError(validTaskId);
      }

      const hasSched = this.hasScheduleSchema();
      let schedRow: DbRow | undefined;
      let attemptNumber = 1;
      const runId = generateRunId();

      if (hasSched) {
        schedRow = this.db.prepare('SELECT * FROM task_schedules WHERE task_id = ? AND user_id = ?').get(validTaskId, this.userId) as DbRow | undefined;
        const countRow = this.db.prepare('SELECT COUNT(*) as count FROM task_runs WHERE task_id = ? AND user_id = ?').get(validTaskId, this.userId) as { count: number };
        attemptNumber = (countRow ? Number(countRow.count) : 0) + 1;

        this.db.prepare(`
          INSERT INTO task_runs (
            id, task_id, schedule_id, user_id, attempt_number, status, claimant_id,
            lease_expires_at, scheduled_for, started_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'claimed', ?, ?, ?, ?, ?, ?)
        `).run(
          runId,
          validTaskId,
          schedRow ? getString(schedRow, 'id') : null,
          this.userId,
          attemptNumber,
          claimantId,
          leaseExpiresAt,
          nowIso,
          nowIso,
          nowIso,
          nowIso
        );
      }

      this.db.prepare(`
        UPDATE platform_tasks
        SET status = 'claimed',
            claimant_id = ?,
            lease_expires_at = ?,
            lease_duration_ms = ?,
            claim_count = claim_count + 1,
            updated_at = ?
        WHERE id = ? AND user_id = ?
      `).run(claimantId, leaseExpiresAt, leaseDurationMs, nowIso, validTaskId, this.userId);

      const refreshedTaskRow = this.db.prepare('SELECT * FROM platform_tasks WHERE id = ? AND user_id = ?').get(validTaskId, this.userId) as DbRow;
      const task = parsePlatformTaskRow(refreshedTaskRow);

      let run: TaskRun;
      if (hasSched) {
        const refreshedRunRow = this.db.prepare('SELECT * FROM task_runs WHERE id = ? AND user_id = ?').get(runId, this.userId) as DbRow;
        run = parseTaskRunRow(refreshedRunRow);
      } else {
        run = {
          id: runId,
          taskId: validTaskId,
          userId: this.userId,
          attemptNumber: 1,
          status: 'claimed',
          claimantId,
          leaseExpiresAt,
          scheduledFor: nowIso,
          startedAt: nowIso,
          completedAt: null,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          createdAt: nowIso,
          updatedAt: nowIso,
        };
      }

      return {
        task: this.attachScheduleAndRun(task)!,
        run,
      };
    });
  }
}
