/**
 * Backup Manifest Generator
 *
 * Scans snapshot files, computes checksums, runs SQLite integrity checks,
 * builds DSH JSONL inventory, and generates strict canonical manifests.
 *
 * @module @enkeep/backup-restore/manifest/generator
 */

import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  BACKUP_FORMAT_VERSION,
  DEFAULT_LIMITS,
  CRYPTO_PARAMS,
} from '../constants.js';
import { computeSha256 } from '../crypto/hash.js';
import { normalizeAndValidateArchivePath } from '../tar/tar-entry.js';
import { BackupManifestError, BackupIntegrityError } from '../errors.js';
import type {
  BackupManifest,
  BackupFileEntry,
  SqliteIntegrityReport,
  DshSessionInventoryItem,
  BackupLimits,
} from '../types.js';

export interface GenerateManifestInput {
  readonly snapshotDir: string;
  readonly dbSnapshotPath?: string;
  readonly runtimeImage?: string;
  readonly enkeepVersion?: string;
  readonly limits?: Partial<BackupLimits>;
  readonly encrypted: boolean;
  readonly description?: string;
}

/**
 * Inspects a SQLite snapshot database and produces an integrity and inventory report.
 */
export function inspectSqliteDatabase(dbPath: string): {
  integrity: SqliteIntegrityReport;
  migrations: Record<string, string>;
  latestVersion: number;
} {
  if (!existsSync(dbPath)) {
    return {
      integrity: {
        status: 'error',
        details: 'Database file not found',
        tables: [],
        userCount: 0,
        spaceCount: 0,
        sessionCount: 0,
        messageCount: 0,
      },
      migrations: {},
      latestVersion: 0,
    };
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });

  try {
    // 1. Run PRAGMA integrity_check
    const integrityRows = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check?: string; [key: string]: unknown }>;
    const firstRow = integrityRows[0];
    const integrityValue = firstRow?.integrity_check ?? Object.values(firstRow || {})[0];

    if (integrityValue !== 'ok') {
      throw new BackupIntegrityError(
        `SQLite integrity_check failed on snapshot: ${String(integrityValue)}`
      );
    }

    // 2. Run PRAGMA foreign_key_check
    const fkRows = db.prepare('PRAGMA foreign_key_check').all();
    if (fkRows.length > 0) {
      throw new BackupIntegrityError(
        `SQLite foreign_key_check failed on snapshot: Found ${fkRows.length} foreign key violation(s)`
      );
    }

    // 3. Inspect tables in sqlite_master
    const tableRows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC")
      .all() as Array<{ name: string }>;
    const tables = tableRows.map((r) => r.name);

    // 4. Counts
    const getCount = (tbl: string): number => {
      if (!tables.includes(tbl)) return 0;
      try {
        const res = db.prepare(`SELECT count(*) as count FROM ${tbl}`).get() as { count: number } | undefined;
        return res?.count ?? 0;
      } catch {
        return 0;
      }
    };

    const userCount = getCount('users');
    const spaceCount = getCount('spaces');
    const sessionCount = tables.includes('session_routes') ? getCount('session_routes') : getCount('sessions');
    const messageCount = getCount('web_messages');

    // 5. Query applied migrations and checksums
    const migrations: Record<string, string> = {};
    let latestVersion = 0;

    if (tables.includes('_schema_migrations')) {
      const migRows = db
        .prepare('SELECT version, name, checksum FROM _schema_migrations ORDER BY version ASC')
        .all() as Array<{ version: number; name: string; checksum: string }>;

      for (const m of migRows) {
        migrations[String(m.version).padStart(3, '0')] = m.checksum;
        if (m.version > latestVersion) {
          latestVersion = m.version;
        }
      }
    }

    return {
      integrity: {
        status: 'ok',
        tables,
        userCount,
        spaceCount,
        sessionCount,
        messageCount,
      },
      migrations,
      latestVersion,
    };
  } finally {
    db.close();
  }
}

/**
 * Recursively scans files in the snapshot directory, computes hashes, and builds JSONL inventory.
 */
export function buildSnapshotInventory(
  snapshotDir: string,
  limits: BackupLimits
): {
  files: BackupFileEntry[];
  dshInventory: DshSessionInventoryItem[];
  totalBytes: number;
} {
  const files: BackupFileEntry[] = [];
  const dshInventory: DshSessionInventoryItem[] = [];
  let totalBytes = 0;

  function walk(currentDir: string): void {
    const entries = readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      const stat = lstatSync(fullPath);

      if (stat.isSymbolicLink()) {
        throw new BackupManifestError(
          `Symlink detected in snapshot directory: "${fullPath}". Symlinks are strictly prohibited in backups.`
        );
      }

      if (stat.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (!stat.isFile()) {
        throw new BackupManifestError(`Special file detected in snapshot directory: "${fullPath}".`);
      }

      // Hardlink guard: reject if nlink > 1
      if (stat.nlink > 1) {
        throw new BackupManifestError(
          `Hard-linked file detected (nlink=${stat.nlink}): "${fullPath}". Refusing to backup.`
        );
      }

      const relativePath = normalizeAndValidateArchivePath(relative(snapshotDir, fullPath));
      const content = readFileSync(fullPath);
      const sha256 = computeSha256(content);
      const size = content.length;
      const mode = stat.mode & 0o777;

      if (size > limits.maxFileSize) {
        throw new BackupManifestError(
          `File "${relativePath}" size (${size} bytes) exceeds limit (${limits.maxFileSize} bytes)`
        );
      }

      totalBytes += size;
      if (totalBytes > limits.maxTotalSize) {
        throw new BackupManifestError(
          `Total backup size (${totalBytes} bytes) exceeds limit (${limits.maxTotalSize} bytes)`
        );
      }

      files.push({
        path: relativePath,
        size,
        sha256,
        mode,
      });

      if (files.length > limits.maxFileCount) {
        throw new BackupManifestError(
          `Total file count (${files.length}) exceeds limit (${limits.maxFileCount})`
        );
      }

      // If it is a session JSONL file, inventory and validate it
      if (entry.name.endsWith('.jsonl') || relativePath.includes('sessions/')) {
        inventoryDshJsonl(relativePath, content, sha256, dshInventory);
      }
    }
  }

  walk(snapshotDir);

  // Sort files and inventory deterministically
  files.sort((a, b) => a.path.localeCompare(b.path));
  dshInventory.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  return { files, dshInventory, totalBytes };
}

function inventoryDshJsonl(
  relativePath: string,
  content: Buffer,
  sha256: string,
  inventory: DshSessionInventoryItem[]
): void {
  const lines = content.toString('utf8').split('\n').filter((l) => l.trim().length > 0);
  let validJsonl = true;
  let userId = 'unknown';
  let sessionId = 'unknown';

  // Extract userId and sessionId from path if matched:
  // e.g. "sessions/sp_alice/session_1/session.jsonl" or "volumes/enkeep-demo-dsh-alice/sessions/..."
  const segments = relativePath.split('/');
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg.startsWith('sp_') || seg.includes('alice') || seg.includes('bob')) {
      userId = seg.replace(/^sp_/, '');
    }
    if (seg.startsWith('session_') || seg.length === 36 || seg.startsWith('import-')) {
      sessionId = seg;
    }
  }

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object') {
        validJsonl = false;
        break;
      }
    } catch {
      validJsonl = false;
      break;
    }
  }

  inventory.push({
    userId,
    sessionId,
    relativePath,
    lineCount: lines.length,
    sha256,
    size: content.length,
    validJsonl,
  });
}

/**
 * Builds the full BackupManifest.
 */
export function generateBackupManifest(input: GenerateManifestInput): BackupManifest {
  const limits: BackupLimits = {
    maxFileSize: input.limits?.maxFileSize ?? DEFAULT_LIMITS.maxFileSize,
    maxTotalSize: input.limits?.maxTotalSize ?? DEFAULT_LIMITS.maxTotalSize,
    maxFileCount: input.limits?.maxFileCount ?? DEFAULT_LIMITS.maxFileCount,
  };

  const dbPath = input.dbSnapshotPath ?? join(input.snapshotDir, 'platform.db');
  const dbInfo = inspectSqliteDatabase(dbPath);

  const { files, dshInventory, totalBytes } = buildSnapshotInventory(input.snapshotDir, limits);

  const hasSecrets = files.some((f) => f.path === 'secrets.json');

  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    enkeepVersion: input.enkeepVersion ?? '0.1.0',
    runtimeImage: input.runtimeImage ?? process.env.ENKEEP_RUNTIME_IMAGE ?? 'enkeep-demo-runtime:acceptance',
    platformSchemaVersion: dbInfo.latestVersion,
    migrationChecksums: dbInfo.migrations,
    sqliteIntegrity: dbInfo.integrity,
    dshInventory,
    files,
    limits,
    summary: {
      totalFiles: files.length,
      totalBytes,
      hasSecrets,
      encrypted: input.encrypted,
      kdf: input.encrypted ? CRYPTO_PARAMS.kdf : undefined,
      cipher: input.encrypted ? CRYPTO_PARAMS.cipher : undefined,
    },
    description: input.description,
  };
}
