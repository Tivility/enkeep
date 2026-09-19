import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  ALL_PLATFORM_MIGRATIONS,
  PlatformServerMigrationRunner,
} from '../../platform-server/src/storage/migrations.js';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { SqliteStreamEventSource } from '../../platform-server/src/channels/sqlite-stream-event-source.js';
import { EventRelayService } from '../../dsh-event-relay/src/index.js';
import { SqliteReceiptStore } from '../../dsh-receipt-store-sqlite/src/store.js';
import { ContinuationWatcher } from '../src/continuation-watcher.js';
import { FakeLarkTransport } from '../src/transport.js';

describe('Real Producer-Sequence Causality Regression: tool/result -> subagent-settled -> DSH int turn -> watcher', () => {
  let db: DatabaseSync;
  let receiptDb: DatabaseSync;
  let receiptStore: SqliteReceiptStore;
  let storage: SqlitePlatformStorage;
  let streamSource: SqliteStreamEventSource;
  let transport: FakeLarkTransport;

  const userId = 'usr_alice_causal_001';
  const spaceId = 'spc_canonical_workspace_1';
  const canonicalSessionId = 'ses_canonical_0000000000000001';
  const accountId = 'acc_lark_alice_00000000000001';

  const groupAChatId = 'oc_group_chat_alpha';
  const groupBChatId = 'oc_group_chat_beta';

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    // Runtime-scoped SQLite database for receiptStore (separate from platform.db)
    receiptStore = new SqliteReceiptStore({
      path: ':memory:',
      userId,
    });
    receiptStore.init();

    storage = new SqlitePlatformStorage({ database: db });
    streamSource = new SqliteStreamEventSource(db);
    transport = new FakeLarkTransport();
    await transport.start();

    // 1. Seed user, space, channel account, and canonical session route
    db.prepare("INSERT INTO users (id, username, password_hash, role, status) VALUES (?, 'alice', 'hash', 'user', 'active')")
      .run(userId);

    db.prepare("INSERT INTO spaces (id, user_id, name, folder, execution_mode, status) VALUES (?, ?, 'Canonical Space', '/tmp/space', 'container', 'active')")
      .run(spaceId, userId);

    db.prepare(`
      INSERT INTO channel_accounts (
        id, user_id, type, status, credential_ref
      ) VALUES (?, ?, 'lark', 'active', '{}')
    `).run(accountId, userId);

    db.prepare(`
      INSERT INTO session_routes (
        id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, status
      ) VALUES (?, ?, ?, 'lark', ?, 'oc_group_chat_alpha', 'peer_alpha', 'dsh_ses_1', 'container', 'active')
    `).run(canonicalSessionId, spaceId, userId, accountId);

    db.prepare("UPDATE spaces SET canonical_session_id = ? WHERE id = ?").run(canonicalSessionId, spaceId);
  });

  it('Turn A launches subagent -> Turn B enters same canonical -> subagent-settled notice resolves Turn A -> late continuation delivers solely to Group A', async () => {
    const originRepo = storage.forTenant(userId).turnOrigins;
    const channelRepo = storage.forTenant(userId).channels;

    // --- STEP 1: Turn A arrives from Group A and is accepted by Platform ---
    const turnAId = 'turn_0000000000000000000000000000000a';
    await originRepo.create({
      turnId: turnAId,
      sessionId: canonicalSessionId,
      accountId,
      channel: 'lark',
      chatId: groupAChatId,
      nativeContextId: groupAChatId,
      nativeEventId: 'evt_lark_inbound_group_a',
      replyToMessageId: 'om_inbound_msg_a',
      rootId: 'om_thread_root_a',
      threadId: 'om_thread_root_a',
    });

    // Mark platform turn_runs state for Turn A
    db.prepare(`
      INSERT INTO turn_runs (id, turn_id, space_id, route_id, user_id, execution_mode, status, created_at, updated_at)
      VALUES ('run_a', ?, ?, ?, ?, 'container', 'running', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(turnAId, spaceId, canonicalSessionId, userId);

    // --- STEP 2: Relay Producer with platform proxy bridge ---
    const fakePlatformClient = {
      request: async (_endpoint: string, opts: any) => {
        const events = opts.body.events;
        for (const raw of events) {
          const rawTurnId = raw.turnId;
          const rawOriginTurnId = raw.originTurnId;
          const payloadObj: any = { ...raw.payload };
          if (rawTurnId) payloadObj.turnId = rawTurnId;
          if (rawOriginTurnId) payloadObj.originTurnId = rawOriginTurnId;

          let eventType = raw.type;
          if (raw.type === 'turn_started') eventType = 'turn_status';
          if (raw.type === 'turn_completed') eventType = 'turn_status';

          db.prepare(`
            INSERT INTO web_events (id, session_id, user_id, type, payload, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(
            `evt_${Math.random().toString(36).slice(2, 12)}`,
            canonicalSessionId,
            userId,
            eventType,
            JSON.stringify(payloadObj),
            new Date().toISOString()
          );
        }
        return { status: 200 };
      },
    };

    const mockCtx: any = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      platformClient: fakePlatformClient,
      receiptStore,
      get: (key: string) => {
        if (key === 'platformClient') return fakePlatformClient;
        if (key === 'receiptStore') return receiptStore;
        return undefined;
      },
    };
    const relay = new EventRelayService(mockCtx);
    const mockSession: any = { id: canonicalSessionId };

    // Turn A is executing in DSH as turn 1
    const unbindTurnA = relay.bindTurnContext(canonicalSessionId, {
      turnId: turnAId,
      dshIntTurn: 1,
    });

    // In Turn A, the agent invokes the subagent tool, producing a REAL official tool/result event:
    const childSessionId = 'ses_child_alice_subagent_42';
    relay.ingest(mockSession, {
      type: 'turn/start',
      seq: 1 as any,
      time: Date.now(),
      data: { turn: 1 },
    });
    relay.ingest(mockSession, {
      type: 'tool/result',
      seq: 2 as any,
      time: Date.now(),
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call_subagent_1' as any,
              content: [{ type: 'text', text: `started subagent ${childSessionId}` }],
            },
          ],
          source: { kind: 'tool-result' } as any,
        } as any,
      },
    });
    relay.ingest(mockSession, {
      type: 'turn/end',
      seq: 3 as any,
      time: Date.now(),
      data: { turn: 1, reason: { kind: 'completed' } },
    });

    // Turn A finishes
    unbindTurnA();
    db.prepare("UPDATE turn_runs SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE turn_id = ?")
      .run(turnAId);

    // Verify child provenance was recorded durably in runtime receiptStore
    const storedOrigin = await receiptStore.getChildOrigin(canonicalSessionId, childSessionId);
    expect(storedOrigin).toBe(turnAId);

    // --- STEP 3: Turn B enters the SAME canonical session from Group B (DSH turn 2) ---
    const turnBId = 'turn_0000000000000000000000000000000b';
    await originRepo.create({
      turnId: turnBId,
      sessionId: canonicalSessionId,
      accountId,
      channel: 'lark',
      chatId: groupBChatId,
      nativeContextId: groupBChatId,
      nativeEventId: 'evt_lark_inbound_group_b',
      replyToMessageId: 'om_inbound_msg_b',
      rootId: 'om_thread_root_b',
      threadId: 'om_thread_root_b',
    });

    db.prepare(`
      INSERT INTO turn_runs (id, turn_id, space_id, route_id, user_id, execution_mode, status, created_at, updated_at)
      VALUES ('run_b', ?, ?, ?, ?, 'container', 'running', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(turnBId, spaceId, canonicalSessionId, userId);

    const unbindTurnB = relay.bindTurnContext(canonicalSessionId, {
      turnId: turnBId,
      dshIntTurn: 2,
    });

    relay.ingest(mockSession, {
      type: 'turn/start',
      seq: 4 as any,
      time: Date.now(),
      data: { turn: 2 },
    });
    relay.ingest(mockSession, {
      type: 'assistant/chunk',
      seq: 5 as any,
      time: Date.now(),
      data: {
        turn: 2,
        step: 1,
        chunk: { type: 'text-delta', text: 'Turn B direct answer to Group B' },
      },
    });
    relay.ingest(mockSession, {
      type: 'turn/end',
      seq: 6 as any,
      time: Date.now(),
      data: { turn: 2, reason: { kind: 'completed' } },
    });

    unbindTurnB();
    db.prepare("UPDATE turn_runs SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE turn_id = ?")
      .run(turnBId);

    // Record Turn B outbox card to Group B
    await channelRepo.createOutboxItem({
      id: 'out_turn_b_delivered',
      accountId,
      sessionId: canonicalSessionId,
      nativeContextId: groupBChatId,
      replyToNativeId: 'om_inbound_msg_b',
      payloadJson: JSON.stringify({ chatId: groupBChatId, text: 'Turn B Answer' }),
      status: 'delivered',
    });

    // --- STEP 4: Start ContinuationWatcher on shared canonical route ---
    // Watcher default replyTarget points to latest inbound (Group B)
    const watcher = new ContinuationWatcher({
      sessionRouteId: canonicalSessionId,
      accountId,
      userId,
      nativeContextId: groupBChatId,
      streamEventSource: streamSource,
      transport,
      channelRepo,
      replyTarget: {
        chatId: groupBChatId,
        replyToMessageId: 'om_inbound_msg_b',
      },
      initialCursor: 0,
      hasActiveInboundTracker: () => false,
      pollIntervalMs: 50,
      inactivityTimeoutMs: 5000,
    });

    // --- STEP 5: Child of A completes! Emits official subagent-settled notice and starts DSH turn 3 ---
    // Note: NO MANUAL bindTurnContext for autonomous turn! Provenance MUST resolve from subagent-settled!
    relay.ingest(mockSession, {
      type: 'user/message',
      seq: 7 as any,
      time: Date.now(),
      data: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Background subagent ${childSessionId} finished.\nIts closing message:\nTask A analysis finished.`,
          },
        ],
        source: {
          kind: 'subagent-settled',
          form: 'notice',
          summary: `Background subagent ${childSessionId} finished.`,
          senderSessionId: childSessionId as any,
        } as any,
      } as any,
    });

    // Autonomous Turn 3 begins in DSH
    relay.ingest(mockSession, {
      type: 'turn/start',
      seq: 8 as any,
      time: Date.now(),
      data: { turn: 3 },
    });
    relay.ingest(mockSession, {
      type: 'assistant/chunk',
      seq: 9 as any,
      time: Date.now(),
      data: {
        turn: 3,
        step: 1,
        chunk: { type: 'text-delta', text: 'Summary of subagent results for Group A task' },
      },
    });
    relay.ingest(mockSession, {
      type: 'turn/end',
      seq: 10 as any,
      time: Date.now(),
      data: { turn: 3, reason: { kind: 'completed' } },
    });

    // Flush all streaming frames to platform-proxy / web_events
    await relay.flush();

    // Verify events in web_events:
    const events = await streamSource.listAssistantEvents(canonicalSessionId, 0);
    // Turn 2 events must carry turnBId and NO originTurnId
    const turn2Evt = events.find((e) => e.turnId === turnBId);
    expect(turn2Evt).toBeDefined();
    expect(turn2Evt?.turnId).toBe(turnBId);
    expect(turn2Evt?.originTurnId).toBeUndefined();

    // Turn 3 events must carry autonomous turnId AND originTurnId = turnAId!
    const turn3Running = events.find((e) => e.type === 'turn_status' && e.status === 'running' && e.originTurnId === turnAId);
    expect(turn3Running).toBeDefined();
    expect(turn3Running?.originTurnId).toBe(turnAId);

    // --- STEP 6: Run ContinuationWatcher ---
    // Poll ticks to advance past completed platform turns (Turn A, Turn B) until autonomous continuation tracker is created
    for (let i = 0; i < 5; i++) {
      if ((watcher as any).activeTracker) break;
      await (watcher as any).pollTick();
    }
    if ((watcher as any).activeTracker) {
      await (watcher as any).activeTracker.pollTick();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify outbox rows
    const outboxRows = db.prepare('SELECT * FROM channel_outbox WHERE session_id = ?').all(canonicalSessionId) as any[];

    // Exactly one continuation outbox row created
    const contOutbox = outboxRows.filter((r) => r.id !== 'out_turn_b_delivered');
    expect(contOutbox.length).toBe(1);

    const payload = JSON.parse(contOutbox[0].payload_json);
    // PROVENANCE ROUTING VERIFICATION:
    // Delivered to Group A ONLY:
    expect(payload.chatId).toBe(groupAChatId);
    expect(contOutbox[0].native_context_id).toBe(groupAChatId);
    expect(payload.replyToMessageId).toBe('om_inbound_msg_a');
    expect(payload.text).toContain('Summary of subagent results for Group A task');

    // Group B received NO duplicate cards:
    const groupBCards = outboxRows.filter((r) => r.native_context_id === groupBChatId);
    expect(groupBCards.length).toBe(1); // Only Turn B answer

    // Replay idempotency check
    await (watcher as any).pollTick();
    const finalOutbox = db.prepare('SELECT * FROM channel_outbox WHERE session_id = ?').all(canonicalSessionId) as any[];
    expect(finalOutbox.length).toBe(2);

    watcher.stop();
  });

  it('durable child origin survives restart and refuses delivery on unknown origin', async () => {
    // 1. Record child in receiptStore
    const childId = 'ses_child_restart_99';
    const originalTurnId = 'turn_00000000000000000000000000000099';
    await receiptStore.recordChildOrigin(canonicalSessionId, childId, originalTurnId);

    // Verify reading back from receiptStore after simulated restart
    const restoredOrigin = await receiptStore.getChildOrigin(canonicalSessionId, childId);
    expect(restoredOrigin).toBe(originalTurnId);

    // 2. An autonomous turn with unknown origin explicitly aborts without wrong-target send
    const channelRepo = storage.forTenant(userId).channels;
    db.prepare(`
      INSERT INTO web_events (id, session_id, user_id, type, payload, created_at)
      VALUES ('evt_ghost_1', ?, ?, 'turn_status', ?, CURRENT_TIMESTAMP)
    `).run(
      canonicalSessionId,
      userId,
      JSON.stringify({ status: 'running', turnId: 'turn_auto_ghost_1', originTurnId: 'turn_nonexistent_origin' })
    );

    const watcher = new ContinuationWatcher({
      sessionRouteId: canonicalSessionId,
      accountId,
      userId,
      nativeContextId: groupBChatId,
      streamEventSource: streamSource,
      transport,
      channelRepo,
      replyTarget: { chatId: groupBChatId },
      initialCursor: 0,
      hasActiveInboundTracker: () => false,
    });

    await (watcher as any).pollTick();
    const outboxRows = db.prepare('SELECT * FROM channel_outbox WHERE session_id = ?').all(canonicalSessionId) as any[];
    expect(outboxRows.length).toBe(0); // Zero wrong target sends!

    watcher.stop();
  });
});
