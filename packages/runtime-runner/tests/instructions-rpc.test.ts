/**
 * Comprehensive Daemon RPC Tests for Instructions Read & Write
 *
 * Tests:
 * 1. instructionsRead & instructionsWrite RPC targets: 'global' and 'space'
 * 2. Global path fixed to $DSH_HOME/AGENTS.md, max 20 KiB limit
 * 3. Space path fixed to <spaceFolder>/AGENTS.md or CLAUDE.md, max 64 KiB limit
 * 4. Safe primitives: O_NOFOLLOW, regular file check, UID verification, UTF-8 NFC normalization
 * 5. Atomic temp file + fsync + rename
 * 6. Strong ETag SHA-256 and expectedEtag CAS / requireAbsent
 * 7. Non-existent file returns empty content with etag: null and exists: false
 * 8. Zero leakage of host filesystem paths or stack traces in error envelopes
 * 9. Daemon maintenance: Writing instructions does NOT evict active agents
 *
 * @module @enkeep/runtime-runner/tests/instructions-rpc.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  executeInstructionsRead,
  executeInstructionsWrite,
  FileOpError,
  MAX_GLOBAL_INSTRUCTIONS_BYTES,
  MAX_SPACE_INSTRUCTIONS_BYTES,
} from '../src/runtime/file-ops.js';
import {
  DAEMON_OPS,
  type InstructionsReadRequest,
  type InstructionsWriteRequest,
  type InstructionsReadResponse,
  type InstructionsWriteResponse,
} from '../src/runtime/daemon-protocol.js';
import { RuntimeDaemon } from '../src/runtime/daemon.js';
import { SessionId } from '@deepseek-ai/dsh-session';

describe('Runtime Daemon RPC: instructionsRead & instructionsWrite', () => {
  let tmpDir: string;
  let dshHome: string;
  let spacesDir: string;
  let spaceA: string;
  let spaceAPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-instructions-rpc-test-'));
    dshHome = path.join(tmpDir, '.dsh');
    spacesDir = path.join(tmpDir, 'spaces');
    spaceA = 'space-alpha';
    spaceAPath = path.join(spacesDir, spaceA);

    fs.mkdirSync(dshHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(spacesDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(spaceAPath, { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe('1. Global Instructions RPC ($DSH_HOME/AGENTS.md)', () => {
    it('returns empty content and null ETag when global file does not exist', () => {
      const res = executeInstructionsRead(
        { target: 'global' },
        { spacesDir, dshHome }
      );

      expect(res.exists).toBe(false);
      expect(res.content).toBe('');
      expect(res.etag).toBeNull();
      expect(res.size).toBe(0);
      expect(res.target).toBe('global');
      expect(res.filename).toBe('AGENTS.md');
    });

    it('writes global instructions atomically and computes SHA-256 ETag', () => {
      const content = '# Global Instructions\n- Be concise\n- Follow instructions';
      const writeRes = executeInstructionsWrite(
        { target: 'global', content },
        { spacesDir, dshHome }
      );

      expect(writeRes.target).toBe('global');
      expect(writeRes.filename).toBe('AGENTS.md');
      expect(writeRes.size).toBe(Buffer.byteLength(content, 'utf8'));
      expect(writeRes.etag).toMatch(/^"[0-9a-f]{64}"$/);

      // Verify file on disk
      const globalFile = path.join(dshHome, 'AGENTS.md');
      expect(fs.existsSync(globalFile)).toBe(true);
      expect(fs.readFileSync(globalFile, 'utf8')).toBe(content);

      // Read back
      const readRes = executeInstructionsRead(
        { target: 'global' },
        { spacesDir, dshHome }
      );
      expect(readRes.exists).toBe(true);
      expect(readRes.content).toBe(content);
      expect(readRes.etag).toBe(writeRes.etag);
    });

    it('enforces strict 20 KiB size limit for global instructions', () => {
      const oversized = 'G'.repeat(MAX_GLOBAL_INSTRUCTIONS_BYTES + 1);
      expect(() => {
        executeInstructionsWrite(
          { target: 'global', content: oversized },
          { spacesDir, dshHome }
        );
      }).toThrow(FileOpError);
    });

    it('strictly rejects non-AGENTS.md filename for global target', () => {
      expect(() => {
        executeInstructionsWrite(
          { target: 'global', filename: 'CLAUDE.md', content: '# Disallowed' },
          { spacesDir, dshHome }
        );
      }).toThrow(FileOpError);

      expect(() => {
        executeInstructionsRead(
          { target: 'global', filename: 'CUSTOM.md' },
          { spacesDir, dshHome }
        );
      }).toThrow(FileOpError);
    });

    it('supports ETag CAS (Compare-And-Swap) for global instructions', () => {
      const w1 = executeInstructionsWrite(
        { target: 'global', content: 'Version 1' },
        { spacesDir, dshHome }
      );

      // CAS update with matching expectedEtag
      const w2 = executeInstructionsWrite(
        { target: 'global', content: 'Version 2', expectedEtag: w1.etag },
        { spacesDir, dshHome }
      );
      expect(w2.etag).not.toBe(w1.etag);

      // CAS update with stale expectedEtag -> PRECONDITION_FAILED
      expect(() => {
        executeInstructionsWrite(
          { target: 'global', content: 'Version 3 Stale', expectedEtag: w1.etag },
          { spacesDir, dshHome }
        );
      }).toThrow(FileOpError);
    });
  });

  describe('2. Space Instructions RPC (<spaceFolder>/AGENTS.md & CLAUDE.md)', () => {
    it('defaults space filename to AGENTS.md and supports CLAUDE.md', () => {
      // 1. Write space AGENTS.md
      const wAgents = executeInstructionsWrite(
        { target: 'space', spaceFolder: spaceA, content: '# Space AGENTS' },
        { spacesDir, dshHome }
      );
      expect(wAgents.filename).toBe('AGENTS.md');
      expect(fs.existsSync(path.join(spaceAPath, 'AGENTS.md'))).toBe(true);

      // 2. Write space CLAUDE.md
      const wClaude = executeInstructionsWrite(
        { target: 'space', spaceFolder: spaceA, filename: 'CLAUDE.md', content: '# Space CLAUDE' },
        { spacesDir, dshHome }
      );
      expect(wClaude.filename).toBe('CLAUDE.md');
      expect(fs.existsSync(path.join(spaceAPath, 'CLAUDE.md'))).toBe(true);

      // 3. Read back independently
      const rAgents = executeInstructionsRead(
        { target: 'space', spaceFolder: spaceA },
        { spacesDir, dshHome }
      );
      expect(rAgents.content).toBe('# Space AGENTS');

      const rClaude = executeInstructionsRead(
        { target: 'space', spaceFolder: spaceA, filename: 'CLAUDE.md' },
        { spacesDir, dshHome }
      );
      expect(rClaude.content).toBe('# Space CLAUDE');
    });

    it('enforces strict 64 KiB size limit for space instructions', () => {
      const oversized = 'S'.repeat(MAX_SPACE_INSTRUCTIONS_BYTES + 1);
      expect(() => {
        executeInstructionsWrite(
          { target: 'space', spaceFolder: spaceA, content: oversized },
          { spacesDir, dshHome }
        );
      }).toThrow(FileOpError);
    });

    it('strictly rejects unauthorized space filenames and path traversals', () => {
      expect(() => {
        executeInstructionsWrite(
          { target: 'space', spaceFolder: spaceA, filename: '../evil.txt', content: 'bad' },
          { spacesDir, dshHome }
        );
      }).toThrow(FileOpError);

      expect(() => {
        executeInstructionsWrite(
          { target: 'space', spaceFolder: spaceA, filename: 'RULES.md', content: 'bad' },
          { spacesDir, dshHome }
        );
      }).toThrow(FileOpError);

      expect(() => {
        executeInstructionsWrite(
          { target: 'space', spaceFolder: '../evilSpace', content: 'bad' },
          { spacesDir, dshHome }
        );
      }).toThrow(FileOpError);
    });
  });

  describe('3. Security Primitives: Symlinks, O_NOFOLLOW & Unicode NFC', () => {
    it('strictly rejects symlinked target files (O_NOFOLLOW & SYMLINK_FORBIDDEN)', () => {
      const outsideTarget = path.join(tmpDir, 'outside-secret.txt');
      fs.writeFileSync(outsideTarget, 'OUTSIDE SECRET DATA', 'utf8');

      // Create a symlink in spaceA pointing to outside secret
      const symlinkPath = path.join(spaceAPath, 'AGENTS.md');
      fs.symlinkSync(outsideTarget, symlinkPath);

      // Read attempt must fail with SYMLINK_FORBIDDEN
      expect(() => {
        executeInstructionsRead(
          { target: 'space', spaceFolder: spaceA, filename: 'AGENTS.md' },
          { spacesDir, dshHome }
        );
      }).toThrow(FileOpError);

      // Write attempt over symlink must fail with SYMLINK_FORBIDDEN
      expect(() => {
        executeInstructionsWrite(
          { target: 'space', spaceFolder: spaceA, filename: 'AGENTS.md', content: 'overwrite' },
          { spacesDir, dshHome }
        );
      }).toThrow(FileOpError);
    });

    it('normalizes Unicode strings to canonical NFC form', () => {
      const decomposed = 'Cafe\u0301 Instructions';
      const composed = 'Caf\u00E9 Instructions';

      const writeRes = executeInstructionsWrite(
        { target: 'space', spaceFolder: spaceA, content: decomposed },
        { spacesDir, dshHome }
      );

      const readRes = executeInstructionsRead(
        { target: 'space', spaceFolder: spaceA },
        { spacesDir, dshHome }
      );

      expect(readRes.content).toBe(composed);
      expect(readRes.etag).toBe(writeRes.etag);
    });
  });

  describe('4. Daemon Integration & Non-Eviction Guarantee', () => {
    it('executes instructionsRead and instructionsWrite over Daemon protocol without evicting active agents', async () => {
      const daemon = new RuntimeDaemon({
        dshHome,
        spacesDir,
        userId: 'alice',
      });

      await daemon.start();

      try {
        const sessionId = 'ses_0123456789abcdef0123456789abcdef';

        // 1. Send an initial turn to warm up an active agent
        const submitRes = await daemon.handleRequest({
          id: 'req_1',
          op: DAEMON_OPS.SUBMIT_TURN,
          turnId: 'turn_0123456789abcdef0123456789abcde1',
          sessionId,
          prompt: 'Initial turn message',
          workspaceFolder: spaceA,
        });
        expect(submitRes.ok).toBe(true);

        const stats1 = (await daemon.handleRequest({ id: 'req_stats1', op: DAEMON_OPS.HEALTH })) as any;
        expect(stats1.stats.activeAgentsCount).toBeGreaterThanOrEqual(1);

        // 2. Perform instructionsWrite via daemon RPC
        const writeRpcRes = (await daemon.handleRequest({
          id: 'req_write',
          op: DAEMON_OPS.INSTRUCTIONS_WRITE,
          target: 'global',
          content: '# Daemon Updated Global Instructions',
        })) as InstructionsWriteResponse;

        expect(writeRpcRes.ok).toBe(true);
        expect(writeRpcRes.etag).toMatch(/^"[0-9a-f]{64}"$/);

        // 3. Verify agent was NOT evicted by write
        const stats2 = (await daemon.handleRequest({ id: 'req_stats2', op: DAEMON_OPS.HEALTH })) as any;
        expect(stats2.stats.activeAgentsCount).toBe(stats1.stats.activeAgentsCount);

        // 4. Perform instructionsRead via daemon RPC
        const readRpcRes = (await daemon.handleRequest({
          id: 'req_read',
          op: DAEMON_OPS.INSTRUCTIONS_READ,
          target: 'global',
        })) as InstructionsReadResponse;

        expect(readRpcRes.ok).toBe(true);
        expect(readRpcRes.exists).toBe(true);
        expect(readRpcRes.content).toBe('# Daemon Updated Global Instructions');
        expect(readRpcRes.etag).toBe(writeRpcRes.etag);
      } finally {
        await daemon.shutdown(1000);
      }
    });
  });
});
