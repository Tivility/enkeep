/**
 * Unified Runtime Execution Provider & Handle Interfaces
 *
 * Defines the contract boundaries for both Docker (containerized) and Host (local OS process)
 * execution modes in Enkeep with strict static type safety (zero `any`).
 *
 * @module @enkeep/runtime-runner/spec/provider
 */

import type { RuntimeContainerSpec } from './types.js';
import type { HostRuntimeSpec } from '../host/types.js';
import type { ExecCliEnvelope } from '../runtime/exec-cli.js';
import type {
  FileOperationRequest,
  FileOperationResult,
  FileInspectTransferStateResult,
  FileInspectTransferStateOptions,
} from '../runtime/file-ops.js';
import type { RuntimeTurnRequest } from '@enkeep/protocol';
import type {
  RuntimeDaemonTransportPort,
  RuntimeHealthStatus,
} from '../transport/types.js';
import type { TunnelHost } from '../tunnel/host.js';
import type { TunnelHostOptions } from '../tunnel/types.js';
import type { DaemonDockerTransportOptions } from '../transport/daemon-transport.js';
import type { HostDaemonTransportOptions } from '../host/transport.js';
import type { HostPlatformProxyPort } from '../host/types.js';
import type { PlatformProxyHandler } from '../tunnel/platform-proxy.js';

export type RuntimeExecutionMode = 'docker' | 'host';

export type RuntimeSpec = RuntimeContainerSpec | HostRuntimeSpec;

// --- Error Hierarchy for Host Runtime Execution ---

export class HostOwnershipError extends Error {
  readonly code = 'HOST_OWNERSHIP_VIOLATION';
  constructor(message = 'Host runtime ownership or path containment violation') {
    super(`Host Safety Violation: ${message}`);
    this.name = 'HostOwnershipError';
  }
}

export class HostCollisionError extends Error {
  readonly code = 'HOST_RESOURCE_COLLISION';
  constructor(message = 'Host runtime process collision detected') {
    super(`Host Safety Violation: Collision detected: ${message}`);
    this.name = 'HostCollisionError';
  }
}

export class HostDaemonError extends Error {
  readonly code: string = 'HOST_DAEMON_ERROR';
  constructor(message = 'Host runtime daemon error', public readonly cause?: unknown) {
    super(`Host daemon error: ${message}`);
    this.name = 'HostDaemonError';
  }
}

export class HostRuntimeExitedError extends HostDaemonError {
  override readonly code: string = 'HOST_RUNTIME_EXITED';
  constructor(message = 'Host runtime daemon process exited unexpectedly', cause?: unknown) {
    super(message, cause);
    this.name = 'HostRuntimeExitedError';
  }
}

export class HostTransportError extends HostDaemonError {
  override readonly code: string = 'HOST_TRANSPORT_ERROR';
  constructor(message = 'Host daemon transport communication error', cause?: unknown) {
    super(message, cause);
    this.name = 'HostTransportError';
  }
}

export class HostNotFoundError extends Error {
  readonly code = 'HOST_NOT_FOUND';
  constructor(message = 'Host runtime process or resource not found') {
    super(`Host resource not found: ${message}`);
    this.name = 'HostNotFoundError';
  }
}

export type CommonTransportOptions = DaemonDockerTransportOptions | HostDaemonTransportOptions;

/**
 * Common Active Runtime Handle interface implemented by both Docker and Host adapters.
 */
export interface ActiveRuntimeHandle {
  readonly spec: RuntimeSpec;
  /** Full container ID (Docker 64-hex) or host process identifier (`host-proc-<pid>-<runId>`) */
  readonly containerId: string;
  /** Random run identifier */
  readonly runId: string;
  /** Stable storage/volume identifier */
  readonly volumeId: string;
  /** Whether this handle newly created the runtime (true) or reconnected to an existing one (false) */
  readonly isCreated: boolean;
  /** Host runtime PID if running in host mode */
  readonly pid?: number;
  /** Active tunnel host instance, if started */
  readonly tunnel?: TunnelHost;
  /** Active persistent daemon transport instance, if started */
  readonly transport?: RuntimeDaemonTransportPort;
  /** Active host loopback proxy server, if started */
  readonly proxyServer?: unknown;
  /** Active host platform proxy server, if started */
  readonly platformProxyServer?: HostPlatformProxyPort;
  /** Sets or updates the platform proxy handler on the loopback proxy */
  setPlatformProxyHandler?(handler: PlatformProxyHandler | null): void;
  /** Starts or retrieves the persistent bidirectional tunnel */
  startTunnel?(options?: TunnelHostOptions): Promise<TunnelHost>;
  /** Starts or retrieves the persistent daemon transport */
  startTransport?(options?: CommonTransportOptions): Promise<RuntimeDaemonTransportPort>;
  checkHealth(): Promise<RuntimeHealthStatus>;
  sendFollowup(request: RuntimeTurnRequest): Promise<ExecCliEnvelope>;
  checkSessionArtifact?(sessionId: string, workspaceFolder?: string): Promise<ExecCliEnvelope>;
  inspectSessionCorruption?(sessionId: string, workspaceFolder?: string): Promise<ExecCliEnvelope>;
  recoverSessionPrefix?(options: {
    sourceSessionId: string;
    targetSessionId: string;
    workspaceFolder?: string;
    maxValidSeq?: number;
  }): Promise<ExecCliEnvelope>;
  exportForkSeed?(
    sessionId: string,
    boundary?: { fromMessageId?: string; fromTurnId?: string },
    workspaceFolder?: string
  ): Promise<ExecCliEnvelope>;
  importSeed(
    sessionId: string,
    seed: readonly unknown[],
    receipt?: unknown,
    profile?: unknown,
    spaceId?: string
  ): Promise<ExecCliEnvelope>;
  cancelTurn(turnId: string): Promise<ExecCliEnvelope>;
  inspectTurn?(turnId: string): Promise<ExecCliEnvelope>;
  fileOperation(request: FileOperationRequest): Promise<ExecCliEnvelope>;
  instructionsRead?(request: {
    target: 'global' | 'space';
    spaceFolder?: string;
    filename?: string;
  }): Promise<ExecCliEnvelope>;
  instructionsWrite?(request: {
    target: 'global' | 'space';
    content: string;
    spaceFolder?: string;
    filename?: string;
    expectedEtag?: string | null;
    requireAbsent?: boolean;
  }): Promise<ExecCliEnvelope>;
  fileWriteStream?(
    options: {
      space: string;
      path: string;
      expectedEtag?: string;
      requireAbsent?: boolean;
      maxSizeBytes?: number;
    },
    inStream: NodeJS.ReadableStream
  ): Promise<ExecCliEnvelope>;
  fileReadStream?(
    options: {
      space: string;
      path: string;
      range?: { start: number; end: number };
    }
  ): Promise<{ metadata: FileOperationResult; stream: NodeJS.ReadableStream }>;
  fileStageStream?(
    options: {
      space: string;
      path: string;
      maxSizeBytes?: number;
    },
    inStream: NodeJS.ReadableStream
  ): Promise<{ stageToken: string; space: string; path: string; size: number; sha256: string; etag: string }>;
  fileCommitStage?(
    options: {
      space: string;
      path: string;
      stageToken: string;
      rollbackToken?: string;
      expectedEtag?: string;
      requireAbsent?: boolean;
    }
  ): Promise<FileOperationResult>;
  fileAbortStage?(
    options: {
      space: string;
      path: string;
      stageToken: string;
    }
  ): Promise<void>;
  fileFinalizeStage?(
    options: {
      space: string;
      path: string;
      rollbackToken?: string;
    }
  ): Promise<void>;
  fileRollbackCommit?(
    options: {
      space: string;
      path: string;
      rollbackToken?: string;
      stageToken?: string;
      expectedEtag?: string;
    }
  ): Promise<void>;
  fileInspectTransferState?(
    options: FileInspectTransferStateOptions
  ): Promise<FileInspectTransferStateResult>;
  stop(): Promise<void>;
  teardown(removeStorage?: boolean): Promise<void>;
}

/**
 * Universal Runtime Execution Provider interface with strict typing.
 */
export interface RuntimeExecutionProvider<
  TSpec extends RuntimeSpec = RuntimeSpec,
  THandle extends ActiveRuntimeHandle = ActiveRuntimeHandle
> {
  readonly kind: RuntimeExecutionMode;
  startRuntime(spec: TSpec, startupTimeoutMs?: number): Promise<THandle>;
  connectRuntime?(spec: TSpec, startupTimeoutMs?: number): Promise<THandle>;
  startRuntimeWithOwnedStorage?(spec: TSpec, startupTimeoutMs?: number): Promise<THandle>;
  startRuntimeWithOwnedVolume?(spec: TSpec, startupTimeoutMs?: number): Promise<THandle>;
}
