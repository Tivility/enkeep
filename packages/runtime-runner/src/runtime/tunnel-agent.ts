#!/usr/bin/env node
/**
 * In-Container Tunnel Agent CLI Entrypoint
 *
 * Invoked inside the zero-network container via:
 * `docker exec -i <container> node /app/runtime-runner/dist/runtime/tunnel-agent.js`
 *
 * Runs the TunnelAgent bound strictly to 127.0.0.1 on the specified or default port (8787).
 * Communicates via process.stdin and process.stdout.
 *
 * @module @enkeep/runtime-runner/runtime/tunnel-agent
 */

import { TunnelAgent } from '../tunnel/agent.js';
import { DEFAULT_TUNNEL_PORT } from '../tunnel/types.js';

function parsePort(): number {
  const envPort = process.env.TUNNEL_PORT ? parseInt(process.env.TUNNEL_PORT, 10) : NaN;
  if (!isNaN(envPort) && envPort > 0 && envPort <= 65535) {
    return envPort;
  }

  const argPort = process.argv[2] ? parseInt(process.argv[2], 10) : NaN;
  if (!isNaN(argPort) && argPort > 0 && argPort <= 65535) {
    return argPort;
  }

  return DEFAULT_TUNNEL_PORT;
}

export async function runTunnelAgentCli(): Promise<void> {
  const port = parsePort();
  const agent = new TunnelAgent(process.stdin, process.stdout, {
    port,
    host: '127.0.0.1',
  });

  const cleanup = async () => {
    try {
      await agent.stop();
    } catch (_err) {}
    process.exit(0);
  };

  process.stdin.on('end', cleanup);
  process.stdin.on('close', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  try {
    await agent.start();
  } catch (err: unknown) {
    // Fail closed on startup failure
    process.exit(1);
  }
}

// Direct invocation guard
if (
  process.argv[1] &&
  (process.argv[1].endsWith('tunnel-agent.js') || process.argv[1].endsWith('tunnel-agent.ts'))
) {
  runTunnelAgentCli().catch(() => {
    process.exit(1);
  });
}
