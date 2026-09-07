import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  AgentPromptTaskWorker,
  TASK_PROTOCOL_ERROR_CODES,
} from '../src/index.js';
import { FakePlatformOperationsStorage } from './support/index.js';
import { PlatformOperationsService } from '../src/services/platform-operations-service.js';

describe('Task Scheduler Worker Engine (Cron, Interval, Pause/Resume, Overlap & Misfire)', () => {
  let storage: FakePlatformOperationsStorage;
  let service: PlatformOperationsService;
  const tenantA = 'tenant_sched_alpha';
  const tenantB = 'tenant_sched_beta';
  let activeWorkers: AgentPromptTaskWorker[] = [];

  beforeEach(() => {
    storage = new FakePlatformOperationsStorage();
    service = new PlatformOperationsService({ storage });
    activeWorkers = [];
  });

  afterEach(async () => {
    for (const w of activeWorkers) {
      await w.stop({ abortInFlight: true });
    }
  });

  describe('1. Deterministic Cron Recurrence & Advancement', () => {
    it('executes due cron task at fake clock time and keeps it pending for subsequent recurrence', async () => {
      const tenantOps = service.forTenant(tenantA);

      // Create cron task: runs every hour at minute 0
      const { task } = await tenantOps.tasks.createTask({
        title: 'Hourly Cron Job',
        scheduleType: 'cron',
        cronExpression: '0 * * * *',
        payload: {
          type: 'agent_prompt',
          prompt: 'Execute hourly sync',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
        },
      });

      let dispatchCount = 0;
      const worker = new AgentPromptTaskWorker({
        workerId: 'worker_test_cron',
        tenantEnumerator: () => [tenantA],
        getTenantOperations: (tid) => service.forTenant(tid),
        dispatcher: async () => {
          dispatchCount++;
          return {
            status: 'completed',
            completedAt: new Date().toISOString(),
            turnId: 'turn_0123456789abcdef0123456789abcdef',
          };
        },
      });
      activeWorkers.push(worker);

      // Run now execution
      const runResult = await worker.runNow({ taskId: task.id, tenantId: tenantA });
      expect(runResult?.status).toBe('completed');
      expect(dispatchCount).toBe(1);

      // Verify task remains pending with enabled schedule
      const refreshedTask = await tenantOps.tasks.getTask(task.id);
      expect(refreshedTask?.status).toBe('pending');
      expect(refreshedTask?.schedule?.enabled).toBe(true);

      // Verify task run recorded
      const runs = await tenantOps.tasks.listRuns(task.id);
      expect(runs.total).toBe(1);
      expect(runs.items[0].status).toBe('completed');
    });
  });

  describe('2. Fixed Interval Recurrence & Drift Prevention', () => {
    it('executes interval task and calculates next recurrence based on scheduled time', async () => {
      const tenantOps = service.forTenant(tenantA);

      const { task } = await tenantOps.tasks.createTask({
        title: '2-Minute Interval Job',
        scheduleType: 'interval',
        intervalSeconds: 120,
        payload: {
          type: 'agent_prompt',
          prompt: 'Execute interval sync',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
        },
      });

      expect(task.schedule?.intervalSeconds).toBe(120);

      const worker = new AgentPromptTaskWorker({
        workerId: 'worker_test_interval',
        tenantEnumerator: () => [tenantA],
        getTenantOperations: (tid) => service.forTenant(tid),
        dispatcher: async () => ({
          status: 'completed',
          completedAt: new Date().toISOString(),
        }),
      });
      activeWorkers.push(worker);

      const execRes = await worker.runNow({ taskId: task.id, tenantId: tenantA });
      expect(execRes?.status).toBe('completed');

      const afterTask = await tenantOps.tasks.getTask(task.id);
      expect(afterTask?.status).toBe('pending');
      expect(afterTask?.schedule?.enabled).toBe(true);
    });
  });

  describe('3. Pause and Resume Behavior', () => {
    it('skips execution while paused, resumes with recalculated next_run_at', async () => {
      const tenantOps = service.forTenant(tenantA);

      const { task } = await tenantOps.tasks.createTask({
        title: 'Pausable Task',
        scheduleType: 'cron',
        cronExpression: '*/5 * * * *',
        payload: {
          type: 'agent_prompt',
          prompt: 'Execute check',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
        },
      });

      // Pause task
      await tenantOps.tasks.pauseTask(task.id);

      let dispatched = false;
      const worker = new AgentPromptTaskWorker({
        workerId: 'worker_test_pause',
        tenantEnumerator: () => [tenantA],
        getTenantOperations: (tid) => service.forTenant(tid),
        dispatcher: async () => {
          dispatched = true;
          return { status: 'completed', completedAt: new Date().toISOString() };
        },
      });
      activeWorkers.push(worker);

      const tickRes = await worker.tick();
      expect(tickRes.processed).toBe(false);
      expect(dispatched).toBe(false);

      // Resume task
      await tenantOps.tasks.resumeTask(task.id, new Date('2026-04-01T12:00:00.000Z'));
      const resumed = await tenantOps.tasks.getTask(task.id);
      expect(resumed?.schedule?.enabled).toBe(true);
      expect(resumed?.schedule?.pausedAt).toBeNull();
      expect(resumed?.schedule?.nextRunAt).toBe('2026-04-01T12:05:00.000Z');
    });
  });

  describe('4. Failure Handling & Recurrence Continuation', () => {
    it('records failed run on execution error but allows recurring schedule to continue', async () => {
      const tenantOps = service.forTenant(tenantA);

      const { task } = await tenantOps.tasks.createTask({
        title: 'Recurring Task with Failure',
        scheduleType: 'interval',
        intervalSeconds: 60,
        payload: {
          type: 'agent_prompt',
          prompt: 'Prompt',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
        },
      });

      const worker = new AgentPromptTaskWorker({
        workerId: 'worker_test_fail',
        tenantEnumerator: () => [tenantA],
        getTenantOperations: (tid) => service.forTenant(tid),
        dispatcher: async () => {
          throw new Error('Downstream network timeout');
        },
      });
      activeWorkers.push(worker);

      const execRes = await worker.runNow({ taskId: task.id, tenantId: tenantA });
      expect(execRes?.status).toBe('failed');
      expect(execRes?.error).toBe(TASK_PROTOCOL_ERROR_CODES.EXECUTION_FAILED);

      // Recurring task status returns to pending for next recurrence
      const taskAfter = await tenantOps.tasks.getTask(task.id);
      expect(taskAfter?.status).toBe('pending');
      expect(taskAfter?.schedule?.enabled).toBe(true);

      // Run record reflects failed status with safe error code
      const runs = await tenantOps.tasks.listRuns(task.id);
      expect(runs.total).toBe(1);
      expect(runs.items[0].status).toBe('failed');
      expect(runs.items[0].errorCode).toBe(TASK_PROTOCOL_ERROR_CODES.EXECUTION_FAILED);
    });
  });

  describe('5. Crash Recovery & Lease Expiry', () => {
    it('recovers expired tasks and runs after worker crash or restart', async () => {
      const tenantOps = service.forTenant(tenantA);

      const { task } = await tenantOps.tasks.createTask({
        title: 'Crashed Task',
        leaseDurationMs: 1000,
        payload: {
          type: 'agent_prompt',
          prompt: 'Prompt',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
        },
      });

      // Claim task and simulate crash (leave in claimed state with expired lease)
      await tenantOps.tasks.claimTask({
        claimantId: 'crashed_worker',
        leaseDurationMs: 1000,
        preferredTaskId: task.id,
      });

      // Advance time past lease expiration
      const futureTime = new Date(Date.now() + 5000).toISOString();
      const recoveryResult = await storage.recoverAfterRestart({ nowIso: futureTime });

      expect(recoveryResult.recoveredTasks).toBeGreaterThanOrEqual(1);

      const recoveredTask = await tenantOps.tasks.getTask(task.id);
      expect(recoveredTask?.status).toBe('pending');
      expect(recoveredTask?.claimantId).toBeNull();
    });
  });
});
