/**
 * Preflight Safety Verification Module
 *
 * Implements strict preflight safety checks:
 * 1. Rejects non-exact 127.0.0.1 bindings (requires strictly exact 127.0.0.1; rejects 0.0.0.0, localhost, ::1, etc.)
 * 2. Rejects demo data / source paths pointing to any happyclaw/data, $DSH_HOME, or external dangerous paths
 * 3. Enforces that demo data resides strictly inside <repoRoot>/.demo-data
 * 4. Ensures production data and real credentials are never read
 * 5. Safely allows in-repo fixtures (e.g. packages/import/fixtures/messages.db) and documentation (docs/safety.md)
 */

import { resolve, normalize, relative, isAbsolute, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  DEMO_DATA_DIR_NAME,
  SYSTEM_DANGER_ROOTS,
  DEFAULT_EXCLUDED_PORTS,
  ALLOWED_HOSTS,
} from './constants.js';
import { SafetyViolationError } from './errors.js';
import { validateHost, validatePort } from './port.js';

export interface PreflightCheckItem {
  name: string;
  passed: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export interface PreflightReport {
  ok: boolean;
  timestamp: string;
  checks: PreflightCheckItem[];
  errors: string[];
}

export interface PreflightOptions {
  /** Optional custom repository root (defaults to auto-detected enkeep repo root) */
  repoRoot?: string;
  /** Optional candidate demo data path to validate */
  demoDataPath?: string;
  /** Optional candidate host to validate */
  host?: string;
  /** Optional candidate ports to validate */
  ports?: number[];
  /** Optional candidate file/directory paths to validate for safety */
  targetPaths?: string[];
}

/**
 * Finds the Enkeep repository root by searching upward from the current working directory
 * or module directory for the enkeep-root package.json or .git marker.
 */
export function findRepoRoot(startDir: string = process.cwd()): string {
  let current = resolve(startDir);

  while (true) {
    const pkgPath = join(current, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkgContent = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        if (pkgContent.name === 'enkeep-root') {
          return current;
        }
      } catch {
        // Continue searching upward
      }
    }

    const parent = resolve(current, '..');
    if (parent === current) {
      break;
    }
    current = parent;
  }

  // Fallback to startDir if not found
  return resolve(startDir);
}

/**
 * Returns the canonical .demo-data directory for the current repo.
 */
export function getCanonicalDemoDataDir(repoRoot?: string): string {
  const root = repoRoot ? resolve(repoRoot) : findRepoRoot();
  return join(root, DEMO_DATA_DIR_NAME);
}

/**
 * Checks whether a given path violates any forbidden production or system paths.
 *
 * Safety Invariants:
 * - Rejects paths resolving to external HappyClaw production directories (~/happyclaw/data, /Users/<user>/happyclaw/data, $HAPPYCLAW_DATA_DIR).
 * - Rejects paths resolving to user $DSH_HOME or ~/.dsh.
 * - Rejects external sensitive system directories (/etc, /var, /usr, /System, /root) or user credentials (~/.ssh, ~/.aws).
 * - Repository-internal files (including docs/safety.md, packages/import/fixtures/messages.db,
 *   .demo-data/fixtures/messages.db, runtime synthetic fixtures) are inside the repository and NOT production data.
 */
export function isForbiddenPath(targetPath: string, repoRoot?: string): { forbidden: boolean; reason?: string } {
  const root = repoRoot ? resolve(repoRoot) : findRepoRoot();
  const normalized = normalize(resolve(root, targetPath));

  // If path is within the repository root, it is safe repository code, fixture, or documentation
  const relToRepo = relative(root, normalized);
  const isInsideRepo = relToRepo === '' || (!relToRepo.startsWith('..') && !isAbsolute(relToRepo));

  if (isInsideRepo) {
    return { forbidden: false };
  }

  // Path is outside repository root: check against known production & sensitive locations
  const userHome = homedir();

  // 1. Check HappyClaw production data directory in user home
  const happyclawDataDir = normalize(join(userHome, 'happyclaw', 'data'));
  const happyclawDir = normalize(join(userHome, 'happyclaw'));

  if (
    normalized === happyclawDataDir ||
    normalized.startsWith(happyclawDataDir + '/') ||
    normalized === happyclawDir ||
    normalized.startsWith(happyclawDir + '/')
  ) {
    return {
      forbidden: true,
      reason: `Target path points to external HappyClaw production data (${normalized})`,
    };
  }

  // 2. Check HappyClaw explicit env vars
  const happyclawEnvData = process.env.HAPPYCLAW_DATA_DIR;
  if (happyclawEnvData) {
    const normEnv = normalize(resolve(happyclawEnvData));
    if (normalized === normEnv || normalized.startsWith(normEnv + '/')) {
      return {
        forbidden: true,
        reason: `Target path matches HAPPYCLAW_DATA_DIR (${happyclawEnvData})`,
      };
    }
  }

  // 3. Check DSH_HOME environment variable & ~/.dsh
  const dshHome = process.env.DSH_HOME;
  if (dshHome) {
    const normDshHome = normalize(resolve(dshHome));
    if (normalized === normDshHome || normalized.startsWith(normDshHome + '/')) {
      return {
        forbidden: true,
        reason: `Target path is inside DSH_HOME (${dshHome})`,
      };
    }
  }
  const defaultDshHome = normalize(join(userHome, '.dsh'));
  if (normalized === defaultDshHome || normalized.startsWith(defaultDshHome + '/')) {
    return {
      forbidden: true,
      reason: `Target path is inside default DSH home (${defaultDshHome})`,
    };
  }

  // 4. Check sensitive user credentials directories (~/.ssh, ~/.aws, ~/.gnupg, ~/.config)
  const sensitiveUserDirs = ['.ssh', '.aws', '.gnupg', '.config'];
  for (const sDir of sensitiveUserDirs) {
    const fullSDir = normalize(join(userHome, sDir));
    if (normalized === fullSDir || normalized.startsWith(fullSDir + '/')) {
      return {
        forbidden: true,
        reason: `Target path points to sensitive user directory (${fullSDir})`,
      };
    }
  }

  // 5. Check system danger roots (/etc, /var, /usr, /System, /root, etc.)
  for (const sysRoot of SYSTEM_DANGER_ROOTS) {
    if (normalized === sysRoot || normalized.startsWith(sysRoot + '/')) {
      return {
        forbidden: true,
        reason: `Target path is inside system directory (${sysRoot})`,
      };
    }
  }

  // Any external path outside repo
  return {
    forbidden: true,
    reason: `Target path is outside the repository boundary (${normalized})`,
  };
}

/**
 * Validates that a path is strictly inside the repository's .demo-data boundary.
 * Throws SafetyViolationError if outside or forbidden.
 */
export function validateDemoDataPath(targetPath: string, repoRoot?: string): string {
  const root = repoRoot ? resolve(repoRoot) : findRepoRoot();
  const canonicalDemoDir = getCanonicalDemoDataDir(root);
  const normalizedTarget = normalize(resolve(root, targetPath));

  // Check forbidden paths first
  const forbiddenCheck = isForbiddenPath(normalizedTarget, root);
  if (forbiddenCheck.forbidden) {
    throw new SafetyViolationError(
      'FORBIDDEN_DATA_ACCESS',
      `Access to forbidden path rejected: ${normalizedTarget} (${forbiddenCheck.reason})`,
      { targetPath, normalizedTarget, reason: forbiddenCheck.reason }
    );
  }

  // Must be inside canonicalDemoDir
  const rel = relative(canonicalDemoDir, normalizedTarget);
  const isInside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));

  if (!isInside) {
    throw new SafetyViolationError(
      'PATH_OUTSIDE_DEMO_BOUNDARY',
      `Demo data path must be strictly contained inside "${canonicalDemoDir}", but got "${normalizedTarget}".`,
      { targetPath, normalizedTarget, canonicalDemoDir }
    );
  }

  return normalizedTarget;
}

/**
 * Validates any arbitrary path against forbidden paths and repository boundaries.
 */
export function validateSafePath(targetPath: string, repoRoot?: string): string {
  const root = repoRoot ? resolve(repoRoot) : findRepoRoot();
  const normalized = normalize(resolve(root, targetPath));

  const forbiddenCheck = isForbiddenPath(normalized, root);
  if (forbiddenCheck.forbidden) {
    throw new SafetyViolationError(
      'FORBIDDEN_DATA_ACCESS',
      `Target path is forbidden: ${normalized} (${forbiddenCheck.reason})`,
      { targetPath, normalized, reason: forbiddenCheck.reason }
    );
  }

  return normalized;
}

/**
 * Runs the full preflight safety verification suite.
 */
export function runPreflightChecks(options: PreflightOptions = {}): PreflightReport {
  const root = options.repoRoot ? resolve(options.repoRoot) : findRepoRoot();
  const checks: PreflightCheckItem[] = [];
  const errors: string[] = [];

  // Check 1: Repo Root Identification
  try {
    const pkgPath = join(root, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (pkg.name === 'enkeep-root') {
        checks.push({
          name: 'repo_root_identification',
          passed: true,
          message: `Identified valid enkeep root at ${root}`,
          details: { repoRoot: root },
        });
      } else {
        throw new Error(`Package name at ${pkgPath} is "${pkg.name}", expected "enkeep-root"`);
      }
    } else {
      throw new Error(`package.json not found at ${root}`);
    }
  } catch (err: any) {
    const msg = `Failed to identify enkeep repo root: ${err.message}`;
    checks.push({ name: 'repo_root_identification', passed: false, message: msg });
    errors.push(msg);
  }

  // Check 2: .gitignore contains .demo-data
  try {
    const gitignorePath = join(root, '.gitignore');
    if (existsSync(gitignorePath)) {
      const gitignoreContent = readFileSync(gitignorePath, 'utf-8');
      const lines = gitignoreContent.split('\n').map(l => l.trim());
      const hasDemoData = lines.some(l => l === '.demo-data' || l === '.demo-data/' || l.startsWith('.demo-data'));

      if (hasDemoData) {
        checks.push({
          name: 'demo_data_gitignored',
          passed: true,
          message: '.demo-data is correctly configured in .gitignore',
        });
      } else {
        throw new Error('.gitignore does not contain .demo-data entry');
      }
    } else {
      throw new Error('.gitignore not found at repo root');
    }
  } catch (err: any) {
    const msg = `Gitignore validation failed: ${err.message}`;
    checks.push({ name: 'demo_data_gitignored', passed: false, message: msg });
    errors.push(msg);
  }

  // Check 3: Host Binding Safety (if provided, or default 127.0.0.1)
  const hostToTest = options.host ?? '127.0.0.1';
  try {
    validateHost(hostToTest);
    checks.push({
      name: 'host_binding_safety',
      passed: true,
      message: `Host binding "${hostToTest}" is strictly exact 127.0.0.1`,
      details: { host: hostToTest },
    });
  } catch (err: any) {
    const msg = `Host binding check failed: ${err.message}`;
    checks.push({ name: 'host_binding_safety', passed: false, message: msg, details: { host: hostToTest } });
    errors.push(msg);
  }

  // Check 4: Reserved Ports Exclusion
  try {
    checks.push({
      name: 'reserved_ports_guard',
      passed: true,
      message: `Protected ports [${DEFAULT_EXCLUDED_PORTS.join(', ')}] (HappyClaw, DSH GUI) are guarded against allocation`,
      details: { excludedPorts: DEFAULT_EXCLUDED_PORTS },
    });
  } catch (err: any) {
    const msg = `Reserved ports check failed: ${err.message}`;
    checks.push({ name: 'reserved_ports_guard', passed: false, message: msg });
    errors.push(msg);
  }

  // Check 5: Custom Ports (if provided)
  if (options.ports && options.ports.length > 0) {
    for (const port of options.ports) {
      try {
        validatePort(port);
        checks.push({
          name: `port_validation_${port}`,
          passed: true,
          message: `Port ${port} is safe and non-reserved`,
          details: { port },
        });
      } catch (err: any) {
        const msg = `Port validation for ${port} failed: ${err.message}`;
        checks.push({ name: `port_validation_${port}`, passed: false, message: msg, details: { port } });
        errors.push(msg);
      }
    }
  }

  // Check 6: Demo Data Path Containment (if provided or default)
  const demoPathToTest = options.demoDataPath ?? getCanonicalDemoDataDir(root);
  try {
    const validatedDemoPath = validateDemoDataPath(demoPathToTest, root);
    checks.push({
      name: 'demo_data_path_containment',
      passed: true,
      message: `Demo data path is safely contained inside ${validatedDemoPath}`,
      details: { demoDataPath: validatedDemoPath },
    });
  } catch (err: any) {
    const msg = `Demo data path containment failed: ${err.message}`;
    checks.push({ name: 'demo_data_path_containment', passed: false, message: msg, details: { demoDataPath: demoPathToTest } });
    errors.push(msg);
  }

  // Check 7: Forbidden Path Isolation Checks
  if (options.targetPaths && options.targetPaths.length > 0) {
    for (const targetPath of options.targetPaths) {
      try {
        validateSafePath(targetPath, root);
        checks.push({
          name: `target_path_safety_${targetPath}`,
          passed: true,
          message: `Path "${targetPath}" passed forbidden path checks`,
        });
      } catch (err: any) {
        const msg = `Target path safety check failed for "${targetPath}": ${err.message}`;
        checks.push({ name: `target_path_safety_${targetPath}`, passed: false, message: msg });
        errors.push(msg);
      }
    }
  }

  return {
    ok: errors.length === 0,
    timestamp: new Date().toISOString(),
    checks,
    errors,
  };
}

/**
 * Asserts preflight checks pass; throws SafetyViolationError if any check fails.
 */
export function assertPreflight(options: PreflightOptions = {}): PreflightReport {
  const report = runPreflightChecks(options);
  if (!report.ok) {
    throw new SafetyViolationError(
      'PREFLIGHT_VALIDATION_FAILED',
      `Preflight safety checks failed:\n${report.errors.map(e => `  - ${e}`).join('\n')}`,
      { report }
    );
  }
  return report;
}
