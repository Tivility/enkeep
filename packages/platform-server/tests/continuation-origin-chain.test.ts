import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
} from '../src/storage/migrations.js';
import { SqliteStreamEventSource } from '../src/channels/sqlite-stream-event-source.js';

describe('Turn Origin Resolution Chain & Guards', () => {
  let db: DatabaseSync;
  let streamEventSource: SqliteStreamEventSource;

  const userId = 'usr_synth_chain_001';
  const spaceId = 'spc_synth_chain_001';
  const accountId = 'ca_synth_lark_001';
  const sessionRouteId = 'ses_route_synth_chain_001';
  const chatId = 'oc_synth_chat_001';

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'synth_user', 'hash')`).run(userId);
    db.prepare(`INSERT INTO spaces (id, user_id, name, folder, execution_mode, status) VALUES (?, ?, 'Synth Space', 'synth-space', 'container', 'active')`).run(spaceId, userId);
    db.prepare(`INSERT INTO channel_accounts (id, user_id, type, status) VALUES (?, ?, 'lark', 'active')`).run(accountId, userId);
    db.prepare(`INSERT INTO session_routes (id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id) VALUES (?, ?, ?, 'lark', ?, ?, ?, 'dsh_synth_chain_001')`).run(
      sessionRouteId,
      spaceId,
      userId,
      accountId,
      chatId,
      `lark:${chatId}`
    );

    streamEventSource = new SqliteStreamEventSource(db);
  });

  it('resolves direct platform turn origin immediately', async () => {
    const platTurnId = 'turn_synth_plat_001';
    db.prepare(`
      INSERT INTO channel_turn_origins (
        turn_id, user_id, session_id, account_id, channel, chat_id, native_context_id
      ) VALUES (?, ?, ?, ?, 'lark', ?, ?)
    `).run(platTurnId, userId, sessionRouteId, accountId, chatId, `lark:${chatId}`);

    const origin = await streamEventSource.resolveTurnOrigin(platTurnId);
    expect(origin).toBeDefined();
    expect(origin?.turnId).toBe(platTurnId);
    expect(origin?.sessionId).toBe(sessionRouteId);
    expect(origin?.chatId).toBe(chatId);
    expect(origin?.channel).toBe('lark');
  });

  it('resolves chain: platform -> auto1 -> auto2 to root platform origin', async () => {
    const platTurnId = 'turn_synth_plat_002';
    const auto1TurnId = 'turn_synth_auto_001';
    const auto2TurnId = 'turn_synth_auto_002';

    // 1. Root platform turn in channel_turn_origins
    db.prepare(`
      INSERT INTO channel_turn_origins (
        turn_id, user_id, session_id, account_id, channel, chat_id, native_context_id
      ) VALUES (?, ?, ?, ?, 'lark', ?, ?)
    `).run(platTurnId, userId, sessionRouteId, accountId, chatId, `lark:${chatId}`);

    // 2. auto1 turn launched by platform turn
    db.prepare(`
      INSERT INTO web_events (id, session_id, user_id, type, payload)
      VALUES ('evt_synth_auto1', ?, ?, 'turn_status', ?)
    `).run(
      sessionRouteId,
      userId,
      JSON.stringify({
        status: 'completed',
        turnId: auto1TurnId,
        originTurnId: platTurnId,
        causeChildId: 'subagent_001',
      })
    );

    // 3. auto2 turn launched inside auto1 continuation
    db.prepare(`
      INSERT INTO web_events (id, session_id, user_id, type, payload)
      VALUES ('evt_synth_auto2', ?, ?, 'turn_status', ?)
    `).run(
      sessionRouteId,
      userId,
      JSON.stringify({
        status: 'completed',
        turnId: auto2TurnId,
        originTurnId: auto1TurnId,
        causeChildId: 'subagent_002',
      })
    );

    // auto1 resolves to platform origin
    const origin1 = await streamEventSource.resolveTurnOrigin(auto1TurnId);
    expect(origin1).toBeDefined();
    expect(origin1?.turnId).toBe(platTurnId);
    expect(origin1?.chatId).toBe(chatId);

    // auto2 resolves all the way through auto1 to platform origin
    const origin2 = await streamEventSource.resolveTurnOrigin(auto2TurnId);
    expect(origin2).toBeDefined();
    expect(origin2?.turnId).toBe(platTurnId);
    expect(origin2?.chatId).toBe(chatId);
    expect(origin2?.sessionId).toBe(sessionRouteId);

    // Passing explicit sessionRouteId also resolves
    const origin2WithSession = await streamEventSource.resolveTurnOrigin(auto2TurnId, sessionRouteId);
    expect(origin2WithSession).toBeDefined();
    expect(origin2WithSession?.turnId).toBe(platTurnId);
  });

  it('aborts when root turn is unknown (no channel_turn_origins)', async () => {
    const unknownPlatId = 'turn_synth_unknown_root_001';
    const auto1TurnId = 'turn_synth_auto_orphan_001';
    const auto2TurnId = 'turn_synth_auto_orphan_002';

    // auto1 points to non-existent platform turn
    db.prepare(`
      INSERT INTO web_events (id, session_id, user_id, type, payload)
      VALUES ('evt_synth_orphan_1', ?, ?, 'turn_status', ?)
    `).run(
      sessionRouteId,
      userId,
      JSON.stringify({
        status: 'completed',
        turnId: auto1TurnId,
        originTurnId: unknownPlatId,
      })
    );

    // auto2 points to auto1
    db.prepare(`
      INSERT INTO web_events (id, session_id, user_id, type, payload)
      VALUES ('evt_synth_orphan_2', ?, ?, 'turn_status', ?)
    `).run(
      sessionRouteId,
      userId,
      JSON.stringify({
        status: 'completed',
        turnId: auto2TurnId,
        originTurnId: auto1TurnId,
      })
    );

    const origin = await streamEventSource.resolveTurnOrigin(auto2TurnId);
    expect(origin).toBeNull();

    // Unknown direct turn also returns null
    const directUnknown = await streamEventSource.resolveTurnOrigin('turn_synth_non_existent');
    expect(directUnknown).toBeNull();
  });

  it('cycle guard prevents infinite loop and aborts (returns null) on cyclic origins', async () => {
    const cyclicA = 'turn_synth_cycle_a';
    const cyclicB = 'turn_synth_cycle_b';

    // A points to B
    db.prepare(`
      INSERT INTO web_events (id, session_id, user_id, type, payload)
      VALUES ('evt_synth_cycle_a', ?, ?, 'turn_status', ?)
    `).run(
      sessionRouteId,
      userId,
      JSON.stringify({
        status: 'completed',
        turnId: cyclicA,
        originTurnId: cyclicB,
      })
    );

    // B points to A
    db.prepare(`
      INSERT INTO web_events (id, session_id, user_id, type, payload)
      VALUES ('evt_synth_cycle_b', ?, ?, 'turn_status', ?)
    `).run(
      sessionRouteId,
      userId,
      JSON.stringify({
        status: 'completed',
        turnId: cyclicB,
        originTurnId: cyclicA,
      })
    );

    const originA = await streamEventSource.resolveTurnOrigin(cyclicA);
    expect(originA).toBeNull();

    const originB = await streamEventSource.resolveTurnOrigin(cyclicB);
    expect(originB).toBeNull();

    // Self cycle (turn points to itself)
    const selfCycle = 'turn_synth_self_cycle';
    db.prepare(`
      INSERT INTO web_events (id, session_id, user_id, type, payload)
      VALUES ('evt_synth_self_cycle', ?, ?, 'turn_status', ?)
    `).run(
      sessionRouteId,
      userId,
      JSON.stringify({
        status: 'completed',
        turnId: selfCycle,
        originTurnId: selfCycle,
      })
    );

    const originSelf = await streamEventSource.resolveTurnOrigin(selfCycle);
    expect(originSelf).toBeNull();
  });

  it('aborts when recursion depth exceeds cap (8 hops)', async () => {
    const platTurnId = 'turn_synth_plat_deep';
    db.prepare(`
      INSERT INTO channel_turn_origins (
        turn_id, user_id, session_id, account_id, channel, chat_id, native_context_id
      ) VALUES (?, ?, ?, ?, 'lark', ?, ?)
    `).run(platTurnId, userId, sessionRouteId, accountId, chatId, `lark:${chatId}`);

    // Build chain of 10 hops: auto10 -> auto9 -> ... -> auto1 -> plat
    let prevTurnId = platTurnId;
    for (let i = 1; i <= 10; i++) {
      const turnId = `turn_synth_deep_${i}`;
      db.prepare(`
        INSERT INTO web_events (id, session_id, user_id, type, payload)
        VALUES (?, ?, ?, 'turn_status', ?)
      `).run(
        `evt_synth_deep_${i}`,
        sessionRouteId,
        userId,
        JSON.stringify({
          status: 'completed',
          turnId,
          originTurnId: prevTurnId,
        })
      );
      prevTurnId = turnId;
    }

    // turn 7 should resolve (<= 8 hops)
    const origin7 = await streamEventSource.resolveTurnOrigin('turn_synth_deep_7');
    expect(origin7).toBeDefined();
    expect(origin7?.turnId).toBe(platTurnId);

    // turn 10 exceeds depth cap of 8, so returns null
    const origin10 = await streamEventSource.resolveTurnOrigin('turn_synth_deep_10');
    expect(origin10).toBeNull();
  });
});
