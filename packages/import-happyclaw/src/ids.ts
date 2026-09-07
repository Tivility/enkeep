import { createHash } from 'node:crypto'

/**
 * Stable SessionId for one HappyClaw chat using sha256 chatJid v1 algorithm.
 * Returns `import-${digestHex.slice(0, 32)}`.
 */
export function sessionIdFor(chatJid: string): string {
  const digest = createHash('sha256').update(chatJid).digest('hex').slice(0, 32)
  return `import-${digest}`
}

/**
 * Deterministic Session ID for generic migration/fork based on source fingerprint, chatJid, and optional userId.
 * Always conforms strictly to canonical pattern `import-[0-9a-f]{32}`.
 */
export function deterministicSessionId(
  sourceFingerprint: string,
  chatJid: string,
  userId?: string
): string {
  const payload = userId ? `${userId}:${sourceFingerprint}:${chatJid}` : `${sourceFingerprint}:${chatJid}`
  const digest = createHash('sha256').update(payload).digest('hex').slice(0, 32)
  return `import-${digest}`
}

/**
 * Stable message id so repeated imports emit identical seeds.
 * Returns `import:${chatJid}:${messageId}`.
 */
export function messageIdFor(chatJid: string, messageId: string): string {
  return `import:${chatJid}:${messageId}`
}

/**
 * Deterministic space ID for an imported/forked folder.
 * Returns `impsp_${digestHex}`.
 */
export function deterministicSpaceId(
  userId: string,
  sourceFingerprint: string,
  folder: string
): string {
  const digest = createHash('sha256').update(`${userId}:${sourceFingerprint}:${folder}`).digest('hex')
  return `impsp_${digest}`
}

/**
 * Deterministic source provenance row ID.
 * Returns `impsrc_${digestHex}`.
 */
export function deterministicSourceProvenanceId(
  userId: string,
  sourceFingerprint: string,
  chatJid: string
): string {
  const digest = createHash('sha256').update(`${userId}:${sourceFingerprint}:${chatJid}`).digest('hex')
  return `impsrc_${digest}`
}

/**
 * Workspace folder fallback when registered_groups has no row.
 * Generates valid folder slug matching /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.
 */
export function folderSlug(nameOrJid: string): string {
  const slug = nameOrJid
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 64)
  return slug || 'chat'
}

/**
 * Infers channel/provider prefix from a HappyClaw JID or address.
 */
export function channelFromJid(jid: string): string {
  if (!jid || typeof jid !== 'string') return 'unknown'
  const colonIdx = jid.indexOf(':')
  if (colonIdx > 0) {
    const prefix = jid.slice(0, colonIdx).toLowerCase()
    if (prefix === 'web' || prefix === 'chat') return 'web'
    if (prefix.startsWith('feishu')) return 'feishu'
    if (prefix === 'tg' || prefix === 'telegram') return 'telegram'
    if (prefix === 'wa' || prefix === 'whatsapp') return 'whatsapp'
    if (prefix === 'slack') return 'slack'
    if (prefix === 'dingtalk' || prefix === 'ding') return 'dingtalk'
    if (prefix === 'discord') return 'discord'
    if (prefix === 'wechat' || prefix === 'wx') return 'wechat'
    return prefix
  }
  if (jid.includes('@g.us') || jid.includes('@group')) return 'group'
  if (jid.includes('@s.whatsapp.net')) return 'whatsapp'
  return 'dm'
}
