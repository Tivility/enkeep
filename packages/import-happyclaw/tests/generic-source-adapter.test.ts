import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {
  compileChats,
  compileSeed,
  createMigrationPlan,
  deterministicSessionId,
  deterministicSpaceId,
  executeGenericMigration,
  formatInspectSummary,
  inspectSource,
  introspectSource,
  readSource,
  sessionIdFor,
  type AnomalyRecord,
  type CompiledChat,
  type GenericMigrateOptions,
  type MessageRow,
} from '../src/index.js'
import { assertLegalSeed, getSessionModule } from '../src/validate.js'

function createTempDir(prefix: string): string {
  const dir = join(tmpdir(), `enkeep-test-${prefix}-${randomUUID()}`)
  mkdirSync(dir, { recursive: true, mode: 0o755 })
  return dir
}

describe('Universal HappyClaw Source Adapter & Introspection', () => {
  it('1. Introspects modern/current HappyClaw schema and produces valid diagnostic', () => {
    const tempDir = createTempDir('current-schema')
    const dbPath = join(tempDir, 'messages.db')
    const db = new DatabaseSync(dbPath)

    db.exec(`
      CREATE TABLE router_state (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO router_state (key, value) VALUES ('schema_version', '64');

      CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT, last_message_time TEXT);
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        chat_jid TEXT,
        sender TEXT,
        sender_name TEXT,
        content TEXT,
        timestamp TEXT,
        is_from_me INTEGER,
        attachments TEXT,
        delivery_status TEXT,
        source_kind TEXT
      );
      CREATE TABLE registered_groups (
        jid TEXT PRIMARY KEY,
        name TEXT,
        folder TEXT,
        execution_mode TEXT
      );
      CREATE TABLE workspaces (jid TEXT PRIMARY KEY, folder TEXT, name TEXT);
      CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT, prompt TEXT);
    `)

    db.close()

    const diag = introspectSource(dbPath)
    expect(diag.ok).toBe(true)
    expect(diag.compatibilityLevel).toBe('current')
    expect(diag.detectedSchemaVersion).toBe(64)
    expect(diag.missingRequiredTables).toHaveLength(0)
    expect(diag.tablesFound).toContain('messages')
    expect(diag.tablesFound).toContain('chats')
    expect(diag.tablesFound).toContain('registered_groups')

    rmSync(tempDir, { recursive: true, force: true })
  })

  it('2. Introspects legacy schema (missing registered_groups and router_state) and marks compatibility as legacy', () => {
    const tempDir = createTempDir('legacy-schema')
    const dbPath = join(tempDir, 'legacy.db')
    const db = new DatabaseSync(dbPath)

    db.exec(`
      CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        chat_jid TEXT,
        content TEXT,
        timestamp TEXT,
        is_from_me INTEGER
      );
    `)
    db.close()

    const diag = introspectSource(dbPath)
    expect(diag.ok).toBe(true)
    expect(diag.compatibilityLevel).toBe('legacy')
    expect(diag.detectedSchemaVersion).toBeNull()
    expect(diag.issues.some((i) => i.includes('registered_groups'))).toBe(true)

    rmSync(tempDir, { recursive: true, force: true })
  })

  it('3. Introspects minimal single-table schema (messages only) and marks compatibility as minimal', () => {
    const tempDir = createTempDir('minimal-schema')
    const dbPath = join(tempDir, 'minimal.db')
    const db = new DatabaseSync(dbPath)

    db.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        chat_jid TEXT,
        content TEXT,
        timestamp TEXT,
        is_from_me INTEGER
      );
    `)
    db.close()

    const diag = introspectSource(dbPath)
    expect(diag.ok).toBe(true)
    expect(diag.compatibilityLevel).toBe('minimal')
    expect(diag.tablesFound).toContain('messages')

    rmSync(tempDir, { recursive: true, force: true })
  })

  it('4. Rejects corrupted or invalid database (missing messages table) with structured diagnostic', () => {
    const tempDir = createTempDir('corrupt-schema')
    const dbPath = join(tempDir, 'empty.db')
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE some_other_table (id TEXT);')
    db.close()

    const diag = introspectSource(dbPath)
    expect(diag.ok).toBe(false)
    expect(diag.compatibilityLevel).toBe('incompatible')
    expect(diag.missingRequiredTables).toContain('messages')
    expect(diag.issues.length).toBeGreaterThan(0)
    expect(diag.recommendations.length).toBeGreaterThan(0)

    rmSync(tempDir, { recursive: true, force: true })
  })

  it('5. Rejects source database with active WAL / SHM files to guarantee immutable consistency', () => {
    const tempDir = createTempDir('wal-check')
    const dbPath = join(tempDir, 'messages.db')
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE messages (id TEXT, chat_jid TEXT, content TEXT, timestamp TEXT, is_from_me INTEGER);')
    db.close()

    writeFileSync(`${dbPath}-wal`, 'temporary wal data')

    const diag = introspectSource(dbPath)
    expect(diag.ok).toBe(true)
    expect(diag.issues.some((i) => i.includes('WAL file'))).toBe(true)

    rmSync(tempDir, { recursive: true, force: true })
  })

  it('6. Allows inspecting and migrating from any operator-authorized explicit path including happyclaw/data', async () => {
    const tempDir = createTempDir('custom-happyclaw-data')
    const happyclawDataDir = join(tempDir, 'user-workspace', 'happyclaw', 'data')
    mkdirSync(happyclawDataDir, { recursive: true })
    const dbPath = join(happyclawDataDir, 'messages.db')

    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE messages (id TEXT PRIMARY KEY, chat_jid TEXT, content TEXT, timestamp TEXT, is_from_me INTEGER, attachments TEXT);
      INSERT INTO chats (jid, name) VALUES ('web:real_path_test', 'Real Path Chat');
      INSERT INTO messages (id, chat_jid, content, timestamp, is_from_me, attachments) VALUES
        ('m1', 'web:real_path_test', 'Testing path containing happyclaw/data', '2026-08-01T12:00:00.000Z', 0, NULL),
        ('m2', 'web:real_path_test', 'Migration works smoothly without directory name blocks', '2026-08-01T12:01:00.000Z', 1, NULL);
    `)
    db.close()

    // Inspect succeeds without error
    const inspectRes = inspectSource({ sourcePath: dbPath })
    expect(inspectRes.totalConversations).toBe(1)
    expect(inspectRes.conversations[0]?.sourceKey).toBe('web:real_path_test')

    // Migrate succeeds
    const migrationRes = await executeGenericMigration({
      sourcePath: dbPath,
      userId: 'alice',
      all: true,
    })
    expect(migrationRes.success).toBe(true)
    expect(migrationRes.compiledChats).toHaveLength(1)

    rmSync(tempDir, { recursive: true, force: true })
  })
})

describe('Multi-Scale Dynamic Temporary Databases (0, 1, 100 Conversations)', () => {
  it('A. Scale 0: Empty database with 0 conversations and 0 messages', async () => {
    const tempDir = createTempDir('scale-0')
    const dbPath = join(tempDir, 'messages.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE messages (id TEXT PRIMARY KEY, chat_jid TEXT, content TEXT, timestamp TEXT, is_from_me INTEGER, attachments TEXT);
      CREATE TABLE registered_groups (jid TEXT PRIMARY KEY, name TEXT, folder TEXT, execution_mode TEXT);
    `)
    db.close()

    // Inspect
    const inspectRes = inspectSource({ sourcePath: dbPath })
    expect(inspectRes.totalConversations).toBe(0)
    expect(inspectRes.totalMessages).toBe(0)
    expect(inspectRes.conversations).toHaveLength(0)

    const summaryText = formatInspectSummary(inspectRes)
    expect(summaryText).toContain('Total Chats:       0')
    expect(summaryText).toContain('No conversations found')

    // Plan
    const plan = createMigrationPlan({
      sourcePath: dbPath,
      userId: 'alice',
      all: true,
      dryRun: true,
    })
    expect(plan.totalConversations).toBe(0)
    expect(plan.totalMessages).toBe(0)

    // Execute
    const execRes = await executeGenericMigration({
      sourcePath: dbPath,
      userId: 'alice',
      all: true,
    })
    expect(execRes.success).toBe(true)
    expect(execRes.compiledChats).toHaveLength(0)
    expect(execRes.stats.chats).toBe(0)

    rmSync(tempDir, { recursive: true, force: true })
  })

  it('B. Scale 1: Single conversation with attachments and valid DSH seed generation', async () => {
    const tempDir = createTempDir('scale-1')
    const dbPath = join(tempDir, 'messages.db')
    const groupsDir = join(tempDir, 'groups')
    mkdirSync(join(groupsDir, 'project-alpha'), { recursive: true })
    writeFileSync(join(groupsDir, 'project-alpha', 'spec.md'), '# Project Alpha Spec')

    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE messages (id TEXT PRIMARY KEY, chat_jid TEXT, content TEXT, timestamp TEXT, is_from_me INTEGER, attachments TEXT);
      CREATE TABLE registered_groups (jid TEXT PRIMARY KEY, name TEXT, folder TEXT, execution_mode TEXT);

      INSERT INTO chats (jid, name) VALUES ('feishu:oc_alpha', 'Alpha Project');
      INSERT INTO registered_groups (jid, name, folder, execution_mode) VALUES ('feishu:oc_alpha', 'Alpha Project', 'project-alpha', 'container');

      INSERT INTO messages (id, chat_jid, content, timestamp, is_from_me, attachments) VALUES
        ('msg-1', 'feishu:oc_alpha', 'Can we review the spec?', '2026-08-01T10:00:00.000Z', 0, NULL),
        ('msg-2', 'feishu:oc_alpha', 'Here is the project spec document.', '2026-08-01T10:01:00.000Z', 1, '[{"path":"spec.md"}]'),
        ('msg-3', 'feishu:oc_alpha', 'Looks great, proceed with implementation.', '2026-08-01T10:02:00.000Z', 0, NULL),
        ('msg-4', 'feishu:oc_alpha', 'Implementation started.', '2026-08-01T10:03:00.000Z', 1, NULL);
    `)
    db.close()

    // 1. Inspect
    const inspectRes = inspectSource({ sourcePath: dbPath, groupsDir })
    expect(inspectRes.totalConversations).toBe(1)
    expect(inspectRes.totalMessages).toBe(4)
    const conv = inspectRes.conversations[0]!
    expect(conv.sourceKey).toBe('feishu:oc_alpha')
    expect(conv.channel).toBe('feishu')
    expect(conv.name).toBe('Alpha Project')
    expect(conv.folder).toBe('project-alpha')
    expect(conv.hasAttachments).toBe(true)

    // 2. Migration Execution with custom target directory
    const targetDir = join(tempDir, 'output')
    const migrationRes = await executeGenericMigration({
      sourcePath: dbPath,
      sourceGroupsDir: groupsDir,
      conversations: ['feishu:oc_alpha'],
      userId: 'alice',
      targetDir,
      demoRoot: tempDir,
    })

    expect(migrationRes.success).toBe(true)
    expect(migrationRes.compiledChats).toHaveLength(1)
    const compiled = migrationRes.compiledChats[0]!
    expect(compiled.chatJid).toBe('feishu:oc_alpha')
    expect(compiled.folder).toBe('project-alpha')

    // Verify seed passes DSH Session.create invariants
    await assertLegalSeed(compiled.sessionId, compiled.seed)

    // Verify output directory files
    expect(existsSync(join(targetDir, 'mapping.json'))).toBe(true)
    expect(existsSync(join(targetDir, 'manifest.json'))).toBe(true)
    expect(existsSync(join(targetDir, 'seeds', `${compiled.sessionId}.json`))).toBe(true)
    expect(existsSync(join(targetDir, 'spaces', 'project-alpha', 'spec.md'))).toBe(true)

    rmSync(tempDir, { recursive: true, force: true })
  })

  it('C. Scale 100: Large-scale database with 100 conversations, verifying complete seed validity & selective fork', async () => {
    const tempDir = createTempDir('scale-100')
    const dbPath = join(tempDir, 'messages.db')
    const db = new DatabaseSync(dbPath)

    db.exec(`
      CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE messages (id TEXT PRIMARY KEY, chat_jid TEXT, sender TEXT, content TEXT, timestamp TEXT, is_from_me INTEGER, attachments TEXT);
      CREATE TABLE registered_groups (jid TEXT PRIMARY KEY, name TEXT, folder TEXT, execution_mode TEXT);
    `)

    const insertChat = db.prepare('INSERT INTO chats (jid, name) VALUES (?, ?)')
    const insertGroup = db.prepare('INSERT INTO registered_groups (jid, name, folder, execution_mode) VALUES (?, ?, ?, ?)')
    const insertMsg = db.prepare('INSERT INTO messages (id, chat_jid, sender, content, timestamp, is_from_me, attachments) VALUES (?, ?, ?, ?, ?, ?, ?)')

    const totalChats = 100
    let totalMessagesCreated = 0

    for (let i = 1; i <= totalChats; i++) {
      const channel = i % 4 === 0 ? 'feishu' : i % 4 === 1 ? 'web' : i % 4 === 2 ? 'telegram' : 'whatsapp'
      const jid = `${channel}:chat_${i.toString().padStart(3, '0')}`
      const name = `Conversation ${i}`
      const folder = `group-${i.toString().padStart(3, '0')}`

      insertChat.run(jid, name)
      insertGroup.run(jid, name, folder, 'container')

      // Generate 2 to 6 messages per conversation (alternating user / assistant)
      const msgCount = 2 + (i % 5)
      for (let m = 1; m <= msgCount; m++) {
        const isFromMe = m % 2 === 0 ? 1 : 0
        const msgId = `m_${i}_${m}`
        const content = isFromMe ? `Assistant response ${m} for chat ${i}` : `User query ${m} for chat ${i}`
        const time = new Date(Date.UTC(2026, 7, 1, 10, i, m)).toISOString()
        insertMsg.run(msgId, jid, isFromMe ? 'assistant' : 'user', content, time, isFromMe, null)
        totalMessagesCreated++
      }
    }

    db.close()

    // 1. Inspect 100 conversations
    const inspectRes = inspectSource({ sourcePath: dbPath })
    expect(inspectRes.totalConversations).toBe(100)
    expect(inspectRes.totalMessages).toBe(totalMessagesCreated)
    expect(inspectRes.conversations).toHaveLength(100)

    // 2. Selectively fork only 2 conversations (chat_001 and chat_002)
    const selectedJids = ['web:chat_001', 'telegram:chat_002']
    const plan = createMigrationPlan({
      sourcePath: dbPath,
      conversations: selectedJids,
      userId: 'alice',
      dryRun: true,
    })
    expect(plan.totalConversations).toBe(2)
    expect(plan.items.map((i) => i.sourceKey).sort()).toEqual(selectedJids.sort())

    // 3. Execute selective migration
    const targetDir = join(tempDir, 'output-selective')
    const selectiveRes = await executeGenericMigration({
      sourcePath: dbPath,
      conversations: selectedJids,
      userId: 'alice',
      targetDir,
      demoRoot: tempDir,
    })
    expect(selectiveRes.success).toBe(true)
    expect(selectiveRes.compiledChats).toHaveLength(2)

    // Verify both compiled seeds satisfy DSH invariants
    for (const chat of selectiveRes.compiledChats) {
      await assertLegalSeed(chat.sessionId, chat.seed)
    }

    // 4. Execute full 100 conversation migration without dryRun
    const allRes = await executeGenericMigration({
      sourcePath: dbPath,
      all: true,
      userId: 'alice',
    })
    expect(allRes.success).toBe(true)
    expect(allRes.compiledChats).toHaveLength(100)
    expect(allRes.stats.sourceMessages).toBe(totalMessagesCreated)

    rmSync(tempDir, { recursive: true, force: true })
  },
  // Large fixture under repository-wide parallel load
  15000)
})

describe('Fork Semantics & DSH Session Resume', () => {
  it('forks a conversation and verifies new generation 1 session can resume directly with DSH Session.create', async () => {
    const tempDir = createTempDir('fork-resume')
    const dbPath = join(tempDir, 'messages.db')
    const db = new DatabaseSync(dbPath)

    db.exec(`
      CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE messages (id TEXT PRIMARY KEY, chat_jid TEXT, content TEXT, timestamp TEXT, is_from_me INTEGER, attachments TEXT);

      INSERT INTO chats (jid, name) VALUES ('web:brainstorm', 'Original Brainstorm');
      INSERT INTO messages (id, chat_jid, content, timestamp, is_from_me, attachments) VALUES
        ('m-1', 'web:brainstorm', 'What are our key architecture goals?', '2026-08-01T12:00:00.000Z', 0, NULL),
        ('m-2', 'web:brainstorm', '1. Modularity, 2. Strict Invariants, 3. Multi-tenant isolation.', '2026-08-01T12:01:00.000Z', 1, NULL);
    `)
    db.close()

    // Fork single conversation with custom space and title
    const forkRes = await executeGenericMigration({
      sourcePath: dbPath,
      conversations: ['web:brainstorm'],
      userId: 'bob',
      targetSpace: 'forked-brainstorm-space',
      titleOverride: 'Forked Brainstorm Session',
    })

    expect(forkRes.success).toBe(true)
    expect(forkRes.compiledChats).toHaveLength(1)
    const compiled = forkRes.compiledChats[0]!
    expect(compiled.folder).toBe('forked-brainstorm-space')

    // Verify session ID is deterministic and starts with import-
    expect(compiled.sessionId).toMatch(/^import-[0-9a-f]{32}$/)

    // Resume using real DSH Session engine
    const { Session, SessionId } = await getSessionModule()
    const sid = SessionId(compiled.sessionId)
    const session = Session.create(sid, compiled.seed) as {
      snapshotEvents: () => Array<{ type: string; seq: number; data?: any }>
    }

    const sessionEvents = session.snapshotEvents()
    expect(sessionEvents.length).toBe(compiled.seed.length)
    expect(sessionEvents.at(-1)?.type).toBe('session/end-seed')

    // Append follow-up turn in resumed session
    const lastSeq = sessionEvents.length
    const followUpUserEvent = {
      type: 'user/message',
      seq: lastSeq,
      time: Date.parse('2026-08-01T12:05:00.000Z'),
      surfaceOp: 'append' as const,
      data: {
        id: 'msg_followup_1',
        role: 'user',
        content: [{ type: 'text', text: 'How do we test goal 2?' }],
        source: { kind: 'user' },
      },
    }

    // Creating session with resumed history + followup works seamlessly
    const extendedSeed = [...compiled.seed, followUpUserEvent]
    const continuedSession = Session.create(sid, extendedSeed) as {
      snapshotEvents: () => Array<{ type: string; data?: any }>
    }
    const continuedEvents = continuedSession.snapshotEvents()
    expect(continuedEvents.length).toBeGreaterThanOrEqual(extendedSeed.length)
    expect(continuedEvents.some((e) => e.type === 'user/message' && e.data?.id === 'msg_followup_1')).toBe(true)

    rmSync(tempDir, { recursive: true, force: true })
  })

  it('proves idempotent repeat migration: re-migrating the exact same source produces identical deterministic IDs and manifests', async () => {
    const tempDir = createTempDir('idempotent-migration')
    const dbPath = join(tempDir, 'messages.db')
    const db = new DatabaseSync(dbPath)

    db.exec(`
      CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE messages (id TEXT PRIMARY KEY, chat_jid TEXT, content TEXT, timestamp TEXT, is_from_me INTEGER, attachments TEXT);
      INSERT INTO chats (jid, name) VALUES ('web:idemp', 'Idempotent Chat');
      INSERT INTO messages (id, chat_jid, content, timestamp, is_from_me, attachments) VALUES
        ('m-1', 'web:idemp', 'First msg', '2026-08-01T12:00:00.000Z', 0, NULL),
        ('m-2', 'web:idemp', 'Second reply', '2026-08-01T12:01:00.000Z', 1, NULL);
    `)
    db.close()

    const deterministicCreatedAt = '2026-08-01T12:00:00.000Z'

    const res1 = await executeGenericMigration({
      sourcePath: dbPath,
      userId: 'alice',
      all: true,
      deterministicCreatedAt,
      targetDir: join(tempDir, 'out1'),
      demoRoot: tempDir,
    })

    const res2 = await executeGenericMigration({
      sourcePath: dbPath,
      userId: 'alice',
      all: true,
      deterministicCreatedAt,
      targetDir: join(tempDir, 'out2'),
      demoRoot: tempDir,
    })

    expect(res1.sourceFingerprint).toBe(res2.sourceFingerprint)
    expect(res1.compiledChats[0]?.sessionId).toBe(res2.compiledChats[0]?.sessionId)
    expect(res1.manifest.sourceFingerprint).toBe(res2.manifest.sourceFingerprint)
    expect(res1.manifest.stats).toEqual(res2.manifest.stats)

    rmSync(tempDir, { recursive: true, force: true })
  })
})
