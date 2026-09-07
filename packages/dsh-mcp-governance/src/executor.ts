/**
 * Tool Execution Bridge for MCP Governance
 *
 * Implements:
 * 1. Dispatches MCP tool calls to `PlatformClient` via canonical `POST /api/mcp/call`.
 * 2. Injects strict scope-derived context: { sessionId, toolName: publicName, args, requestId }.
 * 3. Bridges AbortSignal for immediate cooperative cancellation, forwarding to POST /api/mcp/cancel with { sessionId, requestId }.
 * 4. Normalizes MCP results and bounds output in DSH canonical format.
 * 5. Logs audit event `mcp/tool-invoked` without leaking secrets.
 *
 * @module @enkeep/dsh-mcp-governance/executor
 */

import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import type {
  McpPlatformClientService,
  CallMcpToolRequest,
  CancelMcpToolRequest,
  RawMcpCallToolResult,
  RawMcpTool,
} from './types.js';
import { normalizeMcpResult, sanitizeErrorMessage } from './normalizer.js';
import { enforceToolApproval, type ResolvedToolRisk } from './approval-policy.js';
import { resolveCallerScope } from './scope.js';

export interface CreateExecutorOptions {
  readonly client: McpPlatformClientService;
  readonly rawTool: RawMcpTool;
  readonly publicName: string;
  readonly serverName?: string;
  readonly risk?: ResolvedToolRisk;
  readonly spaceId?: string;
  readonly spacePath?: string;
  readonly userId?: string;
  readonly maxInlineBytes?: number;
  readonly timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Creates the `execute` function for one registered MCP tool.
 */
export function createMcpToolExecutor(
  ctx: Context,
  options: CreateExecutorOptions
): (args: unknown, exec: ToolRunContext) => Promise<unknown> {
  const {
    client,
    rawTool,
    publicName,
    serverName,
    risk,
    maxInlineBytes,
    timeoutMs,
  } = options;

  const effectiveTimeoutMs = timeoutMs ?? 60_000;
  const effectiveServerName = serverName ?? rawTool.serverId ?? rawTool.contributionId;

  return async (args: unknown, exec: ToolRunContext): Promise<unknown> => {
    // Extract arguments safely
    const argsObj = isRecord(args) ? args : {};

    // 1. Enforce approval check before any platform dispatch.
    // Approval summary excludes arg values (only tool name/server and arg keys).
    // If denied, throws immediately and does NOT call platform.
    await enforceToolApproval(ctx, exec, publicName, effectiveServerName, risk, argsObj);

    // 2. Authoritative caller scope derivation from agent/session context
    const scope = resolveCallerScope(exec, ctx);
    const sessionId = scope.sessionId;

    // 3. Log safe audit event on session (NO secrets, NO values)
    const session = scope.agent?.session;
    if (session && typeof session.append === 'function') {
      try {
        session.append('mcp/tool-invoked', {
          serverId: rawTool.serverId ?? rawTool.contributionId,
          serverName: effectiveServerName,
          rawName: rawTool.originalName ?? rawTool.name,
          publicName,
          callId: exec.callId,
        });
      } catch {
        // Logging is best-effort
      }
    }

    // 4. Construct canonical dispatch request body: { sessionId, toolName, args, requestId }
    const requestId = randomUUID();
    const requestBody: CallMcpToolRequest = {
      sessionId,
      toolName: publicName,
      args: argsObj,
      requestId,
    };

    // 5. Forward cancellation signal to POST /api/mcp/cancel with { sessionId, requestId }
    const abortHandler = () => {
      const cancelBody: CancelMcpToolRequest = {
        sessionId,
        requestId,
      };
      client
        .request('/api/mcp/cancel', {
          method: 'POST',
          body: cancelBody,
          timeoutMs: 5_000,
        })
        .catch(() => {});
    };

    if (exec.signal.aborted) {
      abortHandler();
      const err = new Error(`MCP tool "${publicName}" execution was aborted`);
      err.name = 'AbortError';
      throw err;
    }

    exec.signal.addEventListener('abort', abortHandler, { once: true });

    // 6. Execute call via PlatformClient
    let response: { status: number; body?: RawMcpCallToolResult; data?: RawMcpCallToolResult };
    try {
      response = await client.request<RawMcpCallToolResult>('/api/mcp/call', {
        method: 'POST',
        body: requestBody,
        timeoutMs: effectiveTimeoutMs,
        signal: exec.signal,
        requestId,
      });
    } catch (err: unknown) {
      if (exec.signal.aborted) {
        const abortErr = new Error(`MCP tool "${publicName}" execution was aborted`);
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      const rawMsg = err instanceof Error ? err.message : String(err);
      throw new Error(`MCP tool "${publicName}" call failed: ${sanitizeErrorMessage(rawMsg)}`);
    } finally {
      exec.signal.removeEventListener('abort', abortHandler);
    }

    let resPayload: any = response.data ?? response.body;
    if (isRecord(resPayload) && isRecord(resPayload.data) && (Array.isArray(resPayload.data.content) || resPayload.data.isError !== undefined || resPayload.data.toolResult !== undefined)) {
      resPayload = resPayload.data;
    }
    if (!response || response.status >= 400 || !resPayload) {
      const errMsg = `Platform returned status ${response?.status || 500} for tool "${publicName}"`;
      throw new Error(sanitizeErrorMessage(errMsg));
    }

    // 7. Normalize MCP result
    const normalized = await normalizeMcpResult(
      resPayload,
      publicName,
      maxInlineBytes,
      ctx,
      sessionId
    );

    if (normalized.isError) {
      const errText = normalized.content
        .map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
        .join('\n');
      throw new Error(errText || `MCP tool "${publicName}" returned an error`);
    }

    return normalized.value;
  };
}
