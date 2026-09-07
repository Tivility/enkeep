import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import {
  PlatformServer,
  SqliteWebMessageStore,
  validateHostBinding,
  validatePortBinding,
  validateServerBinding,
  UnsafeHostBindingError,
  UnsafePortAllocationError,
} from '../src/index.js';
import { TestOnlyRuntimeGateway } from './test-runtime-gateway.js';

describe('Host & Port Binding Safety Guardrails', () => {
  const validSecret32 = 'valid-test-cookie-secret-32-chars-long!';
  const validCsrf32 = 'valid-test-csrf-token-32-chars-long-ok!';

  const createTestGateway = () => {
    const db = new DatabaseSync(':memory:');
    const storage = new SqlitePlatformStorage(db);
    const messageStore = new SqliteWebMessageStore(db);
    return new TestOnlyRuntimeGateway({ storage, messageStore });
  };

  it('should allow valid loopback host 127.0.0.1 and port 0', () => {
    expect(() => validateServerBinding('127.0.0.1', 0)).not.toThrow();
    expect(() => validateServerBinding('127.0.0.1', 4000)).not.toThrow();
  });

  it('should reject unsafe 0.0.0.0 wildcard host binding', () => {
    const gateway = createTestGateway();
    expect(() => validateHostBinding('0.0.0.0')).toThrow(UnsafeHostBindingError);
    expect(() => new PlatformServer({
      host: '0.0.0.0',
      port: 0,
      cookieSecret: validSecret32,
      csrfToken: validCsrf32,
      runtimeGateway: gateway,
    })).toThrow(UnsafeHostBindingError);
  });

  it('should reject IPv6 wildcard and non-127.0.0.1 hosts', () => {
    expect(() => validateHostBinding('::')).toThrow(UnsafeHostBindingError);
    expect(() => validateHostBinding('::0')).toThrow(UnsafeHostBindingError);
    expect(() => validateHostBinding('*')).toThrow(UnsafeHostBindingError);
    expect(() => validateHostBinding('192.168.1.10')).toThrow(UnsafeHostBindingError);
    expect(() => validateHostBinding('10.0.0.1')).toThrow(UnsafeHostBindingError);
  });

  it('should reject protected ports 3000 (HappyClaw) and 3080 (DSH Web GUI)', () => {
    const gateway = createTestGateway();
    expect(() => validatePortBinding(3000)).toThrow(UnsafePortAllocationError);
    expect(() => validatePortBinding(3080)).toThrow(UnsafePortAllocationError);
    expect(() => new PlatformServer({
      host: '127.0.0.1',
      port: 3000,
      cookieSecret: validSecret32,
      csrfToken: validCsrf32,
      runtimeGateway: gateway,
    })).toThrow(UnsafePortAllocationError);
    expect(() => new PlatformServer({
      host: '127.0.0.1',
      port: 3080,
      cookieSecret: validSecret32,
      csrfToken: validCsrf32,
      runtimeGateway: gateway,
    })).toThrow(UnsafePortAllocationError);
  });

  it('should reject negative or out-of-range ports', () => {
    expect(() => validatePortBinding(-1)).toThrow(UnsafePortAllocationError);
    expect(() => validatePortBinding(70000)).toThrow(UnsafePortAllocationError);
  });
});
