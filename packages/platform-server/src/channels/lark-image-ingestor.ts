import { createHash } from 'node:crypto';
import type { LarkImageAttachmentIngestor } from '@enkeep/channel-lark';
import { PlatformError, ValidationError } from '@enkeep/platform-core';
import type { TenantRuntimeFileProvider } from '../files/runtime-file-api.js';
import { validateUserId, validateSpaceId } from '../files/runtime-file-api.js';
import { sniffMimeType } from '../files/file-transport-utils.js';

export const SAFE_RESOURCE_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;
export const MAX_ATTACHMENT_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MiB per image
export const MAX_ATTACHMENT_FILE_BYTES = 20 * 1024 * 1024; // 20 MiB per file

function isStrictPdfBuffer(buffer: Buffer): boolean {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= 5 &&
    buffer[0] === 0x25 && // %
    buffer[1] === 0x50 && // P
    buffer[2] === 0x44 && // D
    buffer[3] === 0x46 && // F
    buffer[4] === 0x2d    // -
  );
}

const SUPPORTED_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

const MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

export interface TenantScopedLarkImageIngestorOptions {
  readonly fileProvider: TenantRuntimeFileProvider;
}

/**
 * Tenant-scoped safe Lark image attachment ingestor.
 * Validates user/space authorization, sniffs MIME bytes to reject masquerades,
 * stores images deterministically under `.attachments/incoming/<sha256>.<ext>`,
 * and returns exact accepted envelope attachment items.
 */
export class TenantScopedLarkImageIngestor implements LarkImageAttachmentIngestor {
  private readonly fileProvider: TenantRuntimeFileProvider;

  constructor(options: TenantScopedLarkImageIngestorOptions) {
    if (!options || !options.fileProvider) {
      throw new ValidationError('TenantScopedLarkImageIngestor requires fileProvider');
    }
    this.fileProvider = options.fileProvider;
  }

  async ingestImage(params: {
    userId: string;
    spaceId: string;
    messageId: string;
    fileKey: string;
    buffer: Buffer;
    contentType?: string;
  }): Promise<{
    path: string;
    etag: string;
    mediaType: string;
    displayName: string;
  }> {
    const cleanUserId = validateUserId(params.userId);
    const cleanSpaceId = validateSpaceId(params.spaceId);

    if (!params.messageId || !SAFE_RESOURCE_ID_REGEX.test(params.messageId)) {
      throw new ValidationError('Invalid or unsafe messageId format');
    }
    if (!params.fileKey || !SAFE_RESOURCE_ID_REGEX.test(params.fileKey)) {
      throw new ValidationError('Invalid or unsafe fileKey format');
    }

    if (!Buffer.isBuffer(params.buffer) || params.buffer.length === 0) {
      throw new ValidationError('Image buffer must be a non-empty Buffer');
    }
    if (params.buffer.length > MAX_ATTACHMENT_IMAGE_BYTES) {
      throw new PlatformError(
        `Image size ${params.buffer.length} exceeds maximum limit of ${MAX_ATTACHMENT_IMAGE_BYTES} bytes`,
        'PAYLOAD_TOO_LARGE',
        413
      );
    }

    // Authoritative magic byte sniff; do not trust declared Content-Type alone
    const sniffedMime = sniffMimeType('image', params.buffer);
    if (!SUPPORTED_IMAGE_MIMES.has(sniffedMime)) {
      throw new ValidationError(`Unsupported image format or masquerade rejected: ${sniffedMime}`);
    }

    const sha256Hex = createHash('sha256').update(params.buffer).digest('hex').toLowerCase();
    const etag = `"${sha256Hex}"`;
    const ext = MIME_TO_EXT[sniffedMime] || '.jpg';
    // Deterministic, safe filename keyed by SHA-256 (no user input or unvalidated keys in filename)
    const safeFilename = `${sha256Hex}${ext}`;
    const targetRelativePath = `.attachments/incoming/${safeFilename}`;
    const displayName = `${params.fileKey}${ext}`;

    // Check if incoming file already exists with identical etag
    let alreadyExists = false;
    try {
      const statRes = await this.fileProvider.execute(cleanUserId, cleanSpaceId, {
        op: 'stat',
        path: targetRelativePath,
      });
      if (statRes && statRes.op === 'stat' && statRes.type === 'file' && statRes.etag === etag) {
        alreadyExists = true;
      }
    } catch {
      // Not found, proceeds to write
    }

    if (!alreadyExists) {
      try {
        if (typeof this.fileProvider.writeBinaryStream === 'function') {
          const { Readable } = await import('node:stream');
          await this.fileProvider.writeBinaryStream(
            cleanUserId,
            cleanSpaceId,
            {
              op: 'write',
              path: targetRelativePath,
              requireAbsent: true,
              maxSizeBytes: MAX_ATTACHMENT_IMAGE_BYTES,
            },
            Readable.from(params.buffer)
          );
        } else {
          // Bounded chunk size: 512 KiB binary = ~683 KiB base64 (strictly within 1 MiB transport frame)
          const CHUNK_SIZE = 512 * 1024;
          if (params.buffer.length <= CHUNK_SIZE) {
            try {
              await this.fileProvider.execute(cleanUserId, cleanSpaceId, {
                op: 'write',
                path: targetRelativePath,
                content: params.buffer.toString('base64'),
                encoding: 'base64',
                requireAbsent: true,
              });
            } catch (singleWriteErr: unknown) {
              const code = (singleWriteErr as { code?: string })?.code;
              if (code === 'PAYLOAD_TOO_LARGE' || code === 'INVALID_OP') {
                // Fallback to chunked staging or write_attachment
                await this.writeViaChunkedStaging(cleanUserId, cleanSpaceId, targetRelativePath, params.buffer, CHUNK_SIZE);
              } else {
                throw singleWriteErr;
              }
            }
          } else {
            await this.writeViaChunkedStaging(cleanUserId, cleanSpaceId, targetRelativePath, params.buffer, CHUNK_SIZE);
          }
        }
      } catch (writeErr: unknown) {
        // Handle race where file was concurrently written
        try {
          const checkStat = await this.fileProvider.execute(cleanUserId, cleanSpaceId, {
            op: 'stat',
            path: targetRelativePath,
          });
          if (checkStat && checkStat.op === 'stat' && checkStat.type === 'file' && checkStat.etag === etag) {
            alreadyExists = true;
          } else {
            throw writeErr;
          }
        } catch {
          throw writeErr;
        }
      }
    }

    return {
      path: targetRelativePath,
      etag,
      mediaType: sniffedMime,
      displayName,
    };
  }

  async ingestFile(params: {
    userId: string;
    spaceId: string;
    messageId: string;
    fileKey: string;
    fileName?: string;
    buffer: Buffer;
    contentType?: string;
  }): Promise<{
    path: string;
    etag: string;
    mediaType: string;
    displayName: string;
  }> {
    const cleanUserId = validateUserId(params.userId);
    const cleanSpaceId = validateSpaceId(params.spaceId);

    if (!params.messageId || !SAFE_RESOURCE_ID_REGEX.test(params.messageId)) {
      throw new ValidationError('Invalid or unsafe messageId format');
    }
    if (!params.fileKey || !SAFE_RESOURCE_ID_REGEX.test(params.fileKey)) {
      throw new ValidationError('Invalid or unsafe fileKey format');
    }

    if (!Buffer.isBuffer(params.buffer) || params.buffer.length === 0) {
      throw new ValidationError('File buffer must be a non-empty Buffer');
    }
    if (params.buffer.length > MAX_ATTACHMENT_FILE_BYTES) {
      throw new PlatformError(
        `File size ${params.buffer.length} exceeds maximum limit of ${MAX_ATTACHMENT_FILE_BYTES} bytes`,
        'PAYLOAD_TOO_LARGE',
        413
      );
    }

    // Authoritative strict magic byte sniff for PDF
    const isPdf = isStrictPdfBuffer(params.buffer);

    // Clean display name: sanitize claimed name, strip path traversal, limit length, fallback to fileKey
    let cleanDisplayName = params.fileKey;
    let claimedExt = '';
    if (params.fileName && typeof params.fileName === 'string') {
      const sanitized = params.fileName
        .normalize('NFC')
        .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
        .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
        .replace(/.*[/\\]/, '')
        .trim();
      if (sanitized && sanitized !== '.' && sanitized !== '..') {
        cleanDisplayName = sanitized.slice(0, 255);
        const lastDot = cleanDisplayName.lastIndexOf('.');
        if (lastDot > 0) {
          claimedExt = cleanDisplayName.slice(lastDot).toLowerCase();
        }
      }
    }

    if (!params.fileName && isPdf) {
      cleanDisplayName = `${params.fileKey}.pdf`;
    }

    // Authoritative MIME sniff from magic bytes and filename
    const sniffedMime = sniffMimeType(cleanDisplayName, params.buffer);

    // If file claims to be image or sniffed as image, validate against supported image formats
    if (sniffedMime.startsWith('image/')) {
      if (!SUPPORTED_IMAGE_MIMES.has(sniffedMime)) {
        throw new ValidationError(`Unsupported image format or masquerade rejected: ${sniffedMime}`);
      }
    }

    // Determine safe extension for storage:
    // PDF extension for actual PDF only, not for all files
    let safeExt = '.bin';
    if (isPdf) {
      safeExt = '.pdf';
    } else if (sniffedMime.startsWith('image/') && MIME_TO_EXT[sniffedMime]) {
      safeExt = MIME_TO_EXT[sniffedMime];
    } else if (claimedExt && claimedExt !== '.pdf') {
      if (/^\.[a-zA-Z0-9_-]{1,16}$/.test(claimedExt)) {
        safeExt = claimedExt;
      }
    }

    const sha256Hex = createHash('sha256').update(params.buffer).digest('hex').toLowerCase();
    const etag = `"${sha256Hex}"`;
    const safeFilename = `${sha256Hex}${safeExt}`;
    const targetRelativePath = `.attachments/incoming/${safeFilename}`;

    // Check if incoming file already exists with identical etag
    let alreadyExists = false;
    try {
      const statRes = await this.fileProvider.execute(cleanUserId, cleanSpaceId, {
        op: 'stat',
        path: targetRelativePath,
      });
      if (statRes && statRes.op === 'stat' && statRes.type === 'file' && statRes.etag === etag) {
        alreadyExists = true;
      }
    } catch {
      // Not found, proceeds to write
    }

    if (!alreadyExists) {
      try {
        if (typeof this.fileProvider.writeBinaryStream === 'function') {
          const { Readable } = await import('node:stream');
          await this.fileProvider.writeBinaryStream(
            cleanUserId,
            cleanSpaceId,
            {
              op: 'write',
              path: targetRelativePath,
              requireAbsent: true,
              maxSizeBytes: MAX_ATTACHMENT_FILE_BYTES,
            },
            Readable.from(params.buffer)
          );
        } else {
          // Bounded chunk size: 512 KiB binary = ~683 KiB base64 (strictly within 1 MiB transport frame)
          const CHUNK_SIZE = 512 * 1024;
          if (params.buffer.length <= CHUNK_SIZE) {
            try {
              await this.fileProvider.execute(cleanUserId, cleanSpaceId, {
                op: 'write',
                path: targetRelativePath,
                content: params.buffer.toString('base64'),
                encoding: 'base64',
                requireAbsent: true,
              });
            } catch (singleWriteErr: unknown) {
              const code = (singleWriteErr as { code?: string })?.code;
              if (code === 'PAYLOAD_TOO_LARGE' || code === 'INVALID_OP') {
                await this.writeViaChunkedStaging(cleanUserId, cleanSpaceId, targetRelativePath, params.buffer, CHUNK_SIZE);
              } else {
                throw singleWriteErr;
              }
            }
          } else {
            await this.writeViaChunkedStaging(cleanUserId, cleanSpaceId, targetRelativePath, params.buffer, CHUNK_SIZE);
          }
        }
      } catch (writeErr: unknown) {
        try {
          const checkStat = await this.fileProvider.execute(cleanUserId, cleanSpaceId, {
            op: 'stat',
            path: targetRelativePath,
          });
          if (checkStat && checkStat.op === 'stat' && checkStat.type === 'file' && checkStat.etag === etag) {
            alreadyExists = true;
          } else {
            throw writeErr;
          }
        } catch {
          throw writeErr;
        }
      }
    }

    return {
      path: targetRelativePath,
      etag,
      mediaType: sniffedMime,
      displayName: cleanDisplayName,
    };
  }

  private async writeViaChunkedStaging(
    userId: string,
    spaceId: string,
    targetPath: string,
    buffer: Buffer,
    chunkSize: number
  ): Promise<void> {
    let stageToken: string | undefined;
    try {
      let offset = 0;
      while (offset < buffer.length) {
        const chunkEnd = Math.min(offset + chunkSize, buffer.length);
        const chunkBuf = buffer.subarray(offset, chunkEnd);
        const stageRes = await this.fileProvider.execute(userId, spaceId, {
          op: 'stage_chunk',
          path: targetPath,
          stageToken,
          offset,
          content: chunkBuf.toString('base64'),
          encoding: 'base64',
        } as any);
        if (stageRes && (stageRes as any).stageToken) {
          stageToken = (stageRes as any).stageToken;
        }
        offset = chunkEnd;
      }

      await this.fileProvider.execute(userId, spaceId, {
        op: 'commit_stage',
        path: targetPath,
        stageToken: stageToken!,
        requireAbsent: true,
      } as any);
    } catch (stageErr: unknown) {
      if (stageToken) {
        try {
          await this.fileProvider.execute(userId, spaceId, {
            op: 'abort_stage',
            path: targetPath,
            stageToken,
          } as any);
        } catch {}
      }

      const errCode = (stageErr as { code?: string })?.code;
      if (errCode === 'INVALID_OP') {
        // If provider does not support stage_chunk, try dedicated write_attachment
        await this.fileProvider.execute(userId, spaceId, {
          op: 'write_attachment',
          path: targetPath,
          content: buffer.toString('base64'),
          encoding: 'base64',
          requireAbsent: true,
        } as any);
        return;
      }

      throw stageErr;
    }
  }
}
