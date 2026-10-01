import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import * as lark from '@larksuiteoapi/node-sdk';
import {
  CredentialedLarkTransport,
  LARK_DOWNLOAD_CHUNK_SIZE_BYTES,
  LARK_NON_RANGE_MAX_FILE_BYTES,
  MAX_FILE_DOWNLOAD_BYTES,
  isFeishuSizeLimitError,
} from '../src/transport.js';

describe('Lark Chunked File Download (FF2 - Feishu IM Ranged Download)', () => {
  let server: http.Server;
  let serverPort: number;
  let serverBaseUrl: string;

  interface MockResource {
    data: Buffer;
    declaredLarge: boolean;
    failChunkIndexOnce?: number;
  }

  const mockResources = new Map<string, MockResource>();
  const recordedRequests: Array<{ url: string; method: string; rangeHeader?: string }> = [];
  const chunkAttempts = new Map<string, number>();

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = req.url || '';
      const method = req.method || 'GET';
      const rangeHeader = req.headers.range;

      recordedRequests.push({ url, method, rangeHeader });

      // Handle token auth request if client makes one
      if (url.includes('/auth/v3/tenant_access_token')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 0, msg: 'ok', tenant_access_token: 'fake_synth_token_123', expire: 7200 }));
        return;
      }

      // Match GET /open-apis/im/v1/messages/:message_id/resources/:file_key
      const match = url.match(/\/open-apis\/im\/v1\/messages\/([^/?]+)\/resources\/([^/?]+)/);
      if (!match) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 234044, msg: 'Resource not found' }));
        return;
      }

      const [, messageId, fileKey] = match;
      const resource = mockResources.get(`${messageId}:${fileKey}`) || mockResources.get(fileKey);

      if (!resource) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 234044, msg: 'Resource not found' }));
        return;
      }

      // If no Range header and resource is declaredLarge, reject with Feishu error 234037
      if (!rangeHeader && resource.declaredLarge) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 234037, msg: 'Downloaded file size exceeds limit' }));
        return;
      }

      // If Range header is present, serve 206 Partial Content
      if (rangeHeader) {
        const rangeMatch = rangeHeader.match(/^bytes=(\d+)-(\d+)$/);
        if (!rangeMatch) {
          res.writeHead(416, { 'Content-Range': `bytes */${resource.data.length}` });
          res.end();
          return;
        }

        const start = parseInt(rangeMatch[1], 10);
        const requestedEnd = parseInt(rangeMatch[2], 10);
        const actualEnd = Math.min(requestedEnd, resource.data.length - 1);

        // Check for simulated transient failure on a specific chunk
        const chunkKey = `${fileKey}:${start}`;
        const attempts = (chunkAttempts.get(chunkKey) || 0) + 1;
        chunkAttempts.set(chunkKey, attempts);

        if (resource.failChunkIndexOnce !== undefined && start === resource.failChunkIndexOnce && attempts === 1) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 500, msg: 'Simulated transient server error' }));
          return;
        }

        const chunkSlice = resource.data.subarray(start, actualEnd + 1);
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${actualEnd}/${resource.data.length}`,
          'Content-Length': String(chunkSlice.length),
          'Content-Type': 'application/octet-stream',
        });
        res.end(chunkSlice);
        return;
      }

      // Non-range request for small file: serve full 200 OK
      res.writeHead(200, {
        'Content-Length': String(resource.data.length),
        'Content-Type': 'application/octet-stream',
      });
      res.end(resource.data);
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        serverPort = addr.port;
        serverBaseUrl = `http://127.0.0.1:${serverPort}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  beforeEach(() => {
    mockResources.clear();
    recordedRequests.length = 0;
    chunkAttempts.clear();
  });

  it('1. asserts the 32MB chunk constant, 100MB non-range threshold, and 500MB enkeep cap', () => {
    expect(LARK_DOWNLOAD_CHUNK_SIZE_BYTES).toBe(32 * 1024 * 1024);
    expect(LARK_NON_RANGE_MAX_FILE_BYTES).toBe(100 * 1024 * 1024);
    expect(MAX_FILE_DOWNLOAD_BYTES).toBe(500 * 1024 * 1024);
  });

  it('2. detects Feishu size limit error (code 234037) and switches to sequential 206 ranged chunks with merge integrity', async () => {
    const syntheticSize = 950;
    const syntheticBuffer = crypto.randomBytes(syntheticSize);
    const expectedSha256 = crypto.createHash('sha256').update(syntheticBuffer).digest('hex');

    const messageId = 'om_synth_msg_001';
    const fileKey = 'file_synth_key_001';

    mockResources.set(`${messageId}:${fileKey}`, {
      data: syntheticBuffer,
      declaredLarge: true, // Non-range will be rejected with 234037
    });

    const transport = new CredentialedLarkTransport({
      account: {
        userId: 'usr_synth_test',
        appId: 'cli_synth_test',
        appSecret: 'sec_synth_test',
        brand: 'feishu',
      },
      apiClient: new lark.Client({
        appId: 'cli_synth_test',
        appSecret: 'sec_synth_test',
        domain: serverBaseUrl,
        disableTokenCache: true,
        loggerLevel: lark.LoggerLevel.error,
      }),
    });
    await transport.start();

    // Use small synthetic thresholds (nonRange 500 bytes, chunk 200 bytes)
    const result = await transport.downloadFileResource(messageId, fileKey, {
      nonRangeLimitBytes: 500,
      chunkSizeBytes: 200,
    });

    expect(result).toBeDefined();
    expect(result?.buffer).toBeDefined();
    expect(result?.buffer.length).toBe(syntheticSize);

    // Merge integrity: check SHA-256 hash matches
    const actualSha256 = crypto.createHash('sha256').update(result!.buffer).digest('hex');
    expect(actualSha256).toBe(expectedSha256);

    // Verify request sequence:
    // 1st request was non-range (rejected by server with 234037)
    expect(recordedRequests[0].rangeHeader).toBeUndefined();

    // Subsequent requests were sequential ranged requests: 0-199, 200-399, 400-599, 600-799, 800-999
    const rangeRequests = recordedRequests.slice(1);
    expect(rangeRequests.length).toBe(5);
    expect(rangeRequests[0].rangeHeader).toBe('bytes=0-199');
    expect(rangeRequests[1].rangeHeader).toBe('bytes=200-399');
    expect(rangeRequests[2].rangeHeader).toBe('bytes=400-599');
    expect(rangeRequests[3].rangeHeader).toBe('bytes=600-799');
    expect(rangeRequests[4].rangeHeader).toBe('bytes=800-949'); // Clipped to total 950
  });

  it('3. skips non-range attempt and starts immediately with ranged requests when size is known >= non-range threshold', async () => {
    const syntheticSize = 650;
    const syntheticBuffer = crypto.randomBytes(syntheticSize);
    const expectedSha256 = crypto.createHash('sha256').update(syntheticBuffer).digest('hex');

    const messageId = 'om_synth_msg_002';
    const fileKey = 'file_synth_key_002';

    mockResources.set(`${messageId}:${fileKey}`, {
      data: syntheticBuffer,
      declaredLarge: true,
    });

    const transport = new CredentialedLarkTransport({
      account: {
        userId: 'usr_synth_test',
        appId: 'cli_synth_test',
        appSecret: 'sec_synth_test',
        brand: 'feishu',
      },
      apiClient: new lark.Client({
        appId: 'cli_synth_test',
        appSecret: 'sec_synth_test',
        domain: serverBaseUrl,
        disableTokenCache: true,
        loggerLevel: lark.LoggerLevel.error,
      }),
    });
    await transport.start();

    const result = await transport.downloadFileResource(messageId, fileKey, {
      declaredSize: 650, // Known >= 500 threshold
      nonRangeLimitBytes: 500,
      chunkSizeBytes: 200,
    });

    expect(result).toBeDefined();
    expect(result?.buffer.length).toBe(syntheticSize);
    const actualSha256 = crypto.createHash('sha256').update(result!.buffer).digest('hex');
    expect(actualSha256).toBe(expectedSha256);

    // Assert that NO non-range request was made; first request already had Range header
    expect(recordedRequests[0].rangeHeader).toBe('bytes=0-199');
    expect(recordedRequests[1].rangeHeader).toBe('bytes=200-399');
    expect(recordedRequests[2].rangeHeader).toBe('bytes=400-599');
    expect(recordedRequests[3].rangeHeader).toBe('bytes=600-649');
  });

  it('4. retries failed chunk with backoff and successfully resumes download', async () => {
    const syntheticSize = 500;
    const syntheticBuffer = crypto.randomBytes(syntheticSize);
    const expectedSha256 = crypto.createHash('sha256').update(syntheticBuffer).digest('hex');

    const messageId = 'om_synth_msg_003';
    const fileKey = 'file_synth_key_003';

    mockResources.set(`${messageId}:${fileKey}`, {
      data: syntheticBuffer,
      declaredLarge: true,
      failChunkIndexOnce: 200, // Fail second chunk (bytes 200-399) on first attempt
    });

    const transport = new CredentialedLarkTransport({
      account: {
        userId: 'usr_synth_test',
        appId: 'cli_synth_test',
        appSecret: 'sec_synth_test',
        brand: 'feishu',
      },
      apiClient: new lark.Client({
        appId: 'cli_synth_test',
        appSecret: 'sec_synth_test',
        domain: serverBaseUrl,
        disableTokenCache: true,
        loggerLevel: lark.LoggerLevel.error,
      }),
    });
    await transport.start();

    const result = await transport.downloadFileResource(messageId, fileKey, {
      declaredSize: 500,
      nonRangeLimitBytes: 400,
      chunkSizeBytes: 200,
    });

    expect(result).toBeDefined();
    expect(result?.buffer.length).toBe(syntheticSize);
    const actualSha256 = crypto.createHash('sha256').update(result!.buffer).digest('hex');
    expect(actualSha256).toBe(expectedSha256);

    // Verify chunk 200 was attempted twice
    expect(chunkAttempts.get(`${fileKey}:200`)).toBe(2);
  });

  it('5. enforces maximum file size cap (fail-closed on oversize total)', async () => {
    const syntheticSize = 1000;
    const syntheticBuffer = crypto.randomBytes(syntheticSize);

    const messageId = 'om_synth_msg_004';
    const fileKey = 'file_synth_key_004';

    mockResources.set(`${messageId}:${fileKey}`, {
      data: syntheticBuffer,
      declaredLarge: true,
    });

    const transport = new CredentialedLarkTransport({
      account: {
        userId: 'usr_synth_test',
        appId: 'cli_synth_test',
        appSecret: 'sec_synth_test',
        brand: 'feishu',
      },
      apiClient: new lark.Client({
        appId: 'cli_synth_test',
        appSecret: 'sec_synth_test',
        domain: serverBaseUrl,
        disableTokenCache: true,
        loggerLevel: lark.LoggerLevel.error,
      }),
    });
    await transport.start();

    // Cap at 600 bytes, while file is 1000 bytes
    await expect(
      transport.downloadFileResource(messageId, fileKey, {
        nonRangeLimitBytes: 200,
        chunkSizeBytes: 200,
        maxBytes: 600,
      })
    ).rejects.toThrow(/exceeds maximum allowed size/i);
  });
});
