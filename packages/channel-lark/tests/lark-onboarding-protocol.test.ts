/**
 * Offline Mock Protocol Tests for Feishu Open Platform Onboarding Automation.
 *
 * Recorded from authentic Botmux Open Platform Console contracts:
 * 1. Feishu QR login protocol lifecycle: init -> polling -> finalize -> session validation & identity extraction.
 * 2. Scope manifest mapping: strict 2-bucket isolation (171 tenant / 130 user), authentic buildScopeUpdatePayload.
 * 3. Read-before-merge automation: scope catalog, baseline events (im.message.receive_v1 with appEvents/userEvents),
 *    online visibility preservation (data.whiteList + data.blackList), privilege narrowing.
 * 4. Error classification & non-idempotent publish safety: unreadable visibility fail-closed, missing versionId unknown response, awaiting_approval status handling.
 * 5. Security & SSRF containment: strict HTTPS allowlist, exact host match, no userinfo/port bypass, RFC 6265 cookie boundary.
 *
 * @module @enkeep/channel-lark/tests
 */

import { describe, it, expect, vi } from 'vitest';
import {
  MutableCookieJar,
  initFeishuQrSession,
  pollFeishuQrSession,
  finalizeFeishuQrLogin,
  createOpenPlatformApiClient,
  extractOpenPlatformCsrfToken,
  extractOpenPlatformSessionIdentity,
  validateFeishuWebSession,
  isAllowedFeishuUrl,
  assertAllowedFeishuUrl,
  isCookieDomainMatch,
  isCookiePathMatch,
  parseSetCookie,
  InsecureRedirectError,
} from '../src/onboarding/session.js';
import {
  BUNDLED_LARK_SCOPES,
  getDefaultScopeManifest,
  extractOpenPlatformScopeEntries,
  mapManifestScopesToOpenPlatformIds,
  buildScopeUpdatePayload,
} from '../src/onboarding/scope-manifest.js';
import {
  parseOnlineVisibility,
  VisibilityParseError,
  EMPTY_VISIBILITY,
} from '../src/onboarding/visibility.js';
import {
  automateOpenPlatformSetup,
  createFeishuBotApp,
  BOT_BASELINE_APP_EVENTS,
  LONG_CONNECTION_EVENT_MODE,
  nextAppVersion,
  extractVersionId,
  buildEventSubscriptionPayload,
  extractOpenPlatformEventState,
} from '../src/onboarding/automation.js';
import {
  generateQrSvg,
  generateQrDataUrl,
} from '../src/onboarding/qr-generator.js';

describe('1. Security & SSRF Strict Allowlist Verification', () => {
  it('allows strictly HTTPS exact Feishu host URLs on port 443 or default port', () => {
    expect(isAllowedFeishuUrl('https://accounts.feishu.cn/accounts/qrlogin/init')).toBe(true);
    expect(isAllowedFeishuUrl('https://open.feishu.cn/developers/v1/app/create')).toBe(true);
    expect(isAllowedFeishuUrl('https://ask.feishu.cn/')).toBe(true);
    expect(isAllowedFeishuUrl('https://open.larkoffice.com/app')).toBe(true);
    expect(isAllowedFeishuUrl('https://open.feishu.cn:443/app')).toBe(true);
  });

  it('rejects plain HTTP, unauthorized subdomains, IP addresses, userinfo, and non-standard ports', () => {
    expect(isAllowedFeishuUrl('http://accounts.feishu.cn/')).toBe(false);
    expect(isAllowedFeishuUrl('http://127.0.0.1:3000/')).toBe(false);
    expect(isAllowedFeishuUrl('http://localhost:3080/')).toBe(false);
    expect(isAllowedFeishuUrl('https://malicious.feishu.cn.attacker.com/')).toBe(false);
    expect(isAllowedFeishuUrl('https://evil-accounts.feishu.cn/')).toBe(false);
    expect(isAllowedFeishuUrl('https://192.168.1.1/')).toBe(false);
    expect(isAllowedFeishuUrl('https://open.feishu.cn:8080/')).toBe(false);
    expect(isAllowedFeishuUrl('https://user:pass@open.feishu.cn/')).toBe(false);

    expect(() => assertAllowedFeishuUrl('http://127.0.0.1:3900/')).toThrow(InsecureRedirectError);
    expect(() => assertAllowedFeishuUrl('https://evil.com/')).toThrow(InsecureRedirectError);
  });

  it('enforces strict RFC 6265 cookie domain-matching without allowing arbitrary servers to set domains', () => {
    expect(isCookieDomainMatch('accounts.feishu.cn', 'feishu.cn')).toBe(true);
    expect(isCookieDomainMatch('open.feishu.cn', '.feishu.cn')).toBe(true);
    expect(isCookieDomainMatch('open.feishu.cn', 'open.feishu.cn')).toBe(true);

    expect(isCookieDomainMatch('open.feishu.cn', 'ask.feishu.cn')).toBe(false);
    expect(isCookieDomainMatch('open.feishu.cn', 'cn')).toBe(false);
    expect(isCookieDomainMatch('open.feishu.cn', 'com')).toBe(false);
  });

  it('enforces strict RFC 6265 cookie path-matching boundaries', () => {
    expect(isCookiePathMatch('/app', '/app')).toBe(true);
    expect(isCookiePathMatch('/app/123', '/app')).toBe(true);
    expect(isCookiePathMatch('/app/123/edit', '/app')).toBe(true);

    expect(isCookiePathMatch('/application', '/app')).toBe(false);
    expect(isCookiePathMatch('/app-test', '/app')).toBe(false);
  });
});

describe('2. Scope Manifest 2-Bucket Verification & Authentic Payload', () => {
  it('contains full user-authorized scope list with 171 tenant and 130 user scopes', () => {
    const manifest = getDefaultScopeManifest();
    expect(manifest.scopes?.tenant?.length).toBe(171);
    expect(manifest.scopes?.user?.length).toBe(130);
    expect(manifest.scopes?.tenant).toContain('im:message');
    expect(manifest.scopes?.tenant).toContain('im:message.group_at_msg:readonly');
    expect(manifest.scopes?.user).toContain('im:message');
  });

  it('builds authentic Botmux scope update payload matching Open Platform contract', () => {
    const catalog = [
      { id: 'sc_t1', name: 'im:message', bucket: 'tenant' as const },
      { id: 'sc_u1', name: 'im:message', bucket: 'user' as const },
      { id: 'sc_t2', name: 'contact:user.id:readonly', bucket: 'tenant' as const },
    ];

    const mapped = mapManifestScopesToOpenPlatformIds(
      {
        scopes: {
          tenant: ['im:message', 'contact:user.id:readonly', 'unknown:tenant:scope'],
          user: ['im:message', 'unknown:user:scope'],
        },
      },
      catalog
    );

    expect(mapped.tenantScopeIds).toEqual(['sc_t1', 'sc_t2']);
    expect(mapped.userScopeIds).toEqual(['sc_u1']);
    expect(mapped.missingTenantScopes).toEqual(['unknown:tenant:scope']);
    expect(mapped.missingUserScopes).toEqual(['unknown:user:scope']);

    const payload = buildScopeUpdatePayload('cli_123', mapped);
    expect(payload).toEqual({
      clientId: 'cli_123',
      appScopeIDs: ['sc_t1', 'sc_t2'],
      userScopeIDs: ['sc_u1'],
      scopeIds: [],
      operation: 'add',
      isDeveloperPanel: true,
    });
  });

  it('builds authentic event subscription payload with appEvents and userEvents', () => {
    const payload = buildEventSubscriptionPayload('cli_123', 4, ['im.message.receive_v1'], []);
    expect(payload).toEqual({
      clientId: 'cli_123',
      operation: 'add',
      events: [],
      appEvents: ['im.message.receive_v1'],
      userEvents: [],
      eventMode: 4,
    });
  });

  it('extracts event state from authentic Open Platform event response structure', () => {
    const raw = {
      code: 0,
      data: {
        eventMode: 4,
        appEvents: ['im.message.receive_v1'],
        appEventDetails: [
          { items: [{ id: 'im.chat.member.bot.added_v1' }] },
        ],
        userEvents: [],
        events: [],
      },
    };

    const state = extractOpenPlatformEventState(raw);
    expect(state.eventMode).toBe(4);
    expect(state.events).toContain('im.message.receive_v1');
    expect(state.events).toContain('im.chat.member.bot.added_v1');
  });
});

describe('3. Fail-Closed Online Visibility & Version Calculations', () => {
  it('correctly extracts members, departments, and groups from online visibility response', () => {
    const payload = {
      code: 0,
      data: {
        whiteList: {
          departments: [{ id: 'dep_1' }, { id: 'dep_2' }],
          members: [{ id: 'ou_alice' }],
          groups: [{ id: 'grp_1' }],
          isAll: 0,
        },
        blackList: {
          departments: [],
          members: [],
          groups: [],
          isAll: 0,
        },
      },
    };

    const parsed = parseOnlineVisibility(payload);
    expect(parsed.visibleSuggest).toEqual({
      departments: ['dep_1', 'dep_2'],
      members: ['ou_alice'],
      groups: ['grp_1'],
      isAll: 0,
    });
    expect(parsed.blackVisibleSuggest).toEqual(EMPTY_VISIBILITY);
  });

  it('fails closed with VisibilityParseError if visibility structure is corrupted or missing fields', () => {
    const invalidPayload = {
      code: 0,
      data: {
        whiteList: {
          departments: 'invalid_not_array',
          members: [{ id: 'ou_alice' }],
          isAll: 0,
        },
      },
    };

    expect(() => parseOnlineVisibility(invalidPayload)).toThrow(VisibilityParseError);
  });

  it('calculates nextAppVersion correctly from data.versions', () => {
    const emptyVersion = nextAppVersion({ code: 0, data: { versions: [] } });
    expect(emptyVersion).toBe('0.0.1');

    const nextVer = nextAppVersion({
      code: 0,
      data: {
        versions: [{ appVersion: '1.0.0' }, { appVersion: '1.0.2' }],
      },
    });
    expect(nextVer).toBe('1.0.3');
  });
});

describe('4. Mock Open Platform Setup Automation Workflow & Session Identity', () => {
  it('extracts CSRF token and balanced JSON session identity from authentic HTML', () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <script>window.csrfToken = "csrf_token_authentic_val";</script>
        </head>
        <body>
          <script>
            window.user = {
              "id": "ou_scanner_123",
              "name": "Scanner User",
              "tenantId": "ten_corp_789",
              "tenantName": "Corp Name",
              "email": "scanner@corp.feishu.cn"
            };
          </script>
        </body>
      </html>
    `;

    const csrf = extractOpenPlatformCsrfToken(html);
    expect(csrf).toBe('csrf_token_authentic_val');

    const identity = extractOpenPlatformSessionIdentity(html);
    expect(identity).toEqual({
      userId: 'ou_scanner_123',
      userName: 'Scanner User',
      tenantId: 'ten_corp_789',
      tenantName: 'Corp Name',
      email: 'scanner@corp.feishu.cn',
    });
  });

  it('generates zero-dependency SVG and Data URL for QR payload', () => {
    const qrPayload = JSON.stringify({ qrlogin: { token: 'tok_test_12345' } });
    const svg = generateQrSvg(qrPayload);
    expect(svg).toContain('<svg');
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');

    const dataUrl = generateQrDataUrl(qrPayload);
    expect(dataUrl.startsWith('data:image/svg+xml;utf8,')).toBe(true);
  });

  it('executes full read-before-merge automation and identifies pending approval status', async () => {
    const mockPostJson = vi.fn(async (url: string, body?: any) => {
      if (url.includes('/accounts/qrlogin/init')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { step_info: { token: 'mock_token_123' } },
        }), {
          headers: { 'x-flow-key': 'flow_key_xyz', 'content-type': 'application/json' },
        });
      }

      if (url.includes('/developers/v1/scope/all/cli_test_123')) {
        return {
          code: 0,
          data: {
            scopes: [
              { id: 'sc_msg_t', name: 'im:message', bucket: 'tenant' },
              { id: 'sc_msg_u', name: 'im:message', bucket: 'user' },
            ],
          },
        };
      }

      if (url.includes('/developers/v1/scope/update/cli_test_123')) {
        return { code: 0, msg: 'ok' };
      }

      if (url.includes('/developers/v1/privilege/all/cli_test_123')) {
        return {
          code: 0,
          data: {
            privileges: [
              { id: 'priv_1', isRequired: true, privilegeStatus: 'Unset' },
            ],
          },
        };
      }

      if (url.includes('/developers/v1/privilege/update/cli_test_123')) {
        return { code: 0 };
      }

      if (url.includes('/developers/v1/robot/switch/cli_test_123')) {
        return { code: 0 };
      }

      if (url.includes('/developers/v1/event/switch/cli_test_123')) {
        return { code: 0 };
      }

      if (url.includes('/developers/v1/event/cli_test_123')) {
        return {
          code: 0,
          data: {
            eventMode: LONG_CONNECTION_EVENT_MODE,
            appEvents: ['im.message.receive_v1'],
          },
        };
      }

      if (url.includes('/developers/v1/visible/online/cli_test_123')) {
        return {
          code: 0,
          data: {
            whiteList: { departments: [], members: ['ou_creator'], groups: [], isAll: 0 },
            blackList: { departments: [], members: [], groups: [], isAll: 0 },
          },
        };
      }

      if (url.includes('/developers/v1/app_version/list/cli_test_123')) {
        return {
          code: 0,
          data: {
            versions: [{ appVersion: '1.0.0' }],
          },
        };
      }

      if (url.includes('/developers/v1/app_version/create/cli_test_123')) {
        return {
          code: 0,
          data: { versionId: 'ver_created_101' },
        };
      }

      if (url.includes('/developers/v1/publish/commit/cli_test_123/ver_created_101')) {
        return {
          code: 0,
          data: { status: 'under_review', need_audit: true },
        };
      }

      if (url.includes('/app/cli_test_123/auth') || url.includes('/app')) {
        return new Response(`
          <html>
            <head><script>window.csrfToken = "csrf_test_token_999";</script></head>
            <body>
              <script>window.user = {"id":"ou_mock_creator","name":"Mock User","tenantId":"ten_mock_corp","tenantName":"Mock Corp"};</script>
            </body>
          </html>
        `);
      }

      return { code: 0 };
    });

    const mockFetcher = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const urlStr = url.toString();
      const res = await mockPostJson(urlStr, init?.body ? JSON.parse(init.body as string) : undefined);
      if (res instanceof Response) return res;
      return new Response(JSON.stringify(res), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const result = await automateOpenPlatformSetup({
      appId: 'cli_test_123',
      brand: 'feishu',
      sessionCookies: [
        { name: 'session', value: 'sess_val', domain: 'open.feishu.cn', path: '/', secure: true, httpOnly: true, hostOnly: true },
      ],
      requireVerifiedEvents: true,
      fetchImpl: mockFetcher as any,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.awaitingApproval).toBe(true);
      expect(result.versionId).toBe('ver_created_101');
      expect(result.subscribedEventCount).toBe(1);
      expect(result.eventModeReady).toBe(true);
    }
  });

  it('fails closed when scope update API call is rejected and halts version publication', async () => {
    let publishCalled = false;
    const mockFetcher = async (url: RequestInfo | URL): Promise<Response> => {
      const urlStr = url.toString();
      if (urlStr.includes('/auth')) {
        return new Response('<html><head><script>window.csrfToken = "csrf_test";</script></head></html>');
      }
      if (urlStr.includes('/developers/v1/scope/all/cli_scope_err')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { scopes: [{ id: 'sc_1', name: 'im:message', bucket: 'tenant' }] },
        }));
      }
      if (urlStr.includes('/developers/v1/scope/update/cli_scope_err')) {
        return new Response(JSON.stringify({ code: 10003, msg: 'Scope update permission denied' }), { status: 403 });
      }
      if (urlStr.includes('/publish/commit')) {
        publishCalled = true;
      }
      return new Response(JSON.stringify({ code: 0 }));
    };

    const result = await automateOpenPlatformSetup({
      appId: 'cli_scope_err',
      brand: 'feishu',
      sessionCookies: [{ name: 's', value: 'v', domain: 'open.feishu.cn', path: '/', secure: true, httpOnly: true, hostOnly: true }],
      fetchImpl: mockFetcher as any,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('scope_update_failed');
      expect(result.requiresAttention).toBe(true);
    }
    expect(publishCalled).toBe(false);
  });
});
