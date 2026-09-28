import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { bootDshRuntime } from '../src/runtime/dsh-boot.js';
import { DshPlatformClient } from '@enkeep/dsh-platform-client';

describe('Task B: fs path allowlist & Task C: web_fetch integration', () => {
  let tmpDir: string;
  let testHome: string;
  let testSpaces: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-task-bc-test-'));
    testHome = path.join(tmpDir, 'user', '.dsh');
    testSpaces = path.join(tmpDir, 'user', 'spaces');

    fs.mkdirSync(testHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(testSpaces, { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('Task B: verifies fs allowlist rules for extraReadableRoots and extraWritableRoots', async () => {
    const spaceName = 'space-fs-test';
    const spacePath = path.join(testSpaces, spaceName);
    fs.mkdirSync(spacePath, { recursive: true, mode: 0o700 });

    const mockPlatformClient = new DshPlatformClient({
      baseURL: 'http://127.0.0.1:9999/platform',
      timeoutMs: 1000,
    });

    const runtime = await bootDshRuntime({
      userId: 'test-user',
      dshHome: testHome,
      spacesDir: testSpaces,
      platformClient: mockPlatformClient,
    });

    try {
      const sessionId = 'ses_0123456789abcdef0123456789abcdef';
      const agent = await runtime.getOrCreateAgent(sessionId, null, spaceName);
      const fsService = agent.ctx.get('fs');
      expect(fsService).toBeDefined();

      // 1. read tool on a file under os.tmpdir() succeeds
      const tmpFile = path.join(os.tmpdir(), `enkeep_test_tmp_${Date.now()}.txt`);
      fs.writeFileSync(tmpFile, 'hello from tmpdir', 'utf8');
      try {
        const targetTmp = await fsService.resolve(tmpFile);
        const readContent = await fsService.readText(targetTmp);
        expect(readContent).toBe('hello from tmpdir');
      } finally {
        try { fs.unlinkSync(tmpFile); } catch {}
      }

      // 2. read of /etc/passwd denied
      await expect(fsService.resolve('/etc/passwd')).rejects.toThrow(/Access denied/);

      // 3. write to os.tmpdir() succeeds
      const writeTmpFile = path.join(os.tmpdir(), `enkeep_test_write_${Date.now()}.txt`);
      try {
        const targetWrite = await fsService.resolve(writeTmpFile);
        await fsService.writeText(targetWrite, 'written to tmp');
        expect(fs.readFileSync(writeTmpFile, 'utf8')).toBe('written to tmp');
      } finally {
        try { fs.unlinkSync(writeTmpFile); } catch {}
      }

      // 4. read via a symlink inside the space pointing to /etc/passwd denied
      const symlinkInsideSpace = path.join(spacePath, 'passwd_link');
      try {
        fs.symlinkSync('/etc/passwd', symlinkInsideSpace);
        await expect(fsService.resolve(symlinkInsideSpace)).rejects.toThrow(/Access denied/);
      } finally {
        try { fs.unlinkSync(symlinkInsideSpace); } catch {}
      }

      // 5. read of a file under os.homedir() (create one in a temp subdir of HOME if writable, else skip)
      const homeDir = os.homedir();
      let homeSubdir: string | undefined;
      let homeFile: string | undefined;
      try {
        homeSubdir = path.join(homeDir, `.enkeep_tmp_test_${Date.now()}`);
        fs.mkdirSync(homeSubdir, { mode: 0o700 });
        homeFile = path.join(homeSubdir, 'home_test.txt');
        fs.writeFileSync(homeFile, 'hello from home', 'utf8');

        const targetHome = await fsService.resolve(homeFile);
        const homeContent = await fsService.readText(targetHome);
        expect(homeContent).toBe('hello from home');
      } catch (err: any) {
        // If os.homedir() is not writable in this environment, skip gracefully
        if (err.code === 'EACCES' || err.code === 'EPERM') {
          // skipped
        } else {
          throw err;
        }
      } finally {
        if (homeFile) {
          try { fs.unlinkSync(homeFile); } catch {}
        }
        if (homeSubdir) {
          try { fs.rmdirSync(homeSubdir); } catch {}
        }
      }
    } finally {
      await runtime.dispose();
    }
  });

  it('Task C: tools schema contains web_fetch and NOT web_search, executes against mock provider', async () => {
    const spaceName = 'space-web-test';
    const spacePath = path.join(testSpaces, spaceName);
    fs.mkdirSync(spacePath, { recursive: true, mode: 0o700 });

    const mockPlatformClient = new DshPlatformClient({
      baseURL: 'http://127.0.0.1:9999/platform',
      timeoutMs: 1000,
    });

    const runtime = await bootDshRuntime({
      userId: 'test-user',
      dshHome: testHome,
      spacesDir: testSpaces,
      platformClient: mockPlatformClient,
      web: {
        fetchProvider: 'mock-test-fetch-provider',
      },
    });

    try {
      const sessionId = 'ses_0123456789abcdef0123456789abcdee';
      const agent = await runtime.getOrCreateAgent(sessionId, null, spaceName);

      // 1. tools schema list contains 'web_fetch' and NOT 'web_search'
      const toolsService = agent.ctx.tools ?? (agent.ctx.get ? agent.ctx.get('tools') : undefined);
      expect(toolsService).toBeDefined();

      const schemas = toolsService.schemas(agent);
      const toolNames = schemas.map((s: any) => s.name);
      expect(toolNames).toContain('web_fetch');
      expect(toolNames).not.toContain('web_search');

      // 2. Register a fake fetch provider or use local loopback mock on ctx.web
      const webService = agent.ctx.get('web');
      expect(webService).toBeDefined();

      // Register a mock fetch provider that returns page heading
      const mockProvider = {
        id: 'mock-test-fetch-provider',
        available: () => true,
        fetch: async (req: any) => {
          return {
            url: req.url,
            statusCode: 200,
            body: {
              kind: 'html',
              content: '<h1>Welcome to Enkeep Test Page</h1><p>Test content body</p>',
            },
            truncated: false,
          };
        },
      };
      webService.registerFetchProvider(mockProvider);

      // Execute web_fetch tool via toolsService
      const fetchTool = toolsService.get('web_fetch', agent);
      expect(fetchTool).toBeDefined();

      const result = await fetchTool.execute({ url: 'https://example.com/test-page' }, { agent });
      expect(result).toBeDefined();
      const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
      expect(resultStr).toContain('Welcome to Enkeep Test Page');
    } finally {
      await runtime.dispose();
    }
  });
});
