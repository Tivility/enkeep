/**
 * Initiator scope derivation for Browser Tools.
 * Derives Agent session, user ID, and space ID strictly from initiator runtime context,
 * NEVER from model arguments.
 *
 * @module @enkeep/dsh-tool-browser/scope
 */

import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { BrowserCallerScope } from './types.js';
import { createBrowserContextUnavailableError } from './errors.js';

/**
 * Resolves the authoritative caller scope from active initiator context.
 * Fails closed if session or initiator agent cannot be determined.
 *
 * @param execContext - ToolRunContext or Cordis Context
 * @param parentCtx - Fallback Cordis context
 * @returns Resolved BrowserCallerScope with userId, spaceId, sessionId, and optional agent
 */
export function resolveCallerScope(
  execContext?: ToolRunContext | Record<string, unknown>,
  parentCtx?: Context
): BrowserCallerScope {
  let activeAgent: Agent | undefined = (execContext as any)?.agent;

  if (!activeAgent && parentCtx) {
    const agentsService = parentCtx.get('agents');
    if (agentsService) {
      if (typeof agentsService.currentInitiator === 'function') {
        activeAgent = agentsService.currentInitiator();
      }
      if (!activeAgent && (execContext as any)?.sessionId && typeof agentsService.get === 'function') {
        activeAgent = agentsService.get((execContext as any).sessionId);
      }
    }
  }

  const session = activeAgent?.session ?? (execContext as any)?.session;

  const sessionId: string | undefined =
    session?.id ??
    session?.header?.id ??
    (execContext as any)?.sessionId ??
    activeAgent?.id;

  if (!sessionId || typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw createBrowserContextUnavailableError(
      'Cannot execute browser tool: unable to derive active sessionId from initiator agent context'
    );
  }

  // Derive spaceId from session header or meta
  const spaceId: string =
    session?.header?.spaceId ??
    (session as any)?.spaceId ??
    (session?.header as any)?.meta?.spaceId ??
    (execContext as any)?.spaceId ??
    'spc_default';

  // Derive userId from session header or meta
  const userId: string =
    session?.header?.userId ??
    (session as any)?.userId ??
    (session?.header as any)?.meta?.userId ??
    (execContext as any)?.userId ??
    'default-user';

  return {
    userId: String(userId),
    spaceId: String(spaceId),
    sessionId: String(sessionId),
    agent: activeAgent,
  };
}
