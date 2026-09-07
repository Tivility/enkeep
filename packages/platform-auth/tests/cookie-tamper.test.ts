import { describe, it, expect } from 'vitest';
import {
  createSignedCookieValue,
  verifyAndDecodeCookieValue,
  buildSetCookieHeader,
  parseCookieFromHeader,
  signPayload,
} from '../src/index.js';

describe('HMAC Signed Session Cookies and Hardened Parser', () => {
  const secret = 'super-secret-key-that-is-at-least-32-chars-long';
  const sessionId = 'sess-1234-uuid';
  const token = 'token-secret-value-abcdef123456';
  const futureExpiry = Date.now() + 100000;

  it('creates and verifies a valid signed session cookie', () => {
    const signedValue = createSignedCookieValue(sessionId, token, futureExpiry, secret);
    expect(signedValue).toContain('.');

    const decoded = verifyAndDecodeCookieValue(signedValue, secret);
    expect(decoded).not.toBeNull();
    expect(decoded?.sessionId).toBe(sessionId);
    expect(decoded?.token).toBe(token);
    expect(decoded?.expiresAt).toBe(futureExpiry);
  });

  it('rejects tampered payload', () => {
    const signedValue = createSignedCookieValue(sessionId, token, futureExpiry, secret);
    const [, signature] = signedValue.split('.');

    // Tamper with payload (e.g. inject another session ID)
    const tamperedPayload = Buffer.from(`other-sess.${token}.${futureExpiry}`).toString('base64url');
    const tamperedCookie = `${tamperedPayload}.${signature}`;

    const decoded = verifyAndDecodeCookieValue(tamperedCookie, secret);
    expect(decoded).toBeNull();
  });

  it('rejects tampered signature', () => {
    const signedValue = createSignedCookieValue(sessionId, token, futureExpiry, secret);
    const [payload] = signedValue.split('.');

    const tamperedSignature = 'tampered-fake-signature-that-is-43-chars-long!'; // 43 chars but bad
    const tamperedCookie = `${payload}.${tamperedSignature.slice(0, 43)}`;

    const decoded = verifyAndDecodeCookieValue(tamperedCookie, secret);
    expect(decoded).toBeNull();
  });

  it('rejects verification when using wrong secret', () => {
    const signedValue = createSignedCookieValue(sessionId, token, futureExpiry, secret);
    const wrongSecret = 'another-completely-different-secret-key';

    const decoded = verifyAndDecodeCookieValue(signedValue, wrongSecret);
    expect(decoded).toBeNull();
  });

  it('rejects expired session cookies', () => {
    const pastExpiry = Date.now() - 5000;
    const rawPayload = `${sessionId}.${token}.${pastExpiry}`;
    const encodedPayload = Buffer.from(rawPayload, 'utf8').toString('base64url');
    const signature = signPayload(encodedPayload, secret);
    const expiredCookie = `${encodedPayload}.${signature}`;

    const decoded = verifyAndDecodeCookieValue(expiredCookie, secret);
    expect(decoded).toBeNull();
  });

  it('rejects signed payload containing extra or fewer dots (not exactly 3 parts)', () => {
    // 4 parts: extra dot in sessionId or token
    const raw4Parts = `${sessionId}.${token}.extra.${futureExpiry}`;
    const encoded4 = Buffer.from(raw4Parts, 'utf8').toString('base64url');
    const sig4 = signPayload(encoded4, secret);
    expect(verifyAndDecodeCookieValue(`${encoded4}.${sig4}`, secret)).toBeNull();

    // 2 parts: missing expiresAt
    const raw2Parts = `${sessionId}.${token}`;
    const encoded2 = Buffer.from(raw2Parts, 'utf8').toString('base64url');
    const sig2 = signPayload(encoded2, secret);
    expect(verifyAndDecodeCookieValue(`${encoded2}.${sig2}`, secret)).toBeNull();

    // 5 parts
    const raw5Parts = `a.b.c.d.${futureExpiry}`;
    const encoded5 = Buffer.from(raw5Parts, 'utf8').toString('base64url');
    const sig5 = signPayload(encoded5, secret);
    expect(verifyAndDecodeCookieValue(`${encoded5}.${sig5}`, secret)).toBeNull();
  });

  it('rejects non-canonical base64url encoding and invalid characters', () => {
    const validSigned = createSignedCookieValue(sessionId, token, futureExpiry, secret);
    const [payload, sig] = validSigned.split('.');

    // Non-base64url character in payload
    expect(verifyAndDecodeCookieValue(`${payload}!$.${sig}`, secret)).toBeNull();

    // Padding character '=' is rejected in base64url
    expect(verifyAndDecodeCookieValue(`${payload}==.${sig}`, secret)).toBeNull();

    // Malformed signature length (!= 43 chars)
    expect(verifyAndDecodeCookieValue(`${payload}.shortsig`, secret)).toBeNull();
    expect(verifyAndDecodeCookieValue(`${payload}.${sig}extra`, secret)).toBeNull();
  });

  it('rejects non-canonical decimal expiresAt', () => {
    // Leading zero
    const rawLead0 = `${sessionId}.${token}.0${futureExpiry}`;
    const encLead0 = Buffer.from(rawLead0, 'utf8').toString('base64url');
    const sigLead0 = signPayload(encLead0, secret);
    expect(verifyAndDecodeCookieValue(`${encLead0}.${sigLead0}`, secret)).toBeNull();

    // Plus sign
    const rawPlus = `${sessionId}.${token}.+${futureExpiry}`;
    const encPlus = Buffer.from(rawPlus, 'utf8').toString('base64url');
    const sigPlus = signPayload(encPlus, secret);
    expect(verifyAndDecodeCookieValue(`${encPlus}.${sigPlus}`, secret)).toBeNull();

    // Float / decimal point
    const rawFloat = `${sessionId}.${token}.${futureExpiry}.0`;
    const encFloat = Buffer.from(rawFloat, 'utf8').toString('base64url');
    const sigFloat = signPayload(encFloat, secret);
    expect(verifyAndDecodeCookieValue(`${encFloat}.${sigFloat}`, secret)).toBeNull();

    // Exponent / hex / NaN / negative
    for (const badExpiry of ['1e12', '0x1234', 'NaN', '-1000', 'null', 'undefined']) {
      const raw = `${sessionId}.${token}.${badExpiry}`;
      const enc = Buffer.from(raw, 'utf8').toString('base64url');
      const sig = signPayload(enc, secret);
      expect(verifyAndDecodeCookieValue(`${enc}.${sig}`, secret)).toBeNull();
    }
  });

  it('rejects invalid sessionId and token characters or lengths', () => {
    // Disallowed characters (spaces, semicolons, control chars)
    const badIds = ['sess id with spaces', 'sess;semi', 'sess\nnewline', ''];
    for (const badId of badIds) {
      const raw = `${badId}.${token}.${futureExpiry}`;
      const enc = Buffer.from(raw, 'utf8').toString('base64url');
      const sig = signPayload(enc, secret);
      expect(verifyAndDecodeCookieValue(`${enc}.${sig}`, secret)).toBeNull();
    }

    // Overlong sessionId / token (>128 chars)
    const overlongId = 'a'.repeat(129);
    const rawOverlong = `${overlongId}.${token}.${futureExpiry}`;
    const encOverlong = Buffer.from(rawOverlong, 'utf8').toString('base64url');
    const sigOverlong = signPayload(encOverlong, secret);
    expect(verifyAndDecodeCookieValue(`${encOverlong}.${sigOverlong}`, secret)).toBeNull();
  });

  it('rejects secrets shorter than 16 characters in create and verify', () => {
    const shortSecret = 'short-secret';
    expect(() => createSignedCookieValue(sessionId, token, futureExpiry, shortSecret)).toThrow(
      /Invalid arguments/
    );

    const validSigned = createSignedCookieValue(sessionId, token, futureExpiry, secret);
    expect(verifyAndDecodeCookieValue(validSigned, shortSecret)).toBeNull();
  });

  it('builds Set-Cookie header with HttpOnly, SameSite=Strict and Secure flags', () => {
    const header = buildSetCookieHeader('enkeep_session', 'cookie-val', {
      maxAgeSeconds: 3600,
      secure: true,
      sameSite: 'Strict',
      httpOnly: true,
    });

    expect(header).toContain('enkeep_session=cookie-val');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Strict');
    expect(header).toContain('Secure');
    expect(header).toContain('Path=/');
    expect(header).toContain('Max-Age=3600');
  });

  it('supports Secure false for localhost/dev environments', () => {
    const header = buildSetCookieHeader('enkeep_session', 'cookie-val', {
      maxAgeSeconds: 3600,
      secure: false,
      sameSite: 'Strict',
      httpOnly: true,
    });

    expect(header).toContain('enkeep_session=cookie-val');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Strict');
    expect(header).not.toContain('Secure');
  });

  it('parses named cookie from header string with HTTP OWS around pairs and preserves exact value without trimming', () => {
    const cookieHeader = 'other_cookie=123;  enkeep_session=signed-value-abc; theme=dark';
    const parsed = parseCookieFromHeader(cookieHeader, 'enkeep_session');
    expect(parsed).toBe('signed-value-abc');

    // Preserves exact cookie value: value part after = is NOT trimmed
    const headerWithUntrimmedValue = 'enkeep_session=exact_val_with_trailing ; other=1';
    expect(parseCookieFromHeader(headerWithUntrimmedValue, 'enkeep_session')).toBe('exact_val_with_trailing ');

    expect(parseCookieFromHeader(cookieHeader, 'missing_cookie')).toBeNull();
    expect(parseCookieFromHeader('', 'enkeep_session')).toBeNull();
    expect(parseCookieFromHeader(null, 'enkeep_session')).toBeNull();
    expect(parseCookieFromHeader(undefined, 'enkeep_session')).toBeNull();
  });

  it('strictly rejects duplicate cookie names to prevent cookie injection / tossing', () => {
    const duplicateCookieHeader = 'enkeep_session=malicious_injected; enkeep_session=signed-value-abc; theme=dark';
    const parsed = parseCookieFromHeader(duplicateCookieHeader, 'enkeep_session');
    expect(parsed).toBeNull();

    const multipleDuplicates = 'theme=dark; enkeep_session=first; other=1; enkeep_session=second';
    expect(parseCookieFromHeader(multipleDuplicates, 'enkeep_session')).toBeNull();
  });
});
