import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {
  assertSafeCredentialsPath,
  executeMultiUserMigration,
  generateSecureTempPassword,
  hashPasswordScrypt,
  mapUserSpaces,
  planMultiUserMigration,
  runCli,
  savePrivatePasswordsFile,
  type MultiUserMigrateOptions,
} from '../src/index.js'
import { createSyntheticMultiUserFixture, type MultiUserFixture } from './fixtures/multi-user-fixture.js'

describe('Enkeep Multi-User HappyClaw Importer Extension', () => {
  let testRoot: string
  let fixture: MultiUserFixture
  let targetSpacesDir: string
  let customPasswordFile: string

  beforeEach(() => {
    testRoot = join(tmpdir(), `enkeep-mu-test-${randomUUID()}`)
    mkdirSync(testRoot, { recursive: true })
    fixture = createSyntheticMultiUserFixture(testRoot)
    targetSpacesDir = join(testRoot, 'target-spaces')
    // Safe private password file outside repo/reports
    customPasswordFile = join(homedir(), '.config', 'enkeep', 'test-runs', `passwords-${randomUUID()}.json`)
  })

  afterEach(() => {
    if (existsSync(testRoot)) {
      rmSync(testRoot, { recursive: true, force: true })
    }
    if (existsSync(customPasswordFile)) {
      rmSync(customPasswordFile, { force: true })
    }
  })

  describe('1. User Discovery & Selection', () => {
    it('selects all members except owner when --all-except owner is specified', () => {
      const plan = planMultiUserMigration({
        sourcePath: fixture.dbPath,
        sourceGroupsDir: fixture.groupsDir,
        select: { allExceptOwner: true, ownerUsername: 'owner-user' },
        dryRun: true,
      })

      expect(plan.selectedUsers).toHaveLength(3)
      expect(plan.selectedUsers).toContain('cxx')
      expect(plan.selectedUsers).toContain('whz')
      expect(plan.selectedUsers).toContain('wyg')
      expect(plan.selectedUsers).not.toContain('owner-user')
      expect(plan.summary.totalUsers).toBe(3)
    })

    it('selects a single user when --user <id> is specified', () => {
      const plan = planMultiUserMigration({
        sourcePath: fixture.dbPath,
        sourceGroupsDir: fixture.groupsDir,
        select: { users: ['cxx'] },
        dryRun: true,
      })

      expect(plan.selectedUsers).toEqual(['cxx'])
      expect(plan.userPlans).toHaveLength(1)
      expect(plan.userPlans[0]?.sourceUser.username).toBe('cxx')
    })

    it('selects multiple specific users when --user is repeated', () => {
      const plan = planMultiUserMigration({
        sourcePath: fixture.dbPath,
        sourceGroupsDir: fixture.groupsDir,
        select: { users: ['cxx', 'whz'] },
        dryRun: true,
      })

      expect(plan.selectedUsers).toHaveLength(2)
      expect(plan.selectedUsers).toContain('cxx')
      expect(plan.selectedUsers).toContain('whz')
      expect(plan.selectedUsers).not.toContain('wyg')
    })

    it('throws fail-closed error if requested user does not exist in source database', () => {
      expect(() => {
        planMultiUserMigration({
          sourcePath: fixture.dbPath,
          select: { users: ['non_existent_user'] },
          dryRun: true,
        })
      }).toThrow(/Requested user\(s\) not found in source database: non_existent_user/)
    })
  })

  describe('2. Dry-Run Planning & Sizing', () => {
    it('accurately lists planned creations, space disambiguation, and file sizes without writing', () => {
      const plan = planMultiUserMigration({
        sourcePath: fixture.dbPath,
        sourceGroupsDir: fixture.groupsDir,
        sourceMemoryDir: fixture.memoryDir,
        targetDbPath: fixture.platformDbPath,
        select: { allExceptOwner: true },
        dryRun: true,
      })

      expect(plan.dryRun).toBe(true)
      expect(plan.summary.totalUsers).toBe(3)
      expect(plan.summary.totalSpaces).toBe(11) // 7 (cxx) + 2 (whz) + 2 (wyg)
      expect(plan.summary.totalSessions).toBe(11)
      expect(plan.summary.totalMessages).toBe(7) // 4 (cxx) + 2 (whz) + 1 (wyg)
      expect(plan.summary.totalMemoryFiles).toBe(5) // CLAUDE.md files + whz 2026-08-24.md
      expect(plan.summary.totalFileBytes).toBeGreaterThan(0)
      expect(plan.summary.totalChannelAccounts).toBe(4)

      // Confirm platform.db was untouched in dry-run mode
      const pDb = new DatabaseSync(fixture.platformDbPath, { readOnly: true })
      const usersInTarget = (pDb.prepare('SELECT username FROM users').all() as any[]).map((u) => u.username)
      expect(usersInTarget).toEqual(['owner-user']) // only pre-existing owner-user, no new users written
      pDb.close()
    })
  })

  describe('3. Per-User Spaces (Container Mode) & cxx Disambiguation', () => {
    it('disambiguates cxx multiple workspaces sharing one home directory into isolated distinct folders', () => {
      const plan = planMultiUserMigration({
        sourcePath: fixture.dbPath,
        sourceGroupsDir: fixture.groupsDir,
        select: { users: ['cxx'] },
        dryRun: true,
      })

      const cxxPlan = plan.userPlans[0]!
      expect(cxxPlan.spaces).toHaveLength(7)

      // All spaces must be container execution mode
      for (const sp of cxxPlan.spaces) {
        expect(sp.executionMode).toBe('container')
      }

      // Check unique target folders (zero folder collision)
      const targetFolders = cxxPlan.spaces.map((sp) => sp.targetFolder)
      const uniqueFolders = new Set(targetFolders)
      expect(uniqueFolders.size).toBe(7)

      // Check home workspace retains base folder
      const homeSpace = cxxPlan.spaces.find((sp) => sp.isHome)
      expect(homeSpace).toBeDefined()
      expect(homeSpace?.targetFolder).toBe('home-27045ebd-2590-4511-a823-1b89aeaa0c72')

      // Check other workspaces sharing that folder received safe disambiguated folders
      const feishuDm = cxxPlan.spaces.find((sp) => sp.workspaceJid === 'feishu:oc_3700c92c4af3fc43be2561e3cbb8fb9f')
      expect(feishuDm?.targetFolder).not.toBe('home-27045ebd-2590-4511-a823-1b89aeaa0c72')
      expect(feishuDm?.targetFolder).toMatch(/^home-27045ebd.*--feishu-/)
      expect(feishuDm?.targetFolder.length).toBeLessThanOrEqual(64)

      const wechatDm = cxxPlan.spaces.find((sp) => sp.workspaceJid.startsWith('wechat:'))
      expect(wechatDm?.targetFolder).toMatch(/^home-27045ebd.*--wechat-/)
      expect(wechatDm?.targetFolder.length).toBeLessThanOrEqual(64)

      // Check independent workspaces kept their own flow folders
      const tuozhuFlow = cxxPlan.spaces.find((sp) => sp.srcFolder === 'flow-test0015-7637')
      expect(tuozhuFlow?.targetFolder).toBe('flow-test0015-7637')
    })
  })

  describe('4. Passwords Generation & Safe 0600 Storage', () => {
    it('generates secure 24-char temporary passwords and scrypt hash, enforcing must_change_password = 1', async () => {
      const pwd = generateSecureTempPassword()
      expect(pwd.length).toBeGreaterThanOrEqual(24)

      const hash = await hashPasswordScrypt(pwd)
      expect(hash).toMatch(/^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/)
    })

    it('stores passwords in a private 0600 file outside repo/reports and rejects unsafe paths', () => {
      // Rejects inside repo root
      expect(() => {
        assertSafeCredentialsPath(join(process.cwd(), 'passwords.json'))
      }).toThrow(/Security violation/)

      // Rejects inside reports
      expect(() => {
        assertSafeCredentialsPath('/tmp/reports/passwords.json')
      }).toThrow(/Security violation.*reports/)

      // Saves to safe private path with 0600 permissions
      const savedPath = savePrivatePasswordsFile(
        {
          cxx: {
            userId: 'cxx_uid',
            username: 'cxx',
            tempPassword: 'sample_secure_pwd_123456',
            passwordHash: 'scrypt$16384$8$1$salt$hash',
            generatedAt: new Date().toISOString(),
          },
        },
        customPasswordFile
      )

      expect(savedPath).toBe(customPasswordFile)
      expect(existsSync(customPasswordFile)).toBe(true)

      const stat = statSync(customPasswordFile)
      // Check mode 0600 permissions: not world/group readable
      expect(stat.mode & 0o077).toBe(0)

      const content = JSON.parse(readFileSync(customPasswordFile, 'utf8'))
      expect(content.mustChangePasswordForced).toBe(true)
      expect(content.users.cxx).toBeDefined()
    })
  })

  describe('5. Live Execution, File Copying & Secret Exclusion', () => {
    it('executes live migration into target platform DB, copying files excluding secrets (.env, node_modules)', async () => {
      const result = await executeMultiUserMigration({
        sourcePath: fixture.dbPath,
        sourceGroupsDir: fixture.groupsDir,
        sourceMemoryDir: fixture.memoryDir,
        targetDbPath: fixture.platformDbPath,
        targetSpacesDir,
        select: { allExceptOwner: true },
        dryRun: false,
        passwordFile: customPasswordFile,
      })

      expect(result.success).toBe(true)
      expect(result.dryRun).toBe(false)
      expect(result.passwordsFile).toBeDefined()
      expect(existsSync(result.passwordsFile!)).toBe(true)

      // Verify users in target database
      const pDb = new DatabaseSync(fixture.platformDbPath, { readOnly: true })
      const users = (pDb.prepare('SELECT id, username, role, must_change_password FROM users').all() as any[])
      expect(users).toHaveLength(4) // 1 owner + 3 new members

      const cxx = users.find((u) => u.username === 'cxx')
      expect(cxx).toBeDefined()
      expect(cxx.role).toBe('user')
      expect(cxx.must_change_password).toBe(1) // FORCED 1

      // Verify owner owner-user was preserved with must_change_password = 0
      const tiv = users.find((u) => u.username === 'owner-user')
      expect(tiv.must_change_password).toBe(0)

      // Verify spaces in target database
      const spaces = (pDb.prepare('SELECT id, user_id, folder, execution_mode FROM spaces').all() as any[])
      expect(spaces).toHaveLength(11)
      for (const sp of spaces) {
        expect(sp.execution_mode).toBe('container')
      }

      // Verify web messages and events
      const messages = (pDb.prepare('SELECT id, user_id, role, content FROM web_messages').all() as any[])
      expect(messages.length).toBe(7)

      // Verify fixed_import_provenance
      const provs = (pDb.prepare('SELECT id, user_id, source_message_id, target_space_id FROM fixed_import_provenance').all() as any[])
      expect(provs.length).toBe(7)

      // Verify fixed_import_receipts
      const receipts = (pDb.prepare('SELECT user_id, source_fingerprint, importer_version FROM fixed_import_receipts').all() as any[])
      expect(receipts).toHaveLength(3) // 1 for each new user

      // Verify channel accounts: status DISABLED
      const channels = (pDb.prepare('SELECT id, user_id, type, status, credential_ref FROM channel_accounts').all() as any[])
      expect(channels).toHaveLength(4)
      for (const ch of channels) {
        expect(ch.status).toBe('disabled') // All DISABLED as required
      }

      // Verify copied files on disk
      const cxxDiskDir = join(targetSpacesDir, 'home-27045ebd-2590-4511-a823-1b89aeaa0c72')
      expect(existsSync(join(cxxDiskDir, 'CLAUDE.md'))).toBe(true)
      expect(existsSync(join(cxxDiskDir, 'notes.md'))).toBe(true)

      // CRITICAL: Verify secret files were NOT copied!
      expect(existsSync(join(cxxDiskDir, '.env'))).toBe(false)
      expect(existsSync(join(cxxDiskDir, '.env.production'))).toBe(false)
      expect(existsSync(join(cxxDiskDir, 'node_modules'))).toBe(false)

      // Verify memory file for whz
      const whzMemOnDisk = join(targetSpacesDir, 'home-f1959674-c0f3-44a3-ad89-d3e774d336d4', 'memory', '2026-08-24.md')
      expect(existsSync(whzMemOnDisk)).toBe(true)

      pDb.close()
    })
  })

  describe('6. Idempotency & Re-run Safety', () => {
    it('is completely idempotent on re-run with zero duplicate records and zero effect on existing users', async () => {
      // First run
      await executeMultiUserMigration({
        sourcePath: fixture.dbPath,
        sourceGroupsDir: fixture.groupsDir,
        sourceMemoryDir: fixture.memoryDir,
        targetDbPath: fixture.platformDbPath,
        targetSpacesDir,
        select: { allExceptOwner: true },
        passwordFile: customPasswordFile,
      })

      // Second run (re-run)
      const rerunResult = await executeMultiUserMigration({
        sourcePath: fixture.dbPath,
        sourceGroupsDir: fixture.groupsDir,
        sourceMemoryDir: fixture.memoryDir,
        targetDbPath: fixture.platformDbPath,
        targetSpacesDir,
        select: { allExceptOwner: true },
        passwordFile: customPasswordFile,
      })

      expect(rerunResult.success).toBe(true)

      const pDb = new DatabaseSync(fixture.platformDbPath, { readOnly: true })

      // Verify exact counts (no duplication!)
      const users = (pDb.prepare('SELECT id FROM users').all() as any[])
      expect(users).toHaveLength(4)

      const spaces = (pDb.prepare('SELECT id FROM spaces').all() as any[])
      expect(spaces).toHaveLength(11)

      const messages = (pDb.prepare('SELECT id FROM web_messages').all() as any[])
      expect(messages).toHaveLength(7)

      const provs = (pDb.prepare('SELECT id FROM fixed_import_provenance').all() as any[])
      expect(provs).toHaveLength(7)

      const receipts = (pDb.prepare('SELECT user_id FROM fixed_import_receipts').all() as any[])
      expect(receipts).toHaveLength(3)

      // Verify owner-user admin password was never altered
      const tiv = pDb.prepare("SELECT password_hash FROM users WHERE username = 'owner-user'").get() as any
      expect(tiv.password_hash).toBe('scrypt$16384$8$1$existing_salt$existing_hash')

      pDb.close()
    })
  })

  describe('7. CLI Execution', () => {
    it('runs CLI migrate command with --all-except owner and --dry-run returning exit code 0', async () => {
      const exitCode = await runCli([
        'node',
        'enkeep-import-happyclaw',
        'migrate',
        '--source',
        fixture.dbPath,
        '--groups-dir',
        fixture.groupsDir,
        '--all-except',
        'owner',
        '--dry-run',
      ])

      expect(exitCode).toBe(0)
    })

    it('runs CLI migrate command with repeatable --user and --json returning exit code 0', async () => {
      const exitCode = await runCli([
        'node',
        'enkeep-import-happyclaw',
        'migrate',
        '--source',
        fixture.dbPath,
        '--groups-dir',
        fixture.groupsDir,
        '--user',
        'cxx',
        '--user',
        'whz',
        '--dry-run',
        '--json',
      ])

      expect(exitCode).toBe(0)
    })
  })
})
