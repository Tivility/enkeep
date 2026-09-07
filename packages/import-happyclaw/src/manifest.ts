import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AnomalyRecord,
  ChatReport,
  CompiledChat,
  ImportManifest,
  ImportStats,
} from './types.js'

export const IMPORTER_VERSION = '0.1.0'
export const TARGET_DSH_SPEC = '@deepseek-ai/dsh-session@0.1.1-rc.2'
export const SESSION_FORMAT_VERSION = 0
export const ID_ALGORITHM = 'sha256-chatJid-v1'

/**
 * Computes a deterministic SHA256 fingerprint for the source database and spaces.
 */
export function computeSourceFingerprint(dbPath: string, groupsDir?: string): string {
  const hash = createHash('sha256')

  if (existsSync(dbPath)) {
    const dbBuf = readFileSync(dbPath)
    hash.update('db:')
    hash.update(dbBuf)
  }

  if (groupsDir && existsSync(groupsDir)) {
    hashDirectoryDeterministic(groupsDir, hash)
  }

  return `sha256:${hash.digest('hex')}`
}

function hashDirectoryDeterministic(dir: string, hash: ReturnType<typeof createHash>): void {
  const entries = readdirSync(dir).sort()
  for (const entry of entries) {
    const fullPath = join(dir, entry)
    try {
      const stat = lstatSync(fullPath)
      if (stat.isSymbolicLink()) {
        continue
      }
      if (stat.isDirectory()) {
        hash.update(`dir:${entry}:`)
        hashDirectoryDeterministic(fullPath, hash)
      } else if (stat.isFile()) {
        hash.update(`file:${entry}:`)
        hash.update(readFileSync(fullPath))
      }
    } catch {
      // Skip inaccessible entries
    }
  }
}

/**
 * Builds the comprehensive import manifest including fingerprint, versions,
 * session formats, ID algorithm, statistics, per-chat reports, and anomalies.
 */
export function buildManifest(
  chats: CompiledChat[],
  dbPath: string,
  groupsDir?: string,
  options?: { deterministicCreatedAt?: string },
): { manifest: ImportManifest; stats: ImportStats } {
  const sourceFingerprint = computeSourceFingerprint(dbPath, groupsDir)
  const chatReports: ChatReport[] = chats.map((c) => c.report)
  const allAnomalies: AnomalyRecord[] = chats.flatMap((c) => c.anomalies)

  const stats: ImportStats = {
    chats: chats.length,
    sourceMessages: chats.reduce((sum, c) => sum + c.report.sourceMessages, 0),
    importedPeopleTalk: chats.reduce((sum, c) => sum + c.report.importedPeopleTalk, 0),
    droppedEmpty: chats.reduce((sum, c) => sum + c.report.droppedEmpty, 0),
    attachments: chats.reduce((sum, c) => sum + c.report.attachments, 0),
    unpairedAssistants: chats.reduce((sum, c) => sum + c.report.unpairedAssistants, 0),
    consecutiveUserMessages: chats.reduce((sum, c) => sum + c.report.consecutiveUserMessages, 0),
    consecutiveAssistantMessages: chats.reduce((sum, c) => sum + c.report.consecutiveAssistantMessages, 0),
  }

  const manifest: ImportManifest = {
    sourceFingerprint,
    importerVersion: IMPORTER_VERSION,
    targetDsh: TARGET_DSH_SPEC,
    sessionFormat: SESSION_FORMAT_VERSION,
    idAlgorithm: ID_ALGORITHM,
    createdAt: options?.deterministicCreatedAt ?? new Date().toISOString(),
    stats,
    chatReports,
    anomalies: allAnomalies,
  }

  return { manifest, stats }
}
