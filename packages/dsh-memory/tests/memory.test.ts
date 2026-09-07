/**
 * Unit & Integration Tests for @enkeep/dsh-memory
 *
 * Validates:
 * 1. XML escaping and template variable protection.
 * 2. Prompt section assembly and SHA-256 deterministic hashing.
 * 3. Memory read/write/search tools and security confinement.
 * 4. Optimistic concurrency control (etag / expectedHash).
 * 5. MemoryService Cordis lifecycle and scoped agent mounting.
 *
 * @module @enkeep/dsh-memory/tests/memory.test
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Context, Service } from '@deepseek-ai/cordis';
import {
  escapeXmlContent,
  escapeTemplateVariables,
  sanitizeMemoryForPrompt,
  truncateUtf8Bytes,
  computeContentHash,
  assembleMemoryPromptSection,
  ensureGlobalMemorySkeleton,
  resolveSafeMemoryPath,
  createMemoryReadTool,
  createMemoryWriteTool,
  createMemorySearchTool,
  MemoryService,
  apply,
} from '../src/index.js';

describe('dsh-memory: Sanitization & Prompt Assembly', () => {
  it('escapes XML special characters safely', () => {
    const input = '<script>alert("xss & dangerous")</script>\'test\'';
    const escaped = escapeXmlContent(input);
    expect(escaped).toBe('&lt;script&gt;alert(&quot;xss &amp; dangerous&quot;)&lt;/script&gt;&apos;test&apos;');
  });

  it('escapes template variables to prevent DSH interpolation errors', () => {
    const input = 'System {{user_name}} and {{role}} config';
    const escaped = escapeTemplateVariables(input);
    expect(escaped).toBe('System &#123;&#123;user_name&#125;&#125; and &#123;&#123;role&#125;&#125; config');
  });

  it('sanitizes memory text through combined XML and template escaping', () => {
    const input = '<inject>{{secret_key}} & <data>';
    const sanitized = sanitizeMemoryForPrompt(input);
    expect(sanitized).toBe('&lt;inject&gt;&#123;&#123;secret_key&#125;&#125; &amp; &lt;data&gt;');
  });

  it('safely truncates UTF-8 strings at byte boundaries', () => {
    const text = 'Hello 世界 🌍 test';
    const fullBytes = Buffer.byteLength(text, 'utf-8');
    const truncated = truncateUtf8Bytes(text, 10);
    expect(truncated.truncated).toBe(true);
    expect(Buffer.byteLength(truncated.text, 'utf-8')).toBeLessThanOrEqual(10);
    expect(truncateUtf8Bytes(text, fullBytes + 10).truncated).toBe(false);
  });

  it('computes deterministic SHA-256 hashes', () => {
    const hash1 = computeContentHash('test-content');
    const hash2 = computeContentHash('test-content');
    const hash3 = computeContentHash('different-content');
    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hash3);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('dsh-memory: Tools & Confinement', () => {
  let tmpDir: string;
  let dshHome: string;
  let spacePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-memory-test-'));
    dshHome = path.join(tmpDir, 'dsh');
    spacePath = path.join(tmpDir, 'space');
    fs.mkdirSync(dshHome, { recursive: true });
    fs.mkdirSync(spacePath, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('ensures global memory skeleton creation', () => {
    const globalPath = ensureGlobalMemorySkeleton(dshHome);
    expect(fs.existsSync(globalPath)).toBe(true);
    expect(fs.readFileSync(globalPath, 'utf-8')).toContain('# Global Memory');
  });

  it('assembles memory prompt section with global and space files', () => {
    ensureGlobalMemorySkeleton(dshHome);
    const spaceMemoryDir = path.join(spacePath, 'memory');
    fs.mkdirSync(spaceMemoryDir, { recursive: true });
    fs.writeFileSync(path.join(spaceMemoryDir, 'space.md'), '# Space Memory\nProject details here.', 'utf-8');

    const assembled = assembleMemoryPromptSection({
      dshHome,
      spacePath,
      userId: 'user_123',
      spaceId: 'space_456',
      maxGlobalBytes: 20480,
    });

    expect(assembled.text).toContain('<enkeep_memory');
    expect(assembled.text).toContain('Global Memory');
    expect(assembled.text).toContain('Space-specific memories');
    expect(assembled.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(assembled.snapshot.globalMemory?.path).toBe('global.md');
    expect(assembled.snapshot.spaceMemory?.available).toBe(true);
  });

  it('resolves safe memory paths and prevents path traversal', () => {
    const safe = resolveSafeMemoryPath('notes.md', 'global', dshHome, spacePath);
    expect(safe.targetPath).toBe(path.join(dshHome, 'memory', 'notes.md'));

    expect(() => {
      resolveSafeMemoryPath('../../../etc/passwd', 'global', dshHome, spacePath);
    }).toThrow(/escapes memory root boundary/);
  });

  it('executes memory_read tool correctly with pagination', async () => {
    const globalMemoryDir = path.join(dshHome, 'memory');
    fs.mkdirSync(globalMemoryDir, { recursive: true });
    const content = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
    fs.writeFileSync(path.join(globalMemoryDir, 'test.md'), content, 'utf-8');

    const readTool = createMemoryReadTool({ dshHome, spacePath });
    const res = (await readTool.execute({
      path: 'test.md',
      scope: 'global',
      offset: 2,
      limit: 2,
    } as any, {} as any)) as any;

    expect(res.success).toBe(true);
    expect(res.content).toBe('Line 2\nLine 3');
    expect(res.totalBytes).toBe(Buffer.byteLength(content, 'utf-8'));
    expect(res.etag).toBeDefined();
  });

  it('executes memory_write tool with append, overwrite, and OCC', async () => {
    const writeTool = createMemoryWriteTool({ dshHome, spacePath, userId: 'u1', spaceId: 's1' });

    // 1. Initial write (overwrite)
    const writeRes = (await writeTool.execute({
      path: 'notes.md',
      scope: 'global',
      mode: 'overwrite',
      content: 'Initial content',
    } as any, {} as any)) as any;

    expect(writeRes.success).toBe(true);
    expect(writeRes.bytesWritten).toBeGreaterThan(0);
    const initialEtag = writeRes.etag;

    // 2. Append write
    const appendRes = (await writeTool.execute({
      path: 'notes.md',
      scope: 'global',
      mode: 'append',
      content: 'Appended line',
    } as any, {} as any)) as any;

    expect(appendRes.success).toBe(true);
    const readTool = createMemoryReadTool({ dshHome, spacePath });
    const readRes = (await readTool.execute({ path: 'notes.md', scope: 'global' } as any, {} as any)) as any;
    expect(readRes.content).toContain('Initial content');
    expect(readRes.content).toContain('Appended line');

    // 3. Optimistic Concurrency Control (OCC) conflict
    await expect(
      writeTool.execute({
        path: 'notes.md',
        scope: 'global',
        mode: 'overwrite',
        content: 'Conflicting content',
        expectedEtag: initialEtag, // outdated etag
      } as any, {} as any)
    ).rejects.toThrow(/Memory write conflict/);
  });

  it('executes memory_search tool and finds keyword matches', async () => {
    const globalMemoryDir = path.join(dshHome, 'memory');
    fs.mkdirSync(globalMemoryDir, { recursive: true });
    fs.writeFileSync(path.join(globalMemoryDir, 'doc1.md'), 'Important keyword ALPHA located here.', 'utf-8');
    fs.writeFileSync(path.join(globalMemoryDir, 'doc2.md'), 'No match in this document.', 'utf-8');

    const searchTool = createMemorySearchTool({ dshHome, spacePath });
    const searchRes = (await searchTool.execute({
      query: 'ALPHA',
      scope: 'global',
    } as any, {} as any)) as any;

    expect(searchRes.success).toBe(true);
    expect(searchRes.totalMatches).toBe(1);
    expect(searchRes.matches[0].path).toBe('doc1.md');
    expect(searchRes.matches[0].text).toContain('ALPHA');
  });
});

describe('dsh-memory: Cordis Service & Lifecycle', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-memory-service-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('registers MemoryService and mounts memory onto agent context cleanly', async () => {
    const ctx = new Context();
    await ctx.plugin(MemoryService);

    const memoryService = ctx.get('memory') as MemoryService;
    expect(memoryService).toBeDefined();

    const dshHome = path.join(tmpDir, 'dsh');
    const spacePath = path.join(tmpDir, 'space');
    fs.mkdirSync(dshHome, { recursive: true });
    fs.mkdirSync(spacePath, { recursive: true });

    class MockToolsService extends Service {
      public tools: any[] = [];
      constructor(c: Context) {
        super(c, 'tools');
      }
      register(tool: any) {
        this.tools.push(tool);
        return () => {
          const idx = this.tools.indexOf(tool);
          if (idx !== -1) this.tools.splice(idx, 1);
        };
      }
    }

    class MockSystemPromptService extends Service {
      public sections: any[] = [];
      constructor(c: Context) {
        super(c, 'systemPrompt');
      }
      section(sec: any) {
        this.sections.push(sec);
        return () => {
          const idx = this.sections.indexOf(sec);
          if (idx !== -1) this.sections.splice(idx, 1);
        };
      }
    }

    await ctx.plugin(MockToolsService);
    await ctx.plugin(MockSystemPromptService);

    const agentCtx = ctx.isolate(['tools', 'systemPrompt']);
    const mountHandle = memoryService.mountAgentMemory(agentCtx, {
      dshHome,
      spacePath,
      spaceId: 'sp_1',
      userId: 'usr_1',
    });

    expect(mountHandle.snapshot).toBeDefined();
    expect(mountHandle.registeredTools).toEqual(['memory_search', 'memory_read', 'memory_write']);

    const tools = (ctx.get('tools') as any).tools;
    expect(tools.length).toBe(3);

    const sections = (ctx.get('systemPrompt') as any).sections;
    expect(sections.length).toBe(1);
    expect(sections[0].name).toBe('memory:enkeep');
    expect(sections[0].order).toBe(50);

    // Test clean disposal
    mountHandle.dispose();
    expect(tools.length).toBe(0);
    expect(sections.length).toBe(0);
  });
});
