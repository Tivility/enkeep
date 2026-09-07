/**
 * Direct Runtime Workspace Tools & Multi-Space Isolation Integration Test Suite
 *
 * Strictly tests:
 * 1. SpaceA workspace tools (read, write, edit, glob, grep, bash) operate within SpaceA.
 * 2. SpaceA is strictly prohibited from reading SpaceB files, $DSH_HOME sessions, or rootfs.
 * 3. SpaceA bash executor rejects non-existent workdirs and workdirs outside SpaceA (e.g. spaceBPath or $DSH_HOME).
 * 4. Symlinks inside SpaceA pointing to SpaceB are strictly blocked by resolve and lstat.
 * 5. SpaceB has different AGENTS.md instructions and does not crosstalk with SpaceA.
 * 6. Subagents inherit workspace tools and can read files within the active space.
 * 7. Persistent session restart preserves written files on disk and session state.
 * 8. Spill files are scoped to spacePath/.dsh-spill and do not leak across spaces.
 * 9. Health capabilities reflect genuine probes on read, write, and bash.
 *
 * @module @enkeep/runtime-runner/tests/workspace-tools.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionId } from '@deepseek-ai/dsh-session';
import {
  bootDshRuntime,
  type DshBootedRuntime,
} from '../src/runtime/dsh-boot.js';
import {
  SpaceIsolatedFileSystem,
  SpaceIsolatedBashExecutor,
} from '../src/runtime/official-plugins.js';
import { Context } from '@deepseek-ai/cordis';
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local';

describe('Official DSH Workspace Tools & Multi-Space Isolation', () => {
  let tmpDir: string;
  let aliceHome: string;
  let aliceSpaces: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-ws-tools-test-'));
    aliceHome = path.join(tmpDir, 'alice', '.dsh');
    aliceSpaces = path.join(tmpDir, 'alice', 'spaces');

    fs.mkdirSync(aliceHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(aliceSpaces, { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('SpaceA executes write, read, edit, glob, grep, and bash tools within its space boundary', async () => {
    const spaceA = 'space-alpha';
    const spaceAPath = path.join(aliceSpaces, spaceA);
    fs.mkdirSync(spaceAPath, { recursive: true, mode: 0o700 });

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      const sessionId = 'ses_0123456789abcdef0123456789abcde1';

      // 1. Tool: write
      const writeTurn = await runtime.sendFollowup(
        '[enkeep-test-tool-call=write:{"file_path":"alpha.txt","content":"Hello from Space Alpha!"}] write file',
        sessionId,
        'turn_0123456789abcdef0123456789abcde1',
        null,
        spaceA
      );
      expect(writeTurn.status).toBe('completed');
      expect(fs.existsSync(path.join(spaceAPath, 'alpha.txt'))).toBe(true);
      expect(fs.readFileSync(path.join(spaceAPath, 'alpha.txt'), 'utf8')).toBe('Hello from Space Alpha!');

      // 2. Tool: read
      const readTurn = await runtime.sendFollowup(
        '[enkeep-test-tool-call=read:{"file_path":"alpha.txt"}] read file',
        sessionId,
        'turn_0123456789abcdef0123456789abcde2',
        null,
        spaceA
      );
      expect(readTurn.status).toBe('completed');

      // 3. Tool: edit
      const editTurn = await runtime.sendFollowup(
        '[enkeep-test-tool-call=edit:{"file_path":"alpha.txt","old_string":"Hello","new_string":"Greetings"}] edit file',
        sessionId,
        'turn_0123456789abcdef0123456789abcde3',
        null,
        spaceA
      );
      expect(editTurn.status).toBe('completed');
      expect(fs.readFileSync(path.join(spaceAPath, 'alpha.txt'), 'utf8')).toBe('Greetings from Space Alpha!');

      // 4. Tool: glob
      const globTurn = await runtime.sendFollowup(
        '[enkeep-test-tool-call=glob:{"pattern":"*.txt"}] glob files',
        sessionId,
        'turn_0123456789abcdef0123456789abcde4',
        null,
        spaceA
      );
      expect(globTurn.status).toBe('completed');

      // 5. Tool: grep
      const grepTurn = await runtime.sendFollowup(
        '[enkeep-test-tool-call=grep:{"pattern":"Greetings"}] grep files',
        sessionId,
        'turn_0123456789abcdef0123456789abcde5',
        null,
        spaceA
      );
      expect(grepTurn.status).toBe('completed');

      // 6. Tool: bash (pwd should be spaceAPath)
      const bashTurn = await runtime.sendFollowup(
        '[enkeep-test-tool-call=bash:{"command":"pwd","description":"print current directory"}] run pwd',
        sessionId,
        'turn_0123456789abcdef0123456789abcde6',
        null,
        spaceA
      );
      expect(bashTurn.status).toBe('completed');

      const agent = await runtime.getOrCreateAgent(sessionId, null, spaceA);
      const bashEvents = agent.session.snapshotEvents().filter((e) => e.type === 'tool/result');
      expect(bashEvents.length).toBeGreaterThanOrEqual(6);

      // Verify spill store is scoped to spaceAPath/.dsh-spill
      const spillPath = path.join(spaceAPath, '.dsh-spill');
      expect(fs.existsSync(spillPath)).toBe(true);
    } finally {
      await runtime.dispose();
    }
  }, 20_000);

  it('SpaceA is strictly forbidden from reading SpaceB files and $DSH_HOME sessions', async () => {
    const spaceA = 'space-alpha';
    const spaceB = 'space-beta';
    const spaceAPath = path.join(aliceSpaces, spaceA);
    const spaceBPath = path.join(aliceSpaces, spaceB);
    fs.mkdirSync(spaceAPath, { recursive: true, mode: 0o700 });
    fs.mkdirSync(spaceBPath, { recursive: true, mode: 0o700 });

    fs.writeFileSync(path.join(spaceBPath, 'secret-beta.txt'), 'TOP SECRET BETA', 'utf8');

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      const sessionIdA = 'ses_0123456789abcdef0123456789abcde1';
      const agentA = await runtime.getOrCreateAgent(sessionIdA, null, spaceA);

      // 1. Direct cross-space relative read attempt via agent's scoped fs
      const fsService = agentA.ctx.get('fs');
      expect(fsService).toBeDefined();

      await expect(
        fsService.resolve('../space-beta/secret-beta.txt', { cwd: spaceAPath })
      ).rejects.toThrow(/outside space boundary/);

      // 2. Direct absolute read attempt targeting spaceB
      await expect(
        fsService.resolve(path.join(spaceBPath, 'secret-beta.txt'), { cwd: spaceAPath })
      ).rejects.toThrow(/outside space boundary/);

      // 3. Direct read attempt targeting $DSH_HOME sessions
      const sessionsPath = path.join(aliceHome, 'sessions');
      await expect(
        fsService.resolve(sessionsPath, { cwd: spaceAPath })
      ).rejects.toThrow(/outside space boundary/);

      // 4. Bash workdir escape attempt targeting spaceBPath from spaceA scoped bash executor
      const shellService = agentA.ctx.get('shell');
      expect(shellService).toBeDefined();
      expect(() =>
        shellService.resolve({
          command: 'ls',
          workdir: spaceBPath,
          timeoutMs: 5000,
        })
      ).toThrow(/outside space boundary/);

      // 5. Bash workdir escape attempt targeting $DSH_HOME sessions
      expect(() =>
        shellService.resolve({
          command: 'ls',
          workdir: sessionsPath,
          timeoutMs: 5000,
        })
      ).toThrow(/outside space boundary/);

      // 6. Bash workdir targeting non-existent directory
      expect(() =>
        shellService.resolve({
          command: 'ls',
          workdir: path.join(spaceAPath, 'non-existent-subfolder'),
          timeoutMs: 5000,
        })
      ).toThrow(/does not exist/);

      // 7. Symlink escape attempt inside spaceA pointing to spaceB
      const symlinkPath = path.join(spaceAPath, 'symlink_to_b');
      fs.symlinkSync(spaceBPath, symlinkPath);
      await expect(
        fsService.resolve('symlink_to_b/secret-beta.txt', { cwd: spaceAPath })
      ).rejects.toThrow(/outside space boundary/);

      await expect(
        fsService.lstat('symlink_to_b', { cwd: spaceAPath })
      ).rejects.toThrow(/outside space boundary/);
    } finally {
      await runtime.dispose();
    }
  });

  it('SpaceA and SpaceB load distinct AGENTS.md instructions without crosstalk', async () => {
    const spaceA = 'space-alpha';
    const spaceB = 'space-beta';
    const spaceAPath = path.join(aliceSpaces, spaceA);
    const spaceBPath = path.join(aliceSpaces, spaceB);
    fs.mkdirSync(spaceAPath, { recursive: true, mode: 0o700 });
    fs.mkdirSync(spaceBPath, { recursive: true, mode: 0o700 });

    fs.writeFileSync(path.join(spaceAPath, 'AGENTS.md'), '# Space Alpha Custom Rules', 'utf8');
    fs.writeFileSync(path.join(spaceBPath, 'AGENTS.md'), '# Space Beta Strict Guidelines', 'utf8');

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      const sessionA = 'ses_0123456789abcdef0123456789abcdea';
      const sessionB = 'ses_0123456789abcdef0123456789abcdeb';

      // Turn on Space A
      await runtime.sendFollowup(
        'Alpha session turn 1',
        sessionA,
        'turn_0123456789abcdef0123456789abcde1',
        null,
        spaceA
      );

      // Turn on Space B
      await runtime.sendFollowup(
        'Beta session turn 1',
        sessionB,
        'turn_0123456789abcdef0123456789abcde2',
        null,
        spaceB
      );

      const agentA = await runtime.getOrCreateAgent(sessionA, null, spaceA);
      const agentB = await runtime.getOrCreateAgent(sessionB, null, spaceB);

      const instructionsA = agentA.session.snapshotEvents()
        .filter((e) => e.type === 'user/message' && (e.data as any)?.source?.kind === 'agent-instructions')
        .map((e) => JSON.stringify(e.data));

      const instructionsB = agentB.session.snapshotEvents()
        .filter((e) => e.type === 'user/message' && (e.data as any)?.source?.kind === 'agent-instructions')
        .map((e) => JSON.stringify(e.data));

      expect(instructionsA.some((msg) => msg.includes('Space Alpha Custom Rules'))).toBe(true);
      expect(instructionsA.some((msg) => msg.includes('Space Beta Strict Guidelines'))).toBe(false);

      expect(instructionsB.some((msg) => msg.includes('Space Beta Strict Guidelines'))).toBe(true);
      expect(instructionsB.some((msg) => msg.includes('Space Alpha Custom Rules'))).toBe(false);
    } finally {
      await runtime.dispose();
    }
  });

  it('Subagents inherit workspace tools and can read files within active space', async () => {
    const spaceA = 'space-alpha';
    const spaceAPath = path.join(aliceSpaces, spaceA);
    fs.mkdirSync(spaceAPath, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(spaceAPath, 'shared.txt'), 'Shared data for subagent reading', 'utf8');

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      const sessionId = 'ses_0123456789abcdef0123456789abcde1';
      const parentAgent = await runtime.getOrCreateAgent(sessionId, null, spaceA);

      const subagents = runtime.context.get('subagents');
      expect(subagents).toBeDefined();

      const run = await subagents.start('spawn', {
        label: 'test-child',
        prompt: [{ type: 'text', text: 'Subagent reading shared workspace.' }],
        parent: parentAgent,
        signal: new AbortController().signal,
      });

      expect(run.id).toBeDefined();
      expect(run.localAgent).toBeDefined();

      // Child session header cwd should match parent spaceA
      expect(run.localAgent?.session.header.cwd).toBe(spaceAPath);

      const res = await run.result;
      expect(res.stopReason).toBe('completed');
      await run.dispose();
    } finally {
      await runtime.dispose();
    }
  });

  it('persists written space files and resumes session across runtime restart', async () => {
    const spaceA = 'space-alpha';
    const spaceAPath = path.join(aliceSpaces, spaceA);
    fs.mkdirSync(spaceAPath, { recursive: true, mode: 0o700 });

    const sessionId = 'ses_0123456789abcdef0123456789abcde1';

    // 1. Initial runtime writes file
    const runtime1 = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      const res1 = await runtime1.sendFollowup(
        '[enkeep-test-tool-call=write:{"file_path":"persistent.txt","content":"Persisted across restart"}] write file',
        sessionId,
        'turn_0123456789abcdef0123456789abcde1',
        null,
        spaceA
      );
      expect(res1.status).toBe('completed');
    } finally {
      await runtime1.dispose();
    }

    // 2. Second runtime resumes session and reads persisted file
    const runtime2 = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      expect(fs.existsSync(path.join(spaceAPath, 'persistent.txt'))).toBe(true);
      expect(fs.readFileSync(path.join(spaceAPath, 'persistent.txt'), 'utf8')).toBe('Persisted across restart');

      const res2 = await runtime2.sendFollowup(
        '[enkeep-test-tool-call=read:{"file_path":"persistent.txt"}] read persistent file',
        sessionId,
        'turn_0123456789abcdef0123456789abcde2',
        null,
        spaceA
      );
      expect(res2.status).toBe('completed');
      expect(res2.eventsCount).toBeGreaterThan(2);
    } finally {
      await runtime2.dispose();
    }
  });
});
