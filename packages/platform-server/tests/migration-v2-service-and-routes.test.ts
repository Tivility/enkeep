import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
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

describe('Migration V2 Service & REST Endpoints (/api/manage/migrations/happyclaw[-v2])', () => {
  let testRoot: string
  let platformDb: DatabaseSync
  let stagingDir: string
  let service: HappyClawMigrationService
  let routes: HappyClawMigrationRoutes
  let fixtureDbPath: string
  let fixtureGroupsDir: string
  const CSRF_TOKEN = 'a'.repeat(64)

  const adminUser: User = {
    id: 'usr_admin',
    username: 'admin',
    role: 'admin',
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  const normalUser: User = {
    id: 'usr_normal',
    username: 'bob',
    role: 'user',
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  beforeEach(async () => {
    testRoot = join(tmpdir(), `enkeep-p1-7-test-${randomUUID()}`)
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

    // Provision admin and user in platform database
    platformDb.exec(`
      INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at) VALUES
        ('usr_admin', 'admin', 'scrypt$dummyhashadmin', 'admin', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('usr_normal', 'bob', 'scrypt$dummyhashbob', 'user', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('alice', 'alice', 'scrypt$dummyhashalice', 'admin', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    `)

    service = new HappyClawMigrationService({
      db: platformDb,
      stagedImportsDir: stagingDir,
      allowlistedImportRoots: [testRoot],
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
  })

  it('1. POST /api/manage/migrations/happyclaw/inspect returns V2 workspace inspection summary', async () => {
    const { res, getResult } = createMockRes()
    const req = createMockReq({
      method: 'POST',
      url: '/api/manage/migrations/happyclaw/inspect',
      headers: {
        'x-enkeep-csrf-token': CSRF_TOKEN,
        'content-type': 'application/json',
      },
      body: {
        sourcePath: fixtureDbPath,
        groupsDir: fixtureGroupsDir,
      },
    })

    const handled = await routes.handle(req, res, '/api/manage/migrations/happyclaw/inspect', adminUser)
    expect(handled).toBe(true)

    const result = getResult()
    expect(result.statusCode).toBe(200)
    expect(result.json.success).toBe(true)
    expect(result.json.data.totalWorkspaces).toBe(3)
    expect(result.json.data.workspaces).toHaveLength(3)
    expect(result.json.data.workspaces.some((w: any) => w.workspaceId === 'web:alice-space')).toBe(true)
    expect(result.json.data.workspaces.some((w: any) => w.workspaceId === 'feishu:bob-space')).toBe(true)
  })

  it('2. POST /api/manage/migrations/happyclaw/dry-run calculates deterministic plan and untrusted plugin quarantine', async () => {
    const { res, getResult } = createMockRes()
    const req = createMockReq({
      method: 'POST',
      url: '/api/manage/migrations/happyclaw/dry-run',
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

    const handled = await routes.handle(req, res, '/api/manage/migrations/happyclaw/dry-run', adminUser)
    expect(handled).toBe(true)

    const result = getResult()
    expect(result.statusCode).toBe(200)
    expect(result.json.success).toBe(true)
    expect(result.json.data.dryRun).toBe(true)

    const plan = result.json.data.plan
    expect(plan.version).toBe(2)
    expect(plan.planId).toMatch(/^plan_v2_[a-f0-9]{24}$/)
    expect(plan.summary.totalWorkspaces).toBe(3)
    expect(plan.summary.totalQuarantinedPlugins).toBeGreaterThanOrEqual(1)

    const bobItem = plan.items.find((i: any) => i.workspaceId === 'feishu:bob-space')
    expect(bobItem).toBeDefined()
    const quarantinedPlugin = bobItem.extensionPlans.find((e: any) => e.name === 'untrusted-remote-exec-plugin')
    expect(quarantinedPlugin.quarantined).toBe(true)
    expect(quarantinedPlugin.status).toBe('disabled')
  })

  it('3. POST /api/manage/migrations/happyclaw/authorize-credentials executes credential transfer without secret exposure', async () => {
    const capability: SourceCredentialCapability = {
      capabilityToken: 'cap_test_token_123',
      sourceProviderRef: 'hpc-auth-provider-v1',
      authorizedCredentialIds: ['cred_alice_lark', 'cred_bob_wechat'],
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      singleUse: true,
      issuedBy: 'admin',
    }

    const { res, getResult } = createMockRes()
    const req = createMockReq({
      method: 'POST',
      url: '/api/manage/migrations/happyclaw/authorize-credentials',
      headers: {
        'x-enkeep-csrf-token': CSRF_TOKEN,
        'content-type': 'application/json',
      },
      body: {
        capability,
        sourcePath: fixtureDbPath,
        targetUserId: 'alice',
      },
    })

    const handled = await routes.handle(req, res, '/api/manage/migrations/happyclaw/authorize-credentials', adminUser)
    expect(handled).toBe(true)

    const result = getResult()
    expect(result.statusCode).toBe(200)
    expect(result.json.success).toBe(true)

    const data = result.json.data
    expect(data.sourceProviderRef).toBe('hpc-auth-provider-v1')
    expect(data.transferredAt).toBeDefined()

    // Ensure zero secrets in response
    const rawResStr = JSON.stringify(result.json)
    expect(rawResStr).not.toContain('secret')
    expect(rawResStr).not.toContain('token')
    expect(rawResStr).not.toContain('appSecret')
  })

  it('4. POST /api/manage/migrations/happyclaw/stage creates immutable staged plan package', async () => {
    const { res, getResult } = createMockRes()
    const req = createMockReq({
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
        selectedWorkspaceIds: ['web:alice-space'],
        scopes: { coreData: true, extensions: true, tasks: true, channelsMetadata: true, credentials: false },
      },
    })

    const handled = await routes.handle(req, res, '/api/manage/migrations/happyclaw/stage', adminUser)
    expect(handled).toBe(true)

    const result = getResult()
    expect(result.statusCode).toBe(200)
    expect(result.json.success).toBe(true)
    expect(result.json.data.staged).toBe(true)
    expect(result.json.data.packageChecksum).toMatch(/^[a-f0-9]{64}$/)
    expect(existsSync(result.json.data.stageDir)).toBe(true)
  })

  it('5. Non-admin user is rejected with 403 Forbidden across all V2 endpoints', async () => {
    const endpoints = [
      '/api/manage/migrations/happyclaw/inspect',
      '/api/manage/migrations/happyclaw/dry-run',
      '/api/manage/migrations/happyclaw/authorize-credentials',
      '/api/manage/migrations/happyclaw/stage',
      '/api/manage/migrations/happyclaw/execute-pilot',
    ]

    for (const ep of endpoints) {
      const { res } = createMockRes()
      const req = createMockReq({
        method: 'POST',
        url: ep,
        headers: {
          'x-enkeep-csrf-token': CSRF_TOKEN,
          'content-type': 'application/json',
        },
        body: {
          sourcePath: fixtureDbPath,
          planId: 'plan_v2_dummy',
          selectedWorkspaceIds: ['web:alice-space'],
          capability: { capabilityToken: 'c1', expiresAt: '2099-01-01', authorizedCredentialIds: ['c1'] },
        },
      })

      await expect(routes.handle(req, res, ep, normalUser)).rejects.toThrow(/Administrative access required/)
    }

    // Also verify DELETE /api/manage/migrations/happyclaw/pilot/:planId requires admin
    const { res: delRes } = createMockRes()
    const delReq = createMockReq({
      method: 'DELETE',
      url: '/api/manage/migrations/happyclaw/pilot/plan_v2_dummy',
      headers: {
        'x-enkeep-csrf-token': CSRF_TOKEN,
      },
    })
    await expect(routes.handle(delReq, delRes, '/api/manage/migrations/happyclaw/pilot/plan_v2_dummy', normalUser)).rejects.toThrow(/Administrative access required/)
  })

  it('6. Supports both /api/manage/migrations/happyclaw and /api/manage/migrations/happyclaw-v2 route prefixes', async () => {
    const { res, getResult } = createMockRes()
    const req = createMockReq({
      method: 'POST',
      url: '/api/manage/migrations/happyclaw-v2/dry-run',
      headers: {
        'x-enkeep-csrf-token': CSRF_TOKEN,
        'content-type': 'application/json',
      },
      body: {
        sourcePath: fixtureDbPath,
        selectedWorkspaceIds: ['web:alice-space'],
      },
    })

    const handled = await routes.handle(req, res, '/api/manage/migrations/happyclaw-v2/dry-run', adminUser)
    expect(handled).toBe(true)

    const result = getResult()
    expect(result.statusCode).toBe(200)
    expect(result.json.data.plan.planId).toBeDefined()
  })
})

