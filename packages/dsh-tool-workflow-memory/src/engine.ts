/**
 * PTC-backed workflow engine with optional per-call global memory injection support.
 * Upstream source: @deepseek-ai/dsh-workflow-ptc@0.2.0-rc.2 (lib/index.js)
 *
 * Augmented with:
 * - Accepts opts.globalMemory from guest agent(prompt, opts) calls.
 * - Forwards globalMemory via agentOptions in subagents.start() so memory mount injects per child.
 *
 * @module @enkeep/dsh-tool-workflow-memory/engine
 */

import { randomUUID } from 'node:crypto';
import { availableParallelism } from 'node:os';
import * as vm from 'node:vm';
import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import WorkflowEngine, { WorkflowError, WorkflowRunId } from '@deepseek-ai/dsh-workflow';
import type {
  WorkflowAgentEndInfo,
  WorkflowAgentInfo,
  WorkflowMeta,
  WorkflowResult,
  WorkflowRun,
  WorkflowStartRequest,
} from '@deepseek-ai/dsh-workflow';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools';
import { assertNever, snapshotJsonValue } from '@deepseek-ai/dsh-util-values';
import { validateMeta } from '@deepseek-ai/dsh-workflow-ptc';
import { WORKFLOW_GUEST_SOURCE } from './guest-source.js';

const GUEST_URL = `data:text/javascript,${encodeURIComponent(WORKFLOW_GUEST_SOURCE)}`;
const PROGRAM = `const { runWorkflowGuest } = await import(${JSON.stringify(GUEST_URL)}); return await runWorkflowGuest(workflowHost);`;

function object(value: unknown): Record<string, any> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('workflow binding requires an object');
  }
  return value as Record<string, any>;
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`workflow ${name} must be a string`);
  return value;
}

function json(value: unknown): unknown {
  const result = snapshotJsonValue(value as any);
  if (result === undefined) throw new Error('workflow binding value must be lossless JSON');
  return result;
}

function childRequest(value: unknown): {
  prompt: string;
  provider?: string;
  model?: string;
  schema?: any;
  globalMemory?: boolean;
} {
  const request = object(value);
  const prompt = text(request.prompt, 'prompt');
  const provider = request.provider === undefined ? undefined : text(request.provider, 'provider');
  const model = request.model === undefined ? undefined : text(request.model, 'model');
  const globalMemory = typeof request.globalMemory === 'boolean' ? request.globalMemory : false;
  let schema: any;
  if (request.schema !== undefined) {
    const candidate = object(request.schema);
    assertObjectJsonSchema(candidate);
    schema = candidate;
  }
  return {
    prompt,
    ...provider === undefined ? {} : { provider },
    ...model === undefined ? {} : { model },
    ...schema === undefined ? {} : { schema },
    ...globalMemory ? { globalMemory: true } : {},
  };
}

function agentInfo(value: unknown): WorkflowAgentInfo {
  const info = object(value);
  if (!Number.isSafeInteger(info.seq) || info.seq < 1) {
    throw new Error('workflow agent sequence must be a positive integer');
  }
  return {
    seq: info.seq,
    label: text(info.label, 'agent label'),
    childId: SessionId(text(info.childId, 'child id')),
    ...info.phase === undefined ? {} : { phase: text(info.phase, 'agent phase') },
  };
}

function progress(value: unknown): any {
  const event = object(value);
  switch (event.type) {
    case 'phase':
      return {
        type: 'phase',
        title: text(event.title, 'phase'),
      };
    case 'log':
      return {
        type: 'log',
        message: text(event.message, 'log'),
      };
    case 'agent-start':
      return {
        type: 'agent-start',
        info: agentInfo(event.info),
      };
    case 'agent-end': {
      const info = object(event.info);
      if (info.outcome !== 'completed' && info.outcome !== 'failed' && info.outcome !== 'cancelled') {
        throw new Error('invalid workflow agent outcome');
      }
      return {
        type: 'agent-end',
        info: {
          ...agentInfo(info),
          outcome: info.outcome,
        },
      };
    }
    default:
      throw new Error('invalid workflow progress event');
  }
}

function progressBatch(value: unknown): any[] {
  if (!Array.isArray(value)) throw new Error('workflow progress requires an array of events');
  return value.map(progress);
}

function workflowResult(value: unknown): WorkflowResult {
  const result = object(value);
  if (result.stopReason !== 'completed' && result.stopReason !== 'error' && result.stopReason !== 'cancelled') {
    throw new Error('invalid workflow stop reason');
  }
  if (!Number.isSafeInteger(result.agentsStarted) || result.agentsStarted < 0) {
    throw new Error('invalid workflow agent count');
  }
  if (!Object.hasOwn(result, 'value')) throw new Error('workflow result is missing its value');
  return {
    value: result.value,
    stopReason: result.stopReason,
    agentsStarted: result.agentsStarted,
    ...result.error === undefined ? {} : { error: text(result.error, 'error') },
  };
}

function renderThrown(error: unknown): string {
  try {
    const stack = (error as any)?.stack;
    if (typeof stack === 'string' && stack.length > 0) return stack;
    const message = (error as any)?.message;
    if (typeof message === 'string' && message.length > 0) return message;
    return String(error);
  } catch {
    return '[unrenderable thrown value]';
  }
}

function createResolvers<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface ChildRecord {
  readonly callId: number;
  readonly run: any;
  disposal?: Promise<void>;
}

export class PtcWorkflowRun implements WorkflowRun {
  readonly controller = new AbortController();
  readonly children = new Map<number, ChildRecord>();
  readonly pending = new Set<Promise<any>>();
  readonly liveAgents = new Map<number, WorkflowAgentInfo>();
  started = 0;
  terminal = false;
  cancelReason?: string;
  disposed?: Promise<void>;
  externalAbort: () => void;
  readonly result: Promise<WorkflowResult>;

  constructor(
    readonly ctx: Context,
    readonly subagents: any,
    readonly runtime: any,
    readonly id: WorkflowRunId,
    readonly meta: WorkflowMeta,
    readonly parent: Agent,
    readonly init: any,
    readonly provider: string,
    readonly policy: any,
    readonly observer: {
      phase(title: string): void;
      log(message: string): void;
      agentStart(agent: WorkflowAgentInfo): void;
      agentEnd(agent: WorkflowAgentEndInfo): void;
    },
    readonly signal?: AbortSignal,
  ) {
    this.externalAbort = () => {
      this.cancel('workflow signal aborted');
    };
    if (signal?.aborted) this.externalAbort();
    else signal?.addEventListener('abort', this.externalAbort, { once: true });
    this.result = Promise.resolve().then(() => this.drive());
  }

  cancel(reason = 'workflow cancelled'): void {
    if (this.terminal || this.cancelReason !== undefined) return;
    this.cancelReason = reason;
    this.controller.abort(reason);
    for (const record of this.children.values()) this.disposeChild(record);
  }

  dispose(): Promise<void> {
    this.cancel('workflow disposed');
    this.disposed ??= this.result.then(() => {});
    return this.disposed;
  }

  private requireActive(): void {
    this.controller.signal.throwIfAborted();
  }

  private track<T>(task: Promise<T>): Promise<T> {
    this.pending.add(task);
    task.then(
      () => { this.pending.delete(task); },
      () => { this.pending.delete(task); },
    );
    return task;
  }

  private bindings() {
    return {
      begin: () => {
        this.requireActive();
        return Promise.resolve(json(this.init));
      },
      startChild: (value: unknown) => this.track(this.startChild(childRequest(value))),
      childResult: (value: unknown) => this.track(this.childResult(this.child(value))),
      disposeChild: async (value: unknown) => {
        await this.disposeChild(this.child(value));
        return null;
      },
      progress: (value: unknown) => {
        for (const event of progressBatch(value)) this.onProgress(event);
        return Promise.resolve(null);
      },
    };
  }

  private child(value: unknown): ChildRecord {
    this.requireActive();
    const callId = object(value).callId;
    if (!Number.isSafeInteger(callId)) throw new Error('workflow child call id must be an integer');
    const record = this.children.get(callId);
    if (record === undefined) throw new Error('workflow child call is not active');
    return record;
  }

  private async startChild(request: ReturnType<typeof childRequest>) {
    this.requireActive();
    const callId = ++this.started;
    const run = await this.subagents.start(this.provider, {
      prompt: [{
        type: 'text',
        text: request.prompt,
      }],
      parent: this.parent,
      signal: this.controller.signal,
      ...request.schema === undefined ? {} : { outputSchema: request.schema },
      agentOptions: {
        ...request.provider === undefined ? {} : { provider: request.provider },
        ...request.model === undefined ? {} : { model: request.model },
        ...request.globalMemory ? { globalMemory: true } : {},
      },
    });
    const record: ChildRecord = {
      callId,
      run,
    };
    this.children.set(callId, record);
    if (this.controller.signal.aborted) {
      await this.disposeChild(record);
      throw new Error('workflow child started after cancellation');
    }
    return {
      callId,
      childId: run.id,
    };
  }

  private async childResult(record: ChildRecord) {
    const signal = this.controller.signal;
    signal.throwIfAborted();
    const aborted = createResolvers<never>();
    const onAbort = () => {
      aborted.reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const result = await Promise.race([record.run.result, aborted.promise]);
      return json({
        output: result.output,
        stopReason: result.stopReason,
        ...result.structured === undefined ? {} : { structured: result.structured },
      });
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  private disposeChild(record: ChildRecord): Promise<void> {
    record.disposal ??= Promise.resolve().then(() => record.run.dispose()).catch((error) => {
      this.ctx.logger?.warn?.(`workflow-ptc: child dispose failed: ${renderThrown(error)}`);
    }).finally(() => {
      this.children.delete(record.callId);
    });
    return record.disposal;
  }

  private onProgress(event: any): void {
    this.requireActive();
    switch (event.type) {
      case 'phase':
        this.observer.phase(event.title);
        break;
      case 'log':
        this.observer.log(event.message);
        break;
      case 'agent-start':
        this.liveAgents.set(event.info.seq, event.info);
        this.observer.agentStart(event.info);
        break;
      case 'agent-end':
        this.endAgent(event.info);
        break;
      default:
        assertNever(event as never, 'workflow progress');
    }
  }

  private endAgent(info: WorkflowAgentInfo & { outcome: any }): void {
    if (!this.liveAgents.delete(info.seq)) return;
    this.observer.agentEnd(info);
  }

  private cancelled(): WorkflowResult {
    return {
      value: null,
      stopReason: 'cancelled',
      error: `workflow run cancelled: ${this.cancelReason}`,
      agentsStarted: this.started,
    };
  }

  private async drive(): Promise<WorkflowResult> {
    let result: WorkflowResult;
    try {
      const outcome = await this.runtime.run(this.runtime.resolve({
        program: PROGRAM,
        bindings: [{
          global: 'workflowHost',
          functions: this.bindings(),
        }],
        cwd: this.policy.workspaceRoot,
        sandboxPolicy: this.policy,
        timeoutMs: null,
        signal: this.controller.signal,
      }));
      this.terminal = true;
      if (this.cancelReason !== undefined) result = this.cancelled();
      else if (outcome.error !== undefined) {
        result = {
          value: null,
          stopReason: 'error',
          error: `workflow execution failed (${outcome.error.kind}): ${outcome.error.message}`,
          agentsStarted: this.started,
        };
      } else {
        result = workflowResult(outcome.value);
      }
    } catch (error: unknown) {
      this.terminal = true;
      result = this.cancelReason === undefined ? {
        value: null,
        stopReason: 'error',
        error: renderThrown(error),
        agentsStarted: this.started,
      } : this.cancelled();
    } finally {
      this.terminal = true;
      this.signal?.removeEventListener('abort', this.externalAbort);
      this.controller.abort('workflow settled');
      for (const record of this.children.values()) this.disposeChild(record);
      while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
      await Promise.all([...this.children.values()].map(record => this.disposeChild(record)));
      this.children.clear();
      for (const info of this.liveAgents.values()) {
        this.endAgent({
          ...info,
          outcome: 'cancelled',
        });
      }
    }
    return result;
  }
}

const META_STATEMENT = /^\s*export\s+const\s+meta\b/;

function assertBodyParses(body: string, name: string): void {
  if (META_STATEMENT.test(body)) {
    throw new WorkflowError('workflow meta rides the `meta` request field, not the script: remove the `export const meta = {...}` statement from the body', 'SCRIPT_PARSE');
  }
  try {
    void new vm.Script(`(async () => {\n${body}\n})()`, {
      filename: `workflow:${name}`,
      lineOffset: -1,
    });
  } catch (error: unknown) {
    throw new WorkflowError(`workflow script does not parse: ${String(error)}`, 'SCRIPT_PARSE', { cause: error });
  }
}

function resolveSubagentProvider(ctx: Context, configured: string, override?: string): string {
  const provider = override ?? configured;
  if (provider.length === 0 || provider !== provider.trim()) {
    throw new WorkflowError('workflow subagentProvider must be a non-empty normalized string', 'INVALID_ARGUMENT');
  }
  if ((ctx as any).subagents?.getProvider(provider) === undefined) {
    throw new WorkflowError(`no subagent provider registered for "${provider}"`, 'AGENT_START');
  }
  return provider;
}

function resolveMaxTotalAgents(requested: number | undefined, ceiling: number): number {
  if (requested === undefined) return ceiling;
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new WorkflowError('workflow maxTotalAgents must be a positive safe integer', 'INVALID_ARGUMENT');
  }
  if (requested > ceiling) {
    throw new WorkflowError(`workflow maxTotalAgents ${requested} exceeds the engine ceiling ${ceiling}`, 'INVALID_ARGUMENT');
  }
  return requested;
}

export interface PtcWorkflowEngineConfig {
  provider?: string;
  maxConcurrentAgents?: number;
  maxTotalAgents?: number;
  maxItemsPerCall?: number;
  syncTimeoutMs?: number;
}

export class PtcWorkflowEngine extends WorkflowEngine {
  static inject = [
    'subagents',
    'ptcRuntime',
    'sandboxPolicy',
  ];

  static Config: z<PtcWorkflowEngineConfig> = z.object({
    provider: z.string().default('spawn'),
    maxConcurrentAgents: z.natural().default(0),
    maxTotalAgents: z.natural().min(1).default(1e3),
    maxItemsPerCall: z.natural().min(1).default(4096),
    syncTimeoutMs: z.natural().min(1).default(5e3),
  });

  private readonly config: Required<PtcWorkflowEngineConfig>;

  constructor(ctx: Context, config: PtcWorkflowEngineConfig = {}) {
    super(ctx);
    if ((ctx as any).ptcRuntime?.language !== 'typescript') {
      throw new Error('workflow-ptc requires the Node TypeScript PTC runtime');
    }
    this.config = {
      provider: config.provider ?? 'spawn',
      maxConcurrentAgents: config.maxConcurrentAgents ?? 0,
      maxTotalAgents: config.maxTotalAgents ?? 1000,
      maxItemsPerCall: config.maxItemsPerCall ?? 4096,
      syncTimeoutMs: config.syncTimeoutMs ?? 5000,
    };
  }

  start(request: WorkflowStartRequest): WorkflowRun {
    const meta = validateMeta(request.meta);
    assertBodyParses(request.script, meta.name);
    const subagentProvider = resolveSubagentProvider(this.ctx, this.config.provider, request.subagentProvider);
    const maxTotalAgents = resolveMaxTotalAgents(request.maxTotalAgents, this.config.maxTotalAgents);
    const id = WorkflowRunId(randomUUID());
    const info = {
      id,
      meta,
    };
    const limits = {
      maxConcurrentAgents: this.config.maxConcurrentAgents === 0
        ? Math.min(16, Math.max(1, availableParallelism() - 2))
        : this.config.maxConcurrentAgents,
      maxTotalAgents,
      maxItemsPerCall: this.config.maxItemsPerCall,
      syncTimeoutMs: this.config.syncTimeoutMs,
    };
    const init = {
      meta,
      body: request.script,
      ...request.args !== undefined ? { args: structuredClone(request.args) } : {},
      limits,
    };
    const runCtx = this.ctx;
    const subagents = (runCtx as any).subagents;
    const run = new PtcWorkflowRun(
      runCtx,
      subagents,
      (runCtx as any).ptcRuntime,
      id,
      meta,
      request.parent,
      init,
      subagentProvider,
      (runCtx as any).sandboxPolicy.resolve({ session: request.parent.session }),
      {
        phase: (title) => {
          this.emitWorkflowEvent('workflow/phase', info, title);
        },
        log: (message) => {
          this.emitWorkflowEvent('workflow/log', info, message);
        },
        agentStart: (agent) => {
          this.emitWorkflowEvent('workflow/agent-start', info, agent);
        },
        agentEnd: (agent) => {
          this.emitWorkflowEvent('workflow/agent-end', info, agent);
        },
      },
      request.signal,
    );
    this.emitWorkflowEvent('workflow/start', info);
    run.result.then((settled) => {
      this.emitWorkflowEvent('workflow/end', info, {
        stopReason: settled.stopReason,
        ...settled.error !== undefined ? { error: settled.error } : {},
        agentsStarted: settled.agentsStarted,
      });
    });
    return run;
  }
}

export default PtcWorkflowEngine;
