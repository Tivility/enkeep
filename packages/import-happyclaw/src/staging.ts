import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { assertNoSymlinkEscape, assertNotProductionData } from './guard.js'
import {
  compareDirectoryTrees,
  fsyncDirectory,
  scanDirectoryTree,
  writeSafeFile,
} from './copy-spaces.js'

export interface StagingContext {
  stagingDir: string
  destDir: string
  seedsDir: string
  spacesDir: string
}

/**
 * Creates an isolated staging directory next to the destination for atomic operations.
 */
export function createStagingContext(destDir: string): StagingContext {
  assertNotProductionData(destDir, 'staging target')

  const resolvedDest = resolve(destDir)
  const parentDir = dirname(resolvedDest)
  mkdirSync(parentDir, { recursive: true, mode: 0o755 })
  fsyncDirectory(parentDir)

  const randomSuffix = randomBytes(8).toString('hex')
  const stagingDir = join(parentDir, `.staging-${randomSuffix}`)

  rmSync(stagingDir, { recursive: true, force: true })
  mkdirSync(stagingDir, { recursive: true, mode: 0o755 })
  fsyncDirectory(stagingDir)

  const seedsDir = join(stagingDir, 'seeds')
  const spacesDir = join(stagingDir, 'spaces')

  mkdirSync(seedsDir, { recursive: true, mode: 0o755 })
  fsyncDirectory(seedsDir)
  mkdirSync(spacesDir, { recursive: true, mode: 0o755 })
  fsyncDirectory(spacesDir)

  return {
    stagingDir,
    destDir: resolvedDest,
    seedsDir,
    spacesDir,
  }
}

/**
 * Writes a JSON file deterministically with trailing newline using safe O_EXCL write and fsync.
 */
export function writeDeterministicJson(filePath: string, data: unknown): void {
  assertNotProductionData(filePath, 'staging json write')
  const content = `${JSON.stringify(data, undefined, 2)}\n`
  writeSafeFile(filePath, content, 0o644)
}

/**
 * Writes a compact raw JSON seed line with trailing newline using safe O_EXCL write and fsync.
 */
export function writeSeedJson(filePath: string, seed: readonly unknown[]): void {
  assertNotProductionData(filePath, 'staging seed write')
  const content = `${JSON.stringify(seed)}\n`
  writeSafeFile(filePath, content, 0o644)
}

/**
 * Atomically commits staging to target directory with idempotent verification.
 * 
 * Invariants:
 * 1. If destDir exists:
 *    - Compare exact directory tree (relative paths, permission modes, SHA-256 contents).
 *    - If identical: Idempotent no-op. Clean up staging directory and return safely.
 *    - If mismatched: Refuse and throw error without overwriting or deleting existing destination.
 * 2. If destDir does not exist:
 *    - Atomically rename stagingDir to destDir.
 *    - If rename encounters existing destDir (race condition), run exact tree verification or fail.
 * 3. Any error during backup/restore/cleanup is recorded and preserved via AggregateError.
 * 4. Never remove the backup directory if restore fails, preserving user evidence.
 */
export function commitStaging(ctx: StagingContext): void {
  const { stagingDir, destDir } = ctx

  assertNotProductionData(destDir, 'atomic commit destination')
  assertNoSymlinkEscape(stagingDir, dirname(destDir), 'staging directory')

  if (!existsSync(stagingDir)) {
    throw new Error(`staging directory does not exist: ${stagingDir}`)
  }

  // Scan staged tree
  const stagedTree = scanDirectoryTree(stagingDir, stagingDir)

  // 1. If destination already exists
  if (existsSync(destDir)) {
    const destTree = scanDirectoryTree(destDir, destDir)
    if (destTree.size === 0) {
      // Empty placeholder directory (e.g. created by parent mkdir) — safe to remove and replace
      safeClean(destDir)
    } else {
      const comparison = compareDirectoryTrees(stagedTree, destTree)
      if (comparison.matches) {
        // Exact identical tree exists — safe idempotent no-op
        safeClean(stagingDir)
        return
      }

      // Destination exists with non-empty mismatched contents — strictly refuse to overwrite to prevent destructive data loss
      safeClean(stagingDir)
      throw new Error(
        `destination directory "${destDir}" already exists and contents mismatch: ${comparison.reason || 'content discrepancy'}. Refusing to overwrite.`
      )
    }
  }

  // 2. Destination does not exist: attempt atomic rename
  const parentDir = dirname(destDir)
  fsyncDirectory(parentDir)

  try {
    renameSync(stagingDir, destDir)
    fsyncDirectory(parentDir)
  } catch (renameErr: any) {
    const errors: Error[] = [renameErr instanceof Error ? renameErr : new Error(String(renameErr))]

    // Check if destDir appeared during a concurrent race
    if (existsSync(destDir)) {
      try {
        const destTree = scanDirectoryTree(destDir, destDir)
        const comparison = compareDirectoryTrees(stagedTree, destTree)
        if (comparison.matches) {
          // Race completed with exact identical tree
          safeClean(stagingDir, errors)
          return
        } else {
          errors.push(
            new Error(`concurrent rename race detected and destination content mismatches: ${comparison.reason}`)
          )
        }
      } catch (raceErr: any) {
        errors.push(raceErr instanceof Error ? raceErr : new Error(String(raceErr)))
      }
    }

    safeClean(stagingDir, errors)

    if (errors.length === 1) {
      throw errors[0]
    }
    throw new AggregateError(errors, `failed to commit staging directory to "${destDir}"`)
  }
}

/**
 * Safely cleans a directory and collects any cleanup error.
 */
function safeClean(dirPath: string, errorCollector?: Error[]): void {
  try {
    if (existsSync(dirPath)) {
      rmSync(dirPath, { recursive: true, force: true })
    }
  } catch (cleanErr: any) {
    const err = cleanErr instanceof Error ? cleanErr : new Error(String(cleanErr))
    if (errorCollector) {
      errorCollector.push(err)
    }
  }
}

/**
 * Cleans up the staging directory if an error occurred before commit.
 * Records errors in AggregateError if cleanup fails.
 */
export function abortStaging(ctx: StagingContext, originalError?: unknown): void {
  const errors: Error[] = []
  if (originalError !== undefined) {
    errors.push(originalError instanceof Error ? originalError : new Error(String(originalError)))
  }

  try {
    if (existsSync(ctx.stagingDir)) {
      rmSync(ctx.stagingDir, { recursive: true, force: true })
    }
  } catch (cleanupErr: any) {
    errors.push(cleanupErr instanceof Error ? cleanupErr : new Error(String(cleanupErr)))
  }

  if (errors.length > 1) {
    throw new AggregateError(errors, 'error during import and staging cleanup failed')
  }
}
