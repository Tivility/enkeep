import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  importFixedHappyClawFixture,
  sessionIdFor,
  type SeedEvent,
} from '../src/index.js'
import { getSessionModule } from '../src/validate.js'

describe('DSH Seed Invariants with @deepseek-ai/dsh-session Session.create', () => {
  let demoRoot: string
  let targetDir: string

  beforeEach(() => {
    demoRoot = mkdtempSync(join(tmpdir(), 'enkeep-demo-test-invariants-'))
    targetDir = join(demoRoot, 'output')
  })

  afterEach(() => {
    if (existsSync(demoRoot)) {
      rmSync(demoRoot, { recursive: true, force: true })
    }
  })

  it('validates that compiled Alice & Bob seeds pass Session.create invariant engine', async () => {
    const result = await importFixedHappyClawFixture({
      targetDir,
      demoRoot,
      userId: 'alice',
      deterministicCreatedAt: '2026-08-01T12:00:00.000Z',
    })

    const { Session, SessionId } = await getSessionModule()

    for (const chat of result.chats) {
      const sid = SessionId(chat.sessionId)
      // Session.create will throw if any invariant fails
      const session = Session.create(sid, chat.seed) as {
        snapshotEvents: () => SeedEvent[]
        header: { version: number; id: string; createdAt: number; isSeeded: boolean }
        deriveMessages: () => Array<{
          role: string
          content: Array<{ type: string; text?: string }>
          source: { kind: string; provider?: string; model?: string }
        }>
      }

      const events = session.snapshotEvents()
      expect(events).toBeDefined()
      expect(events.length).toBeGreaterThan(0)
      expect(events.length).toBe(chat.seed.length)
      expect(events.at(-1)?.type).toBe('session/end-seed')
      expect(chat.seed.at(-1)?.type).toBe('session/end-seed')

      // Verify derived messages
      const derived = session.deriveMessages()
      expect(derived.length).toBeGreaterThan(0)

      const userMessages = derived.filter((m) => m.role === 'user')
      const assistantMessages = derived.filter((m) => m.role === 'assistant')

      if (chat.chatJid === 'web:alice-workspace-jid-001') {
        // Assert >= 20 dialogue rounds (both user messages >= 20 and assistant messages >= 20)
        expect(userMessages.length).toBeGreaterThanOrEqual(20)
        expect(assistantMessages.length).toBeGreaterThanOrEqual(20)
        expect(chat.report.sourceMessages).toBe(48)
        expect(chat.report.importedPeopleTalk).toBe(46)
      }

      for (const msg of derived) {
        if (msg.role === 'assistant') {
          expect(msg.source).toEqual({
            kind: 'model',
            provider: 'import',
            model: 'happyclaw',
          })
        } else if (msg.role === 'user') {
          expect(msg.source).toEqual({
            kind: 'user',
          })
        }
      }
    }
  })

  it('resumes session history with Session.create and appends follow-up user turn', async () => {
    const result = await importFixedHappyClawFixture({
      targetDir,
      demoRoot,
      userId: 'alice',
      deterministicCreatedAt: '2026-08-01T12:00:00.000Z',
    })

    const { Session, SessionId } = await getSessionModule()
    const aliceChat = result.chats.find((c) => c.chatJid === 'web:alice-workspace-jid-001')!
    const sid = SessionId(aliceChat.sessionId)

    // 1. Resumes imported session from seed
    const session = Session.create(sid, aliceChat.seed) as {
      snapshotEvents: () => SeedEvent[]
      append: (type: string, data: unknown, opts?: { surfaceOp?: string }) => SeedEvent
      deriveMessages: () => Array<{ role: string; content: Array<{ type: string; text?: string }> }>
    }

    const initialEvents = session.snapshotEvents()
    const initialEventCount = initialEvents.length
    expect(initialEventCount).toBe(aliceChat.seed.length)
    expect(initialEvents.at(-1)?.type).toBe('session/end-seed')

    // Verify derived history before resume has >= 20 user & >= 20 assistant messages
    const initialDerived = session.deriveMessages()
    const initialUserCount = initialDerived.filter((m) => m.role === 'user').length
    const initialAssistantCount = initialDerived.filter((m) => m.role === 'assistant').length
    expect(initialUserCount).toBeGreaterThanOrEqual(20)
    expect(initialAssistantCount).toBeGreaterThanOrEqual(20)

    // 2. Continues with follow-up turn in runtime
    const followUp = session.append('user/message', {
      id: 'followup-user-msg-001',
      role: 'user',
      content: [{ type: 'text', text: '继续执行后续的集成阶段。' }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })

    const updatedEvents = session.snapshotEvents()
    expect(followUp.seq).toBe(initialEventCount)
    expect(updatedEvents.length).toBe(initialEventCount + 1)
    expect(updatedEvents.at(-1)?.type).toBe('user/message')

    // 3. Verify updated message history includes follow-up
    const updatedMessages = session.deriveMessages()
    const lastMsg = updatedMessages.at(-1)
    expect(lastMsg?.role).toBe('user')
    expect(lastMsg?.content[0]?.text).toBe('继续执行后续的集成阶段。')
    expect(updatedMessages.filter((m) => m.role === 'user').length).toBe(initialUserCount + 1)
  })

  it('verifies seed events have strictly contiguous sequence numbers, >= 20 user+assistant rounds, and valid envelopes', async () => {
    const result = await importFixedHappyClawFixture({
      targetDir,
      demoRoot,
      userId: 'alice',
      deterministicCreatedAt: '2026-08-01T12:00:00.000Z',
    })

    const aliceSid = sessionIdFor('web:alice-workspace-jid-001')
    const seedPath = join(targetDir, 'seeds', `${aliceSid}.json`)
    const seed: SeedEvent[] = JSON.parse(readFileSync(seedPath, 'utf8'))

    expect(seed.length).toBeGreaterThan(100)

    const userSeedEvents = seed.filter((e) => e.type === 'user/message')
    const assistantSeedEvents = seed.filter((e) => e.type === 'assistant/message')
    const turnStartEvents = seed.filter((e) => e.type === 'turn/start')
    const turnEndEvents = seed.filter((e) => e.type === 'turn/end')

    // Must have >= 20 user messages and >= 20 assistant messages/turns (rounds)
    expect(userSeedEvents.length).toBeGreaterThanOrEqual(20)
    expect(assistantSeedEvents.length).toBeGreaterThanOrEqual(20)
    expect(turnStartEvents.length).toBeGreaterThanOrEqual(20)
    expect(turnEndEvents.length).toBeGreaterThanOrEqual(20)

    // Sequence numbers must be strictly contiguous from 0
    for (let i = 0; i < seed.length; i += 1) {
      const event = seed[i]!
      expect(event.seq).toBe(i)
      expect(typeof event.time).toBe('number')
      expect(Number.isSafeInteger(event.time)).toBe(true)
      expect(event.time).toBeGreaterThanOrEqual(0)
      expect(event.data).toBeDefined()

      if (event.type === 'user/message' || event.type === 'assistant/message') {
        expect(event.surfaceOp).toBe('append')
      }
    }
  })

  it('verifies attachment references are relative notes without absolute path leaks', async () => {
    const result = await importFixedHappyClawFixture({
      targetDir,
      demoRoot,
      userId: 'alice',
      deterministicCreatedAt: '2026-08-01T12:00:00.000Z',
    })

    const aliceSid = sessionIdFor('web:alice-workspace-jid-001')
    const seedPath = join(targetDir, 'seeds', `${aliceSid}.json`)
    const seed: SeedEvent[] = JSON.parse(readFileSync(seedPath, 'utf8'))

    const textPayloads: string[] = []
    for (const event of seed) {
      if (event.type === 'user/message') {
        const content = (event.data['content'] as Array<{ text?: string }>) ?? []
        for (const block of content) {
          if (block.text) textPayloads.push(block.text)
        }
      }
    }

    const attachmentLines = textPayloads.filter((t) => t.includes('见空间内'))
    expect(attachmentLines.length).toBeGreaterThan(0)

    for (const text of attachmentLines) {
      // Must not leak absolute machine paths
      expect(text).not.toContain('/Users/')
      expect(text).not.toContain('/home/')
      expect(text).not.toContain('happyclaw/data')
      // Must use relative path notes
      expect(text).toMatch(/见空间内 (notes\/|conversations\/|artifacts\/|附件)/)
    }
  })
})
