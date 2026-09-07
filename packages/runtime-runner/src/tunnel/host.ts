/**
 * Platform-side Tunnel Host
 *
 * Spawns a persistent in-container `tunnel-agent` via `SafeDockerClient` ownership-verified `docker exec`,
 * demultiplexes incoming logical streams, and dispatches them to a pluggable `StreamHandler`.
 *
 * Invariants:
 * - Reuses SafeDockerClient container ownership verification.
 * - Manages persistent `docker exec -i <container> node /app/runtime-runner/dist/runtime/tunnel-agent.js`.
 * - Explicit state machine: idle -> starting -> connected -> reconnecting -> stopping -> stopped (or disconnected).
 * - Monotonic generation token invalidates stale asynchronous callbacks, timers, and exit handlers.
 * - Idempotent stop/close: cancels timers, awaits in-flight spawn/reconnect promises, and prevents late reconnects.
 * - Demuxes logical streams (streamId 1..32) and creates `TunnelStream` (Duplex) instances.
 * - Dispatches streams to pluggable `StreamHandler`.
 * - Automatic exponential backoff reconnection on unexpected disconnects with bounded retries.
 * - Real-time operational status via `getStatus()`.
 * - Graceful teardown (sends END frames -> terminates exec process -> aggregates errors).
 * - Transparent payload delivery without inspecting frame contents.
 *
 * @module @enkeep/runtime-runner/tunnel/host
 */

import type { Duplex, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import {
  SafeDockerClient,
  type OwnershipExpectation,
  type LongRunningExecHandle,
} from '../docker/client.js';
import { DockerNotFoundError } from '../spec/validator.js';
import type {
  StreamHandler,
  StreamMetadata,
  TunnelHost as ITunnelHost,
} from './contract.js';
import {
  MAX_CONCURRENT_STREAMS,
  TUNNEL_FRAME_TYPES,
  TUNNEL_ERROR_CODES,
  TunnelProtocolError,
  type TunnelStatus,
  type TunnelHostState,
  type StreamHandlerCallback,
  type StreamHandlerInput,
  type TunnelHostOptions,
  type TunnelFrame,
  type OpenTunnelFrame,
  type DataTunnelFrame,
  type EndTunnelFrame,
  type ErrorTunnelFrame,
  type PingTunnelFrame,
  type PongTunnelFrame,
} from './types.js';
import { FrameDecoder, encodeFrame } from './protocol.js';
import { TunnelStream, type TunnelStreamSink } from './stream.js';

export class TunnelHost extends EventEmitter implements TunnelStreamSink, ITunnelHost {
  private readonly dockerClient: SafeDockerClient;
  private readonly expectation: OwnershipExpectation;
  private readonly options: Required<TunnelHostOptions>;
  private defaultCallback: StreamHandlerCallback | null = null;
  private registeredHandlers: Map<string, StreamHandler> = new Map();

  private state: TunnelHostState = 'idle';
  private generation = 0;
  private lastErrorCode: string | null = null;
  private restarts = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private activeSpawnPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;

  private execHandle: LongRunningExecHandle | null = null;
  private decoder: FrameDecoder | null = null;
  private activeStreams: Map<number, TunnelStream> = new Map();

  private pingSequence = 0;
  private pendingPings: Map<number, { resolve: () => void; timer: NodeJS.Timeout }> = new Map();

  constructor(
    dockerClient: SafeDockerClient,
    expectation: OwnershipExpectation,
    options: TunnelHostOptions = {}
  ) {
    super();
    this.dockerClient = dockerClient;
    this.expectation = expectation;
    this.options = {
      agentCliPath: options.agentCliPath ?? '/app/runtime-runner/dist/runtime/tunnel-agent.js',
      tunnelPort: options.tunnelPort ?? 8787,
      handler: options.handler ?? (() => {}),
      maxRetries: options.maxRetries ?? 5,
      initialBackoffMs: options.initialBackoffMs ?? 200,
      maxBackoffMs: options.maxBackoffMs ?? 5000,
      backoffFactor: options.backoffFactor ?? 2,
      autoReconnect: options.autoReconnect ?? true,
    };
    if (options.handler) {
      this.setHandler(options.handler);
    }
  }

  private isTerminated(): boolean {
    const s = this.state as TunnelHostState;
    return s === 'stopping' || s === 'stopped';
  }

  /**
   * Sets or updates the active stream handler (function callback or StreamHandler instance).
   */
  setHandler(handler: StreamHandlerInput): void {
    if (typeof handler === 'function') {
      this.defaultCallback = handler;
    } else if (handler && typeof handler === 'object' && 'kind' in handler) {
      this.registerHandler(handler);
    }
  }

  /**
   * Registers a StreamHandler for its declared kind.
   */
  registerHandler(handler: StreamHandler): () => void {
    this.registeredHandlers.set(handler.kind, handler);
    return () => {
      if (this.registeredHandlers.get(handler.kind) === handler) {
        this.registeredHandlers.delete(handler.kind);
      }
    };
  }

  /**
   * Dispatches an incoming duplex stream to the registered handler for its metadata kind.
   */
  async handleStream(stream: Duplex, metadata: StreamMetadata): Promise<void> {
    const kind = metadata?.kind;
    const handler = kind ? this.registeredHandlers.get(kind) : undefined;
    if (handler) {
      await handler.handle(stream, metadata);
    } else if (this.defaultCallback) {
      await this.defaultCallback(stream as any, metadata);
    } else if (this.registeredHandlers.size === 1) {
      const single = this.registeredHandlers.values().next().value;
      if (single) {
        await single.handle(stream, metadata);
      }
    } else {
      stream.destroy(
        new TunnelProtocolError(
          TUNNEL_ERROR_CODES.STREAM_NOT_FOUND,
          `No StreamHandler registered for kind "${String(kind)}"`
        )
      );
    }
  }

  /**
   * Returns current operational status including explicit state machine state and bounded error code.
   */
  getStatus(): TunnelStatus {
    return {
      connected: this.state === 'connected',
      activeStreams: this.activeStreams.size,
      restarts: this.restarts,
      state: this.state,
      lastErrorCode: this.lastErrorCode,
    };
  }

  /**
   * Starts the persistent tunnel exec process and awaits ready handshake.
   * If initial spawn fails, rejects to caller.
   */
  async start(): Promise<void> {
    if (this.state === 'connected') {
      return;
    }
    if (this.state === 'starting' && this.activeSpawnPromise) {
      return this.activeSpawnPromise;
    }
    if (this.isTerminated()) {
      throw new TunnelProtocolError(
        TUNNEL_ERROR_CODES.TUNNEL_CLOSED,
        `Cannot start TunnelHost: host is in terminal state '${this.state}'`
      );
    }

    this.state = 'starting';
    const currentToken = this.generation;
    const spawnPromise = this.spawnProcess(currentToken, false);
    this.activeSpawnPromise = spawnPromise;

    try {
      await spawnPromise;
    } catch (err: unknown) {
      if (this.generation === currentToken && (this.state as TunnelHostState) === 'starting') {
        this.state = 'disconnected';
      }
      throw err;
    } finally {
      if (this.activeSpawnPromise === spawnPromise) {
        this.activeSpawnPromise = null;
      }
    }
  }

  /**
   * Sends a frame down to the container tunnel-agent via stdin.
   */
  sendFrame(frame: TunnelFrame): boolean {
    if (!this.execHandle || this.isTerminated()) {
      return false;
    }
    try {
      const buf = encodeFrame(frame);
      return (this.execHandle.stdin as Writable).write(buf);
    } catch (_err) {
      return false;
    }
  }

  /**
   * Callback invoked by TunnelStream when it is closed locally or destroyed.
   */
  onStreamClosed(streamId: number): void {
    this.activeStreams.delete(streamId);
  }

  /**
   * Sends a PING frame and awaits PONG with timeout.
   */
  async ping(timeoutMs = 3000): Promise<void> {
    if (!this.execHandle || this.isTerminated()) {
      throw new TunnelProtocolError(
        TUNNEL_ERROR_CODES.TUNNEL_CLOSED,
        'Cannot ping: tunnel is not connected'
      );
    }

    const seq = ++this.pingSequence;
    const pingFrame: PingTunnelFrame = {
      type: TUNNEL_FRAME_TYPES.PING,
      seq,
    };

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPings.delete(seq);
        reject(
          new TunnelProtocolError(
            TUNNEL_ERROR_CODES.IO_ERROR,
            `Ping sequence ${seq} timed out after ${timeoutMs}ms`
          )
        );
      }, timeoutMs);

      this.pendingPings.set(seq, { resolve, timer });
      const sent = this.sendFrame(pingFrame);
      if (!sent) {
        clearTimeout(timer);
        this.pendingPings.delete(seq);
        reject(
          new TunnelProtocolError(
            TUNNEL_ERROR_CODES.TUNNEL_CLOSED,
            'Failed to write PING frame to tunnel stdin'
          )
        );
      }
    });
  }

  /**
   * Alias for close(): gracefully stops the tunnel host.
   */
  async stop(): Promise<void> {
    return this.close();
  }

  /**
   * Gracefully and idempotently shuts down the tunnel host:
   * 1. Transitions state to 'stopping' and increments generation token immediately.
   * 2. Clears all reconnect and ping timers.
   * 3. Awaits any in-flight spawn or reconnect promise to settle.
   * 4. Sends END frames to all active streams and destroys them.
   * 5. Terminates the persistent docker exec child process.
   * 6. Transitions state to terminal 'stopped'.
   * 7. Aggregates stream/teardown cleanup errors into AggregateError.
   */
  async close(): Promise<void> {
    if (this.state === 'stopped') {
      return;
    }
    if (this.state === 'stopping' && this.stopPromise) {
      return this.stopPromise;
    }

    this.state = 'stopping';
    ++this.generation;

    // Immediately cancel all reconnect timers
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Cancel all pending ping timers
    for (const [, pending] of this.pendingPings.entries()) {
      clearTimeout(pending.timer);
    }
    this.pendingPings.clear();

    this.stopPromise = (async () => {
      // Await active in-flight spawn or reconnect to settle before tearing down
      if (this.activeSpawnPromise) {
        try {
          await this.activeSpawnPromise;
        } catch (_err) {
          // In-flight spawn failure during shutdown is expected/ignored
        }
        this.activeSpawnPromise = null;
      }

      const errors: Error[] = [];

      // 1. Gracefully close all active multiplexed streams
      for (const [streamId, stream] of this.activeStreams.entries()) {
        try {
          if (!stream.writableEnded) {
            const endFrame: EndTunnelFrame = {
              type: TUNNEL_FRAME_TYPES.END,
              streamId,
            };
            this.sendFrame(endFrame);
          }
          stream.destroy();
        } catch (err: unknown) {
          errors.push(err instanceof Error ? err : new Error(String(err)));
        }
      }
      this.activeStreams.clear();

      // 2. Tear down decoder
      if (this.decoder) {
        try {
          this.decoder.destroy();
        } catch (err: unknown) {
          errors.push(err instanceof Error ? err : new Error(String(err)));
        }
        this.decoder = null;
      }

      // 3. Terminate docker exec process
      if (this.execHandle) {
        const handle = this.execHandle;
        this.execHandle = null;
        try {
          handle.kill('SIGTERM');
          // Give process up to 1000ms to exit cleanly before forced kill
          const exitPromise = handle.exitPromise;
          const timeoutPromise = new Promise<{ exitCode: null; signal: null }>((resolve) =>
            setTimeout(() => {
              try {
                handle.kill('SIGKILL');
              } catch (_k) {}
              resolve({ exitCode: null, signal: null });
            }, 1000)
          );
          await Promise.race([exitPromise, timeoutPromise]);
        } catch (err: unknown) {
          // DockerNotFoundError during stop/teardown is not an error
          if (!(err instanceof DockerNotFoundError)) {
            errors.push(err instanceof Error ? err : new Error(String(err)));
          }
        }
      }

      this.state = 'stopped';
      this.stopPromise = null;

      if (errors.length > 0) {
        throw new AggregateError(errors, 'TunnelHost close encountered errors during teardown');
      }
    })();

    return this.stopPromise;
  }

  /**
   * Spawns the long-running docker exec process and establishes framing.
   */
  private async spawnProcess(generationToken: number, isReconnect: boolean): Promise<void> {
    if (this.generation !== generationToken || this.isTerminated()) {
      return;
    }

    const cliArgs = ['node', this.options.agentCliPath, String(this.options.tunnelPort)];

    let handle: LongRunningExecHandle;
    try {
      handle = await this.dockerClient.spawnLongRunningExecOwned(
        this.expectation,
        cliArgs
      );
    } catch (err: unknown) {
      if (this.generation !== generationToken || this.isTerminated()) {
        return;
      }
      const errCode =
        err && typeof err === 'object' && 'code' in err && typeof (err as any).code === 'string'
          ? (err as any).code
          : err instanceof DockerNotFoundError
            ? 'DockerNotFoundError'
            : err instanceof Error
              ? err.name || err.message
              : 'SPAWN_ERROR';
      this.lastErrorCode = errCode;
      throw err;
    }

    if (this.generation !== generationToken || this.isTerminated()) {
      try {
        handle.kill('SIGKILL');
      } catch (_k) {}
      return;
    }

    this.execHandle = handle;

    const decoder = new FrameDecoder();
    this.decoder = decoder;

    decoder.on('data', (frame: TunnelFrame) => {
      if (this.generation !== generationToken || this.isTerminated()) {
        return;
      }
      this.handleIncomingFrame(frame);
    });

    decoder.on('error', (err: Error) => {
      if (this.generation !== generationToken || this.isTerminated()) {
        return;
      }
      this.handleProcessFailure(err, generationToken);
    });

    handle.stdout.pipe(decoder);

    handle.stderr.on('data', (_chunk: Buffer) => {});

    handle.exitPromise
      .then(({ exitCode, signal }) => {
        if (this.generation !== generationToken || this.isTerminated()) {
          return;
        }
        this.handleProcessExit(exitCode, signal, generationToken);
      })
      .catch((err) => {
        if (this.generation !== generationToken || this.isTerminated()) {
          return;
        }
        this.handleProcessFailure(
          err instanceof Error ? err : new Error(String(err)),
          generationToken
        );
      });

    // Verify liveness with an immediate ping handshake (5000ms timeout)
    try {
      await this.ping(5000);
    } catch (pingErr: unknown) {
      if (this.generation !== generationToken || this.isTerminated()) {
        try {
          handle.kill('SIGKILL');
        } catch (_k) {}
        return;
      }
      this.lastErrorCode =
        pingErr instanceof Error ? pingErr.name || pingErr.message : 'PING_FAILED';
      try {
        handle.kill('SIGKILL');
      } catch (_k) {}
      this.execHandle = null;
      throw pingErr;
    }

    if (this.generation !== generationToken || this.isTerminated()) {
      try {
        handle.kill('SIGKILL');
      } catch (_k) {}
      return;
    }

    // Mark connected ONLY after verified handshake
    this.state = 'connected';
    this.reconnectAttempts = 0;
    this.lastErrorCode = null;
    this.emit('connected');
  }

  /**
   * Handles incoming frame from container tunnel-agent.
   */
  private handleIncomingFrame(frame: TunnelFrame): void {
    if (this.isTerminated()) return;

    switch (frame.type) {
      case TUNNEL_FRAME_TYPES.PONG: {
        if (frame.seq !== undefined) {
          const pending = this.pendingPings.get(frame.seq);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingPings.delete(frame.seq);
            pending.resolve();
          }
        }
        break;
      }

      case TUNNEL_FRAME_TYPES.PING: {
        // Reply with PONG
        const pongFrame: PongTunnelFrame = {
          type: TUNNEL_FRAME_TYPES.PONG,
          ...(frame.seq !== undefined ? { seq: frame.seq } : {}),
        };
        this.sendFrame(pongFrame);
        break;
      }

      case TUNNEL_FRAME_TYPES.OPEN: {
        this.handleRemoteOpen(frame);
        break;
      }

      case TUNNEL_FRAME_TYPES.DATA: {
        const stream = this.activeStreams.get(frame.streamId);
        if (stream) {
          try {
            const buf = Buffer.from(frame.data, 'base64');
            stream.receiveData(buf);
          } catch (_err) {}
        }
        break;
      }

      case TUNNEL_FRAME_TYPES.END: {
        const stream = this.activeStreams.get(frame.streamId);
        if (stream) {
          stream.receiveEnd();
        }
        break;
      }

      case TUNNEL_FRAME_TYPES.ERROR: {
        const stream = this.activeStreams.get(frame.streamId);
        if (stream) {
          this.activeStreams.delete(frame.streamId);
          stream.receiveError(new Error(frame.error));
        }
        break;
      }
    }
  }

  /**
   * Handles an OPEN frame received from container.
   */
  private handleRemoteOpen(frame: OpenTunnelFrame): void {
    if (this.activeStreams.size >= MAX_CONCURRENT_STREAMS) {
      // Fail closed / reject stream
      const errorFrame: ErrorTunnelFrame = {
        type: TUNNEL_FRAME_TYPES.ERROR,
        streamId: frame.streamId,
        error: `Exceeded maximum concurrent streams limit of ${MAX_CONCURRENT_STREAMS}`,
      };
      this.sendFrame(errorFrame);
      return;
    }

    if (this.activeStreams.has(frame.streamId)) {
      const errorFrame: ErrorTunnelFrame = {
        type: TUNNEL_FRAME_TYPES.ERROR,
        streamId: frame.streamId,
        error: `Stream ${frame.streamId} already exists`,
      };
      this.sendFrame(errorFrame);
      return;
    }

    const rawKind = typeof frame.metadata?.kind === 'string' ? frame.metadata.kind : undefined;
    const userId = this.expectation.userId;
    const baseMetadata: StreamMetadata = {
      ...(frame.metadata ?? {}),
      userId,
      kind: rawKind ?? '',
    };

    const stream = new TunnelStream(frame.streamId, this, { ...frame.metadata, userId });
    stream.on('error', () => {});
    this.activeStreams.set(frame.streamId, stream);

    const registered = rawKind ? this.registeredHandlers.get(rawKind) : undefined;

    if (registered) {
      try {
        const res = registered.handle(stream, { ...baseMetadata, kind: rawKind! });
        if (res && typeof (res as Promise<void>).catch === 'function') {
          (res as Promise<void>).catch((err: unknown) => {
            stream.destroy(err instanceof Error ? err : new Error(String(err)));
          });
        }
      } catch (err: unknown) {
        stream.destroy(err instanceof Error ? err : new Error(String(err)));
      }
    } else if (this.defaultCallback) {
      try {
        const res = this.defaultCallback(stream, { ...baseMetadata, kind: rawKind ?? '' });
        if (res && typeof (res as Promise<void>).catch === 'function') {
          (res as Promise<void>).catch((err: unknown) => {
            stream.destroy(err instanceof Error ? err : new Error(String(err)));
          });
        }
      } catch (err: unknown) {
        stream.destroy(err instanceof Error ? err : new Error(String(err)));
      }
    } else if (this.registeredHandlers.size === 1) {
      const single = this.registeredHandlers.values().next().value;
      if (single) {
        try {
          const res = single.handle(stream, { ...baseMetadata, kind: single.kind });
          if (res && typeof (res as Promise<void>).catch === 'function') {
            (res as Promise<void>).catch((err: unknown) => {
              stream.destroy(err instanceof Error ? err : new Error(String(err)));
            });
          }
        } catch (err: unknown) {
          stream.destroy(err instanceof Error ? err : new Error(String(err)));
        }
      }
    } else if (this.registeredHandlers.size > 1) {
      // Dynamic dispatch by peeking initial stream data
      let dispatched = false;
      const onInitialData = (chunk: Buffer) => {
        if (dispatched) return;
        dispatched = true;
        stream.removeListener('data', onInitialData);
        // Unshift the chunk back so the handler can read the full stream
        stream.unshift(chunk);

        const headerStr = chunk.toString('latin1', 0, Math.min(chunk.length, 512));
        let selectedKind = 'platform';
        if (
          headerStr.includes('/api/events') ||
          headerStr.includes('/events')
        ) {
          selectedKind = this.registeredHandlers.has('events') ? 'events' : 'platform';
        } else if (
          headerStr.includes('/platform') ||
          headerStr.includes('/api/messages') ||
          headerStr.includes('/api/files') ||
          headerStr.includes('/api/manage') ||
          headerStr.includes('/capabilities')
        ) {
          selectedKind = 'platform';
        } else if (
          headerStr.includes('/llm') ||
          headerStr.includes('/cpa-') ||
          headerStr.includes('/chat/completions')
        ) {
          selectedKind = 'llm';
        } else if (this.registeredHandlers.has('events')) {
          selectedKind = 'events';
        } else if (this.registeredHandlers.has('platform')) {
          selectedKind = 'platform';
        } else if (this.registeredHandlers.has('llm')) {
          selectedKind = 'llm';
        }

        let handler = this.registeredHandlers.get(selectedKind);
        if (!handler && selectedKind === 'events') {
          handler = this.registeredHandlers.get('platform');
        }
        if (!handler) {
          handler = this.registeredHandlers.values().next().value;
        }
        if (handler) {
          try {
            const res = handler.handle(stream, { ...baseMetadata, kind: handler.kind });
            if (res && typeof (res as Promise<void>).catch === 'function') {
              (res as Promise<void>).catch((err: unknown) => {
                stream.destroy(err instanceof Error ? err : new Error(String(err)));
              });
            }
          } catch (err: unknown) {
            stream.destroy(err instanceof Error ? err : new Error(String(err)));
          }
        } else {
          stream.destroy(
            new TunnelProtocolError(
              TUNNEL_ERROR_CODES.STREAM_NOT_FOUND,
              `No StreamHandler registered on TunnelHost for kind "${selectedKind}"`
            )
          );
        }
      };

      stream.on('data', onInitialData);
    } else {
      // No handler configured -> close stream
      stream.destroy(
        new TunnelProtocolError(
          TUNNEL_ERROR_CODES.STREAM_NOT_FOUND,
          'No StreamHandler registered on TunnelHost'
        )
      );
    }
  }

  /**
   * Handles process exit or unexpected termination.
   */
  private handleProcessExit(
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    generationToken: number
  ): void {
    if (this.generation !== generationToken || this.isTerminated()) {
      return;
    }

    this.execHandle = null;

    // Clear all pending pings
    for (const [, pending] of this.pendingPings.entries()) {
      clearTimeout(pending.timer);
    }
    this.pendingPings.clear();

    // Fail all in-flight streams immediately
    for (const [streamId, stream] of this.activeStreams.entries()) {
      stream.destroy(
        new TunnelProtocolError(
          TUNNEL_ERROR_CODES.TUNNEL_PROCESS_EXITED,
          `Tunnel process exited unexpectedly (code: ${exitCode}, signal: ${signal})`
        )
      );
      this.activeStreams.delete(streamId);
    }

    this.emit('disconnected', { exitCode, signal });

    if (
      this.options.autoReconnect &&
      this.generation === generationToken &&
      !this.isTerminated()
    ) {
      this.scheduleReconnect(generationToken);
    } else {
      this.state = 'disconnected';
    }
  }

  /**
   * Handles decoder failure or I/O error.
   */
  private handleProcessFailure(err: Error, generationToken: number): void {
    if (this.generation !== generationToken || this.isTerminated()) {
      return;
    }

    const errCode =
      err && typeof err === 'object' && 'code' in err && typeof (err as any).code === 'string'
        ? (err as any).code
        : err instanceof DockerNotFoundError
          ? 'DockerNotFoundError'
          : err.name || 'IO_ERROR';
    this.lastErrorCode = errCode;

    // Clear all pending pings
    for (const [, pending] of this.pendingPings.entries()) {
      clearTimeout(pending.timer);
    }
    this.pendingPings.clear();

    if (this.execHandle) {
      try {
        this.execHandle.kill('SIGKILL');
      } catch (_k) {}
      this.execHandle = null;
    }

    for (const [streamId, stream] of this.activeStreams.entries()) {
      stream.destroy(err);
      this.activeStreams.delete(streamId);
    }

    if (this.listenerCount('error') > 0) {
      this.emit('error', err);
    }

    if (
      this.options.autoReconnect &&
      this.generation === generationToken &&
      !this.isTerminated()
    ) {
      this.scheduleReconnect(generationToken);
    } else {
      this.state = 'disconnected';
    }
  }

  /**
   * Schedules an exponential backoff reconnect attempt with bounded retries and error containment.
   */
  private scheduleReconnect(generationToken: number): void {
    if (
      this.generation !== generationToken ||
      this.isTerminated() ||
      this.reconnectTimer
    ) {
      return;
    }

    if (this.reconnectAttempts >= this.options.maxRetries) {
      this.state = 'disconnected';
      this.lastErrorCode = TUNNEL_ERROR_CODES.RECONNECT_EXHAUSTED;
      const err = new TunnelProtocolError(
        TUNNEL_ERROR_CODES.RECONNECT_EXHAUSTED,
        `Tunnel reconnect exhausted after ${this.reconnectAttempts} attempts`
      );
      if (this.listenerCount('error') > 0) {
        this.emit('error', err);
      }
      return;
    }

    this.reconnectAttempts++;
    this.restarts++;
    this.state = 'reconnecting';

    const delay = Math.min(
      this.options.maxBackoffMs,
      this.options.initialBackoffMs *
        Math.pow(this.options.backoffFactor, this.reconnectAttempts - 1)
    );

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.generation !== generationToken || this.isTerminated()) {
        return;
      }

      try {
        const spawnPromise = this.spawnProcess(generationToken, true);
        this.activeSpawnPromise = spawnPromise;
        await spawnPromise;
      } catch (err: unknown) {
        // Reconnect timer callback MUST catch its own error and record bounded error code without unhandled rejection
        if (this.generation !== generationToken || this.isTerminated()) {
          return;
        }
        this.handleProcessFailure(
          err instanceof Error ? err : new Error(`Reconnect failed: ${String(err)}`),
          generationToken
        );
      } finally {
        if (this.activeSpawnPromise) {
          this.activeSpawnPromise = null;
        }
      }
    }, delay);
  }
}
