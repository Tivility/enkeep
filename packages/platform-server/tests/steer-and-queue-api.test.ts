import { describe, it, expect, vi, beforeAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { PlatformError, ValidationError } from '@enkeep/platform-core';
import { provisionFixtures } from '@enkeep/platform-auth';
import {
  DeliveryRuntimeGateway,
  SqliteWebMessageStore,
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  PlatformServer,
} from '../src/index.js';

describe('D-03 & D-04: Platform Steer and Queue Cancel/List Gateway and Routes', () => {
  const setupTestEnv = async () => {
    const db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    // Seed test user, space, and session route
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES ('u1', 'alice', 'hash', 'admin')").run();
    db.prepare("INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES ('sp1', 'u1', 'Space 1', 'space-1', 'container')").run();
    db.prepare("INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode) VALUES ('ses1', 'u1', 'sp1', 'web', 'web-demo', 'ses1', 'p1', 'dsh1', 'container')").run();

    const storage = new SqlitePlatformStorage(db);
    const messageStore = new SqliteWebMessageStore(db);
    const profileResolver = { resolve: async () => null };

    return { db, storage, messageStore, profileResolver };
  };

  describe('D-03: Steer Gateway Operations', () => {
    it('successfully steers running turn, writes independent web_message with metadata, and replays idempotently', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();

      // Seed a running turn
      const turnId = 'turn_running_01';
      db.prepare(`
        INSERT INTO turn_runs (id, turn_id, space_id, route_id, user_id, execution_mode, status, created_at, updated_at)
        VALUES ('run_1', ?, 'sp1', 'ses1', 'u1', 'container', 'running', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(turnId);

      const steerMock = vi.fn().mockResolvedValue({ ok: true });
      const executor = {
        execute: vi.fn(),
        cancel: vi.fn(),
        steerTurn: steerMock,
      };

      const gateway = new DeliveryRuntimeGateway({
        storage,
        messageStore,
        db,
        quotaMode: 'disabled',
        executor,
        profileResolver,
      });

      // 1. First steer request
      const steerRes1 = await gateway.steerTurn('u1', 'ses1', {
        clientRequestId: 'req-steer-01',
        expectedTurnId: turnId,
        content: 'Please focus on writing unit tests first',
      });

      expect(steerRes1.ok).toBe(true);
      expect(steerRes1.messageId).toMatch(/^msg_/);
      expect(steerMock).toHaveBeenCalledTimes(1);
      expect(steerMock).toHaveBeenCalledWith({
        userId: 'u1',
        platformSpaceId: 'sp1',
        dshSessionId: 'dsh1',
        expectedTurnId: turnId,
        message: 'Please focus on writing unit tests first',
        clientRequestId: 'req-steer-01',
      });

      // Verify message inserted in web_messages with metadata
      const msgRow = db.prepare('SELECT * FROM web_messages WHERE id = ?').get(steerRes1.messageId) as any;
      expect(msgRow).toBeDefined();
      expect(msgRow.session_id).toBe('ses1');
      expect(msgRow.turn_id).toBe(turnId);
      expect(msgRow.role).toBe('user');
      expect(msgRow.content).toBe('Please focus on writing unit tests first');
      const metadata = JSON.parse(msgRow.metadata);
      expect(metadata).toEqual({
        isSteer: true,
        attachedTurnId: turnId,
        clientRequestId: 'req-steer-01',
      });

      // Verify idempotency record created
      const idemRow = db.prepare("SELECT * FROM idempotency_records WHERE idempotency_key = 'steer:req-steer-01'").get() as any;
      expect(idemRow).toBeDefined();
      expect(idemRow.turn_id).toBe(turnId);
      expect(idemRow.state).toBe('completed');

      // 2. Duplicate steer request with same clientRequestId -> returns same result without re-executing
      const steerRes2 = await gateway.steerTurn('u1', 'ses1', {
        clientRequestId: 'req-steer-01',
        expectedTurnId: turnId,
        content: 'Please focus on writing unit tests first',
      });

      expect(steerRes2.ok).toBe(true);
      expect(steerRes2.messageId).toBe(steerRes1.messageId);
      expect(steerMock).toHaveBeenCalledTimes(1); // Not called again
    });

    it('rejects steer when turn is not running (e.g. completed, queued, failed, non-existent) with 409 NOT_RUNNING', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();

      // Seed a completed turn
      db.prepare(`
        INSERT INTO turn_runs (id, turn_id, space_id, route_id, user_id, execution_mode, status, created_at, updated_at)
        VALUES ('run_comp', 'turn_completed_01', 'sp1', 'ses1', 'u1', 'container', 'completed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run();

      // Seed a queued turn
      db.prepare(`
        INSERT INTO turn_runs (id, turn_id, space_id, route_id, user_id, execution_mode, status, created_at, updated_at)
        VALUES ('run_queued', 'turn_queued_01', 'sp1', 'ses1', 'u1', 'container', 'queued', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run();

      const executor = {
        execute: vi.fn(),
        cancel: vi.fn(),
        steerTurn: vi.fn().mockResolvedValue({ ok: true }),
      };

      const gateway = new DeliveryRuntimeGateway({
        storage,
        messageStore,
        db,
        quotaMode: 'disabled',
        executor,
        profileResolver,
      });

      // Attempt steer on completed turn
      await expect(gateway.steerTurn('u1', 'ses1', {
        clientRequestId: 'req-comp',
        expectedTurnId: 'turn_completed_01',
        content: 'steer text',
      })).rejects.toMatchObject({
        status: 409,
        code: 'NOT_RUNNING',
      });

      // Attempt steer on queued turn
      await expect(gateway.steerTurn('u1', 'ses1', {
        clientRequestId: 'req-queued',
        expectedTurnId: 'turn_queued_01',
        content: 'steer text',
      })).rejects.toMatchObject({
        status: 409,
        code: 'NOT_RUNNING',
      });

      // Attempt steer on non-existent turn
      await expect(gateway.steerTurn('u1', 'ses1', {
        clientRequestId: 'req-missing',
        expectedTurnId: 'turn_missing_99',
        content: 'steer text',
      })).rejects.toMatchObject({
        status: 409,
        code: 'NOT_RUNNING',
      });

      // Verify no orphan web_messages created
      const msgCount = (db.prepare('SELECT COUNT(*) as cnt FROM web_messages').get() as { cnt: number }).cnt;
      expect(msgCount).toBe(0);
    });

    it('rejects steer when runtime reports TURN_NOT_RUNNING and leaves no orphan messages', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();

      db.prepare(`
        INSERT INTO turn_runs (id, turn_id, space_id, route_id, user_id, execution_mode, status, created_at, updated_at)
        VALUES ('run_1', 'turn_racing', 'sp1', 'ses1', 'u1', 'container', 'running', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run();

      const executor = {
        execute: vi.fn(),
        cancel: vi.fn(),
        steerTurn: vi.fn().mockResolvedValue({ ok: false, error: { code: 'TURN_NOT_RUNNING' } }),
      };

      const gateway = new DeliveryRuntimeGateway({
        storage,
        messageStore,
        db,
        quotaMode: 'disabled',
        executor,
        profileResolver,
      });

      await expect(gateway.steerTurn('u1', 'ses1', {
        clientRequestId: 'req-race-01',
        expectedTurnId: 'turn_racing',
        content: 'steer text',
      })).rejects.toMatchObject({
        status: 409,
        code: 'NOT_RUNNING',
      });

      // Verify no message or idempotency record was committed
      const msgCount = (db.prepare('SELECT COUNT(*) as cnt FROM web_messages').get() as { cnt: number }).cnt;
      expect(msgCount).toBe(0);
      const idemCount = (db.prepare('SELECT COUNT(*) as cnt FROM idempotency_records').get() as { cnt: number }).cnt;
      expect(idemCount).toBe(0);
    });
  });

  describe('D-04: Queue Listing & Cancellation Operations', () => {
    it('lists queued turns with 80-char content snippet and creates valid list response', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();

      // Seed 2 queued turns and 1 running turn
      db.prepare(`
        INSERT INTO turn_runs (id, turn_id, space_id, route_id, user_id, execution_mode, status, created_at, updated_at)
        VALUES ('r1', 't1', 'sp1', 'ses1', 'u1', 'container', 'queued', '2026-10-09 10:00:00', CURRENT_TIMESTAMP)
      `).run();
      db.prepare(`
        INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, turn_id, created_at)
        VALUES ('m1', 'ses1', 'u1', 'user', 'Short task', 'delivered', 'u1:web:ses1', 't1', '2026-10-09 10:00:00')
      `).run();

      const longContent = 'A'.repeat(120);
      db.prepare(`
        INSERT INTO turn_runs (id, turn_id, space_id, route_id, user_id, execution_mode, status, created_at, updated_at)
        VALUES ('r2', 't2', 'sp1', 'ses1', 'u1', 'container', 'queued', '2026-10-09 10:05:00', CURRENT_TIMESTAMP)
      `).run();
      db.prepare(`
        INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, turn_id, created_at)
        VALUES ('m2', 'ses1', 'u1', 'user', ?, 'delivered', 'u1:web:ses1', 't2', '2026-10-09 10:05:00')
      `).run(longContent);

      db.prepare(`
        INSERT INTO turn_runs (id, turn_id, space_id, route_id, user_id, execution_mode, status, created_at, updated_at)
        VALUES ('r3', 't3', 'sp1', 'ses1', 'u1', 'container', 'running', '2026-10-09 10:10:00', CURRENT_TIMESTAMP)
      `).run();

      const gateway = new DeliveryRuntimeGateway({
        storage,
        messageStore,
        db,
        quotaMode: 'disabled',
        executor: { execute: vi.fn(), cancel: vi.fn() },
        profileResolver,
      });

      const queueList = await gateway.listQueuedTurns('u1', 'ses1');
      expect(queueList).toHaveLength(2);
      expect(queueList[0]).toEqual({
        turnId: 't1',
        createdAt: '2026-10-09 10:00:00',
        contentSnippet: 'Short task',
      });
      expect(queueList[1].turnId).toBe('t2');
      expect(queueList[1].contentSnippet).toBe('A'.repeat(80));
      expect(queueList[1].contentSnippet.length).toBe(80);
    });

    it('cancels queued turn via CAS to interrupted and delivery_inbox to cancelled', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();

      // Seed queued turn across turn_runs, delivery_inbox, and turn_execution_queue
      db.prepare(`
        INSERT INTO turn_runs (id, turn_id, space_id, route_id, user_id, execution_mode, status, created_at, updated_at)
        VALUES ('r1', 't_cancel_01', 'sp1', 'ses1', 'u1', 'container', 'queued', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run();
      db.prepare(`
        INSERT INTO delivery_inbox (id, user_id, route_id, message_id, delivery_id, status, turn_id, created_at, updated_at)
        VALUES ('inbox_1', 'u1', 'ses1', 'msg_1', 'deliv_1', 'held', 't_cancel_01', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run();
      db.prepare(`
        INSERT INTO idempotency_records (id, user_id, idempotency_key, session_id, delivery_id, turn_id, request_hash, state, created_at, updated_at)
        VALUES ('idem_1', 'u1', 'idem-cancel-key', 'ses1', 'deliv_1', 't_cancel_01', 'hash123', 'held', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run();
      db.prepare(`
        INSERT INTO turn_execution_queue (id, user_id, route_id, turn_id, delivery_id, position)
        VALUES ('q_1', 'u1', 'ses1', 't_cancel_01', 'deliv_1', 1)
      `).run();

      const gateway = new DeliveryRuntimeGateway({
        storage,
        messageStore,
        db,
        quotaMode: 'disabled',
        executor: { execute: vi.fn(), cancel: vi.fn() },
        profileResolver,
      });

      const cancelled = await gateway.cancelQueuedTurn('u1', 'ses1', 't_cancel_01');
      expect(cancelled).toBe(true);

      // Verify turn_runs status is 'interrupted' (NOT 'cancelled')
      const turnRow = db.prepare('SELECT status, error FROM turn_runs WHERE turn_id = ?').get('t_cancel_01') as any;
      expect(turnRow.status).toBe('interrupted');
      expect(turnRow.error).toBe('Cancelled by user from queue');

      // Verify delivery_inbox status is 'cancelled'
      const inboxRow = db.prepare('SELECT status, error FROM delivery_inbox WHERE turn_id = ?').get('t_cancel_01') as any;
      expect(inboxRow.status).toBe('cancelled');
      expect(inboxRow.error).toBe('Cancelled by user from queue');

      // Verify turn_execution_queue row was cleaned up
      const qRow = db.prepare('SELECT 1 FROM turn_execution_queue WHERE turn_id = ?').get('t_cancel_01');
      expect(qRow).toBeUndefined();

      // Verify idempotency record is marked failed
      const idemRow = db.prepare('SELECT state FROM idempotency_records WHERE turn_id = ?').get('t_cancel_01') as any;
      expect(idemRow.state).toBe('failed');
    });

    it('rejects cancellation when turn is running or completed (CAS returns false)', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();

      // Seed a running turn
      db.prepare(`
        INSERT INTO turn_runs (id, turn_id, space_id, route_id, user_id, execution_mode, status, created_at, updated_at)
        VALUES ('r_run', 't_running_01', 'sp1', 'ses1', 'u1', 'container', 'running', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run();

      const gateway = new DeliveryRuntimeGateway({
        storage,
        messageStore,
        db,
        quotaMode: 'disabled',
        executor: { execute: vi.fn(), cancel: vi.fn() },
        profileResolver,
      });

      const cancelRunning = await gateway.cancelQueuedTurn('u1', 'ses1', 't_running_01');
      expect(cancelRunning).toBe(false);

      // Verify status is still 'running'
      const turnRow = db.prepare('SELECT status FROM turn_runs WHERE turn_id = ?').get('t_running_01') as any;
      expect(turnRow.status).toBe('running');
    });
  });

  describe('HTTP Route Integration (POST /steer, GET /queue, POST /queue/:turnId/cancel)', () => {
    let server: PlatformServer;
    let baseUrl: string;
    let csrfToken = 'test-steer-queue-csrf-token-32-chars!!';
    let db: DatabaseSync;
    let steerMock: any;

    let aliceCookie = '';

    beforeAll(async () => {
      db = new DatabaseSync(':memory:');
      const runner = new PlatformServerMigrationRunner(db);
      await runner.migrate(ALL_PLATFORM_MIGRATIONS);

      const storage = new SqlitePlatformStorage(db);
      const messageStore = new SqliteWebMessageStore(db);
      steerMock = vi.fn().mockResolvedValue({ ok: true });
      const executor = {
        execute: vi.fn(),
        cancel: vi.fn(),
        steerTurn: steerMock,
      };

      const gateway = new DeliveryRuntimeGateway({
        storage,
        messageStore,
        db,
        quotaMode: 'disabled',
        executor,
        profileResolver: { resolve: async () => null },
      });

      server = new PlatformServer({
        database: db,
        host: '127.0.0.1',
        port: 0,
        cookieSecret: 'test-steer-queue-secret-key-32-chars-long!',
        csrfToken,
        runtimeGateway: gateway,
      });

      const addr = await server.start();
      baseUrl = addr.url;

      // Provision fixtures for alice
      await provisionFixtures(server.storage, server.authService, {
        adminUsername: 'alice',
        adminPassword: 'AlicePassword123!',
        userPassword: 'BobPassword123!',
        disabledPassword: 'CharliePassword123!',
      });
      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({ username: 'alice', password: 'AlicePassword123!' }),
      });
      aliceCookie = loginRes.headers.get('set-cookie')!;

      // Retrieve Alice user ID and create space & session route
      const aliceUser = (await server.storage.users.list()).find((u) => u.username === 'alice');
      const userId = aliceUser!.id;
      db.prepare("INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES ('sp1', ?, 'Space 1', 'space-1', 'container')").run(userId);
      db.prepare("INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode) VALUES ('ses1', ?, 'sp1', 'web', 'web-demo', 'ses1', 'p1', 'dsh1', 'container')").run(userId);
    });

    const getAuthHeaders = () => {
      return {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': csrfToken,
        'Content-Type': 'application/json',
        Origin: baseUrl,
      };
    };

    it('POST /api/sessions/:sessionId/steer routes to gateway and enforces CSRF and running validation', async () => {
      // 1. Without CSRF -> 403
      const noCsrfRes = await fetch(`${baseUrl}/api/sessions/ses1/steer`, {
        method: 'POST',
        headers: {
          Cookie: aliceCookie,
          'Content-Type': 'application/json',
          Origin: baseUrl,
        },
        body: JSON.stringify({
          clientRequestId: 'req-1',
          expectedTurnId: 'turn_run_1',
          content: 'steer message',
        }),
      });
      expect(noCsrfRes.status).toBe(403);

      // 2. Turn not running -> 409 NOT_RUNNING
      const notRunningRes = await fetch(`${baseUrl}/api/sessions/ses1/steer`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          clientRequestId: 'req-1',
          expectedTurnId: 'turn_run_1',
          content: 'steer message',
        }),
      });
      expect(notRunningRes.status).toBe(409);
      const notRunningJson = await notRunningRes.json();
      expect(notRunningJson.error.code).toBe('NOT_RUNNING');

      // 3. Insert running turn -> 200 OK with messageId
      const aliceUser = (await server.storage.users.list()).find((u) => u.username === 'alice');
      db.prepare(`
        INSERT INTO turn_runs (id, turn_id, space_id, route_id, user_id, execution_mode, status, created_at, updated_at)
        VALUES ('r_http_1', 'turn_run_1', 'sp1', 'ses1', ?, 'container', 'running', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(aliceUser!.id);

      const successRes = await fetch(`${baseUrl}/api/sessions/ses1/steer`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          clientRequestId: 'req-1',
          expectedTurnId: 'turn_run_1',
          content: 'steer message via HTTP',
        }),
      });
      expect(successRes.status).toBe(200);
      const successJson = await successRes.json();
      expect(successJson.data.ok).toBe(true);
      expect(successJson.data.messageId).toBeDefined();
    });

    it('GET /api/sessions/:sessionId/queue and POST /api/sessions/:sessionId/queue/:turnId/cancel', async () => {
      const aliceUser = (await server.storage.users.list()).find((u) => u.username === 'alice');
      const userId = aliceUser!.id;

      // Seed queued turn
      db.prepare(`
        INSERT INTO turn_runs (id, turn_id, space_id, route_id, user_id, execution_mode, status, created_at, updated_at)
        VALUES ('r_q_http', 'turn_q_http_1', 'sp1', 'ses1', ?, 'container', 'queued', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(userId);
      db.prepare(`
        INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, turn_id, created_at)
        VALUES ('m_q_http', 'ses1', ?, 'user', 'Queued HTTP Task', 'delivered', ?, 'turn_q_http_1', CURRENT_TIMESTAMP)
      `).run(userId, `${userId}:web:ses1`);

      // 1. GET /api/sessions/ses1/queue -> returns queued turns
      const listRes = await fetch(`${baseUrl}/api/sessions/ses1/queue`, {
        method: 'GET',
        headers: getAuthHeaders(),
      });
      expect(listRes.status).toBe(200);
      const listJson = await listRes.json();
      expect(listJson.data.items).toHaveLength(1);
      expect(listJson.data.items[0].turnId).toBe('turn_q_http_1');
      expect(listJson.data.items[0].contentSnippet).toBe('Queued HTTP Task');

      // 2. POST /api/sessions/ses1/queue/turn_q_http_1/cancel -> 200 OK
      const cancelRes = await fetch(`${baseUrl}/api/sessions/ses1/queue/turn_q_http_1/cancel`, {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      expect(cancelRes.status).toBe(200);
      const cancelJson = await cancelRes.json();
      expect(cancelJson.data.cancelled).toBe(true);
      expect(cancelJson.data.turnId).toBe('turn_q_http_1');

      // 3. Cancelling already cancelled / running turn returns 409 NOT_IN_QUEUE
      const cancelAgainRes = await fetch(`${baseUrl}/api/sessions/ses1/queue/turn_q_http_1/cancel`, {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      expect(cancelAgainRes.status).toBe(409);
      const cancelAgainJson = await cancelAgainRes.json();
      expect(cancelAgainJson.error.code).toBe('NOT_IN_QUEUE');
    });
  });
});
