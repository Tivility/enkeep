import { createHash } from 'node:crypto';
import { ProtocolError, ProtocolErrorCode } from './errors.js';

/**
 * Default limits for strict JSON parsing and serialization.
 */
export const DEFAULT_JSON_LIMITS = {
  /** Maximum payload size in bytes (default: 4 MB) */
  maxPayloadBytes: 4 * 1024 * 1024,
  /** Maximum object/array nesting depth (default: 64) */
  maxDepth: 64,
  /** Maximum total number of object keys in a single document (default: 50,000) */
  maxKeyCount: 50_000,
  /** Maximum string length inside JSON elements (default: 2 MB) */
  maxStringLength: 2 * 1024 * 1024,
} as const;

export interface JsonParseOptions {
  /** Maximum payload size in bytes */
  readonly maxPayloadBytes?: number;
  /** Maximum nesting depth */
  readonly maxDepth?: number;
  /** Maximum total key count across the whole JSON object */
  readonly maxKeyCount?: number;
  /** Maximum string length for individual strings */
  readonly maxStringLength?: number;
  /** Whether to strip dangerous keys (__proto__, constructor, prototype). If false, throws error. Default: true */
  readonly sanitizeProtoKeys?: boolean;
}

export class JsonParseError extends ProtocolError {
  constructor(message: string, cause?: unknown) {
    super({
      code: ProtocolErrorCode.PARSE_ERROR,
      message: `Strict JSON parse error: ${message}`,
      status: 400,
      retryable: false,
      cause,
    });
    this.name = 'JsonParseError';
  }
}

export class JsonLimitExceededError extends ProtocolError {
  constructor(message: string) {
    super({
      code: ProtocolErrorCode.PAYLOAD_TOO_LARGE,
      message: `Strict JSON limit exceeded: ${message}`,
      status: 413,
      retryable: false,
    });
    this.name = 'JsonLimitExceededError';
  }
}

/**
 * Prototype pollution keys to guard against.
 */
const FORBIDDEN_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Validate and sanitize an already parsed JS structure against depth, key count, string length and proto pollution.
 */
function validateStructure(
  root: unknown,
  options: Required<JsonParseOptions>
): unknown {
  let keyCount = 0;

  function walk(value: unknown, currentDepth: number): unknown {
    if (currentDepth > options.maxDepth) {
      throw new JsonLimitExceededError(`Exceeded maximum nesting depth of ${options.maxDepth}`);
    }

    if (value === null || typeof value !== 'object') {
      if (typeof value === 'string' && value.length > options.maxStringLength) {
        throw new JsonLimitExceededError(`String length ${value.length} exceeds maximum allowed of ${options.maxStringLength}`);
      }
      return value;
    }

    if (Array.isArray(value)) {
      const copy: unknown[] = new Array(value.length);
      for (let i = 0; i < value.length; i++) {
        copy[i] = walk(value[i], currentDepth + 1);
      }
      return copy;
    }

    // It's a plain object
    const obj = value as Record<string, unknown>;
    const copy: Record<string, unknown> = Object.create(null);

    const keys = Object.keys(obj);
    for (const key of keys) {
      keyCount++;
      if (keyCount > options.maxKeyCount) {
        throw new JsonLimitExceededError(`Exceeded maximum key count of ${options.maxKeyCount}`);
      }

      if (FORBIDDEN_PROTO_KEYS.has(key)) {
        if (!options.sanitizeProtoKeys) {
          throw new JsonParseError(`Forbidden prototype pollution key encountered: "${key}"`);
        }
        // Sanitize by dropping this dangerous key
        continue;
      }

      copy[key] = walk(obj[key], currentDepth + 1);
    }

    return copy;
  }

  return walk(root, 0);
}

/**
 * Strict JSON parse with payload byte limits, depth limits, key count limits, and proto-pollution protection.
 */
export function strictJsonParse<T = unknown>(
  input: string | Buffer | Uint8Array,
  options?: JsonParseOptions
): T {
  const opts: Required<JsonParseOptions> = {
    maxPayloadBytes: options?.maxPayloadBytes ?? DEFAULT_JSON_LIMITS.maxPayloadBytes,
    maxDepth: options?.maxDepth ?? DEFAULT_JSON_LIMITS.maxDepth,
    maxKeyCount: options?.maxKeyCount ?? DEFAULT_JSON_LIMITS.maxKeyCount,
    maxStringLength: options?.maxStringLength ?? DEFAULT_JSON_LIMITS.maxStringLength,
    sanitizeProtoKeys: options?.sanitizeProtoKeys ?? true,
  };

  let rawString: string;

  if (typeof input === 'string') {
    const byteLength = Buffer.byteLength(input, 'utf-8');
    if (byteLength > opts.maxPayloadBytes) {
      throw new JsonLimitExceededError(
        `Payload size (${byteLength} bytes) exceeds limit of ${opts.maxPayloadBytes} bytes`
      );
    }
    rawString = input;
  } else if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    if (input.byteLength > opts.maxPayloadBytes) {
      throw new JsonLimitExceededError(
        `Payload size (${input.byteLength} bytes) exceeds limit of ${opts.maxPayloadBytes} bytes`
      );
    }
    rawString = Buffer.from(input).toString('utf-8');
  } else {
    throw new JsonParseError(`Expected string or buffer input, received ${typeof input}`);
  }

  // Pre-check for raw payload depth if easily detectable or let parser parse then deep inspect
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawString);
  } catch (err) {
    throw new JsonParseError(err instanceof Error ? err.message : String(err), err);
  }

  return validateStructure(parsed, opts) as T;
}

/**
 * Safe JSON stringify with depth validation and byte limit check.
 */
export function strictJsonStringify(
  value: unknown,
  options?: { maxPayloadBytes?: number; maxDepth?: number }
): string {
  const maxBytes = options?.maxPayloadBytes ?? DEFAULT_JSON_LIMITS.maxPayloadBytes;
  const maxDepth = options?.maxDepth ?? DEFAULT_JSON_LIMITS.maxDepth;

  // Circular reference and depth check
  const seen = new WeakSet();
  function checkDepth(val: unknown, depth: number) {
    if (depth > maxDepth) {
      throw new JsonLimitExceededError(`Exceeded maximum serialization depth of ${maxDepth}`);
    }
    if (val !== null && typeof val === 'object') {
      if (seen.has(val)) {
        throw new JsonParseError('Circular reference detected during serialization');
      }
      seen.add(val);
      if (Array.isArray(val)) {
        for (const item of val) {
          checkDepth(item, depth + 1);
        }
      } else {
        for (const key of Object.keys(val as Record<string, unknown>)) {
          checkDepth((val as Record<string, unknown>)[key], depth + 1);
        }
      }
    }
  }

  checkDepth(value, 0);

  let jsonStr: string;
  try {
    jsonStr = JSON.stringify(value);
  } catch (err) {
    throw new JsonParseError(err instanceof Error ? err.message : String(err), err);
  }

  if (jsonStr === undefined) {
    throw new JsonParseError('Serialization resulted in undefined');
  }

  const byteLen = Buffer.byteLength(jsonStr, 'utf-8');
  if (byteLen > maxBytes) {
    throw new JsonLimitExceededError(
      `Serialized JSON size (${byteLen} bytes) exceeds limit of ${maxBytes} bytes`
    );
  }

  return jsonStr;
}

/**
 * Canonical receipt structure for session seed imports and exports.
 */
export interface SessionSeedReceipt {
  readonly algorithm: 'sha256-session-events-v1';
  readonly checksum: string;
  readonly canonicalBytes: number;
  readonly eventCount: number;
  readonly importedAt?: string;
}

/**
 * Deterministically serializes any JSON-compatible value to a canonical JSON string
 * with recursively sorted object keys, standard primitive encodings, and no extraneous whitespace.
 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (typeof (value as any)?.toJSON === 'function') {
    return canonicalJsonStringify((value as any).toJSON());
  }
  if (Array.isArray(value)) {
    const items = value.map((item) =>
      item === undefined || typeof item === 'function' || typeof item === 'symbol'
        ? 'null'
        : canonicalJsonStringify(item)
    );
    return `[${items.join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const pairs: string[] = [];
    for (const key of keys) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined && typeof v !== 'function' && typeof v !== 'symbol') {
        pairs.push(`${JSON.stringify(key)}:${canonicalJsonStringify(v)}`);
      }
    }
    return `{${pairs.join(',')}}`;
  }
  throw new TypeError('Cannot canonically serialize value of unsupported type');
}

/**
 * Computes canonical SHA-256 checksum (lower-case 64 hex characters) of a session events array.
 */
export function computeSessionEventsChecksum(events: readonly unknown[]): string {
  const canonical = canonicalJsonStringify(events);
  return createHash('sha256').update(canonical, 'utf8').digest('hex').toLowerCase();
}

/**
 * Computes canonical SessionSeedReceipt from a session events array.
 */
export function computeSessionSeedReceipt(events: readonly unknown[]): SessionSeedReceipt {
  const canonicalJson = canonicalJsonStringify(events);
  const checksum = createHash('sha256').update(canonicalJson, 'utf8').digest('hex').toLowerCase();
  const canonicalBytes = Buffer.byteLength(canonicalJson, 'utf8');
  return {
    algorithm: 'sha256-session-events-v1',
    checksum,
    canonicalBytes,
    eventCount: events.length,
  };
}

/**
 * Normalizes session events into plain JSON-safe data structures by canonically
 * serializing and re-parsing. This ensures identical memory representations
 * before and after transport over JSON wire protocols.
 */
export function normalizeCanonicalSessionEvents<T = readonly unknown[]>(events: readonly unknown[]): T {
  if (!Array.isArray(events)) {
    throw new TypeError('Session events must be an array');
  }
  const canonical = canonicalJsonStringify(events);
  return JSON.parse(canonical) as T;
}

/**
 * Test diagnostic helper to find the first differing property path and values between two JSON-compatible structures.
 */
export function findFirstJsonMismatch(
  a: unknown,
  b: unknown,
  currentPath = ''
): { path: string; valueA: unknown; valueB: unknown } | null {
  if (a === b) return null;

  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return { path: currentPath || 'root', valueA: a, valueB: b };
  }

  if (Array.isArray(a) !== Array.isArray(b)) {
    return { path: currentPath || 'root', valueA: a, valueB: b };
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return { path: `${currentPath}.length`, valueA: a.length, valueB: b.length };
    }
    for (let i = 0; i < a.length; i++) {
      const sub = findFirstJsonMismatch(a[i], b[i], `${currentPath}[${i}]`);
      if (sub) return sub;
    }
    return null;
  }

  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA).filter((k) => objA[k] !== undefined).sort();
  const keysB = Object.keys(objB).filter((k) => objB[k] !== undefined).sort();

  const allKeys = Array.from(new Set([...keysA, ...keysB])).sort();
  for (const k of allKeys) {
    const p = currentPath ? `${currentPath}.${k}` : k;
    if (!(k in objA) || objA[k] === undefined) {
      return { path: p, valueA: undefined, valueB: objB[k] };
    }
    if (!(k in objB) || objB[k] === undefined) {
      return { path: p, valueA: objA[k], valueB: undefined };
    }
    const sub = findFirstJsonMismatch(objA[k], objB[k], p);
    if (sub) return sub;
  }

  return null;
}
