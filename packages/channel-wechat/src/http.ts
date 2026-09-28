/**
 * WeChat iLink HTTP utilities, headers, error classification, and retry policies.
 *
 * @module @enkeep/channel-wechat/http
 */

import crypto from 'node:crypto';
import type { WeChatConnectionErrorCode } from './transport-types.js';

export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

export const MSG_SPLIT_LIMIT = 2000;
export const DEFAULT_LONGPOLL_TIMEOUT_MS = 35000;
export const LONGPOLL_EXTRA_TIMEOUT_MS = 5000;

export const RECONNECT_MIN_DELAY_MS = 3000;
export const RECONNECT_MAX_DELAY_MS = 60000;

export const ERRCODE_SESSION_EXPIRED = -14;

export const CHANNEL_VERSION = '1.0.0';
export const ILINK_APP_ID = 'bot';
export const ILINK_APP_CLIENT_VERSION = '131329';

/**
 * Generate random X-WECHAT-UIN header value.
 * A random uint32 converted to string, then base64-encoded.
 */
export function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

/**
 * Build standard headers for iLink API requests.
 */
export function buildWeChatHeaders(botToken: string, uin: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    Authorization: `Bearer ${botToken}`,
    'X-WECHAT-UIN': uin,
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': ILINK_APP_CLIENT_VERSION,
  };
}

/**
 * Build standard base_info payload block for iLink API.
 */
export function buildBaseInfo(): Record<string, string> {
  return {
    channel_version: CHANNEL_VERSION,
    bot_agent: `Enkeep/${CHANNEL_VERSION}`,
  };
}

/**
 * Inspect configured proxy environment variables.
 */
export function configuredWeChatHttpProxy(): string | undefined {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy
  );
}

function errorChain(error: unknown): Array<Record<string, unknown>> {
  const chain: Array<Record<string, unknown>> = [];
  let current = error;
  const seen = new Set<unknown>();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    chain.push(current as Record<string, unknown>);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

/**
 * Classify low-level network and API errors into normalized connection error codes.
 */
export function classifyWeChatConnectionError(
  error: unknown
): WeChatConnectionErrorCode {
  const chain = errorChain(error);
  const codes = chain.map((item) => String(item.code ?? '')).filter(Boolean);
  const message = chain
    .map((item) => String(item.message ?? ''))
    .join(' ')
    .toLowerCase();

  if (
    codes.includes('UND_ERR_CONNECT_TIMEOUT') ||
    codes.includes('ETIMEDOUT') ||
    message.includes('connect timeout')
  ) {
    return 'connect_timeout';
  }
  if (
    codes.includes('WECHAT_REQUEST_TIMEOUT') ||
    codes.includes('ABORT_ERR') ||
    message.includes('timed out') ||
    message.includes('abort')
  ) {
    return 'request_timeout';
  }
  if (
    codes.some((code) =>
      ['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'].includes(code)
    ) ||
    message.includes('socket disconnected') ||
    message.includes('connection reset') ||
    message.includes('econnreset')
  ) {
    return 'connection_reset';
  }
  if (
    codes.some((code) => code.startsWith('ERR_TLS')) ||
    message.includes('tls') ||
    message.includes('certificate')
  ) {
    return 'tls_error';
  }
  if (
    codes.includes('WECHAT_API_ERROR') ||
    message.includes('wechat getupdates error')
  ) {
    return 'api_error';
  }
  if (error instanceof TypeError && message.includes('fetch failed')) {
    return 'network_error';
  }
  return 'unknown';
}

/**
 * User-facing localized connection error message.
 */
export function weChatConnectionErrorMessage(
  code: WeChatConnectionErrorCode
): string {
  switch (code) {
    case 'connect_timeout':
      return '连接微信服务超时，正在自动重试';
    case 'request_timeout':
      return '微信长轮询暂时无响应，正在自动重试';
    case 'connection_reset':
      return '微信连接在 TLS 建立前被中断，正在自动重试';
    case 'tls_error':
      return '微信服务 TLS 连接失败，正在自动重试';
    case 'api_error':
      return '微信服务返回异常，正在自动重试';
    case 'network_error':
      return '暂时无法访问微信服务，正在自动重试';
    default:
      return '微信连接暂时异常，正在自动重试';
  }
}

/**
 * Calculate retry delay with ±20% jitter.
 */
export function jitteredWeChatRetryDelay(
  baseDelayMs: number,
  random: () => number = Math.random
): number {
  const factor = 0.8 + Math.max(0, Math.min(1, random())) * 0.4;
  return Math.max(1, Math.round(baseDelayMs * factor));
}

/**
 * Adaptively split text into <= limit chunks by paragraphs, sentences, or hard boundary.
 */
export function splitTextChunks(text: string, limit = MSG_SPLIT_LIMIT): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    let splitIdx = remaining.lastIndexOf('\n\n', limit);
    if (splitIdx < limit * 0.3) {
      splitIdx = remaining.lastIndexOf('\n', limit);
    }
    if (splitIdx < limit * 0.3) {
      const cnPeriod = remaining.lastIndexOf('。', limit);
      if (cnPeriod !== -1 && cnPeriod >= limit * 0.3) {
        splitIdx = cnPeriod + 1;
      }
    }
    if (splitIdx < limit * 0.3) {
      const cnSemicolon = remaining.lastIndexOf('；', limit);
      if (cnSemicolon !== -1 && cnSemicolon >= limit * 0.3) {
        splitIdx = cnSemicolon + 1;
      }
    }
    if (splitIdx < limit * 0.3) {
      splitIdx = remaining.lastIndexOf(' ', limit);
    }
    if (splitIdx < limit * 0.3) {
      splitIdx = limit;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks;
}

/**
 * Safely parse WeChat API HTTP response.
 */
export async function parseWeChatApiResponse<T>(
  response: Response,
  endpoint: string
): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `WeChat API ${endpoint} HTTP ${response.status}: ${text.slice(0, 200)}`
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `WeChat API ${endpoint} invalid JSON: ${text.slice(0, 200)}`
    );
  }
}
