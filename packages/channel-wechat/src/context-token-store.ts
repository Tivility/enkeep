/**
 * WeChat Context Token Store.
 * Two-level cache (L1 in-memory LRU + L2 SQLite persistence) for iLink context_tokens.
 *
 * @module @enkeep/channel-wechat/context-token-store
 */

export interface ContextTokenEntry {
  readonly token: string;
  readonly expiresAt: number;
  replyCount: number;
}

export interface ContextTokenStoreOptions {
  readonly maxCapacity?: number; // default: 1000
  readonly ttlMs?: number; // default: 24h (86,400,000 ms)
  readonly maxRepliesPerToken?: number; // optional reply count cap
  readonly replyWarningThreshold?: number; // warning threshold before reaching maxRepliesPerToken
  readonly db?: any; // optional DatabaseSync instance from node:sqlite
  readonly onPersist?: (senderId: string, token: string) => Promise<void> | void;
  readonly onLoad?: (senderId: string) => Promise<string | undefined> | string | undefined;
  readonly onWarning?: (senderId: string, currentCount: number, limit: number) => void;
}

const DEFAULT_MAX_CAPACITY = 1000;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class ContextTokenStore {
  private readonly maxCapacity: number;
  private readonly ttlMs: number;
  private readonly maxRepliesPerToken?: number;
  private readonly replyWarningThreshold?: number;
  private readonly db?: any;
  private readonly onPersist?: (senderId: string, token: string) => Promise<void> | void;
  private readonly onLoad?: (senderId: string) => Promise<string | undefined> | string | undefined;
  private readonly onWarning?: (senderId: string, currentCount: number, limit: number) => void;
  private readonly l1Cache = new Map<string, ContextTokenEntry>();

  constructor(options: ContextTokenStoreOptions = {}) {
    this.maxCapacity = options.maxCapacity ?? DEFAULT_MAX_CAPACITY;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxRepliesPerToken = options.maxRepliesPerToken;
    this.replyWarningThreshold = options.replyWarningThreshold;
    this.db = options.db;
    this.onPersist = options.onPersist;
    this.onLoad = options.onLoad;
    this.onWarning = options.onWarning;

    if (this.db) {
      this.initDatabaseTable();
    }
  }

  private initDatabaseTable(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS channel_wechat_context_tokens (
          sender_id TEXT PRIMARY KEY,
          context_token TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
        );
        CREATE INDEX IF NOT EXISTS idx_wechat_ctx_tokens_updated ON channel_wechat_context_tokens(updated_at);
      `);
    } catch {
      // Table creation might fail if db is read-only or closed; ignore gracefully
    }
  }

  get size(): number {
    return this.l1Cache.size;
  }

  /**
   * Stores a context_token for a sender.
   * Evicts oldest LRU entry if max capacity is exceeded.
   * Persists to L2 SQLite and invokes optional onPersist hook.
   */
  async set(senderId: string, contextToken: string): Promise<void> {
    if (!senderId || !contextToken) {
      return;
    }

    const cleanSenderId = senderId.trim();
    const cleanToken = contextToken.trim();
    if (!cleanSenderId || !cleanToken) {
      return;
    }

    // Refresh LRU position by deleting and re-inserting
    if (this.l1Cache.has(cleanSenderId)) {
      this.l1Cache.delete(cleanSenderId);
    } else if (this.l1Cache.size >= this.maxCapacity) {
      const oldestKey = this.l1Cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.l1Cache.delete(oldestKey);
      }
    }

    const expiresAt = Date.now() + this.ttlMs;
    this.l1Cache.set(cleanSenderId, { token: cleanToken, expiresAt, replyCount: 0 });

    // L2 SQLite persistence
    if (this.db) {
      try {
        const stmt = this.db.prepare(`
          INSERT INTO channel_wechat_context_tokens (sender_id, context_token, updated_at)
          VALUES (?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(sender_id) DO UPDATE SET
            context_token = excluded.context_token,
            updated_at = CURRENT_TIMESTAMP
        `);
        stmt.run(cleanSenderId, cleanToken);
      } catch {
        // Fallback or ignore write errors
      }
    }

    if (this.onPersist) {
      try {
        await this.onPersist(cleanSenderId, cleanToken);
      } catch {
        // Log or ignore onPersist hook error
      }
    }
  }

  /**
   * Retrieves a context_token for a sender.
   * Chain: L1 Memory -> L2 SQLite table -> Fallback SQLite channel_inbox payload -> onLoad hook.
   */
  async get(senderId: string): Promise<string | undefined> {
    if (!senderId) return undefined;
    const cleanSenderId = senderId.trim();

    // 1. Check L1 memory cache
    const l1Entry = this.l1Cache.get(cleanSenderId);
    if (l1Entry) {
      if (l1Entry.expiresAt > Date.now()) {
        // Refresh LRU order
        this.l1Cache.delete(cleanSenderId);
        this.l1Cache.set(cleanSenderId, l1Entry);
        return l1Entry.token;
      }
      // Expired entry
      this.l1Cache.delete(cleanSenderId);
    }

    // 2. Check L2 SQLite table
    if (this.db) {
      try {
        const row = this.db
          .prepare('SELECT context_token FROM channel_wechat_context_tokens WHERE sender_id = ?')
          .get(cleanSenderId) as { context_token?: string } | undefined;

        if (row?.context_token) {
          const token = row.context_token;
          // Populate L1 cache
          this.l1Cache.set(cleanSenderId, {
            token,
            expiresAt: Date.now() + this.ttlMs,
            replyCount: 0,
          });
          return token;
        }
      } catch {
        // Ignore query error
      }

      // 3. Fallback to channel_inbox payload if present
      try {
        const nativeCtx = `wechat:${cleanSenderId}`;
        const inboxRow = this.db
          .prepare(`
            SELECT payload_json FROM channel_inbox
            WHERE native_context_id = ? OR native_context_id = ?
            ORDER BY created_at DESC LIMIT 1
          `)
          .get(nativeCtx, cleanSenderId) as { payload_json?: string } | undefined;

        if (inboxRow?.payload_json) {
          const parsed = JSON.parse(inboxRow.payload_json);
          const token = parsed?.parsed?.contextToken || parsed?.rawMsg?.context_token;
          if (typeof token === 'string' && token.length > 0) {
            // Restore to L1 and L2
            await this.set(cleanSenderId, token);
            return token;
          }
        }
      } catch {
        // Ignore fallback error
      }
    }

    // 4. Fallback to optional onLoad hook
    if (this.onLoad) {
      try {
        const loaded = await this.onLoad(cleanSenderId);
        if (loaded) {
          this.l1Cache.set(cleanSenderId, {
            token: loaded,
            expiresAt: Date.now() + this.ttlMs,
            replyCount: 0,
          });
          return loaded;
        }
      } catch {
        // Ignore onLoad error
      }
    }

    return undefined;
  }

  /**
   * Checks whether a non-expired token exists for a sender.
   */
  async has(senderId: string): Promise<boolean> {
    const token = await this.get(senderId);
    return token !== undefined;
  }

  /**
   * Deletes a token from both L1 and L2.
   */
  async delete(senderId: string): Promise<void> {
    if (!senderId) return;
    const cleanSenderId = senderId.trim();
    this.l1Cache.delete(cleanSenderId);

    if (this.db) {
      try {
        this.db
          .prepare('DELETE FROM channel_wechat_context_tokens WHERE sender_id = ?')
          .run(cleanSenderId);
      } catch {
        // Ignore
      }
    }
  }

  /**
   * Increments reply count for a sender's context_token and checks threshold warnings.
   */
  async recordReply(senderId: string): Promise<{ replyCount: number; isWarning: boolean; isLimitReached: boolean }> {
    if (!senderId) return { replyCount: 0, isWarning: false, isLimitReached: false };
    const cleanSenderId = senderId.trim();
    // Ensure token is loaded in L1
    await this.get(cleanSenderId);
    const entry = this.l1Cache.get(cleanSenderId);
    if (!entry) return { replyCount: 0, isWarning: false, isLimitReached: false };

    entry.replyCount = (entry.replyCount || 0) + 1;
    const currentCount = entry.replyCount;
    const limit = this.maxRepliesPerToken;
    const warnThresh = this.replyWarningThreshold;

    let isWarning = false;
    let isLimitReached = false;

    if (limit !== undefined && currentCount >= limit) {
      isLimitReached = true;
    }

    if (limit !== undefined && warnThresh !== undefined && currentCount >= (limit - warnThresh)) {
      isWarning = true;
      if (this.onWarning) {
        try {
          this.onWarning(cleanSenderId, currentCount, limit);
        } catch {}
      }
    }

    return { replyCount: currentCount, isWarning, isLimitReached };
  }

  /**
   * Clears the L1 in-memory cache.
   */
  clear(): void {
    this.l1Cache.clear();
  }
}
