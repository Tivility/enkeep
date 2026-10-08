/**
 * Background Task Delegation Factory for DeliveryTurnExecutor
 *
 * Resolves runtime handle for user space via resolveRuntimeForSpace and delegates
 * listBackgroundTasks and stopBackgroundTask calls to host or container handle.
 *
 * @module @enkeep/demo-runner/up/background-delegates
 */

import type { BackgroundTask } from '@enkeep/platform-server';
import type { UserRuntimeHandle } from '../ports/index.js';

export interface BackgroundTaskDelegates {
  listBackgroundTasks(req: {
    userId: string;
    platformSpaceId: string;
    dshSessionId: string;
  }): Promise<BackgroundTask[]>;
  stopBackgroundTask(req: {
    userId: string;
    platformSpaceId: string;
    dshSessionId: string;
    taskId: string;
  }): Promise<{ stopped: boolean }>;
}

export type RuntimeSpaceResolver = (
  userId: string,
  platformSpaceId: string,
  requestWorkspaceFolder?: string
) => Promise<{
  handle: UserRuntimeHandle | {
    listBackgroundTasks?: (sessionId: string) => Promise<BackgroundTask[]>;
    stopBackgroundTask?: (sessionId: string, taskId: string) => Promise<{ stopped: boolean }>;
    rawHandle?: {
      listBackgroundTasks?: (sessionId: string) => Promise<BackgroundTask[]>;
      stopBackgroundTask?: (sessionId: string, taskId: string) => Promise<{ stopped: boolean }>;
    };
  };
  isHost?: boolean;
  spaceFolder?: string;
}>;

/**
 * Creates background task delegates that resolve runtime handle per space and dispatch queries/stops.
 */
export function createBackgroundTaskDelegates(
  resolveRuntimeForSpace: RuntimeSpaceResolver
): BackgroundTaskDelegates {
  return {
    async listBackgroundTasks(req: {
      userId: string;
      platformSpaceId: string;
      dshSessionId: string;
    }): Promise<BackgroundTask[]> {
      const { userId, platformSpaceId, dshSessionId } = req;
      if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
        throw new Error('FAIL-CLOSED: Mandatory userId missing or empty in listBackgroundTasks');
      }
      if (!platformSpaceId || typeof platformSpaceId !== 'string' || platformSpaceId.trim().length === 0) {
        throw new Error('FAIL-CLOSED: Mandatory platformSpaceId missing or empty in listBackgroundTasks');
      }
      if (!dshSessionId || typeof dshSessionId !== 'string' || dshSessionId.trim().length === 0) {
        throw new Error('FAIL-CLOSED: Mandatory dshSessionId missing or empty in listBackgroundTasks');
      }

      const { handle } = await resolveRuntimeForSpace(userId, platformSpaceId);
      if (typeof handle.listBackgroundTasks === 'function') {
        return await handle.listBackgroundTasks(dshSessionId);
      }
      if (handle.rawHandle && typeof handle.rawHandle.listBackgroundTasks === 'function') {
        return await handle.rawHandle.listBackgroundTasks(dshSessionId);
      }
      return [];
    },

    async stopBackgroundTask(req: {
      userId: string;
      platformSpaceId: string;
      dshSessionId: string;
      taskId: string;
    }): Promise<{ stopped: boolean }> {
      const { userId, platformSpaceId, dshSessionId, taskId } = req;
      if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
        throw new Error('FAIL-CLOSED: Mandatory userId missing or empty in stopBackgroundTask');
      }
      if (!platformSpaceId || typeof platformSpaceId !== 'string' || platformSpaceId.trim().length === 0) {
        throw new Error('FAIL-CLOSED: Mandatory platformSpaceId missing or empty in stopBackgroundTask');
      }
      if (!dshSessionId || typeof dshSessionId !== 'string' || dshSessionId.trim().length === 0) {
        throw new Error('FAIL-CLOSED: Mandatory dshSessionId missing or empty in stopBackgroundTask');
      }
      if (!taskId || typeof taskId !== 'string' || taskId.trim().length === 0) {
        throw new Error('FAIL-CLOSED: Mandatory taskId missing or empty in stopBackgroundTask');
      }

      const { handle } = await resolveRuntimeForSpace(userId, platformSpaceId);
      if (typeof handle.stopBackgroundTask === 'function') {
        return await handle.stopBackgroundTask(dshSessionId, taskId);
      }
      if (handle.rawHandle && typeof handle.rawHandle.stopBackgroundTask === 'function') {
        return await handle.rawHandle.stopBackgroundTask(dshSessionId, taskId);
      }
      return { stopped: false };
    },
  };
}
