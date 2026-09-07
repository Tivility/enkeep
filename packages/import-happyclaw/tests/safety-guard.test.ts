import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assertNoSymlinkEscape,
  assertNotProductionData,
  assertSafeDemoRoot,
  validateSourceFile,
} from '../src/guard.js'
import { importFixedHappyClawFixture } from '../src/index.js'

describe('Safety Guardrails and Path Confinement', () => {
  let demoRoot: string
  let outsideDir: string

  beforeEach(() => {
    demoRoot = mkdtempSync(join(tmpdir(), 'enkeep-demo-test-safety-'))
    outsideDir = mkdtempSync(join(tmpdir(), 'enkeep-outside-boundary-'))
  })

  afterEach(() => {
    if (existsSync(demoRoot)) {
      rmSync(demoRoot, { recursive: true, force: true })
    }
    if (existsSync(outsideDir)) {
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('allows arbitrary valid SQLite regular file paths and validates real regular file existence', () => {
    const validFile = join(demoRoot, 'some', 'happyclaw', 'data', 'messages.db')
    mkdirSync(join(demoRoot, 'some', 'happyclaw', 'data'), { recursive: true })
    writeFileSync(validFile, 'sqlite header')

    // validateSourceFile resolves realpath and confirms regular file
    const resolved = validateSourceFile(validFile, 'source db')
    expect(resolved).toBeDefined()
    expect(existsSync(resolved)).toBe(true)

    // Rejects non-existent files
    expect(() => validateSourceFile(join(demoRoot, 'non-existent.db'))).toThrow(/does not exist/)

    // Rejects directories passed as source files
    expect(() => validateSourceFile(demoRoot)).toThrow(/not a regular file/)
  })

  it('rejects root or user home directory as destination target', () => {
    expect(() => assertNotProductionData('/', 'test')).toThrow(/refuses root or home directory/)
    expect(() => assertNotProductionData(homedir(), 'test')).toThrow(/refuses root or home directory/)
  })

  it('enforces destination strictly inside demoRoot', () => {
    const validDest = join(demoRoot, 'staging-out')
    expect(() => assertSafeDemoRoot(validDest, demoRoot)).not.toThrow()

    // Outside path must throw
    const invalidDest = join(outsideDir, 'escaped-out')
    expect(() => assertSafeDemoRoot(invalidDest, demoRoot)).toThrow(
      /must be strictly contained inside demo root/
    )
  })

  it('detects and refuses symlink escape pointing outside allowed root', () => {
    const symlinkDir = join(demoRoot, 'symlink-test')
    mkdirSync(symlinkDir, { recursive: true })

    const secretFile = join(outsideDir, 'secret.txt')
    writeFileSync(secretFile, 'secret data')

    const linkPath = join(symlinkDir, 'escaped-link')
    symlinkSync(secretFile, linkPath)

    expect(() => assertNoSymlinkEscape(linkPath, demoRoot, 'link test')).toThrow(
      /pointing outside allowed root/
    )
  })

  it('importFixedHappyClawFixture validates deterministicCreatedAt ISO string', async () => {
    await expect(
      importFixedHappyClawFixture({
        targetDir: join(demoRoot, 'out'),
        demoRoot,
        userId: 'alice',
        deterministicCreatedAt: 'invalid-iso-date',
      })
    ).rejects.toThrow(/canonical ISO string/)
  })

  it('importFixedHappyClawFixture validates non-empty targetDir and demoRoot', async () => {
    await expect(
      importFixedHappyClawFixture({
        targetDir: '',
        demoRoot,
        userId: 'alice',
        deterministicCreatedAt: '2026-08-01T12:00:00.000Z',
      })
    ).rejects.toThrow(/targetDir must be a non-empty string/)

    await expect(
      importFixedHappyClawFixture({
        targetDir: join(demoRoot, 'out'),
        demoRoot: '',
        userId: 'alice',
        deterministicCreatedAt: '2026-08-01T12:00:00.000Z',
      })
    ).rejects.toThrow(/demoRoot must be a non-empty string/)
  })
})
