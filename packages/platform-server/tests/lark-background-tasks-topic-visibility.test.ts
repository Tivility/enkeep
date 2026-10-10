import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { DeliveryRuntimeGateway } from '../src/runtime/delivery-gateway.js';
import { ChatCommandService } from '../src/chat/chat-command-service.js';
import { ModelSelectionService } from '../src/models/model-selection-service.js';
import { LarkBackgroundPanelManager } from '@enkeep/channel-lark';

describe('Production Bug Verification: Lark Background Tasks Panel & /bg Visibility', () => {
  let db: DatabaseSync;
  let deliveryGateway: DeliveryRuntimeGateway;
  let chatCommandService: ChatCommandService;

  const aliceUserId = 'usr_synth_alice_000000000000001';
  const sessionRouteId = 'ses_synth_route_00000000000001';
  const dshSessionId = 'dsh_synth_session_000000000001';
  const spaceId = 'spc_synth_space_000000000000001';
  const accountId = 'acc_synth_lark_000000000000001';
  const groupChatId = 'oc_synth_chat_0000000000000001';
  const otherChatId = 'oc_synth_chat_0000000000000002';
  const wechatPeerId = 'synth-peer-01@im.wechat';
  const wechatContextId = `wechat:${wechatPeerId}`;

  const topicTurnId = 'turn_synth_lark_topic_turn_001';
  const topicContextId = `${groupChatId}:om_synth_thread_001`;

  const otherChatTurnId = 'turn_synth_lark_other_turn_001';
  const wechatTurnId = 'turn_synth_wechat_turn_001';

  const rootTurnId = 'turn_synth_root_plat_000000001';
  const autoTurn1Id = 'turn_auto_synth_00000001';
  const autoTurn2Id = 'turn_auto_synth_00000002';

  const subagentTaskId = 'subagent_synth_000000000000001';
  const workflowTaskId = 'workflow_synth_000000000000001';
  const otherChatTaskId = 'subagent_other_000000000000001';
  const wechatTaskId = 'subagent_wechat_000000000000001';
  const autoChainedTaskId = 'workflow_chained_0000000000001';
  const fallbackTaskId = 'subagent_fallback_000000000001';

  beforeAll(() => {
    db = new DatabaseSync(':memory:');

    // Create schema
    db.exec(`
      CREATE TABLE spaces (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        folder TEXT NOT NULL,
        execution_mode TEXT NOT NULL DEFAULT 'container',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE session_routes (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'web',
        account_id TEXT,
        native_context_id TEXT,
        peer_id TEXT,
        dsh_session_id TEXT NOT NULL,
        execution_mode TEXT NOT NULL DEFAULT 'container',
        current_generation INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        title TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE channel_turn_origins (
        turn_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        native_context_id TEXT NOT NULL,
        native_event_id TEXT,
        reply_to_message_id TEXT,
        root_id TEXT,
        thread_id TEXT,
        origin_turn_id TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE web_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE session_child_origins (
        session_id TEXT NOT NULL,
        child_id TEXT NOT NULL,
        origin_turn_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(session_id, child_id)
      );

      CREATE TABLE channel_bindings (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'lark',
        account_id TEXT,
        native_context_id TEXT NOT NULL,
        activation_mode TEXT NOT NULL DEFAULT 'always',
        chat_type TEXT,
        session_route_id TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Seed space and session route
    db.prepare(`
      INSERT INTO spaces (id, user_id, name, folder, execution_mode)
      VALUES (?, ?, 'Test Space', 'space_test', 'container')
    `).run(spaceId, aliceUserId);

    db.prepare(`
      INSERT INTO session_routes (id, space_id, user_id, channel, account_id, native_context_id, dsh_session_id, execution_mode)
      VALUES (?, ?, ?, 'lark', ?, ?, ?, 'container')
    `).run(sessionRouteId, spaceId, aliceUserId, accountId, groupChatId, dshSessionId);

    // 1. Topic turn origin (chatId=groupChatId, nativeContextId='groupChatId:threadId')
    db.prepare(`
      INSERT INTO channel_turn_origins (turn_id, user_id, session_id, account_id, channel, chat_id, native_context_id, thread_id)
      VALUES (?, ?, ?, ?, 'lark', ?, ?, 'om_synth_thread_001')
    `).run(topicTurnId, aliceUserId, sessionRouteId, accountId, groupChatId, topicContextId);

    // 2. Other chat turn origin
    db.prepare(`
      INSERT INTO channel_turn_origins (turn_id, user_id, session_id, account_id, channel, chat_id, native_context_id)
      VALUES (?, ?, ?, ?, 'lark', ?, ?)
    `).run(otherChatTurnId, aliceUserId, sessionRouteId, accountId, otherChatId, otherChatId);

    // 3. WeChat turn origin with colon in native_context_id ('wechat:synth-peer-01@im.wechat')
    db.prepare(`
      INSERT INTO channel_turn_origins (turn_id, user_id, session_id, account_id, channel, chat_id, native_context_id)
      VALUES (?, ?, ?, ?, 'wechat', ?, ?)
    `).run(wechatTurnId, aliceUserId, sessionRouteId, 'acc_synth_wechat', wechatContextId, wechatContextId);

    // 4. Autonomous turn chain: rootTurnId (lark topic) -> autoTurn1Id -> autoTurn2Id
    db.prepare(`
      INSERT INTO channel_turn_origins (turn_id, user_id, session_id, account_id, channel, chat_id, native_context_id, thread_id)
      VALUES (?, ?, ?, ?, 'lark', ?, ?, 'om_synth_thread_001')
    `).run(rootTurnId, aliceUserId, sessionRouteId, accountId, groupChatId, topicContextId);

    db.prepare(`
      INSERT INTO web_events (id, session_id, user_id, type, payload)
      VALUES ('evt_auto_1', ?, ?, 'turn_status', ?)
    `).run(sessionRouteId, aliceUserId, JSON.stringify({
      status: 'completed',
      turnId: autoTurn1Id,
      originTurnId: rootTurnId,
    }));

    db.prepare(`
      INSERT INTO web_events (id, session_id, user_id, type, payload)
      VALUES ('evt_auto_2', ?, ?, 'turn_status', ?)
    `).run(sessionRouteId, aliceUserId, JSON.stringify({
      status: 'completed',
      turnId: autoTurn2Id,
      originTurnId: autoTurn1Id,
    }));

    // Mock executor returning background tasks with originTurnId from runtime daemon
    const mockExecutor = {
      execute: async () => ({ replyText: 'mock' }),
      cancel: async () => true,
      listBackgroundTasks: async (_req: any) => [
        {
          id: subagentTaskId,
          shortId: 'sa01',
          kind: 'subagent' as const,
          name: 'Topic Subagent Task',
          status: 'running' as const,
          startedAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          originTurnId: topicTurnId,
        },
        {
          id: workflowTaskId,
          shortId: 'wf01',
          kind: 'workflow' as const,
          name: 'Topic Workflow Task',
          status: 'running' as const,
          startedAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          originTurnId: topicTurnId,
        },
        {
          id: otherChatTaskId,
          shortId: 'oc01',
          kind: 'subagent' as const,
          name: 'Other Chat Subagent Task',
          status: 'running' as const,
          startedAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          originTurnId: otherChatTurnId,
        },
        {
          id: wechatTaskId,
          shortId: 'wx01',
          kind: 'subagent' as const,
          name: 'WeChat Subagent Task',
          status: 'running' as const,
          startedAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          originTurnId: wechatTurnId,
        },
        {
          id: autoChainedTaskId,
          shortId: 'ac01',
          kind: 'workflow' as const,
          name: 'Autonomous Chained Workflow Task',
          status: 'running' as const,
          startedAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          originTurnId: autoTurn2Id, // Chained via web_events to rootTurnId
        },
        {
          id: fallbackTaskId,
          shortId: 'fb01',
          kind: 'subagent' as const,
          name: 'Guarded Fallback Subagent Task',
          status: 'running' as const,
          startedAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          // No originTurnId provided: will test fallback logic
        },
      ],
      stopBackgroundTask: async () => ({ stopped: true }),
    };

    deliveryGateway = new DeliveryRuntimeGateway({
      storage: {} as any,
      messageStore: {} as any,
      database: db,
      executor: mockExecutor as any,
      quotaMode: 'disabled',
      profileResolver: { resolve: async () => ({ profileId: 'default' }) } as any,
    });

    const modelSelectionService = new ModelSelectionService({ db });
    chatCommandService = new ChatCommandService({
      db,
      modelSelectionService,
      gateway: deliveryGateway as any,
    });
  });

  afterAll(() => {
    db.close();
  });

  it('1. Web (unfiltered) returns all tasks unchanged', async () => {
    const res = await deliveryGateway.getBackgroundTasks(aliceUserId, sessionRouteId);
    expect(res.items).toHaveLength(6);
    expect(res.items.map((t) => t.shortId).sort()).toEqual(['ac01', 'fb01', 'oc01', 'sa01', 'wf01', 'wx01']);
  });

  it('2. Subagent and workflow started in a Lark topic turn show in that chat’s panel (chatId filter)', async () => {
    // Lark caller passes chatId (e.g. groupChatId) as chatContextId
    const res = await deliveryGateway.getBackgroundTasks(aliceUserId, sessionRouteId, {
      chatContextId: groupChatId,
    });

    const ids = res.items.map((t) => t.shortId);
    // Should include topic tasks (sa01, wf01), chained autonomous task (ac01)
    expect(ids).toContain('sa01');
    expect(ids).toContain('wf01');
    expect(ids).toContain('ac01');

    // Tasks started from other chat (oc01) and wechat (wx01) must NOT appear
    expect(ids).not.toContain('oc01');
    expect(ids).not.toContain('wx01');
  });

  it('3. /bg command executed in Lark topic chat displays topic tasks and excludes other chats', async () => {
    const cmdRes = await chatCommandService.execute({
      userId: aliceUserId,
      sessionId: sessionRouteId,
      spaceId,
      content: '/bg',
      channelContext: {
        channel: 'lark',
        chatType: 'group',
        chatId: groupChatId,
        nativeContextId: topicContextId,
      } as any,
    });

    expect(cmdRes.replyText).toContain('[sa01] Topic Subagent Task · running');
    expect(cmdRes.replyText).toContain('[wf01] Topic Workflow Task · running');
    expect(cmdRes.replyText).toContain('[ac01] Autonomous Chained Workflow Task · running');
    expect(cmdRes.replyText).not.toContain('[oc01]');
    expect(cmdRes.replyText).not.toContain('[wx01]');
  });

  it('4. Autonomous-turn-started workflow resolves via event chain to originating Lark chat', async () => {
    const res = await deliveryGateway.getBackgroundTasks(aliceUserId, sessionRouteId, {
      chatContextId: groupChatId,
    });
    const chained = res.items.find((t) => t.id === autoChainedTaskId);
    expect(chained).toBeDefined();
    expect(chained?.originChatContextId).toBe(topicContextId);
  });

  it('5. WeChat native context IDs containing colons (wechat:...) are compared whole and matched correctly', async () => {
    const wechatRes = await deliveryGateway.getBackgroundTasks(aliceUserId, sessionRouteId, {
      chatContextId: wechatContextId,
    });

    expect(wechatRes.items).toHaveLength(1);
    expect(wechatRes.items[0].shortId).toBe('wx01');
    expect(wechatRes.items[0].id).toBe(wechatTaskId);
    expect(wechatRes.items[0].originChatContextId).toBe(wechatContextId);
  });

  it('6. Guarded fallback: single unique chat context within 24h resolves; conflicting chat contexts exclude', async () => {
    // In our setup, all rows in session_routes/channel_turn_origins have multiple chats (groupChatId, otherChatId, wechatContextId),
    // so fallback resolution safely returns null and excludes the unknown-origin task when filtering by chat.
    const filteredRes = await deliveryGateway.getBackgroundTasks(aliceUserId, sessionRouteId, {
      chatContextId: groupChatId,
    });
    expect(filteredRes.items.map((t) => t.shortId)).not.toContain('fb01');

    // Positive case: session with only 1 unique chat context in last 24h
    const singleChatSessionId = 'ses_synth_single_chat_001';
    const singleChatDshSessionId = 'dsh_synth_single_1';
    const singleChatId = 'oc_synth_single_only';
    const singleTurnId = 'turn_synth_single_1';
    db.prepare(`
      INSERT INTO session_routes (id, space_id, user_id, channel, account_id, native_context_id, dsh_session_id, execution_mode)
      VALUES (?, ?, ?, 'lark', ?, ?, ?, 'container')
    `).run(singleChatSessionId, spaceId, aliceUserId, accountId, singleChatId, singleChatDshSessionId);

    db.prepare(`
      INSERT INTO channel_turn_origins (turn_id, user_id, session_id, account_id, channel, chat_id, native_context_id, created_at)
      VALUES (?, ?, ?, ?, 'lark', ?, ?, datetime('now'))
    `).run(singleTurnId, aliceUserId, singleChatSessionId, accountId, singleChatId, singleChatId);

    // Override mockExecutor on deliveryGateway for single chat session
    const origList = (deliveryGateway as any).executor.listBackgroundTasks;
    (deliveryGateway as any).executor.listBackgroundTasks = async (req: any) => {
      if (req.dshSessionId === singleChatDshSessionId) {
        return [
          {
            id: 'subagent_single_fallback_01',
            shortId: 'sfb1',
            kind: 'subagent' as const,
            name: 'Single Fallback Subagent',
            status: 'running' as const,
            startedAt: new Date().toISOString(),
            lastActivityAt: new Date().toISOString(),
            originTurnId: 'turn_unknown_non_existent',
          },
        ];
      }
      return origList(req);
    };

    const singleRes = await deliveryGateway.getBackgroundTasks(aliceUserId, singleChatSessionId, {
      chatContextId: singleChatId,
    });
    expect(singleRes.items).toHaveLength(1);
    expect(singleRes.items[0].shortId).toBe('sfb1');
    expect(singleRes.items[0].originChatContextId).toBe(singleChatId);

    // Restore original mock
    (deliveryGateway as any).executor.listBackgroundTasks = origList;
  });

  it('7. Lark Background Panel Manager integrates seamlessly with getBackgroundTasks', async () => {
    let queriedOpts: any = null;
    const panelManager = new LarkBackgroundPanelManager({
      getBackgroundTasks: async (sessionId, opts) => {
        queriedOpts = opts;
        return deliveryGateway.getBackgroundTasks(aliceUserId, sessionId, opts);
      },
    });

    const res = await (panelManager as any).getBackgroundTasksFn(sessionRouteId, {
      chatContextId: groupChatId,
    });

    expect(queriedOpts?.chatContextId).toBe(groupChatId);
    expect(res.items.some((t: any) => t.shortId === 'sa01')).toBe(true);
    expect(res.items.some((t: any) => t.shortId === 'wf01')).toBe(true);
    expect(res.items.some((t: any) => t.shortId === 'oc01')).toBe(false);
  });

  it('8. Subagent task with no originTurnId/originChatContextId is visible when session route bound chat matches, and hidden when it does not', async () => {
    const routeSessionId = 'ses_synth_no_origin_001';
    const dshSessionId = 'dsh_synth_no_origin_001';
    const boundChatId = 'oc_synth_bound_chat_001';
    const differentChatId = 'oc_synth_diff_chat_002';

    db.prepare(`
      INSERT INTO session_routes (id, space_id, user_id, channel, account_id, native_context_id, dsh_session_id, execution_mode)
      VALUES (?, ?, ?, 'lark', ?, ?, ?, 'container')
    `).run(routeSessionId, spaceId, aliceUserId, accountId, boundChatId, dshSessionId);

    db.prepare(`
      INSERT INTO channel_bindings (id, space_id, user_id, channel, account_id, native_context_id, session_route_id)
      VALUES ('bnd_synth_no_origin_001', ?, ?, 'lark', ?, ?, ?)
    `).run(spaceId, aliceUserId, accountId, boundChatId, routeSessionId);

    const origList = (deliveryGateway as any).executor.listBackgroundTasks;
    (deliveryGateway as any).executor.listBackgroundTasks = async (req: any) => {
      if (req.dshSessionId === dshSessionId) {
        return [
          {
            id: 'subagent_no_origin_01',
            shortId: 'sno1',
            kind: 'subagent' as const,
            name: 'Workflow Derived Subagent Without Origin',
            status: 'running' as const,
            startedAt: new Date().toISOString(),
            lastActivityAt: new Date().toISOString(),
            // originTurnId and originChatContextId are undefined
          },
        ];
      }
      return origList(req);
    };

    // When queried with matching bound chat -> task is visible
    const matchRes = await deliveryGateway.getBackgroundTasks(aliceUserId, routeSessionId, {
      chatContextId: boundChatId,
    });
    expect(matchRes.items).toHaveLength(1);
    expect(matchRes.items[0].shortId).toBe('sno1');

    // When queried with a different chatContextId -> task is filtered out
    const diffRes = await deliveryGateway.getBackgroundTasks(aliceUserId, routeSessionId, {
      chatContextId: differentChatId,
    });
    expect(diffRes.items).toHaveLength(0);

    // /bg stop command also uses the same filter: allowed on matching chat, rejected on different chat
    chatCommandService.setCheckChatAdmin(async () => true);
    const stopMatching = await chatCommandService.execute({
      userId: aliceUserId,
      sessionId: routeSessionId,
      spaceId,
      content: '/bg stop sno1',
      channelContext: {
        channel: 'lark',
        chatType: 'group',
        chatId: boundChatId,
        nativeContextId: boundChatId,
      } as any,
    });
    expect(stopMatching.replyText).toContain('已停止');

    const stopDiff = await chatCommandService.execute({
      userId: aliceUserId,
      sessionId: routeSessionId,
      spaceId,
      content: '/bg stop sno1',
      channelContext: {
        channel: 'lark',
        chatType: 'group',
        chatId: differentChatId,
        nativeContextId: differentChatId,
      } as any,
    });
    expect(stopDiff.replyText).toContain('未找到后台任务');

    (deliveryGateway as any).executor.listBackgroundTasks = origList;
  });

  it('9. Topic session where session_routes.native_context_id is session id and channel_bindings points to topic chat: task with no origin is visible in topic chat, hidden in other chat', async () => {
    const topicRouteId = 'ses_synth_topic_route_002';
    const topicDshId = 'dsh_synth_topic_session_002';
    const topicChatId = 'oc_synth_topic_chat_009';
    const otherChatId = 'oc_synth_topic_chat_other_010';

    // In topic session: session_routes.native_context_id is the session id itself, NOT a chat context
    db.prepare(`
      INSERT INTO session_routes (id, space_id, user_id, channel, account_id, native_context_id, dsh_session_id, execution_mode)
      VALUES (?, ?, ?, 'lark', ?, ?, ?, 'container')
    `).run(topicRouteId, spaceId, aliceUserId, accountId, topicRouteId, topicDshId);

    // channel_bindings links the session route to the actual topic chat
    db.prepare(`
      INSERT INTO channel_bindings (id, space_id, user_id, channel, account_id, native_context_id, session_route_id)
      VALUES ('bnd_synth_001', ?, ?, 'lark', ?, ?, ?)
    `).run(spaceId, aliceUserId, accountId, topicChatId, topicRouteId);

    const origList = (deliveryGateway as any).executor.listBackgroundTasks;
    (deliveryGateway as any).executor.listBackgroundTasks = async (req: any) => {
      if (req.dshSessionId === topicDshId) {
        return [
          {
            id: 'subagent_topic_no_origin_01',
            shortId: 'stno1',
            kind: 'subagent' as const,
            name: 'Topic Session Subagent Without Origin',
            status: 'running' as const,
            startedAt: new Date().toISOString(),
            lastActivityAt: new Date().toISOString(),
          },
        ];
      }
      return origList(req);
    };

    // Visible under topic chat
    const topicRes = await deliveryGateway.getBackgroundTasks(aliceUserId, topicRouteId, {
      chatContextId: topicChatId,
    });
    expect(topicRes.items).toHaveLength(1);
    expect(topicRes.items[0].shortId).toBe('stno1');

    // Also works when passed dshSessionId as sessionId parameter
    const dshTopicRes = await deliveryGateway.getBackgroundTasks(aliceUserId, topicDshId, {
      chatContextId: topicChatId,
    });
    expect(dshTopicRes.items).toHaveLength(1);
    expect(dshTopicRes.items[0].shortId).toBe('stno1');

    // Hidden in other chat
    const otherRes = await deliveryGateway.getBackgroundTasks(aliceUserId, topicRouteId, {
      chatContextId: otherChatId,
    });
    expect(otherRes.items).toHaveLength(0);

    (deliveryGateway as any).executor.listBackgroundTasks = origList;
  });
});
