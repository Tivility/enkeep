/**
 * Type definitions for @enkeep/dsh-tool-browser
 *
 * @module @enkeep/dsh-tool-browser/types
 */

import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';

export type BrowserInteractAction = 'click' | 'fill' | 'press' | 'select';

export interface BrowserOpenArgs {
  readonly url: string;
}

export interface BrowserOpenResult {
  readonly success: boolean;
  readonly pageId: string;
  readonly url: string;
  readonly title?: string;
  readonly message?: string;
}

export interface BrowserSnapshotArgs {
  readonly pageId: string;
}

export interface BrowserSnapshotResult {
  readonly success: boolean;
  readonly pageId: string;
  readonly url: string;
  readonly title?: string;
  readonly snapshot: string;
  readonly textSummary?: string;
  readonly interactiveElementsCount?: number;
}

export interface BrowserInteractArgs {
  readonly pageId: string;
  readonly action: BrowserInteractAction;
  readonly ref: string;
  readonly value?: string;
}

export interface BrowserInteractResult {
  readonly success: boolean;
  readonly pageId: string;
  readonly action: BrowserInteractAction;
  readonly ref: string;
  readonly url?: string;
  readonly message?: string;
}

export interface BrowserScreenshotArgs {
  readonly pageId: string;
  readonly fullPage?: boolean;
}

export interface BrowserScreenshotResult {
  readonly success: boolean;
  readonly pageId: string;
  readonly path: string;
  readonly downloadUrl: string;
  readonly width?: number;
  readonly height?: number;
  readonly sizeBytes?: number;
}

export interface BrowserCloseArgs {
  readonly pageId: string;
}

export interface BrowserCloseResult {
  readonly success: boolean;
  readonly pageId: string;
  readonly closed: boolean;
  readonly closedPages?: number;
}

/**
 * Caller scope resolved from initiator agent & session (never model args).
 */
export interface BrowserCallerScope {
  readonly userId: string;
  readonly spaceId: string;
  readonly sessionId: string;
  readonly agent?: Agent;
}

/**
 * Minimal platform client interface needed by browser tools.
 */
export interface BrowserPlatformClientService {
  request?<T = unknown>(
    path: string,
    options?: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string | undefined>;
      query?: Record<string, string | number | boolean | undefined | null>;
      signal?: AbortSignal;
      timeoutMs?: number;
      maxRetries?: number;
      [key: string]: unknown;
    }
  ): Promise<{ data: T; status: number; headers?: Record<string, unknown> }>;
}

export interface BrowserPluginConfig {
  /**
   * Maximum allowed snapshot length in characters before truncation / bounding.
   * Default: 65536 (64 KB).
   */
  readonly maxSnapshotLength?: number;
  /**
   * Default timeout in milliseconds for browser RPC operations.
   * Default: 30000 (30 seconds).
   */
  readonly defaultTimeoutMs?: number;
  /**
   * Allowed URL protocols. Default: ['http:', 'https:'].
   */
  readonly allowedProtocols?: string[];
  /**
   * Whether to require approval for browser navigation (open).
   * Default: false (GET navigation is low-risk, interact is high-risk).
   */
  readonly requireApprovalOnOpen?: boolean;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    platformClient?: any;
    browserToolsOperational?: boolean;
  }
}
