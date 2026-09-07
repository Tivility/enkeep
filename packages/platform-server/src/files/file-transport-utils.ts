/**
 * File Transport Utilities & Security Enforcements
 *
 * Implements strict, streaming file transport logic:
 * - MIME registry with magic-byte sniffing
 * - RFC 5987 / RFC 6266 filename sanitization and Content-Disposition header generation
 * - HTTP Range request parser
 * - Multipart filename NFC normalization and strict character validation
 * - Strict single-file atomicity limits (MAX_UPLOAD_FILES_COUNT = 1)
 * - ByteLimitTransform with streaming backpressure support
 * - Idempotency request hash computation
 *
 * @module @enkeep/platform-server/files/file-transport-utils
 */

import * as path from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import { createHash } from 'node:crypto';
import { ValidationError, PlatformError } from '@enkeep/platform-core';

export const MAX_UPLOAD_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MiB single file max
export const MAX_UPLOAD_TOTAL_BYTES = 50 * 1024 * 1024; // 50 MiB total request max
export const MAX_UPLOAD_FILES_COUNT = 1; // Strict single-file atomic upload per request

export const EXTENSION_MIME_MAP: Record<string, string> = {
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.xml': 'application/xml',
  '.csv': 'text/csv; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.cjs': 'application/javascript; charset=utf-8',
  '.ts': 'application/typescript; charset=utf-8',
  '.tsx': 'application/typescript; charset=utf-8',
  '.jsx': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.wasm': 'application/wasm',
};

/**
 * Sniffs MIME type from header magic bytes, falling back to extension registry and generic octet-stream.
 */
export function sniffMimeType(filename: string, magicHeader?: Buffer): string {
  if (magicHeader && magicHeader.length >= 4) {
    // PNG: 89 50 4E 47
    if (magicHeader[0] === 0x89 && magicHeader[1] === 0x50 && magicHeader[2] === 0x4e && magicHeader[3] === 0x47) {
      return 'image/png';
    }
    // JPEG: FF D8 FF
    if (magicHeader[0] === 0xff && magicHeader[1] === 0xd8 && magicHeader[2] === 0xff) {
      return 'image/jpeg';
    }
    // GIF: GIF87a or GIF89a
    if (magicHeader[0] === 0x47 && magicHeader[1] === 0x49 && magicHeader[2] === 0x46 && magicHeader[3] === 0x38) {
      return 'image/gif';
    }
    // PDF: %PDF
    if (magicHeader[0] === 0x25 && magicHeader[1] === 0x50 && magicHeader[2] === 0x44 && magicHeader[3] === 0x46) {
      return 'application/pdf';
    }
    // WebP: RIFF....WEBP
    if (
      magicHeader.length >= 12 &&
      magicHeader[0] === 0x52 && magicHeader[1] === 0x49 && magicHeader[2] === 0x46 && magicHeader[3] === 0x46 &&
      magicHeader[8] === 0x57 && magicHeader[9] === 0x45 && magicHeader[10] === 0x42 && magicHeader[11] === 0x50
    ) {
      return 'image/webp';
    }
    // ZIP / JAR / DOCX: PK\x03\x04
    if (magicHeader[0] === 0x50 && magicHeader[1] === 0x4b && magicHeader[2] === 0x03 && magicHeader[3] === 0x04) {
      return 'application/zip';
    }
  }

  const ext = path.extname(filename).toLowerCase();
  if (ext && EXTENSION_MIME_MAP[ext]) {
    return EXTENSION_MIME_MAP[ext];
  }

  return 'application/octet-stream';
}

/**
 * Builds RFC 5987 / RFC 6266 Content-Disposition header.
 */
export function buildContentDispositionHeader(filename: string, dispositionType: 'attachment' | 'inline' = 'attachment'): string {
  const sanitizedAscii = filename.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const encodedUtf8 = encodeURIComponent(filename).replace(/['()]/g, escape).replace(/\*/g, '%2A');
  return `${dispositionType}; filename="${sanitizedAscii}"; filename*=UTF-8''${encodedUtf8}`;
}

/**
 * Strictly sanitizes a multipart filename.
 * - Must be a valid string
 * - NFC normalized
 * - No path separators (/ or \)
 * - No control characters or null bytes
 * - Must not be '.' or '..'
 * - Max 255 characters
 */
export function sanitizeMultipartFilename(rawFilename: unknown): string {
  if (typeof rawFilename !== 'string' || !rawFilename.trim()) {
    throw new ValidationError('Uploaded file part must have a non-empty filename');
  }

  let filenameStr = rawFilename;
  // If latin1 encoded UTF-8 bytes were received from busboy, attempt conversion
  try {
    const asUtf8 = Buffer.from(filenameStr, 'latin1').toString('utf8');
    if (asUtf8 && asUtf8 !== filenameStr && !asUtf8.includes('\ufffd')) {
      filenameStr = asUtf8;
    }
  } catch {
    // Keep original
  }

  const normalized = filenameStr.normalize('NFC').trim();

  if (normalized.length === 0 || normalized.length > 255) {
    throw new ValidationError('Filename length must be between 1 and 255 characters');
  }

  if (normalized === '.' || normalized === '..') {
    throw new ValidationError('Filename cannot be "." or ".."');
  }

  if (normalized.includes('/') || normalized.includes('\\')) {
    throw new ValidationError('Filename cannot contain path separators');
  }

  if (normalized.includes('\0')) {
    throw new ValidationError('Filename cannot contain null bytes');
  }

  for (let i = 0; i < normalized.length; i++) {
    const code = normalized.charCodeAt(i);
    if (code <= 31 || code === 127) {
      throw new ValidationError('Filename cannot contain control characters');
    }
  }

  // Reject dangerous Windows reserved devices
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(normalized)) {
    throw new ValidationError('Filename contains reserved system device name');
  }

  return normalized;
}

/**
 * Parses HTTP Range header (`Range: bytes=start-end` or `Range: bytes=start-`).
 */
export function parseRangeHeader(
  rangeHeader: string | undefined,
  totalSize: number
): { start: number; end: number } | null {
  if (!rangeHeader || typeof rangeHeader !== 'string') {
    return null;
  }

  const match = /^bytes=(\d+)-(\d+)?$/i.exec(rangeHeader.trim());
  if (!match) {
    throw new ValidationError('Invalid Range header format');
  }

  const start = parseInt(match[1], 10);
  let end = match[2] !== undefined ? parseInt(match[2], 10) : totalSize - 1;

  if (isNaN(start) || isNaN(end) || start < 0 || start >= totalSize || end < start) {
    throw new ValidationError('Unsatisfiable Range header');
  }

  if (end >= totalSize) {
    end = totalSize - 1;
  }

  return { start, end };
}

/**
 * Stream Transform that enforces a strict byte limit and counts total bytes,
 * correctly respecting stream backpressure.
 */
export class ByteLimitTransform extends Transform {
  private bytesReceived = 0;
  private readonly maxBytes: number;

  constructor(maxBytes: number) {
    super();
    this.maxBytes = maxBytes;
  }

  get totalBytes(): number {
    return this.bytesReceived;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytesReceived += chunk.length;
    if (this.bytesReceived > this.maxBytes) {
      callback(new PlatformError(`Payload too large: exceeded ${this.maxBytes} bytes`, 'PAYLOAD_TOO_LARGE', 413));
      return;
    }
    this.push(chunk);
    callback();
  }
}

/**
 * Computes deterministic canonical request hash for file upload idempotency ledger.
 * Formulated strictly over tenant, space, destination path, overwrite parameters, and content SHA-256 hash.
 */
export function computeUploadRequestHash(params: {
  userId: string;
  spaceId: string;
  path: string;
  overwrite: boolean;
  expectedEtag?: string;
  contentSha256: string;
}): string {
  const payload = JSON.stringify({
    userId: params.userId,
    spaceId: params.spaceId,
    path: params.path,
    overwrite: params.overwrite,
    expectedEtag: params.expectedEtag ?? null,
    contentSha256: params.contentSha256.toLowerCase(),
  });
  return createHash('sha256').update(payload).digest('hex').toLowerCase();
}
