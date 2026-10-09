import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { ContextTokenStore } from '../src/context-token-store.js';
import { WeChatChannelGateway } from '../src/gateway.js';
import { FakeWeChatTransport } from '../src/transport.js';
import type { WeChatChannelAccount } from '../src/gateway-types.js';

describe('B-06, B-07: WeChat Native File / Image Dispatch and Context Token Store', () => {
  let db: DatabaseSync;
  const userId = 'user_test_synthetic_01';

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
  });

  describe('B-07: ContextTokenStore reply count tracking and warning threshold', () => {
    it('tracks replyCount and triggers warning when approaching threshold', async () => {
      const warningLogs: Array<{ senderId: string; count: number; limit: number }> = [];

      const store = new ContextTokenStore({
        db,
        maxRepliesPerToken: 3,
        replyWarningThreshold: 1, // Warning at count >= (3 - 1) = 2
        onWarning: (senderId, count, limit) => {
          warningLogs.push({ senderId, count, limit });
        },
      });

      const sender = 'wx_user_test_01@im.wechat';
      await store.set(sender, 'ctx_token_synthetic_123');

      // Turn 1
      const res1 = await store.recordReply(sender);
      expect(res1.replyCount).toBe(1);
      expect(res1.isWarning).toBe(false);
      expect(res1.isLimitReached).toBe(false);
      expect(warningLogs.length).toBe(0);

      // Turn 2: Reaches warning threshold (count 2 >= 3-1)
      const res2 = await store.recordReply(sender);
      expect(res2.replyCount).toBe(2);
      expect(res2.isWarning).toBe(true);
      expect(res2.isLimitReached).toBe(false);
      expect(warningLogs.length).toBe(1);
      expect(warningLogs[0]).toEqual({ senderId: sender, count: 2, limit: 3 });

      // Turn 3: Reaches max limit
      const res3 = await store.recordReply(sender);
      expect(res3.replyCount).toBe(3);
      expect(res3.isWarning).toBe(true);
      expect(res3.isLimitReached).toBe(true);
      expect(warningLogs.length).toBe(2);
    });
  });

  describe('B-06: WeChatChannelGateway deliverFile image and file message structures', () => {
    const testAccount: WeChatChannelAccount = {
      id: 'acc_wechat_test',
      userId,
      name: 'WeChat Bot',
      status: 'active',
      defaultSpaceId: 'spc_default_space_123',
    };

    it('dispatches native image buffer to transport and returns sent status', async () => {
      const fakeTransport = new FakeWeChatTransport();
      await fakeTransport.start();

      const outboxItems: any[] = [];
      const mockChannelRepo = {
        findAccountById: vi.fn(async () => testAccount),
        createOutboxItem: vi.fn(async (item: any) => {
          const created = { ...item, id: item.id || 'out_1', attempts: 0, createdAt: new Date().toISOString() };
          outboxItems.push(created);
          return created;
        }),
        updateOutboxStatus: vi.fn(async (id: string, status: string) => {
          const item = outboxItems.find((o) => o.id === id);
          if (item) item.status = status;
          return item || { id, status };
        }),
      };

      const mockSessionRouteRepo = {
        findById: vi.fn(async () => ({
          id: 'ses_wechat_001',
          nativeContextId: 'test-user@im.wechat',
          peerId: 'test-user@im.wechat',
        })),
      };

      const contextTokenStore = new ContextTokenStore({ db });
      await contextTokenStore.set('test-user@im.wechat', 'ctx_tok_image_test');

      const gateway = new WeChatChannelGateway({
        account: testAccount,
        transport: fakeTransport,
        channelRepo: mockChannelRepo as any,
        sessionRouteRepo: mockSessionRouteRepo as any,
        runtimeGateway: {} as any,
        contextTokenStore,
      });

      const imageBuffer = Buffer.from('synthetic png bytes');
      const result = await gateway.deliverFile({
        sessionId: 'ses_wechat_001',
        turnId: 'turn_img_001',
        fileName: 'chart.png',
        fileBuffer: imageBuffer,
        mimeType: 'image/png',
      });

      expect(result.success).toBe(true);
      expect(result.deliveryStatus).toBe('sent');
      expect(fakeTransport.sentReplies.length).toBe(1);
      expect(fakeTransport.sentReplies[0].text).toContain('[Image: chart.png]');
    });

    it('dispatches native document file buffer to transport and returns sent status', async () => {
      const fakeTransport = new FakeWeChatTransport();
      await fakeTransport.start();

      const outboxItems: any[] = [];
      const mockChannelRepo = {
        findAccountById: vi.fn(async () => testAccount),
        createOutboxItem: vi.fn(async (item: any) => {
          const created = { ...item, id: item.id || 'out_2', attempts: 0, createdAt: new Date().toISOString() };
          outboxItems.push(created);
          return created;
        }),
        updateOutboxStatus: vi.fn(async (id: string, status: string) => {
          const item = outboxItems.find((o) => o.id === id);
          if (item) item.status = status;
          return item || { id, status };
        }),
      };

      const mockSessionRouteRepo = {
        findById: vi.fn(async () => ({
          id: 'ses_wechat_002',
          nativeContextId: 'test-user@im.wechat',
          peerId: 'test-user@im.wechat',
        })),
      };

      const contextTokenStore = new ContextTokenStore({ db });
      await contextTokenStore.set('test-user@im.wechat', 'ctx_tok_file_test');

      const gateway = new WeChatChannelGateway({
        account: testAccount,
        transport: fakeTransport,
        channelRepo: mockChannelRepo as any,
        sessionRouteRepo: mockSessionRouteRepo as any,
        runtimeGateway: {} as any,
        contextTokenStore,
      });

      const fileBuffer = Buffer.from('synthetic pdf bytes');
      const result = await gateway.deliverFile({
        sessionId: 'ses_wechat_002',
        turnId: 'turn_doc_001',
        fileName: 'summary.pdf',
        fileBuffer,
        mimeType: 'application/pdf',
      });

      expect(result.success).toBe(true);
      expect(result.deliveryStatus).toBe('sent');
      expect(fakeTransport.sentReplies.length).toBe(1);
      expect(fakeTransport.sentReplies[0].text).toContain('[File: summary.pdf]');
    });

    it('returns deliveryStatus "unknown" on network timeout and does not treat as deterministic failure', async () => {
      const fakeTransport = new FakeWeChatTransport();
      await fakeTransport.start();
      fakeTransport.failNextSend = true;
      fakeTransport.failNextSendReason = 'Network connection timeout to WeChat gateway';

      const outboxItems: any[] = [];
      const mockChannelRepo = {
        findAccountById: vi.fn(async () => testAccount),
        createOutboxItem: vi.fn(async (item: any) => {
          const created = { ...item, id: item.id || 'out_3', attempts: 0, createdAt: new Date().toISOString() };
          outboxItems.push(created);
          return created;
        }),
        updateOutboxStatus: vi.fn(async (id: string, status: string) => {
          const item = outboxItems.find((o) => o.id === id);
          if (item) item.status = status;
          return item || { id, status };
        }),
      };

      const mockSessionRouteRepo = {
        findById: vi.fn(async () => ({
          id: 'ses_wechat_003',
          nativeContextId: 'test-user@im.wechat',
          peerId: 'test-user@im.wechat',
        })),
      };

      const contextTokenStore = new ContextTokenStore({ db });
      await contextTokenStore.set('test-user@im.wechat', 'ctx_tok_timeout_test');

      const gateway = new WeChatChannelGateway({
        account: testAccount,
        transport: fakeTransport,
        channelRepo: mockChannelRepo as any,
        sessionRouteRepo: mockSessionRouteRepo as any,
        runtimeGateway: {} as any,
        contextTokenStore,
      });

      const result = await gateway.deliverFile({
        sessionId: 'ses_wechat_003',
        turnId: 'turn_timeout_001',
        fileName: 'chart.png',
        fileBuffer: Buffer.from('img bytes'),
        mimeType: 'image/png',
      });

      expect(result.success).toBe(false);
      expect(result.deliveryStatus).toBe('unknown');
    });
  });
});
