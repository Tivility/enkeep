/**
 * Host Daemon UDS Transport
 *
 * Connects directly to the resident Host Runtime Daemon via Unix Domain Socket (UDS)
 * with strict NDJSON framing, bidirectional stream event emission, request correlation,
 * backpressure management, and turn completion waiting.
 *
 * @module @enkeep/runtime-runner/host/transport
 */

import net from 'node:net';
import crypto from 'node:crypto';
import EventEmitter from 'node:events';
import {
  DAEMON_OPS,
  DAEMON_ERROR_CODES,
  DAEMON_STREAM_EVENTS,
  MAX_DAEMON_FRAME_SIZE,
  DaemonRpcDecoder,
  DaemonRpcEncoder,
  encodeDaemonMessage,
  DaemonProtocolError,
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
} from '../runtime/daemon-protocol.js';
import type { FileOperationRequest } from '../runtime/file-ops.js';
import {
  type RuntimeDaemonTransportPort,
  type RuntimeHealthStatus,
  type AgentFollowupRequest,
  type AgentFollowupResponse,
  RUNTIME_ERROR_CODES,
  RuntimeProtocolError,
  DEFAULT_FOLLOWUP_TIMEOUT_MS,
} from '../transport/types.js';
import {
  HostDaemonError,
  HostRuntimeExitedError,
  HostTransportError,
} from '../spec/provider.js';
import {
  normalizeCanonicalSessionEvents,
  computeSessionSeedReceipt,
  type SessionSeedReceipt,
} from '@enkeep/protocol';

export const DEFAULT_HOST_DAEMON_TIMEOUT_MS = 30_000;
export const MAX_CONCURRENT_HOST_REQUESTS = 32;

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

export interface HostDaemonTransportOptions {
  socketPath: string;
  maxConcurrentRequests?: number;
  defaultTimeoutMs?: number;
  autoReconnect?: boolean;
}

export class HostDaemonTransport extends EventEmitter implements RuntimeDaemonTransportPort {
  readonly mode = 'uds' as const;
  readonly endpoint: string;

  private readonly socketPath: string;
  private readonly options: Required<HostDaemonTransportOptions>;
  private socket: net.Socket | null = null;
  private decoder: DaemonRpcDecoder | null = null;
  private encoder: DaemonRpcEncoder | null = null;

  private state: 'idle' | 'starting' | 'connected' | 'stopping' | 'stopped' = 'idle';
  private generation = 0;
  private activeStartPromise: Promise<void> | null = null;

  private readonly pendingRequests: Map<string, PendingRpc> = new Map();
  private readonly turnWaiters: Map<string, TurnWaiter> = new Map();

  constructor(options: HostDaemonTransportOptions) {
    super();
    this.socketPath = options.socketPath;
    this.endpoint = `uds://${options.socketPath}`;
    this.options = {
      socketPath: options.socketPath,
      maxConcurrentRequests: options.maxConcurrentRequests ?? MAX_CONCURRENT_HOST_REQUESTS,
      defaultTimeoutMs: options.defaultTimeoutMs ?? DEFAULT_HOST_DAEMON_TIMEOUT_MS,
      autoReconnect: options.autoReconnect ?? true,
    };
  }

  public isConnected(): boolean {
    return this.state === 'connected' && this.socket !== null && !this.socket.destroyed;
  }

  public async start(connectTimeoutMs = 1_000): Promise<void> {
    if (this.isConnected()) return;
    if (this.state === 'stopping' || this.state === 'stopped') {
      throw new HostDaemonError('Cannot start a stopped HostDaemonTransport');
    }
    if (this.activeStartPromise) {
      return this.activeStartPromise;
    }

    this.activeStartPromise = this.executeStart(connectTimeoutMs);
    try {
      await this.activeStartPromise;
    } finally {
      this.activeStartPromise = null;
    }
  }

  private async executeStart(connectTimeoutMs: number): Promise<void> {
    this.generation++;
    const currentGen = this.generation;
    this.state = 'starting';

    const start = Date.now();
    let socket: net.Socket | null = null;
    let lastError: unknown;

    while (Date.now() - start < connectTimeoutMs) {
      try {
        socket = await new Promise<net.Socket>((resolve, reject) => {
          const s = net.connect(this.socketPath);
          const onConnect = () => {
            s.removeAllListeners('error');
            resolve(s);
          };
          const onError = (err: Error) => {
            s.destroy();
            reject(err);
          };
          s.once('connect', onConnect);
          s.once('error', onError);
        });
        break;
      } catch (err: unknown) {
        lastError = err;
        await new Promise((r) => setTimeout(r, 150));
      }
    }

    if (!socket) {
      this.state = 'idle';
      throw new HostDaemonError(
        `Failed to connect to host runtime daemon at "${this.socketPath}"`,
        lastError
      );
    }

    if (this.generation !== currentGen) {
      socket.destroy();
      return;
    }

    this.socket = socket;
    this.decoder = new DaemonRpcDecoder();
    this.encoder = new DaemonRpcEncoder();

    this.decoder.on('data', (message: unknown) => {
      if (this.generation !== currentGen) return;
      this.handleIncomingMessage(message);
    });

    this.decoder.on('error', (err: Error) => {
      if (this.generation !== currentGen) return;
      this.handleDisconnect(err);
    });

    socket.pipe(this.decoder);

    const onDisconnect = () => {
      if (this.generation !== currentGen) return;
      this.handleDisconnect(new Error('Socket disconnected'));
    };

    socket.on('end', onDisconnect);
    socket.on('close', onDisconnect);
    socket.on('error', onDisconnect);

    this.state = 'connected';
    this.emit('connected');
  }

  private handleIncomingMessage(message: unknown): void {
    if (!message || typeof message !== 'object') return;

    const rawMsg = message as Record<string, unknown>;

    // Handle push stream events
    if (rawMsg.type === 'event' && typeof rawMsg.event === 'string') {
      const event = message as DaemonStreamEvent;
      this.emit('stream', event);
      this.emit(event.event, event);

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
          const errMsg = event.error?.message || 'Agent turn execution failed in daemon';
          const protoErr = new DaemonProtocolError(errCode, errMsg, (event.error as any)?.details);
          waiter.reject(protoErr);
        }
      }
      return;
    }

    // Handle RPC response frames
    if (typeof rawMsg.id === 'string') {
      const pending = this.pendingRequests.get(rawMsg.id);
      if (pending) {
        this.pendingRequests.delete(rawMsg.id);
        clearTimeout(pending.timer);
        const res = message as DaemonResponse;
        if (res.ok) {
          pending.resolve(res);
        } else {
          const errCode = (res.error?.code as DaemonErrorCode) || DAEMON_ERROR_CODES.INTERNAL_ERROR;
          const errMsg = res.error?.message || 'Daemon RPC request failed';
          pending.reject(new DaemonProtocolError(errCode, errMsg, (res.error as any)?.details));
        }
      }
    }
  }

  private handleDisconnect(err: Error): void {
    if (this.state === 'stopping' || this.state === 'stopped') {
      return;
    }
    this.state = 'idle';
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch {}
      this.socket = null;
    }

    // Reject all pending RPCs
    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new HostTransportError('Host daemon transport disconnected while request was in-flight', err));
    }
    this.pendingRequests.clear();

    // Reject all active turn waiters immediately with typed HostRuntimeExitedError
    for (const [turnId, waiter] of this.turnWaiters.entries()) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(new HostRuntimeExitedError('Host daemon transport disconnected while turn was executing', err));
    }
    this.turnWaiters.clear();

    this.emit('disconnected', err);
  }

  public async close(): Promise<void> {
    this.state = 'stopping';
    this.generation++;

    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new HostTransportError('HostDaemonTransport is closing'));
    }
    this.pendingRequests.clear();

    for (const [turnId, waiter] of this.turnWaiters.entries()) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(new HostRuntimeExitedError('HostDaemonTransport closed before turn completed'));
    }
    this.turnWaiters.clear();

    if (this.socket) {
      try {
        this.socket.destroy();
      } catch {}
      this.socket = null;
    }

    this.state = 'stopped';
    this.emit('close');
  }

  public async request<TReq extends DaemonRequest, TRes extends DaemonResponse>(
    req: TReq,
    timeoutMs = this.options.defaultTimeoutMs
  ): Promise<TRes> {
    if (!this.isConnected()) {
      await this.start();
    }

    if (this.pendingRequests.size >= this.options.maxConcurrentRequests) {
      throw new HostDaemonError('Too many concurrent daemon requests (backpressure limit exceeded)');
    }

    const id = req.id || `rpc_${crypto.randomBytes(8).toString('hex')}`;
    const framedReq: DaemonRequest = { ...req, id };

    return new Promise<TRes>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new HostDaemonError(`Daemon RPC request "${framedReq.op}" (${id}) timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        id,
        op: framedReq.op,
        resolve: resolve as (res: DaemonResponse) => void,
        reject,
        timer,
        createdAt: Date.now(),
      });

      try {
        const buf = encodeDaemonMessage(framedReq);
        this.socket!.write(buf);
      } catch (err: unknown) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(new HostDaemonError('Failed to encode/write daemon request frame', err));
      }
    });
  }

  public async checkHealth(): Promise<RuntimeHealthStatus> {
    const res = await this.request<HealthRequest, HealthResponse>({
      id: `health_${crypto.randomBytes(8).toString('hex')}`,
      op: DAEMON_OPS.HEALTH,
    });
    if (!res.ok || !res.health) {
      throw new HostDaemonError('Health check returned unhealthy response');
    }
    return res.health;
  }

  public async sendFollowup(request: AgentFollowupRequest): Promise<AgentFollowupResponse> {
    if (!this.isConnected()) {
      try {
        await this.start();
      } catch (startErr: unknown) {
        throw new HostRuntimeExitedError(
          'Failed to connect to host runtime daemon: process exited or socket unreachable',
          startErr
        );
      }
    }

    const turnId = request.turnId;
    const sessionId = request.sessionId;
    const timeoutMs = request.timeoutMs ?? DEFAULT_FOLLOWUP_TIMEOUT_MS;

    const submitPromise = new Promise<AgentFollowupResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turnWaiters.delete(turnId);
        reject(new HostDaemonError(`Followup turn execution timed out after ${timeoutMs}ms`));
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

    const submitReq: SubmitTurnRequest = {
      id: `submit_${turnId}`,
      op: DAEMON_OPS.SUBMIT_TURN,
      turnId,
      sessionId,
      prompt: request.prompt,
      profile: request.profile ?? (request.profileSnapshot as any),
      workspaceFolder: typeof request.workspaceFolder === 'string' ? request.workspaceFolder : undefined,
      attachments: request.attachments as any,
      modelSelection: request.modelSelection ?? undefined,
      replyReference: request.replyReference ?? null,
      timeoutMs,
      mounts: request.mounts,
    };

    try {
      const ackRes = await this.request<SubmitTurnRequest, SubmitTurnResponse>(submitReq);
      if (!ackRes.ok) {
        const waiter = this.turnWaiters.get(turnId);
        if (waiter) {
          this.turnWaiters.delete(turnId);
          if (waiter.timer) clearTimeout(waiter.timer);
        }
        throw new HostDaemonError(`Submit turn rejected: ${ackRes.error?.message || 'Unknown error'}`);
      }
    } catch (err: unknown) {
      const waiter = this.turnWaiters.get(turnId);
      if (waiter) {
        this.turnWaiters.delete(turnId);
        if (waiter.timer) clearTimeout(waiter.timer);
      }
      throw err;
    }

    return submitPromise;
  }

  public async cancelTurn(turnId: string, reason?: string): Promise<CancelResponse> {
    return this.request<CancelRequest, CancelResponse>({
      id: `cancel_${turnId}_${crypto.randomBytes(4).toString('hex')}`,
      op: DAEMON_OPS.CANCEL,
      turnId,
      reason,
    });
  }

  public async inspectTurn(turnId: string): Promise<InspectTurnResponse> {
    return this.request<InspectTurnRequest, InspectTurnResponse>({
      id: `inspect_${turnId}_${crypto.randomBytes(4).toString('hex')}`,
      op: DAEMON_OPS.INSPECT_TURN,
      turnId,
    });
  }

  public async fileOperation(request: FileOperationRequest): Promise<FileOpDaemonResponse> {
    return this.request<FileOpDaemonRequest, FileOpDaemonResponse>({
      id: `fileop_${crypto.randomBytes(8).toString('hex')}`,
      op: DAEMON_OPS.FILE_OP,
      fileOp: request,
    });
  }

  public async checkSessionArtifact(
    sessionId: string,
    workspaceFolder?: string
  ): Promise<CheckSessionArtifactResponse> {
    return this.request<CheckSessionArtifactRequest, CheckSessionArtifactResponse>({
      id: `artifact_${sessionId}_${crypto.randomBytes(4).toString('hex')}`,
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
      id: `corrupt_${sessionId}_${crypto.randomBytes(4).toString('hex')}`,
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
      id: `recover_${options.sourceSessionId}_${crypto.randomBytes(4).toString('hex')}`,
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
      id: `export_${sessionId}_${crypto.randomBytes(4).toString('hex')}`,
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
    const normalizedEvents = normalizeCanonicalSessionEvents(rawEvents);

    const seedReceipt: SessionSeedReceipt =
      receipt && typeof receipt === 'object'
        ? (receipt as SessionSeedReceipt)
        : computeSessionSeedReceipt(normalizedEvents);

    return this.request<ImportSeedRequest, ImportSeedResponse>({
      id: `import_${sessionId}_${crypto.randomBytes(4).toString('hex')}`,
      op: DAEMON_OPS.IMPORT_SEED,
      sessionId,
      seed: normalizedEvents as any,
      receipt: seedReceipt as any,
      profile: profile as any,
      workspaceFolder: spaceId,
    });
  }

  public async instructionsRead(request: {
    target: 'global' | 'space';
    spaceFolder?: string;
    filename?: string;
  }): Promise<InstructionsReadResponse> {
    return this.request<InstructionsReadRequest, InstructionsReadResponse>({
      id: `inst_read_${crypto.randomBytes(4).toString('hex')}`,
      op: DAEMON_OPS.INSTRUCTIONS_READ,
      target: request.target,
      spaceFolder: request.spaceFolder,
      filename: request.filename as any,
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
      id: `inst_write_${crypto.randomBytes(4).toString('hex')}`,
      op: DAEMON_OPS.INSTRUCTIONS_WRITE,
      target: request.target,
      content: request.content,
      spaceFolder: request.spaceFolder,
      filename: request.filename as any,
      expectedEtag: request.expectedEtag,
      requireAbsent: request.requireAbsent,
    });
  }
}
