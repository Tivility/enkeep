import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  DeliveryRuntimeGateway,
  SqliteWebMessageStore,
  type TenantRuntimeFileProvider,
  type CanonicalFileOperationRequest,
  type CanonicalFileOperationResult,
  TenantScopedLarkImageIngestor,
  RuntimeFileApiService,
} from '../src/index.js';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { executeFileOperation, FileOpError } from '../../runtime-runner/src/index.js';

/**
 * Generates synthetic, deterministic, size-controlled valid PNG fixtures (no personal data).
 */
function createSyntheticPng(targetSizeBytes: number): Buffer {
  const buf = Buffer.alloc(targetSizeBytes);
  // PNG Magic Header: 89 50 4E 47 0D 0A 1A 0A
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  header.copy(buf, 0);

  // Fill body with deterministic non-zero pattern
  for (let i = header.length; i < targetSizeBytes; i++) {
    buf[i] = (i * 31 + 17) & 0xff;
  }
  return buf;
}

/**
 * Generates synthetic, deterministic, size-controlled valid JPEG fixtures (no personal data).
 */
function createSyntheticJpeg(targetSizeBytes: number): Buffer {
  const buf = Buffer.alloc(targetSizeBytes);
  // JPEG Magic Header: FF D8 FF E0
  const header = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
  header.copy(buf, 0);

  for (let i = header.length; i < targetSizeBytes - 2; i++) {
    buf[i] = (i * 13 + 7) & 0xff;
  }
  // JPEG End of Image: FF D9
  buf[targetSizeBytes - 2] = 0xff;
  buf[targetSizeBytes - 1] = 0xd9;
  return buf;
}

describe('Lark Large Image Persistence & Cap Compatibility', () => {
  let tmpDir: string;
  let spacesDir: string;
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let messageStore: SqliteWebMessageStore;
  let deliveryGateway: DeliveryRuntimeGateway;
  let realHostFileProvider: TenantRuntimeFileProvider;

  const userId = 'usr_large_img_test_1';
  const spaceA = 'spc_aaaa1111222233334444555566667777';
  const spaceB = 'spc_bbbb1111222233334444555566667777';

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-img-test-'));
    spacesDir = path.join(tmpDir, 'spaces');
    fs.mkdirSync(spacesDir, { recursive: true });
    fs.mkdirSync(path.join(spacesDir, spaceA), { recursive: true });
    fs.mkdirSync(path.join(spacesDir, spaceB), { recursive: true });

    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'tester', 'hash')`).run(userId);
    db.prepare(`INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES (?, ?, 'Space A', ?, 'host')`).run(spaceA, userId, spaceA);
    db.prepare(`INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES (?, ?, 'Space B', ?, 'host')`).run(spaceB, userId, spaceB);

    storage = new SqlitePlatformStorage(db);
    messageStore = new SqliteWebMessageStore(db);

    // Real host provider strictly invoking shared executeFileOperation
    realHostFileProvider = {
      async execute(_uId: string, spcId: string, req: CanonicalFileOperationRequest): Promise<CanonicalFileOperationResult> {
        const res = executeFileOperation(
          {
            ...req,
            space: spcId,
          },
          {
            spacesDir,
            expectedUid: typeof process.getuid === 'function' ? process.getuid() : 1000,
          }
        );
        return res as unknown as CanonicalFileOperationResult;
      },
    };

    deliveryGateway = new DeliveryRuntimeGateway({
      storage,
      database: db,
      messageStore,
      quotaMode: 'disabled',
      fileProvider: realHostFileProvider,
      executor: {
        execute: async () => ({ replyText: 'ok' }),
        cancel: async () => true,
      },
      profileResolver: {
        resolve: async () => ({
          snapshot: { systemInstructions: 'Test' },
          version: 1,
        }),
      } as any,
    });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe('1. Shared executeFileOperation Serialization & Security Boundaries', () => {
    it('ordinary file-op 1MiB policy remains strictly unchanged (>1MiB rejected)', () => {
      const oversized1_2MB = Buffer.alloc(1024 * 1024 + 100, 0x61);
      expect(() => {
        executeFileOperation(
          {
            op: 'write',
            space: spaceA,
            path: 'documents/large.txt',
            content: oversized1_2MB.toString('base64'),
            encoding: 'base64',
            requireAbsent: true,
          },
          { spacesDir }
        );
      }).toThrow(FileOpError);

      try {
        executeFileOperation(
          {
            op: 'write',
            space: spaceA,
            path: 'documents/large.txt',
            content: oversized1_2MB.toString('base64'),
            encoding: 'base64',
            requireAbsent: true,
          },
          { spacesDir }
        );
      } catch (err) {
        expect((err as FileOpError).code).toBe('PAYLOAD_TOO_LARGE');
      }

      // Ordinary file <= 1MiB succeeds normally
      const validSmall = Buffer.alloc(1024, 0x42);
      const smallRes = executeFileOperation(
        {
          op: 'write',
          space: spaceA,
          path: 'documents/small.txt',
          content: validSmall.toString('base64'),
          encoding: 'base64',
          requireAbsent: true,
        },
        { spacesDir }
      );
      expect(smallRes.op).toBe('write');
      expect(smallRes.size).toBe(1024);
    });

    it('chunk transport cap: single chunk >1MiB is rejected with PAYLOAD_TOO_LARGE', () => {
      const oversizedChunk = Buffer.alloc(1024 * 1024 + 1, 0x41);
      expect(() => {
        executeFileOperation(
          {
            op: 'stage_chunk',
            space: spaceA,
            path: '.attachments/incoming/sample.png',
            offset: 0,
            content: oversizedChunk.toString('base64'),
            encoding: 'base64',
          },
          { spacesDir }
        );
      }).toThrow(FileOpError);
    });

    it('interrupted transfer does NOT create consumable partial attachment', () => {
      const chunk = Buffer.alloc(512 * 1024, 0x41);
      const targetRelPath = '.attachments/incoming/interrupted.png';

      // Write chunk 0
      const stageRes = executeFileOperation(
        {
          op: 'stage_chunk',
          space: spaceA,
          path: targetRelPath,
          offset: 0,
          content: chunk.toString('base64'),
          encoding: 'base64',
        },
        { spacesDir }
      );
      expect(stageRes.op).toBe('stage_chunk');
      expect(stageRes.stageToken).toBeDefined();

      // Interrupted before commit: target path must NOT exist
      const targetOnDisk = path.join(spacesDir, spaceA, targetRelPath);
      expect(fs.existsSync(targetOnDisk)).toBe(false);

      // Abort stage cleanly unlinks the temporary staging file
      const abortRes = executeFileOperation(
        {
          op: 'abort_stage',
          space: spaceA,
          path: targetRelPath,
          stageToken: stageRes.stageToken!,
        },
        { spacesDir }
      );
      expect(abortRes.op).toBe('abort_stage');
      const tempPath = path.join(spacesDir, spaceA, '.attachments/incoming', stageRes.stageToken!);
      expect(fs.existsSync(tempPath)).toBe(false);
    });

    it('space and tenant isolation: spaceA file cannot be accessed from spaceB', () => {
      const chunk = Buffer.alloc(1024, 0x41);
      const stageRes = executeFileOperation(
        {
          op: 'stage_chunk',
          space: spaceA,
          path: '.attachments/incoming/isolated.png',
          offset: 0,
          content: chunk.toString('base64'),
          encoding: 'base64',
        },
        { spacesDir }
      );
      executeFileOperation(
        {
          op: 'commit_stage',
          space: spaceA,
          path: '.attachments/incoming/isolated.png',
          stageToken: stageRes.stageToken!,
          requireAbsent: true,
        },
        { spacesDir }
      );

      // Stat in spaceA succeeds
      const statA = executeFileOperation(
        { op: 'stat', space: spaceA, path: '.attachments/incoming/isolated.png' },
        { spacesDir }
      );
      expect(statA.op).toBe('stat');
      expect(statA.size).toBe(1024);

      // Stat in spaceB throws NOT_FOUND
      expect(() => {
        executeFileOperation(
          { op: 'stat', space: spaceB, path: '.attachments/incoming/isolated.png' },
          { spacesDir }
        );
      }).toThrow(FileOpError);
    });

    it('security check: stage_chunk to non-attachment path is strictly rejected with INVALID_TARGET', () => {
      const chunk = Buffer.alloc(1024, 0x41);
      expect(() => {
        executeFileOperation(
          {
            op: 'stage_chunk',
            space: spaceA,
            path: 'documents/bypassed.txt',
            offset: 0,
            content: chunk.toString('base64'),
            encoding: 'base64',
          },
          { spacesDir }
        );
      }).toThrow(FileOpError);

      try {
        executeFileOperation(
          {
            op: 'stage_chunk',
            space: spaceA,
            path: 'documents/bypassed.txt',
            offset: 0,
            content: chunk.toString('base64'),
            encoding: 'base64',
          },
          { spacesDir }
        );
      } catch (err) {
        expect((err as FileOpError).code).toBe('INVALID_TARGET');
      }
    });

    it('security check: path traversal in stage_chunk is strictly rejected', () => {
      const chunk = Buffer.alloc(512, 0x41);
      expect(() => {
        executeFileOperation(
          {
            op: 'stage_chunk',
            space: spaceA,
            path: '../traversal.png',
            offset: 0,
            content: chunk.toString('base64'),
            encoding: 'base64',
          },
          { spacesDir }
        );
      }).toThrow();
    });

    it('security check: offset mismatch / out-of-order chunk is rejected with PRECONDITION_FAILED', () => {
      const chunk = Buffer.alloc(512, 0x41);
      const stageRes = executeFileOperation(
        {
          op: 'stage_chunk',
          space: spaceA,
          path: '.attachments/incoming/seq_test.png',
          offset: 0,
          content: chunk.toString('base64'),
          encoding: 'base64',
        },
        { spacesDir }
      );
      expect(stageRes.currentSize).toBe(512);

      // Attempt chunk at offset 1024 (gap of 512 bytes)
      expect(() => {
        executeFileOperation(
          {
            op: 'stage_chunk',
            space: spaceA,
            path: '.attachments/incoming/seq_test.png',
            stageToken: stageRes.stageToken,
            offset: 1024,
            content: chunk.toString('base64'),
            encoding: 'base64',
          },
          { spacesDir }
        );
      }).toThrow(FileOpError);

      try {
        executeFileOperation(
          {
            op: 'stage_chunk',
            space: spaceA,
            path: '.attachments/incoming/seq_test.png',
            stageToken: stageRes.stageToken,
            offset: 1024,
            content: chunk.toString('base64'),
            encoding: 'base64',
          },
          { spacesDir }
        );
      } catch (err) {
        expect((err as FileOpError).code).toBe('PRECONDITION_FAILED');
      }
    });

    it('security check: commit_stage with mismatched or cross-file stageToken is rejected', () => {
      expect(() => {
        executeFileOperation(
          {
            op: 'commit_stage',
            space: spaceA,
            path: '.attachments/incoming/fileA.png',
            stageToken: '.fileB.png.1122334455667788.stage.tmp',
          },
          { spacesDir }
        );
      }).toThrow(FileOpError);
    });

    it('chunk base64 JSON payload strictly remains below 1MiB transport limit', () => {
      const CHUNK_SIZE = 512 * 1024; // 512 KiB binary
      const buf = Buffer.alloc(CHUNK_SIZE, 0x5a);
      const b64 = buf.toString('base64');
      const b64ByteLength = Buffer.byteLength(b64, 'utf8');

      // 512 KiB in base64 is 699,052 bytes (~683 KiB)
      expect(b64ByteLength).toBeLessThan(1024 * 1024);
      expect(b64ByteLength).toBe(699052);
    });

    it('container protocol: daemon normalized fileOp dispatches identical operation semantics', () => {
      const chunk = Buffer.alloc(1024, 0x63);
      // Simulating daemon-protocol handleFileOp normalization
      const daemonPayload: any = {
        spaceId: spaceA,
        op: 'stage_chunk',
        path: '.attachments/incoming/daemon_proto.png',
        offset: 0,
        content: chunk.toString('base64'),
        encoding: 'base64',
      };
      const normalizedReq = {
        ...daemonPayload,
        space: daemonPayload.space ?? daemonPayload.spaceId,
      };
      delete normalizedReq.spaceId;

      const res = executeFileOperation(normalizedReq, { spacesDir });
      expect(res.op).toBe('stage_chunk');
      expect(res.currentSize).toBe(1024);
    });
  });

  describe('2. Ingestor via Real Host Provider (Bounded Chunk Transport)', () => {
    it('accepts exact 1,610,370 bytes valid PNG fixture byte-identical', async () => {
      const EXACT_SIZE = 1610370; // 1,610,370 bytes from production incident
      const testPng = createSyntheticPng(EXACT_SIZE);
      expect(testPng.length).toBe(EXACT_SIZE);

      const ingestor = new TenantScopedLarkImageIngestor({ fileProvider: realHostFileProvider });
      const envelope = await ingestor.ingestImage({
        userId,
        spaceId: spaceA,
        messageId: 'om_msg_exact_1610370',
        fileKey: 'img_incident_1610370',
        buffer: testPng,
        contentType: 'image/png',
      });

      expect(envelope.path).toContain('.attachments/incoming/');
      expect(envelope.mediaType).toBe('image/png');

      // Verify on-disk content is byte-identical
      const diskPath = path.join(spacesDir, spaceA, envelope.path);
      expect(fs.existsSync(diskPath)).toBe(true);
      const savedBytes = fs.readFileSync(diskPath);
      expect(savedBytes.length).toBe(EXACT_SIZE);
      expect(savedBytes.equals(testPng)).toBe(true);

      // Verify ETag matches SHA-256
      const expectedSha = createHash('sha256').update(testPng).digest('hex').toLowerCase();
      expect(envelope.etag).toBe(`"${expectedSha}"`);
    });

    it('accepts near-20MiB (~19.5 MiB) valid JPEG fixture byte-identical', async () => {
      const NEAR_20MIB = 19 * 1024 * 1024 + 512 * 1024; // 19.5 MiB (20,447,232 B)
      const testJpeg = createSyntheticJpeg(NEAR_20MIB);
      expect(testJpeg.length).toBe(NEAR_20MIB);

      const ingestor = new TenantScopedLarkImageIngestor({ fileProvider: realHostFileProvider });
      const envelope = await ingestor.ingestImage({
        userId,
        spaceId: spaceA,
        messageId: 'om_msg_near_20m',
        fileKey: 'img_near_20m_key',
        buffer: testJpeg,
        contentType: 'image/jpeg',
      });

      expect(envelope.path).toContain('.attachments/incoming/');
      expect(envelope.mediaType).toBe('image/jpeg');

      const diskPath = path.join(spacesDir, spaceA, envelope.path);
      expect(fs.existsSync(diskPath)).toBe(true);
      const diskStat = fs.statSync(diskPath);
      expect(diskStat.size).toBe(NEAR_20MIB);

      const expectedSha = createHash('sha256').update(testJpeg).digest('hex').toLowerCase();
      expect(envelope.etag).toBe(`"${expectedSha}"`);
    }, 30_000);

    it('strictly rejects payload exceeding 20MiB (>20,971,520 bytes)', async () => {
      const OVER_20MIB = 20 * 1024 * 1024 + 1024; // 20 MiB + 1 KiB
      const overBuffer = createSyntheticPng(OVER_20MIB);

      const ingestor = new TenantScopedLarkImageIngestor({ fileProvider: realHostFileProvider });
      await expect(
        ingestor.ingestImage({
          userId,
          spaceId: spaceA,
          messageId: 'om_msg_over_limit',
          fileKey: 'img_over_limit',
          buffer: overBuffer,
          contentType: 'image/png',
        })
      ).rejects.toMatchObject({
        code: 'PAYLOAD_TOO_LARGE',
        status: 413,
      });
    });
  });

  describe('3. End-to-End: Ingestor -> Provider -> Delivery Snapshot -> message_attachments SQLite', () => {
    it('persists 1.61MiB image into delivery snapshot and SQLite message_attachments table', async () => {
      const testPng = createSyntheticPng(1610370);
      const sha = createHash('sha256').update(testPng).digest('hex').toLowerCase();

      // 1. Ingest via real host provider
      const ingestor = new TenantScopedLarkImageIngestor({ fileProvider: realHostFileProvider });
      const envelope = await ingestor.ingestImage({
        userId,
        spaceId: spaceA,
        messageId: 'om_pipeline_001',
        fileKey: 'img_pipe_1610370',
        buffer: testPng,
        contentType: 'image/png',
      });
      expect(envelope.path).toBe(`.attachments/incoming/${sha}.png`);

      // 2. Persist attachment snapshot via delivery gateway
      const canonicalAttachments = await (deliveryGateway as any).processInboundAttachments(
        userId,
        spaceA,
        'del_test_delivery_001',
        [envelope]
      );
      expect(canonicalAttachments).toHaveLength(1);
      const att = canonicalAttachments[0];
      expect(att.snapshotPath).toBe(`.attachments/${sha}/${sha}.png`);
      expect(att.size).toBe(1610370);
      expect(att.mediaType).toBe('image/png');

      // Verify physical snapshot file on disk in spaceA is byte-identical
      const snapshotDiskPath = path.join(spacesDir, spaceA, att.snapshotPath);
      expect(fs.existsSync(snapshotDiskPath)).toBe(true);
      const snapshotBytes = fs.readFileSync(snapshotDiskPath);
      expect(snapshotBytes.length).toBe(1610370);
      expect(snapshotBytes.equals(testPng)).toBe(true);

      // 3. Insert into messageStore and verify SQLite persistence
      const sessionId = 'ses_large_img_session_001';
      db.prepare(
        `INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id, execution_mode) VALUES (?, ?, ?, 'lark', 'app1', ?, 'p1', 'dsh1', 'host')`
      ).run(sessionId, userId, spaceA, sessionId);

      const ingestRes = await messageStore.ingestWebDelivery({
        userId,
        sessionId,
        spaceId: spaceA,
        dshSessionId: 'dsh1',
        idempotencyKey: 'deliv_test_large_img_001',
        content: '[图片]',
        timestamp: new Date().toISOString(),
        attachments: canonicalAttachments,
      });

      // Verify SQLite message_attachments table row
      const rows = db.prepare(`SELECT * FROM message_attachments WHERE space_id = ?`).all(spaceA) as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].message_id).toBe(ingestRes.messageId);
      expect(rows[0].snapshot_path).toBe(`.attachments/${sha}/${sha}.png`);
      expect(rows[0].size).toBe(1610370);
      expect(rows[0].media_type).toBe('image/png');
      expect(rows[0].etag).toBe(`"${sha}"`);
    });

    it('RuntimeFileApiService facade validates and dispatches stage_chunk, commit_stage, abort_stage', async () => {
      const apiService = new RuntimeFileApiService({ fileProvider: realHostFileProvider });
      const chunk = Buffer.alloc(1024, 0x47);
      const stageRes = await apiService.execute(userId, spaceA, {
        op: 'stage_chunk',
        path: '.attachments/incoming/api_facade.png',
        offset: 0,
        content: chunk.toString('base64'),
        encoding: 'base64',
      });
      expect(stageRes.op).toBe('stage_chunk');
      expect((stageRes as any).bytesWritten).toBe(1024);

      const commitRes = await apiService.execute(userId, spaceA, {
        op: 'commit_stage',
        path: '.attachments/incoming/api_facade.png',
        stageToken: (stageRes as any).stageToken,
        requireAbsent: true,
      });
      expect(commitRes.op).toBe('commit_stage');
      expect((commitRes as any).size).toBe(1024);

      // Verify boundary check: RuntimeFileApiService strictly rejects stage_chunk to non-.attachments/
      await expect(
        apiService.execute(userId, spaceA, {
          op: 'stage_chunk',
          path: 'src/forbidden.png',
          offset: 0,
          content: chunk.toString('base64'),
          encoding: 'base64',
        })
      ).rejects.toThrow();
    });
  });
});
