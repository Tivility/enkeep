import { describe, it, expect } from 'vitest';
import {
  DaemonRpcDecoder,
  DaemonRpcEncoder,
  encodeDaemonMessage,
  DAEMON_ERROR_CODES,
  MAX_DAEMON_FRAME_SIZE,
  type DaemonMessage,
  type DaemonRequest,
  type DaemonResponse,
} from '../src/runtime/daemon-protocol.js';

describe('DaemonRpcDecoder UTF-8 Streaming & Framing Robustness', () => {
  it('yields identical parsed payload when JSON reply containing Chinese 3-byte punctuation and 4-byte emoji is split at EVERY byte boundary', async () => {
    const decoder = new DaemonRpcDecoder();
    const received: DaemonMessage[] = [];
    decoder.on('data', (msg: DaemonMessage) => {
      received.push(msg);
    });

    // Synthetic payload containing 3-byte Chinese punctuation (full-width comma U+FF0C, exclamation U+FF01, quotes, ellipsis)
    // and 4-byte emoji (🎉 U+1F389, 🚀 U+1F680, 🐶 U+1F415, 🌟 U+2B50/U+1F31F)
    const payload: DaemonResponse = {
      id: 'resp-utf8-test-001',
      ok: true,
      data: {
        title: '测试报告：流式解码器验证',
        summary: '在“言语冒犯”，剥离“忠诚度质问”，废掉情绪逆转大招……！',
        emojiList: '🎉 Party, 🚀 Rocket, 🐶 Dog, 🌟 Star',
        details: [
          { phase: '第一阶段，准备完毕；', status: '完成！' },
          { phase: '第二阶段，测试四字节表情：🎉🚀🐶🌟', status: '成功！' },
        ],
      },
    };

    const encoded = encodeDaemonMessage(payload);
    expect(encoded.length).toBeGreaterThan(100);

    // Stream one byte at a time to test every multi-byte character boundary
    for (let i = 0; i < encoded.length; i++) {
      decoder.write(encoded.subarray(i, i + 1));
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(payload);
  });

  it('handles mixed multiple frames and CRLF line endings across fragmented chunk boundaries', async () => {
    const decoder = new DaemonRpcDecoder();
    const received: DaemonMessage[] = [];
    decoder.on('data', (msg: DaemonMessage) => {
      received.push(msg);
    });

    const msg1: DaemonRequest = {
      id: 'req-crlf-1',
      op: 'health',
    };
    const msg2: DaemonResponse = {
      id: 'resp-crlf-2',
      ok: true,
      data: { note: '中文字符，带回车换行！\r\n测试内容' },
    };
    const msg3: DaemonRequest = {
      id: 'req-crlf-3',
      op: 'inspectTurn',
      turnId: 'turn_00000000000000000000000000000099',
    };

    // Frame 1 with CRLF (\r\n)
    const frame1 = Buffer.from(JSON.stringify(msg1) + '\r\n', 'utf8');
    // Frame 2 with LF (\n)
    const frame2 = Buffer.from(JSON.stringify(msg2) + '\n', 'utf8');
    // Frame 3 with CRLF (\r\n)
    const frame3 = Buffer.from(JSON.stringify(msg3) + '\r\n', 'utf8');

    const combined = Buffer.concat([frame1, frame2, frame3]);

    // Feed in arbitrary 7-byte chunks
    const chunkSize = 7;
    for (let i = 0; i < combined.length; i += chunkSize) {
      decoder.write(combined.subarray(i, Math.min(i + chunkSize, combined.length)));
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toHaveLength(3);
    expect(received[0]).toEqual(msg1);
    expect(received[1]).toEqual(msg2);
    expect(received[2]).toEqual(msg3);
  });

  it('matches current contract for final flush when valid frame has no trailing newline', async () => {
    const decoder = new DaemonRpcDecoder();
    const received: DaemonMessage[] = [];
    decoder.on('data', (msg: DaemonMessage) => {
      received.push(msg);
    });

    const msg: DaemonRequest = {
      id: 'req-no-newline',
      op: 'capabilities',
    };

    // Serialized without trailing newline
    const rawJson = Buffer.from(JSON.stringify(msg), 'utf8');
    decoder.write(rawJson);

    // Call end() to trigger _flush
    decoder.end();

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(msg);
  });

  it('fails with INVALID_FRAME_STRUCTURE on invalid or malformed JSON frame', async () => {
    const decoder = new DaemonRpcDecoder();
    let emittedError: any = null;
    decoder.on('error', (err) => {
      emittedError = err;
    });

    decoder.write(Buffer.from('{"id":"bad-json", missing_quotes: true}\n', 'utf8'));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(emittedError).toBeDefined();
    expect(emittedError.code).toBe(DAEMON_ERROR_CODES.INVALID_FRAME_STRUCTURE);
  });

  it('fails with INVALID_FRAME_STRUCTURE on truncated frame at EOF without newline', async () => {
    const decoder = new DaemonRpcDecoder();
    let emittedError: any = null;
    decoder.on('error', (err) => {
      emittedError = err;
    });

    // Incomplete JSON frame
    decoder.write(Buffer.from('{"id":"truncated-1","op":"submitTurn"', 'utf8'));
    decoder.end();

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(emittedError).toBeDefined();
    expect(emittedError.code).toBe(DAEMON_ERROR_CODES.INVALID_FRAME_STRUCTURE);
  });

  it('fails with INVALID_FRAME_STRUCTURE on truncated final UTF-8 bytes at EOF', async () => {
    const decoder = new DaemonRpcDecoder();
    let emittedError: any = null;
    decoder.on('error', (err) => {
      emittedError = err;
    });

    // Write incomplete 3-byte UTF-8 sequence (0xE4, 0xBD) then end stream
    decoder.write(Buffer.from([0xe4, 0xbd]));
    decoder.end();

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(emittedError).toBeDefined();
    expect(emittedError.code).toBe(DAEMON_ERROR_CODES.INVALID_FRAME_STRUCTURE);
  });

  it('leaves ordinary ASCII messages unchanged across arbitrary chunk splits', async () => {
    const decoder = new DaemonRpcDecoder();
    const received: DaemonMessage[] = [];
    decoder.on('data', (msg: DaemonMessage) => {
      received.push(msg);
    });

    const asciiMsg: DaemonRequest = {
      id: 'req-ascii-probe-1',
      op: 'health',
    };
    const encoded = encodeDaemonMessage(asciiMsg);

    // Split at 3-byte increments
    for (let i = 0; i < encoded.length; i += 3) {
      decoder.write(encoded.subarray(i, Math.min(i + 3, encoded.length)));
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(asciiMsg);
  });

  it('works correctly in pipeline through DaemonRpcEncoder piped into DaemonRpcDecoder', async () => {
    const encoder = new DaemonRpcEncoder();
    const decoder = new DaemonRpcDecoder();
    encoder.pipe(decoder);

    const received: DaemonMessage[] = [];
    decoder.on('data', (msg: DaemonMessage) => {
      received.push(msg);
    });

    const msg: DaemonResponse = {
      id: 'pipeline-resp-1',
      ok: true,
      data: {
        chinesePunctuation: '你好，世界！“测试引号”；：',
        fourByteEmoji: '🎉🚀🐶🌟',
      },
    };

    encoder.write(msg);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(msg);
  });
});
