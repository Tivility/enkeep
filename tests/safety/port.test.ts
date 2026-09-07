import { describe, it, expect } from 'vitest';
import * as net from 'node:net';
import {
  validateHost,
  isPortExcluded,
  validatePort,
  isPortAvailable,
  findAvailablePort,
  allocatePorts,
} from '../../scripts/safety/port.js';
import { DEFAULT_EXCLUDED_PORTS } from '../../scripts/safety/constants.js';
import { SafetyViolationError } from '../../scripts/safety/errors.js';

describe('Port Safety & Allocator Module', () => {
  describe('validateHost', () => {
    it('allows strictly exact 127.0.0.1 loopback address', () => {
      expect(() => validateHost('127.0.0.1')).not.toThrow();
      expect(() => validateHost(' 127.0.0.1 ')).not.toThrow();
    });

    it('rejects localhost, ::1, 0.0.0.0, and wildcard / public hosts', () => {
      expect(() => validateHost('localhost')).toThrow(SafetyViolationError);
      expect(() => validateHost('::1')).toThrow(SafetyViolationError);
      expect(() => validateHost('LOCALHOST')).toThrow(SafetyViolationError);
      expect(() => validateHost('0.0.0.0')).toThrow(SafetyViolationError);
      expect(() => validateHost('::')).toThrow(SafetyViolationError);
      expect(() => validateHost('0:0:0:0:0:0:0:0')).toThrow(SafetyViolationError);
      expect(() => validateHost('*')).toThrow(SafetyViolationError);
      expect(() => validateHost('192.168.1.100')).toThrow(SafetyViolationError);
      expect(() => validateHost('0.0.0.0:8080')).toThrow(SafetyViolationError);
    });

    it('throws with UNSAFE_HOST_BINDING code on forbidden host', () => {
      try {
        validateHost('0.0.0.0');
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(SafetyViolationError);
        expect(err.code).toBe('UNSAFE_HOST_BINDING');
      }

      try {
        validateHost('localhost');
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(SafetyViolationError);
        expect(err.code).toBe('UNSAFE_HOST_BINDING');
      }
    });
  });

  describe('isPortExcluded & validatePort', () => {
    it('correctly identifies default protected ports 3000 (HappyClaw) and 3080 (DSH GUI)', () => {
      expect(isPortExcluded(3000)).toBe(true);
      expect(isPortExcluded(3080)).toBe(true);
      for (const p of DEFAULT_EXCLUDED_PORTS) {
        expect(isPortExcluded(p)).toBe(true);
      }
      expect(isPortExcluded(3100)).toBe(false);
    });

    it('supports custom excluded ports', () => {
      const custom = [4000, 5000, 8080];
      expect(isPortExcluded(4000, custom)).toBe(true);
      expect(isPortExcluded(5000, custom)).toBe(true);
      expect(isPortExcluded(8080, custom)).toBe(true);
      expect(isPortExcluded(4001, custom)).toBe(false);
      // Default protected ports are still excluded
      expect(isPortExcluded(3000, custom)).toBe(true);
      expect(isPortExcluded(3080, custom)).toBe(true);
    });

    it('validatePort throws on excluded or invalid ports', () => {
      expect(() => validatePort(3000)).toThrow(SafetyViolationError);
      expect(() => validatePort(3080)).toThrow(SafetyViolationError);
      expect(() => validatePort(-1)).toThrow(SafetyViolationError);
      expect(() => validatePort(0)).toThrow(SafetyViolationError);
      expect(() => validatePort(70000)).toThrow(SafetyViolationError);
      expect(() => validatePort(3.14)).toThrow(SafetyViolationError);

      expect(() => validatePort(3100)).not.toThrow();
    });
  });

  describe('isPortAvailable', () => {
    it('rejects forbidden host before checking port', async () => {
      await expect(isPortAvailable(8080, '0.0.0.0')).rejects.toThrow(SafetyViolationError);
    });

    it('returns false when a port is actively in use', async () => {
      // Create a temporary listening socket on loopback
      const server = net.createServer();
      await new Promise<void>((resolve) => {
        server.listen({ port: 0, host: '127.0.0.1' }, () => resolve());
      });

      const port = (server.address() as net.AddressInfo).port;
      try {
        const available = await isPortAvailable(port, '127.0.0.1');
        expect(available).toBe(false);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('returns true for an unbound port', async () => {
      // Find a dynamically assigned port, then close it to ensure it is available
      const server = net.createServer();
      await new Promise<void>((resolve) => {
        server.listen({ port: 0, host: '127.0.0.1' }, () => resolve());
      });
      const port = (server.address() as net.AddressInfo).port;
      await new Promise<void>((resolve) => server.close(() => resolve()));

      const available = await isPortAvailable(port, '127.0.0.1');
      expect(available).toBe(true);
    });
  });

  describe('findAvailablePort', () => {
    it('finds a free port on 127.0.0.1 excluding protected ports', async () => {
      const port = await findAvailablePort({
        startPort: 3100,
        endPort: 3200,
      });

      expect(port).toBeGreaterThanOrEqual(3100);
      expect(port).toBeLessThanOrEqual(3200);
      expect(port).not.toBe(3000);
      expect(port).not.toBe(3080);
    });

    it('respects caller excluded ports', async () => {
      const customExcluded = [3100, 3101, 3102];
      const port = await findAvailablePort({
        startPort: 3100,
        endPort: 3110,
        excludePorts: customExcluded,
      });

      expect(port).toBeGreaterThanOrEqual(3103);
      expect(customExcluded.includes(port)).toBe(false);
    });

    it('rejects unsafe host in options', async () => {
      await expect(
        findAvailablePort({ host: '0.0.0.0' })
      ).rejects.toThrow(SafetyViolationError);
    });

    it('throws when port range is exhausted', async () => {
      await expect(
        findAvailablePort({
          startPort: 3000,
          endPort: 3000, // Only 3000, which is excluded
        })
      ).rejects.toThrow(SafetyViolationError);
    });
  });

  describe('allocatePorts', () => {
    it('allocates distinct safe ports for multiple services', async () => {
      const ports = await allocatePorts(['platform', 'bridge', 'im-approval'] as const, {
        startPort: 3150,
      });

      expect(ports.platform).toBeDefined();
      expect(ports.bridge).toBeDefined();
      expect(ports['im-approval']).toBeDefined();

      const uniquePorts = new Set(Object.values(ports));
      expect(uniquePorts.size).toBe(3);

      for (const p of Object.values(ports)) {
        expect(p).not.toBe(3000);
        expect(p).not.toBe(3080);
      }
    });
  });
});
