/**
 * Host Runtime Execution Adapter
 *
 * Implements the official RuntimeExecutionProvider for local OS process execution.
 * Manages per-user resident RuntimeDaemon processes, signed PID metadata tracking,
 * Unix domain socket IPC, loopback LLM proxy tunneling, and graceful process tree termination.
 *
 * @module @enkeep/runtime-runner/host/adapter
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type {
  ActiveRuntimeHandle,
  RuntimeExecutionProvider,
} from '../spec/provider.js';
import {
  HostOwnershipError,
  HostCollisionError,
  HostNotFoundError,
  HostDaemonError,
  HostRuntimeExitedError,
  HostTransportError,
} from '../spec/provider.js';
import type {
  HostRuntimeSpec,
  HostUserSpecOptions,
  HostProcessMetadata,
  HostRuntimeAdapterOptions,
} from './types.js';
import {
  validateHostRuntimePaths,
  filterHostEnvironment,
  isPathContained,
} from './security.js';
import {
  writeProcessMeta,
  readProcessMeta,
  isProcessAlive,
  getProcessStartTime,
  cleanStaleProcess,
  killProcessTree,
  DEFAULT_SECRET_KEY,
} from './process-registry.js';
import { HostDaemonTransport } from './transport.js';
import { HostLlmProxyServer } from './llm-proxy-server.js';
import { HostPlatformProxyServer } from './platform-proxy-server.js';
import type { PlatformProxyHandler } from '../tunnel/platform-proxy.js';
import {
  hostWriteStream,
  hostReadStream,
  hostStageStream,
  hostCommitStage,
  hostAbortStage,
  hostFinalizeStage,
  hostRollbackCommit,
  hostInspectTransferState,
} from './file-streaming.js';
import type { RuntimeTurnRequest } from '@enkeep/protocol';
import type { ExecCliEnvelope } from '../runtime/exec-cli.js';
import type { FileOperationRequest } from '../runtime/file-ops.js';
import type { RuntimeHealthStatus } from '../transport/types.js';
import { DaemonProtocolError } from '../runtime/daemon-protocol.js';

function resolveDefaultCliPath(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);

  const distCandidate = path.resolve(currentDir, '..', '..', 'dist', 'runtime', 'daemon-cli.js');
  if (fs.existsSync(distCandidate)) {
    return distCandidate;
  }

  const distRelative = path.resolve(process.cwd(), 'packages', 'runtime-runner', 'dist', 'runtime', 'daemon-cli.js');
  if (fs.existsSync(distRelative)) {
    return distRelative;
  }

  const directDist = path.resolve(currentDir, '..', 'runtime', 'daemon-cli.js');
  if (fs.existsSync(directDist)) {
    return directDist;
  }

  return path.resolve(currentDir, '..', 'runtime', 'daemon-cli.js');
}

export class HostRuntimeAdapter implements RuntimeExecutionProvider<HostRuntimeSpec, ActiveRuntimeHandle> {
  readonly kind = 'host' as const;

  private readonly daemonCliPath: string;
  private readonly secretKey: string;

  constructor(options: HostRuntimeAdapterOptions = {}) {
    this.daemonCliPath = options.daemonCliPath || resolveDefaultCliPath();
    this.secretKey = options.secretKey || DEFAULT_SECRET_KEY;
  }

  /**
   * Generates a compliant HostRuntimeSpec for a user under the controlled data root.
   */
  public createDefaultUserSpec(options: HostUserSpecOptions): HostRuntimeSpec {
    const userId = options.userId;
    if (!userId || typeof userId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(userId)) {
      throw new HostOwnershipError(`Invalid userId: "${userId}"`);
    }

    if (!options.dataRoot || !path.isAbsolute(options.dataRoot)) {
      throw new HostOwnershipError('dataRoot must be a non-empty absolute path');
    }

    const dataRoot = path.resolve(options.dataRoot);
    const userRoot = path.join(dataRoot, 'host-runtimes', userId);
    const dshHome = path.join(userRoot, '.dsh');
    const spacesDir = path.join(userRoot, 'spaces');
    const runDir = path.join(userRoot, 'run');
    const defaultSocketPath = path.join(runDir, 'daemon.sock');
    let socketPath = defaultSocketPath;
    if (defaultSocketPath.length > 90) {
      const hash = crypto.createHash('sha256').update(runDir).digest('hex').slice(0, 16);
      socketPath = `/tmp/ek_${hash}.sock`;
    }

    const runId = options.runId || `run_${crypto.randomBytes(16).toString('hex')}`;
    const storageId = options.storageId || `vol_${crypto.randomBytes(16).toString('hex')}`;

    const spec: HostRuntimeSpec = {
      executionMode: 'host',
      userId,
      runId,
      storageId,
      dataRoot,
      dshHome,
      spacesDir,
      runDir,
      socketPath,
      llmEnabled: options.llmEnabled,
      llmProvider: options.llmProvider || 'cpa-gemini',
      llmModel: options.llmModel || 'gemini-3.7-flash-tiered',
      llmProviders: options.llmProviders,
      llmBaseUrl: options.llmBaseUrl,
      llmProxyToken: options.llmProxyToken,
      platformBaseUrl: options.platformBaseUrl,
      platformProxyToken: options.platformProxyToken,
      platformProxyOptions: options.platformProxyOptions,
      platformProxyHandler: options.platformProxyHandler,
      browserService: options.browserService,
      platformUserId: options.platformUserId,
      maxAgents: options.maxAgents ?? 16,
      idleAgentTimeoutMs: options.idleAgentTimeoutMs ?? 1_800_000,
      maxConcurrentSessions: options.maxConcurrentSessions ?? 4,
      mounts: options.mounts,
      environment: options.extraEnv || {},
    };

    validateHostRuntimePaths(spec);
    return spec;
  }

  /**
   * Starts a resident Host RuntimeDaemon child process for the given spec.
   * Enforces collision non-adoption (fails closed if a live process is already running).
   */
  public async startRuntime(
    spec: HostRuntimeSpec,
    startupTimeoutMs = 20_000
  ): Promise<ActiveRuntimeHandle> {
    validateHostRuntimePaths(spec);

    const metaPath = path.join(spec.runDir, 'process.meta.json');
    const existingMeta = readProcessMeta(metaPath, this.secretKey);

    if (existingMeta) {
      if (isProcessAlive(existingMeta.pid)) {
        throw new HostCollisionError(
          `Host runtime daemon already running for user "${spec.userId}" (PID ${existingMeta.pid}). Re-creation refused.`
        );
      } else {
        // Stale process cleanup
        cleanStaleProcess(spec.runDir);
      }
    }

    // Ensure directory structure exists with mode 0700
    fs.mkdirSync(spec.dshHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(spec.spacesDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(spec.runDir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(spec.runDir, 0o700);
    } catch {}

    let llmProxyServer: HostLlmProxyServer | undefined;
    let effectiveLlmBaseUrl = spec.llmBaseUrl;
    let llmProxyToken = spec.llmProxyToken;

    if (spec.llmEnabled && !effectiveLlmBaseUrl) {
      llmProxyServer = new HostLlmProxyServer();
      effectiveLlmBaseUrl = await llmProxyServer.start();
      llmProxyToken = llmProxyServer.getAuthToken();
    }

    let platformProxyServer: HostPlatformProxyServer | undefined;
    let effectivePlatformBaseUrl = spec.platformBaseUrl;
    let platformProxyToken = spec.platformProxyToken;

    if (!effectivePlatformBaseUrl) {
      platformProxyServer = new HostPlatformProxyServer({
        handler: spec.platformProxyHandler,
        platformProxyOptions: spec.platformProxyOptions,
      });
      effectivePlatformBaseUrl = await platformProxyServer.start();
      platformProxyToken = platformProxyServer.getAuthToken();
    }

    let effectiveLlmProviders = spec.llmProviders;
    if (effectiveLlmBaseUrl && typeof spec.llmProviders === 'object' && spec.llmProviders !== null) {
      const updatedProviders: Record<string, unknown> = {};
      for (const [pKey, pVal] of Object.entries(spec.llmProviders)) {
        updatedProviders[pKey] = {
          ...(typeof pVal === 'object' && pVal !== null ? pVal : {}),
          baseURL: `${effectiveLlmBaseUrl.replace(/\/+$/, '')}/${pKey}`,
          apiKeyEnv: 'IN_CONTAINER_PLACEHOLDER',
        };
      }
      effectiveLlmProviders = updatedProviders;
    }

    const effSpec: HostRuntimeSpec = {
      ...spec,
      llmBaseUrl: effectiveLlmBaseUrl,
      llmProxyToken,
      llmProviders: effectiveLlmProviders,
      platformBaseUrl: effectivePlatformBaseUrl,
      platformProxyToken,
    };

    const filteredEnv = filterHostEnvironment(effSpec);

    // Spawn child process
    const child = spawn(process.execPath, [this.daemonCliPath, 'daemon'], {
      cwd: effSpec.dshHome,
      env: filteredEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });

    let stderrChunks = '';
    if (child.stderr) {
      child.stderr.on('data', (d) => {
        stderrChunks += d.toString();
      });
    }

    if (!child.pid) {
      if (llmProxyServer) await llmProxyServer.close();
      if (platformProxyServer) await platformProxyServer.close();
      throw new HostDaemonError('Failed to spawn host runtime daemon process');
    }

    const childPid = child.pid;
    child.unref();

    child.on('exit', () => {
      transport.close().catch(() => {});
    });

    // Record signed process metadata
    const startTime = getProcessStartTime(childPid) || Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    writeProcessMeta(
      metaPath,
      {
        pid: childPid,
        startTime,
        nonce,
        userId: effSpec.userId,
        runId: effSpec.runId,
        storageId: effSpec.storageId,
        paths: {
          dshHome: effSpec.dshHome,
          spacesDir: effSpec.spacesDir,
          runDir: effSpec.runDir,
          socketPath: effSpec.socketPath,
        },
      },
      this.secretKey
    );

    const transport = new HostDaemonTransport({
      socketPath: effSpec.socketPath,
    });

    const handle = this.createActiveRuntimeHandle(effSpec, childPid, transport, llmProxyServer, platformProxyServer, true);

    // Wait for health check readiness
    const start = Date.now();
    let isHealthy = false;
    let lastError: unknown;

    while (Date.now() - start < startupTimeoutMs) {
      if (!isProcessAlive(childPid)) {
        lastError = new HostDaemonError(
          `Host daemon child process exited prematurely during startup. Output: ${stderrChunks}`
        );
        break;
      }

      try {
        await transport.start(1000);
        const health = await transport.checkHealth();
        if (health && health.dshReady === true && (health.status === 'ok' || health.status === 'degraded')) {
          isHealthy = true;
          break;
        }
      } catch (err: unknown) {
        lastError = err;
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    if (!isHealthy) {
      try {
        await handle.stop();
      } catch {}
      throw (
        (lastError instanceof Error ? lastError : null) ||
        new HostDaemonError('Host runtime daemon failed to reach healthy status within deadline')
      );
    }

    return handle;
  }

  /**
   * Alias for starting runtime with owned storage.
   */
  public async startRuntimeWithOwnedStorage(
    spec: HostRuntimeSpec,
    startupTimeoutMs = 20_000
  ): Promise<ActiveRuntimeHandle> {
    return this.startRuntime(spec, startupTimeoutMs);
  }

  public async startRuntimeWithOwnedVolume(
    spec: HostRuntimeSpec,
    startupTimeoutMs = 20_000
  ): Promise<ActiveRuntimeHandle> {
    return this.startRuntime(spec, startupTimeoutMs);
  }

  /**
   * Reconnects to an existing resident Host RuntimeDaemon process.
   */
  public async connectRuntime(
    spec: HostRuntimeSpec,
    startupTimeoutMs = 20_000
  ): Promise<ActiveRuntimeHandle> {
    validateHostRuntimePaths(spec);

    const metaPath = path.join(spec.runDir, 'process.meta.json');
    const existingMeta = readProcessMeta(metaPath, this.secretKey);

    if (!existingMeta) {
      throw new HostNotFoundError(
        `No running host runtime daemon metadata found for user "${spec.userId}"`
      );
    }

    if (!isProcessAlive(existingMeta.pid)) {
      cleanStaleProcess(spec.runDir, existingMeta.paths?.socketPath);
      throw new HostNotFoundError(
        `Host runtime daemon process for user "${spec.userId}" (PID ${existingMeta.pid}) is no longer alive`
      );
    }

    const transport = new HostDaemonTransport({
      socketPath: spec.socketPath,
    });

    const handle = this.createActiveRuntimeHandle(spec, existingMeta.pid, transport, undefined, undefined, false);

    // Verify health
    const start = Date.now();
    let isHealthy = false;
    let lastError: unknown;

    while (Date.now() - start < startupTimeoutMs) {
      if (!isProcessAlive(existingMeta.pid)) {
        cleanStaleProcess(spec.runDir, existingMeta.paths?.socketPath);
        throw new HostNotFoundError(
          `Host runtime daemon process for user "${spec.userId}" (PID ${existingMeta.pid}) died during reconnect`
        );
      }

      try {
        await transport.start(1000);
        const health = await transport.checkHealth();
        if (health && health.dshReady === true) {
          isHealthy = true;
          break;
        }
      } catch (err: unknown) {
        lastError = err;
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    if (!isHealthy) {
      cleanStaleProcess(spec.runDir, existingMeta.paths?.socketPath);
      throw (
        (lastError instanceof Error ? lastError : null) ||
        new HostDaemonError('Host runtime daemon failed health check on reconnect')
      );
    }

    return handle;
  }

  public async inspectRuntime(specOrUserId: string | HostRuntimeSpec): Promise<HostProcessMetadata | null> {
    let runDir: string;
    if (typeof specOrUserId === 'string') {
      runDir = specOrUserId;
    } else {
      runDir = specOrUserId.runDir;
    }

    const metaPath = path.join(runDir, 'process.meta.json');
    return readProcessMeta(metaPath, this.secretKey);
  }

  public async stopRuntime(spec: HostRuntimeSpec): Promise<void> {
    const metaPath = path.join(spec.runDir, 'process.meta.json');
    const meta = readProcessMeta(metaPath, this.secretKey);
    if (meta && isProcessAlive(meta.pid)) {
      await killProcessTree(meta.pid, 3000);
    }
    cleanStaleProcess(spec.runDir);
  }

  public async teardownRuntime(spec: HostRuntimeSpec, removeStorage = false): Promise<void> {
    await this.stopRuntime(spec);
    if (removeStorage) {
      const userRoot = path.join(spec.dataRoot, 'host-runtimes', spec.userId);
      try {
        if (fs.existsSync(userRoot)) {
          fs.rmSync(userRoot, { recursive: true, force: true });
        }
      } catch {}
    }
  }

  private createActiveRuntimeHandle(
    spec: HostRuntimeSpec,
    pid: number,
    transport: HostDaemonTransport,
    llmProxyServer: HostLlmProxyServer | undefined,
    platformProxyServer: HostPlatformProxyServer | undefined,
    isCreated: boolean
  ): ActiveRuntimeHandle {
    const containerId = `host-proc-${pid}-${spec.runId}`;
    const runId = spec.runId;
    const volumeId = spec.storageId;
    const spacesDir = spec.spacesDir;

    const handle: ActiveRuntimeHandle = {
      spec,
      containerId,
      runId,
      volumeId,
      isCreated,
      pid,
      get proxyServer() {
        return llmProxyServer;
      },
      get platformProxyServer() {
        return platformProxyServer;
      },
      setPlatformProxyHandler: (handler: PlatformProxyHandler | null) => {
        if (platformProxyServer) {
          platformProxyServer.setHandler(handler);
        }
      },
      get transport() {
        return transport;
      },
      startTransport: async () => {
        if (!transport.isConnected()) {
          await transport.start();
        }
        return transport;
      },
      checkHealth: async (): Promise<RuntimeHealthStatus> => {
        if (!transport.isConnected()) {
          await transport.start();
        }
        return transport.checkHealth();
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
        const replyReference = (request as any).replyReference;

        if (!prompt || typeof prompt !== 'string') {
          throw new Error('prompt is required for sendFollowup');
        }
        if (!sessionId || typeof sessionId !== 'string') {
          throw new Error('sessionId is required for sendFollowup');
        }
        if (!turnId || typeof turnId !== 'string') {
          throw new Error('turnId is required for sendFollowup');
        }

        try {
          const followupRes = await transport.sendFollowup({
            prompt,
            sessionId,
            turnId,
            profile: (profileSnapshot ?? null) as any,
            profileSnapshot: (profileSnapshot ?? null) as any,
            workspaceFolder: typeof workspaceFolder === 'string' ? workspaceFolder : undefined,
            attachments,
            modelSelection: modelSelection ?? undefined,
            replyReference: replyReference ?? null,
            timeoutMs,
            mounts: request.mounts,
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
              : err instanceof HostDaemonError
              ? err.code
              : typeof err === 'object' && err !== null && 'code' in err
              ? String((err as any).code)
              : 'EXECUTION_FAILED';
          const errMsg = err instanceof Error ? err.message : 'Turn execution failed';

          return {
            status: 'error',
            code: errCode || 'EXECUTION_FAILED',
            turnId,
            sessionId,
            error: errMsg,
          };
        }
      },
      checkSessionArtifact: async (sessionId: string, workspaceFolder?: string) => {
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
      inspectSessionCorruption: async (sessionId: string, workspaceFolder?: string) => {
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
      recoverSessionPrefix: async (options) => {
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
      exportForkSeed: async (sessionId, boundary, workspaceFolder) => {
        try {
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
          const errCode = (err as any)?.code;
          return {
            status: 'error',
            code: errCode,
            sessionId,
            error: (err as any)?.message || 'Export failed',
          };
        }
      },
      importSeed: async (sessionId, seed, receipt, profile, spaceId) => {
        try {
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
          return {
            status: 'error',
            code: (err as any)?.code || 'IMPORT_FAILED',
            sessionId,
            error: (err as any)?.message || 'Import failed',
          };
        }
      },
      cancelTurn: async (turnId: string) => {
        if (!isProcessAlive(pid)) {
          return {
            status: 'cancelled',
            turnId,
            code: 'CANCELLED',
          };
        }
        try {
          const res = await transport.cancelTurn(turnId);
          return {
            status: res.cancelled ? 'cancelled' : 'ok',
            turnId: res.turnId ?? turnId,
            code: res.cancelled ? 'CANCELLED' : 'OK',
          };
        } catch (cancelErr) {
          if (!isProcessAlive(pid)) {
            return {
              status: 'cancelled',
              turnId,
              code: 'CANCELLED',
            };
          }
          throw cancelErr;
        }
      },
      inspectTurn: async (turnId: string) => {
        try {
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
        } catch (inspectErr) {
          if (!isProcessAlive(pid)) {
            return {
              status: 'error',
              turnId,
              sessionId: '',
              error: 'Host daemon process is no longer running',
            };
          }
          throw inspectErr;
        }
      },
      fileOperation: async (request: FileOperationRequest) => {
        try {
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
              ? String((err as any).code)
              : 'FILE_OP_FAILED';
          const errMsg = err instanceof Error ? err.message : 'File operation failed';
          return {
            status: 'error',
            code: errCode,
            error: errMsg,
          };
        }
      },
      instructionsRead: async (request) => {
        try {
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
              ? String((err as any).code)
              : 'INSTRUCTIONS_READ_FAILED';
          const errMsg = err instanceof Error ? err.message : 'Instructions read failed';
          return {
            status: 'error',
            code: errCode,
            error: errMsg,
          };
        }
      },
      instructionsWrite: async (request) => {
        try {
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
              ? String((err as any).code)
              : 'INSTRUCTIONS_WRITE_FAILED';
          const errMsg = err instanceof Error ? err.message : 'Instructions write failed';
          return {
            status: 'error',
            code: errCode,
            error: errMsg,
          };
        }
      },
      fileWriteStream: (options, inStream) =>
        hostWriteStream(spacesDir, options, inStream),
      fileReadStream: (options) =>
        hostReadStream(spacesDir, options),
      fileStageStream: (options, inStream) =>
        hostStageStream(spacesDir, options, inStream),
      fileCommitStage: (options) =>
        hostCommitStage(spacesDir, options),
      fileAbortStage: (options) =>
        hostAbortStage(spacesDir, options),
      fileFinalizeStage: (options) =>
        hostFinalizeStage(spacesDir, options),
      fileRollbackCommit: (options) =>
        hostRollbackCommit(spacesDir, options),
      fileInspectTransferState: (options) =>
        hostInspectTransferState(spacesDir, options),
      stop: async () => {
        try {
          await transport.close();
        } catch {}
        if (llmProxyServer) {
          try {
            await llmProxyServer.close();
          } catch {}
        }
        if (platformProxyServer) {
          try {
            await platformProxyServer.close();
          } catch {}
        }
        await killProcessTree(pid, 3000);
        cleanStaleProcess(spec.runDir);
      },
      teardown: async (removeStorage = false) => {
        try {
          await transport.close();
        } catch {}
        if (llmProxyServer) {
          try {
            await llmProxyServer.close();
          } catch {}
        }
        if (platformProxyServer) {
          try {
            await platformProxyServer.close();
          } catch {}
        }
        await killProcessTree(pid, 2000);
        cleanStaleProcess(spec.runDir);

        if (removeStorage) {
          const userRoot = path.join(spec.dataRoot, 'host-runtimes', spec.userId);
          try {
            if (fs.existsSync(userRoot)) {
              fs.rmSync(userRoot, { recursive: true, force: true });
            }
          } catch {}
        }
      },
    };

    return handle;
  }
}
