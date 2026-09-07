/**
 * User Approval enforcement for CLI Tools.
 *
 * All CLI tool calls require human approval by default.
 *
 * @module @enkeep/dsh-tool-cli/approvals
 */

import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import { CliToolError } from './errors.js';

export interface CliApprovalOptions {
  ctx?: Context;
  execContext?: ToolRunContext | Record<string, unknown>;
  toolName: string;
  contribName: string;
  args: string[];
  agent?: Agent;
}

export async function enforceCliApproval(options: CliApprovalOptions): Promise<void> {
  const { ctx, execContext, toolName, contribName, args, agent } = options;

  if (!ctx) {
    throw new CliToolError(
      `Execution of "${toolName}" requires human approval, but Cordis context is missing`,
      'APPROVAL_UNAVAILABLE',
      503
    );
  }

  const approvalService = ctx.get('approval') ?? (ctx as unknown as { approval?: { request: Function } }).approval;

  if (!approvalService || typeof approvalService.request !== 'function') {
    throw new CliToolError(
      `Execution of "${toolName}" requires human approval, but no ApprovalService is mounted (fail-closed)`,
      'APPROVAL_UNAVAILABLE',
      503
    );
  }

  const activeAgent = agent ?? (execContext as any)?.agent;
  if (!activeAgent) {
    throw new CliToolError(
      `Execution of "${toolName}" requires human approval, but no active Agent context was found`,
      'APPROVAL_UNAVAILABLE',
      503
    );
  }

  const callId = (execContext as any)?.callId;
  const signal = (execContext as any)?.signal;

  const outcome = await approvalService.request({
    agent: activeAgent,
    toolName,
    callId,
    reason: `Execute CLI tool "${toolName}" (${contribName}) with ${args.length} argument(s)`,
    signal,
  });

  if (outcome === 'allowed-once') {
    return;
  } else if (outcome === 'rejected') {
    throw new CliToolError(
      `Execution of CLI tool "${toolName}" was rejected by user approval policy`,
      'APPROVAL_REJECTED',
      403
    );
  } else if (outcome === 'cancelled') {
    throw new CliToolError(
      `Execution of CLI tool "${toolName}" was cancelled`,
      'APPROVAL_CANCELLED',
      499
    );
  } else {
    throw new CliToolError(
      `Approval for CLI tool "${toolName}" was unavailable (status: ${String(outcome)})`,
      'APPROVAL_UNAVAILABLE',
      503
    );
  }
}
