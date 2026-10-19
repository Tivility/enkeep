import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { ALL_PLATFORM_MIGRATIONS, PlatformServerMigrationRunner } from '../src/storage/migrations.js';
import { DeliveryRuntimeGateway } from '../src/runtime/delivery-gateway.js';

describe('Turn Steps Persistence and Retrieval Endpoint (Process Card)', () => {
  let db: DatabaseSync;
  let runner: PlatformServerMigrationRunner;

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, status)
      VALUES ('u_alice_test', 'alice', 'hash_alice', 'user', 'active')
    `).run();

    db.prepare(`
      INSERT INTO spaces (id, user_id, name, folder, status)
      VALUES ('spc_test', 'u_alice_test', 'Default Space', 'folder_test', 'active')
    `).run();

    db.prepare(`
      INSERT INTO session_routes (id, user_id, space_id, channel, dsh_session_id)
      VALUES ('ses_test', 'u_alice_test', 'spc_test', 'web', 'dsh_ses_test')
    `).run();
  });

  it('persists tool steps from web_events into turn_runs.steps_json upon turn finalization', async () => {
    const turnId = 'turn_synth_steps_01';
    const deliveryId = 'deliv_synth_01';
    const idempotencyKey = 'idem_synth_01';

    // Seed turn_runs
    db.prepare(`
      INSERT INTO turn_runs (id, user_id, space_id, route_id, turn_id, status)
      VALUES ('tr_1', 'u_alice_test', 'spc_test', 'ses_test', ?, 'running')
    `).run(turnId);

    // Seed delivery_inbox
    db.prepare(`
      INSERT INTO delivery_inbox (id, user_id, route_id, message_id, delivery_id, status, turn_id)
      VALUES ('inbox_1', 'u_alice_test', 'ses_test', 'msg_1', ?, 'processing', ?)
    `).run(deliveryId, turnId);

    // Seed idempotency_records
    db.prepare(`
      INSERT INTO idempotency_records (id, user_id, idempotency_key, session_id, delivery_id, turn_id, request_hash, state)
      VALUES ('idem_row_1', 'u_alice_test', ?, 'ses_test', ?, ?, 'hash_req', 'processing')
    `).run(idempotencyKey, deliveryId, turnId);

    // Seed web_messages user message
    db.prepare(`
      INSERT INTO web_messages (id, session_id, user_id, role, content, status, route_key, turn_id, created_at)
      VALUES ('msg_user', 'ses_test', 'u_alice_test', 'user', 'Hello', 'delivered', 'route_key', ?, '2026-10-18T10:00:00.000Z')
    `).run(turnId);

    // Seed tool_status web_events
    db.prepare(`
      INSERT INTO web_events (id, session_id, user_id, type, payload, created_at)
      VALUES
        ('evt_1', 'ses_test', 'u_alice_test', 'tool_status', json_object('toolName', 'read', 'status', 'started', 'callId', 'c1', 'summary', '/path/a.ts', 'turnId', ?), '2026-10-18T10:00:00.100Z'),
        ('evt_2', 'ses_test', 'u_alice_test', 'tool_status', json_object('toolName', 'read', 'status', 'completed', 'callId', 'c1', 'summary', '/path/a.ts', 'turnId', ?), '2026-10-18T10:00:00.350Z'),
        ('evt_3', 'ses_test', 'u_alice_test', 'tool_status', json_object('toolName', 'bash', 'status', 'started', 'callId', 'c2', 'summary', 'pnpm test', 'turnId', ?), '2026-10-18T10:00:00.400Z'),
        ('evt_4', 'ses_test', 'u_alice_test', 'tool_status', json_object('toolName', 'bash', 'status', 'completed', 'callId', 'c2', 'summary', 'pnpm test', 'facts', 'exit 0', 'turnId', ?), '2026-10-18T10:00:00.800Z')
    `).run(turnId, turnId, turnId, turnId);

    const gateway = new DeliveryRuntimeGateway({
      database: db,
      quotaMode: 'disabled',
      profileResolver: {
        resolve: async () => ({ snapshot: null, effectivePrompt: '' }),
      } as any,
      executor: {
        execute: async () => ({ replyText: 'Done', totalTokens: 50 }),
        cancel: async () => true,
      } as any,
    });

    await gateway.finalizeCompletedTurn({
      userId: 'u_alice_test',
      sessionId: 'ses_test',
      spaceId: 'spc_test',
      deliveryId,
      idempotencyKey,
      turnId,
      executionResult: { replyText: 'Turn completed.' },
      tokenUsage: { tokens: 50 },
    });

    const turnRow = db.prepare('SELECT status, steps_json FROM turn_runs WHERE turn_id = ?').get(turnId) as { status: string; steps_json?: string };
    expect(turnRow.status).toBe('completed');
    expect(turnRow.steps_json).toBeDefined();

    const parsedSteps = JSON.parse(turnRow.steps_json || '[]');
    expect(parsedSteps.length).toBe(2);

    expect(parsedSteps[0].name).toBe('read');
    expect(parsedSteps[0].status).toBe('completed');
    expect(parsedSteps[0].summary).toBe('/path/a.ts');
    expect(parsedSteps[0].durationMs).toBe(250);

    expect(parsedSteps[1].name).toBe('bash');
    expect(parsedSteps[1].status).toBe('completed');
    expect(parsedSteps[1].facts).toBe('exit 0');
    expect(parsedSteps[1].durationMs).toBe(400);

    // Verify turnId exposed on assistant message in web_messages
    const msgRow = db.prepare("SELECT turn_id, role FROM web_messages WHERE session_id = 'ses_test' AND role = 'assistant'").get() as { turn_id: string; role: string };
    expect(msgRow.turn_id).toBe(turnId);
  });
});
