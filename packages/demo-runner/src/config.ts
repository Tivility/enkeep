/**
 * Demo Runner Safety Configuration and Path Resolvers
 *
 * Enforces strict containment in <repoRoot>/.demo-data (or isolated temporary dataRoot in test mode),
 * zero access to production directories, loopback-only binding, and isolated per-user workspaces.
 *
 * @module @enkeep/demo-runner/config
 */

import { resolve, join, normalize, relative, isAbsolute, dirname } from 'node:path';
import { existsSync, readFileSync, lstatSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import type { DemoPathConfig, DemoPathOptions, DemoUserConfig } from './types.js';

export const DEMO_OWNERSHIP_TAG = 'enkeep-demo' as const;
export const DEMO_CONTAINER_PREFIX = 'enkeep-demo-' as const;
export const DEMO_VOLUME_PREFIX = 'enkeep-demo-dsh-' as const;
export const DEMO_LABEL_KEY = 'app' as const;
export const DEMO_LABEL_VALUE = 'enkeep-demo' as const;
export const USER_LABEL_KEY = 'enkeep.user' as const;
export const RUN_ID_LABEL_KEY = 'enkeep.run-id' as const;
export const VOLUME_ID_LABEL_KEY = 'enkeep.volume-id' as const;

export const RESERVED_PROTECTED_PORTS: readonly number[] = Object.freeze([3000, 3080]);
export const ALLOWED_HOSTS: readonly string[] = Object.freeze(['127.0.0.1']);
export const FORBIDDEN_HOSTS: readonly string[] = Object.freeze([
  '0.0.0.0',
  '::',
  '::0',
  '0:0:0:0:0:0:0:0',
  '::ffff:0.0.0.0',
  '*',
]);

export const DEMO_DATA_DIR_NAME = '.demo-data';
export const DEMO_TEST_DATA_DIR_NAME = '.demo-test-data';

export const RESOURCE_SUFFIX_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Validates resource suffix strictly against allowed characters.
 */
export function validateResourceSuffix(suffix?: string): void {
  if (!suffix) return;
  if (!RESOURCE_SUFFIX_REGEX.test(suffix)) {
    throw new Error(
      `Safety Violation: Invalid resourceSuffix "${suffix}". Must match regex ${RESOURCE_SUFFIX_REGEX.source}`
    );
  }
}

/**
 * Generates safe default users with optional resource suffix for containers and volumes.
 */
export function getDefaultUsers(resourceSuffix?: string): readonly DemoUserConfig[] {
  validateResourceSuffix(resourceSuffix);
  const suffix = resourceSuffix ? `-${resourceSuffix}` : '';
  return Object.freeze([
    {
      userId: 'alice',
      username: 'alice',
      role: 'admin',
      displayName: 'Alice (Admin)',
      containerName: `enkeep-demo-alice${suffix}`,
      volumeName: `enkeep-demo-dsh-alice${suffix}`,
      defaultSpaceFolder: 'alice-container',
    },
    {
      userId: 'bob',
      username: 'bob',
      role: 'user',
      displayName: 'Bob (User)',
      containerName: `enkeep-demo-bob${suffix}`,
      volumeName: `enkeep-demo-dsh-bob${suffix}`,
      defaultSpaceFolder: 'bob-space',
    },
  ]);
}

export const DEFAULT_USERS: readonly DemoUserConfig[] = getDefaultUsers();

/**
 * Finds the Enkeep repository root safely by traversing upward looking for enkeep-root package.json.
 */
export function findRepoRoot(startDir: string = process.cwd()): string {
  let current = resolve(startDir);

  while (true) {
    const pkgPath = join(current, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        if (pkg && typeof pkg === 'object' && pkg.name === 'enkeep-root') {
          return current;
        }
      } catch (_err: unknown) {
        // continue searching upward
      }
    }

    const parent = resolve(current, '..');
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return resolve(startDir);
}

/**
 * Resolves options or string path into normalized DemoPathOptions.
 */
function normalizePathOptions(opts?: DemoPathOptions | string): DemoPathOptions {
  if (!opts) return {};
  if (typeof opts === 'string') return { repoRoot: opts };
  return opts;
}

/**
 * Resolves and validates all demo paths inside repository or isolated test data root.
 */
export function getDemoPathConfig(options?: DemoPathOptions | string): DemoPathConfig {
  const opts = normalizePathOptions(options);
  const root = opts.repoRoot ? resolve(opts.repoRoot) : findRepoRoot();
  const mode = opts.mode ?? 'production';

  let demoDataDir: string;

  if (opts.dataRoot) {
    const rawDataRoot = resolve(opts.dataRoot);
    if (mode === 'production') {
      const canonicalProdData = resolve(root, DEMO_DATA_DIR_NAME);
      if (rawDataRoot !== canonicalProdData && !rawDataRoot.startsWith(canonicalProdData + '/')) {
        throw new Error(
          `Safety Violation: In production mode, dataRoot must resolve inside "${canonicalProdData}". Received "${rawDataRoot}".`
        );
      }
      demoDataDir = rawDataRoot;
    } else {
      // mode === 'test'
      if (!isAbsolute(opts.dataRoot)) {
        throw new Error(
          `Safety Violation: In test mode, explicit dataRoot must be an absolute path. Received "${opts.dataRoot}".`
        );
      }
      const osTmp = normalize(resolve(tmpdir()));
      const repoTestData = normalize(resolve(root, DEMO_TEST_DATA_DIR_NAME));
      const normalizedDataRoot = normalize(rawDataRoot);

      const inOsTmp = normalizedDataRoot === osTmp || normalizedDataRoot.startsWith(osTmp + '/');
      const inRepoTest = normalizedDataRoot === repoTestData || normalizedDataRoot.startsWith(repoTestData + '/');

      if (!inOsTmp && !inRepoTest) {
        throw new Error(
          `Safety Violation: In test mode, dataRoot must be located inside OS tmp (${osTmp}) or repo test directory (${repoTestData}). Received "${normalizedDataRoot}".`
        );
      }
      demoDataDir = normalizedDataRoot;
    }
  } else {
    demoDataDir = join(root, DEMO_DATA_DIR_NAME);
  }

  return {
    repoRoot: root,
    dataRoot: demoDataDir,
    demoDataDir,
    pidsDir: join(demoDataDir, 'pids'),
    containersDir: join(demoDataDir, 'containers'),
    volumesDir: join(demoDataDir, 'volumes'),
    dbPath: join(demoDataDir, 'platform.db'),
    spacesDir: join(demoDataDir, 'spaces'),
    sessionsDir: join(demoDataDir, 'sessions'),
    importDir: join(demoDataDir, 'import'),
    fixturesDbPath: join(root, 'packages/import-happyclaw/fixtures/source/db/messages.db'),
    fixturesGroupsDir: join(root, 'packages/import-happyclaw/fixtures/source/groups'),
  };
}

/**
 * Validates that a path is strictly inside the resolved dataRoot directory.
 * Throws an Error if it resolves outside, points to sensitive production areas,
 * or traverses through unauthorized symlinks (containment & TOCTOU protection).
 */
export function assertPathInDemoData(targetPath: string, options?: DemoPathOptions | string): string {
  const paths = getDemoPathConfig(options);
  if (!isAbsolute(targetPath)) {
    throw new Error(
      `Safety Boundary Violation: Target path must be an absolute canonical path. Received relative path "${targetPath}".`
    );
  }
  const normalized = normalize(targetPath);
  const canonicalDataDir = normalize(resolve(paths.dataRoot));

  // 1. Basic relative path containment check
  const rel = relative(canonicalDataDir, normalized);
  const isInside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  if (!isInside) {
    throw new Error(
      `Safety Boundary Violation: Path "${normalized}" is outside canonical demo data directory "${canonicalDataDir}".`
    );
  }

  // 2. Forbidden production / system directories check
  const userHome = homedir();
  const forbiddenPrefixes = [
    join(userHome, 'happyclaw'),
    join(userHome, '.dsh'),
    join(userHome, '.ssh'),
    join(userHome, '.aws'),
    '/etc',
    '/usr',
    '/root',
    '/bin',
    '/sbin',
  ];

  for (const prefix of forbiddenPrefixes) {
    if (normalized === prefix || normalized.startsWith(prefix + '/')) {
      throw new Error(`Safety Violation: Target path points to forbidden production/system directory: "${normalized}".`);
    }
  }

  // 3. Symlink & TOCTOU Containment Check:
  // Inspect canonicalDataDir and target path down to dataRoot to ensure no symlinks breakout
  if (existsSync(canonicalDataDir)) {
    const lstat = lstatSync(canonicalDataDir);
    if (lstat.isSymbolicLink()) {
      throw new Error(`Safety Violation: Symlink breakout detected! Demo data directory is a symlink.`);
    }
  }

  let currentCheck = normalized;
  while (currentCheck && currentCheck !== canonicalDataDir && currentCheck.startsWith(canonicalDataDir)) {
    if (existsSync(currentCheck)) {
      try {
        const lstat = lstatSync(currentCheck);
        if (lstat.isSymbolicLink()) {
          const real = realpathSync(currentCheck);
          const realRel = relative(canonicalDataDir, real);
          const realInside = realRel === '' || (!realRel.startsWith('..') && !isAbsolute(realRel));
          if (!realInside) {
            throw new Error(
              `Safety Violation: Symlink breakout detected! Path "${currentCheck}" points to external location "${real}".`
            );
          }
        }
      } catch (err: unknown) {
        if (err instanceof Error && (err.message.includes('Safety Violation') || err.message.includes('Symlink breakout'))) {
          throw err;
        }
      }
    }
    const parent = dirname(currentCheck);
    if (parent === currentCheck) break;
    currentCheck = parent;
  }

  return normalized;
}
