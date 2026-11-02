import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
} from '../src/storage/migrations.js';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { ValidationError } from '@enkeep/platform-core';
import {
  ChannelManagementService,
  type ChannelAccountLifecycle,
} from '../src/channels/channel-routes.js';

/**
 * Channel management dispatches account lifecycle calls by channel type:
 * lark -> Lark manager, wechat -> WeChat manager, registered types -> their manager,
 * unknown types are rejected and never handed to another channel's runtime.
 */
describe('ChannelManagementService dispatch by channel type', () => {
  const userId = 'user-alice';
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let lark: { onAccountUpdated: any; onAccountDeleted: any; syncAccount: any };
  let wechat: { syncAccount: any };
  let jarvis: ChannelAccountLifecycle & { onAccountCreated: any };
  let service: ChannelManagementService;

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    await new PlatformServerMigrationRunner(db).migrate(ALL_PLATFORM_MIGRATIONS);
    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'alice', 'hash')`).run(userId);
    storage = new SqlitePlatformStorage({ database: db });

    lark = {
      onAccountUpdated: vi.fn().mockResolvedValue(undefined),
      onAccountDeleted: vi.fn().mockResolvedValue(undefined),
      syncAccount: vi.fn().mockResolvedValue(null),
    };
    wechat = { syncAccount: vi.fn().mockResolvedValue(null) };
    jarvis = {
      onAccountCreated: vi.fn().mockResolvedValue(undefined),
      onAccountUpdated: vi.fn().mockResolvedValue(undefined),
      onAccountDeleted: vi.fn().mockResolvedValue(undefined),
      syncAccount: vi.fn().mockResolvedValue(undefined),
    };
    service = new ChannelManagementService(storage, lark as any, wechat as any);
  });

  it('keeps Lark and WeChat lifecycle behavior', async () => {
    const larkAccount = await service.createAccount(userId, { type: 'lark', status: 'active' });
    expect(lark.onAccountUpdated).toHaveBeenCalledWith(userId, larkAccount.id);
    expect(wechat.syncAccount).not.toHaveBeenCalled();

    const wechatAccount = await service.createAccount(userId, { type: 'wechat', status: 'active' });
    expect(wechat.syncAccount).toHaveBeenCalledWith(userId, wechatAccount.id);
    expect(lark.onAccountUpdated).toHaveBeenCalledTimes(1);

    await service.updateAccount(userId, larkAccount.id, { status: 'disabled' });
    expect(lark.onAccountUpdated).toHaveBeenCalledTimes(2);
    await service.syncAccount(userId, larkAccount.id);
    expect(lark.syncAccount).toHaveBeenCalledWith(userId, larkAccount.id);
    await service.deleteAccount(userId, larkAccount.id);
    expect(lark.onAccountDeleted).toHaveBeenCalledWith(userId, larkAccount.id);

    await service.deleteAccount(userId, wechatAccount.id);
    expect(wechat.syncAccount).toHaveBeenCalledTimes(2);
  });

  it('rejects unknown channel types instead of building a Lark transport for them', async () => {
    await expect(service.createAccount(userId, { type: 'jarvis', status: 'active' })).rejects.toBeInstanceOf(ValidationError);
    await expect(service.createAccount(userId, { type: 'carrier-pigeon' })).rejects.toBeInstanceOf(ValidationError);
    expect(lark.onAccountUpdated).not.toHaveBeenCalled();
    expect(await service.listAccounts(userId)).toHaveLength(0);
  });

  it('routes a registered jarvis type only to the jarvis manager', async () => {
    service.registerManager('jarvis', jarvis);
    expect(service.getSupportedTypes()).toEqual(['lark', 'wechat', 'jarvis']);

    const account = await service.createAccount(userId, { type: 'jarvis', status: 'active' });
    expect(jarvis.onAccountCreated).toHaveBeenCalledWith(userId, account.id);

    await service.updateAccount(userId, account.id, { status: 'disabled' });
    expect(jarvis.onAccountUpdated).toHaveBeenCalledWith(userId, account.id);

    await service.syncAccount(userId, account.id);
    expect(jarvis.syncAccount).toHaveBeenCalledWith(userId, account.id);

    await service.deleteAccount(userId, account.id);
    expect(jarvis.onAccountDeleted).toHaveBeenCalledWith(userId, account.id);

    expect(lark.onAccountUpdated).not.toHaveBeenCalled();
    expect(lark.onAccountDeleted).not.toHaveBeenCalled();
    expect(lark.syncAccount).not.toHaveBeenCalled();
    expect(wechat.syncAccount).not.toHaveBeenCalled();
  });

  it('accepts managers through the constructor map and refuses to override builtin types', () => {
    const svc = new ChannelManagementService(storage, undefined, undefined, { jarvis });
    expect(svc.isSupportedType('jarvis')).toBe(true);
    expect(() => svc.registerManager('lark', jarvis)).toThrow(ValidationError);
    expect(() => svc.registerManager('Not A Type', jarvis)).toThrow(ValidationError);
  });

  it('leaves legacy accounts of unknown types editable without dispatching them to Lark', async () => {
    const legacy = await storage.forTenant(userId).channels.createAccount({ type: 'legacy-im', status: 'active' });
    await service.updateAccount(userId, legacy.id, { status: 'disabled' });
    await expect(service.syncAccount(userId, legacy.id)).rejects.toBeInstanceOf(ValidationError);
    expect(await service.deleteAccount(userId, legacy.id)).toBe(true);
    expect(lark.onAccountUpdated).not.toHaveBeenCalled();
    expect(lark.onAccountDeleted).not.toHaveBeenCalled();
    expect(lark.syncAccount).not.toHaveBeenCalled();
  });

  it('keeps late binding of the Lark manager through the runtimeManager property', async () => {
    const svc = new ChannelManagementService(storage);
    (svc as any).runtimeManager = lark;
    const account = await svc.createAccount(userId, { type: 'lark', status: 'active' });
    expect(lark.onAccountUpdated).toHaveBeenCalledWith(userId, account.id);
  });
});
