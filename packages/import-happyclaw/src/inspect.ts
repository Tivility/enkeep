import { existsSync } from 'node:fs'
import { computeSourceFingerprint } from './manifest.js'
import { channelFromJid, folderSlug } from './ids.js'
import { readSource } from './read-source.js'
import type {
  ConversationInspectSummary,
  GroupRow,
  MessageRow,
  SourceInspectResult,
} from './types.js'

export interface InspectSourceOptions {
  readonly sourcePath: string
  readonly groupsDir?: string
}

/**
 * Inspects a HappyClaw SQLite database without mutating it.
 * Returns structured metadata on all conversations/groups, message counts,
 * time spans, channels, and schema diagnostic.
 * Does NOT include message body content.
 */
export function inspectSource(options: InspectSourceOptions): SourceInspectResult {
  const { sourcePath, groupsDir } = options
  const { chats, messages, groups, diagnostic } = readSource(sourcePath)

  const fingerprint = computeSourceFingerprint(sourcePath, groupsDir)
  const groupByJid = new Map<string, GroupRow>(groups.map((g) => [g.jid, g]))

  const messagesByChat = new Map<string, MessageRow[]>()
  for (const msg of messages) {
    const list = messagesByChat.get(msg.chat_jid) ?? []
    list.push(msg)
    messagesByChat.set(msg.chat_jid, list)
  }

  const summaries: ConversationInspectSummary[] = chats.map((chat) => {
    const group = groupByJid.get(chat.jid)
    const chatMsgs = messagesByChat.get(chat.jid) ?? []

    const timestamps = chatMsgs
      .map((m) => m.timestamp)
      .filter((t): t is string => t !== null && t !== undefined && t.trim() !== '')
      .sort()

    const senders = new Set(
      chatMsgs
        .map((m) => (m.is_from_me ? 'assistant' : m.sender || m.sender_name || 'user'))
        .filter(Boolean)
    )

    const hasAttachments = chatMsgs.some(
      (m) => m.attachments !== null && m.attachments !== undefined && m.attachments.trim() !== ''
    )

    const rawFolder = group?.folder || folderSlug(chat.name || chat.jid)
    const channel = channelFromJid(chat.jid)

    return {
      sourceKey: chat.jid,
      name: chat.name || group?.name || chat.jid,
      channel,
      folder: rawFolder,
      executionMode: group?.execution_mode ?? null,
      messageCount: chatMsgs.length,
      firstMessageAt: timestamps[0] ?? null,
      lastMessageAt: timestamps[timestamps.length - 1] ?? null,
      senderCount: senders.size,
      hasAttachments,
    }
  })

  // Sort by lastMessageAt desc or messageCount desc
  summaries.sort((a, b) => {
    if (a.lastMessageAt && b.lastMessageAt) {
      return b.lastMessageAt.localeCompare(a.lastMessageAt)
    }
    return b.messageCount - a.messageCount
  })

  return {
    sourcePath,
    sourceFingerprint: fingerprint,
    diagnostic,
    totalConversations: summaries.length,
    totalMessages: messages.length,
    conversations: summaries,
  }
}

/**
 * Formats a SourceInspectResult into a human-readable CLI table/summary without message bodies.
 */
export function formatInspectSummary(result: SourceInspectResult): string {
  const lines: string[] = []
  lines.push('================================================================================')
  lines.push('                    HappyClaw Source Inspection Report                          ')
  lines.push('================================================================================')
  lines.push(`Source Database:   ${result.sourcePath}`)
  lines.push(`Fingerprint:       ${result.sourceFingerprint}`)
  lines.push(`Schema Version:    ${result.diagnostic.detectedSchemaVersion ?? 'unknown'}`)
  lines.push(`Compatibility:     ${result.diagnostic.compatibilityLevel}`)
  lines.push(`Total Chats:       ${result.totalConversations}`)
  lines.push(`Total Messages:    ${result.totalMessages}`)
  lines.push('--------------------------------------------------------------------------------')

  if (result.diagnostic.issues.length > 0) {
    lines.push('Diagnostic Warnings:')
    for (const issue of result.diagnostic.issues) {
      lines.push(`  [!] ${issue}`)
    }
    lines.push('--------------------------------------------------------------------------------')
  }

  if (result.conversations.length === 0) {
    lines.push('No conversations found in source database.')
    return lines.join('\n')
  }

  lines.push(
    [
      '#'.padEnd(4),
      'Source Key (JID)'.padEnd(30),
      'Name'.padEnd(20),
      'Channel'.padEnd(10),
      'Msgs'.padStart(6),
      'First Message'.padEnd(22),
      'Last Message'.padEnd(22),
    ].join(' | ')
  )
  lines.push('-'.repeat(124))

  result.conversations.forEach((conv, idx) => {
    const num = String(idx + 1).padEnd(4)
    const key = (conv.sourceKey.length > 28 ? conv.sourceKey.slice(0, 25) + '...' : conv.sourceKey).padEnd(30)
    const name = (conv.name.length > 18 ? conv.name.slice(0, 15) + '...' : conv.name).padEnd(20)
    const chan = conv.channel.padEnd(10)
    const msgs = String(conv.messageCount).padStart(6)
    const first = (conv.firstMessageAt ? conv.firstMessageAt.slice(0, 19) : 'n/a').padEnd(22)
    const last = (conv.lastMessageAt ? conv.lastMessageAt.slice(0, 19) : 'n/a').padEnd(22)
    lines.push(`${num} | ${key} | ${name} | ${chan} | ${msgs} | ${first} | ${last}`)
  })

  lines.push('================================================================================')
  lines.push('Use `--conversation <SourceKey>` to migrate or fork specific conversations.')
  return lines.join('\n')
}
