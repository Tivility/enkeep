/**
 * Tests for 04-P2: Feishu/Lark media + text short-window coalescence.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  LarkChannelGateway,
} from '../src/index.js';

describe('04-P2: Lark Media + Text Short-Window Coalescence', () => {
  let db: DatabaseSync;
  let channelRepo: SqliteTenantScopedChannelRepository;
  let sessionRouteRepo: SqliteTenantScopedSessionRouteRepository;
  let spaceRepo: SqliteTenantScopedSpaceRepository;
  let transport: FakeLarkTransport;

  const userId = 'usr_test_coalesce_01';
  const spaceId = 'spc_test_coalesce_01';
  const accountId = 'acc_test_coalesce_01';
  const botOpenId = 'ou_bot_test_01';
  const senderId = 'ou_sender_test_01';
  const chatId = 'oc_chat_test_01';

  const syntheticPng = Buffer.from(
    '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82',
    'binary'
  );

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'coalesce_user', 'hash')`).run(userId);
    db.prepare(`INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES (?, ?, 'Coalesce Space', 'spc-coalesce', 'container')`).run(spaceId, userId);

    channelRepo = new SqliteTenantScopedChannelRepository(db, userId);
    sessionRouteRepo = new SqliteTenantScopedSessionRouteRepository(db, userId);
    spaceRepo = new SqliteTenantScopedSpaceRepository(db, userId);

    await channelRepo.createAccount({
      id: accountId,
      type: 'lark',
      name: 'Coalesce Lark Account',
      appId: 'cli_test_app_01',
      appSecret: 'test_secret',
      botOpenId,
      status: 'active',
      defaultSpaceId: spaceId,
      groupActivationMode: 'always',
    });

    await channelRepo.createBinding({
      accountId,
      spaceId,
      nativeContextId: chatId,
      activationMode: 'always',
    });

    transport = new FakeLarkTransport();
    await transport.start();
  });

  afterEach(async () => {
    await transport.stop();
  });

  it('dispatches only once when text message arrives within coalescence window after image', async () => {
    const dispatchedEnvelopes: any[] = [];
    const mockRuntime: any = {
      dispatchInbound: vi.fn().mockImplementation(async (env) => {
        dispatchedEnvelopes.push(env);
        return { turnId: `turn_${env.id}`, executionMode: 'agent' };
      }),
    };

    const mockIngestor: any = {
      ingestImage: vi.fn(async ({ fileKey }: any) => ({
        path: `/attachments/${fileKey}.jpg`,
        etag: 'etag_123',
        mediaType: 'image/jpeg',
        displayName: `${fileKey}.jpg`,
      })),
      ingestFile: vi.fn(async ({ fileKey, fileName }: any) => ({
        path: `/attachments/${fileKey}`,
        etag: 'etag_123',
        mediaType: 'application/octet-stream',
        displayName: fileName || fileKey,
      })),
    };

    const gateway = new LarkChannelGateway({
      account: {
        id: accountId,
        userId,
        appId: 'cli_test_app_01',
        botOpenId,
        groupActivationMode: 'always',
      },
      transport,
      channelRepo,
      sessionRouteRepo,
      spaceRepo,
      runtimeGateway: mockRuntime,
      imageAttachmentIngestor: mockIngestor,
      coalesceWindowMs: 50,
    });

    const imageMsgId = 'om_image_001';
    const imageKey = 'img_test_key_001';
    transport.registerMockImage(imageKey, syntheticPng, 'image/png', imageMsgId);

    const imageEvent = {
      header: { event_id: 'evt_image_001', event_type: 'im.message.receive_v1', create_time: '1700000000000' },
      event: {
        sender: { sender_id: { open_id: senderId } },
        message: {
          message_id: imageMsgId,
          chat_id: chatId,
          chat_type: 'p2p',
          message_type: 'image',
          content: JSON.stringify({ image_key: imageKey }),
          create_time: '1700000000000',
        },
      },
    };

    const textMsgId = 'om_text_001';
    const textEvent = {
      header: { event_id: 'evt_text_001', event_type: 'im.message.receive_v1', create_time: '1700000000010' },
      event: {
        sender: { sender_id: { open_id: senderId } },
        message: {
          message_id: textMsgId,
          chat_id: chatId,
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: '请帮我分析这张图片' }),
          create_time: '1700000000010',
        },
      },
    };

    // 1. Send image event (should wait for window)
    const imageHandlingPromise = gateway.handleInboundEvent(imageEvent);

    // 2. Send text event within 20ms (< 50ms)
    await new Promise((r) => setTimeout(r, 20));
    const textResult = await gateway.handleInboundEvent(textEvent);

    // 3. Image handling settles as handled: true
    const imageResult = await imageHandlingPromise;
    expect(imageResult.handled).toBe(true);
    expect(textResult.handled).toBe(true);

    // 4. RuntimeGateway.dispatchInbound should be called exactly once
    expect(mockRuntime.dispatchInbound).toHaveBeenCalledTimes(1);
    expect(dispatchedEnvelopes).toHaveLength(1);

    const dispatched = dispatchedEnvelopes[0];
    expect(dispatched.content).toBe('请帮我分析这张图片');
    expect(dispatched.channelContext.replyToMessageId).toBe(textMsgId);
    expect(dispatched.attachments).toBeDefined();
    expect(dispatched.attachments).toHaveLength(1);
    expect(dispatched.attachments[0].displayName).toBe(`${imageKey}.jpg`);

    // 5. Verify image message reaction is removed
    const removedReactionIds = transport.removedReactions.map((r) => r.reactionId);
    const imageReaction = transport.addedReactions.find((r) => r.messageId === imageMsgId);
    expect(imageReaction).toBeDefined();
    expect(removedReactionIds).toContain(imageReaction!.reactionId);

    await gateway.dispose();
  });

  it('dispatches media individually when no text arrives within window', async () => {
    const dispatchedEnvelopes: any[] = [];
    const mockRuntime: any = {
      dispatchInbound: vi.fn().mockImplementation(async (env) => {
        dispatchedEnvelopes.push(env);
        return { turnId: `turn_${env.id}`, executionMode: 'agent' };
      }),
    };

    const mockIngestor: any = {
      ingestImage: vi.fn(async ({ fileKey }: any) => ({
        path: `/attachments/${fileKey}.jpg`,
        etag: 'etag_123',
        mediaType: 'image/jpeg',
        displayName: `${fileKey}.jpg`,
      })),
      ingestFile: vi.fn(async ({ fileKey, fileName }: any) => ({
        path: `/attachments/${fileKey}`,
        etag: 'etag_123',
        mediaType: 'application/octet-stream',
        displayName: fileName || fileKey,
      })),
    };

    const gateway = new LarkChannelGateway({
      account: {
        id: accountId,
        userId,
        appId: 'cli_test_app_01',
        botOpenId,
        groupActivationMode: 'always',
      },
      transport,
      channelRepo,
      sessionRouteRepo,
      spaceRepo,
      runtimeGateway: mockRuntime,
      imageAttachmentIngestor: mockIngestor,
      coalesceWindowMs: 40,
    });

    const imageMsgId = 'om_image_standalone_001';
    const imageKey = 'img_test_key_002';
    transport.registerMockImage(imageKey, syntheticPng, 'image/png', imageMsgId);

    const imageEvent = {
      header: { event_id: 'evt_image_002', event_type: 'im.message.receive_v1', create_time: '1700000000000' },
      event: {
        sender: { sender_id: { open_id: senderId } },
        message: {
          message_id: imageMsgId,
          chat_id: chatId,
          chat_type: 'p2p',
          message_type: 'image',
          content: JSON.stringify({ image_key: imageKey }),
          create_time: '1700000000000',
        },
      },
    };

    const result = await gateway.handleInboundEvent(imageEvent);
    expect(result.handled).toBe(true);

    // After window timeout, dispatched independently
    expect(mockRuntime.dispatchInbound).toHaveBeenCalledTimes(1);
    expect(dispatchedEnvelopes).toHaveLength(1);
    expect(dispatchedEnvelopes[0].channelContext.replyToMessageId).toBe(imageMsgId);
    expect(dispatchedEnvelopes[0].content).toBe('[图片]');
    expect(dispatchedEnvelopes[0].attachments).toHaveLength(1);

    await gateway.dispose();
  });

  it('merges merge_forward expanded content and attachments before subsequent text', async () => {
    const dispatchedEnvelopes: any[] = [];
    const mockRuntime: any = {
      dispatchInbound: vi.fn().mockImplementation(async (env) => {
        dispatchedEnvelopes.push(env);
        return { turnId: `turn_${env.id}`, executionMode: 'agent' };
      }),
    };

    const mockIngestor: any = {
      ingestImage: vi.fn(async ({ fileKey }: any) => ({
        path: `/attachments/${fileKey}.jpg`,
        etag: 'etag_123',
        mediaType: 'image/jpeg',
        displayName: `${fileKey}.jpg`,
      })),
      ingestFile: vi.fn(async ({ fileKey, fileName }: any) => ({
        path: `/attachments/${fileKey}`,
        etag: 'etag_123',
        mediaType: 'application/octet-stream',
        displayName: fileName || fileKey,
      })),
    };

    const gateway = new LarkChannelGateway({
      account: {
        id: accountId,
        userId,
        appId: 'cli_test_app_01',
        botOpenId,
        groupActivationMode: 'always',
      },
      transport,
      channelRepo,
      sessionRouteRepo,
      spaceRepo,
      runtimeGateway: mockRuntime,
      imageAttachmentIngestor: mockIngestor,
      coalesceWindowMs: 60,
    });

    const forwardMsgId = 'om_forward_coalesce_001';
    transport.mockMessages.set(forwardMsgId, [
      {
        message_id: 'om_sub_c01',
        msg_type: 'text',
        create_time: '1700000000000',
        sender: { name: 'Alice' },
        body: { content: JSON.stringify({ text: '讨论背景记录' }) },
      },
      {
        message_id: 'om_sub_c02',
        msg_type: 'image',
        create_time: '1700000010000',
        sender: { name: 'Bob' },
        body: { content: JSON.stringify({ image_key: 'img_forward_c01' }) },
      },
    ]);
    transport.registerMockImage('img_forward_c01', syntheticPng, 'image/png', forwardMsgId);

    const forwardEvent = {
      header: { event_id: 'evt_forward_c01', event_type: 'im.message.receive_v1', create_time: '1700000000000' },
      event: {
        sender: { sender_id: { open_id: senderId } },
        message: {
          message_id: forwardMsgId,
          chat_id: chatId,
          chat_type: 'p2p',
          message_type: 'merge_forward',
          content: 'Merged and Forwarded Message',
          create_time: '1700000000000',
        },
      },
    };

    const textMsgId = 'om_text_c02';
    const textEvent = {
      header: { event_id: 'evt_text_c02', event_type: 'im.message.receive_v1', create_time: '1700000000020' },
      event: {
        sender: { sender_id: { open_id: senderId } },
        message: {
          message_id: textMsgId,
          chat_id: chatId,
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: '请根据上面的讨论给出结论' }),
          create_time: '1700000000020',
        },
      },
    };

    const forwardPromise = gateway.handleInboundEvent(forwardEvent);
    await new Promise((r) => setTimeout(r, 20));
    const textResult = await gateway.handleInboundEvent(textEvent);
    const forwardResult = await forwardPromise;

    expect(forwardResult.handled).toBe(true);
    expect(textResult.handled).toBe(true);
    expect(mockRuntime.dispatchInbound).toHaveBeenCalledTimes(1);

    const dispatched = dispatchedEnvelopes[0];
    expect(dispatched.content).toContain('[合并转发]');
    expect(dispatched.content).toContain('讨论背景记录');
    expect(dispatched.content).toContain('请根据上面的讨论给出结论');
    expect(dispatched.content.indexOf('[合并转发]')).toBeLessThan(dispatched.content.indexOf('请根据上面的讨论给出结论'));
    expect(dispatched.attachments).toHaveLength(1);

    await gateway.dispose();
  });

  it('dispatches pending media immediately when gateway is disposed', async () => {
    const dispatchedEnvelopes: any[] = [];
    const mockRuntime: any = {
      dispatchInbound: vi.fn().mockImplementation(async (env) => {
        dispatchedEnvelopes.push(env);
        return { turnId: `turn_${env.id}`, executionMode: 'agent' };
      }),
    };

    const gateway = new LarkChannelGateway({
      account: {
        id: accountId,
        userId,
        appId: 'cli_test_app_01',
        botOpenId,
        groupActivationMode: 'always',
      },
      transport,
      channelRepo,
      sessionRouteRepo,
      spaceRepo,
      runtimeGateway: mockRuntime,
      coalesceWindowMs: 5000,
    });

    const imageMsgId = 'om_image_dispose_001';
    const imageKey = 'img_test_key_003';
    transport.registerMockImage(imageKey, syntheticPng, 'image/png', imageMsgId);

    const imageEvent = {
      header: { event_id: 'evt_image_003', event_type: 'im.message.receive_v1', create_time: '1700000000000' },
      event: {
        sender: { sender_id: { open_id: senderId } },
        message: {
          message_id: imageMsgId,
          chat_id: chatId,
          chat_type: 'p2p',
          message_type: 'image',
          content: JSON.stringify({ image_key: imageKey }),
          create_time: '1700000000000',
        },
      },
    };

    const handlingPromise = gateway.handleInboundEvent(imageEvent);
    // Give event a moment to reach pendingMedia map
    await new Promise((r) => setTimeout(r, 20));

    // Dispose gateway while media is waiting
    await gateway.dispose();

    const result = await handlingPromise;
    expect(result.handled).toBe(true);
    expect(mockRuntime.dispatchInbound).toHaveBeenCalledTimes(1);
    expect(dispatchedEnvelopes).toHaveLength(1);
    expect(dispatchedEnvelopes[0].channelContext.replyToMessageId).toBe(imageMsgId);
  });

  it('does not coalesce command messages (/stop etc.) with pending media', async () => {
    const dispatchedEnvelopes: any[] = [];
    const mockRuntime: any = {
      dispatchInbound: vi.fn().mockImplementation(async (env) => {
        dispatchedEnvelopes.push(env);
        return { turnId: `turn_${env.id}`, executionMode: 'command' };
      }),
    };

    const gateway = new LarkChannelGateway({
      account: {
        id: accountId,
        userId,
        appId: 'cli_test_app_01',
        botOpenId,
        groupActivationMode: 'always',
      },
      transport,
      channelRepo,
      sessionRouteRepo,
      spaceRepo,
      runtimeGateway: mockRuntime,
      coalesceWindowMs: 60,
    });

    const imageMsgId = 'om_image_cmd_001';
    const imageKey = 'img_test_key_cmd';
    transport.registerMockImage(imageKey, syntheticPng, 'image/png', imageMsgId);

    const imageEvent = {
      header: { event_id: 'evt_image_cmd_001', event_type: 'im.message.receive_v1', create_time: '1700000000000' },
      event: {
        sender: { sender_id: { open_id: senderId } },
        message: {
          message_id: imageMsgId,
          chat_id: chatId,
          chat_type: 'p2p',
          message_type: 'image',
          content: JSON.stringify({ image_key: imageKey }),
          create_time: '1700000000000',
        },
      },
    };

    const cmdMsgId = 'om_cmd_001';
    const cmdEvent = {
      header: { event_id: 'evt_cmd_001', event_type: 'im.message.receive_v1', create_time: '1700000000010' },
      event: {
        sender: { sender_id: { open_id: senderId } },
        message: {
          message_id: cmdMsgId,
          chat_id: chatId,
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: '/stop' }),
          create_time: '1700000000010',
        },
      },
    };

    const imagePromise = gateway.handleInboundEvent(imageEvent);
    await new Promise((r) => setTimeout(r, 10));
    const cmdResult = await gateway.handleInboundEvent(cmdEvent);
    const imageResult = await imagePromise;

    expect(cmdResult.handled).toBe(true);
    expect(imageResult.handled).toBe(true);

    // Both should be dispatched separately because /stop is a command
    expect(mockRuntime.dispatchInbound).toHaveBeenCalledTimes(2);

    await gateway.dispose();
  });
});
