import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findPackageLib } from '../src/validate.js'

async function loadDshStack() {
  const cordisPath = findPackageLib('@deepseek-ai/cordis', 'lib/index.js')
  const sessionPath = findPackageLib('@deepseek-ai/dsh-session', 'lib/index.js')
  const jsonlPath = findPackageLib('@deepseek-ai/dsh-session-persistence-jsonl', 'lib/index.js')

  const cordisMod = await import(pathToFileURL(cordisPath).href)
  const sessionMod = await import(pathToFileURL(sessionPath).href)
  const jsonlMod = await import(pathToFileURL(jsonlPath).href)

  return {
    Context: cordisMod.Context,
    SessionStore: sessionMod.SessionStore ?? sessionMod.default,
    Session: sessionMod.Session,
    SessionId: sessionMod.SessionId,
    SessionLogOffset: sessionMod.SessionLogOffset,
    JsonlSessionPersistence: jsonlMod.JsonlSessionPersistence ?? jsonlMod.default,
  }
}

function projectKey(cwd: string): string {
  if (!cwd || cwd.length === 0) return '_no-cwd'
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

describe('rc1 SessionPersistenceJsonl backwards compatibility with old rc.2 JSONL', () => {
  let tempDir: string
  let sessionsRoot: string
  let workspaceDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'enkeep-test-rc2-compat-'))
    sessionsRoot = join(tempDir, 'sessions')
    workspaceDir = join(tempDir, 'workspace')
    mkdirSync(sessionsRoot, { recursive: true })
    mkdirSync(workspaceDir, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('loads old rc.2 JSONL containing physical seedLength and translates to logical isSeeded + inheritedEventCount', async () => {
    const { Context, SessionStore, Session, SessionId, JsonlSessionPersistence } = await loadDshStack()
    const sessionId = SessionId('ses_old_rc2_seeded_001')
    const projKey = projectKey(workspaceDir)
    const sessionDir = join(sessionsRoot, projKey, sessionId)
    mkdirSync(sessionDir, { recursive: true })

    // 1. Old rc.2 physical header format containing seedLength: 6
    const oldPhysicalHeader = {
      type: 'session',
      version: 0,
      id: sessionId,
      createdAt: 1700000000000,
      cwd: workspaceDir,
      delegationDepth: 0,
      seedLength: 6,
    }

    // 2. Events: seed turn 1 followed by session/end-seed and live turn 2
    const events = [
      {
        type: 'turn/start',
        seq: 0,
        time: 1700000000500,
        data: { turn: 1 },
      },
      {
        type: 'step/start',
        seq: 1,
        time: 1700000000600,
        data: { turn: 1, step: 1 },
      },
      {
        type: 'user/message',
        seq: 2,
        time: 1700000001000,
        surfaceOp: 'append',
        data: {
          id: 'msg_seed_01',
          role: 'user',
          content: [{ type: 'text', text: 'Hello from seeded history' }],
          source: { kind: 'user' },
        },
      },
      {
        type: 'step/end',
        seq: 3,
        time: 1700000001500,
        data: { turn: 1, step: 1 },
      },
      {
        type: 'turn/end',
        seq: 4,
        time: 1700000002000,
        data: { turn: 1, reason: { kind: 'completed' } },
      },
      {
        type: 'session/end-seed',
        seq: 5,
        time: 1700000003000,
        data: {},
      },
      {
        type: 'turn/start',
        seq: 6,
        time: 1700000004000,
        data: { turn: 2 },
      },
      {
        type: 'step/start',
        seq: 7,
        time: 1700000004100,
        data: { turn: 2, step: 1 },
      },
      {
        type: 'user/message',
        seq: 8,
        time: 1700000004200,
        surfaceOp: 'append',
        data: {
          id: 'msg_live_01',
          role: 'user',
          content: [{ type: 'text', text: 'Live user follow-up message' }],
          source: { kind: 'user' },
        },
      },
      {
        type: 'step/end',
        seq: 9,
        time: 1700000005000,
        data: { turn: 2, step: 1 },
      },
      {
        type: 'turn/end',
        seq: 10,
        time: 1700000006000,
        data: { turn: 2, reason: { kind: 'completed' } },
      },
    ]

    const jsonlContent = [
      JSON.stringify(oldPhysicalHeader),
      ...events.map((e) => JSON.stringify(e)),
    ].join('\n') + '\n'

    writeFileSync(join(sessionDir, 'session.jsonl'), jsonlContent, 'utf8')

    // 3. Load using official rc1 SessionPersistenceJsonl
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, {
      root: sessionsRoot,
      compression: 'none',
    })

    const handle = await ctx.sessionPersistence.open(sessionId, 'read')
    const { events: readEvents } = await handle.read()
    const header = handle.header
    const inheritedCount = handle.inheritedEventCount
    await handle.close()

    // 4. Assert logical SessionHeader properties in rc1
    expect(header.id).toBe(sessionId)
    expect(header.createdAt).toBe(1700000000000)
    expect(header.cwd).toBe(workspaceDir)
    expect(header.isSeeded).toBe(true)
    expect(inheritedCount).toBeGreaterThanOrEqual(6)

    // 5. Assert events were decoded
    expect(readEvents.length).toBeGreaterThan(0)
    expect(readEvents.some(e => e.type === 'user/message')).toBe(true)
    expect(readEvents.some(e => e.type === 'session/end-seed')).toBe(true)
    expect(readEvents.some(e => e.type === 'turn/end')).toBe(true)

    // 6. Restore through Session.fromRestore
    const restored = Session.fromRestore(
      sessionId,
      readEvents,
      header,
      inheritedCount,
    )

    expect(restored.header.isSeeded).toBe(true)
    const snapshot = restored.snapshotEvents()
    expect(snapshot.length).toBeGreaterThan(0)
    expect(snapshot.some(e => e.type === 'session/end-seed')).toBe(true)

    // 7. Verify ownEvents only returns the live events after the seed cut
    const own = restored.ownEvents()
    expect(own.length).toBeGreaterThan(0)
  })

  it('loads old rc.2 JSONL without physical seedLength and translates to isSeeded: false and inheritedEventCount: 0', async () => {
    const { Context, SessionStore, Session, SessionId, JsonlSessionPersistence } = await loadDshStack()
    const sessionId = SessionId('ses_old_rc2_unseeded_002')
    const projKey = projectKey(workspaceDir)
    const sessionDir = join(sessionsRoot, projKey, sessionId)
    mkdirSync(sessionDir, { recursive: true })

    // Unseeded old physical header without seedLength
    const oldPhysicalHeader = {
      type: 'session',
      version: 0,
      id: sessionId,
      createdAt: 1700000000000,
      cwd: workspaceDir,
      delegationDepth: 0,
    }

    const events = [
      {
        type: 'turn/start',
        seq: 0,
        time: 1700000000500,
        data: { turn: 1 },
      },
      {
        type: 'step/start',
        seq: 1,
        time: 1700000000600,
        data: { turn: 1, step: 1 },
      },
      {
        type: 'user/message',
        seq: 2,
        time: 1700000001000,
        surfaceOp: 'append',
        data: {
          id: 'msg_unseeded_01',
          role: 'user',
          content: [{ type: 'text', text: 'First user message in unseeded session' }],
          source: { kind: 'user' },
        },
      },
    ]

    const jsonlContent = [
      JSON.stringify(oldPhysicalHeader),
      ...events.map((e) => JSON.stringify(e)),
    ].join('\n') + '\n'

    writeFileSync(join(sessionDir, 'session.jsonl'), jsonlContent, 'utf8')

    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, {
      root: sessionsRoot,
      compression: 'none',
    })

    const handle = await ctx.sessionPersistence.open(sessionId, 'read')
    const { events: readEvents } = await handle.read()
    const header = handle.header
    const inheritedCount = handle.inheritedEventCount
    await handle.close()

    expect(header.id).toBe(sessionId)
    expect(header.isSeeded).toBe(false)
    expect(inheritedCount).toBe(0)
    expect(readEvents.length).toBeGreaterThanOrEqual(3)

    const restored = Session.fromRestore(
      sessionId,
      readEvents,
      header,
      inheritedCount,
    )

    expect(restored.header.isSeeded).toBe(false)
    expect(restored.inheritedEventCount).toBe(0)
    expect(restored.ownEvents().length).toBeGreaterThanOrEqual(3)
    expect(restored.snapshotEvents().length).toBeGreaterThanOrEqual(3)
  })
})
