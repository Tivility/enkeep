/**
 * WeChat Channel Gateway & ContextTokenStore Unit Tests
 *
 * @module @enkeep/channel-wechat/tests/gateway.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  ContextTokenStore,
  WeChatChannelGateway,
  FakeWeChatTransport,
  type WeChatChannelAccount,
  type WeChatChannelBinding,
  type WeChatChannelInboxItem,
  type WeChatChannelOutboxItem,
  type WeChatChannelRepo,
  type WeChatInboundEnvelope,
  type WeChatParsedMessage,
  type WeChatRuntimeGateway,
  type WeChatSessionRoute,
  type WeChatSessionRouteRepo,
  type WeChatSpaceRepo,
} from '../src/index.js';

describe('ContextTokenStore', () => {
  it('stores and retrieves tokens from L1 memory cache', async () => {
    const store = new ContextTokenStore({ maxCapacity: 10, ttlMs: 10000 });
    await store.set('user_123', 'ctx_tok_123');

    const token = await store.get('user_123');
    expect(token).toBe('ctx_tok_123');
    expect(await store.has('user_123')).toBe(true);
    expect(await store.get('non_existent')).toBeUndefined();
  });

  it('evicts oldest entry when maxCapacity is exceeded (LRU)', async () => {
    const store = new ContextTokenStore({ maxCapacity: 2, ttlMs: 10000 });
    await store.set('user_1', 'tok_1');
    await store.set('user_2', 'tok_2');
    expect(store.size).toBe(2);

    // Access user_1 to refresh its recency
    await store.get('user_1');

    // Add user_3 -> should evict user_2
    await store.set('user_3', 'tok_3');
    expect(store.size).toBe(2);
    expect(await store.get('user_1')).toBe('tok_1');
    expect(await store.get('user_3')).toBe('tok_3');
    expect(await store.get('user_2')).toBeUndefined();
  });

  it('expires entries after ttlMs', async () => {
    const store = new ContextTokenStore({ maxCapacity: 10, ttlMs: 20 });
    await store.set('user_short', 'tok_short');
    expect(await store.get('user_short')).toBe('tok_short');

    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(await store.get('user_short')).toBeUndefined();
  });

  it('persists and restores tokens from SQLite (L2)', async () => {
    const db = new DatabaseSync(':memory:');
    const store1 = new ContextTokenStore({ db, ttlMs: 60000 });

    await store1.set('wx_alice', 'ctx_alice_secret_token');
    expect(await store1.get('wx_alice')).toBe('ctx_alice_secret_token');

    // Create a new store instance pointing to same db (simulating process restart)
    const store2 = new ContextTokenStore({ db, ttlMs: 60000 });
    expect(store2.size).toBe(0); // L1 empty

    const restoredToken = await store2.get('wx_alice');
    expect(restoredToken).toBe('ctx_alice_secret_token');
    expect(store2.size).toBe(1); // L1 populated from L2
  });

  it('falls back to channel_inbox payload when L2 table misses', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE channel_inbox (
        id TEXT PRIMARY KEY,
        account_id TEXT,
        native_context_id TEXT,
        payload_json TEXT,
        created_at TEXT DEFAULT (CURRENT_TIMESTAMP)
      );
    `);

    // Insert historical inbox item with contextToken
    db.prepare(`
      INSERT INTO channel_inbox (id, account_id, native_context_id, payload_json)
      VALUES ('inb_1', 'acc_1', 'wechat:bob', ?)
    `).run(
      JSON.stringify({
        parsed: {
          senderId: 'bob',
          contextToken: 'ctx_bob_from_inbox',
        },
      })
    );

    const store = new ContextTokenStore({ db });
    const token = await store.get('bob');
    expect(token).toBe('ctx_bob_from_inbox');
  });
});

describe('WeChatChannelGateway', () => {
  let fakeTransport: FakeWeChatTransport;
  let mockChannelRepo: WeChatChannelRepo;
  let mockSessionRouteRepo: WeChatSessionRouteRepo;
  let mockSpaceRepo: WeChatSpaceRepo;
  let mockRuntimeGateway: WeChatRuntimeGateway;
  let contextTokenStore: ContextTokenStore;

  const testAccount: WeChatChannelAccount = {
    id: 'acc_wechat_001',
    userId: 'usr_owner_001',
    type: 'wechat',
    status: 'active',
    defaultSpaceId: 'spc_default_001',
  };

  const sampleParsedMessage: WeChatParsedMessage = {
    messageId: 'msg_wc_in_001',
    senderId: 'wx_user_carol',
    senderName: 'Carol',
    chatId: 'wx_user_carol',
    contextToken: 'ctx_carol_token_abc',
    text: 'Hello Enkeep!',
    timestamp: new Date().toISOString(),
    dedupKey: 'mid:msg_wc_in_001',
    isFromBot: false,
  };

  beforeEach(() => {
    fakeTransport = new FakeWeChatTransport();
    fakeTransport.start();

    const inboxMap = new Map<string, WeChatChannelInboxItem>();
    const outboxMap = new Map<string, WeChatChannelOutboxItem>();
    const bindingMap = new Map<string, WeChatChannelBinding>();
    const routeMap = new Map<string, WeChatSessionRoute>();

    mockChannelRepo = {
      findAccountById: vi.fn(async (id: string) => (id === testAccount.id ? testAccount : null)),
      findBindingByContext: vi.fn(async (_accountId: string, ctxId: string) => bindingMap.get(ctxId) || null),
      createBinding: vi.fn(async (input) => {
        const binding: WeChatChannelBinding = {
          id: `bind_${Math.random().toString(36).slice(2, 8)}`,
          userId: testAccount.userId,
          accountId: input.accountId,
          spaceId: input.spaceId,
          nativeContextId: input.nativeContextId,
          activationMode: input.activationMode,
          chatType: input.chatType,
        };
        bindingMap.set(input.nativeContextId, binding);
        return binding;
      }),
      findInboxByEvent: vi.fn(async (_accountId: string, eventId: string) => inboxMap.get(eventId) || null),
      createInboxItem: vi.fn(async (input) => {
        const existing = inboxMap.get(input.nativeEventId);
        if (existing) {
          return { item: existing, isDuplicate: true };
        }
        const item: WeChatChannelInboxItem = {
          id: `inb_${Math.random().toString(36).slice(2, 8)}`,
          accountId: input.accountId,
          nativeEventId: input.nativeEventId,
          nativeContextId: input.nativeContextId,
          payloadJson: input.payloadJson,
          status: input.status,
        };
        inboxMap.set(input.nativeEventId, item);
        return { item, isDuplicate: false };
      }),
      claimInboxForProcessing: vi.fn(async (id: string) => {
        for (const item of inboxMap.values()) {
          if (item.id === id) {
            const updated: WeChatChannelInboxItem = { ...item, status: 'processing' };
            inboxMap.set(item.nativeEventId, updated);
            return updated;
          }
        }
        return null;
      }),
      updateInboxStatus: vi.fn(async (id: string, status: any) => {
        for (const [key, item] of inboxMap.entries()) {
          if (item.id === id) {
            const updated: WeChatChannelInboxItem = { ...item, status };
            inboxMap.set(key, updated);
            return updated;
          }
        }
        throw new Error('Inbox item not found');
      }),
      findOutboxById: vi.fn(async (id: string) => outboxMap.get(id) || null),
      createOutboxItem: vi.fn(async (input) => {
        const item: WeChatChannelOutboxItem = {
          id: input.id || `out_${Math.random().toString(36).slice(2, 8)}`,
          accountId: input.accountId,
          sessionId: input.sessionId,
          nativeContextId: input.nativeContextId,
          replyToNativeId: input.replyToNativeId,
          payloadJson: input.payloadJson,
          status: input.status || 'pending',
          attempts: 0,
        };
        outboxMap.set(item.id, item);
        return item;
      }),
      updateOutboxStatus: vi.fn(async (id: string, status: any, incrementAttempt?: boolean) => {
        const existing = outboxMap.get(id);
        if (!existing) throw new Error('Outbox item not found');
        const updated: WeChatChannelOutboxItem = {
          ...existing,
          status,
          attempts: incrementAttempt ? (existing.attempts || 0) + 1 : existing.attempts,
        };
        outboxMap.set(id, updated);
        return updated;
      }),
    };

    mockSessionRouteRepo = {
      findById: vi.fn(async (id: string) => routeMap.get(id) || null),
      findByRouteIdentity: vi.fn(async (_ch, _acc, ctxId) => routeMap.get(ctxId) || null),
      create: vi.fn(async (input) => {
        const route: WeChatSessionRoute = {
          id: `ses_route_${Math.random().toString(36).slice(2, 8)}`,
          spaceId: input.spaceId,
          channel: input.channel,
          accountId: input.accountId,
          nativeContextId: input.nativeContextId,
          peerId: input.peerId,
          title: input.title,
        };
        routeMap.set(route.id, route);
        routeMap.set(input.nativeContextId, route);
        return route;
      }),
    };

    mockSpaceRepo = {
      findById: vi.fn(async (id: string) => ({ id, status: 'active' })),
    };

    mockRuntimeGateway = {
      dispatchInbound: vi.fn(async (_envelope: WeChatInboundEnvelope) => ({
        turnId: `turn_${Date.now()}`,
        executionMode: 'runtime',
        status: 'accepted',
      })),
    };

    contextTokenStore = new ContextTokenStore();
  });

  it('processes inbound text message, auto-binds default space, caches token, and dispatches to runtime', async () => {
    const gateway = new WeChatChannelGateway({
      account: testAccount,
      transport: fakeTransport,
      channelRepo: mockChannelRepo,
      sessionRouteRepo: mockSessionRouteRepo,
      spaceRepo: mockSpaceRepo,
      runtimeGateway: mockRuntimeGateway,
      contextTokenStore,
    });

    const result = await gateway.handleInboundMessage(sampleParsedMessage);

    expect(result.handled).toBe(true);
    expect(result.inboxItem?.status).toBe('delivered');
    expect(result.turnId).toBeDefined();

    // Verify context_token was cached
    const cachedToken = await contextTokenStore.get('wx_user_carol');
    expect(cachedToken).toBe('ctx_carol_token_abc');

    // Verify runtime dispatch envelope
    expect(mockRuntimeGateway.dispatchInbound).toHaveBeenCalledTimes(1);
    const envelope = (mockRuntimeGateway.dispatchInbound as any).mock.calls[0][0];
    expect(envelope.content).toBe('Hello Enkeep!');
    expect(envelope.userId).toBe(testAccount.userId);
    expect(envelope.channelContext.channel).toBe('wechat');
    expect(envelope.channelContext.accountId).toBe(testAccount.id);

    // Verify channel binding was auto-created with activationMode: 'always' (p2p exemption)
    expect(mockChannelRepo.createBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: testAccount.id,
        spaceId: testAccount.defaultSpaceId,
        nativeContextId: 'wechat:wx_user_carol',
        activationMode: 'always',
        chatType: 'p2p',
      })
    );
  });

  it('handles inbound image message and falls back to placeholder content', async () => {
    const gateway = new WeChatChannelGateway({
      account: testAccount,
      transport: fakeTransport,
      channelRepo: mockChannelRepo,
      sessionRouteRepo: mockSessionRouteRepo,
      spaceRepo: mockSpaceRepo,
      runtimeGateway: mockRuntimeGateway,
      contextTokenStore,
    });

    const imageMessage: WeChatParsedMessage = {
      ...sampleParsedMessage,
      messageId: 'msg_img_002',
      text: '', // Empty text
      mediaItems: [
        {
          type: 'image',
          encryptQueryParam: 'novac2c_param_123',
          aesKey: '0123456789abcdef0123456789abcdef',
        },
      ],
    };

    const result = await gateway.handleInboundMessage(imageMessage);
    expect(result.handled).toBe(true);

    const envelope = (mockRuntimeGateway.dispatchInbound as any).mock.calls[0][0];
    expect(envelope.content).toBe('[图片]');
  });

  it('deduplicates duplicate inbound messages', async () => {
    const gateway = new WeChatChannelGateway({
      account: testAccount,
      transport: fakeTransport,
      channelRepo: mockChannelRepo,
      sessionRouteRepo: mockSessionRouteRepo,
      spaceRepo: mockSpaceRepo,
      runtimeGateway: mockRuntimeGateway,
      contextTokenStore,
    });

    // First arrival
    const result1 = await gateway.handleInboundMessage(sampleParsedMessage);
    expect(result1.handled).toBe(true);

    // Duplicate arrival
    const result2 = await gateway.handleInboundMessage(sampleParsedMessage);
    expect(result2.handled).toBe(false);
    expect(result2.ignoredReason).toBe('duplicate_event');
    expect(mockRuntimeGateway.dispatchInbound).toHaveBeenCalledTimes(1);
  });

  it('ignores inbound messages when account is disabled', async () => {
    const disabledAccount = { ...testAccount, status: 'disabled' };
    mockChannelRepo.findAccountById = vi.fn(async () => disabledAccount);

    const gateway = new WeChatChannelGateway({
      account: disabledAccount,
      transport: fakeTransport,
      channelRepo: mockChannelRepo,
      sessionRouteRepo: mockSessionRouteRepo,
      spaceRepo: mockSpaceRepo,
      runtimeGateway: mockRuntimeGateway,
      contextTokenStore,
    });

    const result = await gateway.handleInboundMessage(sampleParsedMessage);
    expect(result.handled).toBe(false);
    expect(result.ignoredReason).toBe('account_disabled');
    expect(mockRuntimeGateway.dispatchInbound).not.toHaveBeenCalled();
  });

  it('completes agent turn and delivers outbound reply using cached context_token', async () => {
    const gateway = new WeChatChannelGateway({
      account: testAccount,
      transport: fakeTransport,
      channelRepo: mockChannelRepo,
      sessionRouteRepo: mockSessionRouteRepo,
      spaceRepo: mockSpaceRepo,
      runtimeGateway: mockRuntimeGateway,
      contextTokenStore,
    });

    // 1. Process inbound to establish route and cache context_token
    const inboundResult = await gateway.handleInboundMessage(sampleParsedMessage);
    const sessionRouteId = inboundResult.sessionRouteId!;
    expect(sessionRouteId).toBeDefined();

    // 2. Trigger turn completed
    const outboxItem = await gateway.handleTurnCompleted({
      sessionId: sessionRouteId,
      turnId: 'turn_finish_001',
      replyText: 'Hello Carol! This is assistant replying via WeChat.',
      nativeEventId: sampleParsedMessage.messageId,
    });

    expect(outboxItem).toBeDefined();
    expect(outboxItem?.status).toBe('delivered');

    // Verify reply in fakeTransport
    expect(fakeTransport.sentReplies.length).toBe(1);
    const reply = fakeTransport.sentReplies[0];
    expect(reply.toUserId).toBe('wx_user_carol');
    expect(reply.contextToken).toBe('ctx_carol_token_abc');
    expect(reply.text).toBe('Hello Carol! This is assistant replying via WeChat.');
  });

  it('records outbox failure when context_token is missing', async () => {
    const emptyContextStore = new ContextTokenStore();
    const gateway = new WeChatChannelGateway({
      account: testAccount,
      transport: fakeTransport,
      channelRepo: mockChannelRepo,
      sessionRouteRepo: mockSessionRouteRepo,
      spaceRepo: mockSpaceRepo,
      runtimeGateway: mockRuntimeGateway,
      contextTokenStore: emptyContextStore,
    });

    const route = await mockSessionRouteRepo.create({
      spaceId: 'spc_default_001',
      channel: 'wechat',
      accountId: testAccount.id,
      nativeContextId: 'wechat:unknown_user',
      peerId: 'unknown_user',
    });

    const outboxItem = await gateway.handleTurnCompleted({
      sessionId: route.id,
      turnId: 'turn_no_token',
      replyText: 'Should fail due to missing context_token',
    });

    expect(outboxItem).toBeDefined();
    expect(outboxItem?.status).toBe('failed');
    expect(fakeTransport.sentReplies.length).toBe(0);
  });

  describe('Inbound Media Ingestion (WF3)', () => {
    const rawKey = Buffer.alloc(16, 0x42);
    const aesKeyBase64 = rawKey.toString('base64');
    const imagePayload = Buffer.from('fake-image-png-binary-content-12345');
    const filePayload = Buffer.from('fake-file-pdf-binary-content-67890');

    it('downloads, decrypts, and ingests inbound image attachment via mediaAttachmentIngestor', async () => {
      const { encryptAesEcb } = await import('../src/crypto.js');
      const ciphertext = encryptAesEcb(imagePayload, rawKey);

      const mockFetch = vi.fn(async () => {
        return new Response(ciphertext, {
          status: 200,
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(ciphertext.length),
          },
        });
      });

      const mockIngestor = {
        ingestImage: vi.fn(async ({ fileKey }: any) => ({
          path: `.attachments/incoming/${fileKey}.jpg`,
          etag: `"${fileKey}_etag"`,
          mediaType: 'image/jpeg',
          displayName: `${fileKey}.jpg`,
        })),
      };

      const gateway = new WeChatChannelGateway({
        account: testAccount,
        transport: fakeTransport,
        channelRepo: mockChannelRepo,
        sessionRouteRepo: mockSessionRouteRepo,
        spaceRepo: mockSpaceRepo,
        runtimeGateway: mockRuntimeGateway,
        contextTokenStore,
        mediaAttachmentIngestor: mockIngestor,
        fetchFn: mockFetch as any,
      });

      const imageMsg: WeChatParsedMessage = {
        ...sampleParsedMessage,
        messageId: 'msg_img_100',
        text: '',
        mediaItems: [
          {
            type: 'image',
            encryptQueryParam: 'cdn_enc_param_100',
            aesKey: aesKeyBase64,
          },
        ],
      };

      const result = await gateway.handleInboundMessage(imageMsg);
      expect(result.handled).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockIngestor.ingestImage).toHaveBeenCalledTimes(1);

      const envelope = (mockRuntimeGateway.dispatchInbound as any).mock.calls.at(-1)[0];
      expect(envelope.content).toBe('[图片]');
      expect(envelope.attachments).toBeDefined();
      expect(envelope.attachments.length).toBe(1);
      expect(envelope.attachments[0]).toMatchObject({
        type: 'image',
        path: expect.stringContaining('.attachments/incoming/'),
        etag: expect.any(String),
        mediaType: 'image/jpeg',
      });
    });

    it('downloads, decrypts, and ingests inbound file attachment via mediaAttachmentIngestor', async () => {
      const { encryptAesEcb } = await import('../src/crypto.js');
      const ciphertext = encryptAesEcb(filePayload, rawKey);

      const mockFetch = vi.fn(async () => {
        return new Response(ciphertext, {
          status: 200,
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(ciphertext.length),
          },
        });
      });

      const mockIngestor = {
        ingestImage: vi.fn(async () => {
          throw new Error('Not an image');
        }),
        ingestFile: vi.fn(async ({ fileName, fileKey }: any) => ({
          path: `.attachments/incoming/${fileKey}.pdf`,
          etag: `"${fileKey}_etag"`,
          mediaType: 'application/pdf',
          displayName: fileName || 'doc.pdf',
        })),
      };

      const gateway = new WeChatChannelGateway({
        account: testAccount,
        transport: fakeTransport,
        channelRepo: mockChannelRepo,
        sessionRouteRepo: mockSessionRouteRepo,
        spaceRepo: mockSpaceRepo,
        runtimeGateway: mockRuntimeGateway,
        contextTokenStore,
        mediaAttachmentIngestor: mockIngestor,
        fetchFn: mockFetch as any,
      });

      const fileMsg: WeChatParsedMessage = {
        ...sampleParsedMessage,
        messageId: 'msg_file_200',
        text: '',
        mediaItems: [
          {
            type: 'file',
            name: 'quarterly_report.pdf',
            encryptQueryParam: 'cdn_enc_param_file_200',
            aesKey: aesKeyBase64,
          },
        ],
      };

      const result = await gateway.handleInboundMessage(fileMsg);
      expect(result.handled).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockIngestor.ingestFile).toHaveBeenCalledTimes(1);

      const envelope = (mockRuntimeGateway.dispatchInbound as any).mock.calls.at(-1)[0];
      expect(envelope.content).toBe('[文件: quarterly_report.pdf]');
      expect(envelope.attachments).toBeDefined();
      expect(envelope.attachments.length).toBe(1);
      expect(envelope.attachments[0]).toMatchObject({
        type: 'file',
        displayName: 'quarterly_report.pdf',
        mediaType: 'application/pdf',
      });
    });

    it('falls back to text placeholder when image exceeds size limit (>20MB)', async () => {
      const mockFetch = vi.fn(async () => {
        return new Response('dummy', {
          status: 200,
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(25 * 1024 * 1024), // 25 MiB > 20 MiB limit
          },
        });
      });

      const mockIngestor = {
        ingestImage: vi.fn(),
      };

      const gateway = new WeChatChannelGateway({
        account: testAccount,
        transport: fakeTransport,
        channelRepo: mockChannelRepo,
        sessionRouteRepo: mockSessionRouteRepo,
        spaceRepo: mockSpaceRepo,
        runtimeGateway: mockRuntimeGateway,
        contextTokenStore,
        mediaAttachmentIngestor: mockIngestor,
        fetchFn: mockFetch as any,
      });

      const imageMsg: WeChatParsedMessage = {
        ...sampleParsedMessage,
        messageId: 'msg_img_toolarge',
        text: '',
        mediaItems: [
          {
            type: 'image',
            encryptQueryParam: 'cdn_enc_param_huge',
            aesKey: aesKeyBase64,
          },
        ],
      };

      const result = await gateway.handleInboundMessage(imageMsg);
      expect(result.handled).toBe(true);
      expect(mockIngestor.ingestImage).not.toHaveBeenCalled();

      const envelope = (mockRuntimeGateway.dispatchInbound as any).mock.calls.at(-1)[0];
      expect(envelope.content).toBe('[图片]');
      expect(envelope.attachments).toBeUndefined();
    });

    it('falls back to text placeholder gracefully when download or decryption fails', async () => {
      const mockFetch = vi.fn(async () => {
        return new Response('Not Found on CDN', { status: 404 });
      });

      const mockIngestor = {
        ingestImage: vi.fn(),
      };

      const gateway = new WeChatChannelGateway({
        account: testAccount,
        transport: fakeTransport,
        channelRepo: mockChannelRepo,
        sessionRouteRepo: mockSessionRouteRepo,
        spaceRepo: mockSpaceRepo,
        runtimeGateway: mockRuntimeGateway,
        contextTokenStore,
        mediaAttachmentIngestor: mockIngestor,
        fetchFn: mockFetch as any,
      });

      const imageMsg: WeChatParsedMessage = {
        ...sampleParsedMessage,
        messageId: 'msg_img_error',
        text: '',
        mediaItems: [
          {
            type: 'image',
            encryptQueryParam: 'cdn_enc_param_err',
            aesKey: aesKeyBase64,
          },
        ],
      };

      const result = await gateway.handleInboundMessage(imageMsg);
      expect(result.handled).toBe(true);
      expect(mockIngestor.ingestImage).not.toHaveBeenCalled();

      const envelope = (mockRuntimeGateway.dispatchInbound as any).mock.calls.at(-1)[0];
      expect(envelope.content).toBe('[图片]');
      expect(envelope.attachments).toBeUndefined();
    });

    it('falls back to text placeholder gracefully when ingestImage throws', async () => {
      const { encryptAesEcb } = await import('../src/crypto.js');
      const ciphertext = encryptAesEcb(imagePayload, rawKey);

      const mockFetch = vi.fn(async () => {
        return new Response(ciphertext, {
          status: 200,
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(ciphertext.length),
          },
        });
      });

      const mockIngestor = {
        ingestImage: vi.fn(async () => {
          throw new Error('Disk full or storage failure');
        }),
      };

      const gateway = new WeChatChannelGateway({
        account: testAccount,
        transport: fakeTransport,
        channelRepo: mockChannelRepo,
        sessionRouteRepo: mockSessionRouteRepo,
        spaceRepo: mockSpaceRepo,
        runtimeGateway: mockRuntimeGateway,
        contextTokenStore,
        mediaAttachmentIngestor: mockIngestor,
        fetchFn: mockFetch as any,
      });

      const imageMsg: WeChatParsedMessage = {
        ...sampleParsedMessage,
        messageId: 'msg_img_ingest_fail',
        text: '',
        mediaItems: [
          {
            type: 'image',
            encryptQueryParam: 'cdn_enc_param_fail',
            aesKey: aesKeyBase64,
          },
        ],
      };

      const result = await gateway.handleInboundMessage(imageMsg);
      expect(result.handled).toBe(true);
      expect(mockIngestor.ingestImage).toHaveBeenCalledTimes(1);

      const envelope = (mockRuntimeGateway.dispatchInbound as any).mock.calls.at(-1)[0];
      expect(envelope.content).toBe('[图片]');
      expect(envelope.attachments).toBeUndefined();
    });
  });
});
