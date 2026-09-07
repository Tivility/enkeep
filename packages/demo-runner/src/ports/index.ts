/**
 * Orchestration Ports and Adapters
 *
 * Defines explicit contract boundaries for platform server, container runtime,
 * storage provisioning, mock importing, and probe verification.
 *
 * All adapters enforce strict fail-closed semantics: if underlying subsystems
 * are missing or Docker containers cannot be verified, operations fail with explicit errors
 * rather than faking verification.
 *
 * Zero-network Docker container execution is strictly enforced via DockerExecTransport.
 *
 * @module @enkeep/demo-runner/ports
 */

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { PlatformStorage, Space, User } from '@enkeep/platform-core';
import type { RuntimeAgentProfileSnapshot } from '@enkeep/platform-server';
import type {
  RuntimeTurnRequest,
  RuntimeWorkspaceSegment,
  CanonicalAttachment,
} from '@enkeep/protocol';
import type {
  PluginReadinessStatus,
  ToolsUnavailableReasonCode,
} from '@enkeep/runtime-runner/transport';
import { isAllowedToolsUnavailableReason } from '@enkeep/runtime-runner/transport';
import type { ImportResult } from '@enkeep/import-happyclaw';
import {
  DockerRuntimeAdapter,
  SafeDockerClient,
  DockerNotFoundError,
  computeSessionEventsChecksum,
  canonicalJsonStringify,
  loadDshDeploymentConfig,
  createInContainerProvidersSpec,
  createLlmProxyHandler,
  HostRuntimeAdapter,
  type HostRuntimeSpec,
  type ActiveRuntimeHandle,
  type SessionSeedReceipt,
} from '@enkeep/runtime-runner';
import {
  validateContainerSpec,
} from '@enkeep/runtime-runner/spec';
import type {
  ProbeSnapshot,
  SignedProcessMetadata,
  SignedContainerMetadata,
  DemoPathOptions,
  DemoRunnerMode,
} from '../types.js';
import {
  writeSignedContainerMeta,
  readSignedContainerMeta,
  listSignedContainers,
  removeSignedContainerMeta,
  writeSignedVolumeMeta,
  readSignedVolumeMeta,
  removeSignedVolumeMeta,
  generateRunId,
  VOLUME_ID_REGEX,
} from '../utils/crypto-meta.js';
import {
  RUN_ID_LABEL_KEY,
  VOLUME_ID_LABEL_KEY,
  validateResourceSuffix,
  getDemoPathConfig,
} from '../config.js';

export const MAX_TURN_PROMPT_BYTES = 64 * 1024; // 65,536 bytes (64KiB)
export const MAX_TURN_PROMPT_LENGTH = MAX_TURN_PROMPT_BYTES;

export function validateTurnPrompt(prompt: unknown): string {
  if (typeof prompt !== 'string') {
    throw new Error('FAIL-CLOSED: sendTurn prompt must be a string');
  }
  if (prompt.trim().length === 0) {
    throw new Error('FAIL-CLOSED: sendTurn requires a non-empty prompt string');
  }
  if (Buffer.byteLength(prompt, 'utf8') > MAX_TURN_PROMPT_BYTES) {
    throw new Error('FAIL-CLOSED: sendTurn prompt exceeds maximum allowed length');
  }
  return prompt;
}

/**
 * Platform Server Orchestration Port
 */
export interface PlatformServerPort {
  start(options: { host: string; port: number; dbPath: string; options?: DemoPathOptions }): Promise<{
    url: string;
    host: string;
    port: number;
    pid: number;
    meta: SignedProcessMetadata;
    close(): Promise<void>;
  }>;
  stop(serviceName: string, options?: DemoPathOptions): Promise<void>;
}

export interface UserRuntimeHealthInfo {
  status: 'ok';
  dshReady: boolean;
  uptimeSeconds: number;
  version: string;
  enkeepBundleLoaded: boolean;
  modelProvider: string;
  toolsCount: number;
  plugins: PluginReadinessStatus;
  toolsOperational: boolean;
  toolsUnavailableReason: ToolsUnavailableReasonCode | null;
  userId: string;
}

/**
 * User Runtime Container Handle (Zero-Network Architecture via Docker Exec Transport)
 */
export interface UserRuntimeHandle {
  userId: string;
  containerName: string;
  containerId: string;
  volumeId: string;
  runId: string;
  volumeCreated: boolean;
  meta?: SignedContainerMetadata;
  rawHandle?: ActiveRuntimeHandle;
  checkHealth(): Promise<UserRuntimeHealthInfo>;
  checkSessionArtifact?(sessionId: string, workspaceFolder?: string): Promise<{ exists: boolean; valid: boolean; checksum?: string; eventCount?: number }>;
  inspectSessionCorruption?(sessionId: string, workspaceFolder?: string): Promise<any>;
  recoverSessionPrefix?(options: { sourceSessionId: string; targetSessionId: string; workspaceFolder?: string; maxValidSeq?: number }): Promise<any>;
  exportForkSeed?(
    sessionId: string,
    boundary?: { fromMessageId?: string; fromTurnId?: string },
    workspaceFolder?: string
  ): Promise<{ events: readonly unknown[]; receipt: SessionSeedReceipt; boundaryMapping?: Record<string, unknown> }>;
  importSeed?(sessionId: string, seed: readonly unknown[], receipt?: unknown, profile?: unknown, spaceId?: string): Promise<{ status: string; sessionId: string; persisted: true; eventsCount: number; receipt: SessionSeedReceipt; duplicate: boolean }>;
  sendTurn(
    request: RuntimeTurnRequest
  ): Promise<{
    replyText: string;
    persisted: true;
    eventsCount: number;
    usage?: { totalTokens: number };
    modelInfo?: { provider: string; model: string; reasoningEffort?: string | null; source?: string; fallbackUsed?: boolean };
    routeAttempts?: Array<{ provider: string; model: string; latencyMs: number; statusCode: number; success: boolean; errorType?: string | null }>;
  }>;
  cancelTurn(turnId: string): Promise<{ status: 'cancelled'; turnId: string }>;
  inspectTurnResult?(turnId: string): Promise<{
    status: 'absent' | 'running' | 'completed' | 'failed';
    replyText?: string;
    eventsCount?: number;
    persisted?: boolean;
    error?: string;
  }>;
  fileOperation(request: import('@enkeep/runtime-runner').FileOperationRequest): Promise<import('@enkeep/runtime-runner').ExecCliEnvelope>;
  instructionsRead?(request: { target: 'global' | 'space'; spaceFolder?: string; filename?: string }): Promise<import('@enkeep/runtime-runner').ExecCliEnvelope>;
  instructionsWrite?(request: { target: 'global' | 'space'; content: string; spaceFolder?: string; filename?: string; expectedEtag?: string | null; requireAbsent?: boolean }): Promise<import('@enkeep/runtime-runner').ExecCliEnvelope>;
  stop(): Promise<void>;
  teardown(removeVolume?: boolean): Promise<void>;
}

/**
 * Runtime Container Orchestration Port
 */
export interface RuntimeContainerPort {
  startUserRuntime(options: {
    userId: 'alice' | 'bob' | string;
    image?: string;
    repoRoot?: string;
    dataRoot?: string;
    mode?: DemoRunnerMode;
    resourceSuffix?: string;
    timeoutMs?: number;
    llmEnabled?: boolean;
    llmProvider?: string;
    llmModel?: string;
    llmProviders?: string | Record<string, unknown>;
    browserService?: import('@enkeep/platform-core').BrowserService;
    mounts?: readonly import('@enkeep/platform-core').RuntimeMountSpec[];
  }): Promise<UserRuntimeHandle>;
  connectUserRuntime?(options: {
    userId: 'alice' | 'bob' | string;
    image?: string;
    repoRoot?: string;
    dataRoot?: string;
    mode?: DemoRunnerMode;
    resourceSuffix?: string;
    timeoutMs?: number;
    llmEnabled?: boolean;
    llmProvider?: string;
    llmModel?: string;
    llmProviders?: string | Record<string, unknown>;
    mounts?: readonly import('@enkeep/platform-core').RuntimeMountSpec[];
  }): Promise<UserRuntimeHandle>;
  listActiveRuntimes(options?: DemoPathOptions | string): Promise<SignedContainerMetadata[]>;
  stopUserRuntime(containerName: string, removeVolume?: boolean, options?: DemoPathOptions | string): Promise<void>;
}

/**
 * Creates a UserRuntimeHandle wrapping an active runtime container handle with strict fail-closed validations.
 */
function createUserRuntimeHandle(
  activeHandle: ActiveRuntimeHandle,
  spec: { containerName: string; userId: string; volume: { volumeName: string; volumeId: string } },
  meta: SignedContainerMetadata | undefined,
  volumeCreated: boolean,
  pathOptions: DemoPathOptions
): UserRuntimeHandle {
  return {
    userId: spec.userId,
    containerName: spec.containerName,
    containerId: activeHandle.containerId,
    volumeId: spec.volume.volumeId,
    runId: activeHandle.runId,
    volumeCreated,
    meta,
    rawHandle: activeHandle,
    checkHealth: async (): Promise<UserRuntimeHealthInfo> => {
      const health = await activeHandle.checkHealth();
      if (health.status !== 'ok') {
        throw new Error('FAIL-CLOSED: Health check returned unhealthy status');
      }
      if (health.dshReady !== true) {
        throw new Error('FAIL-CLOSED: Health check reported dshReady is not true');
      }
      if (typeof health.userId !== 'string' || health.userId !== spec.userId) {
        throw new Error('FAIL-CLOSED: Health check userId mismatch');
      }
      if (typeof health.uptimeSeconds !== 'number' || !Number.isFinite(health.uptimeSeconds) || health.uptimeSeconds < 0) {
        throw new Error('FAIL-CLOSED: Health check returned invalid uptimeSeconds');
      }
      if (typeof health.version !== 'string' || !health.version.trim()) {
        throw new Error('FAIL-CLOSED: Health check returned invalid version');
      }
      if (typeof health.enkeepBundleLoaded !== 'boolean') {
        throw new Error('FAIL-CLOSED: Health check returned invalid enkeepBundleLoaded');
      }
      if (typeof health.toolsCount !== 'number' || !Number.isSafeInteger(health.toolsCount) || health.toolsCount < 0) {
        throw new Error('FAIL-CLOSED: Health check returned invalid toolsCount');
      }
      if (!health.plugins || typeof health.plugins !== 'object') {
        throw new Error('FAIL-CLOSED: Health check returned missing plugins object');
      }
      const plugins = health.plugins as PluginReadinessStatus;
      if (
        typeof plugins.receiptStore !== 'boolean' ||
        typeof plugins.inbound !== 'boolean' ||
        typeof plugins.eventRelay !== 'boolean' ||
        typeof plugins.externalInteraction !== 'boolean' ||
        typeof plugins.affinityPolicy !== 'boolean' ||
        typeof plugins.llmAffinity !== 'boolean' ||
        typeof plugins.tools !== 'boolean'
      ) {
        throw new Error('FAIL-CLOSED: Health check returned invalid plugin readiness flags');
      }
      if (typeof health.toolsOperational !== 'boolean') {
        throw new Error('FAIL-CLOSED: Health check returned invalid toolsOperational');
      }
      let toolsUnavailableReason: ToolsUnavailableReasonCode | null;
      if (health.toolsOperational === false) {
        if (!isAllowedToolsUnavailableReason(health.toolsUnavailableReason)) {
          throw new Error('FAIL-CLOSED: Health check returned invalid toolsUnavailableReason');
        }
        toolsUnavailableReason = health.toolsUnavailableReason;
      } else {
        if (health.toolsUnavailableReason !== null && health.toolsUnavailableReason !== undefined) {
          throw new Error('FAIL-CLOSED: Health check returned unexpected toolsUnavailableReason for operational tools');
        }
        toolsUnavailableReason = null;
      }
      if (
        typeof health.modelProvider !== 'string' ||
        health.modelProvider.length === 0 ||
        health.modelProvider !== health.modelProvider.trim() ||
        health.modelProvider !== health.modelProvider.normalize('NFC')
      ) {
        throw new Error('FAIL-CLOSED: Health check returned missing or invalid modelProvider');
      }
      const modelProvider = health.modelProvider;
      return {
        status: health.status,
        dshReady: health.dshReady,
        uptimeSeconds: health.uptimeSeconds,
        version: health.version,
        enkeepBundleLoaded: health.enkeepBundleLoaded,
        modelProvider,
        toolsCount: health.toolsCount,
        plugins: {
          receiptStore: plugins.receiptStore,
          inbound: plugins.inbound,
          eventRelay: plugins.eventRelay,
          externalInteraction: plugins.externalInteraction,
          affinityPolicy: plugins.affinityPolicy,
          llmAffinity: plugins.llmAffinity,
          tools: plugins.tools,
        },
        toolsOperational: health.toolsOperational,
        toolsUnavailableReason,
        userId: health.userId,
      };
    },
    checkSessionArtifact: activeHandle.checkSessionArtifact
      ? async (sessionId: string, workspaceFolder?: string) => {
          if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
            throw new Error('FAIL-CLOSED: checkSessionArtifact requires a non-empty sessionId');
          }
          const res = await activeHandle.checkSessionArtifact!(sessionId, workspaceFolder);
          return {
            exists: res.exists === true,
            valid: res.valid === true,
            checksum: res.checksum,
            eventCount: res.eventsCount,
          };
        }
      : undefined,
    inspectSessionCorruption: activeHandle.inspectSessionCorruption
      ? async (sessionId: string, workspaceFolder?: string) => {
          if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
            throw new Error('FAIL-CLOSED: inspectSessionCorruption requires a non-empty sessionId');
          }
          return activeHandle.inspectSessionCorruption!(sessionId, workspaceFolder);
        }
      : undefined,
    recoverSessionPrefix: activeHandle.recoverSessionPrefix
      ? async (options: { sourceSessionId: string; targetSessionId: string; workspaceFolder?: string; maxValidSeq?: number }) => {
          return activeHandle.recoverSessionPrefix!(options);
        }
      : undefined,
    exportForkSeed: activeHandle.exportForkSeed
      ? async (
          sessionId: string,
          boundary?: { fromMessageId?: string; fromTurnId?: string },
          workspaceFolder?: string
        ) => {
          if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
            throw new Error('FAIL-CLOSED: exportForkSeed requires a non-empty sessionId');
          }
          const res = await activeHandle.exportForkSeed!(sessionId, boundary, workspaceFolder);
          if (res.status !== 'ok') {
            if (res.code === 'BOUNDARY_UNAVAILABLE') {
              const boundaryErr = new Error('BOUNDARY_UNAVAILABLE: Requested fork boundary is unavailable');
              (boundaryErr as any).code = 'BOUNDARY_UNAVAILABLE';
              throw boundaryErr;
            }
            if (res.code === 'NOT_FOUND') {
              const notFoundErr = new Error('NOT_FOUND: Session not found for fork export');
              (notFoundErr as any).code = 'NOT_FOUND';
              throw notFoundErr;
            }
            throw new Error(`FAIL-CLOSED: exportForkSeed failed: status=${res.status}, code=${res.code}, error=${res.error}`);
          }
          if (!Array.isArray(res.events) || res.events.length === 0) {
            throw new Error('FAIL-CLOSED: exportForkSeed returned empty or non-array events');
          }
          if (!res.receipt || res.receipt.algorithm !== 'sha256-session-events-v1') {
            throw new Error('FAIL-CLOSED: exportForkSeed returned invalid receipt');
          }
          return {
            events: res.events,
            receipt: res.receipt,
            boundaryMapping: res.boundaryMapping,
          };
        }
      : undefined,
    importSeed: async (
      sessionId: string,
      seed: readonly unknown[],
      receipt?: unknown,
      profile?: unknown,
      spaceId?: string
    ) => {
      if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
        throw new Error('FAIL-CLOSED: importSeed requires a non-empty sessionId');
      }
      if (!Array.isArray(seed) || seed.length === 0) {
        throw new Error('FAIL-CLOSED: importSeed requires a non-empty seed array');
      }

      // Compute expected canonical receipt locally for strict tamper/mismatch assertion
      const expectedChecksum = computeSessionEventsChecksum(seed);
      const expectedJson = canonicalJsonStringify(seed);
      const expectedCanonicalBytes = Buffer.byteLength(expectedJson, 'utf8');
      const expectedEventCount = seed.length;

      const res = await activeHandle.importSeed(sessionId, seed, receipt, profile, spaceId);
      if (res.status !== 'ok' && res.status !== 'completed') {
        throw new Error(`FAIL-CLOSED: Seed import failed: status=${res.status}, code=${res.code}, error=${res.error}`);
      }
      if (res.sessionId !== sessionId) {
        throw new Error('FAIL-CLOSED: Seed import sessionId mismatch');
      }
      if (res.persisted !== true) {
        throw new Error('FAIL-CLOSED: Seed import not persisted');
      }
      if (typeof res.eventsCount !== 'number' || !Number.isSafeInteger(res.eventsCount) || res.eventsCount < 0) {
        throw new Error('FAIL-CLOSED: Seed import returned invalid eventsCount');
      }
      if (
        !res.receipt ||
        typeof res.receipt !== 'object' ||
        res.receipt.algorithm !== 'sha256-session-events-v1' ||
        res.receipt.checksum !== expectedChecksum ||
        res.receipt.canonicalBytes !== expectedCanonicalBytes ||
        res.receipt.eventCount !== expectedEventCount
      ) {
        throw new Error('FAIL-CLOSED: Seed import receipt mismatch');
      }
      if (typeof res.duplicate !== 'boolean') {
        throw new Error('FAIL-CLOSED: Seed import returned missing or non-boolean duplicate flag');
      }
      return {
        status: res.status,
        sessionId: res.sessionId,
        persisted: true,
        eventsCount: res.eventsCount,
        receipt: res.receipt,
        duplicate: res.duplicate,
      };
    },
    sendTurn: async (
      request: RuntimeTurnRequest
    ) => {
      if (!request || typeof request !== 'object' || Array.isArray(request)) {
        throw new Error('FAIL-CLOSED: sendTurn requires a RuntimeTurnRequest object');
      }
      const { prompt, sessionId, turnId, profileSnapshot, workspaceFolder, timeoutMs, attachments, modelSelection, mounts, extensionPlan } = request;
      validateTurnPrompt(prompt);
      if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
        throw new Error('FAIL-CLOSED: sendTurn requires a non-empty sessionId');
      }
      if (!turnId || typeof turnId !== 'string' || turnId.trim().length === 0) {
        throw new Error('FAIL-CLOSED: sendTurn requires a non-empty turnId');
      }
      const effTransport = activeHandle.transport ?? (activeHandle as { rawHandle?: ActiveRuntimeHandle }).rawHandle?.transport;
      let res: {
        status: string;
        code?: string;
        error?: string;
        replyText?: string;
        persisted?: boolean;
        eventsCount?: number;
        usage?: { totalTokens: number };
        modelInfo?: { provider: string; model: string; reasoningEffort?: string | null; source?: string; fallbackUsed?: boolean };
        routeAttempts?: Array<{ provider: string; model: string; latencyMs: number; statusCode: number; success: boolean; errorType?: string | null }>;
      };
      if (effTransport && typeof effTransport.sendFollowup === 'function') {
        const followupRes = await effTransport.sendFollowup({
          prompt,
          sessionId,
          turnId,
          profileSnapshot: profileSnapshot as any,
          profile: profileSnapshot as any,
          workspaceFolder: typeof workspaceFolder === 'string' ? workspaceFolder : undefined,
          attachments,
          modelSelection: modelSelection ?? undefined,
          timeoutMs,
          mounts,
          extensionPlan,
        });
        if (followupRes.status === 'completed') {
          res = {
            status: followupRes.status,
            replyText: followupRes.replyText,
            persisted: followupRes.persisted,
            eventsCount: followupRes.eventsCount,
            usage: followupRes.usage,
            modelInfo: followupRes.modelInfo,
            routeAttempts: followupRes.routeAttempts,
          };
        } else {
          res = {
            status: followupRes.status,
            code: (followupRes as any).code,
            error: (followupRes as any).error,
            persisted: followupRes.persisted,
            eventsCount: followupRes.eventsCount,
          };
        }
      } else {
        res = await activeHandle.sendFollowup({
          prompt,
          sessionId,
          turnId,
          profileSnapshot,
          workspaceFolder,
          timeoutMs,
          attachments,
          modelSelection,
          mounts,
          extensionPlan,
        });
      }
      if (res.status !== 'completed') {
        throw new Error(
          `FAIL-CLOSED: Turn execution envelope status is not completed: status=${res.status}, code=${res.code}, error=${res.error}`
        );
      }
      if (typeof res.replyText !== 'string' || res.replyText.trim().length === 0) {
        throw new Error('FAIL-CLOSED: Turn execution returned missing, empty, or non-string replyText');
      }
      if (res.persisted !== true) {
        throw new Error('FAIL-CLOSED: Turn execution returned persisted=false');
      }
      if (typeof res.eventsCount !== 'number' || !Number.isSafeInteger(res.eventsCount) || res.eventsCount <= 0) {
        throw new Error('FAIL-CLOSED: Turn execution returned missing or invalid positive safe-integer eventsCount');
      }
      return {
        replyText: res.replyText,
        persisted: true,
        eventsCount: res.eventsCount,
        usage: res.usage,
        modelInfo: res.modelInfo,
        routeAttempts: res.routeAttempts,
      };
    },
    cancelTurn: async (turnId: string) => {
      if (!turnId || typeof turnId !== 'string' || turnId.trim().length === 0) {
        throw new Error('FAIL-CLOSED: cancelTurn requires a non-empty turnId');
      }
      const res = await activeHandle.cancelTurn(turnId);
      if (res.status !== 'cancelled') {
        throw new Error('FAIL-CLOSED: Cancel turn returned non-cancelled status');
      }
      if (typeof res.turnId !== 'string' || res.turnId.trim().length === 0) {
        throw new Error('FAIL-CLOSED: Cancel turn returned missing or empty turnId');
      }
      if (res.turnId !== turnId) {
        throw new Error('FAIL-CLOSED: Cancel turn turnId mismatch');
      }
      return {
        status: 'cancelled',
        turnId: res.turnId,
      };
    },
    inspectTurnResult: async (turnId: string) => {
      if (!turnId || typeof turnId !== 'string' || turnId.trim().length === 0) {
        throw new Error('FAIL-CLOSED: inspectTurnResult requires a non-empty turnId');
      }
      if (typeof activeHandle.inspectTurn !== 'function') {
        return { status: 'absent' };
      }
      const res = await activeHandle.inspectTurn(turnId);
      if (res.status === 'completed') {
        return {
          status: 'completed',
          replyText: res.replyText,
          eventsCount: res.eventsCount,
          persisted: res.persisted,
        };
      }
      if (res.status === 'error' || res.status === 'cancelled') {
        return {
          status: 'failed',
          error: res.error || 'Turn execution failed',
        };
      }
      if (res.status === 'ok' && res.code === 'RUNNING') {
        return {
          status: 'running',
        };
      }
      return {
        status: 'absent',
      };
    },
    fileOperation: activeHandle.fileOperation
      ? activeHandle.fileOperation.bind(activeHandle)
      : async (request: import('@enkeep/runtime-runner').FileOperationRequest) => {
          throw new Error('FAIL-CLOSED: fileOperation is not supported by runtime handle');
        },
    instructionsRead: activeHandle.instructionsRead
      ? activeHandle.instructionsRead.bind(activeHandle)
      : undefined,
    instructionsWrite: activeHandle.instructionsWrite
      ? activeHandle.instructionsWrite.bind(activeHandle)
      : undefined,
    stop: async () => {
      await activeHandle.stop();
    },
    teardown: async (removeVolume = false) => {
      await activeHandle.teardown(removeVolume);
      removeSignedContainerMeta(spec.containerName, pathOptions);
      if (removeVolume) {
        removeSignedVolumeMeta(spec.volume.volumeName, pathOptions);
      }
    },
  };
}

/**
 * Real Docker Runtime Container Adapter implementing RuntimeContainerPort
 *
 * Enforces:
 * - Real Docker container execution via @enkeep/runtime-runner
 * - Strict non-root user (1000:1000)
 * - Zero open network ports (--network none) via Docker Exec transport (docker-exec://)
 * - Isolated per-user volumes (enkeep-demo-dsh-<user>)
 * - Fail-closed: Throws immediately if Docker is unavailable or container fails to boot.
 */
export class DockerRuntimeContainerAdapter implements RuntimeContainerPort {
  private readonly adapter: DockerRuntimeAdapter;
  private readonly client: SafeDockerClient;

  constructor(client: SafeDockerClient = new SafeDockerClient()) {
    this.client = client;
    this.adapter = new DockerRuntimeAdapter(client);
  }

  async startUserRuntime(options: {
    userId: 'alice' | 'bob' | string;
    image?: string;
    repoRoot?: string;
    dataRoot?: string;
    mode?: DemoRunnerMode;
    resourceSuffix?: string;
    timeoutMs?: number;
    llmEnabled?: boolean;
    mounts?: readonly import('@enkeep/platform-core').RuntimeMountSpec[];
  }): Promise<UserRuntimeHandle> {
    const pathOptions: DemoPathOptions = {
      repoRoot: options.repoRoot,
      dataRoot: options.dataRoot,
      mode: options.mode,
      resourceSuffix: options.resourceSuffix,
    };
    validateResourceSuffix(options.resourceSuffix);

    const timeoutMs = options.timeoutMs ?? 15000;

    // Fail-closed check: Docker daemon MUST be available
    const isDockerAvailable = await this.client.isDockerAvailable();
    if (!isDockerAvailable) {
      throw new Error(
        'FAIL-CLOSED: Docker daemon is required but unavailable. Cannot fall back to process execution.'
      );
    }

    // 1. Build initial temporary spec only to derive deterministic container and volume names
    const tempRunId = generateRunId();
    const tempSpec = this.adapter.createDefaultUserSpec({
      userId: options.userId,
      image: options.image ?? 'enkeep-demo-runtime:latest',
      nameSuffix: options.resourceSuffix,
      runId: tempRunId,
    });
    const expectedVolumeName = tempSpec.volume.volumeName;

    // 2. Check for existing signed container & volume metadata
    const existingContainerMeta = readSignedContainerMeta(tempSpec.containerName, pathOptions);
    const existingVolMeta = readSignedVolumeMeta(expectedVolumeName, pathOptions);
    let isOwnedVolumeResume = Boolean(existingVolMeta);

    const existingContainer = await this.client.inspectContainer(tempSpec.containerName);
    let isExistingContainerReconnect = Boolean(
      existingContainerMeta &&
      existingContainer &&
      existingContainer.id === existingContainerMeta.containerId
    );

    let selectedVolumeId: string;
    let finalRunId: string;

    if (isExistingContainerReconnect) {
      selectedVolumeId = existingContainerMeta!.volumeId;
      finalRunId = existingContainerMeta!.runId;
    } else if (existingVolMeta) {
      if (existingVolMeta.userId !== options.userId) {
        throw new Error(
          'FAIL-CLOSED: Signed volume metadata userId mismatch'
        );
      }
      if (existingVolMeta.volumeName !== expectedVolumeName) {
        throw new Error(
          'FAIL-CLOSED: Signed volume metadata volumeName mismatch'
        );
      }
      if (!existingVolMeta.volumeId || typeof existingVolMeta.volumeId !== 'string' || !VOLUME_ID_REGEX.test(existingVolMeta.volumeId)) {
        throw new Error(
          'FAIL-CLOSED: Signed volume metadata has invalid volumeId format'
        );
      }
      selectedVolumeId = existingVolMeta.volumeId;
      finalRunId = generateRunId();
    } else {
      selectedVolumeId = `vol_${randomBytes(16).toString('hex').toLowerCase()}`;
      finalRunId = generateRunId();
    }

    // 3. Recreate final spec with selected stable volumeId and fresh runId
    const dshConfig = loadDshDeploymentConfig();
    const isLlmConfigured = Boolean(
      dshConfig &&
      dshConfig.providers &&
      Object.keys(dshConfig.providers).length > 0 &&
      dshConfig.tokens &&
      Object.values(dshConfig.tokens).some((t) => t && t.trim().length > 0)
    );

    let isLlmEnabled: boolean;
    if (options.llmEnabled === false || process.env.ENKEEP_LLM_ENABLED === '0') {
      isLlmEnabled = false; // Explicit disable has highest priority
    } else if (options.llmEnabled === true || process.env.ENKEEP_LLM_ENABLED === '1') {
      isLlmEnabled = true; // Explicit enable
    } else {
      isLlmEnabled = isLlmConfigured; // Default: auto-enable if DSH deployment config and token are valid
    }

    // Query platform.db model_config_overrides for active platform override
    let modelOverride: { provider: string | null; model: string | null; reasoning_effort: string | null } | null = null;
    let overrideDb: DatabaseSync | null = null;
    const paths = getDemoPathConfig(pathOptions);

    if (paths.dbPath && existsSync(paths.dbPath)) {
      try {
        overrideDb = new DatabaseSync(paths.dbPath, { readOnly: true });
        const rawRow = overrideDb
          .prepare("SELECT provider, model, reasoning_effort FROM model_config_overrides WHERE id = 'default'")
          .get() as Record<string, unknown> | undefined;

        if (rawRow && typeof rawRow === 'object') {
          const providerVal = typeof rawRow.provider === 'string' ? rawRow.provider : (rawRow.provider === null ? null : null);
          const modelVal = typeof rawRow.model === 'string' ? rawRow.model : (rawRow.model === null ? null : null);
          const reasoningVal = typeof rawRow.reasoning_effort === 'string' ? rawRow.reasoning_effort : (rawRow.reasoning_effort === null ? null : null);

          if (providerVal || modelVal) {
            modelOverride = {
              provider: providerVal,
              model: modelVal,
              reasoning_effort: reasoningVal,
            };
          }
        }
      } catch (err: unknown) {
        throw new Error('FAIL-CLOSED: Failed to query model_config_overrides from platform database', { cause: err });
      } finally {
        if (overrideDb) {
          try {
            overrideDb.close();
          } catch (closeErr) {
            // Aggregate if close fails
            throw new AggregateError([closeErr], 'FAIL-CLOSED: Failed to close platform database after querying model overrides');
          }
        }
      }
    }

    const llmProvider =
      modelOverride?.provider ||
      dshConfig?.defaultModel?.provider ||
      process.env.ENKEEP_LLM_PROVIDER ||
      'cpa-claude';

    const llmModel =
      modelOverride?.model ||
      dshConfig?.defaultModel?.model ||
      process.env.ENKEEP_LLM_MODEL ||
      'claude-fable-5';

    const inContainerProviders = dshConfig?.providers
      ? createInContainerProvidersSpec(dshConfig.providers)
      : undefined;

    const spec = this.adapter.createDefaultUserSpec({
      userId: options.userId,
      image: options.image ?? 'enkeep-demo-runtime:latest',
      nameSuffix: options.resourceSuffix,
      runId: finalRunId,
      volumeId: selectedVolumeId,
      llmEnabled: isLlmEnabled,
      llmProvider,
      llmModel,
      llmProviders: inContainerProviders,
    });
    if (options.mounts && options.mounts.length > 0) {
      spec.mounts = [...options.mounts];
    }

    const validation = validateContainerSpec(spec);
    if (!validation.valid) {
      throw new Error('FAIL-CLOSED: Container specification validation failed');
    }

    let activeHandle: ActiveRuntimeHandle | undefined;
    let writtenVolMeta = false;
    let writtenContainerMeta = false;
    let meta: SignedContainerMetadata | undefined;

    try {
      // If container already exists on host and matches signed metadata, reconnect to it
      // Otherwise if signed volume metadata exists, start new container mounting the existing owned volume
      // Otherwise, start fresh container creating a new volume
      if (isExistingContainerReconnect) {
        try {
          activeHandle = await this.adapter.connectRuntime(
            spec,
            {
              containerId: existingContainerMeta!.containerId,
              containerName: existingContainerMeta!.containerName,
              userId: options.userId,
              runId: existingContainerMeta!.runId,
              volumeId: existingContainerMeta!.volumeId,
            },
            timeoutMs
          );
        } catch (connErr: unknown) {
          if (
            connErr instanceof DockerNotFoundError ||
            (connErr instanceof Error && (connErr.name === 'DockerNotFoundError' || connErr.message.includes('not found') || connErr.message.includes('RESOURCE_NOT_FOUND')))
          ) {
            // Container or volume disappeared on host: unlink stale container metadata and reconcile
            try {
              removeSignedContainerMeta(spec.containerName, pathOptions);
            } catch {}
            isExistingContainerReconnect = false;
          } else {
            throw connErr;
          }
        }
      }

      if (!activeHandle && isOwnedVolumeResume) {
        try {
          activeHandle = await this.adapter.startRuntimeWithOwnedVolume(spec, timeoutMs);
        } catch (ownedErr: unknown) {
          if (
            ownedErr instanceof DockerNotFoundError ||
            (ownedErr instanceof Error && (ownedErr.name === 'DockerNotFoundError' || ownedErr.message.includes('not found') || ownedErr.message.includes('RESOURCE_NOT_FOUND')))
          ) {
            // Volume not found on host: unlink stale volume metadata and fallback to fresh volume creation
            try {
              removeSignedVolumeMeta(spec.volume.volumeName, pathOptions);
            } catch {}
            isOwnedVolumeResume = false;
          } else {
            throw ownedErr;
          }
        }
      }

      if (!activeHandle) {
        if (!isOwnedVolumeResume && existingVolMeta && spec.volume.volumeId === existingVolMeta.volumeId) {
          const freshVolId = `vol_${randomBytes(16).toString('hex').toLowerCase()}`;
          spec.volume.volumeId = freshVolId;
          spec.labels[VOLUME_ID_LABEL_KEY] = freshVolId;
        }
        activeHandle = await this.adapter.startRuntime(spec, timeoutMs);
      }

      // Save signed volume metadata
      writeSignedVolumeMeta(
        {
          userId: options.userId,
          volumeName: spec.volume.volumeName,
          volumeId: spec.volume.volumeId,
          runId: activeHandle.runId,
        },
        pathOptions
      );
      writtenVolMeta = true;

      // Phase 1: Start persistent bidirectional tunnel with LLM proxy handler if enabled (platform handler deferred to phase 2 binding)
      if (typeof activeHandle.startTunnel === 'function') {
        const tunnelHost = await activeHandle.startTunnel({
          tunnelPort: 8787,
          ...(isLlmEnabled ? { handler: createLlmProxyHandler({ deploymentConfig: dshConfig }) } : {}),
        });
        if (isLlmEnabled) {
          const llmHandler = createLlmProxyHandler({ deploymentConfig: dshConfig });
          tunnelHost.registerHandler(llmHandler);
        }
      }

      // Explicitly verify DaemonTransport is connected or start it
      if (typeof activeHandle.startTransport === 'function' && !activeHandle.transport?.isConnected()) {
        await activeHandle.startTransport();
      }

      // Register cryptographically signed container metadata with REAL 64-hex containerId and matching activeHandle runId & volumeId
      meta = writeSignedContainerMeta(
        {
          userId: options.userId,
          containerName: spec.containerName,
          containerId: activeHandle.containerId,
          image: spec.image,
          volumeName: spec.volume.volumeName,
          volumeId: spec.volume.volumeId,
          labels: {
            ...spec.labels,
            [RUN_ID_LABEL_KEY]: activeHandle.runId,
            [VOLUME_ID_LABEL_KEY]: spec.volume.volumeId,
          },
          runId: activeHandle.runId,
        },
        pathOptions
      );
      writtenContainerMeta = true;
    } catch (setupErr: unknown) {
      if (activeHandle) {
        let dockerTeardownSucceeded = false;
        const cleanupErrors: Error[] = [];
        try {
          // If owned volume resume, NEVER remove the retained volume on container teardown!
          await activeHandle.teardown(!isOwnedVolumeResume);
          dockerTeardownSucceeded = true;
        } catch (teardownErr: unknown) {
          cleanupErrors.push(teardownErr instanceof Error ? teardownErr : new Error(String(teardownErr)));
        }

        // Only if teardown succeeds, remove any partially written metadata
        if (dockerTeardownSucceeded) {
          if (writtenContainerMeta) {
            try {
              removeSignedContainerMeta(spec.containerName, pathOptions);
            } catch (rmMetaErr: unknown) {
              cleanupErrors.push(rmMetaErr instanceof Error ? rmMetaErr : new Error(String(rmMetaErr)));
            }
          }
          if (writtenVolMeta && !isOwnedVolumeResume) {
            try {
              removeSignedVolumeMeta(spec.volume.volumeName, pathOptions);
            } catch (rmVolErr: unknown) {
              cleanupErrors.push(rmVolErr instanceof Error ? rmVolErr : new Error(String(rmVolErr)));
            }
          }
        }

        const primaryErr = setupErr instanceof Error ? setupErr : new Error(String(setupErr));
        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            [primaryErr, ...cleanupErrors],
            'FAIL-CLOSED: Container setup failed after start and cleanup encountered errors'
          );
        }
        throw primaryErr;
      }
      throw setupErr;
    }

    return createUserRuntimeHandle(activeHandle, spec, meta, !isOwnedVolumeResume, pathOptions);
  }

  /**
   * Reconnects to an existing stopped or running container using signed HMAC metadata.
   * Preserves exact 64-hex containerId and volume data without recreating.
   */
  async connectUserRuntime(options: {
    userId: 'alice' | 'bob' | string;
    image?: string;
    repoRoot?: string;
    dataRoot?: string;
    mode?: DemoRunnerMode;
    resourceSuffix?: string;
    timeoutMs?: number;
    llmEnabled?: boolean;
  }): Promise<UserRuntimeHandle> {
    const pathOptions: DemoPathOptions = {
      repoRoot: options.repoRoot,
      dataRoot: options.dataRoot,
      mode: options.mode,
      resourceSuffix: options.resourceSuffix,
    };
    validateResourceSuffix(options.resourceSuffix);
    const paths = getDemoPathConfig(pathOptions);

    const timeoutMs = options.timeoutMs ?? 15000;

    // Fail-closed check: Docker daemon MUST be available
    const isDockerAvailable = await this.client.isDockerAvailable();
    if (!isDockerAvailable) {
      throw new Error(
        'FAIL-CLOSED: Docker daemon is required but unavailable. Cannot fall back to process execution.'
      );
    }

    const suffix = options.resourceSuffix ? `-${options.resourceSuffix}` : '';
    const containerName = `enkeep-demo-${options.userId}${suffix}`;

    // Read verified signed container metadata
    const meta = readSignedContainerMeta(containerName, pathOptions);
    if (!meta) {
      throw new Error(
        `FAIL-CLOSED: Cannot connect to user runtime "${options.userId}": No signed container metadata found`
      );
    }

    if (meta.userId !== options.userId) {
      throw new Error(
        'FAIL-CLOSED: Signed container metadata userId mismatch'
      );
    }

    const spec = this.adapter.createDefaultUserSpec({
      userId: options.userId,
      image: options.image ?? meta.image ?? 'enkeep-demo-runtime:latest',
      nameSuffix: options.resourceSuffix,
      runId: meta.runId,
      volumeId: meta.volumeId,
    });

    const validation = validateContainerSpec(spec);
    if (!validation.valid) {
      throw new Error('FAIL-CLOSED: Container specification validation failed');
    }

    const activeHandle = await this.adapter.connectRuntime(
      spec,
      {
        containerName: meta.containerName,
        containerId: meta.containerId,
        userId: meta.userId,
        runId: meta.runId,
        volumeId: meta.volumeId,
      },
      timeoutMs
    );

    // Phase 1: Start persistent bidirectional tunnel with LLM proxy handler if enabled (platform handler deferred to phase 2 binding)
    if (typeof activeHandle.startTunnel === 'function') {
      const dshConfig = loadDshDeploymentConfig();
      const isLlmEnabled = Boolean(
        options.llmEnabled ??
        (dshConfig && dshConfig.providers && Object.keys(dshConfig.providers).length > 0)
      );
      const tunnelHost = await activeHandle.startTunnel({
        tunnelPort: 8787,
        ...(isLlmEnabled ? { handler: createLlmProxyHandler({ deploymentConfig: dshConfig }) } : {}),
      });
      if (isLlmEnabled) {
        const llmHandler = createLlmProxyHandler({ deploymentConfig: dshConfig });
        tunnelHost.registerHandler(llmHandler);
      }
    }

    // Explicitly verify DaemonTransport is connected or start it
    if (typeof activeHandle.startTransport === 'function' && !activeHandle.transport?.isConnected()) {
      await activeHandle.startTransport();
    }

    return createUserRuntimeHandle(activeHandle, spec, meta, false, pathOptions);
  }

  async listActiveRuntimes(options?: DemoPathOptions | string): Promise<SignedContainerMetadata[]> {
    return listSignedContainers(options);
  }

  async stopUserRuntime(containerName: string, removeVolume = false, options?: DemoPathOptions | string): Promise<void> {
    const meta = readSignedContainerMeta(containerName, options);
    if (!meta) {
      return;
    }

    const runId = meta.runId;
    if (!runId) {
      throw new Error('FAIL-CLOSED: Missing runId for container');
    }

    const existing = await this.client.inspectContainer(meta.containerId);
    const bindMounts = existing?.mounts?.filter((m) => m.type === 'bind' && m.destination.startsWith('/home/dsh/mounts/'));
    const mountsSpec = bindMounts?.map((b) => {
      const id = b.destination.replace('/home/dsh/mounts/', '');
      return {
        id,
        name: id,
        sourcePath: b.source || '',
        mode: (b.rw ? 'rw' : 'ro') as 'rw' | 'ro',
      };
    });

    const expectation = {
      containerName: meta.containerName,
      userId: meta.userId,
      runId,
      containerId: meta.containerId,
      volumeName: meta.volumeName,
      volumeId: meta.volumeId,
      containerPath: '/home/dsh',
      mounts: mountsSpec,
    };

    await this.client.stopContainer(expectation, 2);
    await this.client.removeContainer(expectation, true);
    if (removeVolume && meta.volumeName) {
      const volMeta = readSignedVolumeMeta(meta.volumeName, options);
      const volumeId = volMeta?.volumeId ?? meta.volumeId;
      await this.client.removeVolume({
        volumeName: meta.volumeName,
        userId: meta.userId,
        volumeId,
      });
      removeSignedVolumeMeta(meta.volumeName, options);
    }
    removeSignedContainerMeta(containerName, options);
  }
}

/**
 * Host Runtime Port Adapter implementing RuntimeContainerPort for non-Docker host process execution.
 *
 * Enforces:
 * - Direct host process execution via @enkeep/runtime-runner/host (HostRuntimeAdapter).
 * - Full isolation within <dataRoot>/host-runtimes/<userId> directory.
 * - UDS (Unix Domain Socket) IPC between platform and resident Host RuntimeDaemon.
 * - Loopback LLM proxy support (HostLlmProxyServer) protecting credentials.
 * - Signed process metadata (process.meta.json) and collision non-adoption.
 */
export class HostRuntimePortAdapter implements RuntimeContainerPort {
  private readonly adapter: HostRuntimeAdapter;

  constructor(adapter: HostRuntimeAdapter = new HostRuntimeAdapter()) {
    this.adapter = adapter;
  }

  async startUserRuntime(options: {
    userId: 'alice' | 'bob' | string;
    image?: string;
    repoRoot?: string;
    dataRoot?: string;
    mode?: DemoRunnerMode;
    resourceSuffix?: string;
    timeoutMs?: number;
    llmEnabled?: boolean;
    llmProvider?: string;
    llmModel?: string;
    llmProviders?: string | Record<string, unknown>;
    browserService?: import('@enkeep/platform-core').BrowserService;
    platformProxyOptions?: import('@enkeep/runtime-runner').PlatformProxyOptions;
    platformProxyHandler?: import('@enkeep/runtime-runner').PlatformProxyHandler;
    mounts?: readonly import('@enkeep/platform-core').RuntimeMountSpec[];
  }): Promise<UserRuntimeHandle> {
    const pathOptions: DemoPathOptions = {
      repoRoot: options.repoRoot,
      dataRoot: options.dataRoot,
      mode: options.mode,
      resourceSuffix: options.resourceSuffix,
    };
    validateResourceSuffix(options.resourceSuffix);

    const paths = getDemoPathConfig(pathOptions);
    const timeoutMs = options.timeoutMs ?? 20000;

    const dshConfig = loadDshDeploymentConfig();
    const isLlmConfigured = Boolean(
      dshConfig &&
      dshConfig.providers &&
      Object.keys(dshConfig.providers).length > 0 &&
      dshConfig.tokens &&
      Object.values(dshConfig.tokens).some((t) => t && t.trim().length > 0)
    );

    let isLlmEnabled: boolean;
    if (options.llmEnabled === false || process.env.ENKEEP_LLM_ENABLED === '0') {
      isLlmEnabled = false;
    } else if (options.llmEnabled === true || process.env.ENKEEP_LLM_ENABLED === '1') {
      isLlmEnabled = true;
    } else {
      isLlmEnabled = isLlmConfigured;
    }

    const llmProvider =
      options.llmProvider ||
      dshConfig?.defaultModel?.provider ||
      process.env.ENKEEP_LLM_PROVIDER ||
      'cpa-gemini';

    const llmModel =
      options.llmModel ||
      dshConfig?.defaultModel?.model ||
      process.env.ENKEEP_LLM_MODEL ||
      'gemini-3.7-flash-tiered';

    const inContainerProviders = dshConfig?.providers
      ? createInContainerProvidersSpec(dshConfig.providers)
      : options.llmProviders;

    const runId = generateRunId();
    const storageId = `vol_host_${randomBytes(16).toString('hex').toLowerCase()}`;

    const spec = this.adapter.createDefaultUserSpec({
      userId: options.userId,
      dataRoot: paths.dataRoot,
      runId,
      storageId,
      llmEnabled: isLlmEnabled,
      llmProvider,
      llmModel,
      llmProviders: inContainerProviders,
      browserService: options.browserService,
      platformProxyOptions: options.platformProxyOptions,
      platformProxyHandler: options.platformProxyHandler,
      mounts: options.mounts ? [...options.mounts] : undefined,
    });

    let activeHandle: ActiveRuntimeHandle;
    try {
      activeHandle = await this.adapter.startRuntime(spec, timeoutMs);
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        (err.name === 'HostCollisionError' ||
          (err as any).code === 'HOST_RESOURCE_COLLISION' ||
          err.message.includes('already running'))
      ) {
        try {
          activeHandle = await this.adapter.connectRuntime(spec, timeoutMs);
        } catch (connErr: unknown) {
          if (
            (connErr as any)?.code === 'HOST_NOT_FOUND' ||
            (connErr instanceof Error && connErr.message.includes('no longer alive'))
          ) {
            activeHandle = await this.adapter.startRuntime(spec, timeoutMs);
          } else {
            throw connErr;
          }
        }
      } else {
        throw err;
      }
    }

    const specWrapper = {
      containerName: `host-${options.userId}`,
      userId: options.userId,
      volume: {
        volumeName: `host-storage-${options.userId}`,
        volumeId: storageId,
      },
    };

    return createUserRuntimeHandle(activeHandle, specWrapper, undefined, true, pathOptions);
  }

  async connectUserRuntime(options: {
    userId: 'alice' | 'bob' | string;
    image?: string;
    repoRoot?: string;
    dataRoot?: string;
    mode?: DemoRunnerMode;
    resourceSuffix?: string;
    timeoutMs?: number;
    llmEnabled?: boolean;
  }): Promise<UserRuntimeHandle> {
    const pathOptions: DemoPathOptions = {
      repoRoot: options.repoRoot,
      dataRoot: options.dataRoot,
      mode: options.mode,
      resourceSuffix: options.resourceSuffix,
    };
    validateResourceSuffix(options.resourceSuffix);

    const paths = getDemoPathConfig(pathOptions);
    const timeoutMs = options.timeoutMs ?? 20000;

    const spec = this.adapter.createDefaultUserSpec({
      userId: options.userId,
      dataRoot: paths.dataRoot,
    });

    const activeHandle = await this.adapter.connectRuntime(spec, timeoutMs);

    const specWrapper = {
      containerName: `host-${options.userId}`,
      userId: options.userId,
      volume: {
        volumeName: `host-storage-${options.userId}`,
        volumeId: activeHandle.volumeId || `vol_host_${options.userId}`,
      },
    };

    return createUserRuntimeHandle(activeHandle, specWrapper, undefined, false, pathOptions);
  }

  async listActiveRuntimes(_options?: DemoPathOptions | string): Promise<SignedContainerMetadata[]> {
    return [];
  }

  async stopUserRuntime(containerName: string, removeVolume = false, options?: DemoPathOptions | string): Promise<void> {
    const pathOptions: DemoPathOptions = typeof options === 'string' ? { repoRoot: options } : (options ?? {});
    const paths = getDemoPathConfig(pathOptions);
    const userId = containerName.replace(/^host-/, '');
    const spec = this.adapter.createDefaultUserSpec({
      userId,
      dataRoot: paths.dataRoot,
    });
    await this.adapter.teardownRuntime(spec, removeVolume);
  }
}

/**
 * Storage Provisioning Port
 */
export interface StorageProvisionPort {
  initializeStorage(dbPath: string): Promise<{
    storage: PlatformStorage;
    admin: User;
    user: User;
    disabledUser: User;
    adminContainerSpace: Space;
    bobContainerSpace: Space;
  }>;
}

/**
 * Data Import Port
 */
export interface DataImportPort {
  runMockImport(options: {
    destDir: string;
    demoRoot: string;
    sourceDbFile: string;
    sourceGroupsDir: string;
    userId: string;
    deterministicCreatedAt?: string;
  }): Promise<ImportResult>;
}

/**
 * Integrity Probe Port
 */
export interface IntegrityProbePort {
  probe3000And3080(): Promise<{ port3000: ProbeSnapshot; port3080: ProbeSnapshot }>;
  verifyUnchanged(
    before: { port3000: ProbeSnapshot; port3080: ProbeSnapshot },
    after: { port3000: ProbeSnapshot; port3080: ProbeSnapshot }
  ): { unchanged: boolean; discrepancies: string[] };
}
