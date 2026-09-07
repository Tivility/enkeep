import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve, relative, extname, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * MIME type mapping for static assets.
 */
export const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Returns the MIME type based on file path extension.
 */
export function getMimeType(filePath: string): string {
  if (typeof filePath !== 'string') {
    return 'application/octet-stream';
  }
  const ext = extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * Resolves the directory path containing static Web UI assets.
 * Evaluates strictly relative to the current module bundle directory.
 */
export function getWebUiStaticDir(): string {
  return resolve(__dirname, 'static');
}

export interface WebUiAsset {
  readonly filename: string;
  readonly content: Buffer;
  readonly mimeType: string;
  readonly contentType: string;
  readonly exists: boolean;
}

/**
 * Validates that filename consists only of safe relative POSIX path segments.
 * Disallows empty path, dot (.), dot-dot (..), backslashes, NUL bytes, and absolute paths.
 */
export function isValidAssetPath(filename: string): boolean {
  if (typeof filename !== 'string' || filename.length === 0) {
    return false;
  }

  // Reject NUL bytes, backslashes, and absolute POSIX/Windows paths
  if (filename.includes('\0') || filename.includes('\\') || filename.startsWith('/')) {
    return false;
  }

  const segments = filename.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      return false;
    }
  }

  return true;
}

function createMissingAsset(filename: string): WebUiAsset {
  const mime = getMimeType(filename);
  return {
    filename,
    content: Buffer.alloc(0),
    mimeType: mime,
    contentType: mime,
    exists: false,
  };
}

/**
 * Retrieves a static asset by relative filename with strict sanitization,
 * exact path containment, symlink rejection, and fail-safe error handling.
 */
export function getWebUiAsset(filename: string): WebUiAsset {
  if (!isValidAssetPath(filename)) {
    return createMissingAsset(filename);
  }

  const staticDir = getWebUiStaticDir();
  const resolvedStaticDir = resolve(staticDir);

  // Path containment check via path.relative
  const candidatePath = resolve(resolvedStaticDir, filename);
  const relCandidate = relative(resolvedStaticDir, candidatePath);
  if (relCandidate.startsWith('..') || isAbsolute(relCandidate) || relCandidate === '') {
    return createMissingAsset(filename);
  }

  try {
    // 1. Verify static root exists and is not a symlink
    const staticStat = lstatSync(resolvedStaticDir);
    if (!staticStat.isDirectory() || staticStat.isSymbolicLink()) {
      return createMissingAsset(filename);
    }
    const realStaticDir = realpathSync(resolvedStaticDir);

    // 2. Validate each path segment with lstatSync to reject symlinks anywhere in the path
    const segments = filename.split('/');
    let currentPath = realStaticDir;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]!;
      currentPath = join(currentPath, segment);

      const segmentStat = lstatSync(currentPath);
      if (segmentStat.isSymbolicLink()) {
        return createMissingAsset(filename);
      }

      if (i < segments.length - 1) {
        if (!segmentStat.isDirectory()) {
          return createMissingAsset(filename);
        }
      } else {
        // Final segment must be a regular file
        if (!segmentStat.isFile()) {
          return createMissingAsset(filename);
        }
      }
    }

    // 3. Realpath containment verification
    const realFilePath = realpathSync(currentPath);
    const relFromRealStatic = relative(realStaticDir, realFilePath);
    if (relFromRealStatic.startsWith('..') || isAbsolute(relFromRealStatic) || relFromRealStatic === '') {
      return createMissingAsset(filename);
    }

    // 4. Safe file read
    const content = readFileSync(realFilePath);
    const mime = getMimeType(filename);
    return {
      filename,
      content,
      mimeType: mime,
      contentType: mime,
      exists: true,
    };
  } catch {
    // Fail safe on any filesystem errors (ENOENT, EACCES, ELOOP, ENOTDIR, etc.)
    return createMissingAsset(filename);
  }
}

/**
 * Returns the UTF-8 HTML string for the Single Page Application index.
 */
export function getWebUiIndexHtml(): string {
  const asset = getWebUiAsset('index.html');
  if (!asset.exists) {
    throw new Error('Web UI index.html not found in static assets directory');
  }
  return asset.content.toString('utf-8');
}
