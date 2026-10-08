import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { provisionFixtures } from '@enkeep/platform-auth';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import {
  PlatformServer,
  SqliteWebMessageStore,
} from '../src/index.js';
import { TestOnlyRuntimeGateway } from './test-runtime-gateway.js';
import { ChatCommandService } from '../src/chat/chat-command-service.js';
import { ModelSelectionService } from '../src/models/model-selection-service.js';

describe('Background Tasks API, Origin Mapping & Chat Commands', () => {
  let server: PlatformServer;
  let baseUrl: string;
  let aliceCookie: string;
  let bobCookie: string;
  let aliceSpaceId: string;
  let sessionId: string;
  let db: DatabaseSync;
  let chatCommandService: ChatCommandService;
  const testCsrfToken = 'bg-tasks-csrf-token-32-chars-long-sec!';

  const syntheticChildId = 'ses_00000000000000000000000000000099';
  const syntheticTurnId = 'turn_00000000000000000000000000000001';
  const syntheticNativeContextId = 'chat_feishu_oc_1234567890abcdef';

  beforeAll(async () => {
    db = new DatabaseSync(':memory:');
    const storage = new SqlitePlatformStorage(db);
    const messageStore = new SqliteWebMessageStore(db);

    const runtimeGateway = new TestOnlyRuntimeGateway({
      storage,
      messageStore,
      database: db,
      autoReply: true,
      autoReplyDelayMs: 10,
    });

    // Provide mock background tasks in gateway executor
    (runtimeGateway as any).gateway.executor = {
      execute: async () => ({ replyText: 'Executed' }),
      cancel: async () => true,
      listBackgroundTasks: async () => [
        {
          id: syntheticChildId,
          shortId: '0099',
          kind: 'subagent',
          name: 'Synthetic Background Worker',
          status: 'running',
          startedAt: new Date(Date.now() - 5000).toISOString(),
          lastActivityAt: new Date(Date.now() - 2000).toISOString(),
          stalled: false,
        },
        {
          id: 'job_00000000000000000000000000000055',
          shortId: '0055',
          kind: 'workflow',
          name: 'Synthetic Workflow Pipeline',
          status: 'running',
          startedAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
          lastActivityAt: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
          stalled: true,
          progress: { agentsDone: 2, agentsTotal: 5 },
        },
      ],
      stopBackgroundTask: async (_sessionId: string, _taskId: string) => ({
        stopped: true,
      }),
    };

    server = new PlatformServer({
      database: db,
      host: '127.0.0.1',
      port: 0,
      cookieSecret: 'bg-tasks-secret-key-32-chars-long!',
      csrfToken: testCsrfToken,
      runtimeGateway,
    });

    const addr = await server.start();
    baseUrl = addr.url;

    // Provision fixtures
    const fixtures = await provisionFixtures(server.storage, server.authService, {
      adminUsername: 'alice',
      adminPassword: 'AlicePassword123!',
      userPassword: 'BobPassword123!',
      disabledPassword: 'CharlieDisabledPassword123!',
    });
    aliceSpaceId = fixtures.adminContainerSpace.id;

    // Login Alice
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ username: 'alice', password: 'AlicePassword123!' }),
    });
    const loginJson = await loginRes.json();
    const aliceUserId = loginJson.data.user.id;
    aliceCookie = loginRes.headers.get('set-cookie')!;

    // Login Bob
    const bobLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ username: 'bob', password: 'BobPassword123!' }),
    });
    bobCookie = bobLoginRes.headers.get('set-cookie')!;

    // Create session for Alice
    const createSessionRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Cookie: aliceCookie,
        Origin: baseUrl,
      },
      body: JSON.stringify({ spaceId: aliceSpaceId, title: 'Background Tasks Test Session' }),
    });
    const createJson = await createSessionRes.json();
    sessionId = createJson.data.id;

    // Seed child-origin mapping and channel turn origin in database
    db.prepare(`
      INSERT INTO channel_accounts (id, user_id, type, status)
      VALUES ('acc_test_1', ?, 'lark', 'active')
    `).run(aliceUserId);

    db.prepare(`
      INSERT INTO channel_turn_origins (
        turn_id, user_id, session_id, account_id, channel, chat_id, native_context_id
      ) VALUES (?, ?, ?, 'acc_test_1', 'lark', 'oc_fake_chat', ?)
    `).run(syntheticTurnId, aliceUserId, sessionId, syntheticNativeContextId);

    db.prepare(`
      INSERT INTO session_child_origins (session_id, child_id, origin_turn_id)
      VALUES (?, ?, ?)
    `).run(sessionId, syntheticChildId, syntheticTurnId);

    const modelSelectionService = new ModelSelectionService({ db });
    chatCommandService = new ChatCommandService({
      db,
      modelSelectionService,
      gateway: runtimeGateway as any,
    });
  });

  afterAll(async () => {
    await server.stop();
  });

  it('GET /api/sessions/:sessionId/background returns background tasks with originChatContextId mapping', async () => {
    // 1. Unauthenticated request -> 401
    const unauthRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/background`);
    expect(unauthRes.status).toBe(401);

    // 2. Non-owner Bob request -> 404 (tenant isolation)
    const bobRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/background`, {
      headers: { Cookie: bobCookie },
    });
    expect(bobRes.status).toBe(404);

    // 3. Owner Alice request -> 200
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/background`, {
      headers: { Cookie: aliceCookie },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.items).toHaveLength(2);

    const subagentTask = json.data.items.find((t: any) => t.id === syntheticChildId);
    expect(subagentTask).toBeDefined();
    expect(subagentTask.kind).toBe('subagent');
    expect(subagentTask.originTurnId).toBe(syntheticTurnId);
    expect(subagentTask.originChatContextId).toBe(syntheticNativeContextId);
    expect(subagentTask.stalled).toBe(false);

    const workflowTask = json.data.items.find((t: any) => t.kind === 'workflow');
    expect(workflowTask).toBeDefined();
    expect(workflowTask.stalled).toBe(true);
    expect(workflowTask.progress).toEqual({ agentsDone: 2, agentsTotal: 5 });
  });

  it('GET /api/sessions/:sessionId/background supports chatContextId query filtering', async () => {
    // Match native context
    const filteredRes = await fetch(
      `${baseUrl}/api/sessions/${sessionId}/background?chatContextId=${encodeURIComponent(syntheticNativeContextId)}`,
      { headers: { Cookie: aliceCookie } }
    );
    expect(filteredRes.status).toBe(200);
    const filteredJson = await filteredRes.json();
    expect(filteredJson.data.items).toHaveLength(1);
    expect(filteredJson.data.items[0].id).toBe(syntheticChildId);

    // Unmatched native context
    const emptyRes = await fetch(
      `${baseUrl}/api/sessions/${sessionId}/background?chatContextId=chat_non_existent`,
      { headers: { Cookie: aliceCookie } }
    );
    expect(emptyRes.status).toBe(200);
    const emptyJson = await emptyRes.json();
    expect(emptyJson.data.items).toHaveLength(0);
  });

  it('POST /api/sessions/:sessionId/background/:taskId/stop checks CSRF & stops task', async () => {
    // Missing CSRF -> 403
    const noCsrfRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/background/0099/stop`, {
      method: 'POST',
      headers: { Cookie: aliceCookie, Origin: baseUrl },
    });
    expect(noCsrfRes.status).toBe(403);

    // Valid CSRF -> 200
    const stopRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/background/0099/stop`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': testCsrfToken,
        Cookie: aliceCookie,
        Origin: baseUrl,
      },
    });
    expect(stopRes.status).toBe(200);
    const stopJson = await stopRes.json();
    expect(stopJson.success).toBe(true);
    expect(stopJson.data.stopped).toBe(true);
  });

  it('chat command /bg lists tasks (filtered in channel, full in web)', async () => {
    // 1. Web context -> shows all tasks
    const webRes = await chatCommandService.execute({
      userId: 'user_alice',
      sessionId,
      spaceId: aliceSpaceId,
      content: '/bg',
      channelContext: { channel: 'web', chatType: 'p2p' } as any,
    });
    expect(webRes.replyText).toContain('[0099] Synthetic Background Worker · running');
    expect(webRes.replyText).toContain('[0055] Synthetic Workflow Pipeline · running ⚠️ 可能卡住');

    // 2. Channel context matching native context
    const channelRes = await chatCommandService.execute({
      userId: 'user_alice',
      sessionId,
      spaceId: aliceSpaceId,
      content: '/bg',
      channelContext: {
        channel: 'lark',
        chatType: 'p2p',
        nativeContextId: syntheticNativeContextId,
      } as any,
    });
    expect(channelRes.replyText).toContain('[0099] Synthetic Background Worker · running');
    expect(channelRes.replyText).not.toContain('[0055]');

    // 3. Channel context with no matching tasks
    const unmatchRes = await chatCommandService.execute({
      userId: 'user_alice',
      sessionId,
      spaceId: aliceSpaceId,
      content: '/bg',
      channelContext: {
        channel: 'lark',
        chatType: 'p2p',
        nativeContextId: 'chat_other_context',
      } as any,
    });
    expect(unmatchRes.replyText).toContain('当前聊天暂无后台任务。');
  });

  it('chat command /bg stop stops task, subject to group admin gate', async () => {
    // 1. Direct p2p execution
    const stopRes = await chatCommandService.execute({
      userId: 'user_alice',
      sessionId,
      spaceId: aliceSpaceId,
      content: '/bg stop 0099',
      channelContext: { channel: 'web', chatType: 'p2p' } as any,
    });
    expect(stopRes.replyText).toContain('后台任务 0099 已停止。');

    // 2. Group chat with non-admin check
    chatCommandService.setCheckChatAdmin(async () => false);
    const groupBlockedRes = await chatCommandService.execute({
      userId: 'user_alice',
      sessionId,
      spaceId: aliceSpaceId,
      content: '/bg stop 0099',
      channelContext: { channel: 'lark', chatType: 'group' } as any,
    });
    expect(groupBlockedRes.replyText).toContain('群聊中仅群主或管理员可执行此指令。');

    // 3. Group chat with admin check allowed
    chatCommandService.setCheckChatAdmin(async () => true);
    const groupAllowedRes = await chatCommandService.execute({
      userId: 'user_alice',
      sessionId,
      spaceId: aliceSpaceId,
      content: '/bg stop 0099',
      channelContext: { channel: 'lark', chatType: 'group' } as any,
    });
    expect(groupAllowedRes.replyText).toContain('后台任务 0099 已停止。');
  });

  it('/status command includes background count line', async () => {
    const statusRes = await chatCommandService.execute({
      userId: 'user_alice',
      sessionId,
      spaceId: aliceSpaceId,
      content: '/status',
      channelContext: { channel: 'web', chatType: 'p2p' } as any,
    });
    expect(statusRes.replyText).toContain('background: 2 running');
  });
});
