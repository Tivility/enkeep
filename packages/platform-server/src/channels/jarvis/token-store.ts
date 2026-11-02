/**
 * Bearer tokens of Jarvis channel accounts (`channel_account_tokens`, migration 46).
 *
 * A token is `ejv_` + base64url(32 random bytes), shown to its owner once. Only its sha256 is
 * stored; authentication looks the hash up (the lookup key is itself a hash, so the plaintext is
 * never compared) and confirms it with a constant-time comparison. Tokens are never logged.
 *
 * @module @enkeep/platform-server/channels/jarvis/token-store
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export const JARVIS_TOKEN_PREFIX = 'ejv_';
/** 32 random bytes in base64url. */
const TOKEN_BODY = /^[A-Za-z0-9_-]{43}$/;

export interface JarvisTokenPrincipal {
  accountId: string;
  userId: string;
}

export function generateJarvisToken(): string {
  return `${JARVIS_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function hashJarvisToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Whether a string has the shape of a Jarvis token (cheap pre-check before any lookup). */
export function isJarvisTokenShape(token: string): boolean {
  return typeof token === 'string' && token.startsWith(JARVIS_TOKEN_PREFIX) && TOKEN_BODY.test(token.slice(JARVIS_TOKEN_PREFIX.length));
}

/** The user already holds the token of another Jarvis account. */
export class JarvisTokenOwnerConflictError extends Error {
  readonly code = 'JARVIS_ACCOUNT_EXISTS';
  constructor() {
    super('This user already has a Jarvis channel');
    this.name = 'JarvisTokenOwnerConflictError';
  }
}

/** `UNIQUE constraint failed: channel_account_tokens.user_id` (node:sqlite reports it in the message). */
function isUserUniqueViolation(err: unknown): boolean {
  const message = err instanceof Error ? err.message : '';
  return /UNIQUE constraint failed: channel_account_tokens\.user_id/.test(message);
}

export class JarvisTokenStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * Issues (or replaces) the account's token; returns the plaintext once. Throws
   * {@link JarvisTokenOwnerConflictError} when the user already holds the token of another account
   * (one Jarvis account per user; `channel_account_tokens.user_id` is unique).
   */
  issue(accountId: string, userId: string): string {
    const token = generateJarvisToken();
    const hash = hashJarvisToken(token);
    try {
      this.db
        .prepare(
          `INSERT INTO channel_account_tokens (account_id, user_id, token_hash, created_at, last_used_at)
           VALUES (?, ?, ?, ?, NULL)
           ON CONFLICT(account_id) DO UPDATE SET
             user_id = excluded.user_id,
             token_hash = excluded.token_hash,
             created_at = excluded.created_at,
             last_used_at = NULL`
        )
        .run(accountId, userId, hash, new Date().toISOString());
    } catch (err) {
      if (isUserUniqueViolation(err)) throw new JarvisTokenOwnerConflictError();
      throw err;
    }
    return token;
  }

  /** Removes the account's token. Returns whether one existed. */
  revoke(accountId: string): boolean {
    const res = this.db.prepare('DELETE FROM channel_account_tokens WHERE account_id = ?').run(accountId);
    return Number(res.changes ?? 0) > 0;
  }

  has(accountId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM channel_account_tokens WHERE account_id = ? LIMIT 1').get(accountId));
  }

  /** Token metadata (never the hash). */
  describe(accountId: string): { createdAt: string; lastUsedAt: string | null } | null {
    const row = this.db
      .prepare('SELECT created_at, last_used_at FROM channel_account_tokens WHERE account_id = ? LIMIT 1')
      .get(accountId) as { created_at: string; last_used_at: string | null } | undefined;
    return row ? { createdAt: row.created_at, lastUsedAt: row.last_used_at } : null;
  }

  /**
   * The active Jarvis account (and active owner) a token belongs to, or null. Marks the token used.
   */
  authenticate(token: string): JarvisTokenPrincipal | null {
    if (!isJarvisTokenShape(token)) return null;
    const hash = hashJarvisToken(token);
    const row = this.db
      .prepare(
        `SELECT t.account_id, t.user_id, t.token_hash
         FROM channel_account_tokens t
         JOIN channel_accounts a ON a.id = t.account_id AND a.user_id = t.user_id
         JOIN users u ON u.id = t.user_id
         WHERE t.token_hash = ? AND a.type = 'jarvis' AND a.status = 'active' AND u.status = 'active'
         LIMIT 1`
      )
      .get(hash) as { account_id: string; user_id: string; token_hash: string } | undefined;
    if (!row) return null;
    const expected = Buffer.from(row.token_hash, 'hex');
    const actual = Buffer.from(hash, 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    try {
      this.db
        .prepare('UPDATE channel_account_tokens SET last_used_at = ? WHERE account_id = ?')
        .run(new Date().toISOString(), row.account_id);
    } catch {}
    return { accountId: row.account_id, userId: row.user_id };
  }

  /** Whether the account (and its owner) may still hold a connection. */
  isActive(accountId: string, userId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM channel_account_tokens t
           JOIN channel_accounts a ON a.id = t.account_id AND a.user_id = t.user_id
           JOIN users u ON u.id = t.user_id
           WHERE t.account_id = ? AND t.user_id = ? AND a.type = 'jarvis' AND a.status = 'active' AND u.status = 'active'
           LIMIT 1`
        )
        .get(accountId, userId)
    );
  }
}
