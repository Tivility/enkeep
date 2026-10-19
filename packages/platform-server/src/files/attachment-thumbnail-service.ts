/**
 * Attachment Thumbnail Service
 *
 * Implements lazy thumbnail rendering and persistent disk caching for image attachments:
 * - Long edge 480px, JPEG quality 72, auto EXIF rotation
 * - Non-destructive: GIF and <64KB images are exempt (bypass thumbnailing)
 * - Two-tier hash-based cache directory under <dataRoot>/cache/thumbnails/
 * - Atomic write via temporary file rename to prevent partial reads under concurrency
 *
 * @module @enkeep/platform-server/files/attachment-thumbnail-service
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { Readable } from 'node:stream';
import sharp from 'sharp';

export const THUMBNAIL_MAX_EDGE = 480;
export const THUMBNAIL_QUALITY = 72;
export const THUMBNAIL_MIN_SOURCE_BYTES = 64 * 1024; // 64 KB

export const ELIGIBLE_THUMBNAIL_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
]);

export interface ThumbnailResult {
  readonly buffer: Buffer;
  readonly mimeType: 'image/jpeg';
  readonly etag: string;
  readonly fromCache: boolean;
}

export interface AttachmentThumbnailServiceOptions {
  readonly dshHome?: string;
  readonly dataRoot?: string;
}

/**
 * Checks if an attachment is eligible for thumbnail generation.
 * Only PNG, JPEG, and WebP with size >= 64KB qualify.
 * GIF, SVG, non-images, and images < 64KB are exempt.
 */
export function isEligibleForThumbnail(mediaType: string | undefined, size: number): boolean {
  if (!mediaType || typeof size !== 'number') return false;
  const cleanMime = mediaType.split(';')[0].trim().toLowerCase();
  if (!ELIGIBLE_THUMBNAIL_MIME_TYPES.has(cleanMime)) {
    return false;
  }
  return size >= THUMBNAIL_MIN_SOURCE_BYTES;
}

/**
 * Helper to compute deterministic thumbnail cache key.
 */
export function computeThumbnailCacheKey(spaceId: string, snapshotPath: string): string {
  const normalized = `${spaceId}:${snapshotPath.replace(/\\/g, '/').replace(/^\/+/, '')}`;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Reads an entire readable stream into a single Buffer.
 */
export async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    if (Buffer.isBuffer(chunk)) {
      chunks.push(chunk);
    } else {
      chunks.push(Buffer.from(chunk));
    }
  }
  return Buffer.concat(chunks);
}

export class AttachmentThumbnailService {
  private readonly cacheDir: string;

  constructor(options?: AttachmentThumbnailServiceOptions) {
    const baseDir =
      options?.dataRoot ||
      options?.dshHome ||
      process.env.ENKEEP_DATA_ROOT ||
      process.env.ENKEEP_DATA_DIR ||
      path.join(os.tmpdir(), 'enkeep');

    this.cacheDir = path.join(baseDir, 'cache', 'thumbnails');
  }

  /**
   * Resolves the disk path for a cached thumbnail using a 2-level directory structure.
   */
  getThumbnailPath(spaceId: string, snapshotPath: string): string {
    const key = computeThumbnailCacheKey(spaceId, snapshotPath);
    return path.join(this.cacheDir, key.slice(0, 2), `${key}.jpg`);
  }

  /**
   * Computes a weak ETag for the thumbnail given original ETag.
   */
  computeThumbnailEtag(originalEtag: string): string {
    const cleanEtag = originalEtag.replace(/^W\//, '').replace(/"/g, '');
    return `W/"${cleanEtag}-thumb-480"`;
  }

  /**
   * Retrieves an existing cached thumbnail if it exists on disk.
   */
  async getCachedThumbnail(spaceId: string, snapshotPath: string, originalEtag: string): Promise<ThumbnailResult | null> {
    const filePath = this.getThumbnailPath(spaceId, snapshotPath);
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.isFile() && stat.size > 0) {
        const buffer = await fs.promises.readFile(filePath);
        return {
          buffer,
          mimeType: 'image/jpeg',
          etag: this.computeThumbnailEtag(originalEtag),
          fromCache: true,
        };
      }
    } catch {
      // Not cached or cannot read
    }
    return null;
  }

  /**
   * Generates or fetches a thumbnail from cache.
   * If not cached, consumes sourceStream (or buffer), processes via sharp,
   * writes to disk atomically via temp file + rename, and returns the resulting JPEG Buffer.
   * Returns null on any processing error to allow graceful fallback to the original image.
   */
  async getOrRenderThumbnail(
    spaceId: string,
    snapshotPath: string,
    originalEtag: string,
    sourceStreamOrBuffer: NodeJS.ReadableStream | Buffer
  ): Promise<ThumbnailResult | null> {
    // 1. Check cache first
    const cached = await this.getCachedThumbnail(spaceId, snapshotPath, originalEtag);
    if (cached) {
      return cached;
    }

    // 2. Read source into Buffer
    let sourceBuffer: Buffer;
    try {
      if (Buffer.isBuffer(sourceStreamOrBuffer)) {
        sourceBuffer = sourceStreamOrBuffer;
      } else {
        sourceBuffer = await streamToBuffer(sourceStreamOrBuffer);
      }
    } catch {
      return null;
    }

    if (sourceBuffer.length === 0) {
      return null;
    }

    // 3. Process image with sharp
    let thumbBuffer: Buffer;
    try {
      thumbBuffer = await sharp(sourceBuffer)
        .rotate() // Automatically orient based on EXIF
        .resize(THUMBNAIL_MAX_EDGE, THUMBNAIL_MAX_EDGE, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: THUMBNAIL_QUALITY })
        .toBuffer();
    } catch {
      // Fallback on corrupt image, unrecognized format, etc.
      return null;
    }

    // 4. Save to disk cache atomically
    const targetPath = this.getThumbnailPath(spaceId, snapshotPath);
    const targetDir = path.dirname(targetPath);
    const tempPath = `${targetPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;

    try {
      await fs.promises.mkdir(targetDir, { recursive: true });
      await fs.promises.writeFile(tempPath, thumbBuffer);
      await fs.promises.rename(tempPath, targetPath);
    } catch {
      // Clean up temp file if rename failed
      try {
        await fs.promises.unlink(tempPath);
      } catch {
        // ignore
      }
    }

    return {
      buffer: thumbBuffer,
      mimeType: 'image/jpeg',
      etag: this.computeThumbnailEtag(originalEtag),
      fromCache: false,
    };
  }
}
