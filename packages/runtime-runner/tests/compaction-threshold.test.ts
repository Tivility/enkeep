import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  deriveCompactionThresholdRatio,
  resolveDaemonBootConfig,
} from '../src/runtime/daemon-cli.js';

describe('Piece 1: Compaction Threshold Derivation and Environment Variable', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('deriveCompactionThresholdRatio', () => {
    it('yields 0.2 for 1,000,000 contextWindow and 200,000 threshold', () => {
      const ratio = deriveCompactionThresholdRatio(200000, 1000000);
      expect(ratio).toBeCloseTo(0.2);
    });

    it('yields 0.5 for 400,000 contextWindow and 200,000 threshold', () => {
      const ratio = deriveCompactionThresholdRatio(200000, 400000);
      expect(ratio).toBeCloseTo(0.5);
    });

    it('clamps ratio to minimum 0.2 when threshold / contextWindow < 0.2', () => {
      const ratio = deriveCompactionThresholdRatio(50000, 1000000);
      expect(ratio).toBe(0.2);
    });

    it('clamps ratio to maximum 0.8 when threshold / contextWindow > 0.8', () => {
      const ratio = deriveCompactionThresholdRatio(900000, 1000000);
      expect(ratio).toBe(0.8);
    });

    it('handles zero or negative contextWindow by returning 0.2', () => {
      expect(deriveCompactionThresholdRatio(200000, 0)).toBe(0.2);
      expect(deriveCompactionThresholdRatio(200000, -100)).toBe(0.2);
    });
  });

  describe('resolveDaemonBootConfig', () => {
    it('defaults thresholdTokens to 200000 when DSH_COMPACTION_THRESHOLD_TOKENS is unset', () => {
      delete process.env.DSH_COMPACTION_THRESHOLD_TOKENS;
      const config = resolveDaemonBootConfig();
      expect(config.compaction).toBeDefined();
      expect(config.compaction?.thresholdTokens).toBe(200000);
    });

    it('reads custom DSH_COMPACTION_THRESHOLD_TOKENS integer from environment', () => {
      process.env.DSH_COMPACTION_THRESHOLD_TOKENS = '350000';
      const config = resolveDaemonBootConfig();
      expect(config.compaction).toBeDefined();
      expect(config.compaction?.thresholdTokens).toBe(350000);
    });
  });
});
