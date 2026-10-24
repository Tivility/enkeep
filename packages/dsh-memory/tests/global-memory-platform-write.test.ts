/**
 * Global memory with a host-backed (read-only) memory directory.
 *
 * - globalMemoryWrite: 'platform' sends global writes to the platform route and never writes locally.
 * - Conflicts (HTTP 409) surface as MemoryWriteConflictError; other failures do not fall back.
 * - Space scope and the default 'local' mode are unchanged.
 * - The prompt skeleton tolerates a read-only memory directory.
 * - applyMemoryWriteAtRoot keeps the same etag/append semantics as the tool.
 *
 * Synthetic fixtures only.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createMemoryWriteTool,
  createMemoryReadTool,
  applyMemoryWriteAtRoot,
  ensureGlobalMemorySkeleton,
  MemoryWriteConflictError,
  MemoryPathError,
  PLATFORM_MEMORY_WRITE_ROUTE,
} from '../src/index.js';

function etagOf(content: string): string {
  return `"${crypto.createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16)}"`;
}

class FakeHttpError extends Error {
  constructor(readonly status: number, readonly responseData: unknown) {
    super(`HTTP ${status}`);
  }
}

describe('global memory: platform write mode', () => {
  let tmp: string;
  let dshHome: string;
  let spacePath: string;
  let calls: Array<{ path: string; body: any }>;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-mem-platform-')));
    dshHome = path.join(tmp, 'dsh');
    spacePath = path.join(tmp, 'space');
    fs.mkdirSync(path.join(dshHome, 'memory'), { recursive: true });
    fs.mkdirSync(spacePath, { recursive: true });
    fs.writeFileSync(path.join(dshHome, 'memory', 'global.md'), 'host copy');
    calls = [];
  });

  afterEach(() => {
    try {
      fs.chmodSync(path.join(dshHome, 'memory'), 0o700);
    } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function client(respond: (body: any) => any) {
    return {
      async request(p: string, opts: any) {
        calls.push({ path: p, body: opts.body });
        return respond(opts.body);
      },
    } as any;
  }

  it('sends global writes to the platform with no identity fields and does not touch the local file', async () => {
    const tool = createMemoryWriteTool({
      dshHome,
      spacePath,
      spaceId: 'space-1',
      userId: 'alice',
      globalMemoryWrite: 'platform',
      getClient: () => client(() => ({ data: { success: true, path: 'global.md', scope: 'global', bytesWritten: 3, etag: etagOf('new'), mode: 'overwrite', isNewFile: false, previousEtag: etagOf('host copy') } })),
    });
    const res = await tool.execute({ content: 'new', expectedEtag: etagOf('host copy') });
    expect(res).toMatchObject({ success: true, scope: 'global', etag: etagOf('new'), previousEtag: etagOf('host copy') });
    expect(calls).toEqual([
      {
        path: PLATFORM_MEMORY_WRITE_ROUTE,
        body: { scope: 'global', path: 'global.md', content: 'new', mode: 'overwrite', expectedEtag: etagOf('host copy') },
      },
    ]);
    expect(Object.keys(calls[0].body)).not.toContain('userId');
    expect(Object.keys(calls[0].body)).not.toContain('spaceId');
    // Platform owns the host copy: nothing written here.
    expect(fs.readFileSync(path.join(dshHome, 'memory', 'global.md'), 'utf8')).toBe('host copy');
  });

  it('surfaces a 409 from the platform as an etag conflict', async () => {
    const tool = createMemoryWriteTool({
      dshHome,
      globalMemoryWrite: 'platform',
      getClient: () =>
        client(() => {
          throw new FakeHttpError(409, { error: { code: 'MEMORY_WRITE_CONFLICT', message: 'Memory write conflict: stale' } });
        }),
    });
    await expect(tool.execute({ content: 'x', expectedEtag: '"0000000000000000"' })).rejects.toBeInstanceOf(MemoryWriteConflictError);
    await expect(tool.execute({ content: 'x', expectedEtag: '"0000000000000000"' })).rejects.toThrow(/conflict/i);
  });

  it('never falls back to a local write when the platform is unavailable or rejects', async () => {
    const offline = createMemoryWriteTool({ dshHome, globalMemoryWrite: 'platform', getClient: () => undefined });
    await expect(offline.execute({ content: 'x' })).rejects.toThrow(/platform connection is not ready/);

    const rejecting = createMemoryWriteTool({
      dshHome,
      globalMemoryWrite: 'platform',
      getClient: () => client(() => {
        throw new FakeHttpError(400, { error: { code: 'PATH_REJECTED', message: 'Memory path is not allowed' } });
      }),
    });
    await expect(rejecting.execute({ content: 'x', path: 'topics/a.md' })).rejects.toThrow(/HTTP 400/);
    const bad = createMemoryWriteTool({ dshHome, globalMemoryWrite: 'platform', getClient: () => client(() => ({ data: { success: false } })) });
    await expect(bad.execute({ content: 'x' })).rejects.toThrow(/invalid platform response/);
    expect(fs.readFileSync(path.join(dshHome, 'memory', 'global.md'), 'utf8')).toBe('host copy');
  });

  it('rejects traversal before any platform call', async () => {
    const tool = createMemoryWriteTool({ dshHome, globalMemoryWrite: 'platform', getClient: () => client(() => ({})) });
    await expect(tool.execute({ content: 'x', path: '../../escape.md' })).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('keeps space scope local in platform mode', async () => {
    const tool = createMemoryWriteTool({ dshHome, spacePath, globalMemoryWrite: 'platform', getClient: () => client(() => ({})) });
    const res = await tool.execute({ content: 'space fact', scope: 'space' });
    expect(res.scope).toBe('space');
    expect(fs.readFileSync(path.join(spacePath, 'memory', 'space.md'), 'utf8')).toBe('space fact');
    expect(calls.every((c) => c.path !== PLATFORM_MEMORY_WRITE_ROUTE)).toBe(true);
  });

  it('default local mode is unchanged: writes locally and only posts the audit call', async () => {
    const tool = createMemoryWriteTool({ dshHome, getClient: () => client(() => ({})) });
    const res = await tool.execute({ content: 'local', expectedEtag: etagOf('host copy') });
    expect(res.etag).toBe(etagOf('local'));
    expect(fs.readFileSync(path.join(dshHome, 'memory', 'global.md'), 'utf8')).toBe('local');
    expect(calls.map((c) => c.path)).toEqual(['/api/memory/write']);
    await expect(tool.execute({ content: 'again', expectedEtag: etagOf('host copy') })).rejects.toBeInstanceOf(MemoryWriteConflictError);
  });

  it('memory_read reads the (read-only) host-backed directory', async () => {
    fs.chmodSync(path.join(dshHome, 'memory'), 0o500);
    const read = createMemoryReadTool({ dshHome });
    const res: any = await read.execute({});
    expect(JSON.stringify(res)).toContain('host copy');
  });

  it('ensureGlobalMemorySkeleton tolerates a read-only memory directory', () => {
    fs.rmSync(path.join(dshHome, 'memory', 'global.md'));
    fs.chmodSync(path.join(dshHome, 'memory'), 0o500);
    if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root ignores modes
    expect(() => ensureGlobalMemorySkeleton(dshHome)).not.toThrow();
    expect(fs.existsSync(path.join(dshHome, 'memory', 'global.md'))).toBe(false);
  });
});

describe('applyMemoryWriteAtRoot', () => {
  let root: string;
  beforeEach(() => {
    root = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-mem-root-'))), 'memory');
    fs.mkdirSync(root);
  });
  afterEach(() => {
    fs.rmSync(path.dirname(root), { recursive: true, force: true });
  });

  it('applies overwrite/append with etag CAS', () => {
    const a = applyMemoryWriteAtRoot(root, 'global', { content: 'one' });
    expect(a).toMatchObject({ isNewFile: true, etag: etagOf('one'), path: 'global.md' });
    const b = applyMemoryWriteAtRoot(root, 'global', { content: 'two', mode: 'append', expectedEtag: a.etag });
    expect(fs.readFileSync(path.join(root, 'global.md'), 'utf8')).toBe('one\ntwo');
    expect(b.previousEtag).toBe(etagOf('one'));
    expect(() => applyMemoryWriteAtRoot(root, 'global', { content: 'three', expectedEtag: a.etag })).toThrow(MemoryWriteConflictError);
  });

  it('rejects symlinks under the root when asked to', () => {
    const outside = path.join(path.dirname(root), 'outside.md');
    fs.writeFileSync(outside, 'keep');
    fs.symlinkSync(outside, path.join(root, 'link.md'));
    expect(() => applyMemoryWriteAtRoot(root, 'global', { path: 'link.md', content: 'x' }, { rejectSymlinks: true })).toThrow(MemoryPathError);
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep');
  });
});
