import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_MAX_FILE_SIZE_MB,
  MAX_INBOUND_FILE_BYTES,
  MAX_FILE_SIZE_MB,
  resolveMaxInboundFileBytes,
} from '../src/safety/file-limits.js';

describe('Inbound File Size Limit Configuration (Issue FF)', () => {
  const originalEnvMb = process.env.MAX_FILE_SIZE_MB;
  const originalEnvBytes = process.env.ENKEEP_MAX_FILE_SIZE_BYTES;

  beforeEach(() => {
    delete process.env.MAX_FILE_SIZE_MB;
    delete process.env.ENKEEP_MAX_FILE_SIZE_BYTES;
  });

  afterEach(() => {
    if (originalEnvMb !== undefined) {
      process.env.MAX_FILE_SIZE_MB = originalEnvMb;
    } else {
      delete process.env.MAX_FILE_SIZE_MB;
    }
    if (originalEnvBytes !== undefined) {
      process.env.ENKEEP_MAX_FILE_SIZE_BYTES = originalEnvBytes;
    } else {
      delete process.env.ENKEEP_MAX_FILE_SIZE_BYTES;
    }
  });

  it('defaults to 500MB (524,288,000 bytes)', () => {
    expect(DEFAULT_MAX_FILE_SIZE_MB).toBe(500);
    expect(MAX_INBOUND_FILE_BYTES).toBe(500 * 1024 * 1024);
    expect(MAX_FILE_SIZE_MB).toBe(500);
    expect(resolveMaxInboundFileBytes()).toBe(500 * 1024 * 1024);
  });

  it('resolves custom limit via MAX_FILE_SIZE_MB environment variable', () => {
    process.env.MAX_FILE_SIZE_MB = '250';
    expect(resolveMaxInboundFileBytes()).toBe(250 * 1024 * 1024);
  });

  it('resolves custom limit via ENKEEP_MAX_FILE_SIZE_BYTES environment variable', () => {
    process.env.ENKEEP_MAX_FILE_SIZE_BYTES = '104857600';
    expect(resolveMaxInboundFileBytes()).toBe(104857600);
  });

  it('falls back to default 500MB on invalid or non-numeric environment values', () => {
    process.env.MAX_FILE_SIZE_MB = 'invalid';
    expect(resolveMaxInboundFileBytes()).toBe(500 * 1024 * 1024);

    process.env.MAX_FILE_SIZE_MB = '-50';
    expect(resolveMaxInboundFileBytes()).toBe(500 * 1024 * 1024);
  });
});
