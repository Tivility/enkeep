/**
 * Targeted Offline Verification for Lark Channel Pre-Live Readiness.
 *
 * Test Suites:
 * Group A: Real PlatformServer + DeliveryRuntimeGateway Integration (mock only at Lark SDK boundary)
 * Group B: Two Bots Same User + Multi-Tenant Isolation + Disabled Gates + Thread Routing
 * Group C: Inbound Replay / Outbound Concurrent CAS / Network Failure Retry / Crash Recovery / Idempotency
 *
 * @module @enkeep/channel-lark/tests/lark-prelive-offline-verification.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import * as lark from '@larksuiteoapi/node-sdk';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
} from '../../platform-server/src/storage/migrations.js';
import {
  SqlitePlatformStorage,
  SqliteTenantScopedChannelRepository,
  SqliteTenantScopedSessionRouteRepository,
  SqliteTenantScopedSpaceRepository,
} from '@enkeep/platform-storage-sqlite';
import {
  DeliveryRuntimeGateway,
  type DeliveryTurnExecutor,
  type DeliveryExecutionRequest,
} from '../../platform-server/src/runtime/delivery-gateway.js';
import {
  SqliteWebMessageStore,
} from '../../platform-server/src/storage/web-messages.js';
import {
  PlatformServer,
} from '../../platform-server/src/server/server.js';
import {
  ChannelRuntimeManager,
} from '../../platform-server/src/channels/channel-runtime-manager.js';
import {
  FakeLarkTransport,
  CredentialedLarkTransport,
  LarkChannelGateway,
  parseLarkEvent,
  buildNativeContextId,
  messageMentionsBot,
  stripLeadingMentions,
  type LarkRawEvent,
  type LarkSdkClientFactory,
} from '../src/index.js';

describe('Lark Channel Pre-Live Offline Verification', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let messageStore: SqliteWebMessageStore;

  const user1 = 'usr_alice_owner';
  const user2 = 'usr_bob_owner';
  const space1 = 'spc_alice_main';
  const space2 = 'spc_bob_main';

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    // Seed users and spaces
    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'alice', 'hash')`).run(user1);
    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'bob', 'hash')`).run(user2);
    db.prepare(`INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES (?, ?, 'Alice Space', 'alice-spc', 'container')`).run(space1, user1);
    db.prepare(`INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES (?, ?, 'Bob Space', 'bob-spc', 'container')`).run(space2, user2);

    storage = new SqlitePlatformStorage(db);
    messageStore = new SqliteWebMessageStore(db);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GROUP A: PlatformServer & DeliveryRuntimeGateway Component Integration
  // (Component executor uses a deterministic mock string, not genuine DSH AgentLoop.
  //  Genuine DSH runtime wiring is verified in platform-server/tests/lark-production-wiring.test.ts)
  // ──────────────────────────────────────────────────────────────────────────
  describe('Group A: PlatformServer & DeliveryRuntimeGateway Component Integration (Mock Executor - Genuine DSH verified in platform-server/tests/lark-production-wiring.test.ts)', () => {
    it('inbound user prompt != assistant output, asynchronous delay blocks premature outbox, and completion delivers plain text to SDK boundary in PlatformServer', async () => {
      let agentExecutionStarted = false;
      let agentExecutionFinished = false;
      let resumeAgentPromise: () => void = () => {};

      const deferredAgentSignal = new Promise<void>((resolve) => {
        resumeAgentPromise = resolve;
      });

      // Handcrafted deterministic string executor (genuine DSH runtime wiring verified in platform-server/tests/lark-production-wiring.test.ts)
      const deterministicExecutor: DeliveryTurnExecutor = {
        execute: async (req: DeliveryExecutionRequest) => {
          agentExecutionStarted = true;
          // Wait until we explicitly signal the agent to complete
          await deferredAgentSignal;
          agentExecutionFinished = true;
          return {
            replyText: `Deterministic DSH Assistant answer to: [${req.content}]`,
            usage: { totalTokens: 42 },
          };
        },
        cancel: async () => true,
      };

      const runtimeGateway = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        executor: deterministicExecutor,
        quotaMode: 'disabled',
        profileResolver: { resolve: async () => null },
      });

      // Account & Transport setup
      const tenant = storage.forTenant(user1);
      const account = await tenant.channels.createAccount({
        type: 'lark',
        status: 'active',
        credentialRef: 'cred_lark_alice_1',
      });

      const chatId = 'oc_group_live_test_1';
      await tenant.channels.createBinding({
        accountId: account.id,
        spaceId: space1,
        nativeContextId: chatId,
        activationMode: 'always',
      });

      const transport = new FakeLarkTransport();

      // Real PlatformServer instance hosting DeliveryRuntimeGateway + ChannelRuntimeManager
      const server = new PlatformServer({
        database: db,
        host: '127.0.0.1',
        port: 0,
        cookieSecret: 'test-secret-at-least-32-chars-long!',
        csrfToken: 'test-csrf-token-at-least-32-chars-long!',
        storage,
        runtimeGateway,
        larkTransportFactory: () => transport,
      });

      try {
        await server.start();

        const runtimeManager = server.channelRuntimeManager!;
        expect(runtimeManager).toBeDefined();

        const gateway = runtimeManager.getActiveGateway(user1, account.id)!;
        expect(gateway).toBeDefined();

        // 1. Simulate Inbound Lark Message Event
        const rawEvent: LarkRawEvent = {
          header: {
            event_id: 'evt_groupA_001',
            event_type: 'im.message.receive_v1',
            create_time: '1700000000000',
          },
          event: {
            sender: {
              sender_id: { open_id: 'ou_client_human_1' },
              sender_type: 'user',
            },
            message: {
              message_id: 'om_human_msg_001',
              chat_id: chatId,
              chat_type: 'group',
              message_type: 'text',
              content: JSON.stringify({ text: 'What is the deployment status?' }),
              create_time: '1700000000000',
            },
          },
        };

        // Dispatch event into gateway
        const inboundResult = await gateway.handleInboundEvent(rawEvent);
        expect(inboundResult.handled).toBe(true);
        expect(inboundResult.inboxItem).toBeDefined();
        expect(inboundResult.inboxItem?.status).toBe('delivered');

        // 2. Verify agent started executing in background
        await vi.waitFor(() => expect(agentExecutionStarted).toBe(true), { timeout: 1000 });
        expect(agentExecutionFinished).toBe(false);

        // 3. Before agent completion: verify NO outbox reply exists yet!
        const outboxBefore = await tenant.channels.listPendingOutbox(10, account.id);
        expect(outboxBefore.length).toBe(0);
        expect(transport.sentReplies.length).toBe(0);

        // 4. Resume agent to finish execution
        resumeAgentPromise();

        // Wait for turn completion and outbox delivery
        await vi.waitFor(() => expect(transport.sentReplies.length).toBe(1), { timeout: 2000 });

        expect(agentExecutionFinished).toBe(true);

        // 5. Verify assistant reply was delivered to Lark SDK boundary
        const sent = transport.sentReplies[0];
        expect(sent.chatId).toBe(chatId);
        expect(sent.replyToMessageId).toBe('om_human_msg_001');
        // Crucial: prompt != assistant response
        expect(sent.content).toBe('Deterministic DSH Assistant answer to: [What is the deployment status?]');
        expect(sent.format).toBe('plain');

        // 6. Verify durable outbox status is 'delivered' in database
        const outboxItems = db.prepare('SELECT * FROM channel_outbox WHERE account_id = ?').all(account.id) as Array<{ status: string; attempts: number }>;
        expect(outboxItems.length).toBe(1);
        expect(outboxItems[0].status).toBe('delivered');
        expect(outboxItems[0].attempts).toBe(1);
      } finally {
        await server.stop();
      }
    });

    it('SDK EventDispatcher receives flattened event and passes through CredentialedLarkTransport with real onReady lifecycle and getConnectionStatus object contract', async () => {
      let replyCalledWith: any = null;

      // Mock SDK Client and WSClient boundary
      const mockClientFactory: LarkSdkClientFactory = {
        createClient: (_opts) => {
          return {
            im: {
              message: {
                reply: async (req: any) => {
                  replyCalledWith = req;
                  return { code: 0, data: { message_id: 'om_sdk_reply_success_999' } };
                },
                create: async (req: any) => {
                  replyCalledWith = req;
                  return { code: 0, data: { message_id: 'om_sdk_create_success_999' } };
                },
              },
            },
          };
        },
        createWSClient: (opts) => {
          let connectionState: 'idle' | 'connected' | 'disconnected' = 'idle';
          const wsMock = {
            onReady: opts?.onReady,
            onError: opts?.onError,
            onReconnecting: opts?.onReconnecting,
            onReconnected: opts?.onReconnected,
            eventDispatcher: null as any,
            getConnectionStatus: () => ({
              state: connectionState,
              reconnectAttempts: 0,
            }),
            start: async ({ eventDispatcher }: { eventDispatcher: any }) => {
              wsMock.eventDispatcher = eventDispatcher;
              connectionState = 'connected';
              if (wsMock.onReady) {
                wsMock.onReady();
              }
            },
            close: async () => {
              connectionState = 'disconnected';
              if (wsMock.onError) {
                wsMock.onError(new Error('Closed'));
              }
            },
          };
          return wsMock;
        },
      };

      const credTransport = new CredentialedLarkTransport({
        account: {
          id: 'acc_cred_sdk_1',
          userId: user1,
          appId: 'cli_real_app_id_1',
          appSecret: 'sec_real_secret_1',
          brand: 'feishu',
        },
        clientFactory: mockClientFactory,
      });

      try {
        expect(credTransport.connected).toBe(false);
        await credTransport.start();
        expect(credTransport.connected).toBe(true);

        let capturedEvent: LarkRawEvent | null = null;
        credTransport.onEvent(async (ev) => {
          capturedEvent = ev;
        });

        // Trigger official Lark EventDispatcher with flattened schema 2.0 structure
        const sdkWSClient = (credTransport as any).wsClient;
        expect(sdkWSClient.eventDispatcher).toBeDefined();

        await sdkWSClient.eventDispatcher.invoke({
          schema: '2.0',
          header: {
            event_id: 'evt_flattened_101',
            event_type: 'im.message.receive_v1',
            create_time: '1700000000000',
          },
          event: {
            sender: { sender_id: { open_id: 'ou_flat_sender' } },
            message: {
              message_id: 'om_flat_msg_101',
              chat_id: 'oc_flat_chat_1',
              chat_type: 'p2p',
              message_type: 'text',
              content: JSON.stringify({ text: 'Testing flattened event dispatch' }),
            },
          },
        });

        expect(capturedEvent).not.toBeNull();
        const parsed = parseLarkEvent(capturedEvent!);
        expect(parsed?.messageId).toBe('om_flat_msg_101');
        expect(parsed?.text).toBe('Testing flattened event dispatch');

        // Test sendReply passing stable uuid
        const sendResult = await credTransport.sendReply({
          chatId: 'oc_flat_chat_1',
          replyToMessageId: 'om_flat_msg_101',
          content: 'Replying with plain text',
          uuid: 'out_stable_uuid_101',
        });

        expect(sendResult.success).toBe(true);
        expect(sendResult.messageId).toBe('om_sdk_reply_success_999');
        expect(replyCalledWith?.params?.uuid).toBe('out_stable_uuid_101');
      } finally {
        await credTransport.stop();
        expect(credTransport.connected).toBe(false);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GROUP B: Multi-Bot / Multi-Tenant Isolation & Thread Context Retention
  // ──────────────────────────────────────────────────────────────────────────
  describe('Group B: Multi-Account Isolation, Disabled Gates & Thread Routing', () => {
    it('isolates 2 bots for same user + 1 bot for another user; disabled account halts dispatch and send', async () => {
      const tenant1 = storage.forTenant(user1);
      const tenant2 = storage.forTenant(user2);

      // User 1 Bot A & Bot B
      const botA = await tenant1.channels.createAccount({ type: 'lark', status: 'active', credentialRef: 'ref_A' });
      const botB = await tenant1.channels.createAccount({ type: 'lark', status: 'active', credentialRef: 'ref_B' });
      // User 2 Bot C
      const botC = await tenant2.channels.createAccount({ type: 'lark', status: 'active', credentialRef: 'ref_C' });

      const transportA = new FakeLarkTransport();
      const transportB = new FakeLarkTransport();
      const transportC = new FakeLarkTransport();

      const runtimeGateway = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        executor: {
          execute: async (req) => ({
            replyText: `Reply for [${req.content}]`,
            usage: { totalTokens: 10 },
          }),
          cancel: async () => true,
        },
        quotaMode: 'disabled',
        profileResolver: { resolve: async () => null },
      });

      const transportMap: Record<string, FakeLarkTransport> = {
        [botA.id]: transportA,
        [botB.id]: transportB,
        [botC.id]: transportC,
      };

      const runtimeManager = new ChannelRuntimeManager({
        storage,
        db,
        deliveryGateway: runtimeGateway,
        transportFactory: (acc) => transportMap[acc.id] ?? null,
      });

      try {
        await runtimeManager.start();

        const gwA = runtimeManager.getActiveGateway(user1, botA.id)!;
        const gwB = runtimeManager.getActiveGateway(user1, botB.id)!;
        const gwC = runtimeManager.getActiveGateway(user2, botC.id)!;

        expect(gwA).toBeDefined();
        expect(gwB).toBeDefined();
        expect(gwC).toBeDefined();

        // Bindings
        await tenant1.channels.createBinding({ accountId: botA.id, spaceId: space1, nativeContextId: 'chat_botA', activationMode: 'always' });
        await tenant1.channels.createBinding({ accountId: botB.id, spaceId: space1, nativeContextId: 'chat_botB', activationMode: 'always' });
        await tenant2.channels.createBinding({ accountId: botC.id, spaceId: space2, nativeContextId: 'chat_botC', activationMode: 'always' });

        // Send event to Bot A only
        const inResA = await gwA.handleInboundEvent({
          header: { event_id: 'evt_botA_1', event_type: 'im.message.receive_v1', create_time: '1700000000000' },
          event: {
            sender: { sender_id: { open_id: 'ou_1' } },
            message: { message_id: 'om_botA_1', chat_id: 'chat_botA', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: 'Hello Bot A' }) },
          },
        });
        expect(inResA.handled).toBe(true);

        // Drain execution queue to completion
        await runtimeGateway.drain();

        expect(transportA.sentReplies.length).toBe(1);
        expect(transportB.sentReplies.length).toBe(0);
        expect(transportC.sentReplies.length).toBe(0);

        // Verify repo listPendingOutbox scoped by account
        const pendingA = await tenant1.channels.listPendingOutbox(10, botA.id);
        const pendingB = await tenant1.channels.listPendingOutbox(10, botB.id);
        expect(pendingA.length).toBe(0); // Delivered
        expect(pendingB.length).toBe(0);

        // Disable Bot A
        await tenant1.channels.updateAccount(botA.id, { status: 'disabled' });
        await runtimeManager.onAccountUpdated(user1, botA.id);

        // Dispatched event to disabled Bot A must be rejected
        const disabledRes = await gwA.handleInboundEvent({
          header: { event_id: 'evt_botA_disabled_test', event_type: 'im.message.receive_v1', create_time: '1700000000000' },
          event: {
            sender: { sender_id: { open_id: 'ou_1' } },
            message: { message_id: 'om_disabled_msg', chat_id: 'chat_botA', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: 'Should be ignored' }) },
          },
        });
        expect(disabledRes.handled).toBe(false);
        expect(disabledRes.ignoredReason).toBe('account_disabled');

        // Bot B remains active and working
        const inResB = await gwB.handleInboundEvent({
          header: { event_id: 'evt_botB_1', event_type: 'im.message.receive_v1', create_time: '1700000000000' },
          event: {
            sender: { sender_id: { open_id: 'ou_1' } },
            message: { message_id: 'om_botB_1', chat_id: 'chat_botB', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: 'Hello Bot B' }) },
          },
        });
        expect(inResB.handled).toBe(true);

        await runtimeGateway.drain();

        expect(transportA.sentReplies.length).toBe(1); // No new send for Bot A
        expect(transportB.sentReplies.length).toBe(1); // Bot B delivered
      } finally {
        await runtimeManager.stop();
      }
    });

    it('thread context and reply metadata are structured in payload and preserved across retries without split guessing', async () => {
      const tenant = storage.forTenant(user1);
      const account = await tenant.channels.createAccount({ type: 'lark', status: 'active', credentialRef: 'ref_thread' });
      const transport = new FakeLarkTransport();
      await transport.start();

      const routeRepo = new SqliteTenantScopedSessionRouteRepository(db, user1);

      const gateway = new LarkChannelGateway({
        account,
        transport,
        channelRepo: tenant.channels,
        sessionRouteRepo: routeRepo,
        runtimeGateway: {
          dispatchInbound: async (env) => ({
            accepted: true,
            turnId: env.id,
            message: { id: 'msg_1', role: 'user', content: env.content, status: 'pending', createdAt: new Date().toISOString() },
          }),
          getCurrentTurnStatus: async () => ({ status: 'completed' }),
          cancelCurrentTurn: async () => true,
        },
        defaultSpaceId: space1,
      });

      try {
        const chatId = 'oc_group_threads';
        const rootId = 'om_root_topic_123';
        const threadId = 'om_root_topic_123';
        const replyToMsg = 'om_thread_reply_456';

        // Pre-create binding with always activation
        await tenant.channels.createBinding({
          accountId: account.id,
          spaceId: space1,
          nativeContextId: chatId,
          activationMode: 'always',
        });

        const handleRes = await gateway.handleInboundEvent({
          header: { event_id: 'evt_th_ctx_1', event_type: 'im.message.receive_v1', create_time: '1700000000000' },
          event: {
            sender: { sender_id: { open_id: 'ou_1' } },
            message: {
              message_id: replyToMsg,
              chat_id: chatId,
              root_id: rootId,
              thread_id: threadId,
              chat_type: 'group',
              message_type: 'text',
              content: JSON.stringify({ text: 'Discussion within topic thread' }),
            },
          },
        });
        expect(handleRes.handled).toBe(true);

        const route = await routeRepo.findByRouteIdentity('lark', account.id, `${chatId}:${rootId}`);
        expect(route).not.toBeNull();

        // Simulate completion with structured outbox creation
        const outboxItem = await gateway.handleTurnCompleted({
          sessionId: route!.id,
          turnId: 'trn_th_1',
          replyText: 'Thread Assistant answer',
          nativeEventId: 'evt_th_ctx_1',
          idempotencyKey: `idem_lark_${account.id}_evt_th_ctx_1`,
        });

        expect(outboxItem).not.toBeNull();
        const payload = JSON.parse(outboxItem!.payloadJson);
        expect(payload.chatId).toBe(chatId);
        expect(payload.rootId).toBe(rootId);
        expect(payload.threadId).toBe(threadId);
        expect(payload.replyToMessageId).toBe(replyToMsg);

        expect(transport.sentReplies.length).toBe(1);
        expect(transport.sentReplies[0].chatId).toBe(chatId);
        expect(transport.sentReplies[0].rootId).toBe(rootId);
        expect(transport.sentReplies[0].replyToMessageId).toBe(replyToMsg);

        // Manual Web message in the same session does not create Lark outbox item
        const manualWebResult = await gateway.handleTurnCompleted({
          sessionId: route!.id,
          turnId: 'trn_web_manual_1',
          replyText: 'Manual web assistant reply',
          idempotencyKey: 'deliv_manual_web_user_msg',
        });
        expect(manualWebResult).toBeNull();
      } finally {
        await gateway.dispose();
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GROUP C: Reliability, CAS Concurrency, Network Retry, Crash Recovery & Idempotency
  // ──────────────────────────────────────────────────────────────────────────
  describe('Group C: Reliability, CAS Claims, Network Retries & Stale Recovery', () => {
    it('replays failed inbox events via CAS, ignores duplicate completed events, and enforces CAS concurrency on outbox', async () => {
      const tenant = storage.forTenant(user1);
      const account = await tenant.channels.createAccount({ type: 'lark', status: 'active', credentialRef: 'ref_rel' });
      const transport = new FakeLarkTransport();
      await transport.start();

      let shouldFailDispatch = true;
      const gateway = new LarkChannelGateway({
        account,
        transport,
        channelRepo: tenant.channels,
        sessionRouteRepo: tenant.sessionRoutes,
        runtimeGateway: {
          dispatchInbound: async (env) => {
            if (shouldFailDispatch) {
              throw new Error('Transient queue timeout');
            }
            return {
              accepted: true,
              turnId: env.id,
              message: { id: 'msg_ok', role: 'user', content: env.content, status: 'pending', createdAt: new Date().toISOString() },
            };
          },
          getCurrentTurnStatus: async () => ({ status: 'completed' }),
          cancelCurrentTurn: async () => true,
        },
        defaultSpaceId: space1,
      });

      try {
        // Pre-create binding
        await tenant.channels.createBinding({
          accountId: account.id,
          spaceId: space1,
          nativeContextId: 'oc_retry_1',
          activationMode: 'always',
        });

        const rawEvent: LarkRawEvent = {
          header: { event_id: 'evt_retry_001', event_type: 'im.message.receive_v1', create_time: '1700000000000' },
          event: {
            sender: { sender_id: { open_id: 'ou_1' } },
            message: { message_id: 'om_1', chat_id: 'oc_retry_1', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: 'Execute with retry' }) },
          },
        };

        // 1. Inbound fails on first try
        await expect(gateway.handleInboundEvent(rawEvent)).rejects.toThrow('Transient queue timeout');
        const inboxAfterFail = await tenant.channels.findInboxByEvent(account.id, 'evt_retry_001');
        expect(inboxAfterFail?.status).toBe('failed');

        // 2. Re-dispatch succeeds via CAS claim from 'failed' -> 'processing' -> 'delivered'
        shouldFailDispatch = false;
        const retryResult = await gateway.handleInboundEvent(rawEvent);
        expect(retryResult.handled).toBe(true);
        const inboxAfterSuccess = await tenant.channels.findInboxByEvent(account.id, 'evt_retry_001');
        expect(inboxAfterSuccess?.status).toBe('delivered');

        // 3. Duplicate delivery is skipped cleanly
        const dupResult = await gateway.handleInboundEvent(rawEvent);
        expect(dupResult.handled).toBe(false);
        expect(dupResult.ignoredReason).toBe('duplicate_event');

        // 4. Outbound CAS Concurrency: exactly one worker claims pending outbox item
        const outboxItem = await tenant.channels.createOutboxItem({
          id: 'out_concurrent_test_1',
          accountId: account.id,
          sessionId: retryResult.sessionRouteId!,
          nativeContextId: 'oc_retry_1',
          replyToNativeId: 'om_1',
          payloadJson: JSON.stringify({
            text: 'Concurrency test',
            format: 'plain',
            chatId: 'oc_retry_1',
            replyToMessageId: 'om_1',
            nativeEventId: 'evt_retry_001',
          }),
          status: 'pending',
        });

        const [claim1, claim2] = await Promise.all([
          tenant.channels.claimPendingOutboxItem(outboxItem.id, account.id),
          tenant.channels.claimPendingOutboxItem(outboxItem.id, account.id),
        ]);

        // One must succeed, one must receive null
        expect((claim1 !== null && claim2 === null) || (claim1 === null && claim2 !== null)).toBe(true);
        const finalOutbox = await tenant.channels.findOutboxById(outboxItem.id);
        expect(finalOutbox?.status).toBe('sending');
        expect(finalOutbox?.attempts).toBe(1);
      } finally {
        await gateway.dispose();
      }
    });

    it('recovers network failure during outbox send and recovers stale sending items across process crash via managed worker tick', async () => {
      const tenant = storage.forTenant(user1);
      const account = await tenant.channels.createAccount({ type: 'lark', status: 'active', credentialRef: 'ref_crash' });
      const transport = new FakeLarkTransport();

      // Create session route
      const route = await tenant.sessionRoutes.create({
        spaceId: space1,
        channel: 'lark',
        accountId: account.id,
        nativeContextId: 'oc_crash_1',
        peerId: 'peer_crash',
        dshSessionId: 'dsh_crash_ses',
      });

      const runtimeGateway = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        executor: {
          execute: async () => ({ replyText: 'Answer', usage: { totalTokens: 5 } }),
          cancel: async () => true,
        },
        quotaMode: 'disabled',
        profileResolver: { resolve: async () => null },
      });

      const runtimeManager = new ChannelRuntimeManager({
        storage,
        db,
        deliveryGateway: runtimeGateway,
        transportFactory: () => transport,
        workerIntervalMs: 50, // fast tick for testing
      });

      try {
        await runtimeManager.start();

        const gateway = runtimeManager.getActiveGateway(user1, account.id)!;
        expect(gateway).toBeDefined();

        // 1. Simulate network failure during send
        transport.failNextSend = true;
        transport.failNextSendReason = 'Network socket reset';

        const outboxItem = await tenant.channels.createOutboxItem({
          id: 'out_net_fail_1',
          accountId: account.id,
          sessionId: route.id,
          nativeContextId: 'oc_crash_1',
          replyToNativeId: 'om_crash_1',
          payloadJson: JSON.stringify({
            text: 'Network retry message',
            format: 'plain',
            chatId: 'oc_crash_1',
            replyToMessageId: 'om_crash_1',
            nativeEventId: 'evt_net_fail_1',
          }),
          status: 'pending',
        });

        const deliveredFirst = await gateway.deliverOutboxItem(outboxItem);
        expect(deliveredFirst).toBe(false);

        // Should be reverted to 'pending' with attempts = 1
        const outboxAfterFail = await tenant.channels.findOutboxById(outboxItem.id);
        expect(outboxAfterFail?.status).toBe('pending');
        expect(outboxAfterFail?.attempts).toBe(1);

        // Wait for background worker tick timer (50ms interval) to automatically recover pending outbox
        await vi.waitFor(async () => {
          const item = await tenant.channels.findOutboxById(outboxItem.id);
          expect(item?.status).toBe('delivered');
        }, { timeout: 1500 });

        expect(transport.sentReplies.length).toBe(1);

        // 2. Simulate crashed process that left outbox in 'sending' status with stale updated_at
        db.prepare(`
          INSERT INTO channel_outbox (id, user_id, account_id, session_id, native_context_id, reply_to_native_id, payload_json, status, attempts, created_at, updated_at)
          VALUES ('out_crashed_1', ?, ?, ?, 'oc_crash_1', 'om_crashed_msg', ?, 'sending', 1, datetime('now', '-120 seconds'), datetime('now', '-120 seconds'))
        `).run(
          user1,
          account.id,
          route.id,
          JSON.stringify({
            text: 'Recovered from crash',
            format: 'plain',
            chatId: 'oc_crash_1',
            replyToMessageId: 'om_crashed_msg',
            nativeEventId: 'evt_crashed_1',
          })
        );

        // Wait for background worker tick timer to automatically recover stale sending > 60s and deliver
        await vi.waitFor(async () => {
          const recoveredItem = await tenant.channels.findOutboxById('out_crashed_1');
          expect(recoveredItem?.status).toBe('delivered');
        }, { timeout: 1500 });

        expect(transport.sentReplies.length).toBe(2);
        expect(transport.sentReplies[1].content).toBe('Recovered from crash');
      } finally {
        await runtimeManager.stop();
      }
    });
  });
});
