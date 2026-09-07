export const DEFAULT_WEB_ACCOUNT_ID = 'web-demo';
export const WEB_CHANNEL_NAME = 'web';

export interface RouteKeyParams {
  userId: string;
  channel?: string;
  accountId?: string;
  nativeContextId: string;
}

export interface ParsedRouteKey {
  userId: string;
  channel: string;
  accountId: string;
  nativeContextId: string;
}

/**
 * Builds a deterministic route key incorporating userId, channel, accountId, and nativeContextId.
 * Format: `${userId}:${channel}:${accountId}:${nativeContextId}`
 */
export function buildRouteKey(params: RouteKeyParams): string {
  const {
    userId,
    channel = WEB_CHANNEL_NAME,
    accountId = DEFAULT_WEB_ACCOUNT_ID,
    nativeContextId,
  } = params;

  if (!userId || typeof userId !== 'string') {
    throw new TypeError('RouteKey requires non-empty string userId');
  }
  if (!nativeContextId || typeof nativeContextId !== 'string') {
    throw new TypeError('RouteKey requires non-empty string nativeContextId');
  }

  // Prevent colon injection inside individual fields
  const safeUserId = userId.replace(/:/g, '_');
  const safeChannel = channel.replace(/:/g, '_');
  const safeAccountId = accountId.replace(/:/g, '_');
  const safeContextId = nativeContextId.replace(/:/g, '_');

  return `${safeUserId}:${safeChannel}:${safeAccountId}:${safeContextId}`;
}

/**
 * Parses a standard route key into its four constituent components.
 */
export function parseRouteKey(routeKey: string): ParsedRouteKey {
  if (!routeKey || typeof routeKey !== 'string') {
    throw new TypeError('Expected string routeKey');
  }

  const parts = routeKey.split(':');
  if (parts.length < 4) {
    throw new Error(`Invalid routeKey format "${routeKey}": expected "userId:channel:accountId:nativeContextId"`);
  }

  const [userId, channel, accountId, ...rest] = parts;
  const nativeContextId = rest.join(':');

  return {
    userId,
    channel,
    accountId,
    nativeContextId,
  };
}

/**
 * Validates whether a routeKey string has valid structure and matches expected accountId.
 */
export function isValidRouteKey(routeKey: unknown): boolean {
  if (typeof routeKey !== 'string') return false;
  try {
    const parsed = parseRouteKey(routeKey);
    return Boolean(parsed.userId && parsed.channel && parsed.accountId && parsed.nativeContextId);
  } catch {
    return false;
  }
}
