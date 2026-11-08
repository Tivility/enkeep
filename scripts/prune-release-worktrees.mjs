#!/usr/bin/env node
/**
 * scripts/prune-release-worktrees.mjs
 *
 * Prunes historical release worktrees in a designated directory,
 * preserving the most recent N worktrees and protecting any actively referenced worktree.
 *
 * The worktree the platform's runtime target points to (runtime_target_version.daemon_cli_path
 * in <data-dir>/platform.db, read-only) is always kept, whatever --keep says: host runtimes are
 * started from it, and a platform-only release does not move the target. If the database cannot
 * be read or the stored path is not absolute, nothing is pruned. Only the current target is
 * protected: run it after every runtime has switched to that target.
 *
 * Fully parameterized with zero machine defaults (AGENTS.md §3).
 *
 * Usage:
 *   node scripts/prune-release-worktrees.mjs --release-root <path> --repo-root <path> --data-dir <path> [--keep <n>] [--active-worktree <path>] [--dry-run]
 */

import { existsSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { resolve, join, dirname, basename, sep, isAbsolute, relative } from 'node:path';
import { execSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const FORBIDDEN_ROOTS = ['/etc', '/usr', '/System', '/root', '/bin', '/sbin'];

/**
 * Canonical form of a path that may not exist: the realpath of its deepest existing ancestor
 * with the remaining segments appended. Lets a symlinked release root match a stored real path.
 * Uses the native realpath, which returns the on-disk letter case, so paths that differ only in
 * case still match on a case-insensitive filesystem.
 */
function canonicalize(p) {
  const absolute = resolve(p);
  const rest = [];
  let current = absolute;
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return rest.length > 0 ? join(real, ...rest) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return absolute;
      rest.unshift(basename(current));
      current = parent;
    }
  }
}

function isInside(child, parent) {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * Reads the platform's runtime target from <dataDir>/platform.db, opened read-only.
 * Throws when the database or the runtime_target_version table cannot be read: without it the
 * prune cannot tell which worktree host runtimes start from, so it must not remove anything.
 * A missing row or an empty daemon_cli_path means no worktree is referenced.
 */
export function readRuntimeTarget(dataDir) {
  if (!dataDir) {
    throw new Error('Missing required parameter: --data-dir (or ENKEEP_DATA_DIR)');
  }
  const dbPath = join(resolve(dataDir), 'platform.db');
  if (!existsSync(dbPath)) {
    throw new Error(`Platform database not found: ${dbPath}. Cannot determine the runtime target; refusing to prune.`);
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
    const row = db
      .prepare("SELECT image, daemon_cli_path FROM runtime_target_version WHERE id = 'default'")
      .get();
    return {
      dbPath,
      image: row?.image || null,
      daemonCliPath: row?.daemon_cli_path || null,
    };
  } catch (err) {
    throw new Error(`Cannot read runtime_target_version from ${dbPath} (${err.message}). Refusing to prune.`);
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

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
    dataDir: process.env.ENKEEP_DATA_DIR || '',
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
    else if (a === '--data-dir' && rawArgs[i + 1]) opts.dataDir = rawArgs[++i];
    else if (a === '--keep' && rawArgs[i + 1]) opts.keep = parseInt(rawArgs[++i], 10);
  }

  return opts;
}

export function planPruneWorktrees(options) {
  const { releaseRoot, repoRoot, keep, activeWorktree, dataDir } = options;

  if (!releaseRoot) {
    throw new Error('Missing required parameter: --release-root (or ENKEEP_RELEASE_ROOT)');
  }
  if (!repoRoot) {
    throw new Error('Missing required parameter: --repo-root (or ENKEEP_REPO_ROOT)');
  }
  if (!dataDir) {
    throw new Error('Missing required parameter: --data-dir (or ENKEEP_DATA_DIR)');
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
  const resolvedActive = activeWorktree ? canonicalize(activeWorktree) : '';

  const entries = readdirSync(resolvedReleaseRoot, { withFileTypes: true });
  const candidates = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Release worktrees typically match release-worktree-* or similar
    if (!entry.name.startsWith('release-worktree-')) continue;

    const fullPath = join(resolvedReleaseRoot, entry.name);
    const realCandidatePath = canonicalize(fullPath);

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

  // The worktree host runtimes start from (runtime target in the platform database).
  // Read before deciding anything; an unreadable database aborts the whole plan.
  const target = readRuntimeTarget(dataDir);
  let targetWorktree = null;
  let targetNote = '';
  let targetWarning = false;
  if (target.daemonCliPath) {
    if (!isAbsolute(target.daemonCliPath)) {
      // A relative path would be resolved against the operator's cwd; refuse instead of guessing.
      throw new Error(
        `runtime_target_version.daemon_cli_path is not absolute (${target.daemonCliPath}). Refusing to prune.`,
      );
    }
    const literal = resolve(target.daemonCliPath);
    const canonical = canonicalize(target.daemonCliPath);
    // Canonical match covers symlinked release roots and letter case; the literal match covers a
    // stored path that goes through the worktree but leaves it via a symlink inside it.
    targetWorktree =
      candidates.find(
        (c) => isInside(canonical, c.canonicalPath) || isInside(literal, c.path),
      ) || null;
    if (!targetWorktree) {
      targetWarning = true;
      const canonicalRoot = canonicalize(resolvedReleaseRoot);
      const underRoot = isInside(canonical, canonicalRoot);
      const firstSegment = underRoot ? relative(canonicalRoot, canonical).split(sep)[0] : '';
      if (underRoot && firstSegment.startsWith('release-worktree-') && !existsSync(join(canonicalRoot, firstSegment))) {
        targetNote = `runtime target worktree ${firstSegment} is missing; host runtime starts will fail`;
      } else if (underRoot) {
        targetNote = 'daemon path is under the release root but not inside any release-worktree-* directory';
      } else {
        targetNote = 'daemon path is outside the release root (check --data-dir and --release-root)';
      }
    }
  } else {
    // In host mode the platform then falls back to the daemon of its own worktree, which only
    // --active-worktree protects.
    targetNote = 'no daemon path in runtime_target_version';
    targetWarning = !resolvedActive;
  }

  const kept = [];
  const pruned = [];

  // Protect the most recent `keep` count
  for (let i = 0; i < candidates.length; i++) {
    const item = candidates[i];
    const isActive = resolvedActive && (item.canonicalPath === resolvedActive || item.path === resolvedActive);

    const isRuntimeTarget = targetWorktree !== null && item.path === targetWorktree.path;

    if (i < keep) {
      kept.push({ ...item, reason: `within-most-recent-${keep}` });
    } else if (isActive) {
      kept.push({ ...item, reason: 'protected-as-active-worktree' });
    } else if (isRuntimeTarget) {
      // Not counted toward --keep: kept however many worktrees are retained.
      kept.push({ ...item, reason: 'protected-as-runtime-target' });
    } else {
      pruned.push(item);
    }
  }

  return {
    releaseRoot: resolvedReleaseRoot,
    repoRoot: resolvedRepoRoot,
    activeWorktree: resolvedActive,
    runtimeTarget: {
      dbPath: target.dbPath,
      image: target.image,
      daemonCliPath: target.daemonCliPath,
      worktreeName: targetWorktree ? targetWorktree.name : null,
      worktreePath: targetWorktree ? targetWorktree.path : null,
      note: targetNote,
      warning: targetWarning,
    },
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

  const targetPath = plan.runtimeTarget?.worktreePath ? canonicalize(plan.runtimeTarget.worktreePath) : null;

  for (const item of plan.pruned) {
    // Defensive: a plan built by hand must not remove the runtime target either.
    if (targetPath && canonicalize(item.path) === targetPath) {
      results.errors.push({ path: item.path, error: 'refusing to remove the runtime target worktree' });
      continue;
    }

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
  --data-dir <path>        Platform data directory holding platform.db (Required, or ENKEEP_DATA_DIR).
                           The worktree its runtime target points to is always kept, outside --keep;
                           if the database cannot be read, nothing is pruned.
                           Prune only after all runtimes run the current target (deploy-release
                           --only verify shows "outdated 0").
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
    const rt = plan.runtimeTarget;
    console.log(`Runtime Target:   ${rt.worktreeName ? `${rt.worktreeName} (always kept)` : `(no worktree: ${rt.note})`}`);
    console.log(`  image:          ${rt.image || '(not set)'}`);
    console.log(`  daemon path:    ${rt.daemonCliPath || '(not set)'}`);
    if (rt.warning) {
      console.error(
        rt.daemonCliPath
          ? `WARNING: ${rt.note}`
          : 'WARNING: no daemon path in runtime_target_version and no --active-worktree: host runtimes fall back to the platform\'s own worktree, which is not protected',
      );
    }
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
    }
    if (execution.errors.length > 0) {
      for (const e of execution.errors) console.error(`! ${e.path}: ${e.error}`);
      console.error(`! Encountered ${execution.errors.length} errors during prune.`);
      process.exit(1);
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
