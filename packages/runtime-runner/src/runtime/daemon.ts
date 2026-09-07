/**
 * Persistent Runtime Runner Daemon Core for Enkeep
 *
 * Implements the production resident DSH Runtime Runner Daemon:
 * - Direct PID 1 in container (replaces idle sleep loop).
 * - Boots official DSH core runtime once per user container.
 * - AgentRegistry with LRU eviction (default max 16) and idle timeout (default 10m).
 * - Per-session FIFO queue with per-turn completion correlation (bypassing multi-turn whenIdle wait).
 * - Full turn journaling with idempotency & safe result deduplication ($DSH_HOME/daemon-turns/<turnId>.json).
 * - Concurrent multi-session scheduling bounded by maxConcurrentSessions (default 4).
 * - Approval state retention: agents waiting for approval are NEVER evicted.
 * - Profile/space/model change drain & recreation.
 * - Exclusive OS session lock held while agent is in memory.
 * - Real-time streaming push events for session events, chunks, and approvals.
 * - Graceful shutdown and signal handling.
 *
 * @module @enkeep/runtime-runner/runtime/daemon
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import EventEmitter from 'node:events';
import { type Context } from '@deepseek-ai/cordis';
import {
  createUserMessage,
} from '@deepseek-ai/dsh-llm';
import {
  SessionId,
  type SessionEvent,
} from '@deepseek-ai/dsh-session';
import {
  type Agent,
  type AgentHandle,
} from '@deepseek-ai/dsh-agent';
import {
  bootDshRuntime,
  isValidUserId,
  isValidSessionId,
  isValidTurnId,
  isNormalizedAbsolutePath,
  PersistedSessionResumeError,
  canonicalJsonStringify,
  computeSessionEventsChecksum,
  computeSessionSeedReceipt,
  extractTurnResultFromEvents,
  type DshRuntimeBootConfig,
  type DshBootedRuntime,
  type SessionSeedReceipt,
} from './dsh-boot.js';
import {
  type RuntimeCapabilitiesStatus,
  createDefaultCapabilitiesStatus,
} from './official-plugins.js';
import {
  acquireSessionLock,
  SessionBusyError,
  SessionLockError,
  isProcAvailable,
  isProcessAlive,
  type SessionLockHandle,
} from './session-lock.js';
import {
  validateAgentProfileSnapshot,
  installAgentProfile,
  AgentProfileSessionMismatchError,
  type AgentProfileSnapshot,
  type ValidatedAgentProfile,
} from './agent-profile.js';
import {
  executeFileOperation,
  executeInstructionsRead,
  executeInstructionsWrite,
  type FileOperationRequest,
  type FileOperationResult,
} from './file-ops.js';
import {
  DaemonTurnJournal,
  type JournalTurnRecord,
} from './daemon-journal.js';
import {
  DAEMON_OPS,
  DAEMON_ERROR_CODES,
  DAEMON_STREAM_EVENTS,
  DaemonProtocolError,
  type DaemonRequest,
  type DaemonResponse,
  type DaemonStreamEvent,
  type DaemonStats,
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
  type ShutdownRequest,
  type ShutdownResponse,
  type DaemonErrorResponse,
  type DaemonEvictionReason,
} from './daemon-protocol.js';
import type {
  AgentFollowupResponse,
  AgentFollowupCompletedResponse,
  AgentFollowupCancelledResponse,
  RuntimeHealthStatus,
  FallbackTarget,
} from '../transport/types.js';
import type { RuntimeMountSpec } from '../spec/types.js';
import { computeMountHash } from '../spec/mount-security.js';
import { computeExtensionPlanHash } from '../spec/extension-plan-security.js';
import {
  type ExtensionActivationPlan,
  validateExtensionActivationPlan,
} from '@enkeep/protocol';

export interface DaemonOptions extends DshRuntimeBootConfig {
  /** Maximum number of active agents held in memory (default: 16, or env DSH_MAX_AGENTS) */
  readonly maxAgents?: number;
  /** Idle agent timeout in ms before flush and eviction (default: 1,800,000 ms / 30 min, or env DSH_IDLE_AGENT_TIMEOUT_MS) */
  readonly idleAgentTimeoutMs?: number;
  /** Maximum concurrent executing sessions (default: 4, or env DSH_MAX_CONCURRENT_SESSIONS) */
  readonly maxConcurrentSessions?: number;
  /** Interval in ms for background idle sweep (default: 15,000 ms) */
  readonly idleSweepIntervalMs?: number;
}

export type AgentSessionStatus =
  | 'idle'
  | 'running'
  | 'waiting_approval'
  | 'draining'
  | 'disposed';

export interface QueuedTurnItem {
  readonly request: SubmitTurnRequest;
  readonly createdAt: number;
  readonly resolve: (result: AgentFollowupResponse) => void;
  readonly reject: (error: Error) => void;
  cancelled?: boolean;
  cancelReason?: string;
}

export interface ManagedAgentEntry {
  readonly sessionId: string;
  agent: Agent;
  agentHandle: AgentHandle;
  sessionLock: SessionLockHandle;
  workspaceFolder?: string;
  spacePath: string;
  profileHash?: string;
  mountHash?: string;
  mounts?: readonly RuntimeMountSpec[];
  extensionPlanHash?: string;
  extensionPlan?: ExtensionActivationPlan | null;
  lastUsed: number;
  status: AgentSessionStatus;
  pendingQueue: QueuedTurnItem[];
  currentTurn?: {
    turnId: string;
    item: QueuedTurnItem;
    startedAt: number;
    cancelRequested: boolean;
    abortController?: AbortController;
  };
}

/**
 * Production Resident DSH Runtime Runner Daemon.
 */
export class RuntimeDaemon extends EventEmitter {
  public readonly dshHome: string;
  public readonly spacesDir: string;
  public readonly userId: string;
  public readonly maxAgents: number;
  public readonly idleAgentTimeoutMs: number;
  public readonly maxConcurrentSessions: number;

  private readonly bootedRuntimePromise!: Promise<DshBootedRuntime>;
  private bootedRuntime!: DshBootedRuntime;
  private readonly journal: DaemonTurnJournal;
  private readonly agents = new Map<string, ManagedAgentEntry>();
  private readonly loadingAgents = new Map<string, Promise<ManagedAgentEntry>>();
  private readonly sessionQueues = new Map<string, QueuedTurnItem[]>();
  private readonly currentTurns = new Map<string, {
    turnId: string;
    item: QueuedTurnItem;
    startedAt: number;
    cancelRequested: boolean;
  }>();
  private readonly processingSessionQueues = new Set<string>();
  private readonly activeRunningSessions = new Set<string>();

  private isStarted = false;
  private isShuttingDown = false;
  private idleSweepTimer: NodeJS.Timeout | null = null;
  private evictionsCount = 0;
  private totalTurnsProcessed = 0;
  private readonly startedAt: number;

  // Unhandled rejection / turn event listener cleanups
  private eventRelayCleanup?: () => void;
  private pendingApprovalsTracker = new Map<string, { sessionId: string; toolName: string; approvalId: string }>();
  private readonly sessionMaintenanceLocks = new Map<string, Promise<void>>();

  constructor(private readonly options: DaemonOptions) {
    super();
    this.setMaxListeners(100);
    this.startedAt = Date.now();
    this.userId = options.userId;
    this.dshHome = options.dshHome;
    this.spacesDir = options.spacesDir;

    const envMaxAgents = process.env.DSH_MAX_AGENTS ? parseInt(process.env.DSH_MAX_AGENTS, 10) : NaN;
    this.maxAgents =
      options.maxAgents ?? (!isNaN(envMaxAgents) && envMaxAgents > 0 ? envMaxAgents : 16);

    const envIdleTimeout = process.env.DSH_IDLE_AGENT_TIMEOUT_MS
      ? parseInt(process.env.DSH_IDLE_AGENT_TIMEOUT_MS, 10)
      : NaN;
    this.idleAgentTimeoutMs =
      options.idleAgentTimeoutMs ?? (!isNaN(envIdleTimeout) && envIdleTimeout > 0 ? envIdleTimeout : 1_800_000);

    const envMaxConcurrent = process.env.DSH_MAX_CONCURRENT_SESSIONS
      ? parseInt(process.env.DSH_MAX_CONCURRENT_SESSIONS, 10)
      : NaN;
    this.maxConcurrentSessions =
      options.maxConcurrentSessions ??
      (!isNaN(envMaxConcurrent) && envMaxConcurrent > 0 ? envMaxConcurrent : 4);

    this.journal = new DaemonTurnJournal(this.dshHome);
  }

  private getOrCreateSessionQueue(sessionId: string): QueuedTurnItem[] {
    let queue = this.sessionQueues.get(sessionId);
    if (!queue) {
      queue = [];
      this.sessionQueues.set(sessionId, queue);
    }
    return queue;
  }

  /**
   * Boots the singleton DSH runtime and initializes daemon subsystems.
   */
  public async start(): Promise<void> {
    if (this.isStarted) return;

    // 1. Recover unclosed turn journals from previous crashes
    const recoveryResult = this.journal.recoverOnStartup();
    if (recoveryResult.unclosedCount > 0) {
      this.emit('log', {
        level: 'warn',
        message: `Recovered ${recoveryResult.recoveredCount} unclosed turn journals from previous daemon lifecycle`,
      });
    }

    // 2. Boot official DSH runtime once with strictly validated boot parameters
    const bootConfig: DshRuntimeBootConfig = {
      userId: this.options.userId,
      dshHome: this.options.dshHome,
      spacesDir: this.options.spacesDir,
      provider: this.options.provider,
      model: this.options.model,
      chunkDelayMs: this.options.chunkDelayMs,
      llmEnabled: this.options.llmEnabled,
      llmBaseUrl: this.options.llmBaseUrl,
      providers: this.options.providers,
      compaction: this.options.compaction,
      instructions: this.options.instructions,
      skills: this.options.skills,
      subagents: this.options.subagents,
      mounts: this.options.mounts,
      contextWindow: this.options.contextWindow,
      maxTokens: this.options.maxTokens,
      platformClient: this.options.platformClient,
    };
    this.bootedRuntime = await bootDshRuntime(bootConfig);

    // 3. Attach global Cordis event listener for real-time streaming to subscribers
    this.attachCordisListeners(this.bootedRuntime.context);

    // 4. Start background periodic idle sweep timer
    const sweepInterval =
      this.options.idleSweepIntervalMs ??
      Math.min(15_000, Math.max(200, Math.floor(this.idleAgentTimeoutMs / 2)));
    this.idleSweepTimer = setInterval(() => {
      this.sweepIdleAgents().catch(() => {});
    }, sweepInterval);
    if (this.idleSweepTimer && typeof this.idleSweepTimer.unref === 'function') {
      this.idleSweepTimer.unref();
    }

    this.isStarted = true;
  }

  /**
   * Subscribes to Cordis events to stream approval and session events in real time.
   */
  private attachCordisListeners(ctx: Context): void {
    const disposeSessionEvent = ctx.on('session/event', (subject: any, event: SessionEvent) => {
      const sessionIdStr = typeof subject?.id === 'string' ? subject.id : undefined;
      if (!sessionIdStr) return;

      const entry = this.agents.get(sessionIdStr);
      const turnId = this.currentTurns.get(sessionIdStr)?.turnId ?? entry?.currentTurn?.turnId;

      // Real-time session event stream push
      const streamEvent: DaemonStreamEvent = {
        type: 'event',
        event: DAEMON_STREAM_EVENTS.TURN_EVENT,
        sessionId: sessionIdStr,
        turnId: turnId ?? '',
        seq: event.seq,
        timestamp: Date.now(),
        sessionEvent: event,
      };
      this.emit('stream', streamEvent);

      // Handle approval/asked event
      if (event.type === 'approval/asked') {
        if (entry) {
          entry.status = 'waiting_approval';
        }
        const appData = event.data as any;
        const approvalPush: DaemonStreamEvent = {
          type: 'event',
          event: DAEMON_STREAM_EVENTS.APPROVAL_ASKED,
          sessionId: sessionIdStr,
          turnId,
          timestamp: Date.now(),
          approval: {
            id: appData?.id ?? '',
            toolName: appData?.toolName ?? '',
            risk: appData?.risk ?? 'medium',
            safeSummary: appData?.safeSummary ?? 'Approval requested',
            parameters: appData?.parameters,
          },
        };
        this.emit('stream', approvalPush);
      }

      // Handle approval/decided event
      if (event.type === 'approval/decided') {
        if (entry && entry.status === 'waiting_approval') {
          entry.status = 'running';
        }
        const decData = event.data as any;
        const decidedPush: DaemonStreamEvent = {
          type: 'event',
          event: DAEMON_STREAM_EVENTS.APPROVAL_DECIDED,
          sessionId: sessionIdStr,
          turnId,
          timestamp: Date.now(),
          decision: {
            id: decData?.id ?? '',
            outcome: decData?.outcome ?? '',
            reason: decData?.reason,
          },
        };
        this.emit('stream', decidedPush);
      }

      // Chunk streaming push
      if (event.type === 'assistant/chunk') {
        const chunkData = (event.data as any)?.chunk;
        if (chunkData && turnId) {
          const chunkPush: DaemonStreamEvent = {
            type: 'event',
            event: DAEMON_STREAM_EVENTS.TURN_CHUNK,
            turnId,
            sessionId: sessionIdStr,
            timestamp: Date.now(),
            chunk: chunkData,
          };
          this.emit('stream', chunkPush);
        }
      }
    });

    this.eventRelayCleanup = () => {
      disposeSessionEvent();
    };
  }

  /**
   * Main dispatch entry point for all RPC requests over stdio/IPC.
   */
  public async handleRequest(request: DaemonRequest): Promise<DaemonResponse> {
    if (!this.isStarted) {
      await this.start();
    }

    if (this.isShuttingDown && request.op !== DAEMON_OPS.HEALTH) {
      return {
        id: request.id,
        op: request.op,
        ok: false,
        error: {
          code: DAEMON_ERROR_CODES.SHUTTING_DOWN,
          message: 'Runtime Daemon is shutting down and rejecting new requests',
        },
      };
    }

    try {
      switch (request.op) {
        case DAEMON_OPS.SUBMIT_TURN:
          return await this.handleSubmitTurn(request as SubmitTurnRequest);

        case DAEMON_OPS.CANCEL:
          return await this.handleCancel(request as CancelRequest);

        case DAEMON_OPS.INSPECT_TURN:
          return this.handleInspectTurn(request as InspectTurnRequest);

        case DAEMON_OPS.HEALTH:
          return await this.handleHealth(request as HealthRequest);

        case DAEMON_OPS.CAPABILITIES:
          return await this.handleCapabilities(request as CapabilitiesRequest);

        case DAEMON_OPS.CHECK_SESSION_ARTIFACT:
          return await this.handleCheckSessionArtifact(request as CheckSessionArtifactRequest);

        case DAEMON_OPS.INSPECT_CORRUPTION:
          return await this.handleInspectCorruption(request as InspectCorruptionRequest);

        case DAEMON_OPS.RECOVER_PREFIX:
          return await this.handleRecoverPrefix(request as RecoverPrefixRequest);

        case DAEMON_OPS.EXPORT_FORK_SEED:
          return await this.handleExportForkSeed(request as ExportForkSeedRequest);

        case DAEMON_OPS.IMPORT_SEED:
          return await this.handleImportSeed(request as ImportSeedRequest);

        case DAEMON_OPS.FILE_OP:
          return await this.handleFileOp(request as FileOpDaemonRequest);

        case DAEMON_OPS.INSTRUCTIONS_READ:
          return await this.handleInstructionsRead(request as InstructionsReadRequest);

        case DAEMON_OPS.INSTRUCTIONS_WRITE:
          return await this.handleInstructionsWrite(request as InstructionsWriteRequest);

        case DAEMON_OPS.ANSWER_APPROVAL:
          return await this.handleAnswerApproval(request as AnswerApprovalRequest);

        case DAEMON_OPS.LIST_APPROVALS:
          return await this.handleListApprovals(request as ListApprovalsRequest);

        case DAEMON_OPS.SHUTDOWN:
          return await this.handleShutdown(request as ShutdownRequest);

        default: {
          const raw = request as any;
          return {
            id: raw.id ?? 'unknown',
            op: raw.op ?? 'unknown',
            ok: false,
            error: {
              code: DAEMON_ERROR_CODES.UNKNOWN_OP,
              message: `Unsupported daemon operation: "${raw.op}"`,
            },
          };
        }
      }
    } catch (err: unknown) {
      const code = (err as any)?.code || DAEMON_ERROR_CODES.INTERNAL_ERROR;
      const rawMessage = (err as any)?.message || 'Internal daemon execution error';
      // Sanitize message to never leak raw filesystem paths to public callers
      const sanitizedMessage = typeof rawMessage === 'string'
        ? rawMessage.replace(/(?:\/[a-zA-Z0-9_.\-]+)+/g, (p) =>
            p.startsWith('/tmp/') || p.includes('sessions') || p.includes('spaces') || p.includes('Users') || p.includes('home')
              ? '[path]'
              : p
          )
        : 'Internal daemon execution error';
      const raw = request as any;
      return {
        id: raw.id ?? 'unknown',
        op: raw.op ?? 'unknown',
        ok: false,
        error: {
          code,
          message: sanitizedMessage,
        },
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Operation Handlers
  // ---------------------------------------------------------------------------

  private async handleSubmitTurn(request: SubmitTurnRequest): Promise<SubmitTurnResponse | DaemonErrorResponse> {
    const { turnId, sessionId, prompt, workspaceFolder, spaceId } = request;
    const targetFolder = workspaceFolder ?? spaceId;

    if (!isValidTurnId(turnId)) {
      return {
        id: request.id,
        op: request.op,
        ok: false,
        error: {
          code: DAEMON_ERROR_CODES.INVALID_PARAMETERS,
          message: `Invalid turnId format: "${turnId}"`,
        },
      };
    }

    if (!isValidSessionId(sessionId)) {
      return {
        id: request.id,
        op: request.op,
        ok: false,
        error: {
          code: DAEMON_ERROR_CODES.INVALID_PARAMETERS,
          message: `Invalid sessionId format: "${sessionId}"`,
        },
      };
    }

    if (typeof prompt !== 'string') {
      return {
        id: request.id,
        op: request.op,
        ok: false,
        error: {
          code: DAEMON_ERROR_CODES.INVALID_PARAMETERS,
          message: 'prompt must be a string',
        },
      };
    }

    // 1. Check idempotency journal
    const existingRecord = this.journal.get(turnId);
    if (existingRecord) {
      if (existingRecord.status === 'completed' && existingRecord.result) {
        // Return completed result immediately via async stream push
        setImmediate(() => {
          this.emit('stream', {
            type: 'event',
            event: DAEMON_STREAM_EVENTS.TURN_COMPLETED,
            turnId,
            sessionId,
            timestamp: Date.now(),
            result: existingRecord.result!,
          });
        });
        return {
          id: request.id,
          op: 'submitTurn',
          ok: true,
          status: 'accepted',
          turnId,
          sessionId,
          queuePosition: 0,
        };
      }
      if (existingRecord.status === 'executing' || existingRecord.status === 'accepted') {
        // Attached to existing in-flight turn
        return {
          id: request.id,
          op: 'submitTurn',
          ok: true,
          status: 'accepted',
          turnId,
          sessionId,
          queuePosition: 0,
        };
      }
    }

    // 2. Validate transient extension activation plan if provided (fail-closed)
    let validatedExtensionPlan: ExtensionActivationPlan | null = null;
    if (request.extensionPlan !== undefined && request.extensionPlan !== null) {
      try {
        validatedExtensionPlan = validateExtensionActivationPlan(request.extensionPlan);
      } catch (valErr: unknown) {
        return {
          id: request.id,
          op: request.op,
          ok: false,
          error: {
            code: DAEMON_ERROR_CODES.INVALID_PARAMETERS,
            message: valErr instanceof Error ? valErr.message : String(valErr),
          },
        };
      }
    }

    // 3. Record accepted in journal atomically
    this.journal.recordAccepted({
      turnId,
      sessionId,
      prompt,
      workspaceFolder: targetFolder,
    });

    // 4. Enqueue in per-session FIFO queue atomically before returning/awaiting async Agent setup
    const queue = this.getOrCreateSessionQueue(sessionId);
    const hasActiveTurn = this.currentTurns.has(sessionId);
    const queuePosition = queue.length + (hasActiveTurn ? 1 : 0);

    const queuedItem: QueuedTurnItem = {
      request,
      createdAt: Date.now(),
      resolve: (result) => {
        if (result.status === 'completed') {
          this.emit('stream', {
            type: 'event',
            event: DAEMON_STREAM_EVENTS.TURN_COMPLETED,
            turnId,
            sessionId,
            timestamp: Date.now(),
            result,
          });
        } else if (result.status === 'cancelled') {
          this.emit('stream', {
            type: 'event',
            event: DAEMON_STREAM_EVENTS.TURN_CANCELLED,
            turnId,
            sessionId,
            timestamp: Date.now(),
            reason: 'Turn was cancelled',
          });
        }
      },
      reject: (err) => {
        this.emit('stream', {
          type: 'event',
          event: DAEMON_STREAM_EVENTS.TURN_FAILED,
          turnId,
          sessionId,
          timestamp: Date.now(),
          error: {
            code: (err as any)?.code || 'EXECUTION_FAILED',
            message: err.message,
          },
        });
      },
    };

    queue.push(queuedItem);

    // Warm up / ensure agent in memory
    let entry: ManagedAgentEntry;
    try {
      entry = await this.getOrCreateManagedAgent(
        sessionId,
        request.profileSnapshot ?? request.profile,
        targetFolder,
        request.mounts ?? undefined,
        validatedExtensionPlan
      );
      entry.lastUsed = Date.now();
    } catch (err: unknown) {
      const idx = queue.indexOf(queuedItem);
      if (idx !== -1) queue.splice(idx, 1);
      const isPluginErr = (err as any)?.code === 'PLUGIN_ACTIVATION_FAILED' || (err as any)?.message?.includes('PLUGIN_ACTIVATION_FAILED');
      const code = isPluginErr
        ? DAEMON_ERROR_CODES.PLUGIN_ACTIVATION_FAILED
        : err instanceof PersistedSessionResumeError
        ? 'PERSISTED_SESSION_RESUME_FAILED'
        : ((err as any)?.code || DAEMON_ERROR_CODES.AGENT_EXECUTION_FAILED);
      const message = isPluginErr ? 'PLUGIN_ACTIVATION_FAILED' : ((err as any)?.message || 'Failed to initialize agent for session');
      this.journal.recordFailed(turnId, sessionId, code, message);
      return {
        id: request.id,
        op: request.op,
        ok: false,
        error: {
          code,
          message,
        },
      };
    }

    if (queuedItem.cancelled) {
      return {
        id: request.id,
        op: 'submitTurn',
        ok: true,
        status: 'accepted',
        turnId,
        sessionId,
        queuePosition: 0,
      };
    }

    // Trigger session queue processor asynchronously
    setImmediate(() => {
      this.processSessionQueue(sessionId).catch(() => {});
    });

    return {
      id: request.id,
      op: 'submitTurn',
      ok: true,
      status: 'accepted',
      turnId,
      sessionId,
      queuePosition,
    };
  }

  /**
   * Direct asynchronous turn execution promise for deterministic test callers.
   */
  public async submitTurnAndWait(request: SubmitTurnRequest): Promise<AgentFollowupResponse> {
    const { turnId, sessionId } = request;

    // Fast path: if already completed in journal
    const existing = this.journal.get(turnId);
    if (existing?.status === 'completed' && existing.result) {
      return existing.result;
    }

    return new Promise<AgentFollowupResponse>((resolve, reject) => {
      const onStream = (ev: DaemonStreamEvent) => {
        if ('turnId' in ev && ev.turnId === turnId) {
          if (ev.event === DAEMON_STREAM_EVENTS.TURN_COMPLETED) {
            this.off('stream', onStream);
            resolve(ev.result);
          } else if (ev.event === DAEMON_STREAM_EVENTS.TURN_CANCELLED) {
            this.off('stream', onStream);
            resolve({
              sessionId,
              turnId,
              status: 'cancelled',
              eventsCount: 0,
              persisted: true,
            });
          } else if (ev.event === DAEMON_STREAM_EVENTS.TURN_FAILED) {
            this.off('stream', onStream);
            reject(new Error(ev.error.message));
          }
        }
      };
      this.on('stream', onStream);

      this.handleSubmitTurn(request).then(
        (res) => {
          if (!res.ok) {
            this.off('stream', onStream);
            reject(new Error(res.error?.message || 'Failed to submit turn'));
          }
        },
        (err) => {
          this.off('stream', onStream);
          reject(err);
        }
      );
    });
  }

  private async handleCancel(request: CancelRequest): Promise<CancelResponse | DaemonErrorResponse> {
    const { turnId, sessionId, reason } = request;

    let cancelled = false;

    if (turnId) {
      // 1. Check all session queues (whether agent is in memory or not!)
      for (const [sid, queue] of this.sessionQueues.entries()) {
        const queuedIdx = queue.findIndex((q) => q.request.turnId === turnId);
        if (queuedIdx !== -1) {
          const item = queue.splice(queuedIdx, 1)[0];
          item.cancelled = true;
          item.cancelReason = reason || 'Cancelled in queue by user';
          this.journal.recordCancelled(turnId, sid, item.cancelReason);
          const currentEntry = this.agents.get(sid);
          const eventsCount = currentEntry?.agent?.session?.seq ?? 0;
          item.resolve({
            sessionId: sid,
            turnId,
            status: 'cancelled',
            eventsCount,
            persisted: true,
          });
          this.emit('stream', {
            type: 'event',
            event: DAEMON_STREAM_EVENTS.TURN_CANCELLED,
            turnId,
            sessionId: sid,
            timestamp: Date.now(),
            reason: item.cancelReason,
          });
          cancelled = true;
          break;
        }
      }

      // 2. Check all running turns
      if (!cancelled) {
        for (const [sid, cur] of this.currentTurns.entries()) {
          if (cur.turnId === turnId) {
            cur.cancelRequested = true;
            const entry = this.agents.get(sid);
            if (entry?.agent) {
              entry.agent.cancel({ kind: 'user' });
            } else if (this.bootedRuntime) {
              this.bootedRuntime.cancelTurn(turnId).catch(() => {});
            }
            cancelled = true;
            break;
          }
        }
      }

      if (!cancelled) {
        return {
          id: request.id,
          op: 'cancel',
          ok: false,
          error: {
            code: DAEMON_ERROR_CODES.TURN_NOT_FOUND,
            message: `Turn "${turnId}" not found for cancellation`,
          },
        };
      }
    } else if (sessionId) {
      // Cancel all queued turns for session and abort running turn
      const queue = this.sessionQueues.get(sessionId);
      if (queue) {
        while (queue.length > 0) {
          const item = queue.shift()!;
          item.cancelled = true;
          item.cancelReason = reason || 'Session cancelled by user';
          this.journal.recordCancelled(item.request.turnId, sessionId, item.cancelReason);
          const currentEntry = this.agents.get(sessionId);
          const eventsCount = currentEntry?.agent?.session?.seq ?? 0;
          item.resolve({
            sessionId,
            turnId: item.request.turnId,
            status: 'cancelled',
            eventsCount,
            persisted: true,
          });
          this.emit('stream', {
            type: 'event',
            event: DAEMON_STREAM_EVENTS.TURN_CANCELLED,
            turnId: item.request.turnId,
            sessionId,
            timestamp: Date.now(),
            reason: item.cancelReason,
          });
          cancelled = true;
        }
      }
      const cur = this.currentTurns.get(sessionId);
      if (cur) {
        cur.cancelRequested = true;
        const entry = this.agents.get(sessionId);
        if (entry?.agent) {
          entry.agent.cancel({ kind: 'user' });
        } else if (this.bootedRuntime) {
          this.bootedRuntime.cancelTurn(cur.turnId).catch(() => {});
        }
        cancelled = true;
      }
    }

    return {
      id: request.id,
      op: 'cancel',
      ok: true,
      cancelled,
      turnId,
      sessionId,
    };
  }

  private handleInspectTurn(request: InspectTurnRequest): InspectTurnResponse | DaemonErrorResponse {
    const { turnId } = request;
    if (!isValidTurnId(turnId)) {
      return {
        id: request.id,
        op: request.op,
        ok: false,
        error: {
          code: DAEMON_ERROR_CODES.INVALID_PARAMETERS,
          message: `Invalid turnId: "${turnId}"`,
        },
      };
    }

    const record = this.journal.get(turnId);
    if (!record) {
      return {
        id: request.id,
        op: request.op,
        ok: false,
        error: {
          code: DAEMON_ERROR_CODES.TURN_NOT_FOUND,
          message: `Turn "${turnId}" not found in journal`,
        },
      };
    }

    return {
      id: request.id,
      op: 'inspectTurn',
      ok: true,
      turnId: record.turnId,
      sessionId: record.sessionId,
      journalStatus: record.status,
      result: record.result,
      error: record.error,
    };
  }

  private async handleHealth(request: HealthRequest): Promise<HealthResponse> {
    const rawHealth = await this.bootedRuntime.getHealth();
    let pendingTurnsCount = 0;
    const allMounts: RuntimeMountSpec[] = [];
    const seenMountIds = new Set<string>();

    if (Array.isArray(this.options.mounts)) {
      for (const m of this.options.mounts) {
        if (!seenMountIds.has(m.id)) {
          seenMountIds.add(m.id);
          allMounts.push(m);
        }
      }
    }

    for (const queue of this.sessionQueues.values()) {
      pendingTurnsCount += queue.length;
    }
    pendingTurnsCount += this.currentTurns.size;

    for (const entry of this.agents.values()) {
      if (entry.mounts) {
        for (const m of entry.mounts) {
          if (!seenMountIds.has(m.id)) {
            seenMountIds.add(m.id);
            allMounts.push(m);
          }
        }
      }
    }

    const mountHash = computeMountHash(allMounts);

    const stats: DaemonStats = {
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      activeAgentsCount: this.agents.size,
      runningSessionsCount: this.activeRunningSessions.size,
      pendingTurnsCount,
      evictionsCount: this.evictionsCount,
      totalTurnsProcessed: this.totalTurnsProcessed,
      maxAgents: this.maxAgents,
      idleAgentTimeoutMs: this.idleAgentTimeoutMs,
      maxConcurrentSessions: this.maxConcurrentSessions,
    };

    return {
      id: request.id,
      op: 'health',
      ok: true,
      health: {
        ...rawHealth,
        mountHash,
        mountGeneration: 1,
      },
      stats,
    };
  }

  private async handleCapabilities(request: CapabilitiesRequest): Promise<CapabilitiesResponse> {
    const capabilities: RuntimeCapabilitiesStatus = this.bootedRuntime.getCapabilities
      ? await this.bootedRuntime.getCapabilities()
      : createDefaultCapabilitiesStatus();

    return {
      id: request.id,
      op: 'capabilities',
      ok: true,
      capabilities,
    };
  }

  private async handleCheckSessionArtifact(
    request: CheckSessionArtifactRequest
  ): Promise<CheckSessionArtifactResponse> {
    return this.withSessionMaintenance(request.sessionId, async () => {
      const check = await this.bootedRuntime.checkSessionArtifact(request.sessionId, request.workspaceFolder);
      if (!check.valid) {
        await this.evictAgent(request.sessionId, 'space_mismatch');
      }
      return {
        id: request.id,
        op: 'checkSessionArtifact',
        ok: true,
        exists: check.exists,
        valid: check.valid,
        checksum: check.checksum,
        eventCount: check.eventCount,
      };
    });
  }

  private async handleInspectCorruption(request: InspectCorruptionRequest): Promise<InspectCorruptionResponse> {
    return this.withSessionMaintenance(request.sessionId, async () => {
      const res = await this.bootedRuntime.inspectSessionCorruption(request.sessionId, request.workspaceFolder);
      if (res.corrupted || res.code !== 'VALID') {
        await this.evictAgent(request.sessionId, 'space_mismatch');
      }
      return {
        id: request.id,
        op: 'inspectCorruption',
        ok: true,
        ...res,
      };
    });
  }

  private async handleRecoverPrefix(request: RecoverPrefixRequest): Promise<RecoverPrefixResponse> {
    return this.withSessionMaintenance(request.sourceSessionId, async () => {
      return this.withSessionMaintenance(request.targetSessionId, async () => {
        const res = await this.bootedRuntime.recoverSessionPrefix({
          sourceSessionId: request.sourceSessionId,
          targetSessionId: request.targetSessionId,
          maxValidSeq: request.maxValidSeq,
          workspaceFolder: request.workspaceFolder,
        });
        return {
          id: request.id,
          op: 'recoverPrefix',
          ok: true,
          ...res,
        };
      }, { evict: true });
    }, { evict: true });
  }

  private async handleExportForkSeed(request: ExportForkSeedRequest): Promise<ExportForkSeedResponse | DaemonErrorResponse> {
    return this.withSessionMaintenance(request.sessionId, async () => {
      try {
        const res = await this.bootedRuntime.exportForkSeed(
          request.sessionId,
          request.boundary,
          request.workspaceFolder
        );
        return {
          id: request.id,
          op: 'exportForkSeed',
          ok: true,
          events: res.events,
          receipt: res.receipt,
          boundaryMapping: res.boundaryMapping,
        };
      } catch (err: unknown) {
        const errMsg = (err as any)?.message || 'Export fork seed failed';
        const code = errMsg === 'BOUNDARY_UNAVAILABLE'
          ? 'BOUNDARY_UNAVAILABLE'
          : (errMsg === 'SESSION_NOT_FOUND' ? 'NOT_FOUND' : 'EXPORT_FAILED');
        return {
          id: request.id,
          op: 'exportForkSeed',
          ok: false,
          error: {
            code,
            message: errMsg,
          },
        };
      }
    });
  }

  private async handleImportSeed(request: ImportSeedRequest): Promise<ImportSeedResponse> {
    return this.withSessionMaintenance(request.sessionId, async () => {
      const seedEvents = (request.seed ?? []) as readonly SessionEvent[];
      const seedReceipt: SessionSeedReceipt =
        request.receipt && typeof request.receipt === 'object'
          ? (request.receipt as SessionSeedReceipt)
          : computeSessionSeedReceipt(seedEvents);

      const res = await this.bootedRuntime.importSeed(
        request.sessionId,
        seedEvents,
        seedReceipt,
        request.profileSnapshot ?? request.profile,
        request.workspaceFolder
      );

      return {
        id: request.id,
        op: 'importSeed',
        ok: true,
        sessionId: res.sessionId,
        persisted: res.persisted,
        eventsCount: res.eventsCount,
        receipt: res.receipt,
        duplicate: res.duplicate,
      };
    }, { evict: true });
  }

  private async handleFileOp(request: FileOpDaemonRequest): Promise<FileOpDaemonResponse> {
    const rawOp = request.fileOp as any;
    // Map legacy spaceId -> space if present
    const normalizedReq = {
      ...rawOp,
      space: rawOp.space ?? rawOp.spaceId,
    };
    if ('spaceId' in normalizedReq && normalizedReq.spaceId === normalizedReq.space) {
      delete normalizedReq.spaceId;
    }
    const procReader = !isProcAvailable()
      ? (pid: number) => (isProcessAlive(pid) ? { starttime: '12345' } : null)
      : undefined;

    const res = executeFileOperation(normalizedReq, {
      spacesDir: this.spacesDir,
      lockDir: path.join(this.dshHome, '.enkeep-file-locks'),
      expectedUid: typeof process.getuid === 'function' ? process.getuid() : 1000,
      procStatReader: procReader,
    });
    return {
      id: request.id,
      op: 'fileOp',
      ok: true,
      fileResult: res,
    };
  }

  private async handleInstructionsRead(request: InstructionsReadRequest): Promise<InstructionsReadResponse> {
    const res = executeInstructionsRead(
      {
        target: request.target,
        spaceFolder: request.spaceFolder,
        filename: request.filename,
      },
      {
        spacesDir: this.spacesDir,
        dshHome: this.dshHome,
        expectedUid: typeof process.getuid === 'function' ? process.getuid() : 1000,
      }
    );

    return {
      id: request.id,
      op: 'instructionsRead',
      ok: true,
      content: res.content,
      etag: res.etag,
      exists: res.exists,
      size: res.size,
      mtimeMs: res.mtimeMs,
      target: res.target,
      filename: res.filename,
    };
  }

  private async handleInstructionsWrite(request: InstructionsWriteRequest): Promise<InstructionsWriteResponse> {
    const res = executeInstructionsWrite(
      {
        target: request.target,
        content: request.content,
        spaceFolder: request.spaceFolder,
        filename: request.filename,
        expectedEtag: request.expectedEtag,
        requireAbsent: request.requireAbsent,
      },
      {
        spacesDir: this.spacesDir,
        dshHome: this.dshHome,
        expectedUid: typeof process.getuid === 'function' ? process.getuid() : 1000,
      }
    );

    // Note: Writing does NOT evict agents; official DSH agent-instructions pre-step watcher detects changes on next turn
    return {
      id: request.id,
      op: 'instructionsWrite',
      ok: true,
      etag: res.etag,
      size: res.size,
      mtimeMs: res.mtimeMs,
      target: res.target,
      filename: res.filename,
    };
  }

  private async handleAnswerApproval(request: AnswerApprovalRequest): Promise<AnswerApprovalResponse> {
    const extInteraction = (this.bootedRuntime.context as any).externalInteraction ??
      (this.bootedRuntime.context.get ? this.bootedRuntime.context.get('externalInteraction') : undefined);

    if (!extInteraction || typeof extInteraction.answerApproval !== 'function') {
      throw new Error('ExternalInteraction approval service is not available');
    }

    const outcome = request.decision === 'allowed-always' ? 'allowed-once' : request.decision;
    const answered = extInteraction.answerApproval(request.approvalId, outcome, request.reason);
    return {
      id: request.id,
      op: 'answerApproval',
      ok: true,
      answered: Boolean(answered),
      approvalId: request.approvalId,
    };
  }

  private async handleListApprovals(request: ListApprovalsRequest): Promise<ListApprovalsResponse> {
    const extInteraction = (this.bootedRuntime.context as any).externalInteraction ??
      (this.bootedRuntime.context.get ? this.bootedRuntime.context.get('externalInteraction') : undefined);

    if (!extInteraction || typeof extInteraction.listPendingApprovals !== 'function') {
      return {
        id: request.id,
        op: 'listApprovals',
        ok: true,
        approvals: [],
      };
    }

    const list = extInteraction.listPendingApprovals(request.sessionId);
    return {
      id: request.id,
      op: 'listApprovals',
      ok: true,
      approvals: list,
    };
  }

  private async handleShutdown(request: ShutdownRequest): Promise<ShutdownResponse> {
    const drainTimeout = request.drainTimeoutMs ?? 5000;
    setImmediate(() => {
      this.shutdown(drainTimeout).catch(() => {});
    });

    return {
      id: request.id,
      op: 'shutdown',
      ok: true,
      status: 'shutting_down',
    };
  }

  // ---------------------------------------------------------------------------
  // Agent Lifecycle, Concurrency & FIFO Queue Scheduler
  // ---------------------------------------------------------------------------

  /**
   * Retrieves or instantiates a managed agent for the given session ID,
   * acquiring the OS session lock and tracking LRU.
   */
  private async getOrCreateManagedAgent(
    sessionId: string,
    profileSnapshot?: AgentProfileSnapshot | null,
    workspaceFolder?: string,
    mounts?: readonly RuntimeMountSpec[],
    extensionPlan?: ExtensionActivationPlan | null
  ): Promise<ManagedAgentEntry> {
    const existing = this.agents.get(sessionId);
    if (existing) {
      return this.verifyAndReturnExistingAgent(existing, profileSnapshot, workspaceFolder, mounts, extensionPlan);
    }

    const inFlight = this.loadingAgents.get(sessionId);
    if (inFlight) {
      return await inFlight;
    }

    const loadPromise = this.doCreateManagedAgent(sessionId, profileSnapshot, workspaceFolder, mounts, extensionPlan);
    this.loadingAgents.set(sessionId, loadPromise);

    try {
      const entry = await loadPromise;
      return entry;
    } finally {
      this.loadingAgents.delete(sessionId);
    }
  }

  private async verifyAndReturnExistingAgent(
    existing: ManagedAgentEntry,
    profileSnapshot?: AgentProfileSnapshot | null,
    workspaceFolder?: string,
    mounts?: readonly RuntimeMountSpec[],
    extensionPlan?: ExtensionActivationPlan | null
  ): Promise<ManagedAgentEntry> {
    let validatedProfile: ValidatedAgentProfile | undefined;
    if (profileSnapshot) {
      validatedProfile = validateAgentProfileSnapshot(profileSnapshot);
    }

    let profileMismatch = false;
    if (validatedProfile && existing.profileHash && existing.profileHash !== validatedProfile.promptHash) {
      profileMismatch = true;
    }
    let workspaceMismatch = false;
    if (workspaceFolder && existing.workspaceFolder && existing.workspaceFolder !== workspaceFolder) {
      workspaceMismatch = true;
    }

    let mountMismatch = false;
    if (mounts !== undefined) {
      const newMountHash = computeMountHash(mounts);
      const oldMountHash = existing.mountHash ?? computeMountHash([]);
      if (oldMountHash !== newMountHash) {
        mountMismatch = true;
      }
    }

    let extensionPlanMismatch = false;
    let validatedExtensionPlan: ExtensionActivationPlan | null = null;
    if (extensionPlan !== undefined) {
      if (extensionPlan !== null) {
        validatedExtensionPlan = validateExtensionActivationPlan(extensionPlan);
      }
      const newPlanHash = computeExtensionPlanHash(validatedExtensionPlan);
      const oldPlanHash = existing.extensionPlanHash ?? computeExtensionPlanHash(null);
      if (oldPlanHash !== newPlanHash) {
        extensionPlanMismatch = true;
      }
    }

    if (profileMismatch || workspaceMismatch || mountMismatch) {
      // If agent is active / has pending turns: drain after current turn
      const queue = this.sessionQueues.get(existing.sessionId);
      const queueLen = queue ? queue.length : 0;
      if (existing.status === 'running' || queueLen > 0 || this.currentTurns.has(existing.sessionId)) {
        existing.status = 'draining';
      } else {
        const reason = mountMismatch
          ? 'mount_mismatch'
          : (profileMismatch ? 'profile_mismatch' : 'space_mismatch');
        await this.evictAgent(existing.sessionId, reason);
        return this.getOrCreateManagedAgent(existing.sessionId, profileSnapshot, workspaceFolder, mounts, extensionPlan);
      }
    } else if (extensionPlanMismatch) {
      if (this.bootedRuntime?.getOrCreateAgent) {
        await this.bootedRuntime.getOrCreateAgent(existing.sessionId, profileSnapshot, workspaceFolder, mounts, validatedExtensionPlan);
      }
      existing.extensionPlan = validatedExtensionPlan;
      existing.extensionPlanHash = computeExtensionPlanHash(validatedExtensionPlan);
      existing.lastUsed = Date.now();
    } else {
      existing.lastUsed = Date.now();
    }
    return existing;
  }

  private async doCreateManagedAgent(
    sessionId: string,
    profileSnapshot?: AgentProfileSnapshot | null,
    workspaceFolder?: string,
    mounts?: readonly RuntimeMountSpec[],
    extensionPlan?: ExtensionActivationPlan | null
  ): Promise<ManagedAgentEntry> {
    let validatedProfile: ValidatedAgentProfile | undefined;
    if (profileSnapshot) {
      validatedProfile = validateAgentProfileSnapshot(profileSnapshot);
    }

    let validatedExtensionPlan: ExtensionActivationPlan | null = null;
    if (extensionPlan !== undefined && extensionPlan !== null) {
      validatedExtensionPlan = validateExtensionActivationPlan(extensionPlan);
    }

    // Check LRU capacity and evict least recently used idle agent if needed
    await this.ensureLruCapacity();

    // Acquire OS session lock (held continuously while Agent is in memory)
    const sessionLock = await acquireSessionLock({
      dshHome: this.dshHome,
      sessionId,
      action: 'daemon-managed-agent',
      timeoutMs: 5000,
    });

    try {
      // Boot / resume agent via runtime core with controlled mounts and extension plan
      const agent = await this.bootedRuntime.getOrCreateAgent(
        sessionId,
        profileSnapshot,
        workspaceFolder,
        mounts,
        validatedExtensionPlan
      );
      const agentHandle = this.bootedRuntime.agentHandles?.get(sessionId);

      if (!agentHandle) {
        throw new Error(`Failed to resolve AgentHandle for resumed session "${sessionId}"`);
      }

      const spacePath = ((agent.session.header as any)?.meta as any)?.cwd || path.join(this.spacesDir, workspaceFolder || '');
      const mountHash = computeMountHash(mounts);
      const extensionPlanHash = computeExtensionPlanHash(validatedExtensionPlan);

      const queue = this.getOrCreateSessionQueue(sessionId);
      const curTurn = this.currentTurns.get(sessionId);

      const entry: ManagedAgentEntry = {
        sessionId,
        agent,
        agentHandle,
        sessionLock,
        workspaceFolder,
        spacePath,
        profileHash: validatedProfile?.promptHash,
        mountHash,
        mounts,
        extensionPlanHash,
        extensionPlan: validatedExtensionPlan,
        lastUsed: Date.now(),
        status: 'idle',
        pendingQueue: queue,
        currentTurn: curTurn,
      };

      this.agents.set(sessionId, entry);
      return entry;
    } catch (err: unknown) {
      sessionLock.release();
      throw err;
    }
  }

  /**
   * Processes the next pending turn in the per-session FIFO queue.
   */
  private async processSessionQueue(sessionId: string): Promise<void> {
    if (this.isShuttingDown) return;

    // Mutex: only one queue processor active per session at a time
    if (this.processingSessionQueues.has(sessionId)) {
      return;
    }

    const queue = this.getOrCreateSessionQueue(sessionId);
    if (queue.length === 0 || this.currentTurns.has(sessionId)) {
      return;
    }

    // Check concurrency limit across all sessions
    if (this.activeRunningSessions.size >= this.maxConcurrentSessions) {
      return;
    }

    this.processingSessionQueues.add(sessionId);

    try {
      // Drain any cancelled items at head of queue
      while (queue.length > 0 && queue[0].cancelled) {
        queue.shift();
      }
      if (queue.length === 0) {
        return;
      }

      const item = queue[0];
      const { request } = item;
      const { turnId } = request;

      // Check if queued turn requires a different profile or workspace configuration
      const targetFolder = request.workspaceFolder ?? request.spaceId;
      const reqProfile = request.profileSnapshot ?? request.profile;
      let validatedReqProfile: ValidatedAgentProfile | undefined;
      if (reqProfile) {
        validatedReqProfile = validateAgentProfileSnapshot(reqProfile);
      }

      let validatedReqPlan: ExtensionActivationPlan | null = null;
      if (request.extensionPlan !== undefined && request.extensionPlan !== null) {
        validatedReqPlan = validateExtensionActivationPlan(request.extensionPlan);
      }
      const reqMounts = request.mounts ?? undefined;

      let entry: ManagedAgentEntry;
      try {
        let existing = this.agents.get(sessionId);
        if (existing) {
          const profileDiffers = Boolean(
            validatedReqProfile && existing.profileHash && existing.profileHash !== validatedReqProfile.promptHash
          );
          const workspaceDiffers = Boolean(
            targetFolder && existing.workspaceFolder && existing.workspaceFolder !== targetFolder
          );
          const mountDiffers = Boolean(
            reqMounts !== undefined && (existing.mountHash ?? computeMountHash([])) !== computeMountHash(reqMounts)
          );
          const planDiffers = Boolean(
            request.extensionPlan !== undefined && (existing.extensionPlanHash ?? computeExtensionPlanHash(null)) !== computeExtensionPlanHash(validatedReqPlan)
          );

          if (profileDiffers || workspaceDiffers || mountDiffers) {
            await this.evictAgent(sessionId, mountDiffers ? 'mount_mismatch' : (profileDiffers ? 'profile_mismatch' : 'space_mismatch'));
            entry = await this.getOrCreateManagedAgent(sessionId, reqProfile, targetFolder, reqMounts, validatedReqPlan);
          } else if (planDiffers) {
            entry = await this.getOrCreateManagedAgent(sessionId, reqProfile, targetFolder, reqMounts, validatedReqPlan);
            entry.extensionPlan = validatedReqPlan;
            entry.extensionPlanHash = computeExtensionPlanHash(validatedReqPlan);
          } else {
            entry = existing;
            entry.lastUsed = Date.now();
          }
        } else {
          entry = await this.getOrCreateManagedAgent(sessionId, reqProfile, targetFolder, reqMounts, validatedReqPlan);
        }
      } catch (prepErr: unknown) {
        const idx = queue.indexOf(item);
        if (idx !== -1) queue.splice(idx, 1);
        const isPluginErr = (prepErr as any)?.code === 'PLUGIN_ACTIVATION_FAILED' || (prepErr as any)?.message?.includes('PLUGIN_ACTIVATION_FAILED');
        const errCode = isPluginErr ? DAEMON_ERROR_CODES.PLUGIN_ACTIVATION_FAILED : DAEMON_ERROR_CODES.AGENT_EXECUTION_FAILED;
        const errMsg = isPluginErr ? 'PLUGIN_ACTIVATION_FAILED' : (prepErr instanceof Error ? prepErr.message : String(prepErr));
        this.journal.recordFailed(turnId, sessionId, errCode, errMsg);
        const failError = new Error(errMsg);
        (failError as any).code = errCode;
        item.reject(failError);
        return;
      }

      if (item.cancelled || this.isShuttingDown) {
        const idx = queue.indexOf(item);
        if (idx !== -1) queue.splice(idx, 1);
        return;
      }

      // Dequeue item
      const itemIdx = queue.indexOf(item);
      if (itemIdx !== -1) {
        queue.splice(itemIdx, 1);
      }

      const curTurnInfo = {
        turnId,
        item,
        startedAt: Date.now(),
        cancelRequested: false,
      };

      this.currentTurns.set(sessionId, curTurnInfo);
      entry.currentTurn = curTurnInfo;
      this.activeRunningSessions.add(sessionId);
      entry.status = 'running';
      entry.lastUsed = Date.now();

      // Journal status -> executing
      this.journal.recordExecuting(turnId, sessionId);

      this.emit('stream', {
        type: 'event',
        event: DAEMON_STREAM_EVENTS.TURN_STARTED,
        turnId,
        sessionId,
        timestamp: Date.now(),
      });

      const beforeEventsCount = entry.agent.session.seq;

      try {
        // Execute turn via runtime core sendFollowup with turn correlation and model selection
        const response = await this.bootedRuntime.sendFollowup({
          prompt: request.prompt,
          sessionId,
          turnId,
          profileSnapshot: request.profileSnapshot ?? request.profile ?? null,
          workspaceFolder: request.workspaceFolder ?? request.spaceId,
          attachments: request.attachments,
          modelSelection: request.modelSelection,
          replyReference: request.replyReference ?? null,
          timeoutMs: request.timeoutMs,
          mounts: request.mounts ?? undefined,
          extensionPlan: validatedReqPlan,
        });

        // Independently derive authoritative turn result from events occurring after beforeEventsCount
        const turnResult = this.bootedRuntime.getTurnResultAfterSeq?.(sessionId, beforeEventsCount) ??
          extractTurnResultFromEvents(entry.agent.session.snapshotEvents(), beforeEventsCount);

        if (response.status === 'completed' && turnResult?.replyText && turnResult.replyText.trim().length > 0) {
          response.replyText = turnResult.replyText;
        }

        // Record completion in journal
        if (response.status === 'completed') {
          this.journal.recordCompleted(turnId, sessionId, response);
        } else {
          this.journal.recordCancelled(turnId, sessionId, 'Turn was cancelled by user');
        }

        this.totalTurnsProcessed++;
        item.resolve(response);
      } catch (err: unknown) {
        const isPluginErr = (err as any)?.code === 'PLUGIN_ACTIVATION_FAILED' || (err as any)?.message?.includes('PLUGIN_ACTIVATION_FAILED');
        const errCode = isPluginErr ? 'PLUGIN_ACTIVATION_FAILED' : 'EXECUTION_ERROR';
        const errMsg = isPluginErr ? 'PLUGIN_ACTIVATION_FAILED' : (err instanceof Error ? err.message : String(err || 'Turn execution failed'));
        this.journal.recordFailed(turnId, sessionId, errCode, errMsg);
        const rejectErr = new Error(errMsg);
        (rejectErr as any).code = errCode;
        item.reject(rejectErr);
      } finally {
        entry.currentTurn = undefined;
        this.currentTurns.delete(sessionId);
        this.activeRunningSessions.delete(sessionId);

        // Check if agent was marked for draining due to profile/space change
        if ((entry.status as AgentSessionStatus) === 'draining' && queue.length === 0) {
          await this.evictAgent(sessionId, 'profile_mismatch');
        } else if ((entry.status as AgentSessionStatus) !== 'waiting_approval') {
          entry.status = 'idle';
          entry.lastUsed = Date.now();
        }
      }
    } finally {
      this.processingSessionQueues.delete(sessionId);

      // Schedule next turns across sessions
      setImmediate(() => {
        this.scheduleNextTurns();
      });
    }
  }

  /**
   * Schedules any pending turns across all available sessions up to maxConcurrentSessions.
   */
  private scheduleNextTurns(): void {
    if (this.isShuttingDown) return;
    if (this.activeRunningSessions.size >= this.maxConcurrentSessions) {
      return;
    }

    for (const [sessionId, queue] of this.sessionQueues.entries()) {
      if (!this.currentTurns.has(sessionId) && queue.length > 0 && !this.processingSessionQueues.has(sessionId)) {
        this.processSessionQueue(sessionId).catch(() => {});
        if (this.activeRunningSessions.size >= this.maxConcurrentSessions) {
          break;
        }
      }
    }
  }

  /**
   * Ensures agent registry capacity does not exceed maxAgents by evicting idle agents.
   */
  private async ensureLruCapacity(): Promise<void> {
    if (this.agents.size < this.maxAgents) {
      return;
    }

    // Find the least recently used agent that is strictly idle
    let oldestSid: string | null = null;
    let oldestTime = Infinity;

    for (const [sid, entry] of this.agents.entries()) {
      const queue = this.sessionQueues.get(sid);
      const queueLen = queue ? queue.length : 0;
      if (entry.status === 'idle' && !entry.currentTurn && !this.currentTurns.has(sid) && queueLen === 0) {
        if (entry.lastUsed < oldestTime) {
          oldestTime = entry.lastUsed;
          oldestSid = sid;
        }
      }
    }

    if (oldestSid) {
      await this.evictAgent(oldestSid, 'lru_capacity');
    }
  }

  /**
   * Periodic sweep: evicts agents that have been idle longer than idleAgentTimeoutMs.
   */
  private async sweepIdleAgents(): Promise<void> {
    const now = Date.now();
    const toEvict: string[] = [];

    for (const [sid, entry] of this.agents.entries()) {
      const queue = this.sessionQueues.get(sid);
      const queueLen = queue ? queue.length : 0;
      if (
        entry.status === 'idle' &&
        !entry.currentTurn &&
        !this.currentTurns.has(sid) &&
        queueLen === 0 &&
        now - entry.lastUsed >= this.idleAgentTimeoutMs
      ) {
        toEvict.push(sid);
      }
    }

    for (const sid of toEvict) {
      await this.evictAgent(sid, 'idle_timeout');
    }
  }

  /**
   * Serializes maintenance operations (check, inspect, recover, export, import)
   * on a session by pausing new turns, draining any in-flight turn, flushing/evicting
   * if needed, and safely executing the maintenance action without nested locks.
   */
  public async withSessionMaintenance<T>(
    sessionId: string,
    action: () => Promise<T>,
    options: { evict?: boolean } = {}
  ): Promise<T> {
    // 0. Serialize maintenance operations per session ID (FIFO mutex queue)
    while (this.sessionMaintenanceLocks.has(sessionId)) {
      try {
        await this.sessionMaintenanceLocks.get(sessionId);
      } catch {}
    }

    let releaseLock: () => void = () => {};
    const lockPromise = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    this.sessionMaintenanceLocks.set(sessionId, lockPromise);

    try {
      const entry = this.agents.get(sessionId);

      if (entry) {
        // 1. Mark status draining so new turns won't start immediately
        const prevStatus = entry.status;
        if (entry.status !== 'waiting_approval') {
          entry.status = 'draining';
        }

        // 2. If a turn is currently executing, wait bounded for it to complete
        if (entry.currentTurn || this.currentTurns.has(sessionId)) {
          const timeoutMs = 15_000;
          const start = Date.now();
          while ((entry.currentTurn || this.currentTurns.has(sessionId)) && Date.now() - start < timeoutMs) {
            await new Promise((r) => setTimeout(r, 50));
          }
        }

        // 3. Flush session persistence
        if (this.bootedRuntime?.context?.sessions?.flush) {
          try {
            await this.bootedRuntime.context.sessions.flush(entry.agent.session);
          } catch {}
        }

        // 4. If eviction requested (e.g. importSeed or recoverSessionPrefix), evict and release lock
        if (options.evict) {
          if (entry.currentTurn || this.currentTurns.has(sessionId)) {
            throw new DaemonProtocolError(
              DAEMON_ERROR_CODES.SESSION_BUSY,
              `Session "${sessionId}" is currently executing an active turn and cannot be evicted for maintenance`
            );
          }
          await this.evictAgent(sessionId, 'profile_mismatch');
        } else {
          if (entry.status === 'draining') {
            entry.status = prevStatus === 'running' ? 'idle' : prevStatus;
          }
        }
      }

      const result = await action();
      return result;
    } finally {
      if (this.sessionMaintenanceLocks.get(sessionId) === lockPromise) {
        this.sessionMaintenanceLocks.delete(sessionId);
      }
      releaseLock();

      // Lazy resume queue for this session if has queued turns
      const queue = this.sessionQueues.get(sessionId);
      if (queue && queue.length > 0 && !this.currentTurns.has(sessionId)) {
        setImmediate(() => {
          this.processSessionQueue(sessionId).catch(() => {});
        });
      }
    }
  }

  /**
   * Evicts a single managed agent: flushes session persistence, disposes handle, and releases lock.
   */
  private async evictAgent(
    sessionId: string,
    reason: DaemonEvictionReason
  ): Promise<void> {
    const entry = this.agents.get(sessionId);
    if (!entry) return;

    // Safety guard: Never evict an agent waiting for approval or currently running
    if (entry.status === 'waiting_approval' || entry.currentTurn || this.currentTurns.has(sessionId)) {
      return;
    }

    try {
      // 1. Flush official session persistence
      await this.bootedRuntime.context.sessions.flush(entry.agent.session);
    } catch {}

    try {
      // 2. Dispose agent handle
      await entry.agentHandle.dispose();
    } catch {}

    // Allow asynchronous session retirement to settle
    await new Promise((resolve) => setTimeout(resolve, 50));

    try {
      // 3. Remove agent from bootedRuntime internal maps
      this.bootedRuntime.removeAgent?.(sessionId);
    } catch {}

    try {
      // 4. Release OS session lock
      entry.sessionLock.release();
    } catch {}

    this.agents.delete(sessionId);
    this.evictionsCount++;

    this.emit('stream', {
      type: 'event',
      event: DAEMON_STREAM_EVENTS.AGENT_EVICTED,
      sessionId,
      timestamp: Date.now(),
      reason,
    });
  }

  // ---------------------------------------------------------------------------
  // Shutdown & Teardown
  // ---------------------------------------------------------------------------

  /**
   * Gracefully shuts down the Runtime Daemon.
   */
  public async shutdown(drainTimeoutMs = 5000): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    if (this.idleSweepTimer) {
      clearInterval(this.idleSweepTimer);
      this.idleSweepTimer = null;
    }

    if (this.eventRelayCleanup) {
      this.eventRelayCleanup();
      this.eventRelayCleanup = undefined;
    }

    // 1. Cancel all queued turns immediately
    for (const [sessionId, queue] of this.sessionQueues.entries()) {
      while (queue.length > 0) {
        const item = queue.shift()!;
        item.cancelled = true;
        item.cancelReason = 'Daemon shutdown';
        this.journal.recordCancelled(item.request.turnId, sessionId, 'Daemon shutdown');
        const currentEntry = this.agents.get(sessionId);
        const eventsCount = currentEntry?.agent?.session?.seq ?? 0;
        item.resolve({
          sessionId,
          turnId: item.request.turnId,
          status: 'cancelled',
          eventsCount,
          persisted: true,
        });
        this.emit('stream', {
          type: 'event',
          event: DAEMON_STREAM_EVENTS.TURN_CANCELLED,
          turnId: item.request.turnId,
          sessionId,
          timestamp: Date.now(),
          reason: 'Daemon shutdown',
        });
      }
    }

    // 2. If any agent loading is in-flight, wait for it to settle
    if (this.loadingAgents.size > 0) {
      const loaders = Array.from(this.loadingAgents.values());
      await Promise.allSettled(loaders);
    }

    // 3. Cancel any in-flight running turns
    for (const [sessionId, cur] of this.currentTurns.entries()) {
      cur.cancelRequested = true;
      const entry = this.agents.get(sessionId);
      if (entry?.agent) {
        try {
          entry.agent.cancel({ kind: 'user' });
        } catch {}
      } else if (this.bootedRuntime) {
        try {
          this.bootedRuntime.cancelTurn(cur.turnId).catch(() => {});
        } catch {}
      }
    }

    // 4. Wait up to drainTimeoutMs for in-flight running turns to settle
    const deadline = Date.now() + drainTimeoutMs;
    while (this.activeRunningSessions.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }

    // 5. Force cancel any remaining in-flight turns
    for (const entry of this.agents.values()) {
      if (entry.currentTurn) {
        try {
          entry.agent.cancel({ kind: 'user' });
        } catch {}
      }
    }

    // 6. Flush and dispose all agents
    const allSessionIds = Array.from(this.agents.keys());
    for (const sid of allSessionIds) {
      const entry = this.agents.get(sid);
      if (entry) {
        try {
          await this.bootedRuntime.context.sessions.flush(entry.agent.session);
          await entry.agentHandle.dispose();
          entry.sessionLock.release();
        } catch {}
      }
    }
    this.agents.clear();
    this.sessionQueues.clear();
    this.currentTurns.clear();
    this.activeRunningSessions.clear();

    // 7. Dispose DSH Booted Runtime
    if (this.bootedRuntime) {
      try {
        await this.bootedRuntime.dispose();
      } catch {}
    }

    this.emit('shutdown');
  }
}
