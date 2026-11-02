/**
 * Daemon RPC Protocol Specification and Frame Codec
 *
 * Implements strict, framed, depth-bounded and size-bounded JSON-RPC protocol
 * for the Enkeep Persistent Runtime Runner Daemon.
 *
 * Zero-Network architecture: Communicates over stdio (process.stdin / process.stdout)
 * or stream sockets with no listening network ports.
 *
 * @module @enkeep/runtime-runner/runtime/daemon-protocol
 */

import { Transform, type TransformCallback } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { AgentProfileSnapshot } from './agent-profile.js';
import type { SessionSeedReceipt } from './dsh-boot.js';
import type { RuntimeCapabilitiesStatus } from './official-plugins.js';
import type {
  RuntimeHealthStatus,
  AgentFollowupRequest,
  AgentFollowupResponse,
  FallbackTarget,
} from '../transport/types.js';
import type {
  FileOperationRequest,
  FileOperationResult,
} from './file-ops.js';
import type {
  RuntimeMountSpec,
  ExtensionActivationPlan,
} from '@enkeep/protocol';
import { validateExtraReadableRoots } from '../spec/mount-security.js';

export const MAX_DAEMON_FRAME_SIZE = 10 * 1024 * 1024; // 10 MiB frame limit
export const MAX_JSON_DEPTH = 64; // Safe nested levels for deep tool schemas, session events and profile snapshots
export const DEFAULT_DAEMON_SOCKET_PATH = '/tmp/enkeep-runtime.sock';

export const DAEMON_OPS = {
  SUBMIT_TURN: 'submitTurn',
  CANCEL: 'cancel',
  INSPECT_TURN: 'inspectTurn',
  HEALTH: 'health',
  CAPABILITIES: 'capabilities',
  CHECK_SESSION_ARTIFACT: 'checkSessionArtifact',
  INSPECT_CORRUPTION: 'inspectCorruption',
  RECOVER_PREFIX: 'recoverPrefix',
  EXPORT_FORK_SEED: 'exportForkSeed',
  IMPORT_SEED: 'importSeed',
  FILE_OP: 'fileOp',
  INSTRUCTIONS_READ: 'instructionsRead',
  INSTRUCTIONS_WRITE: 'instructionsWrite',
  SHUTDOWN: 'shutdown',
  ANSWER_APPROVAL: 'answerApproval',
  LIST_APPROVALS: 'listApprovals',
  COMPACT_SESSION: 'compactSession',
  ACTIVITY_STATUS: 'activityStatus',
  BACKGROUND_TASKS: 'backgroundTasks',
  LIST_BACKGROUND_TASKS: 'listBackgroundTasks',
  STOP_BACKGROUND_TASK: 'stopBackgroundTask',
  STEER: 'steer',
  READ_SESSION_EVENTS: 'readSessionEvents',
  READ_ATTACHMENT: 'readAttachment',
} as const;

export type DaemonOp = (typeof DAEMON_OPS)[keyof typeof DAEMON_OPS];

export const DAEMON_STREAM_EVENTS = {
  TURN_ACCEPTED: 'turn/accepted',
  TURN_STARTED: 'turn/started',
  TURN_CHUNK: 'turn/chunk',
  TURN_EVENT: 'turn/event',
  TURN_COMPLETED: 'turn/completed',
  TURN_CANCELLED: 'turn/cancelled',
  TURN_FAILED: 'turn/failed',
  APPROVAL_ASKED: 'approval/asked',
  APPROVAL_DECIDED: 'approval/decided',
  AGENT_EVICTED: 'agent/evicted',
  DAEMON_STATS: 'daemon/stats',
} as const;

export type DaemonStreamEventType =
  (typeof DAEMON_STREAM_EVENTS)[keyof typeof DAEMON_STREAM_EVENTS];

export const DAEMON_ERROR_CODES = {
  INVALID_FRAME_STRUCTURE: 'INVALID_FRAME_STRUCTURE',
  FRAME_SIZE_EXCEEDED: 'FRAME_SIZE_EXCEEDED',
  MAX_DEPTH_EXCEEDED: 'MAX_DEPTH_EXCEEDED',
  UNKNOWN_OP: 'UNKNOWN_OP',
  INVALID_PARAMETERS: 'INVALID_PARAMETERS',
  SESSION_BUSY: 'SESSION_BUSY',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  TURN_NOT_FOUND: 'TURN_NOT_FOUND',
  TURN_NOT_RUNNING: 'TURN_NOT_RUNNING',
  TURN_ALREADY_EXISTS: 'TURN_ALREADY_EXISTS',
  SHUTTING_DOWN: 'SHUTTING_DOWN',
  PLUGIN_ACTIVATION_FAILED: 'PLUGIN_ACTIVATION_FAILED',
  AGENT_EXECUTION_FAILED: 'AGENT_EXECUTION_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

/**
 * Error codes of the read-only session history ops (`readSessionEvents`, `readAttachment`).
 * Kept apart from {@link DAEMON_ERROR_CODES} because callers route on them by name.
 */
export const SESSION_HISTORY_ERROR_CODES = {
  /** No persisted (or created-in-this-process) DSH session has that id. */
  SESSION_NOT_FOUND: 'session/not-found',
  /** The session log exists but DSH refused to read it (corrupt or unsupported format). */
  SESSION_UNREADABLE: 'session/unreadable',
  /** No image with that id/path is cited by the session, or its bytes are gone. */
  ATTACHMENT_NOT_FOUND: 'attachment/not-found',
  /** The image exceeds {@link READ_ATTACHMENT_MAX_BYTES}. */
  ATTACHMENT_TOO_LARGE: 'attachment/too-large',
  /** The cited file is not a PNG/JPEG/GIF/WebP image. */
  ATTACHMENT_NOT_IMAGE: 'attachment/not-image',
  /** The stored bytes failed integrity verification, or changed between chunk reads. */
  ATTACHMENT_UNREADABLE: 'attachment/unreadable',
} as const;

export type SessionHistoryErrorCode =
  (typeof SESSION_HISTORY_ERROR_CODES)[keyof typeof SESSION_HISTORY_ERROR_CODES];

export type DaemonErrorCode =
  | (typeof DAEMON_ERROR_CODES)[keyof typeof DAEMON_ERROR_CODES]
  | SessionHistoryErrorCode;

/** `readSessionEvents`: default page length. */
export const READ_SESSION_EVENTS_DEFAULT_LIMIT = 200;
/** `readSessionEvents`: larger `limit` values are clamped to this. */
export const READ_SESSION_EVENTS_MAX_LIMIT = 1000;
/** `readSessionEvents`: default byte budget of one page (serialized events). */
export const READ_SESSION_EVENTS_DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
/**
 * `readSessionEvents`: hard byte cap of one page, well under {@link MAX_DAEMON_FRAME_SIZE}.
 * Larger `maxBytes` values are clamped to this; a single event above it can never be returned
 * and is reported in `omitted` instead.
 */
export const READ_SESSION_EVENTS_MAX_BYTES_CAP = 8 * 1024 * 1024;
/** `readAttachment`: largest image the ops serve (matches the runtime's image admission limit). */
export const READ_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
/** `readAttachment`: largest raw chunk per frame (base64 ≈ 8 MiB, under the 10 MiB frame limit). */
export const READ_ATTACHMENT_MAX_CHUNK_BYTES = 6 * 1024 * 1024;

export class DaemonProtocolError extends Error {
  readonly code: DaemonErrorCode;
  readonly details?: unknown;

  constructor(code: DaemonErrorCode, message: string, details?: unknown) {
    super(`[${code}] ${message}`);
    this.name = 'DaemonProtocolError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Validates object depth and guards against prototype pollution.
 */
export function validateJsonDepth(value: unknown, currentDepth = 0, maxDepth = MAX_JSON_DEPTH): void {
  if (currentDepth > maxDepth) {
    throw new DaemonProtocolError(
      DAEMON_ERROR_CODES.MAX_DEPTH_EXCEEDED,
      `JSON payload nesting depth exceeds limit of ${maxDepth}`
    );
  }

  if (value === null || typeof value !== 'object') {
    return;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      validateJsonDepth(value[i], currentDepth + 1, maxDepth);
    }
    return;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new DaemonProtocolError(
        DAEMON_ERROR_CODES.INVALID_FRAME_STRUCTURE,
        'Dangerous prototype property detected in payload'
      );
    }
    validateJsonDepth(record[key], currentDepth + 1, maxDepth);
  }
}

// ---------------------------------------------------------------------------
// Request Envelopes
// ---------------------------------------------------------------------------

export interface DaemonRequestBase {
  readonly id: string;
  readonly op: DaemonOp | string;
}

export interface SubmitTurnRequest extends DaemonRequestBase {
  readonly op: 'submitTurn';
  readonly turnId: string;
  readonly sessionId: string;
  readonly prompt: string;
  readonly profileSnapshot?: AgentProfileSnapshot | null;
  readonly profile?: AgentProfileSnapshot | null;
  readonly workspaceFolder?: string;
  readonly spaceId?: string;
  readonly attachments?: readonly any[];
  readonly modelSelection?: {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: string | null;
    readonly source?: string;
    readonly fallbackChain?: readonly FallbackTarget[];
  } | null;
  readonly replyReference?: {
    readonly replyToMessageId: string;
    readonly snippet: string;
    readonly role?: string;
  } | null;
  readonly timeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly maxExecutionBudgetMs?: number;
  readonly mounts?: readonly RuntimeMountSpec[] | null;
  readonly extensionPlan?: ExtensionActivationPlan | null;
  readonly extraReadableRoots?: readonly string[];
  readonly cacheRetention?: 'short' | 'long' | 'none' | null;
  readonly contextWindow?: number | null;
}

export interface CancelRequest extends DaemonRequestBase {
  readonly op: 'cancel';
  readonly turnId?: string;
  readonly sessionId?: string;
  readonly reason?: string;
}

export interface InspectTurnRequest extends DaemonRequestBase {
  readonly op: 'inspectTurn';
  readonly turnId: string;
}

export interface HealthRequest extends DaemonRequestBase {
  readonly op: 'health';
}

export interface CapabilitiesRequest extends DaemonRequestBase {
  readonly op: 'capabilities';
}

export interface CheckSessionArtifactRequest extends DaemonRequestBase {
  readonly op: 'checkSessionArtifact';
  readonly sessionId: string;
  readonly workspaceFolder?: string;
}

export interface InspectCorruptionRequest extends DaemonRequestBase {
  readonly op: 'inspectCorruption';
  readonly sessionId: string;
  readonly workspaceFolder?: string;
}

export interface RecoverPrefixRequest extends DaemonRequestBase {
  readonly op: 'recoverPrefix';
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly maxValidSeq?: number;
  readonly workspaceFolder?: string;
}

export interface ExportForkSeedRequest extends DaemonRequestBase {
  readonly op: 'exportForkSeed';
  readonly sessionId: string;
  readonly boundary?: {
    readonly fromMessageId?: string;
    readonly fromTurnId?: string;
  };
  readonly workspaceFolder?: string;
}

export interface ImportSeedRequest extends DaemonRequestBase {
  readonly op: 'importSeed';
  readonly sessionId: string;
  readonly seed: readonly SessionEvent[];
  readonly receipt: SessionSeedReceipt;
  readonly profileSnapshot?: AgentProfileSnapshot | null;
  readonly profile?: AgentProfileSnapshot | null;
  readonly workspaceFolder?: string;
}

export interface FileOpDaemonRequest extends DaemonRequestBase {
  readonly op: 'fileOp';
  readonly fileOp: FileOperationRequest;
}

export type InstructionsTarget = 'global' | 'space';
export type InstructionsFilename = 'AGENTS.md' | 'CLAUDE.md';

export interface InstructionsReadRequest extends DaemonRequestBase {
  readonly op: 'instructionsRead';
  readonly target: InstructionsTarget;
  readonly spaceFolder?: string;
  readonly filename?: string;
}

export interface InstructionsWriteRequest extends DaemonRequestBase {
  readonly op: 'instructionsWrite';
  readonly target: InstructionsTarget;
  readonly content: string;
  readonly spaceFolder?: string;
  readonly filename?: string;
  readonly expectedEtag?: string | null;
  readonly requireAbsent?: boolean;
}

export interface AnswerApprovalRequest extends DaemonRequestBase {
  readonly op: 'answerApproval';
  readonly approvalId: string;
  readonly decision: 'allowed-once' | 'allowed-always' | 'rejected';
  readonly reason?: string;
}

export interface ListApprovalsRequest extends DaemonRequestBase {
  readonly op: 'listApprovals';
  readonly sessionId?: string;
}

export interface ShutdownRequest extends DaemonRequestBase {
  readonly op: 'shutdown';
  readonly drainTimeoutMs?: number;
}

export interface CompactSessionRequest extends DaemonRequestBase {
  readonly op: 'compactSession';
  readonly sessionId: string;
}

export interface ActivityStatusRequest extends DaemonRequestBase {
  readonly op: 'activityStatus' | 'activity' | 'status';
}

export interface BackgroundTaskProgress {
  agentsDone?: number;
  agentsTotal?: number;
  step?: number;
}

export interface BackgroundTask {
  id: string;                // DSH child session id / job id
  shortId: string;           // 4+ chars, unique within session
  kind: 'subagent' | 'workflow' | 'job';
  name: string;              // workflow name / subagent label / job title (truncated 60)
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;         // ISO
  finishedAt?: string;       // ISO
  lastActivityAt: string;    // ISO
  stalled: boolean;          // running && now - lastActivityAt > 10 min
  progress?: BackgroundTaskProgress;
  originTurnId?: string;     // platform turn that launched it (from durable child-origin mapping)
  originChatContextId?: string; // chat-level native context of the origin turn (from channel_turn_origins)
}

export interface ListBackgroundTasksRequest extends DaemonRequestBase {
  readonly op: 'listBackgroundTasks' | 'backgroundTasks';
  readonly sessionId: string;
}

export interface StopBackgroundTaskRequest extends DaemonRequestBase {
  readonly op: 'stopBackgroundTask';
  readonly sessionId: string;
  readonly taskId: string;
}

export interface SteerRequest extends DaemonRequestBase {
  readonly op: 'steer';
  readonly sessionId: string;
  readonly expectedTurnId: string;
  readonly message: string;
  readonly attachments?: readonly any[];
  readonly clientRequestId?: string;
  readonly workspaceFolder?: string;
  readonly spaceId?: string;
}

/**
 * Parameters of the read-only `readSessionEvents` op (one page of a DSH session log).
 *
 * Paging (all seqs are ORIGINAL DSH seqs, counting from 0):
 * - `afterSeq` → the oldest events with `seq > afterSeq` (forward paging; `hasMore` = newer remain).
 *   With `beforeSeq` too, the page stays inside the open interval (afterSeq, beforeSeq).
 * - `beforeSeq` alone → the newest events with `seq < beforeSeq` (`hasMore` = older remain).
 * - neither → the newest events of the log (`hasMore` = older remain).
 * Events always come back ascending.
 */
export interface ReadSessionEventsParams {
  /** The DSH session id (the id the daemon's submitTurn/listApprovals ops use). */
  readonly sessionId: string;
  /** Integer ≥ -1. */
  readonly afterSeq?: number;
  /** Integer ≥ 0. */
  readonly beforeSeq?: number;
  /** Positive integer; default {@link READ_SESSION_EVENTS_DEFAULT_LIMIT}, clamped to {@link READ_SESSION_EVENTS_MAX_LIMIT}. */
  readonly limit?: number;
  /**
   * Byte budget of the serialized events; default {@link READ_SESSION_EVENTS_DEFAULT_MAX_BYTES},
   * clamped to {@link READ_SESSION_EVENTS_MAX_BYTES_CAP}. A page holds fewer events (and
   * `hasMore: true`) when the next event would exceed it; a page always holds at least one
   * event when one is available, even if that event alone exceeds `maxBytes`.
   */
  readonly maxBytes?: number;
  /**
   * Also return events the session committed in memory but the JSONL write-behind buffer has
   * not written yet (≤ ~200 ms), for a session that is live in this daemon. Default true, so a
   * read started after subscribing to `turn/event` never misses an event pushed before it.
   * False → strictly what is on disk. Neither variant writes or flushes anything.
   */
  readonly includeUnflushed?: boolean;
}

/** An event a page skipped because it can never fit a daemon frame. */
export interface OmittedSessionEvent {
  readonly seq: number;
  readonly type: string;
  /** Serialized size in bytes (when known). */
  readonly bytes: number;
  readonly reason: 'too-large' | 'too-deep';
}

/** Result of `readSessionEvents`. */
export interface ReadSessionEventsResult {
  /** The DSH session id whose log was read (identifies the log; a reset session gets a new id). */
  readonly dshSessionId: string;
  /** Ascending by seq, the events exactly as DSH stored them (original seqs, unmodified). */
  readonly events: readonly SessionEvent[];
  /** The newest seq in the WHOLE log (not just this page); -1 when the log is empty. */
  readonly lastSeq: number;
  /** The newest seq already on disk; < `lastSeq` only while unflushed events were included. */
  readonly persistedLastSeq: number;
  /** More events exist beyond this page in the read direction (after: newer; before/newest: older). */
  readonly hasMore: boolean;
  /** Present only when the page skipped events that can never fit a frame (seq gaps in `events`). */
  readonly omitted?: readonly OmittedSessionEvent[];
}

export interface ReadSessionEventsRequest extends DaemonRequestBase, ReadSessionEventsParams {
  readonly op: 'readSessionEvents';
}

/**
 * Parameters of `readAttachment`: an image cited by the session's events. Exactly one of
 * `attachmentId` / `path` is required.
 */
export interface ReadAttachmentParams {
  /** The DSH session id whose events cite the image. */
  readonly sessionId: string;
  /** A DSH image attachment id (`sha256:<64 hex>`) from an `image` content block in the log. */
  readonly attachmentId?: string;
  /**
   * A workspace file path as the log cites it (enkeep passes user-sent files to DSH as workspace
   * paths in text): relative to the session's working directory (its space), or absolute inside it.
   */
  readonly path?: string;
}

/** Wire parameters of one `readAttachment` chunk (the host transport loops over chunks). */
export interface ReadAttachmentChunkParams extends ReadAttachmentParams {
  /** Byte offset of the chunk; default 0. */
  readonly offset?: number;
  /** Raw bytes per chunk; default and maximum {@link READ_ATTACHMENT_MAX_CHUNK_BYTES}. */
  readonly maxChunkBytes?: number;
}

export interface ReadAttachmentRequest extends DaemonRequestBase, ReadAttachmentChunkParams {
  readonly op: 'readAttachment';
}

/** One chunk of an attachment as the daemon returns it. */
export interface ReadAttachmentChunk {
  readonly mime: string;
  /** Total size of the image in bytes. */
  readonly bytes: number;
  /** Byte offset of this chunk. */
  readonly offset: number;
  /** Raw bytes in this chunk. */
  readonly chunkBytes: number;
  /** Base64 of this chunk. */
  readonly data: string;
  /** This chunk ends the image. */
  readonly done: boolean;
  /** Lowercase hex sha256 of the WHOLE image (detects a file that changed between chunks). */
  readonly sha256: string;
  readonly width?: number;
  readonly height?: number;
  readonly name?: string;
}

/** A whole attachment, as the host transport's `readAttachment` returns it. */
export interface ReadAttachmentResult {
  readonly mime: string;
  /** Base64 of the whole image. */
  readonly data: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly width?: number;
  readonly height?: number;
  readonly name?: string;
}

export type DaemonRequest =
  | SubmitTurnRequest
  | CancelRequest
  | InspectTurnRequest
  | HealthRequest
  | CapabilitiesRequest
  | CheckSessionArtifactRequest
  | InspectCorruptionRequest
  | RecoverPrefixRequest
  | ExportForkSeedRequest
  | ImportSeedRequest
  | FileOpDaemonRequest
  | InstructionsReadRequest
  | InstructionsWriteRequest
  | AnswerApprovalRequest
  | ListApprovalsRequest
  | ShutdownRequest
  | CompactSessionRequest
  | ActivityStatusRequest
  | ListBackgroundTasksRequest
  | StopBackgroundTaskRequest
  | SteerRequest
  | ReadSessionEventsRequest
  | ReadAttachmentRequest;

// ---------------------------------------------------------------------------
// Response Envelopes
// ---------------------------------------------------------------------------

export interface DaemonResponseBase {
  readonly id: string;
  readonly op: string;
  readonly ok: boolean;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
}

export interface DaemonStats {
  readonly uptimeSeconds: number;
  readonly activeAgentsCount: number;
  readonly runningSessionsCount: number;
  readonly pendingTurnsCount: number;
  readonly evictionsCount: number;
  readonly totalTurnsProcessed: number;
  readonly maxAgents: number;
  readonly idleAgentTimeoutMs: number;
  readonly maxConcurrentSessions: number;
}

export interface SubmitTurnResponse extends DaemonResponseBase {
  readonly op: 'submitTurn';
  readonly ok: true;
  readonly status: 'accepted';
  readonly turnId: string;
  readonly sessionId: string;
  readonly queuePosition: number;
}

export interface CancelResponse extends DaemonResponseBase {
  readonly op: 'cancel';
  readonly ok: true;
  readonly cancelled: boolean;
  readonly turnId?: string;
  readonly sessionId?: string;
}

export interface InspectTurnResponse extends DaemonResponseBase {
  readonly op: 'inspectTurn';
  readonly ok: true;
  readonly turnId: string;
  readonly sessionId: string;
  readonly journalStatus: 'accepted' | 'executing' | 'completed' | 'cancelled' | 'failed';
  readonly result?: AgentFollowupResponse;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

export interface HealthResponse extends DaemonResponseBase {
  readonly op: 'health';
  readonly ok: true;
  readonly health: RuntimeHealthStatus;
  readonly stats: DaemonStats;
  readonly activity?: DaemonActivityStatus;
}

export interface CapabilitiesResponse extends DaemonResponseBase {
  readonly op: 'capabilities';
  readonly ok: true;
  readonly capabilities: RuntimeCapabilitiesStatus;
}

export interface CheckSessionArtifactResponse extends DaemonResponseBase {
  readonly op: 'checkSessionArtifact';
  readonly ok: true;
  readonly exists: boolean;
  readonly valid: boolean;
  readonly checksum?: string;
  readonly eventCount?: number;
}

export interface InspectCorruptionResponse extends DaemonResponseBase {
  readonly op: 'inspectCorruption';
  readonly ok: true;
  readonly exists: boolean;
  readonly valid: boolean;
  readonly corrupted: boolean;
  readonly code: 'VALID' | 'CORRUPTED' | 'SEQ_GAP' | 'SYNTAX_ERROR' | 'NOT_FOUND';
  readonly lastValidSeq: number;
  readonly lineCount: number;
  readonly validEventsCount: number;
  readonly errorDetail?: string;
}

export interface RecoverPrefixResponse extends DaemonResponseBase {
  readonly op: 'recoverPrefix';
  readonly ok: true;
  readonly recovered: boolean;
  readonly targetSessionId: string;
  readonly validEventsCount: number;
  readonly backupPath: string;
  readonly backupChecksum: string;
}

export interface ExportForkSeedResponse extends DaemonResponseBase {
  readonly op: 'exportForkSeed';
  readonly ok: true;
  readonly events: readonly SessionEvent[];
  readonly receipt: SessionSeedReceipt;
  readonly boundaryMapping?: Record<string, unknown>;
}

export interface ImportSeedResponse extends DaemonResponseBase {
  readonly op: 'importSeed';
  readonly ok: true;
  readonly sessionId: string;
  readonly persisted: boolean;
  readonly eventsCount: number;
  readonly receipt: SessionSeedReceipt;
  readonly duplicate: boolean;
}

export interface FileOpDaemonResponse extends DaemonResponseBase {
  readonly op: 'fileOp';
  readonly ok: true;
  readonly fileResult: FileOperationResult;
}

export interface InstructionsReadResponse extends DaemonResponseBase {
  readonly op: 'instructionsRead';
  readonly ok: true;
  readonly content: string;
  readonly etag: string | null;
  readonly exists: boolean;
  readonly size: number;
  readonly mtimeMs: number;
  readonly target: InstructionsTarget;
  readonly filename: InstructionsFilename;
}

export interface InstructionsWriteResponse extends DaemonResponseBase {
  readonly op: 'instructionsWrite';
  readonly ok: true;
  readonly etag: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly target: InstructionsTarget;
  readonly filename: InstructionsFilename;
}

export interface AnswerApprovalResponse extends DaemonResponseBase {
  readonly op: 'answerApproval';
  readonly ok: true;
  readonly answered: boolean;
  readonly approvalId: string;
}

export interface ListApprovalsResponse extends DaemonResponseBase {
  readonly op: 'listApprovals';
  readonly ok: true;
  readonly approvals: readonly any[];
}

export interface ShutdownResponse extends DaemonResponseBase {
  readonly op: 'shutdown';
  readonly ok: true;
  readonly status: 'shutting_down';
}

export interface CompactSessionResponse extends DaemonResponseBase {
  readonly op: 'compactSession';
  readonly ok: true;
  readonly beforeTokens?: number;
  readonly afterTokens?: number;
  readonly eventsBefore: number;
  readonly eventsAfter: number;
  readonly summaryChars: number;
}

export interface ActiveTurnActivity {
  readonly sessionId: string;
  readonly turnId?: string;
  readonly turnNumber?: number;
  readonly autonomous: boolean;
  readonly startedAt?: number;
}

export interface RunningJobActivity {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly owner?: string;
  readonly startedAt: number;
}

export interface LiveSubagentActivity {
  readonly id: string;
  readonly provider?: string;
  readonly sessionId?: string;
  readonly parentSession?: string;
  readonly startedAt?: number;
}

export interface SessionActivityDetail {
  readonly sessionId: string;
  readonly activeTurn?: ActiveTurnActivity;
  readonly pendingInboxItemsCount: number;
  readonly pendingNextTurnCount: number;
  readonly pendingNextStepCount: number;
  readonly queuedTurnsCount: number;
}

export interface DaemonActivityStatus {
  readonly isIdle: boolean;
  readonly activeTurnsCount: number;
  readonly autonomousTurnsCount: number;
  readonly runningJobsCount: number;
  readonly runningWorkflowJobsCount: number;
  readonly liveSubagentsCount: number;
  readonly pendingInboxItemsCount: number;
  readonly queuedTurnsCount: number;
  readonly activeTurns: readonly ActiveTurnActivity[];
  readonly runningJobs: readonly RunningJobActivity[];
  readonly liveSubagents: readonly LiveSubagentActivity[];
  readonly sessions: Readonly<Record<string, SessionActivityDetail>>;
}

export interface ActivityStatusResponse extends DaemonResponseBase {
  readonly op: 'activityStatus' | 'activity' | 'status';
  readonly ok: true;
  readonly activity: DaemonActivityStatus;
}

export interface ListBackgroundTasksResponse extends DaemonResponseBase {
  readonly op: 'listBackgroundTasks' | 'backgroundTasks';
  readonly ok: boolean;
  readonly items: BackgroundTask[];
  readonly updatedAt: string;
}

export interface StopBackgroundTaskResponse extends DaemonResponseBase {
  readonly op: 'stopBackgroundTask';
  readonly ok: boolean;
  readonly stopped: boolean;
}

export interface SteerResponse extends DaemonResponseBase {
  readonly op: 'steer';
  readonly ok: boolean;
  readonly steered: boolean;
  readonly sessionId: string;
  readonly turnId: string;
  readonly clientRequestId?: string;
}

export interface ReadSessionEventsResponse extends DaemonResponseBase, ReadSessionEventsResult {
  readonly op: 'readSessionEvents';
  readonly ok: true;
}

export interface ReadAttachmentResponse extends DaemonResponseBase, ReadAttachmentChunk {
  readonly op: 'readAttachment';
  readonly ok: true;
}

export interface DaemonErrorResponse extends DaemonResponseBase {
  readonly ok: false;
  readonly error: {
    readonly code: DaemonErrorCode | string;
    readonly message: string;
    readonly details?: unknown;
  };
}

export type DaemonResponse =
  | SubmitTurnResponse
  | CancelResponse
  | InspectTurnResponse
  | HealthResponse
  | CapabilitiesResponse
  | CheckSessionArtifactResponse
  | InspectCorruptionResponse
  | RecoverPrefixResponse
  | ExportForkSeedResponse
  | ImportSeedResponse
  | FileOpDaemonResponse
  | InstructionsReadResponse
  | InstructionsWriteResponse
  | AnswerApprovalResponse
  | ListApprovalsResponse
  | ShutdownResponse
  | CompactSessionResponse
  | ActivityStatusResponse
  | ListBackgroundTasksResponse
  | StopBackgroundTaskResponse
  | SteerResponse
  | ReadSessionEventsResponse
  | ReadAttachmentResponse
  | DaemonErrorResponse;

// ---------------------------------------------------------------------------
// Streaming Push Events (Sent from Daemon to Client asynchronously)
// ---------------------------------------------------------------------------

/**
 * A live model output delta (text, reasoning, tool-call arguments) of a top-level session, or of
 * any session while it runs a submitted turn. `turnId` is `''` for turns the runtime started on
 * its own (e.g. a background task's completion notice continuing the conversation). Subagent and
 * workflow child sessions do not stream chunks outside submitted turns.
 */
export interface DaemonStreamChunkEvent {
  readonly type: 'event';
  readonly event: 'turn/chunk';
  readonly turnId: string;
  readonly sessionId: string;
  readonly timestamp: number;
  readonly chunk: {
    readonly type: string;
    readonly text?: string;
    readonly delta?: unknown;
  };
}

/**
 * One DSH session event, pushed right after DSH committed it, for EVERY session of the runtime
 * (top-level, subagent and workflow children; submitted, autonomous and compaction turns alike):
 * it mirrors the `session/event` feed the JSONL persistence backend writes from. `seq` is the
 * original DSH seq. `turnId` is `''` outside a submitted turn. Not pushed: seed events of a
 * forked/imported session (DSH never publishes those) and anything while no client is connected
 * (no replay) — read those with `readSessionEvents`.
 */
export interface DaemonStreamSessionEvent {
  readonly type: 'event';
  readonly event: 'turn/event';
  readonly turnId: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly timestamp: number;
  readonly sessionEvent: SessionEvent;
}

export interface DaemonStreamTurnCompletedEvent {
  readonly type: 'event';
  readonly event: 'turn/completed';
  readonly turnId: string;
  readonly sessionId: string;
  readonly timestamp: number;
  readonly result: AgentFollowupResponse;
}

export interface DaemonStreamTurnCancelledEvent {
  readonly type: 'event';
  readonly event: 'turn/cancelled';
  readonly turnId: string;
  readonly sessionId: string;
  readonly timestamp: number;
  readonly reason?: string;
}

export interface DaemonStreamTurnFailedEvent {
  readonly type: 'event';
  readonly event: 'turn/failed';
  readonly turnId: string;
  readonly sessionId: string;
  readonly timestamp: number;
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

export interface DaemonStreamApprovalAskedEvent {
  readonly type: 'event';
  readonly event: 'approval/asked';
  readonly sessionId: string;
  readonly turnId?: string;
  readonly timestamp: number;
  readonly approval: {
    readonly id: string;
    readonly toolName: string;
    readonly risk: string;
    readonly safeSummary: string;
    readonly parameters?: unknown;
  };
}

export interface DaemonStreamApprovalDecidedEvent {
  readonly type: 'event';
  readonly event: 'approval/decided';
  readonly sessionId: string;
  readonly turnId?: string;
  readonly timestamp: number;
  readonly decision: {
    readonly id: string;
    readonly outcome: string;
    readonly reason?: string;
  };
}

export type DaemonEvictionReason =
  | 'idle_timeout'
  | 'lru_capacity'
  | 'profile_mismatch'
  | 'space_mismatch'
  | 'mount_mismatch'
  | 'roots_mismatch';

export interface DaemonStreamAgentEvictedEvent {
  readonly type: 'event';
  readonly event: 'agent/evicted';
  readonly sessionId: string;
  readonly timestamp: number;
  readonly reason: DaemonEvictionReason;
}

export interface DaemonStreamStatsEvent {
  readonly type: 'event';
  readonly event: 'daemon/stats';
  readonly timestamp: number;
  readonly stats: DaemonStats;
}

export type DaemonStreamEvent =
  | DaemonStreamChunkEvent
  | DaemonStreamSessionEvent
  | DaemonStreamTurnCompletedEvent
  | DaemonStreamTurnCancelledEvent
  | DaemonStreamTurnFailedEvent
  | DaemonStreamApprovalAskedEvent
  | DaemonStreamApprovalDecidedEvent
  | DaemonStreamAgentEvictedEvent
  | DaemonStreamStatsEvent;

export type DaemonMessage = DaemonRequest | DaemonResponse | DaemonStreamEvent;

// ---------------------------------------------------------------------------
// Protocol Parser & Validator
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validates and decodes a raw JSON string into a DaemonRequest.
 */
export function decodeDaemonRequest(raw: string | Buffer): DaemonRequest {
  const jsonStr = typeof raw === 'string' ? raw : raw.toString('utf8');

  if (Buffer.byteLength(jsonStr, 'utf8') > MAX_DAEMON_FRAME_SIZE) {
    throw new DaemonProtocolError(
      DAEMON_ERROR_CODES.FRAME_SIZE_EXCEEDED,
      `Frame size exceeds ${MAX_DAEMON_FRAME_SIZE} bytes`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err: unknown) {
    throw new DaemonProtocolError(
      DAEMON_ERROR_CODES.INVALID_FRAME_STRUCTURE,
      'Malformed JSON envelope',
      err
    );
  }

  validateJsonDepth(parsed);

  if (!isRecord(parsed)) {
    throw new DaemonProtocolError(
      DAEMON_ERROR_CODES.INVALID_FRAME_STRUCTURE,
      'Request envelope must be a JSON object'
    );
  }

  const { id, op } = parsed;

  if (typeof id !== 'string' || !id.trim()) {
    throw new DaemonProtocolError(
      DAEMON_ERROR_CODES.INVALID_PARAMETERS,
      'Request envelope missing mandatory non-empty string "id"'
    );
  }

  if (typeof op !== 'string' || !op.trim()) {
    throw new DaemonProtocolError(
      DAEMON_ERROR_CODES.INVALID_PARAMETERS,
      'Request envelope missing mandatory non-empty string "op"'
    );
  }

  if (op === DAEMON_OPS.SUBMIT_TURN || op === 'submitTurn') {
    if ((parsed as any).extraReadableRoots !== undefined && (parsed as any).extraReadableRoots !== null) {
      try {
        validateExtraReadableRoots((parsed as any).extraReadableRoots);
      } catch (err: unknown) {
        throw new DaemonProtocolError(
          DAEMON_ERROR_CODES.INVALID_PARAMETERS,
          err instanceof Error ? err.message : String(err),
          err
        );
      }
    }
  }

  if (op === DAEMON_OPS.STEER || op === 'steer') {
    const { sessionId, expectedTurnId, message } = parsed as any;
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      throw new DaemonProtocolError(
        DAEMON_ERROR_CODES.INVALID_PARAMETERS,
        'Steer request missing mandatory non-empty string "sessionId"'
      );
    }
    if (typeof expectedTurnId !== 'string' || !expectedTurnId.trim()) {
      throw new DaemonProtocolError(
        DAEMON_ERROR_CODES.INVALID_PARAMETERS,
        'Steer request missing mandatory non-empty string "expectedTurnId"'
      );
    }
    if (typeof message !== 'string' || !message.trim()) {
      throw new DaemonProtocolError(
        DAEMON_ERROR_CODES.INVALID_PARAMETERS,
        'Steer request missing mandatory non-empty string "message"'
      );
    }
  }

  return parsed as unknown as DaemonRequest;
}

/**
 * Decodes a raw line or buffer into any DaemonMessage (Request, Response, or StreamEvent).
 */
export function decodeDaemonMessage(raw: string | Buffer): DaemonMessage {
  const jsonStr = typeof raw === 'string' ? raw : raw.toString('utf8');

  if (Buffer.byteLength(jsonStr, 'utf8') > MAX_DAEMON_FRAME_SIZE) {
    throw new DaemonProtocolError(
      DAEMON_ERROR_CODES.FRAME_SIZE_EXCEEDED,
      `Frame size exceeds ${MAX_DAEMON_FRAME_SIZE} bytes`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err: unknown) {
    throw new DaemonProtocolError(
      DAEMON_ERROR_CODES.INVALID_FRAME_STRUCTURE,
      'Malformed JSON envelope',
      err
    );
  }

  validateJsonDepth(parsed);

  if (!isRecord(parsed)) {
    throw new DaemonProtocolError(
      DAEMON_ERROR_CODES.INVALID_FRAME_STRUCTURE,
      'Message envelope must be a JSON object'
    );
  }

  if (parsed.op === DAEMON_OPS.SUBMIT_TURN || parsed.op === 'submitTurn') {
    if ((parsed as any).extraReadableRoots !== undefined && (parsed as any).extraReadableRoots !== null) {
      try {
        validateExtraReadableRoots((parsed as any).extraReadableRoots);
      } catch (err: unknown) {
        throw new DaemonProtocolError(
          DAEMON_ERROR_CODES.INVALID_PARAMETERS,
          err instanceof Error ? err.message : String(err),
          err
        );
      }
    }
  }

  if (parsed.op === DAEMON_OPS.STEER || parsed.op === 'steer') {
    // If it is a Request (not a Response, which has `ok: boolean`), validate request fields
    if ((parsed as any).ok === undefined) {
      const { sessionId, expectedTurnId, message } = parsed as any;
      if (typeof sessionId !== 'string' || !sessionId.trim()) {
        throw new DaemonProtocolError(
          DAEMON_ERROR_CODES.INVALID_PARAMETERS,
          'Steer request missing mandatory non-empty string "sessionId"'
        );
      }
      if (typeof expectedTurnId !== 'string' || !expectedTurnId.trim()) {
        throw new DaemonProtocolError(
          DAEMON_ERROR_CODES.INVALID_PARAMETERS,
          'Steer request missing mandatory non-empty string "expectedTurnId"'
        );
      }
      if (typeof message !== 'string' || !message.trim()) {
        throw new DaemonProtocolError(
          DAEMON_ERROR_CODES.INVALID_PARAMETERS,
          'Steer request missing mandatory non-empty string "message"'
        );
      }
    }
  }

  return parsed as unknown as DaemonMessage;
}

/**
 * Serializes any DaemonMessage into a single newline-delimited JSON line (NDJSON).
 */
export function encodeDaemonMessage(message: DaemonMessage): Buffer {
  validateJsonDepth(message);
  const json = JSON.stringify(message);
  const buf = Buffer.from(json + '\n', 'utf8');

  if (buf.length > MAX_DAEMON_FRAME_SIZE) {
    throw new DaemonProtocolError(
      DAEMON_ERROR_CODES.FRAME_SIZE_EXCEEDED,
      `Serialized message exceeds maximum frame size of ${MAX_DAEMON_FRAME_SIZE} bytes`
    );
  }

  return buf;
}

// ---------------------------------------------------------------------------
// Stream Transformers (NDJSON Framing)
// ---------------------------------------------------------------------------

/**
 * Stream transformer for decoding NDJSON lines from stdin or socket chunks into DaemonMessage objects.
 */
export class DaemonRpcDecoder extends Transform {
  private buffer = '';
  private isClosed = false;
  private readonly stringDecoder = new StringDecoder('utf8');

  constructor() {
    super({ readableObjectMode: true });
  }

  _transform(chunk: Buffer | string, encoding: BufferEncoding, callback: TransformCallback): void {
    if (this.isClosed) {
      callback();
      return;
    }

    const chunkStr = Buffer.isBuffer(chunk)
      ? this.stringDecoder.write(chunk)
      : typeof chunk === 'string'
        ? (encoding && encoding !== 'utf8' && (encoding as string) !== 'buffer'
            ? this.stringDecoder.write(Buffer.from(chunk, encoding))
            : this.stringDecoder.write(Buffer.from(chunk, 'utf8')))
        : '';
    this.buffer += chunkStr;

    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_DAEMON_FRAME_SIZE) {
      const err = new DaemonProtocolError(
        DAEMON_ERROR_CODES.FRAME_SIZE_EXCEEDED,
        `Stream buffer exceeded maximum frame size of ${MAX_DAEMON_FRAME_SIZE} bytes without newline delimiter`
      );
      this.isClosed = true;
      this.destroy(err);
      callback(err);
      return;
    }

    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const msg = decodeDaemonMessage(trimmed);
        this.push(msg);
      } catch (err: unknown) {
        this.isClosed = true;
        const protocolErr =
          err instanceof DaemonProtocolError
            ? err
            : new DaemonProtocolError(
                DAEMON_ERROR_CODES.INVALID_FRAME_STRUCTURE,
                'Decoder error',
                err
              );
        this.destroy(protocolErr);
        callback(protocolErr);
        return;
      }
    }

    callback();
  }

  _flush(callback: TransformCallback): void {
    if (this.isClosed) {
      callback();
      return;
    }

    const trailing = this.stringDecoder.end();
    if (trailing) {
      this.buffer += trailing;
    }

    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_DAEMON_FRAME_SIZE) {
      const err = new DaemonProtocolError(
        DAEMON_ERROR_CODES.FRAME_SIZE_EXCEEDED,
        `Stream buffer exceeded maximum frame size of ${MAX_DAEMON_FRAME_SIZE} bytes without newline delimiter`
      );
      this.isClosed = true;
      this.destroy(err);
      callback(err);
      return;
    }

    if (this.buffer.trim().length > 0) {
      try {
        const msg = decodeDaemonMessage(this.buffer.trim());
        this.push(msg);
        callback();
      } catch (err: unknown) {
        this.isClosed = true;
        const protocolErr =
          err instanceof DaemonProtocolError
            ? err
            : new DaemonProtocolError(
                DAEMON_ERROR_CODES.INVALID_FRAME_STRUCTURE,
                'Trailing data parse error',
                err
              );
        callback(protocolErr);
      }
    } else {
      callback();
    }
  }

  override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    this.isClosed = true;
    this.buffer = '';
    this.stringDecoder.end();
    callback(error);
  }
}

/**
 * Stream transformer for encoding DaemonMessage objects into NDJSON chunks.
 */
export class DaemonRpcEncoder extends Transform {
  constructor() {
    super({ writableObjectMode: true });
  }

  _transform(message: DaemonMessage, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      const buf = encodeDaemonMessage(message);
      this.push(buf);
      callback();
    } catch (err: unknown) {
      const protocolErr =
        err instanceof DaemonProtocolError
          ? err
          : new DaemonProtocolError(
              DAEMON_ERROR_CODES.INVALID_FRAME_STRUCTURE,
              'Encoder error',
              err
            );
      callback(protocolErr);
    }
  }
}
