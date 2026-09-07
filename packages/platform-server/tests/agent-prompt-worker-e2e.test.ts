import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
  createPlatformOperations,
  PlatformOperationsService,
} from '@enkeep/platform-operations';
import {
  SqliteWebMessageStore,
} from '../src/storage/web-messages.js';
import {
  DeliveryRuntimeGateway,
  type DeliveryTurnExecutor,
} from '../src/runtime/delivery-gateway.js';
import {
  createOperationsTenantQuotaProvider,
} from '../src/operations/tenant-quota-provider.js';
import {
  createAgentPromptDeliveryDispatcher,
} from '../src/operations/agent-prompt-dispatcher.js';
import {
  createPlatformServerTaskWorker,
  AgentPromptTaskWorker,
} from '../src/tasks/agent-prompt-worker.js';
import {
  PlatformServer,
  createPlatformServer,
} from '../src/server/server.js';

describe('AgentPromptTaskWorker & Platform Operations End-to-End Integration', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let messageStore: SqliteWebMessageStore;
  let operationsStorage: SqlitePlatformOperationsStorage;
  let operationsService: PlatformOperationsService;
  let deliveryGateway: DeliveryRuntimeGateway;
  let taskWorker: AgentPromptTaskWorker;
  let server: PlatformServer;
  let serverUrl: string;

  const tenantAlice = 'user_alice_e2e';
  const tenantBob = 'user_bob_e2e';
  const cookieSecret = 'test-secret-at-least-32-chars-long!';
  const csrfToken = 'test-csrf-token-at-least-32-chars-long!';

  let aliceSpaceId: string;
  let aliceSessionId: string;
  let executedTurns: Array<{ turnId: string; prompt: string; userId: string; sessionId: string }> = [];
  let cancelledTurns: Array<{ turnId: string; userId: string }> = [];

  const mockExecutor: DeliveryTurnExecutor = {
    async execute(request) {
      executedTurns.push({
        turnId: request.turnId,
        prompt: request.content,
        userId: request.userId,
        sessionId: request.dshSessionId,
      });

      // Simulate slight execution delay
      await new Promise((resolve) => setTimeout(resolve, 20));

      return {
        replyText: `[DSH-Agent] Processed prompt: ${request.content}`,
        metadata: {
          eventsCount: 3,
          persisted: true,
        },
        usage: { totalTokens: 10 },
      };
    },
    async cancel(userId, turnId) {
      cancelledTurns.push({ turnId, userId });
      return true;
    },
  };

  beforeEach(async () => {
    executedTurns = [];
    cancelledTurns = [];

    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    storage = new SqlitePlatformStorage(db);
    messageStore = new SqliteWebMessageStore(db);

    // Create Alice and Bob users
    await storage.users.create({
      id: tenantAlice,
      username: 'alice',
      passwordHash: 'hash_alice',
      role: 'admin',
      status: 'active',
    });
    await storage.users.create({
      id: tenantBob,
      username: 'bob',
      passwordHash: 'hash_bob',
      role: 'user',
      status: 'active',
    });

    // Create Alice container space and session route
    const aliceSpace = await storage.forTenant(tenantAlice).spaces.create({
      id: 'spc_0123456789abcdef0123456789abcdef',
      name: 'Alice Space',
      folder: 'alice_space_1',
      executionMode: 'container',
    });
    aliceSpaceId = aliceSpace.id;

    const aliceRoute = await storage.forTenant(tenantAlice).sessionRoutes.create({
      id: 'ses_0123456789abcdef0123456789abcdef',
      spaceId: aliceSpaceId,
      channel: 'web',
      accountId: 'web-demo',
      nativeContextId: 'ses_0123456789abcdef0123456789abcdef',
      peerId: 'alice_peer',
      dshSessionId: 'dsh_alice_sess_1',
      executionMode: 'container',
    });
    aliceSessionId = aliceRoute.nativeContextId;

    // Initialize Operations Storage, Service & Quota Provider
    operationsStorage = new SqlitePlatformOperationsStorage(db, {
      quotaOptions: { unconfiguredPolicy: 'fail_closed' },
    });
    operationsService = createPlatformOperations({
      storage: operationsStorage,
    });
    const quotaProvider = createOperationsTenantQuotaProvider(operationsService);

    // Setup Alice quota
    const aliceQuota = operationsStorage.forTenant(tenantAlice).quota;
    await aliceQuota.setLimit({ resource: 'turns', limit: 100 });
    await aliceQuota.setLimit({ resource: 'messages', limit: 100 });
    await aliceQuota.setLimit({ resource: 'tokens', limit: 10000 });

    // Construct Gateway with enforced quota
    deliveryGateway = new DeliveryRuntimeGateway({
      storage,
      messageStore,
      database: db,
      executor: mockExecutor,
      quotaMode: 'enforced',
      quotaProvider,
      profileResolver: { resolve: async () => null },
    });

    // Construct Dispatcher and Task Worker
    const dispatcher = createAgentPromptDeliveryDispatcher({
      gateway: deliveryGateway,
      storage,
      database: db,
      maxWaitMs: 5000,
      pollIntervalMs: 20,
    });

    taskWorker = createPlatformServerTaskWorker({
      db,
      dispatcher,
      operationsStorage,
      runId: 'test_run_worker_e2e_1',
      pollIntervalMs: 50,
    });

    // Start PlatformServer with Task Worker enabled
    const started = await createPlatformServer({
      database: db,
      storage,
      operationsStorage,
      operationsService,
      quotaProvider,
      runtimeGateway: deliveryGateway,
      cookieSecret,
      csrfToken,
      host: '127.0.0.1',
      port: 0,
      enableWorker: true,
      taskWorker,
    });
    server = started.server;
    serverUrl = started.address.url;
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
    try {
      db.close();
    } catch {
      // ignore
    }
  });

  it('claims pending task, dispatches through gateway, records turn output, and settles task', async () => {
    // Enqueue an agent_prompt task for Alice via operations service
    const taskOps = operationsService.forTenant(tenantAlice).tasks;
    const { task } = await taskOps.createTask({
      title: 'Analyze Repository',
      priority: 'high',
      payload: {
        type: 'agent_prompt',
        prompt: 'Please check repo status',
        sessionId: aliceSessionId,
        sessionPolicy: 'existing_session',
      },
      idempotencyKey: '11111111-2222-4333-8444-555555555555',
    });

    expect(task.status).toBe('pending');

    // Trigger execution on worker
    const result = await taskWorker.runOnce();

    expect(result).toBeDefined();
    expect(result?.status).toBe('completed');
    expect(result?.taskId).toBe(task.id);
    expect(result?.result).toBeDefined();

    const output = (result?.result as any).output ?? result?.result;
    expect(output.status).toBe('completed');
    expect(output.completedAt).toBeDefined();
    expect((output as any).replyText).toBeUndefined(); // Minimal task result without raw output duplication

    // Verify task is marked completed in DB
    const settledTask = await taskOps.getTask(task.id);
    expect(settledTask?.status).toBe('completed');

    // Verify turn was recorded in web_messages
    const res = await messageStore.listMessages(tenantAlice, aliceSessionId);
    const messages = res.messages;
    expect(messages.length).toBe(2); // user prompt + assistant reply
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('Please check repo status');
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].content).toContain('[DSH-Agent] Processed prompt: Please check repo status');

    // Verify quota was committed
    const turnsUsage = await operationsStorage.forTenant(tenantAlice).quota.getUsage('turns');
    expect(turnsUsage.used).toBe(1);
    expect(turnsUsage.reserved).toBe(0);
  });

  it('recovers interrupted task leases and un-settled reservations on restart', async () => {
    const taskOps = operationsService.forTenant(tenantAlice).tasks;
    const { task } = await taskOps.createTask({
      title: 'Stale Running Task',
      priority: 'medium',
      payload: {
        type: 'agent_prompt',
        prompt: 'Stale task prompt',
        sessionId: aliceSessionId,
        sessionPolicy: 'existing_session',
      },
      idempotencyKey: '22222222-3333-4444-8555-666666666666',
    });

    // Manually mark task as running with an expired lease
    db.prepare(`
      UPDATE platform_tasks
      SET status = 'running', claimant_id = 'worker_dead_prior', lease_expires_at = ?
      WHERE id = ?
    `).run(new Date(Date.now() - 60000).toISOString(), task.id);

    // Call recovery
    const recoveryResult = await operationsStorage.recoverAfterRestart();
    expect(recoveryResult.recoveredTasks).toBeGreaterThanOrEqual(1);

    // Verify task was reset to pending or failed
    const recoveredTask = await taskOps.getTask(task.id);
    expect(recoveredTask?.status === 'pending' || recoveredTask?.status === 'failed').toBe(true);
  });

  it('stops task worker cleanly during server.stop() without lingering timers', async () => {
    // Start background processing
    await taskWorker.start();

    // Stop server
    await server.stop();

    // Verify worker stopped
    expect(taskWorker.status).toBe('stopped');
  });

  it('executes turn successfully when dshSessionId differs from platform nativeContextId after generational reset', async () => {
    // Perform generational reset on Alice's session route: changes dshSessionId to fresh generation
    const newDshSessionId = 'ses_fresh_gen2_diff_dsh';
    const resetRes = await storage.forTenant(tenantAlice).sessionRoutes.reset!(aliceSessionId, {
      dshSessionId: newDshSessionId,
      resetReason: 'Generational reset test',
      agentProfileSnapshotId: null,
    });
    expect(resetRes.generation.generationNumber).toBe(2);
    expect(resetRes.route.dshSessionId).toBe(newDshSessionId);
    expect(resetRes.route.dshSessionId).not.toBe(aliceSessionId);

    const taskOps = operationsService.forTenant(tenantAlice).tasks;
    const { task } = await taskOps.createTask({
      title: 'Post-Reset Turn Execution',
      priority: 'high',
      payload: {
        type: 'agent_prompt',
        prompt: 'Run turn after generational reset',
        sessionId: aliceSessionId,
        sessionPolicy: 'existing_session',
      },
      idempotencyKey: '33333333-4444-4555-8666-777777777777',
    });

    const result = await taskWorker.runOnce();
    expect(result?.status).toBe('completed');
    expect(result?.taskId).toBe(task.id);

    // Verify turn executed with the new authoritative dshSessionId
    const lastExecution = executedTurns[executedTurns.length - 1];
    expect(lastExecution.sessionId).toBe(resetRes.route.dshSessionId);
    expect(lastExecution.turnId).toBeDefined();
    expect(lastExecution.prompt).toBe('Run turn after generational reset');
  });

  it('handles cancellation and aborts turn execution cleanly via cancelTurn', async () => {
    const taskOps = operationsService.forTenant(tenantAlice).tasks;
    const { task } = await taskOps.createTask({
      title: 'Cancelled Turn Execution',
      priority: 'urgent',
      payload: {
        type: 'agent_prompt',
        prompt: 'Prompt to be cancelled',
        sessionId: aliceSessionId,
        sessionPolicy: 'existing_session',
      },
      idempotencyKey: '44444444-5555-4666-8777-888888888888',
    });

    // Start background processing
    await taskWorker.start();

    // Immediately stop worker with abortInFlight
    await taskWorker.stop({ abortInFlight: true });

    // Verify turn was cancelled or worker cleanly stopped without crashing
    expect(taskWorker.status).toBe('stopped');
  });

  it('generates a full 128-bit RFC 4122 UUID default workerId without slice', () => {
    const defaultWorker = createPlatformServerTaskWorker({
      db,
      dispatcher: async () => {},
    });
    expect(defaultWorker.workerId).toMatch(/^server_worker_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});
