/**
 * WeChat Continuation Delivery Acceptance Tests (Item E)
 *
 * Verifies autonomous turn completion continuation for WeChat channel:
 * - Drives the real persistence entry point (PlatformProxyHandler POST /api/events)
 * - Injects onAutonomousTurnCompleted callback wired to WeChatRuntimeManager.handleAutonomousTurnCompleted
 * - Resolves causal origin via channel_turn_origins
 * - Deduplicates outbox ID per Rule C (cont_<originTurnId>_<causeChildId>)
 * - Extracts final answer text strictly from assistant_delta (filtering thinking/reasoning and converting markdown)
 * - Proactively delivers to WeChat recipient using cached context_token
 * - Skips without crashing when context_token is absent
 * - Disregards Lark-origin and web-origin turns
 *
 * @module @enkeep/platform-server/tests/wechat-continuation.test
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import { Duplex } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  SqliteWebMessageStore,
} from '../src/index.js';
import { DeliveryRuntimeGateway } from '../src/runtime/delivery-gateway.js';
import {
  WeChatRuntimeManager,
  type WeChatResolvedCredentials,
} from '../src/channels/wechat-runtime.js';
import {
  createPlatformProxyHandler,
  type PlatformProxyHandler,
} from '../../runtime-runner/src/tunnel/platform-proxy.js';

interface FakeServerRequestRecord {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

class FakeILinkServer {
  private server?: http.Server;
  private port = 0;
  readonly sendMessages: FakeServerRequestRecord[] = [];

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

          if (req.url?.startsWith('/ilink/bot/sendmessage')) {
            this.sendMessages.push(record);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ret: 0, errcode: 0, errmsg: 'ok' }));
            return;
          }

          if (req.url?.startsWith('/ilink/bot/getupdates')) {
            setTimeout(() => {
              if (res.writableEnded) return;
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ret: 0, errcode: 0, errmsg: 'ok', msgs: [], get_updates_buf: 'c_0' }));
            }, 30);
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
    this.sendMessages.length = 0;
  }
}

class TestClientDuplex extends Duplex {
  public responseBuffer = Buffer.alloc(0);

  _write(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.responseBuffer = Buffer.concat([this.responseBuffer, buf]);
    callback();
  }

  _read(_size: number): void {}

  pushToStream(data: string | Buffer): void {
    this.push(typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
  }

  endStream(): void {
    this.push(null);
  }
}

async function sendEvents(
  handler: PlatformProxyHandler,
  events: unknown[],
  runtimeIdentity = 'alice_syn'
): Promise<void> {
  const stream = new TestClientDuplex();
  const body = JSON.stringify({ events });
  const reqStr = `POST /api/events HTTP/1.1\r\nHost: 127.0.0.1:8787\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
  stream.pushToStream(reqStr);
  stream.endStream();

  await handler.handle(stream, { kind: 'platform', userId: runtimeIdentity });
}

describe('Item E: WeChat Continuation Delivery', () => {
  let fakeServer: FakeILinkServer;
  let fakeServerUrl = '';

  const userId = 'user_synthetic_alice';
  const spaceId = 'spc_00000000000000000000000000000001';
  const accountId = 'acc_wechat_synthetic_01';
  const credentialRef = 'cred_wechat_synthetic_01';

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

  const setupTestEnv = async () => {
    const db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'alice_syn', 'hash')`).run(userId);
    db.prepare(`INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES (?, ?, 'Space 1', 'wechat', 'container')`).run(spaceId, userId);

    const storage = new SqlitePlatformStorage(db);
    const messageStore = new SqliteWebMessageStore(db);
    const tenant = storage.forTenant(userId);

    await tenant.channels.createAccount({
      id: accountId,
      type: 'wechat',
      name: 'Synthetic Bot',
      status: 'active',
      credentialRef,
      defaultSpaceId: spaceId,
    } as any);

    await tenant.sessionRoutes.create({
      id: 'ses_route_synthetic_001',
      userId,
      spaceId,
      channel: 'wechat',
      accountId,
      chatId: 'test-peer-01@im.wechat',
      nativeContextId: 'wechat:test-peer-01@im.wechat',
      dshSessionId: 'dsh_ses_synthetic_001',
    });

    await tenant.sessionRoutes.create({
      id: 'ses_route_synthetic_002',
      userId,
      spaceId,
      channel: 'wechat',
      accountId,
      chatId: 'test-peer-02@im.wechat',
      nativeContextId: 'wechat:test-peer-02@im.wechat',
      dshSessionId: 'dsh_ses_synthetic_002',
    });

    await tenant.sessionRoutes.create({
      id: 'ses_route_synthetic_003',
      userId,
      spaceId,
      channel: 'lark',
      accountId,
      chatId: 'oc_test01',
      nativeContextId: 'oc_test01',
      dshSessionId: 'dsh_ses_synthetic_003',
    });

    await tenant.sessionRoutes.create({
      id: 'ses_route_synthetic_web',
      userId,
      spaceId,
      channel: 'web',
      accountId: '',
      chatId: 'web_chat_01',
      nativeContextId: 'web_native_01',
      dshSessionId: 'dsh_ses_synthetic_web',
    });

    const deliveryGateway = new DeliveryRuntimeGateway({
      database: db,
      storage,
      messageStore,
      quotaMode: 'disabled',
      profileResolver: { resolve: async () => null } as any,
      executor: {
        execute: async () => ({ replyText: 'ack', metadata: {}, usage: { totalTokens: 10 } }),
        cancel: async () => true,
      },
    });

    const createMockCredentials = (): WeChatResolvedCredentials => ({
      botToken: 'bot_token_synthetic_abc',
      ilinkBotId: 'ilink_bot_syn_001',
      baseUrl: fakeServerUrl,
      cdnBaseUrl: `${fakeServerUrl}/c2c`,
      getUpdatesBuf: 'cursor_syn_init',
    });

    const manager = new WeChatRuntimeManager({
      storage,
      db,
      deliveryGateway,
      credentialResolver: async () => createMockCredentials(),
      workerIntervalMs: 500,
    });

    await manager.start();

    const proxyHandler = createPlatformProxyHandler({
      platformUserId: userId,
      runtimeIdentity: 'alice_syn',
      db,
      onAutonomousTurnCompleted: (payload) => {
        void manager.handleAutonomousTurnCompleted(payload);
      },
    });

    return { db, manager, proxyHandler };
  };

  it('delivers autonomous turn continuation when terminal frame arrives, filtering thinking and converting markdown, and deduplicates outbox', async () => {
    const { db, manager, proxyHandler } = await setupTestEnv();

    try {
      const sessionRouteId = 'ses_route_synthetic_001';
      const originTurnId = 'turn_origin_001';
      const autoTurnId = 'turn_auto_001';
      const causeChildId = 'ses_subagent_001';
      const peerId = 'test-peer-01@im.wechat';

      // 1. Seed channel_turn_origins for causal tracking
      db.prepare(`
        INSERT INTO channel_turn_origins (
          turn_id, user_id, session_id, account_id, channel, chat_id, native_context_id
        ) VALUES (?, ?, ?, ?, 'wechat', ?, ?)
      `).run(originTurnId, userId, sessionRouteId, accountId, peerId, `wechat:${peerId}`);

      // 2. Cache context token for peer
      await manager.contextTokenStore.set(peerId, 'ctx_token_synthetic_999');

      // 3. Drive stream frames through the real persistence entry point (PlatformProxyHandler)
      await sendEvents(
        proxyHandler,
        [
          {
            type: 'thinking',
            sessionId: sessionRouteId,
            turnId: autoTurnId,
            payload: { status: 'thinking', delta: 'Internal model reasoning...' },
          },
          {
            type: 'reasoning_delta',
            sessionId: sessionRouteId,
            turnId: autoTurnId,
            payload: { status: 'thinking', text: 'Internal planning tokens...' },
          },
          {
            type: 'assistant_delta',
            sessionId: sessionRouteId,
            turnId: autoTurnId,
            payload: { delta: '<think>thinking draft</think>## Subagent Summary\n\n' },
          },
          {
            type: 'assistant_delta',
            sessionId: sessionRouteId,
            turnId: autoTurnId,
            payload: { delta: 'All 3 items **processed successfully**.' },
          },
        ]
      );

      // Verify that deltas alone do not trigger delivery before terminal frame
      expect(fakeServer.sendMessages.length).toBe(0);

      // 4. Send the terminal turn_status completed frame carrying originTurnId
      await sendEvents(
        proxyHandler,
        [
          {
            type: 'turn_status',
            sessionId: sessionRouteId,
            turnId: autoTurnId,
            originTurnId,
            causeChildId,
            payload: { status: 'completed' },
          },
        ]
      );

      // Wait for proactive delivery
      let retries = 30;
      while (retries-- > 0 && fakeServer.sendMessages.length === 0) {
        await new Promise((r) => setTimeout(r, 50));
      }

      expect(fakeServer.sendMessages.length).toBe(1);
      const sentMsg = fakeServer.sendMessages[0].body;
      expect(sentMsg.msg.to_user_id).toBe(peerId);
      expect(sentMsg.msg.context_token).toBe('ctx_token_synthetic_999');

      // Strictly verify thinking is excluded and markdown is converted to plain text (K2 contract)
      const text = sentMsg.msg.item_list[0].text_item.text;
      expect(text).not.toContain('<think>');
      expect(text).not.toContain('thinking draft');
      expect(text).not.toContain('##');
      expect(text).toContain('Subagent Summary');
      expect(text).toContain('All 3 items processed successfully.');

      // Verify deterministic outbox ID matching Rule C: cont_<originTurnId>_<causeChildId>
      const expectedOutboxId = `cont_${originTurnId}_${causeChildId}`;
      const outboxRow = db
        .prepare('SELECT id, status, account_id FROM channel_outbox WHERE id = ?')
        .get(expectedOutboxId) as any;
      expect(outboxRow).toBeDefined();
      expect(outboxRow.status).toBe('delivered');
      expect(outboxRow.account_id).toBe(accountId);

      // 5. Duplicate terminal frame must be skipped (Rule C deduplication)
      await sendEvents(
        proxyHandler,
        [
          {
            type: 'turn_status',
            sessionId: sessionRouteId,
            turnId: autoTurnId,
            originTurnId,
            causeChildId,
            payload: { status: 'completed' },
          },
        ]
      );

      await new Promise((r) => setTimeout(r, 100));
      expect(fakeServer.sendMessages.length).toBe(1); // No second message
    } finally {
      await manager.stop();
    }
  });

  it('skips delivery when context_token is absent without error', async () => {
    const { db, manager, proxyHandler } = await setupTestEnv();

    try {
      const sessionRouteId = 'ses_route_synthetic_002';
      const originTurnId = 'turn_origin_002';
      const autoTurnId = 'turn_auto_002';
      const peerId = 'test-peer-02@im.wechat';

      db.prepare(`
        INSERT INTO channel_turn_origins (
          turn_id, user_id, session_id, account_id, channel, chat_id, native_context_id
        ) VALUES (?, ?, ?, ?, 'wechat', ?, ?)
      `).run(originTurnId, userId, sessionRouteId, accountId, peerId, peerId);

      // Context token is deliberately NOT set in contextTokenStore

      await sendEvents(
        proxyHandler,
        [
          {
            type: 'assistant_delta',
            sessionId: sessionRouteId,
            turnId: autoTurnId,
            payload: { delta: 'Result without token' },
          },
          {
            type: 'turn_status',
            sessionId: sessionRouteId,
            turnId: autoTurnId,
            originTurnId,
            payload: { status: 'completed' },
          },
        ]
      );

      await new Promise((r) => setTimeout(r, 100));
      expect(fakeServer.sendMessages.length).toBe(0);
    } finally {
      await manager.stop();
    }
  });

  it('ignores autonomous turn completion for non-wechat origin channels (lark)', async () => {
    const { db, manager, proxyHandler } = await setupTestEnv();

    try {
      const sessionRouteId = 'ses_route_synthetic_003';
      const originTurnId = 'turn_origin_lark_001';
      const autoTurnId = 'turn_auto_003';

      // Origin belongs to lark, not wechat
      db.prepare(`
        INSERT INTO channel_turn_origins (
          turn_id, user_id, session_id, account_id, channel, chat_id, native_context_id
        ) VALUES (?, ?, ?, ?, 'lark', 'oc_test01', 'oc_test01')
      `).run(originTurnId, userId, sessionRouteId, accountId);

      await sendEvents(
        proxyHandler,
        [
          {
            type: 'assistant_delta',
            sessionId: sessionRouteId,
            turnId: autoTurnId,
            payload: { delta: 'Lark continuation' },
          },
          {
            type: 'turn_status',
            sessionId: sessionRouteId,
            turnId: autoTurnId,
            originTurnId,
            payload: { status: 'completed' },
          },
        ]
      );

      await new Promise((r) => setTimeout(r, 100));
      expect(fakeServer.sendMessages.length).toBe(0);
    } finally {
      await manager.stop();
    }
  });

  it('ignores autonomous turn completion for web-origin turns without channel origin', async () => {
    const { db, manager, proxyHandler } = await setupTestEnv();

    try {
      const sessionRouteId = 'ses_route_synthetic_web';
      const originTurnId = 'turn_origin_web_001';
      const autoTurnId = 'turn_auto_web_001';

      // Web session: no row in channel_turn_origins

      await sendEvents(
        proxyHandler,
        [
          {
            type: 'assistant_delta',
            sessionId: sessionRouteId,
            turnId: autoTurnId,
            payload: { delta: 'Web continuation answer' },
          },
          {
            type: 'turn_status',
            sessionId: sessionRouteId,
            turnId: autoTurnId,
            originTurnId,
            payload: { status: 'completed' },
          },
        ]
      );

      await new Promise((r) => setTimeout(r, 100));
      expect(fakeServer.sendMessages.length).toBe(0);
    } finally {
      await manager.stop();
    }
  });

  it('delivers autonomous turn continuation when originTurnId is an intermediate autonomous turn (platform -> auto1 -> auto2)', async () => {
    const { db, manager, proxyHandler } = await setupTestEnv();

    try {
      const sessionRouteId = 'ses_route_synthetic_001';
      const platTurnId = 'turn_plat_chain_001';
      const auto1TurnId = 'turn_auto_chain_001';
      const auto2TurnId = 'turn_auto_chain_002';
      const causeChildId = 'ses_subagent_chain_002';
      const peerId = 'test-peer-chain@im.wechat';

      // 1. Root platform turn in channel_turn_origins
      db.prepare(`
        INSERT INTO channel_turn_origins (
          turn_id, user_id, session_id, account_id, channel, chat_id, native_context_id
        ) VALUES (?, ?, ?, ?, 'wechat', ?, ?)
      `).run(platTurnId, userId, sessionRouteId, accountId, peerId, `wechat:${peerId}`);

      // 2. Cache context token for peer
      await manager.contextTokenStore.set(peerId, 'ctx_token_synthetic_chain');

      // 3. Drive auto1 turn events through PlatformProxyHandler (origin is platTurnId)
      await sendEvents(
        proxyHandler,
        [
          {
            type: 'assistant_delta',
            sessionId: sessionRouteId,
            turnId: auto1TurnId,
            payload: { delta: 'Auto 1 intermediate reply' },
          },
          {
            type: 'turn_status',
            sessionId: sessionRouteId,
            turnId: auto1TurnId,
            originTurnId: platTurnId,
            payload: { status: 'completed' },
          },
        ]
      );

      // 4. Drive auto2 turn events through PlatformProxyHandler (origin is auto1TurnId)
      await sendEvents(
        proxyHandler,
        [
          {
            type: 'assistant_delta',
            sessionId: sessionRouteId,
            turnId: auto2TurnId,
            payload: { delta: 'Auto 2 final reply from nested background subagent' },
          },
          {
            type: 'turn_status',
            sessionId: sessionRouteId,
            turnId: auto2TurnId,
            originTurnId: auto1TurnId,
            causeChildId,
            payload: { status: 'completed' },
          },
        ]
      );

      await new Promise((r) => setTimeout(r, 150));

      // 5. Verify fakeServer received proactive message delivered for auto2
      const auto2Message = fakeServer.sendMessages.find(
        (m) => m.body?.msg?.item_list?.[0]?.text_item?.text === 'Auto 2 final reply from nested background subagent'
      );
      expect(auto2Message).toBeDefined();

      // 6. Verify dedupe outbox key uses immediate originTurnId: cont_<originTurnId>_<causeChildId>
      const expectedOutboxId = `cont_${auto1TurnId}_${causeChildId}`;
      const outboxRow = db.prepare('SELECT id, status FROM channel_outbox WHERE id = ?').get(expectedOutboxId) as any;
      expect(outboxRow).toBeDefined();
      expect(outboxRow.id).toBe(expectedOutboxId);
      expect(outboxRow.status).toBe('delivered');
    } finally {
      await manager.stop();
    }
  });
});
