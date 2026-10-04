/**
 * Subagent Scope & Inheritance Decorator for Enkeep DSH Runtime (G08a / G08b)
 *
 * Connects child subagent scope chains to parent agent scopes at creation and cold resume time.
 * Coordinates authoritative descendant platform route registration and deterministic lifecycle cleanup.
 *
 * @module @enkeep/runtime-runner/runtime/child-scope
 */

import type { Context } from '@deepseek-ai/cordis';
import { symbols } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { Agent, AgentSetupCommit, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent';
import {
  bindScopeParent,
  scopeOf,
  scopeParentOf,
  scopeChainOf,
} from '@deepseek-ai/dsh-scope';

export { bindScopeParent, scopeOf, scopeParentOf, scopeChainOf };

/** Private symbol to ensure idempotent, single decoration per AgentRegistry instance */
export const kSubagentScopeDecorated = Symbol('enkeep.subagentScopeDecorated');

export interface SubagentScopeDecoratorOptions {
  platformClient?: any;
}

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
 * Returns an unbind cleanup function to safely unwind in case of downstream setup abort.
 */
export function bindSubagentScopeIfEligible(
  childCtx: Context,
  meta: Record<string, unknown> | undefined,
  runtimeCtx: Context,
  childAgent?: Agent,
): (() => void) | undefined {
  // 1. Verify trusted subagent origin - non-subagents pass through untouched
  if (!meta || meta.origin !== 'subagent') {
    return undefined;
  }

  // 2. Extract parentSession from server/engine-owned metadata
  const parentSessionId = meta.parentSession;
  if (typeof parentSessionId !== 'string' || parentSessionId.length === 0) {
    return undefined;
  }

  // 3. Resolve parent agent strictly from the private runtime registry (no client fabrication)
  const agentsService = runtimeCtx.agents ?? (runtimeCtx.get ? runtimeCtx.get('agents') : undefined);
  if (!agentsService || typeof agentsService.get !== 'function') {
    return undefined;
  }

  const parentAgent = agentsService.get(SessionId(parentSessionId)) as Agent | undefined;
  if (!parentAgent) {
    return undefined;
  }

  // 4. Match space and parent actual scope - prevent cross-space tool escalation
  const childCwd = (meta.cwd as string | undefined) ?? childAgent?.session?.header?.cwd;
  const parentCwd = parentAgent.session?.header?.cwd;
  if (childCwd !== parentCwd) {
    return undefined;
  }

  // 5. Establish scope parent link synchronously before origSetup
  const childScope = scopeOf(childCtx);
  const parentScope = scopeOf(parentAgent.ctx);
  if (childScope && parentScope && childScope !== parentScope && scopeParentOf(childScope) === undefined) {
    bindScopeParent(childScope, parentScope);
  }

  // 6. Inherit per-agent native fs binding with updated G02 semantics without leaking helper tokens
  const parentFs = parentAgent.ctx.get('fs');
  let fsDisposer: (() => void) | undefined;
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

    fsDisposer = disposer;

    if (typeof childCtx.effect === 'function') {
      childCtx.effect(() => disposer, 'enkeep.childFsInheritance');
    } else if (childCtx.fiber && typeof childCtx.fiber.effect === 'function') {
      childCtx.fiber.effect(() => disposer, 'enkeep.childFsInheritance');
    }
  }

  return () => {
    fsDisposer?.();
  };
}

/**
 * Installs synchronous setup decoration on ctx.agents.create and ctx.agents.resume.
 * Wires authoritative descendant route registration via platformClient network tunnel,
 * awaiting completion before publication/first model request, and handles deterministic disposal.
 */
export function installSubagentScopeDecorator(
  ctx: Context,
  decoratorOptions?: SubagentScopeDecoratorOptions
): () => void {
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

  const getPlatformClient = () => {
    if (decoratorOptions !== undefined) {
      return decoratorOptions.platformClient;
    }
    return (
      (ctx as any).platformClient ??
      (ctx.get ? (ctx.get as any)('platformClient') : undefined)
    );
  };

  // Synchronous setup decoration & awaited route registration for create
  agents.create = async (options: CreateAgentOptions) => {
    const origSetup = options.setup;
    const meta = options.meta as Record<string, unknown> | undefined;

    const effectiveOptions: CreateAgentOptions = {
      ...options,
      setup: async (childCtx: Context, childAgent: Agent) => {
        // 1. Synchronous scope & tool inheritance BEFORE origSetup
        const unbindInheritance = bindSubagentScopeIfEligible(childCtx, meta, ctx, childAgent);

        let origCommit: AgentSetupCommit | void = undefined;
        let registeredChildId: string | undefined = undefined;

        try {
          // 2. Await original setup callback
          if (origSetup) {
            origCommit = await origSetup(childCtx, childAgent);
          }

          // 3. Await asynchronous descendant route registration safely before publication / first model request
          if (meta && meta.origin === 'subagent' && meta.parentSession) {
            const platformClient = getPlatformClient();
            if (platformClient && typeof platformClient.request === 'function') {
              const childSessionId = String(options.sessionId);
              const parentSessionId = String(meta.parentSession);

              const res = await platformClient.request('/api/routes/descendant', {
                method: 'POST',
                body: {
                  childSessionId,
                  parentSessionId,
                  origin: 'subagent',
                },
              });

              if (res.status < 200 || res.status >= 300) {
                const errMsg =
                  typeof res.body === 'object' && res.body?.error?.message
                    ? res.body.error.message
                    : `HTTP ${res.status}`;
                throw new Error(`Failed to register subagent descendant route: ${errMsg}`);
              }

              registeredChildId = childSessionId;

              // Attach unregister to childCtx fiber effect for deterministic lifecycle disposal
              const unregisterChildRoute = () => {
                return platformClient
                  .request(`/api/routes/descendant/${encodeURIComponent(childSessionId)}`, {
                    method: 'DELETE',
                  })
                  .catch(() => {});
              };

              if (typeof childCtx.effect === 'function') {
                childCtx.effect(() => unregisterChildRoute, 'enkeep.descendantRouteCleanup');
              } else if (childCtx.fiber && typeof childCtx.fiber.effect === 'function') {
                childCtx.fiber.effect(() => unregisterChildRoute, 'enkeep.descendantRouteCleanup');
              }
            }
          }
        } catch (err) {
          // If registration or setup fails: abort child, release inherited listeners/map, no leak
          unbindInheritance?.();
          if (registeredChildId) {
            const platformClient = getPlatformClient();
            void platformClient
              ?.request?.(`/api/routes/descendant/${encodeURIComponent(registeredChildId)}`, {
                method: 'DELETE',
              })
              ?.catch?.(() => {});
          }
          throw err;
        }

        // 4. Preserve origSetup commit semantics
        if (origCommit && typeof (origCommit as AgentSetupCommit).commit === 'function') {
          return {
            commit: () => {
              (origCommit as AgentSetupCommit).commit();
            },
          };
        }
      },
    };
    return originalCreate(effectiveOptions);
  };

  // Synchronous setup decoration & awaited route registration for resume
  agents.resume = async (options: ResumeAgentOptions) => {
    const origSetup = options.setup;

    const effectiveOptions: ResumeAgentOptions = {
      ...options,
      setup: async (childCtx: Context, childAgent: Agent) => {
        // Read server-owned persisted session header
        const header = childAgent?.session?.header as unknown as Record<string, unknown> | undefined;

        // 1. Synchronous scope & tool inheritance BEFORE origSetup
        const unbindInheritance = bindSubagentScopeIfEligible(childCtx, header, ctx, childAgent);

        let origCommit: AgentSetupCommit | void = undefined;
        let registeredChildId: string | undefined = undefined;

        try {
          // 2. Await original setup callback
          if (origSetup) {
            origCommit = await origSetup(childCtx, childAgent);
          }

          // 3. Cold resume re-register using trusted header + known parent route
          if (header && header.origin === 'subagent' && header.parentSession) {
            const platformClient = getPlatformClient();
            if (platformClient && typeof platformClient.request === 'function') {
              const childSessionId = String(options.resumeSessionId);
              const parentSessionId = String(header.parentSession);

              const res = await platformClient.request('/api/routes/descendant', {
                method: 'POST',
                body: {
                  childSessionId,
                  parentSessionId,
                  origin: 'subagent',
                },
              });

              if (res.status < 200 || res.status >= 300) {
                const errMsg =
                  typeof res.body === 'object' && res.body?.error?.message
                    ? res.body.error.message
                    : `HTTP ${res.status}`;
                throw new Error(`Failed to re-register subagent descendant route on resume: ${errMsg}`);
              }

              registeredChildId = childSessionId;

              // Attach unregister to childCtx fiber effect for deterministic lifecycle disposal
              const unregisterChildRoute = () => {
                return platformClient
                  .request(`/api/routes/descendant/${encodeURIComponent(childSessionId)}`, {
                    method: 'DELETE',
                  })
                  .catch(() => {});
              };

              if (typeof childCtx.effect === 'function') {
                childCtx.effect(() => unregisterChildRoute, 'enkeep.descendantRouteCleanup');
              } else if (childCtx.fiber && typeof childCtx.fiber.effect === 'function') {
                childCtx.fiber.effect(() => unregisterChildRoute, 'enkeep.descendantRouteCleanup');
              }
            }
          }
        } catch (err) {
          // If re-registration or setup fails: abort child, release inherited listeners/map, no leak
          unbindInheritance?.();
          if (registeredChildId) {
            const platformClient = getPlatformClient();
            void platformClient
              ?.request?.(`/api/routes/descendant/${encodeURIComponent(registeredChildId)}`, {
                method: 'DELETE',
              })
              ?.catch?.(() => {});
          }
          throw err;
        }

        // 4. Preserve origSetup commit semantics
        if (origCommit && typeof (origCommit as AgentSetupCommit).commit === 'function') {
          return {
            commit: () => {
              (origCommit as AgentSetupCommit).commit();
            },
          };
        }
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
