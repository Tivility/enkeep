import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  PlatformServer,
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  SqliteWebMessageStore,
  createPlatformServerTaskWorker,
} from '../src/index.js';
import {
  SqlitePlatformStorage,
  SqlitePlatformOperationsStorage,
} from '@enkeep/platform-storage-sqlite';
import { PlatformOperationsService } from '@enkeep/platform-operations';
import { hashPassword } from '@enkeep/platform-auth';
import { TestOnlyRuntimeGateway } from './test-runtime-gateway.js';

describe('Script Task Lifecycle & Hardening Integration (D6 / F-16)', () => {
  let db: DatabaseSync;
  let server: PlatformServer;
  let baseUrl: string;
  let opsStorage: SqlitePlatformOperationsStorage;
  let opsService: PlatformOperationsService;

  const cookieSecret = 'explicit-valid-cookie-secret-32-chars-long!';
  const csrfToken = 'explicit-valid-csrf-token-32-chars-long-ok!';

  const adminId = 'user_admin_test';
  const tenant1Id = 'user_tenant_1';

  let adminCookie: string;
  let tenant1Cookie: string;

  const hostSpaceId = 'spc_0123456789abcdef0123456789abcdef';
  const containerSpaceId = 'spc_fedcba9876543210fedcba9876543210';
  const hostSessionId = 'ses_0123456789abcdef0123456789abcdef';

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    const migrationRunner = new PlatformServerMigrationRunner(db);
    await migrationRunner.migrate(ALL_PLATFORM_MIGRATIONS);

    opsStorage = new SqlitePlatformOperationsStorage(db);
    opsService = new PlatformOperationsService({ storage: opsStorage });

    const platformStorage = new SqlitePlatformStorage(db);
    const messageStore = new SqliteWebMessageStore(db);
    const runtimeGateway = new TestOnlyRuntimeGateway({ storage: platformStorage, messageStore });

    const taskWorker = createPlatformServerTaskWorker({
      db,
      dispatcher: async () => ({
        status: 'completed',
        completedAt: new Date().toISOString(),
      }),
      operationsStorage: opsStorage,
      pollIntervalMs: 50,
      resolveSpaceCwd: () => process.cwd(),
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

    // Create admin and regular user
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, status)
      VALUES (?, 'admin_user', ?, 'admin', 'active'),
             (?, 'regular_user', ?, 'user', 'active')
    `).run(adminId, pwdHash, tenant1Id, pwdHash);

    // Create a host space and a container space for admin
    db.prepare(`
      INSERT INTO spaces (id, user_id, name, folder, execution_mode, status)
      VALUES (?, ?, 'Host Space', 'host_folder', 'host', 'active'),
             (?, ?, 'Container Space', 'container_folder', 'container', 'active')
    `).run(hostSpaceId, adminId, containerSpaceId, adminId);

    // Create session route in host space
    db.prepare(`
      INSERT INTO session_routes (
        id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id, status
      ) VALUES (?, ?, ?, 'web', 'web-demo', ?, 'peer1', 'dsh_ses_1', 'active')
    `).run(hostSessionId, hostSpaceId, adminId, hostSessionId);

    adminCookie = await loginUser('admin_user', 'Password123!');
    tenant1Cookie = await loginUser('regular_user', 'Password123!');
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
      Cookie: cookie,
      'X-Enkeep-CSRF': csrfToken,
      'Content-Type': 'application/json',
      Origin: baseUrl,
    };
  }

  it('rejects script task creation from non-admin user with HTTP 403 Forbidden', async () => {
    const res = await fetch(`${baseUrl}/api/manage/tasks`, {
      method: 'POST',
      headers: {
        ...getHeaders(tenant1Cookie),
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({
        title: 'Unauthorized Script Task',
        execution_type: 'script',
        script_command: 'echo "forbidden"',
      }),
    });

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.message).toContain('administrators');
  });

  it('rejects script task creation when space executionMode is container with HTTP 400', async () => {
    const res = await fetch(`${baseUrl}/api/manage/tasks`, {
      method: 'POST',
      headers: {
        ...getHeaders(adminCookie),
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({
        title: 'Container Script Task',
        execution_type: 'script',
        script_command: 'echo "container"',
        spaceId: containerSpaceId,
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.message).toContain('host mode spaces');
  });

  it('creates host script task for admin, audits to auth_audit_log, and allows manual run with 0 tokens', async () => {
    // 1. Create script task (Spec F-16 probe input style)
    const idempotencyKey = randomUUID();
    const createRes = await fetch(`${baseUrl}/api/manage/tasks`, {
      method: 'POST',
      headers: {
        ...getHeaders(adminCookie),
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        title: 'F-16 Spec Health Check Script Task',
        execution_type: 'script',
        script_command: 'echo "{\\"status\\":\\"healthy\\",\\"exit_code\\":0}"',
        sessionId: hostSessionId,
      }),
    });

    expect(createRes.status).toBe(201);
    const createJson = await createRes.json();
    expect(createJson.success).toBe(true);
    const taskId = createJson.data.id;
    expect(createJson.data.task.payload.type).toBe('script');
    expect(createJson.data.task.payload.command).toBe('echo "{\\"status\\":\\"healthy\\",\\"exit_code\\":0}"');
    expect(createJson.data.task.payload.spaceId).toBe(hostSpaceId);

    // Verify auth_audit_log was written
    const auditRows = db.prepare('SELECT * FROM auth_audit_log WHERE action = ?').all('script_task_created') as any[];
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    const auditDetail = JSON.parse(auditRows[auditRows.length - 1].details);
    expect(auditDetail.taskId).toBe(taskId);
    expect(auditDetail.spaceId).toBe(hostSpaceId);

    // 2. Trigger manual run via POST /api/manage/tasks/:taskId/run
    const runRes = await fetch(`${baseUrl}/api/manage/tasks/${taskId}/run`, {
      method: 'POST',
      headers: {
        ...getHeaders(adminCookie),
        'Idempotency-Key': randomUUID(),
      },
    });

    expect(runRes.status).toBe(200);
    const runJson = await runRes.json();
    expect(runJson.success).toBe(true);
    expect(runJson.data.status).toBe('completed');
    expect(runJson.data.result.exitCode).toBe(0);
    expect(runJson.data.result.stdout.trim()).toContain('healthy');

    // 3. Query task runs
    const runsRes = await fetch(`${baseUrl}/api/manage/tasks/${taskId}/runs`, {
      method: 'GET',
      headers: getHeaders(adminCookie),
    });
    expect(runsRes.status).toBe(200);
    const runsJson = await runsRes.json();
    expect(runsJson.data.items.length).toBeGreaterThanOrEqual(1);
    const latestRun = runsJson.data.items[0];
    expect(latestRun.status).toBe('completed');
    expect(latestRun.totalTokens).toBe(0);
    expect(latestRun.promptTokens).toBe(0);
    expect(latestRun.completionTokens).toBe(0);
  });

  it('rejects non-admin execution or modification of script tasks', async () => {
    // 1. Admin creates script task
    const createRes = await fetch(`${baseUrl}/api/manage/tasks`, {
      method: 'POST',
      headers: {
        ...getHeaders(adminCookie),
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({
        title: 'Admin Script Task',
        type: 'script',
        command: 'echo "admin only"',
        spaceId: hostSpaceId,
      }),
    });
    const { id: taskId } = (await createRes.json()).data;

    // Cross-tenant execution is rejected (404 hiding resource)
    const runRes = await fetch(`${baseUrl}/api/manage/tasks/${taskId}/run`, {
      method: 'POST',
      headers: {
        ...getHeaders(tenant1Cookie),
        'Idempotency-Key': randomUUID(),
      },
    });
    expect(runRes.status).toBe(404);

    // 2. Non-admin creates an agent task in their own space
    const tenant1SpaceId = 'spc_11111111111111111111111111111111';
    db.prepare(`
      INSERT INTO spaces (id, user_id, name, folder, execution_mode, status)
      VALUES (?, ?, 'Tenant1 Space', 'tenant1_folder', 'container', 'active')
    `).run(tenant1SpaceId, tenant1Id);

    const regularSessionId = 'ses_11111111111111111111111111111111';
    db.prepare(`
      INSERT INTO session_routes (
        id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id, status
      ) VALUES (?, ?, ?, 'web', 'web-demo', ?, 'peer1', 'dsh_ses_2', 'active')
    `).run(regularSessionId, tenant1SpaceId, tenant1Id, regularSessionId);

    const regularTaskRes = await fetch(`${baseUrl}/api/manage/tasks`, {
      method: 'POST',
      headers: {
        ...getHeaders(tenant1Cookie),
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({
        title: 'Regular User Agent Task',
        prompt: 'Normal prompt',
        sessionId: regularSessionId,
      }),
    });
    const { id: regularTaskId } = (await regularTaskRes.json()).data;

    // Non-admin tries to mutate their own task into a script task
    const updateRes = await fetch(`${baseUrl}/api/manage/tasks/${regularTaskId}`, {
      method: 'PUT',
      headers: getHeaders(tenant1Cookie),
      body: JSON.stringify({
        command: 'echo "escalation attempt"',
      }),
    });
    expect(updateRes.status).toBe(403);
    const updateJson = await updateRes.json();
    expect(updateJson.error.message).toContain('Administrative access required');
  });
});
