import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  importFixedHappyClawFixture,
  type ImportManifest,
} from '../src/index.js'
import { computeSourceFingerprint } from '../src/manifest.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES_SOURCE = join(__dirname, '..', 'fixtures', 'source')

describe('Import Manifest and Anomaly Tracking', () => {
  let demoRoot: string
  let targetDir: string

  beforeEach(() => {
    demoRoot = mkdtempSync(join(tmpdir(), 'enkeep-demo-test-manifest-'))
    targetDir = join(demoRoot, 'output')
  })

  afterEach(() => {
    if (existsSync(demoRoot)) {
      rmSync(demoRoot, { recursive: true, force: true })
    }
  })

  it('generates a complete manifest with all required fields', async () => {
    const fixedTime = '2026-08-01T12:00:00.000Z'
    const result = await importFixedHappyClawFixture({
      targetDir,
      demoRoot,
      userId: 'alice',
      deterministicCreatedAt: fixedTime,
    })

    const manifest: ImportManifest = result.manifest
    expect(manifest.importerVersion).toBe('0.1.0')
    expect(manifest.targetDsh).toBe('@deepseek-ai/dsh-session@0.1.1-rc.2')
    expect(manifest.sessionFormat).toBe(0)
    expect(manifest.idAlgorithm).toBe('sha256-chatJid-v1')
    expect(manifest.createdAt).toBe(fixedTime)
    expect(manifest.sourceFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/)

    // Stats
    expect(manifest.stats.chats).toBe(2)
    expect(manifest.stats.sourceMessages).toBe(52)
    expect(manifest.stats.importedPeopleTalk).toBe(50)
    expect(manifest.stats.droppedEmpty).toBe(2)
    expect(manifest.stats.attachments).toBeGreaterThan(0)

    // Chat reports
    expect(manifest.chatReports).toHaveLength(2)
    const aliceReport = manifest.chatReports.find((r) => r.chatJid === 'web:alice-workspace-jid-001')
    expect(aliceReport).toBeDefined()
    expect(aliceReport?.folder).toBe('alice-space')
    expect(aliceReport?.importedPeopleTalk).toBe(46)
    expect(aliceReport?.sourceMessages).toBe(48)

    const bobReport = manifest.chatReports.find((r) => r.chatJid === 'web:bob-migration-jid-002')
    expect(bobReport).toBeDefined()
    expect(bobReport?.folder).toBe('bob-space')
    expect(bobReport?.executionMode).toBe('former-host')
    expect(bobReport?.importedPeopleTalk).toBe(4)
    expect(bobReport?.sourceMessages).toBe(4)

    // Anomalies
    expect(manifest.anomalies.length).toBeGreaterThan(0)
    const anomalyTypes = new Set(manifest.anomalies.map((a) => a.type))
    expect(anomalyTypes.has('empty_message')).toBe(true)
    expect(anomalyTypes.has('missing_timestamp')).toBe(true)
    expect(anomalyTypes.has('invalid_timestamp')).toBe(true)
    expect(anomalyTypes.has('consecutive_user_message')).toBe(true)
    expect(anomalyTypes.has('consecutive_assistant_message')).toBe(true)
    expect(anomalyTypes.has('attachment_referenced')).toBe(true)
  })

  it('computes identical source fingerprints for unchanged source files', () => {
    const dbPath = join(FIXTURES_SOURCE, 'db', 'messages.db')
    const groupsDir = join(FIXTURES_SOURCE, 'groups')

    const fp1 = computeSourceFingerprint(dbPath, groupsDir)
    const fp2 = computeSourceFingerprint(dbPath, groupsDir)

    expect(fp1).toBe(fp2)
    expect(fp1).toMatch(/^sha256:[a-f0-9]{64}$/)
  })
})
