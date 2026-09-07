import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import {
  SqliteMigrationRunner,
  BUILTIN_MIGRATIONS,
  createSqliteOperationsStorage,
  SqliteTenantScopedTaskRepository,
  SqliteTenantScopedQuotaLedgerRepository,
  AgentPromptTaskWorker,
} from '../src/index.js';
import {
  ValidationError,
  QuotaExceededError,
  createPlatformOperations,
} from '@enkeep/platform-operations';

describe('SQLite Task & Quota Hardening, Concurrency & Worker Execution', () => {
  let db: DatabaseSync;
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'enkeep-hardening-sqlite-'));
    dbPath = join(tempDir, 'platform.db');
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    const runner = new SqliteMigrationRunner(db);
    await runner.migrate(BUILTIN_MIGRATIONS);
    db.exec("ALTER TABLE quota_limits ADD COLUMN reset_interval TEXT DEFAULT 'none';");

    // Create test user
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
      VALUES ('user_test', 'testuser', 'hash', 'user', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run();
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('SQLite Task Payload Contract & Due Date Evaluation', () => {
    it('stores valid agent_prompt payload and rejects forbidden execution commands in SQLite', async () => {
      const taskRepo = new SqliteTenantScopedTaskRepository(db, 'user_test');

      // Valid agent_prompt payload with prompt containing natural language word "bash" and required sessionId
      const created = await taskRepo.create({
        title: 'Bash scripting tutor',
        payload: {
          type: 'agent_prompt',
          prompt: 'Write a tutorial on writing bash scripts safely with set -euo pipefail',
          sessionId: 'ses_0123456789abcdef0123456789abcdef',
          sessionPolicy: 'existing_session',
          spaceId: 'spc_0123456789abcdef0123456789abcdef',
        },
      });

      expect(created.id).toBeDefined();
      expect(created.payload?.type).toBe('agent_prompt');
      expect(created.payload?.sessionId).toBe('ses_0123456789abcdef0123456789abcdef');
      expect(created.payload?.prompt).toContain('bash scripts safely');

      // Direct script execution payload with unknown top-level key is rejected
      await expect(
        taskRepo.create({
          title: 'Direct execution',
          payload: { command: 'rm -rf /' } as any,
        })
      ).rejects.toThrow(ValidationError);
    });

    it('honors dueDate filtering in SQLite atomic CAS queries', async () => {
      const taskRepo = new SqliteTenantScopedTaskRepository(db, 'user_test');

      const futureDate = new Date(Date.now() + 100_000).toISOString();
      const pastDate = new Date(Date.now() - 50_000).toISOString();
      const samplePayload = {
        type: 'agent_prompt' as const,
        prompt: 'Scheduled prompt',
        sessionId: 'ses_0123456789abcdef0123456789abcdef',
        sessionPolicy: 'existing_session' as const,
      };

      // Future task
      const futureTask = await taskRepo.create({
        title: 'Future scheduled task',
        dueDate: futureDate,
        priority: 'urgent',
        payload: samplePayload,
      });

      // Past task
      const pastTask = await taskRepo.create({
        title: 'Past due task',
        dueDate: pastDate,
        priority: 'medium',
        payload: samplePayload,
      });

      // Claim should skip the urgent futureTask because it is not due, and pick pastTask
      const claim1 = await taskRepo.claim({ claimantId: 'worker_1', leaseDurationMs: 10_000 });
      expect(claim1).not.toBeNull();
      expect(claim1?.id).toBe(pastTask.id);

      // Subsequent claim finds nothing because futureTask is not due
      const claim2 = await taskRepo.claim({ claimantId: 'worker_1', leaseDurationMs: 10_000 });
      expect(claim2).toBeNull();
    });
  });

  describe('SQLite Quota Fail-Closed Policy & Metric Validation', () => {
    it('defaults to fail-closed in SQLite when resource limit is unconfigured', async () => {
      const quotaRepo = new SqliteTenantScopedQuotaLedgerRepository(db, 'user_test');

      // Unconfigured 'tokens' has limit=0, remaining=0, allowed=false
      const usage = await quotaRepo.getUsage('tokens');
      expect(usage.allowed).toBe(false);
      expect(usage.limit).toBe(0);
      expect(usage.remaining).toBe(0);

      // Reserve must fail
      await expect(
        quotaRepo.reserve({ resource: 'tokens', amount: 100 })
      ).rejects.toThrow(QuotaExceededError);

      // Direct consume must fail
      await expect(
        quotaRepo.directConsume({ resource: 'tokens', amount: 10 })
      ).rejects.toThrow(QuotaExceededError);
    });

    it('allows metered usage once limit is explicitly configured', async () => {
      const quotaRepo = new SqliteTenantScopedQuotaLedgerRepository(db, 'user_test');

      await quotaRepo.setLimit({ resource: 'tokens', limit: 1000 });

      const usage = await quotaRepo.getUsage('tokens');
      expect(usage.allowed).toBe(true);
      expect(usage.limit).toBe(1000);
      expect(usage.remaining).toBe(1000);

      const reservation = await quotaRepo.reserve({ resource: 'tokens', amount: 300 });
      expect(reservation.status).toBe('reserved');

      const afterRes = await quotaRepo.getUsage('tokens');
      expect(afterRes.reserved).toBe(300);
      expect(afterRes.remaining).toBe(700);
    });
  });

  describe('SQLite Worker Lifecycle, Concurrency & Lease Heartbeat', () => {
    const validSessionId = 'ses_0123456789abcdef0123456789abcdef';
    const validSpaceId = 'spc_0123456789abcdef0123456789abcdef';
    const validTurnId = 'turn_0123456789abcdef0123456789abcdef';
    const validMessageId = 'msg_0123456789abcdef0123456789abcdef';

    it('executes tasks end-to-end with SQLite storage and single-process worker', async () => {
      const storage = createSqliteOperationsStorage(db);
      const ops = createPlatformOperations({ storage });
      const tenantOps = ops.forTenant('user_test');

      const { task } = await tenantOps.tasks.createTask({
        title: 'Process User Query',
        payload: {
          type: 'agent_prompt',
          prompt: 'Answer the question: what is 2 + 2?',
          sessionId: validSessionId,
          sessionPolicy: 'existing_session',
        },
      });

      let executedPrompt = '';
      const nowIso = new Date().toISOString();
      const expectedReceipt = {
        status: 'completed',
        completedAt: nowIso,
      };

      const worker = new AgentPromptTaskWorker({
        workerId: 'sqlite_worker_1',
        tenantEnumerator: () => ['user_test'],
        getTenantOperations: (tId) => ops.forTenant(tId),
        dispatcher: async (ctx) => {
          executedPrompt = ctx.payload.prompt ?? '';
          return {
            status: 'completed',
            completedAt: nowIso,
          };
        },
        leaseDurationMs: 5000,
        heartbeatIntervalMs: 500,
      });

      const result = await worker.runNow({ taskId: task.id, tenantId: 'user_test' });

      expect(result?.status).toBe('completed');
      expect(result?.result).toEqual(expectedReceipt);
      expect(executedPrompt).toContain('what is 2 + 2?');

      const checkTask = await tenantOps.tasks.getTask(task.id);
      expect(checkTask?.status).toBe('completed');
      expect(checkTask?.result).toEqual(expectedReceipt);
    });

    it('handles concurrent multi-connection workers competing for same task queue without double claims', async () => {
      const connA = new DatabaseSync(dbPath);
      connA.exec('PRAGMA journal_mode = WAL;');
      connA.exec('PRAGMA foreign_keys = ON;');

      const connB = new DatabaseSync(dbPath);
      connB.exec('PRAGMA journal_mode = WAL;');
      connB.exec('PRAGMA foreign_keys = ON;');

      try {
        const repoA = new SqliteTenantScopedTaskRepository(connA, 'user_test');
        const repoB = new SqliteTenantScopedTaskRepository(connB, 'user_test');

        // Create 10 tasks
        for (let i = 0; i < 10; i++) {
          await repoA.create({
            title: `Batch Task ${i}`,
            payload: {
              type: 'agent_prompt',
              prompt: `Prompt ${i}`,
              sessionId: validSessionId,
              sessionPolicy: 'existing_session',
            },
          });
        }

        // Run 2 concurrent worker loops claiming until empty
        const claimedByA: string[] = [];
        const claimedByB: string[] = [];

        const validWorkerResult = {
          status: 'completed' as const,
          completedAt: new Date().toISOString(),
        };

        const workerLoopA = async () => {
          while (true) {
            const task = await repoA.claim({ claimantId: 'worker_A', leaseDurationMs: 10_000 });
            if (!task) break;
            claimedByA.push(task.id);
            await repoA.complete(task.id, 'worker_A', validWorkerResult);
          }
        };

        const workerLoopB = async () => {
          while (true) {
            const task = await repoB.claim({ claimantId: 'worker_B', leaseDurationMs: 10_000 });
            if (!task) break;
            claimedByB.push(task.id);
            await repoB.complete(task.id, 'worker_B', validWorkerResult);
          }
        };

        await Promise.all([workerLoopA(), workerLoopB()]);

        expect(claimedByA.length + claimedByB.length).toBe(10);
        // Intersect sets to verify zero overlap
        const setA = new Set(claimedByA);
        const setB = new Set(claimedByB);
        for (const id of setA) {
          expect(setB.has(id)).toBe(false);
        }
      } finally {
        connA.close();
        connB.close();
      }
    });

    it('generates a full 128-bit canonical RFC 4122 UUID default workerId without slice', () => {
      const worker = new AgentPromptTaskWorker({
        tenantEnumerator: () => ['user_test'],
        getTenantOperations: (tId) => ({ tasks: new SqliteTenantScopedTaskRepository(db, tId) }),
        dispatcher: async () => {},
      });
      expect(worker.workerId).toMatch(/^worker_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });
  });
});
