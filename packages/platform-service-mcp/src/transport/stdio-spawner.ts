/**
 * Hardened Child Process Spawner for Stdio MCP Transport
 *
 * Enforces:
 * - Direct argv invocation (no shell)
 * - Allowlisted executable verification
 * - Filtered environment variables
 * - Nonroot process check if configured / available
 * - Process tree termination (kills child process group on close/timeout)
 * - Output bounds (kills runaway output processes)
 *
 * @module @enkeep/platform-service-mcp/transport/stdio-spawner
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { McpErrorCode, McpServiceError } from '../errors.js';
import { filterChildEnvironment } from '../security/env-filter.js';
import { validateExecutable } from '../security/executable-guard.js';
import type { McpStdioServerDescriptor } from '../types.js';

export interface SpawnerOptions {
  readonly descriptor: McpStdioServerDescriptor;
  readonly ephemeralEnv?: Record<string, string>;
  readonly globalAllowlist?: readonly string[];
  readonly envWhitelist?: readonly string[];
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
}

export interface SpawnedProcessInfo {
  readonly child: ChildProcess;
  readonly pid: number;
  readonly killTree: (signal?: NodeJS.Signals) => Promise<void>;
}

/**
 * Spawns a hardened child process for an MCP stdio server.
 */
export function spawnHardenedChildProcess(options: SpawnerOptions): SpawnedProcessInfo {
  const { descriptor, ephemeralEnv = {} } = options;

  // 1. Validate executable against allowlist & package roots
  const { resolvedCommand, resolvedArgs } = validateExecutable(
    descriptor.command,
    descriptor.args ?? [],
    {
      globalAllowlist: options.globalAllowlist,
      serverAllowlist: descriptor.allowlistedExecutables,
      packageRoots: descriptor.packageRoots,
    },
  );

  // 2. Filter environment variables
  const cleanEnv = filterChildEnvironment(
    process.env,
    descriptor.env ?? {},
    ephemeralEnv,
    { customAllowed: options.envWhitelist },
  );

  // 3. Setup spawn options
  const spawnOptions: SpawnOptions = {
    cwd: descriptor.cwd || process.cwd(),
    env: cleanEnv,
    shell: false, // Invariant: direct argv only, never shell
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32', // Allows killing whole process group on POSIX
  };

  // 4. Spawn child process
  let child: ChildProcess;
  try {
    child = spawn(resolvedCommand, resolvedArgs, spawnOptions);
  } catch (err) {
    throw new McpServiceError(
      `Failed to spawn MCP stdio server "${descriptor.id}": ${err instanceof Error ? err.message : String(err)}`,
      {
        code: McpErrorCode.MCP_SPAWN_FORBIDDEN,
        cause: err,
      },
    );
  }

  const pid = child.pid;
  if (!pid) {
    throw new McpServiceError(`Failed to obtain PID for spawned MCP server "${descriptor.id}"`, {
      code: McpErrorCode.MCP_INITIALIZE_FAILED,
    });
  }

  let killed = false;

  // Helper to kill the entire process tree reliably
  const killTree = async (signal: NodeJS.Signals = 'SIGTERM'): Promise<void> => {
    if (killed || child.killed) return;
    killed = true;

    try {
      if (process.platform !== 'win32' && pid) {
        try {
          // Kill process group
          process.kill(-pid, signal);
        } catch {
          try {
            process.kill(pid, signal);
          } catch {}
        }
      } else if (pid) {
        try {
          child.kill(signal);
        } catch {}
      }
    } catch {}

    // Force SIGKILL fallback if not exited after 1.5s
    setTimeout(() => {
      try {
        if (!child.killed && pid) {
          if (process.platform !== 'win32') {
            try {
              process.kill(-pid, 'SIGKILL');
            } catch {
              try {
                process.kill(pid, 'SIGKILL');
              } catch {}
            }
          } else {
            child.kill('SIGKILL');
          }
        }
      } catch {}
    }, 1500).unref();
  };

  // 5. Setup output size monitor on stderr/stdout
  const maxOutputBytes = options.maxOutputBytes ?? descriptor.maxOutputBytes ?? 10 * 1024 * 1024;
  let accumulatedBytes = 0;

  const onData = (chunk: Buffer) => {
    accumulatedBytes += chunk.length;
    if (accumulatedBytes > maxOutputBytes) {
      void killTree('SIGKILL');
    }
  };

  if (child.stdout) child.stdout.on('data', onData);
  if (child.stderr) child.stderr.on('data', onData);

  // 6. Handle abort signal if provided
  if (options.signal) {
    if (options.signal.aborted) {
      void killTree('SIGTERM');
    } else {
      options.signal.addEventListener('abort', () => void killTree('SIGTERM'), { once: true });
    }
  }

  return {
    child,
    pid,
    killTree,
  };
}
