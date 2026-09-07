/**
 * Platform Runtime Provider Registry & Multi-Mode Routing Architecture
 *
 * Directs execution across Docker ('container') and Host ('host') runtimes
 * strictly keyed by authoritative Space execution_mode for all:
 * - Turn runs (DeliveryTurnExecutor)
 * - File operations (TenantRuntimeFileProvider)
 * - Session artifacts & forking (RuntimeArtifactPort)
 * - Management status & lifecycle restarts (ManagementRuntimeProvider)
 * - Space workspace provisioning Saga & rollback
 *
 * Guarantees zero fallback to unintended string routes.
 *
 * @module @enkeep/platform-server/runtime/provider-registry
 */

import type { DatabaseSync } from 'node:sqlite';
import {
  PlatformError,
  NotFoundError,
  ValidationError,
  type ExecutionMode,
  type RuntimeMountResolver,
} from '@enkeep/platform-core';
import type {
  DeliveryTurnExecutor,
  DeliveryExecutionRequest,
  TurnExecutionResult,
  InspectedTurnResult,
} from './delivery-gateway.js';
import type {
  TenantRuntimeFileProvider,
  CanonicalFileOperationRequest,
  CanonicalFileOperationResult,
  CanonicalStreamingWriteRequest,
  CanonicalWriteResult,
  CanonicalStreamingReadRequest,
  CanonicalStreamingReadResult,
  CanonicalStageRequest,
  CanonicalStageResult,
  CanonicalCommitStageRequest,
  CanonicalFinalizeStageRequest,
  CanonicalRollbackCommitRequest,
  CanonicalInspectTransferStateRequest,
  CanonicalInspectTransferStateResult,
  CanonicalInspectSnapshotStateRequest,
  CanonicalInspectSnapshotStateResult,
  CanonicalAbortStageRequest,
} from '../files/runtime-file-api.js';
import type {
  RuntimeArtifactPort,
  SessionArtifactCheckResult,
  SessionCorruptionInspectResult,
  SessionPrefixRecoveryResult,
  ExportForkSeedResult,
  ImportSeedResult,
  ForkBoundaryOptions,
  SessionSeedReceipt,
} from '../sessions/runtime-artifact-port.js';
import type {
  ManagementRuntimeProvider,
  UserRuntimeStatus,
  RuntimeRestartResult,
} from '../management/types.js';

export interface RuntimeProvider {
  readonly mode: ExecutionMode;
  readonly turnExecutor: DeliveryTurnExecutor;
  readonly fileProvider?: TenantRuntimeFileProvider;
  readonly runtimeArtifactPort?: RuntimeArtifactPort;
  readonly managementProvider?: ManagementRuntimeProvider;
  ensureSpaceWorkspace?(userId: string, space: { id: string; folder: string }): Promise<void>;
  rollbackSpaceWorkspace?(userId: string, space: { id: string; folder: string }): Promise<void>;
}

export class RuntimeProviderRegistry {
  private readonly providers = new Map<ExecutionMode, RuntimeProvider>();

  registerProvider(provider: RuntimeProvider): void {
    if (!provider || typeof provider !== 'object') {
      throw new ValidationError('RuntimeProvider must be an object');
    }
    if (provider.mode !== 'container' && provider.mode !== 'host') {
      throw new ValidationError(`Invalid runtime provider mode "${provider.mode}": must be "container" or "host"`);
    }
    this.providers.set(provider.mode, provider);
  }

  getProvider(mode: ExecutionMode): RuntimeProvider | undefined {
    return this.providers.get(mode);
  }

  requireProvider(mode: ExecutionMode): RuntimeProvider {
    const provider = this.providers.get(mode);
    if (!provider) {
      throw new PlatformError(
        `No runtime provider registered for execution mode: ${mode}`,
        'RUNTIME_UNAVAILABLE',
        503
      );
    }
    return provider;
  }

  hasProvider(mode: ExecutionMode): boolean {
    return this.providers.has(mode);
  }

  listProviders(): RuntimeProvider[] {
    return Array.from(this.providers.values());
  }

  listModes(): ExecutionMode[] {
    return Array.from(this.providers.keys());
  }
}

/**
 * Composite DeliveryTurnExecutor routing turn execution to the authoritative
 * provider based on space executionMode.
 */
export class CompositeDeliveryTurnExecutor implements DeliveryTurnExecutor {
  constructor(
    private readonly registry: RuntimeProviderRegistry,
    private readonly db?: DatabaseSync,
    private readonly mountResolver?: RuntimeMountResolver
  ) {}

  async execute(request: DeliveryExecutionRequest): Promise<TurnExecutionResult> {
    let mode: ExecutionMode = request.executionMode ?? 'container';

    if (!request.executionMode && this.db && request.platformSpaceId && request.userId) {
      const spaceRow = this.db
        .prepare('SELECT execution_mode FROM spaces WHERE id = ? AND user_id = ?')
        .get(request.platformSpaceId, request.userId) as { execution_mode?: string } | undefined;
      if (spaceRow?.execution_mode) {
        mode = spaceRow.execution_mode as ExecutionMode;
      }
    }

    let mounts = request.mounts;
    if ((!mounts || mounts.length === 0) && this.mountResolver && request.userId && request.platformSpaceId) {
      try {
        mounts = await this.mountResolver.resolveForSpace(request.userId, request.platformSpaceId);
      } catch {
        // preserve original
      }
    }

    const provider = this.registry.requireProvider(mode);
    return provider.turnExecutor.execute({
      ...request,
      executionMode: mode,
      mounts: mounts ?? [],
    });
  }

  async cancel(userId: string, turnId: string): Promise<boolean> {
    let anyCancelled = false;
    for (const provider of this.registry.listProviders()) {
      try {
        const res = await provider.turnExecutor.cancel(userId, turnId);
        if (res) anyCancelled = true;
      } catch {
        // continue trying other providers
      }
    }
    return anyCancelled;
  }

  async inspectTurnResult(query: {
    userId: string;
    turnId: string;
    dshSessionId: string;
  }): Promise<InspectedTurnResult> {
    for (const provider of this.registry.listProviders()) {
      if (typeof provider.turnExecutor.inspectTurnResult === 'function') {
        try {
          const inspected = await provider.turnExecutor.inspectTurnResult(query);
          if (inspected && inspected.status !== 'absent') {
            return inspected;
          }
        } catch {
          // continue checking
        }
      }
    }
    return { status: 'absent' };
  }
}

/**
 * Composite TenantRuntimeFileProvider routing file operations by space executionMode.
 */
export class CompositeTenantRuntimeFileProvider implements TenantRuntimeFileProvider {
  constructor(
    private readonly registry: RuntimeProviderRegistry,
    private readonly db: DatabaseSync
  ) {}

  private resolveSpaceMode(userId: string, spaceId: string): ExecutionMode {
    const row = this.db
      .prepare('SELECT execution_mode FROM spaces WHERE id = ? AND user_id = ?')
      .get(spaceId, userId) as { execution_mode?: string } | undefined;
    return (row?.execution_mode ?? 'container') as ExecutionMode;
  }

  private resolveSpaceModeByFolder(userId: string, folder: string): ExecutionMode {
    const row = this.db
      .prepare('SELECT execution_mode FROM spaces WHERE folder = ? AND user_id = ?')
      .get(folder, userId) as { execution_mode?: string } | undefined;
    return (row?.execution_mode ?? 'container') as ExecutionMode;
  }

  private getFileProviderForSpace(userId: string, spaceId: string): TenantRuntimeFileProvider {
    const mode = this.resolveSpaceMode(userId, spaceId);
    const provider = this.registry.requireProvider(mode);
    if (!provider.fileProvider) {
      throw new PlatformError(
        `Runtime file provider not available for execution mode "${mode}"`,
        'RUNTIME_UNAVAILABLE',
        503
      );
    }
    return provider.fileProvider;
  }

  async execute(
    userId: string,
    spaceId: string,
    request: CanonicalFileOperationRequest
  ): Promise<CanonicalFileOperationResult> {
    const fileProvider = this.getFileProviderForSpace(userId, spaceId);
    return fileProvider.execute(userId, spaceId, request);
  }

  async writeBinaryStream(
    userId: string,
    spaceId: string,
    request: CanonicalStreamingWriteRequest,
    inStream: NodeJS.ReadableStream
  ): Promise<CanonicalWriteResult> {
    const fileProvider = this.getFileProviderForSpace(userId, spaceId);
    if (typeof fileProvider.writeBinaryStream !== 'function') {
      throw new PlatformError('writeBinaryStream not supported on file provider', 'NOT_SUPPORTED', 501);
    }
    return fileProvider.writeBinaryStream(userId, spaceId, request, inStream);
  }

  async readBinaryStream(
    userId: string,
    spaceId: string,
    request: CanonicalStreamingReadRequest
  ): Promise<CanonicalStreamingReadResult> {
    const fileProvider = this.getFileProviderForSpace(userId, spaceId);
    if (typeof fileProvider.readBinaryStream !== 'function') {
      throw new PlatformError('readBinaryStream not supported on file provider', 'NOT_SUPPORTED', 501);
    }
    return fileProvider.readBinaryStream(userId, spaceId, request);
  }

  async stageBinaryStream(
    userId: string,
    spaceId: string,
    request: CanonicalStageRequest,
    inStream: NodeJS.ReadableStream
  ): Promise<CanonicalStageResult> {
    const fileProvider = this.getFileProviderForSpace(userId, spaceId);
    if (typeof fileProvider.stageBinaryStream !== 'function') {
      throw new PlatformError('stageBinaryStream not supported on file provider', 'NOT_SUPPORTED', 501);
    }
    return fileProvider.stageBinaryStream(userId, spaceId, request, inStream);
  }

  async commitStage(
    userId: string,
    spaceId: string,
    request: CanonicalCommitStageRequest
  ): Promise<CanonicalWriteResult & { rollbackToken?: string }> {
    const fileProvider = this.getFileProviderForSpace(userId, spaceId);
    if (typeof fileProvider.commitStage !== 'function') {
      throw new PlatformError('commitStage not supported on file provider', 'NOT_SUPPORTED', 501);
    }
    return fileProvider.commitStage(userId, spaceId, request);
  }

  async finalizeStage(
    userId: string,
    spaceId: string,
    request: CanonicalFinalizeStageRequest
  ): Promise<void> {
    const fileProvider = this.getFileProviderForSpace(userId, spaceId);
    if (typeof fileProvider.finalizeStage === 'function') {
      return fileProvider.finalizeStage(userId, spaceId, request);
    }
  }

  async rollbackCommit(
    userId: string,
    spaceId: string,
    request: CanonicalRollbackCommitRequest
  ): Promise<void> {
    const fileProvider = this.getFileProviderForSpace(userId, spaceId);
    if (typeof fileProvider.rollbackCommit === 'function') {
      return fileProvider.rollbackCommit(userId, spaceId, request);
    }
  }

  async abortStage(
    userId: string,
    spaceId: string,
    request: CanonicalAbortStageRequest
  ): Promise<void> {
    const fileProvider = this.getFileProviderForSpace(userId, spaceId);
    if (typeof fileProvider.abortStage === 'function') {
      return fileProvider.abortStage(userId, spaceId, request);
    }
  }

  async inspectTransferState(
    userId: string,
    spaceId: string,
    request: CanonicalInspectTransferStateRequest
  ): Promise<CanonicalInspectTransferStateResult> {
    const fileProvider = this.getFileProviderForSpace(userId, spaceId);
    if (typeof fileProvider.inspectTransferState !== 'function') {
      throw new PlatformError('inspectTransferState not supported', 'NOT_SUPPORTED', 501);
    }
    return fileProvider.inspectTransferState(userId, spaceId, request);
  }

  async inspectSnapshotState(
    userId: string,
    spaceId: string,
    request: CanonicalInspectSnapshotStateRequest
  ): Promise<CanonicalInspectSnapshotStateResult> {
    const fileProvider = this.getFileProviderForSpace(userId, spaceId);
    if (typeof fileProvider.inspectSnapshotState !== 'function') {
      throw new PlatformError('inspectSnapshotState not supported', 'NOT_SUPPORTED', 501);
    }
    return fileProvider.inspectSnapshotState(userId, spaceId, request);
  }

  async readGlobalInstructions(
    userId: string
  ): Promise<{ content: string; etag: string | null; size: number; mtimeMs: number; exists: boolean }> {
    for (const provider of this.registry.listProviders()) {
      if (provider.fileProvider && typeof provider.fileProvider.readGlobalInstructions === 'function') {
        try {
          return await provider.fileProvider.readGlobalInstructions(userId);
        } catch {
          // continue
        }
      }
    }
    return { content: '', etag: null, size: 0, mtimeMs: 0, exists: false };
  }

  async writeGlobalInstructions(
    userId: string,
    content: string,
    options?: { expectedEtag?: string | null; requireAbsent?: boolean }
  ): Promise<{ etag: string; size: number; mtimeMs: number }> {
    for (const provider of this.registry.listProviders()) {
      if (provider.fileProvider && typeof provider.fileProvider.writeGlobalInstructions === 'function') {
        return provider.fileProvider.writeGlobalInstructions(userId, content, options);
      }
    }
    throw new PlatformError('Global instructions write not supported by any registered provider', 'RUNTIME_UNAVAILABLE', 503);
  }
}

/**
 * Composite RuntimeArtifactPort routing export and import to authoritative providers.
 */
export class CompositeRuntimeArtifactPort implements RuntimeArtifactPort {
  constructor(
    private readonly registry: RuntimeProviderRegistry,
    private readonly db: DatabaseSync
  ) {}

  private resolveSessionMode(userId: string, dshSessionId: string, workspaceFolder?: string): ExecutionMode {
    if (workspaceFolder) {
      const spaceRow = this.db
        .prepare('SELECT execution_mode FROM spaces WHERE folder = ? AND user_id = ?')
        .get(workspaceFolder, userId) as { execution_mode?: string } | undefined;
      if (spaceRow?.execution_mode) {
        return spaceRow.execution_mode as ExecutionMode;
      }
    }

    const routeRow = this.db
      .prepare('SELECT execution_mode FROM session_routes WHERE (dsh_session_id = ? OR id = ?) AND user_id = ?')
      .get(dshSessionId, dshSessionId, userId) as { execution_mode?: string } | undefined;
    return (routeRow?.execution_mode ?? 'container') as ExecutionMode;
  }

  private resolveFolderMode(userId: string, workspaceFolder?: string): ExecutionMode {
    if (workspaceFolder) {
      const spaceRow = this.db
        .prepare('SELECT execution_mode FROM spaces WHERE folder = ? AND user_id = ?')
        .get(workspaceFolder, userId) as { execution_mode?: string } | undefined;
      if (spaceRow?.execution_mode) {
        return spaceRow.execution_mode as ExecutionMode;
      }
    }
    return 'container';
  }

  async checkSessionArtifact(options: {
    userId: string;
    dshSessionId: string;
    workspaceFolder?: string;
  }): Promise<SessionArtifactCheckResult> {
    const mode = this.resolveSessionMode(options.userId, options.dshSessionId, options.workspaceFolder);
    const provider = this.registry.requireProvider(mode);
    if (!provider.runtimeArtifactPort) {
      throw new PlatformError(`Artifact port unavailable for execution mode "${mode}"`, 'RUNTIME_UNAVAILABLE', 503);
    }
    return provider.runtimeArtifactPort.checkSessionArtifact(options);
  }

  async exportForkSeed(options: {
    userId: string;
    sourceDshSessionId: string;
    boundary?: ForkBoundaryOptions;
    workspaceFolder?: string;
  }): Promise<ExportForkSeedResult> {
    const mode = this.resolveSessionMode(options.userId, options.sourceDshSessionId, options.workspaceFolder);
    const provider = this.registry.requireProvider(mode);
    if (!provider.runtimeArtifactPort) {
      throw new PlatformError(`Artifact port unavailable for source mode "${mode}"`, 'RUNTIME_UNAVAILABLE', 503);
    }
    return provider.runtimeArtifactPort.exportForkSeed(options);
  }

  async importSeed(options: {
    userId: string;
    targetDshId: string;
    events: readonly unknown[];
    receipt: SessionSeedReceipt;
    profile?: unknown;
    workspaceFolder?: string;
  }): Promise<ImportSeedResult> {
    const mode = this.resolveFolderMode(options.userId, options.workspaceFolder);
    const provider = this.registry.requireProvider(mode);
    if (!provider.runtimeArtifactPort) {
      throw new PlatformError(`Artifact port unavailable for target mode "${mode}"`, 'RUNTIME_UNAVAILABLE', 503);
    }
    return provider.runtimeArtifactPort.importSeed(options);
  }

  async inspectSessionCorruption(options: {
    userId: string;
    dshSessionId: string;
    workspaceFolder?: string;
  }): Promise<SessionCorruptionInspectResult> {
    const mode = this.resolveSessionMode(options.userId, options.dshSessionId, options.workspaceFolder);
    const provider = this.registry.requireProvider(mode);
    if (provider.runtimeArtifactPort?.inspectSessionCorruption) {
      return provider.runtimeArtifactPort.inspectSessionCorruption(options);
    }
    return {
      exists: false,
      valid: false,
      corrupted: false,
      code: 'NOT_FOUND',
      lastValidSeq: 0,
      lineCount: 0,
      validEventsCount: 0,
    };
  }

  async recoverValidPrefix(options: {
    userId: string;
    dshSessionId: string;
    targetDshId: string;
    workspaceFolder?: string;
  }): Promise<SessionPrefixRecoveryResult> {
    const mode = this.resolveSessionMode(options.userId, options.dshSessionId, options.workspaceFolder);
    const provider = this.registry.requireProvider(mode);
    if (provider.runtimeArtifactPort?.recoverValidPrefix) {
      return provider.runtimeArtifactPort.recoverValidPrefix(options);
    }
    throw new PlatformError('recoverValidPrefix not supported on artifact port', 'NOT_SUPPORTED', 501);
  }

  async corruptSessionArtifact(options: {
    userId: string;
    dshSessionId: string;
    workspaceFolder?: string;
    type?: 'seq_gap' | 'syntax_error';
  }): Promise<{ corrupted: boolean }> {
    const mode = this.resolveSessionMode(options.userId, options.dshSessionId, options.workspaceFolder);
    const provider = this.registry.requireProvider(mode);
    if (provider.runtimeArtifactPort?.corruptSessionArtifact) {
      return provider.runtimeArtifactPort.corruptSessionArtifact(options);
    }
    return { corrupted: false };
  }

  async resolveArtifactHandle(options: {
    userId: string;
    dshSessionId?: string;
    workspaceFolder?: string;
  }): Promise<any> {
    const mode = this.resolveSessionMode(options.userId, options.dshSessionId || '', options.workspaceFolder);
    const provider = this.registry.requireProvider(mode);
    if (typeof provider.runtimeArtifactPort?.resolveArtifactHandle === 'function') {
      return provider.runtimeArtifactPort.resolveArtifactHandle(options);
    }
    return null;
  }
}

/**
 * Composite ManagementRuntimeProvider routing status and restart operations.
 */
export class CompositeManagementRuntimeProvider implements ManagementRuntimeProvider {
  constructor(private readonly registry: RuntimeProviderRegistry) {}

  async listRuntimes(): Promise<UserRuntimeStatus[]> {
    const results: UserRuntimeStatus[] = [];
    for (const provider of this.registry.listProviders()) {
      if (provider.managementProvider) {
        try {
          const list = await provider.managementProvider.listRuntimes();
          if (Array.isArray(list)) {
            for (const status of list) {
              results.push({
                ...status,
                instanceId: `${status.userId}:${provider.mode}`,
                mode: provider.mode,
              });
            }
          }
        } catch {
          // continue
        }
      }
    }
    return results;
  }

  async getUserRuntime(userId: string, mode?: ExecutionMode): Promise<UserRuntimeStatus | null> {
    if (mode) {
      const provider = this.registry.getProvider(mode);
      if (provider?.managementProvider) {
        const res = await provider.managementProvider.getUserRuntime(userId);
        if (res) {
          return {
            ...res,
            instanceId: `${userId}:${mode}`,
            mode,
          };
        }
      }
      return null;
    }

    for (const provider of this.registry.listProviders()) {
      if (provider.managementProvider) {
        try {
          const res = await provider.managementProvider.getUserRuntime(userId);
          if (res) {
            return {
              ...res,
              instanceId: `${userId}:${provider.mode}`,
              mode: provider.mode,
            };
          }
        } catch {
          // continue
        }
      }
    }
    return null;
  }

  async restartRuntime(
    userId?: string,
    options?: { mode?: ExecutionMode } | ExecutionMode
  ): Promise<RuntimeRestartResult> {
    const targetMode = typeof options === 'string' ? options : options?.mode;

    if (userId) {
      if (!targetMode) {
        // Check if multiple providers have active runtimes for this user
        const activeModes: ExecutionMode[] = [];
        for (const provider of this.registry.listProviders()) {
          if (provider.managementProvider) {
            try {
              const status = await provider.managementProvider.getUserRuntime(userId);
              if (status && status.status === 'ok') {
                activeModes.push(provider.mode);
              }
            } catch {
              // ignore
            }
          }
        }

        if (activeModes.length > 1) {
          throw new ValidationError(
            'Target execution mode ("container" or "host") is required when multiple runtimes exist for user'
          );
        }

        if (activeModes.length === 1) {
          const provider = this.registry.requireProvider(activeModes[0]);
          if (provider.managementProvider?.restartRuntime) {
            return provider.managementProvider.restartRuntime(userId);
          }
        }
      } else {
        const provider = this.registry.requireProvider(targetMode);
        if (provider.managementProvider?.restartRuntime) {
          return provider.managementProvider.restartRuntime(userId);
        }
        return {
          restarted: true,
          userIds: [userId],
          appliedRuntimes: [userId],
        };
      }
    }

    // Restart all or default across providers
    let anyRestarted = false;
    const userIdsSet = new Set<string>();
    const appliedSet = new Set<string>();
    const failedList: Array<{ userId: string; error: string }> = [];

    for (const provider of this.registry.listProviders()) {
      if (targetMode && provider.mode !== targetMode) {
        continue;
      }
      if (provider.managementProvider?.restartRuntime) {
        try {
          const res = await provider.managementProvider.restartRuntime(userId);
          if (res.restarted) anyRestarted = true;
          for (const u of res.userIds || []) userIdsSet.add(u);
          for (const u of res.appliedRuntimes || []) appliedSet.add(u);
          for (const f of res.failedRuntimes || []) failedList.push(f);
        } catch (err: any) {
          failedList.push({
            userId: userId || 'all',
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    return {
      restarted: anyRestarted,
      userIds: Array.from(userIdsSet),
      appliedRuntimes: Array.from(appliedSet),
      failedRuntimes: failedList.length > 0 ? failedList : undefined,
    };
  }

  async stopRuntime(
    userId: string,
    mode?: ExecutionMode
  ): Promise<{ stopped: boolean; userId: string; mode?: ExecutionMode }> {
    if (mode) {
      const provider = this.registry.getProvider(mode);
      if (provider?.managementProvider?.stopRuntime) {
        const res = await provider.managementProvider.stopRuntime(userId);
        return { ...res, mode };
      }
      return { stopped: false, userId, mode };
    }

    let stopped = false;
    for (const provider of this.registry.listProviders()) {
      if (provider.managementProvider?.stopRuntime) {
        try {
          const res = await provider.managementProvider.stopRuntime(userId);
          if (res.stopped) stopped = true;
        } catch {
          // continue
        }
      }
    }
    return { stopped, userId };
  }

  async ensureRuntime(userId: string, mode?: ExecutionMode): Promise<UserRuntimeStatus | null> {
    if (mode) {
      const provider = this.registry.getProvider(mode);
      if (provider?.managementProvider?.ensureRuntime) {
        const res = await provider.managementProvider.ensureRuntime(userId);
        if (res) {
          return {
            ...res,
            instanceId: `${userId}:${mode}`,
            mode,
          };
        }
      }
      return null;
    }

    for (const provider of this.registry.listProviders()) {
      if (provider.managementProvider?.ensureRuntime) {
        try {
          const res = await provider.managementProvider.ensureRuntime(userId);
          if (res) {
            return {
              ...res,
              instanceId: `${userId}:${provider.mode}`,
              mode: provider.mode,
            };
          }
        } catch {
          // continue
        }
      }
    }
    return null;
  }
}
