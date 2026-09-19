import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
} from '../src/storage/migrations.js';
import {
  SqlitePlatformStorage,
  SqlitePlatformOperationsStorage,
} from '@enkeep/platform-storage-sqlite';
import { SqliteWebMessageStore } from '../src/storage/web-messages.js';
import {
  DeliveryRuntimeGateway,
  type DeliveryTurnExecutor,
  type DeliveryExecutionRequest,
} from '../src/runtime/delivery-gateway.js';
import {
  createAgentPromptDeliveryDispatcher,
  AgentPromptDeliveryDispatcher,
} from '../src/operations/agent-prompt-dispatcher.js';
import { PipelineTaskInputPreparerService } from '../src/tasks/pipeline-input-preparer.js';
import { PlatformOperationsService, type AgentPromptDispatchContext } from '@enkeep/platform-operations';
import { ValidationError, NotFoundError } from '@enkeep/platform-core';
import type { RuntimeTurnRequest } from '@enkeep/protocol';

describe('Trusted Runtime Timeout Forwarding E2E: Registry -> Dispatcher -> Gateway -> ExecutionRequest -> Adapter', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let operationsStorage: SqlitePlatformOperationsStorage;
  let operationsService: PlatformOperationsService;
  let messageStore: SqliteWebMessageStore;
  let deliveryGateway: DeliveryRuntimeGateway;
  let dispatcher: AgentPromptDeliveryDispatcher;
  let preparer: PipelineTaskInputPreparerService;

  const tenantAlice = 'usr_alice_timeout_e2e';
  const spaceId = 'spc_00000000000000000000000000000001';
  const sessionId = 'ses_00000000000000000000000000000001';
  const spaceFolder = 'space-timeout-e2e';
  const dshSessionId = 'ses_timeout_dsh_000000000001';

  const trustedTaskId = 'task_hpc_000000000000000000000abc';
  const ordinaryTaskId = 'task_hpc_000000000000000000000001';

  let capturedExecutionRequest: DeliveryExecutionRequest | null = null;
  let capturedAdapterTurnRequest: RuntimeTurnRequest | null = null;
  let cancelCalledForTurn: string | null = null;

  // Real production-like executor wrapping a mock runtime adapter/handle
  const mockAdapterHandle = {
    async sendTurn(request: RuntimeTurnRequest) {
      capturedAdapterTurnRequest = request;
      return {
        replyText: `Executed turn ${request.turnId}`,
        persisted: true,
        usage: { totalTokens: 10 },
      };
    },
  };

  const mockTurnExecutor: DeliveryTurnExecutor = {
    async execute(request: DeliveryExecutionRequest) {
      capturedExecutionRequest = request;
      // Mirror demo-runner/src/up/index.ts lines 928 & 993
      const res = await mockAdapterHandle.sendTurn({
        prompt: request.content,
        sessionId: request.dshSessionId,
        turnId: request.turnId,
        profileSnapshot: request.profile ?? null,
        workspaceFolder: request.workspaceFolder,
        attachments: request.attachments,
        modelSelection: request.modelSelection ?? null,
        timeoutMs: request.timeoutMs,
        mounts: request.mounts,
        extensionPlan: request.extensionPlan ?? null,
      });
      return {
        replyText: res.replyText,
        metadata: { persisted: true },
        usage: res.usage,
      };
    },
    async cancel(userId: string, turnId: string) {
      cancelCalledForTurn = turnId;
      return true;
    },
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    capturedExecutionRequest = null;
    capturedAdapterTurnRequest = null;
    cancelCalledForTurn = null;

    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    storage = new SqlitePlatformStorage(db);
    operationsStorage = new SqlitePlatformOperationsStorage(db, {
      quotaOptions: { unconfiguredPolicy: 'unlimited' },
    });
    operationsService = new PlatformOperationsService({
      storage: operationsStorage,
    });
    messageStore = new SqliteWebMessageStore(db);

    await storage.users.create({
      id: tenantAlice,
      username: 'alice_timeout',
      passwordHash: 'hash',
      role: 'admin',
      status: 'active',
    });

    await storage.forTenant(tenantAlice).spaces.create({
      id: spaceId,
      name: 'Timeout Space',
      folder: spaceFolder,
      executionMode: 'container',
    });

    await storage.forTenant(tenantAlice).sessionRoutes.create({
      id: sessionId,
      spaceId,
      channel: 'web',
      accountId: 'web-user',
      nativeContextId: sessionId,
      peerId: 'peer_timeout',
      dshSessionId,
      executionMode: 'container',
    });

    deliveryGateway = new DeliveryRuntimeGateway({
      storage,
      messageStore,
      database: db,
      executor: mockTurnExecutor,
      quotaMode: 'disabled',
      profileResolver: { resolve: async () => null },
    });

    dispatcher = createAgentPromptDeliveryDispatcher({
      gateway: deliveryGateway,
      storage,
      database: db,
      pollIntervalMs: 20,
    });

    preparer = new PipelineTaskInputPreparerService({
      database: db,
      readTenantMemory: () => '# Memory',
      fileService: {
        async execute(_userId: string, _spaceId: string, req: any) {
          if (req.op === 'read') throw new NotFoundError('Not found');
          return { op: req.op, path: req.path, type: 'file', size: 0, mtimeMs: 0, etag: '1' };
        },
      },
    });

    // Register trusted task in capability registry with 900s budget
    preparer.registerCapability(trustedTaskId, {
      capability: 'pipeline_observation',
      targetSpaceId: spaceId,
      maxWaitMs: 900_000,
    });
  });

  afterEach(async () => {
    await deliveryGateway.close();
    vi.useRealTimers();
  });

  // Test 1: Trusted 900 reaches actual adapter capture sendTurn (end-to-end)
  it('1. trusted 900s task carries maxWaitMs from registry through dispatcher and gateway to actual adapter sendTurn', async () => {
    const trustedTask = {
      id: trustedTaskId,
      userId: tenantAlice,
      title: 'Trusted 900s Pipeline Task',
      priority: 'high' as const,
      status: 'running' as const,
      payload: {
        type: 'agent_prompt' as const,
        prompt: 'Run trusted 900s observation',
        sessionId,
        sessionPolicy: 'existing_session' as const,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const prepResult = await preparer.prepare({
      task: trustedTask,
      payload: trustedTask.payload,
      tenantId: tenantAlice,
      runId: 'run_trusted_001',
      signal: new AbortController().signal,
    });

    expect(prepResult).toBeDefined();
    expect(prepResult?.executionBudget?.maxWaitMs).toBe(900_000);

    const dispatchContext: AgentPromptDispatchContext = {
      task: trustedTask,
      payload: trustedTask.payload,
      signal: new AbortController().signal,
      workerId: 'worker_trusted_1',
      tenantId: tenantAlice,
      executionBudget: prepResult?.executionBudget,
    };

    const dispatchPromise = dispatcher.dispatch(dispatchContext);
    await vi.advanceTimersByTimeAsync(100);
    const result = await dispatchPromise;

    expect(result.status).toBe('completed');
    // Verify DeliveryExecutionRequest carried 900_000
    expect(capturedExecutionRequest).not.toBeNull();
    expect(capturedExecutionRequest?.timeoutMs).toBe(900_000);
    // Verify actual runtime adapter handle.sendTurn received timeoutMs: 900_000
    expect(capturedAdapterTurnRequest).not.toBeNull();
    expect(capturedAdapterTurnRequest?.timeoutMs).toBe(900_000);
  });

  // Test 2: Ordinary task defaults to undefined -> host 300000ms default
  it('2. ordinary task without executionBudget leaves timeoutMs undefined, falling back to 300s default', async () => {
    const ordinaryTask = {
      id: ordinaryTaskId,
      userId: tenantAlice,
      title: 'Ordinary Task',
      priority: 'medium' as const,
      status: 'running' as const,
      payload: {
        type: 'agent_prompt' as const,
        prompt: 'Run ordinary task',
        sessionId,
        sessionPolicy: 'existing_session' as const,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const prepResult = await preparer.prepare({
      task: ordinaryTask,
      payload: ordinaryTask.payload,
      tenantId: tenantAlice,
      runId: 'run_ord_001',
      signal: new AbortController().signal,
    });

    expect(prepResult).toBeUndefined();

    const dispatchContext: AgentPromptDispatchContext = {
      task: ordinaryTask,
      payload: ordinaryTask.payload,
      signal: new AbortController().signal,
      workerId: 'worker_ord_1',
      tenantId: tenantAlice,
      // executionBudget undefined
    };

    const dispatchPromise = dispatcher.dispatch(dispatchContext);
    await vi.advanceTimersByTimeAsync(100);
    const result = await dispatchPromise;

    expect(result.status).toBe('completed');
    // DeliveryExecutionRequest timeoutMs defaults to ordinary 300s
    expect(capturedExecutionRequest).not.toBeNull();
    expect(capturedExecutionRequest?.timeoutMs ?? 300_000).toBe(300_000);
    // Adapter sendTurn receives 300s default
    expect(capturedAdapterTurnRequest).not.toBeNull();
    expect(capturedAdapterTurnRequest?.timeoutMs ?? 300_000).toBe(300_000);
  });

  // Test 3: Invalid registry budget (> 900_000) rejected pre-dispatch
  it('3. invalid registry/context budget > 900000 fails closed and rejects pre-dispatch without invoking executor', async () => {
    const invalidTask = {
      id: trustedTaskId,
      userId: tenantAlice,
      title: 'Over-budget Task',
      priority: 'high' as const,
      status: 'running' as const,
      payload: {
        type: 'agent_prompt' as const,
        prompt: 'Over budget prompt',
        sessionId,
        sessionPolicy: 'existing_session' as const,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const invalidContext: AgentPromptDispatchContext = {
      task: invalidTask,
      payload: invalidTask.payload,
      signal: new AbortController().signal,
      workerId: 'worker_inv_1',
      tenantId: tenantAlice,
      executionBudget: { maxWaitMs: 900_001 },
    };

    await expect(dispatcher.dispatch(invalidContext)).rejects.toThrow(
      /Execution budget maxWaitMs must be a finite integer between 1 and 900000/
    );

    // Executor was never reached
    expect(capturedExecutionRequest).toBeNull();
    expect(capturedAdapterTurnRequest).toBeNull();
  });

  // Test 4: Direct untrusted dispatch options injection rejection
  it('4. gateway rejects unrecognized or invalid dispatch options pre-ingestion', async () => {
    const envelope = {
      id: 'deliv_inject_test_0000000000000001',
      userId: tenantAlice,
      sessionId,
      content: 'Inbound message',
      timestamp: new Date().toISOString(),
    };

    // Unrecognized option key rejected
    await expect(
      deliveryGateway.dispatchInbound(envelope, { timeoutMs: 900_000, extraOption: true } as any)
    ).rejects.toThrow(/Unrecognized dispatch option/);

    // Non-integer timeoutMs rejected
    await expect(
      deliveryGateway.dispatchInbound(envelope, { timeoutMs: 500.5 } as any)
    ).rejects.toThrow(/Dispatch timeoutMs must be a finite integer between 1 and 900000/);

    // Negative timeoutMs rejected
    await expect(
      deliveryGateway.dispatchInbound(envelope, { timeoutMs: -100 })
    ).rejects.toThrow(/Dispatch timeoutMs must be a finite integer between 1 and 900000/);

    // > 900_000 rejected
    await expect(
      deliveryGateway.dispatchInbound(envelope, { timeoutMs: 1_000_000 })
    ).rejects.toThrow(/Dispatch timeoutMs must be a finite integer between 1 and 900000/);
  });

  // Test 5: Outer timeout / cancellation cleanly forwarded to executor.cancel
  it('5. task cancellation or outer timeout cleanly triggers executor.cancel', async () => {
    const abortCtrl = new AbortController();
    let hangingResolve: (() => void) | null = null;
    const hangingTask = {
      id: trustedTaskId,
      userId: tenantAlice,
      title: 'Hanging Task',
      priority: 'high' as const,
      status: 'running' as const,
      payload: {
        type: 'agent_prompt' as const,
        prompt: 'Long operation prompt',
        sessionId,
        sessionPolicy: 'existing_session' as const,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const dispatchContext: AgentPromptDispatchContext = {
      task: hangingTask,
      payload: hangingTask.payload,
      signal: abortCtrl.signal,
      workerId: 'worker_hang_1',
      tenantId: tenantAlice,
      executionBudget: { maxWaitMs: 900_000 },
    };

    // Replace executor with hanging executor that releases on cancel
    (deliveryGateway as any)['executor'] = {
      async execute(req: DeliveryExecutionRequest) {
        capturedExecutionRequest = req;
        await new Promise<void>((resolve) => {
          hangingResolve = resolve;
        });
        return { replyText: 'Cancelled turn', metadata: {}, usage: { totalTokens: 0 } };
      },
      async cancel(_userId: string, turnId: string) {
        cancelCalledForTurn = turnId;
        if (hangingResolve) hangingResolve();
        return true;
      },
    };

    let dispatchErr: Error | null = null;
    const dispatchPromise = dispatcher.dispatch(dispatchContext).catch((err) => {
      dispatchErr = err;
    });

    await vi.advanceTimersByTimeAsync(50);

    // Abort outer task
    abortCtrl.abort();
    await vi.advanceTimersByTimeAsync(50);
    await dispatchPromise;

    expect(dispatchErr).not.toBeNull();
    expect((dispatchErr as any)?.message).toMatch(/Task execution was aborted/);
    expect(cancelCalledForTurn).not.toBeNull();
  });
});
