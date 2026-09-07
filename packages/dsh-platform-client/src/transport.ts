import * as http from 'node:http';
import {
  ClientConnectionError,
  ClientResponseTooLargeError,
  ClientTimeoutError,
} from './errors.js';

export interface TransportRequestParams {
  readonly socketPath?: string;
  readonly baseURL?: string;
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body?: Buffer | string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly maxResponseBodyBytes: number;
  readonly requestId: string;
}

export interface TransportResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly rawBody: Buffer;
  readonly requestId: string;
}

/**
 * Execute a low-level HTTP request over loopback TCP or a Unix Domain Socket with timeout, abort, and body size limits.
 */
export function executeUdsRequest(params: TransportRequestParams): Promise<TransportResponse> {
  return executeTransportRequest(params);
}

export function executeTransportRequest(params: TransportRequestParams): Promise<TransportResponse> {
  return new Promise((resolve, reject) => {
    if (params.signal?.aborted) {
      return reject(new Error('Request aborted before dispatch'));
    }

    let settled = false;
    let timeoutTimer: NodeJS.Timeout | null = null;

    let reqOptions: http.RequestOptions;
    if (params.baseURL) {
      const u = new URL(params.baseURL);
      reqOptions = {
        hostname: u.hostname,
        port: u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80),
        path: params.path,
        method: params.method,
        headers: params.headers,
      };
    } else if (params.socketPath) {
      reqOptions = {
        socketPath: params.socketPath,
        path: params.path,
        method: params.method,
        headers: params.headers,
      };
    } else {
      reqOptions = {
        hostname: '127.0.0.1',
        port: 8787,
        path: params.path,
        method: params.method,
        headers: params.headers,
      };
    }

    const req = http.request(reqOptions);

    function cleanup() {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      params.signal?.removeEventListener('abort', onAbort);
    }

    function settleReject(err: Error) {
      if (settled) return;
      settled = true;
      cleanup();
      req.destroy();
      reject(err);
    }

    function settleResolve(res: TransportResponse) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(res);
    }

    function onAbort() {
      settleReject(new Error('Request was aborted by caller'));
    }

    params.signal?.addEventListener('abort', onAbort, { once: true });

    if (params.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        settleReject(new ClientTimeoutError(params.timeoutMs, params.requestId));
      }, params.timeoutMs);
    }

    req.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOENT' || err.code === 'ENOTSOCK') {
        settleReject(
          new ClientConnectionError(
            params.socketPath ?? params.baseURL ?? '127.0.0.1:8787',
            err.message,
            err,
            params.requestId
          )
        );
      } else {
        settleReject(err);
      }
    });

    req.on('response', (res: http.IncomingMessage) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;

      res.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > params.maxResponseBodyBytes) {
          res.destroy();
          settleReject(
            new ClientResponseTooLargeError(
              totalBytes,
              params.maxResponseBodyBytes,
              params.requestId
            )
          );
          return;
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        if (settled) return;
        const rawBody = Buffer.concat(chunks);
        settleResolve({
          status: res.statusCode ?? 200,
          headers: res.headers,
          rawBody,
          requestId: params.requestId,
        });
      });

      res.on('error', (err: Error) => {
        settleReject(err);
      });
    });

    // Write request body if present
    if (params.body !== undefined && params.body !== null) {
      req.write(params.body);
    }

    req.end();
  });
}
