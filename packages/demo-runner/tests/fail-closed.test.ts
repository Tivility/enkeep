import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { symlinkSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  DockerRuntimeContainerAdapter,
  type UserRuntimeHandle,
} from '../src/ports/index.js';
import {
  SafeDockerClient,
  DockerRuntimeAdapter,
  computeSessionEventsChecksum,
  canonicalJsonStringify,
  type ActiveRuntimeHandle,
} from '@enkeep/runtime-runner';
import {
  upDemo,
  launchDemoSystem,
  extractEnvelopePrompt,
  validateSqliteDatabasePath,
  loadAndVerifyFixedSeeds,
  readSafeDescriptorFile,
} from '../src/up/index.js';
import { downDemo } from '../src/down/index.js';
import { resetDemo } from '../src/reset/index.js';
import { runDemoTestSuite } from '../src/test/index.js';
import { getDemoPathConfig } from '../src/config.js';
import { FakeUnitRuntimeContainerAdapter } from './support/fake-runtime.js';
import { createTempRepo, type TempRepo } from './support/temp-repo.js';

describe('Demo Runner Fail-Closed Security & Runtime Integrity', () => {
  let tempRepo: TempRepo;

  beforeEach(() => {
    tempRepo = createTempRepo();
  });

  afterEach(async () => {
    await downDemo({ repoRoot: tempRepo.repoRoot, removeVolumes: true });
    tempRepo.cleanup();
  });

  it('fails closed when Docker binary is invalid or daemon is unreachable', async () => {
    const badClient = new SafeDockerClient('/non/existent/docker_bin');
    const adapter = new DockerRuntimeContainerAdapter(badClient);

    await expect(
      adapter.startUserRuntime({
        userId: 'alice',
        repoRoot: tempRepo.repoRoot,
      })
    ).rejects.toThrow(/FAIL-CLOSED: Docker daemon is required/);
  });

  it('fails closed when container specification violates safety policy', async () => {
    const client = new SafeDockerClient();
    const adapter = new DockerRuntimeContainerAdapter(client);

    await expect(
      adapter.startUserRuntime({
        userId: '',
        repoRoot: tempRepo.repoRoot,
      })
    ).rejects.toThrow();
  });

  it('fails closed in upDemo when demo DB is missing (refuses automatic reset)', async () => {
    await expect(upDemo({ repoRoot: tempRepo.repoRoot })).rejects.toThrow(
      /FAIL-CLOSED: Demo database missing .* Automatic reset is forbidden/
    );
  });

  it('fails closed in upDemo if Docker is unavailable after DB exists', async () => {
    await resetDemo({ repoRoot: tempRepo.repoRoot });
    const spy = vi.spyOn(SafeDockerClient.prototype, 'isDockerAvailable').mockResolvedValue(false);
    try {
      await expect(upDemo({ repoRoot: tempRepo.repoRoot })).rejects.toThrow(/FAIL-CLOSED: Docker daemon/);
    } finally {
      spy.mockRestore();
    }
  });

  it('fails closed in demo:test when Docker is unavailable and explicitly reports failure (never green)', async () => {
    const spy = vi.spyOn(SafeDockerClient.prototype, 'isDockerAvailable').mockResolvedValue(false);
    try {
      const report = await runDemoTestSuite({ repoRoot: tempRepo.repoRoot });
      expect(report.ok).toBe(false);
      expect(report.summary.failed).toBeGreaterThan(0);
      const dockerStep = report.steps.find((s) => s.stepId === 'step_dsh_docker_runtime');
      expect(dockerStep?.passed).toBe(false);
      expect(dockerStep?.error).toMatch(/FAIL-CLOSED: Docker daemon is unavailable/);
    } finally {
      spy.mockRestore();
    }
  });

  describe('UserRuntimeHandle Fail-Closed Validations', () => {
    let mockActiveHandle: ActiveRuntimeHandle;
    let adapter: DockerRuntimeContainerAdapter;
    let handle: UserRuntimeHandle;

    beforeEach(async () => {
      mockActiveHandle = {
        containerId: 'a'.repeat(64),
        runId: 'run_1234567890_abcdef',
        volumeId: 'vol_alice_12345678',
        isCreated: true,
        spec: {} as any,
        checkHealth: vi.fn().mockResolvedValue({ status: 'ok', dshReady: true, userId: 'alice', version: '1.0.0', modelProvider: 'cpa-claude' }),
        sendFollowup: vi.fn().mockResolvedValue({ status: 'completed', replyText: 'Real assistant reply', persisted: true, eventsCount: 2 }),
        importSeed: vi.fn().mockResolvedValue({
          status: 'completed',
          sessionId: 'import-session-1',
          persisted: true,
          eventsCount: 5,
          receipt: {
            algorithm: 'sha256-session-events-v1',
            checksum: 'test-checksum',
            canonicalBytes: 500,
            eventCount: 5,
          },
        }),
        cancelTurn: vi.fn().mockResolvedValue({ status: 'cancelled', turnId: 'turn-1' }),
        fileOperation: vi.fn().mockResolvedValue({
          protocolVersion: '1.0',
          correlationId: 'corr-1',
          source: 'unit-test',
          timestamp: new Date().toISOString(),
          status: 'ok',
          data: { action: 'list', items: [] },
        }),
        stop: vi.fn().mockResolvedValue(undefined),
        teardown: vi.fn().mockResolvedValue(undefined),
      };

      const mockDockerClient = new SafeDockerClient();
      vi.spyOn(mockDockerClient, 'isDockerAvailable').mockResolvedValue(true);
      vi.spyOn(DockerRuntimeAdapter.prototype, 'startRuntime').mockResolvedValue(mockActiveHandle);

      adapter = new DockerRuntimeContainerAdapter(mockDockerClient);
      handle = await adapter.startUserRuntime({
        userId: 'alice',
        repoRoot: tempRepo.repoRoot,
      });
    });

    it('enforces sendTurn invariants: fails closed on non-completed status, empty replyText, or unpersisted response', async () => {
      const sessionId = 'ses_0123456789abcdef0123456789abcdef';
      const turnId = 'turn_0123456789abcdef0123456789abcdef';

      // 1. Rejects empty or whitespace prompt
      await expect(handle.sendTurn({ prompt: '', sessionId, turnId, profileSnapshot: null })).rejects.toThrow(/FAIL-CLOSED: sendTurn requires a non-empty prompt/);
      await expect(handle.sendTurn({ prompt: '   ', sessionId, turnId, profileSnapshot: null })).rejects.toThrow(/FAIL-CLOSED: sendTurn requires a non-empty prompt/);

      // 1b. Rejects prompt exceeding 64KiB (65,536 UTF-8 bytes)
      await expect(handle.sendTurn({ prompt: 'a'.repeat(65537), sessionId, turnId, profileSnapshot: null })).rejects.toThrow(/FAIL-CLOSED: sendTurn prompt exceeds maximum allowed length/);

      // 1c. Rejects missing or empty sessionId / turnId
      await expect(handle.sendTurn({ prompt: 'hello', sessionId: '', turnId, profileSnapshot: null })).rejects.toThrow(/FAIL-CLOSED: sendTurn requires a non-empty sessionId/);
      await expect(handle.sendTurn({ prompt: 'hello', sessionId, turnId: '', profileSnapshot: null })).rejects.toThrow(/FAIL-CLOSED: sendTurn requires a non-empty turnId/);

      // 2. Fails closed if container returns non-completed status
      (mockActiveHandle.sendFollowup as any).mockResolvedValueOnce({ status: 'error', error: 'Internal execution error' });
      await expect(handle.sendTurn({ prompt: 'hello', sessionId, turnId, profileSnapshot: null })).rejects.toThrow(/FAIL-CLOSED: Turn execution envelope status is not completed/);

      // 3. Fails closed if container returns empty replyText
      (mockActiveHandle.sendFollowup as any).mockResolvedValueOnce({ status: 'completed', replyText: '', persisted: true });
      await expect(handle.sendTurn({ prompt: 'hello', sessionId, turnId, profileSnapshot: null })).rejects.toThrow(/FAIL-CLOSED: Turn execution returned missing, empty, or non-string replyText/);

      // 4. Fails closed if container returns persisted === false
      (mockActiveHandle.sendFollowup as any).mockResolvedValueOnce({ status: 'completed', replyText: 'response', persisted: false });
      await expect(handle.sendTurn({ prompt: 'hello', sessionId, turnId, profileSnapshot: null })).rejects.toThrow(/FAIL-CLOSED: Turn execution returned persisted=false/);

      // 5. Fails closed if eventsCount is missing or invalid
      (mockActiveHandle.sendFollowup as any).mockResolvedValueOnce({ status: 'completed', replyText: 'response', persisted: true, eventsCount: -1 });
      await expect(handle.sendTurn({ prompt: 'hello', sessionId, turnId, profileSnapshot: null })).rejects.toThrow(/FAIL-CLOSED: Turn execution returned missing or invalid positive safe-integer eventsCount/);

      (mockActiveHandle.sendFollowup as any).mockResolvedValueOnce({ status: 'completed', replyText: 'response', persisted: true, eventsCount: undefined });
      await expect(handle.sendTurn({ prompt: 'hello', sessionId, turnId, profileSnapshot: null })).rejects.toThrow(/FAIL-CLOSED: Turn execution returned missing or invalid positive safe-integer eventsCount/);

      // 6. Valid completion returns actual reply text and persisted === true
      (mockActiveHandle.sendFollowup as any).mockResolvedValueOnce({ status: 'completed', replyText: 'Verified reply', persisted: true, eventsCount: 3 });
      const successRes = await handle.sendTurn({ prompt: 'valid prompt', sessionId, turnId, profileSnapshot: null });
      expect(successRes).toEqual({
        replyText: 'Verified reply',
        persisted: true,
        eventsCount: 3,
      });
    });

    it('enforces importSeed invariants: fails closed on invalid status, unpersisted, receipt mismatch, or non-boolean duplicate', async () => {
      const validSeed = [{ type: 'user/message', seq: 0, time: 100, data: { text: 'hi' } }];
      const validChecksum = computeSessionEventsChecksum(validSeed);
      const validCanonicalBytes = Buffer.byteLength(canonicalJsonStringify(validSeed), 'utf8');

      // 1. Rejects empty sessionId or seed
      await expect(handle.importSeed!('', validSeed)).rejects.toThrow(/FAIL-CLOSED: importSeed requires a non-empty sessionId/);
      await expect(handle.importSeed!('sid', [])).rejects.toThrow(/FAIL-CLOSED: importSeed requires a non-empty seed array/);

      // 2. Fails closed if container returns status error
      (mockActiveHandle.importSeed as any).mockResolvedValueOnce({ status: 'error', error: 'Import failed' });
      await expect(handle.importSeed!('import-sid', validSeed)).rejects.toThrow(/FAIL-CLOSED: Seed import failed/);

      // 3. Fails closed if sessionId mismatch
      (mockActiveHandle.importSeed as any).mockResolvedValueOnce({
        status: 'completed',
        sessionId: 'wrong-sid',
        persisted: true,
        eventsCount: 1,
        receipt: { algorithm: 'sha256-session-events-v1', checksum: validChecksum, canonicalBytes: validCanonicalBytes, eventCount: 1 },
        duplicate: false,
      });
      await expect(handle.importSeed!('import-sid', validSeed)).rejects.toThrow(/FAIL-CLOSED: Seed import sessionId mismatch/);

      // 4. Fails closed if persisted === false
      (mockActiveHandle.importSeed as any).mockResolvedValueOnce({
        status: 'completed',
        sessionId: 'import-sid',
        persisted: false,
        eventsCount: 1,
        receipt: { algorithm: 'sha256-session-events-v1', checksum: validChecksum, canonicalBytes: validCanonicalBytes, eventCount: 1 },
        duplicate: false,
      });
      await expect(handle.importSeed!('import-sid', validSeed)).rejects.toThrow(/FAIL-CLOSED: Seed import not persisted/);

      // 5. Fails closed if missing receipt
      (mockActiveHandle.importSeed as any).mockResolvedValueOnce({ status: 'completed', sessionId: 'import-sid', persisted: true, eventsCount: 1, duplicate: false });
      await expect(handle.importSeed!('import-sid', validSeed)).rejects.toThrow(/FAIL-CLOSED: Seed import receipt mismatch/);

      // 6. Fails closed if receipt checksum mismatches
      (mockActiveHandle.importSeed as any).mockResolvedValueOnce({
        status: 'completed',
        sessionId: 'import-sid',
        persisted: true,
        eventsCount: 1,
        receipt: { algorithm: 'sha256-session-events-v1', checksum: 'bad_checksum_hex', canonicalBytes: validCanonicalBytes, eventCount: 1 },
        duplicate: false,
      });
      await expect(handle.importSeed!('import-sid', validSeed)).rejects.toThrow(/FAIL-CLOSED: Seed import receipt mismatch/);

      // 7. Fails closed if duplicate is not a boolean
      (mockActiveHandle.importSeed as any).mockResolvedValueOnce({
        status: 'completed',
        sessionId: 'import-sid',
        persisted: true,
        eventsCount: 1,
        receipt: { algorithm: 'sha256-session-events-v1', checksum: validChecksum, canonicalBytes: validCanonicalBytes, eventCount: 1 },
        duplicate: undefined,
      });
      await expect(handle.importSeed!('import-sid', validSeed)).rejects.toThrow(/FAIL-CLOSED: Seed import returned missing or non-boolean duplicate flag/);

      // 8. Valid import returns exact receipt and duplicate status
      (mockActiveHandle.importSeed as any).mockResolvedValueOnce({
        status: 'completed',
        sessionId: 'import-sid',
        persisted: true,
        eventsCount: 1,
        receipt: { algorithm: 'sha256-session-events-v1', checksum: validChecksum, canonicalBytes: validCanonicalBytes, eventCount: 1 },
        duplicate: false,
      });
      const validRes = await handle.importSeed!('import-sid', validSeed);
      expect(validRes).toEqual({
        status: 'completed',
        sessionId: 'import-sid',
        persisted: true,
        eventsCount: 1,
        receipt: { algorithm: 'sha256-session-events-v1', checksum: validChecksum, canonicalBytes: validCanonicalBytes, eventCount: 1 },
        duplicate: false,
      });
    });

    it('enforces checkHealth invariants: fails closed if status is not ok, dshReady is false, or userId/uptime invalid', async () => {
      (mockActiveHandle.checkHealth as any).mockResolvedValueOnce({ status: 'error', dshReady: true, userId: 'alice', uptimeSeconds: 10 });
      await expect(handle.checkHealth()).rejects.toThrow(/FAIL-CLOSED: Health check returned unhealthy status/);

      (mockActiveHandle.checkHealth as any).mockResolvedValueOnce({ status: 'ok', dshReady: false, userId: 'alice', uptimeSeconds: 10 });
      await expect(handle.checkHealth()).rejects.toThrow(/FAIL-CLOSED: Health check reported dshReady is not true/);

      (mockActiveHandle.checkHealth as any).mockResolvedValueOnce({ status: 'ok', dshReady: true, userId: 'bob', uptimeSeconds: 10 });
      await expect(handle.checkHealth()).rejects.toThrow(/FAIL-CLOSED: Health check userId mismatch/);

      (mockActiveHandle.checkHealth as any).mockResolvedValueOnce({ status: 'ok', dshReady: true, userId: 'alice', uptimeSeconds: -5 });
      await expect(handle.checkHealth()).rejects.toThrow(/FAIL-CLOSED: Health check returned invalid uptimeSeconds/);

      (mockActiveHandle.checkHealth as any).mockResolvedValueOnce({
        status: 'ok',
        dshReady: true,
        userId: 'alice',
        uptimeSeconds: 10,
        version: '0.1.1-rc.2',
        enkeepBundleLoaded: true,
        toolsCount: 4,
        plugins: {
          receiptStore: true,
          inbound: true,
          eventRelay: true,
          externalInteraction: true,
          affinityPolicy: true,
          llmAffinity: true,
          tools: true,
        },
        toolsOperational: true,
        toolsUnavailableReason: null,
      });
      await expect(handle.checkHealth()).rejects.toThrow(/FAIL-CLOSED: Health check returned missing or invalid modelProvider/);

      // Accepts health when tools unavailable
      const validPlugins = {
        receiptStore: true,
        inbound: true,
        eventRelay: true,
        externalInteraction: true,
        affinityPolicy: true,
        llmAffinity: true,
        tools: false,
      };
      (mockActiveHandle.checkHealth as any).mockResolvedValueOnce({
        status: 'ok',
        dshReady: true,
        userId: 'alice',
        uptimeSeconds: 12,
        version: '0.1.1-rc.2',
        enkeepBundleLoaded: true,
        toolsCount: 0,
        plugins: validPlugins,
        toolsOperational: false,
        toolsUnavailableReason: 'PLATFORM_CLIENT_UNAVAILABLE',
        modelProvider: 'cpa-claude',
      });
      const validHealth = await handle.checkHealth();
      expect(validHealth.status).toBe('ok');
      expect(validHealth.modelProvider).toBe('cpa-claude');
      expect(validHealth.toolsOperational).toBe(false);
      expect(validHealth.toolsUnavailableReason).toBe('PLATFORM_CLIENT_UNAVAILABLE');
      expect((validHealth as any).networkMode).toBeUndefined();
    });

    it('enforces cancelTurn invariants: requires cancelled status and non-empty matching turnId', async () => {
      // 1. Rejects missing / empty turnId
      await expect((handle.cancelTurn as any)('')).rejects.toThrow(/FAIL-CLOSED: cancelTurn requires a non-empty turnId/);
      await expect((handle.cancelTurn as any)()).rejects.toThrow(/FAIL-CLOSED: cancelTurn requires a non-empty turnId/);

      // 2. Rejects error status
      (mockActiveHandle.cancelTurn as any).mockResolvedValueOnce({ status: 'error', turnId: 'turn_1' });
      await expect(handle.cancelTurn('turn_1')).rejects.toThrow(/FAIL-CLOSED: Cancel turn returned non-cancelled status/);

      // 3. Rejects permissive / fabricated "ok" status (must be strictly "cancelled")
      (mockActiveHandle.cancelTurn as any).mockResolvedValueOnce({ status: 'ok', turnId: 'turn_1' });
      await expect(handle.cancelTurn('turn_1')).rejects.toThrow(/FAIL-CLOSED: Cancel turn returned non-cancelled status/);

      // 4. Rejects missing / empty turnId returned from handle
      (mockActiveHandle.cancelTurn as any).mockResolvedValueOnce({ status: 'cancelled', turnId: '' });
      await expect(handle.cancelTurn('turn_1')).rejects.toThrow(/FAIL-CLOSED: Cancel turn returned missing or empty turnId/);

      // 5. Rejects turnId mismatch when provided
      (mockActiveHandle.cancelTurn as any).mockResolvedValueOnce({ status: 'cancelled', turnId: 'wrong_turn' });
      await expect(handle.cancelTurn('turn_1')).rejects.toThrow(/FAIL-CLOSED: Cancel turn turnId mismatch/);

      // 6. Accepts valid cancelTurn with explicit matching turnId
      (mockActiveHandle.cancelTurn as any).mockResolvedValueOnce({ status: 'cancelled', turnId: 'turn_1' });
      const cancelRes1 = await handle.cancelTurn('turn_1');
      expect(cancelRes1).toEqual({ status: 'cancelled', turnId: 'turn_1' });
    });

    it('extractEnvelopePrompt strictly validates prompt extraction and rejects invalid formats', () => {
      // Valid string
      expect(extractEnvelopePrompt('Hello world')).toBe('Hello world');

      // Valid object with text
      expect(extractEnvelopePrompt({ text: 'Valid prompt' })).toBe('Valid prompt');

      // Rejects empty / whitespace string
      expect(() => extractEnvelopePrompt('')).toThrow(/FAIL-CLOSED: Envelope content string is empty/);
      expect(() => extractEnvelopePrompt('   \n  ')).toThrow(/FAIL-CLOSED: Envelope content string is empty/);

      // Rejects empty / whitespace object text
      expect(() => extractEnvelopePrompt({ text: '' })).toThrow(/FAIL-CLOSED: Envelope content text property is empty/);
      expect(() => extractEnvelopePrompt({ text: '  ' })).toThrow(/FAIL-CLOSED: Envelope content text property is empty/);

      // Rejects invalid types
      expect(() => extractEnvelopePrompt(null)).toThrow(/FAIL-CLOSED: Unsupported envelope content format/);
      expect(() => extractEnvelopePrompt(123)).toThrow(/FAIL-CLOSED: Unsupported envelope content format/);
      expect(() => extractEnvelopePrompt([])).toThrow(/FAIL-CLOSED: Unsupported envelope content format/);
      expect(() => extractEnvelopePrompt({ otherKey: 'no text' })).toThrow(/FAIL-CLOSED: Unsupported envelope content format/);
    });

    it('P0: tears down active handle and cleans metadata when container metadata write fails post-start', async () => {
      const mockDockerClient = new SafeDockerClient();
      vi.spyOn(mockDockerClient, 'isDockerAvailable').mockResolvedValue(true);
      const teardownSpy = vi.fn().mockResolvedValue(undefined);
      const failingActiveHandle: ActiveRuntimeHandle = {
        containerId: 'b'.repeat(64),
        runId: 'run_fail_123',
        volumeId: 'vol_fail_123',
        isCreated: true,
        spec: {} as any,
        checkHealth: vi.fn().mockResolvedValue({ status: 'ok', dshReady: true, userId: 'charlie', modelProvider: 'cpa-claude' }),
        sendFollowup: vi.fn().mockResolvedValue({ status: 'completed', replyText: 'hi', persisted: true }),
        importSeed: vi.fn().mockResolvedValue({ status: 'completed' }),
        cancelTurn: vi.fn().mockResolvedValue({ status: 'cancelled' }),
        stop: vi.fn().mockResolvedValue(undefined),
        teardown: teardownSpy,
      };
      const startSpy = vi.spyOn(DockerRuntimeAdapter.prototype, 'startRuntime').mockResolvedValue(failingActiveHandle);

      // Spy on writeSignedContainerMeta to simulate write failure after container started
      const cryptoMeta = await import('../src/utils/crypto-meta.js');
      const writeMetaSpy = vi.spyOn(cryptoMeta, 'writeSignedContainerMeta').mockImplementationOnce(() => {
        throw new Error('Simulated disk failure during container metadata registration');
      });

      const adapterInstance = new DockerRuntimeContainerAdapter(mockDockerClient);

      try {
        await expect(
          adapterInstance.startUserRuntime({
            userId: 'charlie',
            repoRoot: tempRepo.repoRoot,
          })
        ).rejects.toThrow(/Simulated disk failure during container metadata registration/);

        // Verify teardown(true) was invoked to avoid live container & volume leak
        expect(teardownSpy).toHaveBeenCalledWith(true);
      } finally {
        writeMetaSpy.mockRestore();
        startSpy.mockRestore();
      }
    });

    it('startUserRuntime on resume constructs spec with exact stable volumeId and matching labels', async () => {
      const mockDockerClient = new SafeDockerClient();
      vi.spyOn(mockDockerClient, 'isDockerAvailable').mockResolvedValue(true);

      const cryptoMeta = await import('../src/utils/crypto-meta.js');
      const stableVolId = 'vol_0123456789abcdef0123456789abcdef';
      cryptoMeta.writeSignedVolumeMeta(
        {
          userId: 'dan',
          volumeName: 'enkeep-demo-dsh-dan',
          volumeId: stableVolId,
          runId: 'run_prior_001',
        },
        { repoRoot: tempRepo.repoRoot }
      );

      let capturedSpec: any = null;
      const startOwnedSpy = vi.spyOn(DockerRuntimeAdapter.prototype, 'startRuntimeWithOwnedVolume').mockImplementation(async (spec) => {
        capturedSpec = spec;
        return {
          containerId: 'c'.repeat(64),
          runId: spec.runId,
          volumeId: spec.volume.volumeId,
          isCreated: false,
          spec,
          checkHealth: vi.fn().mockResolvedValue({ status: 'ok', dshReady: true, userId: 'dan', uptimeSeconds: 10, modelProvider: 'cpa-claude' }),
          sendFollowup: vi.fn().mockResolvedValue({ status: 'completed', replyText: 'hi', persisted: true }),
          importSeed: vi.fn().mockResolvedValue({ status: 'completed' }),
          cancelTurn: vi.fn().mockResolvedValue({ status: 'cancelled', turnId: 'turn_1' }),
          stop: vi.fn().mockResolvedValue(undefined),
          teardown: vi.fn().mockResolvedValue(undefined),
        };
      });

      const adapterInstance = new DockerRuntimeContainerAdapter(mockDockerClient);
      const userHandle = await adapterInstance.startUserRuntime({
        userId: 'dan',
        repoRoot: tempRepo.repoRoot,
      });

      expect(userHandle.volumeId).toBe(stableVolId);
      expect(capturedSpec).not.toBeNull();
      // Verify both spec.volume.volumeId and spec.labels['enkeep.volume-id'] match exact stable volumeId
      expect(capturedSpec.volume.volumeId).toBe(stableVolId);
      expect(capturedSpec.labels['enkeep.volume-id']).toBe(stableVolId);
      expect(capturedSpec.labels['enkeep.user']).toBe('dan');

      startOwnedSpy.mockRestore();
    });

    it('startUserRuntime fails closed if existing signed volume metadata has user mismatch', async () => {
      const mockDockerClient = new SafeDockerClient();
      vi.spyOn(mockDockerClient, 'isDockerAvailable').mockResolvedValue(true);

      const cryptoMeta = await import('../src/utils/crypto-meta.js');
      cryptoMeta.writeSignedVolumeMeta(
        {
          userId: 'frank',
          volumeName: 'enkeep-demo-dsh-eve',
          volumeId: 'vol_frank_123',
          runId: 'run_prior_002',
        },
        { repoRoot: tempRepo.repoRoot }
      );

      const adapterInstance = new DockerRuntimeContainerAdapter(mockDockerClient);
      await expect(
        adapterInstance.startUserRuntime({
          userId: 'eve',
          repoRoot: tempRepo.repoRoot,
        })
      ).rejects.toThrow(/FAIL-CLOSED: Signed volume metadata userId mismatch/);
    });
    it('connectUserRuntime reconnects to existing container using signed HMAC metadata and fails closed on missing metadata', async () => {
      // 1. Successful reconnect using existing container metadata
      vi.spyOn(DockerRuntimeAdapter.prototype, 'connectRuntime').mockResolvedValueOnce(mockActiveHandle);
      const reconnectedHandle = await adapter.connectUserRuntime({
        userId: 'alice',
        repoRoot: tempRepo.repoRoot,
      });
      expect(reconnectedHandle.containerId).toBe(mockActiveHandle.containerId);
      expect(reconnectedHandle.userId).toBe('alice');

      // 2. Fails closed if signed metadata for user is missing
      await expect(
        adapter.connectUserRuntime({
          userId: 'bob',
          repoRoot: tempRepo.repoRoot,
        })
      ).rejects.toThrow(/FAIL-CLOSED: Cannot connect to user runtime "bob": No signed container metadata found/);
    });
  });

  describe('SQLite Database Security & Non-Symlink Verification', () => {
    it('fails closed when database file is a symlink', async () => {
      await resetDemo({ repoRoot: tempRepo.repoRoot });
      const paths = getDemoPathConfig(tempRepo.repoRoot);

      // Rename dbPath to real-db and replace dbPath with a symlink to real-db
      const realDbPath = join(paths.dataRoot, 'real-messages.db');
      symlinkSync(realDbPath, paths.dbPath + '.symlink');

      const pathOptions = { repoRoot: tempRepo.repoRoot, dataRoot: paths.dataRoot };
      expect(() => validateSqliteDatabasePath(paths.dbPath + '.symlink', pathOptions)).toThrow(
        /Database file at .* must not be a symbolic link|breakout detected/
      );
    });

    it('fails closed when database is outside data root', async () => {
      const paths = getDemoPathConfig(tempRepo.repoRoot);
      const pathOptions = { repoRoot: tempRepo.repoRoot, dataRoot: paths.dataRoot };

      expect(() => validateSqliteDatabasePath('/tmp/outside.db', pathOptions)).toThrow(
        /Safety Boundary Violation/
      );
    });

    it('fails closed when database has insecure world-writable permissions', async () => {
      await resetDemo({ repoRoot: tempRepo.repoRoot });
      const paths = getDemoPathConfig(tempRepo.repoRoot);
      const pathOptions = { repoRoot: tempRepo.repoRoot, dataRoot: paths.dataRoot };

      try {
        chmodSync(paths.dbPath, 0o666);
        expect(() => validateSqliteDatabasePath(paths.dbPath, pathOptions)).toThrow(
          /FAIL-CLOSED: Insecure world-writable permissions/
        );
      } finally {
        chmodSync(paths.dbPath, 0o600);
      }
    });
  });

  describe('Seed File IO & Canonical Manifest Verification', () => {
    it('fails closed when import-manifest.json has tampered invariants', async () => {
      await resetDemo({ repoRoot: tempRepo.repoRoot });
      const paths = getDemoPathConfig(tempRepo.repoRoot);
      const pathOptions = { repoRoot: tempRepo.repoRoot, dataRoot: paths.dataRoot };

      const manifestPath = join(paths.importDir, 'import-manifest.json');
      const origContent = readSafeDescriptorFile(manifestPath);
      const parsed = JSON.parse(origContent);

      // Tamper stats
      parsed.stats.sourceMessages = 999;
      writeFileSync(manifestPath, JSON.stringify(parsed, null, 2), { mode: 0o600 });

      expect(() => loadAndVerifyFixedSeeds(paths.importDir, pathOptions)).toThrow(
        /FAIL-CLOSED: import-manifest.json stats invariants violation/
      );
    });

    it('fails closed when seeds directory contains extra or unknown files', async () => {
      await resetDemo({ repoRoot: tempRepo.repoRoot });
      const paths = getDemoPathConfig(tempRepo.repoRoot);
      const pathOptions = { repoRoot: tempRepo.repoRoot, dataRoot: paths.dataRoot };

      const extraSeed = join(paths.importDir, 'seeds', 'extra-unauthorized.json');
      writeFileSync(extraSeed, '[]', { mode: 0o600 });

      expect(() => loadAndVerifyFixedSeeds(paths.importDir, pathOptions)).toThrow(
        /FAIL-CLOSED: seedsDir contains unexpected or extra files/
      );
    });

    it('fails closed when a seed file is a symlink', async () => {
      await resetDemo({ repoRoot: tempRepo.repoRoot });
      const paths = getDemoPathConfig(tempRepo.repoRoot);
      const pathOptions = { repoRoot: tempRepo.repoRoot, dataRoot: paths.dataRoot };

      const seedsDir = join(paths.importDir, 'seeds');
      const realSeed = join(seedsDir, 'import-daaca04dc7344699b1d2fa4392d6a1f2.json');
      const backupSeed = join(paths.importDir, 'backup.json');

      if (rmSync && realSeed) {
        // Read contents and write to backup
        const content = readSafeDescriptorFile(realSeed);
        writeFileSync(backupSeed, content, { mode: 0o600 });
        rmSync(realSeed);
        symlinkSync(backupSeed, realSeed);

        expect(() => loadAndVerifyFixedSeeds(paths.importDir, pathOptions)).toThrow(
          /must not be a symbolic link|breakout detected|O_NOFOLLOW/
        );
      }
    });

    it('fails closed when mapping.json contains invalid keys or session IDs', async () => {
      await resetDemo({ repoRoot: tempRepo.repoRoot });
      const paths = getDemoPathConfig(tempRepo.repoRoot);
      const pathOptions = { repoRoot: tempRepo.repoRoot, dataRoot: paths.dataRoot };

      const mappingPath = join(paths.importDir, 'mapping.json');
      const parsed = JSON.parse(readSafeDescriptorFile(mappingPath));

      parsed['unauthorized-chat-key'] = { userId: 'alice', sessionId: 'bad-sid' };
      writeFileSync(mappingPath, JSON.stringify(parsed, null, 2), { mode: 0o600 });

      expect(() => loadAndVerifyFixedSeeds(paths.importDir, pathOptions)).toThrow(
        /FAIL-CLOSED: mapping.json must contain exact keys/
      );
    });
  });

  describe('DeliveryTurnExecutor Session Route Verification', () => {
    it('fails closed when mandatory execution parameters are missing or invalid', async () => {
      await resetDemo({ repoRoot: tempRepo.repoRoot });
      const fakeAdapter = new FakeUnitRuntimeContainerAdapter();
      const system = await launchDemoSystem({
        repoRoot: tempRepo.repoRoot,
        runtimeAdapter: fakeAdapter,
      });

      try {
        const aliceUser = await system.platformServer['storage'].users.findByUsername('alice');
        const aliceSpaces = await system.platformServer['storage'].forTenant(aliceUser!.id).spaces.list();
        const space = aliceSpaces[0];

        const resolvedEnvelope = {
          id: 'msg_001',
          userId: aliceUser!.id,
          sessionId: 'ses_001',
          spaceId: space.id,
          content: 'Hello agent',
          timestamp: new Date().toISOString(),
        };

        const gateway = system.platformServer['runtimeGateway'] as any;
        const executor = gateway['executor'];

        // Rejects missing/empty dshSessionId
        await expect(
          executor.execute({
            userId: aliceUser!.id,
            platformSpaceId: space.id,
            dshSessionId: '',
            turnId: 'turn_1',
            content: 'Hello agent',
            profile: null,
            envelope: resolvedEnvelope,
          })
        ).rejects.toThrow(/FAIL-CLOSED: Mandatory dshSessionId missing or empty/);

        // Rejects missing/empty turnId
        await expect(
          executor.execute({
            userId: aliceUser!.id,
            platformSpaceId: space.id,
            dshSessionId: 'dsh_sess_1',
            turnId: '',
            content: 'Hello agent',
            profile: null,
            envelope: resolvedEnvelope,
          })
        ).rejects.toThrow(/FAIL-CLOSED: Mandatory turnId missing or empty/);

        // Rejects missing/empty userId
        await expect(
          executor.execute({
            userId: '',
            platformSpaceId: space.id,
            dshSessionId: 'dsh_sess_1',
            turnId: 'turn_1',
            content: 'Hello agent',
            profile: null,
            envelope: resolvedEnvelope,
          })
        ).rejects.toThrow(/FAIL-CLOSED: Missing target userId/);

        // Rejects missing/empty platformSpaceId
        await expect(
          executor.execute({
            userId: aliceUser!.id,
            platformSpaceId: '',
            dshSessionId: 'dsh_sess_1',
            turnId: 'turn_1',
            content: 'Hello agent',
            profile: null,
            envelope: resolvedEnvelope,
          })
        ).rejects.toThrow(/FAIL-CLOSED: Missing platformSpaceId/);

        // Authoritative execution succeeds with valid request
        const result = await executor.execute({
          userId: aliceUser!.id,
          platformSpaceId: space.id,
          dshSessionId: 'dsh_sess_different_gen',
          turnId: 'turn_1',
          content: 'Hello agent',
          profile: null,
          envelope: resolvedEnvelope,
        });
        expect(result).toBeDefined();
        expect(result.replyText).toContain('Hello agent');
      } finally {
        await system.close({ removeVolumes: true });
      }
    });
  });

  describe('Cleanup and Error Aggregation', () => {
    it('startup failure with resumed Alice volume preserves Alice retained volume and invokes teardown(false)', async () => {
      await resetDemo({ repoRoot: tempRepo.repoRoot });
      const cryptoMeta = await import('../src/utils/crypto-meta.js');
      cryptoMeta.writeSignedVolumeMeta(
        {
          userId: 'alice',
          volumeName: 'enkeep-demo-dsh-alice',
          volumeId: 'vol_alice_retained_123',
          runId: 'run_prior_alice',
        },
        { repoRoot: tempRepo.repoRoot }
      );

      const fakeAdapter = new FakeUnitRuntimeContainerAdapter();
      let aliceTeardownArg: boolean | undefined = undefined;

      const origStart = fakeAdapter.startUserRuntime.bind(fakeAdapter);
      vi.spyOn(fakeAdapter, 'startUserRuntime').mockImplementation(async (opts) => {
        if (opts.userId === 'alice') {
          const handle = await origStart(opts);
          const origTeardown = handle.teardown.bind(handle);
          vi.spyOn(handle, 'teardown').mockImplementation(async (rmVol) => {
            aliceTeardownArg = rmVol;
            return origTeardown(rmVol);
          });
          return handle;
        }
        if (opts.userId === 'bob') {
          throw new Error('Simulated Bob startup failure');
        }
        return origStart(opts);
      });

      await expect(
        launchDemoSystem({
          repoRoot: tempRepo.repoRoot,
          runtimeAdapter: fakeAdapter,
        })
      ).rejects.toThrow(/Simulated Bob startup failure/);

      // Verify Alice was torn down with removeVolume: false (preserving retained volume!)
      expect(aliceTeardownArg).toBe(false);

      // Verify Alice signed volume metadata is preserved
      const aliceVolMeta = cryptoMeta.readSignedVolumeMeta('enkeep-demo-dsh-alice', { repoRoot: tempRepo.repoRoot });
      expect(aliceVolMeta).not.toBeNull();
      expect(aliceVolMeta?.volumeId).toBe('vol_alice_retained_123');
    });

    it('startup failure with fresh Alice volume invokes teardown(true) to avoid partial volume leaks', async () => {
      await resetDemo({ repoRoot: tempRepo.repoRoot });
      const cryptoMeta = await import('../src/utils/crypto-meta.js');

      const fakeAdapter = new FakeUnitRuntimeContainerAdapter();
      let aliceTeardownArg: boolean | undefined = undefined;

      const origStart = fakeAdapter.startUserRuntime.bind(fakeAdapter);
      vi.spyOn(fakeAdapter, 'startUserRuntime').mockImplementation(async (opts) => {
        if (opts.userId === 'alice') {
          const handle = await origStart(opts);
          const origTeardown = handle.teardown.bind(handle);
          vi.spyOn(handle, 'teardown').mockImplementation(async (rmVol) => {
            aliceTeardownArg = rmVol;
            return origTeardown(rmVol);
          });
          return handle;
        }
        if (opts.userId === 'bob') {
          throw new Error('Simulated Bob startup failure on fresh system');
        }
        return origStart(opts);
      });

      await expect(
        launchDemoSystem({
          repoRoot: tempRepo.repoRoot,
          runtimeAdapter: fakeAdapter,
        })
      ).rejects.toThrow(/Simulated Bob startup failure on fresh system/);

      // Verify Alice was torn down with removeVolume: true (cleaning newly created volume!)
      expect(aliceTeardownArg).toBe(true);

      // Verify Alice signed volume metadata was removed
      const aliceVolMeta = cryptoMeta.readSignedVolumeMeta('enkeep-demo-dsh-alice', { repoRoot: tempRepo.repoRoot });
      expect(aliceVolMeta).toBeNull();
    });

    it('startup failure during server start invokes teardown(h.volumeCreated) on all handles', async () => {
      await resetDemo({ repoRoot: tempRepo.repoRoot });
      const cryptoMeta = await import('../src/utils/crypto-meta.js');
      // Alice is retained
      cryptoMeta.writeSignedVolumeMeta(
        {
          userId: 'alice',
          volumeName: 'enkeep-demo-dsh-alice',
          volumeId: 'vol_alice_server_fail_test',
          runId: 'run_alice_server_fail',
        },
        { repoRoot: tempRepo.repoRoot }
      );

      const fakeAdapter = new FakeUnitRuntimeContainerAdapter();
      const teardownCalls: { userId: string; removeVolume?: boolean }[] = [];

      const origStart = fakeAdapter.startUserRuntime.bind(fakeAdapter);
      vi.spyOn(fakeAdapter, 'startUserRuntime').mockImplementation(async (opts) => {
        const handle = await origStart(opts);
        const origTeardown = handle.teardown.bind(handle);
        vi.spyOn(handle, 'teardown').mockImplementation(async (rmVol) => {
          teardownCalls.push({ userId: opts.userId, removeVolume: rmVol });
          return origTeardown(rmVol);
        });
        return handle;
      });

      const platformServerPkg = await import('@enkeep/platform-server');
      const createServerSpy = vi.spyOn(platformServerPkg, 'createPlatformServer').mockRejectedValueOnce(
        new Error('Simulated platform server startup failure')
      );

      try {
        await expect(
          launchDemoSystem({
            repoRoot: tempRepo.repoRoot,
            runtimeAdapter: fakeAdapter,
          })
        ).rejects.toThrow(/Simulated platform server startup failure/);

        // Alice was retained -> teardown(false)
        const aliceCall = teardownCalls.find((c) => c.userId === 'alice');
        expect(aliceCall?.removeVolume).toBe(false);

        // Bob was fresh -> teardown(true)
        const bobCall = teardownCalls.find((c) => c.userId === 'bob');
        expect(bobCall?.removeVolume).toBe(true);

        // Alice metadata still on disk
        const aliceMeta = cryptoMeta.readSignedVolumeMeta('enkeep-demo-dsh-alice', { repoRoot: tempRepo.repoRoot });
        expect(aliceMeta).not.toBeNull();
        expect(aliceMeta?.volumeId).toBe('vol_alice_server_fail_test');

        // Bob metadata deleted
        const bobMeta = cryptoMeta.readSignedVolumeMeta('enkeep-demo-dsh-bob', { repoRoot: tempRepo.repoRoot });
        expect(bobMeta).toBeNull();
      } finally {
        createServerSpy.mockRestore();
      }
    });

    it('aggregates all errors during close without swallowing', async () => {
      await resetDemo({ repoRoot: tempRepo.repoRoot });
      const fakeAdapter = new FakeUnitRuntimeContainerAdapter();
      const system = await launchDemoSystem({
        repoRoot: tempRepo.repoRoot,
        runtimeAdapter: fakeAdapter,
      });

      // Mock platformServer.stop to throw
      vi.spyOn(system.platformServer, 'stop').mockRejectedValue(new Error('Server stop failure'));

      // Mock one runtime handle teardown to throw
      const aliceUser = await system.storage.users.findByUsername('alice');
      const aliceHandle = aliceUser ? system.runtimeHandles.get(aliceUser.id) : undefined;
      if (aliceHandle) {
        vi.spyOn(aliceHandle, 'teardown').mockRejectedValue(new Error('Alice container teardown failure'));
      }

      await expect(system.close({ removeVolumes: true })).rejects.toThrow(
        /FAIL-CLOSED: RunningDemoSystem close encountered errors/
      );
    });

    it('management runtime provider leaves dshReady false when raw health is missing dshReady and does not expose raw error messages', async () => {
      await resetDemo({ repoRoot: tempRepo.repoRoot });
      const fakeAdapter = new FakeUnitRuntimeContainerAdapter();
      const system = await launchDemoSystem({
        repoRoot: tempRepo.repoRoot,
        runtimeAdapter: fakeAdapter,
      });

      const provider = system.platformServer.managementProvider;
      expect(provider).toBeDefined();

      const paths = getDemoPathConfig({ repoRoot: tempRepo.repoRoot });
      const db = new DatabaseSync(paths.dbPath);
      const aliceRow = db.prepare("SELECT id FROM users WHERE username = 'alice'").get() as { id: string };
      const bobRow = db.prepare("SELECT id FROM users WHERE username = 'bob'").get() as { id: string };
      db.close();

      const aliceHandle = system.runtimeHandles.get(aliceRow.id)!;
      const bobHandle = system.runtimeHandles.get(bobRow.id)!;

      // 1. Alice checkHealth returns valid degraded status
      aliceHandle.checkHealth = vi.fn().mockResolvedValue({
        status: 'degraded',
        networkMode: 'none',
        dshReady: true,
        userId: aliceRow.id,
        uptimeSeconds: 10,
        version: '1.0.0-demo',
        enkeepBundleLoaded: true,
        toolsCount: 0,
        plugins: {
          receiptStore: true,
          inbound: true,
          eventRelay: true,
          tools: false,
          externalInteraction: true,
          affinityPolicy: true,
          llmAffinity: true,
        },
        toolsOperational: false,
        toolsUnavailableReason: 'PLATFORM_CLIENT_UNAVAILABLE',
        modelProvider: 'cpa-claude',
      });

      // 2. Bob checkHealth throws sensitive error -> provider must return null and not expose raw errors
      bobHandle.checkHealth = vi.fn().mockRejectedValue(new Error('SensitiveBobDbError: db_secret_456'));

      // Test getUserRuntime for Alice
      const aliceStatus = await provider!.getUserRuntime(aliceRow.id);
      expect(aliceStatus).toBeDefined();
      expect(aliceStatus?.userId).toBe(aliceRow.id);
      expect(aliceStatus?.status).toBe('degraded');
      expect(aliceStatus?.toolsOperational).toBe(false);
      expect(aliceStatus?.toolsUnavailableReason).toBe('PLATFORM_CLIENT_UNAVAILABLE');
      expect((aliceStatus as any)?.available).toBeUndefined();
      expect((aliceStatus as any)?.containerId).toBeUndefined();
      expect((aliceStatus as any)?.endpoints).toBeUndefined();

      // Test getUserRuntime for Bob -> returns null on failure
      const bobStatus = await provider!.getUserRuntime(bobRow.id);
      expect(bobStatus).toBeNull();

      // Test listRuntimes: skips null (only returns Alice)
      const runtimes = await provider!.listRuntimes();
      expect(runtimes.length).toBe(1);
      expect(runtimes[0].userId).toBe(aliceRow.id);
      expect(runtimes[0].status).toBe('degraded');

      // Ensure no sensitive substrings leaked into JSON serialization
      const json = JSON.stringify(runtimes);
      expect(json).not.toContain('SensitiveBobDbError');
      expect(json).not.toContain('db_secret');

      await system.close({ removeVolumes: true });
    });

    it('fails closed during upDemo on historical database missing quota limits with guidance to run demo:reset', async () => {
      await resetDemo({ repoRoot: tempRepo.repoRoot });
      const paths = getDemoPathConfig({ repoRoot: tempRepo.repoRoot });

      // Delete all quota_limits rows from database to simulate an older unmigrated demo database
      const db = new DatabaseSync(paths.dbPath);
      db.exec('DELETE FROM quota_limits');
      db.close();

      const fakeAdapter = new FakeUnitRuntimeContainerAdapter();
      await expect(
        launchDemoSystem({
          repoRoot: tempRepo.repoRoot,
          runtimeAdapter: fakeAdapter,
        })
      ).rejects.toThrow(/FAIL-CLOSED: Missing quota limits configuration in demo database.*pnpm run demo:reset/);
    });
  });
});
