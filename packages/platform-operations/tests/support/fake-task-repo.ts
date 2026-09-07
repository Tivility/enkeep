import type {
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
} from '../../src/types/task.js';
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
  TASK_PROTOCOL_ERROR_CODES,
} from '../../src/types/task.js';
import {
  validateScheduleType,
  validateCronExpression,
  validateIntervalSeconds,
  validateMisfirePolicy,
  validateOverlapPolicy,
  computeNextRun,
} from '../../src/tasks/schedule-calculator.js';
import type { TenantScopedTaskRepository } from '../../src/ports/task-port.js';
import {
  TaskNotFoundError,
  TaskAlreadyClaimedError,
  TaskAlreadyCompletedError,
  TaskLeaseExpiredError,
  TaskConflictError,
  ValidationError,
} from '../../src/errors/index.js';

export class FakeTenantScopedTaskRepository implements TenantScopedTaskRepository {
  readonly userId: string;
  private readonly tasks = new Map<string, Task>();
  private readonly schedules = new Map<string, TaskSchedule>();
  private readonly runs = new Map<string, TaskRun>();

  constructor(userId: string) {
    this.userId = userId;
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
      for (const t of this.tasks.values()) {
        if (t.userId === this.userId && t.idempotencyKey === idempotencyKey) {
          throw new TaskConflictError(
            id,
            'Task with idempotency key already exists for tenant'
          );
        }
      }
    }

    // Validate payload against restricted agent_prompt contract (strictly required)
    if (input.payload === undefined || input.payload === null) {
      throw new ValidationError('Task payload is required and must be an agent_prompt payload');
    }
    const validatedPayload = validateAgentPromptPayload(input.payload);

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

    const priority = input.priority !== undefined && input.priority !== null
      ? validateTaskPriority(input.priority)
      : 'medium';

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

    const schedule: TaskSchedule = {
      id: generateScheduleId(),
      taskId: id,
      userId: this.userId,
      scheduleType,
      cronExpression,
      intervalSeconds,
      nextRunAt,
      lastRunAt: null,
      timezone: input.timezone ?? 'UTC',
      enabled: true,
      pausedAt: null,
      misfirePolicy: input.misfirePolicy ? validateMisfirePolicy(input.misfirePolicy) : 'coalesce',
      overlapPolicy: input.overlapPolicy ? validateOverlapPolicy(input.overlapPolicy) : 'skip',
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    const task: Task = {
      id,
      userId: this.userId,
      idempotencyKey,
      title,
      description: typeof input.description === 'string' ? input.description : null,
      assignee: typeof input.assignee === 'string' ? input.assignee : null,
      priority,
      status: 'pending',
      payload: validatedPayload ? JSON.parse(JSON.stringify(validatedPayload)) : null,
      result: null,
      error: null,
      claimantId: null,
      leaseExpiresAt: null,
      leaseDurationMs: input.leaseDurationMs || 60_000,
      claimCount: 0,
      maxRetries: input.maxRetries ?? 3,
      dueDate: normalizedDueDate,
      scheduleType,
      cronExpression,
      intervalSeconds,
      nextRunAt,
      timezone: input.timezone ?? 'UTC',
      schedule,
      createdAt: nowIso,
      updatedAt: nowIso,
      completedAt: null,
    };

    this.tasks.set(id, task);
    this.schedules.set(id, schedule);
    return { ...task };
  }

  async findById(id: string): Promise<Task | null> {
    const validId = validateTaskId(id);
    const t = this.tasks.get(validId);
    if (!t || t.userId !== this.userId) return null;
    t.schedule = this.schedules.get(validId) ?? null;
    return { ...t };
  }

  async findByIdempotencyKey(key: string): Promise<Task | null> {
    const validKey = validateIdempotencyKey(key);
    for (const t of this.tasks.values()) {
      if (t.userId === this.userId && t.idempotencyKey === validKey) {
        t.schedule = this.schedules.get(t.id) ?? null;
        return { ...t };
      }
    }
    return null;
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

    if (preferredTaskId) {
      const preferred = this.tasks.get(preferredTaskId);
      if (!preferred || preferred.userId !== this.userId) {
        throw new TaskNotFoundError(preferredTaskId);
      }
      if (preferred.status === 'completed' || preferred.status === 'failed' || preferred.status === 'cancelled') {
        throw new TaskAlreadyCompletedError(preferredTaskId);
      }

      const schedule = this.schedules.get(preferredTaskId);
      if (schedule && (!schedule.enabled || schedule.pausedAt)) {
        return null;
      }

      if (preferred.status === 'claimed' || preferred.status === 'running') {
        if (preferred.leaseExpiresAt && new Date(preferred.leaseExpiresAt).getTime() > clock.getTime()) {
          throw new TaskAlreadyClaimedError(preferredTaskId, preferred.claimantId || 'unknown');
        }
      }

      const due = preferred.nextRunAt ?? preferred.dueDate;
      if (due && new Date(due).getTime() > clock.getTime()) {
        return null;
      }

      const runId = generateRunId();
      const priorRuns = Array.from(this.runs.values()).filter((r) => r.taskId === preferred.id);
      const run: TaskRun = {
        id: runId,
        taskId: preferred.id,
        scheduleId: schedule?.id ?? null,
        userId: this.userId,
        attemptNumber: priorRuns.length + 1,
        status: 'claimed',
        claimantId,
        leaseExpiresAt,
        scheduledFor: due ?? nowIso,
        startedAt: nowIso,
        completedAt: null,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      this.runs.set(runId, run);

      let subsequentNextRunAt: string | null = null;
      if (preferred.scheduleType === 'cron' || preferred.scheduleType === 'interval') {
        subsequentNextRunAt = computeNextRun(
          {
            scheduleType: preferred.scheduleType,
            cronExpression: preferred.cronExpression,
            intervalSeconds: preferred.intervalSeconds,
            enabled: true,
          },
          clock
        );
      }

      if (schedule) {
        schedule.nextRunAt = subsequentNextRunAt ?? schedule.nextRunAt;
        schedule.lastRunAt = nowIso;
        schedule.updatedAt = nowIso;
      }

      const updated: Task = {
        ...preferred,
        status: 'claimed',
        claimantId,
        leaseExpiresAt,
        leaseDurationMs: input.leaseDurationMs,
        claimCount: preferred.claimCount + 1,
        nextRunAt: subsequentNextRunAt ?? preferred.nextRunAt,
        currentRun: run,
        schedule,
        updatedAt: nowIso,
      };
      this.tasks.set(preferred.id, updated);
      return { ...updated };
    }

    const priorityWeights: Record<string, number> = {
      urgent: 4,
      high: 3,
      medium: 2,
      low: 1,
    };

    const candidates = Array.from(this.tasks.values())
      .filter((t) => {
        if (t.userId !== this.userId) return false;
        const schedule = this.schedules.get(t.id);
        if (schedule && (!schedule.enabled || schedule.pausedAt)) return false;

        const due = t.nextRunAt ?? t.dueDate;
        if (due && new Date(due).getTime() > clock.getTime()) return false;

        if (t.status === 'pending') return true;
        if (t.status === 'claimed' || t.status === 'running') {
          if (t.leaseExpiresAt && new Date(t.leaseExpiresAt).getTime() <= clock.getTime()) {
            return t.claimCount < t.maxRetries;
          }
        }
        return false;
      })
      .sort((a, b) => {
        const pDiff = (priorityWeights[b.priority] || 2) - (priorityWeights[a.priority] || 2);
        if (pDiff !== 0) return pDiff;
        const dueA = a.nextRunAt ?? a.dueDate;
        const dueB = b.nextRunAt ?? b.dueDate;
        if (dueA && dueB) {
          const dDiff = new Date(dueA).getTime() - new Date(dueB).getTime();
          if (dDiff !== 0) return dDiff;
        } else if (dueA && !dueB) {
          return -1;
        } else if (!dueA && dueB) {
          return 1;
        }
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      });

    if (candidates.length === 0) return null;

    const chosen = candidates[0];
    return this.claim({
      claimantId,
      leaseDurationMs: input.leaseDurationMs,
      preferredTaskId: chosen.id,
      now: input.now,
    });
  }

  async renewLease(id: string, claimantId: string, leaseDurationMs: number, runId?: string): Promise<Task> {
    const validId = validateTaskId(id);
    const validClaimantId = validateClaimantId(claimantId);

    const existing = this.tasks.get(validId);
    if (!existing || existing.userId !== this.userId) {
      throw new TaskNotFoundError(validId);
    }
    if (existing.status === 'completed' || existing.status === 'failed' || existing.status === 'cancelled') {
      throw new TaskAlreadyCompletedError(validId);
    }
    if (existing.claimantId !== validClaimantId) {
      throw new TaskAlreadyClaimedError(validId, existing.claimantId || 'unknown');
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const newExpiresAt = new Date(now.getTime() + leaseDurationMs).toISOString();

    if (!existing.leaseExpiresAt || new Date(existing.leaseExpiresAt).getTime() <= now.getTime()) {
      throw new TaskLeaseExpiredError(validId);
    }

    if (runId && this.runs.has(runId)) {
      const r = this.runs.get(runId)!;
      r.leaseExpiresAt = newExpiresAt;
      r.updatedAt = nowIso;
    }

    const updated: Task = {
      ...existing,
      leaseExpiresAt: newExpiresAt,
      leaseDurationMs,
      updatedAt: nowIso,
    };
    this.tasks.set(validId, updated);
    return { ...updated };
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

    const existing = this.tasks.get(validId);
    if (!existing || existing.userId !== this.userId) {
      throw new TaskNotFoundError(validId);
    }
    if (existing.status === 'completed' || existing.status === 'failed' || existing.status === 'cancelled') {
      throw new TaskAlreadyCompletedError(validId);
    }
    if (existing.claimantId !== validClaimantId) {
      throw new TaskAlreadyClaimedError(validId, existing.claimantId || 'unknown');
    }

    const now = new Date();
    const nowIso = now.toISOString();

    if (!existing.leaseExpiresAt || new Date(existing.leaseExpiresAt).getTime() <= now.getTime()) {
      throw new TaskLeaseExpiredError(validId);
    }

    const isRecurring = existing.scheduleType === 'cron' || existing.scheduleType === 'interval';

    if (runId && this.runs.has(runId)) {
      const r = this.runs.get(runId)!;
      r.status = 'completed';
      r.completedAt = nowIso;
      r.turnId = validatedResult.turnId ?? null;
      r.deliveryId = validatedResult.messageId ?? null;
      r.sessionId = validatedResult.sessionId ?? null;
      r.promptTokens = tokenUsage?.promptTokens ?? 0;
      r.completionTokens = tokenUsage?.completionTokens ?? 0;
      r.totalTokens = tokenUsage?.totalTokens ?? 0;
      r.updatedAt = nowIso;
    }

    const updated: Task = {
      ...existing,
      status: isRecurring ? 'pending' : 'completed',
      result: validatedResult,
      claimantId: null,
      leaseExpiresAt: null,
      error: null,
      updatedAt: nowIso,
      completedAt: isRecurring ? null : nowIso,
    };

    this.tasks.set(validId, updated);
    return { ...updated };
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

    const existing = this.tasks.get(validId);
    if (!existing || existing.userId !== this.userId) {
      throw new TaskNotFoundError(validId);
    }
    if (existing.status === 'completed' || existing.status === 'failed' || existing.status === 'cancelled') {
      throw new TaskAlreadyCompletedError(validId);
    }
    if (existing.claimantId !== validClaimantId) {
      throw new TaskAlreadyClaimedError(validId, existing.claimantId || 'unknown');
    }

    const now = new Date();
    const nowIso = now.toISOString();

    if (!existing.leaseExpiresAt || new Date(existing.leaseExpiresAt).getTime() <= now.getTime()) {
      throw new TaskLeaseExpiredError(validId);
    }

    const isRecurring = existing.scheduleType === 'cron' || existing.scheduleType === 'interval';
    const shouldFailPermanently = !isRecurring && (retryable === false || existing.claimCount >= existing.maxRetries);

    if (runId && this.runs.has(runId)) {
      const r = this.runs.get(runId)!;
      r.status = 'failed';
      r.errorCode = errorCode ?? TASK_PROTOCOL_ERROR_CODES.EXECUTION_FAILED;
      r.error = error;
      r.completedAt = nowIso;
      r.updatedAt = nowIso;
    }

    const updated: Task = {
      ...existing,
      status: isRecurring ? 'pending' : (shouldFailPermanently ? 'failed' : 'pending'),
      claimantId: null,
      leaseExpiresAt: null,
      error,
      updatedAt: nowIso,
      completedAt: shouldFailPermanently ? nowIso : null,
    };

    this.tasks.set(validId, updated);
    return { ...updated };
  }

  async cancel(id: string): Promise<Task> {
    const validId = validateTaskId(id);

    const existing = this.tasks.get(validId);
    if (!existing || existing.userId !== this.userId) {
      throw new TaskNotFoundError(validId);
    }
    if (existing.status === 'completed' || existing.status === 'failed' || existing.status === 'cancelled') {
      throw new TaskAlreadyCompletedError(validId);
    }

    const now = new Date().toISOString();
    const schedule = this.schedules.get(validId);
    if (schedule) {
      schedule.enabled = false;
      schedule.pausedAt = now;
      schedule.updatedAt = now;
    }

    const updated: Task = {
      ...existing,
      status: 'cancelled',
      error: TASK_PROTOCOL_ERROR_CODES.CANCELLED,
      claimantId: null,
      leaseExpiresAt: null,
      schedule,
      updatedAt: now,
      completedAt: now,
    };

    this.tasks.set(validId, updated);
    return { ...updated };
  }

  async pause(id: string): Promise<Task> {
    const validId = validateTaskId(id);
    const existing = this.tasks.get(validId);
    if (!existing || existing.userId !== this.userId) {
      throw new TaskNotFoundError(validId);
    }
    const now = new Date().toISOString();
    const schedule = this.schedules.get(validId);
    if (schedule) {
      schedule.enabled = false;
      schedule.pausedAt = now;
      schedule.updatedAt = now;
    }
    existing.schedule = schedule;
    existing.updatedAt = now;
    return { ...existing };
  }

  async resume(id: string, now?: Date | string): Promise<Task> {
    const validId = validateTaskId(id);
    const existing = this.tasks.get(validId);
    if (!existing || existing.userId !== this.userId) {
      throw new TaskNotFoundError(validId);
    }
    const clock = now ? (typeof now === 'string' ? new Date(now) : now) : new Date();
    const nowIso = clock.toISOString();
    const schedule = this.schedules.get(validId);
    if (schedule) {
      schedule.enabled = true;
      schedule.pausedAt = null;
      schedule.nextRunAt = computeNextRun(
        {
          scheduleType: schedule.scheduleType,
          cronExpression: schedule.cronExpression,
          intervalSeconds: schedule.intervalSeconds,
          dueDate: existing.dueDate,
          enabled: true,
        },
        clock
      );
      schedule.updatedAt = nowIso;
      existing.nextRunAt = schedule.nextRunAt;
    }
    existing.schedule = schedule;
    existing.updatedAt = nowIso;
    return { ...existing };
  }

  async recoverExpiredLeases(nowIso?: string): Promise<TaskRecoveryResult> {
    const currentTime = nowIso ? new Date(nowIso).getTime() : Date.now();
    const taskIds: string[] = [];

    for (const [id, task] of this.tasks.entries()) {
      if (task.userId !== this.userId) continue;

      if ((task.status === 'claimed' || task.status === 'running') && task.leaseExpiresAt) {
        if (new Date(task.leaseExpiresAt).getTime() <= currentTime) {
          taskIds.push(id);
          if (task.claimCount >= task.maxRetries) {
            this.tasks.set(id, {
              ...task,
              status: 'failed',
              error: 'Task lease expired: max retries exhausted',
              claimantId: null,
              leaseExpiresAt: null,
              updatedAt: new Date(currentTime).toISOString(),
              completedAt: new Date(currentTime).toISOString(),
            });
          } else {
            this.tasks.set(id, {
              ...task,
              status: 'pending',
              claimantId: null,
              leaseExpiresAt: null,
              updatedAt: new Date(currentTime).toISOString(),
            });
          }
        }
      }
    }

    return {
      recoveredCount: taskIds.length,
      taskIds,
      retriedIds: taskIds,
      failedIds: [],
    };
  }

  async list(options?: TaskQueryOptions): Promise<Task[]> {
    let result = Array.from(this.tasks.values()).filter((t) => t.userId === this.userId);

    if (options?.status) {
      const statuses = Array.isArray(options.status) ? options.status : [options.status];
      result = result.filter((t) => statuses.includes(t.status));
    }
    if (options?.assignee) {
      result = result.filter((t) => t.assignee === options.assignee);
    }
    if (options?.priority) {
      result = result.filter((t) => t.priority === options.priority);
    }

    result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? result.length;
    return result.slice(offset, offset + limit).map((t) => {
      t.schedule = this.schedules.get(t.id) ?? null;
      return { ...t };
    });
  }

  async getSchedule(taskId: string): Promise<TaskSchedule | null> {
    const validTaskId = validateTaskId(taskId);
    return this.schedules.get(validTaskId) ?? null;
  }

  async listRuns(taskId: string, options?: TaskRunQueryOptions): Promise<TaskRunsListResult> {
    const validTaskId = validateTaskId(taskId);
    let items = Array.from(this.runs.values()).filter((r) => r.taskId === validTaskId && r.userId === this.userId);
    if (options?.status) {
      const statuses = Array.isArray(options.status) ? options.status : [options.status];
      items = items.filter((r) => statuses.includes(r.status));
    }
    items.sort((a, b) => b.attemptNumber - a.attemptNumber);
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;
    return {
      items: items.slice(offset, offset + limit),
      total: items.length,
      limit,
      offset,
    };
  }

  async getRun(runId: string): Promise<TaskRun | null> {
    const validRunId = validateRunId(runId);
    return this.runs.get(validRunId) ?? null;
  }

  async createManualRun(
    taskId: string,
    claimantId: string = 'manual_trigger',
    leaseDurationMs: number = 60_000,
    now?: Date | string
  ): Promise<{ task: Task; run: TaskRun }> {
    const validTaskId = validateTaskId(taskId);
    const existing = this.tasks.get(validTaskId);
    if (!existing || existing.userId !== this.userId) {
      throw new TaskNotFoundError(validTaskId);
    }
    const clock = now ? (typeof now === 'string' ? new Date(now) : now) : new Date();
    const nowIso = clock.toISOString();
    const leaseExpiresAt = new Date(clock.getTime() + leaseDurationMs).toISOString();

    const priorRuns = Array.from(this.runs.values()).filter((r) => r.taskId === validTaskId);
    const runId = generateRunId();
    const run: TaskRun = {
      id: runId,
      taskId: validTaskId,
      scheduleId: this.schedules.get(validTaskId)?.id ?? null,
      userId: this.userId,
      attemptNumber: priorRuns.length + 1,
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
    this.runs.set(runId, run);

    existing.status = 'claimed';
    existing.claimantId = claimantId;
    existing.leaseExpiresAt = leaseExpiresAt;
    existing.leaseDurationMs = leaseDurationMs;
    existing.claimCount += 1;
    existing.currentRun = run;
    existing.updatedAt = nowIso;

    return {
      task: { ...existing },
      run,
    };
  }
}
