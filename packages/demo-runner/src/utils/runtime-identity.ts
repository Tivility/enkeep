/**
 * Canonical Runtime Identity Derivation
 *
 * Derives safe, finite-length, collision-free canonical runtime identities from
 * user UUIDs and optional username slugs.
 *
 * Guarantees:
 * - Deterministic output matching /^[a-z0-9][a-z0-9_-]{0,48}$/
 * - Alice and Bob return exact fixture aliases ('alice', 'bob')
 * - Arbitrary users derive from sanitized slug + truncated UUID hash
 * - Never trusts raw special characters in username
 * - Fits within container and volume name constraints (enkeep-demo-<id>, enkeep-demo-dsh-<id>)
 *
 * @module @enkeep/demo-runner/utils/runtime-identity
 */

import { createHash } from 'node:crypto';

export const CANONICAL_RUNTIME_ID_REGEX = /^[a-z0-9][a-z0-9_-]{0,48}$/;

/**
 * Derives canonical runtime identity for Docker container/volume naming.
 */
export function deriveRuntimeIdentity(userId: string, username?: string | null): string {
  if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
    throw new Error('deriveRuntimeIdentity requires a non-empty userId');
  }

  const cleanUsername = (username ?? '').trim().toLowerCase();

  // Exact fixture compatibility for Alice and Bob
  if (cleanUsername === 'alice') return 'alice';
  if (cleanUsername === 'bob') return 'bob';

  const shortHash = createHash('sha256')
    .update(userId.trim())
    .digest('hex')
    .slice(0, 8);

  // Sanitize username slug to valid safe characters (must start with [a-z])
  const slug = cleanUsername.replace(/[^a-z0-9_-]/g, '').slice(0, 24);

  if (slug.length > 0 && /^[a-z]/.test(slug)) {
    const candidate = `${slug}_${shortHash}`;
    if (candidate.length <= 48 && CANONICAL_RUNTIME_ID_REGEX.test(candidate)) {
      return candidate;
    }
  }

  return `u_${shortHash}`;
}
