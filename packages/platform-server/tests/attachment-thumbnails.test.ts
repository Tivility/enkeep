/**
 * Integration & Unit Tests for History Image Thumbnails
 *
 * Covers:
 * 1. Large image thumbnail generation and dimension/size shrinkage
 * 2. GIF and small image (<64KB) pass-through without modification
 * 3. Disk cache hit and HTTP 304 If-None-Match negotiation
 * 4. Web message protocol DTO thumbnailUrl population and safe UI regex validation
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { provisionFixtures, DefaultAuthService } from '@enkeep/platform-auth';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { NotFoundError } from '@enkeep/platform-core';
import {
  createPlatformServerHandler,
  SqlitePlatformWebApiAdapter,
  SqliteWebMessageStore,
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  type TenantRuntimeFileProvider,
  type CanonicalFileOperationRequest,
  type CanonicalFileOperationResult,
  type CanonicalStreamingReadRequest,
  type CanonicalStreamingReadResult,
} from '../src/index.js';
import {
  AttachmentThumbnailService,
  isEligibleForThumbnail,
  computeThumbnailCacheKey,
} from '../src/files/attachment-thumbnail-service.js';
import { TestOnlyRuntimeGateway } from './test-runtime-gateway.js';

function computeEtag(buf: Buffer): string {
  const hash = createHash('sha256').update(buf).digest('hex').toLowerCase();
  return `"${hash}"`;
}

describe('History Image Thumbnails (?variant=thumb)', () => {
  let server: Server;
  let baseUrl: string;
  let aliceCookie: string;
  let aliceId: string;
  let aliceSpaceId: string;
  let db: DatabaseSync;
  let tempDshHome: string;
  const testCsrfToken = 'thumbnail-test-csrf-token-32ch-ok!';

  const spaceStorage = new Map<string, { buffer: Buffer; mtimeMs: number }>();

  const mockFileProvider: TenantRuntimeFileProvider = {
    async execute(userId: string, spaceId: string, req: CanonicalFileOperationRequest): Promise<CanonicalFileOperationResult> {
      const storageKey = `${spaceId}:${req.path}`;
      if (req.op === 'read') {
        const item = spaceStorage.get(storageKey);
        if (!item) {
          throw new NotFoundError(`File "${req.path}" not found`);
        }
        const encoding = req.encoding ?? 'utf8';
        const content = encoding === 'base64' ? item.buffer.toString('base64') : item.buffer.toString('utf8');
        return {
          op: 'read',
          path: req.path,
          content,
          size: item.buffer.length,
          mtimeMs: item.mtimeMs,
          etag: computeEtag(item.buffer),
          type: 'file',
        };
      }
      throw new Error(`Unsupported mock op: ${req.op}`);
    },

    async readBinaryStream(userId: string, spaceId: string, req: CanonicalStreamingReadRequest): Promise<CanonicalStreamingReadResult> {
      const storageKey = `${spaceId}:${req.path}`;
      const item = spaceStorage.get(storageKey);
      if (!item) {
        throw new NotFoundError(`File "${req.path}" not found`);
      }
      const { Readable } = await import('node:stream');
      const stream = Readable.from([item.buffer]);
      return {
        op: 'read',
        path: req.path,
        type: 'file',
        size: item.buffer.length,
        totalSize: item.buffer.length,
        mtimeMs: item.mtimeMs,
        etag: computeEtag(item.buffer),
        stream,
      };
    },
  };

  beforeAll(async () => {
    tempDshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-thumb-test-'));

    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    const storage = new SqlitePlatformStorage(db);
    const authService = new DefaultAuthService(storage, {
      cookieSecret: 'thumbnail-test-secret-32-chars-long!',
    });
    const messageStore = new SqliteWebMessageStore(db);
    const platformApi = new SqlitePlatformWebApiAdapter({
      storage,
      authService,
      messageStore,
      db,
    });
    const runtimeGateway = new TestOnlyRuntimeGateway({ storage, messageStore });

    const handler = createPlatformServerHandler({
      database: db,
      storage,
      authService,
      platformApi,
      runtimeGateway,
      csrfToken: testCsrfToken,
      fileProvider: mockFileProvider,
      dshHome: tempDshHome,
    });

    server = createServer(handler);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });

    const fixtures = await provisionFixtures(storage, authService, {
      adminUsername: 'alice',
      adminPassword: 'AlicePassword123!',
      userUsername: 'bob',
      userPassword: 'BobPassword123!',
      disabledUsername: 'charlie',
      disabledPassword: 'CharliePassword123!',
    });
    aliceId = fixtures.admin.id;
    aliceSpaceId = fixtures.adminContainerSpace.id;

    const aliceRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({
        username: 'alice',
        password: 'AlicePassword123!',
      }),
    });
    expect(aliceRes.status).toBe(200);
    const setCookie = aliceRes.headers.get('set-cookie');
    expect(setCookie).toBeDefined();
    aliceCookie = setCookie!.split(';')[0];
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    try {
      fs.rmSync(tempDshHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('1. Large image thumbnail generation and dimension/size shrinkage', async () => {
    // Generate an image > 1000px and > 64KB using uncompressed noise
    const noise = (await import('node:crypto')).randomBytes(1000 * 1000);
    const largePngBuffer = await sharp(noise, { raw: { width: 1000, height: 1000, channels: 1 } })
      .png()
      .toBuffer();

    expect(largePngBuffer.length).toBeGreaterThan(64 * 1024);

    spaceStorage.set(`${aliceSpaceId}:photos/large.png`, {
      buffer: largePngBuffer,
      mtimeMs: 1700000000000,
    });

    // Request with variant=thumb
    const res = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/download?path=photos/large.png&variant=thumb`, {
      headers: {
        Cookie: aliceCookie,
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('content-disposition')).toContain('inline');
    const thumbEtag = res.headers.get('etag');
    expect(thumbEtag).toBeDefined();
    expect(thumbEtag).toContain('-thumb-480');

    const thumbBytes = Buffer.from(await res.arrayBuffer());
    expect(thumbBytes.length).toBeLessThan(largePngBuffer.length);

    // Verify thumbnail dimensions via sharp metadata
    const meta = await sharp(thumbBytes).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBeLessThanOrEqual(480);
    expect(meta.height).toBeLessThanOrEqual(480);
    expect(Math.max(meta.width || 0, meta.height || 0)).toBe(480);
  });

  it('2. GIF and small image (<64KB) pass-through without modification', async () => {
    // 2a. Small PNG (< 64KB)
    const smallPngBuffer = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 3,
        background: { r: 255, g: 0, b: 0 },
      },
    })
      .png()
      .toBuffer();

    expect(smallPngBuffer.length).toBeLessThan(64 * 1024);

    spaceStorage.set(`${aliceSpaceId}:icons/small.png`, {
      buffer: smallPngBuffer,
      mtimeMs: 1700000000000,
    });

    const smallRes = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/download?path=icons/small.png&variant=thumb`, {
      headers: {
        Cookie: aliceCookie,
      },
    });

    expect(smallRes.status).toBe(200);
    // Should pass through as original PNG
    expect(smallRes.headers.get('content-type')).toBe('image/png');
    expect(smallRes.headers.get('content-disposition')).toContain('inline');
    const smallBytes = Buffer.from(await smallRes.arrayBuffer());
    expect(smallBytes.equals(smallPngBuffer)).toBe(true);

    // 2b. GIF format (bypass sharp re-encoding)
    // 1x1 transparent GIF buffer
    const gifBuffer = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    spaceStorage.set(`${aliceSpaceId}:anim.gif`, {
      buffer: gifBuffer,
      mtimeMs: 1700000000000,
    });

    const gifRes = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/download?path=anim.gif&variant=thumb`, {
      headers: {
        Cookie: aliceCookie,
      },
    });

    expect(gifRes.status).toBe(200);
    expect(gifRes.headers.get('content-type')).toBe('image/gif');
    expect(gifRes.headers.get('content-disposition')).toContain('inline');
    const outGifBytes = Buffer.from(await gifRes.arrayBuffer());
    expect(outGifBytes.equals(gifBuffer)).toBe(true);
  });

  it('3. Disk cache hit and HTTP 304 If-None-Match negotiation', async () => {
    // Generate JPEG > 64KB using noise
    const noise = (await import('node:crypto')).randomBytes(600 * 600 * 3);
    const largeJpegBuffer = await sharp(noise, { raw: { width: 600, height: 600, channels: 3 } })
      .jpeg({ quality: 80 })
      .toBuffer();

    expect(largeJpegBuffer.length).toBeGreaterThan(64 * 1024);

    spaceStorage.set(`${aliceSpaceId}:photos/landscape.jpg`, {
      buffer: largeJpegBuffer,
      mtimeMs: 1700000000000,
    });

    // First request: generates thumbnail on disk
    const res1 = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/download?path=photos/landscape.jpg&variant=thumb`, {
      headers: {
        Cookie: aliceCookie,
      },
    });

    expect(res1.status).toBe(200);
    const etag = res1.headers.get('etag');
    expect(etag).toBeDefined();

    // Verify cache file exists on disk
    const thumbService = new AttachmentThumbnailService({ dshHome: tempDshHome });
    const cachedFilePath = thumbService.getThumbnailPath(aliceSpaceId, 'photos/landscape.jpg');
    expect(fs.existsSync(cachedFilePath)).toBe(true);
    expect(fs.statSync(cachedFilePath).size).toBeGreaterThan(0);

    // Verify no stray .tmp files exist
    const cacheParentDir = path.dirname(cachedFilePath);
    const files = fs.readdirSync(cacheParentDir);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);

    // Second request: If-None-Match with matching ETag should return 304 Not Modified
    const res2 = await fetch(`${baseUrl}/api/spaces/${aliceSpaceId}/files/download?path=photos/landscape.jpg&variant=thumb`, {
      headers: {
        Cookie: aliceCookie,
        'If-None-Match': etag!,
      },
    });

    expect(res2.status).toBe(304);
    expect(res2.headers.get('etag')).toBe(etag);
  });

  it('4. Web message protocol DTO thumbnailUrl population and safe UI regex validation', async () => {
    const msgStore = new SqliteWebMessageStore(db);
    const sessionId = 'ses_00000000000000000000000000000001';
    const dshSessionId = 'dsh_sess_000000000000000000000000001';

    // Seed session_route
    db.prepare(`
      INSERT INTO session_routes (id, space_id, user_id, channel, dsh_session_id, status, execution_mode)
      VALUES (?, ?, ?, 'web', ?, 'active', 'container')
    `).run(sessionId, aliceSpaceId, aliceId, dshSessionId);

    // Ingest a message with:
    // 1. Large PNG (>64KB) -> should get thumbnailUrl
    // 2. Small PNG (<64KB) -> no thumbnailUrl
    // 3. GIF (>64KB simulated) -> no thumbnailUrl
    // 4. Text file -> no thumbnailUrl
    const largePngSha = '1111111111111111111111111111111111111111111111111111111111111111';
    const smallPngSha = '2222222222222222222222222222222222222222222222222222222222222222';
    const gifSha = '3333333333333333333333333333333333333333333333333333333333333333';
    const txtSha = '4444444444444444444444444444444444444444444444444444444444444444';

    const ingestRes = await msgStore.ingestWebDelivery({
      userId: aliceId,
      sessionId,
      spaceId: aliceSpaceId,
      dshSessionId,
      idempotencyKey: 'idem_thumb_test_001',
      role: 'user',
      content: 'Here are test attachments',
      timestamp: new Date().toISOString(),
      attachments: [
        {
          id: 'att_01',
          relativePath: 'photo.png',
          snapshotPath: `.attachments/${largePngSha}/photo.png`,
          etag: `"${largePngSha}"`,
          size: 150 * 1024,
          mediaType: 'image/png',
          displayName: 'Large Photo',
          downloadReference: `/api/spaces/${encodeURIComponent(aliceSpaceId)}/files/download?path=.attachments%2F${largePngSha}%2Fphoto.png`,
        },
        {
          id: 'att_02',
          relativePath: 'icon.png',
          snapshotPath: `.attachments/${smallPngSha}/icon.png`,
          etag: `"${smallPngSha}"`,
          size: 20 * 1024,
          mediaType: 'image/png',
          displayName: 'Small Icon',
          downloadReference: `/api/spaces/${encodeURIComponent(aliceSpaceId)}/files/download?path=.attachments%2F${smallPngSha}%2Ficon.png`,
        },
        {
          id: 'att_03',
          relativePath: 'animation.gif',
          snapshotPath: `.attachments/${gifSha}/animation.gif`,
          etag: `"${gifSha}"`,
          size: 200 * 1024,
          mediaType: 'image/gif',
          displayName: 'GIF Animation',
          downloadReference: `/api/spaces/${encodeURIComponent(aliceSpaceId)}/files/download?path=.attachments%2F${gifSha}%2Fanimation.gif`,
        },
        {
          id: 'att_04',
          relativePath: 'doc.txt',
          snapshotPath: `.attachments/${txtSha}/doc.txt`,
          etag: `"${txtSha}"`,
          size: 100 * 1024,
          mediaType: 'text/plain',
          displayName: 'Document',
          downloadReference: `/api/spaces/${encodeURIComponent(aliceSpaceId)}/files/download?path=.attachments%2F${txtSha}%2Fdoc.txt`,
        },
      ],
    });

    const atts = ingestRes.message.attachments!;
    expect(atts).toHaveLength(4);

    const largeAtt = atts.find((a) => a.id === 'att_01')!;
    expect(largeAtt.thumbnailUrl).toBeDefined();
    expect(largeAtt.thumbnailUrl).toContain('&variant=thumb');

    const smallAtt = atts.find((a) => a.id === 'att_02')!;
    expect(smallAtt.thumbnailUrl).toBeUndefined();

    const gifAtt = atts.find((a) => a.id === 'att_03')!;
    expect(gifAtt.thumbnailUrl).toBeUndefined();

    const txtAtt = atts.find((a) => a.id === 'att_04')!;
    expect(txtAtt.thumbnailUrl).toBeUndefined();

    // Verify frontend SAFE_DOWNLOAD_URL_PATTERN
    const SAFE_DOWNLOAD_URL_PATTERN = /^\/api\/spaces\/[a-zA-Z0-9_-]+\/files\/download\?path=[a-zA-Z0-9_.\-%/]+(&variant=thumb)?$/;

    expect(SAFE_DOWNLOAD_URL_PATTERN.test(largeAtt.downloadUrl)).toBe(true);
    expect(SAFE_DOWNLOAD_URL_PATTERN.test(largeAtt.thumbnailUrl!)).toBe(true);

    // Negative regex assertions: reject invalid characters, javascript:, extra query params
    expect(SAFE_DOWNLOAD_URL_PATTERN.test(`${largeAtt.thumbnailUrl}&evil=true`)).toBe(false);
    expect(SAFE_DOWNLOAD_URL_PATTERN.test('javascript:alert(1)')).toBe(false);
    expect(SAFE_DOWNLOAD_URL_PATTERN.test('/api/spaces/spc_01/files/download?path=file.png;rm -rf /')).toBe(false);

    // Verify isAllowedImageAttachment logic (which rejects .. and protocol schemes)
    const isSafeUrl = (url: string) =>
      typeof url === 'string' &&
      !url.includes('://') &&
      !url.startsWith('//') &&
      !url.includes('\0') &&
      !url.includes('..') &&
      SAFE_DOWNLOAD_URL_PATTERN.test(url);

    expect(isSafeUrl('/api/spaces/spc_01/files/download?path=../etc/passwd')).toBe(false);
    expect(isSafeUrl(largeAtt.thumbnailUrl!)).toBe(true);
  });
});
