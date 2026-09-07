#!/usr/bin/env node
/**
 * Direct runtime-daemon entrypoint for container PID 1 execution
 *
 * @module @enkeep/runtime-runner/runtime/runtime-daemon
 */

import { runDaemonCli } from './daemon-cli.js';

runDaemonCli().catch((err: unknown) => {
  process.stderr.write(`Fatal daemon error: ${String(err)}\n`);
  process.exit(1);
});
