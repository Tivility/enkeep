/**
 * Temporary Isolated Repo Root Helper for Hermetic Testing
 *
 * Ensures tests run strictly within temporary isolated directories
 * and NEVER read or write to the real workspace `.demo-data`.
 * Copies ONLY exact fixture files needed for import/reset without workspace symlinks.
 *
 * @module @enkeep/demo-runner/tests/support/temp-repo
 */

import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  lstatSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findRepoRoot } from '../../src/config.js';

export interface DirectoryMetadataSnapshot {
  path: string;
  dev: number;
  ino: number;
  uid: number;
}

export interface TempRepo {
  repoRoot: string;
  metadata: DirectoryMetadataSnapshot;
  cleanup: () => void;
}

/**
 * Safely removes a tracked directory:
 * - Direct lstatSync without existsSync TOCTOU or permission swallowing
 * - Verifies dev, ino, uid match tracked metadata
 * - Fails closed if replaced with symlink or non-directory
 * - Deletes with recursive: true, force: false
 */
export function safeRemoveTrackedDirectory(expected: DirectoryMetadataSnapshot): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(expected.path);
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') {
      return;
    }
    throw err;
  }

  if (stat.isSymbolicLink()) {
    throw new Error(`FAIL-CLOSED: Path to remove was replaced with a symbolic link: "${expected.path}"`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`FAIL-CLOSED: Path to remove is no longer a directory: "${expected.path}"`);
  }
  if (stat.dev !== expected.dev || stat.ino !== expected.ino) {
    throw new Error(
      `FAIL-CLOSED: Directory identity mismatch on "${expected.path}": expected dev=${expected.dev}, ino=${expected.ino}; got dev=${stat.dev}, ino=${stat.ino}`
    );
  }
  if (stat.uid !== expected.uid) {
    throw new Error(
      `FAIL-CLOSED: Directory owner mismatch on "${expected.path}": expected uid=${expected.uid}, got uid=${stat.uid}`
    );
  }

  rmSync(expected.path, { recursive: true, force: false });
}

/**
 * Recursively copies a directory tree rejecting any symbolic links or special files.
 */
function copyDirRecursiveSafe(srcDir: string, destDir: string): void {
  const stat = lstatSync(srcDir);
  if (stat.isSymbolicLink()) {
    throw new Error(`FAIL-CLOSED: Symlink detected in fixture source directory: "${srcDir}"`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`FAIL-CLOSED: Source path is not a directory: "${srcDir}"`);
  }
  mkdirSync(destDir, { recursive: true });

  const entries = readdirSync(srcDir);
  for (const entry of entries) {
    const srcPath = join(srcDir, entry);
    const destPath = join(destDir, entry);
    const entryStat = lstatSync(srcPath);

    if (entryStat.isSymbolicLink()) {
      throw new Error(`FAIL-CLOSED: Symlink detected in fixture file: "${srcPath}"`);
    }

    if (entryStat.isDirectory()) {
      copyDirRecursiveSafe(srcPath, destPath);
    } else if (entryStat.isFile()) {
      copyFileSync(srcPath, destPath);
    } else {
      throw new Error(`FAIL-CLOSED: Unsupported file type in fixture: "${srcPath}"`);
    }
  }
}

/**
 * Creates a hermetic temporary repository root for unit and acceptance tests.
 * Never symlinks workspace packages; copies only the necessary fixture files safely.
 */
export function createTempRepo(): TempRepo {
  const realRepo = findRepoRoot();
  const tempRepoRoot = mkdtempSync(join(tmpdir(), 'enkeep-test-repo-'));
  const stat = lstatSync(tempRepoRoot);
  const metadata: DirectoryMetadataSnapshot = {
    path: tempRepoRoot,
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
  };

  // Write isolated root package.json
  writeFileSync(
    join(tempRepoRoot, 'package.json'),
    JSON.stringify({ name: 'enkeep-root', private: true, type: 'module' }, null, 2),
    'utf-8'
  );

  // Copy exact HappyClaw import fixtures safely without symlinks
  const realFixturesDir = join(realRepo, 'packages/import-happyclaw/fixtures/source');
  const tempFixturesDir = join(tempRepoRoot, 'packages/import-happyclaw/fixtures/source');
  if (existsSync(realFixturesDir)) {
    copyDirRecursiveSafe(realFixturesDir, tempFixturesDir);
  }

  return {
    repoRoot: tempRepoRoot,
    metadata,
    cleanup: () => {
      safeRemoveTrackedDirectory(metadata);
    },
  };
}
