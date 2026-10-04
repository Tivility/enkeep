import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { executeMultiUserMigration } from '../src/multi-user/orchestrator.js'
import { repairFixTimestamps, repairMaterializeSeeds } from '../src/multi-user/materialize.js'
import { runCli } from '../src/cli.js'

describe('Importer Seed Materialization & Repair Mode (S1)', () => {
  let tempDir: string
  let socketPath: string
  let server: net.Server
  let persistedSessions: Set<string>
  let checkCalls: Array<{ sessionId: string; folder?: string }>
  let importCalls: Array<{ sessionId: string; folder?: string; eventsCount: number }>

  function startFakeRuntimeDaemon(): Promise<string> {
    return new Promise((resolve) => {
      persistedSessions = new Set<string>()
      checkCalls = []
      importCalls = []

      server = net.createServer((socket) => {
        let buffer = ''
        socket.on('data', (chunk) => {
          buffer += chunk.toString('utf8')
          while (true) {
            const nl = buffer.indexOf('\n')
            if (nl === -1) break
            const line = buffer.slice(0, nl).trim()
            buffer = buffer.slice(nl + 1)
            if (!line) continue
            try {
              const req = JSON.parse(line)
              if (req.op === 'checkSessionArtifact') {
                checkCalls.push({ sessionId: req.sessionId, folder: req.workspaceFolder })
                const exists = persistedSessions.has(req.sessionId)
                socket.write(
                  JSON.stringify({
                    id: req.id,
                    op: 'checkSessionArtifact',
                    ok: true,
                    exists,
                    valid: exists,
                    eventCount: exists ? 5 : 0,
                  }) + '\n'
                )
              } else if (req.op === 'importSeed') {
                const count = Array.isArray(req.seed) ? req.seed.length : 0
                importCalls.push({ sessionId: req.sessionId, folder: req.workspaceFolder, eventsCount: count })
                persistedSessions.add(req.sessionId)
                socket.write(
                  JSON.stringify({
                    id: req.id,
                    op: 'importSeed',
                    ok: true,
                    sessionId: req.sessionId,
                    persisted: true,
                    eventsCount: count,
                    duplicate: false,
                  }) + '\n'
                )
              } else {
                socket.write(
                  JSON.stringify({
                    id: req.id,
                    op: req.op,
                    ok: false,
                    error: { code: 'UNKNOWN_OP', message: `Unknown op ${req.op}` },
                  }) + '\n'
                )
              }
            } catch (err: any) {
              socket.write(
                JSON.stringify({ ok: false, error: { code: 'PARSE_ERROR', message: String(err) } }) + '\n'
              )
            }
          }
        })
      })

      socketPath = join(tempDir, 'daemon.sock')
      server.listen(socketPath, () => {
        resolve(socketPath)
      })
    })
  }

  function setupSyntheticSourceDb(dir: string): string {
    const dbPath = join(dir, 'source-messages.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        display_name TEXT,
        role TEXT,
        status TEXT,
        created_at TEXT
      );
      CREATE TABLE chats (
        jid TEXT PRIMARY KEY,
        name TEXT
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        chat_jid TEXT NOT NULL,
        content TEXT,
        timestamp TEXT,
        is_from_me INTEGER,
        attachments TEXT
      );
      CREATE TABLE registered_groups (
        jid TEXT PRIMARY KEY,
        folder TEXT NOT NULL,
        name TEXT,
        execution_mode TEXT,
        is_home INTEGER,
        created_by TEXT
      );

      INSERT INTO users (id, username, display_name, role, status, created_at)
      VALUES
        ('user-admin-01', 'owner-user', 'Owner Admin', 'admin', 'active', '2026-09-01T00:00:00.000Z'),
        ('user-synth-01', 'synth-user', 'Synthetic User', 'member', 'active', '2026-09-01T00:00:00.000Z');

      INSERT INTO chats (jid, name)
      VALUES
        ('web:synth-chat-01', 'Synthetic Chat 1'),
        ('web:synth-chat-02', 'Synthetic Chat 2');

      INSERT INTO registered_groups (jid, folder, name, execution_mode, is_home, created_by)
      VALUES
        ('web:synth-chat-01', 'space-synth-01', 'Synthetic Chat 1', 'container', 1, 'user-synth-01'),
        ('web:synth-chat-02', 'space-synth-02', 'Synthetic Chat 2', 'container', 0, 'user-synth-01');

      INSERT INTO messages (id, chat_jid, content, timestamp, is_from_me, attachments)
      VALUES
        ('msg-s1-01', 'web:synth-chat-01', 'Hello synthetic agent', '2026-09-01T10:00:00.000Z', 0, NULL),
        ('msg-s1-02', 'web:synth-chat-01', 'Hello synthetic user', '2026-09-01T10:01:00.000Z', 1, NULL),
        ('msg-s2-01', 'web:synth-chat-02', 'Another synthetic query', '2026-09-01T10:02:00.000Z', 0, NULL);
    `)
    db.close()
    return dbPath
  }

  function setupSyntheticPlatformDb(dir: string): string {
    const dbPath = join(dir, 'platform.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        password_hash TEXT,
        role TEXT,
        status TEXT,
        display_name TEXT,
        must_change_password INTEGER,
        created_at TEXT,
        updated_at TEXT
      );
      CREATE TABLE spaces (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT,
        folder TEXT NOT NULL,
        execution_mode TEXT,
        status TEXT,
        canonical_session_id TEXT,
        created_at TEXT,
        updated_at TEXT
      );
      CREATE TABLE session_routes (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        channel TEXT,
        account_id TEXT,
        native_context_id TEXT,
        peer_id TEXT,
        dsh_session_id TEXT,
        execution_mode TEXT,
        created_at TEXT,
        updated_at TEXT,
        status TEXT,
        title TEXT
      );
      CREATE TABLE web_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT,
        route_key TEXT,
        created_at TEXT
      );

      INSERT INTO users (id, username, password_hash, role, status, display_name, must_change_password, created_at, updated_at)
      VALUES
        ('user-synth-01', 'synth-user', 'hash', 'user', 'active', 'Synthetic User', 1, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');

      INSERT INTO spaces (id, user_id, name, folder, execution_mode, status, created_at, updated_at)
      VALUES
        ('spc_00000000000000000000000000000001', 'user-synth-01', 'Space 1', 'space-synth-01', 'container', 'active', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'),
        ('spc_00000000000000000000000000000002', 'user-synth-01', 'Space 2', 'space-synth-02', 'container', 'active', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');

      INSERT INTO session_routes (id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, created_at, updated_at, status, title)
      VALUES
        ('import-00000000000000000000000000000001', 'spc_00000000000000000000000000000001', 'user-synth-01', 'web', 'default', 'web:synth-chat-01', 'peer-01', 'import-00000000000000000000000000000001', 'container', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 'active', 'Chat 1'),
        ('import-00000000000000000000000000000002', 'spc_00000000000000000000000000000002', 'user-synth-01', 'web', 'default', 'web:synth-chat-02', 'peer-02', 'import-00000000000000000000000000000002', 'container', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 'active', 'Chat 2');

      INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, created_at)
      VALUES
        ('msg-p1-01', 'import-00000000000000000000000000000001', 'user-synth-01', 'user', 'Question 1', 'delivered', 'web:default:user-synth-01:import-00000000000000000000000000000001', '2026-09-01T10:00:00.000Z'),
        ('msg-p1-02', 'import-00000000000000000000000000000001', 'user-synth-01', 'assistant', 'Answer 1', 'delivered', 'web:default:user-synth-01:import-00000000000000000000000000000001', '2026-09-01T10:01:00.000Z'),
        ('msg-p2-01', 'import-00000000000000000000000000000002', 'user-synth-01', 'user', 'Question 2', 'delivered', 'web:default:user-synth-01:import-00000000000000000000000000000002', '2026-09-01T10:02:00.000Z');
    `)
    db.close()
    return dbPath
  }

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'enkeep-test-seed-'))
    await startFakeRuntimeDaemon()
  })

  afterEach(async () => {
    if (server) {
      await new Promise<void>((res) => server.close(() => res()))
    }
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('multi-user migration materializes each imported session via fake runtime daemon endpoint', async () => {
    const srcDb = setupSyntheticSourceDb(tempDir)
    const targetDb = setupSyntheticPlatformDb(tempDir)

    const result = await executeMultiUserMigration({
      sourcePath: srcDb,
      targetDbPath: targetDb,
      select: { allExceptOwner: true },
      runtimeSocketPath: socketPath,
      dryRun: false,
    })

    expect(result.success).toBe(true)
    // Both sessions should be checked and imported
    expect(checkCalls.length).toBeGreaterThanOrEqual(2)
    expect(importCalls.length).toBeGreaterThanOrEqual(2)
    expect(persistedSessions.size).toBeGreaterThanOrEqual(2)

    const prevImportCount = importCalls.length

    // Idempotency check: run migration again
    const rerunResult = await executeMultiUserMigration({
      sourcePath: srcDb,
      targetDbPath: targetDb,
      select: { allExceptOwner: true },
      runtimeSocketPath: socketPath,
      dryRun: false,
    })

    expect(rerunResult.success).toBe(true)
    // checkSessionArtifact was called again, but importSeed was skipped because sessions already exist!
    expect(importCalls.length).toBe(prevImportCount)
  })

  it('repair mode dry-run lists per-session status (OK/MISSING) with zero side effects', async () => {
    const platformDb = setupSyntheticPlatformDb(tempDir)

    // Initially, persistedSessions in fake runtime is empty.
    // 1. Dry run should report all sessions as MISSING
    const dryRunResults = await repairMaterializeSeeds({
      targetDbPath: platformDb,
      user: 'synth-user',
      runtimeSocketPath: socketPath,
      dryRun: true,
    })

    expect(dryRunResults).toHaveLength(1)
    const userRes = dryRunResults[0]!
    expect(userRes.username).toBe('synth-user')
    expect(userRes.sessions).toHaveLength(2)

    for (const ses of userRes.sessions) {
      expect(ses.status).toBe('MISSING')
    }
    // No side effects: importSeed was NOT called!
    expect(importCalls).toHaveLength(0)
    expect(persistedSessions.size).toBe(0)

    // 2. Pre-populate one session as existing in daemon
    persistedSessions.add('import-00000000000000000000000000000001')

    const dryRunResults2 = await repairMaterializeSeeds({
      targetDbPath: platformDb,
      user: 'synth-user',
      runtimeSocketPath: socketPath,
      dryRun: true,
    })

    const s1 = dryRunResults2[0]!.sessions.find((s) => s.sessionId === 'import-00000000000000000000000000000001')
    const s2 = dryRunResults2[0]!.sessions.find((s) => s.sessionId === 'import-00000000000000000000000000000002')

    expect(s1?.status).toBe('OK')
    expect(s2?.status).toBe('MISSING')
    // Still zero import calls in dry run
    expect(importCalls).toHaveLength(0)
  })

  it('repair mode live rebuilds seeds from platform DB history and materializes missing sessions', async () => {
    const platformDb = setupSyntheticPlatformDb(tempDir)

    // Initially empty daemon: live repair should materialize all 2 sessions
    const liveResults = await repairMaterializeSeeds({
      targetDbPath: platformDb,
      user: 'synth-user',
      runtimeSocketPath: socketPath,
      dryRun: false,
    })

    expect(liveResults).toHaveLength(1)
    expect(liveResults[0]!.sessions).toHaveLength(2)
    for (const ses of liveResults[0]!.sessions) {
      expect(ses.status).toBe('MATERIALIZED')
    }

    expect(importCalls).toHaveLength(2)
    expect(persistedSessions.size).toBe(2)

    // Subsequent dry-run should now report OK for both sessions
    const verifyDryRun = await repairMaterializeSeeds({
      targetDbPath: platformDb,
      user: 'synth-user',
      runtimeSocketPath: socketPath,
      dryRun: true,
    })

    for (const ses of verifyDryRun[0]!.sessions) {
      expect(ses.status).toBe('OK')
    }
    // No additional import calls
    expect(importCalls).toHaveLength(2)
  })

  it('CLI --materialize-seeds --user <name> [--dry-run] runs successfully and lists status', async () => {
    const platformDb = setupSyntheticPlatformDb(tempDir)

    // 1. Dry run via CLI
    let stdoutBuffer = ''
    const origLog = console.log
    console.log = (msg: string) => {
      stdoutBuffer += msg + '\n'
    }

    try {
      const exitCodeDry = await runCli([
        'node',
        'cli.js',
        '--materialize-seeds',
        '--user',
        'synth-user',
        '--target-db',
        platformDb,
        '--runtime-socket',
        socketPath,
        '--dry-run',
        '--json',
      ])

      expect(exitCodeDry).toBe(0)
      const parsed = JSON.parse(stdoutBuffer)
      expect(parsed.success).toBe(true)
      expect(parsed.dryRun).toBe(true)
      expect(parsed.results[0].sessions[0].status).toBe('MISSING')
      expect(parsed.results[0].sessions[1].status).toBe('MISSING')
    } finally {
      console.log = origLog
    }

    // 2. Live repair via CLI
    const exitCodeLive = await runCli([
      'node',
      'cli.js',
      '--materialize-seeds',
      '--user',
      'synth-user',
      '--target-db',
      platformDb,
      '--runtime-socket',
      socketPath,
    ])
    expect(exitCodeLive).toBe(0)
    expect(persistedSessions.size).toBe(2)

    // 3. Dry run again via CLI should report OK
    stdoutBuffer = ''
    console.log = (msg: string) => {
      stdoutBuffer += msg + '\n'
    }

    try {
      const exitCodeVerify = await runCli([
        'node',
        'cli.js',
        '--materialize-seeds',
        '--user',
        'synth-user',
        '--target-db',
        platformDb,
        '--runtime-socket',
        socketPath,
        '--dry-run',
        '--json',
      ])

      expect(exitCodeVerify).toBe(0)
      const parsed = JSON.parse(stdoutBuffer)
      expect(parsed.results[0].sessions[0].status).toBe('OK')
      expect(parsed.results[0].sessions[1].status).toBe('OK')
    } finally {
      console.log = origLog
    }
  })

  it('supports disk session path fallback when runtimeSessionsDir is provided', async () => {
    const platformDb = setupSyntheticPlatformDb(tempDir)
    const sessionsDir = join(tempDir, 'sessions')
    mkdirSync(sessionsDir, { recursive: true })

    // Dry-run should report MISSING
    const dryRun = await repairMaterializeSeeds({
      targetDbPath: platformDb,
      user: 'synth-user',
      runtimeSessionsDir: sessionsDir,
      dryRun: true,
    })
    expect(dryRun[0]!.sessions[0]!.status).toBe('MISSING')

    // Live run should write session.jsonl files
    const live = await repairMaterializeSeeds({
      targetDbPath: platformDb,
      user: 'synth-user',
      runtimeSessionsDir: sessionsDir,
      dryRun: false,
    })
    expect(live[0]!.sessions[0]!.status).toBe('MATERIALIZED')

    // Verify session.jsonl file on disk
    const sessionFile = join(sessionsDir, 'space-synth-01', 'import-00000000000000000000000000000001', 'session.jsonl')
    expect(existsSync(sessionFile)).toBe(true)
    const content = readFileSync(sessionFile, 'utf8')
    expect(content).toContain('"type":"session"')
    expect(content).toContain('Question 1')

    // Second run should be OK
    const rerun = await repairMaterializeSeeds({
      targetDbPath: platformDb,
      user: 'synth-user',
      runtimeSessionsDir: sessionsDir,
      dryRun: true,
    })
    expect(rerun[0]!.sessions[0]!.status).toBe('OK')
  })

  it('scrambled ids still produce chronological seed', async () => {
    const platformDb = join(tempDir, 'platform-scrambled.db')
    const db = new DatabaseSync(platformDb)
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT);
      CREATE TABLE spaces (id TEXT PRIMARY KEY, user_id TEXT, folder TEXT);
      CREATE TABLE session_routes (id TEXT PRIMARY KEY, space_id TEXT, user_id TEXT, native_context_id TEXT, dsh_session_id TEXT);
      CREATE TABLE web_messages (id TEXT PRIMARY KEY, session_id TEXT, user_id TEXT, role TEXT, content TEXT, created_at TEXT);
      CREATE TABLE fixed_import_provenance (id TEXT PRIMARY KEY, user_id TEXT, source_chat_jid TEXT, source_message_id TEXT, target_message_id TEXT, target_event_id TEXT, created_at TEXT);

      INSERT INTO users VALUES ('user-synth-01', 'synth-user');
      INSERT INTO spaces VALUES ('spc_0000000000000001', 'user-synth-01', 'space-scrambled');
      INSERT INTO session_routes VALUES ('import-ses-scrambled', 'spc_0000000000000001', 'user-synth-01', 'web:synth-chat', 'import-ses-scrambled');

      -- Insert with scrambled hashed IDs
      -- msg1 & msg2 have identical timestamps. If sorted by hashed ID, 'msg_hpc_aaa' comes before 'msg_hpc_zzz'.
      -- But msg1 is user turn (provenance rowid 1), msg2 is assistant turn (provenance rowid 2).
      INSERT INTO web_messages VALUES
        ('msg_hpc_zzz', 'import-ses-scrambled', 'user-synth-01', 'user', 'Turn 1 user', '2026-09-01T10:00:00.000Z'),
        ('msg_hpc_aaa', 'import-ses-scrambled', 'user-synth-01', 'assistant', 'Turn 1 assistant', '2026-09-01T10:00:00.000Z'),
        ('msg_hpc_mmm', 'import-ses-scrambled', 'user-synth-01', 'user', 'Turn 2 user', '2026-09-01T10:01:00.000Z'),
        ('msg_post_01', 'import-ses-scrambled', 'user-synth-01', 'assistant', 'Turn 2 assistant post-import', '2026-09-01T10:02:00.000Z');

      INSERT INTO fixed_import_provenance (id, user_id, source_chat_jid, source_message_id, target_message_id) VALUES
        ('prov-1', 'user-synth-01', 'web:synth-chat', 'm1', 'msg_hpc_zzz'),
        ('prov-2', 'user-synth-01', 'web:synth-chat', 'm2', 'msg_hpc_aaa'),
        ('prov-3', 'user-synth-01', 'web:synth-chat', 'm3', 'msg_hpc_mmm');
      -- Note: msg_post_01 has no provenance (created after import)
    `)
    db.close()

    const sessionsDir = join(tempDir, 'sessions-scrambled')
    mkdirSync(sessionsDir, { recursive: true })

    await repairMaterializeSeeds({
      targetDbPath: platformDb,
      user: 'synth-user',
      runtimeSessionsDir: sessionsDir,
      dryRun: false,
    })

    const sessionFile = join(sessionsDir, 'space-scrambled', 'import-ses-scrambled', 'session.jsonl')
    expect(existsSync(sessionFile)).toBe(true)

    const lines = readFileSync(sessionFile, 'utf8').trim().split('\n')
    const events = lines.slice(1).map((l) => JSON.parse(l)) // skip header

    const textMessages = events
      .filter((e) => e.type === 'user/message' || e.type === 'assistant/message')
      .map((e) => {
        if (e.type === 'user/message') return { role: 'user', text: e.data.content[0].text }
        return { role: 'assistant', text: e.data.message.content[0].text }
      })

    expect(textMessages).toEqual([
      { role: 'user', text: 'Turn 1 user' },
      { role: 'assistant', text: 'Turn 1 assistant' },
      { role: 'user', text: 'Turn 2 user' },
      { role: 'assistant', text: 'Turn 2 assistant post-import' },
    ])
  })

  it('fix-timestamps idempotent', async () => {
    const srcDbPath = join(tempDir, 'src-messages.db')
    const srcDb = new DatabaseSync(srcDbPath)
    srcDb.exec(`
      CREATE TABLE messages (id TEXT PRIMARY KEY, chat_jid TEXT, timestamp TEXT);
      INSERT INTO messages VALUES
        ('m1', 'web:synth-chat-01', '2026-08-01T12:00:00.000Z'),
        ('m2', 'web:synth-chat-01', '2026-08-01T12:01:00.000Z');
    `)
    srcDb.close()

    const targetDbPath = join(tempDir, 'target-platform.db')
    const targetDb = new DatabaseSync(targetDbPath)
    targetDb.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT);
      CREATE TABLE web_messages (id TEXT PRIMARY KEY, created_at TEXT);
      CREATE TABLE web_events (id TEXT PRIMARY KEY, created_at TEXT);
      CREATE TABLE fixed_import_provenance (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        source_chat_jid TEXT,
        source_message_id TEXT,
        target_message_id TEXT,
        target_event_id TEXT
      );

      INSERT INTO users VALUES ('user-synth-01', 'synth-user');
      -- Initially with batch time
      INSERT INTO web_messages VALUES
        ('target_msg_1', '2026-09-24T22:29:45.291Z'),
        ('target_msg_2', '2026-09-24T22:29:45.291Z');
      INSERT INTO web_events VALUES
        ('target_ev_1', '2026-09-24T22:29:45.291Z'),
        ('target_ev_2', '2026-09-24T22:29:45.291Z');
      INSERT INTO fixed_import_provenance VALUES
        ('prov-1', 'user-synth-01', 'web:synth-chat-01', 'm1', 'target_msg_1', 'target_ev_1'),
        ('prov-2', 'user-synth-01', 'web:synth-chat-01', 'm2', 'target_msg_2', 'target_ev_2');
    `)
    targetDb.close()

    // 1. Dry run prints counts and does not mutate
    const dryRunRes = await repairFixTimestamps({
      targetDbPath,
      sourcePath: srcDbPath,
      user: 'synth-user',
      dryRun: true,
    })
    expect(dryRunRes.messagesUpdated).toBe(2)
    expect(dryRunRes.eventsUpdated).toBe(2)
    expect(dryRunRes.dryRun).toBe(true)

    const checkDb1 = new DatabaseSync(targetDbPath, { readOnly: true })
    const msg1Before = checkDb1.prepare("SELECT created_at FROM web_messages WHERE id = 'target_msg_1'").get() as any
    expect(msg1Before.created_at).toBe('2026-09-24T22:29:45.291Z')
    checkDb1.close()

    // 2. Live run updates timestamps
    const liveRunRes = await repairFixTimestamps({
      targetDbPath,
      sourcePath: srcDbPath,
      user: 'synth-user',
      dryRun: false,
    })
    expect(liveRunRes.messagesUpdated).toBe(2)
    expect(liveRunRes.eventsUpdated).toBe(2)

    const checkDb2 = new DatabaseSync(targetDbPath, { readOnly: true })
    const msg1After = checkDb2.prepare("SELECT created_at FROM web_messages WHERE id = 'target_msg_1'").get() as any
    const ev1After = checkDb2.prepare("SELECT created_at FROM web_events WHERE id = 'target_ev_1'").get() as any
    expect(msg1After.created_at).toBe('2026-08-01T12:00:00.000Z')
    expect(ev1After.created_at).toBe('2026-08-01T12:00:00.000Z')
    checkDb2.close()

    // 3. Subsequent run reports 0 updates (idempotent)
    const dryRunAgain = await repairFixTimestamps({
      targetDbPath,
      sourcePath: srcDbPath,
      user: 'synth-user',
      dryRun: true,
    })
    expect(dryRunAgain.messagesUpdated).toBe(0)
    expect(dryRunAgain.eventsUpdated).toBe(0)

    const liveRunAgain = await repairFixTimestamps({
      targetDbPath,
      sourcePath: srcDbPath,
      user: 'synth-user',
      dryRun: false,
    })
    expect(liveRunAgain.messagesUpdated).toBe(0)
    expect(liveRunAgain.eventsUpdated).toBe(0)
  })

  it('rebuild refuses with active turn', async () => {
    const platformDb = join(tempDir, 'platform-active-turn.db')
    const db = new DatabaseSync(platformDb)
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT);
      CREATE TABLE spaces (id TEXT PRIMARY KEY, user_id TEXT, folder TEXT);
      CREATE TABLE session_routes (id TEXT PRIMARY KEY, space_id TEXT, user_id TEXT, native_context_id TEXT, dsh_session_id TEXT);
      CREATE TABLE web_messages (id TEXT PRIMARY KEY, session_id TEXT, user_id TEXT, role TEXT, content TEXT, created_at TEXT);
      CREATE TABLE turn_runs (id TEXT PRIMARY KEY, route_id TEXT, status TEXT);

      INSERT INTO users VALUES ('user-synth-01', 'synth-user');
      INSERT INTO spaces VALUES ('spc_0000000000000001', 'user-synth-01', 'space-turn');
      INSERT INTO session_routes VALUES ('import-ses-turn', 'spc_0000000000000001', 'user-synth-01', 'web:synth-chat', 'import-ses-turn');
      INSERT INTO web_messages VALUES ('m-1', 'import-ses-turn', 'user-synth-01', 'user', 'Hello', '2026-09-01T10:00:00.000Z');
      INSERT INTO turn_runs VALUES ('tr-1', 'import-ses-turn', 'running');
    `)
    db.close()

    const sessionsDir = join(tempDir, 'sessions-active-turn')
    mkdirSync(sessionsDir, { recursive: true })

    // Refuses when turn is running
    await expect(
      repairMaterializeSeeds({
        targetDbPath: platformDb,
        user: 'synth-user',
        runtimeSessionsDir: sessionsDir,
        rebuildSeeds: true,
      })
    ).rejects.toThrow(/active or queued turn/)

    // Update to queued - still refuses
    const db2 = new DatabaseSync(platformDb)
    db2.prepare("UPDATE turn_runs SET status = 'queued' WHERE id = 'tr-1'").run()
    db2.close()

    await expect(
      repairMaterializeSeeds({
        targetDbPath: platformDb,
        user: 'synth-user',
        runtimeSessionsDir: sessionsDir,
        rebuildSeeds: true,
      })
    ).rejects.toThrow(/active or queued turn/)

    // Update to completed - successfully rebuilds
    const db3 = new DatabaseSync(platformDb)
    db3.prepare("UPDATE turn_runs SET status = 'completed' WHERE id = 'tr-1'").run()
    db3.close()

    const results = await repairMaterializeSeeds({
      targetDbPath: platformDb,
      user: 'synth-user',
      runtimeSessionsDir: sessionsDir,
      rebuildSeeds: true,
    })
    expect(results).toHaveLength(1)
    expect(results[0]!.sessions[0]!.status).toBe('MATERIALIZED')

    const sessionFile = join(sessionsDir, 'space-turn', 'import-ses-turn', 'session.jsonl')
    expect(existsSync(sessionFile)).toBe(true)

    // Running rebuild again forces re-materialization even if session file exists
    const resultsAgain = await repairMaterializeSeeds({
      targetDbPath: platformDb,
      user: 'synth-user',
      runtimeSessionsDir: sessionsDir,
      rebuildSeeds: true,
    })
    expect(resultsAgain[0]!.sessions[0]!.status).toBe('MATERIALIZED')
  })
})
