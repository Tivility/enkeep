import { describe, it, expect } from 'vitest';
import {
  isDefaultIdempotentMethod,
  isRequestRetryable,
  isTransientError,
  calculateBackoff,
  parseRetryAfterHeader,
  ClientTimeoutError,
  ClientConnectionError,
  ClientHttpError,
} from '../src/index.js';
import { ProtocolError, ProtocolErrorCode } from '@enkeep/protocol';

describe('Retry and Idempotency logic', () => {
  describe('isDefaultIdempotentMethod & isRequestRetryable', () => {
    it('identifies standard idempotent HTTP methods', () => {
      expect(isDefaultIdempotentMethod('GET')).toBe(true);
      expect(isDefaultIdempotentMethod('head')).toBe(true);
      expect(isDefaultIdempotentMethod('PUT')).toBe(true);
      expect(isDefaultIdempotentMethod('DELETE')).toBe(true);
      expect(isDefaultIdempotentMethod('OPTIONS')).toBe(true);

      expect(isDefaultIdempotentMethod('POST')).toBe(false);
      expect(isDefaultIdempotentMethod('patch')).toBe(false);
    });

    it('respects explicit idempotent override in RequestOptions', () => {
      expect(isRequestRetryable('POST', { idempotent: true })).toBe(true);
      expect(isRequestRetryable('GET', { idempotent: false })).toBe(false);
      expect(isRequestRetryable('GET')).toBe(true);
      expect(isRequestRetryable('POST')).toBe(false);
    });
  });

  describe('isTransientError', () => {
    it('identifies transient protocol errors', () => {
      const timeoutErr = new ClientTimeoutError(1000);
      expect(isTransientError(timeoutErr)).toBe(true);

      const connErr = new ClientConnectionError('/tmp/test.sock', 'connection refused');
      expect(isTransientError(connErr)).toBe(true);

      const http503 = new ClientHttpError({ status: 503, message: 'Unavailable' });
      expect(isTransientError(http503)).toBe(true);

      const http429 = new ClientHttpError({ status: 429, message: 'Too Many Requests' });
      expect(isTransientError(http429)).toBe(true);

      const http400 = new ClientHttpError({ status: 400, message: 'Bad Request' });
      expect(isTransientError(http400)).toBe(false);

      const http404 = new ClientHttpError({ status: 404, message: 'Not Found' });
      expect(isTransientError(http404)).toBe(false);
    });

    it('identifies transient system errno codes', () => {
      const econnreset = new Error('read ECONNRESET') as NodeJS.ErrnoException;
      econnreset.code = 'ECONNRESET';
      expect(isTransientError(econnreset)).toBe(true);

      const enoent = new Error('ENOENT socket not found') as NodeJS.ErrnoException;
      enoent.code = 'ENOENT';
      expect(isTransientError(enoent)).toBe(true);

      const otherErr = new Error('Syntax error') as NodeJS.ErrnoException;
      otherErr.code = 'ERR_SYNTAX';
      expect(isTransientError(otherErr)).toBe(false);
    });
  });

  describe('calculateBackoff', () => {
    it('calculates jittered exponential backoff within bounds', () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const delay = calculateBackoff(attempt, 100, 1000);
        const maxExpected = Math.min(100 * Math.pow(2, attempt), 1000);
        expect(delay).toBeGreaterThanOrEqual(maxExpected * 0.5);
        expect(delay).toBeLessThanOrEqual(maxExpected);
      }
    });
  });

  describe('parseRetryAfterHeader', () => {
    it('parses numeric seconds in retry-after header', () => {
      expect(parseRetryAfterHeader({ 'retry-after': '5' })).toBe(5000);
      expect(parseRetryAfterHeader({ 'Retry-After': '2' })).toBe(2000);
      expect(parseRetryAfterHeader({ 'retry-after': '0' })).toBe(0);
    });

    it('returns null when header is absent or invalid', () => {
      expect(parseRetryAfterHeader({})).toBeNull();
      expect(parseRetryAfterHeader(undefined)).toBeNull();
      expect(parseRetryAfterHeader({ 'retry-after': 'invalid-val' })).toBeNull();
    });
  });
});
