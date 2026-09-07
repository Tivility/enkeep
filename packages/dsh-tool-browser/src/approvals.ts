/**
 * DSH User Approval & Permission Integration for Browser Tools.
 *
 * Implements:
 * 1. Risk categorization:
 *    - Read-only: `browser_snapshot`, `browser_screenshot`, `browser_close` (clean release).
 *    - Navigation: `browser_open` (low risk GET, configurable approval).
 *    - Mutation / Interaction: `browser_interact` (click, fill, press, select - potential side effects, asks approval depending on preset).
 * 2. Exact DSH Approvals Registry integration via `ctx.approval.request(...)`.
 * 3. Fail-closed semantics on rejection, cancellation, or unavailable answerers.
 *
 * @module @enkeep/dsh-tool-browser/approvals
 */

import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import { BrowserToolError, BrowserToolErrorCode } from './errors.js';

export interface BrowserApprovalRequestOptions {
  readonly ctx?: Context;
  readonly execContext?: ToolRunContext | Record<string, unknown>;
  readonly toolName: string;
  readonly actionDescription: string;
  readonly agent?: Agent;
  readonly forceApproval?: boolean;
}

/**
 * Checks whether approval is required and requests approval from DSH ApprovalService.
 * Fails closed if approval is rejected, cancelled, or unavailable.
 */
export async function enforceBrowserApproval(
  options: BrowserApprovalRequestOptions
): Promise<void> {
  const { ctx, execContext, toolName, actionDescription, agent } = options;

  if (!ctx) {
    return;
  }

  const approvalService = ctx.get('approval') ?? (ctx as unknown as { approval?: { request: Function } }).approval;
  if (!approvalService || typeof approvalService.request !== 'function') {
    // If no approval service mounted and this is a mutation requiring approval, fail-closed
    if (options.forceApproval) {
      throw new BrowserToolError(
        `Execution of "${toolName}" requires human approval, but no ApprovalService is mounted (fail-closed)`,
        BrowserToolErrorCode.APPROVAL_UNAVAILABLE,
        503
      );
    }
    return;
  }

  const activeAgent = agent ?? (execContext as any)?.agent;
  if (!activeAgent) {
    // Cannot request approval without active Agent identity
    if (options.forceApproval) {
      throw new BrowserToolError(
        `Execution of "${toolName}" requires human approval, but no active Agent context was found`,
        BrowserToolErrorCode.APPROVAL_UNAVAILABLE,
        503
      );
    }
    return;
  }

  const callId = (execContext as any)?.callId;
  const signal = (execContext as any)?.signal;

  const outcome = await approvalService.request({
    agent: activeAgent,
    toolName,
    callId,
    reason: `Browser action: ${actionDescription}`,
    signal,
  });

  if (outcome === 'allowed-once') {
    return;
  } else if (outcome === 'rejected') {
    throw new BrowserToolError(
      `Execution of browser action "${toolName}" (${actionDescription}) was rejected by user approval policy`,
      BrowserToolErrorCode.APPROVAL_REJECTED,
      403
    );
  } else if (outcome === 'cancelled') {
    throw new BrowserToolError(
      `Execution of browser action "${toolName}" was cancelled`,
      BrowserToolErrorCode.APPROVAL_CANCELLED,
      499
    );
  } else if (outcome === 'unavailable') {
    throw new BrowserToolError(
      `Approval for browser action "${toolName}" was unavailable (timed out or no answerer available)`,
      BrowserToolErrorCode.APPROVAL_UNAVAILABLE,
      503
    );
  } else {
    throw new BrowserToolError(
      `Approval for browser action "${toolName}" failed with outcome: ${String(outcome)}`,
      BrowserToolErrorCode.APPROVAL_REJECTED,
      403
    );
  }
}
