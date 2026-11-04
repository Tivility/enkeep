/**
 * A deployment's data directory (marked with enkeep-production.json) is never touched by demo
 * commands, and production runtimes use their own container/volume names.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  getDemoPathConfig,
  isProductionDataDir,
  assertNotProductionDataDir,
  writeProductionMarker,
  PRODUCTION_MARKER_FILE,
} from '../src/config.js';
import { resetDemo } from '../src/reset/index.js';
import { downDemo } from '../src/down/index.js';
import { launchDemoSystem } from '../src/up/index.js';
import { runDemoTestSuite } from '../src/test/index.js';
import {
  writeSignedContainerMeta,
  readSignedContainerMeta,
  writeSignedVolumeMeta,
  readSignedVolumeMeta,
  resetCachedSecrets,
} from '../src/utils/crypto-meta.js';
import { createTempRepo, type TempRepo } from './support/temp-repo.js';

describe('production data directory guard', () => {
  let tempRepo: TempRepo;
  let paths: ReturnType<typeof getDemoPathConfig>;

  beforeEach(() => {
    tempRepo = createTempRepo();
    paths = getDemoPathConfig(tempRepo.repoRoot);
    mkdirSync(paths.dataRoot, { recursive: true });
    writeFileSync(join(paths.dataRoot, 'platform.db'), 'not-a-real-db');
    writeProductionMarker(paths.dataRoot);
  });

  afterEach(() => {
    resetCachedSecrets(tempRepo.repoRoot);
    tempRepo.cleanup();
  });

  it('marks a directory atomically and recognises the marker', () => {
    const marker = join(paths.dataRoot, PRODUCTION_MARKER_FILE);
    expect(existsSync(marker)).toBe(true);
    expect(JSON.parse(readFileSync(marker, 'utf8')).kind).toBe('enkeep-production');
    expect(isProductionDataDir(paths.dataRoot)).toBe(true);
    expect(() => assertNotProductionDataDir(paths.dataRoot, 'demo:test')).toThrow(/production data directory/);
  });

  it('treats an unreadable marker as production (fail closed)', () => {
    writeFileSync(join(paths.dataRoot, PRODUCTION_MARKER_FILE), '{not json');
    expect(isProductionDataDir(paths.dataRoot)).toBe(true);
  });

  it('refuses demo:reset and leaves the data untouched', async () => {
    await expect(resetDemo({ repoRoot: tempRepo.repoRoot })).rejects.toThrow(/production data directory/);
    expect(readFileSync(join(paths.dataRoot, 'platform.db'), 'utf8')).toBe('not-a-real-db');
  });

  it('refuses demo:down without the production flag', async () => {
    await expect(downDemo({ repoRoot: tempRepo.repoRoot })).rejects.toThrow(/production data directory/);
  });

  it('refuses demo:up without the production flag', async () => {
    await expect(launchDemoSystem({ repoRoot: tempRepo.repoRoot })).rejects.toThrow(/enkeep-server serve/);
  });

  it('refuses demo:test', async () => {
    await expect(runDemoTestSuite({ repoRoot: tempRepo.repoRoot })).rejects.toThrow(/production data directory/);
  });
});

describe('production flag on a demo data directory', () => {
  let tempRepo: TempRepo;

  beforeEach(() => {
    tempRepo = createTempRepo();
  });

  afterEach(() => tempRepo.cleanup());

  it('refuses to run or stop a demo directory as production', async () => {
    const paths = getDemoPathConfig(tempRepo.repoRoot);
    mkdirSync(paths.dataRoot, { recursive: true });
    await expect(launchDemoSystem({ repoRoot: tempRepo.repoRoot, production: true })).rejects.toThrow(/not a production data directory/);
    await expect(downDemo({ repoRoot: tempRepo.repoRoot, production: true })).rejects.toThrow(/not a production data directory/);
  });
});

describe('production data directory outside the checkout', () => {
  let tempRepo: TempRepo;
  let external: string;

  beforeEach(() => {
    tempRepo = createTempRepo();
    external = mkdtempSync(join(tmpdir(), 'enkeep-prod-data-'));
  });

  afterEach(() => {
    resetCachedSecrets({ repoRoot: tempRepo.repoRoot, dataRoot: external, mode: 'production' });
    rmSync(external, { recursive: true, force: true });
    tempRepo.cleanup();
  });

  it('is accepted only once marked', () => {
    expect(() => getDemoPathConfig({ repoRoot: tempRepo.repoRoot, dataRoot: external, mode: 'production' })).toThrow(
      /marked production data directory/
    );
    writeProductionMarker(external);
    const paths = getDemoPathConfig({ repoRoot: tempRepo.repoRoot, dataRoot: external, mode: 'production' });
    expect(paths.dataRoot).toBe(external);
    expect(paths.dbPath).toBe(join(external, 'platform.db'));
  });

  it('signs production-named runtime metadata with production labels', () => {
    writeProductionMarker(external);
    const options = { repoRoot: tempRepo.repoRoot, dataRoot: external, mode: 'production' as const };
    const hex64 = randomBytes(32).toString('hex');
    const container = writeSignedContainerMeta(
      {
        userId: 'alice',
        containerName: 'enkeep-runtime-alice',
        containerId: hex64,
        image: 'enkeep-runtime:test',
        volumeName: 'enkeep-home-alice',
        volumeId: 'vol_0123456789abcdef0123456789abcdef',
        runId: 'run_test_001',
      },
      options
    );
    expect(container.labels.app).toBe('enkeep');
    expect(container.labels['enkeep.env']).toBe('production');
    expect(readSignedContainerMeta('enkeep-runtime-alice', options)?.containerId).toBe(hex64);

    const volume = writeSignedVolumeMeta(
      { userId: 'alice', volumeName: 'enkeep-home-alice', volumeId: 'vol_0123456789abcdef0123456789abcdef', runId: 'run_test_001' },
      options
    );
    expect(volume.labels.app).toBe('enkeep');
    expect(readSignedVolumeMeta('enkeep-home-alice', options)?.volumeName).toBe('enkeep-home-alice');
  });

  it('refuses a production container on a demo volume', () => {
    writeProductionMarker(external);
    const options = { repoRoot: tempRepo.repoRoot, dataRoot: external, mode: 'production' as const };
    expect(() =>
      writeSignedContainerMeta(
        {
          userId: 'alice',
          containerName: 'enkeep-runtime-alice',
          containerId: randomBytes(32).toString('hex'),
          volumeName: 'enkeep-demo-dsh-alice',
          volumeId: 'vol_0123456789abcdef0123456789abcdef',
          runId: 'run_test_001',
        },
        options
      )
    ).toThrow(/enkeep-home-/);
  });
});
