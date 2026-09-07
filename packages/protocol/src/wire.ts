import type {
  ContainerId,
  ExecutionId,
  RequestId,
  RunId,
  RuntimeWorkspaceSegment,
  SessionId,
  TaskId,
  UserId,
  WorkspaceId,
} from './branded.js';
import type { ErrorEnvelope, ErrorPayload } from './errors.js';

/**
 * Standard HTTP/Wire header names used between container DSH and Enkeep platform.
 */
export const ProtocolHeaders = {
  REQUEST_ID: 'x-request-id',
  CORRELATION_ID: 'x-correlation-id',
  CONTAINER_ID: 'x-enkeep-container-id',
  SESSION_ID: 'x-enkeep-session-id',
  RUN_ID: 'x-enkeep-run-id',
  WORKSPACE_ID: 'x-enkeep-workspace-id',
  TIMESTAMP: 'x-enkeep-timestamp',
  CLIENT_VERSION: 'x-enkeep-client-version',
} as const;

export type ProtocolHeaderName = (typeof ProtocolHeaders)[keyof typeof ProtocolHeaders];

/**
 * Logical Session Header metadata in official DSH rc1 format.
 * `isSeeded` indicates whether the session contains a fork/replay-inherited event prefix.
 */
export interface LogicalSessionHeader {
  readonly version: number;
  readonly id: SessionId;
  readonly createdAt: number;
  readonly isSeeded: boolean;
  readonly cwd?: string;
  readonly parentSession?: SessionId;
  readonly origin?: 'subagent';
  readonly delegationDepth?: number;
  readonly agentPreset?: string;
}

/** Alias for LogicalSessionHeader */
export type SessionHeader = LogicalSessionHeader;


/**
 * Container lifecycle state enum.
 */
export type ContainerState = 'starting' | 'ready' | 'busy' | 'draining' | 'terminating' | 'terminated';

/**
 * Run / task execution status enum.
 */
export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out';

/**
 * Log levels for container execution logging.
 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/**
 * Container Handshake Payload (sent on startup by container DSH to register with platform).
 */
export interface ContainerHandshakeRequest {
  readonly containerId: ContainerId;
  readonly workspaceId: WorkspaceId;
  readonly clientVersion: string;
  readonly dshVersion?: string;
  readonly nodeVersion?: string;
  readonly startedAt: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ContainerHandshakeResponse {
  readonly containerId: ContainerId;
  readonly registered: boolean;
  readonly platformVersion: string;
  readonly heartbeatIntervalMs: number;
  readonly sessionDefaults?: {
    readonly timeoutMs?: number;
    readonly maxPayloadBytes?: number;
  };
}

/**
 * Container Heartbeat Payload.
 */
export interface ContainerHeartbeatRequest {
  readonly containerId: ContainerId;
  readonly state: ContainerState;
  readonly activeRunsCount: number;
  readonly memoryUsageBytes?: number;
  readonly timestamp: string;
}

export interface ContainerHeartbeatResponse {
  readonly acknowledged: boolean;
  readonly shouldDrain?: boolean;
  readonly timestamp: string;
}

/**
 * Container Teardown / Drain Request.
 */
export interface ContainerTeardownRequest {
  readonly containerId: ContainerId;
  readonly reason: string;
  readonly exitCode?: number;
  readonly timestamp: string;
}

export interface ContainerTeardownResponse {
  readonly acknowledged: boolean;
}

/**
 * Run Lifecycle Event Payload (sent by container when a run state transitions).
 */
export interface RunStateChangeEvent {
  readonly eventId: RequestId;
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly taskId?: TaskId;
  readonly containerId: ContainerId;
  readonly status: RunStatus;
  readonly error?: ErrorPayload;
  readonly resultSummary?: Record<string, unknown>;
  readonly timestamp: string;
}

/**
 * Run Log Event Payload (streamed from container execution).
 */
export interface RunLogEntry {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly level: LogLevel;
  readonly message: string;
  readonly stream?: 'stdout' | 'stderr' | 'system';
  readonly timestamp: string;
  readonly data?: Record<string, unknown>;
}

export interface RunLogBatchRequest {
  readonly containerId: ContainerId;
  readonly entries: readonly RunLogEntry[];
}

export interface RunLogBatchResponse {
  readonly acceptedCount: number;
}

/**
 * Human-in-the-loop Approval Request Payload.
 */
export interface ApprovalRequestPayload {
  readonly approvalId: RequestId;
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly containerId: ContainerId;
  readonly actionType: string;
  readonly actionDetails: Record<string, unknown>;
  readonly requestedByUserId?: UserId;
  readonly timeoutMs?: number;
  readonly timestamp: string;
}

export interface ApprovalDecisionPayload {
  readonly approvalId: RequestId;
  readonly runId: RunId;
  readonly approved: boolean;
  readonly decidedByUserId?: UserId;
  readonly reason?: string;
  readonly modifiedParams?: Record<string, unknown>;
  readonly decidedAt: string;
}

/**
 * Generic Event envelope for container -> platform asynchronous events.
 */
export interface ContainerEventEnvelope<T = unknown> {
  readonly eventType: string;
  readonly containerId: ContainerId;
  readonly eventId: RequestId;
  readonly timestamp: string;
  readonly payload: T;
}

/**
 * Standard RPC Request Envelope.
 */
export interface RpcRequestEnvelope<TParams = unknown> {
  readonly id: RequestId;
  readonly method: string;
  readonly params: TParams;
  readonly metadata?: {
    readonly sessionId?: SessionId;
    readonly runId?: RunId;
    readonly containerId?: ContainerId;
    readonly timestamp?: string;
  };
}

/**
 * Standard RPC Response Envelope.
 */
export type RpcResponseEnvelope<TResult = unknown> =
  | {
      readonly id: RequestId;
      readonly success: true;
      readonly result: TResult;
    }
  | {
      readonly id: RequestId;
      readonly success: false;
      readonly error: ErrorPayload;
    };

/**
 * Maximum number of attachments per message.
 */
export const MAX_MESSAGE_ATTACHMENTS = 10;

/**
 * Maximum character length of attachment displayName.
 */
export const MAX_ATTACHMENT_DISPLAY_NAME_LENGTH = 255;

/**
 * Raw attachment item in POST /api/sessions/:sessionId/messages request body.
 */
export interface MessageAttachmentRequestItem {
  readonly path: string;
  readonly etag: string;
  readonly mimeType?: string;
  readonly displayName?: string;
}

/**
 * Validated canonical attachment reference stored durably and passed internally.
 */
export interface CanonicalAttachment {
  readonly id: string;
  readonly relativePath: string;
  readonly snapshotPath: string;
  readonly etag: string;
  readonly size: number;
  readonly mediaType: string;
  readonly displayName?: string;
  readonly downloadReference: string;
}

/**
 * Public safe attachment DTO returned on public message queries.
 */
export interface PublicMessageAttachment {
  readonly id: string;
  readonly relativePath: string;
  readonly etag: string;
  readonly size: number;
  readonly mediaType: string;
  readonly displayName?: string;
  readonly downloadUrl: string;
}

export interface RuntimeFallbackTarget {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string | null;
}

/**
 * Risk level classification for MCP tools.
 */
export type McpRiskLevel = 'read-only' | 'low' | 'mutation' | 'high' | 'critical';

/**
 * Granular policy for an individual MCP tool within a server plan.
 */
export interface McpToolPolicy {
  /** Raw wire tool name exposed by the MCP server */
  readonly name: string;
  /** Whether the tool is enabled and allowed to be registered */
  readonly enabled?: boolean;
  /** Override risk classification for approval governance */
  readonly riskLevel?: McpRiskLevel;
  /** Explicit override whether executing this tool always requires human approval */
  readonly requiresApproval?: boolean;
  /** Whether this tool is concurrency-safe (side-effect free) */
  readonly isConcurrencySafe?: boolean;
  /** Custom per-tool execution timeout in milliseconds */
  readonly timeoutMs?: number;
  /** Maximum inline content byte budget before spilling/truncating (defaults to 64KB) */
  readonly maxInlineBytes?: number;
}

/**
 * Protocol-neutral declaration of one MCP Server in an Agent's effective plan.
 * Contains ZERO secrets, authentication tokens, or sensitive transport configs.
 */
export interface McpServerPlan {
  /** Unique stable server identifier on the platform (e.g. "github-srv-1", "sqlite-srv-2") */
  readonly serverId: string;
  /** Deterministic local namespace name matching [A-Za-z0-9_-]{1,32} (e.g. "github", "sqlite") */
  readonly serverName: string;
  /** Optional human-readable description */
  readonly description?: string;
  /** Optional server-level tool allowlist (if provided, only listed tool names are admitted) */
  readonly allowTools?: readonly string[];
  /** Optional server-level tool denylist (if provided, listed tool names are rejected) */
  readonly denyTools?: readonly string[];
  /** Optional per-tool policies and overrides */
  readonly toolPolicies?: readonly McpToolPolicy[];
  /** Server-level default tool timeout in milliseconds (default: 60,000ms) */
  readonly defaultTimeoutMs?: number;
  /** Whether all tools on this server default to requiring user approval for mutations */
  readonly defaultRequireApprovalOnMutation?: boolean;
}

/**
 * Effective MCP Plan injected into an Agent turn context by the Platform executor.
 * Strictly protocol-neutral and secret-free.
 */
export interface EffectiveMcpPlan {
  /** Version or hash of this effective plan composition */
  readonly planVersion?: string;
  /** Ordered list of active MCP server configurations for this turn/session */
  readonly servers: readonly McpServerPlan[];
  /** Global default inline content budget (default: 65,536 / 64KB) */
  readonly globalMaxInlineBytes?: number;
}

/**
 * Memory injection policy mode for global user memory.
 */
export type MemoryInjectionMode = 'always' | 'never' | 'auto';

/**
 * Protocol-neutral memory plan configuration injected into an Agent turn context.
 */
export interface MemoryPlan {
  /** Injection mode for global memory (HappyClaw default: 'always') */
  readonly injectGlobalMemory?: MemoryInjectionMode;
  /** Optional custom relative or absolute path to global memory file */
  readonly globalMemoryPath?: string;
  /** Optional custom space memory directory */
  readonly spaceMemoryPath?: string;
  /** Explicit revision identifier for memory snapshot */
  readonly revision?: string;
  /** Cryptographic content hash of the expected memory snapshot */
  readonly hash?: string;
  /** Maximum global memory bytes to inject inline (default: 20,480 / 20KB) */
  readonly maxGlobalBytes?: number;
}

/**
 * Controlled runtime mount specification injected into runtime turns and containers.
 */
export interface RuntimeMountSpec {
  readonly id: string;
  readonly name: string;
  readonly sourcePath: string;
  readonly mode: 'ro' | 'rw';
}

/**
 * Activated generic extension contribution descriptor for Skills.
 */
export interface ExtensionSkillContributionActivation {
  readonly kind: 'skill';
  readonly contributionId: string;
  readonly contributionKey: string;
  readonly name: string;
  readonly description?: string | null;
  readonly whenToUse?: string | null;
  readonly version?: number;
  readonly enabled: boolean;
  readonly modelInvocable: boolean;
  readonly userInvocable: boolean;
  readonly artifactRelPath?: string;
  readonly contentHash?: string;
}

/**
 * Activated generic extension contribution descriptor for MCP Servers.
 */
export interface ExtensionMcpContributionActivation {
  readonly kind: 'mcp';
  readonly contributionId: string;
  readonly contributionKey?: string;
  readonly name: string;
  readonly description?: string | null;
  readonly whenToUse?: string | null;
  readonly version?: number;
  readonly enabled: boolean;
  readonly modelInvocable?: boolean;
  readonly userInvocable?: boolean;
  readonly artifactRelPath?: string;
  readonly contentHash?: string;
  readonly transport?: 'stdio' | 'streamable-http';
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly url?: string;
  readonly headers?: Record<string, string>;
  readonly credentialRefs?: readonly { id: string; type?: string; scope?: string }[];
  readonly toolTimeoutMs?: number;
}

/**
 * Activated generic extension contribution descriptor for CLI Tools.
 */
export interface ExtensionCliContributionActivation {
  readonly kind: 'cli';
  readonly contributionId: string;
  readonly contributionKey: string;
  readonly name: string;
  readonly description?: string | null;
  readonly whenToUse?: string | null;
  readonly version?: number;
  readonly enabled: boolean;
  readonly modelInvocable?: boolean;
  readonly userInvocable?: boolean;
  readonly artifactRelPath?: string;
  readonly contentHash?: string;
  readonly command?: string;
  readonly script?: string;
  readonly fixedArgs?: readonly string[];
  readonly executionMode?: 'container' | 'host' | 'space';
  readonly timeoutMs?: number;
}

/**
 * Activated generic extension contribution descriptor for Trusted DSH Plugins.
 */
export interface ExtensionDshPluginContributionActivation {
  readonly kind: 'dsh-plugin';
  readonly contributionId: string;
  readonly contributionKey: string;
  readonly trustedPluginId: string;
  readonly name: string;
  readonly description?: string | null;
  readonly whenToUse?: string | null;
  readonly version: number;
  readonly integrity: string;
  readonly enabled: boolean;
  readonly config?: Record<string, unknown>;
}

/**
 * Discriminated union of generic extension contribution activations.
 * Supports 'skill', 'mcp', 'cli', and 'dsh-plugin' contributions.
 */
export type ExtensionContributionActivation =
  | ExtensionSkillContributionActivation
  | ExtensionMcpContributionActivation
  | ExtensionCliContributionActivation
  | ExtensionDshPluginContributionActivation;

/**
 * Generic Extension Activation Plan injected transiently per turn.
 * Encapsulates generation versioning and active contribution descriptors.
 */
export interface ExtensionActivationPlan {
  readonly generation: number;
  readonly contributions: readonly ExtensionContributionActivation[];
  /** Convenience accessor for active skill contributions */
  readonly skills: readonly ExtensionSkillContributionActivation[];
  /** Convenience accessor for active mcp contributions */
  readonly mcp?: readonly ExtensionMcpContributionActivation[];
  /** Convenience accessor for active cli contributions */
  readonly cli?: readonly ExtensionCliContributionActivation[];
  /** Convenience accessor for active dsh-plugin contributions */
  readonly plugins?: readonly ExtensionDshPluginContributionActivation[];
}

/**
 * Validates an extension activation plan and ensures strict fail-closed rejection
 * of any unhandled contribution kinds. Currently permits 'skill', 'mcp', 'cli', and 'dsh-plugin'.
 */
export function validateExtensionActivationPlan(plan: unknown): ExtensionActivationPlan {
  if (!plan || typeof plan !== 'object') {
    throw new Error('ExtensionActivationPlan must be a non-null object');
  }

  const raw = plan as Record<string, unknown>;
  if (typeof raw.generation !== 'number' || !Number.isInteger(raw.generation) || raw.generation < 0) {
    throw new Error('ExtensionActivationPlan generation must be a non-negative integer');
  }

  const contributionsRaw: unknown[] = [];
  if (Array.isArray(raw.contributions)) {
    contributionsRaw.push(...raw.contributions);
  } else {
    if (Array.isArray(raw.skills)) {
      contributionsRaw.push(...raw.skills);
    }
    if (Array.isArray(raw.mcp)) {
      contributionsRaw.push(...raw.mcp);
    }
    if (Array.isArray(raw.cli)) {
      contributionsRaw.push(...raw.cli);
    }
    if (Array.isArray(raw.plugins)) {
      contributionsRaw.push(...raw.plugins);
    }
  }

  const validatedSkills: ExtensionSkillContributionActivation[] = [];
  const validatedMcp: ExtensionMcpContributionActivation[] = [];
  const validatedCli: ExtensionCliContributionActivation[] = [];
  const validatedPlugins: ExtensionDshPluginContributionActivation[] = [];
  const validatedContributions: ExtensionContributionActivation[] = [];

  for (let i = 0; i < contributionsRaw.length; i++) {
    const item = contributionsRaw[i];
    if (!item || typeof item !== 'object') {
      throw new Error(`Extension contribution at index ${i} must be an object`);
    }

    const c = item as Record<string, unknown>;
    const kind = c.kind ?? 'skill';

    if (kind !== 'skill' && kind !== 'mcp' && kind !== 'cli' && kind !== 'dsh-plugin') {
      throw new Error(
        `FAIL-CLOSED: Unknown or unsupported extension contribution kind "${String(kind)}" at index ${i}. Only "skill", "mcp", "cli", and "dsh-plugin" are activated.`
      );
    }

    if (typeof c.contributionId !== 'string' || !c.contributionId.trim()) {
      throw new Error(`Extension contribution at index ${i} requires a non-empty string contributionId`);
    }
    if (typeof c.name !== 'string' || !c.name.trim()) {
      throw new Error(`Extension contribution at index ${i} requires a non-empty string name`);
    }

    if (kind === 'skill') {
      const skillContrib: ExtensionSkillContributionActivation = {
        kind: 'skill',
        contributionId: c.contributionId.trim(),
        contributionKey: typeof c.contributionKey === 'string' && c.contributionKey.trim() ? c.contributionKey.trim() : c.name.trim(),
        name: c.name.trim(),
        description: typeof c.description === 'string' ? c.description : null,
        whenToUse: typeof c.whenToUse === 'string' ? c.whenToUse : null,
        version: typeof c.version === 'number' ? c.version : undefined,
        enabled: c.enabled !== false,
        modelInvocable: c.modelInvocable !== false,
        userInvocable: c.userInvocable !== false,
        artifactRelPath: typeof c.artifactRelPath === 'string' ? c.artifactRelPath : undefined,
        contentHash: typeof c.contentHash === 'string' ? c.contentHash : undefined,
      };
      validatedSkills.push(skillContrib);
      validatedContributions.push(skillContrib);
    } else if (kind === 'mcp') {
      const mcpContrib: ExtensionMcpContributionActivation = {
        kind: 'mcp',
        contributionId: c.contributionId.trim(),
        contributionKey: typeof c.contributionKey === 'string' && c.contributionKey.trim() ? c.contributionKey.trim() : c.name.trim(),
        name: c.name.trim(),
        description: typeof c.description === 'string' ? c.description : null,
        whenToUse: typeof c.whenToUse === 'string' ? c.whenToUse : null,
        version: typeof c.version === 'number' ? c.version : undefined,
        enabled: c.enabled !== false,
        modelInvocable: c.modelInvocable !== false,
        userInvocable: c.userInvocable !== false,
        artifactRelPath: typeof c.artifactRelPath === 'string' ? c.artifactRelPath : undefined,
        contentHash: typeof c.contentHash === 'string' ? c.contentHash : undefined,
        transport: c.transport as ('stdio' | 'streamable-http') | undefined,
        command: typeof c.command === 'string' ? c.command : undefined,
        args: Array.isArray(c.args) ? c.args.map(String) : undefined,
        cwd: typeof c.cwd === 'string' ? c.cwd : undefined,
        url: typeof c.url === 'string' ? c.url : undefined,
        headers: c.headers && typeof c.headers === 'object' && !Array.isArray(c.headers) ? c.headers as Record<string, string> : undefined,
        credentialRefs: Array.isArray(c.credentialRefs) ? c.credentialRefs as { id: string; type?: string; scope?: string }[] : undefined,
        toolTimeoutMs: typeof c.toolTimeoutMs === 'number' ? c.toolTimeoutMs : undefined,
      };
      validatedMcp.push(mcpContrib);
      validatedContributions.push(mcpContrib);
    } else if (kind === 'cli') {
      const cliContrib: ExtensionCliContributionActivation = {
        kind: 'cli',
        contributionId: c.contributionId.trim(),
        contributionKey: typeof c.contributionKey === 'string' && c.contributionKey.trim() ? c.contributionKey.trim() : c.name.trim(),
        name: c.name.trim(),
        description: typeof c.description === 'string' ? c.description : null,
        whenToUse: typeof c.whenToUse === 'string' ? c.whenToUse : null,
        version: typeof c.version === 'number' ? c.version : undefined,
        enabled: c.enabled !== false,
        modelInvocable: c.modelInvocable !== false,
        userInvocable: c.userInvocable !== false,
        artifactRelPath: typeof c.artifactRelPath === 'string' ? c.artifactRelPath : undefined,
        contentHash: typeof c.contentHash === 'string' ? c.contentHash : undefined,
        command: typeof c.command === 'string' ? c.command : 'node',
        script: typeof c.script === 'string' ? c.script : undefined,
        fixedArgs: Array.isArray(c.fixedArgs) ? c.fixedArgs.map(String) : (Array.isArray(c.args) ? c.args.map(String) : undefined),
        executionMode: (c.executionMode === 'container' || c.executionMode === 'host' || c.executionMode === 'space') ? c.executionMode : undefined,
        timeoutMs: typeof c.timeoutMs === 'number' ? c.timeoutMs : undefined,
      };
      validatedCli.push(cliContrib);
      validatedContributions.push(cliContrib);
    } else if (kind === 'dsh-plugin') {
      if (typeof c.trustedPluginId !== 'string' || !c.trustedPluginId.trim()) {
        throw new Error(`Extension contribution at index ${i} requires a non-empty string trustedPluginId`);
      }
      if (typeof c.version !== 'number' || !Number.isInteger(c.version) || c.version < 1) {
        throw new Error(`Extension contribution at index ${i} requires a positive integer version`);
      }
      if (typeof c.integrity !== 'string' || !c.integrity.trim()) {
        throw new Error(`Extension contribution at index ${i} requires a non-empty string integrity`);
      }

      const pluginContrib: ExtensionDshPluginContributionActivation = {
        kind: 'dsh-plugin',
        contributionId: c.contributionId.trim(),
        contributionKey: typeof c.contributionKey === 'string' && c.contributionKey.trim() ? c.contributionKey.trim() : c.name.trim(),
        trustedPluginId: c.trustedPluginId.trim(),
        name: c.name.trim(),
        description: typeof c.description === 'string' ? c.description : null,
        whenToUse: typeof c.whenToUse === 'string' ? c.whenToUse : null,
        version: c.version,
        integrity: c.integrity.trim(),
        enabled: c.enabled !== false,
        config: c.config && typeof c.config === 'object' && !Array.isArray(c.config) ? c.config as Record<string, unknown> : undefined,
      };
      validatedPlugins.push(pluginContrib);
      validatedContributions.push(pluginContrib);
    }
  }

  return {
    generation: raw.generation as number,
    contributions: Object.freeze(validatedContributions),
    skills: Object.freeze(validatedSkills),
    mcp: Object.freeze(validatedMcp),
    cli: Object.freeze(validatedCli),
    plugins: Object.freeze(validatedPlugins),
  };
}

/**
 * Standard named turn request passed to runtime handles and container executors.
 */
export interface RuntimeTurnRequest {
  readonly prompt: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly profileSnapshot?: unknown;
  readonly workspaceFolder?: string | RuntimeWorkspaceSegment;
  readonly attachments?: readonly CanonicalAttachment[];
  readonly timeoutMs?: number;
  readonly modelSelection?: {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: string | null;
    readonly source?: string;
    readonly fallbackChain?: readonly RuntimeFallbackTarget[];
  } | null;
  /** Optional effective MCP governance plan injected by platform executor */
  readonly mcpPlan?: EffectiveMcpPlan | null;
  /** Optional memory plan or revision configuration for memory snapshot injection */
  readonly memoryPlan?: MemoryPlan | null;
  /** Optional explicit memory revision string */
  readonly memoryRevision?: string | null;
  /** Optional runtime mounts injected by platform executor for the space */
  readonly mounts?: readonly RuntimeMountSpec[];
  /** Optional generic extension activation plan */
  readonly extensionPlan?: ExtensionActivationPlan | null;
}



