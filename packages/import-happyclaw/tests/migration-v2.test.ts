import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {
  createSyntheticV2Fixture,
  inspectSourceV2,
  createMigrationPlanV2,
  executeCredentialAuthorizedTransfer,
  validateCredentialCapability,
  FakeSourceCredentialReader,
  stageMigrationPackageV2,
  executePilotMigrationV2,
  EphemeralCredentialVaultEncryptor,
  type SourceCredentialCapability,
} from '../src/index.js'

describe('Migration V2 Plan Engine & Credential Authorized Transfer', () => {
  let testRoot: string
  let dbPath: string
  let groupsDir: string
  let fakeCredentials: any[]

  beforeEach(() => {
    testRoot = join(tmpdir(), `enkeep-v2-test-${randomUUID()}`)
    mkdirSync(testRoot, { recursive: true })
    const fixture = createSyntheticV2Fixture(testRoot)
    dbPath = fixture.dbPath
    groupsDir = fixture.groupsDir
    fakeCredentials = [...fixture.fakeCredentials]
  })

  afterEach(() => {
    if (existsSync(testRoot)) {
      rmSync(testRoot, { recursive: true, force: true })
    }
  })

  it('1. inspectSourceV2 correctly identifies 3 representative workspaces and metadata', () => {
    const inspectRes = inspectSourceV2(dbPath, groupsDir)

    expect(inspectRes.totalWorkspaces).toBe(3)
    expect(inspectRes.workspaces).toHaveLength(3)
    expect(inspectRes.sourceFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(inspectRes.diagnostic.ok).toBe(true)

    const alice = inspectRes.workspaces.find((w) => w.workspaceId === 'web:alice-space')
    expect(alice).toBeDefined()
    expect(alice?.folder).toBe('alice-space')
    expect(alice?.hasMemoryOrClaudeFile).toBe(true)
    expect(alice?.skillsCount).toBe(1)
    expect(alice?.tasksCount).toBe(1)

    const bob = inspectRes.workspaces.find((w) => w.workspaceId === 'feishu:bob-space')
    expect(bob).toBeDefined()
    expect(bob?.pluginsCount).toBe(1)
    expect(bob?.mcpCount).toBe(1)
  })

  it('2. createMigrationPlanV2 generates deterministic planId and maps Alice, Bob, Charlie accurately', () => {
    const plan = createMigrationPlanV2({
      sourcePath: dbPath,
      sourceGroupsDir: groupsDir,
      targetUserId: 'alice',
      selectedWorkspaceIds: ['web:alice-space', 'feishu:bob-space', 'web:charlie-space'],
      scopes: {
        coreData: true,
        extensions: true,
        tasks: true,
        channelsMetadata: true,
        credentials: false,
      },
    })

    expect(plan.version).toBe(2)
    expect(plan.planId).toMatch(/^plan_v2_[a-f0-9]{24}$/)
    expect(plan.summary.totalWorkspaces).toBe(3)
    expect(plan.summary.totalSessions).toBe(3)
    expect(plan.summary.totalMessages).toBe(6)

    // Verify determinism of planId
    const plan2 = createMigrationPlanV2({
      sourcePath: dbPath,
      sourceGroupsDir: groupsDir,
      targetUserId: 'alice',
      selectedWorkspaceIds: ['web:alice-space', 'feishu:bob-space', 'web:charlie-space'],
    })
    expect(plan2.planId).toBe(plan.planId)

    // Check Alice Space mapping
    const aliceItem = plan.items.find((i) => i.workspaceId === 'web:alice-space')
    expect(aliceItem).toBeDefined()
    expect(aliceItem?.userSnapshots.length).toBeGreaterThanOrEqual(1)
    expect(aliceItem?.agentProfileSnapshots.length).toBe(1)
    expect(aliceItem?.instructionPlan?.instructionType).toBe('claude_md')
    expect(aliceItem?.extensionPlans.some((e) => e.kind === 'skill' && e.name === 'git-workflow-skill')).toBe(true)
    expect(aliceItem?.taskPlans.some((t) => t.title === 'Daily Workspace Sync')).toBe(true)
    expect(aliceItem?.channelBindingsPlans.some((b) => b.channelType === 'lark' && b.cutoverDeferred === true)).toBe(true)

    // Check Bob Space mapping and Untrusted Plugin Quarantine
    const bobItem = plan.items.find((i) => i.workspaceId === 'feishu:bob-space')
    expect(bobItem).toBeDefined()
    const quarantinedPlugin = bobItem?.extensionPlans.find((e) => e.name === 'untrusted-remote-exec-plugin')
    expect(quarantinedPlugin).toBeDefined()
    expect(quarantinedPlugin?.quarantined).toBe(true)
    expect(quarantinedPlugin?.status).toBe('disabled')
    expect(quarantinedPlugin?.quarantineReason).toContain('quarantined during migration')
    expect(bobItem?.warnings.some((w) => w.includes('quarantined'))).toBe(true)
    expect(plan.summary.totalQuarantinedPlugins).toBeGreaterThanOrEqual(1)

    // Check Charlie Space mapping (Quotas & Model Preferences)
    const charlieItem = plan.items.find((i) => i.workspaceId === 'web:charlie-space')
    expect(charlieItem).toBeDefined()
    expect(charlieItem?.quotaPlans.some((q) => q.resource === 'tokens' && q.limit === 100000)).toBe(true)
    expect(charlieItem?.modelPrefPlans.some((m) => m.model === 'claude-3-7-sonnet')).toBe(true)
  })

  it('3. Credential Authorized Transfer validates capability, encrypts secrets, and flags reauth required', async () => {
    const reader = new FakeSourceCredentialReader(fakeCredentials)
    const usedTokens = new Set<string>()

    const capability: SourceCredentialCapability = {
      capabilityToken: 'cap_tok_synthetic_valid_123',
      sourceProviderRef: 'happyclaw-hpc-provider-ref-01',
      authorizedCredentialIds: ['cred_alice_lark', 'cred_bob_wechat', 'cred_charlie_lark'],
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      singleUse: true,
      issuedBy: 'admin@enkeep.local',
    }

    const transferResult = await executeCredentialAuthorizedTransfer(
      {
        capability,
        targetUserId: 'alice',
      },
      reader,
      usedTokens
    )

    expect(transferResult.success).toBe(true)
    expect(transferResult.transferredCount).toBe(2) // Alice Lark and Bob WeChat
    expect(transferResult.reauthRequiredCount).toBe(1) // Charlie Lark
    expect(transferResult.failedCount).toBe(0)
    expect(transferResult.credentials).toHaveLength(3)

    // Invariant check: ZERO plaintext secrets in results
    const jsonStr = JSON.stringify(transferResult)
    expect(jsonStr).not.toContain('sec_synthetic_alice_secret_xyz')
    expect(jsonStr).not.toContain('wx_synthetic_bob_token_456')
    expect(jsonStr).not.toContain('sec_synthetic_charlie_invalid')

    // Alice Lark should be transferred with targetRefId
    const aliceCred = transferResult.credentials.find((c) => c.credentialId === 'cred_alice_lark')
    expect(aliceCred?.status).toBe('transferred')
    expect(aliceCred?.targetRefId).toMatch(/^cred_ref_[a-f0-9]{16}$/)

    // Charlie Lark should be reauthorization_required
    const charlieCred = transferResult.credentials.find((c) => c.credentialId === 'cred_charlie_lark')
    expect(charlieCred?.status).toBe('reauthorization_required')

    // Capability single-use enforcement: re-using same capabilityToken must be rejected
    const reuseResult = await executeCredentialAuthorizedTransfer(
      {
        capability,
      },
      reader,
      usedTokens
    )
    expect(reuseResult.success).toBe(false)
    expect(reuseResult.warnings[0]).toContain('already been consumed')
  })

  it('4. Rejects expired or malformed credential capability', async () => {
    const reader = new FakeSourceCredentialReader(fakeCredentials)

    const expiredCapability: SourceCredentialCapability = {
      capabilityToken: 'cap_tok_expired',
      sourceProviderRef: 'hpc-provider',
      authorizedCredentialIds: ['cred_alice_lark'],
      expiresAt: new Date(Date.now() - 10000).toISOString(),
      singleUse: true,
      issuedBy: 'admin',
    }

    const result = await executeCredentialAuthorizedTransfer(
      {
        capability: expiredCapability,
      },
      reader
    )

    expect(result.success).toBe(false)
    expect(result.warnings[0]).toContain('expired')
  })

  it('5. stageMigrationPackageV2 creates signed package JSON and stage manifest without mutating DB', () => {
    const plan = createMigrationPlanV2({
      sourcePath: dbPath,
      sourceGroupsDir: groupsDir,
      targetUserId: 'alice',
      selectedWorkspaceIds: ['web:alice-space', 'feishu:bob-space'],
    })

    const stagingDir = join(testRoot, 'staged-output')
    const stageResult = stageMigrationPackageV2(
      {
        sourcePath: dbPath,
        selectedWorkspaceIds: ['web:alice-space', 'feishu:bob-space'],
      },
      plan,
      stagingDir
    )

    expect(stageResult.success).toBe(true)
    expect(stageResult.staged).toBe(true)
    expect(existsSync(stageResult.stageDir)).toBe(true)

    const planPath = join(stageResult.stageDir, 'migration-plan-v2.json')
    const manifestPath = join(stageResult.stageDir, 'stage-manifest.json')

    expect(existsSync(planPath)).toBe(true)
    expect(existsSync(manifestPath)).toBe(true)

    const manifestContent = JSON.parse(readFileSync(manifestPath, 'utf8'))
    expect(manifestContent.planId).toBe(plan.planId)
    expect(manifestContent.packageChecksum).toBe(stageResult.packageChecksum)
    expect(manifestContent.summary.totalWorkspaces).toBe(2)
  })

  it('6. executePilotMigrationV2 sets schedule_type and cron_expression in platform_tasks from HC schedule', async () => {
    const plan = createMigrationPlanV2({
      sourcePath: dbPath,
      sourceGroupsDir: groupsDir,
      targetUserId: 'alice',
      selectedWorkspaceIds: ['web:alice-space'],
    })

    const stagingDir = join(testRoot, 'staged-pilot')
    stageMigrationPackageV2(
      {
        sourcePath: dbPath,
        selectedWorkspaceIds: ['web:alice-space'],
      },
      plan,
      stagingDir
    )

    const targetDb = new DatabaseSync(':memory:')
    // Setup target tables needed by pilot-v2
    targetDb.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, role TEXT, password_hash TEXT, must_change_password INTEGER, created_at TEXT, updated_at TEXT);
      CREATE TABLE spaces (id TEXT PRIMARY KEY, user_id TEXT, folder TEXT, name TEXT, execution_mode TEXT, status TEXT, created_at TEXT, updated_at TEXT, UNIQUE(user_id, folder));
      CREATE TABLE session_routes (id TEXT PRIMARY KEY, space_id TEXT, user_id TEXT, channel TEXT, account_id TEXT, native_context_id TEXT, peer_id TEXT, dsh_session_id TEXT, execution_mode TEXT, status TEXT, title TEXT, created_at TEXT, updated_at TEXT, UNIQUE(user_id, channel, native_context_id));
      CREATE TABLE session_generations (id TEXT PRIMARY KEY, user_id TEXT, route_id TEXT, generation_number INTEGER, dsh_session_id TEXT, agent_profile_snapshot_id TEXT, reset_reason TEXT, created_at TEXT, UNIQUE(route_id, generation_number));
      CREATE TABLE session_sources (id TEXT PRIMARY KEY, route_id TEXT, source_type TEXT, source_id TEXT, user_id TEXT, metadata TEXT, created_at TEXT);
      CREATE TABLE web_messages (id TEXT PRIMARY KEY, session_id TEXT, user_id TEXT, role TEXT, content TEXT, status TEXT, route_key TEXT, metadata TEXT, created_at TEXT);
      CREATE TABLE web_events (id TEXT PRIMARY KEY, session_id TEXT, user_id TEXT, type TEXT, payload TEXT, created_at TEXT);
      CREATE TABLE import_jobs (id TEXT PRIMARY KEY, actor_user_id TEXT, target_user_id TEXT, staged_id TEXT, source_fingerprint TEXT, request_hash TEXT, idempotency_key TEXT, status TEXT, dry_run INTEGER, total_conversations INTEGER, completed_conversations INTEGER, progress_json TEXT, result_json TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE fixed_import_receipts (user_id TEXT, source_fingerprint TEXT, importer_version TEXT, id_algorithm TEXT, target_dsh TEXT, session_format INTEGER, source_chats_count INTEGER, source_messages_count INTEGER, imported_messages_count INTEGER, dropped_messages_count INTEGER, attachments_count INTEGER, canonical_hash TEXT, created_at TEXT, PRIMARY KEY (user_id, source_fingerprint));
      CREATE TABLE fixed_import_provenance (id TEXT PRIMARY KEY, user_id TEXT, source_fingerprint TEXT, source_chat_jid TEXT, source_message_id TEXT, target_space_id TEXT, target_route_id TEXT, target_dsh_session_id TEXT, target_message_id TEXT, target_event_id TEXT, created_at TEXT);
      CREATE TABLE agent_profiles (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, description TEXT, status TEXT, active_version TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE agent_profile_snapshots (id TEXT PRIMARY KEY, user_id TEXT, profile_id TEXT, version TEXT, prompt_mode TEXT, prompt_hash TEXT, identity TEXT, soul TEXT, agents TEXT, tools TEXT, created_at TEXT);
      CREATE TABLE extension_packages (id TEXT PRIMARY KEY, user_id TEXT, slug TEXT, name TEXT, description TEXT, source_kind TEXT, source_ref TEXT, installed_version INTEGER, active_version INTEGER, status TEXT, integrity_sha256 TEXT, provenance_json TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE extension_contributions (id TEXT PRIMARY KEY, package_id TEXT, kind TEXT, contribution_key TEXT, manifest_json TEXT, status TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE extension_bindings (id TEXT PRIMARY KEY, user_id TEXT, space_id TEXT, contribution_id TEXT, enabled INTEGER, created_at TEXT, updated_at TEXT, UNIQUE(space_id, contribution_id));
      CREATE TABLE platform_tasks (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        idempotency_key TEXT,
        title TEXT,
        description TEXT,
        priority TEXT,
        status TEXT,
        payload TEXT,
        schedule_type TEXT NOT NULL DEFAULT 'once',
        cron_expression TEXT,
        created_at TEXT,
        updated_at TEXT
      );
      CREATE TABLE task_schedules (
        id TEXT PRIMARY KEY,
        task_id TEXT UNIQUE,
        user_id TEXT,
        schedule_type TEXT,
        cron_expression TEXT,
        enabled INTEGER,
        paused_at TEXT,
        created_at TEXT,
        updated_at TEXT
      );
      CREATE TABLE channel_accounts (id TEXT PRIMARY KEY, user_id TEXT, type TEXT, status TEXT, credential_ref TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE channel_bindings (id TEXT PRIMARY KEY, user_id TEXT, account_id TEXT, space_id TEXT, native_context_id TEXT, activation_mode TEXT, created_at TEXT, updated_at TEXT, UNIQUE(account_id, native_context_id));
      INSERT INTO users (id, username, role) VALUES ('usr_alice', 'alice', 'admin');
    `)

    const pilotResult = await executePilotMigrationV2({
      stagingDir,
      planId: plan.planId,
      db: targetDb,
      targetUserId: 'usr_alice',
    })

    expect(pilotResult.success).toBe(true)

    const taskRow = targetDb.prepare('SELECT * FROM platform_tasks WHERE title = ?').get('Daily Workspace Sync') as any
    expect(taskRow).toBeDefined()
    expect(taskRow.schedule_type).toBe('cron')
    expect(taskRow.cron_expression).toBe('0 9 * * *')

    const schedRow = targetDb.prepare('SELECT * FROM task_schedules WHERE task_id = ?').get(taskRow.id) as any
    expect(schedRow).toBeDefined()
    expect(schedRow.schedule_type).toBe('cron')
    expect(schedRow.cron_expression).toBe('0 9 * * *')

    targetDb.close()
  })
})
