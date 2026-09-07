/**
 * Browser Service Package Type Contracts
 *
 * @module @enkeep/platform-service-browser/types
 */

export type {
  BrowserSessionKey,
  BrowserOpenOptions,
  BrowserOpenResult,
  BrowserSnapshotNode,
  BrowserSnapshotOptions,
  BrowserSnapshotResult,
  BrowserInteractAction,
  BrowserInteractOptions,
  BrowserInteractResult,
  BrowserScreenshotDimensions,
  BrowserScreenshotOptions,
  BrowserScreenshotResult,
  BrowserCloseOptions,
  BrowserCloseResult,
  BrowserServiceHealth,
  BrowserService,
} from '@enkeep/platform-core';

/**
 * Configuration options for BrowserService
 */
export interface BrowserServiceOptions {
  /** Explicit allowed hostnames (if provided, only matching hosts are permitted) */
  readonly allowedHosts?: readonly string[];
  /** Allow localhost / 127.0.0.1 exclusively for automated integration tests */
  readonly allowLocalForTesting?: boolean;
  /** Maximum pages per session context (default: 3) */
  readonly maxPagesPerSession?: number;
  /** Maximum concurrent browser contexts globally (default: 10) */
  readonly maxContextsGlobal?: number;
  /** Default navigation timeout in milliseconds (default: 30000) */
  readonly navigationTimeoutMs?: number;
  /** Default action/operation timeout in milliseconds (default: 15000) */
  readonly operationTimeoutMs?: number;
  /** Idle context lease TTL in milliseconds before auto-close (default: 60000) */
  readonly idleTimeoutMs?: number;
  /** Maximum DOM snapshot nodes (default: 1000) */
  readonly maxSnapshotNodes?: number;
  /** Maximum DOM snapshot serialized JSON bytes (default: 262144 / 256KB) */
  readonly maxSnapshotBytes?: number;
  /** Run browser in headless mode (default: true) */
  readonly headless?: boolean;
  /** Execution mode: 'worker' subprocess for crash isolation or 'in-process' (default: 'worker') */
  readonly mode?: 'worker' | 'in-process';
  /** Optional custom Chromium executable path */
  readonly chromiumExecutablePath?: string;
  /**
   * Explicit test-only flag to disable Chromium sandbox (e.g. in restricted CI environments).
   * Invariant: ONLY permitted when NODE_ENV === 'test'. Production constructor rejects this with BROWSER_SECURITY_VIOLATION.
   */
  readonly disableChromiumSandboxForTesting?: boolean;
  /** Whether to block heavy media resources (video, audio, font) to conserve resources (default: true) */
  readonly blockMediaResources?: boolean;
}

/**
 * Internal session context representation
 */
export interface ActiveSessionContext {
  readonly key: string; // serialized session key: `${userId}:${spaceId}:${sessionId}`
  readonly userId: string;
  readonly spaceId: string;
  readonly sessionId: string;
  lastActiveAt: number;
  readonly pageIds: Set<string>;
}

/**
 * Internal active page representation
 */
export interface ActivePageInfo {
  readonly pageId: string;
  readonly sessionKey: string;
  readonly createdAt: number;
  lastActiveAt: number;
  currentUrl: string;
  title: string;
}
