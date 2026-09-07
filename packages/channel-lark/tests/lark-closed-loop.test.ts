import { describe, it, expect, beforeEach, vi } from 'vitest';
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
  DeliveryRuntimeGateway,
  type DeliveryTurnExecutor,
} from '../../platform-server/src/runtime/delivery-gateway.js';
import {
  SqliteWebMessageStore,
} from '../../platform-server/src/storage/web-messages.js';
import {
  ChannelRuntimeManager,
} from '../../platform-server/src/channels/channel-runtime-manager.js';
import {
  FakeLarkTransport,
  CredentialedLarkTransport,
  LarkChannelGateway,
  REAL_LARK_CREDENTIAL_ACCEPTANCE,
  REAL_LARK_CREDENTIAL_SKIP_REASON,
  type StreamEventSource,
  parseLarkEvent,
  buildNativeContextId,
  messageMentionsBot,
  stripLeadingMentions,
  extractPostAtParticipants,
} from '../src/index.js';

describe('Lark Channel Closed-Loop Communication', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let messageStore: SqliteWebMessageStore;
  let channelRepo: SqliteTenantScopedChannelRepository;
  let sessionRouteRepo: SqliteTenantScopedSessionRouteRepository;
  let spaceRepo: SqliteTenantScopedSpaceRepository;
  let transport: FakeLarkTransport;
  let gateway: LarkChannelGateway;
  let runtimeGateway: DeliveryRuntimeGateway;
  let runtimeManager: ChannelRuntimeManager;

  const userId = 'usr_lark_owner_1';
  const spaceId = 'spc_lark_space_1';
  const botAppId = 'cli_a1b2c3d4e5f6';
  const botOpenId = 'ou_bot_1234567890';

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'lark_owner', 'hash')`).run(userId);
    db.prepare(`INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES (?, ?, 'Lark Space', 'lark-space', 'container')`).run(spaceId, userId);

    storage = new SqlitePlatformStorage(db);
    messageStore = new SqliteWebMessageStore(db);
    channelRepo = new SqliteTenantScopedChannelRepository(db, userId);
    sessionRouteRepo = new SqliteTenantScopedSessionRouteRepository(db, userId);
    spaceRepo = new SqliteTenantScopedSpaceRepository(db, userId);

    // Deterministic Executor
    const deterministicExecutor: DeliveryTurnExecutor = {
      execute: async (req) => ({
        replyText: `Executed reply to: ${req.content}`,
        usage: { totalTokens: 25 },
      }),
      cancel: async () => true,
    };

    runtimeGateway = new DeliveryRuntimeGateway({
      database: db,
      storage,
      messageStore,
      executor: deterministicExecutor,
      quotaMode: 'disabled',
      profileResolver: { resolve: async () => null },
    });

    transport = new FakeLarkTransport();
    await transport.start();

    // Create channel account
    const account = await channelRepo.createAccount({
      type: 'lark',
      status: 'active',
      credentialRef: 'cred_ref_lark_demo',
    });

    runtimeManager = new ChannelRuntimeManager({
      storage,
      db,
      deliveryGateway: runtimeGateway,
      transportFactory: () => transport,
    });

    await runtimeManager.start();

    gateway = runtimeManager.getActiveGateway(userId, account.id)!;
    expect(gateway).toBeDefined();
    (gateway.account as any).appId = botAppId;
    (gateway.account as any).botOpenId = botOpenId;
  });

  describe('1. Inbound Event to Outbound Agent Reply Delivery Closed-Loop', () => {
    it('simulates inbound Lark WS event, parses content, routes session, and delivers plain text reply', async () => {
      // 1. Setup binding for chat
      const chatId = 'oc_test_chat_1';
      await channelRepo.createBinding({
        accountId: gateway.accountId,
        spaceId,
        nativeContextId: chatId,
        activationMode: 'always',
      });

      // 2. Inbound Lark Event
      const rawEvent = {
        header: {
          event_id: 'evt_inbound_001',
          event_type: 'im.message.receive_v1',
          create_time: '1700000000000',
        },
        event: {
          sender: {
            sender_id: { open_id: 'ou_human_sender_1' },
            sender_type: 'user',
          },
          message: {
            message_id: 'om_human_msg_1',
            chat_id: chatId,
            chat_type: 'group',
            message_type: 'text',
            content: JSON.stringify({ text: 'Hello Enkeep Assistant!' }),
            create_time: '1700000000000',
          },
        },
      };

      // 3. Dispatch through transport
      const res = await gateway.handleInboundEvent(rawEvent);
      expect(res.handled).toBe(true);

      // Drain execution queue
      await runtimeGateway.drain();

      // 5. Verify session route created
      const route = await sessionRouteRepo.findById(res.sessionRouteId!);
      expect(route).not.toBeNull();
      expect(route?.channel).toBe('lark');
      expect(route?.accountId).toBe(gateway.accountId);
      expect(route?.nativeContextId).toBe(chatId);

      // 6. Verify durable channel inbox item delivered
      const inboxItem = await channelRepo.findInboxByEvent(gateway.accountId, 'evt_inbound_001');
      expect(inboxItem).not.toBeNull();
      expect(inboxItem?.status).toBe('delivered');

      // 7. Verify FakeLarkTransport received reply
      expect(transport.sentReplies.length).toBe(1);
      const sent = transport.sentReplies[0];
      expect(sent.chatId).toBe(chatId);
      expect(sent.replyToMessageId).toBe('om_human_msg_1');
      expect(sent.content).toBe('Executed reply to: Hello Enkeep Assistant!');
      expect(sent.format).toBe('plain');
    });
  });

  describe('2. Durable Channel Inbox Idempotency & Duplicate Events', () => {
    it('detects duplicate events, processes only once, and skips second agent execution', async () => {
      const chatId = 'oc_idemp_chat_1';
      await channelRepo.createBinding({
        accountId: gateway.accountId,
        spaceId,
        nativeContextId: chatId,
        activationMode: 'always',
      });

      const rawEvent = {
        header: {
          event_id: 'evt_idemp_duplicate_test',
          event_type: 'im.message.receive_v1',
          create_time: '1700000000000',
        },
        event: {
          sender: {
            sender_id: { open_id: 'ou_human_1' },
            sender_type: 'user',
          },
          message: {
            message_id: 'om_msg_dup_1',
            chat_id: chatId,
            chat_type: 'group',
            message_type: 'text',
            content: JSON.stringify({ text: 'Execute this exact prompt' }),
            create_time: '1700000000000',
          },
        },
      };

      // Send first time
      const res1 = await gateway.handleInboundEvent(rawEvent);
      expect(res1.handled).toBe(true);
      await runtimeGateway.drain();
      expect(transport.sentReplies.length).toBe(1);

      // Send identical event again (network replay / WS re-delivery)
      const res2 = await gateway.handleInboundEvent(rawEvent);
      expect(res2.handled).toBe(false);
      expect(res2.ignoredReason).toBe('duplicate_event');

      await runtimeGateway.drain();
      expect(transport.sentReplies.length).toBe(1);
    });
  });

  describe('3. Mention Gating in Group Chats', () => {
    it('ignores group messages when bot is not mentioned in mention mode', async () => {
      const chatId = 'oc_gated_group_1';
      await channelRepo.createBinding({
        accountId: gateway.accountId,
        spaceId,
        nativeContextId: chatId,
        activationMode: 'mention',
      });

      // Event where someone else is mentioned
      const unmentionedEvent = {
        header: { event_id: 'evt_mention_1', event_type: 'im.message.receive_v1', create_time: '1700000000000' },
        event: {
          sender: { sender_id: { open_id: 'ou_human_1' }, sender_type: 'user' },
          message: {
            message_id: 'om_unmentioned_1',
            chat_id: chatId,
            chat_type: 'group',
            message_type: 'text',
            content: JSON.stringify({ text: '@Bob how are you?' }),
            create_time: '1700000000000',
            mentions: [
              { key: '@_user_1', name: 'Bob', id: { open_id: 'ou_bob_9999' } },
            ],
          },
        },
      };

      const res = await gateway.handleInboundEvent(unmentionedEvent);
      expect(res.handled).toBe(false);
      expect(res.ignoredReason).toBe('not_mentioned');

      await runtimeGateway.drain();
      expect(transport.sentReplies.length).toBe(0);
    });

    it('processes group message when bot is explicitly mentioned and strips leading mention', async () => {
      const chatId = 'oc_gated_group_2';
      await channelRepo.createBinding({
        accountId: gateway.accountId,
        spaceId,
        nativeContextId: chatId,
        activationMode: 'mention',
      });

      const mentionedEvent = {
        header: { event_id: 'evt_mention_2', event_type: 'im.message.receive_v1', create_time: '1700000000000' },
        event: {
          sender: { sender_id: { open_id: 'ou_human_1' }, sender_type: 'user' },
          message: {
            message_id: 'om_mentioned_1',
            chat_id: chatId,
            chat_type: 'group',
            message_type: 'text',
            content: JSON.stringify({ text: '@EnkeepBot summarize quarterly revenue' }),
            create_time: '1700000000000',
            mentions: [
              { key: '@_user_1', name: 'EnkeepBot', id: { open_id: botOpenId } },
            ],
          },
        },
      };

      const res = await gateway.handleInboundEvent(mentionedEvent);
      expect(res.handled).toBe(true);

      await runtimeGateway.drain();
      expect(transport.sentReplies.length).toBe(1);
      expect(transport.sentReplies[0].content).toBe('Executed reply to: summarize quarterly revenue');
    });

    it('group message with trailing bot mention dispatches with clean content 2', async () => {
      const chatId = 'oc_group_chat_trailing';
      await channelRepo.createBinding({
        accountId: gateway.accountId,
        spaceId,
        nativeContextId: chatId,
        activationMode: 'mention',
      });

      const trailingMentionEvent = {
        header: { event_id: 'evt_mention_trailing_1', event_type: 'im.message.receive_v1', create_time: '1700000000000' },
        event: {
          sender: { sender_id: { open_id: 'ou_human_1' }, sender_type: 'user' },
          message: {
            message_id: 'om_trailing_1',
            chat_id: chatId,
            chat_type: 'group',
            message_type: 'text',
            content: JSON.stringify({ text: '2 @_user_1' }),
            create_time: '1700000000000',
            mentions: [
              { key: '@_user_1', name: '测试机器人', id: { open_id: botOpenId } },
            ],
          },
        },
      };

      const res = await gateway.handleInboundEvent(trailingMentionEvent);
      expect(res.handled).toBe(true);

      await runtimeGateway.drain();
      expect(transport.sentReplies.length).toBe(1);
      expect(transport.sentReplies[0].content).toBe('Executed reply to: 2');
    });

    it('mention-only message replies with hint and does not dispatch', async () => {
      const chatId = 'oc_group_chat_mention_only';
      await channelRepo.createBinding({
        accountId: gateway.accountId,
        spaceId,
        nativeContextId: chatId,
        activationMode: 'mention',
      });

      const mentionOnlyEvent = {
        header: { event_id: 'evt_mention_only_1', event_type: 'im.message.receive_v1', create_time: '1700000000000' },
        event: {
          sender: { sender_id: { open_id: 'ou_human_1' }, sender_type: 'user' },
          message: {
            message_id: 'om_mention_only_1',
            chat_id: chatId,
            chat_type: 'group',
            message_type: 'text',
            content: JSON.stringify({ text: '@_user_1' }),
            create_time: '1700000000000',
            mentions: [
              { key: '@_user_1', name: '测试机器人', id: { open_id: botOpenId } },
            ],
          },
        },
      };

      const res = await gateway.handleInboundEvent(mentionOnlyEvent);
      expect(res.handled).toBe(false);
      expect(res.ignoredReason).toBe('empty_after_mention_strip');

      await runtimeGateway.drain();
      // Transport sent the hint reply, NOT an agent reply
      expect(transport.sentReplies.length).toBe(1);
      expect(transport.sentReplies[0].content).toBe('请在 @我 之后写下你的问题～');
      expect(transport.sentReplies[0].replyToMessageId).toBe('om_mention_only_1');
    });

    it('always processes direct messages (p2p) even without mention', async () => {
      const p2pChatId = 'oc_p2p_direct_1';
      await channelRepo.createBinding({
        accountId: gateway.accountId,
        spaceId,
        nativeContextId: p2pChatId,
        activationMode: 'mention', // Mention mode on binding, but chat_type is p2p
      });

      const p2pEvent = {
        header: { event_id: 'evt_p2p_1', event_type: 'im.message.receive_v1', create_time: '1700000000000' },
        event: {
          sender: { sender_id: { open_id: 'ou_human_1' }, sender_type: 'user' },
          message: {
            message_id: 'om_p2p_1',
            chat_id: p2pChatId,
            chat_type: 'p2p',
            message_type: 'text',
            content: JSON.stringify({ text: 'Private direct question' }),
            create_time: '1700000000000',
          },
        },
      };

      const res = await gateway.handleInboundEvent(p2pEvent);
      expect(res.handled).toBe(true);
      await runtimeGateway.drain();
      expect(transport.sentReplies.length).toBe(1);
    });

    it('auto-creates new group binding using account groupActivationMode always, allowing non-mentioned message to dispatch', async () => {
      // Configure account with defaultSpaceId and groupActivationMode: 'always'
      await channelRepo.updateAccount(gateway.accountId, {
        defaultSpaceId: spaceId,
        groupActivationMode: 'always',
      });

      const newGroupChatId = 'oc_auto_created_group_always';
      // Ensure no binding exists yet
      expect(await channelRepo.findBindingByContext(gateway.accountId, newGroupChatId)).toBeNull();

      // Non-mentioned group message
      const unmentionedEvent = {
        header: { event_id: 'evt_auto_always_1', event_type: 'im.message.receive_v1', create_time: '1700000000000' },
        event: {
          sender: { sender_id: { open_id: 'ou_human_1' }, sender_type: 'user' },
          message: {
            message_id: 'om_auto_always_1',
            chat_id: newGroupChatId,
            chat_type: 'group',
            message_type: 'text',
            content: JSON.stringify({ text: 'Hello everyone in group!' }),
            create_time: '1700000000000',
          },
        },
      };

      const res = await gateway.handleInboundEvent(unmentionedEvent);
      expect(res.handled).toBe(true);

      // Verify the auto-created binding was created with activationMode: 'always' and chatType: 'group'
      const createdBinding = await channelRepo.findBindingByContext(gateway.accountId, newGroupChatId);
      expect(createdBinding).toBeDefined();
      expect(createdBinding?.activationMode).toBe('always');
      expect(createdBinding?.chatType).toBe('group');

      await runtimeGateway.drain();
      expect(transport.sentReplies.length).toBe(1);
      expect(transport.sentReplies[0].content).toBe('Executed reply to: Hello everyone in group!');
    });
  });

  describe('4. Thread & Topic Separation', () => {
    it('isolates conversation sessions across different threads in the same chat', async () => {
      const chatId = 'oc_parent_group_1';
      await channelRepo.createBinding({
        accountId: gateway.accountId,
        spaceId,
        nativeContextId: chatId,
        activationMode: 'always',
      });

      // Message in Thread Alpha
      const resA = await gateway.handleInboundEvent({
        header: { event_id: 'evt_th_1', event_type: 'im.message.receive_v1', create_time: '1700000000000' },
        event: {
          sender: { sender_id: { open_id: 'ou_1' } },
          message: {
            message_id: 'om_th_1',
            chat_id: chatId,
            root_id: 'om_root_alpha',
            message_type: 'text',
            content: JSON.stringify({ text: 'Topic Alpha discussion' }),
            create_time: '1700000000000',
          },
        },
      });

      // Message in Thread Beta
      const resB = await gateway.handleInboundEvent({
        header: { event_id: 'evt_th_2', event_type: 'im.message.receive_v1', create_time: '1700000000000' },
        event: {
          sender: { sender_id: { open_id: 'ou_2' } },
          message: {
            message_id: 'om_th_2',
            chat_id: chatId,
            root_id: 'om_root_beta',
            message_type: 'text',
            content: JSON.stringify({ text: 'Topic Beta discussion' }),
            create_time: '1700000000000',
          },
        },
      });

      // Message in Chat Root (no thread)
      const resRoot = await gateway.handleInboundEvent({
        header: { event_id: 'evt_root_1', event_type: 'im.message.receive_v1', create_time: '1700000000000' },
        event: {
          sender: { sender_id: { open_id: 'ou_3' } },
          message: {
            message_id: 'om_root_1',
            chat_id: chatId,
            message_type: 'text',
            content: JSON.stringify({ text: 'Main chat message' }),
            create_time: '1700000000000',
          },
        },
      });

      await runtimeGateway.drain();

      // Verify all 3 sessions are distinct
      expect(resA.sessionRouteId).not.toBe(resB.sessionRouteId);
      expect(resA.sessionRouteId).not.toBe(resRoot.sessionRouteId);
      expect(resB.sessionRouteId).not.toBe(resRoot.sessionRouteId);

      const routeAlpha = await sessionRouteRepo.findById(resA.sessionRouteId!);
      const routeBeta = await sessionRouteRepo.findById(resB.sessionRouteId!);
      const routeRoot = await sessionRouteRepo.findById(resRoot.sessionRouteId!);

      expect(routeAlpha?.nativeContextId).toBe('oc_parent_group_1:om_root_alpha');
      expect(routeBeta?.nativeContextId).toBe('oc_parent_group_1:om_root_beta');
      expect(routeRoot?.nativeContextId).toBe('oc_parent_group_1');
    });
  });

  describe('5. Disconnect, Outbox Redrive & Reconnect Recovery', () => {
    it('redrives pending outbox replies upon transport reconnection', async () => {
      const chatId = 'oc_reconnect_chat_1';
      await channelRepo.createBinding({
        accountId: gateway.accountId,
        spaceId,
        nativeContextId: chatId,
        activationMode: 'always',
      });

      // Simulate failure during outbox send
      transport.failNextSend = true;
      transport.failNextSendReason = 'Network disconnected';

      const event = {
        header: { event_id: 'evt_recon_1', event_type: 'im.message.receive_v1', create_time: '1700000000000' },
        event: {
          sender: { sender_id: { open_id: 'ou_1' } },
          message: {
            message_id: 'om_recon_msg_1',
            chat_id: chatId,
            message_type: 'text',
            content: JSON.stringify({ text: 'Hello during network blip' }),
            create_time: '1700000000000',
          },
        },
      };

      await gateway.handleInboundEvent(event);
      await runtimeGateway.drain();

      // Agent did run, but reply delivery failed
      expect(transport.sentReplies.length).toBe(0);

      // Verify pending outbox item exists
      const pendingBefore = await channelRepo.listPendingOutbox(10, gateway.accountId);
      expect(pendingBefore.length).toBe(1);
      expect(pendingBefore[0].status).toBe('pending');
      expect(pendingBefore[0].attempts).toBe(1);

      // Simulate reconnect and redrive
      transport.simulateReconnect();
      const redriveCount = await gateway.redrivePendingOutbox();
      expect(redriveCount).toBe(1);

      // Verify delivery succeeded
      expect(transport.sentReplies.length).toBe(1);
      const pendingAfter = await channelRepo.listPendingOutbox(10, gateway.accountId);
      expect(pendingAfter.length).toBe(0);

      const deliveredItem = await channelRepo.findOutboxById(pendingBefore[0].id);
      expect(deliveredItem?.status).toBe('delivered');
    });
  });

  describe('6. Real Lark Credential Acceptance Explicit Skip Reporting', () => {
    it('reports REAL_LARK_CREDENTIAL_ACCEPTANCE=SKIPPED and exact reason without real credentials', () => {
      const credTransport = new CredentialedLarkTransport({
        id: 'acc_cred_1',
        userId: 'usr_1',
        appId: 'cli_dummy_test',
        credentialRef: 'cred_lark_unverified',
      });

      expect(credTransport.acceptanceStatus).toBe('SKIPPED');
      expect(credTransport.acceptanceStatus).toBe(REAL_LARK_CREDENTIAL_ACCEPTANCE);
      expect(credTransport.skipReason).toBe(REAL_LARK_CREDENTIAL_SKIP_REASON);
      expect(credTransport.connected).toBe(false);
    });
  });

  describe('7. Rich-Text / Post Message & Resource Parsing', () => {
    it('extracts formatted text, code blocks, attachments, and inline mentions from post events', () => {
      const rawPostEvent = {
        header: { event_id: 'evt_post_1', event_type: 'im.message.receive_v1', create_time: '1700000000000' },
        event: {
          sender: { sender_id: { open_id: 'ou_developer_1' } },
          message: {
            message_id: 'om_post_123',
            chat_id: 'oc_post_chat_1',
            message_type: 'post',
            content: JSON.stringify({
              zh_cn: {
                title: 'Deployment Issue Report',
                content: [
                  [
                    { tag: 'text', text: 'Please review the log from ' },
                    { tag: 'at', user_id: 'ou_bot_1234567890', user_name: 'EnkeepBot' },
                  ],
                  [
                    { tag: 'code_block', text: 'Error: Connection reset by peer\n  at TCP.onStreamRead' },
                  ],
                  [
                    { tag: 'img', image_key: 'img_screenshot_v1' },
                    { tag: 'file', file_key: 'file_dump_v1', file_name: 'stacktrace.log' },
                  ],
                ],
              },
            }),
            create_time: '1700000000000',
          },
        },
      };

      const parsed = parseLarkEvent(rawPostEvent);
      expect(parsed).not.toBeNull();
      expect(parsed?.msgType).toBe('post');
      expect(parsed?.text).toContain('Deployment Issue Report');
      expect(parsed?.text).toContain('@EnkeepBot');
      expect(parsed?.text).toContain('Error: Connection reset by peer');
      expect(parsed?.resources?.length).toBe(2);
      expect(parsed?.resources?.[0].type).toBe('image');
      expect(parsed?.resources?.[0].key).toBe('img_screenshot_v1');
      expect(parsed?.resources?.[1].type).toBe('file');
      expect(parsed?.resources?.[1].name).toBe('stacktrace.log');

      // Test messageMentionsBot with post inline at
      const mentionsBot = messageMentionsBot(
        { content: rawPostEvent.event.message.content },
        undefined,
        botOpenId
      );
      expect(mentionsBot).toBe(true);
    });
  });

  describe('8. Batch 1: Reaction Lifecycle, Thread Reply, & Mention Waiver', () => {
    it('sendReply targets rootId for threads and retries with reply_in_thread: false on code 230071', async () => {
      const replyCalls: Array<{
        message_id: string;
        reply_in_thread: boolean;
        content: string;
      }> = [];

      let shouldFailWith230071 = true;

      const mockClientFactory = {
        createClient: () => ({
          im: {
            message: {
              reply: async (req: any) => {
                replyCalls.push({
                  message_id: req.path.message_id,
                  reply_in_thread: req.data.reply_in_thread,
                  content: req.data.content,
                });
                if (shouldFailWith230071) {
                  shouldFailWith230071 = false;
                  const err: any = new Error('Thread reply unsupported');
                  err.code = 230071;
                  throw err;
                }
                return { code: 0, data: { message_id: 'om_reply_ok' } };
              },
              create: async () => ({ code: 0, data: { message_id: 'om_create_ok' } }),
            },
          },
        }),
      };

      const credTransport = new CredentialedLarkTransport({
        account: {
          id: 'acc_test_reply',
          userId: 'usr_test',
          appId: 'cli_test',
          appSecret: 'sec_test',
          brand: 'feishu',
        },
        clientFactory: mockClientFactory as any,
      });

      await credTransport.start();

      const result = await credTransport.sendReply({
        chatId: 'oc_test_chat',
        rootId: 'om_root_msg_001',
        threadId: 'om_thread_msg_002',
        replyToMessageId: 'om_child_msg_003',
        content: 'Replying to thread',
      });

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('om_reply_ok');
      expect(replyCalls.length).toBe(2);

      // Call 1: preferred rootId and reply_in_thread: true
      expect(replyCalls[0].message_id).toBe('om_root_msg_001');
      expect(replyCalls[0].reply_in_thread).toBe(true);

      // Call 2 (fallback after 230071): targeting replyToMessageId with reply_in_thread: false
      expect(replyCalls[1].message_id).toBe('om_child_msg_003');
      expect(replyCalls[1].reply_in_thread).toBe(false);
    });

    it('inbound message triggers OnIt reaction on claim and turn completion triggers remove and DONE reaction', async () => {
      const account = await channelRepo.createAccount({
        type: 'lark',
        status: 'active',
      });

      const testTransport = new FakeLarkTransport();
      await testTransport.start();

      const testGateway = new LarkChannelGateway({
        account: {
          id: account.id,
          userId,
        },
        transport: testTransport,
        channelRepo,
        sessionRouteRepo,
        runtimeGateway,
      });

      // Binding with always activation
      await channelRepo.createBinding({
        accountId: account.id,
        spaceId,
        nativeContextId: 'oc_rx_chat',
        activationMode: 'always',
      });

      const inboundMsgId = 'om_inbound_reaction_001';
      const eventId = 'evt_reaction_001';

      // 1. Inbound event dispatch
      const inboundResult = await testGateway.handleInboundEvent({
        header: {
          event_id: eventId,
          event_type: 'im.message.receive_v1',
          create_time: '1700000000000',
        },
        event: {
          sender: { sender_id: { open_id: 'ou_rx_user' } },
          message: {
            message_id: inboundMsgId,
            chat_id: 'oc_rx_chat',
            chat_type: 'p2p',
            message_type: 'text',
            content: JSON.stringify({ text: 'Hello reaction test' }),
            create_time: '1700000000000',
          },
        },
      });

      expect(inboundResult.handled).toBe(true);
      // Verify OnIt reaction was added
      expect(testTransport.addedReactions.length).toBe(1);
      expect(testTransport.addedReactions[0].messageId).toBe(inboundMsgId);
      expect(testTransport.addedReactions[0].emojiType).toBe('OnIt');

      const initialReactionId = testTransport.addedReactions[0].reactionId;

      // 2. Handle turn completion
      const outbox = await testGateway.handleTurnCompleted({
        sessionId: inboundResult.sessionRouteId!,
        turnId: inboundResult.turnId!,
        replyText: 'Reply after reaction',
        idempotencyKey: testGateway.deriveIdempotencyKey(eventId),
        replyToMessageId: inboundMsgId,
        chatId: 'oc_rx_chat',
        nativeEventId: eventId,
      });

      expect(outbox).not.toBeNull();

      // Allow async fire-and-forget reaction promises to settle
      await vi.waitFor(() => {
        expect(testTransport.removedReactions.length).toBe(1);
        expect(testTransport.addedReactions.length).toBe(2);
      });

      // Verify OnIt reaction was removed
      expect(testTransport.removedReactions[0].messageId).toBe(inboundMsgId);
      expect(testTransport.removedReactions[0].reactionId).toBe(initialReactionId);

      // Verify DONE reaction was added
      expect(testTransport.addedReactions[1].messageId).toBe(inboundMsgId);
      expect(testTransport.addedReactions[1].emojiType).toBe('DONE');
    });

    it('mention gating is waived inside an established topic route under mention activation mode', async () => {
      const account = await channelRepo.createAccount({
        type: 'lark',
        status: 'active',
      });

      const testTransport = new FakeLarkTransport();
      await testTransport.start();

      const testGateway = new LarkChannelGateway({
        account: {
          id: account.id,
          userId,
        },
        transport: testTransport,
        channelRepo,
        sessionRouteRepo,
        runtimeGateway,
      });

      const chatId = 'oc_topic_chat_001';
      const rootId = 'om_topic_root_001';
      const topicContextId = `${chatId}:${rootId}`;

      // Create mention-mode binding for the group chat
      await channelRepo.createBinding({
        accountId: account.id,
        spaceId,
        nativeContextId: chatId,
        activationMode: 'mention',
      });

      // 1. Inbound inside a topic thread BEFORE any route is established (no mention) -> ignored as not_mentioned
      const unestablishedResult = await testGateway.handleInboundEvent({
        header: {
          event_id: 'evt_topic_unestablished',
          event_type: 'im.message.receive_v1',
          create_time: '1700000000000',
        },
        event: {
          sender: { sender_id: { open_id: 'ou_human_1' } },
          message: {
            message_id: 'om_msg_unestablished',
            chat_id: chatId,
            chat_type: 'group',
            root_id: rootId,
            message_type: 'text',
            content: JSON.stringify({ text: 'Hello in thread without mention' }),
            create_time: '1700000000000',
          },
        },
      });

      expect(unestablishedResult.handled).toBe(false);
      expect(unestablishedResult.ignoredReason).toBe('not_mentioned');

      // 2. Establish route for this topic (e.g. following an initial @mention message)
      await sessionRouteRepo.create({
        spaceId,
        channel: 'lark',
        accountId: account.id,
        nativeContextId: topicContextId,
        peerId: 'ou_human_1',
        dshSessionId: 'ses_topic_established_1',
        title: 'Established Topic Route',
      });

      // 3. Inbound inside established topic thread WITHOUT mention -> handled! (mention waived)
      const establishedResult = await testGateway.handleInboundEvent({
        header: {
          event_id: 'evt_topic_established',
          event_type: 'im.message.receive_v1',
          create_time: '1700000001000',
        },
        event: {
          sender: { sender_id: { open_id: 'ou_human_1' } },
          message: {
            message_id: 'om_msg_established_followup',
            chat_id: chatId,
            chat_type: 'group',
            root_id: rootId,
            message_type: 'text',
            content: JSON.stringify({ text: 'Follow-up question without mention' }),
            create_time: '1700000001000',
          },
        },
      });

      expect(establishedResult.handled).toBe(true);
      expect(establishedResult.sessionRouteId).toBeDefined();

      // 4. Inbound in main chat (not in a thread) without mention still requires mention
      const mainChatResult = await testGateway.handleInboundEvent({
        header: {
          event_id: 'evt_main_chat_msg',
          event_type: 'im.message.receive_v1',
          create_time: '1700000002000',
        },
        event: {
          sender: { sender_id: { open_id: 'ou_human_1' } },
          message: {
            message_id: 'om_msg_main_chat',
            chat_id: chatId,
            chat_type: 'group',
            message_type: 'text',
            content: JSON.stringify({ text: 'Main chat message without mention' }),
            create_time: '1700000002000',
          },
        },
      });

      expect(mainChatResult.handled).toBe(false);
      expect(mainChatResult.ignoredReason).toBe('not_mentioned');
    });
  });

  describe('8. Streaming Interactive Reply Card Closed-Loop', () => {
    it('inbound → completed with a tracker → exactly one outbox row delivered and NO sendReply text call', async () => {
      const streamAccount = await channelRepo.createAccount({
        type: 'lark',
        status: 'active',
      });

      const streamTransport = new FakeLarkTransport();
      await streamTransport.start();

      const chatId = 'oc_stream_chat_1';
      await channelRepo.createBinding({
        accountId: streamAccount.id,
        spaceId,
        nativeContextId: chatId,
        activationMode: 'always',
      });

      const fakeStreamSource: StreamEventSource = {
        listAssistantEvents: async () => [
          { rowId: 1, type: 'assistant_delta', delta: 'Streamed answer' },
          { rowId: 2, type: 'assistant_stream_end' },
        ],
      };

      const streamGateway = new LarkChannelGateway({
        account: {
          id: streamAccount.id,
          userId,
        },
        transport: streamTransport,
        channelRepo,
        sessionRouteRepo,
        spaceRepo,
        runtimeGateway,
        streamEventSource: fakeStreamSource,
      });

      (runtimeManager as any).activeGateways.set(`${userId}:${streamAccount.id}`, streamGateway);

      const rawEvent = {
        header: {
          event_id: 'evt_stream_closed_001',
          event_type: 'im.message.receive_v1',
          create_time: '1700000000000',
        },
        event: {
          sender: {
            sender_id: { open_id: 'ou_human_stream_1' },
            sender_type: 'user',
          },
          message: {
            message_id: 'om_human_stream_001',
            chat_id: chatId,
            chat_type: 'group',
            message_type: 'text',
            content: JSON.stringify({ text: 'Explain streaming execution' }),
            create_time: '1700000000000',
          },
        },
      };

      const res = await streamGateway.handleInboundEvent(rawEvent);
      expect(res.handled).toBe(true);

      // Drain execution queue to completion (triggers runtimeManager.handleTurnCompleted -> streamGateway)
      await runtimeGateway.drain();

      // Exactly one outbox row delivered in database
      const outboxRows = db.prepare('SELECT * FROM channel_outbox WHERE session_id = ?').all(res.sessionRouteId!) as Array<{
        status: string;
        payload_json: string;
      }>;
      expect(outboxRows.length).toBe(1);
      expect(outboxRows[0].status).toBe('delivered');
      const payload = JSON.parse(outboxRows[0].payload_json);
      expect(payload.format).toBe('markdown');
      expect(payload.messageId).toMatch(/^om_/);

      // NO sendReply text call
      expect(streamTransport.sentReplies.length).toBe(0);

      // Fake transport recorded streaming card creation and finalize
      expect(streamTransport.streamingCalls.length).toBeGreaterThanOrEqual(2);
      expect(streamTransport.streamingCalls[0].type).toBe('card_create');
      expect(streamTransport.streamingCalls[streamTransport.streamingCalls.length - 1].type).toBe('finalize');
      expect(streamTransport.streamingCalls[streamTransport.streamingCalls.length - 1].status).toBe('completed');
    });

    it('without streamEventSource → old text path delivers via sendReply', async () => {
      const textAccount = await channelRepo.createAccount({
        type: 'lark',
        status: 'active',
      });

      const textTransport = new FakeLarkTransport();
      await textTransport.start();

      const chatId = 'oc_text_fallback_chat_1';
      await channelRepo.createBinding({
        accountId: textAccount.id,
        spaceId,
        nativeContextId: chatId,
        activationMode: 'always',
      });

      // No streamEventSource provided
      const textGateway = new LarkChannelGateway({
        account: {
          id: textAccount.id,
          userId,
        },
        transport: textTransport,
        channelRepo,
        sessionRouteRepo,
        spaceRepo,
        runtimeGateway,
      });

      (runtimeManager as any).activeGateways.set(`${userId}:${textAccount.id}`, textGateway);

      const rawEvent = {
        header: {
          event_id: 'evt_text_fallback_001',
          event_type: 'im.message.receive_v1',
          create_time: '1700000000000',
        },
        event: {
          sender: {
            sender_id: { open_id: 'ou_human_fallback_1' },
            sender_type: 'user',
          },
          message: {
            message_id: 'om_human_fallback_001',
            chat_id: chatId,
            chat_type: 'group',
            message_type: 'text',
            content: JSON.stringify({ text: 'Explain fallback execution' }),
            create_time: '1700000000000',
          },
        },
      };

      const res = await textGateway.handleInboundEvent(rawEvent);
      expect(res.handled).toBe(true);

      await runtimeGateway.drain();

      // Exactly one outbox row delivered
      const outboxRows = db.prepare('SELECT * FROM channel_outbox WHERE session_id = ?').all(res.sessionRouteId!) as Array<{
        status: string;
        payload_json: string;
      }>;
      expect(outboxRows.length).toBe(1);
      expect(outboxRows[0].status).toBe('delivered');
      const payload = JSON.parse(outboxRows[0].payload_json);
      expect(payload.format).toBe('plain');

      // DID call sendReply text method
      expect(textTransport.sentReplies.length).toBe(1);
      expect(textTransport.sentReplies[0].content).toContain('Executed reply to:');
      expect(textTransport.sentReplies[0].format).toBe('plain');
      // NO streaming card calls
      expect(textTransport.streamingCalls.length).toBe(0);
    });

    it('calling handleTurnCompleted twice concurrently for same turn results in exactly ONE outbox row (markdown) and zero sendReply text calls', async () => {
      const streamAccount = await channelRepo.createAccount({
        type: 'lark',
        status: 'active',
      });

      const streamTransport = new FakeLarkTransport();
      streamTransport.finalizeDelayMs = 50;
      await streamTransport.start();

      const chatId = 'oc_stream_concurrent_1';
      await channelRepo.createBinding({
        accountId: streamAccount.id,
        spaceId,
        nativeContextId: chatId,
        activationMode: 'always',
      });

      const fakeStreamSource: StreamEventSource = {
        listAssistantEvents: async () => [
          { rowId: 1, type: 'assistant_delta', delta: 'Concurrent test answer' },
          { rowId: 2, type: 'assistant_stream_end' },
        ],
      };

      const localRuntimeGateway = {
        dispatchInbound: vi.fn().mockResolvedValue({ turnId: 'turn_stream_concurrent_001' }),
      } as any;

      const streamGateway = new LarkChannelGateway({
        account: {
          id: streamAccount.id,
          userId,
        },
        transport: streamTransport,
        channelRepo,
        sessionRouteRepo,
        spaceRepo,
        runtimeGateway: localRuntimeGateway,
        streamEventSource: fakeStreamSource,
      });

      const rawEvent = {
        header: {
          event_id: 'evt_stream_concurrent_001',
          event_type: 'im.message.receive_v1',
          create_time: '1700000000000',
        },
        event: {
          sender: {
            sender_id: { open_id: 'ou_human_concurrent_1' },
            sender_type: 'user',
          },
          message: {
            message_id: 'om_human_concurrent_001',
            chat_id: chatId,
            chat_type: 'group',
            message_type: 'text',
            content: JSON.stringify({ text: 'Test concurrent completion' }),
            create_time: '1700000000000',
          },
        },
      };

      const res = await streamGateway.handleInboundEvent(rawEvent);
      expect(res.handled).toBe(true);

      const params = {
        sessionId: res.sessionRouteId!,
        turnId: res.turnId!,
        replyText: 'Concurrent test answer',
        idempotencyKey: streamGateway.deriveIdempotencyKey(rawEvent.header.event_id),
        nativeEventId: rawEvent.header.event_id,
        chatId,
      };

      // Call handleTurnCompleted twice concurrently
      const [res1, res2] = await Promise.all([
        streamGateway.handleTurnCompleted(params),
        streamGateway.handleTurnCompleted(params),
      ]);

      // One returns outbox row, the concurrent one returns null
      expect((res1 !== null && res2 === null) || (res1 === null && res2 !== null)).toBe(true);

      // Exactly ONE outbox row in db and format is markdown
      const outboxRows = db.prepare('SELECT * FROM channel_outbox WHERE session_id = ?').all(res.sessionRouteId!) as Array<{
        status: string;
        payload_json: string;
      }>;
      expect(outboxRows.length).toBe(1);
      expect(outboxRows[0].status).toBe('delivered');
      const payload = JSON.parse(outboxRows[0].payload_json);
      expect(payload.format).toBe('markdown');

      // Zero sendReply calls
      expect(streamTransport.sentReplies.length).toBe(0);

      // Subsequent call returns existing outbox item without re-sending
      const res3 = await streamGateway.handleTurnCompleted(params);
      expect(res3).not.toBeNull();
      expect(res3?.id).toBe((res1 || res2)?.id);
      expect(streamTransport.sentReplies.length).toBe(0);
    });
  });
});
