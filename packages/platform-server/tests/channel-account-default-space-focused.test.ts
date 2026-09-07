import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
} from '../src/storage/migrations.js';
import {
  SqlitePlatformStorage,
  SqliteTenantScopedChannelRepository,
} from '@enkeep/platform-storage-sqlite';
import {
  ChannelManagementService,
  ChannelRoutes,
} from '../src/channels/channel-routes.js';
import { LarkChannelGateway, FakeLarkTransport } from '@enkeep/channel-lark';
import type { User, ChannelAccount } from '@enkeep/platform-core';

const FIXTURE_CSRF_TOKEN = 'csrf_token_0123456789abcdef0123456789abcdef';

function createMockReq(options: {
  method: string;
  url: string;
  body?: unknown;
}): IncomingMessage {
  const req = new EventEmitter() as any;
  req.method = options.method;
  req.url = options.url;
  req.headers = {
    host: '127.0.0.1:3000',
    origin: 'http://127.0.0.1:3000',
    'x-enkeep-csrf': FIXTURE_CSRF_TOKEN,
  };
  req.socket = { localAddress: '127.0.0.1', localPort: 3000 };

  process.nextTick(() => {
    if (options.body !== undefined) {
      req.emit('data', Buffer.from(typeof options.body === 'string' ? options.body : JSON.stringify(options.body)));
    }
    req.emit('end');
  });

  return req;
}

function createMockRes(): { res: ServerResponse; getResult: () => { statusCode: number; body: any } } {
  let statusCode = 200;
  const headers: Record<string, string> = {};
  const bodyChunks: Buffer[] = [];

  const res = {
    setHeader(key: string, value: string) {
      headers[key.toLowerCase()] = value;
      return res;
    },
    writeHead(status: number) {
      statusCode = status;
      return res;
    },
    write(data: any) {
      if (data) {
        bodyChunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
      }
      return true;
    },
    end(data?: any) {
      if (data) {
        bodyChunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
      }
      return res;
    },
  } as any;

  return {
    res,
    getResult() {
      const raw = Buffer.concat(bodyChunks).toString('utf-8');
      let body: any = raw;
      try {
        body = JSON.parse(raw);
      } catch {}
      return { statusCode, body };
    },
  };
}

describe('M33 Channel Account Default Workspace Focused Test', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let service: ChannelManagementService;
  let routes: ChannelRoutes;
  const activeGateways: LarkChannelGateway[] = [];

  const aliceUser: User = {
    id: 'usr_alice',
    username: 'alice',
    role: 'user',
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const bobUser: User = {
    id: 'usr_bob',
    username: 'bob',
    role: 'user',
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const spaceAId = 'spc_alice_a';
  const spaceBId = 'spc_alice_b';
  const spaceBobId = 'spc_bob_c';

  beforeEach(async () => {
    activeGateways.length = 0;
    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    const applied = await runner.migrate(ALL_PLATFORM_MIGRATIONS);
    expect(applied.some((m) => m.version === 33)).toBe(true);
    expect(applied.some((m) => m.version === 34)).toBe(true);

    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'alice', 'hash')`).run(aliceUser.id);
    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'bob', 'hash')`).run(bobUser.id);

    db.prepare(`INSERT INTO spaces (id, user_id, name, folder, status) VALUES (?, ?, 'Space A', 'space-a', 'active')`).run(spaceAId, aliceUser.id);
    db.prepare(`INSERT INTO spaces (id, user_id, name, folder, status) VALUES (?, ?, 'Space B', 'space-b', 'active')`).run(spaceBId, aliceUser.id);
    db.prepare(`INSERT INTO spaces (id, user_id, name, folder, status) VALUES (?, ?, 'Space Bob', 'space-bob', 'active')`).run(spaceBobId, bobUser.id);

    storage = new SqlitePlatformStorage({ database: db });
    service = new ChannelManagementService(storage);
    routes = new ChannelRoutes(service, FIXTURE_CSRF_TOKEN);
  });

  afterEach(async () => {
    for (const gw of activeGateways) {
      try {
        await gw.dispose();
      } catch {}
    }
    activeGateways.length = 0;
    if (db) {
      try {
        db.close();
      } catch {}
    }
  });

  it('verifies: oldchatA -> defaultB -> newchatB/oldchatA, tenant validation, null clear, and restart persistence', async () => {
    const aliceTenant = storage.forTenant(aliceUser.id);

    // 1. Create channel account for Alice with initial default Space A
    const account = await service.createAccount(aliceUser.id, {
      type: 'lark',
      status: 'active',
      credentialRef: 'cred_lark_alice',
      defaultSpaceId: spaceAId,
    });
    expect(account.defaultSpaceId).toBe(spaceAId);

    const transport = new FakeLarkTransport();
    await transport.start();
    const mockRuntimeGateway: any = {
      dispatchInbound: async (env: any) => ({
        accepted: true,
        turnId: env.id,
        message: { id: 'msg_1', role: 'user', content: env.content, status: 'pending', createdAt: new Date().toISOString() },
      }),
      getCurrentTurnStatus: async () => ({ status: 'completed' }),
      cancelCurrentTurn: async () => true,
    };

    // Instantiate gateway using initial account
    const gateway = new LarkChannelGateway({
      account,
      transport: transport as any,
      channelRepo: aliceTenant.channels,
      sessionRouteRepo: aliceTenant.sessionRoutes,
      spaceRepo: aliceTenant.spaces,
      runtimeGateway: mockRuntimeGateway,
      defaultSpaceId: account.defaultSpaceId ?? undefined,
    });
    activeGateways.push(gateway);

    // 2. Chat A arrives -> Auto-binds to Space A
    const eventA1: any = {
      header: { event_id: 'evt_chat_a_1' },
      event: {
        sender: { sender_id: { open_id: 'ou_user_1' } },
        message: {
          message_id: 'om_msg_a_1',
          chat_id: 'oc_chat_A',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: 'Hello in chat A' }),
        },
      },
    };
    const resA1 = await gateway.handleInboundEvent(eventA1);
    expect(resA1.handled).toBe(true);

    const bindingA = await aliceTenant.channels.findBindingByContext(account.id, 'oc_chat_A');
    expect(bindingA).toBeDefined();
    expect(bindingA!.spaceId).toBe(spaceAId);

    // 3. User updates default workspace to Space B without reconnecting bot
    const updatedAccount = await service.updateAccount(aliceUser.id, account.id, {
      defaultSpaceId: spaceBId,
    });
    expect(updatedAccount.defaultSpaceId).toBe(spaceBId);

    // Verify DB persistence of defaultSpaceId
    const dbAccount = await aliceTenant.channels.findAccountById(account.id);
    expect(dbAccount?.defaultSpaceId).toBe(spaceBId);

    // 4. New chat B arrives on the SAME live gateway -> Auto-binds to new default Space B
    const eventB1: any = {
      header: { event_id: 'evt_chat_b_1' },
      event: {
        sender: { sender_id: { open_id: 'ou_user_2' } },
        message: {
          message_id: 'om_msg_b_1',
          chat_id: 'oc_chat_B',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: 'Hello in chat B' }),
        },
      },
    };
    const resB1 = await gateway.handleInboundEvent(eventB1);
    expect(resB1.handled).toBe(true);

    const bindingB = await aliceTenant.channels.findBindingByContext(account.id, 'oc_chat_B');
    expect(bindingB).toBeDefined();
    expect(bindingB!.spaceId).toBe(spaceBId);

    // Old chat A sends another message -> Must NOT move, retains binding to Space A
    const eventA2: any = {
      header: { event_id: 'evt_chat_a_2' },
      event: {
        sender: { sender_id: { open_id: 'ou_user_1' } },
        message: {
          message_id: 'om_msg_a_2',
          chat_id: 'oc_chat_A',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: 'Second message in chat A' }),
        },
      },
    };
    const resA2 = await gateway.handleInboundEvent(eventA2);
    expect(resA2.handled).toBe(true);

    const bindingAAfter = await aliceTenant.channels.findBindingByContext(account.id, 'oc_chat_A');
    expect(bindingAAfter!.spaceId).toBe(spaceAId); // Still Space A!

    // 5. Cross-tenant rejection test:
    // Bob attempts to create or update account with Alice's Space A -> rejected by service/routes
    await expect(
      service.createAccount(bobUser.id, {
        type: 'lark',
        status: 'active',
        defaultSpaceId: spaceAId, // Belongs to Alice!
      })
    ).rejects.toThrow(/not found or is not active/i);

    const bobAccount = await service.createAccount(bobUser.id, {
      type: 'lark',
      status: 'active',
      defaultSpaceId: spaceBobId,
    });
    expect(bobAccount.defaultSpaceId).toBe(spaceBobId);

    // Bob tries to update to Alice's Space B -> rejected
    await expect(
      service.updateAccount(bobUser.id, bobAccount.id, {
        defaultSpaceId: spaceBId,
      })
    ).rejects.toThrow(/not found or is not active/i);

    // Also via HTTP route for Bob: routes.handle throws ValidationError for invalid/cross-tenant space
    const { res: rBob } = createMockRes();
    await expect(
      routes.handle(
        createMockReq({
          method: 'PATCH',
          url: `/api/manage/channels/accounts/${bobAccount.id}`,
          body: { defaultSpaceId: spaceAId },
        }),
        rBob,
        `/api/manage/channels/accounts/${bobAccount.id}`,
        bobUser
      )
    ).rejects.toThrow(/not found or is not active/i);

    // 6. Explicit null clear:
    // Clear Alice's default space with null
    const clearedAccount = await service.updateAccount(aliceUser.id, account.id, {
      defaultSpaceId: null,
    });
    expect(clearedAccount.defaultSpaceId).toBeNull();

    // New chat C arrives -> Must NOT fallback to Space A or Space B, returns no_binding
    const eventC1: any = {
      header: { event_id: 'evt_chat_c_1' },
      event: {
        sender: { sender_id: { open_id: 'ou_user_3' } },
        message: {
          message_id: 'om_msg_c_1',
          chat_id: 'oc_chat_C',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: 'Hello in chat C' }),
        },
      },
    };
    const resC1 = await gateway.handleInboundEvent(eventC1);
    expect(resC1.handled).toBe(false);
    expect(resC1.ignoredReason).toBe('no_binding');

    // 7. Restart simulation: Reconstruct repo and gateway, restore default to Space B
    await service.updateAccount(aliceUser.id, account.id, {
      defaultSpaceId: spaceBId,
    });

    const newChannelRepo = new SqliteTenantScopedChannelRepository(db, aliceUser.id);
    const reloadedAccount = await newChannelRepo.findAccountById(account.id);
    expect(reloadedAccount?.defaultSpaceId).toBe(spaceBId);

    const restartedTransport = new FakeLarkTransport();
    await restartedTransport.start();

    const restartedGateway = new LarkChannelGateway({
      account: reloadedAccount!,
      transport: restartedTransport,
      channelRepo: newChannelRepo,
      sessionRouteRepo: aliceTenant.sessionRoutes,
      spaceRepo: aliceTenant.spaces,
      runtimeGateway: mockRuntimeGateway,
      // Pass undefined for defaultSpaceId to prove it queries channelRepo dynamically
      defaultSpaceId: undefined,
    });
    activeGateways.push(restartedGateway);

    const eventD1: any = {
      header: { event_id: 'evt_chat_d_1' },
      event: {
        sender: { sender_id: { open_id: 'ou_user_4' } },
        message: {
          message_id: 'om_msg_d_1',
          chat_id: 'oc_chat_D',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: 'Hello in chat D' }),
        },
      },
    };
    const resD1 = await restartedGateway.handleInboundEvent(eventD1);
    expect(resD1.handled).toBe(true);

    const bindingD = await newChannelRepo.findBindingByContext(account.id, 'oc_chat_D');
    expect(bindingD).toBeDefined();
    expect(bindingD!.spaceId).toBe(spaceBId);
  });
});
