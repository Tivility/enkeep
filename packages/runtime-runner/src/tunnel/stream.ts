/**
 * Tunnel Multiplexed Stream Representation (Duplex)
 *
 * Implements a Node.js Duplex stream representing a single multiplexed logical channel
 * over the tunnel stdio transport.
 *
 * Supports TCP half-close semantics:
 * - When local caller calls stream.end(), an END frame is sent over the tunnel;
 *   the stream remains readable until the remote sends an END frame.
 * - When remote sends an END frame, receiveEnd() pushes null (EOF on readable side);
 *   the stream remains writable if local has not yet ended.
 * - When stream is destroyed or encounters an error, an ERROR frame is sent.
 *
 * @module @enkeep/runtime-runner/tunnel/stream
 */

import { Duplex, type DuplexOptions } from 'node:stream';
import {
  TUNNEL_FRAME_TYPES,
  TUNNEL_ERROR_CODES,
  TunnelProtocolError,
  type ITunnelStream,
  type TunnelFrame,
  type DataTunnelFrame,
  type EndTunnelFrame,
  type ErrorTunnelFrame,
} from './types.js';

export interface TunnelStreamSink {
  /** Sends a frame down the physical tunnel connection */
  sendFrame(frame: TunnelFrame): boolean | void;
  /** Notification when a stream closes locally */
  onStreamClosed(streamId: number): void;
}

export class TunnelStream extends Duplex implements ITunnelStream {
  readonly streamId: number;
  readonly metadata?: Record<string, unknown>;
  private readonly sink: TunnelStreamSink;
  private endSent = false;
  private errorSent = false;

  constructor(
    streamId: number,
    sink: TunnelStreamSink,
    metadata?: Record<string, unknown>,
    options?: DuplexOptions
  ) {
    super({
      ...options,
      allowHalfOpen: true,
      emitClose: true,
      autoDestroy: false,
    });
    this.streamId = streamId;
    this.sink = sink;
    this.metadata = metadata;

    this.on('end', () => {
      if (this.writableEnded) {
        this.sink.onStreamClosed(this.streamId);
      }
    });
    this.on('finish', () => {
      if (this.readableEnded) {
        this.sink.onStreamClosed(this.streamId);
      }
    });
    this.on('close', () => {
      this.sink.onStreamClosed(this.streamId);
    });
  }

  _read(_size: number): void {
    // Flow is driven by receiveData() pushes
  }

  _write(chunk: Buffer | Uint8Array | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.endSent || this.errorSent) {
      callback(
        new TunnelProtocolError(
          TUNNEL_ERROR_CODES.TUNNEL_CLOSED,
          `Cannot write to stream ${this.streamId}: local write is closed`
        )
      );
      return;
    }

    try {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : typeof chunk === 'string'
          ? Buffer.from(chunk, encoding || 'utf8')
          : Buffer.from(chunk);

      const dataFrame: DataTunnelFrame = {
        type: TUNNEL_FRAME_TYPES.DATA,
        streamId: this.streamId,
        data: buffer.toString('base64'),
      };

      this.sink.sendFrame(dataFrame);
      callback();
    } catch (err: unknown) {
      callback(
        err instanceof Error
          ? err
          : new TunnelProtocolError(TUNNEL_ERROR_CODES.IO_ERROR, 'Write failed', err)
      );
    }
  }

  _final(callback: (error?: Error | null) => void): void {
    if (!this.endSent && !this.errorSent) {
      this.endSent = true;
      try {
        const endFrame: EndTunnelFrame = {
          type: TUNNEL_FRAME_TYPES.END,
          streamId: this.streamId,
        };
        this.sink.sendFrame(endFrame);
      } catch (err: unknown) {
        callback(
          err instanceof Error
            ? err
            : new TunnelProtocolError(TUNNEL_ERROR_CODES.IO_ERROR, 'Final failed', err)
        );
        return;
      }
    }
    callback();
    this.checkTerminalState();
  }

  _destroy(err: Error | null, callback: (error: Error | null) => void): void {
    if (err && !this.errorSent) {
      this.errorSent = true;
      try {
        const errorFrame: ErrorTunnelFrame = {
          type: TUNNEL_FRAME_TYPES.ERROR,
          streamId: this.streamId,
          error: err.message || 'Stream destroyed with error',
        };
        this.sink.sendFrame(errorFrame);
      } catch (_sendErr: unknown) {
        // Sink may already be closed
      }
    }

    this.sink.onStreamClosed(this.streamId);
    callback(err);
  }

  /**
   * Remote sent binary data on this stream.
   */
  receiveData(data: Buffer): void {
    if (this.readableEnded || this.destroyed) {
      return;
    }
    this.push(data);
  }

  /**
   * Remote finished writing (half-close readable side).
   */
  receiveEnd(): void {
    if (this.readableEnded || this.destroyed) {
      return;
    }
    this.push(null);
    this.checkTerminalState();
  }

  /**
   * Remote reported error on this stream.
   */
  receiveError(err: Error): void {
    this.destroy(err);
  }

  private checkTerminalState(): void {
    // If both readable and writable sides have ended, emit close and clean up
    if (this.readableEnded && this.writableEnded && !this.destroyed) {
      this.sink.onStreamClosed(this.streamId);
    }
  }
}
