/**
 * TunnelHost Lifecycle, State Machine, and Fake Timers Race Condition Tests
 *
 * Invariants Verified:
 * 1. State machine transitions: idle -> starting -> connected -> reconnecting -> stopping -> stopped (or disconnected).
 * 2. Scheduled reconnect -> stop -> timer fires: no spawnProcess occurs and no unhandled rejection.
 * 3. Spawn in flight -> stop: in-flight process is killed, state settles to stopped without unhandled rejection.
 * 4. Unexpected container removal (DockerNotFoundError): retries bounded by maxRetries with backoff, settles to disconnected.
 * 5. Double stop / concurrent stop: idempotent, settles cleanly to stopped without unhandled rejection.
 * 6. Stop vs onProcessExit race: exit handler recognizes stopping/stopped state and does not trigger reconnect.
 * 7. Initial start() failure: rejects to caller, records status, does not start infinite reconnect timer.
 * 8. Stream errors during stop: aggregated into AggregateError without blocking timer cleanup or stopped state.
 *
 * @module @enkeep/runtime-runner/tests/tunnel-lifecycle.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  TunnelHost,
  TUNNEL_FRAME_TYPES,
  TUNNEL_ERROR_CODES,
  TunnelProtocolError,
  encodeFrame,
  FrameDecoder,
  type TunnelFrame,
} from '../src/tunnel/index.js';
import type {
  SafeDockerClient,
  LongRunningExecHandle,
  OwnershipExpectation,
} from '../src/docker/client.js';
import { DockerNotFoundError } from '../src/spec/validator.js';

interface MockExecContext {
  handle: LongRunningExecHandle;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  exitResolve: (val: { exitCode: number | null; signal: NodeJS.Signals | null }) => void;
  killSpy: ReturnType<typeof vi.fn>;
}

function createMockExecHandle(options?: { autoPong?: boolean }): MockExecContext {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let exitResolve!: (val: { exitCode: number | null; signal: NodeJS.Signals | null }) => void;
  const exitPromise = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      exitResolve = resolve;
    }
  );

  const killSpy = vi.fn((signal = 'SIGTERM') => {
    exitResolve({ exitCode: null, signal: signal as any });
  });

  if (options?.autoPong !== false) {
    const decoder = new FrameDecoder();
    decoder.on('data', (frame: TunnelFrame) => {
      if (frame.type === TUNNEL_FRAME_TYPES.PING) {
        stdout.write(
          encodeFrame({ type: TUNNEL_FRAME_TYPES.PONG, seq: (frame as any).seq })
        );
      }
    });
    stdin.pipe(decoder);
  }

  const handle: LongRunningExecHandle = {
    stdin,
    stdout,
    stderr,
    exitPromise,
    kill: killSpy,
  };

  return { handle, stdin, stdout, stderr, exitResolve, killSpy };
}

describe('TunnelHost State Machine and Lifecycle Races', () => {
  const expectation: OwnershipExpectation = {
    containerName: 'enkeep-test-alice-tunnel',
    userId: 'alice',
    runId: 'run-12345',
    volumeId: 'vol-12345',
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('1. State machine transitions correctly through idle -> starting -> connected -> stopped', async () => {
    const mockContext = createMockExecHandle();
    const spawnSpy = vi.fn().mockResolvedValue(mockContext.handle);

    const mockDockerClient = {
      spawnLongRunningExecOwned: spawnSpy,
    } as unknown as SafeDockerClient;

    const host = new TunnelHost(mockDockerClient, expectation, {
      agentCliPath: '/app/agent.js',
      tunnelPort: 8787,
    });

    expect(host.getStatus().state).toBe('idle');
    expect(host.getStatus().connected).toBe(false);

    const startPromise = host.start();
    expect(host.getStatus().state).toBe('starting');

    await startPromise;

    expect(host.getStatus().state).toBe('connected');
    expect(host.getStatus().connected).toBe(true);
    expect(host.getStatus().restarts).toBe(0);

    await host.stop();

    expect(host.getStatus().state).toBe('stopped');
    expect(host.getStatus().connected).toBe(false);
  });

  it('2. Scheduled reconnect -> stop -> timer fires: no spawnProcess occurs and no unhandled rejection', async () => {
    let spawnCount = 0;
    let currentContext: MockExecContext | null = null;

    const spawnSpy = vi.fn().mockImplementation(() => {
      spawnCount++;
      currentContext = createMockExecHandle();
      return Promise.resolve(currentContext.handle);
    });

    const mockDockerClient = {
      spawnLongRunningExecOwned: spawnSpy,
    } as unknown as SafeDockerClient;

    const host = new TunnelHost(mockDockerClient, expectation, {
      agentCliPath: '/app/agent.js',
      tunnelPort: 8787,
      initialBackoffMs: 200,
      autoReconnect: true,
      maxRetries: 3,
    });

    await host.start();
    expect(spawnCount).toBe(1);
    expect(host.getStatus().state).toBe('connected');

    // Trigger unexpected exit while connected
    currentContext!.exitResolve({ exitCode: 1, signal: null });
    await vi.advanceTimersByTimeAsync(0);

    expect(host.getStatus().state).toBe('reconnecting');
    expect(host.getStatus().restarts).toBe(1);

    // Call stop() while reconnect is scheduled
    await host.stop();
    expect(host.getStatus().state).toBe('stopped');

    // Advance timers well past reconnect delay (e.g. 5000ms)
    await vi.advanceTimersByTimeAsync(5000);

    // Assert no second spawn was triggered after stop
    expect(spawnCount).toBe(1);
    expect(host.getStatus().state).toBe('stopped');
  });

  it('3. Spawn in flight -> stop: cancels in-flight spawn and transitions to stopped cleanly', async () => {
    let resolveSpawn!: (handle: LongRunningExecHandle) => void;
    const spawnInFlightPromise = new Promise<LongRunningExecHandle>((resolve) => {
      resolveSpawn = resolve;
    });

    const spawnSpy = vi.fn().mockReturnValue(spawnInFlightPromise);

    const mockDockerClient = {
      spawnLongRunningExecOwned: spawnSpy,
    } as unknown as SafeDockerClient;

    const host = new TunnelHost(mockDockerClient, expectation, {
      agentCliPath: '/app/agent.js',
      tunnelPort: 8787,
    });

    // Start in-flight spawn
    const startPromise = host.start();
    expect(host.getStatus().state).toBe('starting');

    // Stop while spawn is in flight
    const stopPromise = host.stop();
    expect(host.getStatus().state).toBe('stopping');

    // Now complete the mock spawn
    const mockContext = createMockExecHandle();
    resolveSpawn(mockContext.handle);

    await stopPromise;
    expect(host.getStatus().state).toBe('stopped');

    // Verify handle was killed with SIGKILL due to generation mismatch / stopped state
    expect(mockContext.killSpy).toHaveBeenCalledWith('SIGKILL');
  });

  it('4. Container removed unexpectedly (DockerNotFoundError): retries bounded by maxRetries with backoff, settles to disconnected', async () => {
    const mockContext = createMockExecHandle();
    let spawnAttempts = 0;

    const spawnSpy = vi.fn().mockImplementation(() => {
      spawnAttempts++;
      if (spawnAttempts === 1) {
        return Promise.resolve(mockContext.handle);
      }
      return Promise.reject(
        new DockerNotFoundError('Container not found for long-running exec')
      );
    });

    const mockDockerClient = {
      spawnLongRunningExecOwned: spawnSpy,
    } as unknown as SafeDockerClient;

    const host = new TunnelHost(mockDockerClient, expectation, {
      agentCliPath: '/app/agent.js',
      tunnelPort: 8787,
      initialBackoffMs: 100,
      backoffFactor: 2,
      maxRetries: 3,
      autoReconnect: true,
    });

    await host.start();
    expect(spawnAttempts).toBe(1);
    expect(host.getStatus().state).toBe('connected');

    // Container disappears unexpectedly (process exits)
    mockContext.exitResolve({ exitCode: 137, signal: null });
    await vi.advanceTimersByTimeAsync(0);

    // Reconnect attempt 1 (delay 100ms)
    await vi.advanceTimersByTimeAsync(100);
    expect(spawnAttempts).toBe(2);

    // Reconnect attempt 2 (delay 200ms)
    await vi.advanceTimersByTimeAsync(200);
    expect(spawnAttempts).toBe(3);

    // Reconnect attempt 3 (delay 400ms)
    await vi.advanceTimersByTimeAsync(400);
    expect(spawnAttempts).toBe(4);

    // Retries should now be exhausted (maxRetries: 3)
    await vi.advanceTimersByTimeAsync(0);
    expect(host.getStatus().state).toBe('disconnected');
    expect(host.getStatus().lastErrorCode).toBe(TUNNEL_ERROR_CODES.RECONNECT_EXHAUSTED);
    expect(host.getStatus().restarts).toBe(3);

    // Advance time further by 10,000ms: verify NO further spawn attempts are made
    await vi.advanceTimersByTimeAsync(10000);
    expect(spawnAttempts).toBe(4);
  });

  it('5. Double stop / concurrent stop: idempotent, settles cleanly without unhandled rejection', async () => {
    const mockContext = createMockExecHandle();
    const spawnSpy = vi.fn().mockResolvedValue(mockContext.handle);

    const mockDockerClient = {
      spawnLongRunningExecOwned: spawnSpy,
    } as unknown as SafeDockerClient;

    const host = new TunnelHost(mockDockerClient, expectation);
    await host.start();

    // Concurrent stop calls
    const [res1, res2, res3] = await Promise.all([
      host.stop(),
      host.close(),
      host.stop(),
    ]);

    expect(res1).toBeUndefined();
    expect(res2).toBeUndefined();
    expect(res3).toBeUndefined();
    expect(host.getStatus().state).toBe('stopped');

    // Sequential stop call
    await host.stop();
    expect(host.getStatus().state).toBe('stopped');
  });

  it('6. Stop vs onProcessExit race: exit handler recognizes stopping state and does not trigger reconnect', async () => {
    const mockContext = createMockExecHandle();
    let spawnCalls = 0;

    const spawnSpy = vi.fn().mockImplementation(() => {
      spawnCalls++;
      return Promise.resolve(mockContext.handle);
    });

    const mockDockerClient = {
      spawnLongRunningExecOwned: spawnSpy,
    } as unknown as SafeDockerClient;

    const host = new TunnelHost(mockDockerClient, expectation, {
      initialBackoffMs: 100,
      autoReconnect: true,
      maxRetries: 5,
    });

    await host.start();
    expect(spawnCalls).toBe(1);

    // Trigger stop, which will send SIGTERM and then exitPromise will resolve
    const stopPromise = host.stop();
    mockContext.exitResolve({ exitCode: 0, signal: 'SIGTERM' });

    await stopPromise;
    expect(host.getStatus().state).toBe('stopped');

    // Advance timers by 5000ms
    await vi.advanceTimersByTimeAsync(5000);
    expect(spawnCalls).toBe(1);
    expect(host.getStatus().state).toBe('stopped');
  });

  it('7. Initial start() failure: rejects to caller, records status, and does not schedule reconnect', async () => {
    const spawnSpy = vi.fn().mockRejectedValue(
      new DockerNotFoundError('Container not found for long-running exec')
    );

    const mockDockerClient = {
      spawnLongRunningExecOwned: spawnSpy,
    } as unknown as SafeDockerClient;

    const host = new TunnelHost(mockDockerClient, expectation, {
      autoReconnect: true,
      maxRetries: 5,
    });

    await expect(host.start()).rejects.toThrow(DockerNotFoundError);

    expect(host.getStatus().state).toBe('disconnected');
    expect(host.getStatus().lastErrorCode).toBe('DOCKER_NOT_FOUND');
    expect(host.getStatus().connected).toBe(false);

    // Advance timers: ensure no reconnect was scheduled
    await vi.advanceTimersByTimeAsync(10000);
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });

  it('8. Close stream errors are aggregated into AggregateError without preventing timer cleanup or state transition', async () => {
    const mockContext = createMockExecHandle();
    const spawnSpy = vi.fn().mockResolvedValue(mockContext.handle);

    const mockDockerClient = {
      spawnLongRunningExecOwned: spawnSpy,
    } as unknown as SafeDockerClient;

    const host = new TunnelHost(mockDockerClient, expectation, {
      handler: {
        kind: 'platform',
        handle: () => {},
      },
    });
    await host.start();

    // Inject an open stream
    const streamOpenFrame = encodeFrame({
      type: TUNNEL_FRAME_TYPES.OPEN,
      streamId: 2,
      metadata: { kind: 'platform' },
    });
    mockContext.stdout.write(streamOpenFrame);

    await vi.advanceTimersByTimeAsync(0);

    const activeStream = (host as any).activeStreams.get(2);
    expect(activeStream).toBeDefined();
    vi.spyOn(activeStream, 'destroy').mockImplementation(() => {
      throw new Error('Stream destroy error');
    });

    await expect(host.stop()).rejects.toThrow(AggregateError);

    expect(host.getStatus().state).toBe('stopped');
    expect(host.getStatus().activeStreams).toBe(0);
  });
});
