import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, statSync, existsSync, unlinkSync, rmSync } from 'node:fs';
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
      unlinkSync(path);
      writeFileSync(path, 'new');
      const newIno = statSync(path).ino;
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
