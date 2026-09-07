import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  createSyntheticV2Fixture,
  inspectSourceV2,
  createMigrationPlanV2,
  executeCredentialAuthorizedTransfer,
  validateCredentialCapability,
  FakeSourceCredentialReader,
  stageMigrationPackageV2,
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
})
