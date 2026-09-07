/**
 * Package-owned invariant companion for @enkeep/dsh-tools.
 */

import type { Context } from '@deepseek-ai/cordis';

export const name = 'enkeep-dsh-tools-invariant';
export const inject = {
  optional: ['invariants'],
};

export function apply(ctx: Context): void {
  const invariants = ctx.get ? ctx.get('invariants') : undefined;
  if (invariants && typeof invariants.register === 'function') {
    invariants.register('@enkeep/dsh-tools', () => {
      // Invariant checks
    });
  }
}
