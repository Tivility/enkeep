import type {
  OperationAuditLog,
  CreateOperationAuditLogInput,
  AuditQueryOptions,
} from '../types/audit.js';
import type { AuthAuditLogRepository } from '@enkeep/platform-core';

/**
 * Port for recording operations audit events.
 * All audit records are tenant-scoped and immutable.
 */
export interface OperationsAuditPort {
  record(input: CreateOperationAuditLogInput): Promise<OperationAuditLog>;
  query(options: AuditQueryOptions): Promise<OperationAuditLog[]>;
}

/**
 * Adapter that maps OperationsAuditPort onto platform-core AuthAuditLogRepository
 * if a custom audit sink is not provided.
 */
export class CoreAuthAuditLogAdapter implements OperationsAuditPort {
  constructor(private readonly authAuditRepo: AuthAuditLogRepository) {}

  async record(input: CreateOperationAuditLogInput): Promise<OperationAuditLog> {
    const coreRecord = await this.authAuditRepo.create({
      id: input.id,
      userId: input.userId,
      username: `tenant:${input.userId}`,
      action: input.action as any,
      details: {
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        ...input.details,
      },
    });

    return {
      id: coreRecord.id,
      userId: input.userId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      details: input.details,
      createdAt: coreRecord.createdAt,
    };
  }

  async query(options: AuditQueryOptions): Promise<OperationAuditLog[]> {
    let logs;
    if (options.userId) {
      logs = await this.authAuditRepo.listByUserId(options.userId, {
        limit: options.limit,
        offset: options.offset,
      });
    } else {
      logs = await this.authAuditRepo.listRecent({
        limit: options.limit,
        offset: options.offset,
        action: options.action,
      });
    }

    let filteredLogs = logs;
    if (options.action) {
      filteredLogs = filteredLogs.filter((log) => log.action === options.action);
    }

    return filteredLogs.map((log) => ({
      id: log.id,
      userId: log.userId || options.userId || 'system',
      action: log.action,
      resourceType: (log.details?.['resourceType'] as string) || 'system',
      resourceId: (log.details?.['resourceId'] as string) || undefined,
      details: log.details || undefined,
      createdAt: log.createdAt,
    }));
  }
}
