/**
 * TenantProvisioningService Unit & Transactional Invariant Tests
 *
 * Validates:
 * 1. Atomicity: User + 5 Quota Limits + Default Active Space created in a single SQLite transaction.
 * 2. Complete rollback on conflict, error, or validation failure (no partial rows in DB).
 * 3. Default quota limits come from validated deployment configuration (never scattered constants).
 * 4. Password safety: Temporary password generated once, never stored in plaintext, never leaked in audit logs.
 * 5. Space directory naming and canonical folder.
 *
 * @module @enkeep/platform-server/tests/tenant-provisioning-service.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
} from '../src/storage/migrations.js';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import {
  TenantProvisioningService,
  validateTenantQuotaDefaults,
  type TenantQuotaDefaultsConfig,
} from '../src/management/tenant-provisioning-service.js';
import { PlatformError, ValidationError } from '@enkeep/platform-core';

describe('TenantProvisioningService (Transactional Onboarding Saga)', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let service: TenantProvisioningService;

  const testDeploymentQuotaDefaults: TenantQuotaDefaultsConfig = {
    turns: 100,
    messages: 100,
    tokens: 65536,
    storage_bytes: 10485760,
    api_calls: 500,
    resetInterval: 'none',
  };

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);
    storage = new SqlitePlatformStorage(db);
    service = new TenantProvisioningService({
      database: db,
      quotaDefaults: testDeploymentQuotaDefaults,
    });
  });

  afterEach(async () => {
    if (storage) {
      await storage.close();
    } else if (db) {
      db.close();
    }
  });

  describe('1. Validated Deployment Quota Defaults', () => {
    it('validates explicit quota configuration', () => {
      const valid = validateTenantQuotaDefaults(testDeploymentQuotaDefaults);
      expect(valid.turns).toBe(100);
      expect(valid.messages).toBe(100);
      expect(valid.tokens).toBe(65536);
      expect(valid.storage_bytes).toBe(10485760);
      expect(valid.api_calls).toBe(500);
      expect(valid.resetInterval).toBe('none');
    });

    it('rejects missing or invalid quotaDefaults in constructor without implicit fallback', () => {
      expect(() => new TenantProvisioningService({ database: db } as any)).toThrow(ValidationError);
      expect(() => new TenantProvisioningService({ database: db, quotaDefaults: null as any })).toThrow(ValidationError);
    });

    it('rejects invalid or missing quota metrics in deployment config', () => {
      expect(() => validateTenantQuotaDefaults(null)).toThrow(ValidationError);
      expect(() => validateTenantQuotaDefaults({ turns: -2, messages: 100, tokens: 100, storage_bytes: 100, api_calls: 100 })).toThrow(ValidationError);
      expect(() => validateTenantQuotaDefaults({ turns: 100, messages: '100', tokens: 100, storage_bytes: 100, api_calls: 100 })).toThrow(ValidationError);
      expect(() => validateTenantQuotaDefaults({ turns: 100, messages: 100, tokens: 100, storage_bytes: 100, api_calls: 100, resetInterval: 'invalid' })).toThrow(ValidationError);
      // Validates that -1 (unlimited) is accepted
      const unlimited = validateTenantQuotaDefaults({ turns: -1, messages: -1, tokens: -1, storage_bytes: -1, api_calls: -1 });
      expect(unlimited.turns).toBe(-1);
    });

    it('allows custom deployment quota defaults', async () => {
      const customConfig: TenantQuotaDefaultsConfig = {
        turns: 500,
        messages: 1000,
        tokens: 1000000,
        storage_bytes: 104857600,
        api_calls: 5000,
        resetInterval: 'daily',
      };
      const customService = new TenantProvisioningService({
        database: db,
        quotaDefaults: customConfig,
        defaultSpaceName: 'Workspace Primary',
      });

      const res = await customService.provisionTenant({
        username: 'custom_quota_user',
        displayName: 'Custom User',
      });

      expect(res.user.username).toBe('custom_quota_user');
      expect(res.defaultSpace?.name).toBe('Workspace Primary');

      const quotaRows = db.prepare('SELECT resource, limit_amount, reset_interval FROM quota_limits WHERE user_id = ?').all(res.user.id) as Array<{ resource: string; limit_amount: number; reset_interval: string }>;
      expect(quotaRows.length).toBe(5);
      const rowMap = new Map(quotaRows.map((r) => [r.resource, r]));

      expect(rowMap.get('turns')?.limit_amount).toBe(500);
      expect(rowMap.get('messages')?.limit_amount).toBe(1000);
      expect(rowMap.get('tokens')?.limit_amount).toBe(1000000);
      expect(rowMap.get('storage_bytes')?.limit_amount).toBe(104857600);
      expect(rowMap.get('api_calls')?.limit_amount).toBe(5000);
      expect(rowMap.get('turns')?.reset_interval).toBe('daily');
    });
  });

  describe('2. Atomic Transaction Execution & Rollback Invariants', () => {
    it('atomically creates User + 5 quota_limits + 1 default active space + audit log', async () => {
      const res = await service.provisionTenant(
        {
          username: 'charlie_test',
          displayName: 'Charlie Test',
          role: 'user',
          locale: 'zh-CN',
        },
        'admin_alice_id'
      );

      expect(res.user.username).toBe('charlie_test');
      expect(res.user.displayName).toBe('Charlie Test');
      expect(res.user.role).toBe('user');
      expect(res.user.status).toBe('active');
      expect(res.user.locale).toBe('zh-CN');
      expect(res.user.spaceCount).toBe(1);
      expect(typeof res.tempPassword).toBe('string');
      expect(res.tempPassword.length).toBeGreaterThanOrEqual(16);

      // Verify User in SQLite
      const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(res.user.id) as any;
      expect(userRow).toBeDefined();
      expect(userRow.username).toBe('charlie_test');
      expect(userRow.password_hash).toBeDefined();
      expect(userRow.password_hash).not.toBe(res.tempPassword); // Hashed

      // Verify exactly 5 Quota Limits in SQLite
      const quotaRows = db.prepare('SELECT resource, limit_amount FROM quota_limits WHERE user_id = ?').all(res.user.id) as any[];
      expect(quotaRows.length).toBe(5);
      const metrics = quotaRows.map((r) => r.resource).sort();
      expect(metrics).toEqual(['api_calls', 'messages', 'storage_bytes', 'tokens', 'turns'].sort());

      // Verify default active Space in SQLite
      const spaceRows = db.prepare('SELECT * FROM spaces WHERE user_id = ?').all(res.user.id) as any[];
      expect(spaceRows.length).toBe(1);
      expect(spaceRows[0].status).toBe('active');
      expect(spaceRows[0].folder).toMatch(/^space-[0-9a-f]{32}$/);
      expect(spaceRows[0].name).toBe('Default Space');

      // Verify Audit Log in SQLite
      const auditRows = db.prepare("SELECT * FROM auth_audit_log WHERE user_id = ? AND action = 'user_created'").all(res.user.id) as any[];
      expect(auditRows.length).toBe(1);
      const auditDetails = JSON.parse(auditRows[0].details);
      expect(auditDetails.role).toBe('user');
      expect(auditDetails.locale).toBe('zh-CN');
      expect(auditDetails.actorUserId).toBe('admin_alice_id');
      expect(auditDetails.defaultSpaceId).toBe(spaceRows[0].id);
      expect(auditRows[0].details).not.toContain(res.tempPassword); // Never leaks password
      expect(auditRows[0].details).not.toContain(userRow.password_hash); // Never leaks hash
    });

    it('fails closed and completely rolls back all mutations on username conflict (409)', async () => {
      await service.provisionTenant({ username: 'duplicate_user' });

      const countBeforeUsers = (db.prepare('SELECT COUNT(*) as c FROM users').get() as any).c;
      const countBeforeQuotas = (db.prepare('SELECT COUNT(*) as c FROM quota_limits').get() as any).c;
      const countBeforeSpaces = (db.prepare('SELECT COUNT(*) as c FROM spaces').get() as any).c;
      const countBeforeAudit = (db.prepare('SELECT COUNT(*) as c FROM auth_audit_log').get() as any).c;

      await expect(service.provisionTenant({ username: 'duplicate_user' })).rejects.toThrow(PlatformError);

      const countAfterUsers = (db.prepare('SELECT COUNT(*) as c FROM users').get() as any).c;
      const countAfterQuotas = (db.prepare('SELECT COUNT(*) as c FROM quota_limits').get() as any).c;
      const countAfterSpaces = (db.prepare('SELECT COUNT(*) as c FROM spaces').get() as any).c;
      const countAfterAudit = (db.prepare('SELECT COUNT(*) as c FROM auth_audit_log').get() as any).c;

      expect(countAfterUsers).toBe(countBeforeUsers);
      expect(countAfterQuotas).toBe(countBeforeQuotas);
      expect(countAfterSpaces).toBe(countBeforeSpaces);
      expect(countAfterAudit).toBe(countBeforeAudit);
    });

    it('rejects invalid username formats with ValidationError before transaction', async () => {
      await expect(service.provisionTenant({ username: '' })).rejects.toThrow(ValidationError);
      await expect(service.provisionTenant({ username: 'a'.repeat(65) })).rejects.toThrow(ValidationError);
      await expect(service.provisionTenant({ username: 'bad\x00user' })).rejects.toThrow(ValidationError);
      await expect(service.provisionTenant({ username: '  padded_user  ' })).rejects.toThrow(ValidationError);
      await expect(service.provisionTenant({ username: 'valid_user', displayName: '  padded_display  ' })).rejects.toThrow(ValidationError);
    });

    it('preserves exact custom temporary password without trimming or mutating', async () => {
      const customPwd = '  Exact Password With Spaces 123!  ';
      const res = await service.provisionTenant({
        username: 'exact_pwd_user',
        tempPassword: customPwd,
      });
      expect(res.tempPassword).toBe(customPwd);
    });
  });
});
