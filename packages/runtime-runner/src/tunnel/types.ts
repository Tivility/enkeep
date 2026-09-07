/**
 * Tunnel Subsystem Protocol Types and Boundary Constants
 *
 * Defines contracts for bidirectional multiplexed tunnel communication
 * over container stdio (`docker exec -i <container> node /app/runtime-runner/dist/runtime/tunnel-agent.js`).
 *
 * Invariants:
 * - 4-byte BE length prefix + JSON/binary frame format.
 * - Multiplexing: distinct integer `streamId` (1..32) per logical stream.
 * - Frame types: OPEN, DATA, END, ERROR, PING, PONG.
 * - Strict boundaries: MAX_FRAME_SIZE = 1 MiB (1,048,576 bytes), MAX_CONCURRENT_STREAMS = 32.
 * - Fail-closed on illegal frame or boundary violation.
 * - In-container tunnel agent binds strictly to 127.0.0.1.
 *
 * @module @enkeep/runtime-runner/tunnel/types
 */

import type { Duplex } from 'node:stream';
import type { StreamHandler, StreamMetadata } from './contract.js';

/** Maximum frame payload size in bytes (1 MiB) */
export const MAX_FRAME_SIZE = 1024 * 1024; // 1,048,576 bytes

/** Maximum concurrent logical multiplexed streams */
export const MAX_CONCURRENT_STREAMS = 32;

/** Default loopback port inside container */
export const DEFAULT_TUNNEL_PORT = 8787;

/** Mandatory loopback host binding inside container */
export const DEFAULT_TUNNEL_HOST = '127.0.0.1';

/**
 * Valid frame types in tunnel protocol.
 */
export const TUNNEL_FRAME_TYPES = {
  OPEN: 'OPEN',
  DATA: 'DATA',
  END: 'END',
  ERROR: 'ERROR',
  PING: 'PING',
  PONG: 'PONG',
} as const;

export type TunnelFrameType = (typeof TUNNEL_FRAME_TYPES)[keyof typeof TUNNEL_FRAME_TYPES];

export interface BaseTunnelFrame {
  type: TunnelFrameType;
}

export interface OpenTunnelFrame extends BaseTunnelFrame {
  type: typeof TUNNEL_FRAME_TYPES.OPEN;
  streamId: number;
  metadata?: Record<string, unknown>;
}

export interface DataTunnelFrame extends BaseTunnelFrame {
  type: typeof TUNNEL_FRAME_TYPES.DATA;
  streamId: number;
  /** Base64-encoded binary chunk */
  data: string;
}

export interface EndTunnelFrame extends BaseTunnelFrame {
  type: typeof TUNNEL_FRAME_TYPES.END;
  streamId: number;
}

export interface ErrorTunnelFrame extends BaseTunnelFrame {
  type: typeof TUNNEL_FRAME_TYPES.ERROR;
  streamId: number;
  error: string;
}

export interface PingTunnelFrame extends BaseTunnelFrame {
  type: typeof TUNNEL_FRAME_TYPES.PING;
  seq?: number;
}

export interface PongTunnelFrame extends BaseTunnelFrame {
  type: typeof TUNNEL_FRAME_TYPES.PONG;
  seq?: number;
}

export type TunnelFrame =
  | OpenTunnelFrame
  | DataTunnelFrame
  | EndTunnelFrame
  | ErrorTunnelFrame
  | PingTunnelFrame
  | PongTunnelFrame;

/**
 * Standard error codes for tunnel operations.
 */
export const TUNNEL_ERROR_CODES = {
  FRAME_SIZE_EXCEEDED: 'FRAME_SIZE_EXCEEDED',
  INVALID_FRAME_LENGTH: 'INVALID_FRAME_LENGTH',
  INVALID_FRAME_STRUCTURE: 'INVALID_FRAME_STRUCTURE',
  UNKNOWN_FRAME_TYPE: 'UNKNOWN_FRAME_TYPE',
  INVALID_STREAM_ID: 'INVALID_STREAM_ID',
  MAX_STREAMS_EXCEEDED: 'MAX_STREAMS_EXCEEDED',
  STREAM_NOT_FOUND: 'STREAM_NOT_FOUND',
  STREAM_ALREADY_EXISTS: 'STREAM_ALREADY_EXISTS',
  UNSAFE_HOST_BINDING: 'UNSAFE_HOST_BINDING',
  TUNNEL_CLOSED: 'TUNNEL_CLOSED',
  TUNNEL_PROCESS_EXITED: 'TUNNEL_PROCESS_EXITED',
  RECONNECT_EXHAUSTED: 'RECONNECT_EXHAUSTED',
  IO_ERROR: 'IO_ERROR',
} as const;

export type TunnelErrorCode = (typeof TUNNEL_ERROR_CODES)[keyof typeof TUNNEL_ERROR_CODES];

export class TunnelProtocolError extends Error {
  readonly code: TunnelErrorCode;

  constructor(code: TunnelErrorCode, message: string, cause?: unknown) {
    super(`[${code}] ${message}`, cause ? { cause } : undefined);
    this.name = 'TunnelProtocolError';
    this.code = code;
  }
}

/**
 * Operational states for TunnelHost state machine.
 */
export type TunnelHostState =
  | 'idle'
  | 'starting'
  | 'connected'
  | 'reconnecting'
  | 'stopping'
  | 'stopped'
  | 'disconnected';

/**
 * Real-time operational status of TunnelHost.
 */
export interface TunnelStatus {
  /** Whether the tunnel process is currently running and ready to handle multiplexed streams */
  connected: boolean;
  /** Number of active multiplexed streams currently open */
  activeStreams: number;
  /** Total count of automatic reconnect attempts performed */
  restarts: number;
  /** Operational state of the TunnelHost state machine */
  state?: TunnelHostState;
  /** Last error code recorded during execution, if any */
  lastErrorCode?: string | null;
}

/**
 * Logical duplex stream interface for a single multiplexed channel.
 */
export interface ITunnelStream extends Duplex {
  readonly streamId: number;
  readonly metadata?: Record<string, unknown>;
  /** Safely pushes received binary chunk into readable side */
  receiveData(data: Buffer): void;
  /** Marks readable side as finished (EOF) */
  receiveEnd(): void;
  /** Tears down stream with an error */
  receiveError(err: Error): void;
}

/**
 * Pluggable platform stream handler callback.
 */
export type StreamHandlerCallback = (
  stream: ITunnelStream,
  metadata?: Record<string, unknown>
) => void | Promise<void>;

export type StreamHandlerInput = StreamHandlerCallback | StreamHandler;

/**
 * Options for platform-side TunnelHost.
 */
export interface TunnelHostOptions {
  /** In-container agent CLI path (default '/app/runtime-runner/dist/runtime/tunnel-agent.js') */
  agentCliPath?: string;
  /** Port for in-container agent to listen on (default 8787) */
  tunnelPort?: number;
  /** Stream handler callback or StreamHandler instance */
  handler?: StreamHandlerInput;
  /** Maximum reconnect attempts (default 5, 0 to disable) */
  maxRetries?: number;
  /** Initial backoff delay in ms (default 200ms) */
  initialBackoffMs?: number;
  /** Maximum backoff delay in ms (default 5000ms) */
  maxBackoffMs?: number;
  /** Backoff factor (default 2) */
  backoffFactor?: number;
  /** Whether to automatically reconnect when tunnel process terminates unexpectedly (default true) */
  autoReconnect?: boolean;
}

/**
 * Options for in-container TunnelAgent.
 */
export interface TunnelAgentOptions {
  /** Port to listen on (default 8787) */
  port?: number;
  /** Host to bind on (must be strictly '127.0.0.1') */
  host?: string;
}
