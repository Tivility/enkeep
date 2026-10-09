import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { DefaultOutboundFileChannelAdapter } from '../src/channels/outbound-file-adapter.js';

describe('B-01, B-03, B-04, B-05: Outbound File Channel Adapter & Routing Integration', () => {
  let db: DatabaseSync;
  const userId = 'user_test_synthetic_01';

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY);
      INSERT INTO users (id) VALUES ('${userId}');

      CREATE TABLE spaces (id TEXT PRIMARY KEY, folder TEXT);
      INSERT INTO spaces (id, folder) VALUES ('spc_test_01', 'space_folder_01');

      CREATE TABLE session_routes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        space_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        account_id TEXT,
        native_context_id TEXT,
        peer_id TEXT,
        dsh_session_id TEXT
      );

      CREATE TABLE channel_accounts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL
      );

      CREATE TABLE channel_turn_origins (
        turn_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        native_context_id TEXT NOT NULL,
        native_event_id TEXT,
        reply_to_message_id TEXT,
        root_id TEXT,
        thread_id TEXT,
        origin_turn_id TEXT,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      );

      CREATE TABLE session_child_origins (
        session_id TEXT NOT NULL,
        child_id TEXT NOT NULL,
        origin_turn_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        PRIMARY KEY (session_id, child_id)
      );

      CREATE TABLE channel_outbox (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        native_context_id TEXT NOT NULL,
        reply_to_native_id TEXT,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      );
    `);
  });

  it('Web turn origin -> returns recorded and creates zero channel_outbox items', async () => {
    const sessionRouteId = 'ses_web_main_01';
    const turnId = 'turn_web_001';

    db.exec(`
      INSERT INTO session_routes (id, user_id, space_id, channel, dsh_session_id)
      VALUES ('${sessionRouteId}', '${userId}', 'spc_test_01', 'web', 'dsh_web_001');

      INSERT INTO channel_turn_origins (turn_id, user_id, session_id, account_id, channel, chat_id, native_context_id)
      VALUES ('${turnId}', '${userId}', '${sessionRouteId}', 'acc_web', 'web', 'chat_web', 'chat_web');
    `);

    const adapter = new DefaultOutboundFileChannelAdapter({ db });
    const res = await adapter.deliverFile({
      userId,
      recipient: sessionRouteId,
      fileMetadata: {
        id: 'file_001',
        userId,
        filename: 'report.txt',
        relativePath: 'report.txt',
        size: 100,
        extension: '.txt',
        recipient: sessionRouteId,
        createdAt: new Date().toISOString(),
      },
      turnId,
      sessionId: sessionRouteId,
    });

    expect(res.deliveryStatus).toBe('recorded');
    const outboxCount = (db.prepare('SELECT COUNT(*) as cnt FROM channel_outbox').get() as any).cnt;
    expect(outboxCount).toBe(0);
  });

  it('WeChat turn origin -> dispatches to WeChat gateway deliverFile and returns sent status', async () => {
    const sessionRouteId = 'ses_wechat_main_01';
    const turnId = 'turn_wechat_001';
    const accountId = 'acc_wechat_01';

    db.exec(`
      INSERT INTO channel_accounts (id, user_id, type, status)
      VALUES ('${accountId}', '${userId}', 'wechat', 'active');

      INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, dsh_session_id)
      VALUES ('${sessionRouteId}', '${userId}', 'spc_test_01', 'wechat', '${accountId}', 'test-user@im.wechat', 'dsh_wc_001');

      INSERT INTO channel_turn_origins (turn_id, user_id, session_id, account_id, channel, chat_id, native_context_id)
      VALUES ('${turnId}', '${userId}', '${sessionRouteId}', '${accountId}', 'wechat', 'test-user@im.wechat', 'test-user@im.wechat');
    `);

    const mockDeliverFile = vi.fn().mockResolvedValue({
      success: true,
      deliveryStatus: 'sent',
      outboxItem: { id: 'out_wc_test_001' },
    });

    const mockWechatRuntime = {
      getActiveGateway: vi.fn().mockReturnValue({
        deliverFile: mockDeliverFile,
      }),
    };

    const adapter = new DefaultOutboundFileChannelAdapter({
      db,
      wechatRuntimeManager: mockWechatRuntime as any,
    });

    const res = await adapter.deliverFile({
      userId,
      recipient: sessionRouteId,
      fileMetadata: {
        id: 'file_wc_001',
        userId,
        filename: 'image.png',
        relativePath: 'image.png',
        size: 1024,
        extension: '.png',
        recipient: sessionRouteId,
        createdAt: new Date().toISOString(),
      },
      turnId,
      sessionId: sessionRouteId,
    });

    expect(res.deliveryStatus).toBe('sent');
    expect(mockDeliverFile).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: sessionRouteId,
        nativeContextId: 'test-user@im.wechat',
        turnId,
        fileName: 'image.png',
      })
    );
  });

  it('Subagent child session resolves parent turnId via session_child_origins', async () => {
    const parentSessionId = 'ses_parent_01';
    const childSessionId = 'ses_subagent_child_01';
    const parentTurnId = 'turn_parent_001';
    const accountId = 'acc_wechat_01';

    db.exec(`
      INSERT INTO channel_accounts (id, user_id, type, status)
      VALUES ('${accountId}', '${userId}', 'wechat', 'active');

      INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, dsh_session_id)
      VALUES ('${parentSessionId}', '${userId}', 'spc_test_01', 'wechat', '${accountId}', 'test-user@im.wechat', 'dsh_p_001');

      INSERT INTO channel_turn_origins (turn_id, user_id, session_id, account_id, channel, chat_id, native_context_id)
      VALUES ('${parentTurnId}', '${userId}', '${parentSessionId}', '${accountId}', 'wechat', 'test-user@im.wechat', 'test-user@im.wechat');

      INSERT INTO session_child_origins (session_id, child_id, origin_turn_id)
      VALUES ('${parentSessionId}', '${childSessionId}', '${parentTurnId}');
    `);

    const mockDeliverFile = vi.fn().mockResolvedValue({
      success: true,
      deliveryStatus: 'sent',
      outboxItem: { id: 'out_wc_child_001' },
    });

    const mockWechatRuntime = {
      getActiveGateway: vi.fn().mockReturnValue({
        deliverFile: mockDeliverFile,
      }),
    };

    const adapter = new DefaultOutboundFileChannelAdapter({
      db,
      wechatRuntimeManager: mockWechatRuntime as any,
    });

    // Subagent invokes deliverFile with only child sessionId and no turnId
    const res = await adapter.deliverFile({
      userId,
      recipient: childSessionId,
      fileMetadata: {
        id: 'file_child_001',
        userId,
        filename: 'child_output.pdf',
        relativePath: 'child_output.pdf',
        size: 2048,
        extension: '.pdf',
        recipient: childSessionId,
        createdAt: new Date().toISOString(),
      },
      sessionId: childSessionId,
    });

    expect(res.deliveryStatus).toBe('sent');
    expect(mockDeliverFile).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: parentSessionId,
        turnId: parentTurnId,
        fileName: 'child_output.pdf',
      })
    );
  });

  it('Lark turn origin -> dispatches to Lark gateway deliverFile and returns sent status', async () => {
    const sessionRouteId = 'ses_lark_main_01';
    const turnId = 'turn_lark_001';
    const accountId = 'acc_lark_01';

    db.exec(`
      INSERT INTO channel_accounts (id, user_id, type, status)
      VALUES ('${accountId}', '${userId}', 'lark', 'active');

      INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, dsh_session_id)
      VALUES ('${sessionRouteId}', '${userId}', 'spc_test_01', 'lark', '${accountId}', 'oc_test_chat', 'dsh_lark_001');

      INSERT INTO channel_turn_origins (turn_id, user_id, session_id, account_id, channel, chat_id, native_context_id)
      VALUES ('${turnId}', '${userId}', '${sessionRouteId}', '${accountId}', 'lark', 'oc_test_chat', 'oc_test_chat');
    `);

    const mockDeliverFile = vi.fn().mockResolvedValue({
      success: true,
      deliveryStatus: 'sent',
      outboxItem: { id: 'out_lark_test_001' },
    });

    const mockChannelRuntime = {
      getActiveGateway: vi.fn().mockReturnValue({
        deliverFile: mockDeliverFile,
      }),
    };

    const adapter = new DefaultOutboundFileChannelAdapter({
      db,
      channelRuntimeManager: mockChannelRuntime as any,
    });
    const res = await adapter.deliverFile({
      userId,
      recipient: sessionRouteId,
      fileMetadata: {
        id: 'file_lark_001',
        userId,
        filename: 'doc.pdf',
        relativePath: 'doc.pdf',
        size: 500,
        extension: '.pdf',
        recipient: sessionRouteId,
        createdAt: new Date().toISOString(),
      },
      turnId,
      sessionId: sessionRouteId,
    });

    expect(res.deliveryStatus).toBe('sent');
    expect(mockDeliverFile).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: sessionRouteId,
        chatId: 'oc_test_chat',
        turnId,
        fileName: 'doc.pdf',
      })
    );
  });

  it('Unknown delivery status records are excluded from redrive selection', () => {
    const accountId = 'acc_wechat_redrive';
    db.exec(`
      INSERT INTO channel_accounts (id, user_id, type, status)
      VALUES ('${accountId}', '${userId}', 'wechat', 'active');

      -- Record 1: Normal failed record (should be selected)
      INSERT INTO channel_outbox (id, user_id, account_id, session_id, native_context_id, payload_json, status, attempts)
      VALUES ('out_fail_normal', '${userId}', '${accountId}', 'ses_1', 'user@im.wechat', '{"text":"normal fail"}', 'failed', 1);

      -- Record 2: Unknown delivery status record (must be excluded)
      INSERT INTO channel_outbox (id, user_id, account_id, session_id, native_context_id, payload_json, status, attempts)
      VALUES ('out_fail_unknown', '${userId}', '${accountId}', 'ses_1', 'user@im.wechat', '{"text":"timeout","deliveryStatus":"unknown"}', 'failed', 1);
    `);

    const query = `
      SELECT co.id
      FROM channel_outbox co
      JOIN channel_accounts ca ON ca.id = co.account_id AND ca.status = 'active' AND ca.type = 'wechat'
      WHERE co.status IN ('pending', 'failed')
        AND co.attempts < 3
        AND (json_extract(co.payload_json, '$.deliveryStatus') IS NULL OR json_extract(co.payload_json, '$.deliveryStatus') != 'unknown')
      ORDER BY co.created_at ASC
    `;

    const rows = db.prepare(query).all() as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(['out_fail_normal']);
  });
});
