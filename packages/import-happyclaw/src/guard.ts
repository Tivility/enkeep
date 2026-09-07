import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const GROUP_FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export const MAX_FIXTURE_FILES = 100
export const MAX_FIXTURE_TOTAL_BYTES = 50 * 1024 * 1024 // 50 MB

export const EXPECTED_FIXTURE_FILES: readonly string[] = Object.freeze([
  'db/messages.db',
  'groups/alice-space/CLAUDE.md',
  'groups/alice-space/notes/project-plan.md',
  'groups/alice-space/conversations/topics.md',
  'groups/alice-space/artifacts/summary.json',
  'groups/bob-space/CLAUDE.md',
  'groups/bob-space/notes/migration-notes.md',
  'groups/bob-space/conversations/former-host-context.md',
  'groups/bob-space/artifacts/legacy-report.txt',
])

/**
 * Validates group folder names strictly against /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.
 * Refuses ., .., slash, backslash, control characters, or Unicode confusion.
 * Does NOT sanitize — throws directly on invalid names.
 */
export function validateGroupFolder(folder: unknown, label: string = 'group folder'): string {
  if (typeof folder !== 'string') {
    throw new Error(`${label}: folder name must be a string, got ${typeof folder}`)
  }

  if (folder.length === 0 || folder.length > 64) {
    throw new Error(`${label}: folder name length must be between 1 and 64 characters, got length ${folder.length}`)
  }

  if (folder === '.' || folder === '..') {
    throw new Error(`${label}: folder name cannot be "." or ".."`)
  }

  if (folder.includes('/') || folder.includes('\\')) {
    throw new Error(`${label}: folder name cannot contain path separators: "${folder}"`)
  }

  // Reject control characters (0x00 - 0x1F, 0x7F)
  if (/[\x00-\x1F\x7F]/.test(folder)) {
    throw new Error(`${label}: folder name cannot contain control characters`)
  }

  // Strict regex check: only ASCII letters, numbers, dot, underscore, hyphen, starting with letter/number
  if (!GROUP_FOLDER_PATTERN.test(folder)) {
    throw new Error(
      `${label}: folder name "${folder}" is invalid. Must match pattern ${GROUP_FOLDER_PATTERN.source}`
    )
  }

  return folder
}

/**
 * Finds the package root of @enkeep/import-happyclaw using import.meta.url.
 */
export function findPackageRoot(fromUrlOrPath?: string): string {
  let dir = fromUrlOrPath
    ? fromUrlOrPath.startsWith('file:')
      ? dirname(fileURLToPath(fromUrlOrPath))
      : dirname(resolve(fromUrlOrPath))
    : dirname(fileURLToPath(import.meta.url))

  for (let i = 0; i < 10; i += 1) {
    const pkgJsonPath = join(dir, 'package.json')
    if (existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
        if (pkg.name === '@enkeep/import-happyclaw') {
          return realpathSync(dir)
        }
      } catch {
        // Continue searching
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  throw new Error('cannot locate @enkeep/import-happyclaw package root')
}

/**
 * Resolves and strictly validates the fixed fixture source directory within the package.
 */
export function getFixedFixtureSourceDir(): string {
  const pkgRoot = findPackageRoot()
  const fixtureDir = join(pkgRoot, 'fixtures', 'source')

  if (!existsSync(fixtureDir)) {
    throw new Error(`fixed offline fixture directory does not exist: ${fixtureDir}`)
  }

  const realFixtureDir = realpathSync(fixtureDir)
  const rel = relative(pkgRoot, realFixtureDir)

  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`fixed fixture directory "${realFixtureDir}" escaped package root "${pkgRoot}"`)
  }

  validateFixtureSourceIntegrity(realFixtureDir)
  return realFixtureDir
}

/**
 * Validates that a fixture source directory is safe, has no symlinks/devices/sockets/fifos,
 * does not exceed file count or byte limits, and contains expected files.
 */
export function validateFixtureSourceIntegrity(fixtureDir: string): void {
  const realSourceDir = realpathSync(fixtureDir)
  let fileCount = 0
  let totalBytes = 0

  function scan(currentDir: string): void {
    const entries = readdirSync(currentDir)
    for (const entry of entries) {
      const fullPath = join(currentDir, entry)
      const stat = lstatSync(fullPath)

      if (stat.isSymbolicLink()) {
        throw new Error(`forbidden symbolic link in fixture source: ${fullPath}`)
      }
      if (stat.isFIFO() || stat.isSocket() || stat.isCharacterDevice() || stat.isBlockDevice()) {
        throw new Error(`forbidden non-regular file device in fixture source: ${fullPath}`)
      }

      if (stat.isDirectory()) {
        scan(fullPath)
      } else if (stat.isFile()) {
        fileCount += 1
        totalBytes += stat.size

        if (fileCount > MAX_FIXTURE_FILES) {
          throw new Error(`fixture source exceeds maximum allowed file count (${MAX_FIXTURE_FILES})`)
        }
        if (totalBytes > MAX_FIXTURE_TOTAL_BYTES) {
          throw new Error(`fixture source exceeds maximum allowed size (${MAX_FIXTURE_TOTAL_BYTES} bytes)`)
        }

        // Reject WAL/SHM sqlite temp files in fixture
        if (entry.endsWith('-wal') || entry.endsWith('-shm')) {
          throw new Error(`forbidden WAL/SHM file found in fixture source: ${entry}`)
        }
      } else {
        throw new Error(`unknown file type in fixture source: ${fullPath}`)
      }
    }
  }

  scan(realSourceDir)

  // Verify critical expected fixture files exist
  for (const expectedRel of EXPECTED_FIXTURE_FILES) {
    const expectedPath = join(realSourceDir, expectedRel)
    if (!existsSync(expectedPath)) {
      throw new Error(`missing required fixture file: ${expectedRel}`)
    }
    const stat = lstatSync(expectedPath)
    if (!stat.isFile()) {
      throw new Error(`required fixture path is not a regular file: ${expectedRel}`)
    }
  }
}

/**
 * Validates a user-specified source database file path:
 * - Must exist on filesystem.
 * - Must resolve to a regular file (not directory, socket, pipe, or character/block device).
 * - Resolves real path following symlinks and confirms real path is a regular file.
 */
export function validateSourceFile(sourcePath: string, label: string = 'source database'): string {
  if (!sourcePath || typeof sourcePath !== 'string') {
    throw new Error(`${label}: path must be a non-empty string`)
  }

  const resolved = resolve(sourcePath)
  if (!existsSync(resolved)) {
    throw new Error(`${label} does not exist: ${resolved}`)
  }

  const realPath = realpathSync(resolved)
  const stat = statSync(realPath)

  if (!stat.isFile()) {
    throw new Error(`${label} is not a regular file: ${realPath}`)
  }

  return realPath
}

/**
 * Safety check for write/staging destinations to prevent accidental destruction
 * of root or user home directory.
 */
export function assertNotProductionData(path: string, label: string): void {
  if (!path || typeof path !== 'string') {
    throw new Error(`${label}: path must be a non-empty string`)
  }

  const resolved = resolve(path)
  const normalized = normalize(resolved)
  const userHome = homedir()

  // Refuse root or user home directory as destination target
  if (normalized === '/' || normalized === userHome) {
    throw new Error(`${label} refuses root or home directory as destination target: ${path}`)
  }
}

/**
 * Enforce that a destination path is strictly within the explicit demo root.
 */
export function assertSafeDemoRoot(destDir: string, explicitDemoRoot: string, label: string = 'destination'): string {
  assertNotProductionData(destDir, label)
  assertNotProductionData(explicitDemoRoot, `${label} demo root`)

  const resolvedDest = resolve(destDir)
  const resolvedDemoRoot = resolve(explicitDemoRoot)

  const rel = relative(resolvedDemoRoot, resolvedDest)
  const isInside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))

  if (!isInside) {
    throw new Error(
      `${label} path must be strictly contained inside demo root "${resolvedDemoRoot}", but got "${resolvedDest}".`
    )
  }

  return resolvedDest
}

/**
 * Verifies that a path does not contain symlinks that escape the allowed root boundary.
 */
export function assertNoSymlinkEscape(targetPath: string, allowedRoot: string, label: string = 'path'): void {
  const resolvedAllowedRoot = resolve(allowedRoot)

  if (!existsSync(targetPath)) return

  try {
    const stat = lstatSync(targetPath)
    if (stat.isSymbolicLink()) {
      const real = realpathSync(targetPath)
      const rel = relative(resolvedAllowedRoot, real)
      if (rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error(`${label} is a symlink pointing outside allowed root "${resolvedAllowedRoot}": ${real}`)
      }
    }
  } catch (err: any) {
    if (err.message.includes('pointing outside allowed root')) {
      throw err
    }
  }
}
