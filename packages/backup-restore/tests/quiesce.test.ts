import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectActiveProcesses,
  assertQuiescentEnvironment,
  releaseQuiescence,
} from '../src/index.js';
import { BackupQuiesceError } from '../src/errors.js';
import type { FreezeHooks } from '../src/types.js';

describe('Quiesce Protocol & FreezeHooks Lifecycle', () => {
  const testRoot = mkdtempSync(join(tmpdir(), 'enkeep-quiesce-test-'));

  it('detects no active processes when pids directory is empty or missing', () => {
    const active = detectActiveProcesses(testRoot);
    expect(active).toEqual([]);
  });

  it('detects active process when valid PID file exists with current process PID', () => {
    const pidsDir = join(testRoot, 'pids');
    mkdirSync(pidsDir, { recursive: true });

    // Use current node process PID (guaranteed alive)
    const currentPid = process.pid;
    writeFileSync(join(pidsDir, 'server.pid'), `${currentPid}\n`);

    const active = detectActiveProcesses(testRoot);
    expect(active.length).toBe(1);
    expect(active[0]!.name).toBe('server');
    expect(active[0]!.pid).toBe(currentPid);
  });

  it('ignores stale PID files for non-existent processes', () => {
    const pidsDir = join(testRoot, 'pids');
    mkdirSync(pidsDir, { recursive: true });

    // Use a pid that is almost certainly dead (e.g. 9999999)
    writeFileSync(join(pidsDir, 'stale.pid'), '9999999\n');

    const active = detectActiveProcesses(testRoot);
    // Should filter out dead process
    expect(active.some((p) => p.pid === 9999999)).toBe(false);
  });

  it('fails quiesce check when active process is detected without confirmation or hooks', async () => {
    const pidsDir = join(testRoot, 'pids');
    mkdirSync(pidsDir, { recursive: true });
    writeFileSync(join(pidsDir, 'active-server.pid'), `${process.pid}\n`);

    await expect(
      assertQuiescentEnvironment({
        dataRoot: testRoot,
      })
    ).rejects.toThrow(BackupQuiesceError);
  });

  it('passes quiesce check when --demo-stop-confirmed is provided', async () => {
    const pidsDir = join(testRoot, 'pids');
    mkdirSync(pidsDir, { recursive: true });
    writeFileSync(join(pidsDir, 'active-server.pid'), `${process.pid}\n`);

    await expect(
      assertQuiescentEnvironment({
        dataRoot: testRoot,
        demoStopConfirmed: true,
      })
    ).resolves.not.toThrow();
  });

  it('executes FreezeHooks lifecycle hooks properly', async () => {
    let beforeCalled = false;
    let afterCalled = false;

    const hooks: FreezeHooks = {
      beforeFreeze: async () => {
        beforeCalled = true;
      },
      afterFreeze: async () => {
        afterCalled = true;
      },
    };

    await assertQuiescentEnvironment({
      dataRoot: testRoot,
      freezeHooks: hooks,
    });

    expect(beforeCalled).toBe(true);

    await releaseQuiescence(hooks);
    expect(afterCalled).toBe(true);
  });

  it('triggers FreezeHooks.onAbort on failure', async () => {
    let abortError: unknown = null;

    const hooks: FreezeHooks = {
      onAbort: async (err) => {
        abortError = err;
      },
    };

    const simulatedErr = new Error('Snapshot failure');
    await releaseQuiescence(hooks, simulatedErr);

    expect(abortError).toBe(simulatedErr);
  });
});
