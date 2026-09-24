import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import type { ChannelAccountPlanItem } from './types.js'

export interface ChannelCredentialInfo {
  readonly accountId: string
  readonly channelType: 'lark' | 'wechat' | string
  readonly name: string
  readonly status: 'disabled'
  readonly credentialRef: string
  readonly encryptedPayload: string | null
  readonly isPlaceholder: boolean
}

/**
 * Derives or validates a 32-byte encryption key for channel credentials.
 */
export function resolveMasterEncryptionKey(masterKey?: Buffer | string): Buffer {
  if (masterKey) {
    if (Buffer.isBuffer(masterKey)) {
      if (masterKey.length === 32) return masterKey
      return createHash('sha256').update(masterKey).digest()
    }
    if (typeof masterKey === 'string' && masterKey.trim().length > 0) {
      if (/^[0-9a-fA-F]{64}$/.test(masterKey.trim())) {
        return Buffer.from(masterKey.trim(), 'hex')
      }
      return createHash('sha256').update(masterKey, 'utf8').digest()
    }
  }
  // Deterministic local key if none provided
  return createHash('sha256').update('enkeep-channel-master-encryption-key-v1', 'utf8').digest()
}

/**
 * Encrypts a payload string with AES-256-GCM using AAD `${userId}:${credentialRef}`.
 * Produces format: `v1:${ivHex}:${tagHex}:${ciphertextHex}` matching LarkEncryptedCredentialStore.
 */
export function encryptCredentialWithAad(
  key: Buffer,
  plaintextPayload: string,
  userId: string,
  credentialRef: string
): string {
  const iv = randomBytes(12)
  const aad = Buffer.from(`${userId}:${credentialRef}`, 'utf8')
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad)

  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintextPayload, 'utf8')),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()

  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`
}

/**
 * Prepares channel account and encrypted credential material strictly offline (no network).
 * Guarantees:
 * - Feishu credentials encrypted with AES-256-GCM but status forced to 'disabled'
 * - WeChat accounts set to status 'disabled', preserving encrypted credentials if format known, else placeholder
 * - Zero network calls
 */
export function prepareChannelAccountCredential(
  acc: { id: string; provider?: string; type?: string; name?: string; config?: any },
  userId: string,
  masterKey: Buffer,
  rawCredentials?: any
): ChannelCredentialInfo {
  const channelType = acc.provider === 'feishu' || acc.type === 'lark' ? 'lark' : 'wechat'
  const name = acc.name || (channelType === 'lark' ? '飞书机器人' : '微信账号')

  if (channelType === 'lark') {
    const creds = rawCredentials || acc.config
    const appId = creds?.appId || creds?.app_id
    const appSecret = creds?.appSecret || creds?.app_secret

    if (appId && appSecret) {
      const nonce = randomBytes(8).toString('hex')
      const sanitizedAppId = String(appId).replace(/[^a-zA-Z0-9_]/g, '_')
      const credentialRef = `cred_lark_${sanitizedAppId}_${nonce}`

      const payload = JSON.stringify({
        appId: String(appId),
        appSecret: String(appSecret),
        domain: creds.domain ?? 'feishu',
        botOpenId: creds.ownerOpenId ?? creds.botOpenId,
        tenantId: creds.tenantId,
      })

      const encryptedPayload = encryptCredentialWithAad(masterKey, payload, userId, credentialRef)

      return {
        accountId: acc.id,
        channelType: 'lark',
        name,
        status: 'disabled', // Forced DISABLED as required
        credentialRef,
        encryptedPayload,
        isPlaceholder: false,
      }
    }

    // No raw secret available: record placeholder ref, status disabled
    const placeholderRef = `reauth_required_feishu_${acc.id.slice(0, 16)}`
    return {
      accountId: acc.id,
      channelType: 'lark',
      name,
      status: 'disabled',
      credentialRef: placeholderRef,
      encryptedPayload: null,
      isPlaceholder: true,
    }
  }

  // WeChat channel account
  const wechatCreds = rawCredentials || acc.config
  if (wechatCreds && typeof wechatCreds === 'object' && Object.keys(wechatCreds).length > 0) {
    const nonce = randomBytes(8).toString('hex')
    const credentialRef = `cred_wechat_${acc.id.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 16)}_${nonce}`
    const payload = JSON.stringify(wechatCreds)
    const encryptedPayload = encryptCredentialWithAad(masterKey, payload, userId, credentialRef)

    return {
      accountId: acc.id,
      channelType: 'wechat',
      name,
      status: 'disabled', // Forced DISABLED as required
      credentialRef,
      encryptedPayload,
      isPlaceholder: false,
    }
  }

  // WeChat placeholder ref
  const placeholderRef = `reauth_required_wechat_${acc.id.slice(0, 16)}`
  return {
    accountId: acc.id,
    channelType: 'wechat',
    name,
    status: 'disabled',
    credentialRef: placeholderRef,
    encryptedPayload: null,
    isPlaceholder: true,
  }
}
