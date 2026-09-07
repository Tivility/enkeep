import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlinkSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { provisionFixtures } from '@enkeep/platform-auth';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import {
  PlatformServer,
  SqliteWebMessageStore,
  DeliveryRuntimeGateway,
  ALL_PLATFORM_MIGRATIONS,
} from '../src/index.js';
import { TestOnlyRuntimeGateway } from './test-runtime-gateway.js';

describe('Server Restart & SQLite Persistence Lifecycle', () => {
  const dbFile = join(tmpdir(), `enkeep-test-restart-${randomUUID()}.sqlite`);
  let server1: PlatformServer;
  let server2: PlatformServer;
  let cookie: string;
  let spaceId: string;
  let sessionId: string;
  let messageId: string;
  let version1: number;
  const testCsrfToken = 'restart-persistence-csrf-token-32-chars!';

  beforeAll(async () => {
    // 1. Start Server 1 with file-backed SQLite database
    const db1 = new DatabaseSync(dbFile);
    const storage1 = new SqlitePlatformStorage(db1);
    const messageStore1 = new SqliteWebMessageStore(db1);
    const runtimeGateway1 = new TestOnlyRuntimeGateway({
      storage: storage1,
      messageStore: messageStore1,
      autoReply: true,
      autoReplyDelayMs: 10,
    });

    server1 = new PlatformServer({
      database: db1,
      host: '127.0.0.1',
      port: 0,
      cookieSecret: 'persistent-secret-key-32-chars-long!',
      csrfToken: testCsrfToken,
      runtimeGateway: runtimeGateway1,
    });

    const addr1 = await server1.start();

    // Verify migration version was recorded via versioned migration table
    version1 = await server1.migrationRunner.getCurrentVersion();
    expect(version1).toBe(31);

    // Provision fixtures
    const fixtures = await provisionFixtures(server1.storage, server1.authService, {
      adminUsername: 'alice',
      adminPassword: 'AlicePassword123!',
      userUsername: 'bob',
      userPassword: 'BobPassword123!',
      disabledPassword: 'CharlieDisabledPassword123!',
    });
    spaceId = fixtures.userContainerSpace.id;

    // Login as Bob
    const loginRes = await fetch(`${addr1.url}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: addr1.url,
      },
      body: JSON.stringify({ username: 'bob', password: 'BobPassword123!' }),
    });
    cookie = loginRes.headers.get('set-cookie')!;

    // Create session
    const sessRes = await fetch(`${addr1.url}/api/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: addr1.url,
      },
      body: JSON.stringify({ spaceId, title: 'Restart Session' }),
    });
    const sessJson = await sessRes.json();
    sessionId = sessJson.data.id;

    // Send a message
    const msgRes = await fetch(`${addr1.url}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'a0000000-0000-4000-8000-000000000001',
        Cookie: cookie,
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: addr1.url,
      },
      body: JSON.stringify({ content: 'Hello before restart!' }),
    });
    const msgJson = await msgRes.json();
    if (!msgJson.data) {
      throw new Error(`Failed to send message: status=${msgRes.status}, body=${JSON.stringify(msgJson)}`);
    }
    messageId = msgJson.data.message.id;

    // Wait a brief moment for runtime gateway auto-reply
    await new Promise((r) => setTimeout(r, 60));

    // Stop Server 1
    await server1.stop();
  });

  afterAll(async () => {
    if (server2) {
      await server2.stop();
    }
    if (existsSync(dbFile)) {
      try {
        unlinkSync(dbFile);
      } catch {}
    }
  });

  it('Server 2 should start on the same database file and preserve all state', async () => {
    const db2 = new DatabaseSync(dbFile);
    const storage2 = new SqlitePlatformStorage(db2);
    const messageStore2 = new SqliteWebMessageStore(db2);
    const runtimeGateway2 = new TestOnlyRuntimeGateway({
      storage: storage2,
      messageStore: messageStore2,
      autoReply: true,
      autoReplyDelayMs: 10,
    });

    server2 = new PlatformServer({
      database: db2,
      host: '127.0.0.1',
      port: 0,
      cookieSecret: 'persistent-secret-key-32-chars-long!',
      csrfToken: testCsrfToken,
      runtimeGateway: runtimeGateway2,
      autoRecover: true,
    });

    const addr2 = await server2.start();

    // Verify migration checksum verification passed and version is preserved
    const version2 = await server2.migrationRunner.getCurrentVersion();
    expect(version2).toBe(version1);

    // Authenticate with existing cookie
    const meRes = await fetch(`${addr2.url}/api/auth/me`, {
      headers: { Cookie: cookie },
    });
    expect(meRes.status).toBe(200);
    const meJson = await meRes.json();
    expect(meJson.data.user.username).toBe('bob');

    // Verify Space exists
    const spaceRes = await fetch(`${addr2.url}/api/spaces/${spaceId}`, {
      headers: { Cookie: cookie },
    });
    expect(spaceRes.status).toBe(200);
    const spaceJson = await spaceRes.json();
    expect(spaceJson.data.id).toBe(spaceId);

    // Verify Session Route exists
    const sessionRes = await fetch(`${addr2.url}/api/sessions/${sessionId}`, {
      headers: { Cookie: cookie },
    });
    expect(sessionRes.status).toBe(200);
    const sessionJson = await sessionRes.json();
    expect(sessionJson.data.id).toBe(sessionId);

    // Verify Message History persisted
    const historyRes = await fetch(`${addr2.url}/api/sessions/${sessionId}/messages`, {
      headers: { Cookie: cookie },
    });
    expect(historyRes.status).toBe(200);
    const historyJson = await historyRes.json();
    expect(historyJson.data.messages.length).toBeGreaterThanOrEqual(1);
    expect(historyJson.data.messages.some((m: any) => m.content === 'Hello before restart!')).toBe(true);

    // Verify Event Polling works with previous history
    const eventsRes = await fetch(`${addr2.url}/api/sessions/${sessionId}/events`, {
      headers: { Cookie: cookie },
    });
    expect(eventsRes.status).toBe(200);
    const eventsJson = await eventsRes.json();
    expect(eventsJson.data.events.length).toBeGreaterThanOrEqual(1);
  });

  it('crashes between accept/held and restart recovery redrives held turn exactly once to completion', async () => {
    const db = new DatabaseSync(dbFile);
    const storage = new SqlitePlatformStorage(db);
    const messageStore = new SqliteWebMessageStore(db);

    let executorRuns = 0;
    const executor = {
      execute: async (envelope: any, turnId: string) => {
        executorRuns++;
        return {
          replyText: `Redriven execution: ${envelope.content}`,
          usage: { totalTokens: 10 },
        };
      },
      cancel: async () => true,
    };

    const gateway = new DeliveryRuntimeGateway({
      database: db,
      storage,
      messageStore,
      executor,
      quotaMode: 'disabled',
        profileResolver: { resolve: async () => null }
      });

    const bobUser = await storage.users.findByUsername('bob');
    expect(bobUser).not.toBeNull();
    const bobId = bobUser!.id;

    // 1. Ingest a message directly into delivery_inbox with status = 'held' (simulating crash right after accept)
    const crashDeliveryId = 'crash-held-delivery-key-12345';
    const envelope = {
      id: crashDeliveryId,
      channel: 'web',
      accountId: 'web-demo',
      userId: bobId,
      nativeContext: {
        channel: 'web',
        accountId: 'web-demo',
        userId: bobId,
        spaceId,
        nativeContextId: sessionId,
        peerId: 'p1',
      },
      routeKey: `${bobId}:web:web-demo:${sessionId}`,
      content: 'Unprocessed message before crash',
      timestamp: new Date().toISOString(),
    };

    const routeRow = db.prepare('SELECT dsh_session_id FROM session_routes WHERE id = ?').get(sessionId) as { dsh_session_id: string };
    const dshSessionId = routeRow.dsh_session_id;

    const ingestRes = await messageStore.ingestWebDelivery({
      userId: bobId,
      sessionId,
      spaceId,
      dshSessionId,
      idempotencyKey: crashDeliveryId,
      content: envelope.content,
      timestamp: envelope.timestamp,
    });

    expect(ingestRes.isClaimant).toBe(true);
    expect(ingestRes.turnId).toBeDefined();

    // Verify it is currently in 'held' status
    const heldList = await messageStore.listHeldDeliveries();
    expect(heldList.some((h) => h.deliveryId === ingestRes.deliveryId)).toBe(true);

    // 2. Start server / trigger redriveHeld
    const redriven = await gateway.redriveHeld();
    expect(redriven).toBeGreaterThanOrEqual(1);

    // Wait for async execution
    await gateway.drain(1000);

    // Verify executor ran for the redriven turns
    expect(executorRuns).toBeGreaterThanOrEqual(1);

    // Verify turn is completed
    const status = await gateway.getTurnStatus(bobId, ingestRes.turnId);
    expect(status.status).toBe('completed');

    // Verify delivery_inbox is marked 'delivered' and no longer held
    const heldListAfter = await messageStore.listHeldDeliveries();
    expect(heldListAfter.some((h) => h.deliveryId === crashDeliveryId)).toBe(false);

    // Verify duplicate redrive does not re-execute
    const secondRedrive = await gateway.redriveHeld();
    expect(secondRedrive).toBe(0);
    expect(executorRuns).toBe(1);
  });

  it('fails server start immediately without binding or accepting traffic when startup recovery encounters errors', async () => {
    const db = new DatabaseSync(':memory:');
    const storage = new SqlitePlatformStorage(db);
    const messageStore = new SqliteWebMessageStore(db);

    const gateway = new DeliveryRuntimeGateway({
      database: db,
      storage,
      messageStore,
      executor: {
        execute: async () => ({ replyText: 'Ok', usage: { totalTokens: 10 } }),
        cancel: async () => true,
      },
      quotaMode: 'disabled',
        profileResolver: { resolve: async () => null }
      });

    const failingServer = new PlatformServer({
      database: db,
      host: '127.0.0.1',
      port: 0,
      cookieSecret: 'persistent-secret-key-32-chars-long!',
      csrfToken: testCsrfToken,
      runtimeGateway: gateway,
      autoRecover: true,
    });

    // Run migrations
    await failingServer.migrationRunner.migrate(ALL_PLATFORM_MIGRATIONS);

    // Insert prerequisite user, space, and session for foreign keys
    db.prepare(`INSERT INTO users (id, username, password_hash, role, status) VALUES ('u1', 'user1', 'hash', 'admin', 'active')`).run();
    db.prepare(`INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES ('sp1', 'u1', 'Space1', 'folder1', 'container')`).run();
    db.prepare(`INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, dsh_session_id, execution_mode) VALUES ('ses1', 'u1', 'sp1', 'web', 'web-demo', 'ctx1', 'dsh1', 'container')`).run();

    // Insert corrupt record into delivery_inbox before start
    db.prepare(`
      INSERT INTO delivery_inbox (id, user_id, route_id, message_id, delivery_id, payload, status, turn_id)
      VALUES ('inbox_bad', 'u1', 'ses1', 'msg_bad', 'del_bad', '{CORRUPT_JSON', 'held', 'turn_bad')
    `).run();

    // Server start MUST fail closed before opening listen socket
    await expect(failingServer.start()).rejects.toThrow(AggregateError);

    // Server must not be running
    expect(failingServer.getPort()).toBe(0);
  });
});
