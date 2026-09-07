/**
 * Canonical Tool Naming and Sanitization for MCP Protocol
 *
 * Implements the canonical public MCP tool naming standard:
 * - Public name: `mcp__<contributionKeySlug>__<rawToolName>`
 * - Exactly 3 double-underscore-separated segments (`mcp`, `<slug>`, `<rawToolName>`)
 * - Contribution key slug: `[A-Za-z0-9_-]+` (no double underscores)
 * - Raw tool name: `[A-Za-z0-9_.-]+` (no double underscores)
 * - Deterministic sanitization prevents collision and ambiguity.
 * - Bare names (e.g. `add`), old formats (`server__add`), and malformed/ambiguous names are rejected.
 *
 * @module @enkeep/platform-service-mcp/naming
 */

export const CANONICAL_PREFIX = 'mcp';
export const ALLOWED_SLUG_PATTERN = /^[A-Za-z0-9_-]+$/;
export const ALLOWED_RAW_TOOL_PATTERN = /^[A-Za-z0-9_.-]+$/;

export interface ParsedCanonicalToolName {
  readonly slug: string;
  readonly rawToolName: string;
}

/**
 * Derives a deterministic slug from a contribution ID or server name.
 * - Replaces any character not in `[A-Za-z0-9_-]` with `_`.
 * - Collapses consecutive underscores (`__+`) to `_` to guarantee no double underscores.
 * - Strips leading/trailing underscores and falls back to `'server'` if empty.
 */
export function toContributionKeySlug(rawKey: string): string {
  if (!rawKey || typeof rawKey !== 'string') {
    return 'server';
  }
  const replaced = rawKey.replace(/[^A-Za-z0-9_-]/g, '_');
  const collapsed = replaced.replace(/_{2,}/g, '_');
  const trimmed = collapsed.replace(/^_+|_+$/g, '');
  return trimmed || 'server';
}

/**
 * Sanitizes a raw tool name for canonical integration.
 * - Replaces any character not in `[A-Za-z0-9_.-]` with `_`.
 * - Collapses consecutive underscores (`__+`) to `_` to guarantee no double underscores.
 * - Strips leading/trailing underscores and falls back to `'tool'` if empty.
 */
export function sanitizeRawToolName(rawName: string): string {
  if (!rawName || typeof rawName !== 'string') {
    return 'tool';
  }
  const replaced = rawName.replace(/[^A-Za-z0-9_.-]/g, '_');
  const collapsed = replaced.replace(/_{2,}/g, '_');
  const trimmed = collapsed.replace(/^_+|_+$/g, '');
  return trimmed || 'tool';
}

/**
 * Builds the canonical public tool name from a contribution key / server ID and raw tool name.
 * Format: `mcp__<contributionKeySlug>__<rawToolName>`
 */
export function buildCanonicalToolName(contributionKey: string, rawToolName: string): string {
  const slug = toContributionKeySlug(contributionKey);
  const safeRaw = sanitizeRawToolName(rawToolName);
  return `mcp__${slug}__${safeRaw}`;
}

/**
 * Checks whether a given tool name strictly matches the canonical format `mcp__<slug>__<rawToolName>`.
 * Must have exactly 3 segments separated by `__`, starting with `mcp`.
 */
export function isValidCanonicalToolName(name: string): boolean {
  if (!name || typeof name !== 'string' || !name.startsWith('mcp__')) {
    return false;
  }
  const parts = name.split('__');
  if (parts.length !== 3) {
    return false;
  }
  const [prefix, slug, rawToolName] = parts;
  if (prefix !== CANONICAL_PREFIX || !slug || !rawToolName) {
    return false;
  }
  return ALLOWED_SLUG_PATTERN.test(slug) && ALLOWED_RAW_TOOL_PATTERN.test(rawToolName);
}

/**
 * Parses and validates a canonical public tool name into its constituent slug and raw tool name.
 * Returns `null` if the name is not strictly canonical (e.g. bare `add`, old `server__add`,
 * malformed, or containing ambiguous multiple segments).
 */
export function parseCanonicalToolName(name: string): ParsedCanonicalToolName | null {
  if (!isValidCanonicalToolName(name)) {
    return null;
  }
  const parts = name.split('__');
  return {
    slug: parts[1]!,
    rawToolName: parts[2]!,
  };
}
