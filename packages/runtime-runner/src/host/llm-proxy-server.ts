/**
 * Host LLM Proxy Server
 *
 * Spawns a lightweight local HTTP server bound exclusively to loopback (127.0.0.1) on an ephemeral port
 * to forward in-process LLM requests from the Host daemon to the LlmProxyHandler.
 *
 * Security Invariants:
 * - Cryptographically random per-run 32-byte authorization token.
 * - Constant-time comparison for token validation using Authorization: Bearer <token>.
 * - Fails closed with generic fixed HTTP 401 body on missing/wrong token without invoking proxy handler.
 * - Never logs or reveals auth tokens in metadata, logs, or error responses.
 * - Catch handlers strictly return generic sanitized error payloads without leaking raw paths or internal stack traces.
 *
 * @module @enkeep/runtime-runner/host/llm-proxy-server
 */

import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  LlmProxyHandler,
  createLlmProxyHandler,
  type LlmProxyOptions,
} from '../tunnel/llm-proxy.js';

export interface HostLlmProxyServerOptions extends LlmProxyOptions {
  port?: number;
  host?: string;
  authToken?: string;
  opaquePathPrefix?: string;
}

/**
 * Constant-time string equality comparison guarding against timing attacks.
 * Uses SHA-256 digests to ensure fixed length comparison preventing length-based timing leaks.
 */
export function constantTimeCompare(a: string | undefined | null, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  const hA = crypto.createHash('sha256').update(Buffer.from(a, 'utf8')).digest();
  const hB = crypto.createHash('sha256').update(Buffer.from(b, 'utf8')).digest();
  return crypto.timingSafeEqual(hA, hB);
}

export class HostLlmProxyServer {
  private readonly handler: LlmProxyHandler;
  private readonly host: string;
  private readonly preferredPort: number;
  private readonly authToken: string;
  private readonly opaquePathPrefix: string;
  private server: http.Server | null = null;
  private activePort: number | null = null;

  constructor(options: HostLlmProxyServerOptions = {}) {
    this.handler = createLlmProxyHandler(options);
    this.host = options.host || '127.0.0.1';
    this.preferredPort = options.port ?? 0;
    this.authToken = options.authToken || crypto.randomBytes(32).toString('hex');
    this.opaquePathPrefix = options.opaquePathPrefix || `t_${crypto.randomBytes(16).toString('hex')}`;
  }

  public getHandler(): LlmProxyHandler {
    return this.handler;
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
      throw new Error('Host LLM Proxy server is not running');
    }
    return `http://${this.host}:${this.activePort}/llm/${this.opaquePathPrefix}`;
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
      const llmPrefix = `/llm/${this.opaquePathPrefix}`;

      // 2. LLM Routes: strictly require opaque LLM prefix
      if (
        rawUrl === llmPrefix ||
        rawUrl.startsWith(`${llmPrefix}/`) ||
        rawUrl.startsWith(`${llmPrefix}?`)
      ) {
        // Normalize path: strip prefix and format as /llm/<providerKey>/... for LlmProxyHandler
        const remaining = rawUrl.slice(llmPrefix.length);
        req.url = `/llm${remaining.startsWith('/') ? remaining : (remaining.startsWith('?') ? remaining : `/${remaining}`)}`;

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
                  message: 'Internal proxy error',
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
