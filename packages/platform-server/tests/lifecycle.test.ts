import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { DefaultAuthService } from '@enkeep/platform-auth';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import {
  NotFoundError,
  ValidationError,
  PlatformError,
} from '@enkeep/platform-core';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
} from '../src/storage/migrations.js';
import { SqliteWebMessageStore } from '../src/storage/web-messages.js';
import { SqlitePlatformWebApiAdapter } from '../src/storage/sqlite-platform-api.js';

describe('Enkeep Space and Session Lifecycle Platform Service Tests', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let authService: DefaultAuthService;
  let messageStore: SqliteWebMessageStore;
  let adapter: SqlitePlatformWebApiAdapter;

  const tenantAlice = 'usr_alice_123';
  const tenantBob = 'usr_bob_456';

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    storage = new SqlitePlatformStorage(db);
    authService = new DefaultAuthService(storage, {
      cookieSecret: 'test-cookie-secret-32-chars-long-here!',
    });
    messageStore = new SqliteWebMessageStore(db);
    adapter = new SqlitePlatformWebApiAdapter({
      storage,
      authService,
      messageStore,
      db,
    });

    // Seed test users
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
      VALUES (?, 'alice', 'hash_alice', 'user', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(tenantAlice);

    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
      VALUES (?, 'bob', 'hash_bob', 'user', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(tenantBob);
  });

  describe('1. Space Lifecycle & Immutability Rules', () => {
    it('creates space with name only and active status', async () => {
      const space = await adapter.createSpace(tenantAlice, {
        name: 'Alice Workspace',
      });

      expect(space.id).toBeDefined();
      expect(space.name).toBe('Alice Workspace');
      expect(space.status).toBe('active');
      expect((space as any).userId).toBeUndefined();
      expect((space as any).folder).toBeUndefined();
      expect(space.executionMode).toBe('container');
    });

    it('rejects empty name on space creation', async () => {
      await expect(
        adapter.createSpace(tenantAlice, {
          name: '   ',
        })
      ).rejects.toThrow(ValidationError);
    });

    it('updates space name successfully', async () => {
      const space = await adapter.createSpace(tenantAlice, {
        name: 'Old Name',
      });

      const updated = await adapter.updateSpace(tenantAlice, space.id, {
        name: 'New Name',
      });

      expect(updated.name).toBe('New Name');
      expect(updated.status).toBe('active');
    });

    it('rejects empty name on space update', async () => {
      const space = await adapter.createSpace(tenantAlice, {
        name: 'Immutability Space',
      });

      await expect(
        adapter.updateSpace(tenantAlice, space.id, {
          name: '   ',
        })
      ).rejects.toThrow(ValidationError);
    });

    it('returns 404 NotFoundError on cross-tenant space update', async () => {
      const aliceSpace = await adapter.createSpace(tenantAlice, {
        name: 'Alice Private Space',
      });

      // Bob tries to update Alice's space
      await expect(
        adapter.updateSpace(tenantBob, aliceSpace.id, {
          name: 'Hacked by Bob',
        })
      ).rejects.toThrow(NotFoundError);
    });

    it('returns 404 NotFoundError on cross-tenant space archive or get', async () => {
      const aliceSpace = await adapter.createSpace(tenantAlice, {
        name: 'Alice Confidential Space',
      });

      // Bob tries to read Alice's space
      const readByBob = await adapter.getSpace(tenantBob, aliceSpace.id);
      expect(readByBob).toBeNull();

      // Bob tries to archive Alice's space
      await expect(adapter.archiveSpace(tenantBob, aliceSpace.id)).rejects.toThrow(NotFoundError);
    });
  });

  describe('2. Space Archival, Soft-Deletion & Turn Race Protection', () => {
    it('archives space as soft-delete without physical deletion and cascades to sessions', async () => {
      const space = await adapter.createSpace(tenantAlice, {
        name: 'Space to Archive',
      });

      const session = await adapter.createSession(tenantAlice, {
        spaceId: space.id,
      });

      const archivedSpace = await adapter.archiveSpace(tenantAlice, space.id);
      expect(archivedSpace.status).toBe('archived');

      // Default listSpaces should not include archived space
      const activeSpaces = await adapter.listSpaces(tenantAlice);
      expect(activeSpaces.find((s) => s.id === space.id)).toBeUndefined();

      // Explicit includeArchived returns it
      const allSpaces = await adapter.listSpaces(tenantAlice, { includeArchived: true });
      expect(allSpaces.find((s) => s.id === space.id)).toBeDefined();

      // Child session should also be archived
      const sessionAfter = await adapter.getSession(tenantAlice, session.id);
      expect(sessionAfter?.status).toBe('archived');

      // Default listSessions should not include it
      const activeSessions = await adapter.listSessions(tenantAlice, space.id);
      expect(activeSessions.find((s) => s.id === session.id)).toBeUndefined();
    });

    it('rejects space archive with 409 Conflict if active turn is queued or running', async () => {
      const space = await adapter.createSpace(tenantAlice, {
        name: 'Busy Space',
      });

      const session = await adapter.createSession(tenantAlice, {
        spaceId: space.id,
      });

      // Simulate a running turn run in the database
      db.prepare(`
        INSERT INTO turn_runs (id, user_id, space_id, route_id, turn_id, status, execution_mode, created_at, updated_at)
        VALUES ('turn_run_1', ?, ?, ?, 'turn_1', 'running', 'container', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(tenantAlice, space.id, session.id);

      // Attempt to archive space while turn is running
      try {
        await adapter.archiveSpace(tenantAlice, space.id);
        expect.unreachable('Should have thrown 409 Conflict');
      } catch (err: any) {
        expect(err).toBeInstanceOf(PlatformError);
        expect(err.status).toBe(409);
        expect(err.message).toContain('active (running/queued) turns');
      }

      // Complete the turn
      db.prepare(`UPDATE turn_runs SET status = 'completed' WHERE id = 'turn_run_1'`).run();

      // Archiving space should now succeed
      const archived = await adapter.archiveSpace(tenantAlice, space.id);
      expect(archived.status).toBe('archived');
    });

    it('prevents session creation in an archived space', async () => {
      const space = await adapter.createSpace(tenantAlice, {
        name: 'Archived Space',
      });

      await adapter.archiveSpace(tenantAlice, space.id);

      await expect(
        adapter.createSession(tenantAlice, {
          spaceId: space.id,
        })
      ).rejects.toThrow(ValidationError);
    });

    it('enforces active space check in ensureActiveSessionForTurn', async () => {
      const space = await adapter.createSpace(tenantAlice, {
        name: 'Turn Target Space',
      });

      const session = await adapter.createSession(tenantAlice, {
        spaceId: space.id,
      });

      // Active check succeeds initially
      const route = await adapter.ensureActiveSessionForTurn(tenantAlice, session.id);
      expect(route.id).toBe(session.id);

      // Archive space
      await adapter.archiveSpace(tenantAlice, space.id);

      // Active check now fails
      await expect(
        adapter.ensureActiveSessionForTurn(tenantAlice, session.id)
      ).rejects.toThrow(PlatformError);
    });
  });

  describe('3. Session Lifecycle, Titles, Immutability & Cross-Tenant Protection', () => {
    it('creates session with full 128-bit hex UUID id, initializes gen 1, and active status', async () => {
      const space = await adapter.createSpace(tenantAlice, {
        name: 'Session Main Space',
      });

      const session = await adapter.createSession(tenantAlice, {
        spaceId: space.id,
        title: 'Initial Title',
      });

      expect(session.id.startsWith('ses_')).toBe(true);
      // Full 128-bit UUID is 32 hex chars (+ 4 prefix 'ses_' = 36 total)
      expect(session.id.length).toBe(36);
      expect(session.spaceId).toBe(space.id);
      expect(session.status).toBe('active');
      expect(session.title).toBe('Initial Title');
      expect(session.currentGeneration).toBe(1);
      expect((session as any).userId).toBeUndefined();
      expect((session as any).peerId).toBeUndefined();
      expect((session as any).dshSessionId).toBeUndefined();
      expect((session as any).executionMode).toBeUndefined();

      // Verify generation 1 was recorded
      const gens = await adapter.listSessionGenerations(tenantAlice, session.id);
      expect(gens.length).toBe(1);
      expect(gens[0].generation).toBe(1);
      expect(gens[0].resetReason).toBe('initial');
      expect(gens[0].isCurrent).toBe(true);
      expect((gens[0] as any).dshCheckpoint).toBeUndefined();
    });

    it('updates session title successfully', async () => {
      const spaceA = await adapter.createSpace(tenantAlice, {
        name: 'Space A',
      });

      const session = await adapter.createSession(tenantAlice, {
        spaceId: spaceA.id,
        title: 'Old Title',
      });

      const updated = await adapter.updateSession(tenantAlice, session.id, {
        title: 'Updated Title',
      });

      expect(updated.title).toBe('Updated Title');
      expect(updated.spaceId).toBe(spaceA.id);
    });

    it('returns 404 NotFoundError on cross-tenant session access, update, and reset', async () => {
      const spaceAlice = await adapter.createSpace(tenantAlice, {
        name: 'Alice Space',
      });
      const sessionAlice = await adapter.createSession(tenantAlice, {
        spaceId: spaceAlice.id,
        title: 'Alice Secret Session',
      });

      // Bob cannot get Alice session
      const getResult = await adapter.getSession(tenantBob, sessionAlice.id);
      expect(getResult).toBeNull();

      // Bob cannot update Alice session
      await expect(
        adapter.updateSession(tenantBob, sessionAlice.id, {
          title: 'Hacked Title',
        })
      ).rejects.toThrow(NotFoundError);

      // Bob cannot archive Alice session
      await expect(adapter.archiveSession(tenantBob, sessionAlice.id)).rejects.toThrow(NotFoundError);

      // Bob cannot reset Alice session
      await expect(
        adapter.resetSession(tenantBob, sessionAlice.id, {
          idempotencyKey: '00000000-0000-4000-8000-000000000001',
        })
      ).rejects.toThrow(NotFoundError);

      // Bob cannot list Alice session generations
      await expect(adapter.listSessionGenerations(tenantBob, sessionAlice.id)).rejects.toThrow(NotFoundError);
    });
  });

  describe('4. Generational Session Reset & Lifecycle Idempotency', () => {
    it('performs atomic generational reset preserving history and recording generations', async () => {
      const space = await adapter.createSpace(tenantAlice, {
        name: 'Gen Space',
      });

      const session = await adapter.createSession(tenantAlice, {
        spaceId: space.id,
        title: 'Generation 1 Session',
      });

      const route = db.prepare('SELECT dsh_session_id FROM session_routes WHERE id = ?').get(session.id) as { dsh_session_id: string };

      // Ingest a message in gen 1
      await messageStore.ingestWebDelivery({
        userId: tenantAlice,
        sessionId: session.id,
        spaceId: space.id,
        dshSessionId: route.dsh_session_id,
        idempotencyKey: 'idemp_msg_1',
        content: 'Hello in Generation 1',
        timestamp: new Date().toISOString(),
      });

      // Complete the in-flight turn
      db.prepare(`UPDATE turn_runs SET status = 'completed' WHERE route_id = ?`).run(session.id);

      // Reset session to generation 2
      const resetResult = await adapter.resetSession(tenantAlice, session.id, {
        idempotencyKey: '11111111-1111-4111-8111-111111111111',
        reason: 'context_overflow',
      });

      expect(resetResult.generation.generation).toBe(2);
      expect(resetResult.generation.resetReason).toBe('context_overflow');
      expect(resetResult.session.currentGeneration).toBe(2);
      expect(resetResult.isIdempotentHit).toBe(false);
      expect((resetResult as any).previousDshSessionId).toBeUndefined();
      expect((resetResult as any).newDshSessionId).toBeUndefined();

      // Verify route state in database
      const routeGen2 = await adapter.getSession(tenantAlice, session.id);
      expect(routeGen2?.currentGeneration).toBe(2);

      // Check generations table
      const generations = await adapter.listSessionGenerations(tenantAlice, session.id);
      expect(generations.length).toBe(2);
      expect(generations[0].generation).toBe(1);
      expect(generations[0].resetReason).toBe('initial');
      expect(generations[0].isCurrent).toBe(false);

      expect(generations[1].generation).toBe(2);
      expect(generations[1].resetReason).toBe('context_overflow');
      expect(generations[1].isCurrent).toBe(true);

      // Invariant: Old messages in web_messages MUST be preserved (never truncated)
      const messages = await adapter.listMessages(tenantAlice, session.id);
      expect(messages.messages.length).toBe(1);
      expect(messages.messages[0].content).toBe('Hello in Generation 1');

      // Reset session again to generation 3
      const resetResult3 = await adapter.resetSession(tenantAlice, session.id, {
        idempotencyKey: '22222222-2222-4222-8222-222222222222',
        reason: 'user_request',
      });
      expect(resetResult3.generation.generation).toBe(3);
      expect(resetResult3.session.currentGeneration).toBe(3);

      const generations3 = await adapter.listSessionGenerations(tenantAlice, session.id);
      expect(generations3.length).toBe(3);
      expect(generations3[0].generation).toBe(1);
      expect(generations3[1].generation).toBe(2);
      expect(generations3[2].generation).toBe(3);
      expect(generations3[2].isCurrent).toBe(true);
    });

    it('rejects session reset with 409 Conflict if active turn is running', async () => {
      const space = await adapter.createSpace(tenantAlice, {
        name: 'Reset Race Space',
      });

      const session = await adapter.createSession(tenantAlice, {
        spaceId: space.id,
      });

      // Insert queued turn run
      db.prepare(`
        INSERT INTO turn_runs (id, user_id, space_id, route_id, turn_id, status, execution_mode, created_at, updated_at)
        VALUES ('turn_run_queued_1', ?, ?, ?, 'turn_q1', 'queued', 'container', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(tenantAlice, space.id, session.id);

      // Attempt to reset
      try {
        await adapter.resetSession(tenantAlice, session.id, {
          idempotencyKey: '33333333-3333-4333-8333-333333333333',
        });
        expect.unreachable('Should have thrown 409 Conflict');
      } catch (err: any) {
        expect(err).toBeInstanceOf(PlatformError);
        expect(err.status).toBe(409);
        expect(err.message).toContain('active (running/queued) turns');
      }

      // Mark turn run interrupted/completed
      db.prepare(`UPDATE turn_runs SET status = 'interrupted' WHERE id = 'turn_run_queued_1'`).run();

      // Reset should now succeed
      const res = await adapter.resetSession(tenantAlice, session.id, {
        idempotencyKey: '33333333-3333-4333-8333-333333333333',
      });
      expect(res.generation.generation).toBe(2);
      expect(res.isIdempotentHit).toBe(false);
    });

    it('supports Idempotency-Key on resetSession returning exact initial response on replay and rejecting collisions', async () => {
      const space = await adapter.createSpace(tenantAlice, {
        name: 'Idempotency Space',
      });

      const session = await adapter.createSession(tenantAlice, {
        spaceId: space.id,
      });

      const idempKey = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';

      // Rejects malformed idempotency key
      await expect(
        adapter.resetSession(tenantAlice, session.id, {
          idempotencyKey: 'not-a-valid-uuid',
        })
      ).rejects.toThrow(ValidationError);

      // Rejects non-v4 UUID (e.g. UUIDv1)
      await expect(
        adapter.resetSession(tenantAlice, session.id, {
          idempotencyKey: '9b1deb4d-3b7d-1bad-9bdd-2b0d7b3dcb6d',
        })
      ).rejects.toThrow(ValidationError);

      // Rejects uppercase UUIDv4 (must be strict lowercase)
      await expect(
        adapter.resetSession(tenantAlice, session.id, {
          idempotencyKey: '9B1DEB4D-3B7D-4BAD-9BDD-2B0D7B3DCB6D',
        })
      ).rejects.toThrow(ValidationError);

      // First call
      const res1 = await adapter.resetSession(tenantAlice, session.id, {
        idempotencyKey: idempKey,
        reason: 'user_request',
      });
      expect(res1.generation.generation).toBe(2);
      expect(res1.generation.resetReason).toBe('user_request');
      expect(res1.isIdempotentHit).toBe(false);

      // Replay with exact same Idempotency-Key and payload
      const res2 = await adapter.resetSession(tenantAlice, session.id, {
        idempotencyKey: idempKey,
        reason: 'user_request',
      });
      expect(res2.generation.generation).toBe(res1.generation.generation);
      expect(res2.generation.resetReason).toBe(res1.generation.resetReason);
      expect(res2.isIdempotentHit).toBe(true);

      // Number of generations should remain 2 (gen 1 initial + gen 2 reset, not duplicated)
      const gens = await adapter.listSessionGenerations(tenantAlice, session.id);
      expect(gens.length).toBe(2);

      // Replay with same Idempotency-Key but DIFFERENT payload throws 409 Conflict
      await expect(
        adapter.resetSession(tenantAlice, session.id, {
          idempotencyKey: idempKey,
          reason: 'context_overflow', // different reason => different canonical request hash
        })
      ).rejects.toThrow(PlatformError);

      // Reusing same Idempotency-Key on a DIFFERENT session throws 409 Conflict
      const session2 = await adapter.createSession(tenantAlice, {
        spaceId: space.id,
      });

      await expect(
        adapter.resetSession(tenantAlice, session2.id, {
          idempotencyKey: idempKey,
          reason: 'user_request',
        })
      ).rejects.toThrow(PlatformError);
    });
  });
});
