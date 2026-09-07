import { describe, it, expect } from 'vitest';
import {
  ProtocolErrorCode,
  ProtocolError,
  createErrorEnvelope,
  createSuccessEnvelope,
  isErrorEnvelope,
  isSuccessEnvelope,
} from '../src/index.js';

describe('Protocol Errors & Envelopes', () => {
  describe('createSuccessEnvelope & isSuccessEnvelope', () => {
    it('creates and identifies valid success envelope', () => {
      const envelope = createSuccessEnvelope({ foo: 'bar' }, { requestId: 'req-1' });
      expect(isSuccessEnvelope(envelope)).toBe(true);
      expect(isErrorEnvelope(envelope)).toBe(false);
      expect(envelope.success).toBe(true);
      expect(envelope.data).toEqual({ foo: 'bar' });
      expect(envelope.meta?.requestId).toBe('req-1');
    });

    it('identifies non-success envelopes', () => {
      expect(isSuccessEnvelope(null)).toBe(false);
      expect(isSuccessEnvelope({})).toBe(false);
      expect(isSuccessEnvelope({ success: false })).toBe(false);
    });
  });

  describe('createErrorEnvelope & isErrorEnvelope', () => {
    it('creates and identifies valid error envelope', () => {
      const envelope = createErrorEnvelope({
        code: ProtocolErrorCode.BAD_REQUEST,
        message: 'Invalid parameters',
        status: 400,
        requestId: 'req-2',
        retryable: false,
        details: [{ message: 'Field x is required', path: 'x' }],
      });

      expect(isErrorEnvelope(envelope)).toBe(true);
      expect(isSuccessEnvelope(envelope)).toBe(false);
      expect(envelope.success).toBe(false);
      expect(envelope.error.code).toBe(ProtocolErrorCode.BAD_REQUEST);
      expect(envelope.error.status).toBe(400);
      expect(envelope.error.requestId).toBe('req-2');
      expect(envelope.error.retryable).toBe(false);
      expect(envelope.error.details).toHaveLength(1);
      expect(envelope.error.timestamp).toBeDefined();
    });

    it('identifies non-error envelopes', () => {
      expect(isErrorEnvelope(null)).toBe(false);
      expect(isErrorEnvelope({ success: true, data: 123 })).toBe(false);
      expect(isErrorEnvelope({ success: false })).toBe(false);
    });
  });

  describe('ProtocolError class', () => {
    it('initializes default properties correctly', () => {
      const err500 = new ProtocolError({
        code: ProtocolErrorCode.INTERNAL_ERROR,
        message: 'Server failed',
      });
      expect(err500.status).toBe(500);
      expect(err500.retryable).toBe(true);
      expect(err500.code).toBe(ProtocolErrorCode.INTERNAL_ERROR);

      const err400 = new ProtocolError({
        code: ProtocolErrorCode.BAD_REQUEST,
        message: 'Bad client request',
        status: 400,
      });
      expect(err400.status).toBe(400);
      expect(err400.retryable).toBe(false);

      const err429 = new ProtocolError({
        code: ProtocolErrorCode.RATE_LIMITED,
        message: 'Too many requests',
        status: 429,
      });
      expect(err429.status).toBe(429);
      expect(err429.retryable).toBe(true);
    });

    it('converts to and from envelope losslessly', () => {
      const original = new ProtocolError({
        code: ProtocolErrorCode.UNAUTHORIZED,
        message: 'Missing bearer token',
        status: 401,
        retryable: false,
        requestId: 'req-auth',
        details: [{ message: 'Authorization header required' }],
      });

      const envelope = original.toEnvelope();
      expect(envelope.success).toBe(false);
      expect(envelope.error.code).toBe(ProtocolErrorCode.UNAUTHORIZED);

      const restored = ProtocolError.fromEnvelope(envelope);
      expect(restored.name).toBe('ProtocolError');
      expect(restored.code).toBe(ProtocolErrorCode.UNAUTHORIZED);
      expect(restored.status).toBe(401);
      expect(restored.retryable).toBe(false);
      expect(restored.requestId).toBe('req-auth');
      expect(restored.details).toEqual(original.details);
    });
  });
});
