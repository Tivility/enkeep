/**
 * Browser Worker JSON-RPC Protocol Definitions
 *
 * @module @enkeep/platform-service-browser/worker/rpc-protocol
 */

import type {
  BrowserOpenOptions,
  BrowserOpenResult,
  BrowserSnapshotOptions,
  BrowserSnapshotResult,
  BrowserInteractOptions,
  BrowserInteractResult,
  BrowserScreenshotOptions,
  BrowserScreenshotResult,
  BrowserCloseOptions,
  BrowserCloseResult,
  BrowserServiceHealth,
  BrowserServiceOptions,
} from '../types.js';
import type { BrowserErrorCode } from '../errors.js';

export interface RpcErrorPayload {
  message: string;
  code: BrowserErrorCode;
  details?: Record<string, unknown>;
  retryable?: boolean;
}

export type RpcMethod =
  | 'init'
  | 'open'
  | 'snapshot'
  | 'interact'
  | 'screenshot'
  | 'close'
  | 'health'
  | 'shutdown';

export interface RpcRequestMap {
  init: BrowserServiceOptions;
  open: BrowserOpenOptions;
  snapshot: BrowserSnapshotOptions;
  interact: BrowserInteractOptions;
  screenshot: BrowserScreenshotOptions;
  close: BrowserCloseOptions;
  health: Record<string, never>;
  shutdown: Record<string, never>;
}

export interface RpcResponseMap {
  init: { ok: boolean };
  open: BrowserOpenResult;
  snapshot: BrowserSnapshotResult;
  interact: BrowserInteractResult;
  screenshot: {
    pageId: string;
    mimeType: 'image/png';
    dimensions: { width: number; height: number };
    base64: string;
  };
  close: BrowserCloseResult;
  health: BrowserServiceHealth;
  shutdown: { ok: boolean };
}

export interface RpcRequest<M extends RpcMethod = RpcMethod> {
  id: string;
  method: M;
  params: RpcRequestMap[M];
}

export interface RpcResponse<M extends RpcMethod = RpcMethod> {
  id: string;
  result?: RpcResponseMap[M];
  error?: RpcErrorPayload;
}
