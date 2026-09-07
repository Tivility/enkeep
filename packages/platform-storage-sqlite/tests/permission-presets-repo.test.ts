import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  MIGRATION_001_SQL,
  MIGRATION_022_PERMISSION_PRESETS_SQL,
  SqlitePlatformStorage,
  PermissionPresetRepo,
} from '../src/index.js';
import { PermissionPresetRevisionMismatchError } from '@enkeep/platform-core';

describe('PermissionPresetRepo & Migration 22 SQLite Persistence', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(MIGRATION_001_SQL);

    // Create user alice and bob
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, status)
      VALUES ('usr_alice', 'alice', 'hash', 'user', 'active'),
             ('usr_bob', 'bob', 'hash', 'user', 'active')
    `).run();

    // Create a space for alice
    db.prepare(`
      INSERT INTO spaces (id, user_id, name, folder, execution_mode)
      VALUES ('spc_alice_dev', 'usr_alice', 'Alice Dev', 'alice-dev', 'container')
    `).run();

    // Create agent profile table & a profile for alice
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_profiles (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        active_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      );
    `);
    db.prepare(`
      INSERT INTO agent_profiles (id, user_id, name, status, active_version)
      VALUES ('prof_alice_coding', 'usr_alice', 'Coding Profile', 'active', 1)
    `).run();

    // Apply migration 22
    db.exec(MIGRATION_022_PERMISSION_PRESETS_SQL);

    storage = new SqlitePlatformStorage(db);
  });

  afterEach(() => {
    db.close();
  });

  it('sets and retrieves default user permission preset with initial revision 1', async () => {
    const repo = storage.forTenant('usr_alice').permissionPresets;

    const preset = await repo.setPreset({
      userId: 'usr_alice',
      preset: 'workspace-write',
    });

    expect(preset).toBeDefined();
    expect(preset.userId).toBe('usr_alice');
    expect(preset.preset).toBe('workspace-write');
    expect(preset.sandboxMode).toBe('workspace-write');
    expect(preset.approvalPolicy).toBe('ask');
    expect(preset.revision).toBe(1);
    expect(preset.spaceId).toBeNull();
    expect(preset.profileId).toBeNull();

    const effective = await repo.getEffectivePreset({ userId: 'usr_alice' });
    expect(effective).toEqual(preset);
  });

  it('updates preset with optimistic concurrency control incrementing revision', async () => {
    const repo = storage.forTenant('usr_alice').permissionPresets;

    const initial = await repo.setPreset({
      userId: 'usr_alice',
      preset: 'workspace-write',
    });
    expect(initial.revision).toBe(1);

    // Valid update with current revision
    const updated = await repo.setPreset({
      userId: 'usr_alice',
      preset: 'danger-full-access',
      revision: 1,
    });
    expect(updated.revision).toBe(2);
    expect(updated.preset).toBe('danger-full-access');
    expect(updated.sandboxMode).toBe('danger-full-access');
    expect(updated.approvalPolicy).toBe('never');

    // Stale update with old revision throws PermissionPresetRevisionMismatchError
    await expect(
      repo.setPreset({
        userId: 'usr_alice',
        preset: 'read-only',
        revision: 1, // Stale! Current is 2
      })
    ).rejects.toThrow(PermissionPresetRevisionMismatchError);
  });

  it('resolves hierarchical preset specificity: (space + profile) > space > profile > user default', async () => {
    const repo = storage.forTenant('usr_alice').permissionPresets;

    // 1. User default: read-only
    await repo.setPreset({
      userId: 'usr_alice',
      preset: 'read-only',
    });

    // Effective for generic request is read-only
    let eff = await repo.getEffectivePreset({ userId: 'usr_alice' });
    expect(eff?.preset).toBe('read-only');

    // Effective for space without specific preset is user default
    eff = await repo.getEffectivePreset({ userId: 'usr_alice', spaceId: 'spc_alice_dev' });
    expect(eff?.preset).toBe('read-only');

    // 2. Set profile-specific preset: custom
    await repo.setPreset({
      userId: 'usr_alice',
      profileId: 'prof_alice_coding',
      preset: 'custom',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
    });

    eff = await repo.getEffectivePreset({ userId: 'usr_alice', profileId: 'prof_alice_coding' });
    expect(eff?.preset).toBe('custom');
    expect(eff?.sandboxMode).toBe('workspace-write');

    // 3. Set space-specific preset: workspace-write
    await repo.setPreset({
      userId: 'usr_alice',
      spaceId: 'spc_alice_dev',
      preset: 'workspace-write',
    });

    eff = await repo.getEffectivePreset({ userId: 'usr_alice', spaceId: 'spc_alice_dev' });
    expect(eff?.preset).toBe('workspace-write');

    // 4. Set space + profile combined preset: danger-full-access
    await repo.setPreset({
      userId: 'usr_alice',
      spaceId: 'spc_alice_dev',
      profileId: 'prof_alice_coding',
      preset: 'danger-full-access',
    });

    eff = await repo.getEffectivePreset({
      userId: 'usr_alice',
      spaceId: 'spc_alice_dev',
      profileId: 'prof_alice_coding',
    });
    expect(eff?.preset).toBe('danger-full-access');
    expect(eff?.approvalPolicy).toBe('never');
  });

  it('enforces tenant isolation: user Bob cannot read or mutate user Alice presets', async () => {
    const aliceRepo = storage.forTenant('usr_alice').permissionPresets;
    const bobRepo = storage.forTenant('usr_bob').permissionPresets;

    const alicePreset = await aliceRepo.setPreset({
      userId: 'usr_alice',
      preset: 'danger-full-access',
    });

    const bobEffective = await bobRepo.getEffectivePreset({ userId: 'usr_bob' });
    expect(bobEffective).toBeNull();

    const bobList = await bobRepo.listPresets();
    expect(bobList.length).toBe(0);

    const bobGet = await bobRepo.getPresetById(alicePreset.id);
    expect(bobGet).toBeNull();

    const bobDelete = await bobRepo.deletePreset(alicePreset.id);
    expect(bobDelete).toBe(false);

    // Alice preset remains intact
    const aliceCheck = await aliceRepo.getPresetById(alicePreset.id);
    expect(aliceCheck).toBeDefined();
    expect(aliceCheck?.preset).toBe('danger-full-access');
  });
});
