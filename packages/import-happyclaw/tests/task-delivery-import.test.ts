import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {
  createSyntheticV2Fixture,
  createMigrationPlanV2,
  executePilotMigrationV2,
  stageMigrationPackageV2,
} from '../src/index.js'

describe('HappyClaw Task Import Target Chat & Delivery Mapping (DEF-01)', () => {
  let testRoot: string
  let dbPath: string
  let groupsDir: string

  beforeEach(() => {
    testRoot = join(tmpdir(), `enkeep-task-delivery-test-${randomUUID()}`)
    mkdirSync(testRoot, { recursive: true })
    const fixture = createSyntheticV2Fixture(testRoot)
    dbPath = fixture.dbPath
    groupsDir = fixture.groupsDir
  })

  afterEach(() => {
    if (existsSync(testRoot)) {
      rmSync(testRoot, { recursive: true, force: true })
    }
  })

  it('1. maps synthetic fixture tasks to appropriate delivery targets {channel, accountId, nativeContextId}', () => {
    const plan = createMigrationPlanV2({
      sourcePath: dbPath,
      sourceGroupsDir: groupsDir,
      targetUserId: 'alice',
      selectedWorkspaceIds: ['web:alice-space', 'feishu:bob-space'],
    })

    // Alice space has Lark channel mount (mnt_alice_lark -> acc_alice_lark -> oc_alice_chat_123)
    const aliceItem = plan.items.find((i) => i.workspaceId === 'web:alice-space')
    expect(aliceItem).toBeDefined()
    const aliceTask = aliceItem?.taskPlans.find((t) => t.title === 'Daily Workspace Sync')
    expect(aliceTask).toBeDefined()
    expect(aliceTask?.delivery).toEqual({
      channel: 'lark',
      accountId: 'acc_alice_lark',
      nativeContextId: 'oc_alice_chat_123',
    })

    // Bob space has WeChat channel mount (mnt_bob_wechat -> acc_bob_wechat -> wx_bob_room_456)
    const bobItem = plan.items.find((i) => i.workspaceId === 'feishu:bob-space')
    expect(bobItem).toBeDefined()
    const bobTask = bobItem?.taskPlans.find((t) => t.title === 'Weekly Metrics Report')
    expect(bobTask).toBeDefined()
    expect(bobTask?.delivery).toEqual({
      channel: 'wechat',
      accountId: 'acc_bob_wechat',
      nativeContextId: 'wx_bob_room_456',
    })
  })

  it('2. maps HappyClaw web session to external Lark channel via channel_mounts (HC 3a09c952 reproduction)', () => {
    const customDbPath = join(testRoot, 'hc-repro.db')
    const db = new DatabaseSync(customDbPath)

    db.exec(`
      CREATE TABLE router_state (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO router_state VALUES ('schema_version', '64');

      CREATE TABLE workspaces (jid TEXT PRIMARY KEY, name TEXT, folder TEXT, execution_mode TEXT, created_by TEXT);
      INSERT INTO workspaces VALUES ('web:e0fb7c5c-9b44-411e-a41e-92b76c264862', '克己录', 'flow-test0014-3675', 'host', 'usr_owner-user');

      CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT, last_message_time TEXT);
      INSERT INTO chats VALUES ('web:e0fb7c5c-9b44-411e-a41e-92b76c264862', '克己录', '2026-09-19T01:00:00.000Z');

      CREATE TABLE channel_accounts (id TEXT PRIMARY KEY, type TEXT, name TEXT, status TEXT, credential_ref TEXT);
      INSERT INTO channel_accounts VALUES ('de942f0b-e437-41a6-a0d6-067bd01f82ba', 'feishu', '飞书助手', 'active', 'cred_feishu');

      CREATE TABLE channel_mounts (
        channel_jid TEXT PRIMARY KEY,
        channel_type TEXT,
        workspace_jid TEXT,
        session_id TEXT,
        routing_mode TEXT,
        reply_policy TEXT,
        activation_mode TEXT,
        audience_mode TEXT,
        owner_im_id TEXT,
        created_at TEXT,
        updated_at TEXT,
        channel_account_id TEXT
      );
      INSERT INTO channel_mounts VALUES (
        'feishu:oc_e4b849f19d18010553eb5c5f78624971',
        'feishu',
        'web:e0fb7c5c-9b44-411e-a41e-92b76c264862',
        NULL,
        'single_session',
        'source_only',
        'auto',
        'owner_only',
        'ou_6749227878d159775090098ff3e65af5',
        '2026-08-30T09:46:05.329Z',
        '2026-09-06T09:46:09.440Z',
        'de942f0b-e437-41a6-a0d6-067bd01f82ba'
      );

      CREATE TABLE scheduled_tasks (
        id TEXT PRIMARY KEY,
        group_folder TEXT NOT NULL,
        chat_jid TEXT NOT NULL,
        prompt TEXT NOT NULL,
        schedule_type TEXT NOT NULL,
        schedule_value TEXT NOT NULL,
        context_mode TEXT DEFAULT 'isolated',
        execution_type TEXT DEFAULT 'agent',
        script_command TEXT,
        next_run TEXT,
        last_run TEXT,
        last_result TEXT,
        status TEXT DEFAULT 'active',
        created_at TEXT NOT NULL,
        created_by TEXT,
        notify_channels TEXT,
        execution_mode TEXT,
        workspace_jid TEXT,
        workspace_folder TEXT,
        running_until TEXT,
        runner_id TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL DEFAULT '',
        deleted_at TEXT,
        delivery_route_jid TEXT
      );
      INSERT INTO scheduled_tasks (
        id, group_folder, chat_jid, prompt, schedule_type, schedule_value,
        context_mode, execution_type, status, created_at, delivery_route_jid
      ) VALUES (
        '3a09c952-0569-4c9a-a217-1e46ddd3a84f',
        'flow-test0014-3675',
        'web:e0fb7c5c-9b44-411e-a41e-92b76c264862',
        '今天有没有一个值得拆的场景？',
        'cron',
        '0 18 * * 1-5',
        'group',
        'agent',
        'paused',
        '2026-08-01T00:00:00.000Z',
        'web:e0fb7c5c-9b44-411e-a41e-92b76c264862'
      );
    `)
    db.close()

    const plan = createMigrationPlanV2({
      sourcePath: customDbPath,
      targetUserId: 'owner-user',
      selectedWorkspaceIds: ['web:e0fb7c5c-9b44-411e-a41e-92b76c264862'],
    })

    expect(plan.summary.totalTasks).toBe(1)
    const wsItem = plan.items[0]
    expect(wsItem).toBeDefined()
    expect(wsItem.taskPlans).toHaveLength(1)

    const task = wsItem.taskPlans[0]
    expect(task.sourceTaskId).toBe('3a09c952-0569-4c9a-a217-1e46ddd3a84f')
    expect(task.delivery).toEqual({
      channel: 'lark',
      accountId: 'de942f0b-e437-41a6-a0d6-067bd01f82ba',
      nativeContextId: 'oc_e4b849f19d18010553eb5c5f78624971',
    })
  })

  it('3. maps direct channel JID tasks (e.g. feishu:oc_... and explicit delivery_route_jid with account tag)', () => {
    const customDbPath = join(testRoot, 'direct-jid.db')
    const db = new DatabaseSync(customDbPath)

    db.exec(`
      CREATE TABLE router_state (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO router_state VALUES ('schema_version', '64');

      CREATE TABLE workspaces (jid TEXT PRIMARY KEY, name TEXT, folder TEXT, execution_mode TEXT, created_by TEXT);
      INSERT INTO workspaces VALUES ('web:main', '主工作区', 'main', 'host', 'usr_owner-user');

      CREATE TABLE channel_accounts (id TEXT PRIMARY KEY, type TEXT, name TEXT, status TEXT, credential_ref TEXT);
      INSERT INTO channel_accounts VALUES ('acc_lark_main', 'lark', 'Lark Bot', 'active', 'cred_ref_lark');

      CREATE TABLE scheduled_tasks (
        id TEXT PRIMARY KEY,
        group_folder TEXT,
        chat_jid TEXT,
        prompt TEXT,
        schedule_type TEXT,
        schedule_value TEXT,
        priority TEXT,
        delivery_route_jid TEXT
      );
      INSERT INTO scheduled_tasks VALUES
        ('task_direct_feishu', 'main', 'feishu:oc_a84ebdc224394dc39861485b177ef44d', 'Direct Lark reminder', 'cron', '0 4 * * *', 'high', NULL),
        ('task_explicit_route', 'main', 'web:main', 'Thread digest', 'cron', '0 9 * * *', 'normal', 'feishu:oc_tagged_123#account:acc_custom_456#thread:t-1'),
        ('task_web_silent', 'main', 'web:main', 'Internal pipeline sync', 'once', NULL, 'low', 'web:main');
    `)
    db.close()

    const plan = createMigrationPlanV2({
      sourcePath: customDbPath,
      targetUserId: 'owner-user',
      selectedWorkspaceIds: ['web:main'],
    })

    const mainItem = plan.items[0]
    expect(mainItem).toBeDefined()
    expect(mainItem.taskPlans).toHaveLength(3)

    const directTask = mainItem.taskPlans.find((t) => t.sourceTaskId === 'task_direct_feishu')
    expect(directTask?.delivery).toEqual({
      channel: 'lark',
      accountId: 'acc_lark_main',
      nativeContextId: 'oc_a84ebdc224394dc39861485b177ef44d',
    })

    const explicitTask = mainItem.taskPlans.find((t) => t.sourceTaskId === 'task_explicit_route')
    expect(explicitTask?.delivery).toEqual({
      channel: 'lark',
      accountId: 'acc_custom_456',
      nativeContextId: 'oc_tagged_123',
    })

    const webTask = mainItem.taskPlans.find((t) => t.sourceTaskId === 'task_web_silent')
    expect(webTask?.delivery).toBeNull()
  })

  it('4. executePilotMigrationV2 creates platform_tasks with valid canonical payload and delivery block', async () => {
    const plan = createMigrationPlanV2({
      sourcePath: dbPath,
      sourceGroupsDir: groupsDir,
      targetUserId: 'alice',
      selectedWorkspaceIds: ['web:alice-space'],
    })

    const stagingDir = join(testRoot, 'staged-pilot')
    stageMigrationPackageV2(
      {
        sourcePath: dbPath,
        selectedWorkspaceIds: ['web:alice-space'],
      },
      plan,
      stagingDir
    )

    const targetDb = new DatabaseSync(':memory:')
    targetDb.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, role TEXT, password_hash TEXT, must_change_password INTEGER, created_at TEXT, updated_at TEXT);
      CREATE TABLE spaces (id TEXT PRIMARY KEY, user_id TEXT, folder TEXT, name TEXT, execution_mode TEXT, status TEXT, created_at TEXT, updated_at TEXT, UNIQUE(user_id, folder));
      CREATE TABLE session_routes (id TEXT PRIMARY KEY, space_id TEXT, user_id TEXT, channel TEXT, account_id TEXT, native_context_id TEXT, peer_id TEXT, dsh_session_id TEXT, execution_mode TEXT, status TEXT, title TEXT, created_at TEXT, updated_at TEXT, UNIQUE(user_id, channel, native_context_id));
      CREATE TABLE session_generations (id TEXT PRIMARY KEY, user_id TEXT, route_id TEXT, generation_number INTEGER, dsh_session_id TEXT, agent_profile_snapshot_id TEXT, reset_reason TEXT, created_at TEXT, UNIQUE(route_id, generation_number));
      CREATE TABLE session_sources (id TEXT PRIMARY KEY, route_id TEXT, source_type TEXT, source_id TEXT, user_id TEXT, metadata TEXT, created_at TEXT);
      CREATE TABLE web_messages (id TEXT PRIMARY KEY, session_id TEXT, user_id TEXT, role TEXT, content TEXT, status TEXT, route_key TEXT, metadata TEXT, created_at TEXT);
      CREATE TABLE web_events (id TEXT PRIMARY KEY, session_id TEXT, user_id TEXT, type TEXT, payload TEXT, created_at TEXT);
      CREATE TABLE import_jobs (id TEXT PRIMARY KEY, actor_user_id TEXT, target_user_id TEXT, staged_id TEXT, source_fingerprint TEXT, request_hash TEXT, idempotency_key TEXT, status TEXT, dry_run INTEGER, total_conversations INTEGER, completed_conversations INTEGER, progress_json TEXT, result_json TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE fixed_import_receipts (user_id TEXT, source_fingerprint TEXT, importer_version TEXT, id_algorithm TEXT, target_dsh TEXT, session_format INTEGER, source_chats_count INTEGER, source_messages_count INTEGER, imported_messages_count INTEGER, dropped_messages_count INTEGER, attachments_count INTEGER, canonical_hash TEXT, created_at TEXT, PRIMARY KEY (user_id, source_fingerprint));
      CREATE TABLE fixed_import_provenance (id TEXT PRIMARY KEY, user_id TEXT, source_fingerprint TEXT, source_chat_jid TEXT, source_message_id TEXT, target_space_id TEXT, target_route_id TEXT, target_dsh_session_id TEXT, target_message_id TEXT, target_event_id TEXT, created_at TEXT);
      CREATE TABLE agent_profiles (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, description TEXT, status TEXT, active_version TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE agent_profile_snapshots (id TEXT PRIMARY KEY, user_id TEXT, profile_id TEXT, version TEXT, prompt_mode TEXT, prompt_hash TEXT, identity TEXT, soul TEXT, agents TEXT, tools TEXT, created_at TEXT);
      CREATE TABLE extension_packages (id TEXT PRIMARY KEY, user_id TEXT, slug TEXT, name TEXT, description TEXT, source_kind TEXT, source_ref TEXT, installed_version INTEGER, active_version INTEGER, status TEXT, integrity_sha256 TEXT, provenance_json TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE extension_contributions (id TEXT PRIMARY KEY, package_id TEXT, kind TEXT, contribution_key TEXT, manifest_json TEXT, status TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE extension_bindings (id TEXT PRIMARY KEY, user_id TEXT, space_id TEXT, contribution_id TEXT, enabled INTEGER, created_at TEXT, updated_at TEXT, UNIQUE(space_id, contribution_id));
      CREATE TABLE platform_tasks (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        idempotency_key TEXT,
        title TEXT,
        description TEXT,
        priority TEXT,
        status TEXT,
        payload TEXT,
        schedule_type TEXT NOT NULL DEFAULT 'once',
        cron_expression TEXT,
        created_at TEXT,
        updated_at TEXT
      );
      CREATE TABLE task_schedules (
        id TEXT PRIMARY KEY,
        task_id TEXT UNIQUE,
        user_id TEXT,
        schedule_type TEXT,
        cron_expression TEXT,
        enabled INTEGER,
        paused_at TEXT,
        created_at TEXT,
        updated_at TEXT
      );
      CREATE TABLE channel_accounts (id TEXT PRIMARY KEY, user_id TEXT, type TEXT, status TEXT, credential_ref TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE channel_bindings (id TEXT PRIMARY KEY, user_id TEXT, account_id TEXT, space_id TEXT, native_context_id TEXT, activation_mode TEXT, created_at TEXT, updated_at TEXT, UNIQUE(account_id, native_context_id));
      INSERT INTO users (id, username, role) VALUES ('usr_alice', 'alice', 'admin');
    `)

    const pilotResult = await executePilotMigrationV2({
      stagingDir,
      planId: plan.planId,
      db: targetDb,
      targetUserId: 'usr_alice',
    })

    expect(pilotResult.success).toBe(true)

    const taskRow = targetDb.prepare('SELECT * FROM platform_tasks WHERE title = ?').get('Daily Workspace Sync') as any
    expect(taskRow).toBeDefined()
    expect(taskRow.status).toBe('pending')

    const parsedPayload = JSON.parse(taskRow.payload)
    expect(parsedPayload.type).toBe('agent_prompt')
    expect(parsedPayload.prompt).toBe('Summarize daily progress across tasks')
    expect(parsedPayload.sessionId).toMatch(/^import-/)
    expect(parsedPayload.sessionPolicy).toBe('existing_session')
    expect(parsedPayload.spaceFolder).toBe('alice-space')
    expect(parsedPayload.silent).toBe(false)
    expect(parsedPayload.delivery).toEqual({
      channel: 'lark',
      accountId: expect.stringMatching(/^acc_pilot_/),
      nativeContextId: 'oc_alice_chat_123',
    })

    targetDb.close()
  })
})
