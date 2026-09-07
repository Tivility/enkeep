/**
 * Tunnel Protocol & In-Memory Communication Unit Test Suite
 *
 * Tests:
 * - Frame encoding and decoding (OPEN, DATA, END, ERROR, PING, PONG).
 * - Strict length boundaries (4-byte BE length, 1 MiB frame limit, zero-length rejection).
 * - Maximum concurrent streams limit (32 streams max, rejection of 33rd stream).
 * - Stream ID validation (1..32 only, non-integers, out of range, negative).
 * - Malformed JSON, truncated chunks, split headers across chunk boundaries.
 * - TCP Half-Close semantics on TunnelStream.
 * - Fail-closed behavior on illegal frames.
 * - End-to-end in-memory TunnelAgent <-> TunnelHost multiplexing and data transfer.
 *
 * @module @enkeep/runtime-runner/tests/tunnel-protocol.test
 */

import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import net from 'node:net';
import {
  MAX_FRAME_SIZE,
  MAX_CONCURRENT_STREAMS,
  DEFAULT_TUNNEL_PORT,
  DEFAULT_TUNNEL_HOST,
  TUNNEL_FRAME_TYPES,
  TUNNEL_ERROR_CODES,
  TunnelProtocolError,
  encodeFrame,
  decodeFrame,
  isValidStreamId,
  FrameDecoder,
  FrameEncoder,
  TunnelStream,
  TunnelAgent,
  type TunnelFrame,
  type OpenTunnelFrame,
  type DataTunnelFrame,
  type EndTunnelFrame,
  type ErrorTunnelFrame,
  type PingTunnelFrame,
  type PongTunnelFrame,
} from '../src/tunnel/index.js';

describe('Tunnel Protocol Unit Tests', () => {
  describe('isValidStreamId', () => {
    it('accepts integers between 1 and 32', () => {
      expect(isValidStreamId(1)).toBe(true);
      expect(isValidStreamId(16)).toBe(true);
      expect(isValidStreamId(32)).toBe(true);
    });

    it('rejects 0, negative numbers, numbers > 32, floats, and non-numbers', () => {
      expect(isValidStreamId(0)).toBe(false);
      expect(isValidStreamId(-1)).toBe(false);
      expect(isValidStreamId(33)).toBe(false);
      expect(isValidStreamId(100)).toBe(false);
      expect(isValidStreamId(1.5)).toBe(false);
      expect(isValidStreamId('1')).toBe(false);
      expect(isValidStreamId(null)).toBe(false);
      expect(isValidStreamId(undefined)).toBe(false);
      expect(isValidStreamId({})).toBe(false);
    });
  });

  describe('encodeFrame & decodeFrame', () => {
    it('correctly encodes and decodes OPEN frame', () => {
      const open: OpenTunnelFrame = {
        type: TUNNEL_FRAME_TYPES.OPEN,
        streamId: 5,
        metadata: { protocol: 'http' },
      };
      const buf = encodeFrame(open);
      expect(buf.length).toBeGreaterThan(4);
      expect(buf.readUInt32BE(0)).toBe(buf.length - 4);

      const decoded = decodeFrame(buf.subarray(4));
      expect(decoded).toEqual(open);
    });

    it('correctly encodes and decodes DATA frame with base64 binary data', () => {
      const originalBinary = Buffer.from('Hello, Zero-Network Tunnel!', 'utf8');
      const dataFrame: DataTunnelFrame = {
        type: TUNNEL_FRAME_TYPES.DATA,
        streamId: 1,
        data: originalBinary.toString('base64'),
      };
      const buf = encodeFrame(dataFrame);
      const decoded = decodeFrame(buf.subarray(4)) as DataTunnelFrame;
      expect(decoded.type).toBe('DATA');
      expect(decoded.streamId).toBe(1);
      expect(Buffer.from(decoded.data, 'base64').toString('utf8')).toBe(
        'Hello, Zero-Network Tunnel!'
      );
    });

    it('correctly encodes and decodes END frame', () => {
      const end: EndTunnelFrame = {
        type: TUNNEL_FRAME_TYPES.END,
        streamId: 12,
      };
      const buf = encodeFrame(end);
      const decoded = decodeFrame(buf.subarray(4));
      expect(decoded).toEqual(end);
    });

    it('correctly encodes and decodes ERROR frame', () => {
      const err: ErrorTunnelFrame = {
        type: TUNNEL_FRAME_TYPES.ERROR,
        streamId: 7,
        error: 'Connection reset by peer',
      };
      const buf = encodeFrame(err);
      const decoded = decodeFrame(buf.subarray(4));
      expect(decoded).toEqual(err);
    });

    it('correctly encodes and decodes PING and PONG frames', () => {
      const ping: PingTunnelFrame = {
        type: TUNNEL_FRAME_TYPES.PING,
        seq: 42,
      };
      const pingBuf = encodeFrame(ping);
      expect(decodeFrame(pingBuf.subarray(4))).toEqual(ping);

      const pong: PongTunnelFrame = {
        type: TUNNEL_FRAME_TYPES.PONG,
        seq: 42,
      };
      const pongBuf = encodeFrame(pong);
      expect(decodeFrame(pongBuf.subarray(4))).toEqual(pong);
    });

    it('rejects frame exceeding MAX_FRAME_SIZE (1 MiB)', () => {
      const oversizedString = 'x'.repeat(MAX_FRAME_SIZE + 100);
      const oversizedFrame: DataTunnelFrame = {
        type: TUNNEL_FRAME_TYPES.DATA,
        streamId: 1,
        data: oversizedString,
      };
      expect(() => encodeFrame(oversizedFrame)).toThrow(TunnelProtocolError);
      try {
        encodeFrame(oversizedFrame);
      } catch (err: any) {
        expect(err.code).toBe(TUNNEL_ERROR_CODES.FRAME_SIZE_EXCEEDED);
      }
    });

    it('rejects invalid JSON or malformed structures in decodeFrame', () => {
      expect(() => decodeFrame('{invalid-json')).toThrow(TunnelProtocolError);
      expect(() => decodeFrame('[]')).toThrow(TunnelProtocolError);
      expect(() => decodeFrame('null')).toThrow(TunnelProtocolError);
      expect(() => decodeFrame(JSON.stringify({ type: 'UNKNOWN_TYPE' }))).toThrow(
        TunnelProtocolError
      );
      expect(() =>
        decodeFrame(JSON.stringify({ type: 'OPEN', streamId: 0 }))
      ).toThrow(TunnelProtocolError);
      expect(() =>
        decodeFrame(JSON.stringify({ type: 'OPEN', streamId: 33 }))
      ).toThrow(TunnelProtocolError);
      expect(() =>
        decodeFrame(JSON.stringify({ type: 'DATA', streamId: 1 }))
      ).toThrow(TunnelProtocolError);
      expect(() =>
        decodeFrame(JSON.stringify({ type: 'ERROR', streamId: 1, error: '' }))
      ).toThrow(TunnelProtocolError);
    });
  });

  describe('FrameDecoder & FrameEncoder Streams', () => {
    it('encodes and decodes stream of frames seamlessly', async () => {
      const encoder = new FrameEncoder();
      const decoder = new FrameDecoder();

      const frames: TunnelFrame[] = [
        { type: TUNNEL_FRAME_TYPES.PING, seq: 1 },
        { type: TUNNEL_FRAME_TYPES.OPEN, streamId: 1 },
        { type: TUNNEL_FRAME_TYPES.DATA, streamId: 1, data: Buffer.from('abc').toString('base64') },
        { type: TUNNEL_FRAME_TYPES.END, streamId: 1 },
      ];

      const received: TunnelFrame[] = [];
      decoder.on('data', (f) => received.push(f));

      encoder.pipe(decoder);

      for (const f of frames) {
        encoder.write(f);
      }
      encoder.end();

      await new Promise((r) => decoder.on('end', r));
      expect(received).toEqual(frames);
    });

    it('handles frames fragmented across byte chunks', async () => {
      const decoder = new FrameDecoder();
      const received: TunnelFrame[] = [];
      decoder.on('data', (f) => received.push(f));

      const frame: DataTunnelFrame = {
        type: TUNNEL_FRAME_TYPES.DATA,
        streamId: 2,
        data: Buffer.from('chunked-payload-test').toString('base64'),
      };
      const encoded = encodeFrame(frame);

      // Write byte by byte
      for (let i = 0; i < encoded.length; i++) {
        decoder.write(encoded.subarray(i, i + 1));
      }
      decoder.end();

      await new Promise((r) => decoder.on('end', r));
      expect(received.length).toBe(1);
      expect(received[0]).toEqual(frame);
    });

    it('destroys itself and emits TunnelProtocolError on oversized frame length header', async () => {
      const decoder = new FrameDecoder();
      const errorPromise = new Promise<Error>((resolve) => decoder.on('error', resolve));

      // Header with length 2 MiB (exceeds 1 MiB limit)
      const badHeader = Buffer.alloc(4);
      badHeader.writeUInt32BE(2 * 1024 * 1024, 0);

      decoder.write(badHeader);

      const err = (await errorPromise) as TunnelProtocolError;
      expect(err).toBeInstanceOf(TunnelProtocolError);
      expect(err.code).toBe(TUNNEL_ERROR_CODES.FRAME_SIZE_EXCEEDED);
    });

    it('destroys itself and emits TunnelProtocolError on zero-length frame header', async () => {
      const decoder = new FrameDecoder();
      const errorPromise = new Promise<Error>((resolve) => decoder.on('error', resolve));

      const zeroHeader = Buffer.alloc(4);
      zeroHeader.writeUInt32BE(0, 0);

      decoder.write(zeroHeader);

      const err = (await errorPromise) as TunnelProtocolError;
      expect(err).toBeInstanceOf(TunnelProtocolError);
      expect(err.code).toBe(TUNNEL_ERROR_CODES.INVALID_FRAME_LENGTH);
    });

    it('destroys itself on trailing partial bytes at flush', async () => {
      const decoder = new FrameDecoder();
      const errorPromise = new Promise<Error>((resolve) => decoder.on('error', resolve));

      // Write 2 bytes (incomplete header) and end
      decoder.write(Buffer.from([0x00, 0x01]));
      decoder.end();

      const err = (await errorPromise) as TunnelProtocolError;
      expect(err).toBeInstanceOf(TunnelProtocolError);
      expect(err.code).toBe(TUNNEL_ERROR_CODES.INVALID_FRAME_LENGTH);
    });
  });

  describe('TunnelStream Duplex Operations & Half-Close', () => {
    it('supports writing data chunks and sending final END frame', async () => {
      const sentFrames: TunnelFrame[] = [];
      const sink = {
        sendFrame: (frame: TunnelFrame) => {
          sentFrames.push(frame);
        },
        onStreamClosed: vi.fn(),
      };

      const stream = new TunnelStream(1, sink);

      // Write data chunk
      stream.write(Buffer.from('hello', 'utf8'));
      expect(sentFrames.length).toBe(1);
      expect(sentFrames[0].type).toBe(TUNNEL_FRAME_TYPES.DATA);
      expect((sentFrames[0] as DataTunnelFrame).data).toBe(
        Buffer.from('hello').toString('base64')
      );

      // End writable side
      stream.end();
      expect(sentFrames.length).toBe(2);
      expect(sentFrames[1].type).toBe(TUNNEL_FRAME_TYPES.END);
      expect((sentFrames[1] as EndTunnelFrame).streamId).toBe(1);

      // Readable side is still open (half-close)
      const dataPromise = new Promise<Buffer>((resolve) => {
        stream.once('data', resolve);
      });
      stream.receiveData(Buffer.from('world', 'utf8'));
      const received = await dataPromise;
      expect(received.toString('utf8')).toBe('world');

      // Now close readable side
      const endPromise = new Promise<void>((resolve) => {
        stream.once('end', resolve);
      });
      stream.receiveEnd();
      await endPromise;

      expect(sink.onStreamClosed).toHaveBeenCalledWith(1);
    });

    it('sends ERROR frame when stream is destroyed with error', () => {
      const sentFrames: TunnelFrame[] = [];
      const sink = {
        sendFrame: (frame: TunnelFrame) => {
          sentFrames.push(frame);
        },
        onStreamClosed: vi.fn(),
      };

      const stream = new TunnelStream(3, sink);
      stream.on('error', () => {});
      stream.destroy(new Error('Synthetic error'));

      expect(sentFrames.length).toBe(1);
      expect(sentFrames[0].type).toBe(TUNNEL_FRAME_TYPES.ERROR);
      expect((sentFrames[0] as ErrorTunnelFrame).error).toBe('Synthetic error');
      expect(sink.onStreamClosed).toHaveBeenCalledWith(3);
    });
  });

  describe('TunnelAgent Loopback Confinement & In-Memory Interaction', () => {
    it('rejects non-127.0.0.1 host binding', () => {
      expect(() => {
        new TunnelAgent(new PassThrough(), new PassThrough(), {
          host: '0.0.0.0',
        });
      }).toThrow(TunnelProtocolError);

      expect(() => {
        new TunnelAgent(new PassThrough(), new PassThrough(), {
          host: 'localhost',
        });
      }).toThrow(TunnelProtocolError);
    });

    it('starts on loopback port, receives TCP connection, and sends OPEN/DATA frames to output', async () => {
      const agentInput = new PassThrough();
      const agentOutput = new PassThrough();

      const agent = new TunnelAgent(agentInput, agentOutput, {
        port: 0, // Dynamically assigned port for testing
        host: '127.0.0.1',
      });

      const port = await agent.start();
      expect(port).toBeGreaterThan(0);

      const agentFrames: TunnelFrame[] = [];
      const decoder = new FrameDecoder();
      decoder.on('data', (f: TunnelFrame) => agentFrames.push(f));
      agentOutput.pipe(decoder);

      // Connect local TCP socket to agent
      const socket = net.createConnection({ port, host: '127.0.0.1' });
      await new Promise((r) => socket.on('connect', r));

      // Wait for OPEN frame
      await new Promise((r) => setTimeout(r, 50));
      expect(agentFrames.length).toBeGreaterThanOrEqual(1);
      expect(agentFrames[0].type).toBe(TUNNEL_FRAME_TYPES.OPEN);
      const streamId = (agentFrames[0] as OpenTunnelFrame).streamId;
      expect(streamId).toBeGreaterThanOrEqual(1);

      // Send data from TCP client
      socket.write('Ping from TCP client');
      await new Promise((r) => setTimeout(r, 50));

      const dataFrames = agentFrames.filter((f) => f.type === TUNNEL_FRAME_TYPES.DATA);
      expect(dataFrames.length).toBeGreaterThanOrEqual(1);
      expect(
        Buffer.from((dataFrames[0] as DataTunnelFrame).data, 'base64').toString('utf8')
      ).toBe('Ping from TCP client');

      // Send response from platform via agentInput
      const replyData: DataTunnelFrame = {
        type: TUNNEL_FRAME_TYPES.DATA,
        streamId,
        data: Buffer.from('Reply from platform').toString('base64'),
      };
      agentInput.write(encodeFrame(replyData));

      const receivedReply = await new Promise<string>((resolve) => {
        socket.once('data', (chunk) => resolve(chunk.toString('utf8')));
      });
      expect(receivedReply).toBe('Reply from platform');

      // End socket from client -> agent sends END frame
      socket.end();
      await new Promise((r) => setTimeout(r, 50));

      const endFrames = agentFrames.filter((f) => f.type === TUNNEL_FRAME_TYPES.END);
      expect(endFrames.length).toBeGreaterThanOrEqual(1);

      await agent.stop();
    });

    it('enforces maximum 32 concurrent streams and rejects 33rd connection', async () => {
      const agentInput = new PassThrough();
      const agentOutput = new PassThrough();

      const agent = new TunnelAgent(agentInput, agentOutput, {
        port: 0,
        host: '127.0.0.1',
      });

      const port = await agent.start();
      const sockets: net.Socket[] = [];

      // Open 32 concurrent connections
      for (let i = 0; i < MAX_CONCURRENT_STREAMS; i++) {
        const s = net.createConnection({ port, host: '127.0.0.1' });
        await new Promise((r) => s.on('connect', r));
        sockets.push(s);
      }

      // 33rd connection should be immediately closed/destroyed
      const rejectedSocket = net.createConnection({ port, host: '127.0.0.1' });
      const closedOrError = await new Promise<boolean>((resolve) => {
        rejectedSocket.on('close', () => resolve(true));
        rejectedSocket.on('error', () => resolve(true));
      });
      expect(closedOrError).toBe(true);

      // Clean up all sockets
      for (const s of sockets) {
        s.destroy();
      }
      await agent.stop();
    });

    it('responds to PING frame with PONG frame', async () => {
      const agentInput = new PassThrough();
      const agentOutput = new PassThrough();

      const agent = new TunnelAgent(agentInput, agentOutput, {
        port: 0,
        host: '127.0.0.1',
      });

      await agent.start();

      const agentFrames: TunnelFrame[] = [];
      const decoder = new FrameDecoder();
      decoder.on('data', (f: TunnelFrame) => agentFrames.push(f));
      agentOutput.pipe(decoder);

      const pingFrame: PingTunnelFrame = {
        type: TUNNEL_FRAME_TYPES.PING,
        seq: 99,
      };
      agentInput.write(encodeFrame(pingFrame));

      await new Promise((r) => setTimeout(r, 50));

      const pongFrames = agentFrames.filter((f) => f.type === TUNNEL_FRAME_TYPES.PONG);
      expect(pongFrames.length).toBe(1);
      expect((pongFrames[0] as PongTunnelFrame).seq).toBe(99);

      await agent.stop();
    });
  });
});
