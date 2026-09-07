/**
 * CLI Tool Service & Cordis Lifecycle Orchestration
 *
 * Implements:
 * 1. CliToolService on Cordis context (`ctx.cliTools`).
 * 2. `mountActivationPlan(agentCtx, plan, options)` method.
 * 3. Registers canonical `cli__<key>__run` into `agentCtx.tools`.
 * 4. Returns clean disposers for turn-by-turn lifecycle / disposal.
 *
 * @module @enkeep/dsh-tool-cli/service
 */

import { Service, Context } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type {
  ExtensionActivationPlan,
  ExtensionCliContributionActivation,
  CliPluginConfig,
  CliMountOptions,
  CliMountHandle,
} from './types.js';
import { createCliToolExecutor } from './executor.js';

export class CliToolService extends Service {
  static inject = [];

  private readonly config: CliPluginConfig;

  constructor(ctx: Context, config: CliPluginConfig = {}) {
    super(ctx, 'cliTools');
    this.config = config;
  }

  /**
   * Consumes ExtensionActivationPlan CLI contributions and mounts them onto an Agent's scoped context.
   * If no enabled CLI contributions are present, returns an empty disposer handle immediately.
   *
   * @param agentCtx - Scoped Cordis context for the active Agent
   * @param plan - ExtensionActivationPlan containing cli contributions
   * @param options - Mount options including spacePath and limits
   * @returns CliMountHandle with registered tools and cleanup disposer
   */
  async mountActivationPlan(
    agentCtx: Context,
    plan?: ExtensionActivationPlan | null,
    options: CliMountOptions = {}
  ): Promise<CliMountHandle> {
    const registeredTools = new Map<string, ToolDefinition>();
    const disposers: Array<() => void> = [];

    // Filter active CLI contributions
    const cliContributions: ExtensionCliContributionActivation[] = Array.isArray(plan?.cli)
      ? plan.cli.filter((c) => c.enabled !== false)
      : Array.isArray(plan?.contributions)
      ? (plan.contributions.filter((c) => c.kind === 'cli' && c.enabled !== false) as ExtensionCliContributionActivation[])
      : [];

    if (cliContributions.length === 0) {
      return {
        registeredTools,
        dispose: async () => {},
      };
    }

    const toolsService = agentCtx.get('tools') ?? (agentCtx as unknown as { tools?: { register: (def: ToolDefinition) => (() => void) } }).tools;

    for (const contrib of cliContributions) {
      const sanitizedKey = contrib.contributionKey.replace(/[^a-zA-Z0-9_]/g, '_');
      const toolName = `cli__${sanitizedKey}__run`;

      const toolDef: ToolDefinition = {
        name: toolName,
        description: contrib.description ?? `Run deterministic CLI tool ${contrib.name}`,
        parameters: {
          type: 'object',
          properties: {
            args: {
              type: 'array',
              items: { type: 'string' },
              description: 'Command line arguments to pass to the tool',
            },
          },
          required: ['args'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              stdout: { type: 'string' },
              stderr: { type: 'string' },
              exitCode: { type: 'number' },
            },
            required: ['stdout', 'stderr', 'exitCode'],
            additionalProperties: false,
          },
          render: (_args: unknown, value: any) => {
            const outText = (value?.stdout ?? '').trim();
            const errText = (value?.stderr ?? '').trim();
            const combined = [outText, errText].filter(Boolean).join('\n');
            return [{ type: 'text', text: combined || `(exit code ${value?.exitCode ?? 0})` }];
          },
        },
        isConcurrencySafe: () => false,
        timeoutMs: contrib.timeoutMs ?? options.defaultTimeoutMs ?? this.config.defaultTimeoutMs ?? 15000,
        execute: createCliToolExecutor(agentCtx, {
          contrib,
          toolName,
          spacePath: options.spacePath,
          timeoutMs: options.defaultTimeoutMs ?? this.config.defaultTimeoutMs,
          maxOutputBytes: options.maxOutputBytes ?? this.config.maxOutputBytes,
        }),
      };

      if (toolsService && typeof toolsService.register === 'function') {
        const dispose = toolsService.register(toolDef);
        if (typeof dispose === 'function') {
          disposers.push(dispose);
          registeredTools.set(toolName, toolDef);
        }
      }
    }

    return {
      registeredTools,
      dispose: async () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {}
        }
        registeredTools.clear();
      },
    };
  }
}
