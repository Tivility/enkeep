import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getPlatformDefaultContextWindow,
  resolveTopLevelContextWindow,
  resolveChildContextWindow,
  DEFAULT_ENKEEP_CONTEXT_WINDOW,
} from '@enkeep/platform-core';

describe('Piece 1: Context Window Resolution and Environment Variable', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('getPlatformDefaultContextWindow', () => {
    it('defaults to 272000 when ENKEEP_CONTEXT_WINDOW_DEFAULT is unset', () => {
      delete process.env.ENKEEP_CONTEXT_WINDOW_DEFAULT;
      expect(getPlatformDefaultContextWindow()).toBe(DEFAULT_ENKEEP_CONTEXT_WINDOW);
      expect(getPlatformDefaultContextWindow()).toBe(272000);
    });

    it('reads custom ENKEEP_CONTEXT_WINDOW_DEFAULT integer from environment', () => {
      process.env.ENKEEP_CONTEXT_WINDOW_DEFAULT = '350000';
      expect(getPlatformDefaultContextWindow()).toBe(350000);
    });

    it('falls back to default when ENKEEP_CONTEXT_WINDOW_DEFAULT is invalid', () => {
      process.env.ENKEEP_CONTEXT_WINDOW_DEFAULT = 'not_a_number';
      expect(getPlatformDefaultContextWindow()).toBe(272000);
    });
  });

  describe('resolveTopLevelContextWindow', () => {
    it('resolves session override when present', () => {
      const res = resolveTopLevelContextWindow({
        sessionContextWindow: 128000,
        spaceContextWindow: 200000,
      });
      expect(res.contextWindow).toBe(128000);
      expect(res.source).toBe('session');
      expect(res.override).toBe(128000);
    });

    it('resolves space override when session is unset', () => {
      const res = resolveTopLevelContextWindow({
        sessionContextWindow: null,
        spaceContextWindow: 200000,
      });
      expect(res.contextWindow).toBe(200000);
      expect(res.source).toBe('space');
      expect(res.override).toBeNull();
    });

    it('resolves platform default when both session and space are unset', () => {
      delete process.env.ENKEEP_CONTEXT_WINDOW_DEFAULT;
      const res = resolveTopLevelContextWindow({
        sessionContextWindow: null,
        spaceContextWindow: null,
      });
      expect(res.contextWindow).toBe(272000);
      expect(res.source).toBe('platform');
      expect(res.override).toBeNull();
    });
  });

  describe('resolveChildContextWindow', () => {
    it('always returns platform child default unaffected by parent overrides', () => {
      delete process.env.ENKEEP_CONTEXT_WINDOW_DEFAULT;
      const res = resolveChildContextWindow();
      expect(res.contextWindow).toBe(272000);
      expect(res.source).toBe('child_default');
    });
  });
});
