/**
 * Generic Brand type helper for nominal typing.
 */
declare const __brand: unique symbol;

export type Brand<B, T = string> = T & { readonly [__brand]: B };

/**
 * Branded string ID types used across Enkeep platform and container boundaries.
 */
export type SessionId = Brand<'SessionId', string>;
export type RunId = Brand<'RunId', string>;
export type ExecutionId = Brand<'ExecutionId', string>;
export type TaskId = Brand<'TaskId', string>;
export type WorkspaceId = Brand<'WorkspaceId', string>;
export type ContainerId = Brand<'ContainerId', string>;
export type UserId = Brand<'UserId', string>;
export type RuntimeIdentity = Brand<'RuntimeIdentity', string>;
export type PlatformUserId = Brand<'PlatformUserId', string>;
export type RequestId = Brand<'RequestId', string>;
export type SpaceId = Brand<'SpaceId', string>;
export type ArtifactId = Brand<'ArtifactId', string>;
export type RuntimeWorkspaceSegment = Brand<'RuntimeWorkspaceSegment', string>;

/**
 * Sequence number of one existing event in a Session log (branded safe integer >= 0).
 */
export type SessionSeq = Brand<'SessionSeq', number>;

/**
 * A Session log gap, prefix length, or read offset (branded safe integer >= 0).
 */
export type SessionLogOffset = Brand<'SessionLogOffset', number>;

/**
 * Maximum allowable length for an opaque branded ID string.
 */
export const MAX_ID_LENGTH = 128;

/**
 * Canonical pattern for runtime workspace folder segments: safe relative single directory names.
 */
export const RUNTIME_WORKSPACE_SEGMENT_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/**
 * Valid ID regex: non-empty, alphanumeric, underscores, hyphens, colons, and dots.
 * Prevents control chars, newlines, null bytes, and path traversal tokens.
 */
const ID_PATTERN = /^[A-Za-z0-9_\-:.]{1,128}$/;

/**
 * Canonical pattern for platform user IDs: standard UUIDs (v4 / canonical) or user_ fixture IDs.
 */
export const CANONICAL_PLATFORM_USER_ID_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|user_[a-zA-Z0-9_\-]{1,64}|u[0-9]+)$/i;

/**
 * Canonical pattern for container runtime identities / aliases.
 */
export const RUNTIME_IDENTITY_PATTERN = /^[a-zA-Z0-9_\-]{1,64}$/;

/**
 * Check if a raw string is a valid ID format.
 */
export function isValidIdFormat(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH && ID_PATTERN.test(value);
}

export function isValidPlatformUserId(value: unknown): value is PlatformUserId {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    value === value.trim() &&
    value === value.normalize('NFC') &&
    CANONICAL_PLATFORM_USER_ID_PATTERN.test(value)
  );
}

export function isValidRuntimeIdentity(value: unknown): value is RuntimeIdentity {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 64 &&
    value === value.trim() &&
    value === value.normalize('NFC') &&
    RUNTIME_IDENTITY_PATTERN.test(value)
  );
}

export function isValidRuntimeWorkspaceSegment(value: unknown): value is RuntimeWorkspaceSegment {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 64 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    value === value.trim() &&
    value === value.normalize('NFC') &&
    RUNTIME_WORKSPACE_SEGMENT_PATTERN.test(value)
  );
}

/**
 * Validate and cast a string into a branded type, throwing TypeError on invalid format.
 */
export function makeBranded<B extends string>(value: string, brandName: B): Brand<B, string> {
  if (typeof value !== 'string') {
    throw new TypeError(`Expected string for ${brandName}, received ${typeof value}`);
  }
  if (!isValidIdFormat(value)) {
    throw new TypeError(`Invalid ${brandName} format: "${String(value).slice(0, 32)}" (must match ${ID_PATTERN})`);
  }
  return value as Brand<B, string>;
}

/**
 * Safe branded ID constructor returning null on invalid input.
 */
export function parseBranded<B extends string>(value: unknown, brandName: B): Brand<B, string> | null {
  if (isValidIdFormat(value)) {
    return value as Brand<B, string>;
  }
  return null;
}

// Concrete branded ID constructors
export function makeSessionId(id: string): SessionId {
  return makeBranded(id, 'SessionId');
}

export function makeRunId(id: string): RunId {
  return makeBranded(id, 'RunId');
}

export function makeExecutionId(id: string): ExecutionId {
  return makeBranded(id, 'ExecutionId');
}

export function makeTaskId(id: string): TaskId {
  return makeBranded(id, 'TaskId');
}

export function makeWorkspaceId(id: string): WorkspaceId {
  return makeBranded(id, 'WorkspaceId');
}

export function makeContainerId(id: string): ContainerId {
  return makeBranded(id, 'ContainerId');
}

export function makeUserId(id: string): UserId {
  return makeBranded(id, 'UserId');
}

export function makeRuntimeIdentity(id: string): RuntimeIdentity {
  if (typeof id !== 'string') {
    throw new TypeError(`Expected string for RuntimeIdentity, received ${typeof id}`);
  }
  if (!isValidRuntimeIdentity(id)) {
    throw new TypeError(`Invalid RuntimeIdentity format: "${String(id).slice(0, 32)}" (must be trimmed, NFC, matching ${RUNTIME_IDENTITY_PATTERN})`);
  }
  return id as RuntimeIdentity;
}

export function makePlatformUserId(id: string): PlatformUserId {
  if (typeof id !== 'string') {
    throw new TypeError(`Expected string for PlatformUserId, received ${typeof id}`);
  }
  if (!isValidPlatformUserId(id)) {
    throw new TypeError(`Invalid PlatformUserId format: "${String(id).slice(0, 32)}" (must be trimmed, NFC, canonical UUID or user_ fixture)`);
  }
  return id as PlatformUserId;
}

export function parseRuntimeIdentity(value: unknown): RuntimeIdentity | null {
  if (isValidRuntimeIdentity(value)) {
    return value;
  }
  return null;
}

export function parsePlatformUserId(value: unknown): PlatformUserId | null {
  if (isValidPlatformUserId(value)) {
    return value;
  }
  return null;
}

export function makeRequestId(id: string): RequestId {
  return makeBranded(id, 'RequestId');
}

export function makeSpaceId(id: string): SpaceId {
  return makeBranded(id, 'SpaceId');
}

export function makeArtifactId(id: string): ArtifactId {
  return makeBranded(id, 'ArtifactId');
}

export function makeRuntimeWorkspaceSegment(segment: string): RuntimeWorkspaceSegment {
  if (typeof segment !== 'string') {
    throw new TypeError(`Expected string for RuntimeWorkspaceSegment, received ${typeof segment}`);
  }
  if (!isValidRuntimeWorkspaceSegment(segment)) {
    throw new TypeError(`Invalid RuntimeWorkspaceSegment format: "${String(segment).slice(0, 32)}" (must be single directory segment matching ${RUNTIME_WORKSPACE_SEGMENT_PATTERN})`);
  }
  return segment as RuntimeWorkspaceSegment;
}

export function parseRuntimeWorkspaceSegment(value: unknown): RuntimeWorkspaceSegment | null {
  if (isValidRuntimeWorkspaceSegment(value)) {
    return value;
  }
  return null;
}

export function isValidSessionSeq(value: unknown): value is SessionSeq {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

export function isValidSessionLogOffset(value: unknown): value is SessionLogOffset {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

export function makeSessionSeq(seq: number): SessionSeq {
  if (typeof seq !== 'number') {
    throw new TypeError(`Expected number for SessionSeq, received ${typeof seq}`);
  }
  if (!isValidSessionSeq(seq)) {
    throw new TypeError(`Invalid SessionSeq: ${seq} (must be a non-negative safe integer)`);
  }
  return seq as SessionSeq;
}

export function parseSessionSeq(value: unknown): SessionSeq | null {
  if (isValidSessionSeq(value)) {
    return value;
  }
  return null;
}

export function makeSessionLogOffset(offset: number): SessionLogOffset {
  if (typeof offset !== 'number') {
    throw new TypeError(`Expected number for SessionLogOffset, received ${typeof offset}`);
  }
  if (!isValidSessionLogOffset(offset)) {
    throw new TypeError(`Invalid SessionLogOffset: ${offset} (must be a non-negative safe integer)`);
  }
  return offset as SessionLogOffset;
}

export function parseSessionLogOffset(value: unknown): SessionLogOffset | null {
  if (isValidSessionLogOffset(value)) {
    return value;
  }
  return null;
}


