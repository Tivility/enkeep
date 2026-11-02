/**
 * The demo-runner runtime ports pass the per-user `userQuestions` option into the runtime spec
 * (ENKEEP_USER_QUESTIONS in the container / host daemon env), and leave it unset otherwise so the
 * platform process's ENKEEP_USER_QUESTIONS applies. Offline: a fake Docker client that stops the
 * start right after the spec is built, and a fake host adapter.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DockerRuntimeAdapter } from '@enkeep/runtime-runner';
import { DockerRuntimeContainerAdapter, HostRuntimePortAdapter } from '../src/ports/index.js';
import { createTempRepo, type TempRepo } from './support/temp-repo.js';

const STOP = Object.assign(new Error('synthetic stop after spec'), { code: 'SYNTHETIC_STOP' });

/** A Docker client that is "available", has no containers, and refuses everything else. */
function fakeDockerClient(): any {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'isDockerAvailable') return async () => true;
        if (prop === 'inspectContainer') return async () => null;
        if (prop === 'then') return undefined;
        return async () => {
          throw STOP;
        };
      },
    }
  );
}

describe('runtime ports: userQuestions option', () => {
  let tempRepo: TempRepo;
  const savedGate = process.env.ENKEEP_USER_QUESTIONS;

  beforeEach(() => {
    tempRepo = createTempRepo();
    delete process.env.ENKEEP_USER_QUESTIONS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedGate === undefined) delete process.env.ENKEEP_USER_QUESTIONS;
    else process.env.ENKEEP_USER_QUESTIONS = savedGate;
    tempRepo.cleanup();
  });

  it('container: userQuestions true puts ENKEEP_USER_QUESTIONS=1 in the spec; unset leaves it out', async () => {
    const specs: any[] = [];
    const original = DockerRuntimeAdapter.prototype.createDefaultUserSpec;
    vi.spyOn(DockerRuntimeAdapter.prototype, 'createDefaultUserSpec').mockImplementation(function (this: DockerRuntimeAdapter, options) {
      const spec = original.call(this, options);
      specs.push({ options, spec });
      return spec;
    });
    const port = new DockerRuntimeContainerAdapter(fakeDockerClient());

    await expect(
      port.startUserRuntime({ userId: 'alice', repoRoot: tempRepo.repoRoot, mode: 'test', userQuestions: true, llmEnabled: false })
    ).rejects.toBeTruthy();
    const final = specs.at(-1)!;
    expect(final.options.userQuestions).toBe(true);
    expect(final.spec.environment.ENKEEP_USER_QUESTIONS).toBe('1');

    specs.length = 0;
    await expect(port.startUserRuntime({ userId: 'bob', repoRoot: tempRepo.repoRoot, mode: 'test', llmEnabled: false })).rejects.toBeTruthy();
    expect('userQuestions' in specs.at(-1)!.options).toBe(false);
    expect(specs.at(-1)!.spec.environment.ENKEEP_USER_QUESTIONS).toBeUndefined();
  });

  it('host: the option reaches the host runtime spec only when set', async () => {
    const seen: any[] = [];
    const fakeHostAdapter: any = {
      createDefaultUserSpec: (options: any) => {
        seen.push(options);
        return { userId: options.userId };
      },
      startRuntime: async () => {
        throw STOP;
      },
    };
    const port = new HostRuntimePortAdapter(fakeHostAdapter);
    await expect(port.startUserRuntime({ userId: 'alice', repoRoot: tempRepo.repoRoot, mode: 'test', userQuestions: true, llmEnabled: false })).rejects.toBe(STOP);
    await expect(port.startUserRuntime({ userId: 'bob', repoRoot: tempRepo.repoRoot, mode: 'test', llmEnabled: false })).rejects.toBe(STOP);
    expect(seen[0]).toMatchObject({ userId: 'alice', userQuestions: true });
    expect('userQuestions' in seen[1]).toBe(false);
  });
});
