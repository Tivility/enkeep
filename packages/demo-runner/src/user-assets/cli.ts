/**
 * `user-assets-migrate`: Docker-backed dependencies and entry point for the one-time
 * convergence of user-level assets (see ./index.ts).
 *
 * @module @enkeep/demo-runner/user-assets/cli
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SafeDockerClient } from '@enkeep/runtime-runner/docker';
import { userAssetKindForTarget } from '@enkeep/runtime-runner';
import { getDemoPathConfig, validateResourceSuffix, DEMO_LABEL_KEY, DEMO_LABEL_VALUE, USER_LABEL_KEY, VOLUME_ID_LABEL_KEY } from '../config.js';
import { readSignedVolumeMeta, VOLUME_ID_REGEX, CONTAINER_ID_64_REGEX } from '../utils/crypto-meta.js';
import { deriveRuntimeIdentity } from '../utils/runtime-identity.js';
import { queryContainerActivity } from '../preflight/index.js';
import {
  CONTAINER_MIGRATION_SCRIPT,
  migrationExitCode,
  runUserAssetMigration,
  type MigrationUser,
  type UserAssetMigrationDeps,
  type UserMigrationReport,
} from './index.js';

const CONTAINER_HOME = '/home/dsh';
const SCRIPT_TIMEOUT_MS = 120_000;
const SCRIPT_MAX_OUTPUT = 32 * 1024 * 1024;

export interface UserAssetMigrateCliOptions {
  readonly repoRoot?: string;
  readonly dataDir?: string;
  readonly resourceSuffix?: string;
  readonly dryRun: boolean;
  readonly archiveDivergent: boolean;
  /** Restrict to these platform usernames */
  readonly usernames?: readonly string[];
}

/**
 * Lists active platform users as container runtime identities (read-only DB access).
 */
export function listMigrationUsers(dbPath: string, resourceSuffix?: string, usernames?: readonly string[]): MigrationUser[] {
  validateResourceSuffix(resourceSuffix);
  const suffix = resourceSuffix ? `-${resourceSuffix}` : '';
  if (!existsSync(dbPath)) {
    throw new Error('Platform database not found under the data directory');
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT id, username FROM users WHERE status = 'active' ORDER BY username")
      .all() as Array<{ id: string; username: string }>;
    const filter = usernames && usernames.length > 0 ? new Set(usernames) : undefined;
    return rows
      .filter((r) => typeof r.id === 'string' && typeof r.username === 'string')
      .filter((r) => !filter || filter.has(r.username))
      .map((r) => {
        const runtimeIdentity = deriveRuntimeIdentity(r.id, r.username);
        return {
          platformUserId: r.id,
          username: r.username,
          runtimeIdentity,
          containerName: `enkeep-demo-${runtimeIdentity}${suffix}`,
          volumeName: `enkeep-demo-dsh-${runtimeIdentity}${suffix}`,
        };
      });
  } finally {
    db.close();
  }
}

/**
 * Docker-backed migration dependencies. Container ownership is verified by labels and the
 * volume mount before anything runs inside it; scripts run as the runtime user (1000:1000).
 */
export function createDockerMigrationDeps(pathOptions: { repoRoot?: string; dataRoot?: string }): UserAssetMigrationDeps {
  const client = new SafeDockerClient();
  return {
    async inspectContainer(user) {
      const info = await client.inspectContainer(user.containerName);
      if (!info) return null;
      const labels = info.labels || {};
      if (labels[DEMO_LABEL_KEY] !== DEMO_LABEL_VALUE || labels[USER_LABEL_KEY] !== user.runtimeIdentity) {
        throw new Error('container ownership labels do not match the platform user');
      }
      if (!CONTAINER_ID_64_REGEX.test(info.id)) {
        throw new Error('container id is not a full 64-hex id');
      }
      const volumeId = labels[VOLUME_ID_LABEL_KEY];
      if (!volumeId || !VOLUME_ID_REGEX.test(volumeId)) {
        throw new Error('container volume id label is invalid');
      }
      const volumeMounts = (info.mounts ?? []).filter((m) => m.type === 'volume');
      if (volumeMounts.length !== 1 || volumeMounts[0].name !== user.volumeName || volumeMounts[0].destination !== CONTAINER_HOME) {
        throw new Error('container volume mount does not match the expected user volume');
      }
      const signedVol = readSignedVolumeMeta(user.volumeName, pathOptions);
      if (signedVol && signedVol.volumeId !== volumeId) {
        throw new Error('signed volume metadata does not match the container volume id');
      }
      const userAssetMountKinds = (info.mounts ?? [])
        .filter((m) => m.type === 'bind')
        .map((m) => userAssetKindForTarget(m.destination))
        .filter((k): k is NonNullable<typeof k> => Boolean(k));
      return { containerId: info.id, running: info.state === 'running', volumeId, userAssetMountKinds };
    },
    async isRuntimeIdle(containerId) {
      const act = await queryContainerActivity(containerId, 4000);
      if (!act) return null;
      const busy =
        act.activeTurnsCount > 0 ||
        act.autonomousTurnsCount > 0 ||
        act.runningJobsCount > 0 ||
        act.runningWorkflowJobsCount > 0 ||
        act.liveSubagentsCount > 0 ||
        act.pendingInboxItemsCount > 0 ||
        act.queuedTurnsCount > 0;
      return !busy && act.isIdle === true;
    },
    runContainerScript(containerId, op, args) {
      if (!CONTAINER_ID_64_REGEX.test(containerId)) {
        return Promise.reject(new Error('invalid container id'));
      }
      return new Promise((resolvePromise, rejectPromise) => {
        execFile(
          'docker',
          ['exec', '-u', '1000:1000', containerId, 'node', '-e', CONTAINER_MIGRATION_SCRIPT, op, CONTAINER_HOME, JSON.stringify(args)],
          { timeout: SCRIPT_TIMEOUT_MS, maxBuffer: SCRIPT_MAX_OUTPUT },
          (err, stdout) => {
            const text = typeof stdout === 'string' ? stdout.trim() : '';
            if (text) {
              try {
                resolvePromise(JSON.parse(text));
                return;
              } catch {
                // fall through
              }
            }
            rejectPromise(new Error(err ? `container script failed (${err.code ?? 'error'})` : 'container script returned no result'));
          }
        );
      });
    },
  };
}

export async function runUserAssetMigrateCli(options: UserAssetMigrateCliOptions): Promise<{
  ok: boolean;
  exitCode: 0 | 1 | 2;
  dryRun: boolean;
  reports: UserMigrationReport[];
}> {
  const paths = getDemoPathConfig({ repoRoot: options.repoRoot, ...(options.dataDir ? { dataRoot: options.dataDir } : {}) });
  const users = listMigrationUsers(paths.dbPath, options.resourceSuffix, options.usernames);
  const reports = await runUserAssetMigration({
    dataRoot: paths.dataRoot,
    users,
    dryRun: options.dryRun,
    archiveDivergent: options.archiveDivergent,
    deps: createDockerMigrationDeps({ repoRoot: paths.repoRoot, dataRoot: paths.dataRoot }),
  });
  const exitCode = migrationExitCode(reports);
  return { ok: exitCode === 0, exitCode, dryRun: options.dryRun, reports };
}
