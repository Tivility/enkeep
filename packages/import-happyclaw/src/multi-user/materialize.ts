import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { compileSeed, parseTimestamp } from '../seed.js'
import { validateSourceFile } from '../guard.js'
import type { MessageRow, SeedEvent } from '../types.js'

export interface SessionMaterializeItem {
  readonly sessionId: string
  readonly folder?: string
  readonly seed: readonly SeedEvent[]
  readonly chatJid?: string
}

export interface SessionMaterializeResult {
  readonly sessionId: string
  readonly folder?: string
  readonly chatJid?: string
  readonly status: 'OK' | 'MISSING' | 'MATERIALIZED'
}

export class RuntimeDaemonClient {
  private socket: net.Socket | null = null
  private buffer = ''
  private pending: Array<{ id: string; resolve: (val: any) => void; reject: (err: any) => void }> = []
  private seq = 0

  constructor(private readonly socketPath: string) {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const isTcp = this.socketPath.includes(':') || /^\d+$/.test(this.socketPath)
      this.socket = isTcp
        ? net.connect(Number(this.socketPath.split(':').pop()), this.socketPath.split(':')[0] || '127.0.0.1')
        : net.connect(this.socketPath)
      this.socket.on('connect', () => resolve())
      this.socket.on('error', (err) => reject(err))
      this.socket.on('data', (chunk) => {
        this.buffer += chunk.toString('utf8')
        while (true) {
          const nl = this.buffer.indexOf('\n')
          if (nl === -1) break
          const line = this.buffer.slice(0, nl).trim()
          this.buffer = this.buffer.slice(nl + 1)
          if (!line) continue
          try {
            const msg = JSON.parse(line)
            const idx = this.pending.findIndex((p) => p.id === msg.id)
            if (idx !== -1) {
              const [p] = this.pending.splice(idx, 1)
              if (msg.ok) p.resolve(msg)
              else p.reject(new Error(msg.error?.message || `RPC ${msg.op} failed`))
            }
          } catch {}
        }
      })
    })
  }

  async call(op: string, payload: Record<string, unknown>): Promise<any> {
    if (!this.socket) await this.connect()
    const id = `req_${++this.seq}`
    return new Promise((resolve, reject) => {
      this.pending.push({ id, resolve, reject })
      this.socket!.write(JSON.stringify({ id, op, ...payload }) + '\n')
    })
  }

  close(): void {
    if (this.socket) {
      this.socket.destroy()
      this.socket = null
    }
  }
}

export async function materializeSessions(
  items: readonly SessionMaterializeItem[],
  options: { runtimeSocketPath?: string; runtimeSessionsDir?: string; dryRun?: boolean; forceRebuild?: boolean }
): Promise<SessionMaterializeResult[]> {
  const client = options.runtimeSocketPath ? new RuntimeDaemonClient(options.runtimeSocketPath) : null
  try {
    const results: SessionMaterializeResult[] = []
    for (const item of items) {
      let isOk = false
      if (!options.forceRebuild) {
        if (client) {
          const check = await client.call('checkSessionArtifact', {
            sessionId: item.sessionId,
            workspaceFolder: item.folder,
          })
          isOk = Boolean(check.exists && check.valid)
        } else if (options.runtimeSessionsDir) {
          const sessionFile = join(options.runtimeSessionsDir, item.folder || 'default', item.sessionId, 'session.jsonl')
          isOk = existsSync(sessionFile)
        }
      }

      if (isOk) {
        results.push({ sessionId: item.sessionId, folder: item.folder, chatJid: item.chatJid, status: 'OK' })
      } else if (options.dryRun) {
        results.push({ sessionId: item.sessionId, folder: item.folder, chatJid: item.chatJid, status: 'MISSING' })
      } else {
        if (client) {
          await client.call('importSeed', {
            sessionId: item.sessionId,
            seed: item.seed,
            workspaceFolder: item.folder,
          })
        } else if (options.runtimeSessionsDir) {
          const dir = join(options.runtimeSessionsDir, item.folder || 'default', item.sessionId)
          mkdirSync(dir, { recursive: true })
          const header = { type: 'session', version: 0, id: item.sessionId, createdAt: item.seed[0]?.time ?? Date.now(), cwd: `/home/dsh/spaces/${item.folder || 'default'}`, delegationDepth: 0, seedLength: item.seed.length }
          writeFileSync(join(dir, 'session.jsonl'), [JSON.stringify(header), ...item.seed.map((e) => JSON.stringify(e))].join('\n') + '\n', 'utf8')
        }
        results.push({ sessionId: item.sessionId, folder: item.folder, chatJid: item.chatJid, status: 'MATERIALIZED' })
      }
    }
    return results
  } finally {
    client?.close()
  }
}

export interface RepairMaterializeOptions {
  readonly targetDbPath: string
  readonly user?: string
  readonly users?: readonly string[]
  readonly runtimeSocketPath?: string
  readonly runtimeSessionsDir?: string
  readonly dryRun?: boolean
  readonly rebuildSeeds?: boolean
}

export interface RepairUserResult {
  readonly userId: string
  readonly username: string
  readonly sessions: SessionMaterializeResult[]
}

export async function repairMaterializeSeeds(options: RepairMaterializeOptions): Promise<RepairUserResult[]> {
  const socketPath =
    options.runtimeSocketPath ||
    process.env.ENKEEP_RUNTIME_SOCKET ||
    process.env.DSH_DAEMON_SOCKET_PATH ||
    (existsSync('/tmp/enkeep-runtime.sock') ? '/tmp/enkeep-runtime.sock' : undefined)
  if (!socketPath && !options.runtimeSessionsDir) {
    throw new Error('Runtime daemon socket path required: specify --runtime-socket or set ENKEEP_RUNTIME_SOCKET')
  }

  const userFilter = options.users && options.users.length > 0 ? options.users : options.user ? [options.user] : []
  if (userFilter.length === 0) {
    throw new Error(`--user <name> is required for ${options.rebuildSeeds ? '--rebuild-seeds' : '--materialize-seeds'}`)
  }

  const db = new DatabaseSync(options.targetDbPath, { readOnly: true })
  try {
    const allUsers = (db.prepare('SELECT id, username FROM users').all() as any[])
    const selected = allUsers.filter((u) =>
      userFilter.some((f) => f.toLowerCase() === (u.username || '').toLowerCase() || f.toLowerCase() === (u.id || '').toLowerCase())
    )
    if (selected.length === 0) {
      throw new Error(`No matching users found in target DB for "${userFilter.join(', ')}"`)
    }

    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((t) => t.name)
    )
    const hasTurnRuns = tables.has('turn_runs')
    const hasProv = tables.has('fixed_import_provenance')

    const results: RepairUserResult[] = []
    for (const u of selected) {
      const spaces = (db.prepare('SELECT id, folder FROM spaces WHERE user_id = ?').all(u.id) as any[])
      const spaceMap = new Map(spaces.map((sp) => [sp.id, sp.folder]))
      const routes = (db.prepare('SELECT id, space_id, dsh_session_id, native_context_id FROM session_routes WHERE user_id = ?').all(u.id) as any[])

      const items: SessionMaterializeItem[] = []
      for (const r of routes) {
        if (options.rebuildSeeds && hasTurnRuns) {
          const activeTurn = db
            .prepare("SELECT id, status FROM turn_runs WHERE (route_id = ? OR route_id = ?) AND status IN ('queued', 'running', 'active') LIMIT 1")
            .get(r.id, r.dsh_session_id || r.id) as { id: string; status: string } | undefined
          if (activeTurn) {
            throw new Error(`Cannot rebuild seeds: route "${r.id}" has an active or queued turn (status: ${activeTurn.status})`)
          }
        }

        const rawMsgs = hasProv
          ? (db
              .prepare(
                `SELECT m.id, m.role, m.content, m.created_at, p.source_message_id, p.rowid AS prov_rowid
                 FROM web_messages m
                 LEFT JOIN fixed_import_provenance p ON p.target_message_id = m.id AND p.user_id = m.user_id
                 WHERE m.session_id = ? AND m.user_id = ?`
              )
              .all(r.id, u.id) as any[])
          : (db
              .prepare('SELECT id, role, content, created_at, NULL as source_message_id, NULL as prov_rowid FROM web_messages WHERE session_id = ? AND user_id = ?')
              .all(r.id, u.id) as any[])

        const imported = rawMsgs.filter((m) => m.prov_rowid != null || m.source_message_id != null)
        const postImport = rawMsgs.filter((m) => m.prov_rowid == null && m.source_message_id == null)

        imported.sort((a, b) => {
          const at = parseTimestamp(a.created_at) ?? 0
          const bt = parseTimestamp(b.created_at) ?? 0
          if (at !== bt) return at < bt ? -1 : 1
          if (a.prov_rowid != null && b.prov_rowid != null && a.prov_rowid !== b.prov_rowid) {
            return a.prov_rowid < b.prov_rowid ? -1 : 1
          }
          if (a.source_message_id && b.source_message_id && a.source_message_id !== b.source_message_id) {
            return a.source_message_id < b.source_message_id ? -1 : 1
          }
          return 0
        })

        postImport.sort((a, b) => {
          const at = parseTimestamp(a.created_at) ?? 0
          const bt = parseTimestamp(b.created_at) ?? 0
          return at < bt ? -1 : at > bt ? 1 : 0
        })

        const allOrdered = [...imported, ...postImport]
        const msgRows: MessageRow[] = allOrdered.map((m) => ({
          id: m.source_message_id || m.id,
          chat_jid: r.native_context_id || r.id,
          content: m.content || '',
          timestamp: m.created_at,
          is_from_me: m.role === 'assistant' ? 1 : 0,
          attachments: null,
        }))
        const compiled = compileSeed(r.native_context_id || r.id, msgRows)
        const seed = compiled.seed.length > 0 ? compiled.seed : [{ type: 'session/end-seed', seq: 0, time: Date.now(), data: {} }]
        items.push({
          sessionId: r.dsh_session_id || r.id,
          folder: spaceMap.get(r.space_id) || 'default',
          seed,
          chatJid: r.native_context_id || r.id,
        })
      }

      const sessionResults = await materializeSessions(items, {
        runtimeSocketPath: socketPath,
        runtimeSessionsDir: options.runtimeSessionsDir,
        dryRun: options.dryRun,
        forceRebuild: Boolean(options.rebuildSeeds),
      })
      results.push({ userId: u.id, username: u.username, sessions: sessionResults })
    }
    return results
  } finally {
    db.close()
  }
}

export interface RepairFixTimestampsOptions {
  readonly targetDbPath: string
  readonly sourcePath?: string
  readonly user?: string
  readonly users?: readonly string[]
  readonly dryRun?: boolean
}

export interface FixTimestampsResult {
  readonly messagesUpdated: number
  readonly eventsUpdated: number
  readonly dryRun: boolean
}

export async function repairFixTimestamps(options: RepairFixTimestampsOptions): Promise<FixTimestampsResult> {
  if (!options.sourcePath) {
    throw new Error('--source <path> is required for --fix-timestamps')
  }
  const realSrcPath = validateSourceFile(options.sourcePath, 'source database')
  const srcDb = new DatabaseSync(`file:${realSrcPath}?immutable=1&mode=ro`, { readOnly: true })
  const db = new DatabaseSync(options.targetDbPath)
  try {
    const userFilter = options.users && options.users.length > 0 ? options.users : options.user ? [options.user] : []
    const allUsers = (db.prepare('SELECT id, username FROM users').all() as any[])
    const selected = userFilter.length > 0
      ? allUsers.filter((u) => userFilter.some((f) => f.toLowerCase() === (u.username || '').toLowerCase() || f.toLowerCase() === (u.id || '').toLowerCase()))
      : allUsers
    const userIds = selected.map((u) => u.id)
    if (userIds.length === 0) {
      return { messagesUpdated: 0, eventsUpdated: 0, dryRun: Boolean(options.dryRun) }
    }

    const hasProv = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fixed_import_provenance'").get()) !== undefined
    if (!hasProv) {
      return { messagesUpdated: 0, eventsUpdated: 0, dryRun: Boolean(options.dryRun) }
    }

    const srcRows = (srcDb.prepare('SELECT chat_jid, id, timestamp FROM messages WHERE timestamp IS NOT NULL').all() as any[])
    const tsMap = new Map<string, string>()
    for (const r of srcRows) {
      if (r.timestamp) tsMap.set(`${r.chat_jid}:${r.id}`, r.timestamp)
    }

    const placeholders = userIds.map(() => '?').join(',')
    const provRows = (db.prepare(`
      SELECT p.source_chat_jid, p.source_message_id, p.target_message_id, p.target_event_id,
             m.created_at AS msg_created_at, e.created_at AS ev_created_at
      FROM fixed_import_provenance p
      LEFT JOIN web_messages m ON m.id = p.target_message_id
      LEFT JOIN web_events e ON e.id = p.target_event_id
      WHERE p.user_id IN (${placeholders})
    `).all(...userIds) as any[])

    const msgsToUpdate: Array<{ id: string; timestamp: string }> = []
    const eventsToUpdate: Array<{ id: string; timestamp: string }> = []
    for (const row of provRows) {
      const origTs = tsMap.get(`${row.source_chat_jid}:${row.source_message_id}`)
      if (!origTs) continue
      if (row.target_message_id && row.msg_created_at !== origTs) {
        msgsToUpdate.push({ id: row.target_message_id, timestamp: origTs })
      }
      if (row.target_event_id && row.ev_created_at !== origTs) {
        eventsToUpdate.push({ id: row.target_event_id, timestamp: origTs })
      }
    }

    if (!options.dryRun && (msgsToUpdate.length > 0 || eventsToUpdate.length > 0)) {
      db.exec('BEGIN IMMEDIATE')
      try {
        const updateMsg = db.prepare('UPDATE web_messages SET created_at = ? WHERE id = ?')
        for (const item of msgsToUpdate) {
          updateMsg.run(item.timestamp, item.id)
        }
        const updateEv = db.prepare('UPDATE web_events SET created_at = ? WHERE id = ?')
        for (const item of eventsToUpdate) {
          updateEv.run(item.timestamp, item.id)
        }
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    }

    return {
      messagesUpdated: msgsToUpdate.length,
      eventsUpdated: eventsToUpdate.length,
      dryRun: Boolean(options.dryRun),
    }
  } finally {
    srcDb.close()
    db.close()
  }
}
