/**
 * Control-Plane Sibling Space Extra Readable Roots Provider (G12-P3)
 *
 * Supplies `extraReadableRoots` from the trusted server-side SQLite ownership registry:
 * - Includes other spaces owned by the SAME user (read-only sibling spaces)
 * - Strictly excludes the current workspace/space
 * - Strictly excludes deleted or archived spaces (status != 'active')
 * - Strictly excludes other users' spaces and unowned mounts
 * - Normalizes and maps paths according to execution mode (Host vs Container)
 * - NEVER uses client-supplied paths
 * - Produces a deterministic, stable, and bounded array (or undefined for ordinary 1-space)
 *
 * @module @enkeep/demo-runner/up/sibling-roots
 */

import { resolve, normalize, sep } from 'node:path';
import { posix } from 'node:path';

export const MAX_SIBLING_EXTRA_READABLE_ROOTS = 20;

export interface SiblingRootsQueryDb {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

export interface ResolveSiblingRootsOptions {
  db: SiblingRootsQueryDb;
  userId: string;
  currentSpaceId?: string;
  currentSpaceFolder?: string;
  isHost: boolean;
  dataRoot?: string;
  username?: string;
  maxRoots?: number;
}

/**
 * Validates a single space folder name from the server registry.
 * Ensures it contains no directory traversal, separators, or null bytes.
 */
function isValidSpaceFolderName(folder: unknown): folder is string {
  if (typeof folder !== 'string') return false;
  const trimmed = folder.trim();
  if (!trimmed) return false;
  if (trimmed === '.' || trimmed === '..') return false;
  if (trimmed.includes('\0') || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
    return false;
  }
  return true;
}

/**
 * Checks if a resolved path contains sensitive user or harness configuration directories.
 */
function containsSensitiveSegment(resolvedPath: string, pathSep: string): boolean {
  const parts = resolvedPath.split(pathSep);
  const sensitiveNames = new Set(['.dsh', '.ssh', '.aws', '.gnupg', '.docker', '.kube']);
  return parts.some((part) => sensitiveNames.has(part.toLowerCase()));
}

/**
 * Resolves trusted server-side sibling spaces for the given user and returns
 * normalized, bounded extraReadableRoots, or undefined if none exist.
 */
export function resolveSiblingExtraReadableRoots(
  options: ResolveSiblingRootsOptions
): readonly string[] | undefined {
  const {
    db,
    userId,
    currentSpaceId,
    currentSpaceFolder,
    isHost,
    dataRoot,
    username,
    maxRoots = MAX_SIBLING_EXTRA_READABLE_ROOTS,
  } = options;

  if (!db || !userId || typeof userId !== 'string' || !userId.trim()) {
    return undefined;
  }

  // 1. Resolve canonical user identity (UUID and username) from trusted registry
  let canonicalUserId = userId.trim();
  let canonicalUsername = username ? username.trim() : '';

  try {
    const userRow = db
      .prepare('SELECT id, username FROM users WHERE id = ? OR username = ?')
      .get(canonicalUserId, canonicalUserId) as { id?: string; username?: string } | undefined;

    if (userRow) {
      if (userRow.id && typeof userRow.id === 'string') {
        canonicalUserId = userRow.id.trim();
      }
      if (!canonicalUsername && userRow.username && typeof userRow.username === 'string') {
        canonicalUsername = userRow.username.trim();
      }
    }
  } catch {
    // If users table is absent or fails, fallback to provided userId
  }

  if (!canonicalUsername) {
    canonicalUsername = canonicalUserId;
  }

  // 2. Query spaces table for candidate spaces belonging to THIS user only
  let hasStatusColumn = true;
  try {
    const tableInfo = db.prepare("PRAGMA table_info('spaces')").all() as Array<{ name?: string }>;
    hasStatusColumn = tableInfo.some((col) => col.name === 'status');
  } catch {
    hasStatusColumn = false;
  }

  let rows: Array<{ id?: string; folder?: string; status?: string }> = [];
  try {
    const querySql = hasStatusColumn
      ? 'SELECT id, folder, status FROM spaces WHERE user_id = ? ORDER BY folder ASC'
      : 'SELECT id, folder FROM spaces WHERE user_id = ? ORDER BY folder ASC';
    rows = db.prepare(querySql).all(canonicalUserId) as Array<{ id?: string; folder?: string; status?: string }>;
  } catch {
    return undefined;
  }

  if (!rows || rows.length === 0) {
    return undefined;
  }

  // Normalize current space filters
  const currentId = currentSpaceId ? currentSpaceId.trim() : undefined;
  const currentFolder = currentSpaceFolder ? currentSpaceFolder.trim() : undefined;

  // 3. Filter candidate sibling spaces
  const validSiblingFolders: string[] = [];

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;

    const rowId = typeof row.id === 'string' ? row.id.trim() : undefined;
    const rowFolder = typeof row.folder === 'string' ? row.folder.trim() : undefined;

    // Must have a valid folder
    if (!isValidSpaceFolderName(rowFolder)) {
      continue;
    }

    // Exclude current space by canonical ID or folder
    if (currentId && (rowId === currentId || rowFolder === currentId)) {
      continue;
    }
    if (currentFolder && (rowFolder === currentFolder || rowId === currentFolder)) {
      continue;
    }

    // Exclude deleted or archived spaces
    if (hasStatusColumn && row.status !== undefined && row.status !== null) {
      const status = String(row.status).trim().toLowerCase();
      if (status !== 'active') {
        continue;
      }
    }

    validSiblingFolders.push(rowFolder);
  }

  if (validSiblingFolders.length === 0) {
    // Ordinary one-space workspace: no siblings, return undefined to keep turn request unchanged
    return undefined;
  }

  // 4. Map paths based on execution mode
  const mappedRoots: string[] = [];

  if (isHost) {
    if (!dataRoot || typeof dataRoot !== 'string' || !dataRoot.trim()) {
      throw new Error('FAIL-CLOSED: dataRoot is required to resolve host sibling space roots');
    }

    const spacesBase = resolve(dataRoot, 'host-runtimes', canonicalUsername, 'spaces');

    for (const folder of validSiblingFolders) {
      const mappedPath = resolve(spacesBase, folder);
      const normalizedPath = normalize(mappedPath);

      // Invariant: must be strictly contained inside spacesBase
      if (!normalizedPath.startsWith(spacesBase + sep)) {
        continue;
      }
      if (normalizedPath === spacesBase) {
        continue;
      }
      if (containsSensitiveSegment(normalizedPath, sep)) {
        continue;
      }

      mappedRoots.push(normalizedPath);
    }
  } else {
    // Container mode: fixed base /home/dsh/spaces
    const containerSpacesBase = '/home/dsh/spaces';

    for (const folder of validSiblingFolders) {
      const mappedPath = posix.join(containerSpacesBase, folder);
      const normalizedPath = posix.normalize(mappedPath);

      // Invariant: must be strictly contained inside containerSpacesBase
      if (!normalizedPath.startsWith(containerSpacesBase + '/')) {
        continue;
      }
      if (normalizedPath === containerSpacesBase) {
        continue;
      }
      if (containsSensitiveSegment(normalizedPath, '/')) {
        continue;
      }

      mappedRoots.push(normalizedPath);
    }
  }

  if (mappedRoots.length === 0) {
    return undefined;
  }

  // 5. Stable deduplication and sorting, bounded by limit
  const uniqueSorted = Array.from(new Set(mappedRoots)).sort((a, b) => a.localeCompare(b));
  const boundedLimit = typeof maxRoots === 'number' && Number.isSafeInteger(maxRoots) && maxRoots > 0
    ? maxRoots
    : MAX_SIBLING_EXTRA_READABLE_ROOTS;

  const bounded = uniqueSorted.slice(0, boundedLimit);

  if (bounded.length === 0) {
    return undefined;
  }

  return Object.freeze(bounded);
}
