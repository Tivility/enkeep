import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createWebChannelHandler, type HttpHandler } from './handler.js';
import type { PlatformWebApi, RuntimeGateway } from './types.js';
import {
  PERMITTED_BIND_HOST,
  DEFAULT_SECURITY_HEADERS,
  API_CACHE_CONTROL_HEADERS,
} from './security.js';

export interface WebChannelServerOptions {
  platformApi: PlatformWebApi;
  runtimeGateway: RuntimeGateway;
  csrfToken: string;
  host?: string;
  port?: number;
  maxBodyBytes?: number;
}

/**
 * Reserved protected ports that must NEVER be bound.
 */
const RESERVED_PORTS = new Set([3000, 3080]);

/**
 * Minimum required character length for CSRF token (at least 256 bits of entropy).
 */
export const MIN_CSRF_TOKEN_LENGTH = 32;

/**
 * Validates the safety of the host and port binding.
 * Strictly enforces that only loopback IPv4 '127.0.0.1' is permitted.
 */
export function validateBinding(host: string, port: number): void {
  const normalizedHost = (host || '').trim();

  if (normalizedHost !== PERMITTED_BIND_HOST) {
    throw new Error(
      `Forbidden host binding "${host}". Only strictly "${PERMITTED_BIND_HOST}" is permitted (rejects localhost, ::1, 0.0.0.0, and external IPs).`
    );
  }

  if (RESERVED_PORTS.has(port)) {
    throw new Error(`Port ${port} is reserved for external services (HappyClaw/DSH GUI) and cannot be bound.`);
  }
}

export class WebChannelServer {
  private server: Server | null = null;
  private readonly handler: HttpHandler;
  public readonly platformApi: PlatformWebApi;
  public readonly runtimeGateway: RuntimeGateway;
  public readonly csrfToken: string;
  public readonly host: string;
  public readonly port: number;

  constructor(options: WebChannelServerOptions) {
    if (!options || !options.platformApi || !options.runtimeGateway) {
      throw new Error(
        'WebChannelServer requires explicit platformApi and runtimeGateway implementations to prevent accidental test-mock misuse.'
      );
    }

    if (!options.csrfToken || typeof options.csrfToken !== 'string' || options.csrfToken.length < MIN_CSRF_TOKEN_LENGTH) {
      throw new Error(
        `WebChannelServer requires an explicit csrfToken with at least ${MIN_CSRF_TOKEN_LENGTH} characters for production security.`
      );
    }

    this.platformApi = options.platformApi;
    this.runtimeGateway = options.runtimeGateway;
    this.csrfToken = options.csrfToken;
    this.host = options.host ?? PERMITTED_BIND_HOST;
    this.port = options.port ?? 0; // Default to ephemeral port 0

    validateBinding(this.host, this.port);

    this.handler = createWebChannelHandler({
      platformApi: this.platformApi,
      runtimeGateway: this.runtimeGateway,
      csrfToken: this.csrfToken,
      maxBodyBytes: options.maxBodyBytes,
    });
  }

  async start(): Promise<{ host: string; port: number; url: string; csrfToken: string }> {
    if (this.server) {
      const addr = this.server.address() as AddressInfo;
      return {
        host: addr.address,
        port: addr.port,
        url: `http://${addr.address}:${addr.port}`,
        csrfToken: this.csrfToken,
      };
    }

    validateBinding(this.host, this.port);

    this.server = createServer((req, res) => {
      // Set security headers immediately on every response before handler or error fallback
      for (const [key, value] of Object.entries(DEFAULT_SECURITY_HEADERS)) {
        res.setHeader(key, value);
      }
      for (const [key, value] of Object.entries(API_CACHE_CONTROL_HEADERS)) {
        res.setHeader(key, value);
      }

      this.handler(req, res).catch((err: unknown) => {
        if (!res.headersSent) {
          const message = err instanceof Error ? err.message : String(err);
          const body = JSON.stringify({ success: false, error: { message, status: 500 } });
          res.writeHead(500, {
            ...DEFAULT_SECURITY_HEADERS,
            ...API_CACHE_CONTROL_HEADERS,
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(body, 'utf-8'),
          });
          res.end(body);
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.port, this.host, () => {
        resolve();
      });
    });

    const addr = this.server.address() as AddressInfo;
    validateBinding(addr.address, addr.port);

    return {
      host: addr.address,
      port: addr.port,
      url: `http://${addr.address}:${addr.port}`,
      csrfToken: this.csrfToken,
    };
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
    });
    this.server = null;
  }

  getPort(): number {
    if (!this.server) return this.port;
    const addr = this.server.address() as AddressInfo;
    return addr?.port ?? this.port;
  }

  getUrl(): string {
    const port = this.getPort();
    return `http://${this.host}:${port}`;
  }
}
