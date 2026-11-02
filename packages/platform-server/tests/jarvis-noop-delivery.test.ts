import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { DeliveryRuntimeGateway } from '../src/runtime/delivery-gateway.js';
import { resolveTaskRouteTarget } from '../src/notifications/task-failure-notifier.js';

/**
 * Jarvis is a valid channel without IM chats: task failure notices for a jarvis delivery stay in
 * the session (in-app), and background tasks started from a Jarvis turn are listed for the whole
 * session (Web/Jarvis) but never in a Lark/WeChat chat-filtered view.
 */
describe('jarvis as a no-op delivery channel (platform-server)', () => {
  const userId = 'user-alice';
  const spaceId = 'spc_00000000000000000000000000000001';
  const sessionId = 'ses_00000000000000000000000000000001';
  const dshSessionId = 'ses_00000000000000000000000000000101';
  const larkChat = 'oc_test0000000000000000000000000001';
  const jarvisContext = `${larkChat}:jarvis-context-01`;
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE spaces (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, folder TEXT NOT NULL,
        execution_mode TEXT NOT NULL DEFAULT 'container');
      CREATE TABLE session_routes (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, user_id TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'web', account_id TEXT, native_context_id TEXT, dsh_session_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', current_generation INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE channel_accounts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active');
      CREATE TABLE channel_bindings (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, user_id TEXT NOT NULL,
        account_id TEXT, native_context_id TEXT NOT NULL, session_route_id TEXT);
      CREATE TABLE channel_turn_origins (turn_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_id TEXT NOT NULL,
        account_id TEXT NOT NULL, channel TEXT NOT NULL, chat_id TEXT NOT NULL, native_context_id TEXT NOT NULL,
        native_event_id TEXT, reply_to_message_id TEXT, root_id TEXT, thread_id TEXT, origin_turn_id TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE web_events (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, user_id TEXT NOT NULL, type TEXT NOT NULL,
        payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE session_child_origins (session_id TEXT NOT NULL, child_id TEXT NOT NULL, origin_turn_id TEXT NOT NULL,
        PRIMARY KEY(session_id, child_id));
    `);
    db.prepare(`INSERT INTO spaces (id, user_id, name, folder) VALUES (?, ?, 'Alice Space', 'alice-space')`).run(spaceId, userId);
    db.prepare(`
      INSERT INTO session_routes (id, space_id, user_id, channel, account_id, native_context_id, dsh_session_id)
      VALUES (?, ?, ?, 'lark', 'acc_test_lark_01', ?, ?)
    `).run(sessionId, spaceId, userId, larkChat, dshSessionId);
    db.prepare(`INSERT INTO channel_accounts (id, user_id, type) VALUES ('acc_test_lark_01', ?, 'lark')`).run(userId);
    db.prepare(`INSERT INTO channel_accounts (id, user_id, type) VALUES ('acc_test_jarvis_01', ?, 'jarvis')`).run(userId);
    db.prepare(`
      INSERT INTO channel_bindings (id, space_id, user_id, account_id, native_context_id)
      VALUES ('cb_test_01', ?, ?, 'acc_test_lark_01', ?)
    `).run(spaceId, userId, larkChat);
    db.prepare(`
      INSERT INTO channel_turn_origins (turn_id, user_id, session_id, account_id, channel, chat_id, native_context_id)
      VALUES ('turn_test_jarvis_0001', ?, ?, 'acc_test_jarvis_01', 'jarvis', ?, ?)
    `).run(userId, sessionId, jarvisContext, jarvisContext);
    db.prepare(`
      INSERT INTO channel_turn_origins (turn_id, user_id, session_id, account_id, channel, chat_id, native_context_id)
      VALUES ('turn_test_lark_0001', ?, ?, 'acc_test_lark_01', 'lark', ?, ?)
    `).run(userId, sessionId, larkChat, larkChat);
  });

  it('keeps failure notices of a jarvis delivery in-app instead of the anchor Lark chat', () => {
    const target = resolveTaskRouteTarget(db, {
      id: 'task_test_0001',
      userId,
      title: 'synthetic',
      payload: {
        type: 'agent_prompt',
        sessionId,
        spaceId,
        delivery: { channel: 'jarvis', accountId: 'acc_test_jarvis_01', nativeContextId: 'jarvis-context-01' },
      },
    } as any);
    expect(target).toEqual({ kind: 'in_app', sessionId });

    const larkTarget = resolveTaskRouteTarget(db, {
      id: 'task_test_0002',
      userId,
      title: 'synthetic',
      payload: { type: 'agent_prompt', sessionId, spaceId },
    } as any);
    expect(larkTarget).toMatchObject({ kind: 'im', channel: 'lark', nativeContextId: larkChat });
  });

  it('lists jarvis-origin background tasks for the session but not in a Lark chat view', async () => {
    const now = new Date().toISOString();
    const executor = {
      execute: async () => ({ replyText: 'synthetic' }),
      cancel: async () => true,
      listBackgroundTasks: async () => [
        { id: 'subagent_test_jarvis_01', shortId: 'jv01', kind: 'subagent', name: 'From Jarvis', status: 'running',
          startedAt: now, lastActivityAt: now, originTurnId: 'turn_test_jarvis_0001' },
        { id: 'subagent_test_lark_01', shortId: 'lk01', kind: 'subagent', name: 'From Lark', status: 'running',
          startedAt: now, lastActivityAt: now, originTurnId: 'turn_test_lark_0001' },
      ],
      stopBackgroundTask: async () => ({ stopped: true }),
    };
    const gateway = new DeliveryRuntimeGateway({
      storage: {} as any,
      messageStore: {} as any,
      database: db,
      executor: executor as any,
      quotaMode: 'disabled',
      profileResolver: { resolve: async () => ({ profileId: 'default' }) } as any,
    });

    const all = await gateway.getBackgroundTasks(userId, sessionId);
    expect(all.items.map((t) => t.shortId).sort()).toEqual(['jv01', 'lk01']);

    const larkView = await gateway.getBackgroundTasks(userId, sessionId, { chatContextId: larkChat });
    expect(larkView.items.map((t) => t.shortId)).toEqual(['lk01']);
  });
});
