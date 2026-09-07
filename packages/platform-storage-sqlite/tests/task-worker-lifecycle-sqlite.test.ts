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
  SqliteTenantScopedTaskRepository,
} from '../src/index.js';
import {
  createPlatformOperations,
  PlatformOperationsService,
  AgentPromptTaskWorker,
  TASK_PROTOCOL_ERROR_CODES,
  type AgentPromptDispatchContext,
  type AgentPromptDispatchResult,
} from '@enkeep/platform-operations';

describe('Sqlite Task Worker Lifecycle, CAS Cancellation & Result Validation', () => {
  let db: DatabaseSync;
  let tempDir: string;
  let dbPath: string;
  let operationsStorage: SqlitePlatformOperationsStorage;
  let operationsService: PlatformOperationsService;
  let activeWorkers: AgentPromptTaskWorker[] = [];

  const validSessionId = 'ses_0123456789abcdef0123456789abcdef';
  const validSpaceId = 'spc_0123456789abcdef0123456789abcdef';
  const validTurnId = 'turn_0123456789abcdef0123456789abcdef';
  const validMessageId = 'msg_0123456789abcdef0123456789abcdef';

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'enkeep-task-lifecycle-test-'));
    dbPath = join(tempDir, 'test.db');
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA journal_mode = WAL;');

    const runner = new SqliteMigrationRunner(db);
    await runner.migrate(BUILTIN_MIGRATIONS);

    // Create test user
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
      VALUES ('user_test', 'testuser', 'hash', 'user', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run();

    operationsStorage = createSqliteOperationsStorage(db);
    operationsService = createPlatformOperations({ storage: operationsStorage });
    activeWorkers = [];
  });

  afterEach(async () => {
    for (const w of activeWorkers) {
      await w.stop({ abortInFlight: true });
    }
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createWorker(
    dispatcher: (context: AgentPromptDispatchContext) => Promise<any>,
    options?: {
      leaseDurationMs?: number;
      heartbeatIntervalMs?: number;
      workerId?: string;
      onError?: (err: Error, ctx: any) => void;
    }
  ) {
    const worker = new AgentPromptTaskWorker({
      workerId: options?.workerId,
      tenantEnumerator: () => ['user_test'],
      getTenantOperations: (tenantId) => operationsService.forTenant(tenantId),
      dispatcher,
      leaseDurationMs: options?.leaseDurationMs ?? 2000,
      heartbeatIntervalMs: options?.heartbeatIntervalMs ?? 100,
      recoverOnStart: true,
      systemRecovery: () => operationsStorage.recoverAfterRestart(),
      onError: options?.onError,
    });
    activeWorkers.push(worker);
    return worker;
  }

  it('completes task and stores strictly validated minimal receipt without extra fields', async () => {
    const ops = operationsService.forTenant('user_test');
    const { task } = await ops.tasks.createTask({
      title: 'Run Agent Prompt',
      payload: {
        type: 'agent_prompt',
        prompt: 'Analyze data',
        sessionId: validSessionId,
        sessionPolicy: 'existing_session',
        spaceId: validSpaceId,
      },
    });

    const nowIso = new Date().toISOString();
    const worker = createWorker(async (ctx) => {
      return {
        status: 'completed',
        completedAt: nowIso,
      };
    });

    const result = await worker.runNow({ taskId: task.id, tenantId: 'user_test' });

    expect(result?.status).toBe('completed');
    expect(result?.result).toEqual({
      status: 'completed',
      completedAt: nowIso,
    });

    const dbTask = await ops.tasks.getTask(task.id);
    expect(dbTask?.status).toBe('completed');
    expect(dbTask?.result).toEqual({
      status: 'completed',
      completedAt: nowIso,
    });
    expect(dbTask?.error).toBeNull();
    expect(dbTask?.leaseExpiresAt).toBeNull();
  });

  it('fails task when dispatcher returns forbidden extra keys (e.g. raw output / error)', async () => {
    const ops = operationsService.forTenant('user_test');
    const { task } = await ops.tasks.createTask({
      title: 'Pollution Task',
      payload: {
        type: 'agent_prompt',
        prompt: 'Do something',
        sessionId: validSessionId,
        sessionPolicy: 'existing_session',
      },
    });

    const worker = createWorker(async () => {
      return {
        turnId: 'turn_0123456789abcdef0123456789abcdef',
        sessionId: validSessionId,
        spaceId: validSpaceId,
        status: 'completed',
        messageId: 'msg_0123456789abcdef0123456789abcdef',
        completedAt: new Date().toISOString(),
        rawAssistantOutput: 'Secret data that must not be stored in task result',
        tokensUsed: 500,
      };
    });

    const result = await worker.runNow({ taskId: task.id, tenantId: 'user_test' });

    expect(result?.status).toBe('failed');
    expect(result?.error).toBe(TASK_PROTOCOL_ERROR_CODES.RESULT_INVALID);

    const dbTask = await ops.tasks.getTask(task.id);
    expect(dbTask?.status).toBe('failed');
    expect(dbTask?.error).toBe(TASK_PROTOCOL_ERROR_CODES.RESULT_INVALID);
    expect(dbTask?.result).toBeNull();
  });

  it('fails task when dispatcher returns non-canonical ISO date', async () => {
    const ops = operationsService.forTenant('user_test');
    const { task } = await ops.tasks.createTask({
      title: 'Invalid Date Task',
      payload: {
        type: 'agent_prompt',
        prompt: 'Do something',
        sessionId: validSessionId,
        sessionPolicy: 'existing_session',
      },
    });

    const worker = createWorker(async () => {
      return {
        turnId: 'turn_0123456789abcdef0123456789abcdef',
        sessionId: validSessionId,
        spaceId: validSpaceId,
        status: 'completed',
        messageId: 'msg_0123456789abcdef0123456789abcdef',
        completedAt: 'not-a-date',
      };
    });

    const result = await worker.runNow({ taskId: task.id, tenantId: 'user_test' });

    expect(result?.status).toBe('failed');
    expect(result?.error).toBe(TASK_PROTOCOL_ERROR_CODES.RESULT_INVALID);

    const dbTask = await ops.tasks.getTask(task.id);
    expect(dbTask?.status).toBe('failed');
    expect(dbTask?.error).toBe(TASK_PROTOCOL_ERROR_CODES.RESULT_INVALID);
  });

  it('cancel-vs-complete CAS: cancelled task in SQLite cannot be completed later by worker', async () => {
    const ops = operationsService.forTenant('user_test');
    const { task } = await ops.tasks.createTask({
      title: 'CAS Race Task',
      payload: {
        type: 'agent_prompt',
        prompt: 'Run turn while cancellation happens',
        sessionId: validSessionId,
        sessionPolicy: 'existing_session',
      },
    });

    let completeResolve: () => void;
    const holdPromise = new Promise<void>((resolve) => {
      completeResolve = resolve;
    });

    const worker = createWorker(async () => {
      await holdPromise;
      return {
        status: 'completed',
        completedAt: new Date().toISOString(),
      };
    });

    const runPromise = worker.runNow({ taskId: task.id, tenantId: 'user_test' });
    await new Promise((r) => setTimeout(r, 50));

    // Cancel in SQLite
    const cancelled = await ops.tasks.cancelTask(task.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.error).toBe(TASK_PROTOCOL_ERROR_CODES.CANCELLED);

    // Release dispatcher
    completeResolve!();
    const runResult = await runPromise;

    expect(runResult?.status).toBe('aborted');

    const checkDb = await ops.tasks.getTask(task.id);
    expect(checkDb?.status).toBe('cancelled');
    expect(checkDb?.result).toBeNull();
  });

  it('worker stop with abortInFlight leaves in-flight task claimed and recoverable in SQLite', async () => {
    const ops = operationsService.forTenant('user_test');
    const { task } = await ops.tasks.createTask({
      title: 'Stop Abort Task',
      payload: {
        type: 'agent_prompt',
        prompt: 'Hang during shutdown',
        sessionId: validSessionId,
        sessionPolicy: 'existing_session',
      },
    });

    let aborted = false;
    const worker = createWorker(async (ctx) => {
      ctx.signal.addEventListener('abort', () => {
        aborted = true;
      });
      await new Promise((r) => setTimeout(r, 1000));
      return {
        status: 'completed',
        completedAt: new Date().toISOString(),
      };
    });

    const runPromise = worker.runNow({ taskId: task.id, tenantId: 'user_test' });
    await new Promise((r) => setTimeout(r, 50));

    await worker.stop({ abortInFlight: true });
    const runResult = await runPromise;

    expect(aborted).toBe(true);
    expect(runResult?.status).toBe('aborted');

    // SQLite DB state must remain 'claimed' (not 'failed') so lease recovery can reset it to pending
    const dbTask = await ops.tasks.getTask(task.id);
    expect(dbTask?.status).toBe('claimed');
    expect(dbTask?.claimantId).toBe(worker.workerId);

    // Advance time and run recovery
    const recovery = await operationsStorage.recoverAfterRestart({ nowIso: new Date(Date.now() + 100_000).toISOString() });
    expect(recovery.recoveredTasks).toBe(1);

    const recoveredDbTask = await ops.tasks.getTask(task.id);
    expect(recoveredDbTask?.status).toBe('pending');
    expect(recoveredDbTask?.claimantId).toBeNull();
  });

  it('heartbeat renewal aborts in-flight execution when task is cancelled in SQLite', async () => {
    const ops = operationsService.forTenant('user_test');
    const { task } = await ops.tasks.createTask({
      title: 'Heartbeat Cancel Detection Task',
      leaseDurationMs: 1000,
      payload: {
        type: 'agent_prompt',
        prompt: 'Long running task cancelled mid-flight',
        sessionId: validSessionId,
        sessionPolicy: 'existing_session',
      },
    });

    let abortSignalTriggered = false;

    const worker = createWorker(async (ctx) => {
      ctx.signal.addEventListener('abort', () => {
        abortSignalTriggered = true;
      });
      // Wait long enough for multiple heartbeat ticks
      await new Promise((r) => setTimeout(r, 400));
      return {
        status: 'completed',
        completedAt: new Date().toISOString(),
      };
    }, { leaseDurationMs: 1000, heartbeatIntervalMs: 50 });

    const runPromise = worker.runNow({ taskId: task.id, tenantId: 'user_test' });

    // Cancel task after 100ms
    await new Promise((r) => setTimeout(r, 100));
    await ops.tasks.cancelTask(task.id);

    const result = await runPromise;
    expect(abortSignalTriggered).toBe(true);
    expect(result?.status === 'aborted' || result?.status === 'lease_lost').toBe(true);

    const dbTask = await ops.tasks.getTask(task.id);
    expect(dbTask?.status).toBe('cancelled');
    expect(dbTask?.result).toBeNull();
  });

  it('enforces canonical task ID and strict input validation in SQLite', async () => {
    const ops = operationsService.forTenant('user_test');

    // 1. Auto-generated ID format: task_ + 32hex
    const { task: autoTask } = await ops.tasks.createTask({
      title: 'Canonical Generated Task',
      payload: {
        type: 'agent_prompt',
        prompt: 'Run task',
        sessionId: 'ses_0123456789abcdef0123456789abcdef',
        sessionPolicy: 'existing_session',
      },
    });
    expect(autoTask.id).toMatch(/^task_[0-9a-f]{32}$/);
    expect(autoTask.id.length).toBe(37);

    // 2. Reject whitespace-padded ID
    await expect(
      ops.tasks.createTask({
        id: ' task_0123456789abcdef0123456789abcdef ',
        title: 'Whitespace ID',
      })
    ).rejects.toThrow();

    // 3. Reject empty string ID
    await expect(
      ops.tasks.createTask({
        id: '',
        title: 'Empty ID',
      })
    ).rejects.toThrow();

    // 4. Reject whitespace-padded title
    await expect(
      ops.tasks.createTask({
        title: '  Padded Title  ',
      })
    ).rejects.toThrow();

    // 5. Reject whitespace-padded dueDate
    await expect(
      ops.tasks.createTask({
        title: 'Valid Title',
        dueDate: ' 2026-01-01T00:00:00.000Z ',
      })
    ).rejects.toThrow();
  });

  it('guarantees worker errors stored in SQLite are safe protocol codes with no raw paths or stack traces', async () => {
    const ops = operationsService.forTenant('user_test');
    const { task } = await ops.tasks.createTask({
      title: 'Execution Failure Task',
      maxRetries: 1,
      payload: {
        type: 'agent_prompt',
        prompt: 'Throw raw exception with path',
        sessionId: validSessionId,
        sessionPolicy: 'existing_session',
      },
    });

    const worker = createWorker(async () => {
      throw new Error('Fatal error in /Users/secret/file.ts at line 42: DB connection failure\n    at internalFunction (/Users/secret/file.ts:42:10)');
    });

    const result = await worker.runNow({ taskId: task.id, tenantId: 'user_test' });
    expect(result?.status).toBe('failed');
    expect(result?.error).toBe(TASK_PROTOCOL_ERROR_CODES.EXECUTION_FAILED);

    const dbTask = await ops.tasks.getTask(task.id);
    expect(dbTask?.status).toBe('failed');
    // Error field must be safe protocol code, not raw error string with /Users/...
    expect(dbTask?.error).toBe(TASK_PROTOCOL_ERROR_CODES.EXECUTION_FAILED);
    expect(dbTask?.error).not.toContain('/Users/');
    expect(dbTask?.error).not.toContain('at internalFunction');
  });

  it('rejects unsupported misfire and overlap policies during creation', async () => {
    const ops = operationsService.forTenant('user_test');

    // 1. Rejection on creation
    await expect(
      ops.tasks.createTask({
        title: 'Reject run_all SQLite',
        scheduleType: 'cron',
        cronExpression: '0 0 * * *',
        misfirePolicy: 'run_all' as any,
        payload: {
          type: 'agent_prompt',
          prompt: 'Execute',
          sessionId: validSessionId,
          sessionPolicy: 'existing_session',
        },
      })
    ).rejects.toThrow();

    await expect(
      ops.tasks.createTask({
        title: 'Reject allow SQLite',
        scheduleType: 'cron',
        cronExpression: '0 0 * * *',
        overlapPolicy: 'allow' as any,
        payload: {
          type: 'agent_prompt',
          prompt: 'Execute',
          sessionId: validSessionId,
          sessionPolicy: 'existing_session',
        },
      })
    ).rejects.toThrow();

    await expect(
      ops.tasks.createTask({
        title: 'Reject queue SQLite',
        scheduleType: 'cron',
        cronExpression: '0 0 * * *',
        overlapPolicy: 'queue' as any,
        payload: {
          type: 'agent_prompt',
          prompt: 'Execute',
          sessionId: validSessionId,
          sessionPolicy: 'existing_session',
        },
      })
    ).rejects.toThrow();
  });
});
