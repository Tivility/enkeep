/**
 * Tar Format Definitions & Path Safety Validators
 *
 * @module @enkeep/backup-restore/tar/tar-entry
 */

import { BackupArchiveError, BackupPathSafetyError } from '../errors.js';

export const BLOCK_SIZE = 512;

export interface TarEntryHeader {
  name: string;
  mode: number;
  uid: number;
  gid: number;
  size: number;
  mtime: number;
  typeflag: string;
  linkname: string;
  uname: string;
  gname: string;
  devmajor: number;
  devminor: number;
  prefix: string;
}

export interface TarEntry {
  header: TarEntryHeader;
  data: Buffer;
}

/**
 * Normalizes and validates an archive path strictly.
 * Enforces:
 * - POSIX forward slashes
 * - Unicode NFC normalization
 * - Relative only (no leading slash, no drive letters)
 * - No '..' segments
 * - No null bytes or control characters
 */
export function normalizeAndValidateArchivePath(rawPath: string): string {
  if (!rawPath || typeof rawPath !== 'string') {
    throw new BackupPathSafetyError('Archive entry path must be a non-empty string');
  }

  // Convert Windows backslashes to forward slashes
  let normalized = rawPath.replace(/\\/g, '/');

  // Strip leading slashes and leading './'
  while (normalized.startsWith('/')) {
    normalized = normalized.slice(1);
  }
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }

  // Unicode NFC normalization
  normalized = normalized.normalize('NFC').trim();

  if (normalized.length === 0) {
    throw new BackupPathSafetyError(`Unsafe empty normalized archive path: "${rawPath}"`);
  }

  // Check for control characters or null bytes
  if (/[\x00-\x1f\x7f]/.test(normalized)) {
    throw new BackupPathSafetyError(`Archive path contains invalid control characters: "${rawPath}"`);
  }

  // Split into segments and check for traversal
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) {
    throw new BackupPathSafetyError(`Unsafe normalized archive path: "${rawPath}"`);
  }

  for (const seg of segments) {
    if (seg === '..' || seg === '.') {
      throw new BackupPathSafetyError(
        `Path traversal detected in archive path "${rawPath}" (segment: "${seg}")`
      );
    }
  }

  return segments.join('/');
}

/**
 * Parses an octal string from a tar header field.
 */
export function parseOctal(buffer: Buffer, offset: number, length: number): number {
  const field = buffer.subarray(offset, offset + length).toString('ascii');
  const clean = field.replace(/\0/g, '').trim();
  if (!clean) return 0;
  const val = parseInt(clean, 8);
  return isNaN(val) ? 0 : val;
}

/**
 * Encodes a number into an octal ASCII string in a fixed buffer field.
 */
export function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const octalStr = Math.floor(value).toString(8).padStart(length - 1, '0');
  buffer.write(octalStr, offset, length - 1, 'ascii');
  buffer[offset + length - 1] = 0; // null terminator
}

/**
 * Computes the 8-byte checksum for a 512-byte tar header block.
 */
export function computeHeaderChecksum(headerBlock: Buffer): number {
  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) {
    if (i >= 148 && i < 156) {
      sum += 32; // treat checksum field as ASCII space (0x20)
    } else {
      sum += headerBlock[i]!;
    }
  }
  return sum;
}
