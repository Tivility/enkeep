/**
 * Backup Inspection Operation (`enkeep-backup inspect`)
 *
 * @module @enkeep/backup-restore/operations/inspect
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { MANIFEST_FILE_NAME } from '../constants.js';
import { readPassphraseFromFile } from '../crypto/passphrase.js';
import { isEncryptedBackupBuffer, decryptBackupPayload } from '../crypto/cipher.js';
import { TarReader } from '../tar/tar-reader.js';
import { validateBackupManifest } from '../manifest/inspector.js';
import { assertAbsolutePath } from './safety.js';
import { BackupArchiveError, BackupEncryptionError, BackupPathSafetyError } from '../errors.js';
import type { InspectBackupOptions, InspectBackupResult } from '../types.js';

/**
 * Inspects a backup archive and extracts its manifest and metadata.
 */
export async function inspectBackup(options: InspectBackupOptions): Promise<InspectBackupResult> {
  const archivePath = assertAbsolutePath(options.archivePath, 'archivePath');

  if (!existsSync(archivePath)) {
    throw new BackupPathSafetyError(`Backup archive file not found: "${archivePath}"`);
  }

  const archiveStat = statSync(archivePath);
  const rawArchive = readFileSync(archivePath);

  const isEncrypted = isEncryptedBackupBuffer(rawArchive);
  let tarBuffer: Buffer;

  if (isEncrypted) {
    if (!options.passphraseFile) {
      throw new BackupEncryptionError(
        'Archive is encrypted. Provide --passphrase-file <path> to inspect.'
      );
    }
    const passphrase = readPassphraseFromFile(options.passphraseFile);
    tarBuffer = decryptBackupPayload(rawArchive, passphrase);
  } else {
    tarBuffer = rawArchive;
  }

  const tarReader = new TarReader();
  const entries = tarReader.readAllEntries(tarBuffer);

  const manifestEntry = entries.find((e) => e.path === MANIFEST_FILE_NAME);
  if (!manifestEntry) {
    throw new BackupArchiveError(
      `Corrupted archive: Missing required "${MANIFEST_FILE_NAME}" entry`
    );
  }

  let parsedManifestRaw: unknown;
  try {
    parsedManifestRaw = JSON.parse(manifestEntry.data.toString('utf8'));
  } catch (err) {
    throw new BackupArchiveError(
      `Corrupted manifest in archive: JSON parse failed (${err instanceof Error ? err.message : String(err)})`
    );
  }

  const manifest = validateBackupManifest(parsedManifestRaw);

  const totalUncompressedBytes = entries.reduce((acc, e) => acc + e.size, 0);

  return {
    archivePath,
    encrypted: isEncrypted,
    manifest,
    archiveSize: archiveStat.size,
    totalFiles: entries.length,
    totalUncompressedBytes,
  };
}
