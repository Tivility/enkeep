/**
 * Memory Tools Integration Test Suite
 *
 * Verifies:
 * 1. Boot Dsh runtime with production-like platformClient (fallback capability).
 * 2. Agent scoped tools schemas include memory_write, memory_read, memory_search.
 * 3. Registered memory_write tool writes to global memory, returns valid etag.
 * 4. Registered memory_read tool reads bytes, verifies content and etag match.
 * 5. Space vs Global roots are completely distinct.
 * 6. Wrong expectedEtag is rejected with concurrency conflict error.
 * 7. Path traversal escaping root boundary is rejected.
 * 8. Agent recreation/disposal does not duplicate tool registrations.
 * 9. Subagent / child context inherits memory tools through Cordis scope.
 *
 * @module @enkeep/runtime-runner/tests/memory-tools-integration.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { bootDshRuntime } from '../src/runtime/dsh-boot.js';
import { DshPlatformClient } from '@enkeep/dsh-platform-client';

describe('Memory Tools Integration in DSH Runtime', () => {
  let tmpDir: string;
  let testHome: string;
  let testSpaces: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-memory-integration-'));
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

  it('boots runtime, mounts 3 memory tools in agent context, executes write/read with etag, and enforces security boundaries', async () => {
    const spaceName = 'space-test';
    const spacePath = path.join(testSpaces, spaceName);
    fs.mkdirSync(spacePath, { recursive: true, mode: 0o700 });

    // Production-like client without custom memory endpoints -> ensures graceful filesystem fallback
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

      // 1. Verify agent scoped tools schemas include 3 memory tools
      const toolsService = agent.ctx.tools ?? (agent.ctx.get ? agent.ctx.get('tools') : undefined);
      expect(toolsService).toBeDefined();

      const schemas = toolsService.schemas(agent);
      const toolNames = schemas.map((s: { name: string }) => s.name);
      expect(toolNames).toContain('memory_write');
      expect(toolNames).toContain('memory_read');
      expect(toolNames).toContain('memory_search');

      // Verify no duplicate registrations for memory tools
      const writeToolsCount = toolNames.filter((n: string) => n === 'memory_write').length;
      expect(writeToolsCount).toBe(1);

      // Retrieve registered tool definitions directly from tool runtime
      const view = (toolsService as any).view(agent);
      const writeTool = view.visible.get('memory_write');
      const readTool = view.visible.get('memory_read');
      const searchTool = view.visible.get('memory_search');

      expect(writeTool).toBeDefined();
      expect(readTool).toBeDefined();
      expect(searchTool).toBeDefined();

      // 2. Invoke memory_write for global memory
      const globalContent = 'Agent analysis: weekly5216 metrics successfully calculated.';
      const writeResult = await writeTool.execute({
        path: 'weekly5216_summary.md',
        content: globalContent,
        scope: 'global',
        mode: 'overwrite',
      }, { agent });

      expect(writeResult.success).toBe(true);
      expect(writeResult.scope).toBe('global');
      expect(writeResult.bytesWritten).toBe(Buffer.byteLength(globalContent, 'utf8'));
      expect(typeof writeResult.etag).toBe('string');
      expect(writeResult.etag.length).toBeGreaterThan(0);

      const initialEtag = writeResult.etag;

      // 3. Invoke memory_read to verify bytes and hash/etag
      const readResult = await readTool.execute({
        path: 'weekly5216_summary.md',
        scope: 'global',
      }, { agent });

      expect(readResult.success).toBe(true);
      expect(readResult.content).toBe(globalContent);
      expect(readResult.etag).toBe(initialEtag);
      expect(readResult.totalBytes).toBe(Buffer.byteLength(globalContent, 'utf8'));

      // 4. Verify physical global memory location under $DSH_HOME/memory
      const expectedGlobalPath = path.join(testHome, 'memory', 'weekly5216_summary.md');
      expect(fs.existsSync(expectedGlobalPath)).toBe(true);
      expect(fs.readFileSync(expectedGlobalPath, 'utf8')).toBe(globalContent);

      // 5. Space vs Global roots are distinct
      const spaceContent = 'Space scoped data: workspace specific task.';
      const spaceWriteResult = await writeTool.execute({
        path: 'space_data.md',
        content: spaceContent,
        scope: 'space',
        mode: 'overwrite',
      }, { agent });

      expect(spaceWriteResult.success).toBe(true);
      expect(spaceWriteResult.scope).toBe('space');

      const expectedSpacePath = path.join(spacePath, 'memory', 'space_data.md');
      expect(fs.existsSync(expectedSpacePath)).toBe(true);
      expect(fs.readFileSync(expectedSpacePath, 'utf8')).toBe(spaceContent);
      // Ensure space file is NOT in global memory root
      expect(fs.existsSync(path.join(testHome, 'memory', 'space_data.md'))).toBe(false);

      // 6. Wrong expectedEtag rejection (optimistic concurrency control)
      await expect(
        writeTool.execute({
          path: 'weekly5216_summary.md',
          content: 'Conflicting content',
          scope: 'global',
          expectedEtag: 'outdated-etag-99999',
        }, { agent })
      ).rejects.toThrow(/Memory write conflict/i);

      // 7. Unsafe path traversal rejection
      await expect(
        writeTool.execute({
          path: '../../etc/passwd',
          content: 'malicious payload',
          scope: 'global',
        }, { agent })
      ).rejects.toThrow(/escapes memory root boundary/i);

      await expect(
        readTool.execute({
          path: '../../../system.log',
          scope: 'global',
        }, { agent })
      ).rejects.toThrow(/escapes memory root boundary/i);

      // 8. Search tool verifies query across memory files
      const searchResult = await searchTool.execute({
        query: 'weekly5216',
        scope: 'global',
      }, { agent });

      expect(searchResult.success).toBe(true);
      expect(searchResult.totalMatches).toBeGreaterThan(0);
      expect(searchResult.matches.some((m: any) => m.path.includes('weekly5216_summary.md'))).toBe(true);

      // 9. Verify subagent child execution / context inherits memory tools
      const subagents = runtime.context.get('subagents');
      expect(subagents).toBeDefined();

      const run = await subagents.start('spawn', {
        label: 'test-child-memory',
        prompt: [{ type: 'text', text: 'Subagent verifying memory access.' }],
        parent: agent,
        signal: new AbortController().signal,
      });

      expect(run.id).toBeDefined();
      expect(run.localAgent).toBeDefined();

      const childAgent = run.localAgent!;
      const childTools = toolsService.schemas(childAgent);
      const childToolNames = childTools.map((s: { name: string }) => s.name);
      expect(childToolNames).toContain('memory_write');
      expect(childToolNames).toContain('memory_read');
      expect(childToolNames).toContain('memory_search');

      // Execute read tool from child agent view
      const childView = (toolsService as any).view(childAgent);
      const childReadTool = childView.visible.get('memory_read');
      expect(childReadTool).toBeDefined();

      const childReadResult = await childReadTool.execute({
        path: 'weekly5216_summary.md',
        scope: 'global',
      }, { agent: childAgent });
      expect(childReadResult.success).toBe(true);
      expect(childReadResult.content).toBe(globalContent);

      const res = await run.result;
      expect(res.stopReason).toBe('completed');
      await run.dispose();

      // 10. Verify agent reuse / re-get does not duplicate tools
      const sameAgent = await runtime.getOrCreateAgent(sessionId, null, spaceName);
      const finalSchemas = toolsService.schemas(sameAgent);
      const finalWriteToolsCount = finalSchemas.map((s: { name: string }) => s.name).filter((n: string) => n === 'memory_write').length;
      expect(finalWriteToolsCount).toBe(1);

    } finally {
      await runtime.dispose();
    }
  });

  it('child agent without space cwd has global memory available, space memory rejected fail-closed, and spacesDir/memory is never created', async () => {
    const runtime = await bootDshRuntime({
      userId: 'test-user-no-space',
      dshHome: testHome,
      spacesDir: testSpaces,
    });

    try {
      // Boot agent without workspaceFolder / space (no space context)
      const sessionId = 'ses_0123456789abcdef0123456789abcde0';
      const rootAgent = await runtime.getOrCreateAgent(sessionId);

      const subagents = runtime.context.get('subagents');
      expect(subagents).toBeDefined();

      const run = await subagents.start('spawn', {
        label: 'test-spaceless-child',
        prompt: [{ type: 'text', text: 'Spaceless child verifying failclosed memory.' }],
        parent: rootAgent,
        signal: new AbortController().signal,
      });

      expect(run.localAgent).toBeDefined();
      const childAgent = run.localAgent!;

      const toolsService = childAgent.ctx.tools ?? (childAgent.ctx.get ? childAgent.ctx.get('tools') : undefined);
      expect(toolsService).toBeDefined();

      const schemas = toolsService.schemas(childAgent);
      const toolNames = schemas.map((s: { name: string }) => s.name);
      expect(toolNames).toContain('memory_write');
      expect(toolNames).toContain('memory_read');
      expect(toolNames).toContain('memory_search');

      const childView = (toolsService as any).view(childAgent);
      const childWriteTool = childView.visible.get('memory_write');
      const childReadTool = childView.visible.get('memory_read');
      const childSearchTool = childView.visible.get('memory_search');

      // 1. Global memory write succeeds
      const globalText = 'Spaceless global fact.';
      const writeRes = await childWriteTool.execute({
        path: 'spaceless_global.md',
        content: globalText,
        scope: 'global',
      }, { agent: childAgent });
      expect(writeRes.success).toBe(true);

      // Global memory read succeeds
      const readRes = await childReadTool.execute({
        path: 'spaceless_global.md',
        scope: 'global',
      }, { agent: childAgent });
      expect(readRes.success).toBe(true);
      expect(readRes.content).toBe(globalText);

      // 2. Space memory write rejects fail-closed
      await expect(
        childWriteTool.execute({
          path: 'space_leak.md',
          content: 'Should be rejected',
          scope: 'space',
        }, { agent: childAgent })
      ).rejects.toThrow(/Space memory operation rejected: no space context available/i);

      // Space memory read rejects fail-closed
      await expect(
        childReadTool.execute({
          path: 'space_leak.md',
          scope: 'space',
        }, { agent: childAgent })
      ).rejects.toThrow(/Space memory operation rejected: no space context available/i);

      // Space memory search rejects fail-closed
      await expect(
        childSearchTool.execute({
          query: 'anything',
          scope: 'space',
        }, { agent: childAgent })
      ).rejects.toThrow(/Space memory operation rejected: no space context available/i);

      // 3. spacesDir/memory was NEVER created
      expect(fs.existsSync(path.join(testSpaces, 'memory'))).toBe(false);

      const res = await run.result;
      expect(res.stopReason).toBe('completed');
      await run.dispose();
    } finally {
      await runtime.dispose();
    }
  });
});
