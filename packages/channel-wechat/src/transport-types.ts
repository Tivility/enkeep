/**
 * WeChat iLink Transport Types
 *
 * @module @enkeep/channel-wechat/transport-types
 */

import type { WeChatParsedMessage, WeChatTransport } from './types.js';

export interface WeChatTransportConfig {
  readonly botToken: string;
  readonly ilinkBotId: string;
  readonly baseUrl?: string;          // Default: https://ilinkai.weixin.qq.com
  readonly cdnBaseUrl?: string;       // Default: https://novac2c.cdn.weixin.qq.com/c2c
  readonly initialCursor?: string;    // Initial getUpdatesBuf cursor
  readonly bypassProxy?: boolean;
  readonly logContext?: { readonly accountId?: string; readonly userId?: string };
}

export type WeChatConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'expired'         // -14 session expired, no auto retry, requires re-auth/scan
  | 'disconnected';

export type WeChatConnectionErrorCode =
  | 'connect_timeout'
  | 'request_timeout'
  | 'connection_reset'
  | 'tls_error'
  | 'api_error'
  | 'network_error'
  | 'unknown';

export interface WeChatConnectionState {
  readonly status: WeChatConnectionStatus;
  readonly error?: string;
  readonly errorCode?: WeChatConnectionErrorCode;
  readonly consecutiveFailures?: number;
  readonly nextRetryMs?: number;
  readonly lastConnectedAt?: string;
}

export interface CredentialedWeChatTransport extends WeChatTransport {
  readonly running: boolean;
  readonly cursor: string;
  onStateChange(handler: (state: WeChatConnectionState) => void): void;
  removeStateChangeHandler(handler: (state: WeChatConnectionState) => void): void;
  onCursorCommit(handler: (cursor: string) => Promise<void> | void): void;
  removeCursorCommitHandler(handler: (cursor: string) => Promise<void> | void): void;
  onMessage(handler: (msg: WeChatParsedMessage) => Promise<void>): void;
  removeMessageHandler(handler: (msg: WeChatParsedMessage) => Promise<void>): void;
  sendTyping(toUserId: string, contextToken: string, isTyping: boolean): Promise<void>;
  sendImage(
    toUserId: string,
    contextToken: string,
    imageBuffer: Buffer,
    fileName?: string
  ): Promise<{ success: boolean; error?: string; messageId?: string }>;
  sendFile(
    toUserId: string,
    contextToken: string,
    fileBuffer: Buffer,
    fileName?: string
  ): Promise<{ success: boolean; error?: string; messageId?: string }>;
}

export interface WeChatTransportDeps {
  readonly fetch?: typeof fetch;
  readonly random?: () => number;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly logger?: {
    debug?: (obj: unknown, msg?: string) => void;
    info?: (obj: unknown, msg?: string) => void;
    warn?: (obj: unknown, msg?: string) => void;
    error?: (obj: unknown, msg?: string) => void;
  };
}
