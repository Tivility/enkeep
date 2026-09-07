import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { copySpaceToStaging } from './copy-spaces.js'
import {
  assertNotProductionData,
  assertSafeDemoRoot,
  validateGroupFolder,
  validateSourceFile,
} from './guard.js'
import {
  channelFromJid,
  deterministicSessionId,
  folderSlug,
  sessionIdFor,
} from './ids.js'
import { buildManifest, computeSourceFingerprint } from './manifest.js'
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
  GenericMigrateOptions,
  GenericMigrationResult,
  MigrationPlan,
  MigrationPlanItem,
} from './types.js'
import { assertLegalSeed } from './validate.js'

export const USER_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/

/**
 * Validates a target userId string.
 */
export function validateTargetUserId(userId: unknown): string {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new Error('Target userId must be a non-empty string')
  }
  if (userId.trim() !== userId) {
    throw new Error('Target userId must not have leading or trailing whitespace')
  }
  if (!USER_ID_PATTERN.test(userId)) {
    throw new Error(`Target userId "${userId}" is invalid. Must match pattern ${USER_ID_PATTERN.source}`)
  }
  return userId
}

/**
 * Creates a migration plan without mutating destination or platform state.
 */
export function createMigrationPlan(options: GenericMigrateOptions): MigrationPlan {
  const realDbPath = validateSourceFile(options.sourcePath, 'source database')
  const userId = validateTargetUserId(options.userId)

  const fingerprint = computeSourceFingerprint(realDbPath, options.sourceGroupsDir)
  const source = readSource(realDbPath, {
    chatJids: options.conversations && options.conversations.length > 0 ? options.conversations : undefined,
  })

  if (options.conversations && options.conversations.length > 0) {
    const foundJids = new Set(source.chats.map((c) => c.jid))
    for (const requested of options.conversations) {
      if (!foundJids.has(requested)) {
        throw new Error(`Requested conversation "${requested}" was not found in source database`)
      }
    }
  } else if (!options.all) {
    throw new Error('Must specify at least one `--conversation <id>` or pass `--all` to migrate all conversations')
  }

  const warnings: string[] = [...source.diagnostic.issues]
  const groupByJid = new Map(source.groups.map((g) => [g.jid, g]))

  const planItems: MigrationPlanItem[] = source.chats.map((chat) => {
    const group = groupByJid.get(chat.jid)
    let folder = options.targetSpace
      ? validateGroupFolder(options.targetSpace, 'targetSpace')
      : group?.folder
      ? validateGroupFolder(group.folder, 'group folder')
      : folderSlug(chat.name || chat.jid)

    const spaceName = options.targetSpaceName || options.targetSpace || chat.name || group?.name || folder
    const targetSessionId = deterministicSessionId(fingerprint, chat.jid, userId)
    const targetTitle = options.titleOverride || chat.name || group?.name || folder
    const routeKey = `web:default:${userId}:${targetSessionId}`

    const chatMsgs = source.messages.filter((m) => m.chat_jid === chat.jid)
    const attachmentCount = chatMsgs.filter((m) => m.attachments && m.attachments.trim() !== '').length

    const filesToCopy: string[] = []
    const missingFiles: string[] = []

    if (options.sourceGroupsDir && existsSync(options.sourceGroupsDir)) {
      const spaceSourceDir = join(options.sourceGroupsDir, group?.folder || folder)
      if (existsSync(spaceSourceDir)) {
        try {
          const entries = readdirSync(spaceSourceDir, { recursive: true })
          for (const entry of entries) {
            const rel = String(entry)
            const full = join(spaceSourceDir, rel)
            if (lstatSync(full).isFile()) {
              filesToCopy.push(rel)
            }
          }
        } catch {
          // Ignore
        }
      } else if (attachmentCount > 0) {
        missingFiles.push(`Space directory "${spaceSourceDir}" not found for attachments`)
      }
    }

    // Estimate seed events: user + assistant pairs + turn starts/ends + steps + end-seed
    const estimatedSeedEvents = Math.max(1, chatMsgs.length * 3 + 1)

    return {
      sourceKey: chat.jid,
      sourceName: chat.name || group?.name || chat.jid,
      messageCount: chatMsgs.length,
      targetUserId: userId,
      targetFolder: folder,
      targetSpaceName: spaceName,
      targetSessionId,
      targetRouteKey: routeKey,
      targetTitle,
      estimatedSeedEvents,
      attachmentCount,
      filesToCopy,
      missingFiles,
    }
  })

  return {
    sourcePath: options.sourcePath,
    sourceFingerprint: fingerprint,
    dryRun: Boolean(options.dryRun),
    targetUserId: userId,
    totalConversations: planItems.length,
    totalMessages: planItems.reduce((sum, item) => sum + item.messageCount, 0),
    items: planItems,
    warnings,
  }
}

/**
 * Executes generic migration or fork.
 * Generates plan, compiles DSH seed events, validates invariants, and writes artifacts
 * to target staging if targetDir is specified.
 */
export async function executeGenericMigration(
  options: GenericMigrateOptions
): Promise<GenericMigrationResult> {
  const plan = createMigrationPlan(options)

  if (options.dryRun) {
    return {
      success: true,
      dryRun: true,
      sourceFingerprint: plan.sourceFingerprint,
      targetUserId: plan.targetUserId,
      plan,
      compiledChats: [],
      manifest: {
        sourceFingerprint: plan.sourceFingerprint,
        importerVersion: '0.1.0',
        targetDsh: '@deepseek-ai/dsh-session@0.1.1-rc.2',
        sessionFormat: 0,
        idAlgorithm: 'sha256-chatJid-v1',
        createdAt: options.deterministicCreatedAt ?? new Date().toISOString(),
        stats: {
          chats: plan.totalConversations,
          sourceMessages: plan.totalMessages,
          importedPeopleTalk: plan.totalMessages,
          droppedEmpty: 0,
          attachments: 0,
          unpairedAssistants: 0,
          consecutiveUserMessages: 0,
          consecutiveAssistantMessages: 0,
        },
        chatReports: [],
        anomalies: [],
      },
      stats: {
        chats: plan.totalConversations,
        sourceMessages: plan.totalMessages,
        importedPeopleTalk: plan.totalMessages,
        droppedEmpty: 0,
        attachments: 0,
        unpairedAssistants: 0,
        consecutiveUserMessages: 0,
        consecutiveAssistantMessages: 0,
      },
      mapping: {},
    }
  }

  const source = readSource(options.sourcePath, {
    chatJids: options.conversations && options.conversations.length > 0 ? options.conversations : undefined,
  })

  // Compile chats to seed events
  const compiledChats = compileChats(source.chats, source.messages, source.groups, {
    sessionIdGenerator: (chatJid) => deterministicSessionId(plan.sourceFingerprint, chatJid, plan.targetUserId),
    folderResolver: (chat, group) => {
      if (options.targetSpace) {
        return validateGroupFolder(options.targetSpace, 'targetSpace')
      }
      if (group?.folder) {
        return validateGroupFolder(group.folder, 'group folder')
      }
      return folderSlug(chat.name || chat.jid)
    },
  })

  // Validate seed events with DSH invariant engine
  for (const chat of compiledChats) {
    await assertLegalSeed(chat.sessionId, chat.seed)
  }

  const { manifest, stats } = buildManifest(
    compiledChats,
    options.sourcePath,
    options.sourceGroupsDir,
    { deterministicCreatedAt: options.deterministicCreatedAt }
  )

  const mapping: Record<string, ChatMapping> = {}
  for (const chat of compiledChats) {
    const planItem = plan.items.find((i) => i.sourceKey === chat.chatJid)
    mapping[chat.chatJid] = {
      userId: plan.targetUserId,
      folder: chat.folder,
      sessionId: chat.sessionId,
      chatJid: chat.chatJid,
      executionMode: chat.report.executionMode,
      spaceName: planItem?.targetSpaceName,
      title: planItem?.targetTitle,
    }
  }

  // If targetDir is provided, write out filesystem artifacts via atomic staging
  if (options.targetDir) {
    assertNotProductionData(options.targetDir, 'import target directory')
    if (options.demoRoot) {
      assertSafeDemoRoot(options.targetDir, options.demoRoot, 'import target')
    }

    const staging = createStagingContext(options.targetDir)
    try {
      for (const chat of compiledChats) {
        if (options.sourceGroupsDir && existsSync(options.sourceGroupsDir)) {
          copySpaceToStaging(options.sourceGroupsDir, staging.spacesDir, chat.folder)
        }
        const seedFilePath = join(staging.seedsDir, `${chat.sessionId}.json`)
        writeSeedJson(seedFilePath, chat.seed)
      }

      writeDeterministicJson(join(staging.stagingDir, 'mapping.json'), mapping)
      writeDeterministicJson(join(staging.stagingDir, 'manifest.json'), manifest)
      writeDeterministicJson(join(staging.stagingDir, 'report.json'), {
        summary: stats,
        chatReports: manifest.chatReports,
        anomalies: manifest.anomalies,
      })

      commitStaging(staging)
    } catch (err) {
      abortStaging(staging)
      throw err
    }
  }

  return {
    success: true,
    dryRun: false,
    sourceFingerprint: plan.sourceFingerprint,
    targetUserId: plan.targetUserId,
    plan,
    compiledChats,
    manifest,
    stats,
    targetDir: options.targetDir,
    mapping,
  }
}
