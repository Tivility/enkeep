/**
 * After a deployment's data directory moves and a symlink is left at the old path, sessions that
 * recorded the old path keep working: the old path resolves inside the (new) space boundary, and a
 * path that leaves the space is still denied.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VirtualMountResolver } from '../src/runtime/virtual-mount-resolver.js';

describe('space paths through a moved data directory', () => {
  let root: string;
  let oldData: string;
  let newSpace: string;
  let oldSpace: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-moved-data-')));
    const newData = path.join(root, 'share', 'data');
    newSpace = path.join(newData, 'host-runtimes', 'alice', 'spaces', 'main');
    fs.mkdirSync(newSpace, { recursive: true });
    fs.writeFileSync(path.join(newSpace, 'notes.txt'), 'hello');
    fs.mkdirSync(path.join(newData, 'host-runtimes', 'alice', 'spaces', 'other'), { recursive: true });
    oldData = path.join(root, 'checkout', '.demo-data');
    fs.mkdirSync(path.dirname(oldData), { recursive: true });
    fs.symlinkSync(newData, oldData);
    oldSpace = path.join(oldData, 'host-runtimes', 'alice', 'spaces', 'main');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('resolves files of an old session (old cwd) inside the new space', () => {
    const resolver = new VirtualMountResolver(newSpace, []);
    const relative = resolver.resolvePath('notes.txt', oldSpace);
    expect(relative.physicalPath).toBe(path.join(newSpace, 'notes.txt'));
    const absolute = resolver.resolvePath(path.join(oldSpace, 'notes.txt'), oldSpace);
    expect(absolute.physicalPath).toBe(path.join(newSpace, 'notes.txt'));
    const created = resolver.resolvePath(path.join(oldSpace, 'new-file.txt'), oldSpace);
    expect(created.physicalPath).toBe(path.join(newSpace, 'new-file.txt'));
  });

  it('still denies another space reached through the old path', () => {
    const resolver = new VirtualMountResolver(newSpace, []);
    const sibling = path.join(oldData, 'host-runtimes', 'alice', 'spaces', 'other');
    expect(() => resolver.resolvePath(path.join(sibling, 'x.txt'), oldSpace)).toThrow(/outside space boundary/);
  });

  it('accepts the new path when the space was configured on the old one', () => {
    const resolver = new VirtualMountResolver(oldSpace, []);
    expect(resolver.resolvePath(path.join(newSpace, 'notes.txt')).physicalPath).toBe(path.join(newSpace, 'notes.txt'));
  });
});
