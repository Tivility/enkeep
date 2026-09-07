/**
 * Strict Runtime Schema Validators for Browser JSON-RPC
 *
 * Validates untrusted input lines at the RPC boundary before dispatching to manager.
 * Invariant: Never allows unvalidated `as any` casts from incoming messages.
 *
 * @module @enkeep/platform-service-browser/worker/rpc-validators
 */

import type {
  BrowserSessionKey,
  BrowserOpenOptions,
  BrowserSnapshotOptions,
  BrowserInteractOptions,
  BrowserInteractAction,
  BrowserScreenshotOptions,
  BrowserCloseOptions,
  BrowserServiceOptions,
} from '../types.js';
import { BrowserErrorCode, BrowserServiceError } from '../errors.js';
import type { RpcMethod, RpcRequest } from './rpc-protocol.js';

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function validateSessionKey(value: unknown): BrowserSessionKey {
  if (!isObject(value)) {
    throw new BrowserServiceError('Invalid sessionKey: expected an object.', {
      code: BrowserErrorCode.BROWSER_BAD_REQUEST,
    });
  }

  if (!isNonEmptyString(value.userId)) {
    throw new BrowserServiceError('Invalid sessionKey.userId: expected non-empty string.', {
      code: BrowserErrorCode.BROWSER_BAD_REQUEST,
    });
  }

  if (!isNonEmptyString(value.spaceId)) {
    throw new BrowserServiceError('Invalid sessionKey.spaceId: expected non-empty string.', {
      code: BrowserErrorCode.BROWSER_BAD_REQUEST,
    });
  }

  if (!isNonEmptyString(value.sessionId)) {
    throw new BrowserServiceError('Invalid sessionKey.sessionId: expected non-empty string.', {
      code: BrowserErrorCode.BROWSER_BAD_REQUEST,
    });
  }

  return {
    userId: value.userId,
    spaceId: value.spaceId,
    sessionId: value.sessionId,
  };
}

export function validateInitOptions(params: unknown): BrowserServiceOptions {
  if (!isObject(params)) {
    return {};
  }

  const options: BrowserServiceOptions = {
    allowedHosts: Array.isArray(params.allowedHosts)
      ? params.allowedHosts.filter((h): h is string => typeof h === 'string')
      : undefined,
    allowLocalForTesting: typeof params.allowLocalForTesting === 'boolean' ? params.allowLocalForTesting : undefined,
    maxPagesPerSession: typeof params.maxPagesPerSession === 'number' ? params.maxPagesPerSession : undefined,
    maxContextsGlobal: typeof params.maxContextsGlobal === 'number' ? params.maxContextsGlobal : undefined,
    navigationTimeoutMs: typeof params.navigationTimeoutMs === 'number' ? params.navigationTimeoutMs : undefined,
    operationTimeoutMs: typeof params.operationTimeoutMs === 'number' ? params.operationTimeoutMs : undefined,
    idleTimeoutMs: typeof params.idleTimeoutMs === 'number' ? params.idleTimeoutMs : undefined,
    maxSnapshotNodes: typeof params.maxSnapshotNodes === 'number' ? params.maxSnapshotNodes : undefined,
    maxSnapshotBytes: typeof params.maxSnapshotBytes === 'number' ? params.maxSnapshotBytes : undefined,
    headless: typeof params.headless === 'boolean' ? params.headless : undefined,
    chromiumExecutablePath: typeof params.chromiumExecutablePath === 'string' ? params.chromiumExecutablePath : undefined,
    disableChromiumSandboxForTesting:
      typeof params.disableChromiumSandboxForTesting === 'boolean'
        ? params.disableChromiumSandboxForTesting
        : undefined,
    blockMediaResources: typeof params.blockMediaResources === 'boolean' ? params.blockMediaResources : undefined,
  };

  return options;
}

export function validateOpenOptions(params: unknown): BrowserOpenOptions {
  if (!isObject(params)) {
    throw new BrowserServiceError('Invalid open params: expected object.', {
      code: BrowserErrorCode.BROWSER_BAD_REQUEST,
    });
  }

  const sessionKey = validateSessionKey(params.sessionKey);

  if (!isNonEmptyString(params.url)) {
    throw new BrowserServiceError('Invalid open params: url must be a non-empty string.', {
      code: BrowserErrorCode.BROWSER_BAD_REQUEST,
    });
  }

  return {
    sessionKey,
    url: params.url,
    timeoutMs: typeof params.timeoutMs === 'number' ? params.timeoutMs : undefined,
  };
}

export function validateSnapshotOptions(params: unknown): BrowserSnapshotOptions {
  if (!isObject(params)) {
    throw new BrowserServiceError('Invalid snapshot params: expected object.', {
      code: BrowserErrorCode.BROWSER_BAD_REQUEST,
    });
  }

  const sessionKey = validateSessionKey(params.sessionKey);

  if (!isNonEmptyString(params.pageId)) {
    throw new BrowserServiceError('Invalid snapshot params: pageId must be a non-empty string.', {
      code: BrowserErrorCode.BROWSER_BAD_REQUEST,
    });
  }

  return {
    sessionKey,
    pageId: params.pageId,
    maxNodes: typeof params.maxNodes === 'number' ? params.maxNodes : undefined,
    maxBytes: typeof params.maxBytes === 'number' ? params.maxBytes : undefined,
  };
}

export function validateInteractOptions(params: unknown): BrowserInteractOptions {
  if (!isObject(params)) {
    throw new BrowserServiceError('Invalid interact params: expected object.', {
      code: BrowserErrorCode.BROWSER_BAD_REQUEST,
    });
  }

  const sessionKey = validateSessionKey(params.sessionKey);

  if (!isNonEmptyString(params.pageId)) {
    throw new BrowserServiceError('Invalid interact params: pageId must be a non-empty string.', {
      code: BrowserErrorCode.BROWSER_BAD_REQUEST,
    });
  }

  const validActions: BrowserInteractAction[] = ['click', 'fill', 'press', 'select'];
  if (typeof params.action !== 'string' || !validActions.includes(params.action as BrowserInteractAction)) {
    throw new BrowserServiceError(
      `Invalid interact params: action must be one of ${validActions.join(', ')}.`,
      {
        code: BrowserErrorCode.BROWSER_BAD_REQUEST,
      },
    );
  }

  if (!isNonEmptyString(params.ref)) {
    throw new BrowserServiceError('Invalid interact params: ref must be a non-empty string.', {
      code: BrowserErrorCode.BROWSER_BAD_REQUEST,
    });
  }

  return {
    sessionKey,
    pageId: params.pageId,
    action: params.action as BrowserInteractAction,
    ref: params.ref,
    value: typeof params.value === 'string' ? params.value : undefined,
    key: typeof params.key === 'string' ? params.key : undefined,
    timeoutMs: typeof params.timeoutMs === 'number' ? params.timeoutMs : undefined,
  };
}

export function validateScreenshotOptions(params: unknown): BrowserScreenshotOptions {
  if (!isObject(params)) {
    throw new BrowserServiceError('Invalid screenshot params: expected object.', {
      code: BrowserErrorCode.BROWSER_BAD_REQUEST,
    });
  }

  const sessionKey = validateSessionKey(params.sessionKey);

  if (!isNonEmptyString(params.pageId)) {
    throw new BrowserServiceError('Invalid screenshot params: pageId must be a non-empty string.', {
      code: BrowserErrorCode.BROWSER_BAD_REQUEST,
    });
  }

  return {
    sessionKey,
    pageId: params.pageId,
    fullPage: typeof params.fullPage === 'boolean' ? params.fullPage : undefined,
    timeoutMs: typeof params.timeoutMs === 'number' ? params.timeoutMs : undefined,
  };
}

export function validateCloseOptions(params: unknown): BrowserCloseOptions {
  if (!isObject(params)) {
    return {};
  }

  if (params.all === true) {
    return {
      all: true,
      sessionKey: params.sessionKey ? validateSessionKey(params.sessionKey) : undefined,
    };
  }

  const sessionKey = params.sessionKey ? validateSessionKey(params.sessionKey) : undefined;

  return {
    pageId: typeof params.pageId === 'string' && params.pageId.trim() ? params.pageId.trim() : undefined,
    sessionKey,
    all: typeof params.all === 'boolean' ? params.all : undefined,
  };
}

export function validateRpcRequest(raw: unknown): RpcRequest {
  if (!isObject(raw)) {
    throw new BrowserServiceError('Invalid JSON-RPC frame: expected JSON object.', {
      code: BrowserErrorCode.BROWSER_BAD_REQUEST,
    });
  }

  if (!isNonEmptyString(raw.id)) {
    throw new BrowserServiceError('Invalid JSON-RPC frame: missing id string.', {
      code: BrowserErrorCode.BROWSER_BAD_REQUEST,
    });
  }

  const validMethods: RpcMethod[] = [
    'init',
    'open',
    'snapshot',
    'interact',
    'screenshot',
    'close',
    'health',
    'shutdown',
  ];

  if (typeof raw.method !== 'string' || !validMethods.includes(raw.method as RpcMethod)) {
    throw new BrowserServiceError(`Unknown RPC method: "${String(raw.method)}"`, {
      code: BrowserErrorCode.BROWSER_BAD_REQUEST,
    });
  }

  return raw as unknown as RpcRequest;
}
