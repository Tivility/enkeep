/**
 * memory_read Tool Implementation
 *
 * Implements safe, scoped reading of global and space-specific memory files.
 * Validates path containment and prevents directory traversal outside allowed roots.
 *
 * @module @enkeep/dsh-memory/tools/memory-read
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { MemoryReadResult, MemoryScope, MemoryPlatformClientService } from '../types.js';
import { computeContentHash } from '../prompt.js';

export const DEFAULT_READ_LIMIT_LINES = 200;
export const MAX_READ_LIMIT_LINES = 2000;
export const MAX_READ_FILE_BYTES = 10 * 1024 * 1024; // 10MB safety cap

export interface MemoryReadArgs {
  path?: string;
  scope?: MemoryScope;
  offset?: number;
  limit?: number;
}

export interface MemoryReadToolOptions {
  dshHome: string;
  spacePath?: string;
  getClient?: () => MemoryPlatformClientService | undefined;
}

/**
 * Resolves and validates target path inside the designated memory root.
 * Throws TypeError / Error on directory escape.
 */
export function resolveSafeMemoryPath(
  relOrAbsPath: string | undefined,
  scope: MemoryScope,
  dshHome: string,
  spacePath?: string
): { targetPath: string; relPath: string; memoryRoot: string } {
  const memoryRoot = scope === 'global'
    ? path.join(dshHome, 'memory')
    : (spacePath ? path.join(spacePath, 'memory') : path.join(dshHome, 'memory'));

  const normalizedInput = (relOrAbsPath && relOrAbsPath.trim().length > 0)
    ? relOrAbsPath.trim()
    : (scope === 'global' ? 'global.md' : 'space.md');

  // Strip leading slashes to prevent absolute escaping
  const sanitizedRel = normalizedInput.replace(/^[/\\]+/, '');
  const resolved = path.resolve(memoryRoot, sanitizedRel);

  // Security check: resolved path MUST be strictly inside memoryRoot
  const normalizedRoot = path.normalize(memoryRoot);
  const normalizedTarget = path.normalize(resolved);

  if (
    normalizedTarget !== normalizedRoot &&
    !normalizedTarget.startsWith(normalizedRoot + path.sep)
  ) {
    throw new Error(
      `Security violation: Memory path "${relOrAbsPath}" escapes memory root boundary "${memoryRoot}"`
    );
  }

  const cleanRel = path.relative(normalizedRoot, normalizedTarget) || path.basename(normalizedTarget);
  return { targetPath: normalizedTarget, relPath: cleanRel, memoryRoot: normalizedRoot };
}

/**
 * Creates the memory_read tool definition.
 */
export function createMemoryReadTool(options: MemoryReadToolOptions): ToolDefinition {
  const { dshHome, spacePath } = options;

  return {
    name: 'memory_read',
    description:
      'Read memory contents from global or space-specific persistent memory files with line offset and limit support.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path to memory file (e.g. "global.md", "topics/project.md", "2026-08-30.md"). Defaults to "global.md" or "space.md".',
        },
        scope: {
          type: 'string',
          enum: ['global', 'space'],
          description: 'Target memory scope: "global" (cross-space user memory) or "space" (current space memory). Defaults to "global".',
        },
        offset: {
          type: 'integer',
          minimum: 1,
          description: '1-based line number to start reading from (default: 1).',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 2000,
          description: 'Maximum number of lines to return (default: 200, max: 2000).',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          path: { type: 'string' },
          scope: { type: 'string', enum: ['global', 'space'] },
          content: { type: 'string' },
          totalBytes: { type: 'integer' },
          truncated: { type: 'boolean' },
          etag: { type: 'string' },
          lastModified: { type: 'string' },
        },
        required: ['success', 'path', 'scope', 'content', 'totalBytes', 'truncated', 'etag'],
        additionalProperties: false,
      },
      render: (_args: unknown, val: unknown) => {
        const value = val as MemoryReadResult;
        return [
          {
            type: 'text',
            text: `Memory File: [${value.scope}] ${value.path} (${value.totalBytes} bytes, etag: ${value.etag})\n\n${value.content}${value.truncated ? '\n\n[... truncated ...]' : ''}`,
          },
        ];
      },
    },
    async execute(rawArgs: unknown): Promise<MemoryReadResult> {
      const args = (rawArgs ?? {}) as MemoryReadArgs;
      const scope: MemoryScope = args.scope ?? 'global';
      const offset = Math.max(1, args.offset ?? 1);
      const limit = Math.min(Math.max(1, args.limit ?? DEFAULT_READ_LIMIT_LINES), MAX_READ_LIMIT_LINES);

      const { targetPath, relPath } = resolveSafeMemoryPath(args.path, scope, dshHome, spacePath);

      if (!fs.existsSync(targetPath)) {
        throw new Error(`Memory file not found: [${scope}] "${relPath}"`);
      }

      const stat = fs.statSync(targetPath);
      if (!stat.isFile()) {
        throw new Error(`Memory target is not a regular file: [${scope}] "${relPath}"`);
      }
      if (stat.size > MAX_READ_FILE_BYTES) {
        throw new Error(`Memory file exceeds maximum allowed size of ${MAX_READ_FILE_BYTES} bytes`);
      }

      const raw = fs.readFileSync(targetPath, 'utf-8');
      const lines = raw.split(/\r?\n/);
      const startIdx = offset - 1;
      const selectedLines = lines.slice(startIdx, startIdx + limit);
      const content = selectedLines.join('\n');
      const truncated = startIdx + limit < lines.length;

      const hash = computeContentHash(raw);
      const etag = `"${hash.slice(0, 16)}"`;

      return {
        success: true,
        path: relPath,
        scope,
        content,
        totalBytes: stat.size,
        truncated,
        etag,
        lastModified: stat.mtime.toISOString(),
      };
    },
  };
}
