import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { assertNotProductionData, validateSourceFile } from '../guard.js'
import { channelFromJid, deterministicMessageId, deterministicSessionId, deterministicSpaceId } from '../ids.js'
import { computeSourceFingerprint } from '../manifest.js'
import { introspectSource } from '../introspection.js'
import { compileChats, compileSeed } from '../seed.js'
import { detectIdCollisions } from './collision.js'
import {
  prepareChannelAccountCredential,
  resolveMasterEncryptionKey,
} from './credentials.js'
import {
  copyMemoryFilesSafely,
  copySpaceFilesSafely,
  discoverMemoryFiles,
  scanSpaceFiles,
} from './file-transfer.js'
import { materializeSessions, type SessionMaterializeItem } from './materialize.js'
import {
  generateSecureTempPassword,
  getDefaultPasswordFilePath,
  hashPasswordScrypt,
  savePrivatePasswordsFile,
  type ProvisionedUserPassword,
} from './passwords.js'
import { mapUserSpaces, type RawWorkspaceRow } from './space-mapper.js'
import type {
  ChannelAccountPlanItem,
  MemoryFilePlanItem,
  MultiUserMigrateOptions,
  MultiUserMigrationPlan,
  MultiUserMigrationResult,
  SessionMigrationPlanItem,
  SpaceMigrationPlanItem,
  UserMigrationPlan,
} from './types.js'

export interface RawSourceUser {
  readonly id: string
  readonly username: string
  readonly display_name?: string | null
  readonly role?: string | null
  readonly status?: string | null
  readonly created_at?: string | null
}

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Discovers and filters users from source database according to MultiUserSelectOptions.
 */
export function discoverAndSelectUsers(
  db: DatabaseSync,
  select: MultiUserMigrateOptions['select']
): RawSourceUser[] {
  // Check if users table exists
  const tableCheck = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
    .get()
  if (!tableCheck) {
    throw new Error('Source database does not contain a "users" table')
  }

  const allUsers = (db
    .prepare('SELECT id, username, display_name, role, status, created_at FROM users')
    .all() as unknown[]) as RawSourceUser[]

  const ownerName = (select.ownerUsername || 'owner-user').toLowerCase()

  if (select.allExceptOwner) {
    const filtered = allUsers.filter((u) => {
      const isOwnerRole = u.role === 'admin'
      const isOwnerName = (u.username || '').toLowerCase() === ownerName
      const isOwnerId = (u.id || '').toLowerCase() === ownerName
      return !isOwnerRole && !isOwnerName && !isOwnerId
    })
    if (filtered.length === 0) {
      throw new Error(`No non-owner users found in source database to migrate (owner: "${ownerName}")`)
    }
    return filtered
  }

  if (select.users && select.users.length > 0) {
    const requested = select.users.map((u) => u.toLowerCase())
    const matched: RawSourceUser[] = []
    const missing: string[] = []

    for (const req of requested) {
      const found = allUsers.find(
        (u) => (u.username || '').toLowerCase() === req || (u.id || '').toLowerCase() === req
      )
      if (found) {
        if (!matched.some((m) => m.id === found.id)) {
          matched.push(found)
        }
      } else {
        missing.push(req)
      }
    }

    if (missing.length > 0) {
      throw new Error(`Requested user(s) not found in source database: ${missing.join(', ')}`)
    }
    return matched
  }

  throw new Error('Must specify at least one user via `--user <id>` or pass `--all-except owner`')
}

/**
 * Creates a comprehensive multi-user migration plan without modifying any destination state.
 */
export function planMultiUserMigration(options: MultiUserMigrateOptions): MultiUserMigrationPlan {
  const realDbPath = validateSourceFile(options.sourcePath, 'source database')
  const fingerprint = computeSourceFingerprint(realDbPath, options.sourceGroupsDir)

  const uri = `file:${realDbPath}?immutable=1&mode=ro`
  const srcDb = new DatabaseSync(uri, { readOnly: true })

  try {
    const selectedUsers = discoverAndSelectUsers(srcDb, options.select)
    const masterKey = resolveMasterEncryptionKey(options.masterKey)

    // Optional targetDb inspection to know if user already exists
    let existingTargetUsernames = new Set<string>()
    if (options.targetDbPath && existsSync(options.targetDbPath)) {
      try {
        const targetDb = new DatabaseSync(options.targetDbPath, { readOnly: true })
        const rows = (targetDb.prepare('SELECT username FROM users').all() as unknown[]) as Array<{ username: string }>
        existingTargetUsernames = new Set(rows.map((r) => r.username.toLowerCase()))
        targetDb.close()
      } catch {}
    }

    const userPlans: UserMigrationPlan[] = []
    const warnings: string[] = []

    let totalSpaces = 0
    let totalSessions = 0
    let totalMessages = 0
    let totalMemoryFiles = 0
    let totalFileBytes = 0
    let totalChannelAccounts = 0
    let totalNewUsers = 0
    let totalExistingUsers = 0

    const srcTables = new Set(
      (srcDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map(
        (t) => t.name
      )
    )

    for (const u of selectedUsers) {
      const isExisting = existingTargetUsernames.has(u.username.toLowerCase())
      if (isExisting) {
        totalExistingUsers++
      } else {
        totalNewUsers++
      }

      const targetUserId = u.id

      // 1. Fetch workspaces for this user
      let rawWs: RawWorkspaceRow[] = []
      if (srcTables.has('workspaces')) {
        rawWs = (srcDb
          .prepare('SELECT * FROM workspaces WHERE owner_user_id = ?')
          .all(u.id) as unknown[]) as RawWorkspaceRow[]
      }
      if (rawWs.length === 0 && srcTables.has('registered_groups')) {
        rawWs = (srcDb
          .prepare('SELECT jid, name, folder, execution_mode, is_home, created_by FROM registered_groups WHERE created_by = ?')
          .all(u.id) as unknown[]) as RawWorkspaceRow[]
      }

      // Disambiguate spaces (cxx multiple workspaces sharing home-<uid>)
      const spaceMappings = mapUserSpaces(rawWs, targetUserId, fingerprint)

      // 2. Fetch chats and messages
      const spaceItems: SpaceMigrationPlanItem[] = []
      const sessionItems: SessionMigrationPlanItem[] = []
      const memoryItems: MemoryFilePlanItem[] = []

      for (const sm of spaceMappings) {
        // Files scanning
        const srcSpaceDir = options.sourceGroupsDir ? join(options.sourceGroupsDir, sm.srcFolder) : ''
        const { includedFiles, excludedFiles, totalBytes } = scanSpaceFiles(srcSpaceDir)

        spaceItems.push({
          workspaceJid: sm.workspaceJid,
          workspaceName: sm.workspaceName,
          srcFolder: sm.srcFolder,
          targetFolder: sm.targetFolder,
          spaceId: sm.spaceId,
          executionMode: 'container',
          isHome: sm.isHome,
          filesCount: includedFiles.length,
          totalFileBytes: totalBytes,
          filesToCopy: includedFiles.map((f) => f.relPath),
          excludedFiles: excludedFiles.map((f) => f.relPath),
        })

        totalFileBytes += totalBytes

        // Sessions for this workspace
        const chatRows = (srcDb
          .prepare('SELECT * FROM chats WHERE jid = ?')
          .all(sm.workspaceJid) as unknown[]) as Array<{ jid: string; name?: string }>
        const chatJid = chatRows[0]?.jid || sm.workspaceJid

        const msgRows = (srcDb
          .prepare('SELECT id, attachments FROM messages WHERE chat_jid = ?')
          .all(chatJid) as unknown[]) as Array<{ id: string; attachments?: string | null }>

        const attCount = msgRows.filter((m) => m.attachments && m.attachments.trim() !== '').length
        const targetSessionId = deterministicSessionId(fingerprint, chatJid, targetUserId)
        const targetRouteKey = `web:default:${targetUserId}:${targetSessionId}`

        sessionItems.push({
          chatJid,
          title: sm.workspaceName,
          spaceId: sm.spaceId,
          targetFolder: sm.targetFolder,
          targetSessionId,
          targetRouteKey,
          messageCount: msgRows.length,
          attachmentCount: attCount,
        })

        totalMessages += msgRows.length

        // Memory files
        const mems = discoverMemoryFiles(
          sm.srcFolder,
          sm.targetFolder,
          options.sourceGroupsDir,
          options.sourceMemoryDir
        )
        for (const m of mems) {
          if (!memoryItems.some((existing) => existing.sourceFile === m.sourceFile)) {
            memoryItems.push(m)
          }
        }
      }

      totalSpaces += spaceItems.length
      totalSessions += sessionItems.length
      totalMemoryFiles += memoryItems.length

      // 3. Channel accounts
      let chanRows: Array<{ id: string; provider?: string; name?: string }> = []
      if (srcTables.has('channel_accounts')) {
        chanRows = (srcDb
          .prepare('SELECT * FROM channel_accounts WHERE owner_user_id = ?')
          .all(u.id) as unknown[]) as typeof chanRows
      }

      const channelItems: ChannelAccountPlanItem[] = []
      for (const ch of chanRows) {
        const credInfo = prepareChannelAccountCredential(ch, targetUserId, masterKey)
        channelItems.push({
          sourceAccountId: ch.id,
          channelType: credInfo.channelType,
          name: credInfo.name,
          status: 'disabled', // Forced DISABLED
          credentialRef: credInfo.credentialRef,
          credentialAction: credInfo.isPlaceholder ? 'placeholder' : 'encrypted',
          bindingCount: spaceMappings.length,
        })
      }

      totalChannelAccounts += channelItems.length

      userPlans.push({
        sourceUser: {
          id: u.id,
          username: u.username,
          displayName: u.display_name || u.username,
          role: u.role || 'member',
        },
        targetUserId,
        isNewUser: !isExisting,
        mustChangePassword: true,
        spaces: spaceItems,
        sessions: sessionItems,
        memoryFiles: memoryItems,
        channelAccounts: channelItems,
        summary: {
          spacesCount: spaceItems.length,
          sessionsCount: sessionItems.length,
          messagesCount: sessionItems.reduce((acc, s) => acc + s.messageCount, 0),
          filesCount: spaceItems.reduce((acc, s) => acc + s.filesCount, 0),
          totalFileBytes: spaceItems.reduce((acc, s) => acc + s.totalFileBytes, 0),
          memoryFilesCount: memoryItems.length,
          channelAccountsCount: channelItems.length,
        },
      })
    }

    const plannedPasswordsFile = options.passwordFile || getDefaultPasswordFilePath()

    // Run collision detection against batch and Enkeep database
    const collisions = detectIdCollisions({
      userPlans,
      sourceDb: srcDb,
      targetDbPath: options.targetDbPath,
      sourceFingerprint: fingerprint,
    })

    for (const c of collisions) {
      warnings.push(`[ID Collision] [${c.table}] ${c.id} (${c.reason}): ${c.message}`)
    }

    if (options.throwOnCollision && collisions.length > 0) {
      const details = collisions.map((c) => `[${c.table}] ${c.id} (${c.reason}): ${c.message}`).join('; ')
      throw new Error(`ID collision detected: ${details}`)
    }

    return {
      sourcePath: options.sourcePath,
      sourceFingerprint: fingerprint,
      dryRun: Boolean(options.dryRun),
      selectedUsers: selectedUsers.map((u) => u.username),
      userPlans,
      plannedPasswordsFile,
      summary: {
        totalUsers: selectedUsers.length,
        totalNewUsers,
        totalExistingUsers,
        totalSpaces,
        totalSessions,
        totalMessages,
        totalMemoryFiles,
        totalFileBytes,
        totalChannelAccounts,
      },
      warnings,
      collisions,
    }
  } finally {
    srcDb.close()
  }
}

/**
 * Executes multi-user migration with strict idempotency, tenant isolation,
 * password security, and container space mapping.
 */
export async function executeMultiUserMigration(
  options: MultiUserMigrateOptions
): Promise<MultiUserMigrationResult> {
  const plan = planMultiUserMigration(options)

  if (plan.collisions && plan.collisions.length > 0) {
    const details = plan.collisions.map((c) => `[${c.table}] ${c.id} (${c.reason}): ${c.message}`).join('; ')
    throw new Error(`ID collision detected: ${details}`)
  }

  if (options.dryRun) {
    return {
      success: true,
      dryRun: true,
      plan,
      executedAt: options.deterministicCreatedAt || new Date().toISOString(),
      targetDbPath: options.targetDbPath,
      targetSpacesDir: options.targetSpacesDir,
    }
  }

  if (!options.targetDbPath) {
    throw new Error('Target Enkeep database path (--target-db) is required when executing live migration')
  }

  assertNotProductionData(options.targetDbPath, 'target database')
  const targetDb = new DatabaseSync(options.targetDbPath)
  const masterKey = resolveMasterEncryptionKey(options.masterKey)
  const createdAt = options.deterministicCreatedAt || new Date().toISOString()

  const targetTables = new Set(
    (targetDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map(
      (t) => t.name
    )
  )

  const generatedPasswords: Record<string, ProvisionedUserPassword> = {}

  // Open source DB in read-only mode
  const realDbPath = validateSourceFile(options.sourcePath, 'source database')
  const srcDb = new DatabaseSync(`file:${realDbPath}?immutable=1&mode=ro`, { readOnly: true })

  try {
    for (const uPlan of plan.userPlans) {
      const targetUserId = uPlan.targetUserId
      const username = uPlan.sourceUser.username
      const displayName = uPlan.sourceUser.displayName

      // Check if user already exists
      const existingUser = targetDb
        .prepare('SELECT id, username, password_hash FROM users WHERE id = ? OR username = ?')
        .get(targetUserId, username) as { id: string; username: string; password_hash: string } | undefined

      let passwordHash: string
      if (existingUser) {
        // PRESERVE existing credentials: do not overwrite password_hash, do not generate new temp password
        passwordHash = existingUser.password_hash
      } else {
        // New user: generate secure temp password, scrypt hash, must_change_password = 1
        const tempPassword = generateSecureTempPassword()
        passwordHash = await hashPasswordScrypt(tempPassword)
        generatedPasswords[username] = {
          userId: targetUserId,
          username,
          tempPassword,
          passwordHash,
          generatedAt: createdAt,
        }
      }

      const userMaterializeItems: SessionMaterializeItem[] = []

      // Begin atomic transaction per user
      targetDb.exec('BEGIN IMMEDIATE')
      try {
        // 1. Upsert User
        if (existingUser) {
          targetDb
            .prepare(
              "UPDATE users SET display_name = ?, status = 'active', updated_at = ? WHERE id = ?"
            )
            .run(displayName, createdAt, existingUser.id)
        } else {
          targetDb
            .prepare(
              `INSERT INTO users (id, username, password_hash, role, status, display_name, must_change_password, created_at, updated_at)
               VALUES (?, ?, ?, 'user', 'active', ?, 1, ?, ?)`
            )
            .run(targetUserId, username, passwordHash, displayName, createdAt, createdAt)
        }

        // 2. Idempotent clean of target user's records ONLY (zero effect on other users)
        const tablesToClean = [
          'turn_runs',
          'delivery_inbox',
          'fixed_import_provenance',
          'fixed_import_receipts',
          'message_attachments',
          'web_events',
          'web_messages',
          'session_sources',
          'session_generations',
          'session_routes',
          'channel_bindings',
          'channel_accounts',
          'channel_encrypted_credentials',
          'task_schedules',
          'platform_tasks',
          'model_selection_overrides',
          'spaces',
        ]
        for (const tbl of tablesToClean) {
          if (targetTables.has(tbl)) {
            targetDb.prepare(`DELETE FROM ${tbl} WHERE user_id = ?`).run(targetUserId)
          }
        }

        // 3. Insert fixed_import_receipts if table exists
        if (targetTables.has('fixed_import_receipts')) {
          targetDb
            .prepare(
              `INSERT INTO fixed_import_receipts (
                user_id, source_fingerprint, importer_version, id_algorithm, target_dsh,
                session_format, source_chats_count, source_messages_count,
                imported_messages_count, dropped_messages_count, attachments_count,
                canonical_hash, created_at
              ) VALUES (?, ?, 'enkeep-migration-v3.0', 'sha256-scoped-v1', 'dsh-v2', 0, ?, ?, ?, 0, 0, ?, ?)`
            )
            .run(
              targetUserId,
              plan.sourceFingerprint,
              uPlan.spaces.length,
              uPlan.summary.messagesCount,
              uPlan.summary.messagesCount,
              sha256Hex(`receipt:${targetUserId}:${plan.sourceFingerprint}`),
              createdAt
            )
        }

        // 4. Insert Spaces (container mode)
        if (targetTables.has('spaces')) {
          const spaceStmt = targetDb.prepare(
            `INSERT INTO spaces (id, user_id, name, folder, execution_mode, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'container', 'active', ?, ?)`
          )

          for (const sp of uPlan.spaces) {
            spaceStmt.run(sp.spaceId, targetUserId, sp.workspaceName, sp.targetFolder, createdAt, createdAt)
          }
        }

        // 5. Insert Sessions, Messages, Generations, Sources & Provenance
        const hasRoutes = targetTables.has('session_routes')
        const hasGens = targetTables.has('session_generations')
        const hasSources = targetTables.has('session_sources')
        const hasMsgs = targetTables.has('web_messages')
        const hasEvents = targetTables.has('web_events')
        const hasProv = targetTables.has('fixed_import_provenance')

        const routeStmt = hasRoutes
          ? targetDb.prepare(
              `INSERT INTO session_routes (
                id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, created_at, updated_at, status, title
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'container', ?, ?, 'active', ?)`
            )
          : null

        const genStmt = hasGens
          ? targetDb.prepare(
              `INSERT INTO session_generations (
                id, user_id, route_id, generation_number, dsh_session_id, reset_reason, created_at
              ) VALUES (?, ?, ?, 1, ?, 'initial', ?)`
            )
          : null

        const srcStmt = hasSources
          ? targetDb.prepare(
              `INSERT INTO session_sources (
                id, route_id, source_type, source_id, user_id, metadata, created_at
              ) VALUES (?, ?, 'happyclaw', ?, ?, ?, ?)`
            )
          : null

        const msgStmt = hasMsgs
          ? targetDb.prepare(
              `INSERT INTO web_messages (
                id, session_id, user_id, role, content, status, route_key, created_at
              ) VALUES (?, ?, ?, ?, ?, 'delivered', ?, ?)`
            )
          : null

        const eventStmt = hasEvents
          ? targetDb.prepare(
              `INSERT INTO web_events (
                id, session_id, user_id, type, payload, created_at
              ) VALUES (?, ?, ?, 'message', ?, ?)`
            )
          : null

        const provStmt = hasProv
          ? targetDb.prepare(
              `INSERT INTO fixed_import_provenance (
                id, user_id, source_fingerprint, source_chat_jid, source_message_id,
                target_space_id, target_route_id, target_dsh_session_id,
                target_message_id, target_event_id, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
          : null

        for (const ses of uPlan.sessions) {
          const isWeChat = ses.chatJid.startsWith('wechat:') || channelFromJid(ses.chatJid) === 'wechat'
          let channel = 'web'
          let accountId = 'default'
          let nativeCtxId = ses.chatJid
          let peerId = ses.targetSessionId

          if (isWeChat) {
            channel = 'wechat'
            const wxAcc = uPlan.channelAccounts.find((ca) => ca.channelType === 'wechat')
            if (wxAcc) {
              accountId = `acc_${sha256Hex(`${targetUserId}:wechat:${wxAcc.sourceAccountId}`).slice(0, 24)}`
            } else {
              accountId = `acc_hpc_wechat_${targetUserId}`
            }
            const cleanJid = ses.chatJid.trim()
            const withoutPrefix = cleanJid.replace(/^wechat:/, '')
            nativeCtxId = `wechat:${withoutPrefix}`
            peerId = withoutPrefix
          }

          routeStmt?.run(
            ses.targetSessionId,
            ses.spaceId,
            targetUserId,
            channel,
            accountId,
            nativeCtxId,
            peerId,
            ses.targetSessionId,
            createdAt,
            createdAt,
            ses.title
          )

          if (targetTables.has('spaces')) {
            try {
              targetDb
                .prepare(
                  `UPDATE spaces SET canonical_session_id = ? WHERE id = ? AND (canonical_session_id IS NULL OR canonical_session_id = '')`
                )
                .run(ses.targetSessionId, ses.spaceId)
            } catch {
              // ignore
            }
          }

          const genId = `gen_${sha256Hex(`${targetUserId}:${ses.targetSessionId}:1`).slice(0, 24)}`
          genStmt?.run(genId, targetUserId, ses.targetSessionId, ses.targetSessionId, createdAt)

          const sourceId = `src_${sha256Hex(`${targetUserId}:${ses.targetSessionId}:${ses.chatJid}`).slice(0, 24)}`
          srcStmt?.run(
            sourceId,
            ses.targetSessionId,
            ses.chatJid,
            targetUserId,
            JSON.stringify({ sourceChatJid: ses.chatJid, importedAt: createdAt }),
            createdAt
          )

          // Read messages from source if messages table exists
          const srcHasMsgs = (srcDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'").get()) !== undefined
          const msgs = srcHasMsgs
            ? ((srcDb
                .prepare('SELECT id, content, is_from_me, timestamp, attachments FROM messages WHERE chat_jid = ? ORDER BY timestamp ASC, id ASC')
                .all(ses.chatJid) as unknown[]) as Array<{
                id: string
                content?: string | null
                is_from_me?: number | boolean | null
                timestamp?: string | null
                attachments?: string | null
              }>)
            : []

          for (const m of msgs) {
            const role = m.is_from_me ? 'assistant' : 'user'
            const content = m.content || ''
            const targetMsgId = deterministicMessageId(ses.chatJid, m.id)
            const eventId = `ev_${sha256Hex(`${targetUserId}:${ses.targetSessionId}:${targetMsgId}`).slice(0, 24)}`
            const provId = `prov_${sha256Hex(`${targetUserId}:${ses.chatJid}:${m.id}`).slice(0, 24)}`
            const msgCreatedAt = m.timestamp || createdAt

            msgStmt?.run(targetMsgId, ses.targetSessionId, targetUserId, role, content, ses.targetRouteKey, msgCreatedAt)

            eventStmt?.run(
              eventId,
              ses.targetSessionId,
              targetUserId,
              JSON.stringify({
                id: targetMsgId,
                sessionId: ses.targetSessionId,
                role,
                content,
                routeKey: ses.targetRouteKey,
              }),
              msgCreatedAt
            )

            provStmt?.run(
              provId,
              targetUserId,
              plan.sourceFingerprint,
              ses.chatJid,
              m.id,
              ses.spaceId,
              ses.targetSessionId,
              ses.targetSessionId,
              targetMsgId,
              eventId,
              createdAt
            )
          }

          const msgRows = msgs.map((m) => ({
            id: m.id,
            chat_jid: ses.chatJid,
            content: m.content || '',
            timestamp: m.timestamp || null,
            is_from_me: m.is_from_me ? 1 : 0,
            attachments: m.attachments || null,
          }))
          const compiled = compileSeed(ses.chatJid, msgRows)
          const seed = compiled.seed.length > 0 ? compiled.seed : [{ type: 'session/end-seed', seq: 0, time: Date.now(), data: {} }]
          userMaterializeItems.push({
            sessionId: ses.targetSessionId,
            folder: ses.targetFolder,
            seed,
            chatJid: ses.chatJid,
          })
        }

        // 6. Channel accounts & credentials (DISABLED + encrypted/placeholder)
        const hasChan = targetTables.has('channel_accounts')
        const hasEncCred = targetTables.has('channel_encrypted_credentials')
        const hasBind = targetTables.has('channel_bindings')

        const chanStmt = hasChan
          ? targetDb.prepare(
              `INSERT INTO channel_accounts (
                id, user_id, type, status, credential_ref, created_at, updated_at
              ) VALUES (?, ?, ?, 'disabled', ?, ?, ?)`
            )
          : null

        const encCredStmt = hasEncCred
          ? targetDb.prepare(
              `INSERT INTO channel_encrypted_credentials (
                id, user_id, credential_ref, encrypted_payload, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?)`
            )
          : null

        const bindStmt = hasBind
          ? targetDb.prepare(
              `INSERT INTO channel_bindings (
                id, user_id, account_id, space_id, native_context_id, activation_mode, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, 'mention', ?, ?)`
            )
          : null

        const srcHasChan = (srcDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='channel_accounts'").get()) !== undefined
        const chanRows = srcHasChan
          ? ((srcDb
              .prepare('SELECT * FROM channel_accounts WHERE owner_user_id = ?')
              .all(uPlan.sourceUser.id) as unknown[]) as Array<{ id: string; provider?: string; name?: string }>)
          : []

        for (const ch of chanRows) {
          const credInfo = prepareChannelAccountCredential(ch, targetUserId, masterKey)
          const targetAccId = `acc_${sha256Hex(`${targetUserId}:${credInfo.channelType}:${ch.id}`).slice(0, 24)}`

          chanStmt?.run(
            targetAccId,
            targetUserId,
            credInfo.channelType,
            credInfo.credentialRef,
            createdAt,
            createdAt
          )

          if (credInfo.encryptedPayload && encCredStmt) {
            const encId = `enc_${randomBytes(8).toString('hex')}`
            encCredStmt.run(
              encId,
              targetUserId,
              credInfo.credentialRef,
              credInfo.encryptedPayload,
              createdAt,
              createdAt
            )
          }

          // Create disabled bindings to user spaces
          if (bindStmt) {
            if (credInfo.channelType === 'wechat') {
              const wxSessions = uPlan.sessions.filter(
                (s) => s.chatJid.startsWith('wechat:') || channelFromJid(s.chatJid) === 'wechat'
              )
              if (wxSessions.length > 0) {
                for (const ws of wxSessions) {
                  const cleanJid = ws.chatJid.trim()
                  const withoutPrefix = cleanJid.replace(/^wechat:/, '')
                  const senderWithDomain = withoutPrefix
                  const senderWithoutDomain = withoutPrefix.replace(/@im\.wechat$/, '').replace(/@[^@]+$/, '')

                  const ctxIds = new Set<string>()
                  ctxIds.add(`wechat:${senderWithDomain}`)
                  if (senderWithoutDomain && senderWithoutDomain !== senderWithDomain) {
                    ctxIds.add(`wechat:${senderWithoutDomain}`)
                  }
                  if (senderWithDomain) ctxIds.add(senderWithDomain)
                  if (cleanJid) ctxIds.add(cleanJid)

                  for (const ctxId of ctxIds) {
                    const bindId = `bind_${sha256Hex(`${targetAccId}:${ctxId}`).slice(0, 24)}`
                    bindStmt.run(
                      bindId,
                      targetUserId,
                      targetAccId,
                      ws.spaceId,
                      ctxId,
                      createdAt,
                      createdAt
                    )
                  }
                }
              } else {
                for (const sp of uPlan.spaces) {
                  const bindId = `bind_${sha256Hex(`${targetAccId}:${sp.workspaceJid}`).slice(0, 24)}`
                  bindStmt.run(
                    bindId,
                    targetUserId,
                    targetAccId,
                    sp.spaceId,
                    sp.workspaceJid,
                    createdAt,
                    createdAt
                  )
                }
              }
            } else {
              for (const sp of uPlan.spaces) {
                const bindId = `bind_${sha256Hex(`${targetAccId}:${sp.workspaceJid}`).slice(0, 24)}`
                bindStmt.run(
                  bindId,
                  targetUserId,
                  targetAccId,
                  sp.spaceId,
                  sp.workspaceJid,
                  createdAt,
                  createdAt
                )
              }
            }
          }
        }

        // Commit transaction
        targetDb.exec('COMMIT')
      } catch (err) {
        targetDb.exec('ROLLBACK')
        throw err
      }

      // Copy files to target directory if requested
      if (options.targetSpacesDir) {
        assertNotProductionData(options.targetSpacesDir, 'target spaces directory')
        for (const sp of uPlan.spaces) {
          if (options.sourceGroupsDir) {
            const srcDir = join(options.sourceGroupsDir, sp.srcFolder)
            const destDir = join(options.targetSpacesDir, sp.targetFolder)
            copySpaceFilesSafely(srcDir, destDir)
          }
        }
        copyMemoryFilesSafely(uPlan.memoryFiles, options.targetSpacesDir)
      }

      // 7. Materialize seeds in target runtime daemon if socket or session path available
      const socketPath =
        options.runtimeSocketPath ||
        process.env.ENKEEP_RUNTIME_SOCKET ||
        process.env.DSH_DAEMON_SOCKET_PATH ||
        (existsSync('/tmp/enkeep-runtime.sock') ? '/tmp/enkeep-runtime.sock' : undefined)
      if (socketPath || options.runtimeSessionsDir) {
        await materializeSessions(userMaterializeItems, {
          runtimeSocketPath: socketPath,
          runtimeSessionsDir: options.runtimeSessionsDir,
          dryRun: options.dryRun,
        })
      }
    }

    // Save temporary passwords in private 0600 file ONLY if any new passwords were generated
    let passwordsFile: string | undefined = undefined
    if (Object.keys(generatedPasswords).length > 0) {
      passwordsFile = savePrivatePasswordsFile(generatedPasswords, options.passwordFile)
    }

    return {
      success: true,
      dryRun: false,
      plan,
      passwordsFile,
      executedAt: createdAt,
      targetDbPath: options.targetDbPath,
      targetSpacesDir: options.targetSpacesDir,
    }
  } finally {
    srcDb.close()
    targetDb.close()
  }
}
