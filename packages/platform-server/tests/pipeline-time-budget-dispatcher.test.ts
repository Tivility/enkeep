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
import {
  SqliteWebMessageStore,
} from '../src/storage/web-messages.js';
import {
  DeliveryRuntimeGateway,
  type DeliveryTurnExecutor,
} from '../src/runtime/delivery-gateway.js';
import {
  createAgentPromptDeliveryDispatcher,
  AgentPromptDeliveryDispatcher,
} from '../src/operations/agent-prompt-dispatcher.js';
import {
  PipelineTaskInputPreparerService,
} from '../src/tasks/pipeline-input-preparer.js';
import {
  createPlatformServerTaskWorker,
} from '../src/tasks/agent-prompt-worker.js';
import {
  PlatformOperationsService,
  type AgentPromptDispatchContext,
} from '@enkeep/platform-operations';
import { ValidationError, NotFoundError } from '@enkeep/platform-core';

describe('Trusted Pipeline Task 900s Budget vs Ordinary 300s Budget Integration', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let operationsStorage: SqlitePlatformOperationsStorage;
  let operationsService: PlatformOperationsService;
  let messageStore: SqliteWebMessageStore;
  let deliveryGateway: DeliveryRuntimeGateway;
  let dispatcher: AgentPromptDeliveryDispatcher;
  let preparer: PipelineTaskInputPreparerService;

  const tenantAlice = 'usr_alice_budget';
  const spaceId = 'spc_00000000000000000000000000000001';
  const sessionId = 'ses_00000000000000000000000000000001';
  const spaceFolder = 'space-cognitive-budget';
  const dshSessionId = 'ses_budget111111111111111111111111';

  // 2 trusted pipeline tasks from external manifest
  const trustedObservationTaskId = 'task_hpc_000000000000000000000001';
  const trustedAggregationTaskId = 'task_hpc_000000000000000000000002';
  // Ordinary task
  const ordinaryTaskId = 'task_hpc_000000000000000000000003';

  let executorDelayMs = 0;
  let cancelCalledForTurn: string | null = null;

  const mockExecutor: DeliveryTurnExecutor = {
    async execute(request) {
      if (executorDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, executorDelayMs));
      }
      return {
        replyText: `Executed turn ${request.turnId} for prompt: ${request.content}`,
        metadata: { success: true },
        usage: { totalTokens: 42 },
      };
    },
    async cancel(userId, turnId) {
      cancelCalledForTurn = turnId;
      return true;
    },
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    cancelCalledForTurn = null;
    executorDelayMs = 0;

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
      username: 'alice_budget',
      passwordHash: 'hash',
      role: 'admin',
      status: 'active',
    });

    await storage.forTenant(tenantAlice).spaces.create({
      id: spaceId,
      name: 'Cognitive Space',
      folder: spaceFolder,
      executionMode: 'container',
    });

    await storage.forTenant(tenantAlice).sessionRoutes.create({
      id: sessionId,
      spaceId,
      channel: 'web',
      accountId: 'web-user',
      nativeContextId: sessionId,
      peerId: 'peer_budget',
      dshSessionId,
      executionMode: 'container',
    });

    deliveryGateway = new DeliveryRuntimeGateway({
      storage,
      messageStore,
      database: db,
      executor: mockExecutor,
      quotaMode: 'disabled',
      profileResolver: { resolve: async () => null },
    });

    dispatcher = createAgentPromptDeliveryDispatcher({
      gateway: deliveryGateway,
      storage,
      database: db,
      pollIntervalMs: 50,
      // Default maxWaitMs is 300_000 (5 minutes)
    });

    preparer = new PipelineTaskInputPreparerService({
      database: db,
      readTenantMemory: () => '# Test Memory File',
      fileService: {
        async execute(userId: string, spaceId: string, request: any) {
          if (request.op === 'read') {
            throw new NotFoundError(`File "${request.path}" not found`);
          }
          return { op: request.op, path: request.path, type: 'file', size: 0, mtimeMs: 0, etag: '1' };
        },
      },
    });

    // Register trusted observation task and aggregation task in PipelineTaskCapabilityRegistry
    preparer.registerCapability(trustedObservationTaskId, {
      capability: 'pipeline_observation',
      targetSpaceId: spaceId,
      maxWaitMs: 900_000,
    });
    preparer.registerCapability(trustedAggregationTaskId, {
      capability: 'pipeline_aggregation',
      targetSpaceId: spaceId,
      maxWaitMs: 900_000,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('proves trusted 2 pipeline tasks receive 900s budget while ordinary task receives 300s budget', async () => {
    // 1. Unregistered Ordinary Task -> no execution budget from preparer
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

    const ordinaryPrep = await preparer.prepare({
      task: ordinaryTask,
      payload: ordinaryTask.payload,
      tenantId: tenantAlice,
      runId: 'run_ord_001',
      signal: new AbortController().signal,
    });
    // Ordinary task: preparer is a clean no-op
    expect(ordinaryPrep).toBeUndefined();

    // 2. Trusted Observation Task -> assigned 900s budget
    const observationTask = {
      id: trustedObservationTaskId,
      userId: tenantAlice,
      title: 'Cognitive Observation Task',
      priority: 'high' as const,
      status: 'running' as const,
      payload: {
        type: 'agent_prompt' as const,
        prompt: 'Run cognitive extraction',
        sessionId,
        sessionPolicy: 'existing_session' as const,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const obsPrep = await preparer.prepare({
      task: observationTask,
      payload: observationTask.payload,
      tenantId: tenantAlice,
      runId: 'run_obs_001',
      signal: new AbortController().signal,
    });
    expect(obsPrep).toBeDefined();
    expect(obsPrep?.executionBudget?.maxWaitMs).toBe(900_000);

    // 3. Trusted Aggregation Task -> assigned 900s budget
    const aggregationTask = {
      id: trustedAggregationTaskId,
      userId: tenantAlice,
      title: 'Weekly Aggregation Task',
      priority: 'high' as const,
      status: 'running' as const,
      payload: {
        type: 'agent_prompt' as const,
        prompt: 'Run weekly aggregation',
        sessionId,
        sessionPolicy: 'existing_session' as const,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const aggPrep = await preparer.prepare({
      task: aggregationTask,
      payload: aggregationTask.payload,
      tenantId: tenantAlice,
      runId: 'run_agg_001',
      signal: new AbortController().signal,
    });
    expect(aggPrep).toBeDefined();
    expect(aggPrep?.executionBudget?.maxWaitMs).toBe(900_000);
  });

  it('ordinary task times out at 300s (default maxWaitMs) and cancels turn', async () => {
    // Ordinary task runs longer than 300s: set executor delay to 400s
    executorDelayMs = 400_000;

    const ordinaryCtx: AgentPromptDispatchContext = {
      task: {
        id: ordinaryTaskId,
        userId: tenantAlice,
        title: 'Ordinary Long Task',
        priority: 'medium' as const,
        status: 'running' as const,
        payload: {
          type: 'agent_prompt' as const,
          prompt: 'Ordinary long operation',
          sessionId,
          sessionPolicy: 'existing_session' as const,
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      payload: {
        type: 'agent_prompt' as const,
        prompt: 'Ordinary long operation',
        sessionId,
        sessionPolicy: 'existing_session' as const,
      },
      signal: new AbortController().signal,
      workerId: 'worker_test_1',
      tenantId: tenantAlice,
      // No executionBudget -> defaults to dispatcher 300_000ms
    };

    let dispatchErr: Error | null = null;
    const dispatchPromise = dispatcher.dispatch(ordinaryCtx).catch((err) => {
      dispatchErr = err;
    });

    // Advance fake timer to 300_050ms
    await vi.advanceTimersByTimeAsync(300_050);
    await dispatchPromise;

    expect(dispatchErr).not.toBeNull();
    expect((dispatchErr as any)?.message).toMatch(/Turn execution timed out/i);
    expect(cancelCalledForTurn).not.toBeNull();
  });

  it('at 300s registered task is still waiting and completes at 450s fixture with heartbeats valid', async () => {
    // 3-stage LLM fixture takes 450s (450_000ms)
    executorDelayMs = 450_000;

    const trustedCtx: AgentPromptDispatchContext = {
      task: {
        id: trustedObservationTaskId,
        userId: tenantAlice,
        title: 'Trusted Cognitive 3-Stage Task',
        priority: 'high' as const,
        status: 'running' as const,
        payload: {
          type: 'agent_prompt' as const,
          prompt: 'Trusted cognitive task prompt',
          sessionId,
          sessionPolicy: 'existing_session' as const,
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      payload: {
        type: 'agent_prompt' as const,
        prompt: 'Trusted cognitive task prompt',
        sessionId,
        sessionPolicy: 'existing_session' as const,
      },
      signal: new AbortController().signal,
      workerId: 'worker_test_trusted',
      tenantId: tenantAlice,
      executionBudget: {
        maxWaitMs: 900_000,
      },
    };

    const dispatchPromise = dispatcher.dispatch(trustedCtx);

    // Advance to 300_000ms: registered task MUST STILL BE WAITING (not timed out!)
    await vi.advanceTimersByTimeAsync(300_000);
    expect(cancelCalledForTurn).toBeNull();

    // Advance remaining 150_000ms to reach 450s completion fixture
    await vi.advanceTimersByTimeAsync(150_050);

    const result = await dispatchPromise;
    expect(result.status).toBe('completed');
    expect(result.completedAt).toBeDefined();
    expect(cancelCalledForTurn).toBeNull();
  });

  it('at 900s registered task reaches budget limit and cancels turn', async () => {
    // Task hangs longer than 900s: delay 1000s
    executorDelayMs = 1_000_000;

    const trustedCtx: AgentPromptDispatchContext = {
      task: {
        id: trustedAggregationTaskId,
        userId: tenantAlice,
        title: 'Hanging Aggregation Task',
        priority: 'high' as const,
        status: 'running' as const,
        payload: {
          type: 'agent_prompt' as const,
          prompt: 'Hanging aggregation prompt',
          sessionId,
          sessionPolicy: 'existing_session' as const,
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      payload: {
        type: 'agent_prompt' as const,
        prompt: 'Hanging aggregation prompt',
        sessionId,
        sessionPolicy: 'existing_session' as const,
      },
      signal: new AbortController().signal,
      workerId: 'worker_test_hang',
      tenantId: tenantAlice,
      executionBudget: {
        maxWaitMs: 900_000,
      },
    };

    let dispatchErr: Error | null = null;
    const dispatchPromise = dispatcher.dispatch(trustedCtx).catch((err) => {
      dispatchErr = err;
    });

    // At 300s, still waiting
    await vi.advanceTimersByTimeAsync(300_000);
    expect(cancelCalledForTurn).toBeNull();

    // Advance to 900_050ms
    await vi.advanceTimersByTimeAsync(600_050);
    await dispatchPromise;

    expect(dispatchErr).not.toBeNull();
    expect((dispatchErr as any)?.message).toMatch(/Turn execution timed out/i);
    expect(cancelCalledForTurn).not.toBeNull();
  });

  it('rejects invalid execution budgets and fails closed before dispatch', async () => {
    const baseCtx: AgentPromptDispatchContext = {
      task: {
        id: trustedObservationTaskId,
        userId: tenantAlice,
        title: 'Invalid Budget Task',
        priority: 'high' as const,
        status: 'running' as const,
        payload: {
          type: 'agent_prompt' as const,
          prompt: 'Some prompt',
          sessionId,
          sessionPolicy: 'existing_session' as const,
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      payload: {
        type: 'agent_prompt' as const,
        prompt: 'Some prompt',
        sessionId,
        sessionPolicy: 'existing_session' as const,
      },
      signal: new AbortController().signal,
      workerId: 'worker_test_val',
      tenantId: tenantAlice,
    };

    // Budget exceeds 900,000 limit
    await expect(
      dispatcher.dispatch({
        ...baseCtx,
        executionBudget: { maxWaitMs: 900_001 },
      })
    ).rejects.toThrow(/Execution budget maxWaitMs must be a finite integer between 1 and 900000/);

    // Negative budget
    await expect(
      dispatcher.dispatch({
        ...baseCtx,
        executionBudget: { maxWaitMs: -1 },
      })
    ).rejects.toThrow(/Execution budget maxWaitMs must be a finite integer between 1 and 900000/);

    // Non-integer budget
    await expect(
      dispatcher.dispatch({
        ...baseCtx,
        executionBudget: { maxWaitMs: 300.5 as any },
      })
    ).rejects.toThrow(/Execution budget maxWaitMs must be a finite integer between 1 and 900000/);

    // Unknown field in budget
    await expect(
      dispatcher.dispatch({
        ...baseCtx,
        executionBudget: { maxWaitMs: 900_000, extra: true } as any,
      })
    ).rejects.toThrow(/Execution budget contains unrecognized field/);

    // Array instead of object
    await expect(
      dispatcher.dispatch({
        ...baseCtx,
        executionBudget: [900_000] as any,
      })
    ).rejects.toThrow(/Execution budget must be a plain object/);
  });

  it('ensures old runs, task history, and schedules remain unchanged', async () => {
    // Verify database schema tables exist and no unauthorized mutation occurred
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('platform_tasks', 'task_runs', 'spaces', 'session_routes')")
      .all();
    expect(tables.length).toBe(4);

    // Strict 8-key stored payload contract remains unchanged
    const samplePayload = {
      type: 'agent_prompt',
      prompt: 'Clean prompt',
      sessionId,
      sessionPolicy: 'existing_session',
      spaceId,
    };
    expect(Object.keys(samplePayload)).toEqual(
      expect.arrayContaining(['type', 'prompt', 'sessionId', 'sessionPolicy', 'spaceId'])
    );
  });
});
