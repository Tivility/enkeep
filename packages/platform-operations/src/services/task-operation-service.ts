import type {
  Task,
  CreateTaskInput,
  ClaimTaskInput,
  RenewLeaseInput,
  CompleteTaskInput,
  FailTaskInput,
  CancelTaskInput,
  TaskQueryOptions,
  TaskRecoveryResult,
  AgentPromptTaskPayload,
  AgentPromptDispatchResult,
  TaskSchedule,
  TaskRun,
  TaskRunQueryOptions,
  TaskRunsListResult,
  TaskScheduleType,
} from '../types/task.js';
import {
  validateTaskId,
  validateRunId,
  validateIdempotencyKey,
  validateClaimantId,
  validateCanonicalDueDate,
  validateTaskTitle,
  validateTaskPriority,
  validateAgentPromptPayload,
  validateAgentPromptResult,
  generateTaskId,
  TASK_PROTOCOL_ERROR_CODES,
} from '../types/task.js';
import {
  validateScheduleType,
  validateCronExpression,
  validateIntervalSeconds,
  validateMisfirePolicy,
  validateOverlapPolicy,
} from '../tasks/schedule-calculator.js';
import { ValidationError } from '../errors/index.js';
import type { TenantScopedTaskRepository } from '../ports/task-port.js';
import type { OperationsAuditPort } from '../ports/audit-port.js';

export const DEFAULT_LEASE_DURATION_MS = 60_000; // 60s
export const DEFAULT_MAX_RETRIES = 3;

export interface TaskOperationServiceOptions {
  tasks: TenantScopedTaskRepository;
  auditLogs?: OperationsAuditPort;
  defaultLeaseDurationMs?: number;
  defaultMaxRetries?: number;
}

export class TaskOperationService {
  private readonly tasks: TenantScopedTaskRepository;
  private readonly auditLogs?: OperationsAuditPort;
  private readonly defaultLeaseDurationMs: number;
  private readonly defaultMaxRetries: number;

  constructor(options: TaskOperationServiceOptions) {
    this.tasks = options.tasks;
    this.auditLogs = options.auditLogs;
    this.defaultLeaseDurationMs = options.defaultLeaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.defaultMaxRetries = options.defaultMaxRetries ?? DEFAULT_MAX_RETRIES;
  }

  get userId(): string {
    return this.tasks.userId;
  }

  /**
   * Create a persistent once/cron/interval task with idempotency.
   * If an idempotencyKey is supplied and a task with this key already exists,
   * returns the existing task without duplicate execution.
   */
  async createTask(input: CreateTaskInput): Promise<{ task: Task; isIdempotentHit: boolean }> {
    const title = validateTaskTitle(input.title);

    // Validate payload against restricted agent_prompt contract (strictly required)
    if (input.payload === undefined || input.payload === null) {
      throw new ValidationError('Task payload is required and must be an agent_prompt payload');
    }
    const validatedPayload = validateAgentPromptPayload(input.payload);

    // Validate description if provided
    let description: string | undefined;
    if (input.description !== undefined && input.description !== null) {
      if (typeof input.description !== 'string') {
        throw new ValidationError('Task description must be a string');
      }
      description = input.description;
    }

    // Validate assignee if provided
    let assignee: string | undefined;
    if (input.assignee !== undefined && input.assignee !== null) {
      if (typeof input.assignee !== 'string') {
        throw new ValidationError('Task assignee must be a string');
      }
      assignee = input.assignee;
    }

    // Validate schedule type and specific fields
    const scheduleType: TaskScheduleType = validateScheduleType(input.scheduleType);

    let cronExpression: string | undefined;
    let intervalSeconds: number | undefined;
    let normalizedDueDate: string | undefined;

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

    // 1. Check idempotency key if provided (strict canonical check)
    let idempotencyKey: string | undefined;
    if (input.idempotencyKey !== undefined && input.idempotencyKey !== null) {
      idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
      const existing = await this.tasks.findByIdempotencyKey(idempotencyKey);
      if (existing) {
        return { task: existing, isIdempotentHit: true };
      }
    }

    // 2. Validate external ID strictly or generate canonical ID (task_ + 32hex)
    let taskId: string;
    if (input.id !== undefined) {
      taskId = validateTaskId(input.id);
    } else {
      taskId = generateTaskId();
    }

    const priority = input.priority !== undefined && input.priority !== null
      ? validateTaskPriority(input.priority)
      : 'medium';

    const leaseDurationMs = input.leaseDurationMs ?? this.defaultLeaseDurationMs;
    const maxRetries = input.maxRetries ?? this.defaultMaxRetries;

    const task = await this.tasks.create({
      id: taskId,
      idempotencyKey,
      title,
      description,
      assignee,
      priority,
      payload: validatedPayload,
      leaseDurationMs,
      maxRetries,
      dueDate: normalizedDueDate,
      scheduleType,
      cronExpression,
      intervalSeconds,
      timezone: input.timezone ?? 'UTC',
      misfirePolicy,
      overlapPolicy,
    });

    if (this.auditLogs) {
      await this.auditLogs.record({
        userId: this.userId,
        action: 'task_created',
        resourceType: 'task',
        resourceId: task.id,
        details: {
          title: task.title,
          priority: task.priority,
          scheduleType: task.scheduleType,
          idempotencyKey: task.idempotencyKey,
        },
      });
    }

    return { task, isIdempotentHit: false };
  }

  /**
   * Claim next pending or lease-expired task for execution using lease semantics.
   */
  async claimTask(input: ClaimTaskInput): Promise<Task | null> {
    const claimantId = validateClaimantId(input.claimantId);
    const preferredTaskId = input.preferredTaskId !== undefined && input.preferredTaskId !== null
      ? validateTaskId(input.preferredTaskId)
      : undefined;

    const leaseDurationMs = input.leaseDurationMs ?? this.defaultLeaseDurationMs;

    const task = await this.tasks.claim({
      claimantId,
      leaseDurationMs,
      preferredTaskId,
      now: input.now,
    });

    if (!task) {
      return null;
    }

    if (this.auditLogs) {
      await this.auditLogs.record({
        userId: this.userId,
        action: 'task_claimed',
        resourceType: 'task',
        resourceId: task.id,
        details: {
          claimantId: input.claimantId,
          leaseDurationMs,
          leaseExpiresAt: task.leaseExpiresAt,
          claimCount: task.claimCount,
        },
      });
    }

    return task;
  }

  /**
   * Renew the active lease for a task / run (heartbeat).
   */
  async renewLease(taskId: string, input: RenewLeaseInput): Promise<Task> {
    const validTaskId = validateTaskId(taskId);
    const claimantId = validateClaimantId(input.claimantId);

    const leaseDurationMs = input.leaseDurationMs ?? this.defaultLeaseDurationMs;
    const task = await this.tasks.renewLease(validTaskId, claimantId, leaseDurationMs, input.runId);

    if (this.auditLogs) {
      await this.auditLogs.record({
        userId: this.userId,
        action: 'task_lease_renewed',
        resourceType: 'task',
        resourceId: task.id,
        details: {
          claimantId: input.claimantId,
          leaseDurationMs,
          leaseExpiresAt: task.leaseExpiresAt,
        },
      });
    }

    return task;
  }

  /**
   * Complete task execution and record outcome.
   */
  async completeTask(taskId: string, input: CompleteTaskInput): Promise<Task> {
    const validTaskId = validateTaskId(taskId);
    const claimantId = validateClaimantId(input.claimantId);
    const validatedResult = validateAgentPromptResult(input.result);

    const task = await this.tasks.complete(
      validTaskId,
      claimantId,
      validatedResult,
      input.runId,
      input.tokenUsage
    );

    if (this.auditLogs) {
      await this.auditLogs.record({
        userId: this.userId,
        action: 'task_completed',
        resourceType: 'task',
        resourceId: task.id,
        details: {
          claimantId: input.claimantId,
          completedAt: task.completedAt,
        },
      });
    }

    return task;
  }

  /**
   * Mark task execution failed, allowing retry if within retry bounds.
   */
  async failTask(taskId: string, input: FailTaskInput): Promise<Task> {
    const validTaskId = validateTaskId(taskId);
    const claimantId = validateClaimantId(input.claimantId);

    const task = await this.tasks.fail(
      validTaskId,
      claimantId,
      input.error,
      input.retryable,
      input.runId,
      input.errorCode
    );

    if (this.auditLogs) {
      await this.auditLogs.record({
        userId: this.userId,
        action: 'task_failed',
        resourceType: 'task',
        resourceId: task.id,
        details: {
          claimantId: input.claimantId,
          error: input.error,
          finalStatus: task.status,
          claimCount: task.claimCount,
        },
      });
    }

    return task;
  }

  /**
   * Cancel an active or pending task.
   */
  async cancelTask(taskId: string): Promise<Task> {
    const validTaskId = validateTaskId(taskId);
    const task = await this.tasks.cancel(validTaskId);

    if (this.auditLogs) {
      await this.auditLogs.record({
        userId: this.userId,
        action: 'task_cancelled',
        resourceType: 'task',
        resourceId: task.id,
        details: {
          reason: TASK_PROTOCOL_ERROR_CODES.CANCELLED,
        },
      });
    }

    return task;
  }

  /**
   * Pause a scheduled task.
   */
  async pauseTask(taskId: string): Promise<Task> {
    const validTaskId = validateTaskId(taskId);
    const task = await this.tasks.pause(validTaskId);

    if (this.auditLogs) {
      await this.auditLogs.record({
        userId: this.userId,
        action: 'task_paused',
        resourceType: 'task',
        resourceId: task.id,
        details: {
          pausedAt: task.schedule?.pausedAt,
        },
      });
    }

    return task;
  }

  /**
   * Resume a paused scheduled task.
   */
  async resumeTask(taskId: string, now?: Date | string): Promise<Task> {
    const validTaskId = validateTaskId(taskId);
    const task = await this.tasks.resume(validTaskId, now);

    if (this.auditLogs) {
      await this.auditLogs.record({
        userId: this.userId,
        action: 'task_resumed',
        resourceType: 'task',
        resourceId: task.id,
        details: {
          nextRunAt: task.schedule?.nextRunAt,
        },
      });
    }

    return task;
  }

  /**
   * Recover all tasks whose leases have expired (useful during restart or cron sweep).
   */
  async recoverExpiredLeases(nowIso?: string): Promise<TaskRecoveryResult> {
    const result = await this.tasks.recoverExpiredLeases(nowIso);

    if (result.recoveredCount > 0 && this.auditLogs) {
      await this.auditLogs.record({
        userId: this.userId,
        action: 'task_recovered',
        resourceType: 'task',
        details: {
          recoveredCount: result.recoveredCount,
          taskIds: result.taskIds,
        },
      });
    }

    return result;
  }

  /**
   * Get task by ID.
   */
  async getTask(taskId: string): Promise<Task | null> {
    const validTaskId = validateTaskId(taskId);
    return this.tasks.findById(validTaskId);
  }

  /**
   * List tasks for this tenant.
   */
  async listTasks(options?: TaskQueryOptions): Promise<Task[]> {
    return this.tasks.list(options);
  }

  /**
   * Get schedule for a task.
   */
  async getSchedule(taskId: string): Promise<TaskSchedule | null> {
    const validTaskId = validateTaskId(taskId);
    return this.tasks.getSchedule(validTaskId);
  }

  /**
   * List runs for a task.
   */
  async listRuns(taskId: string, options?: TaskRunQueryOptions): Promise<TaskRunsListResult> {
    const validTaskId = validateTaskId(taskId);
    return this.tasks.listRuns(validTaskId, options);
  }

  /**
   * Get a run by ID.
   */
  async getRun(runId: string): Promise<TaskRun | null> {
    const validRunId = validateRunId(runId);
    return this.tasks.getRun(validRunId);
  }

  /**
   * Create an immediate manual run for a task without shifting next scheduled run.
   */
  async createManualRun(
    taskId: string,
    claimantId?: string,
    leaseDurationMs?: number,
    now?: Date | string
  ): Promise<{ task: Task; run: TaskRun }> {
    const validTaskId = validateTaskId(taskId);
    return this.tasks.createManualRun(validTaskId, claimantId, leaseDurationMs, now);
  }
}
