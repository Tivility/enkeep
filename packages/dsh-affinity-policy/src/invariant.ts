/**
 * Package-owned invariant companion for @enkeep/dsh-affinity-policy.
 * Safe no-op companion retained for interface compatibility after dsh-invariants removal.
 */

import type { Context } from '@deepseek-ai/cordis';

export const name = 'enkeep-affinity-policy-invariant';

export function apply(_ctx: Context): void {
  // No-op: dsh-invariants dropped in DSH 0.2.0-rc.2.
}
