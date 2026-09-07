/**
 * Memory Service & Cordis Lifecycle Orchestration
 *
 * Implements:
 * 1. MemoryService on Cordis context (`ctx.memory` / `ctx.enkeepMemory`).
 * 2. Mounts memory onto agent scoped context (`agentCtx`).
 * 3. Registers `<enkeep_memory>` prompt section at order 50 on `agentCtx.systemPrompt`.
 * 4. Registers `memory_search`, `memory_read`, `memory_write` tools in `agentCtx.tools`.
 * 5. Returns deterministic MemoryMountHandle with cleanup disposer.
 *
 * @module @enkeep/dsh-memory/service
 */

import { Service, Context, type Fiber } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type {
  AssembleMemoryOptions,
  MountAgentMemoryOptions,
  MemoryMountHandle,
  MemorySnapshot,
  MemoryPlatformClientService,
} from './types.js';
import {
  MEMORY_SECTION_NAME,
  MEMORY_SECTION_ORDER,
  ensureGlobalMemorySkeleton,
  assembleMemoryPromptSection,
} from './prompt.js';
import { createMemorySearchTool } from './tools/memory-search.js';
import { createMemoryReadTool } from './tools/memory-read.js';
import { createMemoryWriteTool } from './tools/memory-write.js';

export class MemoryService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'memory');
  }

  /**
   * Ensures the global memory skeleton exists under dshHome.
   */
  ensureSkeleton(dshHome: string): string {
    return ensureGlobalMemorySkeleton(dshHome);
  }

  /**
   * Assembles the prompt section and snapshot representation.
   */
  assembleSection(options: AssembleMemoryOptions): {
    text: string;
    hash: string;
    revision: string;
    snapshot: MemorySnapshot;
  } {
    return assembleMemoryPromptSection(options);
  }

  /**
   * Resolves PlatformClient if mounted on context.
   */
  private resolvePlatformClient(ctx: Context): MemoryPlatformClientService | undefined {
    return ctx.get('platformClient');
  }

  /**
   * Mounts memory subsystem onto an agent's scoped context.
   *
   * @param agentCtx - Scoped Cordis context for the active Agent
   * @param options - Mount options including paths, user, space, and memoryPlan
   * @returns MemoryMountHandle with snapshot and composite disposer
   */
  mountAgentMemory(agentCtx: Context, options: MountAgentMemoryOptions): MemoryMountHandle {
    const { dshHome, spacePath, spaceId, userId, memoryPlan, maxGlobalBytes } = options;

    // 1. Ensure skeleton on disk
    ensureGlobalMemorySkeleton(dshHome);

    // 2. Assemble prompt section and snapshot
    const assembled = assembleMemoryPromptSection({
      dshHome,
      spacePath,
      spaceId,
      userId,
      maxGlobalBytes,
      memoryPlan,
    });

    const disposers: Array<() => void> = [];

    // 3. Register system prompt section at order 50
    const systemPrompt = agentCtx.get('systemPrompt');
    if (systemPrompt && typeof systemPrompt.section === 'function') {
      const disposeSection = systemPrompt.section({
        name: MEMORY_SECTION_NAME,
        order: MEMORY_SECTION_ORDER,
        text: assembled.text,
      });
      if (typeof disposeSection === 'function') {
        disposers.push(disposeSection);
      }
    }

    // 4. Create and register memory tools
    const getClient = () => this.resolvePlatformClient(agentCtx);

    const searchTool = createMemorySearchTool({ dshHome, spacePath, getClient });
    const readTool = createMemoryReadTool({ dshHome, spacePath, getClient });
    const writeTool = createMemoryWriteTool({ dshHome, spacePath, spaceId, userId, getClient });

    const toolsToRegister: ToolDefinition[] = [searchTool, readTool, writeTool];
    const registeredToolNames = toolsToRegister.map(t => t.name);

    const toolsService = agentCtx.get('tools');
    if (toolsService && typeof toolsService.register === 'function') {
      for (const tool of toolsToRegister) {
        const disposeTool = toolsService.register(tool);
        if (typeof disposeTool === 'function') {
          disposers.push(disposeTool);
        }
      }
    }

    return {
      snapshot: assembled.snapshot,
      hash: assembled.hash,
      revision: assembled.revision,
      registeredTools: registeredToolNames,
      dispose: () => {
        const errors: Error[] = [];
        for (const dispose of disposers) {
          try {
            if (typeof dispose === 'function') {
              dispose();
            }
          } catch (err: unknown) {
            errors.push(err instanceof Error ? err : new Error(String(err)));
          }
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, 'Memory mount cleanup failed');
        }
      },
    };
  }
}
