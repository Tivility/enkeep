/**
 * Path Safety & Confinement Utilities
 *
 * @module @enkeep/backup-restore/operations/safety
 */

import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, normalize, relative, resolve } from 'node:path';
import { BackupPathSafetyError } from '../errors.js';

/**
 * Validates that an input path is absolute and well-formed.
 */
export function assertAbsolutePath(targetPath: string, name: string): string {
  if (!targetPath || typeof targetPath !== 'string' || !targetPath.trim()) {
    throw new BackupPathSafetyError(`${name} must be a non-empty absolute path`);
  }
  const resolved = resolve(targetPath);
  if (!isAbsolute(resolved)) {
    throw new BackupPathSafetyError(`${name} must be an absolute path: "${targetPath}"`);
  }
  return normalize(resolved);
}

/**
 * Asserts that the output archive path is NOT located inside the source data directory.
 */
export function assertOutputNotInSource(dataRoot: string, outputPath: string): void {
  const normData = normalize(resolve(dataRoot));
  const normOutput = normalize(resolve(outputPath));

  const rel = relative(normData, normOutput);
  const isInside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));

  if (isInside) {
    throw new BackupPathSafetyError(
      `Output archive path "${normOutput}" must NOT be located inside source data root "${normData}". ` +
        `Writing an archive inside the source directory corrupts backup consistency.`
    );
  }
}

/**
 * Asserts that the restore target root does NOT contain the backup archive itself.
 */
export function assertTargetNotArchive(targetRoot: string, archivePath: string): void {
  const normTarget = normalize(resolve(targetRoot));
  const normArchive = normalize(resolve(archivePath));

  const rel = relative(normTarget, normArchive);
  const isInside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));

  if (isInside) {
    throw new BackupPathSafetyError(
      `Target restore path "${normTarget}" must NOT contain the archive file "${normArchive}".`
    );
  }
}
