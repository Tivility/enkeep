/**
 * Memory Plugin Type Definitions
 *
 * @module @enkeep/dsh-memory/types
 */

import type { Context, Fiber } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { MemoryInjectionMode, MemoryPlan } from '@enkeep/protocol';

export type { MemoryInjectionMode, MemoryPlan };

export type MemoryScope = 'global' | 'space';
export type MemorySearchScope = 'all' | 'global' | 'space';
export type MemoryWriteMode = 'overwrite' | 'append';

/**
 * Single matching snippet from memory search.
 */
export interface MemorySearchMatch {
  readonly path: string;
  readonly scope: MemoryScope;
  readonly line: number;
  readonly text: string;
  readonly snippet?: string;
}

/**
 * Result of memory_search tool execution.
 */
export interface MemorySearchResult {
  readonly success: boolean;
  readonly query: string;
  readonly scope: MemorySearchScope;
  readonly matches: readonly MemorySearchMatch[];
  readonly totalMatches: number;
  readonly truncated: boolean;
}

/**
 * Result of memory_read tool execution.
 */
export interface MemoryReadResult {
  readonly success: boolean;
  readonly path: string;
  readonly scope: MemoryScope;
  readonly content: string;
  readonly totalBytes: number;
  readonly truncated: boolean;
  readonly etag: string;
  readonly lastModified?: string;
}

/**
 * Result of memory_write tool execution.
 */
export interface MemoryWriteResult {
  readonly success: boolean;
  readonly path: string;
  readonly scope: MemoryScope;
  readonly bytesWritten: number;
  readonly etag: string;
  readonly mode: MemoryWriteMode;
  readonly isNewFile: boolean;
  readonly previousEtag?: string;
}

/**
 * Snapshot representation of loaded memory for prompt assembly.
 */
export interface MemorySnapshot {
  readonly globalMemory?: {
    readonly path: string;
    readonly content: string;
    readonly etag: string;
    readonly size: number;
    readonly truncated: boolean;
  };
  readonly spaceMemory?: {
    readonly spaceId?: string;
    readonly spacePath?: string;
    readonly available: boolean;
    readonly summary?: string;
    readonly filesCount?: number;
  };
  readonly revision: string;
  readonly hash: string;
}

/**
 * Options passed to memory prompt section assembly.
 */
export interface AssembleMemoryOptions {
  readonly dshHome: string;
  readonly spacePath?: string;
  readonly spaceId?: string;
  readonly userId?: string;
  readonly injectGlobalMemory?: MemoryInjectionMode;
  readonly maxGlobalBytes?: number;
  readonly memoryPlan?: MemoryPlan | null;
}

/**
 * Options for mounting memory onto an agent's scoped context.
 */
export interface MountAgentMemoryOptions {
  readonly dshHome: string;
  readonly spacePath: string;
  readonly spaceId?: string;
  readonly userId?: string;
  readonly memoryPlan?: MemoryPlan | null;
  readonly maxGlobalBytes?: number;
  readonly defaultApproval?: 'ask' | 'never';
}

/**
 * Disposable handle returned when memory is mounted on an agent context.
 */
export interface MemoryMountHandle {
  readonly snapshot: MemorySnapshot;
  readonly hash: string;
  readonly revision: string;
  readonly registeredTools: readonly string[];
  readonly dispose: () => Promise<void> | void;
}

/**
 * Narrow Platform Client interface for memory operations.
 */
export interface MemoryPlatformClientService {
  request?<T = unknown>(
    path: string,
    options?: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string | undefined>;
      query?: Record<string, string | number | boolean | undefined | null>;
      timeoutMs?: number;
      signal?: AbortSignal;
      [key: string]: unknown;
    }
  ): Promise<{ data?: T; status: number; body?: T; headers?: Record<string, unknown> }>;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    memory?: import('./service.js').MemoryService;
    enkeepMemory?: import('./service.js').MemoryService;
    platformClient?: any;
  }
}
