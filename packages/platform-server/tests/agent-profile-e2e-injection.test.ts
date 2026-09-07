import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { SqliteWebMessageStore } from '../src/storage/web-messages.js';
import { DeliveryRuntimeGateway, DeliveryTurnExecutor } from '../src/runtime/delivery-gateway.js';
import { PlatformProfileService } from '../src/profiles/profile-service.js';
import { SqlitePlatformWebApiAdapter } from '../src/storage/sqlite-platform-api.js';
import { PlatformServerMigrationRunner, ALL_PLATFORM_MIGRATIONS } from '../src/storage/migrations.js';
import { RuntimeAgentProfileSnapshot } from '@enkeep/runtime-runner';
import { WebChannelEnvelope, DEFAULT_WEB_ACCOUNT_ID } from '@enkeep/web-channel';

describe('Agent Profile End-to-End Runtime Injection Integration Tests', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let messageStore: SqliteWebMessageStore;
  let profileService: PlatformProfileService;
  let platformApi: SqlitePlatformWebApiAdapter;
  const aliceUserId = 'usr_alice_e2e_test';

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    storage = new SqlitePlatformStorage(db);
    messageStore = new SqliteWebMessageStore(db);
    profileService = new PlatformProfileService(storage, db);
    platformApi = new SqlitePlatformWebApiAdapter({
      db,
      storage,
      messageStore,
    });

    // Create tenant user
    await storage.users.create({
      id: aliceUserId,
      username: 'alice',
      passwordHash: 'hash',
      role: 'user',
      status: 'active',
      displayName: 'Alice',
    });
  });

  afterEach(async () => {
    if (storage) {
      await storage.close();
    }
    if (db) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  });

  function createEnvelope(session: { id: string; spaceId: string }, content: string): InboundEnvelope {
    return {
      id: `del_${randomUUID().replace(/-/g, '')}`,
      userId: aliceUserId,
      sessionId: session.id,
      content,
      timestamp: new Date().toISOString(),
    };
  }

  it('1. DeliveryRuntimeGateway resolves generation-pinned profile snapshot and injects into DeliveryTurnExecutor.execute', async () => {
    // 1. Create Profile V1
    const profile = await profileService.createProfile(aliceUserId, {
      name: 'Assistant Profile',
      identity: 'You are an expert platform assistant.',
      soul: 'You are concise, helpful, and safe.',
      agents: 'subagent-researcher: handles web search tasks.',
      tools: 'tool-calculator: evaluates math expressions.',
    });

    // 2. Create Space and Bind Profile V1
    const space = await platformApi.createSpace(aliceUserId, {
      name: 'Assistant Workspace',
      executionMode: 'container',
    });
    await profileService.bindSpaceProfile(aliceUserId, space.id, { profileId: profile.id, version: 1 });

    // 3. Create Session (inherits Space Profile V1 binding into Generation 1)
    const session = await platformApi.createSession(aliceUserId, {
      spaceId: space.id,
      channel: 'web',
      executionMode: 'container',
    });

    const dshSessionRow = db.prepare('SELECT dsh_session_id FROM session_routes WHERE id = ?').get(session.id) as { dsh_session_id: string };

    let executedProfile: RuntimeAgentProfileSnapshot | null | undefined;
    let executedDshSessionId: string | undefined;
    let executedTurnId: string | undefined;

    const mockExecutor: DeliveryTurnExecutor = {
      async execute(request) {
        executedProfile = request.profile;
        executedDshSessionId = request.dshSessionId;
        executedTurnId = request.turnId;
        return {
          replyText: 'Hello from assistant container',
          usage: { totalTokens: 10 },
        };
      },
      async cancel() {
        return true;
      },
    };

    const gateway = new DeliveryRuntimeGateway({
      storage,
      messageStore,
      database: db,
      executor: mockExecutor,
      quotaMode: 'disabled',
      profileResolver: profileService,
    });

    const envelope = createEnvelope(session, 'Hello assistant');
    const dispatchResult = await gateway.dispatchInbound(envelope);
    expect(dispatchResult.accepted).toBe(true);

    // Drain scheduled background turn
    await gateway.drain(1000);

    // Verify injected profile properties
    expect(executedProfile).toBeDefined();
    expect(executedProfile).not.toBeNull();
    expect(executedProfile?.profileId).toBe(profile.id);
    expect(executedProfile?.version).toBe(1);
    expect(executedProfile?.identity).toBe('You are an expert platform assistant.');
    expect(executedProfile?.soul).toBe('You are concise, helpful, and safe.');
    expect(executedProfile?.agents).toBe('subagent-researcher: handles web search tasks.');
    expect(executedProfile?.tools).toBe('tool-calculator: evaluates math expressions.');
    expect(executedProfile?.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(executedDshSessionId).toBe(dshSessionRow.dsh_session_id);
    expect(executedTurnId).toMatch(/^turn_[0-9a-f]{32}$/);
  });

  it('2. Pinned Generation 1 retains V1 profile even after Space updates to V2', async () => {
    // 1. Create Profile V1
    const profile = await profileService.createProfile(aliceUserId, {
      name: 'Governed Bot',
      identity: 'Bot V1 Identity',
      soul: 'Bot V1 Soul',
      agents: 'Bot V1 Agents',
      tools: 'Bot V1 Tools',
    });

    // 2. Create Space and Bind Profile V1
    const space = await platformApi.createSpace(aliceUserId, {
      name: 'Bot Space',
      executionMode: 'container',
    });
    await profileService.bindSpaceProfile(aliceUserId, space.id, { profileId: profile.id, version: 1 });

    // 3. Create Session at Generation 1 (pinned to V1)
    const session = await platformApi.createSession(aliceUserId, {
      spaceId: space.id,
      channel: 'web',
      executionMode: 'container',
    });

    // 4. Publish Profile V2 with updated identity & soul
    const v2 = await profileService.createVersion(aliceUserId, profile.id, {
      identity: 'Bot V2 Upgraded Identity',
      soul: 'Bot V2 Upgraded Soul',
      agents: 'Bot V2 Upgraded Agents',
      tools: 'Bot V2 Upgraded Tools',
    });
    expect(v2.version).toBe(2);

    // 5. Update Space to point to Profile V2 (applies to new session generations)
    await profileService.bindSpaceProfile(aliceUserId, space.id, { profileId: profile.id, version: 2 });

    let capturedProfile: RuntimeAgentProfileSnapshot | null | undefined;
    const mockExecutor: DeliveryTurnExecutor = {
      async execute(request) {
        capturedProfile = request.profile;
        return { replyText: 'Ok V1', usage: { totalTokens: 10 } };
      },
      async cancel() {
        return true;
      },
    };

    const gateway = new DeliveryRuntimeGateway({
      storage,
      messageStore,
      database: db,
      executor: mockExecutor,
      quotaMode: 'disabled',
      profileResolver: profileService,
    });

    const envelope = createEnvelope(session, 'Turn in Gen 1');
    await gateway.dispatchInbound(envelope);
    await gateway.drain(1000);

    // Generation 1 must STILL receive V1
    expect(capturedProfile).not.toBeNull();
    expect(capturedProfile?.version).toBe(1);
    expect(capturedProfile?.identity).toBe('Bot V1 Identity');
    expect(capturedProfile?.soul).toBe('Bot V1 Soul');
  });

  it('3. Generational Reset upgrades the session to Generation 2 and binds active V2 profile snapshot', async () => {
    // 1. Create Profile V1 & Space & Session
    const profile = await profileService.createProfile(aliceUserId, {
      name: 'Dynamic Bot',
      identity: 'V1 Initial Identity',
      soul: 'V1 Initial Soul',
    });
    const space = await platformApi.createSpace(aliceUserId, {
      name: 'Reset Space',
      executionMode: 'container',
    });
    await profileService.bindSpaceProfile(aliceUserId, space.id, { profileId: profile.id, version: 1 });
    const session = await platformApi.createSession(aliceUserId, {
      spaceId: space.id,
      channel: 'web',
      executionMode: 'container',
    });

    const initialDshSessionRow = db.prepare('SELECT dsh_session_id FROM session_routes WHERE id = ?').get(session.id) as { dsh_session_id: string };

    // 2. Publish Profile V2 and update Space binding
    await profileService.createVersion(aliceUserId, profile.id, {
      identity: 'V2 Reborn Identity',
      soul: 'V2 Reborn Soul',
    });
    await profileService.bindSpaceProfile(aliceUserId, space.id, { profileId: profile.id, version: 2 });

    // 3. Reset Session (increments generation to 2 and pins V2 snapshot)
    const resetResult = await platformApi.resetSession(aliceUserId, session.id, {
      reason: 'Upgrading to V2 bot profile',
      idempotencyKey: randomUUID(),
    });
    expect(resetResult.session.currentGeneration).toBe(2);

    const newDshSessionRow = db.prepare('SELECT dsh_session_id FROM session_routes WHERE id = ?').get(session.id) as { dsh_session_id: string };
    expect(newDshSessionRow.dsh_session_id).not.toBe(initialDshSessionRow.dsh_session_id);

    let capturedProfile: RuntimeAgentProfileSnapshot | null | undefined;
    let capturedDshSessionId: string | undefined;

    const mockExecutor: DeliveryTurnExecutor = {
      async execute(request) {
        capturedProfile = request.profile;
        capturedDshSessionId = request.dshSessionId;
        return { replyText: 'Ok V2', usage: { totalTokens: 10 } };
      },
      async cancel() {
        return true;
      },
    };

    const gateway = new DeliveryRuntimeGateway({
      storage,
      messageStore,
      database: db,
      executor: mockExecutor,
      quotaMode: 'disabled',
      profileResolver: profileService,
    });

    const envelope = createEnvelope(session, 'Turn in Gen 2 after reset');
    await gateway.dispatchInbound(envelope);
    await gateway.drain(1000);

    // Generation 2 must receive V2
    expect(capturedProfile).not.toBeNull();
    expect(capturedProfile?.version).toBe(2);
    expect(capturedProfile?.identity).toBe('V2 Reborn Identity');
    expect(capturedProfile?.soul).toBe('V2 Reborn Soul');
    expect(capturedDshSessionId).toBe(newDshSessionRow.dsh_session_id);
  });

  it('4. Unbound Session yields explicit null profile to DeliveryTurnExecutor', async () => {
    // 1. Create Space without profile binding
    const space = await platformApi.createSpace(aliceUserId, {
      name: 'Unbound Space',
      executionMode: 'container',
    });

    // 2. Create Session in unbound space
    const session = await platformApi.createSession(aliceUserId, {
      spaceId: space.id,
      channel: 'web',
      executionMode: 'container',
    });

    let capturedProfile: RuntimeAgentProfileSnapshot | null | undefined = 'initial' as any;

    const mockExecutor: DeliveryTurnExecutor = {
      async execute(request) {
        capturedProfile = request.profile;
        return { replyText: 'No profile attached', usage: { totalTokens: 10 } };
      },
      async cancel() {
        return true;
      },
    };

    const gateway = new DeliveryRuntimeGateway({
      storage,
      messageStore,
      database: db,
      executor: mockExecutor,
      quotaMode: 'disabled',
      profileResolver: profileService,
    });

    const envelope = createEnvelope(session, 'Turn in unbound session');
    await gateway.dispatchInbound(envelope);
    await gateway.drain(1000);

    // Profile must be explicitly null
    expect(capturedProfile).toBeNull();
  });

  it('5. Corrupted or tampered snapshot prompt_hash fails closed before turn creation or quota reservation without leaking hashes', async () => {
    // 1. Create Profile V1 & Space & Session
    const profile = await profileService.createProfile(aliceUserId, {
      name: 'Tamper Test Profile',
      identity: 'Original Identity',
      soul: 'Original Soul',
    });
    const space = await platformApi.createSpace(aliceUserId, {
      name: 'Tamper Space',
      executionMode: 'container',
    });
    await profileService.bindSpaceProfile(aliceUserId, space.id, { profileId: profile.id, version: 1 });
    const session = await platformApi.createSession(aliceUserId, {
      spaceId: space.id,
      channel: 'web',
      executionMode: 'container',
    });

    // 2. Tamper prompt_hash directly in SQLite database
    const fakeTamperedHash = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    db.prepare('UPDATE agent_profile_snapshots SET prompt_hash = ? WHERE profile_id = ?').run(
      fakeTamperedHash,
      profile.id
    );

    let executorCalled = false;
    const mockExecutor: DeliveryTurnExecutor = {
      async execute() {
        executorCalled = true;
        return { replyText: 'Should never execute' };
      },
      async cancel() {
        return true;
      },
    };

    const gateway = new DeliveryRuntimeGateway({
      storage,
      messageStore,
      database: db,
      executor: mockExecutor,
      quotaMode: 'disabled',
      profileResolver: profileService,
    });

    const envelope = createEnvelope(session, 'This should fail closed');

    // 3. Gateway dispatch must reject with FAIL_CLOSED (500)
    let caughtError: any;
    try {
      await gateway.dispatchInbound(envelope);
    } catch (err: any) {
      caughtError = err;
    }

    expect(caughtError).toBeDefined();
    expect(caughtError.code).toBe('FAIL_CLOSED');
    expect(caughtError.status).toBe(500);

    // Verify error message does NOT leak the tampered hash or internal hash
    expect(caughtError.message).not.toContain(fakeTamperedHash);

    // Executor must NEVER have been called
    expect(executorCalled).toBe(false);

    // ZERO turn_runs or delivery_inbox rows created
    const turnCount = (db.prepare('SELECT COUNT(*) as count FROM turn_runs').get() as { count: number }).count;
    const inboxCount = (db.prepare('SELECT COUNT(*) as count FROM delivery_inbox').get() as { count: number }).count;
    expect(turnCount).toBe(0);
    expect(inboxCount).toBe(0);
  });
});
