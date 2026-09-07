/**
 * Encrypted Server-Side Credential Store for Lark / Feishu Channel Accounts.
 *
 * Implements LarkCredentialResolver with AES-256-GCM authenticated encryption,
 * strict AAD tenant+ref binding, and SQLite persistence.
 *
 * Security Invariants:
 * - NO hardcoded fallback key. Key MUST be explicitly provided or securely generated to a 0600 file outside workspace.
 * - Key file must be an exact 32-byte regular file (no symlinks, no group/other permissions, no hashing of empty files).
 * - Atomic exclusive creation ('wx' / O_EXCL) prevents race conditions.
 * - Ciphertext payload is bound with AAD = `${userId}:${credentialRef}` to prevent cross-tenant ciphertext swapping.
 * - Ciphertext is persisted to SQLite table `channel_encrypted_credentials` (Migration 032) so restarts retain credentials.
 * - AppSecret is never returned to UI, never logged, and never stored as plaintext in DB.
 *
 * @module @enkeep/platform-server/channels/lark-encrypted-credentials
 */

import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHash,
} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  lstatSync,
  constants,
  openSync,
  closeSync,
  readSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { LarkCredentialResolver, LarkResolvedCredentials } from '@enkeep/channel-lark';

export interface LarkEncryptedSecretPayload {
  readonly appId: string;
  readonly appSecret: string;
  readonly domain?: 'feishu' | 'lark';
  readonly botOpenId?: string;
  readonly tenantId?: string;
}

export interface LarkEncryptedCredentialStoreOptions {
  readonly cipherSecret?: string | Buffer;
  readonly keyFilePath?: string;
  readonly db?: DatabaseSync;
  readonly persistFilePath?: string;
}

export class KeyFileSecurityError extends Error {
  constructor(message: string) {
    super(`KeyFileSecurityError: ${message}`);
    this.name = 'KeyFileSecurityError';
  }
}

export class LarkEncryptedCredentialStore implements LarkCredentialResolver {
  private readonly key: Buffer;
  private readonly db?: DatabaseSync;
  private readonly memoryFallback = new Map<string, string>(); // key: `${userId}:${credentialRef}` -> ciphertext

  constructor(options: LarkEncryptedCredentialStoreOptions = {}) {
    this.db = options.db;

    // 1. Resolve Master Key (fail-closed if neither secret nor valid file is available)
    if (options.cipherSecret) {
      if (typeof options.cipherSecret === 'string') {
        if (options.cipherSecret.trim().length === 0) {
          throw new Error('LarkEncryptedCredentialStore: cipherSecret must be a non-empty string');
        }
        this.key = createHash('sha256').update(options.cipherSecret, 'utf8').digest();
      } else if (Buffer.isBuffer(options.cipherSecret)) {
        if (options.cipherSecret.length !== 32) {
          this.key = createHash('sha256').update(options.cipherSecret).digest();
        } else {
          this.key = options.cipherSecret;
        }
      } else {
        throw new Error('LarkEncryptedCredentialStore: Invalid cipherSecret type');
      }
    } else if (options.keyFilePath) {
      this.key = this.loadOrGenerateKeyFile(options.keyFilePath);
    } else {
      throw new Error(
        'LarkEncryptedCredentialStore: Master encryption key is required (cipherSecret or keyFilePath). Static fallback keys are forbidden.'
      );
    }
  }

  /**
   * Safely loads an existing key file or atomically creates a new 32-byte key file with 0600 permissions.
   * Strictly validates symlinks, ownership permissions, and exact 32-byte size.
   */
  private loadOrGenerateKeyFile(filePath: string): Buffer {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    const validateExisting = (path: string): Buffer => {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        throw new KeyFileSecurityError(`Key file at "${path}" cannot be a symbolic link`);
      }
      if (!stat.isFile()) {
        throw new KeyFileSecurityError(`Key file at "${path}" must be a regular file`);
      }
      // Check mode permissions (must not be group or world readable/writable)
      if ((stat.mode & 0o077) !== 0) {
        throw new KeyFileSecurityError(
          `Insecure permissions on key file "${path}" (mode 0o${(stat.mode & 0o777).toString(8)}). Required: 0600.`
        );
      }
      if (stat.size !== 32) {
        throw new KeyFileSecurityError(
          `Invalid key file size at "${path}": expected exactly 32 bytes, found ${stat.size} bytes. Empty/corrupt files are rejected.`
        );
      }

      const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      try {
        const buf = Buffer.alloc(32);
        const bytesRead = readSync(fd, buf, 0, 32, 0);
        if (bytesRead !== 32) {
          throw new KeyFileSecurityError(`Failed to read 32 bytes from key file "${path}"`);
        }
        return buf;
      } finally {
        closeSync(fd);
      }
    };

    if (existsSync(filePath)) {
      return validateExisting(filePath);
    }

    // Atomic exclusive creation ('wx' / O_EXCL)
    const newKey = randomBytes(32);
    try {
      const fd = openSync(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
      try {
        writeFileSync(fd, newKey);
      } finally {
        closeSync(fd);
      }
      try {
        chmodSync(filePath, 0o600);
      } catch {}
      return newKey;
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        // Race condition: another process created it, re-read and validate
        return validateExisting(filePath);
      }
      throw err;
    }
  }

  /**
   * Encrypts plaintext JSON payload with AES-256-GCM and strict AAD tenant binding.
   */
  private encryptWithAad(plaintext: string, userId: string, credentialRef: string): string {
    const iv = randomBytes(12); // 96-bit standard GCM nonce
    const aad = Buffer.from(`${userId}:${credentialRef}`, 'utf8');

    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(aad);

    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(plaintext, 'utf8')),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;
  }

  /**
   * Decrypts ciphertext with AES-256-GCM verifying AAD tenant binding.
   * Fails closed if AAD mismatch or key wrong.
   */
  private decryptWithAad(encryptedPayload: string, userId: string, credentialRef: string): string {
    if (!encryptedPayload || !encryptedPayload.startsWith('v1:')) {
      throw new Error('Invalid ciphertext format');
    }

    const parts = encryptedPayload.split(':');
    if (parts.length !== 4) {
      throw new Error('Corrupted ciphertext envelope');
    }

    const [, ivHex, tagHex, dataHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const ciphertext = Buffer.from(dataHex, 'hex');
    const aad = Buffer.from(`${userId}:${credentialRef}`, 'utf8');

    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  }

  /**
   * Stores encrypted credentials bound to tenant userId, generating a unique credentialRef.
   */
  async storeCredentials(
    userId: string,
    credentials: {
      appId: string;
      appSecret: string;
      domain?: 'feishu' | 'lark';
      botOpenId?: string;
      tenantId?: string;
    }
  ): Promise<string> {
    if (!userId || typeof userId !== 'string') {
      throw new Error('Tenant userId is required');
    }
    if (!credentials.appId || !credentials.appSecret) {
      throw new Error('appId and appSecret are required');
    }

    const nonce = randomBytes(8).toString('hex');
    const credentialRef = `cred_lark_${credentials.appId.replace(/[^a-zA-Z0-9_]/g, '_')}_${nonce}`;

    const payload: LarkEncryptedSecretPayload = {
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      domain: credentials.domain ?? 'feishu',
      botOpenId: credentials.botOpenId,
      tenantId: credentials.tenantId,
    };

    const encryptedPayload = this.encryptWithAad(JSON.stringify(payload), userId, credentialRef);

    // Persist to SQLite database if db is available
    if (this.db) {
      const id = `enc_${randomBytes(8).toString('hex')}`;
      const stmt = this.db.prepare(`
        INSERT INTO channel_encrypted_credentials (id, user_id, credential_ref, encrypted_payload, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(credential_ref) DO UPDATE SET
          encrypted_payload = excluded.encrypted_payload,
          updated_at = CURRENT_TIMESTAMP
      `);
      stmt.run(id, userId, credentialRef, encryptedPayload);
    } else {
      this.memoryFallback.set(`${userId}:${credentialRef}`, encryptedPayload);
    }

    return credentialRef;
  }

  /**
   * Resolves credentials strictly for the requesting tenant userId and credentialRef.
   * Returns null if not found, wrong tenant user, or auth tag verification fails.
   */
  async resolve(userId: string, credentialRef: string): Promise<LarkResolvedCredentials | null> {
    if (!userId || !credentialRef) return null;

    let encryptedPayload: string | null = null;

    if (this.db) {
      const row = this.db.prepare(`
        SELECT user_id, encrypted_payload FROM channel_encrypted_credentials
        WHERE credential_ref = ?
      `).get(credentialRef) as { user_id: string; encrypted_payload: string } | undefined;

      if (!row || row.user_id !== userId) {
        return null;
      }
      encryptedPayload = row.encrypted_payload;
    } else {
      encryptedPayload = this.memoryFallback.get(`${userId}:${credentialRef}`) || null;
    }

    if (!encryptedPayload) return null;

    try {
      const decryptedJson = this.decryptWithAad(encryptedPayload, userId, credentialRef);
      const parsed = JSON.parse(decryptedJson) as LarkEncryptedSecretPayload;
      if (!parsed.appId || !parsed.appSecret) return null;

      return {
        appId: parsed.appId,
        appSecret: parsed.appSecret,
        domain: parsed.domain ?? 'feishu',
        botOpenId: parsed.botOpenId,
      };
    } catch {
      return null;
    }
  }

  /**
   * Deletes encrypted credentials for a tenant user.
   */
  async deleteCredentials(userId: string, credentialRef: string): Promise<boolean> {
    if (this.db) {
      const res = this.db.prepare(`
        DELETE FROM channel_encrypted_credentials
        WHERE user_id = ? AND credential_ref = ?
      `).run(userId, credentialRef);
      return Number(res.changes) > 0;
    } else {
      return this.memoryFallback.delete(`${userId}:${credentialRef}`);
    }
  }
}
