import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
} from '../src/storage/migrations.js';
import { WeChatRuntimeManager } from '../src/channels/wechat-runtime.js';
import { ChannelRuntimeManager } from '../src/channels/channel-runtime-manager.js';

/**
 * Turn completion attribution relies on channel_turn_origins: a turn that runs on a route bound to
 * WeChat or Lark but was started elsewhere (Web UI, Jarvis, another IM) is not forwarded to that IM.
 */
describe('channel turn attribution by origin', () => {
  const userId = 'user-alice';
  const spaceId = 'spc_00000000000000000000000000000001';
  const wechatRouteId = 'ses_00000000000000000000000000000001';
  const larkRouteId = 'ses_00000000000000000000000000000002';
  const peer = 'test-peer-01@im.wechat';
  const larkChat = 'oc_test0000000000000000000000000001';
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let wechatAccountId: string;
  let larkAccountId: string;
  let jarvisAccountId: string;

  const fakeDeliveryGateway: any = { getFileProvider: () => undefined };

  function completedEvent(turnId: string, sessionId: string, idempotencyKey: string, extra: Record<string, unknown> = {}) {
    return {
      userId,
      sessionId,
      spaceId,
      turnId,
      deliveryId: `deliv_${turnId}`,
      idempotencyKey,
      executionResult: { replyText: 'synthetic reply', usage: { totalTokens: 0 } } as any,
      tokenUsage: { tokens: 0 },
      ...extra,
    };
  }

  function recordOrigin(turnId: string, sessionId: string, accountId: string, channel: string, contextId: string) {
    db.prepare(`
      INSERT INTO channel_turn_origins (turn_id, user_id, session_id, account_id, channel, chat_id, native_context_id, native_event_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(turnId, userId, sessionId, accountId, channel, contextId, contextId, `evt_${turnId}`);
  }

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    await new PlatformServerMigrationRunner(db).migrate(ALL_PLATFORM_MIGRATIONS);
    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'alice', 'hash')`).run(userId);
    db.prepare(`INSERT INTO spaces (id, user_id, name, folder) VALUES (?, ?, 'Alice Space', 'alice-space')`).run(spaceId, userId);
    storage = new SqlitePlatformStorage({ database: db });
    const channels = storage.forTenant(userId).channels;
    wechatAccountId = (await channels.createAccount({ type: 'wechat', status: 'active' })).id;
    larkAccountId = (await channels.createAccount({ type: 'lark', status: 'active' })).id;
    jarvisAccountId = (await channels.createAccount({ type: 'jarvis', status: 'active' })).id;
    const routes = storage.forTenant(userId).sessionRoutes;
    await routes.create({
      id: wechatRouteId,
      spaceId,
      channel: 'wechat',
      accountId: wechatAccountId,
      nativeContextId: `wechat:${peer}`,
      dshSessionId: 'ses_00000000000000000000000000000101',
    });
    await routes.create({
      id: larkRouteId,
      spaceId,
      channel: 'lark',
      accountId: larkAccountId,
      nativeContextId: larkChat,
      dshSessionId: 'ses_00000000000000000000000000000102',
    });
  });

  describe('WeChat', () => {
    function createManager() {
      const manager = new WeChatRuntimeManager({ storage, db, deliveryGateway: fakeDeliveryGateway } as any);
      const gateway = { handleTurnCompleted: vi.fn().mockResolvedValue(undefined) };
      vi.spyOn(manager, 'getActiveGateway').mockReturnValue(gateway as any);
      (manager as any).isRunning = true;
      return { manager, gateway };
    }

    it('does not forward a Web UI turn on a WeChat-bound route', async () => {
      const { manager, gateway } = createManager();
      await manager.handleTurnCompleted(completedEvent('turn_web_0001', wechatRouteId, 'idem_web_0001'));
      await manager.handleTurnFailed({
        userId,
        sessionId: wechatRouteId,
        turnId: 'turn_web_0002',
        deliveryId: 'deliv_web_0002',
        idempotencyKey: 'idem_web_0002',
        code: 'EXECUTION_FAILED',
        reason: 'synthetic',
      });
      expect(gateway.handleTurnCompleted).not.toHaveBeenCalled();
    });

    it('does not forward a turn whose recorded origin is another channel', async () => {
      const { manager, gateway } = createManager();
      recordOrigin('turn_jarvis_0001', wechatRouteId, jarvisAccountId, 'jarvis', 'jarvis-context-01');
      await manager.handleTurnCompleted(completedEvent('turn_jarvis_0001', wechatRouteId, 'idem_jarvis_0001'));
      expect(gateway.handleTurnCompleted).not.toHaveBeenCalled();
    });

    it('still forwards a WeChat-origin turn', async () => {
      const { manager, gateway } = createManager();
      recordOrigin('turn_wechat_0001', wechatRouteId, wechatAccountId, 'wechat', `wechat:${peer}`);
      await manager.handleTurnCompleted(
        completedEvent('turn_wechat_0001', wechatRouteId, `idem_wechat_${wechatAccountId}_evt_turn_wechat_0001`)
      );
      expect(gateway.handleTurnCompleted).toHaveBeenCalledTimes(1);
      expect(gateway.handleTurnCompleted.mock.calls[0][0]).toMatchObject({
        sessionId: wechatRouteId,
        turnId: 'turn_wechat_0001',
        nativeContextId: `wechat:${peer}`,
      });
    });

    it('still forwards a turn attributed by a WeChat idempotency key', async () => {
      const { manager, gateway } = createManager();
      await manager.handleTurnCompleted(
        completedEvent('turn_wechat_0002', wechatRouteId, `idem_wechat_${wechatAccountId}_evt0002`)
      );
      expect(gateway.handleTurnCompleted).toHaveBeenCalledTimes(1);
    });
  });

  describe('Lark', () => {
    function createManager() {
      const manager = new ChannelRuntimeManager({ storage, db, deliveryGateway: fakeDeliveryGateway } as any);
      const gateway = {
        handleTurnCompleted: vi.fn().mockResolvedValue(undefined),
        sendProactiveMessage: vi.fn().mockResolvedValue({ success: true, messageId: 'om_test_proactive_0001' }),
      };
      vi.spyOn(manager, 'getActiveGateway').mockReturnValue(gateway as any);
      (manager as any).isRunning = true;
      return { manager, gateway };
    }

    it('keeps route-based delivery of task turns without a recorded origin', async () => {
      const { manager, gateway } = createManager();
      await manager.handleTurnCompleted(
        completedEvent('turn_task_0001', larkRouteId, 'idem_task_0001', { taskId: 'task_test_0001' })
      );
      expect(gateway.sendProactiveMessage).toHaveBeenCalledTimes(1);
      expect(gateway.sendProactiveMessage.mock.calls[0][0]).toMatchObject({ chatId: larkChat });
    });

    it('does not deliver a turn whose recorded origin is another channel', async () => {
      const { manager, gateway } = createManager();
      recordOrigin('turn_jarvis_0002', larkRouteId, jarvisAccountId, 'jarvis', 'jarvis-context-01');
      await manager.handleTurnCompleted(
        completedEvent('turn_jarvis_0002', larkRouteId, 'idem_jarvis_0002', { taskId: 'task_test_0002' })
      );
      expect(gateway.sendProactiveMessage).not.toHaveBeenCalled();
      expect(gateway.handleTurnCompleted).not.toHaveBeenCalled();
    });
  });
});
