import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { importFixedHappyClawFixture } from '../src/index.js'

function hashDirectoryTree(dir: string): string {
  const hash = createHash('sha256')

  function walk(current: string): void {
    const entries = readdirSync(current).sort()
    for (const entry of entries) {
      const fullPath = join(current, entry)
      const stat = statSync(fullPath)
      if (stat.isDirectory()) {
        hash.update(`dir:${entry}:`)
        walk(fullPath)
      } else if (stat.isFile()) {
        hash.update(`file:${entry}:`)
        hash.update(readFileSync(fullPath))
      }
    }
  }

  walk(dir)
  return hash.digest('hex')
}

describe('Idempotency and Safe Staging Semantics', () => {
  let demoRoot: string
  let targetDir1: string
  let targetDir2: string

  beforeEach(() => {
    demoRoot = mkdtempSync(join(tmpdir(), 'enkeep-demo-test-idempotency-'))
    targetDir1 = join(demoRoot, 'output1')
    targetDir2 = join(demoRoot, 'output2')
  })

  afterEach(() => {
    if (existsSync(demoRoot)) {
      rmSync(demoRoot, { recursive: true, force: true })
    }
  })

  it('produces 100% byte-identical directories across independent runs', async () => {
    const fixedDate = '2026-08-01T12:00:00.000Z'

    await importFixedHappyClawFixture({
      targetDir: targetDir1,
      userId: 'alice',
      demoRoot,
      deterministicCreatedAt: fixedDate,
    })

    await importFixedHappyClawFixture({
      targetDir: targetDir2,
      userId: 'alice',
      demoRoot,
      deterministicCreatedAt: fixedDate,
    })

    const hash1 = hashDirectoryTree(targetDir1)
    const hash2 = hashDirectoryTree(targetDir2)

    expect(hash1).toBe(hash2)
  })

  it('is a safe no-op when re-importing into an identical existing destination', async () => {
    const fixedDate = '2026-08-01T12:00:00.000Z'

    // First run
    const res1 = await importFixedHappyClawFixture({
      targetDir: targetDir1,
      userId: 'alice',
      demoRoot,
      deterministicCreatedAt: fixedDate,
    })
    const initialHash = hashDirectoryTree(targetDir1)

    // Second run with same parameters into existing identical destination
    const res2 = await importFixedHappyClawFixture({
      targetDir: targetDir1,
      userId: 'alice',
      demoRoot,
      deterministicCreatedAt: fixedDate,
    })

    const secondHash = hashDirectoryTree(targetDir1)
    expect(secondHash).toBe(initialHash)
    expect(res2.chats).toHaveLength(res1.chats.length)
  })

  it('refuses to overwrite when existing destination has mismatched contents and never removes it', async () => {
    const fixedDate = '2026-08-01T12:00:00.000Z'

    // First run
    await importFixedHappyClawFixture({
      targetDir: targetDir1,
      userId: 'alice',
      demoRoot,
      deterministicCreatedAt: fixedDate,
    })

    // Modify a file to create a mismatch
    const strayFilePath = join(targetDir1, 'stray-file.tmp')
    writeFileSync(strayFilePath, 'should prevent destructive overwrite', 'utf8')

    // Second run must reject because destination exists and mismatches
    await expect(
      importFixedHappyClawFixture({
        targetDir: targetDir1,
        userId: 'alice',
        demoRoot,
        deterministicCreatedAt: fixedDate,
      })
    ).rejects.toThrow(/already exists and contents mismatch.*Refusing to overwrite/)

    // Existing file must still be present and not deleted
    expect(existsSync(strayFilePath)).toBe(true)
    expect(readFileSync(strayFilePath, 'utf8')).toBe('should prevent destructive overwrite')
  })
})
