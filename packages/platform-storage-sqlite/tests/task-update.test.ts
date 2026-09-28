import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SqliteTenantScopedTaskRepository } from '../src/repos/task-repo.js';
import {
  MIGRATION_001_SQL,
  MIGRATION_004_SQL,
  MIGRATION_018_TASK_SCHEDULES_AND_RUNS_SQL,
} from '../src/schema/migrations.js';
import {
  ValidationError,
  TaskNotFoundError,
  TaskAlreadyClaimedError,
  TaskAlreadyCompletedError,
} from '@enkeep/platform-operations';

describe('SqliteTenantScopedTaskRepository.update', () => {
  let db: DatabaseSync;
  const user1 = 'user_task_update_1';
  const user2 = 'user_task_update_2';
  let repo1: SqliteTenantScopedTaskRepository;
  let repo2: SqliteTenantScopedTaskRepository;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(MIGRATION_001_SQL);
    db.exec(MIGRATION_004_SQL);

    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, status)
      VALUES (?, ?, 'hash', 'user', 'active'), (?, ?, 'hash', 'user', 'active')
    `).run(user1, 'user1', user2, 'user2');

    db.exec(MIGRATION_018_TASK_SCHEDULES_AND_RUNS_SQL);

    repo1 = new SqliteTenantScopedTaskRepository(db, user1);
    repo2 = new SqliteTenantScopedTaskRepository(db, user2);
  });

  afterEach(() => {
    db.close();
  });

  // 1. Update prompt & preserve identity (owner, session, space)
  it('updates prompt correctly in payload while preserving space, session and identity', async () => {
    const task = await repo1.create({
      title: 'Original Title',
      payload: {
        type: 'agent_prompt',
        prompt: 'Original prompt text',
        sessionId: 'ses_11112222333344445555666677778888',
        sessionPolicy: 'existing_session',
        spaceId: 'spc_11112222333344445555666677778888',
        spaceFolder: 'project1',
      },
    });

    const updated = await repo1.update(task.id, {
      title: 'Updated Title',
      prompt: 'Refined prompt text for agent',
      priority: 'urgent',
    });

    expect(updated.id).toBe(task.id);
    expect(updated.userId).toBe(user1);
    expect(updated.title).toBe('Updated Title');
    expect(updated.priority).toBe('urgent');
    expect(updated.payload.prompt).toBe('Refined prompt text for agent');
    expect(updated.payload.sessionId).toBe('ses_11112222333344445555666677778888');
    expect(updated.payload.sessionPolicy).toBe('existing_session');
    expect(updated.payload.spaceId).toBe('spc_11112222333344445555666677778888');
    expect(updated.payload.spaceFolder).toBe('project1');

    // Direct DB verification
    const row = db.prepare('SELECT * FROM platform_tasks WHERE id = ?').get(task.id) as any;
    expect(row.title).toBe('Updated Title');
    expect(row.priority).toBe('urgent');
    const parsedPayload = JSON.parse(row.payload);
    expect(parsedPayload.prompt).toBe('Refined prompt text for agent');
    expect(parsedPayload.spaceId).toBe('spc_11112222333344445555666677778888');
  });

  // 2. Schedule switching and nextRunAt recomputation
  it('maintains schedule rows and recomputes nextRunAt when switching between schedule types', async () => {
    const task = await repo1.create({
      title: 'Switch Schedule Task',
      scheduleType: 'once',
      dueDate: '2026-10-01T12:00:00.000Z',
      payload: {
        type: 'agent_prompt',
        prompt: 'Run once prompt',
        sessionId: 'ses_11112222333344445555666677778888',
        sessionPolicy: 'existing_session',
      },
    });

    expect(task.scheduleType).toBe('once');
    expect(task.dueDate).toBe('2026-10-01T12:00:00.000Z');

    // Switch once -> cron
    const updatedCron = await repo1.update(task.id, {
      scheduleType: 'cron',
      cronExpression: '0 4 * * *',
    });

    expect(updatedCron.scheduleType).toBe('cron');
    expect(updatedCron.cronExpression).toBe('0 4 * * *');
    expect(updatedCron.dueDate).toBeNull();
    expect(updatedCron.nextRunAt).toBeDefined();
    expect(updatedCron.schedule?.scheduleType).toBe('cron');
    expect(updatedCron.schedule?.cronExpression).toBe('0 4 * * *');

    // Verify DB schedule row
    const schedRowCron = db.prepare('SELECT * FROM task_schedules WHERE task_id = ?').get(task.id) as any;
    expect(schedRowCron.schedule_type).toBe('cron');
    expect(schedRowCron.cron_expression).toBe('0 4 * * *');
    expect(schedRowCron.interval_seconds).toBeNull();

    // Switch cron -> interval
    const updatedInterval = await repo1.update(task.id, {
      scheduleType: 'interval',
      intervalSeconds: 600,
    });

    expect(updatedInterval.scheduleType).toBe('interval');
    expect(updatedInterval.intervalSeconds).toBe(600);
    expect(updatedInterval.cronExpression).toBeNull();
    expect(updatedInterval.schedule?.scheduleType).toBe('interval');
    expect(updatedInterval.schedule?.intervalSeconds).toBe(600);

    const schedRowInterval = db.prepare('SELECT * FROM task_schedules WHERE task_id = ?').get(task.id) as any;
    expect(schedRowInterval.schedule_type).toBe('interval');
    expect(schedRowInterval.interval_seconds).toBe(600);
    expect(schedRowInterval.cron_expression).toBeNull();
  });

  // 3. Paused task update preserves paused state and keeps nextRunAt null
  it('updates paused task configuration while preserving paused state and keeping nextRunAt null', async () => {
    const task = await repo1.create({
      title: 'Cron Task to Pause',
      scheduleType: 'cron',
      cronExpression: '0 4 * * *',
      payload: {
        type: 'agent_prompt',
        prompt: 'Cron prompt',
        sessionId: 'ses_11112222333344445555666677778888',
        sessionPolicy: 'existing_session',
      },
    });

    // Pause the task
    const paused = await repo1.pause(task.id);
    expect(paused.schedule?.enabled).toBe(false);

    // Update cron schedule while paused
    const updated = await repo1.update(task.id, {
      cronExpression: '0 6 * * *',
      title: 'Updated Paused Task',
    });

    expect(updated.title).toBe('Updated Paused Task');
    expect(updated.cronExpression).toBe('0 6 * * *');
    expect(updated.nextRunAt).toBeNull();
    expect(updated.schedule?.enabled).toBe(false);
    expect(updated.schedule?.nextRunAt).toBeNull();

    // Resuming calculates nextRunAt with new cron expression
    const resumed = await repo1.resume(task.id, new Date('2026-09-20T00:00:00.000Z'));
    expect(resumed.schedule?.enabled).toBe(true);
    expect(resumed.nextRunAt).toBe('2026-09-20T06:00:00.000Z');
  });

  // 4. Busy task rejection (claimed / running)
  it('atomically rejects updates when task is claimed or running with TaskAlreadyClaimedError', async () => {
    const task = await repo1.create({
      title: 'Busy Task',
      payload: {
        type: 'agent_prompt',
        prompt: 'Work in progress prompt',
        sessionId: 'ses_11112222333344445555666677778888',
        sessionPolicy: 'existing_session',
      },
    });

    await repo1.claim({
      claimantId: 'worker_busy_node_1',
      leaseDurationMs: 60000,
      preferredTaskId: task.id,
    });

    await expect(
      repo1.update(task.id, { title: 'Attempted mutation while running' })
    ).rejects.toThrow(TaskAlreadyClaimedError);

    // Check error details
    try {
      await repo1.update(task.id, { title: 'Attempted mutation' });
    } catch (err) {
      expect(err).toBeInstanceOf(TaskAlreadyClaimedError);
      expect((err as TaskAlreadyClaimedError).claimantId).toBe('worker_busy_node_1');
      expect((err as TaskAlreadyClaimedError).status).toBe(409);
    }
  });

  // 5. Terminal once task rejection
  it('rejects updates on terminal once tasks with TaskAlreadyCompletedError', async () => {
    const task = await repo1.create({
      title: 'Terminal Task',
      scheduleType: 'once',
      payload: {
        type: 'agent_prompt',
        prompt: 'To be completed',
        sessionId: 'ses_11112222333344445555666677778888',
        sessionPolicy: 'existing_session',
      },
    });

    // Cancel task to transition into terminal state
    await repo1.cancel(task.id);

    await expect(
      repo1.update(task.id, { title: 'Update cancelled task' })
    ).rejects.toThrow(TaskAlreadyCompletedError);

    try {
      await repo1.update(task.id, { title: 'Update cancelled task' });
    } catch (err) {
      expect(err).toBeInstanceOf(TaskAlreadyCompletedError);
      expect((err as TaskAlreadyCompletedError).status).toBe(409);
    }
  });

  // 6. Tenant isolation and unknown task rejection
  it('rejects update attempts on tasks belonging to another tenant or non-existent tasks', async () => {
    const taskUser1 = await repo1.create({
      title: 'Tenant 1 Private Task',
      payload: {
        type: 'agent_prompt',
        prompt: 'Secret payload',
        sessionId: 'ses_11112222333344445555666677778888',
        sessionPolicy: 'existing_session',
      },
    });

    // Cross-tenant update must fail with TaskNotFoundError
    await expect(
      repo2.update(taskUser1.id, { title: 'Malicious Overwrite' })
    ).rejects.toThrow(TaskNotFoundError);

    // Non-existent task ID
    await expect(
      repo1.update('task_00000000000000000000000000000000', { title: 'Ghost Task' })
    ).rejects.toThrow(TaskNotFoundError);

    // Verify taskUser1 title remained unchanged
    const fetched = await repo1.findById(taskUser1.id);
    expect(fetched?.title).toBe('Tenant 1 Private Task');
  });
});
