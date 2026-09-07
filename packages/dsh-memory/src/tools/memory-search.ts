/**
 * memory_search Tool Implementation
 *
 * Implements bounded, scoped search over global memory and space memory directories.
 * Strictly prevents path traversal outside controlled memory directories.
 *
 * @module @enkeep/dsh-memory/tools/memory-search
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type {
  MemorySearchResult,
  MemorySearchMatch,
  MemorySearchScope,
  MemoryPlatformClientService,
} from '../types.js';

export const MAX_SEARCH_RESULTS_CAP = 100;
export const MAX_SNIPPET_LINE_LENGTH = 300;

export interface MemorySearchArgs {
  query: string;
  scope?: MemorySearchScope;
  regex?: boolean;
  maxResults?: number;
}

export interface MemorySearchToolOptions {
  dshHome: string;
  spacePath?: string;
  getClient?: () => MemoryPlatformClientService | undefined;
}

/**
 * Recursively scans directory for text/markdown files within depth and count bounds.
 */
function collectMemoryFiles(dir: string, maxFiles = 200, currentDepth = 0, maxDepth = 5): string[] {
  if (currentDepth > maxDepth || !fs.existsSync(dir)) return [];
  const results: string[] = [];

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // skip hidden
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        const subFiles = collectMemoryFiles(fullPath, maxFiles - results.length, currentDepth + 1, maxDepth);
        results.push(...subFiles);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (['.md', '.txt', '.markdown', '.json'].includes(ext) || entry.name === 'MEMORY') {
          results.push(fullPath);
        }
      }
      if (results.length >= maxFiles) break;
    }
  } catch {
    // Ignore unreadable dirs
  }

  return results;
}

/**
 * Searches a single file for occurrences of query / regex.
 */
function searchFile(
  filePath: string,
  relPath: string,
  scope: 'global' | 'space',
  matcher: (line: string) => boolean,
  maxMatches: number
): MemorySearchMatch[] {
  const matches: MemorySearchMatch[] = [];
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (matcher(line)) {
        const trimmedLine = line.length > MAX_SNIPPET_LINE_LENGTH
          ? `${line.slice(0, MAX_SNIPPET_LINE_LENGTH)}...`
          : line;

        matches.push({
          path: relPath,
          scope,
          line: i + 1,
          text: trimmedLine,
          snippet: trimmedLine,
        });

        if (matches.length >= maxMatches) break;
      }
    }
  } catch {
    // Ignore file read error
  }
  return matches;
}

/**
 * Creates the memory_search tool definition.
 */
export function createMemorySearchTool(options: MemorySearchToolOptions): ToolDefinition {
  const { dshHome, spacePath, getClient } = options;

  return {
    name: 'memory_search',
    description:
      'Search across persistent user memory (global and space-specific) by keyword or regular expression.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search keyword or regular expression pattern to find in memory files.',
        },
        scope: {
          type: 'string',
          enum: ['all', 'global', 'space'],
          description: 'Search scope: "global" for cross-session global memory, "space" for current workspace space memory, or "all" (default).',
        },
        regex: {
          type: 'boolean',
          description: 'Whether to interpret the query as a regular expression (default: false).',
        },
        maxResults: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Maximum number of search results to return (default: 20, max: 100).',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          query: { type: 'string' },
          scope: { type: 'string', enum: ['all', 'global', 'space'] },
          matches: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                scope: { type: 'string', enum: ['global', 'space'] },
                line: { type: 'integer' },
                text: { type: 'string' },
                snippet: { type: 'string' },
              },
              required: ['path', 'scope', 'line', 'text'],
            },
          },
          totalMatches: { type: 'integer' },
          truncated: { type: 'boolean' },
        },
        required: ['success', 'query', 'scope', 'matches', 'totalMatches', 'truncated'],
        additionalProperties: false,
      },
      render: (_args: unknown, val: unknown) => {
        const value = val as MemorySearchResult;
        if (!value.matches || value.matches.length === 0) {
          return [{ type: 'text', text: `No memory entries matching "${value.query}" found in ${value.scope} memory.` }];
        }
        const lines = [`Found ${value.totalMatches} match(es) for "${value.query}" in ${value.scope} memory:`];
        for (const m of value.matches) {
          lines.push(`- [${m.scope}] ${m.path}:${m.line} -> ${m.text}`);
        }
        if (value.truncated) {
          lines.push('(Results truncated to max limit)');
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(rawArgs: unknown): Promise<MemorySearchResult> {
      const args = rawArgs as MemorySearchArgs;
      if (!args || typeof args !== 'object' || typeof args.query !== 'string' || args.query.trim().length === 0) {
        throw new TypeError('memory_search requires a non-empty query string');
      }

      const query = args.query.trim();
      const scope = args.scope ?? 'all';
      const isRegex = Boolean(args.regex);
      const maxResults = Math.min(Math.max(1, args.maxResults ?? 20), MAX_SEARCH_RESULTS_CAP);

      let matcher: (line: string) => boolean;
      if (isRegex) {
        try {
          const re = new RegExp(query, 'i');
          matcher = (line: string) => re.test(line);
        } catch (err: unknown) {
          throw new TypeError(`Invalid regular expression in query: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        const lowerQuery = query.toLowerCase();
        matcher = (line: string) => line.toLowerCase().includes(lowerQuery);
      }

      const allMatches: MemorySearchMatch[] = [];

      // 1. Search Global Memory if scope includes global
      if (scope === 'all' || scope === 'global') {
        const globalDir = path.join(dshHome, 'memory');
        if (fs.existsSync(globalDir)) {
          const globalFiles = collectMemoryFiles(globalDir);
          for (const f of globalFiles) {
            const relPath = path.relative(globalDir, f);
            const fileMatches = searchFile(f, relPath, 'global', matcher, maxResults - allMatches.length);
            allMatches.push(...fileMatches);
            if (allMatches.length >= maxResults) break;
          }
        }
      }

      // 2. Search Space Memory if scope includes space and spacePath is set
      if ((scope === 'all' || scope === 'space') && spacePath) {
        const spaceMemDir = path.join(spacePath, 'memory');
        if (fs.existsSync(spaceMemDir)) {
          const spaceFiles = collectMemoryFiles(spaceMemDir);
          for (const f of spaceFiles) {
            const relPath = path.relative(spaceMemDir, f);
            const fileMatches = searchFile(f, relPath, 'space', matcher, maxResults - allMatches.length);
            allMatches.push(...fileMatches);
            if (allMatches.length >= maxResults) break;
          }
        }
      }

      return {
        success: true,
        query,
        scope,
        matches: allMatches,
        totalMatches: allMatches.length,
        truncated: allMatches.length >= maxResults,
      };
    },
  };
}
