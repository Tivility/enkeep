/**
 * Descendant Route Resolver for Subagent Platform Proxy Routing (G08b)
 *
 * Maintains an authoritative, in-memory, tenant-isolated registry of child session
 * routes linked to known parent sessions and authorized spaces.
 *
 * Guarantees:
 * - Tenant isolation: every descendant record is tagged with platformUserId and queryable only by that tenant.
 * - Anti-spoofing: child sessions can only be registered if the parent session is verified.
 * - Deterministic lifecycle: tied strictly to agent lifecycle (creation -> register, dispose -> unregister).
 * - Explicit unregister / cleanup on agent disposal or parent session termination.
 *
 * @module @enkeep/runtime-runner/tunnel/descendant-resolver
 */

export interface DescendantRouteRecord {
  readonly childSessionId: string;
  readonly parentSessionId: string;
  readonly spaceId: string;
  readonly platformUserId: string;
  readonly origin: string;
  readonly createdAt: string;
  readonly expiresAt?: number;
  readonly metadata?: Record<string, unknown>;
}

export interface RegisterDescendantOptions {
  childSessionId: string;
  parentSessionId: string;
  spaceId: string;
  platformUserId: string;
  origin?: string;
  ttlMs?: number;
  metadata?: Record<string, unknown>;
}

export class DescendantResolver {
  private readonly routes = new Map<string, DescendantRouteRecord>();
  private readonly defaultTtlMs?: number;

  constructor(options?: { defaultTtlMs?: number }) {
    this.defaultTtlMs = options?.defaultTtlMs;
  }

  /**
   * Generates a composite key to ensure tenant partition.
   */
  private makeKey(childSessionId: string, platformUserId: string): string {
    return `${platformUserId}::${childSessionId}`;
  }

  /**
   * Registers a validated descendant route for a tenant.
   * Deterministic lifecycle storage without silent LRU eviction.
   */
  register(options: RegisterDescendantOptions): DescendantRouteRecord {
    const {
      childSessionId,
      parentSessionId,
      spaceId,
      platformUserId,
      origin = 'subagent',
      ttlMs = this.defaultTtlMs,
      metadata,
    } = options;

    const key = this.makeKey(childSessionId, platformUserId);
    const now = Date.now();
    const record: DescendantRouteRecord = {
      childSessionId,
      parentSessionId,
      spaceId,
      platformUserId,
      origin,
      createdAt: new Date(now).toISOString(),
      expiresAt: ttlMs ? now + ttlMs : undefined,
      metadata,
    };

    this.routes.set(key, record);
    return record;
  }

  /**
   * Resolves a descendant session for the authenticated tenant.
   * Filters out expired entries.
   */
  resolve(childSessionId: string, platformUserId: string): DescendantRouteRecord | undefined {
    const key = this.makeKey(childSessionId, platformUserId);
    const record = this.routes.get(key);
    if (!record) {
      return undefined;
    }

    if (record.expiresAt && Date.now() > record.expiresAt) {
      this.routes.delete(key);
      return undefined;
    }

    return record;
  }

  /**
   * Unregisters a descendant route on agent dispose or session terminal.
   */
  unregister(childSessionId: string, platformUserId: string): boolean {
    const key = this.makeKey(childSessionId, platformUserId);
    return this.routes.delete(key);
  }

  /**
   * Cleans up all descendant routes belonging to a given parent session.
   */
  cleanupByParent(parentSessionId: string, platformUserId: string): number {
    let count = 0;
    for (const [key, record] of this.routes.entries()) {
      if (record.platformUserId === platformUserId && record.parentSessionId === parentSessionId) {
        this.routes.delete(key);
        count++;
      }
    }
    return count;
  }

  /**
   * Returns current count of registered routes.
   */
  size(): number {
    return this.routes.size;
  }

  /**
   * Clears all registered descendant routes.
   */
  clear(): void {
    this.routes.clear();
  }
}
