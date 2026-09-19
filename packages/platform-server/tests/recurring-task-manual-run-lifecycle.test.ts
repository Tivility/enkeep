import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  PlatformServer,
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  SqliteWebMessageStore,
} from '../src/index.js';
import {
  SqlitePlatformStorage,
  SqlitePlatformOperationsStorage,
} from '../../platform-storage-sqlite/src/index.js';
import {
  PlatformOperationsService,
  AgentPromptTaskWorker,
  TASK_PROTOCOL_ERROR_CODES,
  TaskAlreadyCompletedError,
} from '../../platform-operations/src/index.js';
import type {
  AgentPromptDispatchContext,
  AgentPromptDispatchResult,
} from '../../platform-operations/src/index.js';
import { hashPassword } from '@enkeep/platform-auth';
import { TestOnlyRuntimeGateway } from './test-runtime-gateway.js';

describe('Recurring Task Manual Run Lifecycle & Controlled Retry Protection', () => {
  let db: DatabaseSync;
  let server: PlatformServer;
  let baseUrl: string;
  let opsStorage: SqlitePlatformOperationsStorage;
  let opsService: PlatformOperationsService;
  let taskWorker: AgentPromptTaskWorker;

  const cookieSecret = 'explicit-valid-cookie-secret-32-chars-long!';
  const csrfToken = 'explicit-valid-csrf-token-32-chars-long-ok!';

  const adminId = 'user_admin_test';
  const tenant1Id = 'user_tenant_1';
  const tenant2Id = 'user_tenant_2';

  let tenant1Cookie: string;
  let tenant2Cookie: string;

  const sessionRouteId = 'ses_0123456789abcdef0123456789abcdef';
  const spaceId = 'spc_00000000000000000000000000000001';

  let lastDispatchedContext: AgentPromptDispatchContext | null = null;
  let dispatchHandler: (ctx: AgentPromptDispatchContext) => Promise<AgentPromptDispatchResult>;

  const dailyTaskId = 'task_hpc_aa11bb22cc33dd44ee55ff01';
  const weeklyTaskId = 'task_hpc_aa11bb22cc33dd44ee55ff02';

  beforeEach(async () => {
    lastDispatchedContext = null;
    dispatchHandler = async (ctx) => {
      lastDispatchedContext = ctx;
      return {
        status: 'completed',
        completedAt: new Date().toISOString(),
        turnId: 'turn_0123456789abcdef0123456789abcdef',
      };
    };

    db = new DatabaseSync(':memory:');
    const migrationRunner = new PlatformServerMigrationRunner(db);
    await migrationRunner.migrate(ALL_PLATFORM_MIGRATIONS);

    opsStorage = new SqlitePlatformOperationsStorage(db);
    opsService = new PlatformOperationsService({ storage: opsStorage });

    const platformStorage = new SqlitePlatformStorage(db);
    const messageStore = new SqliteWebMessageStore(db);
    const runtimeGateway = new TestOnlyRuntimeGateway({ storage: platformStorage, messageStore });

    taskWorker = new AgentPromptTaskWorker({
      workerId: 'worker_test_manual_retry',
      tenantEnumerator: () => [tenant1Id, tenant2Id],
      getTenantOperations: (tid) => opsService.forTenant(tid),
      dispatcher: async (ctx) => dispatchHandler(ctx),
    });

    server = new PlatformServer({
      database: db,
      host: '127.0.0.1',
      port: 0,
      runtimeGateway,
      cookieSecret,
      csrfToken,
      operationsService: opsService,
      taskWorker,
      enableWorker: false,
      tenantQuotaDefaults: {
        turns: 100,
        messages: 100,
        tokens: 65536,
        storage_bytes: 10485760,
        api_calls: 500,
        resetInterval: 'none',
      },
    });

    const addr = await server.start();
    baseUrl = addr.url;

    const pwdHash = await hashPassword('Password123!');

    // Create users in DB
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, status)
      VALUES (?, 'admin_user', ?, 'admin', 'active'),
             (?, 'tenant1_user', ?, 'user', 'active'),
             (?, 'tenant2_user', ?, 'user', 'active')
    `).run(adminId, pwdHash, tenant1Id, pwdHash, tenant2Id, pwdHash);

    // Create active spaces and session routes for tenant1
    db.prepare(`
      INSERT INTO spaces (id, user_id, name, folder, execution_mode, status)
      VALUES (?, ?, 'Workspace 1', 'folder1', 'container', 'active')
    `).run(spaceId, tenant1Id);

    db.prepare(`
      INSERT INTO session_routes (
        id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id, status
      ) VALUES (?, ?, ?, 'web', 'web-demo', ?, 'peer1', 'dsh_ses_1', 'active')
    `).run(sessionRouteId, spaceId, tenant1Id, sessionRouteId);

    // Log in
    tenant1Cookie = await loginUser('tenant1_user', 'Password123!');
    tenant2Cookie = await loginUser('tenant2_user', 'Password123!');
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
    if (opsStorage) {
      await opsStorage.close();
    }
    db.close();
  });

  async function loginUser(username: string, password: string): Promise<string> {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': csrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ username, password }),
    });
    return res.headers.get('set-cookie')?.split(';')[0] || '';
  }

  function getHeaders(cookie: string) {
    return {
      'Cookie': cookie,
      'X-Enkeep-CSRF': csrfToken,
      'Content-Type': 'application/json',
      Origin: baseUrl,
    };
  }

  function computeSchedulesChecksum(): string {
    const rows = db.prepare('SELECT id, task_id, schedule_type, cron_expression, interval_seconds, next_run_at, timezone, enabled, paused_at, misfire_policy, overlap_policy FROM task_schedules ORDER BY id ASC').all();
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  }

  it('1. reproduces old bug: legacy claimTask on terminal task body threw TaskAlreadyCompletedError before manual run', async () => {
    // In the old bug, if a recurring task had status = 'failed' in platform_tasks,
    // calling claimTask({ preferredTaskId }) threw TaskAlreadyCompletedError before createManualRun was ever reached.
    // We demonstrate that with the fix, calling claimTask returns null (queue cannot claim), allowing manual run to proceed.
    const nowIso = new Date().toISOString();
    const payload = JSON.stringify({
      type: 'agent_prompt',
      prompt: 'Daily test prompt',
      sessionId: sessionRouteId,
      sessionPolicy: 'existing_session',
      spaceId,
      spaceFolder: 'folder1',
      delivery: {
        channel: 'lark',
        accountId: 'acc_daily',
        nativeContextId: 'oc_daily_ctx',
      },
      silent: false,
    });

    // Simulate HappyClaw import of daily task
    db.prepare(`
      INSERT INTO platform_tasks (
        id, user_id, title, priority, status, payload, created_at, updated_at
      ) VALUES (?, ?, 'Daily Task', 'medium', 'failed', ?, ?, ?)
    `).run(dailyTaskId, tenant1Id, payload, nowIso, nowIso);

    db.prepare(`
      INSERT INTO task_schedules (
        id, task_id, user_id, schedule_type, cron_expression, enabled, next_run_at, created_at, updated_at
      ) VALUES ('sched_daily_01', ?, ?, 'cron', '0 4 * * *', 0, NULL, ?, ?)
    `).run(dailyTaskId, tenant1Id, nowIso, nowIso);

    // Initial failed run row
    db.prepare(`
      INSERT INTO task_runs (
        id, task_id, schedule_id, user_id, attempt_number, status, claimant_id,
        lease_expires_at, scheduled_for, started_at, completed_at, error, created_at, updated_at
      ) VALUES ('run_prior_failed_01', ?, 'sched_daily_01', ?, 1, 'failed', 'worker_prior',
        ?, ?, ?, ?, 'DATA_OVER_CAP', ?, ?)
    `).run(dailyTaskId, tenant1Id, nowIso, nowIso, nowIso, nowIso, nowIso, nowIso);

    // Direct claimTask on recurring task with status='failed' should NOT throw TaskAlreadyCompletedError; it returns null
    const tenantOps = opsService.forTenant(tenant1Id);
    const claimResult = await tenantOps.tasks.claimTask({
      claimantId: 'worker_poll',
      leaseDurationMs: 30000,
      preferredTaskId: dailyTaskId,
    });
    expect(claimResult).toBeNull();
  });

  it('2. recurring failed + disabled schedule -> newrun dispatch accepted, old failed run immutable, 8 canonical payload keys validated', async () => {
    const nowIso = new Date().toISOString();
    // 8 canonical payload keys: type, prompt, sessionId, sessionPolicy, spaceId, spaceFolder, delivery, silent
    const canonicalPayload = {
      type: 'agent_prompt' as const,
      prompt: 'Execute daily task observation',
      sessionId: sessionRouteId,
      sessionPolicy: 'existing_session' as const,
      spaceId,
      spaceFolder: 'folder1',
      delivery: {
        channel: 'lark',
        accountId: 'acc_daily',
        nativeContextId: 'oc_daily_ctx',
      },
      silent: false,
    };

    // Insert imported daily task with failed terminal status and disabled schedule
    db.prepare(`
      INSERT INTO platform_tasks (
        id, user_id, title, priority, status, payload, created_at, updated_at
      ) VALUES (?, ?, '# 日常统一观察任务', 'high', 'failed', ?, ?, ?)
    `).run(dailyTaskId, tenant1Id, JSON.stringify(canonicalPayload), nowIso, nowIso);

    db.prepare(`
      INSERT INTO task_schedules (
        id, task_id, user_id, schedule_type, cron_expression, enabled, next_run_at, timezone, created_at, updated_at
      ) VALUES ('sched_daily_01', ?, ?, 'cron', '0 4 * * *', 0, NULL, 'Asia/Shanghai', ?, ?)
    `).run(dailyTaskId, tenant1Id, nowIso, nowIso);

    const initialScheduleSha = computeSchedulesChecksum();

    // Initial failed run (run 1)
    const initialRunId = 'run_daily_initial_failed_001';
    db.prepare(`
      INSERT INTO task_runs (
        id, task_id, schedule_id, user_id, attempt_number, status, claimant_id,
        lease_expires_at, scheduled_for, started_at, completed_at, error, created_at, updated_at
      ) VALUES (?, ?, 'sched_daily_01', ?, 1, 'failed', 'worker_old',
        ?, ?, ?, ?, 'DATA_OVER_CAP: input messages > 1000', ?, ?)
    `).run(initialRunId, dailyTaskId, tenant1Id, nowIso, nowIso, nowIso, nowIso, nowIso, nowIso);

    // Trigger explicit manual run via POST /api/manage/tasks/:id/run
    const res = await fetch(`${baseUrl}/api/manage/tasks/${dailyTaskId}/run`, {
      method: 'POST',
      headers: getHeaders(tenant1Cookie),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.taskId).toBe(dailyTaskId);
    expect(body.data.status).toBe('completed');

    // Verify dispatcher was invoked with canonical 8-key payload
    expect(lastDispatchedContext).not.toBeNull();
    expect(lastDispatchedContext?.task.id).toBe(dailyTaskId);
    expect(lastDispatchedContext?.payload).toEqual(canonicalPayload);

    // Verify task_runs history:
    // Old failed run must be completely immutable
    const runs = db.prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY attempt_number ASC').all(dailyTaskId) as any[];
    expect(runs.length).toBe(2);

    expect(runs[0].id).toBe(initialRunId);
    expect(runs[0].attempt_number).toBe(1);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error).toBe('DATA_OVER_CAP: input messages > 1000');

    // New run must have unique run ID, attempt 2, status completed
    expect(runs[1].id).not.toBe(initialRunId);
    expect(runs[1].attempt_number).toBe(2);
    expect(runs[1].status).toBe('completed');
    expect(runs[1].claimant_id).toBe('worker_test_manual_retry');

    // Verify schedule remains strictly byte-identical (enabled: 0, next_run_at: null)
    const afterScheduleSha = computeSchedulesChecksum();
    expect(afterScheduleSha).toBe(initialScheduleSha);

    const scheduleRow = db.prepare('SELECT * FROM task_schedules WHERE task_id = ?').get(dailyTaskId) as any;
    expect(scheduleRow.enabled).toBe(0);
    expect(scheduleRow.next_run_at).toBeNull();
  });

  it('3. recurring completed -> creates subsequent unique new run preserving history', async () => {
    const nowIso = new Date().toISOString();
    const canonicalPayload = {
      type: 'agent_prompt' as const,
      prompt: 'Execute daily task observation',
      sessionId: sessionRouteId,
      sessionPolicy: 'existing_session' as const,
      spaceId,
      spaceFolder: 'folder1',
      delivery: {
        channel: 'lark',
        accountId: 'acc_daily',
        nativeContextId: 'oc_daily_ctx',
      },
      silent: false,
    };

    db.prepare(`
      INSERT INTO platform_tasks (id, user_id, title, priority, status, payload, created_at, updated_at)
      VALUES (?, ?, '# 日常统一观察任务', 'high', 'completed', ?, ?, ?)
    `).run(dailyTaskId, tenant1Id, JSON.stringify(canonicalPayload), nowIso, nowIso);

    db.prepare(`
      INSERT INTO task_schedules (id, task_id, user_id, schedule_type, cron_expression, enabled, next_run_at, timezone, created_at, updated_at)
      VALUES ('sched_daily_01', ?, ?, 'cron', '0 4 * * *', 0, NULL, 'Asia/Shanghai', ?, ?)
    `).run(dailyTaskId, tenant1Id, nowIso, nowIso);

    // Prior run 1 (failed)
    db.prepare(`
      INSERT INTO task_runs (id, task_id, schedule_id, user_id, attempt_number, status, claimant_id, lease_expires_at, scheduled_for, started_at, completed_at, error, created_at, updated_at)
      VALUES ('run_prior_01', ?, 'sched_daily_01', ?, 1, 'failed', 'worker_old', ?, ?, ?, ?, 'OLD_ERROR', ?, ?)
    `).run(dailyTaskId, tenant1Id, nowIso, nowIso, nowIso, nowIso, nowIso, nowIso);

    // Prior run 2 (completed)
    db.prepare(`
      INSERT INTO task_runs (id, task_id, schedule_id, user_id, attempt_number, status, claimant_id, lease_expires_at, scheduled_for, started_at, completed_at, created_at, updated_at)
      VALUES ('run_prior_02', ?, 'sched_daily_01', ?, 2, 'completed', 'worker_old', ?, ?, ?, ?, ?, ?)
    `).run(dailyTaskId, tenant1Id, nowIso, nowIso, nowIso, nowIso, nowIso, nowIso);

    // Calling run again on the task that now has completed runs creates attempt 3
    const res = await fetch(`${baseUrl}/api/manage/tasks/${dailyTaskId}/run`, {
      method: 'POST',
      headers: getHeaders(tenant1Cookie),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('completed');

    const runs = db.prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY attempt_number ASC').all(dailyTaskId) as any[];
    expect(runs.length).toBe(3);
    expect(runs[0].attempt_number).toBe(1);
    expect(runs[0].status).toBe('failed');
    expect(runs[1].attempt_number).toBe(2);
    expect(runs[1].status).toBe('completed');
    expect(runs[2].attempt_number).toBe(3);
    expect(runs[2].status).toBe('completed');
  });

  it('4. concurrent manual run while in-flight returns HTTP 409 TASK_CONFLICT', async () => {
    const nowIso = new Date().toISOString();
    const canonicalPayload = {
      type: 'agent_prompt' as const,
      prompt: 'Execute daily task observation',
      sessionId: sessionRouteId,
      sessionPolicy: 'existing_session' as const,
      spaceId,
      spaceFolder: 'folder1',
    };

    db.prepare(`
      INSERT INTO platform_tasks (id, user_id, title, priority, status, payload, created_at, updated_at)
      VALUES (?, ?, '# 日常统一观察任务', 'high', 'pending', ?, ?, ?)
    `).run(dailyTaskId, tenant1Id, JSON.stringify(canonicalPayload), nowIso, nowIso);

    db.prepare(`
      INSERT INTO task_schedules (id, task_id, user_id, schedule_type, cron_expression, enabled, next_run_at, timezone, created_at, updated_at)
      VALUES ('sched_daily_01', ?, ?, 'cron', '0 4 * * *', 0, NULL, 'Asia/Shanghai', ?, ?)
    `).run(dailyTaskId, tenant1Id, nowIso, nowIso);

    let resolveDispatch: (result: AgentPromptDispatchResult) => void;
    const dispatchStarted = new Promise<void>((ready) => {
      dispatchHandler = async () => {
        ready();
        return new Promise<AgentPromptDispatchResult>((res) => {
          resolveDispatch = res;
        });
      };
    });

    // Start in-flight run
    const inFlightPromise = fetch(`${baseUrl}/api/manage/tasks/${dailyTaskId}/run`, {
      method: 'POST',
      headers: getHeaders(tenant1Cookie),
    });

    await dispatchStarted;

    // Concurrent request for same task while active
    const concurrentRes = await fetch(`${baseUrl}/api/manage/tasks/${dailyTaskId}/run`, {
      method: 'POST',
      headers: getHeaders(tenant1Cookie),
    });

    expect(concurrentRes.status).toBe(409);
    const conflictBody = await concurrentRes.json();
    expect(conflictBody.success).toBe(false);
    expect(conflictBody.error.code).toBe('TASK_CONFLICT');

    // Unblock the first run
    resolveDispatch!({
      status: 'completed',
      completedAt: new Date().toISOString(),
    });

    const firstRes = await inFlightPromise;
    expect(firstRes.status).toBe(200);
  });

  it('5. completed once and cancelled tasks remain strictly protected', async () => {
    const nowIso = new Date().toISOString();
    const payload = JSON.stringify({
      type: 'agent_prompt',
      prompt: 'One-off historical prompt',
      sessionId: sessionRouteId,
      sessionPolicy: 'existing_session',
    });

    // 5a. Once task completed
    const completedOnceId = 'task_11111111222233334444555566667777';
    db.prepare(`
      INSERT INTO platform_tasks (id, user_id, title, priority, status, schedule_type, payload, created_at, updated_at)
      VALUES (?, ?, 'Completed Once Task', 'medium', 'completed', 'once', ?, ?, ?)
    `).run(completedOnceId, tenant1Id, payload, nowIso, nowIso);

    const onceRes = await fetch(`${baseUrl}/api/manage/tasks/${completedOnceId}/run`, {
      method: 'POST',
      headers: getHeaders(tenant1Cookie),
    });
    expect(onceRes.status).toBe(409);
    const onceBody = await onceRes.json();
    expect(onceBody.error.code).toBe('TASK_CONFLICT');

    // 5b. Once task failed
    const failedOnceId = 'task_22222222333344445555666677778888';
    db.prepare(`
      INSERT INTO platform_tasks (id, user_id, title, priority, status, schedule_type, payload, created_at, updated_at)
      VALUES (?, ?, 'Failed Once Task', 'medium', 'failed', 'once', ?, ?, ?)
    `).run(failedOnceId, tenant1Id, payload, nowIso, nowIso);

    const failedOnceRes = await fetch(`${baseUrl}/api/manage/tasks/${failedOnceId}/run`, {
      method: 'POST',
      headers: getHeaders(tenant1Cookie),
    });
    expect(failedOnceRes.status).toBe(409);
    const failedOnceBody = await failedOnceRes.json();
    expect(failedOnceBody.error.code).toBe('TASK_CONFLICT');

    // 5c. Recurring task cancelled by admin (explicit admin cancel)
    const cancelledRecurringId = 'task_33333333444455556666777788889999';
    db.prepare(`
      INSERT INTO platform_tasks (id, user_id, title, priority, status, schedule_type, payload, created_at, updated_at)
      VALUES (?, ?, 'Cancelled Cron Task', 'medium', 'cancelled', 'cron', ?, ?, ?)
    `).run(cancelledRecurringId, tenant1Id, payload, nowIso, nowIso);
    db.prepare(`
      INSERT INTO task_schedules (id, task_id, user_id, schedule_type, cron_expression, enabled, created_at, updated_at)
      VALUES ('sched_cancelled_01', ?, ?, 'cron', '0 0 * * *', 0, ?, ?)
    `).run(cancelledRecurringId, tenant1Id, nowIso, nowIso);

    const cancelledRes = await fetch(`${baseUrl}/api/manage/tasks/${cancelledRecurringId}/run`, {
      method: 'POST',
      headers: getHeaders(tenant1Cookie),
    });
    expect(cancelledRes.status).toBe(409);
    const cancelledBody = await cancelledRes.json();
    expect(cancelledBody.error.code).toBe('TASK_CONFLICT');
  });

  it('6. downstream failure yields new run failure, allowed later explicit retry', async () => {
    // Setup synthetic recurring weekly task
    const nowIso = new Date().toISOString();
    const weeklyPayload = {
      type: 'agent_prompt' as const,
      prompt: 'Execute weekly aggregation',
      sessionId: sessionRouteId,
      sessionPolicy: 'existing_session' as const,
      spaceId,
      spaceFolder: 'folder1',
      delivery: {
        channel: 'lark',
        accountId: 'acc_weekly',
        nativeContextId: 'oc_weekly_ctx',
      },
      silent: false,
    };

    db.prepare(`
      INSERT INTO platform_tasks (id, user_id, title, priority, status, payload, created_at, updated_at)
      VALUES (?, ?, '# 周级统一聚合任务', 'medium', 'failed', ?, ?, ?)
    `).run(weeklyTaskId, tenant1Id, JSON.stringify(weeklyPayload), nowIso, nowIso);

    db.prepare(`
      INSERT INTO task_schedules (id, task_id, user_id, schedule_type, cron_expression, enabled, next_run_at, timezone, created_at, updated_at)
      VALUES ('sched_weekly_01', ?, ?, 'cron', '0 2 * * 1', 0, NULL, 'Asia/Shanghai', ?, ?)
    `).run(weeklyTaskId, tenant1Id, nowIso, nowIso);

    // First attempt: simulate downstream dispatcher failure
    dispatchHandler = async () => {
      throw new Error('Downstream network timeout to cognitive service');
    };

    const failRes = await fetch(`${baseUrl}/api/manage/tasks/${weeklyTaskId}/run`, {
      method: 'POST',
      headers: getHeaders(tenant1Cookie),
    });

    expect(failRes.status).toBe(200);
    const failBody = await failRes.json();
    expect(failBody.data.status).toBe('failed');

    const runsAfterFail = db.prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY attempt_number ASC').all(weeklyTaskId) as any[];
    expect(runsAfterFail.length).toBe(1);
    expect(runsAfterFail[0].status).toBe('failed');
    expect(runsAfterFail[0].error_code).toBe(TASK_PROTOCOL_ERROR_CODES.EXECUTION_FAILED);

    // Second attempt: later explicit retry succeeds
    dispatchHandler = async () => {
      return {
        status: 'completed',
        completedAt: new Date().toISOString(),
        turnId: 'turn_retry_success_001',
      };
    };

    const successRes = await fetch(`${baseUrl}/api/manage/tasks/${weeklyTaskId}/run`, {
      method: 'POST',
      headers: getHeaders(tenant1Cookie),
    });

    expect(successRes.status).toBe(200);
    const successBody = await successRes.json();
    expect(successBody.data.status).toBe('completed');

    const runsAfterSuccess = db.prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY attempt_number ASC').all(weeklyTaskId) as any[];
    expect(runsAfterSuccess.length).toBe(2);
    expect(runsAfterSuccess[0].status).toBe('failed');
    expect(runsAfterSuccess[1].status).toBe('completed');
  });

  it('7. rejects cross-tenant manual run with HTTP 404', async () => {
    // Tenant 2 attempts to run Tenant 1's weekly task
    const crossRes = await fetch(`${baseUrl}/api/manage/tasks/${weeklyTaskId}/run`, {
      method: 'POST',
      headers: getHeaders(tenant2Cookie),
    });

    expect(crossRes.status).toBe(404);
  });
});
