/**
 * Backup Verification Operation (`enkeep-backup verify`)
 *
 * @module @enkeep/backup-restore/operations/verify
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  DATABASE_FILE_NAME,
  MANIFEST_FILE_NAME,
  PERMISSIONS,
} from '../constants.js';
import { computeSha256 } from '../crypto/hash.js';
import { readPassphraseFromFile } from '../crypto/passphrase.js';
import { isEncryptedBackupBuffer, decryptBackupPayload } from '../crypto/cipher.js';
import { TarReader } from '../tar/tar-reader.js';
import { validateBackupManifest } from '../manifest/inspector.js';
import { assertAbsolutePath } from './safety.js';
import {
  BackupArchiveError,
  BackupEncryptionError,
  BackupIntegrityError,
  BackupPathSafetyError,
} from '../errors.js';
import type {
  VerifyBackupOptions,
  VerifyBackupResult,
  VerifyCheckDetail,
} from '../types.js';

/**
 * Independently verifies a backup archive:
 * 1. Decryption and container integrity
 * 2. Tar structure & safety (no traversal, no links)
 * 3. Manifest schema validity
 * 4. SHA-256 byte checksums for all entries
 * 5. SQLite database integrity & foreign keys
 * 6. DSH session JSONL line validity
 */
export async function verifyBackup(options: VerifyBackupOptions): Promise<VerifyBackupResult> {
  const archivePath = assertAbsolutePath(options.archivePath, 'archivePath');

  if (!existsSync(archivePath)) {
    throw new BackupPathSafetyError(`Backup archive file not found: "${archivePath}"`);
  }

  const checks: VerifyCheckDetail[] = [];
  const rawArchive = readFileSync(archivePath);

  // 1. Decrypt / Container Check
  const isEncrypted = isEncryptedBackupBuffer(rawArchive);
  let tarBuffer: Buffer;

  if (isEncrypted) {
    if (!options.passphraseFile) {
      throw new BackupEncryptionError(
        'Archive is encrypted. Provide --passphrase-file <path> to verify.'
      );
    }
    const passphrase = readPassphraseFromFile(options.passphraseFile);
    tarBuffer = decryptBackupPayload(rawArchive, passphrase);
    checks.push({
      name: 'archive_encryption_and_tag',
      status: 'passed',
      message: 'AES-256-GCM auth tag verified successfully',
    });
  } else {
    tarBuffer = rawArchive;
    checks.push({
      name: 'archive_container',
      status: 'passed',
      message: 'Plain container format verified',
    });
  }

  // 2. Tar unpack & entry extraction
  const tarReader = new TarReader();
  const entries = tarReader.readAllEntries(tarBuffer);
  checks.push({
    name: 'tar_structure_and_safety',
    status: 'passed',
    message: `Extracted ${entries.length} valid entries with zero traversal/symlinks`,
  });

  // 3. Manifest entry check
  const manifestEntry = entries.find((e) => e.path === MANIFEST_FILE_NAME);
  if (!manifestEntry) {
    throw new BackupArchiveError(`Missing required manifest "${MANIFEST_FILE_NAME}"`);
  }

  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(manifestEntry.data.toString('utf8'));
  } catch (err) {
    throw new BackupIntegrityError(
      `Corrupted manifest JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const manifest = validateBackupManifest(manifestRaw);
  checks.push({
    name: 'manifest_schema',
    status: 'passed',
    message: `Format version v${manifest.formatVersion} schema valid`,
  });

  // 4. Validate all manifest files exist in archive and hashes match
  const entriesByPath = new Map(entries.map((e) => [e.path, e]));
  let recomputedTotalBytes = 0;

  for (const expectedFile of manifest.files) {
    const entry = entriesByPath.get(expectedFile.path);
    if (!entry) {
      throw new BackupIntegrityError(
        `Archive missing expected file listed in manifest: "${expectedFile.path}"`
      );
    }

    if (entry.data.length !== expectedFile.size) {
      throw new BackupIntegrityError(
        `File size mismatch for "${expectedFile.path}": expected ${expectedFile.size} bytes, got ${entry.data.length} bytes`
      );
    }

    const actualSha256 = computeSha256(entry.data);
    if (actualSha256 !== expectedFile.sha256) {
      throw new BackupIntegrityError(
        `Checksum mismatch for "${expectedFile.path}": expected ${expectedFile.sha256}, got ${actualSha256}`
      );
    }

    recomputedTotalBytes += entry.data.length;
  }

  checks.push({
    name: 'file_checksums_and_sizes',
    status: 'passed',
    message: `All ${manifest.files.length} files verified with exact SHA-256 match`,
  });

  // 5. Staged SQLite verification in temporary sandbox
  const tempVerifyDir = mkdtempSync(join(options.tempDir ?? tmpdir(), 'enkeep-verify-stage-'));

  try {
    const dbEntry = entriesByPath.get(DATABASE_FILE_NAME);
    if (dbEntry) {
      const stagedDbPath = join(tempVerifyDir, DATABASE_FILE_NAME);
      writeFileSync(stagedDbPath, dbEntry.data, { mode: PERMISSIONS.sensitiveFileMode });

      const probeDb = new DatabaseSync(stagedDbPath, { readOnly: true });
      try {
        const integrityRows = probeDb.prepare('PRAGMA integrity_check').all() as Array<{
          integrity_check?: string;
          [key: string]: unknown;
        }>;
        const firstRow = integrityRows[0];
        const res = firstRow?.integrity_check ?? Object.values(firstRow || {})[0];
        if (res !== 'ok') {
          throw new BackupIntegrityError(`SQLite integrity_check failed: ${String(res)}`);
        }

        const fkRows = probeDb.prepare('PRAGMA foreign_key_check').all();
        if (fkRows.length > 0) {
          throw new BackupIntegrityError(
            `SQLite foreign_key_check failed: Found ${fkRows.length} foreign key violation(s)`
          );
        }

        checks.push({
          name: 'sqlite_integrity_and_foreign_keys',
          status: 'passed',
          message: 'PRAGMA integrity_check and foreign_key_check passed (ok)',
        });
      } finally {
        probeDb.close();
      }
    }

    // 6. DSH JSONL strict parse check
    let verifiedJsonlCount = 0;
    for (const dshItem of manifest.dshInventory) {
      const entry = entriesByPath.get(dshItem.relativePath);
      if (entry) {
        const lines = entry.data.toString('utf8').split('\n').filter((l) => l.trim().length > 0);
        for (let idx = 0; idx < lines.length; idx++) {
          const line = lines[idx]!;
          try {
            const parsed = JSON.parse(line);
            if (!parsed || typeof parsed !== 'object') {
              throw new Error('Not an object');
            }
          } catch (err) {
            throw new BackupIntegrityError(
              `DSH session JSONL parse failure in "${dshItem.relativePath}" at line ${idx + 1}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
        verifiedJsonlCount += 1;
      }
    }

    if (verifiedJsonlCount > 0) {
      checks.push({
        name: 'dsh_jsonl_strict_parse',
        status: 'passed',
        message: `Validated ${verifiedJsonlCount} session JSONL files with strict JSON parsing`,
      });
    }

    return {
      verified: true,
      archivePath,
      manifest,
      checks,
      recomputedFilesCount: manifest.files.length,
      recomputedTotalBytes,
      verifiedAt: new Date().toISOString(),
    };
  } finally {
    try {
      rmSync(tempVerifyDir, { recursive: true, force: true });
    } catch {}
  }
}
