import * as crypto from 'node:crypto';
import {
  ProtocolHeaders,
  makeRequestId,
  strictJsonParse,
  strictJsonStringify,
} from '@enkeep/protocol';
import {
  ClientHttpError,
} from './errors.js';
import {
  calculateBackoff,
  isRequestRetryable,
  isTransientError,
  parseRetryAfterHeader,
  sleep,
} from './retry.js';
import { executeUdsRequest, type TransportResponse } from './transport.js';
import type {
  ClientResponse,
  DshPlatformClientConfig,
  HttpMethod,
  RequestOptions,
} from './types.js';

export const DEFAULT_CLIENT_CONFIG = {
  timeoutMs: 10_000,
  maxRetries: 3,
  retryInitialDelayMs: 100,
  retryMaxDelayMs: 2_000,
  maxResponseBodyBytes: 4 * 1024 * 1024, // 4 MB
} as const;

/**
 * HTTP Client used by container DSH to communicate with the Enkeep platform over loopback tunnel or UDS.
 */
export class DshPlatformClient {
  private readonly config: {
    baseURL?: string;
    socketPath?: string;
    bearerToken?: DshPlatformClientConfig['bearerToken'];
    timeoutMs: number;
    maxRetries: number;
    retryInitialDelayMs: number;
    retryMaxDelayMs: number;
    maxResponseBodyBytes: number;
    defaultHeaders?: Record<string, string>;
  };

  constructor(config: DshPlatformClientConfig = {}) {
    const rawBaseURL = config.baseURL ?? config.baseUrl;
    const socketPath = config.socketPath;

    if ('socketPath' in config && config.socketPath !== undefined) {
      if (typeof config.socketPath !== 'string' || config.socketPath.trim() === '') {
        throw new TypeError('DshPlatformClient socketPath must be a non-empty string');
      }
    }

    if (rawBaseURL !== undefined) {
      if (typeof rawBaseURL !== 'string' || rawBaseURL.trim() === '') {
        throw new TypeError('DshPlatformClient baseURL must be a non-empty string');
      }
    }

    if (!rawBaseURL && !socketPath) {
      // Default to loopback tunnel platform endpoint if neither specified
      this.config = {
        baseURL: 'http://127.0.0.1:8787/platform',
        socketPath: undefined,
        bearerToken: config.bearerToken,
        timeoutMs: config.timeoutMs ?? DEFAULT_CLIENT_CONFIG.timeoutMs,
        maxRetries: config.maxRetries ?? DEFAULT_CLIENT_CONFIG.maxRetries,
        retryInitialDelayMs: config.retryInitialDelayMs ?? DEFAULT_CLIENT_CONFIG.retryInitialDelayMs,
        retryMaxDelayMs: config.retryMaxDelayMs ?? DEFAULT_CLIENT_CONFIG.retryMaxDelayMs,
        maxResponseBodyBytes: config.maxResponseBodyBytes ?? DEFAULT_CLIENT_CONFIG.maxResponseBodyBytes,
        defaultHeaders: config.defaultHeaders,
      };
    } else {
      this.config = {
        baseURL: rawBaseURL,
        socketPath,
        bearerToken: config.bearerToken,
        timeoutMs: config.timeoutMs ?? DEFAULT_CLIENT_CONFIG.timeoutMs,
        maxRetries: config.maxRetries ?? DEFAULT_CLIENT_CONFIG.maxRetries,
        retryInitialDelayMs: config.retryInitialDelayMs ?? DEFAULT_CLIENT_CONFIG.retryInitialDelayMs,
        retryMaxDelayMs: config.retryMaxDelayMs ?? DEFAULT_CLIENT_CONFIG.retryMaxDelayMs,
        maxResponseBodyBytes: config.maxResponseBodyBytes ?? DEFAULT_CLIENT_CONFIG.maxResponseBodyBytes,
        defaultHeaders: config.defaultHeaders,
      };
    }
  }

  /**
   * Get configured Base URL if using HTTP.
   */
  get baseURL(): string | undefined {
    return this.config.baseURL;
  }

  /**
   * Get configured Unix domain socket path if using UDS.
   */
  get socketPath(): string | undefined {
    return this.config.socketPath;
  }

  /**
   * Resolve authorization bearer token.
   */
  private async resolveBearerToken(): Promise<string | undefined> {
    if (!this.config.bearerToken) {
      return undefined;
    }
    if (typeof this.config.bearerToken === 'function') {
      return await this.config.bearerToken();
    }
    return this.config.bearerToken;
  }

  /**
   * Format query string and append to path.
   */
  private buildFullPath(path: string, query?: RequestOptions['query']): string {
    let normalizedPath = path.startsWith('/') ? path : `/${path}`;

    if (this.config.baseURL) {
      try {
        const u = new URL(this.config.baseURL);
        const prefix = u.pathname.replace(/\/+$/, '');
        if (prefix && prefix !== '/') {
          if (normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)) {
            // Already includes prefix
          } else {
            normalizedPath = `${prefix}${normalizedPath}`;
          }
        }
      } catch {}
    }

    if (!query) {
      return normalizedPath;
    }

    const searchParams = new URLSearchParams();
    for (const [key, val] of Object.entries(query)) {
      if (val !== undefined && val !== null) {
        searchParams.append(key, String(val));
      }
    }

    const qs = searchParams.toString();
    return qs ? `${normalizedPath}?${qs}` : normalizedPath;
  }

  /**
   * Execute an HTTP request with bearer auth, request ID, timeout, body size limits, and bounded retries.
   */
  async request<T = unknown>(path: string, options?: RequestOptions): Promise<ClientResponse<T>> {
    const method: HttpMethod | string = (options?.method ?? 'GET').toUpperCase();
    const requestId = options?.requestId ? String(options.requestId) : crypto.randomUUID();
    const timeoutMs = options?.timeoutMs ?? this.config.timeoutMs;
    const maxResponseBodyBytes = options?.maxResponseBodyBytes ?? this.config.maxResponseBodyBytes;

    const fullPath = this.buildFullPath(path, options?.query);

    let hostHeader = '127.0.0.1:8787';
    if (this.config.baseURL) {
      try {
        const u = new URL(this.config.baseURL);
        hostHeader = u.host || '127.0.0.1:8787';
      } catch {}
    }

    // Build headers
    const headers: Record<string, string> = {
      'host': hostHeader,
      'accept': 'application/json, text/plain, */*',
      [ProtocolHeaders.REQUEST_ID]: requestId,
      ...(this.config.defaultHeaders ?? {}),
    };

    // Bearer token
    const token = await this.resolveBearerToken();
    if (token) {
      headers['authorization'] = `Bearer ${token}`;
    }

    // Merge user headers
    if (options?.headers) {
      for (const [key, value] of Object.entries(options.headers)) {
        if (value !== undefined) {
          headers[key.toLowerCase()] = value;
        }
      }
    }

    // Build payload
    let bodyBuffer: Buffer | string | undefined = undefined;
    if (options?.rawBody !== undefined) {
      bodyBuffer = options.rawBody;
      if (!headers['content-type']) {
        headers['content-type'] = 'application/octet-stream';
      }
    } else if (options?.body !== undefined) {
      bodyBuffer = strictJsonStringify(options.body);
      headers['content-type'] = 'application/json; charset=utf-8';
    }

    if (bodyBuffer !== undefined) {
      headers['content-length'] = String(
        typeof bodyBuffer === 'string' ? Buffer.byteLength(bodyBuffer, 'utf-8') : bodyBuffer.length
      );
    }

    // Determine retryability
    const retryable = isRequestRetryable(method, options);
    const maxRetries = retryable ? (options?.maxRetries ?? this.config.maxRetries) : 0;

    let attempt = 0;
    while (true) {
      try {
        const rawRes: TransportResponse = await executeUdsRequest({
          socketPath: this.config.socketPath,
          baseURL: this.config.baseURL,
          method,
          path: fullPath,
          headers,
          body: bodyBuffer,
          timeoutMs,
          signal: options?.signal,
          maxResponseBodyBytes,
          requestId,
        });

        // Parse body
        let parsedData: unknown = undefined;
        const contentType = String(rawRes.headers['content-type'] ?? '');
        if (rawRes.rawBody.length > 0) {
          if (contentType.includes('application/json') || contentType.includes('+json')) {
            parsedData = strictJsonParse(rawRes.rawBody);
          } else {
            // Try json parse, fallback to utf-8 text
            try {
              parsedData = strictJsonParse(rawRes.rawBody);
            } catch {
              parsedData = rawRes.rawBody.toString('utf-8');
            }
          }
        }

        // Check HTTP status code
        if (rawRes.status >= 300) {
          const httpErr = ClientHttpError.fromResponse(
            rawRes.status,
            parsedData,
            requestId,
            rawRes.headers
          );

          // If retryable status on an idempotent request
          if (attempt < maxRetries && isTransientError(httpErr)) {
            attempt++;
            const headerDelay = parseRetryAfterHeader(rawRes.headers);
            const backoffDelay =
              headerDelay ??
              calculateBackoff(
                attempt,
                this.config.retryInitialDelayMs,
                this.config.retryMaxDelayMs
              );
            await sleep(backoffDelay, options?.signal);
            continue;
          }

          throw httpErr;
        }

        return {
          status: rawRes.status,
          headers: rawRes.headers,
          data: parsedData as T,
          rawBody: rawRes.rawBody,
          requestId,
        };
      } catch (err: any) {
        if (attempt < maxRetries && isTransientError(err)) {
          attempt++;
          const backoffDelay = calculateBackoff(
            attempt,
            this.config.retryInitialDelayMs,
            this.config.retryMaxDelayMs
          );
          await sleep(backoffDelay, options?.signal);
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Convenience GET request.
   */
  get<T = unknown>(path: string, options?: Omit<RequestOptions, 'method'>): Promise<ClientResponse<T>> {
    return this.request<T>(path, { ...options, method: 'GET' });
  }

  /**
   * Convenience POST request.
   */
  post<T = unknown>(
    path: string,
    body?: unknown,
    options?: Omit<RequestOptions, 'method' | 'body'>
  ): Promise<ClientResponse<T>> {
    return this.request<T>(path, { ...options, method: 'POST', body });
  }

  /**
   * Convenience PUT request.
   */
  put<T = unknown>(
    path: string,
    body?: unknown,
    options?: Omit<RequestOptions, 'method' | 'body'>
  ): Promise<ClientResponse<T>> {
    return this.request<T>(path, { ...options, method: 'PUT', body });
  }

  /**
   * Convenience PATCH request.
   */
  patch<T = unknown>(
    path: string,
    body?: unknown,
    options?: Omit<RequestOptions, 'method' | 'body'>
  ): Promise<ClientResponse<T>> {
    return this.request<T>(path, { ...options, method: 'PATCH', body });
  }

  /**
   * Convenience DELETE request.
   */
  delete<T = unknown>(path: string, options?: Omit<RequestOptions, 'method'>): Promise<ClientResponse<T>> {
    return this.request<T>(path, { ...options, method: 'DELETE' });
  }
}
