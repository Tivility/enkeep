/**
 * Real Docker Acceptance Test for Enkeep Demo Runner
 *
 * Runs only under `pnpm --filter @enkeep/demo-runner run test:docker` or `pnpm demo:test`.
 * Never runs under normal unit `pnpm test`.
 *
 * @module @enkeep/demo-runner/tests/docker-acceptance.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { runDemoTestSuite } from '../src/test/index.js';
import { launchDemoSystem, loadAndVerifyFixedSeeds } from '../src/up/index.js';
import { resetDemo } from '../src/reset/index.js';
import { downDemo } from '../src/down/index.js';
import { DockerRuntimeContainerAdapter } from '../src/ports/index.js';
import { probeProtectedPorts, assertProbesUnchanged } from '../src/utils/probes.js';
import { getDemoPathConfig } from '../src/config.js';
import { SafeDockerClient } from '@enkeep/runtime-runner/docker';
import { createTempRepo, type TempRepo } from './support/temp-repo.js';

type ProtectedPortsSnapshot = Awaited<ReturnType<typeof probeProtectedPorts>>;

function generateSuffix12(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12).toLowerCase();
}

describe('Docker Runtime Acceptance Tests (Zero-Network Container Orchestration)', () => {
  let tempRepo: TempRepo | null = null;
  let activeResourceSuffix: string | null = null;
  let runGeneratedMetadata = false;
  let probeBefore: ProtectedPortsSnapshot | null = null;

  let origLlmEnabled: string | undefined;

  beforeEach(() => {
    origLlmEnabled = process.env.ENKEEP_LLM_ENABLED;
  });

  afterEach(async () => {
    if (origLlmEnabled !== undefined) {
      process.env.ENKEEP_LLM_ENABLED = origLlmEnabled;
    } else {
      delete process.env.ENKEEP_LLM_ENABLED;
    }

    const teardownErrors: Error[] = [];

    // Step 1: Call downDemo ONLY if this run generated metadata / started resources
    if (tempRepo && activeResourceSuffix) {
      const paths = getDemoPathConfig({ repoRoot: tempRepo.repoRoot, resourceSuffix: activeResourceSuffix });
      const metadataExists = existsSync(paths.demoDataDir);

      if (runGeneratedMetadata || metadataExists) {
        try {
          const downResult = await downDemo({
            repoRoot: tempRepo.repoRoot,
            resourceSuffix: activeResourceSuffix,
            removeVolumes: true,
          });
          if (!downResult.ok) {
            teardownErrors.push(
              new Error('Teardown reported failure during afterEach downDemo')
            );
          }
        } catch (err: unknown) {
          teardownErrors.push(err instanceof Error ? err : new Error(String(err)));
        }
      }
    }

    // Step 2: Assert no generated exact resources remain after teardown using in-memory names (no sweep)
    if (activeResourceSuffix) {
      try {
        const dockerClient = new SafeDockerClient();
        const isDockerAvailable = await dockerClient.isDockerAvailable();
        if (!isDockerAvailable) {
          teardownErrors.push(
            new Error('FAIL-CLOSED: Docker daemon unavailable during afterEach resource leak verification')
          );
        } else {
          const aliceContainer = `enkeep-demo-alice-${activeResourceSuffix}`;
          const bobContainer = `enkeep-demo-bob-${activeResourceSuffix}`;
          const charlieContainer = `enkeep-demo-charlie_new-${activeResourceSuffix}`;
          const aliceVol = `enkeep-demo-dsh-alice-${activeResourceSuffix}`;
          const bobVol = `enkeep-demo-dsh-bob-${activeResourceSuffix}`;
          const charlieVol = `enkeep-demo-dsh-charlie_new-${activeResourceSuffix}`;

          const [cA, cB, cC, vA, vB, vC] = await Promise.all([
            dockerClient.inspectContainer(aliceContainer),
            dockerClient.inspectContainer(bobContainer),
            dockerClient.inspectContainer(charlieContainer),
            dockerClient.inspectVolume(aliceVol),
            dockerClient.inspectVolume(bobVol),
            dockerClient.inspectVolume(charlieVol),
          ]);

          if (cA !== null) {
            teardownErrors.push(new Error(`LEAK DETECTED: Container "${aliceContainer}" still exists after teardown`));
          }
          if (cB !== null) {
            teardownErrors.push(new Error(`LEAK DETECTED: Container "${bobContainer}" still exists after teardown`));
          }
          if (cC !== null) {
            teardownErrors.push(new Error(`LEAK DETECTED: Container "${charlieContainer}" still exists after teardown`));
          }
          if (vA !== null) {
            teardownErrors.push(new Error(`LEAK DETECTED: Volume "${aliceVol}" still exists after teardown`));
          }
          if (vB !== null) {
            teardownErrors.push(new Error(`LEAK DETECTED: Volume "${bobVol}" still exists after teardown`));
          }
          if (vC !== null) {
            teardownErrors.push(new Error(`LEAK DETECTED: Volume "${charlieVol}" still exists after teardown`));
          }
        }
      } catch (err: unknown) {
        teardownErrors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }

    // Step 3: Protected ports probe after teardown (ALWAYS executed in afterEach)
    if (probeBefore) {
      try {
        const probeAfter = await probeProtectedPorts();
        const probeComparison = assertProbesUnchanged(probeBefore, probeAfter);
        if (!probeComparison.unchanged) {
          teardownErrors.push(
            new Error(`Safety Violation: Protected services disrupted:\n${probeComparison.discrepancies.join('\n')}`)
          );
        }
      } catch (err: unknown) {
        teardownErrors.push(err instanceof Error ? err : new Error(String(err)));
      } finally {
        probeBefore = null;
      }
    }

    // Step 4: Clean up temp root directory ONLY after verified down (cannot cleanup if evidence remains)
    if (tempRepo) {
      if (teardownErrors.length === 0) {
        try {
          tempRepo.cleanup();
        } catch (err: unknown) {
          teardownErrors.push(err instanceof Error ? err : new Error(String(err)));
        }
      } else {
        console.error(
          `[DockerAcceptance] Preserving temporary repo root "${tempRepo.repoRoot}" due to teardown errors / resource leaks.`
        );
      }
    }

    // Reset run tracking state
    tempRepo = null;
    activeResourceSuffix = null;
    runGeneratedMetadata = false;

    if (teardownErrors.length > 0) {
      if (teardownErrors.length === 1) {
        throw teardownErrors[0];
      }
      throw new AggregateError(
        teardownErrors,
        `afterEach teardown encountered errors:\n${teardownErrors.map((e) => e.message).join('\n')}`
      );
    }
  });

  it('runs complete E2E demo test suite against real Docker containers (Alice + Bob)', async () => {
    // 1. Mandatory runtime image check (defaults to exact acceptance image)
    const rawRuntimeImage = process.env.ENKEEP_RUNTIME_IMAGE?.trim() || 'enkeep-demo-runtime:acceptance';
    const acceptanceImagePattern = /^(enkeep-demo-runtime:(acceptance|latest)|enkeep-dsh-0\.1\.2-rc\.1-canary(:latest)?)$/;
    if (!acceptanceImagePattern.test(rawRuntimeImage)) {
      throw new Error(
        `FAIL-CLOSED: Invalid runtime image "${rawRuntimeImage}". Acceptance tests require "enkeep-demo-runtime:acceptance", "enkeep-demo-runtime:latest", or "enkeep-dsh-0.1.2-rc.1-canary".`
      );
    }
    const runtimeImage = rawRuntimeImage;

    // 2. Mandatory Docker availability check
    const dockerClient = new SafeDockerClient();
    const isDockerAvailable = await dockerClient.isDockerAvailable();
    if (!isDockerAvailable) {
      throw new Error('FAIL-CLOSED: Docker daemon is unavailable. Real Docker acceptance tests require an active daemon.');
    }

    // 3. Exact protected port probe snapshot before test
    probeBefore = await probeProtectedPorts();

    // 4. Initialize hermetic isolated temp repo with random 12-char resource suffix
    const resourceSuffix = generateSuffix12();
    activeResourceSuffix = resourceSuffix;
    tempRepo = createTempRepo();

    // 5. Pre-inspect exact generated names/volumes and FAIL ON COLLISION, never delete
    const expectedAliceContainer = `enkeep-demo-alice-${resourceSuffix}`;
    const expectedBobContainer = `enkeep-demo-bob-${resourceSuffix}`;
    const expectedAliceVol = `enkeep-demo-dsh-alice-${resourceSuffix}`;
    const expectedBobVol = `enkeep-demo-dsh-bob-${resourceSuffix}`;

    const [preAliceCont, preBobCont, preAliceVol, preBobVol] = await Promise.all([
      dockerClient.inspectContainer(expectedAliceContainer),
      dockerClient.inspectContainer(expectedBobContainer),
      dockerClient.inspectVolume(expectedAliceVol),
      dockerClient.inspectVolume(expectedBobVol),
    ]);

    if (preAliceCont !== null) {
      throw new Error(`FAIL-CLOSED: Pre-flight collision detected. Container "${expectedAliceContainer}" already exists.`);
    }
    if (preBobCont !== null) {
      throw new Error(`FAIL-CLOSED: Pre-flight collision detected. Container "${expectedBobContainer}" already exists.`);
    }
    if (preAliceVol !== null) {
      throw new Error(`FAIL-CLOSED: Pre-flight collision detected. Volume "${expectedAliceVol}" already exists.`);
    }
    if (preBobVol !== null) {
      throw new Error(`FAIL-CLOSED: Pre-flight collision detected. Volume "${expectedBobVol}" already exists.`);
    }

    // Mark that this run is about to generate metadata
    runGeneratedMetadata = true;

    // 6. Run comprehensive demo test suite with hermetic options
    const testReport = await runDemoTestSuite({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix,
      runtimeImage,
    });

    if (!testReport.ok) {
      const failedSteps = testReport.steps.filter((s) => !s.passed);
      console.error('Failed steps details:', JSON.stringify(failedSteps, null, 2));
    }

    expect(testReport.ok).toBe(true);
    expect(testReport.summary.failed).toBe(0);
    expect(testReport.summary.passed).toBe(testReport.summary.total);
    expect(testReport.probesUnchanged).toBe(true);

    const stepIds = testReport.steps.map((s) => s.stepId);
    expect(stepIds).toContain('step_reset_provision');
    expect(stepIds).toContain('step_auth_verification');
    expect(stepIds).toContain('step_import_history');
    expect(stepIds).toContain('step_tenant_isolation');
    expect(stepIds).toContain('step_session_lifecycle');
    expect(stepIds).toContain('step_sqlite_restart');
    expect(stepIds).toContain('step_migration_idempotency');
    expect(stepIds).toContain('step_dsh_docker_runtime');
    expect(stepIds).toContain('step_teardown');
    expect(stepIds).toContain('step_verify_zero_resources');
    expect(stepIds).toContain('step_integrity_probe');
  }, 120000);

  it('real Docker containers maintain session and volume continuity across container removal and relaunch', async () => {
    // 1. Mandatory runtime image check (defaults to exact acceptance image)
    const rawRuntimeImage = process.env.ENKEEP_RUNTIME_IMAGE?.trim() || 'enkeep-demo-runtime:acceptance';
    const acceptanceImagePattern = /^(enkeep-demo-runtime:(acceptance|latest)|enkeep-dsh-0\.1\.2-rc\.1-canary(:latest)?)$/;
    if (!acceptanceImagePattern.test(rawRuntimeImage)) {
      throw new Error(
        `FAIL-CLOSED: Invalid runtime image "${rawRuntimeImage}". Acceptance tests require "enkeep-demo-runtime:acceptance", "enkeep-demo-runtime:latest", or "enkeep-dsh-0.1.2-rc.1-canary".`
      );
    }
    const runtimeImage = rawRuntimeImage;

    // 2. Mandatory Docker availability check
    const dockerClient = new SafeDockerClient();
    const isDockerAvailable = await dockerClient.isDockerAvailable();
    if (!isDockerAvailable) {
      throw new Error('FAIL-CLOSED: Docker daemon is unavailable. Real Docker acceptance tests require an active daemon.');
    }

    // 3. Exact protected port probe snapshot before test
    probeBefore = await probeProtectedPorts();

    // 4. Initialize hermetic isolated temp repo with random 12-char resource suffix
    const resourceSuffix = generateSuffix12();
    activeResourceSuffix = resourceSuffix;
    tempRepo = createTempRepo();
    const pathOptions = { repoRoot: tempRepo.repoRoot, resourceSuffix };
    const paths = getDemoPathConfig(pathOptions);

    // 5. Pre-inspect exact generated names/volumes and FAIL ON COLLISION
    const expectedAliceContainer = `enkeep-demo-alice-${resourceSuffix}`;
    const expectedBobContainer = `enkeep-demo-bob-${resourceSuffix}`;
    const expectedAliceVol = `enkeep-demo-dsh-alice-${resourceSuffix}`;
    const expectedBobVol = `enkeep-demo-dsh-bob-${resourceSuffix}`;

    const [preAliceCont, preBobCont, preAliceVol, preBobVol] = await Promise.all([
      dockerClient.inspectContainer(expectedAliceContainer),
      dockerClient.inspectContainer(expectedBobContainer),
      dockerClient.inspectVolume(expectedAliceVol),
      dockerClient.inspectVolume(expectedBobVol),
    ]);

    if (preAliceCont !== null || preBobCont !== null || preAliceVol !== null || preBobVol !== null) {
      throw new Error(`FAIL-CLOSED: Pre-flight collision detected for resource suffix "${resourceSuffix}".`);
    }

    // Mark that this run is about to generate metadata
    runGeneratedMetadata = true;

    // 6. Reset demo environment and seed data
    const resetRes = await resetDemo({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix,
      deterministicCreatedAt: '2026-03-30T12:00:00.000Z',
    });
    expect(resetRes.ok).toBe(true);

    const adapter = new DockerRuntimeContainerAdapter(dockerClient);

    // 7. First System Launch: Start Alice and Bob real Docker containers
    const system1 = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix,
      runtimeImage,
      runtimeAdapter: adapter,
    });
    expect(system1.result.ok).toBe(true);

    const aliceUser1 = await system1.storage.users.findByUsername('alice');
    const aliceHandle1 = system1.runtimeHandles.get(aliceUser1!.id)!;
    const aliceContainerId1 = aliceHandle1.containerId;
    const aliceRunId1 = aliceHandle1.runId;
    const aliceVolumeId1 = aliceHandle1.volumeId;

    expect(aliceContainerId1).toMatch(/^[0-9a-f]{64}$/);
    expect(aliceRunId1).toMatch(/^[a-z0-9_-]+$/);
    expect(aliceVolumeId1).toMatch(/^vol_[0-9a-f]{32}$/);

    // 8. Derive targetSessionId and baseline event count from verified pre-seeded fixture
    const verifiedSeeds = loadAndVerifyFixedSeeds(paths.importDir, pathOptions);
    expect(verifiedSeeds.length).toBeGreaterThan(0);
    const aliceSeed = verifiedSeeds[0];
    if (!aliceSeed) {
      throw new Error('FAIL-CLOSED: Expected at least one verified seed for Alice.');
    }
    const targetSessionId = aliceSeed.sessionId;
    const preSeededEventsCount = aliceSeed.seedEvents.length;
    expect(preSeededEventsCount).toBeGreaterThan(0);

    // Send first prompt to pre-seeded session in Alice container
    const turnPrompt1 = 'Explain the difference between mutable and immutable data structures.';
    const turnRes1 = await aliceHandle1.sendTurn({
      prompt: turnPrompt1,
      sessionId: targetSessionId,
      turnId: 'turn_00000000000000000000000000000001',
      profileSnapshot: null,
    });

    expect(turnRes1.persisted).toBe(true);
    if (process.env.ENKEEP_LLM_ENABLED === '0') {
      expect(turnRes1.replyText).toBe(
        `[DemoModel:alice] Received turn: "${turnPrompt1}". Official DSH agent loop active, session persisted successfully.`
      );
    } else {
      expect(typeof turnRes1.replyText).toBe('string');
      expect(turnRes1.replyText.trim().length).toBeGreaterThan(0);
      expect(turnRes1.replyText).not.toContain('[DemoModel:');
    }
    expect(Number.isSafeInteger(turnRes1.eventsCount)).toBe(true);
    expect(turnRes1.eventsCount).toBeGreaterThan(preSeededEventsCount);

    // Live SQLite evidence from disk proving streaming event ingestion from real Docker container
    const { DatabaseSync: SqliteDb } = await import('node:sqlite');
    const liveDb = new SqliteDb(paths.dbPath);
    const liveEvents = liveDb.prepare('SELECT id, session_id, user_id, type, payload, created_at FROM web_events WHERE user_id = ? OR user_id = ? ORDER BY created_at ASC').all(aliceUser1!.id, 'alice') as any[];
    liveDb.close();

    const deltas = liveEvents.filter((e) => e.type === 'assistant_delta');
    console.log(`[Real Docker Live SQLite Evidence] DB: ${paths.dbPath}, Total Events: ${liveEvents.length}, Deltas: ${deltas.length}`);
    expect(deltas.length).toBeGreaterThanOrEqual(1);
    expect(deltas[0].payload).toContain('msgstream_');

    // 9. Close system retaining volumes (removeVolumes: false)
    await system1.close({ removeVolumes: false });

    // Confirm containers are removed from Docker
    const [postCloseAliceCont, postCloseBobCont] = await Promise.all([
      dockerClient.inspectContainer(expectedAliceContainer),
      dockerClient.inspectContainer(expectedBobContainer),
    ]);
    expect(postCloseAliceCont).toBeNull();
    expect(postCloseBobCont).toBeNull();

    // Confirm volumes STILL exist in Docker with exact ownership labels
    const [postCloseAliceVol, postCloseBobVol] = await Promise.all([
      dockerClient.inspectVolume(expectedAliceVol),
      dockerClient.inspectVolume(expectedBobVol),
    ]);
    expect(postCloseAliceVol).not.toBeNull();
    expect(postCloseBobVol).not.toBeNull();
    expect(postCloseAliceVol!.labels['enkeep.volume-id']).toBe(aliceVolumeId1);

    // 10. Relaunch system on same dataRoot / resourceSuffix / image (attaching owned volumes)
    const system2 = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix,
      runtimeImage,
      runtimeAdapter: adapter,
    });
    expect(system2.result.ok).toBe(true);

    const aliceUser2 = await system2.storage.users.findByUsername('alice');
    const aliceHandle2 = system2.runtimeHandles.get(aliceUser2!.id)!;
    const aliceContainerId2 = aliceHandle2.containerId;
    const aliceRunId2 = aliceHandle2.runId;
    const aliceVolumeId2 = aliceHandle2.volumeId;

    // Verify NEW 64-hex containerId and NEW runId, but SAME stable volumeId
    expect(aliceContainerId2).toMatch(/^[0-9a-f]{64}$/);
    expect(aliceContainerId2).not.toBe(aliceContainerId1);
    expect(aliceRunId2).not.toBe(aliceRunId1);
    expect(aliceVolumeId2).toBe(aliceVolumeId1);

    // 11. Send followup prompt to same session and verify continuity
    const turnPrompt2 = 'Give a code example of immutable update in TypeScript.';
    const turnRes2 = await aliceHandle2.sendTurn({
      prompt: turnPrompt2,
      sessionId: targetSessionId,
      turnId: 'turn_00000000000000000000000000000002',
      profileSnapshot: null,
    });

    expect(turnRes2.persisted).toBe(true);
    if (process.env.ENKEEP_LLM_ENABLED === '0') {
      expect(turnRes2.replyText).toBe(
        `[DemoModel:alice] Received turn: "${turnPrompt2}". Official DSH agent loop active, session persisted successfully.`
      );
    } else {
      expect(typeof turnRes2.replyText).toBe('string');
      expect(turnRes2.replyText.trim().length).toBeGreaterThan(0);
      expect(turnRes2.replyText).not.toContain('[DemoModel:');
    }
    expect(Number.isSafeInteger(turnRes2.eventsCount)).toBe(true);
    expect(turnRes2.eventsCount).toBeGreaterThan(turnRes1.eventsCount);

    // 12. Final close removing all volumes
    await system2.close({ removeVolumes: true });

    // Confirm both containers and volumes are fully cleaned up
    const [finalAliceCont, finalAliceVol] = await Promise.all([
      dockerClient.inspectContainer(expectedAliceContainer),
      dockerClient.inspectVolume(expectedAliceVol),
    ]);
    expect(finalAliceCont).toBeNull();
    expect(finalAliceVol).toBeNull();
  }, 120000);
});
