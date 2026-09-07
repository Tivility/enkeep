import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createConnection } from 'node:net';
import { mkdtempSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DefaultAuthService } from '@enkeep/platform-auth';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import {
  PlatformServer,
  PlatformConfigurationError,
  SqliteWebMessageStore,
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  computeChecksum,
  MIN_COOKIE_SECRET_LENGTH,
  MIN_CSRF_TOKEN_LENGTH,
  validateCsrf,
  CsrfViolationError,
} from '../src/index.js';
import { TestOnlyRuntimeGateway } from './test-runtime-gateway.js';

describe('Server Configuration, Credentials & Migration Manifest Enforcement', () => {
  const validSecret32 = 'explicit-valid-cookie-secret-32-chars-long!';
  const validCsrf32 = 'explicit-valid-csrf-token-32-chars-long-ok!';

  it('constructor must throw PlatformConfigurationError when runtimeGateway is omitted', () => {
    const db = new DatabaseSync(':memory:');
    expect(() => {
      // @ts-expect-error testing missing runtimeGateway
      new PlatformServer({
        database: db,
        cookieSecret: validSecret32,
        csrfToken: validCsrf32,
      });
    }).toThrow(PlatformConfigurationError);

    try {
      // @ts-expect-error testing missing runtimeGateway
      new PlatformServer({
        database: db,
        cookieSecret: validSecret32,
        csrfToken: validCsrf32,
      });
    } catch (err: any) {
      expect(err.message).toContain('requires an explicit "runtimeGateway"');
      expect(err.message).toContain('Implicit fake auto-reply default is forbidden');
    }
  });

  it('constructor must throw PlatformConfigurationError when cookieSecret is omitted', () => {
    const db = new DatabaseSync(':memory:');
    const storage = new SqlitePlatformStorage(db);
    const messageStore = new SqliteWebMessageStore(db);
    const gateway = new TestOnlyRuntimeGateway({ storage, messageStore });

    expect(() => {
      // @ts-expect-error testing missing cookieSecret
      new PlatformServer({
        database: db,
        runtimeGateway: gateway,
        csrfToken: validCsrf32,
      });
    }).toThrow(PlatformConfigurationError);

    try {
      // @ts-expect-error testing missing cookieSecret
      new PlatformServer({
        database: db,
        runtimeGateway: gateway,
        csrfToken: validCsrf32,
      });
    } catch (err: any) {
      expect(err.message).toContain(`requires an explicit "cookieSecret" of at least ${MIN_COOKIE_SECRET_LENGTH} characters`);
      expect(err.message).toContain('Hardcoded default credentials are strictly forbidden');
    }
  });

  it('constructor must reject weak or short cookieSecret (<32 chars)', () => {
    const db = new DatabaseSync(':memory:');
    const storage = new SqlitePlatformStorage(db);
    const messageStore = new SqliteWebMessageStore(db);
    const gateway = new TestOnlyRuntimeGateway({ storage, messageStore });

    expect(() => {
      new PlatformServer({
        database: db,
        runtimeGateway: gateway,
        cookieSecret: 'short-secret-under-32-chars',
        csrfToken: validCsrf32,
      });
    }).toThrow(PlatformConfigurationError);
  });

  it('constructor must throw PlatformConfigurationError when csrfToken is omitted', () => {
    const db = new DatabaseSync(':memory:');
    const storage = new SqlitePlatformStorage(db);
    const messageStore = new SqliteWebMessageStore(db);
    const gateway = new TestOnlyRuntimeGateway({ storage, messageStore });

    expect(() => {
      // @ts-expect-error testing missing csrfToken
      new PlatformServer({
        database: db,
        runtimeGateway: gateway,
        cookieSecret: validSecret32,
      });
    }).toThrow(PlatformConfigurationError);
  });

  it('constructor rejects short csrfToken (<32 chars)', () => {
    const db = new DatabaseSync(':memory:');
    const storage = new SqlitePlatformStorage(db);
    const messageStore = new SqliteWebMessageStore(db);
    const gateway = new TestOnlyRuntimeGateway({ storage, messageStore });

    expect(() => {
      new PlatformServer({
        database: db,
        runtimeGateway: gateway,
        cookieSecret: validSecret32,
        csrfToken: 'short-token',
      });
    }).toThrow(PlatformConfigurationError);
  });

  it('constructor succeeds with valid cookieSecret >= 32 chars, csrfToken >= 32 chars, and runtimeGateway', () => {
    const db = new DatabaseSync(':memory:');
    const storage = new SqlitePlatformStorage(db);
    const messageStore = new SqliteWebMessageStore(db);
    const gateway = new TestOnlyRuntimeGateway({ storage, messageStore });

    expect(() => {
      new PlatformServer({
        database: db,
        runtimeGateway: gateway,
        cookieSecret: validSecret32,
        csrfToken: validCsrf32,
      });
    }).not.toThrow();
  });

  it('constructor rejects unknown configuration options or deprecated allowedOrigins', () => {
    const db = new DatabaseSync(':memory:');
    const storage = new SqlitePlatformStorage(db);
    const messageStore = new SqliteWebMessageStore(db);
    const gateway = new TestOnlyRuntimeGateway({ storage, messageStore });

    // 1. Top-level unknown option
    expect(() => {
      // @ts-expect-error testing runtime rejection of unknown option
      new PlatformServer({
        database: db,
        runtimeGateway: gateway,
        cookieSecret: validSecret32,
        csrfToken: validCsrf32,
        allowedOrigins: ['http://127.0.0.1:4000'],
      });
    }).toThrow(PlatformConfigurationError);

    // 2. Limits unknown option / deprecated allowedOrigins
    expect(() => {
      new PlatformServer({
        database: db,
        runtimeGateway: gateway,
        cookieSecret: validSecret32,
        csrfToken: validCsrf32,
        limits: {
          // @ts-expect-error testing runtime rejection of allowedOrigins in limits
          allowedOrigins: ['http://127.0.0.1:4000'],
        },
      });
    }).toThrow(PlatformConfigurationError);

    expect(() => {
      new PlatformServer({
        database: db,
        runtimeGateway: gateway,
        cookieSecret: validSecret32,
        csrfToken: validCsrf32,
        limits: {
          // @ts-expect-error testing runtime rejection of unknown limit
          unknownLimitKey: 12345,
        },
      });
    }).toThrow(PlatformConfigurationError);
  });

  it('constructor enforces XOR between dbPath and database options', () => {
    const db = new DatabaseSync(':memory:');
    const storage = new SqlitePlatformStorage(db);
    const messageStore = new SqliteWebMessageStore(db);
    const gateway = new TestOnlyRuntimeGateway({ storage, messageStore });

    // 1. Both dbPath and database -> rejects
    expect(() => {
      new PlatformServer({
        dbPath: ':memory:',
        database: db,
        runtimeGateway: gateway,
        cookieSecret: validSecret32,
        csrfToken: validCsrf32,
      });
    }).toThrow(PlatformConfigurationError);

    try {
      new PlatformServer({
        dbPath: ':memory:',
        database: db,
        runtimeGateway: gateway,
        cookieSecret: validSecret32,
        csrfToken: validCsrf32,
      });
    } catch (err: any) {
      expect(err.message).toContain('Cannot provide both "dbPath" and "database"');
    }

    // 2. Only dbPath -> succeeds
    expect(() => {
      new PlatformServer({
        dbPath: ':memory:',
        runtimeGateway: gateway,
        cookieSecret: validSecret32,
        csrfToken: validCsrf32,
      });
    }).not.toThrow();

    // 3. Only database -> succeeds
    expect(() => {
      new PlatformServer({
        database: db,
        runtimeGateway: gateway,
        cookieSecret: validSecret32,
        csrfToken: validCsrf32,
      });
    }).not.toThrow();

    // 4. Neither dbPath nor database -> defaults to :memory: and succeeds
    expect(() => {
      new PlatformServer({
        runtimeGateway: gateway,
        cookieSecret: validSecret32,
        csrfToken: validCsrf32,
      });
    }).not.toThrow();
  });

  it('constructor strictly rejects removed aliases (operations, taskProducer, quotaOperations, profileService)', () => {
    const db = new DatabaseSync(':memory:');
    const storage = new SqlitePlatformStorage(db);
    const messageStore = new SqliteWebMessageStore(db);
    const gateway = new TestOnlyRuntimeGateway({ storage, messageStore });

    // operations alias
    expect(() => {
      new PlatformServer({
        database: db,
        runtimeGateway: gateway,
        cookieSecret: validSecret32,
        csrfToken: validCsrf32,
        // @ts-expect-error testing removed operations alias
        operations: {} as any,
      });
    }).toThrow(PlatformConfigurationError);

    // taskProducer alias
    expect(() => {
      new PlatformServer({
        database: db,
        runtimeGateway: gateway,
        cookieSecret: validSecret32,
        csrfToken: validCsrf32,
        // @ts-expect-error testing removed taskProducer alias
        taskProducer: {} as any,
      });
    }).toThrow(PlatformConfigurationError);

    // quotaOperations alias
    expect(() => {
      new PlatformServer({
        database: db,
        runtimeGateway: gateway,
        cookieSecret: validSecret32,
        csrfToken: validCsrf32,
        // @ts-expect-error testing removed quotaOperations alias
        quotaOperations: {} as any,
      });
    }).toThrow(PlatformConfigurationError);

    // profileService alias
    expect(() => {
      new PlatformServer({
        database: db,
        runtimeGateway: gateway,
        cookieSecret: validSecret32,
        csrfToken: validCsrf32,
        // @ts-expect-error testing removed profileService alias
        profileService: {} as any,
      });
    }).toThrow(PlatformConfigurationError);
  });

  it('exposes concrete operationsProvider and quotaProvider on PlatformServer instance', () => {
    const db = new DatabaseSync(':memory:');
    const storage = new SqlitePlatformStorage(db);
    const messageStore = new SqliteWebMessageStore(db);
    const gateway = new TestOnlyRuntimeGateway({ storage, messageStore });

    const server = new PlatformServer({
      database: db,
      runtimeGateway: gateway,
      cookieSecret: validSecret32,
      csrfToken: validCsrf32,
    });

    expect(server.operationsProvider).toBeDefined();
    expect(typeof server.operationsProvider.createTask).toBe('function');
    expect(typeof server.operationsProvider.cancelTask).toBe('function');
    expect(typeof server.operationsProvider.getTask).toBe('function');
    expect(typeof server.operationsProvider.setQuotaLimit).toBe('function');
    expect(typeof server.operationsProvider.checkQuota).toBe('function');
    expect(server.quotaProvider).toBeDefined();
  });

  it('strict getPort and getUrl behavior before, during and after lifecycle', async () => {
    const db = new DatabaseSync(':memory:');
    const storage = new SqlitePlatformStorage(db);
    const messageStore = new SqliteWebMessageStore(db);
    const gateway = new TestOnlyRuntimeGateway({ storage, messageStore });

    const server = new PlatformServer({
      database: db,
      runtimeGateway: gateway,
      cookieSecret: validSecret32,
      csrfToken: validCsrf32,
      port: 0,
    });

    // Before start: returns requested port 0
    expect(server.getPort()).toBe(0);
    expect(server.getUrl()).toBe('http://127.0.0.1:0');

    // Start server
    const info = await server.start();
    expect(server.getPort()).toBe(info.port);
    expect(server.getPort()).toBeGreaterThan(0);
    expect(server.getUrl()).toBe(`http://127.0.0.1:${info.port}`);

    // Idempotent start returns same info
    const info2 = await server.start();
    expect(info2.port).toBe(info.port);

    // Stop server
    await server.stop();
    expect(server.getPort()).toBe(0);
    expect(server.getUrl()).toBe('http://127.0.0.1:0');

    // Idempotent stop
    await expect(server.stop()).resolves.not.toThrow();
  });

  it('proves keepalive connection does not deadlock shutdown and completes swiftly', async () => {
    const db = new DatabaseSync(':memory:');
    const storage = new SqlitePlatformStorage(db);
    const messageStore = new SqliteWebMessageStore(db);
    const gateway = new TestOnlyRuntimeGateway({ storage, messageStore });

    const server = new PlatformServer({
      database: db,
      runtimeGateway: gateway,
      cookieSecret: validSecret32,
      csrfToken: validCsrf32,
      port: 0,
    });

    const info = await server.start();

    // Open keepalive connection and leave it open without sending data
    const keepaliveSocket = createConnection({ host: info.host, port: info.port });
    keepaliveSocket.on('error', () => {}); // Catch ECONNRESET upon server-side socket.destroy()
    await new Promise<void>((resolve) => keepaliveSocket.on('connect', resolve));

    const socketClosedPromise = new Promise<void>((resolve) => {
      keepaliveSocket.on('close', () => resolve());
    });

    // Stop server with keepalive socket connected. Must resolve within 2 seconds without deadlock.
    const stopPromise = server.stop();
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Shutdown deadlocked on keepalive socket')), 2000));

    await expect(Promise.race([stopPromise, timeoutPromise])).resolves.toBeUndefined();
    await socketClosedPromise;
    expect(server.getPort()).toBe(0);
  });

  it('proves strict shutdown sequence order: worker -> gateway drain -> sockets destroy -> close promise', async () => {
    const db = new DatabaseSync(':memory:');
    const storage = new SqlitePlatformStorage(db);
    const messageStore = new SqliteWebMessageStore(db);

    const eventOrder: string[] = [];

    // Mock worker tracking stop call
    const mockWorker = {
      start: async () => {
        eventOrder.push('worker_start');
      },
      stop: async (args: { abortInFlight: boolean }) => {
        expect(args.abortInFlight).toBe(true);
        eventOrder.push('worker_stop');
      },
    } as any;

    // Mock drainable gateway tracking drain call
    const mockDrainableGateway = {
      ...new TestOnlyRuntimeGateway({ storage, messageStore }),
      redriveHeld: async () => 0,
      drain: async (timeoutMs: number) => {
        // Assert worker was stopped BEFORE gateway is drained
        expect(eventOrder).toContain('worker_stop');
        eventOrder.push(`gateway_drain_${timeoutMs}`);
      },
    };

    const server = new PlatformServer({
      database: db,
      runtimeGateway: mockDrainableGateway as any,
      cookieSecret: validSecret32,
      csrfToken: validCsrf32,
      taskWorker: mockWorker,
      port: 0,
    });

    const info = await server.start();
    expect(eventOrder).toContain('worker_start');

    // Open client socket
    const socket = createConnection({ host: info.host, port: info.port });
    socket.on('error', () => {});
    await new Promise<void>((resolve) => socket.on('connect', resolve));

    const socketClosedPromise = new Promise<void>((resolve) => {
      socket.on('close', () => {
        eventOrder.push('socket_closed');
        resolve();
      });
    });

    await server.stop();
    await socketClosedPromise;

    // Verify order: worker_start -> worker_stop -> gateway_drain_3000 -> socket_closed
    expect(eventOrder).toEqual([
      'worker_start',
      'worker_stop',
      'gateway_drain_3000',
      'socket_closed',
    ]);
  });

  it('shutdown collects multiple errors with fixed AggregateError message preserving causes and ensures clean state', async () => {
    const db = new DatabaseSync(':memory:');
    const storage = new SqlitePlatformStorage(db);
    const messageStore = new SqliteWebMessageStore(db);

    const mockFailingWorker = {
      start: async () => {},
      stop: async () => {
        throw new Error('Simulated worker stop failure');
      },
    } as any;

    const mockFailingGateway = {
      ...new TestOnlyRuntimeGateway({ storage, messageStore }),
      redriveHeld: async () => 0,
      drain: async () => {
        throw new Error('Simulated gateway drain failure');
      },
    };

    const server = new PlatformServer({
      database: db,
      runtimeGateway: mockFailingGateway as any,
      cookieSecret: validSecret32,
      csrfToken: validCsrf32,
      taskWorker: mockFailingWorker,
      port: 0,
    });

    await server.start();

    // Shutdown must throw AggregateError
    try {
      await server.stop();
      expect.unreachable('Should have thrown AggregateError');
    } catch (err: any) {
      expect(err).toBeInstanceOf(AggregateError);
      expect(err.message).toBe('Multiple errors occurred during PlatformServer shutdown.');
      expect(err.errors.length).toBe(2);
    }

    // Verify server state was cleaned up despite errors
    expect(server.getPort()).toBe(0);
    expect(server.getUrl()).toBe('http://127.0.0.1:0');
  });

  it('startup rollback gracefully rolls back started worker and cleans up on listen failure', async () => {
    const db1 = new DatabaseSync(':memory:');
    const storage1 = new SqlitePlatformStorage(db1);
    const messageStore1 = new SqliteWebMessageStore(db1);
    const gateway1 = new TestOnlyRuntimeGateway({ storage: storage1, messageStore: messageStore1 });

    const db2 = new DatabaseSync(':memory:');
    const storage2 = new SqlitePlatformStorage(db2);
    const messageStore2 = new SqliteWebMessageStore(db2);
    const gateway2 = new TestOnlyRuntimeGateway({ storage: storage2, messageStore: messageStore2 });

    let workerStarted = false;
    let workerStopped = false;
    const mockWorker = {
      start: async () => {
        workerStarted = true;
      },
      stop: async (args: { abortInFlight: boolean }) => {
        expect(args.abortInFlight).toBe(true);
        workerStopped = true;
      },
    } as any;

    // Start a first server to hold port
    const existingServer = new PlatformServer({
      database: db1,
      runtimeGateway: gateway1,
      cookieSecret: validSecret32,
      csrfToken: validCsrf32,
      port: 0,
    });
    const existingInfo = await existingServer.start();

    // Start a second server attempting to bind to the exact same port (causes EADDRINUSE)
    const conflictingServer = new PlatformServer({
      database: db2,
      runtimeGateway: gateway2,
      cookieSecret: validSecret32,
      csrfToken: validCsrf32,
      taskWorker: mockWorker,
      port: existingInfo.port,
    });

    try {
      await expect(conflictingServer.start()).rejects.toThrow();
      expect(workerStarted).toBe(true);
      expect(workerStopped).toBe(true);
      expect(conflictingServer.getPort()).toBe(existingInfo.port);
    } finally {
      await existingServer.stop();
    }
  });

  it('startup rollback throws AggregateError when both startup and rollback encounter failures', async () => {
    const db1 = new DatabaseSync(':memory:');
    const storage1 = new SqlitePlatformStorage(db1);
    const messageStore1 = new SqliteWebMessageStore(db1);
    const gateway1 = new TestOnlyRuntimeGateway({ storage: storage1, messageStore: messageStore1 });

    const db2 = new DatabaseSync(':memory:');
    const storage2 = new SqlitePlatformStorage(db2);
    const messageStore2 = new SqliteWebMessageStore(db2);
    const gateway2 = new TestOnlyRuntimeGateway({ storage: storage2, messageStore: messageStore2 });

    const mockFailingRollbackWorker = {
      start: async () => {},
      stop: async () => {
        throw new Error('Simulated rollback worker stop failure');
      },
    } as any;

    const existingServer = new PlatformServer({
      database: db1,
      runtimeGateway: gateway1,
      cookieSecret: validSecret32,
      csrfToken: validCsrf32,
      port: 0,
    });
    const existingInfo = await existingServer.start();

    const conflictingServer = new PlatformServer({
      database: db2,
      runtimeGateway: gateway2,
      cookieSecret: validSecret32,
      csrfToken: validCsrf32,
      taskWorker: mockFailingRollbackWorker,
      port: existingInfo.port,
    });

    try {
      await expect(conflictingServer.start()).rejects.toThrow(AggregateError);
    } finally {
      await existingServer.stop();
    }
  });

  it('validateCsrf enforces socket authority, Host header format, and AND semantics', () => {
    const options = { csrfToken: validCsrf32 };

    // 0. Missing or invalid socket -> throws
    const fakeReqNoSocket = {
      method: 'POST',
      headers: { host: '127.0.0.1:4000', origin: 'http://127.0.0.1:4000', 'x-enkeep-csrf': validCsrf32 },
    } as unknown as import('node:http').IncomingMessage;
    expect(() => validateCsrf(fakeReqNoSocket, options)).toThrow(CsrfViolationError);

    const fakeReqNoLocalAddress = {
      method: 'POST',
      headers: { host: '127.0.0.1:4000', origin: 'http://127.0.0.1:4000', 'x-enkeep-csrf': validCsrf32 },
      socket: { localPort: 4000 },
    } as unknown as import('node:http').IncomingMessage;
    expect(() => validateCsrf(fakeReqNoLocalAddress, options)).toThrow(CsrfViolationError);

    const fakeReqNoLocalPort = {
      method: 'POST',
      headers: { host: '127.0.0.1:4000', origin: 'http://127.0.0.1:4000', 'x-enkeep-csrf': validCsrf32 },
      socket: { localAddress: '127.0.0.1' },
    } as unknown as import('node:http').IncomingMessage;
    expect(() => validateCsrf(fakeReqNoLocalPort, options)).toThrow(CsrfViolationError);

    const fakeReqZeroPort = {
      method: 'POST',
      headers: { host: '127.0.0.1:0', origin: 'http://127.0.0.1:0', 'x-enkeep-csrf': validCsrf32 },
      socket: { localAddress: '127.0.0.1', localPort: 0 },
    } as unknown as import('node:http').IncomingMessage;
    expect(() => validateCsrf(fakeReqZeroPort, options)).toThrow(CsrfViolationError);

    const fakeReqFloatPort = {
      method: 'POST',
      headers: { host: '127.0.0.1:4000', origin: 'http://127.0.0.1:4000', 'x-enkeep-csrf': validCsrf32 },
      socket: { localAddress: '127.0.0.1', localPort: 4000.5 },
    } as unknown as import('node:http').IncomingMessage;
    expect(() => validateCsrf(fakeReqFloatPort, options)).toThrow(CsrfViolationError);

    const fakeReqStringPort = {
      method: 'POST',
      headers: { host: '127.0.0.1:4000', origin: 'http://127.0.0.1:4000', 'x-enkeep-csrf': validCsrf32 },
      socket: { localAddress: '127.0.0.1', localPort: '4000' },
    } as unknown as import('node:http').IncomingMessage;
    expect(() => validateCsrf(fakeReqStringPort, options)).toThrow(CsrfViolationError);

    const fakeReqBadSocketAddr = {
      method: 'POST',
      headers: { host: '127.0.0.1:4000', origin: 'http://127.0.0.1:4000', 'x-enkeep-csrf': validCsrf32 },
      socket: { localAddress: '::1', localPort: 4000 },
    } as unknown as import('node:http').IncomingMessage;
    expect(() => validateCsrf(fakeReqBadSocketAddr, options)).toThrow(CsrfViolationError);

    const fakeReqIPv4Mapped = {
      method: 'POST',
      headers: { host: '127.0.0.1:4000', origin: 'http://127.0.0.1:4000', 'x-enkeep-csrf': validCsrf32 },
      socket: { localAddress: '::ffff:127.0.0.1', localPort: 4000 },
    } as unknown as import('node:http').IncomingMessage;
    expect(() => validateCsrf(fakeReqIPv4Mapped, options)).toThrow(CsrfViolationError);

    // 1. Missing both token and origin -> throws
    const fakePostReqNoHeader = {
      method: 'POST',
      headers: { host: '127.0.0.1:4000' },
      socket: { localAddress: '127.0.0.1', localPort: 4000 },
    } as unknown as import('node:http').IncomingMessage;
    expect(() => validateCsrf(fakePostReqNoHeader, options)).toThrow(CsrfViolationError);

    // 2. Good origin, but missing CSRF token -> throws
    const fakePostReqMissingToken = {
      method: 'POST',
      headers: {
        host: '127.0.0.1:4000',
        origin: 'http://127.0.0.1:4000',
      },
      socket: { localAddress: '127.0.0.1', localPort: 4000 },
    } as unknown as import('node:http').IncomingMessage;
    expect(() => validateCsrf(fakePostReqMissingToken, options)).toThrow(CsrfViolationError);

    // 3. Good token, but missing origin -> throws
    const fakePostReqMissingOrigin = {
      method: 'POST',
      headers: {
        host: '127.0.0.1:4000',
        'x-enkeep-csrf': validCsrf32,
      },
      socket: { localAddress: '127.0.0.1', localPort: 4000 },
    } as unknown as import('node:http').IncomingMessage;
    expect(() => validateCsrf(fakePostReqMissingOrigin, options)).toThrow(CsrfViolationError);

    // 4. Bad token + good origin -> throws
    const fakePostReqBadTokenGoodOrigin = {
      method: 'POST',
      headers: {
        host: '127.0.0.1:4000',
        origin: 'http://127.0.0.1:4000',
        'x-enkeep-csrf': 'wrong-token-value-with-32-characters-exact!',
      },
      socket: { localAddress: '127.0.0.1', localPort: 4000 },
    } as unknown as import('node:http').IncomingMessage;
    expect(() => validateCsrf(fakePostReqBadTokenGoodOrigin, options)).toThrow(CsrfViolationError);

    // 5. Good token + bad/spoofed Origin (e.g. http://127.0.0.1.evil.com) -> throws
    const fakePostReqGoodTokenBadOrigin = {
      method: 'POST',
      headers: {
        host: '127.0.0.1:4000',
        origin: 'http://127.0.0.1.evil.com',
        'x-enkeep-csrf': validCsrf32,
      },
      socket: { localAddress: '127.0.0.1', localPort: 4000 },
    } as unknown as import('node:http').IncomingMessage;
    expect(() => validateCsrf(fakePostReqGoodTokenBadOrigin, options)).toThrow(CsrfViolationError);

    // 6. Good token + forbidden localhost Origin -> throws
    const fakePostReqGoodTokenLocalhost = {
      method: 'POST',
      headers: {
        host: '127.0.0.1:4000',
        origin: 'http://localhost:4000',
        'x-enkeep-csrf': validCsrf32,
      },
      socket: { localAddress: '127.0.0.1', localPort: 4000 },
    } as unknown as import('node:http').IncomingMessage;
    expect(() => validateCsrf(fakePostReqGoodTokenLocalhost, options)).toThrow(CsrfViolationError);

    // 7. HTTPS Origin rejected
    const fakePostReqHttps = {
      method: 'POST',
      headers: {
        host: '127.0.0.1:4000',
        origin: 'https://127.0.0.1:4000',
        'x-enkeep-csrf': validCsrf32,
      },
      socket: { localAddress: '127.0.0.1', localPort: 4000 },
    } as unknown as import('node:http').IncomingMessage;
    expect(() => validateCsrf(fakePostReqHttps, options)).toThrow(CsrfViolationError);

    // 8. Referer cannot substitute missing Origin
    const fakePostReqRefererOnly = {
      method: 'POST',
      headers: {
        host: '127.0.0.1:4000',
        referer: 'http://127.0.0.1:4000',
        'x-enkeep-csrf': validCsrf32,
      },
      socket: { localAddress: '127.0.0.1', localPort: 4000 },
    } as unknown as import('node:http').IncomingMessage;
    expect(() => validateCsrf(fakePostReqRefererOnly, options)).toThrow(CsrfViolationError);

    // 9. Host header with comma, whitespace, userinfo, scheme, leading zeros rejected
    const badHosts = [
      '127.0.0.1:4000, 127.0.0.1:4000',
      ' 127.0.0.1:4000',
      'user@127.0.0.1:4000',
      'http://127.0.0.1:4000',
      '127.0.0.1:04000',
      '127.0.0.1:4000.',
      'localhost:4000',
      '127.0.0.1:5000', // Port mismatch with socket localPort 4000
    ];
    for (const bh of badHosts) {
      const fakeBadHostReq = {
        method: 'POST',
        headers: {
          host: bh,
          origin: 'http://127.0.0.1:4000',
          'x-enkeep-csrf': validCsrf32,
        },
        socket: { localAddress: '127.0.0.1', localPort: 4000 },
      } as unknown as import('node:http').IncomingMessage;
      expect(() => validateCsrf(fakeBadHostReq, options)).toThrow(CsrfViolationError);
    }

    // 10. Duplicate/comma origin and token rejected
    const fakeDupOrigin = {
      method: 'POST',
      headers: {
        host: '127.0.0.1:4000',
        origin: 'http://127.0.0.1:4000, http://127.0.0.1:4000',
        'x-enkeep-csrf': validCsrf32,
      },
      socket: { localAddress: '127.0.0.1', localPort: 4000 },
    } as unknown as import('node:http').IncomingMessage;
    expect(() => validateCsrf(fakeDupOrigin, options)).toThrow(CsrfViolationError);

    const fakeDupToken = {
      method: 'POST',
      headers: {
        host: '127.0.0.1:4000',
        origin: 'http://127.0.0.1:4000',
        'x-enkeep-csrf': [validCsrf32, validCsrf32],
      },
      socket: { localAddress: '127.0.0.1', localPort: 4000 },
    } as unknown as import('node:http').IncomingMessage;
    expect(() => validateCsrf(fakeDupToken, options)).toThrow(CsrfViolationError);

    // 11. Legacy / alias header x-csrf-token is rejected
    const fakeAliasCsrfReq = {
      method: 'POST',
      headers: {
        host: '127.0.0.1:4000',
        origin: 'http://127.0.0.1:4000',
        'x-csrf-token': validCsrf32,
      },
      socket: { localAddress: '127.0.0.1', localPort: 4000 },
    } as unknown as import('node:http').IncomingMessage;
    expect(() => validateCsrf(fakeAliasCsrfReq, options)).toThrow(CsrfViolationError);

    // 12. Good token + Good loopback Origin with exact matching host -> succeeds
    const fakePostReqValid = {
      method: 'POST',
      headers: {
        host: '127.0.0.1:4000',
        origin: 'http://127.0.0.1:4000',
        'x-enkeep-csrf': validCsrf32,
      },
      socket: {
        localAddress: '127.0.0.1',
        localPort: 4000,
      },
    } as unknown as import('node:http').IncomingMessage;
    expect(() => validateCsrf(fakePostReqValid, options)).not.toThrow();

    // 13. Safe method (GET/HEAD) with no token or origin -> succeeds
    const fakeGetReq = {
      method: 'GET',
      headers: {
        host: '127.0.0.1:4000',
      },
      socket: {
        localAddress: '127.0.0.1',
        localPort: 4000,
      },
    } as unknown as import('node:http').IncomingMessage;
    expect(() => validateCsrf(fakeGetReq, options)).not.toThrow();

    // 14. Safe method with matching Origin -> succeeds; with mismatched Origin -> throws
    const fakeGetReqWithMatchingOrigin = {
      method: 'GET',
      headers: {
        host: '127.0.0.1:4000',
        origin: 'http://127.0.0.1:4000',
      },
      socket: {
        localAddress: '127.0.0.1',
        localPort: 4000,
      },
    } as unknown as import('node:http').IncomingMessage;
    expect(() => validateCsrf(fakeGetReqWithMatchingOrigin, options)).not.toThrow();

    const fakeGetReqWithBadOrigin = {
      method: 'GET',
      headers: {
        host: '127.0.0.1:4000',
        origin: 'http://evil.com',
      },
      socket: {
        localAddress: '127.0.0.1',
        localPort: 4000,
      },
    } as unknown as import('node:http').IncomingMessage;
    expect(() => validateCsrf(fakeGetReqWithBadOrigin, options)).toThrow(CsrfViolationError);
  });

  it('SqliteWebMessageStore constructor must not execute raw DDL', () => {
    const db = new DatabaseSync(':memory:');
    // Instantiate SqliteWebMessageStore directly
    new SqliteWebMessageStore(db);

    // Verify no tables were created by the constructor
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).not.toContain('web_messages');
    expect(tableNames).not.toContain('web_events');
  });

  it('PlatformServerMigrationRunner applies combined manifest migrations with version history and checksums', async () => {
    const db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);

    // Prior to migration, version is 0
    const v0 = await runner.getCurrentVersion();
    expect(v0).toBe(0);

    // Run combined migrations
    const applied = await runner.migrate(ALL_PLATFORM_MIGRATIONS);
    expect(applied.length).toBe(ALL_PLATFORM_MIGRATIONS.length);

    const vCurrent = await runner.getCurrentVersion();
    expect(vCurrent).toBe(ALL_PLATFORM_MIGRATIONS[ALL_PLATFORM_MIGRATIONS.length - 1].version);

    // Verify web_messages and web_events tables exist
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('web_messages');
    expect(tableNames).toContain('web_events');
    expect(tableNames).toContain('_schema_migrations');

    // Idempotent migration should apply 0 additional migrations
    const reapply = await runner.migrate(ALL_PLATFORM_MIGRATIONS);
    expect(reapply.length).toBe(0);

    // Checksum verification passes
    await expect(runner.validateAppliedMigrations(ALL_PLATFORM_MIGRATIONS)).resolves.not.toThrow();
  });

  it('rolls back both DDL alterations and _schema_migrations when a migration step fails', async () => {
    const db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);

    const validManifest = [
      { version: 1, name: 'v1', upSql: 'CREATE TABLE base_table (id TEXT PRIMARY KEY);' },
    ];
    await runner.migrate(validManifest);

    const failingManifest = [
      { version: 1, name: 'v1', upSql: 'CREATE TABLE base_table (id TEXT PRIMARY KEY);' },
      {
        version: 2,
        name: 'v2_bad',
        upSql: 'ALTER TABLE base_table ADD COLUMN col1 TEXT; INVALID SQL SYNTAX ERROR HERE;',
      },
    ];

    await expect(runner.migrate(failingManifest)).rejects.toThrow();

    // Verify version is still 1 and col1 was rolled back by SQLite DDL transaction
    const v = await runner.getCurrentVersion();
    expect(v).toBe(1);

    // Verify col1 does not exist on base_table
    const cols = db.prepare("PRAGMA table_info('base_table')").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).not.toContain('col1');
  });

  it('proves concurrent PlatformServerMigrationRunner across three independent DB connections resolves cleanly', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'enkeep-server-mig-race3-'));
    const dbPath = join(tempDir, 'server-mig3.db');

    try {
      const db1 = new DatabaseSync(dbPath);
      const db2 = new DatabaseSync(dbPath);
      const db3 = new DatabaseSync(dbPath);
      db1.exec('PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL;');
      db2.exec('PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL;');
      db3.exec('PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL;');

      const runner1 = new PlatformServerMigrationRunner(db1);
      const runner2 = new PlatformServerMigrationRunner(db2);
      const runner3 = new PlatformServerMigrationRunner(db3);

      const [res1, res2, res3] = await Promise.all([
        runner1.migrate(ALL_PLATFORM_MIGRATIONS),
        runner2.migrate(ALL_PLATFORM_MIGRATIONS),
        runner3.migrate(ALL_PLATFORM_MIGRATIONS),
      ]);

      const totalApplied = res1.length + res2.length + res3.length;
      expect(totalApplied).toBe(ALL_PLATFORM_MIGRATIONS.length);

      expect(await runner1.getCurrentVersion()).toBe(ALL_PLATFORM_MIGRATIONS.length);
      expect(await runner2.getCurrentVersion()).toBe(ALL_PLATFORM_MIGRATIONS.length);
      expect(await runner3.getCurrentVersion()).toBe(ALL_PLATFORM_MIGRATIONS.length);

      // Running again on all is cleanly idempotent
      const [re1, re2, re3] = await Promise.all([
        runner1.migrate(ALL_PLATFORM_MIGRATIONS),
        runner2.migrate(ALL_PLATFORM_MIGRATIONS),
        runner3.migrate(ALL_PLATFORM_MIGRATIONS),
      ]);
      expect(re1.length).toBe(0);
      expect(re2.length).toBe(0);
      expect(re3.length).toBe(0);

      db1.close();
      db2.close();
      db3.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('proves concurrent PlatformServerMigrationRunner across two independent DB connections resolves idempotently', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'enkeep-server-mig-race-'));
    const dbPath = join(tempDir, 'server-mig.db');

    try {
      const db1 = new DatabaseSync(dbPath);
      const db2 = new DatabaseSync(dbPath);
      db1.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
      db2.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');

      const runner1 = new PlatformServerMigrationRunner(db1);
      const runner2 = new PlatformServerMigrationRunner(db2);

      const [res1, res2] = await Promise.all([
        runner1.migrate(ALL_PLATFORM_MIGRATIONS),
        runner2.migrate(ALL_PLATFORM_MIGRATIONS),
      ]);

      const totalApplied = res1.length + res2.length;
      expect(totalApplied).toBe(ALL_PLATFORM_MIGRATIONS.length);

      expect(await runner1.getCurrentVersion()).toBe(ALL_PLATFORM_MIGRATIONS.length);
      expect(await runner2.getCurrentVersion()).toBe(ALL_PLATFORM_MIGRATIONS.length);

      // Running again on both is cleanly idempotent
      const [re1, re2] = await Promise.all([
        runner1.migrate(ALL_PLATFORM_MIGRATIONS),
        runner2.migrate(ALL_PLATFORM_MIGRATIONS),
      ]);
      expect(re1.length).toBe(0);
      expect(re2.length).toBe(0);

      db1.close();
      db2.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects duplicate and gapped migration definitions before touching database', async () => {
    const db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);

    // Gapped version (1, 3)
    await expect(
      runner.migrate([
        { version: 1, name: 'v1', upSql: 'CREATE TABLE t1 (id INT);' },
        { version: 3, name: 'v3', upSql: 'CREATE TABLE t3 (id INT);' },
      ])
    ).rejects.toThrow();

    // Duplicate version
    await expect(
      runner.migrate([
        { version: 1, name: 'v1a', upSql: 'CREATE TABLE t1a (id INT);' },
        { version: 1, name: 'v1b', upSql: 'CREATE TABLE t1b (id INT);' },
      ])
    ).rejects.toThrow();
  });

  it('includes full security headers and cache control headers on server-level timeout (408)', async () => {
    const db = new DatabaseSync(':memory:');
    const storage = new SqlitePlatformStorage(db);
    const messageStore = new SqliteWebMessageStore(db);
    const gateway = new TestOnlyRuntimeGateway({ storage, messageStore });

    const server = new PlatformServer({
      database: db,
      runtimeGateway: gateway,
      cookieSecret: validSecret32,
      csrfToken: validCsrf32,
      port: 0,
      limits: {
        requestTimeoutMs: 50, // 50ms short timeout
      },
    });

    const info = await server.start();
    try {
      // Connect to server socket and send partial headers without finishing to trigger server timeout
      const res = await new Promise<{ status: number; headers: Record<string, string>; body: string }>((resolve, reject) => {
        const client = createConnection({ host: info.host, port: info.port }, () => {
          // Send request line and valid CSRF headers but do not send complete request body to trigger timeout
          client.write(
            `POST /api/auth/login HTTP/1.1\r\n` +
            `Host: 127.0.0.1:${info.port}\r\n` +
            `X-Enkeep-CSRF: ${validCsrf32}\r\n` +
            `Origin: http://127.0.0.1:${info.port}\r\n` +
            `Content-Length: 500\r\n` +
            `Content-Type: application/json\r\n\r\n` +
            `{"partial":`
          );
        });

        let data = '';
        client.on('data', (chunk: Buffer) => {
          data += chunk.toString('utf-8');
        });
        client.on('end', () => {
          const lines = data.split('\r\n');
          const statusLine = lines[0] || '';
          const statusMatch = statusLine.match(/HTTP\/1\.[01]\s+(\d+)/);
          const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
          const headers: Record<string, string> = {};
          let i = 1;
          while (i < lines.length && lines[i] !== '') {
            const colonIdx = lines[i].indexOf(':');
            if (colonIdx > 0) {
              const k = lines[i].slice(0, colonIdx).trim().toLowerCase();
              const v = lines[i].slice(colonIdx + 1).trim();
              headers[k] = v;
            }
            i++;
          }
          const body = lines.slice(i + 1).join('\r\n');
          resolve({ status, headers, body });
        });
        client.on('error', reject);
      });

      expect(res.status).toBe(408);
      expect(res.headers['content-security-policy']).toBeDefined();
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['cache-control']).toContain('no-store');
      const json = JSON.parse(res.body);
      expect(json.error.code).toBe('REQUEST_TIMEOUT');
    } finally {
      await server.stop();
    }
  });

  it('guarantees published migration checksums for versions 1 to 30 remain strictly immutable', async () => {
    // Expected checksums for published migrations v1 - v31
    const expectedVersions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31];
    const versions = ALL_PLATFORM_MIGRATIONS.map((m) => m.version);
    expect(versions).toEqual(expectedVersions);

    const EXPECTED_IMMUTABLE_CHECKSUMS: Record<number, { name: string; checksum: string }> = {
      1: { name: '001_initial_happyclaw_subset', checksum: 'dad9c52bb64d8435f055bd7305c55689061ea2a0d564123c7d39d12f390804d2' },
      2: { name: '002_route_identity_and_scoped_cursors', checksum: 'f6ce27c7e6946fdc5a31001e994cbca80fd78fe8cdd297f601d52335e60aaac2' },
      3: { name: '003_delivery_inbox', checksum: 'baf34039177bb204c7a07cebc1e649725edd02329e01887ec67d126ed46a9407' },
      4: { name: '004_platform_operations', checksum: '4ee967c4fbdf3b2cb15378d32e2d0668b793fbf8b9882e723626329f63808e42' },
      5: { name: '005_web_messages_and_events', checksum: '8c4ace0600a82c88dd86991e87133751f26c080e06d27a3b70d9a2a7331577e4' },
      6: { name: '006_delivery_inbox_and_idempotency', checksum: '0ec50830b665ac996e02ac6fa6a56646275b308ca1de2bc6bc379f5e7829e6d9' },
      7: { name: '007_delivery_inbox_failed_status', checksum: '53fc0e118aaf108765d50ffa8f8907e08a971178c3c0c2d5653192f19021bf54' },
      8: { name: '008_fixed_import_receipts_and_provenance', checksum: 'f888e8016b93f3360a28cb8f929576dbd84fc29c2af1948b62fdcf2e91033229' },
      9: { name: '009_agent_profiles_lifecycle_and_generations', checksum: '4d749a483ad94df1818ed2fe094f48fe690d6fded34ffb574521d2405ef1c87a' },
      10: { name: '010_quota_bundles_lifecycle', checksum: 'b7250bf990119e44f8325bc790e0a410a353ff13bbaa408a1d86780e2046ee4d' },
      11: { name: '011_model_config_overrides', checksum: 'c0318242a6acc2eb07c61cc6f9f135a7f5f22728326f2173b4813c1a0c569545' },
      12: { name: '012_storage_and_quota_reset_audit', checksum: 'e1a662f85510acd4c12c29ee6a73f5eafebf319f8acad090d14b2f189314216c' },
      13: { name: '013_user_locale_preferences', checksum: '36f643e788e15df5b3173f5eb74a603f5755c52207d98a001e3c2def589ef310' },
      14: { name: '014_file_transfer_journal', checksum: '78e2f7f58c097d0f6689fccdde0530b97152ab1e12b896313337c13eff0bb665' },
      15: { name: '015_message_attachments', checksum: '3ec08a6a2088a949cea4f6993573df9326354f5ee6199fafb412d823bd7dd4c5' },
      16: { name: '016_attachment_snapshot_journal', checksum: '98b94908296e5ca08ded09522a4ed611b6dc282a71ff5f1bc5a71a72d239bf44' },
      17: { name: '017_user_must_change_password', checksum: '1a9a9b213c3bcdb8cd4478b8ac1eaa593dad81deccf2fabc35c43e79ee7ccb64' },
      18: { name: '018_task_schedules_and_runs', checksum: '7342b6075775bf1e15cedd2c732934f8becf7607b9b15401069860beff313fb6' },
      19: { name: '019_fork_reserved', checksum: '00040d6170a26ab74e6a4746c179719913ff63af66950c1c50e2d17a06d19fc7' },
      20: { name: '020_import_jobs', checksum: '896b1a1012980a549c29937124569db23ceb9bc086b96ad6e43b51569df85908' },
      21: { name: '021_skill_packages_and_bindings', checksum: '6d685cd06fa622b8e664ed7bc3ecf0b47169b51adca574dfbafe26755800822d' },
      22: { name: '022_permission_presets', checksum: 'acff7f4dcb4f67b81e48d820a2ae2fdb0930d3d75afe8b475cdae4ecb957efd9' },
      23: { name: '023_model_selection_overrides_and_health', checksum: 'a4ec67ffce69a1878bac9ca4d11ef8277f91733870e40a9c41fe81bb6f67e45a' },
      24: { name: '024_message_references', checksum: 'ca680041da07cfb59eff0bf622e1438b72c7b08f61f3012554f0a540f76b1025' },
      25: { name: '025_runtime_diagnostics', checksum: 'f76f8a45115f2df869cf51a133477238dea756a5b2eecb6660392c5b995f59fd' },
      26: { name: '026_task_notifications', checksum: '00ab3af267f440fd7dcfd14200e837b7f9a4b875033265070b004843a10b80c3' },
      27: { name: '027_session_execution_leases', checksum: 'bcde3379ca17f54b1c505cc41f3c80c3502cc88988facd503fe5345778ff0e8c' },
      28: { name: '028_user_theme_preference', checksum: 'a645934a3ff086fda7776da11020352b40659ee0d914b02f3cb764e0320deaf2' },
      29: { name: '029_space_mounts', checksum: '3a0cfbf18c617310ead07ee98ebb41d2aabbdeab5d0e210a43ec8afd85ca9ff8' },
      30: { name: '030_unified_extension_catalog', checksum: '606421e52d37ec8f010a6b1e45ad2766a198ddb8295c51b2a0c1f11b422420e4' },
      31: { name: '031_generic_channel_tables', checksum: '3ae9433678068bab97db4c7e6a5dd7a0e984fb5391b7ea06be97438fb91e09cf' },
    };

    for (const m of ALL_PLATFORM_MIGRATIONS) {
      const exp = EXPECTED_IMMUTABLE_CHECKSUMS[m.version];
      expect(exp).toBeDefined();
      expect(m.name).toBe(exp.name);
      expect(m.checksum).toBe(exp.checksum);
      expect(computeChecksum(m.upSql)).toBe(exp.checksum);
    }

    // Run migrations v1 to v31 on a fresh database and verify validateAppliedMigrations
    const db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    expect(await runner.getCurrentVersion()).toBe(31);
    await expect(runner.validateAppliedMigrations(ALL_PLATFORM_MIGRATIONS)).resolves.not.toThrow();

    db.close();
  });

  it('validates recovery snapshot DB and demo-data DB with current all migrations without write mismatch (copy snapshot temp)', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'enkeep-mig-snapshot-test-'));
    try {
      const demoDbPath = join(tempDir, 'demo-platform.db');
      copyFileSync(join(__dirname, '../../../.demo-data/platform.db'), demoDbPath);

      const demoDb = new DatabaseSync(demoDbPath);
      const demoRunner = new PlatformServerMigrationRunner(demoDb);
      expect(await demoRunner.getCurrentVersion()).toBe(31);
      // Validates that existing 31 migrations match without mismatch
      const applied = await demoRunner.getAppliedMigrations();
      expect(applied.length).toBe(31);
      expect(applied[0].version).toBe(1);
      expect(applied[0].checksum).toBe(ALL_PLATFORM_MIGRATIONS[0].checksum);
      expect(applied[0].checksum).toBe('dad9c52bb64d8435f055bd7305c55689061ea2a0d564123c7d39d12f390804d2');

      // Verify PRAGMA integrity_check and foreign_key_check
      const integrity = demoDb.prepare('PRAGMA integrity_check;').all() as Array<{ integrity_check: string }>;
      expect(integrity[0].integrity_check).toBe('ok');
      const fk = demoDb.prepare('PRAGMA foreign_key_check;').all();
      expect(fk.length).toBe(0);

      demoDb.close();

      // Test recovery snapshot DB copy if it exists
      const snapSourcePath = join(__dirname, '../../../reports/recovery-snapshots/platform-before-warm-reset-20260830.db');
      if (existsSync(snapSourcePath)) {
        const snapDbPath = join(tempDir, 'snapshot.db');
        copyFileSync(snapSourcePath, snapDbPath);

        const snapDb = new DatabaseSync(snapDbPath);
        const snapRunner = new PlatformServerMigrationRunner(snapDb);
        const snapApplied = await snapRunner.getAppliedMigrations();
        expect(snapApplied.length).toBeGreaterThanOrEqual(1);
        expect(snapApplied[0].version).toBe(1);
        expect(snapApplied[0].checksum).toBe('dad9c52bb64d8435f055bd7305c55689061ea2a0d564123c7d39d12f390804d2');
        expect(snapApplied[0].checksum).toBe(ALL_PLATFORM_MIGRATIONS[0].checksum);

        const snapIntegrity = snapDb.prepare('PRAGMA integrity_check;').all() as Array<{ integrity_check: string }>;
        expect(snapIntegrity[0].integrity_check).toBe('ok');
        const snapFk = snapDb.prepare('PRAGMA foreign_key_check;').all();
        expect(snapFk.length).toBe(0);

        snapDb.close();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('successfully upgrades an existing v8 database through v9 to v10, creating quota_bundles and altering quota_reservations', async () => {
    const db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);

    // Step 1: Migrate up to v8
    await runner.migrate(ALL_PLATFORM_MIGRATIONS.slice(0, 8));
    expect(await runner.getCurrentVersion()).toBe(8);

    // Insert v4 quota reservations and limits to verify data preservation
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
      VALUES ('u_mig_test', 'mig_user', 'hash', 'user', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run();

    db.prepare(`
      INSERT INTO quota_reservations (id, user_id, resource, amount, status, expires_at, created_at)
      VALUES ('res_v4_legacy', 'u_mig_test', 'turns', 1, 'reserved', '2030-01-01T00:00:00.000Z', CURRENT_TIMESTAMP)
    `).run();

    // Verify quota_bundles table does NOT exist at v8
    const tableV8 = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='quota_bundles'").get();
    expect(tableV8).toBeUndefined();

    // Step 2: Migrate all the way to v10
    const upgraded = await runner.migrate(ALL_PLATFORM_MIGRATIONS.slice(0, 10));
    expect(upgraded.length).toBe(2); // v9 and v10 applied
    expect(await runner.getCurrentVersion()).toBe(10);

    // Verify quota_bundles table exists
    const tableV10 = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='quota_bundles'").get() as any;
    expect(tableV10).toBeDefined();
    expect(tableV10.name).toBe('quota_bundles');

    // Verify quota_reservations columns bundle_id and delivery_id exist and legacy data preserved
    const cols = db.prepare("PRAGMA table_info('quota_reservations')").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain('bundle_id');
    expect(colNames).toContain('delivery_id');

    const legacyRes = db.prepare("SELECT * FROM quota_reservations WHERE id = 'res_v4_legacy'").get() as any;
    expect(legacyRes).toBeDefined();
    expect(legacyRes.id).toBe('res_v4_legacy');
    expect(legacyRes.bundle_id).toBeNull();
    expect(legacyRes.delivery_id).toBeNull();

    // Verify foreign key integrity check passes
    const fkCheck = db.prepare('PRAGMA foreign_key_check').all();
    expect(fkCheck.length).toBe(0);

    db.close();
  });

  it('successfully upgrades an existing v10 database through v11, creating model_config_overrides table', async () => {
    const db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);

    // Step 1: Migrate up to v10
    await runner.migrate(ALL_PLATFORM_MIGRATIONS.slice(0, 10));
    expect(await runner.getCurrentVersion()).toBe(10);

    // Verify v11 table does not exist yet
    const mOverV10 = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='model_config_overrides'").get();
    expect(mOverV10).toBeUndefined();

    // Step 2: Migrate to v11
    const upgraded = await runner.migrate(ALL_PLATFORM_MIGRATIONS.slice(0, 11));
    expect(upgraded.length).toBe(1); // v11 applied
    expect(await runner.getCurrentVersion()).toBe(11);

    // Verify table exists
    const mOverV11 = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='model_config_overrides'").get() as any;
    expect(mOverV11).toBeDefined();

    // Verify FK check passes
    const fkCheck = db.prepare('PRAGMA foreign_key_check').all();
    expect(fkCheck.length).toBe(0);

    db.close();
  });

  it('fails loud when quota bundle operations are executed against a pre-v10 database', async () => {
    const db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);

    // Apply only through v8
    await runner.migrate(ALL_PLATFORM_MIGRATIONS.slice(0, 8));

    const { SqliteTenantScopedQuotaLedgerRepository } = await import('@enkeep/platform-storage-sqlite');
    const repo = new SqliteTenantScopedQuotaLedgerRepository(db, 'u_pre_v10');

    await expect(
      repo.reserveBundle({
        sessionId: 'ses_00000000000000000000000000000001',
        deliveryId: 'deliv_00000000000000000000000000000001',
        turns: 1,
        messages: 1,
        tokens: 100,
      })
    ).rejects.toThrow(/no such table: quota_bundles/i);

    db.close();
  });

  it('fails startup if unrecovered pending file transfer journal rows exist without a configured fileProvider/fileService', async () => {
    const db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    const storage = new SqlitePlatformStorage(db);
    const authService = new DefaultAuthService(storage, {
      cookieSecret: 'test-secret-at-least-32-chars-long-ok!',
    });
    const { provisionFixtures } = await import('@enkeep/platform-auth');
    const fixtures = await provisionFixtures(storage, authService, {
      adminPassword: 'AliceAdminPassword123!',
      userPassword: 'BobUserPassword123!',
      disabledPassword: 'CharlieDisabled123!',
    });

    // Seed unrecovered pending row in journal
    db.prepare(`
      INSERT INTO file_transfer_journal (
        id, user_id, space_id, relative_path, stage_token, rollback_token, overwrite, expected_etag, content_sha256, size, idempotency_key, status, response_payload, created_at, updated_at
      ) VALUES ('jrn_unrecovered', ?, ?, 'orphan.txt', '.orphan.stage.tmp', NULL, 0, NULL, 'hash', 10, 'key_1', 'staged', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(fixtures.admin.id, fixtures.adminContainerSpace.id);

    const runtimeGateway = new TestOnlyRuntimeGateway({ storage, messageStore: new (await import('../src/index.js')).SqliteWebMessageStore(db) });

    const server = new PlatformServer({
      database: db,
      authService,
      runtimeGateway,
      cookieSecret: 'test-secret-at-least-32-chars-long-ok!',
      csrfToken: 'test-csrf-token-at-least-32-chars-ok!',
      host: '127.0.0.1',
      port: 0,
    });

    await expect(server.start()).rejects.toThrow(
      /Cannot start PlatformServer with 1 unrecovered pending file transfer records/
    );

    db.close();
  });
});
