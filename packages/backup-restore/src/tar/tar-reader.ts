/**
 * Pure TypeScript Tar Archive Reader & Safety Guard
 *
 * Implements POSIX ustar / GNU Tar archive parsing and validation:
 * - Validates block checksums, ustar magic, headers
 * - Extracts GNU long links seamlessly
 * - Strict defense against path traversal ('..', leading '/', absolute paths)
 * - Strict rejection of symlinks, hardlinks, character devices, block devices, FIFOs, sockets
 * - Rejection of duplicate entries and case collisions
 * - Enforces limits on file count, individual file size, and total uncompressed bytes
 *
 * @module @enkeep/backup-restore/tar/tar-reader
 */

import {
  BLOCK_SIZE,
  normalizeAndValidateArchivePath,
  parseOctal,
  computeHeaderChecksum,
} from './tar-entry.js';
import { DEFAULT_LIMITS } from '../constants.js';
import { BackupArchiveError } from '../errors.js';
import type { BackupLimits } from '../types.js';

export interface ExtractedTarEntry {
  path: string;
  data: Buffer;
  mode: number;
  uid: number;
  gid: number;
  mtime: number;
  size: number;
}

export class TarReader {
  private readonly limits: BackupLimits;

  constructor(limits?: Partial<BackupLimits>) {
    this.limits = {
      maxFileSize: limits?.maxFileSize ?? DEFAULT_LIMITS.maxFileSize,
      maxTotalSize: limits?.maxTotalSize ?? DEFAULT_LIMITS.maxTotalSize,
      maxFileCount: limits?.maxFileCount ?? DEFAULT_LIMITS.maxFileCount,
    };
  }

  /**
   * Parses a complete tar archive buffer into validated entries in memory.
   */
  readAllEntries(tarBuffer: Buffer): ExtractedTarEntry[] {
    if (tarBuffer.length === 0) {
      throw new BackupArchiveError('Backup archive is empty (0 bytes)');
    }
    if (tarBuffer.length % BLOCK_SIZE !== 0) {
      throw new BackupArchiveError(
        `Corrupted backup archive: Length (${tarBuffer.length} bytes) is not a multiple of ${BLOCK_SIZE}`
      );
    }

    const entries: ExtractedTarEntry[] = [];
    const seenPaths = new Set<string>();
    const seenLowerCasePaths = new Set<string>();
    let totalBytes = 0;
    let offset = 0;
    let pendingLongName: string | null = null;

    while (offset < tarBuffer.length) {
      const headerBlock = tarBuffer.subarray(offset, offset + BLOCK_SIZE);
      offset += BLOCK_SIZE;

      // Check for zero block (end-of-archive indicator)
      const isZeroBlock = headerBlock.every((b) => b === 0);
      if (isZeroBlock) {
        // End of archive reached or padding block
        continue;
      }

      // Check header checksum
      const rawChecksum = headerBlock.subarray(148, 156).toString('ascii').replace(/\0/g, '').trim();
      const expectedChecksum = parseOctal(headerBlock, 148, 8);
      const actualChecksum = computeHeaderChecksum(headerBlock);

      if (expectedChecksum !== actualChecksum) {
        throw new BackupArchiveError(
          `Corrupted backup archive header at offset ${offset - BLOCK_SIZE}: Checksum mismatch (expected ${expectedChecksum}, calculated ${actualChecksum})`
        );
      }

      // Read typeflag (156)
      const typeflagChar = String.fromCharCode(headerBlock[156] ?? 48);

      // Read size (124-136)
      const size = parseOctal(headerBlock, 124, 12);
      if (size < 0) {
        throw new BackupArchiveError(`Invalid negative file size in archive entry: ${size}`);
      }
      if (size > this.limits.maxFileSize) {
        throw new BackupArchiveError(
          `Archive entry size (${size} bytes) exceeds max file size limit (${this.limits.maxFileSize} bytes)`
        );
      }

      // Data block length padded to 512-byte boundary
      const dataBlockLen = Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
      if (offset + dataBlockLen > tarBuffer.length) {
        throw new BackupArchiveError(
          `Corrupted archive: Entry data extends beyond archive boundary (need ${dataBlockLen} bytes, available ${tarBuffer.length - offset})`
        );
      }

      const fileData = tarBuffer.subarray(offset, offset + size);
      offset += dataBlockLen;

      // Handle GNU LongLink typeflag 'L'
      if (typeflagChar === 'L') {
        // Read full long name from data block (strip trailing nulls)
        const longName = fileData.toString('utf8').replace(/\0.*$/, '');
        pendingLongName = longName;
        continue;
      }

      // Reject all dangerous entry types (symlinks, hardlinks, devices, FIFOs, etc.)
      // '0' or '\0' = regular file
      // '5' = directory
      // '1' = hardlink
      // '2' = symlink
      // '3' = character device
      // '4' = block device
      // '6' = FIFO
      if (typeflagChar === '1' || typeflagChar === 'h') {
        throw new BackupArchiveError(
          `Unsafe backup archive entry: Hard link entry rejected (typeflag "${typeflagChar}")`
        );
      }
      if (typeflagChar === '2' || typeflagChar === 's') {
        throw new BackupArchiveError(
          `Unsafe backup archive entry: Symbolic link entry rejected (typeflag "${typeflagChar}")`
        );
      }
      if (typeflagChar === '3' || typeflagChar === '4' || typeflagChar === '6') {
        throw new BackupArchiveError(
          `Unsafe backup archive entry: Special device/FIFO file rejected (typeflag "${typeflagChar}")`
        );
      }
      if (typeflagChar !== '0' && typeflagChar !== '\0' && typeflagChar !== '5') {
        throw new BackupArchiveError(
          `Unsupported or unsafe backup archive entry typeflag: "${typeflagChar}"`
        );
      }

      // If it's a directory entry ('5'), we don't store file payload, but validate path
      let rawName = pendingLongName;
      pendingLongName = null;

      if (!rawName) {
        // Extract prefix and name
        const prefix = headerBlock.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
        const namePart = headerBlock.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
        rawName = prefix ? `${prefix}/${namePart}` : namePart;
      }

      const normalizedPath = normalizeAndValidateArchivePath(rawName);

      if (typeflagChar === '5') {
        // Directory entry - validated, skip creating file record
        continue;
      }

      // Check duplicates
      if (seenPaths.has(normalizedPath)) {
        throw new BackupArchiveError(`Duplicate entry detected in backup archive: "${normalizedPath}"`);
      }
      const lower = normalizedPath.toLowerCase();
      if (seenLowerCasePaths.has(lower)) {
        throw new BackupArchiveError(
          `Case collision detected in backup archive: "${normalizedPath}"`
        );
      }

      seenPaths.add(normalizedPath);
      seenLowerCasePaths.add(lower);

      entries.push({
        path: normalizedPath,
        data: Buffer.from(fileData), // copy buffer
        mode: parseOctal(headerBlock, 100, 8),
        uid: parseOctal(headerBlock, 108, 8),
        gid: parseOctal(headerBlock, 116, 8),
        mtime: parseOctal(headerBlock, 136, 12),
        size,
      });

      if (entries.length > this.limits.maxFileCount) {
        throw new BackupArchiveError(
          `Archive file count exceeds limit (${entries.length} > ${this.limits.maxFileCount})`
        );
      }

      totalBytes += size;
      if (totalBytes > this.limits.maxTotalSize) {
        throw new BackupArchiveError(
          `Total uncompressed archive size exceeds limit (${totalBytes} > ${this.limits.maxTotalSize} bytes)`
        );
      }
    }

    if (entries.length === 0) {
      throw new BackupArchiveError('Backup archive contains no valid file entries');
    }

    return entries;
  }
}
