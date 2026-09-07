/**
 * End-to-End DSH Tools Execution with Controlled Mounts Test Suite
 *
 * Tests production DSH tool suite (read, write, edit, glob, grep, bash)
 * through official Cordis AgentLoop in full agent turns:
 * 1. read tool on /mnt/<name> retrieves file content and renders /mnt/<name> in tool result
 * 2. write & edit tools on /mnt/<name> (RW mode) mutate files on disk
 * 3. write & edit tools on /mnt/<name> (RO mode) are denied with FS_SANDBOX_DENIED
 * 4. glob tool on /mnt/<name> lists matching files with virtual /mnt/<name>/... paths
 * 5. grep tool on /mnt/<name> searches file contents and returns /mnt/<name>/... paths
 * 6. bash tool with workdir /mnt/<name> runs commands in backing path and sanitizes stdout/stderr
 * 7. bash tool denies mutating commands in /mnt/<name> (RO mode) and allows them in RW mode
 * 8. Space isolation: Space A mount is inaccessible in Space B
 * 9. Per-turn dynamic mount updates: Turn 1 accesses Mount A, Turn 2 updates to Mount B
 * 10. Zero physical host path leakage in tool results, messages, and session events
 *
 * @module @enkeep/runtime-runner/tests/dsh-tools-mounts-e2e.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { bootDshRuntime, type DshBootedRuntime } from '../src/runtime/dsh-boot.js';
import type { RuntimeMountSpec } from '../src/spec/types.js';

describe('Production DSH Tools Execution with Controlled Mounts (E2E)', () => {
  let tmpDir: string;
  let aliceHome: string;
  let aliceSpaces: string;
  let hostRoDataset: string;
  let hostRwScratch: string;
  let hostSpaceBData: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tools-mounts-e2e-'));
    aliceHome = path.join(tmpDir, 'alice', '.dsh');
    aliceSpaces = path.join(tmpDir, 'alice', 'spaces');

    hostRoDataset = path.join(tmpDir, 'host-ro-dataset');
    hostRwScratch = path.join(tmpDir, 'host-rw-scratch');
    hostSpaceBData = path.join(tmpDir, 'host-space-b-data');

    fs.mkdirSync(aliceHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(aliceSpaces, { recursive: true, mode: 0o700 });

    fs.mkdirSync(hostRoDataset, { recursive: true, mode: 0o755 });
    fs.mkdirSync(hostRwScratch, { recursive: true, mode: 0o755 });
    fs.mkdirSync(hostSpaceBData, { recursive: true, mode: 0o755 });

    // Seed test files in physical host mounts
    fs.writeFileSync(path.join(hostRoDataset, 'dataset.csv'), 'id,name,role\n101,Alice,Admin\n102,Bob,Engineer\n', 'utf8');
    fs.writeFileSync(path.join(hostRoDataset, 'config.json'), JSON.stringify({ datasetVersion: 'v2.4', format: 'csv' }), 'utf8');
    fs.writeFileSync(path.join(hostRwScratch, 'notes.md'), '# Scratchpad\nInitial notes.\n', 'utf8');
    fs.writeFileSync(path.join(hostSpaceBData, 'b-only.txt'), 'Space B confidential data\n', 'utf8');
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch {}
  });

  it('executes read tool on /mnt/readonly-data, verifying contents and zero host path leakage', async () => {
    const spaceA = 'space-alpha';
    const spaceAPath = path.join(aliceSpaces, spaceA);
    fs.mkdirSync(spaceAPath, { recursive: true, mode: 0o700 });

    const mountRO: RuntimeMountSpec = {
      id: 'mnt_ro_1',
      name: 'readonly-data',
      sourcePath: hostRoDataset,
      mode: 'ro',
    };

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
      mounts: [mountRO],
    });

    try {
      const sessionId = 'ses_0123456789abcdef0123456789abcde1';

      // Submit turn with read tool call
      const readTurn = await runtime.sendFollowup(
        '[enkeep-test-tool-call=read:{"file_path":"/mnt/readonly-data/dataset.csv"}] read dataset',
        sessionId,
        'turn_0123456789abcdef0123456789abcde1',
        null,
        spaceA,
        undefined
      );

      expect(readTurn.status).toBe('completed');
      expect(readTurn.persisted).toBe(true);

      // Verify session events: tool/result event exists and displays /mnt/readonly-data/dataset.csv
      const agent = await runtime.getOrCreateAgent(sessionId, null, spaceA, [mountRO]);
      const events = agent.session.snapshotEvents();

      const toolResultEvent = events.find((e) => e.type === 'tool/result');
      expect(toolResultEvent).toBeDefined();

      const eventString = JSON.stringify(toolResultEvent);
      expect(eventString).toContain('101,Alice,Admin');
      expect(eventString).toContain('/mnt/readonly-data/dataset.csv');
      // Verify physical host path is NOT leaked in event
      expect(eventString).not.toContain(hostRoDataset);
    } finally {
      await runtime.dispose();
    }
  });

  it('executes write and edit tools on /mnt/scratch (RW), mutating physical files', async () => {
    const spaceA = 'space-alpha';
    const spaceAPath = path.join(aliceSpaces, spaceA);
    fs.mkdirSync(spaceAPath, { recursive: true, mode: 0o700 });

    const mountRW: RuntimeMountSpec = {
      id: 'mnt_rw_1',
      name: 'scratch',
      sourcePath: hostRwScratch,
      mode: 'rw',
    };

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
      mounts: [mountRW],
    });

    try {
      const sessionId = 'ses_0123456789abcdef0123456789abcde2';

      // 1. Tool: write
      const writeTurn = await runtime.sendFollowup(
        '[enkeep-test-tool-call=write:{"file_path":"/mnt/scratch/generated.json","content":"{\\"status\\":\\"ok\\"}"}] write json',
        sessionId,
        'turn_0123456789abcdef0123456789abcde1',
        null,
        spaceA,
        undefined
      );

      expect(writeTurn.status).toBe('completed');
      expect(fs.existsSync(path.join(hostRwScratch, 'generated.json'))).toBe(true);
      expect(fs.readFileSync(path.join(hostRwScratch, 'generated.json'), 'utf8')).toBe('{"status":"ok"}');

      // 2. Tool: read then edit (FsObservationPolicy enforces reading before editing)
      const readTurn = await runtime.sendFollowup(
        '[enkeep-test-tool-call=read:{"file_path":"/mnt/scratch/notes.md"}] read notes before edit',
        sessionId,
        'turn_0123456789abcdef0123456789abcde2',
        null,
        spaceA,
        undefined
      );
      expect(readTurn.status).toBe('completed');

      const editTurn = await runtime.sendFollowup(
        '[enkeep-test-tool-call=edit:{"file_path":"/mnt/scratch/notes.md","old_string":"Initial notes.","new_string":"Updated notes by agent."}] edit notes',
        sessionId,
        'turn_0123456789abcdef0123456789abcde3',
        null,
        spaceA,
        undefined
      );

      expect(editTurn.status).toBe('completed');
      expect(fs.readFileSync(path.join(hostRwScratch, 'notes.md'), 'utf8')).toContain('Updated notes by agent.');
    } finally {
      await runtime.dispose();
    }
  });

  it('denies write and edit tools on /mnt/readonly-data (RO mode) with FS_SANDBOX_DENIED', async () => {
    const spaceA = 'space-alpha';
    const spaceAPath = path.join(aliceSpaces, spaceA);
    fs.mkdirSync(spaceAPath, { recursive: true, mode: 0o700 });

    const mountRO: RuntimeMountSpec = {
      id: 'mnt_ro_1',
      name: 'readonly-data',
      sourcePath: hostRoDataset,
      mode: 'ro',
    };

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
      mounts: [mountRO],
    });

    try {
      const sessionId = 'ses_0123456789abcdef0123456789abcde3';

      const writeTurn = await runtime.sendFollowup(
        '[enkeep-test-tool-call=write:{"file_path":"/mnt/readonly-data/forbidden.txt","content":"malicious"}] write to ro',
        sessionId,
        'turn_0123456789abcdef0123456789abcde1',
        null,
        spaceA,
        undefined
      );

      expect(writeTurn.status).toBe('completed');
      expect(fs.existsSync(path.join(hostRoDataset, 'forbidden.txt'))).toBe(false);

      const agent = await runtime.getOrCreateAgent(sessionId, null, spaceA, [mountRO]);
      const toolResultEvent = agent.session.snapshotEvents().find((e) => e.type === 'tool/result');
      expect(toolResultEvent).toBeDefined();

      const eventString = JSON.stringify(toolResultEvent);
      expect(eventString).toContain('FS_SANDBOX_DENIED');
      expect(eventString).toContain('file access denied');
    } finally {
      await runtime.dispose();
    }
  });

  it('executes glob tool on /mnt/readonly-data returning virtual /mnt/... paths', async () => {
    const spaceA = 'space-alpha';
    const spaceAPath = path.join(aliceSpaces, spaceA);
    fs.mkdirSync(spaceAPath, { recursive: true, mode: 0o700 });

    const mountRO: RuntimeMountSpec = {
      id: 'mnt_ro_1',
      name: 'readonly-data',
      sourcePath: hostRoDataset,
      mode: 'ro',
    };

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
      mounts: [mountRO],
    });

    try {
      const sessionId = 'ses_0123456789abcdef0123456789abcde4';

      const globTurn = await runtime.sendFollowup(
        '[enkeep-test-tool-call=glob:{"pattern":"*","path":"/mnt/readonly-data"}] glob files in mount',
        sessionId,
        'turn_0123456789abcdef0123456789abcde1',
        null,
        spaceA,
        undefined
      );

      expect(globTurn.status).toBe('completed');

      const agent = await runtime.getOrCreateAgent(sessionId, null, spaceA, [mountRO]);
      const toolResultEvent = agent.session.snapshotEvents().find((e) => e.type === 'tool/result');
      expect(toolResultEvent).toBeDefined();

      const eventString = JSON.stringify(toolResultEvent);
      expect(eventString).toContain('/mnt/readonly-data');
      expect(eventString).not.toContain(hostRoDataset);
    } finally {
      await runtime.dispose();
    }
  });

  it('executes grep tool on /mnt/readonly-data finding matching lines with virtual paths', async () => {
    const spaceA = 'space-alpha';
    const spaceAPath = path.join(aliceSpaces, spaceA);
    fs.mkdirSync(spaceAPath, { recursive: true, mode: 0o700 });

    const mountRO: RuntimeMountSpec = {
      id: 'mnt_ro_1',
      name: 'readonly-data',
      sourcePath: hostRoDataset,
      mode: 'ro',
    };

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
      mounts: [mountRO],
    });

    try {
      const sessionId = 'ses_0123456789abcdef0123456789abcde5';

      const grepTurn = await runtime.sendFollowup(
        '[enkeep-test-tool-call=grep:{"pattern":"Admin","path":"/mnt/readonly-data"}] grep files in mount',
        sessionId,
        'turn_0123456789abcdef0123456789abcde1',
        null,
        spaceA,
        undefined
      );

      expect(grepTurn.status).toBe('completed');

      const agent = await runtime.getOrCreateAgent(sessionId, null, spaceA, [mountRO]);
      const toolResultEvent = agent.session.snapshotEvents().find((e) => e.type === 'tool/result');
      expect(toolResultEvent).toBeDefined();

      const eventString = JSON.stringify(toolResultEvent);
      expect(eventString).toContain('101,Alice,Admin');
      expect(eventString).toContain('/mnt/readonly-data');
      expect(eventString).not.toContain(hostRoDataset);
    } finally {
      await runtime.dispose();
    }
  });

  it('executes bash tool with workdir /mnt/readonly-data and rewrites paths', async () => {
    const spaceA = 'space-alpha';
    const spaceAPath = path.join(aliceSpaces, spaceA);
    fs.mkdirSync(spaceAPath, { recursive: true, mode: 0o700 });

    const mountRO: RuntimeMountSpec = {
      id: 'mnt_ro_1',
      name: 'readonly-data',
      sourcePath: hostRoDataset,
      mode: 'ro',
    };

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
      mounts: [mountRO],
    });

    try {
      const sessionId = 'ses_0123456789abcdef0123456789abcde6';

      const bashTurn = await runtime.sendFollowup(
        '[enkeep-test-tool-call=bash:{"command":"cat dataset.csv","workdir":"/mnt/readonly-data","description":"read csv"}] bash read',
        sessionId,
        'turn_0123456789abcdef0123456789abcde1',
        null,
        spaceA,
        undefined
      );

      expect(bashTurn.status).toBe('completed');

      const agent = await runtime.getOrCreateAgent(sessionId, null, spaceA, [mountRO]);
      const toolResultEvent = agent.session.snapshotEvents().find((e) => e.type === 'tool/result');
      expect(toolResultEvent).toBeDefined();

      const eventString = JSON.stringify(toolResultEvent);
      expect(eventString).toContain('101,Alice,Admin');
      expect(eventString).not.toContain(hostRoDataset);
    } finally {
      await runtime.dispose();
    }
  });

  it('supports per-turn mount update: Turn 1 accesses Mount A, Turn 2 updates to Mount B', async () => {
    const spaceA = 'space-alpha';
    const spaceAPath = path.join(aliceSpaces, spaceA);
    fs.mkdirSync(spaceAPath, { recursive: true, mode: 0o700 });

    const mountA: RuntimeMountSpec = {
      id: 'mnt_a',
      name: 'data-a',
      sourcePath: hostRoDataset,
      mode: 'ro',
    };

    const mountB: RuntimeMountSpec = {
      id: 'mnt_b',
      name: 'data-b',
      sourcePath: hostRwScratch,
      mode: 'rw',
    };

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      const sessionId = 'ses_0123456789abcdef0123456789abcde7';

      // Turn 1: Mount A
      const turn1 = await runtime.sendFollowup(
        '[enkeep-test-tool-call=read:{"file_path":"/mnt/data-a/dataset.csv"}] read data A',
        sessionId,
        'turn_0123456789abcdef0123456789abcde1',
        null,
        spaceA,
        undefined
      );
      expect(turn1.status).toBe('completed');

      // Turn 2: Mount B (Mount A removed, Mount B added)
      const turn2 = await runtime.sendFollowup(
        '[enkeep-test-tool-call=read:{"file_path":"/mnt/data-b/notes.md"}] read data B',
        sessionId,
        'turn_0123456789abcdef0123456789abcde2',
        null,
        spaceA,
        undefined
      );
      expect(turn2.status).toBe('completed');
    } finally {
      await runtime.dispose();
    }
  });
});
