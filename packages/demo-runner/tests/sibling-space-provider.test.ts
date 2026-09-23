/**
 * Control-Plane Sibling-Space Provider & Turn Request Tests (G12-P3)
 *
 * Requirements:
 * 1. Owner sibling included: same user's other active spaces are included in extraReadableRoots
 * 2. Other user excluded: other users' spaces and unowned mounts/deleted/archived spaces are strictly excluded
 * 3. Container/host mapping: correctly maps to /home/dsh/spaces/<folder> (container) or <dataRoot>/host-runtimes/<user>/spaces/<folder> (host)
 * 4. Ordinary one-space unchanged: returns undefined when user only has a single space
 * 5. Control plane executor integration: dockerTurnExecutor constructs RuntimeTurnRequest with authoritative extraReadableRoots
 *
 * @module @enkeep/demo-runner/tests/sibling-space-provider.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  resolveSiblingExtraReadableRoots,
  MAX_SIBLING_EXTRA_READABLE_ROOTS,
} from '../src/up/sibling-roots.js';
import { launchDemoSystem } from '../src/up/index.js';
import { resetDemo } from '../src/reset/index.js';
import { FakeUnitRuntimeContainerAdapter } from './support/fake-runtime.js';
import { createTempRepo, type TempRepo } from './support/temp-repo.js';
import type { DeliveryExecutionRequest } from '@enkeep/platform-server';
import type { RuntimeTurnRequest } from '@enkeep/protocol';

describe('G12-P3: Control-Plane Sibling Space Provider', () => {
  let db: DatabaseSync;
  const ALICE_ID = 'usr_alice_000000000000000000000001';
  const BOB_ID = 'usr_bob_0000000000000000000000002';
  const DATA_ROOT = '/var/enkeep/test-data';

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'active'
      );

      CREATE TABLE spaces (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        folder TEXT NOT NULL,
        execution_mode TEXT NOT NULL DEFAULT 'container',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, folder)
      );

      CREATE TABLE space_mounts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        space_id TEXT NOT NULL,
        name TEXT NOT NULL,
        source_path_encrypted TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'ro'
      );
    `);

    db.prepare('INSERT INTO users (id, username) VALUES (?, ?)').run(ALICE_ID, 'alice');
    db.prepare('INSERT INTO users (id, username) VALUES (?, ?)').run(BOB_ID, 'bob');
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
  });

  describe('1. Owner sibling included', () => {
    it('includes other active spaces owned by the same user in extraReadableRoots', () => {
      // Alice has Space 1 (current), Space 2 (sibling A), and Space 3 (sibling B)
      db.prepare('INSERT INTO spaces (id, user_id, name, folder, status) VALUES (?, ?, ?, ?, ?)').run(
        'sp_alice_1', ALICE_ID, 'Alice Space 1', 'space-1', 'active'
      );
      db.prepare('INSERT INTO spaces (id, user_id, name, folder, status) VALUES (?, ?, ?, ?, ?)').run(
        'sp_alice_2', ALICE_ID, 'Alice Space 2', 'space-2', 'active'
      );
      db.prepare('INSERT INTO spaces (id, user_id, name, folder, status) VALUES (?, ?, ?, ?, ?)').run(
        'sp_alice_3', ALICE_ID, 'Alice Space 3', 'space-3', 'active'
      );

      const roots = resolveSiblingExtraReadableRoots({
        db,
        userId: ALICE_ID,
        currentSpaceId: 'sp_alice_1',
        currentSpaceFolder: 'space-1',
        isHost: false,
        dataRoot: DATA_ROOT,
      });

      expect(roots).toBeDefined();
      expect(roots).toEqual([
        '/home/dsh/spaces/space-2',
        '/home/dsh/spaces/space-3',
      ]);
    });

    it('resolves by username if userId is passed as username string', () => {
      db.prepare('INSERT INTO spaces (id, user_id, name, folder, status) VALUES (?, ?, ?, ?, ?)').run(
        'sp_alice_1', ALICE_ID, 'Alice Space 1', 'space-1', 'active'
      );
      db.prepare('INSERT INTO spaces (id, user_id, name, folder, status) VALUES (?, ?, ?, ?, ?)').run(
        'sp_alice_2', ALICE_ID, 'Alice Space 2', 'space-2', 'active'
      );

      const roots = resolveSiblingExtraReadableRoots({
        db,
        userId: 'alice',
        currentSpaceId: 'sp_alice_1',
        currentSpaceFolder: 'space-1',
        isHost: false,
        dataRoot: DATA_ROOT,
      });

      expect(roots).toBeDefined();
      expect(roots).toEqual(['/home/dsh/spaces/space-2']);
    });
  });

  describe('2. Other user excluded & unowned mounts/deleted excluded', () => {
    it('strictly excludes spaces belonging to other users', () => {
      // Alice has Space 1 (current) and Space 2 (sibling)
      db.prepare('INSERT INTO spaces (id, user_id, name, folder, status) VALUES (?, ?, ?, ?, ?)').run(
        'sp_alice_1', ALICE_ID, 'Alice Space 1', 'alice-1', 'active'
      );
      db.prepare('INSERT INTO spaces (id, user_id, name, folder, status) VALUES (?, ?, ?, ?, ?)').run(
        'sp_alice_2', ALICE_ID, 'Alice Space 2', 'alice-2', 'active'
      );

      // Bob has Space 3 and Space 4
      db.prepare('INSERT INTO spaces (id, user_id, name, folder, status) VALUES (?, ?, ?, ?, ?)').run(
        'sp_bob_1', BOB_ID, 'Bob Space 1', 'bob-1', 'active'
      );
      db.prepare('INSERT INTO spaces (id, user_id, name, folder, status) VALUES (?, ?, ?, ?, ?)').run(
        'sp_bob_2', BOB_ID, 'Bob Space 2', 'bob-2', 'active'
      );

      // Unowned mount belonging to Bob
      db.prepare('INSERT INTO space_mounts (id, user_id, space_id, name, source_path_encrypted, source_fingerprint) VALUES (?, ?, ?, ?, ?, ?)').run(
        'mount_bob', BOB_ID, 'sp_bob_1', 'secret-mount', 'enc', 'fp'
      );

      // Query Alice's siblings from Alice Space 1
      const aliceRoots = resolveSiblingExtraReadableRoots({
        db,
        userId: ALICE_ID,
        currentSpaceId: 'sp_alice_1',
        currentSpaceFolder: 'alice-1',
        isHost: false,
        dataRoot: DATA_ROOT,
      });

      expect(aliceRoots).toBeDefined();
      expect(aliceRoots).toEqual(['/home/dsh/spaces/alice-2']);
      // Verify NO Bob space or Bob mount leaks to Alice
      expect(aliceRoots?.some((r) => r.includes('bob'))).toBe(false);

      // Query Bob's siblings from Bob Space 1
      const bobRoots = resolveSiblingExtraReadableRoots({
        db,
        userId: BOB_ID,
        currentSpaceId: 'sp_bob_1',
        currentSpaceFolder: 'bob-1',
        isHost: false,
        dataRoot: DATA_ROOT,
      });

      expect(bobRoots).toBeDefined();
      expect(bobRoots).toEqual(['/home/dsh/spaces/bob-2']);
      // Verify NO Alice space leaks to Bob
      expect(bobRoots?.some((r) => r.includes('alice'))).toBe(false);
    });

    it('excludes archived and deleted spaces of the same user', () => {
      db.prepare('INSERT INTO spaces (id, user_id, name, folder, status) VALUES (?, ?, ?, ?, ?)').run(
        'sp_1', ALICE_ID, 'Active Main', 'main', 'active'
      );
      db.prepare('INSERT INTO spaces (id, user_id, name, folder, status) VALUES (?, ?, ?, ?, ?)').run(
        'sp_2', ALICE_ID, 'Active Sibling', 'sibling-active', 'active'
      );
      db.prepare('INSERT INTO spaces (id, user_id, name, folder, status) VALUES (?, ?, ?, ?, ?)').run(
        'sp_3', ALICE_ID, 'Archived Sibling', 'sibling-archived', 'archived'
      );
      db.prepare('INSERT INTO spaces (id, user_id, name, folder, status) VALUES (?, ?, ?, ?, ?)').run(
        'sp_4', ALICE_ID, 'Deleted Sibling', 'sibling-deleted', 'deleted'
      );

      const roots = resolveSiblingExtraReadableRoots({
        db,
        userId: ALICE_ID,
        currentSpaceId: 'sp_1',
        currentSpaceFolder: 'main',
        isHost: false,
        dataRoot: DATA_ROOT,
      });

      expect(roots).toBeDefined();
      expect(roots).toEqual(['/home/dsh/spaces/sibling-active']);
    });

    it('sanitizes and excludes path traversal and sensitive config directories', () => {
      db.prepare('INSERT INTO spaces (id, user_id, name, folder, status) VALUES (?, ?, ?, ?, ?)').run(
        'sp_1', ALICE_ID, 'Current', 'main', 'active'
      );
      db.prepare('INSERT INTO spaces (id, user_id, name, folder, status) VALUES (?, ?, ?, ?, ?)').run(
        'sp_good', ALICE_ID, 'Good Sibling', 'good-sibling', 'active'
      );
      db.prepare('INSERT INTO spaces (id, user_id, name, folder, status) VALUES (?, ?, ?, ?, ?)').run(
        'sp_traversal', ALICE_ID, 'Traversal', '../../etc', 'active'
      );
      db.prepare('INSERT INTO spaces (id, user_id, name, folder, status) VALUES (?, ?, ?, ?, ?)').run(
        'sp_dsh', ALICE_ID, 'Sensitive Dsh', '.dsh', 'active'
      );
      db.prepare('INSERT INTO spaces (id, user_id, name, folder, status) VALUES (?, ?, ?, ?, ?)').run(
        'sp_slash', ALICE_ID, 'Slash In Folder', 'sub/dir', 'active'
      );

      const roots = resolveSiblingExtraReadableRoots({
        db,
        userId: ALICE_ID,
        currentSpaceId: 'sp_1',
        currentSpaceFolder: 'main',
        isHost: false,
        dataRoot: DATA_ROOT,
      });

      expect(roots).toBeDefined();
      expect(roots).toEqual(['/home/dsh/spaces/good-sibling']);
    });
  });

  describe('3. Container vs Host path mapping', () => {
    it('correctly maps to container paths /home/dsh/spaces/<folder>', () => {
      db.prepare('INSERT INTO spaces (id, user_id, name, folder, status) VALUES (?, ?, ?, ?, ?)').run(
        'sp_1', ALICE_ID, 'Main', 'main', 'active'
      );
      db.prepare('INSERT INTO spaces (id, user_id, name, folder, status) VALUES (?, ?, ?, ?, ?)').run(
        'sp_2', ALICE_ID, 'Docs', 'docs', 'active'
      );

      const containerRoots = resolveSiblingExtraReadableRoots({
        db,
        userId: ALICE_ID,
        currentSpaceId: 'sp_1',
        currentSpaceFolder: 'main',
        isHost: false,
        dataRoot: DATA_ROOT,
      });

      expect(containerRoots).toEqual(['/home/dsh/spaces/docs']);
    });

    it('correctly maps to host paths <dataRoot>/host-runtimes/<username>/spaces/<folder>', () => {
      db.prepare('INSERT INTO spaces (id, user_id, name, folder, status) VALUES (?, ?, ?, ?, ?)').run(
        'sp_1', ALICE_ID, 'Main', 'main', 'active'
      );
      db.prepare('INSERT INTO spaces (id, user_id, name, folder, status) VALUES (?, ?, ?, ?, ?)').run(
        'sp_2', ALICE_ID, 'Docs', 'docs', 'active'
      );

      const hostRoots = resolveSiblingExtraReadableRoots({
        db,
        userId: ALICE_ID,
        currentSpaceId: 'sp_1',
        currentSpaceFolder: 'main',
        isHost: true,
        dataRoot: DATA_ROOT,
      });

      const expectedHostPath = resolve(DATA_ROOT, 'host-runtimes', 'alice', 'spaces', 'docs');
      expect(hostRoots).toEqual([expectedHostPath]);
    });

    it('keeps list stable, deduplicated, and bounded by maxRoots', () => {
      db.prepare('INSERT INTO spaces (id, user_id, name, folder, status) VALUES (?, ?, ?, ?, ?)').run(
        'sp_main', ALICE_ID, 'Main', 'main', 'active'
      );

      // Insert 25 sibling spaces
      for (let i = 0; i < 25; i++) {
        const num = String(i).padStart(2, '0');
        db.prepare('INSERT INTO spaces (id, user_id, name, folder, status) VALUES (?, ?, ?, ?, ?)').run(
          `sp_${num}`, ALICE_ID, `Space ${num}`, `space-${num}`, 'active'
        );
      }

      const boundedRoots = resolveSiblingExtraReadableRoots({
        db,
        userId: ALICE_ID,
        currentSpaceId: 'sp_main',
        currentSpaceFolder: 'main',
        isHost: false,
        dataRoot: DATA_ROOT,
      });

      expect(boundedRoots).toBeDefined();
      expect(boundedRoots?.length).toBe(MAX_SIBLING_EXTRA_READABLE_ROOTS); // 20
      // Check alphabetical ordering
      expect(boundedRoots?.[0]).toBe('/home/dsh/spaces/space-00');
      expect(boundedRoots?.[19]).toBe('/home/dsh/spaces/space-19');
    });
  });

  describe('4. Ordinary one-space unchanged', () => {
    it('returns undefined when user only has a single space', () => {
      db.prepare('INSERT INTO spaces (id, user_id, name, folder, status) VALUES (?, ?, ?, ?, ?)').run(
        'sp_only', ALICE_ID, 'Sole Space', 'only-space', 'active'
      );

      const roots = resolveSiblingExtraReadableRoots({
        db,
        userId: ALICE_ID,
        currentSpaceId: 'sp_only',
        currentSpaceFolder: 'only-space',
        isHost: false,
        dataRoot: DATA_ROOT,
      });

      // Crucial requirement: ordinary single space is undefined, keeping turn request clean
      expect(roots).toBeUndefined();
    });

    it('returns undefined when all other spaces are deleted or archived', () => {
      db.prepare('INSERT INTO spaces (id, user_id, name, folder, status) VALUES (?, ?, ?, ?, ?)').run(
        'sp_current', ALICE_ID, 'Current Space', 'current', 'active'
      );
      db.prepare('INSERT INTO spaces (id, user_id, name, folder, status) VALUES (?, ?, ?, ?, ?)').run(
        'sp_arch', ALICE_ID, 'Archived Space', 'archived', 'archived'
      );
      db.prepare('INSERT INTO spaces (id, user_id, name, folder, status) VALUES (?, ?, ?, ?, ?)').run(
        'sp_del', ALICE_ID, 'Deleted Space', 'deleted', 'deleted'
      );

      const roots = resolveSiblingExtraReadableRoots({
        db,
        userId: ALICE_ID,
        currentSpaceId: 'sp_current',
        currentSpaceFolder: 'current',
        isHost: false,
        dataRoot: DATA_ROOT,
      });

      expect(roots).toBeUndefined();
    });
  });

  describe('5. Control-Plane Dispatch (dockerTurnExecutor) integration', () => {
    let tempRepo: TempRepo;

    beforeEach(() => {
      tempRepo = createTempRepo('dsh-sibling-roots-integration');
    });

    afterEach(() => {
      tempRepo.cleanup();
    });

    it('supplies extraReadableRoots in RuntimeTurnRequest for sibling spaces and excludes other users', async () => {
      await resetDemo({ repoRoot: tempRepo.repoRoot });

      let capturedTurnRequest: RuntimeTurnRequest | undefined;

      const fakeAdapter = new FakeUnitRuntimeContainerAdapter();
      const origStart = fakeAdapter.startUserRuntime.bind(fakeAdapter);
      fakeAdapter.startUserRuntime = async (options) => {
        const handle = await origStart(options);
        const origSendTurn = handle.sendTurn.bind(handle);
        handle.sendTurn = async (req: RuntimeTurnRequest) => {
          capturedTurnRequest = req;
          return origSendTurn(req);
        };
        return handle;
      };

      const system = await launchDemoSystem({
        repoRoot: tempRepo.repoRoot,
        runtimeAdapter: fakeAdapter,
      });

      try {
        const storage = system.platformServer['storage'];
        const bobUser = await storage.users.findByUsername('bob');
        expect(bobUser).toBeDefined();
        const bobId = bobUser!.id;

        // Bob starts with 1 space in resetDemo (space-00000000000000000000000000000002).
        // Let's create a sibling space 'bob-sibling' for Bob.
        const bobSiblingId = `spc_${randomUUID().replace(/-/g, '')}`;
        await storage.forTenant(bobId).spaces.create({
          id: bobSiblingId,
          name: 'Bob Sibling Space',
          folder: 'bob-sibling',
          executionMode: 'container',
        });

        // Get Bob's primary space
        const bobMainSpace = system.database.prepare(
          'SELECT id, folder FROM spaces WHERE user_id = ? AND folder != ?'
        ).get(bobId, 'bob-sibling') as { id: string; folder: string };
        expect(bobMainSpace).toBeDefined();

        const gateway = system.platformServer['runtimeGateway'] as any;
        const executor = gateway['executor'];

        const executionRequest: DeliveryExecutionRequest = {
          userId: bobId,
          platformSpaceId: bobMainSpace.id,
          workspaceFolder: bobMainSpace.folder,
          dshSessionId: 'ses_bob_integration_0001',
          turnId: 'turn_bob_integration_0001',
          content: 'Hello sibling space test',
          profile: null,
          envelope: {
            id: 'env_bob_1',
            userId: bobId,
            sessionId: 'ses_bob_integration_0001',
            spaceId: bobMainSpace.id,
            content: 'Hello sibling space test',
            timestamp: new Date().toISOString(),
          },
        };

        const result = await executor.execute(executionRequest);
        expect(result).toBeDefined();
        expect(result.replyText).toBeDefined();

        // Check captured RuntimeTurnRequest
        expect(capturedTurnRequest).toBeDefined();
        expect(capturedTurnRequest?.extraReadableRoots).toBeDefined();
        expect(capturedTurnRequest?.extraReadableRoots).toEqual([
          '/home/dsh/spaces/bob-sibling',
        ]);
        // Alice's spaces must NOT be present
        expect(capturedTurnRequest?.extraReadableRoots?.some((r: string) => r.includes('alice'))).toBe(false);
      } finally {
        await system.close();
      }
    });

    it('ordinary one-space keeps extraReadableRoots undefined in RuntimeTurnRequest', async () => {
      await resetDemo({ repoRoot: tempRepo.repoRoot });

      let capturedTurnRequest: RuntimeTurnRequest | undefined;

      const fakeAdapter = new FakeUnitRuntimeContainerAdapter();
      const origStart = fakeAdapter.startUserRuntime.bind(fakeAdapter);
      fakeAdapter.startUserRuntime = async (options) => {
        const handle = await origStart(options);
        const origSendTurn = handle.sendTurn.bind(handle);
        handle.sendTurn = async (req: RuntimeTurnRequest) => {
          capturedTurnRequest = req;
          return origSendTurn(req);
        };
        return handle;
      };

      const system = await launchDemoSystem({
        repoRoot: tempRepo.repoRoot,
        runtimeAdapter: fakeAdapter,
      });

      try {
        const storage = system.platformServer['storage'];
        const bobUser = await storage.users.findByUsername('bob');
        expect(bobUser).toBeDefined();
        const bobId = bobUser!.id;

        // In resetDemo, Bob only has 1 space (no siblings created)
        const bobSpaces = system.database.prepare(
          'SELECT id, folder FROM spaces WHERE user_id = ?'
        ).all(bobId) as Array<{ id: string; folder: string }>;
        expect(bobSpaces.length).toBe(1);

        const bobMainSpace = bobSpaces[0];

        const gateway = system.platformServer['runtimeGateway'] as any;
        const executor = gateway['executor'];

        const executionRequest: DeliveryExecutionRequest = {
          userId: bobId,
          platformSpaceId: bobMainSpace.id,
          workspaceFolder: bobMainSpace.folder,
          dshSessionId: 'ses_single_space_0001',
          turnId: 'turn_single_space_0001',
          content: 'Hello single space test',
          profile: null,
          envelope: {
            id: 'env_bob_single',
            userId: bobId,
            sessionId: 'ses_single_space_0001',
            spaceId: bobMainSpace.id,
            content: 'Hello single space test',
            timestamp: new Date().toISOString(),
          },
        };

        const result = await executor.execute(executionRequest);
        expect(result).toBeDefined();

        // Check captured RuntimeTurnRequest: extraReadableRoots is undefined for ordinary single space!
        expect(capturedTurnRequest).toBeDefined();
        expect(capturedTurnRequest?.extraReadableRoots).toBeUndefined();
      } finally {
        await system.close();
      }
    });
  });
});
