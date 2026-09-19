import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  DeliveryRuntimeGateway,
  SqliteWebMessageStore,
  ChannelRuntimeManager,
} from '../src/index.js';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import {
  LarkChannelGateway,
  FakeLarkTransport,
  CredentialedLarkTransport,
  type LarkRawEvent,
} from '@enkeep/channel-lark';

describe('Lark Inbound Image Retry Loop & Durable Failure Classification', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let messageStore: SqliteWebMessageStore;
  let deliveryGateway: DeliveryRuntimeGateway;
  let transport: FakeLarkTransport;
  let runtimeManager: ChannelRuntimeManager;
  let gateway: LarkChannelGateway;

  const userId = 'usr_img_retry_test';
  const spaceId = 'spc_img_retry_test_1';
  const accountId = 'ca_img_retry_test_acc';
  const botAppId = 'cli_mock_img_retry_bot';
  const botOpenId = 'ou_mock_img_retry_bot';

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'retry_tester', 'hash')`).run(userId);
    db.prepare(`INSERT INTO spaces (id, user_id, name, folder, execution_mode) VALUES (?, ?, 'Retry Space', 'space_retry', 'container')`).run(spaceId, userId);

    storage = new SqlitePlatformStorage(db);
    messageStore = new SqliteWebMessageStore(db);

    deliveryGateway = new DeliveryRuntimeGateway({
      storage,
      database: db,
      messageStore,
      quotaMode: 'disabled',
      profileResolver: {
        resolve: async () => ({
          snapshot: { systemInstructions: 'Test' },
          version: 1,
        }),
      } as any,
      executor: {
        execute: async (req) => ({
          replyText: `Executed turn for: ${req.prompt}`,
          usage: { totalTokens: 10 },
        }),
        cancel: async () => true,
      },
    });

    transport = new FakeLarkTransport();

    // Create active lark channel account in db
    await storage.forTenant(userId).channels.createAccount({
      id: accountId,
      name: 'Retry Test Bot',
      type: 'lark',
      status: 'active',
      appId: botAppId,
      botOpenId,
      defaultSpaceId: spaceId,
      groupActivationMode: 'mention',
    });

    runtimeManager = new ChannelRuntimeManager({
      storage,
      db,
      deliveryGateway,
      transportFactory: () => transport,
      autoStart: false,
    });

    await runtimeManager.start();
    gateway = runtimeManager.getActiveGateway(userId, accountId)!;
    expect(gateway).toBeDefined();
  });

  it('1. Terminal failure: 3+ worker ticks on image error do not cause repeated download, ACK, or error cards', async () => {
    // Configure transport to fail image download with permanent failure
    transport.failDownloadImage = true;
    transport.failDownloadImageReason = 'Resource not found for key img_missing_001';

    let addReactionCount = 0;
    let removeReactionCount = 0;
    const origAddReaction = transport.addReaction.bind(transport);
    const origRemoveReaction = transport.removeReaction.bind(transport);
    transport.addReaction = async (...args) => {
      addReactionCount++;
      return origAddReaction(...args);
    };
    transport.removeReaction = async (...args) => {
      removeReactionCount++;
      return origRemoveReaction(...args);
    };

    let downloadAttempts = 0;
    const origDownload = transport.downloadImageResource.bind(transport);
    transport.downloadImageResource = async (...args) => {
      downloadAttempts++;
      return origDownload(...args);
    };

    const rawEvent: LarkRawEvent = {
      header: { event_id: 'evt_image_fail_loop_01', event_type: 'im.message.receive_v1', create_time: '100' },
      event: {
        sender: { sender_id: { open_id: 'ou_sender_01' } },
        message: {
          message_id: 'om_image_fail_01',
          chat_id: 'oc_chat_loop',
          chat_type: 'p2p',
          message_type: 'image',
          content: JSON.stringify({ image_key: 'img_missing_001' }),
          create_time: '100',
        },
      },
    };

    // First inbound handle
    const initialResult = await gateway.handleInboundEvent(rawEvent);
    expect(initialResult.handled).toBe(false);
    expect(initialResult.ignoredReason).toBe('transport_error');

    // Exactly 1 download attempt and 1 initial ACK added + removed
    expect(downloadAttempts).toBe(1);
    expect(addReactionCount).toBe(1);
    expect(removeReactionCount).toBe(1);
    expect(transport.sentReplies).toHaveLength(1);
    expect(transport.sentReplies[0].content).toBe('图片接收失败，请稍后重试');

    // Durable outbox row was created with deterministic ID
    const outboxRows = db.prepare(`SELECT * FROM channel_outbox WHERE account_id = ?`).all(accountId) as any[];
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0].status).toBe('delivered');

    // Inbox status is 'failed' and payload classifies terminal failure
    const inboxRow = db.prepare(`SELECT status, payload_json FROM channel_inbox WHERE native_event_id = ?`).get('evt_image_fail_loop_01') as any;
    expect(inboxRow.status).toBe('failed');
    const parsedPayload = JSON.parse(inboxRow.payload_json);
    expect(parsedPayload.retry).toBeDefined();
    expect(parsedPayload.retry.terminal).toBe(true);
    expect(parsedPayload.retry.retryable).toBe(false);
    expect(parsedPayload.retry.failureCode).toBe('RESOURCE_EXPIRED_OR_NOT_FOUND');

    // Run 3+ background worker ticks
    for (let tick = 1; tick <= 4; tick++) {
      await runtimeManager.runBackgroundWorkerTick();
    }

    // Verify: no repeated download attempts, no repeated ACK, no repeated error replies
    expect(downloadAttempts).toBe(1);
    expect(addReactionCount).toBe(1);
    expect(removeReactionCount).toBe(1);
    expect(transport.sentReplies).toHaveLength(1);

    // Verify: inbox terminal failed row is NOT claimed for processing
    const inboxAfterTicks = db.prepare(`SELECT status FROM channel_inbox WHERE native_event_id = ?`).get('evt_image_fail_loop_01') as any;
    expect(inboxAfterTicks.status).toBe('failed');

    // Verify claimInboxForProcessing refuses to claim it
    const claimAttempt = await storage.forTenant(userId).channels.claimInboxForProcessing(initialResult.inboxItem!.id);
    expect(claimAttempt).toBeNull();
  });

  it('2. Duplicate WS same event for terminal failed event does not loop or re-claim', async () => {
    transport.failDownloadImage = true;
    transport.failDownloadImageReason = 'Resource not found for key img_dup_001';

    const rawEvent: LarkRawEvent = {
      header: { event_id: 'evt_ws_duplicate_01', event_type: 'im.message.receive_v1', create_time: '200' },
      event: {
        sender: { sender_id: { open_id: 'ou_sender_02' } },
        message: {
          message_id: 'om_ws_dup_01',
          chat_id: 'oc_chat_dup',
          chat_type: 'p2p',
          message_type: 'image',
          content: JSON.stringify({ image_key: 'img_dup_001' }),
          create_time: '200',
        },
      },
    };

    // First arrival fails and becomes terminal
    const res1 = await gateway.handleInboundEvent(rawEvent);
    expect(res1.handled).toBe(false);
    expect(res1.ignoredReason).toBe('transport_error');
    expect(transport.sentReplies).toHaveLength(1);

    // Second arrival of duplicate WS event
    const res2 = await gateway.handleInboundEvent(rawEvent);
    expect(res2.handled).toBe(false);
    expect(res2.ignoredReason).toBe('duplicate_event');

    // No extra replies sent, no extra outbox entries
    expect(transport.sentReplies).toHaveLength(1);
    const outboxRows = db.prepare(`SELECT * FROM channel_outbox WHERE account_id = ?`).all(accountId) as any[];
    expect(outboxRows).toHaveLength(1);
  });

  it('3. Normal text message still works and completes successfully', async () => {
    const rawEvent: LarkRawEvent = {
      header: { event_id: 'evt_text_normal_01', event_type: 'im.message.receive_v1', create_time: '300' },
      event: {
        sender: { sender_id: { open_id: 'ou_sender_text' } },
        message: {
          message_id: 'om_text_normal_01',
          chat_id: 'oc_chat_text',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: 'Hello Enkeep normal text' }),
          create_time: '300',
        },
      },
    };

    const res = await gateway.handleInboundEvent(rawEvent);
    expect(res.handled).toBe(true);

    const inboxRow = db.prepare(`SELECT status FROM channel_inbox WHERE native_event_id = ?`).get('evt_text_normal_01') as any;
    expect(inboxRow.status).toBe('delivered');
  });

  it('4. Intentional transient retry: HTTP transient error is bounded (max 3) with backoff, duplicate WS during backoff is ignored, concurrent claim is race-safe, and restart stays no-op', async () => {
    // Simulate HTTP transient timeout
    transport.failDownloadImage = true;
    transport.failDownloadImageReason = 'Image resource download timed out waiting for headers';

    let downloadAttempts = 0;
    let addReactionCount = 0;
    let removeReactionCount = 0;
    const origDownload = transport.downloadImageResource.bind(transport);
    const origAddReaction = transport.addReaction.bind(transport);
    const origRemoveReaction = transport.removeReaction.bind(transport);
    transport.downloadImageResource = async (...args) => {
      downloadAttempts++;
      return origDownload(...args);
    };
    transport.addReaction = async (...args) => {
      addReactionCount++;
      return origAddReaction(...args);
    };
    transport.removeReaction = async (...args) => {
      removeReactionCount++;
      return origRemoveReaction(...args);
    };

    const rawEvent: LarkRawEvent = {
      header: { event_id: 'evt_transient_retry_01', event_type: 'im.message.receive_v1', create_time: '400' },
      event: {
        sender: { sender_id: { open_id: 'ou_sender_transient' } },
        message: {
          message_id: 'om_transient_01',
          chat_id: 'oc_chat_transient',
          chat_type: 'p2p',
          message_type: 'image',
          content: JSON.stringify({ image_key: 'img_transient_001' }),
          create_time: '400',
        },
      },
    };

    // Attempt 1: Inbound event
    const res1 = await gateway.handleInboundEvent(rawEvent);
    expect(res1.handled).toBe(false);
    expect(downloadAttempts).toBe(1);
    expect(addReactionCount).toBe(1);
    expect(removeReactionCount).toBe(1);
    expect(transport.sentReplies).toHaveLength(1);

    // Classified as HTTP_TRANSIENT_NETWORK with retryable = true and attempt 1
    let inboxRow = db.prepare(`SELECT id, status, payload_json FROM channel_inbox WHERE native_event_id = ?`).get('evt_transient_retry_01') as any;
    let payload = JSON.parse(inboxRow.payload_json);
    expect(payload.retry.retryable).toBe(true);
    expect(payload.retry.terminal).toBe(false);
    expect(payload.retry.attempts).toBe(1);
    expect(payload.retry.maxAttempts).toBe(3);
    expect(payload.retry.failureCode).toBe('HTTP_TRANSIENT_NETWORK');
    expect(payload.retry.nextRetryAt).toBeDefined();

    // Verify: nextRetryAt is in the future (active backoff)
    expect(new Date(payload.retry.nextRetryAt).getTime()).toBeGreaterThan(Date.now());

    // --- GATE CHECK: Duplicate WS event during active backoff ---
    const dupDuringBackoff = await gateway.handleInboundEvent(rawEvent);
    expect(dupDuringBackoff.handled).toBe(false);
    expect(dupDuringBackoff.ignoredReason).toBe('duplicate_event');

    // Zero additional download, zero additional ACK add/remove, zero error resend
    expect(downloadAttempts).toBe(1);
    expect(addReactionCount).toBe(1);
    expect(removeReactionCount).toBe(1);
    expect(transport.sentReplies).toHaveLength(1);

    // CAS check: claimInboxForProcessing during active backoff fails atomically
    const directClaimDuringBackoff = await storage.forTenant(userId).channels.claimInboxForProcessing(inboxRow.id);
    expect(directClaimDuringBackoff).toBeNull();

    // Advance time past nextRetryAt in payload so backoff elapses
    payload.retry.nextRetryAt = new Date(Date.now() - 1000).toISOString();
    db.prepare(`UPDATE channel_inbox SET payload_json = ? WHERE native_event_id = ?`).run(
      JSON.stringify(payload),
      'evt_transient_retry_01'
    );

    // --- GATE CHECK: Concurrent claim when backoff elapsed yields exactly ONE claim ---
    // Simulate concurrent attempt: both worker tick and gateway WS competing to claim
    const [concurrentClaim1, concurrentClaim2] = await Promise.all([
      storage.forTenant(userId).channels.claimInboxForProcessing(inboxRow.id),
      storage.forTenant(userId).channels.claimInboxForProcessing(inboxRow.id),
    ]);
    const successfulClaims = [concurrentClaim1, concurrentClaim2].filter(Boolean);
    expect(successfulClaims).toHaveLength(1);

    // Restore to failed for Attempt 2 processing simulation
    await storage.forTenant(userId).channels.updateInboxStatus(inboxRow.id, 'failed');

    // Attempt 2: Worker tick retries
    await runtimeManager.runBackgroundWorkerTick();
    expect(downloadAttempts).toBe(2);

    inboxRow = db.prepare(`SELECT status, payload_json FROM channel_inbox WHERE native_event_id = ?`).get('evt_transient_retry_01') as any;
    payload = JSON.parse(inboxRow.payload_json);
    expect(payload.retry.attempts).toBe(2);
    expect(payload.retry.retryable).toBe(true);

    // Advance time past nextRetryAt again
    payload.retry.nextRetryAt = new Date(Date.now() - 1000).toISOString();
    db.prepare(`UPDATE channel_inbox SET payload_json = ? WHERE native_event_id = ?`).run(
      JSON.stringify(payload),
      'evt_transient_retry_01'
    );

    // Attempt 3: Worker tick retries and reaches maxAttempts (3) -> becomes terminal
    await runtimeManager.runBackgroundWorkerTick();
    expect(downloadAttempts).toBe(3);

    inboxRow = db.prepare(`SELECT status, payload_json FROM channel_inbox WHERE native_event_id = ?`).get('evt_transient_retry_01') as any;
    payload = JSON.parse(inboxRow.payload_json);
    expect(payload.retry.attempts).toBe(3);
    expect(payload.retry.retryable).toBe(false);
    expect(payload.retry.terminal).toBe(true);

    // Subsequent ticks do NOT retry anymore
    await runtimeManager.runBackgroundWorkerTick();
    await runtimeManager.runBackgroundWorkerTick();
    expect(downloadAttempts).toBe(3);

    // --- GATE CHECK: Terminal restart stays no-op ---
    await runtimeManager.stop();
    const restartedManager = new ChannelRuntimeManager({
      storage,
      db,
      deliveryGateway,
      transportFactory: () => transport,
      autoStart: false,
    });
    await restartedManager.start();

    // Run ticks on restarted manager
    for (let i = 0; i < 3; i++) {
      await restartedManager.runBackgroundWorkerTick();
    }
    expect(downloadAttempts).toBe(3);
    await restartedManager.stop();
  });

  it('5. Runtime acceptance smoke: exercises loaded CredentialedLarkTransport class rejecting fake image', async () => {
    // Create CredentialedLarkTransport with mock SDK client returning 404 for messageResource
    const mockApiClient = {
      im: {
        v1: {
          messageResource: {
            get: vi.fn().mockRejectedValue(new Error('Resource not found for key img_cred_smoke')),
          },
          message: {
            reply: vi.fn().mockResolvedValue({ data: { message_id: 'om_cred_reply_01' } }),
          },
        },
      },
    };

    const credTransport = new CredentialedLarkTransport({
      account: {
        id: 'ca_cred_smoke_acc',
        userId,
        name: 'Cred Smoke Bot',
        type: 'lark',
        status: 'active',
        appId: 'cli_cred_smoke_app',
        appSecret: 'secret',
        botOpenId: 'ou_cred_smoke_bot',
        brand: 'feishu',
      },
      clientFactory: {
        createClient: () => mockApiClient as any,
      },
    });

    await credTransport.start();

    // Register account in DB
    await storage.forTenant(userId).channels.createAccount({
      id: 'ca_cred_smoke_acc',
      name: 'Cred Smoke Bot',
      type: 'lark',
      status: 'active',
      appId: 'cli_cred_smoke_app',
      botOpenId: 'ou_cred_smoke_bot',
      defaultSpaceId: spaceId,
      groupActivationMode: 'mention',
    });

    // Create gateway with the loaded CredentialedLarkTransport class
    const smokeGateway = new LarkChannelGateway({
      account: {
        id: 'ca_cred_smoke_acc',
        userId,
        name: 'Cred Smoke Bot',
        type: 'lark',
        status: 'active',
        appId: 'cli_cred_smoke_app',
        botOpenId: 'ou_cred_smoke_bot',
        defaultSpaceId: spaceId,
        groupActivationMode: 'mention',
      },
      transport: credTransport,
      channelRepo: storage.forTenant(userId).channels,
      sessionRouteRepo: storage.forTenant(userId).sessionRoutes,
      runtimeGateway: deliveryGateway,
      defaultSpaceId: spaceId,
    });

    const smokeEvent: LarkRawEvent = {
      header: { event_id: 'evt_cred_smoke_01', event_type: 'im.message.receive_v1', create_time: '500' },
      event: {
        sender: { sender_id: { open_id: 'ou_smoke_sender' } },
        message: {
          message_id: 'om_cred_smoke_msg',
          chat_id: 'oc_chat_cred_smoke',
          chat_type: 'p2p',
          message_type: 'image',
          content: JSON.stringify({ image_key: 'img_cred_smoke' }),
          create_time: '500',
        },
      },
    };

    const res = await smokeGateway.handleInboundEvent(smokeEvent);
    expect(res.handled).toBe(false);
    expect(res.ignoredReason).toBe('transport_error');

    // Verify SDK client get was called
    expect(mockApiClient.im.v1.messageResource.get).toHaveBeenCalledTimes(1);

    // Verify inbox item classified as terminal failure
    const inboxRow = db.prepare(`SELECT status, payload_json FROM channel_inbox WHERE native_event_id = ?`).get('evt_cred_smoke_01') as any;
    expect(inboxRow.status).toBe('failed');
    const payload = JSON.parse(inboxRow.payload_json);
    expect(payload.retry.terminal).toBe(true);
    expect(payload.retry.retryable).toBe(false);

    // Verify SDK message.reply was called once via durable outbox delivery
    expect(mockApiClient.im.v1.message.reply).toHaveBeenCalledTimes(1);

    // Run 3 background worker ticks to verify no retries occur
    for (let i = 0; i < 3; i++) {
      await runtimeManager.runBackgroundWorkerTick();
    }
    expect(mockApiClient.im.v1.messageResource.get).toHaveBeenCalledTimes(1);
    expect(mockApiClient.im.v1.message.reply).toHaveBeenCalledTimes(1);
  });
});
