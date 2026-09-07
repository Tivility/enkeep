import { describe, it, expect } from 'vitest';
import {
  validateLoopbackHost,
  validateSafePort,
  findEphemeralPort,
  probePortListener,
  probeProtectedPorts,
  assertProbesUnchanged,
} from '../src/utils/probes.js';

describe('Host, Port, and Probe Safety Utilities', () => {
  describe('validateLoopbackHost', () => {
    it('accepts strictly loopback host 127.0.0.1', () => {
      expect(() => validateLoopbackHost('127.0.0.1')).not.toThrow();
    });

    it('rejects non-exact hosts (localhost, ::1, 0.0.0.0, wildcards)', () => {
      expect(() => validateLoopbackHost('localhost')).toThrow(/Unsafe host binding|Forbidden host binding/);
      expect(() => validateLoopbackHost('::1')).toThrow(/Unsafe host binding|Forbidden host binding/);
      expect(() => validateLoopbackHost('0.0.0.0')).toThrow(/Forbidden host binding/);
      expect(() => validateLoopbackHost('::')).toThrow(/Forbidden host binding/);
      expect(() => validateLoopbackHost('*')).toThrow(/Forbidden host binding/);
      expect(() => validateLoopbackHost('192.168.1.100')).toThrow(/Unsafe host binding/);
    });
  });

  describe('validateSafePort', () => {
    it('accepts ephemeral port 0 and safe user-space ports', () => {
      expect(() => validateSafePort(0)).not.toThrow();
      expect(() => validateSafePort(3100)).not.toThrow();
      expect(() => validateSafePort(8080)).not.toThrow();
    });

    it('rejects protected system ports 3000 (HappyClaw) and 3080 (DSH GUI)', () => {
      expect(() => validateSafePort(3000)).toThrow(/Port 3000 is reserved\/protected/);
      expect(() => validateSafePort(3080)).toThrow(/Port 3080 is reserved\/protected/);
    });

    it('rejects invalid or out of range ports', () => {
      expect(() => validateSafePort(80)).toThrow(/Invalid port/);
      expect(() => validateSafePort(99999)).toThrow(/Invalid port/);
    });
  });

  describe('findEphemeralPort', () => {
    it('finds an available dynamic ephemeral port on 127.0.0.1', async () => {
      const port = await findEphemeralPort();
      expect(port).toBeGreaterThanOrEqual(1024);
      expect(port).toBeLessThanOrEqual(65535);
      expect(port).not.toBe(3000);
      expect(port).not.toBe(3080);
    });
  });

  describe('assertProbesUnchanged', () => {
    const timestamp = new Date().toISOString();

    it('returns unchanged true when before and after probes match', () => {
      const before = {
        port3000: { target: '127.0.0.1:3000', port: 3000, reachable: true, listenerPid: 1234, timestamp },
        port3080: { target: '127.0.0.1:3080', port: 3080, reachable: true, listenerPid: 5678, timestamp },
      };
      const after = {
        port3000: { target: '127.0.0.1:3000', port: 3000, reachable: true, listenerPid: 1234, timestamp },
        port3080: { target: '127.0.0.1:3080', port: 3080, reachable: true, listenerPid: 5678, timestamp },
      };

      const result = assertProbesUnchanged(before, after);
      expect(result.unchanged).toBe(true);
      expect(result.discrepancies).toHaveLength(0);
    });

    it('detects PID disruption on protected ports', () => {
      const before = {
        port3000: { target: '127.0.0.1:3000', port: 3000, reachable: true, listenerPid: 1234, timestamp },
        port3080: { target: '127.0.0.1:3080', port: 3080, reachable: true, listenerPid: 5678, timestamp },
      };
      const after = {
        port3000: { target: '127.0.0.1:3000', port: 3000, reachable: true, listenerPid: 9999, timestamp },
        port3080: { target: '127.0.0.1:3080', port: 3080, reachable: true, listenerPid: 5678, timestamp },
      };

      const result = assertProbesUnchanged(before, after);
      expect(result.unchanged).toBe(false);
      expect(result.discrepancies.some((d) => d.includes('CRITICAL SAFETY DISRUPTION'))).toBe(true);
    });
  });
});
