import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
} from '../src/storage/migrations.js';
import {
  SqlitePlatformStorage,
} from '@enkeep/platform-storage-sqlite';
import {
  ChannelManagementService,
  ChannelRoutes,
} from '../src/channels/channel-routes.js';
import type { User } from '@enkeep/platform-core';

function createMockReq(options: {
  method: string;
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
}): IncomingMessage {
  const req = new EventEmitter() as any;
  req.method = options.method;
  req.url = options.url;
  req.headers = {
    host: '127.0.0.1:3000',
    origin: 'http://127.0.0.1:3000',
    'x-enkeep-csrf': 'test-csrf-token-12345678901234567890',
    ...(options.headers || {}),
  };
  req.socket = {
    localAddress: '127.0.0.1',
    localPort: 3000,
  };

  process.nextTick(() => {
    if (options.body !== undefined) {
      req.emit('data', Buffer.from(typeof options.body === 'string' ? options.body : JSON.stringify(options.body)));
    }
    req.emit('end');
  });

  return req;
}

function createMockRes(): { res: ServerResponse; getResult: () => { statusCode: number; headers: Record<string, string>; body: any } } {
  let statusCode = 200;
  const headers: Record<string, string> = {};
  let bodyChunks: Buffer[] = [];

  const res = {
    setHeader(key: string, value: string) {
      headers[key.toLowerCase()] = value;
      return res;
    },
    writeHead(status: number, h?: Record<string, string>) {
      statusCode = status;
      if (h) {
        for (const [k, v] of Object.entries(h)) {
          headers[k.toLowerCase()] = v;
        }
      }
      return res;
    },
    end(data?: any) {
      if (data) {
        bodyChunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
      }
      return res;
    },
    write(data: any) {
      if (data) {
        bodyChunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
      }
      return true;
    },
  } as any;

  return {
    res,
    getResult() {
      const raw = Buffer.concat(bodyChunks).toString('utf-8');
      let body: any = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        // keep string
      }
      return { statusCode, headers, body };
    },
  };
}

describe('ChannelRoutes HTTP API', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let service: ChannelManagementService;
  let routes: ChannelRoutes;
  const csrfToken = 'test-csrf-token-12345678901234567890';
  const testUser: User = {
    id: 'usr_channel_test',
    username: 'alice',
    role: 'user',
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const spaceId = 'spc_channel_space';

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'alice', 'hash')`).run(testUser.id);
    db.prepare(`INSERT INTO spaces (id, user_id, name, folder) VALUES (?, ?, 'Alice Space', 'alice-space')`).run(spaceId, testUser.id);

    storage = new SqlitePlatformStorage({ database: db });
    service = new ChannelManagementService(storage);
    routes = new ChannelRoutes(service, csrfToken);
  });

  it('manages channel accounts lifecycle via API', async () => {
    // 1. List accounts (empty initially)
    const { res: r1, getResult: g1 } = createMockRes();
    const handled1 = await routes.handle(
      createMockReq({ method: 'GET', url: '/api/manage/channels/accounts' }),
      r1,
      '/api/manage/channels/accounts',
      testUser
    );
    expect(handled1).toBe(true);
    const res1 = g1();
    expect(res1.statusCode).toBe(200);
    expect(res1.body.data.accounts).toEqual([]);

    // 2. Reject plaintext secret fields
    const { res: rSecret, getResult: gSecret } = createMockRes();
    await expect(
      routes.handle(
        createMockReq({
          method: 'POST',
          url: '/api/manage/channels/accounts',
          body: { type: 'lark', appSecret: 'my-super-secret' },
        }),
        rSecret,
        '/api/manage/channels/accounts',
        testUser
      )
    ).rejects.toThrow(/Plaintext secret field/);

    // 3. Create account with credentialRef
    const { res: r2, getResult: g2 } = createMockRes();
    const handled2 = await routes.handle(
      createMockReq({
        method: 'POST',
        url: '/api/manage/channels/accounts',
        body: { type: 'lark', status: 'active', credentialRef: 'cred_lark_alice' },
      }),
      r2,
      '/api/manage/channels/accounts',
      testUser
    );
    expect(handled2).toBe(true);
    const res2 = g2();
    expect(res2.statusCode).toBe(201);
    const createdAccount = res2.body.data;
    expect(createdAccount.id).toBeDefined();
    expect(createdAccount.type).toBe('lark');
    expect(createdAccount.credentialRef).toBe('cred_lark_alice');

    // 4. Update account
    const { res: r3, getResult: g3 } = createMockRes();
    await routes.handle(
      createMockReq({
        method: 'PATCH',
        url: `/api/manage/channels/accounts/${createdAccount.id}`,
        body: { status: 'disabled' },
      }),
      r3,
      `/api/manage/channels/accounts/${createdAccount.id}`,
      testUser
    );
    expect(g3().statusCode).toBe(200);
    expect(g3().body.data.status).toBe('disabled');

    // 5. Delete account
    const { res: r4, getResult: g4 } = createMockRes();
    await routes.handle(
      createMockReq({
        method: 'DELETE',
        url: `/api/manage/channels/accounts/${createdAccount.id}`,
      }),
      r4,
      `/api/manage/channels/accounts/${createdAccount.id}`,
      testUser
    );
    expect(g4().statusCode).toBe(200);
    expect(g4().body.data.deleted).toBe(true);
  });

  it('manages channel bindings lifecycle via API', async () => {
    // Create an account first
    const account = await service.createAccount(testUser.id, { type: 'lark' });

    // 1. Create binding
    const { res: r1, getResult: g1 } = createMockRes();
    const handled1 = await routes.handle(
      createMockReq({
        method: 'POST',
        url: '/api/manage/channels/bindings',
        body: {
          accountId: account.id,
          spaceId,
          nativeContextId: 'oc_chat_999',
          activationMode: 'mention',
        },
      }),
      r1,
      '/api/manage/channels/bindings',
      testUser
    );
    expect(handled1).toBe(true);
    const res1 = g1();
    expect(res1.statusCode).toBe(201);
    const binding = res1.body.data;
    expect(binding.id).toBeDefined();
    expect(binding.nativeContextId).toBe('oc_chat_999');

    // 2. List bindings
    const { res: r2, getResult: g2 } = createMockRes();
    await routes.handle(
      createMockReq({ method: 'GET', url: `/api/manage/channels/bindings?accountId=${account.id}` }),
      r2,
      '/api/manage/channels/bindings',
      testUser
    );
    const res2 = g2();
    expect(res2.statusCode).toBe(200);
    expect(res2.body.data.bindings.length).toBe(1);

    // 3. Update binding activationMode
    const { res: r3, getResult: g3 } = createMockRes();
    await routes.handle(
      createMockReq({
        method: 'PATCH',
        url: `/api/manage/channels/bindings/${binding.id}`,
        body: { activationMode: 'always' },
      }),
      r3,
      `/api/manage/channels/bindings/${binding.id}`,
      testUser
    );
    expect(g3().statusCode).toBe(200);
    expect(g3().body.data.activationMode).toBe('always');

    // 4. Delete binding
    const { res: r4, getResult: g4 } = createMockRes();
    await routes.handle(
      createMockReq({
        method: 'DELETE',
        url: `/api/manage/channels/bindings/${binding.id}`,
      }),
      r4,
      `/api/manage/channels/bindings/${binding.id}`,
      testUser
    );
    expect(g4().statusCode).toBe(200);
    expect(g4().body.data.deleted).toBe(true);
  });

  it('updates groupActivationMode via PATCH, flips group bindings to always, leaves p2p unchanged, and rejects invalid value with 400', async () => {
    // Create account (default groupActivationMode is 'mention')
    const account = await storage.forTenant(testUser.id).channels.createAccount({
      type: 'lark',
      status: 'active',
      credentialRef: 'cred_lark_mode_test',
    });
    expect(account.groupActivationMode).toBe('mention');

    // Create a group binding (mention)
    const groupBinding = await storage.forTenant(testUser.id).channels.createBinding({
      accountId: account.id,
      spaceId,
      nativeContextId: 'oc_group_mode_1',
      activationMode: 'mention',
      chatType: 'group',
    });
    expect(groupBinding.activationMode).toBe('mention');

    // Create a p2p binding (always)
    const p2pBinding = await storage.forTenant(testUser.id).channels.createBinding({
      accountId: account.id,
      spaceId,
      nativeContextId: 'oc_p2p_mode_1',
      activationMode: 'always',
      chatType: 'p2p',
    });
    expect(p2pBinding.activationMode).toBe('always');

    // Reject invalid groupActivationMode with 400
    const { res: rInvalid } = createMockRes();
    await expect(
      routes.handle(
        createMockReq({
          method: 'PATCH',
          url: `/api/manage/channels/accounts/${account.id}`,
          body: { groupActivationMode: 'invalid_mode' },
        }),
        rInvalid,
        `/api/manage/channels/accounts/${account.id}`,
        testUser
      )
    ).rejects.toThrow(/Invalid groupActivationMode/);

    // PATCH with groupActivationMode: 'always' -> 200
    const { res: rPatch, getResult: gPatch } = createMockRes();
    const handledPatch = await routes.handle(
      createMockReq({
        method: 'PATCH',
        url: `/api/manage/channels/accounts/${account.id}`,
        body: { groupActivationMode: 'always' },
      }),
      rPatch,
      `/api/manage/channels/accounts/${account.id}`,
      testUser
    );
    expect(handledPatch).toBe(true);
    const resPatch = gPatch();
    expect(resPatch.statusCode).toBe(200);
    expect(resPatch.body.data.groupActivationMode).toBe('always');

    // Verify GET account also reflects groupActivationMode
    const { res: rGet, getResult: gGet } = createMockRes();
    await routes.handle(
      createMockReq({
        method: 'GET',
        url: `/api/manage/channels/accounts/${account.id}`,
      }),
      rGet,
      `/api/manage/channels/accounts/${account.id}`,
      testUser
    );
    expect(gGet().statusCode).toBe(200);
    expect(gGet().body.data.groupActivationMode).toBe('always');

    // Verify existing group binding flipped to 'always'
    const updatedGroupBinding = await storage.forTenant(testUser.id).channels.findBindingById(groupBinding.id);
    expect(updatedGroupBinding?.activationMode).toBe('always');

    // Verify p2p binding is unchanged (remains 'always')
    const updatedP2PBinding = await storage.forTenant(testUser.id).channels.findBindingById(p2pBinding.id);
    expect(updatedP2PBinding?.activationMode).toBe('always');
  });
});
