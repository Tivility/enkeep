import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  SqlitePlatformStorage,
  MIGRATION_001_SQL,
  MIGRATION_002_SQL,
  MIGRATION_009_AGENT_PROFILES_LIFECYCLE_AND_GENERATIONS_SQL,
  MIGRATION_031_GENERIC_CHANNELS_SQL,
  MIGRATION_036_SPACE_CANONICAL_SESSION_SQL,
  MIGRATION_037_CHANNEL_TURN_ORIGINS_SQL,
} from '../src/index.js';
import { ValidationError, NotFoundError } from '@enkeep/platform-core';

describe('SqliteTenantScopedTurnOriginRepository', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  const userAlice = 'usr_alice_001';
  const userBob = 'usr_bob_002';
  const spaceId = 'spc_00000000000000000000000000000001';
  const sessionId = 'ses_00000000000000000000000000000001';
  const accountId = 'acc_lark_000000000000000000000001';

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    db.exec(MIGRATION_001_SQL);
    db.exec(MIGRATION_002_SQL);
    db.exec(MIGRATION_009_AGENT_PROFILES_LIFECYCLE_AND_GENERATIONS_SQL);
    db.exec(MIGRATION_031_GENERIC_CHANNELS_SQL);
    db.exec(MIGRATION_036_SPACE_CANONICAL_SESSION_SQL);
    db.exec(MIGRATION_037_CHANNEL_TURN_ORIGINS_SQL);

    storage = new SqlitePlatformStorage({ database: db });

    // Seed users
    db.prepare("INSERT INTO users (id, username, password_hash, role, status) VALUES (?, ?, 'hash', 'user', 'active')")
      .run(userAlice, 'alice');
    db.prepare("INSERT INTO users (id, username, password_hash, role, status) VALUES (?, ?, 'hash', 'user', 'active')")
      .run(userBob, 'bob');

    // Seed space and session for Alice
    db.prepare("INSERT INTO spaces (id, user_id, name, folder, execution_mode, status) VALUES (?, ?, 'Alice Space', '/tmp/alice', 'container', 'active')")
      .run(spaceId, userAlice);

    db.prepare(`
      INSERT INTO session_routes (
        id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, status
      ) VALUES (?, ?, ?, 'lark', ?, 'oc_chat_1', 'peer_1', 'dsh_ses_1', 'container', 'active')
    `).run(sessionId, spaceId, userAlice, accountId);

    // Seed channel account for Alice
    db.prepare(`
      INSERT INTO channel_accounts (
        id, user_id, type, status, credential_ref
      ) VALUES (?, ?, 'lark', 'active', '{}')
    `).run(accountId, userAlice);
  });

  it('creates turn origin with all contract fields and turn_id as PK', async () => {
    const repo = storage.forTenant(userAlice).turnOrigins;

    const origin = await repo.create({
      turnId: 'turn_00000000000000000000000000000001',
      sessionId,
      accountId,
      channel: 'lark',
      chatId: 'oc_chat_1',
      nativeContextId: 'oc_chat_1',
      nativeEventId: 'evt_lark_123',
      replyToMessageId: 'om_msg_456',
      rootId: 'om_root_789',
      threadId: 'om_thread_101',
      originTurnId: null,
    });

    expect(origin.turnId).toBe('turn_00000000000000000000000000000001');
    expect(origin.userId).toBe(userAlice);
    expect(origin.sessionId).toBe(sessionId);
    expect(origin.accountId).toBe(accountId);
    expect(origin.channel).toBe('lark');
    expect(origin.chatId).toBe('oc_chat_1');
    expect(origin.nativeContextId).toBe('oc_chat_1');
    expect(origin.nativeEventId).toBe('evt_lark_123');
    expect(origin.replyToMessageId).toBe('om_msg_456');
    expect(origin.rootId).toBe('om_root_789');
    expect(origin.threadId).toBe('om_thread_101');
    expect(origin.originTurnId).toBeNull();
    expect(origin.createdAt).toBeDefined();

    // Verify row in DB has turn_id as primary key
    const dbRow = db.prepare('SELECT * FROM channel_turn_origins WHERE turn_id = ?').get(origin.turnId) as any;
    expect(dbRow).toBeDefined();
    expect(dbRow.turn_id).toBe('turn_00000000000000000000000000000001');
  });

  it('rejects duplicate turn origin creation (immutability)', async () => {
    const repo = storage.forTenant(userAlice).turnOrigins;
    const input = {
      turnId: 'turn_dup_0000000000000000000000000001',
      sessionId,
      accountId,
      channel: 'lark',
      chatId: 'oc_chat_1',
      nativeContextId: 'oc_chat_1',
      nativeEventId: 'evt_lark_dup',
    };

    await repo.create(input);
    await expect(repo.create(input)).rejects.toThrow(ValidationError);
  });

  it('rejects web channel (channel only, no fake Web accounts)', async () => {
    const repo = storage.forTenant(userAlice).turnOrigins;
    await expect(repo.create({
      turnId: 'turn_web_001',
      sessionId,
      accountId,
      channel: 'web',
      chatId: 'chat_web',
      nativeContextId: 'ctx_web',
    })).rejects.toThrow(ValidationError);
  });

  it('rejects Lark channel without nativeEventId', async () => {
    const repo = storage.forTenant(userAlice).turnOrigins;
    await expect(repo.create({
      turnId: 'turn_lark_no_evt',
      sessionId,
      accountId,
      channel: 'lark',
      chatId: 'oc_chat_1',
      nativeContextId: 'oc_chat_1',
      nativeEventId: null,
    })).rejects.toThrow(ValidationError);
  });

  it('enforces tenant isolation between users', async () => {
    const aliceRepo = storage.forTenant(userAlice).turnOrigins;
    const bobRepo = storage.forTenant(userBob).turnOrigins;

    const turnId = 'turn_iso_000000000000000000000001';
    await aliceRepo.create({
      turnId,
      sessionId,
      accountId,
      channel: 'lark',
      chatId: 'oc_chat_1',
      nativeContextId: 'oc_chat_1',
      nativeEventId: 'evt_lark_iso',
    });

    // Alice finds it
    const foundAlice = await aliceRepo.findByTurnId(turnId);
    expect(foundAlice).not.toBeNull();

    // Bob cannot find it
    const foundBob = await bobRepo.findByTurnId(turnId);
    expect(foundBob).toBeNull();

    // Bob cannot create an origin using Alice's account or session
    await expect(bobRepo.create({
      turnId: 'turn_bob_cross',
      sessionId, // Alice's session
      accountId, // Alice's account
      channel: 'lark',
      chatId: 'oc_chat_bob',
      nativeContextId: 'oc_chat_bob',
      nativeEventId: 'evt_bob_1',
    })).rejects.toThrow(NotFoundError);
  });

  it('findByOriginTurnId returns all downstream turns correlated to causal origin', async () => {
    const repo = storage.forTenant(userAlice).turnOrigins;
    const rootTurnId = 'turn_causal_root_001';

    await repo.create({
      turnId: rootTurnId,
      sessionId,
      accountId,
      channel: 'lark',
      chatId: 'oc_chat_1',
      nativeContextId: 'oc_chat_1',
      nativeEventId: 'evt_root',
    });

    await repo.create({
      turnId: 'turn_child_1',
      sessionId,
      accountId,
      channel: 'lark',
      chatId: 'oc_chat_1',
      nativeContextId: 'oc_chat_1',
      nativeEventId: 'evt_child_1',
      originTurnId: rootTurnId,
    });

    await repo.create({
      turnId: 'turn_child_2',
      sessionId,
      accountId,
      channel: 'lark',
      chatId: 'oc_chat_1',
      nativeContextId: 'oc_chat_1',
      nativeEventId: 'evt_child_2',
      originTurnId: rootTurnId,
    });

    const children = await repo.findByOriginTurnId(rootTurnId);
    expect(children).toHaveLength(2);
    expect(children.map((c) => c.turnId)).toEqual(['turn_child_1', 'turn_child_2']);
  });
});
