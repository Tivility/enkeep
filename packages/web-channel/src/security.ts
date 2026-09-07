import { createHmac, createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * Strictly permitted host binding for Web Channel.
 * Only 127.0.0.1 is permitted (rejects 0.0.0.0, ::, ::1, localhost, 192.168.x.x, etc.).
 */
export const PERMITTED_BIND_HOST = '127.0.0.1';

/**
 * Default maximum allowable request body size (1 MB).
 */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024; // 1 MB

/**
 * Standard HTTP Security & Anti-Caching Headers applied to Web Channel responses.
 */
export const DEFAULT_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=()',
});

/**
 * Cache-control headers for sensitive dynamic API endpoints.
 */
export const API_CACHE_CONTROL_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  'Pragma': 'no-cache',
  'Expires': '0',
});

/**
 * Generic security violation reason constants to avoid reflecting hostile headers or attacker payloads.
 */
export const SECURITY_REASONS = Object.freeze({
  FORBIDDEN_SOCKET_AUTHORITY: 'Forbidden socket authority',
  INVALID_SOCKET_PORT: 'Invalid socket local port',
  INVALID_OR_FORBIDDEN_HOST: 'Forbidden or untrusted Host header',
  MISSING_HOST: 'Missing or empty Host header',
  UNSUPPORTED_METHOD: 'Unsupported HTTP method',
  SEC_FETCH_SITE_REJECTED: 'Sec-Fetch-Site cross-site rejected',
  CONFLICTING_CSRF_HEADERS: 'Duplicate or conflicting CSRF token headers',
  MISSING_CSRF_HEADER: 'Missing or empty X-Enkeep-CSRF token header for state-changing request',
  INVALID_CSRF_TOKEN: 'Invalid or forged X-Enkeep-CSRF token value',
  MISSING_ORIGIN: 'Missing Origin header for state-changing request',
  INVALID_ORIGIN: 'Forbidden or untrusted Origin header',
  INVALID_CONTENT_LENGTH: 'Invalid Content-Length header',
} as const);

/**
 * Options for generating session cookies.
 */
export interface CookieOptions {
  cookieName?: string;
  cookiePath?: string;
  cookieSecure?: boolean;
  cookieSameSite?: 'Strict' | 'Lax';
  maxAgeSeconds?: number;
}

const COOKIE_NAME_REGEX = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN_VALUE_REGEX = /^[A-Za-z0-9._~-]{1,1024}$/;
const MIN_SECRET_LENGTH = 16;
const MAX_COOKIE_HEADER_LENGTH = 4096;

/**
 * Generates a random cryptographic secret/token of specified byte length.
 */
export function generateCryptoSecret(byteLength = 32): string {
  return randomBytes(byteLength).toString('hex');
}

/**
 * Constant-time comparison of two string tokens using SHA-256 digests
 * to eliminate timing attacks based on length differences.
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
 * Signs a value using HMAC-SHA256.
 * Format: `s:${value}.${signature}`
 */
export function signCookieValue(value: string, secret: string): string {
  if (!value || typeof value !== 'string' || !TOKEN_VALUE_REGEX.test(value)) {
    throw new TypeError('Value to sign must be a valid non-empty string');
  }
  if (!secret || typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
    throw new TypeError(`Signing secret must be a non-empty string of at least ${MIN_SECRET_LENGTH} characters`);
  }

  const hmac = createHmac('sha256', secret);
  hmac.update(value);
  const signature = hmac.digest('base64url');
  return `s:${value}.${signature}`;
}

/**
 * Verifies and unsigns a signed cookie value. Returns null if invalid, tampered, or malformed.
 */
export function unsignCookieValue(signedValue: string, secret: string): string | null {
  if (
    !signedValue ||
    typeof signedValue !== 'string' ||
    signedValue.length > 2048 ||
    !signedValue.startsWith('s:') ||
    !secret ||
    typeof secret !== 'string' ||
    secret.length < MIN_SECRET_LENGTH
  ) {
    return null;
  }

  const withoutPrefix = signedValue.slice(2);
  const lastDotIdx = withoutPrefix.lastIndexOf('.');
  if (lastDotIdx === -1) {
    return null;
  }

  const rawValue = withoutPrefix.slice(0, lastDotIdx);
  const receivedSig = withoutPrefix.slice(lastDotIdx + 1);

  if (!TOKEN_VALUE_REGEX.test(rawValue) || receivedSig.length === 0) {
    return null;
  }

  const hmac = createHmac('sha256', secret);
  hmac.update(rawValue);
  const expectedSig = hmac.digest('base64url');

  try {
    const receivedBuf = Buffer.from(receivedSig, 'utf-8');
    const expectedBuf = Buffer.from(expectedSig, 'utf-8');

    if (receivedBuf.length !== expectedBuf.length || receivedBuf.length !== 43) {
      return null;
    }

    if (!timingSafeEqual(receivedBuf, expectedBuf)) {
      return null;
    }

    return rawValue;
  } catch {
    return null;
  }
}

/**
 * Builds a Set-Cookie header with HMAC signing and strict security flags.
 */
export function createSignedSessionCookie(
  token: string,
  secret: string,
  options: CookieOptions = {}
): string {
  const cookieName = options.cookieName ?? 'enkeep_session';
  if (!COOKIE_NAME_REGEX.test(cookieName)) {
    throw new TypeError(`Invalid cookieName: "${cookieName}"`);
  }

  const cookiePath = options.cookiePath ?? '/';
  if (!cookiePath.startsWith('/')) {
    throw new TypeError(`Invalid cookiePath: "${cookiePath}". Must start with "/".`);
  }

  const sameSite = options.cookieSameSite ?? 'Strict';
  if (sameSite !== 'Strict' && sameSite !== 'Lax') {
    throw new TypeError(`Invalid cookieSameSite: "${sameSite}". Must be "Strict" or "Lax".`);
  }

  if (options.maxAgeSeconds !== undefined) {
    if (!Number.isInteger(options.maxAgeSeconds) || options.maxAgeSeconds < 0) {
      throw new TypeError(`Invalid maxAgeSeconds: must be a non-negative integer`);
    }
  }

  const secure = options.cookieSecure ? '; Secure' : '';
  const maxAge = options.maxAgeSeconds !== undefined ? `; Max-Age=${options.maxAgeSeconds}` : '';

  const signedVal = signCookieValue(token, secret);
  return `${cookieName}=${encodeURIComponent(signedVal)}; Path=${cookiePath}; HttpOnly; SameSite=${sameSite}${secure}${maxAge}`;
}

/**
 * Extracts and verifies the signed token from the request Cookie header.
 * Strictly requires exact configured name (no aliases like 'session'),
 * rejects duplicate cookie names, safely handles malformed percent encoding without throwing,
 * and bounds cookie header length.
 */
export function parseSignedSessionCookie(
  cookieHeader: string | undefined | null,
  cookieName: string,
  secret: string
): string | null {
  if (
    !cookieHeader ||
    typeof cookieHeader !== 'string' ||
    cookieHeader.length > MAX_COOKIE_HEADER_LENGTH ||
    !cookieName ||
    typeof cookieName !== 'string' ||
    !COOKIE_NAME_REGEX.test(cookieName) ||
    !secret ||
    typeof secret !== 'string' ||
    secret.length < MIN_SECRET_LENGTH
  ) {
    return null;
  }

  let foundRawValue: string | null = null;
  const cookies = cookieHeader.split(';');

  for (const c of cookies) {
    const trimmed = c.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;

    const name = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();

    if (name === cookieName) {
      if (foundRawValue !== null) {
        // Strict rejection: duplicate cookie with same name
        return null;
      }
      foundRawValue = val;
    }
  }

  if (foundRawValue === null || foundRawValue.length === 0 || foundRawValue.length > 2048) {
    return null;
  }

  // Safe decodeURIComponent handling without throwing
  let decoded: string;
  try {
    decoded = decodeURIComponent(foundRawValue);
  } catch {
    return null;
  }

  return unsignCookieValue(decoded, secret);
}

/**
 * Validates that a host header string is strictly a loopback address with mandatory expected port.
 * Format: exact `127.0.0.1:${expectedPort}`.
 */
export function isLoopbackHost(host: string, expectedPort: number): boolean {
  if (
    typeof host !== 'string' ||
    typeof expectedPort !== 'number' ||
    !Number.isInteger(expectedPort) ||
    expectedPort < 1 ||
    expectedPort > 65535
  ) {
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

export interface OriginValidationOptions {
  csrfToken: string;
}

const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const UNSAFE_HTTP_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Validates socket authority, Host header, and CSRF/Origin:
 * - req.socket.localAddress must be exact string '127.0.0.1' only.
 * - req.socket.localPort must be mandatory integer 1..65535.
 * - Host header must be single scalar exact '127.0.0.1:${localPort}'.
 * - Safe methods (GET, HEAD, OPTIONS): Origin if present must be exact http://127.0.0.1:${localPort}.
 * - Unsafe methods (POST, PUT, PATCH, DELETE): Require BOTH exact CSRF token and exact Origin header http://127.0.0.1:${localPort}.
 * - Rejects unknown or non-standard HTTP methods.
 * - Rejects x-csrf-token alias header.
 * - Uses generic constant reason strings without reflecting hostile values.
 */
export function validateOrigin(
  req: IncomingMessage,
  options: OriginValidationOptions
): { allowed: boolean; reason?: string } {
  // 1. Socket Authority check
  const socket = req.socket;
  if (!socket || typeof socket !== 'object') {
    return {
      allowed: false,
      reason: SECURITY_REASONS.FORBIDDEN_SOCKET_AUTHORITY,
    };
  }

  const localAddress = socket.localAddress;
  if (localAddress !== '127.0.0.1') {
    return {
      allowed: false,
      reason: SECURITY_REASONS.FORBIDDEN_SOCKET_AUTHORITY,
    };
  }

  const localPort = socket.localPort;
  if (typeof localPort !== 'number' || !Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
    return {
      allowed: false,
      reason: SECURITY_REASONS.INVALID_SOCKET_PORT,
    };
  }

  // 2. Host header check
  const hostHeader = req.headers.host;
  if (!hostHeader || typeof hostHeader !== 'string' || hostHeader.trim().length === 0) {
    return {
      allowed: false,
      reason: SECURITY_REASONS.MISSING_HOST,
    };
  }

  if (!isLoopbackHost(hostHeader, localPort)) {
    return {
      allowed: false,
      reason: SECURITY_REASONS.INVALID_OR_FORBIDDEN_HOST,
    };
  }

  // 3. Content-Length validation if header is present
  const rawContentLength = req.headers['content-length'];
  if (rawContentLength !== undefined) {
    if (
      Array.isArray(rawContentLength) ||
      typeof rawContentLength !== 'string' ||
      !/^(0|[1-9][0-9]*)$/.test(rawContentLength.trim())
    ) {
      return {
        allowed: false,
        reason: SECURITY_REASONS.INVALID_CONTENT_LENGTH,
      };
    }
  }

  const method = (req.method || 'GET').toUpperCase();

  // 4. Validate standard HTTP method
  if (!SAFE_HTTP_METHODS.has(method) && !UNSAFE_HTTP_METHODS.has(method)) {
    return {
      allowed: false,
      reason: SECURITY_REASONS.UNSUPPORTED_METHOD,
    };
  }

  const expectedOrigin = `http://127.0.0.1:${localPort}`;

  // 5. Safe read-only HTTP methods (GET, HEAD, OPTIONS)
  if (SAFE_HTTP_METHODS.has(method)) {
    const originHeader = req.headers.origin;
    if (originHeader !== undefined && originHeader !== null) {
      if (Array.isArray(originHeader) || typeof originHeader !== 'string' || originHeader.includes(',')) {
        return {
          allowed: false,
          reason: SECURITY_REASONS.INVALID_ORIGIN,
        };
      }
      if (originHeader !== expectedOrigin) {
        return {
          allowed: false,
          reason: SECURITY_REASONS.INVALID_ORIGIN,
        };
      }
    }
    return { allowed: true };
  }

  // 6. Unsafe state-changing HTTP methods (POST, PUT, PATCH, DELETE)
  // Sec-Fetch-Site check
  const secFetchSite = req.headers['sec-fetch-site'];
  if (typeof secFetchSite === 'string' && secFetchSite === 'cross-site') {
    return {
      allowed: false,
      reason: SECURITY_REASONS.SEC_FETCH_SITE_REJECTED,
    };
  }

  // Reject alias or conflicting CSRF token header
  if (req.headers['x-csrf-token'] !== undefined) {
    return {
      allowed: false,
      reason: SECURITY_REASONS.CONFLICTING_CSRF_HEADERS,
    };
  }

  const csrfHeader = req.headers['x-enkeep-csrf'];
  if (Array.isArray(csrfHeader)) {
    return {
      allowed: false,
      reason: SECURITY_REASONS.CONFLICTING_CSRF_HEADERS,
    };
  }

  if (
    !csrfHeader ||
    typeof csrfHeader !== 'string' ||
    csrfHeader.trim().length === 0 ||
    csrfHeader.includes(',')
  ) {
    return {
      allowed: false,
      reason: SECURITY_REASONS.MISSING_CSRF_HEADER,
    };
  }

  if (
    !options ||
    !options.csrfToken ||
    typeof options.csrfToken !== 'string' ||
    !constantTimeCompare(csrfHeader.trim(), options.csrfToken)
  ) {
    return {
      allowed: false,
      reason: SECURITY_REASONS.INVALID_CSRF_TOKEN,
    };
  }

  // Mandatory exact Origin header check for unsafe methods
  const rawOrigin = req.headers.origin;
  if (rawOrigin === undefined || rawOrigin === null) {
    return {
      allowed: false,
      reason: SECURITY_REASONS.MISSING_ORIGIN,
    };
  }

  if (
    Array.isArray(rawOrigin) ||
    typeof rawOrigin !== 'string' ||
    rawOrigin.trim().length === 0 ||
    rawOrigin.includes(',')
  ) {
    return {
      allowed: false,
      reason: SECURITY_REASONS.INVALID_ORIGIN,
    };
  }

  if (rawOrigin !== expectedOrigin) {
    return {
      allowed: false,
      reason: SECURITY_REASONS.INVALID_ORIGIN,
    };
  }

  return { allowed: true };
}

/**
 * Strict bounds for identifiers, message payloads, and attachments.
 */
export const RESOURCE_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;
export const MAX_MESSAGE_CONTENT_LENGTH = 65536; // 64 KiB
export const MAX_ATTACHMENTS_COUNT = 10;
export const MAX_ATTACHMENT_SIZE_BYTES = 524288; // 512 KiB
export const TOTAL_ATTACHMENTS_MAX_BYTES = MAX_ATTACHMENTS_COUNT * MAX_ATTACHMENT_SIZE_BYTES;

/**
 * Validates and sanitizes captured URL path parameter identifiers (spaceId, sessionId, turnId, etc.).
 * - URL pathname preserves percent-encoding.
 * - Decodes percent-encoded components once.
 * - Rejects if decoded includes '%', '/', '\\', dot segments ('.', '..'), or control characters.
 * - Enforces length 1..128 and strictly matches [A-Za-z0-9_-].
 */
export function validatePathId(rawParam: unknown, paramName = 'identifier'): { valid: boolean; value?: string; error?: string } {
  if (typeof rawParam !== 'string' || rawParam.trim().length === 0) {
    return { valid: false, error: `Missing or empty ${paramName}` };
  }

  const trimmed = rawParam.trim();

  let decoded: string;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    return { valid: false, error: `Malformed percent-encoded ${paramName}` };
  }

  // Reject double percent-encoding
  if (decoded.includes('%')) {
    return { valid: false, error: `Invalid ${paramName}: double percent-encoding detected` };
  }

  // Reject path traversal / dot segments
  if (decoded === '.' || decoded === '..' || decoded.includes('..') || decoded.startsWith('.')) {
    return { valid: false, error: `Invalid ${paramName}: dot segments and path traversal are forbidden` };
  }

  // Reject slashes or backslashes
  if (decoded.includes('/') || decoded.includes('\\')) {
    return { valid: false, error: `Invalid ${paramName}: slashes and backslashes are forbidden` };
  }

  // Reject control characters (0x00 - 0x1f, 0x7f)
  if (/[\x00-\x1f\x7f]/.test(decoded)) {
    return { valid: false, error: `Invalid ${paramName}: control characters are forbidden` };
  }

  if (decoded.length < 1 || decoded.length > 128) {
    return { valid: false, error: `Invalid ${paramName} length (${decoded.length}). Expected 1 to 128 characters.` };
  }

  if (!RESOURCE_ID_REGEX.test(decoded)) {
    return { valid: false, error: `Invalid ${paramName} format "${decoded}". Must match [A-Za-z0-9_-]{1,128}.` };
  }

  return { valid: true, value: decoded };
}

/**
 * Validates message content against string bounds (max 64 KiB).
 */
export function validateMessageContent(content: unknown): { valid: boolean; value?: string; error?: string } {
  if (typeof content !== 'string' || content.trim().length === 0) {
    return { valid: false, error: 'Message content must be a non-empty string' };
  }

  if (content.length > MAX_MESSAGE_CONTENT_LENGTH) {
    return {
      valid: false,
      error: `Message content exceeds maximum allowed length of ${MAX_MESSAGE_CONTENT_LENGTH} characters (got ${content.length})`,
    };
  }

  return { valid: true, value: content };
}

export const MAX_MESSAGE_ATTACHMENTS = 10;
export const ETAG_LOWERCASE_SHA256_REGEX = /^"[0-9a-f]{64}"$/;

export interface ValidatedAttachment {
  path: string;
  etag: string;
  mimeType?: string;
  displayName?: string;
  [key: string]: unknown;
}

/**
 * Validates message attachments array shape and bounds.
 */
export function validateAttachments(attachments: unknown): {
  valid: boolean;
  value?: ValidatedAttachment[];
  error?: string;
} {
  if (attachments === undefined || attachments === null) {
    return { valid: true, value: undefined };
  }

  if (!Array.isArray(attachments)) {
    return { valid: false, error: 'Expected attachments to be an array' };
  }

  if (attachments.length > MAX_MESSAGE_ATTACHMENTS) {
    return {
      valid: false,
      error: `Attachment count exceeds limit of ${MAX_MESSAGE_ATTACHMENTS} (got ${attachments.length})`,
    };
  }

  const validated: ValidatedAttachment[] = [];
  for (let i = 0; i < attachments.length; i++) {
    const item = attachments[i];
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return { valid: false, error: `Invalid attachment at index ${i}: must be an object` };
    }

    const rec = item as Record<string, unknown>;
    const allowedAttachmentKeys = new Set(['path', 'etag', 'mimeType', 'displayName']);
    for (const k of Object.keys(rec)) {
      if (!allowedAttachmentKeys.has(k)) {
        return { valid: false, error: `Attachment at index ${i} contains unexpected field "${k}"` };
      }
    }

    const { path: rawPath, etag: rawEtag, mimeType: rawMime, displayName: rawDisplayName } = rec;

    if (typeof rawPath !== 'string' || !rawPath.trim()) {
      return { valid: false, error: `Attachment at index ${i} requires a non-empty string path` };
    }

    const cleanPath = rawPath.trim();
    if (cleanPath.startsWith('/') || cleanPath.startsWith('\\') || cleanPath.includes('..') || cleanPath.includes('\0')) {
      return { valid: false, error: `Attachment at index ${i} path must be canonical relative path within current space` };
    }

    if (typeof rawEtag !== 'string' || !ETAG_LOWERCASE_SHA256_REGEX.test(rawEtag)) {
      return {
        valid: false,
        error: `Attachment at index ${i} requires exact quoted lowercase 64-hex SHA-256 etag (e.g. \\"[0-9a-f]{64}\\")`,
      };
    }

    let cleanDisplayName: string | undefined;
    if (rawDisplayName !== undefined) {
      if (typeof rawDisplayName !== 'string') {
        return { valid: false, error: `Attachment at index ${i} displayName must be a string` };
      }
      const normName = rawDisplayName.trim().normalize('NFC');
      if (normName.length > 255) {
        return { valid: false, error: `Attachment at index ${i} displayName exceeds 255 characters` };
      }
      cleanDisplayName = normName;
    }

    let cleanMime: string | undefined;
    if (rawMime !== undefined) {
      if (typeof rawMime !== 'string') {
        return { valid: false, error: `Attachment at index ${i} mimeType must be a string` };
      }
      cleanMime = rawMime.trim();
    }

    validated.push({
      path: cleanPath,
      etag: rawEtag,
      ...(cleanMime ? { mimeType: cleanMime } : {}),
      ...(cleanDisplayName ? { displayName: cleanDisplayName } : {}),
    });
  }

  return { valid: true, value: validated };
}
