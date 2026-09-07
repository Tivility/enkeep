/**
 * Pure TypeScript Tar Archive Writer
 *
 * Implements POSIX ustar / GNU Tar archive packing with:
 * - GNU '././@LongLink' support for paths > 100 characters
 * - Path traversal and character containment validation
 * - Duplicate entry and case collision rejection
 * - Strict limits on file count, file size, and total size
 *
 * @module @enkeep/backup-restore/tar/tar-writer
 */

import {
  BLOCK_SIZE,
  normalizeAndValidateArchivePath,
  writeOctal,
  computeHeaderChecksum,
} from './tar-entry.js';
import { DEFAULT_LIMITS } from '../constants.js';
import { BackupArchiveError } from '../errors.js';
import type { BackupLimits } from '../types.js';

export interface TarFilePayload {
  path: string;
  data: Buffer;
  mode?: number;
  mtime?: number;
  uid?: number;
  gid?: number;
}

export class TarWriter {
  private readonly limits: BackupLimits;
  private readonly seenPaths = new Set<string>();
  private readonly seenLowerCasePaths = new Set<string>();
  private readonly chunks: Buffer[] = [];
  private totalBytes = 0;
  private fileCount = 0;

  constructor(limits?: Partial<BackupLimits>) {
    this.limits = {
      maxFileSize: limits?.maxFileSize ?? DEFAULT_LIMITS.maxFileSize,
      maxTotalSize: limits?.maxTotalSize ?? DEFAULT_LIMITS.maxTotalSize,
      maxFileCount: limits?.maxFileCount ?? DEFAULT_LIMITS.maxFileCount,
    };
  }

  /**
   * Adds a regular file entry to the tar archive.
   */
  addFile(file: TarFilePayload): void {
    const normalizedPath = normalizeAndValidateArchivePath(file.path);

    if (this.seenPaths.has(normalizedPath)) {
      throw new BackupArchiveError(`Duplicate archive entry detected: "${normalizedPath}"`);
    }

    const lower = normalizedPath.toLowerCase();
    if (this.seenLowerCasePaths.has(lower)) {
      throw new BackupArchiveError(
        `Case collision detected in archive entries: "${normalizedPath}"`
      );
    }

    this.seenPaths.add(normalizedPath);
    this.seenLowerCasePaths.add(lower);

    this.fileCount += 1;
    if (this.fileCount > this.limits.maxFileCount) {
      throw new BackupArchiveError(
        `Archive file count exceeds limit (${this.fileCount} > ${this.limits.maxFileCount})`
      );
    }

    const data = file.data;
    if (data.length > this.limits.maxFileSize) {
      throw new BackupArchiveError(
        `File "${normalizedPath}" exceeds max file size (${data.length} > ${this.limits.maxFileSize} bytes)`
      );
    }

    this.totalBytes += data.length;
    if (this.totalBytes > this.limits.maxTotalSize) {
      throw new BackupArchiveError(
        `Total archive size exceeds limit (${this.totalBytes} > ${this.limits.maxTotalSize} bytes)`
      );
    }

    const mode = file.mode ?? 0o600;
    const mtime = file.mtime ?? Math.floor(Date.now() / 1000);
    const uid = file.uid ?? 0;
    const gid = file.gid ?? 0;

    // Handle GNU LongLink for paths > 100 bytes
    const pathBuffer = Buffer.from(normalizedPath, 'utf8');
    if (pathBuffer.length > 100) {
      this.writeGnuLongLink(pathBuffer);
    }

    // Write primary header
    const header = Buffer.alloc(BLOCK_SIZE, 0);

    // 0-100: name (truncated if longlink was written, else exact)
    pathBuffer.copy(header, 0, 0, Math.min(pathBuffer.length, 100));

    // 100-108: mode (8 bytes octal)
    writeOctal(header, 100, 8, mode & 0o7777);

    // 108-116: uid (8 bytes octal)
    writeOctal(header, 108, 8, uid);

    // 116-124: gid (8 bytes octal)
    writeOctal(header, 116, 8, gid);

    // 124-136: size (12 bytes octal)
    writeOctal(header, 124, 12, data.length);

    // 136-148: mtime (12 bytes octal)
    writeOctal(header, 136, 12, mtime);

    // 156: typeflag ('0' for regular file)
    header[156] = 48; // ASCII '0'

    // 257-263: magic "ustar\0"
    header.write('ustar\0', 257, 6, 'ascii');

    // 263-265: version "00"
    header.write('00', 263, 2, 'ascii');

    // 265-297: uname
    header.write('enkeep', 265, 6, 'ascii');

    // 297-329: gname
    header.write('enkeep', 297, 6, 'ascii');

    // Compute checksum (148-156)
    const checksum = computeHeaderChecksum(header);
    writeOctal(header, 148, 8, checksum);

    this.chunks.push(header);

    // Write file data
    if (data.length > 0) {
      this.chunks.push(data);
      const remainder = data.length % BLOCK_SIZE;
      if (remainder !== 0) {
        const padding = Buffer.alloc(BLOCK_SIZE - remainder, 0);
        this.chunks.push(padding);
      }
    }
  }

  /**
   * Writes GNU '././@LongLink' entry for long filenames.
   */
  private writeGnuLongLink(pathBuffer: Buffer): void {
    const longLinkHeader = Buffer.alloc(BLOCK_SIZE, 0);

    // Name: '././@LongLink'
    longLinkHeader.write('././@LongLink', 0, 14, 'ascii');

    // Mode: 0o000
    writeOctal(longLinkHeader, 100, 8, 0);
    writeOctal(longLinkHeader, 108, 8, 0);
    writeOctal(longLinkHeader, 116, 8, 0);

    // Size: length of path buffer + 1 (null terminator)
    const longLinkData = Buffer.concat([pathBuffer, Buffer.from([0])]);
    writeOctal(longLinkHeader, 124, 12, longLinkData.length);
    writeOctal(longLinkHeader, 136, 12, 0);

    // Typeflag: 'L' (GNU long link)
    longLinkHeader[156] = 76; // ASCII 'L'

    // Magic & version
    longLinkHeader.write('ustar\0', 257, 6, 'ascii');
    longLinkHeader.write('00', 263, 2, 'ascii');

    // Checksum
    const checksum = computeHeaderChecksum(longLinkHeader);
    writeOctal(longLinkHeader, 148, 8, checksum);

    this.chunks.push(longLinkHeader);
    this.chunks.push(longLinkData);

    const remainder = longLinkData.length % BLOCK_SIZE;
    if (remainder !== 0) {
      const padding = Buffer.alloc(BLOCK_SIZE - remainder, 0);
      this.chunks.push(padding);
    }
  }

  /**
   * Finalizes the tar archive with two 512-byte zero end-of-archive blocks.
   */
  finalize(): Buffer {
    // End of archive marker: at least two 512-byte zero blocks
    const eofMarker = Buffer.alloc(BLOCK_SIZE * 2, 0);
    this.chunks.push(eofMarker);

    return Buffer.concat(this.chunks);
  }
}
