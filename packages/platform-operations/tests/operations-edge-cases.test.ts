import { describe, it, expect, beforeEach } from 'vitest';
import { FakePlatformOperationsStorage } from './support/index.js';
import { PlatformOperationsService } from '../src/services/platform-operations-service.js';
import {
  ValidationError,
  QuotaExceededError,
  TaskConflictError,
  TaskAlreadyCompletedError,
  TaskNotFoundError,
} from '../src/errors/index.js';
import { TASK_PROTOCOL_ERROR_CODES } from '../src/types/task.js';

describe('Platform Operations Comprehensive Edge Cases', () => {
  let storage: FakePlatformOperationsStorage;
  let service: PlatformOperationsService;

  beforeEach(() => {
    storage = new FakePlatformOperationsStorage();
    service = new PlatformOperationsService({ storage });
  });

  describe('Input validation', () => {
    it('rejects invalid inputs on messages, files, tasks, and quota', async () => {
      const ops = service.forTenant('user_1');

      // Invalid message input
      await expect(
        ops.messages.sendMessage({ recipient: '', content: 'hello' })
      ).rejects.toThrow(ValidationError);
      await expect(
        ops.messages.sendMessage({ recipient: 'alice', content: null as any })
      ).rejects.toThrow(ValidationError);

      // Invalid file input
      await expect(
        ops.files.sendFile({ recipient: '', path: 'test.txt' })
      ).rejects.toThrow(ValidationError);
      await expect(
        ops.files.sendFile({ recipient: 'alice', path: '   ' })
      ).rejects.toThrow(ValidationError);

      // Invalid task input
      await expect(
        ops.tasks.createTask({ title: '' })
      ).rejects.toThrow(ValidationError);
      await expect(
        ops.tasks.claimTask({ claimantId: '' })
      ).rejects.toThrow(ValidationError);

      // Invalid quota input
      await expect(
        ops.quota.reserveQuota({ resource: 'tokens', amount: -10 })
      ).rejects.toThrow(ValidationError);
      await expect(
        ops.quota.setLimit({ resource: 'tokens', limit: -5 })
      ).rejects.toThrow(ValidationError);
      await expect(
        ops.quota.consumeQuota({ resource: 'tokens', amount: 0 })
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('Direct Quota Consumption and Limits', () => {
    it('handles exact limit boundary correctly', async () => {
      const ops = service.forTenant('user_boundary');
      await ops.quota.setLimit({ resource: 'tokens', limit: 100 });

      // Consume exactly 100
      const summary1 = await ops.quota.consumeQuota({ resource: 'tokens', amount: 100 });
      expect(summary1.used).toBe(100);
      expect(summary1.remaining).toBe(0);
      expect(summary1.allowed).toBe(false);

      // 1 more token -> fails
      await expect(
        ops.quota.consumeQuota({ resource: 'tokens', amount: 1 })
      ).rejects.toThrow(QuotaExceededError);

      // Check overall query
      const overall = await ops.quota.checkQuota();
      expect(overall.allowed).toBe(false);
      expect(overall.usage['tokens']).toBe(100);
      expect(overall.remaining['tokens']).toBe(0);
    });

    it('handles committing a reservation with a larger actual amount', async () => {
      const ops = service.forTenant('user_over');
      await ops.quota.setLimit({ resource: 'tokens', limit: 1000 });

      const res = await ops.quota.reserveQuota({ resource: 'tokens', amount: 200 });

      // LLM used 250 tokens instead of reserved 200
      const { reservation, usage } = await ops.quota.commitQuota({
        reservationId: res.id,
        actualAmount: 250,
      });

      expect(reservation.status).toBe('committed');
      expect(reservation.committedAmount).toBe(250);
      expect(usage.used).toBe(250);
      expect(usage.remaining).toBe(750);
    });
  });

  describe('Task State Machine Edge Cases', () => {
    it('handles task cancellation and rejects operations on cancelled tasks', async () => {
      const ops = service.forTenant('user_task');

      const { task } = await ops.tasks.createTask({
        title: 'Cancel me',
        priority: 'urgent',
        payload: {
          type: 'agent_prompt',
          prompt: 'Cancel test',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
        },
      });

      const cancelled = await ops.tasks.cancelTask(task.id);
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.error).toBe(TASK_PROTOCOL_ERROR_CODES.CANCELLED);

      // Cannot claim cancelled task
      await expect(
        ops.tasks.claimTask({
          claimantId: 'worker_1',
          preferredTaskId: task.id,
        })
      ).rejects.toThrow(TaskConflictError);

      // Cannot complete cancelled task
      await expect(
        ops.tasks.completeTask(task.id, {
          claimantId: 'worker_1',
          result: {
            status: 'completed',
            completedAt: new Date().toISOString(),
          },
        })
      ).rejects.toThrow(TaskConflictError);
    });

    it('rejects renewing lease of a non-claimed task or unowned task', async () => {
      const ops = service.forTenant('user_task');

      const { task } = await ops.tasks.createTask({
        title: 'Pending task',
        payload: {
          type: 'agent_prompt',
          prompt: 'Pending test',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
        },
      });

      // Cannot renew pending task
      await expect(
        ops.tasks.renewLease(task.id, { claimantId: 'worker_1' })
      ).rejects.toThrow(TaskConflictError);

      // Non-existent task throws TaskNotFoundError
      await expect(
        ops.tasks.renewLease('task_00000000000000000000000000000000', { claimantId: 'worker_1' })
      ).rejects.toThrow(TaskNotFoundError);
    });
  });

  describe('Pagination & Listing Filtering', () => {
    it('supports listing and pagination for files, tasks, and receipts', async () => {
      const ops = service.forTenant('user_paged');

      // Create 5 tasks
      for (let i = 1; i <= 5; i++) {
        await ops.tasks.createTask({
          title: `Task ${i}`,
          priority: i % 2 === 0 ? 'high' : 'low',
          payload: {
            type: 'agent_prompt',
            prompt: `Task ${i} prompt`,
            sessionId: 'ses_0123456789abcdef0123456789abcdef',
            sessionPolicy: 'existing_session',
          },
        });
      }

      const highTasks = await ops.tasks.listTasks({ priority: 'high' });
      expect(highTasks).toHaveLength(2);

      const pagedTasks = await ops.tasks.listTasks({ limit: 2, offset: 0 });
      expect(pagedTasks).toHaveLength(2);

      // Create files for 2 recipients
      await ops.files.sendFile({ recipient: 'alice', path: 'file1.txt' });
      await ops.files.sendFile({ recipient: 'alice', path: 'file2.txt' });
      await ops.files.sendFile({ recipient: 'bob', path: 'file3.txt' });

      const aliceFiles = await ops.files.listFiles();
      expect(aliceFiles).toHaveLength(3);
    });
  });

  describe('Authoritative Persistent ID Formats', () => {
    it('generates full 32-hex 128-bit UUID IDs for tasks, files, messages, and delivery receipts', async () => {
      const ops = service.forTenant('user_id_format');

      // 1. Task ID format (task_ + 32 lowercase hex)
      const { task } = await ops.tasks.createTask({
        title: 'Task with generated ID',
        payload: {
          type: 'agent_prompt',
          prompt: 'Generated ID prompt',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
        },
      });
      expect(task.id).toMatch(/^task_[0-9a-f]{32}$/);

      // 2. Custom task ID is preserved
      const { task: customTask } = await ops.tasks.createTask({
        id: 'task_11111111111111111111111111111111',
        title: 'Custom ID Task',
        payload: {
          type: 'agent_prompt',
          prompt: 'Custom ID prompt',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
        },
      });
      expect(customTask.id).toBe('task_11111111111111111111111111111111');

      // 3. File ID format (file_ + 32 lowercase hex)
      const fileRes = await ops.files.sendFile({ recipient: 'alice', path: 'test_id.txt' });
      expect(fileRes.fileId).toMatch(/^file_[0-9a-f]{32}$/);
      expect(fileRes.metadata.id).toMatch(/^file_[0-9a-f]{32}$/);

      // 4. Message delivery and message ID format (deliv_ + 32 lowercase hex, msg_ + 32 lowercase hex)
      const msgRes = await ops.messages.sendMessage({ recipient: 'alice', content: 'hello' });
      expect(msgRes.deliveryId).toMatch(/^deliv_[0-9a-f]{32}$/);
      expect(msgRes.messageId).toMatch(/^msg_[0-9a-f]{32}$/);

      // 5. Custom delivery ID is preserved
      const customMsgRes = await ops.messages.sendMessage({
        deliveryId: 'deliv_custom_54321',
        recipient: 'alice',
        content: 'custom delivery id',
      });
      expect(customMsgRes.deliveryId).toBe('deliv_custom_54321');
    });
  });
});
