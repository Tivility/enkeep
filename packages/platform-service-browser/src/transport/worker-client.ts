/**
 * Worker Subprocess Transport and Client
 *
 * Spawns and manages the isolated browser worker child process over stdio JSON-RPC.
 * Isolates the Platform process from any potential Chromium native crash or memory crash.
 *
 * @module @enkeep/platform-service-browser/transport/worker-client
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
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
import { BrowserErrorCode, BrowserServiceError } from '../errors.js';
import type { RpcMethod, RpcRequest, RpcResponse, RpcRequestMap, RpcResponseMap } from '../worker/rpc-protocol.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface PendingRequest {
  readonly id: string;
  readonly method: string;
  readonly resolve: (value: any) => void;
  readonly reject: (reason: any) => void;
  readonly timer: NodeJS.Timeout;
}

export class BrowserWorkerClient {
  private readonly options: BrowserServiceOptions;
  private workerProcess: ChildProcess | null = null;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private isDisposed = false;
  private spawnPromise: Promise<void> | null = null;

  constructor(options: BrowserServiceOptions = {}) {
    this.options = options;
  }

  /**
   * Resolves the package root directory.
   */
  private findPackageRoot(): string {
    let current = __dirname;
    while (current !== dirname(current)) {
      if (existsSync(join(current, 'package.json'))) {
        return current;
      }
      current = dirname(current);
    }
    return join(__dirname, '..', '..');
  }

  /**
   * Resolves the worker script path.
   */
  private resolveWorkerPath(): { command: string; args: string[] } {
    const pkgRoot = this.findPackageRoot();
    const distPath = join(pkgRoot, 'dist', 'worker', 'browser-worker.js');

    if (existsSync(distPath)) {
      return { command: process.execPath, args: [distPath] };
    }

    // Fallback in dist structure
    const relativeDist = join(__dirname, '..', 'worker', 'browser-worker.js');
    if (existsSync(relativeDist)) {
      return { command: process.execPath, args: [relativeDist] };
    }

    throw new BrowserServiceError(`Browser worker script not found at "${distPath}". Ensure package is built.`, {
      code: BrowserErrorCode.BROWSER_UNAVAILABLE,
    });
  }

  /**
   * Spawns and initializes the worker child process.
   */
  async ensureWorker(): Promise<ChildProcess> {
    if (this.isDisposed) {
      throw new BrowserServiceError('BrowserWorkerClient is disposed', {
        code: BrowserErrorCode.BROWSER_UNAVAILABLE,
      });
    }

    if (this.workerProcess && !this.workerProcess.killed && this.workerProcess.exitCode === null) {
      return this.workerProcess;
    }

    if (this.spawnPromise) {
      await this.spawnPromise;
      if (this.workerProcess && !this.workerProcess.killed && this.workerProcess.exitCode === null) {
        return this.workerProcess;
      }
    }

    this.spawnPromise = (async () => {
      const { command, args } = this.resolveWorkerPath();

      const child = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'inherit'],
        env: {
          ...process.env,
          NODE_ENV: process.env.NODE_ENV || 'production',
        },
      });

      this.workerProcess = child;

      const rl = readline.createInterface({
        input: child.stdout!,
        terminal: false,
      });

      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        try {
          const response = JSON.parse(trimmed) as RpcResponse;
          this.handleResponse(response);
        } catch {
          // Ignore malformed output
        }
      });

      child.on('error', (err) => {
        this.handleProcessCrash(err);
      });

      child.on('exit', (code, signal) => {
        this.handleProcessCrash(new Error(`Worker exited with code ${code}, signal ${signal}`));
      });

      // Send initialization payload
      await this.sendRawRequest('init', this.options, 15000);
    })();

    try {
      await this.spawnPromise;
      return this.workerProcess!;
    } finally {
      this.spawnPromise = null;
    }
  }

  /**
   * Handles incoming response from worker.
   */
  private handleResponse(response: RpcResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingRequests.delete(response.id);

    if (response.error) {
      pending.reject(
        new BrowserServiceError(response.error.message, {
          code: response.error.code,
          details: response.error.details,
          retryable: response.error.retryable,
        }),
      );
    } else {
      pending.resolve(response.result);
    }
  }

  /**
   * Handles worker crash or unexpected termination.
   */
  private handleProcessCrash(error: Error): void {
    this.workerProcess = null;

    // Reject all pending requests with BROWSER_WORKER_CRASHED
    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timer);
      pending.reject(
        new BrowserServiceError(`Browser worker process terminated unexpectedly: ${error.message}`, {
          code: BrowserErrorCode.BROWSER_WORKER_CRASHED,
          cause: error,
          details: { method: pending.method, requestId: id },
        }),
      );
    }
    this.pendingRequests.clear();
  }

  /**
   * Sends an RPC request to the worker child process.
   */
  private async sendRawRequest<M extends RpcMethod>(
    method: M,
    params: RpcRequestMap[M],
    timeoutMs = 30000,
  ): Promise<RpcResponseMap[M]> {
    if (this.isDisposed) {
      throw new BrowserServiceError('BrowserWorkerClient is disposed', {
        code: BrowserErrorCode.BROWSER_UNAVAILABLE,
      });
    }

    if (method !== 'init') {
      await this.ensureWorker();
    }

    const id = `req_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const request: RpcRequest<M> = { id, method, params };

    return new Promise<RpcResponseMap[M]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(
          new BrowserServiceError(`Browser RPC request "${method}" timed out after ${timeoutMs}ms`, {
            code: BrowserErrorCode.BROWSER_TIMEOUT,
            details: { method, requestId: id, timeoutMs },
          }),
        );
      }, timeoutMs);

      this.pendingRequests.set(id, { id, method, resolve, reject, timer });

      try {
        if (!this.workerProcess || !this.workerProcess.stdin) {
          throw new Error('Worker process stdin is not writable');
        }
        this.workerProcess.stdin.write(JSON.stringify(request) + '\n');
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(
          new BrowserServiceError(`Failed to write RPC request to worker: ${err instanceof Error ? err.message : String(err)}`, {
            code: BrowserErrorCode.BROWSER_UNAVAILABLE,
            cause: err,
          }),
        );
      }
    });
  }

  async open(options: BrowserOpenOptions): Promise<BrowserOpenResult> {
    const timeout = (options.timeoutMs ?? this.options.navigationTimeoutMs ?? 30000) + 5000;
    return this.sendRawRequest('open', options, timeout);
  }

  async snapshot(options: BrowserSnapshotOptions): Promise<BrowserSnapshotResult> {
    const timeout = (this.options.operationTimeoutMs ?? 15000) + 5000;
    return this.sendRawRequest('snapshot', options, timeout);
  }

  async interact(options: BrowserInteractOptions): Promise<BrowserInteractResult> {
    const timeout = (options.timeoutMs ?? this.options.operationTimeoutMs ?? 15000) + 5000;
    return this.sendRawRequest('interact', options, timeout);
  }

  async screenshot(options: BrowserScreenshotOptions): Promise<BrowserScreenshotResult> {
    const timeout = (options.timeoutMs ?? this.options.operationTimeoutMs ?? 15000) + 5000;
    const res = await this.sendRawRequest('screenshot', options, timeout);
    const buffer = Buffer.from(res.base64, 'base64');
    return {
      pageId: res.pageId,
      mimeType: res.mimeType,
      dimensions: res.dimensions,
      buffer,
    };
  }

  async close(options: BrowserCloseOptions = {}): Promise<BrowserCloseResult> {
    return this.sendRawRequest('close', options, 10000);
  }

  async checkHealth(): Promise<BrowserServiceHealth> {
    if (!this.workerProcess || this.workerProcess.killed || this.workerProcess.exitCode !== null) {
      return {
        status: 'degraded',
        activeContexts: 0,
        activePages: 0,
        uptimeSeconds: 0,
      };
    }

    try {
      const res = await this.sendRawRequest('health', {}, 5000);
      return {
        ...res,
        workerPid: this.workerProcess.pid,
      };
    } catch {
      return {
        status: 'unhealthy',
        activeContexts: 0,
        activePages: 0,
        workerPid: this.workerProcess?.pid,
        uptimeSeconds: 0,
      };
    }
  }

  async dispose(): Promise<void> {
    this.isDisposed = true;

    if (this.workerProcess) {
      try {
        await this.sendRawRequest('shutdown', {}, 3000).catch(() => {});
      } catch {
        // Ignore
      }

      if (this.workerProcess && !this.workerProcess.killed) {
        this.workerProcess.kill('SIGTERM');
      }
      this.workerProcess = null;
    }

    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new BrowserServiceError('BrowserWorkerClient was disposed', {
          code: BrowserErrorCode.BROWSER_UNAVAILABLE,
        }),
      );
    }
    this.pendingRequests.clear();
  }
}
