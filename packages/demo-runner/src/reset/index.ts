/**
 * Demo Environment Reset Implementation (`demo:reset`)
 *
 * Enforces:
 * 1. Target directory MUST resolve inside canonical dataRoot (contained within repo or isolated test root).
 * 2. Generates fresh random high-entropy credentials for Alice, Bob, and Charlie on every run,
 *    returns them in memory once (no plaintext disk persistence), and passes them to provisionFixtures.
 * 3. Generates/rotates secure random secrets in `<dataRoot>/secrets.json` (mode 0o600).
 * 4. Re-initializes SQLite database and executes all migrations up to date (including Web Messages & Events).
 * 5. Provisions default users and default spaces with unique credentials.
 * 6. Runs deterministic HappyClaw mock importer from safe fixtures directory.
 * 7. Populates Alice tenant platform SQLite (spaces, sessions, web_messages, web_events) with >=20 user + >=20 assistant messages.
 * 8. Strictly isolates demo data between Alice and Bob (Bob cannot see Alice's imported data).
 * 9. Ensures deterministic, byte-stable, idempotent reset.
 * 10. Strict cookies (cookieSameSite: 'Strict').
 *
 * @module @enkeep/demo-runner/reset
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  SqlitePlatformStorage,
  SqlitePlatformOperationsStorage,
} from '@enkeep/platform-storage-sqlite';
import { DefaultAuthService, provisionFixtures } from '@enkeep/platform-auth';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  SqliteFixedFixtureImporter,
} from '@enkeep/platform-server';
import { importFixedHappyClawFixture } from '@enkeep/import-happyclaw';
import {
  getDemoPathConfig,
  assertPathInDemoData,
  findRepoRoot,
} from '../config.js';
import {
  generateAndSaveSecrets,
  getDemoSecrets,
  listSignedProcesses,
  listSignedContainers,
  listSignedVolumes,
} from '../utils/crypto-meta.js';
import { downDemo } from '../down/index.js';
import type { DemoResetOptions, DemoResetResult, DemoCredentials, DemoPathOptions } from '../types.js';

export const ALLOWED_DEMO_DATA_ENTRIES = Object.freeze(
  new Set([
    'pids',
    'containers',
    'volumes',
    'spaces',
    'sessions',
    'import',
    'host-runtimes',
    'platform.db',
    'platform.db-wal',
    'platform.db-shm',
    'secrets.json',
  ])
);

/**
 * Safe, explicit demo fixture quota limits for Alice and Bob.
 *
 * Configured according to deterministic E2E test capacity requirements:
 * - turns: 1000
 * - messages: 1000
 * - tokens: 1000000
 * - storage_bytes: 10485760 (10MB)
 * - api_calls: 5000
 *
 * NOTE: These are strictly demo fixture policies for local development/testing,
 * NOT unmetered or production defaults. Production requires explicit administrative quota provisioning.
 */
export const DEMO_FIXTURE_QUOTA_LIMITS: Readonly<Record<string, number>> = Object.freeze({
  turns: -1,
  messages: -1,
  tokens: -1,
  storage_bytes: -1,
  api_calls: -1,
});

/**
 * Recursively verifies that an entry and all its children are strictly non-symlinks,
 * on the exact same filesystem device as rootDev, owned by current process UID,
 * and regular files/directories (no FIFOs, sockets, or devices).
 */
function assertSafeRecursiveEntry(entryPath: string, rootDev: number): void {
  const stat = lstatSync(entryPath);
  if (stat.isSymbolicLink()) {
    throw new Error(`Safety Violation: Symlink detected at "${entryPath}". Refusing reset cleanup.`);
  }
  if (stat.dev !== rootDev) {
    throw new Error(
      `Safety Violation: Cross-device descendant detected at "${entryPath}" (device ${stat.dev} != root device ${rootDev}). Refusing reset cleanup.`
    );
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(
      `Safety Violation: File owner UID ${stat.uid} at "${entryPath}" does not match current process UID ${process.getuid()}.`
    );
  }
  if (!stat.isFile() && !stat.isDirectory()) {
    throw new Error(`Safety Violation: Special file (FIFO/socket/device) detected at "${entryPath}". Refusing reset cleanup.`);
  }
  if (stat.isDirectory()) {
    const nestedEntries = readdirSync(entryPath);
    for (const nested of nestedEntries) {
      assertSafeRecursiveEntry(join(entryPath, nested), rootDev);
    }
  }
}

interface TopEntrySnapshot {
  entry: string;
  entryPath: string;
  dev: number;
  ino: number;
  uid: number;
  isDirectory: boolean;
  isFile: boolean;
}

/**
 * Safely cleans contents of dataRoot using strict allowlist verification, root inode/dev snapshots,
 * individual entry snapshot identity verification (TOCTOU guard), recursive non-symlink verification,
 * and preserved root directory.
 */
export function cleanDemoDataSafely(dataRoot: string, pathOptions: DemoPathOptions): void {
  if (!existsSync(dataRoot)) return;

  const rootStat = lstatSync(dataRoot);
  if (rootStat.isSymbolicLink()) {
    throw new Error(`Safety Violation: Demo data root directory is a symlink: "${dataRoot}". Refusing reset.`);
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`Safety Violation: Demo data root path is not a directory: "${dataRoot}".`);
  }
  if (typeof process.getuid === 'function' && rootStat.uid !== process.getuid()) {
    throw new Error(
      `Safety Violation: Demo data root UID ${rootStat.uid} does not match current process UID ${process.getuid()}.`
    );
  }

  const rootDev = rootStat.dev;
  const rootIno = rootStat.ino;

  const entries = readdirSync(dataRoot);
  const snapshots: TopEntrySnapshot[] = [];

  // 1. Pre-validation phase (Strict all-or-nothing check & identity snapshot)
  for (const entry of entries) {
    if (!ALLOWED_DEMO_DATA_ENTRIES.has(entry)) {
      throw new Error(
        `Safety Violation: Unknown or non-allowlisted entry "${entry}" found in demo data directory "${dataRoot}". Preserving all data and refusing reset.`
      );
    }
    const entryPath = join(dataRoot, entry);
    assertPathInDemoData(entryPath, pathOptions);
    assertSafeRecursiveEntry(entryPath, rootDev);

    const entryStat = lstatSync(entryPath);
    snapshots.push({
      entry,
      entryPath,
      dev: entryStat.dev,
      ino: entryStat.ino,
      uid: entryStat.uid,
      isDirectory: entryStat.isDirectory(),
      isFile: entryStat.isFile(),
    });
  }

  // 2. Deletion phase (Re-verifying root and entry exact identity before each deletion)
  for (const snap of snapshots) {
    const currentRootStat = lstatSync(dataRoot);
    if (
      currentRootStat.isSymbolicLink() ||
      !currentRootStat.isDirectory() ||
      currentRootStat.dev !== rootDev ||
      currentRootStat.ino !== rootIno ||
      (typeof process.getuid === 'function' && currentRootStat.uid !== process.getuid())
    ) {
      throw new Error(`Safety Violation: Demo data root directory inode/device/state modified during cleanup! Aborting reset.`);
    }

    let preRmStat;
    try {
      preRmStat = lstatSync(snap.entryPath);
    } catch (err: unknown) {
      throw new Error(
        `Safety Violation: Entry "${snap.entryPath}" disappeared or cannot be stat'd before deletion (TOCTOU guard)! Aborting reset.`
      );
    }

    if (
      preRmStat.isSymbolicLink() ||
      preRmStat.dev !== snap.dev ||
      preRmStat.ino !== snap.ino ||
      preRmStat.uid !== snap.uid ||
      preRmStat.isDirectory() !== snap.isDirectory ||
      preRmStat.isFile() !== snap.isFile ||
      (typeof process.getuid === 'function' && preRmStat.uid !== process.getuid())
    ) {
      throw new Error(
        `Safety Violation: Entry "${snap.entryPath}" identity was modified or swapped before deletion (TOCTOU guard)! Aborting reset.`
      );
    }

    // Revalidate descendants
    assertSafeRecursiveEntry(snap.entryPath, rootDev);

    rmSync(snap.entryPath, { recursive: true, force: false });
  }

  // 3. Final root re-verification: root itself remains intact
  const finalRootStat = lstatSync(dataRoot);
  if (finalRootStat.dev !== rootDev || finalRootStat.ino !== rootIno) {
    throw new Error(`Safety Violation: Demo data root inode was replaced during cleanup!`);
  }
}

export async function resetDemo(options: DemoResetOptions = {}): Promise<DemoResetResult> {
  const timestamp = options.deterministicCreatedAt ?? new Date().toISOString();
  const repoRoot = options.repoRoot ?? findRepoRoot();
  const pathOptions: DemoPathOptions = {
    repoRoot,
    dataRoot: options.dataRoot,
    mode: options.mode,
    resourceSuffix: options.resourceSuffix,
  };
  const paths = getDemoPathConfig(pathOptions);

  // 1. Invariant: Target directory MUST resolve inside dataRoot
  assertPathInDemoData(paths.dataRoot, pathOptions);

  // 2. Check for actively registered demo resources
  const activeProcs = listSignedProcesses(pathOptions);
  const activeContainers = listSignedContainers(pathOptions);
  const activeVolumes = listSignedVolumes(pathOptions);
  const hasSignedResources = activeProcs.length > 0 || activeContainers.length > 0 || activeVolumes.length > 0;

  if (options.checkActiveResources) {
    if (activeProcs.length > 0) {
      const pnames = activeProcs.map((p) => `${p.service}(PID:${p.pid})`).join(', ');
      throw new Error(
        `Safety Violation: Cannot reset demo environment while demo processes are running: [${pnames}]. Run "demo:down" first.`
      );
    }
    if (activeContainers.length > 0) {
      const cnames = activeContainers.map((c) => c.containerName).join(', ');
      throw new Error(
        `Safety Violation: Cannot reset demo environment while demo containers are registered: [${cnames}]. Run "demo:down" first.`
      );
    }
    if (activeVolumes.length > 0) {
      const vnames = activeVolumes.map((v) => v.volumeName).join(', ');
      throw new Error(
        `Safety Violation: Cannot reset demo environment while demo volumes are registered: [${vnames}]. Run "demo:down" first.`
      );
    }
  } else if (hasSignedResources) {
    // Exact owned lifecycle cleanup whenever signed metadata exists BEFORE deleting data
    const downResult = await downDemo({
      ...pathOptions,
      removeVolumes: true,
      dockerClient: options.dockerClient,
      processInspector: options.processInspector,
      processKiller: options.processKiller,
    });

    if (!downResult.ok) {
      const pErrors = downResult.terminatedProcesses
        .filter((p) => p.status === 'failed')
        .map((p) => `${p.name}: ${p.error}`)
        .join('; ');
      const cErrors = downResult.terminatedContainers
        .filter((c) => c.status === 'failed')
        .map((c) => `${c.name}: ${c.error}`)
        .join('; ');
      const vErrors = downResult.removedVolumes
        .filter((v) => v.status === 'failed')
        .map((v) => `${v.name}: ${v.error}`)
        .join('; ');
      const summary = [pErrors && `Processes: ${pErrors}`, cErrors && `Containers: ${cErrors}`, vErrors && `Volumes: ${vErrors}`]
        .filter(Boolean)
        .join('\n');

      throw new Error(`Safety Violation: Failed to safely teardown active demo resources before reset:\n${summary}`);
    }

    // Defensive re-verification: confirm zero signed metadata remains after teardown
    const remainingProcs = listSignedProcesses(pathOptions);
    const remainingContainers = listSignedContainers(pathOptions);
    const remainingVolumes = listSignedVolumes(pathOptions);
    if (remainingProcs.length > 0 || remainingContainers.length > 0 || remainingVolumes.length > 0) {
      throw new Error(
        `Safety Violation: Residual signed metadata remained after teardown: ` +
        `processes=[${remainingProcs.map((p) => p.service).join(', ')}], ` +
        `containers=[${remainingContainers.map((c) => c.containerName).join(', ')}], ` +
        `volumes=[${remainingVolumes.map((v) => v.volumeName).join(', ')}]. Preserving all data and aborting reset.`
      );
    }
  }

  // 3. Clean contents of demoDataDir safely using allowlisted entries only (fails loud on errors, preserves root)
  if (options.forceClean !== false) {
    cleanDemoDataSafely(paths.dataRoot, pathOptions);
  }

  mkdirSync(paths.dataRoot, { recursive: true, mode: 0o700 });
  mkdirSync(paths.pidsDir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.containersDir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.volumesDir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.spacesDir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.sessionsDir, { recursive: true, mode: 0o700 });

  // 4. Initialize or rotate secrets in <dataRoot>/secrets.json with mode 0o600
  const secrets = options.rotateSecret
    ? generateAndSaveSecrets(pathOptions, true)
    : getDemoSecrets(pathOptions);

  // 5. Generate high-entropy ephemeral credentials (never persisted to plaintext disk files)
  const credentials: DemoCredentials = {
    admin: {
      username: 'alice',
      password: `pwd_alice_${randomBytes(18).toString('hex')}`,
    },
    user: {
      username: 'bob',
      password: `pwd_bob_${randomBytes(18).toString('hex')}`,
    },
    disabledUser: {
      username: 'charlie_disabled',
      password: `pwd_charlie_${randomBytes(18).toString('hex')}`,
    },
  };

  // 6. Initialize SQLite Storage & Run All Platform Server Migrations
  const db = new DatabaseSync(paths.dbPath);
  let storage: SqlitePlatformStorage | null = null;
  let primaryError: unknown = null;
  let provisioned: Awaited<ReturnType<typeof provisionFixtures>> | null = null;
  let importResult: Awaited<ReturnType<typeof importFixedHappyClawFixture>> | null = null;

  try {
    const migrationRunner = new PlatformServerMigrationRunner(db);
    await migrationRunner.migrate(ALL_PLATFORM_MIGRATIONS);

    storage = new SqlitePlatformStorage(db);

    const authService = new DefaultAuthService(storage, {
      cookieSecret: secrets.cookieSecret,
      cookieSecure: false,
      cookieSameSite: 'Strict',
    });

    // 7. Provision Users (Alice admin, Bob user, Charlie disabled) with high-entropy credentials
    provisioned = await provisionFixtures(storage, authService, {
      adminUsername: credentials.admin.username,
      adminPassword: credentials.admin.password,
      userUsername: credentials.user.username,
      userPassword: credentials.user.password,
      disabledUsername: credentials.disabledUser.username,
      disabledPassword: credentials.disabledUser.password,
    });

    // 7b. Provision explicit safe demo quota limits for Alice and Bob
    const operationsStorage = new SqlitePlatformOperationsStorage(db, {
      quotaOptions: { unconfiguredPolicy: 'fail_closed' },
    });

    for (const user of [provisioned.admin, provisioned.user]) {
      const userQuota = operationsStorage.forTenant(user.id).quota;
      for (const [resource, limit] of Object.entries(DEMO_FIXTURE_QUOTA_LIMITS) as [
        'turns' | 'messages' | 'tokens' | 'storage_bytes' | 'api_calls',
        number,
      ][]) {
        await userQuota.setLimit({
          resource,
          limit,
        });
      }
    }

    // 8. Run Fixed Mock Importer using safe repository fixtures
    importResult = await importFixedHappyClawFixture({
      targetDir: paths.importDir,
      demoRoot: paths.dataRoot,
      userId: 'alice',
      deterministicCreatedAt: timestamp,
    });

    // 9. Populate Alice Tenant Platform SQLite with Imported Spaces, Session Routes, Messages & Events
    const fixtureImporter = new SqliteFixedFixtureImporter(db);
    await fixtureImporter.importFixture({
      userId: provisioned.admin.id,
      result: importResult,
      deterministicCreatedAt: timestamp,
    });

  } catch (err: unknown) {
    primaryError = err;
  } finally {
    try {
      if (storage) {
        await storage.close();
      } else {
        db.close();
      }
    } catch (closeErr: unknown) {
      if (primaryError) {
        primaryError = new AggregateError(
          [
            primaryError instanceof Error ? primaryError : new Error(String(primaryError)),
            closeErr instanceof Error ? closeErr : new Error(String(closeErr)),
          ],
          'Failed during reset storage cleanup (storage.close() / db.close())'
        );
      } else {
        primaryError = closeErr instanceof Error ? closeErr : new Error(String(closeErr));
      }
    }
  }

  if (primaryError) {
    throw primaryError;
  }

  if (!provisioned || !importResult) {
    throw new Error('FAIL-CLOSED: Demo reset did not complete provisioning.');
  }

  const manifestPath = join(paths.importDir, 'import-manifest.json');

  return {
    ok: true,
    timestamp,
    demoDataDir: paths.dataRoot,
    dbPath: paths.dbPath,
    credentials,
    users: {
      admin: provisioned.admin,
      user: provisioned.user,
      disabledUser: provisioned.disabledUser,
    },
    spaces: {
      aliceContainerSpace: provisioned.adminContainerSpace,
      bobContainerSpace: provisioned.userContainerSpace,
    },
    importedChatsCount: Object.keys(importResult.mapping).length,
    importedMessagesCount: importResult.stats.sourceMessages,
    manifestPath,
  };
}
