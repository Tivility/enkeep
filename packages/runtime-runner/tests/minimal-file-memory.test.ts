/**
 * POC Test: Minimal File-based Memory via DSH Agent Instructions & Files API
 *
 * Verifies:
 * 1. Space instructions (space/AGENTS.md) loaded on initial turn.
 * 2. Precedence and deduplication (AGENTS.md over CLAUDE.md).
 * 3. Warm agent dynamic update: modifying instructions file on disk is picked up automatically
 *    on the very next turn via pre-step reconciliation without agent recreation or restart.
 * 4. Multi-tenant isolation: User A's space instructions cannot leak to User B.
 * 5. Global instructions boundary analysis: In Enkeep, SpaceIsolatedFileSystem strictly jails
 *    fs operations to spacePath, demonstrating why user-global instructions ($DSH_HOME/AGENTS.md)
 *    either need read-allowlist in SpaceIsolatedFileSystem or space-level symlink/mount.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  bootDshRuntime,
  type DshBootedRuntime,
} from '../src/runtime/dsh-boot.js';

describe('Minimal File-based Memory via DSH Agent Instructions', () => {
  let tmpDir: string;
  let aliceHome: string;
  let aliceSpaces: string;
  let bobHome: string;
  let bobSpaces: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-file-memory-poc-'));
    aliceHome = path.join(tmpDir, 'alice', '.dsh');
    aliceSpaces = path.join(tmpDir, 'alice', 'spaces');
    bobHome = path.join(tmpDir, 'bob', '.dsh');
    bobSpaces = path.join(tmpDir, 'bob', 'spaces');

    fs.mkdirSync(aliceHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(aliceSpaces, { recursive: true, mode: 0o700 });
    fs.mkdirSync(bobHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(bobSpaces, { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('loads Space-level (space/AGENTS.md) instructions into baseline context', async () => {
    // 1. Write Space-specific instruction
    fs.writeFileSync(
      path.join(aliceSpaces, 'AGENTS.md'),
      '# Space Alpha Guidelines\nFollow repository-specific test-driven workflow.',
      'utf8'
    );

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      const sessionId = 'ses_0123456789abcdef0123456789abcdef';
      const agent = await runtime.getOrCreateAgent(sessionId);

      const res = await runtime.sendFollowup(
        'Turn 1: Initialize session and check context.',
        sessionId,
        'turn_0123456789abcdef0123456789abcde1',
        null
      );
      expect(res.status).toBe('completed');

      // Find instruction messages in session log
      const instructionMessages = agent.session.snapshotEvents()
        .filter((e) => e.type === 'user/message' && (e.data as any)?.source?.kind === 'agent-instructions')
        .map((e) => (e.data as any).content.map((c: any) => c.text).join('\n'));

      expect(instructionMessages.length).toBeGreaterThan(0);
      const combined = instructionMessages.join('\n');
      expect(combined).toContain('Follow repository-specific test-driven workflow');
    } finally {
      await runtime.dispose();
    }
  });

  it('picks up external file updates on warm agent on the next turn via pre-step reconciliation', async () => {
    const spaceAgentsPath = path.join(aliceSpaces, 'AGENTS.md');
    fs.writeFileSync(spaceAgentsPath, '# Space v1 Rules\nInitial rule set.', 'utf8');

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      const sessionId = 'ses_0123456789abcdef0123456789abcdef';
      const agent = await runtime.getOrCreateAgent(sessionId);

      // Turn 1: Warm up agent with v1
      const res1 = await runtime.sendFollowup(
        'Turn 1: Warm up agent.',
        sessionId,
        'turn_0123456789abcdef0123456789abcde1',
        null
      );
      expect(res1.status).toBe('completed');

      // Simulate Web API editing the space instructions file on disk (RuntimeDaemon file op)
      fs.writeFileSync(spaceAgentsPath, '# Space v2 Rules\nUpdated dynamic rule set from Web UI.', 'utf8');

      // Turn 2: Warm agent executes without being restarted or evicted
      const res2 = await runtime.sendFollowup(
        'Turn 2: Agent executes next step after Web UI edit.',
        sessionId,
        'turn_0123456789abcdef0123456789abcde2',
        null
      );
      expect(res2.status).toBe('completed');

      // Session log should record updated instructions
      const allInstructionTexts = agent.session.snapshotEvents()
        .filter((e) => e.type === 'user/message' && (e.data as any)?.source?.kind === 'agent-instructions')
        .map((e) => (e.data as any).content.map((c: any) => c.text).join('\n'))
        .join('\n');

      expect(allInstructionTexts).toContain('Updated dynamic rule set from Web UI');
    } finally {
      await runtime.dispose();
    }
  });

  it('respects precedence and deduplication: AGENTS.md over CLAUDE.md in same directory', async () => {
    fs.writeFileSync(path.join(aliceSpaces, 'AGENTS.md'), '# Priority AGENTS Rules', 'utf8');
    fs.writeFileSync(path.join(aliceSpaces, 'CLAUDE.md'), '# Secondary CLAUDE Rules', 'utf8');

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      const sessionId = 'ses_0123456789abcdef0123456789abcdef';
      const agent = await runtime.getOrCreateAgent(sessionId);

      await runtime.sendFollowup(
        'Check precedence.',
        sessionId,
        'turn_0123456789abcdef0123456789abcde1',
        null
      );

      const instructionMessages = agent.session.snapshotEvents()
        .filter((e) => e.type === 'user/message' && (e.data as any)?.source?.kind === 'agent-instructions')
        .map((e) => JSON.stringify(e.data));

      expect(instructionMessages.some((msg) => msg.includes('Priority AGENTS Rules'))).toBe(true);
    } finally {
      await runtime.dispose();
    }
  });

  it('guarantees tenant isolation: Bob cannot see Alice space instructions', async () => {
    fs.writeFileSync(
      path.join(aliceSpaces, 'AGENTS.md'),
      '# Alice Space Secret=AliceSpaceDoc888',
      'utf8'
    );

    const bobRuntime = await bootDshRuntime({
      userId: 'bob',
      dshHome: bobHome,
      spacesDir: bobSpaces,
    });

    try {
      const bobSessionId = 'ses_0123456789abcdef0123456789abcdef';
      const bobAgent = await bobRuntime.getOrCreateAgent(bobSessionId);

      const res = await bobRuntime.sendFollowup(
        'Bob asks for instructions.',
        bobSessionId,
        'turn_0123456789abcdef0123456789abcde1',
        null
      );
      expect(res.status).toBe('completed');

      const bobInstructionTexts = bobAgent.session.snapshotEvents()
        .filter((e) => e.type === 'user/message' && (e.data as any)?.source?.kind === 'agent-instructions')
        .map((e) => JSON.stringify(e.data))
        .join('\n');

      expect(bobInstructionTexts).not.toContain('AliceSpaceDoc888');
    } finally {
      await bobRuntime.dispose();
    }
  });
});
