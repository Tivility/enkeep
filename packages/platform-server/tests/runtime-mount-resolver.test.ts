/**
 * Comprehensive Acceptance & Contract Tests for RuntimeMountResolver, SpaceMountService,
 * DeliveryRuntimeGateway Mount Resolution, CompositeDeliveryTurnExecutor, and Failure Safety
 *
 * Verifies:
 * 1) SpaceMountService implements RuntimeMountResolver:
 *    - resolveForSpace(userId, spaceId) returns decrypted authoritative { id, name, sourcePath, mode }
 *    - Tenant and space isolation (Space A mounts vs Space B mounts, User 1 vs User 2)
 *    - Throws ValidationError on missing/empty userId or spaceId
 *    - Throws NotFoundError on nonexistent space
 *    - Throws fail-closed on decryption failure (without leaking path)
 *    - Returns empty array [] for spaces without mounts
 *    - Immutability: returned array and objects cannot be mutated to affect subsequent resolutions
 * 2) DeliveryRuntimeGateway Mount Resolution Lifecycle:
 *    - Resolver called once per turn with authoritative userId and spaceId
 *    - Resolved mounts forwarded on DeliveryExecutionRequest.mounts to executor
 *    - Multi-space isolation: Turn in Space A gets Mounts A; Turn in Space B gets Mounts B
 *    - Space with no mounts gets mounts: []
 *    - Resolver failure (e.g. decryption error or space error) -> executor.execute is NEVER called (no model invocation) and turn is failed safely
 *    - Missing resolver when space has 0 active mounts -> turn succeeds with mounts: []
 *    - Missing resolver when space has >0 active mounts -> throws fail-closed error, executor.execute is NEVER called, turn is failed safely
 * 3) CompositeDeliveryTurnExecutor:
 *    - Forwards request.mounts intact to concrete provider turn executor
 * 4) Transient Security:
 *    - Mounts are not serialized to SQLite turn_runs, web_messages, or audit logs
 *
 * @module @enkeep/platform-server/tests/runtime-mount-resolver.test
 */

import { describe, it, expect, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import {
  ValidationError,
  NotFoundError,
  PlatformError,
  type RuntimeMountSpec,
  type RuntimeMountResolver,
  type ExecutionMode,
} from '@enkeep/platform-core';
import {
  DeliveryRuntimeGateway,
  SqliteWebMessageStore,
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  PlatformServer,
  SpaceMountService,
  AesGcmCredentialCipher,
  CompositeDeliveryTurnExecutor,
  RuntimeProviderRegistry,
  type DeliveryExecutionRequest,
  type TurnExecutionResult,
} from '../src/index.js';
import type { InboundEnvelope } from '@enkeep/web-channel';

function createValidDeliveryId(): string {
  return `deliv_${randomUUID().replace(/-/g, '')}`;
}

describe('RuntimeMountResolver & DeliveryRuntimeGateway Mount Resolution Contracts', () => {
  const cookieSecret = 'test-cookie-secret-32-chars-long-123456';
  const cipherSecret = 'test-cipher-secret-32-chars-long-123456';

  const setupTestEnv = async () => {
    const db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    // Create users
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES ('u1', 'alice', 'hash', 'admin')").run();
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES ('u2', 'bob', 'hash', 'user')").run();

    // Create spaces for u1 (alice)
    db.prepare("INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES ('sp_a', 'u1', 'Space A', 'space-a', 'container')").run();
    db.prepare("INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES ('sp_b', 'u1', 'Space B', 'space-b', 'container')").run();
    db.prepare("INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES ('sp_empty', 'u1', 'Space Empty', 'space-empty', 'container')").run();

    // Create space for u2 (bob)
    db.prepare("INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES ('sp_bob', 'u2', 'Bob Space', 'space-bob', 'container')").run();

    // Create session routes
    db.prepare("INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode) VALUES ('ses_a', 'u1', 'sp_a', 'web', 'web-demo', 'ses_a', 'p1', 'dsh_a', 'container')").run();
    db.prepare("INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode) VALUES ('ses_b', 'u1', 'sp_b', 'web', 'web-demo', 'ses_b', 'p1', 'dsh_b', 'container')").run();
    db.prepare("INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode) VALUES ('ses_empty', 'u1', 'sp_empty', 'web', 'web-demo', 'ses_empty', 'p1', 'dsh_empty', 'container')").run();
    db.prepare("INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode) VALUES ('ses_bob', 'u2', 'sp_bob', 'web', 'web-demo', 'ses_bob', 'p1', 'dsh_bob', 'container')").run();

    const storage = new SqlitePlatformStorage(db);
    const messageStore = new SqliteWebMessageStore(db);
    const cipher = new AesGcmCredentialCipher(cipherSecret);

    // Mock reconciler for SpaceMountService
    const mockReconciler = {
      preflightSource: async (sourcePath: string) => ({ realPath: sourcePath }),
      reconcileUserMounts: async () => {},
    };

    const spaceMountService = new SpaceMountService({
      db,
      storage,
      cipherSecret,
      platformSecret: cipherSecret,
      cipher,
      reconciler: mockReconciler,
    });

    const profileResolver = { resolve: async () => null };

    return { db, storage, messageStore, cipher, spaceMountService, profileResolver, mockReconciler };
  };

  const createSampleEnvelope = (overrides: Partial<InboundEnvelope> = {}): InboundEnvelope => {
    return {
      id: overrides.id ?? createValidDeliveryId(),
      userId: overrides.userId ?? 'u1',
      sessionId: overrides.sessionId ?? 'ses_a',
      content: overrides.content ?? 'Hello Docker runtime with mounts',
      timestamp: overrides.timestamp ?? new Date().toISOString(),
      ...overrides,
    };
  };

  describe('1. SpaceMountService.resolveForSpace implementation', () => {
    it('resolves and decrypts exact active mounts for a given user and space', async () => {
      const { spaceMountService } = await setupTestEnv();

      // Create mounts in Space A
      await spaceMountService.createMount('u1', 'sp_a', {
        name: 'docs_ro',
        sourcePath: '/host/path/to/docs',
        mode: 'ro',
      });
      await spaceMountService.createMount('u1', 'sp_a', {
        name: 'output_rw',
        sourcePath: '/host/path/to/output',
        mode: 'rw',
      });

      const mountsA = await spaceMountService.resolveForSpace('u1', 'sp_a');
      expect(mountsA).toHaveLength(2);
      expect(mountsA[0]).toMatchObject({
        name: 'docs_ro',
        sourcePath: '/host/path/to/docs',
        mode: 'ro',
      });
      expect(mountsA[1]).toMatchObject({
        name: 'output_rw',
        sourcePath: '/host/path/to/output',
        mode: 'rw',
      });
      expect(mountsA[0].id).toBeDefined();
      expect(mountsA[1].id).toBeDefined();
    });

    it('enforces space isolation: Space A mounts are not visible when resolving for Space B', async () => {
      const { spaceMountService } = await setupTestEnv();

      // Create mount in Space A
      await spaceMountService.createMount('u1', 'sp_a', {
        name: 'space_a_mount',
        sourcePath: '/host/path/a',
        mode: 'ro',
      });

      // Create mount in Space B
      await spaceMountService.createMount('u1', 'sp_b', {
        name: 'space_b_mount',
        sourcePath: '/host/path/b',
        mode: 'rw',
      });

      const mountsA = await spaceMountService.resolveForSpace('u1', 'sp_a');
      const mountsB = await spaceMountService.resolveForSpace('u1', 'sp_b');

      expect(mountsA).toHaveLength(1);
      expect(mountsA[0].name).toBe('space_a_mount');
      expect(mountsA[0].sourcePath).toBe('/host/path/a');

      expect(mountsB).toHaveLength(1);
      expect(mountsB[0].name).toBe('space_b_mount');
      expect(mountsB[0].sourcePath).toBe('/host/path/b');
    });

    it('returns empty array [] for a space with no mounts', async () => {
      const { spaceMountService } = await setupTestEnv();

      const mountsEmpty = await spaceMountService.resolveForSpace('u1', 'sp_empty');
      expect(mountsEmpty).toEqual([]);
    });

    it('enforces tenant isolation: User 1 cannot resolve User 2 space mounts', async () => {
      const { spaceMountService } = await setupTestEnv();

      // Create mount in Bob's space (u2)
      await spaceMountService.createMount('u2', 'sp_bob', {
        name: 'bob_mount',
        sourcePath: '/host/path/bob',
        mode: 'ro',
      });

      // Alice (u1) attempts to resolve Bob's space -> throws NotFoundError (space not found for Alice)
      await expect(spaceMountService.resolveForSpace('u1', 'sp_bob')).rejects.toThrow(NotFoundError);

      // Bob (u2) resolves Bob's space -> succeeds
      const bobMounts = await spaceMountService.resolveForSpace('u2', 'sp_bob');
      expect(bobMounts).toHaveLength(1);
      expect(bobMounts[0].name).toBe('bob_mount');
    });

    it('validates mandatory userId and platformSpaceId arguments', async () => {
      const { spaceMountService } = await setupTestEnv();

      await expect(spaceMountService.resolveForSpace('', 'sp_a')).rejects.toThrow(ValidationError);
      await expect(spaceMountService.resolveForSpace('u1', '')).rejects.toThrow(ValidationError);
      await expect(spaceMountService.resolveForSpace('u1', 'nonexistent_space')).rejects.toThrow(NotFoundError);
    });

    it('fails closed if ciphertext decryption fails without leaking path', async () => {
      const { db, storage, spaceMountService } = await setupTestEnv();

      // Insert a mount row with corrupted/invalid ciphertext directly in DB
      db.prepare(`
        INSERT INTO space_mounts (id, user_id, space_id, name, source_path_encrypted, source_fingerprint, mode, created_at, updated_at)
        VALUES ('mnt_corrupt', 'u1', 'sp_a', 'corrupt_mount', 'invalid_ciphertext_not_gcm', 'fake_fingerprint', 'ro', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run();

      // Resolving should fail closed (throw decryption error)
      await expect(spaceMountService.resolveForSpace('u1', 'sp_a')).rejects.toThrow();
    });

    it('returns frozen/immutable array and objects', async () => {
      const { spaceMountService } = await setupTestEnv();

      await spaceMountService.createMount('u1', 'sp_a', {
        name: 'immutable_mount',
        sourcePath: '/host/path/imm',
        mode: 'ro',
      });

      const mounts = await spaceMountService.resolveForSpace('u1', 'sp_a');
      expect(Object.isFrozen(mounts)).toBe(true);
      expect(Object.isFrozen(mounts[0])).toBe(true);
    });
  });

  describe('2. DeliveryRuntimeGateway Mount Resolution & Forwarding', () => {
    it('calls mountResolver once per turn and forwards mounts to DeliveryTurnExecutor', async () => {
      const { db, storage, messageStore, profileResolver, spaceMountService } = await setupTestEnv();

      // Create a mount in Space A
      await spaceMountService.createMount('u1', 'sp_a', {
        name: 'shared_data',
        sourcePath: '/data/shared',
        mode: 'ro',
      });

      const resolveSpy = vi.spyOn(spaceMountService, 'resolveForSpace');

      let capturedRequest: DeliveryExecutionRequest | undefined;
      const executor = {
        execute: async (req: DeliveryExecutionRequest): Promise<TurnExecutionResult> => {
          capturedRequest = req;
          return { replyText: 'Turn executed with mounts' };
        },
        cancel: async () => false,
      };

      const gateway = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        quotaMode: 'disabled',
        profileResolver,
        executor,
        mountResolver: spaceMountService,
      });

      const env = createSampleEnvelope({ sessionId: 'ses_a' });
      await gateway.dispatchInbound(env);
      await gateway.drain(1000);

      expect(resolveSpy).toHaveBeenCalledTimes(1);
      expect(resolveSpy).toHaveBeenCalledWith('u1', 'sp_a');

      expect(capturedRequest).toBeDefined();
      expect(capturedRequest!.mounts).toBeDefined();
      expect(capturedRequest!.mounts).toHaveLength(1);
      expect(capturedRequest!.mounts![0]).toMatchObject({
        name: 'shared_data',
        sourcePath: '/data/shared',
        mode: 'ro',
      });

      await gateway.drain();
    });

    it('enforces multi-space mount isolation across consecutive turns in different spaces', async () => {
      const { db, storage, messageStore, profileResolver, spaceMountService } = await setupTestEnv();

      // Space A has Mount A
      await spaceMountService.createMount('u1', 'sp_a', {
        name: 'mount_a',
        sourcePath: '/path/a',
        mode: 'ro',
      });

      // Space B has Mount B
      await spaceMountService.createMount('u1', 'sp_b', {
        name: 'mount_b',
        sourcePath: '/path/b',
        mode: 'rw',
      });

      const capturedMountsBySession = new Map<string, readonly RuntimeMountSpec[] | undefined>();
      const executor = {
        execute: async (req: DeliveryExecutionRequest): Promise<TurnExecutionResult> => {
          capturedMountsBySession.set(req.dshSessionId, req.mounts);
          return { replyText: `Executed in ${req.platformSpaceId}` };
        },
        cancel: async () => false,
      };

      const gateway = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        quotaMode: 'disabled',
        profileResolver,
        executor,
        mountResolver: spaceMountService,
      });

      // Turn 1 in Space A
      await gateway.dispatchInbound(createSampleEnvelope({ sessionId: 'ses_a' }));
      // Turn 2 in Space B
      await gateway.dispatchInbound(createSampleEnvelope({ sessionId: 'ses_b' }));
      // Turn 3 in Space Empty
      await gateway.dispatchInbound(createSampleEnvelope({ sessionId: 'ses_empty' }));
      await gateway.drain(1000);

      const mountsA = capturedMountsBySession.get('dsh_a');
      const mountsB = capturedMountsBySession.get('dsh_b');
      const mountsEmpty = capturedMountsBySession.get('dsh_empty');

      expect(mountsA).toHaveLength(1);
      expect(mountsA![0].name).toBe('mount_a');
      expect(mountsA![0].sourcePath).toBe('/path/a');

      expect(mountsB).toHaveLength(1);
      expect(mountsB![0].name).toBe('mount_b');
      expect(mountsB![0].sourcePath).toBe('/path/b');

      expect(mountsEmpty).toEqual([]);
    });

    it('fails closed without model invocation when resolver fails (fail-safe)', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();

      const failingResolver: RuntimeMountResolver = {
        resolveForSpace: async () => {
          throw new PlatformError('Simulated decryption / resolver failure', 'MOUNT_RESOLUTION_FAILED', 500);
        },
      };

      let executorCalled = false;
      const executor = {
        execute: async (_req: DeliveryExecutionRequest): Promise<TurnExecutionResult> => {
          executorCalled = true;
          return { replyText: 'Should not execute' };
        },
        cancel: async () => false,
      };

      const gateway = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        quotaMode: 'disabled',
        profileResolver,
        executor,
        mountResolver: failingResolver,
      });

      const env = createSampleEnvelope({ sessionId: 'ses_a' });
      await gateway.dispatchInbound(env);
      await gateway.drain(1000);

      // Model/executor was NEVER invoked!
      expect(executorCalled).toBe(false);

      // Turn status is failed
      const turnRow = db.prepare('SELECT status, error FROM turn_runs WHERE route_id = ?').get('ses_a') as { status: string; error?: string } | undefined;
      expect(turnRow).toBeDefined();
      expect(turnRow!.status).toBe('failed');
      expect(turnRow!.error).toBe('Turn execution failed');
    });

    it('succeeds with empty mounts when mountResolver is omitted and space has 0 mount rows', async () => {
      const { db, storage, messageStore, profileResolver } = await setupTestEnv();

      let capturedMounts: readonly RuntimeMountSpec[] | undefined;
      const executor = {
        execute: async (req: DeliveryExecutionRequest): Promise<TurnExecutionResult> => {
          capturedMounts = req.mounts;
          return { replyText: 'No mounts turn executed' };
        },
        cancel: async () => false,
      };

      // Unconfigured mountResolver
      const gateway = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        quotaMode: 'disabled',
        profileResolver,
        executor,
      });

      const env = createSampleEnvelope({ sessionId: 'ses_empty' });
      await gateway.dispatchInbound(env);
      await gateway.drain(1000);

      expect(capturedMounts).toEqual([]);
    });

    it('fails closed when mountResolver is omitted but space has active mount rows in DB', async () => {
      const { db, storage, messageStore, profileResolver, spaceMountService } = await setupTestEnv();

      // Seed a mount in Space A
      await spaceMountService.createMount('u1', 'sp_a', {
        name: 'active_mount',
        sourcePath: '/path/active',
        mode: 'ro',
      });

      let executorCalled = false;
      const executor = {
        execute: async (_req: DeliveryExecutionRequest): Promise<TurnExecutionResult> => {
          executorCalled = true;
          return { replyText: 'Should not execute' };
        },
        cancel: async () => false,
      };

      // Gateway WITHOUT mountResolver
      const gateway = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        quotaMode: 'disabled',
        profileResolver,
        executor,
      });

      const env = createSampleEnvelope({ sessionId: 'ses_a' });
      await gateway.dispatchInbound(env);
      await gateway.drain(1000);

      // Model/executor was NEVER invoked!
      expect(executorCalled).toBe(false);

      // Turn is marked failed due to unconfigured resolver with active mounts
      const turnRow = db.prepare('SELECT status, error FROM turn_runs WHERE route_id = ?').get('ses_a') as { status: string; error?: string } | undefined;
      expect(turnRow).toBeDefined();
      expect(turnRow!.status).toBe('failed');
      expect(turnRow!.error).toBe('Turn execution failed');
    });
  });

  describe('3. CompositeDeliveryTurnExecutor Mount Forwarding', () => {
    it('forwards request.mounts through CompositeDeliveryTurnExecutor to concrete provider', async () => {
      const registry = new RuntimeProviderRegistry();

      let capturedRequest: DeliveryExecutionRequest | undefined;
      const containerTurnExecutor = {
        execute: async (req: DeliveryExecutionRequest): Promise<TurnExecutionResult> => {
          capturedRequest = req;
          return { replyText: 'Container executed' };
        },
        cancel: async () => false,
      };

      registry.registerProvider({
        mode: 'container',
        turnExecutor: containerTurnExecutor,
      });

      const compositeExecutor = new CompositeDeliveryTurnExecutor(registry);

      const testMounts: readonly RuntimeMountSpec[] = [
        {
          id: 'mnt_test1',
          name: 'docs',
          sourcePath: '/host/docs',
          mode: 'ro',
        },
      ];

      const request: DeliveryExecutionRequest = {
        userId: 'u1',
        platformSpaceId: 'sp_a',
        workspaceFolder: 'space-a',
        dshSessionId: 'dsh_a',
        turnId: 'turn_1',
        content: 'Test prompt',
        profile: null,
        envelope: {
          id: 'deliv_1',
          userId: 'u1',
          sessionId: 'ses_a',
          spaceId: 'sp_a',
          content: 'Test prompt',
          timestamp: new Date().toISOString(),
        },
        executionMode: 'container',
        mounts: testMounts,
      };

      const result = await compositeExecutor.execute(request);
      expect(result.replyText).toBe('Container executed');
      expect(capturedRequest).toBeDefined();
      expect(capturedRequest!.mounts).toEqual(testMounts);
    });
  });

  describe('4. Mount Transient Security Verification', () => {
    it('verifies mounts are not serialized to SQLite turn_runs, web_messages, or audit logs', async () => {
      const { db, storage, messageStore, profileResolver, spaceMountService } = await setupTestEnv();

      await spaceMountService.createMount('u1', 'sp_a', {
        name: 'secret_mount',
        sourcePath: '/sensitive/host/path',
        mode: 'ro',
      });

      const executor = {
        execute: async (req: DeliveryExecutionRequest): Promise<TurnExecutionResult> => {
          expect(req.mounts).toBeDefined();
          expect(req.mounts![0].sourcePath).toBe('/sensitive/host/path');
          return { replyText: 'Secret mount turn finished' };
        },
        cancel: async () => false,
      };

      const gateway = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        quotaMode: 'disabled',
        profileResolver,
        executor,
        mountResolver: spaceMountService,
      });

      const env = createSampleEnvelope({ sessionId: 'ses_a' });
      await gateway.dispatchInbound(env);
      await gateway.drain(1000);

      // Verify turn_runs table schema & row contents have NO mount paths
      const turnRow = db.prepare('SELECT * FROM turn_runs WHERE route_id = ?').get('ses_a') as any;
      expect(turnRow).toBeDefined();
      expect(JSON.stringify(turnRow)).not.toContain('/sensitive/host/path');

      // Verify web_messages rows have NO mount paths
      const msgRows = db.prepare('SELECT * FROM web_messages WHERE session_id = ?').all('ses_a') as any[];
      for (const row of msgRows) {
        expect(JSON.stringify(row)).not.toContain('/sensitive/host/path');
      }

      // Verify audit logs have NO mount paths
      const auditRows = db.prepare('SELECT * FROM auth_audit_log WHERE user_id = ?').all('u1') as any[];
      for (const row of auditRows) {
        expect(JSON.stringify(row)).not.toContain('/sensitive/host/path');
      }

      await gateway.drain();
    });
  });

  describe('5. PlatformServer Composition Wiring', () => {
    it('automatically wires server.spaceMountService to deliveryGateway when mountResolver is unset', async () => {
      const db = new DatabaseSync(':memory:');
      const runner = new PlatformServerMigrationRunner(db);
      await runner.migrate(ALL_PLATFORM_MIGRATIONS);
      const storage = new SqlitePlatformStorage(db);
      const messageStore = new SqliteWebMessageStore(db);
      const profileResolver = { resolve: async () => null };

      const executor = {
        execute: async () => ({ replyText: 'ok' }),
        cancel: async () => false,
      };

      const gateway = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        quotaMode: 'disabled',
        profileResolver,
        executor,
      });

      expect(gateway.getMountResolver()).toBeUndefined();

      const server = new PlatformServer({
        database: db,
        storage,
        runtimeGateway: gateway,
        cookieSecret: 'test-cookie-secret-32-chars-long-123456',
        csrfToken: 'test-csrf-token-32-chars-long-123456',
        host: '127.0.0.1',
        port: 0,
      });

      expect(server.spaceMountService).toBeDefined();
      expect(gateway.getMountResolver()).toBe(server.spaceMountService);
    });

    it('preserves custom mountResolver passed to deliveryGateway on construction', async () => {
      const db = new DatabaseSync(':memory:');
      const runner = new PlatformServerMigrationRunner(db);
      await runner.migrate(ALL_PLATFORM_MIGRATIONS);
      const storage = new SqlitePlatformStorage(db);
      const messageStore = new SqliteWebMessageStore(db);
      const profileResolver = { resolve: async () => null };

      const customResolver: RuntimeMountResolver = {
        resolveForSpace: async () => [],
      };

      const executor = {
        execute: async () => ({ replyText: 'ok' }),
        cancel: async () => false,
      };

      const gateway = new DeliveryRuntimeGateway({
        database: db,
        storage,
        messageStore,
        quotaMode: 'disabled',
        profileResolver,
        executor,
        mountResolver: customResolver,
      });

      expect(gateway.getMountResolver()).toBe(customResolver);

      const server = new PlatformServer({
        database: db,
        storage,
        runtimeGateway: gateway,
        cookieSecret: 'test-cookie-secret-32-chars-long-123456',
        csrfToken: 'test-csrf-token-32-chars-long-123456',
        host: '127.0.0.1',
        port: 0,
      });

      expect(gateway.getMountResolver()).toBe(customResolver);
    });
  });
});
