/**
 * MCP Types and Platform Proxy Service Contract
 *
 * Defines the core contract for the isolated MCP execution and gateway service:
 * - Session context mapping: { userId, spaceId, sessionId, turnId, requestId }
 * - Normalized tool definitions and execution results
 * - Health check descriptors
 * - PlatformProxyMcpService interface with required methods (no optional checkFn/list/call/cancel)
 *
 * @module @enkeep/platform-core/types/mcp
 */

export interface McpProxyContext {
  readonly userId: string;
  readonly spaceId?: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly requestId?: string;
}

export interface McpToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
  readonly serverId: string;
  readonly originalName: string;
}

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

export interface McpToolCallResult {
  readonly content: readonly McpToolContent[];
  readonly structuredContent?: Record<string, unknown> | readonly unknown[];
  readonly isError?: boolean;
  readonly _meta?: Record<string, unknown>;
}

export interface McpServerHealth {
  readonly serverId: string;
  readonly status: 'healthy' | 'degraded' | 'unhealthy' | 'stopped';
  readonly circuitState: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  readonly consecutiveFailures: number;
  readonly lastError?: string;
  readonly lastProbeTime?: number;
  readonly activeProcesses: number;
}

export interface McpContributionReconciler {
  reconcile(contributions: readonly unknown[]): Promise<void>;
  reconcileForUser?(userId: string): Promise<void>;
}

export interface PlatformProxyMcpService {
  listTools(context: McpProxyContext): Promise<readonly McpToolDefinition[]>;
  callTool(toolName: string, args: Record<string, unknown>, context: McpProxyContext): Promise<McpToolCallResult>;
  cancel(params: { requestId: string; context: McpProxyContext }): Promise<void>;
  checkHealth(context: McpProxyContext): Promise<readonly McpServerHealth[]>;
  dispose?(): Promise<void>;
  close?(): Promise<void>;
  reconcile?(contributions: readonly unknown[]): Promise<void>;
}
