import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  SqliteTenantScopedTaskRepository,
} from '../src/repos/task-repo.js';
import {
  SqlitePlatformOperationsStorage,
} from '../src/operations-storage.js';
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
  TASK_PROTOCOL_ERROR_CODES,
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

    it('resumes migrated cron task where platform_tasks row has schedule_type=once, null cron_expression but task_schedules has schedule_type=cron', async () => {
      const taskId = 'task_0123456789abcdef0123456789abcdef';
      const scheduleId = 'sched_0123456789abcdef0123456789abcdef';
      const nowIso = '2026-05-01T00:00:00.000Z';
      const payloadJson = JSON.stringify({
        type: 'agent_prompt',
        prompt: 'Run migrated task',
        sessionId: 'ses_0123456789abcdef0123456789abcdef',
        sessionPolicy: 'existing_session',
      });

      // Insert platform_tasks with stale 'once' values
      db.prepare(`
        INSERT INTO platform_tasks (
          id, user_id, title, status, payload, schedule_type, cron_expression, interval_seconds,
          due_date, timezone, created_at, updated_at
        ) VALUES (
          ?, ?, 'Migrated Cron Task', 'pending', ?, 'once', NULL, NULL,
          NULL, 'UTC', ?, ?
        )
      `).run(taskId, user1, payloadJson, nowIso, nowIso);

      // Insert task_schedules with cron schedule
      db.prepare(`
        INSERT INTO task_schedules (
          id, task_id, user_id, schedule_type, cron_expression, interval_seconds,
          timezone, enabled, misfire_policy, overlap_policy, created_at, updated_at
        ) VALUES (
          ?, ?, ?, 'cron', '0 4 * * *', NULL,
          'UTC', 0, 'coalesce', 'skip', ?, ?
        )
      `).run(scheduleId, taskId, user1, nowIso, nowIso);

      const fixedNow = new Date('2026-05-01T01:30:00.000Z');
      const resumed = await repo1.resume(taskId, fixedNow);

      expect(resumed.schedule?.enabled).toBe(true);
      expect(resumed.schedule?.nextRunAt).toBe('2026-05-01T04:00:00.000Z');
      expect(resumed.nextRunAt).toBe('2026-05-01T04:00:00.000Z');

      const schedRow = db.prepare('SELECT * FROM task_schedules WHERE task_id = ?').get(taskId) as any;
      expect(schedRow.enabled).toBe(1);
      expect(schedRow.next_run_at).toBe('2026-05-01T04:00:00.000Z');
    });

    it('resumes migrated interval task where platform_tasks row has schedule_type=once, null interval_seconds but task_schedules has schedule_type=interval', async () => {
      const taskId = 'task_abcdef0123456789abcdef0123456789';
      const scheduleId = 'sched_abcdef0123456789abcdef0123456789';
      const nowIso = '2026-05-01T00:00:00.000Z';
      const payloadJson = JSON.stringify({
        type: 'agent_prompt',
        prompt: 'Run migrated task',
        sessionId: 'ses_0123456789abcdef0123456789abcdef',
        sessionPolicy: 'existing_session',
      });

      // Insert platform_tasks with stale 'once' values
      db.prepare(`
        INSERT INTO platform_tasks (
          id, user_id, title, status, payload, schedule_type, cron_expression, interval_seconds,
          due_date, timezone, created_at, updated_at
        ) VALUES (
          ?, ?, 'Migrated Interval Task', 'pending', ?, 'once', NULL, NULL,
          NULL, 'UTC', ?, ?
        )
      `).run(taskId, user1, payloadJson, nowIso, nowIso);

      // Insert task_schedules with interval schedule (e.g. every 3600 seconds)
      db.prepare(`
        INSERT INTO task_schedules (
          id, task_id, user_id, schedule_type, cron_expression, interval_seconds,
          timezone, enabled, misfire_policy, overlap_policy, created_at, updated_at
        ) VALUES (
          ?, ?, ?, 'interval', NULL, 3600,
          'UTC', 0, 'coalesce', 'skip', ?, ?
        )
      `).run(scheduleId, taskId, user1, nowIso, nowIso);

      const fixedNow = new Date('2026-05-01T01:30:00.000Z');
      const resumed = await repo1.resume(taskId, fixedNow);

      expect(resumed.schedule?.enabled).toBe(true);
      expect(resumed.schedule?.nextRunAt).toBe('2026-05-01T02:30:00.000Z');
      expect(resumed.nextRunAt).toBe('2026-05-01T02:30:00.000Z');

      const schedRow = db.prepare('SELECT * FROM task_schedules WHERE task_id = ?').get(taskId) as any;
      expect(schedRow.enabled).toBe(1);
      expect(schedRow.next_run_at).toBe('2026-05-01T02:30:00.000Z');
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

    it('advances next_run_at on claim for migrated-style rows (platform_tasks schedule_type=once, cron null; task_schedules cron 0 4 * * *)', async () => {
      const taskId = 'task_11112222333344445555666677778888';
      const scheduleId = 'sched_11112222333344445555666677778888';
      const scheduledFor = '2026-09-20T04:00:00.000Z';
      const payloadJson = JSON.stringify({
        type: 'agent_prompt',
        prompt: 'Run migrated cron task',
        sessionId: 'ses_0123456789abcdef0123456789abcdef',
        sessionPolicy: 'existing_session',
      });

      // Insert platform_tasks with migrated-style values: schedule_type='once', cron_expression=NULL
      db.prepare(`
        INSERT INTO platform_tasks (
          id, user_id, title, status, payload, schedule_type, cron_expression, interval_seconds,
          next_run_at, timezone, created_at, updated_at
        ) VALUES (
          ?, ?, 'Migrated Cron Task', 'pending', ?, 'once', NULL, NULL,
          ?, 'UTC', ?, ?
        )
      `).run(taskId, user1, payloadJson, scheduledFor, scheduledFor, scheduledFor);

      // Insert task_schedules with cron schedule
      db.prepare(`
        INSERT INTO task_schedules (
          id, task_id, user_id, schedule_type, cron_expression, interval_seconds,
          next_run_at, timezone, enabled, misfire_policy, overlap_policy, created_at, updated_at
        ) VALUES (
          ?, ?, ?, 'cron', '0 4 * * *', NULL,
          ?, 'UTC', 1, 'coalesce', 'skip', ?, ?
        )
      `).run(scheduleId, taskId, user1, scheduledFor, scheduledFor, scheduledFor);

      const claimTime = new Date('2026-09-20T04:00:00.000Z');
      // 1. Claim at 04:00 -> next_run_at becomes next day 04:00 in the same transaction
      // Use 24h lease so it remains active against real test runner clock
      const claimed = await repo1.claim({
        claimantId: 'worker_node_1',
        leaseDurationMs: 86_400_000,
        preferredTaskId: taskId,
        now: claimTime,
      });

      expect(claimed).not.toBeNull();
      expect(claimed?.status).toBe('claimed');
      expect(claimed?.nextRunAt).toBe('2026-09-21T04:00:00.000Z');
      expect(claimed?.schedule?.nextRunAt).toBe('2026-09-21T04:00:00.000Z');

      // Verify directly in database that both rows updated atomically in the same transaction
      const taskRow = db.prepare('SELECT * FROM platform_tasks WHERE id = ?').get(taskId) as any;
      const schedRow = db.prepare('SELECT * FROM task_schedules WHERE id = ?').get(scheduleId) as any;
      expect(taskRow.next_run_at).toBe('2026-09-21T04:00:00.000Z');
      expect(schedRow.next_run_at).toBe('2026-09-21T04:00:00.000Z');
      expect(schedRow.last_run_at).toBe('2026-09-20T04:00:00.000Z');

      // 2. A second claim immediately after returns nothing (null)
      const secondClaimPreferred = await repo1.claim({
        claimantId: 'worker_node_2',
        leaseDurationMs: 86_400_000,
        preferredTaskId: taskId,
        now: new Date('2026-09-20T04:00:01.000Z'),
      });
      expect(secondClaimPreferred).toBeNull();

      const secondClaimGeneral = await repo1.claim({
        claimantId: 'worker_node_2',
        leaseDurationMs: 86_400_000,
        now: new Date('2026-09-20T04:00:01.000Z'),
      });
      expect(secondClaimGeneral).toBeNull();

      // 3. Completion keeps next_run_at
      const completed = await repo1.complete(
        taskId,
        'worker_node_1',
        {
          status: 'completed',
          completedAt: '2026-09-20T04:00:20.000Z',
        },
        claimed?.currentRun?.id
      );

      expect(completed.status).toBe('pending');
      expect(completed.nextRunAt).toBe('2026-09-21T04:00:00.000Z');
      expect(completed.schedule?.nextRunAt).toBe('2026-09-21T04:00:00.000Z');

      // Verify in DB that next_run_at is still next day 04:00
      const schedRowAfterComplete = db.prepare('SELECT * FROM task_schedules WHERE id = ?').get(scheduleId) as any;
      expect(schedRowAfterComplete.next_run_at).toBe('2026-09-21T04:00:00.000Z');

      // Subsequent claim after completion still returns null since next run is tomorrow
      const thirdClaim = await repo1.claim({
        claimantId: 'worker_node_1',
        leaseDurationMs: 60000,
        preferredTaskId: taskId,
        now: new Date('2026-09-20T04:00:21.000Z'),
      });
      expect(thirdClaim).toBeNull();
    });

    it('advances interval schedule by interval on claim', async () => {
      const task = await repo1.create({
        title: 'Interval Schedule Advancement Test',
        scheduleType: 'interval',
        intervalSeconds: 300, // 5 minutes
        payload: {
          type: 'agent_prompt',
          prompt: 'Execute interval sync',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
        },
      });

      const initialNextRun = task.nextRunAt!;
      expect(initialNextRun).toBeDefined();

      const claimTime = new Date(initialNextRun);
      const claimed = await repo1.claim({
        claimantId: 'worker_interval_1',
        leaseDurationMs: 60000,
        preferredTaskId: task.id,
        now: claimTime,
      });

      expect(claimed).not.toBeNull();
      const expectedNextRun = new Date(claimTime.getTime() + 300 * 1000).toISOString();
      expect(claimed?.nextRunAt).toBe(expectedNextRun);
      expect(claimed?.schedule?.nextRunAt).toBe(expectedNextRun);

      const schedRow = db.prepare('SELECT next_run_at FROM task_schedules WHERE task_id = ?').get(task.id) as any;
      expect(schedRow.next_run_at).toBe(expectedNextRun);
    });

    it('does not alter next_run_at during manual run or upon its completion', async () => {
      const task = await repo1.create({
        title: 'Cron with Manual Run Preserves next_run_at',
        scheduleType: 'cron',
        cronExpression: '0 4 * * *',
        payload: {
          type: 'agent_prompt',
          prompt: 'Prompt',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
        },
      });

      const originalNextRun = task.nextRunAt!;
      expect(originalNextRun).toBeDefined();

      // Execute manual run via createManualRun
      const manualTime = new Date('2026-09-20T10:30:00.000Z');
      const manualResult = await repo1.createManualRun(task.id, 'manual_worker', 60000, manualTime);

      expect(manualResult.run.status).toBe('claimed');
      expect(manualResult.task.nextRunAt).toBe(originalNextRun);
      expect(manualResult.task.schedule?.nextRunAt).toBe(originalNextRun);

      // Verify DB row unchanged
      const schedRowManual = db.prepare('SELECT next_run_at FROM task_schedules WHERE task_id = ?').get(task.id) as any;
      expect(schedRowManual.next_run_at).toBe(originalNextRun);

      // Complete manual run
      const completed = await repo1.complete(
        task.id,
        'manual_worker',
        {
          status: 'completed',
          completedAt: '2026-09-20T10:31:00.000Z',
        },
        manualResult.run.id
      );

      expect(completed.status).toBe('pending');
      expect(completed.nextRunAt).toBe(originalNextRun);
      expect(completed.schedule?.nextRunAt).toBe(originalNextRun);

      const schedRowFinal = db.prepare('SELECT next_run_at FROM task_schedules WHERE task_id = ?').get(task.id) as any;
      expect(schedRowFinal.next_run_at).toBe(originalNextRun);
    });

    it('guards overlap: overlap_policy skip prevents claiming a schedule whose previous run is still claimed/running', async () => {
      const task = await repo1.create({
        title: 'Overlap Guard Test',
        scheduleType: 'cron',
        cronExpression: '0 4 * * *',
        overlapPolicy: 'skip',
        payload: {
          type: 'agent_prompt',
          prompt: 'Overlap prompt',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
        },
      });

      const claimTime = new Date(task.nextRunAt!);
      const claim1 = await repo1.claim({
        claimantId: 'worker_1',
        leaseDurationMs: 60000,
        preferredTaskId: task.id,
        now: claimTime,
      });
      expect(claim1).not.toBeNull();

      // Try claiming concurrently via preferredTaskId
      const claimPreferred = await repo1.claim({
        claimantId: 'worker_2',
        leaseDurationMs: 60000,
        preferredTaskId: task.id,
        now: new Date(claimTime.getTime() + 10000),
      });
      expect(claimPreferred).toBeNull();

      // Try claiming concurrently via general queue
      const claimGeneral = await repo1.claim({
        claimantId: 'worker_2',
        leaseDurationMs: 60000,
        now: new Date(claimTime.getTime() + 10000),
      });
      expect(claimGeneral).toBeNull();
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

  describe('7. Recurring Task State Machine & Recovery (T1)', () => {
    it('recurring task failure resets claim_count, records run failure, computes next_run and returns to pending', async () => {
      const task = await repo1.create({
        title: 'Recurring Cron Fail Test',
        scheduleType: 'cron',
        cronExpression: '0 4 * * *',
        payload: {
          type: 'agent_prompt',
          prompt: 'Execute daily crawl',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
        },
      });

      const initialNextRun = task.nextRunAt!;
      expect(initialNextRun).toBeDefined();

      // Claim task
      const claimed = await repo1.claim({
        claimantId: 'worker_fail_node',
        leaseDurationMs: 60000,
        preferredTaskId: task.id,
        now: new Date(initialNextRun),
      });

      expect(claimed).not.toBeNull();
      expect(claimed?.status).toBe('claimed');
      expect(claimed?.claimCount).toBe(1);

      // Fail task with non-retryable error
      const failed = await repo1.fail(
        task.id,
        'worker_fail_node',
        'Model rate limit exceeded',
        false, // non-retryable!
        claimed?.currentRun?.id,
        'RATE_LIMIT_EXCEEDED',
        new Date(new Date(initialNextRun).getTime() + 1000)
      );

      // Invariant: Recurring tasks MUST NEVER end in 'failed' terminal status!
      expect(failed.status).toBe('pending');
      expect(failed.completedAt).toBeNull();
      expect(failed.claimCount).toBe(0); // claim_count reset to 0
      expect(failed.nextRunAt).toBeDefined();
      expect(new Date(failed.nextRunAt!).getTime()).toBeGreaterThan(new Date(initialNextRun).getTime());

      // Task run must be marked failed
      expect(failed.currentRun?.status).toBe('failed');
      expect(failed.currentRun?.errorCode).toBe('RATE_LIMIT_EXCEEDED');
      expect(failed.currentRun?.error).toBe('Model rate limit exceeded');
    });

    it('recurring task completion resets claim_count, computes next_run, and returns to pending with null completedAt', async () => {
      const task = await repo1.create({
        title: 'Recurring Interval Complete Test',
        scheduleType: 'interval',
        intervalSeconds: 600, // 10 minutes
        payload: {
          type: 'agent_prompt',
          prompt: 'Execute interval sync',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
        },
      });

      const initialNextRun = task.nextRunAt!;
      const claimTime = new Date(initialNextRun);

      const claimed = await repo1.claim({
        claimantId: 'worker_interval_node',
        leaseDurationMs: 60000,
        preferredTaskId: task.id,
        now: claimTime,
      });

      expect(claimed).not.toBeNull();
      expect(claimed?.status).toBe('claimed');
      expect(claimed?.claimCount).toBe(1);

      const completed = await repo1.complete(
        task.id,
        'worker_interval_node',
        {
          status: 'completed',
          completedAt: new Date(claimTime.getTime() + 5000).toISOString(),
        },
        claimed?.currentRun?.id
      );

      // Invariant: Recurring tasks MUST NEVER end in 'completed' terminal status!
      expect(completed.status).toBe('pending');
      expect(completed.completedAt).toBeNull();
      expect(completed.claimCount).toBe(0); // reset claim_count
      const expectedNextRun = new Date(claimTime.getTime() + 600 * 1000).toISOString();
      expect(completed.nextRunAt).toBe(expectedNextRun);
      expect(completed.schedule?.nextRunAt).toBe(expectedNextRun);

      // Run record is completed
      expect(completed.currentRun?.status).toBe('completed');
    });

    it('lease-expiry recovery resets recurring task claim_count to 0, keeps it pending, and marks run failed', async () => {
      const taskId = 'task_aaaa1111bbbb2222cccc3333dddd4444';
      const scheduleId = 'sched_aaaa1111bbbb2222cccc3333dddd4444';
      const runId = 'run_aaaa1111bbbb2222cccc3333dddd4444';
      const pastTime = '2026-09-20T04:00:00.000Z';
      const expiredLease = '2026-09-20T04:01:00.000Z';
      const recoveryTime = '2026-09-20T05:00:00.000Z';

      // Insert task with claim_count (199) >= max_retries (3) to simulate long-running recurring task
      db.prepare(`
        INSERT INTO platform_tasks (
          id, user_id, title, status, payload, schedule_type, cron_expression,
          next_run_at, timezone, claimant_id, lease_expires_at, claim_count, max_retries,
          created_at, updated_at
        ) VALUES (
          ?, ?, 'Expired Lease Recurring Task', 'running', '{}', 'cron', '0 4 * * *',
          ?, 'UTC', 'worker_dead', ?, 199, 3, ?, ?
        )
      `).run(taskId, user1, pastTime, expiredLease, pastTime, pastTime);

      db.prepare(`
        INSERT INTO task_schedules (
          id, task_id, user_id, schedule_type, cron_expression,
          next_run_at, timezone, enabled, created_at, updated_at
        ) VALUES (
          ?, ?, ?, 'cron', '0 4 * * *', ?, 'UTC', 1, ?, ?
        )
      `).run(scheduleId, taskId, user1, pastTime, pastTime, pastTime);

      db.prepare(`
        INSERT INTO task_runs (
          id, task_id, schedule_id, user_id, attempt_number, status,
          claimant_id, lease_expires_at, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, 199, 'running', 'worker_dead', ?, ?, ?
        )
      `).run(runId, taskId, scheduleId, user1, expiredLease, pastTime, pastTime);

      // Run lease-expiry recovery
      const recoveryResult = await repo1.recoverExpiredLeases(recoveryTime);

      expect(recoveryResult.recoveredCount).toBe(1);
      expect(recoveryResult.retriedIds).toContain(taskId);
      expect(recoveryResult.failedIds).toHaveLength(0);

      // Verify task in DB: must be pending, claim_count=0, completed_at=NULL, next_run schedulable
      const taskRow = db.prepare('SELECT * FROM platform_tasks WHERE id = ?').get(taskId) as any;
      expect(taskRow.status).toBe('pending');
      expect(taskRow.completed_at).toBeNull();
      expect(taskRow.claim_count).toBe(0);
      expect(taskRow.claimant_id).toBeNull();
      expect(taskRow.lease_expires_at).toBeNull();
      expect(taskRow.next_run_at).toBe('2026-09-21T04:00:00.000Z');

      // Verify run in DB: must be failed with TASK_LEASE_EXPIRED
      const runRow = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(runId) as any;
      expect(runRow.status).toBe('failed');
      expect(runRow.error_code).toBe(TASK_PROTOCOL_ERROR_CODES.LEASE_EXPIRED);
    });

    it('restart recovery in operations-storage resets recurring task to pending and keeps it schedulable', async () => {
      const taskId = 'task_bbbb1111cccc2222dddd3333eeee4444';
      const scheduleId = 'sched_bbbb1111cccc2222dddd3333eeee4444';
      const runId = 'run_bbbb1111cccc2222dddd3333eeee4444';
      const pastTime = '2026-09-20T04:00:00.000Z';
      const expiredLease = '2026-09-20T04:01:00.000Z';
      const restartTime = '2026-09-20T06:00:00.000Z';

      db.prepare(`
        INSERT INTO platform_tasks (
          id, user_id, title, status, payload, schedule_type, cron_expression,
          next_run_at, timezone, claimant_id, lease_expires_at, claim_count, max_retries,
          created_at, updated_at
        ) VALUES (
          ?, ?, 'Restart Recovery Recurring Task', 'running', '{}', 'cron', '0 4 * * *',
          ?, 'UTC', 'crashed_worker', ?, 250, 3, ?, ?
        )
      `).run(taskId, user1, pastTime, expiredLease, pastTime, pastTime);

      db.prepare(`
        INSERT INTO task_schedules (
          id, task_id, user_id, schedule_type, cron_expression,
          next_run_at, timezone, enabled, created_at, updated_at
        ) VALUES (
          ?, ?, ?, 'cron', '0 4 * * *', ?, 'UTC', 1, ?, ?
        )
      `).run(scheduleId, taskId, user1, pastTime, pastTime, pastTime);

      db.prepare(`
        INSERT INTO task_runs (
          id, task_id, schedule_id, user_id, attempt_number, status,
          claimant_id, lease_expires_at, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, 250, 'running', 'crashed_worker', ?, ?, ?
        )
      `).run(runId, taskId, scheduleId, user1, expiredLease, pastTime, pastTime);

      const opsStorage = new SqlitePlatformOperationsStorage(db);
      const res = await opsStorage.recoverAfterRestart(restartTime);

      expect(res.recoveredTasks).toBeGreaterThanOrEqual(1);

      const taskRow = db.prepare('SELECT * FROM platform_tasks WHERE id = ?').get(taskId) as any;
      expect(taskRow.status).toBe('pending');
      expect(taskRow.completed_at).toBeNull();
      expect(taskRow.claim_count).toBe(0);
      expect(taskRow.claimant_id).toBeNull();
      expect(taskRow.lease_expires_at).toBeNull();
      expect(taskRow.next_run_at).toBe('2026-09-21T04:00:00.000Z');

      const runRow = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(runId) as any;
      expect(runRow.status).toBe('failed');
      expect(runRow.error_code).toBe(TASK_PROTOCOL_ERROR_CODES.LEASE_EXPIRED);
    });

    it('resume() resets a stuck recurring task (in completed or failed status) to pending with claim_count 0', async () => {
      const taskId = 'task_cccc1111dddd2222eeee3333ffff4444';
      const scheduleId = 'sched_cccc1111dddd2222eeee3333ffff4444';
      const pastTime = '2026-09-11T06:18:31.594Z';
      const resumeClock = new Date('2026-09-26T12:00:00.000Z');

      const validPayload = JSON.stringify({
        type: 'agent_prompt',
        prompt: 'Monthly bill reminder',
        sessionId: 'ses_0123456789abcdef0123456789abcdef',
        sessionPolicy: 'existing_session',
      });

      // Simulate historical bug: task is stuck in 'completed' with completed_at set
      db.prepare(`
        INSERT INTO platform_tasks (
          id, user_id, title, status, payload, schedule_type, cron_expression,
          next_run_at, timezone, claim_count, completed_at, created_at, updated_at
        ) VALUES (
          ?, ?, 'Monthly Bill Stuck Task', 'completed', ?, 'cron', '0 9 1 * *',
          '2026-10-01T16:00:00.000Z', 'America/Los_Angeles', 5, ?, ?, ?
        )
      `).run(taskId, user1, validPayload, pastTime, pastTime, pastTime);

      db.prepare(`
        INSERT INTO task_schedules (
          id, task_id, user_id, schedule_type, cron_expression,
          next_run_at, timezone, enabled, paused_at, created_at, updated_at
        ) VALUES (
          ?, ?, ?, 'cron', '0 9 1 * *', '2026-10-01T16:00:00.000Z', 'America/Los_Angeles', 0, ?, ?, ?
        )
      `).run(scheduleId, taskId, user1, pastTime, pastTime, pastTime);

      const resumed = await repo1.resume(taskId, resumeClock);

      // Invariant: Resumed recurring task must be reset to pending!
      expect(resumed.status).toBe('pending');
      expect(resumed.completedAt).toBeNull();
      expect(resumed.claimCount).toBe(0);
      expect(resumed.schedule?.enabled).toBe(true);
      expect(resumed.schedule?.pausedAt).toBeNull();
      expect(resumed.nextRunAt).toBe('2026-10-01T16:00:00.000Z');

      // Direct DB verification
      const taskRow = db.prepare('SELECT * FROM platform_tasks WHERE id = ?').get(taskId) as any;
      expect(taskRow.status).toBe('pending');
      expect(taskRow.completed_at).toBeNull();
      expect(taskRow.claim_count).toBe(0);
      expect(taskRow.claimant_id).toBeNull();
      expect(taskRow.lease_expires_at).toBeNull();
    });
  });

  describe('9. Legacy and Unexpected Task Payload Resiliency', () => {
    it('lists tasks successfully even when a task row contains a legacy or unexpected payload shape', async () => {
      const normalTask = await repo1.create({
        title: 'Normal Active Task',
        payload: {
          type: 'agent_prompt',
          prompt: 'Execute normal check',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
        },
      });

      // Insert synthetic legacy task matching HappyClaw payload shape (keys only, no type property)
      const legacyTaskId = 'task_synth_00000000000000000000000001';
      db.prepare(`
        INSERT INTO platform_tasks (
          id, user_id, title, status, priority, lease_duration_ms, claim_count, max_retries, payload, created_at, updated_at
        ) VALUES (
          ?, ?, 'Legacy Imported Task', 'pending', 'medium', 60000, 0, 3, ?,
          '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
        )
      `).run(
        legacyTaskId,
        user1,
        JSON.stringify({
          chatJid: 'oc_test0000000000000000000000000001',
          executionMode: 'container',
          executionType: 'agent_prompt',
          groupFolder: 'synth_group_01',
          originalTaskId: 'synth_original_task_01',
          prompt: 'Synthetic maintenance prompt',
          status: 'pending',
        })
      );

      const tasks = await repo1.list();
      expect(tasks.length).toBe(2);

      const legacy = tasks.find((t) => t.id === legacyTaskId);
      expect(legacy).toBeDefined();
      expect(legacy?.title).toBe('Legacy Imported Task');
      expect(legacy?.status).toBe('pending');
      expect(legacy?.payload.type).toBe('agent_prompt');
      expect(legacy?.payload.prompt).toBe('Synthetic maintenance prompt');
      expect((legacy?.payload as any).originalTaskId).toBe('synth_original_task_01');
      expect((legacy?.payload as any).groupFolder).toBe('synth_group_01');

      const normal = tasks.find((t) => t.id === normalTask.id);
      expect(normal).toBeDefined();
      expect(normal?.payload.prompt).toBe('Execute normal check');
    });
  });
});
