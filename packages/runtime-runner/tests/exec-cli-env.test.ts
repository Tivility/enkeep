import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { validateExecEnvironment, runExecCli, TypedCliError } from '../src/runtime/exec-cli.js';

describe('Exec CLI Environment Validation (D7)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe('validateExecEnvironment', () => {
    it('accepts legitimate DSH_SPACES directly under DSH_HOME (/home/dsh/spaces with DSH_HOME=/home/dsh)', () => {
      const env: NodeJS.ProcessEnv = {
        DSH_USER: 'alice',
        DSH_HOME: '/home/dsh',
        DSH_SPACES: '/home/dsh/spaces',
      };
      const result = validateExecEnvironment(env);
      expect(result).toEqual({
        userId: 'alice',
        dshHome: '/home/dsh',
        spacesDir: '/home/dsh/spaces',
      });
    });

    it('accepts legitimate DSH_SPACES beside .dsh under parent of DSH_HOME (/home/dsh/spaces with DSH_HOME=/home/dsh/.dsh)', () => {
      const env: NodeJS.ProcessEnv = {
        DSH_USER: 'alice',
        DSH_HOME: '/home/dsh/.dsh',
        DSH_SPACES: '/home/dsh/spaces',
      };
      const result = validateExecEnvironment(env);
      expect(result).toEqual({
        userId: 'alice',
        dshHome: '/home/dsh/.dsh',
        spacesDir: '/home/dsh/spaces',
      });
    });

    it('accepts custom absolute normalized host user runtimes with and without .dsh', () => {
      const withDsh = validateExecEnvironment({
        DSH_USER: 'bob_user',
        DSH_HOME: '/data/users/bob_user/.dsh',
        DSH_SPACES: '/data/users/bob_user/spaces',
      });
      expect(withDsh.spacesDir).toBe('/data/users/bob_user/spaces');

      const withoutDsh = validateExecEnvironment({
        DSH_USER: 'bob_user',
        DSH_HOME: '/data/users/bob_user',
        DSH_SPACES: '/data/users/bob_user/spaces',
      });
      expect(withoutDsh.spacesDir).toBe('/data/users/bob_user/spaces');
    });

    it('rejects genuinely invalid DSH_SPACES environments', () => {
      // 1. Missing DSH_SPACES
      expect(() =>
        validateExecEnvironment({
          DSH_USER: 'alice',
          DSH_HOME: '/home/dsh',
        })
      ).toThrowError(expect.objectContaining({ code: 'INVALID_ENV' }));

      // 2. Relative DSH_SPACES
      expect(() =>
        validateExecEnvironment({
          DSH_USER: 'alice',
          DSH_HOME: '/home/dsh',
          DSH_SPACES: 'home/dsh/spaces',
        })
      ).toThrowError(expect.objectContaining({ code: 'INVALID_ENV' }));

      // 3. Un-normalized DSH_SPACES
      expect(() =>
        validateExecEnvironment({
          DSH_USER: 'alice',
          DSH_HOME: '/home/dsh',
          DSH_SPACES: '/home/dsh/../dsh/spaces',
        })
      ).toThrowError(expect.objectContaining({ code: 'INVALID_ENV' }));

      // 4. Incorrect basename (must end with "spaces")
      expect(() =>
        validateExecEnvironment({
          DSH_USER: 'alice',
          DSH_HOME: '/home/dsh',
          DSH_SPACES: '/home/dsh/workspaces',
        })
      ).toThrowError(expect.objectContaining({ code: 'INVALID_ENV' }));

      // 5. Foreign parent directory (neither dshHome nor parent of dshHome)
      expect(() =>
        validateExecEnvironment({
          DSH_USER: 'alice',
          DSH_HOME: '/home/dsh',
          DSH_SPACES: '/var/spaces',
        })
      ).toThrowError(expect.objectContaining({ code: 'INVALID_ENV' }));

      expect(() =>
        validateExecEnvironment({
          DSH_USER: 'alice',
          DSH_HOME: '/home/dsh/.dsh',
          DSH_SPACES: '/tmp/other/spaces',
        })
      ).toThrowError(expect.objectContaining({ code: 'INVALID_ENV' }));

      // 6. Deprecated DSH_SPACES_DIR is forbidden
      expect(() =>
        validateExecEnvironment({
          DSH_USER: 'alice',
          DSH_HOME: '/home/dsh',
          DSH_SPACES: '/home/dsh/spaces',
          DSH_SPACES_DIR: '/home/dsh/spaces',
        })
      ).toThrowError(expect.objectContaining({ code: 'INVALID_ENV' }));

      // 7. Invalid or missing DSH_USER
      expect(() =>
        validateExecEnvironment({
          DSH_HOME: '/home/dsh',
          DSH_SPACES: '/home/dsh/spaces',
        })
      ).toThrowError(expect.objectContaining({ code: 'INVALID_ENV' }));

      expect(() =>
        validateExecEnvironment({
          DSH_USER: '../invalid/user',
          DSH_HOME: '/home/dsh',
          DSH_SPACES: '/home/dsh/spaces',
        })
      ).toThrowError(expect.objectContaining({ code: 'INVALID_ENV' }));

      // 8. Invalid or relative DSH_HOME
      expect(() =>
        validateExecEnvironment({
          DSH_USER: 'alice',
          DSH_HOME: 'relative/home',
          DSH_SPACES: '/home/dsh/spaces',
        })
      ).toThrowError(expect.objectContaining({ code: 'INVALID_ENV' }));
    });
  });

  describe('runExecCli Integration with Environment Validation', () => {
    it('passes environment validation without INVALID_ENV error when legitimate DSH_SPACES and DSH_HOME=/home/dsh are provided', async () => {
      const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-cli-test-'));
      const dshHome = path.join(tmpBase, 'dsh');
      const dshSpaces = path.join(dshHome, 'spaces');
      fs.mkdirSync(dshHome, { recursive: true, mode: 0o700 });
      fs.mkdirSync(dshSpaces, { recursive: true, mode: 0o700 });

      process.env.DSH_USER = 'alice';
      process.env.DSH_HOME = dshHome;
      process.env.DSH_SPACES = dshSpaces;

      let stdoutOutput = '';
      const originalStdoutWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk: string | Uint8Array) => {
        stdoutOutput += chunk.toString();
        return true;
      };

      try {
        if (typeof process.getuid === 'function') {
          vi.spyOn(process, 'getuid').mockReturnValue(1000);
        }

        await runExecCli(['health']);
        const envelope = JSON.parse(stdoutOutput.trim());
        expect(envelope.status).toBe('error');
        // Environment validation passed; subsequent file ownership check fails on macOS host because files created are UID 501 != 1000
        expect(envelope.code).not.toBe('INVALID_ENV');
      } finally {
        process.stdout.write = originalStdoutWrite;
        fs.rmSync(tmpBase, { recursive: true, force: true });
      }
    });

    it('rejects with INVALID_ENV error envelope when genuinely invalid DSH_SPACES is provided', async () => {
      process.env.DSH_USER = 'alice';
      process.env.DSH_HOME = '/home/dsh';
      process.env.DSH_SPACES = '/var/invalid/spaces_path';

      let stdoutOutput = '';
      const originalStdoutWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk: string | Uint8Array) => {
        stdoutOutput += chunk.toString();
        return true;
      };

      try {
        if (typeof process.getuid === 'function') {
          vi.spyOn(process, 'getuid').mockReturnValue(1000);
        }

        await runExecCli(['health']);
        const envelope = JSON.parse(stdoutOutput.trim());
        expect(envelope.status).toBe('error');
        expect(envelope.code).toBe('INVALID_ENV');
        expect(envelope.error).toContain('DSH_SPACES directory must reside directly under DSH_HOME or parent of DSH_HOME');
      } finally {
        process.stdout.write = originalStdoutWrite;
      }
    });
  });
});
