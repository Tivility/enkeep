/**
 * Security, URL validation, bounding, and error sanitization for Browser tools.
 *
 * @module @enkeep/dsh-tool-browser/security
 */

import { createUnsafeUrlError, BrowserToolError } from './errors.js';

export const DEFAULT_ALLOWED_PROTOCOLS = Object.freeze(['http:', 'https:']);
export const DEFAULT_MAX_SNAPSHOT_LENGTH = 65_536; // 64 KiB
export const MAX_URL_LENGTH = 2048;
export const MAX_VALUE_LENGTH = 10_000;
export const MAX_REF_LENGTH = 64;
export const MAX_PAGE_ID_LENGTH = 128;

/**
 * Validates that a URL string is safe to navigate to.
 * Rejects disallowed schemes (e.g. javascript:, file:, data:), null bytes, overly long URLs, and malformed strings.
 */
export function validateSafeUrl(
  rawUrl: string,
  allowedProtocols: readonly string[] = DEFAULT_ALLOWED_PROTOCOLS
): string {
  if (typeof rawUrl !== 'string') {
    throw createUnsafeUrlError('URL must be a string');
  }

  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    throw createUnsafeUrlError('URL must not be empty');
  }

  if (trimmed.length > MAX_URL_LENGTH) {
    throw createUnsafeUrlError(`URL exceeds maximum allowed length of ${MAX_URL_LENGTH} characters`);
  }

  if (trimmed.includes('\0')) {
    throw createUnsafeUrlError('URL contains forbidden null bytes');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (err: unknown) {
    throw createUnsafeUrlError(`Malformed URL: "${trimmed.slice(0, 100)}"`);
  }

  const protocol = parsed.protocol.toLowerCase();
  const normalizedAllowed = allowedProtocols.map((p) => (p.endsWith(':') ? p.toLowerCase() : `${p.toLowerCase()}:`));

  if (!normalizedAllowed.includes(protocol)) {
    throw createUnsafeUrlError(
      `Disallowed URL protocol "${protocol}". Only ${normalizedAllowed.join(', ')} are permitted.`
    );
  }

  // Reject internal file scheme or javascript execution
  if (protocol === 'javascript:' || protocol === 'file:' || protocol === 'data:' || protocol === 'vbscript:') {
    throw createUnsafeUrlError(`Forbidden dangerous URL scheme: "${protocol}"`);
  }

  return parsed.toString();
}

/**
 * Bounds a string result (such as a DOM accessibility snapshot) to maxSnapshotLength characters.
 */
export function boundSnapshot(snapshot: string, maxLength = DEFAULT_MAX_SNAPSHOT_LENGTH): string {
  if (typeof snapshot !== 'string') {
    return '';
  }
  if (snapshot.length <= maxLength) {
    return snapshot;
  }
  const truncated = snapshot.slice(0, maxLength);
  return `${truncated}\n\n[Snapshot truncated: ${snapshot.length} total chars exceeded limit of ${maxLength} chars]`;
}

/**
 * Sanitizes errors returned to the model or calling agent, stripping stack traces and internal secrets.
 */
export function sanitizeBrowserError(err: unknown): string {
  if (err instanceof BrowserToolError) {
    return `[Browser Error ${err.code}] ${err.message}`;
  }
  if (err instanceof Error) {
    // Strip file paths and stack trace lines
    const firstLine = err.message.split('\n')[0] ?? 'Unknown error';
    return `[Browser Error] ${firstLine.replace(/\/[a-zA-Z0-9_\-./]+/g, '<path>')}`;
  }
  return `[Browser Error] ${String(err)}`;
}
