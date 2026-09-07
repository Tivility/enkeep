import { describe, it, expect } from 'vitest';
import {
  signCookieValue,
  unsignCookieValue,
  createSignedSessionCookie,
  parseSignedSessionCookie,
  generateCryptoSecret,
  constantTimeCompare,
  isLoopbackHost,
  validateOrigin,
  validatePathId,
  validateMessageContent,
  validateAttachments,
  DEFAULT_SECURITY_HEADERS,
  API_CACHE_CONTROL_HEADERS,
  SECURITY_REASONS,
  PERMITTED_BIND_HOST,
} from '../src/security.js';
import type { IncomingMessage } from 'node:http';

describe('Web Channel Security & Cryptography Module', () => {
  const testSecret = 'super-secret-key-for-unit-testing-32-bytes-long';
  const testCsrfToken = 'custom-csrf-token-32-bytes-long-secret';

  describe('Permitted Host Binding Safety', () => {
    it('strictly specifies 127.0.0.1 as the only permitted binding host', () => {
      expect(PERMITTED_BIND_HOST).toBe('127.0.0.1');
    });
  });

  describe('Constant-Time Comparison', () => {
    it('returns true for matching strings and false for mismatched strings regardless of length', () => {
      expect(constantTimeCompare('secret123', 'secret123')).toBe(true);
      expect(constantTimeCompare('secret123', 'secret999')).toBe(false);
      expect(constantTimeCompare('secret123', 'short')).toBe(false);
      expect(constantTimeCompare('short', 'secret123')).toBe(false);
      expect(constantTimeCompare('', '')).toBe(true);
    });
  });

  describe('isLoopbackHost with Mandatory Expected Port', () => {
    it('accepts exact 127.0.0.1:port matching expectedPort', () => {
      expect(isLoopbackHost('127.0.0.1:3200', 3200)).toBe(true);
      expect(isLoopbackHost('127.0.0.1:80', 80)).toBe(true);
      expect(isLoopbackHost('127.0.0.1:65535', 65535)).toBe(true);
    });

    it('rejects port mismatch', () => {
      expect(isLoopbackHost('127.0.0.1:3200', 3201)).toBe(false);
      expect(isLoopbackHost('127.0.0.1:8080', 3000)).toBe(false);
    });

    it('rejects host without port or with invalid port formats', () => {
      expect(isLoopbackHost('127.0.0.1', 3200)).toBe(false);
      expect(isLoopbackHost('127.0.0.1:', 3200)).toBe(false);
      expect(isLoopbackHost('127.0.0.1:03200', 3200)).toBe(false);
      expect(isLoopbackHost('127.0.0.1:3200.', 3200)).toBe(false);
      expect(isLoopbackHost('127.0.0.1:0', 0 as any)).toBe(false);
      expect(isLoopbackHost('127.0.0.1:70000', 70000)).toBe(false);
    });

    it('rejects non-loopback hosts, whitespace, schemes, and hostile characters', () => {
      expect(isLoopbackHost('localhost:3200', 3200)).toBe(false);
      expect(isLoopbackHost('::1:3200', 3200)).toBe(false);
      expect(isLoopbackHost('0.0.0.0:3200', 3200)).toBe(false);
      expect(isLoopbackHost('http://127.0.0.1:3200', 3200)).toBe(false);
      expect(isLoopbackHost('https://127.0.0.1:3200', 3200)).toBe(false);
      expect(isLoopbackHost('127.0.0.1:3200 ', 3200)).toBe(false);
      expect(isLoopbackHost(' 127.0.0.1:3200', 3200)).toBe(false);
      expect(isLoopbackHost('127.0.0.1:3200, 127.0.0.1:3200', 3200)).toBe(false);
      expect(isLoopbackHost('user@127.0.0.1:3200', 3200)).toBe(false);
    });
  });

  describe('HMAC Cookie Signing & Verification', () => {
    it('generates cryptographic secrets of specified length', () => {
      const sec1 = generateCryptoSecret(32);
      const sec2 = generateCryptoSecret(32);
      expect(sec1).not.toBe(sec2);
      expect(sec1.length).toBe(64); // hex representation of 32 bytes
    });

    it('signs and verifies cookie values successfully', () => {
      const original = 'token_abc123_valid_uuid';
      const signed = signCookieValue(original, testSecret);

      expect(signed.startsWith('s:token_abc123_valid_uuid.')).toBe(true);

      const verified = unsignCookieValue(signed, testSecret);
      expect(verified).toBe(original);
    });

    it('rejects tampered cookie value', () => {
      const original = 'token_abc123_valid_uuid';
      const signed = signCookieValue(original, testSecret);

      // Tamper payload
      const tampered = signed.replace('token_abc123', 'token_forged999');
      const verified = unsignCookieValue(tampered, testSecret);
      expect(verified).toBeNull();
    });

    it('rejects tampered signature', () => {
      const original = 'token_abc123_valid_uuid';
      const signed = signCookieValue(original, testSecret);

      // Tamper signature
      const tamperedSig = signed.slice(0, -5) + 'AAAAA';
      const verified = unsignCookieValue(tamperedSig, testSecret);
      expect(verified).toBeNull();
    });

    it('rejects unsigned raw value attempting to spoof a session', () => {
      expect(unsignCookieValue('raw_unsigned_token', testSecret)).toBeNull();
      expect(unsignCookieValue('usr_alice123', testSecret)).toBeNull();
    });

    it('rejects cookie signed with a different secret key', () => {
      const signedWithOtherSecret = signCookieValue('token_xyz', 'other-secret-key-at-least-16-chars');
      expect(unsignCookieValue(signedWithOtherSecret, testSecret)).toBeNull();
    });

    it('validates cookie creation inputs and builds Set-Cookie header with SameSite=Strict and HttpOnly flags', () => {
      const header = createSignedSessionCookie('session_token_1', testSecret, {
        cookieName: 'enkeep_session',
        maxAgeSeconds: 3600,
      });

      expect(header).toContain('enkeep_session=');
      expect(header).toContain('HttpOnly');
      expect(header).toContain('SameSite=Strict');
      expect(header).toContain('Path=/');
      expect(header).toContain('Max-Age=3600');

      // Invalid options validation
      expect(() => createSignedSessionCookie('token', 'short', {})).toThrow(TypeError);
      expect(() => createSignedSessionCookie('', testSecret, {})).toThrow(TypeError);
      expect(() => createSignedSessionCookie('token', testSecret, { cookieName: 'bad name;' })).toThrow(TypeError);
      expect(() => createSignedSessionCookie('token', testSecret, { cookiePath: 'relative-path' })).toThrow(TypeError);
      expect(() => createSignedSessionCookie('token', testSecret, { cookieSameSite: 'None' as any })).toThrow(TypeError);
    });

    it('parses signed session cookie with exact configured name only', () => {
      const token = 'valid_session_uuid_token';
      const signed = signCookieValue(token, testSecret);
      const cookieHeader = `enkeep_session=${encodeURIComponent(signed)}; other=123`;

      const parsed = parseSignedSessionCookie(cookieHeader, 'enkeep_session', testSecret);
      expect(parsed).toBe(token);
    });

    it('strictly rejects alias cookie name "session"', () => {
      const token = 'valid_session_uuid_token';
      const signed = signCookieValue(token, testSecret);
      const aliasCookieHeader = `session=${encodeURIComponent(signed)}; other=123`;

      const parsed = parseSignedSessionCookie(aliasCookieHeader, 'enkeep_session', testSecret);
      expect(parsed).toBeNull();
    });

    it('strictly rejects duplicate cookie names in header', () => {
      const token1 = 'valid_session_uuid_token_1';
      const token2 = 'valid_session_uuid_token_2';
      const signed1 = signCookieValue(token1, testSecret);
      const signed2 = signCookieValue(token2, testSecret);
      const duplicateCookieHeader = `enkeep_session=${encodeURIComponent(signed1)}; enkeep_session=${encodeURIComponent(signed2)}`;

      const parsed = parseSignedSessionCookie(duplicateCookieHeader, 'enkeep_session', testSecret);
      expect(parsed).toBeNull();
    });

    it('safely returns null without throwing on malformed percent encoding', () => {
      const malformedHeader = 'enkeep_session=%E0%A4%A; other=123';
      const parsed = parseSignedSessionCookie(malformedHeader, 'enkeep_session', testSecret);
      expect(parsed).toBeNull();
    });

    it('returns null when Cookie header contains forged user ID instead of signed token', () => {
      const forgedCookieHeader = 'enkeep_session=usr_alice123; other=123';
      const parsed = parseSignedSessionCookie(forgedCookieHeader, 'enkeep_session', testSecret);
      expect(parsed).toBeNull();
    });
  });

  describe('Socket Authority, Host Header & CSRF/Origin Verification', () => {
    it('rejects request when socket is missing or not 127.0.0.1 with generic reason', () => {
      const noSocketReq = {
        method: 'GET',
        headers: { host: '127.0.0.1:3200' },
      } as unknown as IncomingMessage;
      const r1 = validateOrigin(noSocketReq, { csrfToken: testCsrfToken });
      expect(r1.allowed).toBe(false);
      expect(r1.reason).toBe(SECURITY_REASONS.FORBIDDEN_SOCKET_AUTHORITY);

      const badSocketReq = {
        method: 'GET',
        headers: { host: '127.0.0.1:3200' },
        socket: { localAddress: '::1', localPort: 3200 },
      } as unknown as IncomingMessage;
      const r2 = validateOrigin(badSocketReq, { csrfToken: testCsrfToken });
      expect(r2.allowed).toBe(false);
      expect(r2.reason).toBe(SECURITY_REASONS.FORBIDDEN_SOCKET_AUTHORITY);

      const ipv4MappedReq = {
        method: 'GET',
        headers: { host: '127.0.0.1:3200' },
        socket: { localAddress: '::ffff:127.0.0.1', localPort: 3200 },
      } as unknown as IncomingMessage;
      const r3 = validateOrigin(ipv4MappedReq, { csrfToken: testCsrfToken });
      expect(r3.allowed).toBe(false);
      expect(r3.reason).toBe(SECURITY_REASONS.FORBIDDEN_SOCKET_AUTHORITY);
    });

    it('rejects request when Host header does not match exact 127.0.0.1:${socket.localPort}', () => {
      const badHosts = [
        'localhost:3200',
        '127.0.0.1:03200',
        ' 127.0.0.1:3200',
        '127.0.0.1:3200.',
        '127.0.0.1:3200, 127.0.0.1:3200',
        'http://127.0.0.1:3200',
        '127.0.0.1:9999',
      ];
      for (const bh of badHosts) {
        const fakeReq = {
          method: 'GET',
          headers: { host: bh },
          socket: { localAddress: '127.0.0.1', localPort: 3200 },
        } as unknown as IncomingMessage;
        const res = validateOrigin(fakeReq, { csrfToken: testCsrfToken });
        expect(res.allowed).toBe(false);
        expect(res.reason).toBe(SECURITY_REASONS.INVALID_OR_FORBIDDEN_HOST);
      }
    });

    it('rejects unknown or non-standard HTTP methods', () => {
      const customMethodReq = {
        method: 'TRACK',
        headers: { host: '127.0.0.1:3200' },
        socket: { localAddress: '127.0.0.1', localPort: 3200 },
      } as unknown as IncomingMessage;
      const res = validateOrigin(customMethodReq, { csrfToken: testCsrfToken });
      expect(res.allowed).toBe(false);
      expect(res.reason).toBe(SECURITY_REASONS.UNSUPPORTED_METHOD);
    });

    it('rejects malformed Content-Length header', () => {
      const badContentLengthReq = {
        method: 'GET',
        headers: { host: '127.0.0.1:3200', 'content-length': '-5' },
        socket: { localAddress: '127.0.0.1', localPort: 3200 },
      } as unknown as IncomingMessage;
      const res = validateOrigin(badContentLengthReq, { csrfToken: testCsrfToken });
      expect(res.allowed).toBe(false);
      expect(res.reason).toBe(SECURITY_REASONS.INVALID_CONTENT_LENGTH);
    });

    it('allows GET safe requests without origin or token checks when Host is valid', () => {
      const fakeReq = {
        method: 'GET',
        headers: { host: '127.0.0.1:3200' },
        socket: { localAddress: '127.0.0.1', localPort: 3200 },
      } as unknown as IncomingMessage;

      const check = validateOrigin(fakeReq, { csrfToken: testCsrfToken });
      expect(check.allowed).toBe(true);
    });

    it('allows GET with matching Origin but rejects GET with mismatched Origin', () => {
      const goodOriginReq = {
        method: 'GET',
        headers: { host: '127.0.0.1:3200', origin: 'http://127.0.0.1:3200' },
        socket: { localAddress: '127.0.0.1', localPort: 3200 },
      } as unknown as IncomingMessage;
      expect(validateOrigin(goodOriginReq, { csrfToken: testCsrfToken }).allowed).toBe(true);

      const badOriginReq = {
        method: 'GET',
        headers: { host: '127.0.0.1:3200', origin: 'http://evil.com' },
        socket: { localAddress: '127.0.0.1', localPort: 3200 },
      } as unknown as IncomingMessage;
      const r = validateOrigin(badOriginReq, { csrfToken: testCsrfToken });
      expect(r.allowed).toBe(false);
      expect(r.reason).toBe(SECURITY_REASONS.INVALID_ORIGIN);
    });

    it('rejects state-changing request missing CSRF token even if Origin matches', () => {
      const fakeReq = {
        method: 'POST',
        headers: { host: '127.0.0.1:3200', origin: 'http://127.0.0.1:3200' },
        socket: { localAddress: '127.0.0.1', localPort: 3200 },
      } as unknown as IncomingMessage;

      const check = validateOrigin(fakeReq, { csrfToken: testCsrfToken });
      expect(check.allowed).toBe(false);
      expect(check.reason).toBe(SECURITY_REASONS.MISSING_CSRF_HEADER);
    });

    it('rejects state-changing cross-origin request from malicious origin even with valid token', () => {
      const fakeReq = {
        method: 'POST',
        headers: {
          host: '127.0.0.1:3200',
          origin: 'http://evil-site.com',
          'x-enkeep-csrf': testCsrfToken,
        },
        socket: { localAddress: '127.0.0.1', localPort: 3200 },
      } as unknown as IncomingMessage;

      const check = validateOrigin(fakeReq, { csrfToken: testCsrfToken });
      expect(check.allowed).toBe(false);
      expect(check.reason).toBe(SECURITY_REASONS.INVALID_ORIGIN);
    });

    it('rejects state-changing request with HTTPS origin or referer substitute', () => {
      const fakeHttpsReq = {
        method: 'POST',
        headers: {
          host: '127.0.0.1:3200',
          origin: 'https://127.0.0.1:3200',
          'x-enkeep-csrf': testCsrfToken,
        },
        socket: { localAddress: '127.0.0.1', localPort: 3200 },
      } as unknown as IncomingMessage;
      expect(validateOrigin(fakeHttpsReq, { csrfToken: testCsrfToken }).allowed).toBe(false);

      const fakeRefererOnlyReq = {
        method: 'POST',
        headers: {
          host: '127.0.0.1:3200',
          referer: 'http://127.0.0.1:3200',
          'x-enkeep-csrf': testCsrfToken,
        },
        socket: { localAddress: '127.0.0.1', localPort: 3200 },
      } as unknown as IncomingMessage;
      expect(validateOrigin(fakeRefererOnlyReq, { csrfToken: testCsrfToken }).allowed).toBe(false);
    });

    it('rejects state-changing request with x-csrf-token alias or duplicate token headers', () => {
      const fakeAliasToken = {
        method: 'POST',
        headers: {
          host: '127.0.0.1:3200',
          origin: 'http://127.0.0.1:3200',
          'x-csrf-token': testCsrfToken,
        },
        socket: { localAddress: '127.0.0.1', localPort: 3200 },
      } as unknown as IncomingMessage;
      const r1 = validateOrigin(fakeAliasToken, { csrfToken: testCsrfToken });
      expect(r1.allowed).toBe(false);
      expect(r1.reason).toBe(SECURITY_REASONS.CONFLICTING_CSRF_HEADERS);

      const fakeDupToken = {
        method: 'POST',
        headers: {
          host: '127.0.0.1:3200',
          origin: 'http://127.0.0.1:3200',
          'x-enkeep-csrf': testCsrfToken,
          'x-csrf-token': testCsrfToken,
        },
        socket: { localAddress: '127.0.0.1', localPort: 3200 },
      } as unknown as IncomingMessage;
      const r2 = validateOrigin(fakeDupToken, { csrfToken: testCsrfToken });
      expect(r2.allowed).toBe(false);
      expect(r2.reason).toBe(SECURITY_REASONS.CONFLICTING_CSRF_HEADERS);
    });

    it('allows state-changing request carrying BOTH valid matching x-enkeep-csrf token AND exact loopback Origin', () => {
      const fakeReq = {
        method: 'POST',
        headers: {
          host: '127.0.0.1:3200',
          origin: 'http://127.0.0.1:3200',
          'x-enkeep-csrf': testCsrfToken,
        },
        socket: { localAddress: '127.0.0.1', localPort: 3200 },
      } as unknown as IncomingMessage;

      const check = validateOrigin(fakeReq, { csrfToken: testCsrfToken });
      expect(check.allowed).toBe(true);
    });
  });

  describe('Path Parameter Validation & Double-Decoding Checks', () => {
    it('validates safe alphanumeric/hyphen/underscore identifiers', () => {
      expect(validatePathId('session-123_abc', 'sessionId')).toEqual({ valid: true, value: 'session-123_abc' });
      expect(validatePathId('space_456', 'spaceId')).toEqual({ valid: true, value: 'space_456' });
    });

    it('rejects double percent-encoding', () => {
      const res = validatePathId('%252e%252e%252f', 'sessionId');
      expect(res.valid).toBe(false);
      expect(res.error).toContain('double percent-encoding');
    });

    it('rejects dot segments and path traversal', () => {
      expect(validatePathId('.', 'sessionId').valid).toBe(false);
      expect(validatePathId('..', 'sessionId').valid).toBe(false);
      expect(validatePathId('%2e%2e', 'sessionId').valid).toBe(false);
      expect(validatePathId('..%2f', 'sessionId').valid).toBe(false);
      expect(validatePathId('.hidden', 'sessionId').valid).toBe(false);
    });

    it('rejects slashes and backslashes', () => {
      expect(validatePathId('a/b', 'sessionId').valid).toBe(false);
      expect(validatePathId('a\\b', 'sessionId').valid).toBe(false);
      expect(validatePathId('%2F', 'sessionId').valid).toBe(false);
      expect(validatePathId('%5C', 'sessionId').valid).toBe(false);
    });

    it('rejects control characters', () => {
      expect(validatePathId('a%00b', 'sessionId').valid).toBe(false);
      expect(validatePathId('a%1fb', 'sessionId').valid).toBe(false);
      expect(validatePathId('a\nb', 'sessionId').valid).toBe(false);
    });

    it('rejects oversized identifiers (> 128 chars)', () => {
      const longId = 'a'.repeat(129);
      expect(validatePathId(longId, 'sessionId').valid).toBe(false);
    });
  });

  describe('Security Headers', () => {
    it('defines standard security headers including CSP, X-Content-Type-Options, X-Frame-Options', () => {
      expect(DEFAULT_SECURITY_HEADERS['Content-Security-Policy']).toContain("default-src 'self'");
      expect(DEFAULT_SECURITY_HEADERS['Content-Security-Policy']).toContain("form-action 'self'");
      expect(DEFAULT_SECURITY_HEADERS['X-Content-Type-Options']).toBe('nosniff');
      expect(DEFAULT_SECURITY_HEADERS['X-Frame-Options']).toBe('DENY');
      expect(DEFAULT_SECURITY_HEADERS['X-XSS-Protection']).toBe('1; mode=block');
      expect(DEFAULT_SECURITY_HEADERS['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    });

    it('defines anti-caching headers for sensitive API endpoints', () => {
      expect(API_CACHE_CONTROL_HEADERS['Cache-Control']).toContain('no-store');
      expect(API_CACHE_CONTROL_HEADERS['Cache-Control']).toContain('no-cache');
      expect(API_CACHE_CONTROL_HEADERS['Pragma']).toBe('no-cache');
    });
  });
});
