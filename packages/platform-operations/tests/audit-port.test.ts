import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { FakePlatformOperationsStorage } from './support/index.js';
import { PlatformOperationsService } from '../src/services/platform-operations-service.js';
import { CoreAuthAuditLogAdapter } from '../src/ports/audit-port.js';
import type { AuthAuditLog, CreateAuthAuditLogInput, AuthAuditLogRepository } from '@enkeep/platform-core';

class FakeCoreAuthAuditRepo implements AuthAuditLogRepository {
  private readonly records: AuthAuditLog[] = [];

  async create(input: CreateAuthAuditLogInput): Promise<AuthAuditLog> {
    const entry: AuthAuditLog = {
      id: input.id || `audit_${randomUUID().replace(/-/g, '')}`,
      userId: input.userId ?? null,
      username: input.username,
      action: input.action,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      details: input.details ? JSON.parse(JSON.stringify(input.details)) : null,
      createdAt: new Date().toISOString(),
    };
    this.records.push(entry);
    return { ...entry };
  }

  async listByUserId(userId: string): Promise<AuthAuditLog[]> {
    return this.records.filter((r) => r.userId === userId).map((r) => ({ ...r }));
  }

  async listRecent(): Promise<AuthAuditLog[]> {
    return this.records.map((r) => ({ ...r }));
  }
}

describe('Operations Audit Port & Tenant Event Auditing', () => {
  let storage: FakePlatformOperationsStorage;
  let service: PlatformOperationsService;

  beforeEach(() => {
    storage = new FakePlatformOperationsStorage();
    service = new PlatformOperationsService({ storage });
  });

  it('records structured audit entries for message, file, task, and quota actions', async () => {
    const ops = service.forTenant('user_audit_1');

    // 1. Quota actions
    await ops.quota.setLimit({ resource: 'tokens', limit: 1000 });
    const res = await ops.quota.reserveQuota({ resource: 'tokens', amount: 300 });
    await ops.quota.commitQuota({ reservationId: res.id, actualAmount: 250 });

    // 2. Task actions
    const { task } = await ops.tasks.createTask({
      title: 'Audited Task',
      payload: {
        type: 'agent_prompt',
        prompt: 'Audited task execution',
        sessionId: 'ses_0123456789abcdef0123456789abcdef',
        sessionPolicy: 'existing_session',
      },
    });
    await ops.tasks.claimTask({ claimantId: 'worker_1', preferredTaskId: task.id });
    await ops.tasks.completeTask(task.id, {
      claimantId: 'worker_1',
      result: {
        status: 'completed',
        completedAt: new Date().toISOString(),
      },
    });

    // 3. Message actions
    await ops.messages.sendMessage({
      recipient: 'user_2',
      content: 'Audited message',
      deliveryId: 'audited_deliv_1',
    });

    // 4. File actions
    await ops.files.sendFile({
      recipient: 'user_2',
      path: 'logs/app.log',
    });

    // Query audit logs
    const logs = await service.auditLogs.query({ userId: 'user_audit_1' });
    const actions = logs.map((l) => l.action);

    expect(actions).toContain('quota_limit_updated');
    expect(actions).toContain('quota_reserved');
    expect(actions).toContain('quota_committed');
    expect(actions).toContain('task_created');
    expect(actions).toContain('task_claimed');
    expect(actions).toContain('task_completed');
    expect(actions).toContain('message_sent');
    expect(actions).toContain('message_delivered');
    expect(actions).toContain('file_dispatched');

    for (const log of logs) {
      expect(log.userId).toBe('user_audit_1');
      expect(log.createdAt).toBeDefined();
    }
  });

  it('seamlessly bridges with platform-core AuthAuditLogRepository via CoreAuthAuditLogAdapter', async () => {
    const coreAuditRepo = new FakeCoreAuthAuditRepo();
    const adapter = new CoreAuthAuditLogAdapter(coreAuditRepo);

    await adapter.record({
      userId: 'tenant_core_1',
      action: 'task_created',
      resourceType: 'task',
      resourceId: 'task_123',
      details: { foo: 'bar' },
    });

    const coreLogs = await coreAuditRepo.listByUserId('tenant_core_1');
    expect(coreLogs).toHaveLength(1);
    expect(coreLogs[0].username).toBe('tenant:tenant_core_1');
    expect(coreLogs[0].action).toBe('task_created');
    expect(coreLogs[0].details?.['resourceType']).toBe('task');
    expect(coreLogs[0].details?.['resourceId']).toBe('task_123');

    const queriedThroughAdapter = await adapter.query({ userId: 'tenant_core_1' });
    expect(queriedThroughAdapter).toHaveLength(1);
    expect(queriedThroughAdapter[0].action).toBe('task_created');
    expect(queriedThroughAdapter[0].resourceId).toBe('task_123');
  });
});
