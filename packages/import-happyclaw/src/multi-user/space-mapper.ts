import { createHash } from 'node:crypto'
import { validateGroupFolder } from '../guard.js'
import { deterministicSpaceId, folderSlug } from '../ids.js'
import type { DisambiguatedSpaceMapping } from './types.js'

export interface RawWorkspaceRow {
  readonly jid: string
  readonly name?: string | null
  readonly folder?: string | null
  readonly execution_mode?: string | null
  readonly is_home?: number | boolean | null
  readonly created_by?: string | null
  readonly owner_user_id?: string | null
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex')
}

/**
 * Normalizes a string into a clean alphanumeric slug suitable for folder names.
 */
function sanitizeSlug(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return cleaned || 'space'
}

/**
 * Disambiguates a folder name to fit within the 64-character GROUP_FOLDER_PATTERN:
 * `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`
 */
function constructSafeFolder(baseFolder: string, suffix: string, salt: string): string {
  const candidate = `${baseFolder}--${suffix}`
  if (candidate.length <= 64 && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(candidate)) {
    return candidate
  }

  const shortHash = sha256Hex(salt).slice(0, 8)
  const availableLen = 64 - 2 - shortHash.length - 2 // space for "--<hash>--"
  const halfBase = Math.min(30, baseFolder.length)
  const halfSuffix = Math.max(10, availableLen - halfBase)

  const cleanBase = baseFolder.slice(0, halfBase).replace(/-+$/, '')
  const cleanSuffix = suffix.slice(0, halfSuffix).replace(/^-+|-+$/g, '')
  const result = `${cleanBase}--${cleanSuffix}--${shortHash}`

  // Ensure first character is alphanumeric
  if (!/^[A-Za-z0-9]/.test(result)) {
    return `spc-${result.slice(4, 64)}`
  }

  return result.slice(0, 64)
}

/**
 * Maps and disambiguates workspaces for a target user.
 * Specifically handles users like `cxx` where multiple workspaces share one physical folder (e.g. `home-<uid>`),
 * ensuring each Enkeep space is given its own independent folder without cross-contamination.
 */
export function mapUserSpaces(
  workspaces: readonly RawWorkspaceRow[],
  targetUserId: string,
  sourceFingerprint: string
): DisambiguatedSpaceMapping[] {
  if (workspaces.length === 0) {
    return []
  }

  // 1. Group workspaces by raw source folder
  const byFolder = new Map<string, RawWorkspaceRow[]>()
  for (const ws of workspaces) {
    let rawFolder = ws.folder || 'main'
    try {
      rawFolder = validateGroupFolder(rawFolder, 'source workspace folder')
    } catch {
      rawFolder = folderSlug(ws.folder || ws.name || ws.jid)
    }
    const list = byFolder.get(rawFolder) ?? []
    list.push(ws)
    byFolder.set(rawFolder, list)
  }

  const results: DisambiguatedSpaceMapping[] = []

  // 2. For each folder group, assign unique target folders
  for (const [srcFolder, list] of byFolder.entries()) {
    if (list.length === 1) {
      // Single workspace using this folder: clean 1:1 mapping
      const ws = list[0]!
      const targetFolder = srcFolder
      const spaceId = deterministicSpaceId(targetUserId, sourceFingerprint, targetFolder)
      const isHome = Boolean(ws.is_home === 1 || ws.is_home === true || ws.jid.startsWith('web:home-'))

      results.push({
        workspaceJid: ws.jid,
        workspaceName: ws.name || srcFolder,
        srcFolder,
        targetFolder,
        spaceId,
        executionMode: 'container',
        isHome,
        isDisambiguated: false,
      })
      continue
    }

    // Multiple workspaces sharing one home directory (e.g. cxx's 7 workspaces sharing home-<uid>)
    // Find designated home workspace if present
    const homeIdx = list.findIndex(
      (w) => w.is_home === 1 || w.is_home === true || w.jid.startsWith('web:home-')
    )
    const primaryHomeWs = homeIdx >= 0 ? list[homeIdx] : list[0]

    for (let i = 0; i < list.length; i++) {
      const ws = list[i]!
      const isPrimary = ws === primaryHomeWs

      if (isPrimary) {
        // Home workspace retains original base folder
        const targetFolder = srcFolder
        const spaceId = deterministicSpaceId(targetUserId, sourceFingerprint, targetFolder)

        results.push({
          workspaceJid: ws.jid,
          workspaceName: ws.name || `${srcFolder} Home`,
          srcFolder,
          targetFolder,
          spaceId,
          executionMode: 'container',
          isHome: true,
          isDisambiguated: false,
        })
      } else {
        // Disambiguate with channel & identifier/name
        const cleanName = ws.name ? ws.name.toLowerCase().replace(/[^a-z0-9._-]/g, '') : ''
        const jidId = ws.jid.replace(/^(feishu|wechat|web):/, '').split(/[@#]/)[0] || ''
        const cleanJidId = jidId.toLowerCase().replace(/[^a-z0-9._-]/g, '')

        let suffix = ''
        if (ws.jid.startsWith('feishu:')) {
          const part = cleanName || cleanJidId || sha256Hex(ws.jid).slice(0, 8)
          suffix = `feishu-${part}`
        } else if (ws.jid.startsWith('wechat:')) {
          const part = cleanName || cleanJidId || sha256Hex(ws.jid).slice(0, 8)
          suffix = `wechat-${part}`
        } else {
          const part = cleanName || cleanJidId || sha256Hex(ws.jid).slice(0, 8)
          suffix = `sub-${part}`
        }

        const targetFolder = constructSafeFolder(srcFolder, suffix, ws.jid)
        validateGroupFolder(targetFolder, `disambiguated target folder for ${ws.jid}`)
        const spaceId = deterministicSpaceId(targetUserId, sourceFingerprint, targetFolder)

        results.push({
          workspaceJid: ws.jid,
          workspaceName: ws.name || targetFolder,
          srcFolder,
          targetFolder,
          spaceId,
          executionMode: 'container',
          isHome: false,
          isDisambiguated: true,
          disambiguationReason: `Workspace shares source home directory "${srcFolder}" with primary home space; assigned isolated target folder to prevent cross-contamination`,
        })
      }
    }
  }

  return results
}
