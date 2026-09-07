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
  TURN_ALREADY_EXISTS: 'TURN_ALREADY_EXISTS',
  SHUTTING_DOWN: 'SHUTTING_DOWN',
  PLUGIN_ACTIVATION_FAILED: 'PLUGIN_ACTIVATION_FAILED',
  AGENT_EXECUTION_FAILED: 'AGENT_EXECUTION_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type DaemonErrorCode = (typeof DAEMON_ERROR_CODES)[keyof typeof DAEMON_ERROR_CODES];

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
  readonly mounts?: readonly RuntimeMountSpec[] | null;
  readonly extensionPlan?: ExtensionActivationPlan | null;
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
  | ShutdownRequest;

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
  | DaemonErrorResponse;

// ---------------------------------------------------------------------------
// Streaming Push Events (Sent from Daemon to Client asynchronously)
// ---------------------------------------------------------------------------

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
  | 'mount_mismatch';

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

  constructor() {
    super({ readableObjectMode: true });
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    if (this.isClosed) {
      callback();
      return;
    }

    const chunkStr = chunk.toString('utf8');
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
    if (this.buffer.trim().length > 0 && !this.isClosed) {
      try {
        const msg = decodeDaemonMessage(this.buffer.trim());
        this.push(msg);
        callback();
      } catch (err: unknown) {
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
