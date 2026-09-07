#!/usr/bin/env node
/**
 * In-Container Daemon Bridge CLI Entrypoint
 *
 * Invoked inside the zero-network container via:
 * `docker exec -i <container> node /app/runtime-runner/dist/runtime/daemon-bridge.js`
 *
 * Connects to the local Unix domain socket opened by PID 1 daemon (`/tmp/enkeep-runtime.sock`)
 * and forwards framed JSON-RPC bidirectionally between process.stdin / process.stdout and the socket.
 *
 * Invariants:
 * - Redirects console.log to stderr to maintain pristine stdio NDJSON framing.
 * - Retries connection with backoff during startup if daemon socket is initializing.
 * - Handles backpressure on stdio and socket pipes.
 * - Cleanly closes on stdin EOF, SIGTERM, SIGINT, or socket close.
 * - Fails closed on unrecoverable errors.
 *
 * @module @enkeep/runtime-runner/runtime/daemon-bridge
 */

import net from 'node:net';
import fs from 'node:fs';
import { DEFAULT_DAEMON_SOCKET_PATH } from './daemon-protocol.js';
import { redirectConsoleToStderr } from './daemon-cli.js';

export async function connectWithRetry(socketPath: string, maxAttempts = 20, intervalMs = 100): Promise<net.Socket> {
  let attempts = 0;
  while (attempts < maxAttempts) {
    attempts++;
    try {
      if (fs.existsSync(socketPath)) {
        const socket = net.connect(socketPath);
        await new Promise<void>((resolve, reject) => {
          socket.once('connect', () => {
            socket.removeAllListeners('error');
            resolve();
          });
          socket.once('error', (err) => {
            socket.destroy();
            reject(err);
          });
        });
        return socket;
      }
    } catch (_err) {
      // Retry on transient connect error
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Failed to connect to daemon socket at "${socketPath}" after ${maxAttempts} attempts`);
}

export async function runDaemonBridgeCli(): Promise<void> {
  redirectConsoleToStderr();

  const socketPath = process.env.DSH_DAEMON_SOCKET_PATH || process.argv[2] || DEFAULT_DAEMON_SOCKET_PATH;

  let socket: net.Socket;
  try {
    socket = await connectWithRetry(socketPath);
  } catch (err: unknown) {
    process.stderr.write(`[DaemonBridge] Fatal: ${String(err)}\n`);
    process.exit(1);
  }

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    try {
      socket.destroy();
    } catch {}
    process.exit(0);
  };

  // Bidirectional forwarding
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);

  socket.on('end', cleanup);
  socket.on('close', cleanup);
  socket.on('error', (err) => {
    process.stderr.write(`[DaemonBridge] Socket error: ${String(err)}\n`);
    cleanup();
  });

  process.stdin.on('end', cleanup);
  process.stdin.on('close', cleanup);
  process.stdin.on('error', (err) => {
    process.stderr.write(`[DaemonBridge] Stdin error: ${String(err)}\n`);
    cleanup();
  });

  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
}

if (
  process.argv[1] &&
  (process.argv[1].endsWith('daemon-bridge.js') || process.argv[1].endsWith('daemon-bridge.ts'))
) {
  runDaemonBridgeCli().catch((err: unknown) => {
    process.stderr.write(`Fatal bridge error: ${String(err)}\n`);
    process.exit(1);
  });
}
