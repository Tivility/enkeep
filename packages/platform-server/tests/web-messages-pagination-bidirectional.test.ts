import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { ValidationError } from '@enkeep/platform-core';
import { provisionFixtures } from '@enkeep/platform-auth';
import { PlatformServerMigrationRunner, ALL_PLATFORM_MIGRATIONS } from '../src/storage/migrations.js';
import { SqliteWebMessageStore, type WebMessageRecord, encodeOpaqueCursor } from '../src/storage/web-messages.js';
import { SqlitePlatformApi } from '../src/storage/sqlite-platform-api.js';
import { PlatformServer } from '../src/server/server.js';
import { TestOnlyRuntimeGateway } from './test-runtime-gateway.js';

describe('Web Messages Bidirectional Keyset Pagination (Platform Server)', () => {
  let db: DatabaseSync;
  let store: SqliteWebMessageStore;
  let platformStorage: SqlitePlatformStorage;
  let platformApi: SqlitePlatformApi;

  const tenantAlice = 'usr_alice_001';
  const tenantBob = 'usr_bob_002';
  const aliceSpaceId = 'spc_alice_001';
  const bobSpaceId = 'spc_bob_002';
  const aliceSessionId = 'ses_alice_001';
  const aliceSessionId2 = 'ses_alice_002';
  const bobSessionId = 'ses_bob_001';

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    store = new SqliteWebMessageStore(db);
    platformStorage = new SqlitePlatformStorage(db);
    platformApi = new SqlitePlatformApi({ storage: platformStorage, messageStore: store, db });

    // Seed users, spaces, session routes
    db.exec(`
      INSERT INTO users (id, username, password_hash) VALUES ('${tenantAlice}', 'alice', 'hash_alice');
      INSERT INTO users (id, username, password_hash) VALUES ('${tenantBob}', 'bob', 'hash_bob');

      INSERT INTO spaces (id, user_id, name, folder) VALUES ('${aliceSpaceId}', '${tenantAlice}', 'Alice Space', 'alice-folder');
      INSERT INTO spaces (id, user_id, name, folder) VALUES ('${bobSpaceId}', '${tenantBob}', 'Bob Space', 'bob-folder');

      INSERT INTO session_routes (id, space_id, user_id, channel, native_context_id, dsh_session_id)
      VALUES ('${aliceSessionId}', '${aliceSpaceId}', '${tenantAlice}', 'web', '${aliceSessionId}', 'dsh_alice_1');

      INSERT INTO session_routes (id, space_id, user_id, channel, native_context_id, dsh_session_id)
      VALUES ('${aliceSessionId2}', '${aliceSpaceId}', '${tenantAlice}', 'web', '${aliceSessionId2}', 'dsh_alice_2');

      INSERT INTO session_routes (id, space_id, user_id, channel, native_context_id, dsh_session_id)
      VALUES ('${bobSessionId}', '${bobSpaceId}', '${tenantBob}', 'web', '${bobSessionId}', 'dsh_bob_1');
    `);
  });

  describe('1. 120 Numbered Messages Deterministic Bidirectional Pagination', () => {
    beforeEach(async () => {
      // Insert 120 numbered messages for Alice
      // Message 1 is the oldest, Message 120 is the newest
      const baseTime = new Date('2025-01-01T00:00:00.000Z').getTime();
      for (let i = 1; i <= 120; i++) {
        const timestamp = new Date(baseTime + i * 1000).toISOString();
        const msgId = `msg_seq_${String(i).padStart(4, '0')}`;
        await store.insertMessage({
          id: msgId,
          sessionId: aliceSessionId,
          userId: tenantAlice,
          role: i % 2 === 1 ? 'user' : 'assistant',
          content: `Message ${String(i).padStart(3, '0')}`,
          status: 'delivered',
          routeKey: `route_${aliceSessionId}`,
          turnId: null,
          createdAt: timestamp,
        });
      }
    });

    it('initial chat GET returns latest 50 messages (71-120) in chronological old->new array order with olderCursor & newerCursor', async () => {
      const page1 = await store.listMessages(tenantAlice, aliceSessionId, { limit: 50 });

      expect(page1.messages.length).toBe(50);
      expect(page1.hasMore).toBe(true); // There are older messages (1-70)

      // First item is message 71 (oldest in page), last item is message 120 (newest in page)
      expect(page1.messages[0].content).toBe('Message 071');
      expect(page1.messages[49].content).toBe('Message 120');

      // Verify strictly ascending chronological order (old -> new)
      for (let i = 0; i < 50; i++) {
        const expectedNum = 71 + i;
        expect(page1.messages[i].content).toBe(`Message ${String(expectedNum).padStart(3, '0')}`);
      }

      // olderCursor points to Message 71
      expect(page1.olderCursor).toBeDefined();
      expect(page1.newerCursor).toBeDefined();
    });

    it('paginates backwards: initial 71-120 -> before cursor gives 21-70 -> before cursor gives 1-20 -> empty without duplicates or skips', async () => {
      // Step 1: Initial page (71-120)
      const page1 = await store.listMessages(tenantAlice, aliceSessionId, { limit: 50 });
      expect(page1.messages.length).toBe(50);
      expect(page1.hasMore).toBe(true);
      expect(page1.messages[0].content).toBe('Message 071');
      expect(page1.messages[49].content).toBe('Message 120');

      // Step 2: History page 2 (before page1.olderCursor -> 21-70)
      const page2 = await store.listMessages(tenantAlice, aliceSessionId, { limit: 50, before: page1.olderCursor! });
      expect(page2.messages.length).toBe(50);
      expect(page2.hasMore).toBe(true); // messages 1-20 still exist
      expect(page2.messages[0].content).toBe('Message 021');
      expect(page2.messages[49].content).toBe('Message 070');

      // Verify strictly ascending order
      for (let i = 0; i < 50; i++) {
        const expectedNum = 21 + i;
        expect(page2.messages[i].content).toBe(`Message ${String(expectedNum).padStart(3, '0')}`);
      }

      // Step 3: History page 3 (before page2.olderCursor -> 1-20)
      const page3 = await store.listMessages(tenantAlice, aliceSessionId, { limit: 50, before: page2.olderCursor! });
      expect(page3.messages.length).toBe(20);
      expect(page3.hasMore).toBe(false); // No more older messages
      expect(page3.messages[0].content).toBe('Message 001');
      expect(page3.messages[19].content).toBe('Message 020');

      // Verify strictly ascending order
      for (let i = 0; i < 20; i++) {
        const expectedNum = 1 + i;
        expect(page3.messages[i].content).toBe(`Message ${String(expectedNum).padStart(3, '0')}`);
      }

      // Step 4: History page 4 (before page3.olderCursor -> empty)
      const page4 = await store.listMessages(tenantAlice, aliceSessionId, { limit: 50, before: page3.olderCursor! });
      expect(page4.messages.length).toBe(0);
      expect(page4.hasMore).toBe(false);
      expect(page4.olderCursor).toBeNull();
      expect(page4.newerCursor).toBeNull();

      // Verify full reconstruction has zero duplicates and zero skips
      const allCollected = [...page3.messages, ...page2.messages, ...page1.messages];
      expect(allCollected.length).toBe(120);
      for (let i = 0; i < 120; i++) {
        const expectedNum = 1 + i;
        expect(allCollected[i].content).toBe(`Message ${String(expectedNum).padStart(3, '0')}`);
      }
      const uniqueIds = new Set(allCollected.map((m) => m.id));
      expect(uniqueIds.size).toBe(120);
    });

    it('concurrent insert of message 121 after initial fetch does not appear in older history, but appears in forward after query', async () => {
      // 1. Initial fetch gets 71-120
      const initialPage = await store.listMessages(tenantAlice, aliceSessionId, { limit: 50 });
      expect(initialPage.messages.length).toBe(50);
      expect(initialPage.messages[49].content).toBe('Message 120');

      const initialOlderCursor = initialPage.olderCursor!;
      const initialNewerCursor = initialPage.newerCursor!;

      // 2. Concurrent insert of message 121
      const baseTime = new Date('2025-01-01T00:00:00.000Z').getTime();
      const msg121Timestamp = new Date(baseTime + 121 * 1000).toISOString();
      await store.insertMessage({
        id: 'msg_seq_0121',
        sessionId: aliceSessionId,
        userId: tenantAlice,
        role: 'user',
        content: 'Message 121 Concurrent',
        status: 'delivered',
        routeKey: `route_${aliceSessionId}`,
        turnId: null,
        createdAt: msg121Timestamp,
      });

      // 3. Querying older history with initialOlderCursor MUST NOT include message 121
      const olderHistory = await store.listMessages(tenantAlice, aliceSessionId, { limit: 50, before: initialOlderCursor });
      expect(olderHistory.messages.length).toBe(50);
      expect(olderHistory.messages[0].content).toBe('Message 021');
      expect(olderHistory.messages[49].content).toBe('Message 070');
      expect(olderHistory.messages.some((m) => m.content === 'Message 121 Concurrent')).toBe(false);

      // 4. Querying forward catch-up with initialNewerCursor MUST return message 121
      const catchUp = await store.listMessages(tenantAlice, aliceSessionId, { limit: 50, after: initialNewerCursor });
      expect(catchUp.messages.length).toBe(1);
      expect(catchUp.messages[0].content).toBe('Message 121 Concurrent');
      expect(catchUp.messages[0].id).toBe('msg_seq_0121');
      expect(catchUp.hasMore).toBe(false);
    });
  });

  describe('2. Identical created_at Timestamp Ties & Limit 1 Edge Cases', () => {
    it('paginates deterministically with limit=1 when all messages share the exact same created_at timestamp', async () => {
      const fixedTimestamp = '2025-02-15T10:00:00.000Z';
      const totalTies = 15;

      for (let i = 1; i <= totalTies; i++) {
        const id = `msg_tie_${String(i).padStart(3, '0')}`;
        await store.insertMessage({
          id,
          sessionId: aliceSessionId,
          userId: tenantAlice,
          role: 'user',
          content: `Tie message ${i}`,
          status: 'delivered',
          routeKey: `route_${aliceSessionId}`,
          turnId: null,
          createdAt: fixedTimestamp,
        });
      }

      // 1. Initial page with limit=1 gets the latest message (msg_tie_015)
      const page1 = await store.listMessages(tenantAlice, aliceSessionId, { limit: 1 });
      expect(page1.messages.length).toBe(1);
      expect(page1.messages[0].id).toBe('msg_tie_015');
      expect(page1.hasMore).toBe(true);

      // 2. Iterate backwards 1-by-1 using before
      const collected: WebMessageRecord[] = [page1.messages[0]];
      let cursor = page1.olderCursor!;
      let hasMore = page1.hasMore;

      while (hasMore && cursor) {
        const page = await store.listMessages(tenantAlice, aliceSessionId, { limit: 1, before: cursor });
        if (page.messages.length > 0) {
          collected.unshift(page.messages[0]);
        }
        hasMore = page.hasMore;
        cursor = page.olderCursor ?? '';
      }

      expect(collected.length).toBe(totalTies);
      for (let i = 0; i < totalTies; i++) {
        expect(collected[i].id).toBe(`msg_tie_${String(i + 1).padStart(3, '0')}`);
      }

      // 3. Iterate forwards 1-by-1 using after from the first message
      const forwardCollected: WebMessageRecord[] = [collected[0]];
      let forwardCursor = encodeOpaqueCursor({
        v: 1,
        kind: 'message',
        id: collected[0].id,
        createdAt: collected[0].createdAt,
      });

      while (true) {
        const page = await store.listMessages(tenantAlice, aliceSessionId, { limit: 1, after: forwardCursor });
        if (page.messages.length === 0) break;
        forwardCollected.push(page.messages[0]);
        if (!page.hasMore) break;
        forwardCursor = page.newerCursor!;
      }

      expect(forwardCollected.length).toBe(totalTies);
      for (let i = 0; i < totalTies; i++) {
        expect(forwardCollected[i].id).toBe(`msg_tie_${String(i + 1).padStart(3, '0')}`);
      }
    });
  });

  describe('3. Multi-Tenant Isolation, Cross-Session & Tamper Validation', () => {
    it('strictly isolates tenant cursors: Bob cannot access Alice message cursor with before or after', async () => {
      const msgAlice = await store.insertMessage({
        id: 'msg_alice_sec_01',
        sessionId: aliceSessionId,
        userId: tenantAlice,
        role: 'user',
        content: 'Alice secret',
        status: 'delivered',
        routeKey: `route_${aliceSessionId}`,
        turnId: null,
        createdAt: '2025-01-01T12:00:00.000Z',
      });

      const aliceCursor = encodeOpaqueCursor({
        v: 1,
        kind: 'message',
        id: msgAlice.id,
        createdAt: msgAlice.createdAt,
      });

      // Bob tries before
      await expect(
        store.listMessages(tenantBob, bobSessionId, { before: aliceCursor })
      ).rejects.toThrow(ValidationError);

      // Bob tries after
      await expect(
        store.listMessages(tenantBob, bobSessionId, { after: aliceCursor })
      ).rejects.toThrow(ValidationError);
    });

    it('strictly isolates cross-session cursor for the same user', async () => {
      const msgAliceSes1 = await store.insertMessage({
        id: 'msg_alice_ses1_01',
        sessionId: aliceSessionId,
        userId: tenantAlice,
        role: 'user',
        content: 'Session 1 content',
        status: 'delivered',
        routeKey: `route_${aliceSessionId}`,
        turnId: null,
        createdAt: '2025-01-01T12:00:00.000Z',
      });

      const cursorSes1 = encodeOpaqueCursor({
        v: 1,
        kind: 'message',
        id: msgAliceSes1.id,
        createdAt: msgAliceSes1.createdAt,
      });

      // Querying session 2 with session 1 cursor fails
      await expect(
        store.listMessages(tenantAlice, aliceSessionId2, { before: cursorSes1 })
      ).rejects.toThrow(ValidationError);
      await expect(
        store.listMessages(tenantAlice, aliceSessionId2, { after: cursorSes1 })
      ).rejects.toThrow(ValidationError);
    });

    it('strictly rejects specifying both before and after', async () => {
      const msg = await store.insertMessage({
        id: 'msg_both_01',
        sessionId: aliceSessionId,
        userId: tenantAlice,
        role: 'user',
        content: 'Test both',
        status: 'delivered',
        routeKey: `route_${aliceSessionId}`,
        turnId: null,
        createdAt: '2025-01-01T12:00:00.000Z',
      });

      const cursor = encodeOpaqueCursor({
        v: 1,
        kind: 'message',
        id: msg.id,
        createdAt: msg.createdAt,
      });

      await expect(
        store.listMessages(tenantAlice, aliceSessionId, { before: cursor, after: cursor })
      ).rejects.toThrow(/Cannot specify both/);
    });

    it('strictly rejects legacy cursor parameter', async () => {
      await expect(
        store.listMessages(tenantAlice, aliceSessionId, { cursor: 'some_cursor' } as any)
      ).rejects.toThrow(/Legacy "cursor" parameter is removed/);

      await expect(
        platformApi.listMessages(tenantAlice, aliceSessionId, { cursor: 'some_cursor' } as any)
      ).rejects.toThrow(/Legacy "cursor" parameter is removed/);
    });
  });

  describe('4. PlatformServer HTTP GET /api/sessions/:sessionId/messages Handler Contract', () => {
    let server: PlatformServer;
    let baseUrl: string;
    let aliceCookie: string;
    let bobCookie: string;
    let httpAliceSessionId: string;
    const testCsrfToken = 'pagination-csrf-token-32-chars-long!';

    beforeEach(async () => {
      const httpDb = new DatabaseSync(':memory:');
      const runner = new PlatformServerMigrationRunner(httpDb);
      await runner.migrate(ALL_PLATFORM_MIGRATIONS);

      const httpStorage = new SqlitePlatformStorage(httpDb);
      const httpMessageStore = new SqliteWebMessageStore(httpDb);
      const runtimeGateway = new TestOnlyRuntimeGateway({
        storage: httpStorage,
        messageStore: httpMessageStore,
        autoReply: false,
      });

      server = new PlatformServer({
        database: httpDb,
        port: 0,
        cookieSecret: 'pagination-cookie-secret-32-chars-long-secure!',
        csrfToken: testCsrfToken,
        runtimeGateway,
      });

      await server.start();
      baseUrl = server.getUrl()!;

      // Provision fixtures
      const fixtures = await provisionFixtures(server.storage, server.authService, {
        adminUsername: 'alice',
        adminPassword: 'AlicePassword123!',
        userPassword: 'BobPassword123!',
        disabledPassword: 'CharlieDisabledPassword123!',
      });

      // Login Alice
      const aliceLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({ username: 'alice', password: 'AlicePassword123!' }),
      });
      aliceCookie = aliceLoginRes.headers.get('set-cookie')?.split(';')[0] || '';

      // Login Bob
      const bobLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
        },
        body: JSON.stringify({ username: 'bob', password: 'BobPassword123!' }),
      });
      bobCookie = bobLoginRes.headers.get('set-cookie')?.split(';')[0] || '';

      // Create Alice session
      const createSesRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({ spaceId: fixtures.adminContainerSpace.id, title: 'HTTP Pagination Session' }),
      });
      const createSesJson = await createSesRes.json();
      httpAliceSessionId = createSesJson.data.id;
    });

    afterEach(async () => {
      if (server) {
        await server.stop();
      }
    });

    it('rejects unknown query parameters on GET /messages with 400 VALIDATION_ERROR', async () => {
      const res = await fetch(`${baseUrl}/api/sessions/${httpAliceSessionId}/messages?foo=bar`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
      expect(json.error.message).toContain('Unexpected query parameter "foo"');
    });

    it('rejects legacy cursor query parameter on GET /messages with 400 VALIDATION_ERROR', async () => {
      const res = await fetch(`${baseUrl}/api/sessions/${httpAliceSessionId}/messages?cursor=legacy_cursor`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
      expect(json.error.message).toContain('Unexpected query parameter "cursor"');
    });

    it('rejects both before and after query parameters on GET /messages with 400 VALIDATION_ERROR', async () => {
      const res = await fetch(`${baseUrl}/api/sessions/${httpAliceSessionId}/messages?before=c1&after=c2`, {
        headers: { Cookie: aliceCookie },
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
      expect(json.error.message).toContain("Cannot specify both 'before' and 'after'");
    });

    it('executes full HTTP bidirectional pagination on 120 messages', async () => {
      const user = await server.storage.users.findByUsername('alice');
      const aliceUserId = user!.id;
      const baseTime = new Date('2025-01-01T00:00:00.000Z').getTime();

      for (let i = 1; i <= 120; i++) {
        const timestamp = new Date(baseTime + i * 1000).toISOString();
        await server.messageStore.insertMessage({
          id: `http_msg_${String(i).padStart(4, '0')}`,
          sessionId: httpAliceSessionId,
          userId: aliceUserId,
          role: 'user',
          content: `HTTP Message ${String(i).padStart(3, '0')}`,
          status: 'delivered',
          routeKey: `route_${httpAliceSessionId}`,
          turnId: null,
          createdAt: timestamp,
        });
      }

      // 1. Initial GET -> returns 71-120 in ASC order
      const initialRes = await fetch(`${baseUrl}/api/sessions/${httpAliceSessionId}/messages?limit=50`, {
        headers: { Cookie: aliceCookie },
      });
      expect(initialRes.status).toBe(200);
      const initialJson = await initialRes.json();
      expect(initialJson.success).toBe(true);
      expect(initialJson.data.messages.length).toBe(50);
      expect(initialJson.data.hasMore).toBe(true);
      expect(initialJson.data.messages[0].content).toBe('HTTP Message 071');
      expect(initialJson.data.messages[49].content).toBe('HTTP Message 120');

      const olderCursor1 = initialJson.data.olderCursor;
      const newerCursor1 = initialJson.data.newerCursor;
      expect(olderCursor1).toBeDefined();
      expect(newerCursor1).toBeDefined();

      // 2. Fetch older history (before) -> returns 21-70 in ASC order
      const hist2Res = await fetch(
        `${baseUrl}/api/sessions/${httpAliceSessionId}/messages?limit=50&before=${encodeURIComponent(olderCursor1)}`,
        { headers: { Cookie: aliceCookie } }
      );
      expect(hist2Res.status).toBe(200);
      const hist2Json = await hist2Res.json();
      expect(hist2Json.data.messages.length).toBe(50);
      expect(hist2Json.data.hasMore).toBe(true);
      expect(hist2Json.data.messages[0].content).toBe('HTTP Message 021');
      expect(hist2Json.data.messages[49].content).toBe('HTTP Message 070');

      // 3. Fetch older history (before) -> returns 1-20 in ASC order
      const hist3Res = await fetch(
        `${baseUrl}/api/sessions/${httpAliceSessionId}/messages?limit=50&before=${encodeURIComponent(hist2Json.data.olderCursor)}`,
        { headers: { Cookie: aliceCookie } }
      );
      expect(hist3Res.status).toBe(200);
      const hist3Json = await hist3Res.json();
      expect(hist3Json.data.messages.length).toBe(20);
      expect(hist3Json.data.hasMore).toBe(false);
      expect(hist3Json.data.messages[0].content).toBe('HTTP Message 001');
      expect(hist3Json.data.messages[19].content).toBe('HTTP Message 020');

      // 4. Forward catch-up after newerCursor1 -> empty currently
      const afterEmptyRes = await fetch(
        `${baseUrl}/api/sessions/${httpAliceSessionId}/messages?limit=50&after=${encodeURIComponent(newerCursor1)}`,
        { headers: { Cookie: aliceCookie } }
      );
      expect(afterEmptyRes.status).toBe(200);
      const afterEmptyJson = await afterEmptyRes.json();
      expect(afterEmptyJson.data.messages.length).toBe(0);
      expect(afterEmptyJson.data.hasMore).toBe(false);

      // 5. Insert message 121
      const msg121Timestamp = new Date(baseTime + 121 * 1000).toISOString();
      await server.messageStore.insertMessage({
        id: 'http_msg_0121',
        sessionId: httpAliceSessionId,
        userId: aliceUserId,
        role: 'user',
        content: 'HTTP Message 121 New',
        status: 'delivered',
        routeKey: `route_${httpAliceSessionId}`,
        turnId: null,
        createdAt: msg121Timestamp,
      });

      // 6. Forward catch-up after newerCursor1 -> returns message 121
      const after121Res = await fetch(
        `${baseUrl}/api/sessions/${httpAliceSessionId}/messages?limit=50&after=${encodeURIComponent(newerCursor1)}`,
        { headers: { Cookie: aliceCookie } }
      );
      expect(after121Res.status).toBe(200);
      const after121Json = await after121Res.json();
      expect(after121Json.data.messages.length).toBe(1);
      expect(after121Json.data.messages[0].content).toBe('HTTP Message 121 New');
      expect(after121Json.data.hasMore).toBe(false);
    });
  });
});
