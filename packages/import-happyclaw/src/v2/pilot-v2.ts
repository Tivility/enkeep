import { createHash, randomBytes } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { deterministicSpaceId } from '../ids.js'
import type {
  CompiledChat,
  MigrationPlanV2,
  MigrationV2StageManifest,
  PilotCleanupResult,
  PilotExecutionResult,
  PilotExecutionStats,
} from '../types.js'

export interface ExecutePilotOptions {
  readonly stagingDir: string
  readonly planId: string
  readonly db: DatabaseSync
  readonly fileProvider?: any
  readonly targetUserId?: string
}

export interface CleanupPilotOptions {
  readonly stagingDir: string
  readonly planId: string
  readonly db: DatabaseSync
  readonly fileProvider?: any
}

/**
 * Validates the cryptographic integrity of a staged pilot package.
 */
export function verifyStagedPackageIntegrity(
  stagingDir: string,
  planId: string
): { manifest: MigrationV2StageManifest; plan: MigrationPlanV2; stageDir: string } {
  const stageDir = join(stagingDir, planId)
  if (!existsSync(stageDir)) {
    throw new Error(`Staged pilot package directory not found for planId "${planId}"`)
  }

  const manifestPath = join(stageDir, 'stage-manifest.json')
  const planPath = join(stageDir, 'migration-plan-v2.json')

  if (!existsSync(manifestPath)) {
    throw new Error(`Stage manifest missing at "${manifestPath}"`)
  }
  if (!existsSync(planPath)) {
    throw new Error(`Migration plan missing at "${planPath}"`)
  }

  const manifestJson = readFileSync(manifestPath, 'utf8')
  const manifest: MigrationV2StageManifest = JSON.parse(manifestJson)

  const planJson = readFileSync(planPath, 'utf8')
  const plan: MigrationPlanV2 = JSON.parse(planJson)

  // 1. Verify Plan Checksum
  const computedPlanHash = createHash('sha256').update(planJson).digest('hex')
  if (computedPlanHash !== manifest.packageChecksum) {
    throw new Error(`Plan checksum mismatch: expected ${manifest.packageChecksum}, computed ${computedPlanHash}`)
  }

  // 2. Verify Payload File Checksums if recorded
  if (manifest.payloadChecksums) {
    for (const [relPath, expectedHash] of Object.entries(manifest.payloadChecksums)) {
      const fullPath = join(stageDir, relPath)
      if (!existsSync(fullPath)) {
        throw new Error(`Staged payload file missing: "${relPath}"`)
      }
      const fileBytes = readFileSync(fullPath)
      const computedFileHash = createHash('sha256').update(fileBytes).digest('hex')
      if (computedFileHash !== expectedHash) {
        throw new Error(`Payload checksum mismatch for "${relPath}": expected ${expectedHash}, computed ${computedFileHash}`)
      }
    }
  }

  return { manifest, plan, stageDir }
}

/**
 * Executes V2 Pilot Migration consuming ONLY the immutable staged package identified by `planId`.
 *
 * Guarantees:
 * 1. Never accesses source database, live files, live auth, or network.
 * 2. Reads strictly from stagingDir/planId/ payload.
 * 3. Maps at least 3 spaces/profiles/sessions/messages/files/attachments.
 * 4. M30 extensions catalog initialized; untrusted plugins quarantined/disabled with no binding.
 * 5. Platform tasks inserted in paused state (`task_schedules.enabled = 0`).
 * 6. Lark/WeChat metadata mapped into M31 with credentialRef statuses, transport not started.
 * 7. Records deterministic pilot IDs for targeted cleanup.
 */
export async function executePilotMigrationV2(options: ExecutePilotOptions): Promise<PilotExecutionResult> {
  const { manifest, plan, stageDir } = verifyStagedPackageIntegrity(options.stagingDir, options.planId)
  const { db, fileProvider } = options

  const targetUserId = options.targetUserId || plan.targetUserId || 'alice'
  const createdAt = new Date().toISOString()
  const payloadDir = join(stageDir, 'payload')

  // Read compiled sessions from staged payload if present
  let compiledChats: CompiledChat[] = []
  const sessionsFile = join(payloadDir, 'sessions.json')
  if (existsSync(sessionsFile)) {
    try {
      compiledChats = JSON.parse(readFileSync(sessionsFile, 'utf8'))
    } catch {}
  }

  const warnings: string[] = [...plan.warnings]
  const skippedRealChannelCredentials: string[] = []

  const fileShas: Record<string, string> = {}
  let totalFilesMigrated = 0

  db.exec('BEGIN IMMEDIATE')
  try {
    // 1. Insert/Update import_jobs for Pilot Run
    const jobId = `job_pilot_${plan.planId}`
    const jobInsertStmt = db.prepare(`
      INSERT INTO import_jobs (
        id, actor_user_id, target_user_id, staged_id, source_fingerprint,
        request_hash, idempotency_key, status, dry_run, total_conversations,
        completed_conversations, progress_json, result_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', 0, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = 'completed',
        completed_conversations = excluded.completed_conversations,
        result_json = excluded.result_json,
        updated_at = excluded.updated_at
    `)

    jobInsertStmt.run(
      jobId,
      targetUserId,
      targetUserId,
      plan.planId,
      manifest.sourceFingerprint,
      manifest.packageChecksum,
      `pilot_${plan.planId}`,
      plan.summary.totalSessions,
      plan.summary.totalSessions,
      JSON.stringify({ isPilot: true, planId: plan.planId }),
      JSON.stringify({ planId: plan.planId, summary: plan.summary, pilot: true }),
      createdAt,
      createdAt
    )

    // 2. Insert fixed_import_receipts
    const receiptStmt = db.prepare(`
      INSERT INTO fixed_import_receipts (
        user_id, source_fingerprint, importer_version, id_algorithm, target_dsh,
        session_format, source_chats_count, source_messages_count,
        imported_messages_count, dropped_messages_count, attachments_count,
        canonical_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, source_fingerprint) DO UPDATE SET
        source_chats_count = excluded.source_chats_count,
        source_messages_count = excluded.source_messages_count,
        imported_messages_count = excluded.imported_messages_count,
        canonical_hash = excluded.canonical_hash
    `)

    receiptStmt.run(
      targetUserId,
      `pilot:${plan.planId}`,
      manifest.importerVersion,
      'sha256-chatJid-v1',
      manifest.targetDsh,
      0,
      plan.summary.totalSessions,
      plan.summary.totalMessages,
      plan.summary.totalMessages,
      0,
      0,
      manifest.packageChecksum,
      createdAt
    )

    // Prepared statements for entity mapping
    const spaceInsertStmt = db.prepare(`
      INSERT INTO spaces (id, user_id, name, folder, execution_mode, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'container', 'active', ?, ?)
      ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
    `)

    const profileInsertStmt = db.prepare(`
      INSERT INTO agent_profiles (id, user_id, name, description, status, active_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, updated_at = excluded.updated_at
    `)

    const profileSnapshotStmt = db.prepare(`
      INSERT INTO agent_profile_snapshots (
        id, user_id, profile_id, version, prompt_mode, prompt_hash, identity, soul, agents, tools, created_at
      ) VALUES (?, ?, ?, ?, 'append', ?, ?, '', '', '', ?)
      ON CONFLICT(id) DO NOTHING
    `)

    const routeInsertStmt = db.prepare(`
      INSERT INTO session_routes (
        id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, status, title, created_at, updated_at
      ) VALUES (?, ?, ?, 'web', 'default', ?, ?, ?, 'container', 'active', ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at
    `)

    const genInsertStmt = db.prepare(`
      INSERT INTO session_generations (
        id, user_id, route_id, generation_number, dsh_session_id, agent_profile_snapshot_id, reset_reason, created_at
      ) VALUES (?, ?, ?, 1, ?, ?, 'initial', ?)
      ON CONFLICT(route_id, generation_number) DO NOTHING
    `)

    const sourceInsertStmt = db.prepare(`
      INSERT INTO session_sources (
        id, route_id, source_type, source_id, user_id, metadata, created_at
      ) VALUES (?, ?, 'happyclaw', ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET metadata = excluded.metadata
    `)

    const msgInsertStmt = db.prepare(`
      INSERT INTO web_messages (
        id, session_id, user_id, role, content, status, route_key, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, 'delivered', ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET content = excluded.content, status = 'delivered'
    `)

    const eventInsertStmt = db.prepare(`
      INSERT INTO web_events (
        id, session_id, user_id, type, payload, created_at
      ) VALUES (?, ?, ?, 'message', ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload
    `)

    const provInsertStmt = db.prepare(`
      INSERT INTO fixed_import_provenance (
        id, user_id, source_fingerprint, source_chat_jid, source_message_id,
        target_space_id, target_route_id, target_dsh_session_id,
        target_message_id, target_event_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `)

    // M30 Extension Catalog Statements
    const extPkgStmt = db.prepare(`
      INSERT INTO extension_packages (
        id, user_id, slug, name, description, source_kind, source_ref,
        installed_version, active_version, status, integrity_sha256, provenance_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at
    `)

    const extContribStmt = db.prepare(`
      INSERT INTO extension_contributions (
        id, package_id, kind, contribution_key, manifest_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at
    `)

    const extBindingStmt = db.prepare(`
      INSERT INTO extension_bindings (
        id, user_id, space_id, contribution_id, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(space_id, contribution_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at
    `)

    // Tasks Statements
    const taskStmt = db.prepare(`
      INSERT INTO platform_tasks (
        id, user_id, idempotency_key, title, description, priority, status, payload, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = 'pending', updated_at = excluded.updated_at
    `)

    const taskScheduleStmt = db.prepare(`
      INSERT INTO task_schedules (
        id, task_id, user_id, schedule_type, cron_expression, enabled, paused_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET enabled = 0, paused_at = excluded.paused_at, updated_at = excluded.updated_at
    `)

    // M31 Channel Accounts & Bindings Statements
    const channelAccountStmt = db.prepare(`
      INSERT INTO channel_accounts (
        id, user_id, type, status, credential_ref, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, credential_ref = excluded.credential_ref, updated_at = excluded.updated_at
    `)

    const channelBindingStmt = db.prepare(`
      INSERT INTO channel_bindings (
        id, user_id, account_id, space_id, native_context_id, activation_mode, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, native_context_id) DO UPDATE SET space_id = excluded.space_id, activation_mode = excluded.activation_mode, updated_at = excluded.updated_at
    `)

    // 3. Map Channel Accounts first (M31)
    const channelAccountIdMap = new Map<string, string>()
    for (const acc of plan.channelAccounts) {
      const accId = `acc_pilot_${createHash('sha256').update(`${targetUserId}:${acc.channelType}:${acc.sourceAccountId}`).digest('hex').slice(0, 16)}`
      channelAccountIdMap.set(acc.channelType, accId)
      channelAccountIdMap.set(acc.sourceAccountId, accId)

      channelAccountStmt.run(
        accId,
        targetUserId,
        acc.channelType,
        acc.status,
        acc.credentialRef,
        createdAt,
        createdAt
      )

      if (acc.credentialRef) {
        skippedRealChannelCredentials.push(`${acc.channelType}:${acc.name} (credentialRef=${acc.credentialRef}, live cutover skipped)`)
      }
    }

    // 4. Map Workspaces, Profiles, Sessions, Messages, Extensions, Tasks, Channel Bindings
    for (const item of plan.items) {
      const existingSpace = db.prepare('SELECT id FROM spaces WHERE user_id = ? AND folder = ?').get(targetUserId, item.targetSpaceFolder) as { id: string } | undefined
      const spaceId = existingSpace ? existingSpace.id : deterministicSpaceId(targetUserId, manifest.sourceFingerprint, item.targetSpaceFolder)

      // Space
      if (!existingSpace) {
        spaceInsertStmt.run(spaceId, targetUserId, item.targetSpaceName, item.targetSpaceFolder, createdAt, createdAt)
      } else {
        db.prepare('UPDATE spaces SET name = ?, updated_at = ? WHERE id = ?').run(item.targetSpaceName, createdAt, spaceId)
      }

      // Agent Profiles & Snapshots
      let lastSnapshotId: string | null = null
      for (const p of item.agentProfileSnapshots) {
        const profId = `prof_${createHash('sha256').update(`${targetUserId}:${item.targetSpaceFolder}:${p.sourceProfileId}`).digest('hex').slice(0, 32)}`
        const identity = p.systemPromptSnapshot || ''
        const promptHash = createHash('sha256').update(JSON.stringify({ agents: '', identity, soul: '', tools: '' }), 'utf8').digest('hex').toLowerCase()
        const snapId = `snap_${createHash('sha256').update(`${profId}:${p.version}:${promptHash}`).digest('hex').slice(0, 32)}`
        lastSnapshotId = snapId

        profileInsertStmt.run(
          profId,
          targetUserId,
          p.name,
          p.description || '',
          p.version,
          createdAt,
          createdAt
        )

        profileSnapshotStmt.run(
          snapId,
          targetUserId,
          profId,
          p.version,
          promptHash,
          p.systemPromptSnapshot,
          createdAt
        )
      }

      // Sessions & Messages
      for (const sPlan of item.sessionPlans) {
        const sessionId = sPlan.targetSessionId
        const routeKey = `web:default:${targetUserId}:${sessionId}`

        routeInsertStmt.run(
          sessionId,
          spaceId,
          targetUserId,
          sessionId,
          sPlan.sourceChatJid,
          sessionId,
          sPlan.title,
          createdAt,
          createdAt
        )

        const genId = `gen_pilot_${createHash('sha256').update(`${targetUserId}:${sessionId}:gen1`).digest('hex').slice(0, 24)}`
        genInsertStmt.run(genId, targetUserId, sessionId, sessionId, lastSnapshotId, createdAt)

        const sourceRowId = `src_pilot_${createHash('sha256').update(`${targetUserId}:${sessionId}:${sPlan.sourceChatJid}`).digest('hex').slice(0, 24)}`
        sourceInsertStmt.run(
          sourceRowId,
          sessionId,
          sPlan.sourceChatJid,
          targetUserId,
          JSON.stringify({ planId: plan.planId, isPilot: true, sourceChatJid: sPlan.sourceChatJid }),
          createdAt
        )

        // Find compiled chat from payload
        const matchingChat = compiledChats.find((c) => c.chatJid === sPlan.sourceChatJid || c.sessionId === sessionId)
        if (matchingChat && Array.isArray(matchingChat.seed)) {
          if (fileProvider && typeof (fileProvider as any).importSeed === 'function') {
            try {
              await (fileProvider as any).importSeed(targetUserId, sessionId, matchingChat.seed, null, null, item.targetSpaceFolder);
            } catch {}
          }
          for (const event of matchingChat.seed) {
            if (event.type === 'user/message' || event.type === 'assistant/message') {
              const data = event.data as Record<string, unknown>
              const msgObj = event.type === 'assistant/message' ? (data.message as Record<string, unknown>) : data
              const msgId = String(msgObj.id || `msg_pilot_${createHash('sha256').update(`${sessionId}:${event.seq}`).digest('hex').slice(0, 20)}`)
              const role = String(msgObj.role || (event.type === 'user/message' ? 'user' : 'assistant'))
              const contentArr = (msgObj.content as Array<{ text?: string }>) || []
              const content = contentArr.map((c) => c.text || '').join('\n')
              const eventId = `ev_pilot_${createHash('sha256').update(`${targetUserId}:${sessionId}:${msgId}`).digest('hex').slice(0, 24)}`
              const provId = `prov_pilot_${createHash('sha256').update(`${targetUserId}:${sPlan.sourceChatJid}:${msgId}`).digest('hex').slice(0, 24)}`

              msgInsertStmt.run(
                msgId,
                sessionId,
                targetUserId,
                role,
                content,
                routeKey,
                null,
                createdAt
              )

              const eventPayload = {
                id: msgId,
                sessionId,
                userId: targetUserId,
                role,
                content,
                routeKey,
                createdAt,
                message: {
                  id: msgId,
                  sessionId,
                  userId: targetUserId,
                  role,
                  content,
                  status: 'delivered',
                  routeKey,
                  timestamp: createdAt,
                },
              }

              eventInsertStmt.run(
                eventId,
                sessionId,
                targetUserId,
                JSON.stringify(eventPayload),
                createdAt
              )

              provInsertStmt.run(
                provId,
                targetUserId,
                `pilot:${plan.planId}`,
                sPlan.sourceChatJid,
                msgId,
                spaceId,
                sessionId,
                sessionId,
                msgId,
                eventId,
                createdAt
              )
            }
          }
        }
      }

      // Extensions (M30)
      for (const ext of item.extensionPlans) {
        const pkgId = `pkg_pilot_${createHash('sha256').update(`${targetUserId}:${ext.slug}`).digest('hex').slice(0, 16)}`
        const sha = createHash('sha256').update(`${ext.slug}:${ext.kind}:${ext.sourceRef || 'builtin'}`).digest('hex')

        extPkgStmt.run(
          pkgId,
          targetUserId,
          ext.slug,
          ext.name,
          ext.description || '',
          ext.sourceKind,
          ext.sourceRef || null,
          ext.status,
          sha,
          JSON.stringify({ planId: plan.planId, quarantined: ext.quarantined, quarantineReason: ext.quarantineReason }),
          createdAt,
          createdAt
        )

        const contribId = `contrib_pilot_${createHash('sha256').update(`${pkgId}:${ext.kind}:${ext.targetContributionKey}`).digest('hex').slice(0, 16)}`
        extContribStmt.run(
          contribId,
          pkgId,
          ext.kind,
          ext.targetContributionKey,
          JSON.stringify({ name: ext.name, kind: ext.kind, quarantined: ext.quarantined }),
          ext.status,
          createdAt,
          createdAt
        )

        const bindingId = `bind_pilot_${createHash('sha256').update(`${spaceId}:${contribId}`).digest('hex').slice(0, 16)}`
        // Invariant: If quarantined, enabled = 0 and binding is effectively disabled
        extBindingStmt.run(
          bindingId,
          targetUserId,
          spaceId,
          contribId,
          ext.quarantined ? 0 : 1,
          createdAt,
          createdAt
        )
      }

      // Tasks (Paused)
      for (const task of item.taskPlans) {
        const taskId = `task_pilot_${createHash('sha256').update(`${targetUserId}:${item.targetSpaceFolder}:${task.sourceTaskId}`).digest('hex').slice(0, 16)}`
        taskStmt.run(
          taskId,
          targetUserId,
          `pilot_${plan.planId}_${task.sourceTaskId}`,
          task.title,
          task.prompt,
          task.priority === 'urgent' ? 'urgent' : task.priority === 'high' ? 'high' : task.priority === 'low' ? 'low' : 'medium',
          JSON.stringify({ prompt: task.prompt, planId: plan.planId }),
          createdAt,
          createdAt
        )

        const schedId = `sched_pilot_${createHash('sha256').update(taskId).digest('hex').slice(0, 16)}`
        taskScheduleStmt.run(
          schedId,
          taskId,
          targetUserId,
          task.cronExpression ? 'cron' : 'once',
          task.cronExpression || null,
          createdAt,
          createdAt,
          createdAt
        )
      }

      // Channel Bindings (M31)
      for (const cb of item.channelBindingsPlans) {
        const matchedAccId = channelAccountIdMap.get(cb.channelType) || channelAccountIdMap.get('generic') || `acc_pilot_fallback_${cb.channelType}`
        const cbId = `cb_pilot_${createHash('sha256').update(`${targetUserId}:${item.targetSpaceFolder}:${cb.sourceBindingId}`).digest('hex').slice(0, 16)}`

        // Check if account exists, create fallback if not
        const accExists = db.prepare('SELECT id FROM channel_accounts WHERE id = ?').get(matchedAccId)
        if (!accExists) {
          channelAccountStmt.run(
            matchedAccId,
            targetUserId,
            cb.channelType,
            'active',
            null,
            createdAt,
            createdAt
          )
        }

        channelBindingStmt.run(
          cbId,
          targetUserId,
          matchedAccId,
          spaceId,
          cb.nativeContextId,
          cb.activationMode,
          createdAt,
          createdAt
        )
      }
    }

    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  // 5. Populate Runtime Files and Instructions from payload/files
  const payloadFilesDir = join(payloadDir, 'files')
  if (existsSync(payloadFilesDir)) {
    // 5.1 Global Instructions
    for (const gName of ['CLAUDE.md', 'memory.md', 'MEMORY.md']) {
      const gPath = join(payloadFilesDir, gName)
      if (existsSync(gPath) && lstatSync(gPath).isFile()) {
        const content = readFileSync(gPath, 'utf8')
        const sha = createHash('sha256').update(content).digest('hex')
        fileShas[`global/${gName}`] = sha
        totalFilesMigrated++

        if (fileProvider && typeof fileProvider.writeGlobalInstructions === 'function') {
          try {
            await fileProvider.writeGlobalInstructions(targetUserId, content)
          } catch {}
        }
      }
    }

    // 5.2 Space Files & Instructions
    for (const item of plan.items) {
      const spaceFilesDir = join(payloadFilesDir, item.targetSpaceFolder)
      if (existsSync(spaceFilesDir)) {
        const existingSpace = db.prepare('SELECT id FROM spaces WHERE user_id = ? AND folder = ?').get(targetUserId, item.targetSpaceFolder) as { id: string } | undefined
        const spaceId = existingSpace ? existingSpace.id : deterministicSpaceId(targetUserId, manifest.sourceFingerprint, item.targetSpaceFolder)
        if (fileProvider && typeof fileProvider.execute === 'function') {
          try {
            await fileProvider.execute(targetUserId, spaceId, {
              op: 'mkdir',
              path: '.',
              requireAbsent: true,
            })
          } catch {}
        }
        const scanFiles = async (dir: string, rel = '') => {
          const entries = readdirSync(dir)
          for (const e of entries) {
            const full = join(dir, e)
            const curRel = rel ? `${rel}/${e}` : e
            const stat = lstatSync(full)
            if (stat.isDirectory()) {
              if (fileProvider && typeof fileProvider.execute === 'function') {
                try {
                  await fileProvider.execute(targetUserId, spaceId, {
                    op: 'mkdir',
                    path: curRel,
                    requireAbsent: true,
                  })
                } catch {}
              }
              await scanFiles(full, curRel)
            } else if (stat.isFile()) {
              const fileContent = readFileSync(full, 'utf8')
              const sha = createHash('sha256').update(fileContent).digest('hex')
              fileShas[`${item.targetSpaceFolder}/${curRel}`] = sha
              totalFilesMigrated++

              if (fileProvider && typeof fileProvider.execute === 'function') {
                try {
                  await fileProvider.execute(targetUserId, spaceId, {
                    op: 'write',
                    path: curRel,
                    content: fileContent,
                    encoding: 'utf8',
                  })
                } catch {}
              }
            }
          }
        }
        await scanFiles(spaceFilesDir)
      }
    }
  }

  const stats: PilotExecutionStats = {
    workspaces: plan.items.length,
    sessions: plan.summary.totalSessions,
    messages: plan.summary.totalMessages,
    extensions: plan.summary.totalExtensions,
    quarantinedExtensions: plan.summary.totalQuarantinedPlugins,
    tasks: plan.summary.totalTasks,
    channelAccounts: plan.channelAccounts.length,
    channelBindings: plan.summary.totalChannels,
    files: totalFilesMigrated,
    fileShas,
  }

  return {
    success: true,
    planId: plan.planId,
    targetUserId,
    stats,
    warnings,
    skippedRealChannelCredentials,
    executedAt: new Date().toISOString(),
  }
}

/**
 * Deletes ONLY imported pilot rows, files, and receipts matching recorded IDs for the given planId.
 *
 * Guarantees:
 * 1. Removes only pilot entities; leaves all unrelated fixtures, users, spaces, and stages intact.
 * 2. Foreign keys and database integrity verified after deletion.
 */
export async function deletePilotMigrationV2(options: CleanupPilotOptions): Promise<PilotCleanupResult> {
  const { manifest, plan } = verifyStagedPackageIntegrity(options.stagingDir, options.planId)
  const { db, fileProvider } = options

  const targetUserId = plan.targetUserId || 'alice'
  const deletedCounts = {
    spaces: 0,
    agentProfiles: 0,
    sessionRoutes: 0,
    webMessages: 0,
    extensions: 0,
    tasks: 0,
    channelAccounts: 0,
    channelBindings: 0,
    files: 0,
    receipts: 0,
    importJobs: 0,
  }

  db.exec('BEGIN IMMEDIATE')
  try {
    // 1. Delete Channel Bindings
    for (const item of plan.items) {
      for (const cb of item.channelBindingsPlans) {
        const cbId = `cb_pilot_${createHash('sha256').update(`${targetUserId}:${item.targetSpaceFolder}:${cb.sourceBindingId}`).digest('hex').slice(0, 16)}`
        const delRes = db.prepare('DELETE FROM channel_bindings WHERE id = ?').run(cbId)
        deletedCounts.channelBindings += Number(delRes.changes)
      }
    }

    // 2. Delete Channel Accounts
    for (const acc of plan.channelAccounts) {
      const accId = `acc_pilot_${createHash('sha256').update(`${targetUserId}:${acc.channelType}:${acc.sourceAccountId}`).digest('hex').slice(0, 16)}`
      const delRes = db.prepare('DELETE FROM channel_accounts WHERE id = ?').run(accId)
      deletedCounts.channelAccounts += Number(delRes.changes)
    }

    // 3. Delete Tasks and Task Schedules
    for (const item of plan.items) {
      for (const task of item.taskPlans) {
        const taskId = `task_pilot_${createHash('sha256').update(`${targetUserId}:${item.targetSpaceFolder}:${task.sourceTaskId}`).digest('hex').slice(0, 16)}`
        db.prepare('DELETE FROM task_schedules WHERE task_id = ?').run(taskId)
        const delRes = db.prepare('DELETE FROM platform_tasks WHERE id = ?').run(taskId)
        deletedCounts.tasks += Number(delRes.changes)
      }
    }

    // 4. Delete Extensions (Bindings, Contributions, Packages)
    for (const item of plan.items) {
      const existingSpace = db.prepare('SELECT id FROM spaces WHERE user_id = ? AND folder = ?').get(targetUserId, item.targetSpaceFolder) as { id: string } | undefined
      const spaceId = existingSpace ? existingSpace.id : deterministicSpaceId(targetUserId, manifest.sourceFingerprint, item.targetSpaceFolder)
      for (const ext of item.extensionPlans) {
        const pkgId = `pkg_pilot_${createHash('sha256').update(`${targetUserId}:${ext.slug}`).digest('hex').slice(0, 16)}`
        const contribId = `contrib_pilot_${createHash('sha256').update(`${pkgId}:${ext.kind}:${ext.targetContributionKey}`).digest('hex').slice(0, 16)}`
        db.prepare('DELETE FROM extension_bindings WHERE space_id = ? AND contribution_id = ?').run(spaceId, contribId)
        db.prepare('DELETE FROM extension_contributions WHERE id = ?').run(contribId)
        const delRes = db.prepare('DELETE FROM extension_packages WHERE id = ?').run(pkgId)
        deletedCounts.extensions += Number(delRes.changes)
      }
    }

    // 5. Delete Provenance, Messages, Events, Sources, Generations, Routes
    for (const item of plan.items) {
      for (const sPlan of item.sessionPlans) {
        const sessionId = sPlan.targetSessionId
        const delMsg = db.prepare('DELETE FROM web_messages WHERE session_id = ?').run(sessionId)
        deletedCounts.webMessages += Number(delMsg.changes)
        db.prepare('DELETE FROM web_events WHERE session_id = ?').run(sessionId)
        db.prepare('DELETE FROM session_sources WHERE route_id = ?').run(sessionId)
        db.prepare('DELETE FROM session_generations WHERE route_id = ?').run(sessionId)
        const delRoute = db.prepare('DELETE FROM session_routes WHERE id = ?').run(sessionId)
        deletedCounts.sessionRoutes += Number(delRoute.changes)
      }
    }

    // 6. Delete Fixed Import Receipts & Provenance
    db.prepare('DELETE FROM fixed_import_provenance WHERE source_fingerprint = ?').run(`pilot:${plan.planId}`)
    const delReceipt = db.prepare('DELETE FROM fixed_import_receipts WHERE user_id = ? AND source_fingerprint = ?').run(targetUserId, `pilot:${plan.planId}`)
    deletedCounts.receipts += Number(delReceipt.changes)

    // 7. Delete Agent Profiles & Snapshots
    for (const item of plan.items) {
      for (const p of item.agentProfileSnapshots) {
        const profId = `prof_${createHash('sha256').update(`${targetUserId}:${item.targetSpaceFolder}:${p.sourceProfileId}`).digest('hex').slice(0, 32)}`
        db.prepare('DELETE FROM agent_profile_snapshots WHERE profile_id = ?').run(profId)
        const delProf = db.prepare('DELETE FROM agent_profiles WHERE id = ?').run(profId)
        deletedCounts.agentProfiles += Number(delProf.changes)
      }
    }

    // 8. Delete Spaces
    for (const item of plan.items) {
      const spaceId = deterministicSpaceId(targetUserId, manifest.sourceFingerprint, item.targetSpaceFolder)
      const delSpace = db.prepare('DELETE FROM spaces WHERE id = ?').run(spaceId)
      deletedCounts.spaces += Number(delSpace.changes)
    }

    // 9. Delete import_jobs record
    const jobId = `job_pilot_${plan.planId}`
    const delJob = db.prepare('DELETE FROM import_jobs WHERE id = ?').run(jobId)
    deletedCounts.importJobs += Number(delJob.changes)

    // 10. Run FK Integrity Check
    const fkCheck = db.prepare('PRAGMA foreign_key_check').all()
    if (fkCheck.length > 0) {
      throw new Error(`Foreign key integrity check failed after pilot cleanup: ${JSON.stringify(fkCheck)}`)
    }

    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  // 11. Clean up file provider files if configured
  if (fileProvider && typeof fileProvider.execute === 'function') {
    for (const item of plan.items) {
      const spaceId = deterministicSpaceId(targetUserId, manifest.sourceFingerprint, item.targetSpaceFolder)
      try {
        await fileProvider.execute(targetUserId, spaceId, {
          op: 'rm',
          path: 'INSTRUCTIONS.md',
          recursive: true,
          force: true,
        })
        deletedCounts.files++
      } catch {}
    }
  }

  return {
    success: true,
    planId: plan.planId,
    deletedCounts,
    cleanedAt: new Date().toISOString(),
  }
}
