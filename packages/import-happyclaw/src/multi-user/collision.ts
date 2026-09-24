import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { deterministicMessageId } from '../ids.js'
import type { IdCollisionDetail, UserMigrationPlan } from './types.js'

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex')
}

export interface DetectIdCollisionsOptions {
  readonly userPlans: readonly UserMigrationPlan[]
  readonly sourceDb: DatabaseSync
  readonly targetDbPath?: string
  readonly sourceFingerprint: string
}

/**
 * Detects deterministic ID collisions both within the planned migration batch
 * and against the target Enkeep platform database.
 */
export function detectIdCollisions(options: DetectIdCollisionsOptions): IdCollisionDetail[] {
  const collisions: IdCollisionDetail[] = []
  const { userPlans, sourceDb, targetDbPath } = options

  const srcTables = new Set(
    (sourceDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map(
      (t) => t.name
    )
  )
  const srcHasMsgs = srcTables.has('messages')

  // 1. Within-batch tracking sets
  const seenSpaceIds = new Map<string, { userId: string; workspaceJid: string }>()
  const seenSessionIds = new Map<string, { userId: string; chatJid: string }>()
  const seenSourceIds = new Map<string, { userId: string; chatJid: string }>()
  const seenSourceKeys = new Map<string, { userId: string; chatJid: string }>()
  const seenMessageIds = new Map<string, { userId: string; chatJid: string; messageId: string }>()
  const seenEventIds = new Map<string, { userId: string; chatJid: string; messageId: string }>()
  const seenProvIds = new Map<string, { userId: string; chatJid: string; messageId: string }>()
  const seenChannelAccounts = new Map<string, { userId: string; accountId: string }>()

  for (const uPlan of userPlans) {
    const targetUserId = uPlan.targetUserId

    // Spaces
    for (const sp of uPlan.spaces) {
      if (seenSpaceIds.has(sp.spaceId)) {
        const prior = seenSpaceIds.get(sp.spaceId)!
        collisions.push({
          table: 'spaces',
          id: sp.spaceId,
          reason: 'within_batch',
          message: `Duplicate space ID "${sp.spaceId}" within batch (workspace "${sp.workspaceJid}" collides with "${prior.workspaceJid}")`,
          targetUserId,
        })
      } else {
        seenSpaceIds.set(sp.spaceId, { userId: targetUserId, workspaceJid: sp.workspaceJid })
      }
    }

    // Sessions & Sources & Messages & Events & Provenance
    for (const ses of uPlan.sessions) {
      if (seenSessionIds.has(ses.targetSessionId)) {
        const prior = seenSessionIds.get(ses.targetSessionId)!
        collisions.push({
          table: 'session_routes',
          id: ses.targetSessionId,
          reason: 'within_batch',
          message: `Duplicate session ID "${ses.targetSessionId}" within batch (chat "${ses.chatJid}" collides with "${prior.chatJid}")`,
          targetUserId,
          sourceChatJid: ses.chatJid,
        })
      } else {
        seenSessionIds.set(ses.targetSessionId, { userId: targetUserId, chatJid: ses.chatJid })
      }

      const sourceId = `src_${sha256Hex(`${targetUserId}:${ses.targetSessionId}:${ses.chatJid}`).slice(0, 24)}`
      if (seenSourceIds.has(sourceId)) {
        collisions.push({
          table: 'session_sources',
          id: sourceId,
          reason: 'within_batch',
          message: `Duplicate session_sources ID "${sourceId}" within batch for chat "${ses.chatJid}"`,
          targetUserId,
          sourceChatJid: ses.chatJid,
        })
      } else {
        seenSourceIds.set(sourceId, { userId: targetUserId, chatJid: ses.chatJid })
      }

      const sourceKey = `${targetUserId}:happyclaw:${ses.chatJid}`
      if (seenSourceKeys.has(sourceKey)) {
        collisions.push({
          table: 'session_sources',
          id: sourceKey,
          reason: 'within_batch',
          message: `Duplicate session_sources key (user_id, source_type, source_id) within batch for chat "${ses.chatJid}"`,
          targetUserId,
          sourceChatJid: ses.chatJid,
        })
      } else {
        seenSourceKeys.set(sourceKey, { userId: targetUserId, chatJid: ses.chatJid })
      }

      if (srcHasMsgs) {
        const msgs = (sourceDb
          .prepare('SELECT id, attachments FROM messages WHERE chat_jid = ?')
          .all(ses.chatJid) as unknown[]) as Array<{ id: string; attachments?: string | null }>

        for (const m of msgs) {
          const targetMsgId = deterministicMessageId(ses.chatJid, m.id)
          const eventId = `ev_${sha256Hex(`${targetUserId}:${ses.targetSessionId}:${targetMsgId}`).slice(0, 24)}`
          const provId = `prov_${sha256Hex(`${targetUserId}:${ses.chatJid}:${m.id}`).slice(0, 24)}`

          if (seenMessageIds.has(targetMsgId)) {
            const prior = seenMessageIds.get(targetMsgId)!
            collisions.push({
              table: 'web_messages',
              id: targetMsgId,
              reason: 'within_batch',
              message: `Duplicate message ID "${targetMsgId}" within batch (source message "${m.id}" in chat "${ses.chatJid}" collides with chat "${prior.chatJid}")`,
              targetUserId,
              sourceChatJid: ses.chatJid,
              sourceMessageId: m.id,
            })
          } else {
            seenMessageIds.set(targetMsgId, {
              userId: targetUserId,
              chatJid: ses.chatJid,
              messageId: m.id,
            })
          }

          if (seenEventIds.has(eventId)) {
            collisions.push({
              table: 'web_events',
              id: eventId,
              reason: 'within_batch',
              message: `Duplicate event ID "${eventId}" within batch for message "${m.id}" in chat "${ses.chatJid}"`,
              targetUserId,
              sourceChatJid: ses.chatJid,
              sourceMessageId: m.id,
            })
          } else {
            seenEventIds.set(eventId, {
              userId: targetUserId,
              chatJid: ses.chatJid,
              messageId: m.id,
            })
          }

          if (seenProvIds.has(provId)) {
            collisions.push({
              table: 'fixed_import_provenance',
              id: provId,
              reason: 'within_batch',
              message: `Duplicate provenance ID "${provId}" within batch for message "${m.id}" in chat "${ses.chatJid}"`,
              targetUserId,
              sourceChatJid: ses.chatJid,
              sourceMessageId: m.id,
            })
          } else {
            seenProvIds.set(provId, {
              userId: targetUserId,
              chatJid: ses.chatJid,
              messageId: m.id,
            })
          }
        }
      }
    }

    // Channel accounts
    for (const ca of uPlan.channelAccounts) {
      const targetAccId = `acc_${sha256Hex(`${targetUserId}:${ca.channelType}:${ca.sourceAccountId}`).slice(0, 24)}`
      if (seenChannelAccounts.has(targetAccId)) {
        collisions.push({
          table: 'channel_accounts',
          id: targetAccId,
          reason: 'within_batch',
          message: `Duplicate channel account ID "${targetAccId}" within batch for source account "${ca.sourceAccountId}"`,
          targetUserId,
        })
      } else {
        seenChannelAccounts.set(targetAccId, {
          userId: targetUserId,
          accountId: ca.sourceAccountId,
        })
      }
    }
  }

  // 2. Check against target Enkeep database if provided
  if (targetDbPath && existsSync(targetDbPath)) {
    let targetDb: DatabaseSync | null = null
    try {
      targetDb = new DatabaseSync(targetDbPath, { readOnly: true })
      const targetTables = new Set(
        (targetDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map(
          (t) => t.name
        )
      )

      // Spaces collision check
      if (targetTables.has('spaces')) {
        const stmt = targetDb.prepare('SELECT id, user_id FROM spaces WHERE id = ?')
        for (const [spaceId, meta] of seenSpaceIds.entries()) {
          const row = stmt.get(spaceId) as { id: string; user_id: string } | undefined
          if (row && row.user_id !== meta.userId) {
            collisions.push({
              table: 'spaces',
              id: spaceId,
              reason: 'against_enkeep',
              message: `Space ID "${spaceId}" already exists in Enkeep database belonging to user "${row.user_id}"`,
              targetUserId: meta.userId,
              conflictingUserId: row.user_id,
            })
          }
        }
      }

      // Session routes collision check
      if (targetTables.has('session_routes')) {
        const stmt = targetDb.prepare('SELECT id, user_id FROM session_routes WHERE id = ?')
        for (const [sessionId, meta] of seenSessionIds.entries()) {
          const row = stmt.get(sessionId) as { id: string; user_id: string } | undefined
          if (row && row.user_id !== meta.userId) {
            collisions.push({
              table: 'session_routes',
              id: sessionId,
              reason: 'against_enkeep',
              message: `Session ID "${sessionId}" already exists in Enkeep database belonging to user "${row.user_id}"`,
              targetUserId: meta.userId,
              conflictingUserId: row.user_id,
              sourceChatJid: meta.chatJid,
            })
          }
        }
      }

      // Session sources collision check
      if (targetTables.has('session_sources')) {
        const stmtId = targetDb.prepare('SELECT id, user_id FROM session_sources WHERE id = ?')
        for (const [sourceId, meta] of seenSourceIds.entries()) {
          const row = stmtId.get(sourceId) as { id: string; user_id: string } | undefined
          if (row && row.user_id !== meta.userId) {
            collisions.push({
              table: 'session_sources',
              id: sourceId,
              reason: 'against_enkeep',
              message: `Session source ID "${sourceId}" already exists in Enkeep database belonging to user "${row.user_id}"`,
              targetUserId: meta.userId,
              conflictingUserId: row.user_id,
              sourceChatJid: meta.chatJid,
            })
          }
        }

        const stmtKey = targetDb.prepare(
          "SELECT id, user_id FROM session_sources WHERE source_type = 'happyclaw' AND source_id = ?"
        )
        for (const [sessionId, meta] of seenSessionIds.entries()) {
          const row = stmtKey.get(meta.chatJid) as { id: string; user_id: string } | undefined
          if (row && row.user_id !== meta.userId) {
            collisions.push({
              table: 'session_sources',
              id: `${meta.userId}:happyclaw:${meta.chatJid}`,
              reason: 'against_enkeep',
              message: `Session source for chat "${meta.chatJid}" already bound in Enkeep database to user "${row.user_id}"`,
              targetUserId: meta.userId,
              conflictingUserId: row.user_id,
              sourceChatJid: meta.chatJid,
            })
          }
        }
      }

      // Web messages collision check
      if (targetTables.has('web_messages')) {
        const stmt = targetDb.prepare('SELECT id, user_id FROM web_messages WHERE id = ?')
        for (const [msgId, meta] of seenMessageIds.entries()) {
          const row = stmt.get(msgId) as { id: string; user_id: string } | undefined
          if (row && row.user_id !== meta.userId) {
            collisions.push({
              table: 'web_messages',
              id: msgId,
              reason: 'against_enkeep',
              message: `Message ID "${msgId}" already exists in Enkeep database belonging to user "${row.user_id}"`,
              targetUserId: meta.userId,
              conflictingUserId: row.user_id,
              sourceChatJid: meta.chatJid,
              sourceMessageId: meta.messageId,
            })
          }
        }
      }

      // Web events collision check
      if (targetTables.has('web_events')) {
        const stmt = targetDb.prepare('SELECT id, user_id FROM web_events WHERE id = ?')
        for (const [eventId, meta] of seenEventIds.entries()) {
          const row = stmt.get(eventId) as { id: string; user_id: string } | undefined
          if (row && row.user_id !== meta.userId) {
            collisions.push({
              table: 'web_events',
              id: eventId,
              reason: 'against_enkeep',
              message: `Event ID "${eventId}" already exists in Enkeep database belonging to user "${row.user_id}"`,
              targetUserId: meta.userId,
              conflictingUserId: row.user_id,
              sourceChatJid: meta.chatJid,
              sourceMessageId: meta.messageId,
            })
          }
        }
      }

      // Fixed import provenance collision check
      if (targetTables.has('fixed_import_provenance')) {
        const stmt = targetDb.prepare('SELECT id, user_id FROM fixed_import_provenance WHERE id = ?')
        for (const [provId, meta] of seenProvIds.entries()) {
          const row = stmt.get(provId) as { id: string; user_id: string } | undefined
          if (row && row.user_id !== meta.userId) {
            collisions.push({
              table: 'fixed_import_provenance',
              id: provId,
              reason: 'against_enkeep',
              message: `Provenance ID "${provId}" already exists in Enkeep database belonging to user "${row.user_id}"`,
              targetUserId: meta.userId,
              conflictingUserId: row.user_id,
              sourceChatJid: meta.chatJid,
              sourceMessageId: meta.messageId,
            })
          }
        }
      }

      // Channel accounts collision check
      if (targetTables.has('channel_accounts')) {
        const stmt = targetDb.prepare('SELECT id, user_id FROM channel_accounts WHERE id = ?')
        for (const [accId, meta] of seenChannelAccounts.entries()) {
          const row = stmt.get(accId) as { id: string; user_id: string } | undefined
          if (row && row.user_id !== meta.userId) {
            collisions.push({
              table: 'channel_accounts',
              id: accId,
              reason: 'against_enkeep',
              message: `Channel account ID "${accId}" already exists in Enkeep database belonging to user "${row.user_id}"`,
              targetUserId: meta.userId,
              conflictingUserId: row.user_id,
            })
          }
        }
      }
    } finally {
      if (targetDb) {
        try {
          targetDb.close()
        } catch {}
      }
    }
  }

  return collisions
}
