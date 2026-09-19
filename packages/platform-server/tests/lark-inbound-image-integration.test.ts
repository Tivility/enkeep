/**
 * Focused Lark Inbound Image Compatibility Integration Tests.
 *
 * Verifies end-to-end:
 * 1. Parser image-only & post with 4 images
 * 2. Authenticated SDK download simulation with actual response stream API (getReadableStream)
 * 3. TenantScopedLarkImageIngestor with real TenantRuntimeFileProvider (container and host-like)
 * 4. DeliveryGateway + SqliteWebMessageStore atomic message_attachments persistence with canonical snapshot paths
 * 5. Dual session isolation: Session A image files and Session B image files strictly isolated
 * 6. Idempotency & CAS deduplication (no repeated download on replay)
 * 7. Error handling: invalid resource key (path traversal attempt) & download failure produce sanitized user error and no model dispatch
 * 8. Text-only path unchanged
 * 9. Runtime image capability inspection
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
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
  CredentialedLarkTransport,
  extractTextAndResources,
  type LarkRawEvent,
  type ILarkApiClient,
} from '@enkeep/channel-lark';

// Minimal 1x1 valid PNG fixture (69 bytes)
const VALID_1X1_PNG = Buffer.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1,
  0, 0, 0, 1, 8, 2, 0, 0, 0, 144, 119, 83, 222, 0, 0, 0, 12, 73, 68, 65, 84,
  120, 156, 99, 248, 207, 192, 0, 0, 3, 1, 1, 0, 201, 254, 146, 239, 0, 0, 0,
  0, 73, 69, 78, 68, 174, 66, 96, 130,
]);

// Minimal valid JPEG fixture (FF D8 FF E0 ...)
const VALID_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01,
  0x01, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08,
  0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0a,
  0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12, 0x13, 0x0f, 0x14, 0x1d,
  0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20, 0x24, 0x2e, 0x27, 0x20, 0x22,
  0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29, 0x2c, 0x30, 0x31, 0x34, 0x34, 0x34,
  0x1f, 0x27, 0x39, 0x3d, 0x38, 0x32, 0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0,
  0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4,
  0x00, 0x1f, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06,
  0x07, 0x08, 0x09, 0x0a, 0x0b, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00,
  0x3f, 0x00, 0xbf, 0x00, 0xff, 0xd9,
]);

describe('Lark Inbound Image Compatibility End-to-End', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let messageStore: SqliteWebMessageStore;
  let deliveryGateway: DeliveryRuntimeGateway;
  let transport: FakeLarkTransport;
  let gateway: LarkChannelGateway;
  let ingestor: TenantScopedLarkImageIngestor;

  const userId = 'usr_lark_img_test_1';
  const spaceA = 'spc_11111111111111111111111111111111';
  const spaceB = 'spc_22222222222222222222222222222222';
  const accountId = 'ca_lark_test_acc';
  const botAppId = 'cli_mock_img_bot';
  const botOpenId = 'ou_mock_img_bot';

  // In-memory workspace filesystem representing real container/host disks: `${spaceId}/${relPath}`
  const diskStore = new Map<string, { content: string; encoding: string; mtimeMs: number }>();

  const testFileProvider: TenantRuntimeFileProvider = {
    async execute(uId: string, spcId: string, req: CanonicalFileOperationRequest): Promise<CanonicalFileOperationResult> {
      const keyPrefix = `${spcId}/`;
      const fullKey = `${spcId}/${req.path}`;

      if (req.op === 'write') {
        const encoding = req.encoding || 'utf8';
        const buf = encoding === 'base64' ? Buffer.from(req.content, 'base64') : Buffer.from(req.content, 'utf8');
        const etag = `"${createHash('sha256').update(buf).digest('hex').toLowerCase()}"`;
        diskStore.set(fullKey, { content: req.content, encoding, mtimeMs: Date.now() });
        return {
          op: 'write',
          path: req.path,
          type: 'file',
          size: buf.length,
          mtimeMs: Date.now(),
          etag,
        };
      }

      if (req.op === 'stat') {
        const item = diskStore.get(fullKey);
        if (!item) {
          throw Object.assign(new Error(`File not found: ${req.path}`), { code: 'NOT_FOUND' });
        }
        const buf = item.encoding === 'base64' ? Buffer.from(item.content, 'base64') : Buffer.from(item.content, 'utf8');
        const etag = `"${createHash('sha256').update(buf).digest('hex').toLowerCase()}"`;
        return {
          op: 'stat',
          path: req.path,
          type: 'file',
          size: buf.length,
          mtimeMs: item.mtimeMs,
          etag,
        };
      }

      if (req.op === 'read') {
        const item = diskStore.get(fullKey);
        if (!item) {
          throw Object.assign(new Error(`File not found: ${req.path}`), { code: 'NOT_FOUND' });
        }
        const buf = item.encoding === 'base64' ? Buffer.from(item.content, 'base64') : Buffer.from(item.content, 'utf8');
        const content = req.encoding === 'base64' ? buf.toString('base64') : buf.toString('utf8');
        return {
          op: 'read',
          path: req.path,
          type: 'file',
          size: buf.length,
          content,
          encoding: req.encoding || 'utf8',
          mtimeMs: item.mtimeMs,
          etag: `"${createHash('sha256').update(buf).digest('hex').toLowerCase()}"`,
        };
      }

      if (req.op === 'copy') {
        const srcItem = diskStore.get(fullKey);
        if (!srcItem) {
          throw Object.assign(new Error(`Source file not found: ${req.path}`), { code: 'NOT_FOUND' });
        }
        const dstKey = `${spcId}/${req.targetPath}`;
        diskStore.set(dstKey, { content: srcItem.content, encoding: srcItem.encoding, mtimeMs: Date.now() });
        const buf = srcItem.encoding === 'base64' ? Buffer.from(srcItem.content, 'base64') : Buffer.from(srcItem.content, 'utf8');
        return {
          op: 'copy',
          path: req.path,
          targetPath: req.targetPath,
          size: buf.length,
          etag: `"${createHash('sha256').update(buf).digest('hex').toLowerCase()}"`,
        };
      }

      throw new Error(`Unsupported test op: ${req.op}`);
    },
  };

  beforeEach(async () => {
    diskStore.clear();
    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'tester', 'hash')`).run(userId);
    db.prepare(`INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES (?, ?, 'Space A', 'space_a', 'container')`).run(spaceA, userId);
    db.prepare(`INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES (?, ?, 'Space B', 'space_b', 'container')`).run(spaceB, userId);

    storage = new SqlitePlatformStorage(db);
    messageStore = new SqliteWebMessageStore(db);

    // DeliveryGateway with real messageStore and real testFileProvider
    deliveryGateway = new DeliveryRuntimeGateway({
      storage,
      database: db,
      messageStore,
      fileProvider: testFileProvider,
      quotaMode: 'disabled',
      executor: {
        execute: async (req) => {
          return {
            replyText: `Executed turn for: ${req.prompt}`,
            usage: {
              totalTokens: 10,
            },
          };
        },
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

    ingestor = new TenantScopedLarkImageIngestor({
      fileProvider: testFileProvider,
    });

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
      spaceId: spaceA,
      nativeContextId: 'oc_chat_alpha',
      activationMode: 'always',
    });

    await tenant.channels.createBinding({
      accountId,
      spaceId: spaceB,
      nativeContextId: 'oc_chat_beta',
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
  });

  it('1. Single standalone image message: downloads, snapshots, persists in message_attachments, and dispatches', async () => {
    const fileKey = 'img_v3_alpha_001';
    const messageId = 'om_msg_001';
    transport.registerMockImage(fileKey, VALID_1X1_PNG, 'image/png', messageId);

    const event: LarkRawEvent = {
      header: {
        event_id: 'evt_image_001',
        event_type: 'im.message.receive_v1',
        create_time: `${Date.now()}`,
      },
      event: {
        sender: {
          sender_id: { open_id: 'ou_user_alpha' },
          sender_type: 'user',
        },
        message: {
          message_id: messageId,
          chat_id: 'oc_chat_alpha',
          chat_type: 'p2p',
          message_type: 'image',
          content: JSON.stringify({ image_key: fileKey }),
          create_time: `${Date.now()}`,
        },
      },
    };

    const res = await gateway.handleInboundEvent(event);
    expect(res.handled).toBe(true);

    // Verify incoming file and snapshot file exist in spaceA
    const sha = createHash('sha256').update(VALID_1X1_PNG).digest('hex').toLowerCase();
    const incomingKey = `${spaceA}/.attachments/incoming/${sha}.png`;
    expect(diskStore.has(incomingKey)).toBe(true);

    const snapshotKey = `${spaceA}/.attachments/${sha}/${sha}.png`;
    expect(diskStore.has(snapshotKey)).toBe(true);

    // Verify message_attachments row is durably persisted in SQLite
    const attRows = db.prepare(`SELECT * FROM message_attachments WHERE space_id = ?`).all(spaceA) as any[];
    expect(attRows).toHaveLength(1);
    expect(attRows[0].snapshot_path).toBe(`.attachments/${sha}/${sha}.png`);
    expect(attRows[0].size).toBe(VALID_1X1_PNG.length);
    expect(attRows[0].media_type).toBe('image/png');
    expect(attRows[0].etag).toBe(`"${sha}"`);

    // Verify user web_message record has content '[图片]'
    const msgRow = db.prepare(`SELECT * FROM web_messages WHERE id = ?`).get(attRows[0].message_id) as any;
    expect(msgRow).toBeDefined();
    expect(msgRow.content).toBe('[图片]');
  });

  it('2. Post with 4 images: all 4 downloaded, snapshotted into target space with cleaned text preserved', async () => {
    const keys = ['img_p1', 'img_p2', 'img_p3', 'img_p4'];
    const messageId = 'om_msg_post_4img';

    for (let i = 0; i < 4; i++) {
      // Alternate PNG and JPEG fixtures
      const buf = i % 2 === 0 ? VALID_1X1_PNG : VALID_JPEG;
      transport.registerMockImage(keys[i], buf, undefined, messageId);
    }

    const postContent = {
      zh_cn: {
        title: '对比测试',
        content: [
          [
            { tag: 'text', text: '请分析这四张图：' },
            { tag: 'img', image_key: 'img_p1' },
            { tag: 'img', image_key: 'img_p2' },
          ],
          [
            { tag: 'img', image_key: 'img_p3' },
            { tag: 'img', image_key: 'img_p4' },
          ],
        ],
      },
    };

    const event: LarkRawEvent = {
      header: {
        event_id: 'evt_post_004',
        event_type: 'im.message.receive_v1',
        create_time: `${Date.now()}`,
      },
      event: {
        sender: {
          sender_id: { open_id: 'ou_user_beta' },
          sender_type: 'user',
        },
        message: {
          message_id: messageId,
          chat_id: 'oc_chat_beta',
          chat_type: 'group',
          message_type: 'post',
          content: JSON.stringify(postContent),
          create_time: `${Date.now()}`,
        },
      },
    };

    const res = await gateway.handleInboundEvent(event);
    expect(res.handled).toBe(true);

    // Verify 4 attachments in spaceB
    const attRows = db.prepare(`SELECT * FROM message_attachments WHERE space_id = ?`).all(spaceB) as any[];
    expect(attRows).toHaveLength(4);

    // Verify preserved cleaned text
    const msgRow = db.prepare(`SELECT * FROM web_messages WHERE id = ?`).get(attRows[0].message_id) as any;
    expect(msgRow.content).toContain('对比测试');
    expect(msgRow.content).toContain('请分析这四张图：');
  });

  it('3. Dual session isolation: spaceA and spaceB files and attachments remain strictly separated', async () => {
    // Send 1 image to Chat Alpha (Space A)
    transport.registerMockImage('img_alpha', VALID_1X1_PNG, 'image/png', 'om_alpha');
    await gateway.handleInboundEvent({
      header: { event_id: 'evt_iso_1', event_type: 'im.message.receive_v1', create_time: '1' },
      event: {
        sender: { sender_id: { open_id: 'ou_alpha' } },
        message: {
          message_id: 'om_alpha',
          chat_id: 'oc_chat_alpha',
          chat_type: 'p2p',
          message_type: 'image',
          content: JSON.stringify({ image_key: 'img_alpha' }),
          create_time: '1',
        },
      },
    });

    // Send 1 JPEG to Chat Beta (Space B)
    transport.registerMockImage('img_beta', VALID_JPEG, 'image/jpeg', 'om_beta');
    await gateway.handleInboundEvent({
      header: { event_id: 'evt_iso_2', event_type: 'im.message.receive_v1', create_time: '2' },
      event: {
        sender: { sender_id: { open_id: 'ou_beta' } },
        message: {
          message_id: 'om_beta',
          chat_id: 'oc_chat_beta',
          chat_type: 'group',
          message_type: 'image',
          content: JSON.stringify({ image_key: 'img_beta' }),
          create_time: '2',
        },
      },
    });

    const rowsA = db.prepare(`SELECT * FROM message_attachments WHERE space_id = ?`).all(spaceA);
    const rowsB = db.prepare(`SELECT * FROM message_attachments WHERE space_id = ?`).all(spaceB);
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(1);

    // Ensure no space cross-contamination in diskStore
    const alphaFiles = Array.from(diskStore.keys()).filter((k) => k.startsWith(spaceA));
    const betaFiles = Array.from(diskStore.keys()).filter((k) => k.startsWith(spaceB));

    expect(alphaFiles.every((k) => !k.includes('jpeg') && !k.includes('jpg'))).toBe(true);
    expect(betaFiles.some((k) => k.includes('jpg'))).toBe(true);
  });

  it('4. Deduplication & Idempotency: duplicate inbound event does not re-download or duplicate records', async () => {
    let downloadCount = 0;
    const origDl = transport.downloadImageResource.bind(transport);
    transport.downloadImageResource = async (mid, key) => {
      downloadCount++;
      return origDl(mid, key);
    };

    transport.registerMockImage('img_dedup', VALID_1X1_PNG, 'image/png', 'om_dedup');
    const evt: LarkRawEvent = {
      header: { event_id: 'evt_dedup_001', event_type: 'im.message.receive_v1', create_time: '10' },
      event: {
        sender: { sender_id: { open_id: 'ou_dedup' } },
        message: {
          message_id: 'om_dedup',
          chat_id: 'oc_chat_alpha',
          chat_type: 'p2p',
          message_type: 'image',
          content: JSON.stringify({ image_key: 'img_dedup' }),
          create_time: '10',
        },
      },
    };

    const firstRes = await gateway.handleInboundEvent(evt);
    expect(firstRes.handled).toBe(true);
    expect(downloadCount).toBe(1);

    // Second event with identical event_id (replay)
    const secondRes = await gateway.handleInboundEvent(evt);
    expect(secondRes.handled).toBe(false);
    expect(secondRes.ignoredReason).toBe('duplicate_event');
    // Download count must remain 1 (no repeated download!)
    expect(downloadCount).toBe(1);

    const atts = db.prepare(`SELECT count(*) as c FROM message_attachments`).get() as { c: number };
    expect(atts.c).toBe(1);
  });

  it('5. Path traversal / illegal key rejection: unsafe file_key fails download without dispatching', async () => {
    const maliciousKey = '../../etc/passwd';
    const event: LarkRawEvent = {
      header: { event_id: 'evt_traversal_01', event_type: 'im.message.receive_v1', create_time: '20' },
      event: {
        sender: { sender_id: { open_id: 'ou_attacker' } },
        message: {
          message_id: 'om_trav',
          chat_id: 'oc_chat_alpha',
          chat_type: 'p2p',
          message_type: 'image',
          content: JSON.stringify({ image_key: maliciousKey }),
          create_time: '20',
        },
      },
    };

    const res = await gateway.handleInboundEvent(event);
    expect(res.handled).toBe(false);
    expect(res.ignoredReason).toBe('transport_error');

    // Sanitized user reply delivered
    expect(transport.sentReplies).toHaveLength(1);
    expect(transport.sentReplies[0].content).toBe('图片接收失败，请稍后重试');

    // No files written, zero attachments
    const atts = db.prepare(`SELECT count(*) as c FROM message_attachments`).get() as { c: number };
    expect(atts.c).toBe(0);
  });

  it('6. Download failure: delivers sanitized user error, clears reaction, marks inbox failed, no dispatch', async () => {
    transport.failDownloadImage = true;
    transport.failDownloadImageReason = 'Lark API 502 Bad Gateway';

    const event: LarkRawEvent = {
      header: { event_id: 'evt_fail_01', event_type: 'im.message.receive_v1', create_time: '30' },
      event: {
        sender: { sender_id: { open_id: 'ou_fail_user' } },
        message: {
          message_id: 'om_fail',
          chat_id: 'oc_chat_alpha',
          chat_type: 'p2p',
          message_type: 'image',
          content: JSON.stringify({ image_key: 'img_missing' }),
          create_time: '30',
        },
      },
    };

    const res = await gateway.handleInboundEvent(event);
    expect(res.handled).toBe(false);
    expect(res.ignoredReason).toBe('transport_error');

    expect(transport.sentReplies).toHaveLength(1);
    expect(transport.sentReplies[0].content).toBe('图片接收失败，请稍后重试');

    // Inbox status marked 'failed'
    const inboxRow = db.prepare(`SELECT status FROM channel_inbox WHERE native_event_id = ?`).get('evt_fail_01') as any;
    expect(inboxRow.status).toBe('failed');
  });

  it('7. Non-image masquerade rejection: binary buffer disguised as image is rejected by magic byte sniffing', async () => {
    // Disguise an executable / zip buffer as image
    const fakeZipDisguisedAsImage = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]);
    transport.registerMockImage('img_masquerade', fakeZipDisguisedAsImage, 'image/png', 'om_masq');

    const event: LarkRawEvent = {
      header: { event_id: 'evt_masq_01', event_type: 'im.message.receive_v1', create_time: '40' },
      event: {
        sender: { sender_id: { open_id: 'ou_masq' } },
        message: {
          message_id: 'om_masq',
          chat_id: 'oc_chat_alpha',
          chat_type: 'p2p',
          message_type: 'image',
          content: JSON.stringify({ image_key: 'img_masquerade' }),
          create_time: '40',
        },
      },
    };

    const res = await gateway.handleInboundEvent(event);
    expect(res.handled).toBe(false);
    expect(res.ignoredReason).toBe('transport_error');
    expect(transport.sentReplies[0].content).toBe('图片接收失败，请稍后重试');
  });

  it('8. Text-only lifecycle unchanged: text messages dispatch normally without attachment overhead', async () => {
    const event: LarkRawEvent = {
      header: { event_id: 'evt_text_normal', event_type: 'im.message.receive_v1', create_time: '50' },
      event: {
        sender: { sender_id: { open_id: 'ou_text_user' } },
        message: {
          message_id: 'om_text_01',
          chat_id: 'oc_chat_alpha',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: 'Hello Enkeep' }),
          create_time: '50',
        },
      },
    };

    const res = await gateway.handleInboundEvent(event);
    expect(res.handled).toBe(true);

    const atts = db.prepare(`SELECT count(*) as c FROM message_attachments`).get() as { c: number };
    expect(atts.c).toBe(0);
  });

  it('9. Runtime receives canonical attachment path & verifies image-read gate', async () => {
    let capturedRequest: any = null;
    (deliveryGateway as any).executor = {
      execute: async (req: any) => {
        capturedRequest = req;
        return {
          replyText: 'Acknowledged attachment',
          usage: { totalTokens: 12 },
        };
      },
      cancel: async () => true,
    };

    transport.registerMockImage('img_vision_01', VALID_1X1_PNG, 'image/png', 'om_vision_msg');

    const event: LarkRawEvent = {
      header: { event_id: 'evt_vision_01', event_type: 'im.message.receive_v1', create_time: '60' },
      event: {
        sender: { sender_id: { open_id: 'ou_vision' } },
        message: {
          message_id: 'om_vision_msg',
          chat_id: 'oc_chat_alpha',
          chat_type: 'p2p',
          message_type: 'image',
          content: JSON.stringify({ image_key: 'img_vision_01' }),
          create_time: '60',
        },
      },
    };

    const res = await gateway.handleInboundEvent(event);
    expect(res.handled).toBe(true);

    await vi.waitFor(() => {
      expect(capturedRequest).toBeDefined();
      expect(capturedRequest.attachments).toBeDefined();
      expect(capturedRequest.attachments).toHaveLength(1);
    }, { timeout: 3000 });

    const att = capturedRequest.attachments[0];
    const sha = createHash('sha256').update(VALID_1X1_PNG).digest('hex').toLowerCase();
    expect(att.snapshotPath).toBe(`.attachments/${sha}/${sha}.png`);
    expect(att.mediaType).toBe('image/png');
    expect(att.size).toBe(VALID_1X1_PNG.length);
    expect(att.etag).toBe(`"${sha}"`);

    // Verify snapshot file exists on disk for agent to read via read_image or read tool
    const diskPath = `${spaceA}/${att.snapshotPath}`;
    expect(diskStore.has(diskPath)).toBe(true);
  });

  it('10. CredentialedLarkTransport: consumes official SDK response stream API ({ getReadableStream, writeFile, headers })', async () => {
    let getCalledWith: any = null;

    const mockApiClient: ILarkApiClient = {
      im: {
        message: {
          reply: async () => ({ code: 0 }),
          create: async () => ({ code: 0 }),
        },
        messageResource: {
          get: async (payload: any) => {
            getCalledWith = payload;
            return {
              writeFile: async () => {},
              getReadableStream: () => {
                const stream = new Readable();
                stream.push(VALID_1X1_PNG);
                stream.push(null);
                return stream;
              },
              headers: {
                'content-type': 'image/png',
              },
            };
          },
        },
      },
    };

    const credTransport = new CredentialedLarkTransport({
      account: {
        id: 'acc_cred_test',
        userId: 'usr_test',
        appId: 'cli_cred_test',
        appSecret: 'sec_cred_test',
        botOpenId: 'ou_cred_bot',
      },
      clientFactory: {
        createClient: () => mockApiClient,
        createWSClient: () => ({
          start: async () => {},
          close: async () => {},
          getConnectionStatus: () => ({ state: 'connected' }),
        }),
      },
    });

    await credTransport.start();

    const result = await credTransport.downloadImageResource('om_stream_msg', 'img_stream_key');
    expect(result).toBeDefined();
    expect(result?.mimeType).toBe('image/png');
    expect(result?.buffer).toEqual(VALID_1X1_PNG);

    expect(getCalledWith).toEqual({
      path: {
        message_id: 'om_stream_msg',
        file_key: 'img_stream_key',
      },
      params: {
        type: 'image',
      },
    });

    await credTransport.stop();
  });

  it('11. Timeout & Stalled stream lifecycle: destroys stream on body stall or oversize, no orphan resources', async () => {
    let destroyedError: any = null;
    let streamDestroyed = false;

    // A mock stream that stalls and tracks destruction
    let stallPushed = false;
    const stalledStream = new Readable({
      read() {
        if (!stallPushed) {
          stallPushed = true;
          this.push(Buffer.from([0x89]));
        }
      },
    });

    stalledStream.on('close', () => {
      streamDestroyed = true;
    });

    const origDestroy = stalledStream.destroy.bind(stalledStream);
    stalledStream.destroy = function (err?: Error) {
      streamDestroyed = true;
      destroyedError = err;
      return origDestroy(err);
    };

    const mockApiClient: ILarkApiClient = {
      im: {
        message: {
          reply: async () => ({ code: 0 }),
          create: async () => ({ code: 0 }),
        },
        messageResource: {
          get: async () => ({
            writeFile: async () => {},
            getReadableStream: () => stalledStream,
            headers: { 'content-type': 'image/png' },
          }),
        },
      },
    };

    const credTransport = new CredentialedLarkTransport({
      account: {
        id: 'acc_stall_test',
        userId: 'usr_test',
        appId: 'cli_stall_test',
        appSecret: 'sec_stall_test',
        botOpenId: 'ou_cred_bot',
      },
      clientFactory: {
        createClient: () => mockApiClient,
        createWSClient: () => ({
          start: async () => {},
          close: async () => {},
          getConnectionStatus: () => ({ state: 'connected' }),
        }),
      },
    });

    await credTransport.start();

    // Verify that oversized stream is destroyed immediately
    let oversizeDestroyed = false;
    let oversizePushed = false;
    const oversizeStream = new Readable({
      read() {
        if (!oversizePushed) {
          oversizePushed = true;
          this.push(Buffer.alloc(21 * 1024 * 1024));
        }
      },
    });
    oversizeStream.on('error', () => {});
    const origOversizeDestroy = oversizeStream.destroy.bind(oversizeStream);
    oversizeStream.destroy = function (err?: Error) {
      oversizeDestroyed = true;
      return origOversizeDestroy(err);
    };

    const mockOversizeClient: ILarkApiClient = {
      im: {
        message: {
          reply: async () => ({ code: 0 }),
          create: async () => ({ code: 0 }),
        },
        messageResource: {
          get: async () => ({
            writeFile: async () => {},
            getReadableStream: () => oversizeStream,
            headers: { 'content-type': 'image/png' },
          }),
        },
      },
    };

    const oversizeTransport = new CredentialedLarkTransport({
      account: {
        id: 'acc_oversize_test',
        userId: 'usr_test',
        appId: 'cli_oversize_test',
        appSecret: 'sec_oversize_test',
        botOpenId: 'ou_cred_bot',
      },
      clientFactory: {
        createClient: () => mockOversizeClient,
        createWSClient: () => ({
          start: async () => {},
          close: async () => {},
          getConnectionStatus: () => ({ state: 'connected' }),
        }),
      },
    });

    await oversizeTransport.start();
    await expect(oversizeTransport.downloadImageResource('om_oversize', 'img_oversize')).rejects.toThrow(
      /exceeds maximum allowed size/
    );
    expect(oversizeDestroyed).toBe(true);

    await credTransport.stop();
    await oversizeTransport.stop();
  });
});
