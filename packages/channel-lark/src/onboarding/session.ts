/**
 * Portions of this file are derived from botmux (https://github.com/botmux/botmux)
 * Copyright (c) 2026 botmux contributors
 * Licensed under the MIT License.
 *
 * Secure in-memory CookieJar and HTTP session helpers for Feishu Open Platform automation.
 * Enforces strict HTTPS allowlist, exact host match, port 443, no userinfo,
 * per-hop redirection checks, header sanitization, RFC 6265 domain/path matching,
 * and AbortSignal + timeout composition.
 *
 * @module @enkeep/channel-lark/onboarding/session
 */

import type { StoredCookie, FeishuWebSessionIdentity } from './types.js';

export const FEISHU_ACCOUNTS_ORIGIN = 'https://accounts.feishu.cn';
export const ASK_FEISHU_ORIGIN = 'https://ask.feishu.cn';
export const FEISHU_OPEN_PLATFORM_ORIGIN = 'https://open.feishu.cn';
export const FEISHU_APP_ID = '12';

export const ALLOWED_FEISHU_HOSTS = Object.freeze([
  'accounts.feishu.cn',
  'ask.feishu.cn',
  'open.feishu.cn',
  'open.larkoffice.com',
  'passport.feishu.cn',
]);

export const FEISHU_COMMON_HEADERS = {
  'x-api-version': '1.0.28',
  'x-device-info':
    'device_id=0;device_name=Chrome;device_os=Mac;device_model=Chrome;lark_version=;channel=Release;package_name=feishu;tt_app_id=1658;is_dpop_support=true;is_iframe=false',
  'x-locale': 'zh-CN',
  'x-terminal-type': '2',
};

export const DEFAULT_BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

export const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

export class InsecureRedirectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsecureRedirectError';
  }
}

/**
 * Validates whether a target URL is strictly allowed under Feishu HTTPS policy.
 * Requirements:
 * - Protocol strictly 'https:'
 * - Exact host in ALLOWED_FEISHU_HOSTS (no subdomain expansions, no IP addresses)
 * - Port must be empty or 443
 * - No username or password (userinfo) in URL
 */
export function isAllowedFeishuUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    if (url.protocol !== 'https:') {
      return false;
    }
    if (url.username || url.password) {
      return false;
    }
    if (url.port !== '' && url.port !== '443') {
      return false;
    }
    const hostname = url.hostname.toLowerCase();
    return ALLOWED_FEISHU_HOSTS.includes(hostname);
  } catch {
    return false;
  }
}

/**
 * Asserts that a URL is strictly in the allowed Feishu origins allowlist.
 */
export function assertAllowedFeishuUrl(urlString: string, context = 'request'): void {
  if (!isAllowedFeishuUrl(urlString)) {
    throw new InsecureRedirectError(`Untrusted or non-HTTPS origin forbidden in Feishu ${context}: "${urlString}"`);
  }
}

export function pruneExpiredCookies(cookies: StoredCookie[]): StoredCookie[] {
  const now = Date.now();
  return cookies.filter((cookie) => cookie.expiresAt === undefined || cookie.expiresAt > now);
}

/**
 * Checks if a cookie domain matches the response hostname (RFC 6265 Section 5.1.3).
 */
export function isCookieDomainMatch(responseHost: string, cookieDomain: string): boolean {
  const host = responseHost.toLowerCase();
  let domain = cookieDomain.toLowerCase();
  if (domain.startsWith('.')) {
    domain = domain.slice(1);
  }

  // Exact match
  if (host === domain) return true;

  // Suffix match (e.g. host: accounts.feishu.cn, domain: feishu.cn)
  if (host.endsWith(`.${domain}`)) {
    const parts = domain.split('.');
    if (parts.length >= 2) {
      return true;
    }
  }

  return false;
}

/**
 * Checks if a request path matches the cookie path (RFC 6265 Section 5.1.4).
 */
export function isCookiePathMatch(requestPath: string, cookiePath: string): boolean {
  const req = requestPath || '/';
  const cPath = cookiePath || '/';

  if (req === cPath) return true;
  if (req.startsWith(cPath)) {
    if (cPath.endsWith('/')) return true;
    if (req.charAt(cPath.length) === '/') return true;
  }
  return false;
}

/**
 * Parses Set-Cookie header with strict RFC 6265 domain and path validation.
 */
export function parseSetCookie(url: string, raw: string): StoredCookie | null {
  const parts = raw.split(';').map((p) => p.trim());
  if (parts.length === 0 || !parts[0]) return null;
  const eqIdx = parts[0].indexOf('=');
  if (eqIdx <= 0) return null;

  const name = parts[0].slice(0, eqIdx).trim();
  const value = parts[0].slice(eqIdx + 1).trim();
  const requestUrl = new URL(url);
  const responseHost = requestUrl.hostname.toLowerCase();

  let domain = responseHost;
  let path = '/';
  let secure = false;
  let httpOnly = false;
  let hostOnly = true;
  let expiresAt: number | undefined;
  let sameSite: string | undefined;

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const [k, ...vParts] = part.split('=');
    const key = k.trim().toLowerCase();
    const val = vParts.join('=').trim();

    if (key === 'domain') {
      const specifiedDomain = val.startsWith('.') ? val.slice(1) : val;
      if (isCookieDomainMatch(responseHost, specifiedDomain)) {
        domain = specifiedDomain;
        hostOnly = false;
      } else {
        return null;
      }
    } else if (key === 'path') {
      path = val || '/';
    } else if (key === 'secure') {
      secure = true;
    } else if (key === 'httponly') {
      httpOnly = true;
    } else if (key === 'samesite') {
      sameSite = val;
    } else if (key === 'max-age') {
      const sec = Number(val);
      if (!Number.isNaN(sec)) {
        expiresAt = Date.now() + sec * 1000;
      }
    } else if (key === 'expires' && expiresAt === undefined) {
      const t = Date.parse(val);
      if (!Number.isNaN(t)) {
        expiresAt = t;
      }
    }
  }

  return { name, value, domain, path, secure, httpOnly, hostOnly, expiresAt, sameSite };
}

export function splitSetCookieHeader(headerValue: string | null | undefined): string[] {
  if (!headerValue) return [];
  const result: string[] = [];
  let current = '';
  let inExpires = false;
  for (let i = 0; i < headerValue.length; i++) {
    const char = headerValue[i];
    if (char === ',' && !inExpires) {
      result.push(current.trim());
      current = '';
      continue;
    }
    current += char;
    if (current.toLowerCase().endsWith('expires=')) {
      inExpires = true;
    } else if (inExpires && char === ';') {
      inExpires = false;
    }
  }
  if (current.trim()) {
    result.push(current.trim());
  }
  return result;
}

/**
 * Serializes cookies applicable to requestUrl according to RFC 6265 rules.
 */
export function getCookieHeader(cookies: StoredCookie[], requestUrl: string): string {
  const url = new URL(requestUrl);
  const hostname = url.hostname.toLowerCase();
  const pathname = url.pathname || '/';
  const isHttps = url.protocol === 'https:';

  const valid = pruneExpiredCookies(cookies).filter((c) => {
    if (c.secure && !isHttps) return false;
    if (c.hostOnly) {
      if (hostname !== c.domain.toLowerCase()) return false;
    } else {
      if (!isCookieDomainMatch(hostname, c.domain)) return false;
    }
    if (!isCookiePathMatch(pathname, c.path)) return false;
    return true;
  });

  return valid.map((c) => `${c.name}=${c.value}`).join('; ');
}

export class MutableCookieJar {
  private cookies: StoredCookie[];

  constructor(cookies: StoredCookie[] = []) {
    this.cookies = pruneExpiredCookies(cookies);
  }

  toJSON(): StoredCookie[] {
    this.cookies = pruneExpiredCookies(this.cookies);
    return this.cookies.map((cookie) => ({ ...cookie }));
  }

  async fetchText(fetcher: typeof fetch, url: string, signal?: AbortSignal, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<string> {
    const response = await this.fetchRaw(fetcher, url, { method: 'GET', signal }, 10, timeoutMs);
    return await response.text();
  }

  async fetchTextWithUrl(
    fetcher: typeof fetch,
    url: string,
    signal?: AbortSignal,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
  ): Promise<{ text: string; finalUrl: string }> {
    const response = await this.fetchRaw(fetcher, url, { method: 'GET', signal }, 10, timeoutMs);
    return {
      text: await response.text(),
      finalUrl: (response as any).__finalUrl || url,
    };
  }

  async fetchRaw(
    fetcher: typeof fetch,
    url: string,
    init: RequestInit = {},
    maxHops = 10,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
  ): Promise<Response> {
    let current = url;
    let referer: string | undefined;
    let currentMethod = (init.method || 'GET').toUpperCase();
    let currentBody = init.body;
    let currentHeaders = new Headers(init.headers);

    for (let hop = 0; hop <= maxHops; hop += 1) {
      // 1. Verify destination URL against strict allowlist on every hop
      assertAllowedFeishuUrl(current, `redirect hop ${hop}`);

      // 2. Compose Timeout + AbortSignal
      const timeoutController = new AbortController();
      const timer = setTimeout(() => {
        timeoutController.abort(new Error(`Request to ${current} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      let onAbort: (() => void) | undefined;
      if (init.signal) {
        if (init.signal.aborted) {
          clearTimeout(timer);
          throw new DOMException('The operation was aborted.', 'AbortError');
        }
        onAbort = () => timeoutController.abort(init.signal?.reason);
        init.signal.addEventListener('abort', onAbort, { once: true });
      }

      const reqHeaders = new Headers(currentHeaders);
      const cookieHeader = getCookieHeader(this.cookies, current);
      if (cookieHeader) reqHeaders.set('cookie', cookieHeader);
      reqHeaders.set('user-agent', reqHeaders.get('user-agent') ?? DEFAULT_BROWSER_USER_AGENT);
      if (referer && !reqHeaders.has('referer')) reqHeaders.set('referer', referer);

      let response: Response;
      try {
        response = await fetcher(current, {
          ...init,
          method: currentMethod,
          headers: reqHeaders,
          body: currentBody,
          redirect: 'manual',
          signal: timeoutController.signal,
        });
      } finally {
        clearTimeout(timer);
        if (init.signal && onAbort) {
          init.signal.removeEventListener('abort', onAbort);
        }
      }

      this.loadFromResponse(current, response.headers);

      // Handle Redirection
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          (response as any).__finalUrl = current;
          return response;
        }

        const nextUrlObj = new URL(location, current);
        const nextUrl = nextUrlObj.toString();
        const prevOrigin = new URL(current).origin;
        const nextOrigin = nextUrlObj.origin;
        const isSameOrigin = prevOrigin === nextOrigin;

        // Verify next URL is allowed
        assertAllowedFeishuUrl(nextUrl, 'redirection target');

        // Handle Method & Body transitions per RFC 7231
        if (response.status === 303 || response.status === 301 || response.status === 302) {
          currentMethod = 'GET';
          currentBody = undefined;
          currentHeaders.delete('content-type');
          currentHeaders.delete('content-length');
        } else if (response.status === 307 || response.status === 308) {
          if (!isSameOrigin) {
            currentMethod = 'GET';
            currentBody = undefined;
            currentHeaders.delete('content-type');
            currentHeaders.delete('content-length');
          }
        }

        // Cross-origin: strip sensitive authentication & CSRF headers
        if (!isSameOrigin) {
          currentHeaders.delete('authorization');
          currentHeaders.delete('x-csrf-token');
          currentHeaders.delete('cookie');
          currentHeaders.delete('origin');
          currentHeaders.delete('referer');
        }

        referer = current;
        current = nextUrl;
        continue;
      }

      (response as any).__finalUrl = current;
      return response;
    }

    throw new Error('Too many redirects while accessing open platform');
  }

  private loadFromResponse(responseUrl: string, headers: Headers): void {
    const rawSetCookies =
      typeof (headers as any).getSetCookie === 'function'
        ? (headers as any).getSetCookie()
        : splitSetCookieHeader(headers.get('set-cookie'));
    for (const raw of rawSetCookies) {
      const cookie = parseSetCookie(responseUrl, raw);
      if (!cookie) continue;
      const idx = this.cookies.findIndex(
        (item) => item.name === cookie.name && item.domain === cookie.domain && item.path === cookie.path
      );
      if (cookie.expiresAt !== undefined && cookie.expiresAt <= Date.now()) {
        if (idx >= 0) this.cookies.splice(idx, 1);
        continue;
      }
      if (idx >= 0) this.cookies[idx] = cookie;
      else this.cookies.push(cookie);
    }
    this.cookies = pruneExpiredCookies(this.cookies);
  }
}

function extractBalancedJsonObject(input: string, start: number): string | null {
  if (input[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < input.length; i += 1) {
    const char = input[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return input.slice(start, i + 1);
    }
  }
  return null;
}

function pickString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function extractOpenPlatformCsrfToken(html: string): string | null {
  const match =
    html.match(/\bwindow\.csrfToken\s*=\s*(['"])([^'"]+)\1/) ??
    html.match(/\bcsrfToken\s*:\s*(['"])([^'"]+)\1/) ??
    html.match(/(?:window\.__CSRF_TOKEN__|window\.csrfToken|csrfToken)\s*=\s*['"]([^'"]+)['"]/);
  if (match) return match[2] ?? match[1] ?? null;

  const metaMatch = html.match(/<meta\s+name=["']csrf-token["']\s+content=["']([^"']+)["']/i);
  if (metaMatch && metaMatch[1]) return metaMatch[1];

  return null;
}

export function extractOpenPlatformSessionIdentity(html: string): FeishuWebSessionIdentity | null {
  const marker = /\bwindow\.user\s*=\s*/g;
  const match = marker.exec(html);
  if (!match) {
    const ctxMatch = html.match(/window\.context\s*=\s*({[\s\S]*?});<\/script>/);
    if (ctxMatch && ctxMatch[1]) {
      try {
        const context = JSON.parse(ctxMatch[1]);
        const user = context.user || context.currentUser || {};
        const tenant = context.tenant || context.currentTenant || {};
        const userId = String(user.id || user.user_id || user.userId || '');
        const userName = String(user.name || user.userName || user.user_name || 'Feishu User');
        const email = user.email ? String(user.email) : undefined;
        const tenantId = String(tenant.id || tenant.tenant_id || tenant.tenantId || '');
        const tenantName = String(tenant.name || tenant.tenant_name || tenant.tenantName || 'Feishu Enterprise');
        if (userId && tenantId) {
          return { userId, userName, email, tenantId, tenantName };
        }
      } catch {}
    }
    return null;
  }

  const start = match.index + match[0].length;
  const json = extractBalancedJsonObject(html, start);
  if (!json) return null;
  let user: Record<string, unknown>;
  try {
    user = asRecord(JSON.parse(json));
  } catch {
    return null;
  }
  const userId = pickString(user, ['id', 'userId', 'user_id']);
  const userName =
    pickString(user, ['name', 'userName', 'user_name']) ??
    pickString(asRecord(user.displayName), ['value']);
  const tenantId = pickString(user, ['tenantId', 'tenant_id']);
  const tenantName =
    pickString(asRecord(user.tenantDisplayName), ['value']) ??
    pickString(user, ['tenantName', 'tenant_name']);
  if (!userId || !userName || !tenantId || !tenantName) return null;
  const email = pickString(user, ['email']);
  return { userId, userName, ...(email ? { email } : {}), tenantId, tenantName };
}

export async function validateFeishuWebSession(
  cookies: StoredCookie[],
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<boolean> {
  if (!cookies || cookies.length === 0) return false;
  const jar = new MutableCookieJar(cookies);
  try {
    const res = await jar.fetchRaw(fetcher, `${FEISHU_OPEN_PLATFORM_ORIGIN}/app`, { method: 'GET', signal });
    if (res.status === 200) {
      const text = await res.text();
      if (text.includes('/accounts/page/login') || text.includes('passport-login-container')) {
        return false;
      }
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
