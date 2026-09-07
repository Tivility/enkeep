/**
 * Production Lark Channel End-to-End Wiring Acceptance Test.
 *
 * Verifies genuine PlatformServer + DeliveryRuntimeGateway + bootDshRuntime (AgentLoop + DeterministicDemoLlmAdapter)
 * with CredentialedLarkTransport + SDK ClientFactory mock boundary.
 *
 * @module @enkeep/platform-server/tests/lark-production-wiring.test
 */

import { describe, it, expect, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import {
  PlatformServer,
  DeliveryRuntimeGateway,
  SqliteWebMessageStore,
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  SqliteStreamEventSource,
  ChannelRuntimeManager,
  type DeliveryExecutionRequest,
  type TenantQuotaProvider,
  type QuotaReservationRequest,
} from '../src/index.js';
import { validateDeliveryId, DELIVERY_ID_REGEX } from '@enkeep/platform-operations';
import {
  CredentialedLarkTransport,
  FakeLarkTransport,
  type LarkSdkClientFactory,
  type LarkCredentialResolver,
  type ILarkApiClient,
  type ILarkWSClient,
} from '../../channel-lark/src/index.js';
import {
  bootDshRuntime,
  type DshBootedRuntime,
} from '../../runtime-runner/src/index.js';

describe('Production Lark Channel Wiring & Runtime End-to-End Acceptance', () => {
  it('executes genuine DSH Agent turn from Lark event, verifies outbox delivery, multi-turn session routing, and web dispatch isolation', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-lark-e2e-'));
    const dshHome = path.join(tmpDir, 'alice', '.dsh');
    const spacesDir = path.join(tmpDir, 'alice', 'spaces');

    const userId = 'usr_alice_lark_test';
    const spaceId = 'spc_alice_lark_main';
    const accountCredentialRef = 'cred_lark_alice_prod';
    const chatId = 'oc_lark_group_channel_001';
    const botAppId = 'cli_lark_app_test_001';
    const botOpenId = 'ou_bot_app_test_001';

    let db: DatabaseSync | null = null;
    let storage: SqlitePlatformStorage | null = null;
    let messageStore: SqliteWebMessageStore | null = null;
    let dshRuntime: DshBootedRuntime | null = null;
    let deliveryGateway: DeliveryRuntimeGateway | null = null;
    let server: PlatformServer | null = null;

    try {
      // 1. Initialize in-memory SQLite database and apply all platform migrations
      db = new DatabaseSync(':memory:');
      const migrationRunner = new PlatformServerMigrationRunner(db);
      await migrationRunner.migrate(ALL_PLATFORM_MIGRATIONS);

      // Seed tenant user and space
      db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'alice_lark', 'hashed_pw')`).run(userId);
      db.prepare(`INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES (?, ?, 'Alice Lark Space', 'alice-space', 'container')`).run(spaceId, userId);

      storage = new SqlitePlatformStorage(db);
      messageStore = new SqliteWebMessageStore(db);

      const tenant = storage.forTenant(userId);

      // 2. Create active Lark channel account and binding
      const account = await tenant.channels.createAccount({
        type: 'lark',
        status: 'active',
        credentialRef: accountCredentialRef,
      });

      await tenant.channels.createBinding({
        accountId: account.id,
        spaceId,
        nativeContextId: chatId,
        activationMode: 'always',
      });

      // 3. Boot genuine DSH Runtime (Cordis context, AgentLoop, DeterministicDemoLlmAdapter, SessionStore, JSONL persistence)
      dshRuntime = await bootDshRuntime({
        userId,
        dshHome,
        spacesDir,
        llmEnabled: false,
      });

      const runtimeHealth = await dshRuntime.getHealth();
      expect(runtimeHealth.status).toBe('ok');
      expect(runtimeHealth.dshReady).toBe(true);
      expect(runtimeHealth.enkeepBundleLoaded).toBe(true);

      // 4. Construct DeliveryRuntimeGateway delegating execution to genuine DSH runtime
      deliveryGateway = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        executor: {
          execute: async (req: DeliveryExecutionRequest) => {
            const result = await dshRuntime!.sendFollowup(req.content, req.dshSessionId, req.turnId);
            return {
              replyText: result.replyText || '',
              usage: result.usage ?? { totalTokens: 30 },
            };
          },
          cancel: async (_cancelUserId, cancelSessionId) => {
            return dshRuntime!.cancelTurn(cancelSessionId);
          },
        },
        quotaMode: 'disabled',
        profileResolver: {
          resolve: async () => null,
        },
      });

      // 5. Setup Lark Mock Boundary (SDK Client & WSClient Factory + Credential Resolver)
      const sentReplies: Array<{
        method: 'reply' | 'create';
        path?: any;
        params?: any;
        data?: any;
      }> = [];
      let capturedEventDispatcher: any = null;
      let wsConnectionState: 'idle' | 'connected' | 'disconnected' = 'idle';

      const mockClientFactory: LarkSdkClientFactory = {
        createClient: (_opts): ILarkApiClient => ({
          im: {
            message: {
              reply: async (req: any) => {
                sentReplies.push({ method: 'reply', path: req.path, params: req.params, data: req.data });
                return {
                  code: 0,
                  data: {
                    message_id: `om_sdk_reply_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                  },
                };
              },
              create: async (req: any) => {
                sentReplies.push({ method: 'create', params: req.params, data: req.data });
                return {
                  code: 0,
                  data: {
                    message_id: `om_sdk_create_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                  },
                };
              },
            },
          },
        }),
        createWSClient: (opts): ILarkWSClient => {
          const wsMock: ILarkWSClient & { onReady?: () => void; onError?: (err: Error) => void } = {
            onReady: opts?.onReady,
            onError: opts?.onError,
            getConnectionStatus: () => ({
              state: wsConnectionState,
            }),
            start: async ({ eventDispatcher }: { eventDispatcher: any }) => {
              capturedEventDispatcher = eventDispatcher;
              wsConnectionState = 'connected';
              if (wsMock.onReady) {
                wsMock.onReady();
              }
            },
            close: async () => {
              wsConnectionState = 'disconnected';
              if (wsMock.onError) {
                wsMock.onError(new Error('WS connection closed'));
              }
            },
          };
          return wsMock;
        },
      };

      const larkCredentialResolver: LarkCredentialResolver = {
        resolve: async (uId, credRef) => {
          if (uId === userId && credRef === accountCredentialRef) {
            return {
              appId: botAppId,
              appSecret: 'sec_test_secret_value',
              domain: 'feishu',
              botOpenId,
            };
          }
          return null;
        },
      };

      // 6. Instantiate and start PlatformServer with CredentialedLarkTransport + SDK ClientFactory
      server = new PlatformServer({
        database: db,
        host: '127.0.0.1',
        port: 0,
        cookieSecret: 'test-secret-at-least-32-chars-long!',
        csrfToken: 'test-csrf-token-at-least-32-chars-long!',
        storage,
        runtimeGateway: deliveryGateway,
        larkCredentialResolver,
        larkTransportFactory: (acc, resolver) => {
          return new CredentialedLarkTransport({
            account: {
              id: acc.id,
              userId: acc.userId,
              credentialRef: acc.credentialRef,
            },
            credentialResolver: resolver,
            clientFactory: mockClientFactory,
          });
        },
      });

      await server.start();

      expect(server.channelRuntimeManager).toBeDefined();
      expect(server.channelRuntimeManager?.running).toBe(true);
      expect(server.channelRuntimeManager?.activeGatewayCount).toBe(1);
      expect(capturedEventDispatcher).toBeDefined();

      // ──────────────────────────────────────────────────────────────────────────
      // TURN 1: Inbound Lark Message via SDK EventDispatcher.invoke (Schema 2.0)
      // ──────────────────────────────────────────────────────────────────────────
      const inboundMsgId1 = 'om_human_prompt_001';
      const promptText1 = 'Explain TCP handshake step by step';

      await capturedEventDispatcher.invoke({
        schema: '2.0',
        header: {
          event_id: 'evt_lark_inbound_001',
          event_type: 'im.message.receive_v1',
          create_time: '1700000000000',
        },
        event: {
          sender: {
            sender_id: { open_id: 'ou_client_human_001' },
            sender_type: 'user',
          },
          message: {
            message_id: inboundMsgId1,
            chat_id: chatId,
            chat_type: 'group',
            message_type: 'text',
            content: JSON.stringify({ text: promptText1 }),
            create_time: '1700000000000',
          },
        },
      });

      // Wait for Agent execution and Outbox delivery to complete
      await vi.waitFor(() => expect(sentReplies.length).toBe(1), { timeout: 10000 });

      // Verification 1: Outbound reply was sent through SDK reply method with correct native reply_to target
      const reply1 = sentReplies[0];
      expect(reply1.method).toBe('reply');
      expect(reply1.path?.message_id).toBe(inboundMsgId1);

      // Verification 2: Reply content != user prompt, generated by genuine DSH Agent
      const reply1Data = JSON.parse(reply1.data?.content || '{}');
      expect(reply1Data.text).toBeDefined();
      expect(reply1Data.text).not.toBe(promptText1);
      expect(reply1Data.text).toContain(`[DemoModel:${userId}]`);

      // Verification 3: Platform web_messages does NOT pollute reply_to_message_id with native om_ ID
      const routeAfterTurn1 = await tenant.sessionRoutes.findByRouteIdentity('lark', account.id, chatId);
      expect(routeAfterTurn1).not.toBeNull();
      const sessionRouteId = routeAfterTurn1!.id;

      const listTurn1 = await messageStore.listMessages(userId, sessionRouteId);
      const messagesTurn1 = listTurn1.messages;
      expect(messagesTurn1.length).toBe(2); // 1 user + 1 assistant
      expect(messagesTurn1[0].role).toBe('user');
      expect(messagesTurn1[0].content).toBe(promptText1);
      expect(messagesTurn1[0].replyReference).toBeUndefined();
      expect(messagesTurn1[1].role).toBe('assistant');
      expect(messagesTurn1[1].content).toBe(reply1Data.text);

      // Verification 4: Channel outbox record in SQLite is marked 'delivered'
      const outboxRowsTurn1 = db.prepare('SELECT * FROM channel_outbox WHERE account_id = ?').all(account.id) as Array<{
        status: string;
        reply_to_native_id: string;
      }>;
      expect(outboxRowsTurn1.length).toBe(1);
      expect(outboxRowsTurn1[0].status).toBe('delivered');
      expect(outboxRowsTurn1[0].reply_to_native_id).toBe(inboundMsgId1);

      // ──────────────────────────────────────────────────────────────────────────
      // TURN 2: Multi-Turn Conversation within the SAME Lark Chat / Session
      // ──────────────────────────────────────────────────────────────────────────
      const inboundMsgId2 = 'om_human_prompt_002';
      const promptText2 = 'Summarize what we discussed';

      await capturedEventDispatcher.invoke({
        schema: '2.0',
        header: {
          event_id: 'evt_lark_inbound_002',
          event_type: 'im.message.receive_v1',
          create_time: '1700000005000',
        },
        event: {
          sender: {
            sender_id: { open_id: 'ou_client_human_001' },
            sender_type: 'user',
          },
          message: {
            message_id: inboundMsgId2,
            chat_id: chatId,
            chat_type: 'group',
            message_type: 'text',
            content: JSON.stringify({ text: promptText2 }),
            create_time: '1700000005000',
          },
        },
      });

      await vi.waitFor(() => expect(sentReplies.length).toBe(2), { timeout: 10000 });

      const reply2 = sentReplies[1];
      expect(reply2.method).toBe('reply');
      expect(reply2.path?.message_id).toBe(inboundMsgId2);

      const reply2Data = JSON.parse(reply2.data?.content || '{}');
      expect(reply2Data.text).toBeDefined();
      expect(reply2Data.text).not.toBe(promptText2);

      // Verification 5: Same session route maintained and chronological order preserved
      const routeAfterTurn2 = await tenant.sessionRoutes.findByRouteIdentity('lark', account.id, chatId);
      expect(routeAfterTurn2).not.toBeNull();
      expect(routeAfterTurn2!.id).toBe(sessionRouteId);

      const allRoutes = await tenant.sessionRoutes.list();
      expect(allRoutes.length).toBe(1);

      const listTurn2 = await messageStore.listMessages(userId, sessionRouteId);
      const messagesTurn2 = listTurn2.messages;
      expect(messagesTurn2.length).toBe(4); // 2 user + 2 assistant in chronological order
      expect(messagesTurn2[0].content).toBe(promptText1);
      expect(messagesTurn2[1].content).toBe(reply1Data.text);
      expect(messagesTurn2[2].content).toBe(promptText2);
      expect(messagesTurn2[3].content).toBe(reply2Data.text);

      const outboxRowsTurn2 = db.prepare('SELECT * FROM channel_outbox WHERE account_id = ?').all(account.id) as Array<{
        status: string;
        reply_to_native_id: string;
      }>;
      expect(outboxRowsTurn2.length).toBe(2);
      expect(outboxRowsTurn2[1].status).toBe('delivered');
      expect(outboxRowsTurn2[1].reply_to_native_id).toBe(inboundMsgId2);

      // ──────────────────────────────────────────────────────────────────────────
      // TURN 3: Manual Web Inbound Dispatch to the SAME Session (No Lark Outbox)
      // ──────────────────────────────────────────────────────────────────────────
      const webDeliveryId = 'del_web_manual_turn_001';
      const webPromptText = 'Instruction injected directly from Web Console';

      const webDispatchResult = await deliveryGateway.dispatchInbound({
        id: webDeliveryId,
        userId,
        sessionId: sessionRouteId,
        content: webPromptText,
        timestamp: new Date().toISOString(),
      });
      expect(webDispatchResult.accepted).toBe(true);

      // Wait for turn execution to complete in message store (6 messages: 3 user + 3 assistant)
      await vi.waitFor(async () => {
        const listWeb = await messageStore!.listMessages(userId, sessionRouteId);
        expect(listWeb.messages.length).toBe(6);
      }, { timeout: 10000 });

      // Verification 6: Sent Lark replies did NOT increase (manual Web turns do NOT leak to Lark)
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(sentReplies.length).toBe(2);

      const outboxRowsAfterWeb = db.prepare('SELECT * FROM channel_outbox WHERE account_id = ?').all(account.id);
      expect(outboxRowsAfterWeb.length).toBe(2);
    } finally {
      // Clean up Platform, Gateway, DSH Runtime, and temp filesystem resources
      if (server) {
        try {
          await server.stop();
        } catch {}
      }
      if (dshRuntime) {
        try {
          await dshRuntime.dispose();
        } catch {}
      }
      if (db) {
        try {
          db.close();
        } catch {}
      }
      if (fs.existsSync(tmpDir)) {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {}
      }
    }
  });

  it('recovers un-outboxed committed turns across manager restart via startup SQLite scan without in-memory hooks and prevents duplicate outbox deliveries on subsequent scans', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-lark-recovery-'));
    const dshHome = path.join(tmpDir, 'bob', '.dsh');
    const spacesDir = path.join(tmpDir, 'bob', 'spaces');

    const userId = 'usr_bob_recovery_test';
    const spaceId = 'spc_bob_recovery_main';
    const accountCredentialRef = 'cred_lark_bob_recovery';
    const chatId = 'oc_lark_recovery_channel_001';
    const botAppId = 'cli_lark_recovery_app_001';
    const botOpenId = 'ou_bot_recovery_001';

    let db: DatabaseSync | null = null;
    let storage: SqlitePlatformStorage | null = null;
    let messageStore: SqliteWebMessageStore | null = null;
    let dshRuntime: DshBootedRuntime | null = null;
    let deliveryGateway: DeliveryRuntimeGateway | null = null;
    let server1: PlatformServer | null = null;
    let server2: PlatformServer | null = null;

    try {
      // 1. Initialize in-memory SQLite database and apply migrations
      db = new DatabaseSync(':memory:');
      const migrationRunner = new PlatformServerMigrationRunner(db);
      await migrationRunner.migrate(ALL_PLATFORM_MIGRATIONS);

      // Seed tenant user and space
      db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'bob_recovery', 'hashed_pw')`).run(userId);
      db.prepare(`INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES (?, ?, 'Bob Recovery Space', 'bob-space', 'container')`).run(spaceId, userId);

      storage = new SqlitePlatformStorage(db);
      messageStore = new SqliteWebMessageStore(db);

      const tenant = storage.forTenant(userId);

      // 2. Create active Lark channel account and binding
      const account = await tenant.channels.createAccount({
        type: 'lark',
        status: 'active',
        credentialRef: accountCredentialRef,
      });

      await tenant.channels.createBinding({
        accountId: account.id,
        spaceId,
        nativeContextId: chatId,
        activationMode: 'always',
      });

      // 3. Boot genuine DSH Runtime
      dshRuntime = await bootDshRuntime({
        userId,
        dshHome,
        spacesDir,
        llmEnabled: false,
      });

      // 4. Construct DeliveryRuntimeGateway with deferred executor gate to simulate manager crash mid-execution
      let turnExecutionStarted = false;
      let resumeExecutorSignal: () => void = () => {};
      const deferredGate = new Promise<void>((resolve) => {
        resumeExecutorSignal = resolve;
      });
      let pauseExecutor = true;

      deliveryGateway = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        executor: {
          execute: async (req: DeliveryExecutionRequest) => {
            if (pauseExecutor) {
              turnExecutionStarted = true;
              await deferredGate;
            }
            const result = await dshRuntime!.sendFollowup(req.content, req.dshSessionId, req.turnId);
            return {
              replyText: result.replyText || '',
              usage: result.usage ?? { totalTokens: 25 },
            };
          },
          cancel: async (_cancelUserId, cancelSessionId) => {
            return dshRuntime!.cancelTurn(cancelSessionId);
          },
        },
        quotaMode: 'disabled',
        profileResolver: {
          resolve: async () => null,
        },
      });

      const larkCredentialResolver: LarkCredentialResolver = {
        resolve: async (uId, credRef) => {
          if (uId === userId && credRef === accountCredentialRef) {
            return {
              appId: botAppId,
              appSecret: 'sec_recovery_secret',
              domain: 'feishu',
              botOpenId,
            };
          }
          return null;
        },
      };

      // 5. Start Server 1 with mock client factory capturing eventDispatcher
      const sentReplies1: Array<{ method: 'reply' | 'create'; path?: any; data?: any }> = [];
      let capturedEventDispatcher1: any = null;

      const mockClientFactory1: LarkSdkClientFactory = {
        createClient: (_opts): ILarkApiClient => ({
          im: {
            message: {
              reply: async (req: any) => {
                sentReplies1.push({ method: 'reply', path: req.path, data: req.data });
                return { code: 0, data: { message_id: `om_reply_srv1_${Date.now()}` } };
              },
              create: async (req: any) => {
                sentReplies1.push({ method: 'create', data: req.data });
                return { code: 0, data: { message_id: `om_create_srv1_${Date.now()}` } };
              },
            },
          },
        }),
        createWSClient: (opts): ILarkWSClient => {
          let wsState: 'idle' | 'connected' | 'disconnected' = 'idle';
          const wsMock: ILarkWSClient = {
            getConnectionStatus: () => ({ state: wsState }),
            start: async ({ eventDispatcher }: { eventDispatcher: any }) => {
              capturedEventDispatcher1 = eventDispatcher;
              wsState = 'connected';
              opts?.onReady?.();
            },
            close: async () => {
              wsState = 'disconnected';
            },
          };
          return wsMock;
        },
      };

      server1 = new PlatformServer({
        database: db,
        host: '127.0.0.1',
        port: 0,
        cookieSecret: 'test-secret-at-least-32-chars-long!',
        csrfToken: 'test-csrf-token-at-least-32-chars-long!',
        storage,
        runtimeGateway: deliveryGateway,
        larkCredentialResolver,
        larkTransportFactory: (acc, resolver) => {
          return new CredentialedLarkTransport({
            account: {
              id: acc.id,
              userId: acc.userId,
              credentialRef: acc.credentialRef,
            },
            credentialResolver: resolver,
            clientFactory: mockClientFactory1,
          });
        },
      });

      await server1.start();
      expect(server1.channelRuntimeManager?.running).toBe(true);
      expect(capturedEventDispatcher1).toBeDefined();

      // 6. Ingest real inbound Lark message through SDK EventDispatcher while executor gate is active
      const nativeMsgId = 'om_recovery_inbound_prompt_001';
      const recoveryPrompt = 'Explain memory leak detection in Node.js';

      await capturedEventDispatcher1.invoke({
        schema: '2.0',
        header: {
          event_id: 'evt_recovery_001',
          event_type: 'im.message.receive_v1',
          create_time: '1700000000000',
        },
        event: {
          sender: {
            sender_id: { open_id: 'ou_client_bob' },
            sender_type: 'user',
          },
          message: {
            message_id: nativeMsgId,
            chat_id: chatId,
            chat_type: 'group',
            message_type: 'text',
            content: JSON.stringify({ text: recoveryPrompt }),
            create_time: '1700000000000',
          },
        },
      });

      // Wait for executor to reach paused gate
      await vi.waitFor(() => expect(turnExecutionStarted).toBe(true), { timeout: 5000 });

      // Stop server 1's channel runtime manager to tear down in-memory turn completion listeners
      await server1.channelRuntimeManager?.stop();
      expect(server1.channelRuntimeManager?.running).toBe(false);

      // Now resume executor so genuine DSH Agent finishes execution without in-memory delivery hooks
      pauseExecutor = false;
      resumeExecutorSignal();

      // Wait for genuine DSH Agent execution to complete and commit assistant row in web_messages
      const sessionRoute = await tenant.sessionRoutes.findByRouteIdentity('lark', account.id, chatId);
      expect(sessionRoute).not.toBeNull();

      await vi.waitFor(async () => {
        const list = await messageStore!.listMessages(userId, sessionRoute!.id);
        expect(list.messages.length).toBe(2); // 1 user + 1 assistant committed
      }, { timeout: 10000 });

      // Backdate created_at to simulate restart recovery after server downtime (>15 seconds ago)
      db.prepare("UPDATE web_messages SET created_at = datetime('now', '-20 seconds') WHERE session_id = ?").run(sessionRoute!.id);

      // Verify that because manager was stopped, NO memory hook triggered and NO outbox row exists yet
      expect(sentReplies1.length).toBe(0);
      const outboxBeforeRestart = db.prepare('SELECT * FROM channel_outbox WHERE account_id = ?').all(account.id);
      expect(outboxBeforeRestart.length).toBe(0);

      // 7. Boot a brand new Server 2 / ChannelRuntimeManager on the same SQLite database
      const sentReplies2: Array<{ method: 'reply' | 'create'; path?: any; data?: any }> = [];
      const mockClientFactory2: LarkSdkClientFactory = {
        createClient: (_opts): ILarkApiClient => ({
          im: {
            message: {
              reply: async (req: any) => {
                sentReplies2.push({ method: 'reply', path: req.path, data: req.data });
                return { code: 0, data: { message_id: `om_reply_srv2_${Date.now()}` } };
              },
              create: async (req: any) => {
                sentReplies2.push({ method: 'create', data: req.data });
                return { code: 0, data: { message_id: `om_create_srv2_${Date.now()}` } };
              },
            },
          },
        }),
        createWSClient: (opts): ILarkWSClient => {
          let wsState: 'idle' | 'connected' | 'disconnected' = 'idle';
          const wsMock: ILarkWSClient = {
            getConnectionStatus: () => ({ state: wsState }),
            start: async () => {
              wsState = 'connected';
              opts?.onReady?.();
            },
            close: async () => {
              wsState = 'disconnected';
            },
          };
          return wsMock;
        },
      };

      server2 = new PlatformServer({
        database: db,
        host: '127.0.0.1',
        port: 0,
        cookieSecret: 'test-secret-at-least-32-chars-long!',
        csrfToken: 'test-csrf-token-at-least-32-chars-long!',
        storage,
        runtimeGateway: deliveryGateway,
        larkCredentialResolver,
        larkTransportFactory: (acc, resolver) => {
          return new CredentialedLarkTransport({
            account: {
              id: acc.id,
              userId: acc.userId,
              credentialRef: acc.credentialRef,
            },
            credentialResolver: resolver,
            clientFactory: mockClientFactory2,
          });
        },
      });

      // Starting Server 2 automatically triggers scanAndReconcileCommittedTurns() from SQLite
      await server2.start();
      expect(server2.channelRuntimeManager?.running).toBe(true);

      // Wait for startup scan to detect the un-outboxed committed turn and deliver it to Lark SDK
      await vi.waitFor(() => expect(sentReplies2.length).toBe(1), { timeout: 10000 });

      // Verification 1: Outbound reply was delivered with exact native reply_to target
      expect(sentReplies2[0].method).toBe('reply');
      expect(sentReplies2[0].path?.message_id).toBe(nativeMsgId);

      // Verification 2: Outbox content is the genuine DSH assistant reply, not user prompt
      const replyData = JSON.parse(sentReplies2[0].data?.content || '{}');
      expect(replyData.text).toBeDefined();
      expect(replyData.text).not.toBe(recoveryPrompt);
      expect(replyData.text).toContain(`[DemoModel:${userId}]`);

      // Verification 3: Outbox record exists in SQLite marked as 'delivered'
      const outboxAfterRestart = db.prepare('SELECT * FROM channel_outbox WHERE account_id = ?').all(account.id) as Array<{
        status: string;
        reply_to_native_id: string;
      }>;
      expect(outboxAfterRestart.length).toBe(1);
      expect(outboxAfterRestart[0].status).toBe('delivered');
      expect(outboxAfterRestart[0].reply_to_native_id).toBe(nativeMsgId);

      // Verification 4: Duplicate scan idempotency - re-running scan does NOT produce additional deliveries
      await server2.channelRuntimeManager?.scanAndReconcileCommittedTurns();
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(sentReplies2.length).toBe(1);
      const outboxAfterRescan = db.prepare('SELECT * FROM channel_outbox WHERE account_id = ?').all(account.id);
      expect(outboxAfterRescan.length).toBe(1);
    } finally {
      if (server1) {
        try {
          await server1.stop();
        } catch {}
      }
      if (server2) {
        try {
          await server2.stop();
        } catch {}
      }
      if (dshRuntime) {
        try {
          await dshRuntime.dispose();
        } catch {}
      }
      if (db) {
        try {
          db.close();
        } catch {}
      }
      if (fs.existsSync(tmpDir)) {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {}
      }
    }
  });

  it('processes inbound Lark event with quotaMode: enforced and quota provider validating deliveryId format', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-lark-quota-'));
    const dshHome = path.join(tmpDir, 'charlie', '.dsh');
    const spacesDir = path.join(tmpDir, 'charlie', 'spaces');

    const userId = 'usr_charlie_lark_quota';
    const spaceId = 'spc_charlie_lark_main';
    const accountCredentialRef = 'cred_lark_charlie_quota';
    const chatId = 'oc_lark_quota_channel_001';
    const botAppId = 'cli_lark_quota_app_001';
    const botOpenId = 'ou_bot_quota_001';

    let db: DatabaseSync | null = null;
    let storage: SqlitePlatformStorage | null = null;
    let messageStore: SqliteWebMessageStore | null = null;
    let dshRuntime: DshBootedRuntime | null = null;
    let deliveryGateway: DeliveryRuntimeGateway | null = null;
    let server: PlatformServer | null = null;

    try {
      // 1. Initialize in-memory SQLite database and apply migrations
      db = new DatabaseSync(':memory:');
      const migrationRunner = new PlatformServerMigrationRunner(db);
      await migrationRunner.migrate(ALL_PLATFORM_MIGRATIONS);

      // Seed tenant user and space
      db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'charlie_lark', 'hashed_pw')`).run(userId);
      db.prepare(`INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES (?, ?, 'Charlie Lark Space', 'charlie-space', 'container')`).run(spaceId, userId);

      storage = new SqlitePlatformStorage(db);
      messageStore = new SqliteWebMessageStore(db);

      const tenant = storage.forTenant(userId);

      // 2. Create active Lark channel account and binding
      const account = await tenant.channels.createAccount({
        type: 'lark',
        status: 'active',
        credentialRef: accountCredentialRef,
      });

      await tenant.channels.createBinding({
        accountId: account.id,
        spaceId,
        nativeContextId: chatId,
        activationMode: 'always',
      });

      // 3. Boot genuine DSH Runtime
      dshRuntime = await bootDshRuntime({
        userId,
        dshHome,
        spacesDir,
        llmEnabled: false,
      });

      // 4. Construct enforced QuotaProvider that validates deliveryId format (reusing pattern from delivery-gateway-reconcile-and-quota.test.ts)
      let reserveCalls = 0;
      const quotaProvider: TenantQuotaProvider = {
        reserve: async (req: QuotaReservationRequest) => {
          reserveCalls++;
          validateDeliveryId(req.deliveryId);
          return {
            reservationId: `res_quota_${reserveCalls}`,
            userId: req.userId,
            turns: req.turns,
            messages: req.messages,
            tokens: req.tokens,
            isEstimateTokens: req.isEstimateTokens,
            commit: async () => {},
            release: async () => {},
            renew: async () => {},
            commitInTransaction: () => {},
            releaseInTransaction: () => {},
          };
        },
      };

      // 5. Construct DeliveryRuntimeGateway with quotaMode: 'enforced'
      deliveryGateway = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        executor: {
          execute: async (req: DeliveryExecutionRequest) => {
            const result = await dshRuntime!.sendFollowup(req.content, req.dshSessionId, req.turnId);
            return {
              replyText: result.replyText || '',
              usage: result.usage ?? { totalTokens: 30 },
            };
          },
          cancel: async (_cancelUserId, cancelSessionId) => {
            return dshRuntime!.cancelTurn(cancelSessionId);
          },
        },
        quotaMode: 'enforced',
        quotaProvider,
        profileResolver: {
          resolve: async () => null,
        },
      });

      // 6. Setup Lark Mock Boundary
      const sentReplies: Array<{
        method: 'reply' | 'create';
        path?: any;
        params?: any;
        data?: any;
      }> = [];
      let capturedEventDispatcher: any = null;
      let wsConnectionState: 'idle' | 'connected' | 'disconnected' = 'idle';

      const mockClientFactory: LarkSdkClientFactory = {
        createClient: (_opts): ILarkApiClient => ({
          im: {
            message: {
              reply: async (req: any) => {
                sentReplies.push({ method: 'reply', path: req.path, params: req.params, data: req.data });
                return {
                  code: 0,
                  data: {
                    message_id: `om_sdk_reply_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                  },
                };
              },
              create: async (req: any) => {
                sentReplies.push({ method: 'create', params: req.params, data: req.data });
                return {
                  code: 0,
                  data: {
                    message_id: `om_sdk_create_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                  },
                };
              },
            },
          },
        }),
        createWSClient: (opts): ILarkWSClient => {
          const wsMock: ILarkWSClient & { onReady?: () => void; onError?: (err: Error) => void } = {
            onReady: opts?.onReady,
            onError: opts?.onError,
            getConnectionStatus: () => ({
              state: wsConnectionState,
            }),
            start: async ({ eventDispatcher }: { eventDispatcher: any }) => {
              capturedEventDispatcher = eventDispatcher;
              wsConnectionState = 'connected';
              if (wsMock.onReady) {
                wsMock.onReady();
              }
            },
            close: async () => {
              wsConnectionState = 'disconnected';
              if (wsMock.onError) {
                wsMock.onError(new Error('WS connection closed'));
              }
            },
          };
          return wsMock;
        },
      };

      const larkCredentialResolver: LarkCredentialResolver = {
        resolve: async (uId, credRef) => {
          if (uId === userId && credRef === accountCredentialRef) {
            return {
              appId: botAppId,
              appSecret: 'sec_test_secret_value',
              domain: 'feishu',
              botOpenId,
            };
          }
          return null;
        },
      };

      server = new PlatformServer({
        database: db,
        host: '127.0.0.1',
        port: 0,
        cookieSecret: 'test-secret-at-least-32-chars-long!',
        csrfToken: 'test-csrf-token-at-least-32-chars-long!',
        storage,
        runtimeGateway: deliveryGateway,
        larkCredentialResolver,
        larkTransportFactory: (acc, resolver) => {
          return new CredentialedLarkTransport({
            account: {
              id: acc.id,
              userId: acc.userId,
              credentialRef: acc.credentialRef,
            },
            credentialResolver: resolver,
            clientFactory: mockClientFactory,
          });
        },
      });

      await server.start();
      expect(capturedEventDispatcher).toBeDefined();

      // 7. Dispatch inbound Lark event with nativeEventId
      const nativeEventId = 'evt_lark_quota_inbound_001';
      const inboundMsgId = 'om_quota_prompt_001';
      const promptText = 'Test Lark message under enforced quota mode';
      const expectedIdempotencyKey = `idem_lark_${account.id}_${nativeEventId}`;

      await capturedEventDispatcher.invoke({
        schema: '2.0',
        header: {
          event_id: nativeEventId,
          event_type: 'im.message.receive_v1',
          create_time: '1700000010000',
        },
        event: {
          sender: {
            sender_id: { open_id: 'ou_client_human_001' },
            sender_type: 'user',
          },
          message: {
            message_id: inboundMsgId,
            chat_id: chatId,
            chat_type: 'group',
            message_type: 'text',
            content: JSON.stringify({ text: promptText }),
            create_time: '1700000010000',
          },
        },
      });

      // Wait for Agent execution and Outbox delivery to complete
      await vi.waitFor(() => expect(sentReplies.length).toBe(1), { timeout: 10000 });

      // Verification 1: Quota reservation was invoked
      expect(reserveCalls).toBeGreaterThanOrEqual(1);

      // Verification 2: turn_runs row is NOT failed (completed)
      const turnRuns = db.prepare('SELECT * FROM turn_runs WHERE user_id = ?').all(userId) as Array<{
        status: string;
        error: string | null;
      }>;
      expect(turnRuns.length).toBe(1);
      expect(turnRuns[0].status).not.toBe('failed');
      expect(turnRuns[0].status).toBe('completed');

      // Verification 3: delivery_inbox.delivery_id matches canonical deliv_ format
      const inboxRows = db.prepare('SELECT * FROM delivery_inbox WHERE user_id = ?').all(userId) as Array<{
        delivery_id: string;
        status: string;
      }>;
      expect(inboxRows.length).toBe(1);
      expect(inboxRows[0].delivery_id).toMatch(DELIVERY_ID_REGEX);

      // Verification 4: idempotency_records idempotency_key is still the idem_lark_... value
      const idemRows = db.prepare('SELECT * FROM idempotency_records WHERE user_id = ?').all(userId) as Array<{
        idempotency_key: string;
        delivery_id: string;
      }>;
      expect(idemRows.length).toBe(1);
      expect(idemRows[0].idempotency_key).toBe(expectedIdempotencyKey);

      // Verification 5: channel_outbox row is created for the reply
      const outboxRows = db.prepare('SELECT * FROM channel_outbox WHERE account_id = ?').all(account.id) as Array<{
        status: string;
        reply_to_native_id: string;
      }>;
      expect(outboxRows.length).toBe(1);
      expect(outboxRows[0].status).toBe('delivered');
      expect(outboxRows[0].reply_to_native_id).toBe(inboundMsgId);
    } finally {
      if (server) {
        try {
          await server.stop();
        } catch {}
      }
      if (dshRuntime) {
        try {
          await dshRuntime.dispose();
        } catch {}
      }
      if (db) {
        try {
          db.close();
        } catch {}
      }
      if (fs.existsSync(tmpDir)) {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {}
      }
    }
  });

  it('handles turn execution failure, firing onTurnFailed listener and delivering sanitized error reply to Lark while cleaning reactions', async () => {
    const userId = 'usr_bob_lark_fail_test';
    const spaceId = 'spc_bob_lark_fail';
    const accountCredentialRef = 'cred_lark_bob_prod';
    const chatId = 'oc_lark_fail_group_001';
    const botAppId = 'cli_lark_app_fail_001';
    const botOpenId = 'ou_bot_app_fail_001';

    let db: DatabaseSync | null = null;
    let storage: SqlitePlatformStorage | null = null;
    let messageStore: SqliteWebMessageStore | null = null;
    let deliveryGateway: DeliveryRuntimeGateway | null = null;
    let server: PlatformServer | null = null;

    try {
      db = new DatabaseSync(':memory:');
      const migrationRunner = new PlatformServerMigrationRunner(db);
      await migrationRunner.migrate(ALL_PLATFORM_MIGRATIONS);

      db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'bob_lark', 'hashed_pw')`).run(userId);
      db.prepare(`INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES (?, ?, 'Bob Lark Space', 'bob-space', 'container')`).run(spaceId, userId);

      storage = new SqlitePlatformStorage(db);
      messageStore = new SqliteWebMessageStore(db);

      const tenant = storage.forTenant(userId);

      const account = await tenant.channels.createAccount({
        type: 'lark',
        status: 'active',
        credentialRef: accountCredentialRef,
      });

      await tenant.channels.createBinding({
        accountId: account.id,
        spaceId,
        nativeContextId: chatId,
        activationMode: 'always',
      });

      // Executor that throws an error to simulate turn failure
      deliveryGateway = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        executor: {
          execute: async () => {
            throw new Error('Sandbox container execution crashed unexpectedly');
          },
          cancel: async () => true,
        },
        quotaMode: 'disabled',
        profileResolver: {
          resolve: async () => null,
        },
      });

      // Track onTurnFailed listener invocation
      let capturedFailureEvent: any = null;
      deliveryGateway.onTurnFailed((ev) => {
        capturedFailureEvent = ev;
      });

      // Setup Lark Mock Boundary with messageReaction support
      const sentReplies: Array<{
        method: 'reply' | 'create';
        path?: any;
        params?: any;
        data?: any;
      }> = [];
      const createdReactions: Array<{ message_id: string; emoji_type: string }> = [];
      const deletedReactions: Array<{ message_id: string; reaction_id: string }> = [];

      let capturedEventDispatcher: any = null;
      let wsConnectionState: 'idle' | 'connected' | 'disconnected' = 'idle';

      const mockClientFactory: LarkSdkClientFactory = {
        createClient: (): ILarkApiClient => ({
          im: {
            message: {
              reply: async (req: any) => {
                sentReplies.push({ method: 'reply', path: req.path, params: req.params, data: req.data });
                return {
                  code: 0,
                  data: {
                    message_id: `om_sdk_reply_err_${Date.now()}`,
                  },
                };
              },
              create: async (req: any) => {
                sentReplies.push({ method: 'create', params: req.params, data: req.data });
                return {
                  code: 0,
                  data: {
                    message_id: `om_sdk_create_err_${Date.now()}`,
                  },
                };
              },
            },
            messageReaction: {
              create: async (req: any) => {
                createdReactions.push({
                  message_id: req.path.message_id,
                  emoji_type: req.data?.reaction_type?.emoji_type,
                });
                return {
                  code: 0,
                  data: {
                    reaction_id: `rx_fail_test_${Date.now()}`,
                  },
                };
              },
              delete: async (req: any) => {
                deletedReactions.push({
                  message_id: req.path.message_id,
                  reaction_id: req.path.reaction_id,
                });
                return { code: 0 };
              },
            },
          },
        }),
        createWSClient: (opts): ILarkWSClient => {
          const wsMock: ILarkWSClient & { onReady?: () => void; onError?: (err: Error) => void } = {
            onReady: opts?.onReady,
            onError: opts?.onError,
            getConnectionStatus: () => ({
              state: wsConnectionState,
            }),
            start: async ({ eventDispatcher }: { eventDispatcher: any }) => {
              capturedEventDispatcher = eventDispatcher;
              wsConnectionState = 'connected';
              if (wsMock.onReady) {
                wsMock.onReady();
              }
            },
            close: async () => {
              wsConnectionState = 'disconnected';
              if (wsMock.onError) {
                wsMock.onError(new Error('WS connection closed'));
              }
            },
          };
          return wsMock;
        },
      };

      const larkCredentialResolver: LarkCredentialResolver = {
        resolve: async (uId, credRef) => {
          if (uId === userId && credRef === accountCredentialRef) {
            return {
              appId: botAppId,
              appSecret: 'sec_test_secret_bob',
              domain: 'feishu',
              botOpenId,
            };
          }
          return null;
        },
      };

      server = new PlatformServer({
        database: db,
        host: '127.0.0.1',
        port: 0,
        cookieSecret: 'test-secret-at-least-32-chars-long!',
        csrfToken: 'test-csrf-token-at-least-32-chars-long!',
        storage,
        runtimeGateway: deliveryGateway,
        larkCredentialResolver,
        larkTransportFactory: (acc, resolver) => {
          return new CredentialedLarkTransport({
            account: {
              id: acc.id,
              userId: acc.userId,
              credentialRef: acc.credentialRef,
            },
            credentialResolver: resolver,
            clientFactory: mockClientFactory,
          });
        },
      });

      await server.start();
      expect(capturedEventDispatcher).toBeDefined();

      const nativeEventId = 'evt_lark_failing_inbound_001';
      const inboundMsgId = 'om_failing_prompt_001';

      // Dispatch inbound event to trigger execution failure
      await capturedEventDispatcher.invoke({
        schema: '2.0',
        header: {
          event_id: nativeEventId,
          event_type: 'im.message.receive_v1',
          create_time: '1700000020000',
        },
        event: {
          sender: {
            sender_id: { open_id: 'ou_failing_client_001' },
            sender_type: 'user',
          },
          message: {
            message_id: inboundMsgId,
            chat_id: chatId,
            chat_type: 'group',
            message_type: 'text',
            content: JSON.stringify({ text: 'This turn will crash' }),
            create_time: '1700000020000',
          },
        },
      });

      // Wait for error reply delivery to complete
      await vi.waitFor(() => expect(sentReplies.length).toBe(1), { timeout: 10000 });

      // Verification 1: turnFailed listener fired with proper event details
      expect(capturedFailureEvent).not.toBeNull();
      expect(capturedFailureEvent.userId).toBe(userId);
      expect(capturedFailureEvent.code).toBe('EXECUTION_FAILED');
      expect(capturedFailureEvent.reason).toBe('Turn execution failed');

      // Verification 2: OnIt reaction was created upon claim
      expect(createdReactions.length).toBe(1);
      expect(createdReactions[0].message_id).toBe(inboundMsgId);
      expect(createdReactions[0].emoji_type).toBe('OnIt');

      // Verification 3: OnIt reaction was cleaned up (removeReaction called)
      await vi.waitFor(() => expect(deletedReactions.length).toBe(1), { timeout: 5000 });
      expect(deletedReactions[0].message_id).toBe(inboundMsgId);

      // Verification 4: Sanitized plain-text error reply was sent to Lark
      expect(sentReplies[0].method).toBe('reply');
      expect(sentReplies[0].path.message_id).toBe(inboundMsgId);
      const replyData = JSON.parse(sentReplies[0].data.content);
      expect(replyData.text).toBe('处理失败，请稍后重试。');

      // Verification 5: Channel outbox record exists and was delivered
      const outboxRows = db.prepare('SELECT * FROM channel_outbox WHERE account_id = ?').all(account.id) as Array<{
        status: string;
        payload_json: string;
        reply_to_native_id: string;
      }>;
      expect(outboxRows.length).toBe(1);
      expect(outboxRows[0].status).toBe('delivered');
      expect(outboxRows[0].reply_to_native_id).toBe(inboundMsgId);
      const outboxPayload = JSON.parse(outboxRows[0].payload_json);
      expect(outboxPayload.text).toBe('处理失败，请稍后重试。');
    } finally {
      if (server) {
        try {
          await server.stop();
        } catch {}
      }
      if (db) {
        try {
          db.close();
        } catch {}
      }
    }
  });

  it('streams assistant deltas into web_events, pushes to active streaming card session, and delivers outbox row directly with markdown format', async () => {
    const userId = 'usr_carol_lark_stream';
    const spaceId = 'spc_carol_lark_stream';
    const accountCredentialRef = 'cred_lark_carol_prod';
    const chatId = 'oc_lark_stream_group_001';

    let db: DatabaseSync | null = null;
    let storage: SqlitePlatformStorage | null = null;
    let messageStore: SqliteWebMessageStore | null = null;
    let deliveryGateway: DeliveryRuntimeGateway | null = null;
    let server: PlatformServer | null = null;

    try {
      db = new DatabaseSync(':memory:');
      const migrationRunner = new PlatformServerMigrationRunner(db);
      await migrationRunner.migrate(ALL_PLATFORM_MIGRATIONS);

      db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'carol_lark', 'hashed_pw')`).run(userId);
      db.prepare(`INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES (?, ?, 'Carol Lark Space', 'carol-space', 'container')`).run(spaceId, userId);

      storage = new SqlitePlatformStorage(db);
      messageStore = new SqliteWebMessageStore(db);

      const tenant = storage.forTenant(userId);

      const account = await tenant.channels.createAccount({
        type: 'lark',
        status: 'active',
        credentialRef: accountCredentialRef,
      });

      await tenant.channels.createBinding({
        accountId: account.id,
        spaceId,
        nativeContextId: chatId,
        activationMode: 'always',
      });

      const fakeTransport = new FakeLarkTransport();

      // Executor that writes 2 assistant_delta rows and 1 assistant_stream_end row into web_events
      deliveryGateway = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        executor: {
          execute: async (req: DeliveryExecutionRequest) => {
            const streamId = 'strm_fake_1';
            const routeId = req.envelope.sessionId;
            // Simulate streaming execution time so tracker polls while running
            await new Promise((resolve) => setTimeout(resolve, 600));
            // Insert 2 assistant_delta rows
            db!.prepare(`
              INSERT INTO web_events (id, session_id, user_id, type, payload, created_at)
              VALUES (?, ?, ?, 'assistant_delta', ?, CURRENT_TIMESTAMP)
            `).run('evt_delta_1', routeId, userId, JSON.stringify({ streamId, delta: 'Hello, ', accumulatedLength: 7 }));

            db!.prepare(`
              INSERT INTO web_events (id, session_id, user_id, type, payload, created_at)
              VALUES (?, ?, ?, 'assistant_delta', ?, CURRENT_TIMESTAMP)
            `).run('evt_delta_2', routeId, userId, JSON.stringify({ streamId, delta: 'streaming world!', accumulatedLength: 23 }));

            // Insert assistant_stream_end row
            db!.prepare(`
              INSERT INTO web_events (id, session_id, user_id, type, payload, created_at)
              VALUES (?, ?, ?, 'assistant_stream_end', ?, CURRENT_TIMESTAMP)
            `).run('evt_stream_end_1', routeId, userId, JSON.stringify({ streamId }));

            return {
              replyText: 'Hello, streaming world!',
              usage: { totalTokens: 15 },
            };
          },
          cancel: async () => true,
        },
        quotaMode: 'disabled',
        profileResolver: {
          resolve: async () => null,
        },
      });

      const channelRuntimeManager = new ChannelRuntimeManager({
        storage,
        db,
        deliveryGateway,
        transportFactory: () => fakeTransport,
        streamEventSource: new SqliteStreamEventSource(db),
        workerIntervalMs: 50,
      });

      server = new PlatformServer({
        database: db,
        host: '127.0.0.1',
        port: 0,
        cookieSecret: 'test-secret-at-least-32-chars-long!',
        csrfToken: 'test-csrf-token-at-least-32-chars-long!',
        storage,
        runtimeGateway: deliveryGateway,
        channelRuntimeManager,
      });

      await server.start();

      expect(server.channelRuntimeManager).toBeDefined();
      expect(server.channelRuntimeManager?.running).toBe(true);

      const inboundMsgId = 'om_carol_stream_001';
      const promptText = 'Tell me a streaming story';

      // Send inbound event directly to the active gateway registered in server.channelRuntimeManager
      const gateway = server.channelRuntimeManager?.getActiveGateway(userId, account.id)!;
      expect(gateway).toBeDefined();

      const inRes = await gateway.handleInboundEvent({
        header: {
          event_id: 'evt_lark_stream_wiring_001',
          event_type: 'im.message.receive_v1',
          create_time: '1700000030000',
        },
        event: {
          sender: {
            sender_id: { open_id: 'ou_carol_human_001' },
            sender_type: 'user',
          },
          message: {
            message_id: inboundMsgId,
            chat_id: chatId,
            chat_type: 'group',
            message_type: 'text',
            content: JSON.stringify({ text: promptText }),
            create_time: '1700000030000',
          },
        },
      });

      expect(inRes.handled).toBe(true);

      // Drain delivery gateway execution
      await deliveryGateway.drain();

      // Wait for streaming calls and finalize to complete on fakeTransport
      await vi.waitFor(() => {
        expect(fakeTransport.streamingCalls.length).toBeGreaterThanOrEqual(3);
        const lastCall = fakeTransport.streamingCalls[fakeTransport.streamingCalls.length - 1];
        expect(lastCall.type).toBe('finalize');
      }, { timeout: 10000 });

      // Verification: Fake transport recorded card_create + >=1 push + finalize
      const calls = fakeTransport.streamingCalls;
      expect(calls[0].type).toBe('card_create');
      expect(calls[0].params.chatId).toBe(chatId);
      expect(calls[0].params.replyToMessageId).toBe(inboundMsgId);

      const pushCalls = calls.filter((c) => c.type === 'push');
      expect(pushCalls.length).toBeGreaterThanOrEqual(1);
      expect(pushCalls[pushCalls.length - 1].content).toBe('Hello, streaming world!');

      const finalizeCall = calls[calls.length - 1];
      expect(finalizeCall.type).toBe('finalize');
      expect(finalizeCall.status).toBe('completed');
      expect(finalizeCall.content).toBe('Hello, streaming world!');

      // Exactly ONE delivered outbox row in SQLite
      const outboxRows = db.prepare('SELECT * FROM channel_outbox WHERE account_id = ?').all(account.id) as Array<{
        status: string;
        payload_json: string;
        reply_to_native_id: string;
      }>;
      expect(outboxRows.length).toBe(1);
      expect(outboxRows[0].status).toBe('delivered');
      expect(outboxRows[0].reply_to_native_id).toBe(inboundMsgId);

      const outboxPayload = JSON.parse(outboxRows[0].payload_json);
      expect(outboxPayload.format).toBe('markdown');
      expect(outboxPayload.messageId).toBe(finalizeCall.messageId);
      expect(outboxPayload.text).toBe('Hello, streaming world!');

      // NO standard plain-text sendReply calls on fakeTransport
      expect(fakeTransport.sentReplies.length).toBe(0);
    } finally {
      if (server) {
        try {
          await server.stop();
        } catch {}
      }
      if (db) {
        try {
          db.close();
        } catch {}
      }
    }
  });

  it('delivers autonomous follow-up turn as a second streaming card and outbox row after initial turn completion', async () => {
    const userId = 'usr_carol_lark_followup';
    const spaceId = 'spc_carol_lark_followup';
    const accountCredentialRef = 'cred_lark_carol_followup';
    const chatId = 'oc_lark_followup_group_001';

    let db: DatabaseSync | null = null;
    let storage: SqlitePlatformStorage | null = null;
    let messageStore: SqliteWebMessageStore | null = null;
    let deliveryGateway: DeliveryRuntimeGateway | null = null;
    let server: PlatformServer | null = null;

    try {
      db = new DatabaseSync(':memory:');
      const migrationRunner = new PlatformServerMigrationRunner(db);
      await migrationRunner.migrate(ALL_PLATFORM_MIGRATIONS);

      db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'carol_lark_followup', 'hashed_pw')`).run(userId);
      db.prepare(`INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES (?, ?, 'Carol Followup Space', 'carol-space', 'container')`).run(spaceId, userId);

      storage = new SqlitePlatformStorage(db);
      messageStore = new SqliteWebMessageStore(db);

      const tenant = storage.forTenant(userId);

      const account = await tenant.channels.createAccount({
        type: 'lark',
        status: 'active',
        credentialRef: accountCredentialRef,
      });

      await tenant.channels.createBinding({
        accountId: account.id,
        spaceId,
        nativeContextId: chatId,
        activationMode: 'always',
      });

      const fakeTransport = new FakeLarkTransport();

      deliveryGateway = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        executor: {
          execute: async (req: DeliveryExecutionRequest) => {
            const streamId = 'strm_fake_turn1';
            const routeId = req.envelope.sessionId;
            // Simulate streaming execution time so tracker polls while running
            await new Promise((resolve) => setTimeout(resolve, 600));
            db!.prepare(`
              INSERT INTO web_events (id, session_id, user_id, type, payload, created_at)
              VALUES (?, ?, ?, 'assistant_delta', ?, CURRENT_TIMESTAMP)
            `).run('evt_delta_t1', routeId, userId, JSON.stringify({ streamId, delta: 'Starting background tasks...', accumulatedLength: 29 }));

            db!.prepare(`
              INSERT INTO web_events (id, session_id, user_id, type, payload, created_at)
              VALUES (?, ?, ?, 'assistant_stream_end', ?, CURRENT_TIMESTAMP)
            `).run('evt_end_t1', routeId, userId, JSON.stringify({ streamId }));

            return {
              replyText: 'Starting background tasks...',
              usage: { totalTokens: 10 },
            };
          },
          cancel: async () => true,
        },
        quotaMode: 'disabled',
        profileResolver: {
          resolve: async () => null,
        },
      });

      server = new PlatformServer({
        database: db,
        host: '127.0.0.1',
        port: 0,
        cookieSecret: 'test-secret-at-least-32-chars-long!',
        csrfToken: 'test-csrf-token-at-least-32-chars-long!',
        storage,
        runtimeGateway: deliveryGateway,
        larkTransportFactory: () => fakeTransport,
        streamEventSource: new SqliteStreamEventSource(db),
      });

      await server.start();

      const gateway = server.channelRuntimeManager?.getActiveGateway(userId, account.id)!;
      expect(gateway).toBeDefined();

      const inboundMsgId = 'om_carol_turn1_msg';
      const inRes = await gateway.handleInboundEvent({
        header: {
          event_id: 'evt_lark_stream_wiring_followup',
          event_type: 'im.message.receive_v1',
          create_time: '1700000040000',
        },
        event: {
          sender: {
            sender_id: { open_id: 'ou_carol_human_followup' },
            sender_type: 'user',
          },
          message: {
            message_id: inboundMsgId,
            chat_id: chatId,
            chat_type: 'group',
            message_type: 'text',
            content: JSON.stringify({ text: 'Run subagent task' }),
            create_time: '1700000040000',
          },
        },
      });

      expect(inRes.handled).toBe(true);
      const sessionRouteId = inRes.sessionRouteId!;

      // Drain delivery gateway turn 1 execution
      await deliveryGateway.drain();

      // Wait for turn 1 card finalize
      await vi.waitFor(() => {
        const finalizes = fakeTransport.streamingCalls.filter((c) => c.type === 'finalize');
        expect(finalizes.length).toBe(1);
      }, { timeout: 10000 });

      // Check first card outbox item (main turn delivered as markdown card, not plain)
      const outboxAfterTurn1 = db.prepare('SELECT * FROM channel_outbox WHERE account_id = ?').all(account.id) as Array<{
        status: string;
        payload_json: string;
      }>;
      expect(outboxAfterTurn1.length).toBe(1);
      expect(outboxAfterTurn1[0].status).toBe('delivered');
      const turn1Payload = JSON.parse(outboxAfterTurn1[0].payload_json);
      expect(turn1Payload.format).toBe('markdown');
      expect(turn1Payload.messageId).toBe(fakeTransport.streamingCalls.find((c) => c.type === 'finalize')?.messageId);

      // Now simulate two consecutive autonomous follow-up turns (e.g. subagent finished, then post-cleanup)
      const followupStreamId1 = 'strm_fake_followup_subagent_1';
      db.prepare(`
        INSERT INTO web_events (id, session_id, user_id, type, payload, created_at)
        VALUES (?, ?, ?, 'turn_status', ?, CURRENT_TIMESTAMP)
      `).run('evt_followup_run_1', sessionRouteId, userId, JSON.stringify({ status: 'running' }));

      db.prepare(`
        INSERT INTO web_events (id, session_id, user_id, type, payload, created_at)
        VALUES (?, ?, ?, 'assistant_delta', ?, CURRENT_TIMESTAMP)
      `).run('evt_followup_delta_1', sessionRouteId, userId, JSON.stringify({ streamId: followupStreamId1, delta: 'All 3 subagents finished. Final summary: Success!' }));

      db.prepare(`
        INSERT INTO web_events (id, session_id, user_id, type, payload, created_at)
        VALUES (?, ?, ?, 'assistant_stream_end', ?, CURRENT_TIMESTAMP)
      `).run('evt_followup_end_1', sessionRouteId, userId, JSON.stringify({ streamId: followupStreamId1 }));

      db.prepare(`
        INSERT INTO web_events (id, session_id, user_id, type, payload, created_at)
        VALUES (?, ?, ?, 'turn_status', ?, CURRENT_TIMESTAMP)
      `).run('evt_followup_comp_1', sessionRouteId, userId, JSON.stringify({ status: 'completed' }));

      // Follow-up 2 (second consecutive follow-up turn)
      const followupStreamId2 = 'strm_fake_followup_subagent_2';
      db.prepare(`
        INSERT INTO web_events (id, session_id, user_id, type, payload, created_at)
        VALUES (?, ?, ?, 'turn_status', ?, CURRENT_TIMESTAMP)
      `).run('evt_followup_run_2', sessionRouteId, userId, JSON.stringify({ status: 'running' }));

      db.prepare(`
        INSERT INTO web_events (id, session_id, user_id, type, payload, created_at)
        VALUES (?, ?, ?, 'assistant_delta', ?, CURRENT_TIMESTAMP)
      `).run('evt_followup_delta_2', sessionRouteId, userId, JSON.stringify({ streamId: followupStreamId2, delta: 'Post-completion autonomous cleanup done.' }));

      db.prepare(`
        INSERT INTO web_events (id, session_id, user_id, type, payload, created_at)
        VALUES (?, ?, ?, 'assistant_stream_end', ?, CURRENT_TIMESTAMP)
      `).run('evt_followup_end_2', sessionRouteId, userId, JSON.stringify({ streamId: followupStreamId2 }));

      db.prepare(`
        INSERT INTO web_events (id, session_id, user_id, type, payload, created_at)
        VALUES (?, ?, ?, 'turn_status', ?, CURRENT_TIMESTAMP)
      `).run('evt_followup_comp_2', sessionRouteId, userId, JSON.stringify({ status: 'completed' }));

      // Wait for all 3 streaming cards (main + 2 follow-ups) to be created, pushed, and finalized
      await vi.waitFor(() => {
        const finalizes = fakeTransport.streamingCalls.filter((c) => c.type === 'finalize');
        expect(finalizes.length).toBe(3);
      }, { timeout: 10000 });

      // Verify 3 card creates
      const cardCreates = fakeTransport.streamingCalls.filter((c) => c.type === 'card_create');
      expect(cardCreates.length).toBe(3);
      expect(cardCreates[1].params.chatId).toBe(chatId);
      expect(cardCreates[1].params.replyToMessageId).toBe(inboundMsgId);
      expect(cardCreates[2].params.chatId).toBe(chatId);
      expect(cardCreates[2].params.replyToMessageId).toBe(inboundMsgId);

      const finalizes = fakeTransport.streamingCalls.filter((c) => c.type === 'finalize');
      expect(finalizes[1].status).toBe('completed');
      expect(finalizes[1].content).toBe('All 3 subagents finished. Final summary: Success!');
      expect(finalizes[2].status).toBe('completed');
      expect(finalizes[2].content).toBe('Post-completion autonomous cleanup done.');

      // Exactly 3 delivered outbox rows in SQLite channel_outbox (main + 2 follow-ups)
      const outboxAfterFollowup = db.prepare('SELECT rowid, * FROM channel_outbox WHERE account_id = ? ORDER BY rowid ASC').all(account.id) as Array<{
        status: string;
        payload_json: string;
        reply_to_native_id: string;
      }>;
      expect(outboxAfterFollowup.length).toBe(3);

      // Main turn
      expect(outboxAfterFollowup[0].status).toBe('delivered');
      const mainPayload = JSON.parse(outboxAfterFollowup[0].payload_json);
      expect(mainPayload.format).toBe('markdown');
      expect(mainPayload.messageId).toBe(finalizes[0].messageId);

      // Follow-up 1
      expect(outboxAfterFollowup[1].status).toBe('delivered');
      expect(outboxAfterFollowup[1].reply_to_native_id).toBe(inboundMsgId);
      const followup1Payload = JSON.parse(outboxAfterFollowup[1].payload_json);
      expect(followup1Payload.format).toBe('markdown');
      expect(followup1Payload.messageId).toBe(finalizes[1].messageId);
      expect(followup1Payload.text).toBe('All 3 subagents finished. Final summary: Success!');

      // Follow-up 2
      expect(outboxAfterFollowup[2].status).toBe('delivered');
      expect(outboxAfterFollowup[2].reply_to_native_id).toBe(inboundMsgId);
      const followup2Payload = JSON.parse(outboxAfterFollowup[2].payload_json);
      expect(followup2Payload.format).toBe('markdown');
      expect(followup2Payload.messageId).toBe(finalizes[2].messageId);
      expect(followup2Payload.text).toBe('Post-completion autonomous cleanup done.');
    } finally {
      if (server) {
        try {
          await server.stop();
        } catch {}
      }
      if (db) {
        try {
          db.close();
        } catch {}
      }
    }
  });

  it('delivers two back-to-back inbound messages on same route without duplicate continuation card', async () => {
    const userId = 'usr_btb_lark';
    const spaceId = 'spc_btb_lark';
    const accountCredentialRef = 'cred_lark_btb';
    const chatId = 'oc_lark_btb_group';

    let db: DatabaseSync | null = null;
    let storage: SqlitePlatformStorage | null = null;
    let messageStore: SqliteWebMessageStore | null = null;
    let deliveryGateway: DeliveryRuntimeGateway | null = null;
    let server: PlatformServer | null = null;

    try {
      db = new DatabaseSync(':memory:');
      const migrationRunner = new PlatformServerMigrationRunner(db);
      await migrationRunner.migrate(ALL_PLATFORM_MIGRATIONS);

      db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'btb_lark', 'hashed_pw')`).run(userId);
      db.prepare(`INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES (?, ?, 'BTB Space', 'btb-space', 'container')`).run(spaceId, userId);

      storage = new SqlitePlatformStorage(db);
      messageStore = new SqliteWebMessageStore(db);

      const tenant = storage.forTenant(userId);

      const account = await tenant.channels.createAccount({
        type: 'lark',
        status: 'active',
        credentialRef: accountCredentialRef,
      });

      await tenant.channels.createBinding({
        accountId: account.id,
        spaceId,
        nativeContextId: chatId,
        activationMode: 'always',
      });

      const fakeTransport = new FakeLarkTransport();

      let turnCount = 0;
      let turn1Finished = false;
      let card2CreatedAt: string | undefined;

      deliveryGateway = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        executor: {
          execute: async (req: DeliveryExecutionRequest) => {
            turnCount++;
            const currentTurn = turnCount;
            const streamId = `strm_fake_btb_${currentTurn}`;
            const routeId = req.envelope.sessionId;
            const replyText = currentTurn === 1 ? 'Reply for turn 1' : 'Reply for turn 2';

            if (currentTurn === 1) {
              // Simulate real-world execution delay for turn 1 (tracker polls at 500ms)
              await new Promise((resolve) => setTimeout(resolve, 600));
            } else if (currentTurn === 2) {
              // Allow tracker 2 to poll while turn 2 is running (pollIntervalMs is 500ms)
              await new Promise((resolve) => setTimeout(resolve, 600));
            }

            db!.prepare(`
              INSERT INTO web_events (id, session_id, user_id, type, payload, created_at)
              VALUES (?, ?, ?, 'assistant_delta', ?, CURRENT_TIMESTAMP)
            `).run(`evt_btb_delta_${currentTurn}`, routeId, userId, JSON.stringify({ streamId, delta: replyText }));

            db!.prepare(`
              INSERT INTO web_events (id, session_id, user_id, type, payload, created_at)
              VALUES (?, ?, ?, 'assistant_stream_end', ?, CURRENT_TIMESTAMP)
            `).run(`evt_btb_end_${currentTurn}`, routeId, userId, JSON.stringify({ streamId }));

            if (currentTurn === 1) {
              turn1Finished = true;
            }

            return {
              replyText,
              usage: { totalTokens: 10 },
            };
          },
          cancel: async () => true,
        },
        quotaMode: 'disabled',
        profileResolver: {
          resolve: async () => null,
        },
      });

      server = new PlatformServer({
        database: db,
        host: '127.0.0.1',
        port: 0,
        cookieSecret: 'test-secret-at-least-32-chars-long!',
        csrfToken: 'test-csrf-token-at-least-32-chars-long!',
        storage,
        runtimeGateway: deliveryGateway,
        larkTransportFactory: () => fakeTransport,
        streamEventSource: new SqliteStreamEventSource(db),
      });

      await server.start();

      const gateway = server.channelRuntimeManager?.getActiveGateway(userId, account.id)!;
      expect(gateway).toBeDefined();

      // Dispatch message 1
      const inRes1 = await gateway.handleInboundEvent({
        header: {
          event_id: 'evt_lark_btb_1',
          event_type: 'im.message.receive_v1',
          create_time: '1700000050000',
        },
        event: {
          sender: { sender_id: { open_id: 'ou_btb_user' }, sender_type: 'user' },
          message: {
            message_id: 'om_btb_msg_1',
            chat_id: chatId,
            chat_type: 'group',
            message_type: 'text',
            content: JSON.stringify({ text: 'Message 1' }),
            create_time: '1700000050000',
          },
        },
      });
      expect(inRes1.handled).toBe(true);

      // Immediately dispatch message 2 back-to-back on same chat (turn 2 is queued behind turn 1)
      const inRes2 = await gateway.handleInboundEvent({
        header: {
          event_id: 'evt_lark_btb_2',
          event_type: 'im.message.receive_v1',
          create_time: '1700000052000',
        },
        event: {
          sender: { sender_id: { open_id: 'ou_btb_user' }, sender_type: 'user' },
          message: {
            message_id: 'om_btb_msg_2',
            chat_id: chatId,
            chat_type: 'group',
            message_type: 'text',
            content: JSON.stringify({ text: 'Message 2' }),
            create_time: '1700000052000',
          },
        },
      });
      expect(inRes2.handled).toBe(true);

      // Turn 2 is queued behind turn 1
      const turn2Row = db.prepare('SELECT status FROM turn_runs WHERE turn_id = ?').get(inRes2.turnId!) as { status: string } | undefined;
      expect(turn2Row?.status).toBe('queued');

      // Wait for all processing to complete
      await deliveryGateway.drain();

      // Wait for both streaming cards to finalize
      await vi.waitFor(() => {
        const finalizes = fakeTransport.streamingCalls.filter((c) => c.type === 'finalize');
        expect(finalizes.length).toBe(2);
      }, { timeout: 10000 });

      // Verify exactly 2 card creations
      const cardCreates = fakeTransport.streamingCalls.filter((c) => c.type === 'card_create');
      expect(cardCreates.length).toBe(2);

      // Card 2 was created only after turn 1 finished
      expect(turn1Finished).toBe(true);
      const finalizes = fakeTransport.streamingCalls.filter((c) => c.type === 'finalize');
      expect(finalizes[0].content).toBe('Reply for turn 1');
      expect(finalizes[1].content).toBe('Reply for turn 2');

      // Check card 2's pushText: card 2's first push contains turn 2's text, not turn 1's
      const card2Id = cardCreates[1].cardId;
      const pushes = fakeTransport.streamingCalls.filter((c) => c.type === 'push');
      const card2Pushes = pushes.filter((p) => p.cardId === card2Id);
      expect(card2Pushes.length).toBeGreaterThanOrEqual(1);
      expect(card2Pushes[0].content).toContain('Reply for turn 2');
      expect(card2Pushes[0].content).not.toContain('Reply for turn 1');

      // Exactly TWO outbox rows total in SQLite channel_outbox (both markdown, no continuation duplicate)
      const outboxRows = db.prepare('SELECT rowid, * FROM channel_outbox WHERE account_id = ? ORDER BY rowid ASC').all(account.id) as Array<{
        status: string;
        payload_json: string;
      }>;
      expect(outboxRows.length).toBe(2);
      expect(outboxRows[0].status).toBe('delivered');
      expect(outboxRows[1].status).toBe('delivered');

      const payload1 = JSON.parse(outboxRows[0].payload_json);
      expect(payload1.format).toBe('markdown');
      expect(payload1.text).toBe('Reply for turn 1');

      const payload2 = JSON.parse(outboxRows[1].payload_json);
      expect(payload2.format).toBe('markdown');
      expect(payload2.text).toBe('Reply for turn 2');
    } finally {
      if (server) {
        try {
          await server.stop();
        } catch {}
      }
      if (db) {
        try {
          db.close();
        } catch {}
      }
    }
  });
});
