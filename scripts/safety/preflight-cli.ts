#!/usr/bin/env node
/**
 * CLI runner for Enkeep Preflight Safety Checks
 * Usage: pnpm preflight
 */

import { runPreflightChecks } from './preflight.js';

function main() {
  console.log('====================================================');
  console.log('   Enkeep Phase 0 - Preflight Safety Verification   ');
  console.log('====================================================');

  const report = runPreflightChecks();

  for (const check of report.checks) {
    const icon = check.passed ? '✓' : '✗';
    console.log(`[${icon}] ${check.name}: ${check.message}`);
  }

  console.log('----------------------------------------------------');
  if (report.ok) {
    console.log('✓ All preflight safety checks passed successfully!');
    console.log('====================================================');
    process.exit(0);
  } else {
    console.error('✗ Preflight safety checks FAILED with the following errors:');
    for (const err of report.errors) {
      console.error(`  - ${err}`);
    }
    console.log('====================================================');
    process.exit(1);
  }
}

main();
