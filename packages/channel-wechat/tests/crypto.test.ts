import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, afterAll } from 'vitest';
import {
  aesEcbPaddedSize,
  buildCdnDownloadUrl,
  buildCdnUploadUrl,
  decryptAesEcb,
  DEFAULT_CDN_BASE,
  DEFAULT_ILINK_BASE,
  downloadAndDecryptMedia,
  encodeAesKey,
  encryptAesEcb,
  getUploadUrl,
  ILINK_APP_CLIENT_VERSION,
  ILINK_APP_ID,
  MAX_MEDIA_FILE_SIZE,
  parseAesKey,
  uploadBufferToCdn,
  uploadMediaBuffer,
  uploadMediaFile,
  WECHAT_MEDIA_TYPE_FILE,
  WECHAT_MEDIA_TYPE_IMAGE,
} from '../src/crypto.js';

interface TestHttpServer {
  server: http.Server;
  baseUrl: string;
  close: () => Promise<void>;
}

function startTestHttpServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<TestHttpServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${address.port}`;
      resolve({
        server,
        baseUrl,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
    server.on('error', reject);
  });
}

describe('WeChat Media Crypto Module C', () => {
  const openServers: TestHttpServer[] = [];

  afterAll(async () => {
    for (const s of openServers) {
      await s.close().catch(() => {});
    }
  });

  describe('1. AES-128-ECB Encryption & Decryption Equivalence and Padding', () => {
    const key = crypto.randomBytes(16);

    it('encrypts and decrypts empty buffer (0 bytes)', () => {
      const plaintext = Buffer.alloc(0);
      const ciphertext = encryptAesEcb(plaintext, key);
      expect(ciphertext.length).toBe(16); // PKCS7 adds full 16-byte block
      expect(ciphertext.length % 16).toBe(0);
      const decrypted = decryptAesEcb(ciphertext, key);
      expect(decrypted.equals(plaintext)).toBe(true);
      expect(decrypted.length).toBe(0);
    });

    it('encrypts and decrypts 15 bytes buffer', () => {
      const plaintext = Buffer.from('123456789012345', 'utf-8');
      expect(plaintext.length).toBe(15);
      const ciphertext = encryptAesEcb(plaintext, key);
      expect(ciphertext.length).toBe(16);
      const decrypted = decryptAesEcb(ciphertext, key);
      expect(decrypted.equals(plaintext)).toBe(true);
    });

    it('encrypts and decrypts 16 bytes buffer (exact block boundary)', () => {
      const plaintext = Buffer.from('1234567890123456', 'utf-8');
      expect(plaintext.length).toBe(16);
      const ciphertext = encryptAesEcb(plaintext, key);
      expect(ciphertext.length).toBe(32); // PKCS7 adds full 16-byte block
      const decrypted = decryptAesEcb(ciphertext, key);
      expect(decrypted.equals(plaintext)).toBe(true);
    });

    it('encrypts and decrypts 17 bytes buffer', () => {
      const plaintext = Buffer.from('12345678901234567', 'utf-8');
      expect(plaintext.length).toBe(17);
      const ciphertext = encryptAesEcb(plaintext, key);
      expect(ciphertext.length).toBe(32);
      const decrypted = decryptAesEcb(ciphertext, key);
      expect(decrypted.equals(plaintext)).toBe(true);
    });

    it('encrypts and decrypts 1MB buffer correctly', () => {
      const size1MB = 1024 * 1024;
      const plaintext = crypto.randomBytes(size1MB);
      const ciphertext = encryptAesEcb(plaintext, key);
      expect(ciphertext.length).toBe(aesEcbPaddedSize(size1MB));
      const decrypted = decryptAesEcb(ciphertext, key);
      expect(decrypted.equals(plaintext)).toBe(true);
    });

    it('computes aesEcbPaddedSize accurately across boundaries', () => {
      expect(aesEcbPaddedSize(0)).toBe(16);
      expect(aesEcbPaddedSize(1)).toBe(16);
      expect(aesEcbPaddedSize(15)).toBe(16);
      expect(aesEcbPaddedSize(16)).toBe(32);
      expect(aesEcbPaddedSize(17)).toBe(32);
      expect(aesEcbPaddedSize(31)).toBe(32);
      expect(aesEcbPaddedSize(32)).toBe(48);
      expect(aesEcbPaddedSize(1024 * 1024)).toBe(1024 * 1024 + 16);
      expect(() => aesEcbPaddedSize(-1)).toThrow('Invalid plaintextSize');
    });

    it('rejects invalid key length', () => {
      const shortKey = crypto.randomBytes(8);
      const longKey = crypto.randomBytes(32);
      const plaintext = Buffer.from('test');

      expect(() => encryptAesEcb(plaintext, shortKey)).toThrow('must be 16 bytes');
      expect(() => encryptAesEcb(plaintext, longKey)).toThrow('must be 16 bytes');
      expect(() => decryptAesEcb(Buffer.alloc(16), shortKey)).toThrow('must be 16 bytes');
    });

    it('rejects invalid ciphertext length on decrypt', () => {
      expect(() => decryptAesEcb(Buffer.alloc(0), key)).toThrow('must be non-zero multiple of 16');
      expect(() => decryptAesEcb(Buffer.alloc(15), key)).toThrow('must be non-zero multiple of 16');
      expect(() => decryptAesEcb(Buffer.alloc(17), key)).toThrow('must be non-zero multiple of 16');
    });
  });

  describe('2. Key Parsing and Encoding Specification', () => {
    it('round-trips 16-byte raw key through canonical format (Hex-in-Base64)', () => {
      const rawKey = crypto.randomBytes(16);
      const encoded = encodeAesKey(rawKey);

      // Decoded base64 string should be 32-char hex string
      const decodedBuf = Buffer.from(encoded, 'base64');
      expect(decodedBuf.length).toBe(32);
      expect(/^[0-9a-f]{32}$/.test(decodedBuf.toString('utf-8'))).toBe(true);

      const parsed = parseAesKey(encoded);
      expect(parsed.length).toBe(16);
      expect(parsed.equals(rawKey)).toBe(true);
    });

    it('correctly parses legacy format (direct raw 16 bytes Base64)', () => {
      const rawKey = crypto.randomBytes(16);
      const legacyBase64 = rawKey.toString('base64');
      expect(Buffer.from(legacyBase64, 'base64').length).toBe(16);

      const parsed = parseAesKey(legacyBase64);
      expect(parsed.length).toBe(16);
      expect(parsed.equals(rawKey)).toBe(true);
    });

    it('rejects invalid AES key encodings and lengths', () => {
      // 10 bytes decoded
      const invalidLenBase64 = crypto.randomBytes(10).toString('base64');
      expect(() => parseAesKey(invalidLenBase64)).toThrow('Invalid AES key length');

      // 32 bytes decoded but non-hex characters
      const nonHex32Base64 = Buffer.from('g'.repeat(32), 'utf-8').toString('base64');
      expect(() => parseAesKey(nonHex32Base64)).toThrow('Invalid AES key length');

      // Empty string
      expect(() => parseAesKey('')).toThrow('must be a non-empty base64 string');
    });

    it('rejects invalid raw key length in encodeAesKey', () => {
      expect(() => encodeAesKey(crypto.randomBytes(15))).toThrow('expected 16 bytes');
      expect(() => encodeAesKey(crypto.randomBytes(32))).toThrow('expected 16 bytes');
    });
  });

  describe('3. iLink getUploadUrl Assembly and ASCII filekey Validation', () => {
    it('assembles headers, body and parses upload_param correctly', async () => {
      let capturedReqHeaders: http.IncomingHttpHeaders | undefined;
      let capturedBody: Record<string, unknown> | undefined;

      const mockServer = await startTestHttpServer((req, res) => {
        capturedReqHeaders = req.headers;
        let data = '';
        req.on('data', (chunk) => {
          data += chunk;
        });
        req.on('end', () => {
          capturedBody = JSON.parse(data);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              ret: 0,
              upload_param: 'test_upload_param_xyz_999',
            }),
          );
        });
      });
      openServers.push(mockServer);

      const filekey = '0123456789abcdef0123456789abcdef';
      const token = 'mock_bot_token_secret_123';
      const result = await getUploadUrl({
        baseUrl: mockServer.baseUrl,
        token,
        filekey,
        mediaType: WECHAT_MEDIA_TYPE_IMAGE,
        toUserId: 'wx_user_recipient',
        rawsize: 100,
        rawfilemd5: 'md5_checksum_test',
        filesize: 112,
        aeskey: 'aeskey_hex_32chars',
      });

      expect(result.uploadParam).toBe('test_upload_param_xyz_999');

      // Verify headers
      expect(capturedReqHeaders?.authorization).toBe(`Bearer ${token}`);
      expect(capturedReqHeaders?.authorizationtype).toBe('ilink_bot_token');
      expect(capturedReqHeaders?.['ilink-app-id']).toBe(ILINK_APP_ID);
      expect(capturedReqHeaders?.['ilink-app-clientversion']).toBe(ILINK_APP_CLIENT_VERSION);
      expect(capturedReqHeaders?.['x-wechat-uin']).toBeDefined();

      // Verify payload
      expect(capturedBody).toEqual({
        filekey,
        media_type: WECHAT_MEDIA_TYPE_IMAGE,
        to_user_id: 'wx_user_recipient',
        rawsize: 100,
        rawfilemd5: 'md5_checksum_test',
        filesize: 112,
        no_need_thumb: true,
        aeskey: 'aeskey_hex_32chars',
        base_info: { channel_version: '1.0.0' },
      });
    });

    it('strictly validates filekey is ASCII and rejects non-ASCII before network call', async () => {
      await expect(
        getUploadUrl({
          baseUrl: 'http://127.0.0.1:9999',
          token: 'token',
          filekey: 'filekey_中文测试',
          mediaType: WECHAT_MEDIA_TYPE_IMAGE,
          toUserId: 'user',
          rawsize: 10,
          rawfilemd5: 'md5',
          filesize: 16,
          aeskey: 'hex',
        }),
      ).rejects.toThrow('filekey must contain only ASCII characters');
    });

    it('throws when server returns non-zero error code or HTTP error', async () => {
      const errorServer = await startTestHttpServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ret: -1, errmsg: 'system error' }));
      });
      openServers.push(errorServer);

      await expect(
        getUploadUrl({
          baseUrl: errorServer.baseUrl,
          token: 'token',
          filekey: 'abcdef1234567890abcdef1234567890',
          mediaType: WECHAT_MEDIA_TYPE_IMAGE,
          toUserId: 'user',
          rawsize: 10,
          rawfilemd5: 'md5',
          filesize: 16,
          aeskey: 'hex',
        }),
      ).rejects.toThrow('getUploadUrl returned error ret=-1');
    });

    it('throws when server response is missing upload_param', async () => {
      const missingParamServer = await startTestHttpServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ret: 0 }));
      });
      openServers.push(missingParamServer);

      await expect(
        getUploadUrl({
          baseUrl: missingParamServer.baseUrl,
          token: 'token',
          filekey: 'abcdef1234567890abcdef1234567890',
          mediaType: WECHAT_MEDIA_TYPE_IMAGE,
          toUserId: 'user',
          rawsize: 10,
          rawfilemd5: 'md5',
          filesize: 16,
          aeskey: 'hex',
        }),
      ).rejects.toThrow('missing upload_param');
    });
  });

  describe('4. Mock CDN Upload with 3-Attempt Backoff and x-encrypted-param Extraction', () => {
    it('retries on transient failures and extracts x-encrypted-param on success', async () => {
      let attempts = 0;
      const uploadedChunks: Buffer[] = [];

      const cdnServer = await startTestHttpServer((req, res) => {
        attempts++;
        if (attempts < 3) {
          // First two attempts simulate 503 Service Unavailable
          res.writeHead(503, { 'Content-Type': 'text/plain' });
          res.end('CDN Busy');
          return;
        }

        // 3rd attempt succeeds
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(Buffer.from(c)));
        req.on('end', () => {
          uploadedChunks.push(Buffer.concat(chunks));
          res.writeHead(200, {
            'x-encrypted-param': 'enc_cdn_token_attempt_3_success',
            'Content-Type': 'text/plain',
          });
          res.end('OK');
        });
      });
      openServers.push(cdnServer);

      const plaintext = Buffer.from('Novac2c test content for upload retry');
      const aeskey = crypto.randomBytes(16);

      const result = await uploadBufferToCdn({
        buf: plaintext,
        uploadParam: 'mock_upload_param_xyz',
        filekey: 'abcdef0123456789',
        cdnBaseUrl: cdnServer.baseUrl,
        aeskey,
        maxRetries: 3,
        retryDelayMs: 10, // Fast test retry delay
      });

      expect(attempts).toBe(3);
      expect(result.downloadParam).toBe('enc_cdn_token_attempt_3_success');

      // Verify that uploaded body was indeed AES-128-ECB encrypted
      expect(uploadedChunks.length).toBe(1);
      const decrypted = decryptAesEcb(uploadedChunks[0], aeskey);
      expect(decrypted.equals(plaintext)).toBe(true);
    });

    it('fails after exhausting max retries if CDN errors persist', async () => {
      let attempts = 0;
      const failingCdnServer = await startTestHttpServer((req, res) => {
        attempts++;
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Permanent failure');
      });
      openServers.push(failingCdnServer);

      await expect(
        uploadBufferToCdn({
          buf: Buffer.from('test'),
          uploadParam: 'param',
          filekey: 'key',
          cdnBaseUrl: failingCdnServer.baseUrl,
          aeskey: crypto.randomBytes(16),
          maxRetries: 3,
          retryDelayMs: 5,
        }),
      ).rejects.toThrow('CDN upload failed');

      expect(attempts).toBe(3);
    });

    it('fails if response header x-encrypted-param is missing', async () => {
      const missingHeaderServer = await startTestHttpServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK but missing header');
      });
      openServers.push(missingHeaderServer);

      await expect(
        uploadBufferToCdn({
          buf: Buffer.from('test'),
          uploadParam: 'param',
          filekey: 'key',
          cdnBaseUrl: missingHeaderServer.baseUrl,
          aeskey: crypto.randomBytes(16),
          maxRetries: 2,
          retryDelayMs: 5,
        }),
      ).rejects.toThrow('missing x-encrypted-param header');
    });
  });

  describe('5. CDN Download and Decryption (downloadAndDecryptMedia)', () => {
    it('downloads encrypted payload and decrypts accurately', async () => {
      const plaintext = Buffer.from('Enkeep secret media content for download verification');
      const aeskey = crypto.randomBytes(16);
      const ciphertext = encryptAesEcb(plaintext, keyForTest(aeskey));
      const aesKeyBase64 = encodeAesKey(aeskey);

      const downloadCdn = await startTestHttpServer((req, res) => {
        expect(req.url).toContain('/download?encrypted_query_param=enc_param_download_123');
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(ciphertext.length),
        });
        res.end(ciphertext);
      });
      openServers.push(downloadCdn);

      // Positional args style
      const decrypted = await downloadAndDecryptMedia(
        'enc_param_download_123',
        aesKeyBase64,
        { cdnBaseUrl: downloadCdn.baseUrl },
      );
      expect(decrypted.equals(plaintext)).toBe(true);

      // Object params style
      const decryptedObj = await downloadAndDecryptMedia({
        encryptQueryParam: 'enc_param_download_123',
        aesKeyBase64,
        cdnBaseUrl: downloadCdn.baseUrl,
      });
      expect(decryptedObj.equals(plaintext)).toBe(true);
    });

    it('enforces maximum file size defense (50MB threshold)', async () => {
      const largeSizeServer = await startTestHttpServer((req, res) => {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(MAX_MEDIA_FILE_SIZE + 1024),
        });
        res.end('dummy');
      });
      openServers.push(largeSizeServer);

      await expect(
        downloadAndDecryptMedia('param', encodeAesKey(crypto.randomBytes(16)), {
          cdnBaseUrl: largeSizeServer.baseUrl,
        }),
      ).rejects.toThrow('exceeds maximum allowed size');
    });

    it('enforces custom maxFileSize threshold', async () => {
      const thresholdServer = await startTestHttpServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(Buffer.alloc(200));
      });
      openServers.push(thresholdServer);

      await expect(
        downloadAndDecryptMedia('param', encodeAesKey(crypto.randomBytes(16)), {
          cdnBaseUrl: thresholdServer.baseUrl,
          maxFileSize: 100,
        }),
      ).rejects.toThrow('exceeds maximum allowed size');
    });

    it('handles download HTTP error properly', async () => {
      const errorServer = await startTestHttpServer((req, res) => {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      });
      openServers.push(errorServer);

      await expect(
        downloadAndDecryptMedia('param', encodeAesKey(crypto.randomBytes(16)), {
          cdnBaseUrl: errorServer.baseUrl,
        }),
      ).rejects.toThrow('CDN download failed: 404');
    });
  });

  describe('6. End-to-End Media Upload Pipeline (uploadMediaBuffer & uploadMediaFile)', () => {
    it('executes full uploadMediaBuffer pipeline and enables download decryption roundtrip', async () => {
      let uploadedCiphertext: Buffer = Buffer.alloc(0);

      const unifiedServer = await startTestHttpServer((req, res) => {
        if (req.url?.startsWith('/ilink/bot/getuploadurl')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ret: 0, upload_param: 'up_token_e2e_456' }));
        } else if (req.url?.startsWith('/upload')) {
          const chunks: Buffer[] = [];
          req.on('data', (c) => chunks.push(Buffer.from(c)));
          req.on('end', () => {
            uploadedCiphertext = Buffer.concat(chunks);
            res.writeHead(200, {
              'x-encrypted-param': 'down_token_e2e_789',
              'Content-Type': 'text/plain',
            });
            res.end('OK');
          });
        } else if (req.url?.startsWith('/download')) {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
          res.end(uploadedCiphertext);
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      openServers.push(unifiedServer);

      const originalPayload = Buffer.from('Comprehensive E2E upload and roundtrip buffer test!');
      const uploadResult = await uploadMediaBuffer({
        buf: originalPayload,
        fileName: 'test.jpg',
        toUserId: 'wx_user_tester',
        baseUrl: unifiedServer.baseUrl,
        token: 'mock_token',
        cdnBaseUrl: unifiedServer.baseUrl,
        mediaType: WECHAT_MEDIA_TYPE_IMAGE,
        retryDelayMs: 5,
      });

      expect(uploadResult.filekey).toMatch(/^[0-9a-f]{32}$/);
      expect(uploadResult.downloadEncryptedQueryParam).toBe('down_token_e2e_789');
      expect(uploadResult.fileSize).toBe(originalPayload.length);
      expect(uploadResult.fileSizeCiphertext).toBe(aesEcbPaddedSize(originalPayload.length));
      expect(uploadResult.aeskey).toBeDefined();

      // Download and decrypt using the returned aeskey and download token
      const downloaded = await downloadAndDecryptMedia(
        uploadResult.downloadEncryptedQueryParam,
        uploadResult.aeskey,
        { cdnBaseUrl: unifiedServer.baseUrl },
      );

      expect(downloaded.equals(originalPayload)).toBe(true);
    });

    it('uploads a file from disk using uploadMediaFile', async () => {
      const unifiedServer = await startTestHttpServer((req, res) => {
        if (req.url?.startsWith('/ilink/bot/getuploadurl')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ret: 0, upload_param: 'up_file_token_001' }));
        } else if (req.url?.startsWith('/upload')) {
          res.writeHead(200, {
            'x-encrypted-param': 'down_file_token_002',
            'Content-Type': 'text/plain',
          });
          res.end('OK');
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      openServers.push(unifiedServer);

      const tmpFile = path.join(os.tmpdir(), `wechat_test_${Date.now()}_file.txt`);
      const fileContent = 'File content on local filesystem for uploadMediaFile';
      await fs.promises.writeFile(tmpFile, fileContent, 'utf-8');

      try {
        const result = await uploadMediaFile({
          filePath: tmpFile,
          toUserId: 'wx_user_file',
          baseUrl: unifiedServer.baseUrl,
          token: 'token',
          cdnBaseUrl: unifiedServer.baseUrl,
          mediaType: WECHAT_MEDIA_TYPE_FILE,
          retryDelayMs: 5,
        });

        expect(result.downloadEncryptedQueryParam).toBe('down_file_token_002');
        expect(result.fileSize).toBe(Buffer.byteLength(fileContent));
      } finally {
        await fs.promises.unlink(tmpFile).catch(() => {});
      }
    });
  });

  describe('7. CDN URL Builders & Defaults', () => {
    it('builds download and upload URLs properly with query encoding', () => {
      const downUrl = buildCdnDownloadUrl('enc+param/special==');
      expect(downUrl).toBe(
        `${DEFAULT_CDN_BASE}/download?encrypted_query_param=enc%2Bparam%2Fspecial%3D%3D`,
      );

      const upUrl = buildCdnUploadUrl({
        uploadParam: 'up+param/special==',
        filekey: 'key&special=1',
        cdnBaseUrl: 'http://custom-cdn.local',
      });
      expect(upUrl).toBe(
        'http://custom-cdn.local/upload?encrypted_query_param=up%2Bparam%2Fspecial%3D%3D&filekey=key%26special%3D1',
      );
    });

    it('exports standard constants', () => {
      expect(DEFAULT_CDN_BASE).toBe('https://novac2c.cdn.weixin.qq.com/c2c');
      expect(DEFAULT_ILINK_BASE).toBe('https://ilinkai.weixin.qq.com');
      expect(ILINK_APP_ID).toBe('bot');
      expect(ILINK_APP_CLIENT_VERSION).toBe('131329');
      expect(MAX_MEDIA_FILE_SIZE).toBe(50 * 1024 * 1024);
    });
  });
});

function keyForTest(k: Buffer): Buffer {
  return k;
}
