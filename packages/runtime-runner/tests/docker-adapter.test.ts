/**
 * Docker Runtime Adapter & Zero-Network Transport Lifecycle Tests
 *
 * @module @enkeep/runtime-runner/tests/docker-adapter.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { PassThrough } from 'node:stream';
import {
  DockerRuntimeAdapter,
  SafeDockerClient,
  probeTransportFeasibility,
  runExecCli,
  bootDshRuntime,
  getProcessStartTime,
  isStartupHealthEnvelopeValid,
  isAuthenticReadyHealthEnvelope,
  parseRuntimeHealthStatus,
  TOOLS_UNAVAILABLE_REASONS,
  DockerDaemonError,
  DaemonDockerTransport,
  DAEMON_OPS,
  type LongRunningExecHandle,
} from '../src/index.js';

function createMockLongRunningExecHandle(responseFactory: (req: any) => any): LongRunningExecHandle {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let buffer = '';

  stdin.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) {
        try {
          const req = JSON.parse(line.trim());
          const resp = responseFactory(req);
          stdout.write(JSON.stringify(resp) + '\n');
        } catch {}
      }
    }
  });

  return {
    pid: 12345,
    stdin,
    stdout,
    stderr,
    exitPromise: new Promise(() => {}),
    kill: () => {},
  };
}

describe('Docker Runtime Adapter & Zero-Network Subsystem', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-pkg-adapter-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('Spec Generation & Zero-Network Default Rules', () => {
    const adapter = new DockerRuntimeAdapter();

    it('creates compliant zero-network specs for Alice and Bob with volumeId and zero open ports', () => {
      const aliceSpec = adapter.createDefaultUserSpec({
        userId: 'alice',
      });

      const bobSpec = adapter.createDefaultUserSpec({
        userId: 'bob',
      });

      expect(aliceSpec.containerName).toBe('enkeep-demo-alice');
      expect(aliceSpec.volume.volumeName).toBe('enkeep-demo-dsh-alice');
      expect(aliceSpec.volume.volumeId).toBeDefined();
      expect(aliceSpec.volume.volumeId).toMatch(/^vol_[0-9a-f]{32}$/);
      expect(aliceSpec.labels.app).toBe('enkeep-demo');
      expect(aliceSpec.labels['enkeep.user']).toBe('alice');
      expect(aliceSpec.labels['enkeep.run-id']).toBeDefined();
      expect(aliceSpec.labels['enkeep.volume-id']).toBe(aliceSpec.volume.volumeId);
      expect(aliceSpec.runId).toBeDefined();
      expect(aliceSpec.networkMode).toBe('none');
      expect('publishedPorts' in (aliceSpec as Record<string, unknown>)).toBe(false);
      expect(aliceSpec.environment.HOST).toBeUndefined();
      expect(aliceSpec.environment.PORT).toBeUndefined();

      expect(bobSpec.containerName).toBe('enkeep-demo-bob');
      expect(bobSpec.volume.volumeName).toBe('enkeep-demo-dsh-bob');
      expect(bobSpec.volume.volumeId).toBeDefined();
      expect(bobSpec.volume.volumeId).toMatch(/^vol_[0-9a-f]{32}$/);
      expect(bobSpec.labels.app).toBe('enkeep-demo');
      expect(bobSpec.labels['enkeep.user']).toBe('bob');
      expect(bobSpec.labels['enkeep.run-id']).toBeDefined();
      expect(bobSpec.labels['enkeep.volume-id']).toBe(bobSpec.volume.volumeId);
      expect(bobSpec.runId).toBeDefined();
      expect(bobSpec.networkMode).toBe('none');
      expect('publishedPorts' in (bobSpec as Record<string, unknown>)).toBe(false);
      expect(bobSpec.environment.HOST).toBeUndefined();
      expect(bobSpec.environment.PORT).toBeUndefined();

      expect(() => adapter.validateUserPair(aliceSpec, bobSpec)).not.toThrow();
    });

    it('allows caller-supplied random name suffix and custom volumeId safely', () => {
      const customVolId = 'vol_0123456789abcdef0123456789abcdef';
      const aliceSpec = adapter.createDefaultUserSpec({
        userId: 'alice',
        nameSuffix: 'rnd123',
        volumeId: customVolId,
        runId: 'run_alice_custom_888',
      });

      expect(aliceSpec.containerName).toBe('enkeep-demo-alice-rnd123');
      expect(aliceSpec.volume.volumeName).toBe('enkeep-demo-dsh-alice-rnd123');
      expect(aliceSpec.volume.volumeId).toBe(customVolId);
      expect(aliceSpec.runId).toBe('run_alice_custom_888');
      expect(aliceSpec.labels['enkeep.volume-id']).toBe(customVolId);
      expect(aliceSpec.labels['enkeep.run-id']).toBe('run_alice_custom_888');
    });

    it('rejects invalid caller-supplied runId or volumeId formats in createDefaultUserSpec', () => {
      expect(() =>
        adapter.createDefaultUserSpec({
          userId: 'alice',
          runId: 'invalid_run_format',
        })
      ).toThrow(/Invalid caller-supplied runId/);

      expect(() =>
        adapter.createDefaultUserSpec({
          userId: 'alice',
          volumeId: 'invalid_vol_format',
        })
      ).toThrow(/Invalid caller-supplied volumeId/);
    });
  });

  describe('Transport Probing & Platform Diagnostics', () => {
    it('accurately probes transport feasibility recommending exec transport on macOS', () => {
      const result = probeTransportFeasibility();
      expect(result.platform).toBe(process.platform);
      expect(result.recommendedTransport).toBeDefined();
      expect(result.zeroNetworkExecSupported).toBe(true);
      expect(result.rationale).toBeDefined();
      expect(result.technicalEvidence.length).toBeGreaterThan(0);

      if (process.platform === 'darwin') {
        expect(result.isMacOs).toBe(true);
        expect(result.zeroNetworkExecSupported).toBe(true);
        expect(result.recommendedTransport).toBe('exec');
      }
    });
  });

  describe('In-Container Exec CLI Runner Flow', () => {
    it('unconditionally rejects non-idle Exec CLI when current UID is not 1000', async () => {
      const aliceHome = path.join(tmpDir, 'alice', '.dsh');
      process.env.DSH_USER = 'alice';
      process.env.DSH_HOME = aliceHome;
      process.env.DSH_SPACES = path.join(tmpDir, 'alice', 'spaces');

      if (typeof process.getuid === 'function' && process.getuid() !== 1000) {
        let capturedOutput = '';
        const originalStdoutWrite = process.stdout.write.bind(process.stdout);
        process.stdout.write = (chunk: string | Uint8Array) => {
          capturedOutput += chunk.toString();
          return true;
        };

        try {
          await runExecCli(['health']);
          const envelope = JSON.parse(capturedOutput.trim());
          expect(envelope.status).toBe('error');
          expect(envelope.code).toBe('SECURITY_VIOLATION');
          expect(envelope.error).toContain('UID 1000');
        } finally {
          process.stdout.write = originalStdoutWrite;
        }
      }
    });

    it('executes health check via bootDshRuntime and verifies readiness', async () => {
      const aliceHome = path.join(tmpDir, 'alice', '.dsh');
      const aliceSpaces = path.join(tmpDir, 'alice', 'spaces');
      fs.mkdirSync(aliceHome, { recursive: true, mode: 0o700 });
      fs.mkdirSync(aliceSpaces, { recursive: true, mode: 0o700 });

      const runtime = await bootDshRuntime({
        userId: 'alice',
        dshHome: aliceHome,
        spacesDir: aliceSpaces,
      });

      try {
        const health = await runtime.getHealth();
        expect(health.status).toBe('ok');
        expect(health.userId).toBe('alice');
        expect(health.dshReady).toBe(true);
        expect(health.enkeepBundleLoaded).toBe(true);
        expect(health.plugins.tools).toBe(true);
        expect(health.toolsOperational).toBe(false);
        expect(health.toolsCount).toBeGreaterThanOrEqual(4);
        expect(health.plugins.receiptStore).toBe(true);
      } finally {
        await runtime.dispose();
      }
    });

    it('executes followup turn via bootDshRuntime and persists session', async () => {
      const aliceHome = path.join(tmpDir, 'alice', '.dsh');
      const aliceSpaces = path.join(tmpDir, 'alice', 'spaces');
      fs.mkdirSync(aliceHome, { recursive: true, mode: 0o700 });
      fs.mkdirSync(aliceSpaces, { recursive: true, mode: 0o700 });

      const runtime = await bootDshRuntime({
        userId: 'alice',
        dshHome: aliceHome,
        spacesDir: aliceSpaces,
      });

      try {
        const sessionId = 'ses_00000000000000000000000000000001';
        const turnId = 'turn_00000000000000000000000000000001';
        const response = await runtime.sendFollowup(
          'Hello from DSH runtime test',
          sessionId,
          turnId,
          null
        );
        expect(response.status).toBe('completed');
        expect(response.turnId).toBe(turnId);
        expect(response.replyText).toContain('[DemoModel:alice]');
        expect(response.replyText).toContain('Hello from DSH runtime test');
        expect(response.sessionId).toBe(sessionId);
        expect(response.persisted).toBe(true);
      } finally {
        await runtime.dispose();
      }
    });

    it('executes cancel action via bootDshRuntime', async () => {
      const aliceHome = path.join(tmpDir, 'alice', '.dsh');
      const aliceSpaces = path.join(tmpDir, 'alice', 'spaces');
      fs.mkdirSync(aliceHome, { recursive: true, mode: 0o700 });
      fs.mkdirSync(aliceSpaces, { recursive: true, mode: 0o700 });

      const runtime = await bootDshRuntime({
        userId: 'alice',
        dshHome: aliceHome,
        spacesDir: aliceSpaces,
      });

      try {
        const turnId = 'turn_00000000000000000000000000000002';
        const sessionId = 'ses_00000000000000000000000000000002';
        const followupPromise = runtime.sendFollowup(
          'Long running turn [enkeep-test-delay-ms=1500]',
          sessionId,
          turnId,
          null
        );

        await new Promise((r) => setTimeout(r, 100));

        const cancelled = await runtime.cancelTurn(turnId);
        expect(cancelled).toBe(true);

        const response = await followupPromise;
        expect(response.status).toBe('cancelled');
        expect(response.turnId).toBe(turnId);
        expect(response.sessionId).toBe(sessionId);
      } finally {
        await runtime.dispose();
      }
    });
  });

  describe('Safe Docker Client Guardrails', () => {
    const client = new SafeDockerClient();
    const valid64HexId = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    it('rejects unsafe container names not starting with enkeep-demo-', async () => {
      const validVolId = 'vol_0123456789abcdef0123456789abcdef';
      await expect(client.inspectContainer('happyclaw-prod')).rejects.toThrow(
        /Safety Violation/
      );
      await expect(
        client.stopContainer({
          containerName: 'production-database',
          userId: 'admin',
          runId: 'run_1',
          containerId: valid64HexId,
          volumeName: 'enkeep-demo-dsh-admin',
          volumeId: validVolId,
          containerPath: '/home/dsh',
        })
      ).rejects.toThrow(/Safety Violation/);
      await expect(
        client.removeContainer({
          containerName: 'dsh-core-app',
          userId: 'admin',
          runId: 'run_1',
          containerId: valid64HexId,
          volumeName: 'enkeep-demo-dsh-admin',
          volumeId: validVolId,
          containerPath: '/home/dsh',
        })
      ).rejects.toThrow(/Safety Violation/);
      await expect(
        client.execOwned(
          {
            containerName: 'unauthorized-target',
            userId: 'admin',
            runId: 'run_1',
            containerId: valid64HexId,
            volumeName: 'enkeep-demo-dsh-admin',
            volumeId: validVolId,
            containerPath: '/home/dsh',
          },
          { action: 'health' }
        )
      ).rejects.toThrow(/Safety Violation/);
    });

    it('startRuntimeWithOwnedVolume starts a container attaching owned volume and boots healthy handle', async () => {
      const clientInstance = new SafeDockerClient();
      const adapterInstance = new DockerRuntimeAdapter(clientInstance);

      const spec = adapterInstance.createDefaultUserSpec({
        userId: 'alice',
        runId: 'run_test_adapter_1',
        volumeId: 'vol_0123456789abcdef0123456789abcdef',
      });

      const valid64HexId = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

      vi.spyOn(clientInstance, 'inspectContainer').mockImplementation(async (nameOrId) => {
        if (nameOrId === spec.containerName) return null;
        return {
          id: valid64HexId,
          name: spec.containerName,
          state: 'running',
          image: spec.image,
          labels: spec.labels,
          mounts: [],
        };
      });
      vi.spyOn(clientInstance, 'runContainerWithOwnedVolume').mockResolvedValue({
        containerId: valid64HexId,
        volumeCreated: false,
      });

      const mockExecHandle = createMockLongRunningExecHandle((req) => {
        if (req.op === 'health') {
          return {
            id: req.id,
            op: 'health',
            ok: true,
            health: {
              status: 'ok',
              dshReady: true,
              enkeepBundleLoaded: true,
              userId: 'alice',
              version: '0.1.1-rc.2',
              modelProvider: 'cpa-claude',
              uptimeSeconds: 10,
              plugins: {
                receiptStore: true,
                inbound: true,
                eventRelay: true,
                tools: false,
                externalInteraction: true,
                affinityPolicy: true,
                llmAffinity: true,
              },
              toolsCount: 4,
              toolsOperational: false,
              toolsUnavailableReason: TOOLS_UNAVAILABLE_REASONS.PLATFORM_CLIENT_UNAVAILABLE,
            },
            stats: {
              uptimeSeconds: 10,
              activeAgentsCount: 0,
              runningSessionsCount: 0,
              pendingTurnsCount: 0,
              evictionsCount: 0,
              totalTurnsProcessed: 0,
              maxAgents: 16,
              idleAgentTimeoutMs: 1800000,
              maxConcurrentSessions: 4,
            },
          };
        }
        return { id: req.id, op: req.op, ok: true };
      });

      vi.spyOn(clientInstance, 'spawnLongRunningExecOwned').mockResolvedValue(mockExecHandle);

      const handle = await adapterInstance.startRuntimeWithOwnedVolume(spec, 5000);
      expect(handle.containerId).toBe(valid64HexId);
      expect(handle.runId).toBe(spec.runId);
      expect(handle.volumeId).toBe(spec.volume.volumeId);

      const health = await handle.checkHealth();
      expect(health.status).toBe('ok');
      expect(health.dshReady).toBe(true);
    });

    it('rejects unsafe volume removal for non-demo volumes', async () => {
      const validVolId = 'vol_0123456789abcdef0123456789abcdef';
      await expect(
        client.removeVolume({
          volumeName: 'production_data',
          userId: 'admin',
          volumeId: validVolId,
        })
      ).rejects.toThrow(/Safety Violation/);
      await expect(
        client.removeVolume({
          volumeName: 'postgres_data',
          userId: 'admin',
          volumeId: validVolId,
        })
      ).rejects.toThrow(/Safety Violation/);
    });

    describe('Adapter Startup Fail-Closed on Non-Authentic Envelopes', () => {
      const valid64HexId = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
      const validVolId = 'vol_0123456789abcdef0123456789abcdef';

      it('fails startup when health check fails or reports dshReady false', async () => {
        const clientInstance = new SafeDockerClient();
        const adapterInstance = new DockerRuntimeAdapter(clientInstance);
        const spec = adapterInstance.createDefaultUserSpec({
          userId: 'alice',
          runId: 'run_test_missing_tools_op',
          volumeId: validVolId,
        });

        vi.spyOn(clientInstance, 'inspectContainer').mockImplementation(async (nameOrId) => {
          if (nameOrId === spec.containerName) return null;
          return {
            id: valid64HexId,
            name: spec.containerName,
            state: 'running',
            image: spec.image,
            labels: spec.labels,
            mounts: [],
          };
        });
        vi.spyOn(clientInstance, 'runContainerWithOwnedVolume').mockResolvedValue({
          containerId: valid64HexId,
          volumeCreated: false,
        });
        vi.spyOn(clientInstance, 'stopContainer').mockResolvedValue(undefined as unknown as void);
        vi.spyOn(clientInstance, 'removeContainer').mockResolvedValue(undefined as unknown as void);

        const mockExecHandle = createMockLongRunningExecHandle((req) => {
          if (req.op === 'health') {
            return {
              id: req.id,
              op: 'health',
              ok: true,
              health: {
                status: 'error',
                dshReady: false,
                enkeepBundleLoaded: true,
                userId: 'alice',
                version: '0.1.1-rc.2',
                modelProvider: 'cpa-claude',
                uptimeSeconds: 10,
                plugins: {
                  receiptStore: true,
                  inbound: true,
                  eventRelay: true,
                  tools: false,
                  externalInteraction: true,
                  affinityPolicy: true,
                  llmAffinity: true,
                },
                toolsCount: 4,
                toolsOperational: false,
                toolsUnavailableReason: TOOLS_UNAVAILABLE_REASONS.PLATFORM_CLIENT_UNAVAILABLE,
              },
            };
          }
          return { id: req.id, op: req.op, ok: false };
        });

        vi.spyOn(clientInstance, 'spawnLongRunningExecOwned').mockResolvedValue(mockExecHandle);

        await expect(adapterInstance.startRuntimeWithOwnedVolume(spec, 300)).rejects.toThrow(
          /failed to reach healthy status/
        );
      });

      it('fails startup when container exits before reaching healthy status', async () => {
        const clientInstance = new SafeDockerClient();
        const adapterInstance = new DockerRuntimeAdapter(clientInstance);
        const spec = adapterInstance.createDefaultUserSpec({
          userId: 'alice',
          runId: 'run_test_user_mismatch',
          volumeId: validVolId,
        });

        vi.spyOn(clientInstance, 'inspectContainer').mockImplementation(async (nameOrId) => {
          if (nameOrId === spec.containerName) return null;
          return {
            id: valid64HexId,
            name: spec.containerName,
            state: 'exited',
            image: spec.image,
            labels: spec.labels,
            mounts: [],
          };
        });
        vi.spyOn(clientInstance, 'runContainerWithOwnedVolume').mockResolvedValue({
          containerId: valid64HexId,
          volumeCreated: false,
        });
        vi.spyOn(clientInstance, 'stopContainer').mockResolvedValue(undefined as unknown as void);
        vi.spyOn(clientInstance, 'removeContainer').mockResolvedValue(undefined as unknown as void);

        await expect(adapterInstance.startRuntimeWithOwnedVolume(spec, 300)).rejects.toThrow(
          /daemon startup failed: container exited/
        );
      });

      it('fails startup when bridge spawn fails repeatedly', async () => {
        const clientInstance = new SafeDockerClient();
        const adapterInstance = new DockerRuntimeAdapter(clientInstance);
        const spec = adapterInstance.createDefaultUserSpec({
          userId: 'alice',
          runId: 'run_test_plugin_false',
          volumeId: validVolId,
        });

        vi.spyOn(clientInstance, 'inspectContainer').mockImplementation(async (nameOrId) => {
          if (nameOrId === spec.containerName) return null;
          return {
            id: valid64HexId,
            name: spec.containerName,
            state: 'running',
            image: spec.image,
            labels: spec.labels,
            mounts: [],
          };
        });
        vi.spyOn(clientInstance, 'runContainerWithOwnedVolume').mockResolvedValue({
          containerId: valid64HexId,
          volumeCreated: false,
        });
        vi.spyOn(clientInstance, 'stopContainer').mockResolvedValue(undefined as unknown as void);
        vi.spyOn(clientInstance, 'removeContainer').mockResolvedValue(undefined as unknown as void);

        vi.spyOn(clientInstance, 'spawnLongRunningExecOwned').mockRejectedValue(
          new DockerDaemonError('Failed to spawn bridge')
        );

        await expect(adapterInstance.startRuntimeWithOwnedVolume(spec, 300)).rejects.toThrow(
          /Failed to spawn daemon bridge process|failed to reach healthy status/
        );
      });
    });

    describe('isAuthenticReadyHealthEnvelope Strict Invariant Validation', () => {
      const expectation = {
        containerName: 'enkeep-demo-alice',
        userId: 'alice',
        runId: 'run_1',
        containerId: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        volumeName: 'enkeep-demo-dsh-alice',
        volumeId: 'vol_0123456789abcdef0123456789abcdef',
        containerPath: '/home/dsh',
      };

      const validDisabledToolsEnvelope = {
        status: 'ok' as const,
        userId: 'alice',
        uptimeSeconds: 10,
        version: '0.1.1-rc.2',
        modelProvider: 'cpa-claude',
        dshReady: true,
        enkeepBundleLoaded: true,
        plugins: {
          receiptStore: true,
          inbound: true,
          eventRelay: true,
          tools: false,
          externalInteraction: true,
          affinityPolicy: true,
          llmAffinity: true,
        },
        toolsCount: 4,
        toolsOperational: false,
        toolsUnavailableReason: TOOLS_UNAVAILABLE_REASONS.PLATFORM_CLIENT_UNAVAILABLE,
      };

      const validEnabledToolsEnvelope = {
        status: 'ok' as const,
        userId: 'alice',
        uptimeSeconds: 10,
        version: '0.1.1-rc.2',
        modelProvider: 'cpa-claude',
        dshReady: true,
        enkeepBundleLoaded: true,
        plugins: {
          receiptStore: true,
          inbound: true,
          eventRelay: true,
          tools: true,
          externalInteraction: true,
          affinityPolicy: true,
          llmAffinity: true,
        },
        toolsCount: 4,
        toolsOperational: true,
      };

      it('accepts valid envelope with tools honestly disabled under zero-network', () => {
        expect(isAuthenticReadyHealthEnvelope(validDisabledToolsEnvelope, 'alice')).toBe(true);
        expect(isStartupHealthEnvelopeValid(validDisabledToolsEnvelope, expectation)).toBe(true);
      });

      it('accepts valid envelope with tools operational', () => {
        expect(isAuthenticReadyHealthEnvelope(validEnabledToolsEnvelope, 'alice')).toBe(true);
        expect(isStartupHealthEnvelopeValid(validEnabledToolsEnvelope, expectation)).toBe(true);
      });

      it('rejects envelope with missing or mismatched userId', () => {
        expect(isAuthenticReadyHealthEnvelope({ ...validDisabledToolsEnvelope, userId: undefined }, 'alice')).toBe(false);
        expect(isAuthenticReadyHealthEnvelope({ ...validDisabledToolsEnvelope, userId: 'bob' }, 'alice')).toBe(false);
      });

      it('rejects envelope with missing or negative uptimeSeconds', () => {
        expect(isAuthenticReadyHealthEnvelope({ ...validDisabledToolsEnvelope, uptimeSeconds: undefined }, 'alice')).toBe(false);
        expect(isAuthenticReadyHealthEnvelope({ ...validDisabledToolsEnvelope, uptimeSeconds: -1 }, 'alice')).toBe(false);
      });

      it('rejects envelope with missing or empty version', () => {
        expect(isAuthenticReadyHealthEnvelope({ ...validDisabledToolsEnvelope, version: undefined }, 'alice')).toBe(false);
        expect(isAuthenticReadyHealthEnvelope({ ...validDisabledToolsEnvelope, version: '' }, 'alice')).toBe(false);
      });

      it('rejects envelope with dshReady or enkeepBundleLoaded false', () => {
        expect(isAuthenticReadyHealthEnvelope({ ...validDisabledToolsEnvelope, dshReady: false }, 'alice')).toBe(false);
        expect(isAuthenticReadyHealthEnvelope({ ...validDisabledToolsEnvelope, enkeepBundleLoaded: false }, 'alice')).toBe(false);
      });

      it('rejects envelope with missing or invalid modelProvider', () => {
        expect(isAuthenticReadyHealthEnvelope({ ...validDisabledToolsEnvelope, modelProvider: undefined }, 'alice')).toBe(false);
        expect(isAuthenticReadyHealthEnvelope({ ...validDisabledToolsEnvelope, modelProvider: '' }, 'alice')).toBe(false);
        expect(isAuthenticReadyHealthEnvelope({ ...validDisabledToolsEnvelope, modelProvider: '   ' }, 'alice')).toBe(false);
        expect(isAuthenticReadyHealthEnvelope({ ...validDisabledToolsEnvelope, modelProvider: 'cpa-claude\n' }, 'alice')).toBe(false);
      });

      it('rejects envelope with missing toolsOperational', () => {
        expect(isAuthenticReadyHealthEnvelope({ ...validDisabledToolsEnvelope, toolsOperational: undefined }, 'alice')).toBe(false);
      });

      it('rejects envelope when toolsOperational is false but toolsUnavailableReason is missing or empty', () => {
        expect(isAuthenticReadyHealthEnvelope({ ...validDisabledToolsEnvelope, toolsUnavailableReason: undefined }, 'alice')).toBe(false);
        expect(isAuthenticReadyHealthEnvelope({ ...validDisabledToolsEnvelope, toolsUnavailableReason: '   ' }, 'alice')).toBe(false);
      });

      it('rejects envelope when toolsOperational is true but plugins.tools is false', () => {
        expect(
          isAuthenticReadyHealthEnvelope(
            {
              ...validEnabledToolsEnvelope,
              plugins: { ...validEnabledToolsEnvelope.plugins, tools: false },
            },
            'alice'
          )
        ).toBe(false);
      });

      it('rejects envelope when toolsOperational is true but toolsCount is less than 4', () => {
        expect(isAuthenticReadyHealthEnvelope({ ...validEnabledToolsEnvelope, toolsCount: 3 }, 'alice')).toBe(false);
      });

      it('rejects envelope when any of the 6 core required plugins is false', () => {
        expect(
          isAuthenticReadyHealthEnvelope(
            {
              ...validDisabledToolsEnvelope,
              plugins: { ...validDisabledToolsEnvelope.plugins, receiptStore: false },
            },
            'alice'
          )
        ).toBe(false);
        expect(
          isAuthenticReadyHealthEnvelope(
            {
              ...validDisabledToolsEnvelope,
              plugins: { ...validDisabledToolsEnvelope.plugins, inbound: false },
            },
            'alice'
          )
        ).toBe(false);
      });

      it('rejects envelope when any plugin is non-boolean', () => {
        expect(
          isAuthenticReadyHealthEnvelope(
            {
              ...validDisabledToolsEnvelope,
              plugins: { ...validDisabledToolsEnvelope.plugins, receiptStore: 'true' as unknown as boolean },
            },
            'alice'
          )
        ).toBe(false);
      });
    });

    describe('parseRuntimeHealthStatus Typed Parser & Fail-Closed Validation', () => {
      const validEnvelope = {
        status: 'ok' as const,
        userId: 'alice',
        uptimeSeconds: 12,
        version: '0.1.1-rc.2',
        modelProvider: 'cpa-gpt',
        dshReady: true,
        enkeepBundleLoaded: true,
        plugins: {
          receiptStore: true,
          inbound: true,
          eventRelay: true,
          tools: false,
          externalInteraction: true,
          affinityPolicy: true,
          llmAffinity: true,
        },
        toolsCount: 7,
        toolsOperational: false,
        toolsUnavailableReason: TOOLS_UNAVAILABLE_REASONS.PLATFORM_CLIENT_UNAVAILABLE,
      };

      it('parses valid health envelope into strongly-typed RuntimeHealthStatus with modelProvider', () => {
        const health = parseRuntimeHealthStatus(validEnvelope, 'alice');
        expect(health.status).toBe('ok');
        expect(health.userId).toBe('alice');
        expect(health.uptimeSeconds).toBe(12);
        expect(health.version).toBe('0.1.1-rc.2');
        expect(health.modelProvider).toBe('cpa-gpt');
        expect(health.dshReady).toBe(true);
        expect(health.enkeepBundleLoaded).toBe(true);
        expect(health.toolsOperational).toBe(false);
        expect(health.toolsUnavailableReason).toBe(TOOLS_UNAVAILABLE_REASONS.PLATFORM_CLIENT_UNAVAILABLE);
        expect(health.plugins.receiptStore).toBe(true);
      });

      it('computes degraded status when enkeepBundleLoaded is false or core plugin is false', () => {
        const degradedEnvelope = {
          ...validEnvelope,
          enkeepBundleLoaded: false,
        };
        const health = parseRuntimeHealthStatus(degradedEnvelope, 'alice');
        expect(health.status).toBe('degraded');
      });

      it('computes error status when dshReady is false', () => {
        const errorEnvelope = {
          ...validEnvelope,
          dshReady: false,
        };
        const health = parseRuntimeHealthStatus(errorEnvelope, 'alice');
        expect(health.status).toBe('error');
      });

      it('fails closed and throws DockerDaemonError on invalid/missing modelProvider', () => {
        expect(() => parseRuntimeHealthStatus({ ...validEnvelope, modelProvider: undefined }, 'alice')).toThrow(DockerDaemonError);
        expect(() => parseRuntimeHealthStatus({ ...validEnvelope, modelProvider: '' }, 'alice')).toThrow(DockerDaemonError);
        expect(() => parseRuntimeHealthStatus({ ...validEnvelope, modelProvider: '   ' }, 'alice')).toThrow(DockerDaemonError);
      });

      it('fails closed and throws DockerDaemonError on userId mismatch or missing required fields', () => {
        expect(() => parseRuntimeHealthStatus(null, 'alice')).toThrow(DockerDaemonError);
        expect(() => parseRuntimeHealthStatus({ ...validEnvelope, userId: 'bob' }, 'alice')).toThrow(DockerDaemonError);
        expect(() => parseRuntimeHealthStatus({ ...validEnvelope, uptimeSeconds: -1 }, 'alice')).toThrow(DockerDaemonError);
        expect(() => parseRuntimeHealthStatus({ ...validEnvelope, version: '' }, 'alice')).toThrow(DockerDaemonError);
      });
    });

    describe('sendFollowup In-Container Mount Path Transformation', () => {
      it('transforms host mount sourcePath into in-container /home/dsh/mounts/<id> path', async () => {
        let capturedTransportRequest: any;
        const mockTransport: any = {
          checkHealth: vi.fn().mockResolvedValue({
            status: 'ok',
            userId: 'alice',
            uptimeSeconds: 12,
            version: '0.1.1-rc.2',
            modelProvider: 'cpa-gpt',
            dshReady: true,
            enkeepBundleLoaded: true,
            toolsOperational: true,
            toolsCount: 7,
            plugins: {
              receiptStore: true,
              inbound: true,
              eventRelay: true,
              tools: true,
              externalInteraction: true,
              affinityPolicy: true,
              llmAffinity: true,
            },
          }),
          isConnected: vi.fn().mockReturnValue(true),
          start: vi.fn().mockResolvedValue(undefined),
          sendFollowup: vi.fn().mockImplementation(async (req) => {
            capturedTransportRequest = req;
            return {
              status: 'completed',
              turnId: req.turnId,
              sessionId: req.sessionId,
              replyText: 'Echo reply',
              eventsCount: 1,
              persisted: true,
            };
          }),
        };

        const valid64HexId = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
        const clientInstance = new SafeDockerClient();
        const adapter = new DockerRuntimeAdapter({
          client: clientInstance,
          daemonTransportFactory: () => mockTransport,
        });
        const spec = adapter.createDefaultUserSpec({ userId: 'alice' });

        vi.spyOn(clientInstance, 'inspectContainer').mockImplementation(async (nameOrId) => {
          if (nameOrId === spec.containerName) return null;
          return {
            id: valid64HexId,
            name: spec.containerName,
            user: '1000:1000',
            state: 'running',
            status: 'running',
            networkMode: 'none',
            readonlyRootfs: true,
            capDrop: ['ALL'],
            securityOpt: ['no-new-privileges:true'],
            pidsLimit: 256,
            portBindings: null,
            tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=64m' },
            labels: {
              app: 'enkeep-demo',
              'enkeep.user': 'alice',
              'enkeep.run-id': spec.runId,
              'enkeep.volume-id': spec.volume.volumeId,
            },
            mounts: [
              {
                type: 'volume',
                name: spec.volume.volumeName,
                destination: '/home/dsh',
                source: '/var/lib/docker/volumes/enkeep-demo-dsh-alice/_data',
                rw: true,
              },
            ],
          };
        });

        const handle = (adapter as any).createActiveRuntimeHandle(
          spec,
          valid64HexId,
          {
            containerName: spec.containerName,
            userId: spec.userId,
            runId: spec.runId,
            containerId: valid64HexId,
            volumeName: spec.volume.volumeName,
            volumeId: spec.volume.volumeId,
            containerPath: spec.volume.containerPath,
          },
          false
        );

        const hostMounts = [
          {
            id: 'mnt_0123456789abcdef',
            name: 'ro_mount',
            sourcePath: '/var/folders/temp/host-mount-ro',
            mode: 'ro' as const,
          },
          {
            id: 'mnt_fedcba9876543210',
            name: 'rw_mount',
            sourcePath: '/var/folders/temp/host-mount-rw',
            mode: 'rw' as const,
          },
        ];

        const turnRes = await handle.sendFollowup({
          prompt: 'Test turn',
          sessionId: 'ses_00000000000000000000000000000001',
          turnId: 'turn_00000000000000000000000000000001',
          mounts: hostMounts,
        });

        expect(turnRes.status).toBe('completed');
        expect(capturedTransportRequest).toBeDefined();
        expect(capturedTransportRequest.mounts).toEqual([
          {
            id: 'mnt_0123456789abcdef',
            name: 'ro_mount',
            sourcePath: '/home/dsh/mounts/mnt_0123456789abcdef',
            mode: 'ro',
          },
          {
            id: 'mnt_fedcba9876543210',
            name: 'rw_mount',
            sourcePath: '/home/dsh/mounts/mnt_fedcba9876543210',
            mode: 'rw',
          },
        ]);
      });
    });

    describe('DaemonDockerTransport Reconnect Exhaustion & Error Containment', () => {
      it('reconnect exhaustion without error listener does not throw unhandled exception and rejects pending requests', async () => {
        let spawnCount = 0;
        const mockClient = {
          spawnLongRunningExecOwned: vi.fn(async () => {
            spawnCount++;
            const stdin = new PassThrough();
            const stdout = new PassThrough();
            const stderr = new PassThrough();
            let exitResolve: (val: any) => void;
            const exitPromise = new Promise((resolve) => {
              exitResolve = resolve;
            });
            // Immediately disconnect/exit to trigger reconnect loop
            setTimeout(() => {
              exitResolve({ exitCode: 1, signal: null });
            }, 10);
            return {
              pid: 9999 + spawnCount,
              stdin,
              stdout,
              stderr,
              exitPromise,
              kill: () => {},
            };
          }),
        } as unknown as SafeDockerClient;

        const expectation = {
          containerName: 'enkeep-demo-alice',
          userId: 'alice',
          runId: 'run_0123456789abcdef0123456789abcdef',
          containerId: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          volumeName: 'enkeep-demo-dsh-alice',
          volumeId: 'vol_0123456789abcdef0123456789abcdef',
        };

        const transport = new DaemonDockerTransport(mockClient, expectation, {
          maxRetries: 2,
          initialBackoffMs: 10,
          maxBackoffMs: 20,
          autoReconnect: true,
        });

        // No 'error' listener attached!
        expect(transport.listenerCount('error')).toBe(0);

        let transportErrorReceived: Error | null = null;
        transport.on('transportError', (err) => {
          transportErrorReceived = err;
        });

        // Start transport
        await transport.start();

        // Enqueue an in-flight turn request that will wait during reconnect
        const turnPromise = transport.submitTurnAndWait({
          id: 'req_test',
          op: DAEMON_OPS.SUBMIT_TURN,
          turnId: 'turn_00000000000000000000000000000001',
          sessionId: 'ses_00000000000000000000000000000001',
          prompt: 'hello',
        }, 5000);

        // Await turn promise to reject once retries exhaust
        await expect(turnPromise).rejects.toThrow(/Failed to reconnect to daemon after 2 attempts/);

        // State is marked stopped, fatal error is recorded, transportError is emitted, process did not crash
        expect(transport.getState()).toBe('stopped');
        expect(transport.getLastTerminalError()).toBeDefined();
        expect(transportErrorReceived).toBeDefined();
        expect((transportErrorReceived as any)?.message).toContain('Failed to reconnect to daemon after 2 attempts');
      });

      it('reconnect exhaustion with error listener delivers fatal error to listener and allows subsequent start', async () => {
        let shouldSucceed = false;
        const mockClient = {
          spawnLongRunningExecOwned: vi.fn(async () => {
            const stdin = new PassThrough();
            const stdout = new PassThrough();
            const stderr = new PassThrough();
            let exitResolve: (val: any) => void;
            const exitPromise = new Promise((resolve) => {
              exitResolve = resolve;
            });
            if (!shouldSucceed) {
              setTimeout(() => {
                exitResolve({ exitCode: 1, signal: null });
              }, 10);
            }
            return {
              pid: 8888,
              stdin,
              stdout,
              stderr,
              exitPromise,
              kill: () => {},
            };
          }),
        } as unknown as SafeDockerClient;

        const expectation = {
          containerName: 'enkeep-demo-bob',
          userId: 'bob',
          runId: 'run_0123456789abcdef0123456789abcdef',
          containerId: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          volumeName: 'enkeep-demo-dsh-bob',
          volumeId: 'vol_0123456789abcdef0123456789abcdef',
        };

        const transport = new DaemonDockerTransport(mockClient, expectation, {
          maxRetries: 1,
          initialBackoffMs: 10,
          maxBackoffMs: 20,
          autoReconnect: true,
        });

        let errorListenerFired: Error | null = null;
        transport.on('error', (err) => {
          errorListenerFired = err;
        });

        await transport.start();

        // Wait for reconnect retries to exhaust
        await new Promise((r) => setTimeout(r, 100));

        expect(transport.getState()).toBe('stopped');
        expect(errorListenerFired).toBeDefined();
        expect((errorListenerFired as any)?.message).toContain('Failed to reconnect to daemon after 1 attempts');

        // Subsequent explicit start can reset terminal state and reconnect
        shouldSucceed = true;
        await transport.start();
        expect(transport.isConnected()).toBe(true);
        expect(transport.getState()).toBe('connected');
        expect(transport.getLastTerminalError()).toBeNull();

        await transport.close();
        // After explicit close, start throws DockerOwnershipError
        await expect(transport.start()).rejects.toThrow(/Cannot start a stopped DaemonDockerTransport/);
      });
    });
  });
});
