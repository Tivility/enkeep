import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MigrationError,
  MigrationDowngradeError,
  MigrationChecksumMismatchError,
  ValidationError,
  PlatformError,
} from '@enkeep/platform-core';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  computeChecksum,
  SqliteWebMessageStore,
  type WebMessageRecord,
  type WebEventRecord,
} from '../src/index.js';
import {
  encodeOpaqueCursor,
  decodeAndValidateCursor,
} from '../src/storage/web-messages.js';

describe('PlatformServerMigrationRunner & SqliteWebMessageStore Hardening', () => {
  describe('1. PlatformServerMigrationRunner: Manifest, Contiguity, Tamper, Downgrade & WAL Concurrency', () => {
    let db: DatabaseSync;
    let runner: PlatformServerMigrationRunner;

    beforeEach(() => {
      db = new DatabaseSync(':memory:');
      runner = new PlatformServerMigrationRunner(db);
    });

    it('rejects invalid manifest: negative/zero version, empty name, empty SQL, gap, duplicate, non-1 start', async () => {
      // Zero version
      await expect(
        runner.migrate([{ version: 0, name: 'v0', upSql: 'CREATE TABLE t0 (id INT);' }])
      ).rejects.toThrow(MigrationError);

      // Negative version
      await expect(
        runner.migrate([{ version: -1, name: 'v_neg', upSql: 'CREATE TABLE t0 (id INT);' }])
      ).rejects.toThrow(MigrationError);

      // Non-1 start
      await expect(
        runner.migrate([{ version: 2, name: 'v2', upSql: 'CREATE TABLE t2 (id INT);' }])
      ).rejects.toThrow(MigrationError);

      // Empty name
      await expect(
        runner.migrate([{ version: 1, name: '', upSql: 'CREATE TABLE t1 (id INT);' }])
      ).rejects.toThrow(MigrationError);

      // Empty upSql
      await expect(
        runner.migrate([{ version: 1, name: 'v1', upSql: '' }])
      ).rejects.toThrow(MigrationError);

      // Gap in manifest: 1, 3
      await expect(
        runner.migrate([
          { version: 1, name: 'v1', upSql: 'CREATE TABLE t1 (id INT);' },
          { version: 3, name: 'v3', upSql: 'CREATE TABLE t3 (id INT);' },
        ])
      ).rejects.toThrow(MigrationError);

      // Duplicate version: 1, 1
      await expect(
        runner.migrate([
          { version: 1, name: 'v1a', upSql: 'CREATE TABLE t1a (id INT);' },
          { version: 1, name: 'v1b', upSql: 'CREATE TABLE t1b (id INT);' },
        ])
      ).rejects.toThrow(MigrationError);
    });

    it('detects database tampering: gapped applied migrations in _schema_migrations', async () => {
      // Manually set up a corrupted _schema_migrations with versions 1 and 3 (gap at 2)
      db.exec(`
        CREATE TABLE _schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          checksum TEXT NOT NULL,
          applied_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
        );
        INSERT INTO _schema_migrations (version, name, checksum) VALUES (1, '001', 'chk1');
        INSERT INTO _schema_migrations (version, name, checksum) VALUES (3, '003', 'chk3');
      `);

      const manifest = [
        { version: 1, name: '001', upSql: 'CREATE TABLE t1 (id INT);', checksum: 'chk1' },
        { version: 2, name: '002', upSql: 'CREATE TABLE t2 (id INT);', checksum: 'chk2' },
        { version: 3, name: '003', upSql: 'CREATE TABLE t3 (id INT);', checksum: 'chk3' },
      ];

      await expect(runner.migrate(manifest)).rejects.toThrow(MigrationError);
    });

    it('detects database tampering: applied migrations start at version > 1', async () => {
      db.exec(`
        CREATE TABLE _schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          checksum TEXT NOT NULL,
          applied_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
        );
        INSERT INTO _schema_migrations (version, name, checksum) VALUES (2, '002', 'chk2');
      `);

      const manifest = [
        { version: 1, name: '001', upSql: 'CREATE TABLE t1 (id INT);', checksum: 'chk1' },
        { version: 2, name: '002', upSql: 'CREATE TABLE t2 (id INT);', checksum: 'chk2' },
      ];

      await expect(runner.migrate(manifest)).rejects.toThrow(MigrationError);
    });

    it('detects downgrade: database version is newer than code manifest', async () => {
      await runner.migrate(ALL_PLATFORM_MIGRATIONS);
      const currentVer = await runner.getCurrentVersion();
      expect(currentVer).toBe(ALL_PLATFORM_MIGRATIONS.length);

      // Attempt to run with a truncated manifest (only versions 1-4)
      const subsetManifest = ALL_PLATFORM_MIGRATIONS.slice(0, 4);
      await expect(runner.migrate(subsetManifest)).rejects.toThrow(MigrationDowngradeError);
    });

    it('detects checksum mismatch on applied migrations', async () => {
      await runner.migrate(ALL_PLATFORM_MIGRATIONS);

      // Tamper with checksum of migration 1 in _schema_migrations
      db.exec(`UPDATE _schema_migrations SET checksum = 'tampered-sha256-checksum' WHERE version = 1;`);

      await expect(runner.migrate(ALL_PLATFORM_MIGRATIONS)).rejects.toThrow(
        MigrationChecksumMismatchError
      );
      await expect(runner.verifyChecksums(ALL_PLATFORM_MIGRATIONS)).rejects.toThrow(
        MigrationChecksumMismatchError
      );
    });

    it('proves concurrent migration over two independent DatabaseSync WAL connections', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'enkeep-mig-wal-test-'));
      const dbPath = join(tempDir, 'wal-mig.db');

      try {
        const db1 = new DatabaseSync(dbPath);
        const db2 = new DatabaseSync(dbPath);
        db1.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
        db2.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

        const r1 = new PlatformServerMigrationRunner(db1);
        const r2 = new PlatformServerMigrationRunner(db2);

        // Run both concurrently
        const [applied1, applied2] = await Promise.all([
          r1.migrate(ALL_PLATFORM_MIGRATIONS),
          r2.migrate(ALL_PLATFORM_MIGRATIONS),
        ]);

        const total = applied1.length + applied2.length;
        expect(total).toBe(ALL_PLATFORM_MIGRATIONS.length);

        expect(await r1.getCurrentVersion()).toBe(ALL_PLATFORM_MIGRATIONS.length);
        expect(await r2.getCurrentVersion()).toBe(ALL_PLATFORM_MIGRATIONS.length);

        // Re-running concurrently results in 0 applied
        const [re1, re2] = await Promise.all([
          r1.migrate(ALL_PLATFORM_MIGRATIONS),
          r2.migrate(ALL_PLATFORM_MIGRATIONS),
        ]);
        expect(re1.length).toBe(0);
        expect(re2.length).toBe(0);

        db1.close();
        db2.close();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('proves migration rollback safety on SQL failure during migration step', async () => {
      const failingManifest = [
        { version: 1, name: 'v1', upSql: 'CREATE TABLE t1 (id INT);', checksum: computeChecksum('CREATE TABLE t1 (id INT);') },
        { version: 2, name: 'v2', upSql: 'INVALID SQL STATEMENT SYNTAX ERROR;', checksum: computeChecksum('INVALID SQL STATEMENT SYNTAX ERROR;') },
      ];

      await expect(runner.migrate(failingManifest)).rejects.toThrow();

      // Ensure transaction was rolled back and no tables or records were partially persisted
      const applied = await runner.getAppliedMigrations();
      expect(applied.length).toBe(0);

      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
      const names = tables.map((t) => t.name);
      expect(names).not.toContain('t1');
    });

    it('proves migration 007 table collision with pre-existing delivery_inbox_v7 fails safely and rolls back without corrupting original table', async () => {
      // 1. Apply migrations 1 through 6
      const manifest1to6 = ALL_PLATFORM_MIGRATIONS.slice(0, 6);
      await runner.migrate(manifest1to6);
      expect(await runner.getCurrentVersion()).toBe(6);

      // Insert a valid user and session route and a delivery_inbox row in v6
      db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES ('u1', 'u1_user', 'hash', 'user')").run();
      db.prepare("INSERT INTO spaces (id, user_id, name, folder) VALUES ('sp1', 'u1', 'space1', 'folder1')").run();
      db.prepare("INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode) VALUES ('ses1', 'u1', 'sp1', 'web', 'demo', 'ctx1', 'p1', 'dsh1', 'container')").run();
      db.prepare("INSERT INTO delivery_inbox (id, user_id, route_id, message_id, delivery_id, status) VALUES ('del1', 'u1', 'ses1', 'msg1', 'dkey1', 'held')").run();

      // 2. Pre-create conflicting stale table delivery_inbox_v7
      db.prepare("CREATE TABLE delivery_inbox_v7 (stale_column TEXT);").run();

      // 3. Attempt migration to version 7 -> should fail because CREATE TABLE delivery_inbox_v7 collides without IF NOT EXISTS
      await expect(runner.migrate(ALL_PLATFORM_MIGRATIONS)).rejects.toThrow();

      // 4. Verify version remains 6 and original delivery_inbox is intact and untouched
      expect(await runner.getCurrentVersion()).toBe(6);
      const originalRow = db.prepare("SELECT id, status FROM delivery_inbox WHERE id = 'del1'").get() as { id: string; status: string };
      expect(originalRow).toBeDefined();
      expect(originalRow.status).toBe('held');

      // 5. Clean up stale table and re-run migration -> should succeed for v7..latest
      db.prepare("DROP TABLE delivery_inbox_v7;").run();
      const newlyApplied = await runner.migrate(ALL_PLATFORM_MIGRATIONS);
      expect(newlyApplied.length).toBe(ALL_PLATFORM_MIGRATIONS.length - 6);
      expect(newlyApplied.map((m) => m.version)).toEqual(
        ALL_PLATFORM_MIGRATIONS.slice(6).map((m) => m.version)
      );
      expect(await runner.getCurrentVersion()).toBe(ALL_PLATFORM_MIGRATIONS[ALL_PLATFORM_MIGRATIONS.length - 1].version);

      // Verify row was preserved and 'failed' status can now be inserted/updated
      const preservedRow = db.prepare("SELECT id, status FROM delivery_inbox WHERE id = 'del1'").get() as { id: string; status: string };
      expect(preservedRow.id).toBe('del1');

      // Can now update status to 'failed'
      db.prepare("UPDATE delivery_inbox SET status = 'failed' WHERE id = 'del1'").run();
      const updatedRow = db.prepare("SELECT status FROM delivery_inbox WHERE id = 'del1'").get() as { status: string };
      expect(updatedRow.status).toBe('failed');
    });

    it('proves migration 008 table collision with pre-existing fixed_import_receipts fails safely and rolls back without corrupting original table', async () => {
      // 1. Apply migrations 1 through 7
      const manifest1to7 = ALL_PLATFORM_MIGRATIONS.slice(0, 7);
      await runner.migrate(manifest1to7);
      expect(await runner.getCurrentVersion()).toBe(7);

      // 2. Pre-create conflicting stale table fixed_import_receipts
      db.prepare("CREATE TABLE fixed_import_receipts (pre_existing_col TEXT PRIMARY KEY);").run();
      db.prepare("INSERT INTO fixed_import_receipts (pre_existing_col) VALUES ('sentinel_value');").run();

      // 3. Attempt migration to version 8 -> must throw table collision error because CREATE TABLE has NO IF NOT EXISTS
      await expect(runner.migrate(ALL_PLATFORM_MIGRATIONS)).rejects.toThrow(/table fixed_import_receipts already exists/i);

      // 4. Verify version remains 7 and database rolled back safely without corrupting pre-existing table
      expect(await runner.getCurrentVersion()).toBe(7);
      const sentinel = db.prepare("SELECT pre_existing_col FROM fixed_import_receipts").get() as { pre_existing_col: string };
      expect(sentinel.pre_existing_col).toBe('sentinel_value');

      // 5. Clean up stale table and verify migration applies cleanly
      db.prepare("DROP TABLE fixed_import_receipts;").run();
      const newlyApplied = await runner.migrate(ALL_PLATFORM_MIGRATIONS);
      expect(newlyApplied.length).toBe(ALL_PLATFORM_MIGRATIONS.length - 7);
      expect(newlyApplied.map((m) => m.version)).toEqual(
        ALL_PLATFORM_MIGRATIONS.slice(7).map((m) => m.version)
      );
      expect(await runner.getCurrentVersion()).toBe(ALL_PLATFORM_MIGRATIONS[ALL_PLATFORM_MIGRATIONS.length - 1].version);

      // Verify fixed_import_receipts and fixed_import_provenance exist with schema
      const receiptTableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fixed_import_receipts'").get();
      expect(receiptTableCheck).toBeDefined();
      const provTableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fixed_import_provenance'").get();
      expect(provTableCheck).toBeDefined();
    });

    it('proves migration 008 index collision with pre-existing index fails safely and rolls back leaving version at 7', async () => {
      const freshDb = new DatabaseSync(':memory:');
      const freshRunner = new PlatformServerMigrationRunner(freshDb);
      const manifest1to7 = ALL_PLATFORM_MIGRATIONS.slice(0, 7);
      await freshRunner.migrate(manifest1to7);
      expect(await freshRunner.getCurrentVersion()).toBe(7);

      // Pre-create index with name idx_fixed_import_receipts_user on existing table (e.g. users)
      freshDb.prepare("CREATE INDEX idx_fixed_import_receipts_user ON users(username);").run();

      // Attempt migration to version 8 -> fails on index collision
      await expect(freshRunner.migrate(ALL_PLATFORM_MIGRATIONS)).rejects.toThrow(/index idx_fixed_import_receipts_user already exists/i);

      // Verify version remains 7 and rolled back
      expect(await freshRunner.getCurrentVersion()).toBe(7);

      // Drop collision index and verify clean apply
      freshDb.prepare("DROP INDEX idx_fixed_import_receipts_user;").run();
      const applied = await freshRunner.migrate(ALL_PLATFORM_MIGRATIONS);
      expect(applied.length).toBe(ALL_PLATFORM_MIGRATIONS.length - 7);
      expect(applied.map((m) => m.version)).toEqual(
        ALL_PLATFORM_MIGRATIONS.slice(7).map((m) => m.version)
      );
      expect(await freshRunner.getCurrentVersion()).toBe(ALL_PLATFORM_MIGRATIONS[ALL_PLATFORM_MIGRATIONS.length - 1].version);
    });

    it('proves migration 008 table collision with pre-existing fixed_import_provenance fails safely and rolls back leaving version at 7', async () => {
      const freshDb = new DatabaseSync(':memory:');
      const freshRunner = new PlatformServerMigrationRunner(freshDb);
      const manifest1to7 = ALL_PLATFORM_MIGRATIONS.slice(0, 7);
      await freshRunner.migrate(manifest1to7);
      expect(await freshRunner.getCurrentVersion()).toBe(7);

      // Pre-create conflicting table fixed_import_provenance
      freshDb.prepare("CREATE TABLE fixed_import_provenance (stale_id TEXT PRIMARY KEY);").run();

      // Attempt migration to version 8 -> fails on table collision
      await expect(freshRunner.migrate(ALL_PLATFORM_MIGRATIONS)).rejects.toThrow(/table fixed_import_provenance already exists/i);

      // Verify version remains 7 and rolled back
      expect(await freshRunner.getCurrentVersion()).toBe(7);

      // Drop collision table and verify clean apply
      freshDb.prepare("DROP TABLE fixed_import_provenance;").run();
      const applied = await freshRunner.migrate(ALL_PLATFORM_MIGRATIONS);
      expect(applied.length).toBe(ALL_PLATFORM_MIGRATIONS.length - 7);
      expect(applied.map((m) => m.version)).toEqual(
        ALL_PLATFORM_MIGRATIONS.slice(7).map((m) => m.version)
      );
      expect(await freshRunner.getCurrentVersion()).toBe(ALL_PLATFORM_MIGRATIONS[ALL_PLATFORM_MIGRATIONS.length - 1].version);
    });
  });

  describe('2. SqliteWebMessageStore: Keyset Cursor Pagination & Security Boundaries', () => {
    let db: DatabaseSync;
    let store: SqliteWebMessageStore;
    const userId1 = 'user_alice_123';
    const userId2 = 'user_bob_456';
    const sessionId1 = 'ses_route_001';
    const sessionId2 = 'ses_route_002';

    beforeEach(async () => {
      db = new DatabaseSync(':memory:');
      const runner = new PlatformServerMigrationRunner(db);
      await runner.migrate(ALL_PLATFORM_MIGRATIONS);
      store = new SqliteWebMessageStore(db);

      // Seed dummy user & session records to satisfy foreign keys
      db.exec(`
        INSERT INTO users (id, username, password_hash) VALUES ('${userId1}', 'alice', 'hash1');
        INSERT INTO users (id, username, password_hash) VALUES ('${userId2}', 'bob', 'hash2');
        INSERT INTO spaces (id, user_id, name, folder) VALUES ('sp1', '${userId1}', 'Space 1', 'f1');
        INSERT INTO spaces (id, user_id, name, folder) VALUES ('sp2', '${userId2}', 'Space 2', 'f2');
        INSERT INTO session_routes (id, space_id, user_id, channel, native_context_id, dsh_session_id) VALUES ('${sessionId1}', 'sp1', '${userId1}', 'web', '${sessionId1}', 'dsh1');
        INSERT INTO session_routes (id, space_id, user_id, channel, native_context_id, dsh_session_id) VALUES ('${sessionId2}', 'sp2', '${userId2}', 'web', '${sessionId2}', 'dsh2');
      `);
    });

    it('paginates > limit messages with IDENTICAL created_at without data loss or duplicates', async () => {
      const fixedTimestamp = '2025-01-15T12:00:00.000Z';
      const totalMessages = 25;
      const createdIds: string[] = [];

      // Insert 25 messages all sharing the exact same created_at
      for (let i = 0; i < totalMessages; i++) {
        const msgId = `msg_test_${String(i).padStart(3, '0')}`;
        createdIds.push(msgId);
        await store.insertMessage({
          id: msgId,
          sessionId: sessionId1,
          userId: userId1,
          role: 'user',
          content: `Message number ${i}`,
          status: 'delivered',
          routeKey: `route_${sessionId1}`,
          turnId: null,
          createdAt: fixedTimestamp,
        });
      }

      // Fetch with page size 7 using 'before' pagination (backwards from newest)
      const pageSize = 7;
      const collectedMessages: WebMessageRecord[] = [];
      let olderCursor: string | undefined = undefined;
      let pageCount = 0;

      // First get latest page
      const initialPage = await store.listMessages(userId1, sessionId1, { limit: pageSize });
      pageCount++;
      // Prepend or push? We collect all: initialPage has newest 7 messages (sorted old->new)
      collectedMessages.unshift(...initialPage.messages);
      let currentHasMore = initialPage.hasMore;
      olderCursor = initialPage.olderCursor ?? undefined;

      while (currentHasMore && olderCursor) {
        pageCount++;
        const page = await store.listMessages(userId1, sessionId1, { limit: pageSize, before: olderCursor });
        collectedMessages.unshift(...page.messages);
        currentHasMore = page.hasMore;
        olderCursor = page.olderCursor ?? undefined;
      }

      // Verify no message was skipped and no message was duplicated
      expect(collectedMessages.length).toBe(totalMessages);
      const collectedIds = collectedMessages.map((m) => m.id);
      expect(new Set(collectedIds).size).toBe(totalMessages);
      expect(collectedIds).toEqual(createdIds);
      expect(pageCount).toBe(4); // ceil(25 / 7) = 4 pages (7 + 7 + 7 + 4)
    });

    it('paginates > limit events with IDENTICAL created_at without data loss or duplicates', async () => {
      const fixedTimestamp = '2025-01-15T12:00:00.000Z';
      const totalEvents = 20;
      const createdIds: string[] = [];

      for (let i = 0; i < totalEvents; i++) {
        const evtId = `evt_test_${String(i).padStart(3, '0')}`;
        createdIds.push(evtId);
        await store.insertEvent({
          id: evtId,
          sessionId: sessionId1,
          userId: userId1,
          type: 'turn_status',
          payload: { status: 'queued' },
          createdAt: fixedTimestamp,
        });
      }

      const pageSize = 6;
      const collectedEvents: WebEventRecord[] = [];
      let cursor: string | undefined = undefined;

      while (true) {
        const page = await store.pollEvents(userId1, sessionId1, { limit: pageSize, cursor });
        collectedEvents.push(...page.events);

        if (!page.hasMore) {
          break;
        }
        cursor = page.nextCursor;
        expect(cursor).toBeDefined();
      }

      expect(collectedEvents.length).toBe(totalEvents);
      const collectedIds = collectedEvents.map((e) => e.id);
      expect(new Set(collectedIds).size).toBe(totalEvents);
      expect(collectedIds).toEqual(createdIds);
    });

    it('strictly rejects cross-tenant cursor', async () => {
      // Insert message for Alice (userId1)
      const msgAlice = await store.insertMessage({
        id: 'msg_alice_01',
        sessionId: sessionId1,
        userId: userId1,
        role: 'user',
        content: 'Alice secret message',
        status: 'delivered',
        routeKey: `route_${sessionId1}`,
        turnId: null,
        createdAt: new Date().toISOString(),
      });

      const aliceCursor = encodeOpaqueCursor({
        v: 1,
        kind: 'message',
        id: msgAlice.id,
        createdAt: msgAlice.createdAt,
      });

      // Bob (userId2) attempts to use Alice's cursor in his session -> must throw ValidationError
      await expect(
        store.listMessages(userId2, sessionId2, { before: aliceCursor })
      ).rejects.toThrow(ValidationError);
      await expect(
        store.listMessages(userId2, sessionId2, { after: aliceCursor })
      ).rejects.toThrow(ValidationError);
    });

    it('strictly rejects cross-session cursor', async () => {
      // Alice has two sessions
      const sessionId1B = 'ses_route_001b';
      db.exec(`
        INSERT INTO session_routes (id, space_id, user_id, channel, native_context_id, dsh_session_id)
        VALUES ('${sessionId1B}', 'sp1', '${userId1}', 'web', '${sessionId1B}', 'dsh1b');
      `);

      const msg = await store.insertMessage({
        id: 'msg_ses1_01',
        sessionId: sessionId1,
        userId: userId1,
        role: 'user',
        content: 'Session 1 message',
        status: 'delivered',
        routeKey: `route_${sessionId1}`,
        turnId: null,
        createdAt: new Date().toISOString(),
      });

      const cursorSes1 = encodeOpaqueCursor({
        v: 1,
        kind: 'message',
        id: msg.id,
        createdAt: msg.createdAt,
      });

      // Querying session 1B with session 1's cursor must throw ValidationError
      await expect(
        store.listMessages(userId1, sessionId1B, { before: cursorSes1 })
      ).rejects.toThrow(ValidationError);
      await expect(
        store.listMessages(userId1, sessionId1B, { after: cursorSes1 })
      ).rejects.toThrow(ValidationError);
    });

    it('strictly rejects non-existent fabricated cursor ID', async () => {
      const fabricatedCursor = encodeOpaqueCursor({
        v: 1,
        kind: 'message',
        id: 'msg_fabricated_does_not_exist',
        createdAt: new Date().toISOString(),
      });

      await expect(
        store.listMessages(userId1, sessionId1, { before: fabricatedCursor })
      ).rejects.toThrow(ValidationError);
      await expect(
        store.listMessages(userId1, sessionId1, { after: fabricatedCursor })
      ).rejects.toThrow(ValidationError);
    });

    it('strictly rejects malformed, non-JSON, wrong schema, and invalid version cursors', async () => {
      // 1. Non-base64url characters
      await expect(store.listMessages(userId1, sessionId1, { before: '!!!invalid-base64!!!' })).rejects.toThrow(ValidationError);

      // 2. Base64url encoded non-JSON string
      const nonJson = Buffer.from('hello world', 'utf8').toString('base64url');
      await expect(store.listMessages(userId1, sessionId1, { before: nonJson })).rejects.toThrow(ValidationError);

      // 3. JSON array instead of object
      const arrayJson = Buffer.from(JSON.stringify([1, 2, 3]), 'utf8').toString('base64url');
      await expect(store.listMessages(userId1, sessionId1, { before: arrayJson })).rejects.toThrow(ValidationError);

      // 4. Unsupported version (v: 2)
      const v2Json = Buffer.from(JSON.stringify({ v: 2, kind: 'message', id: 'msg_1', createdAt: '2025-01-01' }), 'utf8').toString('base64url');
      await expect(store.listMessages(userId1, sessionId1, { before: v2Json })).rejects.toThrow(ValidationError);

      // 5. Extra unwanted keys in cursor payload
      const extraKeyJson = Buffer.from(JSON.stringify({ v: 1, kind: 'message', id: 'msg_1', createdAt: '2025-01-01', extra: 'hacked' }), 'utf8').toString('base64url');
      await expect(store.listMessages(userId1, sessionId1, { before: extraKeyJson })).rejects.toThrow(ValidationError);

      // 6. Legacy cursor parameter rejection
      await expect(store.listMessages(userId1, sessionId1, { cursor: 'any' } as any)).rejects.toThrow(ValidationError);
    });

    it('rejects cursor kind mismatch: message cursor cannot be used for pollEvents and vice versa', async () => {
      const nowIso = new Date().toISOString();
      const msg = await store.insertMessage({
        id: 'msg_kind_test',
        sessionId: sessionId1,
        userId: userId1,
        role: 'user',
        content: 'Content',
        status: 'delivered',
        routeKey: `route_${sessionId1}`,
        turnId: null,
        createdAt: nowIso,
      });

      const evt = await store.insertEvent({
        id: 'evt_kind_test',
        sessionId: sessionId1,
        userId: userId1,
        type: 'turn_status',
        payload: { status: 'running' },
        createdAt: nowIso,
      });

      const msgCursor = encodeOpaqueCursor({
        v: 1,
        kind: 'message',
        id: msg.id,
        createdAt: msg.createdAt,
      });

      const evtCursor = encodeOpaqueCursor({
        v: 1,
        kind: 'event',
        id: evt.id,
        createdAt: evt.createdAt,
      });

      // Passing message cursor to pollEvents throws ValidationError
      await expect(
        store.pollEvents(userId1, sessionId1, { cursor: msgCursor })
      ).rejects.toThrow(ValidationError);

      // Passing event cursor to listMessages throws ValidationError
      await expect(
        store.listMessages(userId1, sessionId1, { before: evtCursor })
      ).rejects.toThrow(ValidationError);
      await expect(
        store.listMessages(userId1, sessionId1, { after: evtCursor })
      ).rejects.toThrow(ValidationError);
    });

    it('handles single item and empty page correctly with olderCursor and newerCursor', async () => {
      const msg = await store.insertMessage({
        id: 'msg_single_01',
        sessionId: sessionId1,
        userId: userId1,
        role: 'user',
        content: 'Single item',
        status: 'delivered',
        routeKey: `route_${sessionId1}`,
        turnId: null,
        createdAt: new Date().toISOString(),
      });

      const page1 = await store.listMessages(userId1, sessionId1, { limit: 10 });
      expect(page1.messages.length).toBe(1);
      expect(page1.hasMore).toBe(false);
      const cursor1 = page1.olderCursor!;
      expect(cursor1).toBeDefined();
      expect(page1.newerCursor).toBe(cursor1);

      // Query before cursor1 -> empty page, cursors null, hasMore false
      const page2 = await store.listMessages(userId1, sessionId1, { limit: 10, before: cursor1 });
      expect(page2.messages.length).toBe(0);
      expect(page2.hasMore).toBe(false);
      expect(page2.olderCursor).toBeNull();
      expect(page2.newerCursor).toBeNull();
    });

    it('returns null cursors on completely empty session', async () => {
      const emptyPage = await store.listMessages(userId1, sessionId1, { limit: 10 });
      expect(emptyPage.messages.length).toBe(0);
      expect(emptyPage.hasMore).toBe(false);
      expect(emptyPage.olderCursor).toBeNull();
      expect(emptyPage.newerCursor).toBeNull();
    });

    it('strictly rejects direct raw record ID as cursor with ValidationError', async () => {
      const fixedTimestamp = '2025-02-01T10:00:00.000Z';
      const id = 'msg_direct_001';
      await store.insertMessage({
        id,
        sessionId: sessionId1,
        userId: userId1,
        role: 'user',
        content: 'Direct cursor test message',
        status: 'delivered',
        routeKey: `route_${sessionId1}`,
        turnId: null,
        createdAt: fixedTimestamp,
      });

      // Passing raw ID as cursor must be strictly rejected
      await expect(
        store.listMessages(userId1, sessionId1, { limit: 5, before: id })
      ).rejects.toThrow(ValidationError);
      await expect(
        store.listMessages(userId1, sessionId1, { limit: 5, after: id })
      ).rejects.toThrow(ValidationError);
    });

    it('paginates inserted messages with identical timestamps across multiple pages without loss or duplicate', async () => {
      const fixedTimestamp = '2025-02-01T10:00:00.000Z';
      const items = Array.from({ length: 18 }, (_, i) => ({
        id: `msg_page_${String(i).padStart(3, '0')}`,
        sessionId: sessionId1,
        userId: userId1,
        role: 'user' as const,
        content: `Message ${i}`,
        status: 'delivered' as const,
        routeKey: `route_${sessionId1}`,
        turnId: null,
        createdAt: fixedTimestamp,
      }));

      for (const item of items) {
        await store.insertMessage(item);
      }

      const collected: WebMessageRecord[] = [];
      const initPage = await store.listMessages(userId1, sessionId1, { limit: 5 });
      collected.unshift(...initPage.messages);
      let hasMore = initPage.hasMore;
      let olderCursor = initPage.olderCursor ?? undefined;

      while (hasMore && olderCursor) {
        const page = await store.listMessages(userId1, sessionId1, { limit: 5, before: olderCursor });
        collected.unshift(...page.messages);
        hasMore = page.hasMore;
        olderCursor = page.olderCursor ?? undefined;
      }

      expect(collected.length).toBe(18);
      const uniqueIds = new Set(collected.map((m) => m.id));
      expect(uniqueIds.size).toBe(18);
    });
  });

  describe('3. Transaction Rollbacks, CAS & Ingest State Machine', () => {
    let db: DatabaseSync;
    let store: SqliteWebMessageStore;
    const userId = 'user_tx_1';
    const sessionId = 'ses_tx_1';

    beforeEach(async () => {
      db = new DatabaseSync(':memory:');
      const runner = new PlatformServerMigrationRunner(db);
      await runner.migrate(ALL_PLATFORM_MIGRATIONS);
      store = new SqliteWebMessageStore(db);

      db.exec(`
        INSERT INTO users (id, username, password_hash) VALUES ('${userId}', 'alice_tx', 'hash1');
        INSERT INTO spaces (id, user_id, name, folder) VALUES ('sp_tx', '${userId}', 'Space TX', 'f_tx');
        INSERT INTO session_routes (id, space_id, user_id, channel, dsh_session_id) VALUES ('${sessionId}', 'sp_tx', '${userId}', 'web', 'dsh_tx');
      `);
    });

    it('atomically ingests fresh delivery and deduplicates matching idempotency retry', async () => {
      const timestamp = new Date().toISOString();
      const deliveryParams = {
        userId,
        sessionId,
        spaceId: 'sp_tx',
        dshSessionId: 'dsh_tx',
        idempotencyKey: 'idem_tx_001',
        content: 'Hello transactional ingest',
        timestamp,
      };

      const res1 = await store.ingestWebDelivery(deliveryParams);
      expect(res1.isClaimant).toBe(true);
      expect(res1.state).toBe('held');
      expect(res1.turnId).toBeDefined();
      expect(res1.messageId).toBeDefined();

      // Retry with same key and same payload
      const res2 = await store.ingestWebDelivery(deliveryParams);
      expect(res2.isClaimant).toBe(false);
      expect(res2.turnId).toBe(res1.turnId);
      expect(res2.messageId).toBe(res1.messageId);
    });

    it('rejects idempotency collision with 409 Conflict', async () => {
      const timestamp = new Date().toISOString();
      const deliveryParams = {
        userId,
        sessionId,
        spaceId: 'sp_tx',
        dshSessionId: 'dsh_tx',
        idempotencyKey: 'idem_tx_002',
        content: 'Original content',
        timestamp,
      };

      await store.ingestWebDelivery(deliveryParams);

      // Attempt reuse of same idempotency key with altered content
      await expect(
        store.ingestWebDelivery({
          ...deliveryParams,
          content: 'Altered content for collision attack',
        })
      ).rejects.toThrow(PlatformError);
    });

    it('claimHeldDelivery succeeds with CAS transition and closes transaction properly on CAS failure', async () => {
      const timestamp = new Date().toISOString();
      const deliveryParams = {
        userId,
        sessionId,
        spaceId: 'sp_tx',
        dshSessionId: 'dsh_tx',
        idempotencyKey: 'idem_tx_003',
        content: 'Claim test',
        timestamp,
      };

      const ingestRes = await store.ingestWebDelivery(deliveryParams);
      const turnId = ingestRes.turnId;

      // First claim succeeds
      const claimed = await store.claimHeldDelivery(userId, ingestRes.deliveryId, deliveryParams.idempotencyKey, turnId);
      expect(claimed).toBe(true);

      // Second claim fails (CAS condition state='held' no longer matches) and cleanly returns false
      const secondClaim = await store.claimHeldDelivery(userId, ingestRes.deliveryId, deliveryParams.idempotencyKey, turnId);
      expect(secondClaim).toBe(false);
    });
  });
});
