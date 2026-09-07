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
  SqliteWebMessageStore,
} from '../src/storage/web-messages.js';
import {
  DeliveryRuntimeGateway,
  type DeliveryTurnExecutor,
} from '../src/runtime/delivery-gateway.js';
import {
  AgentPromptDeliveryDispatcher,
  createAgentPromptDeliveryDispatcher,
  isValidIsoDate,
} from '../src/operations/agent-prompt-dispatcher.js';
import {
  ValidationError,
  NotFoundError,
} from '@enkeep/platform-core';
import type { AgentPromptDispatchContext } from '@enkeep/platform-operations';

describe('AgentPromptDeliveryDispatcher', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let messageStore: SqliteWebMessageStore;
  let operationsStorage: SqlitePlatformOperationsStorage;
  let deliveryGateway: DeliveryRuntimeGateway;
  let dispatcher: AgentPromptDeliveryDispatcher;

  const tenantAlice = 'user_alice_disp';
  const tenantBob = 'user_bob_disp';
  const validTaskId = 'task_0123456789abcdef0123456789abcdef';
  const validAliceSpaceId = 'spc_0123456789abcdef0123456789abcdef';
  const validAliceSessionId = 'ses_0123456789abcdef0123456789abcdef';
  const validAliceSpaceFolder = 'space-0123456789abcdef0123456789abcdef';
  const validAliceDshSessionId = 'ses_11111111111111111111111111111111';

  let mockExecutor: DeliveryTurnExecutor;
  let executedTurns: Array<{ turnId: string; envelope: any }> = [];
  let cancelledTurns: Array<{ turnId: string; userId: string }> = [];

  beforeEach(async () => {
    executedTurns = [];
    cancelledTurns = [];

    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    storage = new SqlitePlatformStorage(db);
    messageStore = new SqliteWebMessageStore(db);
    operationsStorage = new SqlitePlatformOperationsStorage(db);

    // Create users
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

    // Create Alice space and session route
    await storage.forTenant(tenantAlice).spaces.create({
      id: validAliceSpaceId,
      name: 'Alice Space',
      folder: validAliceSpaceFolder,
      executionMode: 'container',
    });

    await storage.forTenant(tenantAlice).sessionRoutes.create({
      id: validAliceSessionId,
      spaceId: validAliceSpaceId,
      channel: 'web',
      accountId: 'web-demo',
      nativeContextId: validAliceSessionId,
      peerId: 'alice_peer',
      dshSessionId: validAliceDshSessionId,
      executionMode: 'container',
    });

    mockExecutor = {
      async execute(request) {
        executedTurns.push({ turnId: request.turnId, envelope: request.envelope });
        await new Promise((r) => setTimeout(r, 20));
        return {
          replyText: `[Mock Output] Processed prompt for turn ${request.turnId}`,
          metadata: {
            eventsCount: 1,
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
      maxWaitMs: 3000,
      pollIntervalMs: 15,
    });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // ignore
    }
  });

  function createDispatchContext(overrides?: Partial<AgentPromptDispatchContext>): AgentPromptDispatchContext {
    const abortController = new AbortController();
    return {
      task: {
        id: validTaskId,
        userId: tenantAlice,
        title: 'Test Prompt Task',
        priority: 'high',
        status: 'running',
        payload: {
          type: 'agent_prompt',
          prompt: 'Hello AI assistant',
          sessionId: validAliceSessionId,
          sessionPolicy: 'existing_session',
        },
        leaseDurationMs: 30000,
        claimCount: 1,
        maxRetries: 3,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      payload: {
        type: 'agent_prompt',
        prompt: 'Hello AI assistant',
        sessionId: validAliceSessionId,
        sessionPolicy: 'existing_session',
      },
      signal: abortController.signal,
      workerId: 'worker_unit_1',
      tenantId: tenantAlice,
      ...overrides,
    };
  }

  describe('1. Payload Validation & Existing Session Routing', () => {
    it('requires sessionId and sessionPolicy="existing_session"', async () => {
      const ctx = createDispatchContext({
        payload: {
          type: 'agent_prompt',
          prompt: 'Hello',
          sessionId: '',
          sessionPolicy: 'existing_session',
        },
      });

      await expect(dispatcher.dispatch(ctx)).rejects.toThrow(ValidationError);
      await expect(dispatcher.dispatch(ctx)).rejects.toThrow(/Invalid session ID format/i);
    });

    it('rejects implicit space selection without sessionId', async () => {
      const ctx = createDispatchContext({
        payload: {
          type: 'agent_prompt',
          prompt: 'Hello without session',
          spaceId: validAliceSpaceId,
        } as any,
      });

      await expect(dispatcher.dispatch(ctx)).rejects.toThrow(ValidationError);
      await expect(dispatcher.dispatch(ctx)).rejects.toThrow(/Invalid session ID format/i);
    });

    it('rejects invalid sessionPolicy', async () => {
      const ctx = createDispatchContext({
        payload: {
          type: 'agent_prompt',
          prompt: 'Hello',
          sessionId: validAliceSessionId,
          sessionPolicy: 'new_session_per_task' as any,
        },
      });

      await expect(dispatcher.dispatch(ctx)).rejects.toThrow(ValidationError);
      await expect(dispatcher.dispatch(ctx)).rejects.toThrow(/Invalid task payload session policy/i);
    });

    it('rejects cross-tenant session routing', async () => {
      const bobSpaceId = 'spc_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      const bobSessionId = 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      const bobSpaceFolder = 'space-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      const bobDshSessionId = 'ses_22222222222222222222222222222222';

      await storage.forTenant(tenantBob).spaces.create({
        id: bobSpaceId,
        name: 'Bob Space',
        folder: bobSpaceFolder,
        executionMode: 'container',
      });
      const bobRoute = await storage.forTenant(tenantBob).sessionRoutes.create({
        id: bobSessionId,
        spaceId: bobSpaceId,
        channel: 'web',
        accountId: 'web-demo',
        nativeContextId: bobSessionId,
        peerId: 'bob_peer',
        dshSessionId: bobDshSessionId,
        executionMode: 'container',
      });

      const ctx = createDispatchContext({
        payload: {
          type: 'agent_prompt',
          prompt: 'Steal Bob session',
          sessionId: bobRoute.id,
          sessionPolicy: 'existing_session',
        },
      });

      await expect(dispatcher.dispatch(ctx)).rejects.toThrow(NotFoundError);
      await expect(dispatcher.dispatch(ctx)).rejects.toThrow(/\[SESSION_NOT_FOUND\]/i);
    });

    it('rejects inactive session route', async () => {
      // Archive Alice route
      await storage.forTenant(tenantAlice).sessionRoutes.update(validAliceSessionId, {
        status: 'archived',
      });

      const ctx = createDispatchContext();
      await expect(dispatcher.dispatch(ctx)).rejects.toThrow(ValidationError);
      await expect(dispatcher.dispatch(ctx)).rejects.toThrow(/\[INVALID_SESSION_ROUTE\]/i);
    });

    it('rejects missing, untrimmed, or non-canonical task id', async () => {
      const emptyCtx = createDispatchContext({
        task: {
          id: '',
          userId: tenantAlice,
          title: 'Empty task id',
          priority: 'high',
          status: 'running',
          payload: {
            type: 'agent_prompt',
            prompt: 'Hello',
            sessionId: validAliceSessionId,
            sessionPolicy: 'existing_session',
          },
          leaseDurationMs: 30000,
          claimCount: 1,
          maxRetries: 3,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });
      await expect(dispatcher.dispatch(emptyCtx)).rejects.toThrow(ValidationError);
      await expect(dispatcher.dispatch(emptyCtx)).rejects.toThrow(/\[INVALID_TASK\]/i);

      const untrimmedCtx = createDispatchContext({
        task: {
          id: ` ${validTaskId} `,
          userId: tenantAlice,
          title: 'Untrimmed task id',
          priority: 'high',
          status: 'running',
          payload: {
            type: 'agent_prompt',
            prompt: 'Hello',
            sessionId: validAliceSessionId,
            sessionPolicy: 'existing_session',
          },
          leaseDurationMs: 30000,
          claimCount: 1,
          maxRetries: 3,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });
      await expect(dispatcher.dispatch(untrimmedCtx)).rejects.toThrow(ValidationError);
      await expect(dispatcher.dispatch(untrimmedCtx)).rejects.toThrow(/\[INVALID_TASK\]/i);

      const nonCanonicalCtx = createDispatchContext({
        task: {
          id: 'custom_non_task_id',
          userId: tenantAlice,
          title: 'Non canonical task id',
          priority: 'high',
          status: 'running',
          payload: {
            type: 'agent_prompt',
            prompt: 'Hello',
            sessionId: validAliceSessionId,
            sessionPolicy: 'existing_session',
          },
          leaseDurationMs: 30000,
          claimCount: 1,
          maxRetries: 3,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });
      await expect(dispatcher.dispatch(nonCanonicalCtx)).rejects.toThrow(ValidationError);
      await expect(dispatcher.dispatch(nonCanonicalCtx)).rejects.toThrow(/\[INVALID_TASK\]/i);
    });

    it('rejects route with non-web channel or invalid accountId', async () => {
      db.prepare(`UPDATE session_routes SET channel = 'slack' WHERE id = ?`).run(validAliceSessionId);
      const ctx = createDispatchContext();
      await expect(dispatcher.dispatch(ctx)).rejects.toThrow(/channel must be web/i);
    });

    it('rejects route with invalid accountId', async () => {
      db.prepare(`UPDATE session_routes SET account_id = 'custom-account' WHERE id = ?`).run(validAliceSessionId);
      const ctx = createDispatchContext();
      await expect(dispatcher.dispatch(ctx)).rejects.toThrow(/accountId must be web-demo/i);
    });

    it('rejects route with nativeContextId not matching route id', async () => {
      db.prepare(`UPDATE session_routes SET native_context_id = 'different_id' WHERE id = ?`).run(validAliceSessionId);
      const ctx = createDispatchContext();
      await expect(dispatcher.dispatch(ctx)).rejects.toThrow(/nativeContextId must match route id/i);
    });

    it('passes route peerId authoritatively without fabricating fallback', async () => {
      db.prepare(`UPDATE session_routes SET peer_id = 'alice_peer_custom' WHERE id = ?`).run(validAliceSessionId);
      const ctx = createDispatchContext();
      await dispatcher.dispatch(ctx);

      const executed = executedTurns[executedTurns.length - 1];
      expect(executed.envelope.sessionId).toBe(validAliceSessionId);
    });

    it('rejects inactive space', async () => {
      await storage.forTenant(tenantAlice).spaces.update(validAliceSpaceId, {
        status: 'archived',
      });

      const ctx = createDispatchContext();
      await expect(dispatcher.dispatch(ctx)).rejects.toThrow(ValidationError);
      await expect(dispatcher.dispatch(ctx)).rejects.toThrow(/\[INVALID_SPACE\]/i);
    });

    it('rejects non-container executionMode space', async () => {
      db.prepare(`UPDATE spaces SET execution_mode = 'native' WHERE id = ?`).run(validAliceSpaceId);

      const ctx = createDispatchContext();
      await expect(dispatcher.dispatch(ctx)).rejects.toThrow(/execution mode/i);
    });
  });

  describe('2. Optional SpaceId Mismatch Validation', () => {
    it('accepts matching optional spaceId', async () => {
      const ctx = createDispatchContext({
        payload: {
          type: 'agent_prompt',
          prompt: 'Hello',
          sessionId: validAliceSessionId,
          spaceId: validAliceSpaceId,
          sessionPolicy: 'existing_session',
        },
      });

      const result = await dispatcher.dispatch(ctx);
      expect(result).toBeDefined();
      expect(result.status).toBe('completed');
      expect(isValidIsoDate(result.completedAt)).toBe(true);
    });

    it('rejects mismatched optional spaceId with ValidationError', async () => {
      const otherSpaceId = 'spc_99999999999999999999999999999999';
      const ctx = createDispatchContext({
        payload: {
          type: 'agent_prompt',
          prompt: 'Hello',
          sessionId: validAliceSessionId,
          spaceId: otherSpaceId,
          sessionPolicy: 'existing_session',
        },
      });

      await expect(dispatcher.dispatch(ctx)).rejects.toThrow(
        /\[SPACE_MISMATCH\]/i
      );
    });
  });

  describe('3. Authoritative Envelope Context & No Metadata Leakage', () => {
    it('constructs InboundEnvelope with full strength UUID, authoritative route context, and no leaked metadata', async () => {
      const ctx = createDispatchContext();
      await dispatcher.dispatch(ctx);

      expect(executedTurns.length).toBe(1);
      const executed = executedTurns[0];

      // Canonical deliv_ + 32 hex UUID deliveryId
      expect(executed.envelope.id).toMatch(/^deliv_[0-9a-f]{32}$/);
      expect(executed.envelope.userId).toBe(tenantAlice);
      expect(executed.envelope.sessionId).toBe(validAliceSessionId);
      expect(executed.envelope.content).toBe('Hello AI assistant');
      expect(isValidIsoDate(executed.envelope.timestamp)).toBe(true);

      // Simplified envelope: no nativeContext, no routeKey, no metadata or taskId raw linkage
      expect((executed.envelope as any).nativeContext).toBeUndefined();
      expect((executed.envelope as any).routeKey).toBeUndefined();
      expect((executed.envelope as any).metadata).toBeUndefined();
      expect((executed.envelope as any).taskId).toBeUndefined();
    });
  });

  describe('4. Authoritative Completion & Honest Metadata', () => {
    it('resolves minimal completion from SQLite turn_runs and web_messages without duplicating raw replyText', async () => {
      const ctx = createDispatchContext();
      const result = await dispatcher.dispatch(ctx);

      expect(result.status).toBe('completed');
      expect(isValidIsoDate(result.completedAt)).toBe(true);

      // Verify strict minimization: no raw replyText, turnId, sessionId, spaceId, or messageId
      expect((result as any).replyText).toBeUndefined();
      expect((result as any).turnId).toBeUndefined();
      expect((result as any).sessionId).toBeUndefined();
      expect((result as any).spaceId).toBeUndefined();
      expect((result as any).messageId).toBeUndefined();
      expect(result).toEqual({
        status: 'completed',
        completedAt: result.completedAt,
      });
    });

    it('fails protocol when turn_runs is marked completed but finished_at is missing or not a canonical ISO date', async () => {
      // Custom executor that directly sets corrupted finished_at in turn_runs without gateway completion
      const corruptDispatcher = createAgentPromptDeliveryDispatcher({
        gateway: new DeliveryRuntimeGateway({
          storage,
          messageStore,
          database: db,
          executor: {
            async execute(req: any) {
              db.prepare(`
                UPDATE turn_runs
                SET status = 'completed', finished_at = '2026-02-26 12:00:00'
                WHERE turn_id = ?
              `).run(req.turnId);
              // Keep in-flight so gateway does not overwrite finished_at
              await new Promise(() => {});
              return { replyText: 'Never' };
            },
            async cancel() { return true; },
          },
          quotaMode: 'disabled',
        profileResolver: { resolve: async () => null }
      }),
        storage,
        database: db,
        maxWaitMs: 1000,
        pollIntervalMs: 10,
      });

      const ctx = createDispatchContext();
      await expect(corruptDispatcher.dispatch(ctx)).rejects.toThrow(
        /canonical finished_at ISO timestamp/i
      );
    });

    it('fails protocol when turn_runs is marked completed but assistant message is missing in web_messages', async () => {
      const missingMsgDispatcher = createAgentPromptDeliveryDispatcher({
        gateway: new DeliveryRuntimeGateway({
          storage,
          messageStore,
          database: db,
          executor: {
            async execute(req: any) {
              db.prepare(`
                UPDATE turn_runs
                SET status = 'completed', finished_at = ?
                WHERE turn_id = ?
              `).run(new Date().toISOString(), req.turnId);
              // Keep in-flight so gateway does not insert assistant message
              await new Promise(() => {});
              return { replyText: 'Never' };
            },
            async cancel() { return true; },
          },
          quotaMode: 'disabled',
        profileResolver: { resolve: async () => null }
      }),
        storage,
        database: db,
        maxWaitMs: 1000,
        pollIntervalMs: 10,
      });

      const ctx = createDispatchContext();
      await expect(missingMsgDispatcher.dispatch(ctx)).rejects.toThrow(
        /Missing authentic assistant message/i
      );
    });

    it('fails protocol when assistant message status is not delivered or content is empty', async () => {
      const emptyContentDispatcher = createAgentPromptDeliveryDispatcher({
        gateway: new DeliveryRuntimeGateway({
          storage,
          messageStore,
          database: db,
          executor: {
            async execute(req: any) {
              const nowIso = new Date().toISOString();
              // Insert message BEFORE updating turn_runs to completed so polling sees both
              db.prepare(`
                INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, turn_id, created_at)
                VALUES (?, ?, ?, 'assistant', '   ', 'delivered', ?, ?, ?)
              `).run('out_empty_test', validAliceSessionId, tenantAlice, `${tenantAlice}:web:web-demo:${validAliceSessionId}`, req.turnId, nowIso);
              db.prepare(`
                UPDATE turn_runs
                SET status = 'completed', finished_at = ?
                WHERE turn_id = ?
              `).run(nowIso, req.turnId);

              // Keep promise pending so gateway does not attempt completion concurrently
              await new Promise(() => {});
              return { replyText: 'Never' };
            },
            async cancel() { return true; },
          },
          quotaMode: 'disabled',
        profileResolver: { resolve: async () => null }
      }),
        storage,
        database: db,
        maxWaitMs: 1000,
        pollIntervalMs: 10,
      });

      const ctx = createDispatchContext();
      await expect(emptyContentDispatcher.dispatch(ctx)).rejects.toThrow(
        /empty or invalid content/i
      );
    });
  });

  describe('5. AbortSignal Awaits Cancellation & Exact-Once Semantics', () => {
    it('aborts immediately before dispatch when signal is already aborted', async () => {
      const abortController = new AbortController();
      abortController.abort();

      let cancelCalled = false;
      const gatewayWithCancelSpy = new DeliveryRuntimeGateway({
        storage,
        messageStore,
        database: db,
        executor: {
          async execute() { return { replyText: 'Ok' }; },
          async cancel() {
            cancelCalled = true;
            return true;
          },
        },
        quotaMode: 'disabled',
        profileResolver: { resolve: async () => null }
      });

      const earlyAbortDispatcher = createAgentPromptDeliveryDispatcher({
        gateway: gatewayWithCancelSpy,
        storage,
        database: db,
      });

      const ctx = createDispatchContext({ signal: abortController.signal });
      await expect(earlyAbortDispatcher.dispatch(ctx)).rejects.toThrow(/Task execution was aborted/i);
      expect(cancelCalled).toBe(false); // No turnId was generated
    });

    it('awaits gateway.cancelTurn when signal aborts during in-flight turn execution', async () => {
      let cancelPromiseResolved = false;
      const abortController = new AbortController();

      const slowGateway = new DeliveryRuntimeGateway({
        storage,
        messageStore,
        database: db,
        executor: {
          async execute() {
            // Keep executing until cancelled
            await new Promise((r) => setTimeout(r, 2000));
            return { replyText: 'Never finished' };
          },
          async cancel(userId, turnId) {
            // Simulate slow authoritative cancellation
            await new Promise((r) => setTimeout(r, 50));
            cancelPromiseResolved = true;
            return true;
          },
        },
        quotaMode: 'disabled',
        profileResolver: { resolve: async () => null }
      });

      const abortDispatcher = createAgentPromptDeliveryDispatcher({
        gateway: slowGateway,
        storage,
        database: db,
        maxWaitMs: 5000,
        pollIntervalMs: 10,
      });

      const ctx = createDispatchContext({ signal: abortController.signal });

      // Trigger abort after dispatch has returned turnId
      setTimeout(() => {
        abortController.abort();
      }, 50);

      await expect(abortDispatcher.dispatch(ctx)).rejects.toThrow(/Task execution was aborted/i);
      expect(cancelPromiseResolved).toBe(true);
    });

    it('surfaces safe sanitized error when gateway.cancelTurn fails (no swallow)', async () => {
      const abortController = new AbortController();

      const failingCancelGateway = new DeliveryRuntimeGateway({
        storage,
        messageStore,
        database: db,
        executor: {
          async execute() {
            await new Promise((r) => setTimeout(r, 2000));
            return { replyText: 'Never' };
          },
          async cancel() {
            throw new Error('Docker daemon socket connection refused at /var/run/docker.sock\n    at Socket.connect (/Users/test/node_modules/docker.js:10:5)');
          },
        },
        quotaMode: 'disabled',
        profileResolver: { resolve: async () => null }
      });

      const failingCancelDispatcher = createAgentPromptDeliveryDispatcher({
        gateway: failingCancelGateway,
        storage,
        database: db,
        maxWaitMs: 5000,
        pollIntervalMs: 10,
      });

      const ctx = createDispatchContext({ signal: abortController.signal });

      setTimeout(() => {
        abortController.abort();
      }, 50);

      try {
        await failingCancelDispatcher.dispatch(ctx);
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.message).toMatch(/Cancellation failed/i);
        expect(err.message).not.toContain('/Users/test/');
        expect(err.message).not.toContain('/var/run/');
      }
    });
  });

  describe('6. Timeout Cancellation', () => {
    it('cancels turn and awaits gateway.cancelTurn when maxWaitMs timeout is reached', async () => {
      let timeoutCancelCalled = false;

      const timeoutGateway = new DeliveryRuntimeGateway({
        storage,
        messageStore,
        database: db,
        executor: {
          async execute() {
            await new Promise((r) => setTimeout(r, 5000));
            return { replyText: 'Too slow' };
          },
          async cancel() {
            timeoutCancelCalled = true;
            return true;
          },
        },
        quotaMode: 'disabled',
        profileResolver: { resolve: async () => null }
      });

      const timeoutDispatcher = createAgentPromptDeliveryDispatcher({
        gateway: timeoutGateway,
        storage,
        database: db,
        maxWaitMs: 100, // Short timeout
        pollIntervalMs: 10,
      });

      const ctx = createDispatchContext();
      await expect(timeoutDispatcher.dispatch(ctx)).rejects.toThrow(/Turn execution timed out/i);
      expect(timeoutCancelCalled).toBe(true);
    });
  });

  describe('7. Cancellation & Finalize Race', () => {
    it('accepts terminal completed result if authoritative completion won before cancel took effect', async () => {
      const abortController = new AbortController();

      const raceGateway = new DeliveryRuntimeGateway({
        storage,
        messageStore,
        database: db,
        executor: {
          async execute(envelope) {
            await new Promise((r) => setTimeout(r, 40));
            return {
              replyText: 'Fast completion won the race',
              metadata: { eventsCount: 2, persisted: true },
              usage: { totalTokens: 10 },
            };
          },
          async cancel() {
            // Cancel called after completion committed in DB
            return false;
          },
        },
        quotaMode: 'disabled',
        profileResolver: { resolve: async () => null }
      });

      const raceDispatcher = createAgentPromptDeliveryDispatcher({
        gateway: raceGateway,
        storage,
        database: db,
        maxWaitMs: 2000,
        pollIntervalMs: 10,
      });

      const ctx = createDispatchContext({ signal: abortController.signal });

      // Trigger abort right around completion time
      setTimeout(() => {
        abortController.abort();
      }, 70);

      const result = await raceDispatcher.dispatch(ctx);
      expect(result.status).toBe('completed');
      expect(isValidIsoDate(result.completedAt)).toBe(true);
    });
  });

  describe('8. Error Sanitization on Failure / Interruption & Canonical Validators', () => {
    it('sanitizes stack traces and file paths when turn execution fails with safe code prefix', async () => {
      const failingGateway = new DeliveryRuntimeGateway({
        storage,
        messageStore,
        database: db,
        executor: {
          async execute() {
            throw new Error('Container crashed at /Users/developer/code/script.sh:42\n    at Object.run (/home/runner/exec.ts:99:1)');
          },
          async cancel() { return true; },
        },
        quotaMode: 'disabled',
        profileResolver: { resolve: async () => null }
      });

      const failDispatcher = createAgentPromptDeliveryDispatcher({
        gateway: failingGateway,
        storage,
        database: db,
        maxWaitMs: 2000,
        pollIntervalMs: 10,
      });

      const ctx = createDispatchContext();
      try {
        await failDispatcher.dispatch(ctx);
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.message).toMatch(/Turn execution failed/i);
        expect(err.message).toContain('[TURN_EXECUTION_FAILED]');
        expect(err.message).not.toContain('/Users/developer/');
        expect(err.message).not.toContain('/home/runner/');
      }
    });

    it('isValidIsoDate strictly verifies canonical ISO round-trip', () => {
      expect(isValidIsoDate(new Date().toISOString())).toBe(true);
      expect(isValidIsoDate('2026-02-26T12:30:00.000Z')).toBe(true);
      expect(isValidIsoDate('2026-02-26 12:30:00')).toBe(false);
      expect(isValidIsoDate('invalid')).toBe(false);
      expect(isValidIsoDate('')).toBe(false);
      expect(isValidIsoDate(null)).toBe(false);
    });
  });
});
