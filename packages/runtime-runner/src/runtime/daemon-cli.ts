#!/usr/bin/env node
/**
 * In-Container Production Runtime Runner Daemon CLI
 *
 * Runs as container PID 1:
 * `node /app/runtime-runner/dist/runtime/daemon-cli.js daemon`
 *
 * Communicates via framed JSON RPC over process.stdin and process.stdout.
 * Listens for SIGTERM / SIGINT and coordinates graceful shutdown.
 * Also provides one-shot CLI commands: `health` and `idle`.
 *
 * Security & Framing Protections:
 * - Redirects console.log / console.info / console.debug to process.stderr so that
 *   DSH core/plugin output never contaminates the NDJSON stdout frame channel.
 * - Backpressure handling on process.stdout.
 * - Non-zero exit codes on fatal startup errors.
 *
 * @module @enkeep/runtime-runner/runtime/daemon-cli
 */

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { RuntimeDaemon } from './daemon.js';
import {
  DaemonRpcDecoder,
  DaemonRpcEncoder,
  DEFAULT_DAEMON_SOCKET_PATH,
  encodeDaemonMessage,
  type DaemonRequest,
  type DaemonStreamEvent,
} from './daemon-protocol.js';
import { isValidUserId, isNormalizedAbsolutePath } from './dsh-boot.js';
import type { ResolvedRuntimeMount } from '../spec/types.js';

/**
 * Redirects standard console methods to stderr so that library logging
 * does not corrupt stdout NDJSON RPC framing.
 */
export function redirectConsoleToStderr(): () => void {
  const origLog = console.log;
  const origInfo = console.info;
  const origDebug = console.debug;
  const origTrace = console.trace;

  console.log = (...args: any[]) => {
    process.stderr.write(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n');
  };
  console.info = (...args: any[]) => {
    process.stderr.write(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n');
  };
  console.debug = (...args: any[]) => {
    process.stderr.write(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n');
  };
  console.trace = (...args: any[]) => {
    process.stderr.write(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n');
  };

  return () => {
    console.log = origLog;
    console.info = origInfo;
    console.debug = origDebug;
    console.trace = origTrace;
  };
}

export function resolveDaemonBootConfig(): {
  userId: string;
  dshHome: string;
  spacesDir: string;
  maxAgents?: number;
  idleAgentTimeoutMs?: number;
  maxConcurrentSessions?: number;
  llmEnabled?: boolean;
  mounts?: ResolvedRuntimeMount[];
} {
  const userId = process.env.DSH_USER || process.env.ENKEEP_USER_ID || 'alice';
  if (!isValidUserId(userId)) {
    throw new TypeError(`Invalid DSH_USER environment variable: "${userId}"`);
  }

  const dshHome = process.env.DSH_HOME || '/home/dsh/.dsh';
  if (!isNormalizedAbsolutePath(dshHome)) {
    throw new TypeError(`Invalid DSH_HOME environment variable: "${dshHome}"`);
  }

  const spacesDir = process.env.DSH_SPACES || '/home/dsh/spaces';
  if (!isNormalizedAbsolutePath(spacesDir)) {
    throw new TypeError(`Invalid DSH_SPACES environment variable: "${spacesDir}"`);
  }

  const maxAgents = process.env.DSH_MAX_AGENTS ? parseInt(process.env.DSH_MAX_AGENTS, 10) : undefined;
  const idleAgentTimeoutMs = process.env.DSH_IDLE_AGENT_TIMEOUT_MS
    ? parseInt(process.env.DSH_IDLE_AGENT_TIMEOUT_MS, 10)
    : 1_800_000; // 30 minutes default
  const maxConcurrentSessions = process.env.DSH_MAX_CONCURRENT_SESSIONS
    ? parseInt(process.env.DSH_MAX_CONCURRENT_SESSIONS, 10)
    : undefined;
  const llmEnabled = process.env.ENKEEP_LLM_ENABLED === '1';

  let mounts: ResolvedRuntimeMount[] | undefined;
  if (process.env.DSH_MOUNTS_JSON) {
    try {
      const parsed = JSON.parse(process.env.DSH_MOUNTS_JSON);
      if (Array.isArray(parsed)) {
        mounts = parsed.map((m: any) => ({
          id: String(m.id || ''),
          name: String(m.name || ''),
          sourcePath: String(m.sourcePath || m.targetPath || ''),
          targetPath: String(m.targetPath || m.sourcePath || ''),
          mode: (m.mode === 'rw' ? 'rw' : 'ro') as 'ro' | 'rw',
        }));
      }
    } catch {}
  }

  return {
    userId,
    dshHome,
    spacesDir,
    maxAgents,
    idleAgentTimeoutMs,
    maxConcurrentSessions,
    llmEnabled,
    mounts,
  };
}

export async function runDaemonServer(): Promise<void> {
  // Isolate stdout for NDJSON only: redirect console logs to stderr
  redirectConsoleToStderr();

  const config = resolveDaemonBootConfig();
  const daemon = new RuntimeDaemon(config);

  await daemon.start();

  const socketPath = process.env.DSH_DAEMON_SOCKET_PATH || DEFAULT_DAEMON_SOCKET_PATH;
  const socketDir = path.dirname(socketPath);
  try {
    if (!fs.existsSync(socketDir)) {
      fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
    }
  } catch {}

  // Ensure stale socket file is removed before listening
  try {
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
  } catch {}

  const activeSockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    activeSockets.add(socket);

    const decoder = new DaemonRpcDecoder();
    const encoder = new DaemonRpcEncoder();

    const streamListener = (event: DaemonStreamEvent) => {
      try {
        encoder.write(event);
      } catch {}
    };

    daemon.on('stream', streamListener);

    decoder.on('data', async (request: DaemonRequest) => {
      try {
        const response = await daemon.handleRequest(request);
        encoder.write(response);
      } catch (err: unknown) {
        encoder.write({
          id: request.id ?? 'unknown',
          op: request.op ?? 'unknown',
          ok: false,
          error: {
            code: 'INTERNAL_ERROR',
            message: (err as any)?.message || 'Daemon request handling failed',
          },
        });
      }
    });

    encoder.pipe(socket);
    socket.pipe(decoder);

    const cleanup = () => {
      activeSockets.delete(socket);
      daemon.removeListener('stream', streamListener);
      try {
        socket.destroy();
      } catch {}
    };

    socket.on('end', cleanup);
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });

  server.listen(socketPath, () => {
    try {
      fs.chmodSync(socketPath, 0o600);
    } catch {}
    process.stderr.write(`[RuntimeDaemon] Unix domain socket listening at ${socketPath} (mode 0600)\n`);
  });

  server.on('error', (err) => {
    process.stderr.write(`[RuntimeDaemon] Server socket error: ${String(err)}\n`);
  });

  // Stdio fallback / direct pipe support
  const stdioDecoder = new DaemonRpcDecoder();
  const stdioEncoder = new DaemonRpcEncoder();

  const stdioStreamListener = (event: DaemonStreamEvent) => {
    try {
      stdioEncoder.write(event);
    } catch {}
  };
  daemon.on('stream', stdioStreamListener);

  stdioDecoder.on('data', async (request: DaemonRequest) => {
    try {
      const response = await daemon.handleRequest(request);
      stdioEncoder.write(response);
    } catch (err: unknown) {
      stdioEncoder.write({
        id: request.id ?? 'unknown',
        op: request.op ?? 'unknown',
        ok: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: (err as any)?.message || 'Daemon request handling failed',
        },
      });
    }
  });

  stdioEncoder.pipe(process.stdout);
  process.stdin.pipe(stdioDecoder);

  let shuttingDown = false;
  const onSignal = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      server.close();
      for (const s of activeSockets) {
        try {
          s.destroy();
        } catch {}
      }
      try {
        if (fs.existsSync(socketPath)) {
          fs.unlinkSync(socketPath);
        }
      } catch {}
      await daemon.shutdown(5000);
    } catch {}
    process.exit(0);
  };

  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));

  process.stdin.on('end', () => {
    // If running in pure stdio mode (e.g. non-daemon child), shut down when stdin closes
    if (activeSockets.size === 0 && process.env.DSH_DAEMON_STDIO_ONLY === '1') {
      if (shuttingDown) return;
      shuttingDown = true;
      daemon.shutdown(2000).then(() => {
        process.exit(0);
      }).catch(() => {
        process.exit(0);
      });
    }
  });
}

export const runDaemonStdioServer = runDaemonServer;

export async function runDaemonCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const command = argv[0] || 'daemon';

  if (command === 'daemon') {
    await runDaemonStdioServer();
    return;
  }

  if (command === 'health') {
    const config = resolveDaemonBootConfig();
    const daemon = new RuntimeDaemon(config);
    await daemon.start();
    const res = await daemon.handleRequest({
      id: 'cli-health',
      op: 'health',
    });
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    await daemon.shutdown(1000);
    process.exit(res.ok ? 0 : 1);
  }

  process.stderr.write(`Unknown command "${command}". Available commands: daemon, health\n`);
  process.exit(1);
}

if (
  process.argv[1] &&
  (process.argv[1].endsWith('daemon-cli.js') ||
    process.argv[1].endsWith('daemon-cli.ts') ||
    process.argv[1].endsWith('runtime-daemon.js') ||
    process.argv[1].endsWith('runtime-daemon.ts') ||
    process.argv[1].endsWith('daemon.js') ||
    process.argv[1].endsWith('daemon.ts'))
) {
  runDaemonCli().catch((err: unknown) => {
    process.stderr.write(`Fatal daemon error: ${String(err)}\n`);
    process.exit(1);
  });
}
