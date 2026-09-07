import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DIST_INDEX = join(__dirname, '..', 'dist', 'index.js')

describe('Built JS Distribution Smoke Test', () => {
  let demoRoot: string
  let targetDir: string

  beforeEach(() => {
    demoRoot = mkdtempSync(join(tmpdir(), 'enkeep-smoke-built-'))
    targetDir = join(demoRoot, 'output')
  })

  afterEach(() => {
    if (existsSync(demoRoot)) {
      rmSync(demoRoot, { recursive: true, force: true })
    }
  })

  it('imports and runs importFixedHappyClawFixture directly from built dist/index.js', async () => {
    expect(existsSync(DIST_INDEX)).toBe(true)

    // Dynamic import of built JS distribution
    const distExports = await import(`${DIST_INDEX}?t=${Date.now()}`)

    expect(typeof distExports.importFixedHappyClawFixture).toBe('function')
    expect(typeof distExports.sessionIdFor).toBe('function')
    expect(typeof distExports.messageIdFor).toBe('function')
    // Ensure internal functions / aliases are NOT exposed
    expect(distExports.importHappyClaw).toBeUndefined()
    expect(distExports.readSource).toBeUndefined()
    expect(distExports.copySpace).toBeUndefined()
    expect(distExports.assertNotProductionData).toBeUndefined()

    const result = await distExports.importFixedHappyClawFixture({
      targetDir,
      demoRoot,
      userId: 'alice',
      deterministicCreatedAt: '2026-08-01T12:00:00.000Z',
    })

    expect(result.chats).toHaveLength(2)
    expect(result.stats.chats).toBe(2)
    expect(result.stats.sourceMessages).toBe(52)

    // Verify built artifacts in output
    const mappingPath = join(targetDir, 'mapping.json')
    const manifestPath = join(targetDir, 'import-manifest.json')
    const reportPath = join(targetDir, 'import-report.json')

    expect(existsSync(mappingPath)).toBe(true)
    expect(existsSync(manifestPath)).toBe(true)
    expect(existsSync(reportPath)).toBe(true)

    const mapping = JSON.parse(readFileSync(mappingPath, 'utf8'))
    const aliceSid = distExports.sessionIdFor('web:alice-workspace-jid-001')
    expect(mapping['web:alice-workspace-jid-001']?.sessionId).toBe(aliceSid)

    const aliceSeedPath = join(targetDir, 'seeds', `${aliceSid}.json`)
    expect(existsSync(aliceSeedPath)).toBe(true)

    // Verify space files
    expect(existsSync(join(targetDir, 'spaces', 'alice-space', 'CLAUDE.md'))).toBe(true)
    expect(existsSync(join(targetDir, 'spaces', 'bob-space', 'CLAUDE.md'))).toBe(true)
  })
})
