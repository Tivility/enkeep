/**
 * memory_write Tool Implementation
 *
 * Implements safe, atomic writing and appending to global or space-specific memory files.
 * Supports optimistic concurrency control via `expectedEtag`.
 * Uses PlatformClient if available for audit and quota, with fallback to atomic local filesystem write.
 *
 * @module @enkeep/dsh-memory/tools/memory-write
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type {
  MemoryWriteResult,
  MemoryWriteMode,
  MemoryScope,
  MemoryPlatformClientService,
} from '../types.js';
import { computeContentHash } from '../prompt.js';
import { resolveSafeMemoryPath } from './memory-read.js';

export const MAX_WRITE_BYTES = 5 * 1024 * 1024; // 5MB max payload per write

export interface MemoryWriteArgs {
  path?: string;
  content: string;
  scope?: MemoryScope;
  mode?: MemoryWriteMode;
  expectedEtag?: string;
}

export interface MemoryWriteToolOptions {
  dshHome: string;
  spacePath?: string;
  spaceId?: string;
  userId?: string;
  getClient?: () => MemoryPlatformClientService | undefined;
}

/**
 * Performs an atomic file write using temp file and rename.
 */
export function atomicWriteFileSync(targetPath: string, content: string): void {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const tempPath = path.join(dir, `.tmp_mem_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`);
  try {
    fs.writeFileSync(tempPath, content, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tempPath, targetPath);
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {}
    throw err;
  }
}

/**
 * Creates the memory_write tool definition.
 */
export function createMemoryWriteTool(options: MemoryWriteToolOptions): ToolDefinition {
  const { dshHome, spacePath, spaceId, userId, getClient } = options;

  return {
    name: 'memory_write',
    description:
      'Write or append knowledge, user preferences, or facts into persistent global memory or current space memory. Supports optimistic concurrency via expectedEtag.',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'Text or Markdown content to write or append to the memory file.',
        },
        path: {
          type: 'string',
          description: 'Relative file path inside the memory root (e.g. "global.md", "space.md", "2026-08-30.md", "topics/ideas.md"). Defaults to "global.md" or "space.md".',
        },
        scope: {
          type: 'string',
          enum: ['global', 'space'],
          description: 'Target memory scope: "global" (accessible across all sessions) or "space" (confined to current space). Defaults to "global".',
        },
        mode: {
          type: 'string',
          enum: ['overwrite', 'append'],
          description: 'Write mode: "overwrite" (replace entire file) or "append" (add to end of file). Defaults to "overwrite".',
        },
        expectedEtag: {
          type: 'string',
          description: 'Optional expected etag/hash of existing file for optimistic concurrency control. Throws error if file was modified by another session.',
        },
      },
      required: ['content'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          path: { type: 'string' },
          scope: { type: 'string', enum: ['global', 'space'] },
          bytesWritten: { type: 'integer' },
          etag: { type: 'string' },
          mode: { type: 'string', enum: ['overwrite', 'append'] },
          isNewFile: { type: 'boolean' },
          previousEtag: { type: 'string' },
        },
        required: ['success', 'path', 'scope', 'bytesWritten', 'etag', 'mode', 'isNewFile'],
        additionalProperties: false,
      },
      render: (_args: unknown, val: unknown) => {
        const value = val as MemoryWriteResult;
        return [
          {
            type: 'text',
            text: `Memory updated: [${value.scope}] ${value.path} (${value.bytesWritten} bytes ${value.mode}ed, new etag: ${value.etag})`,
          },
        ];
      },
    },
    async execute(rawArgs: unknown): Promise<MemoryWriteResult> {
      const args = (rawArgs ?? {}) as MemoryWriteArgs;
      if (typeof args.content !== 'string') {
        throw new TypeError('memory_write requires a content string');
      }

      const content = args.content;
      const contentBytes = Buffer.byteLength(content, 'utf-8');
      if (contentBytes > MAX_WRITE_BYTES) {
        throw new TypeError(`Memory write content exceeds maximum limit of ${MAX_WRITE_BYTES} bytes`);
      }

      const scope: MemoryScope = args.scope ?? 'global';
      const mode: MemoryWriteMode = args.mode ?? 'overwrite';

      // 1. Resolve safe target path
      const { targetPath, relPath } = resolveSafeMemoryPath(args.path, scope, dshHome, spacePath);

      // 2. Check existing file state & optimistic concurrency
      const isNewFile = !fs.existsSync(targetPath);
      let existingContent = '';
      let previousEtag: string | undefined;

      if (!isNewFile) {
        existingContent = fs.readFileSync(targetPath, 'utf-8');
        const prevHash = computeContentHash(existingContent);
        previousEtag = `"${prevHash.slice(0, 16)}"`;

        if (args.expectedEtag) {
          const cleanExpected = args.expectedEtag.replace(/^W\//, '').trim();
          if (cleanExpected !== previousEtag && cleanExpected !== prevHash) {
            throw new Error(
              `Memory write conflict: expectedEtag "${args.expectedEtag}" does not match current etag ${previousEtag}`
            );
          }
        }
      } else if (args.expectedEtag) {
        throw new Error(`Memory write conflict: expectedEtag provided but file does not exist`);
      }

      // 3. Compute final content
      let finalContent = content;
      if (mode === 'append' && !isNewFile) {
        finalContent = existingContent.endsWith('\n')
          ? `${existingContent}${content}`
          : `${existingContent}\n${content}`;
      }

      // 4. Try Platform Client for audit & quota if available
      const client = getClient ? getClient() : undefined;
      if (client && typeof client.request === 'function') {
        try {
          await client.request('/api/memory/write', {
            method: 'POST',
            body: {
              path: relPath,
              scope,
              mode,
              content: finalContent,
              userId,
              spaceId,
              previousEtag,
            },
            timeoutMs: 15_000,
          });
        } catch {
          // Fall back to direct atomic local write if platform server offline or endpoint missing
        }
      }

      // 5. Write atomically to disk
      atomicWriteFileSync(targetPath, finalContent);

      const newHash = computeContentHash(finalContent);
      const newEtag = `"${newHash.slice(0, 16)}"`;
      const writtenBytes = Buffer.byteLength(finalContent, 'utf-8');

      return {
        success: true,
        path: relPath,
        scope,
        bytesWritten: writtenBytes,
        etag: newEtag,
        mode,
        isNewFile,
        previousEtag,
      };
    },
  };
}
