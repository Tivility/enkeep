import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Service, type Context } from '@deepseek-ai/cordis';
import {
  AttachmentStore,
  AttachmentError,
  AttachmentId,
  ImageVariantId,
  type ImageAttachmentLimits,
  type ImageAttachmentRef,
  type ImageMediaType,
  type ImageRequestPolicy,
  type RequestImageAttachment,
  type SaveImageAttachment,
  type StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment';

export const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MiB
export const DEFAULT_MAX_IMAGES_PER_MESSAGE = 20;
export const DEFAULT_MAX_MESSAGE_IMAGE_BYTES = 200 * 1024 * 1024; // 200 MiB
export const DEFAULT_MAX_IMAGE_PIXELS = 64_000_000;
export const DEFAULT_MAX_IMAGE_DIMENSION = 8192;

export interface WorkspaceAttachmentConfig {
  readonly dshHome?: string;
  readonly spacesDir?: string;
  readonly spacePath?: string;
  readonly maxImageBytes?: number;
  readonly maxImagesPerMessage?: number;
  readonly maxMessageImageBytes?: number;
  readonly maxImagePixels?: number;
  readonly maxImageDimension?: number;
}

export interface DetectedImageInfo {
  readonly mediaType: ImageMediaType;
  readonly width: number;
  readonly height: number;
  readonly hasAlpha: boolean;
}

/**
 * Sniff supported image media type and dimensions from buffer header.
 * Pure JS parser for PNG, JPEG, GIF, and WebP.
 */
export function detectImageInfo(data: Uint8Array): DetectedImageInfo | null {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);

  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf.length >= 24 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return {
      mediaType: 'image/png',
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
      hasAlpha: true,
    };
  }

  // GIF signature: GIF87a or GIF89a
  if (
    buf.length >= 10 &&
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) &&
    buf[5] === 0x61
  ) {
    return {
      mediaType: 'image/gif',
      width: buf.readUInt16LE(6),
      height: buf.readUInt16LE(8),
      hasAlpha: true,
    };
  }

  // JPEG signature: FF D8 FF
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let offset = 2;
    while (offset < buf.length) {
      while (offset < buf.length && buf[offset] !== 0xff) offset++;
      while (offset < buf.length && buf[offset] === 0xff) offset++;
      if (offset >= buf.length) break;
      const marker = buf[offset++];
      if (marker === 0xd9 || marker === 0xda) break; // EOI or SOS
      if (offset + 2 > buf.length) break;
      const len = buf.readUInt16BE(offset);
      // SOF markers: 0xC0..0xC3, 0xC5..0xC7, 0xC9..0xCB, 0xCD..0xCF
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        if (offset + 7 <= buf.length) {
          const height = buf.readUInt16BE(offset + 3);
          const width = buf.readUInt16BE(offset + 5);
          return {
            mediaType: 'image/jpeg',
            width,
            height,
            hasAlpha: false,
          };
        }
      }
      offset += len;
    }
  }

  // WebP signature: RIFF....WEBP
  if (
    buf.length >= 16 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const chunkType = buf.toString('ascii', 12, 16);
    if (chunkType === 'VP8 ' && buf.length >= 30) {
      const width = buf.readUInt16LE(26) & 0x3fff;
      const height = buf.readUInt16LE(28) & 0x3fff;
      return { mediaType: 'image/webp', width, height, hasAlpha: false };
    } else if (chunkType === 'VP8L' && buf.length >= 26) {
      const b1 = buf[22], b2 = buf[23], b3 = buf[24], b4 = buf[25];
      const width = 1 + (((b2 & 0x3f) << 8) | b1);
      const height = 1 + (((b4 & 0xf) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
      return { mediaType: 'image/webp', width, height, hasAlpha: true };
    } else if (chunkType === 'VP8X' && buf.length >= 30) {
      const width = 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16);
      const height = 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16);
      return { mediaType: 'image/webp', width, height, hasAlpha: (buf[20] & 0x10) !== 0 };
    }
  }

  return null;
}

/**
 * WorkspaceAttachmentStore: official DSH AttachmentStore implementation for Enkeep.
 */
export class WorkspaceAttachmentStore extends AttachmentStore {
  readonly root: string;
  readonly imageLimits: ImageAttachmentLimits;
  private readonly memoryCache = new Map<string, Buffer>();

  constructor(ctx: Context, config?: WorkspaceAttachmentConfig) {
    super(ctx);
    const dshHome = config?.dshHome || process.env.DSH_HOME || path.join(process.cwd(), '.dsh');
    this.root = path.resolve(path.join(dshHome, 'attachments', 'v1'));

    this.imageLimits = Object.freeze({
      maxImageBytes: config?.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES,
      maxImagesPerMessage: config?.maxImagesPerMessage ?? DEFAULT_MAX_IMAGES_PER_MESSAGE,
      maxMessageImageBytes: config?.maxMessageImageBytes ?? DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
      maxImagePixels: config?.maxImagePixels ?? DEFAULT_MAX_IMAGE_PIXELS,
      maxImageDimension: config?.maxImageDimension ?? DEFAULT_MAX_IMAGE_DIMENSION,
      mediaTypes: Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const),
    });

    const objectsDir = path.join(this.root, 'objects');
    try {
      fs.mkdirSync(objectsDir, { recursive: true, mode: 0o700 });
    } catch (err: unknown) {
      throw new AttachmentError(
        `Failed to initialize attachment objects directory at "${objectsDir}": ${(err as Error)?.message ?? String(err)}`,
        'ATTACHMENT_WRITE_FAILED',
        { cause: err }
      );
    }
  }

  private inspectAndValidate(input: SaveImageAttachment): DetectedImageInfo {
    if (!input || !input.data || input.data.byteLength === 0) {
      throw new AttachmentError('Image is empty.', 'INVALID_IMAGE');
    }
    if (input.data.byteLength > this.imageLimits.maxImageBytes) {
      throw new AttachmentError(
        `Image size ${input.data.byteLength} exceeds maximum limit of ${this.imageLimits.maxImageBytes} bytes.`,
        'IMAGE_TOO_LARGE'
      );
    }
    if (!this.imageLimits.mediaTypes.includes(input.mediaType)) {
      throw new AttachmentError(
        `Image type ${input.mediaType} is not accepted by this deployment.`,
        'UNSUPPORTED_IMAGE_TYPE'
      );
    }

    const detected = detectImageInfo(input.data);
    if (!detected) {
      throw new AttachmentError('The bytes do not decode as a supported PNG/JPEG/WebP/GIF image.', 'INVALID_IMAGE');
    }
    if (detected.mediaType !== input.mediaType) {
      throw new AttachmentError(
        `Declared image type ${input.mediaType} does not match actual bytes (${detected.mediaType}).`,
        'IMAGE_TYPE_MISMATCH'
      );
    }
    if (
      detected.width > this.imageLimits.maxImageDimension ||
      detected.height > this.imageLimits.maxImageDimension
    ) {
      throw new AttachmentError(
        `Image dimension (${detected.width}x${detected.height}) exceeds limit of ${this.imageLimits.maxImageDimension}px.`,
        'IMAGE_DIMENSION_TOO_LARGE'
      );
    }
    if (detected.width * detected.height > this.imageLimits.maxImagePixels) {
      throw new AttachmentError(
        `Image pixels (${detected.width * detected.height}) exceed decoded-size limit of ${this.imageLimits.maxImagePixels}.`,
        'IMAGE_TOO_MANY_PIXELS'
      );
    }

    return detected;
  }

  async validateImage(input: SaveImageAttachment): Promise<void> {
    this.inspectAndValidate(input);
  }

  async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    const detected = this.inspectAndValidate(input);
    const sha256Hex = createHash('sha256').update(input.data).digest('hex').toLowerCase();
    const attachmentId = AttachmentId(`sha256:${sha256Hex}`);

    const buf = Buffer.isBuffer(input.data)
      ? input.data
      : Buffer.from(input.data.buffer, input.data.byteOffset, input.data.byteLength);

    const objDir = path.join(this.root, 'objects', sha256Hex.slice(0, 2));
    const objPath = path.join(objDir, sha256Hex);

    let needsWrite = true;
    if (fs.existsSync(objPath)) {
      try {
        const existingData = fs.readFileSync(objPath);
        if (existingData.byteLength === 0) {
          try { fs.unlinkSync(objPath); } catch {}
          throw new AttachmentError(`Existing attachment file is 0 bytes.`, 'ATTACHMENT_CORRUPT');
        }
        const existingSha = createHash('sha256').update(existingData).digest('hex').toLowerCase();
        if (existingSha === sha256Hex) {
          needsWrite = false;
        } else {
          try { fs.unlinkSync(objPath); } catch {}
          throw new AttachmentError(`Existing attachment file hash mismatch.`, 'ATTACHMENT_CORRUPT');
        }
      } catch (checkErr: unknown) {
        if (checkErr instanceof AttachmentError) throw checkErr;
        needsWrite = true;
      }
    }

    if (needsWrite) {
      try {
        fs.mkdirSync(objDir, { recursive: true, mode: 0o700 });
      } catch (mkdirErr: unknown) {
        this.memoryCache.delete(sha256Hex);
        throw new AttachmentError(
          `Failed to create directory "${objDir}": ${(mkdirErr as Error)?.message ?? String(mkdirErr)}`,
          'ATTACHMENT_WRITE_FAILED',
          { cause: mkdirErr }
        );
      }

      // Atomic write using temp file in objDir
      const tempPath = path.join(objDir, `.tmp-${sha256Hex}-${randomUUID()}`);
      try {
        fs.writeFileSync(tempPath, buf, { mode: 0o600 });
      } catch (writeErr: unknown) {
        this.memoryCache.delete(sha256Hex);
        try { fs.unlinkSync(tempPath); } catch {}
        throw new AttachmentError(
          `Failed to write attachment temp file "${tempPath}": ${(writeErr as Error)?.message ?? String(writeErr)}`,
          'ATTACHMENT_WRITE_FAILED',
          { cause: writeErr }
        );
      }

      // Verify temp file hash before rename
      try {
        const writtenBytes = fs.readFileSync(tempPath);
        const writtenSha = createHash('sha256').update(writtenBytes).digest('hex').toLowerCase();
        if (writtenSha !== sha256Hex) {
          try { fs.unlinkSync(tempPath); } catch {}
          this.memoryCache.delete(sha256Hex);
          throw new AttachmentError(
            `Attachment write hash verification mismatch: expected ${sha256Hex}, got ${writtenSha}`,
            'ATTACHMENT_CORRUPT'
          );
        }
      } catch (verifyErr: unknown) {
        this.memoryCache.delete(sha256Hex);
        try { fs.unlinkSync(tempPath); } catch {}
        if (verifyErr instanceof AttachmentError) throw verifyErr;
        throw new AttachmentError(
          `Failed to read back temp attachment file: ${(verifyErr as Error)?.message ?? String(verifyErr)}`,
          'ATTACHMENT_READ_FAILED',
          { cause: verifyErr }
        );
      }

      // Atomic rename to final path
      try {
        fs.renameSync(tempPath, objPath);
      } catch (renameErr: unknown) {
        this.memoryCache.delete(sha256Hex);
        try { fs.unlinkSync(tempPath); } catch {}
        throw new AttachmentError(
          `Failed to publish attachment object to "${objPath}": ${(renameErr as Error)?.message ?? String(renameErr)}`,
          'ATTACHMENT_WRITE_FAILED',
          { cause: renameErr }
        );
      }
    }

    // Final readback verification from target disk path before setting cache or returning
    try {
      const diskData = fs.readFileSync(objPath);
      const diskSha = createHash('sha256').update(diskData).digest('hex').toLowerCase();
      if (diskSha !== sha256Hex || diskData.byteLength === 0) {
        this.memoryCache.delete(sha256Hex);
        throw new AttachmentError(
          `Attachment disk persistence verification failed for "${objPath}"`,
          'ATTACHMENT_CORRUPT'
        );
      }
    } catch (readbackErr: unknown) {
      this.memoryCache.delete(sha256Hex);
      if (readbackErr instanceof AttachmentError) throw readbackErr;
      throw new AttachmentError(
        `Failed to verify attachment persistence from disk: ${(readbackErr as Error)?.message ?? String(readbackErr)}`,
        'ATTACHMENT_READ_FAILED',
        { cause: readbackErr }
      );
    }

    // ONLY after successful disk write & verified readback, commit to memory cache
    this.memoryCache.set(sha256Hex, buf);

    const ref: ImageAttachmentRef = {
      attachmentId,
      mediaType: detected.mediaType,
      bytes: input.data.byteLength,
      width: detected.width,
      height: detected.height,
      ...(input.name ? { name: input.name } : {}),
    };

    return ref;
  }

  async readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment> {
    signal?.throwIfAborted();
    const match = /^sha256:([a-f0-9]{64})$/.exec(String(ref.attachmentId));
    if (!match) {
      throw new AttachmentError('Attachment reference is invalid.', 'INVALID_ATTACHMENT_REF');
    }
    const sha256Hex = match[1];

    let buf = this.memoryCache.get(sha256Hex);
    if (!buf) {
      const objPath = path.join(this.root, 'objects', sha256Hex.slice(0, 2), sha256Hex);
      if (!fs.existsSync(objPath)) {
        throw new AttachmentError(`Attachment object ${ref.attachmentId} not found.`, 'ATTACHMENT_NOT_FOUND');
      }
      try {
        buf = fs.readFileSync(objPath);
      } catch (readErr: unknown) {
        throw new AttachmentError(
          `Failed to read attachment object ${ref.attachmentId}: ${(readErr as Error)?.message ?? String(readErr)}`,
          'ATTACHMENT_READ_FAILED',
          { cause: readErr }
        );
      }
    }

    if (buf.byteLength === 0) {
      this.memoryCache.delete(sha256Hex);
      throw new AttachmentError(`Attachment object ${ref.attachmentId} is empty.`, 'ATTACHMENT_CORRUPT');
    }

    const actualSha = createHash('sha256').update(buf).digest('hex').toLowerCase();
    if (actualSha !== sha256Hex) {
      this.memoryCache.delete(sha256Hex);
      throw new AttachmentError('Attachment integrity verification failed.', 'ATTACHMENT_CORRUPT');
    }

    this.memoryCache.set(sha256Hex, buf);

    return {
      ref,
      data: buf,
    };
  }

  override imageHostPath(ref: ImageAttachmentRef): string | undefined {
    const match = /^sha256:([a-f0-9]{64})$/.exec(String(ref.attachmentId));
    if (!match) return undefined;
    const sha256Hex = match[1];
    return path.join(this.root, 'objects', sha256Hex.slice(0, 2), sha256Hex);
  }

  override async readImageRequest(
    ref: ImageAttachmentRef,
    policy: ImageRequestPolicy,
    signal?: AbortSignal
  ): Promise<RequestImageAttachment> {
    signal?.throwIfAborted();
    const stored = await this.readImage(ref, signal);
    const variantId = ImageVariantId(`req:${String(ref.attachmentId)}:${policy.maxPixels}:${policy.maxBytes}`);
    return {
      variantId,
      attachment: ref,
      data: stored.data,
      mediaType: ref.mediaType,
      bytes: stored.data.byteLength,
      width: ref.width,
      height: ref.height,
      depth: 'uchar',
      space: 'srgb',
      hasAlpha: ref.mediaType === 'image/png' || ref.mediaType === 'image/webp',
    };
  }
}

export default WorkspaceAttachmentStore;
