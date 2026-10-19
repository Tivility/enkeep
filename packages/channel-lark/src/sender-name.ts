/**
 * Feishu / Lark sender name resolver with layered cache and graceful fallback.
 *
 * Priority:
 * 1. In-memory LRU cache (seeded also from @mention names)
 * 2. Group chat members bulk query (im.v1.chatMembers.get)
 * 3. User contact query (contact.v3.user.get)
 *
 * Non-blocking:
 * - 3s hard timeout per resolve invocation.
 * - Missing scope (error 99991672) triggers 30-minute backoff.
 * - Unresolved / failed lookups do not throw or block message delivery.
 */

export type FeishuSenderNameSource = 'contact' | 'chat_members';
export type FeishuSenderNameErrorKind = 'missing_scope' | 'transient' | 'definitive';

export interface FeishuChatMemberPage {
  members: Array<{ openId: string; name?: string }>;
  hasMore: boolean;
  pageToken?: string;
}

export interface FeishuSenderNameResolverOptions {
  lookup?: (openId: string) => Promise<string | undefined>;
  listChatMembers?: (chatId: string, pageToken?: string) => Promise<FeishuChatMemberPage>;
  classifyError?: (error: unknown) => FeishuSenderNameErrorKind;
  now?: () => number;
  timeoutMs?: number;               // Default 3_000ms
  requestTimeoutMs?: number;        // Default 10_000ms
  positiveTtlMs?: number;           // Default 6 hours (21_600_000ms)
  negativeTtlMs?: number;           // Default 10 minutes (600_000ms)
  transientTtlMs?: number;          // Default 1 minute (60_000ms)
  missingScopeBackoffMs?: number;   // Default 30 minutes (1_800_000ms)
  memberListRefreshMs?: number;     // Default 1 minute (60_000ms)
  maxMemberPages?: number;          // Default 5 pages
  maxEntries?: number;              // Default 2_000 entries
  maxChats?: number;                // Default 64 chats
  onLookupError?: (source: FeishuSenderNameSource, target: string, error: unknown) => void;
  onMissingScope?: (source: FeishuSenderNameSource, error: unknown) => void;
}

export interface FeishuSenderNameResolver {
  resolve(openId: string, groupChatId?: string): Promise<string | undefined>;
  peek(openId: string): string | undefined;
  cacheMentionName(openId: string, name: string): void;
}

interface CacheEntry {
  name?: string;
  expiresAt: number;
}

interface ChatMembersCacheEntry {
  fetchedAt: number;
  expiresAt: number;
}

export function classifyFeishuError(err: unknown): FeishuSenderNameErrorKind {
  if (!err || typeof err !== 'object') {
    return 'definitive';
  }
  const anyErr = err as Record<string, unknown>;
  const code = Number(
    anyErr.code ??
    ((anyErr.response as Record<string, unknown> | undefined)?.data &&
      ((anyErr.response as Record<string, unknown>).data as Record<string, unknown>).code)
  );
  if (code === 99991672) {
    return 'missing_scope';
  }
  if (
    code === 99991400 ||
    code === 230020 ||
    code === 429 ||
    anyErr.name === 'AbortError' ||
    anyErr.code === 'ETIMEDOUT' ||
    anyErr.code === 'ECONNRESET'
  ) {
    return 'transient';
  }
  return 'definitive';
}

class SimpleLRUCache<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly maxCapacity: number) {}

  get(key: K): V | undefined {
    const val = this.map.get(key);
    if (val !== undefined) {
      this.map.delete(key);
      this.map.set(key, val);
    }
    return val;
  }

  set(key: K, val: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxCapacity) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        this.map.delete(oldestKey);
      }
    }
    this.map.set(key, val);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

export function createFeishuSenderNameResolver(
  options: FeishuSenderNameResolverOptions = {}
): FeishuSenderNameResolver {
  const nowFn = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? 3_000;
  const positiveTtlMs = options.positiveTtlMs ?? 6 * 3600 * 1000; // 6h
  const negativeTtlMs = options.negativeTtlMs ?? 10 * 60 * 1000;  // 10m
  const transientTtlMs = options.transientTtlMs ?? 60 * 1000;     // 1m
  const missingScopeBackoffMs = options.missingScopeBackoffMs ?? 30 * 60 * 1000; // 30m
  const memberListRefreshMs = options.memberListRefreshMs ?? 60 * 1000; // 1m
  const maxMemberPages = options.maxMemberPages ?? 5;
  const maxEntries = options.maxEntries ?? 2_000;
  const maxChats = options.maxChats ?? 64;

  const classify = options.classifyError ?? classifyFeishuError;

  const namesCache = new SimpleLRUCache<string, CacheEntry>(maxEntries);
  const chatMembersCache = new SimpleLRUCache<string, ChatMembersCacheEntry>(maxChats);

  let chatMembersBackoffUntil = 0;
  let contactBackoffUntil = 0;

  // In-flight dedup: key -> Promise<string | undefined>
  const inFlightResolutions = new Map<string, Promise<string | undefined>>();

  function setCachedName(openId: string, name: string | undefined, ttlMs: number): void {
    namesCache.set(openId, {
      name,
      expiresAt: nowFn() + ttlMs,
    });
  }

  function getCachedName(openId: string): string | undefined {
    const entry = namesCache.get(openId);
    if (!entry) return undefined;
    if (nowFn() > entry.expiresAt) {
      namesCache.delete(openId);
      return undefined;
    }
    return entry.name;
  }

  async function loadChatMembers(chatId: string): Promise<void> {
    if (!options.listChatMembers) return;
    const now = nowFn();
    if (now < chatMembersBackoffUntil) return;

    const chatEntry = chatMembersCache.get(chatId);
    if (chatEntry && now - chatEntry.fetchedAt < memberListRefreshMs) {
      return;
    }

    chatMembersCache.set(chatId, {
      fetchedAt: now,
      expiresAt: now + positiveTtlMs,
    });

    try {
      let pageToken: string | undefined;
      let pages = 0;

      while (pages < maxMemberPages) {
        pages++;
        const page = await options.listChatMembers(chatId, pageToken);
        for (const m of page.members) {
          if (m.openId && m.name && m.name.trim().length > 0) {
            setCachedName(m.openId, m.name.trim(), positiveTtlMs);
          }
        }
        if (!page.hasMore || !page.pageToken) {
          break;
        }
        pageToken = page.pageToken;
      }
    } catch (err) {
      const kind = classify(err);
      if (kind === 'missing_scope') {
        chatMembersBackoffUntil = nowFn() + missingScopeBackoffMs;
        options.onMissingScope?.('chat_members', err);
      } else {
        options.onLookupError?.('chat_members', chatId, err);
      }
    }
  }

  async function lookupContact(openId: string): Promise<string | undefined> {
    if (!options.lookup) return undefined;
    const now = nowFn();
    if (now < contactBackoffUntil) return undefined;

    try {
      const name = await options.lookup(openId);
      if (name && name.trim().length > 0) {
        const clean = name.trim();
        setCachedName(openId, clean, positiveTtlMs);
        return clean;
      }
      setCachedName(openId, undefined, negativeTtlMs);
      return undefined;
    } catch (err) {
      const kind = classify(err);
      if (kind === 'missing_scope') {
        contactBackoffUntil = nowFn() + missingScopeBackoffMs;
        options.onMissingScope?.('contact', err);
        setCachedName(openId, undefined, missingScopeBackoffMs);
      } else if (kind === 'transient') {
        options.onLookupError?.('contact', openId, err);
        setCachedName(openId, undefined, transientTtlMs);
      } else {
        options.onLookupError?.('contact', openId, err);
        setCachedName(openId, undefined, negativeTtlMs);
      }
      return undefined;
    }
  }

  async function doResolve(openId: string, groupChatId?: string): Promise<string | undefined> {
    const cached = getCachedName(openId);
    if (cached !== undefined) {
      return cached;
    }

    if (groupChatId) {
      await loadChatMembers(groupChatId);
      const afterChatLoad = getCachedName(openId);
      if (afterChatLoad !== undefined) {
        return afterChatLoad;
      }
    }

    const contactName = await lookupContact(openId);
    if (contactName !== undefined) {
      return contactName;
    }

    return undefined;
  }

  return {
    async resolve(openId: string, groupChatId?: string): Promise<string | undefined> {
      if (!openId || openId.trim().length === 0) {
        return undefined;
      }
      const cleanOpenId = openId.trim();

      const existing = getCachedName(cleanOpenId);
      if (existing !== undefined) {
        return existing;
      }

      const dedupKey = `${cleanOpenId}:${groupChatId ?? ''}`;
      let inFlight = inFlightResolutions.get(dedupKey);

      if (!inFlight) {
        inFlight = doResolve(cleanOpenId, groupChatId).finally(() => {
          inFlightResolutions.delete(dedupKey);
        });
        inFlightResolutions.set(dedupKey, inFlight);
      }

      // Race with timeoutMs. If timed out, return undefined immediately, but allow resolution to complete in background.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      });

      try {
        const result = await Promise.race([inFlight, timeoutPromise]);
        return result;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },

    peek(openId: string): string | undefined {
      if (!openId) return undefined;
      return getCachedName(openId.trim());
    },

    cacheMentionName(openId: string, name: string): void {
      if (!openId || !name) return;
      const cleanId = openId.trim();
      const cleanName = name.trim();
      if (cleanId.length === 0 || cleanName.length === 0) return;
      setCachedName(cleanId, cleanName, positiveTtlMs);
    },
  };
}
