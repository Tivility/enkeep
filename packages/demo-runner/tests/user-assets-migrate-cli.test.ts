/**
 * `user-assets-migrate` exit status: divergent copies (operator decision needed) exit non-zero,
 * also with --dry-run. The Docker-backed run is replaced by fixed reports.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

const reports: { current: Array<{ runtimeIdentity: string; volumeName: string; outcome: string; comparisons: []; archived: [] }> } = { current: [] };

vi.mock('../src/user-assets/cli.js', async () => {
  const { migrationExitCode } = await import('../src/user-assets/index.js');
  return {
    runUserAssetMigrateCli: vi.fn(async (opts: { dryRun: boolean }) => {
      const exitCode = migrationExitCode(reports.current as any);
      return { ok: exitCode === 0, exitCode, dryRun: opts.dryRun, reports: reports.current };
    }),
  };
});

import { runDemoRunnerCli } from '../src/demo-runner.js';
import { migrationExitCode } from '../src/user-assets/index.js';

function report(outcome: string) {
  return { runtimeIdentity: 'alice_1a2b3c4d', volumeName: 'enkeep-demo-dsh-alice_1a2b3c4d', outcome, comparisons: [] as [], archived: [] as [] };
}

describe('user-assets-migrate exit status', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps outcomes to exit codes', () => {
    expect(migrationExitCode([])).toBe(0);
    expect(migrationExitCode([report('converged'), report('already_mounted'), report('no_container')] as any)).toBe(0);
    expect(migrationExitCode([report('converged'), report('divergent')] as any)).toBe(2);
    expect(migrationExitCode([report('divergent'), report('busy')] as any)).toBe(1);
    expect(migrationExitCode([report('error')] as any)).toBe(1);
  });

  async function runCli(args: string[]): Promise<number | undefined> {
    let code: number | undefined;
    vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
      code = c ?? 0;
      return undefined as never;
    }) as any);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await runDemoRunnerCli(['user-assets-migrate', '--repo-root', process.cwd(), '--json', ...args]);
    return code;
  }

  it('exits 2 when a user is divergent, with and without --dry-run', async () => {
    reports.current = [report('converged'), report('divergent')];
    expect(await runCli([])).toBe(2);
    expect(await runCli(['--dry-run'])).toBe(2);
  });

  it('exits 0 when everything converged', async () => {
    reports.current = [report('converged'), report('already_converged')];
    expect(await runCli([])).toBeUndefined();
  });
});
