import { randomUUID } from 'node:crypto';
import type {
  OperationsAuditPort,
} from '../../src/ports/audit-port.js';
import type {
  OperationAuditLog,
  CreateOperationAuditLogInput,
  AuditQueryOptions,
} from '../../src/types/audit.js';

export class FakeOperationsAuditPort implements OperationsAuditPort {
  readonly logs: OperationAuditLog[] = [];

  async record(input: CreateOperationAuditLogInput): Promise<OperationAuditLog> {
    const entry: OperationAuditLog = {
      id: input.id || `audit_${randomUUID().replace(/-/g, '')}`,
      userId: input.userId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      details: input.details ? JSON.parse(JSON.stringify(input.details)) : null,
      createdAt: input.createdAt || new Date().toISOString(),
    };

    this.logs.push(entry);
    return { ...entry };
  }

  async query(options: AuditQueryOptions): Promise<OperationAuditLog[]> {
    let result = [...this.logs];

    if (options.userId) {
      result = result.filter((l) => l.userId === options.userId);
    }
    if (options.action) {
      result = result.filter((l) => l.action === options.action);
    }
    if (options.resourceType) {
      result = result.filter((l) => l.resourceType === options.resourceType);
    }
    if (options.resourceId) {
      result = result.filter((l) => l.resourceId === options.resourceId);
    }
    if (options.from) {
      const fromTime = new Date(options.from).getTime();
      result = result.filter((l) => new Date(l.createdAt).getTime() >= fromTime);
    }
    if (options.to) {
      const toTime = new Date(options.to).getTime();
      result = result.filter((l) => new Date(l.createdAt).getTime() <= toTime);
    }

    result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const offset = options.offset ?? 0;
    const limit = options.limit ?? result.length;
    return result.slice(offset, offset + limit).map((l) => ({ ...l }));
  }

  clear(): void {
    this.logs.length = 0;
  }
}
