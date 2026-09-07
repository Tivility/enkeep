/**
 * Daemon Docker Transport for Zero-Network Container Runtime
 *
 * Connects to the in-container Persistent Runtime Daemon via a persistent
 * bridge process (`docker exec -i <container> node daemon-bridge.js`) over the
 * container's local Unix domain socket (`/tmp/enkeep-runtime.sock`).
 *
 * Invariants:
 * - Zero network ports (--network none).
 * - Single-flight bridge process connection management.
 * - Automatic exponential backoff reconnection on unexpected disconnects.
 * - Request correlation via unique frame IDs.
 * - Backpressure bounding (max 32 concurrent requests).
 * - Payload size caps and depth validation (MAX_DAEMON_FRAME_SIZE).
 * - Request timeout and cancellation support.
 * - Turn journal reconciliation on disconnect/reconnect.
 * - No raw Docker/daemon errors leaked to callers.
 *
 * @module @enkeep/runtime-runner/transport/daemon-transport
 */

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type {
  SafeDockerClient,
  OwnershipExpectation,
  LongRunningExecHandle,
} from '../docker/client.js';
import { DockerNotFoundError, DockerOwnershipError, DockerDaemonError } from '../spec/validator.js';
import {
  DAEMON_OPS,
  DAEMON_ERROR_CODES,
  DAEMON_STREAM_EVENTS,
  MAX_DAEMON_FRAME_SIZE,
  DaemonRpcDecoder,
  DaemonRpcEncoder,
  DaemonProtocolError,
  validateJsonDepth,
  type DaemonOp,
  type DaemonErrorCode,
  type DaemonRequest,
  type DaemonResponse,
  type DaemonStreamEvent,
  type SubmitTurnRequest,
  type SubmitTurnResponse,
  type CancelRequest,
  type CancelResponse,
  type InspectTurnRequest,
  type InspectTurnResponse,
  type HealthRequest,
  type HealthResponse,
  type CapabilitiesRequest,
  type CapabilitiesResponse,
  type CheckSessionArtifactRequest,
  type CheckSessionArtifactResponse,
  type InspectCorruptionRequest,
  type InspectCorruptionResponse,
  type RecoverPrefixRequest,
  type RecoverPrefixResponse,
  type ExportForkSeedRequest,
  type ExportForkSeedResponse,
  type ImportSeedRequest,
  type ImportSeedResponse,
  type FileOpDaemonRequest,
  type FileOpDaemonResponse,
  type InstructionsReadRequest,
  type InstructionsReadResponse,
  type InstructionsWriteRequest,
  type InstructionsWriteResponse,
  type AnswerApprovalRequest,
  type AnswerApprovalResponse,
  type ListApprovalsRequest,
  type ListApprovalsResponse,
} from '../runtime/daemon-protocol.js';
import type { FileOperationRequest, FileOperationResult } from '../runtime/file-ops.js';
import type { RuntimeMountSpec } from '../spec/types.js';
import {
  canonicalJsonStringify,
  computeSessionEventsChecksum,
  computeSessionSeedReceipt,
  normalizeCanonicalSessionEvents,
  type SessionSeedReceipt,
} from '@enkeep/protocol';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { AgentProfileSnapshot } from '../runtime/agent-profile.js';
import {
  type RuntimeTransport,
  type RuntimeDaemonTransportPort,
  type RuntimeHealthStatus,
  type AgentFollowupRequest,
  type AgentFollowupResponse,
  RUNTIME_ERROR_CODES,
  RuntimeProtocolError,
  DEFAULT_FOLLOWUP_TIMEOUT_MS,
} from './types.js';

export const MAX_CONCURRENT_DAEMON_REQUESTS = 32;
export const DEFAULT_DAEMON_TIMEOUT_MS = 30_000;

export interface DaemonDockerTransportOptions {
  bridgeCliPath?: string;
  maxConcurrentRequests?: number;
  defaultTimeoutMs?: number;
  maxRetries?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  autoReconnect?: boolean;
}

export type DaemonTransportState =
  | 'idle'
  | 'starting'
  | 'connected'
  | 'reconnecting'
  | 'stopping'
  | 'stopped';

interface PendingRpc {
  id: string;
  op: string;
  resolve: (res: DaemonResponse) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  createdAt: number;
}

interface TurnWaiter {
  turnId: string;
  sessionId: string;
  resolve: (res: AgentFollowupResponse) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
  createdAt: number;
}

export class DaemonDockerTransport extends EventEmitter implements RuntimeTransport, RuntimeDaemonTransportPort {
  readonly mode = 'exec' as const;
  readonly endpoint = 'docker-daemon://local-runtime';

  private readonly dockerClient: SafeDockerClient;
  private readonly expectation: OwnershipExpectation;
  private readonly options: Required<DaemonDockerTransportOptions>;

  private state: DaemonTransportState = 'idle';
  private generation = 0;
  private explicitlyClosed = false;
  private lastTerminalError: Error | null = null;
  private execHandle: LongRunningExecHandle | null = null;
  private decoder: DaemonRpcDecoder | null = null;
  private encoder: DaemonRpcEncoder | null = null;

  private activeStartPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;

  private readonly pendingRequests: Map<string, PendingRpc> = new Map();
  private readonly turnWaiters: Map<string, TurnWaiter> = new Map();

  constructor(
    dockerClient: SafeDockerClient,
    expectation: OwnershipExpectation,
    options: DaemonDockerTransportOptions = {}
  ) {
    super();
    this.dockerClient = dockerClient;
    this.expectation = expectation;
    this.options = {
      bridgeCliPath:
        options.bridgeCliPath ?? '/app/runtime-runner/dist/runtime/daemon-bridge.js',
      maxConcurrentRequests:
        options.maxConcurrentRequests ?? MAX_CONCURRENT_DAEMON_REQUESTS,
      defaultTimeoutMs: options.defaultTimeoutMs ?? DEFAULT_DAEMON_TIMEOUT_MS,
      maxRetries: options.maxRetries ?? 5,
      initialBackoffMs: options.initialBackoffMs ?? 200,
      maxBackoffMs: options.maxBackoffMs ?? 5000,
      autoReconnect: options.autoReconnect ?? true,
    };
  }

  public getState(): DaemonTransportState {
    return this.state;
  }

  public getLastTerminalError(): Error | null {
    return this.lastTerminalError;
  }

  public isConnected(): boolean {
    return this.state === 'connected' && this.execHandle !== null;
  }

  /**
   * Starts the persistent bridge process and establishes communication.
   * Single-flight: concurrent start calls return the same promise.
   */
  public async start(): Promise<void> {
    if (this.state === 'connected') return;
    if (this.explicitlyClosed || this.state === 'stopping') {
      throw new DockerOwnershipError('Cannot start a stopped DaemonDockerTransport');
    }
    if (this.state === 'stopped') {
      // Allow explicit restart after reconnect exhaustion
      this.state = 'idle';
      this.reconnectAttempts = 0;
      this.lastTerminalError = null;
    }
    if (this.activeStartPromise) {
      return this.activeStartPromise;
    }

    this.activeStartPromise = this.executeStart(false);
    try {
      await this.activeStartPromise;
    } finally {
      this.activeStartPromise = null;
    }
  }

  private async executeStart(isReconnect = false): Promise<void> {
    this.generation++;
    const currentGen = this.generation;
    this.state = 'starting';

    try {
      const handle = await this.dockerClient.spawnLongRunningExecOwned(this.expectation, [
        'node',
        this.options.bridgeCliPath,
      ]);

      if (this.generation !== currentGen) {
        handle.kill('SIGTERM');
        return;
      }

      this.execHandle = handle;
      this.decoder = new DaemonRpcDecoder();
      this.encoder = new DaemonRpcEncoder();

      this.decoder.on('data', (message: unknown) => {
        if (this.generation !== currentGen) return;
        this.handleIncomingMessage(message);
      });

      this.decoder.on('error', (err: Error) => {
        if (this.generation !== currentGen) return;
        this.handleBridgeDisconnect(err);
      });

      handle.stdout.pipe(this.decoder);
      this.encoder.pipe(handle.stdin);

      handle.exitPromise.then(({ exitCode, signal }) => {
        if (this.generation !== currentGen) return;
        this.handleBridgeDisconnect(
          new Error(`Bridge process exited with code ${exitCode}, signal ${signal}`)
        );
      });

      this.state = 'connected';
      if (!isReconnect) {
        this.reconnectAttempts = 0;
      }
      this.lastTerminalError = null;
      this.emit('connected');
    } catch (err: unknown) {
      this.state = 'idle';
      if (err instanceof DockerNotFoundError || err instanceof DockerOwnershipError) {
        throw err;
      }
      throw new DockerDaemonError('Failed to spawn daemon bridge process', err);
    }
  }

  /**
   * Handles incoming message from the daemon (either a response or a push event).
   */
  private handleIncomingMessage(message: unknown): void {
    if (!message || typeof message !== 'object') return;
    this.reconnectAttempts = 0;

    // Check if it is a push event
    const rawMsg = message as Record<string, unknown>;
    if (rawMsg.type === 'event' && typeof rawMsg.event === 'string') {
      const event = message as DaemonStreamEvent;
      this.emit('stream', event);
      this.emit(event.event, event);

      // Correlation for turn completion / cancellation / failure
      if (event.event === DAEMON_STREAM_EVENTS.TURN_COMPLETED) {
        const turnId = event.turnId;
        const waiter = this.turnWaiters.get(turnId);
        if (waiter) {
          this.turnWaiters.delete(turnId);
          if (waiter.timer) clearTimeout(waiter.timer);
          waiter.resolve(event.result);
        }
      } else if (event.event === DAEMON_STREAM_EVENTS.TURN_CANCELLED) {
        const turnId = event.turnId;
        const waiter = this.turnWaiters.get(turnId);
        if (waiter) {
          this.turnWaiters.delete(turnId);
          if (waiter.timer) clearTimeout(waiter.timer);
          waiter.resolve({
            status: 'cancelled',
            turnId,
            sessionId: event.sessionId ?? waiter.sessionId,
            eventsCount: 0,
            persisted: true,
          });
        }
      } else if (event.event === DAEMON_STREAM_EVENTS.TURN_FAILED) {
        const turnId = event.turnId;
        const waiter = this.turnWaiters.get(turnId);
        if (waiter) {
          this.turnWaiters.delete(turnId);
          if (waiter.timer) clearTimeout(waiter.timer);
          const errCode = (event.error?.code as DaemonErrorCode) || DAEMON_ERROR_CODES.AGENT_EXECUTION_FAILED;
          const errMsg = event.error?.message || 'Turn execution failed in daemon';
          waiter.reject(new DaemonProtocolError(errCode, errMsg, (event.error as any)?.details));
        }
      }
      return;
    }

    // Correlation for request responses
    if (typeof rawMsg.id === 'string') {
      const pending = this.pendingRequests.get(rawMsg.id);
      if (pending) {
        this.pendingRequests.delete(rawMsg.id);
        clearTimeout(pending.timer);

        const resp = message as DaemonResponse;
        if (resp.ok === false) {
          const errCode = (resp.error?.code as DaemonErrorCode) || DAEMON_ERROR_CODES.INTERNAL_ERROR;
          const errMsg = resp.error?.message || 'Daemon request failed';
          pending.reject(new DaemonProtocolError(errCode, errMsg, (resp.error as any)?.details));
        } else {
          pending.resolve(resp);
        }
      }
    }
  }

  /**
   * Handles bridge disconnection and initiates automatic reconnection.
   */
  private handleBridgeDisconnect(err: Error): void {
    if (this.state === 'stopping' || this.state === 'stopped') {
      return;
    }

    this.state = 'reconnecting';
    this.emit('disconnected', err);

    // Reject non-turn in-flight requests that cannot be journal-reconciled
    for (const [id, req] of this.pendingRequests.entries()) {
      if (req.op !== DAEMON_OPS.SUBMIT_TURN) {
        clearTimeout(req.timer);
        req.reject(new DaemonProtocolError(DAEMON_ERROR_CODES.SHUTTING_DOWN, 'Daemon disconnected'));
        this.pendingRequests.delete(id);
      }
    }

    if (this.execHandle) {
      this.execHandle.kill('SIGTERM');
      this.execHandle = null;
    }
    this.decoder = null;
    this.encoder = null;

    if (!this.options.autoReconnect) {
      this.state = 'idle';
      return;
    }

    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.explicitlyClosed || this.state === 'stopping') {
      return;
    }

    if (this.reconnectAttempts >= this.options.maxRetries) {
      this.state = 'stopped';
      const fatalErr = new DockerDaemonError(
        `Failed to reconnect to daemon after ${this.options.maxRetries} attempts`
      );
      this.lastTerminalError = fatalErr;

      // Emit non-special transportError event unconditionally for subscribers
      this.emit('transportError', fatalErr);

      // Only emit special 'error' event if caller has explicitly registered an 'error' listener
      // preventing unhandled error crashes from terminating Node process
      if (this.listenerCount('error') > 0) {
        this.emit('error', fatalErr);
      }

      // Reject all pending in-flight requests and turn waiters
      for (const [id, req] of this.pendingRequests.entries()) {
        clearTimeout(req.timer);
        req.reject(fatalErr);
        this.pendingRequests.delete(id);
      }

      for (const [turnId, waiter] of this.turnWaiters.entries()) {
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.reject(fatalErr);
        this.turnWaiters.delete(turnId);
      }
      return;
    }

    const backoff = Math.min(
      this.options.initialBackoffMs * Math.pow(2, this.reconnectAttempts),
      this.options.maxBackoffMs
    );
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.explicitlyClosed || this.state === 'stopping' || this.state === 'stopped') {
        return;
      }
      try {
        await this.executeStart(true);
        // Upon successful reconnect, reconcile active turn waiters against daemon journal
        await this.reconcileActiveTurns();
      } catch (_recErr) {
        this.scheduleReconnect();
      }
    }, backoff);
  }

  /**
   * Reconciles in-flight turn waiters against the daemon journal after reconnection.
   */
  private async reconcileActiveTurns(): Promise<void> {
    if (this.turnWaiters.size === 0) return;

    for (const [turnId, waiter] of Array.from(this.turnWaiters.entries())) {
      try {
        const inspectRes = await this.inspectTurn(turnId);
        if (inspectRes.ok) {
          if (inspectRes.journalStatus === 'completed' && inspectRes.result) {
            this.turnWaiters.delete(turnId);
            if (waiter.timer) clearTimeout(waiter.timer);
            waiter.resolve(inspectRes.result);
          } else if (inspectRes.journalStatus === 'cancelled') {
            this.turnWaiters.delete(turnId);
            if (waiter.timer) clearTimeout(waiter.timer);
            waiter.resolve({
              status: 'cancelled',
              turnId,
              sessionId: waiter.sessionId,
              eventsCount: 0,
              persisted: true,
            });
          } else if (inspectRes.journalStatus === 'failed') {
            this.turnWaiters.delete(turnId);
            if (waiter.timer) clearTimeout(waiter.timer);
            const errCode = (inspectRes.error?.code as DaemonErrorCode) || DAEMON_ERROR_CODES.AGENT_EXECUTION_FAILED;
            waiter.reject(new DaemonProtocolError(errCode, 'Turn failed during previous run'));
          }
        }
      } catch {}
    }
  }

  /**
   * Dispatches a raw request to the daemon and returns the response envelope.
   */
  public async request<TReq extends DaemonRequest, TRes extends DaemonResponse>(
    req: TReq,
    timeoutMs?: number
  ): Promise<TRes> {
    if (this.state === 'stopping' || this.state === 'stopped') {
      throw new DaemonProtocolError(DAEMON_ERROR_CODES.SHUTTING_DOWN, 'Transport is stopped');
    }

    if (!this.isConnected()) {
      await this.start();
    }

    if (this.pendingRequests.size >= this.options.maxConcurrentRequests) {
      throw new DaemonProtocolError(
        DAEMON_ERROR_CODES.SESSION_BUSY,
        `Backpressure limit reached: maximum ${this.options.maxConcurrentRequests} concurrent in-flight requests`
      );
    }

    validateJsonDepth(req);

    const effTimeout = timeoutMs ?? this.options.defaultTimeoutMs;
    const reqId = req.id || `req_${crypto.randomUUID()}`;
    const payload = { ...req, id: reqId };

    return new Promise<TRes>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(reqId);
        reject(
          new DaemonProtocolError(
            DAEMON_ERROR_CODES.INTERNAL_ERROR,
            `Request "${req.op}" (${reqId}) timed out after ${effTimeout}ms`
          )
        );
      }, effTimeout);

      this.pendingRequests.set(reqId, {
        id: reqId,
        op: req.op,
        resolve: resolve as (res: DaemonResponse) => void,
        reject,
        timer,
        createdAt: Date.now(),
      });

      try {
        this.encoder!.write(payload);
      } catch (err: unknown) {
        clearTimeout(timer);
        this.pendingRequests.delete(reqId);
        reject(new DockerDaemonError('Failed to write request payload to bridge encoder', err));
      }
    });
  }

  /**
   * Submits a turn and awaits its final completion result from the daemon.
   */
  public async submitTurnAndWait(
    request: SubmitTurnRequest,
    timeoutMs: number = DEFAULT_FOLLOWUP_TIMEOUT_MS
  ): Promise<AgentFollowupResponse> {
    const { turnId, sessionId } = request;

    if (!this.isConnected()) {
      await this.start();
    }

    const completionPromise = new Promise<AgentFollowupResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turnWaiters.delete(turnId);
        reject(
          new RuntimeProtocolError(RUNTIME_ERROR_CODES.FOLLOWUP_FAILED)
        );
      }, timeoutMs);

      this.turnWaiters.set(turnId, {
        turnId,
        sessionId,
        resolve,
        reject,
        timer,
        createdAt: Date.now(),
      });
    });
    // Suppress unhandled rejection on completionPromise if submission itself fails earlier
    completionPromise.catch(() => {});

    // Translate host mount sourcePath to in-container physical targetPath (/home/dsh/mounts/<id>)
    // so no host path is transmitted to or visible by the in-container daemon filesystem
    let effRequest = request;
    if (request.mounts && request.mounts.length > 0) {
      const inContainerMounts: RuntimeMountSpec[] = request.mounts.map((m) => ({
        id: m.id,
        name: m.name,
        sourcePath: m.sourcePath.startsWith('/home/dsh/mounts/') ? m.sourcePath : `/home/dsh/mounts/${m.id}`,
        mode: m.mode,
      }));
      effRequest = {
        ...request,
        mounts: inContainerMounts,
      };
    }

    try {
      const submitRes = await this.request<SubmitTurnRequest, SubmitTurnResponse>(
        effRequest,
        Math.min(timeoutMs, 10_000)
      );

      if (!submitRes.ok) {
        const waiter = this.turnWaiters.get(turnId);
        if (waiter) {
          this.turnWaiters.delete(turnId);
          if (waiter.timer) clearTimeout(waiter.timer);
        }
        const errCode = (submitRes.error?.code as DaemonErrorCode) || DAEMON_ERROR_CODES.INTERNAL_ERROR;
        throw new DaemonProtocolError(errCode, 'Failed to submit turn to daemon');
      }

      return await completionPromise;
    } catch (err: unknown) {
      const waiter = this.turnWaiters.get(turnId);
      if (waiter) {
        this.turnWaiters.delete(turnId);
        if (waiter.timer) clearTimeout(waiter.timer);
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Standard Runtime Operations
  // ---------------------------------------------------------------------------

  public async sendFollowup(request: AgentFollowupRequest): Promise<AgentFollowupResponse> {
    const submitReq: SubmitTurnRequest = {
      id: `req_${crypto.randomUUID()}`,
      op: DAEMON_OPS.SUBMIT_TURN,
      turnId: request.turnId,
      sessionId: request.sessionId,
      prompt: request.prompt,
      profileSnapshot: request.profileSnapshot !== undefined ? request.profileSnapshot : (request.profile ?? null),
      profile: request.profile ?? null,
      workspaceFolder: typeof request.workspaceFolder === 'string' ? request.workspaceFolder : (request.spaceId ?? undefined),
      attachments: request.attachments,
      modelSelection: request.modelSelection,
      replyReference: request.replyReference ?? null,
      timeoutMs: request.timeoutMs,
      mounts: request.mounts,
      extensionPlan: request.extensionPlan ?? null,
    };
    return this.submitTurnAndWait(submitReq, request.timeoutMs ?? DEFAULT_FOLLOWUP_TIMEOUT_MS);
  }

  public async checkHealth(): Promise<RuntimeHealthStatus> {
    const res = await this.request<HealthRequest, HealthResponse>({
      id: `req_${crypto.randomUUID()}`,
      op: DAEMON_OPS.HEALTH,
    });
    return res.health;
  }

  public async cancelTurn(turnId: string, reason?: string): Promise<CancelResponse> {
    return this.request<CancelRequest, CancelResponse>({
      id: `req_${crypto.randomUUID()}`,
      op: DAEMON_OPS.CANCEL,
      turnId,
      reason,
    });
  }

  public async inspectTurn(turnId: string): Promise<InspectTurnResponse> {
    return this.request<InspectTurnRequest, InspectTurnResponse>({
      id: `req_${crypto.randomUUID()}`,
      op: DAEMON_OPS.INSPECT_TURN,
      turnId,
    });
  }

  public async getCapabilities(): Promise<CapabilitiesResponse> {
    return this.request<CapabilitiesRequest, CapabilitiesResponse>({
      id: `req_${crypto.randomUUID()}`,
      op: DAEMON_OPS.CAPABILITIES,
    });
  }

  public async checkSessionArtifact(
    sessionId: string,
    workspaceFolder?: string
  ): Promise<CheckSessionArtifactResponse> {
    return this.request<CheckSessionArtifactRequest, CheckSessionArtifactResponse>({
      id: `req_${crypto.randomUUID()}`,
      op: DAEMON_OPS.CHECK_SESSION_ARTIFACT,
      sessionId,
      workspaceFolder,
    });
  }

  public async inspectSessionCorruption(
    sessionId: string,
    workspaceFolder?: string
  ): Promise<InspectCorruptionResponse> {
    return this.request<InspectCorruptionRequest, InspectCorruptionResponse>({
      id: `req_${crypto.randomUUID()}`,
      op: DAEMON_OPS.INSPECT_CORRUPTION,
      sessionId,
      workspaceFolder,
    });
  }

  public async recoverSessionPrefix(options: {
    sourceSessionId: string;
    targetSessionId: string;
    workspaceFolder?: string;
    maxValidSeq?: number;
  }): Promise<RecoverPrefixResponse> {
    return this.request<RecoverPrefixRequest, RecoverPrefixResponse>({
      id: `req_${crypto.randomUUID()}`,
      op: DAEMON_OPS.RECOVER_PREFIX,
      sourceSessionId: options.sourceSessionId,
      targetSessionId: options.targetSessionId,
      workspaceFolder: options.workspaceFolder,
      maxValidSeq: options.maxValidSeq,
    });
  }

  public async exportForkSeed(
    sessionId: string,
    boundary?: { fromMessageId?: string; fromTurnId?: string },
    workspaceFolder?: string
  ): Promise<ExportForkSeedResponse> {
    return this.request<ExportForkSeedRequest, ExportForkSeedResponse>({
      id: `req_${crypto.randomUUID()}`,
      op: DAEMON_OPS.EXPORT_FORK_SEED,
      sessionId,
      boundary,
      workspaceFolder,
    });
  }

  public async importSeed(
    sessionId: string,
    seed: readonly unknown[],
    receipt?: unknown,
    profile?: unknown,
    spaceId?: string
  ): Promise<ImportSeedResponse> {
    const rawEvents = Array.isArray(seed) ? seed : [];
    const normalizedEvents = normalizeCanonicalSessionEvents<readonly SessionEvent[]>(rawEvents);

    const seedReceipt: SessionSeedReceipt =
      receipt && typeof receipt === 'object'
        ? (receipt as SessionSeedReceipt)
        : computeSessionSeedReceipt(normalizedEvents);

    return this.request<ImportSeedRequest, ImportSeedResponse>({
      id: `req_${crypto.randomUUID()}`,
      op: DAEMON_OPS.IMPORT_SEED,
      sessionId,
      seed: normalizedEvents,
      receipt: seedReceipt,
      profileSnapshot: (profile ?? null) as AgentProfileSnapshot | null,
      workspaceFolder: spaceId,
    });
  }

  public async fileOperation(request: FileOperationRequest): Promise<FileOpDaemonResponse> {
    return this.request<FileOpDaemonRequest, FileOpDaemonResponse>({
      id: `req_${crypto.randomUUID()}`,
      op: DAEMON_OPS.FILE_OP,
      fileOp: request,
    });
  }

  public async instructionsRead(request: {
    target: 'global' | 'space';
    spaceFolder?: string;
    filename?: string;
  }): Promise<InstructionsReadResponse> {
    return this.request<InstructionsReadRequest, InstructionsReadResponse>({
      id: `req_${crypto.randomUUID()}`,
      op: DAEMON_OPS.INSTRUCTIONS_READ,
      target: request.target,
      spaceFolder: request.spaceFolder,
      filename: request.filename,
    });
  }

  public async instructionsWrite(request: {
    target: 'global' | 'space';
    content: string;
    spaceFolder?: string;
    filename?: string;
    expectedEtag?: string | null;
    requireAbsent?: boolean;
  }): Promise<InstructionsWriteResponse> {
    return this.request<InstructionsWriteRequest, InstructionsWriteResponse>({
      id: `req_${crypto.randomUUID()}`,
      op: DAEMON_OPS.INSTRUCTIONS_WRITE,
      target: request.target,
      content: request.content,
      spaceFolder: request.spaceFolder,
      filename: request.filename,
      expectedEtag: request.expectedEtag,
      requireAbsent: request.requireAbsent,
    });
  }

  public async answerApproval(
    sessionId: string,
    approvalId: string,
    decision: 'allowed-once' | 'rejected' | 'allowed-always'
  ): Promise<AnswerApprovalResponse> {
    return this.request<AnswerApprovalRequest, AnswerApprovalResponse>({
      id: `req_${crypto.randomUUID()}`,
      op: DAEMON_OPS.ANSWER_APPROVAL,
      approvalId,
      decision,
    });
  }

  public async listApprovals(sessionId: string): Promise<ListApprovalsResponse> {
    return this.request<ListApprovalsRequest, ListApprovalsResponse>({
      id: `req_${crypto.randomUUID()}`,
      op: DAEMON_OPS.LIST_APPROVALS,
      sessionId,
    });
  }

  /**
   * Cleanly closes the transport and terminates the bridge process.
   */
  public async close(): Promise<void> {
    this.explicitlyClosed = true;
    if (this.state === 'stopped' || this.state === 'stopping') {
      return this.stopPromise ?? Promise.resolve();
    }

    this.state = 'stopping';
    this.generation++;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Reject all pending RPCs
    for (const [id, req] of this.pendingRequests.entries()) {
      clearTimeout(req.timer);
      req.reject(new DaemonProtocolError(DAEMON_ERROR_CODES.SHUTTING_DOWN, 'Transport closed'));
      this.pendingRequests.delete(id);
    }

    for (const [turnId, waiter] of this.turnWaiters.entries()) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(new DaemonProtocolError(DAEMON_ERROR_CODES.SHUTTING_DOWN, 'Transport closed'));
      this.turnWaiters.delete(turnId);
    }

    if (this.execHandle) {
      try {
        this.execHandle.kill('SIGTERM');
      } catch {}
      this.execHandle = null;
    }

    this.decoder = null;
    this.encoder = null;
    this.state = 'stopped';
    this.emit('closed');
  }
}
