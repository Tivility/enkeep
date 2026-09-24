/**
 * WeChat Channel Runtime & End-to-End Wiring Acceptance Tests
 *
 * Verifies complete WeChat runtime flow against a local fake iLink HTTP server:
 * - Enable account -> poll inbound text/image -> channel_inbox -> turn -> outbound reply with cached context_token
 * - Cursor persisted and resumed across restarts
 * - Disable account stops polling immediately
 * - -14 session expired marks account needs re-login without crashing
 * - Single-poller concurrency guard prevents duplicate pollers
 *
 * @module @enkeep/platform-server/tests/wechat-runtime.test
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  SqliteWebMessageStore,
} from '../src/index.js';
import { DeliveryRuntimeGateway, type DeliveryExecutionRequest } from '../src/runtime/delivery-gateway.js';
import {
  WeChatRuntimeManager,
  type WeChatResolvedCredentials,
} from '../src/channels/wechat-runtime.js';
import { CredentialedWeChatTransport } from '../../../channel-wechat/dist/index.js';

interface FakeServerRequestRecord {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

class FakeILinkServer {
  private server?: http.Server;
  private port = 0;
  readonly getUpdatesRequests: FakeServerRequestRecord[] = [];
  readonly sendMessages: FakeServerRequestRecord[] = [];
  readonly queuedUpdatesResponses: Array<{ ret?: number; errcode?: number; errmsg?: string; msgs?: any[]; get_updates_buf?: string }> = [];
  returnSessionExpired = false;

  async start(): Promise<string> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        let bodyRaw = '';
        req.on('data', (chunk) => {
          bodyRaw += chunk;
        });

        req.on('end', () => {
          let bodyJson: any = null;
          try {
            if (bodyRaw) bodyJson = JSON.parse(bodyRaw);
          } catch {}

          const record: FakeServerRequestRecord = {
            method: req.method || 'GET',
            url: req.url || '/',
            headers: req.headers,
            body: bodyJson,
          };

          if (req.url?.startsWith('/ilink/bot/getupdates')) {
            this.getUpdatesRequests.push(record);

            if (this.returnSessionExpired) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ret: -14, errcode: -14, errmsg: 'session expired' }));
              return;
            }

            if (this.queuedUpdatesResponses.length > 0) {
              const resp = this.queuedUpdatesResponses.shift()!;
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  ret: resp.ret ?? 0,
                  errcode: resp.errcode ?? 0,
                  errmsg: resp.errmsg ?? 'ok',
                  msgs: resp.msgs ?? [],
                  get_updates_buf: resp.get_updates_buf ?? bodyJson?.get_updates_buf ?? '',
                  longpolling_timeout_ms: 50,
                })
              );
              return;
            }

            // Default empty long-poll response with realistic delay
            setTimeout(() => {
              if (res.writableEnded) return;
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  ret: 0,
                  errcode: 0,
                  errmsg: 'ok',
                  msgs: [],
                  get_updates_buf: bodyJson?.get_updates_buf ?? '',
                  longpolling_timeout_ms: 50,
                })
              );
            }, 20);
            return;
          }

          if (req.url?.startsWith('/ilink/bot/sendmessage')) {
            this.sendMessages.push(record);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                ret: 0,
                errcode: 0,
                errmsg: 'ok',
                msg: { message_id: 88888 },
              })
            );
            return;
          }

          if (req.url?.startsWith('/ilink/bot/getconfig')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ret: 0, errcode: 0, config: 'mock_cfg' }));
            return;
          }

          // Fallback
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ret: 0, errcode: 0, errmsg: 'ok' }));
        });
      });

      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address() as any;
        this.port = addr.port;
        resolve(`http://127.0.0.1:${this.port}`);
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  clearRecords(): void {
    this.getUpdatesRequests.length = 0;
    this.sendMessages.length = 0;
    this.queuedUpdatesResponses.length = 0;
    this.returnSessionExpired = false;
  }
}

describe('WeChat Channel Runtime & E2E Integration', () => {
  let fakeServer: FakeILinkServer;
  let fakeServerUrl = '';

  const userId = 'usr_alice_wechat';
  const spaceId = 'spc_alice_main';
  const accountId = 'acc_wechat_prod_001';
  const credentialRef = 'cred_wechat_alice';

  beforeAll(async () => {
    fakeServer = new FakeILinkServer();
    fakeServerUrl = await fakeServer.start();
  });

  afterAll(async () => {
    await fakeServer.stop();
  });

  beforeEach(() => {
    fakeServer.clearRecords();
  });

  const setupDatabase = async () => {
    const db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    // Seed tenant user and space
    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'alice_wechat', 'hash')`).run(userId);
    db.prepare(`INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES (?, ?, 'WeChat Space', 'wechat', 'container')`).run(spaceId, userId);

    const storage = new SqlitePlatformStorage(db);
    const messageStore = new SqliteWebMessageStore(db);
    const tenant = storage.forTenant(userId);

    // Create WeChat channel account with fixed accountId
    await tenant.channels.createAccount({
      id: accountId,
      type: 'wechat',
      status: 'active',
      credentialRef,
      defaultSpaceId: spaceId,
    } as any);

    return { db, storage, messageStore, tenant };
  };

  const createMockCredentials = (initialCursor = ''): WeChatResolvedCredentials => ({
    botToken: 'bot_token_test_abc123',
    ilinkBotId: 'ilink_bot_001',
    baseUrl: fakeServerUrl,
    cdnBaseUrl: `${fakeServerUrl}/c2c`,
    getUpdatesBuf: initialCursor,
  });

  it('enables account -> polls inbound text/image -> channel_inbox -> turn -> outbound reply with cached context_token', async () => {
    const { db, storage, messageStore } = await setupDatabase();

    // 1. Setup mock DeliveryRuntimeGateway executor that replies to incoming turns
    let executedTurns = 0;
    const executor = {
      execute: async (req: DeliveryExecutionRequest) => {
        executedTurns++;
        return {
          replyText: `[Echo Bot Reply] You said: ${req.content}`,
          metadata: { engine: 'mock' },
          usage: { totalTokens: 15 },
        };
      },
      cancel: async () => true,
    };

    const deliveryGateway = new DeliveryRuntimeGateway({
      database: db,
      storage,
      messageStore,
      quotaMode: 'disabled',
      profileResolver: { resolve: async () => null } as any,
      executor,
    });

    // 2. Queue inbound text message with context_token and cursor
    fakeServer.queuedUpdatesResponses.push({
      ret: 0,
      msgs: [
        {
          message_id: 10001,
          from_user_id: 'wx_user_dave',
          to_user_id: 'ilink_bot_001',
          message_type: 1,
          context_token: 'ctx_token_dave_secret_777',
          item_list: [
            {
              type: 1,
              text_item: { text: 'Hello Enkeep Assistant!' },
            },
          ],
        },
      ],
      get_updates_buf: 'cursor_v1_text_acked',
    });

    // 3. Start WeChatRuntimeManager
    const manager = new WeChatRuntimeManager({
      storage,
      db,
      deliveryGateway,
      credentialResolver: async () => createMockCredentials('cursor_v0_initial'),
      workerIntervalMs: 500,
    });

    await manager.start();

    // 4. Wait for poller to process inbound message, trigger agent turn, and deliver outbound reply
    let retries = 50;
    while (retries-- > 0 && fakeServer.sendMessages.length === 0) {
      await new Promise((r) => setTimeout(r, 60));
    }

    expect(fakeServer.sendMessages.length).toBe(1);
    const sentMsg = fakeServer.sendMessages[0].body;
    expect(sentMsg.msg.to_user_id).toBe('wx_user_dave');
    expect(sentMsg.msg.context_token).toBe('ctx_token_dave_secret_777');
    expect(sentMsg.msg.item_list[0].text_item.text).toBe('[Echo Bot Reply] You said: Hello Enkeep Assistant!');

    // Verify inbox CAS transition in DB
    const inboxRow = db
      .prepare('SELECT status, native_event_id FROM channel_inbox WHERE account_id = ?')
      .get(accountId) as any;
    expect(inboxRow).toBeDefined();
    expect(inboxRow.status).toBe('delivered');
    expect(inboxRow.native_event_id).toBe('10001');

    // Verify outbox record in DB
    const outboxRow = db
      .prepare('SELECT status, native_context_id FROM channel_outbox WHERE account_id = ?')
      .get(accountId) as any;
    expect(outboxRow).toBeDefined();
    expect(outboxRow.status).toBe('delivered');
    expect(outboxRow.native_context_id).toBe('wechat:wx_user_dave');

    // Verify context_token was stored and is accessible from contextTokenStore
    const cachedToken = await manager.contextTokenStore.get('wx_user_dave');
    expect(cachedToken).toBe('ctx_token_dave_secret_777');

    // 5. Now test inbound image message
    fakeServer.queuedUpdatesResponses.push({
      ret: 0,
      msgs: [
        {
          message_id: 10002,
          from_user_id: 'wx_user_eva',
          to_user_id: 'ilink_bot_001',
          message_type: 1,
          context_token: 'ctx_token_eva_image_888',
          item_list: [
            {
              type: 2,
              image_item: {
                media: {
                  encrypt_query_param: 'cdn_param_eva_img',
                  aes_key: '0123456789abcdef0123456789abcdef',
                },
              },
            },
          ],
        },
      ],
      get_updates_buf: 'cursor_v2_image_acked',
    });

    retries = 50;
    while (retries-- > 0 && fakeServer.sendMessages.length < 2) {
      await new Promise((r) => setTimeout(r, 60));
    }

    expect(fakeServer.sendMessages.length).toBe(2);
    const sentImgReply = fakeServer.sendMessages[1].body;
    expect(sentImgReply.msg.to_user_id).toBe('wx_user_eva');
    expect(sentImgReply.msg.context_token).toBe('ctx_token_eva_image_888');
    expect(sentImgReply.msg.item_list[0].text_item.text).toBe('[Echo Bot Reply] You said: [图片]');

    await manager.stop();
  });

  it('persists committed cursor and resumes from persisted cursor on restart', async () => {
    const { db, storage, messageStore } = await setupDatabase();

    const deliveryGateway = new DeliveryRuntimeGateway({
      database: db,
      storage,
      messageStore,
      quotaMode: 'disabled',
      profileResolver: { resolve: async () => null } as any,
      executor: {
        execute: async () => ({ replyText: 'ok', metadata: {}, usage: { totalTokens: 1 } }),
        cancel: async () => true,
      },
    });

    // 1. First run: commit cursor 'cursor_step_42'
    const manager1 = new WeChatRuntimeManager({
      storage,
      db,
      deliveryGateway,
      credentialResolver: async () => createMockCredentials('cursor_step_0'),
    });

    fakeServer.queuedUpdatesResponses.push({
      ret: 0,
      msgs: [
        {
          message_id: 20001,
          from_user_id: 'wx_frank',
          to_user_id: 'ilink_bot_001',
          message_type: 1,
          context_token: 'tok_frank',
          item_list: [{ type: 1, text_item: { text: 'Hi' } }],
        },
      ],
      get_updates_buf: 'cursor_step_42',
    });

    await manager1.start();

    // Wait for cursor to commit
    let retries = 50;
    while (retries-- > 0 && manager1.getPersistedCursor(accountId) !== 'cursor_step_42') {
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(manager1.getPersistedCursor(accountId)).toBe('cursor_step_42');

    // Verify persisted cursor in SQLite table
    const cursorRow = db
      .prepare('SELECT cursor FROM channel_wechat_cursors WHERE account_id = ?')
      .get(accountId) as any;
    expect(cursorRow?.cursor).toBe('cursor_step_42');

    await manager1.stop();
    fakeServer.clearRecords();

    // 2. Restart with fresh manager on same DB
    const manager2 = new WeChatRuntimeManager({
      storage,
      db,
      deliveryGateway,
      // Credential resolver still returns initial cursor_step_0, but manager must use persisted cursor_step_42
      credentialResolver: async () => createMockCredentials('cursor_step_0'),
    });

    await manager2.start();

    // Wait for poller to make its first getupdates request
    retries = 50;
    while (retries-- > 0 && fakeServer.getUpdatesRequests.length === 0) {
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(fakeServer.getUpdatesRequests.length).toBeGreaterThanOrEqual(1);
    const firstReqBody = fakeServer.getUpdatesRequests[0].body;
    expect(firstReqBody.get_updates_buf).toBe('cursor_step_42');

    await manager2.stop();
  });

  it('stops polling when account is disabled', async () => {
    const { db, storage, messageStore, tenant } = await setupDatabase();

    const deliveryGateway = new DeliveryRuntimeGateway({
      database: db,
      storage,
      messageStore,
      quotaMode: 'disabled',
      profileResolver: { resolve: async () => null } as any,
      executor: {
        execute: async () => ({ replyText: 'ok', metadata: {}, usage: { totalTokens: 1 } }),
        cancel: async () => true,
      },
    });

    const manager = new WeChatRuntimeManager({
      storage,
      db,
      deliveryGateway,
      credentialResolver: async () => createMockCredentials('cursor_active'),
    });

    await manager.start();
    expect(manager.activeGatewayCount).toBe(1);

    // Disable the account in database
    await tenant.channels.updateAccount(accountId, { status: 'disabled' });

    // Sync account to reflect status change
    await manager.syncAccount(userId, accountId);

    expect(manager.activeGatewayCount).toBe(0);

    // Verify polling requests cease
    const reqCountBefore = fakeServer.getUpdatesRequests.length;
    await new Promise((r) => setTimeout(r, 150));
    const reqCountAfter = fakeServer.getUpdatesRequests.length;

    // No new poll requests after stopping
    expect(reqCountAfter - reqCountBefore).toBeLessThanOrEqual(1);

    await manager.stop();
  });

  it('-14 session expired marks account needs re-login without crashing', async () => {
    const { db, storage, messageStore } = await setupDatabase();

    const deliveryGateway = new DeliveryRuntimeGateway({
      database: db,
      storage,
      messageStore,
      quotaMode: 'disabled',
      profileResolver: { resolve: async () => null } as any,
      executor: {
        execute: async () => ({ replyText: 'ok', metadata: {}, usage: { totalTokens: 1 } }),
        cancel: async () => true,
      },
    });

    fakeServer.returnSessionExpired = true;

    const manager = new WeChatRuntimeManager({
      storage,
      db,
      deliveryGateway,
      credentialResolver: async () => createMockCredentials('cursor_check_expired'),
    });

    await manager.start();

    // Wait for poller to receive -14
    let retries = 50;
    while (retries-- > 0 && !manager.getAccountNeedsReLogin(accountId)) {
      await new Promise((r) => setTimeout(r, 50));
    }

    // Must mark account as needing re-login
    expect(manager.getAccountNeedsReLogin(accountId)).toBe(true);

    // Account status in DB must be updated to 'unverified'
    const accRow = db.prepare('SELECT status FROM channel_accounts WHERE id = ?').get(accountId) as any;
    expect(accRow.status).toBe('unverified');

    // Gateway must be disposed and poller stopped without crashing the process
    expect(manager.activeGatewayCount).toBe(0);
    expect(manager.running).toBe(true); // Server runtime is still running healthy

    await manager.stop();
  });

  it('single-poller concurrency guard prevents duplicate pollers for the same account', async () => {
    const { db, storage, messageStore } = await setupDatabase();

    const deliveryGateway = new DeliveryRuntimeGateway({
      database: db,
      storage,
      messageStore,
      quotaMode: 'disabled',
      profileResolver: { resolve: async () => null } as any,
      executor: {
        execute: async () => ({ replyText: 'ok', metadata: {}, usage: { totalTokens: 1 } }),
        cancel: async () => true,
      },
    });

    const manager = new WeChatRuntimeManager({
      storage,
      db,
      deliveryGateway,
      credentialResolver: async () => createMockCredentials('cursor_guard'),
    });

    // Trigger 5 concurrent syncAccount calls simultaneously
    const syncPromises = [
      manager.syncAccount(userId, accountId),
      manager.syncAccount(userId, accountId),
      manager.syncAccount(userId, accountId),
      manager.syncAccount(userId, accountId),
      manager.syncAccount(userId, accountId),
    ];

    const results = await Promise.all(syncPromises);

    // All promises must resolve to the identical gateway instance
    expect(results[0]).toBeDefined();
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toBe(results[0]);
    }

    // Exactly one active gateway instance tracked
    expect(manager.activeGatewayCount).toBe(1);

    await manager.stop();
  });
});
