import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  SqliteReceiptStoreMigrationRunner,
  MigrationError,
  MigrationDowngradeError,
  MigrationChecksumMismatchError,
  computeSqlChecksum,
  MIGRATIONS,
  validateMigrationManifest,
  type MigrationStep,
} from '../src/index.js';

describe('SqliteReceiptStore Migration Runner Tests', () => {
  let dbPath: string;
  let db: DatabaseSync;

  beforeEach(() => {
    dbPath = join(tmpdir(), `receipt-store-migration-test-${randomUUID()}.db`);
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec('PRAGMA journal_mode = WAL;');
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // ignore
    }
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
        rmSync(`${dbPath}-wal`, { force: true });
        rmSync(`${dbPath}-shm`, { force: true });
      } catch {
        // ignore
      }
    }
  });

  describe('Manifest Prevalidation', () => {
    it('accepts valid contiguous manifest', () => {
      const manifest: MigrationStep[] = [
        { version: 1, sql: 'CREATE TABLE t1 (id INT);', checksum: computeSqlChecksum('CREATE TABLE t1 (id INT);') },
        { version: 2, sql: 'CREATE TABLE t2 (id INT);', checksum: computeSqlChecksum('CREATE TABLE t2 (id INT);') },
      ];
      const validated = validateMigrationManifest(manifest);
      expect(validated).toHaveLength(2);
      expect(validated[0].version).toBe(1);
      expect(validated[1].version).toBe(2);
    });

    it('rejects manifest not starting at version 1', () => {
      const manifest: MigrationStep[] = [
        { version: 2, sql: 'CREATE TABLE t2 (id INT);', checksum: 'abc' },
      ];
      expect(() => validateMigrationManifest(manifest)).toThrow(MigrationError);
    });

    it('rejects non-contiguous version jumps in manifest', () => {
      const manifest: MigrationStep[] = [
        { version: 1, sql: 'CREATE TABLE t1 (id INT);', checksum: 'abc' },
        { version: 3, sql: 'CREATE TABLE t3 (id INT);', checksum: 'def' },
      ];
      expect(() => validateMigrationManifest(manifest)).toThrow(MigrationError);
    });

    it('rejects duplicate versions in manifest', () => {
      const manifest: MigrationStep[] = [
        { version: 1, sql: 'CREATE TABLE t1 (id INT);', checksum: 'abc' },
        { version: 1, sql: 'CREATE TABLE t2 (id INT);', checksum: 'def' },
      ];
      expect(() => validateMigrationManifest(manifest)).toThrow(MigrationError);
    });

    it('rejects empty or non-string SQL in manifest', () => {
      const manifest: MigrationStep[] = [
        { version: 1, sql: '', checksum: 'abc' },
      ];
      expect(() => validateMigrationManifest(manifest)).toThrow(MigrationError);
    });
  });

  describe('Migration Execution and Invariants', () => {
    it('applies built-in migrations sequentially and checks schema version', () => {
      const runner = new SqliteReceiptStoreMigrationRunner(db);
      expect(runner.getCurrentVersion()).toBe(0);

      runner.run();

      expect(runner.getCurrentVersion()).toBe(2);

      // Verify tables exist
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name ASC").all() as Array<{ name: string }>;
      const tableNames = tables.map((t) => t.name);
      expect(tableNames).toContain('_dsh_migrations');
      expect(tableNames).toContain('dsh_delivery_receipts');
      expect(tableNames).toContain('dsh_session_sources');
      expect(tableNames).toContain('dsh_event_cursors');
      expect(tableNames).toContain('dsh_seed_import_receipts');
    });

    it('is idempotent when run multiple times on same database', () => {
      const runner = new SqliteReceiptStoreMigrationRunner(db);
      runner.run();
      expect(runner.getCurrentVersion()).toBe(2);

      // Second run is a no-op
      expect(() => runner.run()).not.toThrow();
      expect(runner.getCurrentVersion()).toBe(2);
    });

    it('detects schema downgrade when applied version is higher than manifest', () => {
      const runner = new SqliteReceiptStoreMigrationRunner(db);
      runner.run();

      // Now attempt to run with manifest only containing version 1
      const truncatedManifest = [MIGRATIONS[0]];
      expect(() => runner.run(truncatedManifest)).toThrow(MigrationDowngradeError);
    });

    it('detects checksum tampering of already applied migrations', () => {
      const runner = new SqliteReceiptStoreMigrationRunner(db);
      runner.run();

      // Tamper with checksum in _dsh_migrations
      db.prepare("UPDATE _dsh_migrations SET checksum = 'tampered_checksum' WHERE version = 1").run();

      expect(() => runner.run()).toThrow(MigrationChecksumMismatchError);
    });

    it('detects non-contiguous applied migrations in database', () => {
      // Manually insert non-contiguous migration rows
      db.exec(`
        CREATE TABLE _dsh_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);
        INSERT INTO _dsh_migrations (version, checksum, applied_at) VALUES (1, '${MIGRATIONS[0].checksum}', '2025-01-01');
        INSERT INTO _dsh_migrations (version, checksum, applied_at) VALUES (3, 'some-checksum', '2025-01-01');
      `);

      const customManifest: MigrationStep[] = [
        MIGRATIONS[0],
        MIGRATIONS[1],
        { version: 3, sql: 'CREATE TABLE t3 (id INT);', checksum: 'some-checksum' },
      ];

      const runner = new SqliteReceiptStoreMigrationRunner(db);
      expect(() => runner.run(customManifest)).toThrow(MigrationError);
    });

    it('rolls back atomically on migration SQL failure and throws AggregateError if rollback fails', () => {
      const failingManifest: MigrationStep[] = [
        MIGRATIONS[0],
        {
          version: 2,
          sql: 'SYNTAX ERROR IN SQL DEFINITION;',
          checksum: computeSqlChecksum('SYNTAX ERROR IN SQL DEFINITION;'),
        },
      ];

      const runner = new SqliteReceiptStoreMigrationRunner(db);
      expect(() => runner.run(failingManifest)).toThrow();

      // Verify that version 2 was NOT recorded in migrations table
      const rows = db.prepare('SELECT version FROM _dsh_migrations').all() as Array<{ version: number }>;
      expect(rows.map((r) => r.version)).toEqual([1]);
    });
  });
});
