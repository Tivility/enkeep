import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  MIGRATION_001_SQL,
  MIGRATION_021_SKILL_PACKAGES_AND_BINDINGS_SQL,
  MIGRATION_030_EXTENSIONS_CATALOG_AND_BINDINGS_SQL,
  SqlitePlatformStorage,
  SqliteMigrationRunner,
} from '../src/index.js';

describe('Sqlite Extension Repository & Migration 30 Storage Tests', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(MIGRATION_001_SQL);

    // Seed users
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, status)
      VALUES ('usr_alice', 'alice', 'hash', 'user', 'active'),
             ('usr_bob', 'bob', 'hash', 'user', 'active')
    `).run();

    // Seed spaces
    db.prepare(`
      INSERT INTO spaces (id, user_id, name, folder, execution_mode)
      VALUES ('spc_alice_1', 'usr_alice', 'Space A', 'space-a', 'container'),
             ('spc_alice_2', 'usr_alice', 'Space B', 'space-b', 'container'),
             ('spc_bob_1', 'usr_bob', 'Bob Space', 'bob-space', 'container')
    `).run();

    // Apply M21 and M30
    db.exec(MIGRATION_021_SKILL_PACKAGES_AND_BINDINGS_SQL);
    db.exec(MIGRATION_030_EXTENSIONS_CATALOG_AND_BINDINGS_SQL);

    storage = new SqlitePlatformStorage(db);
  });

  afterEach(() => {
    db.close();
  });

  it('performs CRUD on extension packages, versions, and contributions', async () => {
    const aliceExt = storage.forTenant('usr_alice').extensionPackages;

    // 1. Create extension package
    const pkg = await aliceExt.create({
      slug: 'code-review-pro',
      name: 'Code Review Pro',
      description: 'Automated code review expert',
      sourceKind: 'git',
      sourceRef: 'main',
      installedVersion: 1,
      activeVersion: 1,
      status: 'active',
      integritySha256: 'hash_v1_12345',
      provenanceJson: JSON.stringify({ repositoryUrl: 'https://github.com/test/repo.git' }),
    });

    expect(pkg.id).toBeDefined();
    expect(pkg.slug).toBe('code-review-pro');
    expect(pkg.sourceKind).toBe('git');
    expect(pkg.status).toBe('active');

    // 2. Find by ID and find by slug
    const foundById = await aliceExt.findById(pkg.id);
    expect(foundById?.slug).toBe('code-review-pro');

    const foundBySlug = await aliceExt.findBySlug('code-review-pro');
    expect(foundBySlug?.id).toBe(pkg.id);

    // 3. Create version history
    const v1 = await aliceExt.createVersion({
      packageId: pkg.id,
      version: 1,
      sourceKind: 'git',
      sourceRef: 'main',
      commitSha: 'commit_sha_1111',
      integritySha256: 'hash_v1_12345',
      manifestJson: JSON.stringify({ name: 'code-review-pro', version: 1 }),
      changeSummary: 'Initial release',
    });
    expect(v1.version).toBe(1);

    const v2 = await aliceExt.createVersion({
      packageId: pkg.id,
      version: 2,
      sourceKind: 'git',
      sourceRef: 'main',
      commitSha: 'commit_sha_2222',
      integritySha256: 'hash_v2_67890',
      manifestJson: JSON.stringify({ name: 'code-review-pro', version: 2 }),
      changeSummary: 'Updated review heuristics',
    });
    expect(v2.version).toBe(2);

    const versions = await aliceExt.listVersions(pkg.id);
    expect(versions.length).toBe(2);
    expect(versions[0].version).toBe(2); // DESC order

    // 4. Create contribution (skill kind)
    const contrib = await aliceExt.createContribution({
      packageId: pkg.id,
      kind: 'skill',
      contributionKey: 'code-review-pro',
      manifestJson: JSON.stringify({
        name: 'code-review-pro',
        description: 'Automated code review expert',
        modelInvocable: true,
        userInvocable: true,
      }),
      status: 'active',
    });
    expect(contrib.id).toBeDefined();
    expect(contrib.kind).toBe('skill');
    expect(contrib.contributionKey).toBe('code-review-pro');

    const contribs = await aliceExt.listContributions(pkg.id);
    expect(contribs.length).toBe(1);

    const foundContrib = await aliceExt.findContributionByKey(pkg.id, 'skill', 'code-review-pro');
    expect(foundContrib?.id).toBe(contrib.id);

    const foundContribById = await aliceExt.findContributionById(contrib.id);
    expect(foundContribById?.id).toBe(contrib.id);
    expect(foundContribById?.packageId).toBe(pkg.id);
    expect(foundContribById?.contributionKey).toBe('code-review-pro');

    // Bob cannot access Alice's contribution by ID (tenant isolation)
    const bobExt = storage.forTenant('usr_bob').extensionPackages;
    const bobFoundContrib = await bobExt.findContributionById(contrib.id);
    expect(bobFoundContrib).toBeNull();

    // 5. Update package
    const updated = await aliceExt.update(pkg.id, {
      activeVersion: 2,
      installedVersion: 2,
      integritySha256: 'hash_v2_67890',
    });
    expect(updated.activeVersion).toBe(2);
    expect(updated.integritySha256).toBe('hash_v2_67890');

    // 6. List with filtering
    const listAll = await aliceExt.list();
    expect(listAll.length).toBe(1);

    const listGit = await aliceExt.list({ sourceKind: 'git' });
    expect(listGit.length).toBe(1);

    const listBuiltin = await aliceExt.list({ sourceKind: 'builtin' });
    expect(listBuiltin.length).toBe(0);

    const listSkill = await aliceExt.list({ kind: 'skill' });
    expect(listSkill.length).toBe(1);

    const listMcp = await aliceExt.list({ kind: 'mcp' });
    expect(listMcp.length).toBe(0);
  });

  it('manages space bindings and enforces tenant isolation', async () => {
    const aliceExt = storage.forTenant('usr_alice').extensionPackages;
    const aliceBind = storage.forTenant('usr_alice').extensionBindings;
    const bobBind = storage.forTenant('usr_bob').extensionBindings;

    const pkg = await aliceExt.create({
      slug: 'sec-audit',
      name: 'Security Audit',
      sourceKind: 'archive',
      installedVersion: 1,
      activeVersion: 1,
      status: 'active',
      integritySha256: 'sha_sec_1',
    });

    const contrib = await aliceExt.createContribution({
      packageId: pkg.id,
      kind: 'skill',
      contributionKey: 'sec-audit',
      manifestJson: '{}',
      status: 'active',
    });

    // 1. Set binding in Space 1 (enabled = true)
    const b1 = await aliceBind.setBinding('spc_alice_1', contrib.id, true);
    expect(b1.enabled).toBe(true);
    expect(b1.spaceId).toBe('spc_alice_1');
    expect(b1.contributionId).toBe(contrib.id);

    // 2. Set binding in Space 2 (enabled = false)
    const b2 = await aliceBind.setBinding('spc_alice_2', contrib.id, false);
    expect(b2.enabled).toBe(false);

    // 3. Find bindings
    const foundB1 = await aliceBind.findBySpaceAndContribution('spc_alice_1', contrib.id);
    expect(foundB1?.enabled).toBe(true);

    const foundByKey = await aliceBind.findBySpaceAndContributionKey('spc_alice_1', 'skill', 'sec-audit');
    expect(foundByKey?.id).toBe(b1.id);

    // 4. Update binding
    const b1Disabled = await aliceBind.setBinding('spc_alice_1', contrib.id, false);
    expect(b1Disabled.enabled).toBe(false);

    // 5. Tenant isolation: Bob cannot see or mutate Alice bindings
    const bobList = await bobBind.listBySpace('spc_alice_1');
    expect(bobList.length).toBe(0);

    const bobFind = await bobBind.findBySpaceAndContribution('spc_alice_1', contrib.id);
    expect(bobFind).toBeNull();
  });

  it('migrates legacy M21 skill data accurately and idempotently in Migration 30', async () => {
    const freshDb = new DatabaseSync(':memory:');
    freshDb.exec('PRAGMA foreign_keys = ON;');
    freshDb.exec(MIGRATION_001_SQL);

    // Create user and space
    freshDb.prepare(`
      INSERT INTO users (id, username, password_hash, role, status)
      VALUES ('usr_alice', 'alice', 'hash', 'user', 'active')
    `).run();

    freshDb.prepare(`
      INSERT INTO spaces (id, user_id, name, folder, execution_mode)
      VALUES ('spc_1', 'usr_alice', 'Space 1', 'spc-1', 'container')
    `).run();

    // Create M21 tables and seed legacy skill data
    freshDb.exec(MIGRATION_021_SKILL_PACKAGES_AND_BINDINGS_SQL);

    freshDb.prepare(`
      INSERT INTO skill_packages (
        id, user_id, name, scope, space_id, version, source_type, source_url,
        source_ref, commit_sha, subdirectory, content_hash, manifest_json, status
      ) VALUES (
        'spkg_legacy_1', 'usr_alice', 'legacy-skill', 'space', 'spc_1', 2, 'git',
        'https://github.com/example/legacy-skill.git', 'main', 'c0ffee1234',
        'subdir', 'sha256_content_hash', '{"description":"A legacy skill"}', 'active'
      )
    `).run();

    freshDb.prepare(`
      INSERT INTO skill_package_versions (
        id, package_id, version, commit_sha, content_hash, manifest_json, change_summary
      ) VALUES
        ('spver_1', 'spkg_legacy_1', 1, 'c0ffee0001', 'sha256_hash_v1', '{"description":"v1"}', 'Initial'),
        ('spver_2', 'spkg_legacy_1', 2, 'c0ffee1234', 'sha256_content_hash', '{"description":"v2"}', 'Update')
    `).run();

    freshDb.prepare(`
      INSERT INTO skill_bindings (
        id, user_id, space_id, skill_name, enabled, package_id
      ) VALUES (
        'sbind_1', 'usr_alice', 'spc_1', 'legacy-skill', 1, 'spkg_legacy_1'
      )
    `).run();

    // Also insert an unlinked binding without package_id (should not create fake builtin package)
    freshDb.prepare(`
      INSERT INTO skill_bindings (
        id, user_id, space_id, skill_name, enabled, package_id
      ) VALUES (
        'sbind_bundled_1', 'usr_alice', 'spc_1', 'bundled-system-skill', 0, NULL
      )
    `).run();

    // Now execute Migration 30
    freshDb.exec(MIGRATION_030_EXTENSIONS_CATALOG_AND_BINDINGS_SQL);

    const freshStorage = new SqlitePlatformStorage(freshDb);
    const aliceExt = freshStorage.forTenant('usr_alice').extensionPackages;
    const aliceBind = freshStorage.forTenant('usr_alice').extensionBindings;

    // Verify extension package was migrated
    const migratedPkg = await aliceExt.findBySlug('legacy-skill');
    expect(migratedPkg).not.toBeNull();
    expect(migratedPkg?.id).toBe('spkg_legacy_1');
    expect(migratedPkg?.sourceKind).toBe('git');
    expect(migratedPkg?.installedVersion).toBe(2);
    expect(migratedPkg?.activeVersion).toBe(2);
    expect(migratedPkg?.integritySha256).toBe('sha256_content_hash');

    // Verify contribution was migrated
    const contribs = await aliceExt.listContributions('spkg_legacy_1');
    expect(contribs.length).toBe(1);
    expect(contribs[0].kind).toBe('skill');
    expect(contribs[0].contributionKey).toBe('legacy-skill');

    // Verify versions were migrated
    const versions = await aliceExt.listVersions('spkg_legacy_1');
    expect(versions.length).toBe(2);

    // Verify package-linked binding was migrated
    const binding = await aliceBind.findBySpaceAndContribution('spc_1', 'contrib_spkg_legacy_1');
    expect(binding).not.toBeNull();
    expect(binding?.enabled).toBe(true);

    // Verify orphaned bundled binding does not create fake builtin package
    const bundledPkg = await aliceExt.findBySlug('bundled-system-skill');
    expect(bundledPkg).toBeNull();

    // Verify legacy tables are still present and readable
    const legacyCount = freshDb.prepare('SELECT count(*) as count FROM skill_packages').get() as { count: number };
    expect(legacyCount.count).toBe(1);

    // Verify idempotent re-run of M30 SQL does not duplicate or throw
    expect(() => {
      freshDb.exec(MIGRATION_030_EXTENSIONS_CATALOG_AND_BINDINGS_SQL);
    }).not.toThrow();

    const pkgCount = freshDb.prepare('SELECT count(*) as count FROM extension_packages WHERE user_id = ?').get('usr_alice') as { count: number };
    expect(pkgCount.count).toBe(1); // only legacy-skill

    freshDb.close();
  });
});
