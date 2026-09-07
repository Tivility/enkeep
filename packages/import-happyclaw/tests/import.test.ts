import { existsSync, readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  importFixedHappyClawFixture,
  sessionIdFor,
  type ImportResult,
} from '../src/index.js'

describe('importFixedHappyClawFixture end-to-end import', () => {
  let demoRoot: string
  let targetDir: string

  beforeEach(() => {
    demoRoot = mkdtempSync(join(tmpdir(), 'enkeep-demo-test-import-'))
    targetDir = join(demoRoot, 'output')
  })

  afterEach(() => {
    if (existsSync(demoRoot)) {
      rmSync(demoRoot, { recursive: true, force: true })
    }
  })

  it('imports all 2 chats and 52 messages successfully from fixed package fixture', async () => {
    const result: ImportResult = await importFixedHappyClawFixture({
      targetDir,
      demoRoot,
      userId: 'alice',
      deterministicCreatedAt: '2026-08-01T12:00:00.000Z',
    })

    // Fixed fixture has 2 chats, Alice (48 messages) and Bob (4 messages) = 52 total messages
    expect(result.chats).toHaveLength(2)
    expect(result.stats.chats).toBe(2)
    expect(result.stats.sourceMessages).toBe(52)
    expect(result.stats.importedPeopleTalk).toBe(50)
    expect(result.stats.droppedEmpty).toBe(2)
    expect(result.stats.attachments).toBeGreaterThan(0)

    const aliceChat = result.chats.find((c) => c.chatJid === 'web:alice-workspace-jid-001')!
    expect(aliceChat).toBeDefined()
    expect(aliceChat.report.sourceMessages).toBe(48)
    expect(aliceChat.report.importedPeopleTalk).toBe(46)
    expect(aliceChat.report.droppedEmpty).toBe(2)

    const aliceUserEvents = aliceChat.seed.filter((e) => e.type === 'user/message')
    const aliceAssistantEvents = aliceChat.seed.filter((e) => e.type === 'assistant/message')
    // Explicit round checks: >= 20 user messages & >= 20 assistant messages (pairs)
    expect(aliceUserEvents.length).toBeGreaterThanOrEqual(20)
    expect(aliceAssistantEvents.length).toBeGreaterThanOrEqual(20)

    // Verify mapping.json
    const mappingFile = join(targetDir, 'mapping.json')
    expect(existsSync(mappingFile)).toBe(true)
    const mapping = JSON.parse(readFileSync(mappingFile, 'utf8'))
    expect(mapping['web:alice-workspace-jid-001']).toEqual({
      userId: 'alice',
      folder: 'alice-space',
      sessionId: sessionIdFor('web:alice-workspace-jid-001'),
      chatJid: 'web:alice-workspace-jid-001',
      executionMode: 'default',
    })
    expect(mapping['web:bob-migration-jid-002']).toEqual({
      userId: 'alice',
      folder: 'bob-space',
      sessionId: sessionIdFor('web:bob-migration-jid-002'),
      chatJid: 'web:bob-migration-jid-002',
      executionMode: 'former-host',
    })

    // Verify seeds directory and contents
    const aliceSid = sessionIdFor('web:alice-workspace-jid-001')
    const bobSid = sessionIdFor('web:bob-migration-jid-002')
    const aliceSeedPath = join(targetDir, 'seeds', `${aliceSid}.json`)
    const bobSeedPath = join(targetDir, 'seeds', `${bobSid}.json`)

    expect(existsSync(aliceSeedPath)).toBe(true)
    expect(existsSync(bobSeedPath)).toBe(true)

    const aliceSeed = JSON.parse(readFileSync(aliceSeedPath, 'utf8'))
    expect(Array.isArray(aliceSeed)).toBe(true)
    expect(aliceSeed.length).toBeGreaterThan(30)

    // Verify spaces copied
    expect(existsSync(join(targetDir, 'spaces', 'alice-space', 'CLAUDE.md'))).toBe(true)
    expect(existsSync(join(targetDir, 'spaces', 'alice-space', 'notes', 'project-plan.md'))).toBe(true)
    expect(existsSync(join(targetDir, 'spaces', 'alice-space', 'conversations', 'topics.md'))).toBe(true)
    expect(existsSync(join(targetDir, 'spaces', 'alice-space', 'artifacts', 'summary.json'))).toBe(true)

    expect(existsSync(join(targetDir, 'spaces', 'bob-space', 'CLAUDE.md'))).toBe(true)
    expect(existsSync(join(targetDir, 'spaces', 'bob-space', 'notes', 'migration-notes.md'))).toBe(true)
    expect(existsSync(join(targetDir, 'spaces', 'bob-space', 'conversations', 'former-host-context.md'))).toBe(true)
    expect(existsSync(join(targetDir, 'spaces', 'bob-space', 'artifacts', 'legacy-report.txt'))).toBe(true)

    // Verify import-manifest.json
    const manifestFile = join(targetDir, 'import-manifest.json')
    expect(existsSync(manifestFile)).toBe(true)
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
    expect(manifest.importerVersion).toBe('0.1.0')
    expect(manifest.targetDsh).toBe('@deepseek-ai/dsh-session@0.1.1-rc.2')
    expect(manifest.sessionFormat).toBe(0)
    expect(manifest.idAlgorithm).toBe('sha256-chatJid-v1')
    expect(manifest.sourceFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/)

    // Verify import-report.json
    const reportFile = join(targetDir, 'import-report.json')
    expect(existsSync(reportFile)).toBe(true)
  })

  it('rejects request with missing or extra own enumerable keys', async () => {
    // Missing deterministicCreatedAt
    await expect(
      importFixedHappyClawFixture({
        targetDir,
        demoRoot,
        userId: 'alice',
      } as any)
    ).rejects.toThrow(/request must have exact own enumerable keys/)

    // Extra unknown property
    await expect(
      importFixedHappyClawFixture({
        targetDir,
        demoRoot,
        userId: 'alice',
        deterministicCreatedAt: '2026-08-01T12:00:00.000Z',
        extraKey: 'forbidden',
      } as any)
    ).rejects.toThrow(/request must have exact own enumerable keys/)
  })

  it('rejects userId other than "alice"', async () => {
    await expect(
      importFixedHappyClawFixture({
        targetDir,
        demoRoot,
        userId: 'bob' as any,
        deterministicCreatedAt: '2026-08-01T12:00:00.000Z',
      })
    ).rejects.toThrow(/userId must strictly be "alice"/)
  })
})
