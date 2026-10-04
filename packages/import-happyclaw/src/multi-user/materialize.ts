import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { compileSeed } from '../seed.js'
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
  options: { runtimeSocketPath?: string; runtimeSessionsDir?: string; dryRun?: boolean }
): Promise<SessionMaterializeResult[]> {
  const client = options.runtimeSocketPath ? new RuntimeDaemonClient(options.runtimeSocketPath) : null
  try {
    const results: SessionMaterializeResult[] = []
    for (const item of items) {
      let isOk = false
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
    throw new Error('--user <name> is required for --materialize-seeds')
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

    const results: RepairUserResult[] = []
    for (const u of selected) {
      const spaces = (db.prepare('SELECT id, folder FROM spaces WHERE user_id = ?').all(u.id) as any[])
      const spaceMap = new Map(spaces.map((sp) => [sp.id, sp.folder]))
      const routes = (db.prepare('SELECT id, space_id, dsh_session_id, native_context_id FROM session_routes WHERE user_id = ?').all(u.id) as any[])

      const items: SessionMaterializeItem[] = []
      for (const r of routes) {
        const msgs = (db.prepare('SELECT id, role, content, created_at FROM web_messages WHERE session_id = ? AND user_id = ? ORDER BY created_at ASC').all(r.id, u.id) as any[])
        const msgRows: MessageRow[] = msgs.map((m) => ({
          id: m.id,
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
      })
      results.push({ userId: u.id, username: u.username, sessions: sessionResults })
    }
    return results
  } finally {
    db.close()
  }
}
