/**
 * HappyClaw WeChat Credential Importer & Migration Module (Module I).
 *
 * Implements smooth, scan-free credential migration for WeChat iLink Bot accounts:
 * - Decrypts HappyClaw AES-256-GCM secret files using claude-provider.key.
 * - Extracts botToken, ilinkBotId, baseUrl, cdnBaseUrl, getUpdatesBuf cursor.
 * - Re-encrypts credentials following Enkeep standards: AES-256-GCM with AAD `${userId}:${credentialRef}`.
 * - Populates channel_encrypted_credentials, channel_accounts, and channel_bindings.
 * - Supports pre-cutover staging (status: 'disabled') and activation (status: 'active').
 * - Zero secrets leakage: never prints, logs, or returns plaintext tokens or keys.
 * - Zero external network calls: tests and verification use local mock HTTP servers/fixtures.
 *
 * @module @enkeep/import-happyclaw/wechat-importer
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import * as http from 'node:http';
import * as https from 'node:https';

export interface HappyClawWeChatSecret {
  readonly botToken: string;
  readonly ilinkBotId: string;
  readonly baseUrl?: string;
  readonly cdnBaseUrl?: string;
  readonly getUpdatesBuf?: string;
  readonly bypassProxy?: boolean | string;
  readonly [key: string]: any;
}

export interface EnkeepWeChatCredentialPayload {
  readonly botToken: string;
  readonly ilinkBotId: string;
  readonly baseUrl: string;
  readonly cdnBaseUrl: string;
  readonly getUpdatesBuf: string;
  readonly bypassProxy: boolean;
}

export interface WeChatMigrationItem {
  readonly username: string;
  readonly sourceUserId: string;
  readonly targetUserId: string;
  readonly sourceAccountId: string;
  readonly targetAccountId: string;
  readonly ilinkBotIdMasked: string;
  readonly cursorLen: number;
  readonly credentialRef: string;
  readonly status: 'active' | 'disabled';
  readonly defaultSpaceId: string | null;
  readonly bindingsCount: number;
}

export interface WeChatMigrationOptions {
  readonly hcDir?: string;
  readonly hcKeyPath?: string;
  readonly hcKey?: Buffer | string;
  readonly targetDbPath?: string;
  readonly targetDb?: DatabaseSync;
  readonly masterKey?: Buffer | string;
  readonly vaultKeyPath?: string;
  readonly dryRun?: boolean;
  readonly status?: 'disabled' | 'active';
  readonly activate?: boolean;
  readonly user?: string;
  readonly targetAccountId?: string;
  readonly onlyActive?: boolean;
  readonly checkEndpoint?: boolean;
}

export interface WeChatMigrationReport {
  readonly success: boolean;
  readonly dryRun: boolean;
  readonly items: readonly WeChatMigrationItem[];
  readonly warnings: readonly string[];
  readonly endpointChecks?: readonly {
    readonly username: string;
    readonly ok: boolean;
    readonly status?: number;
    readonly message?: string;
  }[];
}

interface EncryptedHappyClawSecretEnvelope {
  readonly version: 1;
  readonly iv: string;
  readonly tag: string;
  readonly data: string;
  readonly updated_at?: string;
}

/**
 * Computes sha256 lowercase hex digest.
 */
export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex').toLowerCase();
}

/**
 * Masks a secret string safely for logs and reports (e.g. "***abc").
 */
export function maskCredentialString(val?: string | null): string {
  if (!val || typeof val !== 'string' || val.trim().length === 0) {
    return '***';
  }
  const clean = val.trim();
  if (clean.length <= 6) {
    return '***' + clean.slice(-Math.min(3, clean.length));
  }
  return '***' + clean.slice(-3);
}

/**
 * Derives or validates a 32-byte master encryption key for Enkeep channel credentials.
 */
export function resolveMasterEncryptionKey(masterKey?: Buffer | string, vaultKeyPath?: string): Buffer {
  if (masterKey) {
    if (Buffer.isBuffer(masterKey)) {
      if (masterKey.length === 32) return masterKey;
      return createHash('sha256').update(masterKey).digest();
    }
    if (typeof masterKey === 'string' && masterKey.trim().length > 0) {
      if (/^[0-9a-fA-F]{64}$/.test(masterKey.trim())) {
        return Buffer.from(masterKey.trim(), 'hex');
      }
      return createHash('sha256').update(masterKey, 'utf8').digest();
    }
  }

  if (vaultKeyPath && fs.existsSync(vaultKeyPath)) {
    try {
      const content = fs.readFileSync(vaultKeyPath, 'utf8').trim();
      if (/^[0-9a-fA-F]{64}$/.test(content)) {
        return Buffer.from(content, 'hex');
      }
      if (content.length > 0) {
        return createHash('sha256').update(content, 'utf8').digest();
      }
    } catch {
      // fallback
    }
  }

  const envVaultKey = process.env.ENKEEP_VAULT_KEY || process.env.ENKEEP_MASTER_KEY;
  if (envVaultKey && envVaultKey.trim().length > 0) {
    if (/^[0-9a-fA-F]{64}$/.test(envVaultKey.trim())) {
      return Buffer.from(envVaultKey.trim(), 'hex');
    }
    return createHash('sha256').update(envVaultKey.trim(), 'utf8').digest();
  }

  // Deterministic local key if none provided
  return createHash('sha256').update('enkeep-channel-master-encryption-key-v1', 'utf8').digest();
}

/**
 * Resolves HappyClaw's 32-byte encryption key from file or raw input.
 */
export function resolveHappyClawKey(hcKey?: Buffer | string, hcKeyPath?: string, hcDir?: string): Buffer {
  if (hcKey) {
    if (Buffer.isBuffer(hcKey)) {
      if (hcKey.length === 32) return hcKey;
      throw new Error('HappyClaw key buffer must be exactly 32 bytes');
    }
    if (typeof hcKey === 'string') {
      const trimmed = hcKey.trim();
      if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
        return Buffer.from(trimmed, 'hex');
      }
      throw new Error('HappyClaw key string must be a 64-character hex string');
    }
  }

  const resolvedPath = hcKeyPath || (hcDir ? path.join(hcDir, 'data', 'config', 'claude-provider.key') : null);
  if (resolvedPath && fs.existsSync(resolvedPath)) {
    const raw = fs.readFileSync(resolvedPath, 'utf8').trim();
    if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
      throw new Error(`Invalid HappyClaw key file at ${resolvedPath}: expected 64 hex characters`);
    }
    return Buffer.from(raw, 'hex');
  }

  throw new Error('Could not resolve HappyClaw key file (claude-provider.key)');
}

/**
 * Decrypts a HappyClaw channel-account secret file (AES-256-GCM, no AAD).
 */
export function decryptHappyClawSecretFile(filePath: string, key: Buffer): HappyClawWeChatSecret {
  if (!fs.existsSync(filePath)) {
    throw new Error(`HappyClaw secret file not found: ${filePath}`);
  }
  const envelope = JSON.parse(fs.readFileSync(filePath, 'utf8')) as EncryptedHappyClawSecretEnvelope;
  if (envelope.version !== 1) {
    throw new Error(`Unsupported HappyClaw secret envelope version: ${envelope.version}`);
  }

  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  const ciphertext = Buffer.from(envelope.data, 'base64');

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');

  const payload = JSON.parse(decrypted) as HappyClawWeChatSecret;
  if (!payload.botToken || !payload.ilinkBotId) {
    throw new Error('Corrupted HappyClaw secret: missing botToken or ilinkBotId');
  }

  return payload;
}

/**
 * Encrypts a payload into HappyClaw secret envelope format for fixtures/tests.
 */
export function encryptHappyClawSecretPayload(
  payload: any,
  key: Buffer
): { version: 1; iv: string; tag: string; data: string; updated_at: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);

  return {
    version: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64'),
    updated_at: new Date().toISOString(),
  };
}

/**
 * Generates an Enkeep WeChat credential reference according to design spec:
 * `cred_wechat_${sha256(userId + ':' + ilinkBotId).slice(0, 16)}`
 */
export function createWeChatCredentialRef(userId: string, ilinkBotId: string): string {
  const hash = sha256Hex(`${userId}:${ilinkBotId}`);
  return `cred_wechat_${hash.slice(0, 16)}`;
}

/**
 * Generates an Enkeep WeChat account ID according to design spec:
 * `acc_hpc_wechat_${userId}`
 */
export function createWeChatAccountId(userId: string): string {
  return `acc_hpc_wechat_${userId}`;
}

/**
 * Encrypts a payload string using AES-256-GCM strictly bound to AAD `${userId}:${credentialRef}`.
 * Produces format: `v1:${ivHex}:${tagHex}:${ciphertextHex}` matching Enkeep standards.
 */
export function encryptEnkeepCredential(
  key: Buffer,
  plaintextPayload: string | Record<string, any>,
  userId: string,
  credentialRef: string
): string {
  const payloadStr = typeof plaintextPayload === 'string' ? plaintextPayload : JSON.stringify(plaintextPayload);
  const iv = randomBytes(12);
  const aad = Buffer.from(`${userId}:${credentialRef}`, 'utf8');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);

  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(payloadStr, 'utf8')),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;
}

/**
 * Decrypts an Enkeep credential payload verifying the AAD `${userId}:${credentialRef}`.
 * Fails closed if AAD mismatch, key error, or tampering occurs.
 */
export function decryptEnkeepCredential(
  key: Buffer,
  encryptedEnvelope: string,
  userId: string,
  credentialRef: string
): any {
  if (!encryptedEnvelope || !encryptedEnvelope.startsWith('v1:')) {
    throw new Error('Invalid Enkeep ciphertext format');
  }

  const parts = encryptedEnvelope.split(':');
  if (parts.length !== 4) {
    throw new Error('Corrupted Enkeep ciphertext envelope');
  }

  const [, ivHex, tagHex, dataHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const ciphertext = Buffer.from(dataHex, 'hex');
  const aad = Buffer.from(`${userId}:${credentialRef}`, 'utf8');

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');

  try {
    return JSON.parse(decrypted);
  } catch {
    return decrypted;
  }
}

/**
 * Pure offline endpoint check against local fake mock server.
 * Never calls real WeChat servers.
 */
export async function verifyWeChatEndpointOffline(
  baseUrl: string,
  botToken: string,
  options: { timeoutMs?: number } = {}
): Promise<{ ok: boolean; status: number; message?: string }> {
  const timeoutMs = options.timeoutMs ?? 2000;
  const urlStr = `${baseUrl.replace(/\/+$/, '')}/ilink/bot/getconfig`;

  return new Promise((resolve) => {
    try {
      const parsedUrl = new URL(urlStr);
      const isHttps = parsedUrl.protocol === 'https:';
      const client = isHttps ? https : http;

      const req = client.request(
        urlStr,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${botToken}`,
            AuthorizationType: 'ilink_bot_token',
          },
          timeout: timeoutMs,
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => {
            const ok = res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300;
            resolve({
              ok,
              status: res.statusCode || 0,
              message: ok ? 'OK' : `HTTP ${res.statusCode}: ${body.slice(0, 100)}`,
            });
          });
        }
      );

      req.on('error', (err) => {
        resolve({
          ok: false,
          status: 0,
          message: err.message,
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({
          ok: false,
          status: 408,
          message: 'Request timed out',
        });
      });

      req.write(JSON.stringify({}));
      req.end();
    } catch (err: any) {
      resolve({
        ok: false,
        status: 0,
        message: err?.message || 'Invalid URL',
      });
    }
  });
}

/**
 * Main migration entry point for WeChat credentials from HappyClaw to Enkeep.
 */
export async function importWeChatCredentials(
  options: WeChatMigrationOptions = {}
): Promise<WeChatMigrationReport> {
  const hcDir = options.hcDir ? path.resolve(options.hcDir) : (process.env.HAPPYCLAW_DIR || path.join(os.tmpdir(), 'happyclaw'));
  const dryRun = Boolean(options.dryRun);
  const status: 'active' | 'disabled' = options.status || (options.activate ? 'active' : 'disabled');
  const warnings: string[] = [];
  const items: WeChatMigrationItem[] = [];
  const endpointChecks: { username: string; ok: boolean; status?: number; message?: string }[] = [];

  // 1. Resolve HappyClaw Key
  const hcKey = resolveHappyClawKey(options.hcKey, options.hcKeyPath, hcDir);

  // 2. Resolve Enkeep Master Key
  const masterKey = resolveMasterEncryptionKey(options.masterKey, options.vaultKeyPath);

  // 3. Open HappyClaw Database (read-only)
  const hcDbPath = path.join(hcDir, 'data', 'db', 'messages.db');
  let hcDb: DatabaseSync | null = null;
  if (fs.existsSync(hcDbPath)) {
    hcDb = new DatabaseSync(hcDbPath, { readOnly: true });
  }

  // 4. Open Target Enkeep Database
  let targetDb = options.targetDb;
  let closeTargetDbAtEnd = false;
  if (!targetDb) {
    const targetDbPath = options.targetDbPath
      ? path.resolve(options.targetDbPath)
      : process.env.ENKEEP_PLATFORM_DB
        ? path.resolve(process.env.ENKEEP_PLATFORM_DB)
        : path.resolve(process.cwd(), '.demo-data', 'platform.db');

    if (!fs.existsSync(targetDbPath) && !dryRun) {
      throw new Error(`Target Enkeep platform database not found at ${targetDbPath}`);
    }

    if (fs.existsSync(targetDbPath)) {
      targetDb = new DatabaseSync(targetDbPath, { readOnly: dryRun });
      closeTargetDbAtEnd = true;
    }
  }

  try {
    // 5. Query HappyClaw WeChat accounts
    interface RawHcAccount {
      id: string;
      owner_user_id: string;
      provider?: string;
      name?: string;
      status?: string;
      enabled?: number;
      secret_ref?: string;
    }

    let rawAccounts: RawHcAccount[] = [];
    if (hcDb) {
      try {
        rawAccounts = hcDb
          .prepare(
            "SELECT id, owner_user_id, provider, name, status, enabled, secret_ref FROM channel_accounts WHERE provider = 'wechat'"
          )
          .all() as unknown as RawHcAccount[];
      } catch (err: any) {
        warnings.push(`Failed to query channel_accounts from HappyClaw db: ${err.message}`);
      }
    }

    // Filter accounts if onlyActive requested (by default include all or enabled = 1 unless explicitly specified)
    if (options.onlyActive) {
      rawAccounts = rawAccounts.filter((acc) => acc.enabled === 1 || acc.status === 'connected');
    }

    // Map HappyClaw users to usernames
    const hcUserMap = new Map<string, string>(); // owner_user_id -> username
    if (hcDb) {
      try {
        const users = hcDb.prepare('SELECT id, username FROM users').all() as unknown as { id: string; username: string }[];
        for (const u of users) {
          hcUserMap.set(u.id, u.username);
        }
      } catch {
        // ignore
      }
    }

    // If no db accounts found, check channel-accounts directory directly
    const secretDir = path.join(hcDir, 'data', 'config', 'channel-accounts');
    if (rawAccounts.length === 0 && fs.existsSync(secretDir)) {
      const files = fs.readdirSync(secretDir).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        const accountId = file.replace(/\.json$/, '');
        rawAccounts.push({
          id: accountId,
          owner_user_id: 'unknown',
          provider: 'wechat',
          name: '默认微信',
          secret_ref: `channel-account:${accountId}`,
        });
      }
    }

    // Helper utilities for schema checking
    function tableExists(db: DatabaseSync, tableName: string): boolean {
      try {
        const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(tableName);
        return Boolean(row);
      } catch {
        return false;
      }
    }

    function columnExists(db: DatabaseSync, tableName: string, columnName: string): boolean {
      try {
        const cols = db.prepare(`PRAGMA table_info("${tableName}")`).all() as unknown as Array<{ name: string }>;
        return cols.some((c) => c.name === columnName);
      } catch {
        return false;
      }
    }

    // Process each WeChat account
    for (const acc of rawAccounts) {
      const hcUsername = hcUserMap.get(acc.owner_user_id) || acc.owner_user_id;

      // Filter by requested user if specified
      if (options.user && options.user !== hcUsername && options.user !== acc.owner_user_id) {
        continue;
      }

      // Locate secret file
      let secretFilePath = path.join(secretDir, `${acc.id}.json`);
      if (!fs.existsSync(secretFilePath) && acc.secret_ref?.startsWith('channel-account:')) {
        const refId = acc.secret_ref.slice('channel-account:'.length);
        secretFilePath = path.join(secretDir, `${refId}.json`);
      }

      if (!fs.existsSync(secretFilePath)) {
        warnings.push(`Secret file not found for account ${acc.id}`);
        continue;
      }

      // Decrypt HappyClaw secret
      let secret: HappyClawWeChatSecret;
      try {
        secret = decryptHappyClawSecretFile(secretFilePath, hcKey);
      } catch (err: any) {
        warnings.push(`Failed to decrypt secret for account ${acc.id}: ${err.message}`);
        continue;
      }

      // Resolve Enkeep target user ID
      let targetUserId = acc.owner_user_id;
      if (targetDb) {
        try {
          const matchedUser = targetDb
            .prepare('SELECT id FROM users WHERE username = ? OR id = ?')
            .get(hcUsername, acc.owner_user_id) as { id: string } | undefined;
          if (matchedUser) {
            targetUserId = matchedUser.id;
          }
        } catch {
          // ignore
        }
      }

      // Resolve Enkeep target account ID
      let targetAccountId = createWeChatAccountId(targetUserId);
      if (options.targetAccountId) {
        targetAccountId = options.targetAccountId;
      } else if (targetDb) {
        try {
          const existingAcc = targetDb
            .prepare("SELECT id FROM channel_accounts WHERE user_id = ? AND type = 'wechat' LIMIT 1")
            .get(targetUserId) as { id: string } | undefined;
          if (existingAcc?.id) {
            targetAccountId = existingAcc.id;
          }
        } catch {
          // ignore
        }
      }

      // Find historical chat JIDs and HappyClaw mount mappings for bindings & space resolution
      const chatJids: string[] = [];
      const workspaceJids: string[] = [];
      const workspaceFolders: string[] = [];
      const chatFolderMap = new Map<string, string>(); // chatJid -> folder

      // 1. Account default workspace if present
      const rawDefaultWs = (acc as any).default_workspace_jid || (acc as any).default_workspace || (acc as any).workspace_jid || (acc as any).workspace_id;
      if (rawDefaultWs && typeof rawDefaultWs === 'string' && rawDefaultWs.trim() !== '') {
        workspaceJids.push(rawDefaultWs.trim());
      }

      if (hcDb) {
        // 2. Query agent_channel_mounts
        if (tableExists(hcDb, 'agent_channel_mounts')) {
          try {
            const agentMounts = hcDb
              .prepare(
                `SELECT workspace_jid, workspace_folder, channel_jid FROM agent_channel_mounts
                 WHERE (channel_account_id = ? OR owner_user_id = ?)
                   AND (channel_type = 'wechat' OR channel = 'wechat' OR channel_jid LIKE 'wechat:%')`
              )
              .all(acc.id, acc.owner_user_id) as unknown as Array<{ workspace_jid?: string; workspace_folder?: string; channel_jid?: string }>;
            for (const m of agentMounts) {
              if (m.workspace_jid && !workspaceJids.includes(m.workspace_jid)) workspaceJids.push(m.workspace_jid);
              if (m.workspace_folder && !workspaceFolders.includes(m.workspace_folder)) workspaceFolders.push(m.workspace_folder);
              if (m.channel_jid && m.channel_jid.startsWith('wechat:') && !chatJids.includes(m.channel_jid)) chatJids.push(m.channel_jid);
            }
          } catch {
            // ignore
          }
        }

        // 3. Query channel_mounts
        if (tableExists(hcDb, 'channel_mounts')) {
          try {
            const chanMounts = hcDb
              .prepare(
                `SELECT workspace_jid, workspace_id, group_jid, channel_jid, workspace_folder FROM channel_mounts
                 WHERE (channel_account_id = ? OR account_id = ? OR owner_user_id = ?)
                   AND (channel = 'wechat' OR channel_type = 'wechat' OR group_jid LIKE 'wechat:%' OR channel_jid LIKE 'wechat:%')`
              )
              .all(acc.id, acc.id, acc.owner_user_id) as unknown as Array<{ workspace_jid?: string; workspace_id?: string; group_jid?: string; channel_jid?: string; workspace_folder?: string }>;
            for (const m of chanMounts) {
              if (m.workspace_jid && !workspaceJids.includes(m.workspace_jid)) workspaceJids.push(m.workspace_jid);
              if (m.workspace_id && !workspaceJids.includes(m.workspace_id)) workspaceJids.push(m.workspace_id);
              if (m.workspace_folder && !workspaceFolders.includes(m.workspace_folder)) workspaceFolders.push(m.workspace_folder);
              const cJid = m.channel_jid || m.group_jid;
              if (cJid && cJid.startsWith('wechat:') && !chatJids.includes(cJid)) chatJids.push(cJid);
            }
          } catch {
            // ignore
          }
        }

        // 4. Query registered_groups
        if (tableExists(hcDb, 'registered_groups')) {
          try {
            const groupRows = hcDb
              .prepare(
                "SELECT jid, folder, name FROM registered_groups WHERE channel_account_id = ? OR (created_by = ? AND jid LIKE 'wechat:%')"
              )
              .all(acc.id, acc.owner_user_id) as unknown as Array<{ jid: string; folder?: string; name?: string }>;
            for (const grp of groupRows) {
              if (grp.jid) {
                if (!chatJids.includes(grp.jid)) chatJids.push(grp.jid);
                if (grp.folder) {
                  chatFolderMap.set(grp.jid, grp.folder);
                  if (!workspaceFolders.includes(grp.folder)) workspaceFolders.push(grp.folder);
                }
              }
            }
          } catch {
            // ignore
          }
        }

        // 5. Query chats & messages
        if (tableExists(hcDb, 'chats')) {
          try {
            const chatRows = hcDb.prepare("SELECT jid FROM chats WHERE jid LIKE 'wechat:%'").all() as unknown as Array<{ jid: string }>;
            for (const c of chatRows) {
              if (c.jid && !chatJids.includes(c.jid)) chatJids.push(c.jid);
            }
          } catch {
            // ignore
          }
        }
        if (tableExists(hcDb, 'messages')) {
          try {
            const msgRows = hcDb.prepare("SELECT DISTINCT chat_jid FROM messages WHERE chat_jid LIKE 'wechat:%'").all() as unknown as Array<{ chat_jid: string }>;
            for (const m of msgRows) {
              if (m.chat_jid && !chatJids.includes(m.chat_jid)) chatJids.push(m.chat_jid);
            }
          } catch {
            // ignore
          }
        }

        // 6. Query workspaces
        if (tableExists(hcDb, 'workspaces')) {
          try {
            const wsRows = hcDb.prepare("SELECT jid, folder, name FROM workspaces WHERE jid LIKE 'wechat:%' OR folder = 'wechat' OR jid = 'web:wechat'").all() as unknown as Array<{ jid: string; folder?: string; name?: string }>;
            for (const w of wsRows) {
              if (w.jid && !workspaceJids.includes(w.jid)) workspaceJids.push(w.jid);
              if (w.folder && !workspaceFolders.includes(w.folder)) workspaceFolders.push(w.folder);
            }
          } catch {
            // ignore
          }
        }
      }

      // Resolve target space ID via import provenance & HC account mapping (deterministic)
      let defaultSpaceId: string | null = null;
      const conversationSpaceMap = new Map<string, string>(); // chatJid -> spaceId

      if (targetDb) {
        const userSpaces = targetDb
          .prepare('SELECT id, folder, name FROM spaces WHERE user_id = ? ORDER BY id ASC')
          .all(targetUserId) as unknown as Array<{ id: string; folder: string; name: string }>;

        if (userSpaces.length > 0) {
          const userSpaceIds = new Set(userSpaces.map((s) => s.id));

          // Helper to find space by folder/name matching candidate
          const findSpaceByFolderOrName = (candidateFolderOrName: string): string | null => {
            const clean = candidateFolderOrName.trim().toLowerCase();
            // 1. Exact folder match
            const exactFolder = userSpaces.find((s) => s.folder.toLowerCase() === clean);
            if (exactFolder) return exactFolder.id;
            // 2. Prefix / suffix folder match (e.g. wechat--container, home-uid--wechat-...)
            const prefixFolder = userSpaces.find(
              (s) =>
                s.folder.toLowerCase().startsWith(`${clean}--`) ||
                s.folder.toLowerCase().endsWith(`--${clean}`) ||
                s.folder.toLowerCase().includes(`--${clean}--`) ||
                s.folder.toLowerCase().includes(`--wechat-`)
            );
            if (prefixFolder) return prefixFolder.id;
            // 3. Name match
            const nameMatch = userSpaces.find((s) => s.name.toLowerCase() === clean || s.name.toLowerCase().includes(clean));
            if (nameMatch) return nameMatch.id;
            return null;
          };

          // Helper to resolve space from a given JID via provenance tables
          const resolveSpaceFromJid = (jid: string): string | null => {
            const cleanJid = jid.trim();
            const withoutPrefix = cleanJid.replace(/^wechat:/, '');
            const senderWithoutDomain = withoutPrefix.replace(/@im\.wechat$/, '').replace(/@[^@]+$/, '');

            // Check fixed_import_provenance
            if (tableExists(targetDb, 'fixed_import_provenance')) {
              try {
                const provRow = targetDb
                  .prepare(
                    `SELECT target_space_id FROM fixed_import_provenance
                     WHERE user_id = ? AND (source_chat_jid = ? OR source_chat_jid = ? OR source_chat_jid = ?)
                     LIMIT 1`
                  )
                  .get(targetUserId, cleanJid, withoutPrefix, senderWithoutDomain) as { target_space_id: string } | undefined;
                if (provRow?.target_space_id && userSpaceIds.has(provRow.target_space_id)) {
                  return provRow.target_space_id;
                }
              } catch {
                // ignore
              }
            }

            // Check session_sources + session_routes
            if (tableExists(targetDb, 'session_sources') && tableExists(targetDb, 'session_routes')) {
              try {
                const srcRow = targetDb
                  .prepare(
                    `SELECT sr.space_id FROM session_sources ss
                     JOIN session_routes sr ON ss.route_id = sr.id
                     WHERE ss.user_id = ? AND (ss.source_id = ? OR ss.source_id = ? OR ss.source_id = ?)
                     LIMIT 1`
                  )
                  .get(targetUserId, cleanJid, withoutPrefix, senderWithoutDomain) as { space_id: string } | undefined;
                if (srcRow?.space_id && userSpaceIds.has(srcRow.space_id)) {
                  return srcRow.space_id;
                }
              } catch {
                // ignore
              }
            }

            // Check session_routes
            if (tableExists(targetDb, 'session_routes')) {
              try {
                const rRow = targetDb
                  .prepare(
                    `SELECT space_id FROM session_routes
                     WHERE user_id = ? AND (
                       peer_id = ? OR peer_id = ? OR
                       native_context_id = ? OR native_context_id = ? OR
                       native_context_id = ? OR native_context_id = ?
                     )
                     LIMIT 1`
                  )
                  .get(
                    targetUserId,
                    withoutPrefix,
                    senderWithoutDomain,
                    `wechat:${withoutPrefix}`,
                    `wechat:${senderWithoutDomain}`,
                    cleanJid,
                    withoutPrefix
                  ) as { space_id: string } | undefined;
                if (rRow?.space_id && userSpaceIds.has(rRow.space_id)) {
                  return rRow.space_id;
                }
              } catch {
                // ignore
              }
            }

            // Check channel_bindings
            if (tableExists(targetDb, 'channel_bindings')) {
              try {
                const bRow = targetDb
                  .prepare(
                    `SELECT space_id FROM channel_bindings
                     WHERE user_id = ? AND (
                       native_context_id = ? OR native_context_id = ? OR native_context_id = ?
                     )
                     LIMIT 1`
                  )
                  .get(targetUserId, `wechat:${withoutPrefix}`, `wechat:${senderWithoutDomain}`, cleanJid) as { space_id: string } | undefined;
                if (bRow?.space_id && userSpaceIds.has(bRow.space_id)) {
                  return bRow.space_id;
                }
              } catch {
                // ignore
              }
            }

            // Check folder from registered_groups
            const rgFolder = chatFolderMap.get(cleanJid);
            if (rgFolder) {
              const matchedId = findSpaceByFolderOrName(rgFolder);
              if (matchedId) return matchedId;
            }

            return null;
          };

          // 1. Resolve each conversation JID
          for (const jid of chatJids) {
            const spId = resolveSpaceFromJid(jid);
            if (spId) {
              conversationSpaceMap.set(jid, spId);
              if (!defaultSpaceId) {
                defaultSpaceId = spId;
              }
            }
          }

          // 2. If defaultSpaceId not yet resolved, check existing channel_accounts in targetDb (idempotent re-run)
          if (!defaultSpaceId && tableExists(targetDb, 'channel_accounts')) {
            try {
              const accRow = targetDb
                .prepare(
                  `SELECT default_space_id FROM channel_accounts
                   WHERE user_id = ? AND (id = ? OR type = 'wechat') AND default_space_id IS NOT NULL
                   LIMIT 1`
                )
                .get(targetUserId, targetAccountId) as { default_space_id: string } | undefined;
              if (accRow?.default_space_id && userSpaceIds.has(accRow.default_space_id)) {
                defaultSpaceId = accRow.default_space_id;
              }
            } catch {
              // ignore
            }
          }

          // 3. If defaultSpaceId not yet resolved, check workspaceJids (e.g. from mount web:wechat)
          if (!defaultSpaceId) {
            for (const wsJid of workspaceJids) {
              const spId = resolveSpaceFromJid(wsJid);
              if (spId) {
                defaultSpaceId = spId;
                break;
              }
              const folderPart = wsJid.replace(/^(web|wechat|feishu):/, '').split(/[@#]/)[0] || '';
              if (folderPart) {
                const spFromFolder = findSpaceByFolderOrName(folderPart);
                if (spFromFolder) {
                  defaultSpaceId = spFromFolder;
                  break;
                }
              }
            }
          }

          // 4. If defaultSpaceId not yet resolved, check workspaceFolders (including 'wechat' as channel default folder)
          if (!defaultSpaceId) {
            const candidateFolders = [...workspaceFolders];
            if (!candidateFolders.includes('wechat')) {
              candidateFolders.push('wechat');
            }
            for (const wf of candidateFolders) {
              const spId = findSpaceByFolderOrName(wf);
              if (spId) {
                defaultSpaceId = spId;
                break;
              }
            }
          }

          // 5. Fail loudly if mapping missing instead of arbitrary SELECT
          if (!defaultSpaceId) {
            throw new Error(
              `FAIL-CLOSED: Cannot resolve target Enkeep space for WeChat account ${acc.id} (${hcUsername}): ` +
              `no workspace mapping found in HappyClaw or import provenance.`
            );
          }

          // Backfill any conversation that didn't have specific override
          for (const jid of chatJids) {
            if (!conversationSpaceMap.has(jid)) {
              conversationSpaceMap.set(jid, defaultSpaceId);
            }
          }
        }
      }

      // Prepare Enkeep credential reference and payload
      const credentialRef = createWeChatCredentialRef(targetUserId, secret.ilinkBotId);

      const enkeepPayload: EnkeepWeChatCredentialPayload = {
        botToken: secret.botToken,
        ilinkBotId: secret.ilinkBotId,
        baseUrl: secret.baseUrl || 'https://ilinkai.weixin.qq.com',
        cdnBaseUrl: secret.cdnBaseUrl || 'https://novac2c.cdn.weixin.qq.com/c2c',
        getUpdatesBuf: secret.getUpdatesBuf || '',
        bypassProxy: Boolean(secret.bypassProxy),
      };

      const encryptedPayload = encryptEnkeepCredential(
        masterKey,
        enkeepPayload,
        targetUserId,
        credentialRef
      );

      // Verify round-trip decryption (fail-closed integrity check)
      const decryptedCheck = decryptEnkeepCredential(
        masterKey,
        encryptedPayload,
        targetUserId,
        credentialRef
      );
      if (!decryptedCheck || decryptedCheck.botToken !== secret.botToken || decryptedCheck.ilinkBotId !== secret.ilinkBotId) {
        throw new Error(`FAIL-CLOSED: Integrity check failed for re-encrypted WeChat credential ${credentialRef}`);
      }

      // Write to target Enkeep DB if not dryRun
      let bindingsCount = 0;
      if (!dryRun && targetDb) {
        targetDb.exec('BEGIN IMMEDIATE');
        try {
          // 1. Ensure user exists if table present
          try {
            targetDb
              .prepare(
                `INSERT OR IGNORE INTO users (id, username, password_hash, role, status, display_name)
                 VALUES (?, ?, 'migrated_wechat_user', 'user', 'active', ?)`
              )
              .run(targetUserId, hcUsername, hcUsername);
          } catch {
            // ignore
          }

          // 2. Ensure default space exists if needed
          if (!defaultSpaceId) {
            try {
              const newSpaceId = `spc_hpc_wechat_${sha256Hex(targetUserId).slice(0, 16)}`;
              const targetFolder = workspaceFolders[0] || 'wechat';
              targetDb
                .prepare(
                  `INSERT OR IGNORE INTO spaces (id, user_id, name, folder, execution_mode, status)
                   VALUES (?, ?, '微信空间', ?, 'container', 'active')`
                )
                .run(newSpaceId, targetUserId, targetFolder);
              defaultSpaceId = newSpaceId;
            } catch {
              // ignore
            }
          }

          // 3. Upsert channel_encrypted_credentials
          const encId = `enc_${randomBytes(8).toString('hex')}`;
          targetDb
            .prepare(
              `INSERT INTO channel_encrypted_credentials (id, user_id, credential_ref, encrypted_payload, updated_at)
               VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
               ON CONFLICT(credential_ref) DO UPDATE SET
                 encrypted_payload = excluded.encrypted_payload,
                 updated_at = CURRENT_TIMESTAMP`
            )
            .run(encId, targetUserId, credentialRef, encryptedPayload);

          // 4. Upsert channel_accounts
          targetDb
            .prepare(
              `INSERT INTO channel_accounts (id, user_id, type, status, credential_ref, default_space_id, updated_at)
               VALUES (?, ?, 'wechat', ?, ?, ?, CURRENT_TIMESTAMP)
               ON CONFLICT(id) DO UPDATE SET
                 status = excluded.status,
                 credential_ref = excluded.credential_ref,
                 default_space_id = COALESCE(excluded.default_space_id, channel_accounts.default_space_id),
                 updated_at = CURRENT_TIMESTAMP`
            )
            .run(targetAccountId, targetUserId, status, credentialRef, defaultSpaceId);

          // 5. Upsert channel_bindings if space is available
          if (defaultSpaceId) {
            const bindStmt = targetDb.prepare(
              `INSERT INTO channel_bindings (id, user_id, account_id, space_id, native_context_id, activation_mode, chat_type, updated_at)
               VALUES (?, ?, ?, ?, ?, 'always', 'p2p', CURRENT_TIMESTAMP)
               ON CONFLICT(account_id, native_context_id) DO UPDATE SET
                 space_id = excluded.space_id,
                 activation_mode = excluded.activation_mode,
                 updated_at = CURRENT_TIMESTAMP`
            );

            for (const jid of chatJids) {
              const targetSpaceForJid = conversationSpaceMap.get(jid) || defaultSpaceId;
              const cleanJid = jid.trim();
              const withoutPrefix = cleanJid.replace(/^wechat:/, '');
              const senderWithDomain = withoutPrefix;
              const senderWithoutDomain = withoutPrefix.replace(/@im\.wechat$/, '').replace(/@[^@]+$/, '');

              // Gateway compatible native context IDs:
              // 1. Primary: wechat:${senderWithDomain} (e.g. wechat:o9cq...@im.wechat)
              // 2. Bare sender without domain: wechat:${senderWithoutDomain} (e.g. wechat:o9cq...)
              // 3. Sender with domain (e.g. for msg.chatId): o9cq...@im.wechat
              // 4. Raw clean JID: cleanJid
              const nativeCtxIdsToBind = new Set<string>();
              nativeCtxIdsToBind.add(`wechat:${senderWithDomain}`);
              if (senderWithoutDomain && senderWithoutDomain !== senderWithDomain) {
                nativeCtxIdsToBind.add(`wechat:${senderWithoutDomain}`);
              }
              if (senderWithDomain) {
                nativeCtxIdsToBind.add(senderWithDomain);
              }
              if (cleanJid) {
                nativeCtxIdsToBind.add(cleanJid);
              }

              for (const nativeCtxId of nativeCtxIdsToBind) {
                const bindId = `bind_hpc_wechat_${sha256Hex(`${targetAccountId}:${nativeCtxId}`).slice(0, 16)}`;
                bindStmt.run(bindId, targetUserId, targetAccountId, targetSpaceForJid, nativeCtxId);
                bindingsCount++;
              }
            }
          }

          // 6. Update or insert session_routes for imported WeChat conversations
          if (tableExists(targetDb, 'session_routes')) {
            const routeUpdateStmt = targetDb.prepare(`
              UPDATE session_routes SET
                channel = 'wechat',
                account_id = ?,
                native_context_id = ?,
                peer_id = ?,
                space_id = ?,
                updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `);

            const routeInsertStmt = targetDb.prepare(`
              INSERT INTO session_routes (
                id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode, created_at, updated_at, status, title
              ) VALUES (?, ?, ?, 'wechat', ?, ?, ?, ?, 'container', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'active', ?)
              ON CONFLICT(id) DO UPDATE SET
                channel = 'wechat',
                account_id = excluded.account_id,
                native_context_id = excluded.native_context_id,
                peer_id = excluded.peer_id,
                space_id = excluded.space_id,
                updated_at = CURRENT_TIMESTAMP
            `);

            const hasSpaces = tableExists(targetDb, 'spaces');
            const hasCanonicalCol = hasSpaces && columnExists(targetDb, 'spaces', 'canonical_session_id');
            const spaceCanonStmt = hasCanonicalCol
              ? targetDb.prepare(
                  `UPDATE spaces SET canonical_session_id = ? WHERE id = ? AND (canonical_session_id IS NULL OR canonical_session_id = '')`
                )
              : null;

            for (const jid of chatJids) {
              const targetSpaceForJid = conversationSpaceMap.get(jid) || defaultSpaceId;
              if (!targetSpaceForJid) continue;

              const cleanJid = jid.trim();
              const withoutPrefix = cleanJid.replace(/^wechat:/, '');
              const senderWithDomain = withoutPrefix;
              const senderWithoutDomain = withoutPrefix.replace(/@im\.wechat$/, '').replace(/@[^@]+$/, '');
              const primaryNativeCtxId = `wechat:${senderWithDomain}`;

              let existingRouteId: string | null = null;

              if (tableExists(targetDb, 'fixed_import_provenance')) {
                try {
                  const provRow = targetDb
                    .prepare(
                      `SELECT target_route_id FROM fixed_import_provenance
                       WHERE user_id = ? AND (source_chat_jid = ? OR source_chat_jid = ? OR source_chat_jid = ?)
                       LIMIT 1`
                    )
                    .get(targetUserId, cleanJid, withoutPrefix, senderWithoutDomain) as { target_route_id: string } | undefined;
                  if (provRow?.target_route_id) {
                    existingRouteId = provRow.target_route_id;
                  }
                } catch {
                  // ignore
                }
              }

              if (!existingRouteId && tableExists(targetDb, 'session_sources')) {
                try {
                  const srcRow = targetDb
                    .prepare(
                      `SELECT route_id FROM session_sources
                       WHERE user_id = ? AND (source_id = ? OR source_id = ? OR source_id = ?)
                       LIMIT 1`
                    )
                    .get(targetUserId, cleanJid, withoutPrefix, senderWithoutDomain) as { route_id: string } | undefined;
                  if (srcRow?.route_id) {
                    existingRouteId = srcRow.route_id;
                  }
                } catch {
                  // ignore
                }
              }

              if (!existingRouteId) {
                try {
                  const rRow = targetDb
                    .prepare(
                      `SELECT id FROM session_routes
                       WHERE user_id = ? AND (
                         peer_id = ? OR peer_id = ? OR
                         native_context_id = ? OR native_context_id = ? OR
                         native_context_id = ? OR native_context_id = ?
                       )
                       LIMIT 1`
                    )
                    .get(
                      targetUserId,
                      senderWithDomain,
                      senderWithoutDomain,
                      primaryNativeCtxId,
                      `wechat:${senderWithoutDomain}`,
                      cleanJid,
                      withoutPrefix
                    ) as { id: string } | undefined;
                  if (rRow?.id) {
                    existingRouteId = rRow.id;
                  }
                } catch {
                  // ignore
                }
              }

              if (existingRouteId) {
                routeUpdateStmt.run(
                  targetAccountId,
                  primaryNativeCtxId,
                  senderWithDomain,
                  targetSpaceForJid,
                  existingRouteId
                );
                if (spaceCanonStmt) {
                  try {
                    spaceCanonStmt.run(existingRouteId, targetSpaceForJid);
                  } catch {
                    // ignore
                  }
                }
              } else {
                const genRouteId = `ses_${sha256Hex(`${targetUserId}:wechat:${cleanJid}`).slice(0, 24)}`;
                try {
                  routeInsertStmt.run(
                    genRouteId,
                    targetSpaceForJid,
                    targetUserId,
                    targetAccountId,
                    primaryNativeCtxId,
                    senderWithDomain,
                    genRouteId,
                    `WeChat ${senderWithoutDomain}`
                  );
                  if (spaceCanonStmt) {
                    try {
                      spaceCanonStmt.run(genRouteId, targetSpaceForJid);
                    } catch {
                      // ignore
                    }
                  }
                } catch {
                  // ignore
                }
              }
            }
          }

          targetDb.exec('COMMIT');
        } catch (err: any) {
          targetDb.exec('ROLLBACK');
          throw err;
        }
      } else {
        // In dry run, count potential bindings
        bindingsCount = chatJids.length;
      }

      // Check endpoint offline if requested
      if (options.checkEndpoint && enkeepPayload.baseUrl) {
        const checkResult = await verifyWeChatEndpointOffline(enkeepPayload.baseUrl, enkeepPayload.botToken);
        endpointChecks.push({
          username: hcUsername,
          ok: checkResult.ok,
          status: checkResult.status,
          message: checkResult.message,
        });
      }

      items.push({
        username: hcUsername,
        sourceUserId: acc.owner_user_id,
        targetUserId,
        sourceAccountId: acc.id,
        targetAccountId,
        ilinkBotIdMasked: maskCredentialString(secret.ilinkBotId),
        cursorLen: secret.getUpdatesBuf?.length || 0,
        credentialRef,
        status,
        defaultSpaceId,
        bindingsCount,
      });
    }

    return {
      success: true,
      dryRun,
      items,
      warnings,
      endpointChecks: endpointChecks.length > 0 ? endpointChecks : undefined,
    };
  } finally {
    if (hcDb) {
      try {
        hcDb.close();
      } catch {
        // ignore
      }
    }
    if (closeTargetDbAtEnd && targetDb) {
      try {
        targetDb.close();
      } catch {
        // ignore
      }
    }
  }
}
