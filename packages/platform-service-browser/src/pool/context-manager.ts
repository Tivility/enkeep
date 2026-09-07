/**
 * Hardened Browser and Context Pool Manager
 *
 * Manages Chromium browser singleton and isolated incognito BrowserContexts per session key.
 *
 * Enforces:
 * - Playwright Browser singleton
 * - Incognito BrowserContext per session { userId, spaceId, sessionId }
 * - Zero cross-session state leakage (cookies, storage, cache, permissions)
 * - Route interception on all requests and redirect hops (SSRF protection)
 * - Concurrency limits: Max 3 pages/session, Max 10 contexts globally
 * - Timeouts: Navigation 30s, Action 15s, Idle context TTL 60s
 * - Strict lifecycle and cleanup
 *
 * @module @enkeep/platform-service-browser/pool/context-manager
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { randomUUID } from 'node:crypto';
import type {
  BrowserSessionKey,
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
import { BrowserErrorCode, BrowserServiceError } from '../errors.js';
import { validateBrowserTargetUrl } from '../security/ssrf-guard.js';
import { sanitizeUrl } from '../security/url-sanitizer.js';
import { takePageSnapshot } from '../snapshot/dom-snapshot.js';
import { executePageAction } from '../interact/action-executor.js';

export const DEFAULT_MAX_PAGES_PER_SESSION = 3;
export const DEFAULT_MAX_CONTEXTS_GLOBAL = 10;
export const DEFAULT_NAVIGATION_TIMEOUT_MS = 30000;
export const DEFAULT_OPERATION_TIMEOUT_MS = 15000;
export const DEFAULT_IDLE_TIMEOUT_MS = 60000;

interface ManagedPage {
  readonly pageId: string;
  readonly sessionKeyStr: string;
  readonly page: Page;
  createdAt: number;
  lastActiveAt: number;
}

interface ManagedContext {
  readonly sessionKeyStr: string;
  readonly sessionKey: BrowserSessionKey;
  readonly context: BrowserContext;
  createdAt: number;
  lastActiveAt: number;
  readonly pages: Map<string, ManagedPage>;
}

export function serializeSessionKey(key: BrowserSessionKey): string {
  if (!key.userId || !key.spaceId || !key.sessionId) {
    throw new BrowserServiceError(`Invalid session key: missing userId, spaceId, or sessionId.`, {
      code: BrowserErrorCode.BROWSER_BAD_REQUEST,
      details: { key },
    });
  }
  return `${key.userId}:${key.spaceId}:${key.sessionId}`;
}

export class BrowserContextManager {
  private readonly options: BrowserServiceOptions;
  private browser: Browser | null = null;
  private readonly contexts = new Map<string, ManagedContext>();
  private readonly pageToContext = new Map<string, string>();
  private readonly startedAt = Date.now();
  private idleSweepTimer: NodeJS.Timeout | null = null;
  private isDisposing = false;

  constructor(options: BrowserServiceOptions = {}) {
    // Validate disableChromiumSandboxForTesting: only permitted under test environment
    if (options.disableChromiumSandboxForTesting) {
      const isTestEnv = process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);
      if (!isTestEnv) {
        throw new BrowserServiceError(
          'disableChromiumSandboxForTesting is strictly forbidden in non-test environments.',
          {
            code: BrowserErrorCode.BROWSER_SECURITY_VIOLATION,
          },
        );
      }
    }

    // Invariant: Do not run browser service directly as root in production
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      const isTestEnv = process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);
      if (!isTestEnv) {
        throw new BrowserServiceError(
          'Running BrowserService directly as root (UID 0) is forbidden for security.',
          {
            code: BrowserErrorCode.BROWSER_SECURITY_VIOLATION,
          },
        );
      }
    }

    this.options = options;
  }

  /**
   * Initializes the browser manager and starts background idle context sweeps.
   */
  async initialize(): Promise<void> {
    await this.ensureBrowser();

    // Start background idle context reaper
    const sweepInterval = Math.max(5000, Math.floor((this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS) / 2));
    this.idleSweepTimer = setInterval(() => {
      this.sweepIdleContexts().catch(() => {
        // Silently ignore sweep errors in background loop
      });
    }, sweepInterval);
  }

  /**
   * Ensures the singleton Playwright Chromium browser is launched and connected.
   * Uses default Chromium sandbox unless explicit test flag is active.
   */
  async ensureBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) {
      return this.browser;
    }

    const launchArgs = [
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-translate',
      '--hide-scrollbars',
      '--metrics-recording-only',
      '--mute-audio',
    ];

    // Only add no-sandbox args if explicit test flag is present and validated
    if (this.options.disableChromiumSandboxForTesting) {
      launchArgs.push('--no-sandbox', '--disable-setuid-sandbox');
    }

    try {
      this.browser = await chromium.launch({
        headless: this.options.headless ?? true,
        executablePath: this.options.chromiumExecutablePath,
        args: launchArgs,
      });

      this.browser.on('disconnected', () => {
        this.browser = null;
      });

      return this.browser;
    } catch (err) {
      throw new BrowserServiceError(`Failed to launch Chromium browser: ${err instanceof Error ? err.message : String(err)}`, {
        code: BrowserErrorCode.BROWSER_UNAVAILABLE,
        cause: err,
      });
    }
  }

  /**
   * Acquires or creates an isolated incognito context for the given session key.
   */
  private async getOrCreateContext(sessionKey: BrowserSessionKey): Promise<ManagedContext> {
    const keyStr = serializeSessionKey(sessionKey);
    const existing = this.contexts.get(keyStr);
    if (existing) {
      existing.lastActiveAt = Date.now();
      return existing;
    }

    const maxContexts = this.options.maxContextsGlobal ?? DEFAULT_MAX_CONTEXTS_GLOBAL;

    // Enforce global context limit
    if (this.contexts.size >= maxContexts) {
      // Attempt to evict oldest idle context
      const evicted = await this.evictOldestIdleContext();
      if (!evicted && this.contexts.size >= maxContexts) {
        throw new BrowserServiceError(
          `Maximum concurrent browser contexts limit reached (${maxContexts}). Close unused sessions.`,
          {
            code: BrowserErrorCode.BROWSER_RESOURCE_LIMIT,
            details: { maxContexts, activeContexts: this.contexts.size },
          },
        );
      }
    }

    const browser = await this.ensureBrowser();

    // Create hardened incognito context
    const context = await browser.newContext({
      acceptDownloads: false,
      permissions: [],
      serviceWorkers: 'block',
      geolocation: undefined,
      ignoreHTTPSErrors: false,
      viewport: { width: 1280, height: 720 },
    });

    // Install SSRF route guard on all context requests & redirects
    await context.route('**/*', async (route) => {
      const request = route.request();
      const reqUrl = request.url();
      const resourceType = request.resourceType();

      // Block dangerous media if configured
      if (this.options.blockMediaResources && (resourceType === 'media' || resourceType === 'websocket')) {
        await route.abort('blockedbyclient');
        return;
      }

      try {
        await validateBrowserTargetUrl(reqUrl, {
          allowLocalForTesting: this.options.allowLocalForTesting,
          allowedHosts: this.options.allowedHosts,
        });
        await route.continue();
      } catch {
        await route.abort('blockedbyclient');
      }
    });

    const managed: ManagedContext = {
      sessionKeyStr: keyStr,
      sessionKey,
      context,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pages: new Map(),
    };

    this.contexts.set(keyStr, managed);
    return managed;
  }

  /**
   * Opens a URL in a new page within the session's isolated context.
   */
  async open(options: BrowserOpenOptions): Promise<BrowserOpenResult> {
    if (this.isDisposing) {
      throw new BrowserServiceError('BrowserService is shutting down.', {
        code: BrowserErrorCode.BROWSER_UNAVAILABLE,
      });
    }

    // SSRF Preflight validation
    await validateBrowserTargetUrl(options.url, {
      allowLocalForTesting: this.options.allowLocalForTesting,
      allowedHosts: this.options.allowedHosts,
    });

    const managedCtx = await this.getOrCreateContext(options.sessionKey);
    const maxPages = this.options.maxPagesPerSession ?? DEFAULT_MAX_PAGES_PER_SESSION;

    if (managedCtx.pages.size >= maxPages) {
      throw new BrowserServiceError(
        `Maximum pages per session reached (${maxPages}). Close existing pages before opening new ones.`,
        {
          code: BrowserErrorCode.BROWSER_RESOURCE_LIMIT,
          details: { sessionKey: options.sessionKey, maxPages, activePages: managedCtx.pages.size },
        },
      );
    }

    const page = await managedCtx.context.newPage();
    const pageId = `page_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

    const navTimeout = options.timeoutMs ?? this.options.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
    page.setDefaultNavigationTimeout(navTimeout);
    page.setDefaultTimeout(this.options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS);

    const managedPage: ManagedPage = {
      pageId,
      sessionKeyStr: managedCtx.sessionKeyStr,
      page,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };

    managedCtx.pages.set(pageId, managedPage);
    this.pageToContext.set(pageId, managedCtx.sessionKeyStr);

    page.on('close', () => {
      managedCtx.pages.delete(pageId);
      this.pageToContext.delete(pageId);
      if (managedCtx.pages.size === 0 && this.contexts.has(managedCtx.sessionKeyStr)) {
        this.contexts.delete(managedCtx.sessionKeyStr);
        managedCtx.context.close().catch(() => {});
      }
    });

    try {
      const response = await page.goto(options.url, {
        timeout: navTimeout,
        waitUntil: 'domcontentloaded',
      });

      // Validate all redirect hops to enforce SSRF policy on every hop
      let hopReq = response ? response.request() : null;
      while (hopReq) {
        await validateBrowserTargetUrl(hopReq.url(), {
          allowLocalForTesting: this.options.allowLocalForTesting,
          allowedHosts: this.options.allowedHosts,
        });
        hopReq = hopReq.redirectedFrom();
      }

      // Validate final page URL
      await validateBrowserTargetUrl(page.url(), {
        allowLocalForTesting: this.options.allowLocalForTesting,
        allowedHosts: this.options.allowedHosts,
      });

      const title = await page.title();
      const currentUrl = sanitizeUrl(page.url());
      managedPage.lastActiveAt = Date.now();
      managedCtx.lastActiveAt = Date.now();

      return {
        pageId,
        title: title || '',
        url: currentUrl,
      };
    } catch (err) {
      // Clean up page on failed navigation
      try {
        await page.close().catch(() => {});
      } finally {
        managedCtx.pages.delete(pageId);
        this.pageToContext.delete(pageId);
        if (managedCtx.pages.size === 0 && this.contexts.has(managedCtx.sessionKeyStr)) {
          this.contexts.delete(managedCtx.sessionKeyStr);
          await managedCtx.context.close().catch(() => {});
        }
      }

      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('Timeout') || errMsg.includes('timeout')) {
        throw new BrowserServiceError(`Navigation to "${options.url}" timed out after ${navTimeout}ms`, {
          code: BrowserErrorCode.BROWSER_TIMEOUT,
          cause: err,
          details: { pageId, url: options.url, timeoutMs: navTimeout },
        });
      }

      if (errMsg.includes('BLOCKED') || errMsg.includes('blockedbyclient')) {
        throw new BrowserServiceError(`Navigation to "${options.url}" was blocked by security policy`, {
          code: BrowserErrorCode.BROWSER_SSRF_BLOCKED,
          cause: err,
          details: { pageId, url: options.url },
        });
      }

      throw new BrowserServiceError(`Failed to open page "${options.url}": ${errMsg}`, {
        code: BrowserErrorCode.BROWSER_ACTION_FAILED,
        cause: err,
        details: { pageId, url: options.url },
      });
    }
  }

  /**
   * Takes a deterministic DOM snapshot of the specified page.
   */
  async snapshot(options: BrowserSnapshotOptions): Promise<BrowserSnapshotResult> {
    const managedPage = this.getManagedPage(options.pageId, options.sessionKey);
    managedPage.lastActiveAt = Date.now();

    const managedCtx = this.contexts.get(managedPage.sessionKeyStr);
    if (managedCtx) {
      managedCtx.lastActiveAt = Date.now();
    }

    return takePageSnapshot(managedPage.page, {
      sessionKey: options.sessionKey,
      pageId: options.pageId,
      maxNodes: options.maxNodes ?? this.options.maxSnapshotNodes,
      maxBytes: options.maxBytes ?? this.options.maxSnapshotBytes,
    });
  }

  /**
   * Executes a safe interaction on the page by ref.
   */
  async interact(options: BrowserInteractOptions): Promise<BrowserInteractResult> {
    const managedPage = this.getManagedPage(options.pageId, options.sessionKey);
    managedPage.lastActiveAt = Date.now();

    const managedCtx = this.contexts.get(managedPage.sessionKeyStr);
    if (managedCtx) {
      managedCtx.lastActiveAt = Date.now();
    }

    return executePageAction(
      managedPage.page,
      {
        ...options,
        timeoutMs: options.timeoutMs ?? this.options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
      },
      this.options,
    );
  }

  /**
   * Captures a screenshot of the specified page.
   */
  async screenshot(options: BrowserScreenshotOptions): Promise<BrowserScreenshotResult> {
    const managedPage = this.getManagedPage(options.pageId, options.sessionKey);
    managedPage.lastActiveAt = Date.now();

    const managedCtx = this.contexts.get(managedPage.sessionKeyStr);
    if (managedCtx) {
      managedCtx.lastActiveAt = Date.now();
    }

    const timeout = options.timeoutMs ?? this.options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;

    try {
      const buffer = await managedPage.page.screenshot({
        fullPage: options.fullPage ?? false,
        type: 'png',
        timeout,
      });

      const viewport = managedPage.page.viewportSize() ?? { width: 1280, height: 720 };

      return {
        pageId: options.pageId,
        mimeType: 'image/png',
        dimensions: {
          width: viewport.width,
          height: viewport.height,
        },
        buffer,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('Timeout') || errMsg.includes('timeout')) {
        throw new BrowserServiceError(`Screenshot timed out after ${timeout}ms`, {
          code: BrowserErrorCode.BROWSER_TIMEOUT,
          cause: err,
          details: { pageId: options.pageId, timeoutMs: timeout },
        });
      }

      throw new BrowserServiceError(`Screenshot capture failed: ${errMsg}`, {
        code: BrowserErrorCode.BROWSER_ACTION_FAILED,
        cause: err,
        details: { pageId: options.pageId },
      });
    }
  }

  /**
   * Closes pages, session contexts, or all resources.
   */
  async close(options: BrowserCloseOptions = {}): Promise<BrowserCloseResult> {
    let closedPages = 0;
    let closedContexts = 0;

    if (options.all) {
      for (const [keyStr, managedCtx] of Array.from(this.contexts.entries())) {
        closedPages += managedCtx.pages.size;
        this.contexts.delete(keyStr);
        try {
          await managedCtx.context.close().catch(() => {});
        } finally {
          closedContexts++;
        }
      }
      this.pageToContext.clear();
      return { closedPages, closedContexts };
    }

    if (options.pageId) {
      if (!options.sessionKey) {
        throw new BrowserServiceError(`Page "${options.pageId}" not found or has been closed.`, {
          code: BrowserErrorCode.BROWSER_PAGE_NOT_FOUND,
          details: { pageId: options.pageId },
        });
      }

      // Validates ownership: throws generic BROWSER_PAGE_NOT_FOUND if wrong sessionKey or not found (no oracle)
      const managedPage = this.getManagedPage(options.pageId, options.sessionKey);
      const callerKeyStr = serializeSessionKey(options.sessionKey);
      const managedCtx = this.contexts.get(callerKeyStr);

      try {
        await managedPage.page.close().catch(() => {});
      } finally {
        if (managedCtx) {
          managedCtx.pages.delete(options.pageId);
        }
        this.pageToContext.delete(options.pageId);
        closedPages++;
      }

      // If owning context has no pages left, immediately close context and commit state removal
      if (managedCtx && managedCtx.pages.size === 0) {
        this.contexts.delete(callerKeyStr);
        try {
          await managedCtx.context.close().catch(() => {});
        } finally {
          closedContexts++;
        }
      }

      return { closedPages, closedContexts };
    }

    if (options.sessionKey) {
      const keyStr = serializeSessionKey(options.sessionKey);
      const managedCtx = this.contexts.get(keyStr);
      if (managedCtx) {
        closedPages += managedCtx.pages.size;
        for (const pageId of managedCtx.pages.keys()) {
          this.pageToContext.delete(pageId);
        }
        this.contexts.delete(keyStr);
        try {
          await managedCtx.context.close().catch(() => {});
        } finally {
          closedContexts++;
        }
      }
      return { closedPages, closedContexts };
    }

    return { closedPages: 0, closedContexts: 0 };
  }

  /**
   * Checks the health and statistics of the browser manager.
   */
  async checkHealth(): Promise<BrowserServiceHealth> {
    const isConnected = this.browser !== null && this.browser.isConnected();
    let totalPages = 0;
    for (const ctx of this.contexts.values()) {
      totalPages += ctx.pages.size;
    }

    return {
      status: isConnected ? 'healthy' : 'degraded',
      activeContexts: this.contexts.size,
      activePages: totalPages,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  /**
   * Periodically reaps contexts that have exceeded their idle lease TTL.
   */
  async sweepIdleContexts(): Promise<number> {
    const ttl = this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const now = Date.now();
    let swept = 0;

    for (const [keyStr, managedCtx] of Array.from(this.contexts.entries())) {
      if (now - managedCtx.lastActiveAt > ttl) {
        for (const pageId of managedCtx.pages.keys()) {
          this.pageToContext.delete(pageId);
        }
        this.contexts.delete(keyStr);
        await managedCtx.context.close().catch(() => {});
        swept++;
      }
    }

    return swept;
  }

  /**
   * Evicts the oldest idle context to make room for a new one.
   */
  private async evictOldestIdleContext(): Promise<boolean> {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [keyStr, ctx] of this.contexts.entries()) {
      if (ctx.lastActiveAt < oldestTime) {
        oldestTime = ctx.lastActiveAt;
        oldestKey = keyStr;
      }
    }

    if (oldestKey) {
      const managedCtx = this.contexts.get(oldestKey);
      if (managedCtx) {
        for (const pageId of managedCtx.pages.keys()) {
          this.pageToContext.delete(pageId);
        }
        this.contexts.delete(oldestKey);
        await managedCtx.context.close().catch(() => {});
        return true;
      }
    }

    return false;
  }

  /**
   * Resolves a managed page by ID and validates ownership against caller sessionKey.
   * If page not found OR if sessionKey does not match owner, throws generic BROWSER_PAGE_NOT_FOUND.
   * Invariant: Never reveals whether the page exists in another session (no existence oracle).
   */
  private getManagedPage(pageId: string, sessionKey: BrowserSessionKey): ManagedPage {
    const callerKeyStr = serializeSessionKey(sessionKey);
    const ownerKeyStr = this.pageToContext.get(pageId);

    // Defense-in-depth: If page not registered OR owner session does not match caller session, fail closed
    if (!ownerKeyStr || ownerKeyStr !== callerKeyStr) {
      throw new BrowserServiceError(`Page "${pageId}" not found or has been closed.`, {
        code: BrowserErrorCode.BROWSER_PAGE_NOT_FOUND,
        details: { pageId },
      });
    }

    const managedCtx = this.contexts.get(ownerKeyStr);
    if (!managedCtx) {
      throw new BrowserServiceError(`Page "${pageId}" not found or has been closed.`, {
        code: BrowserErrorCode.BROWSER_PAGE_NOT_FOUND,
        details: { pageId },
      });
    }

    const managedPage = managedCtx.pages.get(pageId);
    if (!managedPage) {
      throw new BrowserServiceError(`Page "${pageId}" not found or has been closed.`, {
        code: BrowserErrorCode.BROWSER_PAGE_NOT_FOUND,
        details: { pageId },
      });
    }

    return managedPage;
  }

  /**
   * Disposes all resources and terminates the Chromium browser process.
   */
  async dispose(): Promise<void> {
    this.isDisposing = true;
    if (this.idleSweepTimer) {
      clearInterval(this.idleSweepTimer);
      this.idleSweepTimer = null;
    }

    await this.close({ all: true }).catch(() => {});

    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}
