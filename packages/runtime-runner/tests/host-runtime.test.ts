/**
 * Comprehensive Host Runtime Execution Tests
 *
 * Tests the real child process Host Runtime Daemon, UDS transport, signed process registry,
 * collision non-adoption, environment secret filtering, multi-turn session persistence,
 * cancellation, idle eviction, workspace persistence across restarts, and file operations.
 *
 * @module @enkeep/runtime-runner/tests/host-runtime.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  HostRuntimeAdapter,
  HostDaemonTransport,
  HostOwnershipError,
  HostCollisionError,
  HostNotFoundError,
  filterHostEnvironment,
  validateHostRuntimePaths,
  writeProcessMeta,
  readProcessMeta,
  cleanStaleProcess,
  killProcessTree,
  HostLlmProxyServer,
  type HostRuntimeSpec,
  type ActiveRuntimeHandle,
} from '../src/index.js';

describe('Host Runtime Adapter & Lifecycle Subsystem', () => {
  let tmpDataRoot: string;
  let adapter: HostRuntimeAdapter;
  const activeHandles: ActiveRuntimeHandle[] = [];

  beforeEach(() => {
    tmpDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-host-test-root-'));
    adapter = new HostRuntimeAdapter();
  });

  afterEach(async () => {
    for (const h of activeHandles) {
      try {
        await h.stop();
      } catch {}
    }
    activeHandles.length = 0;

    if (fs.existsSync(tmpDataRoot)) {
      try {
        fs.rmSync(tmpDataRoot, { recursive: true, force: true });
      } catch {}
    }
  });

  describe('1. Specification & Path Containment Validation', () => {
    it('generates valid compliant HostRuntimeSpec under dataRoot', () => {
      const spec = adapter.createDefaultUserSpec({
        userId: 'alice',
        dataRoot: tmpDataRoot,
      });

      expect(spec.executionMode).toBe('host');
      expect(spec.userId).toBe('alice');
      expect(spec.runId).toMatch(/^run_[0-9a-f]{32}$/);
      expect(spec.storageId).toMatch(/^vol_[0-9a-f]{32}$/);
      expect(spec.dshHome).toBe(path.join(tmpDataRoot, 'host-runtimes', 'alice', '.dsh'));
      expect(spec.spacesDir).toBe(path.join(tmpDataRoot, 'host-runtimes', 'alice', 'spaces'));
      expect(spec.runDir).toBe(path.join(tmpDataRoot, 'host-runtimes', 'alice', 'run'));
      expect(spec.socketPath).toBeDefined();
      expect(spec.socketPath).toMatch(/\.sock$/);
      expect(spec.llmProvider).toBe('cpa-gemini');
      expect(spec.llmModel).toBe('gemini-3.7-flash-tiered');
    });

    it('rejects arbitrary dshHome outside user root', () => {
      expect(() => {
        validateHostRuntimePaths({
          userId: 'alice',
          dataRoot: tmpDataRoot,
          dshHome: '/tmp/arbitrary-dsh-home',
          spacesDir: path.join(tmpDataRoot, 'host-runtimes', 'alice', 'spaces'),
          runDir: path.join(tmpDataRoot, 'host-runtimes', 'alice', 'run'),
        });
      }).toThrow(HostOwnershipError);
    });

    it('rejects non-sibling spaces directory', () => {
      expect(() => {
        validateHostRuntimePaths({
          userId: 'alice',
          dataRoot: tmpDataRoot,
          dshHome: path.join(tmpDataRoot, 'host-runtimes', 'alice', '.dsh'),
          spacesDir: path.join(tmpDataRoot, 'other-dir', 'spaces'),
          runDir: path.join(tmpDataRoot, 'host-runtimes', 'alice', 'run'),
        });
      }).toThrow(HostOwnershipError);
    });
  });

  describe('2. Environment Filtering & Secret Safety', () => {
    it('strips all sensitive platform keys and sets placeholders', () => {
      const origAws = process.env.AWS_SECRET_ACCESS_KEY;
      const origOpenAi = process.env.OPENAI_API_KEY;
      const origClaude = process.env.ANTHROPIC_API_KEY;

      process.env.AWS_SECRET_ACCESS_KEY = 'super-secret-aws';
      process.env.OPENAI_API_KEY = 'sk-real-secret';
      process.env.ANTHROPIC_API_KEY = 'sk-ant-real-secret';

      try {
        const spec = adapter.createDefaultUserSpec({
          userId: 'alice',
          dataRoot: tmpDataRoot,
        });

        const filtered = filterHostEnvironment(spec);

        expect(filtered.AWS_SECRET_ACCESS_KEY).toBeUndefined();
        expect(filtered.OPENAI_API_KEY).toBe('in-container-placeholder');
        expect(filtered.ANTHROPIC_API_KEY).toBe('in-container-placeholder');
        expect(filtered.DEEPSEEK_API_KEY).toBe('in-container-placeholder');
        expect(filtered.DSH_USER).toBe('alice');
        expect(filtered.DSH_HOME).toBe(spec.dshHome);
        expect(filtered.DSH_SPACES).toBe(spec.spacesDir);
        expect(filtered.HOME).toBe(spec.dshHome);
      } finally {
        if (origAws) process.env.AWS_SECRET_ACCESS_KEY = origAws;
        else delete process.env.AWS_SECRET_ACCESS_KEY;
        if (origOpenAi) process.env.OPENAI_API_KEY = origOpenAi;
        else delete process.env.OPENAI_API_KEY;
        if (origClaude) process.env.ANTHROPIC_API_KEY = origClaude;
        else delete process.env.ANTHROPIC_API_KEY;
      }
    });
  });

  describe('3. Signed Process Metadata & State Management', () => {
    it('writes and verifies signed process metadata with mode 0600', () => {
      const runDir = path.join(tmpDataRoot, 'host-runtimes', 'alice', 'run');
      const metaPath = path.join(runDir, 'process.meta.json');

      const meta = writeProcessMeta(metaPath, {
        pid: process.pid,
        startTime: Date.now(),
        nonce: 'test-nonce-1234',
        userId: 'alice',
        runId: 'run_test_1',
        storageId: 'vol_test_1',
        paths: {
          dshHome: '/test/dsh',
          spacesDir: '/test/spaces',
          runDir,
          socketPath: path.join(runDir, 'daemon.sock'),
        },
      });

      expect(meta.signature).toBeDefined();
      expect(meta.signature.length).toBe(64);

      const stat = fs.statSync(metaPath);
      // On POSIX check file mode is 0600 (or contains user rw only)
      if (process.platform !== 'win32') {
        expect(stat.mode & 0o777).toBe(0o600);
      }

      const readBack = readProcessMeta(metaPath);
      expect(readBack).not.toBeNull();
      expect(readBack?.pid).toBe(process.pid);
      expect(readBack?.userId).toBe('alice');

      // Tampered file detection
      fs.writeFileSync(metaPath, JSON.stringify({ ...meta, userId: 'bob' }));
      const tampered = readProcessMeta(metaPath);
      expect(tampered).toBeNull();
    });
  });

  describe('4. Real Child Process Execution & 10-Turn Session Reuse', () => {
    it('boots real host runtime daemon, reports healthy status, and executes 10 turns on same agent', async () => {
      const spec = adapter.createDefaultUserSpec({
        userId: 'alice',
        dataRoot: tmpDataRoot,
      });

      const handle = await adapter.startRuntime(spec, 15_000);
      activeHandles.push(handle);

      expect(handle.isCreated).toBe(true);
      expect(handle.pid).toBeGreaterThan(0);

      // Check health
      const health = await handle.checkHealth();
      expect(health.status).toBe('ok');
      expect(health.dshReady).toBe(true);
      expect(health.userId).toBe('alice');
      expect(health.plugins.tools).toBe(true);

      const sessionId = 'ses_0123456789abcdef0123456789abcdef';

      // Execute 10 sequential turns on the same session
      for (let i = 1; i <= 10; i++) {
        const turnId = `turn_0123456789abcdef0123456789abcde${i.toString(16)}`;
        const res = await handle.sendFollowup({
          prompt: `Turn message #${i}`,
          sessionId,
          turnId,
          workspaceFolder: 'space-a',
        });

        expect(res.status).toBe('completed');
        expect(res.sessionId).toBe(sessionId);
        expect(res.turnId).toBe(turnId);
        expect(res.replyText.toLowerCase()).toContain('alice');
        expect(res.persisted).toBe(true);
      }

      // Check session artifact exists and has all 10 turns
      const artifact = await handle.checkSessionArtifact!(sessionId, 'space-a');
      expect(artifact.exists).toBe(true);
      expect(artifact.valid).toBe(true);
      expect(artifact.eventsCount).toBeGreaterThanOrEqual(20);
    }, 30_000);

    it('enforces collision non-adoption when starting runtime for already-active user', async () => {
      const spec = adapter.createDefaultUserSpec({
        userId: 'bob',
        dataRoot: tmpDataRoot,
      });

      const handle = await adapter.startRuntime(spec, 15_000);
      activeHandles.push(handle);

      // Attempting second startRuntime on same user must fail with HostCollisionError
      await expect(adapter.startRuntime(spec, 5_000)).rejects.toThrow(HostCollisionError);
    }, 20_000);

    it('supports reconnecting to already-running host runtime daemon via connectRuntime', async () => {
      const spec = adapter.createDefaultUserSpec({
        userId: 'alice',
        dataRoot: tmpDataRoot,
      });

      const handle1 = await adapter.startRuntime(spec, 15_000);
      activeHandles.push(handle1);

      const handle2 = await adapter.connectRuntime(spec, 10_000);
      expect(handle2.isCreated).toBe(false);
      expect(handle2.pid).toBe(handle1.pid);

      const health = await handle2.checkHealth();
      expect(health.dshReady).toBe(true);
    }, 20_000);
  });

  describe('5. Multi-Session, Cancellation & Idle Agent Resumption', () => {
    it('executes turns across multiple distinct sessions in the same host runtime', async () => {
      const spec = adapter.createDefaultUserSpec({
        userId: 'alice',
        dataRoot: tmpDataRoot,
      });

      const handle = await adapter.startRuntime(spec, 15_000);
      activeHandles.push(handle);

      const ses1 = 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const ses2 = 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

      const res1 = await handle.sendFollowup({
        prompt: 'Hello from session 1',
        sessionId: ses1,
        turnId: 'turn_11111111111111111111111111111111',
      });
      expect(res1.status).toBe('completed');

      const res2 = await handle.sendFollowup({
        prompt: 'Hello from session 2',
        sessionId: ses2,
        turnId: 'turn_22222222222222222222222222222222',
      });
      expect(res2.status).toBe('completed');
    }, 20_000);

    it('cancels turn cleanly using cancelTurn', async () => {
      const spec = adapter.createDefaultUserSpec({
        userId: 'alice',
        dataRoot: tmpDataRoot,
      });

      const handle = await adapter.startRuntime(spec, 15_000);
      activeHandles.push(handle);

      const sessionId = 'ses_cccccccccccccccccccccccccccccccc';
      const turnId = 'turn_33333333333333333333333333333333';

      // Submit turn with simulated delay
      const turnPromise = handle.sendFollowup({
        prompt: 'Turn with delay [enkeep-test-delay-ms=3000]',
        sessionId,
        turnId,
      });

      await new Promise((r) => setTimeout(r, 200));

      const cancelRes = await handle.cancelTurn(turnId);
      expect(cancelRes.status).toBe('cancelled');

      const finalRes = await turnPromise;
      expect(finalRes.status).toBe('cancelled');
    }, 20_000);

    it('sweeps idle agent and seamlessly resumes on next turn', async () => {
      const spec = adapter.createDefaultUserSpec({
        userId: 'alice',
        dataRoot: tmpDataRoot,
        idleAgentTimeoutMs: 500, // 500ms timeout
      });

      const handle = await adapter.startRuntime(spec, 15_000);
      activeHandles.push(handle);

      const sessionId = 'ses_dddddddddddddddddddddddddddddddd';

      const res1 = await handle.sendFollowup({
        prompt: 'Initial turn before idle',
        sessionId,
        turnId: 'turn_44444444444444444444444444444444',
      });
      expect(res1.status).toBe('completed');

      // Wait for idle sweep (longer than 500ms)
      await new Promise((r) => setTimeout(r, 1200));

      // Subsequent turn resumes smoothly from JSONL
      const res2 = await handle.sendFollowup({
        prompt: 'Turn after idle sweep',
        sessionId,
        turnId: 'turn_55555555555555555555555555555555',
      });
      expect(res2.status).toBe('completed');
    }, 20_000);
  });

  describe('6. Workspace Persistence across Stop & Restart', () => {
    it('preserves DSH_HOME and spaces data when stopped, and resumes correctly after restart', async () => {
      const spec = adapter.createDefaultUserSpec({
        userId: 'alice',
        dataRoot: tmpDataRoot,
      });

      const handle1 = await adapter.startRuntime(spec, 15_000);
      const sessionId = 'ses_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

      // 1. Send turn in session
      await handle1.sendFollowup({
        prompt: 'Turn before shutdown',
        sessionId,
        turnId: 'turn_66666666666666666666666666666666',
        workspaceFolder: 'space-persist',
      });

      // 2. Write a space file via fileOperation
      await handle1.fileOperation({
        op: 'write',
        space: 'space-persist',
        path: 'persist.txt',
        content: 'Persisted Content v1',
        requireAbsent: true,
      });

      // 3. Stop runtime handle (kills process tree without deleting workspace)
      await handle1.stop();

      // Verify files still exist on host disk
      const filePath = path.join(spec.spacesDir, 'space-persist', 'persist.txt');
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, 'utf8')).toBe('Persisted Content v1');

      // 4. Start runtime again using the SAME spec and DSH_HOME
      const handle2 = await adapter.startRuntime(spec, 15_000);
      activeHandles.push(handle2);

      // Verify file read from space
      const readRes = await handle2.fileOperation({
        op: 'read',
        space: 'space-persist',
        path: 'persist.txt',
      });
      expect(readRes.status).toBe('ok');
      expect(readRes.fileResult?.content).toBe('Persisted Content v1');

      // 5. Resume session from JSONL on the new daemon instance
      const resumeRes = await handle2.sendFollowup({
        prompt: 'Turn after restart',
        sessionId,
        turnId: 'turn_77777777777777777777777777777777',
        workspaceFolder: 'space-persist',
      });
      expect(resumeRes.status).toBe('completed');
    }, 25_000);
  });

  describe('7. File Operations, Instructions RPC & Streaming', () => {
    it('executes file operations and instructions RPC on host spaces', async () => {
      const spec = adapter.createDefaultUserSpec({
        userId: 'alice',
        dataRoot: tmpDataRoot,
      });

      const handle = await adapter.startRuntime(spec, 15_000);
      activeHandles.push(handle);

      // Write space instructions
      const writeInst = await handle.instructionsWrite!({
        target: 'space',
        spaceFolder: 'space-ops',
        filename: 'AGENTS.md',
        content: '# Space Instructions\nINSTRUCTION_TOKEN_TEST_ALPHA',
      });
      expect(writeInst.status).toBe('ok');

      // Read back space instructions
      const readInst = await handle.instructionsRead!({
        target: 'space',
        spaceFolder: 'space-ops',
        filename: 'AGENTS.md',
      });
      expect(readInst.status).toBe('ok');
      expect(readInst.instructionsResult?.content).toContain('INSTRUCTION_TOKEN_TEST_ALPHA');

      // Space file operations
      const writeRes = await handle.fileOperation({
        op: 'write',
        space: 'space-ops',
        path: 'hello.txt',
        content: 'Hello Host Runtime!',
        requireAbsent: true,
      });
      expect(writeRes.status).toBe('ok');

      const statRes = await handle.fileOperation({
        op: 'stat',
        space: 'space-ops',
        path: 'hello.txt',
      });
      expect(statRes.status).toBe('ok');
      expect(statRes.fileResult?.size).toBe(19);

      // Path traversal rejection
      const traversalRes = await handle.fileOperation({
        op: 'read',
        space: 'space-ops',
        path: '../../etc/passwd',
      });
      expect(traversalRes.status).toBe('error');
    }, 20_000);

    it('performs space-isolated streaming read and write', async () => {
      const spec = adapter.createDefaultUserSpec({
        userId: 'alice',
        dataRoot: tmpDataRoot,
      });

      const handle = await adapter.startRuntime(spec, 15_000);
      activeHandles.push(handle);

      const { Readable } = await import('node:stream');
      const inStream = Readable.from([Buffer.from('Stream Chunk 1 '), Buffer.from('Stream Chunk 2')]);

      const writeRes = await handle.fileWriteStream!(
        {
          space: 'space-stream',
          path: 'stream.txt',
        },
        inStream
      );
      expect(writeRes.status).toBe('ok');

      const { metadata, stream } = await handle.fileReadStream!({
        space: 'space-stream',
        path: 'stream.txt',
      });

      expect(metadata.size).toBe(29);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      expect(Buffer.concat(chunks).toString('utf8')).toBe('Stream Chunk 1 Stream Chunk 2');

      // Canonical FileInspectTransferState inspection
      const hash = crypto.createHash('sha256').update(Buffer.concat(chunks)).digest('hex');
      const inspectTransfer = await handle.fileInspectTransferState!({
        space: 'space-stream',
        path: 'stream.txt',
        expectedContentSha256: hash,
      });

      expect(inspectTransfer.op).toBe('inspect_transfer_state');
      expect(inspectTransfer.targetExists).toBe(true);
      expect(inspectTransfer.targetMatchesContent).toBe(true);
      expect(inspectTransfer.size).toBe(29);
    }, 20_000);
  });

  describe('8. Tenant Path Isolation & Process Tree Termination', () => {
    it('guarantees complete directory isolation between Alice and Bob', async () => {
      const aliceSpec = adapter.createDefaultUserSpec({
        userId: 'alice',
        dataRoot: tmpDataRoot,
      });
      const bobSpec = adapter.createDefaultUserSpec({
        userId: 'bob',
        dataRoot: tmpDataRoot,
      });

      const aliceHandle = await adapter.startRuntime(aliceSpec, 15_000);
      activeHandles.push(aliceHandle);

      const bobHandle = await adapter.startRuntime(bobSpec, 15_000);
      activeHandles.push(bobHandle);

      expect(aliceHandle.pid).not.toBe(bobHandle.pid);

      await aliceHandle.fileOperation({
        op: 'write',
        space: 'tenant-test',
        path: 'secret.txt',
        content: 'AliceSecret',
        requireAbsent: true,
      });

      await bobHandle.fileOperation({
        op: 'write',
        space: 'tenant-test',
        path: 'secret.txt',
        content: 'BobSecret',
        requireAbsent: true,
      });

      const aliceRead = await aliceHandle.fileOperation({
        op: 'read',
        space: 'tenant-test',
        path: 'secret.txt',
      });
      const bobRead = await bobHandle.fileOperation({
        op: 'read',
        space: 'tenant-test',
        path: 'secret.txt',
      });

      expect(aliceRead.fileResult?.content).toBe('AliceSecret');
      expect(bobRead.fileResult?.content).toBe('BobSecret');
    }, 25_000);

    it('terminates process tree gracefully on stop', async () => {
      const spec = adapter.createDefaultUserSpec({
        userId: 'alice',
        dataRoot: tmpDataRoot,
      });

      const handle = await adapter.startRuntime(spec, 15_000);
      const pid = handle.pid!;
      expect(pid).toBeGreaterThan(0);

      await handle.stop();

      // Check process is no longer alive
      let isAlive = true;
      try {
        process.kill(pid, 0);
      } catch {
        isAlive = false;
      }
      expect(isAlive).toBe(false);
    }, 20_000);
  });
});
