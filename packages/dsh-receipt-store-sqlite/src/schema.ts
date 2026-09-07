/**
 * SQLite Schema definitions and Migration runner with SHA-256 checksum verification.
 *
 * @module @enkeep/dsh-receipt-store-sqlite
 */

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  MigrationChecksumMismatchError,
  MigrationDowngradeError,
  MigrationError,
  isError,
  toErrorMessage,
  toError,
} from './errors.js';

export const SCHEMA_VERSION = 2;

export const MIGRATION_001_SQL = `
CREATE TABLE IF NOT EXISTS _dsh_migrations (
  version INTEGER PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dsh_delivery_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  route_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'failed')),
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, delivery_id)
);

CREATE INDEX IF NOT EXISTS idx_dsh_delivery_receipts_msg
  ON dsh_delivery_receipts (user_id, message_id);

CREATE INDEX IF NOT EXISTS idx_dsh_delivery_receipts_route
  ON dsh_delivery_receipts (user_id, route_id);

CREATE TABLE IF NOT EXISTS dsh_session_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  route_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, source_type, source_id)
);

CREATE INDEX IF NOT EXISTS idx_dsh_session_sources_route
  ON dsh_session_sources (user_id, route_id);

CREATE TABLE IF NOT EXISTS dsh_event_cursors (
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  consumer TEXT NOT NULL DEFAULT 'default',
  cursor_value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, session_id, consumer)
);
`.trim();

export const MIGRATION_002_SQL = `
CREATE TABLE IF NOT EXISTS dsh_seed_import_receipts (
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  algorithm TEXT NOT NULL CHECK (algorithm = 'sha256-session-events-v1'),
  checksum TEXT NOT NULL CHECK (length(checksum) = 64 AND checksum NOT GLOB '*[^0-9a-f]*'),
  canonical_bytes INTEGER NOT NULL CHECK (canonical_bytes >= 0),
  event_count INTEGER NOT NULL CHECK (event_count >= 0),
  imported_at TEXT NOT NULL,
  PRIMARY KEY (user_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_dsh_seed_import_receipts_session
  ON dsh_seed_import_receipts (user_id, session_id);
`.trim();

export interface MigrationStep {
  version: number;
  sql: string;
  checksum: string;
}

export function computeSqlChecksum(sql: string): string {
  return createHash('sha256').update(sql.trim()).digest('hex');
}

export const MIGRATIONS: readonly MigrationStep[] = [
  {
    version: 1,
    sql: MIGRATION_001_SQL,
    checksum: computeSqlChecksum(MIGRATION_001_SQL),
  },
  {
    version: 2,
    sql: MIGRATION_002_SQL,
    checksum: computeSqlChecksum(MIGRATION_002_SQL),
  },
];

/**
 * Validates that migration manifest definitions have unique and contiguous sequential versions starting at 1.
 */
export function validateMigrationManifest(manifest: readonly MigrationStep[]): readonly MigrationStep[] {
  if (!manifest || manifest.length === 0) {
    return [];
  }

  const seenVersions = new Set<number>();
  for (const m of manifest) {
    if (!Number.isInteger(m.version) || m.version <= 0) {
      throw new MigrationError(`Invalid migration version: ${String(m.version)}. Version must be a positive integer.`);
    }
    if (!m.sql || typeof m.sql !== 'string' || m.sql.trim().length === 0) {
      throw new MigrationError(`Invalid migration SQL for version ${m.version}. SQL must be a non-empty string.`);
    }
    if (seenVersions.has(m.version)) {
      throw new MigrationError(`Duplicate migration version in manifest: version ${m.version} appears multiple times.`);
    }
    seenVersions.add(m.version);
  }

  const sorted = [...manifest].sort((a, b) => a.version - b.version);

  if (sorted[0].version !== 1) {
    throw new MigrationError(`Migration manifest must start at version 1 (found start version: ${sorted[0].version}).`);
  }

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].version !== sorted[i - 1].version + 1) {
      throw new MigrationError(
        `Non-sequential migration versions in manifest: version ${sorted[i - 1].version} followed by ${sorted[i].version}. Manifest must be strictly contiguous (1, 2, ...).`
      );
    }
  }

  return sorted;
}

export interface AppliedMigrationRow {
  version: number;
  checksum: string;
  applied_at: string;
}

export class SqliteReceiptStoreMigrationRunner {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  private initMigrationsTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _dsh_migrations (
        version INTEGER PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
  }

  private getAppliedMigrations(): AppliedMigrationRow[] {
    this.initMigrationsTable();
    const rows = this.db.prepare(
      'SELECT version, checksum, applied_at FROM _dsh_migrations ORDER BY version ASC'
    ).all() as Array<{ version: unknown; checksum: unknown; applied_at: unknown }>;

    return rows.map((r) => {
      const v = typeof r.version === 'number' ? r.version : Number(r.version);
      const c = typeof r.checksum === 'string' ? r.checksum : String(r.checksum);
      const a = typeof r.applied_at === 'string' ? r.applied_at : String(r.applied_at);
      if (!Number.isSafeInteger(v) || v <= 0) {
        throw new MigrationError(`Invalid migration version in _dsh_migrations table: ${String(r.version)}`);
      }
      if (!c) {
        throw new MigrationError(`Missing migration checksum in _dsh_migrations for version ${v}`);
      }
      return { version: v, checksum: c, applied_at: a };
    });
  }

  getCurrentVersion(): number {
    try {
      const tableCheck = this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='_dsh_migrations'"
      ).get() as { name: string } | undefined;

      if (!tableCheck) return 0;

      const row = this.db.prepare(
        'SELECT MAX(version) as max_version FROM _dsh_migrations'
      ).get() as { max_version: unknown } | undefined;

      if (!row || row.max_version === null || row.max_version === undefined) return 0;
      const v = typeof row.max_version === 'number' ? row.max_version : Number(row.max_version);
      return Number.isSafeInteger(v) ? v : 0;
    } catch (err) {
      if (err instanceof MigrationError) throw err;
      throw new MigrationError('Failed to read schema version', err);
    }
  }

  private acquireImmediateTransaction(maxRetries = 50): void {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        this.db.exec('BEGIN IMMEDIATE;');
        return;
      } catch (err: unknown) {
        const errcode = (err !== null && typeof err === 'object' && 'errcode' in err)
          ? (err as { errcode: unknown }).errcode
          : undefined;
        const code = (err !== null && typeof err === 'object' && 'code' in err)
          ? (err as { code: unknown }).code
          : undefined;

        const isBusyOrLocked = errcode === 5 || errcode === 6 || code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED';

        if (isBusyOrLocked && attempt < maxRetries - 1) {
          try {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 + attempt * 2);
          } catch {
            // If Atomics.wait unavailable, fall through
          }
          continue;
        }
        throw new MigrationError(`Failed to acquire immediate transaction for migrations: ${toErrorMessage(err)}`, err);
      }
    }
  }

  run(customManifest?: readonly MigrationStep[]): void {
    // 1. Prevalidate manifest contiguous
    const manifest = validateMigrationManifest(customManifest ?? MIGRATIONS);
    if (manifest.length === 0) return;

    this.initMigrationsTable();

    // 2. Acquire lock to inspect state
    this.acquireImmediateTransaction();
    let applied: AppliedMigrationRow[] = [];
    try {
      this.initMigrationsTable();
      applied = this.getAppliedMigrations();
      const targetVersion = manifest.reduce((max, m) => Math.max(max, m.version), 0);

      // In-lock recheck: downgrade
      for (const record of applied) {
        if (record.version > targetVersion) {
          throw new MigrationDowngradeError(record.version, targetVersion);
        }
      }

      // In-lock recheck: contiguous sequence of applied migrations
      if (applied.length > 0) {
        if (applied[0].version !== 1) {
          throw new MigrationError(
            `Database contains non-contiguous applied migrations: first version is ${applied[0].version}, expected 1`
          );
        }
        for (let i = 1; i < applied.length; i++) {
          if (applied[i].version !== applied[i - 1].version + 1) {
            throw new MigrationError(
              `Database contains non-contiguous applied migrations: version ${applied[i - 1].version} followed by ${applied[i].version}`
            );
          }
        }
      }

      // In-lock recheck: verify checksums
      const manifestMap = new Map<number, MigrationStep>();
      for (const m of manifest) {
        manifestMap.set(m.version, m);
      }

      for (const record of applied) {
        const defined = manifestMap.get(record.version);
        if (!defined) {
          throw new MigrationError(
            `Unknown migration version ${record.version} found in database. Codebase is missing this migration definition.`
          );
        }
        const expectedChecksum = defined.checksum || computeSqlChecksum(defined.sql);
        if (record.checksum !== expectedChecksum) {
          throw new MigrationChecksumMismatchError(
            record.version,
            expectedChecksum,
            record.checksum
          );
        }
      }

      this.db.exec('COMMIT;');
    } catch (checkErr: unknown) {
      try {
        this.db.exec('ROLLBACK;');
      } catch (rollbackErr: unknown) {
        throw new AggregateError(
          [toError(checkErr), toError(rollbackErr)],
          `Migration check failed: ${toErrorMessage(checkErr)}; rollback failed: ${toErrorMessage(rollbackErr)}`
        );
      }
      if (checkErr instanceof MigrationError) throw checkErr;
      throw new MigrationError(`Failed during migration state verification: ${toErrorMessage(checkErr)}`, checkErr);
    }

    const appliedVersions = new Set(applied.map((m) => m.version));

    // 3. Apply each pending migration in its own atomic transaction
    for (const migration of manifest) {
      if (appliedVersions.has(migration.version)) {
        continue;
      }

      this.acquireImmediateTransaction();
      try {
        const checksum = migration.checksum || computeSqlChecksum(migration.sql);
        this.db.exec(migration.sql);

        const now = new Date().toISOString();
        const insert = this.db.prepare(
          'INSERT INTO _dsh_migrations (version, checksum, applied_at) VALUES (?, ?, ?)'
        );
        insert.run(migration.version, checksum, now);

        this.db.exec('COMMIT;');
        appliedVersions.add(migration.version);
      } catch (primaryErr: unknown) {
        try {
          this.db.exec('ROLLBACK;');
        } catch (rollbackErr: unknown) {
          throw new AggregateError(
            [toError(primaryErr), toError(rollbackErr)],
            `Migration version ${migration.version} failed: ${toErrorMessage(primaryErr)}; rollback failed: ${toErrorMessage(rollbackErr)}`
          );
        }
        if (primaryErr instanceof MigrationError) {
          throw primaryErr;
        }
        throw new MigrationError(
          `Failed applying migration version ${migration.version}: ${toErrorMessage(primaryErr)}`,
          primaryErr
        );
      }
    }
  }
}
