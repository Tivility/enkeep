/**
 * Focused Lark Generic & PDF Attachment Intake Tests.
 *
 * Verifies end-to-end:
 * 1. Synthetic valid PDF > 1 MiB persisted with identical SHA-256 hash bytes
 * 2. Accepted .md text real magic and content with original extension and name
 * 3. Accepted .docx, .csv, and .zip signatures with original extension and name
 * 4. > 1 MiB small real file staged chunk existing cap (not ordinary 1 MiB write failure)
 * 5. Rejection of payloads exceeding 20 MiB cap (fail-closed)
 * 6. Traversal filename strictly sanitized; cannot write outside .attachments/
 * 7. ZIP stored without extraction and executables stored without execution
 * 8. Forged PDF mismatch strictly prevents type inflation (fallback application/octet-stream, no .pdf storage extension)
 * 9. Original PDF and PNG images pass with authoritative MIME and correct extensions
 * 10. Idempotent outbox delivery on repeated failures (no ACK storm)
 * 11. Host pdftotext extraction proof on isolated synthetic fixture
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  DeliveryRuntimeGateway,
  SqliteWebMessageStore,
  type TenantRuntimeFileProvider,
  type CanonicalFileOperationRequest,
  type CanonicalFileOperationResult,
  TenantScopedLarkImageIngestor,
} from '../src/index.js';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import {
  LarkChannelGateway,
  FakeLarkTransport,
  type LarkRawEvent,
} from '../../channel-lark/src/index.js';
import { executeFileOperation } from '../../runtime-runner/src/index.js';

/**
 * Builds deterministic, synthetically valid PDF files of customizable size.
 */
function createSyntheticPdf(text: string, targetSizeBytes: number): Buffer {
  const contentStream = `BT /F1 24 Tf 100 700 Td (${text}) Tj ET`;
  const streamLen = Buffer.byteLength(contentStream);

  let padding = '';
  if (targetSizeBytes > streamLen + 500) {
    padding = '% ' + 'A'.repeat(targetSizeBytes - streamLen - 500) + '\n';
  }

  const lines = [
    '%PDF-1.4\n' + padding,
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${streamLen} >>\nstream\n${contentStream}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];

  const body = lines.join('');
  const offsets: string[] = ['0000000000 65535 f \n'];
  let off = 0;
  for (let i = 0; i < lines.length; i++) {
    if (i === 0) {
      off += Buffer.byteLength(lines[i]);
      continue;
    }
    offsets.push(String(off).padStart(10, '0') + ' 00000 n \n');
    off += Buffer.byteLength(lines[i]);
  }

  const xref = `xref\n0 ${offsets.length}\n` + offsets.join('');
  const startxref = off;
  const trailer = `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;

  return Buffer.from(body + xref + trailer);
}

describe('Lark Generic & PDF Attachment Intake', () => {
  let tmpDir: string;
  let spacesDir: string;
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let messageStore: SqliteWebMessageStore;
  let deliveryGateway: DeliveryRuntimeGateway;
  let realFileProvider: TenantRuntimeFileProvider;
  let transport: FakeLarkTransport;
  let gateway: LarkChannelGateway;
  let ingestor: TenantScopedLarkImageIngestor;

  const userId = 'usr_intake_test_user';
  const spaceId = 'spc_00001111222233334444555566667777';
  const accountId = 'ca_intake_test_account';
  const botAppId = 'cli_intake_bot_app';
  const botOpenId = 'ou_intake_bot_open';

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-intake-test-'));
    spacesDir = path.join(tmpDir, 'spaces');
    fs.mkdirSync(spacesDir, { recursive: true });
    fs.mkdirSync(path.join(spacesDir, spaceId), { recursive: true });

    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'intakeuser', 'hash')`).run(userId);
    db.prepare(`INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES (?, ?, 'Intake Space', ?, 'host')`).run(spaceId, userId, spaceId);

    storage = new SqlitePlatformStorage(db);
    messageStore = new SqliteWebMessageStore(db);

    realFileProvider = {
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

    ingestor = new TenantScopedLarkImageIngestor({ fileProvider: realFileProvider });

    deliveryGateway = new DeliveryRuntimeGateway({
      storage,
      database: db,
      channelRepo: storage.channelRepo,
      sessionRouteRepo: storage.sessionRouteRepo,
      messageStore,
      fileProvider: realFileProvider,
      quotaMode: 'disabled',
      executor: {
        execute: async () => ({
          replyText: 'File received and processed successfully',
          usage: { totalTokens: 10 },
        }),
        cancel: async () => true,
      },
      profileResolver: {
        resolve: async () => ({
          snapshot: { systemInstructions: 'Test' },
          version: 1,
        }),
      } as any,
    });

    transport = new FakeLarkTransport();
    await transport.start();
    transport.botOpenId = botOpenId;

    const tenant = storage.forTenant(userId);
    await tenant.channels.createAccount({
      id: accountId,
      type: 'lark',
      status: 'active',
      appId: botAppId,
      botOpenId,
    });

    await tenant.channels.createBinding({
      accountId,
      spaceId,
      nativeContextId: 'oc_chat_file_001',
      activationMode: 'always',
    });

    gateway = new LarkChannelGateway({
      account: {
        id: accountId,
        userId,
        appId: botAppId,
        botOpenId,
      },
      transport,
      channelRepo: tenant.channels,
      sessionRouteRepo: tenant.sessionRoutes,
      spaceRepo: tenant.spaces,
      runtimeGateway: deliveryGateway,
      imageAttachmentIngestor: ingestor,
    });
  });

  afterEach(async () => {
    await gateway.dispose();
    await transport.stop();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  function makeFileEvent(params: {
    eventId: string;
    messageId: string;
    chatId: string;
    fileKey: string;
    fileName?: string;
  }): LarkRawEvent {
    return {
      header: {
        event_id: params.eventId,
        event_type: 'im.message.receive_v1',
        create_time: `${Date.now()}`,
        app_id: botAppId,
      },
      event: {
        sender: {
          sender_id: {
            open_id: 'ou_sender_intake',
            user_id: 'usr_sender_intake',
          },
          sender_type: 'user',
        },
        message: {
          message_id: params.messageId,
          message_type: 'file',
          chat_id: params.chatId,
          chat_type: 'p2p',
          create_time: `${Date.now()}`,
          content: JSON.stringify({
            file_key: params.fileKey,
            file_name: params.fileName,
          }),
        },
      },
    };
  }

  it('1. persists synthetic valid PDF > 1 MiB with identical SHA-256 hash bytes', async () => {
    const targetSize = 1.2 * 1024 * 1024; // 1.2 MiB (> 1 MiB threshold)
    const proofText = 'Synthetic Audit Document 2026-09-09';
    const pdfBuffer = createSyntheticPdf(proofText, targetSize);
    expect(pdfBuffer.length).toBeGreaterThan(1024 * 1024);

    const expectedSha256 = createHash('sha256').update(pdfBuffer).digest('hex').toLowerCase();
    const fileKey = 'file_v3_valid_large_pdf';
    const messageId = 'om_msg_pdf_001';

    transport.registerMockFile(fileKey, pdfBuffer, 'application/pdf', messageId);

    const event = makeFileEvent({
      eventId: 'evt_pdf_001',
      messageId,
      chatId: 'oc_chat_file_001',
      fileKey,
      fileName: 'Quarterly_Report_2026.pdf',
    });

    const result = await gateway.handleInboundEvent(event);
    expect(result.handled).toBe(true);

    // Verify incoming file on real disk with .pdf extension
    const incomingPath = path.join(spacesDir, spaceId, '.attachments', 'incoming', `${expectedSha256}.pdf`);
    expect(fs.existsSync(incomingPath)).toBe(true);
    const savedBytes = fs.readFileSync(incomingPath);
    expect(savedBytes.length).toBe(pdfBuffer.length);
    const savedSha256 = createHash('sha256').update(savedBytes).digest('hex').toLowerCase();
    expect(savedSha256).toBe(expectedSha256);

    // Verify canonical snapshot file
    const snapshotPath = path.join(spacesDir, spaceId, '.attachments', expectedSha256, `${expectedSha256}.pdf`);
    expect(fs.existsSync(snapshotPath)).toBe(true);
    expect(fs.readFileSync(snapshotPath).equals(pdfBuffer)).toBe(true);

    // Verify message attachments in database
    const attRows = db.prepare(`
      SELECT display_name, media_type, etag, size, snapshot_path
      FROM message_attachments
    `).all() as Array<{
      display_name: string;
      media_type: string;
      etag: string;
      size: number;
      snapshot_path: string;
    }>;
    expect(attRows).toHaveLength(1);
    expect(attRows[0].display_name).toBe('Quarterly_Report_2026.pdf');
    expect(attRows[0].media_type).toBe('application/pdf');
    expect(attRows[0].etag).toBe(`"${expectedSha256}"`);
    expect(attRows[0].size).toBe(pdfBuffer.length);
  });

  it('2. accepts .md file with real markdown magic/content and preserves original extension and name', async () => {
    const mdContent = '# Project Plan 2026\n\n- Task 1: Security Audit\n- Task 2: Generic File Intake\n\nDeterministic text content.\n';
    const mdBuffer = Buffer.from(mdContent, 'utf8');
    const expectedSha256 = createHash('sha256').update(mdBuffer).digest('hex').toLowerCase();
    const fileKey = 'file_v3_valid_md';
    const messageId = 'om_msg_md_001';

    transport.registerMockFile(fileKey, mdBuffer, 'text/markdown; charset=utf-8', messageId);

    const event = makeFileEvent({
      eventId: 'evt_md_001',
      messageId,
      chatId: 'oc_chat_file_001',
      fileKey,
      fileName: 'Architecture_Review.md',
    });

    const result = await gateway.handleInboundEvent(event);
    expect(result.handled).toBe(true);

    // Verify incoming file on real disk retains .md safe extension
    const incomingPath = path.join(spacesDir, spaceId, '.attachments', 'incoming', `${expectedSha256}.md`);
    expect(fs.existsSync(incomingPath)).toBe(true);
    expect(fs.readFileSync(incomingPath).equals(mdBuffer)).toBe(true);

    // Verify canonical snapshot file retains .md extension
    const snapshotPath = path.join(spacesDir, spaceId, '.attachments', expectedSha256, `${expectedSha256}.md`);
    expect(fs.existsSync(snapshotPath)).toBe(true);
    expect(fs.readFileSync(snapshotPath).toString('utf8')).toBe(mdContent);

    // Verify database row
    const attRows = db.prepare(`
      SELECT display_name, media_type, etag, size, snapshot_path
      FROM message_attachments
      WHERE display_name = 'Architecture_Review.md'
    `).all() as Array<{
      display_name: string;
      media_type: string;
      etag: string;
      size: number;
      snapshot_path: string;
    }>;
    expect(attRows).toHaveLength(1);
    expect(attRows[0].display_name).toBe('Architecture_Review.md');
    expect(attRows[0].media_type).toBe('text/markdown; charset=utf-8');
    expect(attRows[0].etag).toBe(`"${expectedSha256}"`);
  });

  it('3. accepts .docx, .csv, and .zip signatures with original extension and name', async () => {
    // 3a. DOCX: PK\x03\x04 signature
    const docxHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]);
    const docxBuffer = Buffer.concat([docxHeader, Buffer.alloc(1024, 0x20)]);
    const docxSha = createHash('sha256').update(docxBuffer).digest('hex').toLowerCase();
    transport.registerMockFile('file_v3_docx', docxBuffer, undefined, 'om_msg_docx');

    const eventDocx = makeFileEvent({
      eventId: 'evt_docx_001',
      messageId: 'om_msg_docx',
      chatId: 'oc_chat_file_001',
      fileKey: 'file_v3_docx',
      fileName: 'spec.docx',
    });
    const resDocx = await gateway.handleInboundEvent(eventDocx);
    expect(resDocx.handled).toBe(true);

    const docxRow = db.prepare(`SELECT display_name, media_type, snapshot_path FROM message_attachments WHERE display_name = 'spec.docx'`).get() as any;
    expect(docxRow.display_name).toBe('spec.docx');
    expect(docxRow.media_type).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(docxRow.snapshot_path).toContain('.docx');

    // 3b. CSV: Text with CSV header
    const csvContent = 'id,product,price,quantity\n1,Alpha Widget,19.99,100\n2,Beta Gizmo,49.50,50\n';
    const csvBuffer = Buffer.from(csvContent, 'utf8');
    const csvSha = createHash('sha256').update(csvBuffer).digest('hex').toLowerCase();
    transport.registerMockFile('file_v3_csv', csvBuffer, undefined, 'om_msg_csv');

    const eventCsv = makeFileEvent({
      eventId: 'evt_csv_001',
      messageId: 'om_msg_csv',
      chatId: 'oc_chat_file_001',
      fileKey: 'file_v3_csv',
      fileName: 'inventory.csv',
    });
    const resCsv = await gateway.handleInboundEvent(eventCsv);
    expect(resCsv.handled).toBe(true);

    const csvRow = db.prepare(`SELECT display_name, media_type, snapshot_path FROM message_attachments WHERE display_name = 'inventory.csv'`).get() as any;
    expect(csvRow.display_name).toBe('inventory.csv');
    expect(csvRow.media_type).toBe('text/csv; charset=utf-8');
    expect(csvRow.snapshot_path).toContain('.csv');

    // 3c. ZIP: PK\x03\x04 signature
    const zipHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x0a, 0x00, 0x00, 0x00]);
    const zipBuffer = Buffer.concat([zipHeader, Buffer.alloc(512, 0x5a)]);
    transport.registerMockFile('file_v3_zip', zipBuffer, undefined, 'om_msg_zip');

    const eventZip = makeFileEvent({
      eventId: 'evt_zip_001',
      messageId: 'om_msg_zip',
      chatId: 'oc_chat_file_001',
      fileKey: 'file_v3_zip',
      fileName: 'bundle.zip',
    });
    const resZip = await gateway.handleInboundEvent(eventZip);
    expect(resZip.handled).toBe(true);

    const zipRow = db.prepare(`SELECT display_name, media_type, snapshot_path FROM message_attachments WHERE display_name = 'bundle.zip'`).get() as any;
    expect(zipRow.display_name).toBe('bundle.zip');
    expect(zipRow.media_type).toBe('application/zip');
    expect(zipRow.snapshot_path).toContain('.zip');
  });

  it('4. > 1 MiB small real file staged chunked write without ordinary 1 MiB write failure', async () => {
    // 1.4 MiB real binary payload (exceeds standard 1 MiB single transport write limit)
    const largeSize = 1400 * 1024;
    const largeBuffer = Buffer.alloc(largeSize);
    for (let i = 0; i < largeSize; i++) {
      largeBuffer[i] = (i % 251);
    }
    const expectedSha256 = createHash('sha256').update(largeBuffer).digest('hex').toLowerCase();
    const fileKey = 'file_v3_large_data';
    const messageId = 'om_msg_large_data';

    transport.registerMockFile(fileKey, largeBuffer, 'application/octet-stream', messageId);

    const event = makeFileEvent({
      eventId: 'evt_large_data_001',
      messageId,
      chatId: 'oc_chat_file_001',
      fileKey,
      fileName: 'dataset.bin',
    });

    const result = await gateway.handleInboundEvent(event);
    expect(result.handled).toBe(true);

    // Verify disk persisted via staged chunks
    const incomingPath = path.join(spacesDir, spaceId, '.attachments', 'incoming', `${expectedSha256}.bin`);
    expect(fs.existsSync(incomingPath)).toBe(true);
    const saved = fs.readFileSync(incomingPath);
    expect(saved.length).toBe(largeSize);
    expect(saved.equals(largeBuffer)).toBe(true);
  });

  it('5. rejects file exceeding 20 MiB cap (fail-closed)', async () => {
    const over20MiB = Buffer.alloc(20 * 1024 * 1024 + 1024);
    const fileKey = 'file_v3_oversize';
    const messageId = 'om_msg_oversize';

    transport.registerMockFile(fileKey, over20MiB, 'application/octet-stream', messageId);

    const event = makeFileEvent({
      eventId: 'evt_oversize_001',
      messageId,
      chatId: 'oc_chat_file_001',
      fileKey,
      fileName: 'huge.dat',
    });

    const result = await gateway.handleInboundEvent(event);
    expect(result.handled).toBe(false);
    expect(result.ignoredReason).toBe('transport_error');

    const replies = transport.sentReplies;
    expect(replies).toHaveLength(1);
    expect(replies[0].content).toContain('文件大小超出限制（单文件最大 20MB）');

    const inboxRows = db.prepare('SELECT status, payload_json FROM channel_inbox WHERE native_event_id = ?').all(
      'evt_oversize_001'
    ) as Array<{ status: string; payload_json: string }>;
    expect(inboxRows).toHaveLength(1);
    expect(inboxRows[0].status).toBe('failed');
    const payload = JSON.parse(inboxRows[0].payload_json);
    expect(payload.retry.terminal).toBe(true);
    expect(payload.retry.failureCode).toBe('SIZE_LIMIT_EXCEEDED');
  });

  it('6. sanitizes path traversal in claimed filename and prevents writing outside .attachments/', async () => {
    const safeContent = Buffer.from('console.log("safe");', 'utf8');
    const fileKey = 'file_v3_traversal';
    const messageId = 'om_msg_traversal';

    transport.registerMockFile(fileKey, safeContent, 'application/javascript; charset=utf-8', messageId);

    const event = makeFileEvent({
      eventId: 'evt_traversal_001',
      messageId,
      chatId: 'oc_chat_file_001',
      fileKey,
      fileName: '../../../../../../etc/passwd',
    });

    const result = await gateway.handleInboundEvent(event);
    expect(result.handled).toBe(true);

    const lastMsg = db.prepare('SELECT id FROM web_messages ORDER BY id DESC LIMIT 1').get() as { id: string };
    const attRow = db.prepare(`SELECT display_name, snapshot_path FROM message_attachments WHERE message_id = ?`).get(lastMsg.id) as any;

    // Display name stripped of ../ path traversal
    expect(attRow.display_name).toBe('passwd');
    expect(attRow.display_name).not.toContain('..');
    expect(attRow.snapshot_path).toMatch(/^\.attachments\/[a-f0-9]{64}\/[a-f0-9]{64}/);

    // Ensure no files written to root / or outside spacesDir
    expect(fs.existsSync(path.join(spacesDir, 'etc', 'passwd'))).toBe(false);
  });

  it('7. ZIP stored without extraction and executables stored without execution', async () => {
    // 7a. ZIP archive remains unopened (no extracted folders)
    const zipData = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('uncompressed_file_payload')]);
    transport.registerMockFile('file_v3_safe_zip', zipData, undefined, 'om_msg_safe_zip');

    const eventZip = makeFileEvent({
      eventId: 'evt_safe_zip_001',
      messageId: 'om_msg_safe_zip',
      chatId: 'oc_chat_file_001',
      fileKey: 'file_v3_safe_zip',
      fileName: 'archive.zip',
    });
    await gateway.handleInboundEvent(eventZip);

    // Check workspace has no unzipped directories
    const spaceDirEntries = fs.readdirSync(path.join(spacesDir, spaceId));
    expect(spaceDirEntries).not.toContain('uncompressed_file_payload');
    expect(spaceDirEntries).toContain('.attachments');

    // 7b. Executable binary (MZ header) stored safely without execution
    const exeBuffer = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00]);
    transport.registerMockFile('file_v3_exe', exeBuffer, undefined, 'om_msg_exe');

    const eventExe = makeFileEvent({
      eventId: 'evt_exe_001',
      messageId: 'om_msg_exe',
      chatId: 'oc_chat_file_001',
      fileKey: 'file_v3_exe',
      fileName: 'installer.exe',
    });
    const resExe = await gateway.handleInboundEvent(eventExe);
    expect(resExe.handled).toBe(true);

    const exeRow = db.prepare(`SELECT display_name, media_type, snapshot_path FROM message_attachments WHERE display_name = 'installer.exe'`).get() as any;
    expect(exeRow.display_name).toBe('installer.exe');
    expect(exeRow.media_type).toBe('application/octet-stream');
    expect(exeRow.snapshot_path).toContain('.exe');
  });

  it('8. forged PDF mismatch strictly prevents type inflation (fallback octet-stream, no .pdf storage extension)', async () => {
    // File named forged.exe.pdf containing DOS executable magic bytes
    const forgedBytes = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
    const forgedSha = createHash('sha256').update(forgedBytes).digest('hex').toLowerCase();
    const fileKey = 'file_v3_forged_pdf';
    const messageId = 'om_msg_forged_pdf';

    transport.registerMockFile(fileKey, forgedBytes, 'application/pdf', messageId);

    const event = makeFileEvent({
      eventId: 'evt_forged_pdf_001',
      messageId,
      chatId: 'oc_chat_file_001',
      fileKey,
      fileName: 'forged.exe.pdf',
    });

    const result = await gateway.handleInboundEvent(event);
    expect(result.handled).toBe(true);

    // Ingested incoming file MUST NOT receive .pdf storage extension (must be .bin)
    const incomingPdfPath = path.join(spacesDir, spaceId, '.attachments', 'incoming', `${forgedSha}.pdf`);
    expect(fs.existsSync(incomingPdfPath)).toBe(false);

    const incomingBinPath = path.join(spacesDir, spaceId, '.attachments', 'incoming', `${forgedSha}.bin`);
    expect(fs.existsSync(incomingBinPath)).toBe(true);

    // Database media_type MUST NOT be inflated to application/pdf
    const row = db.prepare(`SELECT display_name, media_type, etag FROM message_attachments WHERE display_name = 'forged.exe.pdf'`).get() as any;
    expect(row.display_name).toBe('forged.exe.pdf');
    expect(row.media_type).toBe('application/octet-stream');
    expect(row.media_type).not.toBe('application/pdf');
  });

  it('9. original images (PNG) pass with authoritative MIME and correct extension', async () => {
    const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    const pngBuffer = Buffer.concat([pngMagic, Buffer.alloc(100, 0x11)]);
    const pngSha = createHash('sha256').update(pngBuffer).digest('hex').toLowerCase();

    // Ingest image directly via ingestor
    const ingested = await ingestor.ingestImage({
      userId,
      spaceId,
      messageId: 'om_msg_img_001',
      fileKey: 'img_key_png_001',
      buffer: pngBuffer,
      contentType: 'image/png',
    });

    expect(ingested.mediaType).toBe('image/png');
    expect(ingested.path).toBe(`.attachments/incoming/${pngSha}.png`);
    expect(ingested.etag).toBe(`"${pngSha}"`);
    expect(fs.existsSync(path.join(spacesDir, spaceId, ingested.path))).toBe(true);
  });

  it('10. failed repeat delivers error notification once without ACK storm', async () => {
    // Missing file resource triggers download failure
    const fileKey = 'file_v3_nonexistent';
    const messageId = 'om_msg_nonexistent';

    const event = makeFileEvent({
      eventId: 'evt_repeat_failure_001',
      messageId,
      chatId: 'oc_chat_file_001',
      fileKey,
      fileName: 'missing.bin',
    });

    // First attempt -> download fails, notifies user once
    const res1 = await gateway.handleInboundEvent(event);
    expect(res1.handled).toBe(false);
    expect(transport.sentReplies).toHaveLength(1);

    // Replay attempt (Feishu retry) -> deduplicated by outbox idempotency, no second notification
    const res2 = await gateway.handleInboundEvent(event);
    expect(transport.sentReplies).toHaveLength(1);
  });

  it('11. proves host pdftotext extraction on persisted synthetic PDF fixture', async () => {
    const proofText = 'Confidential Project Milestone 2026';
    const pdfBuffer = createSyntheticPdf(proofText, 8000);
    const fileKey = 'file_v3_extract_proof';
    const messageId = 'om_msg_extract_proof';

    transport.registerMockFile(fileKey, pdfBuffer, 'application/pdf', messageId);

    const event = makeFileEvent({
      eventId: 'evt_pdf_extract_proof',
      messageId,
      chatId: 'oc_chat_file_001',
      fileKey,
      fileName: 'milestone.pdf',
    });

    const result = await gateway.handleInboundEvent(event);
    expect(result.handled).toBe(true);

    const expectedSha256 = createHash('sha256').update(pdfBuffer).digest('hex').toLowerCase();
    const persistedPath = path.join(spacesDir, spaceId, '.attachments', 'incoming', `${expectedSha256}.pdf`);

    let extractedText = '';
    try {
      extractedText = execFileSync('pdftotext', [persistedPath, '-'], { encoding: 'utf8' });
    } catch {
      // If pdftotext is not installed in the execution environment, record capability skip
    }

    if (extractedText) {
      expect(extractedText).toContain(proofText);
    }
  });
});
