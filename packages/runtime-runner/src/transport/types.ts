/**
 * Transport Types for Enkeep Platform <-> Runtime Communication
 *
 * Strictly defines the Zero-Network Docker Exec transport contracts.
 *
 * @module @enkeep/runtime-runner/transport/types
 */

import type { AgentProfileSnapshot } from '../runtime/agent-profile.js';
import type { RuntimeWorkspaceSegment, CanonicalAttachment, ExtensionActivationPlan } from '@enkeep/protocol';
import type { RuntimeMountSpec } from '../spec/types.js';
export type { RuntimeMountSpec, ExtensionActivationPlan };
import type {
  DaemonRequest,
  DaemonResponse,
  CancelResponse,
  InspectTurnResponse,
  CheckSessionArtifactResponse,
  InspectCorruptionResponse,
  RecoverPrefixResponse,
  ExportForkSeedResponse,
  ImportSeedResponse,
  FileOpDaemonResponse,
  InstructionsReadResponse,
  InstructionsWriteResponse,
  AnswerApprovalResponse,
  ListApprovalsResponse,
} from '../runtime/daemon-protocol.js';
import type { FileOperationRequest } from '../runtime/file-ops.js';

/**
 * Standard runtime protocol error codes.
 */
export const RUNTIME_ERROR_CODES = {
  EXEC_CONTAINER_ERROR: 'EXEC_CONTAINER_ERROR',
  FOLLOWUP_FAILED: 'FOLLOWUP_FAILED',
  HEALTH_CHECK_FAILED: 'HEALTH_CHECK_FAILED',
  PROTOCOL_VIOLATION: 'PROTOCOL_VIOLATION',
  INVALID_RESPONSE_ENVELOPE: 'INVALID_RESPONSE_ENVELOPE',
  SESSION_ID_MISMATCH: 'SESSION_ID_MISMATCH',
  TURN_ID_MISMATCH: 'TURN_ID_MISMATCH',
  PERSISTENCE_REQUIRED: 'PERSISTENCE_REQUIRED',
  EMPTY_REPLY_TEXT: 'EMPTY_REPLY_TEXT',
} as const;

export type RuntimeErrorCode = (typeof RUNTIME_ERROR_CODES)[keyof typeof RUNTIME_ERROR_CODES];

export const RUNTIME_ERROR_MESSAGES: Record<RuntimeErrorCode, string> = {
  EXEC_CONTAINER_ERROR: 'Container execution error',
  FOLLOWUP_FAILED: 'Followup execution failed',
  HEALTH_CHECK_FAILED: 'Health check failed',
  PROTOCOL_VIOLATION: 'Runtime protocol violation',
  INVALID_RESPONSE_ENVELOPE: 'Invalid response envelope',
  SESSION_ID_MISMATCH: 'Session ID mismatch',
  TURN_ID_MISMATCH: 'Turn ID mismatch',
  PERSISTENCE_REQUIRED: 'Persistence required',
  EMPTY_REPLY_TEXT: 'Empty reply text',
};

export class RuntimeProtocolError extends Error {
  readonly code: RuntimeErrorCode;

  constructor(code: RuntimeErrorCode) {
    const fixedMessage = RUNTIME_ERROR_MESSAGES[code] || 'Runtime protocol error';
    super(`[${code}] ${fixedMessage}`);
    this.name = 'RuntimeProtocolError';
    this.code = code;
  }
}

/**
 * Standard runtime reason codes for tool unavailability.
 */
export const TOOLS_UNAVAILABLE_REASONS = {
  PLATFORM_CLIENT_UNAVAILABLE: 'PLATFORM_CLIENT_UNAVAILABLE',
  TOOLS_REGISTRY_UNAVAILABLE: 'TOOLS_REGISTRY_UNAVAILABLE',
  TOOLS_SCHEMA_PROBE_FAILED: 'TOOLS_SCHEMA_PROBE_FAILED',
  TOOLS_SCHEMA_INCOMPLETE: 'TOOLS_SCHEMA_INCOMPLETE',
} as const;

export type ToolsUnavailableReasonCode =
  (typeof TOOLS_UNAVAILABLE_REASONS)[keyof typeof TOOLS_UNAVAILABLE_REASONS];

/**
 * Static UI / Display descriptions mapping for tool unavailability codes.
 * Note: Never returned in authoritative runtime health protocol status.
 */
export const TOOLS_UNAVAILABLE_DESCRIPTIONS: Readonly<Record<ToolsUnavailableReasonCode, string>> = {
  PLATFORM_CLIENT_UNAVAILABLE:
    'Platform client service is unavailable (zero-network / no-UDS mount architecture); tool schemas registered but platform tools execution is disabled',
  TOOLS_REGISTRY_UNAVAILABLE: 'Tools registry service is not registered or unavailable',
  TOOLS_SCHEMA_PROBE_FAILED: 'Failed to probe tools registry schemas',
  TOOLS_SCHEMA_INCOMPLETE: 'Tool schemas are incomplete or fewer than 4 tools registered',
};

export const ALLOWED_TOOLS_UNAVAILABLE_CODES: Set<ToolsUnavailableReasonCode> =
  new Set<ToolsUnavailableReasonCode>(
    Object.values(TOOLS_UNAVAILABLE_REASONS) as ToolsUnavailableReasonCode[]
  );

export function isAllowedToolsUnavailableReason(reason: unknown): reason is ToolsUnavailableReasonCode {
  return (
    typeof reason === 'string' &&
    reason.length > 0 &&
    reason === reason.trim() &&
    ALLOWED_TOOLS_UNAVAILABLE_CODES.has(reason as ToolsUnavailableReasonCode)
  );
}

/**
 * Exact canonical session ID pattern for runtime protocol:
 * Platform UUID session (`ses_<32hex>`) or HappyClaw deterministic import (`import-<32hex>`).
 */
export const RUNTIME_SESSION_ID_PATTERN = /^(ses_[0-9a-f]{32}|import-[0-9a-f]{32})$/;

/**
 * Exact canonical turn ID pattern for runtime protocol:
 * Turn run UUID identifier (`turn_<32hex>`).
 */
export const RUNTIME_TURN_ID_PATTERN = /^turn_[0-9a-f]{32}$/;

export interface PluginReadinessStatus {
  receiptStore: boolean;
  inbound: boolean;
  eventRelay: boolean;
  /** Whether tool schemas are registered in DSH ToolsRegistry (honestly true when the 4 canonical schemas are registered, even under zero-network where execution is unavailable) */
  tools: boolean;
  externalInteraction: boolean;
  affinityPolicy: boolean;
  llmAffinity: boolean;
}

export interface RuntimeHealthStatus {
  status: 'ok' | 'degraded' | 'error';
  uptimeSeconds: number;
  userId: string;
  dshReady: boolean;
  enkeepBundleLoaded: boolean;
  /** Active LLM model provider (returns the actual active provider key such as 'cpa-claude' when real model enabled, 'demo' when zero-key demo model) */
  modelProvider: string;
  plugins: PluginReadinessStatus;
  /** Number of tool schemas registered in DSH ToolsRegistry */
  toolsCount: number;
  /** Whether platform tools are operational (mandatory explicit boolean; false under zero-network/no-UDS) */
  toolsOperational: boolean;
  /** Reason code why platform tools are disabled (mandatory code when toolsOperational is false; null when toolsOperational is true) */
  toolsUnavailableReason: ToolsUnavailableReasonCode | null;
  version: string;
  /** Cryptographic mount hash (deterministic SHA-256 of mount descriptors, zero host paths) */
  mountHash?: string;
  /** Active mount generation counter */
  mountGeneration?: number;
}

/** Default execution timeout for followup turns (300 seconds / 5 minutes to accommodate large context LLM calls) */
export const DEFAULT_FOLLOWUP_TIMEOUT_MS = 300_000;

export interface FallbackTarget {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string | null;
}

export interface AgentFollowupRequest {
  prompt: string;
  sessionId: string;
  turnId: string;
  profile: AgentProfileSnapshot | null;
  /** Optional profileSnapshot alias */
  profileSnapshot?: AgentProfileSnapshot | null;
  /** Optional authoritative workspaceFolder for multi-space isolation */
  workspaceFolder?: string | RuntimeWorkspaceSegment;
  /** @deprecated Optional legacy spaceId property name */
  spaceId?: string;
  /** Optional turn execution timeout override in ms (default: 300,000ms) */
  timeoutMs?: number;
  /** Optional attachments for the turn */
  attachments?: readonly CanonicalAttachment[];
  /** Optional effective model selection resolved for this turn */
  modelSelection?: {
    provider: string;
    model: string;
    reasoningEffort?: string | null;
    source?: string;
    fallbackChain?: readonly FallbackTarget[];
  } | null;
  /** Optional quote/reply reference */
  replyReference?: {
    readonly replyToMessageId: string;
    readonly snippet: string;
    readonly role?: string;
  } | null;
  /** Optional controlled host mounts for space context */
  mounts?: readonly RuntimeMountSpec[] | null;
  /** Optional generic extension activation plan */
  extensionPlan?: ExtensionActivationPlan | null;
}

export interface AgentFollowupCompletedResponse {
  sessionId: string;
  turnId: string;
  status: 'completed';
  replyText: string;
  eventsCount: number;
  persisted: true;
  usage?: {
    totalTokens: number;
  };
  modelInfo?: {
    provider: string;
    model: string;
    reasoningEffort?: string | null;
    source?: string;
    fallbackUsed?: boolean;
  };
  routeAttempts?: Array<{
    provider: string;
    model: string;
    latencyMs: number;
    statusCode: number;
    success: boolean;
    errorType?: string | null;
  }>;
}

export interface AgentFollowupCancelledResponse {
  sessionId: string;
  turnId: string;
  status: 'cancelled';
  replyText?: undefined;
  eventsCount: number;
  persisted: boolean;
}

export type AgentFollowupResponse =
  | AgentFollowupCompletedResponse
  | AgentFollowupCancelledResponse;

export interface RuntimeTransport {
  readonly mode: 'exec';
  readonly endpoint: string;
  checkHealth(): Promise<RuntimeHealthStatus>;
  sendFollowup(request: AgentFollowupRequest): Promise<AgentFollowupResponse>;
  close(): Promise<void>;
}

/**
 * Minimal typed port for persistent in-container daemon transport operations.
 */
export interface RuntimeDaemonTransportPort {
  readonly mode?: 'exec' | string;
  readonly endpoint?: string;
  start(): Promise<void>;
  close(): Promise<void>;
  isConnected(): boolean;
  checkHealth(): Promise<RuntimeHealthStatus>;
  sendFollowup(request: AgentFollowupRequest): Promise<AgentFollowupResponse>;
  checkSessionArtifact?(
    sessionId: string,
    workspaceFolder?: string
  ): Promise<CheckSessionArtifactResponse>;
  inspectSessionCorruption?(
    sessionId: string,
    workspaceFolder?: string
  ): Promise<InspectCorruptionResponse>;
  recoverSessionPrefix?(options: {
    sourceSessionId: string;
    targetSessionId: string;
    workspaceFolder?: string;
    maxValidSeq?: number;
  }): Promise<RecoverPrefixResponse>;
  exportForkSeed?(
    sessionId: string,
    boundary?: { fromMessageId?: string; fromTurnId?: string },
    workspaceFolder?: string
  ): Promise<ExportForkSeedResponse>;
  importSeed?(
    sessionId: string,
    seed: readonly unknown[],
    receipt?: unknown,
    profile?: unknown,
    spaceId?: string
  ): Promise<ImportSeedResponse>;
  cancelTurn?(turnId: string, reason?: string): Promise<CancelResponse>;
  inspectTurn?(turnId: string): Promise<InspectTurnResponse>;
  fileOperation?(request: FileOperationRequest): Promise<FileOpDaemonResponse>;
  instructionsRead?(request: { target: 'global' | 'space'; spaceFolder?: string; filename?: string }): Promise<InstructionsReadResponse>;
  instructionsWrite?(request: { target: 'global' | 'space'; content: string; spaceFolder?: string; filename?: string; expectedEtag?: string | null; requireAbsent?: boolean }): Promise<InstructionsWriteResponse>;
  answerApproval?(sessionId: string, approvalId: string, decision: 'allowed-once' | 'rejected' | 'allowed-always'): Promise<AnswerApprovalResponse>;
  listApprovals?(sessionId: string): Promise<ListApprovalsResponse>;
  request?<TReq extends DaemonRequest, TRes extends DaemonResponse>(
    req: TReq,
    timeoutMs?: number
  ): Promise<TRes>;
}
