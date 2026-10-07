import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { resolvePlatformDshHome } from '../src/safety/dsh-home.js';

describe('resolvePlatformDshHome (@enkeep/platform-core)', () => {
  let origEnkeepDshHome: string | undefined;
  let origDshHome: string | undefined;
  let origNodeEnv: string | undefined;
  let origEnkeepMode: string | undefined;

  beforeEach(() => {
    origEnkeepDshHome = process.env.ENKEEP_DSH_HOME;
    origDshHome = process.env.DSH_HOME;
    origNodeEnv = process.env.NODE_ENV;
    origEnkeepMode = process.env.ENKEEP_MODE;
    delete process.env.ENKEEP_DSH_HOME;
    delete process.env.DSH_HOME;
    delete process.env.ENKEEP_MODE;
  });

  afterEach(() => {
    if (origEnkeepDshHome !== undefined) process.env.ENKEEP_DSH_HOME = origEnkeepDshHome;
    else delete process.env.ENKEEP_DSH_HOME;

    if (origDshHome !== undefined) process.env.DSH_HOME = origDshHome;
    else delete process.env.DSH_HOME;

    if (origNodeEnv !== undefined) process.env.NODE_ENV = origNodeEnv;
    else delete process.env.NODE_ENV;

    if (origEnkeepMode !== undefined) process.env.ENKEEP_MODE = origEnkeepMode;
    else delete process.env.ENKEEP_MODE;
  });

  it('uses explicit customDshHome override first', () => {
    process.env.ENKEEP_DSH_HOME = '/tmp/synthetic-enkeep-home';
    process.env.DSH_HOME = '/tmp/synthetic-dsh-home';
    const resolved = resolvePlatformDshHome('/tmp/synthetic-custom-override');
    expect(resolved).toBe(path.resolve('/tmp/synthetic-custom-override'));
  });

  it('prefers ENKEEP_DSH_HOME over DSH_HOME when both are set', () => {
    process.env.ENKEEP_DSH_HOME = '/tmp/synthetic-enkeep-preferred';
    process.env.DSH_HOME = '/tmp/synthetic-dsh-fallback';
    const resolved = resolvePlatformDshHome();
    expect(resolved).toBe(path.resolve('/tmp/synthetic-enkeep-preferred'));
  });

  it('falls back to DSH_HOME when ENKEEP_DSH_HOME is unset', () => {
    process.env.DSH_HOME = '/tmp/synthetic-dsh-only';
    const resolved = resolvePlatformDshHome();
    expect(resolved).toBe(path.resolve('/tmp/synthetic-dsh-only'));
  });

  it('returns null in non-production mode when neither is set (never defaults to ~/.dsh)', () => {
    process.env.NODE_ENV = 'test';
    const homedirSpy = vi.spyOn(os, 'homedir');
    const resolved = resolvePlatformDshHome();
    expect(resolved).toBeNull();
    expect(homedirSpy).not.toHaveBeenCalled();
    homedirSpy.mockRestore();
  });

  it('throws clear fail-closed error in production mode when neither is set', () => {
    expect(() => {
      resolvePlatformDshHome(undefined, { isProduction: true });
    }).toThrow(/FAIL-CLOSED: ENKEEP_DSH_HOME or DSH_HOME environment variable is mandatory in production mode\. Silent fallback to ~\/\.dsh is disabled\./);

    expect(() => {
      resolvePlatformDshHome(undefined, true);
    }).toThrow(/FAIL-CLOSED: ENKEEP_DSH_HOME or DSH_HOME environment variable is mandatory in production mode\. Silent fallback to ~\/\.dsh is disabled\./);

    process.env.NODE_ENV = 'production';
    expect(() => {
      resolvePlatformDshHome();
    }).toThrow(/FAIL-CLOSED: ENKEEP_DSH_HOME or DSH_HOME environment variable is mandatory in production mode\. Silent fallback to ~\/\.dsh is disabled\./);
  });

  it('never calls os.homedir() under any circumstance', () => {
    const homedirSpy = vi.spyOn(os, 'homedir');

    resolvePlatformDshHome('/tmp/custom');
    process.env.ENKEEP_DSH_HOME = '/tmp/enkeep';
    resolvePlatformDshHome();
    delete process.env.ENKEEP_DSH_HOME;
    process.env.DSH_HOME = '/tmp/dsh';
    resolvePlatformDshHome();
    delete process.env.DSH_HOME;
    resolvePlatformDshHome();

    expect(homedirSpy).not.toHaveBeenCalled();
    homedirSpy.mockRestore();
  });
});
