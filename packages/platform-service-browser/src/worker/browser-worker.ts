/**
 * Browser Service Worker Subprocess
 *
 * Runs as an isolated child process, managing the Playwright Browser singleton
 * and servicing RPC requests via stdio NDJSON framing.
 *
 * @module @enkeep/platform-service-browser/worker/browser-worker
 */

import * as readline from 'node:readline';
import { BrowserContextManager } from '../pool/context-manager.js';
import { BrowserErrorCode, BrowserServiceError, isBrowserServiceError, sanitizeBrowserError } from '../errors.js';
import type { RpcRequest, RpcResponse } from './rpc-protocol.js';
import {
  validateRpcRequest,
  validateInitOptions,
  validateOpenOptions,
  validateSnapshotOptions,
  validateInteractOptions,
  validateScreenshotOptions,
  validateCloseOptions,
} from './rpc-validators.js';

let manager: BrowserContextManager | null = null;

function sendResponse(response: RpcResponse): void {
  try {
    process.stdout.write(JSON.stringify(response) + '\n');
  } catch {
    // Process stdout broken or closed
  }
}

async function handleRequest(request: RpcRequest): Promise<void> {
  const { id, method, params } = request;

  try {
    switch (method) {
      case 'init': {
        const validatedOptions = validateInitOptions(params);
        if (!manager) {
          manager = new BrowserContextManager(validatedOptions);
          await manager.initialize();
        }
        sendResponse({ id, result: { ok: true } });
        break;
      }

      case 'open': {
        if (!manager) {
          throw new BrowserServiceError('Browser worker manager not initialized', {
            code: BrowserErrorCode.BROWSER_UNAVAILABLE,
          });
        }
        const validatedParams = validateOpenOptions(params);
        const res = await manager.open(validatedParams);
        sendResponse({ id, result: res });
        break;
      }

      case 'snapshot': {
        if (!manager) {
          throw new BrowserServiceError('Browser worker manager not initialized', {
            code: BrowserErrorCode.BROWSER_UNAVAILABLE,
          });
        }
        const validatedParams = validateSnapshotOptions(params);
        const res = await manager.snapshot(validatedParams);
        sendResponse({ id, result: res });
        break;
      }

      case 'interact': {
        if (!manager) {
          throw new BrowserServiceError('Browser worker manager not initialized', {
            code: BrowserErrorCode.BROWSER_UNAVAILABLE,
          });
        }
        const validatedParams = validateInteractOptions(params);
        const res = await manager.interact(validatedParams);
        sendResponse({ id, result: res });
        break;
      }

      case 'screenshot': {
        if (!manager) {
          throw new BrowserServiceError('Browser worker manager not initialized', {
            code: BrowserErrorCode.BROWSER_UNAVAILABLE,
          });
        }
        const validatedParams = validateScreenshotOptions(params);
        const res = await manager.screenshot(validatedParams);
        sendResponse({
          id,
          result: {
            pageId: res.pageId,
            mimeType: res.mimeType,
            dimensions: res.dimensions,
            base64: res.buffer.toString('base64'),
          },
        });
        break;
      }

      case 'close': {
        if (!manager) {
          sendResponse({ id, result: { closedPages: 0, closedContexts: 0 } });
          return;
        }
        const validatedParams = validateCloseOptions(params);
        const res = await manager.close(validatedParams);
        sendResponse({ id, result: res });
        break;
      }

      case 'health': {
        if (!manager) {
          sendResponse({
            id,
            result: {
              status: 'unhealthy',
              activeContexts: 0,
              activePages: 0,
              uptimeSeconds: 0,
            },
          });
          return;
        }
        const res = await manager.checkHealth();
        sendResponse({ id, result: res });
        break;
      }

      case 'shutdown': {
        if (manager) {
          await manager.dispose().catch(() => {});
          manager = null;
        }
        sendResponse({ id, result: { ok: true } });
        process.exit(0);
        break;
      }

      default: {
        throw new BrowserServiceError(`Unknown RPC method: "${String(method)}"`, {
          code: BrowserErrorCode.BROWSER_BAD_REQUEST,
        });
      }
    }
  } catch (err) {
    const sanitized = sanitizeBrowserError(err);
    sendResponse({
      id,
      error: {
        message: sanitized.message,
        code: sanitized.code,
        details: sanitized.details,
        retryable: isBrowserServiceError(err) ? err.retryable : false,
      },
    });
  }
}

// Set up NDJSON line reader on stdin
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  try {
    const raw = JSON.parse(trimmed);
    const request = validateRpcRequest(raw);
    handleRequest(request).catch(() => {
      // Invariant: no unhandled rejection leaks to stdout/stderr
    });
  } catch (err) {
    const sanitized = sanitizeBrowserError(err);
    sendResponse({
      id: 'invalid_frame',
      error: {
        message: sanitized.message,
        code: sanitized.code,
        details: sanitized.details,
        retryable: false,
      },
    });
  }
});

async function cleanupAndExit(): Promise<void> {
  if (manager) {
    await manager.dispose().catch(() => {});
    manager = null;
  }
  process.exit(0);
}

process.on('SIGTERM', () => {
  cleanupAndExit();
});

process.on('SIGINT', () => {
  cleanupAndExit();
});

process.on('SIGHUP', () => {
  cleanupAndExit();
});

process.stdin.on('end', () => {
  cleanupAndExit();
});
