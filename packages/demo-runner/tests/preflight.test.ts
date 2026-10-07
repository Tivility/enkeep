import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { runPreflight, inspectPlatformDb, queryDaemonActivityOverSocket } from '../src/preflight/index.js';
import { runDemoRunnerCli, parseDataDir, parseDueWithinMinutes } from '../src/demo-runner.js';
import type { DaemonActivityStatus } from '@enkeep/runtime-runner';

describe('Deploy Preflight Quiescence Aggregator (`demo-runner preflight`)', () => {
  let tmpDir: string;
  let dataDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-preflight-test-'));
    dataDir = path.join(tmpDir, '.demo-data');
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('reports quiescent/idle when platform and runtimes have no active work', async () => {
    const result = await runPreflight({ dataDir });
    expect(result.ok).toBe(true);
    expect(result.isIdle).toBe(true);
    expect(result.platform.isIdle).toBe(true);
    expect(result.runtimes).toHaveLength(0);
    expect(result.issues).toHaveLength(0);
    expect(result.summary).toContain('Overall Preflight Status: QUIESCENT / IDLE ✔');
  });

  it('detects platform activity: active turn_runs and claimed task_runs mark preflight not idle', async () => {
    const dbPath = path.join(dataDir, 'platform.db');
    const db = new DatabaseSync(dbPath);

    db.exec(`
      CREATE TABLE turn_runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL
      );
      CREATE TABLE task_runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL
      );
      INSERT INTO turn_runs (id, status) VALUES ('turn_1', 'running');
      INSERT INTO task_runs (id, status) VALUES ('task_1', 'claimed');
    `);
    db.close();

    const result = await runPreflight({ dataDir });
    expect(result.isIdle).toBe(false);
    expect(result.platform.isIdle).toBe(false);
    expect(result.platform.runningQueuedTurns).toBe(1);
    expect(result.platform.claimedTaskRuns).toBe(1);
    expect(result.issues.some((i) => i.includes('running or queued turn'))).toBe(true);
    expect(result.issues.some((i) => i.includes('claimed or running task'))).toBe(true);
  });

  it('detects non-terminal journals in platform database', async () => {
    const dbPath = path.join(dataDir, 'platform.db');
    const db = new DatabaseSync(dbPath);

    db.exec(`
      CREATE TABLE file_transfer_journal (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL
      );
      INSERT INTO file_transfer_journal (id, status) VALUES ('ft_1', 'staged');
    `);
    db.close();

    const result = await runPreflight({ dataDir });
    expect(result.isIdle).toBe(false);
    expect(result.platform.nonTerminalJournals).toBe(1);
    expect(result.issues.some((i) => i.includes('non-terminal journal'))).toBe(true);
  });

  it('detects scheduled tasks due within lookahead window', async () => {
    const dbPath = path.join(dataDir, 'platform.db');
    const db = new DatabaseSync(dbPath);

    const dueInTwoMinutes = new Date(Date.now() + 2 * 60 * 1000).toISOString();

    db.exec(`
      CREATE TABLE platform_tasks (
        id TEXT PRIMARY KEY,
        status TEXT,
        next_run_at TEXT,
        due_date TEXT
      );
      INSERT INTO platform_tasks (id, status, next_run_at) VALUES ('task_sched_1', 'pending', '${dueInTwoMinutes}');
    `);
    db.close();

    const result = await runPreflight({ dataDir, dueWithinMinutes: 10 });
    expect(result.isIdle).toBe(false);
    expect(result.platform.tasksDueWithinNMinutes).toBe(1);
    expect(result.issues.some((i) => i.includes('due within 10 minute(s)'))).toBe(true);
  });

  it('detects busy host runtime with active autonomous turn or running jobs and exits non-zero', async () => {
    // 1. Create simulated host runtime directory
    const hostUserDir = path.join(dataDir, 'host-runtimes', 'alice');
    const runDir = path.join(hostUserDir, 'run');
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });

    // Use a short path in /tmp because macOS has a 104-char limit for UDS socket paths
    const socketPath = path.join('/tmp', `ek-pf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.sock`);

    // 2. Mock UDS server simulating a resident Host RuntimeDaemon with active autonomous turn & workflow job
    const busyStatus: DaemonActivityStatus = {
      isIdle: false,
      activeTurnsCount: 1,
      autonomousTurnsCount: 1,
      runningJobsCount: 1,
      runningWorkflowJobsCount: 1,
      liveSubagentsCount: 0,
      pendingInboxItemsCount: 0,
      queuedTurnsCount: 0,
      activeTurns: [
        {
          sessionId: 'ses_alice_001',
          turnNumber: 3,
          autonomous: true,
          startedAt: Date.now() - 10000,
        },
      ],
      runningJobs: [
        {
          id: 'job-wf-001',
          kind: 'workflow',
          label: 'Data Migration Workflow Job',
          startedAt: Date.now() - 5000,
        },
      ],
      liveSubagents: [],
      sessions: {
        ses_alice_001: {
          sessionId: 'ses_alice_001',
          activeTurn: {
            sessionId: 'ses_alice_001',
            turnNumber: 3,
            autonomous: true,
          },
          pendingInboxItemsCount: 0,
          pendingNextTurnCount: 0,
          pendingNextStepCount: 0,
          queuedTurnsCount: 0,
        },
      },
    };

    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      let buffer = '';
      socket.on('data', (d) => {
        buffer += d.toString('utf8');
        if (buffer.includes('\n')) {
          const req = JSON.parse(buffer.trim());
          const res = {
            id: req.id,
            op: req.op,
            ok: true,
            activity: busyStatus,
          };
          socket.write(JSON.stringify(res) + '\n');
          socket.end();
        }
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(socketPath, resolve);
    });

    // Write process.meta.json pointing to this live process and socketPath
    fs.writeFileSync(
      path.join(runDir, 'process.meta.json'),
      JSON.stringify({
        pid: process.pid, // current test process is alive
        paths: {
          socketPath,
        },
      }),
      'utf8'
    );

    try {
      const result = await runPreflight({ dataDir });
      expect(result.isIdle).toBe(false);
      expect(result.runtimes).toHaveLength(1);
      expect(result.runtimes[0].isIdle).toBe(false);
      expect(result.runtimes[0].activity?.autonomousTurnsCount).toBe(1);
      expect(result.runtimes[0].activity?.runningWorkflowJobsCount).toBe(1);
      expect(result.issues.some((i) => i.includes('autonomous'))).toBe(true);
      expect(result.issues.some((i) => i.includes('workflow'))).toBe(true);
      expect(result.summary).toContain('BUSY / NOT IDLE ✖');

      // Test CLI subcommand execution exits non-zero (process.exit(1)) when not idle
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`Process.exit called with code ${code}`);
      });

      await expect(
        runDemoRunnerCli(['preflight', '--data-dir', dataDir])
      ).rejects.toThrow('Process.exit called with code 1');

      exitSpy.mockRestore();
    } finally {
      for (const s of sockets) s.destroy();
      server.close();
      try {
        fs.unlinkSync(socketPath);
      } catch {}
    }
  });

  it('CLI arguments parser parses flags and environment variables properly', () => {
    expect(parseDataDir(['--data-dir', '/tmp/custom-data'])).toBe('/tmp/custom-data');
    expect(parseDataDir(['--data-dir=/tmp/custom-data-eq'])).toBe('/tmp/custom-data-eq');
    expect(parseDataDir([], { ENKEEP_DATA_DIR: '/tmp/env-data' })).toBe('/tmp/env-data');

    expect(parseDueWithinMinutes(['--due-within-minutes', '15'])).toBe(15);
    expect(parseDueWithinMinutes(['--due-within=25'])).toBe(25);
    expect(parseDueWithinMinutes([], { ENKEEP_PREFLIGHT_DUE_MINUTES: '30' })).toBe(30);
    expect(parseDueWithinMinutes([])).toBe(10);
  });
});
