/**
 * Types and interfaces for WeChat iLink media cryptography and CDN transfer.
 *
 * @module @enkeep/channel-wechat/crypto-types
 */

export const WECHAT_MEDIA_TYPE_IMAGE = 1;
export const WECHAT_MEDIA_TYPE_VIDEO = 2;
export const WECHAT_MEDIA_TYPE_FILE = 3;
export const WECHAT_MEDIA_TYPE_VOICE = 4;

export type WeChatMediaType =
  | typeof WECHAT_MEDIA_TYPE_IMAGE
  | typeof WECHAT_MEDIA_TYPE_VIDEO
  | typeof WECHAT_MEDIA_TYPE_FILE
  | typeof WECHAT_MEDIA_TYPE_VOICE
  | number;

export interface GetUploadUrlParams {
  readonly baseUrl: string;
  readonly token: string;
  readonly filekey: string;
  readonly mediaType: WeChatMediaType;
  readonly toUserId: string;
  readonly rawsize: number;
  readonly rawfilemd5: string;
  readonly filesize: number;
  readonly aeskey: string; // 32-char hex string
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface GetUploadUrlResult {
  readonly uploadParam: string;
}

export interface UploadBufferToCdnParams {
  readonly buf: Buffer;
  readonly uploadParam: string;
  readonly filekey: string;
  readonly cdnBaseUrl?: string;
  readonly aeskey: Buffer; // 16-byte raw key
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly retryDelayMs?: number;
}

export interface UploadBufferToCdnResult {
  readonly downloadParam: string;
}

export interface UploadMediaResult {
  readonly filekey: string;
  readonly downloadEncryptedQueryParam: string;
  /**
   * AES key encoded as base64(hex-string ASCII bytes) — ~44 chars, uniform for all media types.
   */
  readonly aeskey: string;
  readonly fileSize: number;
  readonly fileSizeCiphertext: number;
}

export interface UploadMediaBufferParams {
  readonly buf: Buffer;
  readonly fileName?: string;
  readonly toUserId: string;
  readonly baseUrl: string;
  readonly token: string;
  readonly cdnBaseUrl?: string;
  readonly mediaType: WeChatMediaType;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly retryDelayMs?: number;
}

export interface UploadMediaFileParams {
  readonly filePath: string;
  readonly toUserId: string;
  readonly baseUrl: string;
  readonly token: string;
  readonly cdnBaseUrl?: string;
  readonly mediaType: WeChatMediaType;
  readonly fileName?: string;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly retryDelayMs?: number;
}

export interface DownloadMediaOptions {
  readonly cdnBaseUrl?: string;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxFileSize?: number;
}

export interface DownloadMediaParams extends DownloadMediaOptions {
  readonly encryptQueryParam: string;
  readonly aesKeyBase64: string;
}
