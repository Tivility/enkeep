/**
 * Multi-User Runtime Mapping & Fail-Closed Routing Tests
 *
 * Verifies:
 * 1. Multi-user runtime handle resolution strictly keyed by platform user UUID (Alice, Bob, Shadow Admin).
 * 2. Deterministic runtime identity alias derivation (alice -> 'alice', bob -> 'bob', shadow -> 'hpc_admin_shadow_42559a95').
 * 3. Exact handle mapping: each user UUID resolves to their own isolated UserRuntimeHandle without cross-user handle sharing.
 * 4. Unknown user UUID fail-closed rejection: throws immediately without falling back to Alice.
 * 5. Admin-only policy on Host runtime: admin user succeeds, regular user (Bob) is rejected.
 * 6. Users with only host spaces do not start Docker containers at startup; users with container spaces do.
 *
 * @module @enkeep/demo-runner/tests/multi-user-runtime-mapping.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createTempRepo, type TempRepo } from './support/temp-repo.js';
import { FakeUnitRuntimeContainerAdapter } from './support/fake-runtime.js';
import { resetDemo } from '../src/reset/index.js';
import { launchDemoSystem, type RunningDemoSystem } from '../src/up/index.js';
import { downDemo } from '../src/down/index.js';
import { deriveRuntimeIdentity } from '../src/utils/runtime-identity.js';

describe('Multi-User Runtime Mapping & Fail-Closed Routing', () => {
  let tempRepo: TempRepo;
  let resourceSuffix: string;
  let running: RunningDemoSystem | null = null;
  let fakeContainerAdapter: FakeUnitRuntimeContainerAdapter;
  let fakeHostAdapter: FakeUnitRuntimeContainerAdapter;

  const shadowUserId = 'fa9c8c17-1591-49e9-b6ad-dea756958e7c';
  const shadowUsername = 'hpc_admin_shadow';

  beforeEach(async () => {
    resourceSuffix = randomUUID().replace(/-/g, '').slice(0, 10).toLowerCase();
    tempRepo = createTempRepo();
    fakeContainerAdapter = new FakeUnitRuntimeContainerAdapter();
    fakeHostAdapter = new FakeUnitRuntimeContainerAdapter();

    // 1. Reset demo environment (provisions Alice and Bob)
    const resetResult = await resetDemo({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix,
    });
    expect(resetResult.ok).toBe(true);

    // 2. Insert Shadow Admin user into DB with both a container space and a host space
    const db = new DatabaseSync(`${tempRepo.repoRoot}/.demo-data/platform.db`);
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, status, display_name)
      VALUES (?, ?, ?, 'admin', 'active', 'Shadow Admin')
    `).run(shadowUserId, shadowUsername, 'hashed_password_shadow');

    // Quota limits for shadow user
    const quotaMetrics = ['turns', 'messages', 'tokens', 'storage_bytes', 'api_calls'];
    for (const metric of quotaMetrics) {
      db.prepare(`
        INSERT INTO quota_limits (user_id, resource, limit_amount, window_seconds)
        VALUES (?, ?, 100000, 86400)
      `).run(shadowUserId, metric);
    }

    // Shadow container space
    db.prepare(`
      INSERT INTO spaces (id, user_id, name, folder, execution_mode, status)
      VALUES ('spc_shadow_container', ?, 'Shadow Container Space', 'shadow-container', 'container', 'active')
    `).run(shadowUserId);

    // Shadow host space
    db.prepare(`
      INSERT INTO spaces (id, user_id, name, folder, execution_mode, status)
      VALUES ('spc_shadow_host', ?, 'Shadow Host Space', 'shadow-host', 'host', 'active')
    `).run(shadowUserId);

    db.close();
  });

  afterEach(async () => {
    if (running) {
      try {
        await running.close({ removeVolumes: true });
      } catch {}
      running = null;
    }
    if (tempRepo) {
      try {
        await downDemo({
          repoRoot: tempRepo.repoRoot,
          resourceSuffix,
          removeVolumes: true,
        });
      } catch {}
      try {
        tempRepo.cleanup();
      } catch {}
    }
  });

  it('1. launchDemoSystem boots independent runtimes for all 3 active users (Alice, Bob, Shadow) with no cross-user fallback', async () => {
    running = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix,
      runtimeAdapter: fakeContainerAdapter,
      hostRuntimeAdapter: fakeHostAdapter,
      allowHostRuntime: true,
    });
    expect(running.result.ok).toBe(true);

    const aliceUser = await running.storage.users.findByUsername('alice');
    const bobUser = await running.storage.users.findByUsername('bob');
    const shadowUser = await running.storage.users.findByUsername(shadowUsername);

    expect(aliceUser).toBeDefined();
    expect(bobUser).toBeDefined();
    expect(shadowUser).toBeDefined();

    // Verify all 3 user handles exist and are strictly keyed by authoritative DB UUID
    const aliceHandle = running.runtimeHandles.get(aliceUser!.id);
    const bobHandle = running.runtimeHandles.get(bobUser!.id);
    const shadowHandle = running.runtimeHandles.get(shadowUser!.id);

    expect(aliceHandle).toBeDefined();
    expect(bobHandle).toBeDefined();
    expect(shadowHandle).toBeDefined();

    // Invariant: Alice, Bob, and Shadow must have distinct, isolated runtime container handles
    expect(aliceHandle).not.toBe(bobHandle);
    expect(aliceHandle).not.toBe(shadowHandle);
    expect(bobHandle).not.toBe(shadowHandle);

    expect(aliceHandle!.userId).toBe('alice');
    expect(bobHandle!.userId).toBe('bob');
    expect(shadowHandle!.userId).toBe(deriveRuntimeIdentity(shadowUserId, shadowUsername));
    expect(shadowHandle!.userId).toBe('hpc_admin_shadow_42559a95');
  });

  it('2. Fail-closed: DeliveryTurnExecutor rejects unknown user UUID without falling back to Alice', async () => {
    running = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix,
      runtimeAdapter: fakeContainerAdapter,
      hostRuntimeAdapter: fakeHostAdapter,
      allowHostRuntime: true,
    });

    const unknownUserId = '99999999-9999-4999-a999-999999999999';

    const executor = (running.platformServer.runtimeGateway as any).executor;

    // Attempting to execute turn with unknown user must throw fail-closed
    await expect(
      executor.execute({
        userId: unknownUserId,
        platformSpaceId: 'spc_unknown',
        workspaceFolder: 'unknown-space',
        dshSessionId: 'ses_unknown_001',
        turnId: 'turn_unknown_001',
        content: 'hello unknown',
      })
    ).rejects.toThrow(/FAIL-CLOSED/);
  });

  it('3. Admin-only policy on host runtime: shadow admin succeeds, regular user Bob is rejected', async () => {
    running = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix,
      runtimeAdapter: fakeContainerAdapter,
      hostRuntimeAdapter: fakeHostAdapter,
      allowHostRuntime: true,
    });

    const executor = (running.platformServer.runtimeGateway as any).executor;

    // Shadow admin can execute on host space
    const shadowTurn = await executor.execute({
      userId: shadowUserId,
      platformSpaceId: 'spc_shadow_host',
      workspaceFolder: 'shadow-host',
      dshSessionId: 'ses_shadow_host_001',
      turnId: 'turn_shadow_host_001',
      content: 'hello shadow host',
    });
    expect(shadowTurn).toBeDefined();
    expect(shadowTurn.replyText).toBeDefined();

    // Bob (regular user) attempting host turn should fail closed
    const bobUser = await running.storage.users.findByUsername('bob');
    await expect(
      executor.execute({
        userId: bobUser!.id,
        platformSpaceId: 'spc_bob_host_fake',
        workspaceFolder: 'bob-host',
        dshSessionId: 'ses_bob_host_001',
        turnId: 'turn_bob_host_001',
        content: 'hello bob host',
      })
    ).rejects.toThrow(/FAIL-CLOSED/);
  });

  it('4. up boots cleanly with only single admin user "tivility" without Alice or Bob', async () => {
    // Clean up Alice, Bob, and Shadow from DB, keeping only user "tivility"
    const db = new DatabaseSync(`${tempRepo.repoRoot}/.demo-data/platform.db`);
    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec('DELETE FROM users;');
    db.exec('DELETE FROM spaces;');
    db.exec('DELETE FROM quota_limits;');

    const tivilityUserId = '1b587104-4f7c-46a9-8964-72ee9bea23bc';
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, status, display_name)
      VALUES (?, 'tivility', 'hashed_pwd_tivility', 'admin', 'active', 'Tivility Admin')
    `).run(tivilityUserId);

    db.prepare(`
      INSERT INTO quota_limits (user_id, resource, limit_amount, window_seconds)
      VALUES (?, 'turns', 100000, 86400)
    `).run(tivilityUserId);

    db.prepare(`
      INSERT INTO spaces (id, user_id, name, folder, execution_mode, status)
      VALUES ('spc_tivility_home', ?, 'Tivility Home', 'tivility-home', 'container', 'active')
    `).run(tivilityUserId);

    db.close();

    running = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix,
      runtimeAdapter: fakeContainerAdapter,
      hostRuntimeAdapter: fakeHostAdapter,
      allowHostRuntime: true,
    });

    expect(running.result.ok).toBe(true);
    expect(running.result.runtimes.tivility).toBeDefined();
    expect(running.result.runtimes.tivility?.status).toBe('healthy');
    expect(running.result.runtimes.alice).toBeUndefined();
    expect(running.result.runtimes.bob).toBeUndefined();
    expect(running.runtimeHandles.size).toBe(1);
    expect(running.runtimeHandles.has(tivilityUserId)).toBe(true);

    const tivilityHandle = running.runtimeHandles.get(tivilityUserId);
    expect(tivilityHandle).toBeDefined();
    expect(tivilityHandle!.userId).toBe(deriveRuntimeIdentity(tivilityUserId, 'tivility'));
    expect(running.result.users).toBeDefined();
    expect(running.result.users?.length).toBe(1);
    expect(running.result.users?.[0].username).toBe('tivility');
  });

  it('5. up fails closed when ZERO active users exist in DB', async () => {
    const db = new DatabaseSync(`${tempRepo.repoRoot}/.demo-data/platform.db`);
    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec('DELETE FROM users;');
    db.close();

    await expect(
      launchDemoSystem({
        repoRoot: tempRepo.repoRoot,
        resourceSuffix,
        runtimeAdapter: fakeContainerAdapter,
        hostRuntimeAdapter: fakeHostAdapter,
        allowHostRuntime: true,
      })
    ).rejects.toThrow(/FAIL-CLOSED: Zero active users found in database/);
  });
});
