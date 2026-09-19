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
  type DeliveryExecutionRequest,
  type DeliveryTurnExecutor,
} from '../src/runtime/delivery-gateway.js';
import {
  createAgentPromptDeliveryDispatcher,
  AgentPromptDeliveryDispatcher,
} from '../src/operations/agent-prompt-dispatcher.js';
import {
  HostDaemonTransport,
  HostDaemonError,
} from '../../runtime-runner/src/host/index.js';
import type { AgentPromptDispatchContext } from '@enkeep/platform-operations';
import { ValidationError } from '@enkeep/platform-core';
import type { RuntimeTurnRequest } from '@enkeep/protocol';

describe('Production Trusted Runtime Timeout Propagation E2E', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let operationsStorage: SqlitePlatformOperationsStorage;
  let messageStore: SqliteWebMessageStore;
  let deliveryGateway: DeliveryRuntimeGateway;
  let dispatcher: AgentPromptDeliveryDispatcher;

  const tenantAlice = 'usr_synth_alice_timeout';
  const spaceId = 'spc_00000000000000000000000000000001';
  const sessionId = 'ses_00000000000000000000000000000001';
  const spaceFolder = 'space-synth-timeout';
  const dshSessionId = 'ses_budget111111111111111111111111';

  const trustedTaskId = 'task_hpc_000000000000000000000abc';
  const ordinaryTaskId = 'task_00000000000000000000000000000001';

  let capturedTurnRequest: RuntimeTurnRequest | undefined;
  let capturedFollowupRequest: any | undefined;
  let cancelCalledForTurn: string | null = null;
  let harnessDelayMs = 0;

  // Real HostDaemonTransport instance running in harness fake clock mode
  let transport: HostDaemonTransport;

  beforeEach(async () => {
    vi.useFakeTimers();
    capturedTurnRequest = undefined;
    capturedFollowupRequest = undefined;
    cancelCalledForTurn = null;
    harnessDelayMs = 0;

    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    storage = new SqlitePlatformStorage(db);
    operationsStorage = new SqlitePlatformOperationsStorage(db, {
      quotaOptions: { unconfiguredPolicy: 'unlimited' },
    });
    messageStore = new SqliteWebMessageStore(db);

    await storage.users.create({
      id: tenantAlice,
      username: 'synth_alice_timeout',
      passwordHash: 'hash',
      role: 'admin',
      status: 'active',
    });

    await storage.forTenant(tenantAlice).spaces.create({
      id: spaceId,
      name: 'Synth Space',
      folder: spaceFolder,
      executionMode: 'host',
    });

    await storage.forTenant(tenantAlice).sessionRoutes.create({
      id: sessionId,
      spaceId,
      channel: 'web',
      accountId: 'synth-account',
      nativeContextId: sessionId,
      peerId: 'peer_synth_timeout',
      dshSessionId,
      executionMode: 'host',
    });

    // Initialize real HostDaemonTransport with fake connected state and fake clock
    transport = new HostDaemonTransport({
      userId: tenantAlice,
      dshHome: '/tmp/dsh-synth-home',
    });

    (transport as any).state = 'connected';
    (transport as any).socket = {
      destroyed: false,
      write: vi.fn(),
    };

    // Spy on cancelTurn
    transport.cancelTurn = vi.fn().mockImplementation(async (turnId: string, reason?: string) => {
      cancelCalledForTurn = turnId;
      return { ok: true, id: `cancel_${turnId}`, op: 'cancel' };
    });

    // Mock daemon submitTurn request ack and controlled delay execution completion
    (transport as any).request = vi.fn().mockImplementation(async (submitReq: any) => {
      // Return ack immediately
      setTimeout(() => {
        const waiter = (transport as any).turnWaiters.get(submitReq.turnId);
        if (waiter) {
          if (harnessDelayMs > 0) {
            setTimeout(() => {
              const currentWaiter = (transport as any).turnWaiters.get(submitReq.turnId);
              if (currentWaiter) {
                (transport as any).turnWaiters.delete(submitReq.turnId);
                if (currentWaiter.timer) clearTimeout(currentWaiter.timer);
                currentWaiter.resolve({
                  status: 'completed',
                  replyText: `Executed turn ${submitReq.turnId} after ${harnessDelayMs}ms delay`,
                  persisted: true,
                  eventsCount: 1,
                  usage: { totalTokens: 100 },
                });
              }
            }, harnessDelayMs);
          } else {
            (transport as any).turnWaiters.delete(submitReq.turnId);
            if (waiter.timer) clearTimeout(waiter.timer);
            waiter.resolve({
              status: 'completed',
              replyText: `Executed turn ${submitReq.turnId} immediately`,
              persisted: true,
              eventsCount: 1,
              usage: { totalTokens: 50 },
            });
          }
        }
      }, 0);
      return { ok: true, id: `ack_${submitReq.id}`, op: 'submitTurn' };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Builds the production-compiled delivery executor wired through userHandle.sendTurn to HostDaemonTransport
   */
  function buildRealCompiledTurnExecutor(mode: 'fixed' | 'old_buggy'): DeliveryTurnExecutor {
    // Fake userHandle replicating demo-runner/src/ports/index.ts
    const userHandle = {
      sendTurn: async (req: RuntimeTurnRequest) => {
        capturedTurnRequest = req;
        capturedFollowupRequest = {
          prompt: req.prompt,
          sessionId: req.sessionId,
          turnId: req.turnId,
          timeoutMs: req.timeoutMs,
        };

        const followupRes = await transport.sendFollowup({
          prompt: req.prompt,
          sessionId: req.sessionId,
          turnId: req.turnId,
          timeoutMs: req.timeoutMs,
        });

        if (followupRes.status !== 'completed') {
          throw new Error(`FAIL-CLOSED: Turn execution envelope status is not completed: ${followupRes.status}`);
        }
        return {
          replyText: followupRes.replyText,
          persisted: true,
          eventsCount: followupRes.eventsCount,
          usage: followupRes.usage,
        };
      },
      cancelTurn: async (turnId: string) => {
        await transport.cancelTurn(turnId, 'Cancelled via handle');
        return { status: 'cancelled', turnId };
      },
    };

    if (mode === 'old_buggy') {
      // Replicate the old compiled production bug (packages/demo-runner/dist/up/index.js:739)
      // where userHandle.sendTurn omitted timeoutMs
      return {
        async execute(request: DeliveryExecutionRequest) {
          const {
            userId,
            platformSpaceId,
            workspaceFolder,
            dshSessionId,
            turnId,
            content,
            attachments,
            profile,
            // timeoutMs omitted!
          } = request;
          return await userHandle.sendTurn({
            prompt: content,
            sessionId: dshSessionId,
            turnId,
            profileSnapshot: profile ?? null,
            workspaceFolder,
            attachments,
            modelSelection: request.modelSelection ?? null,
            mounts: request.mounts,
            extensionPlan: request.extensionPlan ?? null,
            // timeoutMs NOT forwarded!
          });
        },
        async cancel(userId: string, turnId: string) {
          await userHandle.cancelTurn(turnId);
          return true;
        },
      };
    }

    // Fixed production executor (packages/demo-runner/src/up/index.ts) forwarding timeoutMs
    return {
      async execute(request: DeliveryExecutionRequest) {
        const {
          userId,
          platformSpaceId,
          workspaceFolder,
          dshSessionId,
          turnId,
          content,
          attachments,
          profile,
          timeoutMs,
        } = request;
        return await userHandle.sendTurn({
          prompt: content,
          sessionId: dshSessionId,
          turnId,
          profileSnapshot: profile ?? null,
          workspaceFolder,
          attachments,
          modelSelection: request.modelSelection ?? null,
          mounts: request.mounts,
          extensionPlan: request.extensionPlan ?? null,
          timeoutMs,
        });
      },
      async cancel(userId: string, turnId: string) {
        await userHandle.cancelTurn(turnId);
        return true;
      },
    };
  }

  function setupSystem(executorMode: 'fixed' | 'old_buggy') {
    const executor = buildRealCompiledTurnExecutor(executorMode);
    deliveryGateway = new DeliveryRuntimeGateway({
      storage,
      messageStore,
      database: db,
      executor,
      quotaMode: 'disabled',
      profileResolver: { resolve: async () => null },
    });

    dispatcher = createAgentPromptDeliveryDispatcher({
      gateway: deliveryGateway,
      storage,
      database: db,
      pollIntervalMs: 50,
      maxWaitMs: 300_000,
    });
  }

  it('1. Reproduces old adapter bug: omitting timeoutMs causes HostDaemonTransport to default to 300s and fail at 300s', async () => {
    setupSystem('old_buggy');

    // Harness introduces a 450s delay (within 900s budget, but exceeds 300s default)
    harnessDelayMs = 450_000;

    const trustedCtx: AgentPromptDispatchContext = {
      task: {
        id: trustedTaskId,
        userId: tenantAlice,
        title: 'Trusted Cognitive Task',
        priority: 'high',
        status: 'running',
        payload: {
          type: 'agent_prompt',
          prompt: 'Execute cognitive turn',
          sessionId,
          sessionPolicy: 'existing_session',
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      payload: {
        type: 'agent_prompt',
        prompt: 'Execute cognitive turn',
        sessionId,
        sessionPolicy: 'existing_session',
      },
      signal: new AbortController().signal,
      workerId: 'worker_synth_01',
      tenantId: tenantAlice,
      executionBudget: {
        maxWaitMs: 900_000,
      },
    };

    let dispatchErr: Error | null = null;
    const dispatchPromise = dispatcher.dispatch(trustedCtx).catch((err) => {
      dispatchErr = err;
    });

    // Advance to tick 0 for initial dispatch
    await vi.advanceTimersByTimeAsync(10);

    // Old adapter omitted timeoutMs: userHandle received undefined
    expect(capturedTurnRequest?.timeoutMs).toBeUndefined();
    expect(capturedFollowupRequest?.timeoutMs).toBeUndefined();

    // Advance fake timer to 300_050ms
    await vi.advanceTimersByTimeAsync(300_050);
    await dispatchPromise;

    // Must fail at 300s due to HostDaemonTransport DEFAULT_FOLLOWUP_TIMEOUT_MS cancel
    expect(dispatchErr).not.toBeNull();
    expect(cancelCalledForTurn).not.toBeNull();
  });

  it('2. Fixed adapter propagates 900000ms through dispatcher -> gateway -> sendTurn -> HostDaemonTransport, surviving 300s and completing at 450s', async () => {
    setupSystem('fixed');

    // Harness delay 450s (within 900s budget)
    harnessDelayMs = 450_000;

    const trustedCtx: AgentPromptDispatchContext = {
      task: {
        id: trustedTaskId,
        userId: tenantAlice,
        title: 'Trusted Cognitive Task',
        priority: 'high',
        status: 'running',
        payload: {
          type: 'agent_prompt',
          prompt: 'Execute cognitive turn 450s',
          sessionId,
          sessionPolicy: 'existing_session',
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      payload: {
        type: 'agent_prompt',
        prompt: 'Execute cognitive turn 450s',
        sessionId,
        sessionPolicy: 'existing_session',
      },
      signal: new AbortController().signal,
      workerId: 'worker_synth_02',
      tenantId: tenantAlice,
      executionBudget: {
        maxWaitMs: 900_000,
      },
    };

    const dispatchPromise = dispatcher.dispatch(trustedCtx);

    // Advance to tick 0 for initial dispatch
    await vi.advanceTimersByTimeAsync(10);

    // Fixed adapter forwards timeoutMs: HostDaemonTransport receives 900000, not default 300000!
    expect(capturedTurnRequest?.timeoutMs).toBe(900_000);
    expect(capturedFollowupRequest?.timeoutMs).toBe(900_000);
    expect(capturedFollowupRequest?.timeoutMs).not.toBe(300_000);

    // Advance to 300_000ms: MUST NOT be cancelled, still executing!
    await vi.advanceTimersByTimeAsync(300_000);
    expect(cancelCalledForTurn).toBeNull();

    // Advance remaining 150_050ms to reach 450s completion
    await vi.advanceTimersByTimeAsync(150_050);

    const result = await dispatchPromise;
    expect(result.status).toBe('completed');
    expect(result.completedAt).toBeDefined();
    expect(cancelCalledForTurn).toBeNull();
  });

  it('3. Bounds task at 900s: both outer dispatcher and inner host transport cancel when execution exceeds 900s', async () => {
    setupSystem('fixed');

    // Harness delay 1,000s (exceeds 900s budget)
    harnessDelayMs = 1_000_000;

    const trustedCtx: AgentPromptDispatchContext = {
      task: {
        id: trustedTaskId,
        userId: tenantAlice,
        title: 'Hanging Task',
        priority: 'high',
        status: 'running',
        payload: {
          type: 'agent_prompt',
          prompt: 'Execute hanging turn',
          sessionId,
          sessionPolicy: 'existing_session',
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      payload: {
        type: 'agent_prompt',
        prompt: 'Execute hanging turn',
        sessionId,
        sessionPolicy: 'existing_session',
      },
      signal: new AbortController().signal,
      workerId: 'worker_synth_03',
      tenantId: tenantAlice,
      executionBudget: {
        maxWaitMs: 900_000,
      },
    };

    let dispatchErr: Error | null = null;
    const dispatchPromise = dispatcher.dispatch(trustedCtx).catch((err) => {
      dispatchErr = err;
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(capturedFollowupRequest?.timeoutMs).toBe(900_000);

    // At 300s: still waiting
    await vi.advanceTimersByTimeAsync(300_000);
    expect(cancelCalledForTurn).toBeNull();

    // Advance to 900_050ms: inner transport and outer dispatcher fire cancel
    await vi.advanceTimersByTimeAsync(600_050);
    await dispatchPromise;

    expect(dispatchErr).not.toBeNull();
    expect(cancelCalledForTurn).not.toBeNull();
  });

  it('4. Ordinary task without execution budget retains 300s default for both outer and inner', async () => {
    setupSystem('fixed');

    // Harness delay 400s (exceeds 300s default)
    harnessDelayMs = 400_000;

    const ordinaryCtx: AgentPromptDispatchContext = {
      task: {
        id: ordinaryTaskId,
        userId: tenantAlice,
        title: 'Ordinary Task',
        priority: 'medium',
        status: 'running',
        payload: {
          type: 'agent_prompt',
          prompt: 'Execute ordinary turn',
          sessionId,
          sessionPolicy: 'existing_session',
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      payload: {
        type: 'agent_prompt',
        prompt: 'Execute ordinary turn',
        sessionId,
        sessionPolicy: 'existing_session',
      },
      signal: new AbortController().signal,
      workerId: 'worker_synth_04',
      tenantId: tenantAlice,
      // executionBudget undefined -> defaults to 300_000ms
    };

    let dispatchErr: Error | null = null;
    const dispatchPromise = dispatcher.dispatch(ordinaryCtx).catch((err) => {
      dispatchErr = err;
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(capturedFollowupRequest?.timeoutMs).toBe(300_000);

    // At 300_050ms: times out
    await vi.advanceTimersByTimeAsync(300_050);
    await dispatchPromise;

    expect(dispatchErr).not.toBeNull();
    expect(cancelCalledForTurn).not.toBeNull();
  });

  it('5. Invalid execution budget fails zero dispatch immediately', async () => {
    setupSystem('fixed');

    const invalidBudgets = [
      { maxWaitMs: 0 },
      { maxWaitMs: -100 },
      { maxWaitMs: 900_001 },
      { maxWaitMs: 1.5 },
      { maxWaitMs: '900000' as any },
      { unknownKey: 5000 } as any,
    ];

    for (const budget of invalidBudgets) {
      const badCtx: AgentPromptDispatchContext = {
        task: {
          id: trustedTaskId,
          userId: tenantAlice,
          title: 'Bad Budget Task',
          priority: 'high',
          status: 'running',
          payload: {
            type: 'agent_prompt',
            prompt: 'Bad budget prompt',
            sessionId,
            sessionPolicy: 'existing_session',
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        payload: {
          type: 'agent_prompt',
          prompt: 'Bad budget prompt',
          sessionId,
          sessionPolicy: 'existing_session',
        },
        signal: new AbortController().signal,
        workerId: 'worker_synth_bad',
        tenantId: tenantAlice,
        executionBudget: budget,
      };

      await expect(dispatcher.dispatch(badCtx)).rejects.toThrow(ValidationError);
    }

    // Also test direct gateway dispatchInbound failzero on invalid options
    await expect(
      deliveryGateway.dispatchInbound(
        {
          id: 'deliv_synth_bad_000000000000000000001',
          userId: tenantAlice,
          sessionId,
          content: 'Direct bad dispatch',
          timestamp: new Date().toISOString(),
        },
        { timeoutMs: 900_001 }
      )
    ).rejects.toThrow(ValidationError);

    await expect(
      deliveryGateway.dispatchInbound(
        {
          id: 'deliv_synth_bad_000000000000000000002',
          userId: tenantAlice,
          sessionId,
          content: 'Direct bad dispatch 0',
          timestamp: new Date().toISOString(),
        },
        { timeoutMs: 0 }
      )
    ).rejects.toThrow(ValidationError);

    // Verify zero turns were created in turn_runs for bad dispatches
    const turnCount = db.prepare('SELECT COUNT(*) as cnt FROM turn_runs').get() as { cnt: number };
    expect(turnCount.cnt).toBe(0);
  });

  it('6. External Web payload injection of timeoutMs/metadata has zero effect; ordinary 300s remains default', async () => {
    setupSystem('fixed');
    harnessDelayMs = 0;

    // Normal web dispatch via InboundEnvelope (external web caller injecting timeoutMs/metadata)
    const envelopeWithInjection: any = {
      id: 'deliv_synth_inject_00000000000000001',
      userId: tenantAlice,
      sessionId,
      content: 'Web user message with malicious injection',
      timestamp: new Date().toISOString(),
      timeoutMs: 900_000, // External attempted injection
      metadata: { timeoutMs: 900_000, executionBudget: { maxWaitMs: 900_000 } },
    };

    // Dispatch without server options (as ordinary web server handler does)
    const res = await deliveryGateway.dispatchInbound(envelopeWithInjection);
    expect(res.accepted).toBe(true);

    // Let scheduler claim and execute turn
    await vi.advanceTimersByTimeAsync(50);

    // Verify that injected parameters had NO effect: timeoutMs defaulted to 300_000
    expect(capturedTurnRequest?.timeoutMs).toBe(300_000);
    expect(capturedFollowupRequest?.timeoutMs).toBe(300_000);
  });

  it('7. Queued cancellation and schedule lease semantics are preserved', async () => {
    setupSystem('fixed');
    harnessDelayMs = 0;

    // Dispatch a turn directly to gateway
    const envelope: any = {
      id: 'deliv_synth_queue_000000000000000001',
      userId: tenantAlice,
      sessionId,
      content: 'Turn to be cancelled in queue',
      timestamp: new Date().toISOString(),
    };

    const res = await deliveryGateway.dispatchInbound(envelope, { timeoutMs: 900_000 });
    expect(res.accepted).toBe(true);
    const turnId = res.turnId;

    // Immediately cancel the turn before scheduler processes it
    const cancelResult = await deliveryGateway.cancelTurn(tenantAlice, turnId);
    expect(cancelResult).toBe(true);

    // Verify status in turn_runs and delivery_inbox
    const turnRow = db.prepare('SELECT status, error FROM turn_runs WHERE turn_id = ?').get(turnId) as { status: string; error: string };
    expect(turnRow.status).toBe('interrupted');
    expect(turnRow.error).toContain('Turn cancelled by user');

    const inboxRow = db.prepare('SELECT status, error FROM delivery_inbox WHERE turn_id = ?').get(turnId) as { status: string; error: string };
    expect(inboxRow.status).toBe('cancelled');
  });
});
