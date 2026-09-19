import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  AgentPromptTaskWorker,
  type AgentPromptDispatcher,
  type AgentPromptDispatchFn,
  type AgentPromptDispatchContext,
  type AgentPromptDispatchResult,
  type TaskWorkerStatus,
  type TaskWorkerOptions,
  type TaskWorkerTickResult,
  type TaskWorkerExecutionResult,
  type TenantDiagnostic,
  type AgentPromptTaskPayload,
  type TaskExecutionBudget,
} from '@enkeep/platform-operations';
import {
  SqlitePlatformOperationsStorage,
  SqliteUserRepository,
} from '@enkeep/platform-storage-sqlite';
import type { TaskNotificationService } from '../notifications/task-notification-service.js';
import {
  PipelineTaskInputPreparerService,
} from './pipeline-input-preparer.js';

export {
  AgentPromptTaskWorker,
  type AgentPromptDispatcher,
  type AgentPromptDispatchFn,
  type AgentPromptDispatchContext,
  type AgentPromptDispatchResult,
  type TaskWorkerStatus,
  type TaskWorkerOptions,
  type TaskWorkerTickResult,
  type TaskWorkerExecutionResult,
  type TenantDiagnostic,
  type AgentPromptTaskPayload,
  type TaskExecutionBudget,
};

export interface PlatformServerTaskWorkerOptions {
  db: DatabaseSync;
  dispatcher: AgentPromptDispatcher | AgentPromptDispatchFn;
  workerId?: string;
  runId?: string;
  pollIntervalMs?: number;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  operationsStorage?: SqlitePlatformOperationsStorage;
  taskNotificationService?: TaskNotificationService;
  channelRuntimeManager?: any;
  prepareTaskInput?: TaskWorkerOptions['prepareTaskInput'];
  pipelineTaskPreparer?: PipelineTaskInputPreparerService;
  pipelineManifestPath?: string;
  fileService?: any;
  dataRoot?: string;
  dshHome?: string;
}

/**
 * Convenience factory to create an AgentPromptTaskWorker for platform-server
 * with DatabaseSync and SqlitePlatformOperationsStorage.
 */
export function createPlatformServerTaskWorker(
  options: PlatformServerTaskWorkerOptions
): AgentPromptTaskWorker {
  const operationsStorage = options.operationsStorage ?? new SqlitePlatformOperationsStorage(options.db, {
    quotaOptions: { unconfiguredPolicy: 'fail_closed' },
  });
  const userRepo = new SqliteUserRepository(options.db);

  const tenantEnumerator = async (): Promise<string[]> => {
    const users = await userRepo.list({ status: 'active' });
    return users
      .filter((u) => u && typeof u.id === 'string' && u.id.trim().length > 0 && u.status === 'active')
      .map((u) => u.id.trim());
  };

  const getTenantOperations = (tenantId: string) => {
    const tenantStorage = operationsStorage.forTenant(tenantId);
    const origTasks = tenantStorage.tasks;

    if (!options.taskNotificationService) {
      return {
        tasks: origTasks,
        quota: tenantStorage.quota,
      };
    }

    const notifService = options.taskNotificationService;
    const proxiedTasks: typeof origTasks = {
      ...origTasks,
      async complete(id, claimantId, result, runId, tokenUsage) {
        const completedTask = await origTasks.complete(id, claimantId, result, runId, tokenUsage);
        try {
          await notifService.notifyTaskEvent({
            taskId: completedTask.id,
            userId: tenantId,
            event: 'completed',
            task: {
              id: completedTask.id,
              name: (completedTask as any).title ?? (completedTask as any).name,
              status: completedTask.status,
              scheduleType: completedTask.scheduleType,
              scheduledFor: completedTask.nextRunAt ?? completedTask.dueDate ?? null,
              startedAt: null,
              completedAt: completedTask.completedAt ?? null,
            },
            run: runId ? {
              id: runId,
              status: 'completed',
              promptTokens: tokenUsage?.promptTokens ?? 0,
              completionTokens: tokenUsage?.completionTokens ?? 0,
              totalTokens: tokenUsage?.totalTokens ?? 0,
            } : null,
          });
        } catch {}
        return completedTask;
      },
      async fail(id, claimantId, error, retryable, runId, errorCode) {
        const failedTask = await origTasks.fail(id, claimantId, error, retryable, runId, errorCode);
        try {
          await notifService.notifyTaskEvent({
            taskId: failedTask.id,
            userId: tenantId,
            event: 'failed',
            task: {
              id: failedTask.id,
              name: (failedTask as any).title ?? (failedTask as any).name,
              status: failedTask.status,
              scheduleType: failedTask.scheduleType,
              scheduledFor: failedTask.nextRunAt ?? failedTask.dueDate ?? null,
              startedAt: null,
              completedAt: failedTask.completedAt ?? null,
            },
            run: runId ? {
              id: runId,
              status: 'failed',
              errorCode: errorCode ?? null,
              error: error ?? null,
            } : null,
          });
        } catch {}
        return failedTask;
      },
    };

    return {
      tasks: proxiedTasks,
      quota: tenantStorage.quota,
    };
  };

  const resolvedWorkerId = options.workerId ?? (
    options.runId
      ? `worker_${options.runId}_${process.pid}`
      : `server_worker_${randomUUID()}`
  );

  const effectiveManifestPath = options.pipelineManifestPath ?? process.env.ENKEEP_PIPELINE_MANIFEST;
  let taskPreparerHook = options.prepareTaskInput;
  if (!taskPreparerHook && (options.pipelineTaskPreparer || effectiveManifestPath)) {
    const preparer = options.pipelineTaskPreparer ?? new PipelineTaskInputPreparerService({
      database: options.db,
      fileService: options.fileService,
      manifestPath: effectiveManifestPath,
      dataRoot: options.dataRoot,
      dshHome: options.dshHome,
    });
    taskPreparerHook = preparer.asPreparerHook();
  }

  return new AgentPromptTaskWorker({
    workerId: resolvedWorkerId,
    tenantEnumerator,
    getTenantOperations,
    dispatcher: options.dispatcher,
    pollIntervalMs: options.pollIntervalMs,
    leaseDurationMs: options.leaseDurationMs,
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    systemRecovery: () => operationsStorage.recoverAfterRestart(),
    channelRuntimeManager: options.channelRuntimeManager,
    prepareTaskInput: taskPreparerHook,
    db: options.db,
  });
}
