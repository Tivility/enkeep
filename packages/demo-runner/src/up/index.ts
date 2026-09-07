/**
 * Demo Environment Startup (`demo:up`)
 *
 * Enforces:
 * 1. Preflight safety checks (never 0.0.0.0, never ports 3000/3080, loopback 127.0.0.1 only).
 * 2. Platform HTTP server dynamically bound to 127.0.0.1:0 with dynamic URL.
 * 3. Alice & Bob independent real Docker DSH runtimes (user container requirement: non-root, isolated volumes).
 *    Zero-network isolation (--network none) via Docker Exec transport (docker-exec://).
 *    Fails closed if Docker daemon is not accessible or container fails to boot.
 * 4. Injects real Docker execution into DeliveryRuntimeGateway.
 * 5. Cryptographically signed process and container metadata registration in dataRoot.
 * 6. Exact user ID mapping from SQLite username lookup (no heuristic includes).
 * 7. DeliveryTurnExecutor cancel(userId, turnId) delegates directly to handle.cancelTurn.
 * 8. Imported seed required/fail loud when seeds exist.
 * 9. Explicit failure when DB is missing (never auto-resets).
 *
 * @module @enkeep/demo-runner/up
 */

import {
  existsSync,
  readdirSync,
  mkdirSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
  lstatSync,
  constants,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { sessionIdFor } from '@enkeep/import-happyclaw';
import {
  createPlatformServer,
  PlatformServer,
  SqliteWebMessageStore,
  DeliveryRuntimeGateway,
  type DeliveryTurnExecutor,
  type DeliveryExecutionRequest,
  ModelSelectionService,
  RuntimeDiagnosticsService,
  createOperationsTenantQuotaProvider,
  createPlatformOperations,
  SqlitePlatformOperationsStorage,
  createProfileService,
  type RuntimeAgentProfileSnapshot,
  type TenantRuntimeFileProvider,
  type CanonicalFileOperationRequest,
  type CanonicalFileOperationResult,
  type CanonicalInspectTransferStateResult,
  type ManagementRuntimeProvider,
  type RuntimeRestartResult,
  DefaultRuntimeMountReconciler,
  SpaceMountService,
  ExtensionService,
  mapFileOpError,
} from '@enkeep/platform-server';
import {
  PlatformError,
  NotFoundError,
  ValidationError,
  ForbiddenError,
  type RuntimeMountSpec,
  type BrowserService,
} from '@enkeep/platform-core';
import {
  createBrowserService,
  type BrowserServiceOptions,
} from '@enkeep/platform-service-browser';
import {
  HostMcpManager,
  type McpGatewayPort,
} from '@enkeep/platform-service-mcp';
import { chromium } from 'playwright';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { SafeDockerClient } from '@enkeep/runtime-runner/docker';
import {
  computeSessionEventsChecksum,
  canonicalJsonStringify,
  computeSessionSeedReceipt,
  createPlatformProxyHandler,
  createEventsStreamHandler,
  createLlmProxyHandler,
  loadDshDeploymentConfig,
  validateMountSourcePath,
  isProcessAlive,
  type SessionSeedReceipt,
} from '@enkeep/runtime-runner';
import {
  getDemoPathConfig,
  findRepoRoot,
  validateResourceSuffix,
  assertPathInDemoData,
} from '../config.js';
import {
  writeSignedProcessMeta,
  getDemoSecrets,
  removeSignedProcessMeta,
  generateRunId,
} from '../utils/crypto-meta.js';
import { DEMO_FIXTURE_QUOTA_LIMITS } from '../reset/index.js';
import { defaultProcessInspector } from '../utils/process-guard.js';
import { deriveRuntimeIdentity } from '../utils/runtime-identity.js';
import {
  validateLoopbackHost,
  validateSafePort,
} from '../utils/probes.js';
import {
  DockerRuntimeContainerAdapter,
  HostRuntimePortAdapter,
  type UserRuntimeHandle,
  type UserRuntimeHealthInfo,
  type RuntimeContainerPort,
} from '../ports/index.js';
import {
  loadLarkTestCredentials,
  createLarkTestCredentialResolver,
  ensureLarkTestResources,
  getLarkTestCredentialRef,
} from '../utils/lark-credentials.js';
import type {
  DemoUpOptions,
  DemoUpResult,
  DemoServiceEndpoint,
  SignedProcessMetadata,
  SignedContainerMetadata,
  DemoPathOptions,
} from '../types.js';

export interface RunningDemoSystem {
  result: DemoUpResult;
  platformServer: PlatformServer;
  platformUrl: string;
  browserService?: BrowserService;
  mcpManager?: McpGatewayPort;
  storage: SqlitePlatformStorage;
  database: DatabaseSync;
  runtimeHandles: Map<string, UserRuntimeHandle>;
  hostRuntimeHandles: Map<string, UserRuntimeHandle>;
  managementProvider?: ManagementRuntimeProvider;
  restartRuntime(targetUserId?: string): Promise<RuntimeRestartResult>;
  connectRuntime(userId: string): Promise<UserRuntimeHandle>;
  ensureHostRuntime(userId: string): Promise<UserRuntimeHandle>;
  createHostSpace(userId: string, input: { name: string; folder: string; agentProfileId?: string }): Promise<import('@enkeep/platform-core').Space>;
  createHostSession(userId: string, input: { spaceId: string; title?: string }): Promise<import('@enkeep/platform-core').SessionRoute>;
  close(options?: { removeVolumes?: boolean; crash?: boolean }): Promise<void>;
}

export async function upDemo(options: DemoUpOptions = {}): Promise<RunningDemoSystem> {
  return launchDemoSystem(options);
}

export function isChromiumAvailable(customExecutablePath?: string): boolean {
  try {
    const execPath = customExecutablePath || chromium.executablePath();
    return Boolean(execPath && existsSync(execPath));
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkFileOwnershipAndMode(stat: import('node:fs').Stats, targetPath: string, _isDir: boolean): void {
  if (typeof process.getuid === 'function') {
    const currentUid = process.getuid();
    if (stat.uid !== currentUid && stat.uid !== 1000 && stat.uid !== 0) {
      throw new Error(`FAIL-CLOSED: Path ownership violation on "${targetPath}": expected UID ${currentUid} or 1000, found ${stat.uid}`);
    }
  }
  // Disallow world-writable permissions
  if ((stat.mode & 0o002) !== 0) {
    throw new Error(`FAIL-CLOSED: Insecure world-writable permissions on "${targetPath}": mode ${(stat.mode & 0o777).toString(8)}`);
  }
}

export function validateSqliteDatabasePath(dbPath: string, pathOptions: DemoPathOptions): void {
  assertPathInDemoData(dbPath, pathOptions);

  // 1. Inspect db file itself
  let stat: import('node:fs').Stats;
  try {
    stat = lstatSync(dbPath);
  } catch (err: unknown) {
    throw new Error(`FAIL-CLOSED: Database file missing or inaccessible at "${dbPath}": ${err instanceof Error ? err.message : String(err)}`);
  }

  if (stat.isSymbolicLink()) {
    throw new Error(`FAIL-CLOSED: Database file at "${dbPath}" must not be a symbolic link`);
  }
  if (!stat.isFile()) {
    throw new Error(`FAIL-CLOSED: Database path at "${dbPath}" is not a regular file`);
  }
  checkFileOwnershipAndMode(stat, dbPath, false);

  // 2. Inspect all ancestor directories up to dataRoot
  const paths = getDemoPathConfig(pathOptions);
  const dataRootDir = paths.dataRoot;

  let currentDir = dirname(dbPath);
  while (currentDir && currentDir.startsWith(dataRootDir)) {
    let dirStat: import('node:fs').Stats;
    try {
      dirStat = lstatSync(currentDir);
    } catch (err: unknown) {
      throw new Error(`FAIL-CLOSED: Ancestor directory missing or inaccessible at "${currentDir}": ${err instanceof Error ? err.message : String(err)}`);
    }

    if (dirStat.isSymbolicLink()) {
      throw new Error(`FAIL-CLOSED: Ancestor directory at "${currentDir}" must not be a symbolic link`);
    }
    if (!dirStat.isDirectory()) {
      throw new Error(`FAIL-CLOSED: Ancestor path at "${currentDir}" is not a directory`);
    }
    checkFileOwnershipAndMode(dirStat, currentDir, true);

    if (currentDir === dataRootDir) break;
    const parent = dirname(currentDir);
    if (parent === currentDir) break;
    currentDir = parent;
  }
}

export function validatePostOpenDatabasePath(dbPath: string, pathOptions: DemoPathOptions): void {
  validateSqliteDatabasePath(dbPath, pathOptions);
}

export function readSafeDescriptorFile(filePath: string, maxBytes: number = 10 * 1024 * 1024): string {
  let fd: number;
  try {
    fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err: unknown) {
    throw new Error(`FAIL-CLOSED: Failed to open file "${filePath}" with O_NOFOLLOW: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const stat = fstatSync(fd);
    if (stat.isSymbolicLink()) {
      throw new Error(`FAIL-CLOSED: File "${filePath}" must not be a symbolic link`);
    }
    if (!stat.isFile()) {
      throw new Error(`FAIL-CLOSED: Path "${filePath}" is not a regular file`);
    }
    checkFileOwnershipAndMode(stat, filePath, false);

    if (stat.size <= 0 || stat.size > maxBytes) {
      throw new Error(`FAIL-CLOSED: File "${filePath}" size ${stat.size} is out of bounds (1..${maxBytes} bytes)`);
    }

    const buf = Buffer.alloc(stat.size);
    let totalRead = 0;
    while (totalRead < stat.size) {
      const bytes = readSync(fd, buf, totalRead, stat.size - totalRead, totalRead);
      if (bytes === 0) break;
      totalRead += bytes;
    }
    if (totalRead !== stat.size) {
      throw new Error(`FAIL-CLOSED: Incomplete read from "${filePath}": expected ${stat.size} bytes, got ${totalRead}`);
    }
    return buf.toString('utf8', 0, totalRead);
  } finally {
    closeSync(fd);
  }
}

export interface VerifiedSeedPayload {
  sessionId: string;
  seedEvents: readonly unknown[];
  receipt: SessionSeedReceipt;
}

export function loadAndVerifyFixedSeeds(importDir: string, pathOptions: DemoPathOptions): VerifiedSeedPayload[] {
  assertPathInDemoData(importDir, pathOptions);

  // 1. Check importDir directory
  const importDirStat = lstatSync(importDir);
  if (importDirStat.isSymbolicLink()) {
    throw new Error(`FAIL-CLOSED: importDir at "${importDir}" must not be a symbolic link`);
  }
  if (!importDirStat.isDirectory()) {
    throw new Error(`FAIL-CLOSED: importDir at "${importDir}" is not a directory`);
  }
  checkFileOwnershipAndMode(importDirStat, importDir, true);

  // 2. Read and validate import-manifest.json
  const manifestPath = join(importDir, 'import-manifest.json');
  assertPathInDemoData(manifestPath, pathOptions);
  const manifestRaw = readSafeDescriptorFile(manifestPath, 1024 * 1024);
  const manifest: unknown = JSON.parse(manifestRaw);

  if (!isRecord(manifest)) {
    throw new Error('FAIL-CLOSED: import-manifest.json must be a JSON object');
  }
  if (typeof manifest.sourceFingerprint !== 'string' || !manifest.sourceFingerprint.startsWith('sha256:')) {
    throw new Error('FAIL-CLOSED: import-manifest.json has invalid sourceFingerprint');
  }
  if (manifest.importerVersion !== '0.1.0') {
    throw new Error(`FAIL-CLOSED: import-manifest.json importerVersion mismatch: expected "0.1.0", got "${manifest.importerVersion}"`);
  }
  if (manifest.idAlgorithm !== 'sha256-chatJid-v1') {
    throw new Error(`FAIL-CLOSED: import-manifest.json idAlgorithm mismatch: expected "sha256-chatJid-v1", got "${manifest.idAlgorithm}"`);
  }
  if (manifest.targetDsh !== '@deepseek-ai/dsh-session@0.1.1-rc.2') {
    throw new Error(`FAIL-CLOSED: import-manifest.json targetDsh mismatch: expected "@deepseek-ai/dsh-session@0.1.1-rc.2", got "${manifest.targetDsh}"`);
  }
  if (manifest.sessionFormat !== 0) {
    throw new Error(`FAIL-CLOSED: import-manifest.json sessionFormat mismatch: expected 0, got ${manifest.sessionFormat}`);
  }
  if (!isRecord(manifest.stats)) {
    throw new Error('FAIL-CLOSED: import-manifest.json missing stats object');
  }
  const stats = manifest.stats;
  if (
    stats.chats !== 2 ||
    stats.sourceMessages !== 52 ||
    stats.importedPeopleTalk !== 50 ||
    stats.droppedEmpty !== 2 ||
    stats.attachments !== 5
  ) {
    throw new Error(`FAIL-CLOSED: import-manifest.json stats invariants violation: ${JSON.stringify(stats)}`);
  }
  if (!Array.isArray(manifest.chatReports) || manifest.chatReports.length !== 2) {
    throw new Error(`FAIL-CLOSED: import-manifest.json chatReports must contain exactly 2 chat reports`);
  }

  // 3. Read and validate mapping.json
  const mappingPath = join(importDir, 'mapping.json');
  assertPathInDemoData(mappingPath, pathOptions);
  const mappingRaw = readSafeDescriptorFile(mappingPath, 1024 * 1024);
  const mapping: unknown = JSON.parse(mappingRaw);

  if (!isRecord(mapping)) {
    throw new Error('FAIL-CLOSED: mapping.json must be a JSON object');
  }

  const mappingKeys = Object.keys(mapping).sort();
  const expectedChatKeys = ['web:alice-workspace-jid-001', 'web:bob-migration-jid-002'].sort();
  if (mappingKeys.length !== 2 || !mappingKeys.every((k, idx) => k === expectedChatKeys[idx])) {
    throw new Error(`FAIL-CLOSED: mapping.json must contain exact keys [${expectedChatKeys.join(', ')}], found [${mappingKeys.join(', ')}]`);
  }

  const expectedAliceSid = sessionIdFor('web:alice-workspace-jid-001');
  const expectedBobSid = sessionIdFor('web:bob-migration-jid-002');

  const aliceMapping = mapping['web:alice-workspace-jid-001'];
  const bobMapping = mapping['web:bob-migration-jid-002'];

  if (!isRecord(aliceMapping) || aliceMapping.sessionId !== expectedAliceSid || aliceMapping.userId !== 'alice') {
    throw new Error(`FAIL-CLOSED: Invalid mapping for "web:alice-workspace-jid-001": expected sessionId="${expectedAliceSid}" and userId="alice"`);
  }
  if (!isRecord(bobMapping) || bobMapping.sessionId !== expectedBobSid || bobMapping.userId !== 'alice') {
    throw new Error(`FAIL-CLOSED: Invalid mapping for "web:bob-migration-jid-002": expected sessionId="${expectedBobSid}" and userId="alice"`);
  }

  // 4. Validate seedsDir
  const seedsDir = join(importDir, 'seeds');
  assertPathInDemoData(seedsDir, pathOptions);

  const seedsDirStat = lstatSync(seedsDir);
  if (seedsDirStat.isSymbolicLink()) {
    throw new Error(`FAIL-CLOSED: seedsDir at "${seedsDir}" must not be a symbolic link`);
  }
  if (!seedsDirStat.isDirectory()) {
    throw new Error(`FAIL-CLOSED: seedsDir at "${seedsDir}" is not a directory`);
  }
  checkFileOwnershipAndMode(seedsDirStat, seedsDir, true);

  const dirEntries = readdirSync(seedsDir).sort();
  const expectedSeedFiles = [`${expectedAliceSid}.json`, `${expectedBobSid}.json`].sort();
  if (dirEntries.length !== 2 || !dirEntries.every((e, idx) => e === expectedSeedFiles[idx])) {
    throw new Error(`FAIL-CLOSED: seedsDir contains unexpected or extra files: found [${dirEntries.join(', ')}], expected [${expectedSeedFiles.join(', ')}]`);
  }

  const results: VerifiedSeedPayload[] = [];

  for (const expectedSid of [expectedAliceSid, expectedBobSid]) {
    const seedFilePath = join(seedsDir, `${expectedSid}.json`);
    assertPathInDemoData(seedFilePath, pathOptions);
    const rawSeed = readSafeDescriptorFile(seedFilePath, 10 * 1024 * 1024);
    const seedEvents: unknown = JSON.parse(rawSeed);

    if (!Array.isArray(seedEvents) || seedEvents.length === 0) {
      throw new Error(`FAIL-CLOSED: Seed file "${expectedSid}.json" contains invalid or empty seed events array`);
    }

    for (let i = 0; i < seedEvents.length; i++) {
      const ev = seedEvents[i];
      if (!isRecord(ev)) {
        throw new Error(`FAIL-CLOSED: Seed event at index ${i} in "${expectedSid}.json" is not an object`);
      }
      if (typeof ev.type !== 'string' || ev.type.length === 0) {
        throw new Error(`FAIL-CLOSED: Seed event at index ${i} in "${expectedSid}.json" has missing or invalid type`);
      }
      if (typeof ev.seq !== 'number' || !Number.isSafeInteger(ev.seq) || ev.seq < 0) {
        throw new Error(`FAIL-CLOSED: Seed event at index ${i} in "${expectedSid}.json" has invalid seq`);
      }
      if (typeof ev.time !== 'number' || !Number.isSafeInteger(ev.time) || ev.time < 0) {
        throw new Error(`FAIL-CLOSED: Seed event at index ${i} in "${expectedSid}.json" has invalid time`);
      }
      if (!isRecord(ev.data)) {
        throw new Error(`FAIL-CLOSED: Seed event at index ${i} in "${expectedSid}.json" has invalid data object`);
      }
    }

    const checksum = computeSessionEventsChecksum(seedEvents);
    const canonicalJson = canonicalJsonStringify(seedEvents);
    const canonicalBytes = Buffer.byteLength(canonicalJson, 'utf8');

    const receipt: SessionSeedReceipt = {
      algorithm: 'sha256-session-events-v1',
      checksum,
      canonicalBytes,
      eventCount: seedEvents.length,
    };

    results.push({
      sessionId: expectedSid,
      seedEvents,
      receipt,
    });
  }

  return results;
}

export function extractEnvelopePrompt(content: unknown): string {
  if (typeof content === 'string') {
    if (content.trim().length === 0) {
      throw new Error('FAIL-CLOSED: Envelope content string is empty or whitespace only');
    }
    return content;
  }
  if (isRecord(content)) {
    if ('text' in content && typeof content.text === 'string') {
      if (content.text.trim().length === 0) {
        throw new Error('FAIL-CLOSED: Envelope content text property is empty or whitespace only');
      }
      return content.text;
    }
  }
  throw new Error('FAIL-CLOSED: Unsupported envelope content format (expected non-empty string or { text: string })');
}

export async function launchDemoSystem(options: DemoUpOptions = {}): Promise<RunningDemoSystem> {
  const repoRoot = options.repoRoot ?? findRepoRoot();
  const pathOptions: DemoPathOptions = {
    repoRoot,
    dataRoot: options.dataRoot,
    mode: options.mode,
    resourceSuffix: options.resourceSuffix,
  };
  validateResourceSuffix(options.resourceSuffix);

  const paths = getDemoPathConfig(pathOptions);

  // 1. Invariant: Demo database MUST exist. Never auto-reset to avoid credential loss!
  if (!existsSync(paths.dbPath)) {
    throw new Error(
      `FAIL-CLOSED: Demo database missing at "${paths.dbPath}". Automatic reset is forbidden to prevent credential loss. Please run "demo:reset" first to initialize and generate credentials.`
    );
  }

  // Ensure metadata directories exist with mode 0o700
  mkdirSync(paths.dataRoot, { recursive: true, mode: 0o700 });
  mkdirSync(paths.pidsDir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.containersDir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.volumesDir, { recursive: true, mode: 0o700 });

  // 2. Allocate safe dynamic host binding on 127.0.0.1 for Platform HTTP Server (never 3000/3080)
  const host = '127.0.0.1';
  validateLoopbackHost(host);

  const platformPort = options.platformPort ?? 0;
  if (platformPort !== 0) validateSafePort(platformPort);

  const allowHostRuntime =
    options.allowHostRuntime ??
    (process.env.ENKEEP_ALLOW_HOST_RUNTIME === '1' || process.env.ENKEEP_ALLOW_HOST_RUNTIME === 'true');

  // 3. Prepare Container Adapter (No production escape hatches)
  const containerAdapter: RuntimeContainerPort =
    options.runtimeAdapter ?? new DockerRuntimeContainerAdapter(new SafeDockerClient());
  const hostAdapter: RuntimeContainerPort =
    options.hostRuntimeAdapter ?? new HostRuntimePortAdapter();

  // 3b. Prepare Browser Service (Shared across tenants on host platform)
  // - If options.browserService is provided, reuse injected instance
  // - If options.browserOptions is explicitly false or ENKEEP_BROWSER_ENABLED is '0'/'false', disable
  // - If options.browserOptions is provided (object or boolean true), create service with options
  // - Production default: Enable Browser in worker mode if Chromium preflight is available
  let browserService: BrowserService | undefined = options.browserService;

  if (!browserService) {
    const browserExplicitlyDisabled =
      options.browserOptions === false ||
      process.env.ENKEEP_BROWSER_ENABLED === '0' ||
      process.env.ENKEEP_BROWSER_ENABLED === 'false';

    if (!browserExplicitlyDisabled) {
      const explicitOptions =
        typeof options.browserOptions === 'object' && options.browserOptions !== null
          ? options.browserOptions
          : undefined;

      const hasChromium = isChromiumAvailable(explicitOptions?.chromiumExecutablePath);

      if (hasChromium) {
        const browserOpts: BrowserServiceOptions = {
          mode: 'worker',
          ...explicitOptions,
        };
        browserService = createBrowserService(browserOpts);
      } else if (explicitOptions) {
        throw new Error(
          'FAIL-CLOSED: Browser options specified but Playwright Chromium executable was not found. Please install Chromium via `pnpm exec playwright install chromium`.'
        );
      }
    }
  }

  // 4. Start Alice and Bob isolated User Runtimes
  const runtimeHandles = new Map<string, UserRuntimeHandle>();
  const hostRuntimeHandles = new Map<string, UserRuntimeHandle>();
  const activeUserMountsByMode = new Map<string, Record<string, RuntimeMountSpec[]>>();
  const newlyCreatedHandles: UserRuntimeHandle[] = [];
  const containersList: SignedContainerMetadata[] = [];

  // Lark Test Opt-in Integration state
  let effectiveLarkCredentialResolver = options.larkCredentialResolver;
  let effectiveLarkDefaultSpaceResolver = options.larkDefaultSpaceResolver;

  const cleanupStartupHandles = async (handles: readonly UserRuntimeHandle[]): Promise<Error[]> => {
    const errors: Error[] = [];
    for (const h of handles) {
      try {
        // Roll back freshly created volumes to prevent leak, but PRESERVE preexisting retained volumes
        await h.teardown(h.volumeCreated);
      } catch (teardownErr: unknown) {
        errors.push(teardownErr instanceof Error ? teardownErr : new Error(String(teardownErr)));
      }
    }
    return errors;
  };

  try {
    // Start Alice container
    const aliceHandle = await containerAdapter.startUserRuntime({
      userId: 'alice',
      image: options.runtimeImage ?? process.env.ENKEEP_RUNTIME_IMAGE?.trim() ?? 'enkeep-demo-runtime:acceptance',
      repoRoot,
      dataRoot: options.dataRoot,
      mode: options.mode,
      resourceSuffix: options.resourceSuffix,
      timeoutMs: options.timeoutMs ?? 15000,
      llmEnabled: options.llmEnabled,
      llmProvider: options.llmProvider,
      llmModel: options.llmModel,
    });
    newlyCreatedHandles.push(aliceHandle);
    if (aliceHandle.meta) {
      containersList.push(aliceHandle.meta);
    }

    // If Alice has imported seed JSON files from demo:reset, install them into Alice container volume via official importSeed (REQUIRED / FAIL LOUD)
    if (existsSync(paths.importDir)) {
      const verifiedSeeds = loadAndVerifyFixedSeeds(paths.importDir, pathOptions);
      if (typeof aliceHandle.importSeed !== 'function') {
        throw new Error(`FAIL-CLOSED: Alice runtime container handle does not support importSeed`);
      }
      for (const { sessionId, seedEvents, receipt } of verifiedSeeds) {
        const importRes = await aliceHandle.importSeed(sessionId, seedEvents);
        if (importRes.status !== 'ok' && importRes.status !== 'completed' && importRes.status !== 'imported') {
          throw new Error(`FAIL-CLOSED: Seed import failed for session "${sessionId}": status ${importRes.status}`);
        }
        if (importRes.persisted !== true) {
          throw new Error(`FAIL-CLOSED: Seed import was not persisted for session "${sessionId}"`);
        }
        if (importRes.sessionId !== sessionId) {
          throw new Error(`FAIL-CLOSED: Seed import sessionId mismatch: expected "${sessionId}", got "${importRes.sessionId}"`);
        }
        if (
          !importRes.receipt ||
          importRes.receipt.algorithm !== receipt.algorithm ||
          importRes.receipt.checksum !== receipt.checksum ||
          importRes.receipt.canonicalBytes !== receipt.canonicalBytes ||
          importRes.receipt.eventCount !== receipt.eventCount
        ) {
          throw new Error(
            `FAIL-CLOSED: Seed import receipt mismatch for session "${sessionId}": expected ${JSON.stringify(receipt)}, got ${JSON.stringify(importRes.receipt)}`
          );
        }
        if (typeof importRes.duplicate !== 'boolean') {
          throw new Error(`FAIL-CLOSED: Seed import returned missing or non-boolean duplicate flag for session "${sessionId}"`);
        }
      }
    }

    // Start Bob container
    const bobHandle = await containerAdapter.startUserRuntime({
      userId: 'bob',
      image: options.runtimeImage ?? process.env.ENKEEP_RUNTIME_IMAGE?.trim() ?? 'enkeep-demo-runtime:acceptance',
      repoRoot,
      dataRoot: options.dataRoot,
      mode: options.mode,
      resourceSuffix: options.resourceSuffix,
      timeoutMs: options.timeoutMs ?? 15000,
      llmEnabled: options.llmEnabled,
      llmProvider: options.llmProvider,
      llmModel: options.llmModel,
    });
    newlyCreatedHandles.push(bobHandle);
    if (bobHandle.meta) {
      containersList.push(bobHandle.meta);
    }
  } catch (err: unknown) {
    // Fail-closed: Clean up any newly created containers immediately before throwing
    const teardownErrors = await cleanupStartupHandles(newlyCreatedHandles);
    const primaryError = err instanceof Error ? err : new Error(String(err));
    if (teardownErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...teardownErrors],
        `FAIL-CLOSED: User runtime container initialization failed:\n${primaryError.message}\nCleanup errors: ${teardownErrors.map((e) => e.message).join('; ')}`
      );
    }
    throw primaryError;
  }

  // 5. Connect Platform Storage and Message Store (Strictly validated non-symlink path and ancestors)
  validateSqliteDatabasePath(paths.dbPath, pathOptions);
  let db: DatabaseSync | null = null;
  let storage: SqlitePlatformStorage | null = null;
  let messageStore: SqliteWebMessageStore | null = null;
  let runtimeDiagnosticsService: RuntimeDiagnosticsService | null = null;
  let aliceAuthoritativeUser: import('@enkeep/platform-core').User | null = null;
  let bobAuthoritativeUser: import('@enkeep/platform-core').User | null = null;

  try {
    db = new DatabaseSync(paths.dbPath);
    validatePostOpenDatabasePath(paths.dbPath, pathOptions);

    // Fail-Closed Check for Legacy Host Execution Mode:
    // Disallow historical execution_mode='host' records in spaces or session_routes when allowHostRuntime is not explicitly enabled.
    // Never silently rewrite host to container (which changes execution semantics and could grant container execution unexpectedly),
    // and never execute on host without authorization. Preserves historical records intact for audit without mutating or deleting user data.
    const hostSpacesCount = (db.prepare("SELECT COUNT(*) as c FROM spaces WHERE execution_mode = 'host'").get() as { c: number }).c;
    const hostRoutesCount = (db.prepare("SELECT COUNT(*) as c FROM session_routes WHERE execution_mode = 'host'").get() as { c: number }).c;

    if (!allowHostRuntime && (hostSpacesCount > 0 || hostRoutesCount > 0)) {
      throw new Error(
        `FAIL-CLOSED: Legacy host execution mode detected in demo database (${hostSpacesCount} space(s), ${hostRoutesCount} route(s) with execution_mode='host'). ` +
        `Host execution is discontinued in demo environment and automatic conversion to container is forbidden to prevent semantic changes. ` +
        `Please run "pnpm run demo:reset" to reinitialize a clean container-only demo environment.`
      );
    }

    storage = new SqlitePlatformStorage(db);
    messageStore = new SqliteWebMessageStore(db);

    // Authoritative lookup of Alice and Bob DB user records
    const aliceUser = await storage.users.findByUsername('alice');
    if (!aliceUser || !aliceUser.id) {
      throw new Error('FAIL-CLOSED: Authoritative user record for alice not found in database');
    }
    const bobUser = await storage.users.findByUsername('bob');
    if (!bobUser || !bobUser.id) {
      throw new Error('FAIL-CLOSED: Authoritative user record for bob not found in database');
    }
    aliceAuthoritativeUser = aliceUser;
    bobAuthoritativeUser = bobUser;

    // Lark Test Opt-in Integration
    const larkCredsFile =
      options.larkTestCredentialsFile ?? process.env.ENKEEP_LARK_TEST_CREDENTIALS_FILE;
    if (larkCredsFile) {
      const larkCreds = loadLarkTestCredentials(larkCredsFile);
      const testEnv = await ensureLarkTestResources(storage, aliceUser.id, paths.spacesDir, larkCreds.appId);
      const expectedCredentialRef = getLarkTestCredentialRef(larkCreds.appId);

      if (!effectiveLarkCredentialResolver) {
        effectiveLarkCredentialResolver = createLarkTestCredentialResolver(larkCreds, aliceUser.id);
      }
      if (!effectiveLarkDefaultSpaceResolver) {
        effectiveLarkDefaultSpaceResolver = async (userId: string, account: import('@enkeep/platform-core').ChannelAccount) => {
          if (account.defaultSpaceId !== undefined) {
            return account.defaultSpaceId ?? undefined;
          }
          if (userId === aliceUser.id && account.credentialRef === expectedCredentialRef) {
            return testEnv.space.id;
          }
          return undefined;
        };
      }
    }

    const aliceHandle = newlyCreatedHandles[0];
    const bobHandle = newlyCreatedHandles[1];

    // Key runtimeHandles strictly by authoritative DB user ID (never usernames)
    runtimeHandles.set(aliceUser.id, aliceHandle);
    runtimeHandles.set(bobUser.id, bobHandle);

    // Instantiate and record initial startup diagnostics for Alice and Bob
    runtimeDiagnosticsService = new RuntimeDiagnosticsService({ db });
    try {
      if (aliceHandle) {
        await runtimeDiagnosticsService.recordDiagnostic({
          userId: aliceUser.id,
          containerId: aliceHandle.meta?.containerId ?? null,
          eventType: 'lifecycle_start',
          level: 'info',
          code: 'CONTAINER_START_SUCCESS',
          details: { username: aliceUser.username },
        });
      }
      if (bobHandle) {
        await runtimeDiagnosticsService.recordDiagnostic({
          userId: bobUser.id,
          containerId: bobHandle.meta?.containerId ?? null,
          eventType: 'lifecycle_start',
          level: 'info',
          code: 'CONTAINER_START_SUCCESS',
          details: { username: bobUser.username },
        });
      }
    } catch {}

    // Validate Alice and Bob EACH have exactly 5 explicit quota_limits metrics (exact 10 rows in DB total), exact finite nonnegative (no count-only)
    const expectedQuotaMetrics = ['turns', 'messages', 'tokens', 'storage_bytes', 'api_calls'] as const;
    const totalQuotaRows = (db.prepare('SELECT COUNT(*) as c FROM quota_limits').get() as { c: number }).c;
    if (totalQuotaRows < 10 || totalQuotaRows % 5 !== 0) {
      throw new Error(
        `FAIL-CLOSED: Missing quota limits configuration in demo database (expected at least 10 rows matching 5 per user, got ${totalQuotaRows}). ` +
        `Please run "pnpm run demo:reset" to reinitialize a clean demo database with explicit demo quota limits.`
      );
    }
    for (const user of [aliceUser, bobUser]) {
      const rows = db.prepare('SELECT resource, limit_amount FROM quota_limits WHERE user_id = ?').all(user.id) as Array<{ resource: string; limit_amount: number }>;
      if (rows.length === 0) {
        throw new Error(
          `FAIL-CLOSED: Missing quota limits configuration in demo database for user "${user.username}". ` +
          `Unconfigured quota under fail_closed policy blocks all turn execution. ` +
          `Please run "pnpm run demo:reset" to reinitialize a clean demo database with explicit demo quota limits.`
        );
      }
      if (rows.length !== expectedQuotaMetrics.length) {
        throw new Error(
          `FAIL-CLOSED: Missing quota limits configuration in demo database for user "${user.username}". ` +
          `Found ${rows.length} configured metrics; exactly ${expectedQuotaMetrics.length} explicit metrics (${expectedQuotaMetrics.join(', ')}) required. ` +
          `Please run "pnpm run demo:reset" to reinitialize a clean demo database with explicit demo quota limits.`
        );
      }
      const metricMap = new Map<string, number>();
      for (const row of rows) {
        if (metricMap.has(row.resource)) {
          throw new Error(`FAIL-CLOSED: Duplicate quota metric "${row.resource}" for user "${user.username}".`);
        }
        if (typeof row.limit_amount !== 'number' || !Number.isFinite(row.limit_amount) || (row.limit_amount < 0 && row.limit_amount !== -1)) {
          throw new Error(
            `FAIL-CLOSED: Quota limit for metric "${row.resource}" on user "${user.username}" is invalid (${row.limit_amount}); must be a finite nonnegative number or -1 for unlimited.`
          );
        }
        metricMap.set(row.resource, row.limit_amount);
      }
      for (const expectedMetric of expectedQuotaMetrics) {
        if (!metricMap.has(expectedMetric)) {
          throw new Error(
            `FAIL-CLOSED: Missing required quota limit metric "${expectedMetric}" for user "${user.username}". ` +
            `Please run "pnpm run demo:reset" to reinitialize a clean demo database with explicit demo quota limits.`
          );
        }
      }
    }

    // Discover all active DB users and initialize/reconnect their runtime containers (one user, one runtime)
    const allActiveUsers = db.prepare("SELECT id, username, status, role FROM users WHERE status = 'active'").all() as Array<{ id: string; username: string; status: string; role: string }>;
    for (const u of allActiveUsers) {
      if (runtimeHandles.has(u.id)) continue;
      const runtimeIdentity = deriveRuntimeIdentity(u.id, u.username);
      const userHandle = await containerAdapter.startUserRuntime({
        userId: runtimeIdentity,
        image: options.runtimeImage ?? process.env.ENKEEP_RUNTIME_IMAGE?.trim() ?? 'enkeep-demo-runtime:acceptance',
        repoRoot,
        dataRoot: options.dataRoot,
        mode: options.mode,
        resourceSuffix: options.resourceSuffix,
        timeoutMs: options.timeoutMs ?? 15000,
        llmEnabled: options.llmEnabled,
        llmProvider: options.llmProvider,
        llmModel: options.llmModel,
      });
      newlyCreatedHandles.push(userHandle);
      if (userHandle.meta) {
        containersList.push(userHandle.meta);
      }
      runtimeHandles.set(u.id, userHandle);
      try {
        if (runtimeDiagnosticsService) {
          await runtimeDiagnosticsService.recordDiagnostic({
            userId: u.id,
            containerId: userHandle.meta?.containerId ?? null,
            eventType: 'lifecycle_start',
            level: 'info',
            code: 'CONTAINER_START_SUCCESS',
            details: { username: u.username },
          });
        }
      } catch {}
    }
  } catch (err: unknown) {
    const teardownErrs = await cleanupStartupHandles(newlyCreatedHandles);
    if (storage) {
      try {
        await storage.close();
      } catch (storageErr: unknown) {
        teardownErrs.push(storageErr instanceof Error ? storageErr : new Error(String(storageErr)));
      }
    } else if (db) {
      try {
        db.close();
      } catch (dbErr: unknown) {
        teardownErrs.push(dbErr instanceof Error ? dbErr : new Error(String(dbErr)));
      }
    }
    const primary = err instanceof Error ? err : new Error(String(err));
    if (teardownErrs.length > 0) {
      throw new AggregateError(
        [primary, ...teardownErrs],
        `FAIL-CLOSED: Database/storage initialization failed:\n${primary.message}\nCleanup errors: ${teardownErrs.map((e) => e.message).join('; ')}`
      );
    }
    throw primary;
  }

  // Per-user singleflight map for dynamic runtime provisioning
  const pendingRuntimeStarts = new Map<string, Promise<UserRuntimeHandle>>();
  const pendingHostRuntimeStarts = new Map<string, Promise<UserRuntimeHandle>>();

  // Helper: lazily provision / boot user host runtime on-demand with per-user singleflight mutex
  async function ensureUserHostRuntime(rawUserId: string): Promise<UserRuntimeHandle> {
    if (!rawUserId || typeof rawUserId !== 'string' || rawUserId.trim().length === 0) {
      throw new Error('FAIL-CLOSED: Missing or invalid userId for host user handle resolution');
    }
    const existing = hostRuntimeHandles.get(rawUserId);
    if (existing) {
      const rawHandle = (existing as any).rawHandle;
      const pid = rawHandle?.pid;
      if (pid && isProcessAlive(pid)) {
        return existing;
      }
      // Process is not alive, evict stale handle
      hostRuntimeHandles.delete(rawUserId);
    }

    const inFlight = pendingHostRuntimeStarts.get(rawUserId);
    if (inFlight) {
      return inFlight;
    }

    const startPromise = (async () => {
      try {
        const userRecord = await storage!.users.findById(rawUserId);
        if (!userRecord || !userRecord.id) {
          throw new Error(`FAIL-CLOSED: User "${rawUserId}" is not a canonical platform user`);
        }
        if (userRecord.status === 'disabled') {
          throw new Error(`FAIL-CLOSED: Cannot start host runtime for disabled user "${userRecord.username}" (${rawUserId})`);
        }

        const handle = await hostAdapter.startUserRuntime({
          userId: userRecord.username,
          repoRoot,
          dataRoot: options.dataRoot,
          mode: options.mode,
          resourceSuffix: options.resourceSuffix,
          timeoutMs: options.timeoutMs ?? 20000,
          llmEnabled: options.llmEnabled,
          llmProvider: options.llmProvider,
          llmModel: options.llmModel,
          browserService,
        });

        // Phase 2 Binding: Bind full platform proxy & events stream handlers with authoritative user UUID
        await bindRuntimeServices(handle, userRecord.id);

        hostRuntimeHandles.set(userRecord.id, handle);
        return handle;
      } finally {
        pendingHostRuntimeStarts.delete(rawUserId);
      }
    })();

    pendingHostRuntimeStarts.set(rawUserId, startPromise);
    return startPromise;
  }

  // Helper: lazily provision / boot user runtime container on-demand with per-user singleflight mutex
  async function ensureUserRuntime(rawUserId: string): Promise<UserRuntimeHandle> {
    if (!rawUserId || typeof rawUserId !== 'string' || rawUserId.trim().length === 0) {
      throw new Error('FAIL-CLOSED: Missing or invalid userId for user handle resolution');
    }
    const existing = runtimeHandles.get(rawUserId);
    if (existing) {
      return existing;
    }

    const inFlight = pendingRuntimeStarts.get(rawUserId);
    if (inFlight) {
      return inFlight;
    }

    const startPromise = (async () => {
      try {
        const userRecord = await storage!.users.findById(rawUserId);
        if (!userRecord || !userRecord.id) {
          throw new Error(`FAIL-CLOSED: User "${rawUserId}" is not a canonical platform user`);
        }
        if (userRecord.status === 'disabled') {
          throw new Error(`FAIL-CLOSED: Cannot start runtime for disabled user "${userRecord.username}" (${rawUserId})`);
        }

        const runtimeIdentity = deriveRuntimeIdentity(userRecord.id, userRecord.username);

        const handle = await containerAdapter.startUserRuntime({
          userId: runtimeIdentity,
          image: options.runtimeImage ?? process.env.ENKEEP_RUNTIME_IMAGE?.trim() ?? 'enkeep-demo-runtime:acceptance',
          repoRoot,
          dataRoot: options.dataRoot,
          mode: options.mode,
          resourceSuffix: options.resourceSuffix,
          timeoutMs: options.timeoutMs ?? 15000,
        });

        // Phase 2 Binding: Bind full platform proxy & events stream handlers with authoritative user UUID
        await bindRuntimeServices(handle, userRecord.id);

        const health = await handle.checkHealth();
        if (health.status !== 'ok') {
          throw new Error(
            `FAIL-CLOSED: User runtime container for "${userRecord.username}" health check returned status "${health.status}"`
          );
        }
        if (health.toolsOperational !== true) {
          throw new Error(
            `FAIL-CLOSED: User runtime container for "${userRecord.username}" toolsOperational is not true (reason: ${health.toolsUnavailableReason ?? 'unknown'})`
          );
        }

        runtimeHandles.set(userRecord.id, handle);
        try {
          if (runtimeDiagnosticsService) {
            await runtimeDiagnosticsService.recordDiagnostic({
              userId: userRecord.id,
              containerId: handle.meta?.containerId ?? null,
              eventType: 'lifecycle_start',
              level: 'info',
              code: 'CONTAINER_START_SUCCESS',
              details: { username: userRecord.username },
            });
          }
        } catch {}
        return handle;
      } finally {
        pendingRuntimeStarts.delete(rawUserId);
      }
    })();

    pendingRuntimeStarts.set(rawUserId, startPromise);
    return startPromise;
  }

  // Helper: exact user handle resolution via canonical user ID (exact map get or lazy on-demand ensure)
  async function resolveUserHandle(rawUserId: string): Promise<UserRuntimeHandle> {
    if (!rawUserId || typeof rawUserId !== 'string' || rawUserId.trim().length === 0) {
      throw new Error('FAIL-CLOSED: Missing or invalid userId for user handle resolution');
    }
    const handle = runtimeHandles.get(rawUserId);
    if (handle) {
      return handle;
    }
    return ensureUserRuntime(rawUserId);
  }

  // Helper: resolve runtime handle and space folder according to space execution mode
  async function resolveRuntimeForSpace(
    userId: string,
    platformSpaceId: string,
    requestWorkspaceFolder?: string
  ): Promise<{ handle: UserRuntimeHandle; isHost: boolean; spaceFolder: string }> {
    const spaceRow = db!.prepare(
      'SELECT id, user_id, status, folder, execution_mode FROM spaces WHERE (id = ? OR folder = ?) AND user_id = ?'
    ).get(platformSpaceId, platformSpaceId, userId) as { id: string; user_id: string; status: string; folder: string; execution_mode: string } | undefined;

    if (!spaceRow) {
      throw new Error(`FAIL-CLOSED: Space "${platformSpaceId}" not found for user "${userId}"`);
    }
    if (spaceRow.status !== 'active') {
      throw new Error(`FAIL-CLOSED: Space "${platformSpaceId}" is not active (status: ${spaceRow.status}) for user "${userId}"`);
    }
    if (!spaceRow.folder || typeof spaceRow.folder !== 'string' || spaceRow.folder.trim().length === 0) {
      throw new Error(`FAIL-CLOSED: Space "${platformSpaceId}" has no valid canonical folder for user "${userId}"`);
    }

    const spaceFolder = requestWorkspaceFolder || spaceRow.folder;
    const isHost = spaceRow.execution_mode === 'host';

    const handle = isHost ? await ensureUserHostRuntime(userId) : await resolveUserHandle(userId);
    return { handle, isHost, spaceFolder };
  }

  // 6. Production DeliveryTurnExecutor wired to real Docker User Containers
  const dockerTurnExecutor: DeliveryTurnExecutor = {
    async execute(request: DeliveryExecutionRequest) {
      const {
        userId,
        platformSpaceId,
        workspaceFolder: requestWorkspaceFolder,
        dshSessionId,
        turnId,
        content,
        attachments,
        profile,
      } = request;

      if (!dshSessionId || typeof dshSessionId !== 'string' || dshSessionId.trim().length === 0) {
        throw new Error('FAIL-CLOSED: Mandatory dshSessionId missing or empty in DeliveryTurnExecutor.execute');
      }
      if (!turnId || typeof turnId !== 'string' || turnId.trim().length === 0) {
        throw new Error('FAIL-CLOSED: Mandatory turnId missing or empty in DeliveryTurnExecutor.execute');
      }
      if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
        throw new Error('FAIL-CLOSED: Missing target userId in DeliveryExecutionRequest for DeliveryTurnExecutor.execute');
      }
      if (!platformSpaceId || typeof platformSpaceId !== 'string' || platformSpaceId.trim().length === 0) {
        throw new Error('FAIL-CLOSED: Missing platformSpaceId in DeliveryExecutionRequest for DeliveryTurnExecutor.execute');
      }

      const { handle: userHandle, isHost, spaceFolder } = await resolveRuntimeForSpace(
        userId,
        platformSpaceId,
        requestWorkspaceFolder
      );

      // Ensure space directory exists on the user volume before executing turn (idempotent mkdir)
      try {
        await userHandle.fileOperation({
          op: 'mkdir',
          space: spaceFolder,
          path: '.',
          requireAbsent: true,
        });
      } catch (mkdirErr: unknown) {
        const errCode = (mkdirErr as { code?: unknown })?.code;
        if (
          errCode === 'HOST_RUNTIME_EXITED' ||
          errCode === 'HOST_TRANSPORT_ERROR' ||
          errCode === 'HOST_DAEMON_ERROR' ||
          errCode === 'HOST_NOT_FOUND'
        ) {
          throw mkdirErr;
        }
        // Space directory already exists, proceed
      }

      const prompt = extractEnvelopePrompt(content);

      // Resolve space-specific mounts from request.mounts or fallback to activeUserMountsByMode
      let spaceMountSpecs: readonly RuntimeMountSpec[] | undefined = request.mounts;
      if (!spaceMountSpecs) {
        const key = `${userId}:${isHost ? 'host' : 'container'}`;
        const userMounts = activeUserMountsByMode.get(key);
        if (userMounts) {
          spaceMountSpecs = userMounts[platformSpaceId] ?? userMounts[spaceFolder];
        }
      }

      const res = await userHandle.sendTurn({
        prompt,
        sessionId: dshSessionId,
        turnId,
        profileSnapshot: profile ?? null,
        workspaceFolder: spaceFolder,
        attachments,
        modelSelection: request.modelSelection ?? null,
        mounts: spaceMountSpecs,
        extensionPlan: request.extensionPlan ?? null,
      });
      if (typeof res.replyText !== 'string' || res.replyText.trim().length === 0) {
        throw new Error('FAIL-CLOSED: DSH runtime returned empty or invalid replyText');
      }
      if (res.persisted !== true) {
        throw new Error('FAIL-CLOSED: DSH runtime turn was not persisted');
      }

      const metadata: Record<string, unknown> = {
        persisted: true,
      };
      if (typeof res.eventsCount === 'number') {
        metadata.eventsCount = res.eventsCount;
      }

      let totalTokens: number;
      if (res.usage && typeof res.usage.totalTokens === 'number' && Number.isSafeInteger(res.usage.totalTokens) && res.usage.totalTokens >= 0) {
        totalTokens = res.usage.totalTokens;
      } else {
        totalTokens = Math.max(1, Math.ceil(Buffer.byteLength(res.replyText, 'utf8') / 4));
      }

      if (res.routeAttempts && Array.isArray(res.routeAttempts)) {
        for (const attempt of res.routeAttempts) {
          try {
            await modelSelectionService.recordHealth({
              provider: attempt.provider,
              model: attempt.model,
              latencyMs: attempt.latencyMs,
              statusCode: attempt.statusCode,
              success: attempt.success,
              errorType: attempt.errorType,
            });
          } catch {}
        }
      }

      return {
        replyText: res.replyText,
        metadata,
        usage: {
          totalTokens,
        },
      };
    },
    async cancel(userId, turnId) {
      if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
        throw new Error('FAIL-CLOSED: Mandatory userId missing or empty in DeliveryTurnExecutor.cancel');
      }
      if (!turnId || typeof turnId !== 'string' || turnId.trim().length === 0) {
        throw new Error('FAIL-CLOSED: Mandatory turnId missing or empty in DeliveryTurnExecutor.cancel');
      }

      let cancelled = false;
      let hostHandle = hostRuntimeHandles.get(userId);
      if (!hostHandle && options.allowHostRuntime) {
        const hostSpace = db!.prepare(
          "SELECT 1 FROM spaces WHERE user_id = ? AND execution_mode = 'host' LIMIT 1"
        ).get(userId);
        if (hostSpace) {
          try {
            hostHandle = await ensureUserHostRuntime(userId);
          } catch {}
        }
      }

      if (hostHandle && typeof hostHandle.cancelTurn === 'function') {
        try {
          const res = await hostHandle.cancelTurn(turnId);
          if (res && res.status === 'cancelled') {
            cancelled = true;
          }
        } catch {}
      }

      if (!cancelled) {
        const userHandle = await resolveUserHandle(userId);
        if (typeof userHandle.cancelTurn !== 'function') {
          throw new Error(`FAIL-CLOSED: User runtime handle for "${userId}" does not support cancelTurn`);
        }
        const cancelRes = await userHandle.cancelTurn(turnId);
        if (cancelRes.status !== 'cancelled') {
          throw new Error(`FAIL-CLOSED: DeliveryTurnExecutor.cancel returned non-cancelled status "${cancelRes.status}" for turn "${turnId}"`);
        }
        if (typeof cancelRes.turnId !== 'string' || cancelRes.turnId.trim().length === 0) {
          throw new Error(`FAIL-CLOSED: DeliveryTurnExecutor.cancel returned missing or empty turnId for turn "${turnId}"`);
        }
      }
      return true;
    },
    async inspectTurnResult(query: { userId: string; turnId: string; dshSessionId: string }) {
      const { userId, turnId } = query;
      if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
        throw new Error('FAIL-CLOSED: Mandatory userId missing or empty in DeliveryTurnExecutor.inspectTurnResult');
      }
      if (!turnId || typeof turnId !== 'string' || turnId.trim().length === 0) {
        throw new Error('FAIL-CLOSED: Mandatory turnId missing or empty in DeliveryTurnExecutor.inspectTurnResult');
      }

      let hostHandle = hostRuntimeHandles.get(userId);
      if (!hostHandle && options.allowHostRuntime) {
        const hostSpace = db!.prepare(
          "SELECT 1 FROM spaces WHERE user_id = ? AND execution_mode = 'host' LIMIT 1"
        ).get(userId);
        if (hostSpace) {
          try {
            hostHandle = await ensureUserHostRuntime(userId);
          } catch {}
        }
      }

      if (hostHandle && typeof hostHandle.inspectTurnResult === 'function') {
        try {
          const inspected = await hostHandle.inspectTurnResult(turnId);
          if (inspected && inspected.status !== 'absent') {
            if (inspected.status === 'completed' && inspected.replyText) {
              return {
                status: 'completed' as const,
                result: {
                  replyText: inspected.replyText,
                },
              };
            }
            if (inspected.status === 'failed') {
              return {
                status: 'failed' as const,
                errorCode: 'EXECUTION_FAILED' as const,
              };
            }
            if (inspected.status === 'running') {
              return {
                status: 'running' as const,
              };
            }
          }
        } catch {}
      }

      const userHandle = await resolveUserHandle(userId);
      if (typeof userHandle.inspectTurnResult !== 'function') {
        return { status: 'absent' as const };
      }
      const inspected = await userHandle.inspectTurnResult(turnId);
      if (inspected.status === 'completed' && inspected.replyText) {
        return {
          status: 'completed' as const,
          result: {
            replyText: inspected.replyText,
          },
        };
      }
      if (inspected.status === 'failed') {
        return {
          status: 'failed' as const,
          errorCode: 'EXECUTION_FAILED' as const,
        };
      }
      if (inspected.status === 'running') {
        return {
          status: 'running' as const,
        };
      }
      return {
        status: 'absent' as const,
      };
    },
  };

  // 6b. Platform Operations & Multi-Metric Quota Provider Setup
  const operationsStorage = new SqlitePlatformOperationsStorage(db, {
    quotaOptions: { unconfiguredPolicy: 'fail_closed' },
  });
  const operationsService = createPlatformOperations({
    storage: operationsStorage,
  });
  const quotaProvider = createOperationsTenantQuotaProvider(operationsService);
  const profileService = createProfileService(storage, db);
  const modelSelectionService = new ModelSelectionService({
    db,
    operations: operationsService,
  });

  // 6c. Tenant Runtime File Provider wired to real Docker User Containers & Host Runtimes
  const demoFileProvider: TenantRuntimeFileProvider & {
    importSeed?: (
      userId: string,
      sessionId: string,
      events: readonly unknown[],
      receipt?: any,
      profile?: any,
      workspaceFolder?: string
    ) => Promise<any>;
  } = {
    async execute(
      userId: string,
      spaceId: string,
      request: CanonicalFileOperationRequest
    ): Promise<CanonicalFileOperationResult> {
      if (!userId || typeof userId !== 'string' || !spaceId || typeof spaceId !== 'string') {
        throw new ValidationError('Invalid userId or spaceId for file operation');
      }
      const spaceRow = db!.prepare(
        'SELECT id, user_id, status, folder, execution_mode FROM spaces WHERE (id = ? OR folder = ?) AND user_id = ?'
      ).get(spaceId, spaceId, userId) as { id: string; user_id: string; status: string; folder: string; execution_mode: string } | undefined;

      if (!spaceRow) {
        throw new NotFoundError(`Space "${spaceId}" not found for user "${userId}"`);
      }
      if (spaceRow.status !== 'active') {
        throw new PlatformError(`Space "${spaceId}" is not active (status: ${spaceRow.status})`, 'SPACE_INACTIVE', 400);
      }
      if (spaceRow.execution_mode !== 'container' && spaceRow.execution_mode !== 'host') {
        throw new PlatformError(`Space "${spaceId}" has invalid execution mode "${spaceRow.execution_mode}"`, 'INVALID_EXECUTION_MODE', 400);
      }
      const userHandle = spaceRow.execution_mode === 'host'
        ? await ensureUserHostRuntime(userId)
        : await resolveUserHandle(userId);

      if (typeof userHandle.fileOperation !== 'function') {
        throw new PlatformError(`User runtime handle does not support fileOperation`, 'NOT_SUPPORTED', 500);
      }

      let targetSpaceFolder: string | undefined = undefined;
      if (typeof (request as any).targetSpace === 'string' && (request as any).targetSpace.trim()) {
        const rawTarget = (request as any).targetSpace.trim();
        const targetRow = db!.prepare(
          'SELECT folder FROM spaces WHERE (id = ? OR folder = ?) AND user_id = ?'
        ).get(rawTarget, rawTarget, userId) as { folder: string } | undefined;
        targetSpaceFolder = targetRow ? targetRow.folder : rawTarget;
      }

      const rawRes = await userHandle.fileOperation({
        ...request,
        space: spaceRow.folder,
        ...(targetSpaceFolder ? { targetSpace: targetSpaceFolder } : {}),
      } as any);
      if (rawRes.status !== 'ok' && rawRes.status !== 'completed') {
        const errCode = rawRes.code || rawRes.error;
        throw mapFileOpError({ code: errCode });
      }
      const fileRes = (rawRes.fileResult ?? (rawRes as any).data ?? rawRes) as unknown as CanonicalFileOperationResult;
      return fileRes;
    },

    async writeBinaryStream(
      userId: string,
      spaceId: string,
      request: any,
      inStream: NodeJS.ReadableStream
    ): Promise<any> {
      if (!userId || typeof userId !== 'string' || !spaceId || typeof spaceId !== 'string') {
        throw new ValidationError('Invalid userId or spaceId for file operation');
      }
      const spaceRow = db!.prepare(
        'SELECT id, user_id, status, folder, execution_mode FROM spaces WHERE (id = ? OR folder = ?) AND user_id = ?'
      ).get(spaceId, spaceId, userId) as { id: string; user_id: string; status: string; folder: string; execution_mode: string } | undefined;

      if (!spaceRow) {
        throw new NotFoundError(`Space "${spaceId}" not found for user "${userId}"`);
      }
      if (spaceRow.status !== 'active') {
        throw new PlatformError(`Space "${spaceId}" is not active (status: ${spaceRow.status})`, 'SPACE_INACTIVE', 400);
      }
      const userHandle = spaceRow.execution_mode === 'host'
        ? await ensureUserHostRuntime(userId)
        : await resolveUserHandle(userId);

      const rawHandle = userHandle.rawHandle;
      if (rawHandle && typeof rawHandle.fileWriteStream === 'function') {
        const rawRes = await rawHandle.fileWriteStream({
          space: spaceRow.folder,
          path: request.path,
          expectedEtag: request.expectedEtag,
          requireAbsent: request.requireAbsent,
          maxSizeBytes: request.maxSizeBytes,
        }, inStream);
        if (rawRes.status !== 'ok' && rawRes.status !== 'completed') {
          throw new PlatformError(
            `File streaming write failed in runtime: status=${rawRes.status}${rawRes.error ? ` (${rawRes.error})` : ''}`,
            'FILE_OPERATION_FAILED',
            500
          );
        }
        return { type: 'file', ...rawRes.fileResult };
      }
      // Fallback
      throw new PlatformError(`User runtime handle does not support fileWriteStream`, 'NOT_SUPPORTED', 500);
    },

    async readBinaryStream(
      userId: string,
      spaceId: string,
      request: any
    ): Promise<any> {
      if (!userId || typeof userId !== 'string' || !spaceId || typeof spaceId !== 'string') {
        throw new ValidationError('Invalid userId or spaceId for file operation');
      }
      const spaceRow = db!.prepare(
        'SELECT id, user_id, status, folder, execution_mode FROM spaces WHERE (id = ? OR folder = ?) AND user_id = ?'
      ).get(spaceId, spaceId, userId) as { id: string; user_id: string; status: string; folder: string; execution_mode: string } | undefined;

      if (!spaceRow) {
        throw new NotFoundError(`Space "${spaceId}" not found for user "${userId}"`);
      }
      if (spaceRow.status !== 'active') {
        throw new PlatformError(`Space "${spaceId}" is not active (status: ${spaceRow.status})`, 'SPACE_INACTIVE', 400);
      }
      const userHandle = spaceRow.execution_mode === 'host'
        ? await ensureUserHostRuntime(userId)
        : await resolveUserHandle(userId);

      const rawHandle = userHandle.rawHandle;
      if (rawHandle && typeof rawHandle.fileReadStream === 'function') {
        try {
          const { metadata, stream } = await rawHandle.fileReadStream({
            space: spaceRow.folder,
            path: request.path,
            range: request.range,
          });
          return {
            op: 'read',
            path: metadata.path,
            type: 'file',
            size: metadata.size,
            totalSize: (metadata as any).totalSize ?? metadata.size,
            mtimeMs: metadata.mtimeMs,
            etag: metadata.etag,
            range: (metadata as any).range,
            stream,
          };
        } catch (readErr: unknown) {
          console.error('READ STREAM IN RUNTIME FAILED:', readErr);
          throw readErr;
        }
      }
      throw new PlatformError(`User runtime handle does not support fileReadStream`, 'NOT_SUPPORTED', 500);
    },

    async stageBinaryStream(
      userId: string,
      spaceId: string,
      request: any,
      inStream: NodeJS.ReadableStream
    ): Promise<any> {
      if (!userId || typeof userId !== 'string' || !spaceId || typeof spaceId !== 'string') {
        throw new ValidationError('Invalid userId or spaceId for file operation');
      }
      const spaceRow = db!.prepare(
        'SELECT id, user_id, status, folder, execution_mode FROM spaces WHERE (id = ? OR folder = ?) AND user_id = ?'
      ).get(spaceId, spaceId, userId) as { id: string; user_id: string; status: string; folder: string; execution_mode: string } | undefined;

      if (!spaceRow) {
        throw new NotFoundError(`Space "${spaceId}" not found for user "${userId}"`);
      }
      if (spaceRow.status !== 'active') {
        throw new PlatformError(`Space "${spaceId}" is not active (status: ${spaceRow.status})`, 'SPACE_INACTIVE', 400);
      }
      const userHandle = spaceRow.execution_mode === 'host'
        ? await ensureUserHostRuntime(userId)
        : await resolveUserHandle(userId);

      const rawHandle = userHandle.rawHandle;
      if (rawHandle && typeof rawHandle.fileStageStream === 'function') {
        const stageRes = await rawHandle.fileStageStream({
          space: spaceRow.folder,
          path: request.path,
          maxSizeBytes: request.maxSizeBytes,
        }, inStream);
        return {
          op: 'stage',
          path: stageRes.path,
          stageToken: stageRes.stageToken,
          size: stageRes.size,
          sha256: stageRes.sha256,
          etag: stageRes.etag,
        };
      }
      throw new PlatformError(`User runtime handle does not support fileStageStream`, 'NOT_SUPPORTED', 500);
    },

    async commitStage(
      userId: string,
      spaceId: string,
      request: any
    ): Promise<any> {
      if (!userId || typeof userId !== 'string' || !spaceId || typeof spaceId !== 'string') {
        throw new ValidationError('Invalid userId or spaceId for file operation');
      }
      const spaceRow = db!.prepare(
        'SELECT id, user_id, status, folder, execution_mode FROM spaces WHERE (id = ? OR folder = ?) AND user_id = ?'
      ).get(spaceId, spaceId, userId) as { id: string; user_id: string; status: string; folder: string; execution_mode: string } | undefined;

      if (!spaceRow) {
        throw new NotFoundError(`Space "${spaceId}" not found for user "${userId}"`);
      }
      if (spaceRow.status !== 'active') {
        throw new PlatformError(`Space "${spaceId}" is not active (status: ${spaceRow.status})`, 'SPACE_INACTIVE', 400);
      }
      const userHandle = spaceRow.execution_mode === 'host'
        ? await ensureUserHostRuntime(userId)
        : await resolveUserHandle(userId);

      const rawHandle = userHandle.rawHandle;
      if (rawHandle && typeof rawHandle.fileCommitStage === 'function') {
        const res = await rawHandle.fileCommitStage({
          space: spaceRow.folder,
          path: request.path,
          stageToken: request.stageToken,
          rollbackToken: request.rollbackToken,
          expectedEtag: request.expectedEtag,
          requireAbsent: request.requireAbsent,
        });
        return { type: 'file', ...res };
      }
      throw new PlatformError(`User runtime handle does not support fileCommitStage`, 'NOT_SUPPORTED', 500);
    },

    async abortStage(
      userId: string,
      spaceId: string,
      request: any
    ): Promise<void> {
      if (!userId || typeof userId !== 'string' || !spaceId || typeof spaceId !== 'string') return;
      const spaceRow = db!.prepare(
        'SELECT folder, execution_mode FROM spaces WHERE (id = ? OR folder = ?) AND user_id = ?'
      ).get(spaceId, spaceId, userId) as { folder: string; execution_mode: string } | undefined;
      if (!spaceRow) return;

      const userHandle = spaceRow.execution_mode === 'host'
        ? await ensureUserHostRuntime(userId)
        : await resolveUserHandle(userId);

      const rawHandle = userHandle.rawHandle;
      if (rawHandle && typeof rawHandle.fileAbortStage === 'function') {
        await rawHandle.fileAbortStage({
          space: spaceRow.folder,
          path: request.path,
          stageToken: request.stageToken,
        });
      }
    },

    async finalizeStage(
      userId: string,
      spaceId: string,
      request: any
    ): Promise<void> {
      if (!userId || typeof userId !== 'string' || !spaceId || typeof spaceId !== 'string') return;
      const spaceRow = db!.prepare(
        'SELECT folder, execution_mode FROM spaces WHERE (id = ? OR folder = ?) AND user_id = ?'
      ).get(spaceId, spaceId, userId) as { folder: string; execution_mode: string } | undefined;
      if (!spaceRow) return;

      const userHandle = spaceRow.execution_mode === 'host'
        ? await ensureUserHostRuntime(userId)
        : await resolveUserHandle(userId);

      const rawHandle = userHandle.rawHandle;
      if (rawHandle && typeof rawHandle.fileFinalizeStage === 'function') {
        await rawHandle.fileFinalizeStage({
          space: spaceRow.folder,
          path: request.path,
          rollbackToken: request.rollbackToken,
        });
      }
    },

    async rollbackCommit(
      userId: string,
      spaceId: string,
      request: any
    ): Promise<void> {
      if (!userId || typeof userId !== 'string' || !spaceId || typeof spaceId !== 'string') return;
      const spaceRow = db!.prepare(
        'SELECT folder, execution_mode FROM spaces WHERE (id = ? OR folder = ?) AND user_id = ?'
      ).get(spaceId, spaceId, userId) as { folder: string; execution_mode: string } | undefined;
      if (!spaceRow) return;

      const userHandle = spaceRow.execution_mode === 'host'
        ? await ensureUserHostRuntime(userId)
        : await resolveUserHandle(userId);

      const rawHandle = userHandle.rawHandle;
      if (rawHandle && typeof rawHandle.fileRollbackCommit === 'function') {
        await rawHandle.fileRollbackCommit({
          space: spaceRow.folder,
          path: request.path,
          rollbackToken: request.rollbackToken,
          stageToken: request.stageToken,
          expectedEtag: request.expectedEtag,
        });
      }
    },

    async inspectTransferState(
      userId: string,
      spaceId: string,
      request: any
    ): Promise<any> {
      if (!userId || typeof userId !== 'string' || !spaceId || typeof spaceId !== 'string') {
        throw new ValidationError('Invalid userId or spaceId for file operation');
      }
      const spaceRow = db!.prepare(
        'SELECT id, user_id, status, folder, execution_mode FROM spaces WHERE (id = ? OR folder = ?) AND user_id = ?'
      ).get(spaceId, spaceId, userId) as { id: string; user_id: string; status: string; folder: string; execution_mode: string } | undefined;

      if (!spaceRow) {
        throw new NotFoundError(`Space "${spaceId}" not found for user "${userId}"`);
      }
      if (spaceRow.status !== 'active') {
        throw new PlatformError(`Space "${spaceId}" is not active (status: ${spaceRow.status})`, 'SPACE_INACTIVE', 400);
      }
      const userHandle = spaceRow.execution_mode === 'host'
        ? await ensureUserHostRuntime(userId)
        : await resolveUserHandle(userId);

      const rawHandle = userHandle.rawHandle;
      if (rawHandle && typeof rawHandle.fileInspectTransferState === 'function') {
        const res = await rawHandle.fileInspectTransferState({
          space: spaceRow.folder,
          path: request.path,
          stageToken: request.stageToken,
          rollbackToken: request.rollbackToken,
          expectedContentSha256: request.contentSha256 || request.expectedContentSha256,
          overwrite: request.overwrite,
        });
        return res as CanonicalInspectTransferStateResult;
      }
      throw new PlatformError(`User runtime handle does not support fileInspectTransferState`, 'NOT_SUPPORTED', 500);
    },

    async readGlobalInstructions(
      userId: string
    ): Promise<{ content: string; etag: string | null; size: number; mtimeMs: number; exists: boolean }> {
      if (!userId || typeof userId !== 'string') {
        throw new ValidationError('Invalid userId for instructions operation');
      }
      const userHandle = hostRuntimeHandles.has(userId)
        ? hostRuntimeHandles.get(userId)!
        : await resolveUserHandle(userId);

      const rawHandle = userHandle.rawHandle ?? userHandle;
      if (rawHandle && typeof rawHandle.instructionsRead === 'function') {
        const rawRes = await rawHandle.instructionsRead({ target: 'global' });
        if (rawRes.status !== 'ok' && rawRes.status !== 'completed') {
          const errCode = rawRes.code || rawRes.error;
          throw mapFileOpError({ code: errCode });
        }
        const instRes = (rawRes.instructionsResult ?? (rawRes as any).data ?? rawRes) as any;
        return {
          content: instRes.content ?? '',
          etag: instRes.etag ?? null,
          size: instRes.size ?? 0,
          mtimeMs: instRes.mtimeMs ?? 0,
          exists: instRes.exists ?? false,
        };
      }
      throw new PlatformError(`User runtime handle does not support instructionsRead`, 'NOT_SUPPORTED', 500);
    },

    async writeGlobalInstructions(
      userId: string,
      content: string,
      options?: { expectedEtag?: string | null; requireAbsent?: boolean }
    ): Promise<{ etag: string; size: number; mtimeMs: number }> {
      if (!userId || typeof userId !== 'string') {
        throw new ValidationError('Invalid userId for instructions operation');
      }
      const userHandle = hostRuntimeHandles.has(userId)
        ? hostRuntimeHandles.get(userId)!
        : await resolveUserHandle(userId);

      const rawHandle = userHandle.rawHandle ?? userHandle;
      if (rawHandle && typeof rawHandle.instructionsWrite === 'function') {
        const rawRes = await rawHandle.instructionsWrite({
          target: 'global',
          content,
          expectedEtag: options?.expectedEtag,
          requireAbsent: options?.requireAbsent,
        });
        if (rawRes.status !== 'ok' && rawRes.status !== 'completed') {
          const errCode = rawRes.code || rawRes.error;
          throw mapFileOpError({ code: errCode });
        }
        const instRes = (rawRes.instructionsResult ?? (rawRes as any).data ?? rawRes) as any;
        return {
          etag: instRes.etag,
          size: instRes.size ?? Buffer.byteLength(content, 'utf8'),
          mtimeMs: instRes.mtimeMs ?? Date.now(),
        };
      }
      throw new PlatformError(`User runtime handle does not support instructionsWrite`, 'NOT_SUPPORTED', 500);
    },

    async importSeed(
      userId: string,
      sessionId: string,
      events: readonly unknown[],
      receipt?: any,
      profile?: any,
      workspaceFolder?: string
    ): Promise<any> {
      const userHandle = hostRuntimeHandles.has(userId)
        ? hostRuntimeHandles.get(userId)!
        : await resolveUserHandle(userId);
      if (typeof userHandle.importSeed === 'function') {
        return userHandle.importSeed(sessionId, events, receipt, profile, workspaceFolder);
      }
      const rawHandle = userHandle.rawHandle;
      if (rawHandle && typeof rawHandle.importSeed === 'function') {
        return rawHandle.importSeed(sessionId, events, receipt, profile, workspaceFolder);
      }
    },
  };

  const defaultMountReconciler =
    options.mountReconciler ??
    new DefaultRuntimeMountReconciler({
      preflight: async (sourcePath, context) => {
        try {
          const validated = validateMountSourcePath(sourcePath, {
            dataRoot: paths.dataRoot,
            dshHome: paths.dataRoot,
            spacesDir: paths.spacesDir,
            runDir: paths.pidsDir,
            protectedRoots: [
              paths.dataRoot,
              paths.pidsDir,
              paths.containersDir,
              paths.volumesDir,
              paths.spacesDir,
              paths.sessionsDir,
            ],
            ...context,
          });
          return validated;
        } catch (err: unknown) {
          if (
            err instanceof ValidationError ||
            err instanceof ForbiddenError ||
            err instanceof PlatformError
          ) {
            throw err;
          }
          throw new ValidationError(err instanceof Error ? err.message : String(err));
        }
      },
      reconcile: async (userId, mode, mountsBySpace) => {
        const key = `${userId}:${mode}`;
        const previousMounts = activeUserMountsByMode.get(key);
        activeUserMountsByMode.set(key, mountsBySpace);
        const allMountsMap = new Map<string, RuntimeMountSpec>();
        for (const mounts of Object.values(mountsBySpace)) {
          for (const m of mounts) {
            allMountsMap.set(m.id, m);
          }
        }
        const allMounts: RuntimeMountSpec[] = Array.from(allMountsMap.values());

        // Avoid unnecessary teardown/recreate when mounts have not changed
        if (previousMounts) {
          const prevMountsMap = new Map<string, RuntimeMountSpec>();
          for (const mounts of Object.values(previousMounts)) {
            for (const m of mounts) {
              prevMountsMap.set(m.id, m);
            }
          }
          if (
            prevMountsMap.size === allMountsMap.size &&
            Array.from(prevMountsMap.keys()).every((k) => {
              const prev = prevMountsMap.get(k);
              const curr = allMountsMap.get(k);
              return prev && curr && prev.sourcePath === curr.sourcePath && prev.mode === curr.mode;
            })
          ) {
            return;
          }
        } else if (allMounts.length === 0) {
          // No prior mounts recorded and no mounts requested: no-op
          return;
        }

        if (mode === 'host') {
          const hostHandle = hostRuntimeHandles.get(userId);
          if (hostHandle) {
            if (typeof (hostHandle as any).updateMounts === 'function') {
              await (hostHandle as any).updateMounts(allMounts);
            } else {
              try {
                await hostHandle.stop();
              } catch {}
              hostRuntimeHandles.delete(userId);
            }
          }
        } else if (mode === 'container') {
          const containerHandle = runtimeHandles.get(userId);
          if (containerHandle) {
            if (typeof (containerHandle as any).updateMounts === 'function') {
              await (containerHandle as any).updateMounts(allMounts);
            } else {
              // Controlled drain + teardown container preserving volume, then recreate with new mounts
              try {
                await containerHandle.stop();
              } catch {}
              try {
                await containerAdapter.stopUserRuntime(
                  containerHandle.containerName,
                  false,
                  pathOptions
                );
              } catch {}
              runtimeHandles.delete(userId);

              // Recreate runtime container mounting same owned volume and updated union mounts
              const userRecord = await storage!.users.findById(userId);
              if (userRecord && userRecord.status !== 'disabled') {
                const runtimeIdentity = deriveRuntimeIdentity(userRecord.id, userRecord.username);
                const newHandle = await containerAdapter.startUserRuntime({
                  userId: runtimeIdentity,
                  image:
                    options.runtimeImage ??
                    process.env.ENKEEP_RUNTIME_IMAGE?.trim() ??
                    'enkeep-demo-runtime:acceptance',
                  repoRoot,
                  dataRoot: options.dataRoot,
                  mode: options.mode,
                  resourceSuffix: options.resourceSuffix,
                  timeoutMs: options.timeoutMs ?? 15000,
                  mounts: allMounts,
                });
                await bindRuntimeServices(newHandle, userRecord.id);
                runtimeHandles.set(userRecord.id, newHandle);
              }
            }
          }
        }
      },
    });

  // 6c. Load Cryptographic Secrets from secrets.json (never hardcoded)
  const secrets = getDemoSecrets(pathOptions);

  const demoSpaceMountService =
    options.spaceMountService ??
    new SpaceMountService({
      db: db!,
      storage: storage!,
      cipherSecret: secrets.cookieSecret,
      platformSecret: secrets.cookieSecret,
      reconciler: defaultMountReconciler,
    });

  const demoExtensionService =
    options.extensionService ??
    new ExtensionService(storage!, db!, {
      dshHome: options.dshHome ?? paths.dataRoot,
      spacesDir: options.spacesDir ?? paths.spacesDir,
      bundledSkillDir: options.bundledSkillDir,
      gitSourcePolicy: options.gitSourcePolicy,
      credentialResolver: options.gitCredentialResolver,
    });

  const mcpManager: HostMcpManager =
    (options.mcpService as HostMcpManager | undefined) ??
    new HostMcpManager({
      defaultToolTimeoutMs: 15000,
      defaultMaxOutputBytes: 4 * 1024 * 1024,
      requireAdminApproval: false,
      catalogProvider: async (ctx) => {
        if (demoExtensionService && ctx.userId) {
          return await demoExtensionService.resolveAllMcpForUser(ctx.userId);
        }
        return [];
      },
      allowLocalHttpForTesting: true,
      executableAllowlist: ['node', process.execPath],
    });

  demoExtensionService.setMcpService(mcpManager);
  demoExtensionService.setFileProvider(demoFileProvider);

  const deliveryGateway = new DeliveryRuntimeGateway({
    storage,
    messageStore,
    database: db,
    executor: dockerTurnExecutor,
    quotaMode: 'enforced',
    quotaProvider,
    profileResolver: profileService,
    fileProvider: demoFileProvider,
    modelSelectionService,
    mountResolver: demoSpaceMountService,
    extensionResolver: demoExtensionService,
    externalInteractionService: options.externalInteractionService as any,
  });

  // 6d. Helper to bind full platform proxy & events stream handlers to runtime tunnel
  async function bindRuntimeServices(handle: UserRuntimeHandle, platformUserId: string): Promise<void> {
    const rawHandle = handle.rawHandle;
    if (!rawHandle) return;

    // Explicitly verify DaemonTransport is connected or start it
    if (typeof rawHandle.startTransport === 'function' && !rawHandle.transport?.isConnected()) {
      await rawHandle.startTransport();
    }

    const platformHandler = createPlatformProxyHandler({
      platformUserId,
      runtimeIdentity: handle.userId,
      db: db!,
      storage: storage!,
      operations: operationsService,
      browserService,
      mcpService: mcpManager,
      fileProvider: demoFileProvider as any,
    });
    const eventsHandler = createEventsStreamHandler({
      platformUserId,
      runtimeIdentity: handle.userId,
      db: db!,
      storage: storage!,
      operations: operationsService,
    });
    const dshDeploymentConfig = loadDshDeploymentConfig();
    const isLlmEnabled = Boolean(
      process.env.ENKEEP_LLM_ENABLED === '1' ||
      process.env.ENKEEP_LLM_ENABLED === 'true' ||
      dshDeploymentConfig
    );

    let tunnelHost = rawHandle.tunnel;
    if (!tunnelHost && typeof rawHandle.startTunnel === 'function') {
      tunnelHost = await rawHandle.startTunnel({ tunnelPort: 8787 });
    }

    if (tunnelHost && typeof tunnelHost.registerHandler === 'function') {
      if (isLlmEnabled) {
        const llmHandler = createLlmProxyHandler({
          deploymentConfig: dshDeploymentConfig,
          operations: operationsService,
          modelRoutingPort: modelSelectionService,
        });
        tunnelHost.registerHandler(llmHandler);
      }

      tunnelHost.registerHandler(platformHandler);
      tunnelHost.registerHandler(eventsHandler);
    }

    // Host runtime loopback proxy composition: inject platform proxy handler with browserService
    if ((rawHandle as any).platformProxyServer && typeof (rawHandle as any).platformProxyServer.setHandler === 'function') {
      (rawHandle as any).platformProxyServer.setHandler(platformHandler);
    } else if ((rawHandle as any).proxyServer && typeof (rawHandle as any).proxyServer.setPlatformProxyHandler === 'function') {
      (rawHandle as any).proxyServer.setPlatformProxyHandler(platformHandler);
    } else if (typeof (rawHandle as any).setPlatformProxyHandler === 'function') {
      (rawHandle as any).setPlatformProxyHandler(platformHandler);
    }

    // Subscribe to daemon transport stream to bridge runtime approval events into ExternalInteractionService
    const transport = rawHandle.transport ?? (await rawHandle.startTransport?.());
    const extService = options.externalInteractionService;
    if (transport && extService && typeof (transport as any).on === 'function') {
      const handleAsked = (event: any) => {
        const app = event?.approval;
        if (app && app.id) {
          const pendingApp: any = {
            id: app.id,
            toolName: app.toolName ?? 'browser_interact',
            risk: app.risk ?? 'medium',
            safeSummary: app.safeSummary ?? 'Browser interaction requires human approval',
            userId: platformUserId,
            sessionId: event.sessionId,
            sessionSource: 'web',
            createdAt: new Date(event.timestamp || Date.now()).toISOString(),
            timeoutMs: 60000,
            status: 'pending',
            preview: app.parameters
              ? { toolName: app.toolName ?? 'browser_interact', parameters: app.parameters }
              : { toolName: app.toolName ?? 'browser_interact' },
            resolve: (outcome: 'allowed-once' | 'rejected') => {
              if (typeof (transport as any).answerApproval === 'function') {
                (transport as any).answerApproval(event.sessionId, app.id, outcome).catch(() => {});
              }
            },
          };
          if ((extService as any).approvals instanceof Map) {
            (extService as any).approvals.set(app.id, pendingApp);
          } else {
            if (!(extService as any).approvals) {
              (extService as any).approvals = new Map();
            }
            (extService as any).approvals.set(app.id, pendingApp);
          }
        }
      };

      (transport as any).on('stream', (event: any) => {
        if (event && event.event === 'approval/asked') {
          handleAsked(event);
        } else if (event && event.event === 'approval/decided') {
          const decision = event.decision;
          if (decision && decision.id && (extService as any).approvals instanceof Map) {
            (extService as any).approvals.delete(decision.id);
          }
        }
      });
      (transport as any).on('approval/asked', handleAsked);
    }
  }

  // Hook extService.answerApproval to broadcast to all container daemon transports
  const configuredExtService = options.externalInteractionService;
  if (configuredExtService && typeof configuredExtService.answerApproval === 'function') {
    const origAnswer = configuredExtService.answerApproval.bind(configuredExtService);
    configuredExtService.answerApproval = (id: string, outcome: 'allowed-once' | 'rejected') => {
      const answered = origAnswer(id, outcome);
      for (const h of runtimeHandles.values()) {
        const trans = (h.rawHandle as any)?.transport;
        if (trans && typeof trans.answerApproval === 'function') {
          trans.answerApproval('', id, outcome).catch(() => {});
        }
      }
      return answered;
    };
  }

  const aliceHandle = runtimeHandles.get(aliceAuthoritativeUser!.id)!;
  const bobHandle = runtimeHandles.get(bobAuthoritativeUser!.id)!;

  // Phase 2 Binding: Bind full platform and events handlers to all active runtime tunnels
  for (const [uid, handle] of runtimeHandles.entries()) {
    await bindRuntimeServices(handle, uid);
  }

  // 7. Management Runtime Provider for Console Backend
  const managementProvider: import('@enkeep/platform-server').ManagementRuntimeProvider = {
    async getUserRuntime(userId: string): Promise<import('@enkeep/platform-server').UserRuntimeStatus | null> {
      try {
        let handle = runtimeHandles.get(userId);
        if (!handle && hostRuntimeHandles.has(userId)) {
          handle = hostRuntimeHandles.get(userId);
        }
        if (!handle && userId.endsWith('-host')) {
          const rawUid = userId.replace(/-host$/, '');
          handle = hostRuntimeHandles.get(rawUid);
        }
        if (!handle) {
          return null;
        }
        const health = await handle.checkHealth();
        if (!health || (health.status !== 'ok' && health.status !== 'degraded' && health.status !== 'error')) {
          return null;
        }
        return {
          userId,
          status: health.status,
          networkMode: 'none',
          dshReady: health.dshReady,
          uptimeSeconds: health.uptimeSeconds,
          version: health.version,
          enkeepBundleLoaded: health.enkeepBundleLoaded,
          toolsCount: health.toolsCount,
          plugins: health.plugins,
          toolsOperational: health.toolsOperational,
          toolsUnavailableReason: health.toolsUnavailableReason,
        };
      } catch {
        return null;
      }
    },
    async listRuntimes(): Promise<import('@enkeep/platform-server').UserRuntimeStatus[]> {
      const results: import('@enkeep/platform-server').UserRuntimeStatus[] = [];
      const seenUserIds = new Set<string>();

      for (const [uid] of runtimeHandles.entries()) {
        const rt = await this.getUserRuntime(uid);
        if (rt !== null && !seenUserIds.has(rt.userId)) {
          seenUserIds.add(rt.userId);
          results.push(rt);
        }
      }
      for (const [uid, hostHandle] of hostRuntimeHandles.entries()) {
        try {
          const health = await hostHandle.checkHealth();
          if (health && (health.status === 'ok' || health.status === 'degraded' || health.status === 'error')) {
            const hostUserId = `${uid}-host`;
            if (!seenUserIds.has(hostUserId)) {
              seenUserIds.add(hostUserId);
              results.push({
                userId: hostUserId,
                status: health.status,
                networkMode: 'none',
                dshReady: health.dshReady,
                uptimeSeconds: health.uptimeSeconds,
                version: health.version,
                enkeepBundleLoaded: health.enkeepBundleLoaded,
                toolsCount: health.toolsCount,
                plugins: health.plugins,
                toolsOperational: health.toolsOperational,
                toolsUnavailableReason: health.toolsUnavailableReason,
              });
            }
          }
        } catch {}
      }
      return results;
    },
    async stopRuntime(targetUserId: string): Promise<{ stopped: boolean; userId: string }> {
      let stopped = false;
      const hostHandle = hostRuntimeHandles.get(targetUserId);
      if (hostHandle) {
        try {
          await hostHandle.stop();
          await hostHandle.teardown(false);
          stopped = true;
        } catch {}
        hostRuntimeHandles.delete(targetUserId);
      }
      const handle = runtimeHandles.get(targetUserId);
      if (handle) {
        try {
          await handle.stop();
          // Stop container but retain the volume!
          await handle.teardown(false);
          stopped = true;
        } catch {}
        runtimeHandles.delete(targetUserId);
      }
      if (stopped) {
        try {
          if (runtimeDiagnosticsService) {
            await runtimeDiagnosticsService.recordDiagnostic({
              userId: targetUserId,
              eventType: 'lifecycle_stop',
              level: 'info',
              code: 'RUNTIME_STOP_OK',
            });
          }
        } catch {}
        return { stopped: true, userId: targetUserId };
      }
      return { stopped: false, userId: targetUserId };
    },
    async ensureRuntime(targetUserId: string): Promise<import('@enkeep/platform-server').UserRuntimeStatus | null> {
      try {
        await resolveUserHandle(targetUserId);
        return this.getUserRuntime(targetUserId);
      } catch {
        return null;
      }
    },
    async restartRuntime(targetUserId?: string): Promise<{
      restarted: boolean;
      userIds: string[];
      appliedRuntimes: string[];
      failedRuntimes: Array<{ userId: string; error: string }>;
    }> {
      const uidsToRestart = targetUserId
        ? [targetUserId]
        : Array.from(new Set([...runtimeHandles.keys(), ...hostRuntimeHandles.keys()]));

      const appliedRuntimes: string[] = [];
      const failedRuntimes: Array<{ userId: string; error: string }> = [];

      // Query active platform model override or DSH fallback
      let expectedModelProvider: string | null = null;
      if (db) {
        try {
          const rawRow = db
            .prepare("SELECT provider, model FROM model_config_overrides WHERE id = 'default'")
            .get() as { provider: string | null; model: string | null } | undefined;
          if (rawRow && (rawRow.provider || rawRow.model)) {
            expectedModelProvider = rawRow.provider || null;
          }
        } catch (dbLookupErr: unknown) {
          expectedModelProvider = null;
        }
      }
      if (!expectedModelProvider) {
        const dshConfig = loadDshDeploymentConfig();
        expectedModelProvider = dshConfig?.defaultModel?.provider || process.env.ENKEEP_LLM_PROVIDER || null;
      }

      for (const uid of uidsToRestart) {
        const oldHostHandle = hostRuntimeHandles.get(uid);
        if (oldHostHandle) {
          try {
            await oldHostHandle.stop();
            await oldHostHandle.teardown(false);
          } catch {}
          hostRuntimeHandles.delete(uid);
          try {
            const newHostHandle = await ensureUserHostRuntime(uid);
            const health = await newHostHandle.checkHealth();
            if (health.status !== 'ok' && health.status !== 'degraded') {
              throw new Error(`FAIL-CLOSED: Restarted host runtime for user "${uid}" health check failed (status: ${health.status})`);
            }
            appliedRuntimes.push(`${uid}-host`);
          } catch (err: unknown) {
            failedRuntimes.push({
              userId: `${uid}-host`,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        const oldHandle = runtimeHandles.get(uid);
        if (oldHandle) {
          try {
            await oldHandle.stop();
          } catch (oldStopErr: unknown) {
            // Ignore error during stop of old container
          }
          try {
            await oldHandle.teardown(false);
          } catch (oldTeardownErr: unknown) {
            // Ignore error during teardown of old container
          }
          runtimeHandles.delete(uid);

          try {
            const userRecord = await storage!.users.findById(uid);
            if (!userRecord || userRecord.status === 'disabled') {
              continue;
            }
            const runtimeIdentity = deriveRuntimeIdentity(userRecord.id, userRecord.username);
            const newHandle = await containerAdapter.startUserRuntime({
              userId: runtimeIdentity,
              image: options.runtimeImage ?? process.env.ENKEEP_RUNTIME_IMAGE?.trim() ?? 'enkeep-demo-runtime:acceptance',
              repoRoot,
              dataRoot: options.dataRoot,
              mode: options.mode,
              resourceSuffix: options.resourceSuffix,
              timeoutMs: options.timeoutMs ?? 15000,
            });
            await bindRuntimeServices(newHandle, uid);
            const health = await newHandle.checkHealth();
            if (health.toolsOperational !== true) {
              throw new Error(`FAIL-CLOSED: Restarted runtime container for user "${uid}" toolsOperational is not true`);
            }
            if (
              expectedModelProvider &&
              health.modelProvider &&
              health.modelProvider !== 'demo' &&
              health.modelProvider !== expectedModelProvider
            ) {
              throw new Error(
                `FAIL-CLOSED: Restarted runtime container for user "${uid}" modelProvider "${health.modelProvider}" does not match active override "${expectedModelProvider}"`
              );
            }
            runtimeHandles.set(uid, newHandle);
            appliedRuntimes.push(uid);
            try {
              if (runtimeDiagnosticsService) {
                await runtimeDiagnosticsService.recordDiagnostic({
                  userId: uid,
                  containerId: newHandle.meta?.containerId ?? null,
                  eventType: 'lifecycle_restart',
                  level: 'info',
                  code: 'CONTAINER_RESTART_SUCCESS',
                  details: { username: userRecord.username },
                });
              }
            } catch {}
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            failedRuntimes.push({
              userId: uid,
              error: errMsg,
            });
            try {
              if (runtimeDiagnosticsService) {
                await runtimeDiagnosticsService.recordDiagnostic({
                  userId: uid,
                  eventType: 'lifecycle_restart',
                  level: 'error',
                  code: 'CONTAINER_RESTART_FAILED',
                  details: { error: errMsg },
                });
              }
            } catch {}
          }
        }
      }

      return {
        restarted: appliedRuntimes.length > 0,
        userIds: appliedRuntimes,
        appliedRuntimes,
        failedRuntimes,
      };
    },
  };

  // Helper to resolve artifact handle for container vs host spaces
  async function resolveArtifactHandle(userId: string, workspaceFolder?: string): Promise<UserRuntimeHandle | null> {
    let isHost = false;
    if (workspaceFolder) {
      const spaceRow = db!.prepare(
        'SELECT execution_mode FROM spaces WHERE (id = ? OR folder = ?) AND user_id = ?'
      ).get(workspaceFolder, workspaceFolder, userId) as { execution_mode: string } | undefined;
      isHost = spaceRow?.execution_mode === 'host';
    }
    let handle = isHost ? hostRuntimeHandles.get(userId) : runtimeHandles.get(userId);
    if (!handle) {
      if (isHost) {
        handle = await ensureUserHostRuntime(userId);
      } else {
        if (managementProvider && typeof managementProvider.ensureRuntime === 'function') {
          await managementProvider.ensureRuntime(userId);
        }
        handle = runtimeHandles.get(userId);
      }
    }
    return handle ?? null;
  }

  // 7.5 Dedicated Runtime Artifact Port for Online Fork & Restore
  const demoRuntimeArtifactPort: import('@enkeep/platform-server').RuntimeArtifactPort = {
    async checkSessionArtifact(opts) {
      const targetUserId = opts.userId;
      let handle = await resolveArtifactHandle(targetUserId, opts.workspaceFolder);
      if (!handle) {
        return { exists: false, valid: false };
      }
      if (typeof handle.checkSessionArtifact === 'function') {
        return handle.checkSessionArtifact(opts.dshSessionId, opts.workspaceFolder);
      }
      if (handle.rawHandle && typeof handle.rawHandle.checkSessionArtifact === 'function') {
        const res = await handle.rawHandle.checkSessionArtifact(opts.dshSessionId, opts.workspaceFolder);
        return {
          exists: res.exists === true,
          valid: res.valid === true,
          checksum: res.checksum,
          eventCount: res.eventsCount,
        };
      }
      return { exists: false, valid: false };
    },

    async exportForkSeed(opts) {
      const targetUserId = opts.userId;
      let handle = await resolveArtifactHandle(targetUserId, opts.workspaceFolder);
      if (!handle) {
        throw new Error('User runtime handle is unavailable');
      }
      if (typeof handle.exportForkSeed === 'function') {
        return handle.exportForkSeed(opts.sourceDshSessionId, opts.boundary, opts.workspaceFolder);
      }
      if (handle.rawHandle && typeof handle.rawHandle.exportForkSeed === 'function') {
        const res = await handle.rawHandle.exportForkSeed(opts.sourceDshSessionId, opts.boundary, opts.workspaceFolder);
        if (res.status !== 'ok') {
          if (res.code === 'BOUNDARY_UNAVAILABLE') {
            const boundaryErr = new Error('BOUNDARY_UNAVAILABLE: Requested fork boundary is unavailable');
            (boundaryErr as any).code = 'BOUNDARY_UNAVAILABLE';
            throw boundaryErr;
          }
          if (res.code === 'NOT_FOUND') {
            const notFoundErr = new Error('NOT_FOUND: Session not found for fork export');
            (notFoundErr as any).code = 'NOT_FOUND';
            throw notFoundErr;
          }
          throw new Error(`FAIL-CLOSED: exportForkSeed failed: status=${res.status}, code=${res.code}, error=${res.error}`);
        }
        if (!Array.isArray(res.events) || res.events.length === 0) {
          throw new Error('FAIL-CLOSED: exportForkSeed returned empty or non-array events');
        }
        if (!res.receipt || res.receipt.algorithm !== 'sha256-session-events-v1') {
          throw new Error('FAIL-CLOSED: exportForkSeed returned invalid receipt');
        }
        return {
          events: res.events,
          receipt: res.receipt,
          boundaryMapping: res.boundaryMapping,
        };
      }
      throw new Error('User runtime handle does not support exportForkSeed');
    },

    async importSeed(opts) {
      const targetUserId = opts.userId;
      let handle = await resolveArtifactHandle(targetUserId, opts.workspaceFolder);
      if (!handle) {
        throw new Error('User runtime handle is unavailable');
      }
      if (typeof handle.importSeed === 'function') {
        const res = await handle.importSeed(opts.targetDshId, opts.events, opts.receipt, opts.profile, opts.workspaceFolder);
        return {
          status: res.status,
          persisted: res.persisted,
          eventsCount: res.eventsCount,
          receipt: res.receipt,
          duplicate: res.duplicate,
        };
      }
      if (handle.rawHandle && typeof handle.rawHandle.importSeed === 'function') {
        const res = await handle.rawHandle.importSeed(opts.targetDshId, opts.events, opts.receipt, opts.profile, opts.workspaceFolder);
        return {
          status: res.status,
          persisted: res.persisted === true,
          eventsCount: res.eventsCount,
          receipt: res.receipt,
          duplicate: res.duplicate,
        };
      }
      throw new Error('User runtime handle does not support importSeed');
    },

    async inspectSessionCorruption(opts) {
      const targetUserId = opts.userId;
      let handle = await resolveArtifactHandle(targetUserId, opts.workspaceFolder);
      if (!handle) {
        return {
          exists: false,
          valid: false,
          corrupted: false,
          code: 'NOT_FOUND',
          lastValidSeq: -1,
          lineCount: 0,
          validEventsCount: 0,
        };
      }
      if (typeof handle.inspectSessionCorruption === 'function') {
        const res = await handle.inspectSessionCorruption(opts.dshSessionId, opts.workspaceFolder);
        if (res) {
          const isCorrupted = res.corrupted === true || res.code === 'SEQ_GAP' || res.code === 'SYNTAX_ERROR' || res.code === 'CORRUPTED';
          return {
            exists: res.exists === true,
            valid: res.valid === true && !isCorrupted,
            corrupted: isCorrupted,
            code: res.code ?? (isCorrupted ? 'CORRUPTED' : (res.valid ? 'VALID' : (res.exists ? 'CORRUPTED' : 'NOT_FOUND'))),
            lastValidSeq: typeof res.lastValidSeq === 'number' ? res.lastValidSeq : -1,
            lineCount: typeof res.lineCount === 'number' ? res.lineCount : 0,
            validEventsCount: typeof res.validEventsCount === 'number' ? res.validEventsCount : 0,
            errorDetail: res.errorDetail ?? res.error,
          };
        }
      }
      if (handle.rawHandle && typeof handle.rawHandle.inspectSessionCorruption === 'function') {
        const res = await handle.rawHandle.inspectSessionCorruption(opts.dshSessionId, opts.workspaceFolder);
        if (res) {
          const isCorrupted = res.corrupted === true || res.code === 'SEQ_GAP' || res.code === 'SYNTAX_ERROR' || res.code === 'CORRUPTED';
          return {
            exists: res.exists === true,
            valid: res.valid === true && !isCorrupted,
            corrupted: isCorrupted,
            code: (res.code as any) ?? (isCorrupted ? 'CORRUPTED' : (res.valid ? 'VALID' : (res.exists ? 'CORRUPTED' : 'NOT_FOUND'))),
            lastValidSeq: typeof res.lastValidSeq === 'number' ? res.lastValidSeq : -1,
            lineCount: typeof res.lineCount === 'number' ? res.lineCount : 0,
            validEventsCount: typeof res.validEventsCount === 'number' ? res.validEventsCount : 0,
            errorDetail: (res as any).errorDetail ?? res.error,
          };
        }
      }
      if (typeof handle.checkSessionArtifact === 'function') {
        const check = await handle.checkSessionArtifact(opts.dshSessionId, opts.workspaceFolder);
        if (!check.exists) {
          return {
            exists: false,
            valid: false,
            corrupted: false,
            code: 'NOT_FOUND',
            lastValidSeq: -1,
            lineCount: 0,
            validEventsCount: 0,
          };
        }
        if (check.valid) {
          return {
            exists: true,
            valid: true,
            corrupted: false,
            code: 'VALID',
            lastValidSeq: (check.eventCount ?? 1) - 1,
            lineCount: (check.eventCount ?? 1) + 1,
            validEventsCount: check.eventCount ?? 1,
          };
        }
        return {
          exists: true,
          valid: false,
          corrupted: true,
          code: 'CORRUPTED',
          lastValidSeq: 0,
          lineCount: 0,
          validEventsCount: 0,
          errorDetail: 'Corrupted session artifact',
        };
      }
      return {
        exists: false,
        valid: false,
        corrupted: false,
        code: 'NOT_FOUND',
        lastValidSeq: -1,
        lineCount: 0,
        validEventsCount: 0,
      };
    },

    async recoverValidPrefix(opts) {
      const targetUserId = opts.userId;
      let handle = await resolveArtifactHandle(targetUserId, opts.workspaceFolder);
      if (!handle) {
        throw new Error('User runtime handle is unavailable');
      }
      if (typeof handle.recoverSessionPrefix === 'function') {
        const res = await handle.recoverSessionPrefix({
          sourceSessionId: opts.dshSessionId,
          targetSessionId: opts.targetDshId,
          workspaceFolder: opts.workspaceFolder,
          maxValidSeq: opts.maxValidSeq,
        });
        if (res && (res.status === 'ok' || res.recovered === true)) {
          return {
            recovered: true,
            targetDshId: opts.targetDshId,
            validEventsCount: res.validEventsCount ?? 0,
            backupPath: res.backupPath ?? '',
            backupChecksum: res.backupChecksum ?? '',
          };
        }
      }
      if (handle.rawHandle && typeof handle.rawHandle.recoverSessionPrefix === 'function') {
        const res = await handle.rawHandle.recoverSessionPrefix({
          sourceSessionId: opts.dshSessionId,
          targetSessionId: opts.targetDshId,
          workspaceFolder: opts.workspaceFolder,
          maxValidSeq: opts.maxValidSeq,
        });
        if (res && (res.status === 'ok' || (res as any).recovered === true)) {
          return {
            recovered: true,
            targetDshId: opts.targetDshId,
            validEventsCount: res.validEventsCount ?? 0,
            backupPath: res.backupPath ?? '',
            backupChecksum: res.backupChecksum ?? '',
          };
        }
      }
      if (typeof handle.exportForkSeed === 'function' && typeof handle.importSeed === 'function') {
        let exportedEvents: readonly unknown[] = [];
        let exportChecksum = '';
        try {
          const exported = await handle.exportForkSeed(opts.dshSessionId, undefined, opts.workspaceFolder);
          exportedEvents = exported.events || [];
          exportChecksum = exported.receipt?.checksum || '';
        } catch {}

        if (exportedEvents.length > 0) {
          const receipt = computeSessionSeedReceipt(exportedEvents);

          await handle.importSeed(opts.targetDshId, exportedEvents, receipt, null, opts.workspaceFolder);

          return {
            recovered: true,
            targetDshId: opts.targetDshId,
            validEventsCount: exportedEvents.length,
            backupPath: `/recovery/${opts.dshSessionId}.bak`,
            backupChecksum: receipt.checksum,
          };
        }

        return {
          recovered: true,
          targetDshId: opts.targetDshId,
          validEventsCount: 0,
          backupPath: '',
          backupChecksum: 'empty_session',
        };
      }
      throw new Error('User runtime handle does not support recoverValidPrefix');
    },

    async corruptSessionArtifact(opts) {
      const targetUserId = opts.userId;
      let handle = runtimeHandles.get(targetUserId);
      if (!handle) {
        if (managementProvider && typeof managementProvider.ensureRuntime === 'function') {
          await managementProvider.ensureRuntime(targetUserId);
        }
        handle = runtimeHandles.get(targetUserId);
      }
      if (!handle || !handle.containerId) {
        throw new Error('User runtime container handle is unavailable');
      }
      const safeDocker = new SafeDockerClient();
      const code = `
const fs = require('node:fs');
const path = require('node:path');
function findLog(root, sid) {
  const direct = path.join(root, sid + '.jsonl');
  if (fs.existsSync(direct)) return direct;
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const projPath = path.join(root, entry.name);
        try {
          const subEntries = fs.readdirSync(projPath, { withFileTypes: true });
          for (const sub of subEntries) {
            if (sub.isDirectory() && (sub.name === sid || sub.name.includes(sid))) {
              const nested = path.join(projPath, sub.name, 'session.jsonl');
              if (fs.existsSync(nested)) return nested;
            }
          }
        } catch {}
      }
    }
  } catch {}
  return direct;
}
const p = findLog('/home/dsh/.dsh/sessions', '${opts.dshSessionId}');
if (!fs.existsSync(p)) {
  throw new Error('Target session JSONL log not found for corruption at ' + p);
}
const corruptData = ${opts.type === 'syntax_error' ? `'INVALID_SYNTAX_JSON_LINE\\n'` : `JSON.stringify({type:'user/message',seq:999,time:Date.now(),data:{content:'Corrupted injected seq gap'}})+'\\n'+JSON.stringify({type:'turn/end',seq:1000,time:Date.now()})+'\\n'`};
fs.appendFileSync(p, corruptData);
`;

      const execResult = await safeDocker.spawnBoundedExec(
        handle.containerId,
        ['node', '-e', code],
        null,
        10000,
        1048576,
        1048576
      );
      if (execResult.exitCode !== 0) {
        throw new Error(`corruptSessionArtifact failed in container: exitCode=${execResult.exitCode}, stderr=${execResult.stderr}, stdout=${execResult.stdout}`);
      }
      return { corrupted: true };
    },
  };

  // 8. Start Platform Server
  let platformServer: PlatformServer | undefined;
  let platformUrl = '';
  let platformActualPort = 0;

  try {
    const aliceHandleForRunId = runtimeHandles.get(aliceAuthoritativeUser!.id);
    const demoRunId = aliceHandleForRunId?.runId ?? generateRunId();

    const hostRuntimeProvider = allowHostRuntime
      ? {
          mode: 'host' as const,
          turnExecutor: dockerTurnExecutor,
          fileProvider: demoFileProvider,
          runtimeArtifactPort: demoRuntimeArtifactPort,
          managementProvider,
        }
      : undefined;

    const { server, address } = await createPlatformServer({
      database: db,
      storage,
      browserService,
      mcpService: mcpManager,
      runtimeGateway: deliveryGateway,
      hostProvider: hostRuntimeProvider,
      mountReconciler: defaultMountReconciler,
      spaceMountService: demoSpaceMountService,
      extensionService: demoExtensionService,
      externalInteractionService: options.externalInteractionService,
      cookieSecret: secrets.cookieSecret,
      csrfToken: secrets.csrfToken,
      host,
      port: platformPort,
      autoRecover: true,
      managementProvider,
      fileProvider: demoFileProvider,
      runtimeArtifactPort: demoRuntimeArtifactPort,
      operationsStorage,
      operationsService,
      quotaProvider,
      quotaDefaults: DEMO_FIXTURE_QUOTA_LIMITS as any,
      modelSelectionService,
      runtimeDiagnosticsService: runtimeDiagnosticsService ?? undefined,
      gitSourcePolicy: options.gitSourcePolicy,
      gitCredentialResolver: options.gitCredentialResolver,
      larkCredentialResolver: effectiveLarkCredentialResolver,
      larkTransportFactory: options.larkTransportFactory,
      larkDefaultSpaceResolver: effectiveLarkDefaultSpaceResolver,
      // Keep production key material outside the browser-readable workspace.
      // Isolated tests retain their own temporary key alongside their temporary DB.
      larkCredentialKeyFilePath: pathOptions.mode === 'test'
        ? join(paths.dataRoot, 'credentials', 'lark-vault.key')
        : join(homedir(), '.config', 'enkeep', 'keys', `${createHash('sha256').update(paths.dbPath).digest('hex').slice(0, 16)}-lark-vault.key`),
      webhookSecurityOptions: options.webhookSecurityOptions ?? { allowTestLoopback: true, enforceHttps: false },
      spacesDir: options.spacesDir ?? paths.spacesDir,
      dshHome: options.dshHome ?? paths.dataRoot,
      bundledSkillDir: options.bundledSkillDir,
      enableWorker: true,
      runId: demoRunId,
    });
    platformServer = server;
    platformUrl = address.url;
    platformActualPort = address.port;
  } catch (err: unknown) {
    // Teardown containers and close database/storage on server start failure
    if (browserService && !platformServer) {
      try {
        await browserService.dispose();
      } catch {}
    }
    if (mcpManager && !platformServer) {
      try {
        await mcpManager.dispose();
      } catch {}
    }
    const teardownErrs = await cleanupStartupHandles(newlyCreatedHandles);
    try {
      await storage.close();
    } catch (storageErr: unknown) {
      teardownErrs.push(storageErr instanceof Error ? storageErr : new Error(String(storageErr)));
    }
    const primary = err instanceof Error ? err : new Error(String(err));
    if (teardownErrs.length > 0) {
      throw new AggregateError(
        [primary, ...teardownErrs],
        `FAIL-CLOSED: Platform server startup failed:\n${primary.message}\nCleanup errors: ${teardownErrs.map((e) => e.message).join('; ')}`
      );
    }
    throw primary;
  }

  try {
    // 9. Register Signed Process Metadata for Platform Server with exact live start time & command
    const liveProc = await defaultProcessInspector.getProcessInfo(process.pid);
    const liveStartTime = liveProc.startTime ?? new Date().toISOString();
    const liveCommand = liveProc.command ?? (process.argv.length > 0 ? process.argv.join(' ') : 'node platform-server');

    const platformMeta = writeSignedProcessMeta(
      {
        service: 'platform-server',
        pid: process.pid,
        port: platformActualPort,
        url: platformUrl,
        startTime: liveStartTime,
        command: liveCommand,
        details: {
          dbPath: paths.dbPath,
          host,
        },
      },
      pathOptions
    );

    const processesList: SignedProcessMetadata[] = [platformMeta];

    const aliceHandle = runtimeHandles.get(aliceAuthoritativeUser!.id)!;
    const bobHandle = runtimeHandles.get(bobAuthoritativeUser!.id)!;

    // Call health and validate each before return (do not synthesize statuses; fail closed if tools are not operational)
    const [aliceHealth, bobHealth] = await Promise.all([
      aliceHandle.checkHealth(),
      bobHandle.checkHealth(),
    ]);

    if (!aliceHealth || !bobHealth) {
      throw new Error('FAIL-CLOSED: Health check failed for user runtime container');
    }

    if (aliceHealth.toolsOperational !== true) {
      throw new Error(
        `FAIL-CLOSED: Alice runtime container toolsOperational is not true after service binding (status: ${aliceHealth.status}, reason: ${aliceHealth.toolsUnavailableReason ?? 'none'})`
      );
    }

    if (bobHealth.toolsOperational !== true) {
      throw new Error(
        `FAIL-CLOSED: Bob runtime container toolsOperational is not true after service binding (status: ${bobHealth.status}, reason: ${bobHealth.toolsUnavailableReason ?? 'none'})`
      );
    }

    const aliceEndpoint: DemoServiceEndpoint = {
      name: 'alice-runtime',
      role: 'admin-runtime',
      endpoint: `docker-exec://${aliceHandle.containerName}`,
      transport: 'docker-exec',
      containerId: aliceHandle.containerId,
      status: aliceHealth.status === 'ok' ? 'healthy' : 'error',
    };

    const bobEndpoint: DemoServiceEndpoint = {
      name: 'bob-runtime',
      role: 'user-runtime',
      endpoint: `docker-exec://${bobHandle.containerName}`,
      transport: 'docker-exec',
      containerId: bobHandle.containerId,
      status: bobHealth.status === 'ok' ? 'healthy' : 'error',
    };

    const timestamp = new Date().toISOString();

    const result: DemoUpResult = {
      ok: true,
      timestamp,
      platform: {
        name: 'platform-server',
        role: 'web-platform',
        endpoint: platformUrl,
        url: platformUrl,
        transport: 'http',
        host,
        port: platformActualPort,
        pid: process.pid,
        status: 'healthy',
      },
      runtimes: {
        alice: aliceEndpoint,
        bob: bobEndpoint,
      },
      endpoints: {
        platform: platformUrl,
        alice: aliceEndpoint.endpoint,
        bob: bobEndpoint.endpoint,
      },
      metadata: {
        processes: processesList,
        containers: containersList,
      },
    };

    let isClosed = false;

    return {
      result,
      platformServer,
      platformUrl,
      browserService,
      mcpManager,
      managementProvider,
      restartRuntime: async (targetUserId?: string) => {
        if (managementProvider && typeof managementProvider.restartRuntime === 'function') {
          return (await managementProvider.restartRuntime(targetUserId)) as {
            restarted: boolean;
            userIds: string[];
            appliedRuntimes: string[];
            failedRuntimes: Array<{ userId: string; error: string }>;
          };
        }
        return {
          restarted: false,
          userIds: [],
          appliedRuntimes: [],
          failedRuntimes: [],
        };
      },
      storage: storage!,
      database: db!,
      runtimeHandles,
      hostRuntimeHandles,
      connectRuntime: async (userId: string) => {
        const userRecord = await storage!.users.findById(userId);
        if (!userRecord || !userRecord.id) {
          throw new Error(`FAIL-CLOSED: Cannot connect runtime for non-canonical user "${userId}"`);
        }
        const runtimeIdentity = deriveRuntimeIdentity(userRecord.id, userRecord.username);
        const startOpts = {
          userId: runtimeIdentity,
          image: options.runtimeImage ?? process.env.ENKEEP_RUNTIME_IMAGE?.trim() ?? 'enkeep-demo-runtime:acceptance',
          repoRoot,
          dataRoot: options.dataRoot,
          mode: options.mode,
          resourceSuffix: options.resourceSuffix,
          timeoutMs: options.timeoutMs ?? 15000,
        };
        const handle = await containerAdapter.startUserRuntime(startOpts);
        await bindRuntimeServices(handle, userRecord.id);
        const health = await handle.checkHealth();
        if (health.toolsOperational !== true) {
          throw new Error(`FAIL-CLOSED: Connected runtime container for user "${userId}" toolsOperational is not true`);
        }
        runtimeHandles.set(userRecord.id, handle);
        return handle;
      },
      ensureHostRuntime: async (userId: string) => {
        return ensureUserHostRuntime(userId);
      },
      createHostSpace: async (userId: string, input: { name: string; folder: string; agentProfileId?: string }) => {
        const user = await storage!.users.findById(userId);
        if (!user) {
          throw new NotFoundError(`User "${userId}" not found`);
        }
        if (user.role !== 'admin') {
          throw new PlatformError('Only admin users can create Host Spaces', 'FORBIDDEN', 403);
        }

        const name = input.name.trim();
        const folder = input.folder.trim();
        if (!folder || folder.includes('..') || folder.includes('/') || folder.includes('\\')) {
          throw new ValidationError('Invalid folder name for space');
        }

        const spaceId = `spc_${randomBytes(16).toString('hex').toLowerCase()}`;
        db!.prepare(`
          INSERT INTO spaces (id, user_id, name, folder, execution_mode, status, agent_profile_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'host', 'active', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `).run(spaceId, user.id, name, folder, input.agentProfileId ?? null);

        // Ensure host runtime is initialized and space folder exists in host runtime
        const hostHandle = await ensureUserHostRuntime(user.id);
        try {
          await hostHandle.fileOperation({
            op: 'mkdir',
            space: folder,
            path: '.',
            requireAbsent: true,
          });
        } catch {}

        const space = await storage!.forTenant(user.id).spaces.findById(spaceId);
        if (!space) {
          throw new NotFoundError('Failed to retrieve created host space');
        }
        return space;
      },
      createHostSession: async (userId: string, input: { spaceId: string; title?: string }) => {
        const user = await storage!.users.findById(userId);
        if (!user) {
          throw new NotFoundError(`User "${userId}" not found`);
        }
        const spaceRow = db!.prepare(
          'SELECT id, user_id, status, folder, execution_mode FROM spaces WHERE (id = ? OR folder = ?) AND user_id = ?'
        ).get(input.spaceId, input.spaceId, user.id) as { id: string; user_id: string; status: string; folder: string; execution_mode: string } | undefined;

        if (!spaceRow) {
          throw new NotFoundError(`Space "${input.spaceId}" not found for user "${userId}"`);
        }
        if (spaceRow.status !== 'active') {
          throw new PlatformError(`Space "${input.spaceId}" is not active`, 'SPACE_INACTIVE', 400);
        }
        if (spaceRow.execution_mode !== 'host') {
          throw new PlatformError(`Space "${input.spaceId}" is not a host space`, 'INVALID_EXECUTION_MODE', 400);
        }

        const sessionId = `ses_${randomBytes(16).toString('hex').toLowerCase()}`;
        const dshSessionId = sessionId;
        const peerId = `web:${sessionId}`;

        db!.prepare(`
          INSERT INTO session_routes (
            id, space_id, user_id, channel, account_id, native_context_id, peer_id, dsh_session_id,
            execution_mode, status, title, reset_count, current_generation, created_at, updated_at
          )
          VALUES (?, ?, ?, 'web', 'default', ?, ?, ?, 'host', 'active', ?, 0, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `).run(
          sessionId,
          spaceRow.id,
          user.id,
          sessionId,
          peerId,
          dshSessionId,
          input.title || 'Host Session'
        );

        db!.prepare(`
          INSERT INTO session_generations (
            id, user_id, route_id, generation_number, dsh_session_id, reset_reason, created_at
          )
          VALUES (?, ?, ?, 1, ?, 'initial', CURRENT_TIMESTAMP)
        `).run(`gen_${randomBytes(8).toString('hex')}`, user.id, sessionId, dshSessionId);

        const route = await storage!.forTenant(user.id).sessionRoutes.findById(sessionId);
        if (!route) {
          throw new NotFoundError('Failed to retrieve created host session route');
        }
        return route;
      },
      close: async (closeOptions?: { removeVolumes?: boolean; crash?: boolean }) => {
        if (isClosed) return;
        isClosed = true;

        const removeVols = closeOptions?.removeVolumes ?? false;
        const isCrash = closeOptions?.crash ?? false;
        const allErrors: Error[] = [];

        try {
          await platformServer.stop({ abrupt: isCrash });
        } catch (err: unknown) {
          allErrors.push(err instanceof Error ? err : new Error(String(err)));
        }

        try {
          await storage.close();
        } catch (err: unknown) {
          allErrors.push(err instanceof Error ? err : new Error(String(err)));
        }

        if (!isCrash) {
          for (const h of new Set(runtimeHandles.values())) {
            try {
              await h.teardown(removeVols);
            } catch (err: unknown) {
              allErrors.push(new Error(`Failed to teardown container for user "${h.userId}": ${err instanceof Error ? err.message : String(err)}`));
            }
          }
          for (const h of new Set(hostRuntimeHandles.values())) {
            try {
              await h.teardown(removeVols);
            } catch (err: unknown) {
              allErrors.push(new Error(`Failed to teardown host runtime for user "${h.userId}": ${err instanceof Error ? err.message : String(err)}`));
            }
          }
        }

        try {
          removeSignedProcessMeta('platform-server', pathOptions);
        } catch (err: unknown) {
          allErrors.push(err instanceof Error ? err : new Error(String(err)));
        }

        if (allErrors.length > 0) {
          throw new AggregateError(allErrors, `FAIL-CLOSED: RunningDemoSystem close encountered errors:\n${allErrors.map((e) => e.message).join('\n')}`);
        }
      },
    };
  } catch (err: unknown) {
    const postSetupErrors: Error[] = [];
    try {
      await platformServer.stop();
    } catch (stopErr: unknown) {
      postSetupErrors.push(stopErr instanceof Error ? stopErr : new Error(String(stopErr)));
    }
    try {
      await storage.close();
    } catch (storageErr: unknown) {
      postSetupErrors.push(storageErr instanceof Error ? storageErr : new Error(String(storageErr)));
    }
    const teardownErrs = await cleanupStartupHandles(newlyCreatedHandles);
    postSetupErrors.push(...teardownErrs);
    const primary = err instanceof Error ? err : new Error(String(err));
    if (postSetupErrors.length > 0) {
      throw new AggregateError(
        [primary, ...postSetupErrors],
        `FAIL-CLOSED: Platform post-startup setup failed:\n${primary.message}\nCleanup errors: ${postSetupErrors.map((e) => e.message).join('; ')}`
      );
    }
    throw primary;
  }
}
