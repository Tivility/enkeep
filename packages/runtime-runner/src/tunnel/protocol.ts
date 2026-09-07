/**
 * Tunnel Protocol Encoder, Decoder, and Stream Transformers
 *
 * Implements 4-byte Big-Endian length-prefixed JSON framing over stream I/O.
 * Enforces strict fail-closed boundaries (1 MiB frame limit, type validation).
 *
 * @module @enkeep/runtime-runner/tunnel/protocol
 */

import { Transform, type TransformCallback } from 'node:stream';
import {
  MAX_FRAME_SIZE,
  MAX_CONCURRENT_STREAMS,
  TUNNEL_FRAME_TYPES,
  TUNNEL_ERROR_CODES,
  TunnelProtocolError,
  type TunnelFrame,
  type OpenTunnelFrame,
  type DataTunnelFrame,
  type EndTunnelFrame,
  type ErrorTunnelFrame,
  type PingTunnelFrame,
  type PongTunnelFrame,
} from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validates whether a value is a valid streamId (1..MAX_CONCURRENT_STREAMS).
 */
export function isValidStreamId(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_CONCURRENT_STREAMS
  );
}

/**
 * Strictly parses and validates a raw JSON string or Buffer into a validated TunnelFrame.
 * Throws TunnelProtocolError on any violation.
 */
export function decodeFrame(raw: Buffer | string): TunnelFrame {
  const jsonStr = typeof raw === 'string' ? raw : raw.toString('utf8');
  let parsed: unknown;

  try {
    parsed = JSON.parse(jsonStr);
  } catch (err: unknown) {
    throw new TunnelProtocolError(
      TUNNEL_ERROR_CODES.INVALID_FRAME_STRUCTURE,
      'Failed to parse frame JSON',
      err
    );
  }

  if (!isRecord(parsed)) {
    throw new TunnelProtocolError(
      TUNNEL_ERROR_CODES.INVALID_FRAME_STRUCTURE,
      'Frame payload must be a valid JSON object'
    );
  }

  const type = parsed.type;
  if (typeof type !== 'string') {
    throw new TunnelProtocolError(
      TUNNEL_ERROR_CODES.INVALID_FRAME_STRUCTURE,
      'Frame missing mandatory string property "type"'
    );
  }

  switch (type) {
    case TUNNEL_FRAME_TYPES.OPEN: {
      if (!isValidStreamId(parsed.streamId)) {
        throw new TunnelProtocolError(
          TUNNEL_ERROR_CODES.INVALID_STREAM_ID,
          `OPEN frame streamId must be an integer between 1 and ${MAX_CONCURRENT_STREAMS}`
        );
      }
      if (parsed.metadata !== undefined && !isRecord(parsed.metadata)) {
        throw new TunnelProtocolError(
          TUNNEL_ERROR_CODES.INVALID_FRAME_STRUCTURE,
          'OPEN frame metadata must be an object when present'
        );
      }
      const openFrame: OpenTunnelFrame = {
        type: TUNNEL_FRAME_TYPES.OPEN,
        streamId: parsed.streamId,
        ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
      };
      return openFrame;
    }

    case TUNNEL_FRAME_TYPES.DATA: {
      if (!isValidStreamId(parsed.streamId)) {
        throw new TunnelProtocolError(
          TUNNEL_ERROR_CODES.INVALID_STREAM_ID,
          `DATA frame streamId must be an integer between 1 and ${MAX_CONCURRENT_STREAMS}`
        );
      }
      if (typeof parsed.data !== 'string') {
        throw new TunnelProtocolError(
          TUNNEL_ERROR_CODES.INVALID_FRAME_STRUCTURE,
          'DATA frame missing mandatory base64 string "data"'
        );
      }
      const dataFrame: DataTunnelFrame = {
        type: TUNNEL_FRAME_TYPES.DATA,
        streamId: parsed.streamId,
        data: parsed.data,
      };
      return dataFrame;
    }

    case TUNNEL_FRAME_TYPES.END: {
      if (!isValidStreamId(parsed.streamId)) {
        throw new TunnelProtocolError(
          TUNNEL_ERROR_CODES.INVALID_STREAM_ID,
          `END frame streamId must be an integer between 1 and ${MAX_CONCURRENT_STREAMS}`
        );
      }
      const endFrame: EndTunnelFrame = {
        type: TUNNEL_FRAME_TYPES.END,
        streamId: parsed.streamId,
      };
      return endFrame;
    }

    case TUNNEL_FRAME_TYPES.ERROR: {
      if (!isValidStreamId(parsed.streamId)) {
        throw new TunnelProtocolError(
          TUNNEL_ERROR_CODES.INVALID_STREAM_ID,
          `ERROR frame streamId must be an integer between 1 and ${MAX_CONCURRENT_STREAMS}`
        );
      }
      if (typeof parsed.error !== 'string' || !parsed.error.trim()) {
        throw new TunnelProtocolError(
          TUNNEL_ERROR_CODES.INVALID_FRAME_STRUCTURE,
          'ERROR frame missing non-empty string "error"'
        );
      }
      const errorFrame: ErrorTunnelFrame = {
        type: TUNNEL_FRAME_TYPES.ERROR,
        streamId: parsed.streamId,
        error: parsed.error,
      };
      return errorFrame;
    }

    case TUNNEL_FRAME_TYPES.PING: {
      if (parsed.seq !== undefined && (!Number.isSafeInteger(parsed.seq) || (parsed.seq as number) < 0)) {
        throw new TunnelProtocolError(
          TUNNEL_ERROR_CODES.INVALID_FRAME_STRUCTURE,
          'PING frame seq must be a non-negative integer when present'
        );
      }
      const pingFrame: PingTunnelFrame = {
        type: TUNNEL_FRAME_TYPES.PING,
        ...(parsed.seq !== undefined ? { seq: parsed.seq as number } : {}),
      };
      return pingFrame;
    }

    case TUNNEL_FRAME_TYPES.PONG: {
      if (parsed.seq !== undefined && (!Number.isSafeInteger(parsed.seq) || (parsed.seq as number) < 0)) {
        throw new TunnelProtocolError(
          TUNNEL_ERROR_CODES.INVALID_FRAME_STRUCTURE,
          'PONG frame seq must be a non-negative integer when present'
        );
      }
      const pongFrame: PongTunnelFrame = {
        type: TUNNEL_FRAME_TYPES.PONG,
        ...(parsed.seq !== undefined ? { seq: parsed.seq as number } : {}),
      };
      return pongFrame;
    }

    default:
      throw new TunnelProtocolError(
        TUNNEL_ERROR_CODES.UNKNOWN_FRAME_TYPE,
        `Unknown frame type: "${String(type)}"`
      );
  }
}

/**
 * Encodes a TunnelFrame into a 4-byte BE length-prefixed Buffer.
 * Throws TunnelProtocolError if frame exceeds MAX_FRAME_SIZE or has invalid structure.
 */
export function encodeFrame(frame: TunnelFrame): Buffer {
  let jsonString: string;
  try {
    jsonString = JSON.stringify(frame);
  } catch (err: unknown) {
    throw new TunnelProtocolError(
      TUNNEL_ERROR_CODES.INVALID_FRAME_STRUCTURE,
      'Failed to serialize frame to JSON',
      err
    );
  }

  const payloadBuf = Buffer.from(jsonString, 'utf8');
  if (payloadBuf.length === 0) {
    throw new TunnelProtocolError(
      TUNNEL_ERROR_CODES.INVALID_FRAME_LENGTH,
      'Frame payload length cannot be zero'
    );
  }

  if (payloadBuf.length > MAX_FRAME_SIZE) {
    throw new TunnelProtocolError(
      TUNNEL_ERROR_CODES.FRAME_SIZE_EXCEEDED,
      `Frame payload byte length (${payloadBuf.length}) exceeds maximum limit (${MAX_FRAME_SIZE})`
    );
  }

  const headerBuf = Buffer.allocUnsafe(4);
  headerBuf.writeUInt32BE(payloadBuf.length, 0);

  return Buffer.concat([headerBuf, payloadBuf]);
}

/**
 * Transform stream that accepts raw chunks, parses 4-byte BE length prefix,
 * validates boundaries, and emits parsed TunnelFrame objects.
 * Immediately destroys itself on boundary/protocol violation (fail-closed).
 */
export class FrameDecoder extends Transform {
  private buffer: Buffer = Buffer.alloc(0);
  private isDecoderClosed = false;

  constructor() {
    super({ readableObjectMode: true });
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    if (this.isDecoderClosed) {
      callback();
      return;
    }

    this.buffer = Buffer.concat([this.buffer, chunk]);

    try {
      while (this.buffer.length >= 4) {
        const payloadLength = this.buffer.readUInt32BE(0);

        if (payloadLength === 0) {
          throw new TunnelProtocolError(
            TUNNEL_ERROR_CODES.INVALID_FRAME_LENGTH,
            'Received zero-length frame header'
          );
        }

        if (payloadLength > MAX_FRAME_SIZE) {
          throw new TunnelProtocolError(
            TUNNEL_ERROR_CODES.FRAME_SIZE_EXCEEDED,
            `Frame length ${payloadLength} exceeds maximum limit of ${MAX_FRAME_SIZE} bytes`
          );
        }

        const totalFrameLength = 4 + payloadLength;
        if (this.buffer.length < totalFrameLength) {
          // Incomplete frame, wait for more data
          break;
        }

        const payloadBuffer = this.buffer.subarray(4, totalFrameLength);
        this.buffer = this.buffer.subarray(totalFrameLength);

        const frame = decodeFrame(payloadBuffer);
        this.push(frame);
      }
      callback();
    } catch (err: unknown) {
      this.isDecoderClosed = true;
      const protocolError =
        err instanceof TunnelProtocolError
          ? err
          : new TunnelProtocolError(
              TUNNEL_ERROR_CODES.INVALID_FRAME_STRUCTURE,
              'Protocol decoder error',
              err
            );
      this.destroy(protocolError);
      callback(protocolError);
    }
  }

  _flush(callback: TransformCallback): void {
    if (this.buffer.length > 0 && !this.isDecoderClosed) {
      const err = new TunnelProtocolError(
        TUNNEL_ERROR_CODES.INVALID_FRAME_LENGTH,
        `Stream ended with ${this.buffer.length} unparsed trailing bytes`
      );
      this.destroy(err);
      callback(err);
    } else {
      callback();
    }
  }
}

/**
 * Transform stream that accepts TunnelFrame objects and outputs 4-byte BE length-prefixed Buffers.
 */
export class FrameEncoder extends Transform {
  constructor() {
    super({ writableObjectMode: true });
  }

  _transform(frame: TunnelFrame, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      const buf = encodeFrame(frame);
      this.push(buf);
      callback();
    } catch (err: unknown) {
      const protocolError =
        err instanceof TunnelProtocolError
          ? err
          : new TunnelProtocolError(
              TUNNEL_ERROR_CODES.INVALID_FRAME_STRUCTURE,
              'Protocol encoder error',
              err
            );
      callback(protocolError);
    }
  }
}
