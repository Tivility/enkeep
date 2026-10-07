import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseDshHome, parseContainerNetworkMode } from '../src/demo-runner.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('Demo Runner DSH Home Resolution & Precedence', () => {
  let tempBaseDir: string;
  let origEnkeepDshHome: string | undefined;
  let origDshHome: string | undefined;

  beforeEach(() => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-demo-dsh-test-'));
    origEnkeepDshHome = process.env.ENKEEP_DSH_HOME;
    origDshHome = process.env.DSH_HOME;
    delete process.env.ENKEEP_DSH_HOME;
    delete process.env.DSH_HOME;
  });

  afterEach(() => {
    if (origEnkeepDshHome !== undefined) process.env.ENKEEP_DSH_HOME = origEnkeepDshHome;
    else delete process.env.ENKEEP_DSH_HOME;

    if (origDshHome !== undefined) process.env.DSH_HOME = origDshHome;
    else delete process.env.DSH_HOME;

    try {
      fs.rmSync(tempBaseDir, { recursive: true, force: true });
    } catch {}
  });

  it('parses --dsh-home argument correctly', () => {
    const res1 = parseDshHome(['--dsh-home', '/tmp/synthetic-dsh']);
    expect(res1).toBe('/tmp/synthetic-dsh');

    const res2 = parseDshHome(['--dsh-home=/tmp/synthetic-dsh-eq']);
    expect(res2).toBe('/tmp/synthetic-dsh-eq');
  });

  it('fails closed when --dsh-home is missing value', () => {
    expect(() => parseDshHome(['--dsh-home'])).toThrow(/Safety Violation: --dsh-home requires a valid directory path/);
    expect(() => parseDshHome(['--dsh-home', '--other-flag'])).toThrow(/Safety Violation: --dsh-home requires a valid directory path/);
    expect(() => parseDshHome(['--dsh-home='])).toThrow(/Safety Violation: --dsh-home requires a valid directory path/);
  });

  it('prioritizes CLI arg over ENKEEP_DSH_HOME and DSH_HOME', () => {
    const env = {
      ENKEEP_DSH_HOME: '/tmp/env-enkeep',
      DSH_HOME: '/tmp/env-dsh',
    };
    const res = parseDshHome(['--dsh-home', '/tmp/cli-dsh'], env);
    expect(res).toBe('/tmp/cli-dsh');
  });

  it('prefers ENKEEP_DSH_HOME over DSH_HOME when CLI arg is absent', () => {
    const env = {
      ENKEEP_DSH_HOME: '/tmp/env-enkeep-pref',
      DSH_HOME: '/tmp/env-dsh-fallback',
    };
    const res = parseDshHome([], env);
    expect(res).toBe('/tmp/env-enkeep-pref');
  });

  it('falls back to DSH_HOME when ENKEEP_DSH_HOME is unset', () => {
    const env = {
      DSH_HOME: '/tmp/env-dsh-only',
    };
    const res = parseDshHome([], env);
    expect(res).toBe('/tmp/env-dsh-only');
  });

  it('returns undefined when neither CLI arg nor environment variables are provided', () => {
    const res = parseDshHome([], {});
    expect(res).toBeUndefined();
  });

  it('loads container network mode from explicit dsh-home settings.yaml', () => {
    const dshDir = path.join(tempBaseDir, 'dsh-custom');
    fs.mkdirSync(dshDir, { recursive: true });
    fs.writeFileSync(
      path.join(dshDir, 'settings.yaml'),
      'container-network-mode: bridge\n',
      'utf8'
    );

    const mode = parseContainerNetworkMode(['--dsh-home', dshDir], {});
    expect(mode).toBe('bridge');
  });
});
