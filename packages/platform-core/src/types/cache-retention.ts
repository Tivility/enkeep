/**
 * Layered Prompt Cache Retention Types & Resolution Engine
 *
 * Implements Enkeep's prompt cache retention hierarchy:
 * - TOP-LEVEL sessions: session override -> space override -> platform top-level default (env ENKEEP_CACHE_RETENTION_TOP, default 'long')
 * - Child agents (subagent / fork / workflow): platform child default (env ENKEEP_CACHE_RETENTION_CHILD, default 'short'), unaffected by space/session overrides
 *
 * Values:
 * - 'short': 5-minute ephemeral cache (default Anthropic/Kimi TTL)
 * - 'long': Long retention (Anthropic/Kimi 1h TTL, OpenAI 24h where supported)
 * - 'none': Disabled (no cache_control headers / prompt cache retention)
 * - 'default': Clears an explicit override (restoring inheritance)
 *
 * @module @enkeep/platform-core/types/cache-retention
 */

export type CacheRetention = 'short' | 'long' | 'none';

export type CacheRetentionInput = 'short' | 'long' | 'none' | 'default';

export type CacheRetentionSource = 'session' | 'space' | 'platform' | 'child_default';

export interface EffectiveCacheRetention {
  readonly retention: CacheRetention;
  readonly source: CacheRetentionSource;
  readonly override?: CacheRetention | null;
}

export function isValidCacheRetention(val: unknown): val is CacheRetention {
  return val === 'short' || val === 'long' || val === 'none';
}

export function isValidCacheRetentionInput(val: unknown): val is CacheRetentionInput {
  return val === 'short' || val === 'long' || val === 'none' || val === 'default';
}

/**
 * Resolves the platform top-level session default cache retention from ENKEEP_CACHE_RETENTION_TOP.
 * Defaults to 'long' if unset or invalid.
 */
export function getPlatformTopLevelCacheRetention(): CacheRetention {
  const env = process.env.ENKEEP_CACHE_RETENTION_TOP;
  if (env && isValidCacheRetention(env)) {
    return env;
  }
  return 'long';
}

/**
 * Resolves the platform child agent default cache retention from ENKEEP_CACHE_RETENTION_CHILD.
 * Defaults to 'short' if unset or invalid.
 */
export function getPlatformChildCacheRetention(): CacheRetention {
  const env = process.env.ENKEEP_CACHE_RETENTION_CHILD;
  if (env && isValidCacheRetention(env)) {
    return env;
  }
  return 'short';
}

/**
 * Resolves effective prompt cache retention for TOP-LEVEL sessions:
 * session override -> space override -> platform top-level default (ENKEEP_CACHE_RETENTION_TOP, default 'long').
 */
export function resolveTopLevelCacheRetention(options: {
  sessionRetention?: string | null;
  spaceRetention?: string | null;
} = {}): { retention: CacheRetention; source: 'session' | 'space' | 'platform'; override: CacheRetention | null } {
  if (options.sessionRetention && isValidCacheRetention(options.sessionRetention)) {
    return {
      retention: options.sessionRetention,
      source: 'session',
      override: options.sessionRetention,
    };
  }

  if (options.spaceRetention && isValidCacheRetention(options.spaceRetention)) {
    return {
      retention: options.spaceRetention,
      source: 'space',
      override: null,
    };
  }

  return {
    retention: getPlatformTopLevelCacheRetention(),
    source: 'platform',
    override: null,
  };
}

/**
 * Resolves prompt cache retention for child agents (subagent, fork, workflow):
 * ALWAYS returns the platform child default (ENKEEP_CACHE_RETENTION_CHILD, default 'short'),
 * completely unaffected by parent space or session overrides.
 */
export function resolveChildCacheRetention(): { retention: CacheRetention; source: 'child_default' } {
  return {
    retention: getPlatformChildCacheRetention(),
    source: 'child_default',
  };
}
