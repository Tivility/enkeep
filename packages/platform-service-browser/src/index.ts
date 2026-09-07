/**
 * Enkeep Platform Service Browser Package
 *
 * Provides isolated, hardened, container-safe browser automation conforming to the
 * Platform Core BrowserService port contract:
 * - Singleton Playwright Chromium process
 * - Incognito BrowserContext per session { userId, spaceId, sessionId }
 * - SSRF guard & DNS rebinding protection on all requests and redirect hops
 * - Deterministic accessibility-like DOM snapshot (e1... refs, max 1000 nodes / 256KB cap)
 * - Safe interactions (click | fill | press | select) by ref ONLY (no arbitrary JS/CSS)
 * - Screenshots with buffer & dimensions
 * - Worker subprocess fault isolation
 * - Strict lifecycle and resource limits
 *
 * @module @enkeep/platform-service-browser
 */

// Types & Interfaces
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
  BrowserServiceOptions,
  ActiveSessionContext,
  ActivePageInfo,
} from './types.js';

// Error Hierarchy
export {
  BrowserErrorCode,
  type BrowserErrorOptions,
  BrowserServiceError,
  isBrowserServiceError,
  sanitizeBrowserError,
} from './errors.js';

// Security Subsystem
export {
  FORBIDDEN_SCHEMES,
  isPrivateIPv4,
  isPrivateIPv6,
  type ValidateUrlOptions,
  validateBrowserTargetUrl,
} from './security/ssrf-guard.js';

export {
  SENSITIVE_QUERY_PARAMS,
  sanitizeUrl,
  getCleanOriginAndPath,
} from './security/url-sanitizer.js';

// Snapshot & Interaction Subsystems
export {
  DEFAULT_MAX_SNAPSHOT_NODES,
  DEFAULT_MAX_SNAPSHOT_BYTES,
  buildSnapshotTextSummary,
  takePageSnapshot,
} from './snapshot/dom-snapshot.js';

export {
  DEFAULT_ACTION_TIMEOUT_MS,
  isValidRef,
  executePageAction,
} from './interact/action-executor.js';

// Pool & Context Manager
export {
  DEFAULT_MAX_PAGES_PER_SESSION,
  DEFAULT_MAX_CONTEXTS_GLOBAL,
  DEFAULT_NAVIGATION_TIMEOUT_MS,
  DEFAULT_OPERATION_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  serializeSessionKey,
  BrowserContextManager,
} from './pool/context-manager.js';

// Transport & Client
export { BrowserWorkerClient } from './transport/worker-client.js';

// Main Service & Factory
export {
  EnkeepBrowserService,
  createBrowserService,
} from './service.js';
