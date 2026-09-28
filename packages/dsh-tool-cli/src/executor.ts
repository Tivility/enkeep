/**
 * Tool Execution Bridge for CLI Tools
 *
 * Spawns deterministic Node CLI contributions or bound native CLI tools (e.g. feishu-cli)
 * inside runtime boundary (Space workspace) using `process.execPath` or binary invocation
 * with strict parameter bounding, human approval enforcement, tenant-scoped configuration,
 * output limits, and lifecycle disposal.
 *
 * Phase Status: G16-P2 (Executor Integration & Scoped Provider Wiring).
 *
 * @module @enkeep/dsh-tool-cli/executor
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import type { Context } from '@deepseek-ai/cordis';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import type {
  ExtensionCliContributionActivation,
  CliToolCallInput,
  CliToolCallOutput,
  LarkScopedConfigHandle,
  LarkScopedConfigProvider,
} from './types.js';
import {
  CliToolError,
  ContainerSupportPendingError,
  TenantContextMissingError,
  ScopedConfigProviderUnavailableError,
  LarkAmbiguousBoundAppError,
  LarkBoundAppNotFoundError,
} from './errors.js';
import { enforceCliApproval } from './approvals.js';
import { resolveCallerScope } from './scope.js';
import {
  isFeishuCliTool,
  assertNoConfigOverride,
  resolveLarkScopedConfigProvider,
} from './feishu-bridge.js';

export interface CreateCliExecutorOptions {
  readonly contrib: ExtensionCliContributionActivation;
  readonly toolName: string;
  readonly spacePath?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly userId?: string;
  readonly spaceId?: string;
  readonly channelAccountId?: string;
  readonly executionMode?: 'container' | 'host' | 'space';
  readonly larkScopedConfigProvider?: LarkScopedConfigProvider;
  readonly boundFeishuCli?: boolean;
}

export const MAX_CLI_ARGS_COUNT = 32;
export const MAX_CLI_ARG_LENGTH_BYTES = 4096;
export const DEFAULT_CLI_TIMEOUT_MS = 15000;
export const MAX_CLI_TIMEOUT_MS = 60000;
export const DEFAULT_CLI_MAX_OUTPUT_BYTES = 1048576; // 1MB

function isPathInside(childPath: string, parentPath: string): boolean {
  const rel = path.relative(parentPath, childPath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function buildScrubbedEnv(): Record<string, string> {
  const allowlist = ['PATH', 'NODE_ENV', 'TMPDIR', 'HOME', 'LANG', 'LC_ALL', 'USER'];
  const env: Record<string, string> = {
    NODE_ENV: process.env.NODE_ENV || 'production',
  };
  for (const key of allowlist) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key]!;
    }
  }
  return env;
}

export function validateCliInputArgs(rawArgs: unknown): string[] {
  if (rawArgs === undefined || rawArgs === null) {
    return [];
  }
  if (!Array.isArray(rawArgs)) {
    throw new CliToolError('CLI tool arguments must be an array of strings', 'INVALID_ARGUMENTS', 400);
  }
  if (rawArgs.length > MAX_CLI_ARGS_COUNT) {
    throw new CliToolError(
      `CLI tool received ${rawArgs.length} arguments, exceeding maximum limit of ${MAX_CLI_ARGS_COUNT}`,
      'ARGUMENTS_OVERFLOW',
      400
    );
  }

  const result: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const item = rawArgs[i];
    if (typeof item !== 'string') {
      throw new CliToolError(`CLI tool argument at index ${i} must be a string`, 'INVALID_ARGUMENTS', 400);
    }
    if (Buffer.byteLength(item, 'utf8') > MAX_CLI_ARG_LENGTH_BYTES) {
      throw new CliToolError(
        `CLI tool argument at index ${i} exceeds maximum allowed size of ${MAX_CLI_ARG_LENGTH_BYTES} bytes`,
        'ARGUMENT_TOO_LARGE',
        400
      );
    }
    result.push(item);
  }
  return result;
}

interface RunProcessOptions {
  ctx: Context;
  command: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
  execContext?: ToolRunContext;
}

async function runProcess(options: RunProcessOptions): Promise<CliToolCallOutput> {
  const { ctx, command, argv, cwd, env, timeoutMs, maxOutputBytes, execContext } = options;

  const subprocessService =
    (ctx.get ? (ctx.get('subprocess') as any) : undefined) ??
    (ctx as any).root?.get?.('subprocess') ??
    (ctx as any).subprocess;

  if (subprocessService && typeof subprocessService.spawn === 'function') {
    const ac = new AbortController();
    const timeoutId = setTimeout(() => {
      ac.abort(new CliToolError(`CLI command timed out after ${timeoutMs}ms`, 'CLI_TIMEOUT', 504));
    }, timeoutMs);

    let onAbort: (() => void) | undefined;
    if (execContext?.signal) {
      if (execContext.signal.aborted) {
        ac.abort(execContext.signal.reason);
      } else {
        onAbort = () => ac.abort(execContext.signal!.reason);
        execContext.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    try {
      const handle = subprocessService.spawn({
        argv: [command, ...argv],
        cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: maxOutputBytes },
          stderr: { maxBytes: maxOutputBytes },
        },
        graceMs: 2000,
        signal: ac.signal,
        env,
      });

      const outcome = await (handle.done ?? handle.settled);
      const stdoutRead = handle.collected?.stdout?.readFrom(0);
      const stderrRead = handle.collected?.stderr?.readFrom(0);
      const stdout = stdoutRead?.text ?? '';
      const stderr = stderrRead?.text ?? '';

      return {
        stdout: stdout.slice(0, maxOutputBytes),
        stderr: stderr.slice(0, maxOutputBytes),
        exitCode: outcome?.exitCode ?? (outcome?.signal ? 128 : 0),
      };
    } finally {
      clearTimeout(timeoutId);
      if (onAbort && execContext?.signal) {
        execContext.signal.removeEventListener('abort', onAbort);
      }
    }
  }

  // Fallback: Node child_process.spawn
  return new Promise<CliToolCallOutput>((resolve, reject) => {
    let stdoutBuf = '';
    let stderrBuf = '';
    let settled = false;

    const cp = nodeSpawn(command, argv, {
      cwd,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          cp.kill('SIGKILL');
        } catch {}
        reject(new CliToolError(`CLI command timed out after ${timeoutMs}ms`, 'CLI_TIMEOUT', 504));
      }
    }, timeoutMs);

    const abortHandler = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        try {
          cp.kill('SIGKILL');
        } catch {}
        reject(new CliToolError('CLI execution was cancelled', 'CLI_CANCELLED', 499));
      }
    };

    if (execContext?.signal) {
      if (execContext.signal.aborted) {
        abortHandler();
        return;
      }
      execContext.signal.addEventListener('abort', abortHandler, { once: true });
    }

    cp.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutBuf.length < maxOutputBytes) {
        stdoutBuf += chunk.toString('utf8');
      }
    });

    cp.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBuf.length < maxOutputBytes) {
        stderrBuf += chunk.toString('utf8');
      }
    });

    cp.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (execContext?.signal) {
          execContext.signal.removeEventListener('abort', abortHandler);
        }
        reject(new CliToolError(`Failed to spawn CLI process: ${err.message}`, 'CLI_SPAWN_ERROR', 500));
      }
    });

    cp.on('close', (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (execContext?.signal) {
          execContext.signal.removeEventListener('abort', abortHandler);
        }
        resolve({
          stdout: stdoutBuf.slice(0, maxOutputBytes),
          stderr: stderrBuf.slice(0, maxOutputBytes),
          exitCode: code ?? (signal ? 128 : 0),
        });
      }
    });
  });
}

export function createCliToolExecutor(
  ctx: Context,
  options: CreateCliExecutorOptions
): (input: unknown, execContext?: ToolRunContext) => Promise<CliToolCallOutput> {
  const { contrib, toolName, spacePath } = options;
  const rawTimeout = contrib.timeoutMs ?? options.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
  const timeoutMs = Math.min(Math.max(1000, rawTimeout), MAX_CLI_TIMEOUT_MS);
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_CLI_MAX_OUTPUT_BYTES;
  const isFeishu = isFeishuCliTool(contrib, toolName) && options.boundFeishuCli !== false;

  return async (input: unknown, execContext?: ToolRunContext): Promise<CliToolCallOutput> => {
    // 1. Validate input args
    const rawArgs = input && typeof input === 'object' && 'args' in input ? (input as CliToolCallInput).args : [];
    const modelArgs = validateCliInputArgs(rawArgs);

    // 2. Resolve caller scope and enforce platform human approval
    const scope = resolveCallerScope(execContext, ctx);
    await enforceCliApproval({
      ctx,
      execContext,
      toolName,
      contribName: contrib.name,
      args: modelArgs,
      agent: scope.agent,
    });

    const effectiveSpacePath = path.resolve(spacePath ?? process.cwd());

    // ──────────────────────────────────────────────────────────
    // Non-Feishu Binaries: Standard workspace script execution path (Unchanged)
    // ──────────────────────────────────────────────────────────
    if (!isFeishu) {
      const relScript = contrib.artifactRelPath ?? contrib.script ?? 'index.js';
      const resolvedScript = path.resolve(effectiveSpacePath, relScript);

      if (!isPathInside(resolvedScript, effectiveSpacePath)) {
        throw new CliToolError(
          `Security violation: CLI script path "${relScript}" resolves outside workspace boundary "${effectiveSpacePath}"`,
          'PATH_TRAVERSAL_DENIED',
          403
        );
      }

      if (!fs.existsSync(resolvedScript)) {
        throw new CliToolError(
          `CLI script "${relScript}" not found at "${resolvedScript}"`,
          'CLI_SCRIPT_NOT_FOUND',
          404
        );
      }

      const fixedArgs = contrib.fixedArgs ?? [];
      const fullArgv = [resolvedScript, ...fixedArgs, ...modelArgs];
      const cwd = path.dirname(resolvedScript);
      const scrubbedEnv = buildScrubbedEnv();

      return runProcess({
        ctx,
        command: process.execPath,
        argv: fullArgv,
        cwd,
        env: scrubbedEnv,
        timeoutMs,
        maxOutputBytes,
        execContext,
      });
    }

    // ──────────────────────────────────────────────────────────
    // Feishu CLI: Scoped bound Bot identity resolution & ephemeral config
    // ──────────────────────────────────────────────────────────

    // 1. Prohibit user-supplied --config argument overriding bound identity
    assertNoConfigOverride(modelArgs);

    // 2. Check execution mode: Host mode supported; container mode pending
    const executionMode = contrib.executionMode ?? options.executionMode ?? 'host';
    if (executionMode === 'container') {
      throw new ContainerSupportPendingError(
        'Feishu CLI scoped binding in container mode is pending: host-private config file is not shared into container filesystem. Host mode required.'
      );
    }

    // 3. Obtain trusted tenant / space contextual metadata
    const userId = scope.userId ?? options.userId;
    const spaceId = scope.spaceId ?? options.spaceId;
    const channelAccountId = (execContext as any)?.channelAccountId ?? options.channelAccountId;

    if (!userId) {
      throw new TenantContextMissingError(
        'Tenant userId could not be derived from context for bound Feishu CLI tool execution'
      );
    }

    // 4. Resolve host platform service provider
    const provider = resolveLarkScopedConfigProvider(ctx, options);
    if (!provider) {
      throw new ScopedConfigProviderUnavailableError(
        'No Lark/Feishu scoped configuration provider registered on host platform service'
      );
    }

    // 5. Obtain ephemeral scoped config handle
    let configHandle: LarkScopedConfigHandle | null = null;
    try {
      configHandle = await provider({
        userId,
        spaceId,
        channelAccountId,
      });
    } catch (err: any) {
      if (err?.code === 'AMBIGUOUS_BOUND_APP' || err?.name === 'LarkAmbiguousBoundAppError') {
        throw new LarkAmbiguousBoundAppError(
          err.message ?? `Multiple active Feishu accounts bound to space "${spaceId}" without explicit selection`,
          spaceId ?? 'unspecified',
          userId,
          err.candidateAccountIds ?? []
        );
      }
      if (err instanceof CliToolError) throw err;
      throw new CliToolError(
        `Failed to resolve Lark scoped configuration: ${err?.message ?? String(err)}`,
        err?.code || 'LARK_SCOPED_CONFIG_ERROR',
        err?.status || 500,
        err
      );
    }

    if (!configHandle) {
      throw new LarkBoundAppNotFoundError(
        `No active Feishu/Lark channel account is bound to space "${spaceId ?? 'default'}" for tenant "${userId}". Host fallback prohibited.`,
        spaceId ?? 'default',
        userId
      );
    }

    // 6. Execute binary with ephemeral config; handle.dispose() is guaranteed in finally
    try {
      const binary = contrib.command || 'feishu-cli';
      const fixedArgs = contrib.fixedArgs ?? [];
      const fullArgv = ['--config', configHandle.configPath, ...fixedArgs, ...modelArgs];
      const cwd = effectiveSpacePath;

      const scrubbedEnv = buildScrubbedEnv();
      delete scrubbedEnv['FEISHU_APP_ID'];
      delete scrubbedEnv['FEISHU_APP_SECRET'];
      delete scrubbedEnv['FEISHU_USER_ACCESS_TOKEN'];

      return await runProcess({
        ctx,
        command: binary,
        argv: fullArgv,
        cwd,
        env: scrubbedEnv,
        timeoutMs,
        maxOutputBytes,
        execContext,
      });
    } finally {
      try {
        await configHandle.dispose();
      } catch {}
    }
  };
}
