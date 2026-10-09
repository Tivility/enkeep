/**
 * Layered Working Context Window Types & Resolution Engine
 *
 * Implements Enkeep's working context window hierarchy:
 * - TOP-LEVEL sessions: session override -> space override -> platform default (env ENKEEP_CONTEXT_WINDOW_DEFAULT, default 272000)
 * - Child agents (subagent / fork / workflow): platform default (env ENKEEP_CONTEXT_WINDOW_DEFAULT, default 272000), unaffected by space/session overrides
 *
 * @module @enkeep/platform-core/types/context-window
 */

export type ContextWindowSource = 'session' | 'space' | 'platform' | 'child_default';

export const DEFAULT_ENKEEP_CONTEXT_WINDOW = 272000;

export interface EffectiveContextWindow {
  readonly contextWindow: number;
  readonly source: ContextWindowSource;
  readonly override?: number | null;
}

export function isValidContextWindow(val: unknown): val is number {
  return typeof val === 'number' && Number.isSafeInteger(val) && val > 0;
}

export function isValidContextWindowInput(val: unknown): val is number | 'default' {
  if (val === 'default') return true;
  return typeof val === 'number' && Number.isSafeInteger(val) && val > 0;
}

/**
 * Resolves the platform default working context window from ENKEEP_CONTEXT_WINDOW_DEFAULT.
 * Defaults to 272000 if unset or invalid.
 */
export function getPlatformDefaultContextWindow(): number {
  const env = process.env.ENKEEP_CONTEXT_WINDOW_DEFAULT;
  if (env) {
    const parsed = Number(env);
    if (isValidContextWindow(parsed)) {
      return parsed;
    }
  }
  return DEFAULT_ENKEEP_CONTEXT_WINDOW;
}

/**
 * Resolves effective working context window for TOP-LEVEL sessions:
 * session override -> space override -> platform default (ENKEEP_CONTEXT_WINDOW_DEFAULT, default 272000).
 */
export function resolveTopLevelContextWindow(options: {
  sessionContextWindow?: number | null;
  spaceContextWindow?: number | null;
} = {}): { contextWindow: number; source: 'session' | 'space' | 'platform'; override: number | null } {
  if (options.sessionContextWindow !== undefined && options.sessionContextWindow !== null && isValidContextWindow(options.sessionContextWindow)) {
    return {
      contextWindow: options.sessionContextWindow,
      source: 'session',
      override: options.sessionContextWindow,
    };
  }

  if (options.spaceContextWindow !== undefined && options.spaceContextWindow !== null && isValidContextWindow(options.spaceContextWindow)) {
    return {
      contextWindow: options.spaceContextWindow,
      source: 'space',
      override: null,
    };
  }

  return {
    contextWindow: getPlatformDefaultContextWindow(),
    source: 'platform',
    override: null,
  };
}

/**
 * Resolves working context window for child agents (subagent, fork, workflow):
 * ALWAYS returns the platform default (ENKEEP_CONTEXT_WINDOW_DEFAULT, default 272000),
 * completely unaffected by parent space or session overrides.
 */
export function resolveChildContextWindow(): { contextWindow: number; source: 'child_default' } {
  return {
    contextWindow: getPlatformDefaultContextWindow(),
    source: 'child_default',
  };
}
