import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { DefaultAuthService } from '@enkeep/platform-auth';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  SqliteWebMessageStore,
} from '../src/index.js';
import { SqlitePlatformWebApiAdapter } from '../src/storage/sqlite-platform-api.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('Session Channel Public API Contract & UI Badge Reader Tests', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let messageStore: SqliteWebMessageStore;
  let authService: DefaultAuthService;
  let adapter: SqlitePlatformWebApiAdapter;

  const tenantAlice = 'usr_alice_channel_test';
  const tenantBob = 'usr_bob_channel_test';

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

    // Seed test user
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
      VALUES (?, 'alice', 'hash_alice', 'user', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(tenantAlice);

    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
      VALUES (?, 'bob', 'hash_bob', 'user', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(tenantBob);
  });

  it('serializes channel: route.channel on list and detail while concealing sensitive credentials and native context', async () => {
    // 1. Create a shared space
    const space = await adapter.createSpace(tenantAlice, {
      name: 'Operations Workspace',
    });

    // 2. Create synthetic same-space Web and Lark session routes directly in storage
    const aliceStorage = storage.forTenant(tenantAlice);

    const webRoute = await aliceStorage.sessionRoutes.create({
      spaceId: space.id,
      channel: 'web',
      accountId: 'account-web-public-001',
      nativeContextId: 'ctx_web_tab_secret_001',
      peerId: 'peer_web_001',
      dshSessionId: 'dsh_session_uuid_web_001',
      title: 'Customer Onboarding',
    });

    const larkRoute = await aliceStorage.sessionRoutes.create({
      spaceId: space.id,
      channel: 'lark',
      accountId: 'account-lark-credential-ref-secret-002',
      nativeContextId: 'oc_chat_secret_group_token_002',
      peerId: 'ou_user_secret_openid_002',
      dshSessionId: 'dsh_session_uuid_lark_002',
      title: 'Customer Onboarding',
    });

    // 3. Test listSessions (session listing)
    const listResult = await adapter.listSessions(tenantAlice, { spaceId: space.id });
    expect(listResult).toHaveLength(2);

    const publicWeb = listResult.find((s) => s.id === webRoute.id);
    const publicLark = listResult.find((s) => s.id === larkRoute.id);

    expect(publicWeb).toBeDefined();
    expect(publicLark).toBeDefined();

    // Verify channel serialization
    expect(publicWeb?.channel).toBe('web');
    expect(publicLark?.channel).toBe('lark');

    // Strict security check: NO credential refs, private native context, or dshSessionId exposed
    const FORBIDDEN_KEYS = [
      'accountId',
      'account_id',
      'credentialRef',
      'credential_ref',
      'nativeContextId',
      'native_context_id',
      'peerId',
      'peer_id',
      'dshSessionId',
      'dsh_session_id',
      'password',
      'secret',
      'token',
    ];

    for (const session of [publicWeb!, publicLark!]) {
      for (const forbiddenKey of FORBIDDEN_KEYS) {
        expect(session).not.toHaveProperty(forbiddenKey);
      }
      // Verify only known public fields exist
      const keys = Object.keys(session).sort();
      expect(keys).toEqual([
        'channel',
        'createdAt',
        'currentGeneration',
        'id',
        'spaceId',
        'status',
        'title',
        'updatedAt',
      ].sort());
    }

    // 4. Test getSession (session detail)
    const detailWeb = await adapter.getSession(tenantAlice, webRoute.id);
    const detailLark = await adapter.getSession(tenantAlice, larkRoute.id);

    expect(detailWeb).not.toBeNull();
    expect(detailLark).not.toBeNull();

    expect(detailWeb?.id).toBe(webRoute.id);
    expect(detailWeb?.channel).toBe('web');
    expect(detailWeb?.title).toBe('Customer Onboarding');

    expect(detailLark?.id).toBe(larkRoute.id);
    expect(detailLark?.channel).toBe('lark');
    expect(detailLark?.title).toBe('Customer Onboarding');

    for (const session of [detailWeb!, detailLark!]) {
      for (const forbiddenKey of FORBIDDEN_KEYS) {
        expect(session).not.toHaveProperty(forbiddenKey);
      }
    }

    // 5. Test UI badge reader contract with public session objects
    // Load app.js to extract getSessionSourceBadgeInfo
    const appJsPath = join(__dirname, '../../web-ui/src/static/app.js');
    const appJsCode = readFileSync(appJsPath, 'utf-8');

    const fnSourceMatch = appJsCode.match(/function getSessionSourceBadgeInfo\([\s\S]*?\n\}/);
    expect(fnSourceMatch).not.toBeNull();

    // Mock tr for zh-CN
    const trZh = (key: string, _params: any, fallback: string) => {
      const zhDict: Record<string, string> = {
        'chat.channelWeb': 'Web',
        'chat.channelWebAria': '来源：Web',
        'chat.channelLark': '飞书',
        'chat.channelLarkAria': '来源：飞书',
        'chat.channelSession': '会话',
        'chat.channelSessionAria': '来源：会话',
      };
      return zhDict[key] || fallback;
    };

    // Mock tr for en
    const trEn = (key: string, _params: any, fallback: string) => {
      const enDict: Record<string, string> = {
        'chat.channelWeb': 'Web',
        'chat.channelWebAria': 'Source: Web',
        'chat.channelLark': 'Lark',
        'chat.channelLarkAria': 'Source: Lark',
        'chat.channelSession': 'Session',
        'chat.channelSessionAria': 'Source: Session',
      };
      return enDict[key] || fallback;
    };

    const getBadgeInfoZh = new Function('session', 'tr', `
      ${fnSourceMatch![0]}
      return getSessionSourceBadgeInfo(session);
    `);

    const getBadgeInfoEn = new Function('session', 'tr', `
      ${fnSourceMatch![0]}
      return getSessionSourceBadgeInfo(session);
    `);

    // Under zh-CN, publicWeb displays "Web" and publicLark displays "飞书" (NOT neutral "会话")
    const badgeWebZh = getBadgeInfoZh(publicWeb, trZh);
    expect(badgeWebZh).toEqual({
      type: 'web',
      label: 'Web',
      ariaLabel: '来源：Web',
    });

    const badgeLarkZh = getBadgeInfoZh(publicLark, trZh);
    expect(badgeLarkZh).toEqual({
      type: 'lark',
      label: '飞书',
      ariaLabel: '来源：飞书',
    });

    // Under en, publicWeb displays "Web" and publicLark displays "Lark"
    const badgeWebEn = getBadgeInfoEn(publicWeb, trEn);
    expect(badgeWebEn).toEqual({
      type: 'web',
      label: 'Web',
      ariaLabel: 'Source: Web',
    });

    const badgeLarkEn = getBadgeInfoEn(publicLark, trEn);
    expect(badgeLarkEn).toEqual({
      type: 'lark',
      label: 'Lark',
      ariaLabel: 'Source: Lark',
    });

    // Verify detail session objects also resolve to the exact same badges
    expect(getBadgeInfoZh(detailWeb, trZh)).toEqual(badgeWebZh);
    expect(getBadgeInfoZh(detailLark, trZh)).toEqual(badgeLarkZh);
  });

  it('preserves channel on createSession, updateSession, and archiveSession operations', async () => {
    const space = await adapter.createSpace(tenantAlice, {
      name: 'Secondary Workspace',
    });

    // createSession (defaults to web channel)
    const createdSession = await adapter.createSession(tenantAlice, {
      spaceId: space.id,
      title: 'Initial Web Chat',
    });
    expect(createdSession.channel).toBe('web');
    expect(createdSession).not.toHaveProperty('accountId');
    expect(createdSession).not.toHaveProperty('dshSessionId');

    // updateSession
    const updatedSession = await adapter.updateSession(tenantAlice, createdSession.id, {
      title: 'Renamed Web Chat',
    });
    expect(updatedSession.channel).toBe('web');
    expect(updatedSession.title).toBe('Renamed Web Chat');
    expect(updatedSession).not.toHaveProperty('accountId');

    // archiveSession
    const archivedSession = await adapter.archiveSession(tenantAlice, createdSession.id);
    expect(archivedSession.channel).toBe('web');
    expect(archivedSession.status).toBe('archived');
    expect(archivedSession).not.toHaveProperty('accountId');
  });
});
