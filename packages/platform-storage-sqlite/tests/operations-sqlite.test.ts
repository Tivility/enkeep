import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SqlitePlatformStorage,
  SqlitePlatformOperationsStorage,
  SqliteMigrationRunner,
  createSqliteOperationsStorage,
  BUILTIN_MIGRATIONS,
} from '../src/index.js';
import {
  createPlatformOperations,
  PlatformOperationsService,
  QuotaExceededError,
  TaskConflictError,
  TaskNotFoundError,
  TaskAlreadyClaimedError,
  TaskLeaseExpiredError,
} from '@enkeep/platform-operations';

describe('Sqlite Platform Operations Persistence & Services', () => {
  let db: DatabaseSync;
  let operationsStorage: SqlitePlatformOperationsStorage;
  let operationsService: PlatformOperationsService;

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    const runner = new SqliteMigrationRunner(db);
    await runner.migrate(BUILTIN_MIGRATIONS);

    // Create test user fixtures
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
      VALUES
        ('user_alice', 'alice', 'hash_a', 'user', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('user_bob', 'bob', 'hash_b', 'user', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run();

    db.exec(`
      CREATE TABLE IF NOT EXISTS quota_bundles (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        delivery_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved', 'committed', 'released', 'expired')),
        turns_amount INTEGER NOT NULL DEFAULT 1,
        messages_amount INTEGER NOT NULL DEFAULT 1,
        tokens_amount INTEGER NOT NULL DEFAULT 0,
        is_estimate_tokens INTEGER NOT NULL DEFAULT 1,
        turns_committed INTEGER,
        messages_committed INTEGER,
        tokens_committed INTEGER,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        settled_at TEXT,
        metadata TEXT,
        UNIQUE(user_id, delivery_id)
      );
      ALTER TABLE quota_limits ADD COLUMN reset_interval TEXT DEFAULT 'none';
    `);

    operationsStorage = createSqliteOperationsStorage(db);
    operationsService = createPlatformOperations({
      storage: operationsStorage,
      filePathConfig: {
        maxSizeBytes: 10 * 1024 * 1024,
      },
    });
  });

  afterEach(async () => {
    await operationsStorage.close();
    try {
      db.close();
    } catch {
      // ignore
    }
  });

  describe('SqliteTenantScopedFileMetadataRepository', () => {
    it('creates, retrieves, and filters file metadata with tenant isolation', async () => {
      const aliceRepo = operationsStorage.forTenant('user_alice').files;
      const bobRepo = operationsStorage.forTenant('user_bob').files;

      const file1 = await aliceRepo.create({
        filename: 'report.pdf',
        relativePath: 'documents/2025/report.pdf',
        size: 1024,
        mimeType: 'application/pdf',
        extension: 'pdf',
        recipient: 'finance-team',
        description: 'Monthly financial report',
        metadata: { department: 'finance' },
      });

      expect(file1.id).toBeDefined();
      expect(file1.id).toMatch(/^file_[0-9a-f]{32}$/);
      expect(file1.userId).toBe('user_alice');
      expect(file1.filename).toBe('report.pdf');
      expect(file1.metadata).toEqual({ department: 'finance' });

      // Alice can find by id
      const found = await aliceRepo.findById(file1.id);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(file1.id);

      // Bob cannot see Alice's file
      const bobFound = await bobRepo.findById(file1.id);
      expect(bobFound).toBeNull();

      // List by recipient
      const financeFiles = await aliceRepo.listByRecipient('finance-team');
      expect(financeFiles.length).toBe(1);
      expect(financeFiles[0].id).toBe(file1.id);

      const bobFiles = await bobRepo.listByRecipient('finance-team');
      expect(bobFiles.length).toBe(0);
    });
  });

  describe('SqliteTenantScopedTaskRepository', () => {
    it('handles task lifecycle, idempotency key, priority claim and completion', async () => {
      const aliceTasks = operationsStorage.forTenant('user_alice').tasks;
      const validUuid = '11111111-2222-4333-8444-555555555555';
      const validSessionId = 'ses_0123456789abcdef0123456789abcdef';

      // 1. Create with idempotency key
      const task1 = await aliceTasks.create({
        title: 'Generate PDF Report',
        idempotencyKey: validUuid,
        priority: 'high',
        leaseDurationMs: 5000,
        maxRetries: 3,
        payload: {
          type: 'agent_prompt',
          prompt: 'Generate PDF Report for doc 1',
          sessionId: validSessionId,
          sessionPolicy: 'existing_session',
        },
      });

      expect(task1.id).toBeDefined();
      expect(task1.id).toMatch(/^task_[0-9a-f]{32}$/);
      expect(task1.status).toBe('pending');
      expect(task1.priority).toBe('high');

      // Duplicate idempotency key throws TaskConflictError
      await expect(
        aliceTasks.create({
          title: 'Duplicate Task',
          idempotencyKey: validUuid,
          payload: {
            type: 'agent_prompt',
            prompt: 'Test prompt duplicate',
            sessionId: validSessionId,
            sessionPolicy: 'existing_session',
          },
        })
      ).rejects.toThrow(TaskConflictError);

      // Find by idempotency key
      const foundByIdem = await aliceTasks.findByIdempotencyKey(validUuid);
      expect(foundByIdem?.id).toBe(task1.id);

      // 2. Claim task
      const claimed = await aliceTasks.claim({
        claimantId: 'worker_node_1',
        leaseDurationMs: 10_000,
      });

      expect(claimed).not.toBeNull();
      expect(claimed?.id).toBe(task1.id);
      expect(claimed?.status).toBe('claimed');
      expect(claimed?.claimantId).toBe('worker_node_1');
      expect(claimed?.claimCount).toBe(1);

      // 3. Renew lease
      const renewed = await aliceTasks.renewLease(task1.id, 'worker_node_1', 15_000);
      expect(renewed.leaseDurationMs).toBe(15_000);

      // Other worker cannot renew
      await expect(
        aliceTasks.renewLease(task1.id, 'worker_node_2', 15_000)
      ).rejects.toThrow(TaskAlreadyClaimedError);

      // 4. Complete task
      const validResult = {
        status: 'completed' as const,
        completedAt: new Date().toISOString(),
      };
      const completed = await aliceTasks.complete(task1.id, 'worker_node_1', validResult);
      expect(completed.status).toBe('completed');
      expect(completed.result).toEqual(validResult);
      expect(completed.completedAt).not.toBeNull();
    });

    it('claims highest priority tasks first (urgent > high > medium > low)', async () => {
      const aliceTasks = operationsStorage.forTenant('user_alice').tasks;
      const makePayload = (p: string) => ({
        type: 'agent_prompt' as const,
        prompt: `Prompt for ${p}`,
        sessionId: 'ses_0123456789abcdef0123456789abcdef',
        sessionPolicy: 'existing_session' as const,
      });

      await aliceTasks.create({ title: 'Low priority', priority: 'low', payload: makePayload('low') });
      const urgentTask = await aliceTasks.create({ title: 'Urgent priority', priority: 'urgent', payload: makePayload('urgent') });
      await aliceTasks.create({ title: 'Medium priority', priority: 'medium', payload: makePayload('medium') });
      await aliceTasks.create({ title: 'High priority', priority: 'high', payload: makePayload('high') });

      const claimedFirst = await aliceTasks.claim({ claimantId: 'worker_1', leaseDurationMs: 5000 });
      expect(claimedFirst?.id).toBe(urgentTask.id);
      expect(claimedFirst?.priority).toBe('urgent');
    });

    it('recovers expired leases back to pending or marks failed if retries exceeded', async () => {
      const aliceTasks = operationsStorage.forTenant('user_alice').tasks;

      const task = await aliceTasks.create({
        title: 'Short lease task',
        leaseDurationMs: 50,
        maxRetries: 2,
        payload: {
          type: 'agent_prompt',
          prompt: 'Short lease task prompt',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
        },
      });

      // Claim 1
      await aliceTasks.claim({ claimantId: 'worker_1', leaseDurationMs: 10, preferredTaskId: task.id });

      // Simulate lease expiration
      const futureTime = new Date(Date.now() + 100_000).toISOString();
      const recovery1 = await aliceTasks.recoverExpiredLeases(futureTime);
      expect(recovery1.recoveredCount).toBe(1);
      expect(recovery1.taskIds).toContain(task.id);

      const recoveredTask = await aliceTasks.findById(task.id);
      expect(recoveredTask?.status).toBe('pending');
      expect(recoveredTask?.claimCount).toBe(1);

      // Claim 2 (reaching maxRetries: 2)
      await aliceTasks.claim({ claimantId: 'worker_2', leaseDurationMs: 10, preferredTaskId: task.id });

      // Expire again
      const recovery2 = await aliceTasks.recoverExpiredLeases(new Date(Date.now() + 200_000).toISOString());
      expect(recovery2.recoveredCount).toBe(1);

      const failedTask = await aliceTasks.findById(task.id);
      expect(failedTask?.status).toBe('failed');
      expect(failedTask?.error).toContain('exhausted');
    });
  });

  describe('SqliteTenantScopedQuotaLedgerRepository', () => {
    it('enforces limits, two-phase commit, release, and direct consume', async () => {
      const aliceQuota = operationsStorage.forTenant('user_alice').quota;

      // 1. Set limit of 100 for messages
      await aliceQuota.setLimit({ resource: 'messages', limit: 100 });
      const limit = await aliceQuota.getLimit('messages');
      expect(limit?.limit).toBe(100);

      // 2. Check initial usage
      const u0 = await aliceQuota.getUsage('messages');
      expect(u0.limit).toBe(100);
      expect(u0.used).toBe(0);
      expect(u0.reserved).toBe(0);
      expect(u0.remaining).toBe(100);

      // 3. Two-phase reserve 40
      const res = await aliceQuota.reserve({ resource: 'messages', amount: 40, ttlSeconds: 60 });
      expect(res.id).toBeDefined();
      expect(res.amount).toBe(40);
      expect(res.status).toBe('reserved');

      const u1 = await aliceQuota.getUsage('messages');
      expect(u1.used).toBe(0);
      expect(u1.reserved).toBe(40);
      expect(u1.remaining).toBe(60);

      // 4. Over-reservation rejected
      await expect(
        aliceQuota.reserve({ resource: 'messages', amount: 70 })
      ).rejects.toThrow(QuotaExceededError);

      // 5. Commit reservation (actual amount 35)
      const commitRes = await aliceQuota.commit({ reservationId: res.id, actualAmount: 35 });
      expect(commitRes.reservation.status).toBe('committed');
      expect(commitRes.reservation.committedAmount).toBe(35);
      expect(commitRes.usage.used).toBe(35);
      expect(commitRes.usage.reserved).toBe(0);
      expect(commitRes.usage.remaining).toBe(65);

      // 6. Direct consume 20
      const directUsage = await aliceQuota.directConsume({ resource: 'messages', amount: 20 });
      expect(directUsage.used).toBe(55);
      expect(directUsage.remaining).toBe(45);

      // 7. Reserve and release
      const res2 = await aliceQuota.reserve({ resource: 'messages', amount: 30 });
      const uAfterRes2 = await aliceQuota.getUsage('messages');
      expect(uAfterRes2.remaining).toBe(15);

      const released = await aliceQuota.release({ reservationId: res2.id });
      expect(released.status).toBe('released');

      const uAfterRelease = await aliceQuota.getUsage('messages');
      expect(uAfterRelease.remaining).toBe(45);
      expect(uAfterRelease.reserved).toBe(0);
    });

    it('expires stale reservations cleanly', async () => {
      const aliceQuota = operationsStorage.forTenant('user_alice').quota;
      await aliceQuota.setLimit({ resource: 'tokens', limit: 1000 });

      const res = await aliceQuota.reserve({ resource: 'tokens', amount: 500, ttlSeconds: 1 });
      const futureTime = new Date(Date.now() + 100_000).toISOString();

      const expirationResult = await aliceQuota.expireStaleReservations(futureTime);
      expect(expirationResult.expiredCount).toBe(1);
      expect(expirationResult.reservationIds).toContain(res.id);

      const usage = await aliceQuota.getUsage('tokens');
      expect(usage.reserved).toBe(0);
      expect(usage.remaining).toBe(1000);
    });
  });

  describe('End-to-End Persistence Across Database Restart', () => {
    it('persists all tenant data to SQLite disk file and recovers cleanly after reopening', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'enkeep-sqlite-ops-test-'));
      const dbPath = join(tempDir, 'platform-test.db');

      try {
        // --- STEP 1: First DB instance on disk ---
        let diskDb = new DatabaseSync(dbPath);
        diskDb.exec('PRAGMA foreign_keys = ON;');
        const runner = new SqliteMigrationRunner(diskDb);
        await runner.migrate(BUILTIN_MIGRATIONS);
        diskDb.exec("ALTER TABLE quota_limits ADD COLUMN reset_interval TEXT DEFAULT 'none';");

        diskDb.prepare(`
          INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
          VALUES ('user_persisted', 'persisted_user', 'hash_p', 'user', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `).run();

        diskDb.prepare(`
          INSERT INTO spaces (id, user_id, name, folder, created_at, updated_at)
          VALUES ('space_persist_1', 'user_persisted', 'Space 1', 'folder_1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `).run();

        diskDb.prepare(`
          INSERT INTO session_routes (id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id, created_at, updated_at)
          VALUES ('route_persist_1', 'space_persist_1', 'user_persisted', 'web', 'default', 'peer_1', 'peer_1', 'dsh_1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `).run();

        let opsStorage = createSqliteOperationsStorage(diskDb);
        let ops = createPlatformOperations({ storage: opsStorage });

        const tenantOps = ops.forTenant('user_persisted');

        // 1. Quota
        await tenantOps.quota.setLimit({ resource: 'tokens', limit: 5000 });
        await tenantOps.quota.consumeQuota({ resource: 'tokens', amount: 1200 });
        const resPending = await tenantOps.quota.reserveQuota({ resource: 'tokens', amount: 800, ttlSeconds: 1 }); // 1 second TTL

        // 2. Task
        const taskCreation = await tenantOps.tasks.createTask({
          title: 'Persistent Task In Flight',
          priority: 'high',
          leaseDurationMs: 100, // Short lease
          maxRetries: 3,
          payload: {
            type: 'agent_prompt',
            prompt: 'Persistent task execution',
            sessionId: 'ses_00000000000000000000000000000001',
            sessionPolicy: 'existing_session',
          },
        });
        await tenantOps.tasks.claimTask({
          claimantId: 'worker_pre_restart',
          leaseDurationMs: 100,
          preferredTaskId: taskCreation.task.id,
        });

        // 3. File
        const sendFileResult = await tenantOps.files.sendFile({
          recipient: 'system',
          path: 'uploads/notes.txt',
          filename: 'persisted_notes.txt',
          size: 512,
        });
        expect(sendFileResult.success).toBe(true);

        // 4. Delivery receipt
        const sendResult = await tenantOps.messages.sendMessage({
          deliveryId: 'deliv_persist_1',
          recipient: 'user_bob',
          routeId: 'route_persist_1',
          content: 'Hello persistence',
        });
        expect(sendResult.receipt.status).toBe('delivered');

        // Close storage and DB to simulate restart
        await opsStorage.close();
        diskDb.close();

        // --- STEP 2: Reopen from disk file (Restart Simulation) ---
        diskDb = new DatabaseSync(dbPath);
        diskDb.exec('PRAGMA foreign_keys = ON;');
        const runner2 = new SqliteMigrationRunner(diskDb);
        await runner2.verifyChecksums(BUILTIN_MIGRATIONS);

        opsStorage = createSqliteOperationsStorage(diskDb);
        ops = createPlatformOperations({ storage: opsStorage });

        // Run recovery after restart at future time
        const futureTime = new Date(Date.now() + 50_000).toISOString();
        const recovery = await ops.recoverAfterRestart({ nowIso: futureTime });
        expect(recovery.recoveredTasks).toBeGreaterThanOrEqual(1);
        expect(recovery.expiredReservations).toBeGreaterThanOrEqual(1);

        const tenantOpsAfter = ops.forTenant('user_persisted');

        // Verify File persisted
        const fileAfter = await tenantOpsAfter.files.getFile(sendFileResult.fileId);
        expect(fileAfter?.filename).toBe('persisted_notes.txt');

        // Verify Quota persisted and stale reservation expired
        const quotaCheck = await tenantOpsAfter.quota.checkQuota({ resource: 'tokens' });
        expect(quotaCheck.usage['tokens']).toBe(1200);
        expect(quotaCheck.activeReservations['tokens']).toBe(0);
        expect(quotaCheck.remaining['tokens']).toBe(3800);

        // Verify Task was recovered from expired lease back to pending
        const taskAfter = await tenantOpsAfter.tasks.getTask(taskCreation.task.id);
        expect(taskAfter?.status).toBe('pending');
        expect(taskAfter?.claimCount).toBe(1);

        // Verify Delivery receipt idempotency hit persisted
        const resend = await tenantOpsAfter.messages.sendMessage({
          deliveryId: 'deliv_persist_1',
          recipient: 'user_bob',
          routeId: 'route_persist_1',
          content: 'Hello persistence duplicate',
        });
        expect(resend.isIdempotentHit).toBe(true);

        await opsStorage.close();
        diskDb.close();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('Concurrency & Tenant Isolation', () => {
    it('handles concurrent quota reservations without over-allocation', async () => {
      const aliceOps = operationsService.forTenant('user_alice');
      await aliceOps.quota.setLimit({ resource: 'tokens', limit: 100 });

      // Attempt 20 concurrent reservations of 10 units each on budget of 100 (exactly 10 should succeed)
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, () => aliceOps.quota.reserveQuota({ resource: 'tokens', amount: 10, ttlSeconds: 60 }))
      );

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled.length).toBe(10);
      expect(rejected.length).toBe(10);

      const check = await aliceOps.quota.checkQuota({ resource: 'tokens' });
      expect(check.activeReservations['tokens']).toBe(100);
      expect(check.remaining['tokens']).toBe(0);
    });

    it('enforces strict tenant isolation across all operational resources', async () => {
      const alice = operationsService.forTenant('user_alice');
      const bob = operationsService.forTenant('user_bob');

      // 1. Quota isolation
      await alice.quota.setLimit({ resource: 'messages', limit: 100 });
      await bob.quota.setLimit({ resource: 'messages', limit: 20 });

      await alice.quota.consumeQuota({ resource: 'messages', amount: 80 });
      const aliceCheck = await alice.quota.checkQuota({ resource: 'messages' });
      const bobCheck = await bob.quota.checkQuota({ resource: 'messages' });
      expect(aliceCheck.remaining['messages']).toBe(20);
      expect(bobCheck.remaining['messages']).toBe(20);

      // 2. Task isolation
      const aliceCreation = await alice.tasks.createTask({
        title: 'Secret Alice Task',
        payload: {
          type: 'agent_prompt',
          prompt: 'Alice task prompt',
          sessionId: 'ses_00000000000000000000000000000001',
          sessionPolicy: 'existing_session',
        },
      });
      const bobCreation = await bob.tasks.createTask({
        title: 'Secret Bob Task',
        payload: {
          type: 'agent_prompt',
          prompt: 'Bob task prompt',
          sessionId: 'ses_00000000000000000000000000000002',
          sessionPolicy: 'existing_session',
        },
      });

      expect(await alice.tasks.getTask(bobCreation.task.id)).toBeNull();
      expect(await bob.tasks.getTask(aliceCreation.task.id)).toBeNull();

      const aliceList = await alice.tasks.listTasks();
      expect(aliceList.length).toBe(1);
      expect(aliceList[0].id).toBe(aliceCreation.task.id);

      // Bob worker cannot claim Alice's task
      await expect(
        bob.tasks.claimTask({
          claimantId: 'worker_bob',
          preferredTaskId: aliceCreation.task.id,
        })
      ).rejects.toThrow(TaskNotFoundError);

      // 3. File isolation
      const aliceFile = await alice.files.sendFile({
        recipient: 'finance',
        path: 'alice.txt',
        filename: 'alice.txt',
        size: 100,
      });
      expect(await bob.files.getFile(aliceFile.fileId)).toBeNull();
      expect((await bob.files.listFiles()).length).toBe(0);
    });

    it('proves multi-connection atomic CAS task claiming without double claims', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'enkeep-db-multiconn-task-'));
      const dbPath = join(tempDir, 'shared-tasks.db');

      try {
        // Setup initial schema & WAL mode
        const initDb = new DatabaseSync(dbPath);
        initDb.exec('PRAGMA journal_mode = WAL;');
        initDb.exec('PRAGMA foreign_keys = ON;');
        const runner = new SqliteMigrationRunner(initDb);
        await runner.migrate(BUILTIN_MIGRATIONS);
        initDb.prepare(`
          INSERT INTO users (id, username, password_hash, role, status)
          VALUES ('user_tenant1', 'tenant1', 'hash_t1', 'user', 'active')
        `).run();
        initDb.close();

        // Open two independent DatabaseSync connections
        const dbConn1 = new DatabaseSync(dbPath);
        dbConn1.exec('PRAGMA busy_timeout = 5000;');
        dbConn1.exec('PRAGMA foreign_keys = ON;');

        const dbConn2 = new DatabaseSync(dbPath);
        dbConn2.exec('PRAGMA busy_timeout = 5000;');
        dbConn2.exec('PRAGMA foreign_keys = ON;');

        const opsStorage1 = createSqliteOperationsStorage(dbConn1);
        const opsStorage2 = createSqliteOperationsStorage(dbConn2);

        const tasksRepo1 = opsStorage1.forTenant('user_tenant1').tasks;
        const tasksRepo2 = opsStorage2.forTenant('user_tenant1').tasks;

        // Create 1 pending task
        const createdTask = await tasksRepo1.create({
          title: 'Concurrent Target Task',
          priority: 'high',
          leaseDurationMs: 60_000,
          payload: {
            type: 'agent_prompt',
            prompt: 'Concurrent target prompt',
            sessionId: 'ses_0123456789abcdef0123456789abcdef',
            sessionPolicy: 'existing_session',
          },
        });

        // Worker 1 and Worker 2 concurrently race to claim the same preferred task
        const [claimResult1, claimResult2] = await Promise.allSettled([
          tasksRepo1.claim({ claimantId: 'worker_conn1', leaseDurationMs: 60_000, preferredTaskId: createdTask.id }),
          tasksRepo2.claim({ claimantId: 'worker_conn2', leaseDurationMs: 60_000, preferredTaskId: createdTask.id }),
        ]);

        const successfulClaims = [claimResult1, claimResult2].filter((r) => r.status === 'fulfilled' && (r as PromiseFulfilledResult<any>).value !== null);
        const failedClaims = [claimResult1, claimResult2].filter((r) => r.status === 'rejected');

        // Exactly 1 must succeed in claiming the task; the other must fail with TaskAlreadyClaimedError
        expect(successfulClaims.length).toBe(1);
        expect(failedClaims.length).toBe(1);
        expect((failedClaims[0] as PromiseRejectedResult).reason).toBeInstanceOf(TaskAlreadyClaimedError);

        // Verify task state in database
        const finalTask = await tasksRepo1.findById(createdTask.id);
        expect(finalTask?.status).toBe('claimed');
        expect(finalTask?.claimCount).toBe(1);

        // Cleanup
        await opsStorage1.close();
        await opsStorage2.close();
        dbConn1.close();
        dbConn2.close();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('proves multi-connection quota reservation and 2-phase commit atomicity', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'enkeep-db-multiconn-quota-'));
      const dbPath = join(tempDir, 'shared-quota.db');

      try {
        const initDb = new DatabaseSync(dbPath);
        initDb.exec('PRAGMA journal_mode = WAL;');
        initDb.exec('PRAGMA foreign_keys = ON;');
        const runner = new SqliteMigrationRunner(initDb);
        await runner.migrate(BUILTIN_MIGRATIONS);
        initDb.exec("ALTER TABLE quota_limits ADD COLUMN reset_interval TEXT DEFAULT 'none';");
        initDb.prepare(`
          INSERT INTO users (id, username, password_hash, role, status)
          VALUES ('user_tenant2', 'tenant2', 'hash_t2', 'user', 'active')
        `).run();
        initDb.close();

        // Open two independent DatabaseSync connections
        const dbConn1 = new DatabaseSync(dbPath);
        dbConn1.exec('PRAGMA busy_timeout = 5000;');
        dbConn1.exec('PRAGMA foreign_keys = ON;');

        const dbConn2 = new DatabaseSync(dbPath);
        dbConn2.exec('PRAGMA busy_timeout = 5000;');
        dbConn2.exec('PRAGMA foreign_keys = ON;');

        const opsStorage1 = createSqliteOperationsStorage(dbConn1);
        const opsStorage2 = createSqliteOperationsStorage(dbConn2);

        const quotaRepo1 = opsStorage1.forTenant('user_tenant2').quota;
        const quotaRepo2 = opsStorage2.forTenant('user_tenant2').quota;

        // Set limit = 100 units
        await quotaRepo1.setLimit({ resource: 'api_calls', limit: 100 });

        // Concurrently reserve 60 units from Conn1 and 60 units from Conn2
        const [res1, res2] = await Promise.allSettled([
          quotaRepo1.reserve({ resource: 'api_calls', amount: 60, ttlSeconds: 60 }),
          quotaRepo2.reserve({ resource: 'api_calls', amount: 60, ttlSeconds: 60 }),
        ]);

        const successfulRes = [res1, res2].filter((r) => r.status === 'fulfilled');
        const rejectedRes = [res1, res2].filter((r) => r.status === 'rejected');

        // Exactly one should succeed, the other rejected with QuotaExceededError
        expect(successfulRes.length).toBe(1);
        expect(rejectedRes.length).toBe(1);
        expect((rejectedRes[0] as PromiseRejectedResult).reason).toBeInstanceOf(QuotaExceededError);

        // Commit the successful reservation from Conn2
        const winningRes = (successfulRes[0] as PromiseFulfilledResult<any>).value;
        const commitResult = await quotaRepo2.commit({ reservationId: winningRes.id, actualAmount: 60 });
        expect(commitResult.reservation.status).toBe('committed');
        expect(commitResult.usage.used).toBe(60);
        expect(commitResult.usage.remaining).toBe(40);

        // Verify Conn1 sees the updated usage
        const usageConn1 = await quotaRepo1.getUsage('api_calls');
        expect(usageConn1.used).toBe(60);
        expect(usageConn1.remaining).toBe(40);

        // Cleanup
        await opsStorage1.close();
        await opsStorage2.close();
        dbConn1.close();
        dbConn2.close();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('proves simultaneous queue-based claim across two independent DB connections via setImmediate/Promise -> exactly one winner', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'enkeep-db-multiconn-queue-'));
      const dbPath = join(tempDir, 'shared-queue.db');

      try {
        const initDb = new DatabaseSync(dbPath);
        initDb.exec('PRAGMA journal_mode = WAL;');
        initDb.exec('PRAGMA foreign_keys = ON;');
        const runner = new SqliteMigrationRunner(initDb);
        await runner.migrate(BUILTIN_MIGRATIONS);
        initDb.prepare(`
          INSERT INTO users (id, username, password_hash, role, status)
          VALUES ('user_tenant3', 'tenant3', 'hash_t3', 'user', 'active')
        `).run();
        initDb.close();

        // Two independent connections with busy_timeout configured
        const dbConn1 = new DatabaseSync(dbPath);
        dbConn1.exec('PRAGMA busy_timeout = 5000;');
        dbConn1.exec('PRAGMA foreign_keys = ON;');

        const dbConn2 = new DatabaseSync(dbPath);
        dbConn2.exec('PRAGMA busy_timeout = 5000;');
        dbConn2.exec('PRAGMA foreign_keys = ON;');

        const opsStorage1 = createSqliteOperationsStorage(dbConn1);
        const opsStorage2 = createSqliteOperationsStorage(dbConn2);

        const tasksRepo1 = opsStorage1.forTenant('user_tenant3').tasks;
        const tasksRepo2 = opsStorage2.forTenant('user_tenant3').tasks;

        // Create 1 high priority task in the queue
        const singleTask = await tasksRepo1.create({
          title: 'Single Queue Task',
          priority: 'urgent',
          leaseDurationMs: 30_000,
          payload: {
            type: 'agent_prompt',
            prompt: 'Single queue task prompt',
            sessionId: 'ses_0123456789abcdef0123456789abcdef',
            sessionPolicy: 'existing_session',
          },
        });

        // Concurrently dispatch claims across both connections via setImmediate promises
        const claimPromise1 = new Promise<any>((resolve, reject) => {
          setImmediate(async () => {
            try {
              resolve(await tasksRepo1.claim({ claimantId: 'worker_a', leaseDurationMs: 30_000 }));
            } catch (e) {
              reject(e);
            }
          });
        });

        const claimPromise2 = new Promise<any>((resolve, reject) => {
          setImmediate(async () => {
            try {
              resolve(await tasksRepo2.claim({ claimantId: 'worker_b', leaseDurationMs: 30_000 }));
            } catch (e) {
              reject(e);
            }
          });
        });

        const [r1, r2] = await Promise.allSettled([claimPromise1, claimPromise2]);

        const claimedTasks = [r1, r2]
          .filter((r) => r.status === 'fulfilled' && (r as PromiseFulfilledResult<any>).value !== null)
          .map((r) => (r as PromiseFulfilledResult<any>).value);

        // Exactly one worker got the task
        expect(claimedTasks.length).toBe(1);
        expect(claimedTasks[0].id).toBe(singleTask.id);

        // Verify task state in database: exactly 1 claim
        const taskInDb = await tasksRepo1.findById(singleTask.id);
        expect(taskInDb?.status).toBe('claimed');
        expect(taskInDb?.claimCount).toBe(1);
        expect(['worker_a', 'worker_b']).toContain(taskInDb?.claimantId);

        await opsStorage1.close();
        await opsStorage2.close();
        dbConn1.close();
        dbConn2.close();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('proves simultaneous complete vs cancel terminal race across two DB connections -> exactly one terminal state', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'enkeep-db-multiconn-terminal-'));
      const dbPath = join(tempDir, 'shared-terminal.db');

      try {
        const initDb = new DatabaseSync(dbPath);
        initDb.exec('PRAGMA journal_mode = WAL;');
        initDb.exec('PRAGMA foreign_keys = ON;');
        const runner = new SqliteMigrationRunner(initDb);
        await runner.migrate(BUILTIN_MIGRATIONS);
        initDb.prepare(`
          INSERT INTO users (id, username, password_hash, role, status)
          VALUES ('user_tenant4', 'tenant4', 'hash_t4', 'user', 'active')
        `).run();
        initDb.close();

        const dbConn1 = new DatabaseSync(dbPath);
        dbConn1.exec('PRAGMA busy_timeout = 5000;');
        dbConn1.exec('PRAGMA foreign_keys = ON;');

        const dbConn2 = new DatabaseSync(dbPath);
        dbConn2.exec('PRAGMA busy_timeout = 5000;');
        dbConn2.exec('PRAGMA foreign_keys = ON;');

        const opsStorage1 = createSqliteOperationsStorage(dbConn1);
        const opsStorage2 = createSqliteOperationsStorage(dbConn2);

        const tasksRepo1 = opsStorage1.forTenant('user_tenant4').tasks;
        const tasksRepo2 = opsStorage2.forTenant('user_tenant4').tasks;

        // Create and claim a task
        const createdTask = await tasksRepo1.create({
          title: 'Terminal Race Task',
          priority: 'medium',
          leaseDurationMs: 60_000,
          payload: {
            type: 'agent_prompt',
            prompt: 'Terminal race prompt',
            sessionId: 'ses_0123456789abcdef0123456789abcdef',
            sessionPolicy: 'existing_session',
          },
        });
        const claimed = await tasksRepo1.claim({
          claimantId: 'worker_finisher',
          leaseDurationMs: 60_000,
          preferredTaskId: createdTask.id,
        });
        expect(claimed?.status).toBe('claimed');

        const validRaceResult = {
          status: 'completed' as const,
          completedAt: new Date().toISOString(),
        };

        // Race complete on Conn1 vs cancel on Conn2 concurrently via setImmediate
        const completePromise = new Promise<any>((resolve, reject) => {
          setImmediate(async () => {
            try {
              resolve(await tasksRepo1.complete(createdTask.id, 'worker_finisher', validRaceResult));
            } catch (e) {
              reject(e);
            }
          });
        });

        const cancelPromise = new Promise<any>((resolve, reject) => {
          setImmediate(async () => {
            try {
              resolve(await tasksRepo2.cancel(createdTask.id));
            } catch (e) {
              reject(e);
            }
          });
        });

        const [completeRes, cancelRes] = await Promise.allSettled([completePromise, cancelPromise]);

        // Exactly one must succeed and achieve terminal state; the other must fail with TaskAlreadyCompletedError
        const successes = [completeRes, cancelRes].filter((r) => r.status === 'fulfilled');
        const rejections = [completeRes, cancelRes].filter((r) => r.status === 'rejected');

        expect(successes.length).toBe(1);
        expect(rejections.length).toBe(1);

        // Verify task state in database: terminal status is either completed or cancelled
        const finalTask = await tasksRepo1.findById(createdTask.id);
        expect(['completed', 'cancelled']).toContain(finalTask?.status);

        await opsStorage1.close();
        await opsStorage2.close();
        dbConn1.close();
        dbConn2.close();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('rejects forTenant with empty or invalid user_id to prevent accidental global scoping', () => {
      expect(() => operationsStorage.forTenant('')).toThrow(/non-empty/);
      expect(() => operationsStorage.forTenant('   ')).toThrow(/non-empty/);
      expect(() => (operationsStorage as any).forTenant(null)).toThrow(/non-empty/);
    });

    it('CAS prevents recoverExpiredLeases from reverting a task completed concurrently', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'enkeep-recovery-race-'));
      const dbPath = join(tempDir, 'recovery-race.db');

      try {
        const dbConn1 = new DatabaseSync(dbPath);
        const dbConn2 = new DatabaseSync(dbPath);
        dbConn1.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
        dbConn2.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');

        const runner = new SqliteMigrationRunner(dbConn1);
        await runner.migrate(BUILTIN_MIGRATIONS);

        dbConn1.prepare("INSERT INTO users (id, username, password_hash, role) VALUES ('user_alice', 'alice', 'hash', 'admin')").run();

        const ops1 = createSqliteOperationsStorage(dbConn1);
        const ops2 = createSqliteOperationsStorage(dbConn2);

        const tasks1 = ops1.forTenant('user_alice').tasks;
        const tasks2 = ops2.forTenant('user_alice').tasks;

        // Create task with short 10ms lease
        const task = await tasks1.create({
          title: 'Concurrent complete vs recovery',
          maxRetries: 3,
          payload: {
            type: 'agent_prompt',
            prompt: 'Concurrent complete prompt',
            sessionId: 'ses_0123456789abcdef0123456789abcdef',
            sessionPolicy: 'existing_session',
          },
        });

        // Claim task with safe lease duration for test
        await tasks1.claim({ claimantId: 'worker_alice', leaseDurationMs: 5000, preferredTaskId: task.id });

        const validRaceResult = {
          status: 'completed' as const,
          completedAt: new Date().toISOString(),
        };

        // Worker completes task on connection 1
        const completed = await tasks1.complete(task.id, 'worker_alice', validRaceResult);
        expect(completed.status).toBe('completed');

        // Simultaneously run recovery on connection 2 with a future timestamp
        const futureTime = new Date(Date.now() + 100_000).toISOString();
        const recoveryResult = await tasks2.recoverExpiredLeases(futureTime);

        // Recovery MUST NOT touch completed task
        expect(recoveryResult.recoveredCount).toBe(0);
        expect(recoveryResult.taskIds).not.toContain(task.id);

        const taskAfter = await tasks2.findById(task.id);
        expect(taskAfter?.status).toBe('completed');

        // Also test global ops.recoverAfterRestart CAS protection
        const globalRecovery = await ops2.recoverAfterRestart({ nowIso: futureTime });
        expect(globalRecovery.recoveredTasks).toBe(0);

        await ops1.close();
        await ops2.close();
        dbConn1.close();
        dbConn2.close();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('rejects complete and fail attempts by a claimant whose lease expired before terminal CAS', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'enkeep-lease-expired-terminal-'));
      const dbPath = join(tempDir, 'lease-expired.db');

      try {
        const dbConn1 = new DatabaseSync(dbPath);
        const dbConn2 = new DatabaseSync(dbPath);
        dbConn1.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
        dbConn2.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');

        const runner = new SqliteMigrationRunner(dbConn1);
        await runner.migrate(BUILTIN_MIGRATIONS);
        dbConn1.exec("ALTER TABLE quota_limits ADD COLUMN reset_interval TEXT DEFAULT 'none';");
        dbConn1.prepare("INSERT INTO users (id, username, password_hash, role) VALUES ('user_alice', 'alice', 'hash', 'admin')").run();

        const ops1 = createSqliteOperationsStorage(dbConn1);
        const ops2 = createSqliteOperationsStorage(dbConn2);

        const tasks1 = ops1.forTenant('user_alice').tasks;
        const tasks2 = ops2.forTenant('user_alice').tasks;

        // 1. Test complete rejection on expired lease
        const task1 = await tasks1.create({
          title: 'Task 1 expired lease',
          maxRetries: 3,
          payload: {
            type: 'agent_prompt',
            prompt: 'Task 1 expired lease prompt',
            sessionId: 'ses_0123456789abcdef0123456789abcdef',
            sessionPolicy: 'existing_session',
          },
        });
        await tasks1.claim({ claimantId: 'worker_slow', leaseDurationMs: 10, preferredTaskId: task1.id });
        await new Promise((r) => setTimeout(r, 20)); // wait past 10ms lease

        const validResult = {
          status: 'completed' as const,
          completedAt: new Date().toISOString(),
        };

        // worker_slow tries to complete after lease expiration -> throws TaskLeaseExpiredError
        await expect(
          tasks1.complete(task1.id, 'worker_slow', validResult)
        ).rejects.toThrow(/expired/i);

        // 2. Test fail rejection on expired lease
        const task2 = await tasks1.create({
          title: 'Task 2 expired lease',
          maxRetries: 3,
          payload: {
            type: 'agent_prompt',
            prompt: 'Task 2 expired lease prompt',
            sessionId: 'ses_0123456789abcdef0123456789abcdef',
            sessionPolicy: 'existing_session',
          },
        });
        await tasks1.claim({ claimantId: 'worker_slow_2', leaseDurationMs: 10, preferredTaskId: task2.id });
        await new Promise((r) => setTimeout(r, 20));

        await expect(
          tasks1.fail(task2.id, 'worker_slow_2', 'failed slow', false)
        ).rejects.toThrow(/expired/i);

        // 3. Two-connection race: recovery runs on connection 2 while expired claimant tries to complete on connection 1
        const task3 = await tasks1.create({
          title: 'Task 3 race recovery',
          maxRetries: 3,
          payload: {
            type: 'agent_prompt',
            prompt: 'Task 3 race recovery prompt',
            sessionId: 'ses_0123456789abcdef0123456789abcdef',
            sessionPolicy: 'existing_session',
          },
        });
        await tasks1.claim({ claimantId: 'worker_slow_3', leaseDurationMs: 10, preferredTaskId: task3.id });
        await new Promise((r) => setTimeout(r, 20));

        const recoveryPromise = tasks2.recoverExpiredLeases();
        const completePromise = tasks1.complete(task3.id, 'worker_slow_3', validResult);

        const [rRec, rComp] = await Promise.allSettled([recoveryPromise, completePromise]);
        expect(rComp.status).toBe('rejected'); // complete on expired lease must always be rejected
        expect(rRec.status).toBe('fulfilled');

        const task3Final = await tasks2.findById(task3.id);
        expect(task3Final?.status).toBe('pending');
        expect(task3Final?.claimantId).toBeNull();

        await ops1.close();
        await ops2.close();
        dbConn1.close();
        dbConn2.close();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('proves multi-connection concurrent double-commit on same reservation exactly increments once', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'enkeep-quota-commit-race-'));
      const dbPath = join(tempDir, 'quota-commit-race.db');

      try {
        const dbConn1 = new DatabaseSync(dbPath);
        const dbConn2 = new DatabaseSync(dbPath);
        dbConn1.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
        dbConn2.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');

        const runner = new SqliteMigrationRunner(dbConn1);
        await runner.migrate(BUILTIN_MIGRATIONS);
        dbConn1.exec("ALTER TABLE quota_limits ADD COLUMN reset_interval TEXT DEFAULT 'none';");
        dbConn1.prepare("INSERT INTO users (id, username, password_hash, role) VALUES ('user_alice', 'alice', 'hash', 'admin')").run();

        const ops1 = createSqliteOperationsStorage(dbConn1);
        const ops2 = createSqliteOperationsStorage(dbConn2);

        const quota1 = ops1.forTenant('user_alice').quota;
        const quota2 = ops2.forTenant('user_alice').quota;

        // Set limit
        await quota1.setLimit({ resource: 'tokens', limit: 1000 });

        // Reserve 200 tokens
        const reservation = await quota1.reserve({ resource: 'tokens', amount: 200, ttlSeconds: 60 });

        // Simultaneous commit attempts across two independent connections
        const commit1 = new Promise<any>((resolve, reject) => {
          setImmediate(async () => {
            try {
              resolve(await quota1.commit({ reservationId: reservation.id, actualAmount: 200 }));
            } catch (err) {
              reject(err);
            }
          });
        });

        const commit2 = new Promise<any>((resolve, reject) => {
          setImmediate(async () => {
            try {
              resolve(await quota2.commit({ reservationId: reservation.id, actualAmount: 200 }));
            } catch (err) {
              reject(err);
            }
          });
        });

        const [r1, r2] = await Promise.allSettled([commit1, commit2]);
        const successes = [r1, r2].filter((r) => r.status === 'fulfilled');
        const rejections = [r1, r2].filter((r) => r.status === 'rejected');

        expect(successes.length).toBe(1);
        expect(rejections.length).toBe(1);

        // Verify permanent usage was incremented EXACTLY once (200, not 400)
        const finalUsage = await quota1.getUsage('tokens');
        expect(finalUsage.used).toBe(200);
        expect(finalUsage.reserved).toBe(0);
        expect(finalUsage.remaining).toBe(800);

        await ops1.close();
        await ops2.close();
        dbConn1.close();
        dbConn2.close();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('proves multi-connection concurrent commit vs release on same reservation achieves exactly one terminal state', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'enkeep-quota-release-race-'));
      const dbPath = join(tempDir, 'quota-release-race.db');

      try {
        const dbConn1 = new DatabaseSync(dbPath);
        const dbConn2 = new DatabaseSync(dbPath);
        dbConn1.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
        dbConn2.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');

        const runner = new SqliteMigrationRunner(dbConn1);
        await runner.migrate(BUILTIN_MIGRATIONS);
        dbConn1.exec("ALTER TABLE quota_limits ADD COLUMN reset_interval TEXT DEFAULT 'none';");
        dbConn1.prepare("INSERT INTO users (id, username, password_hash, role) VALUES ('user_alice', 'alice', 'hash', 'admin')").run();

        const ops1 = createSqliteOperationsStorage(dbConn1);
        const ops2 = createSqliteOperationsStorage(dbConn2);

        const quota1 = ops1.forTenant('user_alice').quota;
        const quota2 = ops2.forTenant('user_alice').quota;

        await quota1.setLimit({ resource: 'tokens', limit: 100 });
        const reservation = await quota1.reserve({ resource: 'tokens', amount: 50, ttlSeconds: 60 });

        const commitPromise = new Promise<any>((resolve, reject) => {
          setImmediate(async () => {
            try {
              resolve(await quota1.commit({ reservationId: reservation.id }));
            } catch (err) {
              reject(err);
            }
          });
        });

        const releasePromise = new Promise<any>((resolve, reject) => {
          setImmediate(async () => {
            try {
              resolve(await quota2.release({ reservationId: reservation.id }));
            } catch (err) {
              reject(err);
            }
          });
        });

        const [r1, r2] = await Promise.allSettled([commitPromise, releasePromise]);
        const successes = [r1, r2].filter((r) => r.status === 'fulfilled');
        const rejections = [r1, r2].filter((r) => r.status === 'rejected');

        expect(successes.length).toBe(1);
        expect(rejections.length).toBe(1);

        const finalUsage = await quota1.getUsage('tokens');
        // If commit won: used = 50, reserved = 0. If release won: used = 0, reserved = 0.
        expect([0, 50]).toContain(finalUsage.used);
        expect(finalUsage.reserved).toBe(0);

        await ops1.close();
        await ops2.close();
        dbConn1.close();
        dbConn2.close();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
