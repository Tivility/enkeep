/**
 * Type declarations and protocol interfaces for MCP Governance
 *
 * @module @enkeep/dsh-mcp-governance/types
 */

import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolCallId, ContentBlock } from '@deepseek-ai/dsh-llm';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type {
  ExtensionActivationPlan,
  ExtensionMcpContributionActivation,
} from '@enkeep/protocol';

export type {
  ExtensionActivationPlan,
  ExtensionMcpContributionActivation,
};

/**
 * Raw tool metadata returned by Platform /api/mcp/tools endpoint.
 */
export interface RawMcpTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  readonly serverId?: string;
  readonly contributionId?: string;
  readonly originalName?: string;
  readonly annotations?: {
    readonly readOnly?: boolean;
    readonly sideEffects?: boolean;
    readonly destructive?: boolean;
    readonly audience?: readonly string[];
    readonly priority?: number;
    readonly [key: string]: unknown;
  };
  readonly execution?: {
    readonly taskSupport?: 'optional' | 'required' | 'forbidden';
    readonly [key: string]: unknown;
  };
}

/**
 * Response payload for GET /api/mcp/tools from PlatformClient.
 */
export interface ListMcpToolsResponse {
  readonly tools?: readonly RawMcpTool[];
  readonly success?: boolean;
  readonly data?: {
    readonly tools?: readonly RawMcpTool[];
  };
}

/**
 * Request payload for POST /api/mcp/call sent to PlatformClient.
 * Strict canonical body: { sessionId, toolName, args, requestId }.
 */
export interface CallMcpToolRequest {
  readonly sessionId: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly requestId: string;
}

/**
 * Request payload for POST /api/mcp/cancel sent to PlatformClient.
 * Strict canonical body: { sessionId, requestId }.
 */
export interface CancelMcpToolRequest {
  readonly sessionId: string;
  readonly requestId: string;
}

/**
 * Content block received from raw MCP server execution response.
 */
export interface RawMcpContentBlock {
  readonly type: string;
  readonly text?: string;
  readonly mimeType?: string;
  readonly data?: string;
  readonly name?: string;
  readonly uri?: string;
  readonly message?: string;
  readonly [key: string]: unknown;
}

/**
 * Raw tool call result returned by PlatformClient POST /api/mcp/call.
 */
export interface RawMcpCallToolResult {
  readonly content?: readonly RawMcpContentBlock[];
  readonly structuredContent?: JsonValue;
  readonly isError?: boolean;
  readonly toolResult?: unknown;
  readonly [key: string]: unknown;
}

/**
 * Options for a single platform client request.
 */
export interface PlatformClientRequestOptions {
  readonly method?: string;
  readonly query?: Record<string, string | number | boolean | undefined | null>;
  readonly headers?: Record<string, string | undefined>;
  readonly body?: unknown;
  readonly timeoutMs?: number;
  readonly requestId?: string;
  readonly signal?: AbortSignal;
}

/**
 * Standard PlatformClient response wrapper.
 */
export interface PlatformClientResponse<T = unknown> {
  readonly status: number;
  readonly headers?: Record<string, string | string[] | undefined>;
  readonly data?: T;
  readonly body?: T;
}

/**
 * Typed PlatformClient interface expected by MCP Governance.
 * Single unified request signature only.
 */
export interface McpPlatformClientService {
  request<T = unknown>(
    path: string,
    options?: PlatformClientRequestOptions
  ): Promise<PlatformClientResponse<T>>;
}

/**
 * Tools Registry service interface on Cordis context.
 */
export interface ToolsRegistryService {
  register(tool: ToolDefinition): () => void;
  get?(name: string): ToolDefinition | undefined;
}

/**
 * Spill Store service interface on Cordis context.
 */
export interface SpillStoreService {
  saveText(input: {
    owner: string;
    suggestedName?: string;
    source?: string;
    toolName?: string;
    content: string;
  }): Promise<{ locator: string; guidance?: string; bytes?: number }>;
}

/**
 * User Approval outcome.
 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

/**
 * User Approval request parameters.
 */
export interface ApprovalRequestParams {
  agent: Agent;
  toolName: string;
  callId?: ToolCallId;
  reason: string;
  signal?: AbortSignal;
}

/**
 * Approval service interface on Cordis context.
 */
export interface ApprovalService {
  request(params: ApprovalRequestParams): Promise<ApprovalOutcome>;
}

/**
 * Canonical MCP execution result structure.
 */
export interface McpExecutionResult<Structured extends JsonValue = JsonValue> {
  content: JsonValue[];
  structuredContent?: Structured;
}

/**
 * Health probe status for an individual MCP server / contribution.
 */
export interface McpServerHealth {
  readonly serverId: string;
  readonly serverName: string;
  readonly status: 'operational' | 'degraded' | 'unreachable' | 'filtered_out';
  readonly toolsCount: number;
  readonly registeredTools: readonly string[];
  readonly lastSyncedAt?: string;
  readonly error?: string;
}

/**
 * Truthful health and operational status for MCP Governance.
 */
export interface McpHealthStatus {
  readonly mcpConfigured: boolean;
  readonly mcpOperational: boolean;
  readonly serverCount: number;
  readonly toolCount: number;
  readonly servers: readonly McpServerHealth[];
}

/**
 * Handle returned when mounting an ExtensionActivationPlan.
 */
export interface McpMountHandle {
  readonly registeredTools: ReadonlyMap<string, ToolDefinition>;
  readonly serverHealths: ReadonlyMap<string, McpServerHealth>;
  dispose(): Promise<void>;
}

/**
 * Authoritative caller scope derived from agent/session initiator context.
 */
export interface McpCallerScope {
  readonly sessionId: string;
  readonly spaceId?: string;
  readonly userId?: string;
  readonly agent?: Agent;
}

/**
 * Options for mounting MCP Governance.
 */
export interface McpGovernanceOptions {
  readonly platformClient?: McpPlatformClientService;
  readonly sessionId?: string;
  readonly spaceId?: string;
  readonly spacePath?: string;
  readonly userId?: string;
  readonly maxInlineBytes?: number;
  readonly defaultTimeoutMs?: number;
  readonly maxSchemaDepth?: number;
  readonly maxSchemaSizeBytes?: number;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    mcpGovernance?: import('./service.js').McpGovernanceService;
    platformClient?: any;
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'mcp/plan-applied': {
      readonly planVersion?: string | number;
      readonly serverIds: readonly string[];
      readonly serverNames: readonly string[];
      readonly totalToolsRegistered: number;
    };
    'mcp/tool-invoked': {
      readonly serverId?: string;
      readonly serverName?: string;
      readonly rawName?: string;
      readonly publicName: string;
      readonly callId?: ToolCallId;
    };
  }
}
