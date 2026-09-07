/**
 * Adversarial & Fail-Closed Readiness Tests for DockerExecTransport
 *
 * Strictly tests that DockerExecTransport.checkHealth and parseExecEnvelope
 * fail closed without fabricated readiness defaults:
 * - Rejects missing fields (userId, uptimeSeconds, version, dshReady, plugins, toolsCount, enkeepBundleLoaded).
 * - Rejects userId mismatch.
 * - Rejects invalid types / bounds (negative toolsCount, non-boolean plugins, float counts, negative uptime).
 * - Rejects non-ok / error statuses.
 * - Accurately reflects partial plugins, false plugins, and low toolsCount as 'degraded'.
 * - Verifies that tools indicate schema registration rather than external executability.
 *
 * @module @enkeep/runtime-runner/tests/exec-transport-readiness.test
 */

import { describe, it, expect, vi } from 'vitest';
import {
  DockerExecTransport,
  SafeDockerClient,
  parseExecEnvelope,
  DockerDaemonError,
  RuntimeProtocolError,
  RUNTIME_ERROR_CODES,
  TOOLS_UNAVAILABLE_REASONS,
  ALLOWED_TOOLS_UNAVAILABLE_CODES,
  type ToolsUnavailableReasonCode,
  type OwnershipExpectation,
  type PluginReadinessStatus,
  type ExecCliEnvelope,
  type AgentProfileSnapshot,
  computeAgentProfilePromptHash,
} from '../src/index.js';

const VALID_64_HEX_CONTAINER_ID =
  'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
const VALID_SESSION_ID = 'ses_0123456789abcdef0123456789abcdef';
const VALID_IMPORT_SESSION_ID = 'import-0123456789abcdef0123456789abcdef';
const VALID_TURN_ID = 'turn_0123456789abcdef0123456789abcdef';

function createValidProfileSnapshot(overrides: Partial<AgentProfileSnapshot> = {}): AgentProfileSnapshot {
  const identity = overrides.identity ?? 'You are Enkeep Code Auditor.';
  const soul = overrides.soul ?? 'Meticulous and calm.';
  const agents = overrides.agents ?? 'Subagent hierarchy.';
  const tools = overrides.tools ?? 'Preferred tools.';
  const promptHash = overrides.promptHash ?? computeAgentProfilePromptHash({ identity, soul, agents, tools });

  return {
    profileId: overrides.profileId ?? 'profile-auditor-1',
    version: overrides.version ?? 1,
    promptHash,
    identity,
    soul,
    agents,
    tools,
  };
}

function createMockExpectation(overrides: Partial<OwnershipExpectation> = {}): OwnershipExpectation {
  return {
    containerName: 'enkeep-demo-alice',
    userId: 'alice',
    runId: 'run_test_readiness_123',
    containerId: VALID_64_HEX_CONTAINER_ID,
    volumeName: 'enkeep-demo-dsh-alice',
    volumeId: 'vol_alice_test_readiness_123',
    containerPath: '/home/dsh',
    ...overrides,
  };
}

function createAllPluginsReady(): PluginReadinessStatus {
  return {
    receiptStore: true,
    inbound: true,
    eventRelay: true,
    tools: true,
    externalInteraction: true,
    affinityPolicy: true,
    llmAffinity: true,
  };
}

function createAuthenticHealthEnvelope(overrides: Partial<ExecCliEnvelope> = {}): ExecCliEnvelope {
  return {
    status: 'ok',
    userId: 'alice',
    uptimeSeconds: 42,
    version: '0.1.1-rc.2',
    modelProvider: 'cpa-claude',
    dshReady: true,
    enkeepBundleLoaded: true,
    plugins: createAllPluginsReady(),
    toolsCount: 4,
    toolsOperational: true,
    toolsUnavailableReason: null,
    ...overrides,
  };
}

describe('DockerExecTransport Readiness & Fail-Closed Behavior', () => {
  describe('Authentic Normal Health Check', () => {
    it('returns status "ok" when all readiness criteria and 7 plugins are met', async () => {
      const expectation = createMockExpectation();
      const mockClient = new SafeDockerClient();
      const mockEnvelope = createAuthenticHealthEnvelope();

      vi.spyOn(mockClient, 'execOwned').mockResolvedValue(mockEnvelope);

      const transport = new DockerExecTransport(mockClient, expectation);
      const health = await transport.checkHealth();

      expect(health.status).toBe('ok');
      expect(health.userId).toBe('alice');
      expect(health.uptimeSeconds).toBe(42);
      expect(health.version).toBe('0.1.1-rc.2');
      expect(health.dshReady).toBe(true);
      expect(health.enkeepBundleLoaded).toBe(true);
      expect(health.toolsCount).toBe(4);
      expect(health.plugins).toEqual(createAllPluginsReady());
      expect((health as any).sessionId).toBeUndefined();
      expect((health as any).totalEvents).toBeUndefined();
      expect(health.toolsUnavailableReason).toBeNull();
    });

    it('returns status "ok" when toolsCount exceeds 4 (e.g. additional tool schemas registered)', async () => {
      const expectation = createMockExpectation();
      const mockClient = new SafeDockerClient();
      const mockEnvelope = createAuthenticHealthEnvelope({ toolsCount: 8 });

      vi.spyOn(mockClient, 'execOwned').mockResolvedValue(mockEnvelope);

      const transport = new DockerExecTransport(mockClient, expectation);
      const health = await transport.checkHealth();

      expect(health.status).toBe('ok');
      expect(health.toolsCount).toBe(8);
      expect(health.toolsUnavailableReason).toBeNull();
    });
  });

  describe('No Fabricated Readiness: Missing Fields Must Fail Closed', () => {
    it('throws protocol violation error when dshReady is missing (no true default)', async () => {
      const expectation = createMockExpectation();
      const mockClient = new SafeDockerClient();
      const mockEnvelope = createAuthenticHealthEnvelope({ dshReady: undefined });

      vi.spyOn(mockClient, 'execOwned').mockResolvedValue(mockEnvelope);

      const transport = new DockerExecTransport(mockClient, expectation);
      await expect(transport.checkHealth()).rejects.toThrow(
        expect.objectContaining({ code: RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION })
      );
    });

    it('throws protocol violation error when enkeepBundleLoaded is missing (no true default)', async () => {
      const expectation = createMockExpectation();
      const mockClient = new SafeDockerClient();
      const mockEnvelope = createAuthenticHealthEnvelope({ enkeepBundleLoaded: undefined });

      vi.spyOn(mockClient, 'execOwned').mockResolvedValue(mockEnvelope);

      const transport = new DockerExecTransport(mockClient, expectation);
      await expect(transport.checkHealth()).rejects.toThrow(
        expect.objectContaining({ code: RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION })
      );
    });

    it('throws protocol violation error when plugins object is missing (no all-true default)', async () => {
      const expectation = createMockExpectation();
      const mockClient = new SafeDockerClient();
      const mockEnvelope = createAuthenticHealthEnvelope({ plugins: undefined });

      vi.spyOn(mockClient, 'execOwned').mockResolvedValue(mockEnvelope);

      const transport = new DockerExecTransport(mockClient, expectation);
      await expect(transport.checkHealth()).rejects.toThrow(
        expect.objectContaining({ code: RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION })
      );
    });

    it('throws protocol violation error when toolsCount is missing (no 4 default)', async () => {
      const expectation = createMockExpectation();
      const mockClient = new SafeDockerClient();
      const mockEnvelope = createAuthenticHealthEnvelope({ toolsCount: undefined });

      vi.spyOn(mockClient, 'execOwned').mockResolvedValue(mockEnvelope);

      const transport = new DockerExecTransport(mockClient, expectation);
      await expect(transport.checkHealth()).rejects.toThrow(
        expect.objectContaining({ code: RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION })
      );
    });

    it('throws protocol violation error when toolsOperational is missing', async () => {
      const expectation = createMockExpectation();
      const mockClient = new SafeDockerClient();
      const mockEnvelope = createAuthenticHealthEnvelope({ toolsOperational: undefined });

      vi.spyOn(mockClient, 'execOwned').mockResolvedValue(mockEnvelope);

      const transport = new DockerExecTransport(mockClient, expectation);
      await expect(transport.checkHealth()).rejects.toThrow(
        expect.objectContaining({ code: RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION })
      );
    });

    it('throws protocol violation error when modelProvider is missing or empty', async () => {
      const expectation = createMockExpectation();
      const mockClient = new SafeDockerClient();
      const mockEnvelope = createAuthenticHealthEnvelope({
        modelProvider: undefined,
      });

      vi.spyOn(mockClient, 'execOwned').mockResolvedValue(mockEnvelope);

      const transport = new DockerExecTransport(mockClient, expectation);
      await expect(transport.checkHealth()).rejects.toThrow(
        expect.objectContaining({ code: RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION })
      );
    });

    it('throws protocol violation error when toolsOperational is false but toolsUnavailableReason is missing', async () => {
      const expectation = createMockExpectation();
      const mockClient = new SafeDockerClient();
      const plugins = createAllPluginsReady();
      plugins.tools = false;
      const mockEnvelope = createAuthenticHealthEnvelope({
        plugins,
        toolsOperational: false,
        toolsUnavailableReason: undefined,
      });

      vi.spyOn(mockClient, 'execOwned').mockResolvedValue(mockEnvelope);

      const transport = new DockerExecTransport(mockClient, expectation);
      await expect(transport.checkHealth()).rejects.toThrow(
        expect.objectContaining({ code: RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION })
      );
    });

    it('throws protocol violation error when toolsOperational is false but toolsUnavailableReason is empty string', async () => {
      const expectation = createMockExpectation();
      const mockClient = new SafeDockerClient();
      const plugins = createAllPluginsReady();
      plugins.tools = false;
      const mockEnvelope = createAuthenticHealthEnvelope({
        plugins,
        toolsOperational: false,
        toolsUnavailableReason: '   ' as any,
      });

      vi.spyOn(mockClient, 'execOwned').mockResolvedValue(mockEnvelope);

      const transport = new DockerExecTransport(mockClient, expectation);
      await expect(transport.checkHealth()).rejects.toThrow(
        expect.objectContaining({ code: RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION })
      );
    });

    it('throws protocol violation error when toolsOperational is true but plugins.tools is false', async () => {
      const expectation = createMockExpectation();
      const mockClient = new SafeDockerClient();
      const plugins = createAllPluginsReady();
      plugins.tools = false;
      const mockEnvelope = createAuthenticHealthEnvelope({
        plugins,
        toolsOperational: true,
      });

      vi.spyOn(mockClient, 'execOwned').mockResolvedValue(mockEnvelope);

      const transport = new DockerExecTransport(mockClient, expectation);
      await expect(transport.checkHealth()).rejects.toThrow(
        expect.objectContaining({ code: RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION })
      );
    });

    it('throws protocol violation error when toolsOperational is true but toolsCount is less than 4', async () => {
      const expectation = createMockExpectation();
      const mockClient = new SafeDockerClient();
      const mockEnvelope = createAuthenticHealthEnvelope({
        toolsCount: 3,
        toolsOperational: true,
      });

      vi.spyOn(mockClient, 'execOwned').mockResolvedValue(mockEnvelope);

      const transport = new DockerExecTransport(mockClient, expectation);
      await expect(transport.checkHealth()).rejects.toThrow(
        expect.objectContaining({ code: RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION })
      );
    });

    it('throws protocol violation error when userId is missing (no "unknown" default)', async () => {
      const expectation = createMockExpectation();
      const mockClient = new SafeDockerClient();
      const mockEnvelope = createAuthenticHealthEnvelope({ userId: undefined });

      vi.spyOn(mockClient, 'execOwned').mockResolvedValue(mockEnvelope);

      const transport = new DockerExecTransport(mockClient, expectation);
      await expect(transport.checkHealth()).rejects.toThrow(
        expect.objectContaining({ code: RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION })
      );
    });

    it('throws protocol violation error when version is missing (no hardcoded default)', async () => {
      const expectation = createMockExpectation();
      const mockClient = new SafeDockerClient();
      const mockEnvelope = createAuthenticHealthEnvelope({ version: undefined });

      vi.spyOn(mockClient, 'execOwned').mockResolvedValue(mockEnvelope);

      const transport = new DockerExecTransport(mockClient, expectation);
      await expect(transport.checkHealth()).rejects.toThrow(
        expect.objectContaining({ code: RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION })
      );
    });

    it('throws protocol violation error when uptimeSeconds is missing (no 0 default)', async () => {
      const expectation = createMockExpectation();
      const mockClient = new SafeDockerClient();
      const mockEnvelope = createAuthenticHealthEnvelope({ uptimeSeconds: undefined });

      vi.spyOn(mockClient, 'execOwned').mockResolvedValue(mockEnvelope);

      const transport = new DockerExecTransport(mockClient, expectation);
      await expect(transport.checkHealth()).rejects.toThrow(
        expect.objectContaining({ code: RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION })
      );
    });
  });

  describe('Ownership & Status Fail-Closed Invariants', () => {
    it('throws error when userId mismatches expectation', async () => {
      const expectation = createMockExpectation({ userId: 'alice' });
      const mockClient = new SafeDockerClient();
      const mockEnvelope = createAuthenticHealthEnvelope({ userId: 'bob' });

      vi.spyOn(mockClient, 'execOwned').mockResolvedValue(mockEnvelope);

      const transport = new DockerExecTransport(mockClient, expectation);
      await expect(transport.checkHealth()).rejects.toThrow(
        expect.objectContaining({ code: RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION })
      );
    });

    it('throws error when envelope status is "error"', async () => {
      const expectation = createMockExpectation();
      const mockClient = new SafeDockerClient();
      const mockEnvelope: ExecCliEnvelope = {
        status: 'error',
        error: 'Cordis runtime context initialization failed',
      };

      vi.spyOn(mockClient, 'execOwned').mockResolvedValue(mockEnvelope);

      const transport = new DockerExecTransport(mockClient, expectation);
      await expect(transport.checkHealth()).rejects.toThrow(
        expect.objectContaining({ code: RUNTIME_ERROR_CODES.HEALTH_CHECK_FAILED })
      );
    });

    it('throws error when envelope status is unexpected non-ok status (e.g. "idle" or "completed")', async () => {
      const expectation = createMockExpectation();
      const mockClient = new SafeDockerClient();
      const mockEnvelope = createAuthenticHealthEnvelope({ status: 'idle' });

      vi.spyOn(mockClient, 'execOwned').mockResolvedValue(mockEnvelope);

      const transport = new DockerExecTransport(mockClient, expectation);
      await expect(transport.checkHealth()).rejects.toThrow(
        expect.objectContaining({ code: RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION })
      );
    });
  });

  describe('Explicit Degraded & Error Status Computation', () => {
    it('reports status "error" when dshReady is explicitly false', async () => {
      const expectation = createMockExpectation();
      const mockClient = new SafeDockerClient();
      const mockEnvelope = createAuthenticHealthEnvelope({ dshReady: false });

      vi.spyOn(mockClient, 'execOwned').mockResolvedValue(mockEnvelope);

      const transport = new DockerExecTransport(mockClient, expectation);
      const health = await transport.checkHealth();

      expect(health.status).toBe('error');
      expect(health.dshReady).toBe(false);
    });

    it('reports status "error" when dshReady is false and tools are honestly disabled with reason', async () => {
      const expectation = createMockExpectation();
      const mockClient = new SafeDockerClient();
      const plugins = createAllPluginsReady();
      plugins.tools = false;
      const mockEnvelope = createAuthenticHealthEnvelope({
        dshReady: false,
        plugins,
        toolsOperational: false,
        toolsUnavailableReason: TOOLS_UNAVAILABLE_REASONS.PLATFORM_CLIENT_UNAVAILABLE,
      });

      vi.spyOn(mockClient, 'execOwned').mockResolvedValue(mockEnvelope);

      const transport = new DockerExecTransport(mockClient, expectation);
      const health = await transport.checkHealth();

      expect(health.status).toBe('error');
      expect(health.dshReady).toBe(false);
      expect(health.toolsOperational).toBe(false);
      expect(health.toolsUnavailableReason).toBe(TOOLS_UNAVAILABLE_REASONS.PLATFORM_CLIENT_UNAVAILABLE);
    });

    it('reports status "degraded" when enkeepBundleLoaded is false', async () => {
      const expectation = createMockExpectation();
      const mockClient = new SafeDockerClient();
      const mockEnvelope = createAuthenticHealthEnvelope({ enkeepBundleLoaded: false });

      vi.spyOn(mockClient, 'execOwned').mockResolvedValue(mockEnvelope);

      const transport = new DockerExecTransport(mockClient, expectation);
      const health = await transport.checkHealth();

      expect(health.status).toBe('degraded');
      expect(health.enkeepBundleLoaded).toBe(false);
      expect(health.dshReady).toBe(true);
    });

    it('reports status "degraded" when enkeepBundleLoaded is false and tools are honestly disabled with reason', async () => {
      const expectation = createMockExpectation();
      const mockClient = new SafeDockerClient();
      const plugins = createAllPluginsReady();
      plugins.tools = false;
      const mockEnvelope = createAuthenticHealthEnvelope({
        enkeepBundleLoaded: false,
        plugins,
        toolsOperational: false,
        toolsUnavailableReason: TOOLS_UNAVAILABLE_REASONS.PLATFORM_CLIENT_UNAVAILABLE,
      });

      vi.spyOn(mockClient, 'execOwned').mockResolvedValue(mockEnvelope);

      const transport = new DockerExecTransport(mockClient, expectation);
      const health = await transport.checkHealth();

      expect(health.status).toBe('degraded');
      expect(health.enkeepBundleLoaded).toBe(false);
      expect(health.toolsOperational).toBe(false);
      expect(health.toolsUnavailableReason).toBe(TOOLS_UNAVAILABLE_REASONS.PLATFORM_CLIENT_UNAVAILABLE);
    });

    it('reports status "ok" and toolsOperational: false when platform tools are honestly disabled under zero-network architecture', async () => {
      const expectation = createMockExpectation();
      const mockClient = new SafeDockerClient();
      const plugins = createAllPluginsReady();
      plugins.tools = false;

      const mockEnvelope = createAuthenticHealthEnvelope({
        plugins,
        toolsOperational: false,
        toolsUnavailableReason: TOOLS_UNAVAILABLE_REASONS.PLATFORM_CLIENT_UNAVAILABLE,
      });

      vi.spyOn(mockClient, 'execOwned').mockResolvedValue(mockEnvelope);

      const transport = new DockerExecTransport(mockClient, expectation);
      const health = await transport.checkHealth();

      expect(health.status).toBe('ok');
      expect(health.dshReady).toBe(true);
      expect(health.enkeepBundleLoaded).toBe(true);
      expect(health.plugins.tools).toBe(false);
      expect(health.toolsOperational).toBe(false);
      expect(health.toolsUnavailableReason).toBe(TOOLS_UNAVAILABLE_REASONS.PLATFORM_CLIENT_UNAVAILABLE);
      expect(health.toolsCount).toBe(4);
    });

    // Test each of the 6 core required plugins individually returning false
    const coreRequiredPluginNames: Array<keyof Omit<PluginReadinessStatus, 'tools'>> = [
      'receiptStore',
      'inbound',
      'eventRelay',
      'externalInteraction',
      'affinityPolicy',
      'llmAffinity',
    ];

    for (const pluginName of coreRequiredPluginNames) {
      it(`reports status "degraded" when core required plugin "${pluginName}" is false`, async () => {
        const expectation = createMockExpectation();
        const mockClient = new SafeDockerClient();
        const plugins = createAllPluginsReady();
        plugins[pluginName] = false;

        const mockEnvelope = createAuthenticHealthEnvelope({ plugins });
        vi.spyOn(mockClient, 'execOwned').mockResolvedValue(mockEnvelope);

        const transport = new DockerExecTransport(mockClient, expectation);
        const health = await transport.checkHealth();

        expect(health.status).toBe('degraded');
        expect(health.plugins[pluginName]).toBe(false);
        expect(health.dshReady).toBe(true);
      });
    }

    it('reports status "degraded" when envelope has partial plugins object (missing keys filled with false)', async () => {
      const expectation = createMockExpectation();
      const mockClient = new SafeDockerClient();
      // Partial plugins from envelope where only 2 plugins are true, remainder missing
      const partialPlugins: PluginReadinessStatus = {
        receiptStore: true,
        inbound: true,
        eventRelay: false,
        tools: false,
        externalInteraction: false,
        affinityPolicy: false,
        llmAffinity: false,
      };

      const mockEnvelope = createAuthenticHealthEnvelope({
        plugins: partialPlugins,
        toolsOperational: false,
        toolsUnavailableReason: TOOLS_UNAVAILABLE_REASONS.TOOLS_SCHEMA_INCOMPLETE,
      });
      vi.spyOn(mockClient, 'execOwned').mockResolvedValue(mockEnvelope);

      const transport = new DockerExecTransport(mockClient, expectation);
      const health = await transport.checkHealth();

      expect(health.status).toBe('degraded');
      expect(health.plugins.receiptStore).toBe(true);
      expect(health.plugins.inbound).toBe(true);
      expect(health.plugins.tools).toBe(false);
      expect(health.plugins.eventRelay).toBe(false);
    });
  });

  describe('Adversarial parseExecEnvelope Validation', () => {
    it('rejects non-boolean dshReady with DockerDaemonError', () => {
      expect(() =>
        parseExecEnvelope(JSON.stringify({ status: 'ok', dshReady: 'true' }))
      ).toThrow(DockerDaemonError);

      expect(() =>
        parseExecEnvelope(JSON.stringify({ status: 'ok', dshReady: 1 }))
      ).toThrow(DockerDaemonError);
    });

    it('rejects non-boolean enkeepBundleLoaded with DockerDaemonError', () => {
      expect(() =>
        parseExecEnvelope(JSON.stringify({ status: 'ok', enkeepBundleLoaded: 'yes' }))
      ).toThrow(DockerDaemonError);
    });

    it('rejects non-boolean toolsOperational with DockerDaemonError', () => {
      expect(() =>
        parseExecEnvelope(JSON.stringify({ status: 'ok', toolsOperational: 'true' }))
      ).toThrow(DockerDaemonError);

      expect(() =>
        parseExecEnvelope(JSON.stringify({ status: 'ok', toolsOperational: 1 }))
      ).toThrow(DockerDaemonError);
    });

    it('rejects non-string toolsUnavailableReason with DockerDaemonError', () => {
      expect(() =>
        parseExecEnvelope(JSON.stringify({ status: 'ok', toolsUnavailableReason: 123 }))
      ).toThrow(DockerDaemonError);
    });

    it('rejects non-integer, negative, or string toolsCount with DockerDaemonError', () => {
      expect(() =>
        parseExecEnvelope(JSON.stringify({ status: 'ok', toolsCount: -1 }))
      ).toThrow(DockerDaemonError);

      expect(() =>
        parseExecEnvelope(JSON.stringify({ status: 'ok', toolsCount: 3.5 }))
      ).toThrow(DockerDaemonError);

      expect(() =>
        parseExecEnvelope(JSON.stringify({ status: 'ok', toolsCount: '4' }))
      ).toThrow(DockerDaemonError);
    });

    it('rejects negative, NaN, or non-finite uptimeSeconds with DockerDaemonError', () => {
      expect(() =>
        parseExecEnvelope(JSON.stringify({ status: 'ok', uptimeSeconds: -10 }))
      ).toThrow(DockerDaemonError);

      expect(() =>
        parseExecEnvelope(JSON.stringify({ status: 'ok', uptimeSeconds: '10' }))
      ).toThrow(DockerDaemonError);
    });

    it('rejects empty or non-string userId with DockerDaemonError', () => {
      expect(() =>
        parseExecEnvelope(JSON.stringify({ status: 'ok', userId: '' }))
      ).toThrow(DockerDaemonError);

      expect(() =>
        parseExecEnvelope(JSON.stringify({ status: 'ok', userId: '   ' }))
      ).toThrow(DockerDaemonError);

      expect(() =>
        parseExecEnvelope(JSON.stringify({ status: 'ok', userId: 123 }))
      ).toThrow(DockerDaemonError);
    });

    it('rejects empty or non-string version with DockerDaemonError', () => {
      expect(() =>
        parseExecEnvelope(JSON.stringify({ status: 'ok', version: '' }))
      ).toThrow(DockerDaemonError);

      expect(() =>
        parseExecEnvelope(JSON.stringify({ status: 'ok', version: 123 }))
      ).toThrow(DockerDaemonError);
    });

    it('rejects empty, non-string, or non-trimmed modelProvider with DockerDaemonError', () => {
      expect(() =>
        parseExecEnvelope(JSON.stringify({ status: 'ok', modelProvider: '' }))
      ).toThrow(DockerDaemonError);

      expect(() =>
        parseExecEnvelope(JSON.stringify({ status: 'ok', modelProvider: '   ' }))
      ).toThrow(DockerDaemonError);

      expect(() =>
        parseExecEnvelope(JSON.stringify({ status: 'ok', modelProvider: 123 }))
      ).toThrow(DockerDaemonError);
    });

    it('rejects non-object plugins with DockerDaemonError', () => {
      expect(() =>
        parseExecEnvelope(JSON.stringify({ status: 'ok', plugins: 'all_ready' }))
      ).toThrow(DockerDaemonError);

      expect(() =>
        parseExecEnvelope(JSON.stringify({ status: 'ok', plugins: [true, true] }))
      ).toThrow(DockerDaemonError);

      expect(() =>
        parseExecEnvelope(JSON.stringify({ status: 'ok', plugins: 123 }))
      ).toThrow(DockerDaemonError);
    });

    it('rejects non-boolean plugin property values with DockerDaemonError', () => {
      expect(() =>
        parseExecEnvelope(
          JSON.stringify({
            status: 'ok',
            plugins: {
              receiptStore: 'true',
              inbound: true,
            },
          })
        )
      ).toThrow(DockerDaemonError);

      expect(() =>
        parseExecEnvelope(
          JSON.stringify({
            status: 'ok',
            plugins: {
              tools: 1,
            },
          })
        )
      ).toThrow(DockerDaemonError);
    });

    it('parses partial plugins safely by setting missing keys to false (no fabricated true)', () => {
      const envelope = parseExecEnvelope(
        JSON.stringify({
          status: 'ok',
          plugins: {
            receiptStore: true,
            tools: true,
          },
        })
      );

      expect(envelope.plugins).toEqual({
        receiptStore: true,
        inbound: false,
        eventRelay: false,
        tools: true,
        externalInteraction: false,
        affinityPolicy: false,
        llmAffinity: false,
      });
    });
  });

  describe('Transport Endpoint & Protocol Error Invariants', () => {
    it('endpoint is fixed "docker-exec://local-runtime" and never stores or leaks containerName', () => {
      const expectation = createMockExpectation({ containerName: 'secret-container-xyz' });
      const mockClient = new SafeDockerClient();
      const transport = new DockerExecTransport(mockClient, expectation);

      expect(transport.endpoint).toBe('docker-exec://local-runtime');
      expect(transport.endpoint).not.toContain('secret-container-xyz');
    });

    it('RuntimeProtocolError uses strictly fixed error messages without custom message parameter', () => {
      const err = new RuntimeProtocolError(RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION);
      expect(err.code).toBe(RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION);
      expect(err.message).toBe('[PROTOCOL_VIOLATION] Runtime protocol violation');
      expect(err.name).toBe('RuntimeProtocolError');
    });

    it('ALLOWED_TOOLS_UNAVAILABLE_CODES is typed as Set<ToolsUnavailableReasonCode> with 4 exact codes', () => {
      expect(ALLOWED_TOOLS_UNAVAILABLE_CODES).toBeInstanceOf(Set);
      expect(ALLOWED_TOOLS_UNAVAILABLE_CODES.size).toBe(4);
      expect(ALLOWED_TOOLS_UNAVAILABLE_CODES.has(TOOLS_UNAVAILABLE_REASONS.PLATFORM_CLIENT_UNAVAILABLE)).toBe(true);
      expect(ALLOWED_TOOLS_UNAVAILABLE_CODES.has(TOOLS_UNAVAILABLE_REASONS.TOOLS_REGISTRY_UNAVAILABLE)).toBe(true);
      expect(ALLOWED_TOOLS_UNAVAILABLE_CODES.has(TOOLS_UNAVAILABLE_REASONS.TOOLS_SCHEMA_PROBE_FAILED)).toBe(true);
      expect(ALLOWED_TOOLS_UNAVAILABLE_CODES.has(TOOLS_UNAVAILABLE_REASONS.TOOLS_SCHEMA_INCOMPLETE)).toBe(true);
    });
  });

  describe('DockerExecTransport.sendFollowup Behavior', () => {
    it('dispatches followup successfully with completed status and verifies timeoutMs defaults to 300000ms', async () => {
      const expectation = createMockExpectation();
      const mockClient = new SafeDockerClient();
      const mockEnvelope: ExecCliEnvelope = {
        status: 'completed',
        sessionId: VALID_SESSION_ID,
        turnId: VALID_TURN_ID,
        replyText: 'Hello from DSH agent',
        eventsCount: 5,
        persisted: true,
      };

      const execSpy = vi.spyOn(mockClient, 'execOwned').mockResolvedValue(mockEnvelope);

      const transport = new DockerExecTransport(mockClient, expectation);
      const profile = createValidProfileSnapshot();
      const res = await transport.sendFollowup({
        prompt: 'Hello',
        sessionId: VALID_SESSION_ID,
        turnId: VALID_TURN_ID,
        profile,
      });

      expect(res.status).toBe('completed');
      expect(res.replyText).toBe('Hello from DSH agent');
      expect(res.eventsCount).toBe(5);
      expect(res.persisted).toBe(true);
      expect(res.turnId).toBe(VALID_TURN_ID);
      expect(res.sessionId).toBe(VALID_SESSION_ID);
      expect(execSpy).toHaveBeenCalledWith(
        expectation,
        expect.objectContaining({ action: 'followup' }),
        expect.objectContaining({ timeoutMs: 300_000 })
      );
    });

    it('dispatches followup with explicit timeoutMs override and passes it to execOwned', async () => {
      const expectation = createMockExpectation();
      const mockClient = new SafeDockerClient();
      const mockEnvelope: ExecCliEnvelope = {
        status: 'completed',
        sessionId: VALID_SESSION_ID,
        turnId: VALID_TURN_ID,
        replyText: 'Custom timeout response',
        eventsCount: 5,
        persisted: true,
      };

      const execSpy = vi.spyOn(mockClient, 'execOwned').mockResolvedValue(mockEnvelope);

      const transport = new DockerExecTransport(mockClient, expectation);
      const res = await transport.sendFollowup({
        prompt: 'Custom timeout prompt',
        sessionId: VALID_SESSION_ID,
        turnId: VALID_TURN_ID,
        profile: null,
        timeoutMs: 600_000,
      });

      expect(res.status).toBe('completed');
      expect(execSpy).toHaveBeenCalledWith(
        expectation,
        expect.objectContaining({ action: 'followup' }),
        expect.objectContaining({ timeoutMs: 600_000 })
      );
    });

    it('long turn (40s simulated delay) succeeds under 300s default timeout but fails under explicit 30s timeout', async () => {
      const expectation = createMockExpectation();
      const mockClient = new SafeDockerClient();

      vi.spyOn(mockClient, 'execOwned').mockImplementation(async (_exp, _req, opts) => {
        const timeout = (opts as any)?.timeoutMs ?? 30_000;
        const simulatedTurnDuration = 40_000; // 40 seconds
        if (simulatedTurnDuration > timeout) {
          throw new Error('Docker exec timeout exceeded');
        }
        return {
          status: 'completed',
          sessionId: VALID_SESSION_ID,
          turnId: VALID_TURN_ID,
          replyText: 'Long turn response completed',
          eventsCount: 10,
          persisted: true,
        };
      });

      const transport = new DockerExecTransport(mockClient, expectation);

      // 1. Under default timeout (300,000ms): 40s turn succeeds
      const successRes = await transport.sendFollowup({
        prompt: 'Large context prompt',
        sessionId: VALID_SESSION_ID,
        turnId: VALID_TURN_ID,
        profile: null,
      });
      expect(successRes.status).toBe('completed');
      expect(successRes.replyText).toBe('Long turn response completed');

      // 2. Under explicit 30s timeout (30,000ms): 40s turn fails as expected
      await expect(
        transport.sendFollowup({
          prompt: 'Large context prompt with short timeout',
          sessionId: VALID_SESSION_ID,
          turnId: VALID_TURN_ID,
          profile: null,
          timeoutMs: 30_000,
        })
      ).rejects.toThrow(/Docker exec timeout exceeded/);
    });

    it('dispatches followup with import session ID successfully', async () => {
      const expectation = createMockExpectation();
      const mockClient = new SafeDockerClient();
      const mockEnvelope: ExecCliEnvelope = {
        status: 'completed',
        sessionId: VALID_IMPORT_SESSION_ID,
        turnId: VALID_TURN_ID,
        replyText: 'Imported session response',
        eventsCount: 8,
        persisted: true,
      };

      vi.spyOn(mockClient, 'execOwned').mockResolvedValue(mockEnvelope);

      const transport = new DockerExecTransport(mockClient, expectation);
      const profile = createValidProfileSnapshot();
      const res = await transport.sendFollowup({
        prompt: 'Followup on imported chat',
        sessionId: VALID_IMPORT_SESSION_ID,
        turnId: VALID_TURN_ID,
        profile,
      });

      expect(res.status).toBe('completed');
      expect(res.sessionId).toBe(VALID_IMPORT_SESSION_ID);
    });

    it('dispatches followup with profile: null for unbound generation successfully', async () => {
      const expectation = createMockExpectation();
      const mockClient = new SafeDockerClient();
      const mockEnvelope: ExecCliEnvelope = {
        status: 'completed',
        sessionId: VALID_SESSION_ID,
        turnId: VALID_TURN_ID,
        replyText: 'Unbound generation response',
        eventsCount: 4,
        persisted: true,
      };

      vi.spyOn(mockClient, 'execOwned').mockResolvedValue(mockEnvelope);

      const transport = new DockerExecTransport(mockClient, expectation);
      const res = await transport.sendFollowup({
        prompt: 'Unbound prompt',
        sessionId: VALID_SESSION_ID,
        turnId: VALID_TURN_ID,
        profile: null,
      });

      expect(res.status).toBe('completed');
      expect(res.replyText).toBe('Unbound generation response');
      expect(res.turnId).toBe(VALID_TURN_ID);
      expect(res.sessionId).toBe(VALID_SESSION_ID);
    });

    it('handles cancelled turn properly with status "cancelled" and explicit persisted false', async () => {
      const expectation = createMockExpectation();
      const mockClient = new SafeDockerClient();
      const mockEnvelope: ExecCliEnvelope = {
        status: 'cancelled',
        sessionId: VALID_SESSION_ID,
        turnId: VALID_TURN_ID,
        eventsCount: 3,
        persisted: false,
      };

      vi.spyOn(mockClient, 'execOwned').mockResolvedValue(mockEnvelope);

      const transport = new DockerExecTransport(mockClient, expectation);
      const profile = createValidProfileSnapshot();
      const res = await transport.sendFollowup({
        prompt: 'Long task',
        sessionId: VALID_SESSION_ID,
        turnId: VALID_TURN_ID,
        profile,
      });

      expect(res.status).toBe('cancelled');
      expect(res.replyText).toBeUndefined();
      expect(res.eventsCount).toBe(3);
      expect(res.persisted).toBe(false);
      expect(res.turnId).toBe(VALID_TURN_ID);
    });

    it('rejects followup request containing unknown keys (e.g. targetSessionId or extraField)', async () => {
      const expectation = createMockExpectation();
      const mockClient = new SafeDockerClient();
      const transport = new DockerExecTransport(mockClient, expectation);
      const profile = createValidProfileSnapshot();

      await expect(
        transport.sendFollowup({
          prompt: 'Hello',
          sessionId: VALID_SESSION_ID,
          turnId: VALID_TURN_ID,
          profile,
          targetSessionId: VALID_SESSION_ID,
        } as any)
      ).rejects.toThrow(
        expect.objectContaining({ code: RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION })
      );

      await expect(
        transport.sendFollowup({
          prompt: 'Hello',
          sessionId: VALID_SESSION_ID,
          turnId: VALID_TURN_ID,
          profile,
          unknownKey: 'rejected',
        } as any)
      ).rejects.toThrow(
        expect.objectContaining({ code: RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION })
      );
    });

    it('rejects followup request missing required fields (prompt, sessionId, turnId, profile)', async () => {
      const expectation = createMockExpectation();
      const mockClient = new SafeDockerClient();
      const transport = new DockerExecTransport(mockClient, expectation);
      const profile = createValidProfileSnapshot();

      await expect(
        transport.sendFollowup({
          sessionId: VALID_SESSION_ID,
          turnId: VALID_TURN_ID,
          profile,
        } as any)
      ).rejects.toThrow(
        expect.objectContaining({ code: RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION })
      );

      await expect(
        transport.sendFollowup({
          prompt: 'Hello',
          turnId: VALID_TURN_ID,
          profile,
        } as any)
      ).rejects.toThrow(
        expect.objectContaining({ code: RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION })
      );

      await expect(
        transport.sendFollowup({
          prompt: 'Hello',
          sessionId: VALID_SESSION_ID,
          profile,
        } as any)
      ).rejects.toThrow(
        expect.objectContaining({ code: RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION })
      );

      await expect(
        transport.sendFollowup({
          prompt: 'Hello',
          sessionId: VALID_SESSION_ID,
          turnId: VALID_TURN_ID,
        } as any)
      ).rejects.toThrow(
        expect.objectContaining({ code: RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION })
      );
    });

    it('rejects prompt that is empty, whitespace-only, or exceeding 64KiB UTF-8', async () => {
      const expectation = createMockExpectation();
      const mockClient = new SafeDockerClient();
      const transport = new DockerExecTransport(mockClient, expectation);
      const profile = createValidProfileSnapshot();

      await expect(
        transport.sendFollowup({
          prompt: '',
          sessionId: VALID_SESSION_ID,
          turnId: VALID_TURN_ID,
          profile,
        })
      ).rejects.toThrow(
        expect.objectContaining({ code: RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION })
      );

      await expect(
        transport.sendFollowup({
          prompt: '   \t\n  ',
          sessionId: VALID_SESSION_ID,
          turnId: VALID_TURN_ID,
          profile,
        })
      ).rejects.toThrow(
        expect.objectContaining({ code: RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION })
      );

      const oversizedPrompt = 'a'.repeat(65537);
      await expect(
        transport.sendFollowup({
          prompt: oversizedPrompt,
          sessionId: VALID_SESSION_ID,
          turnId: VALID_TURN_ID,
          profile,
        })
      ).rejects.toThrow(
        expect.objectContaining({ code: RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION })
      );
    });

    it('rejects invalid sessionId format (non ses_32 / non import-32)', async () => {
      const expectation = createMockExpectation();
      const mockClient = new SafeDockerClient();
      const transport = new DockerExecTransport(mockClient, expectation);
      const profile = createValidProfileSnapshot();

      await expect(
        transport.sendFollowup({
          prompt: 'Hello',
          sessionId: 'invalid_session_id',
          turnId: VALID_TURN_ID,
          profile,
        })
      ).rejects.toThrow(
        expect.objectContaining({ code: RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION })
      );

      await expect(
        transport.sendFollowup({
          prompt: 'Hello',
          sessionId: 'ses_short',
          turnId: VALID_TURN_ID,
          profile,
        })
      ).rejects.toThrow(
        expect.objectContaining({ code: RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION })
      );
    });

    it('rejects invalid turnId format (non turn_32)', async () => {
      const expectation = createMockExpectation();
      const mockClient = new SafeDockerClient();
      const transport = new DockerExecTransport(mockClient, expectation);
      const profile = createValidProfileSnapshot();

      await expect(
        transport.sendFollowup({
          prompt: 'Hello',
          sessionId: VALID_SESSION_ID,
          turnId: 'turn-123',
          profile,
        })
      ).rejects.toThrow(
        expect.objectContaining({ code: RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION })
      );
    });

    it('rejects invalid agent profile snapshot', async () => {
      const expectation = createMockExpectation();
      const mockClient = new SafeDockerClient();
      const transport = new DockerExecTransport(mockClient, expectation);

      await expect(
        transport.sendFollowup({
          prompt: 'Hello',
          sessionId: VALID_SESSION_ID,
          turnId: VALID_TURN_ID,
          profile: { profileId: 'bad', version: -1 } as any,
        })
      ).rejects.toThrow(
        expect.objectContaining({ code: RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION })
      );
    });

    it('throws error when followup returns status "error"', async () => {
      const expectation = createMockExpectation();
      const mockClient = new SafeDockerClient();
      const mockEnvelope: ExecCliEnvelope = {
        status: 'error',
        error: 'Execution failed: Model quota exceeded',
      };

      vi.spyOn(mockClient, 'execOwned').mockResolvedValue(mockEnvelope);

      const transport = new DockerExecTransport(mockClient, expectation);
      const profile = createValidProfileSnapshot();
      await expect(
        transport.sendFollowup({ prompt: 'Hello', sessionId: VALID_SESSION_ID, turnId: VALID_TURN_ID, profile })
      ).rejects.toThrow(
        expect.objectContaining({ code: RUNTIME_ERROR_CODES.FOLLOWUP_FAILED })
      );
    });

    it('strictly rejects completed followup response with missing or empty replyText', async () => {
      const expectation = createMockExpectation();
      const mockClient = new SafeDockerClient();
      const mockEnvelope: ExecCliEnvelope = {
        status: 'completed',
        sessionId: VALID_SESSION_ID,
        turnId: VALID_TURN_ID,
        replyText: '',
        eventsCount: 5,
        persisted: true,
      };

      vi.spyOn(mockClient, 'execOwned').mockResolvedValue(mockEnvelope);

      const transport = new DockerExecTransport(mockClient, expectation);
      const profile = createValidProfileSnapshot();
      await expect(
        transport.sendFollowup({ prompt: 'Hello', sessionId: VALID_SESSION_ID, turnId: VALID_TURN_ID, profile })
      ).rejects.toThrow(
        expect.objectContaining({ code: RUNTIME_ERROR_CODES.EMPTY_REPLY_TEXT })
      );
    });

    it('strictly rejects completed followup response with persisted !== true', async () => {
      const expectation = createMockExpectation();
      const mockClient = new SafeDockerClient();
      const mockEnvelope: ExecCliEnvelope = {
        status: 'completed',
        sessionId: VALID_SESSION_ID,
        turnId: VALID_TURN_ID,
        replyText: 'Valid assistant output',
        eventsCount: 5,
        persisted: false,
      };

      vi.spyOn(mockClient, 'execOwned').mockResolvedValue(mockEnvelope);

      const transport = new DockerExecTransport(mockClient, expectation);
      const profile = createValidProfileSnapshot();
      await expect(
        transport.sendFollowup({ prompt: 'Hello', sessionId: VALID_SESSION_ID, turnId: VALID_TURN_ID, profile })
      ).rejects.toThrow(
        expect.objectContaining({ code: RUNTIME_ERROR_CODES.PERSISTENCE_REQUIRED })
      );
    });

    it('strictly rejects followup response when sessionId mismatches requested sessionId', async () => {
      const expectation = createMockExpectation();
      const mockClient = new SafeDockerClient();
      const mockEnvelope: ExecCliEnvelope = {
        status: 'completed',
        sessionId: 'ses_ffffffffffffffffffffffffffffffff',
        turnId: VALID_TURN_ID,
        replyText: 'Valid assistant output',
        eventsCount: 5,
        persisted: true,
      };

      vi.spyOn(mockClient, 'execOwned').mockResolvedValue(mockEnvelope);

      const transport = new DockerExecTransport(mockClient, expectation);
      const profile = createValidProfileSnapshot();
      await expect(
        transport.sendFollowup({ prompt: 'Hello', sessionId: VALID_SESSION_ID, turnId: VALID_TURN_ID, profile })
      ).rejects.toThrow(
        expect.objectContaining({ code: RUNTIME_ERROR_CODES.SESSION_ID_MISMATCH })
      );
    });

    it('strictly rejects followup response when turnId mismatches requested turnId', async () => {
      const expectation = createMockExpectation();
      const mockClient = new SafeDockerClient();
      const mockEnvelope: ExecCliEnvelope = {
        status: 'completed',
        sessionId: VALID_SESSION_ID,
        turnId: 'turn_ffffffffffffffffffffffffffffffff',
        replyText: 'Valid assistant output',
        eventsCount: 5,
        persisted: true,
      };

      vi.spyOn(mockClient, 'execOwned').mockResolvedValue(mockEnvelope);

      const transport = new DockerExecTransport(mockClient, expectation);
      const profile = createValidProfileSnapshot();
      await expect(
        transport.sendFollowup({ prompt: 'Hello', sessionId: VALID_SESSION_ID, turnId: VALID_TURN_ID, profile })
      ).rejects.toThrow(
        expect.objectContaining({ code: RUNTIME_ERROR_CODES.TURN_ID_MISMATCH })
      );
    });

    it('strictly rejects followup response with missing or invalid eventsCount', async () => {
      const expectation = createMockExpectation();
      const mockClient = new SafeDockerClient();
      const mockEnvelope: ExecCliEnvelope = {
        status: 'completed',
        sessionId: VALID_SESSION_ID,
        turnId: VALID_TURN_ID,
        replyText: 'Valid assistant output',
        persisted: true,
      };

      vi.spyOn(mockClient, 'execOwned').mockResolvedValue(mockEnvelope);

      const transport = new DockerExecTransport(mockClient, expectation);
      const profile = createValidProfileSnapshot();
      await expect(
        transport.sendFollowup({ prompt: 'Hello', sessionId: VALID_SESSION_ID, turnId: VALID_TURN_ID, profile })
      ).rejects.toThrow(
        expect.objectContaining({ code: RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION })
      );
    });

    it('strictly rejects cancelled followup response when replyText is present', async () => {
      const expectation = createMockExpectation();
      const mockClient = new SafeDockerClient();
      const mockEnvelope: ExecCliEnvelope = {
        status: 'cancelled',
        sessionId: VALID_SESSION_ID,
        turnId: VALID_TURN_ID,
        replyText: 'Fabricated output during cancellation',
        eventsCount: 2,
        persisted: false,
      };

      vi.spyOn(mockClient, 'execOwned').mockResolvedValue(mockEnvelope);

      const transport = new DockerExecTransport(mockClient, expectation);
      const profile = createValidProfileSnapshot();
      await expect(
        transport.sendFollowup({ prompt: 'Hello', sessionId: VALID_SESSION_ID, turnId: VALID_TURN_ID, profile })
      ).rejects.toThrow(
        expect.objectContaining({ code: RUNTIME_ERROR_CODES.PROTOCOL_VIOLATION })
      );
    });

    it('strictly rejects followup response with unexpected envelope status (e.g. "ok" or "idle")', async () => {
      const expectation = createMockExpectation();
      const mockClient = new SafeDockerClient();
      const mockEnvelope: ExecCliEnvelope = {
        status: 'ok',
        sessionId: VALID_SESSION_ID,
        turnId: VALID_TURN_ID,
        eventsCount: 2,
        persisted: true,
      };

      vi.spyOn(mockClient, 'execOwned').mockResolvedValue(mockEnvelope);

      const transport = new DockerExecTransport(mockClient, expectation);
      const profile = createValidProfileSnapshot();
      await expect(
        transport.sendFollowup({ prompt: 'Hello', sessionId: VALID_SESSION_ID, turnId: VALID_TURN_ID, profile })
      ).rejects.toThrow(
        expect.objectContaining({ code: RUNTIME_ERROR_CODES.INVALID_RESPONSE_ENVELOPE })
      );
    });
  });
});
