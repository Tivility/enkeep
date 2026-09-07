import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { getStatus } from '../src/demo-runner.js';
import {
  writeSignedProcessMeta,
  writeSignedContainerMeta,
  resetSessionMetaSecret,
} from '../src/utils/crypto-meta.js';
import { getDemoPathConfig } from '../src/config.js';
import { createTempRepo, type TempRepo } from './support/temp-repo.js';

describe('Negative Security Tests: Status Command Sanitization (`demo:status`)', () => {
  let tempRepo: TempRepo;
  let paths: ReturnType<typeof getDemoPathConfig>;

  beforeEach(() => {
    tempRepo = createTempRepo();
    paths = getDemoPathConfig(tempRepo.repoRoot);
    resetSessionMetaSecret(tempRepo.repoRoot);
    mkdirSync(paths.pidsDir, { recursive: true });
    mkdirSync(paths.containersDir, { recursive: true });
  });

  afterEach(() => {
    resetSessionMetaSecret(tempRepo.repoRoot);
    tempRepo.cleanup();
  });

  it('sanitizes status output and never leaks cryptographic signatures or command tokens', async () => {
    writeSignedProcessMeta(
      {
        service: 'platform-server',
        pid: 12345,
        port: 3100,
        url: 'http://127.0.0.1:3100',
        details: { internalSecretKey: 'super-secret-internal-key-12345' },
      },
      tempRepo.repoRoot
    );

    writeSignedContainerMeta(
      {
        userId: 'alice',
        containerName: 'enkeep-demo-alice',
        containerId: randomBytes(32).toString('hex'),
        image: 'enkeep-demo-runtime:latest',
        volumeName: 'enkeep-demo-dsh-alice',
        volumeId: 'vol_alice_001',
        runId: 'run_alice_001',
      },
      tempRepo.repoRoot
    );

    const status = await getStatus(tempRepo.repoRoot);
    expect(status.ok).toBe(true);
    expect(status.processes).toHaveLength(1);
    expect(status.containers).toHaveLength(1);

    const proc = status.processes[0] as any;
    expect(proc.service).toBe('platform-server');
    expect(proc.pid).toBe(12345);
    // MUST NOT contain sensitive signature or tokens or details
    expect(proc.signature).toBeUndefined();
    expect(proc.commandToken).toBeUndefined();
    expect(proc.details).toBeUndefined();

    const container = status.containers[0] as any;
    expect(container.containerName).toBe('enkeep-demo-alice');
    expect(container.signature).toBeUndefined();
    expect(container.commandToken).toBeUndefined();

    // Verify JSON serialization doesn't leak secrets
    const jsonStr = JSON.stringify(status);
    expect(jsonStr).not.toContain('super-secret-internal-key');
    expect(jsonStr).not.toContain('cmd_platform-server_');
    expect(jsonStr).not.toContain('cmd_enkeep-demo-alice_');
  });
});
