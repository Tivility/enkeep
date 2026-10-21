import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { guardStdioAgainstBrokenPipe } from '../src/runtime/daemon-cli.js';

const epipe = () => Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });

describe('daemon stdio after the spawning platform exits', () => {
  it('an EPIPE on an unguarded stream is fatal (the failure being prevented)', () => {
    const stream = new PassThrough();
    expect(() => stream.emit('error', epipe())).toThrow('EPIPE');
  });

  it('guarded stdout/stderr swallow EPIPE so the daemon keeps running', () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    guardStdioAgainstBrokenPipe([stdout, stderr]);
    expect(() => stdout.emit('error', epipe())).not.toThrow();
    expect(() => stderr.emit('error', epipe())).not.toThrow();
  });
});
