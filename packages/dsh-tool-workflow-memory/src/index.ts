/**
 * Model-facing workflow tool with per-call global memory support.
 * Drop-in replacement for @deepseek-ai/dsh-tool-workflow@0.2.0-rc.2.
 *
 * Augmented with:
 * - Documents agent(prompt, opts) option `globalMemory` (boolean, default false).
 * - Exports enhanced PtcWorkflowEngine that supports per-call globalMemory.
 *
 * Upstream source: @deepseek-ai/dsh-tool-workflow@0.2.0-rc.2 (lib/index.js)
 * @module @enkeep/dsh-tool-workflow-memory
 */

import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type { WorkflowResult, WorkflowStopReason } from '@deepseek-ai/dsh-workflow';
import { createWorkflowRecordMirror, createWorkflowRecorder } from './record.js';
import { PtcWorkflowEngine } from './engine.js';

export { PtcWorkflowEngine } from './engine.js';

export const name = 'tool-workflow-memory';
export const inject = ['tools', 'workflowEngine', 'systemPrompt'];

export interface Config {
  toolName?: string;
  maxResultChars?: number;
  enableRunInBackground?: boolean;
}

export const Config: z<Config> = z.object({
  toolName: z.string().default('workflow'),
  maxResultChars: z.natural().min(1).default(50_000),
  enableRunInBackground: z.boolean().default(true),
});

type ResolvedConfig = Required<Config>;

export const DESCRIPTION = `Run a JavaScript workflow script that orchestrates subagents at scale. Use this for work that fans out across many independent pieces — an audit over many files, a migration, multi-angle research, adversarial verification of findings — where you write the orchestration as a script instead of delegating turn by turn.

The workflow's identity rides the \`meta\` parameter as JSON: required \`name\` (short kebab-case) and \`description\` strings, optional \`whenToUse\` string and \`phases\` array (\`{title, detail?, provider?, model?}\`). The \`script\` parameter is the plain JavaScript body ONLY (NOT TypeScript, and NO \`export const meta\` statement — meta is a parameter, not code), running with top-level await; end with \`return <value>\` — the value must be JSON-serializable and is this tool's result.

Script-body hooks:
- \`agent(prompt, opts?): Promise<any>\` — run one subagent to completion. Without \`opts.schema\` it resolves to the child's final text; with \`opts.schema\` (an object-rooted JSON Schema using ONLY type/properties/required/additionalProperties/items/enum/const/oneOf — no pattern/format/numeric bounds) it resolves to the validated object. Resolves \`null\` when the child fails (filter with \`.filter(Boolean)\`). Other opts: \`label\` (display), \`phase\` (progress group), \`globalMemory\` (boolean, default false; include the user's global memory in the child's context), and independent \`provider\`/\`model\` LLM target overrides (either may be provided alone). Anything else (\`effort\`/\`isolation\`/\`agentType\`) is rejected loudly.
- \`pipeline(items, ...stages): Promise<any[]>\` — run each item through the stages independently with NO barrier between stages (prefer this for multi-stage work). Each stage receives \`(prev, item, index)\`. An ordinary stage throw drops that ITEM to \`null\` and skips its remaining stages.
- \`parallel(thunks): Promise<any[]>\` — run zero-argument functions concurrently and await ALL of them (a barrier; use only when a stage genuinely needs every prior result together). A throwing thunk resolves to \`null\`.
- \`phase(title)\` — start a progress phase; \`log(message)\` — narrate progress; \`args\` — the tool call's \`args\` input, verbatim.

Misused hooks (bad arguments, unknown options, unsupported schemas, tripped caps) throw errors that ALWAYS kill the script — they never dissolve into a per-item \`null\`.

Constraints: concurrency and total-agent caps apply; no filesystem, network, timers, or Node.js APIs are provided — the agents do the work, the script only coordinates them. The run executes in the foreground: this call returns when the whole script finishes.`;

function presentWorkflowCall(args: any): ToolCallView {
  return {
    card: 'generic',
    title: `workflow: ${args.meta.name}`,
    rawInput: args.script,
  };
}

function presentWorkflowResult(args: any, result: any): ToolResultView {
  void args;
  void result;
  return { card: 'generic' };
}

function stopReasonError(result: WorkflowResult): string | undefined {
  switch (result.stopReason) {
    case 'completed':
      return undefined;
    case 'cancelled':
      return `workflow run was cancelled${result.error !== undefined ? ` (${result.error})` : ''}`;
    case 'error':
      return `workflow run failed: ${result.error ?? 'unknown error'}`;
    default:
      return `workflow run ended abnormally (${String(result.stopReason)})`;
  }
}

function renderResult(name: string, agentsStarted: number, value: JsonValue, maxChars: number): string {
  const rendered = JSON.stringify(value, null, 2);
  const clipped = rendered.length > maxChars
    ? `${rendered.slice(0, maxChars)}\n… [truncated: ${rendered.length - maxChars} more characters]`
    : rendered;
  return `workflow "${name}" completed (${agentsStarted} agent${agentsStarted === 1 ? '' : 's'}).\nReturn value:\n${clipped}`;
}

function jobOutcomeOf(result: WorkflowResult, name: string, maxChars: number): any {
  switch (result.stopReason) {
    case 'completed':
      return { status: 'completed', result: renderResult(name, result.agentsStarted, result.value as JsonValue, maxChars) };
    case 'cancelled':
      return { status: 'killed', detail: result.error };
    case 'error':
      return { status: 'failed', detail: result.error ?? 'workflow execution failed' };
    default:
      return { status: 'failed', detail: `workflow run ended abnormally (${String(result.stopReason)})` };
  }
}

function startBackgroundRun(ctx: Context, args: any, parent: any, recordsRun: boolean, services: any) {
  const jobs = ctx.get('jobs');
  if (jobs === undefined) {
    throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs');
  }
  const meta = args.meta;
  const script = args.script;
  const scriptArgs = args.args;
  const maxResultChars = services.maxResultChars;
  const jobId = (jobs as any).start({
    kind: 'workflow',
    label: `workflow: ${meta.name}`,
    owner: parent.id,
    run: (task: any) => {
      const run = ctx.workflowEngine.start({
        script,
        meta,
        ...scriptArgs !== undefined ? { args: scriptArgs } : {},
        parent,
        signal: task.signal,
      });
      if (recordsRun) services.recorder.start(parent.session, run);
      services.mirror.start(run.id, task);
      return {
        cancel: (reason?: string) => {
          run.cancel(reason ?? 'background workflow task killed');
        },
        done: (async () => {
          try {
            const result = await run.result;
            return jobOutcomeOf(result, meta.name, maxResultChars);
          } finally {
            services.mirror.stop(run.id);
            try {
              await run.dispose();
              if (recordsRun) {
                const settled = await run.result.catch(() => undefined);
                if (settled !== undefined) services.recorder.finish(run.id, settled.stopReason);
              }
            } finally {
              if (recordsRun) services.recorder.abandon(run.id);
            }
          }
        })(),
      };
    },
  });
  return {
    kind: 'background' as const,
    jobId,
  };
}

export function apply(ctx: Context, config: Config): void {
  const { toolName, maxResultChars, enableRunInBackground } = config as ResolvedConfig;
  const recorder = createWorkflowRecorder(ctx);
  const mirror = createWorkflowRecordMirror(ctx);

  ctx.systemPrompt.section({
    name: `tool:${toolName}`,
    order: ctx.systemPrompt.getSectionOrder('TOOL_WORKFLOW'),
    text: `Use the ${toolName} tool ONLY when the user explicitly asks for a workflow or for large multi-agent orchestration: you write a JavaScript script (the tool description documents the exact format) that fans work out across many subagents with phases and structured results. For one or two delegations, prefer plain subagent calls.`,
  });

  ctx.tools.register(defineTool({
    name: toolName,
    description: DESCRIPTION,
    parameters: {
      script: {
        type: 'string',
        required: true,
        description: 'The plain-JS workflow script body (top-level await allowed; NO `export const meta` statement; end with `return <json-value>`).',
      },
      meta: {
        type: 'object',
        additionalProperties: true,
        required: true,
        description: 'The workflow identity block (plain JSON — never code).',
        properties: {
          name: { type: 'string', required: true, description: 'Short kebab-case workflow name.' },
          description: { type: 'string', required: true, description: 'One-line description of what the workflow does.' },
          whenToUse: { type: 'string', description: 'Optional guidance on when this workflow applies.' },
          phases: {
            type: 'array',
            description: 'Optional phase declarations matched by phase() calls.',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                title: { type: 'string', required: true, description: 'The phase title phase() calls match by exact string.' },
                detail: { type: 'string', description: 'Optional one-line description of the phase.' },
                provider: { type: 'string', description: 'Optional provider override this phase is expected to use.' },
                model: { type: 'string', description: 'Optional model override this phase is expected to use.' },
              },
            },
          },
        },
      },
      args: {
        type: 'object',
        additionalProperties: true,
        description: 'Optional JSON input exposed to the script as the `args` global (wrap a bare list as a field, e.g. {"files": [...]}).',
      },
      ...enableRunInBackground ? {
        run_in_background: {
          type: 'boolean',
          description: 'Whether to run the workflow in the background and return a job id immediately. Defaults to false (wait for completion in foreground).',
        },
      } : {},
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
              kind: { type: 'string', required: true, const: 'foreground' },
              runId: { type: 'string', required: true },
              agentsStarted: { type: 'integer', required: true },
              result: { type: 'json', required: true },
            },
          },
        ],
      },
      render: (args, value: any) => [{
        type: 'text',
        text: value.kind === 'background'
          ? `workflow "${args.meta.name}" started in the background as job ${value.jobId}. Its return value arrives with the completion notice; check on it with job_output, stop it with job_kill.`
          : renderResult(args.meta.name, value.agentsStarted, value.result, maxResultChars),
      }],
    },
    async execute(args, exec) {
      const parent = exec.agent;
      if (!parent) {
        throw new Error('workflow tool requires a calling agent (exec.agent was undefined)');
      }
      if (args.run_in_background === true) {
        if (!enableRunInBackground) throw new Error('run_in_background is disabled for this tool');
        return startBackgroundRun(ctx, args, parent, exec.parent === undefined, {
          recorder,
          mirror,
          maxResultChars,
        });
      }

      const run = ctx.workflowEngine.start({
        script: args.script,
        meta: args.meta,
        ...args.args !== undefined ? { args: args.args } : {},
        parent,
        signal: exec.signal,
      });
      const recordsRun = exec.parent === undefined;
      if (recordsRun) recorder.start(parent.session, run);

      const onAbort = (): void => {
        run.cancel('parent step aborted');
      };
      exec.signal.addEventListener('abort', onAbort, { once: true });

      let result: WorkflowResult | undefined;
      try {
        result = await run.result;
        const error = stopReasonError(result);
        if (error !== undefined) {
          throw new Error(error);
        }
        return {
          kind: 'foreground' as const,
          runId: String(run.id),
          agentsStarted: result.agentsStarted,
          result: result.value as JsonValue,
        };
      } finally {
        exec.signal.removeEventListener('abort', onAbort);
        try {
          await run.dispose();
          if (recordsRun) {
            if (result === undefined) throw new Error('workflow run settled without a result');
            recorder.finish(run.id, result.stopReason);
          }
        } finally {
          if (recordsRun) recorder.abandon(run.id);
        }
      }
    },
    presentCall: args => presentWorkflowCall(args),
    presentResult: (args, result) => presentWorkflowResult(args, result),
  }));
}

export const ToolWorkflowPlugin = {
  name,
  inject,
  Config,
  apply,
};

export default ToolWorkflowPlugin;
