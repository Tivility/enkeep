/**
 * Enkeep Browser Service Implementation
 *
 * Provides a unified facade for browser execution conforming to the BrowserService port contract.
 * Supports worker subprocess isolation (default) for fault resilience and in-process execution.
 *
 * @module @enkeep/platform-service-browser/service
 */

import type {
  BrowserService,
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
} from '@enkeep/platform-core';
import type { BrowserServiceOptions } from './types.js';
import { BrowserErrorCode, BrowserServiceError } from './errors.js';
import { BrowserContextManager } from './pool/context-manager.js';
import { BrowserWorkerClient } from './transport/worker-client.js';

export class EnkeepBrowserService implements BrowserService {
  private readonly options: BrowserServiceOptions;
  private readonly inProcessManager: BrowserContextManager | null = null;
  private readonly workerClient: BrowserWorkerClient | null = null;
  private isDisposed = false;
  private isInitialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(options: BrowserServiceOptions = {}) {
    this.options = options;
    const mode = options.mode ?? 'worker';

    if (mode === 'in-process') {
      this.inProcessManager = new BrowserContextManager(options);
    } else {
      this.workerClient = new BrowserWorkerClient(options);
    }
  }

  /**
   * Initializes the browser service and underlying backend. Idempotent.
   */
  async initialize(): Promise<void> {
    if (this.isDisposed) {
      throw new BrowserServiceError('BrowserService is disposed', {
        code: BrowserErrorCode.BROWSER_UNAVAILABLE,
      });
    }
    if (this.isInitialized) {
      return;
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      if (this.inProcessManager) {
        await this.inProcessManager.initialize();
      } else if (this.workerClient) {
        await this.workerClient.ensureWorker();
      }
      this.isInitialized = true;
    })();

    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  async open(options: BrowserOpenOptions): Promise<BrowserOpenResult> {
    if (this.isDisposed) {
      throw new BrowserServiceError('BrowserService is disposed', {
        code: BrowserErrorCode.BROWSER_UNAVAILABLE,
      });
    }
    if (this.inProcessManager) {
      return this.inProcessManager.open(options);
    }
    return this.workerClient!.open(options);
  }

  async snapshot(options: BrowserSnapshotOptions): Promise<BrowserSnapshotResult> {
    if (this.isDisposed) {
      throw new BrowserServiceError('BrowserService is disposed', {
        code: BrowserErrorCode.BROWSER_UNAVAILABLE,
      });
    }
    if (this.inProcessManager) {
      return this.inProcessManager.snapshot(options);
    }
    return this.workerClient!.snapshot(options);
  }

  async interact(options: BrowserInteractOptions): Promise<BrowserInteractResult> {
    if (this.isDisposed) {
      throw new BrowserServiceError('BrowserService is disposed', {
        code: BrowserErrorCode.BROWSER_UNAVAILABLE,
      });
    }
    if (this.inProcessManager) {
      return this.inProcessManager.interact(options);
    }
    return this.workerClient!.interact(options);
  }

  async screenshot(options: BrowserScreenshotOptions): Promise<BrowserScreenshotResult> {
    if (this.isDisposed) {
      throw new BrowserServiceError('BrowserService is disposed', {
        code: BrowserErrorCode.BROWSER_UNAVAILABLE,
      });
    }
    if (this.inProcessManager) {
      return this.inProcessManager.screenshot(options);
    }
    return this.workerClient!.screenshot(options);
  }

  async close(options?: BrowserCloseOptions): Promise<BrowserCloseResult> {
    if (this.isDisposed) {
      throw new BrowserServiceError('BrowserService is disposed', {
        code: BrowserErrorCode.BROWSER_UNAVAILABLE,
      });
    }
    if (this.inProcessManager) {
      return this.inProcessManager.close(options);
    }
    return this.workerClient!.close(options);
  }

  async checkHealth(): Promise<BrowserServiceHealth> {
    if (this.isDisposed) {
      return {
        status: 'unhealthy',
        activeContexts: 0,
        activePages: 0,
        uptimeSeconds: 0,
      };
    }
    if (this.inProcessManager) {
      return this.inProcessManager.checkHealth();
    }
    return this.workerClient!.checkHealth();
  }

  async dispose(): Promise<void> {
    if (this.isDisposed) return;
    this.isDisposed = true;

    if (this.inProcessManager) {
      await this.inProcessManager.dispose();
    }
    if (this.workerClient) {
      await this.workerClient.dispose();
    }
  }
}

/**
 * Factory function for creating a configured BrowserService instance.
 */
export function createBrowserService(options: BrowserServiceOptions = {}): BrowserService {
  return new EnkeepBrowserService(options);
}
