import fs from 'node:fs';
import path from 'node:path';
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
  type ScriptTaskPayload,
  type ScriptTaskDispatchResult,
  type TaskPayload,
  type TaskDispatchResult,
  type TaskExecutionBudget,
  DEFAULT_TASK_EXECUTION_BUDGET_MS,
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
  type ScriptTaskPayload,
  type ScriptTaskDispatchResult,
  type TaskPayload,
  type TaskDispatchResult,
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
  defaultExecutionBudgetMs?: number;
  operationsStorage?: SqlitePlatformOperationsStorage;
  taskNotificationService?: TaskNotificationService;
  channelRuntimeManager?: any;
  wechatRuntimeManager?: any;
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

  const resolveSpaceCwd = async (params: {
    tenantId: string;
    spaceId: string;
    spaceFolder?: string;
  }): Promise<string> => {
    let folder = params.spaceFolder;
    const spaceRow = options.db
      .prepare('SELECT folder, execution_mode FROM spaces WHERE id = ? AND user_id = ?')
      .get(params.spaceId, params.tenantId) as { folder: string; execution_mode: string } | undefined;

    if (!spaceRow) {
      throw new Error(`Target space "${params.spaceId}" not found for tenant`);
    }
    if (spaceRow.execution_mode !== 'host') {
      throw new Error(`Script tasks can only execute in host mode spaces (current mode: ${spaceRow.execution_mode})`);
    }
    if (!folder) {
      folder = spaceRow.folder;
    }

    const userRow = options.db
      .prepare('SELECT username FROM users WHERE id = ?')
      .get(params.tenantId) as { username: string } | undefined;
    const username = userRow?.username || params.tenantId;

    const dataRoots = [
      options.dataRoot,
      options.dshHome,
      process.env.ENKEEP_DATA_DIR,
      process.env.DSH_HOME,
      path.join(process.cwd(), '.demo-data'),
      path.join(process.cwd(), 'data'),
    ].filter((r): r is string => typeof r === 'string' && r.trim().length > 0);

    const candidates: string[] = [];
    for (const root of dataRoots) {
      candidates.push(path.join(root, 'host-runtimes', username, 'spaces', folder));
      candidates.push(path.join(root, 'host-runtimes', params.tenantId, 'spaces', folder));
      candidates.push(path.join(root, 'host-runtimes', username, '.dsh', 'spaces', folder));
      candidates.push(path.join(root, 'spaces', folder));
    }

    for (const cand of candidates) {
      if (fs.existsSync(cand)) {
        return cand;
      }
    }

    const primaryRoot = dataRoots[0] || path.join(process.cwd(), '.demo-data');
    const defaultHostPath = path.join(primaryRoot, 'host-runtimes', username, 'spaces', folder);
    if (!fs.existsSync(defaultHostPath)) {
      try {
        fs.mkdirSync(defaultHostPath, { recursive: true });
      } catch {}
    }
    return defaultHostPath;
  };

  return new AgentPromptTaskWorker({
    workerId: resolvedWorkerId,
    tenantEnumerator,
    getTenantOperations,
    dispatcher: options.dispatcher,
    pollIntervalMs: options.pollIntervalMs,
    leaseDurationMs: options.leaseDurationMs,
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    defaultExecutionBudgetMs: options.defaultExecutionBudgetMs ?? DEFAULT_TASK_EXECUTION_BUDGET_MS,
    systemRecovery: () => operationsStorage.recoverAfterRestart(),
    channelRuntimeManager: options.channelRuntimeManager,
    wechatRuntimeManager: options.wechatRuntimeManager,
    prepareTaskInput: taskPreparerHook,
    resolveSpaceCwd,
    db: options.db,
  });
}
