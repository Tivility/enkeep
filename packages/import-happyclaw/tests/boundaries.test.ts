import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  importFixedHappyClawFixture,
  type MessageRow,
} from '../src/index.js'
import { readSource } from '../src/read-source.js'
import {
  attachmentNote,
  compileChats,
  compileSeed,
  parseTimestamp,
  peopleTalk,
  validateRelativeAttachmentPath,
} from '../src/seed.js'

describe('Boundary and Edge Case Handling', () => {
  let demoRoot: string
  let targetDir: string

  beforeEach(() => {
    demoRoot = mkdtempSync(join(tmpdir(), 'enkeep-demo-test-boundaries-'))
    targetDir = join(demoRoot, 'output')
  })

  afterEach(() => {
    if (existsSync(demoRoot)) {
      rmSync(demoRoot, { recursive: true, force: true })
    }
  })

  it('verifies Alice has at least 20 human conversation turns and assistant pairs', async () => {
    const result = await importFixedHappyClawFixture({
      targetDir,
      demoRoot,
      userId: 'alice',
      deterministicCreatedAt: '2026-08-01T12:00:00.000Z',
    })

    const aliceChat = result.chats.find((c) => c.chatJid === 'web:alice-workspace-jid-001')!
    expect(aliceChat).toBeDefined()
    expect(aliceChat.report.importedPeopleTalk).toBeGreaterThanOrEqual(20)
    expect(aliceChat.report.sourceMessages).toBeGreaterThanOrEqual(40)

    // Count user and assistant messages in compiled seed
    const userEvents = aliceChat.seed.filter((e) => e.type === 'user/message')
    const assistantEvents = aliceChat.seed.filter((e) => e.type === 'assistant/message')

    expect(userEvents.length).toBeGreaterThanOrEqual(20)
    expect(assistantEvents.length).toBeGreaterThanOrEqual(20)
  })

  it('handles consecutive user and consecutive assistant messages properly', () => {
    const chatJid = 'web:boundary-consecutive'
    const rows: MessageRow[] = [
      { id: '1', chat_jid: chatJid, content: 'User 1a', timestamp: '2026-08-01T10:00:00Z', is_from_me: 0, attachments: null },
      { id: '2', chat_jid: chatJid, content: 'User 1b (consecutive)', timestamp: '2026-08-01T10:00:01Z', is_from_me: 0, attachments: null },
      { id: '3', chat_jid: chatJid, content: 'Assistant 1', timestamp: '2026-08-01T10:00:05Z', is_from_me: 1, attachments: null },
      { id: '4', chat_jid: chatJid, content: 'Assistant 2 (consecutive)', timestamp: '2026-08-01T10:00:06Z', is_from_me: 1, attachments: null },
    ]

    const { seed, report, anomalies } = compileSeed(chatJid, rows)
    expect(report.consecutiveUserMessages).toBe(1)
    expect(report.consecutiveAssistantMessages).toBe(1)
    expect(seed.filter((e) => e.type === 'user/message')).toHaveLength(2)
    expect(seed.filter((e) => e.type === 'assistant/message')).toHaveLength(2)

    expect(anomalies.some((a) => a.type === 'consecutive_user_message')).toBe(true)
    expect(anomalies.some((a) => a.type === 'consecutive_assistant_message')).toBe(true)
  })

  it('drops empty messages and records anomalies', () => {
    const chatJid = 'web:boundary-empty'
    const rows: MessageRow[] = [
      { id: '1', chat_jid: chatJid, content: 'Valid message', timestamp: '2026-08-01T10:00:00Z', is_from_me: 0, attachments: null },
      { id: '2', chat_jid: chatJid, content: '', timestamp: '2026-08-01T10:00:01Z', is_from_me: 0, attachments: null },
      { id: '3', chat_jid: chatJid, content: '   ', timestamp: '2026-08-01T10:00:02Z', is_from_me: 1, attachments: null },
      { id: '4', chat_jid: chatJid, content: null, timestamp: '2026-08-01T10:00:03Z', is_from_me: 0, attachments: null },
    ]

    const { seed, report, anomalies } = compileSeed(chatJid, rows)
    expect(report.sourceMessages).toBe(4)
    expect(report.droppedEmpty).toBe(3)
    expect(report.importedPeopleTalk).toBe(1)
    expect(seed.filter((e) => e.type === 'user/message')).toHaveLength(1)

    const emptyAnomalies = anomalies.filter((a) => a.type === 'empty_message')
    expect(emptyAnomalies).toHaveLength(3)
  })

  it('parses timestamps correctly and provides monotonic fallback for invalid ones', () => {
    expect(parseTimestamp('2026-08-01T10:00:00.000Z')).toBe(Date.parse('2026-08-01T10:00:00.000Z'))
    expect(parseTimestamp('1785500000000')).toBe(1785500000000)
    expect(parseTimestamp(null)).toBeUndefined()
    expect(parseTimestamp('')).toBeUndefined()
    expect(parseTimestamp('   ')).toBeUndefined()
    expect(parseTimestamp('invalid-date-string')).toBeUndefined()
    expect(parseTimestamp('-500')).toBeUndefined()

    const chatJid = 'web:boundary-time'
    const rows: MessageRow[] = [
      { id: '1', chat_jid: chatJid, content: 'Msg with null time', timestamp: null, is_from_me: 0, attachments: null },
      { id: '2', chat_jid: chatJid, content: 'Msg with invalid time', timestamp: 'invalid-time', is_from_me: 1, attachments: null },
      { id: '3', chat_jid: chatJid, content: 'Msg with valid ISO time', timestamp: '2026-08-01T10:00:00Z', is_from_me: 0, attachments: null },
    ]

    const { seed, anomalies } = compileSeed(chatJid, rows)
    expect(seed[0]?.time).toBe(0)
    expect(seed[1]?.time).toBe(Date.parse('2026-08-01T10:00:00Z'))
    expect(seed[2]?.time).toBe(Date.parse('2026-08-01T10:00:00Z') + 1)
    expect(anomalies.some((a) => a.type === 'missing_timestamp')).toBe(true)
    expect(anomalies.some((a) => a.type === 'invalid_timestamp')).toBe(true)
  })

  it('validates relative attachment paths strictly and rejects invalid patterns', () => {
    expect(validateRelativeAttachmentPath('notes/plan.md')).toBe('notes/plan.md')
    expect(validateRelativeAttachmentPath('artifacts/out.json')).toBe('artifacts/out.json')
    expect(validateRelativeAttachmentPath('conversations/chat.md')).toBe('conversations/chat.md')
    expect(validateRelativeAttachmentPath('doc.pdf')).toBe('doc.pdf')

    // Absolute paths forbidden
    expect(() => validateRelativeAttachmentPath('/notes/plan.md')).toThrow(/absolute paths and backslashes are forbidden/)
    // Backslashes forbidden
    expect(() => validateRelativeAttachmentPath('notes\\plan.md')).toThrow(/absolute paths and backslashes are forbidden/)
    // Traversal forbidden
    expect(() => validateRelativeAttachmentPath('../secret.txt')).toThrow(/invalid attachment path segment/)
    expect(() => validateRelativeAttachmentPath('notes/../secret.txt')).toThrow(/invalid attachment path segment/)
    // Control characters forbidden
    expect(() => validateRelativeAttachmentPath('notes/\x00secret.txt')).toThrow(/control characters are forbidden/)
  })

  it('normalizes valid attachment shapes and throws on malformed JSON without suppression', () => {
    expect(attachmentNote(null)).toBeUndefined()
    expect(attachmentNote('')).toBeUndefined()
    // Malformed JSON must throw error (no catch suppression)
    expect(() => attachmentNote('invalid-json')).toThrow()
    expect(attachmentNote(JSON.stringify([{ path: 'notes/plan.md' }]))).toBe('见空间内 notes/plan.md')
    expect(attachmentNote(JSON.stringify([{ filename: 'artifacts/out.json' }]))).toBe('见空间内 artifacts/out.json')
    expect(attachmentNote(JSON.stringify([{ name: 'conversations/chat.md' }]))).toBe('见空间内 conversations/chat.md')
    expect(attachmentNote(JSON.stringify(['doc.pdf', 'image.png']))).toBe('见空间内 doc.pdf\n见空间内 image.png')
  })

  it('extracts peopleTalk properly combining text and attachment notes', () => {
    const rowWithBoth: MessageRow = {
      id: '1',
      chat_jid: 'web:1',
      content: 'Here is the plan',
      timestamp: null,
      is_from_me: 0,
      attachments: JSON.stringify([{ path: 'notes/plan.md' }]),
    }
    expect(peopleTalk(rowWithBoth)).toBe('Here is the plan\n见空间内 notes/plan.md')

    const rowOnlyAttachment: MessageRow = {
      id: '2',
      chat_jid: 'web:1',
      content: '',
      timestamp: null,
      is_from_me: 0,
      attachments: JSON.stringify([{ path: 'notes/plan.md' }]),
    }
    expect(peopleTalk(rowOnlyAttachment)).toBe('见空间内 notes/plan.md')
  })

  it('reads and compiles SQLite source directly when registered_groups table is omitted', () => {
    const customDbDir = join(demoRoot, 'custom-db')
    mkdirSync(customDbDir, { recursive: true })
    const customDbPath = join(customDbDir, 'messages.db')
    const db = new DatabaseSync(customDbPath)

    db.exec(`
      CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE messages (id TEXT PRIMARY KEY, chat_jid TEXT, content TEXT, timestamp TEXT, is_from_me INTEGER, attachments TEXT);
      INSERT INTO chats VALUES ('web:bare-chat', 'Bare Chat');
      INSERT INTO messages VALUES ('m1', 'web:bare-chat', 'Hello without registered groups', '2026-08-01T10:00:00Z', 0, null);
    `)
    db.close()

    const source = readSource(customDbPath)
    expect(source.chats).toHaveLength(1)
    expect(source.groups).toHaveLength(0)

    const chats = compileChats(source.chats, source.messages, source.groups)
    expect(chats).toHaveLength(1)
    expect(chats[0]?.folder).toBe('bare-chat')
    expect(chats[0]?.anomalies.some((a) => a.type === 'missing_group_registration')).toBe(true)
  })
})
