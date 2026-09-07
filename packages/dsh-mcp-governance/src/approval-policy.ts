/**
 * Approval Risk Evaluation & Governance Integration for MCP Tools
 *
 * Implements:
 * 1. Default Stance:
 *    - All MCP tool executions require human approval.
 *    - Do not trust manifest self-reported risk or read-only annotations to bypass approval.
 *    - Tool listing requires NO approval.
 * 2. Summary & Privacy:
 *    - Approval summary excludes argument values to prevent data leakage and prompt injection.
 *    - Summary presents tool name, server name if known, and parameter keys only.
 * 3. DSH UserApproval Integration:
 *    - Calls `approvalService.request({ agent, toolName, reason, signal })`.
 *    - Fails closed on rejection, cancellation, or unavailability — no platform call is made.
 *
 * @module @enkeep/dsh-mcp-governance/approval-policy
 */

import type { Context } from '@deepseek-ai/cordis';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { RawMcpTool, ApprovalService } from './types.js';

export interface ResolvedToolRisk {
  readonly riskLevel: 'mutation' | 'read-only';
  readonly requiresApproval: boolean;
  readonly isConcurrencySafe: boolean;
  readonly reason: string;
}

export interface ToolPolicyOverride {
  readonly name?: string;
  readonly requiresApproval?: boolean;
  readonly isConcurrencySafe?: boolean;
  readonly riskLevel?: 'mutation' | 'read-only';
}

/**
 * Resolves the effective risk level and approval requirement for an MCP tool.
 * All MCP tool executions require approval by default.
 *
 * @param tool - Raw tool metadata from MCP server
 * @param options - Optional server identification or explicit policy overrides
 * @param toolPolicy - Optional tool-specific policy override
 * @returns Resolved risk evaluation
 */
export function resolveToolRisk(
  tool: RawMcpTool,
  options?: { serverName?: string; requiresApproval?: boolean; isConcurrencySafe?: boolean; riskLevel?: 'mutation' | 'read-only' } | null,
  toolPolicy?: ToolPolicyOverride | null
): ResolvedToolRisk {
  const serverName = options?.serverName ?? tool.serverId ?? tool.contributionId;
  const policy = toolPolicy ?? options;

  if (policy?.requiresApproval !== undefined) {
    return {
      riskLevel: policy.riskLevel ?? (policy.requiresApproval ? 'mutation' : 'read-only'),
      requiresApproval: policy.requiresApproval,
      isConcurrencySafe: policy.isConcurrencySafe ?? false,
      reason: serverName ? `MCP tool "${tool.name}" on server "${serverName}"` : `MCP tool "${tool.name}"`,
    };
  }

  return {
    riskLevel: 'mutation',
    requiresApproval: true,
    isConcurrencySafe: false,
    reason: serverName
      ? `Execute MCP tool "${tool.name}" on server "${serverName}"`
      : `Execute MCP tool "${tool.name}"`,
  };
}

/**
 * Formats a safe approval prompt reason that excludes argument values,
 * revealing only the tool identity, server name if known, and argument keys.
 *
 * @param publicName - Model-facing public tool name
 * @param serverName - MCP server or contribution name
 * @param args - Tool invocation arguments (used ONLY for key extraction)
 * @returns Sanitized approval prompt string
 */
export function formatSafeApprovalReason(
  publicName: string,
  serverName?: string | null,
  args?: Record<string, unknown> | null
): string {
  const keys = args && typeof args === 'object' && !Array.isArray(args) ? Object.keys(args) : [];
  const serverPart = serverName ? ` on server "${serverName}"` : '';

  if (keys.length > 0) {
    return `Execute MCP tool "${publicName}"${serverPart} (parameters: [${keys.join(', ')}])`;
  }
  return `Execute MCP tool "${publicName}"${serverPart}`;
}

/**
 * Enforces approval gate before executing an MCP tool.
 * Fails closed if approval service is missing or if user rejects/cancels.
 *
 * @param ctx - Plugin context
 * @param exec - Tool execution context
 * @param publicName - Model-facing public tool name
 * @param serverName - MCP server or contribution name
 * @param risk - Evaluated risk details
 * @param args - Tool invocation arguments (used ONLY for key extraction)
 */
export async function enforceToolApproval(
  ctx: Context,
  exec: ToolRunContext,
  publicName: string,
  serverName?: string | null,
  risk?: ResolvedToolRisk,
  args?: Record<string, unknown> | null
): Promise<void> {
  if (risk && !risk.requiresApproval) {
    return;
  }

  const approvalService =
    (ctx.get ? (ctx.get('approval') as ApprovalService | undefined) : undefined) ??
    (ctx as unknown as { approval?: ApprovalService }).approval ??
    (exec.agent as unknown as { ctx?: { approval?: ApprovalService } })?.ctx?.approval;

  if (!approvalService || typeof approvalService.request !== 'function') {
    throw new Error(
      `Execution of MCP tool "${publicName}" requires human approval, but no ApprovalService is mounted (fail-closed)`
    );
  }

  const agent = exec.agent;
  if (!agent) {
    throw new Error(
      `Execution of MCP tool "${publicName}" requires human approval, but no active Agent context was found`
    );
  }

  const safeReason = formatSafeApprovalReason(publicName, serverName, args);

  const outcome = await approvalService.request({
    agent,
    toolName: publicName,
    callId: exec.callId,
    reason: safeReason,
    signal: exec.signal,
  });

  if (outcome === 'rejected') {
    throw new Error(`Execution of MCP tool "${publicName}" was rejected by user approval policy`);
  } else if (outcome === 'cancelled') {
    throw new Error(`Execution of MCP tool "${publicName}" was cancelled`);
  } else if (outcome === 'unavailable') {
    throw new Error(`Approval for MCP tool "${publicName}" was unavailable (timed out or no answerer available)`);
  } else if (outcome !== 'allowed-once') {
    throw new Error(`Approval for MCP tool "${publicName}" failed with outcome: ${String(outcome)}`);
  }
}
