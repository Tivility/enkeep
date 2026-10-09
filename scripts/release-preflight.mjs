#!/usr/bin/env node
/**
 * scripts/release-preflight.mjs
 * 
 * Read-only preflight verification helper for Enkeep releases and rollback safety chain (G15).
 * Validates isolated release worktrees, built dist artifacts, safe boundaries, and database readiness.
 *
 * Usage:
 *   node enkeep/scripts/release-preflight.mjs --release-id batch4
 *   node enkeep/scripts/release-preflight.mjs --test-fixture
 *   node enkeep/scripts/release-preflight.mjs --help
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const WORKSPACE_ROOT = resolve(__dirname, '../..');

// Safety Constants
const FORBIDDEN_ROOTS = ['/etc', '/var', '/usr', '/System', '/root', '/bin', '/sbin'];
const REQUIRED_DIST_FILES = [
  'packages/demo-runner/dist/demo-runner.js',
  'packages/platform-server/dist/index.js',
  'packages/dsh-tools/dist/index.js',
  'packages/dsh-memory/dist/index.js',
];

function isSafePath(p) {
  const resolved = resolve(p);
  for (const f of FORBIDDEN_ROOTS) {
    if (resolved === f || resolved.startsWith(f + '/')) {
      return { safe: false, reason: `Path resides in forbidden system root: ${f}` };
    }
  }
  return { safe: true };
}

export function verifyReleaseManifest(options = {}) {
  const releaseId = options.releaseId || 'batch4';
  const report = {
    ok: true,
    timestamp: new Date().toISOString(),
    releaseId,
    checks: [],
    errors: [],
    plannedOperations: {},
  };

  const addCheck = (name, passed, message, meta = null) => {
    report.checks.push({ name, passed, message, ...(meta ? { meta } : {}) });
    if (!passed) {
      report.ok = false;
      report.errors.push(`[${name}] ${message}`);
    }
  };

  const repoRoot = options.repoRoot ? resolve(options.repoRoot) : REPO_ROOT;
  const pathSafety = isSafePath(repoRoot);
  if (!pathSafety.safe) {
    addCheck('repoRootSafety', false, pathSafety.reason);
    return report;
  }
  addCheck('repoRootSafety', true, `Repo root is safe: ${repoRoot}`);

  // Check enkeep package.json
  const pkgPath = join(repoRoot, 'package.json');
  if (!existsSync(pkgPath)) {
    addCheck('repoRootValid', false, `Missing package.json in ${repoRoot}`);
  } else {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      addCheck('repoRootValid', true, `Found repo root for package: ${pkg.name || 'enkeep'}`);
    } catch (e) {
      addCheck('repoRootValid', false, `Invalid package.json in ${repoRoot}: ${e.message}`);
    }
  }

  // Check .demo-data
  const demoDataDir = options.demoDataDir ? resolve(options.demoDataDir) : join(repoRoot, '.demo-data');
  if (!existsSync(demoDataDir)) {
    addCheck('demoDataDir', false, `Demo data directory not found at: ${demoDataDir}`);
  } else {
    addCheck('demoDataDir', true, `Demo data directory verified: ${demoDataDir}`);
  }

  // Check platform.db
  const dbPath = options.dbPath ? resolve(options.dbPath) : join(demoDataDir, 'platform.db');
  if (!existsSync(dbPath)) {
    addCheck('platformDb', false, `platform.db not found at: ${dbPath}`);
  } else {
    const st = statSync(dbPath);
    addCheck('platformDb', true, `platform.db exists (${st.size} bytes)`);
  }

  // Check Worktree / Dist
  const worktreePath = options.worktree
    ? resolve(options.worktree)
    : join(WORKSPACE_ROOT, 'reports/hc-vs-enkeep/implementation', `release-worktree-${releaseId}`);

  if (!existsSync(worktreePath)) {
    addCheck('releaseWorktree', false, `Release worktree not found: ${worktreePath}`);
  } else {
    addCheck('releaseWorktree', true, `Release worktree found: ${worktreePath}`);

    // Verify critical dist artifacts
    let allDists = true;
    for (const rel of REQUIRED_DIST_FILES) {
      const fullDist = join(worktreePath, rel);
      if (!existsSync(fullDist)) {
        addCheck(`distArtifact:${rel}`, false, `Missing built artifact: ${rel}`);
        allDists = false;
      }
    }
    if (allDists) {
      addCheck('distArtifacts', true, `All ${REQUIRED_DIST_FILES.length} required dist artifacts exist`);
    }
  }

  // Construct Planned Operations
  const imageTag = options.imageTag || `enkeep-runtime:gap-${releaseId}`;
  const port = options.port || 3900;
  const configDir = options.configDir || process.env.ENKEEP_CONFIG_DIR || join(homedir(), '.config/enkeep');

  report.plannedOperations = {
    preflightVacuumCommand: `sqlite3 ${dbPath} "VACUUM INTO '${configDir}/snapshots/platform.db.pre-${releaseId}-vacuum';"`,
    startupCommand: [
      `ENKEEP_RUNTIME_IMAGE=${imageTag}`,
      `ENKEEP_PIPELINE_MANIFEST=${configDir}/pipeline-task-capabilities.json`,
      `DSH_WEB_URL=http://127.0.0.1:3080`,
      `node ${join(worktreePath, 'packages/demo-runner/dist/demo-runner.js')} up --port ${port} --network-mode none --allow-host --repo-root ${repoRoot}`,
    ].join(' \\\n  '),
    quiescenceCheckQueries: [
      `SELECT count(*) FROM turn_runs WHERE status = 'running';`,
      `SELECT count(*) FROM turn_execution_queue;`,
      `SELECT count(*) FROM task_runs WHERE status IN ('running', 'claimed');`,
      `SELECT count(*) FROM session_execution_leases WHERE status = 'active';`,
    ],
    smokeHealthEndpoints: [
      `curl -s -i http://127.0.0.1:${port}/`,
      `curl -s http://127.0.0.1:${port}/api/auth/csrf`,
      `node reports/hc-vs-enkeep/bench/ek.mjs login`,
      `node reports/hc-vs-enkeep/bench/ek.mjs spaces`,
      `curl -s -i http://127.0.0.1:${port + 1}/`,
    ],
  };

  return report;
}

export function runFixtureTests() {
  console.log('Running Generic Local Fixture Tests for Release Preflight (enkeep/scripts)...');
  let passCount = 0;
  let totalCount = 0;

  function assert(cond, desc) {
    totalCount++;
    if (cond) {
      passCount++;
      console.log(`  ✓ ${desc}`);
    } else {
      console.error(`  ✗ FAIL: ${desc}`);
    }
  }

  // Test 1: Forbidden path detection
  assert(isSafePath('/etc/passwd').safe === false, 'Detects /etc/passwd as forbidden');
  assert(isSafePath('/var/run/docker.sock').safe === false, 'Detects /var/run as forbidden');
  assert(isSafePath(REPO_ROOT).safe === true, 'Allows valid repo path');

  // Test 2: Validation of known existing batch3 worktree
  const b3Report = verifyReleaseManifest({ releaseId: 'batch3' });
  assert(b3Report.plannedOperations.startupCommand.includes('release-worktree-batch3'), 'Generates batch3 startup command');
  assert(b3Report.checks.some(c => c.name === 'repoRootValid' && c.passed), 'Validates repoRootValid');
  assert(b3Report.ok === true, 'Batch3 worktree preflight passes all required checks');

  // Test 3: Validation of known existing batch4 worktree
  const b4Report = verifyReleaseManifest({ releaseId: 'batch4' });
  assert(b4Report.plannedOperations.startupCommand.includes('release-worktree-batch4'), 'Generates batch4 startup command');
  assert(b4Report.ok === true, 'Batch4 worktree preflight passes all required checks');

  // Test 4: Missing worktree failure behavior
  const nonExistReport = verifyReleaseManifest({ releaseId: 'nonexistent-batch-xyz' });
  assert(nonExistReport.ok === false, 'Fails ok gate on nonexistent release worktree');
  assert(nonExistReport.errors.length > 0, 'Populates errors array on failure');

  console.log(`\nFixture test results: ${passCount}/${totalCount} passed.`);
  return passCount === totalCount;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    releaseId: 'batch4',
    json: false,
    testFixture: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') options.help = true;
    else if (a === '--test-fixture') options.testFixture = true;
    else if (a === '--json') options.json = true;
    else if (a === '--release-id' && args[i + 1]) options.releaseId = args[++i];
    else if (a === '--worktree' && args[i + 1]) options.worktree = args[++i];
    else if (a === '--repo-root' && args[i + 1]) options.repoRoot = args[++i];
    else if (a === '--image-tag' && args[i + 1]) options.imageTag = args[++i];
  }

  return options;
}

function main() {
  const opts = parseArgs();

  if (opts.help) {
    console.log(`
Enkeep Release Preflight Verification Tool

Options:
  --release-id <id>    Release ID (e.g. batch4, batch3, batch2) [default: batch4]
  --worktree <path>    Path to isolated release worktree
  --repo-root <path>   Path to enkeep repo root [default: ./enkeep]
  --image-tag <tag>    Docker runtime image tag
  --json               Output raw JSON report
  --test-fixture       Run local test suite and exit
  -h, --help           Show this help message
`);
    process.exit(0);
  }

  if (opts.testFixture) {
    const success = runFixtureTests();
    process.exit(success ? 0 : 1);
  }

  const report = verifyReleaseManifest(opts);

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.ok ? 0 : 1);
  }

  console.log('================================================================');
  console.log(`  Enkeep Release Preflight & Safety Verification [${report.releaseId}]  `);
  console.log('================================================================\n');

  console.log('--- Checks ---');
  for (const c of report.checks) {
    const icon = c.passed ? '✓' : '✗';
    console.log(`[${icon}] ${c.name}: ${c.message}`);
  }

  if (report.errors.length > 0) {
    console.log('\n--- Errors ---');
    for (const err of report.errors) {
      console.log(`! ${err}`);
    }
  }

  console.log('\n--- Planned Operations & Commands ---');
  console.log(`[Database Snapshot]\n  ${report.plannedOperations.preflightVacuumCommand}\n`);
  console.log(`[Launch Command]\n  ${report.plannedOperations.startupCommand}\n`);
  console.log('[Quiescence Verification SQL]');
  for (const q of report.plannedOperations.quiescenceCheckQueries) {
    console.log(`  ${q}`);
  }
  console.log('\n[Smoke Healthcheck Probes]');
  for (const p of report.plannedOperations.smokeHealthEndpoints) {
    console.log(`  ${p}`);
  }

  console.log('\n================================================================');
  if (report.ok) {
    console.log('✓ Preflight PASSED. Ready for explicit manual operator deployment.');
  } else {
    console.log('✗ Preflight FAILED. Rectify errors before attempting release.');
  }
  console.log('================================================================');

  process.exit(report.ok ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
