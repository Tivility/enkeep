/**
 * WeChat iLink Novac2c CDN media encryption, decryption, and upload/download routines.
 *
 * @module @enkeep/channel-wechat/crypto
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  DownloadMediaOptions,
  DownloadMediaParams,
  GetUploadUrlParams,
  GetUploadUrlResult,
  UploadBufferToCdnParams,
  UploadBufferToCdnResult,
  UploadMediaBufferParams,
  UploadMediaFileParams,
  UploadMediaResult,
} from './crypto-types.js';

export * from './crypto-types.js';

export const DEFAULT_CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c';
export const DEFAULT_ILINK_BASE = 'https://ilinkai.weixin.qq.com';
export const ILINK_APP_ID = 'bot';
export const ILINK_APP_CLIENT_VERSION = '131329';
export const MAX_MEDIA_FILE_SIZE = 50 * 1024 * 1024; // 50MB

/**
 * Encrypt buffer with AES-128-ECB and PKCS7 padding.
 */
export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  if (key.length !== 16) {
    throw new Error(`AES-128-ECB key must be 16 bytes, received ${key.length}`);
  }
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/**
 * Decrypt buffer with AES-128-ECB and PKCS7 padding.
 */
export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  if (key.length !== 16) {
    throw new Error(`AES-128-ECB key must be 16 bytes, received ${key.length}`);
  }
  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
    throw new Error(
      `Invalid AES-128-ECB ciphertext length: ${ciphertext.length} (must be non-zero multiple of 16)`,
    );
  }
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Compute the AES-128-ECB PKCS7 padded size for a given plaintext size.
 * PKCS7 always adds at least 1 byte (up to block size 16) to reach the next 16-byte boundary.
 */
export function aesEcbPaddedSize(plaintextSize: number): number {
  if (plaintextSize < 0 || !Number.isFinite(plaintextSize)) {
    throw new Error(`Invalid plaintextSize: ${plaintextSize}`);
  }
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

/**
 * Build Novac2c CDN download URL.
 */
export function buildCdnDownloadUrl(
  encryptedQueryParam: string,
  cdnBaseUrl?: string,
): string {
  const base = (cdnBaseUrl || DEFAULT_CDN_BASE).replace(/\/+$/, '');
  return `${base}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

/**
 * Build Novac2c CDN upload URL.
 */
export function buildCdnUploadUrl(params: {
  cdnBaseUrl?: string;
  uploadParam: string;
  filekey: string;
}): string {
  const base = (params.cdnBaseUrl || DEFAULT_CDN_BASE).replace(/\/+$/, '');
  return `${base}/upload?encrypted_query_param=${encodeURIComponent(params.uploadParam)}&filekey=${encodeURIComponent(params.filekey)}`;
}

/**
 * Encode a 16-byte raw AES key into the canonical WeChat iLink wire format:
 * raw 16 bytes -> 32-char hex string -> ASCII bytes -> base64 (~44 chars).
 */
export function encodeAesKey(rawKey: Buffer): string {
  if (rawKey.length !== 16) {
    throw new Error(`Invalid raw AES key length: ${rawKey.length}, expected 16 bytes`);
  }
  const hexStr = rawKey.toString('hex');
  return Buffer.from(hexStr, 'utf-8').toString('base64');
}

/**
 * Parse aes_key from base64 string to 16-byte Buffer.
 *
 * Supports two formats:
 * 1. Canonical iLink format: base64(hex-string ASCII bytes): decoded is 32-byte hex string -> 16 bytes key.
 * 2. Fallback legacy format: decoded is directly raw 16 bytes.
 */
export function parseAesKey(aesKeyBase64: string): Buffer {
  if (!aesKeyBase64 || typeof aesKeyBase64 !== 'string') {
    throw new Error('AES key must be a non-empty base64 string');
  }
  const decoded = Buffer.from(aesKeyBase64, 'base64');

  // Canonical path: decoded is a 32-char hex string
  if (decoded.length === 32) {
    const hexStr = decoded.toString('utf-8');
    if (/^[0-9a-fA-F]{32}$/.test(hexStr)) {
      return Buffer.from(hexStr, 'hex');
    }
  }

  // Fallback path: decoded is directly 16 raw bytes
  if (decoded.length === 16) {
    return decoded;
  }

  throw new Error(
    `Invalid AES key length: decoded length ${decoded.length}, expected 16 or 32 bytes`,
  );
}

/**
 * Request pre-signed upload URL and parameter from iLink server.
 */
export async function getUploadUrl(
  params: GetUploadUrlParams,
): Promise<GetUploadUrlResult> {
  // Validate that filekey is strictly ASCII
  if (!/^[\x20-\x7E]+$/.test(params.filekey)) {
    throw new Error(`filekey must contain only ASCII characters: "${params.filekey}"`);
  }

  const url = `${params.baseUrl.replace(/\/+$/, '')}/ilink/bot/getuploadurl`;
  const body = {
    filekey: params.filekey,
    media_type: params.mediaType,
    to_user_id: params.toUserId,
    rawsize: params.rawsize,
    rawfilemd5: params.rawfilemd5,
    filesize: params.filesize,
    no_need_thumb: true,
    aeskey: params.aeskey,
    base_info: { channel_version: '1.0.0' },
  };

  const xWechatUin = crypto.randomBytes(4).toString('base64');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${params.token}`,
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': xWechatUin,
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': ILINK_APP_CLIENT_VERSION,
  };

  const fetchFn = params.fetchFn ?? globalThis.fetch;
  const signal = AbortSignal.timeout(params.timeoutMs ?? 15_000);
  const resp = await fetchFn(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(
      `getUploadUrl failed: ${resp.status} ${resp.statusText}${errText ? ` - ${errText}` : ''}`,
    );
  }

  const data = (await resp.json()) as Record<string, unknown>;
  if (typeof data.ret === 'number' && data.ret !== 0) {
    throw new Error(`getUploadUrl returned error ret=${data.ret}: ${JSON.stringify(data)}`);
  }
  if (typeof data.errcode === 'number' && data.errcode !== 0) {
    throw new Error(
      `getUploadUrl returned error errcode=${data.errcode}: ${JSON.stringify(data)}`,
    );
  }

  const uploadParam = data.upload_param as string | undefined;
  if (!uploadParam) {
    throw new Error(`getUploadUrl response missing upload_param: ${JSON.stringify(data)}`);
  }

  return { uploadParam };
}

/**
 * Upload encrypted buffer to Novac2c CDN with automatic retry.
 */
export async function uploadBufferToCdn(
  params: UploadBufferToCdnParams,
): Promise<UploadBufferToCdnResult> {
  const encrypted = encryptAesEcb(params.buf, params.aeskey);
  const url = buildCdnUploadUrl({
    cdnBaseUrl: params.cdnBaseUrl,
    uploadParam: params.uploadParam,
    filekey: params.filekey,
  });

  const fetchFn = params.fetchFn ?? globalThis.fetch;
  const maxRetries = params.maxRetries ?? 3;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const signal = AbortSignal.timeout(params.timeoutMs ?? 120_000);
      const resp = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: encrypted,
        signal,
      });

      if (!resp.ok) {
        throw new Error(`CDN upload failed: ${resp.status} ${resp.statusText}`);
      }

      const downloadParam = resp.headers.get('x-encrypted-param');
      if (!downloadParam) {
        throw new Error('CDN upload response missing x-encrypted-param header');
      }

      return { downloadParam };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries - 1) {
        const delay =
          params.retryDelayMs !== undefined
            ? params.retryDelayMs * (attempt + 1)
            : 1000 * (attempt + 1);
        if (delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
  }

  throw lastError ?? new Error(`CDN upload failed after ${maxRetries} retries`);
}

/**
 * Download encrypted media from Novac2c CDN and decrypt with AES-128-ECB.
 */
export async function downloadAndDecryptMedia(
  params: DownloadMediaParams,
): Promise<Buffer>;
export async function downloadAndDecryptMedia(
  encryptQueryParam: string,
  aesKeyBase64: string,
  options?: DownloadMediaOptions,
): Promise<Buffer>;
export async function downloadAndDecryptMedia(
  arg1: string | DownloadMediaParams,
  arg2?: string,
  arg3?: DownloadMediaOptions,
): Promise<Buffer> {
  const params: DownloadMediaParams =
    typeof arg1 === 'string'
      ? {
          encryptQueryParam: arg1,
          aesKeyBase64: arg2 ?? '',
          cdnBaseUrl: arg3?.cdnBaseUrl,
          fetchFn: arg3?.fetchFn,
          timeoutMs: arg3?.timeoutMs,
          maxFileSize: arg3?.maxFileSize,
        }
      : arg1;

  if (!params.encryptQueryParam) {
    throw new Error('encryptQueryParam is required for CDN download');
  }

  const url = buildCdnDownloadUrl(params.encryptQueryParam, params.cdnBaseUrl);
  const key = parseAesKey(params.aesKeyBase64);
  const maxFileSize = params.maxFileSize ?? MAX_MEDIA_FILE_SIZE;
  const timeoutMs = params.timeoutMs ?? 60_000;
  const fetchFn = params.fetchFn ?? globalThis.fetch;

  const resp = await fetchFn(url, {
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!resp.ok) {
    throw new Error(`CDN download failed: ${resp.status} ${resp.statusText}`);
  }

  const contentLengthHeader = resp.headers.get('content-length');
  if (contentLengthHeader) {
    const contentLength = parseInt(contentLengthHeader, 10);
    if (!Number.isNaN(contentLength) && contentLength > maxFileSize) {
      throw new Error(
        `CDN download payload exceeds maximum allowed size (${contentLength} > ${maxFileSize})`,
      );
    }
  }

  const arrayBuf = await resp.arrayBuffer();
  if (arrayBuf.byteLength > maxFileSize) {
    throw new Error(
      `CDN download payload exceeds maximum allowed size (${arrayBuf.byteLength} > ${maxFileSize})`,
    );
  }

  const ciphertext = Buffer.from(arrayBuf);
  return decryptAesEcb(ciphertext, key);
}

/**
 * End-to-end media buffer upload:
 * 1. Generate 16-byte random AES key and 32-char hex ASCII filekey
 * 2. Calculate MD5 hash and ciphertext padded size
 * 3. Request pre-signed upload URL from iLink server
 * 4. Encrypt with AES-128-ECB and upload to CDN
 * 5. Return upload result with canonical base64 AES key and download token
 */
export async function uploadMediaBuffer(
  params: UploadMediaBufferParams,
): Promise<UploadMediaResult> {
  const { buf } = params;
  const rawsize = buf.length;
  const rawfilemd5 = crypto.createHash('md5').update(buf).digest('hex');

  const aeskeyBuf = crypto.randomBytes(16);
  const aeskeyHex = aeskeyBuf.toString('hex');
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString('hex');

  const { uploadParam } = await getUploadUrl({
    baseUrl: params.baseUrl,
    token: params.token,
    filekey,
    mediaType: params.mediaType,
    toUserId: params.toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    aeskey: aeskeyHex,
    fetchFn: params.fetchFn,
    timeoutMs: params.timeoutMs,
  });

  const { downloadParam } = await uploadBufferToCdn({
    buf,
    uploadParam,
    filekey,
    cdnBaseUrl: params.cdnBaseUrl,
    aeskey: aeskeyBuf,
    fetchFn: params.fetchFn,
    timeoutMs: params.timeoutMs,
    maxRetries: params.maxRetries,
    retryDelayMs: params.retryDelayMs,
  });

  const aeskeyEncoded = encodeAesKey(aeskeyBuf);

  return {
    filekey,
    downloadEncryptedQueryParam: downloadParam,
    aeskey: aeskeyEncoded,
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  };
}

/**
 * Upload local file to Novac2c CDN via uploadMediaBuffer.
 */
export async function uploadMediaFile(
  params: UploadMediaFileParams,
): Promise<UploadMediaResult> {
  const buf = await fs.promises.readFile(params.filePath);
  return uploadMediaBuffer({
    buf,
    fileName: params.fileName ?? path.basename(params.filePath),
    toUserId: params.toUserId,
    baseUrl: params.baseUrl,
    token: params.token,
    cdnBaseUrl: params.cdnBaseUrl,
    mediaType: params.mediaType,
    fetchFn: params.fetchFn,
    timeoutMs: params.timeoutMs,
    maxRetries: params.maxRetries,
    retryDelayMs: params.retryDelayMs,
  });
}
