/**
 * MCP Protocol and Host Service Core Type Contracts
 *
 * Defines interfaces for:
 * - CredentialResolverPort (ephemeral credentials per user/credentialRef)
 * - Contribution manifests and server descriptors (stdio argv/package roots/env and streamable-http)
 * - McpGatewayPort (listTools, callTool, checkHealth/health, reconcile, dispose)
 * - Effective per-turn plans (dynamic filtering)
 * - Catalog providers (dynamic server registry)
 * - Audit and Metrics hooks
 *
 * @module @enkeep/platform-service-mcp/types
 */

export const DEFAULT_TOOL_TIMEOUT_MS = 15000; // 15 seconds
export const DEFAULT_INIT_TIMEOUT_MS = 10000; // 10 seconds
export const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024; // 4 MiB
export const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 3; // 3 failures
export const DEFAULT_CIRCUIT_RESET_TIMEOUT_MS = 60000; // 60 seconds

export type McpServerTransportType = 'stdio' | 'streamable-http' | 'http';

/**
 * Reference to a stored credential (resolved at runtime via CredentialResolverPort).
 */
export interface McpCredentialRef {
  readonly id: string;
  readonly type?: string;
  readonly scope?: string;
}

/**
 * Resolved ephemeral credentials. Invariant: never logged, never stored, never leaked to container/agent.
 */
export interface McpResolvedCredentials {
  readonly env?: Record<string, string>;
  readonly headers?: Record<string, string>;
}

/**
 * Port for resolving tenant/user credentials securely in platform host memory.
 */
export interface CredentialResolverPort {
  resolveCredentials(
    userId: string,
    credentialRef: McpCredentialRef,
  ): Promise<McpResolvedCredentials | null>;
}

/**
 * Contribution source classification for approval policies.
 */
export type McpContributionSource = 'builtin' | 'signed-extension' | 'user-extension' | string;

/**
 * Base descriptor for an MCP contribution manifest and server definition.
 */
export interface McpServerBaseDescriptor {
  readonly id: string;
  readonly contributionId?: string;
  readonly name: string;
  readonly description?: string;
  readonly version?: string;
  readonly transport: McpServerTransportType;
  readonly credentialRefs?: readonly (McpCredentialRef | string)[];
  readonly envRefs?: readonly (McpCredentialRef | string)[] | Record<string, string>;
  /** Optional timeout for tool execution in milliseconds (default: 15000 / 15s) */
  readonly toolTimeoutMs?: number;
  /** Optional initialization timeout in milliseconds (default: 10000 / 10s) */
  readonly initTimeoutMs?: number;
  /** Optional maximum output bytes (default: 4 MiB) */
  readonly maxOutputBytes?: number;
  /** Space IDs for which this server is visible/bound (space binding controls visibility) */
  readonly spaceIds?: readonly string[];
  /** Whether this MCP contribution has been approved by admin (required for user extensions) */
  readonly adminApproved?: boolean;
  /** Manifest source */
  readonly source?: McpContributionSource;
}

/**
 * Stdio transport contribution manifest and server descriptor.
 */
export interface McpStdioServerDescriptor extends McpServerBaseDescriptor {
  readonly transport: 'stdio';
  /**
   * Command to execute (must be allowlisted executable name or path inside allowlisted package root).
   * Direct argv execution only (NEVER shell interpolated).
   */
  readonly command: string;
  /** Command line arguments (alias: argv) */
  readonly args?: readonly string[];
  readonly argv?: readonly string[];
  /** Working directory (Enkeep-controlled, must be within allowlisted root if restricted) */
  readonly cwd?: string;
  readonly cwdMode?: 'enkeep-controlled' | 'workspace' | 'temp' | string;
  /** Static environment variables (will be filtered against env whitelist) */
  readonly env?: Record<string, string>;
  /** Whitelisted executable names or paths specific to this server */
  readonly allowlistedExecutables?: readonly string[];
  /** Package roots where local scripts / extension artifacts may reside */
  readonly packageRoots?: readonly string[];
}

/**
 * Streamable-HTTP transport contribution manifest and server descriptor.
 */
export interface McpHttpServerDescriptor extends McpServerBaseDescriptor {
  readonly transport: 'streamable-http' | 'http';
  /** Public HTTPS URL of the MCP server endpoint */
  readonly url: string;
  /** Static HTTP headers */
  readonly headers?: Record<string, string>;
  /** Optional allowed hostnames override */
  readonly allowedHosts?: readonly string[];
}

export type McpServerDescriptor = McpStdioServerDescriptor | McpHttpServerDescriptor;

/**
 * Extension contribution manifest formats.
 */
export type McpStdioContributionManifest = McpStdioServerDescriptor;
export type McpHttpContributionManifest = McpHttpServerDescriptor;
export type McpContributionManifest = McpStdioContributionManifest | McpHttpContributionManifest;

/**
 * Normalized Tool Definition exposed to agents.
 */
export interface McpToolDefinition {
  /** Normalized unique tool name (e.g. `serverSlug__originalToolName` or `originalToolName`) */
  readonly name: string;
  /** Human-readable description */
  readonly description?: string;
  /** JSON Schema of the input arguments */
  readonly inputSchema: Record<string, unknown>;
  /** Originating server / contribution ID */
  readonly serverId: string;
  /** Original un-namespaced tool name on downstream server */
  readonly originalName: string;
}

/**
 * Content block in an MCP tool execution result.
 * Bounded to text and structured JSON content for P1.
 */
export type McpToolContent =
  | {
      readonly type: 'text';
      readonly text: string;
    }
  | {
      readonly type: 'image';
      readonly data: string;
      readonly mimeType: string;
    }
  | {
      readonly type: 'resource';
      readonly resource: {
        readonly uri: string;
        readonly mimeType?: string;
        readonly text?: string;
        readonly blob?: string;
      };
    };

/**
 * Typed tool call result.
 */
export interface McpToolCallResult {
  readonly content: readonly McpToolContent[];
  readonly structuredContent?: Record<string, unknown> | readonly unknown[];
  readonly isError?: boolean;
  readonly _meta?: Record<string, unknown>;
}

/**
 * Contextual metadata for an MCP invocation.
 */
export interface McpContext {
  readonly userId: string;
  readonly spaceId?: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly requestId?: string;
  readonly serverId?: string;
  readonly runtimeIdentity?: string;
  readonly signal?: AbortSignal;
}

/**
 * Effective turn plan defining which servers and tools are active for a specific turn.
 */
export interface McpEffectivePlan {
  readonly enabledServers?: readonly string[];
  readonly disabledServers?: readonly string[];
  readonly toolAllowlist?: readonly string[];
  readonly toolDenylist?: readonly string[];
}

export type McpEffectivePlanProvider = (
  context: McpContext,
) => Promise<McpEffectivePlan | null | undefined> | McpEffectivePlan | null | undefined;

/**
 * Dynamic catalog provider for discovering registered MCP servers (avoids direct DB dependency).
 */
export type McpCatalogProvider = (
  context: McpContext,
) => Promise<readonly McpServerDescriptor[]> | readonly McpServerDescriptor[];

/**
 * Server health state.
 */
export interface McpServerHealth {
  readonly serverId: string;
  readonly status: 'healthy' | 'degraded' | 'unhealthy' | 'stopped';
  readonly circuitState: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  readonly consecutiveFailures: number;
  readonly lastError?: string;
  readonly lastProbeTime?: number;
  readonly activeProcesses: number;
}

/**
 * Gateway port providing normalized tool access.
 */
export interface McpGatewayPort {
  /**
   * Lists all normalized tools available for the given context.
   */
  listTools(context: McpContext): Promise<readonly McpToolDefinition[]>;

  /**
   * Invokes a tool by its normalized name.
   */
  callTool(
    name: string,
    args: Record<string, unknown>,
    context: McpContext,
  ): Promise<McpToolCallResult>;

  /**
   * Returns health status of managed servers.
   */
  checkHealth(context: McpContext): Promise<readonly McpServerHealth[]>;

  /**
   * Alias for checkHealth.
   */
  health(context: McpContext): Promise<readonly McpServerHealth[]>;

  /**
   * Cancels an in-flight tool invocation by requestId within tenant context.
   */
  cancel(params: { requestId: string; context: McpContext }): Promise<void>;

  /**
   * Reconciles the active contribution set dynamically.
   */
  reconcile(contributions: readonly (McpServerDescriptor | McpContributionManifest)[]): Promise<void>;

  /**
   * Disposes all active child processes and pooled connections.
   */
  close(): Promise<void>;

  /**
   * Alias for close.
   */
  dispose(): Promise<void>;
}

/**
 * Audit event hook payload (contains metadata only, never raw decrypted secrets or large payloads).
 */
export interface McpAuditEvent {
  readonly timestamp: number;
  readonly eventType: 'tool_call' | 'tool_result' | 'tool_error' | 'server_spawn' | 'server_exit' | 'circuit_state_change';
  readonly serverId: string;
  readonly toolName?: string;
  readonly userId: string;
  readonly sessionId?: string;
  readonly durationMs?: number;
  readonly success: boolean;
  readonly errorCode?: string;
}

export type McpAuditHook = (event: McpAuditEvent) => void | Promise<void>;

/**
 * Usage metrics payload (no payload data).
 */
export interface McpUsageMetric {
  readonly userId: string;
  readonly serverId: string;
  readonly toolName?: string;
  readonly callCount: number;
  readonly totalDurationMs: number;
  readonly errorCount: number;
}

export type McpUsageMetricsCallback = (metric: McpUsageMetric) => void | Promise<void>;

/**
 * Host MCP Manager Configuration Options.
 */
export interface McpManagerOptions {
  /** Dynamic catalog provider */
  catalogProvider?: McpCatalogProvider;
  /** Static server descriptors */
  servers?: readonly (McpServerDescriptor | McpContributionManifest)[];
  /** Ephemeral credential resolver */
  credentialResolver?: CredentialResolverPort;
  /** Per-turn effective plan provider */
  effectivePlanProvider?: McpEffectivePlanProvider;
  /** Maximum idle time for pooled stdio processes before auto-reap (default: 30 min = 1,800,000 ms) */
  idleTimeoutMs?: number;
  /** Maximum concurrent child processes per tenant (default: 10) */
  maxProcessesPerTenant?: number;
  /** Maximum total child processes across host (default: 50) */
  maxTotalProcesses?: number;
  /** Circuit breaker consecutive failure threshold (default: 3) */
  circuitFailureThreshold?: number;
  /** Circuit breaker reset timeout in ms (default: 60,000 ms) */
  circuitResetTimeoutMs?: number;
  /** Default per-tool timeout (default: 15,000 ms) */
  defaultToolTimeoutMs?: number;
  /** Default max output bytes (default: 4 MiB) */
  defaultMaxOutputBytes?: number;
  /** Audit logging hook */
  onAudit?: McpAuditHook;
  /** Metrics hook */
  onMetric?: McpUsageMetricsCallback;
  /** Environment whitelist overrides */
  envWhitelist?: readonly string[];
  /** Global executable allowlist overrides */
  executableAllowlist?: readonly string[];
  /** Allow local HTTP for testing only (SSRF bypass for localhost in test suites) */
  allowLocalHttpForTesting?: boolean;
  /** Require admin approval for user-installed extensions (default: true) */
  requireAdminApproval?: boolean;
}
