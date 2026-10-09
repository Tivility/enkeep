#!/usr/bin/env node
/**
 * scripts/prune-release-worktrees.mjs
 *
 * Prunes historical release worktrees in a designated directory,
 * preserving the most recent N worktrees and protecting any actively referenced worktree.
 *
 * Fully parameterized with zero machine defaults (AGENTS.md §3).
 *
 * Usage:
 *   node scripts/prune-release-worktrees.mjs --release-root <path> --repo-root <path> [--keep <n>] [--active-worktree <path>] [--dry-run]
 */

import { existsSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execSync } from 'node:child_process';

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

export function parseArgs(rawArgs) {
  const opts = {
    releaseRoot: process.env.ENKEEP_RELEASE_ROOT || '',
    repoRoot: process.env.ENKEEP_REPO_ROOT || '',
    keep: parseInt(process.env.ENKEEP_KEEP_WORKTREES || '3', 10),
    activeWorktree: process.env.ENKEEP_ACTIVE_WORKTREE || '',
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--release-root' && rawArgs[i + 1]) opts.releaseRoot = rawArgs[++i];
    else if (a === '--repo-root' && rawArgs[i + 1]) opts.repoRoot = rawArgs[++i];
    else if (a === '--active-worktree' && rawArgs[i + 1]) opts.activeWorktree = rawArgs[++i];
    else if (a === '--keep' && rawArgs[i + 1]) opts.keep = parseInt(rawArgs[++i], 10);
  }

  return opts;
}

export function planPruneWorktrees(options) {
  const { releaseRoot, repoRoot, keep, activeWorktree } = options;

  if (!releaseRoot) {
    throw new Error('Missing required parameter: --release-root (or ENKEEP_RELEASE_ROOT)');
  }
  if (!repoRoot) {
    throw new Error('Missing required parameter: --repo-root (or ENKEEP_REPO_ROOT)');
  }
  if (isNaN(keep) || keep < 1) {
    throw new Error('--keep must be a positive integer');
  }

  const safeCheck = isSafePath(releaseRoot);
  if (!safeCheck.safe) {
    throw new Error(safeCheck.reason);
  }

  const resolvedReleaseRoot = resolve(releaseRoot);
  const resolvedRepoRoot = resolve(repoRoot);

  if (!existsSync(resolvedReleaseRoot)) {
    throw new Error(`Release root directory does not exist: ${resolvedReleaseRoot}`);
  }
  if (!existsSync(resolvedRepoRoot)) {
    throw new Error(`Repo root directory does not exist: ${resolvedRepoRoot}`);
  }

  // Active worktree canonical path resolution
  let resolvedActive = '';
  if (activeWorktree) {
    try {
      resolvedActive = resolve(activeWorktree);
      if (existsSync(resolvedActive)) {
        resolvedActive = realpathSync(resolvedActive);
      }
    } catch {
      resolvedActive = resolve(activeWorktree);
    }
  }

  const entries = readdirSync(resolvedReleaseRoot, { withFileTypes: true });
  const candidates = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Release worktrees typically match release-worktree-* or similar
    if (!entry.name.startsWith('release-worktree-')) continue;

    const fullPath = join(resolvedReleaseRoot, entry.name);
    let realCandidatePath = fullPath;
    try {
      realCandidatePath = realpathSync(fullPath);
    } catch {
      // Keep fullPath
    }

    try {
      const st = statSync(fullPath);
      candidates.push({
        name: entry.name,
        path: fullPath,
        canonicalPath: realCandidatePath,
        mtimeMs: st.mtimeMs,
      });
    } catch {
      // Ignore stat failures
    }
  }

  // Sort descending by mtime (most recent first)
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const kept = [];
  const pruned = [];

  // Protect the most recent `keep` count
  for (let i = 0; i < candidates.length; i++) {
    const item = candidates[i];
    const isActive = resolvedActive && (item.canonicalPath === resolvedActive || item.path === resolvedActive);

    if (i < keep) {
      kept.push({ ...item, reason: `within-most-recent-${keep}` });
    } else if (isActive) {
      kept.push({ ...item, reason: 'protected-as-active-worktree' });
    } else {
      pruned.push(item);
    }
  }

  return {
    releaseRoot: resolvedReleaseRoot,
    repoRoot: resolvedRepoRoot,
    activeWorktree: resolvedActive,
    keepCount: keep,
    totalFound: candidates.length,
    kept,
    pruned,
  };
}

export function executePrune(plan, dryRun = false) {
  const results = {
    prunedCount: 0,
    errors: [],
    actions: [],
  };

  for (const item of plan.pruned) {
    const action = {
      path: item.path,
      command: `git worktree remove --force "${item.path}"`,
      dryRun,
    };

    if (dryRun) {
      results.actions.push(action);
      results.prunedCount++;
    } else {
      try {
        execSync(`git worktree remove --force "${item.path}"`, {
          cwd: plan.repoRoot,
          stdio: 'pipe',
        });
        results.actions.push(action);
        results.prunedCount++;
      } catch (err) {
        // Fallback if git worktree remove fails but directory still exists
        try {
          execSync(`rm -rf "${item.path}"`, { stdio: 'pipe' });
          execSync(`git worktree prune`, { cwd: plan.repoRoot, stdio: 'pipe' });
          results.actions.push({ ...action, fallbackUsed: true });
          results.prunedCount++;
        } catch (rmErr) {
          results.errors.push({ path: item.path, error: err.message, rmError: rmErr.message });
        }
      }
    }
  }

  return results;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    console.log(`
Prune Historical Release Worktrees Tool

Usage:
  node scripts/prune-release-worktrees.mjs [options]

Options:
  --release-root <path>    Path to release worktrees directory (Required)
  --repo-root <path>       Path to git repository root (Required)
  --keep <n>               Number of recent worktrees to retain (Default: 3)
  --active-worktree <path> Path to actively running release worktree to protect
  --dry-run                Print planned removals without deleting
  -h, --help               Show this message
`);
    process.exit(0);
  }

  try {
    const plan = planPruneWorktrees(opts);

    console.log('================================================================');
    console.log('  Enkeep Release Worktree Prune Plan                            ');
    console.log('================================================================');
    console.log(`Release Root:     ${plan.releaseRoot}`);
    console.log(`Repo Root:        ${plan.repoRoot}`);
    console.log(`Active Worktree:  ${plan.activeWorktree || '(none specified)'}`);
    console.log(`Keep Policy:      Keep ${plan.keepCount} most recent`);
    console.log(`Total Found:      ${plan.totalFound}`);
    console.log(`To Keep:          ${plan.kept.length}`);
    console.log(`To Prune:         ${plan.pruned.length}`);
    console.log(`Mode:             ${opts.dryRun ? 'DRY-RUN (No files modified)' : 'LIVE EXECUTION'}`);
    console.log('----------------------------------------------------------------\n');

    console.log('[Kept Worktrees]');
    for (const k of plan.kept) {
      console.log(`  ✓ ${k.name} (${k.reason})`);
    }

    console.log('\n[Worktrees To Prune]');
    for (const p of plan.pruned) {
      console.log(`  ✗ ${p.name} -> ${p.path}`);
    }

    const execution = executePrune(plan, opts.dryRun);

    console.log('\n================================================================');
    if (opts.dryRun) {
      console.log(`✓ Dry run complete. Would prune ${execution.prunedCount} worktrees.`);
    } else {
      console.log(`✓ Prune complete. Pruned ${execution.prunedCount} worktrees.`);
      if (execution.errors.length > 0) {
        console.error(`! Encountered ${execution.errors.length} errors during prune.`);
        process.exit(1);
      }
    }
    console.log('================================================================');
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].endsWith('prune-release-worktrees.mjs')) {
  main();
}
