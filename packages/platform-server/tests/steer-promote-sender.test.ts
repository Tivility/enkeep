import { describe, it, expect, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { ALL_PLATFORM_MIGRATIONS } from '../src/storage/migrations.js';
import { SqliteWebMessageStore } from '../src/storage/web-messages.js';
import { DeliveryRuntimeGateway } from '../src/runtime/delivery-gateway.js';
import type { InboundEnvelope } from '@enkeep/web-channel';

function setupDb() {
  const db = new DatabaseSync(':memory:');
  for (const mig of ALL_PLATFORM_MIGRATIONS) db.exec(mig.upSql);
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES ('u_test_1', 'user_test', 'hash', 'user')").run();
  db.prepare("INSERT INTO spaces (id, user_id, name, folder, status, execution_mode) VALUES ('spc_test_1', 'u_test_1', 'Space A', 'space-a', 'active', 'container')").run();
  db.prepare("INSERT INTO channel_accounts (id, user_id, type, status) VALUES ('acc_lark_1', 'u_test_1', 'lark', 'active')").run();
  db.prepare("INSERT INTO session_routes (id, user_id, space_id, channel, dsh_session_id, status) VALUES ('ses_test_1', 'u_test_1', 'spc_test_1', 'lark', 'dsh_ses_1', 'active')").run();
  return db;
}

describe('/steer promotes a group sender\'s queued messages', () => {
  it('finds a message queued through dispatchInbound by its sender', async () => {
    const db = setupDb();
    db.prepare(`
      INSERT INTO turn_runs (id, turn_id, space_id, route_id, user_id, execution_mode, status, created_at, updated_at)
      VALUES ('run_r1', 'turn_r1', 'spc_test_1', 'ses_test_1', 'u_test_1', 'container', 'running', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run();

    const steerMock = vi.fn().mockResolvedValue({ ok: true });
    const gateway = new DeliveryRuntimeGateway({
      database: db,
      storage: null as any,
      messageStore: new SqliteWebMessageStore(db),
      executor: { execute: vi.fn(), cancel: vi.fn().mockResolvedValue(true), steerTurn: steerMock },
      quotaMode: 'disabled',
      profileResolver: { resolve: async () => null },
    });

    const envelope: InboundEnvelope = {
      id: 'deliv_test_000000000000000000000002',
      userId: 'u_test_1',
      sessionId: 'ses_test_1',
      content: 'queued follow-up',
      timestamp: new Date().toISOString(),
      channelContext: {
        channel: 'lark',
        accountId: 'acc_lark_1',
        chatId: 'oc_test_chat_001',
        nativeContextId: 'oc_test_chat_001',
        nativeEventId: 'om_test_msg_0001',
        replyToMessageId: 'om_test_msg_0001',
        senderId: 'ou_user_alpha',
        senderName: 'Alice',
        chatType: 'group',
      } as any,
    };
    const dispatched = await gateway.dispatchInbound(envelope);
    expect(dispatched.queuePosition).toBeGreaterThan(0);

    const inbox = db.prepare('SELECT payload FROM delivery_inbox WHERE turn_id = ?').get(dispatched.turnId) as { payload: string };
    expect(JSON.parse(inbox.payload).channelContext.senderId).toBe('ou_user_alpha');

    // Another member's /steer does not take Alice's message
    const other = await gateway.promoteQueuedToSteer('u_test_1', 'ses_test_1', { all: true, senderId: 'ou_user_beta' });
    expect(other.status).toBe('nothing_queued');

    const res = await gateway.promoteQueuedToSteer('u_test_1', 'ses_test_1', { all: true, senderId: 'ou_user_alpha' });
    expect(res.status).toBe('steered');
    expect(res.count).toBe(1);
    expect(steerMock).toHaveBeenCalledTimes(1);
    expect(steerMock.mock.calls[0][0].message).toContain('[发送者: Alice] queued follow-up');

  });
});
