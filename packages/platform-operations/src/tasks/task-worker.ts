import { randomUUID } from 'node:crypto';
import type {
  Task,
  AgentPromptTaskPayload,
  TaskRecoveryResult,
  AgentPromptDispatchResult,
} from '../types/task.js';
import {
  validateAgentPromptPayload,
  validateAgentPromptResult,
  validateTaskId,
  TASK_PROTOCOL_ERROR_CODES,
} from '../types/task.js';
import type { TenantScopedTaskRepository } from '../ports/task-port.js';
import type { TenantScopedQuotaLedgerRepository } from '../ports/quota-ledger-port.js';
import { TaskOperationService } from '../services/task-operation-service.js';
import { QuotaOperationService } from '../services/quota-operation-service.js';
import {
  TaskLeaseExpiredError,
  TaskAlreadyClaimedError,
  TaskAlreadyCompletedError,
  TaskNotFoundError,
  ValidationError,
} from '../errors/index.js';

export type TaskWorkerStatus = 'idle' | 'running' | 'stopping' | 'stopped';

export interface TaskExecutionBudget {
  readonly maxWaitMs?: number;
}

export interface AgentPromptDispatchContext {
  task: Task;
  payload: AgentPromptTaskPayload;
  signal: AbortSignal;
  workerId: string;
  tenantId: string;
  executionBudget?: TaskExecutionBudget;
}

export interface AgentPromptDispatcher {
  dispatch(context: AgentPromptDispatchContext): Promise<AgentPromptDispatchResult>;
}

export type AgentPromptDispatchFn = (context: AgentPromptDispatchContext) => Promise<AgentPromptDispatchResult>;

export type TenantEnumerator = () => Promise<string[]> | string[];

export interface WorkerTenantOperations {
  tasks: TaskOperationService | TenantScopedTaskRepository;
  quota?: QuotaOperationService | TenantScopedQuotaLedgerRepository;
}

export type TenantOperationsAccessor = (
  tenantId: string
) => WorkerTenantOperations | Promise<WorkerTenantOperations>;

export type TaskWorkerStage =
  | 'system_recovery'
  | 'tenant_enumeration'
  | 'operations_access'
  | 'claim'
  | 'execution'
  | 'settlement'
  | 'heartbeat'
  | 'polling_tick'
  | 'recovery'
  | 'callback';

export type TaskWorkerOriginatingStage =
  | 'system_recovery'
  | 'tenant_enumeration'
  | 'operations_access'
  | 'claim'
  | 'execution'
  | 'settlement'
  | 'heartbeat'
  | 'polling_tick'
  | 'recovery';

export interface TaskWorkerErrorContext {
  stage: TaskWorkerStage;
  tenantId?: string;
  taskId?: string;
  originatingStage?: TaskWorkerOriginatingStage;
}

export type TaskWorkerErrorHandler = (
  error: Error,
  context: TaskWorkerErrorContext
) => void | Promise<void>;

export interface TaskInputPreparationContext {
  task: Task;
  payload: AgentPromptTaskPayload;
  tenantId: string;
  runId: string;
  signal: AbortSignal;
}

export interface TaskInputPreparationResult {
  preparedPrompt?: string;
  stagedPath?: string;
  executionBudget?: TaskExecutionBudget;
}

export type TaskInputPreparer = (
  context: TaskInputPreparationContext
) => Promise<TaskInputPreparationResult | void> | TaskInputPreparationResult | void;

export interface TaskWorkerOptions {
  workerId?: string;
  tenantEnumerator: TenantEnumerator;
  getTenantOperations: TenantOperationsAccessor;
  dispatcher: AgentPromptDispatcher | AgentPromptDispatchFn;
  prepareTaskInput?: TaskInputPreparer;
  pollIntervalMs?: number;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  recoverOnStart?: boolean;
  systemRecovery?: () => Promise<{ recoveredTasks: number; expiredReservations?: number }>;
  onError?: TaskWorkerErrorHandler;
  channelRuntimeManager?: any;
  db?: any;
  getReplyText?: (params: { tenantId: string; sessionId: string; taskId: string }) => Promise<string | null> | string | null;
}

export interface TenantDiagnostic {
  tenantId: string;
  stage: 'recovery' | 'claim' | 'operations_access' | 'settlement' | 'callback' | 'heartbeat' | 'system_recovery' | 'tenant_enumeration';
  originatingStage?: TaskWorkerOriginatingStage;
  error: string;
}

export interface TaskWorkerTickResult {
  processed: boolean;
  taskId?: string;
  tenantId?: string;
  status?: 'completed' | 'failed' | 'aborted' | 'lease_lost';
  result?: AgentPromptDispatchResult | null;
  error?: string;
  reason?: 'task_executed' | 'no_due_tasks' | 'busy' | 'stopped' | 'tenant_error' | 'enumeration_error';
  scannedTenantsCount?: number;
  diagnostics?: TenantDiagnostic[];
}

export interface TaskWorkerExecutionResult {
  taskId: string;
  tenantId: string;
  status: 'completed' | 'failed' | 'aborted' | 'lease_lost';
  result?: AgentPromptDispatchResult | null;
  error?: string | null;
}

export interface TaskWorkerDiagnostics {
  workerId: string;
  status: TaskWorkerStatus;
  isBusy: boolean;
  lastTickResult: TaskWorkerTickResult | null;
  lastError: string | null;
  lastDiagnostics: TenantDiagnostic[];
}

/**
 * Single-process task worker with bounded concurrency = 1.
 * Dispatches agent_prompt tasks strictly to injected agent dispatcher.
 * Implements non-overlapping heartbeat lease renewal, abort on lease loss/cancel,
 * and restart recovery.
 * Fully transparent diagnostics with fixed error codes: strictly no raw sanitizer/err.message/String(err).
 * Absolutely no shell or external script execution.
 */
export class AgentPromptTaskWorker {
  readonly workerId: string;
  private readonly tenantEnumerator: TenantEnumerator;
  private readonly getTenantOperations: TenantOperationsAccessor;
  private readonly dispatcher: AgentPromptDispatcher | AgentPromptDispatchFn;
  private readonly prepareTaskInput?: TaskInputPreparer;
  private readonly pollIntervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly recoverOnStart: boolean;
  private readonly systemRecovery?: () => Promise<{ recoveredTasks: number; expiredReservations?: number }>;
  private readonly onErrorCallback?: TaskWorkerErrorHandler;
  public channelRuntimeManager?: any;
  private readonly db?: any;
  private readonly getReplyText?: (params: { tenantId: string; sessionId: string; taskId: string }) => Promise<string | null> | string | null;

  private _status: TaskWorkerStatus = 'idle';
  private pollTimer: NodeJS.Timeout | null = null;
  private isExecuting = false;
  private currentExecutingTaskId: string | null = null;
  private activeAbortController: AbortController | null = null;
  private activeExecutionPromise: Promise<TaskWorkerExecutionResult | null> | null = null;

  private _lastTickResult: TaskWorkerTickResult | null = null;
  private _lastError: string | null = null;
  private _lastDiagnostics: TenantDiagnostic[] = [];

  constructor(options: TaskWorkerOptions) {
    this.workerId = options.workerId ?? `worker_${randomUUID()}`;
    this.tenantEnumerator = options.tenantEnumerator;
    this.getTenantOperations = options.getTenantOperations;
    this.dispatcher = options.dispatcher;
    this.prepareTaskInput = options.prepareTaskInput;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? Math.max(500, Math.floor(this.leaseDurationMs / 3));
    this.recoverOnStart = options.recoverOnStart ?? true;
    this.systemRecovery = options.systemRecovery;
    this.onErrorCallback = options.onError;
    this.channelRuntimeManager = options.channelRuntimeManager;
    this.db = options.db;
    this.getReplyText = options.getReplyText;
  }

  get status(): TaskWorkerStatus {
    return this._status;
  }

  get isBusy(): boolean {
    return this.isExecuting;
  }

  get lastTickResult(): TaskWorkerTickResult | null {
    return this._lastTickResult;
  }

  get lastError(): string | null {
    return this._lastError;
  }

  get lastDiagnostics(): TenantDiagnostic[] {
    return [...this._lastDiagnostics];
  }

  /**
   * Public diagnostic state inspector.
   */
  getDiagnostics(): TaskWorkerDiagnostics {
    return {
      workerId: this.workerId,
      status: this._status,
      isBusy: this.isExecuting,
      lastTickResult: this._lastTickResult,
      lastError: this._lastError,
      lastDiagnostics: [...this._lastDiagnostics],
    };
  }

  /**
   * Start worker background polling loop.
   */
  async start(): Promise<void> {
    if (this._status === 'running') {
      return;
    }

    this._status = 'running';

    // 1. Run startup recovery if enabled
    if (this.recoverOnStart) {
      await this.runRecovery();
    }

    // 2. Start polling loop
    this.scheduleNextPoll();
  }

  /**
   * Stop worker gracefully.
   * When abortInFlight is true, in-flight dispatch is aborted through AbortSignal,
   * but not persisted as failed in DB, leaving it claimed for lease recovery.
   */
  async stop(options?: { abortInFlight?: boolean }): Promise<void> {
    if (this._status === 'stopped' || this._status === 'stopping') {
      return;
    }

    this._status = 'stopping';

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    if (options?.abortInFlight && this.activeAbortController) {
      this.activeAbortController.abort('Worker stopping');
    }

    if (this.activeExecutionPromise) {
      try {
        await this.activeExecutionPromise;
      } catch (_stopErr: unknown) {
        // Handled during stop settlement
      }
    }

    this._status = 'stopped';
  }

  /**
   * Run recovery across all tenants and system-level recovery if provided.
   */
  async runRecovery(): Promise<{ recoveredTasks: number; diagnostics?: TenantDiagnostic[] }> {
    let totalRecovered = 0;
    const diagnostics: TenantDiagnostic[] = [];

    if (this.systemRecovery) {
      try {
        const sysResult = await this.systemRecovery();
        totalRecovered += sysResult.recoveredTasks;
      } catch (_err: unknown) {
        const errCode = TASK_PROTOCOL_ERROR_CODES.RECOVERY_FAILED;
        this._lastError = errCode;
        diagnostics.push({
          tenantId: 'system',
          stage: 'recovery',
          error: errCode,
        });
        if (this.onErrorCallback) {
          try {
            await this.onErrorCallback(new Error(errCode), { stage: 'system_recovery' });
          } catch (_cbErr: unknown) {
            diagnostics.push({
              tenantId: 'system',
              stage: 'callback',
              originatingStage: 'system_recovery',
              error: TASK_PROTOCOL_ERROR_CODES.CALLBACK_FAILED,
            });
          }
        }
      }
    }

    let rawTenantIds: string[] = [];
    try {
      rawTenantIds = await this.tenantEnumerator();
    } catch (_err: unknown) {
      const errCode = TASK_PROTOCOL_ERROR_CODES.TENANT_ENUMERATION_FAILED;
      this._lastError = errCode;
      diagnostics.push({
        tenantId: '*',
        stage: 'recovery',
        error: errCode,
      });
      if (this.onErrorCallback) {
        try {
          await this.onErrorCallback(new Error(errCode), { stage: 'tenant_enumeration' });
        } catch (_cbErr: unknown) {
          diagnostics.push({
            tenantId: '*',
            stage: 'callback',
            originatingStage: 'tenant_enumeration',
            error: TASK_PROTOCOL_ERROR_CODES.CALLBACK_FAILED,
          });
        }
      }
      return { recoveredTasks: totalRecovered, diagnostics };
    }

    const tenantIds = (Array.isArray(rawTenantIds) ? rawTenantIds : [])
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      .map((id) => id.trim());

    for (const tenantId of tenantIds) {
      try {
        const ops = await this.getTenantOperations(tenantId);
        const repo = ops.tasks;
        const res: TaskRecoveryResult = await repo.recoverExpiredLeases();
        totalRecovered += res.recoveredCount;
      } catch (_err: unknown) {
        const errCode = TASK_PROTOCOL_ERROR_CODES.RECOVERY_FAILED;
        diagnostics.push({
          tenantId,
          stage: 'recovery',
          error: errCode,
        });
      }
    }

    if (diagnostics.length > 0) {
      this._lastDiagnostics = diagnostics;
    }

    return {
      recoveredTasks: totalRecovered,
      diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
    };
  }

  /**
   * One single polling and execution tick across tenants.
   * Concurrency is bounded to 1: if already executing, skips this tick.
   * Uses fixed protocol error codes.
   */
  async tick(): Promise<TaskWorkerTickResult> {
    if (this.isExecuting) {
      const res: TaskWorkerTickResult = { processed: false, reason: 'busy' };
      this._lastTickResult = res;
      return res;
    }
    if (this._status === 'stopped' || this._status === 'stopping') {
      const res: TaskWorkerTickResult = { processed: false, reason: 'stopped' };
      this._lastTickResult = res;
      return res;
    }

    this.isExecuting = true;
    try {
      let rawTenantIds: string[];
      try {
        rawTenantIds = await this.tenantEnumerator();
      } catch (_enumErr: unknown) {
        const errorMsg = TASK_PROTOCOL_ERROR_CODES.TENANT_ENUMERATION_FAILED;
        this._lastError = errorMsg;
        const diag: TenantDiagnostic = {
          tenantId: '*',
          stage: 'operations_access',
          error: errorMsg,
        };
        const allDiags: TenantDiagnostic[] = [diag];

        if (this.onErrorCallback) {
          try {
            await this.onErrorCallback(new Error(errorMsg), { stage: 'tenant_enumeration' });
          } catch (_cbErr: unknown) {
            allDiags.push({
              tenantId: '*',
              stage: 'callback',
              originatingStage: 'tenant_enumeration',
              error: TASK_PROTOCOL_ERROR_CODES.CALLBACK_FAILED,
            });
          }
        }
        this._lastDiagnostics = allDiags;

        const res: TaskWorkerTickResult = {
          processed: false,
          reason: 'enumeration_error',
          error: errorMsg,
          scannedTenantsCount: 0,
          diagnostics: allDiags,
        };
        this._lastTickResult = res;
        return res;
      }

      const tenantIds = (Array.isArray(rawTenantIds) ? rawTenantIds : [])
        .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
        .map((id) => id.trim());

      const diagnostics: TenantDiagnostic[] = [];
      let scannedCount = 0;

      for (const tenantId of tenantIds) {
        scannedCount++;
        let ops: WorkerTenantOperations;
        try {
          ops = await this.getTenantOperations(tenantId);
        } catch (_accessErr: unknown) {
          const errorMsg = TASK_PROTOCOL_ERROR_CODES.TENANT_ACCESS_FAILED;
          diagnostics.push({
            tenantId,
            stage: 'operations_access',
            error: errorMsg,
          });
          if (this.onErrorCallback) {
            try {
              await this.onErrorCallback(new Error(errorMsg), { stage: 'operations_access', tenantId });
            } catch (_cbErr: unknown) {
              diagnostics.push({
                tenantId,
                stage: 'callback',
                originatingStage: 'operations_access',
                error: TASK_PROTOCOL_ERROR_CODES.CALLBACK_FAILED,
              });
            }
          }
          continue;
        }

        const tasksRepo = ops.tasks;

        // Periodic recovery check for expired tasks in this tenant
        try {
          await tasksRepo.recoverExpiredLeases();
        } catch (_recErr: unknown) {
          diagnostics.push({
            tenantId,
            stage: 'recovery',
            error: TASK_PROTOCOL_ERROR_CODES.RECOVERY_FAILED,
          });
        }

        // Attempt to claim next available due task
        let claimResult: Task | null = null;
        try {
          claimResult = await (tasksRepo instanceof TaskOperationService
            ? tasksRepo.claimTask({ claimantId: this.workerId, leaseDurationMs: this.leaseDurationMs })
            : tasksRepo.claim({ claimantId: this.workerId, leaseDurationMs: this.leaseDurationMs }));
        } catch (_claimErr: unknown) {
          const errorMsg = TASK_PROTOCOL_ERROR_CODES.CLAIM_FAILED;
          diagnostics.push({
            tenantId,
            stage: 'claim',
            error: errorMsg,
          });
          if (this.onErrorCallback) {
            try {
              await this.onErrorCallback(new Error(errorMsg), { stage: 'claim', tenantId });
            } catch (_cbErr: unknown) {
              diagnostics.push({
                tenantId,
                stage: 'callback',
                originatingStage: 'claim',
                error: TASK_PROTOCOL_ERROR_CODES.CALLBACK_FAILED,
              });
            }
          }
          continue;
        }

        if (claimResult) {
          const execResult = await this.executeClaimedTask(tenantId, claimResult, ops);
          this._lastDiagnostics = diagnostics;
          const res: TaskWorkerTickResult = {
            processed: true,
            taskId: claimResult.id,
            tenantId,
            status: execResult.status,
            result: execResult.result ?? null,
            error: execResult.error ?? undefined,
            reason: 'task_executed',
            scannedTenantsCount: scannedCount,
            diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
          };
          this._lastTickResult = res;
          return res;
        }
      }

      this._lastDiagnostics = diagnostics;

      if (diagnostics.length > 0) {
        const errorMsg = TASK_PROTOCOL_ERROR_CODES.TENANT_ACCESS_FAILED;
        this._lastError = errorMsg;
        const res: TaskWorkerTickResult = {
          processed: false,
          reason: 'tenant_error',
          error: errorMsg,
          scannedTenantsCount: scannedCount,
          diagnostics,
        };
        this._lastTickResult = res;
        return res;
      }

      const res: TaskWorkerTickResult = {
        processed: false,
        reason: 'no_due_tasks',
        scannedTenantsCount: scannedCount,
      };
      this._lastTickResult = res;
      return res;
    } finally {
      this.isExecuting = false;
    }
  }

  /**
   * Run one single task execution immediately if available.
   */
  async runOnce(): Promise<TaskWorkerExecutionResult | null> {
    const tickResult = await this.tick();
    if (!tickResult.processed || !tickResult.taskId || !tickResult.tenantId || !tickResult.status) {
      return null;
    }
    return {
      taskId: tickResult.taskId,
      tenantId: tickResult.tenantId,
      status: tickResult.status,
      result: tickResult.result ?? null,
      error: tickResult.error ?? null,
    };
  }

  /**
   * Run a specific task immediately by taskId and tenantId.
   */
  async runNow(options: { taskId: string; tenantId: string }): Promise<TaskWorkerExecutionResult | null> {
    if (!options || typeof options !== 'object') {
      throw new ValidationError('Task worker runNow options must be an object');
    }
    const validTaskId = validateTaskId(options.taskId);
    const tenantId = typeof options.tenantId === 'string' ? options.tenantId.trim() : '';
    if (!tenantId) {
      throw new ValidationError('Task worker runNow requires a non-empty tenantId');
    }

    if (this.isExecuting) {
      if (this.currentExecutingTaskId === validTaskId) {
        throw new TaskAlreadyClaimedError(validTaskId, this.workerId);
      }
      throw new Error('Task worker concurrency bounded to 1: already executing a task');
    }
    this.isExecuting = true;
    this.currentExecutingTaskId = validTaskId;
    try {
      const ops = await this.getTenantOperations(tenantId);
      const existingTask = await (ops.tasks instanceof TaskOperationService
        ? ops.tasks.getTask(validTaskId)
        : ops.tasks.findById(validTaskId));

      if (!existingTask) {
        throw new TaskNotFoundError(validTaskId);
      }

      const isRecurring =
        existingTask.scheduleType === 'cron' ||
        existingTask.scheduleType === 'interval' ||
        existingTask.schedule?.scheduleType === 'cron' ||
        existingTask.schedule?.scheduleType === 'interval' ||
        Boolean(existingTask.cronExpression || existingTask.schedule?.cronExpression) ||
        (existingTask.intervalSeconds !== null && existingTask.intervalSeconds !== undefined && existingTask.intervalSeconds > 0) ||
        (existingTask.schedule?.intervalSeconds !== null && existingTask.schedule?.intervalSeconds !== undefined && existingTask.schedule?.intervalSeconds > 0);

      let task: Task | null = null;
      if (isRecurring) {
        if (existingTask.status === 'cancelled') {
          throw new TaskAlreadyCompletedError(validTaskId);
        }
        if (ops.tasks instanceof TaskOperationService) {
          const manualRes = await ops.tasks.createManualRun(validTaskId, this.workerId, this.leaseDurationMs);
          task = manualRes.task;
        } else {
          const manualRes = await (ops.tasks as TenantScopedTaskRepository).createManualRun(
            validTaskId,
            this.workerId,
            this.leaseDurationMs
          );
          task = manualRes.task;
        }
      } else {
        if (existingTask.status === 'completed' || existingTask.status === 'cancelled' || existingTask.status === 'failed') {
          throw new TaskAlreadyCompletedError(validTaskId);
        }
        if (ops.tasks instanceof TaskOperationService) {
          task = await ops.tasks.claimTask({
            claimantId: this.workerId,
            leaseDurationMs: this.leaseDurationMs,
            preferredTaskId: validTaskId,
          });
        } else {
          task = await ops.tasks.claim({
            claimantId: this.workerId,
            leaseDurationMs: this.leaseDurationMs,
            preferredTaskId: validTaskId,
          });
        }
        if (!task) {
          if (ops.tasks instanceof TaskOperationService) {
            const manualRes = await ops.tasks.createManualRun(validTaskId, this.workerId, this.leaseDurationMs);
            task = manualRes.task;
          } else {
            const manualRes = await (ops.tasks as TenantScopedTaskRepository).createManualRun(
              validTaskId,
              this.workerId,
              this.leaseDurationMs
            );
            task = manualRes.task;
          }
        }
      }
      if (!task) {
        return null;
      }
      return await this.executeClaimedTask(tenantId, task, ops);
    } finally {
      this.isExecuting = false;
      this.currentExecutingTaskId = null;
    }
  }

  private scheduleNextPoll(): void {
    if (this._status !== 'running') {
      return;
    }

    this.pollTimer = setTimeout(async () => {
      if (this._status === 'running') {
        try {
          await this.tick();
        } catch (_unhandledErr: unknown) {
          const errMsg = TASK_PROTOCOL_ERROR_CODES.UNKNOWN_ERROR;
          this._lastError = errMsg;
          this._lastDiagnostics = [{
            tenantId: '*',
            stage: 'operations_access',
            error: errMsg,
          }];
          if (this.onErrorCallback) {
            try {
              await this.onErrorCallback(new Error(errMsg), { stage: 'polling_tick' });
            } catch (_cbErr: unknown) {
              this._lastDiagnostics.push({
                tenantId: '*',
                stage: 'callback',
                originatingStage: 'polling_tick',
                error: TASK_PROTOCOL_ERROR_CODES.CALLBACK_FAILED,
              });
            }
          }
        } finally {
          this.scheduleNextPoll();
        }
      }
    }, this.pollIntervalMs);
  }

  /**
   * Core task execution harness:
   * - Non-overlapping recursive heartbeat loop renewing lease every `heartbeatIntervalMs`.
   * - Immediate abort on lease loss or cancellation detection.
   * - Strict AgentPromptTaskPayload validation.
   * - Strict AgentPromptDispatchResult validation.
   * - Minimal receipt persistence only.
   * - Safe fixed protocol error codes.
   * - Authoritative completion CAS: re-reads authoritative task on TaskAlreadyCompletedError.
   */
  private async executeClaimedTask(
    tenantId: string,
    task: Task,
    ops: WorkerTenantOperations
  ): Promise<TaskWorkerExecutionResult> {
    const abortController = new AbortController();
    this.activeAbortController = abortController;

    const executionPromise = (async (): Promise<TaskWorkerExecutionResult> => {
      let heartbeatTimeoutHandle: NodeJS.Timeout | null = null;
      let heartbeatActive = true;
      let isRenewing = false;
      let leaseLost = false;

      // 1. Strict payload validation
      let payload: AgentPromptTaskPayload;
      try {
        payload = validateAgentPromptPayload(task.payload);
      } catch (_validationErr: unknown) {
        const protocolCode = TASK_PROTOCOL_ERROR_CODES.PAYLOAD_INVALID;
        try {
          if (ops.tasks instanceof TaskOperationService) {
            await ops.tasks.failTask(task.id, {
              claimantId: this.workerId,
              error: protocolCode,
              retryable: false,
            });
          } else {
            await (ops.tasks as TenantScopedTaskRepository).fail(
              task.id,
              this.workerId,
              protocolCode,
              false
            );
          }
        } catch (settlementErr: unknown) {
          if (settlementErr instanceof TaskLeaseExpiredError) {
            return {
              taskId: task.id,
              tenantId,
              status: 'lease_lost',
              error: TASK_PROTOCOL_ERROR_CODES.LEASE_EXPIRED,
            };
          }
          const settlementCode = TASK_PROTOCOL_ERROR_CODES.SETTLEMENT_FAILED;
          this._lastError = settlementCode;
          this._lastDiagnostics = [{
            tenantId,
            stage: 'settlement',
            error: settlementCode,
          }];
          if (this.onErrorCallback) {
            try {
              await this.onErrorCallback(new Error(settlementCode), { stage: 'settlement', tenantId, taskId: task.id });
            } catch (_cbErr: unknown) {
              this._lastDiagnostics.push({
                tenantId,
                stage: 'callback',
                originatingStage: 'settlement',
                error: TASK_PROTOCOL_ERROR_CODES.CALLBACK_FAILED,
              });
            }
          }
          return {
            taskId: task.id,
            tenantId,
            status: 'failed',
            error: settlementCode,
          };
        }
        return {
          taskId: task.id,
          tenantId,
          status: 'failed',
          error: protocolCode,
        };
      }

      // 2. Non-overlapping recursive heartbeat loop
      const scheduleHeartbeat = () => {
        if (!heartbeatActive || abortController.signal.aborted || leaseLost) {
          return;
        }
        heartbeatTimeoutHandle = setTimeout(async () => {
          if (!heartbeatActive || abortController.signal.aborted || leaseLost || isRenewing) {
            return;
          }
          isRenewing = true;
          try {
            if (ops.tasks instanceof TaskOperationService) {
              await ops.tasks.renewLease(task.id, {
                claimantId: this.workerId,
                leaseDurationMs: this.leaseDurationMs,
                runId: task.currentRun?.id,
              });
            } else {
              await (ops.tasks as TenantScopedTaskRepository).renewLease(
                task.id,
                this.workerId,
                this.leaseDurationMs,
                task.currentRun?.id
              );
            }
          } catch (heartbeatErr: unknown) {
            leaseLost = true;
            heartbeatActive = false;
            if (heartbeatTimeoutHandle) {
              clearTimeout(heartbeatTimeoutHandle);
              heartbeatTimeoutHandle = null;
            }
            // Immediately abort the in-flight dispatch signal
            abortController.abort(
              heartbeatErr instanceof Error ? heartbeatErr : new TaskLeaseExpiredError(task.id)
            );
            return;
          } finally {
            isRenewing = false;
          }

          scheduleHeartbeat();
        }, this.heartbeatIntervalMs);
      };

      scheduleHeartbeat();

      const stopHeartbeat = () => {
        heartbeatActive = false;
        if (heartbeatTimeoutHandle) {
          clearTimeout(heartbeatTimeoutHandle);
          heartbeatTimeoutHandle = null;
        }
      };

      // 2b. Optional trusted pre-dispatch input preparation
      let effectivePayload = payload;
      let executionBudget: TaskExecutionBudget | undefined = undefined;
      if (this.prepareTaskInput) {
        const runId = task.currentRun?.id || task.id;
        try {
          const prepResult = await this.prepareTaskInput({
            task,
            payload,
            tenantId,
            runId,
            signal: abortController.signal,
          });
          if (prepResult && typeof prepResult.preparedPrompt === 'string') {
            effectivePayload = {
              ...payload,
              prompt: prepResult.preparedPrompt,
            };
          }
          if (prepResult && prepResult.executionBudget !== undefined) {
            executionBudget = prepResult.executionBudget;
          }
        } catch (prepErr) {
          stopHeartbeat();
          const failCode = TASK_PROTOCOL_ERROR_CODES.EXECUTION_FAILED;
          try {
            if (ops.tasks instanceof TaskOperationService) {
              await ops.tasks.failTask(task.id, {
                claimantId: this.workerId,
                error: prepErr instanceof Error ? prepErr.message : String(prepErr),
                retryable: false,
                runId: task.currentRun?.id,
                errorCode: failCode,
              });
            } else {
              await (ops.tasks as TenantScopedTaskRepository).fail(
                task.id,
                this.workerId,
                prepErr instanceof Error ? prepErr.message : String(prepErr),
                false,
                task.currentRun?.id,
                failCode
              );
            }
          } catch {}
          return {
            taskId: task.id,
            tenantId,
            status: 'failed',
            error: failCode,
          };
        }
      }

      // 3. Dispatch to agent dispatcher
      try {
        const dispatchContext: AgentPromptDispatchContext = {
          task,
          payload: effectivePayload,
          signal: abortController.signal,
          workerId: this.workerId,
          tenantId,
          ...(executionBudget !== undefined ? { executionBudget } : {}),
        };

        let rawResult: AgentPromptDispatchResult;
        if (typeof this.dispatcher === 'function') {
          rawResult = await this.dispatcher(dispatchContext);
        } else {
          rawResult = await this.dispatcher.dispatch(dispatchContext);
        }

        stopHeartbeat();

        if (leaseLost) {
          let currentTask: Task | null = null;
          try {
            if (ops.tasks instanceof TaskOperationService) {
              currentTask = await ops.tasks.getTask(task.id);
            } else {
              currentTask = await (ops.tasks as TenantScopedTaskRepository).findById(task.id);
            }
          } catch (_rereadErr: unknown) {
            // Ignore reread error
          }
          if (currentTask?.status === 'cancelled') {
            return {
              taskId: task.id,
              tenantId,
              status: 'aborted',
              error: TASK_PROTOCOL_ERROR_CODES.CANCELLED,
            };
          }
          return {
            taskId: task.id,
            tenantId,
            status: 'lease_lost',
            error: TASK_PROTOCOL_ERROR_CODES.LEASE_EXPIRED,
          };
        }

        if (abortController.signal.aborted) {
          return {
            taskId: task.id,
            tenantId,
            status: 'aborted',
            error: TASK_PROTOCOL_ERROR_CODES.ABORTED,
          };
        }

        // 4. Validate exact AgentPromptDispatchResult schema
        let extractedReplyText: string | undefined;
        let resultToValidate = rawResult;
        if (rawResult && typeof rawResult === 'object' && 'replyText' in rawResult) {
          extractedReplyText = typeof (rawResult as any).replyText === 'string' ? (rawResult as any).replyText : undefined;
          const { replyText: _discarded, ...rest } = rawResult as any;
          resultToValidate = rest;
        }

        let validatedResult: AgentPromptDispatchResult;
        try {
          validatedResult = validateAgentPromptResult(resultToValidate);
        } catch (_resultValErr: unknown) {
          const protocolCode = TASK_PROTOCOL_ERROR_CODES.RESULT_INVALID;
          try {
            if (ops.tasks instanceof TaskOperationService) {
              await ops.tasks.failTask(task.id, {
                claimantId: this.workerId,
                error: protocolCode,
                retryable: false,
              });
            } else {
              await (ops.tasks as TenantScopedTaskRepository).fail(
                task.id,
                this.workerId,
                protocolCode,
                false
              );
            }
          } catch (settlementErr: unknown) {
            if (settlementErr instanceof TaskLeaseExpiredError) {
              return {
                taskId: task.id,
                tenantId,
                status: 'lease_lost',
                error: TASK_PROTOCOL_ERROR_CODES.LEASE_EXPIRED,
              };
            }
            const settlementCode = TASK_PROTOCOL_ERROR_CODES.SETTLEMENT_FAILED;
            this._lastError = settlementCode;
            this._lastDiagnostics = [{
              tenantId,
              stage: 'settlement',
              error: settlementCode,
            }];
            if (this.onErrorCallback) {
              try {
                await this.onErrorCallback(new Error(settlementCode), { stage: 'settlement', tenantId, taskId: task.id });
              } catch (_cbErr: unknown) {
                this._lastDiagnostics.push({
                  tenantId,
                  stage: 'callback',
                  error: TASK_PROTOCOL_ERROR_CODES.CALLBACK_FAILED,
                });
              }
            }
            return {
              taskId: task.id,
              tenantId,
              status: 'failed',
              error: settlementCode,
            };
          }
          return {
            taskId: task.id,
            tenantId,
            status: 'failed',
            error: protocolCode,
          };
        }

        // 5. Authoritative completion CAS
        try {
          if (ops.tasks instanceof TaskOperationService) {
            await ops.tasks.completeTask(task.id, {
              claimantId: this.workerId,
              result: validatedResult,
              runId: task.currentRun?.id,
            });
          } else {
            await (ops.tasks as TenantScopedTaskRepository).complete(
              task.id,
              this.workerId,
              validatedResult,
              task.currentRun?.id
            );
          }
        } catch (completeErr: unknown) {
          if (completeErr instanceof TaskLeaseExpiredError) {
            return {
              taskId: task.id,
              tenantId,
              status: 'lease_lost',
              error: TASK_PROTOCOL_ERROR_CODES.LEASE_EXPIRED,
            };
          }

          // Re-read authoritative task from storage to truthfully classify the race outcome
          let currentTask: Task | null = null;
          try {
            if (ops.tasks instanceof TaskOperationService) {
              currentTask = await ops.tasks.getTask(task.id);
            } else {
              currentTask = await (ops.tasks as TenantScopedTaskRepository).findById(task.id);
            }
          } catch (_rereadErr: unknown) {
            // Ignore reread error and fall back to settlement failure
          }

          if (currentTask?.status === 'completed') {
            return {
              taskId: task.id,
              tenantId,
              status: 'completed',
              result: currentTask.result ?? validatedResult,
            };
          }
          if (currentTask?.status === 'cancelled') {
            return {
              taskId: task.id,
              tenantId,
              status: 'aborted',
              error: TASK_PROTOCOL_ERROR_CODES.CANCELLED,
            };
          }
          if (currentTask?.status === 'failed') {
            return {
              taskId: task.id,
              tenantId,
              status: 'failed',
              error: currentTask.error ?? TASK_PROTOCOL_ERROR_CODES.EXECUTION_FAILED,
            };
          }

          const settlementCode = TASK_PROTOCOL_ERROR_CODES.SETTLEMENT_FAILED;
          this._lastError = settlementCode;
          this._lastDiagnostics = [{
            tenantId,
            stage: 'settlement',
            error: settlementCode,
          }];
          if (this.onErrorCallback) {
            try {
              await this.onErrorCallback(new Error(settlementCode), { stage: 'settlement', tenantId, taskId: task.id });
            } catch (_cbErr: unknown) {
              this._lastDiagnostics.push({
                tenantId,
                stage: 'callback',
                originatingStage: 'settlement',
                error: TASK_PROTOCOL_ERROR_CODES.CALLBACK_FAILED,
              });
            }
          }
          return {
            taskId: task.id,
            tenantId,
            status: 'failed',
            error: settlementCode,
          };
        }

        // 6. Proactive Lark delivery if configured in payload
        if (
          !payload.silent &&
          payload.delivery?.channel === 'lark' &&
          payload.delivery.accountId &&
          payload.delivery.nativeContextId
        ) {
          try {
            // Validate tenant account and binding if DB is present
            let deliveryAllowed = true;
            if (this.db) {
              try {
                // Validate channel account belongs to tenant and is active
                const accountRow = this.db.prepare(`
                  SELECT id, status FROM channel_accounts
                  WHERE id = ? AND user_id = ?
                  LIMIT 1
                `).get(payload.delivery.accountId, tenantId) as { id?: string; status?: string } | undefined;

                if (accountRow) {
                  if (accountRow.status !== 'active') {
                    deliveryAllowed = false;
                    console.warn('[lark-task] Channel account is not active for tenant:', {
                      tenantId,
                      accountId: payload.delivery.accountId,
                    });
                  } else {
                    // Resolve target space ID authoritatively
                    let resolvedSpaceId = payload.spaceId;
                    if (!resolvedSpaceId) {
                      try {
                        const routeRow = this.db.prepare(`
                          SELECT space_id FROM session_routes
                          WHERE id = ? AND user_id = ?
                          LIMIT 1
                        `).get(payload.sessionId, tenantId) as { space_id?: string } | undefined;
                        if (routeRow && typeof routeRow.space_id === 'string') {
                          resolvedSpaceId = routeRow.space_id;
                        }
                      } catch {}
                    }

                    // Validate binding exists for this account, context, AND exact target space
                    const baseContext = payload.delivery.nativeContextId.includes(':')
                      ? payload.delivery.nativeContextId.split(':')[0]
                      : payload.delivery.nativeContextId;
                    const bindingRow = this.db.prepare(`
                      SELECT id, space_id FROM channel_bindings
                      WHERE user_id = ? AND account_id = ? AND (native_context_id = ? OR native_context_id = ?)
                      LIMIT 1
                    `).get(tenantId, payload.delivery.accountId, payload.delivery.nativeContextId, baseContext) as { id?: string; space_id?: string } | undefined;

                    if (!bindingRow) {
                      deliveryAllowed = false;
                      console.warn('[lark-task] No channel binding found for tenant account and context:', {
                        tenantId,
                        accountId: payload.delivery.accountId,
                        context: payload.delivery.nativeContextId,
                      });
                    } else if (resolvedSpaceId && bindingRow.space_id !== resolvedSpaceId) {
                      // Binding belongs to another space: fail closed before external dispatch
                      deliveryAllowed = false;
                      console.warn('[lark-task] Channel binding space_id mismatch against resolved target space:', {
                        tenantId,
                        accountId: payload.delivery.accountId,
                        bindingSpaceId: bindingRow.space_id,
                        targetSpaceId: resolvedSpaceId,
                      });
                    }
                  }
                }
              } catch (dbCheckErr) {
                // Non-fatal if tables do not exist in minimal test DBs
              }
            }

            if (deliveryAllowed) {
              let replyText = extractedReplyText;
              if (!replyText && this.db) {
                try {
                  const stmt = this.db.prepare(`
                    SELECT content FROM web_messages
                    WHERE user_id = ? AND session_id = ? AND role = 'assistant'
                    ORDER BY created_at DESC, id DESC LIMIT 1
                  `);
                  const row = stmt.get(tenantId, payload.sessionId) as { content?: string } | undefined;
                  if (row && typeof row.content === 'string') {
                    replyText = row.content;
                  }
                } catch (dbErr) {
                  console.warn('[lark-task] Failed to read assistant message from web_messages:', dbErr);
                }
              }
              if (!replyText && this.getReplyText) {
                try {
                  replyText = (await this.getReplyText({ tenantId, sessionId: payload.sessionId, taskId: task.id })) ?? undefined;
                } catch {}
              }

              const crm = typeof this.channelRuntimeManager === 'function'
                ? this.channelRuntimeManager()
                : this.channelRuntimeManager;
              const gateway = crm?.getActiveGateway?.(tenantId, payload.delivery.accountId);

              if (gateway && typeof gateway.sendProactiveMessage === 'function') {
                const chatId = payload.delivery.nativeContextId.includes(':')
                  ? payload.delivery.nativeContextId.split(':')[0]
                  : payload.delivery.nativeContextId;
                const deliveryText = replyText ?? `Task "${task.title}" completed successfully.`;
                const stableRunId = task.currentRun?.id || task.id;
                const outboxId = `out_task_${stableRunId.replace(/[^a-zA-Z0-9_]/g, '')}`;
                await gateway.sendProactiveMessage({
                  chatId,
                  text: deliveryText,
                  title: task.title,
                  sessionId: payload.sessionId,
                  outboxId,
                });
              } else {
                console.warn('[lark-task] Active LarkChannelGateway not found for account:', {
                  tenantId,
                  accountId: payload.delivery.accountId,
                  taskId: task.id,
                });
              }
            }
          } catch (deliveryErr) {
            console.warn('[lark-task] Failed to deliver task result to Lark:', deliveryErr);
          }
        }

        return {
          taskId: task.id,
          tenantId,
          status: 'completed',
          result: validatedResult,
        };
      } catch (err: unknown) {
        stopHeartbeat();

        if (leaseLost || err instanceof TaskLeaseExpiredError) {
          let currentTask: Task | null = null;
          try {
            if (ops.tasks instanceof TaskOperationService) {
              currentTask = await ops.tasks.getTask(task.id);
            } else {
              currentTask = await (ops.tasks as TenantScopedTaskRepository).findById(task.id);
            }
          } catch (_rereadErr: unknown) {
            // Ignore reread error
          }
          if (currentTask?.status === 'cancelled') {
            return {
              taskId: task.id,
              tenantId,
              status: 'aborted',
              error: TASK_PROTOCOL_ERROR_CODES.CANCELLED,
            };
          }
          return {
            taskId: task.id,
            tenantId,
            status: 'lease_lost',
            error: TASK_PROTOCOL_ERROR_CODES.LEASE_EXPIRED,
          };
        }

        if (abortController.signal.aborted) {
          // If aborted due to server/worker stop or manual cancel, do not write failure to DB:
          // leave claimed for restart recovery
          return {
            taskId: task.id,
            tenantId,
            status: 'aborted',
            error: TASK_PROTOCOL_ERROR_CODES.ABORTED,
          };
        }

        // Execution failed: persist safe protocol failure
        const protocolCode = TASK_PROTOCOL_ERROR_CODES.EXECUTION_FAILED;
        try {
          if (ops.tasks instanceof TaskOperationService) {
            await ops.tasks.failTask(task.id, {
              claimantId: this.workerId,
              error: protocolCode,
              retryable: true,
              runId: task.currentRun?.id,
            });
          } else {
            await (ops.tasks as TenantScopedTaskRepository).fail(
              task.id,
              this.workerId,
              protocolCode,
              true,
              task.currentRun?.id
            );
          }
        } catch (settlementErr: unknown) {
          if (settlementErr instanceof TaskLeaseExpiredError) {
            return {
              taskId: task.id,
              tenantId,
              status: 'lease_lost',
              error: TASK_PROTOCOL_ERROR_CODES.LEASE_EXPIRED,
            };
          }
          const settlementCode = TASK_PROTOCOL_ERROR_CODES.SETTLEMENT_FAILED;
          this._lastError = settlementCode;
          this._lastDiagnostics = [{
            tenantId,
            stage: 'settlement',
            error: settlementCode,
          }];
          if (this.onErrorCallback) {
            try {
              await this.onErrorCallback(new Error(settlementCode), { stage: 'settlement', tenantId, taskId: task.id });
            } catch (_cbErr: unknown) {
              this._lastDiagnostics.push({
                tenantId,
                stage: 'callback',
                originatingStage: 'settlement',
                error: TASK_PROTOCOL_ERROR_CODES.CALLBACK_FAILED,
              });
            }
          }
        }

        return {
          taskId: task.id,
          tenantId,
          status: 'failed',
          error: protocolCode,
        };
      }
    })();

    this.activeExecutionPromise = executionPromise;
    try {
      return await executionPromise;
    } finally {
      this.activeAbortController = null;
      this.activeExecutionPromise = null;
    }
  }
}
