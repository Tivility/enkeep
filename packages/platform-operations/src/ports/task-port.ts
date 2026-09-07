import type {
  Task,
  CreateTaskInput,
  TaskQueryOptions,
  TaskRecoveryResult,
  AgentPromptDispatchResult,
  TaskSchedule,
  TaskRun,
  TaskRunQueryOptions,
  TaskRunsListResult,
} from '../types/task.js';

export interface TenantScopedTaskRepository {
  readonly userId: string;

  findById(id: string): Promise<Task | null>;
  findByIdempotencyKey(key: string): Promise<Task | null>;
  create(input: CreateTaskInput): Promise<Task>;

  /**
   * Atomically claim a pending or lease-expired task/schedule.
   * If preferredTaskId is provided, attempts to claim that specific task.
   */
  claim(input: {
    claimantId: string;
    leaseDurationMs: number;
    preferredTaskId?: string;
    now?: Date | string;
  }): Promise<Task | null>;

  /**
   * Renew the lease of an actively claimed task / run.
   */
  renewLease(id: string, claimantId: string, leaseDurationMs: number, runId?: string): Promise<Task>;

  /**
   * Mark a task and its run as completed with result payload.
   * Mandatory AgentPromptDispatchResult only.
   */
  complete(
    id: string,
    claimantId: string,
    result: AgentPromptDispatchResult,
    runId?: string,
    tokenUsage?: {
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
    }
  ): Promise<Task>;

  /**
   * Mark a task and its run as failed, incrementing retry count or failing permanently.
   */
  fail(
    id: string,
    claimantId: string,
    error: string,
    retryable?: boolean,
    runId?: string,
    errorCode?: string
  ): Promise<Task>;

  /**
   * Cancel an active or pending task and disable its schedule.
   */
  cancel(id: string): Promise<Task>;

  /**
   * Pause a scheduled task (sets schedule.enabled = 0, paused_at = now).
   */
  pause(id: string): Promise<Task>;

  /**
   * Resume a paused scheduled task (sets schedule.enabled = 1, paused_at = null, recomputes next_run_at).
   */
  resume(id: string, now?: Date | string): Promise<Task>;

  /**
   * Recover all tasks whose leases have expired (e.g. after worker crash or restart).
   * Moves expired tasks back to pending (if retries remain) or failed (if exhausted).
   */
  recoverExpiredLeases(nowIso?: string): Promise<TaskRecoveryResult>;

  /**
   * List tasks matching criteria.
   */
  list(options?: TaskQueryOptions): Promise<Task[]>;

  /**
   * Get 1:1 schedule info for a task.
   */
  getSchedule(taskId: string): Promise<TaskSchedule | null>;

  /**
   * List paginated execution runs for a task.
   */
  listRuns(taskId: string, options?: TaskRunQueryOptions): Promise<TaskRunsListResult>;

  /**
   * Get a specific task run by run ID.
   */
  getRun(runId: string): Promise<TaskRun | null>;

  /**
   * Create an immediate execution run for a task (e.g. manual Run Now) without shifting next scheduled run.
   */
  createManualRun(taskId: string, claimantId?: string, leaseDurationMs?: number, now?: Date | string): Promise<{ task: Task; run: TaskRun }>;
}
