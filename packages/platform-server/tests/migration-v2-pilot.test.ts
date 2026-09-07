import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { EventEmitter } from 'node:events'
import {
  ALL_PLATFORM_MIGRATIONS,
  HappyClawMigrationRoutes,
  HappyClawMigrationService,
  PlatformServerMigrationRunner,
} from '../src/index.js'
import {
  createSyntheticV2Fixture,
  type SourceCredentialCapability,
} from '@enkeep/import-happyclaw'
import type { User } from '@enkeep/platform-core'
import type { CanonicalFileOperationRequest, CanonicalFileOperationResult, TenantRuntimeFileProvider } from '../src/files/runtime-file-api.js'

interface MockHttpRequestOptions {
  method?: string
  url?: string
  headers?: Record<string, string>
  body?: unknown
}

function createMockReq(options: MockHttpRequestOptions): IncomingMessage {
  const emitter = new EventEmitter() as any
  emitter.method = options.method || 'GET'
  emitter.url = options.url || '/'
  emitter.headers = {
    host: '127.0.0.1:3000',
    origin: 'http://127.0.0.1:3000',
    'x-enkeep-csrf': options.headers?.['x-enkeep-csrf'] || 'a'.repeat(64),
    ...(options.headers || {}),
  }
  emitter.socket = {
    localAddress: '127.0.0.1',
    localPort: 3000,
    remoteAddress: '127.0.0.1',
  }

  process.nextTick(() => {
    if (options.body !== undefined) {
      const data = typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
      emitter.emit('data', Buffer.from(data, 'utf8'))
    }
    emitter.emit('end')
  })

  return emitter as IncomingMessage
}

function createMockRes(): { res: ServerResponse; getResult: () => { statusCode: number; headers: Record<string, string>; json: any } } {
  let statusCode = 200
  const headers: Record<string, string> = {}
  let body = ''

  const res = {
    writeHead(code: number, hdrs: Record<string, string>) {
      statusCode = code
      Object.assign(headers, hdrs)
      return res
    },
    end(data?: string) {
      if (data) body += data
    },
  } as unknown as ServerResponse

  return {
    res,
    getResult: () => ({
      statusCode,
      headers,
      json: body ? JSON.parse(body) : null,
    }),
  }
}

describe('P1-8 Migration V2 Pilot Execution & Lifecycle: Stage -> Execute -> Verify -> Cleanup', () => {
  let testRoot: string
  let platformDb: DatabaseSync
  let stagingDir: string
  let service: HappyClawMigrationService
  let routes: HappyClawMigrationRoutes
  let fixtureDbPath: string
  let fixtureGroupsDir: string
  const CSRF_TOKEN = 'a'.repeat(64)

  // In-memory runtime file storage mock
  const mockStorage = new Map<string, string>()

  const mockFileProvider: TenantRuntimeFileProvider = {
    async execute(
      userId: string,
      spaceId: string,
      req: CanonicalFileOperationRequest
    ): Promise<CanonicalFileOperationResult> {
      const key = `${userId}:${spaceId}:${req.path}`
      if (req.op === 'write') {
        mockStorage.set(key, req.content || '')
        return {
          op: 'write',
          space: spaceId,
          path: req.path,
          type: 'file',
          size: Buffer.byteLength(req.content || '', 'utf8'),
          mtimeMs: Date.now(),
          etag: `"${createHash('sha256').update(req.content || '').digest('hex')}"`,
        }
      }
      if (req.op === 'read') {
        const content = mockStorage.get(key)
        if (content === undefined) {
          throw { status: 404, code: 'NOT_FOUND', message: `File not found: ${req.path}` }
        }
        return {
          op: 'read',
          space: spaceId,
          path: req.path,
          content,
          encoding: 'utf8',
          type: 'file',
          size: Buffer.byteLength(content, 'utf8'),
          mtimeMs: Date.now(),
          etag: `"${createHash('sha256').update(content).digest('hex')}"`,
        }
      }
      if (req.op === 'rm') {
        mockStorage.delete(key)
        return {
          op: 'rm',
          space: spaceId,
          path: req.path,
          type: 'file',
          size: 0,
          mtimeMs: Date.now(),
          etag: '""',
        }
      }
      return {
        op: 'stat',
        space: spaceId,
        path: req.path,
        type: 'file',
        size: 0,
        mtimeMs: Date.now(),
        etag: '""',
      }
    },
    async writeGlobalInstructions(userId: string, content: string) {
      mockStorage.set(`global:${userId}:CLAUDE.md`, content)
      return {
        etag: `"${createHash('sha256').update(content).digest('hex')}"`,
        size: Buffer.byteLength(content, 'utf8'),
        mtimeMs: Date.now(),
      }
    },
    async readGlobalInstructions(userId: string) {
      const content = mockStorage.get(`global:${userId}:CLAUDE.md`)
      if (!content) {
        return { content: '', etag: null, size: 0, mtimeMs: 0, exists: false }
      }
      return {
        content,
        etag: `"${createHash('sha256').update(content).digest('hex')}"`,
        size: Buffer.byteLength(content, 'utf8'),
        mtimeMs: Date.now(),
        exists: true,
      }
    },
  }

  const adminUser: User = {
    id: 'usr_admin',
    username: 'admin',
    role: 'admin',
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  beforeEach(async () => {
    testRoot = join(tmpdir(), `enkeep-p1-8-pilot-${randomUUID()}`)
    stagingDir = join(testRoot, 'staging')
    mkdirSync(testRoot, { recursive: true })
    mkdirSync(stagingDir, { recursive: true })

    const fixture = createSyntheticV2Fixture(join(testRoot, 'fixture'))
    fixtureDbPath = fixture.dbPath
    fixtureGroupsDir = fixture.groupsDir

    const dbPath = join(testRoot, 'platform.db')
    platformDb = new DatabaseSync(dbPath)
    const runner = new PlatformServerMigrationRunner(platformDb)
    await runner.migrate(ALL_PLATFORM_MIGRATIONS)

    // Pre-seed baseline admin and an unrelated user fixture
    platformDb.exec(`
      INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at) VALUES
        ('usr_admin', 'admin', 'scrypt$dummyhashadmin', 'admin', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('unrelated_user', 'unrelated', 'scrypt$dummyhashunrelated', 'user', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('alice', 'alice', 'scrypt$dummyhashalice', 'admin', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

      -- Unrelated baseline space that must NOT be touched by cleanup
      INSERT INTO spaces (id, user_id, name, folder, execution_mode, status, created_at, updated_at) VALUES
        ('space_unrelated_baseline', 'unrelated_user', 'Unrelated Space', 'unrelated-space', 'container', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    `)

    service = new HappyClawMigrationService({
      db: platformDb,
      stagedImportsDir: stagingDir,
      allowlistedImportRoots: [testRoot],
      fileProvider: mockFileProvider,
    })
    routes = new HappyClawMigrationRoutes(service, CSRF_TOKEN)
  })

  afterEach(() => {
    try {
      platformDb.close()
    } catch {}
    if (existsSync(testRoot)) {
      rmSync(testRoot, { recursive: true, force: true })
    }
    mockStorage.clear()
  })

  it('completes the full V2 pilot migration lifecycle: stage -> execute-pilot -> verify behavior -> delete-pilot', async () => {
    // -------------------------------------------------------------------------
    // Phase 1: Stage V2 Package (Synthetic 3-Workspace HappyClaw Source)
    // -------------------------------------------------------------------------
    const { res: stageRes, getResult: getStageResult } = createMockRes()
    const stageReq = createMockReq({
      method: 'POST',
      url: '/api/manage/migrations/happyclaw/stage',
      headers: {
        'x-enkeep-csrf-token': CSRF_TOKEN,
        'content-type': 'application/json',
      },
      body: {
        sourcePath: fixtureDbPath,
        sourceGroupsDir: fixtureGroupsDir,
        targetUserId: 'alice',
        selectedWorkspaceIds: ['web:alice-space', 'feishu:bob-space', 'web:charlie-space'],
        scopes: {
          coreData: true,
          extensions: true,
          tasks: true,
          channelsMetadata: true,
          credentials: false,
        },
      },
    })

    const handledStage = await routes.handle(stageReq, stageRes, '/api/manage/migrations/happyclaw/stage', adminUser)
    expect(handledStage).toBe(true)

    const stageResult = getStageResult()
    expect(stageResult.statusCode).toBe(200)
    expect(stageResult.json.success).toBe(true)
    expect(stageResult.json.data.staged).toBe(true)

    const planId = stageResult.json.data.planId
    expect(planId).toMatch(/^plan_v2_[a-f0-9]{24}$/)
    expect(existsSync(stageResult.json.data.stageDir)).toBe(true)

    // Verify staged package payload files exist
    const planFile = join(stageResult.json.data.stageDir, 'migration-plan-v2.json')
    const manifestFile = join(stageResult.json.data.stageDir, 'stage-manifest.json')
    const sessionsFile = join(stageResult.json.data.stageDir, 'payload', 'sessions.json')
    const filesDir = join(stageResult.json.data.stageDir, 'payload', 'files')

    expect(existsSync(planFile)).toBe(true)
    expect(existsSync(manifestFile)).toBe(true)
    expect(existsSync(sessionsFile)).toBe(true)
    expect(existsSync(filesDir)).toBe(true)

    // -------------------------------------------------------------------------
    // Phase 2: Execute V2 Pilot (Consuming ONLY Staged planId)
    // -------------------------------------------------------------------------
    const { res: execRes, getResult: getExecResult } = createMockRes()
    const execReq = createMockReq({
      method: 'POST',
      url: '/api/manage/migrations/happyclaw/execute-pilot',
      headers: {
        'x-enkeep-csrf-token': CSRF_TOKEN,
        'content-type': 'application/json',
      },
      body: {
        planId,
      },
    })

    const handledExec = await routes.handle(execReq, execRes, '/api/manage/migrations/happyclaw/execute-pilot', adminUser)
    expect(handledExec).toBe(true)

    const execResult = getExecResult()
    expect(execResult.statusCode).toBe(200)
    expect(execResult.json.success).toBe(true)

    const execData = execResult.json.data
    expect(execData.planId).toBe(planId)
    expect(execData.targetUserId).toBe('alice')
    expect(execData.stats.workspaces).toBe(3)
    expect(execData.stats.sessions).toBe(3)
    expect(execData.stats.messages).toBe(6)
    expect(execData.stats.extensions).toBeGreaterThanOrEqual(4)
    expect(execData.stats.quarantinedExtensions).toBeGreaterThanOrEqual(1) // External uncompiled/untrusted plugins quarantined!
    expect(execData.stats.tasks).toBe(2)
    expect(execData.stats.channelAccounts).toBe(3)
    expect(execData.stats.channelBindings).toBe(3)
    expect(execData.stats.files).toBeGreaterThanOrEqual(3)

    // -------------------------------------------------------------------------
    // Phase 3: Behavior Verification After Import
    // -------------------------------------------------------------------------

    // 3.1 Verify database foreign key integrity
    const fkCheck = platformDb.prepare('PRAGMA foreign_key_check').all()
    expect(fkCheck).toEqual([])

    // 3.2 Verify Spaces
    const spaces = platformDb.prepare('SELECT id, name, folder, status FROM spaces WHERE user_id = ?').all('alice') as any[]
    expect(spaces).toHaveLength(3)
    const spaceFolders = spaces.map((s) => s.folder).sort()
    expect(spaceFolders).toEqual(['alice-space', 'bob-space', 'charlie-space'])

    // 3.3 Verify Agent Profiles & Snapshots
    const profiles = platformDb.prepare('SELECT id, name, active_version FROM agent_profiles WHERE user_id = ?').all('alice') as any[]
    expect(profiles.length).toBeGreaterThanOrEqual(1)
    const snapshots = platformDb.prepare('SELECT id, profile_id, identity, prompt_hash FROM agent_profile_snapshots WHERE user_id = ?').all('alice') as any[]
    expect(snapshots.length).toBeGreaterThanOrEqual(1)

    // 3.4 Verify Sessions & Messages
    const routesRows = platformDb.prepare('SELECT id, space_id, dsh_session_id, status FROM session_routes WHERE user_id = ?').all('alice') as any[]
    expect(routesRows).toHaveLength(3)

    const messagesRows = platformDb.prepare('SELECT id, session_id, role, content FROM web_messages WHERE user_id = ?').all('alice') as any[]
    expect(messagesRows).toHaveLength(6)

    // 3.5 Verify M30 Extensions Catalog & Untrusted Plugin Quarantine
    const extPackages = platformDb.prepare('SELECT id, slug, name, status, provenance_json FROM extension_packages WHERE user_id = ?').all('alice') as any[]
    expect(extPackages.length).toBeGreaterThanOrEqual(4)

    const untrustedPkg = extPackages.find((p) => p.slug.includes('untrusted'))
    expect(untrustedPkg).toBeDefined()
    expect(untrustedPkg.status).toBe('disabled') // Invariant: Disabled status

    const untrustedBindings = platformDb.prepare(`
      SELECT b.id, b.enabled
      FROM extension_bindings b
      JOIN extension_contributions c ON b.contribution_id = c.id
      WHERE c.package_id = ?
    `).all(untrustedPkg.id) as any[]
    expect(untrustedBindings).toHaveLength(1)
    expect(untrustedBindings[0].enabled).toBe(0) // Invariant: Binding disabled / no active binding

    const trustedPkg = extPackages.find((p) => p.name.includes('git-workflow-skill'))
    expect(trustedPkg).toBeDefined()
    expect(trustedPkg.status).toBe('active')

    const uncompiledPkg = extPackages.find((p) => p.name.includes('alice-calendar-plugin'))
    expect(uncompiledPkg).toBeDefined()
    expect(uncompiledPkg.status).toBe('disabled')

    // 3.6 Verify Tasks are Paused
    const tasks = platformDb.prepare('SELECT id, title, status FROM platform_tasks WHERE user_id = ?').all('alice') as any[]
    expect(tasks).toHaveLength(2)
    const schedules = platformDb.prepare('SELECT id, task_id, enabled, paused_at FROM task_schedules WHERE user_id = ?').all('alice') as any[]
    expect(schedules).toHaveLength(2)
    for (const sched of schedules) {
      expect(sched.enabled).toBe(0) // Invariant: Paused / disabled to avoid execution
      expect(sched.paused_at).toBeDefined()
    }

    // 3.7 Verify M31 Channel Accounts and Bindings (No live transport started)
    const channelAccounts = platformDb.prepare('SELECT id, type, status, credential_ref FROM channel_accounts WHERE user_id = ?').all('alice') as any[]
    expect(channelAccounts.length).toBeGreaterThanOrEqual(2)

    const channelBindings = platformDb.prepare('SELECT id, account_id, space_id, native_context_id FROM channel_bindings WHERE user_id = ?').all('alice') as any[]
    expect(channelBindings.length).toBeGreaterThanOrEqual(3)

    // Channel inbox & outbox must be completely empty (no live cutover/transports)
    const inboxCount = (platformDb.prepare('SELECT COUNT(*) as cnt FROM channel_inbox WHERE user_id = ?').get('alice') as any).cnt
    const outboxCount = (platformDb.prepare('SELECT COUNT(*) as cnt FROM channel_outbox WHERE user_id = ?').get('alice') as any).cnt
    expect(inboxCount).toBe(0)
    expect(outboxCount).toBe(0)

    // 3.8 Verify File SHA256 integrity and Instructions Read via Runtime File API
    const aliceSpace = spaces.find((s) => s.folder === 'alice-space')
    expect(aliceSpace).toBeDefined()

    const aliceClaude = await mockFileProvider.execute('alice', aliceSpace.id, { op: 'read', path: 'CLAUDE.md' })
    expect(aliceClaude.op).toBe('read')
    expect(aliceClaude.content).toContain('Alice Space Instructions')

    const globalInstructions = await mockFileProvider.readGlobalInstructions!('alice')
    expect(globalInstructions.exists).toBe(true)
    expect(globalInstructions.content).toContain('Global HappyClaw System Instructions')

    // 3.9 Verify Idempotency of execute-pilot
    const { res: execRes2, getResult: getExecResult2 } = createMockRes()
    const execReq2 = createMockReq({
      method: 'POST',
      url: '/api/manage/migrations/happyclaw/execute-pilot',
      headers: {
        'x-enkeep-csrf-token': CSRF_TOKEN,
        'content-type': 'application/json',
        'idempotency-key': `pilot_${planId}`,
      },
      body: {
        planId,
      },
    })
    await routes.handle(execReq2, execRes2, '/api/manage/migrations/happyclaw/execute-pilot', adminUser)
    const execResult2 = getExecResult2()
    expect(execResult2.statusCode).toBe(200)
    expect(execResult2.json.data.planId).toBe(planId)

    // -------------------------------------------------------------------------
    // Phase 4: Delete Pilot Data (Cleanup)
    // -------------------------------------------------------------------------
    const { res: delRes, getResult: getDelResult } = createMockRes()
    const delReq = createMockReq({
      method: 'DELETE',
      url: `/api/manage/migrations/happyclaw/pilot/${planId}`,
      headers: {
        'x-enkeep-csrf-token': CSRF_TOKEN,
      },
    })

    const handledDel = await routes.handle(delReq, delRes, `/api/manage/migrations/happyclaw/pilot/${planId}`, adminUser)
    expect(handledDel).toBe(true)

    const delResult = getDelResult()
    expect(delResult.statusCode).toBe(200)
    expect(delResult.json.success).toBe(true)

    const delCounts = delResult.json.data.deletedCounts
    expect(delCounts.spaces).toBe(3)
    expect(delCounts.sessionRoutes).toBe(3)
    expect(delCounts.webMessages).toBe(6)
    expect(delCounts.extensions).toBeGreaterThanOrEqual(4)
    expect(delCounts.tasks).toBe(2)
    expect(delCounts.channelAccounts).toBe(3)
    expect(delCounts.channelBindings).toBe(3)

    // -------------------------------------------------------------------------
    // Phase 5: Verification of Clean State Post-Cleanup
    // -------------------------------------------------------------------------

    // 5.1 Assert zero pilot rows remain for alice
    const remainingSpaces = platformDb.prepare('SELECT COUNT(*) as cnt FROM spaces WHERE user_id = ?').get('alice') as any
    const remainingRoutes = platformDb.prepare('SELECT COUNT(*) as cnt FROM session_routes WHERE user_id = ?').get('alice') as any
    const remainingMessages = platformDb.prepare('SELECT COUNT(*) as cnt FROM web_messages WHERE user_id = ?').get('alice') as any
    const remainingExtensions = platformDb.prepare('SELECT COUNT(*) as cnt FROM extension_packages WHERE user_id = ?').get('alice') as any
    const remainingTasks = platformDb.prepare('SELECT COUNT(*) as cnt FROM platform_tasks WHERE user_id = ?').get('alice') as any
    const remainingChannels = platformDb.prepare('SELECT COUNT(*) as cnt FROM channel_accounts WHERE user_id = ?').get('alice') as any

    expect(remainingSpaces.cnt).toBe(0)
    expect(remainingRoutes.cnt).toBe(0)
    expect(remainingMessages.cnt).toBe(0)
    expect(remainingExtensions.cnt).toBe(0)
    expect(remainingTasks.cnt).toBe(0)
    expect(remainingChannels.cnt).toBe(0)

    // 5.2 Assert unrelated baseline space and user remain completely untouched
    const unrelatedSpace = platformDb.prepare('SELECT id, name, folder FROM spaces WHERE id = ?').get('space_unrelated_baseline') as any
    expect(unrelatedSpace).toBeDefined()
    expect(unrelatedSpace.name).toBe('Unrelated Space')

    const unrelatedUser = platformDb.prepare('SELECT id, username FROM users WHERE id = ?').get('unrelated_user') as any
    expect(unrelatedUser).toBeDefined()

    // 5.3 Verify Foreign Key Integrity after deletion
    const finalFkCheck = platformDb.prepare('PRAGMA foreign_key_check').all()
    expect(finalFkCheck).toEqual([])

    // 5.4 Staged package on disk remains available (stage cleanup is separate)
    expect(existsSync(stageResult.json.data.stageDir)).toBe(true)
  })
})
