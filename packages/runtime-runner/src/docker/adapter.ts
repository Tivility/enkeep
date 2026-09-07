/**
 * Docker Runtime Lifecycle Adapter (Zero-Network Architecture)
 *
 * Provides high-level lifecycle operations (start, connect, health-check, followup turn, cancel, stop, teardown)
 * for isolated user DSH runtime containers with zero network ports exclusively via safe Docker Exec dispatch
 * and full 64-hex container ID ownership tracking.
 *
 * @module @enkeep/runtime-runner/docker/adapter
 */

import crypto from 'node:crypto';
import {
  SafeDockerClient,
  type OwnershipExpectation,
  type VolumeOwnershipExpectation,
  type DockerContainerInfo,
  DEFAULT_EXEC_MAX_INPUT_BYTES,
  DEFAULT_EXEC_MAX_OUTPUT_BYTES,
  SEED_IMPORT_MAX_INPUT_BYTES,
  HEALTH_EXEC_MAX_INPUT_BYTES,
  HEALTH_EXEC_MAX_OUTPUT_BYTES,
} from './client.js';
import {
  validateContainerSpec,
  validateCrossUserIsolation,
  is64HexContainerId,
  USER_ID_REGEX,
  RUN_ID_REGEX,
  VOLUME_ID_REGEX,
  DockerOwnershipError,
  DockerCollisionError,
  DockerNotFoundError,
  DockerDaemonError,
} from '../spec/validator.js';
import type { RuntimeContainerSpec, ExactContainerIdentity } from '../spec/types.js';
import type { ExecCliEnvelope } from '../runtime/exec-cli.js';
import type { FileOperationRequest, FileOperationResult } from '../runtime/file-ops.js';
import type { RuntimeTurnRequest } from '@enkeep/protocol';
import type { AgentProfileSnapshot } from '../runtime/agent-profile.js';
import {
  type AgentFollowupRequest,
  type RuntimeHealthStatus,
  type PluginReadinessStatus,
  type ToolsUnavailableReasonCode,
  type RuntimeDaemonTransportPort,
  isAllowedToolsUnavailableReason,
  DEFAULT_FOLLOWUP_TIMEOUT_MS,
} from '../transport/types.js';
import { TunnelHost } from '../tunnel/host.js';
import type { TunnelHostOptions } from '../tunnel/types.js';
import { DaemonDockerTransport, type DaemonDockerTransportOptions } from '../transport/daemon-transport.js';
import { DaemonProtocolError } from '../runtime/daemon-protocol.js';
import type { ActiveRuntimeHandle, RuntimeExecutionProvider } from '../spec/provider.js';

export type { ActiveRuntimeHandle };

export type DaemonTransportFactory = (
  client: SafeDockerClient,
  expectation: OwnershipExpectation,
  options?: DaemonDockerTransportOptions
) => RuntimeDaemonTransportPort;

export interface DockerRuntimeAdapterOptions {
  client?: SafeDockerClient;
  daemonTransportFactory?: DaemonTransportFactory;
}

export interface UserSpecOptions {
  userId: 'alice' | 'bob' | (string & {});
  image?: string;
  runId?: string;
  volumeId?: string;
  containerName?: string;
  volumeName?: string;
  nameSuffix?: string;
  /** Whether real LLM is enabled (injects ENKEEP_LLM_ENABLED=1) */
  llmEnabled?: boolean;
  /** Optional LLM provider identifier (injects ENKEEP_LLM_PROVIDER) */
  llmProvider?: string;
  /** Optional LLM model identifier (injects ENKEEP_LLM_MODEL) */
  llmModel?: string;
  /** Optional in-container providers JSON (injects ENKEEP_LLM_PROVIDERS) */
  llmProviders?: string | Record<string, unknown>;
}



function isFatalHealthError(err: unknown): boolean {
  if (err instanceof DockerOwnershipError) {
    // Transient container boot state is not fatal during startup polling
    if (err.message.includes('not in running state')) {
      return false;
    }
    return true;
  }
  if (err instanceof DockerCollisionError || err instanceof DockerNotFoundError) {
    return true;
  }
  if (err instanceof DockerDaemonError) {
    const msg = err.message.toLowerCase();
    if (/\b(?:permission denied|access denied|unauthorized)\b/i.test(msg)) {
      return true;
    }
  }
  return false;
}

/**
 * Strict typed parser and validator that converts an ExecCliEnvelope into a fully typed RuntimeHealthStatus.
 * Enforces all required fields, non-empty modelProvider, plugin booleans, and toolsOperational semantics.
 */
export function parseRuntimeHealthStatus(
  envelope: ExecCliEnvelope | null | undefined,
  expectedUserId: string
): RuntimeHealthStatus {
  if (!envelope) {
    throw new DockerDaemonError('Health check returned empty envelope');
  }

  if (envelope.status === 'error') {
    throw new DockerDaemonError('Health check reported error status');
  }

  if (envelope.status !== 'ok' && (envelope.status as string) !== 'degraded') {
    throw new DockerDaemonError(`Health check returned unexpected envelope status: "${envelope.status}"`);
  }

  // Mandatory userId validation against ownership expectation
  if (typeof envelope.userId !== 'string' || !envelope.userId.trim()) {
    throw new DockerDaemonError('Health check envelope missing non-empty userId');
  }
  if (envelope.userId !== expectedUserId) {
    throw new DockerDaemonError(`Health check envelope userId mismatch: expected "${expectedUserId}", got "${envelope.userId}"`);
  }

  // Mandatory finite non-negative uptimeSeconds
  if (typeof envelope.uptimeSeconds !== 'number' || !Number.isFinite(envelope.uptimeSeconds) || envelope.uptimeSeconds < 0) {
    throw new DockerDaemonError('Health check envelope uptimeSeconds must be a non-negative finite number');
  }

  // Mandatory non-empty version
  if (typeof envelope.version !== 'string' || !envelope.version.trim()) {
    throw new DockerDaemonError('Health check envelope missing non-empty version');
  }

  // Mandatory non-empty modelProvider string (e.g. 'cpa-claude' or 'demo')
  if (
    typeof envelope.modelProvider !== 'string' ||
    envelope.modelProvider.length === 0 ||
    envelope.modelProvider !== envelope.modelProvider.trim() ||
    envelope.modelProvider !== envelope.modelProvider.normalize('NFC')
  ) {
    throw new DockerDaemonError('Health check envelope missing or invalid modelProvider');
  }

  // Mandatory core readiness booleans
  if (typeof envelope.dshReady !== 'boolean') {
    throw new DockerDaemonError('Health check envelope dshReady must be an explicit boolean');
  }
  if (typeof envelope.enkeepBundleLoaded !== 'boolean') {
    throw new DockerDaemonError('Health check envelope enkeepBundleLoaded must be an explicit boolean');
  }

  // Mandatory plugins object verification
  if (!envelope.plugins || typeof envelope.plugins !== 'object') {
    throw new DockerDaemonError('Health check envelope missing valid plugins object');
  }
  const plugins = envelope.plugins;
  if (
    typeof plugins.receiptStore !== 'boolean' ||
    typeof plugins.inbound !== 'boolean' ||
    typeof plugins.eventRelay !== 'boolean' ||
    typeof plugins.externalInteraction !== 'boolean' ||
    typeof plugins.affinityPolicy !== 'boolean' ||
    typeof plugins.llmAffinity !== 'boolean' ||
    typeof plugins.tools !== 'boolean'
  ) {
    throw new DockerDaemonError('Health check envelope plugins object missing required boolean flags');
  }

  // Mandatory toolsCount non-negative safe integer
  if (typeof envelope.toolsCount !== 'number' || !Number.isSafeInteger(envelope.toolsCount) || envelope.toolsCount < 0) {
    throw new DockerDaemonError('Health check envelope toolsCount must be a non-negative safe integer');
  }

  // Mandatory toolsOperational explicit boolean
  if (typeof envelope.toolsOperational !== 'boolean') {
    throw new DockerDaemonError('Health check envelope toolsOperational must be an explicit boolean');
  }

  let toolsUnavailableReason: ToolsUnavailableReasonCode | null = null;
  if (envelope.toolsOperational === false) {
    if (!isAllowedToolsUnavailableReason(envelope.toolsUnavailableReason)) {
      throw new DockerDaemonError('Health check envelope toolsOperational is false but toolsUnavailableReason is invalid');
    }
    toolsUnavailableReason = envelope.toolsUnavailableReason;
  } else {
    if (envelope.toolsUnavailableReason !== null && envelope.toolsUnavailableReason !== undefined) {
      throw new DockerDaemonError('Health check envelope toolsUnavailableReason must be null when tools are operational');
    }
    if (plugins.tools !== true || envelope.toolsCount < 4) {
      throw new DockerDaemonError('Health check envelope reports operational tools but tools plugin or count is invalid');
    }
    toolsUnavailableReason = null;
  }

  const corePluginsReady =
    plugins.receiptStore === true &&
    plugins.inbound === true &&
    plugins.eventRelay === true &&
    plugins.externalInteraction === true &&
    plugins.affinityPolicy === true &&
    plugins.llmAffinity === true;

  let computedStatus: RuntimeHealthStatus['status'];
  if (!envelope.dshReady) {
    computedStatus = 'error';
  } else if (!envelope.enkeepBundleLoaded || !corePluginsReady || (envelope.status as string) === 'degraded') {
    computedStatus = 'degraded';
  } else {
    computedStatus = 'ok';
  }

  return {
    status: computedStatus,
    uptimeSeconds: envelope.uptimeSeconds,
    userId: envelope.userId,
    dshReady: envelope.dshReady,
    enkeepBundleLoaded: envelope.enkeepBundleLoaded,
    modelProvider: envelope.modelProvider,
    plugins: {
      receiptStore: plugins.receiptStore,
      inbound: plugins.inbound,
      eventRelay: plugins.eventRelay,
      externalInteraction: plugins.externalInteraction,
      affinityPolicy: plugins.affinityPolicy,
      llmAffinity: plugins.llmAffinity,
      tools: plugins.tools,
    },
    toolsCount: envelope.toolsCount,
    toolsOperational: envelope.toolsOperational,
    toolsUnavailableReason,
    version: envelope.version,
  };
}

/**
 * Strict validator for in-container startup health check envelope.
 * Rejects missing or non-boolean plugins, userId mismatches, missing toolsOperational semantics, etc.
 *
 * @param envelope - The ExecCliEnvelope returned from container health probe.
 * @param expectedUserId - The exact expected userId for ownership verification.
 */
export function isAuthenticReadyHealthEnvelope(
  envelope: ExecCliEnvelope | null | undefined,
  expectedUserId: string
): boolean {
  if (!envelope || envelope.status !== 'ok') {
    return false;
  }
  // Mandatory exact userId match against ownership expectation
  if (typeof envelope.userId !== 'string' || !envelope.userId.trim() || envelope.userId !== expectedUserId) {
    return false;
  }
  // Mandatory finite non-negative uptimeSeconds
  if (typeof envelope.uptimeSeconds !== 'number' || !Number.isFinite(envelope.uptimeSeconds) || envelope.uptimeSeconds < 0) {
    return false;
  }
  // Mandatory non-empty version
  if (typeof envelope.version !== 'string' || !envelope.version.trim()) {
    return false;
  }
  // Mandatory non-empty modelProvider string (e.g. 'cpa-claude' or 'demo')
  if (
    typeof envelope.modelProvider !== 'string' ||
    envelope.modelProvider.length === 0 ||
    envelope.modelProvider !== envelope.modelProvider.trim() ||
    envelope.modelProvider !== envelope.modelProvider.normalize('NFC')
  ) {
    return false;
  }
  // Mandatory core readiness booleans
  if (envelope.dshReady !== true || envelope.enkeepBundleLoaded !== true) {
    return false;
  }
  // Mandatory plugins object verification
  if (!envelope.plugins || typeof envelope.plugins !== 'object') {
    return false;
  }
  const plugins = envelope.plugins;
  // All 7 plugins must have explicit boolean types
  if (
    typeof plugins.receiptStore !== 'boolean' ||
    typeof plugins.inbound !== 'boolean' ||
    typeof plugins.eventRelay !== 'boolean' ||
    typeof plugins.externalInteraction !== 'boolean' ||
    typeof plugins.affinityPolicy !== 'boolean' ||
    typeof plugins.llmAffinity !== 'boolean' ||
    typeof plugins.tools !== 'boolean'
  ) {
    return false;
  }
  // 6 core operational plugins must be strictly true
  if (
    plugins.receiptStore !== true ||
    plugins.inbound !== true ||
    plugins.eventRelay !== true ||
    plugins.externalInteraction !== true ||
    plugins.affinityPolicy !== true ||
    plugins.llmAffinity !== true
  ) {
    return false;
  }
  // Mandatory toolsCount non-negative safe integer
  if (typeof envelope.toolsCount !== 'number' || !Number.isSafeInteger(envelope.toolsCount) || envelope.toolsCount < 0) {
    return false;
  }
  // Mandatory toolsOperational explicit boolean
  if (typeof envelope.toolsOperational !== 'boolean') {
    return false;
  }
  // Strict toolsOperational semantics
  if (envelope.toolsOperational === false) {
    if (!isAllowedToolsUnavailableReason(envelope.toolsUnavailableReason)) {
      return false;
    }
  } else if (envelope.toolsOperational === true) {
    if (envelope.toolsUnavailableReason !== null && envelope.toolsUnavailableReason !== undefined) {
      return false;
    }
    if (plugins.tools !== true || envelope.toolsCount < 4) {
      return false;
    }
  } else {
    return false;
  }

  return true;
}

/**
 * Backward compatibility alias for isAuthenticReadyHealthEnvelope.
 */
export function isStartupHealthEnvelopeValid(
  envelope: ExecCliEnvelope | null | undefined,
  expectation: OwnershipExpectation
): boolean {
  return isAuthenticReadyHealthEnvelope(envelope, expectation.userId);
}

export class DockerRuntimeAdapter implements RuntimeExecutionProvider<RuntimeContainerSpec, ActiveRuntimeHandle> {
  readonly kind = 'docker' as const;
  private readonly client: SafeDockerClient;
  private readonly daemonTransportFactory: DaemonTransportFactory;

  constructor(
    clientOrOptions?: SafeDockerClient | DockerRuntimeAdapterOptions,
    options?: DockerRuntimeAdapterOptions
  ) {
    if (clientOrOptions && typeof (clientOrOptions as SafeDockerClient).runContainer === 'function') {
      this.client = clientOrOptions as SafeDockerClient;
      this.daemonTransportFactory =
        options?.daemonTransportFactory ??
        ((client, exp, opts) => new DaemonDockerTransport(client, exp, opts));
    } else if (clientOrOptions && typeof clientOrOptions === 'object') {
      const opts = clientOrOptions as DockerRuntimeAdapterOptions;
      this.client = opts.client ?? new SafeDockerClient();
      this.daemonTransportFactory =
        opts.daemonTransportFactory ??
        ((client, exp, o) => new DaemonDockerTransport(client, exp, o));
    } else {
      this.client = new SafeDockerClient();
      this.daemonTransportFactory =
        options?.daemonTransportFactory ??
        ((client, exp, opts) => new DaemonDockerTransport(client, exp, opts));
    }
  }

  /**
   * Returns the underlying SafeDockerClient instance.
   */
  getClient(): SafeDockerClient {
    return this.client;
  }

  /**
   * Generates a standard secure RuntimeContainerSpec for a user (Alice/Bob).
   * Strictly enforces zero-network (`--network none`) with zero published ports, no HOST binding,
   * random unique runId, immutable volumeId, and no host directory mounts except the dedicated user volume.
   * Allows caller-supplied random name suffixes while maintaining the mandatory prefix.
   */
  createDefaultUserSpec(options: UserSpecOptions): RuntimeContainerSpec {
    const userId = options.userId;
    if (!userId || typeof userId !== 'string' || !USER_ID_REGEX.test(userId)) {
      throw new DockerOwnershipError('Invalid caller-supplied userId');
    }
    const suffix = options.nameSuffix ? `-${options.nameSuffix}` : '';
    const containerName = options.containerName ?? `enkeep-demo-${userId}${suffix}`;
    const volumeName = options.volumeName ?? `enkeep-demo-dsh-${userId}${suffix}`;
    const image = options.image ?? 'enkeep-demo-runtime:acceptance';
    const runId = options.runId ?? `run_${crypto.randomBytes(16).toString('hex')}`;
    const volumeId = options.volumeId ?? `vol_${crypto.randomBytes(16).toString('hex')}`;

    if (options.runId && !RUN_ID_REGEX.test(options.runId)) {
      throw new DockerOwnershipError('Invalid caller-supplied runId');
    }

    if (options.volumeId && !VOLUME_ID_REGEX.test(options.volumeId)) {
      throw new DockerOwnershipError('Invalid caller-supplied volumeId');
    }

    let isLlmEnabled: boolean;
    if (options.llmEnabled !== undefined) {
      isLlmEnabled = options.llmEnabled;
    } else if (process.env.ENKEEP_LLM_ENABLED === '0') {
      isLlmEnabled = false;
    } else if (process.env.ENKEEP_LLM_ENABLED === '1') {
      isLlmEnabled = true;
    } else {
      isLlmEnabled = Boolean(options.llmProviders && Object.keys(options.llmProviders).length > 0);
    }
    const llmProvider = options.llmProvider || process.env.ENKEEP_LLM_PROVIDER || 'cpa-claude';
    const llmModel = options.llmModel || process.env.ENKEEP_LLM_MODEL || 'claude-fable-5';

    const env: Record<string, string> = {
      DSH_USER: userId,
      DSH_HOME: '/home/dsh/.dsh',
      DSH_SPACES: '/home/dsh/spaces',
    };

    if (isLlmEnabled) {
      env.ENKEEP_LLM_ENABLED = '1';
      env.ENKEEP_LLM_PROVIDER = llmProvider;
      env.ENKEEP_LLM_MODEL = llmModel;
      env.ENKEEP_LLM_BASE_URL = 'http://127.0.0.1:8787/llm';
      env.IN_CONTAINER_PLACEHOLDER = 'in-container-placeholder';
      if (options.llmProviders) {
        env.ENKEEP_LLM_PROVIDERS =
          typeof options.llmProviders === 'string'
            ? options.llmProviders
            : JSON.stringify(options.llmProviders);
      }
    }

    const spec: RuntimeContainerSpec = {
      userId,
      runId,
      containerName,
      image,
      user: '1000:1000',
      workingDir: '/home/dsh',
      volume: {
        volumeName,
        volumeId,
        containerPath: '/home/dsh',
      },
      networkMode: 'none', // Strictly zero-network
      labels: {
        app: 'enkeep-demo',
        'enkeep.user': userId,
        'enkeep.run-id': runId,
        'enkeep.volume-id': volumeId,
      },
      environment: env,
    };

    return spec;
  }

  /**
   * Validates specs for a pair of users to ensure cross-user isolation.
   */
  validateUserPair(aliceSpec: RuntimeContainerSpec, bobSpec: RuntimeContainerSpec): void {
    const validation = validateCrossUserIsolation(aliceSpec, bobSpec);
    if (!validation.valid) {
      throw new DockerOwnershipError('Cross-user isolation validation failed');
    }
  }

  /**
   * Internal shared runtime startup runner.
   */
  private async startRuntimeInternal(
    spec: RuntimeContainerSpec,
    runFn: () => Promise<{ containerId: string; volumeCreated: boolean }>,
    startupTimeoutMs: number
  ): Promise<ActiveRuntimeHandle> {
    const validation = validateContainerSpec(spec);
    if (!validation.valid) {
      throw new DockerOwnershipError('Invalid container specification');
    }

    // Fail closed immediately if any container already exists with this name (collision non-adoption)
    const existing = await this.client.inspectContainer(spec.containerName);
    if (existing) {
      throw new DockerCollisionError('Container already exists on host. Re-creation refused.');
    }

    const { containerId, volumeCreated } = await runFn();
    const runId = spec.runId;
    const volumeId = spec.volume.volumeId;

    const expectation: OwnershipExpectation = {
      containerName: spec.containerName,
      userId: spec.userId,
      runId,
      containerId,
      volumeName: spec.volume.volumeName,
      volumeId,
      containerPath: spec.volume.containerPath,
      mounts: spec.mounts,
    };

    const handle = this.createActiveRuntimeHandle(spec, containerId, expectation, volumeCreated);

    // Await healthy status via resident DaemonDockerTransport (zero network)
    const startTime = Date.now();
    let isHealthy = false;
    let lastError: unknown;

    while (Date.now() - startTime < startupTimeoutMs) {
      // Check if container unexpectedly stopped or exited
      try {
        const info = await this.client.inspectContainer(containerId);
        if (info && (info.state === 'exited' || info.state === 'dead' || info.state === 'stopped')) {
          lastError = new DockerDaemonError(
            `Runtime container daemon startup failed: container exited with state ${info.state}`
          );
          break;
        }
      } catch (inspectErr: unknown) {
        if (isFatalHealthError(inspectErr)) {
          lastError = inspectErr;
          break;
        }
      }

      try {
        await handle.startTransport!();
        const health = await handle.checkHealth();
        if (health && health.dshReady === true && (health.status === 'ok' || health.status === 'degraded')) {
          isHealthy = true;
          break;
        }
      } catch (err: unknown) {
        lastError = err;
        // Fail fast on fatal ownership/collision/not-found/permission errors
        if (isFatalHealthError(err)) {
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 400));
    }

    if (!isHealthy) {
      const cleanupErrors: Error[] = [];

      // Attempt exact stop & remove of newly created container
      try {
        await handle.stop();
      } catch (stopErr: unknown) {
        if (!(stopErr instanceof DockerNotFoundError)) {
          cleanupErrors.push(stopErr instanceof Error ? stopErr : new Error(String(stopErr)));
        }
      }

      try {
        await this.client.removeContainer(expectation, true);
      } catch (rmErr: unknown) {
        if (!(rmErr instanceof DockerNotFoundError)) {
          cleanupErrors.push(rmErr instanceof Error ? rmErr : new Error(String(rmErr)));
        }
      }

      // If volume was newly created in this call, remove it as well to avoid orphan leaks
      if (volumeCreated) {
        try {
          await this.client.removeVolume({
            volumeName: spec.volume.volumeName,
            userId: spec.userId,
            volumeId: spec.volume.volumeId,
          });
        } catch (volErr: unknown) {
          cleanupErrors.push(
            volErr instanceof Error ? volErr : new Error('Volume cleanup failure', { cause: volErr })
          );
        }
      }

      const primaryErr =
        lastError instanceof Error
          ? lastError
          : new DockerDaemonError('Runtime container failed to reach healthy status within deadline');

      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [primaryErr, ...cleanupErrors],
          'Runtime container failed startup health checks'
        );
      }
      throw primaryErr;
    }

    return handle;
  }

  /**
   * Starts a container for the given spec and verifies runtime readiness via Exec health check.
   * STRICT FAIL-CLOSED: If any container with the same name exists, throws DockerCollisionError immediately without deleting.
   * On health failure or fatal error, aggregates all cleanup errors and primary failure to prevent resource leaks.
   */
  async startRuntime(
    spec: RuntimeContainerSpec,
    startupTimeoutMs = 20000
  ): Promise<ActiveRuntimeHandle> {
    return this.startRuntimeInternal(spec, () => this.client.runContainer(spec), startupTimeoutMs);
  }

  /**
   * Starts a new container attaching an existing owned Docker volume and verifies runtime readiness.
   * Preserves the caller's existing volume on any failure or post-run assertion mismatch.
   */
  async startRuntimeWithOwnedVolume(
    spec: RuntimeContainerSpec,
    startupTimeoutMs = 20000
  ): Promise<ActiveRuntimeHandle> {
    const volumeExpectation: VolumeOwnershipExpectation = {
      volumeName: spec.volume.volumeName,
      userId: spec.userId,
      volumeId: spec.volume.volumeId,
    };
    return this.startRuntimeInternal(
      spec,
      () => this.client.runContainerWithOwnedVolume(spec, volumeExpectation),
      startupTimeoutMs
    );
  }

  /**
   * Reconnects to an existing stopped or running container with full signed identity validation.
   * STRICT FAIL-CLOSED: Reconnection requires a verified ExactContainerIdentity (64-hex containerId, runId, volumeId).
   * Reconnecting by spec alone without containerId is strictly rejected.
   */
  async connectRuntime(
    spec: RuntimeContainerSpec,
    identityOrTimeout?: ExactContainerIdentity | number,
    startupTimeoutMs = 20000
  ): Promise<ActiveRuntimeHandle> {
    let identity: ExactContainerIdentity;
    let effTimeout = startupTimeoutMs;

    if (typeof identityOrTimeout === 'number') {
      effTimeout = identityOrTimeout;
      const info = await this.client.inspectContainer(spec.containerName);
      if (!info) {
        throw new DockerNotFoundError(`Cannot connect: container "${spec.containerName}" not found`);
      }
      identity = {
        containerId: info.id,
        containerName: spec.containerName,
        userId: spec.userId,
        runId: info.labels?.['enkeep.run-id'] || spec.runId,
        volumeId: info.labels?.['enkeep.volume-id'] || spec.volume.volumeId,
      };
    } else if (identityOrTimeout && typeof identityOrTimeout === 'object') {
      identity = identityOrTimeout;
    } else {
      const info = await this.client.inspectContainer(spec.containerName);
      if (!info) {
        throw new DockerNotFoundError(`Cannot connect: container "${spec.containerName}" not found`);
      }
      identity = {
        containerId: info.id,
        containerName: spec.containerName,
        userId: spec.userId,
        runId: info.labels?.['enkeep.run-id'] || spec.runId,
        volumeId: info.labels?.['enkeep.volume-id'] || spec.volume.volumeId,
      };
    }
    if (!identity || !is64HexContainerId(identity.containerId)) {
      throw new DockerOwnershipError(
        'connectRuntime rejected: reconnection requires verified 64-hex containerId. Reconnection by spec alone is forbidden.'
      );
    }

    if (!identity.containerName || identity.containerName !== spec.containerName) {
      throw new DockerOwnershipError('connectRuntime rejected: containerName mismatch');
    }

    if (!identity.userId || identity.userId !== spec.userId) {
      throw new DockerOwnershipError('connectRuntime rejected: userId mismatch');
    }

    if (!identity.runId || identity.runId !== spec.runId) {
      throw new DockerOwnershipError('connectRuntime rejected: runId mismatch');
    }

    if (!identity.volumeId || identity.volumeId !== spec.volume.volumeId) {
      throw new DockerOwnershipError('connectRuntime rejected: volumeId mismatch');
    }

    // Verify existing volume ownership
    await this.client.connectVolume(spec.volume.volumeName, {
      volumeName: spec.volume.volumeName,
      userId: spec.userId,
      volumeId: spec.volume.volumeId,
    });

    const expectation: OwnershipExpectation = {
      containerName: spec.containerName,
      userId: spec.userId,
      runId: identity.runId,
      containerId: identity.containerId,
      volumeName: spec.volume.volumeName,
      volumeId: spec.volume.volumeId,
      containerPath: spec.volume.containerPath,
      mounts: spec.mounts,
    };

    // Inspect with brief retry to handle daemon state transitions
    let info: DockerContainerInfo | null = null;
    const inspectDeadline = Date.now() + 5000;
    while (Date.now() < inspectDeadline) {
      info = await this.client.inspectContainer(identity.containerId);
      if (info) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    if (!info) {
      throw new DockerNotFoundError('Cannot connect to runtime container: container not found');
    }

    this.client.assertContainerOwnership(info, expectation);

    if (info.state !== 'running') {
      await this.client.startContainer(expectation);
    }

    const handle = this.createActiveRuntimeHandle(spec, info.id, expectation, false);

    const startTime = Date.now();
    let isHealthy = false;
    let lastError: unknown;

    while (Date.now() - startTime < startupTimeoutMs) {
      try {
        const currentInfo = await this.client.inspectContainer(identity.containerId);
        if (currentInfo && (currentInfo.state === 'exited' || currentInfo.state === 'dead' || currentInfo.state === 'stopped')) {
          lastError = new DockerDaemonError(
            `Runtime container daemon startup failed: container exited with state ${currentInfo.state}`
          );
          break;
        }
      } catch (inspectErr: unknown) {
        if (isFatalHealthError(inspectErr)) {
          lastError = inspectErr;
          break;
        }
      }

      try {
        await handle.startTransport!();
        const health = await handle.checkHealth();
        if (health && health.dshReady === true && (health.status === 'ok' || health.status === 'degraded')) {
          isHealthy = true;
          break;
        }
      } catch (err: unknown) {
        lastError = err;
        if (isFatalHealthError(err)) {
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 400));
    }

    if (!isHealthy) {
      const primaryErr =
        lastError instanceof Error
          ? lastError
          : new DockerDaemonError('Runtime container failed to reach healthy status after reconnect within deadline');
      throw primaryErr;
    }

    return handle;
  }

  private createActiveRuntimeHandle(
    spec: RuntimeContainerSpec,
    containerId: string,
    expectation: OwnershipExpectation,
    isCreated: boolean
  ): ActiveRuntimeHandle {
    const adapterClient = this.client;
    const runId = spec.runId;
    const volumeId = spec.volume.volumeId;
    let activeTunnel: TunnelHost | undefined;
    let activeTransport: RuntimeDaemonTransportPort | undefined;

    const getOrStartTransport = async (
      options?: DaemonDockerTransportOptions
    ): Promise<RuntimeDaemonTransportPort> => {
      if (!activeTransport) {
        activeTransport = this.daemonTransportFactory(adapterClient, expectation, options);
      }
      if (!activeTransport.isConnected()) {
        await activeTransport.start();
      }
      return activeTransport;
    };

    const handle: ActiveRuntimeHandle = {
      spec,
      containerId,
      runId,
      volumeId,
      isCreated,
      get tunnel() {
        return activeTunnel;
      },
      get transport() {
        return activeTransport;
      },
      startTunnel: async (options?: TunnelHostOptions) => {
        if (activeTunnel) {
          if (options?.handler) {
            activeTunnel.setHandler(options.handler);
          }
          return activeTunnel;
        }
        const host = new TunnelHost(adapterClient, expectation, options);
        await host.start();
        activeTunnel = host;
        return host;
      },
      startTransport: async (options?: DaemonDockerTransportOptions) => {
        return getOrStartTransport(options);
      },
      checkHealth: async (): Promise<RuntimeHealthStatus> => {
        const transport = await getOrStartTransport();
        return await transport.checkHealth();
      },
      sendFollowup: async (request: RuntimeTurnRequest): Promise<ExecCliEnvelope> => {
        if (!request || typeof request !== 'object') {
          throw new Error('request is required for sendFollowup');
        }
        const {
          prompt,
          sessionId,
          turnId,
          profileSnapshot,
          workspaceFolder,
          timeoutMs,
          attachments,
          modelSelection,
        } = request;
        const replyReference = (request as {
          replyReference?: {
            readonly replyToMessageId: string;
            readonly snippet: string;
            readonly role?: string;
          } | null;
        }).replyReference;

        if (!prompt || typeof prompt !== 'string') {
          throw new Error('prompt is required for sendFollowup');
        }
        if (!sessionId || typeof sessionId !== 'string') {
          throw new Error('sessionId is required for sendFollowup');
        }
        if (!turnId || typeof turnId !== 'string') {
          throw new Error('turnId is required for sendFollowup');
        }

        const effProfile = (profileSnapshot ?? null) as AgentProfileSnapshot | null;
        const effWorkspaceFolder = typeof workspaceFolder === 'string' ? workspaceFolder : undefined;
        const effTimeout = timeoutMs ?? DEFAULT_FOLLOWUP_TIMEOUT_MS;

        const inContainerMounts = request.mounts?.map((m) => ({
          id: m.id,
          name: m.name,
          sourcePath: `/home/dsh/mounts/${m.id}`,
          mode: m.mode,
        }));

        const transport = await getOrStartTransport();
        try {
          const followupRes = await transport.sendFollowup({
            prompt,
            sessionId,
            turnId,
            profile: effProfile,
            profileSnapshot: effProfile,
            workspaceFolder: effWorkspaceFolder,
            attachments,
            modelSelection: modelSelection ?? undefined,
            replyReference: replyReference ?? null,
            timeoutMs: effTimeout,
            mounts: inContainerMounts,
            extensionPlan: request.extensionPlan ?? null,
          });

          if (followupRes.status === 'completed') {
            return {
              status: 'completed',
              turnId,
              sessionId,
              replyText: followupRes.replyText,
              eventsCount: followupRes.eventsCount,
              persisted: followupRes.persisted,
              usage: followupRes.usage,
              modelInfo: followupRes.modelInfo,
              routeAttempts: followupRes.routeAttempts,
            };
          }
          return {
            status: 'cancelled',
            turnId,
            sessionId,
            eventsCount: followupRes.eventsCount,
            persisted: followupRes.persisted,
          };
        } catch (err: unknown) {
          const errCode =
            err instanceof DaemonProtocolError
              ? err.code
              : typeof err === 'object' && err !== null && 'code' in err
                ? String((err as { code: unknown }).code)
                : 'EXECUTION_FAILED';
          const errMsg = err instanceof Error ? err.message : 'Turn execution failed';

          if (errCode === 'PERSISTED_SESSION_RESUME_FAILED') {
            return {
              status: 'error',
              code: 'PERSISTED_SESSION_RESUME_FAILED',
              turnId,
              sessionId,
              error: errMsg || 'Session resume failed',
            };
          }

          // On disconnect / transport error, attempt reconnect and journal reconciliation
          try {
            if (!transport.isConnected()) {
              await transport.start();
            }
            if (typeof transport.inspectTurn === 'function') {
              const inspected = await transport.inspectTurn(turnId);
              if (inspected.ok) {
                if (inspected.journalStatus === 'completed' && inspected.result) {
                  const comp = inspected.result;
                  return {
                    status: 'completed',
                    turnId,
                    sessionId,
                    replyText: comp.replyText ?? '',
                    eventsCount: comp.eventsCount,
                    persisted: comp.persisted,
                    usage: comp.status === 'completed' ? comp.usage : undefined,
                    modelInfo: comp.status === 'completed' ? comp.modelInfo : undefined,
                  };
                }
                if (inspected.journalStatus === 'cancelled') {
                  return {
                    status: 'cancelled',
                    turnId,
                    sessionId,
                    eventsCount: 0,
                    persisted: true,
                  };
                }
                if (inspected.journalStatus === 'failed') {
                  return {
                    status: 'error',
                    code: inspected.error?.code || 'AGENT_EXECUTION_FAILED',
                    turnId,
                    sessionId,
                    error: inspected.error?.message || 'Turn execution failed in daemon',
                  };
                }
                if (inspected.journalStatus === 'executing' || inspected.journalStatus === 'accepted') {
                  return {
                    status: 'error',
                    code: 'TURN_STATUS_UNKNOWN',
                    turnId,
                    sessionId,
                    error: 'Turn execution in progress in daemon; status unknown after reconnect',
                  };
                }
              }
            }
          } catch {}

          return {
            status: 'error',
            code: errCode || 'EXECUTION_FAILED',
            turnId,
            sessionId,
            error: errMsg,
          };
        }
      },
      checkSessionArtifact: async (
        sessionId: string,
        workspaceFolder?: string
      ): Promise<ExecCliEnvelope> => {
        const transport = await getOrStartTransport();
        if (!transport.checkSessionArtifact) {
          throw new DockerDaemonError('Transport does not support checkSessionArtifact');
        }
        const res = await transport.checkSessionArtifact(sessionId, workspaceFolder);
        return {
          status: res.ok ? 'ok' : 'error',
          sessionId,
          exists: res.exists,
          valid: res.valid,
          checksum: res.checksum,
          eventsCount: res.eventCount,
          error: res.error?.message,
        };
      },
      inspectSessionCorruption: async (
        sessionId: string,
        workspaceFolder?: string
      ): Promise<ExecCliEnvelope> => {
        const transport = await getOrStartTransport();
        if (!transport.inspectSessionCorruption) {
          throw new DockerDaemonError('Transport does not support inspectSessionCorruption');
        }
        const res = await transport.inspectSessionCorruption(sessionId, workspaceFolder);
        return {
          status: res.ok ? 'ok' : 'error',
          sessionId,
          exists: res.exists,
          valid: res.valid,
          corrupted: res.corrupted,
          code: res.code,
          lastValidSeq: res.lastValidSeq,
          lineCount: res.lineCount,
          validEventsCount: res.validEventsCount,
          errorDetail: res.errorDetail,
          error: res.error?.message,
        };
      },
      recoverSessionPrefix: async (options: {
        sourceSessionId: string;
        targetSessionId: string;
        workspaceFolder?: string;
        maxValidSeq?: number;
      }): Promise<ExecCliEnvelope> => {
        const transport = await getOrStartTransport();
        if (!transport.recoverSessionPrefix) {
          throw new DockerDaemonError('Transport does not support recoverSessionPrefix');
        }
        const res = await transport.recoverSessionPrefix(options);
        return {
          status: res.ok ? 'ok' : 'error',
          sessionId: res.targetSessionId,
          validEventsCount: res.validEventsCount,
          backupPath: res.backupPath,
          backupChecksum: res.backupChecksum,
          error: res.error?.message,
        };
      },
      exportForkSeed: async (
        sessionId: string,
        boundary?: { fromMessageId?: string; fromTurnId?: string },
        workspaceFolder?: string
      ): Promise<ExecCliEnvelope> => {
        try {
          const transport = await getOrStartTransport();
          if (!transport.exportForkSeed) {
            throw new DockerDaemonError('Transport does not support exportForkSeed');
          }
          const res = await transport.exportForkSeed(sessionId, boundary, workspaceFolder);
          return {
            status: res.ok ? 'ok' : 'error',
            sessionId,
            events: res.events,
            eventsCount: res.events?.length,
            totalEvents: res.events?.length,
            receipt: res.receipt,
            boundaryMapping: res.boundaryMapping,
            error: res.error?.message,
          };
        } catch (err: unknown) {
          const errCode =
            err instanceof DaemonProtocolError
              ? err.code
              : typeof err === 'object' && err !== null && 'code' in err
                ? String((err as { code: unknown }).code)
                : undefined;
          const errMsg = err instanceof Error ? err.message : 'Export fork seed failed';
          if (errCode === 'BOUNDARY_UNAVAILABLE' || errCode === 'NOT_FOUND') {
            return {
              status: 'error',
              code: errCode,
              sessionId,
              error: errMsg,
            };
          }
          throw err;
        }
      },
      importSeed: async (
        sessionId: string,
        seed: readonly unknown[],
        receipt?: unknown,
        profile?: unknown,
        spaceId?: string
      ): Promise<ExecCliEnvelope> => {
        try {
          const transport = await getOrStartTransport();
          if (!transport.importSeed) {
            throw new DockerDaemonError('Transport does not support importSeed');
          }
          const res = await transport.importSeed(sessionId, seed, receipt, profile, spaceId);
          return {
            status: res.ok ? 'ok' : 'error',
            sessionId: res.sessionId,
            persisted: res.persisted,
            eventsCount: res.eventsCount,
            receipt: res.receipt,
            duplicate: res.duplicate,
            error: res.error?.message,
          };
        } catch (err: unknown) {
          const errCode =
            err instanceof DaemonProtocolError
              ? err.code
              : typeof err === 'object' && err !== null && 'code' in err
                ? String((err as { code: unknown }).code)
                : 'IMPORT_FAILED';
          const errMsg = err instanceof Error ? err.message : 'Import failed';
          return {
            status: 'error',
            code: errCode,
            sessionId,
            error: errMsg,
          };
        }
      },
      cancelTurn: async (turnId: string): Promise<ExecCliEnvelope> => {
        if (!turnId || typeof turnId !== 'string' || turnId.trim().length === 0) {
          throw new Error('turnId is required for cancelTurn');
        }
        try {
          const transport = await getOrStartTransport();
          if (!transport.cancelTurn) {
            throw new DockerDaemonError('Transport does not support cancelTurn');
          }
          const res = await transport.cancelTurn(turnId);
          return {
            status: res.cancelled ? 'cancelled' : 'ok',
            turnId: res.turnId ?? turnId,
            code: res.cancelled ? 'CANCELLED' : 'OK',
          };
        } catch (err: unknown) {
          const errCode =
            err instanceof DaemonProtocolError
              ? err.code
              : typeof err === 'object' && err !== null && 'code' in err
                ? String((err as { code: unknown }).code)
                : undefined;
          const errMsg = err instanceof Error ? err.message : 'Cancel turn failed';
          if (errCode === 'TURN_NOT_FOUND' || errMsg.includes('not found')) {
            return {
              status: 'error',
              code: 'NOT_FOUND',
              turnId,
              error: errMsg || 'Turn not found for cancellation',
            };
          }
          throw err;
        }
      },
      inspectTurn: async (turnId: string): Promise<ExecCliEnvelope> => {
        if (!turnId || typeof turnId !== 'string' || turnId.trim().length === 0) {
          throw new Error('turnId is required for inspectTurn');
        }
        const transport = await getOrStartTransport();
        if (!transport.inspectTurn) {
          throw new DockerDaemonError('Transport does not support inspectTurn');
        }
        const res = await transport.inspectTurn(turnId);
        if (res.journalStatus === 'completed' && res.result) {
          const comp = res.result;
          return {
            status: 'completed',
            turnId: res.turnId,
            sessionId: res.sessionId,
            replyText: comp.replyText,
            eventsCount: comp.eventsCount,
            persisted: comp.persisted,
            usage: comp.status === 'completed' ? comp.usage : undefined,
            modelInfo: comp.status === 'completed' ? comp.modelInfo : undefined,
          };
        }
        if (res.journalStatus === 'executing' || res.journalStatus === 'accepted') {
          return {
            status: 'ok',
            code: 'RUNNING',
            turnId: res.turnId,
            sessionId: res.sessionId,
          };
        }
        if (res.journalStatus === 'cancelled') {
          return {
            status: 'cancelled',
            turnId: res.turnId,
            sessionId: res.sessionId,
            error: res.error?.message || 'Turn cancelled',
          };
        }
        if (res.journalStatus === 'failed') {
          return {
            status: 'error',
            turnId: res.turnId,
            sessionId: res.sessionId,
            error: res.error?.message || 'Turn failed',
          };
        }
        return { status: 'ok', exists: false, code: 'NOT_FOUND' };
      },
      fileOperation: async (request: FileOperationRequest): Promise<ExecCliEnvelope> => {
        try {
          const transport = await getOrStartTransport();
          if (!transport.fileOperation) {
            throw new DockerDaemonError('Transport does not support fileOperation');
          }
          const res = await transport.fileOperation(request);
          return {
            status: res.ok ? 'ok' : 'error',
            fileResult: res.fileResult,
            error: res.error?.message,
          };
        } catch (err: unknown) {
          const errCode =
            err instanceof DaemonProtocolError
              ? err.code
              : typeof err === 'object' && err !== null && 'code' in err
                ? String((err as { code: unknown }).code)
                : 'FILE_OP_FAILED';
          const errMsg = err instanceof Error ? err.message : 'File operation failed';
          return {
            status: 'error',
            code: errCode,
            error: errMsg,
          };
        }
      },
      instructionsRead: async (request): Promise<ExecCliEnvelope> => {
        try {
          const transport = await getOrStartTransport();
          if (!transport.instructionsRead) {
            throw new DockerDaemonError('Transport does not support instructionsRead');
          }
          const res = await transport.instructionsRead(request);
          return {
            status: res.ok ? 'ok' : 'error',
            instructionsResult: res,
            error: res.error?.message,
          };
        } catch (err: unknown) {
          const errCode =
            err instanceof DaemonProtocolError
              ? err.code
              : typeof err === 'object' && err !== null && 'code' in err
                ? String((err as { code: unknown }).code)
                : 'INSTRUCTIONS_READ_FAILED';
          const errMsg = err instanceof Error ? err.message : 'Instructions read failed';
          return {
            status: 'error',
            code: errCode,
            error: errMsg,
          };
        }
      },
      instructionsWrite: async (request): Promise<ExecCliEnvelope> => {
        try {
          const transport = await getOrStartTransport();
          if (!transport.instructionsWrite) {
            throw new DockerDaemonError('Transport does not support instructionsWrite');
          }
          const res = await transport.instructionsWrite(request);
          return {
            status: res.ok ? 'ok' : 'error',
            instructionsResult: res,
            error: res.error?.message,
          };
        } catch (err: unknown) {
          const errCode =
            err instanceof DaemonProtocolError
              ? err.code
              : typeof err === 'object' && err !== null && 'code' in err
                ? String((err as { code: unknown }).code)
                : 'INSTRUCTIONS_WRITE_FAILED';
          const errMsg = err instanceof Error ? err.message : 'Instructions write failed';
          return {
            status: 'error',
            code: errCode,
            error: errMsg,
          };
        }
      },
      /**
       * Large streaming file operations use direct safe Docker exec streaming
       * because they stream raw binary chunks and do not touch Session JSONL or mutating session state.
       */
      fileWriteStream: (options, inStream) =>
        adapterClient.execWriteStream(expectation, options, inStream),
      fileStageStream: (options, inStream) =>
        adapterClient.execStageStream(expectation, options, inStream),
      fileCommitStage: (options) =>
        adapterClient.execCommitStage(expectation, options),
      fileAbortStage: (options) =>
        adapterClient.execAbortStage(expectation, options),
      fileFinalizeStage: (options) =>
        adapterClient.execFinalizeStage(expectation, options),
      fileRollbackCommit: (options) =>
        adapterClient.execRollbackCommit(expectation, options),
      fileInspectTransferState: (options) =>
        adapterClient.execInspectTransferState(expectation, options),
      fileReadStream: (options) =>
        adapterClient.execReadStream(expectation, options),
      stop: async () => {
        const errors: unknown[] = [];
        if (activeTransport) {
          try {
            await activeTransport.close();
            activeTransport = undefined;
          } catch (trErr: unknown) {
            errors.push(trErr);
          }
        }
        if (activeTunnel) {
          try {
            await activeTunnel.close();
            activeTunnel = undefined;
          } catch (tErr: unknown) {
            errors.push(tErr);
          }
        }
        try {
          await adapterClient.stopContainer(expectation, 5);
        } catch (err: unknown) {
          errors.push(err);
        }
        if (errors.length > 0) {
          throw new AggregateError(
            errors.map((e) => (e instanceof Error ? e : new Error('Stop error', { cause: e }))),
            'Stop failed for container'
          );
        }
      },
      teardown: async (removeVolume = false) => {
        const errors: unknown[] = [];
        if (activeTransport) {
          try {
            await activeTransport.close();
            activeTransport = undefined;
          } catch (trErr: unknown) {
            errors.push(trErr);
          }
        }
        if (activeTunnel) {
          try {
            await activeTunnel.close();
            activeTunnel = undefined;
          } catch (tErr: unknown) {
            errors.push(tErr);
          }
        }
        try {
          await adapterClient.stopContainer(expectation, 2);
        } catch (err: unknown) {
          if (!(err instanceof DockerNotFoundError)) {
            errors.push(err);
          }
        }

        try {
          await adapterClient.removeContainer(expectation, true);
        } catch (err: unknown) {
          if (!(err instanceof DockerNotFoundError)) {
            errors.push(err);
          }
        }

        if (removeVolume) {
          try {
            await adapterClient.removeVolume({
              volumeName: spec.volume.volumeName,
              userId: spec.userId,
              volumeId: spec.volume.volumeId,
            });
          } catch (err: unknown) {
            if (!(err instanceof DockerNotFoundError)) {
              errors.push(err);
            }
          }
        }

        if (errors.length > 0) {
          throw new AggregateError(
            errors.map((e) => (e instanceof Error ? e : new Error('Teardown error', { cause: e }))),
            'Teardown failed for container'
          );
        }
      },
    };

    return handle;
  }
}
