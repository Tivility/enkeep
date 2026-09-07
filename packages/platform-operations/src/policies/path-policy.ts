import * as path from 'node:path';
import type { PathPolicyPort, PathValidationResult } from '../ports/file-port.js';
import type { PathPolicyConfig } from '../types/file.js';
import { PathPolicyViolationError } from '../errors/index.js';

export const DEFAULT_BLOCKED_EXTENSIONS = [
  '.exe',
  '.sh',
  '.bash',
  '.bat',
  '.cmd',
  '.com',
  '.dll',
  '.so',
  '.dylib',
  '.vbs',
  '.ps1',
];

export const DEFAULT_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * Standard path policy validator implementing PathPolicyPort.
 * Performs pure path policy validation, containment check, extension & traversal enforcement
 * without reading external filesystem paths.
 */
export class StandardPathPolicyValidator implements PathPolicyPort {
  async validatePath(
    userId: string,
    targetPath: string,
    config?: PathPolicyConfig
  ): Promise<PathValidationResult> {
    if (!userId || typeof userId !== 'string' || !userId.trim()) {
      throw new PathPolicyViolationError(targetPath || '', 'Invalid tenant userId');
    }

    if (!targetPath || typeof targetPath !== 'string' || !targetPath.trim()) {
      throw new PathPolicyViolationError('', 'File path must be a non-empty string');
    }

    // 1. Null byte injection check
    if (targetPath.includes('\0')) {
      throw new PathPolicyViolationError(targetPath, 'Null byte injection detected in path');
    }

    // 2. Normalize path (POSIX style for uniformity)
    const normalized = path.posix.normalize(targetPath.replace(/\\/g, '/'));

    // 3. Absolute path checks
    const isAbsolute = normalized.startsWith('/');
    if (isAbsolute && !config?.allowAbsolute) {
      throw new PathPolicyViolationError(
        targetPath,
        `Absolute path "${targetPath}" is disallowed by path policy. Must be relative.`
      );
    }

    // 4. Directory traversal check (escaping root)
    if (
      normalized === '..' ||
      normalized.startsWith('../') ||
      normalized.includes('/../') ||
      normalized.endsWith('/..')
    ) {
      throw new PathPolicyViolationError(
        targetPath,
        `Path traversal detected in "${targetPath}". Path must stay within tenant workspace.`
      );
    }

    // 5. Clean relative path
    const relativePath = normalized.replace(/^\/+/, '');
    const filename = path.posix.basename(relativePath);
    if (!filename || filename === '.' || filename === '..') {
      throw new PathPolicyViolationError(targetPath, 'Invalid filename in path');
    }

    const extension = path.posix.extname(filename).toLowerCase();

    // 6. Blocked extensions check
    const blocked = config?.blockedExtensions ?? DEFAULT_BLOCKED_EXTENSIONS;
    if (blocked.some((b) => b.toLowerCase() === extension)) {
      throw new PathPolicyViolationError(
        targetPath,
        `File extension "${extension}" is blocked by security policy`
      );
    }

    // 7. Allowed extensions check (if specified)
    if (config?.allowedExtensions && config.allowedExtensions.length > 0) {
      const allowed = config.allowedExtensions.map((e) => e.toLowerCase());
      if (!allowed.includes(extension)) {
        throw new PathPolicyViolationError(
          targetPath,
          `File extension "${extension}" is not in allowed extensions list: [${allowed.join(', ')}]`
        );
      }
    }

    // Simple MIME type derivation
    const mimeType = deriveMimeType(extension);

    return {
      valid: true,
      normalizedRelativePath: relativePath,
      filename,
      extension,
      mimeType,
    };
  }
}

function deriveMimeType(ext: string): string {
  switch (ext) {
    case '.txt':
    case '.md':
    case '.markdown':
      return 'text/plain; charset=utf-8';
    case '.json':
      return 'application/json';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.svg':
      return 'image/svg+xml';
    case '.webp':
      return 'image/webp';
    case '.pdf':
      return 'application/pdf';
    case '.csv':
      return 'text/csv';
    case '.html':
    case '.htm':
      return 'text/html';
    case '.zip':
      return 'application/zip';
    default:
      return 'application/octet-stream';
  }
}
