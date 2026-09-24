import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { assertNotProductionData, validateGroupFolder } from '../guard.js'
import { fsyncDirectory, writeSafeFile } from '../copy-spaces.js'
import type { MemoryFilePlanItem, SpaceMigrationPlanItem } from './types.js'

export const EXCLUDED_NAMES = new Set([
  '.env',
  'node_modules',
  '.git',
  '.DS_Store',
  '.claude',
  '.ipc',
  'ipc',
])

export function isSecretOrExcluded(name: string): boolean {
  if (EXCLUDED_NAMES.has(name)) return true
  if (name.startsWith('.env.')) return true
  if (name.endsWith('.sock') || name.endsWith('.tmp')) return true
  return false
}

export interface ScannedFileInfo {
  readonly relPath: string
  readonly fullPath: string
  readonly size: number
  readonly mode: number
  readonly isExcluded: boolean
}

/**
 * Safely scans a source directory, returning included and excluded files.
 */
export function scanSpaceFiles(sourceDir: string): {
  includedFiles: ScannedFileInfo[]
  excludedFiles: ScannedFileInfo[]
  totalBytes: number
} {
  const includedFiles: ScannedFileInfo[] = []
  const excludedFiles: ScannedFileInfo[] = []
  let totalBytes = 0

  if (!existsSync(sourceDir)) {
    return { includedFiles, excludedFiles, totalBytes: 0 }
  }

  function walk(current: string): void {
    const entries = readdirSync(current, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(current, entry.name)
      const relPath = relative(sourceDir, fullPath).replaceAll('\\', '/')

      if (isSecretOrExcluded(entry.name)) {
        excludedFiles.push({
          relPath,
          fullPath,
          size: 0,
          mode: 0o644,
          isExcluded: true,
        })
        continue
      }

      if (entry.isDirectory()) {
        walk(fullPath)
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        try {
          const stat = lstatSync(fullPath)
          if (stat.isSymbolicLink()) {
            // Exclude symlinks for safety
            excludedFiles.push({
              relPath,
              fullPath,
              size: 0,
              mode: stat.mode & 0o777,
              isExcluded: true,
            })
            continue
          }
          includedFiles.push({
            relPath,
            fullPath,
            size: stat.size,
            mode: stat.mode & 0o777,
            isExcluded: false,
          })
          totalBytes += stat.size
        } catch {}
      }
    }
  }

  walk(sourceDir)
  return { includedFiles, excludedFiles, totalBytes }
}

/**
 * Discovers memory files for a workspace and user from:
 * 1. Space root `CLAUDE.md` and `memory.md`
 * 2. `data/memory/<srcFolder>/*.md`
 */
export function discoverMemoryFiles(
  srcFolder: string,
  targetFolder: string,
  sourceGroupsDir?: string,
  sourceMemoryDir?: string
): MemoryFilePlanItem[] {
  const items: MemoryFilePlanItem[] = []

  // 1. Instructions / memory in workspace root
  if (sourceGroupsDir && existsSync(sourceGroupsDir)) {
    const spaceDir = join(sourceGroupsDir, srcFolder)
    if (existsSync(spaceDir)) {
      for (const name of ['CLAUDE.md', 'memory.md', 'MEMORY.md']) {
        const full = join(spaceDir, name)
        if (existsSync(full)) {
          try {
            const stat = lstatSync(full)
            if (stat.isFile()) {
              items.push({
                sourceFile: full,
                relativePath: name,
                targetPath: join(targetFolder, name),
                byteSize: stat.size,
                targetFolder,
              })
            }
          } catch {}
        }
      }
    }
  }

  // 2. Memory files in data/memory/<srcFolder>/
  if (sourceMemoryDir && existsSync(sourceMemoryDir)) {
    const memDir = join(sourceMemoryDir, srcFolder)
    if (existsSync(memDir)) {
      try {
        const files = readdirSync(memDir, { withFileTypes: true })
        for (const file of files) {
          if (file.isFile() && file.name.endsWith('.md')) {
            const full = join(memDir, file.name)
            const stat = lstatSync(full)
            items.push({
              sourceFile: full,
              relativePath: `memory/${file.name}`,
              targetPath: join(targetFolder, 'memory', file.name),
              byteSize: stat.size,
              targetFolder,
            })
          }
        }
      } catch {}
    }
  }

  return items
}

/**
 * Copies files for a space to target directory excluding secrets.
 */
export function copySpaceFilesSafely(
  sourceDir: string,
  targetDir: string
): { filesCopied: number; bytesCopied: number } {
  if (!existsSync(sourceDir)) {
    return { filesCopied: 0, bytesCopied: 0 }
  }

  assertNotProductionData(targetDir, 'target space directory')
  mkdirSync(targetDir, { recursive: true, mode: 0o755 })
  fsyncDirectory(targetDir)

  const { includedFiles } = scanSpaceFiles(sourceDir)
  let filesCopied = 0
  let bytesCopied = 0

  for (const file of includedFiles) {
    const dest = join(targetDir, file.relPath)
    const destParent = dirname(dest)
    if (!existsSync(destParent)) {
      mkdirSync(destParent, { recursive: true, mode: 0o755 })
      fsyncDirectory(destParent)
    }

    try {
      const content = readFileSync(file.fullPath)
      writeSafeFile(dest, content, file.mode || 0o644)
      filesCopied++
      bytesCopied += file.size
    } catch {}
  }

  fsyncDirectory(targetDir)
  return { filesCopied, bytesCopied }
}

/**
 * Copies memory files to target space memory directory.
 */
export function copyMemoryFilesSafely(
  memoryItems: readonly MemoryFilePlanItem[],
  targetSpacesBaseDir: string
): number {
  let count = 0
  for (const item of memoryItems) {
    const dest = join(targetSpacesBaseDir, item.targetPath)
    const destDir = dirname(dest)
    if (!existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true, mode: 0o755 })
      fsyncDirectory(destDir)
    }
    try {
      const content = readFileSync(item.sourceFile)
      writeSafeFile(dest, content, 0o644)
      count++
    } catch {}
  }
  return count
}
