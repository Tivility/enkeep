/**
 * Subagent Scope & Inheritance Decorator for Enkeep DSH Runtime (G08a)
 *
 * Connects child subagent scope chains to parent agent scopes at creation and cold resume time.
 * Declares @deepseek-ai/dsh-scope as explicit package dependency and imports scope utilities directly.
 *
 * @module @enkeep/runtime-runner/runtime/child-scope
 */

import type { Context } from '@deepseek-ai/cordis';
import { symbols } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { Agent, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent';
import {
  bindScopeParent,
  scopeOf,
  scopeParentOf,
  scopeChainOf,
} from '@deepseek-ai/dsh-scope';

export { bindScopeParent, scopeOf, scopeParentOf, scopeChainOf };

/** Private symbol to ensure idempotent, single decoration per AgentRegistry instance */
export const kSubagentScopeDecorated = Symbol('enkeep.subagentScopeDecorated');

/**
 * Tests whether candidate context is derived from (equal to, or prototypally inherits from)
 * the base context.
 */
export function isContextDerivedFrom(candidate: Context | undefined, base: Context): boolean {
  if (!candidate || !base) return false;
  if (candidate === base) return true;
  let current: any = candidate;
  while (current && current !== Object.prototype) {
    if (current === base) return true;
    current = Object.getPrototypeOf(current);
  }
  return false;
}

/**
 * Validates trusted subagent origin, resolves parent agent, and performs synchronous
 * scope chain binding before the original setup callback executes.
 */
export function bindSubagentScopeIfEligible(
  childCtx: Context,
  meta: Record<string, unknown> | undefined,
  runtimeCtx: Context,
): void {
  // 1. Verify trusted subagent origin - non-subagents pass through untouched
  if (!meta || meta.origin !== 'subagent') {
    return;
  }

  // 2. Extract parentSession from server/engine-owned metadata
  const parentSessionId = meta.parentSession;
  if (typeof parentSessionId !== 'string' || parentSessionId.length === 0) {
    return;
  }

  // 3. Resolve parent agent strictly from the private runtime registry (no client fabrication)
  const agentsService = runtimeCtx.agents ?? (runtimeCtx.get ? runtimeCtx.get('agents') : undefined);
  if (!agentsService || typeof agentsService.get !== 'function') {
    return;
  }

  const parentAgent = agentsService.get(SessionId(parentSessionId)) as Agent | undefined;
  if (!parentAgent) {
    return;
  }

  // 4. Match space and parent actual scope - prevent cross-space tool escalation
  const childCwd = (meta.cwd as string | undefined) ?? (childCtx.agent as Agent)?.session?.header?.cwd;
  const parentCwd = parentAgent.session?.header?.cwd;
  if (childCwd !== parentCwd) {
    return;
  }

  // 5. Establish scope parent link synchronously before origSetup
  const childScope = scopeOf(childCtx);
  const parentScope = scopeOf(parentAgent.ctx);
  if (childScope && parentScope && childScope !== parentScope && scopeParentOf(childScope) === undefined) {
    bindScopeParent(childScope, parentScope);
  }

  // 6. Inherit per-agent native fs binding with updated G02 semantics without leaking helper tokens
  const parentFs = parentAgent.ctx.get('fs');
  if (parentFs) {
    const disposer = childCtx.on('internal/get', (ctx, prop, error, next) => {
      if (prop !== 'fs') {
        return next();
      }
      // 1. First ctx filter: context must be childCtx or derived from childCtx
      if (ctx !== childCtx && !isContextDerivedFrom(ctx, childCtx)) {
        return next();
      }
      // 2. Isolate identity filter: context must match childCtx's own isolation token for fs
      const childFsToken = childCtx[symbols.isolate]?.[prop];
      const callerFsToken = ctx[symbols.isolate]?.[prop];
      if (childFsToken && callerFsToken && childFsToken !== callerFsToken) {
        return next();
      }
      return parentFs;
    });

    if (typeof childCtx.effect === 'function') {
      childCtx.effect(() => disposer, 'enkeep.childFsInheritance');
    } else if (childCtx.fiber && typeof childCtx.fiber.effect === 'function') {
      childCtx.fiber.effect(() => disposer, 'enkeep.childFsInheritance');
    }
  }
}

/**
 * Installs synchronous setup decoration on ctx.agents.create and ctx.agents.resume.
 * Lifecycle-scoped via fiber effect to ensure clean unwrap on runtime disposal.
 */
export function installSubagentScopeDecorator(ctx: Context): () => void {
  const agents = ctx.agents ?? (ctx.get ? ctx.get('agents') : undefined);
  if (!agents || typeof agents.create !== 'function' || typeof agents.resume !== 'function') {
    return () => {};
  }

  // Idempotency check using private Symbol
  if ((agents as any)[kSubagentScopeDecorated]) {
    return () => {};
  }
  (agents as any)[kSubagentScopeDecorated] = true;

  const originalCreate = agents.create.bind(agents);
  const originalResume = agents.resume.bind(agents);

  // Synchronous setup decoration for create
  agents.create = async (options: CreateAgentOptions) => {
    const origSetup = options.setup;
    const effectiveOptions: CreateAgentOptions = {
      ...options,
      setup: async (childCtx: Context) => {
        // Execute synchronous scope binding BEFORE original setup
        bindSubagentScopeIfEligible(childCtx, options.meta as Record<string, unknown> | undefined, ctx);
        return origSetup?.(childCtx);
      },
    };
    return originalCreate(effectiveOptions);
  };

  // Synchronous setup decoration for resume
  agents.resume = async (options: ResumeAgentOptions) => {
    const origSetup = options.setup;
    const effectiveOptions: ResumeAgentOptions = {
      ...options,
      setup: async (childCtx: Context) => {
        // On resume, read server-owned persisted session header
        const header = (childCtx.agent as Agent)?.session?.header as unknown as Record<string, unknown> | undefined;
        bindSubagentScopeIfEligible(childCtx, header, ctx);
        return origSetup?.(childCtx);
      },
    };
    return originalResume(effectiveOptions);
  };

  // Register fiber-owned restoration disposer
  const disposer = () => {
    agents.create = originalCreate;
    agents.resume = originalResume;
    delete (agents as any)[kSubagentScopeDecorated];
  };

  ctx.effect(() => disposer, 'enkeep.subagentScopeDecorator');
  return disposer;
}
