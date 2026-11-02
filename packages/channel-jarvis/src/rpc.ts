/**
 * Bidirectional JSON-RPC over one message transport (the Jarvis runtime protocol, §8.2).
 *
 * Frames are single JSON objects:
 * - request  `{"id","method","params"}`
 * - response `{"id","result"}` or `{"id","error":{"message","code"?,"data"?}}`
 * - event    `{"event","params"}`
 *
 * Both sides may send requests; ids of requests sent from this side carry a prefix (`e` for enkeep).
 *
 * @module @enkeep/channel-jarvis/rpc
 */

/** A message-oriented transport: one string per message (a WebSocket text frame, an in-memory pipe). */
export interface MessageSocket {
  send(data: string): void;
  onMessage(listener: (data: string) => void): void;
  onClose(listener: (code: number, reason: string) => void): void;
  close(code?: number, reason?: string): void;
}

/** pino-compatible logger; every method is optional. Never pass tokens or message content. */
export interface JarvisLogger {
  debug?(obj: unknown, msg?: string): void;
  info?(obj: unknown, msg?: string): void;
  warn?(obj: unknown, msg?: string): void;
  error?(obj: unknown, msg?: string): void;
}

/** An rpc failure: thrown by `call()` for error responses, and by handlers to answer with a code. */
export class RpcError extends Error {
  readonly code?: string;
  readonly data?: unknown;

  constructor(message: string, code?: string, data?: unknown) {
    super(message);
    this.name = 'RpcError';
    if (code !== undefined) this.code = code;
    if (data !== undefined) this.data = data;
  }
}

/** The string `code` of an error, when it carries one. */
export function errorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return undefined;
}

export type RequestHandler = (method: string, params: unknown) => unknown | Promise<unknown>;
export type EventHandler = (event: string, params: unknown) => void;

export interface CallOptions {
  /** Milliseconds before the call fails with code `timeout`; 0 waits forever. Defaults to the peer's default. */
  timeoutMs?: number;
  /** Aborting drops the call locally and rejects it with code `aborted`. */
  signal?: AbortSignal;
}

export interface PeerOptions {
  /** Prefix for ids of requests sent from this side. Defaults to `e`. */
  idPrefix?: string;
  /** Default call timeout in milliseconds. Defaults to 30 s. */
  defaultTimeoutMs?: number;
  onRequest?: RequestHandler;
  onEvent?: EventHandler;
  log?: JarvisLogger;
}

interface PendingCall {
  resolve(value: unknown): void;
  reject(err: Error): void;
  cleanup(): void;
}

type RequestId = string | number;

const DEFAULT_TIMEOUT_MS = 30_000;

export class Peer {
  private readonly socket: MessageSocket;
  private readonly idPrefix: string;
  private readonly defaultTimeoutMs: number;
  private readonly log: JarvisLogger | undefined;
  private readonly pending = new Map<string, PendingCall>();
  private requestHandler: RequestHandler | undefined;
  private eventHandler: EventHandler | undefined;
  private nextId = 1;
  private isClosed = false;

  constructor(socket: MessageSocket, options: PeerOptions = {}) {
    this.socket = socket;
    this.idPrefix = options.idPrefix ?? 'e';
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = options.log;
    this.requestHandler = options.onRequest;
    this.eventHandler = options.onEvent;
    socket.onMessage((data) => this.receive(data));
    socket.onClose(() => this.close());
  }

  get closed(): boolean {
    return this.isClosed;
  }

  setRequestHandler(handler: RequestHandler): void {
    this.requestHandler = handler;
  }

  setEventHandler(handler: EventHandler): void {
    this.eventHandler = handler;
  }

  /** Send a request and wait for its response. Error responses reject with an {@link RpcError}. */
  call<T = unknown>(method: string, params?: unknown, options: CallOptions = {}): Promise<T> {
    if (this.isClosed) return Promise.reject(new RpcError('connection closed', 'closed'));
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(new RpcError('call aborted', 'aborted'));

    const id = `${this.idPrefix}${this.nextId++}`;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = (): void => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        entry.cleanup();
        reject(new RpcError('call aborted', 'aborted'));
      };
      const entry: PendingCall = {
        resolve: (value) => resolve(value as T),
        reject,
        cleanup: () => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        },
      };
      this.pending.set(id, entry);
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (!this.pending.delete(id)) return;
          entry.cleanup();
          reject(new RpcError(`${method} timed out`, 'timeout'));
        }, timeoutMs);
      }
      signal?.addEventListener('abort', onAbort, { once: true });

      if (!this.write({ id, method, params: params ?? {} })) {
        this.pending.delete(id);
        entry.cleanup();
        reject(new RpcError('connection closed', 'closed'));
      }
    });
  }

  /** Send an event (no response). Returns false when the peer is closed or the send failed. */
  notify(event: string, params?: unknown): boolean {
    if (this.isClosed) return false;
    return this.write({ event, params: params ?? {} });
  }

  /** Stop the peer: pending calls reject with code `closed`; later frames are ignored. Does not close the socket. */
  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      entry.cleanup();
      entry.reject(new RpcError('connection closed', 'closed'));
    }
  }

  private write(frame: Record<string, unknown>): boolean {
    let text: string;
    try {
      text = JSON.stringify(frame);
    } catch (err) {
      this.log?.warn?.({ err: describe(err) }, 'jarvis rpc: frame not serializable');
      return false;
    }
    try {
      this.socket.send(text);
      return true;
    } catch (err) {
      this.log?.warn?.({ err: describe(err) }, 'jarvis rpc: send failed');
      return false;
    }
  }

  private receive(data: string): void {
    if (this.isClosed) return;
    let frame: unknown;
    try {
      frame = JSON.parse(data);
    } catch {
      this.log?.warn?.({ bytes: data.length }, 'jarvis rpc: dropped a frame that is not JSON');
      return;
    }
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
      this.log?.warn?.({}, 'jarvis rpc: dropped a frame that is not an object');
      return;
    }
    const msg = frame as Record<string, unknown>;
    const id = msg.id;
    const hasId = typeof id === 'string' || typeof id === 'number';

    if (hasId && typeof msg.method === 'string') {
      void this.serve(id as RequestId, msg.method, msg.params);
      return;
    }
    if (hasId && ('result' in msg || 'error' in msg)) {
      this.settle(String(id), msg);
      return;
    }
    if (typeof msg.event === 'string') {
      try {
        this.eventHandler?.(msg.event, msg.params);
      } catch (err) {
        this.log?.warn?.({ event: msg.event, err: describe(err) }, 'jarvis rpc: event handler failed');
      }
      return;
    }
    this.log?.warn?.({}, 'jarvis rpc: dropped a frame of unknown shape');
  }

  private settle(id: string, msg: Record<string, unknown>): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    entry.cleanup();
    if ('error' in msg && msg.error !== undefined && msg.error !== null) {
      const raw = msg.error as { message?: unknown; code?: unknown; data?: unknown };
      const message = typeof raw.message === 'string' ? raw.message : 'remote error';
      const code = typeof raw.code === 'string' ? raw.code : typeof raw.code === 'number' ? String(raw.code) : undefined;
      entry.reject(new RpcError(message, code, raw.data));
      return;
    }
    entry.resolve(msg.result);
  }

  private async serve(id: RequestId, method: string, params: unknown): Promise<void> {
    const handler = this.requestHandler;
    try {
      if (!handler) throw new RpcError(`unsupported method: ${method}`, 'unsupported');
      const result = await handler(method, params);
      if (this.isClosed) return;
      this.write({ id, result: result === undefined ? null : result });
    } catch (err) {
      if (this.isClosed) return;
      const code = errorCode(err);
      const error: Record<string, unknown> = {
        message: err instanceof Error && err.message ? err.message : 'request failed',
      };
      if (code) error.code = code;
      if (err instanceof RpcError && err.data !== undefined) error.data = err.data;
      this.write({ id, error });
    }
  }
}

/** A loggable description of an error (name and code, never payloads). */
export function describe(err: unknown): string {
  if (err instanceof Error) {
    const code = errorCode(err);
    return code ? `${err.name}(${code}): ${err.message}` : `${err.name}: ${err.message}`;
  }
  return String(err);
}
