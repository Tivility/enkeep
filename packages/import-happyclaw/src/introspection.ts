import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { validateSourceFile } from './guard.js'
import type { SchemaCompatibilityLevel, SchemaDiagnostic } from './types.js'

export const KNOWN_HAPPYCLAW_TABLES = Object.freeze([
  'chats',
  'messages',
  'registered_groups',
  'workspaces',
  'sessions',
  'agents',
  'agent_profiles',
  'channel_mounts',
  'agent_channel_mounts',
  'channel_accounts',
  'im_context_bindings',
  'router_state',
  'scheduled_tasks',
  'task_runs',
  'task_run_logs',
  'users',
  'user_sessions',
  'billing_plans',
  'user_balances',
  'usage_records',
  'conversation_runtime_state',
  'conversation_runtime_sessions',
  'turn_events',
])

export const CORE_REQUIRED_TABLES = Object.freeze(['messages'])
export const STANDARD_REQUIRED_TABLES = Object.freeze(['messages', 'chats'])

/**
 * Introspects a source SQLite database without modifying it.
 * Opens with immutable read-only URI, analyzes table schema, column definitions,
 * router_state schema_version, and returns structured diagnostics.
 */
export function introspectSource(dbPath: string): SchemaDiagnostic {
  let realDbPath: string
  try {
    realDbPath = validateSourceFile(dbPath, 'source database')
  } catch (err: any) {
    return {
      ok: false,
      compatibilityLevel: 'incompatible',
      detectedSchemaVersion: null,
      tablesFound: [],
      missingRequiredTables: ['messages', 'chats'],
      missingOptionalTables: ['registered_groups', 'workspaces', 'router_state'],
      issues: [err?.message ?? String(err)],
      recommendations: ['Provide a valid existing regular SQLite database file path.'],
      columnMap: {},
    }
  }

  const issues: string[] = []
  const recommendations: string[] = []

  // Check for SQLite WAL / SHM companion files and warn operator
  const walPath = `${realDbPath}-wal`
  const shmPath = `${realDbPath}-shm`
  if (existsSync(walPath)) {
    issues.push(
      `Source database has an accompanying WAL file (${walPath}). For guaranteed transactional consistency, checkpoint the source database before migration or create a snapshot copy.`
    )
  }
  if (existsSync(shmPath)) {
    issues.push(
      `Source database has an accompanying SHM file (${shmPath}).`
    )
  }

  const uri = `file:${realDbPath}?immutable=1&mode=ro`
  let db: DatabaseSync
  try {
    db = new DatabaseSync(uri, { readOnly: true })
  } catch (err: any) {
    return {
      ok: false,
      compatibilityLevel: 'incompatible',
      detectedSchemaVersion: null,
      tablesFound: [],
      missingRequiredTables: ['messages'],
      missingOptionalTables: [],
      issues: [`Failed to open SQLite database in read-only mode: ${err?.message ?? String(err)}`],
      recommendations: ['Ensure file is a valid, uncorrupted SQLite database.'],
      columnMap: {},
    }
  }

  try {
    // 1. Inspect tables in sqlite_master
    const masterRows = (db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as unknown[]) as Array<{ name: string }>
    const tablesFound = masterRows.map((r) => r.name)
    const tableSet = new Set(tablesFound)

    // 2. Inspect columns for each table
    const columnMap: Record<string, string[]> = {}
    for (const tableName of tablesFound) {
      try {
        const colRows = (db.prepare(`PRAGMA table_info("${tableName}")`).all() as unknown[]) as Array<{
          name: string
        }>
        columnMap[tableName] = colRows.map((c) => c.name)
      } catch {
        columnMap[tableName] = []
      }
    }

    // 3. Inspect router_state schema_version if present
    let detectedSchemaVersion: number | null = null
    if (tableSet.has('router_state')) {
      try {
        const row = db.prepare("SELECT value FROM router_state WHERE key = 'schema_version'").get() as
          | { value: string }
          | undefined
        if (row && row.value) {
          const num = Number(row.value)
          if (Number.isSafeInteger(num) && num > 0) {
            detectedSchemaVersion = num
          }
        }
      } catch {
        // Table or query error
      }
    }

    // 4. Check required tables
    const missingRequiredTables: string[] = []
    for (const requiredTable of CORE_REQUIRED_TABLES) {
      if (!tableSet.has(requiredTable)) {
        missingRequiredTables.push(requiredTable)
      }
    }

    if (missingRequiredTables.length > 0) {
      issues.push(`Missing core required table(s): ${missingRequiredTables.join(', ')}`)
      recommendations.push('Database must contain at least the "messages" table to perform migration.')
      return {
        ok: false,
        compatibilityLevel: 'incompatible',
        detectedSchemaVersion,
        tablesFound,
        missingRequiredTables,
        missingOptionalTables: KNOWN_HAPPYCLAW_TABLES.filter((t) => !tableSet.has(t)),
        issues,
        recommendations,
        columnMap,
      }
    }

    // 5. Check columns of messages table
    const messageCols = new Set(columnMap['messages'] ?? [])
    const coreMsgCols = ['id', 'chat_jid', 'content', 'timestamp', 'is_from_me']
    const missingMsgCols = coreMsgCols.filter((c) => !messageCols.has(c))
    if (missingMsgCols.length > 0) {
      issues.push(`Messages table is missing essential columns: ${missingMsgCols.join(', ')}`)
      recommendations.push('Messages table schema is non-standard or corrupt.')
      return {
        ok: false,
        compatibilityLevel: 'incompatible',
        detectedSchemaVersion,
        tablesFound,
        missingRequiredTables: [],
        missingOptionalTables: [],
        issues,
        recommendations,
        columnMap,
      }
    }

    // 6. Check optional tables
    const missingOptionalTables = KNOWN_HAPPYCLAW_TABLES.filter((t) => !tableSet.has(t))

    // 7. Determine compatibility level
    let compatibilityLevel: SchemaCompatibilityLevel
    if (
      tableSet.has('chats') &&
      tableSet.has('messages') &&
      tableSet.has('registered_groups') &&
      (detectedSchemaVersion !== null ? detectedSchemaVersion >= 50 : messageCols.has('attachments'))
    ) {
      compatibilityLevel = 'current'
    } else if (tableSet.has('chats') && tableSet.has('messages')) {
      compatibilityLevel = 'legacy'
      if (!tableSet.has('registered_groups')) {
        issues.push('Missing "registered_groups" table; spaces and folders will be inferred from chat metadata.')
      }
      if (!tableSet.has('router_state')) {
        issues.push('Missing "router_state" table; schema version could not be explicitly confirmed.')
      }
    } else {
      compatibilityLevel = 'minimal'
      issues.push('Minimal single-table schema detected (messages only); chats will be derived from unique chat_jid values.')
      recommendations.push('Full group folder hierarchy is not present; default folder mapping will be applied.')
    }

    return {
      ok: true,
      compatibilityLevel,
      detectedSchemaVersion,
      tablesFound,
      missingRequiredTables: [],
      missingOptionalTables,
      issues,
      recommendations,
      columnMap,
    }
  } finally {
    db.close()
  }
}
