import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import { EventRelayService } from '../src/service.js';
import { SqliteReceiptStore } from '../../dsh-receipt-store-sqlite/src/index.js';
import { SqliteStreamEventSource } from '../../platform-server/src/channels/sqlite-stream-event-source.js';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
} from '../../platform-server/src/storage/migrations.js';

describe('DSH 0.2 Autonomous Continuation Origin Integration Tests', () => {
  let ctx: Context;
  let dispatchedFrames: any[];
  let mockPlatformClient: { request: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    ctx = new Context();
    dispatchedFrames = [];
    mockPlatformClient = {
      request: vi.fn().mockImplementation(async (_endpoint: string, opts: any) => {
        if (opts?.body?.events) {
          dispatchedFrames.push(...opts.body.events);
        }
        return { status: 200, data: { success: true } };
      }),
    };
    ctx.platformClient = mockPlatformClient as any;
  });

  it('1. subagent start -> turn end -> settle notice -> autonomous turn carries turnId + originTurnId + causeChildId without phantom autoCtx pollution', async () => {
    const service = new EventRelayService(ctx);
    const session = { id: 'ses_synth_subagent_001' } as Session;
    const platTurnId = 'turn_synth_plat_001';
    const childId = 'child_synth_subagent_001';

    // 1. Platform turn starts and launches subagent
    service.bindTurnContext(session.id, {
      turnId: platTurnId,
      dshIntTurn: 1,
    });
    service.ingest(session, {
      type: 'turn/start',
      seq: 1,
      time: 100,
      data: { turn: 1 },
    });
    // DSH 0.2 structured event: subagent/catalog
    service.ingest(session, {
      type: 'subagent/catalog',
      seq: 2,
      time: 101,
      data: { childId, mode: 'continuable', label: 'Synthetic Subagent' },
    });
    // tool/result event
    service.ingest(session, {
      type: 'tool/result',
      seq: 3,
      time: 102,
      data: {
        turn: 1,
        message: { content: `started subagent ${childId}` },
      },
    });
    service.ingest(session, {
      type: 'assistant/chunk',
      seq: 4,
      time: 103,
      data: { turn: 1, chunk: { type: 'text-delta', text: 'Subagent launched.' } },
    });
    service.ingest(session, {
      type: 'turn/end',
      seq: 5,
      time: 104,
      data: { turn: 1, reason: { kind: 'completed' } },
    });

    // Verify turn 1 completed frame carries platTurnId, NOT a phantom autoTurnId
    await service.flush();
    const turn1Completed = dispatchedFrames.find((f) => f.type === 'turn_completed' && f.payload?.status === 'completed');
    expect(turn1Completed).toBeDefined();
    expect(turn1Completed.turnId).toBe(platTurnId);

    // Verify activeTurnContexts was NOT polluted with a phantom autoCtx
    expect((service as any).activeTurnContexts.has(session.id)).toBe(false);

    // 2. Child settles: agent/inbox/spliced
    service.ingest(session, {
      type: 'agent/inbox/spliced',
      seq: 6,
      time: 110,
      data: {
        inserted: [
          {
            source: {
              kind: 'agent-message',
              form: 'relay',
              senderSessionId: childId,
            },
            message: { content: 'Synthetic subagent completed task.' },
          },
        ],
      },
    });

    // 3. Autonomous continuation turn begins
    service.ingest(session, {
      type: 'turn/start',
      seq: 7,
      time: 111,
      data: { turn: 2 },
    });
    service.ingest(session, {
      type: 'assistant/chunk',
      seq: 8,
      time: 112,
      data: { turn: 2, chunk: { type: 'text-delta', text: 'Autonomous turn response.' } },
    });
    service.ingest(session, {
      type: 'turn/end',
      seq: 9,
      time: 113,
      data: { turn: 2, reason: { kind: 'completed' } },
    });

    await service.flush();

    // 4. Assert autonomous turn frames carry turnId + originTurnId + causeChildId
    const autoFrames = dispatchedFrames.filter((f) => f.payload?.delta === 'Autonomous turn response.' || (f.turnId?.startsWith('turn_auto_') && f.originTurnId === platTurnId));
    expect(autoFrames.length).toBeGreaterThan(0);
    for (const frame of autoFrames) {
      expect(frame.turnId).toMatch(/^turn_auto_/);
      expect(frame.originTurnId).toBe(platTurnId);
      expect(frame.causeChildId).toBe(childId);
    }

    // Active contexts must be clean after turn/end
    expect((service as any).activeTurnContexts.has(session.id)).toBe(false);
  });

  it('2. background workflow job -> turn end -> settle notice -> autonomous turn carries causal metadata', async () => {
    const service = new EventRelayService(ctx);
    const session = { id: 'ses_synth_wf_002' } as Session;
    const platTurnId = 'turn_synth_plat_wf_002';
    const jobId = 'workflow-synth-job-42';

    // 1. Platform turn launches workflow
    service.bindTurnContext(session.id, {
      turnId: platTurnId,
      dshIntTurn: 1,
    });
    service.ingest(session, {
      type: 'turn/start',
      seq: 1,
      time: 200,
      data: { turn: 1 },
    });
    service.ingest(session, {
      type: 'tool/call',
      seq: 2,
      time: 201,
      data: {
        name: 'workflow',
        arguments: { meta: { name: 'synth-flow' } },
      },
    });
    service.ingest(session, {
      type: 'tool/result',
      seq: 3,
      time: 202,
      data: {
        turn: 1,
        message: { content: `workflow "synth-flow" started in the background as job ${jobId}.` },
      },
    });
    service.ingest(session, {
      type: 'turn/end',
      seq: 4,
      time: 203,
      data: { turn: 1, reason: { kind: 'completed' } },
    });

    await service.flush();
    expect((service as any).activeTurnContexts.has(session.id)).toBe(false);

    // 2. Workflow job completion notice
    service.ingest(session, {
      type: 'agent/inbox/spliced',
      seq: 5,
      time: 210,
      data: {
        inserted: [
          {
            source: {
              kind: 'tool-jobs',
              summary: 'workflow workflow: synth-flow [status: completed]',
            },
            message: { content: `background job ${jobId} finished` },
          },
        ],
      },
    });

    // 3. Autonomous continuation turn begins
    service.ingest(session, {
      type: 'turn/start',
      seq: 6,
      time: 211,
      data: { turn: 2 },
    });
    service.ingest(session, {
      type: 'assistant/chunk',
      seq: 7,
      time: 212,
      data: { turn: 2, chunk: { type: 'text-delta', text: 'Workflow result analyzed.' } },
    });
    service.ingest(session, {
      type: 'turn/end',
      seq: 8,
      time: 213,
      data: { turn: 2, reason: { kind: 'completed' } },
    });

    await service.flush();

    // 4. Assert frames carry origin metadata
    const autoFrames = dispatchedFrames.filter((f) => f.payload?.delta === 'Workflow result analyzed.' || (f.turnId?.startsWith('turn_auto_') && f.originTurnId === platTurnId));
    expect(autoFrames.length).toBeGreaterThan(0);
    for (const frame of autoFrames) {
      expect(frame.turnId).toMatch(/^turn_auto_/);
      expect(frame.originTurnId).toBe(platTurnId);
      expect(frame.causeChildId).toBe(jobId);
    }
  });

  it('3. simulated restart between start and settle: restores child origin from receiptStore', async () => {
    // Shared receiptStore instance across simulated restart
    const receiptStore = new SqliteReceiptStore({
      path: ':memory:',
      userId: 'usr_synth_restart_001',
    });
    receiptStore.init();

    const session = { id: 'ses_synth_restart_003' } as Session;
    const platTurnId = 'turn_synth_plat_restart_003';
    const childId = 'child_synth_restart_003';

    // Instance 1: boots, launches subagent, records origin in memory and receiptStore, then terminates
    const ctx1 = new Context();
    ctx1.platformClient = mockPlatformClient as any;
    ctx1.provide('receiptStore', receiptStore);
    const relay1 = new EventRelayService(ctx1);

    relay1.bindTurnContext(session.id, {
      turnId: platTurnId,
      dshIntTurn: 1,
    });
    relay1.ingest(session, {
      type: 'turn/start',
      seq: 1,
      time: 300,
      data: { turn: 1 },
    });
    relay1.ingest(session, {
      type: 'subagent/catalog',
      seq: 2,
      time: 301,
      data: { childId, mode: 'continuable' },
    });
    relay1.ingest(session, {
      type: 'tool/result',
      seq: 3,
      time: 302,
      data: {
        turn: 1,
        message: { content: `started subagent ${childId}` },
      },
    });
    relay1.ingest(session, {
      type: 'turn/end',
      seq: 4,
      time: 303,
      data: { turn: 1, reason: { kind: 'completed' } },
    });

    await relay1.flush();
    relay1.clear();

    // Verify origin was written into receiptStore
    const stored = await receiptStore.getChildOrigin(session.id, childId);
    expect(stored).toBe(platTurnId);

    // SIMULATED RESTART: Instance 2 starts with fresh memory, sharing same receiptStore
    const ctx2 = new Context();
    ctx2.platformClient = mockPlatformClient as any;
    ctx2.provide('receiptStore', receiptStore);
    const relay2 = new EventRelayService(ctx2);

    // Relay 2 in-memory childOriginMap is completely empty
    expect((relay2 as any).childOriginMap.has(childId)).toBe(false);

    // Settle notice arrives on Relay 2
    relay2.ingest(session, {
      type: 'agent/inbox/spliced',
      seq: 5,
      time: 310,
      data: {
        inserted: [
          {
            source: {
              kind: 'subagent-settled',
              senderSessionId: childId,
            },
            message: { content: 'Subagent settled after restart.' },
          },
        ],
      },
    });

    // Autonomous turn starts on Relay 2
    relay2.ingest(session, {
      type: 'turn/start',
      seq: 6,
      time: 311,
      data: { turn: 2 },
    });
    relay2.ingest(session, {
      type: 'assistant/chunk',
      seq: 7,
      time: 312,
      data: { turn: 2, chunk: { type: 'text-delta', text: 'Restarted continuation response.' } },
    });
    relay2.ingest(session, {
      type: 'turn/end',
      seq: 8,
      time: 313,
      data: { turn: 2, reason: { kind: 'completed' } },
    });

    await relay2.flush();

    // Verify Relay 2 consulted store and successfully stamped origin metadata
    const restartedFrames = dispatchedFrames.filter(
      (f) => f.payload?.delta === 'Restarted continuation response.' || (f.turnId?.startsWith('turn_auto_') && f.originTurnId === platTurnId)
    );
    expect(restartedFrames.length).toBeGreaterThan(0);
    for (const frame of restartedFrames) {
      expect(frame.turnId).toMatch(/^turn_auto_/);
      expect(frame.originTurnId).toBe(platTurnId);
      expect(frame.causeChildId).toBe(childId);
    }
  });

  it('4. parallel subagents: distinctly attribute separate autonomous turns', async () => {
    const service = new EventRelayService(ctx);
    const session = { id: 'ses_synth_parallel_004' } as Session;
    const platTurnId = 'turn_synth_plat_par_004';
    const childAlpha = 'child_synth_alpha_004';
    const childBeta = 'child_synth_beta_004';

    // 1. Initial turn launches both Alpha and Beta
    service.bindTurnContext(session.id, {
      turnId: platTurnId,
      dshIntTurn: 1,
    });
    service.ingest(session, { type: 'turn/start', seq: 1, time: 400, data: { turn: 1 } });
    service.ingest(session, {
      type: 'tool/result',
      seq: 2,
      time: 401,
      data: { turn: 1, message: { content: `started subagent ${childAlpha}` } },
    });
    service.ingest(session, {
      type: 'tool/result',
      seq: 3,
      time: 402,
      data: { turn: 1, message: { content: `started subagent ${childBeta}` } },
    });
    service.ingest(session, { type: 'turn/end', seq: 4, time: 403, data: { turn: 1, reason: { kind: 'completed' } } });

    // 2. Both children settle in inbox
    service.ingest(session, {
      type: 'agent/inbox/spliced',
      seq: 5,
      time: 410,
      data: {
        inserted: [
          { source: { kind: 'agent-message', form: 'relay', senderSessionId: childAlpha }, message: { content: 'Alpha done.' } },
          { source: { kind: 'agent-message', form: 'relay', senderSessionId: childBeta }, message: { content: 'Beta done.' } },
        ],
      },
    });

    // 3. Autonomous turn 2 for Alpha
    service.ingest(session, { type: 'turn/start', seq: 6, time: 411, data: { turn: 2 } });
    service.ingest(session, {
      type: 'assistant/chunk',
      seq: 7,
      time: 412,
      data: { turn: 2, chunk: { type: 'text-delta', text: 'Alpha reply.' } },
    });
    service.ingest(session, { type: 'turn/end', seq: 8, time: 413, data: { turn: 2, reason: { kind: 'completed' } } });

    // 4. Autonomous turn 3 for Beta
    service.ingest(session, { type: 'turn/start', seq: 9, time: 414, data: { turn: 3 } });
    service.ingest(session, {
      type: 'assistant/chunk',
      seq: 10,
      time: 415,
      data: { turn: 3, chunk: { type: 'text-delta', text: 'Beta reply.' } },
    });
    service.ingest(session, { type: 'turn/end', seq: 11, time: 416, data: { turn: 3, reason: { kind: 'completed' } } });

    await service.flush();

    // Assert Alpha turn
    const alphaFrames = dispatchedFrames.filter((f) => f.causeChildId === childAlpha);
    expect(alphaFrames.length).toBeGreaterThan(0);
    expect(alphaFrames[0].originTurnId).toBe(platTurnId);
    expect(alphaFrames[0].causeChildId).toBe(childAlpha);

    // Assert Beta turn
    const betaFrames = dispatchedFrames.filter((f) => f.causeChildId === childBeta);
    expect(betaFrames.length).toBeGreaterThan(0);
    expect(betaFrames[0].originTurnId).toBe(platTurnId);
    expect(betaFrames[0].causeChildId).toBe(childBeta);
    expect(betaFrames[0].turnId).not.toBe(alphaFrames[0].turnId);
  });

  it('5. nested continuation: child of autonomous turn resolves via platform-server chain resolver', async () => {
    const db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    const userId = 'usr_synth_nested_001';
    const spaceId = 'spc_synth_nested_001';
    const accountId = 'ca_synth_nested_001';
    const sessionRouteId = 'ses_route_synth_nested_001';
    const chatId = 'oc_synth_chat_nested_001';

    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'nested_user', 'hash')`).run(userId);
    db.prepare(`INSERT INTO spaces (id, user_id, name, folder, execution_mode, status) VALUES (?, ?, 'Synth Space', 'synth-space', 'container', 'active')`).run(spaceId, userId);
    db.prepare(`INSERT INTO channel_accounts (id, user_id, type, status) VALUES (?, ?, 'lark', 'active')`).run(accountId, userId);
    db.prepare(`INSERT INTO session_routes (id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id) VALUES (?, ?, ?, 'lark', ?, ?, ?, 'dsh_nested_001')`).run(
      sessionRouteId,
      spaceId,
      userId,
      accountId,
      chatId,
      `lark:${chatId}`
    );

    const streamEventSource = new SqliteStreamEventSource(db);

    const rootPlatformTurnId = 'turn_synth_root_plat_005';
    const autoTurn1Id = 'turn_synth_auto_1_005';
    const autoTurn2Id = 'turn_synth_auto_2_005';

    // Root platform turn in channel_turn_origins
    db.prepare(`
      INSERT INTO channel_turn_origins (
        turn_id, user_id, session_id, account_id, channel, chat_id, native_context_id
      ) VALUES (?, ?, ?, ?, 'lark', ?, ?)
    `).run(rootPlatformTurnId, userId, sessionRouteId, accountId, chatId, `lark:${chatId}`);

    // auto1 emitted by platform turn
    db.prepare(`
      INSERT INTO web_events (id, session_id, user_id, type, payload)
      VALUES ('evt_synth_auto1_nested', ?, ?, 'turn_status', ?)
    `).run(
      sessionRouteId,
      userId,
      JSON.stringify({
        status: 'completed',
        turnId: autoTurn1Id,
        originTurnId: rootPlatformTurnId,
        causeChildId: 'child_1',
      })
    );

    // auto2 launched inside auto1
    db.prepare(`
      INSERT INTO web_events (id, session_id, user_id, type, payload)
      VALUES ('evt_synth_auto2_nested', ?, ?, 'turn_status', ?)
    `).run(
      sessionRouteId,
      userId,
      JSON.stringify({
        status: 'completed',
        turnId: autoTurn2Id,
        originTurnId: autoTurn1Id,
        causeChildId: 'child_2_nested',
      })
    );

    // Chain resolver resolves autoTurn2Id -> autoTurn1Id -> rootPlatformTurnId
    const resolved = await streamEventSource.resolveTurnOrigin(autoTurn2Id, sessionRouteId);
    expect(resolved).toBeDefined();
    expect(resolved?.turnId).toBe(rootPlatformTurnId);
    expect(resolved?.chatId).toBe(chatId);
    expect(resolved?.channel).toBe('lark');
  });

  it('6. safe fallback rule: positive and negative cases', async () => {
    const db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    const userId = 'usr_synth_fb_001';
    const spaceId = 'spc_synth_fb_001';
    const accountId = 'ca_synth_fb_001';
    const sessionRouteId = 'ses_route_synth_fb_001';
    const chatId = 'oc_synth_chat_fb_001';

    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'fb_user', 'hash')`).run(userId);
    db.prepare(`INSERT INTO spaces (id, user_id, name, folder, execution_mode, status) VALUES (?, ?, 'Synth Space', 'synth-space', 'container', 'active')`).run(spaceId, userId);
    db.prepare(`INSERT INTO channel_accounts (id, user_id, type, status) VALUES (?, ?, 'lark', 'active')`).run(accountId, userId);
    db.prepare(`INSERT INTO session_routes (id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id) VALUES (?, ?, ?, 'lark', ?, ?, ?, 'dsh_fb_001')`).run(
      sessionRouteId,
      spaceId,
      userId,
      accountId,
      chatId,
      `lark:${chatId}`
    );

    const streamEventSource = new SqliteStreamEventSource(db);

    const platTurnRecent = 'turn_synth_fb_recent_006';
    const unmappedAutoTurn = 'turn_synth_fb_auto_orphan_006';

    // Positive case: 1 platform turn in last 24h for this session pointing to oc_synth_chat_fb_001
    db.prepare(`
      INSERT INTO channel_turn_origins (
        turn_id, user_id, session_id, account_id, channel, chat_id, native_context_id, created_at
      ) VALUES (?, ?, ?, ?, 'lark', ?, ?, datetime('now', '-10 minutes'))
    `).run(platTurnRecent, userId, sessionRouteId, accountId, chatId, `lark:${chatId}`);

    const positiveOrigin = await streamEventSource.resolveTurnOrigin(unmappedAutoTurn, sessionRouteId);
    expect(positiveOrigin).toBeDefined();
    expect(positiveOrigin?.turnId).toBe(platTurnRecent);
    expect(positiveOrigin?.chatId).toBe(chatId);

    // Negative case 1: Multiple conflicting chat contexts in last 24h
    db.prepare(`
      INSERT INTO channel_turn_origins (
        turn_id, user_id, session_id, account_id, channel, chat_id, native_context_id, created_at
      ) VALUES ('turn_synth_conflict_chat', ?, ?, ?, 'lark', 'oc_diff_chat_002', 'lark:oc_diff_chat_002', datetime('now', '-5 minutes'))
    `).run(userId, sessionRouteId, accountId);

    const conflictOrigin = await streamEventSource.resolveTurnOrigin(unmappedAutoTurn, sessionRouteId);
    expect(conflictOrigin).toBeNull();

    // Negative case 2: Session with no channel origins in last 24h
    const emptySessionRouteId = 'ses_route_synth_fb_empty_002';
    db.prepare(`INSERT INTO session_routes (id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id) VALUES (?, ?, ?, 'lark', ?, 'oc_empty', 'lark:oc_empty', 'dsh_empty')`).run(
      emptySessionRouteId,
      spaceId,
      userId,
      accountId
    );
    const emptyOrigin = await streamEventSource.resolveTurnOrigin(unmappedAutoTurn, emptySessionRouteId);
    expect(emptyOrigin).toBeNull();
  });
});
