import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { PlatformError, ValidationError, TooManyRequestsError, type PlatformStorage } from '@enkeep/platform-core';

export const MIN_COOKIE_SECRET_LENGTH = 32;
export const MIN_CSRF_TOKEN_LENGTH = 32;

export interface ServerLimitsOptions {
  /** Maximum body size in bytes (default: 1 MB = 1048576 bytes) */
  maxBodySizeBytes?: number;
  /** Request timeout in milliseconds (default: 30000 ms) */
  requestTimeoutMs?: number;
  /** Maximum cookie header length in bytes (default: 4096 bytes) */
  maxCookieSizeBytes?: number;
  /** Maximum failed login attempts allowed within the window (default: 5 attempts) */
  maxFailedLogins?: number;
  /** Rate limit sliding window duration in seconds (default: 900 seconds = 15 minutes) */
  failedLoginWindowSeconds?: number;
}

export const DEFAULT_SERVER_LIMITS: Required<ServerLimitsOptions> = Object.freeze({
  maxBodySizeBytes: 1024 * 1024, // 1 MB
  requestTimeoutMs: 30_000,       // 30 seconds
  maxCookieSizeBytes: 4096,       // 4 KB
  maxFailedLogins: 5,
  failedLoginWindowSeconds: 900,  // 15 minutes
});

/**
 * Centralized HTTP Security Headers for all platform-server responses.
 */
export const DEFAULT_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'X-XSS-Protection': '1; mode=block',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=()',
});

/**
 * Standard cache prevention headers for sensitive dynamic API endpoints.
 */
export const API_CACHE_CONTROL_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  'Pragma': 'no-cache',
  'Expires': '0',
});

export class PayloadTooLargeError extends PlatformError {
  constructor(message = 'Request payload exceeds maximum allowed size') {
    super(message, 'PAYLOAD_TOO_LARGE', 413);
  }
}

export class CsrfViolationError extends PlatformError {
  constructor(message = 'CSRF validation failed: missing, invalid, or forged Origin/Host/CSRF token') {
    super(message, 'CSRF_VIOLATION', 403);
  }
}

export { TooManyRequestsError };

/**
 * Bounded per-IP + per-username sliding window rate limiter for failed logins.
 * Persistently falls back to querying `auth_audit_log` in storage across server restarts,
 * while maintaining an in-memory bounded LRU-style map (max 5,000 entries) for high-performance defense.
 */
export class FailedLoginRateLimiter {
  private readonly maxFailedLogins: number;
  private readonly windowSeconds: number;
  private readonly storage?: PlatformStorage;
  private readonly memoryCache = new Map<string, number[]>();
  private readonly maxCacheEntries = 5000;

  constructor(options: { maxFailedLogins?: number; windowSeconds?: number; storage?: PlatformStorage } = {}) {
    this.maxFailedLogins = options.maxFailedLogins ?? DEFAULT_SERVER_LIMITS.maxFailedLogins;
    this.windowSeconds = options.windowSeconds ?? DEFAULT_SERVER_LIMITS.failedLoginWindowSeconds;
    this.storage = options.storage;
  }

  private cleanKey(key: string, nowMs: number): number[] {
    const windowMs = this.windowSeconds * 1000;
    const timestamps = this.memoryCache.get(key) || [];
    const valid = timestamps.filter((t) => nowMs - t < windowMs);
    if (valid.length === 0) {
      this.memoryCache.delete(key);
    } else {
      this.memoryCache.set(key, valid);
    }
    return valid;
  }

  /**
   * Checks if login attempt for IP/username is rate-limited.
   * Throws TooManyRequestsError (429) if threshold is exceeded.
   * Throws PlatformError (503) if persistent audit storage fails (fails closed).
   */
  async checkLimit(username: string, ipAddress?: string): Promise<void> {
    const nowMs = Date.now();
    const cleanUser = (username || '').toLowerCase().trim();
    const cleanIp = (ipAddress || '127.0.0.1').trim();
    const pairKey = `pair:${cleanIp}:${cleanUser}`;
    const ipKey = `ip:${cleanIp}`;

    const pairFailures = this.cleanKey(pairKey, nowMs).length;
    const ipFailures = this.cleanKey(ipKey, nowMs).length;

    // Reject if 5 failures for this IP+username pair, or 50 global failures from this IP
    if (pairFailures >= this.maxFailedLogins || ipFailures >= this.maxFailedLogins * 10) {
      throw new TooManyRequestsError('Too many failed login attempts. Please try again later.');
    }

    // If storage has countRecentFailures, check persistent database records for this (IP + username) pair
    if (this.storage?.auditLogs?.countRecentFailures) {
      let dbCount: number;
      try {
        dbCount = await this.storage.auditLogs.countRecentFailures({
          username: cleanUser,
          ipAddress: cleanIp,
          windowSeconds: this.windowSeconds,
        });
      } catch (err) {
        if (err instanceof TooManyRequestsError) throw err;
        // Audit storage failures MUST fail closed
        throw new PlatformError(
          'Audit storage unavailable for rate limit verification',
          'SERVICE_UNAVAILABLE',
          503
        );
      }

      if (dbCount >= this.maxFailedLogins) {
        throw new TooManyRequestsError('Too many failed login attempts. Please try again later.');
      }
    }
  }

  /**
   * Records a failed login attempt for the given username and IP address.
   */
  recordFailure(username: string, ipAddress?: string): void {
    const nowMs = Date.now();
    const cleanUser = (username || '').toLowerCase().trim();
    const cleanIp = (ipAddress || '127.0.0.1').trim();
    const pairKey = `pair:${cleanIp}:${cleanUser}`;
    const ipKey = `ip:${cleanIp}`;

    // Bound memory map size by evicting oldest if exceeds limit
    if (this.memoryCache.size >= this.maxCacheEntries) {
      const firstKey = this.memoryCache.keys().next().value;
      if (firstKey) this.memoryCache.delete(firstKey);
    }

    const pairTimestamps = this.cleanKey(pairKey, nowMs);
    pairTimestamps.push(nowMs);
    this.memoryCache.set(pairKey, pairTimestamps);

    const ipTimestamps = this.cleanKey(ipKey, nowMs);
    ipTimestamps.push(nowMs);
    this.memoryCache.set(ipKey, ipTimestamps);
  }
}

/**
 * Constant-time comparison between two strings using fixed-length SHA-256 buffers
 * to eliminate timing differences based on string length.
 */
export function constantTimeCompare(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  const hashA = createHash('sha256').update(Buffer.from(a, 'utf-8')).digest();
  const hashB = createHash('sha256').update(Buffer.from(b, 'utf-8')).digest();
  return timingSafeEqual(hashA, hashB);
}

/**
 * Validates incoming request headers for size limits.
 */
export function validateRequestLimits(req: IncomingMessage, limits: ServerLimitsOptions = {}): void {
  const maxCookieBytes = limits.maxCookieSizeBytes ?? DEFAULT_SERVER_LIMITS.maxCookieSizeBytes;
  const cookieHeader = req.headers.cookie;

  if (cookieHeader && Buffer.byteLength(cookieHeader, 'utf-8') > maxCookieBytes) {
    throw new ValidationError('Cookie header exceeds maximum allowed length');
  }

  // Content-Length sanity check
  const contentLength = req.headers['content-length'];
  if (contentLength !== undefined && contentLength !== null) {
    if (typeof contentLength !== 'string' || !/^(?:0|[1-9]\d*)$/.test(contentLength.trim())) {
      throw new ValidationError('Invalid Content-Length header');
    }
    const parsedLength = Number(contentLength.trim());
    const maxBodyBytes = limits.maxBodySizeBytes ?? DEFAULT_SERVER_LIMITS.maxBodySizeBytes;
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > maxBodyBytes) {
      throw new PayloadTooLargeError(`Request payload size ${parsedLength} bytes exceeds limit of ${maxBodyBytes} bytes`);
    }
  }
}

export interface CsrfValidationOptions {
  /** Configured server CSRF token for constant-time matching (REQUIRED, non-optional) */
  csrfToken: string;
}

/**
 * Validates that a host header string is strictly a loopback address with mandatory expected port.
 * Format: exact 127.0.0.1:${expectedPort}.
 */
export function isLoopbackHost(host: string, expectedPort: number): boolean {
  if (typeof host !== 'string' || typeof expectedPort !== 'number' || !Number.isInteger(expectedPort) || expectedPort < 1 || expectedPort > 65535) {
    return false;
  }
  if (
    Array.isArray(host) ||
    host.includes(',') ||
    /\s/.test(host) ||
    host.includes('@') ||
    host.includes('/') ||
    host.includes('\\') ||
    host.startsWith('http:') ||
    host.startsWith('https:') ||
    host.endsWith('.')
  ) {
    return false;
  }
  const expectedHost = `127.0.0.1:${expectedPort}`;
  return host === expectedHost;
}

/**
 * Checks if a Host header is strictly allowed (loopback 127.0.0.1 with mandatory expected port).
 */
export function isAllowedHost(host: string, expectedPort: number): boolean {
  return isLoopbackHost(host, expectedPort);
}

/**
 * Validates the request socket authority and Host header immediately before any URL construction or routing.
 * - req.socket.localAddress must be exact string '127.0.0.1' only (rejects ::1, ::ffff:127.0.0.1, etc.).
 * - req.socket.localPort must be mandatory integer 1..65535.
 * - Host header must be single scalar exact '127.0.0.1:${localPort}'.
 * - Rejects comma, whitespace, userinfo, scheme, trailing dot, leading zeros, localhost, or port mismatch.
 */
export function validateHost(req: IncomingMessage): void {
  const socket = req.socket;
  if (!socket || typeof socket !== 'object') {
    throw new CsrfViolationError('Forbidden socket authority');
  }

  const localAddress = socket.localAddress;
  if (localAddress !== '127.0.0.1') {
    throw new CsrfViolationError('Forbidden socket authority');
  }

  const localPort = socket.localPort;
  if (typeof localPort !== 'number' || !Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
    throw new CsrfViolationError('Invalid socket port');
  }

  const hostHeader = req.headers.host;
  if (!hostHeader || typeof hostHeader !== 'string' || hostHeader.trim().length === 0) {
    throw new CsrfViolationError('Missing or empty Host header');
  }

  // Reject array, comma, whitespace, userinfo, scheme, trailing dot, leading zeros
  if (
    Array.isArray(hostHeader) ||
    hostHeader.includes(',') ||
    /\s/.test(hostHeader) ||
    hostHeader.includes('@') ||
    hostHeader.includes('/') ||
    hostHeader.includes('\\') ||
    hostHeader.startsWith('http:') ||
    hostHeader.startsWith('https:') ||
    hostHeader.endsWith('.')
  ) {
    throw new CsrfViolationError('Forbidden or untrusted Host header');
  }

  const expectedHost = `127.0.0.1:${localPort}`;
  if (hostHeader !== expectedHost) {
    throw new CsrfViolationError('Forbidden or untrusted Host header');
  }
}

/**
 * Verifies that requests satisfy:
 * - Immediate socket authority and Host header validation.
 * - Safe methods (GET, HEAD, OPTIONS): No CSRF token required. Origin header if present must exactly match http://127.0.0.1:${localPort}.
 * - Unsafe methods (POST, PUT, PATCH, DELETE): Require BOTH:
 *   1. Constant-time timing-safe matching of single scalar CSRF token (X-Enkeep-CSRF).
 *   2. Exact single scalar Origin header matching http://127.0.0.1:${localPort} (no HTTPS, no Referer substitute, no originless).
 *   Rejects duplicate or comma-separated Origin and token headers, and rejects aliases (e.g. x-csrf-token).
 */
export function validateCsrf(req: IncomingMessage, options: CsrfValidationOptions): void {
  // 1. Mandatory Host and Socket Authority validation
  validateHost(req);

  const socket = req.socket;
  const expectedOrigin = `http://127.0.0.1:${socket.localPort}`;
  const method = (req.method || 'GET').toUpperCase();

  // 2. Safe read-only HTTP methods do not modify server state
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    const originHeader = req.headers.origin;
    if (originHeader !== undefined && originHeader !== null) {
      if (Array.isArray(originHeader) || typeof originHeader !== 'string' || originHeader.includes(',') || originHeader.trim().length === 0) {
        throw new CsrfViolationError('Forbidden or untrusted Origin header');
      }
      if (originHeader !== expectedOrigin) {
        throw new CsrfViolationError('Forbidden or untrusted Origin header');
      }
    }
    return;
  }

  // 3. Unsafe state-modifying HTTP methods (POST, PUT, PATCH, DELETE)
  if (!options || !options.csrfToken || typeof options.csrfToken !== 'string' || options.csrfToken.length < MIN_CSRF_TOKEN_LENGTH) {
    throw new CsrfViolationError('Server CSRF configuration error: missing or invalid csrfToken');
  }

  // Reject alias or conflicting CSRF token headers
  if (req.headers['x-csrf-token'] !== undefined) {
    throw new CsrfViolationError('Duplicate or conflicting CSRF token headers');
  }

  const rawToken = req.headers['x-enkeep-csrf'];
  if (Array.isArray(rawToken)) {
    throw new CsrfViolationError('Duplicate or conflicting CSRF token headers');
  }

  if (!rawToken || typeof rawToken !== 'string' || rawToken.trim().length === 0 || rawToken.includes(',')) {
    throw new CsrfViolationError('Missing or empty X-Enkeep-CSRF token header for state-changing request');
  }

  if (!constantTimeCompare(rawToken.trim(), options.csrfToken)) {
    throw new CsrfViolationError('Missing or invalid X-Enkeep-CSRF token');
  }

  // Mandatory exact Origin header check (NO HTTPS, NO Referer substitute, NO configured origin, NO originless)
  const rawOrigin = req.headers.origin;
  if (rawOrigin === undefined || rawOrigin === null) {
    throw new CsrfViolationError('Missing Origin header for state-changing request');
  }

  if (Array.isArray(rawOrigin) || typeof rawOrigin !== 'string' || rawOrigin.trim().length === 0 || rawOrigin.includes(',')) {
    throw new CsrfViolationError('Forbidden or untrusted Origin header');
  }

  if (rawOrigin !== expectedOrigin) {
    throw new CsrfViolationError('Forbidden or untrusted Origin header');
  }
}

/**
 * Strict bounds for identifiers, message payloads, and attachments.
 */
export const RESOURCE_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;
export const MAX_MESSAGE_CONTENT_LENGTH = 65536; // 64 KiB
export const MAX_ATTACHMENTS_COUNT = 10;
export const MAX_ATTACHMENT_SIZE_BYTES = 524288; // 512 KiB

/**
 * Validates and sanitizes captured URL path parameter identifiers (spaceId, sessionId, turnId, etc.).
 * - URL pathname preserves percent-encoding.
 * - Decodes percent-encoded components once.
 * - Rejects if decoded includes '%', '/', '\\', dot segments ('.', '..'), or control characters.
 * - Enforces length 1..128 and strictly matches [A-Za-z0-9_-].
 */
export function validatePathId(rawParam: unknown, paramName = 'identifier'): string {
  if (typeof rawParam !== 'string' || rawParam.trim().length === 0) {
    throw new ValidationError(`Missing or empty ${paramName}`);
  }

  const trimmed = rawParam.trim();

  let decoded: string;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    throw new ValidationError(`Malformed percent-encoded ${paramName}`);
  }

  // Reject double percent-encoding
  if (decoded.includes('%')) {
    throw new ValidationError(`Invalid ${paramName}: double percent-encoding detected`);
  }

  // Reject path traversal / dot segments
  if (decoded === '.' || decoded === '..' || decoded.includes('..') || decoded.startsWith('.')) {
    throw new ValidationError(`Invalid ${paramName}: dot segments and path traversal are forbidden`);
  }

  // Reject slashes or backslashes
  if (decoded.includes('/') || decoded.includes('\\')) {
    throw new ValidationError(`Invalid ${paramName}: slashes and backslashes are forbidden`);
  }

  // Reject control characters (0x00 - 0x1f, 0x7f)
  if (/[\x00-\x1f\x7f]/.test(decoded)) {
    throw new ValidationError(`Invalid ${paramName}: control characters are forbidden`);
  }

  if (decoded.length < 1 || decoded.length > 128) {
    throw new ValidationError(`Invalid ${paramName} length (${decoded.length}). Expected 1 to 128 characters.`);
  }

  if (!RESOURCE_ID_REGEX.test(decoded)) {
    throw new ValidationError(`Invalid ${paramName} format "${decoded}". Must match [A-Za-z0-9_-]{1,128}.`);
  }

  return decoded;
}

/**
 * Validates message text content (must be string, <= 64 KiB, non-empty when trimmed).
 */
export function validateMessageContent(content: unknown): string {
  if (content === undefined || content === null) {
    throw new ValidationError('Message content is required');
  }

  if (typeof content !== 'string') {
    throw new ValidationError('Message content must be a string');
  }

  if (content.length > MAX_MESSAGE_CONTENT_LENGTH) {
    throw new ValidationError(
      `Message content length (${content.length} characters) exceeds maximum allowed length of ${MAX_MESSAGE_CONTENT_LENGTH} characters`
    );
  }

  if (content.trim().length === 0) {
    throw new ValidationError('Message content cannot be empty or whitespace only');
  }

  return content;
}

export interface ValidatedAttachment {
  path: string;
  etag: string;
  mimeType?: string;
  displayName?: string;
  [key: string]: unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const ETAG_LOWERCASE_SHA256_REGEX = /^"[0-9a-f]{64}"$/;

/**
 * Validates attachments array:
 * - Maximum 10 attachments
 * - Path: canonical relative path within current space
 * - ETag: required exact quoted lowercase 64-hex SHA-256 string
 * - Display name: optional string <= 255 chars, NFC normalized
 * - MIME type: optional string (server is authoritative)
 */
export function validateAttachments(attachments: unknown): ValidatedAttachment[] | undefined {
  if (attachments === undefined || attachments === null) {
    return undefined;
  }

  if (!Array.isArray(attachments)) {
    throw new ValidationError('Attachments must be an array');
  }

  if (attachments.length > MAX_ATTACHMENTS_COUNT) {
    throw new ValidationError(
      `Attachment count (${attachments.length}) exceeds limit of ${MAX_ATTACHMENTS_COUNT} attachments`
    );
  }

  const validated: ValidatedAttachment[] = [];

  for (let i = 0; i < attachments.length; i++) {
    const item = attachments[i];
    if (!isRecord(item)) {
      throw new ValidationError(`Attachment ${i} must be an object`);
    }

    const allowedAttachmentKeys = new Set(['path', 'etag', 'mimeType', 'displayName']);
    for (const k of Object.keys(item)) {
      if (!allowedAttachmentKeys.has(k)) {
        throw new ValidationError(`Attachment ${i} contains unexpected field "${k}"`);
      }
    }

    const { path: rawPath, etag: rawEtag, mimeType: rawMime, displayName: rawDisplayName } = item;

    if (typeof rawPath !== 'string' || !rawPath) {
      throw new ValidationError(`Attachment ${i} requires a non-empty string path`);
    }

    if (rawPath !== rawPath.trim()) {
      throw new ValidationError(`Attachment ${i} path must not contain leading or trailing whitespace`);
    }

    if (rawPath.normalize('NFC') !== rawPath) {
      throw new ValidationError(`Attachment ${i} path must be in Unicode NFC normalized form`);
    }

    if (rawPath.startsWith('/') || rawPath.startsWith('\\') || rawPath.includes('..') || rawPath.includes('\0')) {
      throw new ValidationError(`Attachment ${i} path must be canonical relative path within current space`);
    }

    if (typeof rawEtag !== 'string' || !ETAG_LOWERCASE_SHA256_REGEX.test(rawEtag)) {
      throw new ValidationError(
        `Attachment ${i} requires exact quoted lowercase 64-hex SHA-256 etag (e.g. \\"[0-9a-f]{64}\\")`
      );
    }

    let cleanDisplayName: string | undefined;
    if (rawDisplayName !== undefined) {
      if (typeof rawDisplayName !== 'string') {
        throw new ValidationError(`Attachment ${i} displayName must be a string`);
      }
      if (rawDisplayName !== rawDisplayName.trim()) {
        throw new ValidationError(`Attachment ${i} displayName must not contain leading or trailing whitespace`);
      }
      if (rawDisplayName.normalize('NFC') !== rawDisplayName) {
        throw new ValidationError(`Attachment ${i} displayName must be in Unicode NFC normalized form`);
      }
      if (rawDisplayName.length > 255) {
        throw new ValidationError(`Attachment ${i} displayName exceeds 255 characters`);
      }
      cleanDisplayName = rawDisplayName;
    }

    let cleanMime: string | undefined;
    if (rawMime !== undefined) {
      if (typeof rawMime !== 'string') {
        throw new ValidationError(`Attachment ${i} mimeType must be a string`);
      }
      cleanMime = rawMime.trim();
    }

    validated.push({
      path: rawPath,
      etag: rawEtag,
      ...(cleanMime ? { mimeType: cleanMime } : {}),
      ...(cleanDisplayName ? { displayName: cleanDisplayName } : {}),
    });
  }

  return validated;
}
