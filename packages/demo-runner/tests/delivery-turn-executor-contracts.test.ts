/**
 * DeliveryTurnExecutor Contracts, Static Invariants & Public ID vs Folder Integration Tests
 *
 * Verifies:
 * 1. Static code contracts in demo up region:
 *    - No `envelope as any` or unsafe casting
 *    - No `nativeContext` or `routeKey` fallback
 *    - No `userHandle.sendTurn` with >1 positional arguments (must be named RuntimeTurnRequest)
 * 2. Integration verification that public PlatformSpaceId differs from workspaceFolder
 *    and public ID is never used as filesystem path.
 *
 * @module @enkeep/demo-runner/tests/delivery-turn-executor-contracts.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { launchDemoSystem, type RunningDemoSystem } from '../src/up/index.js';
import { resetDemo } from '../src/reset/index.js';
import { FakeUnitRuntimeContainerAdapter } from './support/fake-runtime.js';
import { createTempRepo, type TempRepo } from './support/temp-repo.js';
import type { DeliveryExecutionRequest } from '@enkeep/platform-server';
import type { RuntimeTurnRequest } from '@enkeep/protocol';

describe('DeliveryTurnExecutor Static Invariants & Space Folder Contracts', () => {
  let tempRepo: TempRepo;

  beforeEach(() => {
    tempRepo = createTempRepo('dsh-executor-contract');
  });

  afterEach(() => {
    tempRepo.cleanup();
  });

  describe('1. Static Invariants in demo up region (dockerTurnExecutor)', () => {
    it('verifies demo up index.ts dockerTurnExecutor contains NO "envelope as any", NO "nativeContext", NO "routeKey" fallback, and NO multi-argument sendTurn', () => {
      const upIndexPath = join(__dirname, '../src/up/index.ts');
      expect(existsSync(upIndexPath)).toBe(true);
      const source = readFileSync(upIndexPath, 'utf8');

      // Extract dockerTurnExecutor implementation block
      const executorStart = source.indexOf('const dockerTurnExecutor: DeliveryTurnExecutor = {');
      expect(executorStart).toBeGreaterThan(-1);
      const executorEnd = source.indexOf('// 6b. Platform Operations', executorStart);
      expect(executorEnd).toBeGreaterThan(executorStart);

      const executorBlock = source.slice(executorStart, executorEnd);

      // Invariant 1: No "envelope as any" or any unsafe envelope cast
      expect(executorBlock).not.toContain('envelope as any');
      expect(executorBlock).not.toContain('(envelope as any)');
      expect(executorBlock).not.toContain('as any');

      // Invariant 2: No nativeContext or routeKey fallback
      expect(executorBlock).not.toContain('nativeContext');
      expect(executorBlock).not.toContain('routeKey');

      // Invariant 3: userHandle.sendTurn called with exactly ONE named object argument ({ ... })
      // Must match .sendTurn({ ... }) and NOT positional arguments like .sendTurn(prompt, ...)
      expect(executorBlock).toMatch(/\.sendTurn\s*\(\s*\{/);

      // Ensure no positional argument .sendTurn(a, ...) exists in executorBlock
      const positionalSendTurnPattern = /\.sendTurn\s*\(\s*[^{\s]/;
      expect(positionalSendTurnPattern.test(executorBlock)).toBe(false);
    });
  });

  describe('2. Space Folder Resolution Integration (Public SpaceId !== workspaceFolder)', () => {
    it('resolves canonical workspace folder when platformSpaceId differs from space folder, ensuring public ID is never used as path', async () => {
      await resetDemo({ repoRoot: tempRepo.repoRoot });

      // Track received arguments inside fake adapter
      let capturedTurnRequest: RuntimeTurnRequest | undefined;
      let capturedFileOpSpace: string | undefined;

      const fakeAdapter = new FakeUnitRuntimeContainerAdapter();
      const origStart = fakeAdapter.startUserRuntime.bind(fakeAdapter);
      fakeAdapter.startUserRuntime = async (options) => {
        const handle = await origStart(options);
        const origSendTurn = handle.sendTurn.bind(handle);
        handle.sendTurn = async (req: RuntimeTurnRequest) => {
          capturedTurnRequest = req;
          return origSendTurn(req);
        };
        const origFileOp = handle.fileOperation.bind(handle);
        handle.fileOperation = async (req) => {
          if (req.op === 'mkdir') {
            capturedFileOpSpace = req.space;
          }
          return origFileOp(req);
        };
        return handle;
      };

      const system = await launchDemoSystem({
        repoRoot: tempRepo.repoRoot,
        runtimeAdapter: fakeAdapter,
      });

      try {
        const storage = system.platformServer['storage'];
        const aliceUser = await storage.users.findByUsername('alice');
        expect(aliceUser).toBeDefined();

        // Create a space where public ID is a distinct opaque UUID and folder is a custom segment name
        const publicSpaceId = `spc_${randomUUID().replace(/-/g, '')}`;
        const canonicalFolder = 'custom-project-alpha';
        expect(publicSpaceId).not.toBe(canonicalFolder);

        await storage.forTenant(aliceUser!.id).spaces.create({
          id: publicSpaceId,
          name: 'Alpha Project Public Space',
          folder: canonicalFolder,
          executionMode: 'container',
        });

        // Resolve executor
        const gateway = system.platformServer['runtimeGateway'] as any;
        const executor = gateway['executor'];

        const resolvedEnvelope = {
          id: `deliv_${randomUUID().replace(/-/g, '')}`,
          userId: aliceUser!.id,
          sessionId: 'ses_space_diff_001',
          spaceId: publicSpaceId,
          content: 'Perform integration task in custom space',
          timestamp: new Date().toISOString(),
        };

        const executionRequest: DeliveryExecutionRequest = {
          userId: aliceUser!.id,
          platformSpaceId: publicSpaceId,
          dshSessionId: 'dsh_session_space_diff_001',
          turnId: 'turn_space_diff_0000000000000001',
          content: 'Perform integration task in custom space',
          profile: null,
          envelope: resolvedEnvelope,
        };

        const result = await executor.execute(executionRequest);
        expect(result).toBeDefined();
        expect(result.replyText).toContain('Perform integration task in custom space');

        // Verify:
        // 1. fileOperation mkdir was executed on canonicalFolder, NOT publicSpaceId
        expect(capturedFileOpSpace).toBe(canonicalFolder);
        expect(capturedFileOpSpace).not.toBe(publicSpaceId);

        // 2. sendTurn received workspaceFolder equal to canonicalFolder, NOT publicSpaceId
        expect(capturedTurnRequest).toBeDefined();
        expect(capturedTurnRequest?.workspaceFolder).toBe(canonicalFolder);
        expect(capturedTurnRequest?.workspaceFolder).not.toBe(publicSpaceId);
        expect(capturedTurnRequest?.sessionId).toBe('dsh_session_space_diff_001');
        expect(capturedTurnRequest?.turnId).toBe('turn_space_diff_0000000000000001');
      } finally {
        await system.close({ removeVolumes: true });
      }
    });
  });
});
