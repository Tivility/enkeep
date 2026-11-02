/**
 * Real Docker round trip for user asset mounts and the kill switch.
 *
 * Runs only with ENKEEP_DOCKER_ACCEPTANCE=1 (excluded from the unit `test` script by the
 * `*docker*` pattern). Uses a throwaway temp repo, a random resource suffix, and removes the
 * container and volume it created. Image: ENKEEP_RUNTIME_IMAGE (default enkeep-demo-runtime:acceptance).
 *
 * on (new volume, mounts) -> start again (reconnect, mounts kept) -> kill switch (still mounted,
 * flagged for rebuild, write route kept) -> rebuild (no mounts; daemon boot removes Docker's
 * root-owned empty mountpoints) -> uid 1000 writes global memory locally.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as runtimeRunner from '@enkeep/runtime-runner';
import { DockerRuntimeContainerAdapter, type UserRuntimeHandle } from '../src/ports/index.js';
import { getDemoPathConfig } from '../src/config.js';
import { hostMemoryRootForBinding, readMigrationMarker } from '../src/user-assets/index.js';
import { createTempRepo, type TempRepo } from './support/temp-repo.js';

const enabled = process.env.ENKEEP_DOCKER_ACCEPTANCE === '1';
const image = process.env.ENKEEP_RUNTIME_IMAGE?.trim() || 'enkeep-demo-runtime:acceptance';

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function inContainer(containerId: string, script: string): any {
  const out = docker(['exec', '-i', containerId, 'node', '-e', script]);
  return JSON.parse(out.trim().split('\n').pop()!);
}

const STAT_SCRIPT = `
const fs = require('fs');
const out = {};
for (const n of ['memory', 'skills', 'AGENTS.md']) {
  try { const s = fs.lstatSync('/home/dsh/.dsh/' + n); out[n] = { uid: s.uid, dir: s.isDirectory(), size: s.size }; }
  catch (e) { out[n] = e.code; }
}
const mi = fs.readFileSync('/proc/self/mountinfo', 'utf8');
out.mounted = ['memory', 'skills', 'AGENTS.md'].filter((n) => mi.includes(' /home/dsh/.dsh/' + n + ' '));
console.log(JSON.stringify(out));
`;

// Local global write through the same dsh-memory code the runtime uses (uid 1000, not via the platform).
const WRITE_SCRIPT = `
(async () => {
  const fs = require('fs');
  const { createMemoryWriteTool } = await import('/app/runtime-runner/node_modules/@enkeep/dsh-memory/dist/index.js');
  const tool = createMemoryWriteTool({ dshHome: '/home/dsh/.dsh' });
  try {
    const r = await tool.execute({ content: 'written after rollback\\n' });
    const s = fs.statSync('/home/dsh/.dsh/memory/global.md');
    console.log(JSON.stringify({ ok: true, success: r.success, uid: s.uid, text: fs.readFileSync('/home/dsh/.dsh/memory/global.md', 'utf8') }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
  }
})();
`;

const READ_ONLY_PROBE = `
const fs = require('fs');
let write;
try { fs.writeFileSync('/home/dsh/.dsh/memory/global.md', 'x'); write = 'ok'; } catch (e) { write = e.code; }
console.log(JSON.stringify({ text: fs.readFileSync('/home/dsh/.dsh/memory/global.md', 'utf8'), write }));
`;

describe.skipIf(!enabled)('user assets: real Docker kill switch round trip', () => {
  let tempRepo: TempRepo | null = null;
  let lastHandle: UserRuntimeHandle | null = null;
  const savedEnv = process.env.ENKEEP_USER_ASSET_MOUNTS;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (savedEnv === undefined) delete process.env.ENKEEP_USER_ASSET_MOUNTS;
    else process.env.ENKEEP_USER_ASSET_MOUNTS = savedEnv;
    if (lastHandle) {
      await lastHandle.teardown(true); // remove the throwaway container AND volume
      lastHandle = null;
    }
    tempRepo?.cleanup();
    tempRepo = null;
  });

  it('on -> off -> rebuild -> write', async () => {
    // Hermetic: never read the operator's DSH deployment config (LLM is off in this test)
    vi.spyOn(runtimeRunner, 'loadDshDeploymentConfig').mockReturnValue(null as any);
    tempRepo = createTempRepo();
    const resourceSuffix = randomUUID().replace(/-/g, '').slice(0, 12);
    const dataRoot = getDemoPathConfig({ repoRoot: tempRepo.repoRoot, resourceSuffix }).dataRoot;
    const hostHome = join(dataRoot, 'host-runtimes', 'alice', '.dsh');
    mkdirSync(join(hostHome, 'memory'), { recursive: true, mode: 0o700 });
    writeFileSync(join(hostHome, 'memory', 'global.md'), 'host copy\n', { mode: 0o600 });
    writeFileSync(join(hostHome, 'AGENTS.md'), '# host instructions\n', { mode: 0o600 });

    const identity = 'alice_0a1b2c3d';
    const adapter = new DockerRuntimeContainerAdapter();
    const start = async () => {
      lastHandle = await adapter.startUserRuntime({
        userId: identity,
        username: 'alice',
        image,
        repoRoot: tempRepo!.repoRoot,
        resourceSuffix,
        llmEnabled: false,
        timeoutMs: 60_000,
      });
      return lastHandle;
    };

    // 1. on: new volume, three read-only mounts, marker persisted
    const on = await start();
    expect(on.rawHandle?.userAssetMounts?.map((m) => m.kind).sort()).toEqual(['agents_md', 'memory', 'skills']);
    const volumeName = `enkeep-demo-dsh-${identity}-${resourceSuffix}`;
    expect(readMigrationMarker(dataRoot, volumeName)).toMatchObject({ status: 'converged', origin: 'new_volume' });
    expect(inContainer(on.containerId!, READ_ONLY_PROBE)).toEqual({ text: 'host copy\n', write: 'EROFS' });

    // 2. restart (reconnect): mounts kept, nothing pending
    const again = await start();
    expect(again.rawHandle?.userAssetMounts?.length).toBe(3);
    expect(again.rawHandle?.userAssetMountsPending).toBe(false);

    // 3. kill switch: the running container keeps mounts and its write route, flagged for rebuild
    process.env.ENKEEP_USER_ASSET_MOUNTS = '0';
    const off = await start();
    expect(off.rawHandle?.userAssetMounts?.length).toBe(3);
    expect(off.rawHandle?.userAssetMountsPending).toBe(true);
    expect(hostMemoryRootForBinding(off)).toBe(join(hostHome, 'memory'));

    // 4. rebuild (what the idle AutoUpgrader does): container replaced, volume kept
    await off.teardown(false);
    lastHandle = null;
    const rebuilt = await start();
    expect(rebuilt.rawHandle?.userAssetMounts ?? []).toEqual([]);
    expect(hostMemoryRootForBinding(rebuilt)).toBeUndefined();
    const st = inContainer(rebuilt.containerId!, STAT_SCRIPT);
    expect(st.mounted).toEqual([]);
    // Docker's empty root-owned mountpoints were removed at daemon boot
    expect(st.memory).toBe('ENOENT');
    expect(st.skills).toBe('ENOENT');
    expect(st['AGENTS.md']).toBe('ENOENT');

    // 5. write: uid 1000 creates and writes its own global memory again
    const w = inContainer(rebuilt.containerId!, WRITE_SCRIPT);
    expect(w).toMatchObject({ ok: true, success: true, uid: 1000, text: 'written after rollback\n' });
    // host copy untouched
    expect(docker(['inspect', '--format', '{{json .Mounts}}', rebuilt.containerId!])).not.toContain('host-runtimes');
  }, 240_000);
});
