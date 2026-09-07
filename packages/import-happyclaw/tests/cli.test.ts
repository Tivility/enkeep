import { describe, expect, it } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { parseCliArgs, runCli } from '../src/cli.js'

function createTempDb(tempDir: string): string {
  const dbPath = join(tempDir, 'messages.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE messages (id TEXT PRIMARY KEY, chat_jid TEXT, content TEXT, timestamp TEXT, is_from_me INTEGER, attachments TEXT);
    INSERT INTO chats (jid, name) VALUES ('web:test_cli', 'CLI Test Chat');
    INSERT INTO messages (id, chat_jid, content, timestamp, is_from_me, attachments) VALUES
      ('m1', 'web:test_cli', 'Hello from CLI', '2026-08-01T12:00:00.000Z', 0, NULL),
      ('m2', 'web:test_cli', 'CLI reply back', '2026-08-01T12:01:00.000Z', 1, NULL);
  `)
  db.close()
  return dbPath
}

describe('HappyClaw Migration CLI Parser & Runner', () => {
  it('1. Parses CLI arguments accurately', () => {
    const parsed = parseCliArgs([
      'node',
      'cli.js',
      'migrate',
      '--source',
      './data/messages.db',
      '--conversation',
      'web:chat1',
      '--conversation',
      'feishu:chat2',
      '--user',
      'bob',
      '--space',
      'my-space',
      '--title',
      'Custom Title',
      '--dry-run',
      '--json',
    ])

    expect(parsed.command).toBe('migrate')
    expect(parsed.sourcePath).toBe('./data/messages.db')
    expect(parsed.conversations).toEqual(['web:chat1', 'feishu:chat2'])
    expect(parsed.user).toBe('bob')
    expect(parsed.space).toBe('my-space')
    expect(parsed.title).toBe('Custom Title')
    expect(parsed.dryRun).toBe(true)
    expect(parsed.json).toBe(true)
  })

  it('2. Executes `inspect` command via runCli and returns exit code 0', async () => {
    const tempDir = join(tmpdir(), `enkeep-cli-${randomUUID()}`)
    mkdirSync(tempDir, { recursive: true })
    const dbPath = createTempDb(tempDir)

    const code = await runCli(['node', 'cli.js', 'inspect', '--source', dbPath, '--json'])
    expect(code).toBe(0)

    rmSync(tempDir, { recursive: true, force: true })
  })

  it('3. Executes `migrate --dry-run` command via runCli and returns exit code 0', async () => {
    const tempDir = join(tmpdir(), `enkeep-cli-${randomUUID()}`)
    mkdirSync(tempDir, { recursive: true })
    const dbPath = createTempDb(tempDir)

    const code = await runCli([
      'node',
      'cli.js',
      'migrate',
      '--source',
      dbPath,
      '--all',
      '--user',
      'alice',
      '--dry-run',
      '--json',
    ])
    expect(code).toBe(0)

    rmSync(tempDir, { recursive: true, force: true })
  })

  it('4. Executes `fork` command via runCli and returns exit code 0', async () => {
    const tempDir = join(tmpdir(), `enkeep-cli-${randomUUID()}`)
    mkdirSync(tempDir, { recursive: true })
    const dbPath = createTempDb(tempDir)

    const code = await runCli([
      'node',
      'cli.js',
      'fork',
      '--source',
      dbPath,
      '--conversation',
      'web:test_cli',
      '--user',
      'alice',
      '--space',
      'forked-space',
      '--title',
      'Forked Session Title',
      '--json',
    ])
    expect(code).toBe(0)

    rmSync(tempDir, { recursive: true, force: true })
  })

  it('5. Executes CLI inspect, migrate, and fork on temporary paths intentionally named happyclaw/data', async () => {
    const tempDir = join(tmpdir(), `enkeep-cli-happyclaw-data-${randomUUID()}`)
    const customDataDir = join(tempDir, 'happyclaw', 'data')
    mkdirSync(customDataDir, { recursive: true })
    const dbPath = createTempDb(customDataDir)

    // Inspect
    const inspectCode = await runCli(['node', 'cli.js', 'inspect', '--source', dbPath, '--json'])
    expect(inspectCode).toBe(0)

    // Migrate dry-run
    const migrateCode = await runCli([
      'node',
      'cli.js',
      'migrate',
      '--source',
      dbPath,
      '--all',
      '--user',
      'alice',
      '--dry-run',
      '--json',
    ])
    expect(migrateCode).toBe(0)

    // Fork
    const forkCode = await runCli([
      'node',
      'cli.js',
      'fork',
      '--source',
      dbPath,
      '--conversation',
      'web:test_cli',
      '--user',
      'alice',
      '--json',
    ])
    expect(forkCode).toBe(0)

    rmSync(tempDir, { recursive: true, force: true })
  })

  it('5. Returns exit code 1 on missing source path or unknown command', async () => {
    const code1 = await runCli(['node', 'cli.js', 'inspect'])
    expect(code1).toBe(1)

    const code2 = await runCli(['node', 'cli.js', 'unknown_cmd', '--source', 'some.db'])
    expect(code2).toBe(1)
  })

  it('6. Returns exit code 0 on --help', async () => {
    const code = await runCli(['node', 'cli.js', '--help'])
    expect(code).toBe(0)
  })
})
