import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
} from '../src/storage/migrations.js';
import {
  SqlitePlatformStorage,
  SqlitePlatformOperationsStorage,
} from '@enkeep/platform-storage-sqlite';
import { createPlatformServerTaskWorker } from '../src/tasks/agent-prompt-worker.js';
import { TaskNotificationService } from '../src/notifications/task-notification-service.js';
import {
  buildRunFailureMessage,
  formatInTimeZone,
  loadTaskContext,
} from '../src/notifications/task-failure-notifier.js';

/**
 * Failure notifications on the task's own route (task_route channel).
 * All identifiers below are synthetic fixtures.
 */
describe('task_route failure notifications', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let operationsStorage: SqlitePlatformOperationsStorage;
  let notif: TaskNotificationService;
  let sentIm: any[];
  let resultGateway: { sendProactiveMessage: ReturnType<typeof vi.fn> };
  let fakeCrm: { getActiveGateway: ReturnType<typeof vi.fn> };
  let dispatchMode: 'fail' | 'succeed';

  const tenant = 'user_route_alice';
  const spaceId = 'spc_00000000000000000000000000000a01';
  const webSessionId = 'ses_00000000000000000000000000000b01';
  const larkSessionId = 'ses_00000000000000000000000000000b02';
  const otherSpaceId = 'spc_00000000000000000000000000000a02';
  const otherSessionId = 'ses_00000000000000000000000000000b03';
  const accountId = 'acc_route_lark_1';
  const anchorChat = 'oc_route_anchor_chat';
  const deliveryChat = 'oc_route_delivery_chat';

  function insertLarkFixtures() {
    db.prepare(`INSERT INTO channel_accounts (id, user_id, type, status) VALUES (?, ?, 'lark', 'active')`).run(accountId, tenant);
    db.prepare(`INSERT INTO channel_bindings (id, user_id, account_id, space_id, native_context_id) VALUES (?, ?, ?, ?, ?)`)
      .run('cb_route_anchor', tenant, accountId, spaceId, anchorChat);
    db.prepare(`INSERT INTO channel_bindings (id, user_id, account_id, space_id, native_context_id) VALUES (?, ?, ?, ?, ?)`)
      .run('cb_route_delivery', tenant, accountId, otherSpaceId, deliveryChat);
  }

  function makeWorker() {
    return createPlatformServerTaskWorker({
      db,
      dispatcher: async () => {
        if (dispatchMode === 'fail') {
          throw new Error('synthetic dispatch failure');
        }
        return { status: 'completed', completedAt: new Date().toISOString() };
      },
      operationsStorage,
      taskNotificationService: notif,
      channelRuntimeManager: fakeCrm,
      pollIntervalMs: 50,
    });
  }

  async function createTask(input: {
    title: string;
    sessionId: string;
    silent?: boolean;
    delivery?: { channel: string; accountId: string; nativeContextId: string };
    maxRetries?: number;
    dueDate?: string;
    key: string;
  }) {
    const repo = operationsStorage.forTenant(tenant).tasks as any;
    const payload: Record<string, unknown> = {
      type: 'agent_prompt',
      prompt: `prompt for ${input.title}`,
      sessionId: input.sessionId,
      sessionPolicy: 'existing_session',
    };
    if (input.silent !== undefined) payload.silent = input.silent;
    if (input.delivery) payload.delivery = input.delivery;
    const task = await repo.create({
      title: input.title,
      payload,
      maxRetries: input.maxRetries ?? 1,
      dueDate: input.dueDate,
      idempotencyKey: randomUUID(),
    });
    return task;
  }

  function routeDeliveries(taskId?: string) {
    const rows = db.prepare(`
      SELECT * FROM task_notification_deliveries WHERE channel = 'task_route' ${taskId ? 'AND task_id = ?' : ''}
      ORDER BY created_at ASC
    `).all(...(taskId ? [taskId] : [])) as any[];
    return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload_json) }));
  }

  async function flush() {
    // allow setImmediate dispatches to settle
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    await new PlatformServerMigrationRunner(db).migrate(ALL_PLATFORM_MIGRATIONS);
    storage = new SqlitePlatformStorage(db);
    await storage.users.create({ id: tenant, username: 'route_alice', passwordHash: 'x', role: 'user', status: 'active' });
    const tenantStorage = storage.forTenant(tenant);
    await tenantStorage.spaces.create({ id: spaceId, name: 'Route Space', folder: 'route_space', executionMode: 'container' });
    await tenantStorage.spaces.create({ id: otherSpaceId, name: 'Other Space', folder: 'route_space_2', executionMode: 'container' });
    await tenantStorage.sessionRoutes.create({
      id: webSessionId, spaceId, channel: 'web', accountId: 'web-demo', nativeContextId: webSessionId,
      peerId: 'p1', dshSessionId: 'dsh_route_1', executionMode: 'container',
    });
    await tenantStorage.sessionRoutes.create({
      id: larkSessionId, spaceId, channel: 'lark', accountId, nativeContextId: `${anchorChat}:omt_thread_1`,
      peerId: 'p2', dshSessionId: 'dsh_route_2', executionMode: 'container',
    });
    await tenantStorage.sessionRoutes.create({
      id: otherSessionId, spaceId: otherSpaceId, channel: 'web', accountId: 'web-demo', nativeContextId: otherSessionId,
      peerId: 'p3', dshSessionId: 'dsh_route_3', executionMode: 'container',
    });

    operationsStorage = new SqlitePlatformOperationsStorage(db, { quotaOptions: { unconfiguredPolicy: 'fail_closed' } });
    const quota = operationsStorage.forTenant(tenant).quota;
    await quota.setLimit({ resource: 'turns', limit: 100 });
    await quota.setLimit({ resource: 'messages', limit: 100 });
    await quota.setLimit({ resource: 'tokens', limit: 10000 });

    sentIm = [];
    notif = new TaskNotificationService({
      db,
      taskRouteSender: async (params) => {
        sentIm.push(params);
        return { success: true, messageId: `om_${sentIm.length}` };
      },
    });
    resultGateway = { sendProactiveMessage: vi.fn().mockResolvedValue({ success: true }) };
    fakeCrm = { getActiveGateway: vi.fn().mockReturnValue(resultGateway) };
    dispatchMode = 'fail';
  });

  afterEach(() => {
    notif.stopRetryWorker();
    try { db.close(); } catch { /* ignore */ }
  });

  it('a silent task that fails notifies its delivery target, while its success stays silent', async () => {
    insertLarkFixtures();
    const delivery = { channel: 'lark', accountId, nativeContextId: deliveryChat };
    const failing = await createTask({ title: 'Silent failing job', sessionId: otherSessionId, silent: true, delivery, key: 'k-silent-fail' });

    const worker = makeWorker();
    const result = await worker.runOnce();
    expect(result?.status).toBe('failed');
    await flush();

    const rows = routeDeliveries(failing.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('delivered');
    expect(rows[0].event).toBe('failed');
    expect(rows[0].payload.target).toMatchObject({ kind: 'im', source: 'delivery', channel: 'lark', nativeContextId: deliveryChat });
    expect(sentIm).toHaveLength(1);
    expect(sentIm[0]).toMatchObject({ userId: tenant, channel: 'lark', accountId, chatId: deliveryChat });
    expect(sentIm[0].text).toContain('定时任务「Silent failing job」运行失败');
    expect(sentIm[0].outboxId).toMatch(/^out_tfn_/);
    // result output is suppressed by silent
    expect(resultGateway.sendProactiveMessage).not.toHaveBeenCalled();

    dispatchMode = 'succeed';
    const ok = await createTask({ title: 'Silent ok job', sessionId: otherSessionId, silent: true, delivery, key: 'k-silent-ok' });
    const okResult = await worker.runOnce();
    expect(okResult?.status).toBe('completed');
    await notif.reconcileTaskRoute();
    await flush();
    expect(routeDeliveries(ok.id)).toHaveLength(0);
    expect(sentIm).toHaveLength(1);
    expect(resultGateway.sendProactiveMessage).not.toHaveBeenCalled();
  });

  it('without delivery, the failure goes to the chat bound to the anchor session (thread suffix stripped)', async () => {
    insertLarkFixtures();
    const task = await createTask({ title: 'Anchor routed job', sessionId: larkSessionId, silent: true, key: 'k-anchor' });
    await makeWorker().runOnce();
    await flush();

    const rows = routeDeliveries(task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.target).toMatchObject({ kind: 'im', source: 'anchor', channel: 'lark', accountId });
    expect(sentIm).toHaveLength(1);
    expect(sentIm[0].chatId).toBe(anchorChat);
    expect(sentIm[0].sessionId).toBe(larkSessionId);
  });

  it('without any IM route, the failure is written to the anchor web session', async () => {
    const task = await createTask({ title: 'Web only job', sessionId: otherSessionId, silent: true, key: 'k-web' });
    await makeWorker().runOnce();
    await flush();

    const rows = routeDeliveries(task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('delivered');
    expect(rows[0].payload.target).toMatchObject({ kind: 'in_app', sessionId: otherSessionId });
    expect(sentIm).toHaveLength(0);
    const msgs = db.prepare(`SELECT * FROM web_messages WHERE session_id = ? AND id LIKE 'msg_tfn_%'`).all(otherSessionId) as any[];
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toContain('Web only job');
  });

  it('sends one notification per run even when the fast path and the reconciler both see it', async () => {
    insertLarkFixtures();
    const task = await createTask({ title: 'Dedup job', sessionId: larkSessionId, key: 'k-dedup' });
    await makeWorker().runOnce();
    await flush();
    const run = db.prepare(`SELECT id FROM task_runs WHERE task_id = ?`).get(task.id) as { id: string };

    await notif.reconcileTaskRoute();
    await notif.notifyRunFailure(tenant, run.id, { dispatch: 'await' });
    await notif.notifyTaskEvent({
      taskId: task.id, userId: tenant, event: 'failed',
      task: { id: task.id, status: 'failed' }, run: { id: run.id, status: 'failed' },
    });
    await flush();

    expect(routeDeliveries(task.id)).toHaveLength(1);
    expect(sentIm).toHaveLength(1);
  });

  it('retries a failed IM send through deliveries without sending twice', async () => {
    insertLarkFixtures();
    let calls = 0;
    notif.setTaskRouteSender(async (params) => {
      calls++;
      if (calls === 1) throw new Error('synthetic gateway outage');
      sentIm.push(params);
      return { success: true };
    });
    const task = await createTask({ title: 'Retry job', sessionId: larkSessionId, key: 'k-retry' });
    await makeWorker().runOnce();
    await flush();

    let rows = routeDeliveries(task.id);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].attempts).toBe(1);
    db.prepare(`UPDATE task_notification_deliveries SET next_retry_at = ? WHERE id = ?`).run(new Date(Date.now() - 1000).toISOString(), rows[0].id);

    await notif.processPendingDeliveries();
    rows = routeDeliveries(task.id);
    expect(rows[0].status).toBe('delivered');
    expect(rows[0].attempts).toBe(2);
    expect(sentIm).toHaveLength(1);
    // the same outbox id is reused, so the gateway can dedupe a send that was in fact delivered
    expect(sentIm[0].outboxId).toBe(`out_tfn_${rows[0].id}`);
  });

  it('does not notify when the task has disabled failure notifications', async () => {
    insertLarkFixtures();
    const task = await createTask({ title: 'Opted out job', sessionId: larkSessionId, key: 'k-optout' });
    const setting = await notif.setFailureNotificationEnabled(task.id, tenant, false);
    expect(setting?.enabled).toBe(false);
    expect(setting?.channel).toBe('task_route');

    await makeWorker().runOnce();
    await notif.reconcileTaskRoute();
    await flush();
    expect(routeDeliveries(task.id)).toHaveLength(0);
    expect(sentIm).toHaveLength(0);

    // enabling again affects later runs only; the setting is unique per task
    const again = await notif.setFailureNotificationEnabled(task.id, tenant, true);
    expect(again?.id).toBe(setting?.id);
    const subs = db.prepare(`SELECT COUNT(*) AS c FROM task_notification_subscriptions WHERE task_id = ? AND channel = 'task_route'`).get(task.id) as any;
    expect(subs.c).toBe(1);
  });

  it('reports lease-expired runs found by the scheduler maintenance pass', async () => {
    insertLarkFixtures();
    const task = await createTask({ title: 'Lease job', sessionId: larkSessionId, key: 'k-lease' });
    const repo = operationsStorage.forTenant(tenant).tasks as any;
    const claimed = await repo.claim({ claimantId: 'worker_synthetic', leaseDurationMs: 1000 });
    expect(claimed?.id).toBe(task.id);
    // expire the lease and recover like the worker does after a crash
    await repo.recoverExpiredLeases(new Date(Date.now() + 60_000).toISOString());
    const run = db.prepare(`SELECT status, error_code FROM task_runs WHERE task_id = ?`).get(task.id) as any;
    expect(run.status).toBe('failed');

    const result = await notif.reconcileTaskRoute();
    expect(result.failedRuns).toBe(1);
    const rows = routeDeliveries(task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].event).toBe('timeout');
    expect(sentIm[0].text).toContain('运行超时');
  });

  it('reports a run that has not started 30 minutes after its due time, once', async () => {
    insertLarkFixtures();
    const due = new Date(Date.now() + 1000).toISOString();
    const task = await createTask({ title: 'Missed job', sessionId: larkSessionId, dueDate: due, key: 'k-missed' });

    // not yet past the threshold
    let result = await notif.reconcileTaskRoute(new Date(Date.parse(due) + 10 * 60_000));
    expect(result.missedRuns).toBe(0);

    const later = new Date(Date.parse(due) + 31 * 60_000);
    result = await notif.reconcileTaskRoute(later);
    expect(result.missedRuns).toBe(1);
    result = await notif.reconcileTaskRoute(new Date(later.getTime() + 60_000));
    expect(result.missedRuns).toBe(0);

    const rows = routeDeliveries(task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.kind).toBe('missed_run');
    expect(sentIm).toHaveLength(1);
    expect(sentIm[0].text).toContain('没有按时运行');
    expect(sentIm[0].text).toContain('31 分钟');
  });

  it('does not report missed runs of paused schedules', async () => {
    const due = new Date(Date.now() + 1000).toISOString();
    const task = await createTask({ title: 'Paused job', sessionId: webSessionId, dueDate: due, key: 'k-paused' });
    db.prepare(`UPDATE task_schedules SET enabled = 0, paused_at = ? WHERE task_id = ?`).run(new Date().toISOString(), task.id);
    const result = await notif.reconcileTaskRoute(new Date(Date.parse(due) + 60 * 60_000));
    expect(result.missedRuns).toBe(0);
    expect(routeDeliveries(task.id)).toHaveLength(0);
  });

  it('non-silent tasks keep their result delivery and also get failure notices', async () => {
    insertLarkFixtures();
    dispatchMode = 'succeed';
    const delivery = { channel: 'lark', accountId, nativeContextId: deliveryChat };
    const ok = await createTask({ title: 'Loud ok job', sessionId: otherSessionId, delivery, key: 'k-loud-ok' });
    const worker = makeWorker();
    expect((await worker.runOnce())?.status).toBe('completed');
    expect(resultGateway.sendProactiveMessage).toHaveBeenCalledTimes(1);
    expect(resultGateway.sendProactiveMessage.mock.calls[0][0].chatId).toBe(deliveryChat);
    await notif.reconcileTaskRoute();
    expect(routeDeliveries(ok.id)).toHaveLength(0);

    dispatchMode = 'fail';
    const bad = await createTask({ title: 'Loud failing job', sessionId: otherSessionId, delivery, key: 'k-loud-bad' });
    expect((await worker.runOnce())?.status).toBe('failed');
    await flush();
    expect(resultGateway.sendProactiveMessage).toHaveBeenCalledTimes(1);
    expect(routeDeliveries(bad.id)).toHaveLength(1);
    expect(sentIm).toHaveLength(1);
  });

  it('does not replay failures that happened before the feature was enabled', async () => {
    insertLarkFixtures();
    const task = await createTask({ title: 'Old failure', sessionId: larkSessionId, key: 'k-old' });
    await makeWorker().runOnce();
    await flush();
    // pretend the run ended before migration 045 was applied
    db.prepare(`DELETE FROM task_notification_deliveries`).run();
    db.prepare(`UPDATE task_runs SET completed_at = '2000-01-01T00:00:00.000Z' WHERE task_id = ?`).run(task.id);
    sentIm.length = 0;
    const result = await notif.reconcileTaskRoute();
    expect(result.failedRuns).toBe(0);
    expect(sentIm).toHaveLength(0);
  });

  it('builds a self-contained Chinese message in the task time zone', () => {
    db.prepare(`INSERT INTO platform_tasks (id, user_id, title, status, payload, schedule_type, timezone, next_run_at, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', ?, 'cron', 'Asia/Shanghai', ?, ?, ?)`).run(
      'task_00000000000000000000000000000c01', tenant, 'Daily digest',
      JSON.stringify({ type: 'agent_prompt', prompt: 'x', sessionId: webSessionId, sessionPolicy: 'isolated' }),
      '2026-01-03T02:30:00.000Z', new Date().toISOString(), new Date().toISOString()
    );
    const ctx = loadTaskContext(db, 'task_00000000000000000000000000000c01', tenant)!;
    const msg = buildRunFailureMessage(ctx, {
      id: 'run_synthetic_1', taskId: ctx.id, userId: tenant, status: 'failed',
      errorCode: 'TASK_EXECUTION_FAILED', error: 'TASK_EXECUTION_FAILED',
      scheduledFor: '2026-01-02T02:30:00.000Z', startedAt: null, completedAt: null,
    });
    expect(msg.text).toContain('定时任务「Daily digest」运行失败');
    expect(msg.text).toContain('原定运行时间：2026-01-02 10:30（Asia/Shanghai）');
    expect(msg.text).toContain('下次运行：2026-01-03 10:30（Asia/Shanghai），按原计划自动运行');
    expect(msg.text).toContain('立即执行');
    // internal ids only inside parentheses on the last line
    const lines = msg.text.split('\n');
    const idLine = lines[lines.length - 1];
    expect(idLine.startsWith('（') && idLine.endsWith('）')).toBe(true);
    expect(lines.slice(0, -1).some((l) => l.includes('run_synthetic_1'))).toBe(false);
    expect(formatInTimeZone('2026-01-02T02:30:00.000Z', 'Invalid/Zone')).toBe('2026-01-02 02:30（UTC）');
  });
});
