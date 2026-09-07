import { describe, it, expect } from 'vitest';
import {
  httpStatusToErrorCode,
  ClientHttpError,
  ClientTimeoutError,
  ClientConnectionError,
  ClientResponseTooLargeError,
} from '../src/index.js';
import { ProtocolErrorCode, createErrorEnvelope } from '@enkeep/protocol';

describe('Client Error mappings', () => {
  describe('httpStatusToErrorCode', () => {
    it('maps standard status codes correctly', () => {
      expect(httpStatusToErrorCode(400)).toBe(ProtocolErrorCode.BAD_REQUEST);
      expect(httpStatusToErrorCode(401)).toBe(ProtocolErrorCode.UNAUTHORIZED);
      expect(httpStatusToErrorCode(403)).toBe(ProtocolErrorCode.FORBIDDEN);
      expect(httpStatusToErrorCode(404)).toBe(ProtocolErrorCode.NOT_FOUND);
      expect(httpStatusToErrorCode(409)).toBe(ProtocolErrorCode.CONFLICT);
      expect(httpStatusToErrorCode(413)).toBe(ProtocolErrorCode.PAYLOAD_TOO_LARGE);
      expect(httpStatusToErrorCode(429)).toBe(ProtocolErrorCode.RATE_LIMITED);
      expect(httpStatusToErrorCode(500)).toBe(ProtocolErrorCode.INTERNAL_ERROR);
      expect(httpStatusToErrorCode(502)).toBe(ProtocolErrorCode.SERVICE_UNAVAILABLE);
      expect(httpStatusToErrorCode(503)).toBe(ProtocolErrorCode.SERVICE_UNAVAILABLE);
      expect(httpStatusToErrorCode(504)).toBe(ProtocolErrorCode.GATEWAY_TIMEOUT);
    });
  });

  describe('ClientHttpError.fromResponse', () => {
    it('extracts structured ErrorEnvelope when provided by server', () => {
      const envelope = createErrorEnvelope({
        code: ProtocolErrorCode.FORBIDDEN,
        message: 'Insufficient permissions',
        status: 403,
        requestId: 'req-srv-1',
        retryable: false,
        details: [{ message: 'Missing workspace.read' }],
      });

      const err = ClientHttpError.fromResponse(403, envelope, 'req-client-1');
      expect(err).toBeInstanceOf(ClientHttpError);
      expect(err.code).toBe(ProtocolErrorCode.FORBIDDEN);
      expect(err.status).toBe(403);
      expect(err.message).toBe('Insufficient permissions');
      expect(err.requestId).toBe('req-srv-1');
      expect(err.retryable).toBe(false);
      expect(err.details).toHaveLength(1);
    });

    it('falls back gracefully on non-envelope error payloads', () => {
      const err = ClientHttpError.fromResponse(404, { message: 'Item missing' }, 'req-client-2');
      expect(err.code).toBe(ProtocolErrorCode.NOT_FOUND);
      expect(err.status).toBe(404);
      expect(err.message).toBe('Item missing');
      expect(err.requestId).toBe('req-client-2');
    });

    it('falls back on plain string/unknown error payloads', () => {
      const err = ClientHttpError.fromResponse(500, 'Internal Crash', 'req-client-3');
      expect(err.code).toBe(ProtocolErrorCode.INTERNAL_ERROR);
      expect(err.status).toBe(500);
      expect(err.message).toContain('HTTP request failed with status 500');
    });
  });

  describe('Specific client errors', () => {
    it('initializes ClientTimeoutError', () => {
      const err = new ClientTimeoutError(5000, 'req-t');
      expect(err.name).toBe('ClientTimeoutError');
      expect(err.status).toBe(408);
      expect(err.retryable).toBe(true);
      expect(err.requestId).toBe('req-t');
      expect(err.message).toContain('5000ms');
    });

    it('initializes ClientConnectionError', () => {
      const err = new ClientConnectionError('/tmp/test.sock', 'refused', undefined, 'req-c');
      expect(err.name).toBe('ClientConnectionError');
      expect(err.status).toBe(503);
      expect(err.socketPath).toBe('/tmp/test.sock');
      expect(err.retryable).toBe(true);
      expect(err.requestId).toBe('req-c');
    });

    it('initializes ClientResponseTooLargeError', () => {
      const err = new ClientResponseTooLargeError(5000, 1000, 'req-l');
      expect(err.name).toBe('ClientResponseTooLargeError');
      expect(err.status).toBe(413);
      expect(err.sizeBytes).toBe(5000);
      expect(err.maxBytes).toBe(1000);
      expect(err.retryable).toBe(false);
    });
  });
});
