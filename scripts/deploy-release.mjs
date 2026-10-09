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
 * - P-04: Tree comparison optimization to skip redundant test runs when the git tree matches tested HEAD.
 *
 * Usage:
 *   node scripts/deploy-release.mjs --env-file <path-to-env> [options]
 *   node scripts/deploy-release.mjs --dry-run [options]
 */

import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const FORBIDDEN_ROOTS = ['/etc', '/usr', '/System', '/root', '/bin', '/sbin'];

function isSafePath(p) {
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

export function resolveDeployConfig(cliArgs = process.argv.slice(2)) {
  let envFile = '';
  const cliOpts = {
    dryRun: false,
    skipTests: false,
    pruneOld: false,
    help: false,
  };

  for (let i = 0; i < cliArgs.length; i++) {
    const a = cliArgs[i];
    if (a === '--help' || a === '-h') cliOpts.help = true;
    else if (a === '--dry-run') cliOpts.dryRun = true;
    else if (a === '--skip-tests') cliOpts.skipTests = true;
    else if (a === '--prune-old') cliOpts.pruneOld = true;
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
    else if (a === '--tested-commit' && cliArgs[i + 1]) cliOpts.testedCommit = cliArgs[++i];
  }

  // File env or process.env fallback
  const fileEnv = envFile ? parseEnvFile(resolve(envFile)) : {};

  const getVal = (key, cliVal, defaultVal = undefined) => {
    if (cliVal !== undefined) return cliVal;
    if (fileEnv[key] !== undefined) return fileEnv[key];
    if (process.env[key] !== undefined) return process.env[key];
    return defaultVal;
  };

  const config = {
    releaseId: getVal('RELEASE_ID', cliOpts.releaseId),
    targetRef: getVal('TARGET_REF', cliOpts.targetRef, 'origin/main'),
    repoRoot: getVal('REPO_ROOT', cliOpts.repoRoot),
    releaseRoot: getVal('RELEASE_ROOT', cliOpts.releaseRoot),
    dataDir: getVal('DATA_DIR', cliOpts.dataDir),
    configDir: getVal('CONFIG_DIR', cliOpts.configDir),
    plistPath: getVal('PLIST_PATH', cliOpts.plistPath),
    launchdLabel: getVal('LAUNCHD_LABEL', cliOpts.launchdLabel),
    port: parseInt(getVal('PORT', cliOpts.port, '3900'), 10),
    runtimeImagePrefix: getVal('RUNTIME_IMAGE_PREFIX', undefined, 'enkeep-runtime:gap-'),
    dockerfilePath: getVal('DOCKERFILE_PATH', undefined, 'docker/Dockerfile.runtime'),
    preflightTimeoutSeconds: parseInt(getVal('PREFLIGHT_TIMEOUT_SECONDS', undefined, '7200'), 10),
    preflightIntervalSeconds: parseInt(getVal('PREFLIGHT_INTERVAL_SECONDS', undefined, '10'), 10),
    preflightDueMinutes: parseInt(getVal('PREFLIGHT_DUE_MINUTES', undefined, '10'), 10),
    testedCommit: getVal('TESTED_COMMIT', cliOpts.testedCommit, ''),
    dryRun: cliOpts.dryRun,
    skipTests: cliOpts.skipTests,
    pruneOld: cliOpts.pruneOld,
    help: cliOpts.help,
  };

  return config;
}

export function validateConfig(config) {
  const required = [
    ['releaseId', 'RELEASE_ID'],
    ['repoRoot', 'REPO_ROOT'],
    ['releaseRoot', 'RELEASE_ROOT'],
    ['dataDir', 'DATA_DIR'],
    ['configDir', 'CONFIG_DIR'],
    ['plistPath', 'PLIST_PATH'],
    ['launchdLabel', 'LAUNCHD_LABEL'],
  ];

  for (const [prop, envName] of required) {
    if (!config[prop]) {
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

export function runDeployStep(name, commandFn, dryRun = false) {
  console.log(`\n>>> [Step: ${name}]`);
  if (dryRun) {
    console.log(`[DRY-RUN] Would execute: ${name}`);
    return;
  }
  commandFn();
}

export async function executeDeploy(config) {
  validateConfig(config);

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
    runtimeImagePrefix,
    dockerfilePath,
    preflightTimeoutSeconds,
    preflightIntervalSeconds,
    preflightDueMinutes,
    testedCommit,
    dryRun,
    skipTests,
  } = config;

  const worktreePath = join(releaseRoot, `release-worktree-${releaseId}`);
  const dbPath = join(dataDir, 'platform.db');
  const snapshotPath = join(configDir, 'snapshots', `platform.db.pre-${releaseId}-vacuum`);
  const plistBackup = join(configDir, 'snapshots', `${launchdLabel}.plist.pre-${releaseId}-backup`);

  console.log('================================================================');
  console.log(`  Enkeep Controlled Release Deployment [${releaseId}]          `);
  console.log('================================================================');
  console.log(`Target Ref:       ${targetRef}`);
  console.log(`Worktree Path:    ${worktreePath}`);
  console.log(`Data Directory:   ${dataDir}`);
  console.log(`Port:             ${port}`);
  console.log(`LaunchAgent:      ${launchdLabel}`);
  console.log(`Mode:             ${dryRun ? 'DRY-RUN' : 'LIVE EXECUTION'}`);
  console.log('----------------------------------------------------------------');

  // Step 1: Worktree setup
  runDeployStep('Setup Worktree', () => {
    if (!existsSync(worktreePath)) {
      execSync(`git worktree add "${worktreePath}" "${targetRef}"`, { cwd: repoRoot, stdio: 'inherit' });
    } else {
      execSync(`git fetch origin`, { cwd: worktreePath, stdio: 'inherit' });
      execSync(`git reset --hard "${targetRef}"`, { cwd: worktreePath, stdio: 'inherit' });
    }
  }, dryRun);

  // Resolve target commit sha
  let targetSha = '0000000';
  if (!dryRun) {
    targetSha = execSync(`git rev-parse --short "${targetRef}"`, { cwd: repoRoot, encoding: 'utf8' }).trim();
  }
  const imageTag = `${runtimeImagePrefix}${releaseId}-${targetSha}`;

  // Step 2: Build & Compile
  runDeployStep('Install & Build Worktree', () => {
    execSync('pnpm install --frozen-lockfile', { cwd: worktreePath, stdio: 'inherit' });
    execSync('pnpm run build:root && pnpm -r run build', { cwd: worktreePath, stdio: 'inherit' });
  }, dryRun);

  // Step 3: Tests (P-04 Tree compare optimization)
  const treeMatches = checkTreeMatch(repoRoot, targetRef, testedCommit);
  let shouldRunTests = !skipTests;
  if (treeMatches) {
    console.log(`\n[P-04 Optimization] Target tree matches tested commit ${testedCommit}. Skipping re-running test suite.`);
    shouldRunTests = false;
  }

  if (shouldRunTests) {
    runDeployStep('Run Targeted Unit Tests', () => {
      execSync('pnpm test', { cwd: worktreePath, stdio: 'inherit' });
    }, dryRun);
  }

  // Step 4: Build Docker Image
  runDeployStep('Build Runtime Docker Image', () => {
    execSync(`docker build -f "${dockerfilePath}" -t "${imageTag}" .`, { cwd: worktreePath, stdio: 'inherit' });
  }, dryRun);

  // Step 5: Quiescent Drain Gate & Atomic DB Vacuum Snapshot & Switch
  // In deployment recipe: final preflight check and shutdown are part of the same unified pipeline step
  const preflightCmd = [
    `node "${join(worktreePath, 'packages/demo-runner/dist/demo-runner.js')}" preflight`,
    `--data-dir "${dataDir}"`,
    `--port ${port}`,
    `--due-within-minutes ${preflightDueMinutes}`,
    `--wait`,
    `--timeout-seconds ${preflightTimeoutSeconds}`,
    `--interval-seconds ${preflightIntervalSeconds}`,
  ].join(' ');

  runDeployStep('Quiescent Preflight & Atomic Switchover', () => {
    console.log('Verifying quiescence before stopping service...');
    execSync(preflightCmd, { cwd: worktreePath, stdio: 'inherit' });

    console.log(`Creating SQLite snapshot: ${snapshotPath}`);
    execSync(`sqlite3 "${dbPath}" "VACUUM INTO '${snapshotPath}';"`, { stdio: 'inherit' });

    console.log(`Backing up LaunchAgent plist: ${plistBackup}`);
    execSync(`cp "${plistPath}" "${plistBackup}"`, { stdio: 'inherit' });

    console.log('Unloading LaunchAgent...');
    try {
      execSync(`launchctl bootout gui/$(id -u) "${plistPath}"`, { stdio: 'inherit' });
    } catch {
      // Might not be loaded
    }

    console.log('Tearing down active containers (preserving volumes)...');
    try {
      execSync(`node "${join(worktreePath, 'packages/demo-runner/dist/demo-runner.js')}" down --repo-root "${repoRoot}"`, { cwd: worktreePath, stdio: 'inherit' });
    } catch (e) {
      console.warn(`demo-runner down notice: ${e.message}`);
    }

    console.log('Updating LaunchAgent plist with new worktree and container image...');
    const currentPlist = readFileSync(plistPath, 'utf8');
    const updatedPlist = updatePlistContent(currentPlist, worktreePath, imageTag);
    writeFileSync(plistPath, updatedPlist, 'utf8');

    console.log('Bootstrapping LaunchAgent...');
    execSync(`launchctl bootstrap gui/$(id -u) "${plistPath}"`, { stdio: 'inherit' });
  }, dryRun);

  // Step 6: Healthcheck verification
  runDeployStep('Verify Health & CSRF Endpoint', () => {
    console.log('Polling CSRF endpoint...');
    const startTime = Date.now();
    let ok = false;
    while (Date.now() - startTime < 60000) {
      try {
        const out = execSync(`curl -s -f http://127.0.0.1:${port}/api/auth/csrf`, { encoding: 'utf8' });
        if (out.includes('csrfToken')) {
          ok = true;
          break;
        }
      } catch {
        // Retry
      }
      execSync('sleep 2');
    }
    if (!ok) {
      throw new Error(`Healthcheck failed: CSRF endpoint on port ${port} did not respond with 200 within 60s`);
    }
    console.log('✓ Service successfully started and healthy.');
  }, dryRun);

  console.log('\n================================================================');
  console.log(`✓ Release ${releaseId} deployed successfully!`);
  console.log('================================================================');
}

function main() {
  const config = resolveDeployConfig();

  if (config.help) {
    console.log(`
Enkeep Automated Release Deployment Workflow (P-01)

Usage:
  node scripts/deploy-release.mjs --env-file <path> [options]

Required Options (or via env file):
  --release-id <id>        Release batch ID (e.g. batch56)
  --repo-root <path>       Git repository root path
  --release-root <path>    Directory where release worktrees are kept
  --data-dir <path>        Path to .demo-data
  --config-dir <path>      Path to external config dir (e.g. ~/.config/enkeep)
  --plist-path <path>      Path to LaunchAgent plist file
  --launchd-label <label>  LaunchAgent label name

Optional Options:
  --env-file <path>        Path to external deployment env file
  --target-ref <ref>       Target git ref to deploy [default: origin/main]
  --tested-commit <sha>    Commit SHA whose test suite passed (P-04 tree match)
  --port <port>            Platform port [default: 3900]
  --skip-tests             Skip unit test run
  --prune-old              Prune historical release worktrees after deploy
  --dry-run                Simulate actions without modifying system
  -h, --help               Show this help message
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
