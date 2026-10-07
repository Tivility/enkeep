/**
 * Platform-side DSH Configuration Home Directory Resolver
 *
 * Single shared resolver for all platform-process locations that read DSH
 * deployment or model configuration.
 *
 * Rules:
 * - Priority: customDshHome > ENKEEP_DSH_HOME > DSH_HOME > null
 * - In production mode (isProduction: true, or process.env.NODE_ENV === 'production',
 *   or process.env.ENKEEP_MODE === 'production'):
 *   Fails closed loudly with a clear error if neither is set.
 * - NEVER falls back to os.homedir()/.dsh or ~/.dsh.
 *
 * @module @enkeep/platform-core/safety/dsh-home
 */

import path from 'node:path';

export interface ResolvePlatformDshHomeOptions {
  isProduction?: boolean;
}

/**
 * Resolves the platform-side DSH home directory.
 *
 * @param customDshHome - Optional explicit directory override
 * @param options - Optional resolution options or boolean isProduction flag
 * @returns Absolute normalized path to platform DSH home, or null if unset in non-production mode
 * @throws Error in production mode if neither ENKEEP_DSH_HOME nor DSH_HOME is set
 */
export function resolvePlatformDshHome(
  customDshHome?: string | null,
  options?: ResolvePlatformDshHomeOptions | boolean
): string | null {
  const isProd = typeof options === 'boolean'
    ? options
    : (typeof options?.isProduction === 'boolean'
        ? options.isProduction
        : (process.env.NODE_ENV === 'production' || process.env.ENKEEP_MODE === 'production'));

  const candidate = (customDshHome !== undefined && customDshHome !== null && customDshHome.trim().length > 0)
    ? customDshHome.trim()
    : (process.env.ENKEEP_DSH_HOME !== undefined && process.env.ENKEEP_DSH_HOME.trim().length > 0)
      ? process.env.ENKEEP_DSH_HOME.trim()
      : (process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim().length > 0)
        ? process.env.DSH_HOME.trim()
        : null;

  if (!candidate) {
    if (isProd) {
      throw new Error(
        'FAIL-CLOSED: ENKEEP_DSH_HOME or DSH_HOME environment variable is mandatory in production mode. Silent fallback to ~/.dsh is disabled.'
      );
    }
    return null;
  }

  return path.resolve(candidate);
}
