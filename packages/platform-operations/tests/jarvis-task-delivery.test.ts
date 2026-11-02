import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { FakePlatformOperationsStorage } from './support/index.js';
import { PlatformOperationsService } from '../src/services/platform-operations-service.js';
import {
  AgentPromptTaskWorker,
  resolveTaskOriginDelivery,
  isNoopTaskDeliveryChannel,
} from '../src/index.js';

/**
 * `jarvis` is a valid task delivery channel whose delivery is a successful no-op: Jarvis shows the
 * session content itself. It must never fall back to an IM chat bound to the same space.
 */
describe('jarvis task delivery is a no-op', () => {
  const tenantId = 'user-alice';
  const sessionId = 'ses_00000000000000000000000000000001';
  const jarvisSessionId = 'ses_00000000000000000000000000000002';
  const spaceId = 'spc_00000000000000000000000000000001';
  let storage: FakePlatformOperationsStorage;
  let service: PlatformOperationsService;
  let db: DatabaseSync;
  let gateway: { sendProactiveMessage: ReturnType<typeof vi.fn> };
  let crm: { getActiveGateway: ReturnType<typeof vi.fn> };
  const workers: AgentPromptTaskWorker[] = [];

  beforeEach(() => {
    storage = new FakePlatformOperationsStorage();
    service = new PlatformOperationsService({ storage });
    gateway = { sendProactiveMessage: vi.fn().mockResolvedValue({ success: true }) };
    crm = { getActiveGateway: vi.fn().mockReturnValue(gateway) };
    db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE channel_accounts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active');
      CREATE TABLE session_routes (
        id TEXT PRIMARY KEY, space_id TEXT NOT NULL, user_id TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'web', account_id TEXT, native_context_id TEXT
      );
      CREATE TABLE channel_bindings (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, account_id TEXT NOT NULL, space_id TEXT NOT NULL, native_context_id TEXT NOT NULL
      );
    `);
    db.prepare(`INSERT INTO channel_accounts (id, user_id, type, status) VALUES ('acc_test_lark_01', ?, 'lark', 'active')`).run(tenantId);
    db.prepare(`INSERT INTO channel_accounts (id, user_id, type, status) VALUES ('acc_test_jarvis_01', ?, 'jarvis', 'active')`).run(tenantId);
    // The space is bound to a Lark chat: the fallback would pick it for web sessions.
    db.prepare(`
      INSERT INTO channel_bindings (id, user_id, account_id, space_id, native_context_id)
      VALUES ('cb_test_01', ?, 'acc_test_lark_01', ?, 'oc_test0000000000000000000000000001')
    `).run(tenantId, spaceId);
    db.prepare(`INSERT INTO session_routes (id, space_id, user_id, channel) VALUES (?, ?, ?, 'web')`).run(sessionId, spaceId, tenantId);
    db.prepare(`
      INSERT INTO session_routes (id, space_id, user_id, channel, account_id, native_context_id)
      VALUES (?, ?, ?, 'jarvis', 'acc_test_jarvis_01', 'jarvis-context-01')
    `).run(jarvisSessionId, spaceId, tenantId);
  });

  afterEach(async () => {
    for (const w of workers.splice(0)) {
      await w.stop({ abortInFlight: true });
    }
  });

  function createWorker() {
    const worker = new AgentPromptTaskWorker({
      workerId: 'worker_test_jarvis',
      tenantEnumerator: () => [tenantId],
      getTenantOperations: (id) => service.forTenant(id),
      dispatcher: async () => ({
        status: 'completed',
        completedAt: new Date().toISOString(),
        replyText: 'synthetic task result',
      }),
      channelRuntimeManager: crm as any,
      db,
    });
    workers.push(worker);
    return worker;
  }

  it('recognizes jarvis as a no-op channel only', () => {
    expect(isNoopTaskDeliveryChannel('jarvis')).toBe(true);
    expect(isNoopTaskDeliveryChannel('lark')).toBe(false);
    expect(isNoopTaskDeliveryChannel('wechat')).toBe(false);
    expect(isNoopTaskDeliveryChannel(undefined)).toBe(false);
  });

  it('completes a task with an explicit jarvis delivery without sending anything', async () => {
    const { task } = await service.forTenant(tenantId).tasks.createTask({
      title: 'Jarvis delivery task',
      payload: {
        type: 'agent_prompt',
        prompt: 'synthetic prompt',
        sessionId,
        sessionPolicy: 'existing_session',
        spaceId,
        silent: false,
        delivery: { channel: 'jarvis', accountId: 'acc_test_jarvis_01', nativeContextId: 'jarvis-context-01' },
      },
    });
    const result = await createWorker().runNow({ taskId: task.id, tenantId });
    expect(result?.status).toBe('completed');
    expect(gateway.sendProactiveMessage).not.toHaveBeenCalled();
    expect(crm.getActiveGateway).not.toHaveBeenCalled();
  });

  it('does not guess the space Lark chat for a session that belongs to jarvis', async () => {
    expect(resolveTaskOriginDelivery(db, tenantId, { sessionId: jarvisSessionId, spaceId })).toBeUndefined();

    const { task } = await service.forTenant(tenantId).tasks.createTask({
      title: 'Jarvis session task',
      payload: {
        type: 'agent_prompt',
        prompt: 'synthetic prompt',
        sessionId: jarvisSessionId,
        sessionPolicy: 'existing_session',
        spaceId,
        silent: false,
      },
    });
    const result = await createWorker().runNow({ taskId: task.id, tenantId });
    expect(result?.status).toBe('completed');
    expect(gateway.sendProactiveMessage).not.toHaveBeenCalled();
  });

  it('keeps the space-binding fallback for web sessions', async () => {
    expect(resolveTaskOriginDelivery(db, tenantId, { sessionId, spaceId })).toEqual({
      channel: 'lark',
      accountId: 'acc_test_lark_01',
      nativeContextId: 'oc_test0000000000000000000000000001',
    });
  });
});
