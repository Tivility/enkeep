/**
 * Safe Teardown Implementation (`demo:down`)
 *
 * Enforces:
 * 1. Reads ONLY registered signed metadata from <dataRoot>.
 * 2. Verifies cryptographic HMAC signatures and command tokens.
 * 3. Process safety: verifies live process start time / cmdline against metadata (PID reuse protection),
 *    never touches caller CLI (process.pid), parent PID, PID 1, or protected port owners (3000/3080).
 * 4. Container safety: verifies container name prefix (`enkeep-demo-`), mandatory labels (`app=enkeep-demo`),
 *    mandatory exact 64-hex containerId and runId, inspects live Docker container labels/id before issuing stop/rm.
 * 5. Volume safety: NEVER fallback signed runId to live labels; requires signed volume metadata with exact volumeId;
 *    no broad no-such substring matching.
 * 6. Fail-closed: metadata invalid/tampered/inspect error/ownership mismatch/destructive error => status failed, ok=false, retain all metadata as evidence;
 *    metadata file removed only after every associated verified cleanup succeeds. No sweep/prune.
 *
 * @module @enkeep/demo-runner/down
 */

import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SafeDockerClient } from '@enkeep/runtime-runner/docker';
import { isProcessAlive, killProcessTree, cleanStaleProcess } from '@enkeep/runtime-runner';
import {
  findRepoRoot,
  getDemoPathConfig,
  DEMO_CONTAINER_PREFIX,
  DEMO_VOLUME_PREFIX,
  DEMO_LABEL_KEY,
  DEMO_LABEL_VALUE,
  USER_LABEL_KEY,
  RUN_ID_LABEL_KEY,
  VOLUME_ID_LABEL_KEY,
  validateResourceSuffix,
  isProductionDataDir,
  labelsMatchNamespace,
  PRODUCTION_RESOURCE_NAMESPACE,
  TEST_RESOURCE_NAMESPACE,
} from '../config.js';
import {
  readSignedProcessMeta,
  readSignedContainerMeta,
  removeSignedProcessMeta,
  removeSignedContainerMeta,
  readSignedVolumeMeta,
  removeSignedVolumeMeta,
  CONTAINER_ID_64_REGEX,
  RUN_ID_REGEX,
  VOLUME_ID_REGEX,
} from '../utils/crypto-meta.js';
import {
  safeKillProcess,
  defaultProcessInspector,
  defaultProcessKiller,
} from '../utils/process-guard.js';
import type { DemoDownOptions, DemoDownResult, TerminatedResource, DemoPathOptions } from '../types.js';

const RUNTIME_NETWORK_MODES = ['none', 'bridge'] as const;
type RuntimeNetworkMode = (typeof RUNTIME_NETWORK_MODES)[number];

function isRuntimeNetworkMode(value: string | undefined): value is RuntimeNetworkMode {
  return value !== undefined && (RUNTIME_NETWORK_MODES as readonly string[]).includes(value);
}

/**
 * Human-readable teardown summary. Counts only resources that were actually stopped or removed;
 * failures are counted separately and each one is listed with its reason.
 */
export function formatDownSummary(result: DemoDownResult): string {
  const count = (items: TerminatedResource[], status: TerminatedResource['status']) =>
    items.filter((r) => r.status === status).length;
  const groups: Array<[string, TerminatedResource[]]> = [
    ['Processes', result.terminatedProcesses],
    ['Containers', result.terminatedContainers],
    ['Volumes', result.removedVolumes],
  ];
  const failures = groups.flatMap(([, items]) => items.filter((r) => r.status === 'failed'));
  const lines = [
    result.ok ? '🛑 Enkeep Demo Environment Teardown Complete' : '✖ Enkeep Demo Environment Teardown Failed',
    `  Terminated Processes:  ${count(result.terminatedProcesses, 'terminated')} (already stopped: ${count(result.terminatedProcesses, 'already_stopped')}, failed: ${count(result.terminatedProcesses, 'failed')})`,
    `  Terminated Containers: ${count(result.terminatedContainers, 'terminated')} (already stopped: ${count(result.terminatedContainers, 'already_stopped')}, failed: ${count(result.terminatedContainers, 'failed')})`,
    `  Removed Volumes:       ${count(result.removedVolumes, 'terminated')} (failed: ${count(result.removedVolumes, 'failed')})`,
    `  Cleaned Metadata:      ${result.cleanedMetadataCount}`,
  ];
  if (failures.length > 0) {
    lines.push('  Failures:');
    for (const f of failures) {
      lines.push(`    ✖ ${f.type} ${f.name}${f.id !== undefined ? ` (${f.id})` : ''}: ${f.error ?? 'unknown error'}`);
    }
  }
  return lines.join('\n');
}

export async function downDemo(options: DemoDownOptions = {}): Promise<DemoDownResult> {
  const repoRoot = options.repoRoot ?? findRepoRoot();
  const pathOptions: DemoPathOptions = {
    repoRoot,
    dataRoot: options.dataRoot,
    mode: options.mode,
    resourceSuffix: options.resourceSuffix,
  };
  validateResourceSuffix(options.resourceSuffix);

  const paths = getDemoPathConfig(pathOptions);
  // A production data directory is only ever torn down by enkeep-server (production: true), and then
  // only its own production-named resources; a demo run only ever touches demo-named ones.
  const isProduction = isProductionDataDir(paths.dataRoot);
  if (isProduction && options.production !== true) {
    throw new Error(
      `Safety Violation: "${paths.dataRoot}" is a production data directory. Refusing demo:down; production is stopped through scripts/deploy-release.mjs.`
    );
  }
  if (!isProduction && options.production === true) {
    throw new Error(`Safety Violation: "${paths.dataRoot}" is not a production data directory.`);
  }
  const namespace = isProduction ? PRODUCTION_RESOURCE_NAMESPACE : TEST_RESOURCE_NAMESPACE;
  const removeVolumes = isProduction ? false : (options.removeVolumes ?? false);
  const graceTimeoutMs = options.graceTimeoutMs ?? 500;
  const inspector = options.processInspector ?? defaultProcessInspector;
  const killer = options.processKiller ?? defaultProcessKiller;

  const terminatedProcesses: TerminatedResource[] = [];
  const terminatedContainers: TerminatedResource[] = [];
  const removedVolumes: TerminatedResource[] = [];
  const processedVolumes = new Set<string>();
  let cleanedMetadataCount = 0;
  let allSucceeded = true;

  // 1. Process Teardown with strict live verification and PID reuse guard
  if (existsSync(paths.pidsDir)) {
    const pfiles = readdirSync(paths.pidsDir).filter((f) => f.endsWith('.json'));
    for (const file of pfiles) {
      const service = file.replace(/\.json$/, '');
      let proc = null;
      try {
        proc = readSignedProcessMeta(service, pathOptions);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        terminatedProcesses.push({
          type: 'process',
          name: service,
          status: 'failed',
          error: `Invalid or tampered signed process metadata: ${msg}`,
        });
        allSucceeded = false;
        continue;
      }

      if (!proc) {
        continue;
      }

      if (proc.owner !== 'enkeep-demo') {
        terminatedProcesses.push({
          type: 'process',
          name: proc.service,
          id: proc.pid,
          status: 'failed',
          error: `Safety violation: Invalid owner tag "${proc.owner}" in process metadata`,
        });
        allSucceeded = false;
        continue;
      }

      const killResult = await safeKillProcess(proc, {
        inspector,
        killer,
        graceTimeoutMs,
        repoRoot,
        dataRoot: options.dataRoot,
        mode: options.mode,
      });

      if (killResult.status === 'failed') {
        terminatedProcesses.push({
          type: 'process',
          name: proc.service,
          id: proc.pid,
          status: 'failed',
          error: killResult.error,
        });
        allSucceeded = false;
      } else if (killResult.status === 'already_stopped') {
        terminatedProcesses.push({
          type: 'process',
          name: proc.service,
          id: proc.pid,
          status: 'already_stopped',
        });
        removeSignedProcessMeta(proc.service, pathOptions);
        cleanedMetadataCount++;
      } else {
        terminatedProcesses.push({
          type: 'process',
          name: proc.service,
          id: proc.pid,
          status: 'terminated',
        });
        removeSignedProcessMeta(proc.service, pathOptions);
        cleanedMetadataCount++;
      }
    }
  }

  // 2. Docker Container Teardown with live inspect label and exact ID verification
  if (existsSync(paths.containersDir)) {
    const cfiles = readdirSync(paths.containersDir).filter((f) => f.endsWith('.json'));
    const dockerClient = options.dockerClient ?? new SafeDockerClient();
    const isDockerAvailable = await dockerClient.isDockerAvailable();

    for (const file of cfiles) {
      const cname = file.replace(/\.json$/, '');
      let c = null;
      try {
        c = readSignedContainerMeta(cname, pathOptions);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        terminatedContainers.push({
          type: 'container',
          name: cname,
          status: 'failed',
          error: `Invalid or tampered signed container metadata: ${msg}`,
        });
        allSucceeded = false;
        continue;
      }

      if (!c) {
        continue;
      }

      // Strict metadata safety assertions
      if (!c.containerName.startsWith(namespace.containerPrefix)) {
        terminatedContainers.push({
          type: 'container',
          name: c.containerName,
          id: c.containerId,
          status: 'failed',
          error: `Safety violation: Container name "${c.containerName}" does not start with prefix "${namespace.containerPrefix}"`,
        });
        allSucceeded = false;
        continue;
      }

      if (!labelsMatchNamespace(c.labels, namespace)) {
        terminatedContainers.push({
          type: 'container',
          name: c.containerName,
          id: c.containerId,
          status: 'failed',
          error: `Safety violation: Missing mandatory label "${DEMO_LABEL_KEY}=${namespace.appLabel}"`,
        });
        allSucceeded = false;
        continue;
      }

      if (!CONTAINER_ID_64_REGEX.test(c.containerId)) {
        terminatedContainers.push({
          type: 'container',
          name: c.containerName,
          id: c.containerId,
          status: 'failed',
          error: `Safety violation: containerId "${c.containerId}" is not a valid 64-hex SHA-256 ID`,
        });
        allSucceeded = false;
        continue;
      }

      if (!RUN_ID_REGEX.test(c.runId)) {
        terminatedContainers.push({
          type: 'container',
          name: c.containerName,
          id: c.containerId,
          status: 'failed',
          error: `Safety violation: runId "${c.runId}" does not match pattern ${RUN_ID_REGEX.source}`,
        });
        allSucceeded = false;
        continue;
      }

      if (!isDockerAvailable) {
        terminatedContainers.push({
          type: 'container',
          name: c.containerName,
          id: c.containerId,
          status: 'failed',
          error: 'Docker daemon is unavailable to teardown container',
        });
        allSucceeded = false;
        continue;
      }

      const runId = c.runId;

      // Inspect live container before stopping/removing
      let liveInfo = null;
      try {
        liveInfo = await dockerClient.inspectContainer(c.containerName);
      } catch (inspectErr: unknown) {
        const msg = inspectErr instanceof Error ? inspectErr.message : String(inspectErr);
        terminatedContainers.push({
          type: 'container',
          name: c.containerName,
          id: c.containerId,
          status: 'failed',
          error: `Live inspect error: ${msg}`,
        });
        allSucceeded = false;
        continue;
      }

      if (liveInfo === null) {
        // Explicit notfound: container does not exist in Docker
        let volumeCleaned = true;
        if (removeVolumes && c.volumeName) {
          if (!c.volumeName.startsWith(namespace.volumePrefix)) {
            removedVolumes.push({
              type: 'volume',
              name: c.volumeName,
              status: 'failed',
              error: `Safety violation: Volume "${c.volumeName}" does not start with volume prefix "${namespace.volumePrefix}"`,
            });
            volumeCleaned = false;
            allSucceeded = false;
          } else {
            processedVolumes.add(c.volumeName);
            const volMeta = readSignedVolumeMeta(c.volumeName, pathOptions);
            if (!volMeta) {
              removedVolumes.push({
                type: 'volume',
                name: c.volumeName,
                status: 'failed',
                error: `Safety violation: Missing signed volume metadata for "${c.volumeName}"`,
              });
              volumeCleaned = false;
              allSucceeded = false;
            } else {
              try {
                await dockerClient.removeVolume({
                  volumeName: c.volumeName,
                  userId: c.userId,
                  volumeId: volMeta.volumeId,
                });
                removeSignedVolumeMeta(c.volumeName, pathOptions);
                cleanedMetadataCount++;
                removedVolumes.push({
                  type: 'volume',
                  name: c.volumeName,
                  id: volMeta.volumeId,
                  status: 'terminated',
                });
              } catch (volErr: unknown) {
                const msg = volErr instanceof Error ? volErr.message : String(volErr);
                removedVolumes.push({
                  type: 'volume',
                  name: c.volumeName,
                  id: volMeta.volumeId,
                  status: 'failed',
                  error: msg,
                });
                volumeCleaned = false;
                allSucceeded = false;
              }
            }
          }
        }

        if (volumeCleaned) {
          terminatedContainers.push({
            type: 'container',
            name: c.containerName,
            id: c.containerId,
            status: 'already_stopped',
          });
          removeSignedContainerMeta(c.containerName, pathOptions);
          cleanedMetadataCount++;
        }
        continue;
      }

      // If container exists, verify exact container ID and labels match
      if (liveInfo.id !== c.containerId) {
        terminatedContainers.push({
          type: 'container',
          name: c.containerName,
          id: c.containerId,
          status: 'failed',
          error: `Safety violation: Live container ID "${liveInfo.id}" does not match signed metadata container ID "${c.containerId}"`,
        });
        allSucceeded = false;
        continue;
      }

      if (!labelsMatchNamespace(liveInfo.labels, namespace) || liveInfo.labels[USER_LABEL_KEY] !== c.userId || liveInfo.labels[RUN_ID_LABEL_KEY] !== c.runId) {
        terminatedContainers.push({
          type: 'container',
          name: c.containerName,
          id: c.containerId,
          status: 'failed',
          error: `Safety violation: Live container labels do not match signed metadata expectations`,
        });
        allSucceeded = false;
        continue;
      }

      // A runtime may run with network mode 'none' or 'bridge' (the platform's --network-mode). The
      // ownership check compares against the expectation, which otherwise defaults to 'none', so pass
      // the container's own mode, accepting only the two modes a runtime can be created with. When the
      // inspect result carries no mode, the client's own check (which requires one) decides.
      const liveNetworkMode = liveInfo.networkMode?.trim() || undefined;
      if (liveNetworkMode !== undefined && !isRuntimeNetworkMode(liveNetworkMode)) {
        terminatedContainers.push({
          type: 'container',
          name: c.containerName,
          id: c.containerId,
          status: 'failed',
          error: `Safety violation: Live container NetworkMode "${liveNetworkMode}" is not one of ${RUNTIME_NETWORK_MODES.join(', ')}`,
        });
        allSucceeded = false;
        continue;
      }

      const expectation = {
        containerName: c.containerName,
        userId: c.userId,
        runId,
        containerId: c.containerId,
        volumeName: c.volumeName,
        volumeId: c.volumeId,
        containerPath: '/home/dsh',
        ...(liveNetworkMode ? { networkMode: liveNetworkMode as RuntimeNetworkMode } : {}),
      };

      let containerRemoved = false;
      try {
        await dockerClient.stopContainer(expectation, 2);
        await dockerClient.removeContainer(expectation, true);
        containerRemoved = true;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        terminatedContainers.push({
          type: 'container',
          name: c.containerName,
          id: c.containerId,
          status: 'failed',
          error: msg,
        });
        allSucceeded = false;
        continue;
      }

      if (containerRemoved) {
        let volumeSuccess = true;
        if (removeVolumes && c.volumeName) {
          if (!c.volumeName.startsWith(namespace.volumePrefix)) {
            removedVolumes.push({
              type: 'volume',
              name: c.volumeName,
              status: 'failed',
              error: `Safety violation: Volume "${c.volumeName}" does not start with volume prefix "${namespace.volumePrefix}"`,
            });
            volumeSuccess = false;
            allSucceeded = false;
          } else {
            processedVolumes.add(c.volumeName);
            const volMeta = readSignedVolumeMeta(c.volumeName, pathOptions);
            if (!volMeta) {
              removedVolumes.push({
                type: 'volume',
                name: c.volumeName,
                status: 'failed',
                error: `Safety violation: Missing signed volume metadata for "${c.volumeName}"`,
              });
              volumeSuccess = false;
              allSucceeded = false;
            } else {
              try {
                await dockerClient.removeVolume({
                  volumeName: c.volumeName,
                  userId: c.userId,
                  volumeId: volMeta.volumeId,
                });
                removeSignedVolumeMeta(c.volumeName, pathOptions);
                cleanedMetadataCount++;
                removedVolumes.push({
                  type: 'volume',
                  name: c.volumeName,
                  id: volMeta.volumeId,
                  status: 'terminated',
                });
              } catch (volErr: unknown) {
                const msg = volErr instanceof Error ? volErr.message : String(volErr);
                removedVolumes.push({
                  type: 'volume',
                  name: c.volumeName,
                  id: volMeta.volumeId,
                  status: 'failed',
                  error: msg,
                });
                volumeSuccess = false;
                allSucceeded = false;
              }
            }
          }
        }

        if (volumeSuccess) {
          terminatedContainers.push({
            type: 'container',
            name: c.containerName,
            id: c.containerId,
            status: 'terminated',
          });
          removeSignedContainerMeta(c.containerName, pathOptions);
          cleanedMetadataCount++;
        }
      }
    }
  }

  // 3. Standalone Signed Volumes Teardown (if removeVolumes requested)
  if (removeVolumes && existsSync(paths.volumesDir)) {
    const vfiles = readdirSync(paths.volumesDir).filter((f) => f.endsWith('.json'));
    const dockerClient = options.dockerClient ?? new SafeDockerClient();
    const isDockerAvailable = await dockerClient.isDockerAvailable();

    for (const file of vfiles) {
      const vname = file.replace(/\.json$/, '');
      if (processedVolumes.has(vname)) {
        continue;
      }

      let volMeta = null;
      try {
        volMeta = readSignedVolumeMeta(vname, pathOptions);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        removedVolumes.push({
          type: 'volume',
          name: vname,
          status: 'failed',
          error: `Invalid or tampered signed volume metadata: ${msg}`,
        });
        allSucceeded = false;
        continue;
      }

      if (!volMeta) continue;

      if (processedVolumes.has(volMeta.volumeName)) {
        continue;
      }
      processedVolumes.add(volMeta.volumeName);

      if (!isDockerAvailable) {
        removedVolumes.push({
          type: 'volume',
          name: volMeta.volumeName,
          id: volMeta.volumeId,
          status: 'failed',
          error: 'Docker daemon is unavailable to remove volume',
        });
        allSucceeded = false;
        continue;
      }

      try {
        await dockerClient.removeVolume({
          volumeName: volMeta.volumeName,
          userId: volMeta.userId,
          volumeId: volMeta.volumeId,
        });
        removeSignedVolumeMeta(volMeta.volumeName, pathOptions);
        cleanedMetadataCount++;
        removedVolumes.push({
          type: 'volume',
          name: volMeta.volumeName,
          id: volMeta.volumeId,
          status: 'terminated',
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        removedVolumes.push({
          type: 'volume',
          name: volMeta.volumeName,
          id: volMeta.volumeId,
          status: 'failed',
          error: msg,
        });
        allSucceeded = false;
      }
    }
  }

  // 4. Host Runtime Process and Directory Cleanup
  const hostRuntimesDir = join(paths.dataRoot, 'host-runtimes');
  if (existsSync(hostRuntimesDir)) {
    try {
      const userEntries = readdirSync(hostRuntimesDir, { withFileTypes: true });
      for (const userEntry of userEntries) {
        if (userEntry.isDirectory()) {
          const runDir = join(hostRuntimesDir, userEntry.name, 'run');
          const metaPath = join(runDir, 'process.meta.json');
          if (existsSync(metaPath)) {
            try {
              const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
              if (meta && typeof meta.pid === 'number' && isProcessAlive(meta.pid)) {
                await killProcessTree(meta.pid, 2000);
                terminatedProcesses.push({
                  type: 'process',
                  name: `host-runtime-${userEntry.name}`,
                  id: meta.pid,
                  status: 'terminated',
                });
              }
              cleanStaleProcess(runDir);
            } catch {}
          }
          if (removeVolumes) {
            try {
              rmSync(join(hostRuntimesDir, userEntry.name), { recursive: true, force: true });
              removedVolumes.push({
                type: 'volume',
                name: `host-storage-${userEntry.name}`,
                status: 'terminated',
              });
            } catch {}
          }
        }
      }
    } catch {}
  }

  const timestamp = new Date().toISOString();

  return {
    ok: allSucceeded,
    timestamp,
    terminatedProcesses,
    terminatedContainers,
    removedVolumes,
    cleanedMetadataCount,
  };
}
