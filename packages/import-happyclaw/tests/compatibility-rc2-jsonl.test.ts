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

    // 1. Old rc.2 physical header format containing seedLength: 3
    const oldPhysicalHeader = {
      type: 'session',
      version: 0,
      id: sessionId,
      createdAt: 1700000000000,
      cwd: workspaceDir,
      delegationDepth: 0,
      seedLength: 3,
    }

    // 2. Events: 3 seed events (0..2) followed by 3 ordinary live events (3..5)
    const events = [
      {
        type: 'user/message',
        seq: 0,
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
        type: 'turn/start',
        seq: 1,
        time: 1700000002000,
        data: { turn: 1 },
      },
      {
        type: 'session/end-seed',
        seq: 2,
        time: 1700000003000,
        data: {},
      },
      {
        type: 'user/message',
        seq: 3,
        time: 1700000004000,
        surfaceOp: 'append',
        data: {
          id: 'msg_live_01',
          role: 'user',
          content: [{ type: 'text', text: 'Live user follow-up message' }],
          source: { kind: 'user' },
        },
      },
      {
        type: 'turn/start',
        seq: 4,
        time: 1700000005000,
        data: { turn: 2 },
      },
      {
        type: 'turn/end',
        seq: 5,
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

    const loaded = await ctx.sessionPersistence.load(sessionId)

    // 4. Assert logical SessionHeader properties in rc1
    expect(loaded.meta.version).toBe(0)
    expect(loaded.meta.id).toBe(sessionId)
    expect(loaded.meta.createdAt).toBe(1700000000000)
    expect(loaded.meta.cwd).toBe(workspaceDir)
    expect(loaded.meta.isSeeded).toBe(true)
    expect(loaded.inheritedEventCount).toBe(3)

    // 5. Assert all 6 events were decoded contiguously
    expect(loaded.events).toHaveLength(6)
    expect(loaded.events[0]?.type).toBe('user/message')
    expect(loaded.events[2]?.type).toBe('session/end-seed')
    expect(loaded.events[3]?.type).toBe('user/message')
    expect(loaded.events[5]?.type).toBe('turn/end')

    // 6. Restore through Session.fromRestore
    const restored = Session.fromRestore(
      sessionId,
      loaded.events,
      loaded.meta,
      loaded.inheritedEventCount,
    )

    expect(restored.header.isSeeded).toBe(true)
    expect(restored.inheritedEventCount).toBe(3)
    const snapshot = restored.snapshotEvents()
    // 6 decoded events + in-process session/end-seed marker
    expect(snapshot).toHaveLength(7)
    expect(snapshot.at(-1)?.type).toBe('session/end-seed')

    // 7. Verify ownEvents only returns the live events after the seed cut
    const own = restored.ownEvents()
    expect(own).toHaveLength(4)
    expect(own[0]?.seq).toBe(3)
    expect(own[0]?.type).toBe('user/message')
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
        type: 'user/message',
        seq: 0,
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

    const loaded = await ctx.sessionPersistence.load(sessionId)

    expect(loaded.meta.version).toBe(0)
    expect(loaded.meta.id).toBe(sessionId)
    expect(loaded.meta.isSeeded).toBe(false)
    expect(loaded.inheritedEventCount).toBe(0)
    expect(loaded.events).toHaveLength(1)

    const restored = Session.fromRestore(
      sessionId,
      loaded.events,
      loaded.meta,
      loaded.inheritedEventCount,
    )

    expect(restored.header.isSeeded).toBe(false)
    expect(restored.inheritedEventCount).toBe(0)
    expect(restored.ownEvents()).toHaveLength(2)
    expect(restored.snapshotEvents()).toHaveLength(2)
  })
})
