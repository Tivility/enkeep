/**
 * Demo Runner LLM Enablement Decision & Container Spec Injection Unit Tests
 *
 * Tests the 3 enablement paths in DockerRuntimeContainerAdapter / ports:
 * 1. Auto-enable: Local DSH deployment config and token are valid -> default automatically enables real model (ENKEEP_LLM_ENABLED=1).
 * 2. Explicit disable: ENKEEP_LLM_ENABLED='0' -> explicitly disabled with highest priority (demo mode, no ENKEEP_LLM_ENABLED=1).
 * 3. Missing config / token: DSH deployment config missing or empty token -> falls back cleanly to demo mode.
 *
 * @module @enkeep/demo-runner/tests/llm-auto-enable.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DockerRuntimeContainerAdapter } from '../src/ports/index.js';
import { SafeDockerClient, type RuntimeContainerSpec } from '@enkeep/runtime-runner';
import { createTempRepo, type TempRepo } from './support/temp-repo.js';

describe('Demo Runner LLM Auto-Enablement & Priority Decision Paths', () => {
  const originalEnv = process.env;
  let tempRepo: TempRepo;
  let tempDshHome: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    tempRepo = createTempRepo();
    const nonce = Math.random().toString(36).substring(2, 10);
    tempDshHome = path.join(os.tmpdir(), `test-dsh-auto-enable-${nonce}`);
    fs.mkdirSync(path.join(tempDshHome, 'profiles', 'web'), { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    process.env = originalEnv;
    tempRepo.cleanup();
    try {
      fs.rmSync(tempDshHome, { recursive: true, force: true });
    } catch {}
  });

  function setupMockDshConfig(opts: { validToken?: boolean; validConfig?: boolean }) {
    if (opts.validConfig !== false) {
      const patchYml = `
- id: llm-pi-ai
  config:
    providers:
      cpa-claude:
        displayName: Claude
        apiKeyEnv: CPA_TOKEN
        api: anthropic-messages
        baseURL: https://gw.example.com
        defaultContextWindow: 1000000
        defaultMaxTokens: 128000
        models:
          - id: claude-fable-5
`;
      const settingsYml = `
agent-default-model:
  provider: cpa-claude
  model: claude-fable-5
`;
      fs.writeFileSync(path.join(tempDshHome, 'profiles', 'web', 'cordis.patch.yml'), patchYml, 'utf8');
      fs.writeFileSync(path.join(tempDshHome, 'settings.yaml'), settingsYml, 'utf8');
    }

    if (opts.validToken) {
      fs.writeFileSync(path.join(tempDshHome, '.env'), 'CPA_TOKEN=test-cpa-token-valid\n', 'utf8');
    } else {
      fs.writeFileSync(path.join(tempDshHome, '.env'), 'CPA_TOKEN=\n', 'utf8');
    }

    process.env.DSH_HOME = tempDshHome;
  }

  it('Path 1 (Auto-enable): automatically enables real model when DSH config and token are valid', async () => {
    setupMockDshConfig({ validConfig: true, validToken: true });
    delete process.env.ENKEEP_LLM_ENABLED;

    let capturedSpec: RuntimeContainerSpec | undefined;
    const mockClient = new SafeDockerClient();
    const adapter = new DockerRuntimeContainerAdapter(mockClient);

    // Spy on internal adapter startRuntime to capture generated spec without invoking real docker
    vi.spyOn((adapter as any).adapter, 'startRuntime').mockImplementation(async (spec: RuntimeContainerSpec) => {
      capturedSpec = spec;
      return {
        containerId: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        runId: spec.runId,
        volumeId: spec.volume.volumeId,
        isCreated: true,
        spec,
        checkHealth: vi.fn(),
        sendFollowup: vi.fn(),
        importSeed: vi.fn(),
        cancelTurn: vi.fn(),
        fileOperation: vi.fn(),
        stop: vi.fn(),
        teardown: vi.fn(),
      };
    });

    await adapter.startUserRuntime({
      userId: 'alice',
      repoRoot: tempRepo.repoRoot,
    });

    expect(capturedSpec).toBeDefined();
    expect(capturedSpec?.environment.ENKEEP_LLM_ENABLED).toBe('1');
    expect(capturedSpec?.environment.ENKEEP_LLM_PROVIDER).toBe('cpa-claude');
    expect(capturedSpec?.environment.ENKEEP_LLM_MODEL).toBe('claude-fable-5');
    expect(capturedSpec?.environment.IN_CONTAINER_PLACEHOLDER).toBe('in-container-placeholder');
    // Security assertion: Real token MUST NEVER be in container spec environment
    expect(capturedSpec?.environment.CPA_TOKEN).toBeUndefined();
    expect(capturedSpec?.environment.DEEPSEEK_API_KEY).toBeUndefined();
  });

  it('Path 2 (Explicit disable): ENKEEP_LLM_ENABLED="0" takes highest priority and keeps demo mode even if valid DSH config exists', async () => {
    setupMockDshConfig({ validConfig: true, validToken: true });
    process.env.ENKEEP_LLM_ENABLED = '0'; // Explicit disable

    let capturedSpec: RuntimeContainerSpec | undefined;
    const mockClient = new SafeDockerClient();
    const adapter = new DockerRuntimeContainerAdapter(mockClient);

    vi.spyOn((adapter as any).adapter, 'startRuntime').mockImplementation(async (spec: RuntimeContainerSpec) => {
      capturedSpec = spec;
      return {
        containerId: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        runId: spec.runId,
        volumeId: spec.volume.volumeId,
        isCreated: true,
        spec,
        checkHealth: vi.fn(),
        sendFollowup: vi.fn(),
        importSeed: vi.fn(),
        cancelTurn: vi.fn(),
        fileOperation: vi.fn(),
        stop: vi.fn(),
        teardown: vi.fn(),
      };
    });

    await adapter.startUserRuntime({
      userId: 'alice',
      repoRoot: tempRepo.repoRoot,
    });

    expect(capturedSpec).toBeDefined();
    // In demo mode: ENKEEP_LLM_ENABLED is not set to '1'
    expect(capturedSpec?.environment.ENKEEP_LLM_ENABLED).toBeUndefined();
    expect(capturedSpec?.environment.ENKEEP_LLM_PROVIDERS).toBeUndefined();
  });

  it('Path 3 (Missing config / token): falls back cleanly to demo mode when DSH config or token is missing', async () => {
    setupMockDshConfig({ validConfig: true, validToken: false }); // Missing token
    delete process.env.ENKEEP_LLM_ENABLED;

    let capturedSpec: RuntimeContainerSpec | undefined;
    const mockClient = new SafeDockerClient();
    const adapter = new DockerRuntimeContainerAdapter(mockClient);

    vi.spyOn((adapter as any).adapter, 'startRuntime').mockImplementation(async (spec: RuntimeContainerSpec) => {
      capturedSpec = spec;
      return {
        containerId: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        runId: spec.runId,
        volumeId: spec.volume.volumeId,
        isCreated: true,
        spec,
        checkHealth: vi.fn(),
        sendFollowup: vi.fn(),
        importSeed: vi.fn(),
        cancelTurn: vi.fn(),
        fileOperation: vi.fn(),
        stop: vi.fn(),
        teardown: vi.fn(),
      };
    });

    await adapter.startUserRuntime({
      userId: 'alice',
      repoRoot: tempRepo.repoRoot,
    });

    expect(capturedSpec).toBeDefined();
    expect(capturedSpec?.environment.ENKEEP_LLM_ENABLED).toBeUndefined();
    expect(capturedSpec?.environment.ENKEEP_LLM_PROVIDERS).toBeUndefined();
  });

  it('Path 4 (Database model_config_overrides): applies platform default override from platform.db to container spec', async () => {
    setupMockDshConfig({ validConfig: true, validToken: true });
    delete process.env.ENKEEP_LLM_ENABLED;
    delete process.env.ENKEEP_LLM_PROVIDER;
    delete process.env.ENKEEP_LLM_MODEL;

    // Create platform.db with model_config_overrides table and override
    const { DatabaseSync } = await import('node:sqlite');
    const { join } = await import('node:path');
    const { mkdirSync } = await import('node:fs');

    const demoDataDir = join(tempRepo.repoRoot, '.demo-data');
    mkdirSync(demoDataDir, { recursive: true });
    const dbPath = join(demoDataDir, 'platform.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE model_config_overrides (
        id TEXT PRIMARY KEY,
        provider TEXT,
        model TEXT,
        reasoning_effort TEXT,
        updated_by TEXT,
        updated_at TEXT
      );
      INSERT INTO model_config_overrides (id, provider, model, reasoning_effort)
      VALUES ('default', 'cpa-gemini', 'gemini-2.0-flash', 'high');
    `);
    db.close();

    let capturedSpec: RuntimeContainerSpec | undefined;
    const mockClient = new SafeDockerClient();
    const adapter = new DockerRuntimeContainerAdapter(mockClient);

    vi.spyOn((adapter as any).adapter, 'startRuntime').mockImplementation(async (spec: RuntimeContainerSpec) => {
      capturedSpec = spec;
      return {
        containerId: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        runId: spec.runId,
        volumeId: spec.volume.volumeId,
        isCreated: true,
        spec,
        checkHealth: vi.fn(),
        sendFollowup: vi.fn(),
        importSeed: vi.fn(),
        cancelTurn: vi.fn(),
        fileOperation: vi.fn(),
        stop: vi.fn(),
        teardown: vi.fn(),
      };
    });

    await adapter.startUserRuntime({
      userId: 'alice',
      repoRoot: tempRepo.repoRoot,
    });

    expect(capturedSpec).toBeDefined();
    expect(capturedSpec?.environment.ENKEEP_LLM_ENABLED).toBe('1');
    expect(capturedSpec?.environment.ENKEEP_LLM_PROVIDER).toBe('cpa-gemini');
    expect(capturedSpec?.environment.ENKEEP_LLM_MODEL).toBe('gemini-2.0-flash');
  });

  it('Path 5 (Database without override row): falls back to DSH default when model_config_overrides table is empty', async () => {
    setupMockDshConfig({ validConfig: true, validToken: true });
    delete process.env.ENKEEP_LLM_ENABLED;
    delete process.env.ENKEEP_LLM_PROVIDER;
    delete process.env.ENKEEP_LLM_MODEL;

    // Create platform.db WITH model_config_overrides table but NO rows
    const { DatabaseSync } = await import('node:sqlite');
    const { join } = await import('node:path');
    const { mkdirSync } = await import('node:fs');

    const demoDataDir = join(tempRepo.repoRoot, '.demo-data');
    mkdirSync(demoDataDir, { recursive: true });
    const dbPath = join(demoDataDir, 'platform.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE model_config_overrides (
        id TEXT PRIMARY KEY,
        provider TEXT,
        model TEXT,
        reasoning_effort TEXT,
        updated_by TEXT,
        updated_at TEXT
      );
    `);
    db.close();

    let capturedSpec: RuntimeContainerSpec | undefined;
    const mockClient = new SafeDockerClient();
    const adapter = new DockerRuntimeContainerAdapter(mockClient);

    vi.spyOn((adapter as any).adapter, 'startRuntime').mockImplementation(async (spec: RuntimeContainerSpec) => {
      capturedSpec = spec;
      return {
        containerId: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        runId: spec.runId,
        volumeId: spec.volume.volumeId,
        isCreated: true,
        spec,
        checkHealth: vi.fn(),
        sendFollowup: vi.fn(),
        importSeed: vi.fn(),
        cancelTurn: vi.fn(),
        fileOperation: vi.fn(),
        stop: vi.fn(),
        teardown: vi.fn(),
      };
    });

    await adapter.startUserRuntime({
      userId: 'alice',
      repoRoot: tempRepo.repoRoot,
    });

    expect(capturedSpec).toBeDefined();
    expect(capturedSpec?.environment.ENKEEP_LLM_ENABLED).toBe('1');
    expect(capturedSpec?.environment.ENKEEP_LLM_PROVIDER).toBe('cpa-claude'); // DSH deployment default
  });

  it('Path 6 (Database error fail-closed): throws explicit fail-closed error without leaking path', async () => {
    setupMockDshConfig({ validConfig: true, validToken: true });

    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');

    const demoDataDir = join(tempRepo.repoRoot, '.demo-data');
    mkdirSync(demoDataDir, { recursive: true });
    const dbPath = join(demoDataDir, 'platform.db');
    writeFileSync(dbPath, 'corrupted binary database payload header', 'utf8');

    const mockClient = new SafeDockerClient();
    const adapter = new DockerRuntimeContainerAdapter(mockClient);

    await expect(
      adapter.startUserRuntime({
        userId: 'alice',
        repoRoot: tempRepo.repoRoot,
      })
    ).rejects.toThrow('FAIL-CLOSED: Failed to query model_config_overrides from platform database');
  });
});
