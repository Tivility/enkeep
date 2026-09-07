import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Context } from '@deepseek-ai/cordis';
import { CliToolService } from '../src/service.js';
import { validateCliInputArgs } from '../src/executor.js';
import type { ExtensionActivationPlan, ExtensionCliContributionActivation } from '../src/types.js';

describe('CLI Tools Subsystem (@enkeep/dsh-tool-cli)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-cli-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Input argument validation', () => {
    it('accepts valid string argument array', () => {
      const args = ['--help', 'hello', 'world'];
      expect(validateCliInputArgs(args)).toEqual(['--help', 'hello', 'world']);
    });

    it('defaults undefined or null to empty array', () => {
      expect(validateCliInputArgs(undefined)).toEqual([]);
      expect(validateCliInputArgs(null)).toEqual([]);
    });

    it('rejects non-array arguments', () => {
      expect(() => validateCliInputArgs('hello')).toThrow(/must be an array of strings/);
      expect(() => validateCliInputArgs({ a: 1 })).toThrow(/must be an array of strings/);
    });

    it('rejects more than 32 arguments', () => {
      const args = Array.from({ length: 33 }, (_, i) => `arg${i}`);
      expect(() => validateCliInputArgs(args)).toThrow(/exceeding maximum limit of 32/);
    });

    it('rejects arguments larger than 4KB', () => {
      const largeArg = 'a'.repeat(4097);
      expect(() => validateCliInputArgs([largeArg])).toThrow(/exceeds maximum allowed size of 4096/);
    });
  });

  describe('Mount and Lifecycle', () => {
    it('mounts CLI tools from ExtensionActivationPlan and unmounts cleanly on dispose', async () => {
      const scriptRel = '.extensions/demo-cli/run.mjs';
      const scriptAbs = path.join(tempDir, scriptRel);
      fs.mkdirSync(path.dirname(scriptAbs), { recursive: true });
      fs.writeFileSync(
        scriptAbs,
        `
console.log('CLI output: ' + process.argv.slice(2).join(' '));
`,
        'utf8'
      );

      const ctx = new Context();
      const toolsMap = new Map<string, any>();
      (ctx as any).tools = {
        register: (def: any) => {
          toolsMap.set(def.name, def);
          return () => toolsMap.delete(def.name);
        },
      };

      // Mock approval service
      (ctx as any).approval = {
        request: async () => 'allowed-once',
      };

      const cliService = new CliToolService(ctx);

      const plan: ExtensionActivationPlan = {
        generation: 1,
        contributions: [
          {
            kind: 'cli',
            contributionId: 'contrib_1',
            contributionKey: 'demo-cli',
            name: 'Demo CLI',
            enabled: true,
            command: 'node',
            script: 'run.mjs',
            artifactRelPath: scriptRel,
            fixedArgs: ['--prefix'],
          },
        ],
        skills: [],
        cli: [
          {
            kind: 'cli',
            contributionId: 'contrib_1',
            contributionKey: 'demo-cli',
            name: 'Demo CLI',
            enabled: true,
            command: 'node',
            script: 'run.mjs',
            artifactRelPath: scriptRel,
            fixedArgs: ['--prefix'],
          },
        ],
      };

      const handle = await cliService.mountActivationPlan(ctx, plan, { spacePath: tempDir });
      expect(handle.registeredTools.has('cli__demo_cli__run')).toBe(true);
      expect(toolsMap.has('cli__demo_cli__run')).toBe(true);

      // Execute tool
      const tool = toolsMap.get('cli__demo_cli__run');
      const result = await tool.execute({ args: ['foo', 'bar'] }, { agent: { session: { id: 's1' } } });
      expect(result.stdout).toContain('CLI output: --prefix foo bar');
      expect(result.exitCode).toBe(0);

      // Dispose
      await handle.dispose();
      expect(toolsMap.has('cli__demo_cli__run')).toBe(false);
    });

    it('enforces approval and fails closed when rejected', async () => {
      const scriptRel = '.extensions/demo-cli/run.mjs';
      const scriptAbs = path.join(tempDir, scriptRel);
      fs.mkdirSync(path.dirname(scriptAbs), { recursive: true });
      fs.writeFileSync(scriptAbs, `console.log('should not run');`, 'utf8');

      const ctx = new Context();
      const toolsMap = new Map<string, any>();
      (ctx as any).tools = {
        register: (def: any) => {
          toolsMap.set(def.name, def);
          return () => toolsMap.delete(def.name);
        },
      };

      (ctx as any).approval = {
        request: async () => 'rejected',
      };

      const cliService = new CliToolService(ctx);
      const plan: ExtensionActivationPlan = {
        generation: 1,
        contributions: [],
        skills: [],
        cli: [
          {
            kind: 'cli',
            contributionId: 'contrib_1',
            contributionKey: 'demo-cli',
            name: 'Demo CLI',
            enabled: true,
            artifactRelPath: scriptRel,
          },
        ],
      };

      await cliService.mountActivationPlan(ctx, plan, { spacePath: tempDir });
      const tool = toolsMap.get('cli__demo_cli__run');
      await expect(
        tool.execute({ args: [] }, { agent: { session: { id: 's1' } } })
      ).rejects.toThrow(/rejected by user approval policy/);
    });
  });
});
