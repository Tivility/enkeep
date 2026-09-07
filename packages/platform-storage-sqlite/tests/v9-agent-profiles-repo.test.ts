import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createSqliteStorage,
  SqlitePlatformStorage,
  BUILTIN_MIGRATIONS,
} from '../src/index.js';
import {
  ValidationError,
  NotFoundError,
  composeAgentProfilePrompt,
  type MigrationDefinition,
} from '@enkeep/platform-core';

export const TEST_V9_FULL_MIGRATIONS: MigrationDefinition[] = [
  ...BUILTIN_MIGRATIONS,
  {
    version: 5,
    name: '005_web_messages_and_events',
    upSql: `
      CREATE TABLE IF NOT EXISTS web_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES session_routes(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'delivered',
        route_key TEXT NOT NULL,
        turn_id TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      );
    `,
  },
  {
    version: 6,
    name: '006_delivery_inbox_and_idempotency',
    upSql: `
      ALTER TABLE delivery_inbox ADD COLUMN turn_id TEXT;
      CREATE TABLE IF NOT EXISTS idempotency_records (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES session_routes(id) ON DELETE CASCADE,
        delivery_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'held',
        response_payload TEXT,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        UNIQUE(user_id, idempotency_key)
      );
    `,
  },
  {
    version: 7,
    name: '007_delivery_inbox_failed_status',
    upSql: `
      CREATE TABLE delivery_inbox_v7 (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        route_id TEXT NOT NULL REFERENCES session_routes(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'held',
        payload TEXT,
        error TEXT,
        received_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        processed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        turn_id TEXT,
        UNIQUE(user_id, delivery_id)
      );
      INSERT INTO delivery_inbox_v7 SELECT id, user_id, route_id, message_id, delivery_id, status, payload, error, received_at, processed_at, created_at, updated_at, turn_id FROM delivery_inbox;
      DROP TABLE delivery_inbox;
      ALTER TABLE delivery_inbox_v7 RENAME TO delivery_inbox;
    `,
  },
  {
    version: 8,
    name: '008_fixed_import_receipts',
    upSql: `
      CREATE TABLE fixed_import_receipts (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source_fingerprint TEXT NOT NULL,
        importer_version TEXT NOT NULL,
        id_algorithm TEXT NOT NULL,
        target_dsh TEXT NOT NULL,
        session_format INTEGER NOT NULL,
        source_chats_count INTEGER NOT NULL,
        source_messages_count INTEGER NOT NULL,
        imported_messages_count INTEGER NOT NULL,
        dropped_messages_count INTEGER NOT NULL,
        attachments_count INTEGER NOT NULL,
        canonical_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        PRIMARY KEY (user_id, source_fingerprint)
      );
    `,
  },
  {
    version: 9,
    name: '009_agent_profiles_lifecycle_and_generations',
    upSql: `
      CREATE TABLE IF NOT EXISTS agent_profiles (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived', 'deleted')),
        active_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        UNIQUE(user_id, name)
      );

      CREATE TABLE IF NOT EXISTS agent_profile_snapshots (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE RESTRICT,
        version INTEGER NOT NULL,
        prompt_mode TEXT NOT NULL DEFAULT 'append' CHECK(prompt_mode = 'append'),
        prompt_hash TEXT NOT NULL CHECK(length(prompt_hash) = 64 AND prompt_hash NOT GLOB '*[^0-9a-f]*'),
        identity TEXT NOT NULL DEFAULT '',
        soul TEXT NOT NULL DEFAULT '',
        agents TEXT NOT NULL DEFAULT '',
        tools TEXT NOT NULL DEFAULT '',
        change_summary TEXT,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        UNIQUE(profile_id, version)
      );

      CREATE TABLE IF NOT EXISTS session_generations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        route_id TEXT NOT NULL REFERENCES session_routes(id) ON DELETE CASCADE,
        generation_number INTEGER NOT NULL DEFAULT 1,
        dsh_session_id TEXT NOT NULL,
        agent_profile_snapshot_id TEXT REFERENCES agent_profile_snapshots(id) ON DELETE RESTRICT,
        reset_reason TEXT,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        UNIQUE(route_id, generation_number)
      );

      ALTER TABLE spaces ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived', 'deleted'));
      ALTER TABLE spaces ADD COLUMN agent_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE RESTRICT;
      ALTER TABLE spaces ADD COLUMN agent_profile_snapshot_id TEXT REFERENCES agent_profile_snapshots(id) ON DELETE RESTRICT;

      ALTER TABLE session_routes ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived', 'deleted'));
      ALTER TABLE session_routes ADD COLUMN title TEXT;
      ALTER TABLE session_routes ADD COLUMN last_reset_at TEXT;
      ALTER TABLE session_routes ADD COLUMN reset_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE session_routes ADD COLUMN current_generation INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE session_routes ADD COLUMN agent_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE RESTRICT;
      ALTER TABLE session_routes ADD COLUMN agent_profile_snapshot_id TEXT REFERENCES agent_profile_snapshots(id) ON DELETE RESTRICT;

      INSERT INTO session_generations (
        id,
        user_id,
        route_id,
        generation_number,
        dsh_session_id,
        agent_profile_snapshot_id,
        reset_reason,
        created_at
      )
      SELECT
        'gen_' || lower(hex(randomblob(16))),
        user_id,
        id,
        1,
        dsh_session_id,
        agent_profile_snapshot_id,
        'initial',
        created_at
      FROM session_routes;
    `,
  },
  {
    version: 10,
    name: '010_quota_bundles_lifecycle',
    upSql: `
      CREATE TABLE IF NOT EXISTS quota_bundles (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        delivery_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved', 'committed', 'released', 'expired')),
        turns_amount INTEGER NOT NULL DEFAULT 1,
        messages_amount INTEGER NOT NULL DEFAULT 1,
        tokens_amount INTEGER NOT NULL DEFAULT 0,
        is_estimate_tokens INTEGER NOT NULL DEFAULT 1,
        turns_committed INTEGER,
        messages_committed INTEGER,
        tokens_committed INTEGER,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        settled_at TEXT,
        metadata TEXT,
        UNIQUE(user_id, delivery_id)
      );

      CREATE INDEX IF NOT EXISTS idx_quota_bundles_user_status ON quota_bundles(user_id, status);
      CREATE INDEX IF NOT EXISTS idx_quota_bundles_delivery ON quota_bundles(user_id, delivery_id);
      CREATE INDEX IF NOT EXISTS idx_quota_bundles_expires_at ON quota_bundles(expires_at);

      ALTER TABLE quota_reservations ADD COLUMN bundle_id TEXT REFERENCES quota_bundles(id) ON DELETE SET NULL;
      ALTER TABLE quota_reservations ADD COLUMN delivery_id TEXT;

      CREATE INDEX IF NOT EXISTS idx_quota_reservations_bundle_id ON quota_reservations(user_id, bundle_id);
      CREATE INDEX IF NOT EXISTS idx_quota_reservations_delivery_id ON quota_reservations(user_id, delivery_id);
    `,
  },
];

export const TEST_V10_FULL_MIGRATIONS = TEST_V9_FULL_MIGRATIONS;
export const TEST_FULL_MIGRATIONS = TEST_V9_FULL_MIGRATIONS;

describe('Sqlite Agent Profile, Session Generation & Extended Repositories', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    storage = await createSqliteStorage({
      database: db,
      autoMigrate: true,
      migrations: TEST_V9_FULL_MIGRATIONS,
    });

    // Create test users
    await storage.users.create({
      id: 'u_alice',
      username: 'alice',
      passwordHash: 'hash_alice',
    });
    await storage.users.create({
      id: 'u_bob',
      username: 'bob',
      passwordHash: 'hash_bob',
    });
  });

  afterEach(() => {
    db.close();
  });

  describe('1. Agent Profiles CRUD and 4-Section Snapshots', () => {
    it('creates profile with initial immutable snapshot in append mode', async () => {
      const alice = storage.forTenant('u_alice');

      const profile = await alice.agentProfiles.create({
        name: 'Full Stack Engineer',
        description: 'TypeScript & SQLite expert',
        identity: 'You are an expert TypeScript engineer.',
        soul: 'Be concise, precise, thoughtful and test-driven.',
        agents: 'Delegate scoped tasks to worker subagents.',
        tools: 'Use SQLite DatabaseSync for all persistence.',
      });

      expect(profile.id).toBeDefined();
      expect(profile.name).toBe('Full Stack Engineer');
      expect(profile.status).toBe('active');
      expect(profile.activeVersion).toBe(1);
      expect(profile.snapshot).toBeDefined();
      expect(profile.snapshot?.version).toBe(1);
      expect(profile.snapshot?.promptMode).toBe('append');
      expect(profile.snapshot?.identity).toBe('You are an expert TypeScript engineer.');
      expect(profile.snapshot?.soul).toBe('Be concise, precise, thoughtful and test-driven.');
      expect(profile.snapshot?.agents).toBe('Delegate scoped tasks to worker subagents.');
      expect(profile.snapshot?.tools).toBe('Use SQLite DatabaseSync for all persistence.');

      // Check composed prompt output
      const prompt = composeAgentProfilePrompt(profile.snapshot!);
      expect(prompt).toContain('### AGENT IDENTITY\nYou are an expert TypeScript engineer.');
      expect(prompt).toContain('### AGENT SOUL\nBe concise, precise, thoughtful and test-driven.');
      expect(prompt).toContain('### SUB-AGENTS & DELEGATION\nDelegate scoped tasks to worker subagents.');
      expect(prompt).toContain('### TOOLS GUIDELINES\nUse SQLite DatabaseSync for all persistence.');
    });

    it('strictly forbids prompt mode other than append (validation & check constraint)', async () => {
      const alice = storage.forTenant('u_alice');

      await expect(
        alice.agentProfiles.create({
          name: 'Illegal Mode Agent',
          promptMode: 'replace' as unknown as 'append',
          identity: 'Forbidden replacement',
        })
      ).rejects.toThrow(ValidationError);
    });

    it('creates new version snapshots immutably and preserves complete history', async () => {
      const alice = storage.forTenant('u_alice');

      const profile = await alice.agentProfiles.create({
        name: 'Refactoring Assistant',
        identity: 'Version 1 Identity',
        soul: 'Version 1 Soul',
      });

      // Create Version 2
      const snapshotV2 = await alice.agentProfiles.createVersion(profile.id, {
        identity: 'Version 2 Identity (Enhanced)',
        soul: 'Version 2 Soul',
        agents: 'Version 2 Agents',
        changeSummary: 'Upgraded to Version 2',
      });

      expect(snapshotV2.version).toBe(2);
      expect(snapshotV2.identity).toBe('Version 2 Identity (Enhanced)');

      // Verify active version updated on profile
      const updatedProfile = await alice.agentProfiles.findById(profile.id);
      expect(updatedProfile?.activeVersion).toBe(2);

      // Verify all snapshots are preserved in append-only history
      const history = await alice.agentProfiles.listSnapshots(profile.id);
      expect(history.length).toBe(2);
      expect(history[0].version).toBe(1);
      expect(history[0].identity).toBe('Version 1 Identity');
      expect(history[1].version).toBe(2);
      expect(history[1].identity).toBe('Version 2 Identity (Enhanced)');

      // Fetch snapshot by specific version
      const v1Fetch = await alice.agentProfiles.getSnapshot(profile.id, 1);
      expect(v1Fetch?.identity).toBe('Version 1 Identity');
    });

    it('performs atomic rollback by creating a new immutable snapshot with target version content', async () => {
      const alice = storage.forTenant('u_alice');

      const profile = await alice.agentProfiles.create({
        name: 'Rollback Candidate',
        identity: 'V1 Golden Standard',
        soul: 'V1 Stable Tone',
      });

      // Create V2
      await alice.agentProfiles.createVersion(profile.id, {
        identity: 'V2 Flawed Identity',
        soul: 'V2 Experimental Tone',
        changeSummary: 'Experimental update',
      });

      // Create V3
      await alice.agentProfiles.createVersion(profile.id, {
        identity: 'V3 Broken Identity',
        soul: 'V3 Unstable Tone',
        changeSummary: 'Another broken update',
      });

      const currentProfile = await alice.agentProfiles.findById(profile.id);
      expect(currentProfile?.activeVersion).toBe(3);

      // Perform atomic rollback to Version 1
      const rollbackSnapshot = await alice.agentProfiles.rollbackVersion(profile.id, {
        targetVersion: 1,
        changeSummary: 'Emergency rollback to V1 Golden Standard',
      });

      // Invariant: Rollback creates Version 4 (new snapshot) with V1 content
      expect(rollbackSnapshot.version).toBe(4);
      expect(rollbackSnapshot.identity).toBe('V1 Golden Standard');
      expect(rollbackSnapshot.soul).toBe('V1 Stable Tone');
      expect(rollbackSnapshot.changeSummary).toBe('Emergency rollback to V1 Golden Standard');

      const finalProfile = await alice.agentProfiles.findById(profile.id);
      expect(finalProfile?.activeVersion).toBe(4);

      // Complete history has 4 immutable records
      const fullHistory = await alice.agentProfiles.listSnapshots(profile.id);
      expect(fullHistory.length).toBe(4);
      expect(fullHistory.map((s) => s.version)).toEqual([1, 2, 3, 4]);
    });
  });

  describe('2. Space Default Binding and Cascading Agent Profile Resolution', () => {
    it('correctly resolves cascading agent profiles: route override > space default > none', async () => {
      const alice = storage.forTenant('u_alice');

      // 1. Create Space profile (Default)
      const spaceProfile = await alice.agentProfiles.create({
        name: 'Space Level Profile',
        identity: 'I am the space default assistant.',
        soul: 'Helpful and polite.',
      });

      // 2. Create Session override profile
      const sessionProfile = await alice.agentProfiles.create({
        name: 'Session Specialized Profile',
        identity: 'I am a specialized Python code reviewer.',
        soul: 'Strict and meticulous.',
      });

      // 3. Create Space with default agent profile binding
      const space = await alice.spaces.create({
        name: 'Engineering Workspace',
        folder: 'space-00000000000000000000000000000001',
        agentProfileId: spaceProfile.id,
      });

      // 4. Session 1: Inherits Space profile (no session-level override)
      const session1 = await alice.sessionRoutes.create({
        spaceId: space.id,
        channel: 'web',
        nativeContextId: 'sess_default_1',
        dshSessionId: 'ses_00000000000000000000000000000001',
      });

      const effective1 = await alice.sessionRoutes.resolveAgentProfile!(session1.id);
      expect(effective1.source).toBe('space');
      expect(effective1.profileId).toBe(spaceProfile.id);
      expect(effective1.identity).toBe('I am the space default assistant.');
      expect(effective1.composedPrompt).toContain('### AGENT IDENTITY\nI am the space default assistant.');

      // 5. Session 2: Has explicit session-level profile override
      const session2 = await alice.sessionRoutes.create({
        spaceId: space.id,
        channel: 'web',
        nativeContextId: 'sess_override_2',
        dshSessionId: 'ses_00000000000000000000000000000002',
        agentProfileId: sessionProfile.id,
      });

      const effective2 = await alice.sessionRoutes.resolveAgentProfile!(session2.id);
      expect(effective2.source).toBe('route');
      expect(effective2.profileId).toBe(sessionProfile.id);
      expect(effective2.identity).toBe('I am a specialized Python code reviewer.');
      expect(effective2.composedPrompt).toContain('### AGENT IDENTITY\nI am a specialized Python code reviewer.');

      // 6. Session 3: Space with no profile returns source: 'none'
      const bareSpace = await alice.spaces.create({
        name: 'Bare Workspace',
        folder: 'space-00000000000000000000000000000002',
      });
      const session3 = await alice.sessionRoutes.create({
        spaceId: bareSpace.id,
        channel: 'web',
        nativeContextId: 'sess_bare_3',
        dshSessionId: 'ses_00000000000000000000000000000003',
      });

      const effective3 = await alice.sessionRoutes.resolveAgentProfile!(session3.id);
      expect(effective3.source).toBe('none');
      expect(effective3.composedPrompt).toBe('');
    });
  });

  describe('3. Generational Session Reset & DSH JSONL Immutability', () => {
    it('performs atomic generational reset, increments generations, and preserves history', async () => {
      const alice = storage.forTenant('u_alice');

      const space = await alice.spaces.create({
        name: 'Reset Test Space',
        folder: 'space-00000000000000000000000000000003',
      });

      const route = await alice.sessionRoutes.create({
        spaceId: space.id,
        channel: 'web',
        nativeContextId: 'ctx_reset_test',
        dshSessionId: 'ses_00000000000000000000000000000004',
        title: 'Initial Conversation Topic',
      });

      expect(route.currentGeneration).toBe(1);
      expect(route.resetCount).toBe(0);
      expect(route.lastResetAt).toBeNull();

      // Perform 1st Generative Reset
      const reset1 = await alice.sessionRoutes.reset!(route.id, {
        resetReason: 'User requested new conversation context',
        dshSessionId: 'ses_00000000000000000000000000000005',
        agentProfileSnapshotId: null,
      });

      expect(reset1.route.currentGeneration).toBe(2);
      expect(reset1.route.resetCount).toBe(1);
      expect(reset1.route.lastResetAt).toBeDefined();
      expect(reset1.generation.generationNumber).toBe(2);
      expect(reset1.generation.resetReason).toBe('User requested new conversation context');
      expect(reset1.generation.dshSessionId).toBe('ses_00000000000000000000000000000005');

      // Perform 2nd Generative Reset
      const reset2 = await alice.sessionRoutes.reset!(route.id, {
        resetReason: 'Switched focus to bugfix',
        dshSessionId: 'ses_00000000000000000000000000000006',
        agentProfileSnapshotId: null,
      });

      expect(reset2.route.currentGeneration).toBe(3);
      expect(reset2.route.resetCount).toBe(2);
      expect(reset2.generation.generationNumber).toBe(3);

      // Verify list of generations in order (initial gen 1 created on route creation + 2 resets = 3 generations)
      const genRepo = alice.sessionGenerations;
      const allGenerations = await genRepo.listByRouteId(route.id);
      expect(allGenerations.length).toBe(3);
      expect(allGenerations[0].generationNumber).toBe(1);
      expect(allGenerations[0].resetReason).toBe('initial');
      expect(allGenerations[0].dshSessionId).toBe('ses_00000000000000000000000000000004');
      expect(allGenerations[1].generationNumber).toBe(2);
      expect(allGenerations[1].resetReason).toBe('User requested new conversation context');
      expect(allGenerations[1].dshSessionId).toBe('ses_00000000000000000000000000000005');
      expect(allGenerations[2].generationNumber).toBe(3);
      expect(allGenerations[2].resetReason).toBe('Switched focus to bugfix');
      expect(allGenerations[2].dshSessionId).toBe('ses_00000000000000000000000000000006');

      const latestGen = await genRepo.getLatestByRouteId(route.id);
      expect(latestGen?.generationNumber).toBe(3);
    });
  });

  describe('4. Multi-Tenant Isolation & Cross-Tenant Non-Existence', () => {
    it('enforces that cross-tenant queries uniformly act as if entities do not exist', async () => {
      const alice = storage.forTenant('u_alice');
      const bob = storage.forTenant('u_bob');

      // Alice creates profile, space, route
      const aliceProfile = await alice.agentProfiles.create({
        name: 'Alice Secret Agent',
        identity: 'Alice Confidential Identity',
      });

      const aliceSpace = await alice.spaces.create({
        name: 'Alice Secret Space',
        folder: 'space-00000000000000000000000000000007',
        agentProfileId: aliceProfile.id,
      });

      const aliceRoute = await alice.sessionRoutes.create({
        spaceId: aliceSpace.id,
        channel: 'web',
        nativeContextId: 'alice_sec_ctx',
        dshSessionId: 'ses_00000000000000000000000000000007',
      });

      // 1. Bob cannot find Alice's profile by ID or name
      expect(await bob.agentProfiles.findById(aliceProfile.id)).toBeNull();
      expect(await bob.agentProfiles.findByName('Alice Secret Agent')).toBeNull();
      expect(await bob.agentProfiles.getWithActiveSnapshot(aliceProfile.id)).toBeNull();
      expect(await bob.agentProfiles.listSnapshots(aliceProfile.id)).toEqual([]);

      // 2. Bob cannot update or archive Alice's profile (throws NotFoundError)
      await expect(
        bob.agentProfiles.update(aliceProfile.id, { name: 'Hacked Profile' })
      ).rejects.toThrow(NotFoundError);

      await expect(
        bob.agentProfiles.createVersion(aliceProfile.id, { identity: 'Hacked Version' })
      ).rejects.toThrow(NotFoundError);

      await expect(
        bob.agentProfiles.rollbackVersion(aliceProfile.id, { targetVersion: 1 })
      ).rejects.toThrow(NotFoundError);

      await expect(
        bob.agentProfiles.archive(aliceProfile.id)
      ).rejects.toThrow(NotFoundError);

      // Verify no hard delete method exists on repository or delete returns false
      expect(await bob.agentProfiles.delete(aliceProfile.id)).toBe(false);

      // 3. Bob cannot access Alice's space or route
      expect(await bob.spaces.findById(aliceSpace.id)).toBeNull();
      expect(await bob.spaces.findByFolder('space-00000000000000000000000000000007')).toBeNull();
      expect(await bob.sessionRoutes.findById(aliceRoute.id)).toBeNull();
      expect(await bob.sessionRoutes.findByDshSessionId('ses_00000000000000000000000000000007')).toBeNull();

      // 4. Bob cannot reset Alice's session route
      await expect(
        bob.sessionRoutes.reset!(aliceRoute.id, {
          resetReason: 'Malicious reset',
          dshSessionId: 'ses_00000000000000000000000000000008',
          agentProfileSnapshotId: null,
        })
      ).rejects.toThrow(NotFoundError);

      // 5. Bob's list queries return 0 items
      expect(await bob.agentProfiles.list()).toEqual([]);
      expect(await bob.spaces.list()).toEqual([]);
      expect(await bob.sessionRoutes.list()).toEqual([]);
    });
  });

  describe('5. High Concurrency & Lock Resilience', () => {
    it('handles concurrent version creation and snapshots across multiple DatabaseSync connections cleanly', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'enkeep-concurrency-test-'));
      const dbPath = join(tempDir, 'concurrent-v9.db');

      try {
        const db1 = new DatabaseSync(dbPath);
        const db2 = new DatabaseSync(dbPath);
        db1.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000;');
        db2.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000;');

        const s1 = await createSqliteStorage({ database: db1, autoMigrate: true, migrations: TEST_V9_FULL_MIGRATIONS });
        const s2 = await createSqliteStorage({ database: db2, autoMigrate: false, migrations: TEST_V9_FULL_MIGRATIONS });

        await s1.users.create({ id: 'u_concurrent', username: 'concurrent_user', passwordHash: 'h' });

        const t1 = s1.forTenant('u_concurrent');
        const t2 = s2.forTenant('u_concurrent');

        const profile = await t1.agentProfiles.create({
          name: 'Concurrency Champion',
          identity: 'Initial Thread Identity',
        });

        // Concurrently create versions from two independent connections
        const results = await Promise.all([
          t1.agentProfiles.createVersion(profile.id, { identity: 'Thread 1 update', changeSummary: 'T1' }),
          t2.agentProfiles.createVersion(profile.id, { identity: 'Thread 2 update', changeSummary: 'T2' }),
        ]);

        expect(results.length).toBe(2);
        const versions = results.map((r) => r.version).sort((a, b) => a - b);
        expect(versions).toEqual([2, 3]);

        const snapshots = await t1.agentProfiles.listSnapshots(profile.id);
        expect(snapshots.length).toBe(3);

        db1.close();
        db2.close();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
