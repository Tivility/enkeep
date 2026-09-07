import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import {
  assertNoSymlinkEscape,
  assertNotProductionData,
  validateGroupFolder,
} from './guard.js'

export interface DirectoryTreeEntry {
  relPath: string
  isDirectory: boolean
  mode: number
  sha256?: string
  size?: number
}

/**
 * Recursively scans a directory with lstat, enforcing no symlinks/devices/sockets/fifos.
 * Collects relative paths, modes, and SHA-256 digests for files.
 */
export function scanDirectoryTree(
  dirPath: string,
  rootPath: string = dirPath
): Map<string, DirectoryTreeEntry> {
  const tree = new Map<string, DirectoryTreeEntry>()

  if (!existsSync(dirPath)) {
    return tree
  }

  function walk(current: string): void {
    const entries = readdirSync(current).sort()
    for (const entry of entries) {
      const fullPath = join(current, entry)
      const stat = lstatSync(fullPath)
      const relPath = relative(rootPath, fullPath).replaceAll('\\', '/')

      if (stat.isSymbolicLink()) {
        throw new Error(`forbidden symlink encountered in space directory: ${relPath}`)
      }
      if (stat.isFIFO() || stat.isSocket() || stat.isCharacterDevice() || stat.isBlockDevice()) {
        throw new Error(`forbidden special device file encountered in space directory: ${relPath}`)
      }

      if (stat.isDirectory()) {
        tree.set(relPath, {
          relPath,
          isDirectory: true,
          mode: stat.mode & 0o777,
        })
        walk(fullPath)
      } else if (stat.isFile()) {
        const content = readFileSync(fullPath)
        const sha256 = createHash('sha256').update(content).digest('hex')
        tree.set(relPath, {
          relPath,
          isDirectory: false,
          mode: stat.mode & 0o777,
          sha256,
          size: stat.size,
        })
      } else {
        throw new Error(`forbidden unknown file type encountered: ${relPath}`)
      }
    }
  }

  walk(dirPath)
  return tree
}

/**
 * Compares two directory trees for exact relative paths, modes, and content hashes.
 */
export function compareDirectoryTrees(
  treeA: Map<string, DirectoryTreeEntry>,
  treeB: Map<string, DirectoryTreeEntry>
): { matches: boolean; reason?: string } {
  if (treeA.size !== treeB.size) {
    return {
      matches: false,
      reason: `tree entry counts differ (${treeA.size} vs ${treeB.size})`,
    }
  }

  for (const [relPath, entryA] of treeA.entries()) {
    const entryB = treeB.get(relPath)
    if (!entryB) {
      return {
        matches: false,
        reason: `entry "${relPath}" is missing in target tree`,
      }
    }

    if (entryA.isDirectory !== entryB.isDirectory) {
      return {
        matches: false,
        reason: `entry "${relPath}" type mismatch (directory vs file)`,
      }
    }

    if (entryA.mode !== entryB.mode) {
      return {
        matches: false,
        reason: `entry "${relPath}" permission mode mismatch (${entryA.mode.toString(8)} vs ${entryB.mode.toString(8)})`,
      }
    }

    if (!entryA.isDirectory && entryA.sha256 !== entryB.sha256) {
      return {
        matches: false,
        reason: `file content sha256 mismatch for "${relPath}"`,
      }
    }
  }

  return { matches: true }
}

/**
 * Safely writes a file to destination with O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW and fsync.
 */
export function writeSafeFile(
  filePath: string,
  content: Buffer | string,
  mode: number = 0o644
): void {
  const flags =
    constants.O_CREAT |
    constants.O_EXCL |
    constants.O_WRONLY |
    (constants.O_NOFOLLOW ?? 0)

  const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
  const fd = openSync(filePath, flags, mode)
  try {
    let offset = 0
    while (offset < buf.length) {
      const written = writeSync(fd, buf, offset, buf.length - offset)
      offset += written
    }
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * Performs fsync on a directory descriptor to ensure directory metadata persistence.
 */
export function fsyncDirectory(dirPath: string): void {
  try {
    const fd = openSync(dirPath, constants.O_RDONLY)
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    // Some OS filesystems may not support directory fsync; ignore silently
  }
}

/**
 * Recursively copies a source space directory tree to a staging destination.
 * Uses lstat, rejects symlinks/devices, writes files with O_EXCL | O_NOFOLLOW, and runs fsync.
 */
export function copySpaceToStaging(
  sourceGroupsDir: string,
  stagingSpacesDir: string,
  folder: string
): boolean {
  assertNotProductionData(sourceGroupsDir, 'source groups directory')
  assertNotProductionData(stagingSpacesDir, 'staging spaces directory')

  // Group folder name is strictly validated without sanitization
  const validFolder = validateGroupFolder(folder, 'space folder')

  const from = resolve(sourceGroupsDir, validFolder)
  const to = resolve(stagingSpacesDir, validFolder)

  if (!existsSync(from)) {
    return false
  }

  assertNoSymlinkEscape(from, sourceGroupsDir, `source space "${validFolder}"`)

  // Scan source tree and ensure safety
  const sourceTree = scanDirectoryTree(from, from)

  mkdirSync(to, { recursive: true, mode: 0o755 })
  fsyncDirectory(to)

  // Copy each entry
  for (const [relPath, entry] of sourceTree.entries()) {
    const targetPath = join(to, relPath)
    if (entry.isDirectory) {
      mkdirSync(targetPath, { recursive: true, mode: entry.mode })
      fsyncDirectory(targetPath)
    } else {
      const targetParent = dirname(targetPath)
      if (!existsSync(targetParent)) {
        mkdirSync(targetParent, { recursive: true, mode: 0o755 })
        fsyncDirectory(targetParent)
      }
      const fileContent = readFileSync(join(from, relPath))
      writeSafeFile(targetPath, fileContent, entry.mode)
    }
  }

  fsyncDirectory(to)
  return true
}

/**
 * Copy one group/space folder onto the destination spaces root.
 * Alias for copySpaceToStaging for backward compatibility.
 */
export function copySpace(
  sourceGroupsDir: string,
  destSpacesDir: string,
  folder: string
): boolean {
  return copySpaceToStaging(sourceGroupsDir, destSpacesDir, folder)
}
