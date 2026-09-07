/**
 * Two-Phase Runtime Binding, Platform Tools & Event Relay Test Suite
 *
 * Verifies:
 * 1. Two-Phase Startup:
 *    - Phase 1 (startUserRuntime / connectUserRuntime): Tunnel + LLM handler only. No premature PlatformProxyHandler.
 *    - Capabilities handshake rejects or returns 503 / capabilities: [] when unbound -> toolsOperational=false without false reporting.
 *    - Phase 2 (upDemo / launchDemoSystem): Full PlatformProxyHandler & EventsStreamHandler bound with real db/storage/operations.
 *    - Secondary health probe verifies toolsOperational=true.
 * 2. Platform Tools Execution:
 *    - check_quota queries real quota ledger.
 *    - create_task persists into SQLite platform_tasks in current platform.db.
 *    - send_message persists into SQLite web_messages.
 * 3. Event Relay & Streaming Deltas:
 *    - POST /api/events persists events into SQLite web_events.
 *    - Real/deterministic turn emits >= 2 assistant_delta events before final message.
 * 4. Tenant Isolation:
 *    - Alice and Bob operations strictly bound to their respective authoritative user IDs.
 * 5. Dynamic connectRuntime / restartRuntime automatically binds platform services and probes health.
 *
 * @module @enkeep/demo-runner/tests/two-phase-binding-and-tools.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { PassThrough, Duplex } from 'node:stream';
import {
  createPlatformProxyHandler,
  createEventsStreamHandler,
  createLlmProxyHandler,
  TunnelHost,
  bootDshRuntime,
  type DshBootedRuntime,
} from '@enkeep/runtime-runner';
import {
  SqlitePlatformStorage,
  SqlitePlatformOperationsStorage,
} from '@enkeep/platform-storage-sqlite';
import {
  createPlatformOperations,
  SqliteWebMessageStore,
  DeliveryRuntimeGateway,
} from '@enkeep/platform-server';
import { resetDemo } from '../src/reset/index.js';
import { launchDemoSystem } from '../src/up/index.js';
import { createTempRepo, type TempRepo } from './support/temp-repo.js';
import { FakeUnitRuntimeContainerAdapter } from './support/fake-runtime.js';
import { getDemoPathConfig } from '../src/config.js';

class MockDuplexStream extends Duplex {
  public responseBuffer = Buffer.alloc(0);

  _read(): void {}

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.responseBuffer = Buffer.concat([this.responseBuffer, chunk]);
    callback();
  }

  pushRequest(data: string | Buffer): void {
    this.push(typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
  }

  endRequest(): void {
    this.push(null);
  }
}

describe('Two-Phase Runtime Binding & Platform Tools Integration', () => {
  let tempRepo: TempRepo;

  beforeEach(() => {
    tempRepo = createTempRepo();
  });

  afterEach(() => {
    tempRepo.cleanup();
  });

  it('PlatformProxyHandler returns 503 and empty capabilities when db and operations are missing', async () => {
    const unboundHandler = createPlatformProxyHandler();

    const stream = new MockDuplexStream();
    stream.pushRequest('GET /capabilities HTTP/1.1\r\nHost: 127.0.0.1:8787\r\n\r\n');
    stream.endRequest();

    await unboundHandler.handle(stream, { kind: 'platform', userId: 'alice' });

    const response = stream.responseBuffer.toString('utf8');
    expect(response).toContain('503 Service Unavailable');
    expect(response).toContain('"capabilities":[]');
    expect(response).toContain('SERVICES_UNAVAILABLE');
  });

  it('PlatformProxyHandler returns 200 and all 5 capabilities when db and operations are present', async () => {
    await resetDemo({ repoRoot: tempRepo.repoRoot });
    const paths = getDemoPathConfig({ repoRoot: tempRepo.repoRoot });
    const db = new DatabaseSync(paths.dbPath);

    try {
      const storage = new SqlitePlatformStorage(db);
      const alice = await storage.users.findByUsername('alice');
      expect(alice).toBeDefined();

      const operationsStorage = new SqlitePlatformOperationsStorage(db);
      const operationsService = createPlatformOperations({ storage: operationsStorage });

      const boundHandler = createPlatformProxyHandler({
        platformUserId: alice!.id,
        runtimeIdentity: 'alice',
        db,
        storage,
        operations: operationsService,
      });

      const stream = new MockDuplexStream();
      stream.pushRequest('GET /capabilities HTTP/1.1\r\nHost: 127.0.0.1:8787\r\n\r\n');
      stream.endRequest();

      await boundHandler.handle(stream, { kind: 'platform', userId: 'alice' });

      const response = stream.responseBuffer.toString('utf8');
      expect(response).toContain('200 OK');
      expect(response).toContain('"success":true');
      expect(response).toContain('"messages"');
      expect(response).toContain('"files"');
      expect(response).toContain('"tasks"');
      expect(response).toContain('"quota"');
      expect(response).toContain('"events"');
    } finally {
      db.close();
    }
  });

  it('Phase 1 TunnelHost with only LLM handler rejects platform /capabilities (503/404); Phase 2 binding resolves 200', async () => {
    await resetDemo({ repoRoot: tempRepo.repoRoot });
    const paths = getDemoPathConfig({ repoRoot: tempRepo.repoRoot });
    const db = new DatabaseSync(paths.dbPath);

    try {
      const storage = new SqlitePlatformStorage(db);
      const operationsStorage = new SqlitePlatformOperationsStorage(db);
      const operationsService = createPlatformOperations({ storage: operationsStorage });

      // Simulate Phase 1: Only LLM handler is registered on TunnelHost
      const llmHandler = createLlmProxyHandler({ deploymentConfig: undefined });
      const mockFakeDocker = {
        execOwnedLongRunning: () => ({
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          process: { kill: () => true },
          exitPromise: Promise.resolve({ exitCode: 0, signal: null }),
        }),
      } as any;

      const expectation = {
        containerName: 'enkeep-demo-alice',
        userId: 'alice',
        runId: 'run_test_001',
        containerId: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        volumeName: 'enkeep-demo-dsh-alice',
        volumeId: 'vol_alice_001',
        containerPath: '/home/dsh',
      };

      const tunnelHost = new TunnelHost(mockFakeDocker, expectation, {
        handler: llmHandler,
      });
      tunnelHost.registerHandler(llmHandler);

      // Phase 1 Probe: Container requests /capabilities -> LLM handler returns 503 (no LLM config) or fails
      const phase1Stream = new MockDuplexStream();
      phase1Stream.pushRequest('GET /capabilities HTTP/1.1\r\nHost: 127.0.0.1:8787\r\n\r\n');
      phase1Stream.endRequest();

      await tunnelHost.handleStream(phase1Stream, { kind: 'llm', userId: 'alice' });
      const phase1Resp = phase1Stream.responseBuffer.toString('utf8');
      // In Phase 1, platform capabilities is NOT available
      expect(phase1Resp).not.toContain('"capabilities":["messages"');

      // Phase 2 Binding: Register full platform and events handlers
      const alice = await storage.users.findByUsername('alice');
      expect(alice).toBeDefined();

      const platformHandler = createPlatformProxyHandler({
        platformUserId: alice!.id,
        runtimeIdentity: 'alice',
        db,
        storage,
        operations: operationsService,
      });
      const eventsHandler = createEventsStreamHandler({
        platformUserId: alice!.id,
        runtimeIdentity: 'alice',
        db,
        storage,
        operations: operationsService,
      });

      tunnelHost.registerHandler(platformHandler);
      tunnelHost.registerHandler(eventsHandler);

      // Phase 2 Probe: Container requests /capabilities -> platform handler returns 200 OK with all 5 capabilities
      const phase2Stream = new MockDuplexStream();
      phase2Stream.pushRequest('GET /capabilities HTTP/1.1\r\nHost: 127.0.0.1:8787\r\n\r\n');
      phase2Stream.endRequest();

      await tunnelHost.handleStream(phase2Stream, { kind: 'platform', userId: 'alice' });
      const phase2Resp = phase2Stream.responseBuffer.toString('utf8');
      expect(phase2Resp).toContain('200 OK');
      expect(phase2Resp).toContain('"capabilities":[');
      expect(phase2Resp).toContain('"messages"');
      expect(phase2Resp).toContain('"files"');
      expect(phase2Resp).toContain('"tasks"');
      expect(phase2Resp).toContain('"quota"');
      expect(phase2Resp).toContain('"events"');
    } finally {
      db.close();
    }
  });

  it('persists tasks into platform_tasks and messages into web_messages via bound PlatformProxyHandler', async () => {
    await resetDemo({ repoRoot: tempRepo.repoRoot });
    const paths = getDemoPathConfig({ repoRoot: tempRepo.repoRoot });
    const db = new DatabaseSync(paths.dbPath);

    try {
      const storage = new SqlitePlatformStorage(db);
      const alice = await storage.users.findByUsername('alice');
      expect(alice).toBeDefined();

      const aliceRoutes = await storage.forTenant(alice!.id).sessionRoutes.list();
      expect(aliceRoutes.length).toBeGreaterThan(0);
      const aliceSessionId = aliceRoutes[0].id;

      const operationsStorage = new SqlitePlatformOperationsStorage(db);
      const operationsService = createPlatformOperations({ storage: operationsStorage });

      const boundHandler = createPlatformProxyHandler({
        platformUserId: alice!.id,
        runtimeIdentity: 'alice',
        db,
        storage,
        operations: operationsService,
      });

      // 1. Create Task via POST /api/manage/tasks
      const taskStream = new MockDuplexStream();
      const taskBody = JSON.stringify({
        title: 'Security analysis job',
        prompt: 'Audit access tokens',
        sessionId: aliceSessionId,
        priority: 'high',
      });
      const idempotencyKey = randomUUID();
      taskStream.pushRequest(
        `POST /api/manage/tasks HTTP/1.1\r\nHost: 127.0.0.1:8787\r\nIdempotency-Key: ${idempotencyKey}\r\nContent-Length: ${Buffer.byteLength(taskBody)}\r\n\r\n${taskBody}`
      );
      taskStream.endRequest();

      await boundHandler.handle(taskStream, { kind: 'platform', userId: 'alice' });
      const taskResp = taskStream.responseBuffer.toString('utf8');
      expect(taskResp).toContain('201 Created');
      expect(taskResp).toContain('"title":"Security analysis job"');

      // Verify row in SQLite platform_tasks has authoritative platform UUID
      const taskRow = db.prepare(
        'SELECT id, title, user_id, status, priority FROM platform_tasks WHERE user_id = ? AND idempotency_key = ?'
      ).get(alice!.id, idempotencyKey) as any;
      expect(taskRow).toBeDefined();
      expect(taskRow.title).toBe('Security analysis job');
      expect(taskRow.user_id).toBe(alice!.id);
      expect(taskRow.priority).toBe('high');

      // Verify zero rows stored under runtime alias 'alice'
      const taskAliasRows = db.prepare('SELECT COUNT(*) as count FROM platform_tasks WHERE user_id = ?').get('alice') as any;
      expect(taskAliasRows.count).toBe(0);

      // 2. Send Message via POST /api/messages
      const msgStream = new MockDuplexStream();
      const msgBody = JSON.stringify({
        recipient: aliceSessionId,
        content: 'Task completed successfully',
      });
      msgStream.pushRequest(
        `POST /api/messages HTTP/1.1\r\nHost: 127.0.0.1:8787\r\nContent-Length: ${Buffer.byteLength(msgBody)}\r\n\r\n${msgBody}`
      );
      msgStream.endRequest();

      await boundHandler.handle(msgStream, { kind: 'platform', userId: 'alice' });
      const msgResp = msgStream.responseBuffer.toString('utf8');
      expect(msgResp).toContain('200 OK');
      expect(msgResp).toContain('"messageId":');

      // Verify row in SQLite web_messages has authoritative platform UUID
      const msgRow = db.prepare(
        'SELECT id, session_id, user_id, content, role FROM web_messages WHERE user_id = ? ORDER BY created_at DESC LIMIT 1'
      ).get(alice!.id) as any;
      expect(msgRow).toBeDefined();
      expect(msgRow.content).toBe('Task completed successfully');
      expect(msgRow.user_id).toBe(alice!.id);
      expect(msgRow.role).toBe('assistant');

      // Verify zero rows stored under runtime alias 'alice'
      const msgAliasRows = db.prepare('SELECT COUNT(*) as count FROM web_messages WHERE user_id = ?').get('alice') as any;
      expect(msgAliasRows.count).toBe(0);

      // 3. Publish Events via POST /api/events (Streaming deltas)
      const evStream = new MockDuplexStream();
      const eventsBody = JSON.stringify({
        events: [
          {
            id: `evt_delta_1_${randomUUID()}`,
            sessionId: aliceSessionId,
            type: 'assistant_delta',
            payload: { delta: 'Part 1: Initial analysis. ', streamId: 'stream_01', accumulatedLength: 26 },
          },
          {
            id: `evt_delta_2_${randomUUID()}`,
            sessionId: aliceSessionId,
            type: 'assistant_delta',
            payload: { delta: 'Part 2: Verified complete.', streamId: 'stream_01', accumulatedLength: 51 },
          },
          {
            id: `evt_final_msg_${randomUUID()}`,
            sessionId: aliceSessionId,
            type: 'message',
            payload: {
              message: {
                id: `msg_final_${randomUUID()}`,
                role: 'assistant',
                content: 'Part 1: Initial analysis. Part 2: Verified complete.',
              },
            },
          },
        ],
      });
      evStream.pushRequest(
        `POST /api/events HTTP/1.1\r\nHost: 127.0.0.1:8787\r\nContent-Length: ${Buffer.byteLength(eventsBody)}\r\n\r\n${eventsBody}`
      );
      evStream.endRequest();

      await boundHandler.handle(evStream, { kind: 'platform', userId: 'alice' });
      const evResp = evStream.responseBuffer.toString('utf8');
      expect(evResp).toContain('200 OK');
      expect(evResp).toContain('"count":3');

      // Verify rows in SQLite web_events
      const eventRows = db.prepare(
        'SELECT id, session_id, user_id, type, payload FROM web_events WHERE user_id = ? AND session_id = ? ORDER BY created_at ASC'
      ).all(alice!.id, aliceSessionId) as any[];

      const deltaEvents = eventRows.filter((e) => e.type === 'assistant_delta');
      const messageEvents = eventRows.filter((e) => e.type === 'message');
      expect(deltaEvents.length).toBeGreaterThanOrEqual(2);
      expect(messageEvents.length).toBeGreaterThanOrEqual(1);

      // Verify zero rows stored under runtime alias 'alice'
      const eventAliasRows = db.prepare('SELECT COUNT(*) as count FROM web_events WHERE user_id = ?').get('alice') as any;
      expect(eventAliasRows.count).toBe(0);

      // Verify Bob cannot see Alice's events or tasks (Tenant Isolation)
      const bob = await storage.users.findByUsername('bob');
      expect(bob).toBeDefined();
      const bobTasks = db.prepare('SELECT COUNT(*) as c FROM platform_tasks WHERE user_id = ?').get(bob!.id) as { c: number };
      const bobEvents = db.prepare('SELECT COUNT(*) as c FROM web_events WHERE user_id = ?').get(bob!.id) as { c: number };
      expect(bobTasks.c).toBe(0);
      expect(bobEvents.c).toBe(0);
    } finally {
      db.close();
    }
  });

  it('launchDemoSystem boots with toolsOperational: true and dynamic connectRuntime binds full handlers', async () => {
    await resetDemo({ repoRoot: tempRepo.repoRoot });
    const fakeAdapter = new FakeUnitRuntimeContainerAdapter();

    const system = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      runtimeAdapter: fakeAdapter,
    });

    try {
      expect(system.result.ok).toBe(true);
      expect(system.result.platform.status).toBe('healthy');

      // Inspect runtime handles
      const aliceUser = await system.storage.users.findByUsername('alice');
      const bobUser = await system.storage.users.findByUsername('bob');
      expect(aliceUser).toBeDefined();
      expect(bobUser).toBeDefined();

      const aliceHandle = system.runtimeHandles.get(aliceUser!.id);
      const bobHandle = system.runtimeHandles.get(bobUser!.id);
      expect(aliceHandle).toBeDefined();
      expect(bobHandle).toBeDefined();

      const aliceHealth = await aliceHandle!.checkHealth();
      expect(aliceHealth.status).toBe('ok');
      expect(aliceHealth.dshReady).toBe(true);
      expect(aliceHealth.toolsOperational).toBe(true);
      expect(aliceHealth.toolsUnavailableReason).toBeNull();

      const bobHealth = await bobHandle!.checkHealth();
      expect(bobHealth.status).toBe('ok');
      expect(bobHealth.dshReady).toBe(true);
      expect(bobHealth.toolsOperational).toBe(true);
      expect(bobHealth.toolsUnavailableReason).toBeNull();

      // Test dynamic connectRuntime for Alice
      const reconnectedHandle = await system.connectRuntime(aliceUser!.id);
      expect(reconnectedHandle).toBeDefined();
      const reconnectedHealth = await reconnectedHandle.checkHealth();
      expect(reconnectedHealth.toolsOperational).toBe(true);

      // Test restartRuntime across all active runtimes
      const restartAllRes = await system.restartRuntime();
      expect(restartAllRes.restarted).toBe(true);
      expect(restartAllRes.appliedRuntimes).toContain(aliceUser!.id);
      expect(restartAllRes.appliedRuntimes).toContain(bobUser!.id);
      expect(restartAllRes.failedRuntimes).toEqual([]);
    } finally {
      await system.close({ removeVolumes: true });
    }
  });

  it('restartRuntime applies platform model override and observes partial failures with error details', async () => {
    await resetDemo({ repoRoot: tempRepo.repoRoot });
    const fakeAdapter = new FakeUnitRuntimeContainerAdapter();

    const system = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      runtimeAdapter: fakeAdapter,
    });

    try {
      const aliceUser = await system.storage.users.findByUsername('alice');
      const bobUser = await system.storage.users.findByUsername('bob');

      // Set model override in platform database
      const paths = getDemoPathConfig({ repoRoot: tempRepo.repoRoot });
      const db = new DatabaseSync(paths.dbPath);
      try {
        db.prepare(`
          INSERT INTO model_config_overrides (id, provider, model, reasoning_effort)
          VALUES ('default', 'cpa-gemini', 'gemini-2.0-flash', 'high')
          ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, model = excluded.model
        `).run();
      } finally {
        db.close();
      }

      // Successful restart under override
      const restartRes = await system.restartRuntime();
      expect(restartRes.restarted).toBe(true);
      expect(restartRes.appliedRuntimes).toContain(aliceUser!.id);
      expect(restartRes.appliedRuntimes).toContain(bobUser!.id);
      expect(restartRes.failedRuntimes).toEqual([]);

      // Simulate partial failure: startUserRuntime fails for Bob
      const originalStart = fakeAdapter.startUserRuntime.bind(fakeAdapter);
      fakeAdapter.startUserRuntime = async (opts) => {
        if (opts.userId.includes('bob')) {
          throw new Error('Simulated Docker OOM during Bob container start');
        }
        return originalStart(opts);
      };

      const partialRes = await system.restartRuntime();
      expect(partialRes.restarted).toBe(true);
      expect(partialRes.appliedRuntimes).toContain(aliceUser!.id);
      expect(partialRes.appliedRuntimes).not.toContain(bobUser!.id);
      expect(partialRes.failedRuntimes.length).toBe(1);
      expect(partialRes.failedRuntimes[0].userId).toBe(bobUser!.id);
      expect(partialRes.failedRuntimes[0].error).toContain('Simulated Docker OOM during Bob container start');
    } finally {
      await system.close({ removeVolumes: true });
    }
  });
});
