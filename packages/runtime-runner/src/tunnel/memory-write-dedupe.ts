/**
 * Request-id dedupe for platform writes of the user's host memory copy.
 *
 * The container retries a global `memory_write` on timeouts and transient failures with the same
 * `Idempotency-Key`. A retry of a write that was already applied (e.g. the response was lost or
 * arrived after the client timeout) must return the original result instead of applying the
 * write again — otherwise an `append` would be applied twice.
 *
 * - Keyed by memory root + idempotency key, so keys never collide across users.
 * - The same key with a different request (path/mode/content/expectedEtag) is rejected.
 * - Only final outcomes are remembered (applied: 200, conflict: 409).
 * - Process-local and bounded (TTL + max entries). It survives tunnel reconnects (one shared
 *   instance per platform process) but not a platform restart.
 *
 * The write itself runs synchronously in the platform process, so a retry can never overlap the
 * original attempt's read-compare-write.
 */

import { createHash } from 'node:crypto';

export interface MemoryWriteDedupeRecord {
  readonly status: number;
  readonly body: unknown;
}

interface Entry extends MemoryWriteDedupeRecord {
  readonly fingerprint: string;
  readonly expiresAt: number;
}

export type MemoryWriteDedupeLookup =
  | { readonly kind: 'miss' }
  | { readonly kind: 'replay'; readonly record: MemoryWriteDedupeRecord }
  | { readonly kind: 'mismatch' };

export interface MemoryWriteDedupeOptions {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
}

export const DEFAULT_MEMORY_WRITE_DEDUPE_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_MEMORY_WRITE_DEDUPE_MAX_ENTRIES = 4096;

export function memoryWriteFingerprint(request: {
  readonly path: string;
  readonly mode?: string;
  readonly content: string;
  readonly expectedEtag?: string;
}): string {
  return createHash('sha256')
    .update(JSON.stringify([request.path, request.mode ?? 'overwrite', request.expectedEtag ?? null, request.content]))
    .digest('hex');
}

export class MemoryWriteDedupeCache {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: MemoryWriteDedupeOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_MEMORY_WRITE_DEDUPE_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MEMORY_WRITE_DEDUPE_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
  }

  private key(memoryRoot: string, idempotencyKey: string): string {
    return `${memoryRoot}\0${idempotencyKey}`;
  }

  lookup(memoryRoot: string, idempotencyKey: string, fingerprint: string): MemoryWriteDedupeLookup {
    const k = this.key(memoryRoot, idempotencyKey);
    const entry = this.entries.get(k);
    if (!entry) return { kind: 'miss' };
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(k);
      return { kind: 'miss' };
    }
    if (entry.fingerprint !== fingerprint) return { kind: 'mismatch' };
    return { kind: 'replay', record: { status: entry.status, body: entry.body } };
  }

  remember(memoryRoot: string, idempotencyKey: string, fingerprint: string, record: MemoryWriteDedupeRecord): void {
    const now = this.now();
    for (const [k, e] of this.entries) {
      if (e.expiresAt > now && this.entries.size < this.maxEntries) break;
      this.entries.delete(k); // insertion order = oldest first
    }
    this.entries.set(this.key(memoryRoot, idempotencyKey), { ...record, fingerprint, expiresAt: now + this.ttlMs });
  }

  get size(): number {
    return this.entries.size;
  }
}

/** One instance per platform process, shared by every proxy handler (survives reconnects). */
export const sharedMemoryWriteDedupe = new MemoryWriteDedupeCache();
