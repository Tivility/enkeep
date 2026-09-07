/**
 * URL and Credential Sanitizer
 *
 * Enforces:
 * - Redaction of basic auth / userinfo in URLs (username:password@)
 * - Redaction of sensitive query parameters (tokens, keys, secrets, session cookies)
 * - Safe presentation of URLs for agent responses, logs, and audit trails
 *
 * @module @enkeep/platform-service-browser/security/url-sanitizer
 */

export const SENSITIVE_QUERY_PARAMS = new Set([
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'api_key',
  'apikey',
  'secret',
  'client_secret',
  'password',
  'passwd',
  'pwd',
  'auth',
  'authentication',
  'authorization',
  'bearer',
  'session',
  'session_id',
  'sessionid',
  'session_token',
  'signature',
  'sig',
  'code',
  'key',
  'private_key',
  'credential',
]);

/**
 * Sanitizes a URL string by stripping userinfo (user:password@) and redacting sensitive query parameters.
 */
export function sanitizeUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return '';
  }

  try {
    const url = new URL(rawUrl);

    // Strip basic auth credentials
    url.username = '';
    url.password = '';

    // Redact sensitive query parameters
    const searchParams = new URLSearchParams(url.search);
    let modified = false;

    for (const key of Array.from(searchParams.keys())) {
      const lowerKey = key.toLowerCase();
      if (
        SENSITIVE_QUERY_PARAMS.has(lowerKey) ||
        lowerKey.includes('token') ||
        lowerKey.includes('secret') ||
        lowerKey.includes('password') ||
        lowerKey.includes('apikey')
      ) {
        searchParams.set(key, '***');
        modified = true;
      }
    }

    if (modified) {
      url.search = searchParams.toString();
    }

    return url.toString();
  } catch {
    // If URL parsing fails, apply regex-based sanitization
    return rawUrl
      .replace(/(https?:\/\/)[^:@]+:[^@]+@/gi, '$1')
      .replace(/([?&](?:token|password|secret|key|api_key|auth)=)[^&#\s]+/gi, '$1***');
  }
}

/**
 * Strips query string and fragment entirely, returning only origin + pathname.
 */
export function getCleanOriginAndPath(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.username = '';
    url.password = '';
    return `${url.origin}${url.pathname}`;
  } catch {
    return rawUrl.split('?')[0].split('#')[0];
  }
}
