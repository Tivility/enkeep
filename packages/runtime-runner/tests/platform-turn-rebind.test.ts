import { describe, it, expect } from 'vitest';
import { platformTurnRebindDecision } from '../src/runtime/dsh-boot.js';

describe('platform turn binding across DSH turns', () => {
  it('corrects the guessed DSH turn number with the first turn that starts', () => {
    expect(platformTurnRebindDecision(false, 5, 6)).toBe('rebind');
    expect(platformTurnRebindDecision(false, undefined, 3)).toBe('rebind');
    expect(platformTurnRebindDecision(false, 5, 5)).toBe('keep');
  });

  it('leaves later DSH turns (child messages, completion notices) to autonomous attribution', () => {
    expect(platformTurnRebindDecision(true, 5, 6)).toBe('ignore');
    expect(platformTurnRebindDecision(true, 5, 7)).toBe('ignore');
  });
});
