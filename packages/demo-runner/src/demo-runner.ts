#!/usr/bin/env node
/**
 * Enkeep Demo Runner CLI (`demo:reset`, `demo:up`, `demo:down`, `demo:test`, `demo:status`)
 *
 * Provides command-line interfaces with structured terminal output and machine-readable JSON mode.
 *
 * @module @enkeep/demo-runner/demo-runner
 */

import { resetDemo } from './reset/index.js';
import { launchDemoSystem } from './up/index.js';
import { downDemo } from './down/index.js';
import { runDemoTestSuite } from './test/index.js';
import { runPreflight } from './preflight/index.js';
import { listSignedProcesses, listSignedContainers } from './utils/crypto-meta.js';
import { validateSafePort } from './utils/probes.js';
import {
  parseLarkTestCredentialsPath,
  bindLarkChatContext,
  ensureLarkTestResources,
  loadLarkTestCredentials,
  LARK_TEST_SPACE_FOLDER,
} from './utils/lark-credentials.js';
import { findRepoRoot, getDemoPathConfig, validateResourceSuffix } from './config.js';
import { loadDshDeploymentConfig } from '@enkeep/runtime-runner';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { DatabaseSync } from 'node:sqlite';
import type {
  DemoStatusResult,
  SanitizedProcessMetadata,
  SanitizedContainerMetadata,
  DemoStatusOptions,
  DemoPathOptions,
} from './types.js';

function printHelp(): void {
  console.log(`
Enkeep Demo Runner CLI

USAGE:
  pnpm demo:<command> [options]
  node dist/demo-runner.js <command> [options]

COMMANDS:
  reset      Clean and re-initialize .demo-data, run migrations, provision users with fresh high-entropy credentials
  up         Start Platform HTTP server on dynamic 127.0.0.1:0 and launch Alice/Bob Docker runtimes in foreground
  down       Safely terminate demo processes and containers verified by signed metadata
  test       Run full automated verification suite and teardown with port 3000/3080 probes
  status     Show current status of demo services, processes, and containers
  preflight  Verify platform and all host/container runtimes quiescence before deploy or stop
  bind-lark  Explicitly bind a Lark chatId to the dedicated test space
  help       Display this help message

OPTIONS:
  --port <number>             Fixed loopback Platform port for up (default dynamic)
  --data-dir <path>           Explicit platform data root (or env ENKEEP_DATA_DIR)
  --due-within-minutes <N>    Lookahead window in minutes for due scheduled tasks (default: 10)
  --network-mode <mode>       Container network mode: "none" (default) or "bridge"
  --resource-suffix <suffix>  Resource suffix for Docker containers and volumes (or env ENKEEP_RESOURCE_SUFFIX)
  --dsh-home <dir>            Explicit DSH home directory (or env ENKEEP_DSH_HOME, DSH_HOME)
  --lark-test-credentials <f> Path to Lark test credentials file (0600 mode)
  --json                      Output results as JSON (errors omit stack trace)
  --remove-vols               Remove demo Docker volumes on teardown
  --repo-root                 Explicit repository root path (default: auto-detected)
  --help, -h                  Show help
`);
}

/**
 * Parses and validates the platform port from CLI arguments or environment variables.
 * Priority: CLI `--port <number>` > env `ENKEEP_PLATFORM_PORT` > default 0 (dynamic loopback).
 */
export function parsePlatformPort(
  args: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): number {
  let rawPort: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--port') {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('-')) {
        throw new Error('Safety Violation: --port requires a valid port number.');
      }
      rawPort = next;
      break;
    } else if (arg.startsWith('--port=')) {
      const val = arg.slice('--port='.length);
      if (!val) {
        throw new Error('Safety Violation: --port requires a valid port number.');
      }
      rawPort = val;
      break;
    }
  }

  if (rawPort === undefined && env.ENKEEP_PLATFORM_PORT !== undefined && env.ENKEEP_PLATFORM_PORT !== '') {
    rawPort = env.ENKEEP_PLATFORM_PORT;
  }

  if (rawPort === undefined) {
    return 0;
  }

  const trimmed = rawPort.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Safety Violation: Invalid port "${rawPort}". Must be an integer.`);
  }

  const port = Number.parseInt(trimmed, 10);
  validateSafePort(port);
  return port;
}

/**
 * Parses and validates the DSH home directory from CLI arguments or environment variables.
 * Priority: CLI `--dsh-home <path>` > env `ENKEEP_DSH_HOME` > env `DSH_HOME` > undefined.
 */
export function parseDshHome(
  args: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  let rawHome: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dsh-home') {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('-')) {
        throw new Error('Safety Violation: --dsh-home requires a valid directory path.');
      }
      rawHome = next;
      break;
    } else if (arg.startsWith('--dsh-home=')) {
      const val = arg.slice('--dsh-home='.length);
      if (!val) {
        throw new Error('Safety Violation: --dsh-home requires a valid directory path.');
      }
      rawHome = val;
      break;
    }
  }

  if (rawHome === undefined && env.ENKEEP_DSH_HOME !== undefined && env.ENKEEP_DSH_HOME !== '') {
    rawHome = env.ENKEEP_DSH_HOME;
  } else if (rawHome === undefined && env.DSH_HOME !== undefined && env.DSH_HOME !== '') {
    rawHome = env.DSH_HOME;
  }

  return rawHome;
}

/**
 * Parses and validates container network mode from CLI arguments, environment variables, or DSH settings.
 * Whitelist supported: 'none' | 'bridge'. Defaults to 'none' for backwards compatibility.
 * Priority: CLI `--network-mode <mode>` / `--network <mode>` > env `ENKEEP_CONTAINER_NETWORK_MODE` > env `DSH_CONTAINER_NETWORK_MODE` > settings `container-network-mode` > default 'none'.
 * Rejects null, undefined, unknown, or unsupported modes fail-closed.
 */
export function parseContainerNetworkMode(
  args: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  dshConfig: import('@enkeep/runtime-runner').DshDeploymentConfig | null = loadDshDeploymentConfig(parseDshHome(args, env))
): import('@enkeep/runtime-runner').RuntimeNetworkMode {
  let rawMode: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--network-mode' || arg === '--network') {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('-')) {
        throw new Error(`Safety Violation: ${arg} requires a valid network mode ("none" or "bridge").`);
      }
      rawMode = next;
      break;
    } else if (arg.startsWith('--network-mode=')) {
      const val = arg.slice('--network-mode='.length);
      if (!val) {
        throw new Error('Safety Violation: --network-mode requires a valid network mode ("none" or "bridge").');
      }
      rawMode = val;
      break;
    } else if (arg.startsWith('--network=')) {
      const val = arg.slice('--network='.length);
      if (!val) {
        throw new Error('Safety Violation: --network requires a valid network mode ("none" or "bridge").');
      }
      rawMode = val;
      break;
    }
  }

  if (rawMode === undefined && env.ENKEEP_CONTAINER_NETWORK_MODE !== undefined && env.ENKEEP_CONTAINER_NETWORK_MODE !== '') {
    rawMode = env.ENKEEP_CONTAINER_NETWORK_MODE;
  } else if (rawMode === undefined && env.DSH_CONTAINER_NETWORK_MODE !== undefined && env.DSH_CONTAINER_NETWORK_MODE !== '') {
    rawMode = env.DSH_CONTAINER_NETWORK_MODE;
  } else if (rawMode === undefined && dshConfig?.containerNetworkMode !== undefined) {
    rawMode = dshConfig.containerNetworkMode;
  }

  if (rawMode === undefined) {
    return 'none';
  }

  const trimmed = rawMode.trim().toLowerCase();
  if (trimmed !== 'none' && trimmed !== 'bridge') {
    throw new Error(`Safety Violation: Invalid container network mode "${rawMode}". Must be "none" or "bridge".`);
  }

  return trimmed as import('@enkeep/runtime-runner').RuntimeNetworkMode;
}

/**
 * Parses and validates resource suffix from CLI arguments or environment variables.
 * Priority: CLI `--resource-suffix <suffix>` > env `ENKEEP_RESOURCE_SUFFIX` > undefined.
 * Validated by existing `validateResourceSuffix`.
 */
export function parseResourceSuffix(
  args: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  let rawSuffix: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--resource-suffix') {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('-')) {
        throw new Error('Safety Violation: --resource-suffix requires a valid suffix string.');
      }
      rawSuffix = next;
      break;
    } else if (arg.startsWith('--resource-suffix=')) {
      const val = arg.slice('--resource-suffix='.length);
      if (!val) {
        throw new Error('Safety Violation: --resource-suffix requires a valid suffix string.');
      }
      rawSuffix = val;
      break;
    }
  }

  if (rawSuffix === undefined && env.ENKEEP_RESOURCE_SUFFIX !== undefined && env.ENKEEP_RESOURCE_SUFFIX !== '') {
    rawSuffix = env.ENKEEP_RESOURCE_SUFFIX;
  }

  if (rawSuffix === undefined) {
    return undefined;
  }

  const trimmed = rawSuffix.trim();
  if (trimmed === '') {
    throw new Error('Safety Violation: --resource-suffix cannot be empty.');
  }

  validateResourceSuffix(trimmed);
  return trimmed;
}

/**
 * Parses explicit data directory from CLI arguments or environment variables.
 * Priority: CLI `--data-dir <path>` > env `ENKEEP_DATA_DIR` > undefined.
 */
export function parseDataDir(
  args: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  let rawDir: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--data-dir') {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('-')) {
        throw new Error('Safety Violation: --data-dir requires a valid directory path.');
      }
      rawDir = next;
      break;
    } else if (arg.startsWith('--data-dir=')) {
      const val = arg.slice('--data-dir='.length);
      if (!val) {
        throw new Error('Safety Violation: --data-dir requires a valid directory path.');
      }
      rawDir = val;
      break;
    }
  }

  if (rawDir === undefined && env.ENKEEP_DATA_DIR !== undefined && env.ENKEEP_DATA_DIR !== '') {
    rawDir = env.ENKEEP_DATA_DIR;
  }

  return rawDir;
}

/**
 * Parses due-within-minutes lookahead window from CLI arguments or environment variables.
 * Priority: CLI `--due-within-minutes <number>` > env `ENKEEP_PREFLIGHT_DUE_MINUTES` > default 10.
 */
export function parseDueWithinMinutes(
  args: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): number {
  let rawVal: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--due-within-minutes' || arg === '--due-within') {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('-')) {
        throw new Error(`Safety Violation: ${arg} requires a valid number of minutes.`);
      }
      rawVal = next;
      break;
    } else if (arg.startsWith('--due-within-minutes=')) {
      rawVal = arg.slice('--due-within-minutes='.length);
      break;
    } else if (arg.startsWith('--due-within=')) {
      rawVal = arg.slice('--due-within='.length);
      break;
    }
  }

  if (rawVal === undefined && env.ENKEEP_PREFLIGHT_DUE_MINUTES !== undefined && env.ENKEEP_PREFLIGHT_DUE_MINUTES !== '') {
    rawVal = env.ENKEEP_PREFLIGHT_DUE_MINUTES;
  }

  if (rawVal === undefined) {
    return 10;
  }

  const trimmed = rawVal.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Safety Violation: Invalid minutes value "${rawVal}". Must be an integer.`);
  }

  return Number.parseInt(trimmed, 10);
}

export async function getStatus(options?: DemoStatusOptions | string): Promise<DemoStatusResult> {
  const pathOptions: DemoPathOptions = typeof options === 'string' ? { repoRoot: options } : (options ?? {});
  const processes = listSignedProcesses(pathOptions);
  const containers = listSignedContainers(pathOptions);

  const platformProc = processes.find((p) => p.service === 'platform-server');
  const ports = processes.map((p) => p.port).filter((p): p is number => typeof p === 'number');

  const sanitizedProcesses: SanitizedProcessMetadata[] = processes.map((p) => ({
    service: p.service,
    pid: p.pid,
    port: p.port,
    url: p.url,
    startedAt: p.startedAt,
    owner: p.owner,
    runId: p.runId,
    command: p.command,
  }));

  const sanitizedContainers: SanitizedContainerMetadata[] = containers.map((c) => ({
    userId: c.userId,
    containerName: c.containerName,
    containerId: c.containerId,
    image: c.image,
    volumeName: c.volumeName,
    volumeId: c.volumeId,
    labels: c.labels,
    startedAt: c.startedAt,
    owner: c.owner,
    runId: c.runId,
    status: c.status,
  }));

  return {
    ok: true,
    timestamp: new Date().toISOString(),
    platformRunning: !!platformProc,
    platformEndpoint: platformProc?.url,
    processes: sanitizedProcesses,
    containers: sanitizedContainers,
    activePortBindings: ports,
  };
}

export async function runDemoRunnerCli(args: string[] = process.argv.slice(2)): Promise<void> {
  const command = args[0] || 'help';
  const isJson = args.includes('--json');
  const removeVolumes = args.includes('--remove-vols');
  const allowHostRuntime =
    args.includes('--allow-host') ||
    process.env.ENKEEP_ALLOW_HOST_RUNTIME === '1' ||
    process.env.ENKEEP_ALLOW_HOST_RUNTIME === 'true';

  let repoRoot: string | undefined;
  const repoIdx = args.indexOf('--repo-root');
  if (repoIdx !== -1 && args[repoIdx + 1]) {
    repoRoot = args[repoIdx + 1];
  }

  if (command === 'help' || args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  try {
    switch (command) {
      case 'reset': {
        const result = await resetDemo({ repoRoot });
        if (isJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log('\n✔ Enkeep Demo Environment Reset Complete');
          console.log(`  Data Directory: ${result.demoDataDir}`);
          console.log(`  Database:       ${result.dbPath}`);
          console.log(`  Users:          Admin=${result.users.admin.username}, User=${result.users.user.username}, Disabled=${result.users.disabledUser.username}`);
          console.log(`  Generated Credentials (Ephemerally provisioned):`);
          console.log(`    Alice (Admin):  username=${result.credentials.admin.username}  password=${result.credentials.admin.password}`);
          console.log(`    Bob (User):     username=${result.credentials.user.username}  password=${result.credentials.user.password}`);
          console.log(`    Charlie (Dis):  username=${result.credentials.disabledUser.username}  password=${result.credentials.disabledUser.password}`);
          console.log(`  Imported:       ${result.importedChatsCount} chats, ${result.importedMessagesCount} messages\n`);
        }
        break;
      }

      case 'up': {
        const platformPort = parsePlatformPort(args);
        const larkTestCredentialsFile = parseLarkTestCredentialsPath(args);
        const containerNetworkMode = parseContainerNetworkMode(args);
        const resourceSuffix = parseResourceSuffix(args);
        const dshHome = parseDshHome(args);
        const system = await launchDemoSystem({
          repoRoot,
          allowHostRuntime,
          platformPort,
          larkTestCredentialsFile,
          containerNetworkMode,
          resourceSuffix,
          dshHome,
        });
        const dshConfig = loadDshDeploymentConfig(dshHome);
        const isLlmConfigured = Boolean(
          dshConfig &&
          dshConfig.providers &&
          Object.keys(dshConfig.providers).length > 0 &&
          dshConfig.tokens &&
          Object.values(dshConfig.tokens).some((t) => t && t.trim().length > 0)
        );

        if (isJson) {
          console.log(JSON.stringify(system.result, null, 2));
        } else {
          console.log('\n🚀 Enkeep Demo Environment Running');
          console.log(`  Platform Server: ${system.result.platform.endpoint}`);
          if (system.result.users && system.result.users.length > 0) {
            for (const u of system.result.users) {
              const rt = system.result.runtimes[u.username];
              const label = `${u.username.charAt(0).toUpperCase() + u.username.slice(1)} Runtime:`;
              const containerIdStr = rt?.containerId ? ` (${rt.containerId.slice(0, 12)})` : '';
              console.log(`  ${label.padEnd(17)} ${rt?.endpoint ?? 'n/a'}${containerIdStr}`);
            }
          } else {
            for (const [name, rt] of Object.entries(system.result.runtimes)) {
              if (!rt) continue;
              const label = `${name.charAt(0).toUpperCase() + name.slice(1)} Runtime:`;
              const containerIdStr = rt.containerId ? ` (${rt.containerId.slice(0, 12)})` : '';
              console.log(`  ${label.padEnd(17)} ${rt.endpoint}${containerIdStr}`);
            }
          }
          if (isLlmConfigured && dshConfig) {
            const providerNames = Object.keys(dshConfig.providers);
            const modelNames = Object.entries(dshConfig.providers).flatMap(([pkey, p]) =>
              (p.models || []).map((m) => `${pkey}/${m.id}`)
            );
            console.log(`  Model Providers: ${providerNames.join(', ')}`);
            console.log(`  Default Model:   ${dshConfig.defaultModel.provider}/${dshConfig.defaultModel.model}`);
            console.log(`  Available Models (${modelNames.length}): ${modelNames.slice(0, 8).join(', ')}${modelNames.length > 8 ? ` ... (+${modelNames.length - 8} more)` : ''}`);
          } else {
            console.log(`  Model Provider:  demo (Zero-Key Demo Model, DSH deployment config not found)`);
          }
          console.log(`  Processes:       ${system.result.metadata.processes.length} registered`);
          console.log(`  Containers:      ${system.result.metadata.containers.length} registered`);
          console.log('\n  Press Ctrl+C to stop...\n');
        }

        // Stay foreground awaiting SIGINT/SIGTERM
        await new Promise<void>((resolve, reject) => {
          let shuttingDown = false;
          const onSignal = async (sig: NodeJS.Signals) => {
            if (shuttingDown) {
              process.exitCode = 1;
              return;
            }
            shuttingDown = true;
            if (!isJson) {
              console.log(`\nReceived ${sig}, gracefully stopping demo system...`);
            }
            try {
              await system.close({ removeVolumes: false });
              resolve();
            } catch (err) {
              reject(err);
            } finally {
              process.off('SIGINT', onSignal);
              process.off('SIGTERM', onSignal);
            }
          };

          process.on('SIGINT', onSignal);
          process.on('SIGTERM', onSignal);
        });
        break;
      }

      case 'down': {
        const result = await downDemo({ repoRoot, removeVolumes });
        if (isJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log('\n🛑 Enkeep Demo Environment Teardown Complete');
          console.log(`  Terminated Processes:  ${result.terminatedProcesses.length}`);
          console.log(`  Terminated Containers: ${result.terminatedContainers.length}`);
          console.log(`  Removed Volumes:       ${result.removedVolumes.length}`);
          console.log(`  Cleaned Metadata:      ${result.cleanedMetadataCount}\n`);
        }
        if (!result.ok) process.exit(1);
        break;
      }

      case 'test': {
        const result = await runDemoTestSuite({ repoRoot });
        if (isJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`\n📋 Enkeep Demo Test Suite: ${result.ok ? 'PASSED ✔' : 'FAILED ✖'}`);
          console.log(`  Total Duration:   ${result.totalDurationMs}ms`);
          console.log(`  Steps Passed:     ${result.summary.passed}/${result.summary.total}`);
          console.log(`  Port 3000 PID:    ${result.probeBefore.port3000.listenerPid ?? 'none'} -> ${result.probeAfter.port3000.listenerPid ?? 'none'} (Unchanged: ${result.probesUnchanged})`);
          console.log(`  Port 3080 PID:    ${result.probeBefore.port3080.listenerPid ?? 'none'} -> ${result.probeAfter.port3080.listenerPid ?? 'none'} (Unchanged: ${result.probesUnchanged})`);
          console.log('\n  Step Breakdown:');
          for (const step of result.steps) {
            const icon = step.passed ? '✔' : '✖';
            console.log(`    [${icon}] ${step.name} (${step.durationMs}ms)`);
            if (step.error) console.log(`        Error: ${step.error}`);
          }
          console.log('');
        }
        if (!result.ok) process.exit(1);
        break;
      }

      case 'status': {
        const result = await getStatus(repoRoot);
        if (isJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log('\n📊 Enkeep Demo Status:');
          console.log(`  Platform:   ${result.platformRunning ? `Running (${result.platformEndpoint})` : 'Stopped'}`);
          console.log(`  Processes:  ${result.processes.length} active`);
          console.log(`  Containers: ${result.containers.length} active`);
          console.log(`  Ports:      ${result.activePortBindings.join(', ') || 'none'}\n`);
        }
        break;
      }

      case 'preflight': {
        const platformPort = parsePlatformPort(args);
        const dataDir = parseDataDir(args, process.env);
        const dueWithinMinutes = parseDueWithinMinutes(args, process.env);
        const result = await runPreflight({
          dataDir,
          repoRoot,
          port: platformPort,
          dueWithinMinutes,
        });

        if (isJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(result.summary);
        }

        if (!result.isIdle) {
          process.exit(1);
        }
        break;
      }

      case 'bind-lark': {
        let chatId: string | undefined;
        const chatIdx = args.indexOf('--chat-id');
        if (chatIdx !== -1 && args[chatIdx + 1]) {
          chatId = args[chatIdx + 1];
        }
        if (!chatId) {
          throw new Error('Safety Violation: --chat-id <chatId> is required for bind-lark.');
        }
        let mode: 'always' | 'mention' = 'always';
        const modeIdx = args.indexOf('--mode');
        if (modeIdx !== -1 && (args[modeIdx + 1] === 'always' || args[modeIdx + 1] === 'mention')) {
          mode = args[modeIdx + 1] as 'always' | 'mention';
        }

        const paths = getDemoPathConfig({ repoRoot });
        const db = new DatabaseSync(paths.dbPath);
        const storage = new SqlitePlatformStorage(db);
        const alice = await storage.users.findByUsername('alice');
        if (!alice) {
          throw new Error('Authoritative alice user not found in database.');
        }

        await ensureLarkTestResources(storage, alice.id, paths.spacesDir);
        const binding = await bindLarkChatContext(storage, alice.id, chatId, {
          activationMode: mode,
        });

        if (isJson) {
          console.log(JSON.stringify({ ok: true, binding }, null, 2));
        } else {
          console.log(`\n✔ Successfully bound Lark chat "${chatId}" to space "${LARK_TEST_SPACE_FOLDER}" (mode: ${mode}, bindingId: ${binding.id})\n`);
        }
        break;
      }

      default:
        console.error(`Unknown command: "${command}". Run "demo:help" or "--help" for usage.`);
        process.exit(1);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isJson) {
      console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
    } else {
      console.error(`\n✖ Error during demo:${command}: ${msg}\n`);
    }
    process.exit(1);
  }
}

if (process.argv[1] && (process.argv[1].endsWith('demo-runner.js') || process.argv[1].endsWith('demo-runner.ts'))) {
  runDemoRunnerCli();
}
