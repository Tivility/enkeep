/**
 * Portions of this file are derived from botmux (https://github.com/botmux/botmux)
 * Copyright (c) 2026 botmux contributors
 * Licensed under the MIT License.
 *
 * Feishu Open Platform setup and onboarding automation.
 *
 * @module @enkeep/channel-lark/onboarding/automation
 */

import { randomUUID } from 'node:crypto';
import type {
  StoredCookie,
  ScopeManifest,
  OpenPlatformAutomationOptions,
  OpenPlatformAutomationResult,
  CreateAppResult,
  OpenPlatformEventState,
  OpenPlatformCallbackState,
  OpenPlatformPrivilege,
  OpenPlatformPrivilegeField,
} from './types.js';
import {
  MutableCookieJar,
  FEISHU_ACCOUNTS_ORIGIN,
  ASK_FEISHU_ORIGIN,
  FEISHU_OPEN_PLATFORM_ORIGIN,
  FEISHU_APP_ID,
  FEISHU_COMMON_HEADERS,
  extractOpenPlatformCsrfToken,
  extractOpenPlatformSessionIdentity,
  validateFeishuWebSession,
  isAllowedFeishuUrl,
} from './session.js';
import {
  getDefaultScopeManifest,
  extractOpenPlatformScopeEntries,
  mapManifestScopesToOpenPlatformIds,
  buildScopeUpdatePayload,
} from './scope-manifest.js';
import {
  parseOnlineVisibility,
  VisibilityParseError,
} from './visibility.js';

/**
 * Baseline event actively processed by Enkeep text conversation gateway.
 * Other existing events on the app are preserved and not deleted.
 */
export const BOT_BASELINE_APP_EVENTS = ['im.message.receive_v1'] as const;
export const BOT_CRITICAL_APP_EVENTS = ['im.message.receive_v1'] as const;
export const LONG_CONNECTION_EVENT_MODE = 4;

export class OpenPlatformApiError extends Error {
  constructor(
    message: string,
    readonly payload: unknown,
    readonly status: number
  ) {
    super(message);
    this.name = 'OpenPlatformApiError';
  }
}

export class FeishuLoginError extends Error {
  constructor(
    message: string,
    readonly reason: 'timeout' | 'qr_expired' | 'network' | 'login_failed' | 'invalid_session'
  ) {
    super(message);
    this.name = 'FeishuLoginError';
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function pickString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = record[key];
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err || 'Unknown error');
}

export function buildFeishuQrPayload(token: string): string {
  return JSON.stringify({ qrlogin: { token } });
}

export function mapFeishuQrPollingStatus(status: number | null): string {
  if (status === 2) return 'Scanned, waiting for confirmation on mobile';
  if (status === 5) return 'QR code expired';
  return 'Waiting for Feishu scan';
}

/**
 * Initializes a Feishu Web QR login flow.
 * Returns flowKey, token, and the URL / payload to encode in the QR.
 */
export async function initFeishuQrSession(
  session: MutableCookieJar,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<{ flowKey: string; token: string; qrPayload: string; qrUrl?: string }> {
  const redirectUrl = `${ASK_FEISHU_ORIGIN}/`;
  const endpoint = `${FEISHU_ACCOUNTS_ORIGIN}/accounts/qrlogin/init?_r${10000 + Math.floor(Math.random() * 80000)}=${Date.now()}`;
  const response = await session.fetchRaw(fetcher, endpoint, {
    method: 'POST',
    signal,
    headers: {
      ...FEISHU_COMMON_HEADERS,
      'x-app-id': FEISHU_APP_ID,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      biz_type: null,
      redirect_uri: redirectUrl,
    }),
  });

  const data = await response.json();
  const dataRec = asRecord(data);
  if (dataRec.code !== 0) {
    const msg = pickString(dataRec, ['message', 'msg']) ?? 'Feishu QR init failed';
    throw new FeishuLoginError(msg, 'login_failed');
  }

  const innerData = asRecord(dataRec.data);
  const stepInfo = asRecord(innerData.step_info);
  const token = pickString(stepInfo, ['token']);
  const flowKey = response.headers.get('x-flow-key') ?? '';

  if (!flowKey || !token) {
    throw new FeishuLoginError('Feishu QR init missing flow key or token', 'login_failed');
  }

  const qrPayload = buildFeishuQrPayload(token);
  // Official scan URL only if explicitly provided in response and strictly on the Feishu allowlist
  const officialUrl = pickString(stepInfo, ['url', 'qr_url', 'scan_url', 'login_url']);
  const qrUrl = (officialUrl && isAllowedFeishuUrl(officialUrl)) ? officialUrl : undefined;

  return { flowKey, token, qrPayload, qrUrl };
}

/**
 * Polls the Feishu QR login status once.
 */
export async function pollFeishuQrSession(
  session: MutableCookieJar,
  flowKey: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<{
  status: number | null;
  nextStep: string | null;
  crossLoginUri: string | null;
  isConfirmed: boolean;
  isExpired: boolean;
  isComplete: boolean;
}> {
  const endpoint = `${FEISHU_ACCOUNTS_ORIGIN}/accounts/qrlogin/polling?_r${10000 + Math.floor(Math.random() * 80000)}=${Date.now()}`;
  const response = await session.fetchRaw(fetcher, endpoint, {
    method: 'POST',
    signal,
    headers: {
      ...FEISHU_COMMON_HEADERS,
      'x-app-id': FEISHU_APP_ID,
      'x-flow-key': flowKey,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ biz_type: null }),
  });

  const data = await response.json();
  const dataRec = asRecord(data);
  if (dataRec.code !== 0) {
    const msg = pickString(dataRec, ['message', 'msg']) ?? 'Feishu QR polling failed';
    throw new FeishuLoginError(msg, 'login_failed');
  }

  const innerData = asRecord(dataRec.data);
  const stepInfo = asRecord(innerData.step_info);
  const status = typeof stepInfo.status === 'number' ? stepInfo.status : null;
  const nextStep = pickString(innerData, ['next_step']) ?? null;
  const crossLoginUri = pickString(stepInfo, ['cross_login_uri']) ?? null;

  return {
    status,
    nextStep,
    crossLoginUri,
    isConfirmed: status === 2,
    isExpired: status === 5,
    isComplete: nextStep === 'enter_app',
  };
}

/**
 * Completes the login flow after nextStep === 'enter_app'.
 */
export async function finalizeFeishuQrLogin(
  session: MutableCookieJar,
  crossLoginUri: string | null,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<StoredCookie[]> {
  const redirectUrl = `${ASK_FEISHU_ORIGIN}/`;
  if (crossLoginUri) {
    await session.fetchRaw(fetcher, crossLoginUri, { method: 'GET', signal });
  }
  await session.fetchRaw(fetcher, redirectUrl, { method: 'GET', signal });
  const cookies = session.toJSON();
  return cookies;
}

export interface OpenPlatformApiClient {
  readonly apiOrigin: string;
  readonly appHome: string;
  readonly csrfToken: string;
  readonly identity?: import('./types.js').FeishuWebSessionIdentity | null;
  postJson(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown>;
}

export async function createOpenPlatformApiClient(
  cookies: StoredCookie[],
  appId?: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<{ client: OpenPlatformApiClient; identity: import('./types.js').FeishuWebSessionIdentity | null }> {
  const session = new MutableCookieJar(cookies);
  const defaultOrigin = FEISHU_OPEN_PLATFORM_ORIGIN;
  const targetAppId = appId || 'cli_placeholder';
  const defaultAppHome = `${defaultOrigin}/app/${targetAppId}`;

  let csrfToken: string | null = null;
  let apiOrigin = defaultOrigin;
  let appHome = defaultAppHome;
  let html = '';

  try {
    const authPage = await session.fetchTextWithUrl(fetcher, `${defaultAppHome}/auth`, signal);
    apiOrigin = new URL(authPage.finalUrl).origin;
    appHome = `${apiOrigin}/app/${targetAppId}`;
    html = authPage.text;
    csrfToken = extractOpenPlatformCsrfToken(authPage.text);
    if (!csrfToken) {
      const homePage = await session.fetchTextWithUrl(fetcher, appHome, signal);
      apiOrigin = new URL(homePage.finalUrl).origin;
      appHome = `${apiOrigin}/app/${targetAppId}`;
      html = homePage.text;
      csrfToken = extractOpenPlatformCsrfToken(homePage.text);
    }
    if (!csrfToken) {
      const baseAppPage = await session.fetchTextWithUrl(fetcher, `${apiOrigin}/app`, signal);
      apiOrigin = new URL(baseAppPage.finalUrl).origin;
      html = baseAppPage.text;
      csrfToken = extractOpenPlatformCsrfToken(baseAppPage.text);
    }
  } catch (err: any) {
    throw new OpenPlatformApiError(`Failed to fetch Open Platform page: ${safeErrorMessage(err)}`, null, 500);
  }

  if (!csrfToken) {
    throw new OpenPlatformApiError('Feishu session valid but failed to extract CSRF token', null, 401);
  }

  const identity = extractOpenPlatformSessionIdentity(html);

  const postJson = async (path: string, body?: unknown, reqSignal?: AbortSignal): Promise<unknown> => {
    const effectiveSignal = reqSignal ?? signal;
    const url = `${apiOrigin}${path}`;
    const response = await session.fetchRaw(fetcher, url, {
      method: 'POST',
      signal: effectiveSignal,
      headers: {
        accept: 'application/json, text/plain, */*',
        origin: apiOrigin,
        referer: appHome,
        'x-csrf-token': csrfToken!,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    let data: any;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok) {
      throw new OpenPlatformApiError(
        `HTTP ${response.status} ${path}`,
        data,
        response.status
      );
    }

    if (data && typeof data === 'object' && typeof data.code === 'number' && data.code !== 0) {
      throw new OpenPlatformApiError(
        `code=${data.code} msg=${data.msg ?? data.message ?? ''}`,
        data,
        response.status
      );
    }

    return data;
  };

  return {
    client: {
      apiOrigin,
      appHome,
      csrfToken,
      identity,
      postJson,
    },
    identity,
  };
}

function extractEventIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(
    value
      .map((item) => (typeof item === 'string' ? item : pickString(asRecord(item), ['id', 'eventName', 'event_name', 'name'])))
      .filter((item): item is string => Boolean(item))
  );
}

function extractEventIdsFromDetails(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value.flatMap((group) => extractEventIds(asRecord(group).items)));
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

export function extractOpenPlatformEventState(payload: unknown): OpenPlatformEventState {
  const root = asRecord(payload);
  const wrapped = asRecord(root.data);
  const data = Object.keys(wrapped).length > 0 ? wrapped : root;
  const appEvents = uniqueStrings([
    ...extractEventIds(data.appEvents),
    ...extractEventIdsFromDetails(data.appEventDetails),
  ]);
  const userEvents = uniqueStrings([
    ...extractEventIds(data.userEvents),
    ...extractEventIdsFromDetails(data.userEventDetails),
  ]);
  const genericEvents = uniqueStrings([
    ...extractEventIds(data.events),
    ...extractEventIdsFromDetails(data.eventDetails),
  ]);
  const eventMode =
    typeof data.eventMode === 'number' && Number.isFinite(data.eventMode) ? data.eventMode : undefined;
  return {
    eventMode,
    events: uniqueStrings([...genericEvents, ...appEvents, ...userEvents]),
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function nextAppVersion(payload: unknown): string {
  const data = asRecord(asRecord(payload).data);
  const versions = Array.isArray(data.versions) ? data.versions : [];
  const triples = versions
    .map((item) => pickString(asRecord(item), ['appVersion']))
    .filter((version): version is string => Boolean(version))
    .map((version) => version.split('.').map((part) => Number.parseInt(part, 10)))
    .filter((parts) => parts.length === 3 && parts.every((part) => Number.isFinite(part)));
  if (triples.length === 0) return '0.0.1';
  const max = triples.reduce((a, b) => {
    for (let i = 0; i < 3; i++) {
      if (b[i] !== a[i]) return b[i] > a[i] ? b : a;
    }
    return a;
  });
  return [max[0], max[1], max[2] + 1].join('.');
}

export function extractVersionId(payload: unknown): string | undefined {
  const direct = pickString(asRecord(payload), ['versionId', 'version_id', 'id']);
  if (direct) return direct;
  const data = asRecord(asRecord(payload).data);
  return pickString(data, ['versionId', 'version_id', 'id']) ?? pickString(asRecord(data.appVersion), ['versionId', 'version_id', 'id']);
}

export function buildEventSubscriptionPayload(
  appId: string,
  eventMode: number,
  appEvents: string[],
  userEvents: string[] = [],
  events: string[] = []
) {
  return {
    clientId: appId,
    operation: 'add',
    events,
    appEvents,
    userEvents,
    eventMode,
  };
}

export function buildAppVersionCreatePayload(appVersion: string, visibleMemberIds: string[] = []) {
  return {
    appVersion,
    versionRemark: 'Configured by Enkeep Channel Automation',
    changeLog: 'Configured by Enkeep Channel Automation',
    visibleSuggest: {
      departments: [],
      members: visibleMemberIds,
      groups: [],
      isAll: 0,
    },
    blackVisibleSuggest: {
      departments: [],
      members: [],
      groups: [],
      isAll: 0,
    },
  };
}

/**
 * Narrows required privilege ranges to application visibility.
 */
export async function narrowRequiredPrivilegeRanges(
  postJson: (path: string, body?: unknown, signal?: AbortSignal) => Promise<unknown>,
  appId: string,
  signal?: AbortSignal
): Promise<number> {
  let allPrivilegesPayload: unknown;
  try {
    allPrivilegesPayload = await postJson(`/developers/v1/privilege/all/${appId}`, undefined, signal);
  } catch {
    return 0;
  }

  const root = asRecord(allPrivilegesPayload);
  const data = asRecord(root.data ?? root);
  const rawPrivList = data.privileges ?? data.list;
  const list: unknown[] = Array.isArray(rawPrivList) ? rawPrivList : [];
  const toUpdate: Record<string, unknown>[] = [];

  for (const item of list) {
    const rec = asRecord(item);
    const isRequired = Boolean(rec.isRequired ?? rec.is_required);
    const privilegeStatus = String(rec.privilegeStatus ?? rec.status ?? '');
    if (isRequired && (privilegeStatus === 'Unset' || !rec.content)) {
      toUpdate.push({
        ...rec,
        content: JSON.stringify({ mode: 'app' }),
      });
    }
  }

  if (toUpdate.length > 0) {
    try {
      await postJson(`/developers/v1/privilege/update/${appId}`, {
        clientId: appId,
        privileges: toUpdate,
      }, signal);
      return toUpdate.length;
    } catch {
      return 0;
    }
  }

  return 0;
}

/**
 * Fetches Open Platform AppSecret for a given appId using authentic Botmux console contract:
 * POST /developers/v1/secret/:clientId, body {} (strictly read-only, never /reset).
 */
export async function fetchOpenPlatformAppSecret(
  client: OpenPlatformApiClient,
  appId: string,
  signal?: AbortSignal
): Promise<string> {
  const res = await client.postJson(`/developers/v1/secret/${appId}`, {}, signal);
  const record = asRecord(res);
  const secret = pickString(asRecord(record.data), ['secret']) ?? pickString(record, ['secret', 'appSecret', 'app_secret']);
  if (!secret) {
    throw new OpenPlatformApiError('Open Platform did not return secret field', res, 500);
  }
  return secret;
}

/**
 * Creates a brand new Feishu Open Platform bot app and prepares it with bot capability + 1.0.0 publish.
 */
export async function createFeishuBotApp(
  cookies: StoredCookie[],
  options: {
    name: string;
    description?: string;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
  }
): Promise<CreateAppResult> {
  const fetcher = options.fetchImpl ?? fetch;
  const signal = options.signal;
  const { client, identity } = await createOpenPlatformApiClient(cookies, undefined, fetcher, signal);
  if (!identity?.userId) {
    throw new Error('Could not identify Feishu Web session owner userId; app creation aborted');
  }
  const creatorUserId = identity.userId;

  const name = options.name.trim();
  const description = options.description?.trim() || 'Enkeep Assistant Bot';

  // 1. Create app
  let createdApp: unknown;
  try {
    createdApp = await client.postJson('/developers/v1/app/create', {
      appSceneType: 0,
      name,
      desc: description,
      i18n: { zh_cn: { name, description } },
      primaryLang: 'zh_cn',
    }, signal);
  } catch (err: any) {
    throw new Error(`Failed to create Open Platform app: ${safeErrorMessage(err)}`);
  }

  const root = asRecord(createdApp);
  const data = asRecord(root.data ?? root);
  const appId = pickString(data, ['ClientID', 'clientID', 'clientId', 'appId']);

  if (!appId || !appId.startsWith('cli_')) {
    throw new Error('Open Platform app creation did not return a valid ClientID (cli_*)');
  }

  // 2. Enable Bot capability & WebSocket Long Connection
  try {
    await client.postJson(`/developers/v1/robot/switch/${appId}`, { clientId: appId, enable: true }, signal);
    await client.postJson(`/developers/v1/event/switch/${appId}`, { clientId: appId, eventMode: LONG_CONNECTION_EVENT_MODE }, signal);
  } catch (err: any) {
    throw new Error(`Failed to enable robot or event mode for new app: ${safeErrorMessage(err)}`);
  }

  // 3. Narrow required privilege ranges
  await narrowRequiredPrivilegeRanges(client.postJson, appId, signal).catch(() => 0);

  // 4. Initial 1.0.0 publish (creator visible only) to activate tenant app
  let versionId: string | undefined;
  let awaitingApproval = false;
  try {
    const versionPayload = buildAppVersionCreatePayload('1.0.0', [creatorUserId]);
    const versionCreated = await client.postJson(`/developers/v1/app_version/create/${appId}`, versionPayload, signal);
    versionId = extractVersionId(versionCreated);
    if (!versionId) {
      throw new Error('Initial app version creation did not return versionId');
    }

    const commitRes = await client.postJson(`/developers/v1/publish/commit/${appId}/${versionId}`, { clientId: appId }, signal);
    const commitData = asRecord(asRecord(commitRes).data ?? commitRes);
    const status = commitData.status ?? commitData.publish_status ?? commitData.appStatus;
    const needAudit = commitData.need_audit ?? commitData.needAudit;

    // Conservative fail-closed: unless explicitly confirmed as published/online, require approval
    const isExplicitlyOnline = status === 'published' || status === 'online' || status === 2 || status === 'passed';
    if (!isExplicitlyOnline || needAudit === true) {
      awaitingApproval = true;
    }
  } catch (err: any) {
    throw new Error(`Failed to publish initial 1.0.0 version: ${safeErrorMessage(err)}`);
  }

  // 5. Read AppSecret via authentic POST /developers/v1/secret/:clientId
  const appSecret = await fetchOpenPlatformAppSecret(client, appId, signal);

  return {
    appId,
    appSecret,
    versionId,
    awaitingApproval,
  };
}

/**
 * Automates scopes, events, privilege ranges, and publishes an existing or newly created app.
 * Read-before-merge: reads catalog, existing event subscriptions, and online visibility before mutating.
 */
export async function automateOpenPlatformSetup(
  options: OpenPlatformAutomationOptions & { signal?: AbortSignal }
): Promise<OpenPlatformAutomationResult> {
  const brand = options.brand ?? 'feishu';
  if (brand !== 'feishu') {
    return {
      ok: false,
      reason: 'unsupported_brand',
      message: 'Automatic Open Platform configuration currently supports feishu.cn tenants. For Lark international, requires_manual_supported_fallback.',
      redirectConfigured: false,
    };
  }

  const fetcher = options.fetchImpl ?? fetch;
  const signal = options.signal;
  let client: OpenPlatformApiClient;

  try {
    const clientRes = await createOpenPlatformApiClient(options.sessionCookies, options.appId, fetcher, signal);
    client = clientRes.client;
  } catch (err: any) {
    return {
      ok: false,
      reason: 'api_error',
      message: `Failed to initialize Open Platform client: ${safeErrorMessage(err)}`,
      redirectConfigured: false,
    };
  }

  let mutated = false;
  let scopeWarning: string | undefined;
  let importedScopeCount = 0;
  let skippedScopeCount = 0;

  // 1. Read-before-merge: Read catalog and map scopes (fail closed if read fails)
  let allScopesPayload: unknown;
  try {
    allScopesPayload = await client.postJson(`/developers/v1/scope/all/${options.appId}`, undefined, signal);
  } catch (err: any) {
    return {
      ok: false,
      reason: 'scope_catalog_unreadable',
      message: `Failed to read Open Platform scope catalog: ${safeErrorMessage(err)}`,
      redirectConfigured: false,
    };
  }

  const catalog = extractOpenPlatformScopeEntries(allScopesPayload);
  if (catalog.length === 0) {
    return {
      ok: false,
      reason: 'scope_catalog_empty',
      message: 'Open Platform returned empty scope catalog; cannot safely compute scope diff',
      redirectConfigured: false,
    };
  }

  const manifest = options.scopeManifest ?? getDefaultScopeManifest();
  const grantedTenant = options.grantedScopeNames?.tenant ? new Set(options.grantedScopeNames.tenant) : undefined;
  const grantedUser = options.grantedScopeNames?.user ? new Set(options.grantedScopeNames.user) : undefined;

  const effectiveManifest: ScopeManifest = {
    scopes: {
      tenant: (manifest.scopes?.tenant ?? []).filter((name) => !grantedTenant?.has(name)),
      user: (manifest.scopes?.user ?? []).filter((name) => !grantedUser?.has(name)),
    },
  };

  const mapped = mapManifestScopesToOpenPlatformIds(effectiveManifest, catalog);
  skippedScopeCount = mapped.missingTenantScopes.length + mapped.missingUserScopes.length;
  importedScopeCount = mapped.tenantScopeIds.length + mapped.userScopeIds.length;

  if (importedScopeCount > 0) {
    try {
      await client.postJson(`/developers/v1/scope/update/${options.appId}`, buildScopeUpdatePayload(options.appId, mapped), signal);
      mutated = true;
    } catch (err: any) {
      return {
        ok: false,
        reason: 'scope_update_failed',
        message: `Failed to submit scope update to Open Platform: ${safeErrorMessage(err)}`,
        requiresAttention: true,
        redirectConfigured: false,
      };
    }
  }

  // 2. Narrow required privilege ranges (non-fatal)
  let privilegeRangeCount = 0;
  let privilegeRangeWarning: string | undefined;
  try {
    privilegeRangeCount = await narrowRequiredPrivilegeRanges(client.postJson, options.appId, signal);
    if (privilegeRangeCount > 0) mutated = true;
  } catch (err: any) {
    privilegeRangeWarning = safeErrorMessage(err);
  }

  // 3. Switch robot & event mode to long connection (fatal)
  try {
    await client.postJson(`/developers/v1/robot/switch/${options.appId}`, { clientId: options.appId, enable: true }, signal);
    await client.postJson(`/developers/v1/event/switch/${options.appId}`, { clientId: options.appId, eventMode: LONG_CONNECTION_EVENT_MODE }, signal);
  } catch (err: any) {
    return {
      ok: false,
      reason: 'api_error',
      message: `Failed to enable robot or long-connection event mode: ${safeErrorMessage(err)}`,
      redirectConfigured: false,
    };
  }

  // 4. Read-before-merge: Events subscription (incremental merge only, preserve existing events)
  const eventWarnings: string[] = [];
  const readEventState = async () =>
    extractOpenPlatformEventState(await client.postJson(`/developers/v1/event/${options.appId}`, { needEventDetail: true }, signal));

  let eventState: OpenPlatformEventState | undefined;
  try {
    eventState = await readEventState();
  } catch (err: any) {
    return {
      ok: false,
      reason: 'event_state_unreadable',
      message: `Failed to read existing event subscriptions: ${safeErrorMessage(err)}`,
      redirectConfigured: false,
    };
  }

  const hasEvent = (name: string) => Boolean(eventState?.events.includes(name));
  const missingBaselineEvents = BOT_BASELINE_APP_EVENTS.filter((name) => !hasEvent(name));

  if (missingBaselineEvents.length > 0) {
    mutated = true;
    const eventMode = eventState?.eventMode ?? LONG_CONNECTION_EVENT_MODE;
    try {
      await client.postJson(
        `/developers/v1/event/update/${options.appId}`,
        buildEventSubscriptionPayload(options.appId, eventMode, missingBaselineEvents, []),
        signal
      );
    } catch {
      for (const name of missingBaselineEvents) {
        try {
          await client.postJson(
            `/developers/v1/event/update/${options.appId}`,
            buildEventSubscriptionPayload(options.appId, eventMode, [name], []),
            signal
          );
        } catch (err: any) {
          eventWarnings.push(`Failed to subscribe baseline event ${name}: ${safeErrorMessage(err)}`);
        }
      }
    }

    try {
      eventState = await readEventState();
    } catch (err: any) {
      eventWarnings.push(`Failed to readback event subscriptions: ${safeErrorMessage(err)}`);
    }
  }

  const subscribedEventCount = (eventState?.events ?? []).length;
  const eventModeReady = eventState?.eventMode === LONG_CONNECTION_EVENT_MODE;
  const criticalIssues: string[] = [];

  if (options.requireVerifiedEvents) {
    const missingCritical = BOT_CRITICAL_APP_EVENTS.filter((name) => !hasEvent(name));
    if (missingCritical.length > 0) {
      criticalIssues.push(`Missing critical events: ${missingCritical.join(', ')}`);
    }
  }

  if (!eventModeReady) {
    criticalIssues.push(`Event mode is not long-connection (current=${eventState?.eventMode})`);
  }

  if (criticalIssues.length > 0) {
    return {
      ok: false,
      reason: 'event_verification_failed',
      message: `Critical event subscription verification failed: ${criticalIssues.join('; ')}`,
      subscribedEventCount,
      eventWarning: eventWarnings.join('; ') || undefined,
      eventModeReady,
      redirectConfigured: true,
    };
  }

  // 5. Check if version publish is needed
  const mustPublish = options.appJustCreated === true || options.requireVerifiedEvents === true;
  if (!mutated && !mustPublish) {
    return {
      ok: true,
      scopeCount: importedScopeCount,
      skippedScopeCount,
      scopeWarning,
      privilegeRangeCount,
      privilegeRangeWarning,
      subscribedEventCount,
      eventWarning: eventWarnings.join('; ') || undefined,
      eventModeReady,
      redirectConfigured: true,
      publishSkipped: true,
    };
  }

  // 6. Publish new version with strictly preserved online visibility (fail-closed)
  try {
    let onlineVisibilityRaw: unknown;
    try {
      onlineVisibilityRaw = await client.postJson(`/developers/v1/visible/online/${options.appId}`, {}, signal);
    } catch (err: any) {
      return {
        ok: false,
        reason: 'visibility_unreadable',
        message: `Failed to read online visibility: ${safeErrorMessage(err)}; publication aborted`,
        subscribedEventCount,
        eventWarning: eventWarnings.join('; ') || undefined,
        eventModeReady,
        redirectConfigured: true,
      };
    }

    let visibility: { visibleSuggest: import('./visibility.js').VisibilitySuggest; blackVisibleSuggest: import('./visibility.js').VisibilitySuggest };
    try {
      visibility = parseOnlineVisibility(onlineVisibilityRaw);
    } catch (err: any) {
      if (err instanceof VisibilityParseError) {
        return {
          ok: false,
          reason: 'visibility_unreadable',
          message: `Cannot safely parse online visibility (${err.message}); publication aborted to prevent overwriting visibility`,
          subscribedEventCount,
          eventWarning: eventWarnings.join('; ') || undefined,
          eventModeReady,
          redirectConfigured: true,
        };
      }
      throw err;
    }

    const versionList = await client.postJson(`/developers/v1/app_version/list/${options.appId}`, {}, signal);
    const appVersion = nextAppVersion(versionList);
    const versionPayload = buildAppVersionCreatePayload(appVersion) as Record<string, unknown>;
    versionPayload.visibleSuggest = visibility.visibleSuggest;
    versionPayload.blackVisibleSuggest = visibility.blackVisibleSuggest;

    const created = await client.postJson(`/developers/v1/app_version/create/${options.appId}`, versionPayload, signal);
    const versionId = extractVersionId(created);

    if (!versionId) {
      return {
        ok: false,
        reason: 'version_verification_failed',
        message: 'Open platform did not return versionId for created version (unknown result, will not retry)',
        subscribedEventCount,
        eventWarning: eventWarnings.join('; ') || undefined,
        eventModeReady,
        redirectConfigured: true,
        requiresAttention: true,
      };
    }

    const commitRes = await client.postJson(`/developers/v1/publish/commit/${options.appId}/${versionId}`, {
      clientId: options.appId,
    }, signal);
    const commitData = asRecord(asRecord(commitRes).data ?? commitRes);

    let awaitingApproval = false;
    let approvalMessage: string | undefined;
    const status = commitData.status ?? commitData.publish_status ?? commitData.appStatus;
    const needAudit = commitData.need_audit ?? commitData.needAudit;

    // Conservative fail-closed: unless explicitly confirmed as published/online, require approval
    const isExplicitlyOnline = status === 'published' || status === 'online' || status === 2 || status === 'passed';
    if (!isExplicitlyOnline || needAudit === true) {
      awaitingApproval = true;
      approvalMessage = 'Version submitted for administrator approval in Feishu Admin Console';
    }

    return {
      ok: true,
      scopeCount: importedScopeCount,
      skippedScopeCount,
      scopeWarning,
      privilegeRangeCount,
      privilegeRangeWarning,
      subscribedEventCount,
      eventWarning: eventWarnings.join('; ') || undefined,
      eventModeReady,
      redirectConfigured: true,
      versionId,
      awaitingApproval,
      approvalMessage,
    };
  } catch (err: any) {
    return {
      ok: false,
      reason: 'api_error',
      message: `Failed to create/publish version: ${safeErrorMessage(err)}`,
      subscribedEventCount,
      eventWarning: eventWarnings.join('; ') || undefined,
      eventModeReady,
      redirectConfigured: true,
      requiresAttention: true,
    };
  }
}
