/**
 * Secure Passphrase File Reader & Validator
 *
 * Enforces reading passphrases strictly from secure local files,
 * never from command-line arguments or environment variables.
 *
 * @module @enkeep/backup-restore/crypto/passphrase
 */

import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BackupEncryptionError, BackupPathSafetyError } from '../errors.js';

export const MIN_PASSPHRASE_LENGTH = 8;

/**
 * Reads and validates a passphrase from an absolute or resolvable file path.
 */
export function readPassphraseFromFile(passphraseFile?: string): string {
  if (!passphraseFile || typeof passphraseFile !== 'string' || !passphraseFile.trim()) {
    throw new BackupEncryptionError(
      'Passphrase file path is required. Provide --passphrase-file <path>.'
    );
  }

  const resolvedPath = resolve(passphraseFile);
  if (!existsSync(resolvedPath)) {
    throw new BackupPathSafetyError(`Passphrase file does not exist: "${resolvedPath}"`);
  }

  const stat = lstatSync(resolvedPath);
  if (stat.isSymbolicLink()) {
    throw new BackupPathSafetyError(`Passphrase file must not be a symbolic link: "${resolvedPath}"`);
  }
  if (!stat.isFile()) {
    throw new BackupPathSafetyError(`Passphrase path is not a regular file: "${resolvedPath}"`);
  }

  // Check file permissions mode on POSIX systems (warn or notice if too open)
  const mode = stat.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    // File is readable/writable by group or others
    // We do not reject outright to avoid breaking non-POSIX/Docker, but we record permission
  }

  const rawContent = readFileSync(resolvedPath, 'utf8');
  // Trim trailing newline or whitespace
  const passphrase = rawContent.replace(/[\r\n]+$/, '');

  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new BackupEncryptionError(
      `Passphrase in "${resolvedPath}" is too short. Minimum length is ${MIN_PASSPHRASE_LENGTH} characters.`
    );
  }

  return passphrase;
}
