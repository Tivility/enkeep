import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { copySpaceToStaging } from './copy-spaces.js'
import {
  assertNotProductionData,
  assertSafeDemoRoot,
  getFixedFixtureSourceDir,
} from './guard.js'
import { buildManifest } from './manifest.js'
import { readSource } from './read-source.js'
import { compileChats } from './seed.js'
import {
  abortStaging,
  commitStaging,
  createStagingContext,
  writeDeterministicJson,
  writeSeedJson,
} from './staging.js'
import type {
  ChatMapping,
  ImportFixedFixtureRequest,
  ImportResult,
} from './types.js'
import { assertLegalSeed } from './validate.js'

const ALLOWED_REQUEST_KEYS = Object.freeze([
  'demoRoot',
  'deterministicCreatedAt',
  'targetDir',
  'userId',
])

export const EXPECTED_FIXED_FIXTURE_COUNTS = Object.freeze({
  chats: 2,
  sourceMessages: 52,
  importedPeopleTalk: 50,
  droppedEmpty: 2,
  attachments: 5,
})

/**
 * Validates the runtime request object strictly:
 * - Must be an object with exact own enumerable keys (no extra / no missing / no aliases).
 * - userId must be strictly 'alice'.
 * - targetDir and demoRoot must be non-empty absolute paths with no whitespace trim differences.
 * - targetDir must be strictly contained within demoRoot.
 * - deterministicCreatedAt must be a canonical ISO date string (new Date(x).toISOString() === x).
 */
export function validateImportRequest(request: unknown): asserts request is ImportFixedFixtureRequest {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    throw new Error('importFixedHappyClawFixture: request must be a non-null object')
  }

  const keys = Object.keys(request).sort()
  if (keys.length !== ALLOWED_REQUEST_KEYS.length || !keys.every((k, i) => k === ALLOWED_REQUEST_KEYS[i])) {
    throw new Error(
      `importFixedHappyClawFixture: request must have exact own enumerable keys [${ALLOWED_REQUEST_KEYS.join(', ')}], but got [${keys.join(', ')}]`
    )
  }

  const req = request as Record<string, unknown>

  if (typeof req.targetDir !== 'string' || req.targetDir.length === 0) {
    throw new Error('importFixedHappyClawFixture: targetDir must be a non-empty string')
  }
  if (req.targetDir.trim() !== req.targetDir) {
    throw new Error('importFixedHappyClawFixture: targetDir must not have leading or trailing whitespace')
  }
  if (!isAbsolute(req.targetDir)) {
    throw new Error(`importFixedHappyClawFixture: targetDir must be an absolute path, got "${req.targetDir}"`)
  }

  if (typeof req.demoRoot !== 'string' || req.demoRoot.length === 0) {
    throw new Error('importFixedHappyClawFixture: demoRoot must be a non-empty string')
  }
  if (req.demoRoot.trim() !== req.demoRoot) {
    throw new Error('importFixedHappyClawFixture: demoRoot must not have leading or trailing whitespace')
  }
  if (!isAbsolute(req.demoRoot)) {
    throw new Error(`importFixedHappyClawFixture: demoRoot must be an absolute path, got "${req.demoRoot}"`)
  }

  if (req.userId !== 'alice') {
    throw new Error(`importFixedHappyClawFixture: userId must strictly be "alice", got "${String(req.userId)}"`)
  }

  if (typeof req.deterministicCreatedAt !== 'string' || req.deterministicCreatedAt.length === 0) {
    throw new Error('importFixedHappyClawFixture: deterministicCreatedAt must be a non-empty string')
  }
  const parsedTime = Date.parse(req.deterministicCreatedAt)
  if (Number.isNaN(parsedTime) || new Date(parsedTime).toISOString() !== req.deterministicCreatedAt) {
    throw new Error(
      `importFixedHappyClawFixture: deterministicCreatedAt must be a canonical ISO string (e.g. "2026-08-01T12:00:00.000Z"), got "${req.deterministicCreatedAt}"`
    )
  }
}

/**
 * Asserts that the fixed fixture matches expected static message and chat invariants.
 * Prevents silent fixture drift from altering import output counts.
 */
export function assertFixedFixtureCounts(
  sourceChatsCount: number,
  sourceMessagesCount: number,
  statsChatsCount: number,
  statsMessagesCount: number,
  importedPeopleTalkCount: number,
  droppedEmptyCount: number,
  attachmentsCount: number
): void {
  if (
    sourceChatsCount !== EXPECTED_FIXED_FIXTURE_COUNTS.chats ||
    sourceMessagesCount !== EXPECTED_FIXED_FIXTURE_COUNTS.sourceMessages ||
    statsChatsCount !== EXPECTED_FIXED_FIXTURE_COUNTS.chats ||
    statsMessagesCount !== EXPECTED_FIXED_FIXTURE_COUNTS.sourceMessages ||
    importedPeopleTalkCount !== EXPECTED_FIXED_FIXTURE_COUNTS.importedPeopleTalk ||
    droppedEmptyCount !== EXPECTED_FIXED_FIXTURE_COUNTS.droppedEmpty ||
    attachmentsCount !== EXPECTED_FIXED_FIXTURE_COUNTS.attachments
  ) {
    throw new Error(
      `fixed fixture drift detected: expected exact counts ${JSON.stringify(EXPECTED_FIXED_FIXTURE_COUNTS)}, got ` +
      `{ chats: ${sourceChatsCount}, sourceMessages: ${sourceMessagesCount}, importedPeopleTalk: ${importedPeopleTalkCount}, droppedEmpty: ${droppedEmptyCount}, attachments: ${attachmentsCount} }`
    )
  }
}

/**
 * Runs the HappyClaw import pipeline for the package-internal fixed offline fixture:
 * 1. Validates exact runtime request shape (targetDir, demoRoot, userId 'alice', deterministicCreatedAt).
 * 2. Resolves and validates package root and fixed offline fixture at `fixtures/source`.
 * 3. Enforces demoRoot containment on targetDir.
 * 4. Reads SQLite source messages, chats, and registered groups from immutable URI.
 * 5. Compiles chats to DSH-legal seeds and asserts fixed fixture count invariants.
 * 6. Verifies seeds using real @deepseek-ai/dsh-session Session.create invariants.
 * 7. Writes all artifacts (seeds, spaces, mapping, manifest, report) into atomic staging.
 * 8. Atomically commits staging to target directory with idempotent verification.
 */
export async function importFixedHappyClawFixture(
  request: ImportFixedFixtureRequest
): Promise<ImportResult> {
  validateImportRequest(request)

  const { targetDir, demoRoot, userId, deterministicCreatedAt } = request

  assertNotProductionData(targetDir, 'import target directory')
  assertSafeDemoRoot(targetDir, demoRoot, 'import target')

  // Strictly locate fixed offline fixture from package directory via import.meta.url
  const fixtureSourceDir = getFixedFixtureSourceDir()
  const dbPath = join(fixtureSourceDir, 'db', 'messages.db')
  const groupsDir = join(fixtureSourceDir, 'groups')

  if (!existsSync(dbPath)) {
    throw new Error(`fixed source database file not found: ${dbPath}`)
  }

  const source = readSource(dbPath)
  // Always import all fixed 2 chats and 52 messages
  const chats = compileChats(source.chats, source.messages, source.groups)

  // Validate every compiled seed through the actual DSH Session.create invariant engine
  for (const chat of chats) {
    await assertLegalSeed(chat.sessionId, chat.seed)
  }

  const { manifest, stats } = buildManifest(chats, dbPath, groupsDir, {
    deterministicCreatedAt,
  })

  // Assert exact fixed fixture invariants to detect drift
  assertFixedFixtureCounts(
    source.chats.length,
    source.messages.length,
    stats.chats,
    stats.sourceMessages,
    stats.importedPeopleTalk,
    stats.droppedEmpty,
    stats.attachments
  )

  // Create isolated staging environment
  const staging = createStagingContext(targetDir)

  try {
    const mapping: Record<string, ChatMapping> = {}

    for (const chat of chats) {
      // 1. Copy space folder to staging if exists in fixed fixture
      if (existsSync(groupsDir)) {
        copySpaceToStaging(groupsDir, staging.spacesDir, chat.folder)
      }

      // 2. Write seed JSON with safe write and fsync
      const seedFilePath = join(staging.seedsDir, `${chat.sessionId}.json`)
      writeSeedJson(seedFilePath, chat.seed)

      // 3. Build mapping record (strictly typed with userId: 'alice')
      mapping[chat.chatJid] = {
        userId: 'alice',
        folder: chat.folder,
        sessionId: chat.sessionId,
        chatJid: chat.chatJid,
        executionMode: chat.report.executionMode,
      }
    }

    // Write mapping.json
    writeDeterministicJson(join(staging.stagingDir, 'mapping.json'), mapping)

    // Write import-manifest.json
    writeDeterministicJson(join(staging.stagingDir, 'import-manifest.json'), manifest)

    // Write import-report.json
    const reportData = {
      userId,
      createdAt: manifest.createdAt,
      importerVersion: manifest.importerVersion,
      targetDsh: manifest.targetDsh,
      stats: manifest.stats,
      chats: chats.map((c) => c.report),
      anomalies: manifest.anomalies,
    }
    writeDeterministicJson(join(staging.stagingDir, 'import-report.json'), reportData)

    // Atomically swap staging to target directory (idempotent / no-overwrite on mismatch)
    commitStaging(staging)

    const resolvedDest = resolve(targetDir)
    return {
      targetDir: resolvedDest,
      mapping,
      chats,
      manifest,
      stats,
    }
  } catch (err) {
    abortStaging(staging, err)
    throw err
  }
}
