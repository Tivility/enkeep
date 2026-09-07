import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { ValidationError, PlatformError } from '@enkeep/platform-core';
import {
  SqliteWebMessageStore,
  type WebMessageRecord,
  type WebEventRecord,
  encodeOpaqueCursor,
  decodeAndValidateCursor,
  computeCanonicalRequestHash,
  generate32HexId,
  isValidIsoDate,
} from '../src/storage/web-messages.js';
import { PlatformServerMigrationRunner, ALL_PLATFORM_MIGRATIONS } from '../src/storage/migrations.js';

describe('SqliteWebMessageStore Dedicated Unit Tests', () => {
  let db: DatabaseSync;
  let store: SqliteWebMessageStore;
  const userId = 'usr_alice_001';
  const spaceId = 'spc_00000000000000000000000000000001';
  const sessionId = 'ses_00000000000000000000000000000001';
  const dshSessionId = 'dsh_sess_001';

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);
    store = new SqliteWebMessageStore(db);

    // Seed parent user, space, and session_route
    db.exec(`
      INSERT INTO users (id, username, password_hash, status)
      VALUES ('${userId}', 'alice', 'hash', 'active');

      INSERT INTO spaces (id, user_id, name, folder, status, execution_mode)
      VALUES ('${spaceId}', '${userId}', 'Alice Space', 'folder_1', 'active', 'container');

      INSERT INTO session_routes (id, space_id, user_id, channel, dsh_session_id, status, execution_mode)
      VALUES ('${sessionId}', '${spaceId}', '${userId}', 'web', '${dshSessionId}', 'active', 'container');
    `);
  });

  describe('ID generation and canonical request hash', () => {
    it('generates exact 32 lowercase hex IDs with canonical prefixes', () => {
      const delivId = generate32HexId('deliv');
      const turnId = generate32HexId('turn');
      const msgId = generate32HexId('msg');
      const runId = generate32HexId('run');
      const evtId = generate32HexId('evt');

      expect(delivId).toMatch(/^deliv_[0-9a-f]{32}$/);
      expect(turnId).toMatch(/^turn_[0-9a-f]{32}$/);
      expect(msgId).toMatch(/^msg_[0-9a-f]{32}$/);
      expect(runId).toMatch(/^run_[0-9a-f]{32}$/);
      expect(evtId).toMatch(/^evt_[0-9a-f]{32}$/);
    });

    it('computes exact canonical request hash from JSON {sessionId, content}', () => {
      const hash1 = computeCanonicalRequestHash(sessionId, 'hello world');
      const hash2 = computeCanonicalRequestHash(sessionId, 'hello world');
      const hash3 = computeCanonicalRequestHash(sessionId, 'different');

      expect(hash1).toBe(hash2);
      expect(hash1).not.toBe(hash3);
      expect(hash1).toMatch(/^[0-9a-f]{64}$/);
    });

    it('strictly verifies canonical ISO date format', () => {
      expect(isValidIsoDate(new Date().toISOString())).toBe(true);
      expect(isValidIsoDate('2026-02-26T12:00:00.000Z')).toBe(true);
      expect(isValidIsoDate('2026-02-26 12:00:00')).toBe(false);
      expect(isValidIsoDate('invalid')).toBe(false);
      expect(isValidIsoDate('')).toBe(false);
      expect(isValidIsoDate(null)).toBe(false);
    });
  });

  describe('Atomic Ingest: ingestWebDelivery', () => {
    it('atomically inserts idempotency_records, delivery_inbox, web_messages, web_events, and turn_runs', async () => {
      const timestamp = new Date().toISOString();
      const idempotencyKey = 'idem_key_001';
      const content = 'Test message for atomic ingestion';

      const result = await store.ingestWebDelivery({
        userId,
        sessionId,
        spaceId,
        dshSessionId,
        idempotencyKey,
        content,
        timestamp,
      });

      expect(result.isClaimant).toBe(true);
      expect(result.state).toBe('held');
      expect(result.deliveryId).toMatch(/^deliv_[0-9a-f]{32}$/);
      expect(result.turnId).toMatch(/^turn_[0-9a-f]{32}$/);
      expect(result.messageId).toMatch(/^msg_[0-9a-f]{32}$/);
      expect(result.runId).toMatch(/^run_[0-9a-f]{32}$/);

      // Verify safe public WebMessageRecord
      expect(result.message).toEqual({
        id: result.messageId,
        role: 'user',
        content,
        status: 'delivered',
        createdAt: timestamp,
      });

      // Verify DB records exist
      const idemRow = db.prepare('SELECT * FROM idempotency_records WHERE idempotency_key = ?').get(idempotencyKey) as any;
      expect(idemRow).toBeDefined();
      expect(idemRow.state).toBe('held');
      expect(idemRow.turn_id).toBe(result.turnId);

      const inboxRow = db.prepare('SELECT * FROM delivery_inbox WHERE delivery_id = ?').get(result.deliveryId) as any;
      expect(inboxRow).toBeDefined();
      expect(inboxRow.status).toBe('held');
      expect(inboxRow.turn_id).toBe(result.turnId);

      const msgRow = db.prepare('SELECT * FROM web_messages WHERE id = ?').get(result.messageId) as any;
      expect(msgRow).toBeDefined();
      expect(msgRow.metadata).toBeNull();
      expect(msgRow.turn_id).toBe(result.turnId);

      const evtRow = db.prepare('SELECT * FROM web_events WHERE session_id = ?').get(sessionId) as any;
      expect(evtRow).toBeDefined();
      expect(evtRow.type).toBe('message');
      const parsedEvt = JSON.parse(evtRow.payload);
      expect(parsedEvt).toEqual({
        message: {
          id: result.messageId,
          role: 'user',
          content,
          status: 'delivered',
          createdAt: timestamp,
        },
      });

      const turnRow = db.prepare('SELECT * FROM turn_runs WHERE turn_id = ?').get(result.turnId) as any;
      expect(turnRow).toBeDefined();
      expect(turnRow.status).toBe('queued');
    });

    it('deduplicates matching idempotent replay and returns existing turn and message', async () => {
      const timestamp = new Date().toISOString();
      const idempotencyKey = 'idem_key_replay';
      const content = 'Replay content';

      const res1 = await store.ingestWebDelivery({
        userId,
        sessionId,
        spaceId,
        dshSessionId,
        idempotencyKey,
        content,
        timestamp,
      });
      expect(res1.isClaimant).toBe(true);

      const res2 = await store.ingestWebDelivery({
        userId,
        sessionId,
        spaceId,
        dshSessionId,
        idempotencyKey,
        content,
        timestamp,
      });
      expect(res2.isClaimant).toBe(false);
      expect(res2.turnId).toBe(res1.turnId);
      expect(res2.messageId).toBe(res1.messageId);
      expect(res2.deliveryId).toBe(res1.deliveryId);
      expect(res2.message).toEqual(res1.message);
    });

    it('rejects idempotency collision with different content with 409 Conflict', async () => {
      const timestamp = new Date().toISOString();
      const idempotencyKey = 'idem_key_collision';

      await store.ingestWebDelivery({
        userId,
        sessionId,
        spaceId,
        dshSessionId,
        idempotencyKey,
        content: 'Original content',
        timestamp,
      });

      await expect(
        store.ingestWebDelivery({
          userId,
          sessionId,
          spaceId,
          dshSessionId,
          idempotencyKey,
          content: 'Different content collision attack',
          timestamp,
        })
      ).rejects.toThrow(PlatformError);
    });

    it('rejects ingest when parent session route is archived with 409 Conflict', async () => {
      db.prepare("UPDATE session_routes SET status = 'archived' WHERE id = ?").run(sessionId);

      await expect(
        store.ingestWebDelivery({
          userId,
          sessionId,
          spaceId,
          dshSessionId,
          idempotencyKey: 'idem_archived_sess',
          content: 'Hello',
          timestamp: new Date().toISOString(),
        })
      ).rejects.toThrow(PlatformError);
    });

    it('rejects ingest when parent space is archived with 409 Conflict', async () => {
      db.prepare("UPDATE spaces SET status = 'archived' WHERE id = ?").run(spaceId);

      await expect(
        store.ingestWebDelivery({
          userId,
          sessionId,
          spaceId,
          dshSessionId,
          idempotencyKey: 'idem_archived_space',
          content: 'Hello',
          timestamp: new Date().toISOString(),
        })
      ).rejects.toThrow(PlatformError);
    });

    it('rejects invalid inputs with ValidationError', async () => {
      const validTimestamp = new Date().toISOString();

      await expect(
        store.ingestWebDelivery({
          userId: '',
          sessionId,
          spaceId,
          dshSessionId,
          idempotencyKey: 'k',
          content: 'c',
          timestamp: validTimestamp,
        })
      ).rejects.toThrow(ValidationError);

      await expect(
        store.ingestWebDelivery({
          userId,
          sessionId,
          spaceId,
          dshSessionId,
          idempotencyKey: 'k',
          content: 'c',
          timestamp: 'invalid-date',
        })
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('CAS State Machine: claimHeldDelivery', () => {
    it('atomically claims held delivery from held -> processing', async () => {
      const timestamp = new Date().toISOString();
      const idempotencyKey = 'idem_claim_test';
      const ingestRes = await store.ingestWebDelivery({
        userId,
        sessionId,
        spaceId,
        dshSessionId,
        idempotencyKey,
        content: 'Claiming message',
        timestamp,
      });

      const claimed = await store.claimHeldDelivery(userId, ingestRes.deliveryId, idempotencyKey, ingestRes.turnId);
      expect(claimed).toBe(true);

      // Second claim attempt fails CAS
      const secondClaim = await store.claimHeldDelivery(userId, ingestRes.deliveryId, idempotencyKey, ingestRes.turnId);
      expect(secondClaim).toBe(false);
    });
  });

  describe('Keyset Pagination and Query Methods', () => {
    it('lists messages safely without internal metadata or turnId', async () => {
      const timestamp = new Date().toISOString();
      const msg = await store.insertMessage({
        id: 'msg_test_public',
        sessionId,
        userId,
        role: 'assistant',
        content: 'Hello user',
        status: 'delivered',
        routeKey: `route_${sessionId}`,
        turnId: null,
        createdAt: timestamp,
      });

      expect(msg).toEqual({
        id: 'msg_test_public',
        role: 'assistant',
        content: 'Hello user',
        status: 'delivered',
        createdAt: timestamp,
      });

      const listRes = await store.listMessages(userId, sessionId, { limit: 10 });
      expect(listRes.messages.length).toBe(1);
      expect(listRes.messages[0]).toEqual({
        id: 'msg_test_public',
        role: 'assistant',
        content: 'Hello user',
        status: 'delivered',
        createdAt: timestamp,
      });
    });

    it('retrieves internal message with turnId and routeKey via getInternalMessage and getInternalMessageByTurn', async () => {
      const timestamp = new Date().toISOString();
      const turnId = 'turn_internal_test_1';
      await store.insertMessage({
        id: 'msg_internal_test',
        sessionId,
        userId,
        role: 'user',
        content: 'Internal message',
        status: 'delivered',
        routeKey: `route_${sessionId}`,
        turnId,
        createdAt: timestamp,
      });

      const internalMsg = await store.getInternalMessage(userId, sessionId, 'msg_internal_test');
      expect(internalMsg).toBeDefined();
      expect(internalMsg?.turnId).toBe(turnId);
      expect(internalMsg?.routeKey).toBe(`route_${sessionId}`);

      const internalByTurn = await store.getInternalMessageByTurn(userId, sessionId, turnId);
      expect(internalByTurn).toBeDefined();
      expect(internalByTurn?.id).toBe('msg_internal_test');
    });

    it('polls events with safe public event records', async () => {
      const timestamp = new Date().toISOString();
      await store.insertEvent({
        id: 'evt_test_1',
        sessionId,
        userId,
        type: 'turn_status',
        payload: { status: 'completed' },
        createdAt: timestamp,
      });

      const polled = await store.pollEvents(userId, sessionId);
      expect(polled.events.length).toBe(1);
      expect(polled.events[0]).toEqual({
        id: 'evt_test_1',
        type: 'turn_status',
        payload: { status: 'completed' },
        createdAt: timestamp,
      });
    });
  });
});
