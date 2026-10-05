/**
 * Unit and integration tests for SpaceIsolatedBashExecutor.execute() unified execution model,
 * path sanitization across result(), readOutput(), and observed stream readers, and Volatile config.
 *
 * Conforms to AGENTS.md: synthetic data only, temp directories via os.tmpdir().
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local';
import {
  SpaceIsolatedBashExecutor,
  type ResolvedRuntimeMount,
} from '../src/index.js';

describe('SpaceIsolatedBashExecutor execute() and Streaming Sanitization', () => {
  let tmpTestDir: string;
  let spaceDir: string;
  let hostMountDir: string;

  beforeEach(() => {
    tmpTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-test-bash-exec-'));
    spaceDir = path.join(tmpTestDir, 'space-01');
    hostMountDir = path.join(tmpTestDir, 'host-data-mnt');

    fs.mkdirSync(spaceDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(hostMountDir, { recursive: true, mode: 0o755 });

    fs.writeFileSync(path.join(hostMountDir, 'data.txt'), 'synthetic-content-line1\nsynthetic-content-line2\n');
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpTestDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it('execute() returns ShellExecution and result() sanitizes stdout/stderr', async () => {
    const ctx = new Context();
    await ctx.plugin(LocalSubprocess);

    const mounts: ResolvedRuntimeMount[] = [
      { id: 'mnt_test', name: 'shared-data', sourcePath: hostMountDir, targetPath: hostMountDir, mode: 'ro' },
    ];

    const bash = new SpaceIsolatedBashExecutor(ctx, {
      cwd: spaceDir,
      mounts,
    });

    const spec = bash.resolve({
      command: 'echo "Mounted at: /mnt/shared-data/data.txt"; cat /mnt/shared-data/data.txt',
      workdir: spaceDir,
    });

    // Check command rewrite replaced /mnt/shared-data with physical hostMountDir
    expect(spec.command).toContain(hostMountDir);

    const execution = await bash.execute(spec);
    expect(execution).toBeDefined();
    expect(typeof execution.readOutput).toBe('function');
    expect(typeof execution.result).toBe('function');
    expect(execution.observed).toBeDefined();

    const outcome = await execution.result();
    expect(outcome.exitCode).toBe(0);
    // Path sanitization: physical hostMountDir must NOT be leaked in stdout
    expect(outcome.stdout.text).not.toContain(hostMountDir);
    expect(outcome.stdout.text).toContain('/mnt/shared-data');
    expect(outcome.stdout.text).toContain('synthetic-content-line1');
  });

  it('readOutput() streams sanitized output deltas', async () => {
    const ctx = new Context();
    await ctx.plugin(LocalSubprocess);

    const mounts: ResolvedRuntimeMount[] = [
      { id: 'mnt_test', name: 'shared-data', sourcePath: hostMountDir, targetPath: hostMountDir, mode: 'ro' },
    ];

    const bash = new SpaceIsolatedBashExecutor(ctx, {
      cwd: spaceDir,
      mounts,
    });

    const spec = bash.resolve({
      command: `echo "Leaking raw path: ${hostMountDir}/data.txt"`,
      workdir: spaceDir,
    });

    const execution = await bash.execute(spec);
    await execution.done;

    const read = execution.readOutput();
    expect(read.delta).toBeDefined();
    expect(read.delta).not.toContain(hostMountDir);
    expect(read.delta).toContain('/mnt/shared-data');
  });

  it('observed stream readers sanitize stdout and stderr non-destructively', async () => {
    const ctx = new Context();
    await ctx.plugin(LocalSubprocess);

    const mounts: ResolvedRuntimeMount[] = [
      { id: 'mnt_test', name: 'shared-data', sourcePath: hostMountDir, targetPath: hostMountDir, mode: 'ro' },
    ];

    const bash = new SpaceIsolatedBashExecutor(ctx, {
      cwd: spaceDir,
      mounts,
    });

    const spec = bash.resolve({
      command: `echo "stdout-leak: ${hostMountDir}" ; echo "stderr-leak: ${hostMountDir}" >&2`,
      workdir: spaceDir,
    });

    const execution = await bash.execute(spec);
    await execution.done;

    const observedStdout = execution.observed.stdout.readFrom(0);
    expect(observedStdout.text).not.toContain(hostMountDir);
    expect(observedStdout.text).toContain('/mnt/shared-data');

    const observedStderr = execution.observed.stderr.readFrom(0);
    expect(observedStderr.text).not.toContain(hostMountDir);
    expect(observedStderr.text).toContain('/mnt/shared-data');
  });

  it('supports Volatile config references via .get()', async () => {
    const ctx = new Context();
    await ctx.plugin(LocalSubprocess);

    const mounts: ResolvedRuntimeMount[] = [
      { id: 'mnt_test', name: 'shared-data', sourcePath: hostMountDir, targetPath: hostMountDir, mode: 'ro' },
    ];

    const volatileCwd = {
      get: () => spaceDir,
    };
    const volatileTimeout = {
      get: () => 45000,
    };

    const bash = new SpaceIsolatedBashExecutor(ctx, {
      cwd: volatileCwd,
      timeoutMs: volatileTimeout,
      mounts,
    });

    const spec = bash.resolve({
      command: 'echo "hello from volatile config"',
    });

    expect(spec.workdir).toBe(fs.realpathSync(spaceDir));
    expect(spec.timeoutMs).toBe(45000);

    const outcome = await bash.run(spec);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout.text).toContain('hello from volatile config');
  });
});
