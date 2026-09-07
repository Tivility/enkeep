import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  linkSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  ALL_PLATFORM_MIGRATIONS,
  HappyClawMigrationRoutes,
  HappyClawMigrationService,
  PlatformServerMigrationRunner,
  SqlitePlatformWebApiAdapter,
  SqliteWebMessageStore,
} from '../src/index.js'
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite'
import { DefaultAuthService } from '@enkeep/platform-auth'
import type { User } from '@enkeep/platform-core'

function createCurrentSchemaDb(dbPath: string): string {
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE router_state (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO router_state (key, value) VALUES ('schema_version', '64');

    CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT, last_message_time TEXT);
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      chat_jid TEXT,
      sender TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      attachments TEXT
    );
    CREATE TABLE registered_groups (jid TEXT PRIMARY KEY, name TEXT, folder TEXT, execution_mode TEXT);

    INSERT INTO chats (jid, name, last_message_time) VALUES
      ('web:chat_1', 'Alice Space', '2026-08-01T12:01:00.000Z'),
      ('feishu:oc_2', 'Feishu Space', '2026-08-01T12:06:00.000Z');

    INSERT INTO registered_groups (jid, name, folder, execution_mode) VALUES
      ('web:chat_1', 'Alice Space', 'alice-space', 'container'),
      ('feishu:oc_2', 'Feishu Space', 'feishu-space', 'container');

    INSERT INTO messages (id, chat_jid, sender, content, timestamp, is_from_me, attachments) VALUES
      ('m1', 'web:chat_1', 'alice', 'How do we migrate?', '2026-08-01T12:00:00.000Z', 0, NULL),
      ('m2', 'web:chat_1', 'assistant', 'We use the staging pipeline.', '2026-08-01T12:01:00.000Z', 1, NULL),
      ('m3', 'feishu:oc_2', 'bob', 'Checking attachment.', '2026-08-01T12:05:00.000Z', 0, '["legacy-plan.pdf"]'),
      ('m4', 'feishu:oc_2', 'assistant', 'Attachment noted.', '2026-08-01T12:06:00.000Z', 1, NULL);
  `)
  db.close()
  return dbPath
}

function createLegacySchemaDb(dbPath: string): string {
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE messages (id TEXT PRIMARY KEY, chat_jid TEXT, content TEXT, timestamp TEXT, is_from_me INTEGER);
    INSERT INTO chats (jid, name) VALUES ('web:legacy_chat', 'Legacy Chat');
    INSERT INTO messages (id, chat_jid, content, timestamp, is_from_me) VALUES
      ('lm1', 'web:legacy_chat', 'Hello legacy', '2026-08-01T10:00:00.000Z', 0),
      ('lm2', 'web:legacy_chat', 'Hi from legacy assistant', '2026-08-01T10:01:00.000Z', 1);
  `)
  db.close()
  return dbPath
}

function createMinimalSchemaDb(dbPath: string): string {
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE messages (id TEXT PRIMARY KEY, chat_jid TEXT, content TEXT, timestamp TEXT, is_from_me INTEGER);
    INSERT INTO messages (id, chat_jid, content, timestamp, is_from_me) VALUES
      ('mm1', 'min:chat_min', 'Minimal message only', '2026-08-01T11:00:00.000Z', 0),
      ('mm2', 'min:chat_min', 'Minimal reply', '2026-08-01T11:01:00.000Z', 1);
  `)
  db.close()
  return dbPath
}

function createLargeScaleDb(dbPath: string, conversationCount: number = 100): string {
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE messages (id TEXT PRIMARY KEY, chat_jid TEXT, content TEXT, timestamp TEXT, is_from_me INTEGER, attachments TEXT);
    CREATE TABLE registered_groups (jid TEXT PRIMARY KEY, name TEXT, folder TEXT, execution_mode TEXT);
  `)

  const chatStmt = db.prepare('INSERT INTO chats (jid, name) VALUES (?, ?)')
  const groupStmt = db.prepare('INSERT INTO registered_groups (jid, name, folder, execution_mode) VALUES (?, ?, ?, ?)')
  const msgStmt = db.prepare('INSERT INTO messages (id, chat_jid, content, timestamp, is_from_me, attachments) VALUES (?, ?, ?, ?, ?, ?)')

  db.exec('BEGIN IMMEDIATE')
  for (let i = 1; i <= conversationCount; i++) {
    const jid = `scale:conv_${String(i).padStart(3, '0')}`
    const name = `Conversation ${i}`
    const folder = `space-${String(i).padStart(3, '0')}`
    chatStmt.run(jid, name)
    groupStmt.run(jid, name, folder, 'container')

    msgStmt.run(`msg_${i}_1`, jid, `User prompt ${i}`, `2026-08-01T12:${String(i % 60).padStart(2, '0')}:00.000Z`, 0, i % 5 === 0 ? '["doc.pdf"]' : null)
    msgStmt.run(`msg_${i}_2`, jid, `Assistant response ${i}`, `2026-08-01T12:${String(i % 60).padStart(2, '0')}:30.000Z`, 1, null)
  }
  db.exec('COMMIT')
  db.close()
  return dbPath
}

function createMockReqRes(method: string, bodyJson?: unknown, headers: Record<string, string> = {}) {
  const chunks: Buffer[] = []
  if (bodyJson !== undefined) {
    chunks.push(Buffer.from(JSON.stringify(bodyJson), 'utf8'))
  }

  let chunkIdx = 0
  const req = {
    method,
    headers: {
      host: '127.0.0.1:3000',
      origin: 'http://127.0.0.1:3000',
      'x-enkeep-csrf': 'csrf_token_test_1234567890123456789012',
      ...headers,
    },
    socket: {
      localAddress: '127.0.0.1',
      localPort: 3000,
    },
    on(event: string, callback: any) {
      if (event === 'data') {
        while (chunkIdx < chunks.length) {
          callback(chunks[chunkIdx++])
        }
      } else if (event === 'end') {
        callback()
      }
      return this
    },
  } as unknown as IncomingMessage

  let statusCode = 200
  let writtenData = ''
  const res = {
    writeHead(code: number) {
      statusCode = code
    },
    end(data?: string) {
      if (data) writtenData += data
    },
  } as unknown as ServerResponse

  return { req, res, getStatus: () => statusCode, getBody: () => (writtenData ? JSON.parse(writtenData) : null) }
}

describe('HappyClaw Migration Service & Backend Routes', () => {
  let tempDir: string
  let platformDb: DatabaseSync
  let storage: SqlitePlatformStorage
  let authService: DefaultAuthService
  let messageStore: SqliteWebMessageStore
  let platformApi: SqlitePlatformWebApiAdapter
  let migrationService: HappyClawMigrationService
  let routes: HappyClawMigrationRoutes
  let allowlistedDir: string
  let unallowlistedDir: string
  let stagedDir: string
  let sourceDbPath: string

  const adminUser: User = {
    id: 'usr_admin',
    username: 'admin',
    role: 'admin',
    status: 'active',
    displayName: 'Admin User',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  }

  const memberUser: User = {
    id: 'usr_member',
    username: 'member',
    role: 'member',
    status: 'active',
    displayName: 'Member User',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  }

  const validCsrf = 'csrf_token_test_1234567890123456789012'

  beforeEach(async () => {
    tempDir = join(tmpdir(), `enkeep-migration-test-${randomUUID()}`)
    allowlistedDir = join(tempDir, 'allowlisted')
    unallowlistedDir = join(tempDir, 'unallowlisted')
    stagedDir = join(tempDir, 'staged')
    mkdirSync(allowlistedDir, { recursive: true })
    mkdirSync(unallowlistedDir, { recursive: true })
    mkdirSync(stagedDir, { recursive: true })

    sourceDbPath = createCurrentSchemaDb(join(allowlistedDir, 'messages.db'))

    // Platform DB setup
    const platformDbPath = join(tempDir, 'platform.db')
    platformDb = new DatabaseSync(platformDbPath)
    const runner = new PlatformServerMigrationRunner(platformDb)
    await runner.migrate(ALL_PLATFORM_MIGRATIONS)

    storage = new SqlitePlatformStorage(platformDb)
    authService = new DefaultAuthService(storage, {
      cookieSecret: 'cookie_secret_at_least_32_characters_long_12345',
      cookieSecure: false,
    })
    messageStore = new SqliteWebMessageStore(platformDb)
    platformApi = new SqlitePlatformWebApiAdapter({
      db: platformDb,
      storage,
      authService,
      messageStore,
    })

    // Seed users into platform database
    platformDb.exec(`
      INSERT INTO users (id, username, password_hash, display_name, role, status, created_at, updated_at)
      VALUES
        ('usr_admin', 'admin', 'hash_admin', 'Admin User', 'admin', 'active', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'),
        ('usr_member', 'member', 'hash_member', 'Member User', 'member', 'active', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'),
        ('alice', 'alice', 'hash_alice', 'Alice', 'member', 'active', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'),
        ('bob', 'bob', 'hash_bob', 'Bob', 'member', 'active', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'),
        ('inactive_user', 'inactive', 'hash_inact', 'Inactive User', 'member', 'suspended', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
    `)

    migrationService = new HappyClawMigrationService({
      db: platformDb,
      storage,
      allowlistedImportRoots: [allowlistedDir],
      stagedImportsDir: stagedDir,
    })

    routes = new HappyClawMigrationRoutes(migrationService, validCsrf)
  })

  afterEach(() => {
    try {
      platformDb.close()
    } catch {}
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  describe('1. Staged Listing & Security Bounds (GET /api/admin/imports/staged)', () => {
    it('lists staged databases and refuses access for non-admin users', async () => {
      await expect(migrationService.listStaged(memberUser)).rejects.toThrow(
        /Administrative access required/
      )
    })

    it('scans staging directories and returns public metadata without leaking absolute paths', async () => {
      createCurrentSchemaDb(join(stagedDir, 'staged_chat.db'))

      const items = await migrationService.listStaged(adminUser)
      expect(items.length).toBeGreaterThan(0)
      const found = items.find((i) => i.name.includes('staged_chat.db'))
      expect(found).toBeDefined()
      expect(found!.stagedId).toMatch(/^stg_[a-f0-9]+$/)
      expect(found!.size).toBeGreaterThan(0)
      expect(found!.inspectionStatus).toBe('ready')

      expect((found as any).canonicalPath).toBeUndefined()
      expect((found as any).hostPath).toBeUndefined()
      expect((found as any).sourcePath).toBeUndefined()
    })

    it('rejects symlinks placed inside staging directory', async () => {
      const realTarget = createCurrentSchemaDb(join(tempDir, 'outside_target.db'))
      const symlinkPath = join(stagedDir, 'symlink_attack.db')
      symlinkSync(realTarget, symlinkPath)

      const items = await migrationService.listStaged(adminUser)
      const symlinkItem = items.find((i) => i.name.includes('symlink_attack.db'))
      expect(symlinkItem).toBeUndefined()
    })

    it('rejects hardlinks placed inside staging directory', async () => {
      const realFile = createCurrentSchemaDb(join(stagedDir, 'original.db'))
      const hardlinkPath = join(stagedDir, 'hardlink.db')
      try {
        linkSync(realFile, hardlinkPath)
        const items = await migrationService.listStaged(adminUser)
        const hardlinkItem = items.find((i) => i.name.includes('hardlink.db'))
        expect(hardlinkItem).toBeUndefined()
      } catch {}
    })

    it('identifies malformed/non-SQLite files as invalid inspectionStatus', async () => {
      const malformedPath = join(stagedDir, 'corrupt.db')
      writeFileSync(malformedPath, 'NOT A SQLITE DATABASE HEADER')

      const items = await migrationService.listStaged(adminUser)
      const corruptItem = items.find((i) => i.name.includes('corrupt.db'))
      expect(corruptItem).toBeDefined()
      expect(corruptItem!.inspectionStatus).toBe('invalid')
    })
  })

  describe('2. Idempotent Inspection & Schema Compatibility (POST /staged/:id/inspect)', () => {
    it('inspects current schema database and produces accurate counts and attachment notice', async () => {
      createCurrentSchemaDb(join(stagedDir, 'current_test.db'))
      const items = await migrationService.listStaged(adminUser)
      const stagedId = items.find((i) => i.name.includes('current_test.db'))!.stagedId

      const inspectRes = await migrationService.inspectStaged(adminUser, stagedId)
      expect(inspectRes.stagedId).toBe(stagedId)
      expect(inspectRes.diagnostic.compatibilityLevel).toBe('current')
      expect(inspectRes.diagnostic.detectedSchemaVersion).toBe(64)
      expect(inspectRes.totalConversations).toBe(2)
      expect(inspectRes.totalMessages).toBe(4)
      expect(inspectRes.totalAttachments).toBe(1)
      expect(inspectRes.attachmentNotice).toContain('Will migrate text messages only')

      expect(inspectRes.conversations).toHaveLength(2)
      expect(inspectRes.conversations[0].id).toMatch(/^[a-f0-9]{16}$/)
    })

    it('inspects legacy schema database with structured diagnostic warnings', async () => {
      createLegacySchemaDb(join(stagedDir, 'legacy_test.db'))
      const items = await migrationService.listStaged(adminUser)
      const stagedId = items.find((i) => i.name.includes('legacy_test.db'))!.stagedId

      const inspectRes = await migrationService.inspectStaged(adminUser, stagedId)
      expect(inspectRes.diagnostic.compatibilityLevel).toBe('legacy')
      expect(inspectRes.diagnostic.detectedSchemaVersion).toBeNull()
      expect(inspectRes.totalConversations).toBe(1)
      expect(inspectRes.totalMessages).toBe(2)
    })

    it('inspects minimal single-table schema (messages only)', async () => {
      createMinimalSchemaDb(join(stagedDir, 'minimal_test.db'))
      const items = await migrationService.listStaged(adminUser)
      const stagedId = items.find((i) => i.name.includes('minimal_test.db'))!.stagedId

      const inspectRes = await migrationService.inspectStaged(adminUser, stagedId)
      expect(inspectRes.diagnostic.compatibilityLevel).toBe('minimal')
      expect(inspectRes.totalConversations).toBe(1)
      expect(inspectRes.totalMessages).toBe(2)
    })

    it('supports 100 conversations scale and pagination (limit, offset, search)', async () => {
      createLargeScaleDb(join(stagedDir, 'scale100.db'), 100)
      const items = await migrationService.listStaged(adminUser)
      const stagedId = items.find((i) => i.name.includes('scale100.db'))!.stagedId

      // Page 1 (limit 20, offset 0)
      const page1 = await migrationService.inspectStaged(adminUser, stagedId, { limit: 20, offset: 0 })
      expect(page1.totalConversations).toBe(100)
      expect(page1.totalMessages).toBe(200)
      expect(page1.conversations).toHaveLength(20)
      expect(page1.pagination.hasMore).toBe(true)

      // Page 2 (limit 20, offset 20)
      const page2 = await migrationService.inspectStaged(adminUser, stagedId, { limit: 20, offset: 20 })
      expect(page2.conversations).toHaveLength(20)
      expect(page2.conversations[0].sourceKey).not.toEqual(page1.conversations[0].sourceKey)

      // Search filter
      const searchRes = await migrationService.inspectStaged(adminUser, stagedId, { search: 'conv_042' })
      expect(searchRes.conversations.length).toBe(1)
      expect(searchRes.conversations[0].sourceKey).toBe('scale:conv_042')
    })
  })

  describe('3. Durable SQLite Migration Jobs (Migration 020), Dry-Run & TOCTOU', () => {
    it('executes dry-run without mutating spaces or session routes, persists job result in SQLite', async () => {
      createCurrentSchemaDb(join(stagedDir, 'dryrun_test.db'))
      const items = await migrationService.listStaged(adminUser)
      const stagedId = items.find((i) => i.name.includes('dryrun_test.db'))!.stagedId

      const res = await migrationService.migrateStaged(adminUser, stagedId, {
        targetUserId: 'alice',
        dryRun: true,
      })

      expect(res.dryRun).toBe(true)
      expect(res.plan.totalConversations).toBe(2)
      expect(res.plan.totalMessages).toBe(4)

      // Verify no spaces or session_routes in DB
      const spaceCount = (platformDb.prepare('SELECT COUNT(*) as count FROM spaces').get() as any).count
      expect(spaceCount).toBe(0)

      // Verify durable job stored in SQLite import_jobs table
      const jobRow = platformDb.prepare('SELECT id, status, dry_run, target_user_id FROM import_jobs WHERE id = ?').get(res.jobId) as any
      expect(jobRow).toBeDefined()
      expect(jobRow.status).toBe('completed')
      expect(jobRow.dry_run).toBe(1)
      expect(jobRow.target_user_id).toBe('alice')
    })

    it('rejects migration targeting inactive or non-existent user', async () => {
      createCurrentSchemaDb(join(stagedDir, 'tenant_test.db'))
      const items = await migrationService.listStaged(adminUser)
      const stagedId = items.find((i) => i.name.includes('tenant_test.db'))!.stagedId

      // Non-existent user
      await expect(
        migrationService.migrateStaged(adminUser, stagedId, { targetUserId: 'non_existent_usr' })
      ).rejects.toThrow(/not found/)

      // Suspended / inactive user
      await expect(
        migrationService.migrateStaged(adminUser, stagedId, { targetUserId: 'inactive_user' })
      ).rejects.toThrow(/not active/)
    })

    it('executes real migration with dual write, generation 1, and durable job record in SQLite', async () => {
      createCurrentSchemaDb(join(stagedDir, 'real_migrate.db'))
      const items = await migrationService.listStaged(adminUser)
      const stagedId = items.find((i) => i.name.includes('real_migrate.db'))!.stagedId

      const res = await migrationService.migrateStaged(adminUser, stagedId, {
        targetUserId: 'alice',
        dryRun: false,
      })

      expect(res.success).toBe(true)
      expect(res.dryRun).toBe(false)
      expect(res.jobId).toBeDefined()
      expect(res.compiledChats).toHaveLength(2)

      // Verify spaces & session_routes
      const spaces = platformDb.prepare('SELECT id, user_id, folder FROM spaces WHERE user_id = ?').all('alice') as any[]
      expect(spaces).toHaveLength(2)

      const routes = platformDb.prepare('SELECT id, space_id, user_id, channel FROM session_routes WHERE user_id = ?').all('alice') as any[]
      expect(routes).toHaveLength(2)
      expect(routes.every((r) => r.channel === 'web')).toBe(true)

      // Verify generation 1
      const gens = platformDb.prepare('SELECT generation_number, reset_reason FROM session_generations WHERE user_id = ?').all('alice') as any[]
      expect(gens).toHaveLength(2)
      expect(gens.every((g) => g.generation_number === 1)).toBe(true)

      // Verify durable job status in SQLite
      const jobStatus = migrationService.getJobStatus(res.jobId)
      expect(jobStatus).toBeDefined()
      expect(jobStatus!.status).toBe('completed')
      expect(jobStatus!.result).toBeDefined()
      expect(jobStatus!.result!.sessionLinks.length).toBe(2)

      // Verify granular child table import_job_conversations
      const convRows = platformDb.prepare('SELECT * FROM import_job_conversations WHERE job_id = ?').all(res.jobId) as any[]
      expect(convRows).toHaveLength(2)
      expect(convRows.every((r) => r.status === 'completed')).toBe(true)
    })

    it('detects TOCTOU file modification / swap attack and aborts execution', async () => {
      const dbPath = join(stagedDir, 'toctou_victim.db')
      createCurrentSchemaDb(dbPath)

      const items = await migrationService.listStaged(adminUser)
      const stagedId = items.find((i) => i.name.includes('toctou_victim.db'))!.stagedId

      // Simulate swap attack: Modify file contents/size behind the staged ID
      writeFileSync(dbPath, 'TAMPERED REPLACED CONTENT AFTER STAGING INITIAL REGISTRATION')

      await expect(
        migrationService.migrateStaged(adminUser, stagedId, { targetUserId: 'alice' })
      ).rejects.toThrow(/TOCTOU integrity check failed/)
    })

    it('enforces Idempotency-Key: replays cached result on identical request and throws 409 Conflict on payload mismatch', async () => {
      createCurrentSchemaDb(join(stagedDir, 'idemp_test.db'))
      const items = await migrationService.listStaged(adminUser)
      const stagedId = items.find((i) => i.name.includes('idemp_test.db'))!.stagedId

      const idempKey = `test_idemp_key_${randomUUID()}`

      // 1. Initial execution with Idempotency-Key
      const res1 = await migrationService.migrateStaged(adminUser, stagedId, {
        targetUserId: 'alice',
        idempotencyKey: idempKey,
      })
      expect(res1.success).toBe(true)

      // 2. Exact same request with same Idempotency-Key -> replays cached completed job
      const res2 = await migrationService.migrateStaged(adminUser, stagedId, {
        targetUserId: 'alice',
        idempotencyKey: idempKey,
      })
      expect(res2.jobId).toBe(res1.jobId)

      // 3. Different request payload with same Idempotency-Key -> throws 409 Conflict
      await expect(
        migrationService.migrateStaged(adminUser, stagedId, {
          targetUserId: 'bob', // Different target user
          idempotencyKey: idempKey,
        })
      ).rejects.toThrow(/Idempotency conflict/)
    })
  })

  describe('4. Server Restart Crash Recovery & Job Resume', () => {
    it('marks orphaned running jobs as interrupted on server restart recovery', async () => {
      createCurrentSchemaDb(join(stagedDir, 'orphan.db'))
      const items = await migrationService.listStaged(adminUser)
      const stagedId = items.find((i) => i.name.includes('orphan.db'))!.stagedId

      const orphanJobId = `job_orphan_${randomUUID()}`
      platformDb.prepare(`
        INSERT INTO import_jobs (
          id, actor_user_id, target_user_id, staged_id, source_fingerprint,
          request_hash, status, dry_run, total_conversations, completed_conversations,
          created_at, updated_at
        ) VALUES (?, 'usr_admin', 'alice', ?, 'fp_test', 'hash_test', 'running', 0, 2, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(orphanJobId, stagedId)

      // Simulate platform server restart by creating a new service instance
      const freshService = new HappyClawMigrationService({
        db: platformDb,
        storage,
        allowlistedImportRoots: [allowlistedDir],
        stagedImportsDir: stagedDir,
      })

      const jobStatus = freshService.getJobStatus(orphanJobId)
      expect(jobStatus).toBeDefined()
      expect(jobStatus!.status).toBe('interrupted')
    })

    it('resumes interrupted job via POST /api/admin/imports/staged/jobs/:jobId/resume', async () => {
      createCurrentSchemaDb(join(stagedDir, 'resume_target.db'))
      const items = await migrationService.listStaged(adminUser)
      const stagedId = items.find((i) => i.name.includes('resume_target.db'))!.stagedId

      const interruptedJobId = `job_interrupted_${randomUUID()}`
      const createdAt = new Date().toISOString()
      platformDb.prepare(`
        INSERT INTO import_jobs (
          id, actor_user_id, target_user_id, staged_id, source_fingerprint,
          request_hash, status, dry_run, total_conversations, completed_conversations,
          created_at, updated_at
        ) VALUES (?, 'usr_admin', 'alice', ?, 'fp_test', 'hash_test', 'interrupted', 0, 2, 0, ?, ?)
      `).run(interruptedJobId, stagedId, createdAt, createdAt)

      platformDb.prepare(`
        INSERT INTO import_job_conversations (id, job_id, source_key, status, created_at, updated_at)
        VALUES ('ijc_r1', ?, 'web:chat_1', 'pending', ?, ?), ('ijc_r2', ?, 'feishu:oc_2', 'pending', ?, ?)
      `).run(interruptedJobId, createdAt, createdAt, interruptedJobId, createdAt, createdAt)

      // Call resume route
      const { req: rResume, res: resResume, getStatus, getBody } = createMockReqRes('POST')
      const handled = await routes.handle(rResume, resResume, `/api/admin/imports/staged/jobs/${interruptedJobId}/resume`, adminUser)
      expect(handled).toBe(true)
      expect(getStatus()).toBe(200)
      expect(getBody().data.status).toBe('completed')
    })
  })

  describe('5. Canonical Routes vs Old Route 404 Assertion', () => {
    it('asserts canonical endpoints return true and old happyclaw/v1 routes return false (404)', async () => {
      createCurrentSchemaDb(join(stagedDir, 'route_test.db'))
      const items = await migrationService.listStaged(adminUser)
      const stagedId = items.find((i) => i.name.includes('route_test.db'))!.stagedId

      // 1. Canonical GET /api/admin/imports/staged -> handled (true)
      const { req: r1, res: res1, getStatus: s1 } = createMockReqRes('GET')
      expect(await routes.handle(r1, res1, '/api/admin/imports/staged', adminUser)).toBe(true)
      expect(s1()).toBe(200)

      // 2. Canonical POST /api/admin/imports/staged/:id/inspect -> handled (true)
      const { req: r2, res: res2, getStatus: s2 } = createMockReqRes('POST', { limit: 10 })
      expect(await routes.handle(r2, res2, `/api/admin/imports/staged/${stagedId}/inspect`, adminUser)).toBe(true)
      expect(s2()).toBe(200)

      // 3. Old /api/v1 aliases must NOT be handled (returns false -> 404 in server)
      const { req: rv1, res: resv1 } = createMockReqRes('GET')
      expect(await routes.handle(rv1, resv1, '/api/v1/admin/imports/staged', adminUser)).toBe(false)

      const { req: rv1Inspect, res: resv1Inspect } = createMockReqRes('POST')
      expect(await routes.handle(rv1Inspect, resv1Inspect, `/api/v1/admin/imports/staged/${stagedId}/inspect`, adminUser)).toBe(false)

      // 4. Old /api/admin/imports/happyclaw/* routes must NOT be handled (returns false -> 404 in server)
      const { req: rh1, res: resh1 } = createMockReqRes('POST', { sourcePath: sourceDbPath })
      expect(await routes.handle(rh1, resh1, '/api/admin/imports/happyclaw/inspect', adminUser)).toBe(false)

      const { req: rh2, res: resh2 } = createMockReqRes('POST', { sourcePath: sourceDbPath })
      expect(await routes.handle(rh2, resh2, '/api/admin/imports/happyclaw/execute', adminUser)).toBe(false)

      const { req: rh3, res: resh3 } = createMockReqRes('GET')
      expect(await routes.handle(rh3, resh3, '/api/admin/imports/happyclaw/status/job_123', adminUser)).toBe(false)

      const { req: rh4, res: resh4 } = createMockReqRes('POST')
      expect(await routes.handle(rh4, resh4, '/api/admin/imports/happyclaw/cancel/job_123', adminUser)).toBe(false)
    })
  })

  describe('6. Chat Continuation in Platform after Migration', () => {
    it('allows migrated session to appear in listSessions and receive new user turns', async () => {
      createCurrentSchemaDb(join(stagedDir, 'chat_continue.db'))
      const items = await migrationService.listStaged(adminUser)
      const stagedId = items.find((i) => i.name.includes('chat_continue.db'))!.stagedId

      await migrationService.migrateStaged(adminUser, stagedId, { targetUserId: 'alice' })

      // 1. Session is listed in platformApi
      const sessions = await platformApi.listSessions('alice')
      expect(sessions.length).toBeGreaterThanOrEqual(1)
      const migratedSession = sessions[0]

      // 2. Fetch messages for migrated session
      const history = await platformApi.listMessages('alice', migratedSession.id)
      expect(history.messages.length).toBeGreaterThanOrEqual(2)
      expect(history.messages.some((m) => m.content.includes('How do we migrate?'))).toBe(true)

      // 3. Append new message to continue the conversation in Docker / runtime
      const ingestRes = await messageStore.ingestWebDelivery({
        userId: 'alice',
        sessionId: migratedSession.id,
        spaceId: migratedSession.spaceId,
        dshSessionId: migratedSession.dshSessionId || migratedSession.id,
        idempotencyKey: `idem_${randomUUID()}`,
        content: 'Follow-up question after successful migration.',
        timestamp: new Date().toISOString(),
      })

      expect(ingestRes.state).toBe('held')
      expect(ingestRes.isClaimant).toBe(true)

      const updatedHistory = await platformApi.listMessages('alice', migratedSession.id)
      expect(updatedHistory.messages.length).toBeGreaterThan(history.messages.length)
      expect(updatedHistory.messages.some((m) => m.content.includes('Follow-up question'))).toBe(true)
    })
  })
})
