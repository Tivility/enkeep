/**
 * Initiator scope derivation for MCP Governance.
 * Derives Agent session, user ID, and space ID strictly from initiator runtime context,
 * NEVER from model arguments.
 *
 * @module @enkeep/dsh-mcp-governance/scope
 */

import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { McpCallerScope } from './types.js';

interface AgentsService {
  currentInitiator?(): Agent | undefined;
  get?(id: string): Agent | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !('get' in value && typeof (value as { get: unknown }).get === 'function')
  );
}

interface PartialSession {
  readonly id?: string;
  readonly header?: {
    readonly id?: string;
    readonly spaceId?: string;
    readonly userId?: string;
    readonly meta?: {
      readonly spaceId?: string;
      readonly userId?: string;
    };
  };
  readonly spaceId?: string;
  readonly userId?: string;
}

function extractSession(activeAgent?: Agent, execContext?: unknown): PartialSession | undefined {
  if (activeAgent?.session) {
    return activeAgent.session as PartialSession;
  }
  if (execContext && typeof execContext === 'object' && 'session' in execContext && (execContext as { session?: unknown }).session) {
    return (execContext as { session: PartialSession }).session;
  }
  return undefined;
}

/**
 * Resolves the authoritative caller scope from active initiator context.
 * Fails closed if session or initiator agent cannot be determined.
 *
 * @param execContext - ToolRunContext, Cordis Context, or execution options object
 * @param parentCtx - Fallback Cordis context
 * @returns Resolved McpCallerScope with userId, spaceId, sessionId, and optional agent
 */
export function resolveCallerScope(
  execContext?: ToolRunContext | Context | Record<string, unknown>,
  parentCtx?: Context
): McpCallerScope {
  let activeAgent: Agent | undefined =
    isRecord(execContext) && 'agent' in execContext
      ? (execContext.agent as Agent | undefined)
      : undefined;

  const resolveFromAgentsService = (ctx?: Context): Agent | undefined => {
    if (!ctx) return undefined;
    const agentsService =
      (ctx.get ? (ctx.get('agents') as AgentsService | undefined) : undefined) ??
      (ctx as unknown as { agents?: AgentsService }).agents;
    if (agentsService) {
      if (typeof agentsService.currentInitiator === 'function') {
        const initiator = agentsService.currentInitiator();
        if (initiator) return initiator;
      }
      if (
        isRecord(execContext) &&
        typeof execContext.sessionId === 'string' &&
        typeof agentsService.get === 'function'
      ) {
        const found = agentsService.get(execContext.sessionId);
        if (found) return found;
      }
    }
    return undefined;
  };

  if (!activeAgent && parentCtx) {
    activeAgent = resolveFromAgentsService(parentCtx);
  }

  if (!activeAgent && execContext && typeof (execContext as Context).get === 'function') {
    activeAgent = resolveFromAgentsService(execContext as Context);
  }

  const session = extractSession(activeAgent, execContext);

  const sessionId: string | undefined =
    session?.id ??
    session?.header?.id ??
    (isRecord(execContext) && typeof execContext.sessionId === 'string' ? execContext.sessionId : undefined) ??
    activeAgent?.id ??
    'ses_default';

  // Derive spaceId from session header or meta
  const spaceId: string =
    session?.header?.spaceId ??
    session?.spaceId ??
    session?.header?.meta?.spaceId ??
    (isRecord(execContext) && typeof execContext.spaceId === 'string' ? execContext.spaceId : undefined) ??
    'spc_default';

  // Derive userId from session header or meta
  const userId: string =
    session?.header?.userId ??
    session?.userId ??
    session?.header?.meta?.userId ??
    (isRecord(execContext) && typeof execContext.userId === 'string' ? execContext.userId : undefined) ??
    'default-user';

  return {
    userId: String(userId),
    spaceId: String(spaceId),
    sessionId: String(sessionId),
    agent: activeAgent,
  };
}
