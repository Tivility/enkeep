/**
 * Backup Restore Operation (`enkeep-backup restore` / `enkeep-restore`)
 *
 * @module @enkeep/backup-restore/operations/restore
 */

import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
  lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  DATABASE_FILE_NAME,
  MANIFEST_FILE_NAME,
  PERMISSIONS,
  SECRETS_FILE_NAME,
} from '../constants.js';
import { computeSha256 } from '../crypto/hash.js';
import { readPassphraseFromFile } from '../crypto/passphrase.js';
import { isEncryptedBackupBuffer, decryptBackupPayload } from '../crypto/cipher.js';
import { TarReader } from '../tar/tar-reader.js';
import { validateBackupManifest } from '../manifest/inspector.js';
import { validateRestoredTarget } from '../validators/post-restore.js';
import { assertAbsolutePath, assertTargetNotArchive } from './safety.js';
import {
  BackupArchiveError,
  BackupEncryptionError,
  BackupIntegrityError,
  BackupPathSafetyError,
  BackupRestoreSafetyError,
  BackupVersionMismatchError,
} from '../errors.js';
import type { RestoreBackupOptions, RestoreBackupResult, VerifyCheckDetail } from '../types.js';

/**
 * Recursively hardens directory and file permissions.
 */
function hardenRestoredPermissions(rootDir: string): void {
  const pending = [rootDir];

  while (pending.length > 0) {
    const current = pending.pop()!;
    try {
      chmodSync(current, PERMISSIONS.dirMode); // 0o700
    } catch {}

    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
      } else if (entry.isFile()) {
        try {
          chmodSync(fullPath, PERMISSIONS.sensitiveFileMode); // 0o600
        } catch {}
      }
    }
  }
}

/**
 * Restores a backup archive into a target root directory with atomic staging and strict validation.
 */
export async function restoreBackup(options: RestoreBackupOptions): Promise<RestoreBackupResult> {
  const archivePath = assertAbsolutePath(options.archivePath, 'archivePath');
  const targetRoot = assertAbsolutePath(options.targetRoot, 'targetRoot');

  if (!existsSync(archivePath)) {
    throw new BackupPathSafetyError(`Backup archive not found: "${archivePath}"`);
  }

  assertTargetNotArchive(targetRoot, archivePath);

  // Target directory checks
  if (existsSync(targetRoot)) {
    const targetStat = lstatSync(targetRoot);
    if (!targetStat.isDirectory()) {
      throw new BackupRestoreSafetyError(
        `Target restore path exists and is not a directory: "${targetRoot}"`
      );
    }
    const existingEntries = readdirSync(targetRoot);
    if (existingEntries.length > 0 && !options.force) {
      throw new BackupRestoreSafetyError(
        `Target restore directory "${targetRoot}" is not empty (${existingEntries.length} entries found). ` +
          `Restore will not overwrite existing directories. Provide an empty or non-existent target, or use --force.`
      );
    }
  }

  const rawArchive = readFileSync(archivePath);
  const isEncrypted = isEncryptedBackupBuffer(rawArchive);
  let tarBuffer: Buffer;

  // 1. Decryption
  if (isEncrypted) {
    if (!options.passphraseFile) {
      throw new BackupEncryptionError(
        'Archive is encrypted. Provide --passphrase-file <path> to restore.'
      );
    }
    const passphrase = readPassphraseFromFile(options.passphraseFile);
    tarBuffer = decryptBackupPayload(rawArchive, passphrase);
  } else {
    tarBuffer = rawArchive;
  }

  // 2. Unpack tar entries in memory
  const tarReader = new TarReader();
  const entries = tarReader.readAllEntries(tarBuffer);

  const manifestEntry = entries.find((e) => e.path === MANIFEST_FILE_NAME);
  if (!manifestEntry) {
    throw new BackupArchiveError(`Missing required manifest "${MANIFEST_FILE_NAME}" in archive`);
  }

  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(manifestEntry.data.toString('utf8'));
  } catch (err) {
    throw new BackupIntegrityError(
      `Corrupted manifest in archive: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const manifest = validateBackupManifest(manifestRaw);

  // 3. Check Runtime Image / Version match
  const currentRuntimeImage = process.env.ENKEEP_RUNTIME_IMAGE;
  if (
    currentRuntimeImage &&
    manifest.runtimeImage &&
    manifest.runtimeImage !== currentRuntimeImage &&
    !options.allowRuntimeImageMismatch
  ) {
    throw new BackupVersionMismatchError(
      `Runtime image mismatch: Archive created with "${manifest.runtimeImage}", but current environment is "${currentRuntimeImage}". ` +
        `Provide --allow-runtime-image-mismatch to proceed anyway.`
    );
  }

  // 4. Validate entry checksums against manifest
  const entriesByPath = new Map(entries.map((e) => [e.path, e]));
  let totalRestoredBytes = 0;

  for (const expected of manifest.files) {
    const entry = entriesByPath.get(expected.path);
    if (!entry) {
      throw new BackupIntegrityError(
        `Archive corrupted: Missing file listed in manifest: "${expected.path}"`
      );
    }
    if (entry.data.length !== expected.size) {
      throw new BackupIntegrityError(
        `Archive corrupted: Size mismatch for "${expected.path}" (expected ${expected.size}, got ${entry.data.length})`
      );
    }
    const sha = computeSha256(entry.data);
    if (sha !== expected.sha256) {
      throw new BackupIntegrityError(
        `Archive corrupted: Checksum mismatch for "${expected.path}" (expected ${expected.sha256}, got ${sha})`
      );
    }
    totalRestoredBytes += entry.data.length;
  }

  // Handle dry-run mode: Validate everything in isolated temporary sandbox, zero target write
  if (options.dryRun) {
    const dryRunTemp = mkdtempSync(join(tmpdir(), 'enkeep-restore-dryrun-'));
    try {
      // Write all files to dry-run sandbox
      for (const entry of entries) {
        if (entry.path === MANIFEST_FILE_NAME) continue;
        const outPath = join(dryRunTemp, entry.path);
        mkdirSync(dirname(outPath), { recursive: true, mode: PERMISSIONS.dirMode });
        writeFileSync(outPath, entry.data, { mode: entry.mode || PERMISSIONS.sensitiveFileMode });
      }

      hardenRestoredPermissions(dryRunTemp);

      const postRestoreChecks = await validateRestoredTarget({
        targetRoot: dryRunTemp,
        manifest,
      });

      return {
        success: true,
        dryRun: true,
        targetRoot,
        manifest,
        restoredFilesCount: manifest.files.length,
        restoredBytes: totalRestoredBytes,
        postRestoreChecks,
        restoredAt: new Date().toISOString(),
      };
    } finally {
      try {
        rmSync(dryRunTemp, { recursive: true, force: true });
      } catch {}
    }
  }

  // 5. Staged Restoration in sibling temporary directory
  const targetParent = dirname(targetRoot);
  mkdirSync(targetParent, { recursive: true, mode: PERMISSIONS.dirMode });

  const stagingDir = join(
    targetParent,
    `.enkeep-restore-stage-${Date.now()}-${randomUUID().slice(0, 8)}`
  );
  mkdirSync(stagingDir, { recursive: true, mode: PERMISSIONS.dirMode });

  let postRestoreChecks: VerifyCheckDetail[] = [];

  try {
    // Write all data files
    for (const entry of entries) {
      if (entry.path === MANIFEST_FILE_NAME) continue;
      const targetFilePath = join(stagingDir, entry.path);
      mkdirSync(dirname(targetFilePath), { recursive: true, mode: PERMISSIONS.dirMode });
      writeFileSync(targetFilePath, entry.data, {
        mode: entry.mode || PERMISSIONS.sensitiveFileMode,
      });
    }

    // Write manifest copy to staging
    writeFileSync(
      join(stagingDir, MANIFEST_FILE_NAME),
      Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'),
      { mode: PERMISSIONS.sensitiveFileMode }
    );

    // Harden permissions
    hardenRestoredPermissions(stagingDir);

    // 6. Post-restore validations
    postRestoreChecks = await validateRestoredTarget({
      targetRoot: stagingDir,
      manifest,
    });

    // 7. Atomic Commit: Rename stagingDir to targetRoot
    if (existsSync(targetRoot)) {
      // Empty existing directory if forced
      rmSync(targetRoot, { recursive: true, force: true });
    }

    renameSync(stagingDir, targetRoot);

    return {
      success: true,
      dryRun: false,
      targetRoot,
      manifest,
      restoredFilesCount: manifest.files.length,
      restoredBytes: totalRestoredBytes,
      postRestoreChecks,
      restoredAt: new Date().toISOString(),
    };
  } catch (err) {
    // Clean up staging on any failure, leaving target untouched
    try {
      rmSync(stagingDir, { recursive: true, force: true });
    } catch {}
    throw err;
  }
}
