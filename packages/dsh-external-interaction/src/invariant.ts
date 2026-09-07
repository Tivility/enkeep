/**
 * Package-owned invariant companion for @enkeep/dsh-external-interaction.
 */

import type { Context } from '@deepseek-ai/cordis';

export const name = 'enkeep-external-interaction-invariant';
export const inject = {
  optional: ['invariants'],
};

export function apply(ctx: Context): void {
  const invariants = ctx.get ? ctx.get('invariants') : undefined;
  if (invariants && typeof invariants.register === 'function') {
    invariants.register('@enkeep/dsh-external-interaction', () => {
      // Invariant assertions
    });
  }
}
