/**
 * In-Container Tunnel Agent
 *
 * Runs inside the zero-network container (`--network none`, user 1000:1000).
 * Listens exclusively on `127.0.0.1` at a fixed port (e.g. 8787).
 * Encapsulates local TCP connections into multiplexed tunnel streams over stdio.
 *
 * Invariants:
 * - Strictly binds to 127.0.0.1 only; rejects any other host binding.
 * - Caps concurrent streams to MAX_CONCURRENT_STREAMS (32); rejects extra connections.
 * - Zero outbound network attempts.
 * - Fails closed on illegal frames or protocol violations.
 * - Transparent payload transfer: base64 encoded data over DATA frames.
 *
 * @module @enkeep/runtime-runner/tunnel/agent
 */

import net from 'node:net';
import type { Readable, Writable } from 'node:stream';
import {
  DEFAULT_TUNNEL_PORT,
  DEFAULT_TUNNEL_HOST,
  MAX_CONCURRENT_STREAMS,
  TUNNEL_FRAME_TYPES,
  TUNNEL_ERROR_CODES,
  TunnelProtocolError,
  type TunnelFrame,
  type OpenTunnelFrame,
  type DataTunnelFrame,
  type EndTunnelFrame,
  type ErrorTunnelFrame,
  type PongTunnelFrame,
  type TunnelAgentOptions,
} from './types.js';
import { FrameDecoder, FrameEncoder, encodeFrame } from './protocol.js';

export interface ActiveAgentConnection {
  streamId: number;
  socket: net.Socket;
  halfClosedRemotely: boolean;
}

export class TunnelAgent {
  readonly port: number;
  readonly host: string;
  private readonly input: Readable;
  private readonly output: Writable;
  private server: net.Server | null = null;
  private decoder: FrameDecoder | null = null;
  private activeStreams: Map<number, ActiveAgentConnection> = new Map();
  private nextStreamId = 1;
  private running = false;
  private stopped = false;

  constructor(
    input: Readable = process.stdin,
    output: Writable = process.stdout,
    options: TunnelAgentOptions = {}
  ) {
    this.input = input;
    this.output = output;
    this.port = options.port ?? DEFAULT_TUNNEL_PORT;
    this.host = options.host ?? DEFAULT_TUNNEL_HOST;

    if (this.host !== DEFAULT_TUNNEL_HOST) {
      throw new TunnelProtocolError(
        TUNNEL_ERROR_CODES.UNSAFE_HOST_BINDING,
        `TunnelAgent host binding must be strictly "${DEFAULT_TUNNEL_HOST}", got "${this.host}"`
      );
    }
  }

  /**
   * Starts the TCP listener on 127.0.0.1 and sets up frame processing over stdio.
   */
  async start(): Promise<number> {
    if (this.running) {
      return this.port;
    }
    this.running = true;
    this.stopped = false;

    // Set up frame decoder on input stream
    this.decoder = new FrameDecoder();
    this.decoder.on('data', (frame: TunnelFrame) => {
      this.handleIncomingFrame(frame);
    });

    this.decoder.on('error', (err: Error) => {
      this.failClosed(err);
    });

    this.input.on('error', (err: Error) => {
      this.failClosed(err);
    });

    this.input.on('end', () => {
      this.stop().catch(() => {});
    });

    this.input.on('close', () => {
      this.stop().catch(() => {});
    });

    this.input.pipe(this.decoder);

    // Create loopback TCP server
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      this.handleIncomingConnection(socket);
    });

    server.on('error', (err: any) => {
      if (err && err.code === 'EADDRINUSE') {
        // Handled in retry loop during listen
        return;
      }
      this.failClosed(err);
    });

    this.server = server;

    const startDeadline = Date.now() + 5000;
    while (true) {
      try {
        const boundPort = await new Promise<number>((resolve, reject) => {
          const onListening = () => {
            cleanup();
            const addr = server.address();
            const p = typeof addr === 'object' && addr ? addr.port : this.port;
            resolve(p);
          };
          const onError = (err: unknown) => {
            cleanup();
            reject(err);
          };
          const cleanup = () => {
            server.removeListener('listening', onListening);
            server.removeListener('error', onError);
          };
          server.once('listening', onListening);
          server.once('error', onError);

          server.listen({
            port: this.port,
            host: this.host,
            exclusive: true,
          });
        });
        return boundPort;
      } catch (err: any) {
        if (err && err.code === 'EADDRINUSE' && Date.now() < startDeadline && !this.stopped) {
          await new Promise((r) => setTimeout(r, 100));
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Gracefully stops the agent, terminates listening socket and all active connections.
   */
  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.running = false;

    // Destroy all active sockets
    for (const [streamId, conn] of this.activeStreams.entries()) {
      try {
        conn.socket.destroy();
      } catch (_err) {}
      this.activeStreams.delete(streamId);
    }

    if (this.decoder) {
      try {
        this.input.unpipe(this.decoder);
        this.decoder.destroy();
      } catch (_err) {}
      this.decoder = null;
    }

    if (this.server) {
      const s = this.server;
      this.server = null;
      await new Promise<void>((resolve) => {
        s.close(() => resolve());
      });
    }
  }

  /**
   * Sends a frame downstream through stdout.
   */
  sendFrame(frame: TunnelFrame): void {
    if (this.stopped) {
      return;
    }
    try {
      const buf = encodeFrame(frame);
      this.output.write(buf);
    } catch (err: unknown) {
      this.failClosed(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Allocates the next available streamId in 1..MAX_CONCURRENT_STREAMS.
   */
  private allocateStreamId(): number | null {
    if (this.activeStreams.size >= MAX_CONCURRENT_STREAMS) {
      return null;
    }

    // Try starting from nextStreamId with wrap-around
    for (let i = 0; i < MAX_CONCURRENT_STREAMS; i++) {
      const candidate = ((this.nextStreamId - 1 + i) % MAX_CONCURRENT_STREAMS) + 1;
      if (!this.activeStreams.has(candidate)) {
        this.nextStreamId = (candidate % MAX_CONCURRENT_STREAMS) + 1;
        return candidate;
      }
    }

    return null;
  }

  /**
   * Handles incoming local TCP connection from within container.
   */
  private handleIncomingConnection(socket: net.Socket): void {
    const streamId = this.allocateStreamId();
    if (streamId === null) {
      // Reached maximum concurrent streams limit -> reject connection immediately
      socket.on('error', () => {});
      socket.destroy();
      return;
    }

    const conn: ActiveAgentConnection = {
      streamId,
      socket,
      halfClosedRemotely: false,
    };
    this.activeStreams.set(streamId, conn);

    // Send OPEN frame to platform
    const openFrame: OpenTunnelFrame = {
      type: TUNNEL_FRAME_TYPES.OPEN,
      streamId,
    };
    this.sendFrame(openFrame);

    // Forward socket data to platform as DATA frames
    socket.on('data', (chunk: Buffer) => {
      if (this.stopped) return;
      const dataFrame: DataTunnelFrame = {
        type: TUNNEL_FRAME_TYPES.DATA,
        streamId,
        data: chunk.toString('base64'),
      };
      this.sendFrame(dataFrame);
    });

    // Socket ended locally (client sent FIN) -> send END frame to platform
    socket.on('end', () => {
      if (this.stopped) return;
      const endFrame: EndTunnelFrame = {
        type: TUNNEL_FRAME_TYPES.END,
        streamId,
      };
      this.sendFrame(endFrame);
    });

    // Socket closed or error
    socket.on('error', (err: Error) => {
      if (this.stopped) return;
      const errorFrame: ErrorTunnelFrame = {
        type: TUNNEL_FRAME_TYPES.ERROR,
        streamId,
        error: err.message || 'Socket error',
      };
      this.sendFrame(errorFrame);
      this.activeStreams.delete(streamId);
    });

    socket.on('close', () => {
      this.activeStreams.delete(streamId);
    });
  }

  /**
   * Processes a validated frame received from the platform over stdin.
   */
  private handleIncomingFrame(frame: TunnelFrame): void {
    if (this.stopped) return;

    switch (frame.type) {
      case TUNNEL_FRAME_TYPES.PING: {
        const pongFrame: PongTunnelFrame = {
          type: TUNNEL_FRAME_TYPES.PONG,
          ...(frame.seq !== undefined ? { seq: frame.seq } : {}),
        };
        this.sendFrame(pongFrame);
        break;
      }

      case TUNNEL_FRAME_TYPES.PONG: {
        // No-op for agent
        break;
      }

      case TUNNEL_FRAME_TYPES.DATA: {
        const conn = this.activeStreams.get(frame.streamId);
        if (!conn) {
          // Stream does not exist; ignore or send error
          break;
        }
        try {
          const buf = Buffer.from(frame.data, 'base64');
          conn.socket.write(buf);
        } catch (_err) {}
        break;
      }

      case TUNNEL_FRAME_TYPES.END: {
        const conn = this.activeStreams.get(frame.streamId);
        if (!conn) {
          break;
        }
        conn.halfClosedRemotely = true;
        conn.socket.end();
        break;
      }

      case TUNNEL_FRAME_TYPES.ERROR: {
        const conn = this.activeStreams.get(frame.streamId);
        if (!conn) {
          break;
        }
        this.activeStreams.delete(frame.streamId);
        conn.socket.destroy(new Error(frame.error));
        break;
      }

      case TUNNEL_FRAME_TYPES.OPEN: {
        // Platform attempting to open stream towards container is not currently supported in agent
        // Fail closed or send error frame
        const errorFrame: ErrorTunnelFrame = {
          type: TUNNEL_FRAME_TYPES.ERROR,
          streamId: frame.streamId,
          error: 'OPEN frame from platform to agent is not supported',
        };
        this.sendFrame(errorFrame);
        break;
      }
    }
  }

  /**
   * Fails closed: terminates the server and exits.
   */
  private failClosed(err: Error): void {
    this.stop().catch(() => {});
  }
}
