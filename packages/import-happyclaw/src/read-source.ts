import { DatabaseSync } from 'node:sqlite'
import { validateGroupFolder, validateSourceFile } from './guard.js'
import { folderSlug } from './ids.js'
import { introspectSource } from './introspection.js'
import type { ChatRow, GroupRow, MessageRow, SchemaDiagnostic } from './types.js'

export interface ReadSourceOptions {
  readonly chatJids?: readonly string[]
}

export interface ReadSourceResult {
  readonly chats: ChatRow[]
  readonly messages: MessageRow[]
  readonly groups: GroupRow[]
  readonly diagnostic: SchemaDiagnostic
}

export function readSource(dbPath: string, options?: ReadSourceOptions): ReadSourceResult {
  const realDbPath = validateSourceFile(dbPath, 'source database')

  const diagnostic = introspectSource(realDbPath)
  if (!diagnostic.ok) {
    const detail = diagnostic.issues.join('; ')
    throw new Error(`source database schema validation failed: ${detail}`)
  }

  const uri = `file:${realDbPath}?immutable=1&mode=ro`
  const db = new DatabaseSync(uri, { readOnly: true })

  try {
    const tableSet = new Set(diagnostic.tablesFound)

    // 1. Read chats
    let chats: ChatRow[] = []
    if (tableSet.has('chats')) {
      const hasLastMsgTime = diagnostic.columnMap['chats']?.includes('last_message_time') ?? false
      const sql = hasLastMsgTime
        ? 'SELECT jid, name, last_message_time FROM chats'
        : 'SELECT jid, name FROM chats'
      chats = (db.prepare(sql).all() as unknown[]) as ChatRow[]
    } else {
      // Minimal schema fallback: distinct chat_jid from messages
      const rows = (db
        .prepare('SELECT DISTINCT chat_jid AS jid FROM messages')
        .all() as unknown[]) as Array<{ jid: string }>
      chats = rows.map((r) => ({ jid: r.jid, name: null }))
    }

    // Filter chats if requested
    if (options?.chatJids && options.chatJids.length > 0) {
      const requestedSet = new Set(options.chatJids)
      chats = chats.filter((c) => requestedSet.has(c.jid))
    }

    // 2. Read registered groups / workspaces
    let groups: GroupRow[] = []
    if (tableSet.has('registered_groups')) {
      groups = readRegisteredGroups(db, diagnostic.columnMap['registered_groups'] ?? [])
    } else if (tableSet.has('workspaces')) {
      groups = readWorkspacesAsGroups(db, diagnostic.columnMap['workspaces'] ?? [])
    }

    // 3. Read messages
    const messages = readMessages(db, diagnostic.columnMap['messages'] ?? [], options?.chatJids)

    return { chats, messages, groups, diagnostic }
  } finally {
    db.close()
  }
}

function readRegisteredGroups(db: DatabaseSync, columns: readonly string[]): GroupRow[] {
  const colSet = new Set(columns)
  const selectCols = ['jid', 'name', 'folder']
  if (colSet.has('execution_mode')) selectCols.push('execution_mode')
  if (colSet.has('is_home')) selectCols.push('is_home')
  if (colSet.has('created_by')) selectCols.push('created_by')

  const sql = `SELECT ${selectCols.join(', ')} FROM registered_groups`
  const rows = (db.prepare(sql).all() as unknown[]) as Array<GroupRow>

  return rows.map((row) => {
    let folder = row.folder
    try {
      folder = validateGroupFolder(row.folder, `registered_groups folder for "${row.jid}"`)
    } catch {
      folder = folderSlug(row.folder || row.name || row.jid)
    }

    return {
      ...row,
      folder,
      execution_mode: row.execution_mode ?? null,
    }
  })
}

function readWorkspacesAsGroups(db: DatabaseSync, columns: readonly string[]): GroupRow[] {
  const colSet = new Set(columns)
  const selectCols = ['jid', 'name', 'folder']
  if (colSet.has('is_home')) selectCols.push('is_home')

  const sql = `SELECT ${selectCols.join(', ')} FROM workspaces`
  const rows = (db.prepare(sql).all() as unknown[]) as Array<{ jid: string; name: string; folder: string; is_home?: number }>

  return rows.map((row) => {
    let folder = row.folder
    try {
      folder = validateGroupFolder(row.folder, `workspaces folder for "${row.jid}"`)
    } catch {
      folder = folderSlug(row.folder || row.name || row.jid)
    }

    return {
      jid: row.jid,
      name: row.name,
      folder,
      execution_mode: null,
      is_home: row.is_home ?? null,
    }
  })
}

function readMessages(
  db: DatabaseSync,
  columns: readonly string[],
  chatJids?: readonly string[]
): MessageRow[] {
  const colSet = new Set(columns)
  const selectCols = ['id', 'chat_jid', 'content', 'timestamp', 'is_from_me']
  if (colSet.has('attachments')) selectCols.push('attachments')
  if (colSet.has('source_jid')) selectCols.push('source_jid')
  if (colSet.has('sender')) selectCols.push('sender')
  if (colSet.has('sender_name')) selectCols.push('sender_name')
  if (colSet.has('delivery_status')) selectCols.push('delivery_status')
  if (colSet.has('source_kind')) selectCols.push('source_kind')
  if (colSet.has('session_id')) selectCols.push('session_id')
  if (colSet.has('turn_id')) selectCols.push('turn_id')

  let sql = `SELECT ${selectCols.join(', ')} FROM messages`
  const params: Array<string | number | bigint | null | Uint8Array> = []

  if (chatJids && chatJids.length > 0) {
    const placeholders = chatJids.map(() => '?').join(', ')
    sql += ` WHERE chat_jid IN (${placeholders})`
    params.push(...chatJids)
  }

  const rows = (db.prepare(sql).all(...params) as unknown[]) as Array<MessageRow>

  return rows.map((row) => ({
    ...row,
    attachments: row.attachments ?? null,
  }))
}
