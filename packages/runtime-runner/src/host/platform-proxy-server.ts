/**
 * Host Platform Proxy Server
 *
 * Spawns a lightweight local HTTP server bound exclusively to loopback (127.0.0.1) on an ephemeral port
 * to forward in-process platform and tool RPC requests (browser, files, tasks, quota, events, MCP)
 * from the Host daemon to the platform PlatformProxyHandler.
 *
 * Security Invariants:
 * - Cryptographically random per-run 32-byte authorization token.
 * - Constant-time comparison for token validation using Authorization: Bearer <token>.
 * - Fails closed with generic fixed HTTP 401 body on missing/wrong token without invoking proxy handler.
 * - Never logs or reveals auth tokens in metadata, logs, or error responses.
 * - Catch handlers strictly return generic sanitized error payloads without leaking raw paths or internal stack traces.
 *
 * @module @enkeep/runtime-runner/host/platform-proxy-server
 */

import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  PlatformProxyHandler,
  createPlatformProxyHandler,
  type PlatformProxyOptions,
} from '../tunnel/platform-proxy.js';
import { constantTimeCompare } from './llm-proxy-server.js';

export interface HostPlatformProxyServerOptions {
  port?: number;
  host?: string;
  authToken?: string;
  opaquePathPrefix?: string;
  handler?: PlatformProxyHandler;
  platformProxyOptions?: PlatformProxyOptions;
}

export class HostPlatformProxyServer {
  private handler: PlatformProxyHandler | null = null;
  private readonly host: string;
  private readonly preferredPort: number;
  private readonly authToken: string;
  private readonly opaquePathPrefix: string;
  private server: http.Server | null = null;
  private activePort: number | null = null;

  constructor(options: HostPlatformProxyServerOptions = {}) {
    if (options.handler) {
      this.handler = options.handler;
    } else if (options.platformProxyOptions) {
      this.handler = createPlatformProxyHandler(options.platformProxyOptions);
    }

    this.host = options.host || '127.0.0.1';
    this.preferredPort = options.port ?? 0;
    this.authToken = options.authToken || crypto.randomBytes(32).toString('hex');
    this.opaquePathPrefix = options.opaquePathPrefix || `p_${crypto.randomBytes(16).toString('hex')}`;
  }

  public getHandler(): PlatformProxyHandler | null {
    return this.handler;
  }

  public setHandler(handler: PlatformProxyHandler | null): void {
    this.handler = handler;
  }

  public getAuthToken(): string {
    return this.authToken;
  }

  public getOpaquePathPrefix(): string {
    return this.opaquePathPrefix;
  }

  public getPort(): number | null {
    return this.activePort;
  }

  public getBaseUrl(): string {
    if (!this.activePort) {
      throw new Error('Host Platform Proxy server is not running');
    }
    return `http://${this.host}:${this.activePort}/platform/${this.opaquePathPrefix}`;
  }

  public async start(): Promise<string> {
    if (this.server && this.activePort) {
      return this.getBaseUrl();
    }

    const server = http.createServer(async (req, res) => {
      // 1. Mandatory Constant-Time Authentication BEFORE any route matching or dispatch
      const isAuthorized = this.validateRequestAuth(req);

      if (!isAuthorized) {
        if (!res.headersSent) {
          res.writeHead(401, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(
            JSON.stringify({
              error: {
                code: 'unauthorized',
                message: 'Unauthorized proxy access',
              },
            }),
          );
        }
        return;
      }

      const rawUrl = req.url || '/';
      const platformPrefix = `/platform/${this.opaquePathPrefix}`;

      if (!this.handler) {
        if (!res.headersSent) {
          res.writeHead(503, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(
            JSON.stringify({
              error: {
                code: 'SERVICE_UNAVAILABLE',
                message: 'Platform proxy handler is not configured for host runtime',
              },
            }),
          );
        }
        return;
      }

      // 2. Platform Routes: strictly require exact opaque platform prefix
      if (
        rawUrl === platformPrefix ||
        rawUrl.startsWith(`${platformPrefix}/`) ||
        rawUrl.startsWith(`${platformPrefix}?`)
      ) {
        if (!this.handler) {
          if (!res.headersSent) {
            res.writeHead(503, {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
            });
            res.end(
              JSON.stringify({
                error: {
                  code: 'SERVICE_UNAVAILABLE',
                  message: 'Platform proxy handler is not configured for host runtime',
                },
              }),
            );
          }
          return;
        }

        // Normalize path: strip exact opaque platform prefix and format for PlatformProxyHandler
        const remaining = rawUrl.slice(platformPrefix.length);
        req.url = `/platform${remaining.startsWith('/') ? remaining : (remaining.startsWith('?') ? remaining : `/${remaining}`)}`;

        try {
          await this.handler.handleHttpRequest(req, res);
        } catch (_err: unknown) {
          if (!res.headersSent) {
            res.writeHead(500, {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
            });
            res.end(
              JSON.stringify({
                error: {
                  code: 'internal_error',
                  message: 'Internal platform proxy error',
                },
              }),
            );
          }
        }
        return;
      }

      // 3. Fail-closed: Reject any unlisted path, bare /api, bare /capabilities, or wrong prefix with 404
      if (!res.headersSent) {
        res.writeHead(404, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(
          JSON.stringify({
            error: {
              code: 'not_found',
              message: 'Route not found or invalid path prefix',
            },
          }),
        );
      }
    });

    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.listen(this.preferredPort, this.host, () => {
        const addr = server.address() as AddressInfo;
        this.activePort = addr.port;
        resolve();
      });
      server.once('error', (err) => {
        reject(err);
      });
    });

    return this.getBaseUrl();
  }

  private validateRequestAuth(req: http.IncomingMessage): boolean {
    // Check Authorization: Bearer <token>
    const authHeader = req.headers.authorization;
    if (typeof authHeader === 'string') {
      const trimmed = authHeader.trim();
      if (trimmed.toLowerCase().startsWith('bearer ')) {
        const candidateToken = trimmed.slice(7).trim();
        if (candidateToken.length > 0 && constantTimeCompare(candidateToken, this.authToken)) {
          return true;
        }
      }
    }

    return false;
  }

  public async close(): Promise<void> {
    if (!this.server) return;
    const s = this.server;
    this.server = null;
    this.activePort = null;

    await new Promise<void>((resolve) => {
      s.close(() => resolve());
    });
  }
}
