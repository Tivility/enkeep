/**
 * Typed Management Operations Adapter
 *
 * Bridges the canonical PlatformOperationsService to the single-shape ManagementOperationsProvider contract.
 *
 * @module @enkeep/platform-server/operations/management-adapter
 */

import type { PlatformOperationsService, CreateTaskInput } from '@enkeep/platform-operations';
import type {
  ManagementOperationsProvider,
  StrictCreateTaskInput,
  StrictSetQuotaLimitInput,
  CheckQuotaQuery,
  CheckQuotaResult,
  TenantQuotaLimit,
  SafeTask,
} from '../management/types.js';

export function createManagementOperationsAdapter(
  operationsService: PlatformOperationsService
): ManagementOperationsProvider & { forTenant: (userId: string) => ReturnType<PlatformOperationsService['forTenant']> } {
  return {
    forTenant(userId: string) {
      return operationsService.forTenant(userId);
    },

    async createTask(userId: string, input: StrictCreateTaskInput): Promise<{ task: SafeTask; isIdempotentHit: boolean }> {
      const tenantOps = operationsService.forTenant(userId);
      const taskInput: CreateTaskInput = {
        idempotencyKey: input.idempotencyKey,
        title: input.title,
        priority: input.priority,
        payload: input.payload,
        dueDate: input.dueDate,
        scheduleType: input.scheduleType,
        cronExpression: input.cronExpression,
        intervalSeconds: input.intervalSeconds,
        timezone: input.timezone,
        misfirePolicy: input.misfirePolicy,
        overlapPolicy: input.overlapPolicy,
      };
      return tenantOps.tasks.createTask(taskInput);
    },

    async cancelTask(userId: string, taskId: string): Promise<SafeTask> {
      const tenantOps = operationsService.forTenant(userId);
      return tenantOps.tasks.cancelTask(taskId);
    },

    async pauseTask(userId: string, taskId: string): Promise<SafeTask> {
      const tenantOps = operationsService.forTenant(userId);
      return tenantOps.tasks.pauseTask(taskId);
    },

    async resumeTask(userId: string, taskId: string): Promise<SafeTask> {
      const tenantOps = operationsService.forTenant(userId);
      return tenantOps.tasks.resumeTask(taskId);
    },

    async getTask(userId: string, taskId: string): Promise<SafeTask | null> {
      const tenantOps = operationsService.forTenant(userId);
      return tenantOps.tasks.getTask(taskId);
    },

    async setQuotaLimit(userId: string, input: StrictSetQuotaLimitInput): Promise<TenantQuotaLimit> {
      const tenantOps = operationsService.forTenant(userId);
      return tenantOps.quota.setLimit(input);
    },

    async checkQuota(userId: string, query?: CheckQuotaQuery): Promise<CheckQuotaResult> {
      const tenantOps = operationsService.forTenant(userId);
      return tenantOps.quota.checkQuota(query);
    },
  };
}
