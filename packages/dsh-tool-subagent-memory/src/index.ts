/**
 * Model-facing delegation tool with optional global memory injection.
 * Drop-in replacement for @deepseek-ai/dsh-tool-subagent@0.2.0-rc.2.
 *
 * Augmented with:
 * - Parameter `global_memory` (boolean, default false): include the user's global memory in the child's context.
 * - Carries `globalMemory` to child agent options so memory mount decides injection per child.
 *
 * Upstream source: @deepseek-ai/dsh-tool-subagent@0.2.0-rc.2 (src/index.ts)
 * @module @enkeep/dsh-tool-subagent-memory
 */

import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { scopeChainOf, scopeOf } from '@deepseek-ai/dsh-scope';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import { SessionSeq, type Session } from '@deepseek-ai/dsh-session';
import {
  assertSubagentMaxDepth,
  parentAgentOptionsForDelegation,
  settleRun,
} from '@deepseek-ai/dsh-subagent';
import type { SubagentProvider, SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent';
import type { JobOutcome } from '@deepseek-ai/dsh-jobs';
import {
  assertAllowedModelSelection,
  hasConfiguredLlmSelection,
  hasDelegationModelRequest,
  preflightChildLlmRoute,
  requestedAgentOptions,
} from './model-selection.js';
import type { DelegationModelRequest, ModelSelectionPolicy } from './model-selection.js';
import { registerListSubagentModels } from './list-models.js';
import type {} from './model-selection-settings.js';
import {
  recordSubagentModelSelection,
  subagentModelSelectionProjectionDefinition,
  subagentModelSelectionPolicy,
} from './model-selection-state.js';

declare module '@deepseek-ai/dsh-agent' {
  interface AgentOptions {
    globalMemory?: boolean;
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    agent?: Agent;
  }
}

export const name = 'tool-subagent-memory';
export const inject = ['tools', 'subagents', 'systemPrompt', 'sessionProjections'];

/** Config: which registered provider this tool delegates to, plus child defaults. */
export interface Config {
  /** The `ctx.subagents` provider name to start runs on (e.g. `spawn`, `acp`). */
  provider: string;
  /**
   * Model-facing tool name (default `subagent`). Each loaded instance must use
   * a distinct name.
   */
  toolName?: string;
  /**
   * Sample the Host `subagent-model-selection` user setting for each new
   * top-level session and inherit that decision in its child sessions.
   */
  modelSelectionSettings?: boolean;
  /**
   * Expose `run_in_background` (default true). Disabled instances omit the
   * parameter and reject forced background calls.
   */
  enableRunInBackground?: boolean;
  /**
   * Background execution policy (default `one-shot`). `one-shot` defaults calls
   * to foreground; `continuable` defaults them to background, requires a provider
   * with the `prepareContinuable` capability, and returns the durable child id.
   * Follow-up adapters remain independently optional.
   */
  backgroundMode?: 'one-shot' | 'continuable';
  /**
   * Agent options applied to every child; omitted fields use child-loop defaults.
   */
  agentOptions?: AgentOptions;
  /**
   * Per-child persona that shadows `deployment:persona`. Requires the
   * provider's `persona` capability; omission preserves the deployment persona.
   */
  persona?: string;
  /**
   * Tool filter applied to every child. Filtered tools disappear from its
   * prompt and reject execution. Requires the provider's `toolFilter`
   * capability; unknown names fail startup.
   */
  toolFilter?: {
    /** Global tool names the child keeps; everything else is removed. */
    allow?: string[];
    /** Global tool names removed from the child. */
    deny?: string[];
  };
  /**
   * Maximum child depth: a non-negative safe integer (default `3`; `0` forbids
   * delegation entirely), or `'provider-managed'` to send no cap.
   */
  maxDepth?: number | 'provider-managed';
}

export const Config: z<Config> = z.object({
  provider: z.string().required(),
  toolName: z.string().default('subagent'),
  modelSelectionSettings: z.boolean().default(false),
  enableRunInBackground: z.boolean().default(true),
  backgroundMode: z.union(['one-shot', 'continuable'] as const).default('one-shot'),
  agentOptions: z.object({
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string().min(1) as z<ReturnType<typeof ReasoningEffortId>>,
    maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  }).default(undefined as unknown as {
    provider: string;
    model: string;
    reasoningEffort: ReturnType<typeof ReasoningEffortId>;
    maxTokens: number;
  }),
  persona: z.string(),
  toolFilter: z.object({
    allow: z.array(z.string()).default(undefined as unknown as string[]),
    deny: z.array(z.string()).default(undefined as unknown as string[]),
  }).default(undefined as unknown as { allow: string[]; deny: string[] }),
  maxDepth: z.union([z.natural().max(Number.MAX_SAFE_INTEGER), z.const('provider-managed' as const)]).default(3),
});

/** Render text blocks from the canonical JSON block array without trusting arbitrary values. */
function outputValueText(values: JsonValue[]): string {
  return values
    .filter((value): value is { type: 'text'; text: string } =>
      typeof value === 'object' && value !== null && !Array.isArray(value)
      && value.type === 'text' && typeof value.text === 'string')
    .map(value => value.text)
    .join('');
}

/** Settle pending startup without rejecting the task producer contract. */
async function settleStart(start: Promise<SubagentRun>, signal: AbortSignal): Promise<JobOutcome> {
  try {
    return await settleRun(await start);
  } catch (error: unknown) {
    return signal.aborted && !(error instanceof AggregateError)
      ? { status: 'killed' }
      : { status: 'failed', detail: String(error) };
  }
}

/** A non-`completed` stop reason means the child did not finish cleanly. */
function stopReasonError(result: SubagentResult): string | undefined {
  switch (result.stopReason) {
    case 'completed':
      return undefined;
    case 'aborted':
      return 'subagent run was cancelled';
    case 'error':
      return 'subagent run failed';
    case 'max-tokens':
      return 'subagent run hit its token limit before finishing';
    case 'refusal':
      return 'subagent declined the task';
    default:
      return `subagent run ended abnormally (${String(result.stopReason)})`;
  }
}

/**
 * Append provider-authored failure detail and the child's preserved partial
 * answer to a stop-reason error.
 */
function withDiagnosticAndPartialText(error: string, result: SubagentResult): string {
  const diagnostic = result.diagnostic === undefined
    ? ''
    : `\nDiagnostic: ${result.diagnostic}`;
  const text = result.output
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('');
  const partial = text.length === 0
    ? ''
    : `\nPartial output before the run ended:\n${text}`;
  return `${error}${diagnostic}${partial}`;
}

type ForegroundToolResult = {
  readonly kind: 'foreground';
  readonly runId: SubagentRun['id'];
  readonly output: JsonValue[];
};

/** Collect and release one foreground run. */
async function settleForegroundRun(run: SubagentRun): Promise<ForegroundToolResult> {
  const [execution] = await Promise.allSettled([
    run.result.then((result): ForegroundToolResult => {
      const error = stopReasonError(result);
      if (error !== undefined) {
        throw new Error(withDiagnosticAndPartialText(error, result));
      }
      return {
        kind: 'foreground',
        runId: run.id,
        output: result.output as unknown as JsonValue[],
      };
    }),
  ]);
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())]);
  if (execution.status === 'rejected') {
    if (disposal.status === 'rejected') {
      throw new AggregateError(
        [execution.reason, disposal.reason],
        `subagent run failed: ${String(execution.reason)}; dispose failed: ${String(disposal.reason)}`,
      );
    }
    throw execution.reason;
  }
  if (disposal.status === 'rejected') throw disposal.reason;
  return execution.value;
}

/** Model-facing wording from provider context inheritance. */
function providerWording(inheritsConversation: boolean): { description: string; promptDescription: string } {
  if (inheritsConversation) {
    return {
      description:
        'Delegate a task to a subagent that inherits this conversation: a child agent seeded with all '
        + 'completed turns so far (it does not see the current in-flight turn). Use this when the subtask '
        + 'builds on this conversation\'s context — a follow-up analysis, '
        + 'a review, a continuation — without consuming this conversation\'s context for the work itself. '
        + 'You receive its result, not its intermediate steps.',
      promptDescription:
        'The task for the subagent. It already sees this conversation\'s completed turns, so build on them '
        + 'freely and state only what is new.',
    };
  }
  return {
    description:
      'Delegate a self-contained task to a subagent (a separate agent that works in its own context) '
      + 'to offload focused, independent work — research, a scoped '
      + 'implementation, an analysis — so it does not consume this conversation\'s context. The subagent '
      + 'returns its result, not its intermediate steps. Give it a '
      + 'complete, standalone prompt: it does not see this conversation.',
    promptDescription:
      'The complete, self-contained task for the subagent. It does not share this '
      + 'conversation\'s context, so include everything it needs.',
  };
}

interface DelegationRunRequest {
  readonly run_in_background?: boolean;
}

interface DelegationRunSpec {
  readonly runInBackground: boolean;
}

function resolveDelegationRun(
  request: DelegationRunRequest,
  options: { readonly backgroundEnabled: boolean; readonly continuable: boolean },
): DelegationRunSpec {
  if (!options.backgroundEnabled) {
    if (request.run_in_background === true) {
      throw new Error('run_in_background is disabled for this tool instance (enableRunInBackground: false)');
    }
    return { runInBackground: false };
  }
  return {
    runInBackground: request.run_in_background ?? options.continuable,
  };
}

export function apply(ctx: Context, config: Config, session?: Session): void {
  if (config.maxDepth !== 'provider-managed') assertSubagentMaxDepth(config.maxDepth);
  if (config.toolFilter !== undefined && config.toolFilter.allow === undefined && config.toolFilter.deny === undefined) {
    throw new Error('tool-subagent: `toolFilter` is configured but names neither `allow` nor `deny` — remove the key or fill the filter');
  }
  const backgroundEnabled = config.enableRunInBackground !== false;
  const continuable = (config.backgroundMode ?? 'one-shot') === 'continuable';
  const toolName = config.toolName ?? 'subagent';

  const modelSelectionCapable = config.modelSelectionSettings === true;
  ctx.sessionProjections.register(subagentModelSelectionProjectionDefinition);

  const assertSubagentProviderConfiguration = (subagentProvider: SubagentProvider): void => {
    if (typeof config.maxDepth === 'number' && !subagentProvider.capabilities.depthLimit) {
      throw new Error(
        `tool-subagent: provider "${subagentProvider.name}" cannot enforce maxDepth (no depthLimit capability) — `
        + 'set maxDepth: \'provider-managed\' to leave the recursion budget to the provider',
      );
    }
    if (config.agentOptions !== undefined && !subagentProvider.capabilities.agentOptions) {
      throw new Error(
        `tool-subagent: provider "${subagentProvider.name}" does not support child agentOptions`,
      );
    }
    if (modelSelectionCapable && !subagentProvider.capabilities.agentOptions) {
      throw new Error(
        `tool-subagent: provider "${subagentProvider.name}" does not support child model selection`,
      );
    }
    if (continuable && subagentProvider.prepareContinuable === undefined) {
      throw new Error(
        `tool-subagent: provider "${subagentProvider.name}" does not support \`backgroundMode: continuable\``,
      );
    }
  };

  ctx.on('subagent/provider-added', (subagentProvider) => {
    if (subagentProvider.name === config.provider) assertSubagentProviderConfiguration(subagentProvider);
  });
  const initialProvider = ctx.subagents.getProvider(config.provider);
  if (initialProvider !== undefined) assertSubagentProviderConfiguration(initialProvider);

  const install = (runtimeCtx: Context, modelSelectionPolicy: ModelSelectionPolicy | undefined): void => {
    const modelSelectionEnabled = modelSelectionPolicy !== undefined;
    if (modelSelectionPolicy !== undefined) registerListSubagentModels(runtimeCtx, modelSelectionPolicy);

    let mounted: { subagentProvider: SubagentProvider; disposeTool: () => void } | undefined;
    const mount = (subagentProvider: SubagentProvider): void => {
      assertSubagentProviderConfiguration(subagentProvider);
      const wording = providerWording(subagentProvider.inheritsParentContext);
      const providerRouteDefaults = subagentProvider.agentRouteDefaults;
      const selectionDescription = providerRouteDefaults !== undefined
        ? ' Child LLM selection is optional. Omit `provider`, `model`, and `reasoning_effort` to use configured child defaults and this provider\'s route defaults. Supply `provider` and `model` together after using `list_subagent_models` to inspect advertised routes and efforts. Changing the effective route without naming an effort uses the selected model\'s default effort.'
        : ' Child LLM selection is optional. Omit `provider`, `model`, and `reasoning_effort` to use configured child defaults and inherit compatible missing values from the parent Agent. Supply `provider` and `model` together after using `list_subagent_models` to inspect advertised routes and efforts. Changing the effective route without naming an effort uses the selected model\'s default effort.';
      const choiceDescription = !modelSelectionEnabled
        ? ''
        : selectionDescription
          + (subagentProvider.inheritsParentContext
            ? ' Changing the route can prevent provider-side reuse of the inherited conversation prefix.'
            : '');

      const disposeTool = runtimeCtx.tools.register(defineTool({
        name: toolName,
        description: wording.description + (backgroundEnabled
          ? continuable
            ? ' This tool runs in the background by default, immediately returns a durable subagent id, and keeps the child conversation available for later turns. When that run settles, the runtime sends the parent a notice containing its outcome and any final assistant message; `send_message` steers the child\'s nearest step while it is running and starts a turn while it is idle. Set `run_in_background: false` only when your next action depends on receiving the result.'
            : ' This call waits for the result by default. Set `run_in_background: true` to return a job id; collect with `job_output` and stop with `job_kill`.'
          : ' This call waits for the subagent and returns its result.') + choiceDescription,
        parameters: {
          description: {
            type: 'string',
            required: true,
            description: 'A short (3-5 word) description of the delegated task, for display.',
          },
          prompt: {
            type: 'string',
            required: true,
            description: wording.promptDescription,
          },
          ...modelSelectionEnabled ? {
            provider: {
              type: 'string' as const,
              description: providerRouteDefaults !== undefined
                ? 'LLM provider route for the child. Supply together with model; omit both to use configured child defaults or this provider\'s route defaults.'
                : 'LLM provider route for the child. Supply together with model; omit both to use configured child defaults or inherit the parent route.',
            },
            model: {
              type: 'string' as const,
              description: providerRouteDefaults !== undefined
                ? 'Model id interpreted by provider. Supply together with provider; omit both to use configured child defaults or this provider\'s route defaults.'
                : 'Model id interpreted by provider. Supply together with provider; omit both to use configured child defaults or inherit the parent route.',
            },
            reasoning_effort: {
              type: 'string' as const,
              description: providerRouteDefaults !== undefined
                ? 'Adapter-owned reasoning effort for the effective child route. Omit to use a compatible configured effort or the selected model\'s default.'
                : 'Adapter-owned reasoning effort for the effective child route. Omit to inherit a compatible configured/parent effort or use a newly selected model\'s default.',
            },
          } : {},
          ...backgroundEnabled ? {
            run_in_background: {
              type: 'boolean' as const,
              description: continuable
                ? 'Whether to run in the background and return a durable subagent id immediately. Defaults to true. Set false to wait for the result when your next action depends on it.'
                : 'Whether to run as a background job and return its id. Defaults to false; collect with job_output or stop with job_kill.',
            },
          } : {},
          global_memory: {
            type: 'boolean' as const,
            description: "include the user's global memory in the child's context",
          },
        },
        output: {
          schema: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'background' },
                  jobId: { type: 'string', required: true },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'continuable' },
                  subagentId: { type: 'string', required: true },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'foreground' },
                  runId: { type: 'string', required: true },
                  output: { type: 'array', required: true, items: { type: 'json' } },
                },
              },
            ],
          },
          render: (_args, value) => [{
            type: 'text',
            text: value.kind === 'background'
              ? `started background subagent job ${value.jobId}`
              : value.kind === 'continuable'
                ? `started subagent ${value.subagentId}`
                : outputValueText(value.output),
          }],
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const parent = exec.agent;
          if (!parent) {
            throw new Error('subagent tool requires a calling agent (exec.agent was undefined)');
          }

          const modelRequest = args as DelegationModelRequest;
          const parentOptions = parentAgentOptionsForDelegation(parent);
          const requiresRoutePreflight = hasDelegationModelRequest(modelRequest)
            || hasConfiguredLlmSelection(config.agentOptions);
          const configuredChildAgentOptions = requiresRoutePreflight && providerRouteDefaults !== undefined
            ? { ...providerRouteDefaults, ...config.agentOptions }
            : config.agentOptions;
          const requestedChildAgentOptions = requestedAgentOptions(
            parentOptions,
            configuredChildAgentOptions,
            modelRequest,
            modelSelectionEnabled,
          );
          assertAllowedModelSelection(
            modelSelectionPolicy,
            parentOptions,
            requestedChildAgentOptions,
            modelRequest,
          );
          if (requiresRoutePreflight) {
            const llm = runtimeCtx.get('llm');
            if (llm === undefined) {
              throw new Error('cannot resolve the selected child LLM route because the `llm` service is unavailable');
            }
            await preflightChildLlmRoute(
              llm,
              parentOptions,
              requestedChildAgentOptions,
              exec.signal,
              providerRouteDefaults === undefined,
            );
            if (runtimeCtx.subagents.getProvider(config.provider) !== subagentProvider) {
              throw new Error(`subagent provider "${config.provider}" changed while resolving the child LLM route; retry the delegation`);
            }
          }
          exec.signal.throwIfAborted();
          const maxDepth = typeof config.maxDepth === 'number' ? config.maxDepth : undefined;
          const globalMemory = Boolean((args as any).global_memory);

          const request = {
            label: args.description,
            prompt: [{ type: 'text', text: args.prompt }] as ContentBlock[],
            parent,
            agentOptions: {
              ...requestedChildAgentOptions,
              globalMemory,
            },
            ...config.persona !== undefined ? { persona: config.persona } : {},
            ...config.toolFilter !== undefined ? { toolFilter: config.toolFilter } : {},
            ...maxDepth !== undefined ? { maxDepth } : {},
          };

          const runSpec = resolveDelegationRun(args, { backgroundEnabled, continuable });
          if (runSpec.runInBackground) {
            if (continuable) {
              const started = await runtimeCtx.subagents.startContinuable({
                provider: config.provider,
                label: args.description,
                request,
                signal: exec.signal,
              });
              return { kind: 'continuable' as const, subagentId: started.childId };
            }
            const jobs = runtimeCtx.get('jobs');
            if (jobs === undefined) {
              throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs');
            }
            const id = jobs.start({
              kind: 'subagent',
              label: args.description,
              owner: parent.id,
              run: () => {
                const controller = new AbortController();
                const start = runtimeCtx.subagents.start(config.provider, { ...request, signal: controller.signal });
                return {
                  cancel: (reason?: string) => {
                    controller.abort(reason ?? 'background subagent task killed');
                  },
                  done: settleStart(start, controller.signal),
                };
              },
            });
            return { kind: 'background' as const, jobId: id };
          }

          const run: SubagentRun = await runtimeCtx.subagents.start(config.provider, {
            ...request,
            signal: exec.signal,
          });
          return settleForegroundRun(run);
        },
      }));
      mounted = { subagentProvider, disposeTool };
    };

    runtimeCtx.on('subagent/provider-added', (subagentProvider) => {
      if (subagentProvider.name === config.provider && mounted === undefined) mount(subagentProvider);
    });
    runtimeCtx.on('subagent/provider-removed', (name) => {
      if (name !== config.provider || mounted === undefined) return;
      mounted.disposeTool();
      mounted = undefined;
    });
    const present = runtimeCtx.subagents.getProvider(config.provider);
    if (present !== undefined) {
      mount(present);
    } else {
      runtimeCtx.logger?.info?.(`subagent provider "${config.provider}" not registered yet; the "${config.toolName ?? 'subagent'}" tool will register when it appears`);
    }
    if (backgroundEnabled && continuable) {
      runtimeCtx.systemPrompt.section({
        name: `tool:${toolName}`,
        order: runtimeCtx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
        text: context => mounted === undefined || runtimeCtx.tools.get(toolName, context.scope) === undefined
          ? ''
          : `Use ${toolName} in the background by default. Start independent delegations together in one assistant message and continue useful work while they run. Set \`run_in_background: false\` only when your next action depends on that subagent's result. When a background run settles, the runtime sends you a notice containing its outcome and any final assistant message.`,
      });
    }
  };

  if (config.modelSelectionSettings !== true) {
    install(ctx, undefined);
    return;
  }

  const settings = ctx.get('subagentModelSelection');
  if (settings === undefined) {
    throw new Error(
      'tool-subagent: `modelSelectionSettings` requires '
      + '@deepseek-ai/dsh-tool-subagent/model-selection-settings in the Host scope',
    );
  }

  const selectForSession = (target: Session): ModelSelectionPolicy | undefined => {
    const freshSession = target.firstLiveSeq === 0
      && target.eventAt(SessionSeq(0))?.type !== 'session/end-seed';
    let allowedModels = subagentModelSelectionPolicy(ctx.sessionProjections, target);
    if (allowedModels === undefined) {
      const parentId = target.header.origin === 'subagent'
        ? target.header.parentSession
        : undefined;
      if (parentId !== undefined) {
        const sessions = ctx.get('sessions');
        if (sessions === undefined) throw new Error('tool-subagent: child model-selection inheritance requires the Session registry');
        const parent = sessions.get(parentId);
        allowedModels = parent === undefined
          ? undefined
          : subagentModelSelectionPolicy(ctx.sessionProjections, parent);
      } else if (freshSession) {
        const current = settings.current();
        allowedModels = current.enabled ? current.allowedModels : undefined;
      }
    }
    if (allowedModels !== undefined) {
      recordSubagentModelSelection(ctx.sessionProjections, target, allowedModels);
    }
    return allowedModels === undefined ? undefined : { routes: allowedModels };
  };

  const currentSession = session ?? ctx.get('session') ?? (ctx.get ? (ctx.get('agent') as any)?.session : undefined);
  if (currentSession !== undefined) {
    install(ctx, selectForSession(currentSession));
    return;
  }

  const compositionScope = scopeOf(ctx);
  if (compositionScope === undefined) {
    throw new Error('tool-subagent: standing `modelSelectionSettings` requires a scoped preset Context');
  }

  const agents = ctx.get('agents');
  if (agents === undefined) throw new Error('tool-subagent: standing `modelSelectionSettings` requires the Agent registry');
  const scopedInstalls = new WeakMap<Agent, ReturnType<Context['inject']>>();
  const installing = new WeakSet<Agent>();
  const belongsToComposition = (candidate: Agent): boolean =>
    scopeChainOf(scopeOf(candidate.ctx)).includes(compositionScope);
  const installScoped = (candidate: Agent): void => {
    if (scopedInstalls.has(candidate) || installing.has(candidate)) return;
    installing.add(candidate);
    let fiber: ReturnType<Context['inject']>;
    try {
      const policy = selectForSession(candidate.session);
      fiber = candidate.ctx.inject(['tools', 'subagents', 'systemPrompt'], (runtimeCtx) => {
        install(runtimeCtx, policy);
      });
    } finally {
      installing.delete(candidate);
    }
    scopedInstalls.set(candidate, fiber);
  };
  const removeScoped = (candidate: Agent): void => {
    const fiber = scopedInstalls.get(candidate);
    if (fiber === undefined) return;
    scopedInstalls.delete(candidate);
    void fiber.dispose().catch((error: unknown) => {
      ctx.logger?.warn?.(`tool-subagent: failed to remove recomposed Agent "${candidate.id}" definitions: ${String(error)}`);
    });
  };
  const reconcileComposedAgents = (): void => {
    for (const candidate of agents.list()) {
      if (belongsToComposition(candidate)) installScoped(candidate);
      else removeScoped(candidate);
    }
  };
  ctx.on('agent/created', async ({ agent: created }) => {
    installScoped(created);
    return undefined;
  });
  ctx.on('agent/disposed', ({ agent: disposed }) => { removeScoped(disposed); });
  ctx.on('tools/change', reconcileComposedAgents);
  reconcileComposedAgents();
}

export default {
  name,
  inject,
  Config,
  apply,
};
