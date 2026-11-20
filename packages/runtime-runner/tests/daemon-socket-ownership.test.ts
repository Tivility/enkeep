import { describe, it, expect } from 'vitest';
import { closeSync, mkdtempSync, openSync, writeFileSync, statSync, existsSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeOwnSocket } from '../src/runtime/daemon-cli.js';

describe('daemon socket cleanup on shutdown', () => {
  it('leaves a socket path that a newer daemon has re-bound, and removes its own', () => {
    const dir = mkdtempSync(join(tmpdir(), 'enkeep-test-sock-'));
    const path = join(dir, 'daemon.sock');
    try {
      writeFileSync(path, 'old');
      const oldIno = statSync(path).ino;
      // The old daemon still holds its socket while a newer one re-binds the path, so the
      // old inode cannot be freed and reused yet. Keep it referenced the same way here:
      // without a holder, filesystems such as ext4 hand the freed inode straight back.
      const oldHolder = openSync(path, 'r');
      unlinkSync(path);
      writeFileSync(path, 'new');
      const newIno = statSync(path).ino;
      closeSync(oldHolder);
      expect(newIno).not.toBe(oldIno);

      removeOwnSocket(path, oldIno);
      expect(existsSync(path)).toBe(true);

      removeOwnSocket(path, newIno);
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
