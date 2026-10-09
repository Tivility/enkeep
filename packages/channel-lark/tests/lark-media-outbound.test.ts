import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  ALL_PLATFORM_MIGRATIONS,
  PlatformServerMigrationRunner,
} from '../../platform-server/src/storage/migrations.js';
import {
  SqlitePlatformStorage,
  SqliteTenantScopedChannelRepository,
  SqliteTenantScopedSessionRouteRepository,
  SqliteTenantScopedSpaceRepository,
} from '@enkeep/platform-storage-sqlite';
import {
  FakeLarkTransport,
  CredentialedLarkTransport,
  LarkChannelGateway,
  type ILarkApiClient,
} from '../src/index.js';

describe('E-01: Lark Media & File Outbound Dispatch (im.v1)', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let channelRepo: SqliteTenantScopedChannelRepository;
  let sessionRouteRepo: SqliteTenantScopedSessionRouteRepository;
  let spaceRepo: SqliteTenantScopedSpaceRepository;

  const userId = 'usr_lark_media_test';
  const spaceId = 'spc_lark_media_space';
  const accountId = 'ca_lark_media_acc';
  const chatId = 'oc_media_test_chat';

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'media_user', 'hash')`).run(userId);
    db.prepare(`INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES (?, ?, 'Media Space', 'media-space', 'container')`).run(spaceId, userId);

    storage = new SqlitePlatformStorage(db);
    channelRepo = new SqliteTenantScopedChannelRepository(db, userId);
    sessionRouteRepo = new SqliteTenantScopedSessionRouteRepository(db, userId);
    spaceRepo = new SqliteTenantScopedSpaceRepository(db, userId);

    await channelRepo.createAccount({
      id: accountId,
      type: 'lark',
      status: 'active',
      credentialRef: 'cred_lark_media',
    });
  });

  describe('1. CredentialedLarkTransport uploadAndSendImage & uploadAndSendFile with SDK mock', () => {
    it('uploads image via im.v1.image.create and sends image message via reply/create', async () => {
      const calls = {
        imageCreate: [] as any[],
        messageReply: [] as any[],
        messageCreate: [] as any[],
      };

      const mockClient: ILarkApiClient = {
        im: {
          image: {
            create: async (payload: any) => {
              calls.imageCreate.push(payload);
              return { code: 0, image_key: 'img_synthetic_key_001' };
            },
          },
          message: {
            reply: async (payload: any) => {
              calls.messageReply.push(payload);
              return { code: 0, data: { message_id: 'om_reply_img_001' } };
            },
            create: async (payload: any) => {
              calls.messageCreate.push(payload);
              return { code: 0, data: { message_id: 'om_create_img_001' } };
            },
          },
        },
      };

      const transport = new CredentialedLarkTransport({
        account: {
          id: accountId,
          userId,
          appId: 'cli_synthetic_01',
          appSecret: 'sec_synthetic_01',
        },
        apiClient: mockClient,
      });

      const imageBuf = Buffer.from('fake png image data');

      // Test A: Reply to existing message in chat (with replyToMessageId)
      const res1 = await transport.uploadAndSendImage({
        chatId,
        imageBuffer: imageBuf,
        replyToMessageId: 'om_orig_human_msg',
      });

      expect(res1.success).toBe(true);
      expect(res1.messageId).toBe('om_reply_img_001');
      expect(calls.imageCreate.length).toBe(1);
      expect(calls.imageCreate[0].data.image_type).toBe('message');
      expect(calls.imageCreate[0].data.image).toEqual(imageBuf);

      expect(calls.messageReply.length).toBe(1);
      expect(calls.messageReply[0].path.message_id).toBe('om_orig_human_msg');
      expect(calls.messageReply[0].data.msg_type).toBe('image');
      expect(calls.messageReply[0].data.content).toBe(JSON.stringify({ image_key: 'img_synthetic_key_001' }));

      // Test B: Send directly to chat without replyTo
      const res2 = await transport.uploadAndSendImage({
        chatId,
        imageBuffer: imageBuf,
      });

      expect(res2.success).toBe(true);
      expect(res2.messageId).toBe('om_create_img_001');
      expect(calls.messageCreate.length).toBe(1);
      expect(calls.messageCreate[0].params.receive_id_type).toBe('chat_id');
      expect(calls.messageCreate[0].data.receive_id).toBe(chatId);
      expect(calls.messageCreate[0].data.msg_type).toBe('image');
      expect(calls.messageCreate[0].data.content).toBe(JSON.stringify({ image_key: 'img_synthetic_key_001' }));
    });

    it('uploads file via im.v1.file.create and sends file message with topic reply_in_thread', async () => {
      const calls = {
        fileCreate: [] as any[],
        messageReply: [] as any[],
      };

      const mockClient: ILarkApiClient = {
        im: {
          file: {
            create: async (payload: any) => {
              calls.fileCreate.push(payload);
              return { code: 0, file_key: 'file_synthetic_key_001' };
            },
          },
          message: {
            reply: async (payload: any) => {
              calls.messageReply.push(payload);
              return { code: 0, data: { message_id: 'om_reply_file_001' } };
            },
            create: async () => ({ code: 0, data: { message_id: 'om_create_001' } }),
          },
        },
      };

      const transport = new CredentialedLarkTransport({
        account: {
          id: accountId,
          userId,
          appId: 'cli_synthetic_02',
          appSecret: 'sec_synthetic_02',
        },
        apiClient: mockClient,
      });

      const pdfBuf = Buffer.from('%PDF-1.4 synthetic content');

      const res = await transport.uploadAndSendFile({
        chatId,
        fileBuffer: pdfBuf,
        fileName: 'report.pdf',
        rootId: 'om_topic_root',
        threadId: 'omt_topic_thread',
        replyToMessageId: 'om_topic_msg_01',
      });

      expect(res.success).toBe(true);
      expect(res.messageId).toBe('om_reply_file_001');
      expect(calls.fileCreate.length).toBe(1);
      expect(calls.fileCreate[0].data.file_type).toBe('pdf');
      expect(calls.fileCreate[0].data.file_name).toBe('report.pdf');

      expect(calls.messageReply.length).toBe(1);
      expect(calls.messageReply[0].path.message_id).toBe('om_topic_root');
      expect(calls.messageReply[0].data.reply_in_thread).toBe(true);
      expect(calls.messageReply[0].data.msg_type).toBe('file');
      expect(calls.messageReply[0].data.content).toBe(JSON.stringify({ file_key: 'file_synthetic_key_001' }));
    });
  });

  describe('2. LarkChannelGateway deliverFile integration', () => {
    it('deliverFile dispatches image to transport and creates delivered channel_outbox row', async () => {
      const fakeTransport = new FakeLarkTransport();
      await fakeTransport.start();

      const route = await sessionRouteRepo.create({
        spaceId,
        channel: 'lark',
        accountId,
        nativeContextId: chatId,
        peerId: 'peer_user_1',
        dshSessionId: 'dsh_ses_media_001',
      });

      const gateway = new LarkChannelGateway({
        account: { id: accountId, userId, appId: 'cli_test' },
        transport: fakeTransport,
        channelRepo,
        sessionRouteRepo,
        runtimeGateway: {} as any,
      });

      const imageBuffer = Buffer.from('synthetic png bytes');
      const res = await gateway.deliverFile({
        sessionId: route.id,
        chatId,
        turnId: 'turn_lark_img_001',
        fileName: 'dashboard.png',
        fileBuffer: imageBuffer,
        mimeType: 'image/png',
      });

      expect(res.success).toBe(true);
      expect(res.deliveryStatus).toBe('sent');
      expect(fakeTransport.sentReplies.length).toBe(1);
      expect(fakeTransport.sentReplies[0].msgType).toBe('image');

      const outboxRows = await channelRepo.listPendingOutbox(10, accountId);
      expect(outboxRows.length).toBe(0); // Delivered outbox item is no longer pending

      const deliveredItem = await channelRepo.findOutboxById(res.outboxItem?.id);
      expect(deliveredItem?.status).toBe('delivered');
    });

    it('deliverFile returns deliveryStatus "unknown" on network timeout and fails outbox', async () => {
      const fakeTransport = new FakeLarkTransport();
      await fakeTransport.start();
      fakeTransport.failNextSend = true;
      fakeTransport.failNextSendReason = 'Network socket timeout to Feishu OpenAPI';

      const route = await sessionRouteRepo.create({
        spaceId,
        channel: 'lark',
        accountId,
        nativeContextId: chatId,
        peerId: 'peer_user_2',
        dshSessionId: 'dsh_ses_media_002',
      });

      const gateway = new LarkChannelGateway({
        account: { id: accountId, userId, appId: 'cli_test' },
        transport: fakeTransport,
        channelRepo,
        sessionRouteRepo,
        runtimeGateway: {} as any,
      });

      const fileBuffer = Buffer.from('synthetic doc content');
      const res = await gateway.deliverFile({
        sessionId: route.id,
        chatId,
        turnId: 'turn_lark_timeout_001',
        fileName: 'contract.doc',
        fileBuffer,
        mimeType: 'application/msword',
      });

      expect(res.success).toBe(false);
      expect(res.deliveryStatus).toBe('unknown');

      const failedItem = await channelRepo.findOutboxById(res.outboxItem?.id);
      expect(failedItem?.status).toBe('failed');
    });
  });
});
