/**
 * G12-P2 Runtime Protocol Wiring & Isolation Tests
 *
 * Verifies:
 * 1. Request parsing & codec validation for extraReadableRoots (valid, invalid types, traversal, protected system roots, sensitive paths)
 * 2. Actual mounted native read of authorized sibling space
 * 3. Write and edit to authorized sibling space denied (FS_SANDBOX_DENIED) while own space write succeeds
 * 4. Changing roots between turns refreshes affected session at safe boundary without leaking into other sessions
 * 5. Reuses baseline extraReadableRoots boot option without duplicating fields
 *
 * @module @enkeep/runtime-runner/tests/extra-readable-roots-wiring.test
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  bootDshRuntime,
  RuntimeDaemon,
  decodeDaemonRequest,
  decodeDaemonMessage,
  DAEMON_OPS,
  DAEMON_ERROR_CODES,
  DaemonProtocolError,
  computeExtraRootsHash,
  validateExtraReadableRoots,
  type SubmitTurnRequest,
} from '../src/index.js';

describe('G12-P2 Runtime Protocol Wiring & Native Mount Tests', () => {
  let tmpBaseDir: string;
  let spacesDir: string;
  let dshHomeDir: string;
  let ownSpaceDir: string;
  let siblingSpaceDir: string;
  let siblingCSpaceDir: string;
  let baselineExtraDir: string;

  beforeEach(() => {
    tmpBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-g12-wiring-test-'));
    tmpBaseDir = fs.realpathSync(tmpBaseDir);

    spacesDir = path.join(tmpBaseDir, 'spaces');
    dshHomeDir = path.join(tmpBaseDir, '.dsh');
    ownSpaceDir = path.join(spacesDir, 'space-a');
    siblingSpaceDir = path.join(spacesDir, 'space-b');
    siblingCSpaceDir = path.join(spacesDir, 'space-c');
    baselineExtraDir = path.join(tmpBaseDir, 'baseline-shared');

    fs.mkdirSync(spacesDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(dshHomeDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(ownSpaceDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(siblingSpaceDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(siblingCSpaceDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(baselineExtraDir, { recursive: true, mode: 0o755 });

    // Seed test files
    fs.writeFileSync(path.join(ownSpaceDir, 'own.txt'), 'own content');
    fs.writeFileSync(path.join(siblingSpaceDir, 'sibling-b.txt'), 'sibling-b content');
    fs.writeFileSync(path.join(siblingCSpaceDir, 'sibling-c.txt'), 'sibling-c content');
    fs.writeFileSync(path.join(baselineExtraDir, 'baseline.txt'), 'baseline content');
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tmpBaseDir)) {
        fs.rmSync(tmpBaseDir, { recursive: true, force: true });
      }
    } catch {}
  });

  describe('1. Request Parsing & Validation', () => {
    it('successfully parses valid extraReadableRoots in SubmitTurnRequest', () => {
      const validEnvelope: SubmitTurnRequest = {
        id: 'req-1',
        op: 'submitTurn',
        turnId: 'turn_0123456789abcdef0123456789abcdef',
        sessionId: 'ses_0123456789abcdef0123456789abcdef',
        prompt: 'test prompt',
        extraReadableRoots: [siblingSpaceDir, siblingCSpaceDir],
      };

      const decoded = decodeDaemonRequest(JSON.stringify(validEnvelope)) as SubmitTurnRequest;
      expect(decoded.op).toBe(DAEMON_OPS.SUBMIT_TURN);
      expect(decoded.extraReadableRoots).toEqual([siblingSpaceDir, siblingCSpaceDir]);

      const decodedMsg = decodeDaemonMessage(JSON.stringify(validEnvelope)) as SubmitTurnRequest;
      expect(decodedMsg.extraReadableRoots).toEqual([siblingSpaceDir, siblingCSpaceDir]);
    });

    it('rejects non-array extraReadableRoots', () => {
      const invalidEnvelope = {
        id: 'req-2',
        op: 'submitTurn',
        turnId: 'turn_0123456789abcdef0123456789abcdef',
        sessionId: 'ses_0123456789abcdef0123456789abcdef',
        prompt: 'test prompt',
        extraReadableRoots: siblingSpaceDir, // string instead of array
      };

      expect(() => decodeDaemonRequest(JSON.stringify(invalidEnvelope))).toThrowError(
        expect.objectContaining({
          code: DAEMON_ERROR_CODES.INVALID_PARAMETERS,
        })
      );
    });

    it('rejects non-absolute paths in extraReadableRoots', () => {
      const invalidEnvelope = {
        id: 'req-3',
        op: 'submitTurn',
        turnId: 'turn_0123456789abcdef0123456789abcdef',
        sessionId: 'ses_0123456789abcdef0123456789abcdef',
        prompt: 'test prompt',
        extraReadableRoots: ['relative/path/to/sibling'],
      };

      expect(() => decodeDaemonRequest(JSON.stringify(invalidEnvelope))).toThrowError(
        expect.objectContaining({
          code: DAEMON_ERROR_CODES.INVALID_PARAMETERS,
        })
      );
    });

    it('rejects directory traversal attempts in extraReadableRoots', () => {
      const invalidEnvelope = {
        id: 'req-4',
        op: 'submitTurn',
        turnId: 'turn_0123456789abcdef0123456789abcdef',
        sessionId: 'ses_0123456789abcdef0123456789abcdef',
        prompt: 'test prompt',
        extraReadableRoots: [`${siblingSpaceDir}/../space-b`],
      };

      expect(() => decodeDaemonRequest(JSON.stringify(invalidEnvelope))).toThrowError(
        expect.objectContaining({
          code: DAEMON_ERROR_CODES.INVALID_PARAMETERS,
        })
      );
    });

    it('rejects prohibited system roots (/ and /etc)', () => {
      const envelopeRoot = {
        id: 'req-5a',
        op: 'submitTurn',
        turnId: 'turn_0123456789abcdef0123456789abcdef',
        sessionId: 'ses_0123456789abcdef0123456789abcdef',
        prompt: 'test prompt',
        extraReadableRoots: ['/'],
      };
      expect(() => decodeDaemonRequest(JSON.stringify(envelopeRoot))).toThrowError(
        expect.objectContaining({
          code: DAEMON_ERROR_CODES.INVALID_PARAMETERS,
        })
      );

      const envelopeEtc = {
        id: 'req-5b',
        op: 'submitTurn',
        turnId: 'turn_0123456789abcdef0123456789abcdef',
        sessionId: 'ses_0123456789abcdef0123456789abcdef',
        prompt: 'test prompt',
        extraReadableRoots: ['/etc'],
      };
      expect(() => decodeDaemonRequest(JSON.stringify(envelopeEtc))).toThrowError(
        expect.objectContaining({
          code: DAEMON_ERROR_CODES.INVALID_PARAMETERS,
        })
      );
    });

    it('rejects sensitive user directories (.ssh, .aws)', () => {
      const envelopeSsh = {
        id: 'req-6',
        op: 'submitTurn',
        turnId: 'turn_0123456789abcdef0123456789abcdef',
        sessionId: 'ses_0123456789abcdef0123456789abcdef',
        prompt: 'test prompt',
        extraReadableRoots: [`${tmpBaseDir}/.ssh`],
      };
      expect(() => decodeDaemonRequest(JSON.stringify(envelopeSsh))).toThrowError(
        expect.objectContaining({
          code: DAEMON_ERROR_CODES.INVALID_PARAMETERS,
        })
      );
    });

    it('validateExtraReadableRoots deduplicates and freezes result', () => {
      const res = validateExtraReadableRoots([siblingSpaceDir, siblingSpaceDir]);
      expect(res).toEqual([siblingSpaceDir]);
      expect(Object.isFrozen(res)).toBe(true);
    });
  });

  describe('2. Mounted Native Read Authorized Sibling & Write Denied', () => {
    it('allows native read of authorized sibling space, denies write/edit to sibling, allows own write', async () => {
      const runtime = await bootDshRuntime({
        userId: 'alice',
        dshHome: dshHomeDir,
        spacesDir,
      });

      try {
        const sessionId = 'ses_11111111111111111111111111111111';
        const agent = await runtime.getOrCreateAgent(
          sessionId,
          null,
          'space-a',
          undefined,
          null,
          [siblingSpaceDir]
        );

        const fsService = agent.ctx.get('fs') as any;
        expect(fsService).toBeDefined();

        // 1. Read authorized sibling space file -> succeeds
        const siblingTarget = await fsService.resolve(path.join(siblingSpaceDir, 'sibling-b.txt'));
        expect(siblingTarget.displayPath).toBe(path.join(siblingSpaceDir, 'sibling-b.txt'));
        const siblingContent = await fsService.readText(siblingTarget);
        expect(siblingContent).toBe('sibling-b content');

        // 2. Write to authorized sibling space -> denied with FS_SANDBOX_DENIED
        await expect(
          fsService.writeText(siblingTarget, 'overwritten sibling content')
        ).rejects.toThrow(/Access denied: cannot write to read-only root/);

        // 3. Edit file in authorized sibling space -> denied with FS_SANDBOX_DENIED
        await expect(
          fsService.editText(siblingTarget, {
            type: 'replace',
            oldString: 'sibling-b',
            newString: 'mutated',
          })
        ).rejects.toThrow(/Access denied: cannot edit file in read-only root/);

        // 4. Write to own space -> succeeds
        const ownTarget = await fsService.resolve(path.join(ownSpaceDir, 'own-new.txt'));
        await fsService.writeText(ownTarget, 'brand new file');
        const ownContent = await fsService.readText(ownTarget);
        expect(ownContent).toBe('brand new file');

        // 5. Unshared sibling-c space -> denied
        await expect(
          fsService.resolve(path.join(siblingCSpaceDir, 'sibling-c.txt'))
        ).rejects.toThrow(/outside space boundary/);
      } finally {
        await runtime.dispose();
      }
    });
  });

  describe('3. Dynamic Per-Turn Root Changes & Cross-Session Isolation', () => {
    it('refreshes affected session when roots change between turns, preserving history, without leaking to other sessions', async () => {
      const runtime = await bootDshRuntime({
        userId: 'alice',
        dshHome: dshHomeDir,
        spacesDir,
      });

      try {
        const sessionA = 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        const sessionB = 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

        // Turn 1 for Session A: siblingSpaceDir authorized
        const agentA_Turn1 = await runtime.getOrCreateAgent(
          sessionA,
          null,
          'space-a',
          undefined,
          null,
          [siblingSpaceDir]
        );
        const fsA_1 = agentA_Turn1.ctx.get('fs') as any;

        // Session A can read sibling-b
        const targetB_1 = await fsA_1.resolve(path.join(siblingSpaceDir, 'sibling-b.txt'));
        expect(await fsA_1.readText(targetB_1)).toBe('sibling-b content');
        // Session A cannot read sibling-c yet
        await expect(
          fsA_1.resolve(path.join(siblingCSpaceDir, 'sibling-c.txt'))
        ).rejects.toThrow(/outside space boundary/);

        // Session B concurrently active in space-b with NO extraReadableRoots
        const agentB = await runtime.getOrCreateAgent(
          sessionB,
          null,
          'space-b',
          undefined,
          null,
          undefined
        );
        const fsB = agentB.ctx.get('fs') as any;

        // Session B cannot access space-a or space-c
        await expect(
          fsB.resolve(path.join(ownSpaceDir, 'own.txt'))
        ).rejects.toThrow(/outside space boundary/);
        await expect(
          fsB.resolve(path.join(siblingCSpaceDir, 'sibling-c.txt'))
        ).rejects.toThrow(/outside space boundary/);

        // Turn 2 for Session A: roots change to siblingCSpaceDir
        const agentA_Turn2 = await runtime.getOrCreateAgent(
          sessionA,
          null,
          'space-a',
          undefined,
          null,
          [siblingCSpaceDir]
        );
        const fsA_2 = agentA_Turn2.ctx.get('fs') as any;

        // Session A now CAN read sibling-c
        const targetC_2 = await fsA_2.resolve(path.join(siblingCSpaceDir, 'sibling-c.txt'));
        expect(await fsA_2.readText(targetC_2)).toBe('sibling-c content');

        // Session A can NO LONGER read sibling-b (revoked at turn boundary)
        await expect(
          fsA_2.resolve(path.join(siblingSpaceDir, 'sibling-b.txt'))
        ).rejects.toThrow(/outside space boundary/);

        // Session B is completely unaffected (no leak)
        const targetOwnB = await fsB.resolve(path.join(siblingSpaceDir, 'sibling-b.txt'));
        expect(await fsB.readText(targetOwnB)).toBe('sibling-b content');
        await expect(
          fsB.resolve(path.join(siblingCSpaceDir, 'sibling-c.txt'))
        ).rejects.toThrow(/outside space boundary/);
      } finally {
        await runtime.dispose();
      }
    });
  });

  describe('4. Baseline extraReadableRoots Option Reuse', () => {
    it('combines baseline boot extraReadableRoots with per-turn extraReadableRoots without duplication', async () => {
      // Boot runtime with baseline extraReadableRoots
      const runtime = await bootDshRuntime({
        userId: 'alice',
        dshHome: dshHomeDir,
        spacesDir,
        extraReadableRoots: [baselineExtraDir],
      });

      try {
        const sessionId = 'ses_22222222222222222222222222222222';

        // Turn with additional siblingSpaceDir
        const agent = await runtime.getOrCreateAgent(
          sessionId,
          null,
          'space-a',
          undefined,
          null,
          [siblingSpaceDir]
        );
        const fsService = agent.ctx.get('fs') as any;

        // Baseline root is readable
        const baselineTarget = await fsService.resolve(path.join(baselineExtraDir, 'baseline.txt'));
        expect(await fsService.readText(baselineTarget)).toBe('baseline content');

        // Turn root is readable
        const siblingTarget = await fsService.resolve(path.join(siblingSpaceDir, 'sibling-b.txt'));
        expect(await fsService.readText(siblingTarget)).toBe('sibling-b content');

        // Writing to baseline root is denied
        await expect(
          fsService.writeText(baselineTarget, 'mutated')
        ).rejects.toThrow(/Access denied: cannot write to read-only root/);

        // Turn without additional roots still retains baseline root
        const agentTurn2 = await runtime.getOrCreateAgent(
          sessionId,
          null,
          'space-a',
          undefined,
          null,
          []
        );
        const fsService2 = agentTurn2.ctx.get('fs') as any;

        const baselineTarget2 = await fsService2.resolve(path.join(baselineExtraDir, 'baseline.txt'));
        expect(await fsService2.readText(baselineTarget2)).toBe('baseline content');

        // Sibling root is no longer readable
        await expect(
          fsService2.resolve(path.join(siblingSpaceDir, 'sibling-b.txt'))
        ).rejects.toThrow(/outside space boundary/);
      } finally {
        await runtime.dispose();
      }
    });
  });

  describe('5. Daemon End-to-End Turn Execution & Rebuild', () => {
    it('executes turn via daemon with extraReadableRoots and safely evicts on root change', async () => {
      const daemon = new RuntimeDaemon({
        userId: 'alice',
        dshHome: dshHomeDir,
        spacesDir,
      });
      await daemon.start();

      try {
        const sessionId = 'ses_33333333333333333333333333333333';

        // 1. Submit turn with invalid extraReadableRoots -> rejected
        const invalidRes = await daemon.handleRequest({
          id: 'turn-invalid',
          op: 'submitTurn',
          turnId: 'turn_33333333333333333333333333333331',
          sessionId,
          prompt: 'hello',
          workspaceFolder: 'space-a',
          extraReadableRoots: ['/etc/passwd'], // prohibited
        } as any);

        expect(invalidRes.ok).toBe(false);
        expect(invalidRes.error?.code).toBe(DAEMON_ERROR_CODES.INVALID_PARAMETERS);

        // 2. Submit valid turn 1 with sibling-b
        const turn1Res = await daemon.submitTurnAndWait({
          id: 'turn-1',
          op: 'submitTurn',
          turnId: 'turn_33333333333333333333333333333332',
          sessionId,
          prompt: 'Hello turn 1',
          workspaceFolder: 'space-a',
          extraReadableRoots: [siblingSpaceDir],
        });
        expect(turn1Res.status).toBe('completed');

        // 3. Submit turn 2 with changed extraReadableRoots (sibling-c)
        // Daemon should evict agent due to roots_mismatch and recreate safely
        const turn2Res = await daemon.submitTurnAndWait({
          id: 'turn-2',
          op: 'submitTurn',
          turnId: 'turn_33333333333333333333333333333333',
          sessionId,
          prompt: 'Hello turn 2 with changed roots',
          workspaceFolder: 'space-a',
          extraReadableRoots: [siblingCSpaceDir],
        });
        expect(turn2Res.status).toBe('completed');
        expect(turn2Res.persisted).toBe(true);

        const healthRes = await daemon.handleRequest({ id: 'h-check', op: 'health' });
        expect(healthRes.ok).toBe(true);
        if (healthRes.ok) {
          expect(healthRes.stats.evictionsCount).toBeGreaterThanOrEqual(1);
        }
      } finally {
        await daemon.shutdown(1500);
      }
    });
  });
});
