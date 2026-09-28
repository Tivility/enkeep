/**
 * VirtualMountResolver & SpaceIsolatedFileSystem Functional Tests (G12-P1)
 *
 * Targeted functional tests verifying:
 * 1. Same-user sibling space resolved by controlplane assumed authorized: read accepted under broad spacesDir denied ancestor
 * 2. Own workspace write OK, sibling space write denied (read-only enforcement)
 * 3. Unrelated root deny: ungranted sibling space, system paths, and path-prefix collisions (/spaceA vs /spaceAB) denied
 * 4. Most-specific grant logic: absolute denied sensitive subtrees inside grant preserved (descendant deny)
 *
 * @module @enkeep/runtime-runner/tests/virtual-mount-resolver.test
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import {
  VirtualMountResolver,
  SpaceIsolatedFileSystem,
  isPathInside,
} from '../src/index.js';

describe('VirtualMountResolver Scoped Read-Only Extra Roots (G12-P1)', () => {
  let tmpBaseDir: string;
  let spacesDir: string;
  let ownSpaceDir: string;
  let siblingSpaceDir: string;
  let siblingSecretDir: string;
  let unrelatedSpaceDir: string;
  let prefixAttackDir: string;

  beforeEach(() => {
    tmpBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-g12-test-'));
    // Canonicalize base path to handle symlinks (e.g. /var vs /private/var on macOS)
    tmpBaseDir = fs.realpathSync(tmpBaseDir);

    spacesDir = path.join(tmpBaseDir, 'spaces');
    ownSpaceDir = path.join(spacesDir, 'space-a');
    siblingSpaceDir = path.join(spacesDir, 'space-b');
    siblingSecretDir = path.join(siblingSpaceDir, '.secret');
    unrelatedSpaceDir = path.join(spacesDir, 'space-c');
    prefixAttackDir = path.join(spacesDir, 'space-b-malicious');

    fs.mkdirSync(ownSpaceDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(siblingSpaceDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(siblingSecretDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(unrelatedSpaceDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(prefixAttackDir, { recursive: true, mode: 0o700 });

    // Seed test files
    fs.writeFileSync(path.join(ownSpaceDir, 'own.txt'), 'own space content');
    fs.writeFileSync(path.join(siblingSpaceDir, 'shared.txt'), 'sibling shared content');
    fs.writeFileSync(path.join(siblingSecretDir, 'keys.env'), 'SECRET_TOKEN=xyz');
    fs.writeFileSync(path.join(unrelatedSpaceDir, 'private.txt'), 'unrelated space content');
    fs.writeFileSync(path.join(prefixAttackDir, 'escape.txt'), 'prefix attack content');
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tmpBaseDir)) {
        fs.rmSync(tmpBaseDir, { recursive: true, force: true });
      }
    } catch {}
  });

  it('1. same-user root resolved by controlplane assumed authorized: read accepted under broad spacesDir denied ancestor', async () => {
    const ctx = new Context();
    const fsService = new SpaceIsolatedFileSystem(ctx, {
      cwd: ownSpaceDir,
      extraReadableRoots: [siblingSpaceDir],
    });

    // Sibling file under spacesDir (which is denied as parent of ownSpaceDir) should be read accepted
    const siblingFile = path.join(siblingSpaceDir, 'shared.txt');
    const target = await fsService.resolve(siblingFile);

    expect(target.displayPath).toBe(siblingFile);
    const content = await fsService.readText(target);
    expect(content).toBe('sibling shared content');

    // Unit check on VirtualMountResolver directly
    const resolver = new VirtualMountResolver(ownSpaceDir, [], {
      extraReadableRoots: [siblingSpaceDir],
    });
    const resolved = resolver.resolvePath(siblingFile);
    expect(resolved.isExtraRoot).toBe(true);
    expect(resolved.isWritableExtraRoot).toBe(false);
    expect(resolved.physicalPath).toBe(siblingFile);
  });

  it('2. own write OK, sibling write denied: writes remain in current workspace only', async () => {
    const ctx = new Context();
    const fsService = new SpaceIsolatedFileSystem(ctx, {
      cwd: ownSpaceDir,
      extraReadableRoots: [siblingSpaceDir],
    });

    // 2a. Own workspace write & edit succeed
    const ownTarget = await fsService.resolve(path.join(ownSpaceDir, 'new-file.txt'));
    await fsService.writeText(ownTarget, 'created in own workspace');
    expect(fs.readFileSync(path.join(ownSpaceDir, 'new-file.txt'), 'utf8')).toBe(
      'created in own workspace'
    );

    await fsService.editText(ownTarget, {
      oldString: 'created in own workspace',
      newString: 'edited in own workspace',
      replaceAll: false,
    });
    expect(fs.readFileSync(path.join(ownSpaceDir, 'new-file.txt'), 'utf8')).toBe(
      'edited in own workspace'
    );

    // 2b. Sibling space write & edit are strictly rejected with FS_SANDBOX_DENIED
    const siblingFile = path.join(siblingSpaceDir, 'shared.txt');
    const siblingTarget = await fsService.resolve(siblingFile);

    await expect(fsService.writeText(siblingTarget, 'malicious write')).rejects.toThrow(
      /Access denied: cannot write to read-only root/
    );

    await expect(
      fsService.editText(siblingTarget, {
        oldString: 'sibling shared content',
        newString: 'tampered content',
        replaceAll: false,
      })
    ).rejects.toThrow(/Access denied: cannot edit file in read-only root/);

    // Ensure sibling file was untouched
    expect(fs.readFileSync(siblingFile, 'utf8')).toBe('sibling shared content');
  });

  it('3. unrelated root and pathprefix collision denied', async () => {
    const ctx = new Context();
    const fsService = new SpaceIsolatedFileSystem(ctx, {
      cwd: ownSpaceDir,
      extraReadableRoots: [siblingSpaceDir],
    });

    // 3a. Ungranted sibling space under same spacesDir is denied
    const unrelatedFile = path.join(unrelatedSpaceDir, 'private.txt');
    await expect(fsService.resolve(unrelatedFile)).rejects.toThrow(/Access denied.*resolves outside space boundary/);

    // 3b. Unrelated system path is denied
    await expect(fsService.resolve('/etc/passwd')).rejects.toThrow(/Access denied.*resolves outside space boundary/);

    // 3c. Narrow semantics: path prefix collision (/space-b vs /space-b-malicious) must NOT grant access
    const prefixFile = path.join(prefixAttackDir, 'escape.txt');
    await expect(fsService.resolve(prefixFile)).rejects.toThrow(/Access denied.*resolves outside space boundary/);

    // Verify isPathInside boundary helper
    expect(isPathInside(prefixAttackDir, siblingSpaceDir)).toBe(false);
    expect(isPathInside(path.join(siblingSpaceDir, 'sub'), siblingSpaceDir)).toBe(true);
  });

  it('4. most-specific grant logic preserves absolute descendant deny inside grant', async () => {
    // Sibling space is granted RO, but .secret inside sibling space is explicitly denied
    const ctx = new Context();
    const resolver = new VirtualMountResolver(ownSpaceDir, [], {
      extraReadableRoots: [siblingSpaceDir],
      deniedRoots: [siblingSecretDir],
    });

    // Public sibling file is allowed RO
    const publicTarget = resolver.resolvePath(path.join(siblingSpaceDir, 'shared.txt'));
    expect(publicTarget.isExtraRoot).toBe(true);
    expect(publicTarget.isWritableExtraRoot).toBe(false);

    // Descendant deny inside grant is strictly denied
    const secretFile = path.join(siblingSecretDir, 'keys.env');
    expect(() => resolver.resolvePath(secretFile)).toThrow(/Access denied.*resolves outside space boundary/);

    // Dangling / missing file in descendant deny is also denied
    const missingSecret = path.join(siblingSecretDir, 'nonexistent.txt');
    expect(() => resolver.resolvePath(missingSecret)).toThrow(/Access denied/);
  });
});
