/**
 * The WebSocket endpoint a jarvisd node dials into (`GET /api/jarvis/runtime`, §8.1).
 *
 * The platform calls {@link JarvisEndpoint.handleUpgrade} from its http server's `upgrade` event for
 * that path, after its own Host validation. Checks, in order, each refusing with a plain HTTP
 * response: the optional `validate` hook; an `Origin` header (browsers always send one, jarvisd
 * never does) → 403; the bearer token → 401; the `jarvis-runtime.v1` subprotocol → 400. Then the
 * socket is upgraded, answering that subprotocol, and handed to `onConnection`.
 *
 * @module @enkeep/channel-jarvis/endpoint
 */

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { describe, type JarvisLogger, type MessageSocket } from './rpc.js';

export const JARVIS_SUBPROTOCOL = 'jarvis-runtime.v1';
export const JARVIS_RUNTIME_PATH = '/api/jarvis/runtime';
/** Largest accepted message (64 MiB). */
export const JARVIS_MAX_PAYLOAD = 64 * 1024 * 1024;
/** Close code sent to an older connection when the same account connects again. */
export const JARVIS_CLOSE_REPLACED = 4000;

export interface JarvisPrincipal {
  accountId: string;
  userId: string;
}

export interface JarvisConnection extends JarvisPrincipal {
  socket: MessageSocket;
}

export interface JarvisEndpointOptions {
  /** Resolve a bearer token to an enabled Jarvis channel account; null when unknown or revoked. */
  authenticate(token: string): Promise<JarvisPrincipal | null>;
  /** A connection was accepted (any older one of the same account is already being closed). */
  onConnection(connection: JarvisConnection): void | Promise<void>;
  /** Extra check run first; a status code refuses the upgrade, null passes. */
  validate?(req: IncomingMessage): number | null;
  /** Defaults to {@link JARVIS_MAX_PAYLOAD}. */
  maxPayload?: number;
  log?: JarvisLogger;
}

export interface JarvisEndpoint {
  /** Handle one upgrade request; never throws or rejects. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void>;
  /** Close every connection and refuse later upgrades. */
  closeAll(code?: number, reason?: string): void;
  /** Number of open connections. */
  readonly size: number;
}

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  421: 'Misdirected Request',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

/** The token of an `Authorization: Bearer <token>` header, or null. */
export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
  return match ? match[1]! : null;
}

/** The subprotocols the client offered (`Sec-WebSocket-Protocol`). */
export function offeredSubprotocols(req: IncomingMessage): string[] {
  const header = req.headers['sec-websocket-protocol'];
  const raw = Array.isArray(header) ? header.join(',') : header ?? '';
  return raw
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

function refuse(socket: Duplex, status: number, extraHeaders: string[] = []): void {
  if (socket.destroyed) return;
  const text = STATUS_TEXT[status] ?? 'Error';
  const body = `${text}\n`;
  const head = [
    `HTTP/1.1 ${status} ${text}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    ...extraHeaders,
  ];
  socket.once('finish', () => socket.destroy());
  socket.end(`${head.join('\r\n')}\r\n\r\n${body}`);
}

/** Wrap an accepted `ws` socket as a {@link MessageSocket} (text frames only). */
export function wrapWebSocket(ws: WebSocket, log?: JarvisLogger): MessageSocket {
  return {
    send(data: string): void {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    },
    onMessage(listener: (data: string) => void): void {
      ws.on('message', (data: RawData, isBinary: boolean) => {
        if (isBinary) {
          log?.warn?.({}, 'jarvis endpoint: binary frame refused');
          ws.close(1003, 'text frames only');
          return;
        }
        listener(rawToString(data));
      });
    },
    onClose(listener: (code: number, reason: string) => void): void {
      ws.on('close', (code: number, reason: Buffer) => listener(code, reason.toString('utf8')));
    },
    close(code?: number, reason?: string): void {
      if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) return;
      ws.close(code ?? 1000, reason);
    },
  };
}

function rawToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

export function createJarvisEndpoint(options: JarvisEndpointOptions): JarvisEndpoint {
  const log = options.log;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: options.maxPayload ?? JARVIS_MAX_PAYLOAD,
    perMessageDeflate: false,
    handleProtocols: (protocols: Set<string>) => (protocols.has(JARVIS_SUBPROTOCOL) ? JARVIS_SUBPROTOCOL : false),
  });
  const live = new Map<string, WebSocket>();
  let shuttingDown = false;

  async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    // A socket error during the checks or after a refusal must not become an unhandled 'error' event;
    // `ws` installs its own handler once the upgrade proceeds.
    const onEarlyError = (err: Error): void => {
      log?.debug?.({ err: describe(err) }, 'jarvis endpoint: socket error during handshake');
    };
    socket.on('error', onEarlyError);
    try {
      if (shuttingDown) return refuse(socket, 503);

      const custom = options.validate?.(req) ?? null;
      if (custom !== null) return refuse(socket, custom);

      if (req.headers.origin !== undefined) {
        log?.warn?.({}, 'jarvis endpoint: refused an upgrade carrying Origin');
        return refuse(socket, 403);
      }

      const token = bearerToken(req);
      const principal = token ? await options.authenticate(token) : null;
      if (!principal) {
        log?.warn?.({ tokenPresent: token !== null }, 'jarvis endpoint: refused an upgrade without a valid token');
        return refuse(socket, 401, ['WWW-Authenticate: Bearer']);
      }

      if (!offeredSubprotocols(req).includes(JARVIS_SUBPROTOCOL)) {
        log?.warn?.({ accountId: principal.accountId }, 'jarvis endpoint: refused an upgrade without the subprotocol');
        return refuse(socket, 400);
      }

      if (socket.destroyed) return;
      if (shuttingDown) return refuse(socket, 503);
      socket.off('error', onEarlyError);
      wss.handleUpgrade(req, socket, head, (ws) => accept(ws, principal));
    } catch (err) {
      log?.error?.({ err: describe(err) }, 'jarvis endpoint: upgrade failed');
      if (socket.listenerCount('error') === 0) socket.on('error', onEarlyError);
      refuse(socket, 500);
    }
  }

  function accept(ws: WebSocket, principal: JarvisPrincipal): void {
    const { accountId, userId } = principal;
    ws.on('error', (err: Error) => {
      log?.warn?.({ accountId, err: describe(err) }, 'jarvis endpoint: socket error');
    });

    const older = live.get(accountId);
    live.set(accountId, ws);
    if (older) {
      log?.info?.({ accountId }, 'jarvis endpoint: replacing the older connection');
      older.close(JARVIS_CLOSE_REPLACED, 'replaced');
    }
    ws.on('close', (code: number) => {
      if (live.get(accountId) === ws) live.delete(accountId);
      log?.info?.({ accountId, code }, 'jarvis endpoint: connection closed');
    });
    log?.info?.({ accountId }, 'jarvis endpoint: connection accepted');

    const socket = wrapWebSocket(ws, log);
    try {
      const pending = options.onConnection({ accountId, userId, socket });
      if (pending && typeof (pending as Promise<void>).catch === 'function') {
        (pending as Promise<void>).catch((err: unknown) => {
          log?.error?.({ accountId, err: describe(err) }, 'jarvis endpoint: onConnection failed');
          socket.close(1011, 'internal error');
        });
      }
    } catch (err) {
      log?.error?.({ accountId, err: describe(err) }, 'jarvis endpoint: onConnection failed');
      socket.close(1011, 'internal error');
    }
  }

  return {
    handleUpgrade(req, socket, head) {
      return handleUpgrade(req, socket, head);
    },
    closeAll(code = 1001, reason = 'shutting down') {
      shuttingDown = true;
      for (const ws of live.values()) {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(code, reason);
      }
      live.clear();
      wss.close();
    },
    get size() {
      return live.size;
    },
  };
}
