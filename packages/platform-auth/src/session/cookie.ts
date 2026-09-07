import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

export interface CookieOptions {
  name?: string;
  path?: string;
  maxAgeSeconds?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface ParsedSessionPayload {
  sessionId: string;
  token: string;
  expiresAt: number; // Unix timestamp ms
}

const BASE64URL_PAYLOAD_REGEX = /^[A-Za-z0-9_-]{1,1024}$/;
const BASE64URL_SIGNATURE_REGEX = /^[A-Za-z0-9_-]{43}$/; // HMAC-SHA256 in base64url is 43 chars
const CANONICAL_EXPIRES_AT_REGEX = /^[1-9][0-9]{0,15}$/;
const ID_OR_TOKEN_REGEX = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_PAYLOAD_BYTES = 1024;
const MIN_SECRET_LEN = 16;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function signPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function verifySignature(payload: string, signature: string, secret: string): boolean {
  if (
    !payload ||
    !signature ||
    !secret ||
    typeof payload !== 'string' ||
    typeof signature !== 'string' ||
    typeof secret !== 'string' ||
    secret.length < MIN_SECRET_LEN ||
    !BASE64URL_PAYLOAD_REGEX.test(payload) ||
    !BASE64URL_SIGNATURE_REGEX.test(signature)
  ) {
    return false;
  }

  const expectedSig = signPayload(payload, secret);
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  const actualBuf = Buffer.from(signature, 'utf8');

  if (expectedBuf.length !== actualBuf.length || expectedBuf.length !== 43) {
    return false;
  }

  return timingSafeEqual(expectedBuf, actualBuf);
}

/**
 * Encode session details into a signed cookie value:
 * base64url(sessionId.token.expiresAt).signature
 */
export function createSignedCookieValue(
  sessionId: string,
  token: string,
  expiresAt: number,
  secret: string
): string {
  if (
    typeof sessionId !== 'string' ||
    !ID_OR_TOKEN_REGEX.test(sessionId) ||
    typeof token !== 'string' ||
    !ID_OR_TOKEN_REGEX.test(token) ||
    typeof expiresAt !== 'number' ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= 0 ||
    typeof secret !== 'string' ||
    secret.length < MIN_SECRET_LEN
  ) {
    throw new Error('Invalid arguments for createSignedCookieValue');
  }

  const rawPayload = `${sessionId}.${token}.${expiresAt}`;
  const encodedPayload = Buffer.from(rawPayload, 'utf8').toString('base64url');
  const signature = signPayload(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

/**
 * Verify and decode signed cookie value.
 * Returns null if signature is invalid, payload is tampered, malformed, or expired.
 */
export function verifyAndDecodeCookieValue(
  signedCookieValue: string,
  secret: string
): ParsedSessionPayload | null {
  if (
    !signedCookieValue ||
    typeof signedCookieValue !== 'string' ||
    !secret ||
    typeof secret !== 'string' ||
    secret.length < MIN_SECRET_LEN
  ) {
    return null;
  }

  const parts = signedCookieValue.split('.');
  if (parts.length !== 2) {
    return null;
  }

  const [encodedPayload, signature] = parts;
  if (!encodedPayload || !signature) {
    return null;
  }

  // Pre-HMAC bounds and character set validation
  if (!BASE64URL_PAYLOAD_REGEX.test(encodedPayload) || !BASE64URL_SIGNATURE_REGEX.test(signature)) {
    return null;
  }

  if (!verifySignature(encodedPayload, signature, secret)) {
    return null; // Tamper detected or invalid signature
  }

  try {
    const payloadBuf = Buffer.from(encodedPayload, 'base64url');
    if (payloadBuf.length < 1 || payloadBuf.length > MAX_PAYLOAD_BYTES) {
      return null;
    }

    // Reject non-canonical base64url encodings
    if (payloadBuf.toString('base64url') !== encodedPayload) {
      return null;
    }

    const rawPayload = payloadBuf.toString('utf8');
    const rawParts = rawPayload.split('.');

    // Strictly require exactly 3 parts (sessionId.token.expiresAt), reject extra dots
    if (rawParts.length !== 3) {
      return null;
    }

    const [sessionId, token, expiresAtStr] = rawParts;

    if (!ID_OR_TOKEN_REGEX.test(sessionId) || !ID_OR_TOKEN_REGEX.test(token)) {
      return null;
    }

    if (!CANONICAL_EXPIRES_AT_REGEX.test(expiresAtStr)) {
      return null;
    }

    const expiresAt = Number(expiresAtStr);
    if (!Number.isSafeInteger(expiresAt)) {
      return null;
    }

    if (Date.now() > expiresAt) {
      return null; // Expired
    }

    return { sessionId, token, expiresAt };
  } catch {
    return null;
  }
}

/**
 * Generate a Set-Cookie header string with strict security parameters.
 */
export function buildSetCookieHeader(
  name: string,
  value: string,
  options: CookieOptions = {}
): string {
  const path = options.path ?? '/';
  const httpOnly = options.httpOnly !== false;
  const sameSite = options.sameSite ?? 'Strict';
  const secure = options.secure ?? true;
  const maxAge = options.maxAgeSeconds ?? 86400 * 7; // 7 days

  const parts = [
    `${name}=${value}`,
    `Path=${path}`,
    `Max-Age=${maxAge}`,
    `SameSite=${sameSite}`,
  ];

  if (httpOnly) {
    parts.push('HttpOnly');
  }
  if (secure) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

/**
 * Parse a Cookie header to extract the named cookie value.
 * HTTP cookie grammar (RFC 6265) allows OWS around cookie pairs and cookie name,
 * but the exact auth cookie value is preserved without trimming.
 * Strictly rejects headers containing duplicate cookie names to prevent cookie injection / tossing attacks.
 */
export function parseCookieFromHeader(
  cookieHeader: string | string[] | undefined | null,
  cookieName: string
): string | null {
  if (!cookieHeader) {
    return null;
  }

  const rawHeader = Array.isArray(cookieHeader) ? cookieHeader.join('; ') : cookieHeader;
  if (typeof rawHeader !== 'string' || rawHeader.length === 0) {
    return null;
  }

  let foundVal: string | null = null;
  const pairs = rawHeader.split(';');

  for (const pair of pairs) {
    // Strip leading OWS (spaces/tabs) before the cookie pair
    const leadingTrimmed = pair.replace(/^[\t ]+/, '');
    if (leadingTrimmed.length === 0) continue;

    const eqIdx = leadingTrimmed.indexOf('=');
    if (eqIdx === -1) continue;

    const key = leadingTrimmed.slice(0, eqIdx).trim();
    // Preserve exact cookie value without trimming
    const val = leadingTrimmed.slice(eqIdx + 1);

    if (key === cookieName) {
      if (foundVal !== null) {
        // Strict rejection of duplicate cookie names
        return null;
      }
      foundVal = val;
    }
  }

  return foundVal;
}
