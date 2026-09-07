import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakePlatformOperationsStorage } from './support/index.js';
import { PlatformOperationsService } from '../src/services/platform-operations-service.js';
import { TaskOperationService } from '../src/services/task-operation-service.js';
import {
  AgentPromptTaskWorker,
  TASK_PROTOCOL_ERROR_CODES,
  type AgentPromptDispatchContext,
  type AgentPromptDispatchResult,
  type TaskWorkerTickResult,
} from '../src/index.js';

describe('AgentPromptTaskWorker (Single-Process Worker, Concurrency=1, Heartbeat, Lease Loss Abort, Rich Diagnostics, Observability)', () => {
  let storage: FakePlatformOperationsStorage;
  let service: PlatformOperationsService;
  let activeWorkers: AgentPromptTaskWorker[] = [];

  const validSessionId = 'ses_0123456789abcdef0123456789abcdef';
  const validSpaceId = 'spc_0123456789abcdef0123456789abcdef';

  beforeEach(() => {
    storage = new FakePlatformOperationsStorage();
    service = new PlatformOperationsService({ storage });
    activeWorkers = [];
  });

  afterEach(async () => {
    for (const w of activeWorkers) {
      await w.stop({ abortInFlight: true });
    }
  });

  function createWorker(
    dispatcher: (context: AgentPromptDispatchContext) => Promise<any>,
    options?: {
      leaseDurationMs?: number;
      heartbeatIntervalMs?: number;
      pollIntervalMs?: number;
      workerId?: string;
      onError?: (err: Error, ctx: any) => void;
      tenantEnumerator?: () => Promise<string[]> | string[];
    }
  ) {
    const worker = new AgentPromptTaskWorker({
      workerId: options?.workerId,
      tenantEnumerator: options?.tenantEnumerator ?? (() => ['user_test']),
      getTenantOperations: (tenantId) => service.forTenant(tenantId),
      dispatcher,
      leaseDurationMs: options?.leaseDurationMs ?? 2000,
      heartbeatIntervalMs: options?.heartbeatIntervalMs ?? 200,
      pollIntervalMs: options?.pollIntervalMs ?? 100,
      recoverOnStart: true,
      systemRecovery: () => storage.recoverAfterRestart(),
      onError: options?.onError,
    });
    activeWorkers.push(worker);
    return worker;
  }

  it('generates a full 128-bit UUID workerId by default without low-entropy slicing', () => {
    const worker = new AgentPromptTaskWorker({
      tenantEnumerator: () => ['user_test'],
      getTenantOperations: (tenantId) => service.forTenant(tenantId),
      dispatcher: async () => ({
        status: 'completed',
        completedAt: new Date().toISOString(),
      }),
    });
    activeWorkers.push(worker);

    expect(worker.workerId).toMatch(/^worker_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('claims pending agent_prompt task, renews lease via heartbeat, and completes successfully', async () => {
    const ops = service.forTenant('user_test');
    const { task } = await ops.tasks.createTask({
      title: 'Analyze Logs Task',
      payload: {
        type: 'agent_prompt',
        prompt: 'Analyze error logs from production server and extract stack traces',
        sessionId: validSessionId,
        sessionPolicy: 'existing_session',
        spaceId: validSpaceId,
      },
    });

    let executedWithPrompt = '';
    let executedWithSignal: AbortSignal | null = null;
    const nowIso = new Date().toISOString();

    const worker = createWorker(async (ctx) => {
      executedWithPrompt = ctx.payload.prompt;
      executedWithSignal = ctx.signal;
      // Simulate task taking 300ms (will trigger at least 1 heartbeat renewal)
      await new Promise((resolve) => setTimeout(resolve, 300));
      return {
        status: 'completed',
        completedAt: nowIso,
      };
    }, { leaseDurationMs: 1000, heartbeatIntervalMs: 100 });

    const result = await worker.runNow({ taskId: task.id, tenantId: 'user_test' });

    expect(result).not.toBeNull();
    expect(result?.status).toBe('completed');
    expect(executedWithPrompt).toContain('Analyze error logs');
    expect(executedWithSignal?.aborted).toBe(false);

    // Verify minimal receipt stored in task result (no raw assistant text or extra payload)
    const finishedTask = await ops.tasks.getTask(task.id);
    expect(finishedTask?.status).toBe('completed');
    expect(finishedTask?.result).toEqual({
      status: 'completed',
      completedAt: nowIso,
    });
    expect(finishedTask?.completedAt).not.toBeNull();
    expect(finishedTask?.leaseExpiresAt).toBeNull();
    expect(finishedTask?.error).toBeNull();
  });

  it('strictly enforces bounded concurrency = 1 (rejects simultaneous task execution)', async () => {
    const ops = service.forTenant('user_test');
    const { task: task1 } = await ops.tasks.createTask({
      title: 'Task 1',
      payload: { type: 'agent_prompt', prompt: 'P1', sessionId: validSessionId, sessionPolicy: 'existing_session' },
    });
    const { task: task2 } = await ops.tasks.createTask({
      title: 'Task 2',
      payload: { type: 'agent_prompt', prompt: 'P2', sessionId: validSessionId, sessionPolicy: 'existing_session' },
    });

    let task1Resolve: () => void;
    const task1Promise = new Promise<void>((resolve) => {
      task1Resolve = resolve;
    });

    const worker = createWorker(async (ctx) => {
      if (ctx.task.id === task1.id) {
        await task1Promise;
        return {
          status: 'completed',
          completedAt: new Date().toISOString(),
        };
      }
      return {
        status: 'completed',
        completedAt: new Date().toISOString(),
      };
    });

    // Start task 1 in background
    const task1RunPromise = worker.runNow({ taskId: task1.id, tenantId: 'user_test' });

    // Wait a brief tick so task 1 is in-flight
    await new Promise((r) => setTimeout(r, 50));
    expect(worker.isBusy).toBe(true);

    // Attempting runNow while task 1 is running must throw concurrency error
    await expect(
      worker.runNow({ taskId: task2.id, tenantId: 'user_test' })
    ).rejects.toThrow(/concurrency bounded to 1/i);

    // tick() returns busy
    const tickRes = await worker.tick();
    expect(tickRes.processed).toBe(false);
    expect(tickRes.reason).toBe('busy');

    // Complete task 1
    task1Resolve!();
    const task1Result = await task1RunPromise;
    expect(task1Result?.status).toBe('completed');
    expect(worker.isBusy).toBe(false);

    // Now task 2 can run
    const task2Result = await worker.runNow({ taskId: task2.id, tenantId: 'user_test' });
    expect(task2Result?.status).toBe('completed');
  });

  it('detects lease loss during execution and immediately aborts the in-flight signal', async () => {
    const ops = service.forTenant('user_test');
    const { task } = await ops.tasks.createTask({
      title: 'Long Running Task',
      leaseDurationMs: 300,
      payload: { type: 'agent_prompt', prompt: 'P_long', sessionId: validSessionId, sessionPolicy: 'existing_session' },
    });

    let abortTriggered = false;

    const worker = createWorker(async (ctx) => {
      ctx.signal.addEventListener('abort', () => {
        abortTriggered = true;
      });

      await new Promise((r) => setTimeout(r, 100));

      // Simulate lease expiration sweep in background
      await ops.tasks.recoverExpiredLeases(new Date(Date.now() + 100_000).toISOString());

      // Wait longer so the worker's heartbeat attempts renewal and discovers lease loss
      await new Promise((r) => setTimeout(r, 400));

      if (ctx.signal.aborted) {
        throw ctx.signal.reason;
      }
      return {
        status: 'completed',
        completedAt: new Date().toISOString(),
      };
    }, { leaseDurationMs: 200, heartbeatIntervalMs: 80 });

    const result = await worker.runNow({ taskId: task.id, tenantId: 'user_test' });

    expect(abortTriggered).toBe(true);
    expect(result?.status === 'lease_lost' || result?.status === 'aborted').toBe(true);
  });

  it('exposes rich diagnostics on tenant errors in tick without disguising them as no_due_tasks', async () => {
    const errorsCaptured: any[] = [];
    const faultyWorker = new AgentPromptTaskWorker({
      tenantEnumerator: () => ['faulty_tenant_1', 'healthy_tenant_2'],
      getTenantOperations: (tenantId) => {
        if (tenantId === 'faulty_tenant_1') {
          throw new Error('Database connection refused for tenant');
        }
        return service.forTenant(tenantId);
      },
      dispatcher: async () => ({
        status: 'completed',
        completedAt: new Date().toISOString(),
      }),
      onError: (err, ctx) => {
        errorsCaptured.push({ err: err.message, ctx });
      },
    });
    activeWorkers.push(faultyWorker);

    const tickResult = await faultyWorker.tick();

    expect(tickResult.processed).toBe(false);
    expect(tickResult.reason).toBe('tenant_error');
    expect(tickResult.error).toBe(TASK_PROTOCOL_ERROR_CODES.TENANT_ACCESS_FAILED);
    expect(tickResult.diagnostics).toBeDefined();
    expect(tickResult.diagnostics?.length).toBe(1);
    expect(tickResult.diagnostics?.[0].tenantId).toBe('faulty_tenant_1');
    expect(tickResult.diagnostics?.[0].error).toBe(TASK_PROTOCOL_ERROR_CODES.TENANT_ACCESS_FAILED);

    // Test getDiagnostics() public inspector
    const diag = faultyWorker.getDiagnostics();
    expect(diag.workerId).toBe(faultyWorker.workerId);
    expect(diag.lastError).toBe(TASK_PROTOCOL_ERROR_CODES.TENANT_ACCESS_FAILED);
    expect(diag.lastDiagnostics.length).toBe(1);
    expect(errorsCaptured.length).toBe(1);
    expect(errorsCaptured[0].ctx.tenantId).toBe('faulty_tenant_1');
  });

  it('exposes enumeration error in tick when tenantEnumerator throws', async () => {
    const brokenWorker = new AgentPromptTaskWorker({
      tenantEnumerator: () => {
        throw new Error('Tenant catalog unavailable');
      },
      getTenantOperations: (tenantId) => service.forTenant(tenantId),
      dispatcher: async () => ({
        status: 'completed',
        completedAt: new Date().toISOString(),
      }),
    });
    activeWorkers.push(brokenWorker);

    const tickResult = await brokenWorker.tick();

    expect(tickResult.processed).toBe(false);
    expect(tickResult.reason).toBe('enumeration_error');
    expect(tickResult.error).toBe(TASK_PROTOCOL_ERROR_CODES.TENANT_ENUMERATION_FAILED);
    expect(tickResult.diagnostics?.[0].stage).toBe('operations_access');

    const diag = brokenWorker.getDiagnostics();
    expect(diag.lastError).toBe(TASK_PROTOCOL_ERROR_CODES.TENANT_ENUMERATION_FAILED);
  });

  it('rejects task with invalid payload immediately without dispatching', async () => {
    const ops = service.forTenant('user_test');
    // Bypassing service validation to simulate raw corrupted/malicious DB entry missing sessionId
    const rawRepo = (ops.tasks as any).tasks;
    const maliciousTask = await rawRepo.create({
      title: 'Missing sessionId Task',
      payload: {
        type: 'agent_prompt',
        prompt: 'Valid prompt but no sessionId',
      },
    }).catch(() => null);

    let dispatcherCalled = false;
    const worker = createWorker(async () => {
      dispatcherCalled = true;
      return {
        status: 'completed',
        completedAt: new Date().toISOString(),
      };
    });

    if (maliciousTask) {
      const result = await worker.runNow({ taskId: maliciousTask.id, tenantId: 'user_test' });
      expect(result?.status).toBe('failed');
      expect(result?.error).toBe(TASK_PROTOCOL_ERROR_CODES.PAYLOAD_INVALID);
      expect(dispatcherCalled).toBe(false);

      const dbTask = await ops.tasks.getTask(maliciousTask.id);
      expect(dbTask?.status).toBe('failed');
      expect(dbTask?.error).toBe(TASK_PROTOCOL_ERROR_CODES.PAYLOAD_INVALID);
    }
  });

  it('fails task safely when dispatcher returns invalid result (extra keys / invalid date / wrong status)', async () => {
    const ops = service.forTenant('user_test');
    const { task } = await ops.tasks.createTask({
      title: 'Invalid Result Task',
      payload: {
        type: 'agent_prompt',
        prompt: 'Generate invalid result',
        sessionId: validSessionId,
        sessionPolicy: 'existing_session',
      },
    });

    const worker = createWorker(async () => {
      // Returning extra forbidden keys (e.g. assistant replyText, raw tokens)
      return {
        turnId: 'turn_0123456789abcdef0123456789abcdef',
        sessionId: validSessionId,
        spaceId: validSpaceId,
        status: 'completed',
        messageId: 'msg_0123456789abcdef0123456789abcdef',
        completedAt: new Date().toISOString(),
        replyText: 'Forbidden raw assistant response',
        extraMetadata: { foo: 'bar' },
      };
    });

    const result = await worker.runNow({ taskId: task.id, tenantId: 'user_test' });
    expect(result?.status).toBe('failed');
    expect(result?.error).toBe(TASK_PROTOCOL_ERROR_CODES.RESULT_INVALID);

    const persisted = await ops.tasks.getTask(task.id);
    expect(persisted?.status).toBe('failed');
    expect(persisted?.error).toBe(TASK_PROTOCOL_ERROR_CODES.RESULT_INVALID);
    expect(persisted?.result).toBeNull();
  });

  it('proves cancel-vs-complete CAS race: cancelled in-flight task cannot later complete', async () => {
    const ops = service.forTenant('user_test');
    const { task } = await ops.tasks.createTask({
      title: 'Race Cancel Task',
      payload: {
        type: 'agent_prompt',
        prompt: 'Run turn while cancellation happens',
        sessionId: validSessionId,
        sessionPolicy: 'existing_session',
      },
    });

    let completeResolve: () => void;
    const holdExecutionPromise = new Promise<void>((resolve) => {
      completeResolve = resolve;
    });

    const worker = createWorker(async () => {
      await holdExecutionPromise;
      return {
        status: 'completed',
        completedAt: new Date().toISOString(),
      };
    });

    // Start execution
    const runPromise = worker.runNow({ taskId: task.id, tenantId: 'user_test' });
    await new Promise((r) => setTimeout(r, 50));

    // Cancel task in DB while execution is in-flight
    const cancelled = await ops.tasks.cancelTask(task.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.error).toBe(TASK_PROTOCOL_ERROR_CODES.CANCELLED);

    // Let the worker dispatcher return its result
    completeResolve!();
    const execResult = await runPromise;

    // Worker must discover the task was cancelled via CAS and NOT overwrite DB with completed
    expect(execResult?.status).toBe('aborted');

    const dbTask = await ops.tasks.getTask(task.id);
    expect(dbTask?.status).toBe('cancelled');
    expect(dbTask?.result).toBeNull();
  });

  it('worker stop with abortInFlight leaves in-flight task recoverable in claimed state (no failed DB write)', async () => {
    const ops = service.forTenant('user_test');
    const { task } = await ops.tasks.createTask({
      title: 'Shutdown Recoverable Task',
      payload: {
        type: 'agent_prompt',
        prompt: 'Do not mark me failed during shutdown',
        sessionId: validSessionId,
        sessionPolicy: 'existing_session',
      },
    });

    let abortReceived = false;

    const worker = createWorker(async (ctx) => {
      ctx.signal.addEventListener('abort', () => {
        abortReceived = true;
      });
      // Hang until aborted
      await new Promise((r) => setTimeout(r, 1000));
      return {
        status: 'completed',
        completedAt: new Date().toISOString(),
      };
    });

    // Start execution
    const runPromise = worker.runNow({ taskId: task.id, tenantId: 'user_test' });
    await new Promise((r) => setTimeout(r, 50));

    // Stop worker with abortInFlight
    await worker.stop({ abortInFlight: true });
    const runResult = await runPromise;

    expect(abortReceived).toBe(true);
    expect(runResult?.status).toBe('aborted');

    // DB state must remain 'claimed' (not failed) with valid claimant, ready for lease recovery
    const dbTask = await ops.tasks.getTask(task.id);
    expect(dbTask?.status).toBe('claimed');
    expect(dbTask?.claimantId).toBe(worker.workerId);
  });

  it('heartbeat renewal prevents overlapping concurrent calls via recursive guard', async () => {
    const ops = service.forTenant('user_test');
    const { task } = await ops.tasks.createTask({
      title: 'Heartbeat Non-Overlap Task',
      leaseDurationMs: 1000,
      payload: {
        type: 'agent_prompt',
        prompt: 'Check heartbeat serialization',
        sessionId: validSessionId,
        sessionPolicy: 'existing_session',
      },
    });

    let concurrentRenewals = 0;
    let maxConcurrentRenewals = 0;

    const origRenew = ops.tasks.renewLease.bind(ops.tasks);
    ops.tasks.renewLease = async (taskId, input) => {
      concurrentRenewals++;
      maxConcurrentRenewals = Math.max(maxConcurrentRenewals, concurrentRenewals);
      // Simulate slight delay in renewal IO
      await new Promise((r) => setTimeout(r, 60));
      concurrentRenewals--;
      return origRenew(taskId, input);
    };

    const worker = createWorker(async () => {
      await new Promise((r) => setTimeout(r, 250));
      return {
        status: 'completed',
        completedAt: new Date().toISOString(),
      };
    }, { leaseDurationMs: 800, heartbeatIntervalMs: 50 });

    const result = await worker.runNow({ taskId: task.id, tenantId: 'user_test' });
    expect(result?.status).toBe('completed');
    // Non-overlapping guard ensures max concurrent renewal calls is at most 1
    expect(maxConcurrentRenewals).toBe(1);
  });

  it('settlement failure in failTask/completeTask is safely reported without masking errors', async () => {
    const ops = service.forTenant('user_test');
    const { task } = await ops.tasks.createTask({
      title: 'Settlement Error Task',
      payload: {
        type: 'agent_prompt',
        prompt: 'Trigger settlement error',
        sessionId: validSessionId,
        sessionPolicy: 'existing_session',
      },
    });

    const errorCaptured: any[] = [];
    // Inject repository that throws during completion settlement
    const rawRepo = storage.forTenant('user_test').tasks;
    vi.spyOn(rawRepo, 'complete').mockRejectedValue(
      new Error('Database disk I/O failure during settlement')
    );
    const brokenTasksService = new TaskOperationService({
      tasks: rawRepo,
    });

    const worker = new AgentPromptTaskWorker({
      workerId: 'worker_settle_test',
      tenantEnumerator: () => ['user_test'],
      getTenantOperations: () => ({
        tasks: brokenTasksService,
      }),
      dispatcher: async () => ({
        status: 'completed',
        completedAt: new Date().toISOString(),
      }),
      onError: (err, ctx) => {
        errorCaptured.push({ err, ctx });
      },
    });
    activeWorkers.push(worker);

    const result = await worker.runNow({ taskId: task.id, tenantId: 'user_test' });

    expect(result?.status).toBe('failed');
    expect(result?.error).toBe(TASK_PROTOCOL_ERROR_CODES.SETTLEMENT_FAILED);
    expect(errorCaptured.length).toBe(1);
    expect(errorCaptured[0].ctx.stage).toBe('settlement');
    expect(errorCaptured[0].err.message).toBe(TASK_PROTOCOL_ERROR_CODES.SETTLEMENT_FAILED);
  });
});
