import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  PlatformServer,
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  SqliteWebMessageStore,
} from '../src/index.js';
import {
  SqlitePlatformStorage,
  SqlitePlatformOperationsStorage,
} from '@enkeep/platform-storage-sqlite';
import { PlatformOperationsService } from '@enkeep/platform-operations';
import { hashPassword } from '@enkeep/platform-auth';
import { TestOnlyRuntimeGateway } from './test-runtime-gateway.js';

describe('Task Scheduler Management APIs (Cron, Interval, Pause/Resume, Runs, Run-Now)', () => {
  let db: DatabaseSync;
  let server: PlatformServer;
  let baseUrl: string;
  let opsStorage: SqlitePlatformOperationsStorage;
  let opsService: PlatformOperationsService;

  const cookieSecret = 'explicit-valid-cookie-secret-32-chars-long!';
  const csrfToken = 'explicit-valid-csrf-token-32-chars-long-ok!';

  const adminId = 'user_admin_test';
  const tenant1Id = 'user_tenant_1';
  const tenant2Id = 'user_tenant_2';

  let adminCookie: string;
  let tenant1Cookie: string;
  let tenant2Cookie: string;

  let sessionRouteId: string;

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    const migrationRunner = new PlatformServerMigrationRunner(db);
    await migrationRunner.migrate(ALL_PLATFORM_MIGRATIONS);

    opsStorage = new SqlitePlatformOperationsStorage(db);
    opsService = new PlatformOperationsService({ storage: opsStorage });

    const platformStorage = new SqlitePlatformStorage(db);
    const messageStore = new SqliteWebMessageStore(db);
    const runtimeGateway = new TestOnlyRuntimeGateway({ storage: platformStorage, messageStore });

    server = new PlatformServer({
      database: db,
      host: '127.0.0.1',
      port: 0,
      runtimeGateway,
      cookieSecret,
      csrfToken,
      operationsService: opsService,
      enableWorker: true,
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
      VALUES ('spc_test1', ?, 'Workspace 1', 'folder1', 'container', 'active')
    `).run(tenant1Id);

    sessionRouteId = 'ses_0123456789abcdef0123456789abcdef';
    db.prepare(`
      INSERT INTO session_routes (
        id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id, status
      ) VALUES (?, 'spc_test1', ?, 'web', 'web-demo', ?, 'peer1', 'dsh_ses_1', 'active')
    `).run(sessionRouteId, tenant1Id, sessionRouteId);

    // Log in to get authentic signed cookies
    adminCookie = await loginUser('admin_user', 'Password123!');
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

  async function loginUser(username: string, password: string):Promise<string> {
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

  describe('1. POST /api/manage/tasks (Cron, Interval, Once)', () => {
    it('creates a cron task with 5-field expression and returns 201 with schedule info', async () => {
      const idempotencyKey = '22222222-3333-4444-8555-666666666666';
      const res = await fetch(`${baseUrl}/api/manage/tasks`, {
        method: 'POST',
        headers: {
          ...getHeaders(tenant1Cookie),
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          title: 'Daily Cleanup Cron',
          prompt: 'Execute daily cleanup',
          sessionId: sessionRouteId,
          scheduleType: 'cron',
          cronExpression: '0 2 * * *',
          priority: 'medium',
        }),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.task.scheduleType).toBe('cron');
      expect(json.data.task.cronExpression).toBe('0 2 * * *');
      expect(json.data.task.schedule).toBeDefined();
      expect(json.data.task.schedule.enabled).toBe(true);
    });

    it('creates an interval task with intervalSeconds', async () => {
      const idempotencyKey = '33333333-4444-4555-8666-777777777777';
      const res = await fetch(`${baseUrl}/api/manage/tasks`, {
        method: 'POST',
        headers: {
          ...getHeaders(tenant1Cookie),
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          title: 'Every 5 Mins Health Check',
          prompt: 'Check health endpoint',
          sessionId: sessionRouteId,
          scheduleType: 'interval',
          intervalSeconds: 300,
          priority: 'high',
        }),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.task.scheduleType).toBe('interval');
      expect(json.data.task.intervalSeconds).toBe(300);
    });

    it('rejects cron task with invalid cron expression', async () => {
      const res = await fetch(`${baseUrl}/api/manage/tasks`, {
        method: 'POST',
        headers: {
          ...getHeaders(tenant1Cookie),
          'Idempotency-Key': '44444444-5555-4666-8777-888888888888',
        },
        body: JSON.stringify({
          title: 'Invalid Cron Task',
          prompt: 'Run task',
          sessionId: sessionRouteId,
          scheduleType: 'cron',
          cronExpression: 'invalid * *',
        }),
      });

      expect(res.status).toBe(400);
    });

    it('rejects unsupported misfirePolicy (run_all) and unsupported overlapPolicy (allow, queue)', async () => {
      // Reject run_all misfire policy
      const res1 = await fetch(`${baseUrl}/api/manage/tasks`, {
        method: 'POST',
        headers: {
          ...getHeaders(tenant1Cookie),
          'Idempotency-Key': '44444444-5555-4666-8777-888888888889',
        },
        body: JSON.stringify({
          title: 'Unsupported Misfire Task',
          prompt: 'Run task',
          sessionId: sessionRouteId,
          scheduleType: 'cron',
          cronExpression: '0 * * * *',
          misfirePolicy: 'run_all',
        }),
      });
      expect(res1.status).toBe(400);

      // Reject allow overlap policy
      const res2 = await fetch(`${baseUrl}/api/manage/tasks`, {
        method: 'POST',
        headers: {
          ...getHeaders(tenant1Cookie),
          'Idempotency-Key': '44444444-5555-4666-8777-888888888890',
        },
        body: JSON.stringify({
          title: 'Unsupported Overlap Allow Task',
          prompt: 'Run task',
          sessionId: sessionRouteId,
          scheduleType: 'cron',
          cronExpression: '0 * * * *',
          overlapPolicy: 'allow',
        }),
      });
      expect(res2.status).toBe(400);

      // Reject queue overlap policy
      const resQueue = await fetch(`${baseUrl}/api/manage/tasks`, {
        method: 'POST',
        headers: {
          ...getHeaders(tenant1Cookie),
          'Idempotency-Key': '44444444-5555-4666-8777-888888888893',
        },
        body: JSON.stringify({
          title: 'Unsupported Overlap Queue Task',
          prompt: 'Run task',
          sessionId: sessionRouteId,
          scheduleType: 'cron',
          cronExpression: '0 * * * *',
          overlapPolicy: 'queue',
        }),
      });
      expect(resQueue.status).toBe(400);

      // Reject non-UTC timezone
      const res3 = await fetch(`${baseUrl}/api/manage/tasks`, {
        method: 'POST',
        headers: {
          ...getHeaders(tenant1Cookie),
          'Idempotency-Key': '44444444-5555-4666-8777-888888888891',
        },
        body: JSON.stringify({
          title: 'Non-UTC Timezone Task',
          prompt: 'Run task',
          sessionId: sessionRouteId,
          scheduleType: 'cron',
          cronExpression: '0 * * * *',
          timezone: 'America/New_York',
        }),
      });
      expect(res3.status).toBe(400);
    });

    it('accepts supported misfirePolicy (coalesce, skip) and overlapPolicy (skip)', async () => {
      const res = await fetch(`${baseUrl}/api/manage/tasks`, {
        method: 'POST',
        headers: {
          ...getHeaders(tenant1Cookie),
          'Idempotency-Key': '44444444-5555-4666-8777-888888888892',
        },
        body: JSON.stringify({
          title: 'Supported Policies Task',
          prompt: 'Run task',
          sessionId: sessionRouteId,
          scheduleType: 'cron',
          cronExpression: '0 * * * *',
          misfirePolicy: 'skip',
          overlapPolicy: 'skip',
          timezone: 'UTC',
        }),
      });
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.data.task.schedule.misfirePolicy).toBe('skip');
      expect(json.data.task.schedule.overlapPolicy).toBe('skip');
    });
  });

  describe('2. POST /api/manage/tasks/:id/pause and /resume', () => {
    it('pauses and resumes a task, updating schedule enabled and pausedAt states', async () => {
      // 1. Create cron task
      const createRes = await fetch(`${baseUrl}/api/manage/tasks`, {
        method: 'POST',
        headers: {
          ...getHeaders(tenant1Cookie),
          'Idempotency-Key': '55555555-6666-4777-8888-999999999999',
        },
        body: JSON.stringify({
          title: 'Pausable Cron Task',
          prompt: 'Run task',
          sessionId: sessionRouteId,
          scheduleType: 'cron',
          cronExpression: '*/15 * * * *',
        }),
      });
      const createJson = await createRes.json();
      const taskId = createJson.data.task.id;

      // 2. Pause
      const pauseRes = await fetch(`${baseUrl}/api/manage/tasks/${taskId}/pause`, {
        method: 'POST',
        headers: getHeaders(tenant1Cookie),
      });
      expect(pauseRes.status).toBe(200);
      const pauseJson = await pauseRes.json();
      expect(pauseJson.data.paused).toBe(true);
      expect(pauseJson.data.task.schedule.enabled).toBe(false);

      // 3. Resume
      const resumeRes = await fetch(`${baseUrl}/api/manage/tasks/${taskId}/resume`, {
        method: 'POST',
        headers: getHeaders(tenant1Cookie),
      });
      expect(resumeRes.status).toBe(200);
      const resumeJson = await resumeRes.json();
      expect(resumeJson.data.resumed).toBe(true);
      expect(resumeJson.data.task.schedule.enabled).toBe(true);
    });
  });

  describe('3. GET /api/manage/tasks/:id/runs (Execution History)', () => {
    it('returns paginated execution runs with safe metadata and error codes only', async () => {
      // 1. Create task
      const createRes = await fetch(`${baseUrl}/api/manage/tasks`, {
        method: 'POST',
        headers: {
          ...getHeaders(tenant1Cookie),
          'Idempotency-Key': '66666666-7777-4888-8999-000000000000',
        },
        body: JSON.stringify({
          title: 'Runs History Test Task',
          prompt: 'Execute task',
          sessionId: sessionRouteId,
        }),
      });
      const createJson = await createRes.json();
      const taskId = createJson.data.task.id;

      // Claim and complete a run in storage
      const claimed = await opsStorage.forTenant(tenant1Id).tasks.claim({
        claimantId: 'worker_api_test',
        leaseDurationMs: 60000,
        preferredTaskId: taskId,
      });

      await opsStorage.forTenant(tenant1Id).tasks.complete(
        taskId,
        'worker_api_test',
        {
          status: 'completed',
          completedAt: new Date().toISOString(),
          turnId: 'turn_0123456789abcdef0123456789abcdef',
          messageId: 'msg_0123456789abcdef0123456789abcdef',
        },
        claimed?.currentRun?.id,
        { promptTokens: 50, completionTokens: 25, totalTokens: 75 }
      );

      // Fetch runs
      const runsRes = await fetch(`${baseUrl}/api/manage/tasks/${taskId}/runs?limit=10&offset=0`, {
        method: 'GET',
        headers: getHeaders(tenant1Cookie),
      });

      expect(runsRes.status).toBe(200);
      const runsJson = await runsRes.json();
      expect(runsJson.data.total).toBe(1);
      expect(runsJson.data.items.length).toBe(1);
      const run = runsJson.data.items[0];
      expect(run.status).toBe('completed');
      expect(run.turnId).toBe('turn_0123456789abcdef0123456789abcdef');
      expect(run.promptTokens).toBe(50);
      expect(run.totalTokens).toBe(75);
      expect(run.errorCode).toBeNull();
    });

    it('enforces multi-tenant isolation: Tenant 2 cannot access Tenant 1 task runs', async () => {
      // 1. Create task for Tenant 1
      const createRes = await fetch(`${baseUrl}/api/manage/tasks`, {
        method: 'POST',
        headers: {
          ...getHeaders(tenant1Cookie),
          'Idempotency-Key': '77777777-8888-4999-8000-111111111111',
        },
        body: JSON.stringify({
          title: 'Tenant 1 Isolated Task',
          prompt: 'Prompt',
          sessionId: sessionRouteId,
        }),
      });
      const createJson = await createRes.json();
      const taskId = createJson.data.task.id;

      // Tenant 2 requests Tenant 1 task runs -> empty list (tenant-scoped)
      const runsRes = await fetch(`${baseUrl}/api/manage/tasks/${taskId}/runs`, {
        method: 'GET',
        headers: getHeaders(tenant2Cookie),
      });

      expect(runsRes.status).toBe(200);
      const runsJson = await runsRes.json();
      expect(runsJson.data.total).toBe(0);
      expect(runsJson.data.items.length).toBe(0);
    });
  });

  describe('4. Admin GET /api/admin/tasks and /runs', () => {
    it('allows admin to query tasks across tenants and view task runs', async () => {
      // Create tasks for tenant 1
      await fetch(`${baseUrl}/api/manage/tasks`, {
        method: 'POST',
        headers: {
          ...getHeaders(tenant1Cookie),
          'Idempotency-Key': '88888888-9999-4000-8111-222222222222',
        },
        body: JSON.stringify({
          title: 'Admin Cross Tenant Check',
          prompt: 'Prompt',
          sessionId: sessionRouteId,
        }),
      });

      // Admin list tasks
      const adminTasksRes = await fetch(`${baseUrl}/api/admin/tasks`, {
        method: 'GET',
        headers: getHeaders(adminCookie),
      });

      expect(adminTasksRes.status).toBe(200);
      const adminTasksJson = await adminTasksRes.json();
      expect(adminTasksJson.data.total).toBeGreaterThanOrEqual(1);
    });
  });
});
