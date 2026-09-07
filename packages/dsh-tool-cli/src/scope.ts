/**
 * Initiator scope derivation for CLI Tools.
 * Derives Agent session, user ID, and space ID strictly from initiator runtime context.
 *
 * @module @enkeep/dsh-tool-cli/scope
 */

import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';

export interface CliCallerScope {
  readonly userId?: string;
  readonly spaceId?: string;
  readonly sessionId?: string;
  readonly agent?: Agent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function resolveCallerScope(
  execContext?: ToolRunContext | Context | Record<string, unknown>,
  parentCtx?: Context
): CliCallerScope {
  let activeAgent: Agent | undefined =
    isRecord(execContext) && 'agent' in execContext
      ? (execContext.agent as Agent | undefined)
      : undefined;

  const resolveFromAgentsService = (ctx?: Context): Agent | undefined => {
    if (!ctx) return undefined;
    const agentsService = ctx.get('agents');
    if (agentsService && typeof agentsService.currentInitiator === 'function') {
      const initiator = agentsService.currentInitiator();
      if (initiator) return initiator;
    }
    return undefined;
  };

  if (!activeAgent && parentCtx) {
    activeAgent = resolveFromAgentsService(parentCtx);
  }

  if (!activeAgent && execContext && typeof (execContext as Context).get === 'function') {
    activeAgent = resolveFromAgentsService(execContext as Context);
  }

  const session = (activeAgent?.session ?? (isRecord(execContext) ? execContext.session : undefined)) as any;
  const sessionId =
    (isRecord(execContext) && typeof execContext.sessionId === 'string' ? execContext.sessionId : undefined) ??
    session?.id ??
    session?.header?.id;

  const spaceId =
    (isRecord(execContext) && typeof execContext.spaceId === 'string' ? execContext.spaceId : undefined) ??
    session?.spaceId ??
    session?.header?.spaceId ??
    session?.header?.meta?.spaceId;

  const userId =
    (isRecord(execContext) && typeof execContext.userId === 'string' ? execContext.userId : undefined) ??
    session?.userId ??
    session?.header?.userId ??
    session?.header?.meta?.userId;

  return {
    userId,
    spaceId,
    sessionId,
    agent: activeAgent,
  };
}
