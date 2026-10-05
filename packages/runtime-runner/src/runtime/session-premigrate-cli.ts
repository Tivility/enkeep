#!/usr/bin/env node
/**
 * CLI binary entry for `enkeep-session-premigrate`
 */
import { runSessionPremigrateCli } from './session-premigrate.js';

runSessionPremigrateCli(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
