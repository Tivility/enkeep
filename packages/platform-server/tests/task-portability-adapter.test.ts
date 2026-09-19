import { describe, it, expect, beforeEach } from 'vitest';
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
  LarkChannelGateway,
} from '@enkeep/channel-lark';
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
  createPlatformServerTaskWorker,
  AgentPromptTaskWorker,
} from '../src/tasks/agent-prompt-worker.js';
import {
  PlatformOperationsService,
} from '@enkeep/platform-operations';
import {
  ValidationError,
  NotFoundError,
} from '@enkeep/platform-core';

describe('Scheduled Task Portability Adapter & Canonical Routing', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let operationsStorage: SqlitePlatformOperationsStorage;
  let operationsService: PlatformOperationsService;
  let deliveryGateway: DeliveryRuntimeGateway;
  let dispatcher: AgentPromptDeliveryDispatcher;

  const tenantAlice = 'usr_alice_synth';
  const tenantBob = 'usr_bob_synth';

  const hostSpaceId = 'spc_11111111111111111111111111111111';
  const containerSpaceId = 'spc_22222222222222222222222222222222';
  const importedTaskId = 'task_hpc_123456789012345678901234';

  const hostSessionId = 'ses_11111111111111111111111111111111';
  const containerSessionId = 'ses_22222222222222222222222222222222';
  const larkSessionId = 'ses_33333333333333333333333333333333';

  const deliveredProactiveMessages: any[] = [];
  const executedTurns: any[] = [];

  const mockExecutor: DeliveryTurnExecutor = {
    async execute(request) {
      executedTurns.push({
        turnId: request.turnId,
        content: request.content,
        userId: request.userId,
        sessionId: request.dshSessionId,
      });

      if (request.content.includes('SIMULATE_FAILURE')) {
        throw new Error('Simulated executor failure during task run');
      }

      return {
        replyText: `Executed turn for prompt: ${request.content}`,
        metadata: { success: true },
        usage: { totalTokens: 15 },
      };
    },
    async cancel() {
      return true;
    },
  };

  const fakeLarkGateway = {
    sendProactiveMessage: async (params: any) => {
      deliveredProactiveMessages.push(params);
      return { success: true, messageId: 'om_synth_reply_001' };
    },
  };

  const fakeChannelRuntimeManager = {
    getActiveGateway: (userId: string, accountId: string) => {
      if (userId === tenantAlice && accountId === 'acc_synth_lark_1') {
        return fakeLarkGateway;
      }
      return undefined;
    },
  };

  beforeEach(async () => {
    deliveredProactiveMessages.length = 0;
    executedTurns.length = 0;

    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    storage = new SqlitePlatformStorage(db);
    const messageStore = new SqliteWebMessageStore(db);
    operationsStorage = new SqlitePlatformOperationsStorage(db);
    operationsService = new PlatformOperationsService({
      storage: operationsStorage,
    });

    // Create users
    await storage.users.create({
      id: tenantAlice,
      username: 'alice_synth',
      passwordHash: 'hash_synth',
      role: 'admin',
      status: 'active',
    });
    await storage.users.create({
      id: tenantBob,
      username: 'bob_synth',
      passwordHash: 'hash_synth',
      role: 'user',
      status: 'active',
    });

    // Create Host Space
    await storage.forTenant(tenantAlice).spaces.create({
      id: hostSpaceId,
      name: 'Host Space',
      folder: 'space-host-folder',
      executionMode: 'host',
    });

    // Create Container Space
    await storage.forTenant(tenantAlice).spaces.create({
      id: containerSpaceId,
      name: 'Container Space',
      folder: 'space-container-folder',
      executionMode: 'container',
    });

    // Create channel account and binding for Alice
    db.prepare(`
      INSERT INTO channel_accounts (id, user_id, type, status, created_at, updated_at)
      VALUES ('acc_synth_lark_1', ?, 'lark', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(tenantAlice);

    db.prepare(`
      INSERT INTO channel_bindings (id, user_id, account_id, space_id, native_context_id, activation_mode, created_at, updated_at)
      VALUES ('cb_synth_1', ?, 'acc_synth_lark_1', ?, 'oc_synth_chat_1', 'always', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(tenantAlice, hostSpaceId);

    // Create Host Route
    await storage.forTenant(tenantAlice).sessionRoutes.create({
      id: hostSessionId,
      spaceId: hostSpaceId,
      channel: 'web',
      accountId: 'web-user',
      nativeContextId: hostSessionId,
      peerId: 'alice_peer',
      dshSessionId: 'ses_1234567890abcdef1234567890abcdef',
      executionMode: 'host',
    });

    // Create Container Route
    await storage.forTenant(tenantAlice).sessionRoutes.create({
      id: containerSessionId,
      spaceId: containerSpaceId,
      channel: 'web',
      accountId: 'web-user',
      nativeContextId: containerSessionId,
      peerId: 'alice_peer',
      dshSessionId: 'ses_234567890abcdef1234567890abcdef1',
      executionMode: 'container',
    });

    // Create Lark-origin Route in Host Space (channel: 'lark', accountId: 'acc_synth_lark_1')
    await storage.forTenant(tenantAlice).sessionRoutes.create({
      id: larkSessionId,
      spaceId: hostSpaceId,
      channel: 'lark',
      accountId: 'acc_synth_lark_1',
      nativeContextId: 'oc_synth_chat_1',
      peerId: 'oc_synth_chat_1',
      dshSessionId: 'ses_34567890abcdef1234567890abcdef12',
      executionMode: 'host',
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
      pollIntervalMs: 20,
    });
  });

  describe('1. Host Canonical Space & Execution Mode Derivation', () => {
    it('accepts host canonical space and correctly derives host executionMode', async () => {
      const task = {
        id: 'task_00000000000000000000000000000001',
        userId: tenantAlice,
        title: 'Host Task',
        priority: 'high' as const,
        status: 'running' as const,
        payload: {
          type: 'agent_prompt' as const,
          prompt: 'Execute in host mode',
          sessionId: hostSessionId,
          sessionPolicy: 'existing_session' as const,
          spaceId: hostSpaceId,
          spaceFolder: 'space-host-folder',
          silent: true,
        },
        leaseDurationMs: 30000,
        claimCount: 1,
        maxRetries: 3,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const result = await dispatcher.dispatch({
        task,
        payload: task.payload,
        signal: new AbortController().signal,
        workerId: 'worker_1',
        tenantId: tenantAlice,
      });

      expect(result.status).toBe('completed');
      expect(executedTurns.length).toBe(1);

      // Verify route executionMode synced to host
      const routeRow = db.prepare('SELECT execution_mode FROM session_routes WHERE id = ?').get(hostSessionId) as any;
      expect(routeRow.execution_mode).toBe('host');

      // Verify space canonical_session_id is bound
      const spaceRow = db.prepare('SELECT canonical_session_id FROM spaces WHERE id = ?').get(hostSpaceId) as any;
      expect(spaceRow.canonical_session_id).toBe(hostSessionId);
    });

    it('accepts container canonical space and preserves container executionMode', async () => {
      const task = {
        id: 'task_00000000000000000000000000000002',
        userId: tenantAlice,
        title: 'Container Task',
        priority: 'high' as const,
        status: 'running' as const,
        payload: {
          type: 'agent_prompt' as const,
          prompt: 'Execute in container mode',
          sessionId: containerSessionId,
          sessionPolicy: 'existing_session' as const,
          spaceId: containerSpaceId,
          spaceFolder: 'space-container-folder',
        },
        leaseDurationMs: 30000,
        claimCount: 1,
        maxRetries: 3,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const result = await dispatcher.dispatch({
        task,
        payload: task.payload,
        signal: new AbortController().signal,
        workerId: 'worker_1',
        tenantId: tenantAlice,
      });

      expect(result.status).toBe('completed');
      const routeRow = db.prepare('SELECT execution_mode FROM session_routes WHERE id = ?').get(containerSessionId) as any;
      expect(routeRow.execution_mode).toBe('container');
    });
  });

  describe('2. Canonical Lark-Origin Route Without Web/Web-Demo Constraints', () => {
    it('accepts canonical Lark-origin route without web-demo or container force', async () => {
      // Set larkSessionId as canonical on host space
      db.prepare('UPDATE spaces SET canonical_session_id = ? WHERE id = ?').run(larkSessionId, hostSpaceId);

      const task = {
        id: 'task_00000000000000000000000000000003',
        userId: tenantAlice,
        title: 'Lark Route Task',
        priority: 'high' as const,
        status: 'running' as const,
        payload: {
          type: 'agent_prompt' as const,
          prompt: 'Execute with Lark route',
          sessionId: larkSessionId,
          sessionPolicy: 'existing_session' as const,
          delivery: {
            channel: 'lark' as const,
            accountId: 'acc_synth_lark_1',
            nativeContextId: 'oc_synth_chat_1',
          },
        },
        leaseDurationMs: 30000,
        claimCount: 1,
        maxRetries: 3,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const result = await dispatcher.dispatch({
        task,
        payload: task.payload,
        signal: new AbortController().signal,
        workerId: 'worker_1',
        tenantId: tenantAlice,
      });

      expect(result.status).toBe('completed');
      expect(executedTurns[executedTurns.length - 1].content).toBe('Execute with Lark route');
    });
  });

  describe('3. Tenant / Space / Canonical Security Rejection', () => {
    it('rejects cross-tenant session access', async () => {
      // Create Bob space and session
      const bobSpaceId = 'spc_44444444444444444444444444444444';
      await storage.forTenant(tenantBob).spaces.create({
        id: bobSpaceId,
        name: 'Bob Space',
        folder: 'bob-folder',
        executionMode: 'host',
      });
      const bobRoute = await storage.forTenant(tenantBob).sessionRoutes.create({
        id: 'ses_44444444444444444444444444444444',
        spaceId: bobSpaceId,
        channel: 'web',
        accountId: 'web-user',
        nativeContextId: 'ses_44444444444444444444444444444444',
        peerId: 'bob_peer',
        dshSessionId: 'ses_55555555555555555555555555555555',
        executionMode: 'host',
      });

      const task = {
        id: 'task_00000000000000000000000000000004',
        userId: tenantAlice,
        title: 'Cross Tenant Task',
        priority: 'high' as const,
        status: 'running' as const,
        payload: {
          type: 'agent_prompt' as const,
          prompt: 'Steal Bob session',
          sessionId: bobRoute.id,
          sessionPolicy: 'existing_session' as const,
        },
        leaseDurationMs: 30000,
        claimCount: 1,
        maxRetries: 3,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await expect(
        dispatcher.dispatch({
          task,
          payload: task.payload,
          signal: new AbortController().signal,
          workerId: 'worker_1',
          tenantId: tenantAlice,
        })
      ).rejects.toThrow(NotFoundError);
    });

    it('rejects archived session route', async () => {
      await storage.forTenant(tenantAlice).sessionRoutes.update(hostSessionId, { status: 'archived' });

      const task = {
        id: 'task_00000000000000000000000000000005',
        userId: tenantAlice,
        title: 'Archived Route Task',
        priority: 'high' as const,
        status: 'running' as const,
        payload: {
          type: 'agent_prompt' as const,
          prompt: 'Hello',
          sessionId: hostSessionId,
          sessionPolicy: 'existing_session' as const,
        },
        leaseDurationMs: 30000,
        claimCount: 1,
        maxRetries: 3,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await expect(
        dispatcher.dispatch({
          task,
          payload: task.payload,
          signal: new AbortController().signal,
          workerId: 'worker_1',
          tenantId: tenantAlice,
        })
      ).rejects.toThrow(/\[INVALID_SESSION_ROUTE\]/i);
    });

    it('rejects non-canonical session when an active canonical session exists for space', async () => {
      // Set hostSessionId as canonical
      db.prepare('UPDATE spaces SET canonical_session_id = ? WHERE id = ?').run(hostSessionId, hostSpaceId);

      // Attempt to dispatch with larkSessionId (which is in the same space but not canonical)
      const task = {
        id: 'task_00000000000000000000000000000006',
        userId: tenantAlice,
        title: 'Non-Canonical Task',
        priority: 'high' as const,
        status: 'running' as const,
        payload: {
          type: 'agent_prompt' as const,
          prompt: 'Hello non-canonical',
          sessionId: larkSessionId,
          sessionPolicy: 'existing_session' as const,
        },
        leaseDurationMs: 30000,
        claimCount: 1,
        maxRetries: 3,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await expect(
        dispatcher.dispatch({
          task,
          payload: task.payload,
          signal: new AbortController().signal,
          workerId: 'worker_1',
          tenantId: tenantAlice,
        })
      ).rejects.toThrow(/\[NON_CANONICAL_SESSION\]/i);
    });

    it('rejects payload spaceFolder mismatch against authoritative space.folder', async () => {
      const task = {
        id: 'task_00000000000000000000000000000007',
        userId: tenantAlice,
        title: 'Mismatched Folder Task',
        priority: 'high' as const,
        status: 'running' as const,
        payload: {
          type: 'agent_prompt' as const,
          prompt: 'Folder mismatch',
          sessionId: hostSessionId,
          sessionPolicy: 'existing_session' as const,
          spaceFolder: 'wrong-folder-name',
        },
        leaseDurationMs: 30000,
        claimCount: 1,
        maxRetries: 3,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await expect(
        dispatcher.dispatch({
          task,
          payload: task.payload,
          signal: new AbortController().signal,
          workerId: 'worker_1',
          tenantId: tenantAlice,
        })
      ).rejects.toThrow(/\[SPACE_FOLDER_MISMATCH\]/i);
    });
  });

  describe('4. Worker Proactive Lark Notification, Tenant Account Binding & Failure Deduplication', () => {
    it('proactively sends Lark notification on success with tenant account and binding validated', async () => {
      // Bind hostSessionId as canonical
      db.prepare('UPDATE spaces SET canonical_session_id = ? WHERE id = ?').run(hostSessionId, hostSpaceId);

      const ops = operationsService.forTenant(tenantAlice);
      const { task } = await ops.tasks.createTask({
        title: 'Successful Lark Notification Task',
        payload: {
          type: 'agent_prompt',
          prompt: 'Compute weekly report',
          sessionId: hostSessionId,
          sessionPolicy: 'existing_session',
          spaceId: hostSpaceId,
          delivery: {
            channel: 'lark',
            accountId: 'acc_synth_lark_1',
            nativeContextId: 'oc_synth_chat_1',
          },
        },
      });

      const worker = createPlatformServerTaskWorker({
        db,
        dispatcher,
        channelRuntimeManager: fakeChannelRuntimeManager,
        pollIntervalMs: 50,
      });

      const tickResult = await worker.tick();
      expect(tickResult.processed).toBe(true);
      expect(tickResult.status).toBe('completed');

      // Verify fakeLarkGateway.sendProactiveMessage was called exactly once
      expect(deliveredProactiveMessages.length).toBe(1);
      expect(deliveredProactiveMessages[0].chatId).toBe('oc_synth_chat_1');
      expect(deliveredProactiveMessages[0].sessionId).toBe(hostSessionId);
      expect(deliveredProactiveMessages[0].outboxId).toMatch(/^out_task_run_[0-9a-f]{32}$/);
    });

    it('does NOT send Lark notification on task failure (zero duplicate notifications on failure)', async () => {
      db.prepare('UPDATE spaces SET canonical_session_id = ? WHERE id = ?').run(hostSessionId, hostSpaceId);

      const ops = operationsService.forTenant(tenantAlice);
      const { task } = await ops.tasks.createTask({
        title: 'Failing Task',
        payload: {
          type: 'agent_prompt',
          prompt: 'SIMULATE_FAILURE should crash executor',
          sessionId: hostSessionId,
          sessionPolicy: 'existing_session',
          delivery: {
            channel: 'lark',
            accountId: 'acc_synth_lark_1',
            nativeContextId: 'oc_synth_chat_1',
          },
        },
      });

      const worker = createPlatformServerTaskWorker({
        db,
        dispatcher,
        channelRuntimeManager: fakeChannelRuntimeManager,
        pollIntervalMs: 50,
      });

      const tickResult = await worker.tick();
      expect(tickResult.processed).toBe(true);
      expect(tickResult.status).toBe('failed');

      // CRITICAL INVARIANT: Zero notification dispatched on task failure!
      expect(deliveredProactiveMessages.length).toBe(0);
    });

    it('rejects arbitrary / unbound Lark account target for tenant', async () => {
      db.prepare('UPDATE spaces SET canonical_session_id = ? WHERE id = ?').run(hostSessionId, hostSpaceId);

      const ops = operationsService.forTenant(tenantAlice);
      const { task } = await ops.tasks.createTask({
        title: 'Unbound Account Task',
        payload: {
          type: 'agent_prompt',
          prompt: 'Send to invalid account',
          sessionId: hostSessionId,
          sessionPolicy: 'existing_session',
          delivery: {
            channel: 'lark',
            accountId: 'acc_arbitrary_unbound',
            nativeContextId: 'oc_synth_chat_1',
          },
        },
      });

      const worker = createPlatformServerTaskWorker({
        db,
        dispatcher,
        channelRuntimeManager: fakeChannelRuntimeManager,
        pollIntervalMs: 50,
      });

      const tickResult = await worker.tick();
      expect(tickResult.processed).toBe(true);
      expect(tickResult.status).toBe('completed');

      // Unbound account refused delivery -> zero messages sent
      expect(deliveredProactiveMessages.length).toBe(0);
    });

    it('mismatched space existing binding 0 sends (fails closed without schedule mutation)', async () => {
      // Re-point channel_binding to containerSpaceId, while task executes in hostSpaceId
      db.prepare('UPDATE channel_bindings SET space_id = ? WHERE id = ?').run(containerSpaceId, 'cb_synth_1');
      db.prepare('UPDATE spaces SET canonical_session_id = ? WHERE id = ?').run(hostSessionId, hostSpaceId);

      const ops = operationsService.forTenant(tenantAlice);
      const { task } = await ops.tasks.createTask({
        title: 'Mismatched Space Task',
        payload: {
          type: 'agent_prompt',
          prompt: 'Execute with mismatched space binding',
          sessionId: hostSessionId,
          sessionPolicy: 'existing_session',
          spaceId: hostSpaceId,
          delivery: {
            channel: 'lark',
            accountId: 'acc_synth_lark_1',
            nativeContextId: 'oc_synth_chat_1',
          },
        },
      });

      const worker = createPlatformServerTaskWorker({
        db,
        dispatcher,
        channelRuntimeManager: fakeChannelRuntimeManager,
        pollIntervalMs: 50,
      });

      const tickResult = await worker.tick();
      expect(tickResult.processed).toBe(true);
      expect(tickResult.status).toBe('completed');

      // CRITICAL INVARIANT: Zero messages sent when binding belongs to another workspace!
      expect(deliveredProactiveMessages.length).toBe(0);

      // Restore binding to hostSpaceId for subsequent tests
      db.prepare('UPDATE channel_bindings SET space_id = ? WHERE id = ?').run(hostSpaceId, 'cb_synth_1');
    });

    it('silent task completes turn in main session without dispatching external notification', async () => {
      db.prepare('UPDATE spaces SET canonical_session_id = ? WHERE id = ?').run(hostSessionId, hostSpaceId);

      const ops = operationsService.forTenant(tenantAlice);
      const { task } = await ops.tasks.createTask({
        title: 'Silent Observation Task',
        payload: {
          type: 'agent_prompt',
          prompt: 'Silent observation extractor',
          sessionId: hostSessionId,
          sessionPolicy: 'existing_session',
          silent: true,
        },
      });

      const worker = createPlatformServerTaskWorker({
        db,
        dispatcher,
        channelRuntimeManager: fakeChannelRuntimeManager,
        pollIntervalMs: 50,
      });

      const tickResult = await worker.tick();
      expect(tickResult.processed).toBe(true);
      expect(tickResult.status).toBe('completed');

      // No external notification
      expect(deliveredProactiveMessages.length).toBe(0);

      // But turn executed and assistant message recorded in web_messages!
      const messages = db
        .prepare('SELECT id, role, content FROM web_messages WHERE session_id = ? AND role = ?')
        .all(hostSessionId, 'assistant');
      expect(messages.length).toBeGreaterThan(0);
    });
  });

  describe('5. Acceptance of Imported task_hpc IDs & IANA Timezones', () => {
    it('accepts imported task_hpc ID format and canonical IANA timezone in operations and dispatcher', async () => {
      db.prepare('UPDATE spaces SET canonical_session_id = ? WHERE id = ?').run(hostSessionId, hostSpaceId);

      const ops = operationsService.forTenant(tenantAlice);
      const { task } = await ops.tasks.createTask({
        id: importedTaskId,
        title: 'Imported HPC Task',
        timezone: 'America/Los_Angeles',
        scheduleType: 'cron',
        cronExpression: '0 4 * * *',
        payload: {
          type: 'agent_prompt',
          prompt: 'Imported daily cron spec',
          sessionId: hostSessionId,
          sessionPolicy: 'existing_session',
          spaceFolder: 'space-host-folder',
          silent: true,
        },
      });

      expect(task.id).toBe(importedTaskId);
      expect(task.timezone).toBe('America/Los_Angeles');

      // Dispatcher accepts imported task_hpc ID
      const result = await dispatcher.dispatch({
        task,
        payload: task.payload as any,
        signal: new AbortController().signal,
        workerId: 'worker_1',
        tenantId: tenantAlice,
      });

      expect(result.status).toBe('completed');
    });
  });

  describe('6. Real SQLite + FakeTransport Outbox Race & Idempotency', () => {
    it('2 concurrent same run 1 sends, replays after delivered 0 additional, crash/retry status no fake success', async () => {
      let transportSendCount = 0;
      let shouldSimulateCrash = false;

      const fakeTransport: any = {
        connected: true,
        onEvent: () => {},
        createStreamingCard: null, // Force sendReply path
        sendReply: async (params: any) => {
          if (shouldSimulateCrash) {
            throw new Error('Simulated transport network crash during proactive card send');
          }
          transportSendCount++;
          return { success: true, messageId: `om_transport_${transportSendCount}` };
        },
      };

      const tenant = storage.forTenant(tenantAlice);

      const gateway = new LarkChannelGateway({
        account: {
          id: 'acc_synth_lark_1',
          userId: tenantAlice,
          channel: 'lark',
          status: 'active',
        },
        transport: fakeTransport,
        channelRepo: tenant.channels,
        sessionRouteRepo: tenant.sessionRoutes,
        spaceRepo: tenant.spaces,
        defaultSpaceId: hostSpaceId,
      });

      const outboxId = 'out_task_run_race_0000000000001';

      // (a) 2 concurrent calls for same taskRunId -> exactly 1 transport send
      const [res1, res2] = await Promise.all([
        gateway.sendProactiveMessage({
          chatId: 'oc_synth_chat_1',
          text: 'Concurrent test message',
          sessionId: hostSessionId,
          outboxId,
        }),
        gateway.sendProactiveMessage({
          chatId: 'oc_synth_chat_1',
          text: 'Concurrent test message',
          sessionId: hostSessionId,
          outboxId,
        }),
      ]);

      expect(res1.success).toBe(true);
      expect(res2.success).toBe(true);
      expect(transportSendCount).toBe(1);

      // (b) Replay after delivered -> 0 additional sends
      const replayRes = await gateway.sendProactiveMessage({
        chatId: 'oc_synth_chat_1',
        text: 'Concurrent test message',
        sessionId: hostSessionId,
        outboxId,
      });

      expect(replayRes.success).toBe(true);
      expect(transportSendCount).toBe(1); // STILL 1 (0 additional)

      // (c) Crash/retry status -> no fake success, outbox status never marked delivered
      shouldSimulateCrash = true;
      const crashOutboxId = 'out_task_run_crash_00000000002';

      const crashRes = await gateway.sendProactiveMessage({
        chatId: 'oc_synth_chat_1',
        text: 'Crashing test message',
        sessionId: hostSessionId,
        outboxId: crashOutboxId,
      });

      expect(crashRes.success).toBe(false);
      expect(crashRes.error).toContain('Simulated transport network crash');

      // Verify DB outbox status is NOT delivered
      const crashRow = db.prepare('SELECT status, attempts FROM channel_outbox WHERE id = ?').get(crashOutboxId) as any;
      expect(crashRow).toBeDefined();
      expect(crashRow.status).not.toBe('delivered');
      expect(['pending', 'failed']).toContain(crashRow.status);
    });
  });
});
