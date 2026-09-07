import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { validateGroupFolder, validateSourceFile } from '../guard.js'
import {
  channelFromJid,
  deterministicSessionId,
  deterministicSpaceId,
  folderSlug,
} from '../ids.js'
import { computeSourceFingerprint } from '../manifest.js'
import { introspectSource } from '../introspection.js'
import { readSource } from '../read-source.js'
import { validateTargetUserId } from '../migrate.js'
import {
  DEFAULT_MIGRATION_V2_SCOPES,
  type AgentProfileSnapshotPlan,
  type ChannelAccountMigrationPlan,
  type ChannelBindingMigrationPlan,
  type ExtensionMigrationPlan,
  type MigrationPlanV2,
  type MigrationV2DryRunRequest,
  type MigrationV2PlanItem,
  type MigrationV2Scopes,
  type ModelPrefMigrationPlan,
  type QuotaMigrationPlan,
  type SchemaDiagnostic,
  type SessionMigrationPlan,
  type SourceInspectResultV2,
  type SpaceInstructionPlan,
  type TaskMigrationPlan,
  type UserInstructionPlan,
  type UserSnapshotPlan,
  type WorkspaceInspectSummaryV2,
} from '../types.js'

export function computeDeterministicPlanId(
  fingerprint: string,
  targetUserId: string,
  selectedWorkspaces: readonly string[],
  scopes: MigrationV2Scopes
): string {
  const normWorkspaces = [...selectedWorkspaces].sort()
  const payload = {
    fingerprint,
    targetUserId,
    workspaces: normWorkspaces,
    scopes: {
      coreData: Boolean(scopes.coreData),
      extensions: Boolean(scopes.extensions),
      tasks: Boolean(scopes.tasks),
      channelsMetadata: Boolean(scopes.channelsMetadata),
      credentials: Boolean(scopes.credentials),
    },
  }
  const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  return `plan_v2_${hash.slice(0, 24)}`
}

/**
 * Inspects a source HappyClaw snapshot for V2 workspace-centric migration.
 */
export function inspectSourceV2(
  sourcePath: string,
  groupsDir?: string
): SourceInspectResultV2 {
  const realDbPath = validateSourceFile(sourcePath, 'source database')
  const diagnostic = introspectSource(realDbPath)
  const fingerprint = computeSourceFingerprint(realDbPath, groupsDir)

  const uri = `file:${realDbPath}?immutable=1&mode=ro`
  const db = new DatabaseSync(uri, { readOnly: true })

  try {
    const tableSet = new Set(diagnostic.tablesFound)

    // Workspaces / Registered groups
    interface RawWorkspace {
      jid: string
      name?: string | null
      folder?: string | null
      execution_mode?: string | null
    }

    let rawWorkspaces: RawWorkspace[] = []
    if (tableSet.has('registered_groups')) {
      const rows = (db
        .prepare('SELECT jid, name, folder, execution_mode FROM registered_groups')
        .all() as unknown[]) as RawWorkspace[]
      rawWorkspaces = rows
    } else if (tableSet.has('workspaces')) {
      const rows = (db
        .prepare('SELECT jid, name, folder, execution_mode FROM workspaces')
        .all() as unknown[]) as RawWorkspace[]
      rawWorkspaces = rows
    } else if (tableSet.has('chats')) {
      const rows = (db
        .prepare('SELECT jid, name FROM chats')
        .all() as unknown[]) as Array<{ jid: string; name?: string }>
      rawWorkspaces = rows.map((r) => ({
        jid: r.jid,
        name: r.name,
        folder: folderSlug(r.name || r.jid),
        execution_mode: 'container',
      }))
    }

    // Chats and messages counts
    const chatRows = tableSet.has('chats')
      ? ((db.prepare('SELECT jid, name FROM chats').all() as unknown[]) as Array<{ jid: string; name?: string }>)
      : []

    const messages = tableSet.has('messages')
      ? ((db.prepare('SELECT id, chat_jid FROM messages').all() as unknown[]) as Array<{ id: string; chat_jid: string }>)
      : []

    const msgCountByChat = new Map<string, number>()
    for (const m of messages) {
      msgCountByChat.set(m.chat_jid, (msgCountByChat.get(m.chat_jid) ?? 0) + 1)
    }

    // Extensions / Skills / MCP / Plugins
    let allSkills: Array<{ id: string; name: string; space_id?: string }> = []
    if (tableSet.has('skills')) {
      const cols = new Set(diagnostic.columnMap['skills'] ?? [])
      const idCol = cols.has('id') ? 'id' : 'rowid AS id'
      const nameCol = cols.has('name') ? 'name' : idCol
      const spaceCol = cols.has('space_id') ? 'space_id' : cols.has('workspace_id') ? 'workspace_id AS space_id' : 'NULL AS space_id'
      allSkills = (db.prepare(`SELECT ${idCol}, ${nameCol}, ${spaceCol} FROM skills`).all() as unknown[]) as typeof allSkills
    } else if (tableSet.has('skill_packages')) {
      const cols = new Set(diagnostic.columnMap['skill_packages'] ?? [])
      const idCol = cols.has('id') ? 'id' : 'rowid AS id'
      const nameCol = cols.has('name') ? 'name' : idCol
      const spaceCol = cols.has('space_id') ? 'space_id' : cols.has('workspace_id') ? 'workspace_id AS space_id' : 'NULL AS space_id'
      allSkills = (db.prepare(`SELECT ${idCol}, ${nameCol}, ${spaceCol} FROM skill_packages`).all() as unknown[]) as typeof allSkills
    }

    let allMcp: Array<{ id: string; name: string; workspace_id?: string }> = []
    if (tableSet.has('mcp_servers')) {
      const cols = new Set(diagnostic.columnMap['mcp_servers'] ?? [])
      const idCol = cols.has('id') ? 'id' : 'name AS id'
      const nameCol = cols.has('name') ? 'name' : idCol
      const wsCol = cols.has('workspace_id') ? 'workspace_id' : 'NULL AS workspace_id'
      allMcp = (db.prepare(`SELECT ${idCol}, ${nameCol}, ${wsCol} FROM mcp_servers`).all() as unknown[]) as typeof allMcp
    }

    let allPlugins: Array<{ id: string; name: string; workspace_id?: string }> = []
    if (tableSet.has('plugins')) {
      const cols = new Set(diagnostic.columnMap['plugins'] ?? [])
      const idCol = cols.has('id') ? 'id' : 'name AS id'
      const nameCol = cols.has('name') ? 'name' : idCol
      const wsCol = cols.has('workspace_id') ? 'workspace_id' : 'NULL AS workspace_id'
      allPlugins = (db.prepare(`SELECT ${idCol}, ${nameCol}, ${wsCol} FROM plugins`).all() as unknown[]) as typeof allPlugins
    }

    // Tasks
    let allTasks: Array<{ id: string; title?: string; workspace_id?: string; group_jid?: string }> = []
    if (tableSet.has('scheduled_tasks')) {
      const cols = new Set(diagnostic.columnMap['scheduled_tasks'] ?? [])
      const idCol = cols.has('id') ? 'id' : 'rowid AS id'
      const titleCol = cols.has('title') ? 'title' : cols.has('prompt') ? 'prompt AS title' : "'Scheduled Task' AS title"
      const wsCol = cols.has('workspace_id') ? 'workspace_id' : cols.has('workspace_jid') ? 'workspace_jid AS workspace_id' : cols.has('group_folder') ? 'group_folder AS workspace_id' : 'NULL AS workspace_id'
      const groupCol = cols.has('group_jid') ? 'group_jid' : cols.has('chat_jid') ? 'chat_jid AS group_jid' : cols.has('workspace_jid') ? 'workspace_jid AS group_jid' : 'NULL AS group_jid'
      allTasks = (db.prepare(`SELECT ${idCol}, ${titleCol}, ${wsCol}, ${groupCol} FROM scheduled_tasks`).all() as unknown[]) as typeof allTasks
    } else if (tableSet.has('tasks')) {
      const cols = new Set(diagnostic.columnMap['tasks'] ?? [])
      const idCol = cols.has('id') ? 'id' : 'rowid AS id'
      const titleCol = cols.has('title') ? 'title' : cols.has('prompt') ? 'prompt AS title' : "'Task' AS title"
      const wsCol = cols.has('workspace_id') ? 'workspace_id' : 'NULL AS workspace_id'
      allTasks = (db.prepare(`SELECT ${idCol}, ${titleCol}, ${wsCol} FROM tasks`).all() as unknown[]) as typeof allTasks
    }

    // Channels & mounts
    let allMounts: Array<{ id: string; workspace_id?: string; group_jid?: string; channel?: string }> = []
    if (tableSet.has('channel_mounts')) {
      const cols = new Set(diagnostic.columnMap['channel_mounts'] ?? [])
      const idCol = cols.has('id') ? 'id' : cols.has('channel_jid') ? 'channel_jid AS id' : 'rowid AS id'
      const wsCol = cols.has('workspace_id') ? 'workspace_id' : cols.has('workspace_jid') ? 'workspace_jid AS workspace_id' : 'NULL AS workspace_id'
      const groupCol = cols.has('group_jid') ? 'group_jid' : cols.has('workspace_jid') ? 'workspace_jid AS group_jid' : 'NULL AS group_jid'
      const chanCol = cols.has('channel') ? 'channel' : cols.has('channel_type') ? 'channel_type AS channel' : "'generic' AS channel"
      allMounts = (db.prepare(`SELECT ${idCol}, ${wsCol}, ${groupCol}, ${chanCol} FROM channel_mounts`).all() as unknown[]) as typeof allMounts
    } else if (tableSet.has('im_context_bindings')) {
      const cols = new Set(diagnostic.columnMap['im_context_bindings'] ?? [])
      const idCol = cols.has('id') ? 'id' : cols.has('source_jid') ? 'source_jid AS id' : 'rowid AS id'
      const wsCol = cols.has('workspace_id') ? 'workspace_id' : cols.has('workspace_jid') ? 'workspace_jid AS workspace_id' : 'NULL AS workspace_id'
      const chanCol = cols.has('channel') ? 'channel' : cols.has('context_type') ? 'context_type AS channel' : "'generic' AS channel"
      allMounts = (db.prepare(`SELECT ${idCol}, ${wsCol}, ${chanCol} FROM im_context_bindings`).all() as unknown[]) as typeof allMounts
    }

    const summaries: WorkspaceInspectSummaryV2[] = rawWorkspaces.map((ws) => {
      const folder = ws.folder || folderSlug(ws.name || ws.jid)
      const wsChats = chatRows.filter((c) => c.jid === ws.jid || c.jid.includes(ws.jid))
      const chatJids = new Set(wsChats.map((c) => c.jid))
      if (chatJids.size === 0) {
        chatJids.add(ws.jid)
      }

      let wsMsgCount = 0
      for (const jid of chatJids) {
        wsMsgCount += msgCountByChat.get(jid) ?? 0
      }

      let hasMem = false
      if (groupsDir && existsSync(groupsDir)) {
        const spaceDir = join(groupsDir, folder)
        if (existsSync(spaceDir)) {
          hasMem =
            existsSync(join(spaceDir, 'CLAUDE.md')) ||
            existsSync(join(spaceDir, 'memory.md')) ||
            existsSync(join(spaceDir, 'MEMORY.md'))
        }
      }

      const wsSkills = allSkills.filter((s) => s.space_id === ws.jid || s.space_id === folder)
      const wsMcp = allMcp.filter((m) => m.workspace_id === ws.jid || m.workspace_id === folder)
      const wsPlugins = allPlugins.filter((p) => p.workspace_id === ws.jid || p.workspace_id === folder)
      const wsTasks = allTasks.filter((t) => t.workspace_id === ws.jid || t.group_jid === ws.jid || t.workspace_id === folder)
      const wsMounts = allMounts.filter((m) => m.workspace_id === ws.jid || m.group_jid === ws.jid || m.workspace_id === folder)
      const channels = Array.from(new Set(wsMounts.map((m) => m.channel || 'generic').concat(channelFromJid(ws.jid))))

      return {
        workspaceId: ws.jid,
        name: ws.name || ws.jid,
        folder,
        executionMode: ws.execution_mode ?? 'container',
        conversationCount: Math.max(1, wsChats.length),
        messageCount: wsMsgCount,
        hasMemoryOrClaudeFile: hasMem,
        skillsCount: wsSkills.length,
        pluginsCount: wsPlugins.length,
        mcpCount: wsMcp.length,
        tasksCount: wsTasks.length,
        channels,
      }
    })

    return {
      sourcePath: realDbPath,
      sourceFingerprint: fingerprint,
      diagnostic,
      totalWorkspaces: summaries.length,
      totalConversations: chatRows.length || summaries.length,
      totalMessages: messages.length,
      totalExtensions: allSkills.length + allMcp.length + allPlugins.length,
      totalTasks: allTasks.length,
      totalChannels: allMounts.length,
      workspaces: summaries,
    }
  } finally {
    db.close()
  }
}

/**
 * Creates a deterministic Migration V2 Plan (Dry Run) across selected workspaces.
 */
export function createMigrationPlanV2(request: MigrationV2DryRunRequest): MigrationPlanV2 {
  if (!request.sourcePath && !request.stagedId) {
    throw new Error('Either sourcePath or stagedId must be specified')
  }

  const realDbPath = validateSourceFile(request.sourcePath || '', 'source database')
  const targetUserId = validateTargetUserId(request.targetUserId || 'alice')
  const groupsDir = request.sourceGroupsDir

  const scopes: MigrationV2Scopes = {
    ...DEFAULT_MIGRATION_V2_SCOPES,
    ...(request.scopes ?? {}),
  }

  const fingerprint = computeSourceFingerprint(realDbPath, groupsDir)
  const diagnostic = introspectSource(realDbPath)
  const warnings: string[] = [...diagnostic.issues]

  const uri = `file:${realDbPath}?immutable=1&mode=ro`
  const db = new DatabaseSync(uri, { readOnly: true })

  try {
    const tableSet = new Set(diagnostic.tablesFound)

    // 1. Read Workspaces
    interface RawWorkspace {
      jid: string
      name?: string | null
      folder?: string | null
      execution_mode?: string | null
      created_by?: string | null
    }

    let allWorkspaces: RawWorkspace[] = []
    if (tableSet.has('registered_groups')) {
      allWorkspaces = (db
        .prepare('SELECT jid, name, folder, execution_mode, created_by FROM registered_groups')
        .all() as unknown[]) as RawWorkspace[]
    } else if (tableSet.has('workspaces')) {
      allWorkspaces = (db
        .prepare('SELECT jid, name, folder, execution_mode, created_by FROM workspaces')
        .all() as unknown[]) as RawWorkspace[]
    } else if (tableSet.has('chats')) {
      const chats = (db.prepare('SELECT jid, name FROM chats').all() as unknown[]) as Array<{ jid: string; name?: string }>
      allWorkspaces = chats.map((c) => ({
        jid: c.jid,
        name: c.name,
        folder: folderSlug(c.name || c.jid),
        execution_mode: 'container',
        created_by: targetUserId,
      }))
    }

    // Filter by selectedWorkspaceIds
    const selectedIds = new Set(request.selectedWorkspaceIds)
    if (selectedIds.size === 0) {
      throw new Error('At least one workspace must be selected in selectedWorkspaceIds')
    }

    const selectedWorkspaces = allWorkspaces.filter((w) => selectedIds.has(w.jid))
    if (selectedWorkspaces.length === 0) {
      throw new Error(`None of the requested workspaces (${Array.from(selectedIds).join(', ')}) were found in source`)
    }

    // 2. Read Users
    interface RawUser {
      id: string
      username?: string | null
      role?: string | null
      name?: string | null
    }
    let rawUsers: RawUser[] = []
    if (tableSet.has('users')) {
      const cols = new Set(diagnostic.columnMap['users'] ?? [])
      const idCol = cols.has('id') ? 'id' : 'rowid AS id'
      const userCol = cols.has('username') ? 'username' : idCol
      const roleCol = cols.has('role') ? 'role' : "'user' AS role"
      const nameCol = cols.has('name') ? 'name' : cols.has('display_name') ? 'display_name AS name' : userCol
      rawUsers = (db.prepare(`SELECT ${idCol}, ${userCol}, ${roleCol}, ${nameCol} FROM users`).all() as unknown[]) as RawUser[]
    }

    // 3. Read Agents & Agent Profiles
    interface RawAgent {
      id: string
      name: string
      profile_id?: string | null
      workspace_id?: string | null
      system_prompt?: string | null
    }
    let rawAgents: RawAgent[] = []
    if (tableSet.has('agents')) {
      const cols = new Set(diagnostic.columnMap['agents'] ?? [])
      const idCol = cols.has('id') ? 'id' : 'rowid AS id'
      const nameCol = cols.has('name') ? 'name' : idCol
      const profCol = cols.has('profile_id') ? 'profile_id' : 'NULL AS profile_id'
      const wsCol = cols.has('workspace_id') ? 'workspace_id' : cols.has('group_folder') ? 'group_folder AS workspace_id' : cols.has('chat_jid') ? 'chat_jid AS workspace_id' : 'NULL AS workspace_id'
      const sysCol = cols.has('system_prompt') ? 'system_prompt' : cols.has('prompt') ? 'prompt AS system_prompt' : 'NULL AS system_prompt'
      rawAgents = (db.prepare(`SELECT ${idCol}, ${nameCol}, ${profCol}, ${wsCol}, ${sysCol} FROM agents`).all() as unknown[]) as RawAgent[]
    }

    interface RawProfile {
      id: string
      name: string
      description?: string | null
      system_prompt: string
      version?: number | null
    }
    let rawProfiles: RawProfile[] = []
    if (tableSet.has('agent_profiles')) {
      const cols = new Set(diagnostic.columnMap['agent_profiles'] ?? [])
      const idCol = cols.has('id') ? 'id' : 'rowid AS id'
      const nameCol = cols.has('name') ? 'name' : idCol
      const descCol = cols.has('description') ? 'description' : 'NULL AS description'
      const sysCol = cols.has('system_prompt') ? 'system_prompt' : cols.has('identity_prompt') ? 'identity_prompt AS system_prompt' : "'' AS system_prompt"
      const verCol = cols.has('version') ? 'version' : 'NULL AS version'
      rawProfiles = (db.prepare(`SELECT ${idCol}, ${nameCol}, ${descCol}, ${sysCol}, ${verCol} FROM agent_profiles`).all() as unknown[]) as RawProfile[]
    }

    // 4. Read Chats & Messages
    interface RawChat {
      jid: string
      name?: string | null
    }
    const rawChats = tableSet.has('chats')
      ? ((db.prepare('SELECT jid, name FROM chats').all() as unknown[]) as RawChat[])
      : []

    interface RawMessage {
      id: string
      chat_jid: string
      content?: string | null
      attachments?: string | null
    }
    const rawMessages = tableSet.has('messages')
      ? ((db.prepare('SELECT id, chat_jid, content, attachments FROM messages').all() as unknown[]) as RawMessage[])
      : []

    const messagesByChat = new Map<string, RawMessage[]>()
    for (const m of rawMessages) {
      const list = messagesByChat.get(m.chat_jid) ?? []
      list.push(m)
      messagesByChat.set(m.chat_jid, list)
    }

    // 5. Read Skills, MCP, Plugins
    interface RawSkill {
      id: string
      name: string
      scope?: string | null
      space_id?: string | null
      source_type?: string | null
      source_url?: string | null
      content_hash?: string | null
    }
    let rawSkills: RawSkill[] = []
    if (tableSet.has('skills')) {
      const cols = new Set(diagnostic.columnMap['skills'] ?? [])
      const idCol = cols.has('id') ? 'id' : 'rowid AS id'
      const nameCol = cols.has('name') ? 'name' : idCol
      const scopeCol = cols.has('scope') ? 'scope' : "'workspace' AS scope"
      const spaceCol = cols.has('space_id') ? 'space_id' : cols.has('workspace_id') ? 'workspace_id AS space_id' : 'NULL AS space_id'
      const srcTypeCol = cols.has('source_type') ? 'source_type' : "'builtin' AS source_type"
      const srcUrlCol = cols.has('source_url') ? 'source_url' : 'NULL AS source_url'
      const hashCol = cols.has('content_hash') ? 'content_hash' : 'NULL AS content_hash'
      rawSkills = (db.prepare(`SELECT ${idCol}, ${nameCol}, ${scopeCol}, ${spaceCol}, ${srcTypeCol}, ${srcUrlCol}, ${hashCol} FROM skills`).all() as unknown[]) as RawSkill[]
    } else if (tableSet.has('skill_packages')) {
      const cols = new Set(diagnostic.columnMap['skill_packages'] ?? [])
      const idCol = cols.has('id') ? 'id' : 'rowid AS id'
      const nameCol = cols.has('name') ? 'name' : idCol
      const scopeCol = cols.has('scope') ? 'scope' : "'workspace' AS scope"
      const spaceCol = cols.has('space_id') ? 'space_id' : cols.has('workspace_id') ? 'workspace_id AS space_id' : 'NULL AS space_id'
      const srcTypeCol = cols.has('source_type') ? 'source_type' : "'builtin' AS source_type"
      const srcUrlCol = cols.has('source_url') ? 'source_url' : 'NULL AS source_url'
      const hashCol = cols.has('content_hash') ? 'content_hash' : 'NULL AS content_hash'
      rawSkills = (db.prepare(`SELECT ${idCol}, ${nameCol}, ${scopeCol}, ${spaceCol}, ${srcTypeCol}, ${srcUrlCol}, ${hashCol} FROM skill_packages`).all() as unknown[]) as RawSkill[]
    }

    interface RawMcp {
      id: string
      name: string
      transport?: string | null
      command?: string | null
      args?: string | null
      workspace_id?: string | null
    }
    let rawMcp: RawMcp[] = []
    if (tableSet.has('mcp_servers')) {
      const cols = new Set(diagnostic.columnMap['mcp_servers'] ?? [])
      const idCol = cols.has('id') ? 'id' : 'name AS id'
      const nameCol = cols.has('name') ? 'name' : idCol
      const transCol = cols.has('transport') ? 'transport' : "'stdio' AS transport"
      const cmdCol = cols.has('command') ? 'command' : "'' AS command"
      const argsCol = cols.has('args') ? 'args' : "'[]' AS args"
      const wsCol = cols.has('workspace_id') ? 'workspace_id' : 'NULL AS workspace_id'
      rawMcp = (db.prepare(`SELECT ${idCol}, ${nameCol}, ${transCol}, ${cmdCol}, ${argsCol}, ${wsCol} FROM mcp_servers`).all() as unknown[]) as RawMcp[]
    }

    interface RawPlugin {
      id: string
      name: string
      workspace_id?: string | null
      source?: string | null
      status?: string | null
      trusted?: number | null
      capabilities?: string | null
    }
    let rawPlugins: RawPlugin[] = []
    if (tableSet.has('plugins')) {
      const cols = new Set(diagnostic.columnMap['plugins'] ?? [])
      const idCol = cols.has('id') ? 'id' : 'name AS id'
      const nameCol = cols.has('name') ? 'name' : idCol
      const wsCol = cols.has('workspace_id') ? 'workspace_id' : 'NULL AS workspace_id'
      const srcCol = cols.has('source') ? 'source' : "'local' AS source"
      const stCol = cols.has('status') ? 'status' : "'active' AS status"
      const trCol = cols.has('trusted') ? 'trusted' : '1 AS trusted'
      const capCol = cols.has('capabilities') ? 'capabilities' : "'[]' AS capabilities"
      rawPlugins = (db.prepare(`SELECT ${idCol}, ${nameCol}, ${wsCol}, ${srcCol}, ${stCol}, ${trCol}, ${capCol} FROM plugins`).all() as unknown[]) as RawPlugin[]
    }

    // 6. Read Tasks
    interface RawTask {
      id: string
      title: string
      prompt: string
      cron_expression?: string | null
      priority?: string | null
      workspace_id?: string | null
      group_jid?: string | null
    }
    let rawTasks: RawTask[] = []
    if (tableSet.has('scheduled_tasks')) {
      const cols = new Set(diagnostic.columnMap['scheduled_tasks'] ?? [])
      const idCol = cols.has('id') ? 'id' : 'rowid AS id'
      const titleCol = cols.has('title') ? 'title' : cols.has('prompt') ? 'prompt AS title' : "'Scheduled Task' AS title"
      const promptCol = cols.has('prompt') ? 'prompt' : "'' AS prompt"
      const cronCol = cols.has('cron_expression') ? 'cron_expression' : cols.has('schedule_value') ? 'schedule_value AS cron_expression' : 'NULL AS cron_expression'
      const priCol = cols.has('priority') ? 'priority' : 'NULL AS priority'
      const wsCol = cols.has('workspace_id') ? 'workspace_id' : cols.has('workspace_jid') ? 'workspace_jid AS workspace_id' : cols.has('group_folder') ? 'group_folder AS workspace_id' : 'NULL AS workspace_id'
      const grpCol = cols.has('group_jid') ? 'group_jid' : cols.has('chat_jid') ? 'chat_jid AS group_jid' : cols.has('workspace_jid') ? 'workspace_jid AS group_jid' : 'NULL AS group_jid'
      rawTasks = (db.prepare(`SELECT ${idCol}, ${titleCol}, ${promptCol}, ${cronCol}, ${priCol}, ${wsCol}, ${grpCol} FROM scheduled_tasks`).all() as unknown[]) as RawTask[]
    } else if (tableSet.has('tasks')) {
      const cols = new Set(diagnostic.columnMap['tasks'] ?? [])
      const idCol = cols.has('id') ? 'id' : 'rowid AS id'
      const titleCol = cols.has('title') ? 'title' : cols.has('prompt') ? 'prompt AS title' : "'Task' AS title"
      const promptCol = cols.has('prompt') ? 'prompt' : "'' AS prompt"
      const cronCol = cols.has('cron_expression') ? 'cron_expression' : cols.has('schedule') ? 'schedule AS cron_expression' : 'NULL AS cron_expression'
      const priCol = cols.has('priority') ? 'priority' : 'NULL AS priority'
      const wsCol = cols.has('workspace_id') ? 'workspace_id' : 'NULL AS workspace_id'
      rawTasks = (db.prepare(`SELECT ${idCol}, ${titleCol}, ${promptCol}, ${cronCol}, ${priCol}, ${wsCol} FROM tasks`).all() as unknown[]) as RawTask[]
    }

    // 7. Read Channel Accounts & Bindings
    interface RawChannelAccount {
      id: string
      type: string
      name?: string | null
      status?: string | null
      credential_ref?: string | null
      credential_id?: string | null
    }
    let rawChannelAccounts: RawChannelAccount[] = []
    if (tableSet.has('channel_accounts')) {
      const cols = new Set(diagnostic.columnMap['channel_accounts'] ?? [])
      const idCol = cols.has('id') ? 'id' : 'rowid AS id'
      const typeCol = cols.has('type') ? 'type' : cols.has('provider') ? 'provider AS type' : "'unknown' AS type"
      const nameCol = cols.has('name') ? 'name' : cols.has('provider') ? 'provider AS name' : idCol
      const stCol = cols.has('status') ? 'status' : "'active' AS status"
      const credCol = cols.has('credential_ref') ? 'credential_ref' : cols.has('secret_ref') ? 'secret_ref AS credential_ref' : 'NULL AS credential_ref'
      rawChannelAccounts = (db.prepare(`SELECT ${idCol}, ${typeCol}, ${nameCol}, ${stCol}, ${credCol} FROM channel_accounts`).all() as unknown[]) as RawChannelAccount[]
    }

    interface RawChannelBinding {
      id: string
      account_id: string
      workspace_id?: string | null
      group_jid?: string | null
      native_context_id: string
      activation_mode?: string | null
      channel?: string | null
    }
    let rawChannelBindings: RawChannelBinding[] = []
    if (tableSet.has('channel_mounts')) {
      const cols = new Set(diagnostic.columnMap['channel_mounts'] ?? [])
      const idCol = cols.has('id') ? 'id' : cols.has('channel_jid') ? 'channel_jid AS id' : 'rowid AS id'
      const accCol = cols.has('account_id') ? 'account_id' : cols.has('channel_account_id') ? 'channel_account_id AS account_id' : "'' AS account_id"
      const wsCol = cols.has('workspace_id') ? 'workspace_id' : cols.has('workspace_jid') ? 'workspace_jid AS workspace_id' : 'NULL AS workspace_id'
      const grpCol = cols.has('group_jid') ? 'group_jid' : cols.has('workspace_jid') ? 'workspace_jid AS group_jid' : 'NULL AS group_jid'
      const natCol = cols.has('native_context_id') ? 'native_context_id' : cols.has('session_id') ? 'session_id AS native_context_id' : cols.has('channel_jid') ? 'channel_jid AS native_context_id' : "'' AS native_context_id"
      const actCol = cols.has('activation_mode') ? 'activation_mode' : "'auto' AS activation_mode"
      const chanCol = cols.has('channel') ? 'channel' : cols.has('channel_type') ? 'channel_type AS channel' : "'generic' AS channel"
      rawChannelBindings = (db.prepare(`SELECT ${idCol}, ${accCol}, ${wsCol}, ${grpCol}, ${natCol}, ${actCol}, ${chanCol} FROM channel_mounts`).all() as unknown[]) as RawChannelBinding[]
    } else if (tableSet.has('im_context_bindings')) {
      const cols = new Set(diagnostic.columnMap['im_context_bindings'] ?? [])
      const idCol = cols.has('id') ? 'id' : cols.has('source_jid') ? 'source_jid AS id' : 'rowid AS id'
      const accCol = cols.has('account_id') ? 'account_id' : "'' AS account_id"
      const wsCol = cols.has('workspace_id') ? 'workspace_id' : cols.has('workspace_jid') ? 'workspace_jid AS workspace_id' : 'NULL AS workspace_id'
      const natCol = cols.has('native_context_id') ? 'native_context_id' : cols.has('context_id') ? 'context_id AS native_context_id' : cols.has('source_jid') ? 'source_jid AS native_context_id' : "'' AS native_context_id"
      const actCol = cols.has('activation_mode') ? 'activation_mode' : "'auto' AS activation_mode"
      const chanCol = cols.has('channel') ? 'channel' : cols.has('context_type') ? 'context_type AS channel' : "'generic' AS channel"
      rawChannelBindings = (db.prepare(`SELECT ${idCol}, ${accCol}, ${wsCol}, ${natCol}, ${actCol}, ${chanCol} FROM im_context_bindings`).all() as unknown[]) as RawChannelBinding[]
    }

    // 8. Read Quotas & Model Preferences
    interface RawQuota {
      resource: string
      limit_val: number
      user_id?: string | null
    }
    let rawQuotas: RawQuota[] = []
    if (tableSet.has('quotas')) {
      rawQuotas = (db.prepare('SELECT resource, limit_val, user_id FROM quotas').all() as unknown[]) as RawQuota[]
    } else if (tableSet.has('user_quotas')) {
      const cols = new Set(diagnostic.columnMap['user_quotas'] ?? [])
      const userCol = cols.has('user_id') ? 'user_id' : 'NULL AS user_id'
      const limitCol = cols.has('monthly_token_limit') ? 'monthly_token_limit' : '1000000'
      rawQuotas = (db.prepare(`SELECT 'tokens' AS resource, ${limitCol} AS limit_val, ${userCol} FROM user_quotas`).all() as unknown[]) as RawQuota[]
    } else if (tableSet.has('billing_plans')) {
      const cols = new Set(diagnostic.columnMap['billing_plans'] ?? [])
      const limitCol = cols.has('token_limit') ? 'token_limit' : cols.has('monthly_token_quota') ? 'monthly_token_quota' : '1000000'
      const userCol = cols.has('user_id') ? 'user_id' : 'NULL AS user_id'
      rawQuotas = (db.prepare(`SELECT 'tokens' AS resource, ${limitCol} AS limit_val, ${userCol} FROM billing_plans`).all() as unknown[]) as RawQuota[]
    }

    interface RawModelPref {
      provider: string
      model: string
      reasoning_effort?: string | null
      user_id?: string | null
      workspace_id?: string | null
    }
    let rawModelPrefs: RawModelPref[] = []
    if (tableSet.has('conversation_runtime_state')) {
      const cols = new Set(diagnostic.columnMap['conversation_runtime_state'] ?? [])
      const provCol = cols.has('provider') ? 'provider' : cols.has('active_provider_family') ? 'active_provider_family AS provider' : cols.has('provider_family') ? 'provider_family AS provider' : "'default' AS provider"
      const modCol = cols.has('model') ? 'model' : cols.has('active_selected_model') ? 'active_selected_model AS model' : cols.has('selected_model') ? 'selected_model AS model' : cols.has('resolved_model') ? 'resolved_model AS model' : "'default' AS model"
      const rsnCol = cols.has('reasoning_effort') ? 'reasoning_effort' : 'NULL AS reasoning_effort'
      const userCol = cols.has('user_id') ? 'user_id' : 'NULL AS user_id'
      const wsCol = cols.has('workspace_id') ? 'workspace_id' : cols.has('group_folder') ? 'group_folder AS workspace_id' : 'NULL AS workspace_id'
      rawModelPrefs = (db.prepare(`SELECT ${provCol}, ${modCol}, ${rsnCol}, ${userCol}, ${wsCol} FROM conversation_runtime_state`).all() as unknown[]) as RawModelPref[]
    }

    // Process global instruction if present
    let globalInstructions: UserInstructionPlan | null = null
    if (groupsDir && existsSync(groupsDir)) {
      const globalClaude = join(groupsDir, 'CLAUDE.md')
      const globalMemory = join(groupsDir, 'memory.md')
      let chosenFile: string | null = null
      let instructionType: 'global_claude_md' | 'global_memory_md' = 'global_claude_md'

      if (existsSync(globalClaude) && lstatSync(globalClaude).isFile()) {
        chosenFile = globalClaude
        instructionType = 'global_claude_md'
      } else if (existsSync(globalMemory) && lstatSync(globalMemory).isFile()) {
        chosenFile = globalMemory
        instructionType = 'global_memory_md'
      }

      if (chosenFile) {
        try {
          const content = readFileSync(chosenFile, 'utf8')
          globalInstructions = {
            sourceFile: chosenFile,
            instructionType,
            targetUserId,
            contentPreview: content.slice(0, 150),
            byteSize: Buffer.byteLength(content, 'utf8'),
          }
        } catch {}
      }
    }

    let totalSessions = 0
    let totalMessages = 0
    let totalExtensions = 0
    let totalQuarantinedPlugins = 0
    let totalTasks = 0
    let totalChannels = 0

    // Construct Plan Items per Workspace
    const items: MigrationV2PlanItem[] = selectedWorkspaces.map((ws) => {
      const itemWarnings: string[] = []
      const folder = ws.folder || folderSlug(ws.name || ws.jid)
      const targetFolder = request.targetSpace ? validateGroupFolder(request.targetSpace, 'targetSpace') : validateGroupFolder(folder, 'space folder')
      const spaceName = request.targetSpace || ws.name || targetFolder

      // 1. User Snapshots
      const userSnapshots: UserSnapshotPlan[] = []
      if (scopes.coreData) {
        if (rawUsers.length > 0) {
          for (const u of rawUsers) {
            userSnapshots.push({
              sourceUserId: u.id,
              sourceUsername: u.username || u.name || u.id,
              targetUserId,
              targetRole: u.role === 'admin' ? 'admin' : 'user',
              displayName: u.name || u.username || u.id,
            })
          }
        } else {
          userSnapshots.push({
            sourceUserId: ws.created_by || 'hpc_user',
            sourceUsername: targetUserId,
            targetUserId,
            targetRole: 'user',
            displayName: targetUserId,
          })
        }
      }

      // 2. Agent Profile Snapshots
      const agentProfileSnapshots: AgentProfileSnapshotPlan[] = []
      if (scopes.coreData) {
        const wsAgents = rawAgents.filter((a) => a.workspace_id === ws.jid || a.workspace_id === folder || !a.workspace_id)
        for (const ag of wsAgents) {
          const prof = rawProfiles.find((p) => p.id === ag.profile_id)
          const prompt = prof?.system_prompt || ag.system_prompt || 'You are an intelligent assistant.'
          const name = prof?.name || ag.name || 'Assistant Profile'
          agentProfileSnapshots.push({
            sourceProfileId: prof?.id || ag.id,
            name,
            description: prof?.description || `Migrated profile for ${name}`,
            systemPromptSnapshot: prompt,
            version: prof?.version || 1,
            targetProfileId: `prof_${createHash('sha256').update(`${ws.jid}:${ag.id}`).digest('hex').slice(0, 16)}`,
          })
        }
      }

      // 3. Sessions & Messages
      const sessionPlans: SessionMigrationPlan[] = []
      if (scopes.coreData) {
        const wsChats = rawChats.filter((c) => c.jid === ws.jid || c.jid.startsWith(`${ws.jid}:`) || c.jid.includes(ws.jid))
        const effectiveChats = wsChats.length > 0 ? wsChats : [{ jid: ws.jid, name: ws.name }]

        for (const chat of effectiveChats) {
          const msgs = messagesByChat.get(chat.jid) ?? []
          const attachCount = msgs.filter((m) => m.attachments && m.attachments.trim() !== '').length
          const targetSessionId = deterministicSessionId(fingerprint, chat.jid, targetUserId)
          const targetRouteKey = `web:default:${targetUserId}:${targetSessionId}`

          sessionPlans.push({
            sourceChatJid: chat.jid,
            title: chat.name || spaceName,
            targetSessionId,
            targetRouteKey,
            messageCount: msgs.length,
            attachmentCount: attachCount,
          })
          totalSessions++
          totalMessages += msgs.length
        }
      }

      // 4. Instructions (CLAUDE.md / memory.md)
      let instructionPlan: SpaceInstructionPlan | null = null
      if (groupsDir && existsSync(groupsDir)) {
        const spaceSourceDir = join(groupsDir, folder)
        if (existsSync(spaceSourceDir)) {
          const claudeFile = join(spaceSourceDir, 'CLAUDE.md')
          const memFile = join(spaceSourceDir, 'memory.md')
          let chosen: string | null = null
          let type: 'claude_md' | 'memory_md' | 'combined' = 'claude_md'

          if (existsSync(claudeFile) && existsSync(memFile)) {
            chosen = claudeFile
            type = 'combined'
          } else if (existsSync(claudeFile)) {
            chosen = claudeFile
            type = 'claude_md'
          } else if (existsSync(memFile)) {
            chosen = memFile
            type = 'memory_md'
          }

          if (chosen) {
            try {
              const content = readFileSync(chosen, 'utf8')
              instructionPlan = {
                spaceFolder: targetFolder,
                sourceFile: chosen,
                instructionType: type,
                targetPath: `${targetFolder}/INSTRUCTIONS.md`,
                contentPreview: content.slice(0, 150),
                byteSize: Buffer.byteLength(content, 'utf8'),
              }
            } catch {}
          }
        }
      }

      // 5. Extensions (Skills, MCP, Plugins) -> M30 unified catalog
      const extensionPlans: ExtensionMigrationPlan[] = []
      if (scopes.extensions) {
        // 5.1 Skills
        const wsSkills = rawSkills.filter((s) => s.space_id === ws.jid || s.space_id === folder || s.scope === 'global')
        for (const s of wsSkills) {
          const slug = folderSlug(s.name)
          extensionPlans.push({
            sourceId: s.id,
            name: s.name,
            slug,
            kind: 'skill',
            description: `Imported HappyClaw skill: ${s.name}`,
            sourceKind: (s.source_type === 'git' ? 'git' : s.source_type === 'upload' ? 'archive' : 'builtin'),
            sourceRef: s.source_url || null,
            targetPackageSlug: slug,
            targetContributionKey: `skill_${slug}`,
            status: 'active',
            quarantined: false,
            spaceBinding: targetFolder,
          })
          totalExtensions++
        }

        // 5.2 MCP
        const wsMcp = rawMcp.filter((m) => m.workspace_id === ws.jid || m.workspace_id === folder)
        for (const m of wsMcp) {
          const slug = folderSlug(m.name)
          extensionPlans.push({
            sourceId: m.id,
            name: m.name,
            slug,
            kind: 'mcp',
            description: `Imported MCP server: ${m.name}`,
            sourceKind: 'builtin',
            sourceRef: m.command || null,
            targetPackageSlug: slug,
            targetContributionKey: `mcp_${slug}`,
            status: 'active',
            quarantined: false,
            spaceBinding: targetFolder,
          })
          totalExtensions++
        }

        // 5.3 Plugins & Quarantine Policy
        const wsPlugins = rawPlugins.filter((p) => p.workspace_id === ws.jid || p.workspace_id === folder)
        for (const p of wsPlugins) {
          const slug = folderSlug(p.name)
          const isCompiledTrusted = p.source === 'enkeep.echo' || slug === 'trusted-echo' || p.name === 'enkeep.echo'
          const isUntrusted = !isCompiledTrusted || p.trusted === 0 || p.status === 'untrusted' || p.name.includes('untrusted')
          const quarantined = isUntrusted
          const status = quarantined ? 'disabled' : 'active'
          const quarantineReason = quarantined
            ? `Untrusted or uncompiled external plugin quarantined during migration: requires administrative verification before enablement`
            : undefined

          if (quarantined) {
            totalQuarantinedPlugins++
            itemWarnings.push(`Plugin "${p.name}" is quarantined: disabled by security policy`)
          }

          extensionPlans.push({
            sourceId: p.id,
            name: p.name,
            slug,
            kind: 'dsh-plugin',
            description: `Imported plugin: ${p.name}`,
            sourceKind: 'archive',
            sourceRef: p.source || null,
            targetPackageSlug: slug,
            targetContributionKey: `plugin_${slug}`,
            status,
            quarantined,
            quarantineReason,
            spaceBinding: targetFolder,
          })
          totalExtensions++
        }
      }

      // 6. Tasks
      const taskPlans: TaskMigrationPlan[] = []
      if (scopes.tasks) {
        const wsTasks = rawTasks.filter((t) => t.workspace_id === ws.jid || t.group_jid === ws.jid || t.workspace_id === folder)
        for (const t of wsTasks) {
          const prio = (t.priority === 'urgent' || t.priority === 'high' || t.priority === 'low') ? t.priority : 'normal'
          taskPlans.push({
            sourceTaskId: t.id,
            title: t.title,
            prompt: t.prompt,
            cronExpression: t.cron_expression || null,
            priority: prio,
            targetSpaceFolder: targetFolder,
          })
          totalTasks++
        }
      }

      // 7. Channel Bindings (Lark, WeChat to M31)
      const channelBindingsPlans: ChannelBindingMigrationPlan[] = []
      if (scopes.channelsMetadata) {
        const wsBindings = rawChannelBindings.filter((b) => b.workspace_id === ws.jid || b.group_jid === ws.jid || b.workspace_id === folder)
        for (const b of wsBindings) {
          const chType = b.channel || (channelFromJid(ws.jid) !== 'unknown' ? channelFromJid(ws.jid) : 'generic')
          channelBindingsPlans.push({
            sourceBindingId: b.id,
            channelType: chType,
            nativeContextId: b.native_context_id || ws.jid,
            targetSpaceFolder: targetFolder,
            activationMode: b.activation_mode === 'always' ? 'always' : 'mention',
            cutoverDeferred: true,
          })
          totalChannels++
        }
      }

      // 8. Quotas
      const quotaPlans: QuotaMigrationPlan[] = []
      if (scopes.coreData) {
        for (const q of rawQuotas) {
          quotaPlans.push({
            resource: q.resource,
            limit: q.limit_val,
            targetUserId,
          })
        }
      }

      // 9. Model Preferences
      const modelPrefPlans: ModelPrefMigrationPlan[] = []
      if (scopes.coreData) {
        const wsPrefs = rawModelPrefs.filter((p) => p.workspace_id === ws.jid || p.workspace_id === folder || !p.workspace_id)
        for (const p of wsPrefs) {
          modelPrefPlans.push({
            provider: p.provider,
            model: p.model,
            reasoningEffort: p.reasoning_effort || null,
            targetUserId,
          })
        }
      }

      return {
        workspaceId: ws.jid,
        workspaceName: ws.name || ws.jid,
        targetSpaceFolder: targetFolder,
        targetSpaceName: spaceName,
        userSnapshots,
        agentProfileSnapshots,
        sessionPlans,
        instructionPlan,
        extensionPlans,
        taskPlans,
        channelBindingsPlans,
        quotaPlans,
        modelPrefPlans,
        warnings: itemWarnings,
      }
    })

    // Process Channel Accounts
    const channelAccounts: ChannelAccountMigrationPlan[] = []
    if (scopes.channelsMetadata) {
      for (const acc of rawChannelAccounts) {
        channelAccounts.push({
          sourceAccountId: acc.id,
          channelType: acc.type,
          name: acc.name || acc.id,
          status: acc.status === 'disabled' ? 'disabled' : acc.status === 'unverified' ? 'unverified' : 'active',
          credentialRef: acc.credential_ref || null,
          hasCredentialAuthorization: Boolean(acc.credential_ref),
          cutoverDeferred: true,
        })
      }
    }

    const planId = computeDeterministicPlanId(
      fingerprint,
      targetUserId,
      Array.from(selectedIds),
      scopes
    )

    const plan: MigrationPlanV2 = {
      version: 2,
      planId,
      sourcePath: realDbPath,
      sourceFingerprint: fingerprint,
      targetUserId,
      scopes,
      selectedWorkspaceIds: Array.from(selectedIds),
      summary: {
        totalWorkspaces: items.length,
        totalSessions,
        totalMessages,
        totalExtensions,
        totalQuarantinedPlugins,
        totalTasks,
        totalChannels,
        totalCredentialsToTransfer: channelAccounts.length,
      },
      items,
      globalInstructions,
      channelAccounts,
      warnings,
      createdAt: new Date().toISOString(),
    }

    return plan
  } finally {
    db.close()
  }
}
