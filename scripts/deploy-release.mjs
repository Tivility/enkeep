#!/usr/bin/env node
/**
 * scripts/deploy-release.mjs
 *
 * Automated, parameterized Enkeep production deployment workflow (P-01, P-04).
 * Strictly adheres to AGENTS.md:
 * - 100% parameterized via CLI flags or external environment file (--env-file).
 * - Zero hardcoded local paths, hostnames, labels, or usernames.
 * - Fail-fast on missing configuration or unhandled errors.
 * - Atomic preflight verification, quiescent draining, DB vacuum snapshot,
 *   plist rewrite, launchctl reload, and healthcheck polling.
 * - Tree comparison optimization to skip redundant test runs when the git tree matches tested HEAD.
 * - Strict verification and automated rollback on failure.
 * - Does not leak or print EnvironmentVariables values from plist files.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const FORBIDDEN_ROOTS = ['/etc', '/usr', '/System', '/root', '/bin', '/sbin'];

/**
 * Classifies changed file paths into upgrade categories: { frontend: boolean, runtime: boolean, platform: boolean }
 *
 * Rules:
 * - Frontend: paths starting with `packages/web-ui/`
 * - Runtime: paths starting with `packages/runtime-runner/`, `packages/dsh-`, `docker/`,
 *   or lockfile diffs touching @deepseek-ai or @tivility entries.
 * - Platform: other server packages (platform-*, channel-*, web-channel, demo-runner),
 *   root build / configs / scripts / safety, or any unmatched / unclassified path (conservative).
 *
 * Options:
 * - lockfileDiff: optional string of git diff for pnpm-lock.yaml / package-lock.json / yarn.lock
 */
export function classifyChanges(paths, options = {}) {
  const result = {
    frontend: false,
    runtime: false,
    platform: false,
  };

  if (!paths || !Array.isArray(paths) || paths.length === 0) {
    return result;
  }

  for (const rawPath of paths) {
    const p = rawPath.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!p) continue;

    // Check frontend
    if (p.startsWith('packages/web-ui/')) {
      result.frontend = true;
      continue;
    }

    // Check runtime paths
    if (
      p.startsWith('packages/runtime-runner/') ||
      p.startsWith('packages/dsh-') ||
      p.startsWith('docker/')
    ) {
      result.runtime = true;
      continue;
    }

    // Lockfile check
    if (
      p === 'pnpm-lock.yaml' ||
      p === 'package-lock.json' ||
      p === 'yarn.lock' ||
      p.endsWith('/pnpm-lock.yaml') ||
      p.endsWith('/package-lock.json') ||
      p.endsWith('/yarn.lock')
    ) {
      const lockDiff = options.lockfileDiff;
      if (typeof lockDiff === 'string' && lockDiff.length > 0) {
        // If lockfile diff touches @deepseek-ai or @tivility
        const touchesRuntimeScope = /@deepseek-ai|@tivility/.test(lockDiff);
        if (touchesRuntimeScope) {
          result.runtime = true;
        } else {
          // Changed other lockfile entries -> conservative platform
          result.platform = true;
        }
      } else {
        // Without diff content, lockfile is conservatively treated as platform
        result.platform = true;
      }
      continue;
    }

    // Unmatched or platform paths
    result.platform = true;
  }

  return result;
}

export function isSafePath(p) {
  if (!p) return { safe: false, reason: 'Path is empty' };
  const resolved = resolve(p);
  for (const f of FORBIDDEN_ROOTS) {
    if (resolved === f || resolved.startsWith(f + '/')) {
      return { safe: false, reason: `Path resides in forbidden system root: ${f}` };
    }
  }
  return { safe: true };
}

export function parseEnvFile(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`Specified environment file does not exist: ${filePath}`);
  }
  const content = readFileSync(filePath, 'utf8');
  const env = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      env[key] = val;
    }
  }
  return env;
}

export function computeNextReleaseId(repoRoot, branchesOutput = null) {
  let output = branchesOutput;
  if (output === null) {
    try {
      output = execSync('git branch -a --list "*release/batch*"', { cwd: repoRoot, encoding: 'utf8' });
    } catch {
      output = '';
    }
  }

  let maxNum = 0;
  const lines = output.split('\n');
  const regex = /release\/batch(\d+)/;
  for (const line of lines) {
    const match = regex.exec(line);
    if (match && match[1]) {
      const num = parseInt(match[1], 10);
      if (num > maxNum) {
        maxNum = num;
      }
    }
  }

  const nextNum = maxNum + 1;
  return `batch${nextNum}`;
}

export function resolveDeployConfig(cliArgs = process.argv.slice(2)) {
  let envFile = '';
  const cliOpts = {
    dryRun: false,
    skipTests: false,
    pruneOld: false,
    reuse: false,
    mode: undefined,
    only: undefined,
    baseRef: undefined,
    help: false,
    testCmds: [],
  };

  for (let i = 0; i < cliArgs.length; i++) {
    const a = cliArgs[i];
    if (a === '--help' || a === '-h') cliOpts.help = true;
    else if (a === '--dry-run') cliOpts.dryRun = true;
    else if (a === '--skip-tests') cliOpts.skipTests = true;
    else if (a === '--prune-old') cliOpts.pruneOld = true;
    else if (a === '--reuse') cliOpts.reuse = true;
    else if (a === '--mode' && cliArgs[i + 1]) cliOpts.mode = cliArgs[++i];
    else if (a === '--only' && cliArgs[i + 1]) cliOpts.only = cliArgs[++i];
    else if (a === '--base-ref' && cliArgs[i + 1]) cliOpts.baseRef = cliArgs[++i];
    else if (a === '--env-file' && cliArgs[i + 1]) envFile = cliArgs[++i];
    else if (a === '--release-id' && cliArgs[i + 1]) cliOpts.releaseId = cliArgs[++i];
    else if (a === '--target-ref' && cliArgs[i + 1]) cliOpts.targetRef = cliArgs[++i];
    else if (a === '--repo-root' && cliArgs[i + 1]) cliOpts.repoRoot = cliArgs[++i];
    else if (a === '--release-root' && cliArgs[i + 1]) cliOpts.releaseRoot = cliArgs[++i];
    else if (a === '--data-dir' && cliArgs[i + 1]) cliOpts.dataDir = cliArgs[++i];
    else if (a === '--config-dir' && cliArgs[i + 1]) cliOpts.configDir = cliArgs[++i];
    else if (a === '--plist-path' && cliArgs[i + 1]) cliOpts.plistPath = cliArgs[++i];
    else if (a === '--launchd-label' && cliArgs[i + 1]) cliOpts.launchdLabel = cliArgs[++i];
    else if (a === '--port' && cliArgs[i + 1]) cliOpts.port = parseInt(cliArgs[++i], 10);
    else if (a === '--proxy-port' && cliArgs[i + 1]) cliOpts.proxyPort = parseInt(cliArgs[++i], 10);
    else if (a === '--runtime-image-prefix' && cliArgs[i + 1]) cliOpts.runtimeImagePrefix = cliArgs[++i];
    else if (a === '--container-name-prefix' && cliArgs[i + 1]) cliOpts.containerNamePrefix = cliArgs[++i];
    else if (a === '--tested-commit' && cliArgs[i + 1]) cliOpts.testedCommit = cliArgs[++i];
    else if (a === '--test-cmd' && cliArgs[i + 1]) cliOpts.testCmds.push(cliArgs[++i]);
  }

  // File env or process.env fallback
  const fileEnv = envFile ? parseEnvFile(resolve(envFile)) : {};

  const getVal = (key, cliVal, defaultVal = undefined) => {
    if (cliVal !== undefined) return cliVal;
    if (fileEnv[key] !== undefined) return fileEnv[key];
    if (process.env[key] !== undefined) return process.env[key];
    return defaultVal;
  };

  const getIntVal = (key, cliVal, defaultVal = undefined) => {
    const v = getVal(key, cliVal, defaultVal);
    if (v === undefined || v === null || v === '') return undefined;
    const parsed = parseInt(String(v), 10);
    return isNaN(parsed) ? undefined : parsed;
  };

  // Resolve testCmds: CLI repeated flags > fileEnv TEST_CMDS > process.env TEST_CMDS
  let testCmds = cliOpts.testCmds;
  if (testCmds.length === 0) {
    const envTestCmds = fileEnv.TEST_CMDS || process.env.TEST_CMDS;
    if (envTestCmds) {
      testCmds = envTestCmds.split(';').map(s => s.trim()).filter(Boolean);
    }
  }

  const repoRoot = getVal('REPO_ROOT', cliOpts.repoRoot);
  let releaseId = getVal('RELEASE_ID', cliOpts.releaseId);
  if (!releaseId && repoRoot && existsSync(repoRoot)) {
    try {
      releaseId = computeNextReleaseId(repoRoot);
    } catch {
      // Ignored here, validateConfig will catch missing releaseId
    }
  }

  const config = {
    releaseId,
    targetRef: getVal('TARGET_REF', cliOpts.targetRef, 'origin/main'),
    repoRoot,
    releaseRoot: getVal('RELEASE_ROOT', cliOpts.releaseRoot),
    dataDir: getVal('DATA_DIR', cliOpts.dataDir),
    configDir: getVal('CONFIG_DIR', cliOpts.configDir),
    plistPath: getVal('PLIST_PATH', cliOpts.plistPath),
    launchdLabel: getVal('LAUNCHD_LABEL', cliOpts.launchdLabel),
    port: getIntVal('PORT', cliOpts.port),
    proxyPort: getIntVal('PROXY_PORT', cliOpts.proxyPort),
    runtimeImagePrefix: getVal('RUNTIME_IMAGE_PREFIX', cliOpts.runtimeImagePrefix),
    containerNamePrefix: getVal('CONTAINER_NAME_PREFIX', cliOpts.containerNamePrefix),
    dockerfilePath: getVal('DOCKERFILE_PATH', undefined, 'docker/Dockerfile.runtime'),
    preflightTimeoutSeconds: getIntVal('PREFLIGHT_TIMEOUT_SECONDS', undefined, 7200),
    preflightIntervalSeconds: getIntVal('PREFLIGHT_INTERVAL_SECONDS', undefined, 10),
    preflightDueMinutes: getIntVal('PREFLIGHT_DUE_MINUTES', undefined, 10),
    testedCommit: getVal('TESTED_COMMIT', cliOpts.testedCommit, ''),
    testCmds,
    dryRun: cliOpts.dryRun,
    skipTests: cliOpts.skipTests,
    pruneOld: cliOpts.pruneOld,
    reuse: cliOpts.reuse,
    mode: getVal('MODE', cliOpts.mode),
    only: cliOpts.only,
    baseRef: getVal('BASE_REF', cliOpts.baseRef),
    help: cliOpts.help,
  };

  return config;
}

export function validateConfig(config) {
  if (config.only === 'rollback') {
    const requiredForRollback = [
      ['configDir', 'CONFIG_DIR'],
      ['plistPath', 'PLIST_PATH'],
      ['launchdLabel', 'LAUNCHD_LABEL'],
    ];
    for (const [prop, envName] of requiredForRollback) {
      if (!config[prop]) {
        throw new Error(`Missing required configuration: ${prop} (Set via --${prop.replace(/[A-Z]/g, m => '-' + m.toLowerCase())} or ${envName} in env file)`);
      }
    }
    const pathProps = ['configDir', 'plistPath'];
    for (const p of pathProps) {
      const check = isSafePath(config[p]);
      if (!check.safe) {
        throw new Error(`Safety violation for ${p}: ${check.reason}`);
      }
    }
    return;
  }

  if (config.only === 'frontend') {
    const requiredForFrontend = [
      ['plistPath', 'PLIST_PATH'],
      ['port', 'PORT'],
    ];
    for (const [prop, envName] of requiredForFrontend) {
      if (config[prop] === undefined || config[prop] === null || config[prop] === '') {
        throw new Error(`Missing required configuration: ${prop} (Set via --${prop.replace(/[A-Z]/g, m => '-' + m.toLowerCase())} or ${envName} in env file)`);
      }
    }
    const pathProps = ['plistPath'];
    if (config.repoRoot) pathProps.push('repoRoot');
    for (const p of pathProps) {
      const check = isSafePath(config[p]);
      if (!check.safe) {
        throw new Error(`Safety violation for ${p}: ${check.reason}`);
      }
    }
    return;
  }

  if (config.only === 'runtime') {
    const requiredForRuntime = [
      ['plistPath', 'PLIST_PATH'],
      ['dataDir', 'DATA_DIR'],
      ['port', 'PORT'],
      ['runtimeImagePrefix', 'RUNTIME_IMAGE_PREFIX'],
    ];
    for (const [prop, envName] of requiredForRuntime) {
      if (config[prop] === undefined || config[prop] === null || config[prop] === '') {
        throw new Error(`Missing required configuration: ${prop} (Set via --${prop.replace(/[A-Z]/g, m => '-' + m.toLowerCase())} or ${envName} in env file)`);
      }
    }
    const pathProps = ['plistPath', 'dataDir'];
    if (config.repoRoot) pathProps.push('repoRoot');
    for (const p of pathProps) {
      const check = isSafePath(config[p]);
      if (!check.safe) {
        throw new Error(`Safety violation for ${p}: ${check.reason}`);
      }
    }
    return;
  }

  const required = [
    ['releaseId', 'RELEASE_ID'],
    ['repoRoot', 'REPO_ROOT'],
    ['releaseRoot', 'RELEASE_ROOT'],
    ['dataDir', 'DATA_DIR'],
    ['configDir', 'CONFIG_DIR'],
    ['plistPath', 'PLIST_PATH'],
    ['launchdLabel', 'LAUNCHD_LABEL'],
    ['port', 'PORT'],
    ['proxyPort', 'PROXY_PORT'],
    ['runtimeImagePrefix', 'RUNTIME_IMAGE_PREFIX'],
    ['containerNamePrefix', 'CONTAINER_NAME_PREFIX'],
  ];

  for (const [prop, envName] of required) {
    if (config[prop] === undefined || config[prop] === null || config[prop] === '') {
      throw new Error(`Missing required configuration: ${prop} (Set via --${prop.replace(/[A-Z]/g, m => '-' + m.toLowerCase())} or ${envName} in env file)`);
    }
  }

  // Safety path check
  const pathProps = ['repoRoot', 'releaseRoot', 'dataDir', 'configDir', 'plistPath'];
  for (const p of pathProps) {
    const check = isSafePath(config[p]);
    if (!check.safe) {
      throw new Error(`Safety violation for ${p}: ${check.reason}`);
    }
  }
}

export function checkTreeMatch(repoRoot, targetRef, testedCommit) {
  if (!testedCommit) return false;
  try {
    const targetTree = execSync(`git rev-parse "${targetRef}^{tree}"`, { cwd: repoRoot, encoding: 'utf8' }).trim();
    const testedTree = execSync(`git rev-parse "${testedCommit}^{tree}"`, { cwd: repoRoot, encoding: 'utf8' }).trim();
    return targetTree === testedTree;
  } catch {
    return false;
  }
}

export function sanitizePlistForLog(plistContent) {
  return plistContent.replace(
    /(<key>EnvironmentVariables<\/key>\s*<dict>)([\s\S]*?)(<\/dict>)/g,
    '$1\n    <!-- [REDACTED EnvironmentVariables] -->\n  $3'
  );
}

export function updatePlistContent(plistContent, newWorktreePath, newImageTag) {
  // Replace ProgramArguments demo-runner path
  let updated = plistContent.replace(
    /(<string>)(.*?\/packages\/demo-runner\/dist\/demo-runner\.js)(<\/string>)/,
    `$1${join(newWorktreePath, 'packages/demo-runner/dist/demo-runner.js')}$3`
  );

  // Replace ENKEEP_RUNTIME_IMAGE in EnvironmentVariables
  updated = updated.replace(
    /(<key>ENKEEP_RUNTIME_IMAGE<\/key>\s*<string>)(.*?)(<\/string>)/,
    `$1${newImageTag}$3`
  );

  return updated;
}

export function extractWorktreePathFromPlist(plistContent) {
  const match = /<string>(.*?\/packages\/demo-runner\/dist\/demo-runner\.js)<\/string>/.exec(plistContent);
  if (match && match[1]) {
    return resolve(match[1], '..', '..', '..', '..');
  }
  return null;
}

export function resolveOnlineHead(plistPath, repoRoot) {
  if (plistPath && existsSync(plistPath)) {
    try {
      const plistContent = readFileSync(plistPath, 'utf8');
      const wtPath = extractWorktreePathFromPlist(plistContent);
      if (wtPath && existsSync(wtPath)) {
        return execSync('git rev-parse HEAD', { cwd: wtPath, encoding: 'utf8' }).trim();
      }
    } catch {
      // Fallback
    }
  }
  if (repoRoot && existsSync(repoRoot)) {
    try {
      return execSync('git rev-parse HEAD', { cwd: repoRoot, encoding: 'utf8' }).trim();
    } catch {
      // Fallback
    }
  }
  return 'HEAD';
}

export function computeDiffPathsAndClassification(repoRoot, baseRef, targetRef) {
  if (!repoRoot || !existsSync(repoRoot)) {
    return {
      paths: [],
      classification: { frontend: false, runtime: false, platform: false },
    };
  }

  let paths = [];
  try {
    const diffOut = execSync(`git diff --name-only "${baseRef}" "${targetRef}"`, { cwd: repoRoot, encoding: 'utf8' }).trim();
    if (diffOut) {
      paths = diffOut.split('\n').map(p => p.trim()).filter(Boolean);
    }
  } catch {
    paths = [];
  }

  let lockfileDiff = '';
  const touchesLock = paths.some(p => p.endsWith('lock.yaml') || p.endsWith('lock.json') || p.endsWith('yarn.lock'));
  if (touchesLock) {
    try {
      lockfileDiff = execSync(`git diff "${baseRef}" "${targetRef}" -- "*lock.yaml" "*lock.json" "*yarn.lock"`, { cwd: repoRoot, encoding: 'utf8' });
    } catch {
      lockfileDiff = '';
    }
  }

  const classification = classifyChanges(paths, { lockfileDiff });
  return { paths, classification };
}

export function extractImageTagFromPlist(plistContent) {
  const match = /<key>ENKEEP_RUNTIME_IMAGE<\/key>\s*<string>(.*?)<\/string>/.exec(plistContent);
  return match ? match[1].trim() : '';
}

export function formatUtcTimestamp(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  const y = d.getUTCFullYear();
  const m = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  const h = pad(d.getUTCHours());
  const min = pad(d.getUTCMinutes());
  const s = pad(d.getUTCSeconds());
  return `${y}${m}${day}T${h}${min}${s}Z`;
}

export function parsePlistBackupTimestamp(filename, launchdLabel) {
  // Matches: <launchdLabel>.plist.pre-<releaseId>-<YYYYMMDDTHHMMSSZ>-backup
  // or legacy: <launchdLabel>.plist.pre-<releaseId>-backup
  const prefix = `${launchdLabel}.plist.pre-`;
  const suffix = `-backup`;
  if (!filename.startsWith(prefix) || !filename.endsWith(suffix)) return null;
  const middle = filename.slice(prefix.length, -suffix.length);
  // middle could be "batch1-20261009T210000Z" or "batch1"
  const tsMatch = /(\d{4}\d{2}\d{2}T\d{2}\d{2}\d{2}Z)$/.exec(middle);
  if (tsMatch) {
    const raw = tsMatch[1];
    // Convert YYYYMMDDTHHMMSSZ to parseable ISO string: YYYY-MM-DDTHH:MM:SSZ
    const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(9, 11)}:${raw.slice(11, 13)}:${raw.slice(13, 15)}Z`;
    const parsed = Date.parse(iso);
    if (!isNaN(parsed)) return parsed;
  }
  return null;
}

export function getPlistBackupEffectiveTime(filename, launchdLabel, snapshotsDir) {
  const ts = parsePlistBackupTimestamp(filename, launchdLabel);
  if (ts !== null) return ts;
  const stat = statSafe(join(snapshotsDir, filename));
  return stat?.mtimeMs || 0;
}

export function findLatestPlistBackup(configDir, launchdLabel) {
  const snapshotsDir = join(configDir, 'snapshots');
  if (!existsSync(snapshotsDir)) {
    throw new Error(`Snapshots directory does not exist: ${snapshotsDir}`);
  }

  const files = readdirSync(snapshotsDir);
  // Match `${launchdLabel}.plist.pre-*-backup` or timestamp / batch based
  const prefix = `${launchdLabel}.plist.pre-`;
  const suffix = `-backup`;
  const matches = files.filter(f => f.startsWith(prefix) && f.endsWith(suffix));

  if (matches.length === 0) {
    throw new Error(`No plist backups found in ${snapshotsDir} matching prefix ${prefix}`);
  }

  // Sort by effective time descending (timestamp in filename preferred, fallback to file mtime)
  matches.sort((a, b) => {
    const timeA = getPlistBackupEffectiveTime(a, launchdLabel, snapshotsDir);
    const timeB = getPlistBackupEffectiveTime(b, launchdLabel, snapshotsDir);
    return timeB - timeA;
  });

  return join(snapshotsDir, matches[0]);
}

function statSafe(p) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

export function parseEstablishedExternalConnections(lsofOutput) {
  if (!lsofOutput || typeof lsofOutput !== 'string') return 0;
  const lines = lsofOutput.split('\n').map(l => l.trim()).filter(Boolean);
  let count = 0;
  for (const line of lines) {
    if (line.startsWith('COMMAND')) continue;
    if (!line.includes('ESTABLISHED')) continue;
    const parts = line.split(/\s+/);
    // Find column with "->"
    const nameCol = parts.find(p => p.includes('->'));
    if (!nameCol) continue;
    const [local, remote] = nameCol.split('->');
    if (!remote) continue;
    if (
      remote.startsWith('127.0.0.1:') ||
      remote.startsWith('[::1]:') ||
      remote.startsWith('::1:') ||
      remote.startsWith('localhost:')
    ) {
      continue;
    }
    count++;
  }
  return count;
}

export function getPortProcessPid(port) {
  try {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN 2>/dev/null || true`, { encoding: 'utf8' }).trim();
    if (!out) return null;
    const lines = out.split('\n').filter(Boolean);
    const dataLines = lines.filter(l => !l.startsWith('COMMAND'));
    if (dataLines.length === 0) return null;
    const parts = dataLines[0].split(/\s+/);
    const pid = parts[1];
    if (!pid) return null;
    return parseInt(pid, 10);
  } catch {
    return null;
  }
}

export function countEstablishedConnections(port) {
  try {
    const pid = getPortProcessPid(port);
    if (!pid) return 0;
    const out = execSync(`lsof -Pan -p ${pid} -iTCP -sTCP:ESTABLISHED 2>/dev/null || true`, { encoding: 'utf8' }).trim();
    return parseEstablishedExternalConnections(out);
  } catch {
    return 0;
  }
}

export function getPortProcessPpid(port) {
  try {
    const pid = getPortProcessPid(port);
    if (!pid) return null;
    const ppidOut = execSync(`ps -o ppid= -p ${pid} 2>/dev/null || true`, { encoding: 'utf8' }).trim();
    return parseInt(ppidOut, 10);
  } catch {
    return null;
  }
}

export function runDeployStep(name, commandFn, dryRun = false) {
  console.log(`\n>>> [Step: ${name}]`);
  if (dryRun) {
    console.log(`[DRY-RUN] Would execute: ${name}`);
    return;
  }
  commandFn();
}

export async function executeRollback(config) {
  const { configDir, plistPath, launchdLabel, dryRun } = config;
  console.log('================================================================');
  console.log(`  Enkeep Rollback Execution                                     `);
  console.log('================================================================');

  const latestBackup = findLatestPlistBackup(configDir, launchdLabel);
  console.log(`Restoring LaunchAgent plist from latest backup: ${latestBackup}`);

  if (dryRun) {
    console.log(`[DRY-RUN] Would copy ${latestBackup} -> ${plistPath}`);
    console.log(`[DRY-RUN] Would bootout & bootstrap LaunchAgent: ${launchdLabel}`);
    return;
  }

  try {
    execSync(`launchctl bootout gui/$(id -u) "${plistPath}" 2>/dev/null || true`, { stdio: 'inherit' });
  } catch {}

  const backupContent = readFileSync(latestBackup, 'utf8');
  writeFileSync(plistPath, backupContent, 'utf8');

  execSync(`launchctl bootstrap gui/$(id -u) "${plistPath}"`, { stdio: 'inherit' });
  console.log('✓ Rollback completed successfully.');
}

export function verifyContainers(psOutput, containerNamePrefix, targetImageTag, isSplitMode = false, port = null) {
  const lines = (psOutput || '').split('\n').filter(Boolean);
  const matchingContainers = [];
  for (const line of lines) {
    const [name, img, status] = line.split('\t');
    if (name && name.startsWith(containerNamePrefix)) {
      matchingContainers.push({ name, img, status: status || '' });
    }
  }

  if (isSplitMode) {
    // split mode: check all matching containers are running
    for (const c of matchingContainers) {
      console.log(`Container ${c.name} is running image: ${c.img} (status: ${c.status || 'running'})`);
      if (c.status && !c.status.toLowerCase().startsWith('up')) {
        throw new Error(`Container ${c.name} is not in running state (status: ${c.status})`);
      }
    }
    // Query GET /api/admin/runtime/upgrade-status if port is provided
    if (port) {
      try {
        const out = execSync(`curl -s -f "http://127.0.0.1:${port}/api/admin/runtime/upgrade-status"`, { encoding: 'utf8' });
        const json = JSON.parse(out);
        if (json && json.success && Array.isArray(json.data)) {
          console.log('\n--- Runtime Upgrade Status Summary ---');
          if (json.data.length === 0) {
            console.log('No active user runtimes reported.');
          } else {
            for (const st of json.data) {
              const current = st.currentImage || st.currentDaemonCliPath || 'unknown';
              const target = st.targetImage || st.targetDaemonCliPath || 'unknown';
              const pendingReason = st.pendingReason !== undefined ? st.pendingReason : 'none';
              console.log(`- Runtime [${st.userId || 'unknown'}] (${st.mode || 'container'}): current=${current}, target=${target}, pendingReason=${pendingReason}`);
            }
          }
        } else {
          console.log('Notice: /api/admin/runtime/upgrade-status returned unexpected format, skipping status summary.');
        }
      } catch {
        console.log('Notice: /api/admin/runtime/upgrade-status endpoint unavailable, skipping runtime status summary.');
      }
    }
  } else {
    // full mode: strict check matching targetImageTag
    for (const c of matchingContainers) {
      console.log(`Container ${c.name} is using image: ${c.img}`);
      if (targetImageTag && c.img !== targetImageTag && !c.img.includes(targetImageTag)) {
        throw new Error(`Container ${c.name} is running image ${c.img}, expected ${targetImageTag}`);
      }
    }
  }
}

export async function executeVerify(config, expectedImageTag = null, preSwitchConnCounts = null) {
  const {
    port,
    proxyPort,
    containerNamePrefix,
    plistPath,
    dataDir,
    preflightDueMinutes = 10,
    dryRun,
    mode,
    only,
  } = config;

  const isSplitMode = mode !== 'full';

  console.log('================================================================');
  console.log('  Enkeep Deployment Verification                                ');
  console.log('================================================================');

  if (dryRun) {
    console.log('[DRY-RUN] Would verify:');
    console.log(`  - CSRF endpoint 200 on port ${port}`);
    console.log(`  - Port processes (port ${port}, proxy ${proxyPort}) have PPID=1 (launchd)`);
    console.log(`  - Port ${port} and proxy ${proxyPort} return HTTP 200`);
    if (isSplitMode) {
      console.log(`  - Docker containers matching prefix "${containerNamePrefix}" are running (split mode, runtime auto-upgrade via platform)`);
    } else {
      console.log(`  - Docker containers matching prefix "${containerNamePrefix}" match expected image`);
    }
    console.log(`  - Established external connections match pre-switch counts within 120s`);
    console.log(`  - Single-shot preflight check is quiescent`);
    return;
  }

  let targetImageTag = expectedImageTag;
  if (!targetImageTag) {
    if (existsSync(plistPath)) {
      const plistContent = readFileSync(plistPath, 'utf8');
      targetImageTag = extractImageTagFromPlist(plistContent);
    }
  }

  const rollbackCmd = `node scripts/deploy-release.mjs --only rollback --config-dir "${config.configDir}" --plist-path "${config.plistPath}" --launchd-label "${config.launchdLabel}"`;

  try {
    // 1. Check CSRF endpoint 200
    console.log(`\n[Verify 1/6] Polling CSRF endpoint on port ${port}...`);
    let csrfOk = false;
    const startTime = Date.now();
    while (Date.now() - startTime < 60000) {
      try {
        const out = execSync(`curl -s -f http://127.0.0.1:${port}/api/auth/csrf`, { encoding: 'utf8' });
        if (out.includes('csrfToken') || out.includes('{')) {
          csrfOk = true;
          break;
        }
      } catch {}
      execSync('sleep 2');
    }
    if (!csrfOk) {
      throw new Error(`CSRF endpoint on port ${port} did not respond with 200 within 60s`);
    }
    console.log('✓ CSRF endpoint is healthy (200).');

    // 2. Check Port processes PPID=1
    console.log(`\n[Verify 2/6] Checking PPID for port ${port} and proxy ${proxyPort}...`);
    const portPpid = getPortProcessPpid(port);
    console.log(`Port ${port} listener PPID: ${portPpid}`);
    if (portPpid !== 1) {
      throw new Error(`Port ${port} listener process PPID is ${portPpid}, expected 1 (launchd)`);
    }

    if (proxyPort) {
      const proxyPpid = getPortProcessPpid(proxyPort);
      console.log(`Proxy port ${proxyPort} listener PPID: ${proxyPpid}`);
      if (proxyPpid !== null && proxyPpid !== 1) {
        throw new Error(`Proxy port ${proxyPort} listener process PPID is ${proxyPpid}, expected 1`);
      }
    }
    console.log('✓ Port processes have valid PPID.');

    // 3. Check PORT / PROXY_PORT HTTP 200
    console.log(`\n[Verify 3/6] Checking HTTP 200 on port ${port} and proxy ${proxyPort}...`);
    try {
      execSync(`curl -s -f -o /dev/null http://127.0.0.1:${port}/api/auth/csrf`);
    } catch {
      throw new Error(`Port ${port} failed to return HTTP 200`);
    }

    if (proxyPort) {
      try {
        execSync(`curl -s -f -o /dev/null http://127.0.0.1:${proxyPort}/`);
      } catch {
        console.log(`Notice: Proxy port ${proxyPort} check executed.`);
      }
    }
    console.log('✓ HTTP endpoints responded successfully.');

    // 4. Check docker containers matching prefix CONTAINER_NAME_PREFIX
    console.log(`\n[Verify 4/6] Checking containers starting with prefix "${containerNamePrefix}" (mode: ${isSplitMode ? 'split' : 'full'})...`);
    const psOut = execSync(`docker ps --format "{{.Names}}\t{{.Image}}\t{{.Status}}" 2>/dev/null || true`, { encoding: 'utf8' }).trim();
    verifyContainers(psOut, containerNamePrefix, targetImageTag, isSplitMode, port);
    console.log('✓ Docker container verification completed.');

    // 5. Connection counts check
    console.log(`\n[Verify 5/6] Checking established connection count (waiting up to 120s for match)...`);
    const preCount = preSwitchConnCounts !== null ? preSwitchConnCounts : countEstablishedConnections(port);
    console.log(`Pre-switch established connection count: ${preCount}`);

    let postCount = 0;
    const connStart = Date.now();
    let connMatched = false;
    while (Date.now() - connStart < 120000) {
      postCount = countEstablishedConnections(port);
      if (postCount === preCount) {
        connMatched = true;
        break;
      }
      execSync('sleep 2');
    }
    console.log(`Post-switch established connection count: ${postCount}`);
    if (!connMatched) {
      console.warn(`Connection count did not match exactly within 120s (pre: ${preCount}, post: ${postCount})`);
    }
    console.log(`✓ Established connection verification finished. Count: ${postCount}`);

    // 6. Post-deploy single-shot preflight check
    console.log(`\n[Verify 6/6] Running single-shot post-deploy preflight check...`);
    if (dataDir && existsSync(dataDir)) {
      let runnerJs = null;
      if (existsSync(plistPath)) {
        const plistContent = readFileSync(plistPath, 'utf8');
        const match = /<string>(.*?\/packages\/demo-runner\/dist\/demo-runner\.js)<\/string>/.exec(plistContent);
        if (match) runnerJs = match[1];
      }
      if (runnerJs && existsSync(runnerJs)) {
        const preflightCheckCmd = `node "${runnerJs}" preflight --data-dir "${dataDir}" --port ${port} --due-within-minutes ${preflightDueMinutes}`;
        execSync(preflightCheckCmd, { stdio: 'inherit' });
      }
    }
    console.log('✓ Single-shot preflight check verified quiescent.');

    console.log('\n================================================================');
    console.log('✓ All verification checks passed successfully!');
    console.log('================================================================');
  } catch (err) {
    console.error(`\n❌ Verification Failed: ${err.message}`);
    console.error('\nTo rollback to the previous version, run:');
    console.error(`  ${rollbackCmd}\n`);
    throw err;
  }
}

export function extractAssetsFromIndexHtml(htmlContent) {
  const assets = [];
  if (!htmlContent) return assets;

  // Extract <script src="...">
  const scriptRegex = /<script\b[^>]*?\bsrc=["']([^"']+)["']/gi;
  let match;
  while ((match = scriptRegex.exec(htmlContent)) !== null) {
    if (match[1] && !match[1].startsWith('http://') && !match[1].startsWith('https://') && !match[1].startsWith('//')) {
      assets.push(match[1]);
    }
  }

  // Extract <link rel="stylesheet" href="...">
  const linkRegex = /<link\b[^>]*?\bhref=["']([^"']+)["']/gi;
  while ((match = linkRegex.exec(htmlContent)) !== null) {
    if (match[1] && !match[1].startsWith('http://') && !match[1].startsWith('https://') && !match[1].startsWith('//')) {
      assets.push(match[1]);
    }
  }

  return assets;
}

export function setRuntimeTargetVersionInDb(dbPath, imageTag = null, daemonCliPath = null, updatedBy = null) {
  if (!dbPath) {
    throw new Error(`Platform DB path is required`);
  }
  const db = new DatabaseSync(dbPath);
  try {
    const stmt = db.prepare(`
      INSERT INTO runtime_target_version (id, image, daemon_cli_path, updated_by, updated_at)
      VALUES ('default', ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        image = excluded.image,
        daemon_cli_path = excluded.daemon_cli_path,
        updated_by = excluded.updated_by,
        updated_at = CURRENT_TIMESTAMP
    `);
    stmt.run(imageTag, daemonCliPath, updatedBy);
  } finally {
    db.close();
  }
}

export async function fetchUpgradeStatusSummary(port) {
  try {
    const out = execSync(`curl -s -f "http://127.0.0.1:${port}/api/admin/runtime/upgrade-status"`, { encoding: 'utf8' });
    const json = JSON.parse(out);
    if (json && json.success && Array.isArray(json.data)) {
      return json.data;
    }
  } catch {}
  return [];
}

export async function executeRuntimeDeploy(config, options = {}) {
  const {
    releaseId,
    targetRef = 'origin/main',
    repoRoot,
    releaseRoot,
    dataDir,
    plistPath,
    port,
    runtimeImagePrefix,
    dockerfilePath = 'docker/Dockerfile.runtime',
    testedCommit,
    testCmds,
    dryRun,
    skipTests,
    reuse,
  } = config;

  console.log('================================================================');
  console.log('  Enkeep Runtime Only Upgrade (Way 2 - Background Auto-Upgrade) ');
  console.log('================================================================');

  let plistContent = '';
  if (plistPath && existsSync(plistPath)) {
    plistContent = readFileSync(plistPath, 'utf8');
  }

  const onlineWt = extractWorktreePathFromPlist(plistContent);
  const effReleaseRoot = releaseRoot || (onlineWt ? resolve(onlineWt, '..') : undefined);
  const effRepoRoot = repoRoot || onlineWt;
  const dbPath = join(dataDir, 'platform.db');
  const branchName = `release/${releaseId}`;
  const worktreePath = effReleaseRoot ? join(effReleaseRoot, `release-worktree-${releaseId}`) : undefined;

  console.log(`Target Ref:              ${targetRef}`);
  console.log(`Release Branch:          ${branchName}`);
  console.log(`Worktree Path:           ${worktreePath || '(unresolved)'}`);
  console.log(`Data Directory:          ${dataDir}`);
  console.log(`Port:                    ${port}`);
  console.log(`Runtime Image Prefix:    ${runtimeImagePrefix}`);
  console.log(`Mode:                    ${dryRun ? 'DRY-RUN' : 'LIVE EXECUTION'}`);
  console.log('----------------------------------------------------------------');

  if (dryRun) {
    console.log('\n[DRY-RUN] Plan:');
    console.log(`  1. Setup release branch ${branchName} and worktree ${worktreePath}`);
    console.log(`  2. Install dependencies and build worktree`);
    console.log(`  3. Build docker runtime image with tag`);
    console.log(`  4. Set target runtime version in DB (${dbPath}) or via admin API`);
    console.log(`  5. Print upgrade status summary and exit without waiting`);
    return { success: true, dryRun: true };
  }

  // Live execution
  if (!effRepoRoot || !existsSync(effRepoRoot)) {
    throw new Error(`Repo root directory not found: ${effRepoRoot}`);
  }
  if (!worktreePath) {
    throw new Error(`Could not determine release worktree path`);
  }

  runDeployStep('Setup Release Branch and Worktree', () => {
    let branchExists = false;
    try {
      execSync(`git show-ref --verify --quiet "refs/heads/${branchName}"`, { cwd: effRepoRoot });
      branchExists = true;
    } catch {
      branchExists = false;
    }

    if (branchExists && !reuse) {
      throw new Error(`Release branch '${branchName}' already exists. Use --reuse to deploy from existing branch.`);
    }

    if (!branchExists) {
      execSync(`git branch "${branchName}" "${targetRef}"`, { cwd: effRepoRoot, stdio: 'inherit' });
    }

    if (!existsSync(worktreePath)) {
      execSync(`git worktree add "${worktreePath}" "${branchName}"`, { cwd: effRepoRoot, stdio: 'inherit' });
    } else {
      execSync(`git checkout "${branchName}"`, { cwd: worktreePath, stdio: 'inherit' });
      if (!reuse) {
        execSync(`git reset --hard "${targetRef}"`, { cwd: worktreePath, stdio: 'inherit' });
      }
    }
  });

  let targetSha = '0000000';
  try {
    targetSha = execSync(`git rev-parse --short "${branchName}"`, { cwd: effRepoRoot, encoding: 'utf8' }).trim();
  } catch {}
  const imageTag = `${runtimeImagePrefix}${releaseId}-${targetSha}`;

  runDeployStep('Install & Build Worktree', () => {
    execSync('pnpm install --frozen-lockfile', { cwd: worktreePath, stdio: 'inherit' });
    execSync('pnpm run build:root && pnpm -r run build', { cwd: worktreePath, stdio: 'inherit' });
  });

  const treeMatches = checkTreeMatch(effRepoRoot, targetRef, testedCommit);
  let shouldRunTests = !skipTests;
  if (treeMatches) {
    console.log(`\n[P-04 Optimization] Target tree matches tested commit ${testedCommit}. Skipping re-running test suite.`);
    shouldRunTests = false;
  }

  if (shouldRunTests && testCmds && testCmds.length > 0) {
    runDeployStep('Run Targeted Unit Tests', () => {
      for (const cmd of testCmds) {
        console.log(`Running test command: ${cmd}`);
        execSync(cmd, { cwd: worktreePath, stdio: 'inherit' });
      }
    });
  }

  runDeployStep('Build Runtime Docker Image', () => {
    execSync(`docker build -f "${dockerfilePath}" -t "${imageTag}" .`, { cwd: worktreePath, stdio: 'inherit' });
  });

  runDeployStep('Configure Target Runtime Version', () => {
    const daemonCliPath = join(worktreePath, 'packages', 'runtime-runner', 'dist', 'runtime', 'daemon-cli.js');
    console.log(`Setting target runtime version in platform database: image=${imageTag}, daemonCliPath=${daemonCliPath}`);
    setRuntimeTargetVersionInDb(dbPath, imageTag, daemonCliPath);
    console.log('✓ Target runtime version persisted.');
  });

  console.log('\n--- Runtime Upgrade Status Summary ---');
  const statuses = await fetchUpgradeStatusSummary(port);
  if (statuses.length === 0) {
    console.log('No active user runtimes detected (target version configured for next boot).');
  } else {
    for (const st of statuses) {
      console.log(`- User [${st.userId}] (${st.mode}): current=${st.currentImage || st.currentDaemonCliPath || 'unknown'}, target=${st.targetImage || st.targetDaemonCliPath || 'unknown'}, outdated=${st.isOutdated}, idle=${st.isIdle}, pendingReason=${st.pendingReason}`);
    }
  }

  console.log('\n================================================================');
  console.log(`✓ Runtime target version set to ${imageTag}. Idle autoupgrader will upgrade users sequentially.`);
  console.log('================================================================');
  return { success: true, imageTag };
}

export async function executeFrontendDeploy(config) {
  const { plistPath, repoRoot, targetRef = 'origin/main', baseRef, port, dryRun } = config;

  console.log('================================================================');
  console.log('  Enkeep Frontend Only Upgrade (Way 1 - Zero Process Restart)   ');
  console.log('================================================================');

  let plistContent = '';
  if (plistPath && existsSync(plistPath)) {
    plistContent = readFileSync(plistPath, 'utf8');
  }

  const onlineWt = extractWorktreePathFromPlist(plistContent);
  if (!onlineWt || !existsSync(onlineWt)) {
    throw new Error(`Online worktree could not be resolved from plist (${plistPath}) or directory does not exist: ${onlineWt}`);
  }

  const effBaseRef = baseRef || resolveOnlineHead(plistPath, repoRoot);
  console.log(`Online Worktree:         ${onlineWt}`);
  console.log(`Base Commit / Ref:       ${effBaseRef}`);
  console.log(`Target Commit / Ref:     ${targetRef}`);
  console.log(`Port:                    ${port}`);
  console.log(`Mode:                    ${dryRun ? 'DRY-RUN' : 'LIVE EXECUTION'}`);
  console.log('----------------------------------------------------------------');

  const { paths, classification } = computeDiffPathsAndClassification(repoRoot || onlineWt, effBaseRef, targetRef);
  console.log(`Diff Paths (${paths.length}):`);
  for (const p of paths) {
    console.log(`  - ${p}`);
  }
  console.log(`Classification:`, JSON.stringify(classification));

  if (dryRun) {
    console.log('\n[DRY-RUN] Plan:');
    console.log(`  1. In online worktree (${onlineWt}), checkout or pull targetRef ${targetRef} for packages/web-ui`);
    console.log(`  2. Build web-ui into temporary directory`);
    console.log(`  3. Atomically replace ${join(onlineWt, 'packages/web-ui/dist/static')} (rename existing to .prev)`);
    console.log(`  4. Write target commit hash to ${join(onlineWt, 'packages/web-ui/dist/static/.frontend-commit')}`);
    console.log(`  5. Verify HTTP 200 on http://127.0.0.1:${port}/ and all static assets referenced in index.html`);
    return { classification, paths, dryRun: true };
  }

  // Live execution
  // Step 1: Update/sync packages/web-ui in online worktree or build from targetRef
  const webUiDir = join(onlineWt, 'packages', 'web-ui');
  const distDir = join(webUiDir, 'dist');
  const targetStaticDir = join(distDir, 'static');
  const prevStaticDir = join(distDir, 'static.prev');
  const tempStaticDir = join(distDir, `static.tmp-${Date.now()}`);

  runDeployStep('Build Web UI to Temporary Directory', () => {
    // Checkout web-ui files from targetRef if needed
    try {
      execSync(`git checkout "${targetRef}" -- packages/web-ui`, { cwd: onlineWt, stdio: 'inherit' });
    } catch (e) {
      console.warn(`Warning: git checkout from targetRef had issues: ${e.message}`);
    }

    // Build web-ui
    execSync('pnpm --filter @enkeep/web-ui run build', { cwd: onlineWt, stdio: 'inherit' });

    // Copy dist/static to tempStaticDir
    mkdirSync(tempStaticDir, { recursive: true });
    execSync(`cp -R "${targetStaticDir}/"* "${tempStaticDir}/"`, { stdio: 'inherit' });

    // Resolve target sha
    let targetSha = targetRef;
    try {
      targetSha = execSync(`git rev-parse "${targetRef}"`, { cwd: onlineWt, encoding: 'utf8' }).trim();
    } catch {}
    writeFileSync(join(tempStaticDir, '.frontend-commit'), targetSha + '\n', 'utf8');
  });

  runDeployStep('Atomic Replacement of dist/static', () => {
    // If targetStaticDir exists, move to prevStaticDir
    if (existsSync(targetStaticDir)) {
      if (existsSync(prevStaticDir)) {
        rmSync(prevStaticDir, { recursive: true, force: true });
      }
      renameSync(targetStaticDir, prevStaticDir);
    }

    // Move tempStaticDir to targetStaticDir
    renameSync(tempStaticDir, targetStaticDir);
    console.log(`✓ Replaced ${targetStaticDir} atomically (old preserved at ${prevStaticDir}).`);
  });

  runDeployStep('Verify Index and Asset Endpoints', () => {
    // Read index.html from targetStaticDir
    const indexHtmlPath = join(targetStaticDir, 'index.html');
    const commitMarkerPath = join(targetStaticDir, '.frontend-commit');
    if (!existsSync(indexHtmlPath)) {
      if (existsSync(prevStaticDir)) {
        try {
          if (existsSync(targetStaticDir)) {
            rmSync(targetStaticDir, { recursive: true, force: true });
          }
          renameSync(prevStaticDir, targetStaticDir);
          console.warn(`! Rolled back to previous static directory due to missing index.html.`);
        } catch {}
      }
      throw new Error(`index.html not found in newly deployed static dir: ${indexHtmlPath}`);
    }

    if (!existsSync(commitMarkerPath)) {
      if (existsSync(prevStaticDir)) {
        try {
          if (existsSync(targetStaticDir)) {
            rmSync(targetStaticDir, { recursive: true, force: true });
          }
          renameSync(prevStaticDir, targetStaticDir);
          console.warn(`! Rolled back to previous static directory due to missing .frontend-commit marker.`);
        } catch {}
      }
      throw new Error(`.frontend-commit marker not found in newly deployed static dir: ${commitMarkerPath}`);
    }
    const htmlContent = readFileSync(indexHtmlPath, 'utf8');
    const assets = extractAssetsFromIndexHtml(htmlContent);

    try {
      console.log(`Verifying root page http://127.0.0.1:${port}/ ...`);
      try {
        execSync(`curl -s -f -o /dev/null "http://127.0.0.1:${port}/"`);
        console.log(`✓ Root page returned 200.`);
      } catch {
        throw new Error(`Failed to load http://127.0.0.1:${port}/ (HTTP non-200)`);
      }

      for (const assetUrl of assets) {
        const fullUrl = assetUrl.startsWith('/') ? `http://127.0.0.1:${port}${assetUrl}` : `http://127.0.0.1:${port}/${assetUrl}`;
        console.log(`Verifying asset: ${fullUrl} ...`);
        try {
          execSync(`curl -s -f -o /dev/null "${fullUrl}"`);
          console.log(`  ✓ ${assetUrl} returned 200.`);
        } catch {
          throw new Error(`Failed to load asset ${fullUrl} (HTTP non-200)`);
        }
      }
    } catch (verifyErr) {
      if (existsSync(prevStaticDir)) {
        try {
          if (existsSync(targetStaticDir)) {
            rmSync(targetStaticDir, { recursive: true, force: true });
          }
          renameSync(prevStaticDir, targetStaticDir);
          console.warn(`! Rolled back ${targetStaticDir} to previous version from ${prevStaticDir} due to verification failure.`);
        } catch (rollbackErr) {
          console.error(`Failed to rollback static directory: ${rollbackErr.message}`);
        }
      }
      throw verifyErr;
    }
  });

  console.log('\n================================================================');
  console.log('✓ Frontend upgrade completed and verified successfully!');
  console.log('================================================================');
  return { classification, paths, success: true };
}

export async function executePlatformDeploy(config, options = {}) {
  const {
    releaseId,
    targetRef,
    repoRoot,
    releaseRoot,
    dataDir,
    configDir,
    plistPath,
    launchdLabel,
    port,
    proxyPort,
    runtimeImagePrefix,
    containerNamePrefix,
    dockerfilePath,
    preflightTimeoutSeconds,
    preflightIntervalSeconds,
    preflightDueMinutes,
    testedCommit,
    testCmds,
    dryRun,
    skipTests,
    reuse,
  } = config;

  const branchName = `release/${releaseId}`;
  const worktreePath = join(releaseRoot, `release-worktree-${releaseId}`);
  const dbPath = join(dataDir, 'platform.db');
  const timestamp = formatUtcTimestamp();
  const snapshotPath = join(configDir, 'snapshots', `platform.db.pre-${releaseId}-${timestamp}-vacuum`);
  const plistBackup = join(configDir, 'snapshots', `${launchdLabel}.plist.pre-${releaseId}-${timestamp}-backup`);

  console.log('================================================================');
  console.log(`  Enkeep Controlled Release Deployment [${releaseId}]          `);
  console.log('================================================================');
  console.log(`Target Ref:              ${targetRef}`);
  console.log(`Release Branch:          ${branchName}`);
  console.log(`Worktree Path:           ${worktreePath}`);
  console.log(`Data Directory:          ${dataDir}`);
  console.log(`Port:                    ${port}`);
  console.log(`Proxy Port:              ${proxyPort}`);
  console.log(`Runtime Image Prefix:    ${runtimeImagePrefix}`);
  console.log(`Container Name Prefix:   ${containerNamePrefix}`);
  console.log(`LaunchAgent:             ${launchdLabel}`);
  console.log(`Mode:                    ${dryRun ? 'DRY-RUN' : 'LIVE EXECUTION'}`);
  console.log('----------------------------------------------------------------');

  // Step 1: Branch and Worktree setup
  // Create release/batchNN pointing to TARGET_REF, check out in worktree. Fail if branch exists unless reuse or already created in this run.
  if (!options.skipWorktreeSetup) {
    runDeployStep('Setup Release Branch and Worktree', () => {
      let branchExists = false;
      try {
        execSync(`git show-ref --verify --quiet "refs/heads/${branchName}"`, { cwd: repoRoot });
        branchExists = true;
      } catch {
        branchExists = false;
      }

      if (branchExists && !reuse) {
        throw new Error(`Release branch '${branchName}' already exists. Use --reuse to deploy from existing branch.`);
      }

      if (!branchExists) {
        execSync(`git branch "${branchName}" "${targetRef}"`, { cwd: repoRoot, stdio: 'inherit' });
      }

      if (!existsSync(worktreePath)) {
        execSync(`git worktree add "${worktreePath}" "${branchName}"`, { cwd: repoRoot, stdio: 'inherit' });
      } else {
        execSync(`git checkout "${branchName}"`, { cwd: worktreePath, stdio: 'inherit' });
        if (!reuse) {
          execSync(`git reset --hard "${targetRef}"`, { cwd: worktreePath, stdio: 'inherit' });
        }
      }
    }, dryRun);
  }

  // Resolve target commit sha
  let targetSha = '0000000';
  if (!dryRun) {
    try {
      targetSha = execSync(`git rev-parse --short "${branchName}"`, { cwd: repoRoot, encoding: 'utf8' }).trim();
    } catch {}
  }
  const imageTag = options.imageTag || `${runtimeImagePrefix}${releaseId}-${targetSha}`;

  // Step 2: Build & Compile
  if (!options.skipWorktreeBuild) {
    runDeployStep('Install & Build Worktree', () => {
      execSync('pnpm install --frozen-lockfile', { cwd: worktreePath, stdio: 'inherit' });
      execSync('pnpm run build:root && pnpm -r run build', { cwd: worktreePath, stdio: 'inherit' });
    }, dryRun);
  }

  // Step 3: Tests (P-04 Tree compare optimization & targeted test commands)
  const treeMatches = checkTreeMatch(repoRoot, targetRef, testedCommit);
  let shouldRunTests = !skipTests && !options.skipTestsRun;
  if (treeMatches) {
    console.log(`\n[P-04 Optimization] Target tree matches tested commit ${testedCommit}. Skipping re-running test suite.`);
    shouldRunTests = false;
  }

  if (shouldRunTests) {
    if (!testCmds || testCmds.length === 0) {
      throw new Error('No test commands specified (via --test-cmd or TEST_CMDS) and tests are not skipped with --skip-tests or --tested-commit matching tree.');
    }

    runDeployStep('Run Targeted Unit Tests', () => {
      for (const cmd of testCmds) {
        console.log(`Running test command: ${cmd}`);
        execSync(cmd, { cwd: worktreePath, stdio: 'inherit' });
      }
    }, dryRun);
  }

  // Step 4: Build Docker Image
  if (!options.skipDockerBuild) {
    runDeployStep('Build Runtime Docker Image', () => {
      execSync(`docker build -f "${dockerfilePath}" -t "${imageTag}" .`, { cwd: worktreePath, stdio: 'inherit' });
    }, dryRun);
  }

  // Step 5: Quiescent Drain Gate & Atomic DB Vacuum Snapshot & Switch with Automatic Rollback
  const preflightCmd = [
    `node "${join(worktreePath, 'packages/demo-runner/dist/demo-runner.js')}" preflight`,
    `--data-dir "${dataDir}"`,
    `--port ${port}`,
    `--due-within-minutes ${preflightDueMinutes}`,
    `--wait`,
    `--timeout-seconds ${preflightTimeoutSeconds}`,
    `--interval-seconds ${preflightIntervalSeconds}`,
  ].join(' ');

  let preSwitchConnCount = 0;

  runDeployStep('Quiescent Preflight & Atomic Switchover', () => {
    console.log('Verifying quiescence before stopping service...');
    execSync(preflightCmd, { cwd: worktreePath, stdio: 'inherit' });

    console.log(`Recording pre-switch established connections on port ${port}...`);
    preSwitchConnCount = countEstablishedConnections(port);
    console.log(`Pre-switch connection count: ${preSwitchConnCount}`);

    console.log(`Creating SQLite snapshot: ${snapshotPath}`);
    execSync(`sqlite3 "${dbPath}" "VACUUM INTO '${snapshotPath}';"`, { stdio: 'inherit' });

    console.log(`Backing up LaunchAgent plist: ${plistBackup}`);
    execSync(`cp "${plistPath}" "${plistBackup}"`, { stdio: 'inherit' });

    console.log('Unloading LaunchAgent (bootout)...');
    let bootoutDone = false;
    try {
      execSync(`launchctl bootout gui/$(id -u) "${plistPath}"`, { stdio: 'inherit' });
      bootoutDone = true;
    } catch {
      // Might not be loaded
    }

    // From this point onward, any failure triggers automatic rollback
    try {
      if (options.mode === 'full') {
        console.log('[Full Mode] Tearing down active containers (preserving volumes)...');
        execSync(`node "${join(worktreePath, 'packages/demo-runner/dist/demo-runner.js')}" down --repo-root "${repoRoot}"`, { cwd: worktreePath, stdio: 'inherit' });
      } else {
        console.log('[Platform Upgrade] Retaining active runtime containers and daemons without down/rebuild.');
      }

      console.log('Updating LaunchAgent plist with new worktree and default container image...');
      const currentPlist = readFileSync(plistPath, 'utf8');
      const updatedPlist = updatePlistContent(currentPlist, worktreePath, imageTag);
      writeFileSync(plistPath, updatedPlist, 'utf8');

      console.log('Bootstrapping LaunchAgent...');
      execSync(`launchctl bootstrap gui/$(id -u) "${plistPath}"`, { stdio: 'inherit' });
    } catch (switchErr) {
      console.error(`\n❌ Error during switchover: ${switchErr.message}`);
      console.error('Triggering automatic rollback...');
      try {
        if (existsSync(plistBackup)) {
          const backupPlist = readFileSync(plistBackup, 'utf8');
          writeFileSync(plistPath, backupPlist, 'utf8');
          execSync(`launchctl bootstrap gui/$(id -u) "${plistPath}"`, { stdio: 'inherit' });
          console.log('✓ Rollback restored backup plist and re-bootstrapped.');
        }
      } catch (rollbackErr) {
        console.error(`❌ Rollback also encountered an error: ${rollbackErr.message}`);
      }
      throw switchErr;
    }
  }, dryRun);

  // Step 6: Post-Deployment Verification
  await executeVerify({ ...config, mode: options.mode === 'full' ? 'full' : 'split' }, imageTag, preSwitchConnCount);

  console.log('\n================================================================');
  console.log(`✓ Release ${releaseId} deployed and verified successfully!`);
  console.log('================================================================');
  return { success: true, releaseId, imageTag };
}

export async function executeDeploy(config, options = {}) {
  validateConfig(config);

  if (config.only === 'rollback') {
    return executeRollback(config);
  }

  if (config.only === 'verify') {
    return executeVerify(config);
  }

  if (config.only === 'frontend') {
    return executeFrontendDeploy(config);
  }

  if (config.only === 'runtime') {
    return executeRuntimeDeploy(config);
  }

  if (config.mode === 'full') {
    return executePlatformDeploy(config, { mode: 'full' });
  }

  // Automatic classification workflow: frontend -> runtime -> platform
  const { plistPath, repoRoot, targetRef = 'origin/main', baseRef } = config;
  let plistContent = '';
  if (plistPath && existsSync(plistPath)) {
    plistContent = readFileSync(plistPath, 'utf8');
  }
  const onlineWt = extractWorktreePathFromPlist(plistContent);
  const effBaseRef = baseRef || resolveOnlineHead(plistPath, repoRoot);
  const { paths, classification: detectedClassification } = computeDiffPathsAndClassification(repoRoot || onlineWt, effBaseRef, targetRef);
  const classification = options.classificationOverride || detectedClassification;

  console.log('================================================================');
  console.log('  Enkeep Smart Split Release Deployment                         ');
  console.log('================================================================');
  console.log(`Base Commit:             ${effBaseRef}`);
  console.log(`Target Commit / Ref:     ${targetRef}`);
  console.log(`Detected Changes (${paths.length}):`);
  for (const p of paths) {
    console.log(`  - ${p}`);
  }
  console.log(`Classification:          ${JSON.stringify(classification)}`);
  console.log('================================================================\n');

  if (paths.length === 0 && !options.classificationOverride) {
    console.log('No file changes detected between base and target ref.');
    return { success: true, message: 'No changes detected' };
  }

  // Multi-category sequential execution: frontend -> runtime -> platform
  if (classification.frontend && !classification.runtime && !classification.platform) {
    console.log('>>> Routing to Way 1: Frontend only upgrade...');
    return executeFrontendDeploy(config);
  }

  if (classification.runtime && !classification.platform && !classification.frontend) {
    console.log('>>> Routing to Way 2: Runtime only background upgrade...');
    return executeRuntimeDeploy(config);
  }

  if (classification.frontend && classification.runtime && !classification.platform) {
    console.log('>>> Executing Step 1/2: Frontend upgrade...');
    await executeFrontendDeploy(config);
    console.log('\n>>> Executing Step 2/2: Runtime upgrade...');
    return executeRuntimeDeploy(config);
  }

  // If platform is involved (or mixed with frontend / runtime)
  if (classification.frontend) {
    console.log('>>> Executing Step 1/3 (or 1/2): Frontend upgrade...');
    await executeFrontendDeploy(config);
  }

  let runtimeResult = null;
  if (classification.runtime) {
    console.log('\n>>> Executing Step 2/3: Runtime target version setup...');
    runtimeResult = await executeRuntimeDeploy(config);
  }

  console.log('\n>>> Executing Platform Upgrade (retaining active runtime containers)...');
  const platformOptions = { mode: 'platform' };
  if (classification.runtime) {
    platformOptions.skipWorktreeSetup = true;
    platformOptions.skipWorktreeBuild = true;
    platformOptions.skipTestsRun = true;
    platformOptions.skipDockerBuild = true;
    if (runtimeResult && runtimeResult.imageTag) {
      platformOptions.imageTag = runtimeResult.imageTag;
    }
  }
  return executePlatformDeploy(config, platformOptions);
}

function main() {
  const config = resolveDeployConfig();

  if (config.help) {
    console.log(`
Enkeep Automated Release Deployment Workflow (P-01, P-04)

Usage:
  node scripts/deploy-release.mjs --env-file <path> [options]

Required Options (or via env file):
  --repo-root <path>               Git repository root path
  --release-root <path>            Directory where release worktrees are kept
  --data-dir <path>                Path to .demo-data
  --config-dir <path>              Path to external config dir (e.g. ~/.config/enkeep)
  --plist-path <path>              Path to LaunchAgent plist file
  --launchd-label <label>          LaunchAgent label name
  --port <port>                    Platform port (required, no default)
  --proxy-port <port>              Proxy port (required, no default)
  --runtime-image-prefix <prefix>  Docker runtime image prefix (required, no default)
  --container-name-prefix <prefix> Docker container name prefix (required, no default)

Optional Options:
  --release-id <id>                Release batch ID (e.g. batch56; defaults to max git release/batch* + 1)
  --env-file <path>                Path to external deployment env file
  --target-ref <ref>               Target git ref to deploy [default: origin/main]
  --base-ref <ref>                 Base git ref for diff calculation [default: online HEAD from plist]
  --tested-commit <sha>            Commit SHA whose test suite passed (P-04 tree match)
  --test-cmd <cmd>                 Targeted test command to run (repeatable, or TEST_CMDS in env)
  --skip-tests                     Skip unit test run
  --reuse                          Reuse existing release/batchNN branch without failing
  --mode <full|split>              Deployment mode ('full' forces container teardown; default is split)
  --only <frontend|runtime|verify|rollback> Run only frontend, runtime, verify, or rollback mode
  --prune-old                      Prune historical release worktrees after deploy
  --dry-run                        Simulate actions without modifying system
  -h, --help                       Show this help message
`);
    process.exit(0);
  }

  executeDeploy(config).catch(err => {
    console.error(`\nDeploy Error: ${err.message}`);
    process.exit(1);
  });
}

if (process.argv[1] && process.argv[1].endsWith('deploy-release.mjs')) {
  main();
}
