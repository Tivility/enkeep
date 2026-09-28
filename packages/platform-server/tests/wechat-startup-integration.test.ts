/**
 * WeChat Channel Production Startup Integration Test
 *
 * Boots the actual PlatformServer (and createPlatformServer startup path)
 * with a temp DB containing an active WeChat channel account whose credential
 * is encrypted exactly as the importer does, pointing baseUrl at a local fake iLink HTTP server.
 *
 * Verifies end-to-end without manual construction of WeChatRuntimeManager or transport:
 * 1. PlatformServer startup begins polling (fake server receives getUpdates).
 * 2. Inbound text message becomes a channel_inbox row and dispatches to runtime.
 * 3. Outbound reply is sent to fake server with the correct context_token.
 * 4. Disabling the account via the real API (PATCH /api/manage/channels/accounts/:id) stops polling.
 * 5. Re-enabling the account via the real API restarts polling.
 * 6. Server shutdown (server.stop()) stops polling.
 *
 * @module @enkeep/platform-server/tests/wechat-startup-integration.test
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import {
  PlatformServer,
  createPlatformServer,
  DeliveryRuntimeGateway,
  SqliteWebMessageStore,
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  type DeliveryExecutionRequest,
} from '../src/index.js';
import { DefaultAuthService, provisionFixtures } from '@enkeep/platform-auth';
import { encryptEnkeepCredential } from '../../import-happyclaw/src/wechat-importer.js';

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
  readonly queuedUpdatesResponses: Array<{
    ret?: number;
    errcode?: number;
    errmsg?: string;
    msgs?: any[];
    get_updates_buf?: string;
  }> = [];

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

            // Return empty long-poll response with short delay
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
            }, 25);
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
  }
}

describe('WeChat Channel Production Startup & Lifecycle Integration', () => {
  let fakeServer: FakeILinkServer;
  let fakeServerUrl = '';

  beforeAll(async () => {
    fakeServer = new FakeILinkServer();
    fakeServerUrl = await fakeServer.start();
  });

  afterAll(async () => {
    await fakeServer.stop();
  });

  it('boots PlatformServer with encrypted WeChat credential, verifies polling, inbound processing, outbox reply, API disable/enable, and clean shutdown', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-wechat-startup-'));
    const dbPath = path.join(tempDir, 'platform.sqlite');
    const vaultKeyPath = path.join(tempDir, 'credentials', 'wechat-vault.key');
    fs.mkdirSync(path.dirname(vaultKeyPath), { recursive: true });

    // 1. Generate 32-byte master key and write to 0600 key file exactly as importer does
    const masterKey = crypto.randomBytes(32);
    fs.writeFileSync(vaultKeyPath, masterKey.toString('hex'), { mode: 0o600 });

    // 2. Open temporary SQLite database and run all platform migrations
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA foreign_keys = ON;');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    const storage = new SqlitePlatformStorage(db);
    const messageStore = new SqliteWebMessageStore(db);

    const cookieSecret = 'test_cookie_secret_0123456789abcdef';
    const csrfToken = 'test_csrf_token_0123456789abcdef';

    const authService = new DefaultAuthService(storage, {
      cookieSecret,
      sessionTtlSeconds: 3600,
      cookieSecure: false,
    });

    // 3. Provision admin and user fixtures
    const adminPassword = 'AliceAdmin123!';
    const userPassword = 'BobUser123!';
    const disabledPassword = 'CharlieDisabled123!';
    const fixtures = await provisionFixtures(storage, authService, {
      adminPassword,
      userPassword,
      disabledPassword,
    });

    const adminUser = fixtures.admin;
    const adminUserId = adminUser.id;
    const adminSpaceId = fixtures.adminSpace.id;

    // 4. Encrypt WeChat credentials matching the importer format (AES-256-GCM + AAD userId:credentialRef)
    const accountId = 'acc_wechat_prod_001';
    const credentialRef = 'cred_wechat_prod_001';
    const botToken = 'bot_token_test_123456';
    const ilinkBotId = 'ilink_bot_001';

    const enkeepPayload = {
      botToken,
      ilinkBotId,
      baseUrl: fakeServerUrl,
      cdnBaseUrl: `${fakeServerUrl}/c2c`,
      getUpdatesBuf: '',
      bypassProxy: true,
    };

    const encryptedPayload = encryptEnkeepCredential(
      masterKey,
      enkeepPayload,
      adminUserId,
      credentialRef
    );

    // Seed channel_encrypted_credentials, channel_accounts, channel_bindings into temp DB
    db.prepare(`
      INSERT INTO channel_encrypted_credentials (id, user_id, credential_ref, encrypted_payload, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run('enc_wechat_001', adminUserId, credentialRef, encryptedPayload);

    db.prepare(`
      INSERT INTO channel_accounts (id, user_id, type, status, credential_ref, default_space_id, updated_at)
      VALUES (?, ?, 'wechat', 'active', ?, ?, CURRENT_TIMESTAMP)
    `).run(accountId, adminUserId, credentialRef, adminSpaceId);

    const wechatSenderId = 'wx_user_alice_001';
    const nativeContextId = `wechat:${wechatSenderId}`;

    db.prepare(`
      INSERT INTO channel_bindings (id, user_id, account_id, space_id, native_context_id, activation_mode, chat_type, updated_at)
      VALUES (?, ?, ?, ?, ?, 'always', 'p2p', CURRENT_TIMESTAMP)
    `).run('bind_wechat_001', adminUserId, accountId, adminSpaceId, nativeContextId);

    // 5. Construct DeliveryRuntimeGateway delegating execution to mock turn executor
    // Enforces daemon parameter validation matching packages/runtime-runner/src/runtime/dsh-boot.ts:127 & daemon.ts:569
    const CANONICAL_SESSION_ID_PATTERN = /^(ses_[0-9a-f]{32}|import-[0-9a-f]{32})$/;
    const executedTurns: DeliveryExecutionRequest[] = [];
    const executor = {
      execute: async (req: DeliveryExecutionRequest) => {
        if (!req.dshSessionId || !CANONICAL_SESSION_ID_PATTERN.test(req.dshSessionId)) {
          throw new Error(`[INVALID_PARAMETERS] Invalid sessionId format: "${req.dshSessionId}"`);
        }
        executedTurns.push(req);
        return {
          replyText: `[WeChat Bot Echo] ${req.content}`,
          usage: { totalTokens: 25 },
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

    // 6. Boot the actual PlatformServer using createPlatformServer (the exact demo-runner startup path)
    // Notice: NO manual construction of WeChatRuntimeManager or CredentialedWeChatTransport!
    fakeServer.clearRecords();

    const { server } = await createPlatformServer({
      database: db,
      storage,
      authService,
      runtimeGateway: deliveryGateway,
      cookieSecret,
      csrfToken,
      host: '127.0.0.1',
      port: 0,
      wechatMasterKey: masterKey,
      wechatCredentialKeyFilePath: vaultKeyPath,
    });

    try {
      const serverUrl = server.getUrl();
      expect(server.wechatRuntimeManager).toBeDefined();

      // ──────────────────────────────────────────────────────────────────────────
      // ASSERTION 1: Server startup begins polling without manual runtime construction
      // ──────────────────────────────────────────────────────────────────────────
      await vi.waitFor(() => {
        expect(fakeServer.getUpdatesRequests.length).toBeGreaterThanOrEqual(1);
      }, { timeout: 5000 });

      const firstGetUpdates = fakeServer.getUpdatesRequests[0];
      expect(firstGetUpdates.method).toBe('POST');
      expect(firstGetUpdates.url).toContain('/ilink/bot/getupdates');
      expect(firstGetUpdates.headers['authorization']).toContain(botToken);

      // ──────────────────────────────────────────────────────────────────────────
      // ASSERTION 2: An inbound text becomes a channel_inbox row and dispatch
      // ──────────────────────────────────────────────────────────────────────────
      const inboundMsgId = 654321;
      const inboundText = 'Hello WeChat Server Startup Test';
      const expectedContextToken = 'ctx_token_auth_secret_998877';

      fakeServer.queuedUpdatesResponses.push({
        ret: 0,
        msgs: [
          {
            message_id: inboundMsgId,
            from_user_id: wechatSenderId,
            to_user_id: ilinkBotId,
            message_type: 1, // TEXT
            item_list: [
              {
                type: 1,
                text_item: { text: inboundText },
              },
            ],
            context_token: expectedContextToken,
          },
        ],
        get_updates_buf: 'cursor_test_001',
      });

      // Wait for turn execution to complete
      await vi.waitFor(() => {
        expect(executedTurns.length).toBe(1);
      }, { timeout: 10000 });

      // Verify turn execution succeeded and was NOT failed due to parameter validation
      expect(executedTurns[0].content).toBe(inboundText);
      expect(executedTurns[0].dshSessionId).toBeDefined();
      expect(executedTurns[0].dshSessionId).toMatch(CANONICAL_SESSION_ID_PATTERN);
      expect(executedTurns[0].dshSessionId).toMatch(/^ses_[0-9a-f]{32}$/);

      // Verify turn_runs status in database is completed and NOT failed due to parameter validation
      const turnRunRow = db.prepare(
        'SELECT * FROM turn_runs WHERE user_id = ? ORDER BY created_at DESC LIMIT 1'
      ).get(adminUserId) as any;
      expect(turnRunRow).toBeDefined();
      expect(turnRunRow.status).toBe('completed');
      expect(turnRunRow.error).toBeNull();

      // Verify session_routes was populated with canonical dsh_session_id
      const sessionRouteRow = db.prepare(
        'SELECT * FROM session_routes WHERE account_id = ? AND channel = ?'
      ).get(accountId, 'wechat') as any;
      expect(sessionRouteRow).toBeDefined();
      expect(sessionRouteRow.dsh_session_id).toMatch(CANONICAL_SESSION_ID_PATTERN);
      expect(sessionRouteRow.dsh_session_id).toMatch(/^ses_[0-9a-f]{32}$/);

      // Verify channel_inbox row was created in SQLite
      const inboxRow = db.prepare(
        'SELECT * FROM channel_inbox WHERE account_id = ? AND native_event_id = ?'
      ).get(accountId, String(inboundMsgId)) as any;

      expect(inboxRow).toBeDefined();
      expect(inboxRow.account_id).toBe(accountId);
      expect(inboxRow.native_event_id).toBe(String(inboundMsgId));
      expect(inboxRow.native_context_id).toBe(nativeContextId);

      // Verify channel_turn_origins was atomically populated with channel='wechat'
      const turnOriginRow = db.prepare(
        'SELECT * FROM channel_turn_origins WHERE account_id = ? AND channel = ?'
      ).get(accountId, 'wechat') as any;

      expect(turnOriginRow).toBeDefined();
      expect(turnOriginRow.native_event_id).toBe(String(inboundMsgId));

      // ──────────────────────────────────────────────────────────────────────────
      // ASSERTION 3: Outbound reply is sent to fake server with the right context_token
      // ──────────────────────────────────────────────────────────────────────────
      await vi.waitFor(() => {
        expect(fakeServer.sendMessages.length).toBe(1);
      }, { timeout: 10000 });

      const outboundReq = fakeServer.sendMessages[0];
      expect(outboundReq.body).toBeDefined();
      expect(outboundReq.body.msg).toBeDefined();
      expect(outboundReq.body.msg.to_user_id).toBe(wechatSenderId);
      expect(outboundReq.body.msg.context_token).toBe(expectedContextToken);

      const replyItems = outboundReq.body.msg.item_list;
      expect(replyItems).toBeDefined();
      expect(replyItems.length).toBeGreaterThan(0);
      expect(replyItems[0].text_item.text).toBe(`[WeChat Bot Echo] ${inboundText}`);

      // Verify channel_outbox status is delivered
      const outboxRow = db.prepare(
        'SELECT * FROM channel_outbox WHERE account_id = ?'
      ).get(accountId) as any;
      expect(outboxRow).toBeDefined();
      expect(outboxRow.status).toBe('delivered');

      // ──────────────────────────────────────────────────────────────────────────
      // ASSERTION 4: Disabling the account via the real API stops polling
      // ──────────────────────────────────────────────────────────────────────────
      const loginResult = await authService.login('alice', adminPassword);
      const authCookie = loginResult.cookieHeader.split(';')[0];

      const disableResponse = await fetch(`${serverUrl}/api/manage/channels/accounts/${accountId}`, {
        method: 'PATCH',
        headers: {
          'Cookie': authCookie,
          'X-Enkeep-CSRF': csrfToken,
          'Origin': serverUrl,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'disabled' }),
      });

      expect(disableResponse.status).toBe(200);
      const disableJson = await disableResponse.json();
      expect(disableJson.data.status).toBe('disabled');

      // Clear records and wait to ensure no new getUpdates requests are made
      fakeServer.clearRecords();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(fakeServer.getUpdatesRequests.length).toBe(0);

      // ──────────────────────────────────────────────────────────────────────────
      // ASSERTION 5: Re-enabling the account via the real API restarts polling
      // ──────────────────────────────────────────────────────────────────────────
      const enableResponse = await fetch(`${serverUrl}/api/manage/channels/accounts/${accountId}`, {
        method: 'PATCH',
        headers: {
          'Cookie': authCookie,
          'X-Enkeep-CSRF': csrfToken,
          'Origin': serverUrl,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'active' }),
      });

      expect(enableResponse.status).toBe(200);
      const enableJson = await enableResponse.json();
      expect(enableJson.data.status).toBe('active');

      await vi.waitFor(() => {
        expect(fakeServer.getUpdatesRequests.length).toBeGreaterThanOrEqual(1);
      }, { timeout: 5000 });

      // ──────────────────────────────────────────────────────────────────────────
      // ASSERTION 6: Server shutdown stops polling
      // ──────────────────────────────────────────────────────────────────────────
      await server.stop();

      fakeServer.clearRecords();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(fakeServer.getUpdatesRequests.length).toBe(0);
    } finally {
      try {
        await server.stop();
      } catch {}
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
  });
});
