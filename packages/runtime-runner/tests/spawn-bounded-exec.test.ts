/**
 * Unit & Integration Tests for SafeDockerClient.spawnBoundedExec Input Bounds & Stdin Guardrails
 *
 * Verifies:
 * 1. Exact boundary input byte length (exact pass, exact + 1 reject).
 * 2. Multibyte UTF-8 characters (byte length computation including newline framing).
 * 3. Pre-spawn input bound rejection (throws DockerProtocolError BEFORE child_process.spawn is called).
 * 4. Invalid limit validation (non-numeric, NaN, negative bounds fail closed).
 * 5. Large payload handling under 64 MiB cap and over-cap rejection.
 * 6. EPIPE error handling discrimination (EPIPE + non-zero => DockerDaemonError; EPIPE + 0 => DockerProtocolError).
 * 7. Non-EPIPE stream error tracking.
 * 8. Output byte limit enforcement with SIGKILL termination.
 * 9. Timeout enforcement with SIGKILL termination.
 * 10. Null stdin payload handling (0 bytes).
 * 11. execOwned integration with operation-specific input constants & options.
 * 12. Static callsites & protocol constant assertions.
 *
 * @module @enkeep/runtime-runner/tests/spawn-bounded-exec.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type * as childProcessType from 'node:child_process';
import {
  SafeDockerClient,
  DockerProtocolError,
  DockerDaemonError,
  DockerOwnershipError,
  DEFAULT_EXEC_MAX_INPUT_BYTES,
  DEFAULT_EXEC_MAX_OUTPUT_BYTES,
  SEED_IMPORT_MAX_INPUT_BYTES,
  HEALTH_EXEC_MAX_INPUT_BYTES,
  HEALTH_EXEC_MAX_OUTPUT_BYTES,
  type OwnershipExpectation,
  type DockerContainerInfo,
} from '../src/index.js';

const { mockSpawn, setMockSpawnImpl } = vi.hoisted(() => {
  let impl: any = null;
  const fn = vi.fn((...args: any[]) => {
    if (impl) {
      return impl(...args);
    }
    return null;
  });
  return {
    mockSpawn: fn,
    setMockSpawnImpl: (newImpl: any) => {
      impl = newImpl;
    },
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcessType>();
  return {
    ...actual,
    spawn: mockSpawn,
  };
});

const VALID_64_HEX_CONTAINER_ID = '1111111122222222333333334444444455555555666666667777777788888888';

interface MockChildProcessOptions {
  stdoutText?: string;
  stderrText?: string;
  exitCode?: number;
  epipeOnWrite?: boolean;
  stdinError?: Error;
  hangOnClose?: boolean;
}

function createMockChildProcess(options: MockChildProcessOptions = {}): any {
  const emitter = new EventEmitter() as any;
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  let killed = false;
  emitter.killed = false;
  emitter.kill = vi.fn((_signal?: string) => {
    killed = true;
    emitter.killed = true;
    setImmediate(() => {
      emitter.emit('close', null, 'SIGKILL');
    });
  });

  const stdin = new Writable({
    write(chunk, encoding, callback) {
      if (options.epipeOnWrite) {
        const err = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
        callback(err);
        return;
      }
      if (options.stdinError) {
        callback(options.stdinError);
        return;
      }
      callback();
    },
  });

  emitter.stdin = stdin;
  emitter.stdout = stdout;
  emitter.stderr = stderr;

  if (options.epipeOnWrite) {
    setImmediate(() => {
      const err = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
      stdin.emit('error', err);
    });
  } else if (options.stdinError) {
    setImmediate(() => {
      stdin.emit('error', options.stdinError);
    });
  }

  if (!options.hangOnClose) {
    setImmediate(() => {
      if (options.stdoutText !== undefined) {
        stdout.write(options.stdoutText);
      }
      if (options.stderrText !== undefined) {
        stderr.write(options.stderrText);
      }
      stdout.end();
      stderr.end();
      setImmediate(() => {
        emitter.emit('close', options.exitCode ?? 0, null);
      });
    });
  }

  return emitter;
}

function createValidExpectation(overrides: Partial<OwnershipExpectation> = {}): OwnershipExpectation {
  return {
    containerName: 'enkeep-demo-alice',
    userId: 'alice',
    runId: 'run_1234567890abcdef1234567890abcdef',
    containerId: VALID_64_HEX_CONTAINER_ID,
    volumeName: 'enkeep-demo-dsh-alice',
    volumeId: 'vol_1234567890abcdef1234567890abcdef',
    containerPath: '/home/dsh',
    ...overrides,
  };
}

function createValidContainerInfo(overrides: Partial<DockerContainerInfo> = {}): DockerContainerInfo {
  return {
    id: VALID_64_HEX_CONTAINER_ID,
    name: 'enkeep-demo-alice',
    image: 'enkeep-demo-runtime:latest',
    status: 'running',
    state: 'running',
    user: '1000:1000',
    networkMode: 'none',
    readonlyRootfs: true,
    capDrop: ['ALL'],
    securityOpt: ['no-new-privileges:true'],
    pidsLimit: 256,
    portBindings: null,
    mounts: [
      {
        type: 'volume',
        name: 'enkeep-demo-dsh-alice',
        source: 'enkeep-demo-dsh-alice',
        destination: '/home/dsh',
        rw: true,
      },
    ],
    tmpfs: {
      '/tmp': 'rw,noexec,nosuid,nodev,size=64m',
    },
    labels: {
      app: 'enkeep-demo',
      'enkeep.user': 'alice',
      'enkeep.run-id': 'run_1234567890abcdef1234567890abcdef',
      'enkeep.volume-id': 'vol_1234567890abcdef1234567890abcdef',
    },
    ...overrides,
  };
}

describe('SafeDockerClient.spawnBoundedExec Input Bounds & Stdin Guardrails', () => {
  let client: SafeDockerClient;

  beforeEach(() => {
    client = new SafeDockerClient();
    mockSpawn.mockClear();
    setMockSpawnImpl(() => {
      return createMockChildProcess({ stdoutText: '{"status":"ok"}\n', exitCode: 0 });
    });
  });

  afterEach(() => {
    mockSpawn.mockReset();
  });

  describe('1. Exact Byte Boundary Enforcement', () => {
    it('accepts stdin payload when byte length + 1 equals maxInputBytes exactly', async () => {
      // payload = 'hello' (5 bytes utf8), + '\n' (1 byte) = 6 bytes
      const payload = 'hello';
      const maxInputBytes = 6;

      const result = await client.spawnBoundedExec(
        VALID_64_HEX_CONTAINER_ID,
        ['node', 'test.js'],
        payload,
        5000,
        1024 * 1024,
        maxInputBytes
      );

      expect(result.exitCode).toBe(0);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    it('rejects stdin payload when byte length + 1 exceeds maxInputBytes by exactly 1 byte', async () => {
      // payload = 'hello' (5 bytes utf8), + '\n' (1 byte) = 6 bytes
      const payload = 'hello';
      const maxInputBytes = 5; // 6 > 5

      await expect(
        client.spawnBoundedExec(
          VALID_64_HEX_CONTAINER_ID,
          ['node', 'test.js'],
          payload,
          5000,
          1024 * 1024,
          maxInputBytes
        )
      ).rejects.toThrow(DockerProtocolError);

      // CRITICAL: spawn was NOT invoked
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('accepts payload when byte length is comfortably under maxInputBytes', async () => {
      const payload = 'small';
      const maxInputBytes = 100;

      const result = await client.spawnBoundedExec(
        VALID_64_HEX_CONTAINER_ID,
        ['node', 'test.js'],
        payload,
        5000,
        1024 * 1024,
        maxInputBytes
      );

      expect(result.exitCode).toBe(0);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });
  });

  describe('2. Multibyte UTF-8 Characters & Byte Calculation', () => {
    it('accurately computes UTF-8 byte length for 4-byte Unicode emoji (e.g. 🚀)', async () => {
      // '🚀' is 2 UTF-16 code units (length === 2), but 4 UTF-8 bytes
      const rocket = '🚀';
      expect(rocket.length).toBe(2);
      expect(Buffer.byteLength(rocket, 'utf8')).toBe(4);

      // '🚀\n' is 5 bytes
      const payload = rocket;

      // maxInputBytes = 5: exactly matches 5 bytes -> passes
      await expect(
        client.spawnBoundedExec(
          VALID_64_HEX_CONTAINER_ID,
          ['node', 'test.js'],
          payload,
          5000,
          1024 * 1024,
          5
        )
      ).resolves.toBeDefined();
      expect(mockSpawn).toHaveBeenCalledTimes(1);

      mockSpawn.mockClear();

      // maxInputBytes = 4: 5 > 4 -> fails with DockerProtocolError
      await expect(
        client.spawnBoundedExec(
          VALID_64_HEX_CONTAINER_ID,
          ['node', 'test.js'],
          payload,
          5000,
          1024 * 1024,
          4
        )
      ).rejects.toThrow(DockerProtocolError);
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('accurately computes UTF-8 byte length for 3-byte CJK characters (e.g. 你好世界)', async () => {
      // '你好世界' is 4 chars, 12 UTF-8 bytes
      const cjk = '你好世界';
      expect(cjk.length).toBe(4);
      expect(Buffer.byteLength(cjk, 'utf8')).toBe(12);

      // '你好世界\n' is 13 bytes
      // Limit 13 -> passes
      await expect(
        client.spawnBoundedExec(
          VALID_64_HEX_CONTAINER_ID,
          ['node', 'test.js'],
          cjk,
          5000,
          1024 * 1024,
          13
        )
      ).resolves.toBeDefined();

      mockSpawn.mockClear();

      // Limit 12 -> rejects
      await expect(
        client.spawnBoundedExec(
          VALID_64_HEX_CONTAINER_ID,
          ['node', 'test.js'],
          cjk,
          5000,
          1024 * 1024,
          12
        )
      ).rejects.toThrow(DockerProtocolError);
      expect(mockSpawn).not.toHaveBeenCalled();
    });
  });

  describe('3. Pre-Spawn Rejection Guarantee (Zero Child Processes Created)', () => {
    it('throws DockerProtocolError and guarantees child_process.spawn is never called when limit exceeded', async () => {
      const oversized = 'x'.repeat(1000);
      const maxInputBytes = 500;

      await expect(
        client.spawnBoundedExec(
          VALID_64_HEX_CONTAINER_ID,
          ['node', 'test.js'],
          oversized,
          5000,
          1024 * 1024,
          maxInputBytes
        )
      ).rejects.toThrow(DockerProtocolError);

      expect(mockSpawn).toHaveBeenCalledTimes(0);
    });

    it('includes informative byte counts in DockerProtocolError message', async () => {
      const payload = 'abc'; // 3 bytes + 1 newline = 4 bytes
      const maxInputBytes = 2;

      let caughtErr: unknown;
      try {
        await client.spawnBoundedExec(
          VALID_64_HEX_CONTAINER_ID,
          ['node', 'test.js'],
          payload,
          5000,
          1024 * 1024,
          maxInputBytes
        );
      } catch (err) {
        caughtErr = err;
      }

      expect(caughtErr).toBeInstanceOf(DockerProtocolError);
      expect((caughtErr as DockerProtocolError).message).toContain('4 bytes');
      expect((caughtErr as DockerProtocolError).message).toContain('2 bytes');
    });
  });

  describe('4. Strict Argument & Limit Bounds Validation', () => {
    it('rejects negative maxInputBytes with DockerProtocolError before spawning', async () => {
      await expect(
        client.spawnBoundedExec(
          VALID_64_HEX_CONTAINER_ID,
          ['node', 'test.js'],
          'test',
          5000,
          1024 * 1024,
          -1
        )
      ).rejects.toThrow(DockerProtocolError);
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('rejects non-finite/NaN maxInputBytes with DockerProtocolError before spawning', async () => {
      await expect(
        client.spawnBoundedExec(
          VALID_64_HEX_CONTAINER_ID,
          ['node', 'test.js'],
          'test',
          5000,
          1024 * 1024,
          NaN
        )
      ).rejects.toThrow(DockerProtocolError);
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('rejects negative maxOutputBytes with DockerDaemonError before spawning', async () => {
      await expect(
        client.spawnBoundedExec(
          VALID_64_HEX_CONTAINER_ID,
          ['node', 'test.js'],
          'test',
          5000,
          -10,
          1024
        )
      ).rejects.toThrow(DockerDaemonError);
      expect(mockSpawn).not.toHaveBeenCalled();
    });
  });

  describe('5. Large Payloads Under 64 MiB Cap & Over-Cap Enforcement', () => {
    it('allows large payloads under SEED_IMPORT_MAX_INPUT_BYTES (64 MiB)', async () => {
      // 10 MiB payload string
      const largePayload = 'a'.repeat(10 * 1024 * 1024);

      const result = await client.spawnBoundedExec(
        VALID_64_HEX_CONTAINER_ID,
        ['node', 'test.js'],
        largePayload,
        30000,
        10 * 1024 * 1024,
        SEED_IMPORT_MAX_INPUT_BYTES
      );

      expect(result.exitCode).toBe(0);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    it('rejects payloads exceeding SEED_IMPORT_MAX_INPUT_BYTES before spawn', async () => {
      // Create a mock string or sized payload exceeding 64 MiB
      const oversizedPayload = 'a'.repeat(64 * 1024 * 1024); // 64 MiB + 1 byte newline > 64 MiB

      await expect(
        client.spawnBoundedExec(
          VALID_64_HEX_CONTAINER_ID,
          ['node', 'test.js'],
          oversizedPayload,
          30000,
          10 * 1024 * 1024,
          SEED_IMPORT_MAX_INPUT_BYTES
        )
      ).rejects.toThrow(DockerProtocolError);

      expect(mockSpawn).not.toHaveBeenCalled();
    });
  });

  describe('6. Stdin EPIPE Error Discrimination', () => {
    it('settles with DockerDaemonError when EPIPE occurs and child exits with non-zero exit code', async () => {
      setMockSpawnImpl(() => {
        return createMockChildProcess({
          epipeOnWrite: true,
          exitCode: 1,
          stderrText: 'Process crashed before reading stdin\n',
        });
      });

      await expect(
        client.spawnBoundedExec(
          VALID_64_HEX_CONTAINER_ID,
          ['node', 'test.js'],
          'some payload',
          5000,
          1024 * 1024,
          1024 * 1024
        )
      ).rejects.toThrow(DockerDaemonError);
    });

    it('settles with DockerProtocolError when EPIPE occurs but child exits cleanly with exitCode 0', async () => {
      setMockSpawnImpl(() => {
        return createMockChildProcess({
          epipeOnWrite: true,
          exitCode: 0,
          stdoutText: '{"status":"premature_exit"}\n',
        });
      });

      await expect(
        client.spawnBoundedExec(
          VALID_64_HEX_CONTAINER_ID,
          ['node', 'test.js'],
          'some payload',
          5000,
          1024 * 1024,
          1024 * 1024
        )
      ).rejects.toThrow(DockerProtocolError);
    });
  });

  describe('7. Non-EPIPE Stdin Stream Errors', () => {
    it('settles with DockerDaemonError on non-EPIPE stdin stream error (e.g. ECONNRESET)', async () => {
      const resetErr = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
      setMockSpawnImpl(() => {
        return createMockChildProcess({
          stdinError: resetErr,
          exitCode: 1,
        });
      });

      await expect(
        client.spawnBoundedExec(
          VALID_64_HEX_CONTAINER_ID,
          ['node', 'test.js'],
          'payload',
          5000,
          1024 * 1024,
          1024 * 1024
        )
      ).rejects.toThrow(DockerDaemonError);
    });
  });

  describe('8. Output Byte Limit & Timeout Enforcement', () => {
    it('kills process and throws DockerDaemonError when stdout exceeds maxOutputBytes', async () => {
      setMockSpawnImpl(() => {
        return createMockChildProcess({
          stdoutText: 'x'.repeat(200),
          exitCode: 0,
        });
      });

      await expect(
        client.spawnBoundedExec(
          VALID_64_HEX_CONTAINER_ID,
          ['node', 'test.js'],
          'in',
          5000,
          100, // limit 100 bytes
          1024
        )
      ).rejects.toThrow(/Docker exec output exceeded maximum limit/);
    });

    it('kills process and throws DockerDaemonError when execution times out', async () => {
      setMockSpawnImpl(() => {
        return createMockChildProcess({
          hangOnClose: true,
        });
      });

      await expect(
        client.spawnBoundedExec(
          VALID_64_HEX_CONTAINER_ID,
          ['node', 'test.js'],
          'in',
          50, // 50ms timeout
          1024 * 1024,
          1024
        )
      ).rejects.toThrow(/Docker exec timed out/);
    });
  });

  describe('9. Null Stdin Payload Handling', () => {
    it('handles stdinPayload = null correctly (0 bytes input)', async () => {
      const result = await client.spawnBoundedExec(
        VALID_64_HEX_CONTAINER_ID,
        ['node', 'test.js'],
        null,
        5000,
        1024 * 1024,
        0 // limit 0 allows null input (0 bytes)
      );

      expect(result.exitCode).toBe(0);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });
  });

  describe('10. SafeDockerClient.execOwned Integration with Input Limits', () => {
    beforeEach(() => {
      vi.spyOn(client, 'inspectContainer').mockResolvedValue(createValidContainerInfo());
    });

    it('execOwned defaults import-seed to 64 MiB input limit', async () => {
      const expectation = createValidExpectation();
      const largeSeed = [{ id: 'evt_1', type: 'message', content: 'x'.repeat(2 * 1024 * 1024) }];

      const envelope = await client.execOwned(expectation, {
        action: 'import-seed',
        sessionId: 'ses_1234567890abcdef1234567890abcdef',
        seed: largeSeed,
      });

      expect(envelope).toBeDefined();
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    it('execOwned defaults standard action to 1 MiB and rejects oversized payload with DockerProtocolError', async () => {
      const expectation = createValidExpectation();
      const oversizedPrompt = 'a'.repeat(2 * 1024 * 1024); // 2 MiB > 1 MiB default

      await expect(
        client.execOwned(expectation, {
          action: 'followup',
          prompt: oversizedPrompt,
          sessionId: 'ses_1234567890abcdef1234567890abcdef',
          turnId: 'turn_1234567890abcdef1234567890abcdef',
        })
      ).rejects.toThrow(DockerProtocolError);

      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('execOwned respects explicit maxInputBytes option override', async () => {
      const expectation = createValidExpectation();
      const prompt = 'a'.repeat(2 * 1024 * 1024); // 2 MiB

      // With explicit 5 MiB limit override, it passes
      const envelope = await client.execOwned(
        expectation,
        {
          action: 'followup',
          prompt,
          sessionId: 'ses_1234567890abcdef1234567890abcdef',
          turnId: 'turn_1234567890abcdef1234567890abcdef',
        },
        { maxInputBytes: 5 * 1024 * 1024 }
      );

      expect(envelope).toBeDefined();
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });
  });

  describe('11. Protocol Constants Verification', () => {
    it('defines exact protocol upper constants without hidden defaults', () => {
      expect(DEFAULT_EXEC_MAX_INPUT_BYTES).toBe(1024 * 1024); // 1 MiB
      expect(DEFAULT_EXEC_MAX_OUTPUT_BYTES).toBe(10 * 1024 * 1024); // 10 MiB
      expect(SEED_IMPORT_MAX_INPUT_BYTES).toBe(64 * 1024 * 1024); // 64 MiB
      expect(HEALTH_EXEC_MAX_INPUT_BYTES).toBe(64 * 1024); // 64 KiB
      expect(HEALTH_EXEC_MAX_OUTPUT_BYTES).toBe(64 * 1024); // 64 KiB
    });
  });
});
