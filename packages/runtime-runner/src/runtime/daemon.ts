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
import { carrierKeyOf } from '@deepseek-ai/dsh-scope';
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
  type CompactSessionRequest,
  type CompactSessionResponse,
  type ActivityStatusRequest,
  type ActivityStatusResponse,
  type DaemonActivityStatus,
  type ActiveTurnActivity,
  type RunningJobActivity,
  type LiveSubagentActivity,
  type SessionActivityDetail,
  type DaemonErrorResponse,
  type DaemonEvictionReason,
  type BackgroundTask,
  type ListBackgroundTasksRequest,
  type ListBackgroundTasksResponse,
  type StopBackgroundTaskRequest,
  type StopBackgroundTaskResponse,
} from './daemon-protocol.js';
import type {
  AgentFollowupResponse,
  AgentFollowupCompletedResponse,
  AgentFollowupCancelledResponse,
  RuntimeHealthStatus,
  FallbackTarget,
} from '../transport/types.js';
import type { RuntimeMountSpec } from '../spec/types.js';
import { computeMountHash, computeExtraRootsHash, validateExtraReadableRoots } from '../spec/mount-security.js';
import { computeExtensionPlanHash } from '../spec/extension-plan-security.js';
import {
  type ExtensionActivationPlan,
  validateExtensionActivationPlan,
} from '@enkeep/protocol';

function haveSkillsChanged(
  oldPlan: ExtensionActivationPlan | null | undefined,
  newPlan: ExtensionActivationPlan | null | undefined
): boolean {
  if (!oldPlan && !newPlan) return false;
  const oldSkills = oldPlan?.skills ?? [];
  const newSkills = newPlan?.skills ?? [];
  if (oldSkills.length !== newSkills.length) return true;
  for (let i = 0; i < newSkills.length; i++) {
    const o = oldSkills[i];
    const n = newSkills[i];
    if (
      o.contributionKey !== n.contributionKey ||
      o.name !== n.name ||
      o.version !== n.version ||
      o.contentHash !== n.contentHash ||
      o.enabled !== n.enabled ||
      o.modelInvocable !== n.modelInvocable ||
      o.userInvocable !== n.userInvocable
    ) {
      return true;
    }
  }
  return false;
}

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
  extraReadableRootsHash?: string;
  extraReadableRoots?: readonly string[];
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

export function computeTaskShortId(taskId: string, allTaskIds: string[]): string {
  const stripPrefix = (id: string) => {
    if (id.startsWith('ses_') || id.startsWith('ses-')) return id.slice(4);
    if (id.startsWith('job_') || id.startsWith('job-')) return id.slice(4);
    if (id.startsWith('wf_') || id.startsWith('wf-')) return id.slice(3);
    const idx = id.indexOf('_');
    return idx >= 0 ? id.slice(idx + 1) : id;
  };
  const stripped = stripPrefix(taskId).replace(/[^a-zA-Z0-9]/g, '');
  const cleanId = stripped.length >= 4 ? stripped : taskId.replace(/[^a-zA-Z0-9]/g, '');
  const base = cleanId.length >= 4 ? cleanId : (taskId.replace(/[^a-zA-Z0-9]/g, '') + '0000').slice(0, 4);
  const otherStripped = allTaskIds
    .filter((id) => id !== taskId)
    .map(stripPrefix)
    .map((s) => s.replace(/[^a-zA-Z0-9]/g, '').toLowerCase());

  for (let len = 4; len <= base.length; len++) {
    const candidate = base.slice(0, len).toLowerCase();
    if (!otherStripped.some((other) => other.startsWith(candidate))) {
      return candidate;
    }
  }
  return base.slice(0, Math.max(4, Math.min(base.length, 8))).toLowerCase();
}

interface BackgroundTaskRecord {
  id: string;
  parentSessionId: string;
  kind: 'subagent' | 'workflow' | 'job';
  name: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt?: string;
  lastActivityAt: string;
  progress?: {
    agentsDone?: number;
    agentsTotal?: number;
    step?: number;
  };
  originTurnId?: string;
  originChatContextId?: string;
  mode?: 'one-shot' | 'continuable';
  isBackground?: boolean;
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
  private readonly liveSubagentsTracker = new Map<string, LiveSubagentActivity>();
  private readonly backgroundTasksTracker = new Map<string, BackgroundTaskRecord>();
  private readonly autonomousTurnsTracker = new Map<string, { sessionId: string; turnNumber?: number; startedAt: number }>();
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

    const envIdleTimeout = process.env.DSH_IDLE_AGENT_TIMEOUT_MS || process.env.ENKEEP_EXECUTION_BUDGET_MS || process.env.DSH_DEFAULT_EXECUTION_BUDGET_MS
      ? parseInt(process.env.DSH_IDLE_AGENT_TIMEOUT_MS || process.env.ENKEEP_EXECUTION_BUDGET_MS || process.env.DSH_DEFAULT_EXECUTION_BUDGET_MS || '', 10)
      : NaN;
    this.idleAgentTimeoutMs =
      options.idleAgentTimeoutMs ?? (!isNaN(envIdleTimeout) && envIdleTimeout > 0 ? envIdleTimeout : 3_600_000);

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
    const daemon = this;
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

      // Track autonomous continuation turns
      if (event.type === 'turn/start') {
        const turnData = event.data as any;
        const turnNum = typeof turnData?.turn === 'number' ? turnData.turn : undefined;
        if (!this.currentTurns.has(sessionIdStr)) {
          this.autonomousTurnsTracker.set(sessionIdStr, {
            sessionId: sessionIdStr,
            turnNumber: turnNum,
            startedAt: Date.now(),
          });
        }
      }

      if (event.type === 'turn/end') {
        this.autonomousTurnsTracker.delete(sessionIdStr);
      }

      // Track child session activity for background tasks
      if (sessionIdStr) {
        let task = this.backgroundTasksTracker.get(sessionIdStr);
        const parentSid = (subject as any)?.header?.parentSession
          ? String((subject as any).header.parentSession)
          : undefined;

        if (task) {
          task.lastActivityAt = new Date(event.time || Date.now()).toISOString();
          if (parentSid && !task.parentSessionId) {
            task.parentSessionId = parentSid;
          }
          if (event.type === 'step/start') {
            task.progress = task.progress || {};
            task.progress.step = (task.progress.step || 0) + 1;
          }
          if (event.type === 'subagent/descriptor' && (event as any).data) {
            const data = (event as any).data;
            if (data.label) task.name = String(data.label).slice(0, 60);
            if (data.mode) task.mode = data.mode;
            if (data.mode === 'continuable') task.isBackground = true;
          }
        } else if (parentSid && ((subject as any)?.header?.origin === 'subagent' || (subject as any)?.meta?.origin === 'subagent')) {
          const nowIso = new Date(event.time || Date.now()).toISOString();
          task = {
            id: sessionIdStr,
            parentSessionId: parentSid,
            kind: 'subagent',
            name: String((subject as any)?.header?.label || (subject as any)?.meta?.label || 'subagent').slice(0, 60),
            status: 'running',
            startedAt: nowIso,
            lastActivityAt: nowIso,
          };
          if (event.type === 'step/start') {
            task.progress = { step: 1 };
          }
          if (event.type === 'subagent/descriptor' && (event as any).data) {
            const data = (event as any).data;
            if (data.label) task.name = String(data.label).slice(0, 60);
            if (data.mode) task.mode = data.mode;
            if (data.mode === 'continuable') task.isBackground = true;
          }
          this.backgroundTasksTracker.set(sessionIdStr, task);
        }
      }

      // Track tool-workflow events on session
      const rawEvent = event as any;
      if (rawEvent?.type === 'tool-workflow/run-start' && rawEvent.data) {
        const runId = String(rawEvent.data.runId);
        const parentSid = sessionIdStr || '';
        const nowIso = new Date().toISOString();
        this.backgroundTasksTracker.set(runId, {
          id: runId,
          parentSessionId: parentSid,
          kind: 'workflow',
          name: String(rawEvent.data.name || 'workflow').slice(0, 60),
          status: 'running',
          startedAt: nowIso,
          lastActivityAt: nowIso,
          progress: { agentsDone: 0, agentsTotal: 0 },
        });
      } else if (rawEvent?.type === 'tool-workflow/agent-start' && rawEvent.data) {
        const runId = String(rawEvent.data.runId);
        const task = this.backgroundTasksTracker.get(runId);
        if (task) {
          task.lastActivityAt = new Date().toISOString();
          task.progress = task.progress || { agentsDone: 0, agentsTotal: 0 };
          task.progress.agentsTotal = (task.progress.agentsTotal || 0) + 1;
        }
      } else if (rawEvent?.type === 'tool-workflow/agent-end' && rawEvent.data) {
        const runId = String(rawEvent.data.runId);
        const task = this.backgroundTasksTracker.get(runId);
        if (task) {
          task.lastActivityAt = new Date().toISOString();
          task.progress = task.progress || { agentsDone: 0, agentsTotal: 0 };
          task.progress.agentsDone = (task.progress.agentsDone || 0) + 1;
        }
      } else if (rawEvent?.type === 'tool-workflow/run-end' && rawEvent.data) {
        const runId = String(rawEvent.data.runId);
        const task = this.backgroundTasksTracker.get(runId);
        if (task) {
          const nowIso = new Date().toISOString();
          task.finishedAt = nowIso;
          task.lastActivityAt = nowIso;
          const stopReason = rawEvent.data.stopReason;
          if (stopReason === 'failed' || stopReason === 'error') {
            task.status = 'failed';
          } else if (stopReason === 'cancelled' || stopReason === 'interrupted' || stopReason === 'killed') {
            task.status = 'cancelled';
          } else {
            task.status = 'completed';
          }
        }
      }
    });

    // Chunk streaming push from new agent/assistant-stream event
    const disposeAssistantStream = ctx.on('agent/assistant-stream', (payload: any) => {
      const frame = payload?.frame;
      if (!frame || frame.type !== 'chunk') return;
      const agent = payload?.agent;
      const sessionIdStr = agent?.session?.id ? String(agent.session.id) : undefined;
      if (!sessionIdStr) return;

      const entry = this.agents.get(sessionIdStr);
      const turnId = this.currentTurns.get(sessionIdStr)?.turnId ?? entry?.currentTurn?.turnId;
      const chunkData = frame.chunk;
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
    });

    // Track live background subagents via lifecycle events
    const disposeSubagentStart = ctx.on('subagent/start', function (this: any, info: any, maybeParent?: any) {
      if (info?.id) {
        const idStr = String(info.id);
        let parentSession: string | undefined = undefined;

        // 1. From listener context / carrierKeyOf(this)
        try {
          const carrierAgent = carrierKeyOf(this) as any;
          if (carrierAgent?.session?.id) {
            parentSession = String(carrierAgent.session.id);
          } else if (carrierAgent?.id) {
            parentSession = String(carrierAgent.id);
          }
        } catch {}

        if (!parentSession && this?.session?.id) {
          parentSession = String(this.session.id);
        }

        // 2. From maybeParent argument
        if (!parentSession && maybeParent) {
          if (typeof maybeParent === 'string') {
            parentSession = maybeParent;
          } else if (maybeParent?.session?.id) {
            parentSession = String(maybeParent.session.id);
          } else if (maybeParent?.id) {
            parentSession = String(maybeParent.id);
          }
        }

        // 3. From payload fields
        if (!parentSession && info) {
          if (info.parentSession) parentSession = String(info.parentSession);
          else if (info.parentSessionId) parentSession = String(info.parentSessionId);
          else if (info.parent?.session?.id) parentSession = String(info.parent.session.id);
          else if (typeof info.parent === 'string') parentSession = info.parent;
        }

        // 4. From session registry
        if (!parentSession) {
          const s = ctx.get('sessions')?.get(info.id);
          if (s?.header?.parentSession) {
            parentSession = String(s.header.parentSession);
          }
        }

        const isContinuable = info.mode === 'continuable' || info.continuable === true;
        const isBg = info.runInBackground === true || info.background === true || isContinuable;

        daemon.liveSubagentsTracker.set(idStr, {
          id: idStr,
          provider: info.provider ? String(info.provider) : undefined,
          sessionId: info.sessionId ? String(info.sessionId) : idStr,
          parentSession,
          startedAt: Date.now(),
        });
        const nowIso = new Date().toISOString();
        const existing = daemon.backgroundTasksTracker.get(idStr);
        if (!existing) {
          daemon.backgroundTasksTracker.set(idStr, {
            id: idStr,
            parentSessionId: parentSession || '',
            kind: 'subagent',
            name: String(info.label || info.description || info.provider || 'subagent').slice(0, 60),
            status: 'running',
            startedAt: nowIso,
            lastActivityAt: nowIso,
            mode: isContinuable ? 'continuable' : (info.mode === 'one-shot' ? 'one-shot' : undefined),
            isBackground: isBg,
          });
        } else {
          if (parentSession && !existing.parentSessionId) {
            existing.parentSessionId = parentSession;
          }
          existing.status = 'running';
          existing.lastActivityAt = nowIso;
          if (isContinuable) existing.mode = 'continuable';
          if (isBg) existing.isBackground = true;
          if (info.label || info.description) {
            existing.name = String(info.label || info.description).slice(0, 60);
          }
        }
      }
    });

    const disposeSubagentEnd = ctx.on('subagent/end', function (this: any, info: any, maybeParent?: any) {
      if (info?.id) {
        const idStr = String(info.id);
        daemon.liveSubagentsTracker.delete(idStr);
        let existing = daemon.backgroundTasksTracker.get(idStr);
        if (!existing) {
          let parentSession: string | undefined = undefined;
          try {
            const carrierAgent = carrierKeyOf(this) as any;
            if (carrierAgent?.session?.id) parentSession = String(carrierAgent.session.id);
          } catch {}
          if (!parentSession && maybeParent) {
            parentSession = typeof maybeParent === 'string' ? maybeParent : String(maybeParent?.session?.id || maybeParent?.id || '');
          }
          if (!parentSession && info.parentSession) parentSession = String(info.parentSession);
          if (!parentSession) {
            const s = ctx.get('sessions')?.get(info.id);
            if (s?.header?.parentSession) parentSession = String(s.header.parentSession);
          }
          const nowIso = new Date().toISOString();
          existing = {
            id: idStr,
            parentSessionId: parentSession || '',
            kind: 'subagent',
            name: String(info.label || info.description || info.provider || 'subagent').slice(0, 60),
            status: 'completed',
            startedAt: nowIso,
            finishedAt: nowIso,
            lastActivityAt: nowIso,
          };
          daemon.backgroundTasksTracker.set(idStr, existing);
        }
        if (existing) {
          const nowIso = new Date().toISOString();
          existing.finishedAt = nowIso;
          existing.lastActivityAt = nowIso;
          const outcome = info.outcome || info.stopReason;
          if (outcome === 'failed' || outcome === 'error') {
            existing.status = 'failed';
          } else if (outcome === 'cancelled' || outcome === 'interrupted' || outcome === 'killed') {
            existing.status = 'cancelled';
          } else {
            existing.status = 'completed';
          }
        }
      }
    });

    // Track Cordis workflow lifecycle events
    const disposeWorkflowStart = ctx.on('workflow/start' as any, (info: any) => {
      const runId = String(info?.runId || info?.id || '');
      if (runId) {
        const parentSid = String(info?.parentSession || info?.sessionId || '');
        const nowIso = new Date().toISOString();
        if (!this.backgroundTasksTracker.has(runId)) {
          this.backgroundTasksTracker.set(runId, {
            id: runId,
            parentSessionId: parentSid,
            kind: 'workflow',
            name: String(info?.meta?.name || info?.name || 'workflow').slice(0, 60),
            status: 'running',
            startedAt: nowIso,
            lastActivityAt: nowIso,
            progress: { agentsDone: 0, agentsTotal: 0 },
          });
        }
      }
    });

    const disposeWorkflowAgentStart = ctx.on('workflow/agent-start' as any, (info: any) => {
      const runId = String(info?.runId || info?.id || '');
      const task = this.backgroundTasksTracker.get(runId);
      if (task) {
        task.lastActivityAt = new Date().toISOString();
        task.progress = task.progress || { agentsDone: 0, agentsTotal: 0 };
        task.progress.agentsTotal = (task.progress.agentsTotal || 0) + 1;
      }
    });

    const disposeWorkflowAgentEnd = ctx.on('workflow/agent-end' as any, (info: any) => {
      const runId = String(info?.runId || info?.id || '');
      const task = this.backgroundTasksTracker.get(runId);
      if (task) {
        task.lastActivityAt = new Date().toISOString();
        task.progress = task.progress || { agentsDone: 0, agentsTotal: 0 };
        task.progress.agentsDone = (task.progress.agentsDone || 0) + 1;
      }
    });

    const disposeWorkflowEnd = ctx.on('workflow/end' as any, (info: any, result: any) => {
      const runId = String(info?.runId || info?.id || '');
      const task = this.backgroundTasksTracker.get(runId);
      if (task) {
        const nowIso = new Date().toISOString();
        task.finishedAt = nowIso;
        task.lastActivityAt = nowIso;
        const stopReason = result?.stopReason;
        if (stopReason === 'failed' || stopReason === 'error') {
          task.status = 'failed';
        } else if (stopReason === 'cancelled' || stopReason === 'interrupted' || stopReason === 'killed') {
          task.status = 'cancelled';
        } else {
          task.status = 'completed';
        }
      }
    });

    this.eventRelayCleanup = () => {
      disposeSessionEvent();
      disposeAssistantStream();
      disposeSubagentStart();
      disposeSubagentEnd();
      disposeWorkflowStart();
      disposeWorkflowAgentStart();
      disposeWorkflowAgentEnd();
      disposeWorkflowEnd();
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

        case DAEMON_OPS.COMPACT_SESSION:
          return await this.handleCompactSession(request as CompactSessionRequest);

        case DAEMON_OPS.BACKGROUND_TASKS:
        case DAEMON_OPS.LIST_BACKGROUND_TASKS:
        case 'backgroundTasks':
        case 'listBackgroundTasks':
          return await this.handleListBackgroundTasks(request as ListBackgroundTasksRequest);

        case DAEMON_OPS.STOP_BACKGROUND_TASK:
        case 'stopBackgroundTask':
          return await this.handleStopBackgroundTask(request as StopBackgroundTaskRequest);

        case DAEMON_OPS.ACTIVITY_STATUS:
        case 'activityStatus':
        case 'activity':
        case 'status':
          return await this.handleActivityStatus(request as any);

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

    // 2b. Validate extraReadableRoots if provided (fail-closed)
    let validatedExtraRoots: readonly string[] | undefined;
    if (request.extraReadableRoots !== undefined && request.extraReadableRoots !== null) {
      try {
        validatedExtraRoots = validateExtraReadableRoots(request.extraReadableRoots);
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
        validatedExtensionPlan,
        validatedExtraRoots
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

    const activity = await this.getActivityStatus();

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
      activity,
    };
  }

  public async handleActivityStatus(request: ActivityStatusRequest | DaemonRequest): Promise<ActivityStatusResponse> {
    const activity = await this.getActivityStatus();
    const op = (request.op === 'activity' || request.op === 'status') ? request.op : 'activityStatus';
    return {
      id: request.id,
      op,
      ok: true,
      activity,
    };
  }

  public async handleListBackgroundTasks(request: ListBackgroundTasksRequest | DaemonRequest): Promise<ListBackgroundTasksResponse> {
    const sessionId = (request as ListBackgroundTasksRequest).sessionId;
    if (!sessionId) {
      throw new DaemonProtocolError(
        DAEMON_ERROR_CODES.INVALID_PARAMETERS,
        'Field "sessionId" is required for listBackgroundTasks'
      );
    }
    const items = await this.listBackgroundTasks(sessionId);
    return {
      id: request.id,
      op: (request.op === 'backgroundTasks' ? 'backgroundTasks' : 'listBackgroundTasks'),
      ok: true,
      items,
      updatedAt: new Date().toISOString(),
    };
  }

  public async handleStopBackgroundTask(request: StopBackgroundTaskRequest | DaemonRequest): Promise<StopBackgroundTaskResponse> {
    const { sessionId, taskId } = request as StopBackgroundTaskRequest;
    if (!sessionId || !taskId) {
      throw new DaemonProtocolError(
        DAEMON_ERROR_CODES.INVALID_PARAMETERS,
        'Fields "sessionId" and "taskId" are required for stopBackgroundTask'
      );
    }
    const result = await this.stopBackgroundTask(sessionId, taskId);
    return {
      id: request.id,
      op: 'stopBackgroundTask',
      ok: true,
      stopped: result.stopped,
    };
  }

  /**
   * Returns per-session background tasks meeting the visibility contract:
   * - subagents from DSH subagents / sessions registry
   * - workflow jobs with progress (agentsDone/agentsTotal) from events
   * - other background jobs from ctx.jobs
   * - lastActivityAt from latest child event
   * - completed tasks retained for 2h
   */
  public async listBackgroundTasks(sessionId: string): Promise<BackgroundTask[]> {
    const ctx = this.bootedRuntime?.context;
    const now = Date.now();
    const RETENTION_MS = 2 * 60 * 60 * 1000; // 2 hours

    // 1. Sync jobs from ctx.jobs
    const jobRegistry = ctx?.get('jobs');
    const allJobs = typeof jobRegistry?.list === 'function' ? jobRegistry.list() : [];
    for (const job of allJobs) {
      const jobId = String(job.id);
      const owner = job.owner ? String(job.owner) : '';
      if (owner === sessionId) {
        let task = this.backgroundTasksTracker.get(jobId);
        if (!task) {
          const startedIso = new Date(job.startedAt || now).toISOString();
          const kind: 'workflow' | 'job' = job.kind === 'workflow' ? 'workflow' : 'job';
          const status =
            job.status === 'running' || job.status === 'stopping'
              ? 'running'
              : job.status === 'completed'
              ? 'completed'
              : job.status === 'failed'
              ? 'failed'
              : 'cancelled';
          task = {
            id: jobId,
            parentSessionId: owner,
            kind,
            name: String(job.label || job.kind || 'job').slice(0, 60),
            status,
            startedAt: startedIso,
            finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : undefined,
            lastActivityAt: startedIso,
          };
          this.backgroundTasksTracker.set(jobId, task);
        } else {
          if (job.status === 'completed') {
            task.status = 'completed';
            if (!task.finishedAt) task.finishedAt = new Date().toISOString();
          } else if (job.status === 'failed') {
            task.status = 'failed';
            if (!task.finishedAt) task.finishedAt = new Date().toISOString();
          } else if (job.status === 'killed') {
            task.status = 'cancelled';
            if (!task.finishedAt) task.finishedAt = new Date().toISOString();
          }
        }
      }
    }

    // 2. Sync subagent children using DSH 0.2 APIs: subagents service, sessionQuery service, and session registry
    // 2a. Sync from ctx.subagents.listChildren
    const subagentsService = ctx?.get('subagents');
    if (subagentsService && typeof subagentsService.listChildren === 'function') {
      try {
        const children = await subagentsService.listChildren(sessionId as any);
        for (const child of children) {
          const childId = String(child.id);
          let task = this.backgroundTasksTracker.get(childId);
          const isLive = this.liveSubagentsTracker.has(childId) || this.agents.has(childId);
          const mode = child.mode === 'continuable' ? 'continuable' : child.mode === 'one-shot' ? 'one-shot' : undefined;
          const isBg = mode === 'continuable';
          if (!task) {
            const nowIso = new Date(child.createdAt || now).toISOString();
            task = {
              id: childId,
              parentSessionId: sessionId,
              kind: 'subagent',
              name: String(child.label || 'subagent').slice(0, 60),
              status: isLive ? 'running' : 'completed',
              startedAt: nowIso,
              lastActivityAt: nowIso,
              mode,
              isBackground: isBg,
            };
            this.backgroundTasksTracker.set(childId, task);
          } else {
            task.parentSessionId = sessionId;
            if (child.label && (!task.name || task.name === 'subagent')) {
              task.name = String(child.label).slice(0, 60);
            }
            if (mode) {
              task.mode = mode;
              if (mode === 'continuable') task.isBackground = true;
            }
            if (task.status === 'running' && !isLive) {
              task.status = 'completed';
              if (!task.finishedAt) task.finishedAt = new Date().toISOString();
            }
          }
        }
      } catch {}
    }

    // 2b. Sync from ctx.sessionQuery
    const sessionQuery = ctx?.get('sessionQuery');
    if (sessionQuery && typeof sessionQuery.listSessions === 'function') {
      try {
        const querySessions = await sessionQuery.listSessions();
        for (const sRec of querySessions) {
          const sId = String(sRec.header.id);
          const origin = sRec.header.origin;
          const parent = sRec.header.parentSession;
          if (origin === 'subagent' && String(parent) === sessionId) {
            let task = this.backgroundTasksTracker.get(sId);
            const startedIso = new Date(sRec.header.createdAt || now).toISOString();
            if (!task) {
              task = {
                id: sId,
                parentSessionId: sessionId,
                kind: 'subagent',
                name: String((sRec.header as any)?.label || 'subagent').slice(0, 60),
                status: (this.liveSubagentsTracker.has(sId) || this.agents.has(sId)) ? 'running' : 'completed',
                startedAt: startedIso,
                lastActivityAt: startedIso,
              };
              this.backgroundTasksTracker.set(sId, task);
            }
          }
        }
      } catch {}
    }

    // 2c. Sync from ctx.sessions
    const sessionRegistry = ctx?.get('sessions');
    const registeredSessions = typeof sessionRegistry?.list === 'function' ? sessionRegistry.list() : [];
    for (const s of registeredSessions) {
      const sId = String(s.id);
      const origin = s.header?.origin ?? (s as any).meta?.origin;
      const parent = s.header?.parentSession ?? (s as any).meta?.parentSession;
      if (origin === 'subagent' && String(parent) === sessionId) {
        let task = this.backgroundTasksTracker.get(sId);
        const startedIso = new Date(s.header?.createdAt || now).toISOString();
        let lastActIso = startedIso;
        const rawS = s as any;
        if (Array.isArray(rawS.events) && rawS.events.length > 0) {
          const lastEv = rawS.events[rawS.events.length - 1];
          if (lastEv?.time) {
            lastActIso = new Date(lastEv.time).toISOString();
          }
        }
        if (!task) {
          task = {
            id: sId,
            parentSessionId: sessionId,
            kind: 'subagent',
            name: String((s.header as any)?.label || (s as any).meta?.label || 'subagent').slice(0, 60),
            status: (this.liveSubagentsTracker.has(sId) || this.agents.has(sId)) ? 'running' : 'completed',
            startedAt: startedIso,
            lastActivityAt: lastActIso,
          };
          this.backgroundTasksTracker.set(sId, task);
        }
      }
    }

    // 2d. Enrich all subagent tasks with step count & descriptor metadata from events
    for (const [id, task] of this.backgroundTasksTracker.entries()) {
      if (task.parentSessionId === sessionId && task.kind === 'subagent') {
        const liveSession = sessionRegistry?.get?.(id as any) as any;
        let events = liveSession?.events;
        if ((!events || events.length === 0) && sessionQuery && typeof sessionQuery.readSession === 'function') {
          try {
            const loaded = await sessionQuery.readSession(id as any);
            events = loaded.events;
          } catch {}
        }
        if (Array.isArray(events) && events.length > 0) {
          const stepEvents = events.filter((e: any) => e.type === 'step/start');
          const stepCount = stepEvents.length;
          if (stepCount > 0) {
            task.progress = task.progress || {};
            task.progress.step = Math.max(task.progress.step || 0, stepCount);
          }
          const descriptorEv = events.find((e: any) => e.type === 'subagent/descriptor');
          if (descriptorEv?.data) {
            if (descriptorEv.data.label && (!task.name || task.name === 'subagent')) {
              task.name = String(descriptorEv.data.label).slice(0, 60);
            }
            if (descriptorEv.data.mode) {
              task.mode = descriptorEv.data.mode;
              if (descriptorEv.data.mode === 'continuable') task.isBackground = true;
            }
          }
          // If name is still generic 'subagent', check user message prompt
          if (!task.name || task.name === 'subagent') {
            for (const ev of events) {
              if (ev.type === 'message/content' && ev.data?.content) {
                const textBlock = Array.isArray(ev.data.content)
                  ? ev.data.content.find((b: any) => b.type === 'text')
                  : undefined;
                if (textBlock?.text) {
                  task.name = String(textBlock.text).trim().slice(0, 60);
                  break;
                }
              }
            }
          }
          const lastEv = events[events.length - 1];
          if (lastEv?.time) {
            const evTimeIso = new Date(lastEv.time).toISOString();
            if (Date.parse(evTimeIso) > Date.parse(task.lastActivityAt || '1970-01-01')) {
              task.lastActivityAt = evTimeIso;
            }
          }
        }
      }
    }

    // 3. Filter tasks belonging to sessionId, exclude finished foreground one-shots, & apply 2h retention
    const sessionTasks: BackgroundTaskRecord[] = [];
    for (const [id, task] of this.backgroundTasksTracker.entries()) {
      if (task.parentSessionId === sessionId) {
        // Exclude finished foreground one-shots (not continuable, not run_in_background)
        if (task.kind === 'subagent' && task.status !== 'running') {
          if (task.mode === 'one-shot' && !task.isBackground) {
            continue;
          }
        }

        if (task.finishedAt) {
          const finishedTime = Date.parse(task.finishedAt);
          if (!isNaN(finishedTime) && now - finishedTime > RETENTION_MS) {
            this.backgroundTasksTracker.delete(id);
            continue;
          }
        }
        sessionTasks.push(task);
      }
    }

    const allTaskIds = sessionTasks.map((t) => t.id);

    return sessionTasks.map((task) => {
      const shortId = computeTaskShortId(task.id, allTaskIds);
      const lastActTime = Date.parse(task.lastActivityAt);
      const stalled =
        task.status === 'running' &&
        !isNaN(lastActTime) &&
        now - lastActTime > 10 * 60 * 1000;

      return {
        id: task.id,
        shortId,
        kind: task.kind,
        name: task.name,
        status: task.status,
        startedAt: task.startedAt,
        finishedAt: task.finishedAt,
        lastActivityAt: task.lastActivityAt,
        stalled,
        progress: task.progress,
        originTurnId: task.originTurnId,
        originChatContextId: task.originChatContextId,
      };
    });
  }

  /**
   * Stops a running background task (subagent interrupt or job kill).
   */
  public async stopBackgroundTask(
    sessionId: string,
    taskId: string
  ): Promise<{ stopped: boolean }> {
    const ctx = this.bootedRuntime?.context;
    let foundTask: BackgroundTaskRecord | undefined;

    // Match by exact id or shortId
    const allSessionTasks = Array.from(this.backgroundTasksTracker.values()).filter(
      (t) => t.parentSessionId === sessionId
    );
    const allTaskIds = allSessionTasks.map((t) => t.id);

    for (const task of allSessionTasks) {
      if (
        task.id === taskId ||
        computeTaskShortId(task.id, allTaskIds) === taskId.toLowerCase() ||
        task.id.toLowerCase().startsWith(taskId.toLowerCase())
      ) {
        foundTask = task;
        break;
      }
    }

    let stopped = false;
    const targetSessionId = foundTask ? foundTask.id : taskId;

    // 1. If it's a subagent
    const subagentsService = ctx?.get('subagents');
    if (subagentsService && typeof subagentsService.interrupt === 'function') {
      try {
        subagentsService.interrupt(targetSessionId as any, {
          kind: 'user',
          parentSessionId: sessionId as any,
        });
        stopped = true;
      } catch {}
    }

    const agentRegistry = ctx?.get('agents');
    if (agentRegistry && typeof agentRegistry.get === 'function') {
      try {
        const ag = agentRegistry.get(targetSessionId as any);
        if (ag && typeof (ag as any).cancel === 'function') {
          (ag as any).cancel('user stopped');
          stopped = true;
        }
      } catch {}
    }

    // 2. If it's a job or workflow
    const jobRegistry = ctx?.get('jobs');
    if (jobRegistry && typeof jobRegistry.kill === 'function') {
      try {
        const killRes = jobRegistry.kill(targetSessionId as any, sessionId as any, 'user stopped');
        if (killRes === 'requested' || killRes === 'already-finished') {
          stopped = true;
        }
      } catch {}
    }

    if (foundTask) {
      foundTask.status = 'cancelled';
      foundTask.finishedAt = new Date().toISOString();
      foundTask.lastActivityAt = new Date().toISOString();
      stopped = true;
    }

    return { stopped };
  }

  /**
   * Returns current read-only daemon activity status.
   * Alias for getActivityStatus.
   */
  public async getStatus(): Promise<DaemonActivityStatus> {
    return this.getActivityStatus();
  }

  /**
   * Gathers live activity status across all sessions, turns, background jobs, subagents, and inboxes.
   */
  public async getActivityStatus(): Promise<DaemonActivityStatus> {
    const ctx = this.bootedRuntime?.context;
    const sessionMap = new Map<string, SessionActivityDetail>();

    // 1. Gather all candidate session IDs from multiple authoritative sources
    const allSessionIds = new Set<string>();
    for (const sid of this.agents.keys()) allSessionIds.add(sid);
    for (const sid of this.sessionQueues.keys()) allSessionIds.add(sid);
    for (const sid of this.currentTurns.keys()) allSessionIds.add(sid);
    for (const sid of this.autonomousTurnsTracker.keys()) allSessionIds.add(sid);

    const agentRegistry = ctx?.get('agents');
    const liveAgents = typeof agentRegistry?.list === 'function' ? agentRegistry.list() : [];
    for (const a of liveAgents) {
      if (a?.id) allSessionIds.add(String(a.id));
    }

    const sessionRegistry = ctx?.get('sessions');
    const registeredSessions = typeof sessionRegistry?.list === 'function' ? sessionRegistry.list() : [];
    for (const s of registeredSessions) {
      if (s?.id) allSessionIds.add(String(s.id));
    }

    // 2. Resolve per-session activity: active turn (submitted or autonomous), inbox items, queued turns
    const activeTurns: ActiveTurnActivity[] = [];

    for (const sessionId of allSessionIds) {
      const entry = this.agents.get(sessionId);
      const liveAgent = entry?.agent ?? (typeof agentRegistry?.get === 'function' ? agentRegistry.get(sessionId as any) : undefined);
      const queue = this.sessionQueues.get(sessionId) ?? [];
      const queuedTurnsCount = queue.filter((item) => !item.cancelled).length;

      let activeTurn: ActiveTurnActivity | undefined;

      // Check daemon-submitted in-flight turn
      const curTurn = this.currentTurns.get(sessionId) ?? entry?.currentTurn;
      if (curTurn && !curTurn.cancelRequested) {
        activeTurn = {
          sessionId,
          turnId: curTurn.turnId,
          autonomous: false,
          startedAt: curTurn.startedAt,
        };
      } else if (this.autonomousTurnsTracker.has(sessionId)) {
        // Autonomous continuation turn tracked via turn/start event
        const auto = this.autonomousTurnsTracker.get(sessionId)!;
        activeTurn = {
          sessionId,
          turnNumber: auto.turnNumber,
          autonomous: true,
          startedAt: auto.startedAt,
        };
      } else if (liveAgent) {
        // Direct inspection of live agent status / phase / turnBoundary projection
        const agentStatus = (liveAgent as any).status;
        const agentPhase = (liveAgent as any).phase;
        const sessionProjections = ctx?.get('sessionProjections');
        const sessionObj = liveAgent.session ?? (typeof sessionRegistry?.get === 'function' ? sessionRegistry.get(sessionId as any) : undefined);
        const turnBoundary = sessionObj && sessionProjections ? sessionProjections.stateOf(sessionObj, 'turnBoundary') : undefined;

        const isRunning =
          agentStatus === 'running' ||
          agentPhase?.kind === 'running' ||
          (turnBoundary && turnBoundary.openTurnStartSeq !== null && turnBoundary.openTurnStartSeq !== undefined);

        if (isRunning) {
          activeTurn = {
            sessionId,
            turnNumber: agentPhase?.turn ?? (typeof turnBoundary?.lastTurn === 'number' ? turnBoundary.lastTurn : undefined),
            autonomous: true,
            startedAt: Date.now(),
          };
        }
      }

      if (activeTurn) {
        activeTurns.push(activeTurn);
      }

      // Check pending inbox items
      let pendingNextTurnCount = 0;
      let pendingNextStepCount = 0;

      if (liveAgent) {
        const inbox = (liveAgent as any).inbox;
        if (inbox) {
          if (Array.isArray(inbox.nextTurn)) pendingNextTurnCount = inbox.nextTurn.length;
          if (Array.isArray(inbox.nextStep)) pendingNextStepCount = inbox.nextStep.length;
        }

        if (pendingNextTurnCount === 0 && pendingNextStepCount === 0 && liveAgent.session) {
          const sessionProjections = ctx?.get('sessionProjections');
          const projInbox = sessionProjections?.stateOf(liveAgent.session, 'inbox');
          if (projInbox) {
            if (Array.isArray(projInbox['next-turn'])) pendingNextTurnCount = projInbox['next-turn'].length;
            if (Array.isArray(projInbox['next-step'])) pendingNextStepCount = projInbox['next-step'].length;
          }
        }
      }

      const pendingInboxItemsCount = pendingNextTurnCount + pendingNextStepCount;

      sessionMap.set(sessionId, {
        sessionId,
        activeTurn,
        pendingInboxItemsCount,
        pendingNextTurnCount,
        pendingNextStepCount,
        queuedTurnsCount,
      });
    }

    // 3. Running jobs (including workflow jobs)
    const jobRegistry = ctx?.get('jobs');
    const allJobs = typeof jobRegistry?.list === 'function' ? jobRegistry.list() : [];
    const runningJobs: RunningJobActivity[] = [];
    for (const job of allJobs) {
      if (job.status === 'running' || job.status === 'stopping') {
        runningJobs.push({
          id: String(job.id),
          kind: String(job.kind),
          label: String(job.label || ''),
          owner: job.owner ? String(job.owner) : undefined,
          startedAt: job.startedAt || 0,
        });
      }
    }
    const runningWorkflowJobsCount = runningJobs.filter((j) => j.kind === 'workflow').length;

    // 4. Live background subagents
    const liveSubagents: LiveSubagentActivity[] = [];
    const seenSubagentKeys = new Set<string>();

    for (const sub of this.liveSubagentsTracker.values()) {
      liveSubagents.push(sub);
      seenSubagentKeys.add(sub.id);
      if (sub.sessionId) seenSubagentKeys.add(sub.sessionId);
    }

    for (const agent of liveAgents) {
      const aId = String(agent.id);
      const isOriginSubagent =
        (agent as any).session?.header?.origin === 'subagent' ||
        (agent as any).session?.meta?.origin === 'subagent';

      if (isOriginSubagent && !seenSubagentKeys.has(aId)) {
        liveSubagents.push({
          id: aId,
          sessionId: aId,
          parentSession: (agent as any).session?.header?.parentSession
            ? String((agent as any).session.header.parentSession)
            : undefined,
          startedAt: (agent as any).session?.header?.createdAt
            ? Number((agent as any).session.header.createdAt)
            : undefined,
        });
        seenSubagentKeys.add(aId);
      }
    }

    // 5. Aggregate totals
    const activeTurnsCount = activeTurns.length;
    const autonomousTurnsCount = activeTurns.filter((t) => t.autonomous).length;
    const runningJobsCount = runningJobs.length;
    const liveSubagentsCount = liveSubagents.length;

    let totalPendingInboxItems = 0;
    let totalQueuedTurns = 0;
    const sessionsObj: Record<string, SessionActivityDetail> = {};

    for (const [sid, detail] of sessionMap.entries()) {
      sessionsObj[sid] = detail;
      totalPendingInboxItems += detail.pendingInboxItemsCount;
      totalQueuedTurns += detail.queuedTurnsCount;
    }

    const isIdle =
      activeTurnsCount === 0 &&
      runningJobsCount === 0 &&
      liveSubagentsCount === 0 &&
      totalPendingInboxItems === 0 &&
      totalQueuedTurns === 0;

    return {
      isIdle,
      activeTurnsCount,
      autonomousTurnsCount,
      runningJobsCount,
      runningWorkflowJobsCount,
      liveSubagentsCount,
      pendingInboxItemsCount: totalPendingInboxItems,
      queuedTurnsCount: totalQueuedTurns,
      activeTurns,
      runningJobs,
      liveSubagents,
      sessions: sessionsObj,
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

  public async handleCompactSession(
    request: CompactSessionRequest
  ): Promise<CompactSessionResponse | DaemonErrorResponse> {
    const { sessionId } = request;

    if (!sessionId || typeof sessionId !== 'string') {
      return {
        id: request.id,
        op: 'compactSession',
        ok: false,
        error: {
          code: DAEMON_ERROR_CODES.INVALID_PARAMETERS,
          message: 'Invalid or missing sessionId',
        },
      };
    }

    if (this.currentTurns.has(sessionId)) {
      return {
        id: request.id,
        op: 'compactSession',
        ok: false,
        error: {
          code: 'TURN_ACTIVE',
          message: `Cannot compact session "${sessionId}" while a turn is active`,
        },
      };
    }

    let entry = this.agents.get(sessionId);
    if (entry && (entry.currentTurn || entry.status === 'running')) {
      return {
        id: request.id,
        op: 'compactSession',
        ok: false,
        error: {
          code: 'TURN_ACTIVE',
          message: `Cannot compact session "${sessionId}" while a turn is active`,
        },
      };
    }

    if (!entry) {
      const artifactCheck = await this.bootedRuntime.checkSessionArtifact(sessionId);
      if (!artifactCheck.exists) {
        return {
          id: request.id,
          op: 'compactSession',
          ok: false,
          error: {
            code: DAEMON_ERROR_CODES.SESSION_NOT_FOUND,
            message: `Session "${sessionId}" not found`,
          },
        };
      }
      entry = await this.getOrCreateManagedAgent(sessionId);
    }

    const compaction = this.bootedRuntime.context.get('compaction');
    if (!compaction || typeof compaction.compactNow !== 'function') {
      return {
        id: request.id,
        op: 'compactSession',
        ok: false,
        error: {
          code: 'COMPACTION_UNSUPPORTED',
          message: 'Explicit compaction is unsupported: ctx.compaction service unavailable in current runtime',
        },
      };
    }

    const tokenMeter = this.bootedRuntime.context.get('tokenMeter');
    const beforeMeasurement = tokenMeter ? tokenMeter.measure(entry.agent.session) : undefined;
    const beforeTokens = beforeMeasurement?.totalTokens;
    const eventsBefore = entry.agent.session.snapshotEvents().length;

    try {
      const abortController = new AbortController();
      const result = await compaction.compactNow(entry.agent, abortController.signal);

      const afterMeasurement = tokenMeter ? tokenMeter.measure(entry.agent.session) : undefined;
      const afterTokens = afterMeasurement?.totalTokens;
      const eventsAfter = entry.agent.session.snapshotEvents().length;

      let summaryChars = 0;
      if (result && Array.isArray(result.summary)) {
        for (const block of result.summary) {
          if (typeof (block as any).text === 'string') {
            summaryChars += (block as any).text.length;
          }
        }
      }

      entry.lastUsed = Date.now();

      return {
        id: request.id,
        op: 'compactSession',
        ok: true,
        beforeTokens,
        afterTokens,
        eventsBefore,
        eventsAfter,
        summaryChars,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const isBusy = (err as any)?.code === 'busy' || message.includes('idle');
      return {
        id: request.id,
        op: 'compactSession',
        ok: false,
        error: {
          code: isBusy ? 'TURN_ACTIVE' : DAEMON_ERROR_CODES.INTERNAL_ERROR,
          message: `Compaction failed: ${message}`,
        },
      };
    }
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
    extensionPlan?: ExtensionActivationPlan | null,
    extraReadableRoots?: readonly string[]
  ): Promise<ManagedAgentEntry> {
    const existing = this.agents.get(sessionId);
    if (existing) {
      return this.verifyAndReturnExistingAgent(existing, profileSnapshot, workspaceFolder, mounts, extensionPlan, extraReadableRoots);
    }

    const inFlight = this.loadingAgents.get(sessionId);
    if (inFlight) {
      return await inFlight;
    }

    const loadPromise = this.doCreateManagedAgent(sessionId, profileSnapshot, workspaceFolder, mounts, extensionPlan, extraReadableRoots);
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
    extensionPlan?: ExtensionActivationPlan | null,
    extraReadableRoots?: readonly string[]
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

    let rootsMismatch = false;
    if (extraReadableRoots !== undefined) {
      const newRootsHash = computeExtraRootsHash(extraReadableRoots);
      const oldRootsHash = existing.extraReadableRootsHash ?? computeExtraRootsHash([]);
      if (oldRootsHash !== newRootsHash) {
        rootsMismatch = true;
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

    const planSkillsChanged = extensionPlanMismatch && haveSkillsChanged(existing.extensionPlan, validatedExtensionPlan);
    if (profileMismatch || workspaceMismatch || mountMismatch || planSkillsChanged || rootsMismatch) {
      // If agent is active / has pending turns: drain after current turn
      const queue = this.sessionQueues.get(existing.sessionId);
      const queueLen = queue ? queue.length : 0;
      if (existing.status === 'running' || queueLen > 0 || this.currentTurns.has(existing.sessionId)) {
        existing.status = 'draining';
      } else {
        const reason = rootsMismatch
          ? 'roots_mismatch'
          : (mountMismatch
            ? 'mount_mismatch'
            : (profileMismatch || planSkillsChanged ? 'profile_mismatch' : 'space_mismatch'));
        await this.evictAgent(existing.sessionId, reason);
        return this.getOrCreateManagedAgent(existing.sessionId, profileSnapshot, workspaceFolder, mounts, extensionPlan, extraReadableRoots);
      }
    } else if (extensionPlanMismatch) {
      if (this.bootedRuntime?.getOrCreateAgent) {
        await this.bootedRuntime.getOrCreateAgent(existing.sessionId, profileSnapshot, workspaceFolder, mounts, validatedExtensionPlan, extraReadableRoots);
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
    extensionPlan?: ExtensionActivationPlan | null,
    extraReadableRoots?: readonly string[]
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
        validatedExtensionPlan,
        extraReadableRoots
      );
      const agentHandle = this.bootedRuntime.agentHandles?.get(sessionId);

      if (!agentHandle) {
        throw new Error(`Failed to resolve AgentHandle for resumed session "${sessionId}"`);
      }

      const spacePath = ((agent.session.header as any)?.meta as any)?.cwd || path.join(this.spacesDir, workspaceFolder || '');
      const mountHash = computeMountHash(mounts);
      const extensionPlanHash = computeExtensionPlanHash(validatedExtensionPlan);
      const extraReadableRootsHash = computeExtraRootsHash(extraReadableRoots);

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
        extraReadableRootsHash,
        extraReadableRoots,
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

      let validatedReqExtraRoots: readonly string[] | undefined;
      if (request.extraReadableRoots !== undefined && request.extraReadableRoots !== null) {
        validatedReqExtraRoots = validateExtraReadableRoots(request.extraReadableRoots);
      }

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
          const rootsDiffers = Boolean(
            request.extraReadableRoots !== undefined &&
            (existing.extraReadableRootsHash ?? computeExtraRootsHash([])) !== computeExtraRootsHash(validatedReqExtraRoots)
          );

          const planSkillsChanged = planDiffers && haveSkillsChanged(existing.extensionPlan, validatedReqPlan);
          if (profileDiffers || workspaceDiffers || mountDiffers || planSkillsChanged || rootsDiffers) {
            await this.evictAgent(sessionId, rootsDiffers ? 'roots_mismatch' : (mountDiffers ? 'mount_mismatch' : (profileDiffers || planSkillsChanged ? 'profile_mismatch' : 'space_mismatch')));
            entry = await this.getOrCreateManagedAgent(sessionId, reqProfile, targetFolder, reqMounts, validatedReqPlan, validatedReqExtraRoots);
          } else if (planDiffers) {
            entry = await this.getOrCreateManagedAgent(sessionId, reqProfile, targetFolder, reqMounts, validatedReqPlan, validatedReqExtraRoots);
            entry.extensionPlan = validatedReqPlan;
            entry.extensionPlanHash = computeExtensionPlanHash(validatedReqPlan);
          } else {
            entry = existing;
            entry.lastUsed = Date.now();
          }
        } else {
          entry = await this.getOrCreateManagedAgent(sessionId, reqProfile, targetFolder, reqMounts, validatedReqPlan, validatedReqExtraRoots);
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
          extraReadableRoots: validatedReqExtraRoots,
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
