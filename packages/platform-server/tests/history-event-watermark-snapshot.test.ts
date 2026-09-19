import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ValidationError } from '@enkeep/platform-core';
import {
  SqliteWebMessageStore,
  encodeOpaqueCursor,
  decodeAndValidateCursor,
  type WebEventRecord,
} from '../src/storage/web-messages.js';
import { SqlitePlatformWebApiAdapter } from '../src/storage/sqlite-platform-api.js';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { PlatformServerMigrationRunner, ALL_PLATFORM_MIGRATIONS } from '../src/storage/migrations.js';
import { PlatformServer } from '../src/server/server.js';
import { provisionFixtures } from '@enkeep/platform-auth';
import { TestOnlyRuntimeGateway } from './test-runtime-gateway.js';

describe('History Event Watermark Snapshot & Regression Tests', () => {
  let db: DatabaseSync;
  let store: SqliteWebMessageStore;
  let storage: SqlitePlatformStorage;
  let platformApi: SqlitePlatformWebApiAdapter;

  const tenantAlice = 'usr_alice_watermark';
  const tenantBob = 'usr_bob_watermark';
  const spaceAlice = 'spc_alice_watermark';
  const sessionAlice1 = 'ses_alice_watermark_01';
  const sessionAlice2 = 'ses_alice_watermark_02';
  const sessionBob1 = 'ses_bob_watermark_01';

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    store = new SqliteWebMessageStore(db);
    storage = new SqlitePlatformStorage(db);
    platformApi = new SqlitePlatformWebApiAdapter({
      db,
      storage,
      messageStore: store,
    });

    // Seed tenants, spaces, and session routes
    db.exec(`
      INSERT INTO users (id, username, password_hash, status)
      VALUES
        ('${tenantAlice}', 'alice', 'hash', 'active'),
        ('${tenantBob}', 'bob', 'hash', 'active');

      INSERT INTO spaces (id, user_id, name, folder, status, execution_mode)
      VALUES
        ('${spaceAlice}', '${tenantAlice}', 'Alice Space', 'folder_a', 'active', 'container');

      INSERT INTO session_routes (id, space_id, user_id, channel, account_id, native_context_id, dsh_session_id, status, execution_mode)
      VALUES
        ('${sessionAlice1}', '${spaceAlice}', '${tenantAlice}', 'web', 'default', 'ctx_a1', 'dsh_a1', 'active', 'container'),
        ('${sessionAlice2}', '${spaceAlice}', '${tenantAlice}', 'web', 'default', 'ctx_a2', 'dsh_a2', 'active', 'container'),
        ('${sessionBob1}', '${spaceAlice}', '${tenantBob}', 'web', 'default', 'ctx_b1', 'dsh_b1', 'active', 'container');
    `);
  });

  it('1. Old April events + new Sep messages: initial snapshot returns event cursor (not message cursor), poll after excludes old April events', async () => {
    // 1a. Insert old events in April 2026
    const aprilTime1 = '2026-04-10T10:00:00.000Z';
    const aprilTime2 = '2026-04-10T10:05:00.000Z';

    await store.insertEvent({
      id: 'evt_april_001',
      sessionId: sessionAlice1,
      userId: tenantAlice,
      type: 'turn_status',
      payload: { status: 'running' },
      createdAt: aprilTime1,
    });

    await store.insertEvent({
      id: 'evt_april_002',
      sessionId: sessionAlice1,
      userId: tenantAlice,
      type: 'turn_status',
      payload: { status: 'completed' },
      createdAt: aprilTime2,
    });

    // 1b. Insert new messages in September 2026
    const sepTime1 = '2026-09-01T12:00:00.000Z';
    const sepTime2 = '2026-09-01T12:01:00.000Z';

    await store.insertMessage({
      id: 'msg_sep_001',
      sessionId: sessionAlice1,
      userId: tenantAlice,
      role: 'user',
      content: 'Hello September',
      status: 'delivered',
      routeKey: `route_${sessionAlice1}`,
      turnId: null,
      createdAt: sepTime1,
    });

    await store.insertMessage({
      id: 'msg_sep_002',
      sessionId: sessionAlice1,
      userId: tenantAlice,
      role: 'assistant',
      content: 'September reply',
      status: 'delivered',
      routeKey: `route_${sessionAlice1}`,
      turnId: null,
      createdAt: sepTime2,
    });

    // 1c. Fetch initial messages snapshot
    const initialSnapshot = await store.listMessages(tenantAlice, sessionAlice1, { limit: 50 });
    expect(initialSnapshot.messages).toHaveLength(2);
    expect(initialSnapshot.latestEventCursor).toBeDefined();
    expect(typeof initialSnapshot.latestEventCursor).toBe('string');

    // Verify the cursor kind is 'event' and points to the latest April event
    const decoded = decodeAndValidateCursor(db, initialSnapshot.latestEventCursor!, 'event', tenantAlice, sessionAlice1);
    expect(decoded.id).toBe('evt_april_002');
    expect(decoded.createdAt).toBe(aprilTime2);

    // 1d. Poll events using latestEventCursor: old April events MUST be excluded
    const pollRes = await store.pollEvents(tenantAlice, sessionAlice1, {
      cursor: initialSnapshot.latestEventCursor!,
    });
    expect(pollRes.events).toHaveLength(0);
  });

  it('2. Event arrives after capture => next poll includes it', async () => {
    // Initial snapshot with April event
    await store.insertEvent({
      id: 'evt_april_watermark',
      sessionId: sessionAlice1,
      userId: tenantAlice,
      type: 'turn_status',
      payload: { status: 'completed' },
      createdAt: '2026-04-10T10:00:00.000Z',
    });

    const snapshot = await store.listMessages(tenantAlice, sessionAlice1, { limit: 50 });
    const cursor = snapshot.latestEventCursor!;
    expect(cursor).toBeTruthy();

    // Event arrives after capture point
    const newEventTime = '2026-09-01T15:00:00.000Z';
    await store.insertEvent({
      id: 'evt_sep_post_capture',
      sessionId: sessionAlice1,
      userId: tenantAlice,
      type: 'turn_status',
      payload: { status: 'running' },
      createdAt: newEventTime,
    });

    // Next poll includes the new post-capture event
    const pollRes = await store.pollEvents(tenantAlice, sessionAlice1, { cursor });
    expect(pollRes.events).toHaveLength(1);
    expect(pollRes.events[0].id).toBe('evt_sep_post_capture');
  });

  it('3. Event during history load (interleaving hook) leaves NO gap', async () => {
    // Seed initial event and messages
    await store.insertEvent({
      id: 'evt_prior_01',
      sessionId: sessionAlice1,
      userId: tenantAlice,
      type: 'turn_status',
      payload: { status: 'completed' },
      createdAt: '2026-04-01T00:00:00.000Z',
    });

    await store.insertMessage({
      id: 'msg_prior_01',
      sessionId: sessionAlice1,
      userId: tenantAlice,
      role: 'user',
      content: 'Initial history message',
      status: 'delivered',
      routeKey: `route_${sessionAlice1}`,
      turnId: null,
      createdAt: '2026-04-01T00:00:00.000Z',
    });

    // Interleaving hook simulates an event arriving concurrently during the snapshot transaction
    let interleavedEventId = 'evt_interleaved_01';
    const snapshot = await store.listMessages(tenantAlice, sessionAlice1, {
      limit: 50,
      _interleavingHook: () => {
        // Watermark has already been selected inside the coherent read transaction.
        // Even if an external event is written right now, it will be strictly newer than watermark.
        db.prepare(`
          INSERT INTO web_events (id, session_id, user_id, type, payload, created_at)
          VALUES (?, ?, ?, 'turn_status', '{"status":"running"}', '2026-04-01T00:00:01.000Z')
        `).run(interleavedEventId, sessionAlice1, tenantAlice);
      },
    });

    expect(snapshot.latestEventCursor).toBeDefined();
    // Watermark captured prior event
    const decoded = decodeAndValidateCursor(db, snapshot.latestEventCursor!, 'event', tenantAlice, sessionAlice1);
    expect(decoded.id).toBe('evt_prior_01');

    // Next poll using latestEventCursor MUST see the interleaved event (no gap)
    const pollRes = await store.pollEvents(tenantAlice, sessionAlice1, {
      cursor: snapshot.latestEventCursor!,
    });
    expect(pollRes.events).toHaveLength(1);
    expect(pollRes.events[0].id).toBe(interleavedEventId);
  });

  it('4. Deterministic ordering with same-timestamp IDs', async () => {
    const sameTimestamp = '2026-09-02T10:00:00.000Z';

    // Insert three events with identical timestamp but alphabetical IDs
    await store.insertEvent({
      id: 'evt_same_time_a',
      sessionId: sessionAlice1,
      userId: tenantAlice,
      type: 'turn_status',
      payload: { status: 'running' },
      createdAt: sameTimestamp,
    });
    await store.insertEvent({
      id: 'evt_same_time_b',
      sessionId: sessionAlice1,
      userId: tenantAlice,
      type: 'turn_status',
      payload: { status: 'running' },
      createdAt: sameTimestamp,
    });
    await store.insertEvent({
      id: 'evt_same_time_c',
      sessionId: sessionAlice1,
      userId: tenantAlice,
      type: 'turn_status',
      payload: { status: 'completed' },
      createdAt: sameTimestamp,
    });

    // Initial snapshot picks the highest ID under created_at DESC, id DESC: 'evt_same_time_c'
    const snapshot = await store.listMessages(tenantAlice, sessionAlice1, { limit: 50 });
    const decoded = decodeAndValidateCursor(db, snapshot.latestEventCursor!, 'event', tenantAlice, sessionAlice1);
    expect(decoded.id).toBe('evt_same_time_c');

    // Poll with this cursor: all 3 events are excluded
    const pollEmpty = await store.pollEvents(tenantAlice, sessionAlice1, { cursor: snapshot.latestEventCursor! });
    expect(pollEmpty.events).toHaveLength(0);

    // Insert an event with the same timestamp but higher ID 'evt_same_time_d'
    await store.insertEvent({
      id: 'evt_same_time_d',
      sessionId: sessionAlice1,
      userId: tenantAlice,
      type: 'turn_status',
      payload: { status: 'completed' },
      createdAt: sameTimestamp,
    });

    // Next poll retrieves 'evt_same_time_d' deterministically
    const pollNext = await store.pollEvents(tenantAlice, sessionAlice1, { cursor: snapshot.latestEventCursor! });
    expect(pollNext.events).toHaveLength(1);
    expect(pollNext.events[0].id).toBe('evt_same_time_d');
  });

  it('5. Cross-session and cross-tenant event cursor is rejected', async () => {
    // Seed event for Alice session 1
    await store.insertEvent({
      id: 'evt_alice_s1',
      sessionId: sessionAlice1,
      userId: tenantAlice,
      type: 'turn_status',
      payload: { status: 'completed' },
      createdAt: '2026-09-01T10:00:00.000Z',
    });

    const snapshot = await store.listMessages(tenantAlice, sessionAlice1, { limit: 50 });
    const aliceCursor = snapshot.latestEventCursor!;

    // Passing Alice's cursor to Bob's pollEvents throws ValidationError
    await expect(
      store.pollEvents(tenantBob, sessionBob1, { cursor: aliceCursor })
    ).rejects.toThrow(ValidationError);

    // Passing Alice's session 1 cursor to Alice's session 2 throws ValidationError
    await expect(
      store.pollEvents(tenantAlice, sessionAlice2, { cursor: aliceCursor })
    ).rejects.toThrow(ValidationError);
  });

  it('6. Empty-event session produces explicit boundary cursor: latestEventCursor === null', async () => {
    // Session has no events
    const snapshot = await store.listMessages(tenantAlice, sessionAlice1, { limit: 50 });
    expect(snapshot.latestEventCursor).toBeNull();

    // Verify key is explicitly present
    expect('latestEventCursor' in snapshot).toBe(true);

    // Polling with null/omitted cursor works from genesis
    const pollGenesis = await store.pollEvents(tenantAlice, sessionAlice1);
    expect(pollGenesis.events).toHaveLength(0);

    // When an event arrives post-snapshot, polling from genesis includes it
    await store.insertEvent({
      id: 'evt_first_ever',
      sessionId: sessionAlice1,
      userId: tenantAlice,
      type: 'turn_status',
      payload: { status: 'completed' },
      createdAt: '2026-09-01T10:00:00.000Z',
    });

    const pollAfterEvent = await store.pollEvents(tenantAlice, sessionAlice1);
    expect(pollAfterEvent.events).toHaveLength(1);
    expect(pollAfterEvent.events[0].id).toBe('evt_first_ever');
  });

  it('7. Pagination preserves UI invariant: older page fetches do NOT return latestEventCursor', async () => {
    // Seed 3 messages
    for (let i = 1; i <= 3; i++) {
      await store.insertMessage({
        id: `msg_page_${i}`,
        sessionId: sessionAlice1,
        userId: tenantAlice,
        role: 'user',
        content: `Msg ${i}`,
        status: 'delivered',
        routeKey: `route_${sessionAlice1}`,
        turnId: null,
        createdAt: `2026-09-01T10:0${i}:00.000Z`,
      });
    }

    // Initial fetch returns latestEventCursor
    const initialPage = await store.listMessages(tenantAlice, sessionAlice1, { limit: 1 });
    expect(initialPage.latestEventCursor).toBeDefined();

    // Pagination fetch with 'before' does NOT return latestEventCursor
    const olderPage = await store.listMessages(tenantAlice, sessionAlice1, {
      limit: 1,
      before: initialPage.olderCursor!,
    });
    expect(olderPage.latestEventCursor).toBeUndefined();
    expect('latestEventCursor' in olderPage).toBe(false);

    // Pagination fetch with 'after' does NOT return latestEventCursor
    const newerPage = await store.listMessages(tenantAlice, sessionAlice1, {
      limit: 1,
      after: initialPage.olderCursor!,
    });
    expect(newerPage.latestEventCursor).toBeUndefined();
    expect('latestEventCursor' in newerPage).toBe(false);
  });

  describe('8. Real HTTP Server & PlatformWebApiAdapter Integration', () => {
    let server: PlatformServer;
    let baseUrl: string;
    let aliceCookie: string;
    let httpAliceSessionId: string;
    const testCsrf = 'csrf-test-token-watermark-32chars!';

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
        cookieSecret: 'cookie-secret-watermark-32-chars-long!',
        csrfToken: testCsrf,
        runtimeGateway,
      });

      await server.start();
      baseUrl = server.getUrl()!;

      const fixtures = await provisionFixtures(server.storage, server.authService, {
        adminUsername: 'alice_http',
        adminPassword: 'AliceHttpPassword123!',
        userPassword: 'BobHttpPassword123!',
        disabledPassword: 'CharlieHttpPassword123!',
      });

      const aliceLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrf,
          Origin: baseUrl,
        },
        body: JSON.stringify({ username: 'alice_http', password: 'AliceHttpPassword123!' }),
      });
      aliceCookie = aliceLoginRes.headers.get('set-cookie')?.split(';')[0] || '';

      const createSesRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': testCsrf,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({ spaceId: fixtures.adminContainerSpace.id, title: 'HTTP Watermark Session' }),
      });
      const createSesJson = await createSesRes.json();
      httpAliceSessionId = createSesJson.data.id;
    });

    afterEach(async () => {
      if (server) {
        await server.stop();
      }
    });

    it('returns latestEventCursor on GET /messages and preserves read-only database guarantee', async () => {
      const user = await server.storage.users.findByUsername('alice_http');
      const aliceUserId = user!.id;

      // Seed an event and a message
      await server.messageStore.insertEvent({
        id: 'evt_http_001',
        sessionId: httpAliceSessionId,
        userId: aliceUserId,
        type: 'turn_status',
        payload: { status: 'completed' },
        createdAt: '2026-04-15T12:00:00.000Z',
      });

      await server.messageStore.insertMessage({
        id: 'msg_http_001',
        sessionId: httpAliceSessionId,
        userId: aliceUserId,
        role: 'user',
        content: 'HTTP Initial message',
        status: 'delivered',
        routeKey: `route_${httpAliceSessionId}`,
        turnId: null,
        createdAt: '2026-09-01T12:00:00.000Z',
      });

      // 1. Initial messages query
      const resInitial = await fetch(`${baseUrl}/api/sessions/${httpAliceSessionId}/messages`, {
        headers: { Cookie: aliceCookie },
      });
      expect(resInitial.status).toBe(200);
      const jsonInitial = await resInitial.json();
      expect(jsonInitial.success).toBe(true);
      expect(jsonInitial.data.messages).toHaveLength(1);
      expect(jsonInitial.data.latestEventCursor).toBeDefined();
      expect(typeof jsonInitial.data.latestEventCursor).toBe('string');

      // Verify that the event cursor can be decoded as 'event'
      const decoded = decodeAndValidateCursor(
        server.db,
        jsonInitial.data.latestEventCursor,
        'event',
        aliceUserId,
        httpAliceSessionId
      );
      expect(decoded.id).toBe('evt_http_001');

      // 2. Poll events using latestEventCursor via HTTP /api/sessions/:id/events?cursor=...
      const resEvents = await fetch(
        `${baseUrl}/api/sessions/${httpAliceSessionId}/events?cursor=${encodeURIComponent(jsonInitial.data.latestEventCursor)}`,
        { headers: { Cookie: aliceCookie } }
      );
      expect(resEvents.status).toBe(200);
      const jsonEvents = await resEvents.json();
      expect(jsonEvents.success).toBe(true);
      expect(jsonEvents.data.events).toHaveLength(0); // old event excluded

      // 3. Pagination query with 'before' does NOT include latestEventCursor
      const resPage = await fetch(
        `${baseUrl}/api/sessions/${httpAliceSessionId}/messages?before=${encodeURIComponent(jsonInitial.data.olderCursor)}`,
        { headers: { Cookie: aliceCookie } }
      );
      expect(resPage.status).toBe(200);
      const jsonPage = await resPage.json();
      expect(jsonPage.success).toBe(true);
      expect('latestEventCursor' in jsonPage.data).toBe(false);
    });

    it('returns latestEventCursor: null for empty-event session via HTTP', async () => {
      // Empty session (no events)
      const resInitial = await fetch(`${baseUrl}/api/sessions/${httpAliceSessionId}/messages`, {
        headers: { Cookie: aliceCookie },
      });
      expect(resInitial.status).toBe(200);
      const jsonInitial = await resInitial.json();
      expect(jsonInitial.success).toBe(true);
      expect(jsonInitial.data.messages).toHaveLength(0);
      expect(jsonInitial.data.latestEventCursor).toBeNull();
      expect('latestEventCursor' in jsonInitial.data).toBe(true);
    });
  });

  describe('9. Multi-Connection WAL & Concurrency Regressions', () => {
    let tmpDir: string;
    let dbFile: string;
    let conn1: DatabaseSync;
    let conn2: DatabaseSync;
    let store1: SqliteWebMessageStore;
    let store2: SqliteWebMessageStore;

    beforeEach(async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'enkeep-wal-test-'));
      dbFile = join(tmpDir, 'test-wal.db');

      conn1 = new DatabaseSync(dbFile);
      conn1.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
      const runner = new PlatformServerMigrationRunner(conn1);
      await runner.migrate(ALL_PLATFORM_MIGRATIONS);

      conn2 = new DatabaseSync(dbFile);
      conn2.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

      store1 = new SqliteWebMessageStore(conn1);
      store2 = new SqliteWebMessageStore(conn2);

      // Seed tenant, space, session on conn1
      conn1.exec(`
        INSERT INTO users (id, username, password_hash, status)
        VALUES ('${tenantAlice}', 'alice', 'hash', 'active');

        INSERT INTO spaces (id, user_id, name, folder, status, execution_mode)
        VALUES ('${spaceAlice}', '${tenantAlice}', 'Alice Space', 'folder_a', 'active', 'container');

        INSERT INTO session_routes (id, space_id, user_id, channel, account_id, native_context_id, dsh_session_id, status, execution_mode)
        VALUES ('${sessionAlice1}', '${spaceAlice}', '${tenantAlice}', 'web', 'default', 'ctx_a1', 'dsh_a1', 'active', 'container');
      `);
    });

    afterEach(() => {
      try {
        conn1.close();
      } catch {}
      try {
        conn2.close();
      } catch {}
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    });

    it('handles same-ms random IDs where later insert has lexicographically smaller ID across 2 SQLite connections', async () => {
      const sameTime = '2026-06-01T12:00:00.000Z';

      // Conn 1 inserts an event with a lexicographically large ID
      await store1.insertEvent({
        id: 'evt_zzzz_rand',
        sessionId: sessionAlice1,
        userId: tenantAlice,
        type: 'turn_status',
        payload: { status: 'running' },
        createdAt: sameTime,
      });

      // Conn 1 takes initial snapshot -> captures latestEventCursor
      const snapshot = await store1.listMessages(tenantAlice, sessionAlice1, { limit: 50 });
      const watermarkCursor = snapshot.latestEventCursor!;
      expect(watermarkCursor).toBeTruthy();

      // Conn 2 inserts a subsequent event in the EXACT SAME millisecond but with lexicographically smaller ID
      await store2.insertEvent({
        id: 'evt_aaaa_rand',
        sessionId: sessionAlice1,
        userId: tenantAlice,
        type: 'turn_status',
        payload: { status: 'completed' },
        createdAt: sameTime,
      });

      // Conn 1 polls with watermarkCursor: MUST include evt_aaaa_rand via append sequence rowid!
      const pollRes = await store1.pollEvents(tenantAlice, sessionAlice1, { cursor: watermarkCursor });
      expect(pollRes.events).toHaveLength(1);
      expect(pollRes.events[0].id).toBe('evt_aaaa_rand');
    });

    it('includes late backdated event inserted after snapshot boundary irrespective of timestamp', async () => {
      // Conn 1 inserts event in September
      await store1.insertEvent({
        id: 'evt_sep_norm',
        sessionId: sessionAlice1,
        userId: tenantAlice,
        type: 'turn_status',
        payload: { status: 'completed' },
        createdAt: '2026-09-01T12:00:00.000Z',
      });

      const snapshot = await store1.listMessages(tenantAlice, sessionAlice1, { limit: 50 });
      const watermarkCursor = snapshot.latestEventCursor!;

      // Conn 2 inserts an event with a backdated timestamp from April
      await store2.insertEvent({
        id: 'evt_backdated_april',
        sessionId: sessionAlice1,
        userId: tenantAlice,
        type: 'turn_status',
        payload: { status: 'running' },
        createdAt: '2026-04-01T00:00:00.000Z', // 5 months older timestamp!
      });

      // Polling with watermarkCursor MUST include the backdated event because its committed append rowid is newer
      const pollRes = await store1.pollEvents(tenantAlice, sessionAlice1, { cursor: watermarkCursor });
      expect(pollRes.events).toHaveLength(1);
      expect(pollRes.events[0].id).toBe('evt_backdated_april');
    });

    it('replayed INSERT of existing event preserves rowid and avoids endless poll loops', async () => {
      // 1. Insert event
      await store1.insertEventsBatch([{
        id: 'evt_idemp_repeat',
        sessionId: sessionAlice1,
        userId: tenantAlice,
        type: 'turn_status',
        payload: { status: 'completed' },
        createdAt: '2026-06-01T10:00:00.000Z',
      }]);

      // 2. Poll to consume event and get nextCursor
      const poll1 = await store1.pollEvents(tenantAlice, sessionAlice1);
      expect(poll1.events).toHaveLength(1);
      const pollCursor = poll1.nextCursor!;
      expect(pollCursor).toBeTruthy();

      // 3. Confirm next poll is empty
      const poll2 = await store1.pollEvents(tenantAlice, sessionAlice1, { cursor: pollCursor });
      expect(poll2.events).toHaveLength(0);

      // 4. Replay the exact same event batch (idempotency test)
      await store2.insertEventsBatch([{
        id: 'evt_idemp_repeat',
        sessionId: sessionAlice1,
        userId: tenantAlice,
        type: 'turn_status',
        payload: { status: 'completed' },
        createdAt: '2026-06-01T10:00:00.000Z',
      }]);

      // 5. Poll again with pollCursor: MUST still be 0 (rowid was not advanced by replay!)
      const pollAfterReplay = await store1.pollEvents(tenantAlice, sessionAlice1, { cursor: pollCursor });
      expect(pollAfterReplay.events).toHaveLength(0);
    });

    it('backward compatibility: legacy v1 event cursor is accepted and resolved to rowid sequence', async () => {
      // Insert two events
      await store1.insertEvent({
        id: 'evt_legacy_01',
        sessionId: sessionAlice1,
        userId: tenantAlice,
        type: 'turn_status',
        payload: { status: 'running' },
        createdAt: '2026-06-01T10:00:00.000Z',
      });
      await store1.insertEvent({
        id: 'evt_legacy_02',
        sessionId: sessionAlice1,
        userId: tenantAlice,
        type: 'turn_status',
        payload: { status: 'completed' },
        createdAt: '2026-06-01T10:01:00.000Z',
      });

      // Fabricate a legacy v1 event cursor (no seq key)
      const v1Cursor = encodeOpaqueCursor({
        v: 1,
        kind: 'event',
        id: 'evt_legacy_01',
        createdAt: '2026-06-01T10:00:00.000Z',
      });

      // Verify decodeAndValidateCursor resolves v1 cursor to database rowid
      const decoded = decodeAndValidateCursor(conn1, v1Cursor, 'event', tenantAlice, sessionAlice1);
      expect(decoded.id).toBe('evt_legacy_01');
      expect(decoded.rowid).toBeDefined();
      expect(typeof decoded.rowid).toBe('number');

      // Poll with legacy v1 cursor: returns the next event correctly
      const pollRes = await store1.pollEvents(tenantAlice, sessionAlice1, { cursor: v1Cursor });
      expect(pollRes.events).toHaveLength(1);
      expect(pollRes.events[0].id).toBe('evt_legacy_02');
      // nextCursor should now be upgraded to v2 format
      expect(pollRes.nextCursor).toBeDefined();
    });
  });
});
