import { describe, it, expect, beforeEach } from 'vitest';
import { TaskOperationService } from '../src/services/task-operation-service.js';
import { FakeTenantScopedTaskRepository } from './support/fake-task-repo.js';
import { FakeOperationsAuditPort } from './support/fake-audit-repo.js';
import {
  ValidationError,
  TaskNotFoundError,
  TaskAlreadyClaimedError,
  TaskAlreadyCompletedError,
  TaskConflictError,
} from '../src/errors/index.js';
import type { TaskPriority } from '../src/types/task.js';

describe('Task Update Domain Operation & Fake Repository (G07)', () => {
  const tenantA = 'usr_tenant_alpha_001';
  const tenantB = 'usr_tenant_bravo_002';

  let repoA: FakeTenantScopedTaskRepository;
  let auditLogsA: FakeOperationsAuditPort;
  let serviceA: TaskOperationService;

  beforeEach(() => {
    repoA = new FakeTenantScopedTaskRepository(tenantA);
    auditLogsA = new FakeOperationsAuditPort();
    serviceA = new TaskOperationService({
      tasks: repoA,
      auditLogs: auditLogsA,
    });
  });

  describe('1. Editable Fields & Payload Merging', () => {
    it('updates title, description, assignee, and priority successfully', async () => {
      const { task: created } = await serviceA.createTask({
        title: 'Original Title',
        description: 'Original Desc',
        assignee: 'worker-1',
        priority: 'low',
        payload: {
          type: 'agent_prompt',
          prompt: 'Echo hello',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
          spaceId: 'spc_0123456789abcdef0123456789abcdef',
        },
      });

      const updated = await serviceA.updateTask(created.id, {
        title: 'New Title',
        description: 'Updated Desc',
        assignee: 'worker-2',
        priority: 'urgent',
      });

      expect(updated.title).toBe('New Title');
      expect(updated.description).toBe('Updated Desc');
      expect(updated.assignee).toBe('worker-2');
      expect(updated.priority).toBe('urgent');
      expect(updated.payload.prompt).toBe('Echo hello');
      expect(updated.payload.sessionId).toBe('ses_0123456789abcdef0123456789abcdef');
      expect(updated.payload.spaceId).toBe('spc_0123456789abcdef0123456789abcdef');

      // Audit log check
      const logs = await auditLogsA.query({ resourceId: created.id });
      const updateLog = logs.find((l) => l.action === 'task_updated');
      expect(updateLog).toBeDefined();
      expect(updateLog?.details).toMatchObject({
        title: 'New Title',
        priority: 'urgent',
      });
    });

    it('updates prompt via root prompt field while preserving immutable payload bindings', async () => {
      const { task: created } = await serviceA.createTask({
        title: 'Prompt Update Task',
        payload: {
          type: 'agent_prompt',
          prompt: 'Initial prompt text',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
          spaceId: 'spc_0123456789abcdef0123456789abcdef',
          spaceFolder: 'subfolder',
        },
      });

      const updated = await serviceA.updateTask(created.id, {
        prompt: 'Updated prompt instructions for worker',
      });

      expect(updated.payload.prompt).toBe('Updated prompt instructions for worker');
      expect(updated.payload.sessionId).toBe('ses_0123456789abcdef0123456789abcdef');
      expect(updated.payload.sessionPolicy).toBe('existing_session');
      expect(updated.payload.spaceId).toBe('spc_0123456789abcdef0123456789abcdef');
      expect(updated.payload.spaceFolder).toBe('subfolder');
      expect(updated.payload.type).toBe('agent_prompt');
    });

    it('updates prompt via payload.prompt field', async () => {
      const { task: created } = await serviceA.createTask({
        title: 'Payload Prompt Task',
        payload: {
          type: 'agent_prompt',
          prompt: 'Initial',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
        },
      });

      const updated = await serviceA.updateTask(created.id, {
        payload: {
          prompt: 'Prompt through payload object',
        },
      });

      expect(updated.payload.prompt).toBe('Prompt through payload object');
      expect(updated.payload.sessionId).toBe('ses_0123456789abcdef0123456789abcdef');
    });
  });

  describe('2. Immutable Fields Protection', () => {
    it('rejects attempt to alter ownership (userId)', async () => {
      const { task: created } = await serviceA.createTask({
        title: 'Task Alpha',
        payload: {
          type: 'agent_prompt',
          prompt: 'Do work',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
        },
      });

      await expect(
        serviceA.updateTask(created.id, {
          userId: 'usr_malicious_attacker',
        } as any)
      ).rejects.toThrow(ValidationError);

      await expect(
        serviceA.updateTask(created.id, {
          user_id: 'usr_malicious_attacker',
        } as any)
      ).rejects.toThrow('Task ownership is immutable');
    });

    it('rejects attempt to alter task ID or status directly', async () => {
      const { task: created } = await serviceA.createTask({
        title: 'Task Alpha',
        payload: {
          type: 'agent_prompt',
          prompt: 'Do work',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
        },
      });

      await expect(
        serviceA.updateTask(created.id, {
          id: 'task_00000000000000000000000000000000',
        } as any)
      ).rejects.toThrow('Field "id" is immutable and cannot be updated');

      await expect(
        serviceA.updateTask(created.id, {
          status: 'completed',
        } as any)
      ).rejects.toThrow('Field "status" is immutable');
    });

    it('rejects attempt to alter session or space bindings in payload', async () => {
      const { task: created } = await serviceA.createTask({
        title: 'Task Alpha',
        payload: {
          type: 'agent_prompt',
          prompt: 'Do work',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
          spaceId: 'spc_0123456789abcdef0123456789abcdef',
        },
      });

      await expect(
        serviceA.updateTask(created.id, {
          payload: {
            prompt: 'Valid prompt',
            sessionId: 'ses_9999999999abcdef0123456789abcdef',
          } as any,
        })
      ).rejects.toThrow('Task session and space bindings are immutable');

      await expect(
        serviceA.updateTask(created.id, {
          payload: {
            prompt: 'Valid prompt',
            spaceId: 'spc_9999999999abcdef0123456789abcdef',
          } as any,
        })
      ).rejects.toThrow('Task session and space bindings are immutable');
    });

    it('rejects update with no editable fields', async () => {
      const { task: created } = await serviceA.createTask({
        title: 'Task Alpha',
        payload: {
          type: 'agent_prompt',
          prompt: 'Do work',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
        },
      });

      await expect(serviceA.updateTask(created.id, {})).rejects.toThrow(
        'At least one editable field must be provided'
      );
    });
  });

  describe('3. Concurrency & Busy Worker Protection (Section 4)', () => {
    it('rejects update when task is claimed by an active worker (409 TaskAlreadyClaimedError)', async () => {
      const { task: created } = await serviceA.createTask({
        title: 'Claimed Task',
        payload: {
          type: 'agent_prompt',
          prompt: 'Do work',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
        },
      });

      // Worker claims task
      const claimed = await serviceA.claimTask({
        claimantId: 'worker-node-1',
        preferredTaskId: created.id,
      });
      expect(claimed).not.toBeNull();

      // Attempt to update while claimed
      await expect(
        serviceA.updateTask(created.id, {
          title: 'Modified During Claim',
        })
      ).rejects.toThrow(TaskAlreadyClaimedError);
    });

    it('rejects update when single task is completed (TaskAlreadyCompletedError)', async () => {
      const { task: created } = await serviceA.createTask({
        title: 'Once Task',
        scheduleType: 'once',
        payload: {
          type: 'agent_prompt',
          prompt: 'Single run',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
        },
      });

      const claimed = await serviceA.claimTask({
        claimantId: 'worker-node-1',
        preferredTaskId: created.id,
      });

      await serviceA.completeTask(created.id, {
        claimantId: 'worker-node-1',
        result: {
          status: 'completed',
          completedAt: new Date().toISOString(),
        },
        runId: claimed?.currentRun?.id,
      });

      // Terminal single task rejects update
      await expect(
        serviceA.updateTask(created.id, {
          title: 'Update After Complete',
        })
      ).rejects.toThrow(TaskAlreadyCompletedError);
    });

    it('rejects update when single task is cancelled', async () => {
      const { task: created } = await serviceA.createTask({
        title: 'Cancelled Task',
        payload: {
          type: 'agent_prompt',
          prompt: 'Single run',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
        },
      });

      await serviceA.cancelTask(created.id);

      await expect(
        serviceA.updateTask(created.id, {
          prompt: 'New prompt for cancelled task',
        })
      ).rejects.toThrow(TaskAlreadyCompletedError);
    });

    it('allows updating a recurring task that has returned to pending after completion', async () => {
      const { task: created } = await serviceA.createTask({
        title: 'Recurring Cron Task',
        scheduleType: 'cron',
        cronExpression: '0 4 * * *',
        payload: {
          type: 'agent_prompt',
          prompt: 'Daily run',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
        },
      });

      // Claim at the task's due time
      const claimed = await serviceA.claimTask({
        claimantId: 'worker-1',
        preferredTaskId: created.id,
        now: created.nextRunAt!,
      });
      expect(claimed).not.toBeNull();

      const completed = await serviceA.completeTask(created.id, {
        claimantId: 'worker-1',
        result: {
          status: 'completed',
          completedAt: new Date().toISOString(),
        },
        runId: claimed?.currentRun?.id,
      });

      expect(completed.status).toBe('pending');

      // Now safe to update in idle pending state
      const updated = await serviceA.updateTask(created.id, {
        title: 'Updated Daily Cron Task',
        prompt: 'Daily run with new instructions',
      });

      expect(updated.title).toBe('Updated Daily Cron Task');
      expect(updated.payload.prompt).toBe('Daily run with new instructions');
      expect(updated.status).toBe('pending');
    });

    it('allows updating a paused recurring task (schedule.enabled === false)', async () => {
      const { task: created } = await serviceA.createTask({
        title: 'Cron To Pause',
        scheduleType: 'cron',
        cronExpression: '0 4 * * *',
        payload: {
          type: 'agent_prompt',
          prompt: 'Run at 4',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
        },
      });

      await serviceA.pauseTask(created.id);

      const updated = await serviceA.updateTask(created.id, {
        cronExpression: '0 5 * * *',
        title: 'Run at 5',
      });

      expect(updated.title).toBe('Run at 5');
      expect(updated.schedule?.cronExpression).toBe('0 5 * * *');
      // Paused schedule has null nextRunAt
      expect(updated.nextRunAt).toBeNull();

      // Resume recalculates with updated cron '0 5 * * *'
      const resumed = await serviceA.resumeTask(created.id, '2026-06-01T00:00:00.000Z');
      expect(resumed.schedule?.nextRunAt).toBe('2026-06-01T05:00:00.000Z');
      expect(resumed.schedule?.cronExpression).toBe('0 5 * * *');
    });
  });

  describe('4. Schedule Recomputation & Conversion', () => {
    it('recomputes next_run_at when cronExpression is modified', async () => {
      const { task: created } = await serviceA.createTask({
        title: 'Cron 4am',
        scheduleType: 'cron',
        cronExpression: '0 4 * * *',
        payload: {
          type: 'agent_prompt',
          prompt: 'Work',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
        },
      });

      const updated = await serviceA.updateTask(created.id, {
        cronExpression: '0 12 * * *',
      });

      expect(updated.schedule?.cronExpression).toBe('0 12 * * *');
      expect(updated.cronExpression).toBe('0 12 * * *');
      expect(updated.nextRunAt).not.toBe(created.nextRunAt);
      expect(updated.schedule?.nextRunAt).toBe(updated.nextRunAt);
    });

    it('recomputes next_run_at when intervalSeconds is modified', async () => {
      const { task: created } = await serviceA.createTask({
        title: 'Interval 60s',
        scheduleType: 'interval',
        intervalSeconds: 60,
        payload: {
          type: 'agent_prompt',
          prompt: 'Sync',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
        },
      });

      const updated = await serviceA.updateTask(created.id, {
        intervalSeconds: 300,
      });

      expect(updated.schedule?.intervalSeconds).toBe(300);
      expect(updated.intervalSeconds).toBe(300);
      expect(updated.nextRunAt).toBeDefined();
    });

    it('converts once task to cron schedule and establishes schedule row', async () => {
      const { task: created } = await serviceA.createTask({
        title: 'Originally Once Task',
        scheduleType: 'once',
        payload: {
          type: 'agent_prompt',
          prompt: 'Run once',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
        },
      });

      expect(created.scheduleType).toBe('once');

      const updated = await serviceA.updateTask(created.id, {
        scheduleType: 'cron',
        cronExpression: '30 8 * * *',
      });

      expect(updated.scheduleType).toBe('cron');
      expect(updated.cronExpression).toBe('30 8 * * *');
      expect(updated.schedule).toBeDefined();
      expect(updated.schedule?.scheduleType).toBe('cron');
      expect(updated.schedule?.cronExpression).toBe('30 8 * * *');
      expect(updated.nextRunAt).toBeDefined();
    });

    it('updates dueDate for once task and recomputes nextRunAt', async () => {
      const { task: created } = await serviceA.createTask({
        title: 'Due Date Task',
        scheduleType: 'once',
        dueDate: '2026-10-01T10:00:00.000Z',
        payload: {
          type: 'agent_prompt',
          prompt: 'Run at due',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
        },
      });

      const updated = await serviceA.updateTask(created.id, {
        dueDate: '2026-11-01T12:00:00.000Z',
      });

      expect(updated.dueDate).toBe('2026-11-01T12:00:00.000Z');
      expect(updated.nextRunAt).toBe('2026-11-01T12:00:00.000Z');
    });
  });

  describe('5. Tenant Isolation', () => {
    it('rejects update across tenants (Tenant B cannot update Tenant A task)', async () => {
      const { task: created } = await serviceA.createTask({
        title: 'Tenant A Task',
        payload: {
          type: 'agent_prompt',
          prompt: 'Tenant A only',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
        },
      });

      const repoB = new FakeTenantScopedTaskRepository(tenantB);
      const serviceB = new TaskOperationService({ tasks: repoB });

      await expect(
        serviceB.updateTask(created.id, {
          title: 'Tampered by Tenant B',
        })
      ).rejects.toThrow(TaskNotFoundError);
    });
  });
});
