/**
 * Space-Isolated Controlled Mounts & Virtual Path Routing Unit & Integration Tests
 *
 * Tests:
 * 1. Virtual path resolution: `/mnt/<name>` maps to backing physical directory
 * 2. Virtual directory listing: `listDir('/mnt')` lists all mounted slugs in the current space
 * 3. File tools read/write:
 *    - RO mount: `read` succeeds; `write` and `edit` fail with FS_SANDBOX_DENIED
 *    - RW mount: `read`, `write`, `edit` succeed within mount boundary
 * 4. Path traversal defense: `/mnt/<name>/../../etc/passwd` throws FS_SANDBOX_DENIED
 * 5. Symlink escape defense: symlink inside mount pointing outside throws FS_SANDBOX_DENIED
 * 6. Cross-space isolation: Space A mount is inaccessible from Space B
 * 7. Name collision non-interference: same slug name `/mnt/data` in Space A and Space B points to distinct targets
 * 8. Space-isolated Bash executor:
 *    - `cd /mnt/<name>` / `workdir: '/mnt/<name>'` resolves to backing path
 *    - Command rewrite and stdout/stderr sanitization (no host path leaked)
 *    - RO mount shell mutation rejection
 *
 * @module @enkeep/runtime-runner/tests/space-isolated-mounts.test
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local';
import {
  SpaceIsolatedFileSystem,
  SpaceIsolatedBashExecutor,
  mountWorkspaceTools,
  type ResolvedRuntimeMount,
} from '../src/index.js';

describe('Space-Isolated Controlled Mounts & Virtual Path Routing', () => {
  let tmpTestDir: string;
  let spaceADir: string;
  let spaceBDir: string;
  let dshHomeDir: string;
  let hostDatasetRO: string;
  let hostScratchRW: string;
  let hostDatasetB: string;

  beforeEach(() => {
    tmpTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-space-mount-test-'));
    spaceADir = path.join(tmpTestDir, 'spaces', 'space-a');
    spaceBDir = path.join(tmpTestDir, 'spaces', 'space-b');
    dshHomeDir = path.join(tmpTestDir, '.dsh');

    hostDatasetRO = path.join(tmpTestDir, 'host-data-ro');
    hostScratchRW = path.join(tmpTestDir, 'host-scratch-rw');
    hostDatasetB = path.join(tmpTestDir, 'host-data-b');

    fs.mkdirSync(spaceADir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(spaceBDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(dshHomeDir, { recursive: true, mode: 0o700 });

    fs.mkdirSync(hostDatasetRO, { recursive: true, mode: 0o755 });
    fs.mkdirSync(hostScratchRW, { recursive: true, mode: 0o755 });
    fs.mkdirSync(hostDatasetB, { recursive: true, mode: 0o755 });

    // Seed test files in mounts
    fs.writeFileSync(path.join(hostDatasetRO, 'dataset.csv'), 'id,value\n1,alice\n2,bob\n');
    fs.writeFileSync(path.join(hostDatasetRO, 'config.json'), '{"version": 1}');
    fs.writeFileSync(path.join(hostScratchRW, 'notes.txt'), 'initial scratch notes');
    fs.writeFileSync(path.join(hostDatasetB, 'space-b-data.txt'), 'Space B exclusive data');
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tmpTestDir)) {
        fs.rmSync(tmpTestDir, { recursive: true, force: true });
      }
    } catch {}
  });

  describe('SpaceIsolatedFileSystem Mount Routing & Security', () => {
    it('resolves virtual /mnt/<name> paths and reads contents correctly', async () => {
      const ctx = new Context();
      const mounts: ResolvedRuntimeMount[] = [
        { id: 'mnt_ro', name: 'readonly-data', sourcePath: hostDatasetRO, targetPath: hostDatasetRO, mode: 'ro' },
        { id: 'mnt_rw', name: 'scratch', sourcePath: hostScratchRW, targetPath: hostScratchRW, mode: 'rw' },
      ];

      const fsService = new SpaceIsolatedFileSystem(ctx, {
        cwd: spaceADir,
        mounts,
      });

      // 1. Resolve and read file in RO mount
      const targetRO = await fsService.resolve('/mnt/readonly-data/dataset.csv');
      expect(targetRO.displayPath).toBe('/mnt/readonly-data/dataset.csv');
      expect(targetRO.targetKey).toBe(path.join(hostDatasetRO, 'dataset.csv'));

      const contentRO = await fsService.readText(targetRO);
      expect(contentRO).toContain('1,alice');

      // 2. Resolve and read file in RW mount
      const targetRW = await fsService.resolve('/mnt/scratch/notes.txt');
      expect(targetRW.displayPath).toBe('/mnt/scratch/notes.txt');
      const contentRW = await fsService.readText(targetRW);
      expect(contentRW).toBe('initial scratch notes');
    });

    it('lists virtual /mnt directory returning all configured mount slugs for the space', async () => {
      const ctx = new Context();
      const mounts: ResolvedRuntimeMount[] = [
        { id: 'mnt_ro', name: 'readonly-data', sourcePath: hostDatasetRO, targetPath: hostDatasetRO, mode: 'ro' },
        { id: 'mnt_rw', name: 'scratch', sourcePath: hostScratchRW, targetPath: hostScratchRW, mode: 'rw' },
      ];

      const fsService = new SpaceIsolatedFileSystem(ctx, {
        cwd: spaceADir,
        mounts,
      });

      const mntTarget = await fsService.resolve('/mnt');
      const entries = await fsService.listDir(mntTarget);

      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.name).sort()).toEqual(['readonly-data', 'scratch']);
      expect(entries.every((e) => e.type === 'directory')).toBe(true);
    });

    it('enforces RO mode: writeText and editText to read-only mount fail with FS_SANDBOX_DENIED', async () => {
      const ctx = new Context();
      const mounts: ResolvedRuntimeMount[] = [
        { id: 'mnt_ro', name: 'readonly-data', sourcePath: hostDatasetRO, targetPath: hostDatasetRO, mode: 'ro' },
      ];

      const fsService = new SpaceIsolatedFileSystem(ctx, {
        cwd: spaceADir,
        mounts,
      });

      const target = await fsService.resolve('/mnt/readonly-data/dataset.csv');

      // writeText must fail
      await expect(fsService.writeText(target, 'malicious edit')).rejects.toThrow(
        /cannot write to read-only mount "\/mnt\/readonly-data"/
      );

      // editText must fail
      await expect(
        fsService.editText(target, {
          oldString: '1,alice',
          newString: '1,eve',
          replaceAll: false,
        })
      ).rejects.toThrow(/cannot edit file in read-only mount "\/mnt\/readonly-data"/);

      // File on host must be unmodified
      expect(fs.readFileSync(path.join(hostDatasetRO, 'dataset.csv'), 'utf8')).toContain('1,alice');
    });

    it('enforces RW mode: writeText and editText to read-write mount succeed', async () => {
      const ctx = new Context();
      const mounts: ResolvedRuntimeMount[] = [
        { id: 'mnt_rw', name: 'scratch', sourcePath: hostScratchRW, targetPath: hostScratchRW, mode: 'rw' },
      ];

      const fsService = new SpaceIsolatedFileSystem(ctx, {
        cwd: spaceADir,
        mounts,
      });

      const target = await fsService.resolve('/mnt/scratch/new-output.txt');
      await fsService.writeText(target, 'created by agent');

      expect(fs.readFileSync(path.join(hostScratchRW, 'new-output.txt'), 'utf8')).toBe(
        'created by agent'
      );

      // Edit existing file
      const editTarget = await fsService.resolve('/mnt/scratch/notes.txt');
      await fsService.editText(editTarget, {
        oldString: 'initial scratch notes',
        newString: 'updated scratch notes',
        replaceAll: false,
      });

      expect(fs.readFileSync(path.join(hostScratchRW, 'notes.txt'), 'utf8')).toBe(
        'updated scratch notes'
      );
    });

    it('strictly rejects path traversal attacks escaping mount boundary', async () => {
      const ctx = new Context();
      const mounts: ResolvedRuntimeMount[] = [
        { id: 'mnt_ro', name: 'readonly-data', sourcePath: hostDatasetRO, targetPath: hostDatasetRO, mode: 'ro' },
      ];

      const fsService = new SpaceIsolatedFileSystem(ctx, {
        cwd: spaceADir,
        mounts,
      });

      // Path traversal: /mnt/readonly-data/../../...
      await expect(fsService.resolve('/mnt/readonly-data/../../etc/passwd')).rejects.toThrow(
        /Access denied: path ".*" traverses outside mount boundary/
      );

      await expect(fsService.resolve('/mnt/readonly-data/../host-scratch-rw/notes.txt')).rejects.toThrow(
        /Access denied: path ".*" traverses outside mount boundary/
      );
    });

    it('strictly rejects symlink escape attacks inside mount', async () => {
      // Create malicious symlink inside mount pointing to /etc
      const symlinkInsideMount = path.join(hostDatasetRO, 'escape-link');
      try {
        fs.symlinkSync('/etc', symlinkInsideMount);
      } catch {}

      if (fs.existsSync(symlinkInsideMount)) {
        const ctx = new Context();
        const mounts: ResolvedRuntimeMount[] = [
          { id: 'mnt_ro', name: 'readonly-data', sourcePath: hostDatasetRO, targetPath: hostDatasetRO, mode: 'ro' },
        ];

        const fsService = new SpaceIsolatedFileSystem(ctx, {
          cwd: spaceADir,
          mounts,
        });

        await expect(fsService.resolve('/mnt/readonly-data/escape-link/passwd')).rejects.toThrow(
          /Access denied/
        );

        await expect(fsService.lstat('/mnt/readonly-data/escape-link')).rejects.toThrow(
          /Access denied/
        );
      }
    });

    it('guarantees per-space mount isolation (Space A mounts are invisible to Space B)', async () => {
      const ctxA = new Context();
      const ctxB = new Context();

      // Space A has hostDatasetRO at /mnt/data-a
      const fsA = new SpaceIsolatedFileSystem(ctxA, {
        cwd: spaceADir,
        mounts: [
          { id: 'mnt_a', name: 'data-a', sourcePath: hostDatasetRO, targetPath: hostDatasetRO, mode: 'ro' },
        ],
      });

      // Space B has hostDatasetB at /mnt/data-b
      const fsB = new SpaceIsolatedFileSystem(ctxB, {
        cwd: spaceBDir,
        mounts: [
          { id: 'mnt_b', name: 'data-b', sourcePath: hostDatasetB, targetPath: hostDatasetB, mode: 'ro' },
        ],
      });

      // Space A can access /mnt/data-a, but NOT /mnt/data-b
      const targetA = await fsA.resolve('/mnt/data-a/dataset.csv');
      expect(await fsA.readText(targetA)).toContain('1,alice');
      await expect(fsA.resolve('/mnt/data-b/space-b-data.txt')).rejects.toThrow(/outside space boundary/);

      // Space B can access /mnt/data-b, but NOT /mnt/data-a
      const targetB = await fsB.resolve('/mnt/data-b/space-b-data.txt');
      expect(await fsB.readText(targetB)).toBe('Space B exclusive data');
      await expect(fsB.resolve('/mnt/data-a/dataset.csv')).rejects.toThrow(/outside space boundary/);
    });

    it('supports same slug name in different spaces pointing to different physical targets', async () => {
      const ctxA = new Context();
      const ctxB = new Context();

      // Space A mounts hostDatasetRO as /mnt/dataset
      const fsA = new SpaceIsolatedFileSystem(ctxA, {
        cwd: spaceADir,
        mounts: [
          { id: 'mnt_1', name: 'dataset', sourcePath: hostDatasetRO, targetPath: hostDatasetRO, mode: 'ro' },
        ],
      });

      // Space B mounts hostDatasetB as /mnt/dataset
      const fsB = new SpaceIsolatedFileSystem(ctxB, {
        cwd: spaceBDir,
        mounts: [
          { id: 'mnt_2', name: 'dataset', sourcePath: hostDatasetB, targetPath: hostDatasetB, mode: 'ro' },
        ],
      });

      // Both spaces access /mnt/dataset, but see completely different data
      const targetA = await fsA.resolve('/mnt/dataset/dataset.csv');
      expect(await fsA.readText(targetA)).toContain('1,alice');

      const targetB = await fsB.resolve('/mnt/dataset/space-b-data.txt');
      expect(await fsB.readText(targetB)).toBe('Space B exclusive data');
    });
  });

  describe('SpaceIsolatedBashExecutor Mount Resolution & Execution', () => {
    it('executes bash command with workdir set to /mnt/<name> and sanitizes output', async () => {
      const ctx = new Context();
      await ctx.plugin(LocalSubprocess);

      const mounts: ResolvedRuntimeMount[] = [
        { id: 'mnt_ro', name: 'readonly-data', sourcePath: hostDatasetRO, targetPath: hostDatasetRO, mode: 'ro' },
      ];

      const bash = new SpaceIsolatedBashExecutor(ctx, {
        cwd: spaceADir,
        mounts,
      });

      const spec = bash.resolve({
        command: 'cat dataset.csv',
        workdir: '/mnt/readonly-data',
      });

      expect(spec.workdir).toBe(fs.realpathSync(hostDatasetRO));

      const res = await bash.run(spec);
      expect(res.exitCode).toBe(0);
      expect(res.stdout?.text).toContain('1,alice');
    });

    it('rewrites /mnt/<name> in bash command string and sanitizes stdout/stderr', async () => {
      const ctx = new Context();
      await ctx.plugin(LocalSubprocess);

      const mounts: ResolvedRuntimeMount[] = [
        { id: 'mnt_ro', name: 'readonly-data', sourcePath: hostDatasetRO, targetPath: hostDatasetRO, mode: 'ro' },
      ];

      const bash = new SpaceIsolatedBashExecutor(ctx, {
        cwd: spaceADir,
        mounts,
      });

      const spec = bash.resolve({
        command: 'head -n 2 /mnt/readonly-data/dataset.csv',
        workdir: spaceADir,
      });

      expect(spec.command).toContain(hostDatasetRO);

      const res = await bash.run(spec);
      expect(res.exitCode).toBe(0);
      expect(res.stdout?.text).toContain('1,alice');
      expect(res.stdout?.text).not.toContain(hostDatasetRO);
    });

    it('rejects mutation shell commands attempting to write into RO mounts', async () => {
      const ctx = new Context();
      await ctx.plugin(LocalSubprocess);

      const mounts: ResolvedRuntimeMount[] = [
        { id: 'mnt_ro', name: 'readonly-data', sourcePath: hostDatasetRO, targetPath: hostDatasetRO, mode: 'ro' },
      ];

      const bash = new SpaceIsolatedBashExecutor(ctx, {
        cwd: spaceADir,
        mounts,
      });

      // Attempting redirection to /mnt/readonly-data
      expect(() =>
        bash.resolve({
          command: 'echo "hacked" > /mnt/readonly-data/hacked.txt',
          workdir: spaceADir,
        })
      ).toThrow(/cannot write to read-only mount "\/mnt\/readonly-data"/);

      // Attempting rm in workdir /mnt/readonly-data
      expect(() =>
        bash.resolve({
          command: 'rm dataset.csv',
          workdir: '/mnt/readonly-data',
        })
      ).toThrow(/mount "\/mnt\/readonly-data" is read-only; mutation commands are forbidden/);
    });

    it('allows mutation commands in RW mounts', async () => {
      const ctx = new Context();
      await ctx.plugin(LocalSubprocess);

      const mounts: ResolvedRuntimeMount[] = [
        { id: 'mnt_rw', name: 'scratch', sourcePath: hostScratchRW, targetPath: hostScratchRW, mode: 'rw' },
      ];

      const bash = new SpaceIsolatedBashExecutor(ctx, {
        cwd: spaceADir,
        mounts,
      });

      const spec = bash.resolve({
        command: 'echo "created-by-bash" > /mnt/scratch/bash-out.txt',
        workdir: spaceADir,
      });

      const res = await bash.run(spec);
      expect(res.exitCode).toBe(0);
      expect(fs.readFileSync(path.join(hostScratchRW, 'bash-out.txt'), 'utf8').trim()).toBe(
        'created-by-bash'
      );
    });

    it('rejects path traversal in bash workdir escaping mount boundary', async () => {
      const ctx = new Context();
      await ctx.plugin(LocalSubprocess);

      const mounts: ResolvedRuntimeMount[] = [
        { id: 'mnt_ro', name: 'readonly-data', sourcePath: hostDatasetRO, targetPath: hostDatasetRO, mode: 'ro' },
      ];

      const bash = new SpaceIsolatedBashExecutor(ctx, {
        cwd: spaceADir,
        mounts,
      });

      expect(() =>
        bash.resolve({
          command: 'ls',
          workdir: '/mnt/readonly-data/../../etc',
        })
      ).toThrow(/traverses outside mount boundary/);
    });
  });

  describe('mountWorkspaceTools Full Integration', () => {
    it('mounts tools and allows read/write/bash operations on space and mounts', async () => {
      const agentCtx = new Context();
      const mounts: ResolvedRuntimeMount[] = [
        { id: 'mnt_ro', name: 'ro-data', sourcePath: hostDatasetRO, targetPath: hostDatasetRO, mode: 'ro' },
        { id: 'mnt_rw', name: 'rw-data', sourcePath: hostScratchRW, targetPath: hostScratchRW, mode: 'rw' },
      ];

      const handle = await mountWorkspaceTools(agentCtx, {
        spacePath: spaceADir,
        dshHome: dshHomeDir,
        mounts,
      });

      expect(handle.spacePath).toBe(spaceADir);
      expect(handle.fibers.length).toBeGreaterThan(5);

      const fsService = agentCtx.get('fs') as any;
      expect(fsService).toBeDefined();

      const targetRO = await fsService.resolve('/mnt/ro-data/dataset.csv');
      const readRes = await fsService.readText(targetRO);
      expect(readRes).toContain('1,alice');

      await handle.dispose();
    });
  });
});
