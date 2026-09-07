/**
 * Backup Creation Operation (`enkeep-backup create`)
 *
 * @module @enkeep/backup-restore/operations/create
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  lstatSync,
  copyFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  EXCLUDED_TRANSIENT_ENTRIES,
  MANIFEST_FILE_NAME,
  DATABASE_FILE_NAME,
  PERMISSIONS,
} from '../constants.js';
import { readPassphraseFromFile } from '../crypto/passphrase.js';
import { encryptBackupPayload } from '../crypto/cipher.js';
import { TarWriter } from '../tar/tar-writer.js';
import { normalizeAndValidateArchivePath } from '../tar/tar-entry.js';
import { generateBackupManifest } from '../manifest/generator.js';
import { assertQuiescentEnvironment, releaseQuiescence } from '../quiesce/quiesce.js';
import { assertAbsolutePath, assertOutputNotInSource } from './safety.js';
import {
  BackupEncryptionError,
  BackupIntegrityError,
  BackupPathSafetyError,
  BackupRestoreSafetyError,
} from '../errors.js';
import type { CreateBackupOptions, CreateBackupResult } from '../types.js';

/**
 * Creates a transactional SQLite snapshot using VACUUM INTO.
 *
 * Requirements & Invariants:
 * 1. `readOnly: false` is required because SQLite engine's `VACUUM INTO` command
 *    requires a write-capable connection handle to write out the destination database file,
 *    even though the source database pages are purely read and never mutated.
 * 2. Strict zero-fallback: Direct file copy (`copyFileSync`) on an active WAL database
 *    would create a dirty, inconsistent snapshot missing in-flight WAL frames. If VACUUM INTO
 *    fails (e.g. locked, read-only FS, target collision), the connection is closed cleanly
 *    and a BackupRestoreSafetyError is thrown.
 * 3. Immediately validates PRAGMA integrity_check and foreign_key_check on the snapshot.
 */
function createSqliteSnapshot(sourceDbPath: string, targetDbPath: string): void {
  if (!existsSync(sourceDbPath)) return;

  const db = new DatabaseSync(sourceDbPath, { readOnly: false });
  try {
    const escapedTarget = targetDbPath.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${escapedTarget}'`);
  } catch (err) {
    try {
      db.close();
    } catch (_closeErr) {
      // ignore secondary close error
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new BackupRestoreSafetyError(
      `Failed to create atomic SQLite snapshot via VACUUM INTO: ${message}. Direct copy of live WAL database is prohibited to prevent dirty/inconsistent snapshots.`,
      err
    );
  }
  db.close();

  // Validate snapshot immediately
  if (!existsSync(targetDbPath)) {
    throw new BackupIntegrityError('SQLite snapshot file was not created by VACUUM INTO');
  }

  const probeDb = new DatabaseSync(targetDbPath, { readOnly: true });
  try {
    const integrityRows = probeDb.prepare('PRAGMA integrity_check').all() as Array<{
      integrity_check?: string;
      [key: string]: unknown;
    }>;
    const firstRow = integrityRows[0];
    const res = firstRow?.integrity_check ?? Object.values(firstRow || {})[0];
    if (res !== 'ok') {
      throw new BackupIntegrityError(`SQLite snapshot integrity_check failed: ${String(res)}`);
    }

    const fkRows = probeDb.prepare('PRAGMA foreign_key_check').all();
    if (fkRows.length > 0) {
      throw new BackupIntegrityError(
        `SQLite snapshot foreign_key_check failed: Found ${fkRows.length} foreign key violation(s)`
      );
    }
  } finally {
    probeDb.close();
  }
}

/**
 * Recursively copies safe non-transient files into a staging directory.
 */
function copyDirectorySafely(sourceDir: string, targetDir: string): void {
  if (!existsSync(sourceDir)) return;
  mkdirSync(targetDir, { recursive: true, mode: PERMISSIONS.dirMode });

  const entries = readdirSync(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    if (EXCLUDED_TRANSIENT_ENTRIES.includes(entry.name)) {
      continue;
    }

    const srcPath = join(sourceDir, entry.name);
    const dstPath = join(targetDir, entry.name);
    const stat = lstatSync(srcPath);

    if (stat.isSymbolicLink()) {
      // Reject symlinks
      throw new BackupPathSafetyError(
        `Symlink detected at "${srcPath}". Symlinks are strictly prohibited in backup sources.`
      );
    }

    if (stat.isDirectory()) {
      copyDirectorySafely(srcPath, dstPath);
    } else if (stat.isFile()) {
      if (stat.nlink > 1) {
        throw new BackupPathSafetyError(
          `Hard-linked file detected (nlink=${stat.nlink}): "${srcPath}". Refusing backup.`
        );
      }
      copyFileSync(srcPath, dstPath);
    }
  }
}

/**
 * Executes the complete backup creation workflow.
 */
export async function createBackup(options: CreateBackupOptions): Promise<CreateBackupResult> {
  const dataRoot = assertAbsolutePath(options.dataRoot, 'dataRoot');
  const outputPath = assertAbsolutePath(options.outputPath, 'outputPath');

  if (!existsSync(dataRoot)) {
    throw new BackupPathSafetyError(`Source data root directory does not exist: "${dataRoot}"`);
  }

  assertOutputNotInSource(dataRoot, outputPath);

  if (existsSync(outputPath) && !options.force) {
    throw new BackupPathSafetyError(
      `Output archive already exists: "${outputPath}". Use --force to overwrite.`
    );
  }

  // Ensure output parent directory exists
  mkdirSync(dirname(outputPath), { recursive: true, mode: PERMISSIONS.dirMode });

  // 1. Quiesce check
  let freezeError: unknown = null;
  await assertQuiescentEnvironment({
    dataRoot,
    demoStopConfirmed: options.demoStopConfirmed,
    freezeHooks: options.freezeHooks,
  });

  const tempStaging = mkdtempSync(join(tmpdir(), 'enkeep-backup-stage-'));

  try {
    // 2. Encryption passphrase check
    let passphrase: string | null = null;
    if (options.passphraseFile) {
      passphrase = readPassphraseFromFile(options.passphraseFile);
    } else if (!options.allowInsecureUnencrypted) {
      throw new BackupEncryptionError(
        'Backups contain sensitive authentication secrets (secrets.json, sessions, DB). ' +
          'Encryption is mandatory. Provide --passphrase-file <path> or explicitly specify --allow-insecure-unencrypted.'
      );
    }

    const isEncrypted = passphrase !== null;

    // 3. Stage SQLite database via VACUUM INTO (strict, zero fallback)
    const srcDb = join(dataRoot, DATABASE_FILE_NAME);
    const stagedDb = join(tempStaging, DATABASE_FILE_NAME);
    if (existsSync(srcDb)) {
      createSqliteSnapshot(srcDb, stagedDb);
    }

    // 4. Stage other managed directories and files
    const topEntries = readdirSync(dataRoot, { withFileTypes: true });
    for (const entry of topEntries) {
      if (entry.name === DATABASE_FILE_NAME || EXCLUDED_TRANSIENT_ENTRIES.includes(entry.name)) {
        continue;
      }
      const srcPath = join(dataRoot, entry.name);
      const dstPath = join(tempStaging, entry.name);
      const stat = lstatSync(srcPath);

      if (stat.isSymbolicLink()) {
        throw new BackupPathSafetyError(`Symlink detected at "${srcPath}".`);
      }

      if (stat.isDirectory()) {
        copyDirectorySafely(srcPath, dstPath);
      } else if (stat.isFile()) {
        if (stat.nlink > 1) {
          throw new BackupPathSafetyError(`Hardlink detected at "${srcPath}".`);
        }
        copyFileSync(srcPath, dstPath);
      }
    }

    // 5. Generate Manifest
    const manifest = generateBackupManifest({
      snapshotDir: tempStaging,
      dbSnapshotPath: stagedDb,
      limits: options.limits,
      encrypted: isEncrypted,
      description: options.description,
    });

    const manifestBuffer = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');

    // 6. Tar packing
    const tarWriter = new TarWriter(options.limits);

    // Write manifest first
    tarWriter.addFile({
      path: MANIFEST_FILE_NAME,
      data: manifestBuffer,
      mode: PERMISSIONS.sensitiveFileMode,
    });

    // Write all staged data files
    for (const file of manifest.files) {
      const fullPath = join(tempStaging, file.path);
      const content = readFileSync(fullPath);
      tarWriter.addFile({
        path: file.path,
        data: content,
        mode: file.mode,
      });
    }

    const tarballBuffer = tarWriter.finalize();

    // 7. Encrypt payload if passphrase provided
    let finalArchiveBuffer: Buffer;
    if (isEncrypted && passphrase) {
      finalArchiveBuffer = encryptBackupPayload(tarballBuffer, passphrase);
    } else {
      finalArchiveBuffer = tarballBuffer;
    }

    // 8. Atomic write to outputPath with mode 0o600
    const tempOutputFile = `${outputPath}.tmp.${Date.now()}`;
    writeFileSync(tempOutputFile, finalArchiveBuffer, { mode: PERMISSIONS.sensitiveFileMode });
    copyFileSync(tempOutputFile, outputPath);
    rmSync(tempOutputFile, { force: true });

    const archiveStat = statSync(outputPath);

    return {
      success: true,
      archivePath: outputPath,
      manifest,
      encrypted: isEncrypted,
      archiveSize: archiveStat.size,
      createdAt: manifest.createdAt,
    };
  } catch (err) {
    freezeError = err;
    throw err;
  } finally {
    // Clean up staging directory
    try {
      rmSync(tempStaging, { recursive: true, force: true });
    } catch (_rmErr) {
      // ignore rm error
    }
    // Release quiescence
    await releaseQuiescence(options.freezeHooks, freezeError);
  }
}
