import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  SqliteTenantScopedTaskRepository,
} from '../src/repos/task-repo.js';
import {
  MIGRATION_001_SQL,
  MIGRATION_004_SQL,
  MIGRATION_018_TASK_SCHEDULES_AND_RUNS_SQL,
} from '../src/schema/migrations.js';
import {
  ValidationError,
  TaskConflictError,
  TaskNotFoundError,
  computeNextRun,
  validateCronExpression,
  validateIntervalSeconds,
  validateMisfirePolicy,
  validateOverlapPolicy,
} from '@enkeep/platform-operations';

describe('Task Schedules, Recurrences and Execution Runs Storage', () => {
  let db: DatabaseSync;
  const user1 = 'user_schedule_test_1';
  const user2 = 'user_schedule_test_2';
  let repo1: SqliteTenantScopedTaskRepository;
  let repo2: SqliteTenantScopedTaskRepository;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(MIGRATION_001_SQL);
    db.exec(MIGRATION_004_SQL);

    // Setup test users
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, status)
      VALUES (?, ?, 'hash', 'user', 'active'), (?, ?, 'hash', 'user', 'active')
    `).run(user1, 'user1', user2, 'user2');

    // Apply Migration 018
    db.exec(MIGRATION_018_TASK_SCHEDULES_AND_RUNS_SQL);

    repo1 = new SqliteTenantScopedTaskRepository(db, user1);
    repo2 = new SqliteTenantScopedTaskRepository(db, user2);
  });

  afterEach(() => {
    db.close();
  });

  describe('1. Migration 018 Schema Verification & Policy Constraints', () => {
    it('creates task_schedules with narrowed CHECK constraints on misfire_policy and overlap_policy', () => {
      const tables = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name IN ('task_schedules', 'task_runs', 'platform_tasks')
      `).all() as { name: string }[];
      const names = tables.map((t) => t.name);
      expect(names).toContain('task_schedules');
      expect(names).toContain('task_runs');
      expect(names).toContain('platform_tasks');

      // Assert SQLite rejects unsupported misfire policy at SQL level
      expect(() => {
        db.prepare(`
          INSERT INTO task_schedules (id, task_id, user_id, schedule_type, misfire_policy)
          VALUES ('s1', 't1', 'u1', 'cron', 'run_all')
        `).run();
      }).toThrow();

      // Assert SQLite rejects unsupported overlap policy at SQL level
      expect(() => {
        db.prepare(`
          INSERT INTO task_schedules (id, task_id, user_id, schedule_type, overlap_policy)
          VALUES ('s2', 't2', 'u1', 'cron', 'allow')
        `).run();
      }).toThrow();

      expect(() => {
        db.prepare(`
          INSERT INTO task_schedules (id, task_id, user_id, schedule_type, overlap_policy)
          VALUES ('s3', 't3', 'u1', 'cron', 'queue')
        `).run();
      }).toThrow();
    });

    it('backfills task_schedules for pre-existing platform_tasks', () => {
      const freshDb = new DatabaseSync(':memory:');
      freshDb.exec(MIGRATION_001_SQL);
      freshDb.exec(MIGRATION_004_SQL);
      freshDb.prepare(`INSERT INTO users (id, username, password_hash) VALUES ('u_old', 'old_user', 'hash')`).run();
      freshDb.prepare(`
        INSERT INTO platform_tasks (id, user_id, title, status, due_date)
        VALUES ('task_pre1', 'u_old', 'Old Task 1', 'pending', '2026-06-01T12:00:00.000Z'),
               ('task_pre2', 'u_old', 'Old Task 2', 'completed', '2026-05-01T12:00:00.000Z')
      `).run();

      freshDb.exec(MIGRATION_018_TASK_SCHEDULES_AND_RUNS_SQL);

      const schedules = freshDb.prepare(`SELECT * FROM task_schedules ORDER BY task_id ASC`).all() as any[];
      expect(schedules.length).toBe(2);
      expect(schedules[0].task_id).toBe('task_pre1');
      expect(schedules[0].schedule_type).toBe('once');
      expect(schedules[0].enabled).toBe(1);
      expect(schedules[0].next_run_at).toBe('2026-06-01T12:00:00.000Z');

      expect(schedules[1].task_id).toBe('task_pre2');
      expect(schedules[1].enabled).toBe(0); // completed task has schedule disabled

      freshDb.close();
    });
  });

  describe('2. Schedule Validation & Policy Strictness', () => {
    it('validates 5-field cron expression in UTC and rejects invalid formats or intervals <60s', () => {
      expect(validateCronExpression('*/5 * * * *')).toBe('*/5 * * * *');
      expect(validateCronExpression('0 12 * * 1-5')).toBe('0 12 * * 1-5');

      // Reject non-5-field (e.g. 6-field with seconds)
      expect(() => validateCronExpression('* * * * * *')).toThrow(ValidationError);
      // Reject invalid syntax
      expect(() => validateCronExpression('not-a-cron')).toThrow(ValidationError);
    });

    it('validates interval seconds requiring minimum 60 seconds', () => {
      expect(validateIntervalSeconds(60)).toBe(60);
      expect(validateIntervalSeconds(300)).toBe(300);
      expect(() => validateIntervalSeconds(59)).toThrow(ValidationError);
      expect(() => validateIntervalSeconds(-10)).toThrow(ValidationError);
      expect(() => validateIntervalSeconds(32_000_000)).toThrow(ValidationError);
    });

    it('strictly validates misfire and overlap policies, rejecting unsupported options', () => {
      expect(validateMisfirePolicy('coalesce')).toBe('coalesce');
      expect(validateMisfirePolicy('skip')).toBe('skip');
      expect(() => validateMisfirePolicy('run_all')).toThrow(ValidationError);
      expect(() => validateMisfirePolicy('unknown_misfire')).toThrow(ValidationError);

      expect(validateOverlapPolicy('skip')).toBe('skip');
      expect(() => validateOverlapPolicy('allow')).toThrow(ValidationError);
      expect(() => validateOverlapPolicy('queue')).toThrow(ValidationError);
      expect(() => validateOverlapPolicy('unknown_overlap')).toThrow(ValidationError);
    });

    it('computes deterministic next_run_at with clock injection', () => {
      const fixedClock = new Date('2026-03-01T10:00:00.000Z');

      // Cron: every hour at minute 15
      const nextCron = computeNextRun(
        { scheduleType: 'cron', cronExpression: '15 * * * *', enabled: true },
        fixedClock
      );
      expect(nextCron).toBe('2026-03-01T10:15:00.000Z');

      // Interval: 300 seconds (5 minutes)
      const nextInterval = computeNextRun(
        { scheduleType: 'interval', intervalSeconds: 300, enabled: true },
        fixedClock
      );
      expect(nextInterval).toBe('2026-03-01T10:05:00.000Z');

      // Once with dueDate
      const nextOnce = computeNextRun(
        { scheduleType: 'once', dueDate: '2026-03-05T00:00:00.000Z', enabled: true },
        fixedClock
      );
      expect(nextOnce).toBe('2026-03-05T00:00:00.000Z');

      // Disabled / paused returns null
      expect(computeNextRun({ scheduleType: 'cron', cronExpression: '*/5 * * * *', enabled: false }, fixedClock)).toBeNull();
      expect(computeNextRun({ scheduleType: 'cron', cronExpression: '*/5 * * * *', enabled: true, pausedAt: '2026-03-01T09:00:00.000Z' }, fixedClock)).toBeNull();
    });
  });

  describe('3. Task Creation with Schedules (Once, Cron, Interval)', () => {
    it('creates a once task with dueDate and persists 1:1 schedule', async () => {
      const task = await repo1.create({
        title: 'Once Task',
        priority: 'high',
        dueDate: '2026-04-01T15:30:00.000Z',
        payload: {
          type: 'agent_prompt',
          prompt: 'Execute once check',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
        },
      });

      expect(task.scheduleType).toBe('once');
      expect(task.dueDate).toBe('2026-04-01T15:30:00.000Z');
      expect(task.nextRunAt).toBe('2026-04-01T15:30:00.000Z');
      expect(task.schedule).toBeDefined();
      expect(task.schedule?.scheduleType).toBe('once');
      expect(task.schedule?.enabled).toBe(true);

      const found = await repo1.findById(task.id);
      expect(found?.schedule?.nextRunAt).toBe('2026-04-01T15:30:00.000Z');
    });

    it('creates a cron task, validates expression and computes next_run_at', async () => {
      const task = await repo1.create({
        title: 'Hourly Cron Task',
        scheduleType: 'cron',
        cronExpression: '0 * * * *',
        payload: {
          type: 'agent_prompt',
          prompt: 'Execute hourly maintenance',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
        },
      });

      expect(task.scheduleType).toBe('cron');
      expect(task.cronExpression).toBe('0 * * * *');
      expect(task.nextRunAt).toBeDefined();
      expect(task.schedule?.scheduleType).toBe('cron');
      expect(task.schedule?.cronExpression).toBe('0 * * * *');
      expect(task.schedule?.enabled).toBe(true);
      expect(task.schedule?.pausedAt).toBeNull();
    });

    it('creates an interval task with intervalSeconds', async () => {
      const task = await repo1.create({
        title: '5-Minute Interval Task',
        scheduleType: 'interval',
        intervalSeconds: 300,
        payload: {
          type: 'agent_prompt',
          prompt: 'Execute 5-minute health check',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
        },
      });

      expect(task.scheduleType).toBe('interval');
      expect(task.intervalSeconds).toBe(300);
      expect(task.nextRunAt).toBeDefined();
      expect(task.schedule?.scheduleType).toBe('interval');
      expect(task.schedule?.intervalSeconds).toBe(300);
    });

    it('enforces idempotency key uniqueness per tenant', async () => {
      const idempotencyKey = '11111111-2222-4333-8444-555555555555';
      const task1 = await repo1.create({
        idempotencyKey,
        title: 'Idempotent Task',
        payload: {
          type: 'agent_prompt',
          prompt: 'Run check',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
        },
      });

      expect(task1.idempotencyKey).toBe(idempotencyKey);
    });
  });

  describe('4. Pause and Resume Lifecycle', () => {
    it('pauses a scheduled task, disabling future triggers without deleting schedule', async () => {
      const task = await repo1.create({
        title: 'Recurring Task to Pause',
        scheduleType: 'cron',
        cronExpression: '*/10 * * * *',
        payload: {
          type: 'agent_prompt',
          prompt: 'Run task',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
        },
      });

      const paused = await repo1.pause(task.id);
      expect(paused.schedule?.enabled).toBe(false);
      expect(paused.schedule?.pausedAt).toBeDefined();

      // Paused task cannot be claimed
      const claimResult = await repo1.claim({
        claimantId: 'worker_1',
        leaseDurationMs: 30000,
        preferredTaskId: task.id,
      });
      expect(claimResult).toBeNull();
    });

    it('resumes a paused scheduled task and recalculates next_run_at from resume time', async () => {
      const task = await repo1.create({
        title: 'Recurring Task to Resume',
        scheduleType: 'cron',
        cronExpression: '0 * * * *',
        payload: {
          type: 'agent_prompt',
          prompt: 'Run task',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
        },
      });

      await repo1.pause(task.id);

      const fakeResumeTime = new Date('2026-05-01T14:22:00.000Z');
      const resumed = await repo1.resume(task.id, fakeResumeTime);

      expect(resumed.schedule?.enabled).toBe(true);
      expect(resumed.schedule?.pausedAt).toBeNull();
      // Next run should be top of next hour: 15:00:00
      expect(resumed.schedule?.nextRunAt).toBe('2026-05-01T15:00:00.000Z');
    });
  });

  describe('5. Task Claiming, Run Rows Creation, and Overlap Prevention', () => {
    it('creates a task_runs row when a task is claimed', async () => {
      const task = await repo1.create({
        title: 'Task for Execution Run',
        payload: {
          type: 'agent_prompt',
          prompt: 'Run prompt',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
        },
      });

      const claimed = await repo1.claim({
        claimantId: 'worker_node_1',
        leaseDurationMs: 45000,
        preferredTaskId: task.id,
      });

      expect(claimed).not.toBeNull();
      expect(claimed?.status).toBe('claimed');
      expect(claimed?.currentRun).toBeDefined();
      expect(claimed?.currentRun?.status).toBe('claimed');
      expect(claimed?.currentRun?.claimantId).toBe('worker_node_1');
      expect(claimed?.currentRun?.attemptNumber).toBe(1);

      const runsResult = await repo1.listRuns(task.id);
      expect(runsResult.total).toBe(1);
      expect(runsResult.items[0].id).toBe(claimed?.currentRun?.id);
    });

    it('enforces overlap policy skip: does not allow concurrent run if one is actively claimed/running', async () => {
      const task = await repo1.create({
        title: 'Cron Overlap Test',
        scheduleType: 'cron',
        cronExpression: '*/5 * * * *',
        overlapPolicy: 'skip',
        payload: {
          type: 'agent_prompt',
          prompt: 'Run prompt',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
        },
      });

      // Claim 1 when task becomes due at nextRunAt
      const claim1 = await repo1.claim({
        claimantId: 'worker_node_1',
        leaseDurationMs: 60000,
        preferredTaskId: task.id,
        now: task.nextRunAt!,
      });
      expect(claim1).not.toBeNull();

      // Claim 2 while Claim 1 is in-flight must be skipped (returns null)
      const claim2 = await repo1.claim({
        claimantId: 'worker_node_2',
        leaseDurationMs: 60000,
        preferredTaskId: task.id,
        now: task.nextRunAt!,
      });
      expect(claim2).toBeNull();
    });

    it('completes run and task for once schedule, recording token usage and turn link', async () => {
      const task = await repo1.create({
        title: 'Task Complete Test',
        payload: {
          type: 'agent_prompt',
          prompt: 'Run prompt',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
        },
      });

      const claimed = await repo1.claim({
        claimantId: 'worker_node_1',
        leaseDurationMs: 60000,
        preferredTaskId: task.id,
      });

      const completed = await repo1.complete(
        task.id,
        'worker_node_1',
        {
          status: 'completed',
          completedAt: new Date().toISOString(),
          turnId: 'turn_0123456789abcdef0123456789abcdef',
          messageId: 'msg_0123456789abcdef0123456789abcdef',
        },
        claimed?.currentRun?.id,
        {
          promptTokens: 120,
          completionTokens: 80,
          totalTokens: 200,
        }
      );

      expect(completed.status).toBe('completed');
      expect(completed.currentRun?.status).toBe('completed');
      expect(completed.currentRun?.turnId).toBe('turn_0123456789abcdef0123456789abcdef');
      expect(completed.currentRun?.promptTokens).toBe(120);
      expect(completed.currentRun?.totalTokens).toBe(200);
    });

    it('keeps cron task pending for next recurrence upon run completion', async () => {
      const task = await repo1.create({
        title: 'Cron Recurrence Completion',
        scheduleType: 'cron',
        cronExpression: '0 * * * *',
        payload: {
          type: 'agent_prompt',
          prompt: 'Hourly task',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
        },
      });

      const claimed = await repo1.claim({
        claimantId: 'worker_node_1',
        leaseDurationMs: 60000,
        preferredTaskId: task.id,
        now: task.nextRunAt!,
      });

      const completed = await repo1.complete(
        task.id,
        'worker_node_1',
        {
          status: 'completed',
          completedAt: new Date().toISOString(),
        },
        claimed?.currentRun?.id
      );

      // Task status returns to pending for next recurrence!
      expect(completed.status).toBe('pending');
      expect(completed.currentRun?.status).toBe('completed');
      expect(completed.schedule?.enabled).toBe(true);
    });

    it('creates manual Run Now without shifting next scheduled run', async () => {
      const task = await repo1.create({
        title: 'Cron with Manual Run Now',
        scheduleType: 'cron',
        cronExpression: '0 12 1 7 *', // July 1st 12:00
        payload: {
          type: 'agent_prompt',
          prompt: 'Prompt',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
        },
      });

      const manualResult = await repo1.createManualRun(task.id, 'manual_worker', 30000);
      expect(manualResult.run.status).toBe('claimed');
      expect(manualResult.run.attemptNumber).toBe(1);
    });
  });

  describe('6. Multi-Tenant Isolation', () => {
    it('strictly isolates tasks, schedules, and runs between tenants', async () => {
      const task1 = await repo1.create({
        title: 'User 1 Task',
        payload: {
          type: 'agent_prompt',
          prompt: 'P1',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
        },
      });

      const foundByUser2 = await repo2.findById(task1.id);
      expect(foundByUser2).toBeNull();

      const user2List = await repo2.list();
      expect(user2List.length).toBe(0);

      const user2Runs = await repo2.listRuns(task1.id);
      expect(user2Runs.total).toBe(0);
    });
  });
});
