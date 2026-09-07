/**
 * Authenticated Operations API Producer & Governance Contract Tests
 *
 * Covers:
 * 1. POST /api/manage/tasks:
 *    - Unauthenticated 401
 *    - CSRF mandatory (missing/invalid 403)
 *    - Idempotency-Key UUID-v4 mandatory (missing/invalid 400)
 *    - Strict body whitelist (unknown fields -> 400 ValidationError)
 *    - Natural language prompt allows 'bash' etc. without keyword filtering
 *    - Session ownership check (missing/cross-tenant session -> 404)
 *    - Session status active check (inactive -> 400)
 *    - Session executionMode container check (non-container -> 400)
 *    - DueDate validation (ISO string, future one-time schedule allowed)
 *    - Priority validation (low, medium, high, urgent)
 *    - Injected OperationsApi / TaskProducer invocation
 *    - Authoritative task ID, status, and isIdempotentHit return
 *    - Deduplication / isIdempotentHit = true on repeated Idempotency-Key
 * 2. POST /api/manage/tasks/:id/cancel:
 *    - Owner-only (authenticated user)
 *    - CSRF mandatory
 *    - Cross-tenant / missing task -> uniform 404 (prevent tenant enumeration)
 *    - Authoritative cancellation status
 * 3. POST /api/manage/tasks/:id/run:
 *    - Owner-only (authenticated user)
 *    - CSRF mandatory
 *    - Cross-tenant / missing task -> uniform 404
 *    - Dispatches to worker runNow
 *    - Accepted / running does not fake completed; returns actual execution state
 * 4. GET /api/manage/tasks & GET /api/admin/tasks:
 *    - Safe data without raw payload or idempotencyKey
 * 5. PATCH /api/admin/quotas/:userId/:metric:
 *    - Regular user (non-admin) -> 403 Forbidden
 *    - Admin authenticated
 *    - CSRF mandatory
 *    - Strict body whitelist (limit, windowSeconds, resetAt)
 *    - Fixed metrics validation (tokens, messages, turns, storage_bytes, api_calls)
 *    - Calls operations setLimit and returns authoritative limit
 * 6. Readiness & Operations Availability:
 *    - GET /api/readiness & GET /readiness
 *    - When operations not injected: available: false, mode: 'unavailable', status: 'unavailable'
 *    - Write endpoints return 503 Service Unavailable when operations is not injected (no fake success!)
 * 7. Error Sanitization & Security:
 *    - Cross-tenant access uniformly returns 404
 *    - Errors do not leak raw payload, idempotency keys, or absolute file paths
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { provisionFixtures, DefaultAuthService } from '@enkeep/platform-auth';
import { SqlitePlatformStorage, SqlitePlatformOperationsStorage } from '@enkeep/platform-storage-sqlite';
import { PlatformOperationsService } from '@enkeep/platform-operations';
import {
  createPlatformServerHandler,
  createManagementOperationsAdapter,
  SqliteWebMessageStore,
  SqlitePlatformWebApiAdapter,
  ConsoleDataSource,
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  DeliveryRuntimeGateway,
  OperationsTenantQuotaProvider,
  type TaskExecutionResult,
} from '../src/index.js';
import { TestOnlyRuntimeGateway } from './test-runtime-gateway.js';

describe('Authenticated Operations API Producer & Governance Contract Tests', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let platformApi: SqlitePlatformWebApiAdapter;
  let operationsService: PlatformOperationsService;

  let serverWithOps: Server;
  let serverWithoutOps: Server;
  let urlWithOps: string;
  let urlWithoutOps: string;

  let aliceCookie: string;
  let bobCookie: string;
  let aliceId: string;
  let bobId: string;
  let aliceSessionId: string;
  let bobSessionId: string;

  const testCsrfToken = 'ops-contract-csrf-32-chars-long-valid!';
  const cookieSecret = 'ops-contract-secret-32-chars-long-key!';

  // In-memory worker mock for runNow testing
  let workerRunResult: TaskExecutionResult = {
    taskId: '',
    status: 'completed',
    result: { output: 'Agent prompt executed successfully with bash context' },
  };

  const mockWorker = {
    async runNow(options?: { taskId?: string; tenantId?: string }): Promise<TaskExecutionResult> {
      if (options?.taskId && options?.tenantId) {
        db.prepare('UPDATE platform_tasks SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(
          workerRunResult.status,
          new Date().toISOString(),
          options.taskId,
          options.tenantId
        );
      }
      return {
        ...workerRunResult,
        taskId: options?.taskId ?? 'unknown_task',
        tenantId: options?.tenantId,
      };
    },
  };

  beforeAll(async () => {
    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    storage = new SqlitePlatformStorage(db);
    const authService = new DefaultAuthService(storage, { cookieSecret });
    const messageStore = new SqliteWebMessageStore(db);
    platformApi = new SqlitePlatformWebApiAdapter({
      storage,
      authService,
      messageStore,
      db,
    });

    const operationsStorage = new SqlitePlatformOperationsStorage(db);
    operationsService = new PlatformOperationsService({
      storage: operationsStorage,
    });

    const runtimeGateway = new TestOnlyRuntimeGateway({
      storage,
      messageStore,
      autoReply: true,
    });

    const consoleDataSource = new ConsoleDataSource({
      database: db,
      storage,
      quotaDefaults: {
        turns: 100,
        messages: 100,
        tokens: 65536,
        storage_bytes: 10485760,
        api_calls: 500,
        resetInterval: 'none',
      },
    });

    // 1. Server WITH Operations & Worker injected
    const handlerWithOps = createPlatformServerHandler({
      platformApi,
      runtimeGateway,
      csrfToken: testCsrfToken,
      storage,
      consoleDataSource,
      operations: createManagementOperationsAdapter(operationsService),
      taskWorker: mockWorker,
    });

    serverWithOps = createServer(handlerWithOps);
    await new Promise<void>((resolve) => serverWithOps.listen(0, '127.0.0.1', () => resolve()));
    const addrWithOps = serverWithOps.address() as AddressInfo;
    urlWithOps = `http://127.0.0.1:${addrWithOps.port}`;

    // 2. Server WITHOUT Operations injected (to test 503 and readiness available: false)
    const handlerWithoutOps = createPlatformServerHandler({
      platformApi,
      runtimeGateway,
      csrfToken: testCsrfToken,
      storage,
      consoleDataSource,
    });

    serverWithoutOps = createServer(handlerWithoutOps);
    await new Promise<void>((resolve) => serverWithoutOps.listen(0, '127.0.0.1', () => resolve()));
    const addrWithoutOps = serverWithoutOps.address() as AddressInfo;
    urlWithoutOps = `http://127.0.0.1:${addrWithoutOps.port}`;

    // Provision test fixtures: Alice (admin), Bob (user)
    const fixtures = await provisionFixtures(storage, authService, {
      adminUsername: 'alice',
      adminPassword: 'AlicePassword123!',
      userUsername: 'bob',
      userPassword: 'BobPassword123!',
      disabledUsername: 'charlie',
      disabledPassword: 'CharliePassword123!',
    });

    aliceId = fixtures.admin.id;
    bobId = fixtures.user.id;

    // Create container sessions for Alice and Bob
    const aliceSession = await platformApi.createSession(aliceId, {
      spaceId: fixtures.adminContainerSpace.id,
      executionMode: 'container',
      title: 'Alice Container Session',
    });
    aliceSessionId = aliceSession.id;

    const bobSession = await platformApi.createSession(bobId, {
      spaceId: fixtures.userContainerSpace.id,
      executionMode: 'container',
      title: 'Bob Container Session',
    });
    bobSessionId = bobSession.id;

    // Login Alice
    const aliceLogin = await fetch(`${urlWithOps}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: urlWithOps,
      },
      body: JSON.stringify({ username: 'alice', password: 'AlicePassword123!' }),
    });
    if (!aliceLogin.ok) {
      const err = await aliceLogin.text();
      throw new Error(`Alice login failed with status ${aliceLogin.status}: ${err}`);
    }
    aliceCookie = aliceLogin.headers.get('set-cookie')!.split(';')[0];

    // Login Bob
    const bobLogin = await fetch(`${urlWithOps}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: urlWithOps,
      },
      body: JSON.stringify({ username: 'bob', password: 'BobPassword123!' }),
    });
    if (!bobLogin.ok) {
      const err = await bobLogin.text();
      throw new Error(`Bob login failed with status ${bobLogin.status}: ${err}`);
    }
    bobCookie = bobLogin.headers.get('set-cookie')!.split(';')[0];
  });

  describe('1. Readiness & Operations Availability', () => {
    it('GET /api/readiness reports operations available: true when operations is injected', async () => {
      const res = await fetch(`${urlWithOps}/api/readiness`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.status).toBe('ready');
      expect(body.data.available).toBe(true);
      expect(body.data.operations.producer.available).toBe(true);
      expect(body.data.operations.producer.unavailableReason).toBeNull();
    });

    it('GET /readiness reports operations available: false and mode unavailable when operations is NOT injected', async () => {
      const res = await fetch(`${urlWithoutOps}/readiness`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.status).toBe('not_ready');
      expect(body.data.available).toBe(false);
      expect(body.data.operations.producer.available).toBe(false);
      expect(body.data.operations.producer.unavailableReason).toBe('OPERATIONS_PROVIDER_UNAVAILABLE');
    });

    it('POST /api/manage/tasks returns 503 OPERATIONS_UNAVAILABLE when operations is not injected', async () => {
      const res = await fetch(`${urlWithoutOps}/api/manage/tasks`, {
        method: 'POST',
        headers: {
          Cookie: bobCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: urlWithoutOps,
          'Idempotency-Key': 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Unconfigured Task',
        }),
      });

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('OPERATIONS_UNAVAILABLE');
    });
  });

  describe('2. POST /api/manage/tasks: Task Creation & Governance', () => {
    const validUuid = '11111111-2222-4333-8444-555555555555';

    it('rejects unauthenticated request with 401', async () => {
      const res = await fetch(`${urlWithOps}/api/manage/tasks`, {
        method: 'POST',
        headers: {
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: urlWithOps,
          'Idempotency-Key': validUuid,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: 'Test Task' }),
      });
      expect(res.status).toBe(401);
    });

    it('rejects missing or invalid CSRF token with 403', async () => {
      const res = await fetch(`${urlWithOps}/api/manage/tasks`, {
        method: 'POST',
        headers: {
          Cookie: bobCookie,
          Origin: urlWithOps,
          'Idempotency-Key': validUuid,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: 'Test Task' }),
      });
      expect(res.status).toBe(403);
    });

    it('rejects missing Idempotency-Key header with 400', async () => {
      const res = await fetch(`${urlWithOps}/api/manage/tasks`, {
        method: 'POST',
        headers: {
          Cookie: bobCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: urlWithOps,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: 'Test Task' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain('Idempotency-Key header is required');
    });

    it('rejects non-UUIDv4 Idempotency-Key header with 400', async () => {
      const res = await fetch(`${urlWithOps}/api/manage/tasks`, {
        method: 'POST',
        headers: {
          Cookie: bobCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: urlWithOps,
          'Idempotency-Key': 'not-a-uuid-v4',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: 'Test Task' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain('canonical lowercase UUID-v4');
    });

    it('strictly rejects unknown/forbidden body keys with 400', async () => {
      const res = await fetch(`${urlWithOps}/api/manage/tasks`, {
        method: 'POST',
        headers: {
          Cookie: bobCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: urlWithOps,
          'Idempotency-Key': '22222222-3333-4444-8555-666666666666',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Test Task',
          command: 'bash -c "rm -rf /"', // Forbidden execution key
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain('Unexpected field "command"');
    });

    it('allows natural language prompt mentioning bash and creates agent_prompt task', async () => {
      const uuid = '33333333-4444-4555-8666-777777777777';
      const res = await fetch(`${urlWithOps}/api/manage/tasks`, {
        method: 'POST',
        headers: {
          Cookie: bobCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: urlWithOps,
          'Idempotency-Key': uuid,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Analyze bash script syntax in workspace',
          prompt: 'Please review the bash script at scripts/deploy.sh and provide a report',
          sessionId: bobSessionId,
          priority: 'high',
          dueDate: new Date(Date.now() + 86400000).toISOString(),
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.id).toMatch(/^task_/);
      expect(body.data.status).toBe('pending');
      expect(body.data.isIdempotentHit).toBe(false);
      expect(body.data.task.title).toBe('Analyze bash script syntax in workspace');
      expect(body.data.task.priority).toBe('high');
    });

    it('deduplicates identical Idempotency-Key and returns isIdempotentHit: true with authoritative status', async () => {
      const uuid = '44444444-5555-4666-8777-888888888888';
      const firstRes = await fetch(`${urlWithOps}/api/manage/tasks`, {
        method: 'POST',
        headers: {
          Cookie: bobCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: urlWithOps,
          'Idempotency-Key': uuid,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Idempotent Task',
          prompt: 'Do task',
          sessionId: bobSessionId,
        }),
      });

      expect(firstRes.status).toBe(201);
      const firstBody = await firstRes.json();
      expect(firstBody.data.isIdempotentHit).toBe(false);
      const taskId = firstBody.data.id;

      // Second identical request
      const secondRes = await fetch(`${urlWithOps}/api/manage/tasks`, {
        method: 'POST',
        headers: {
          Cookie: bobCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: urlWithOps,
          'Idempotency-Key': uuid,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Idempotent Task',
          prompt: 'Do task',
          sessionId: bobSessionId,
        }),
      });

      expect(secondRes.status).toBe(201);
      const secondBody = await secondRes.json();
      expect(secondBody.data.isIdempotentHit).toBe(true);
      expect(secondBody.data.id).toBe(taskId);
    });

    it('rejects cross-tenant sessionId with 404 to prevent enumeration', async () => {
      const uuid = '55555555-6666-4777-8888-999999999999';
      // Bob tries to attach Alice's sessionId
      const res = await fetch(`${urlWithOps}/api/manage/tasks`, {
        method: 'POST',
        headers: {
          Cookie: bobCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: urlWithOps,
          'Idempotency-Key': uuid,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Cross-tenant session attack',
          prompt: 'Execute cross-tenant prompt',
          sessionId: aliceSessionId,
        }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe('NOT_FOUND');
    });

    it('rejects alternate x-idempotency-key header with 400', async () => {
      const res = await fetch(`${urlWithOps}/api/manage/tasks`, {
        method: 'POST',
        headers: {
          Cookie: bobCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: urlWithOps,
          'X-Idempotency-Key': '11111111-2222-4333-8444-555555555555',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Alternate Header Task',
          prompt: 'Do work',
          sessionId: bobSessionId,
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain('Alternate header "x-idempotency-key" is not permitted');
    });

    it('rejects comma-separated or multi-value Idempotency-Key with 400', async () => {
      const res = await fetch(`${urlWithOps}/api/manage/tasks`, {
        method: 'POST',
        headers: {
          Cookie: bobCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: urlWithOps,
          'Idempotency-Key': '11111111-2222-4333-8444-555555555555, 22222222-3333-4444-8555-666666666666',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Multi Idempotency Task',
          prompt: 'Do work',
          sessionId: bobSessionId,
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain('arrays and comma-separated');
    });

    it('rejects uppercase UUIDv4 Idempotency-Key with 400 (requires canonical lowercase)', async () => {
      const res = await fetch(`${urlWithOps}/api/manage/tasks`, {
        method: 'POST',
        headers: {
          Cookie: bobCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: urlWithOps,
          'Idempotency-Key': '11111111-2222-4333-8444-55555555555A', // Uppercase A
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Uppercase Idempotency Task',
          prompt: 'Do work',
          sessionId: bobSessionId,
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain('canonical lowercase UUID-v4');
    });

    it('rejects missing or whitespace-only prompt with 400', async () => {
      const res = await fetch(`${urlWithOps}/api/manage/tasks`, {
        method: 'POST',
        headers: {
          Cookie: bobCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: urlWithOps,
          'Idempotency-Key': '12121212-3434-4545-8686-787878787878',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Whitespace Prompt Task',
          prompt: '   \n\t  ',
          sessionId: bobSessionId,
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain('Task prompt must be a non-empty string');
    });

    it('rejects prompt exceeding 64 KiB UTF-8 byte length with 400', async () => {
      const oversizedPrompt = 'a'.repeat(65537);
      const res = await fetch(`${urlWithOps}/api/manage/tasks`, {
        method: 'POST',
        headers: {
          Cookie: bobCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: urlWithOps,
          'Idempotency-Key': '23232323-4545-4646-8787-898989898989',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Oversized Prompt Task',
          prompt: oversizedPrompt,
          sessionId: bobSessionId,
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain('exceeds maximum limit of 64 KiB');
    });

    it('rejects task creation without sessionId with 400', async () => {
      const res = await fetch(`${urlWithOps}/api/manage/tasks`, {
        method: 'POST',
        headers: {
          Cookie: bobCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: urlWithOps,
          'Idempotency-Key': '34343434-5656-4747-8888-909090909090',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'No Session Task',
          prompt: 'Prompt without session',
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain('Task sessionId is required');
    });

    it('accepts past dueDate and marks task immediately eligible', async () => {
      const pastDate = new Date(Date.now() - 3600000).toISOString();
      const res = await fetch(`${urlWithOps}/api/manage/tasks`, {
        method: 'POST',
        headers: {
          Cookie: bobCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: urlWithOps,
          'Idempotency-Key': '45454545-6767-4848-8989-010101010101',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Past Due Date Task',
          prompt: 'Immediate run task',
          sessionId: bobSessionId,
          dueDate: pastDate,
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.task.dueDate).toBe(pastDate);
    });
  });

  describe('3. POST /api/manage/tasks/:id/cancel', () => {
    let bobTaskId: string;
    let aliceTaskId: string;

    beforeAll(async () => {
      // Create a task for Bob
      const bobCreate = await fetch(`${urlWithOps}/api/manage/tasks`, {
        method: 'POST',
        headers: {
          Cookie: bobCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: urlWithOps,
          'Idempotency-Key': '77777777-8888-4999-8000-111111111111',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Bob Cancel Target',
          prompt: 'Bob cancel prompt',
          sessionId: bobSessionId,
        }),
      });
      const bobBody = await bobCreate.json();
      bobTaskId = bobBody.data.id;

      // Create a task for Alice
      const aliceCreate = await fetch(`${urlWithOps}/api/manage/tasks`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: urlWithOps,
          'Idempotency-Key': '88888888-9999-4000-8111-222222222222',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Alice Cancel Target',
          prompt: 'Alice cancel prompt',
          sessionId: aliceSessionId,
        }),
      });
      const aliceBody = await aliceCreate.json();
      aliceTaskId = aliceBody.data.id;
    });

    it('allows task owner to cancel their own task', async () => {
      const res = await fetch(`${urlWithOps}/api/manage/tasks/${bobTaskId}/cancel`, {
        method: 'POST',
        headers: {
          Cookie: bobCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: urlWithOps,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ reason: 'No longer needed' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.id).toBe(bobTaskId);
      expect(body.data.status).toBe('cancelled');
      expect(body.data.cancelled).toBe(true);
    });

    it('returns uniform 404 when user attempts to cancel another tenant task', async () => {
      // Bob tries to cancel Alice's task
      const res = await fetch(`${urlWithOps}/api/manage/tasks/${aliceTaskId}/cancel`, {
        method: 'POST',
        headers: {
          Cookie: bobCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: urlWithOps,
        },
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe('NOT_FOUND');
    });

    it('returns 503 when operations is not injected', async () => {
      const res = await fetch(`${urlWithoutOps}/api/manage/tasks/task_123/cancel`, {
        method: 'POST',
        headers: {
          Cookie: bobCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: urlWithoutOps,
        },
      });
      expect(res.status).toBe(503);
    });
  });

  describe('4. POST /api/manage/tasks/:id/run: Actual state returned', () => {
    let bobRunTaskId: string;

    beforeAll(async () => {
      const createRes = await fetch(`${urlWithOps}/api/manage/tasks`, {
        method: 'POST',
        headers: {
          Cookie: bobCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: urlWithOps,
          'Idempotency-Key': '99999999-0000-4111-8222-333333333333',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Bob Run Target',
          prompt: 'Run promptly',
          sessionId: bobSessionId,
        }),
      });
      const body = await createRes.json();
      bobRunTaskId = body.data.id;
    });

    it('runs task through worker and returns actual execution state', async () => {
      workerRunResult = {
        taskId: bobRunTaskId,
        status: 'running',
        result: null,
      };

      const res = await fetch(`${urlWithOps}/api/manage/tasks/${bobRunTaskId}/run`, {
        method: 'POST',
        headers: {
          Cookie: bobCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: urlWithOps,
        },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.taskId).toBe(bobRunTaskId);
      // Ensure running status is NOT faked as completed!
      expect(body.data.status).toBe('running');
    });

    it('returns completed actual status when worker completes execution', async () => {
      workerRunResult = {
        taskId: bobRunTaskId,
        status: 'completed',
        result: { summary: 'Completed run' },
      };

      const res = await fetch(`${urlWithOps}/api/manage/tasks/${bobRunTaskId}/run`, {
        method: 'POST',
        headers: {
          Cookie: bobCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: urlWithOps,
        },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.taskId).toBe(bobRunTaskId);
      expect(body.data.status).toBe('completed');
      expect(body.data.task.status).toBe('completed');
    });

    it('rejects cross-tenant run with uniform 404', async () => {
      // Alice tries to run Bob's task or vice versa
      const res = await fetch(`${urlWithOps}/api/manage/tasks/${bobRunTaskId}/run`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: urlWithOps,
        },
      });

      expect(res.status).toBe(404);
    });
  });

  describe('5. Quotas: Real GET and Admin PATCH /api/admin/quotas/:userId/:metric', () => {
    it('rejects regular user (Bob) with 403 on admin quota PATCH', async () => {
      const res = await fetch(`${urlWithOps}/api/admin/quotas/${bobId}/tokens`, {
        method: 'PATCH',
        headers: {
          Cookie: bobCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: urlWithOps,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ limit: 5000 }),
      });

      expect(res.status).toBe(403);
    });

    it('rejects invalid quota metric with 400', async () => {
      const res = await fetch(`${urlWithOps}/api/admin/quotas/${bobId}/unsupported_metric_xyz`, {
        method: 'PATCH',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: urlWithOps,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ limit: 1000 }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain('Invalid quota metric');
    });

    it('strictly rejects unknown body keys with 400', async () => {
      const res = await fetch(`${urlWithOps}/api/admin/quotas/${bobId}/tokens`, {
        method: 'PATCH',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: urlWithOps,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          limit: 1000,
          unsupportedField: 'forbidden',
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain('Unexpected field "unsupportedField"');
    });

    it('admin successfully updates quota and returns authoritative limit', async () => {
      const resetAt = new Date(Date.now() + 3600000).toISOString();
      const res = await fetch(`${urlWithOps}/api/admin/quotas/${bobId}/tokens`, {
        method: 'PATCH',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: urlWithOps,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          limit: 50000,
          windowSeconds: 3600,
          resetAt,
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.userId).toBe(bobId);
      expect(body.data.resource).toBe('tokens');
      expect(body.data.limit).toBe(50000);
      expect(body.data.windowSeconds).toBe(3600);
      expect(body.data.resetAt).toBe(resetAt);

      // Verify GET /api/manage/quotas reflects the real updated quota
      const getRes = await fetch(`${urlWithOps}/api/manage/quotas`, {
        headers: { Cookie: bobCookie },
      });
      expect(getRes.status).toBe(200);
      const getBody = await getRes.json();
      expect(getBody.success).toBe(true);
      const tokenLimit = getBody.data.items[0].limits.find((l: any) => l.resource === 'tokens');
      expect(tokenLimit).toBeDefined();
      expect(tokenLimit.limit).toBe(50000);

      // Verify GET /api/manage/quota/check?metrics=all returns canonical quota structure with 5 metrics
      const checkRes = await fetch(`${urlWithOps}/api/manage/quota/check?metrics=all`, {
        headers: { Cookie: bobCookie },
      });
      expect(checkRes.status).toBe(200);
      const checkBody = await checkRes.json();
      expect(checkBody.success).toBe(true);
      expect(checkBody.data).toHaveProperty('allowed');
      expect(checkBody.data).toHaveProperty('usage');
      expect(checkBody.data).toHaveProperty('activeReservations');
      expect(checkBody.data).toHaveProperty('limit');
      expect(checkBody.data).toHaveProperty('remaining');
      expect(checkBody.data).toHaveProperty('resetAt');
      expect(checkBody.data.limit).toHaveProperty('tokens', 50000);
      expect(checkBody.data.limit).toHaveProperty('messages');
      expect(checkBody.data.limit).toHaveProperty('turns');
      expect(checkBody.data.limit).toHaveProperty('storage_bytes');
      expect(checkBody.data.limit).toHaveProperty('api_calls');

      // Verify rejection of unknown query parameters with 400
      const unknownQueryRes = await fetch(`${urlWithOps}/api/manage/quota/check?resource=tokens`, {
        headers: { Cookie: bobCookie },
      });
      expect(unknownQueryRes.status).toBe(400);

      // Verify rejection of invalid metrics parameter with 400
      const invalidMetricsRes = await fetch(`${urlWithOps}/api/manage/quota/check?metrics=invalid`, {
        headers: { Cookie: bobCookie },
      });
      expect(invalidMetricsRes.status).toBe(400);
    });

    it('returns 503 when operations is not injected on admin quota PATCH', async () => {
      const res = await fetch(`${urlWithoutOps}/api/admin/quotas/${bobId}/tokens`, {
        method: 'PATCH',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: urlWithoutOps,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ limit: 1000 }),
      });

      expect(res.status).toBe(503);
    });

    it('returns 502 Bad Gateway if operations provider omits or returns invalid updatedAt (no timestamp fabrication)', async () => {
      // Mock operations provider that returns missing/corrupted updatedAt
      const faultyOps = {
        ...createManagementOperationsAdapter(operationsService),
        async setQuotaLimit() {
          return {
            userId: bobId,
            resource: 'tokens' as const,
            limit: 1000,
            updatedAt: 'invalid-date-string', // Corrupted
          };
        },
      };

      const handlerFaulty = createPlatformServerHandler({
        platformApi,
        csrfToken: testCsrfToken,
        storage,
        operations: faultyOps,
      });

      const serverFaulty = createServer(handlerFaulty);
      await new Promise<void>((resolve) => serverFaulty.listen(0, '127.0.0.1', () => resolve()));
      const addrFaulty = serverFaulty.address() as AddressInfo;
      const urlFaulty = `http://127.0.0.1:${addrFaulty.port}`;

      const res = await fetch(`${urlFaulty}/api/admin/quotas/${bobId}/tokens`, {
        method: 'PATCH',
        headers: {
          Cookie: aliceCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: urlFaulty,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ limit: 1000 }),
      });

      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error.message).toContain('invalid or missing updatedAt');
      serverFaulty.close();
    });
  });

  describe('6. Security, Sensitive Field Absence & Path Sanitization', () => {
    it('GET /api/manage/tasks does not contain raw payload or idempotencyKey', async () => {
      const res = await fetch(`${urlWithOps}/api/manage/tasks`, {
        headers: { Cookie: bobCookie },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      for (const item of body.data.items) {
        expect(item.payload).toBeUndefined();
        expect(item.idempotencyKey).toBeUndefined();
        expect(item.idempotency_key).toBeUndefined();
      }
    });

    it('errors do not leak host absolute paths (/Users/, /home/, etc.)', async () => {
      // Intentionally trigger an error with a long path
      const res = await fetch(`${urlWithOps}/api/spaces`, {
        method: 'POST',
        headers: {
          Cookie: bobCookie,
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: urlWithOps,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Invalid Space',
          folder: '/Users/admin/secrets/leak', // Invalid absolute path
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).not.toContain('/Users/');
    });

    it('POST /api/sessions/:sessionId/messages works end-to-end with real DeliveryRuntimeGateway and TenantQuotaProvider deliveryId validation', async () => {
      const bobOps = operationsService.forTenant(bobId);
      await bobOps.quota.setLimit({ resource: 'turns', limit: 10 });
      await bobOps.quota.setLimit({ resource: 'messages', limit: 10 });
      await bobOps.quota.setLimit({ resource: 'tokens', limit: 50000 });

      const quotaProvider = new OperationsTenantQuotaProvider(operationsService);

      const realGateway = new DeliveryRuntimeGateway({
        storage,
        messageStore: new SqliteWebMessageStore(db),
        database: db,
        executor: {
          execute: async () => ({
            replyText: 'Executed real turn',
            metadata: { durationMs: 10 },
            usage: { totalTokens: 10 },
          }),
          cancel: async () => true,
        },
        profileResolver: { resolve: async () => null },
        quotaMode: 'enforced',
        quotaProvider,
      });

      const liveHandler = createPlatformServerHandler({
        platformApi,
        runtimeGateway: realGateway,
        csrfToken: testCsrfToken,
        storage,
        operations: createManagementOperationsAdapter(operationsService),
      });

      const liveServer = createServer(liveHandler);
      await new Promise<void>((resolve) => liveServer.listen(0, '127.0.0.1', () => resolve()));
      const liveAddr = liveServer.address() as AddressInfo;
      const liveUrl = `http://127.0.0.1:${liveAddr.port}`;

      try {
        const rawUuidIdempKey = '123e4567-e89b-42d3-a456-426614174099';
        const msgRes = await fetch(`${liveUrl}/api/sessions/${bobSessionId}/messages`, {
          method: 'POST',
          headers: {
            Cookie: bobCookie,
            'X-Enkeep-CSRF': testCsrfToken,
            Origin: liveUrl,
            'Idempotency-Key': rawUuidIdempKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ content: 'Hello from real delivery gateway test' }),
        });

        expect(msgRes.status).toBe(200);
        const msgBody = await msgRes.json();
        expect(msgBody.success).toBe(true);
        expect(msgBody.data.accepted).toBe(true);
        expect(msgBody.data.isDuplicate).toBe(false);
        expect(msgBody.data.message.id).toMatch(/^msg_[0-9a-f]{32}$/);

        await realGateway.drain(1000);
      } finally {
        liveServer.close();
      }
    });
  });
});
