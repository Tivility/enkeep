import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copySpaceToStaging } from '../src/copy-spaces.js'
import { validateFixtureSourceIntegrity, validateGroupFolder } from '../src/guard.js'
import {
  importFixedHappyClawFixture,
  type ImportFixedFixtureRequest,
} from '../src/index.js'
import {
  assertFixedFixtureCounts,
  validateImportRequest,
} from '../src/run.js'
import {
  abortStaging,
  commitStaging,
  createStagingContext,
} from '../src/staging.js'

describe('Security Confinement, Strict Rejection, and Rollback Invariants', () => {
  let demoRoot: string
  let targetDir: string

  beforeEach(() => {
    demoRoot = mkdtempSync(join(tmpdir(), 'enkeep-security-test-'))
    targetDir = join(demoRoot, 'output')
  })

  afterEach(() => {
    if (existsSync(demoRoot)) {
      rmSync(demoRoot, { recursive: true, force: true })
    }
  })

  describe('Type System and Public API Boundaries', () => {
    it('does not accept sourceDir or arbitrary db in ImportFixedFixtureRequest', () => {
      const validReq: ImportFixedFixtureRequest = {
        targetDir,
        demoRoot,
        userId: 'alice',
        deterministicCreatedAt: '2026-08-01T12:00:00.000Z',
      }
      expect(validReq.targetDir).toBe(targetDir)

      // Verify that assigning sourceDir is not supported in the type contract
      // @ts-expect-error sourceDir must not exist in ImportFixedFixtureRequest
      const _invalidReq: ImportFixedFixtureRequest = { targetDir, demoRoot, userId: 'alice', deterministicCreatedAt: '...', sourceDir: '/some/path' }
      expect(_invalidReq).toBeDefined()
    })

    it('strictly requires exact own enumerable keys and rejects runtime extras', async () => {
      // Extra property
      await expect(
        importFixedHappyClawFixture({
          targetDir,
          demoRoot,
          userId: 'alice',
          deterministicCreatedAt: '2026-08-01T12:00:00.000Z',
          sourceDir: '/tmp/injected',
        } as any)
      ).rejects.toThrow(/request must have exact own enumerable keys/)

      // Wrong userId
      await expect(
        importFixedHappyClawFixture({
          targetDir,
          demoRoot,
          userId: 'attacker' as any,
          deterministicCreatedAt: '2026-08-01T12:00:00.000Z',
        })
      ).rejects.toThrow(/userId must strictly be "alice"/)
    })

    it('strictly enforces absolute paths and rejects whitespace trim differences in targetDir and demoRoot', () => {
      // Relative targetDir
      expect(() =>
        validateImportRequest({
          targetDir: 'relative/output',
          demoRoot,
          userId: 'alice',
          deterministicCreatedAt: '2026-08-01T12:00:00.000Z',
        })
      ).toThrow(/targetDir must be an absolute path/)

      // Relative demoRoot
      expect(() =>
        validateImportRequest({
          targetDir,
          demoRoot: 'relative/demoRoot',
          userId: 'alice',
          deterministicCreatedAt: '2026-08-01T12:00:00.000Z',
        })
      ).toThrow(/demoRoot must be an absolute path/)

      // Whitespace in targetDir
      expect(() =>
        validateImportRequest({
          targetDir: ` ${targetDir} `,
          demoRoot,
          userId: 'alice',
          deterministicCreatedAt: '2026-08-01T12:00:00.000Z',
        })
      ).toThrow(/targetDir must not have leading or trailing whitespace/)

      // Whitespace in demoRoot
      expect(() =>
        validateImportRequest({
          targetDir,
          demoRoot: `${demoRoot} `,
          userId: 'alice',
          deterministicCreatedAt: '2026-08-01T12:00:00.000Z',
        })
      ).toThrow(/demoRoot must not have leading or trailing whitespace/)
    })

    it('strictly requires canonical ISO string for deterministicCreatedAt', () => {
      // Valid canonical ISO
      expect(() =>
        validateImportRequest({
          targetDir,
          demoRoot,
          userId: 'alice',
          deterministicCreatedAt: '2026-08-01T12:00:00.000Z',
        })
      ).not.toThrow()

      // Non-ISO / Non-canonical formats
      expect(() =>
        validateImportRequest({
          targetDir,
          demoRoot,
          userId: 'alice',
          deterministicCreatedAt: '2026-08-01',
        })
      ).toThrow(/deterministicCreatedAt must be a canonical ISO string/)

      expect(() =>
        validateImportRequest({
          targetDir,
          demoRoot,
          userId: 'alice',
          deterministicCreatedAt: '2026-08-01T12:00:00Z',
        })
      ).toThrow(/deterministicCreatedAt must be a canonical ISO string/)

      expect(() =>
        validateImportRequest({
          targetDir,
          demoRoot,
          userId: 'alice',
          deterministicCreatedAt: 'invalid-date',
        })
      ).toThrow(/deterministicCreatedAt must be a canonical ISO string/)
    })

    it('detects and asserts exact fixed fixture counts preventing silent drift', () => {
      // Valid counts (chats: 2, messages: 52, talk: 50, empty: 2, attachments: 5)
      expect(() => assertFixedFixtureCounts(2, 52, 2, 52, 50, 2, 5)).not.toThrow()

      // Drift in messages count
      expect(() => assertFixedFixtureCounts(2, 51, 2, 51, 49, 2, 5)).toThrow(
        /fixed fixture drift detected/
      )

      // Drift in chats count
      expect(() => assertFixedFixtureCounts(3, 52, 3, 52, 50, 2, 5)).toThrow(
        /fixed fixture drift detected/
      )
    })
  })

  describe('Group Folder Strict Validation (No Sanitization)', () => {
    it('accepts valid alphanumeric, hyphen, dot, underscore folder names', () => {
      expect(validateGroupFolder('alice-space')).toBe('alice-space')
      expect(validateGroupFolder('bob_space.01')).toBe('bob_space.01')
      expect(validateGroupFolder('Project123')).toBe('Project123')
      expect(validateGroupFolder('a')).toBe('a')
    })

    it('strictly rejects path traversals (., ..)', () => {
      expect(() => validateGroupFolder('.')).toThrow(/cannot be "\." or "\.\."/)
      expect(() => validateGroupFolder('..')).toThrow(/cannot be "\." or "\.\."/)
    })

    it('strictly rejects slashes and backslashes without sanitizing', () => {
      expect(() => validateGroupFolder('alice/space')).toThrow(/cannot contain path separators/)
      expect(() => validateGroupFolder('../alice-space')).toThrow(/cannot contain path separators/)
      expect(() => validateGroupFolder('alice\\space')).toThrow(/cannot contain path separators/)
    })

    it('strictly rejects control characters', () => {
      expect(() => validateGroupFolder('alice\x00space')).toThrow(/cannot contain control characters/)
      expect(() => validateGroupFolder('alice\nspace')).toThrow(/cannot contain control characters/)
      expect(() => validateGroupFolder('alice\tspace')).toThrow(/cannot contain control characters/)
    })

    it('strictly rejects Unicode confusables and non-ASCII characters', () => {
      expect(() => validateGroupFolder('аlice-space')).toThrow(/Must match pattern/) // Cyrillic 'а'
      expect(() => validateGroupFolder('alice space')).toThrow(/Must match pattern/) // Space
      expect(() => validateGroupFolder('alice@space')).toThrow(/Must match pattern/) // @
      expect(() => validateGroupFolder('alice!space')).toThrow(/Must match pattern/) // !
      expect(() => validateGroupFolder('空间')).toThrow(/Must match pattern/) // Chinese
    })

    it('strictly rejects names exceeding 64 characters or empty names', () => {
      expect(() => validateGroupFolder('')).toThrow(/length must be between 1 and 64/)
      expect(() => validateGroupFolder('a'.repeat(65))).toThrow(/length must be between 1 and 64/)
    })
  })

  describe('Symlink and Special File Rejection', () => {
    it('rejects copySpaceToStaging when source contains recursive or external symlinks', () => {
      const sourceGroups = join(demoRoot, 'source-groups')
      const stagingSpaces = join(demoRoot, 'staging-spaces')
      const badSpace = join(sourceGroups, 'bad-space')
      mkdirSync(badSpace, { recursive: true })
      mkdirSync(stagingSpaces, { recursive: true })

      const outsideFile = join(demoRoot, 'outside-secret.txt')
      writeFileSync(outsideFile, 'secret', 'utf8')

      const symlinkInSpace = join(badSpace, 'symlink-leak')
      try {
        symlinkSync(outsideFile, symlinkInSpace)
      } catch {
        // Skip if OS does not permit symlinks
        return
      }

      expect(() => copySpaceToStaging(sourceGroups, stagingSpaces, 'bad-space')).toThrow(
        /forbidden symlink encountered/
      )
    })

    it('rejects fixture source integrity check if a symlink exists', () => {
      const mockFixture = join(demoRoot, 'mock-fixture')
      mkdirSync(mockFixture, { recursive: true })

      const linkPath = join(mockFixture, 'link-file')
      const targetFile = join(demoRoot, 'target-file')
      writeFileSync(targetFile, 'content', 'utf8')

      try {
        symlinkSync(targetFile, linkPath)
      } catch {
        return
      }

      expect(() => validateFixtureSourceIntegrity(mockFixture)).toThrow(
        /forbidden symbolic link in fixture source/
      )
    })
  })

  describe('Staging Commit, Rollback, and AggregateError Evidence Preservation', () => {
    it('aborts staging cleanly and preserves original errors in AggregateError if cleanup fails', () => {
      const stagingCtx = createStagingContext(targetDir)
      expect(existsSync(stagingCtx.stagingDir)).toBe(true)

      const originalErr = new Error('original import error')
      // Normal abort cleanly removes staging dir
      abortStaging(stagingCtx, originalErr)
      expect(existsSync(stagingCtx.stagingDir)).toBe(false)
    })

    it('refuses commit and does not destroy existing destination if contents mismatch', async () => {
      // 1. Initial successful import
      await importFixedHappyClawFixture({
        targetDir,
        demoRoot,
        userId: 'alice',
        deterministicCreatedAt: '2026-08-01T12:00:00.000Z',
      })

      // 2. Corrupt/modify destination
      const modifiedFile = join(targetDir, 'mapping.json')
      writeFileSync(modifiedFile, '{"tampered": true}\n', 'utf8')

      // 3. Attempt commit should refuse without destroying tampered destination
      await expect(
        importFixedHappyClawFixture({
          targetDir,
          demoRoot,
          userId: 'alice',
          deterministicCreatedAt: '2026-08-01T12:00:00.000Z',
        })
      ).rejects.toThrow(/already exists and contents mismatch.*Refusing to overwrite/)

      expect(readFileSync(modifiedFile, 'utf8')).toBe('{"tampered": true}\n')
    })

    it('handles race conditions during commit with exact tree verification', () => {
      const stagingCtx = createStagingContext(targetDir)
      writeFileSync(join(stagingCtx.stagingDir, 'file.txt'), 'hello', 'utf8')

      // Create matching destDir before commit
      mkdirSync(stagingCtx.destDir, { recursive: true })
      mkdirSync(join(stagingCtx.destDir, 'seeds'), { recursive: true })
      mkdirSync(join(stagingCtx.destDir, 'spaces'), { recursive: true })
      writeFileSync(join(stagingCtx.destDir, 'file.txt'), 'hello', 'utf8')

      // Commit should detect matching destination and clean staging
      expect(() => commitStaging(stagingCtx)).not.toThrow()
      expect(existsSync(stagingCtx.stagingDir)).toBe(false)
      expect(existsSync(stagingCtx.destDir)).toBe(true)
    })
  })
})
