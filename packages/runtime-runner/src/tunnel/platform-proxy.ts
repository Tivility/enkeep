/**
 * Platform Proxy Stream Handler for Platform Host (Runtime Module Bridge)
 *
 * Implements StreamHandler for kind: 'platform' over the stdio multiplexed tunnel.
 *
 * Explicit 5-Module Boundary Architecture:
 * 1. Runtime Module: Owns container lifecycle, stdio tunnel multiplexing, task executor/worker leasing, and PlatformProxyHandler bridge.
 * 2. Workspace Module: Owns task definition/planning/history, message dispatching, and file containment operations.
 *    - `create_task` typed handler invokes Workspace Task Service (`TaskOperationService`).
 *    - `send_message` / `send_file` typed handlers invoke Workspace message & file operations services.
 * 3. Storage Module: Owns SQLite tables and persistence repositories (`platform_tasks`, `web_messages`, `file_metadata`, `delivery_receipts`),
 *    as well as quota rules and ledger repositories (`quota_limits`, `quota_usage`, `quota_reservations`).
 *    - `check_quota` typed handler reads Storage quota ledger.
 * 4. User Accounts Module: Owns authentication, tenant authorization, and user/session isolation.
 * 5. Model Accounts Module: Owns LLM provider routing and credential proxy (`LlmProxyHandler`), strictly producing token usage only.
 *
 * Security and Architecture Invariants:
 * - Strict fixed route and method allowlist only (no generic proxying, no arbitrary paths).
 * - Binds strictly to container ownership: userId is INJECTED by TunnelHost metadata (never trusted from container).
 * - Interacts directly with platform-side typed services / storage (no HTTP cookie/CSRF needed).
 * - Enforces identical tenant isolation, quota checks, and idempotency guarantees.
 * - MAX payload body limits (10 MiB for files, 1 MiB for tasks/messages/events).
 * - Zero host outbound network access (no fetch to internet).
 *
 * @module @enkeep/runtime-runner/tunnel/platform-proxy
 */

import { randomUUID } from 'node:crypto';
import { Duplex, PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { StreamHandler, StreamMetadata } from './contract.js';
import type { PlatformOperationsService } from '@enkeep/platform-operations';
import type {
  PlatformStorage,
  BrowserService,
  PlatformProxyMcpService,
  McpProxyContext,
  McpToolDefinition,
  McpToolCallResult,
  McpServerHealth,
} from '@enkeep/platform-core';
import { parseHttp1RequestFromStream, type ParsedHttpRequest } from './llm-proxy.js';

export type {
  PlatformProxyMcpService,
  McpProxyContext,
  McpToolDefinition,
  McpToolCallResult,
  McpServerHealth,
};

export const PLATFORM_STREAM_KIND = 'platform';
export const EVENTS_STREAM_KIND = 'events';
export const MAX_PLATFORM_BODY_BYTES = 1024 * 1024; // 1 MiB
export const MAX_FILE_BODY_BYTES = 10 * 1024 * 1024; // 10 MiB

export const CANONICAL_UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const CANONICAL_PLATFORM_USER_ID_REGEX =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|user_[a-zA-Z0-9_\-]{1,64}|u[0-9]+)$/i;

export const RUNTIME_IDENTITY_REGEX = /^[a-zA-Z0-9_\-]{1,64}$/;

export const CANONICAL_SESSION_ID_REGEX =
  /^(?:ses_[0-9a-f]{32}|import-[0-9a-f]{32})$/;

export const CANONICAL_TASK_ID_REGEX = /^task_[0-9a-f]{32}$/;

export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTaskPriority(p: unknown): p is TaskPriority {
  return p === 'low' || p === 'medium' || p === 'high' || p === 'urgent';
}

export interface PlatformProxyFileProvider {
  execute(
    userId: string,
    spaceId: string,
    request: {
      op: 'write';
      path: string;
      content: string;
      encoding?: 'utf8' | 'base64';
      requireAbsent?: boolean;
    } | {
      op: 'read';
      path: string;
      encoding?: 'utf8' | 'base64';
    }
  ): Promise<unknown>;
}

interface StoredTaskRow {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly priority: string;
  readonly due_date: string | null;
  readonly created_at: string;
}

export interface PlatformProxyBaseOptions {
  /** Expected container runtime alias (e.g. 'alice') */
  runtimeIdentity?: string;
  /** Maximum body bytes override */
  maxBodyBytes?: number;
  /** Maximum file body bytes override */
  maxFileSizeBytes?: number;
}

export interface PlatformProxyBoundOptions extends PlatformProxyBaseOptions {
  /** Authoritative platform user identifier (canonical UUID in platform DB) */
  platformUserId: string;
  /** Platform operations service (for tasks, quotas, message/file audit) */
  operations?: PlatformOperationsService;
  /** Core platform storage (for spaces, session_routes, users) */
  storage?: PlatformStorage;
  /** Direct SQLite database access (for web_messages, file_metadata) */
  db?: DatabaseSync;
  /** Optional browser execution service for browser automation */
  browserService?: BrowserService;
  /** Optional tenant runtime file provider for artifact persistence */
  fileProvider?: PlatformProxyFileProvider;
  /** Optional MCP service / gateway port */
  mcpService?: PlatformProxyMcpService;
}

export interface PlatformProxyUnboundOptions extends PlatformProxyBaseOptions {
  platformUserId?: undefined;
  operations?: undefined;
  storage?: undefined;
  db?: undefined;
  browserService?: undefined;
  fileProvider?: undefined;
  mcpService?: undefined;
}

export type PlatformProxyOptions = PlatformProxyBoundOptions | PlatformProxyUnboundOptions;

/**
 * Strips `/platform` prefix from incoming request pathname.
 */
export function normalizePlatformPath(rawUrl: string): { pathname: string; searchParams: URLSearchParams } {
  try {
    const parsed = new URL(rawUrl, 'http://127.0.0.1:8787');
    let pathname = parsed.pathname;

    if (pathname.startsWith('/platform/')) {
      pathname = pathname.slice(9); // remove '/platform'
    } else if (pathname === '/platform') {
      pathname = '/';
    }

    if (!pathname.startsWith('/')) {
      pathname = `/${pathname}`;
    }

    return { pathname, searchParams: parsed.searchParams };
  } catch (_urlErr: unknown) {
    return { pathname: rawUrl, searchParams: new URLSearchParams() };
  }
}

/**
 * PlatformProxyHandler handles stream multiplexing for kind: 'platform'.
 */
export class PlatformProxyHandler implements StreamHandler {
  readonly kind = PLATFORM_STREAM_KIND;
  readonly platformUserId?: string;
  readonly runtimeIdentity?: string;
  private readonly operations?: PlatformOperationsService;
  private readonly storage?: PlatformStorage;
  private readonly db?: DatabaseSync;
  private readonly browserService?: BrowserService;
  private readonly fileProvider?: PlatformProxyFileProvider;
  private readonly mcpService?: PlatformProxyMcpService;
  private readonly maxBodyBytes: number;
  private readonly maxFileSizeBytes: number;

  constructor(options: PlatformProxyOptions = {}) {
    if (options.db || options.storage || options.operations || options.browserService || options.fileProvider || options.mcpService) {
      if (
        options.platformUserId === undefined ||
        options.platformUserId === null ||
        typeof options.platformUserId !== 'string' ||
        options.platformUserId.length === 0
      ) {
        throw new Error(
          'FAIL-CLOSED: platformUserId is required when configuring PlatformProxyHandler with db, storage, or operations'
        );
      }
      if (
        options.platformUserId !== options.platformUserId.trim() ||
        options.platformUserId !== options.platformUserId.normalize('NFC')
      ) {
        throw new Error(
          'FAIL-CLOSED: platformUserId must be exact trimmed string in Unicode NFC normalization (automatic trimming is forbidden)'
        );
      }
      if (!CANONICAL_PLATFORM_USER_ID_REGEX.test(options.platformUserId)) {
        throw new Error(
          `FAIL-CLOSED: Invalid platformUserId format "${options.platformUserId}" (must be canonical UUID or valid user fixture ID)`
        );
      }
    }

    if (options.platformUserId !== undefined) {
      if (
        typeof options.platformUserId !== 'string' ||
        options.platformUserId.length === 0 ||
        options.platformUserId !== options.platformUserId.trim() ||
        options.platformUserId !== options.platformUserId.normalize('NFC') ||
        !CANONICAL_PLATFORM_USER_ID_REGEX.test(options.platformUserId)
      ) {
        throw new Error(
          'FAIL-CLOSED: platformUserId must be a valid, exact trimmed, NFC normalized canonical UUID or user identifier'
        );
      }
    }

    if (options.runtimeIdentity !== undefined) {
      if (
        typeof options.runtimeIdentity !== 'string' ||
        options.runtimeIdentity.length === 0 ||
        options.runtimeIdentity !== options.runtimeIdentity.trim() ||
        options.runtimeIdentity !== options.runtimeIdentity.normalize('NFC') ||
        !RUNTIME_IDENTITY_REGEX.test(options.runtimeIdentity)
      ) {
        throw new Error(
          'FAIL-CLOSED: runtimeIdentity must be a non-empty, exact trimmed, NFC normalized container alias'
        );
      }
    }

    // Preserve raw validated values without silent normalization or trimming
    this.platformUserId = options.platformUserId;
    this.runtimeIdentity = options.runtimeIdentity;
    this.operations = options.operations;
    this.storage = options.storage;
    this.db = options.db;
    this.browserService = options.browserService;
    this.fileProvider = options.fileProvider;
    this.mcpService = options.mcpService;
    this.maxBodyBytes = options.maxBodyBytes ?? MAX_PLATFORM_BODY_BYTES;
    this.maxFileSizeBytes = options.maxFileSizeBytes ?? MAX_FILE_BODY_BYTES;
  }

  /**
   * Handles an incoming duplex stream from the tunnel.
   */
  async handle(stream: Duplex, metadata: StreamMetadata): Promise<void> {
    if (metadata.kind !== PLATFORM_STREAM_KIND) {
      this.writeJsonResponse(stream, 400, {
        error: { code: 'INVALID_STREAM_KIND', message: `Expected kind "${PLATFORM_STREAM_KIND}", got "${metadata.kind}"` },
      });
      return;
    }

    const runtimeAlias = typeof metadata.userId === 'string' && metadata.userId.length > 0
      ? metadata.userId
      : undefined;

    if (!runtimeAlias) {
      this.writeJsonResponse(stream, 403, {
        error: { code: 'UNAUTHORIZED_CONTAINER', message: 'Tunnel stream missing authoritative container userId binding' },
      });
      return;
    }

    if (this.runtimeIdentity && runtimeAlias !== this.runtimeIdentity) {
      this.writeJsonResponse(stream, 403, {
        error: { code: 'UNAUTHORIZED_CONTAINER', message: `Tunnel stream runtime alias "${runtimeAlias}" does not match bound identity "${this.runtimeIdentity}"` },
      });
      return;
    }

    try {
      const parsedReq = await parseHttp1RequestFromStream(stream);
      await this.dispatchRequest(parsedReq, runtimeAlias, stream);
    } catch (_err: unknown) {
      this.writeJsonResponse(stream, 500, {
        error: { code: 'INTERNAL_ERROR', message: 'Internal platform proxy error' },
      });
    }
  }

  /**
   * Handles incoming HTTP request directly from loopback HTTP proxy (e.g. Host runtime).
   */
  async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const bodyChunks: Buffer[] = [];
    for await (const chunk of req) {
      bodyChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const body = Buffer.concat(bodyChunks);

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers[k.toLowerCase()] = v;
      else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(', ');
    }

    const parsedReq: ParsedHttpRequest = {
      method: req.method || 'GET',
      url: req.url || '/',
      httpVersion: req.httpVersion || '1.1',
      headers,
      body,
    };

    const runtimeAlias = this.runtimeIdentity || this.platformUserId || 'host-user';

    const duplex = new PassThrough();
    let headersParsed = false;
    let headerBuffer = Buffer.alloc(0);

    duplex.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      if (headersParsed) {
        if (!res.writableEnded && !res.destroyed) {
          res.write(buf);
        }
        return;
      }
      headerBuffer = Buffer.concat([headerBuffer, buf]);
      const headerEndIdx = headerBuffer.indexOf('\r\n\r\n');
      if (headerEndIdx !== -1) {
        headersParsed = true;
        const headerText = headerBuffer.slice(0, headerEndIdx).toString('utf8');
        const bodyRemainder = headerBuffer.slice(headerEndIdx + 4);

        const lines = headerText.split('\r\n');
        const statusLine = lines[0] || 'HTTP/1.1 200 OK';
        const parts = statusLine.split(' ');
        const statusCode = parseInt(parts[1] || '200', 10);

        const resHeaders: Record<string, string> = {};
        for (let i = 1; i < lines.length; i++) {
          const colonIdx = lines[i].indexOf(':');
          if (colonIdx > 0) {
            const key = lines[i].slice(0, colonIdx).trim();
            const val = lines[i].slice(colonIdx + 1).trim();
            resHeaders[key] = val;
          }
        }

        if (!res.headersSent) {
          res.writeHead(statusCode, resHeaders);
        }
        if (bodyRemainder.length > 0 && !res.writableEnded && !res.destroyed) {
          res.write(bodyRemainder);
        }
      }
    });

    duplex.on('end', () => {
      if (!headersParsed && headerBuffer.length > 0 && !res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(headerBuffer);
      } else if (!res.writableEnded && !res.destroyed) {
        res.end();
      }
    });

    duplex.on('error', (_err: Error) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Internal platform proxy error' } }));
      }
    });

    try {
      await this.dispatchRequest(parsedReq, runtimeAlias, duplex);
    } catch (_err: unknown) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Internal platform proxy error' } }));
      }
    }
  }

  /**
   * Dispatches the parsed HTTP request strictly against the allowlisted routes.
   */
  private async dispatchRequest(req: ParsedHttpRequest, runtimeAlias: string, stream: Duplex): Promise<void> {
    const { pathname, searchParams } = normalizePlatformPath(req.url);
    const method = req.method.toUpperCase();

    // 1. Capabilities Handshake: GET /platform/capabilities or GET /capabilities
    if ((pathname === '/capabilities' || pathname === '/platform/capabilities') && method === 'GET') {
      if (!this.platformUserId || (!this.db && !this.operations && !this.browserService && !this.mcpService)) {
        this.writeJsonResponse(stream, 503, {
          success: false,
          error: { code: 'SERVICES_UNAVAILABLE', message: 'Platform proxy requires authoritative platformUserId with db, operations, browser, or mcp service' },
          data: {
            capabilities: [],
            userId: runtimeAlias,
          },
          capabilities: [],
        });
        return;
      }

      // Dynamic readiness probe on operations / quota / database
      const verifiedCapabilities: string[] = [];
      let quotaOperational = false;
      let sessionOwnershipValid = false;

      if (this.operations) {
        try {
          const quotaCheck = await this.operations.forTenant(this.platformUserId).quota.checkQuota();
          if (quotaCheck && typeof quotaCheck.allowed === 'boolean') {
            quotaOperational = true;
          }
        } catch (_quotaErr: unknown) {
          quotaOperational = false;
        }
      } else if (this.db) {
        try {
          const qRow = this.db.prepare('SELECT COUNT(*) as c FROM quota_limits WHERE user_id = ?').get(this.platformUserId) as { c: number } | undefined;
          if (qRow) {
            quotaOperational = true;
          }
        } catch (_dbErr: unknown) {
          quotaOperational = false;
        }
      }

      if (this.storage) {
        try {
          const sessionRoutesRepo = this.storage.forTenant(this.platformUserId).sessionRoutes;
          if (typeof (sessionRoutesRepo as any).list === 'function') {
            await (sessionRoutesRepo as any).list();
          } else if (typeof sessionRoutesRepo.countBySpaceId === 'function') {
            await sessionRoutesRepo.countBySpaceId('__probe__');
          }
          sessionOwnershipValid = true;
        } catch (_stErr: unknown) {
          sessionOwnershipValid = false;
        }
      } else if (this.db) {
        try {
          const rRow = this.db.prepare('SELECT COUNT(*) as c FROM session_routes WHERE user_id = ?').get(this.platformUserId) as { c: number } | undefined;
          if (rRow) {
            sessionOwnershipValid = true;
          }
        } catch (_dbErr: unknown) {
          sessionOwnershipValid = false;
        }
      } else if (this.operations) {
        sessionOwnershipValid = true;
      }

      if (quotaOperational) {
        verifiedCapabilities.push('quota');
      }
      if (sessionOwnershipValid || this.operations || this.db) {
        verifiedCapabilities.push('messages', 'files', 'tasks', 'events');
      }
      if (this.browserService) {
        try {
          const health = await this.browserService.checkHealth();
          if (health.status === 'healthy') {
            verifiedCapabilities.push('browser');
          }
        } catch {
          // Degraded, unhealthy, or checkHealth failed -> do not advertise browser capability
        }
      }
      if (this.mcpService) {
        try {
          const mcpHealth: readonly McpServerHealth[] = await this.mcpService.checkHealth({ userId: this.platformUserId || runtimeAlias });
          const isHealthy = Array.isArray(mcpHealth) && !mcpHealth.some((h) => h.status === 'unhealthy' || h.status === 'degraded');
          if (isHealthy) {
            verifiedCapabilities.push('mcp');
          }
        } catch {
          // Degraded, unhealthy, or checkHealth failed -> do not advertise mcp capability
        }
      }

      if (verifiedCapabilities.length === 0) {
        this.writeJsonResponse(stream, 503, {
          success: false,
          error: { code: 'PROBE_FAILED', message: 'Platform readiness probe failed for tenant' },
          data: {
            capabilities: [],
            userId: runtimeAlias,
          },
          capabilities: [],
        });
        return;
      }

      // Public capabilities response must NEVER leak internal platform UUID
      this.writeJsonResponse(stream, 200, {
        success: true,
        data: {
          capabilities: verifiedCapabilities,
          userId: runtimeAlias,
        },
        capabilities: verifiedCapabilities,
      });
      return;
    }

    // 2. Quota Check: GET /api/manage/quota/check?metrics=all
    if (pathname === '/api/manage/quota/check' && method === 'GET') {
      await this.handleCheckQuota(searchParams, stream);
      return;
    }

    // 3. Messages: POST /api/messages
    if (pathname === '/api/messages') {
      if (method !== 'POST') {
        this.writeJsonResponse(stream, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method Not Allowed' } });
        return;
      }
      await this.handleSendMessage(req, stream);
      return;
    }

    // 4. Files: POST /api/files
    if (pathname === '/api/files') {
      if (method !== 'POST') {
        this.writeJsonResponse(stream, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method Not Allowed' } });
        return;
      }
      await this.handleSendFile(req, stream);
      return;
    }

    // 5. Tasks: POST /api/manage/tasks
    if (pathname === '/api/manage/tasks') {
      if (method === 'POST') {
        await this.handleCreateTask(req, stream);
        return;
      }
      this.writeJsonResponse(stream, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method Not Allowed' } });
      return;
    }

    // 6. Events / Streaming: POST /api/events, POST /events, POST /api/events/batch
    if (
      (pathname === '/api/events' || pathname === '/events' || pathname === '/api/events/batch') &&
      method === 'POST'
    ) {
      await this.handlePublishEvents(req, stream);
      return;
    }

    // 7. Canonical Internal Browser Operations: POST /api/browser/*
    if (pathname.startsWith('/api/browser/')) {
      const browserSub = pathname.slice('/api/browser/'.length);

      if (method !== 'POST') {
        this.writeJsonResponse(stream, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method Not Allowed' } });
        return;
      }

      if (!this.browserService) {
        this.writeJsonResponse(stream, 503, {
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Browser service is not configured or unavailable' },
        });
        return;
      }

      if (browserSub === 'open') {
        await this.handleBrowserOpen(req, stream);
        return;
      }
      if (browserSub === 'snapshot') {
        await this.handleBrowserSnapshot(req, stream);
        return;
      }
      if (browserSub === 'interact') {
        await this.handleBrowserInteract(req, stream);
        return;
      }
      if (browserSub === 'screenshot') {
        await this.handleBrowserScreenshot(req, stream);
        return;
      }
      if (browserSub === 'close') {
        await this.handleBrowserClose(req, stream);
        return;
      }
    }

    // 8. Canonical Internal MCP Operations: /api/mcp/tools, /api/mcp/call, /api/mcp/cancel, /api/mcp/health
    if (pathname === '/api/mcp/tools') {
      if (method !== 'GET') {
        this.writeJsonResponse(stream, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method Not Allowed' } });
        return;
      }
      if (!this.mcpService) {
        this.writeJsonResponse(stream, 503, {
          error: { code: 'SERVICE_UNAVAILABLE', message: 'MCP service is not configured or unavailable' },
        });
        return;
      }
      await this.handleMcpListTools(req, stream, searchParams);
      return;
    }

    if (pathname === '/api/mcp/call') {
      if (method !== 'POST') {
        this.writeJsonResponse(stream, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method Not Allowed' } });
        return;
      }
      if (!this.mcpService) {
        this.writeJsonResponse(stream, 503, {
          error: { code: 'SERVICE_UNAVAILABLE', message: 'MCP service is not configured or unavailable' },
        });
        return;
      }
      await this.handleMcpCallTool(req, stream);
      return;
    }

    if (pathname === '/api/mcp/cancel') {
      if (method !== 'POST') {
        this.writeJsonResponse(stream, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method Not Allowed' } });
        return;
      }
      if (!this.mcpService) {
        this.writeJsonResponse(stream, 503, {
          error: { code: 'SERVICE_UNAVAILABLE', message: 'MCP service is not configured or unavailable' },
        });
        return;
      }
      await this.handleMcpCancel(req, stream);
      return;
    }

    if (pathname === '/api/mcp/health') {
      if (method !== 'GET') {
        this.writeJsonResponse(stream, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method Not Allowed' } });
        return;
      }
      if (!this.mcpService) {
        this.writeJsonResponse(stream, 503, {
          error: { code: 'SERVICE_UNAVAILABLE', message: 'MCP service is not configured or unavailable' },
        });
        return;
      }
      await this.handleMcpHealth(req, stream);
      return;
    }

    // Fail-closed for old aliases / unauthorized MCP paths (/mcp/*, /tools/call, /reconcile, etc.)
    if (
      pathname.startsWith('/api/mcp/') ||
      pathname.startsWith('/mcp/') ||
      pathname === '/api/mcp' ||
      pathname === '/mcp' ||
      pathname === '/tools/call' ||
      pathname === '/api/mcp/reconcile' ||
      pathname === '/reconcile'
    ) {
      this.writeJsonResponse(stream, 404, {
        error: { code: 'NOT_FOUND', message: `Route "${pathname}" is not permitted on PlatformProxyHandler` },
      });
      return;
    }

    // Strict Fail-Closed on any unlisted path
    this.writeJsonResponse(stream, 404, {
      error: { code: 'NOT_FOUND', message: `Route "${pathname}" is not permitted on PlatformProxyHandler` },
    });
  }

  /**
   * Handles GET /api/manage/quota/check?metrics=all
   */
  private async handleCheckQuota(
    searchParams: URLSearchParams,
    stream: Duplex
  ): Promise<void> {
    const metricsParam = searchParams.get('metrics');
    if (metricsParam !== null && metricsParam !== 'all') {
      this.writeJsonResponse(stream, 400, {
        error: { code: 'VALIDATION_ERROR', message: 'Invalid "metrics" query parameter, expected "all"' },
      });
      return;
    }

    if (!this.platformUserId) {
      this.writeJsonResponse(stream, 503, {
        error: { code: 'OPERATIONS_UNAVAILABLE', message: 'Platform proxy requires authoritative platformUserId binding' },
      });
      return;
    }

    if (this.operations) {
      try {
        const tenantQuota = this.operations.forTenant(this.platformUserId).quota;
        if (tenantQuota) {
          let hasLimit = false;
          if (typeof tenantQuota.getLimit === 'function') {
            const lim = await tenantQuota.getLimit('api_calls');
            if (lim && typeof lim.limit === 'number' && lim.limit > 0) {
              hasLimit = true;
            }
          }
          if (hasLimit && typeof tenantQuota.reserveQuota === 'function') {
            const resv = await tenantQuota.reserveQuota({ resource: 'api_calls', amount: 1, ttlSeconds: 60 });
            if (resv && typeof tenantQuota.commitQuota === 'function') {
              await tenantQuota.commitQuota({ reservationId: resv.id, actualAmount: 1 });
            }
          }
        }
        const quota = await this.operations.forTenant(this.platformUserId).quota.checkQuota();
        this.writeJsonResponse(stream, 200, {
          success: true,
          data: quota,
        });
        return;
      } catch (err: any) {
        if (err?.code === 'QUOTA_EXCEEDED' || err?.name === 'QuotaExceededError') {
          this.writeJsonResponse(stream, 429, { error: { code: 'QUOTA_EXCEEDED', message: 'Quota exceeded for api_calls' } });
          return;
        }
        this.writeJsonResponse(stream, 500, { error: { code: 'QUOTA_ERROR', message: 'Quota check failed' } });
        return;
      }
    }

    if (this.db) {
      try {
        const limitRows = this.db.prepare('SELECT resource, limit_amount FROM quota_limits WHERE user_id = ?').all(this.platformUserId) as Array<{ resource: string; limit_amount: number }>;
        const limitMap: Record<string, number> = {
          tokens: -1,
          messages: -1,
          turns: -1,
          storage_bytes: -1,
          api_calls: -1,
        };
        for (const row of limitRows) {
          limitMap[row.resource] = row.limit_amount;
        }
        const defaultQuota = {
          allowed: true,
          usage: {
            tokens: 0,
            messages: 0,
            turns: 0,
            storage_bytes: 0,
            api_calls: 0,
          },
          activeReservations: {
            tokens: 0,
            messages: 0,
            turns: 0,
            storage_bytes: 0,
            api_calls: 0,
          },
          limit: limitMap,
          remaining: { ...limitMap },
          resetAt: null,
        };

        this.writeJsonResponse(stream, 200, {
          success: true,
          data: defaultQuota,
        });
        return;
      } catch (_dbErr: unknown) {
        // Fall through
      }
    }

    // Fallback default quota structure with all 5 fixed metrics
    const defaultQuota = {
      allowed: true,
      usage: {
        tokens: 0,
        messages: 0,
        turns: 0,
        storage_bytes: 0,
        api_calls: 0,
      },
      activeReservations: {
        tokens: 0,
        messages: 0,
        turns: 0,
        storage_bytes: 0,
        api_calls: 0,
      },
      limit: {
        tokens: -1,
        messages: -1,
        turns: -1,
        storage_bytes: -1,
        api_calls: -1,
      },
      remaining: {
        tokens: -1,
        messages: -1,
        turns: -1,
        storage_bytes: -1,
        api_calls: -1,
      },
      resetAt: null,
    };

    this.writeJsonResponse(stream, 200, {
      success: true,
      data: defaultQuota,
    });
  }

  /**
   * Handles POST /api/messages
   */
  private async handleSendMessage(req: ParsedHttpRequest, stream: Duplex): Promise<void> {
    if (!this.platformUserId) {
      this.writeJsonResponse(stream, 503, {
        error: { code: 'OPERATIONS_UNAVAILABLE', message: 'Platform proxy requires authoritative platformUserId binding' },
      });
      return;
    }

    if (req.body.length > this.maxBodyBytes) {
      this.writeJsonResponse(stream, 413, {
        error: { code: 'PAYLOAD_TOO_LARGE', message: `Message payload exceeds maximum limit of ${this.maxBodyBytes} bytes` },
      });
      return;
    }

    let parsedBody: Record<string, unknown>;
    try {
      const parsed = JSON.parse(req.body.toString('utf8'));
      if (!isRecord(parsed)) {
        this.writeJsonResponse(stream, 400, {
          error: { code: 'VALIDATION_ERROR', message: 'Request body must be an object' },
        });
        return;
      }
      parsedBody = parsed;
    } catch (_parseErr: unknown) {
      this.writeJsonResponse(stream, 400, {
        error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON' },
      });
      return;
    }

    const { recipient, content, metadata } = parsedBody;
    if (typeof recipient !== 'string' || recipient.trim().length === 0) {
      this.writeJsonResponse(stream, 400, {
        error: { code: 'VALIDATION_ERROR', message: 'Recipient must be a non-empty string' },
      });
      return;
    }
    if (typeof content !== 'string' || content.trim().length === 0) {
      this.writeJsonResponse(stream, 400, {
        error: { code: 'VALIDATION_ERROR', message: 'Content must be a non-empty string' },
      });
      return;
    }

    const messageId = `msg_${randomUUID().replace(/-/g, '')}`;
    const timestamp = new Date().toISOString();

    // 1. If SQLite db is attached, insert into web_messages
    if (this.db) {
      try {
        let matchedSessionId: string | null = null;
        let matchedRouteKey = `session:${recipient}`;

        // Try to match session_routes
        try {
          const routeRow = this.db.prepare(
            'SELECT id, dsh_session_id FROM session_routes WHERE (id = ? OR dsh_session_id = ?) AND user_id = ? LIMIT 1'
          ).get(recipient, recipient, this.platformUserId) as { id: string; dsh_session_id: string } | undefined;

          if (routeRow) {
            matchedSessionId = routeRow.id;
          } else {
            // Find any valid session for this user
            const anyRoute = this.db.prepare(
              'SELECT id FROM session_routes WHERE user_id = ? LIMIT 1'
            ).get(this.platformUserId) as { id: string } | undefined;
            if (anyRoute) {
              matchedSessionId = anyRoute.id;
            }
          }
        } catch (_lookupErr: unknown) {
          // Retain default session route
        }

        if (matchedSessionId) {
          this.db.prepare(`
            INSERT INTO web_messages (
              id, session_id, user_id, role, content, status, route_key, metadata, created_at
            ) VALUES (?, ?, ?, 'assistant', ?, 'delivered', ?, ?, ?)
          `).run(
            messageId,
            matchedSessionId,
            this.platformUserId,
            content,
            matchedRouteKey,
            metadata ? JSON.stringify(metadata) : null,
            timestamp
          );
        }
      } catch (_dbErr: unknown) {
        // DB fallback error contained without failing stream
      }
    }

    // 2. Record in operations if available
    if (this.operations) {
      try {
        await this.operations.forTenant(this.platformUserId).messages.sendMessage({
          recipient,
          content,
          metadata: isRecord(metadata) ? metadata : undefined,
        });
      } catch (_opErr: unknown) {
        // Operations recording error contained
      }
    }

    this.writeJsonResponse(stream, 200, {
      success: true,
      messageId,
      recipient,
      timestamp,
      id: messageId,
      createdAt: timestamp,
    });
  }

  /**
   * Handles POST /api/files
   */
  private async handleSendFile(req: ParsedHttpRequest, stream: Duplex): Promise<void> {
    if (!this.platformUserId) {
      this.writeJsonResponse(stream, 503, {
        error: { code: 'OPERATIONS_UNAVAILABLE', message: 'Platform proxy requires authoritative platformUserId binding' },
      });
      return;
    }

    if (req.body.length > this.maxFileSizeBytes) {
      this.writeJsonResponse(stream, 413, {
        error: { code: 'PAYLOAD_TOO_LARGE', message: `File payload exceeds maximum limit of ${this.maxFileSizeBytes} bytes` },
      });
      return;
    }

    let parsedBody: Record<string, unknown>;
    try {
      const parsed = JSON.parse(req.body.toString('utf8'));
      if (!isRecord(parsed)) {
        this.writeJsonResponse(stream, 400, {
          error: { code: 'VALIDATION_ERROR', message: 'Request body must be an object' },
        });
        return;
      }
      parsedBody = parsed;
    } catch (_parseErr: unknown) {
      this.writeJsonResponse(stream, 400, {
        error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON' },
      });
      return;
    }

    const { recipient, path: filePath, filename, size, content, checksum, sha256, description } = parsedBody;
    if (typeof recipient !== 'string' || recipient.trim().length === 0) {
      this.writeJsonResponse(stream, 400, {
        error: { code: 'VALIDATION_ERROR', message: 'Recipient must be a non-empty string' },
      });
      return;
    }
    if (typeof filePath !== 'string' || filePath.trim().length === 0) {
      this.writeJsonResponse(stream, 400, {
        error: { code: 'VALIDATION_ERROR', message: 'Path must be a non-empty string' },
      });
      return;
    }

    const fileId = `file_${randomUUID().replace(/-/g, '')}`;
    const effectiveFilename = typeof filename === 'string' && filename.length > 0 ? filename : filePath.split('/').pop() || 'file';
    const effectiveSize = typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 ? size : 0;
    const effectiveSha256 = typeof sha256 === 'string' ? sha256 : (typeof checksum === 'string' ? checksum.replace(/^sha256:/, '') : '');
    const timestamp = new Date().toISOString();
    const ext = effectiveFilename.includes('.') ? `.${effectiveFilename.split('.').pop()}` : '';

    let matchedSessionId: string | null = null;
    let matchedSpaceId: string | null = null;

    // 1. Insert into file_metadata table if SQLite DB is available
    if (this.db) {
      try {
        const routeRow = this.db.prepare(
          'SELECT id, space_id FROM session_routes WHERE (id = ? OR dsh_session_id = ?) AND user_id = ? LIMIT 1'
        ).get(recipient, recipient, this.platformUserId) as { id: string; space_id: string } | undefined;
        if (routeRow) {
          matchedSessionId = routeRow.id;
          matchedSpaceId = routeRow.space_id;
        }

        const effectiveDescription = typeof description === 'string' && description.trim().length > 0 ? description.trim() : null;

        this.db.prepare(`
          INSERT INTO file_metadata (
            id, user_id, filename, relative_path, size, mime_type, extension, checksum, recipient, description, metadata, created_at
          ) VALUES (?, ?, ?, ?, ?, 'application/octet-stream', ?, ?, ?, ?, ?, ?)
        `).run(
          fileId,
          this.platformUserId,
          effectiveFilename,
          filePath,
          effectiveSize,
          ext,
          effectiveSha256 || null,
          recipient,
          effectiveDescription,
          null,
          timestamp
        );

        if (matchedSessionId) {
          const msgContent = effectiveDescription
            ? `[File: ${effectiveFilename}] ${effectiveDescription}`
            : `[File: ${effectiveFilename}] (${effectiveSize} bytes)`;
          const fileMeta = {
            fileId,
            path: filePath,
            size: effectiveSize,
            filename: effectiveFilename,
            ...(matchedSpaceId ? { fileReference: `/api/spaces/${encodeURIComponent(matchedSpaceId)}/files/download?path=${encodeURIComponent(filePath)}` } : {}),
          };
          this.db.prepare(`
            INSERT INTO web_messages (
              id, session_id, user_id, role, content, status, route_key, metadata, created_at
            ) VALUES (?, ?, ?, 'assistant', ?, 'delivered', ?, ?, ?)
          `).run(
            `msg_${randomUUID().replace(/-/g, '')}`,
            matchedSessionId,
            this.platformUserId,
            msgContent,
            `session:${matchedSessionId}`,
            JSON.stringify(fileMeta),
            timestamp
          );
        }
      } catch (_dbErr: unknown) {
        // File metadata insertion error contained
      }
    }

    // 2. Delegate to operations if available
    if (this.operations) {
      try {
        await this.operations.forTenant(this.platformUserId).files.sendFile({
          recipient,
          path: filePath,
          filename: effectiveFilename,
          size: effectiveSize,
          checksum: effectiveSha256,
        });
      } catch (_opErr: unknown) {
        // Operations recording error contained
      }
    }

    this.writeJsonResponse(stream, 200, {
      success: true,
      fileId,
      id: fileId,
      path: filePath,
      size: effectiveSize,
      recipient,
      ...(matchedSpaceId ? { fileReference: `/api/spaces/${encodeURIComponent(matchedSpaceId)}/files/download?path=${encodeURIComponent(filePath)}` } : {}),
    });
  }

  /**
   * Handles POST /api/manage/tasks
   */
  private async handleCreateTask(req: ParsedHttpRequest, stream: Duplex): Promise<void> {
    if (!this.platformUserId) {
      this.writeJsonResponse(stream, 503, {
        error: { code: 'OPERATIONS_UNAVAILABLE', message: 'Platform proxy requires authoritative platformUserId binding' },
      });
      return;
    }

    if (req.body.length > this.maxBodyBytes) {
      this.writeJsonResponse(stream, 413, {
        error: { code: 'PAYLOAD_TOO_LARGE', message: `Task payload exceeds maximum limit of ${this.maxBodyBytes} bytes` },
      });
      return;
    }

    // Require exact canonical lowercase UUID-v4 Idempotency-Key header
    const idempotencyKey = req.headers['idempotency-key'];
    if (!idempotencyKey || typeof idempotencyKey !== 'string' || !CANONICAL_UUID_V4_REGEX.test(idempotencyKey)) {
      this.writeJsonResponse(stream, 400, {
        error: { code: 'VALIDATION_ERROR', message: 'Authoritative canonical lowercase UUID-v4 Idempotency-Key header is required' },
      });
      return;
    }

    let parsedBody: Record<string, unknown>;
    try {
      const parsed = JSON.parse(req.body.toString('utf8'));
      if (!isRecord(parsed)) {
        this.writeJsonResponse(stream, 400, {
          error: { code: 'VALIDATION_ERROR', message: 'Request body must be an object' },
        });
        return;
      }
      parsedBody = parsed;
    } catch (_parseErr: unknown) {
      this.writeJsonResponse(stream, 400, {
        error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON' },
      });
      return;
    }

    const { title, prompt, sessionId, priority, dueDate } = parsedBody;

    // Strict validation
    if (typeof title !== 'string' || title.length === 0 || title !== title.trim() || title.length > 256) {
      this.writeJsonResponse(stream, 400, {
        error: { code: 'VALIDATION_ERROR', message: 'Task title must be a non-empty trimmed string up to 256 characters' },
      });
      return;
    }

    if (typeof prompt !== 'string' || prompt.trim().length === 0 || Buffer.byteLength(prompt, 'utf8') > 65536) {
      this.writeJsonResponse(stream, 400, {
        error: { code: 'VALIDATION_ERROR', message: 'Task prompt must be a non-empty string under 64 KiB' },
      });
      return;
    }

    if (typeof sessionId !== 'string' || !CANONICAL_SESSION_ID_REGEX.test(sessionId)) {
      this.writeJsonResponse(stream, 400, {
        error: { code: 'VALIDATION_ERROR', message: 'Canonical platform sessionId is required' },
      });
      return;
    }

    const validPriorities = new Set(['low', 'medium', 'high', 'urgent']);
    if (priority !== undefined && !validPriorities.has(priority as string)) {
      this.writeJsonResponse(stream, 400, {
        error: { code: 'VALIDATION_ERROR', message: 'Invalid priority. Allowed: low, medium, high, urgent' },
      });
      return;
    }

    if (dueDate !== undefined && dueDate !== null) {
      if (typeof dueDate !== 'string' || Number.isNaN(new Date(dueDate).getTime()) || new Date(dueDate).toISOString() !== dueDate) {
        this.writeJsonResponse(stream, 400, {
          error: { code: 'VALIDATION_ERROR', message: 'dueDate must be an exact ISO 8601 UTC string' },
        });
        return;
      }
    }

    const taskPriority: TaskPriority = isTaskPriority(priority) ? priority : 'medium';

    // Call operations.createTask if operations is configured
    if (this.operations) {
      try {
        const payload = {
          type: 'agent_prompt' as const,
          prompt,
          sessionId,
          sessionPolicy: 'existing_session' as const,
        };

        const result = await this.operations.forTenant(this.platformUserId).tasks.createTask({
          title,
          dueDate: typeof dueDate === 'string' ? dueDate : undefined,
          priority: taskPriority,
          idempotencyKey,
          payload,
        });

        this.writeJsonResponse(stream, 201, {
          success: true,
          data: {
            isIdempotentHit: result.isIdempotentHit,
            task: {
              id: result.task.id,
              title: result.task.title,
              status: result.task.status,
              priority: result.task.priority || 'medium',
              dueDate: result.task.dueDate ?? null,
              createdAt: result.task.createdAt || new Date().toISOString(),
            },
          },
        });
        return;
      } catch (_err: unknown) {
        this.writeJsonResponse(stream, 500, { error: { code: 'TASK_ERROR', message: 'Task creation failed' } });
        return;
      }
    }

    // Direct SQLite fallback if DB is available
    if (this.db) {
      try {
        const existing = this.db.prepare(
          'SELECT id, title, status, priority, due_date, created_at FROM platform_tasks WHERE user_id = ? AND idempotency_key = ? LIMIT 1'
        ).get(this.platformUserId, idempotencyKey) as StoredTaskRow | undefined;

        if (existing) {
          this.writeJsonResponse(stream, 200, {
            success: true,
            data: {
              isIdempotentHit: true,
              task: {
                id: existing.id,
                title: existing.title,
                status: existing.status,
                priority: existing.priority,
                dueDate: existing.due_date ?? null,
                createdAt: existing.created_at,
              },
            },
          });
          return;
        }

        const taskId = `task_${randomUUID().replace(/-/g, '')}`;
        const createdAt = new Date().toISOString();

        this.db.prepare(`
          INSERT INTO platform_tasks (
            id, user_id, idempotency_key, title, status, priority, due_date, payload, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
        `).run(
          taskId,
          this.platformUserId,
          idempotencyKey,
          title,
          taskPriority,
          (typeof dueDate === 'string' ? dueDate : null),
          JSON.stringify({ type: 'agent_prompt', prompt, sessionId }),
          createdAt,
          createdAt
        );

        this.writeJsonResponse(stream, 201, {
          success: true,
          data: {
            isIdempotentHit: false,
            task: {
              id: taskId,
              title,
              status: 'pending',
              priority: taskPriority,
              dueDate: typeof dueDate === 'string' ? dueDate : null,
              createdAt,
            },
          },
        });
        return;
      } catch (_err: unknown) {
        this.writeJsonResponse(stream, 500, { error: { code: 'TASK_ERROR', message: 'Task creation failed' } });
        return;
      }
    }

    this.writeJsonResponse(stream, 503, {
      error: { code: 'OPERATIONS_UNAVAILABLE', message: 'Platform Operations service is unavailable' },
    });
  }

  /**
   * Handles POST /api/events, POST /events, and POST /api/events/batch
   * Ingests streaming event frames from container, sanitizes payloads, and persists into SQLite web_events.
   */
  private async handlePublishEvents(req: ParsedHttpRequest, stream: Duplex): Promise<void> {
    if (!this.platformUserId) {
      this.writeJsonResponse(stream, 503, {
        error: { code: 'OPERATIONS_UNAVAILABLE', message: 'Platform proxy requires authoritative platformUserId binding' },
      });
      return;
    }

    if (req.body.length > this.maxBodyBytes) {
      this.writeJsonResponse(stream, 413, {
        error: { code: 'PAYLOAD_TOO_LARGE', message: `Events payload exceeds maximum limit of ${this.maxBodyBytes} bytes` },
      });
      return;
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(req.body.toString('utf8'));
    } catch (_parseErr: unknown) {
      this.writeJsonResponse(stream, 400, {
        error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON' },
      });
      return;
    }

    if (!parsedBody || (typeof parsedBody !== 'object' && !Array.isArray(parsedBody))) {
      this.writeJsonResponse(stream, 400, {
        error: { code: 'VALIDATION_ERROR', message: 'Request body must be an object or array' },
      });
      return;
    }

    const rawEvents: unknown[] = Array.isArray(parsedBody)
      ? parsedBody
      : isRecord(parsedBody) && Array.isArray(parsedBody['events'])
        ? parsedBody['events']
        : isRecord(parsedBody) && parsedBody['event']
          ? [parsedBody['event']]
          : [];

    if (rawEvents.length === 0) {
      this.writeJsonResponse(stream, 200, {
        success: true,
        count: 0,
      });
      return;
    }

    let insertedCount = 0;

    if (this.db) {
      const nowIso = new Date().toISOString();
      const insertStmt = this.db.prepare(`
        INSERT OR REPLACE INTO web_events (id, session_id, user_id, type, payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      let lastTimeMs = 0;
      try {
        for (const raw of rawEvents) {
          if (!isRecord(raw)) continue;

          const rawSessionId = typeof raw['sessionId'] === 'string' ? raw['sessionId'] : (typeof raw['session_id'] === 'string' ? raw['session_id'] : undefined);
          if (!rawSessionId || !rawSessionId.trim()) continue;

          // Resolve canonical user ID and session ID for tenant
          let targetSessionId = rawSessionId.trim();
          let targetUserId = this.platformUserId;
          try {
            const routeRow = this.db.prepare(
              'SELECT id, user_id FROM session_routes WHERE (id = ? OR dsh_session_id = ?) AND user_id = ? LIMIT 1'
            ).get(targetSessionId, targetSessionId, this.platformUserId) as { id: string; user_id?: string } | undefined;
            if (routeRow) {
              targetSessionId = routeRow.id;
              if (routeRow.user_id) {
                targetUserId = routeRow.user_id;
              }
            }
          } catch (_lookupErr: unknown) {
            // Retain raw targetSessionId on query error
          }

          const rawCreatedAt = typeof raw['createdAt'] === 'string' && raw['createdAt'].length > 0 ? raw['createdAt'] : nowIso;
          let rawTimeMs = new Date(rawCreatedAt).getTime();
          if (Number.isNaN(rawTimeMs) || rawTimeMs <= lastTimeMs) {
            rawTimeMs = Math.max(Date.now(), lastTimeMs + 1);
          }
          lastTimeMs = rawTimeMs;
          const createdAt = new Date(rawTimeMs).toISOString();

          const timeHex = rawTimeMs.toString(16).padStart(12, '0');
          const randHex = randomUUID().replace(/-/g, '').slice(0, 20);
          const eventId = typeof raw['id'] === 'string' && raw['id'].length > 0 ? raw['id'] : `evt_${timeHex}${randHex}`;
          const rawType = raw['type'];
          const p = isRecord(raw['payload']) ? raw['payload'] : {};

          let eventType = 'turn_status';
          let sanitizedPayload: Record<string, unknown> = {};

          switch (rawType) {
            case 'turn_started': {
              eventType = 'turn_status';
              sanitizedPayload = { status: 'running' };
              break;
            }
            case 'assistant_delta': {
              eventType = 'assistant_delta';
              const streamId = typeof p['streamId'] === 'string' ? p['streamId'] : `msgstream_${randomUUID().replace(/-/g, '')}`;
              const delta = typeof p['delta'] === 'string' ? p['delta'] : '';
              const accumulatedLength = typeof p['accumulatedLength'] === 'number' && Number.isFinite(p['accumulatedLength'])
                ? p['accumulatedLength']
                : delta.length;
              sanitizedPayload = { streamId, delta, accumulatedLength };
              break;
            }
            case 'assistant_stream_end': {
              eventType = 'assistant_stream_end';
              const streamId = typeof p['streamId'] === 'string' ? p['streamId'] : `msgstream_${randomUUID().replace(/-/g, '')}`;
              sanitizedPayload = { streamId };
              break;
            }
            case 'thinking_delta':
            case 'thinking': {
              eventType = 'thinking';
              const streamId = typeof p['streamId'] === 'string' ? p['streamId'] : undefined;
              sanitizedPayload = {
                status: 'thinking',
                ...(streamId ? { streamId } : {}),
              };
              break;
            }
            case 'tool_started': {
              eventType = 'tool_status';
              const rawName = p['toolName'] ?? p['name'];
              sanitizedPayload = {
                toolName: typeof rawName === 'string' ? rawName.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 64) : 'tool',
                status: 'started',
              };
              break;
            }
            case 'tool_completed': {
              eventType = 'tool_status';
              const rawName = p['toolName'] ?? p['name'];
              const rawStatus = p['status'] === 'failed' ? 'failed' : 'completed';
              sanitizedPayload = {
                toolName: typeof rawName === 'string' ? rawName.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 64) : 'tool',
                status: rawStatus,
              };
              break;
            }
            case 'tool_status': {
              eventType = 'tool_status';
              const rawName = p['toolName'] ?? p['name'];
              const rawStatus = (p['status'] === 'started' || p['status'] === 'completed' || p['status'] === 'failed') ? p['status'] : 'started';
              sanitizedPayload = {
                toolName: typeof rawName === 'string' ? rawName.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 64) : 'tool',
                status: rawStatus,
              };
              break;
            }
            case 'turn_completed': {
              eventType = 'turn_status';
              sanitizedPayload = { status: 'completed' };
              break;
            }
            case 'turn_failed': {
              eventType = 'turn_status';
              sanitizedPayload = {
                status: 'failed',
                code: typeof p['code'] === 'string' ? p['code'] : 'TURN_FAILED',
              };
              break;
            }
            case 'turn_cancelled': {
              eventType = 'turn_status';
              sanitizedPayload = {
                status: 'interrupted',
                code: 'TURN_CANCELLED',
              };
              break;
            }
            case 'turn_status': {
              eventType = 'turn_status';
              const status = typeof p['status'] === 'string' ? p['status'] : 'running';
              sanitizedPayload = {
                status,
                ...(typeof p['code'] === 'string' ? { code: p['code'] } : {}),
              };
              break;
            }
            case 'message': {
              eventType = 'message';
              const rawMsg = isRecord(p['message']) ? p['message'] : p;
              sanitizedPayload = {
                message: {
                  id: typeof rawMsg['id'] === 'string' ? rawMsg['id'] : `msg_${randomUUID().replace(/-/g, '')}`,
                  role: rawMsg['role'] === 'user' || rawMsg['role'] === 'assistant' || rawMsg['role'] === 'system' ? rawMsg['role'] : 'assistant',
                  content: typeof rawMsg['content'] === 'string' ? rawMsg['content'] : '',
                  status: rawMsg['status'] === 'pending' || rawMsg['status'] === 'failed' ? rawMsg['status'] : 'delivered',
                  createdAt: typeof rawMsg['createdAt'] === 'string' ? rawMsg['createdAt'] : createdAt,
                },
              };
              break;
            }
            case 'error': {
              eventType = 'error';
              sanitizedPayload = {
                code: typeof p['code'] === 'string' ? p['code'] : 'INTERNAL_ERROR',
              };
              break;
            }
            default:
              continue;
          }

          insertStmt.run(
            eventId,
            targetSessionId,
            targetUserId,
            eventType,
            JSON.stringify(sanitizedPayload),
            createdAt
          );
          insertedCount++;
        }
      } catch (err: unknown) {
        throw err;
      }
    }

    this.writeJsonResponse(stream, 200, {
      success: true,
      count: insertedCount,
    });
  }

  /**
   * Resolves session and space identity for the authenticated tenant.
   * Prevents cross-tenant spoofing by strictly filtering by user_id = platformUserId.
   */
  private async resolveSessionRoute(
    rawSessionId?: string
  ): Promise<{ matchedSessionId: string; matchedSpaceId: string; dshSessionId: string } | null> {
    if (!this.platformUserId) return null;
    if (!rawSessionId || typeof rawSessionId !== 'string' || !rawSessionId.trim()) {
      return null;
    }

    const targetId = rawSessionId.trim();

    if (this.db) {
      try {
        const row = this.db
          .prepare(
            'SELECT id, space_id, dsh_session_id FROM session_routes WHERE (id = ? OR dsh_session_id = ?) AND user_id = ? LIMIT 1'
          )
          .get(targetId, targetId, this.platformUserId) as
          | { id: string; space_id: string; dsh_session_id: string }
          | undefined;

        if (row) {
          return {
            matchedSessionId: row.id,
            matchedSpaceId: row.space_id,
            dshSessionId: row.dsh_session_id || row.id,
          };
        }
      } catch (_dbErr: unknown) {
        // Fall through to storage lookup
      }
    }

    if (this.storage) {
      try {
        const sessionRoutesRepo = this.storage.forTenant(this.platformUserId).sessionRoutes;
        const route = await sessionRoutesRepo.findById(targetId);
        if (route) {
          return {
            matchedSessionId: route.id,
            matchedSpaceId: route.spaceId,
            dshSessionId: (route as any).dshSessionId || route.id,
          };
        }
      } catch (_stErr: unknown) {
        // Not found
      }
    }

    return null;
  }

  /**
   * Consumes single quota unit for API calls if operations quota service is configured.
   */
  private async consumeQuota(): Promise<boolean> {
    if (!this.platformUserId || !this.operations) return true;
    try {
      const tenantQuota = this.operations.forTenant(this.platformUserId).quota;
      if (tenantQuota) {
        let hasLimit = false;
        if (typeof tenantQuota.getLimit === 'function') {
          const lim = await tenantQuota.getLimit('api_calls');
          if (lim && typeof lim.limit === 'number' && lim.limit > 0) {
            hasLimit = true;
          }
        }
        if (hasLimit && typeof tenantQuota.reserveQuota === 'function') {
          const resv = await tenantQuota.reserveQuota({ resource: 'api_calls', amount: 1, ttlSeconds: 60 });
          if (resv && typeof tenantQuota.commitQuota === 'function') {
            await tenantQuota.commitQuota({ reservationId: resv.id, actualAmount: 1 });
          }
        }
      }
      return true;
    } catch (err: any) {
      if (err?.code === 'QUOTA_EXCEEDED' || err?.name === 'QuotaExceededError') {
        return false;
      }
      return true;
    }
  }

  /**
   * Records audit log with sensitive parameter redaction (NO query parameters, NO form values).
   */
  private async recordAuditLog(
    action:
      | 'browser.open'
      | 'browser.snapshot'
      | 'browser.interact'
      | 'browser.screenshot'
      | 'browser.close'
      | 'mcp.call'
      | 'mcp.cancel',
    details: Record<string, unknown>
  ): Promise<void> {
    if (!this.platformUserId) return;
    const auditId = `aud_${randomUUID().replace(/-/g, '')}`;
    const nowIso = new Date().toISOString();

    if (this.storage?.auditLogs) {
      try {
        await this.storage.auditLogs.create({
          id: auditId,
          userId: this.platformUserId,
          action: action as any,
          details,
        });
        return;
      } catch (_err) {}
    }

    if (this.db) {
      try {
        this.db
          .prepare(
            `INSERT INTO auth_audit_log (id, user_id, action, details, created_at)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(auditId, this.platformUserId, action, JSON.stringify(details), nowIso);
      } catch (_dbErr) {}
    }
  }

  /**
   * Maps browser errors safely to standardized machine-readable public error codes.
   */
  private handleBrowserError(stream: Duplex, err: any): void {
    const code = err?.code || '';
    const message = err?.message || 'Browser operation failed';

    if (
      code === 'BROWSER_SSRF_BLOCKED' ||
      code === 'SSRF_BLOCKED' ||
      /ssrf|loopback|private ip|metadata|restricted/i.test(message)
    ) {
      this.writeJsonResponse(stream, 400, {
        error: { code: 'SSRF_BLOCKED', message: 'Target URL is blocked by security policy' },
      });
      return;
    }

    if (code === 'BROWSER_TIMEOUT' || /timeout/i.test(message)) {
      this.writeJsonResponse(stream, 408, {
        error: { code: 'BROWSER_TIMEOUT', message: 'Browser operation timed out' },
      });
      return;
    }

    if (code === 'BROWSER_PAGE_NOT_FOUND' || /page not found/i.test(message)) {
      this.writeJsonResponse(stream, 404, {
        error: { code: 'PAGE_NOT_FOUND', message: 'Browser page not found' },
      });
      return;
    }

    if (code === 'BROWSER_INVALID_REF' || /invalid ref/i.test(message)) {
      this.writeJsonResponse(stream, 400, {
        error: { code: 'INVALID_REF', message: 'Invalid or expired element reference' },
      });
      return;
    }

    if (code === 'BROWSER_UNAVAILABLE' || /unavailable/i.test(message)) {
      this.writeJsonResponse(stream, 503, {
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Browser service is unavailable' },
      });
      return;
    }

    this.writeJsonResponse(stream, 500, {
      error: { code: 'INTERNAL_ERROR', message: 'Browser operation failed' },
    });
  }

  /**
   * Handles POST /api/browser/open
   */
  private async handleBrowserOpen(req: ParsedHttpRequest, stream: Duplex): Promise<void> {
    if (!this.platformUserId) {
      this.writeJsonResponse(stream, 503, {
        error: { code: 'OPERATIONS_UNAVAILABLE', message: 'Platform proxy requires authoritative platformUserId binding' },
      });
      return;
    }

    if (req.body.length > this.maxBodyBytes) {
      this.writeJsonResponse(stream, 413, {
        error: { code: 'PAYLOAD_TOO_LARGE', message: `Payload exceeds maximum limit of ${this.maxBodyBytes} bytes` },
      });
      return;
    }

    let parsedBody: Record<string, unknown>;
    try {
      const parsed = JSON.parse(req.body.toString('utf8'));
      if (!isRecord(parsed)) {
        this.writeJsonResponse(stream, 400, {
          error: { code: 'VALIDATION_ERROR', message: 'Request body must be an object' },
        });
        return;
      }
      parsedBody = parsed;
    } catch (_parseErr: unknown) {
      this.writeJsonResponse(stream, 400, {
        error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON' },
      });
      return;
    }

    const { url, sessionId, timeoutMs } = parsedBody;

    if (typeof url !== 'string' || !url.trim()) {
      this.writeJsonResponse(stream, 400, {
        error: { code: 'VALIDATION_ERROR', message: 'url must be a non-empty string' },
      });
      return;
    }

    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      this.writeJsonResponse(stream, 400, {
        error: { code: 'VALIDATION_ERROR', message: 'sessionId must be a non-empty string' },
      });
      return;
    }

    // Verify session belongs to authenticated user/space (prevents tenant spoofing)
    const route = await this.resolveSessionRoute(sessionId);
    if (!route) {
      this.writeJsonResponse(stream, 403, {
        error: { code: 'FORBIDDEN', message: 'Session does not belong to authorized tenant or space' },
      });
      return;
    }

    // Enforce quota
    const quotaAllowed = await this.consumeQuota();
    if (!quotaAllowed) {
      this.writeJsonResponse(stream, 429, {
        error: { code: 'QUOTA_EXCEEDED', message: 'Quota exceeded for api_calls' },
      });
      return;
    }

    // Safe audit logging: extract hostname and pathname only (strip query params / secrets)
    let safeHostname = 'unknown';
    let safePath = '/';
    try {
      const parsed = new URL(url.trim());
      safeHostname = parsed.hostname;
      safePath = parsed.pathname;
    } catch {
      safeHostname = 'unknown';
      safePath = '/';
    }

    await this.recordAuditLog('browser.open', {
      hostname: safeHostname,
      path: safePath,
      sessionId: route.matchedSessionId,
      spaceId: route.matchedSpaceId,
    });

    try {
      const result = await this.browserService!.open({
        sessionKey: {
          userId: this.platformUserId,
          spaceId: route.matchedSpaceId,
          sessionId: route.matchedSessionId,
        },
        url: url.trim(),
        timeoutMs: typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : undefined,
      });

      this.writeJsonResponse(stream, 200, {
        success: true,
        data: result,
        pageId: result.pageId,
        url: result.url,
        title: result.title,
      });
    } catch (err: unknown) {
      this.handleBrowserError(stream, err);
    }
  }

  /**
   * Handles POST /api/browser/snapshot
   */
  private async handleBrowserSnapshot(req: ParsedHttpRequest, stream: Duplex): Promise<void> {
    if (!this.platformUserId) {
      this.writeJsonResponse(stream, 503, {
        error: { code: 'OPERATIONS_UNAVAILABLE', message: 'Platform proxy requires authoritative platformUserId binding' },
      });
      return;
    }

    if (req.body.length > this.maxBodyBytes) {
      this.writeJsonResponse(stream, 413, {
        error: { code: 'PAYLOAD_TOO_LARGE', message: `Payload exceeds maximum limit of ${this.maxBodyBytes} bytes` },
      });
      return;
    }

    let parsedBody: Record<string, unknown>;
    try {
      const parsed = JSON.parse(req.body.toString('utf8'));
      if (!isRecord(parsed)) {
        this.writeJsonResponse(stream, 400, {
          error: { code: 'VALIDATION_ERROR', message: 'Request body must be an object' },
        });
        return;
      }
      parsedBody = parsed;
    } catch (_parseErr: unknown) {
      this.writeJsonResponse(stream, 400, {
        error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON' },
      });
      return;
    }

    const { pageId, sessionId, maxNodes, maxBytes } = parsedBody;

    if (typeof pageId !== 'string' || !pageId.trim()) {
      this.writeJsonResponse(stream, 400, {
        error: { code: 'VALIDATION_ERROR', message: 'pageId must be a non-empty string' },
      });
      return;
    }

    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      this.writeJsonResponse(stream, 400, {
        error: { code: 'VALIDATION_ERROR', message: 'sessionId must be a non-empty string' },
      });
      return;
    }

    const route = await this.resolveSessionRoute(sessionId);
    if (!route) {
      this.writeJsonResponse(stream, 403, {
        error: { code: 'FORBIDDEN', message: 'Session does not belong to authorized tenant or space' },
      });
      return;
    }

    // Enforce quota
    const quotaAllowed = await this.consumeQuota();
    if (!quotaAllowed) {
      this.writeJsonResponse(stream, 429, {
        error: { code: 'QUOTA_EXCEEDED', message: 'Quota exceeded for api_calls' },
      });
      return;
    }

    await this.recordAuditLog('browser.snapshot', {
      pageId: pageId.trim(),
      sessionId: route.matchedSessionId,
      spaceId: route.matchedSpaceId,
    });

    try {
      const result = await this.browserService!.snapshot({
        sessionKey: {
          userId: this.platformUserId,
          spaceId: route.matchedSpaceId,
          sessionId: route.matchedSessionId,
        },
        pageId: pageId.trim(),
        maxNodes: typeof maxNodes === 'number' && maxNodes > 0 ? maxNodes : undefined,
        maxBytes: typeof maxBytes === 'number' && maxBytes > 0 ? maxBytes : undefined,
      });

      this.writeJsonResponse(stream, 200, {
        success: true,
        data: result,
        pageId: result.pageId,
        url: result.url,
        title: result.title,
        root: result.root,
        nodeCount: result.nodeCount,
        truncated: result.truncated,
        textSummary: result.textSummary,
        snapshot: result.textSummary,
      });
    } catch (err: unknown) {
      this.handleBrowserError(stream, err);
    }
  }

  /**
   * Handles POST /api/browser/interact
   */
  private async handleBrowserInteract(req: ParsedHttpRequest, stream: Duplex): Promise<void> {
    if (!this.platformUserId) {
      this.writeJsonResponse(stream, 503, {
        error: { code: 'OPERATIONS_UNAVAILABLE', message: 'Platform proxy requires authoritative platformUserId binding' },
      });
      return;
    }

    if (req.body.length > this.maxBodyBytes) {
      this.writeJsonResponse(stream, 413, {
        error: { code: 'PAYLOAD_TOO_LARGE', message: `Payload exceeds maximum limit of ${this.maxBodyBytes} bytes` },
      });
      return;
    }

    let parsedBody: Record<string, unknown>;
    try {
      const parsed = JSON.parse(req.body.toString('utf8'));
      if (!isRecord(parsed)) {
        this.writeJsonResponse(stream, 400, {
          error: { code: 'VALIDATION_ERROR', message: 'Request body must be an object' },
        });
        return;
      }
      parsedBody = parsed;
    } catch (_parseErr: unknown) {
      this.writeJsonResponse(stream, 400, {
        error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON' },
      });
      return;
    }

    const { pageId, sessionId, action, ref, value, key, timeoutMs } = parsedBody;

    if (typeof pageId !== 'string' || !pageId.trim()) {
      this.writeJsonResponse(stream, 400, {
        error: { code: 'VALIDATION_ERROR', message: 'pageId must be a non-empty string' },
      });
      return;
    }

    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      this.writeJsonResponse(stream, 400, {
        error: { code: 'VALIDATION_ERROR', message: 'sessionId must be a non-empty string' },
      });
      return;
    }

    if (action !== 'click' && action !== 'fill' && action !== 'press' && action !== 'select') {
      this.writeJsonResponse(stream, 400, {
        error: { code: 'VALIDATION_ERROR', message: 'action must be one of: click, fill, press, select' },
      });
      return;
    }

    if (typeof ref !== 'string' || !ref.trim()) {
      this.writeJsonResponse(stream, 400, {
        error: { code: 'VALIDATION_ERROR', message: 'ref must be a non-empty string' },
      });
      return;
    }

    const route = await this.resolveSessionRoute(sessionId);
    if (!route) {
      this.writeJsonResponse(stream, 403, {
        error: { code: 'FORBIDDEN', message: 'Session does not belong to authorized tenant or space' },
      });
      return;
    }

    // Enforce quota
    const quotaAllowed = await this.consumeQuota();
    if (!quotaAllowed) {
      this.writeJsonResponse(stream, 429, {
        error: { code: 'QUOTA_EXCEEDED', message: 'Quota exceeded for api_calls' },
      });
      return;
    }

    // Safe audit: record action and ref, NEVER record input value or form fill content!
    await this.recordAuditLog('browser.interact', {
      pageId: pageId.trim(),
      action,
      ref: ref.trim(),
      sessionId: route.matchedSessionId,
      spaceId: route.matchedSpaceId,
    });

    try {
      const result = await this.browserService!.interact({
        sessionKey: {
          userId: this.platformUserId,
          spaceId: route.matchedSpaceId,
          sessionId: route.matchedSessionId,
        },
        pageId: pageId.trim(),
        action,
        ref: ref.trim(),
        value: typeof value === 'string' ? value : undefined,
        key: typeof key === 'string' ? key : undefined,
        timeoutMs: typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : undefined,
      });

      this.writeJsonResponse(stream, 200, {
        success: result.success,
        data: result,
        pageId: result.pageId,
        ref: result.ref,
        action: result.action,
        navigationOccurred: result.navigationOccurred,
        currentUrl: result.currentUrl,
        message: result.message,
      });
    } catch (err: unknown) {
      this.handleBrowserError(stream, err);
    }
  }

  /**
   * Handles POST /api/browser/screenshot
   */
  private async handleBrowserScreenshot(req: ParsedHttpRequest, stream: Duplex): Promise<void> {
    if (!this.platformUserId) {
      this.writeJsonResponse(stream, 503, {
        error: { code: 'OPERATIONS_UNAVAILABLE', message: 'Platform proxy requires authoritative platformUserId binding' },
      });
      return;
    }

    if (req.body.length > this.maxBodyBytes) {
      this.writeJsonResponse(stream, 413, {
        error: { code: 'PAYLOAD_TOO_LARGE', message: `Payload exceeds maximum limit of ${this.maxBodyBytes} bytes` },
      });
      return;
    }

    let parsedBody: Record<string, unknown>;
    try {
      const parsed = JSON.parse(req.body.toString('utf8'));
      if (!isRecord(parsed)) {
        this.writeJsonResponse(stream, 400, {
          error: { code: 'VALIDATION_ERROR', message: 'Request body must be an object' },
        });
        return;
      }
      parsedBody = parsed;
    } catch (_parseErr: unknown) {
      this.writeJsonResponse(stream, 400, {
        error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON' },
      });
      return;
    }

    const { pageId, sessionId, fullPage, timeoutMs } = parsedBody;

    if (typeof pageId !== 'string' || !pageId.trim()) {
      this.writeJsonResponse(stream, 400, {
        error: { code: 'VALIDATION_ERROR', message: 'pageId must be a non-empty string' },
      });
      return;
    }

    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      this.writeJsonResponse(stream, 400, {
        error: { code: 'VALIDATION_ERROR', message: 'sessionId must be a non-empty string' },
      });
      return;
    }

    const route = await this.resolveSessionRoute(sessionId);
    if (!route) {
      this.writeJsonResponse(stream, 403, {
        error: { code: 'FORBIDDEN', message: 'Session does not belong to authorized tenant or space' },
      });
      return;
    }

    // Enforce quota
    const quotaAllowed = await this.consumeQuota();
    if (!quotaAllowed) {
      this.writeJsonResponse(stream, 429, {
        error: { code: 'QUOTA_EXCEEDED', message: 'Quota exceeded for api_calls' },
      });
      return;
    }

    try {
      const result = await this.browserService!.screenshot({
        sessionKey: {
          userId: this.platformUserId,
          spaceId: route.matchedSpaceId,
          sessionId: route.matchedSessionId,
        },
        pageId: pageId.trim(),
        fullPage: fullPage === true,
        timeoutMs: typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : undefined,
      });

      // Max 10MB limit enforcement on screenshot payload
      if (result.buffer.length > this.maxFileSizeBytes) {
        this.writeJsonResponse(stream, 413, {
          error: {
            code: 'PAYLOAD_TOO_LARGE',
            message: `Screenshot exceeds maximum limit of ${this.maxFileSizeBytes} bytes (10MB)`,
          },
        });
        return;
      }

      // Persist screenshot atomically under artifacts/browser/<opaque>.png
      const opaqueId = randomUUID().replace(/-/g, '');
      const relativePath = `artifacts/browser/${opaqueId}.png`;
      const filename = `${opaqueId}.png`;
      const fileId = `file_${opaqueId}`;
      const effectiveSpaceId = route.matchedSpaceId || 'default';
      const downloadUrl = `/api/spaces/${encodeURIComponent(effectiveSpaceId)}/files/download?path=${encodeURIComponent(relativePath)}`;

      if (this.fileProvider) {
        try {
          await this.fileProvider.execute(this.platformUserId, effectiveSpaceId, {
            op: 'write',
            path: relativePath,
            content: result.buffer.toString('base64'),
            encoding: 'base64',
            requireAbsent: true,
          });
        } catch (_fileErr: unknown) {
          // File provider error contained
        }
      }

      if (this.db) {
        try {
          const timestamp = new Date().toISOString();
          this.db
            .prepare(
              `INSERT INTO file_metadata (
                id, user_id, filename, relative_path, size, mime_type, extension, checksum, recipient, description, metadata, created_at
              ) VALUES (?, ?, ?, ?, ?, 'image/png', '.png', ?, ?, ?, ?, ?)`
            )
            .run(
              fileId,
              this.platformUserId,
              filename,
              relativePath,
              result.buffer.length,
              null,
              route.matchedSessionId ?? null,
              `Screenshot of page ${pageId.trim()}`,
              JSON.stringify({ width: result.dimensions.width, height: result.dimensions.height }),
              timestamp
            );
        } catch (_dbErr: unknown) {
          // DB metadata insertion error contained
        }
      }

      await this.recordAuditLog('browser.screenshot', {
        pageId: pageId.trim(),
        path: relativePath,
        size: result.buffer.length,
        sessionId: route.matchedSessionId ?? null,
        spaceId: effectiveSpaceId,
      });

      this.writeJsonResponse(stream, 200, {
        success: true,
        data: {
          artifactId: fileId,
          pageId: result.pageId,
          path: relativePath,
          downloadUrl,
          width: result.dimensions.width,
          height: result.dimensions.height,
          sizeBytes: result.buffer.length,
          size: result.buffer.length,
          mimeType: result.mimeType,
        },
        artifactId: fileId,
        pageId: result.pageId,
        path: relativePath,
        downloadUrl,
        width: result.dimensions.width,
        height: result.dimensions.height,
        sizeBytes: result.buffer.length,
        size: result.buffer.length,
      });
    } catch (err: unknown) {
      this.handleBrowserError(stream, err);
    }
  }

  /**
   * Handles POST /api/browser/close
   */
  private async handleBrowserClose(req: ParsedHttpRequest, stream: Duplex): Promise<void> {
    if (!this.platformUserId) {
      this.writeJsonResponse(stream, 503, {
        error: { code: 'OPERATIONS_UNAVAILABLE', message: 'Platform proxy requires authoritative platformUserId binding' },
      });
      return;
    }

    let parsedBody: Record<string, unknown> = {};
    if (req.body.length > 0) {
      try {
        const parsed = JSON.parse(req.body.toString('utf8'));
        if (isRecord(parsed)) {
          parsedBody = parsed;
        }
      } catch (_parseErr: unknown) {
        // Empty or non-JSON body allowed for close
      }
    }

    const { pageId, sessionId, all } = parsedBody;

    let route: { matchedSpaceId: string; matchedSessionId: string } | null = null;
    if (typeof sessionId === 'string' && sessionId.trim()) {
      route = await this.resolveSessionRoute(sessionId);
      if (!route) {
        this.writeJsonResponse(stream, 403, {
          error: { code: 'FORBIDDEN', message: 'Session does not belong to authorized tenant or space' },
        });
        return;
      }
    } else if (typeof pageId === 'string' && pageId.trim() && !all) {
      this.writeJsonResponse(stream, 400, {
        error: { code: 'VALIDATION_ERROR', message: 'sessionId must be provided when closing by pageId' },
      });
      return;
    }

    await this.recordAuditLog('browser.close', {
      pageId: typeof pageId === 'string' ? pageId.trim() : null,
      sessionId: route?.matchedSessionId ?? null,
      spaceId: route?.matchedSpaceId ?? null,
      all: all === true,
    });

    try {
      const sessionKey = route
        ? {
            userId: this.platformUserId,
            spaceId: route.matchedSpaceId,
            sessionId: route.matchedSessionId,
          }
        : undefined;

      const result = await this.browserService!.close({
        sessionKey,
        pageId: typeof pageId === 'string' && pageId.trim() ? pageId.trim() : undefined,
        all: all === true,
      });

      this.writeJsonResponse(stream, 200, {
        success: true,
        data: result,
        closedPages: result.closedPages,
        closedContexts: result.closedContexts,
      });
    } catch (err: unknown) {
      this.handleBrowserError(stream, err);
    }
  }

  /**
   * Handles GET /api/mcp/tools
   */
  private async handleMcpListTools(
    _req: ParsedHttpRequest,
    stream: Duplex,
    searchParams: URLSearchParams
  ): Promise<void> {
    if (!this.mcpService) {
      this.writeJsonResponse(stream, 503, {
        error: { code: 'SERVICE_UNAVAILABLE', message: 'MCP service is not configured' },
      });
      return;
    }

    // Strict query check: reject unknown query parameters
    for (const [key] of searchParams.entries()) {
      if (key !== 'sessionId') {
        this.writeJsonResponse(stream, 400, {
          error: { code: 'VALIDATION_ERROR', message: `Unknown query parameter "${key}"` },
        });
        return;
      }
    }

    const sessionId = searchParams.get('sessionId');
    if (!sessionId || typeof sessionId !== 'string' || !sessionId.trim()) {
      this.writeJsonResponse(stream, 400, {
        error: { code: 'VALIDATION_ERROR', message: 'Missing required query parameter "sessionId"' },
      });
      return;
    }

    const route = await this.resolveSessionRoute(sessionId);
    if ((this.db || this.storage) && !route) {
      this.writeJsonResponse(stream, 403, {
        error: { code: 'FORBIDDEN', message: 'Session does not belong to authorized tenant or space' },
      });
      return;
    }

    const quotaAllowed = await this.consumeQuota();
    if (!quotaAllowed) {
      this.writeJsonResponse(stream, 429, {
        error: { code: 'QUOTA_EXCEEDED', message: 'Quota exceeded for api_calls' },
      });
      return;
    }

    const context: McpProxyContext = {
      userId: this.platformUserId || 'system',
      spaceId: route?.matchedSpaceId,
      sessionId: route?.matchedSessionId ?? sessionId.trim(),
    };

    try {
      const tools = await this.mcpService.listTools(context);
      this.writeJsonResponse(stream, 200, {
        success: true,
        data: { tools },
        tools,
      });
    } catch (err: unknown) {
      this.handleMcpError(stream, err);
    }
  }

  /**
   * Handles POST /api/mcp/call
   */
  private async handleMcpCallTool(
    req: ParsedHttpRequest,
    stream: Duplex
  ): Promise<void> {
    if (!this.mcpService) {
      this.writeJsonResponse(stream, 503, {
        error: { code: 'SERVICE_UNAVAILABLE', message: 'MCP service is not configured' },
      });
      return;
    }

    let parsedBody: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(req.body.toString('utf8'));
      if (!isRecord(parsed)) {
        this.writeJsonResponse(stream, 400, {
          error: { code: 'VALIDATION_ERROR', message: 'Request body must be a JSON object' },
        });
        return;
      }
      parsedBody = parsed;
    } catch (_parseErr: unknown) {
      this.writeJsonResponse(stream, 400, {
        error: { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON' },
      });
      return;
    }

    // Strict parameter check: reject unknown / spoofed keys
    const allowedKeys = new Set(['sessionId', 'toolName', 'args', 'requestId']);
    for (const key of Object.keys(parsedBody)) {
      if (!allowedKeys.has(key)) {
        this.writeJsonResponse(stream, 400, {
          error: { code: 'VALIDATION_ERROR', message: `Unknown parameter "${key}" in request body` },
        });
        return;
      }
    }

    const { sessionId, toolName, args, requestId } = parsedBody;

    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      this.writeJsonResponse(stream, 400, {
        error: { code: 'VALIDATION_ERROR', message: 'sessionId must be a non-empty string' },
      });
      return;
    }

    if (typeof toolName !== 'string' || !toolName.trim()) {
      this.writeJsonResponse(stream, 400, {
        error: { code: 'VALIDATION_ERROR', message: 'toolName must be a non-empty string' },
      });
      return;
    }

    if (args !== undefined && !isRecord(args)) {
      this.writeJsonResponse(stream, 400, {
        error: { code: 'VALIDATION_ERROR', message: 'args must be an object' },
      });
      return;
    }

    if (requestId !== undefined && (typeof requestId !== 'string' || !requestId.trim())) {
      this.writeJsonResponse(stream, 400, {
        error: { code: 'VALIDATION_ERROR', message: 'requestId must be a non-empty string when provided' },
      });
      return;
    }

    const route = await this.resolveSessionRoute(sessionId);
    if ((this.db || this.storage) && !route) {
      this.writeJsonResponse(stream, 403, {
        error: { code: 'FORBIDDEN', message: 'Session does not belong to authorized tenant or space' },
      });
      return;
    }

    const quotaAllowed = await this.consumeQuota();
    if (!quotaAllowed) {
      this.writeJsonResponse(stream, 429, {
        error: { code: 'QUOTA_EXCEEDED', message: 'Quota exceeded for api_calls' },
      });
      return;
    }

    const cleanRequestId = typeof requestId === 'string' && requestId.trim() ? requestId.trim() : undefined;
    const cleanSessionId = route?.matchedSessionId ?? sessionId.trim();

    // Safe audit logging: safe noarg values
    await this.recordAuditLog('mcp.call', {
      toolName: toolName.trim(),
      sessionId: cleanSessionId,
      spaceId: route?.matchedSpaceId,
      requestId: cleanRequestId,
    });

    const context: McpProxyContext = {
      userId: this.platformUserId || 'system',
      spaceId: route?.matchedSpaceId,
      sessionId: cleanSessionId,
      requestId: cleanRequestId,
    };

    try {
      const result = await this.mcpService.callTool(
        toolName.trim(),
        (args as Record<string, unknown>) || {},
        context
      );
      this.writeJsonResponse(stream, 200, {
        success: true,
        data: result,
        ...result,
      });
    } catch (err: unknown) {
      this.handleMcpError(stream, err);
    }
  }

  /**
   * Handles POST /api/mcp/cancel
   */
  private async handleMcpCancel(
    req: ParsedHttpRequest,
    stream: Duplex
  ): Promise<void> {
    if (!this.mcpService) {
      this.writeJsonResponse(stream, 503, {
        error: { code: 'SERVICE_UNAVAILABLE', message: 'MCP service is not configured' },
      });
      return;
    }

    let parsedBody: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(req.body.toString('utf8'));
      if (!isRecord(parsed)) {
        this.writeJsonResponse(stream, 400, {
          error: { code: 'VALIDATION_ERROR', message: 'Request body must be a JSON object' },
        });
        return;
      }
      parsedBody = parsed;
    } catch (_parseErr: unknown) {
      this.writeJsonResponse(stream, 400, {
        error: { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON' },
      });
      return;
    }

    // Strict parameter check: reject unknown / spoofed keys
    const allowedKeys = new Set(['sessionId', 'requestId']);
    for (const key of Object.keys(parsedBody)) {
      if (!allowedKeys.has(key)) {
        this.writeJsonResponse(stream, 400, {
          error: { code: 'VALIDATION_ERROR', message: `Unknown parameter "${key}" in request body` },
        });
        return;
      }
    }

    const { sessionId, requestId } = parsedBody;

    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      this.writeJsonResponse(stream, 400, {
        error: { code: 'VALIDATION_ERROR', message: 'sessionId must be a non-empty string' },
      });
      return;
    }

    if (typeof requestId !== 'string' || !requestId.trim()) {
      this.writeJsonResponse(stream, 400, {
        error: { code: 'VALIDATION_ERROR', message: 'requestId must be a non-empty string' },
      });
      return;
    }

    const route = await this.resolveSessionRoute(sessionId);
    if ((this.db || this.storage) && !route) {
      this.writeJsonResponse(stream, 403, {
        error: { code: 'FORBIDDEN', message: 'Session does not belong to authorized tenant or space' },
      });
      return;
    }

    const cleanRequestId = requestId.trim();
    const cleanSessionId = route?.matchedSessionId ?? sessionId.trim();

    await this.recordAuditLog('mcp.cancel', {
      requestId: cleanRequestId,
      sessionId: cleanSessionId,
      spaceId: route?.matchedSpaceId,
    });

    const context: McpProxyContext = {
      userId: this.platformUserId || 'system',
      spaceId: route?.matchedSpaceId,
      sessionId: cleanSessionId,
      requestId: cleanRequestId,
    };

    try {
      await this.mcpService.cancel({
        requestId: cleanRequestId,
        context,
      });
      this.writeJsonResponse(stream, 200, {
        success: true,
      });
    } catch (err: unknown) {
      this.handleMcpError(stream, err);
    }
  }

  /**
   * Handles GET /api/mcp/health
   */
  private async handleMcpHealth(
    _req: ParsedHttpRequest,
    stream: Duplex
  ): Promise<void> {
    if (!this.mcpService) {
      this.writeJsonResponse(stream, 503, {
        error: { code: 'SERVICE_UNAVAILABLE', message: 'MCP service is not configured' },
      });
      return;
    }

    const context: McpProxyContext = {
      userId: this.platformUserId || 'system',
    };

    try {
      const health = await this.mcpService.checkHealth(context);
      this.writeJsonResponse(stream, 200, {
        success: true,
        data: { health },
        health,
      });
    } catch (err: unknown) {
      this.handleMcpError(stream, err);
    }
  }

  /**
   * Safe mapping for MCP errors to HTTP responses.
   */
  private handleMcpError(stream: Duplex, err: unknown): void {
    const errorObj = err as any;
    const message = errorObj instanceof Error ? errorObj.message : String(errorObj || 'MCP operation failed');
    const code = typeof errorObj?.code === 'string' ? errorObj.code : 'MCP_OPERATION_FAILED';
    const httpStatus = typeof errorObj?.httpStatus === 'number'
      ? errorObj.httpStatus
      : code === 'MCP_TOOL_NOT_FOUND' || code === 'NOT_FOUND'
      ? 404
      : code === 'MCP_INVALID_ARGUMENTS' || code === 'VALIDATION_ERROR' || code === 'MCP_BAD_REQUEST'
      ? 400
      : code === 'MCP_UNAUTHORIZED' || code === 'MCP_FORBIDDEN' || code === 'FORBIDDEN'
      ? 403
      : code === 'MCP_TOOL_TIMEOUT' || code === 'TIMEOUT'
      ? 408
      : code === 'MCP_CIRCUIT_OPEN' || code === 'SERVICE_UNAVAILABLE'
      ? 503
      : 500;

    this.writeJsonResponse(stream, httpStatus, {
      error: { code, message },
    });
  }

  /**
   * Helper to write structured HTTP/1.1 JSON response to duplex stream.
   */
  private writeJsonResponse(stream: Duplex, statusCode: number, body: unknown): void {
    if (stream.writableEnded) return;

    try {
      const payload = JSON.stringify(body);
      const payloadBytes = Buffer.byteLength(payload, 'utf8');

      const statusText =
        statusCode === 200 ? 'OK' :
        statusCode === 201 ? 'Created' :
        statusCode === 400 ? 'Bad Request' :
        statusCode === 403 ? 'Forbidden' :
        statusCode === 404 ? 'Not Found' :
        statusCode === 405 ? 'Method Not Allowed' :
        statusCode === 413 ? 'Payload Too Large' :
        statusCode === 500 ? 'Internal Server Error' :
        statusCode === 503 ? 'Service Unavailable' : 'Status';

      const headers = [
        `HTTP/1.1 ${statusCode} ${statusText}`,
        'Content-Type: application/json; charset=utf-8',
        `Content-Length: ${payloadBytes}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n');

      stream.write(headers);
      stream.write(payload);
      stream.end();
    } catch (_writeErr: unknown) {
      try {
        if (!stream.writableEnded) {
          const fallbackBody = JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Internal platform error' } });
          const fallbackBytes = Buffer.byteLength(fallbackBody, 'utf8');
          const fallbackHeaders = [
            'HTTP/1.1 500 Internal Server Error',
            'Content-Type: application/json; charset=utf-8',
            `Content-Length: ${fallbackBytes}`,
            'Connection: close',
            '',
            '',
          ].join('\r\n');
          stream.write(fallbackHeaders);
          stream.write(fallbackBody);
          stream.end();
        }
      } catch (_fallbackErr: unknown) {
        // Fallback error contained
      }
      try {
        stream.destroy();
      } catch (_destroyErr: unknown) {
        // Stream destruction error contained
      }
    }
  }
}

/**
 * EventsStreamHandler handles dedicated stream multiplexing for kind: 'events'.
 */
export class EventsStreamHandler implements StreamHandler {
  readonly kind = EVENTS_STREAM_KIND;
  private readonly proxyHandler: PlatformProxyHandler;

  constructor(options: PlatformProxyOptions = {}) {
    this.proxyHandler = new PlatformProxyHandler(options);
  }

  async handle(stream: Duplex, metadata: StreamMetadata): Promise<void> {
    const effectiveMetadata = {
      ...metadata,
      kind: PLATFORM_STREAM_KIND,
    };
    await this.proxyHandler.handle(stream, effectiveMetadata);
  }
}

export function createEventsStreamHandler(options?: PlatformProxyOptions): EventsStreamHandler {
  return new EventsStreamHandler(options);
}

/**
 * Factory function creating a PlatformProxyHandler instance.
 */
export function createPlatformProxyHandler(options?: PlatformProxyOptions): PlatformProxyHandler {
  return new PlatformProxyHandler(options);
}
