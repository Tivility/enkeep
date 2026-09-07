import { folderSlug, messageIdFor, sessionIdFor } from './ids.js'
import { validateGroupFolder } from './guard.js'
import type {
  AnomalyRecord,
  ChatReport,
  ChatRow,
  CompiledChat,
  GroupRow,
  MessageRow,
  SeedEvent,
} from './types.js'

export interface CompileChatsOptions {
  readonly sessionIdGenerator?: (chatJid: string) => string
  readonly folderResolver?: (chat: ChatRow, group?: GroupRow) => string
}

export function compileChats(
  chats: ChatRow[],
  messages: MessageRow[],
  groups: GroupRow[],
  options?: CompileChatsOptions
): CompiledChat[] {
  const groupByJid = new Map(groups.map((row) => [row.jid, row]))
  const byChat = new Map<string, MessageRow[]>()

  for (const message of messages) {
    const list = byChat.get(message.chat_jid) ?? []
    list.push(message)
    byChat.set(message.chat_jid, list)
  }

  return chats.map((chat) => {
    const group = groupByJid.get(chat.jid)
    let folder: string
    if (options?.folderResolver) {
      folder = options.folderResolver(chat, group)
    } else {
      const rawFolder = group?.folder || folderSlug(chat.name || chat.jid)
      folder = validateGroupFolder(rawFolder, `chat "${chat.jid}" folder`)
    }

    const sessionId = options?.sessionIdGenerator
      ? options.sessionIdGenerator(chat.jid)
      : sessionIdFor(chat.jid)

    const rows = byChat.get(chat.jid) ?? []
    const compiled = compileSeed(chat.jid, rows)

    const anomalies: AnomalyRecord[] = [...compiled.anomalies]

    if (!group) {
      anomalies.push({
        type: 'missing_group_registration',
        chatJid: chat.jid,
        detail: `Chat "${chat.name ?? chat.jid}" has no entry in registered_groups; defaulted folder to "${folder}"`,
      })
    } else if (group.execution_mode && group.execution_mode !== 'former-host' && group.execution_mode !== 'default' && group.execution_mode !== 'container') {
      anomalies.push({
        type: 'unknown_execution_mode',
        chatJid: chat.jid,
        detail: `Group execution mode "${group.execution_mode}" is non-standard`,
      })
    }

    return {
      chatJid: chat.jid,
      folder,
      sessionId,
      seed: compiled.seed,
      report: {
        ...compiled.report,
        folder,
        sessionId,
        executionMode: group?.execution_mode ?? null,
      },
      anomalies,
    }
  })
}

export function compileSeed(
  chatJid: string,
  rows: MessageRow[],
): { seed: SeedEvent[]; report: ChatReport; anomalies: AnomalyRecord[] } {
  const ordered = [...rows].sort(compareMessages)
  const events: SeedEvent[] = []
  const anomalies: AnomalyRecord[] = []

  let seq = 0
  let time = 0
  let haveTime = false
  let turn = 1
  let droppedEmpty = 0
  let attachments = 0
  let unpairedAssistants = 0
  let consecutiveUserMessages = 0
  let consecutiveAssistantMessages = 0
  let lastWasUser = false
  let hasUserBefore = false

  const nextTime = (raw: string | null, messageId: string): number => {
    const parsed = parseTimestamp(raw)
    if (parsed !== undefined) {
      haveTime = true
      time = Math.max(time, parsed)
      return time
    }

    if (raw === null || raw.trim() === '') {
      anomalies.push({
        type: 'missing_timestamp',
        chatJid,
        messageId,
        rawTimestamp: raw,
        assignedTime: haveTime ? time + 1 : 0,
        detail: 'Message has null or empty timestamp; assigned monotonic sequential time',
      })
    } else {
      anomalies.push({
        type: 'invalid_timestamp',
        chatJid,
        messageId,
        rawTimestamp: raw,
        assignedTime: haveTime ? time + 1 : 0,
        detail: `Message has unparseable timestamp "${raw}"; assigned monotonic sequential time`,
      })
    }

    if (!haveTime) {
      haveTime = true
      time = 0
      return time
    }
    time += 1
    return time
  }

  const push = (event: SeedEvent): void => {
    events.push(event)
    seq += 1
  }

  for (const row of ordered) {
    if (hasAttachment(row.attachments)) {
      attachments += 1
      const note = attachmentNote(row.attachments)
      if (note) {
        anomalies.push({
          type: 'attachment_referenced',
          chatJid,
          messageId: row.id,
          detail: `Attachment normalized to relative note: ${note}`,
        })
      }
    }

    const text = peopleTalk(row)
    if (text === undefined) {
      droppedEmpty += 1
      anomalies.push({
        type: 'empty_message',
        chatJid,
        messageId: row.id,
        detail: 'Dropped empty message with no content and no valid attachment',
      })
      continue
    }

    const stamp = nextTime(row.timestamp, row.id)

    if (row.is_from_me === 1) {
      if (!lastWasUser) {
        if (!hasUserBefore) {
          unpairedAssistants += 1
          anomalies.push({
            type: 'unpaired_assistant',
            chatJid,
            messageId: row.id,
            detail: 'Assistant message appears before any user message in conversation',
          })
        } else {
          consecutiveAssistantMessages += 1
          anomalies.push({
            type: 'consecutive_assistant_message',
            chatJid,
            messageId: row.id,
            detail: 'Assistant message immediately follows another assistant message',
          })
        }
      }

      push({ type: 'turn/start', seq, time: stamp, data: { turn } })
      push({ type: 'step/start', seq, time: stamp, data: { turn, step: 1 } })
      push({
        type: 'assistant/message',
        seq,
        time: stamp,
        surfaceOp: 'append',
        data: {
          turn,
          step: 1,
          message: {
            id: messageIdFor(chatJid, row.id),
            role: 'assistant',
            content: [{ type: 'text', text }],
            source: { kind: 'model', provider: 'import', model: 'happyclaw' },
          },
        },
      })
      push({ type: 'step/end', seq, time: stamp, data: { turn, step: 1 } })
      push({ type: 'turn/end', seq, time: stamp, data: { turn, reason: { kind: 'completed' } } })
      turn += 1
      lastWasUser = false
      continue
    }

    if (lastWasUser) {
      consecutiveUserMessages += 1
      anomalies.push({
        type: 'consecutive_user_message',
        chatJid,
        messageId: row.id,
        detail: 'User message immediately follows another user message before assistant responded',
      })
    }

    lastWasUser = true
    hasUserBefore = true
    push({
      type: 'user/message',
      seq,
      time: stamp,
      surfaceOp: 'append',
      data: {
        id: messageIdFor(chatJid, row.id),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      },
    })
  }

  if (events.length > 0) {
    push({
      type: 'session/end-seed',
      seq,
      time,
      data: {},
    })
  }

  const importedPeopleTalk = rows.length - droppedEmpty

  return {
    seed: events,
    report: {
      chatJid,
      folder: '',
      sessionId: sessionIdFor(chatJid),
      sourceMessages: rows.length,
      importedPeopleTalk,
      droppedEmpty,
      attachments,
      unpairedAssistants,
      consecutiveUserMessages,
      consecutiveAssistantMessages,
      executionMode: null,
    },
    anomalies,
  }
}

function hasAttachment(raw: string | null): boolean {
  return raw !== null && raw.trim() !== ''
}

export function compareMessages(a: MessageRow, b: MessageRow): number {
  const atParsed = parseTimestamp(a.timestamp)
  const btParsed = parseTimestamp(b.timestamp)
  if (atParsed !== undefined && btParsed !== undefined && atParsed !== btParsed) {
    return atParsed < btParsed ? -1 : 1
  }
  const at = a.timestamp ?? ''
  const bt = b.timestamp ?? ''
  if (at !== bt) return at < bt ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function parseTimestamp(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === '') return undefined
  const asNumber = Number(raw)
  if (Number.isSafeInteger(asNumber) && asNumber >= 0) return asNumber
  const parsed = Date.parse(raw)
  if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed
  return undefined
}

export function peopleTalk(row: MessageRow): string | undefined {
  const text = (row.content ?? '').trim()
  const attachmentLine = attachmentNote(row.attachments)
  if (text !== '' && attachmentLine !== undefined) return `${text}\n${attachmentLine}`
  if (text !== '') return text
  if (attachmentLine !== undefined) return attachmentLine
  return undefined
}

export const ATTACHMENT_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/

/**
 * Validates a relative attachment path segment-by-segment.
 * Strictly rejects absolute paths, backslashes, control characters, '..' or '.' segments.
 * Segments must match /^[A-Za-z0-9._-]+$/.
 */
export function validateRelativeAttachmentPath(rawPath: string): string {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new Error('attachment path must be a non-empty string')
  }

  if (rawPath.startsWith('/') || rawPath.includes('\\')) {
    throw new Error(`invalid attachment path "${rawPath}": absolute paths and backslashes are forbidden`)
  }

  if (/[\x00-\x1F\x7F]/.test(rawPath)) {
    throw new Error(`invalid attachment path "${rawPath}": control characters are forbidden`)
  }

  const segments = rawPath.split('/')
  if (segments.length === 0) {
    throw new Error(`invalid empty attachment path: "${rawPath}"`)
  }

  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') {
      throw new Error(`invalid attachment path segment "${segment}" in path "${rawPath}"`)
    }
    if (!ATTACHMENT_SEGMENT_PATTERN.test(segment)) {
      throw new Error(
        `attachment path segment "${segment}" does not match allowed pattern ${ATTACHMENT_SEGMENT_PATTERN.source}`
      )
    }
  }

  return segments.join('/')
}

/**
 * Parses attachment info into relative space note lines.
 * Strictly parses JSON (no suppression) and validates relative path segments.
 */
export function attachmentNote(raw: string | null): string | undefined {
  if (raw === null || raw.trim() === '') return undefined

  const parsed = JSON.parse(raw)
  const items = Array.isArray(parsed) ? parsed : [parsed]
  const names = items.map(attachmentName).filter((name): name is string => name !== undefined)
  if (names.length === 0) return '见空间内 附件'
  return names.map((name) => `见空间内 ${name}`).join('\n')
}

function attachmentName(item: unknown): string | undefined {
  if (typeof item === 'string' && item.trim() !== '') {
    try {
      return validateRelativeAttachmentPath(item.trim())
    } catch {
      return undefined
    }
  }
  if (typeof item !== 'object' || item === null) return undefined
  const record = item as Record<string, unknown>
  for (const key of ['path', 'name', 'filename', 'file']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') {
      try {
        return validateRelativeAttachmentPath(value.trim())
      } catch {
        // Ignore invalid segments
      }
    }
  }
  if (typeof record.mimeType === 'string' && record.mimeType.trim() !== '') {
    try {
      return validateRelativeAttachmentPath(record.mimeType.trim())
    } catch {
      // Ignore
    }
  }
  if (typeof record.type === 'string' && record.type.trim() !== '') {
    try {
      return validateRelativeAttachmentPath(record.type.trim())
    } catch {
      // Ignore
    }
  }
  return undefined
}
