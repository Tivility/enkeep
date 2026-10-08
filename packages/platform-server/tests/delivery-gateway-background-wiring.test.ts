import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { provisionFixtures } from '@enkeep/platform-auth';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { LarkBackgroundPanelManager } from '@enkeep/channel-lark';
import {
  PlatformServer,
  SqliteWebMessageStore,
  DeliveryRuntimeGateway,
  RuntimeProviderRegistry,
  CompositeDeliveryTurnExecutor,
  type DeliveryTurnExecutor,
  type BackgroundTask,
} from '../src/index.js';
import { ChatCommandService } from '../src/chat/chat-command-service.js';
import { ModelSelectionService } from '../src/models/model-selection-service.js';

describe('Cross-Layer DeliveryGateway & ProviderRegistry Background Tasks Wiring', () => {
  let db: DatabaseSync;
  let server: PlatformServer;
  let baseUrl: string;
  let aliceCookie: string;
  let aliceUserId: string;
  let hostSpaceId: string;
  let containerSpaceId: string;
  let chatCommandService: ChatCommandService;
  let runtimeGateway: DeliveryRuntimeGateway;

  const testCsrfToken = 'wiring-csrf-token-32-chars-long-sec!';

  const hostRouteId = 'ses_synth_host_route_001';
  const hostDshSessionId = 'dsh_synth_host_gen_001';

  const containerRouteId = 'ses_synth_cont_route_002';
  const containerDshSessionId = 'dsh_synth_cont_gen_002';

  const syntheticChildId = 'ses_synth_child_worker_0099';
  const syntheticTurnId = 'turn_synth_000000000000000000000001';
  const syntheticNativeContextId = 'chat_feishu_oc_synth_000000000001';

  const containerCalls: { list: string[]; stop: Array<{ sessionId: string; taskId: string }> } = {
    list: [],
    stop: [],
  };

  const hostCalls: { list: string[]; stop: Array<{ sessionId: string; taskId: string }> } = {
    list: [],
    stop: [],
  };

  const fakeContainerTurnExecutor: DeliveryTurnExecutor = {
    execute: async () => ({ replyText: 'Container turn executed' }),
    cancel: async () => true,
    listBackgroundTasks: async (sessionId: string): Promise<BackgroundTask[]> => {
      containerCalls.list.push(sessionId);
      if (sessionId === containerDshSessionId) {
        return [
          {
            id: 'job_synth_cont_001',
            shortId: 'c001',
            kind: 'workflow',
            name: 'Container Workflow Task',
            status: 'running',
            startedAt: new Date(Date.now() - 30000).toISOString(),
            lastActivityAt: new Date(Date.now() - 5000).toISOString(),
            stalled: false,
            progress: { agentsDone: 1, agentsTotal: 3 },
          },
        ];
      }
      return [];
    },
    stopBackgroundTask: async (sessionId: string, taskId: string) => {
      containerCalls.stop.push({ sessionId, taskId });
      return { stopped: true };
    },
  };

  const fakeHostTurnExecutor: DeliveryTurnExecutor = {
    execute: async () => ({ replyText: 'Host turn executed' }),
    cancel: async () => true,
    listBackgroundTasks: async (sessionId: string): Promise<BackgroundTask[]> => {
      hostCalls.list.push(sessionId);
      if (sessionId === hostDshSessionId) {
        return [
          {
            id: syntheticChildId,
            shortId: 'h099',
            kind: 'subagent',
            name: 'Host Subagent Worker',
            status: 'running',
            startedAt: new Date(Date.now() - 60000).toISOString(),
            lastActivityAt: new Date(Date.now() - 10000).toISOString(),
            stalled: false,
          },
          {
            id: 'job_synth_host_002',
            shortId: 'h002',
            kind: 'workflow',
            name: 'Host Workflow Pipeline',
            status: 'running',
            startedAt: new Date(Date.now() - 120000).toISOString(),
            lastActivityAt: new Date(Date.now() - 15000).toISOString(),
            stalled: false,
            progress: { agentsDone: 2, agentsTotal: 4 },
          },
        ];
      }
      return [];
    },
    stopBackgroundTask: async (sessionId: string, taskId: string) => {
      hostCalls.stop.push({ sessionId, taskId });
      return { stopped: true };
    },
  };

  beforeAll(async () => {
    db = new DatabaseSync(':memory:');
    const storage = new SqlitePlatformStorage(db);
    const messageStore = new SqliteWebMessageStore(db);

    const registry = new RuntimeProviderRegistry();
    registry.registerProvider({
      mode: 'container',
      turnExecutor: fakeContainerTurnExecutor,
    });
    registry.registerProvider({
      mode: 'host',
      turnExecutor: fakeHostTurnExecutor,
    });

    const compositeExecutor = new CompositeDeliveryTurnExecutor(registry, db);

    runtimeGateway = new DeliveryRuntimeGateway({
      storage,
      messageStore,
      database: db,
      executor: compositeExecutor,
      quotaMode: 'disabled',
      profileResolver: { resolve: async () => null },
    });

    server = new PlatformServer({
      database: db,
      host: '127.0.0.1',
      port: 0,
      cookieSecret: 'wiring-test-secret-key-32-chars-long!',
      csrfToken: testCsrfToken,
      runtimeGateway,
      runtimeProviderRegistry: registry,
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
    aliceUserId = fixtures.admin.id;

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
    aliceCookie = loginRes.headers.get('set-cookie')!;

    // Create host space & container space in DB
    hostSpaceId = 'spc_synth_host_0000000000000001';
    containerSpaceId = 'spc_synth_container_0000000001';

    db.prepare(`
      INSERT INTO spaces (id, user_id, name, folder, execution_mode, status)
      VALUES (?, ?, 'Host Space', 'host-ws', 'host', 'active')
    `).run(hostSpaceId, aliceUserId);

    db.prepare(`
      INSERT INTO spaces (id, user_id, name, folder, execution_mode, status)
      VALUES (?, ?, 'Container Space', 'container-ws', 'container', 'active')
    `).run(containerSpaceId, aliceUserId);

    // Insert host session route where route id != dsh_session_id
    db.prepare(`
      INSERT INTO session_routes (
        id, space_id, user_id, channel, account_id, native_context_id, peer_id,
        dsh_session_id, execution_mode, current_generation, status, title
      ) VALUES (?, ?, ?, 'lark', 'acc_lark_1', ?, 'peer_1', ?, 'host', 1, 'active', 'Host Wiring Session')
    `).run(hostRouteId, hostSpaceId, aliceUserId, syntheticNativeContextId, hostDshSessionId);

    // Insert container session route where route id != dsh_session_id
    db.prepare(`
      INSERT INTO session_routes (
        id, space_id, user_id, channel, account_id, native_context_id, peer_id,
        dsh_session_id, execution_mode, current_generation, status, title
      ) VALUES (?, ?, ?, 'web', 'default', ?, 'peer_2', ?, 'container', 1, 'active', 'Container Wiring Session')
    `).run(containerRouteId, containerSpaceId, aliceUserId, containerRouteId, containerDshSessionId);

    // Seed channel turn origins and child origins for host route
    db.prepare(`
      INSERT INTO channel_accounts (id, user_id, type, status)
      VALUES ('acc_lark_1', ?, 'lark', 'active')
    `).run(aliceUserId);

    db.prepare(`
      INSERT INTO channel_turn_origins (
        turn_id, user_id, session_id, account_id, channel, chat_id, native_context_id
      ) VALUES (?, ?, ?, 'acc_lark_1', 'lark', 'oc_fake_chat', ?)
    `).run(syntheticTurnId, aliceUserId, hostRouteId, syntheticNativeContextId);

    db.prepare(`
      INSERT INTO session_child_origins (session_id, child_id, origin_turn_id)
      VALUES (?, ?, ?)
    `).run(hostRouteId, syntheticChildId, syntheticTurnId);

    const modelSelectionService = new ModelSelectionService({ db });
    chatCommandService = new ChatCommandService({
      db,
      modelSelectionService,
      gateway: runtimeGateway,
    });
  });

  afterAll(async () => {
    await server.stop();
  });

  it('1. GET /api/sessions/:id/background translates routeId -> dsh_session_id, routes to host provider, and enriches origins', async () => {
    hostCalls.list = [];
    containerCalls.list = [];

    const res = await fetch(`${baseUrl}/api/sessions/${hostRouteId}/background`, {
      headers: { Cookie: aliceCookie },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);

    // CRITICAL: Verify the runtime adapter received dsh_session_id, NOT route id or user id!
    expect(hostCalls.list).toContain(hostDshSessionId);
    expect(hostCalls.list).not.toContain(hostRouteId);
    expect(hostCalls.list).not.toContain(aliceUserId);

    expect(json.data.items).toHaveLength(2);
    const subagentTask = json.data.items.find((t: any) => t.id === syntheticChildId);
    expect(subagentTask).toBeDefined();
    expect(subagentTask.shortId).toBe('h099');
    expect(subagentTask.originTurnId).toBe(syntheticTurnId);
    expect(subagentTask.originChatContextId).toBe(syntheticNativeContextId);
  });

  it('2. GET /api/sessions/:id/background routes container space sessions to container provider', async () => {
    hostCalls.list = [];
    containerCalls.list = [];

    const res = await fetch(`${baseUrl}/api/sessions/${containerRouteId}/background`, {
      headers: { Cookie: aliceCookie },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);

    // Verify container adapter received containerDshSessionId
    expect(containerCalls.list).toContain(containerDshSessionId);
    expect(json.data.items).toHaveLength(1);
    expect(json.data.items[0].shortId).toBe('c001');
    expect(json.data.items[0].name).toBe('Container Workflow Task');
  });

  it('3. /bg command queries through DeliveryGateway and renders tasks with correct dsh_session_id', async () => {
    hostCalls.list = [];

    const cmdRes = await chatCommandService.execute({
      userId: aliceUserId,
      sessionId: hostRouteId,
      spaceId: hostSpaceId,
      content: '/bg',
      channelContext: { channel: 'web', chatType: 'p2p' } as any,
    });

    expect(hostCalls.list).toContain(hostDshSessionId);
    expect(cmdRes.replyText).toContain('[h099] Host Subagent Worker · running');
    expect(cmdRes.replyText).toContain('[h002] Host Workflow Pipeline · running (2/4 agents)');
  });

  it('4. Lark Background Panel manager callback queries through DeliveryGateway and returns items', async () => {
    hostCalls.list = [];

    const panelManager = new LarkBackgroundPanelManager({
      getBackgroundTasks: async (sessionId, opts) => {
        return runtimeGateway.getBackgroundTasks(aliceUserId, sessionId, opts);
      },
    });

    const tasksRes = await (panelManager as any).getBackgroundTasksFn(hostRouteId, {
      chatContextId: syntheticNativeContextId,
    });

    expect(hostCalls.list).toContain(hostDshSessionId);
    expect(tasksRes.items).toHaveLength(1);
    expect(tasksRes.items[0].id).toBe(syntheticChildId);
    expect(tasksRes.items[0].shortId).toBe('h099');
  });

  it('5. Stop background task translates routeId -> dsh_session_id across HTTP API and /bg stop command', async () => {
    hostCalls.stop = [];

    // HTTP API Stop
    const stopRes = await fetch(`${baseUrl}/api/sessions/${hostRouteId}/background/h099/stop`, {
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
    expect(stopJson.data.stopped).toBe(true);

    expect(hostCalls.stop).toContainEqual({
      sessionId: hostDshSessionId,
      taskId: 'h099',
    });

    // Chat command /bg stop
    const cmdStopRes = await chatCommandService.execute({
      userId: aliceUserId,
      sessionId: hostRouteId,
      spaceId: hostSpaceId,
      content: '/bg stop h002',
    });
    expect(cmdStopRes.replyText).toContain('后台任务 h002 已停止');
    expect(hostCalls.stop).toContainEqual({
      sessionId: hostDshSessionId,
      taskId: 'h002',
    });
  });

  it('6. Dynamic generation reset updates dsh_session_id and next queries use the updated dsh_session_id', async () => {
    const updatedDshSessionId = 'dsh_synth_host_gen_002_reset';

    db.prepare(`
      UPDATE session_routes
      SET dsh_session_id = ?, current_generation = 2
      WHERE id = ?
    `).run(updatedDshSessionId, hostRouteId);

    hostCalls.list = [];

    await fetch(`${baseUrl}/api/sessions/${hostRouteId}/background`, {
      headers: { Cookie: aliceCookie },
    });

    // Verify the query now went to the new generation's dsh_session_id
    expect(hostCalls.list).toContain(updatedDshSessionId);
    expect(hostCalls.list).not.toContain(hostDshSessionId);
  });
});
