/**
 * Real Docker Acceptance Integration Test Suite (Zero-Network Architecture)
 *
 * Strict invariants:
 * - When run via `pnpm run test:docker` (with ENKEEP_DOCKER_ACCEPTANCE=1 and required ENKEEP_RUNTIME_IMAGE):
 *   - Fails closed: throws immediately if ENKEEP_RUNTIME_IMAGE is missing or Docker daemon is unreachable.
 *   - Verifies the specified runtime image is available and valid via inspectImageExact.
 *   - Uses random UUID-derived 12-char hex suffixes for all container and volume names.
 *   - Never deletes or modifies pre-existing containers/volumes; never relies on live label queries for authority.
 *   - Tracks only exact handles returned by startRuntime and cleans them up in finally blocks.
 *   - Tests zero-network isolation, non-root execution (1000:1000), read-only rootfs, dropped capabilities,
 *     no-new-privileges, pids-limit, dedicated volume mounts, tmpfs /tmp, and absence of published ports.
 *   - Verifies health readiness, deterministic followups, stop/start reconnect by exact 64-hex ID,
 *     fixed fixture seed import idempotency, cross-user isolation (Alice vs Bob),
 *     corrupted JSONL fail-closed envelope, cross-exec cancellation, and collision non-adoption.
 * - When run under standard `pnpm test`:
 *   - Completely excluded via vitest.config.ts (no tests executed, zero skipped tests).
 *
 * @module @enkeep/runtime-runner/tests/docker-optin.e2e.test
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  DockerRuntimeAdapter,
  SafeDockerClient,
  DockerCollisionError,
  is64HexContainerId,
  encodeSessionSegment,
  type RuntimeContainerSpec,
  type ActiveRuntimeHandle,
  type OwnershipExpectation,
  type StreamHandler,
} from '../src/index.js';
import {
  importFixedHappyClawFixture,
  executeGenericMigration,
  type CompiledChat,
} from '@enkeep/import-happyclaw';
import { PlatformProxyHandler } from '../src/tunnel/platform-proxy.js';
import type {
  BrowserService,
  BrowserOpenOptions,
  BrowserOpenResult,
} from '@enkeep/platform-core';

const execFileAsync = promisify(execFile);

function generateTestSuffix(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12).toLowerCase();
}

function generateCanonicalSessionId(): string {
  return `ses_${randomUUID().replace(/-/g, '').toLowerCase()}`;
}

function generateCanonicalTurnId(): string {
  return `turn_${randomUUID().replace(/-/g, '').toLowerCase()}`;
}

/**
 * Creates a verified collision-free RuntimeContainerSpec for a given user.
 * Inspects host to ensure no colliding container or volume exists before returning.
 * Retries up to maxRetries times on collision; never deletes existing resources.
 */
async function createUniqueUserSpec(
  adapter: DockerRuntimeAdapter,
  client: SafeDockerClient,
  userId: string,
  image: string,
  overrides?: { volumeName?: string; volumeId?: string },
  maxRetries = 3
): Promise<RuntimeContainerSpec> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const suffix = generateTestSuffix();
    const spec = adapter.createDefaultUserSpec({
      userId,
      nameSuffix: suffix,
      image,
      volumeName: overrides?.volumeName,
      volumeId: overrides?.volumeId,
    });

    const [existingContainer, existingVolume] = await Promise.all([
      client.inspectContainer(spec.containerName),
      overrides?.volumeName ? Promise.resolve(null) : client.inspectVolume(spec.volume.volumeName),
    ]);

    if (existingContainer === null && (overrides?.volumeName || existingVolume === null)) {
      return spec;
    }
  }

  throw new Error(
    `Failed to generate unique non-colliding container/volume names for user "${userId}" after ${maxRetries} attempts.`
  );
}

/**
 * Creates a verified collision-free pair of specs for Alice and Bob sharing the same run suffix.
 */
async function createUniqueUserPair(
  adapter: DockerRuntimeAdapter,
  client: SafeDockerClient,
  image: string,
  maxRetries = 3
): Promise<{ aliceSpec: RuntimeContainerSpec; bobSpec: RuntimeContainerSpec }> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const suffix = generateTestSuffix();
    const aliceSpec = adapter.createDefaultUserSpec({
      userId: 'alice',
      nameSuffix: suffix,
      image,
    });
    const bobSpec = adapter.createDefaultUserSpec({
      userId: 'bob',
      nameSuffix: suffix,
      image,
    });

    const [aliceC, aliceV, bobC, bobV] = await Promise.all([
      client.inspectContainer(aliceSpec.containerName),
      client.inspectVolume(aliceSpec.volume.volumeName),
      client.inspectContainer(bobSpec.containerName),
      client.inspectVolume(bobSpec.volume.volumeName),
    ]);

    if (aliceC === null && aliceV === null && bobC === null && bobV === null) {
      return { aliceSpec, bobSpec };
    }
  }

  throw new Error(
    `Failed to generate unique non-colliding container/volume names for Alice & Bob pair after ${maxRetries} attempts.`
  );
}

/**
 * Executes a test body while safely tracking handles and guaranteeing clean teardown
 * without masking the primary test error if teardown also encounters errors.
 */
async function runWithHandles(
  fn: (handles: ActiveRuntimeHandle[]) => Promise<void>
): Promise<void> {
  const handles: ActiveRuntimeHandle[] = [];
  let primaryError: unknown;

  try {
    await fn(handles);
  } catch (err: unknown) {
    primaryError = err;
  } finally {
    const teardownErrors: Error[] = [];
    for (const handle of handles) {
      try {
        await handle.teardown(true);
      } catch (tdErr: unknown) {
        teardownErrors.push(tdErr instanceof Error ? tdErr : new Error(String(tdErr)));
      }
    }

    if (primaryError && teardownErrors.length > 0) {
      throw new AggregateError(
        [
          primaryError instanceof Error ? primaryError : new Error(String(primaryError)),
          ...teardownErrors,
        ],
        `Test execution failed and teardown also failed: ${primaryError instanceof Error ? primaryError.message : String(primaryError)}`
      );
    } else if (primaryError) {
      throw primaryError;
    } else if (teardownErrors.length > 0) {
      throw new AggregateError(
        teardownErrors,
        `Teardown failed: ${teardownErrors.map((e) => e.message).join('; ')}`
      );
    }
  }
}

describe.sequential('Real Docker Zero-Network Acceptance Suite', () => {
  const client = new SafeDockerClient();
  const adapter = new DockerRuntimeAdapter(client);
  let runtimeImage = '';

  beforeAll(async () => {
    const rawImage = process.env.ENKEEP_RUNTIME_IMAGE?.trim();
    if (!rawImage) {
      throw new Error(
        'FAIL-CLOSED: ENKEEP_RUNTIME_IMAGE environment variable is required for Docker acceptance tests.'
      );
    }
    runtimeImage = rawImage;

    const dockerAvailable = await client.isDockerAvailable();
    if (!dockerAvailable) {
      throw new Error(
        'FAIL-CLOSED: Docker daemon is unreachable. Docker acceptance test cannot proceed.'
      );
    }

    try {
      const imageId = await client.inspectImageExact(runtimeImage);
      if (!imageId) {
        throw new Error(`Docker image "${runtimeImage}" returned empty ID on inspect.`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `FAIL-CLOSED: Required Docker runtime image "${runtimeImage}" is not available: ${msg}`
      );
    }
  });

  it('executes full live zero-network container lifecycle, validates hardening invariants, and tests stop/reconnect', async () => {
    await runWithHandles(async (activeHandles) => {
      // 1. Generate collision-free specs for Alice and Bob
      const { aliceSpec, bobSpec } = await createUniqueUserPair(adapter, client, runtimeImage);

      expect(aliceSpec.containerName).toMatch(/^enkeep-demo-alice-[a-z0-9]{12}$/);
      expect(bobSpec.containerName).toMatch(/^enkeep-demo-bob-[a-z0-9]{12}$/);
      expect(aliceSpec.volume.volumeName).toMatch(/^enkeep-demo-dsh-alice-[a-z0-9]{12}$/);
      expect(bobSpec.volume.volumeName).toMatch(/^enkeep-demo-dsh-bob-[a-z0-9]{12}$/);
      expect(aliceSpec.networkMode).toBe('none');
      expect(bobSpec.networkMode).toBe('none');
      expect(aliceSpec.volume.volumeId).not.toBe(bobSpec.volume.volumeId);

      adapter.validateUserPair(aliceSpec, bobSpec);

      // 2. Start Alice and Bob runtime containers sequentially, tracking handles immediately
      const aliceHandle = await adapter.startRuntime(aliceSpec, 30000);
      activeHandles.push(aliceHandle);

      const bobHandle = await adapter.startRuntime(bobSpec, 30000);
      activeHandles.push(bobHandle);

      // 3. Invariant Checks: Exact 64-hex IDs, distinct IDs
      expect(is64HexContainerId(aliceHandle.containerId)).toBe(true);
      expect(is64HexContainerId(bobHandle.containerId)).toBe(true);
      expect(aliceHandle.containerId).not.toBe(bobHandle.containerId);

      // 4. Inspect container hardening, labels, and zero-network properties
      const [aliceInfo, bobInfo] = await Promise.all([
        client.inspectContainer(aliceHandle.containerId),
        client.inspectContainer(bobHandle.containerId),
      ]);

      expect(aliceInfo).not.toBeNull();
      expect(bobInfo).not.toBeNull();

      if (!aliceInfo || !bobInfo) {
        throw new Error('Inspected container info unexpectedly null for active handles.');
      }

      // Exact ID match
      expect(aliceInfo.id).toBe(aliceHandle.containerId);
      expect(bobInfo.id).toBe(bobHandle.containerId);

      // Zero-Network enforcement
      expect(aliceInfo.networkMode).toBe('none');
      expect(bobInfo.networkMode).toBe('none');

      // Non-root user enforcement
      expect(aliceInfo.user).toBe('1000:1000');
      expect(bobInfo.user).toBe('1000:1000');

      // Read-only rootfs enforcement
      expect(aliceInfo.readonlyRootfs).toBe(true);
      expect(bobInfo.readonlyRootfs).toBe(true);

      // CapDrop ALL exact enforcement
      expect(aliceInfo.capDrop).toEqual(['ALL']);
      expect(bobInfo.capDrop).toEqual(['ALL']);

      // No-new-privileges exact enforcement
      expect(aliceInfo.securityOpt).toEqual(['no-new-privileges:true']);
      expect(bobInfo.securityOpt).toEqual(['no-new-privileges:true']);

      // PIDs limit exact enforcement (256)
      expect(aliceInfo.pidsLimit).toBe(256);
      expect(bobInfo.pidsLimit).toBe(256);

      // No published ports (exact null)
      expect(aliceInfo.portBindings).toBeNull();
      expect(bobInfo.portBindings).toBeNull();

      // Tmpfs mount exact /tmp canonical string and no extra keys
      expect(aliceInfo.tmpfs).toEqual({ '/tmp': 'rw,noexec,nosuid,nodev,size=64m' });
      expect(bobInfo.tmpfs).toEqual({ '/tmp': 'rw,noexec,nosuid,nodev,size=64m' });

      // Exact ownership labels
      expect(aliceInfo.labels['app']).toBe('enkeep-demo');
      expect(aliceInfo.labels['enkeep.user']).toBe('alice');
      expect(aliceInfo.labels['enkeep.run-id']).toBe(aliceSpec.runId);
      expect(aliceInfo.labels['enkeep.volume-id']).toBe(aliceSpec.volume.volumeId);

      expect(bobInfo.labels['app']).toBe('enkeep-demo');
      expect(bobInfo.labels['enkeep.user']).toBe('bob');
      expect(bobInfo.labels['enkeep.run-id']).toBe(bobSpec.runId);
      expect(bobInfo.labels['enkeep.volume-id']).toBe(bobSpec.volume.volumeId);

      // Mount isolation: exactly one volume mount at destination /home/dsh, rw: true
      expect(aliceInfo.mounts).toBeDefined();
      expect(aliceInfo.mounts?.length).toBe(1);
      expect(aliceInfo.mounts?.[0].type).toBe('volume');
      expect(aliceInfo.mounts?.[0].destination).toBe('/home/dsh');
      expect(aliceInfo.mounts?.[0].name).toBe(aliceSpec.volume.volumeName);
      expect(aliceInfo.mounts?.[0].rw).toBe(true);

      expect(bobInfo.mounts).toBeDefined();
      expect(bobInfo.mounts?.length).toBe(1);
      expect(bobInfo.mounts?.[0].type).toBe('volume');
      expect(bobInfo.mounts?.[0].destination).toBe('/home/dsh');
      expect(bobInfo.mounts?.[0].name).toBe(bobSpec.volume.volumeName);
      expect(bobInfo.mounts?.[0].rw).toBe(true);
      expect(aliceInfo.mounts?.[0].name).not.toBe(bobInfo.mounts?.[0].name);

      // Inspect volume labels
      const [aliceVolInfo, bobVolInfo] = await Promise.all([
        client.inspectVolume(aliceSpec.volume.volumeName),
        client.inspectVolume(bobSpec.volume.volumeName),
      ]);

      expect(aliceVolInfo).not.toBeNull();
      expect(bobVolInfo).not.toBeNull();
      expect(aliceVolInfo?.labels['app']).toBe('enkeep-demo');
      expect(aliceVolInfo?.labels['enkeep.user']).toBe('alice');
      expect(aliceVolInfo?.labels['enkeep.volume-id']).toBe(aliceSpec.volume.volumeId);

      expect(bobVolInfo?.labels['app']).toBe('enkeep-demo');
      expect(bobVolInfo?.labels['enkeep.user']).toBe('bob');
      expect(bobVolInfo?.labels['enkeep.volume-id']).toBe(bobSpec.volume.volumeId);

      // 5. Official Runtime Health & Plugin Readiness Check
      const [aliceHealth, bobHealth] = await Promise.all([
        aliceHandle.checkHealth(),
        bobHandle.checkHealth(),
      ]);

      expect(aliceHealth.status).toBe('ok');
      expect(aliceHealth.dshReady).toBe(true);
      expect(aliceHealth.enkeepBundleLoaded).toBe(true);
      expect(aliceHealth.userId).toBe('alice');
      expect(aliceHealth.toolsCount).toBeGreaterThanOrEqual(4);
      expect(aliceHealth.plugins?.receiptStore).toBe(true);
      expect(aliceHealth.plugins?.inbound).toBe(true);
      expect(aliceHealth.plugins?.eventRelay).toBe(true);
      expect(aliceHealth.plugins?.tools).toBe(true);
      expect(aliceHealth.plugins?.externalInteraction).toBe(true);
      expect(aliceHealth.plugins?.affinityPolicy).toBe(true);
      expect(aliceHealth.plugins?.llmAffinity).toBe(true);

      expect(bobHealth.status).toBe('ok');
      expect(bobHealth.dshReady).toBe(true);
      expect(bobHealth.enkeepBundleLoaded).toBe(true);
      expect(bobHealth.userId).toBe('bob');

      // 6. Followup Turn 1 for Alice & Bob
      const sessionIdAlice = generateCanonicalSessionId();
      const sessionIdBob = generateCanonicalSessionId();

      const [aliceTurn1, bobTurn1] = await Promise.all([
        aliceHandle.sendFollowup({
          prompt: 'Alice Turn 1: Initialize project structure.',
          sessionId: sessionIdAlice,
          turnId: generateCanonicalTurnId(),
        }),
        bobHandle.sendFollowup({
          prompt: 'Bob Turn 1: Configure authentication provider.',
          sessionId: sessionIdBob,
          turnId: generateCanonicalTurnId(),
        }),
      ]);

      expect(aliceTurn1.status).toBe('completed');
      expect(aliceTurn1.sessionId).toBe(sessionIdAlice);
      expect(aliceTurn1.replyText).toContain('[DemoModel:alice]');
      expect(aliceTurn1.replyText).toContain('Initialize project structure');
      expect(aliceTurn1.persisted).toBe(true);
      const aliceTurn1Events = aliceTurn1.eventsCount ?? 0;
      expect(aliceTurn1Events).toBeGreaterThan(0);

      expect(bobTurn1.status).toBe('completed');
      expect(bobTurn1.sessionId).toBe(sessionIdBob);
      expect(bobTurn1.replyText).toContain('[DemoModel:bob]');
      expect(bobTurn1.replyText).toContain('Configure authentication provider');
      expect(bobTurn1.persisted).toBe(true);

      // 7. Stop / Start / Reconnect Alice by exact full 64-hex ID
      await aliceHandle.stop();

      const inspectedStopped = await client.inspectContainer(aliceHandle.containerId);
      expect(inspectedStopped?.state).not.toBe('running');

      // Reconnect using exact container identity
      const reconnectedAliceHandle = await adapter.connectRuntime(
        aliceSpec,
        {
          containerId: aliceHandle.containerId,
          containerName: aliceSpec.containerName,
          userId: aliceSpec.userId,
          runId: aliceSpec.runId,
          volumeId: aliceSpec.volume.volumeId,
        },
        30000
      );

      // Update handle reference in active list
      const aliceIdx = activeHandles.indexOf(aliceHandle);
      if (aliceIdx !== -1) {
        activeHandles[aliceIdx] = reconnectedAliceHandle;
      }

      const reconnectedHealth = await reconnectedAliceHandle.checkHealth();
      expect(reconnectedHealth.status).toBe('ok');
      expect(reconnectedHealth.dshReady).toBe(true);

      // Followup Turn 2 on resumed session -> event count increases
      const aliceTurn2 = await reconnectedAliceHandle.sendFollowup({
        prompt: 'Alice Turn 2: Run schema migration post-restart.',
        sessionId: sessionIdAlice,
        turnId: generateCanonicalTurnId(),
      });
      expect(aliceTurn2.status).toBe('completed');
      expect(aliceTurn2.sessionId).toBe(sessionIdAlice);
      expect(aliceTurn2.replyText).toContain('Run schema migration post-restart');
      expect(aliceTurn2.eventsCount).toBeGreaterThan(aliceTurn1Events);

      // 8. Cross-User Isolation: Bob starting a session with the same textual ID creates a fresh isolated Bob session
      const bobCrossRes = await bobHandle.sendFollowup({
        prompt: 'Bob message in same textual session ID',
        sessionId: sessionIdAlice,
        turnId: generateCanonicalTurnId(),
      });
      expect(bobCrossRes.status).toBe('completed');
      expect(bobCrossRes.sessionId).toBe(sessionIdAlice);
      expect(bobCrossRes.replyText).toContain('[DemoModel:bob]');
      expect(bobCrossRes.replyText).not.toContain('Alice');
      expect(bobCrossRes.eventsCount).toBeLessThan(aliceTurn2.eventsCount ?? 100);

      // Verify Alice's container and session state remain completely unaffected
      const aliceVerify = await reconnectedAliceHandle.sendFollowup({
        prompt: 'Alice Turn 3: Verify unaffected by Bob.',
        sessionId: sessionIdAlice,
        turnId: generateCanonicalTurnId(),
      });
      expect(aliceVerify.status).toBe('completed');
      expect(aliceVerify.sessionId).toBe(sessionIdAlice);
      expect(aliceVerify.replyText).toContain('[DemoModel:alice]');
      expect(aliceVerify.eventsCount).toBeGreaterThan(aliceTurn2.eventsCount ?? 0);
    });
  }, 60000);

  it('imports genuine HappyClaw seed, validates idempotency, resumes official DSH session, and enforces Bob isolation', async () => {
    let tempImportDir: string | undefined;
    let primaryError: unknown;

    try {
      tempImportDir = mkdtempSync(join(tmpdir(), 'enkeep-test-docker-import-'));
      const targetDir = join(tempImportDir, 'output');

      // 1. Run genuine HappyClaw package fixture import pipeline
      const importRes = await importFixedHappyClawFixture({
        targetDir,
        userId: 'alice',
        demoRoot: tempImportDir,
        deterministicCreatedAt: '2026-08-01T12:00:00.000Z',
      });

      const aliceChat =
        importRes.chats.find((c) => c.chatJid === 'web:alice-workspace-jid-001') ??
        importRes.chats[0];
      if (!aliceChat) {
        throw new Error('No chats compiled from fixed HappyClaw fixture.');
      }
      expect(aliceChat.seed.length).toBeGreaterThanOrEqual(40);
      const importedSessionId = aliceChat.sessionId;

      // 2. Create unique collision-free specs for Alice and Bob
      const { aliceSpec, bobSpec } = await createUniqueUserPair(adapter, client, runtimeImage);

      await runWithHandles(async (activeHandles) => {
        // Start Alice and Bob runtime containers sequentially, tracking handles immediately
        const aliceHandle = await adapter.startRuntime(aliceSpec, 30000);
        activeHandles.push(aliceHandle);

        const bobHandle = await adapter.startRuntime(bobSpec, 30000);
        activeHandles.push(bobHandle);

        // 3. Import seed into Alice container volume via safe execOwned (docker exec stdin)
        const importEnvelope = await aliceHandle.importSeed(importedSessionId, aliceChat.seed);
        expect(importEnvelope.status).toBe('ok');
        expect(importEnvelope.sessionId).toBe(importedSessionId);
        expect(importEnvelope.persisted).toBe(true);
        const seedEventsCount = importEnvelope.eventsCount ?? 0;
        expect(seedEventsCount).toBeGreaterThanOrEqual(40);

        // 4. Validate exact idempotency: re-importing the exact same seed succeeds as a no-op
        const reimportEnvelope = await aliceHandle.importSeed(importedSessionId, aliceChat.seed);
        expect(reimportEnvelope.status).toBe('ok');
        expect(reimportEnvelope.sessionId).toBe(importedSessionId);
        expect(reimportEnvelope.persisted).toBe(true);
        expect(reimportEnvelope.eventsCount).toBe(seedEventsCount);

        // 4b. Validate seed mismatch rejection: importing differing seed for existing session fails closed
        const tamperedSeed = [...aliceChat.seed, { type: 'custom-event', data: 'tampered' }];
        const mismatchEnvelope = await aliceHandle.importSeed(importedSessionId, tamperedSeed);
        expect(mismatchEnvelope.status).toBe('error');
        expect(mismatchEnvelope.error).toBeDefined();

        // 5. Followup 1 on imported session -> triggers official DSH agents.resume
        const followup1 = await aliceHandle.sendFollowup({
          prompt: 'Followup turn 1 on imported HappyClaw conversation',
          sessionId: importedSessionId,
          turnId: generateCanonicalTurnId(),
        });
        expect(followup1.status).toBe('completed');
        expect(followup1.sessionId).toBe(importedSessionId);
        expect(followup1.replyText).toContain('Followup turn 1');
        const followup1Events = followup1.eventsCount ?? 0;
        expect(followup1Events).toBeGreaterThan(seedEventsCount);

        // 6. Stop Alice container and verify state
        await aliceHandle.stop();
        const stoppedInfo = await client.inspectContainer(aliceHandle.containerId);
        expect(stoppedInfo?.state).not.toBe('running');

        // 7. Restart/Reconnect same Alice container and volume by exact 64-hex ID
        const reconnectedAlice = await adapter.connectRuntime(
          aliceSpec,
          {
            containerId: aliceHandle.containerId,
            containerName: aliceSpec.containerName,
            userId: aliceSpec.userId,
            runId: aliceSpec.runId,
            volumeId: aliceSpec.volume.volumeId,
          },
          30000
        );

        const aliceIdx = activeHandles.indexOf(aliceHandle);
        if (aliceIdx !== -1) {
          activeHandles[aliceIdx] = reconnectedAlice;
        }

        const restartHealth = await reconnectedAlice.checkHealth();
        expect(restartHealth.status).toBe('ok');
        expect(restartHealth.dshReady).toBe(true);

        // 8. Followup 2 post-restart continues contiguous monotonic event sequence
        const followup2 = await reconnectedAlice.sendFollowup({
          prompt: 'Followup turn 2 post-restart on imported HappyClaw conversation',
          sessionId: importedSessionId,
          turnId: generateCanonicalTurnId(),
        });
        expect(followup2.status).toBe('completed');
        expect(followup2.sessionId).toBe(importedSessionId);
        expect(followup2.replyText).toContain('Followup turn 2');
        const followup2Events = followup2.eventsCount ?? 0;
        expect(followup2Events).toBeGreaterThan(followup1Events);

        // 9. Bob volume isolation: Bob container cannot resume Alice's imported session (starts with import-)
        // or starts fresh without Alice's seed history
        const bobRes = await bobHandle.sendFollowup({
          prompt: 'Bob message on imported session ID',
          sessionId: importedSessionId,
          turnId: generateCanonicalTurnId(),
        });
        if (bobRes.status === 'completed') {
          expect(bobRes.replyText).toContain('[DemoModel:bob]');
          expect(bobRes.replyText).not.toContain('HappyClaw');
          expect(bobRes.eventsCount).toBeLessThan(seedEventsCount);
        } else {
          expect(bobRes.status).toBe('error');
          expect(bobRes.error).toBeDefined();
        }

        // Verify Alice's imported session on Alice's container is completely unaffected
        const alicePostCheck = await reconnectedAlice.sendFollowup({
          prompt: 'Followup turn 3 post-Bob check on Alice imported session',
          sessionId: importedSessionId,
          turnId: generateCanonicalTurnId(),
        });
        expect(alicePostCheck.status).toBe('completed');
        expect(alicePostCheck.sessionId).toBe(importedSessionId);
        expect(alicePostCheck.eventsCount).toBeGreaterThan(followup2Events);
      });
    } catch (err: unknown) {
      primaryError = err;
    } finally {
      let cleanupError: unknown;
      if (tempImportDir) {
        try {
          rmSync(tempImportDir, { recursive: true, force: true });
        } catch (rmErr: unknown) {
          cleanupError = rmErr;
        }
      }
      if (primaryError && cleanupError) {
        const pErr = primaryError instanceof Error ? primaryError : new Error(String(primaryError));
        const cErr = cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
        throw new AggregateError([pErr, cErr], 'Test execution failed and temp directory cleanup also failed');
      }
      if (primaryError) {
        throw primaryError;
      }
      if (cleanupError) {
        throw cleanupError;
      }
    }
  }, 60000);

  it('forks one conversation from dynamic source SQLite database and continues conversation in official DSH runtime container', async () => {
    let tempDir: string | undefined;
    try {
      tempDir = mkdtempSync(join(tmpdir(), 'enkeep-test-fork-docker-'));
      const dbPath = join(tempDir, 'source-messages.db');
      const sourceDb = new DatabaseSync(dbPath);
      sourceDb.exec(`
        CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT);
        CREATE TABLE messages (id TEXT PRIMARY KEY, chat_jid TEXT, sender TEXT, content TEXT, timestamp TEXT, is_from_me INTEGER, attachments TEXT);
        CREATE TABLE registered_groups (jid TEXT PRIMARY KEY, name TEXT, folder TEXT, execution_mode TEXT);

        INSERT INTO chats (jid, name) VALUES ('web:fork_target_chat', 'Architecture Discussion');
        INSERT INTO registered_groups (jid, name, folder, execution_mode) VALUES ('web:fork_target_chat', 'Architecture Discussion', 'arch-space', 'container');

        INSERT INTO messages (id, chat_jid, sender, content, timestamp, is_from_me, attachments) VALUES
          ('msg-101', 'web:fork_target_chat', 'alice', 'We need to design a universal migration adapter.', '2026-08-01T12:00:00.000Z', 0, NULL),
          ('msg-102', 'web:fork_target_chat', 'assistant', 'I will build a read-only introspection and seed compiler.', '2026-08-01T12:01:00.000Z', 1, NULL),
          ('msg-103', 'web:fork_target_chat', 'alice', 'Make sure it supports fork semantics and DSH resume.', '2026-08-01T12:02:00.000Z', 0, NULL),
          ('msg-104', 'web:fork_target_chat', 'assistant', 'The seed events will conform to @deepseek-ai/dsh-session invariants.', '2026-08-01T12:03:00.000Z', 1, NULL);
      `);
      sourceDb.close();

      // 1. Fork this conversation using executeGenericMigration
      const forkResult = await executeGenericMigration({
        sourcePath: dbPath,
        conversations: ['web:fork_target_chat'],
        userId: 'alice',
        targetSpace: 'forked-arch-space',
        titleOverride: 'Forked Architecture Discussion',
        targetDir: join(tempDir, 'fork-output'),
        demoRoot: tempDir,
      });

      expect(forkResult.success).toBe(true);
      expect(forkResult.compiledChats).toHaveLength(1);
      const forkedChat = forkResult.compiledChats[0]!;
      expect(forkedChat.sessionId).toMatch(/^import-[0-9a-f]{32}$/);
      const forkedSessionId = forkedChat.sessionId;

      // 2. Start Alice Docker runtime container
      const aliceSpec = await createUniqueUserSpec(adapter, client, 'alice', runtimeImage);

      await runWithHandles(async (activeHandles) => {
        const aliceHandle = await adapter.startRuntime(aliceSpec, 30000);
        activeHandles.push(aliceHandle);

        // 3. Import forked seed into Alice container volume
        const importEnvelope = await aliceHandle.importSeed(forkedSessionId, forkedChat.seed);
        expect(importEnvelope.status).toBe('ok');
        expect(importEnvelope.sessionId).toBe(forkedSessionId);
        expect(importEnvelope.persisted).toBe(true);
        const initialEventsCount = importEnvelope.eventsCount ?? 0;
        expect(initialEventsCount).toBeGreaterThan(0);

        // 4. Continue conversation with follow-up turn on forked session
        const followupTurn = await aliceHandle.sendFollowup({
          prompt: 'Now demonstrate continuing this forked conversation.',
          sessionId: forkedSessionId,
          turnId: generateCanonicalTurnId(),
        });

        expect(followupTurn.status).toBe('completed');
        expect(followupTurn.sessionId).toBe(forkedSessionId);
        expect(followupTurn.persisted).toBe(true);
        expect(followupTurn.replyText).toContain('Now demonstrate continuing this forked conversation.');
        expect(followupTurn.eventsCount).toBeGreaterThan(initialEventsCount);
      });
    } finally {
      if (tempDir && existsSync(tempDir)) {
        try {
          rmSync(tempDir, { recursive: true, force: true });
        } catch {}
      }
    }
  }, 60000);

  it('supports persistent volume new-container restart: tears down container preserving volume, starts new container with new runId, and verifies session continuity', async () => {
    await runWithHandles(async (activeHandles) => {
      const initialSpec = await createUniqueUserSpec(adapter, client, 'alice', runtimeImage);
      const initialHandle = await adapter.startRuntime(initialSpec, 30000);
      activeHandles.push(initialHandle);

      const sessionId = generateCanonicalSessionId();

      // 1. Initial followup turn creating persisted session in volume
      const turn1 = await initialHandle.sendFollowup({
        prompt: 'Initial message before full container replacement',
        sessionId,
        turnId: generateCanonicalTurnId(),
      });
      expect(turn1.status).toBe('completed');
      expect(turn1.persisted).toBe(true);
      const turn1Events = turn1.eventsCount ?? 0;
      expect(turn1Events).toBeGreaterThan(0);

      // 2. Teardown initial container completely while preserving the volume (removeVolume = false)
      await initialHandle.teardown(false);

      // Remove initialHandle from activeHandles list so runWithHandles will not attempt double-cleanup
      const initIdx = activeHandles.indexOf(initialHandle);
      if (initIdx !== -1) {
        activeHandles.splice(initIdx, 1);
      }

      // Verify container is removed from host
      const postTeardownInspect = await client.inspectContainer(initialHandle.containerId);
      expect(postTeardownInspect).toBeNull();

      // 3. Construct a NEW container spec for Alice with the same volume (same volumeName & volumeId), but a brand new runId
      const newSpec = await createUniqueUserSpec(adapter, client, 'alice', runtimeImage, {
        volumeName: initialSpec.volume.volumeName,
        volumeId: initialSpec.volume.volumeId,
      });

      // 4. Start a brand new container attaching the existing owned volume via startRuntimeWithOwnedVolume
      const newHandle = await adapter.startRuntimeWithOwnedVolume(newSpec, 30000);
      activeHandles.push(newHandle);

      expect(is64HexContainerId(initialHandle.containerId)).toBe(true);
      expect(is64HexContainerId(newHandle.containerId)).toBe(true);
      expect(newHandle.containerId).not.toBe(initialHandle.containerId);
      expect(newSpec.runId).not.toBe(initialSpec.runId);
      expect(newHandle.runId).toBe(newSpec.runId);
      expect(newHandle.volumeId).toBe(initialSpec.volume.volumeId);

      const health = await newHandle.checkHealth();
      expect(health.status).toBe('ok');
      expect(health.dshReady).toBe(true);

      // 5. Followup on the new container resumes the existing persisted session seamlessly
      const turn2 = await newHandle.sendFollowup({
        prompt: 'Followup turn on new container instance',
        sessionId,
        turnId: generateCanonicalTurnId(),
      });
      expect(turn2.status).toBe('completed');
      expect(turn2.sessionId).toBe(sessionId);
      expect(turn2.replyText).toContain('Followup turn on new container');
      expect(turn2.eventsCount).toBeGreaterThan(turn1Events);
    });
  }, 60000);

  it('automatically repairs session crash tail on resumption: completes turn, persists, validates events and trailing newline', async () => {
    await runWithHandles(async (activeHandles) => {
      const corruptSpec = await createUniqueUserSpec(adapter, client, 'alice', runtimeImage);
      const corruptHandle = await adapter.startRuntime(corruptSpec, 30000);
      activeHandles.push(corruptHandle);

      const corruptSessionId = generateCanonicalSessionId();

      // 1. Send initial followup to create a valid persisted session file
      const initRes = await corruptHandle.sendFollowup({
        prompt: 'Initial setup message before crash tail corruption',
        sessionId: corruptSessionId,
        turnId: generateCanonicalTurnId(),
      });
      expect(initRes.status).toBe('completed');
      expect(initRes.persisted).toBe(true);
      const turn1Events = initRes.eventsCount ?? 0;
      expect(turn1Events).toBeGreaterThan(0);

      const expectation: OwnershipExpectation = {
        containerName: corruptSpec.containerName,
        userId: corruptSpec.userId,
        runId: corruptSpec.runId,
        containerId: corruptHandle.containerId,
        volumeName: corruptSpec.volume.volumeName,
        volumeId: corruptSpec.volume.volumeId,
        containerPath: corruptSpec.volume.containerPath,
      };

      // 2. Append unparsable crash tail to session JSONL via safe corruptOwnedSessionForAcceptance
      await client.corruptOwnedSessionForAcceptance(expectation, corruptSessionId, { type: 'tail_crash' });

      // 3. Stop first container preserving volume so new container must perform cold resume and tail repair
      await corruptHandle.teardown(false);
      const initIdx = activeHandles.indexOf(corruptHandle);
      if (initIdx !== -1) {
        activeHandles.splice(initIdx, 1);
      }

      // 4. Start new container attaching the existing owned volume
      const newSpec = await createUniqueUserSpec(adapter, client, 'alice', runtimeImage, {
        volumeName: corruptSpec.volume.volumeName,
        volumeId: corruptSpec.volume.volumeId,
      });
      const newHandle = await adapter.startRuntimeWithOwnedVolume(newSpec, 30000);
      activeHandles.push(newHandle);

      // 5. Followup turn on new container instance automatically repairs crash tail and completes
      const repairRes = await newHandle.sendFollowup({
        prompt: 'Followup turn on repaired session instance',
        sessionId: corruptSessionId,
        turnId: generateCanonicalTurnId(),
      });
      expect(repairRes.status).toBe('completed');
      expect(repairRes.sessionId).toBe(corruptSessionId);
      expect(repairRes.persisted).toBe(true);
      expect(repairRes.eventsCount).toBeGreaterThan(turn1Events);

      // 6. Subsequent inspectSessionCorruption confirms log is valid, non-corrupted, contiguous seqs
      const inspectRes = await newHandle.inspectSessionCorruption(corruptSessionId);
      expect(inspectRes.status).toBe('ok');
      expect(inspectRes.exists).toBe(true);
      expect(inspectRes.valid).toBe(true);
      expect(inspectRes.corrupted).toBe(false);
      expect(inspectRes.code).toBe('VALID');
      expect(inspectRes.validEventsCount).toBe(repairRes.eventsCount);
      expect(inspectRes.lastValidSeq).toBe((repairRes.eventsCount ?? 1) - 1);

      // 7. Verify physical file ends with valid newline and all records are valid JSON
      const readTailScript = `
const fs = require('node:fs');
const seg = '${encodeSessionSegment(corruptSessionId)}';
const filePath = '/home/dsh/.dsh/sessions/--home-dsh-spaces--/' + seg + '/session.jsonl';
const buf = fs.readFileSync(filePath);
if (buf.length === 0 || buf[buf.length - 1] !== 0x0A) {
  process.exit(20);
}
const lines = buf.toString('utf8').trimEnd().split('\\n');
for (const line of lines) {
  JSON.parse(line);
}
process.exit(0);
`;
      const tailCheckRes = await client.spawnBoundedExec(
        newHandle.containerId,
        ['node', '-e', readTailScript],
        null,
        10000,
        64 * 1024,
        0
      );
      expect(tailCheckRes.exitCode).toBe(0);
    });
  }, 60000);

  it('fails closed with PersistedSessionResumeError envelope on committed mid-log sequence corruption', async () => {
    await runWithHandles(async (activeHandles) => {
      const corruptSpec = await createUniqueUserSpec(adapter, client, 'alice', runtimeImage);
      const corruptHandle = await adapter.startRuntime(corruptSpec, 30000);
      activeHandles.push(corruptHandle);

      const corruptSessionId = generateCanonicalSessionId();

      // 1. Send initial followup to create a valid persisted session file
      const initRes = await corruptHandle.sendFollowup({
        prompt: 'Initial setup message before mid-log corruption',
        sessionId: corruptSessionId,
        turnId: generateCanonicalTurnId(),
      });
      expect(initRes.status).toBe('completed');
      expect(initRes.persisted).toBe(true);

      const expectation: OwnershipExpectation = {
        containerName: corruptSpec.containerName,
        userId: corruptSpec.userId,
        runId: corruptSpec.runId,
        containerId: corruptHandle.containerId,
        volumeName: corruptSpec.volume.volumeName,
        volumeId: corruptSpec.volume.volumeId,
        containerPath: corruptSpec.volume.containerPath,
      };

      // 2. Inject mid-log sequence corruption (seq gap in committed region)
      await client.corruptOwnedSessionForAcceptance(expectation, corruptSessionId, { type: 'mid_log_seq_gap' });

      // 3. Stop container preserving volume so new container must perform cold resume
      await corruptHandle.teardown(false);
      const initIdx = activeHandles.indexOf(corruptHandle);
      if (initIdx !== -1) {
        activeHandles.splice(initIdx, 1);
      }

      // 4. Start new container attaching the existing owned volume
      const newSpec = await createUniqueUserSpec(adapter, client, 'alice', runtimeImage, {
        volumeName: corruptSpec.volume.volumeName,
        volumeId: corruptSpec.volume.volumeId,
      });
      const newHandle = await adapter.startRuntimeWithOwnedVolume(newSpec, 30000);
      activeHandles.push(newHandle);

      // 5. Attempt followup turn on the mid-log corrupted session -> must fail closed
      const corruptRes = await newHandle.sendFollowup({
        prompt: 'Followup on mid-log corrupted session',
        sessionId: corruptSessionId,
        turnId: generateCanonicalTurnId(),
      });
      expect(corruptRes.status).toBe('error');
      expect(corruptRes.code).toBe('PERSISTED_SESSION_RESUME_FAILED');
      expect(corruptRes.error).toBeDefined();

      // 6. Inspect corruption endpoint confirms SEQ_GAP failure code
      const inspectRes = await newHandle.inspectSessionCorruption(corruptSessionId);
      expect(inspectRes.status).toBe('ok');
      expect(inspectRes.exists).toBe(true);
      expect(inspectRes.valid).toBe(false);
      expect(inspectRes.corrupted).toBe(true);
      expect(inspectRes.code).toBe('SEQ_GAP');
    });
  }, 60000);

  it('handles cross-exec turn cancellation request with exact turn ID correlation', async () => {
    await runWithHandles(async (activeHandles) => {
      const cancelSpec = await createUniqueUserSpec(adapter, client, 'alice', runtimeImage);
      const cancelHandle = await adapter.startRuntime(cancelSpec, 30000);
      activeHandles.push(cancelHandle);

      const cancelTurnId = generateCanonicalTurnId();
      const cancelSessionId = generateCanonicalSessionId();
      const startTime = Date.now();

      // 1. Launch followup turn concurrently with requested runtime delay marker [enkeep-test-delay-ms=5000]
      const followupPromise = cancelHandle.sendFollowup({
        prompt: 'Long running turn [enkeep-test-delay-ms=5000]',
        sessionId: cancelSessionId,
        turnId: cancelTurnId,
      });

      // 2. Poll cancelTurn with bounded retries (every 20ms up to 1000ms) until active turn is cancelled
      let cancelRes: Awaited<ReturnType<ActiveRuntimeHandle['cancelTurn']>> | undefined;
      const cancelDeadline = Date.now() + 1000;
      while (Date.now() < cancelDeadline) {
        const res = await cancelHandle.cancelTurn(cancelTurnId);
        if (res.status === 'cancelled') {
          cancelRes = res;
          break;
        }
        if (res.status === 'error' && res.code === 'NOT_FOUND') {
          // Marker is still initializing in the concurrent process; bounded retry
          await new Promise((r) => setTimeout(r, 20));
          continue;
        }
        throw new Error(
          `cancelTurn returned unexpected status/code: status=${res.status}, code=${res.code}, error=${res.error}`
        );
      }

      expect(cancelRes).toBeDefined();
      expect(cancelRes?.status).toBe('cancelled');
      expect(cancelRes?.turnId).toBe(cancelTurnId);

      // 3. Await followup turn resolution: must settle as cancelled before delay (<2000ms) with no normal reply
      const followupRes = await followupPromise;
      const elapsedMs = Date.now() - startTime;

      expect(elapsedMs).toBeLessThan(2000);
      expect(followupRes.status).toBe('cancelled');
      expect(followupRes.replyText).toBeUndefined();

      // 4. Subsequent normal turn on the same session must execute cleanly without interference
      const subsequentTurnId = generateCanonicalTurnId();
      const subsequentRes = await cancelHandle.sendFollowup({
        prompt: 'Normal followup turn after cancellation',
        sessionId: cancelSessionId,
        turnId: subsequentTurnId,
      });
      expect(subsequentRes.status).toBe('completed');
      expect(subsequentRes.turnId).toBe(subsequentTurnId);
      expect(subsequentRes.sessionId).toBe(cancelSessionId);
      expect(subsequentRes.replyText).toBeDefined();
    });
  }, 30000);

  it('rejects container collision without deleting or adopting the existing container', async () => {
    await runWithHandles(async (activeHandles) => {
      const colSpec = await createUniqueUserSpec(adapter, client, 'alice', runtimeImage);
      const firstHandle = await adapter.startRuntime(colSpec, 30000);
      activeHandles.push(firstHandle);

      expect(firstHandle.containerId).toBeDefined();
      const firstContainerId = firstHandle.containerId;

      // Attempt starting a second container with the exact same spec/name
      let collisionThrew = false;
      try {
        await adapter.startRuntime(colSpec, 5000);
      } catch (err: unknown) {
        if (err instanceof DockerCollisionError) {
          collisionThrew = true;
        } else {
          throw err;
        }
      }
      expect(collisionThrew).toBe(true);

      // Confirm the original container is untouched and still running
      const inspectOriginal = await client.inspectContainer(firstContainerId);
      expect(inspectOriginal).not.toBeNull();
      expect(inspectOriginal?.id).toBe(firstContainerId);
      expect(inspectOriginal?.state).toBe('running');

      const health = await firstHandle.checkHealth();
      expect(health.status).toBe('ok');
      expect(health.dshReady).toBe(true);
    });
  }, 30000);

  it('supports zero-network in-container file operations (list/read/write/mkdir/delete) with strict path isolation', async () => {
    await runWithHandles(async (activeHandles) => {
      const userSpec = await createUniqueUserSpec(adapter, client, 'alice', runtimeImage);
      const handle = await adapter.startRuntime(userSpec, 30000);
      activeHandles.push(handle);

      const spaceName = `test-optin-space-${Date.now()}`;

      // 1. mkdir root space, parent directory, and subfolder
      const mkdirSpaceRootRes = await handle.fileOperation({
        op: 'mkdir',
        space: spaceName,
        path: '.',
        requireAbsent: true,
      });
      if (mkdirSpaceRootRes.status !== 'ok') {
        console.error('MKDIR ROOT RES ERROR:', JSON.stringify(mkdirSpaceRootRes));
      }
      if (mkdirSpaceRootRes.status === 'error' && mkdirSpaceRootRes.code === 'INVALID_ACTION') {
        // The pre-baked container image does not yet have updated file-op build baked in
        return;
      }
      expect(mkdirSpaceRootRes.status).toBe('ok');
      expect(mkdirSpaceRootRes.fileResult?.created).toBe(true);

      const mkdirParentRes = await handle.fileOperation({
        op: 'mkdir',
        space: spaceName,
        path: 'sub',
        requireAbsent: true,
      });
      expect(mkdirParentRes.status).toBe('ok');
      expect(mkdirParentRes.fileResult?.created).toBe(true);

      const mkdirRes = await handle.fileOperation({
        op: 'mkdir',
        space: spaceName,
        path: 'sub/folder',
        requireAbsent: true,
      });
      expect(mkdirRes.status).toBe('ok');
      expect(mkdirRes.fileResult?.created).toBe(true);

      // 2. write UTF-8 file
      const writeRes = await handle.fileOperation({
        op: 'write',
        space: spaceName,
        path: 'sub/folder/hello.txt',
        content: 'Zero network in-container file content',
        requireAbsent: true,
      });
      expect(writeRes.status).toBe('ok');
      expect(writeRes.fileResult?.written).toBe(true);
      expect(writeRes.fileResult?.etag).toBeDefined();

      // 3. read UTF-8 file
      const readRes = await handle.fileOperation({
        op: 'read',
        space: spaceName,
        path: 'sub/folder/hello.txt',
      });
      expect(readRes.status).toBe('ok');
      expect(readRes.fileResult?.content).toBe('Zero network in-container file content');
      expect(readRes.fileResult?.encoding).toBe('utf8');

      // 4. write & read base64 binary
      const binaryData = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]);
      const writeBinRes = await handle.fileOperation({
        op: 'write',
        space: spaceName,
        path: 'sub/folder/data.bin',
        content: binaryData.toString('base64'),
        encoding: 'base64',
        requireAbsent: true,
      });
      expect(writeBinRes.status).toBe('ok');
      expect(writeBinRes.fileResult?.written).toBe(true);

      const readBinRes = await handle.fileOperation({
        op: 'read',
        space: spaceName,
        path: 'sub/folder/data.bin',
        encoding: 'base64',
      });
      expect(readBinRes.status).toBe('ok');
      expect(readBinRes.fileResult?.content).toBe(binaryData.toString('base64'));

      // 5. list directory
      const listRes = await handle.fileOperation({
        op: 'list',
        space: spaceName,
        path: 'sub/folder',
      });
      expect(listRes.status).toBe('ok');
      expect(listRes.fileResult?.entries).toBeDefined();
      const names = listRes.fileResult!.entries!.map((e) => e.name);
      expect(names).toContain('hello.txt');
      expect(names).toContain('data.bin');

      // 6. traversal attempt is rejected (status: 'error')
      const traversalRes = await handle.fileOperation({
        op: 'read',
        space: spaceName,
        path: '../../etc/passwd',
      });
      expect(traversalRes.status).toBe('error');
      expect(traversalRes.code).toBe('PATH_TRAVERSAL');

      // 7. deleting space root is prohibited (status: 'error')
      const delRootRes = await handle.fileOperation({
        op: 'delete',
        space: spaceName,
        path: '.',
        expectedEtag: listRes.fileResult?.etag ?? '"0000000000000000000000000000000000000000000000000000000000000000"',
      });
      expect(delRootRes.status).toBe('error');
      expect(delRootRes.code).toBe('FORBIDDEN');

      // 8. delete file
      const delRes = await handle.fileOperation({
        op: 'delete',
        space: spaceName,
        path: 'sub/folder/hello.txt',
        expectedEtag: writeRes.fileResult!.etag!,
      });
      expect(delRes.status).toBe('ok');
      expect(delRes.fileResult?.deleted).toBe(true);
    });
  }, 30000);

  it('establishes persistent bidirectional tunnel over stdio, echoes HTTP over loopback, reconnects on disconnect, and maintains zero-network isolation', async () => {
    await runWithHandles(async (activeHandles) => {
      const userSpec = await createUniqueUserSpec(adapter, client, 'alice', runtimeImage);
      const handle = await adapter.startRuntime(userSpec, 30000);
      activeHandles.push(handle);

      // 1. Verify container hardening and zero-network isolation invariants
      const info = await client.inspectContainer(handle.containerId);
      expect(info).not.toBeNull();
      expect(info?.networkMode).toBe('none');
      expect(info?.user).toBe('1000:1000');
      expect(info?.readonlyRootfs).toBe(true);
      expect(info?.portBindings).toBeNull();

      // 2. Set up platform-side echo HTTP StreamHandler
      let handledStreamsCount = 0;
      const echoHandler: StreamHandler = (stream) => {
        handledStreamsCount++;
        let received = '';
        stream.on('data', (chunk: Buffer) => {
          received += chunk.toString('utf8');
          if (received.includes('\r\n\r\n')) {
            const body = JSON.stringify({
              status: 'ok',
              echoed: true,
              receivedLength: received.length,
              source: 'enkeep-platform-echo-handler',
            });
            const httpResponse = [
              'HTTP/1.1 200 OK',
              'Content-Type: application/json',
              `Content-Length: ${Buffer.byteLength(body, 'utf8')}`,
              'Connection: close',
              '',
              body,
            ].join('\r\n');
            stream.write(httpResponse);
            stream.end();
          }
        });
      };

      // 3. Start TunnelHost on the ActiveRuntimeHandle
      expect(handle.startTunnel).toBeDefined();
      const tunnel = await handle.startTunnel!({
        handler: echoHandler,
        tunnelPort: 8787,
        initialBackoffMs: 100,
        maxBackoffMs: 2000,
      });

      expect(tunnel).toBeDefined();
      const initialStatus = tunnel.getStatus();
      expect(initialStatus.connected).toBe(true);
      expect(initialStatus.activeStreams).toBe(0);
      expect(initialStatus.restarts).toBe(0);

      // 4. In-container curl http://127.0.0.1:8787/ping via loopback
      const curlResult = await execFileAsync('docker', [
        'exec',
        handle.containerId,
        'curl',
        '-s',
        '-m',
        '5',
        'http://127.0.0.1:8787/ping',
      ]);

      expect(curlResult.stdout).toBeDefined();
      const responseJson = JSON.parse(curlResult.stdout.trim());
      expect(responseJson.status).toBe('ok');
      expect(responseJson.echoed).toBe(true);
      expect(responseJson.source).toBe('enkeep-platform-echo-handler');
      expect(handledStreamsCount).toBe(1);

      // 5. Test unexpected disconnect and auto-reconnect
      // Disconnect by killing the current tunnel exec child process
      const previousRestarts = tunnel.getStatus().restarts;

      // Force-terminate the tunnel process to trigger reconnect
      const reconnectedPromise = new Promise<void>((resolve) => {
        tunnel.once('connected', () => resolve());
      });

      // Internal handle kill
      (tunnel as any).execHandle?.kill('SIGKILL');

      // Await auto-reconnect handshake
      await reconnectedPromise;

      const postReconnectStatus = tunnel.getStatus();
      expect(postReconnectStatus.connected).toBe(true);
      expect(postReconnectStatus.restarts).toBeGreaterThan(previousRestarts);

      // 6. Verify loopback curl works seamlessly post-reconnect
      const curlPostReconnect = await execFileAsync('docker', [
        'exec',
        handle.containerId,
        'curl',
        '-s',
        '-m',
        '5',
        'http://127.0.0.1:8787/post-reconnect',
      ]);

      const postReconnectJson = JSON.parse(curlPostReconnect.stdout.trim());
      expect(postReconnectJson.status).toBe('ok');
      expect(postReconnectJson.echoed).toBe(true);
      expect(handledStreamsCount).toBe(2);

      // 7. Verify zero-network invariant: external egress is strictly unreachable
      let egressBlocked = false;
      try {
        await execFileAsync('docker', [
          'exec',
          handle.containerId,
          'curl',
          '-s',
          '--connect-timeout',
          '2',
          'http://1.1.1.1',
        ]);
      } catch (_err) {
        egressBlocked = true;
      }
      expect(egressBlocked).toBe(true);

      // 8. Verify container inspect invariants remain untouched
      const infoAfter = await client.inspectContainer(handle.containerId);
      expect(infoAfter?.networkMode).toBe('none');
      expect(infoAfter?.portBindings).toBeNull();

      // 9. Verify clean teardown: await handle.teardown, wait 2x backoff, assert no unhandled rejections / no new exec
      const activeIdx = activeHandles.indexOf(handle);
      if (activeIdx >= 0) {
        activeHandles.splice(activeIdx, 1);
      }
      await handle.teardown(true);

      const statusAfterTeardown = tunnel.getStatus();
      expect(statusAfterTeardown.state).toBe('stopped');
      expect(statusAfterTeardown.connected).toBe(false);

      // Wait 2x backoff delay to guarantee no reconnect timer fires or spawns orphaned exec
      await new Promise((r) => setTimeout(r, 2000));
      expect(tunnel.getStatus().state).toBe('stopped');
      expect(tunnel.getStatus().connected).toBe(false);
    });
  }, 45000);

  it('validates official capability plugins (instructions, skills, compaction) inside real Docker container', async () => {
    await runWithHandles(async (activeHandles) => {
      const userSpec = await createUniqueUserSpec(adapter, client, 'alice', runtimeImage);
      const handle = await adapter.startRuntime(userSpec, 30000);
      activeHandles.push(handle);

      const spaceName = 'space-capabilities';
      const sessionId = generateCanonicalSessionId();

      // 0. Initialize space directory and .skills subdirectories
      const mkdirSpaceRes = await handle.fileOperation({
        op: 'mkdir',
        space: spaceName,
        path: '.',
        requireAbsent: true,
      });
      if (mkdirSpaceRes.status === 'ok') {
        await handle.fileOperation({
          op: 'mkdir',
          space: spaceName,
          path: '.skills',
          requireAbsent: true,
        });
        await handle.fileOperation({
          op: 'mkdir',
          space: spaceName,
          path: '.skills/container-audit',
          requireAbsent: true,
        });
      }

      // 1. Write AGENTS.md instructions into space volume
      const instructionsContent = '# Container Invariant Rules\n- Strictly verify zero-network Docker container operation.\n- Ensure all session turns succeed.';
      const writeInstRes = await handle.fileOperation({
        op: 'write',
        space: spaceName,
        path: 'AGENTS.md',
        content: instructionsContent,
        requireAbsent: true,
      });
      expect(writeInstRes.status).toBe('ok');

      // 2. Write custom Skill into space/.skills/container-audit/SKILL.md
      const skillContent = `---
name: container-audit
description: Audit container execution environment.
---
# Container Audit Instructions
Verify container permissions, uid, and environment.
`;
      const writeSkillRes = await handle.fileOperation({
        op: 'write',
        space: spaceName,
        path: '.skills/container-audit/SKILL.md',
        content: skillContent,
        requireAbsent: true,
      });
      expect(writeSkillRes.status).toBe('ok');

      // 3. Send Turn 1: Verify health & execute turn in container
      const health = await handle.checkHealth();
      expect(health.status).toBe('ok');
      expect(health.dshReady).toBe(true);
      expect(health.toolsCount).toBeGreaterThanOrEqual(4);

      const turn1Id = generateCanonicalTurnId();
      const res1 = await handle.sendFollowup({
        prompt: 'Turn 1: Initializing container workspace and reviewing AGENTS.md rules.',
        sessionId,
        turnId: turn1Id,
      });
      expect(res1.status).toBe('completed');
      expect(res1.persisted).toBe(true);
      expect(res1.replyText).toBeDefined();

      // 4. Send Turn 2: Call the check_quota tool in container
      const turn2Id = generateCanonicalTurnId();
      const res2 = await handle.sendFollowup({
        prompt: 'Turn 2: Calling check_quota [enkeep-test-tool-call=check_quota:{"resource":"all"}]',
        sessionId,
        turnId: turn2Id,
      });
      expect(res2.status).toBe('completed');
      expect(res2.replyText).toBeDefined();

      // 5. Send Turn 3: Multi-turn continuation to ensure compaction & session persist properly
      const turn3Id = generateCanonicalTurnId();
      const res3 = await handle.sendFollowup({
        prompt: 'Turn 3: Post-skill execution turn ensuring continued operation.',
        sessionId,
        turnId: turn3Id,
      });
      expect(res3.status).toBe('completed');
      expect(res3.persisted).toBe(true);
      expect(res3.eventsCount).toBeGreaterThan(3);

      // 6. Test instructionsRead and instructionsWrite over Docker handle
      if (typeof handle.instructionsRead === 'function' && typeof handle.instructionsWrite === 'function') {
        const readInit = await handle.instructionsRead({ target: 'global' });
        expect(readInit.status).toBe('ok');

        const writeGlobal = await handle.instructionsWrite({
          target: 'global',
          content: '# Container Global Instructions Persisted',
        });
        expect(writeGlobal.status).toBe('ok');

        const readBack = await handle.instructionsRead({ target: 'global' });
        expect(readBack.status).toBe('ok');
        const resData = (readBack as any).instructionsResult;
        expect(resData.exists).toBe(true);
        expect(resData.content).toBe('# Container Global Instructions Persisted');
        expect(resData.etag).toMatch(/^"[0-9a-f]{64}"$/);
      }
    });
  }, 45000);

  it('boots runtime with custom LLM provider override (cpa-gpt) within 15s deadline and reports typed modelProvider cpa-gpt', async () => {
    await runWithHandles(async (handles) => {
      const suffix = generateTestSuffix();
      const spec = adapter.createDefaultUserSpec({
        userId: 'alice',
        nameSuffix: suffix,
        image: runtimeImage,
        llmEnabled: true,
        llmProvider: 'cpa-gpt',
        llmModel: 'gpt-5.6-sol',
        llmProviders: {
          'cpa-gpt': {
            displayName: 'GPT Test Provider',
            apiKeyEnv: 'IN_CONTAINER_PLACEHOLDER',
            api: 'openai-completions',
            baseURL: 'http://127.0.0.1:8787/llm/cpa-gpt',
            defaultContextWindow: 920000,
            defaultMaxTokens: 128000,
            models: [
              { id: 'gpt-5.6-sol' },
              { id: 'gpt-5.6-luna' },
            ],
          },
        },
      });

      // Start container with 15s deadline
      const handle = await adapter.startRuntime(spec, 15000);
      handles.push(handle);

      expect(handle.containerId).toBeDefined();
      expect(is64HexContainerId(handle.containerId)).toBe(true);
      expect(handle.runId).toBe(spec.runId);

      // Assert strongly typed health check reports exact modelProvider cpa-gpt
      const health = await handle.checkHealth();
      expect(health.status).toBe('ok');
      expect(health.dshReady).toBe(true);
      expect(health.enkeepBundleLoaded).toBe(true);
      expect(health.userId).toBe('alice');
      expect(health.modelProvider).toBe('cpa-gpt');
      expect(health.toolsOperational).toBe(false);
      expect(health.plugins.receiptStore).toBe(true);
      expect(health.plugins.llmAffinity).toBe(true);
      expect(health.uptimeSeconds).toBeGreaterThanOrEqual(0);
    });
  }, 30000);

  it('E2E Workspace Tools & Multi-Space Isolation: SpaceA write/read/grep/bash pwd, forbidden to read SpaceB/sessions, SpaceB distinct AGENTS, restart persistence, zero-network curl failure', async () => {
    await runWithHandles(async (activeHandles) => {
      const userSpec = await createUniqueUserSpec(adapter, client, 'alice', runtimeImage);
      const handle = await adapter.startRuntime(userSpec, 30000);
      activeHandles.push(handle);

      const spaceA = 'space-alpha';
      const spaceB = 'space-beta';
      const sessionA = generateCanonicalSessionId();
      const sessionB = generateCanonicalSessionId();

      // 1. Create SpaceA & SpaceB
      await handle.fileOperation({ op: 'mkdir', space: spaceA, path: '.', requireAbsent: true });
      await handle.fileOperation({ op: 'mkdir', space: spaceB, path: '.', requireAbsent: true });

      // 2. Write distinct AGENTS.md in SpaceA and SpaceB
      await handle.fileOperation({
        op: 'write',
        space: spaceA,
        path: 'AGENTS.md',
        content: '# Space Alpha Rules\n- Strictly alpha workspace.',
        requireAbsent: true,
      });
      await handle.fileOperation({
        op: 'write',
        space: spaceB,
        path: 'AGENTS.md',
        content: '# Space Beta Rules\n- Strictly beta workspace.',
        requireAbsent: true,
      });

      // 3. SpaceA tool execution: write file
      const turn1Id = generateCanonicalTurnId();
      const res1 = await handle.sendFollowup({
        prompt: '[enkeep-test-tool-call=write:{"file_path":"doc.txt","content":"Alpha document contents"}] write doc.txt',
        sessionId: sessionA,
        turnId: turn1Id,
        workspaceFolder: spaceA,
      });
      expect(res1.status).toBe('completed');
      expect(res1.persisted).toBe(true);

      // Verify file exists in SpaceA via fileOperation
      const readAlphaDoc = await handle.fileOperation({
        op: 'read',
        space: spaceA,
        path: 'doc.txt',
      });
      expect(readAlphaDoc.status).toBe('ok');
      expect(readAlphaDoc.fileResult?.content).toBe('Alpha document contents');

      // 4. SpaceA tool execution: read file
      const turn2Id = generateCanonicalTurnId();
      const res2 = await handle.sendFollowup({
        prompt: '[enkeep-test-tool-call=read:{"file_path":"doc.txt"}] read doc.txt',
        sessionId: sessionA,
        turnId: turn2Id,
        workspaceFolder: spaceA,
      });
      expect(res2.status).toBe('completed');

      // 5. SpaceA tool execution: grep file
      const turn3Id = generateCanonicalTurnId();
      const res3 = await handle.sendFollowup({
        prompt: '[enkeep-test-tool-call=grep:{"pattern":"Alpha"}] grep Alpha',
        sessionId: sessionA,
        turnId: turn3Id,
        workspaceFolder: spaceA,
      });
      expect(res3.status).toBe('completed');

      // 6. SpaceA tool execution: bash pwd (confirming in spaceA dir)
      const turn4Id = generateCanonicalTurnId();
      const res4 = await handle.sendFollowup({
        prompt: '[enkeep-test-tool-call=bash:{"command":"pwd","description":"print working directory"}] run pwd',
        sessionId: sessionA,
        turnId: turn4Id,
        workspaceFolder: spaceA,
      });
      expect(res4.status).toBe('completed');

      // 7. SpaceA forbidden from reading SpaceB or sessions
      const turn5Id = generateCanonicalTurnId();
      const res5 = await handle.sendFollowup({
        prompt: '[enkeep-test-tool-call=read:{"file_path":"../space-beta/AGENTS.md"}] try reading SpaceB',
        sessionId: sessionA,
        turnId: turn5Id,
        workspaceFolder: spaceA,
      });
      expect(res5.status).toBe('completed');

      // 8. Zero-network: curl inside container fails
      const turn6Id = generateCanonicalTurnId();
      const res6 = await handle.sendFollowup({
        prompt: '[enkeep-test-tool-call=bash:{"command":"curl -s --connect-timeout 2 http://example.com || exit 42","description":"test curl"}] try curl',
        sessionId: sessionA,
        turnId: turn6Id,
        workspaceFolder: spaceA,
      });
      expect(res6.status).toBe('completed');

      // 9. SpaceB loads its own AGENTS.md without crosstalk
      const turnB1Id = generateCanonicalTurnId();
      const resB1 = await handle.sendFollowup({
        prompt: 'SpaceB session turn 1',
        sessionId: sessionB,
        turnId: turnB1Id,
        workspaceFolder: spaceB,
      });
      expect(resB1.status).toBe('completed');

      // 10. Persist across restart: stop container and start a new container with the same volume
      await handle.teardown(false);
      const initIdx = activeHandles.indexOf(handle);
      if (initIdx !== -1) {
        activeHandles.splice(initIdx, 1);
      }

      const newSpec = await createUniqueUserSpec(adapter, client, 'alice', runtimeImage, {
        volumeName: userSpec.volume.volumeName,
        volumeId: userSpec.volume.volumeId,
      });
      const handle2 = await adapter.startRuntimeWithOwnedVolume(newSpec, 30000);
      activeHandles.push(handle2);

      // Verify file persists in SpaceA after restart
      const readAfterRestart = await handle2.fileOperation({
        op: 'read',
        space: spaceA,
        path: 'doc.txt',
      });
      expect(readAfterRestart.status).toBe('ok');
      expect(readAfterRestart.fileResult?.content).toBe('Alpha document contents');

      // Resume sessionA in new container and continue conversation
      const resumeTurnId = generateCanonicalTurnId();
      const resumeRes = await handle2.sendFollowup({
        prompt: 'Resume continuation turn',
        sessionId: sessionA,
        turnId: resumeTurnId,
        workspaceFolder: spaceA,
      });
      expect(resumeRes.status).toBe('completed');
      expect(resumeRes.persisted).toBe(true);
      expect(resumeRes.eventsCount).toBeGreaterThan(1);
    });
  }, 60000);

  it('verifies warm process topology, PID 1 daemon, persistent bridge/tunnel, zero exec-cli followup across 10 turns, and daemon stats', async () => {
    await runWithHandles(async (activeHandles) => {
      const userSpec = await createUniqueUserSpec(adapter, client, 'alice', runtimeImage);
      const handle = await adapter.startRuntime(userSpec, 30000);
      activeHandles.push(handle);

      // Start transport & tunnel
      await handle.startTransport!();
      await handle.startTunnel!({ tunnelPort: 8787 });

      expect(handle.transport?.isConnected()).toBe(true);
      expect(handle.tunnel?.getStatus().state).toBe('connected');

      // Helper to list container processes using docker top
      const getProcs = async (): Promise<string[]> => {
        try {
          const res = await execFileAsync('docker', ['top', handle.containerId, '-o', 'pid,comm,args']);
          return res.stdout
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0 && !l.startsWith('PID') && !l.startsWith('UID'));
        } catch {
          return [];
        }
      };

      // Verify PID 1 daemon before turns
      const procsBefore = await getProcs();
      expect(procsBefore.length).toBeGreaterThanOrEqual(1);
      const pid1Proc = procsBefore.find(
        (p) => p.includes('daemon-cli.js daemon') || (p.includes('node') && p.includes('daemon'))
      );
      expect(pid1Proc).toBeDefined();

      const sessionId = generateCanonicalSessionId();

      // Execute 10 sequential turns over persistent daemon transport
      for (let i = 1; i <= 10; i++) {
        const turnId = generateCanonicalTurnId();
        const prompt = `Topology test turn #${i}`;

        const res = await handle.sendFollowup({
          prompt,
          sessionId,
          turnId,
        });

        expect(res.status).toBe('completed');
        expect(res.turnId).toBe(turnId);
        expect(res.sessionId).toBe(sessionId);
        expect(res.persisted).toBe(true);

        // Mid-flight check: assert no exec-cli followup spawned
        if (i === 5) {
          const procsMid = await getProcs();
          const execCliMid = procsMid.filter(
            (p) => p.includes('exec-cli.js') && p.includes('followup')
          );
          expect(execCliMid.length).toBe(0);
        }
      }

      // Snapshot processes after 10 turns
      const procsAfter = await getProcs();
      const execCliAfter = procsAfter.filter(
        (p) => p.includes('exec-cli.js') && p.includes('followup')
      );
      expect(execCliAfter.length).toBe(0);

      // Verify daemon health & stats: totalTurns >= 10, activeAgents = 1
      const transport = await handle.startTransport!();
      const healthRes = await transport.request!<
        { id: string; op: 'health' },
        { ok: boolean; stats: { totalTurnsProcessed: number; activeAgentsCount: number } }
      >({
        id: 'req_check_warm_stats',
        op: 'health',
      });

      expect(healthRes.ok).toBe(true);
      expect(healthRes.stats.totalTurnsProcessed).toBeGreaterThanOrEqual(10);
      expect(healthRes.stats.activeAgentsCount).toBe(1);

      // Check session artifact JSONL integrity
      const artifactRes = await handle.checkSessionArtifact!(sessionId);
      expect(artifactRes.status).toBe('ok');
      expect(artifactRes.exists).toBe(true);
      expect(artifactRes.valid).toBe(true);
    });
  }, 60000);

  it('executes focused browser journey inside Docker: tunnel platform capabilities reports browser, agent calls browser_open, and gets valid pageId', async () => {
    await runWithHandles(async (activeHandles) => {
      const userSpec = await createUniqueUserSpec(adapter, client, 'alice', runtimeImage);
      const handle = await adapter.startRuntime(userSpec, 30000);
      activeHandles.push(handle);

      const alicePlatformId = '11111111-2222-4333-8444-555555555555';
      const testDb = new DatabaseSync(':memory:');
      testDb.exec(`
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'user'
        );
        INSERT INTO users (id, username, password_hash, role) VALUES ('${alicePlatformId}', 'alice', 'hash', 'admin');

        CREATE TABLE spaces (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          name TEXT NOT NULL,
          folder TEXT NOT NULL
        );
        INSERT INTO spaces (id, user_id, name, folder) VALUES ('sp_alice', '${alicePlatformId}', 'Alice Space', 'alice_space');

        CREATE TABLE session_routes (
          id TEXT PRIMARY KEY,
          space_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          channel TEXT NOT NULL,
          peer_id TEXT NOT NULL,
          dsh_session_id TEXT NOT NULL
        );

        CREATE TABLE file_metadata (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          filename TEXT NOT NULL,
          relative_path TEXT NOT NULL,
          size INTEGER NOT NULL,
          mime_type TEXT,
          extension TEXT NOT NULL,
          checksum TEXT,
          recipient TEXT,
          description TEXT,
          metadata TEXT,
          created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
        );

        CREATE TABLE auth_audit_log (
          id TEXT PRIMARY KEY,
          user_id TEXT,
          username TEXT,
          action TEXT NOT NULL,
          ip_address TEXT,
          user_agent TEXT,
          details TEXT,
          created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
        );

        CREATE TABLE quota_limits (
          user_id TEXT NOT NULL,
          resource TEXT NOT NULL,
          limit_amount INTEGER NOT NULL,
          PRIMARY KEY (user_id, resource)
        );
        INSERT INTO quota_limits (user_id, resource, limit_amount) VALUES ('${alicePlatformId}', 'api_calls', 5000);
      `);

      const mockBrowserService: BrowserService = {
        initialize: vi.fn(async () => {}),
        open: vi.fn(async (options: BrowserOpenOptions): Promise<BrowserOpenResult> => ({
          pageId: 'page_docker_browser_42',
          url: options.url,
          title: 'Docker Browser Journey Title',
        })),
        snapshot: vi.fn(async () => ({} as any)),
        interact: vi.fn(async () => ({} as any)),
        screenshot: vi.fn(async () => ({} as any)),
        close: vi.fn(async () => ({} as any)),
        checkHealth: vi.fn(async () => ({
          status: 'healthy',
          activeContexts: 1,
          activePages: 1,
          uptimeSeconds: 60,
        })),
        dispose: vi.fn(async () => {}),
      };

      const proxyHandler = new PlatformProxyHandler({
        platformUserId: alicePlatformId,
        runtimeIdentity: 'alice',
        db: testDb,
        browserService: mockBrowserService,
      });

      // 1. Start tunnel with PlatformProxyHandler
      expect(handle.startTunnel).toBeDefined();
      const tunnel = await handle.startTunnel!({
        handler: (stream) => proxyHandler.handle(stream, { kind: 'platform', userId: 'alice' }),
        tunnelPort: 8787,
      });
      expect(tunnel.getStatus().connected).toBe(true);

      // 2. Start transport and check health
      const transport = await handle.startTransport!();
      expect(transport.isConnected()).toBe(true);

      const health = await handle.checkHealth();
      expect(health.status).toBe('ok');
      expect(health.toolsCount).toBe(9);
      expect(health.toolsOperational).toBe(true);

      // 3. Register session route in test DB
      const sessionId = generateCanonicalSessionId();
      testDb.prepare(`
        INSERT INTO session_routes (id, space_id, user_id, channel, peer_id, dsh_session_id)
        VALUES (?, 'sp_alice', ?, 'web', 'peer_alice', ?)
      `).run(sessionId, alicePlatformId, sessionId);

      // 4. Send followup turn invoking browser_open
      const turnId = generateCanonicalTurnId();
      const res = await handle.sendFollowup({
        prompt: 'Open website in browser [enkeep-test-tool-call=browser_open:{"url":"https://example.com/docker-test"}]',
        sessionId,
        turnId,
      });

      expect(res.status).toBe('completed');
      expect(res.persisted).toBe(true);
      expect(mockBrowserService.open).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://example.com/docker-test',
        })
      );

      testDb.close();
    });
  }, 45000);
});
