/**
 * Tool Execution Bridge for CLI Tools
 *
 * Spawns deterministic Node CLI contributions inside runtime boundary (Space workspace)
 * using `process.execPath` and `ctx.subprocess` with strict parameter bounding,
 * human approval enforcement, and output limits.
 *
 * @module @enkeep/dsh-tool-cli/executor
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import type { Context } from '@deepseek-ai/cordis';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { ExtensionCliContributionActivation, CliToolCallInput, CliToolCallOutput } from './types.js';
import { CliToolError } from './errors.js';
import { enforceCliApproval } from './approvals.js';
import { resolveCallerScope } from './scope.js';

export interface CreateCliExecutorOptions {
  readonly contrib: ExtensionCliContributionActivation;
  readonly toolName: string;
  readonly spacePath?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
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

export function createCliToolExecutor(
  ctx: Context,
  options: CreateCliExecutorOptions
): (input: unknown, execContext?: ToolRunContext) => Promise<CliToolCallOutput> {
  const { contrib, toolName, spacePath } = options;
  const rawTimeout = contrib.timeoutMs ?? options.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
  const timeoutMs = Math.min(Math.max(1000, rawTimeout), MAX_CLI_TIMEOUT_MS);
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_CLI_MAX_OUTPUT_BYTES;

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

    // 3. Resolve script path strictly inside space boundary
    const effectiveSpacePath = path.resolve(spacePath ?? process.cwd());
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

    // 4. Assemble argv: [resolvedScript, ...fixedArgs, ...modelArgs]
    const fixedArgs = contrib.fixedArgs ?? [];
    const fullArgv = [resolvedScript, ...fixedArgs, ...modelArgs];
    const cwd = path.dirname(resolvedScript);
    const scrubbedEnv = buildScrubbedEnv();

    // 5. Execute via ctx.subprocess (if available) or fallback
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
          argv: [process.execPath, ...fullArgv],
          cwd,
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: maxOutputBytes },
            stderr: { maxBytes: maxOutputBytes },
          },
          graceMs: 2000,
          signal: ac.signal,
          env: scrubbedEnv,
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

      const cp = nodeSpawn(process.execPath, fullArgv, {
        cwd,
        env: scrubbedEnv,
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
  };
}
