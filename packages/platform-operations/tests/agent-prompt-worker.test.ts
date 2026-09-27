import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
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
      defaultExecutionBudgetMs?: number;
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
      defaultExecutionBudgetMs: options?.defaultExecutionBudgetMs,
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

  it('a task with lark delivery → fake gateway sendProactiveMessage called once with the reply text; delivery failure does not fail the task', async () => {
    const ops = service.forTenant('user_test');

    // 1. Successful Lark proactive delivery
    const { task: task1 } = await ops.tasks.createTask({
      title: 'Lark Proactive Delivery Task',
      payload: {
        type: 'agent_prompt',
        prompt: 'Generate daily report',
        sessionId: validSessionId,
        sessionPolicy: 'existing_session',
        delivery: {
          channel: 'lark',
          accountId: 'acc_lark_123',
          nativeContextId: 'oc_chat_report_999',
        },
      },
    });

    const proactiveCalls: any[] = [];
    const fakeGateway = {
      sendProactiveMessage: vi.fn().mockImplementation(async (params: any) => {
        proactiveCalls.push(params);
        return { success: true, messageId: 'om_proactive_1' };
      }),
    };

    const fakeChannelRuntimeManager = {
      getActiveGateway: vi.fn().mockImplementation((userId: string, accountId: string) => {
        if (userId === 'user_test' && accountId === 'acc_lark_123') {
          return fakeGateway;
        }
        return undefined;
      }),
    };

    const worker1 = new AgentPromptTaskWorker({
      workerId: 'worker_lark_success',
      tenantEnumerator: () => ['user_test'],
      getTenantOperations: (tenantId) => service.forTenant(tenantId),
      dispatcher: async () => ({
        status: 'completed',
        completedAt: new Date().toISOString(),
        replyText: 'Daily report: All systems operational.',
      }),
      channelRuntimeManager: fakeChannelRuntimeManager,
    });
    activeWorkers.push(worker1);

    const result1 = await worker1.runNow({ taskId: task1.id, tenantId: 'user_test' });
    expect(result1?.status).toBe('completed');
    expect(fakeGateway.sendProactiveMessage).toHaveBeenCalledTimes(1);
    expect(proactiveCalls.length).toBe(1);
    expect(proactiveCalls[0].chatId).toBe('oc_chat_report_999');
    expect(proactiveCalls[0].text).toBe('Daily report: All systems operational.');
    expect(proactiveCalls[0].title).toBe('Lark Proactive Delivery Task');

    // 2. Delivery failure does not fail the task
    const { task: task2 } = await ops.tasks.createTask({
      title: 'Lark Delivery Failure Resilience Task',
      payload: {
        type: 'agent_prompt',
        prompt: 'Task with failing Lark gateway',
        sessionId: validSessionId,
        sessionPolicy: 'existing_session',
        delivery: {
          channel: 'lark',
          accountId: 'acc_lark_broken',
          nativeContextId: 'oc_chat_broken_888',
        },
      },
    });

    const brokenGateway = {
      sendProactiveMessage: vi.fn().mockRejectedValue(new Error('Network connection timeout to Lark API')),
    };

    const fakeBrokenCrm = {
      getActiveGateway: vi.fn().mockReturnValue(brokenGateway),
    };

    const worker2 = new AgentPromptTaskWorker({
      workerId: 'worker_lark_failure',
      tenantEnumerator: () => ['user_test'],
      getTenantOperations: (tenantId) => service.forTenant(tenantId),
      dispatcher: async () => ({
        status: 'completed',
        completedAt: new Date().toISOString(),
        replyText: 'Output for failing channel delivery',
      }),
      channelRuntimeManager: fakeBrokenCrm,
    });
    activeWorkers.push(worker2);

    const result2 = await worker2.runNow({ taskId: task2.id, tenantId: 'user_test' });
    expect(result2?.status).toBe('completed');
    expect(brokenGateway.sendProactiveMessage).toHaveBeenCalledTimes(1);

    const completedTask2 = await ops.tasks.getTask(task2.id);
    expect(completedTask2?.status).toBe('completed');
  });

  it('multi-subagent long agent task progressing within execution budget continuously renews lease and completes successfully without TASK_LEASE_EXPIRED', async () => {
    const ops = service.forTenant('user_test');
    const { task } = await ops.tasks.createTask({
      title: 'Multi-Subagent Pipeline Task',
      payload: {
        type: 'agent_prompt',
        prompt: 'Coordinate subagent 1 (cognitive), subagent 2 (knowledge), and subagent 3 (interaction)',
        sessionId: validSessionId,
        sessionPolicy: 'existing_session',
      },
    });

    let renewalCount = 0;
    const origRenew = ops.tasks.renewLease.bind(ops.tasks);
    ops.tasks.renewLease = async (taskId, input) => {
      renewalCount++;
      return origRenew(taskId, input);
    };

    // Task takes 400ms, while lease duration is only 150ms.
    // Without heartbeat renewal, lease would expire at 150ms and task would fail with TASK_LEASE_EXPIRED.
    const worker = createWorker(async (ctx) => {
      // Simulate multiple sequential/parallel subagent turn execution
      for (let i = 0; i < 4; i++) {
        if (ctx.signal.aborted) {
          throw new Error('Aborted');
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return {
        status: 'completed',
        completedAt: new Date().toISOString(),
      };
    }, {
      leaseDurationMs: 150,
      heartbeatIntervalMs: 40,
      defaultExecutionBudgetMs: 5000,
    });

    const result = await worker.runNow({ taskId: task.id, tenantId: 'user_test' });

    expect(result).not.toBeNull();
    expect(result?.status).toBe('completed');
    expect(result?.error).toBeUndefined();
    // Heartbeat must have renewed the lease multiple times while task was progressing
    expect(renewalCount).toBeGreaterThanOrEqual(3);

    const finished = await ops.tasks.getTask(task.id);
    expect(finished?.status).toBe('completed');
    expect(finished?.error).toBeNull();
  });

  it('task execution lease renewal is strictly bounded by execution budget (no immortal leases)', async () => {
    const ops = service.forTenant('user_test');
    const { task } = await ops.tasks.createTask({
      title: 'Runaway Task Exceeding Execution Budget',
      payload: {
        type: 'agent_prompt',
        prompt: 'Runaway agent task that hangs or runs forever',
        sessionId: validSessionId,
        sessionPolicy: 'existing_session',
      },
    });

    let renewalCount = 0;
    const origRenew = ops.tasks.renewLease.bind(ops.tasks);
    ops.tasks.renewLease = async (taskId, input) => {
      renewalCount++;
      return origRenew(taskId, input);
    };

    let signalAborted = false;
    const worker = createWorker(async (ctx) => {
      ctx.signal.addEventListener('abort', () => {
        signalAborted = true;
      });
      // Simulate hung / runaway task waiting 600ms
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 600);
        ctx.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve(undefined);
        });
      });
      return {
        status: 'completed',
        completedAt: new Date().toISOString(),
      };
    }, {
      leaseDurationMs: 500,
      heartbeatIntervalMs: 40,
      defaultExecutionBudgetMs: 200, // Budget is strictly 200ms
    });

    const result = await worker.runNow({ taskId: task.id, tenantId: 'user_test' });

    // Must be aborted / lease_lost due to budget exhaustion, NOT immortal
    expect(result?.status === 'lease_lost' || result?.status === 'aborted').toBe(true);
    expect(signalAborted).toBe(true);
    // Renewals should have stopped once the budget was reached
    expect(renewalCount).toBeLessThan(6);
  });

  it('dynamic execution budget from prepareTaskInput overrides default and strictly bounds lease renewal', async () => {
    const ops = service.forTenant('user_test');
    const { task } = await ops.tasks.createTask({
      title: 'Dynamic Budget Task',
      payload: {
        type: 'agent_prompt',
        prompt: 'Task with custom execution budget from prepareTaskInput',
        sessionId: validSessionId,
        sessionPolicy: 'existing_session',
      },
    });

    let signalAborted = false;
    const worker = new AgentPromptTaskWorker({
      workerId: 'worker_dyn_budget',
      tenantEnumerator: () => ['user_test'],
      getTenantOperations: (tenantId) => service.forTenant(tenantId),
      prepareTaskInput: async () => ({
        preparedPrompt: 'Prepared prompt with budget',
        executionBudget: { maxWaitMs: 180 }, // Dynamic budget of 180ms
      }),
      dispatcher: async (ctx) => {
        ctx.signal.addEventListener('abort', () => {
          signalAborted = true;
        });
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 600);
          ctx.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve(undefined);
          });
        });
        return {
          status: 'completed',
          completedAt: new Date().toISOString(),
        };
      },
      leaseDurationMs: 400,
      heartbeatIntervalMs: 40,
      defaultExecutionBudgetMs: 30_000, // Default is large, but overridden by prepareTaskInput
    });
    activeWorkers.push(worker);

    const result = await worker.runNow({ taskId: task.id, tenantId: 'user_test' });

    expect(result?.status === 'lease_lost' || result?.status === 'aborted').toBe(true);
    expect(signalAborted).toBe(true);
  });

  describe('Fallback proactive delivery resolution for agent_prompt tasks (origin session/space bindings)', () => {
    let testDb: DatabaseSync;
    let proactiveCalls: any[];
    let fakeGateway: any;
    let fakeChannelRuntimeManager: any;

    beforeEach(() => {
      proactiveCalls = [];
      fakeGateway = {
        sendProactiveMessage: vi.fn().mockImplementation(async (params: any) => {
          proactiveCalls.push(params);
          return { success: true, messageId: 'om_proactive_mock' };
        }),
      };

      fakeChannelRuntimeManager = {
        getActiveGateway: vi.fn().mockImplementation((userId: string, accountId: string) => {
          if (userId === 'user_test' && (accountId === 'acc_lark_1' || accountId === 'acc_lark_2')) {
            return fakeGateway;
          }
          return undefined;
        }),
      };

      testDb = new DatabaseSync(':memory:');
      testDb.exec(`
        CREATE TABLE channel_accounts (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          type TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active'
        );
        CREATE TABLE session_routes (
          id TEXT PRIMARY KEY,
          space_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          channel TEXT NOT NULL DEFAULT 'web',
          account_id TEXT,
          native_context_id TEXT
        );
        CREATE TABLE channel_bindings (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          account_id TEXT NOT NULL,
          space_id TEXT NOT NULL,
          native_context_id TEXT NOT NULL
        );
      `);

      testDb.prepare(`
        INSERT INTO channel_accounts (id, user_id, type, status)
        VALUES ('acc_lark_1', 'user_test', 'lark', 'active'),
               ('acc_lark_2', 'user_test', 'lark', 'active'),
               ('acc_lark_disabled', 'user_test', 'lark', 'disabled');
      `).run();
    });

    it('falls back to origin session channel binding when payload has no explicit delivery', async () => {
      const sessionId = 'ses_11111111111111111111111111111111';
      const spaceId = 'spc_11111111111111111111111111111111';

      testDb.prepare(`
        INSERT INTO session_routes (id, space_id, user_id, channel, account_id, native_context_id)
        VALUES (?, ?, 'user_test', 'lark', 'acc_lark_1', 'oc_origin_session_chat');
      `).run(sessionId, spaceId);

      testDb.prepare(`
        INSERT INTO channel_bindings (id, user_id, account_id, space_id, native_context_id)
        VALUES ('cb_1', 'user_test', 'acc_lark_1', ?, 'oc_origin_session_chat');
      `).run(spaceId);

      const ops = service.forTenant('user_test');
      const { task } = await ops.tasks.createTask({
        title: 'Daily Review Prompt',
        payload: {
          type: 'agent_prompt',
          prompt: 'Is there a scenario to review today?',
          sessionId,
          sessionPolicy: 'existing_session',
          spaceId,
          silent: false,
          // no explicit delivery
        },
      });

      const worker = new AgentPromptTaskWorker({
        workerId: 'worker_fallback_session',
        tenantEnumerator: () => ['user_test'],
        getTenantOperations: (tenantId) => service.forTenant(tenantId),
        dispatcher: async () => ({
          status: 'completed',
          completedAt: new Date().toISOString(),
          replyText: 'No scenario today. Keep moving forward.',
        }),
        channelRuntimeManager: fakeChannelRuntimeManager,
        db: testDb,
      });
      activeWorkers.push(worker);

      const result = await worker.runNow({ taskId: task.id, tenantId: 'user_test' });
      expect(result?.status).toBe('completed');
      expect(fakeGateway.sendProactiveMessage).toHaveBeenCalledTimes(1);
      expect(proactiveCalls.length).toBe(1);
      expect(proactiveCalls[0].chatId).toBe('oc_origin_session_chat');
      expect(proactiveCalls[0].accountId).toBe('acc_lark_1');
      expect(proactiveCalls[0].sessionId).toBe(sessionId);
      expect(proactiveCalls[0].text).toBe('No scenario today. Keep moving forward.');
    });

    it('falls back to origin space channel binding when origin session is web and space has unique binding', async () => {
      const sessionId = 'ses_22222222222222222222222222222222';
      const spaceId = 'spc_22222222222222222222222222222222';

      testDb.prepare(`
        INSERT INTO session_routes (id, space_id, user_id, channel, account_id, native_context_id)
        VALUES (?, ?, 'user_test', 'web', NULL, NULL);
      `).run(sessionId, spaceId);

      testDb.prepare(`
        INSERT INTO channel_bindings (id, user_id, account_id, space_id, native_context_id)
        VALUES ('cb_space_1', 'user_test', 'acc_lark_1', ?, 'oc_space_chat_1');
      `).run(spaceId);

      const ops = service.forTenant('user_test');
      const { task } = await ops.tasks.createTask({
        title: 'Space-Bound Task',
        payload: {
          type: 'agent_prompt',
          prompt: 'Execute space prompt',
          sessionId,
          sessionPolicy: 'existing_session',
          spaceId,
          silent: false,
        },
      });

      const worker = new AgentPromptTaskWorker({
        workerId: 'worker_fallback_space',
        tenantEnumerator: () => ['user_test'],
        getTenantOperations: (tenantId) => service.forTenant(tenantId),
        dispatcher: async () => ({
          status: 'completed',
          completedAt: new Date().toISOString(),
          replyText: 'Space task executed.',
        }),
        channelRuntimeManager: fakeChannelRuntimeManager,
        db: testDb,
      });
      activeWorkers.push(worker);

      const result = await worker.runNow({ taskId: task.id, tenantId: 'user_test' });
      expect(result?.status).toBe('completed');
      expect(fakeGateway.sendProactiveMessage).toHaveBeenCalledTimes(1);
      expect(proactiveCalls.length).toBe(1);
      expect(proactiveCalls[0].chatId).toBe('oc_space_chat_1');
      expect(proactiveCalls[0].accountId).toBe('acc_lark_1');
    });

    it('falls back to web only when origin space has no channel bindings', async () => {
      const sessionId = 'ses_33333333333333333333333333333333';
      const spaceId = 'spc_33333333333333333333333333333333';

      testDb.prepare(`
        INSERT INTO session_routes (id, space_id, user_id, channel, account_id, native_context_id)
        VALUES (?, ?, 'user_test', 'web', NULL, NULL);
      `).run(sessionId, spaceId);

      const ops = service.forTenant('user_test');
      const { task } = await ops.tasks.createTask({
        title: 'Pure Web Task',
        payload: {
          type: 'agent_prompt',
          prompt: 'Pure web task execution',
          sessionId,
          sessionPolicy: 'existing_session',
          spaceId,
          silent: false,
        },
      });

      const worker = new AgentPromptTaskWorker({
        workerId: 'worker_web_only',
        tenantEnumerator: () => ['user_test'],
        getTenantOperations: (tenantId) => service.forTenant(tenantId),
        dispatcher: async () => ({
          status: 'completed',
          completedAt: new Date().toISOString(),
          replyText: 'Pure web output.',
        }),
        channelRuntimeManager: fakeChannelRuntimeManager,
        db: testDb,
      });
      activeWorkers.push(worker);

      const result = await worker.runNow({ taskId: task.id, tenantId: 'user_test' });
      expect(result?.status).toBe('completed');
      expect(fakeGateway.sendProactiveMessage).not.toHaveBeenCalled();
      expect(proactiveCalls.length).toBe(0);
    });

    it('falls back to web only and never guesses when origin space has multiple conflicting chat bindings', async () => {
      const sessionId = 'ses_44444444444444444444444444444444';
      const spaceId = 'spc_44444444444444444444444444444444';

      testDb.prepare(`
        INSERT INTO session_routes (id, space_id, user_id, channel, account_id, native_context_id)
        VALUES (?, ?, 'user_test', 'web', NULL, NULL);
      `).run(sessionId, spaceId);

      testDb.prepare(`
        INSERT INTO channel_bindings (id, user_id, account_id, space_id, native_context_id)
        VALUES ('cb_amb_1', 'user_test', 'acc_lark_1', ?, 'oc_chat_alpha'),
               ('cb_amb_2', 'user_test', 'acc_lark_2', ?, 'oc_chat_beta');
      `).run(spaceId, spaceId);

      const ops = service.forTenant('user_test');
      const { task } = await ops.tasks.createTask({
        title: 'Ambiguous Space Task',
        payload: {
          type: 'agent_prompt',
          prompt: 'Prompt in space with multiple chats',
          sessionId,
          sessionPolicy: 'existing_session',
          spaceId,
          silent: false,
        },
      });

      const worker = new AgentPromptTaskWorker({
        workerId: 'worker_ambiguous_no_guess',
        tenantEnumerator: () => ['user_test'],
        getTenantOperations: (tenantId) => service.forTenant(tenantId),
        dispatcher: async () => ({
          status: 'completed',
          completedAt: new Date().toISOString(),
          replyText: 'Ambiguous output.',
        }),
        channelRuntimeManager: fakeChannelRuntimeManager,
        db: testDb,
      });
      activeWorkers.push(worker);

      const result = await worker.runNow({ taskId: task.id, tenantId: 'user_test' });
      expect(result?.status).toBe('completed');
      // Must NOT guess between oc_chat_alpha and oc_chat_beta: falls back to web only!
      expect(fakeGateway.sendProactiveMessage).not.toHaveBeenCalled();
      expect(proactiveCalls.length).toBe(0);
    });

    it('silent: true suppresses fallback proactive delivery even when channel binding exists', async () => {
      const sessionId = 'ses_55555555555555555555555555555555';
      const spaceId = 'spc_55555555555555555555555555555555';

      testDb.prepare(`
        INSERT INTO session_routes (id, space_id, user_id, channel, account_id, native_context_id)
        VALUES (?, ?, 'user_test', 'lark', 'acc_lark_1', 'oc_silent_chat');
      `).run(sessionId, spaceId);

      testDb.prepare(`
        INSERT INTO channel_bindings (id, user_id, account_id, space_id, native_context_id)
        VALUES ('cb_silent_1', 'user_test', 'acc_lark_1', ?, 'oc_silent_chat');
      `).run(spaceId);

      const ops = service.forTenant('user_test');
      const { task } = await ops.tasks.createTask({
        title: 'Silent Task',
        payload: {
          type: 'agent_prompt',
          prompt: 'Silent execution',
          sessionId,
          sessionPolicy: 'existing_session',
          spaceId,
          silent: true,
        },
      });

      const worker = new AgentPromptTaskWorker({
        workerId: 'worker_silent',
        tenantEnumerator: () => ['user_test'],
        getTenantOperations: (tenantId) => service.forTenant(tenantId),
        dispatcher: async () => ({
          status: 'completed',
          completedAt: new Date().toISOString(),
          replyText: 'Silent output.',
        }),
        channelRuntimeManager: fakeChannelRuntimeManager,
        db: testDb,
      });
      activeWorkers.push(worker);

      const result = await worker.runNow({ taskId: task.id, tenantId: 'user_test' });
      expect(result?.status).toBe('completed');
      expect(fakeGateway.sendProactiveMessage).not.toHaveBeenCalled();
      expect(proactiveCalls.length).toBe(0);
    });

    it('fails closed (web only) when payload.spaceId mismatches session_routes.space_id', async () => {
      const sessionId = 'ses_66666666666666666666666666666666';
      const sessionSpaceId = 'spc_6666666666666666666666666666666a';
      const payloadSpaceId = 'spc_6666666666666666666666666666666b';

      testDb.prepare(`
        INSERT INTO session_routes (id, space_id, user_id, channel, account_id, native_context_id)
        VALUES (?, ?, 'user_test', 'lark', 'acc_lark_1', 'oc_mismatch_chat');
      `).run(sessionId, sessionSpaceId);

      testDb.prepare(`
        INSERT INTO channel_bindings (id, user_id, account_id, space_id, native_context_id)
        VALUES ('cb_mismatch_1', 'user_test', 'acc_lark_1', ?, 'oc_mismatch_chat');
      `).run(sessionSpaceId);

      const ops = service.forTenant('user_test');
      const { task } = await ops.tasks.createTask({
        title: 'Mismatched Space Task',
        payload: {
          type: 'agent_prompt',
          prompt: 'Prompt with mismatched spaceId',
          sessionId,
          sessionPolicy: 'existing_session',
          spaceId: payloadSpaceId, // Differs from session_routes!
          silent: false,
        },
      });

      const worker = new AgentPromptTaskWorker({
        workerId: 'worker_mismatch',
        tenantEnumerator: () => ['user_test'],
        getTenantOperations: (tenantId) => service.forTenant(tenantId),
        dispatcher: async () => ({
          status: 'completed',
          completedAt: new Date().toISOString(),
          replyText: 'Mismatched space output.',
        }),
        channelRuntimeManager: fakeChannelRuntimeManager,
        db: testDb,
      });
      activeWorkers.push(worker);

      const result = await worker.runNow({ taskId: task.id, tenantId: 'user_test' });
      expect(result?.status).toBe('completed');
      expect(fakeGateway.sendProactiveMessage).not.toHaveBeenCalled();
    });

    it('fails closed (web only) when channel account is inactive/disabled', async () => {
      const sessionId = 'ses_77777777777777777777777777777777';
      const spaceId = 'spc_77777777777777777777777777777777';

      testDb.prepare(`
        INSERT INTO session_routes (id, space_id, user_id, channel, account_id, native_context_id)
        VALUES (?, ?, 'user_test', 'lark', 'acc_lark_disabled', 'oc_disabled_chat');
      `).run(sessionId, spaceId);

      testDb.prepare(`
        INSERT INTO channel_bindings (id, user_id, account_id, space_id, native_context_id)
        VALUES ('cb_dis_1', 'user_test', 'acc_lark_disabled', ?, 'oc_disabled_chat');
      `).run(spaceId);

      const ops = service.forTenant('user_test');
      const { task } = await ops.tasks.createTask({
        title: 'Disabled Account Task',
        payload: {
          type: 'agent_prompt',
          prompt: 'Task with disabled account',
          sessionId,
          sessionPolicy: 'existing_session',
          spaceId,
          silent: false,
        },
      });

      const worker = new AgentPromptTaskWorker({
        workerId: 'worker_disabled_acc',
        tenantEnumerator: () => ['user_test'],
        getTenantOperations: (tenantId) => service.forTenant(tenantId),
        dispatcher: async () => ({
          status: 'completed',
          completedAt: new Date().toISOString(),
          replyText: 'Disabled output.',
        }),
        channelRuntimeManager: fakeChannelRuntimeManager,
        db: testDb,
      });
      activeWorkers.push(worker);

      const result = await worker.runNow({ taskId: task.id, tenantId: 'user_test' });
      expect(result?.status).toBe('completed');
      expect(fakeGateway.sendProactiveMessage).not.toHaveBeenCalled();
    });

    it('preserves explicit delivery target without invoking fallback resolution', async () => {
      const sessionId = 'ses_88888888888888888888888888888888';
      const spaceId = 'spc_88888888888888888888888888888888';

      // Seed session_routes pointing to oc_session_chat
      testDb.prepare(`
        INSERT INTO session_routes (id, space_id, user_id, channel, account_id, native_context_id)
        VALUES (?, ?, 'user_test', 'lark', 'acc_lark_1', 'oc_session_chat');
      `).run(sessionId, spaceId);

      // Seed channel_bindings for BOTH oc_session_chat and oc_explicit_target
      testDb.prepare(`
        INSERT INTO channel_bindings (id, user_id, account_id, space_id, native_context_id)
        VALUES ('cb_exp_1', 'user_test', 'acc_lark_1', ?, 'oc_session_chat'),
               ('cb_exp_2', 'user_test', 'acc_lark_1', ?, 'oc_explicit_target');
      `).run(spaceId, spaceId);

      const ops = service.forTenant('user_test');
      const { task } = await ops.tasks.createTask({
        title: 'Explicit Delivery Task',
        payload: {
          type: 'agent_prompt',
          prompt: 'Task with explicit delivery target',
          sessionId,
          sessionPolicy: 'existing_session',
          spaceId,
          silent: false,
          delivery: {
            channel: 'lark',
            accountId: 'acc_lark_1',
            nativeContextId: 'oc_explicit_target',
          },
        },
      });

      const worker = new AgentPromptTaskWorker({
        workerId: 'worker_explicit',
        tenantEnumerator: () => ['user_test'],
        getTenantOperations: (tenantId) => service.forTenant(tenantId),
        dispatcher: async () => ({
          status: 'completed',
          completedAt: new Date().toISOString(),
          replyText: 'Explicit target output.',
        }),
        channelRuntimeManager: fakeChannelRuntimeManager,
        db: testDb,
      });
      activeWorkers.push(worker);

      const result = await worker.runNow({ taskId: task.id, tenantId: 'user_test' });
      expect(result?.status).toBe('completed');
      expect(fakeGateway.sendProactiveMessage).toHaveBeenCalledTimes(1);
      expect(proactiveCalls[0].chatId).toBe('oc_explicit_target'); // Explicit target respected!
    });
  });
});
