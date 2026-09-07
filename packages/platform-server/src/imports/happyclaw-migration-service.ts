import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  createWriteStream,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import type { IncomingMessage } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import {
  ForbiddenError,
  NotFoundError,
  PlatformError,
  type PlatformStorage,
  type User,
  ValidationError,
} from '@enkeep/platform-core'
import {
  type CompiledChat,
  computeSourceFingerprint,
  deterministicSessionId,
  deterministicSpaceId,
  deterministicSourceProvenanceId,
  executeGenericMigration,
  type GenericMigrateOptions,
  type GenericMigrationResult,
  inspectSource,
  introspectSource,
  messageIdFor,
  type MigrationPlan,
  type SchemaDiagnostic,
  type SourceInspectResult,
  validateGroupFolder,
  validateRelativeAttachmentPath,
  inspectSourceV2,
  createMigrationPlanV2,
  executeCredentialAuthorizedTransfer,
  stageMigrationPackageV2,
  executePilotMigrationV2,
  deletePilotMigrationV2,
  EphemeralCredentialVaultEncryptor,
  FakeSourceCredentialReader,
  type MigrationPlanV2,
  type MigrationV2DryRunRequest,
  type MigrationV2DryRunResult,
  type MigrationV2StageRequest,
  type MigrationV2StageResult,
  type SourceInspectResultV2,
  type SourceCredentialCapability,
  type SourceCredentialReader,
  type CredentialTransferRequest,
  type CredentialTransferResult,
  type PilotExecutionResult,
  type PilotCleanupResult,
} from '@enkeep/import-happyclaw'
import { buildRouteKey, DEFAULT_WEB_ACCOUNT_ID, WEB_CHANNEL_NAME } from '@enkeep/web-channel'
import type { TenantRuntimeFileProvider } from '../files/runtime-file-api.js'

export interface HappyClawMigrationServiceOptions {
  readonly db: DatabaseSync
  readonly storage?: PlatformStorage
  readonly fileProvider?: TenantRuntimeFileProvider
  readonly runtimeGateway?: unknown
  readonly allowlistedImportRoots?: readonly string[]
  readonly stagedImportsDir?: string
}

export interface StagedRegistryEntry {
  readonly stagedId: string
  readonly canonicalPath: string
  readonly relativeName: string
  readonly size: number
  readonly mtimeMs: number
  readonly mtime: string
  readonly ino: bigint
  readonly dev: bigint
  readonly sha256Prefix: string
  readonly inspectionStatus: 'uninspected' | 'ready' | 'invalid'
  readonly registeredAt: string
}

export interface StagedImportItem {
  readonly stagedId: string
  readonly name: string
  readonly size: number
  readonly mtime: string
  readonly inspectionStatus: 'uninspected' | 'ready' | 'invalid'
}

export interface StagedInspectOptions {
  readonly limit?: number
  readonly offset?: number
  readonly search?: string
}

export interface StagedConversationSummary {
  readonly id: string
  readonly sourceKey: string
  readonly title: string
  readonly channel: string
  readonly folder: string
  readonly executionMode: string | null
  readonly msgCount: number
  readonly attachmentCount: number
  readonly hasAttachments: boolean
  readonly firstMessageAt: string | null
  readonly lastMessageAt: string | null
  readonly schemaWarnings: readonly string[]
}

export interface StagedInspectResponse {
  readonly stagedId: string
  readonly name: string
  readonly size: number
  readonly mtime: string
  readonly sourceFingerprint: string
  readonly diagnostic: SchemaDiagnostic
  readonly totalConversations: number
  readonly totalMessages: number
  readonly totalAttachments: number
  readonly attachmentNotice: string
  readonly conversations: readonly StagedConversationSummary[]
  readonly pagination: {
    readonly limit: number
    readonly offset: number
    readonly total: number
    readonly hasMore: boolean
  }
}

export interface StagedMigrateRequestDto {
  readonly targetUserId?: string
  readonly conversationIds?: readonly string[]
  readonly conversations?: readonly string[]
  readonly all?: boolean
  readonly dryRun?: boolean
  readonly titleOverride?: string
  readonly targetSpace?: string
  readonly idempotencyKey?: string
}

export interface InspectRequestDto {
  readonly sourcePath?: string
  readonly stagedUploadId?: string
  readonly groupsDir?: string
}

export interface ExecuteMigrationRequestDto {
  readonly sourcePath?: string
  readonly stagedUploadId?: string
  readonly groupsDir?: string
  readonly conversations?: readonly string[]
  readonly all?: boolean
  readonly userId?: string
  readonly targetSpace?: string
  readonly titleOverride?: string
  readonly dryRun?: boolean
}

export type MigrationJobStatusType =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancel_requested'
  | 'cancelled'
  | 'interrupted'

export interface MigrationJobStatus {
  readonly jobId: string
  readonly actorUserId: string
  readonly targetUserId: string
  readonly stagedId: string
  readonly sourceFingerprint: string
  readonly status: MigrationJobStatusType
  readonly dryRun: boolean
  readonly totalConversations: number
  readonly completedConversations: number
  readonly progress?: {
    readonly currentConversation?: string
    readonly completedChats?: number
    readonly totalChats?: number
  }
  readonly result?: {
    readonly success: boolean
    readonly dryRun: boolean
    readonly stats: {
      readonly chats: number
      readonly sourceMessages: number
      readonly importedPeopleTalk: number
      readonly attachments: number
    }
    readonly sessionLinks: Array<{
      readonly folder: string
      readonly sessionId: string
      readonly title: string
    }>
  }
  readonly errorCode?: string
  readonly error?: string
  readonly createdAt: string
  readonly updatedAt: string
}

const SQLITE_HEADER_PREFIX = Buffer.from('SQLite format 3\0', 'utf8')
const MAX_STAGED_FILE_SIZE = 10 * 1024 * 1024 * 1024 // 10 GB
const MAX_STREAM_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024 // 2 GB

export class HappyClawMigrationService {
  private readonly db: DatabaseSync
  private readonly storage?: PlatformStorage
  private readonly fileProvider?: TenantRuntimeFileProvider
  private readonly runtimeGateway?: any
  private readonly allowlistedImportRoots: readonly string[]
  private readonly stagedImportsDir?: string
  private readonly stagedRegistry = new Map<string, StagedRegistryEntry>()
  private readonly activeControllers = new Map<string, AbortController>()
  private readonly usedCredentialTokens = new Set<string>()
  private readonly credentialVaultEncryptor = new EphemeralCredentialVaultEncryptor()

  constructor(options: HappyClawMigrationServiceOptions) {
    if (!options.db) {
      throw new ValidationError('DatabaseSync instance is required')
    }
    this.db = options.db
    this.storage = options.storage
    this.fileProvider = options.fileProvider
    this.runtimeGateway = options.runtimeGateway
    this.allowlistedImportRoots = options.allowlistedImportRoots ?? []
    this.stagedImportsDir = options.stagedImportsDir

    this.recoverInterruptedJobs()
  }

  /**
   * On startup, safely marks any orphaned running/cancel_requested jobs as interrupted in SQLite.
   */
  public recoverInterruptedJobs(): void {
    try {
      const tableCheck = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='import_jobs'")
        .get()
      if (!tableCheck) return

      this.db
        .prepare(
          `UPDATE import_jobs
           SET status = 'interrupted', updated_at = CURRENT_TIMESTAMP
           WHERE status IN ('running', 'cancel_requested')`
        )
        .run()
    } catch {}
  }

  /**
   * Scans configured staging roots and populates/updates in-memory registry.
   */
  public scanStagedRoots(): StagedImportItem[] {
    const roots: string[] = []
    if (this.stagedImportsDir && existsSync(this.stagedImportsDir)) {
      roots.push(resolve(this.stagedImportsDir))
    }
    for (const r of this.allowlistedImportRoots) {
      if (existsSync(r)) {
        const resolved = resolve(r)
        if (!roots.includes(resolved)) {
          roots.push(resolved)
        }
      }
    }

    const items: StagedImportItem[] = []

    for (const root of roots) {
      try {
        const rootStat = lstatSync(root, { bigint: true })
        if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
          continue
        }

        const entries = readdirSync(root, { withFileTypes: true })
        for (const entry of entries) {
          const entryName = entry.name
          if (entryName.startsWith('.') || entryName.normalize('NFC') !== entryName) {
            continue
          }

          const fullPath = join(root, entryName)

          if (entry.isDirectory()) {
            try {
              const subStat = lstatSync(fullPath, { bigint: true })
              if (subStat.isSymbolicLink() || !subStat.isDirectory()) continue

              const subEntries = readdirSync(fullPath, { withFileTypes: true })
              for (const subEntry of subEntries) {
                const subName = subEntry.name
                if (subName.startsWith('.') || subName.normalize('NFC') !== subName) continue
                const subFullPath = join(fullPath, subName)
                const relName = `${entryName}/${subName}`
                this.processCandidateFile(subFullPath, relName, items)
              }
            } catch {}
          } else {
            this.processCandidateFile(fullPath, entryName, items)
          }
        }
      } catch {}
    }

    items.sort((a, b) => b.mtime.localeCompare(a.mtime))
    return items
  }

  private processCandidateFile(
    fullPath: string,
    relativeName: string,
    outputList: StagedImportItem[]
  ): void {
    try {
      const stat = lstatSync(fullPath, { bigint: true })
      if (!stat.isFile()) return
      if (stat.isSymbolicLink()) return
      if (stat.nlink > 1n) return
      const sizeNum = Number(stat.size)
      if (sizeNum <= 0 || sizeNum > MAX_STAGED_FILE_SIZE) return

      const lower = relativeName.toLowerCase()
      if (!lower.endsWith('.db') && !lower.endsWith('.sqlite')) {
        return
      }

      const hasWal = existsSync(`${fullPath}-wal`) || existsSync(`${fullPath}-shm`)

      let isValidSqlite = false
      let sha256Prefix = ''
      try {
        const fd = openSync(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW)
        const headerBuf = Buffer.alloc(16)
        readSync(fd, headerBuf, 0, 16, 0)
        closeSync(fd)
        if (headerBuf.subarray(0, 16).equals(SQLITE_HEADER_PREFIX)) {
          isValidSqlite = true
        }
      } catch {
        isValidSqlite = false
      }

      const mtimeMs = Number(stat.mtimeMs)
      const mtimeIso = new Date(mtimeMs).toISOString()

      const stagedId = `stg_${createHash('sha256')
        .update(`${stat.dev}:${stat.ino}:${stat.size}:${mtimeMs}:${fullPath}`)
        .digest('hex')
        .slice(0, 24)}`

      const inspectionStatus: 'uninspected' | 'ready' | 'invalid' = !isValidSqlite
        ? 'invalid'
        : hasWal
        ? 'invalid'
        : 'ready'

      const entry: StagedRegistryEntry = {
        stagedId,
        canonicalPath: fullPath,
        relativeName,
        size: sizeNum,
        mtimeMs,
        mtime: mtimeIso,
        ino: stat.ino,
        dev: stat.dev,
        sha256Prefix,
        inspectionStatus,
        registeredAt: new Date().toISOString(),
      }

      this.stagedRegistry.set(stagedId, entry)
      outputList.push({
        stagedId,
        name: relativeName,
        size: sizeNum,
        mtime: mtimeIso,
        inspectionStatus,
      })
    } catch {}
  }

  /**
   * Re-stats staged file and validates TOCTOU integrity against server registry.
   */
  public verifyAndResolveStaged(stagedId: string): StagedRegistryEntry {
    if (typeof stagedId !== 'string' || stagedId.trim() !== stagedId || !stagedId) {
      throw new ValidationError('stagedId must be a valid non-empty string')
    }

    let entry = this.stagedRegistry.get(stagedId)
    if (!entry) {
      this.scanStagedRoots()
      entry = this.stagedRegistry.get(stagedId)
    }

    if (!entry) {
      throw new NotFoundError(`Staged import database not found for ID "${stagedId}"`)
    }

    if (!existsSync(entry.canonicalPath)) {
      throw new NotFoundError(`Staged database file disappeared or is unreachable`)
    }

    const stat = lstatSync(entry.canonicalPath, { bigint: true })

    if (stat.isSymbolicLink()) {
      throw new ValidationError('Security violation: Symlink detected at staged path')
    }
    if (!stat.isFile()) {
      throw new ValidationError('Security violation: Staged target is not a regular file')
    }
    if (stat.nlink > 1n) {
      throw new ValidationError('Security violation: Hardlink detected at staged path')
    }
    if (stat.ino !== entry.ino || stat.dev !== entry.dev) {
      throw new PlatformError(
        'TOCTOU integrity check failed: File inode or device swapped',
        'STAGED_FILE_MODIFIED_OR_SWAPPED',
        400
      )
    }
    if (stat.size !== BigInt(entry.size)) {
      throw new PlatformError(
        'TOCTOU integrity check failed: File size modified after staging',
        'STAGED_FILE_MODIFIED_OR_SWAPPED',
        400
      )
    }
    if (Math.abs(Number(stat.mtimeMs) - entry.mtimeMs) > 1) {
      throw new PlatformError(
        'TOCTOU integrity check failed: File modification time changed after staging',
        'STAGED_FILE_MODIFIED_OR_SWAPPED',
        400
      )
    }

    return entry
  }

  /**
   * Lists operator-staged DB files under configured staging roots.
   */
  public async listStaged(currentUser: User): Promise<StagedImportItem[]> {
    if (currentUser.role !== 'admin') {
      throw new ForbiddenError('Administrative access required to list staged databases')
    }
    return this.scanStagedRoots()
  }

  /**
   * Inspects a staged database with TOCTOU integrity validation and paginated conversation summary.
   */
  public async inspectStaged(
    currentUser: User,
    stagedId: string,
    options?: StagedInspectOptions
  ): Promise<StagedInspectResponse> {
    if (currentUser.role !== 'admin') {
      throw new ForbiddenError('Administrative access required for staged inspection')
    }

    const entry = this.verifyAndResolveStaged(stagedId)
    const inspectResult = inspectSource({ sourcePath: entry.canonicalPath })

    let totalAttachments = 0
    let summaries: StagedConversationSummary[] = inspectResult.conversations.map((c) => {
      const idHash = createHash('sha256').update(c.sourceKey).digest('hex').slice(0, 16)
      const attachCount = c.hasAttachments ? 1 : 0
      totalAttachments += attachCount

      const warnings: string[] = []
      if (c.hasAttachments) {
        warnings.push('Binary attachment files are not migrated directly; text transcripts are preserved.')
      }
      if (!c.folder || c.folder.trim() === '') {
        warnings.push('Space folder inferred from chat name or key.')
      }

      return {
        id: idHash,
        sourceKey: c.sourceKey,
        title: c.name || c.sourceKey,
        channel: c.channel,
        folder: c.folder,
        executionMode: c.executionMode,
        msgCount: c.messageCount,
        attachmentCount: attachCount,
        hasAttachments: c.hasAttachments,
        firstMessageAt: c.firstMessageAt,
        lastMessageAt: c.lastMessageAt,
        schemaWarnings: warnings,
      }
    })

    if (options?.search && options.search.trim()) {
      const q = options.search.trim().toLowerCase()
      summaries = summaries.filter(
        (s) =>
          s.title.toLowerCase().includes(q) ||
          s.sourceKey.toLowerCase().includes(q) ||
          s.folder.toLowerCase().includes(q)
      )
    }

    const totalFiltered = summaries.length
    const offset = Math.max(0, options?.offset ?? 0)
    const limit = Math.max(1, Math.min(200, options?.limit ?? 50))
    const paged = summaries.slice(offset, offset + limit)

    return {
      stagedId: entry.stagedId,
      name: entry.relativeName,
      size: entry.size,
      mtime: entry.mtime,
      sourceFingerprint: inspectResult.sourceFingerprint,
      diagnostic: inspectResult.diagnostic,
      totalConversations: inspectResult.totalConversations,
      totalMessages: inspectResult.totalMessages,
      totalAttachments,
      attachmentNotice:
        'Will migrate text messages only. External attachment files not found in database will be preserved as message text/metadata warnings.',
      conversations: paged,
      pagination: {
        limit,
        offset,
        total: totalFiltered,
        hasMore: offset + paged.length < totalFiltered,
      },
    }
  }

  /**
   * Executes staged database migration with durable SQLite job recording, idempotency key enforcement,
   * TOCTOU checks, and incremental cancellation.
   */
  public async migrateStaged(
    currentUser: User,
    stagedId: string,
    options: StagedMigrateRequestDto
  ): Promise<GenericMigrationResult & { jobId: string }> {
    if (currentUser.role !== 'admin') {
      throw new ForbiddenError('Administrative access required for staged migration')
    }

    const entry = this.verifyAndResolveStaged(stagedId)
    const targetUserId = options.targetUserId || currentUser.id

    // Verify target user exists and is active
    const userRow = this.db.prepare('SELECT id, status FROM users WHERE id = ?').get(targetUserId) as
      | { id: string; status: string }
      | undefined
    if (!userRow) {
      throw new NotFoundError(`Target user "${targetUserId}" not found`)
    }
    if (userRow.status !== 'active') {
      throw new PlatformError(`Target user "${targetUserId}" is not active`, 'USER_INACTIVE', 400)
    }

    // Resolve conversation keys
    let conversations = options.conversations ? [...options.conversations] : undefined
    if (options.conversationIds && options.conversationIds.length > 0) {
      const fullInspect = inspectSource({ sourcePath: entry.canonicalPath })
      const hashToKey = new Map<string, string>()
      for (const conv of fullInspect.conversations) {
        const idHash = createHash('sha256').update(conv.sourceKey).digest('hex').slice(0, 16)
        hashToKey.set(idHash, conv.sourceKey)
        hashToKey.set(conv.sourceKey, conv.sourceKey)
      }

      const mappedKeys: string[] = []
      for (const id of options.conversationIds) {
        const key = hashToKey.get(id) || id
        mappedKeys.push(key)
      }
      conversations = mappedKeys
    }

    const inspectRes = inspectSource({ sourcePath: entry.canonicalPath })
    const allConversations = conversations && conversations.length > 0 ? conversations : inspectRes.conversations.map((c) => c.sourceKey)

    // Compute request hash
    const normalizedPayload = {
      targetUserId,
      stagedId,
      conversations: [...allConversations].sort(),
      dryRun: Boolean(options.dryRun),
      targetSpace: options.targetSpace || null,
      titleOverride: options.titleOverride || null,
    }
    const requestHash = createHash('sha256').update(JSON.stringify(normalizedPayload)).digest('hex')
    const idempotencyKey = options.idempotencyKey || null

    // Check existing job with Idempotency Key in SQLite
    if (idempotencyKey) {
      const existingJob = this.db
        .prepare(
          'SELECT id, request_hash, status, result_json FROM import_jobs WHERE actor_user_id = ? AND idempotency_key = ?'
        )
        .get(currentUser.id, idempotencyKey) as
        | { id: string; request_hash: string; status: string; result_json: string | null }
        | undefined

      if (existingJob) {
        if (existingJob.request_hash !== requestHash) {
          throw new PlatformError(
            'Idempotency conflict: request payload differs for the given Idempotency-Key',
            'IDEMPOTENCY_CONFLICT',
            409
          )
        }
        if (existingJob.status === 'completed' && existingJob.result_json) {
          const cachedResult = JSON.parse(existingJob.result_json)
          return { ...cachedResult, jobId: existingJob.id }
        }
      }
    }

    const jobId = `job_${randomUUID().replace(/-/g, '')}`
    const createdAt = new Date().toISOString()
    const isDryRun = Boolean(options.dryRun)

    // Insert durable job in SQLite transaction
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare(
          `INSERT INTO import_jobs (
            id, actor_user_id, target_user_id, staged_id, source_fingerprint,
            request_hash, idempotency_key, status, dry_run, total_conversations,
            completed_conversations, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, 0, ?, ?)`
        )
        .run(
          jobId,
          currentUser.id,
          targetUserId,
          stagedId,
          inspectRes.sourceFingerprint,
          requestHash,
          idempotencyKey,
          isDryRun ? 1 : 0,
          allConversations.length,
          createdAt,
          createdAt
        )

      const convInsertStmt = this.db.prepare(
        `INSERT INTO import_job_conversations (id, job_id, source_key, status, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?)`
      )

      for (const key of allConversations) {
        const convRowId = `ijc_${randomUUID().replace(/-/g, '')}`
        convInsertStmt.run(convRowId, jobId, key, createdAt, createdAt)
      }

      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }

    // AbortController registration
    const controller = new AbortController()
    this.activeControllers.set(jobId, controller)

    try {
      // Execute migration
      const result = await this.execute(currentUser, {
        sourcePath: entry.canonicalPath,
        conversations: allConversations,
        all: options.all || (!conversations || conversations.length === 0),
        userId: targetUserId,
        targetSpace: options.targetSpace,
        titleOverride: options.titleOverride,
        dryRun: isDryRun,
      })

      // Check if cancellation was requested during execute
      const currentJobRow = this.db
        .prepare('SELECT status FROM import_jobs WHERE id = ?')
        .get(jobId) as { status: string } | undefined

      if (currentJobRow && (currentJobRow.status === 'cancel_requested' || controller.signal.aborted)) {
        this.db
          .prepare("UPDATE import_jobs SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .run(jobId)
        throw new PlatformError('Migration job was cancelled by administrator', 'JOB_CANCELLED', 400)
      }

      // Persist safe result JSON (no absolute paths)
      const safeSessionLinks = result.compiledChats.map((c) => ({
        folder: c.folder,
        sessionId: c.sessionId,
        title: (c as any).name || c.folder,
      }))

      const safeResultJson = JSON.stringify({
        success: result.success,
        dryRun: result.dryRun,
        stats: {
          chats: result.stats.chats,
          sourceMessages: result.stats.sourceMessages,
          importedPeopleTalk: result.stats.importedPeopleTalk,
          attachments: result.stats.attachments,
        },
        sessionLinks: safeSessionLinks,
      })

      this.db
        .prepare(
          `UPDATE import_jobs
           SET status = 'completed', completed_conversations = ?, result_json = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        )
        .run(allConversations.length, safeResultJson, jobId)

      this.db
        .prepare(
          "UPDATE import_job_conversations SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE job_id = ?"
        )
        .run(jobId)

      return {
        ...result,
        jobId,
      }
    } catch (err: any) {
      const isCancelled = err?.code === 'JOB_CANCELLED'
      const statusToSet = isCancelled ? 'cancelled' : 'failed'
      const errorMsg = err instanceof Error ? err.message : String(err)
      const errCode = err instanceof PlatformError ? err.code : 'MIGRATION_FAILED'

      try {
        this.db
          .prepare(
            `UPDATE import_jobs
             SET status = ?, error_code = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`
          )
          .run(statusToSet, errCode, errorMsg, jobId)
      } catch {}

      throw err
    } finally {
      this.activeControllers.delete(jobId)
    }
  }

  /**
   * Queries durable job status from SQLite database.
   */
  public getJobStatus(jobId: string): MigrationJobStatus | undefined {
    if (typeof jobId !== 'string' || !jobId) return undefined

    const row = this.db
      .prepare('SELECT * FROM import_jobs WHERE id = ?')
      .get(jobId) as Record<string, unknown> | undefined

    if (!row) return undefined

    let progress: any = undefined
    if (typeof row.progress_json === 'string' && row.progress_json) {
      try {
        progress = JSON.parse(row.progress_json)
      } catch {}
    }

    let result: any = undefined
    if (typeof row.result_json === 'string' && row.result_json) {
      try {
        result = JSON.parse(row.result_json)
      } catch {}
    }

    return {
      jobId: String(row.id),
      actorUserId: String(row.actor_user_id),
      targetUserId: String(row.target_user_id),
      stagedId: String(row.staged_id),
      sourceFingerprint: String(row.source_fingerprint),
      status: row.status as MigrationJobStatusType,
      dryRun: Boolean(row.dry_run),
      totalConversations: Number(row.total_conversations || 0),
      completedConversations: Number(row.completed_conversations || 0),
      progress,
      result,
      errorCode: typeof row.error_code === 'string' ? row.error_code : undefined,
      error: typeof row.error_message === 'string' ? row.error_message : undefined,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  }

  /**
   * Cancels in-flight migration job in SQLite and aborts active controller.
   */
  public cancelJob(jobId: string): boolean {
    if (typeof jobId !== 'string' || !jobId) return false

    const row = this.db
      .prepare('SELECT status FROM import_jobs WHERE id = ?')
      .get(jobId) as { status: string } | undefined

    if (!row) return false
    if (['completed', 'failed', 'cancelled'].includes(row.status)) {
      return false
    }

    // Write cancellation intent to database
    this.db
      .prepare(
        "UPDATE import_jobs SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      )
      .run(jobId)

    // Abort in-flight process if running
    const controller = this.activeControllers.get(jobId)
    if (controller) {
      controller.abort()
      this.activeControllers.delete(jobId)
    }

    return true
  }

  /**
   * Resumes an interrupted or failed job from durable state in SQLite.
   */
  public async resumeJob(currentUser: User, jobId: string): Promise<MigrationJobStatus> {
    if (currentUser.role !== 'admin') {
      throw new ForbiddenError('Administrative access required to resume migration job')
    }

    const job = this.getJobStatus(jobId)
    if (!job) {
      throw new NotFoundError(`Import job "${jobId}" not found`)
    }

    if (job.status !== 'interrupted' && job.status !== 'failed') {
      return job
    }

    // TOCTOU check on staged DB
    const entry = this.verifyAndResolveStaged(job.stagedId)

    // Query pending conversations
    const pendingConvs = (this.db
      .prepare(
        "SELECT source_key FROM import_job_conversations WHERE job_id = ? AND status != 'completed'"
      )
      .all(jobId) as Array<{ source_key: string }>).map((c) => c.source_key)

    if (pendingConvs.length === 0) {
      this.db
        .prepare("UPDATE import_jobs SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(jobId)
      return this.getJobStatus(jobId)!
    }

    this.db
      .prepare("UPDATE import_jobs SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(jobId)

    const controller = new AbortController()
    this.activeControllers.set(jobId, controller)

    try {
      const result = await this.execute(currentUser, {
        sourcePath: entry.canonicalPath,
        conversations: pendingConvs,
        userId: job.targetUserId,
        dryRun: job.dryRun,
      })

      const safeSessionLinks = result.compiledChats.map((c) => ({
        folder: c.folder,
        sessionId: c.sessionId,
        title: (c as any).name || c.folder,
      }))

      const safeResultJson = JSON.stringify({
        success: result.success,
        dryRun: result.dryRun,
        stats: {
          chats: result.stats.chats,
          sourceMessages: result.stats.sourceMessages,
          importedPeopleTalk: result.stats.importedPeopleTalk,
          attachments: result.stats.attachments,
        },
        sessionLinks: safeSessionLinks,
      })

      this.db
        .prepare(
          `UPDATE import_jobs
           SET status = 'completed', completed_conversations = total_conversations, result_json = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        )
        .run(safeResultJson, jobId)

      this.db
        .prepare(
          "UPDATE import_job_conversations SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE job_id = ?"
        )
        .run(jobId)

      return this.getJobStatus(jobId)!
    } catch (err: any) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      this.db
        .prepare(
          `UPDATE import_jobs
           SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        )
        .run(errorMsg, jobId)
      throw err
    } finally {
      this.activeControllers.delete(jobId)
    }
  }

  /**
   * Safely streams an uploaded database file into server staging directory with O_NOFOLLOW and 0600 mode.
   */
  public async uploadStaged(
    currentUser: User,
    req: IncomingMessage,
    filenameOverride?: string
  ): Promise<StagedImportItem> {
    if (currentUser.role !== 'admin') {
      throw new ForbiddenError('Administrative access required for database staging upload')
    }

    const stagingBase =
      this.stagedImportsDir ||
      (this.allowlistedImportRoots.length > 0 ? this.allowlistedImportRoots[0] : undefined)

    if (!stagingBase) {
      throw new PlatformError(
        'Server has no configured staged imports directory or allowlisted roots',
        'STAGING_NOT_CONFIGURED',
        400
      )
    }

    mkdirSync(stagingBase, { recursive: true, mode: 0o700 })

    const uploadDirName = `upload_${randomUUID().replace(/-/g, '')}`
    const uploadDirPath = join(stagingBase, uploadDirName)
    mkdirSync(uploadDirPath, { recursive: true, mode: 0o700 })

    const safeFilename = filenameOverride
      ? filenameOverride.replace(/[^a-zA-Z0-9_.-]/g, '_').normalize('NFC')
      : 'messages.db'
    const targetFile = join(
      uploadDirPath,
      safeFilename.endsWith('.db') || safeFilename.endsWith('.sqlite')
        ? safeFilename
        : `${safeFilename}.db`
    )

    let totalBytes = 0
    const countingStream = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        totalBytes += chunk.length
        if (totalBytes > MAX_STREAM_UPLOAD_BYTES) {
          callback(
            new PlatformError(
              'Payload Too Large: database upload exceeds 2GB maximum limit',
              'PAYLOAD_TOO_LARGE',
              413
            )
          )
          return
        }
        callback(null, chunk)
      },
    })

    const fileStream = createWriteStream(targetFile, {
      flags: 'wx',
      mode: 0o600,
    })

    try {
      await pipeline(req, countingStream, fileStream)

      const checkFd = openSync(targetFile, constants.O_RDONLY | constants.O_NOFOLLOW)
      const headerBuf = Buffer.alloc(16)
      readSync(checkFd, headerBuf, 0, 16, 0)
      closeSync(checkFd)

      if (!headerBuf.subarray(0, 16).equals(SQLITE_HEADER_PREFIX)) {
        throw new ValidationError('Uploaded file is not a valid SQLite database (missing SQLite 3 header)')
      }

      this.scanStagedRoots()

      const items = this.scanStagedRoots()
      const found = items.find((i) => i.name.startsWith(uploadDirName))
      if (!found) {
        throw new PlatformError('Failed to register uploaded staged database', 'STAGED_REGISTER_FAILED', 500)
      }

      return found
    } catch (err) {
      try {
        fileStream.destroy()
      } catch {}
      try {
        rmSync(uploadDirPath, { recursive: true, force: true })
      } catch {}
      throw err
    }
  }

  /**
   * Resolves and verifies an import path against platform security boundaries.
   */
  public resolveAndValidateSourcePath(sourcePath?: string, stagedUploadId?: string): string {
    if (stagedUploadId) {
      if (typeof stagedUploadId !== 'string' || stagedUploadId.trim() !== stagedUploadId) {
        throw new ValidationError('stagedUploadId must be a valid non-empty string')
      }
      if (!this.stagedImportsDir) {
        throw new PlatformError('Staged imports directory is not configured on this server', 'STAGING_NOT_CONFIGURED', 400)
      }
      const safeId = stagedUploadId.replace(/[^a-zA-Z0-9_-]/g, '')
      const stagedPath = resolve(this.stagedImportsDir, safeId, 'messages.db')
      if (!existsSync(stagedPath)) {
        throw new NotFoundError(`Staged import database not found for ID "${stagedUploadId}"`)
      }
      return stagedPath
    }

    if (!sourcePath || typeof sourcePath !== 'string') {
      throw new ValidationError('Either sourcePath or stagedUploadId must be provided')
    }

    const resolved = resolve(sourcePath)
    const normalized = normalize(resolved)

    const allowedRoots = [...this.allowlistedImportRoots]
    if (this.stagedImportsDir) {
      allowedRoots.push(this.stagedImportsDir)
    }

    if (allowedRoots.length > 0) {
      let insideAllowlist = false
      for (const root of allowedRoots) {
        const normRoot = normalize(resolve(root))
        const rel = relative(normRoot, normalized)
        if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
          insideAllowlist = true
          break
        }
      }
      if (!insideAllowlist) {
        throw new ForbiddenError(
          `Source path "${sourcePath}" is outside configured platform allowlisted import roots`
        )
      }
    }

    if (!existsSync(normalized)) {
      throw new NotFoundError(`Source database file does not exist: ${sourcePath}`)
    }

    return normalized
  }

  /**
   * Inspects a HappyClaw SQLite source database.
   */
  public async inspect(
    currentUser: User,
    request: InspectRequestDto
  ): Promise<SourceInspectResult> {
    if (currentUser.role !== 'admin') {
      throw new ForbiddenError('Administrative access required for import inspection')
    }

    const dbPath = this.resolveAndValidateSourcePath(request.sourcePath, request.stagedUploadId)
    const groupsDir = request.groupsDir ? resolve(request.groupsDir) : undefined

    return inspectSource({
      sourcePath: dbPath,
      groupsDir,
    })
  }

  /**
   * Executes a HappyClaw database migration or dry-run.
   */
  public async execute(
    currentUser: User,
    request: ExecuteMigrationRequestDto
  ): Promise<GenericMigrationResult> {
    if (currentUser.role !== 'admin') {
      throw new ForbiddenError('Administrative access required for migration execution')
    }

    const dbPath = this.resolveAndValidateSourcePath(request.sourcePath, request.stagedUploadId)
    const groupsDir = request.groupsDir ? resolve(request.groupsDir) : undefined
    const targetUserId = request.userId || currentUser.id

    const userRow = this.db.prepare('SELECT id, status FROM users WHERE id = ?').get(targetUserId) as
      | { id: string; status: string }
      | undefined
    if (!userRow) {
      throw new NotFoundError(`Target user "${targetUserId}" not found`)
    }
    if (userRow.status !== 'active') {
      throw new PlatformError(`Target user "${targetUserId}" is not active`, 'USER_INACTIVE', 400)
    }

    const options: GenericMigrateOptions = {
      sourcePath: dbPath,
      sourceGroupsDir: groupsDir,
      conversations: request.conversations,
      all: request.all || (!request.conversations || request.conversations.length === 0),
      userId: targetUserId,
      targetSpace: request.targetSpace,
      titleOverride: request.titleOverride,
      dryRun: Boolean(request.dryRun),
    }

    const migrationRes = await executeGenericMigration(options)

    if (options.dryRun) {
      return migrationRes
    }

    await this.applyMigrationToPlatform(targetUserId, migrationRes, groupsDir)

    return migrationRes
  }

  private async applyMigrationToPlatform(
    userId: string,
    result: GenericMigrationResult,
    groupsDir?: string
  ): Promise<void> {
    const createdAt = new Date().toISOString()
    const { sourceFingerprint, compiledChats, plan } = result

    this.db.exec('BEGIN IMMEDIATE')
    try {
      const spaceInsertStmt = this.db.prepare(`
        INSERT INTO spaces (id, user_id, name, folder, execution_mode, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'container', 'active', ?, ?)
        ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
      `)

      const routeInsertStmt = this.db.prepare(`
        INSERT INTO session_routes (
          id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, status, title, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'container', 'active', ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          updated_at = excluded.updated_at
      `)

      const genInsertStmt = this.db.prepare(`
        INSERT INTO session_generations (
          id, user_id, route_id, generation_number, dsh_session_id, agent_profile_snapshot_id, reset_reason, created_at
        ) VALUES (?, ?, ?, 1, ?, NULL, 'initial', ?)
        ON CONFLICT(route_id, generation_number) DO NOTHING
      `)

      const sourceInsertStmt = this.db.prepare(`
        INSERT INTO session_sources (
          id, route_id, source_type, source_id, user_id, metadata, created_at
        ) VALUES (?, ?, 'happyclaw', ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET metadata = excluded.metadata
      `)

      const msgInsertStmt = this.db.prepare(`
        INSERT INTO web_messages (
          id, session_id, user_id, role, content, status, route_key, metadata, created_at
        ) VALUES (?, ?, ?, ?, ?, 'delivered', ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET content = excluded.content, status = 'delivered'
      `)

      const eventInsertStmt = this.db.prepare(`
        INSERT INTO web_events (
          id, session_id, user_id, type, payload, created_at
        ) VALUES (?, ?, ?, 'message', ?, ?)
        ON CONFLICT(id) DO UPDATE SET payload = excluded.payload
      `)

      const receiptInsertStmt = this.db.prepare(`
        INSERT INTO fixed_import_receipts (
          user_id, source_fingerprint, importer_version, id_algorithm, target_dsh,
          session_format, source_chats_count, source_messages_count,
          imported_messages_count, dropped_messages_count, attachments_count,
          canonical_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, source_fingerprint) DO UPDATE SET
          source_chats_count = excluded.source_chats_count,
          source_messages_count = excluded.source_messages_count,
          imported_messages_count = excluded.imported_messages_count
      `)

      const provInsertStmt = this.db.prepare(`
        INSERT INTO fixed_import_provenance (
          id, user_id, source_fingerprint, source_chat_jid, source_message_id,
          target_space_id, target_route_id, target_dsh_session_id,
          target_message_id, target_event_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `)

      const canonicalHash = createHash('sha256')
        .update(JSON.stringify(result.manifest))
        .digest('hex')

      receiptInsertStmt.run(
        userId,
        sourceFingerprint,
        result.manifest.importerVersion,
        result.manifest.idAlgorithm,
        result.manifest.targetDsh,
        result.manifest.sessionFormat,
        result.stats.chats,
        result.stats.sourceMessages,
        result.stats.importedPeopleTalk,
        result.stats.droppedEmpty,
        result.stats.attachments,
        canonicalHash,
        createdAt
      )

      for (const chat of compiledChats) {
        const planItem = plan.items.find((i) => i.sourceKey === chat.chatJid)
        const spaceId = deterministicSpaceId(userId, sourceFingerprint, chat.folder)
        const spaceName = planItem?.targetSpaceName || chat.folder
        const sessionTitle = planItem?.targetTitle || (chat as { name?: string }).name || chat.folder

        spaceInsertStmt.run(spaceId, userId, spaceName, chat.folder, createdAt, createdAt)

        routeInsertStmt.run(
          chat.sessionId,
          spaceId,
          userId,
          WEB_CHANNEL_NAME,
          DEFAULT_WEB_ACCOUNT_ID,
          chat.sessionId,
          chat.chatJid,
          chat.sessionId,
          sessionTitle,
          createdAt,
          createdAt
        )

        const genId = `gen_${createHash('sha256').update(`${userId}:${sourceFingerprint}:${chat.sessionId}:gen1`).digest('hex').slice(0, 32)}`
        genInsertStmt.run(genId, userId, chat.sessionId, chat.sessionId, createdAt)

        const sourceRowId = deterministicSourceProvenanceId(userId, sourceFingerprint, chat.chatJid)
        const metaStr = JSON.stringify({
          sourceKey: chat.chatJid,
          sourceName: (chat as { name?: string }).name || chat.folder,
          folder: chat.folder,
          sourceExecutionMode: chat.report.executionMode,
          sourceMessages: chat.report.sourceMessages,
          importedMessages: chat.report.importedPeopleTalk,
          droppedEmpty: chat.report.droppedEmpty,
          attachments: chat.report.attachments,
        })
        sourceInsertStmt.run(sourceRowId, chat.sessionId, chat.chatJid, userId, metaStr, createdAt)

        const routeKey = buildRouteKey({
          userId,
          channel: WEB_CHANNEL_NAME,
          accountId: DEFAULT_WEB_ACCOUNT_ID,
          nativeContextId: chat.sessionId,
        })

        for (const event of chat.seed) {
          if (event.type === 'user/message' || event.type === 'assistant/message') {
            const data = event.data as Record<string, unknown>
            const msgObj = event.type === 'assistant/message' ? (data.message as Record<string, unknown>) : data
            const msgId = String(msgObj.id || `msg_${randomUUID().replace(/-/g, '')}`)
            const role = String(msgObj.role || (event.type === 'user/message' ? 'user' : 'assistant'))
            const contentArr = (msgObj.content as Array<{ text?: string }>) || []
            const content = contentArr.map((c) => c.text || '').join('\n')
            const eventId = `ev_${createHash('sha256').update(`${userId}:${chat.sessionId}:${msgId}`).digest('hex').slice(0, 32)}`
            const provId = `prov_${createHash('sha256').update(`${userId}:${sourceFingerprint}:${chat.chatJid}:${msgId}`).digest('hex').slice(0, 32)}`

            msgInsertStmt.run(
              msgId,
              chat.sessionId,
              userId,
              role,
              content,
              routeKey,
              null,
              createdAt
            )

            const eventPayload = {
              id: msgId,
              sessionId: chat.sessionId,
              userId,
              role,
              content,
              routeKey,
              createdAt,
              message: {
                id: msgId,
                sessionId: chat.sessionId,
                userId,
                role,
                content,
                status: 'delivered',
                routeKey,
                timestamp: createdAt,
              },
            }

            eventInsertStmt.run(
              eventId,
              chat.sessionId,
              userId,
              JSON.stringify(eventPayload),
              createdAt
            )

            provInsertStmt.run(
              provId,
              userId,
              sourceFingerprint,
              chat.chatJid,
              msgId,
              spaceId,
              chat.sessionId,
              chat.sessionId,
              msgId,
              eventId,
              createdAt
            )
          }
        }
      }

      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }

    for (const chat of compiledChats) {
      const spaceId = deterministicSpaceId(userId, sourceFingerprint, chat.folder)

      if (groupsDir && existsSync(groupsDir) && this.fileProvider) {
        const spaceSourceDir = join(groupsDir, chat.folder)
        if (existsSync(spaceSourceDir)) {
          await this.copySpaceFilesViaProvider(userId, spaceId, spaceSourceDir)
        }
      }
    }
  }

  private async copySpaceFilesViaProvider(
    userId: string,
    spaceId: string,
    sourceDir: string
  ): Promise<void> {
    if (!this.fileProvider) return
    const entries = readdirSync(sourceDir, { recursive: true })
    for (const entry of entries) {
      const relPath = String(entry).replaceAll('\\', '/')
      const fullPath = join(sourceDir, relPath)
      try {
        const stat = lstatSync(fullPath)
        if (stat.isFile()) {
          const content = readFileSync(fullPath)
          await this.fileProvider.execute(userId, spaceId, {
            op: 'write',
            path: relPath,
            content: content.toString('utf8'),
            requireAbsent: true,
          })
        }
      } catch {}
    }
  }

  // -------------------------------------------------------------------------
  // Migration V2 Methods (Pilot Dry Run, Credential Transfer, Staging)
  // -------------------------------------------------------------------------

  /**
   * Resolves canonical sourcePath and optional groupsDir from stagedId or explicit sourcePath.
   */
  public resolveSourcePathAndGroupsDir(target: {
    stagedId?: string
    sourcePath?: string
    groupsDir?: string
  }): { sourcePath: string; groupsDir?: string } {
    let sourcePath: string
    let groupsDir = target.groupsDir

    if (target.stagedId) {
      const entry = this.verifyAndResolveStaged(target.stagedId)
      sourcePath = entry.canonicalPath
      if (!groupsDir) {
        const candidateGroups = join(resolve(sourcePath, '..'), 'groups')
        if (existsSync(candidateGroups) && lstatSync(candidateGroups).isDirectory()) {
          groupsDir = candidateGroups
        }
      }
    } else if (target.sourcePath) {
      if (typeof target.sourcePath !== 'string' || target.sourcePath.trim() !== target.sourcePath) {
        throw new ValidationError('sourcePath must be a non-empty string')
      }
      sourcePath = resolve(target.sourcePath)
      if (!existsSync(sourcePath)) {
        throw new NotFoundError(`Source database file not found at "${target.sourcePath}"`)
      }

      // Check allowlisted roots if configured
      if (this.allowlistedImportRoots.length > 0) {
        const isAllowlisted = this.allowlistedImportRoots.some((root) => {
          const resRoot = resolve(root)
          return sourcePath === resRoot || sourcePath.startsWith(`${resRoot}${sep}`)
        })
        if (!isAllowlisted) {
          throw new ForbiddenError(`sourcePath "${target.sourcePath}" is outside configured allowlisted import roots`)
        }
      }
    } else {
      throw new ValidationError('Either stagedId or sourcePath must be provided')
    }

    return { sourcePath, groupsDir }
  }

  /**
   * Inspects source database for V2 workspace-centric migration.
   */
  public async inspectV2(
    currentUser: User,
    target: { stagedId?: string; sourcePath?: string; groupsDir?: string }
  ): Promise<SourceInspectResultV2> {
    if (currentUser.role !== 'admin') {
      throw new ForbiddenError('Administrative access required for V2 inspection')
    }
    const resolved = this.resolveSourcePathAndGroupsDir(target)
    return inspectSourceV2(resolved.sourcePath, resolved.groupsDir)
  }

  /**
   * Executes Migration V2 Dry Run returning per-workspace breakdown, counts, M30 extensions, M31 channels,
   * deterministic planId and sourceFingerprint.
   */
  public async dryRunV2(
    currentUser: User,
    request: MigrationV2DryRunRequest
  ): Promise<MigrationV2DryRunResult> {
    if (currentUser.role !== 'admin') {
      throw new ForbiddenError('Administrative access required for V2 dry run')
    }

    if (!Array.isArray(request.selectedWorkspaceIds) || request.selectedWorkspaceIds.length === 0) {
      throw new ValidationError('selectedWorkspaceIds must be a non-empty array of workspace identifiers')
    }

    const resolved = this.resolveSourcePathAndGroupsDir({
      stagedId: request.stagedId,
      sourcePath: request.sourcePath,
      groupsDir: request.sourceGroupsDir,
    })

    const targetUserId = request.targetUserId || currentUser.id

    // Verify target user exists
    const userRow = this.db.prepare('SELECT id, status FROM users WHERE id = ?').get(targetUserId) as
      | { id: string; status: string }
      | undefined
    if (!userRow) {
      throw new NotFoundError(`Target user "${targetUserId}" not found`)
    }
    if (userRow.status !== 'active') {
      throw new PlatformError(`Target user "${targetUserId}" is not active`, 'USER_INACTIVE', 400)
    }

    const plan = createMigrationPlanV2({
      sourcePath: resolved.sourcePath,
      sourceGroupsDir: resolved.groupsDir,
      targetUserId,
      selectedWorkspaceIds: request.selectedWorkspaceIds,
      scopes: request.scopes,
      titleOverride: request.titleOverride,
      targetSpace: request.targetSpace,
    })

    return {
      success: true,
      dryRun: true,
      plan,
      warnings: plan.warnings,
    }
  }

  /**
   * Executes Credential Authorized Transfer.
   * Admin supplies one-time authorization capability referencing source credential provider.
   * Service reads selected credential IDs via injected SourceCredentialReader (test fake in P1-7),
   * transforms in memory, encrypts into existing Credential Vault/ref, returns status without secrets.
   */
  public async authorizeCredentialsV2(
    currentUser: User,
    request: CredentialTransferRequest,
    customReader?: SourceCredentialReader
  ): Promise<CredentialTransferResult> {
    if (currentUser.role !== 'admin') {
      throw new ForbiddenError('Administrative access required for credential transfer authorization')
    }

    if (!request.capability) {
      throw new ValidationError('Field "capability" is required for credential transfer')
    }

    const reader = customReader ?? new FakeSourceCredentialReader()
    const result = await executeCredentialAuthorizedTransfer(
      request,
      reader,
      this.usedCredentialTokens,
      this.credentialVaultEncryptor
    )

    return result
  }

  /**
   * Stages immutable Pilot V2 package containing deterministic plan JSON and signed manifest.
   * Invariant: Never executes live database import; creates staging artifacts only for P1-8 pilot execution.
   */
  public async stageV2(
    currentUser: User,
    request: MigrationV2StageRequest
  ): Promise<MigrationV2StageResult> {
    if (currentUser.role !== 'admin') {
      throw new ForbiddenError('Administrative access required for V2 package staging')
    }

    if (!Array.isArray(request.selectedWorkspaceIds) || request.selectedWorkspaceIds.length === 0) {
      throw new ValidationError('selectedWorkspaceIds must be a non-empty array')
    }

    const resolved = this.resolveSourcePathAndGroupsDir({
      stagedId: request.stagedId,
      sourcePath: request.sourcePath,
      groupsDir: request.sourceGroupsDir,
    })

    const targetUserId = request.targetUserId || currentUser.id
    const plan = createMigrationPlanV2({
      sourcePath: resolved.sourcePath,
      sourceGroupsDir: resolved.groupsDir,
      targetUserId,
      selectedWorkspaceIds: request.selectedWorkspaceIds,
      scopes: request.scopes,
    })

    const stagingRoot = this.stagedImportsDir || (this.allowlistedImportRoots[0] ? resolve(this.allowlistedImportRoots[0], 'staged-plans') : '/tmp/enkeep-staged-plans')

    return stageMigrationPackageV2(request, plan, stagingRoot)
  }

  /**
   * Executes V2 Pilot Migration consuming ONLY the immutable staged package identified by `planId`.
   * Never re-reads source database or external credentials.
   */
  public async executePilotV2(
    currentUser: User,
    request: { planId: string; targetUserId?: string; idempotencyKey?: string }
  ): Promise<PilotExecutionResult> {
    if (currentUser.role !== 'admin') {
      throw new ForbiddenError('Administrative access required for V2 pilot execution')
    }

    if (!request || typeof request.planId !== 'string' || request.planId.trim().length === 0) {
      throw new ValidationError('Field "planId" must be a non-empty string')
    }

    const stagingRoot = this.stagedImportsDir || (this.allowlistedImportRoots[0] ? resolve(this.allowlistedImportRoots[0], 'staged-plans') : '/tmp/enkeep-staged-plans')

    // Check Idempotency if key provided
    if (request.idempotencyKey) {
      const existingJob = this.db
        .prepare('SELECT id, status, result_json FROM import_jobs WHERE actor_user_id = ? AND idempotency_key = ?')
        .get(currentUser.id, request.idempotencyKey) as { id: string; status: string; result_json: string } | undefined

      if (existingJob && existingJob.result_json) {
        try {
          const parsed = JSON.parse(existingJob.result_json)
          if (parsed.success && parsed.planId === request.planId) {
            return parsed as PilotExecutionResult
          }
        } catch {}
      }
    }

    const result = await executePilotMigrationV2({
      stagingDir: stagingRoot,
      planId: request.planId,
      db: this.db,
      fileProvider: this.fileProvider,
      targetUserId: request.targetUserId,
    })

    return result
  }

  /**
   * Deletes ONLY imported pilot entities matching recorded IDs for the given planId.
   */
  public async deletePilotV2(
    currentUser: User,
    planId: string
  ): Promise<PilotCleanupResult> {
    if (currentUser.role !== 'admin') {
      throw new ForbiddenError('Administrative access required for V2 pilot cleanup')
    }

    if (typeof planId !== 'string' || planId.trim().length === 0) {
      throw new ValidationError('Parameter "planId" must be a non-empty string')
    }

    const stagingRoot = this.stagedImportsDir || (this.allowlistedImportRoots[0] ? resolve(this.allowlistedImportRoots[0], 'staged-plans') : '/tmp/enkeep-staged-plans')

    const result = await deletePilotMigrationV2({
      stagingDir: stagingRoot,
      planId,
      db: this.db,
      fileProvider: this.fileProvider,
    })

    return result
  }
}
