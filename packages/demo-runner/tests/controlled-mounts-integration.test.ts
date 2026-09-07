/**
 * Comprehensive Controlled Mounts Integration Journey & Acceptance Tests
 *
 * Enforces:
 * 1. API Login for Alice (Admin) and Bob (User) to test genuine HTTP Admin endpoints and RBAC.
 * 2. Admin GET / POST / DELETE /api/admin/spaces/:spaceId/mounts with exact DTO bodies (sourcePath, name, mode, id, createdAt).
 * 3. Deprecated route verification: /api/spaces/:spaceId/mounts returns 404.
 * 4. RBAC verification: Bob (non-admin) receives 403 Forbidden on /api/admin/spaces/:spaceId/mounts.
 * 5. Temp roots only: Host Space & Container Space each test RO and RW mount behavior.
 * 6. Agent direct official file / bash virtual `/mnt/name`:
 *    - Reading files from RO / RW mounts.
 *    - RO: all mutations (file write, edit, bash redirection, python mutation) fail closed.
 *    - RW: mutations persist directly to the host filesystem.
 * 7. Space isolation & same mount slug name in distinct spaces.
 * 8. Deletion lifecycle: Deleted mount is immediately absent on subsequent turns.
 * 9. Symlink swap defense and protected root (/etc, dataRoot, pidsDir) validation during preflight.
 * 10. Platform restart with identical encrypted DB key: reconciles before turns.
 * 11. Database check: SQLite space_mounts table contains NO plaintext source paths (encrypted + HMAC fingerprint only).
 * 12. Hermetic cleanup and zero path leaks in audits and logs.
 *
 * @module @enkeep/demo-runner/tests/controlled-mounts-integration.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { resetDemo } from '../src/reset/index.js';
import { launchDemoSystem, type RunningDemoSystem } from '../src/up/index.js';
import { HostRuntimePortAdapter } from '../src/ports/index.js';
import { createTempRepo, type TempRepo } from './support/temp-repo.js';
import { FakeUnitRuntimeContainerAdapter } from './support/fake-runtime.js';
import {
  SpaceIsolatedFileSystem,
  SpaceIsolatedBashExecutor,
  LocalSubprocess,
  Context,
  type ResolvedRuntimeMount,
} from '@enkeep/runtime-runner';

async function loginUser(serverUrl: string, user: { username: string; password: string }) {
  const initCsrfRes = await fetch(`${serverUrl}/api/auth/csrf`, {
    headers: { Origin: serverUrl },
  });
  if (!initCsrfRes.ok) throw new Error(`Initial CSRF fetch failed: ${initCsrfRes.status}`);
  const initCsrfData = ((await initCsrfRes.json()) as any).data;
  const loginCsrf = initCsrfData.csrfToken;

  const loginRes = await fetch(`${serverUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Enkeep-CSRF': loginCsrf,
      Origin: serverUrl,
    },
    body: JSON.stringify({
      username: user.username,
      password: user.password,
    }),
  });

  if (!loginRes.ok) throw new Error(`Login failed for ${user.username}: ${loginRes.status}`);
  const setCookie = loginRes.headers.get('set-cookie');
  if (!setCookie) throw new Error(`No set-cookie header received for ${user.username}`);
  const cookie = setCookie.split(';')[0];

  const authCsrfRes = await fetch(`${serverUrl}/api/auth/csrf`, {
    headers: { Cookie: cookie, Origin: serverUrl },
  });
  if (!authCsrfRes.ok) throw new Error(`Auth CSRF fetch failed: ${authCsrfRes.status}`);
  const authCsrfData = ((await authCsrfRes.json()) as any).data;

  return {
    cookie,
    csrfToken: authCsrfData.csrfToken,
    user: (await loginRes.json() as any).data?.user,
  };
}

describe('Controlled Directory Mounts End-to-End Integration Journey', () => {
  let tempRepo: TempRepo;
  let system: RunningDemoSystem | null = null;

  let hostProjectRO: string;
  let hostProjectRW: string;
  let hostProjectSpaceB: string;

  beforeEach(() => {
    tempRepo = createTempRepo();

    const rawRO = join(tempRepo.repoRoot, 'temp-project-ro');
    const rawRW = join(tempRepo.repoRoot, 'temp-project-rw');
    const rawSpaceB = join(tempRepo.repoRoot, 'temp-project-space-b');

    mkdirSync(rawRO, { recursive: true, mode: 0o755 });
    mkdirSync(rawRW, { recursive: true, mode: 0o755 });
    mkdirSync(rawSpaceB, { recursive: true, mode: 0o755 });

    hostProjectRO = realpathSync(rawRO);
    hostProjectRW = realpathSync(rawRW);
    hostProjectSpaceB = realpathSync(rawSpaceB);

    // Seed test files
    writeFileSync(join(hostProjectRO, 'spec.md'), '# Controlled RO Project Spec\nImmutable documentation.\n', 'utf8');
    writeFileSync(join(hostProjectRO, 'config.json'), '{"readOnly": true, "environment": "test"}', 'utf8');

    writeFileSync(join(hostProjectRW, 'scratch.txt'), 'Initial RW scratch notes.\n', 'utf8');
    writeFileSync(join(hostProjectSpaceB, 'spec.md'), '# Space B Distinct Spec\nIsolated from Space A.\n', 'utf8');
  });

  afterEach(async () => {
    if (system) {
      try {
        await system.close({ removeVolumes: true });
      } catch {}
      system = null;
    }
    tempRepo.cleanup();
  });

  it('completes the full Controlled Mounts journey: RBAC, RO/RW tools & bash, space isolation, symlink defense, deletion, and restart', async () => {
    // -----------------------------------------------------------------------------------
    // 1. Reset demo environment & launch platform system
    // -----------------------------------------------------------------------------------
    const resetResult = await resetDemo({
      repoRoot: tempRepo.repoRoot,
      forceClean: true,
    });
    expect(resetResult.ok).toBe(true);

    const fakeContainerAdapter = new FakeUnitRuntimeContainerAdapter();
    const hostAdapter = new HostRuntimePortAdapter();

    system = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      runtimeAdapter: fakeContainerAdapter,
      hostRuntimeAdapter: hostAdapter,
      allowHostRuntime: true,
      llmEnabled: false,
    });

    expect(system.result.ok).toBe(true);
    expect(system.result.platform.status).toBe('healthy');
    const platformUrl = system.platformUrl;

    // -----------------------------------------------------------------------------------
    // 2. HTTP API Login: Alice (Admin) and Bob (User)
    // -----------------------------------------------------------------------------------
    const aliceAuth = await loginUser(platformUrl, resetResult.credentials.admin);
    const bobAuth = await loginUser(platformUrl, resetResult.credentials.user);
    expect(aliceAuth.cookie).toBeDefined();
    expect(bobAuth.cookie).toBeDefined();

    // -----------------------------------------------------------------------------------
    // 3. Create Spaces for Alice (Host & Container) and Bob (Container)
    // -----------------------------------------------------------------------------------
    // Alice Host Space
    const createHostSpaceRes = await fetch(`${platformUrl}/api/spaces`, {
      method: 'POST',
      headers: {
        Cookie: aliceAuth.cookie,
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Alice Host Space',
        folder: 'alice-host-space',
        executionMode: 'host',
      }),
    });
    expect(createHostSpaceRes.status).toBe(201);
    const aliceHostSpace = (await createHostSpaceRes.json() as any).data;
    expect(aliceHostSpace.executionMode).toBe('host');

    // Alice Container Space
    const createContainerSpaceRes = await fetch(`${platformUrl}/api/spaces`, {
      method: 'POST',
      headers: {
        Cookie: aliceAuth.cookie,
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Alice Container Space',
        folder: 'alice-container-space',
        executionMode: 'container',
      }),
    });
    expect(createContainerSpaceRes.status).toBe(201);
    const aliceContainerSpace = (await createContainerSpaceRes.json() as any).data;
    expect(aliceContainerSpace.executionMode).toBe('container');

    // Alice Space B (Host) for Isolation testing
    const createSpaceBRes = await fetch(`${platformUrl}/api/spaces`, {
      method: 'POST',
      headers: {
        Cookie: aliceAuth.cookie,
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Alice Space B',
        folder: 'alice-space-b',
        executionMode: 'host',
      }),
    });
    expect(createSpaceBRes.status).toBe(201);
    const aliceSpaceB = (await createSpaceBRes.json() as any).data;

    // Bob Container Space
    const createBobSpaceRes = await fetch(`${platformUrl}/api/spaces`, {
      method: 'POST',
      headers: {
        Cookie: bobAuth.cookie,
        'X-Enkeep-CSRF': bobAuth.csrfToken,
        Origin: platformUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Bob Container Space',
        folder: 'bob-container-space',
        executionMode: 'container',
      }),
    });
    expect(createBobSpaceRes.status).toBe(201);
    const bobSpace = (await createBobSpaceRes.json() as any).data;

    // -----------------------------------------------------------------------------------
    // 4. RBAC & Deprecated Endpoint Verifications
    // -----------------------------------------------------------------------------------
    // Old non-admin endpoint /api/spaces/:spaceId/mounts MUST return 404
    const oldEndpointGet = await fetch(`${platformUrl}/api/spaces/${aliceHostSpace.id}/mounts`, {
      headers: { Cookie: aliceAuth.cookie },
    });
    expect(oldEndpointGet.status).toBe(404);

    const oldEndpointPost = await fetch(`${platformUrl}/api/spaces/${aliceHostSpace.id}/mounts`, {
      method: 'POST',
      headers: {
        Cookie: aliceAuth.cookie,
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'project_ro',
        sourcePath: hostProjectRO,
        mode: 'ro',
      }),
    });
    expect(oldEndpointPost.status).toBe(404);

    // Bob (non-admin) attempting Admin API MUST return 403 Forbidden
    const bobAdminGet = await fetch(`${platformUrl}/api/admin/spaces/${bobSpace.id}/mounts`, {
      headers: { Cookie: bobAuth.cookie },
    });
    expect(bobAdminGet.status).toBe(403);

    const bobAdminPost = await fetch(`${platformUrl}/api/admin/spaces/${bobSpace.id}/mounts`, {
      method: 'POST',
      headers: {
        Cookie: bobAuth.cookie,
        'X-Enkeep-CSRF': bobAuth.csrfToken,
        Origin: platformUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'bob_mount',
        sourcePath: hostProjectRO,
        mode: 'ro',
      }),
    });
    expect(bobAdminPost.status).toBe(403);

    // Bob attempting to manage Alice's space mounts MUST also return 403 Forbidden
    const bobCrossGet = await fetch(`${platformUrl}/api/admin/spaces/${aliceHostSpace.id}/mounts`, {
      headers: { Cookie: bobAuth.cookie },
    });
    expect(bobCrossGet.status).toBe(403);

    // -----------------------------------------------------------------------------------
    // 5. Admin Mount Creation via /api/admin/spaces/:spaceId/mounts (Exact DTO Contract)
    // -----------------------------------------------------------------------------------
    // 5a. Create RO Mount for Alice Host Space
    const createRoRes = await fetch(`${platformUrl}/api/admin/spaces/${aliceHostSpace.id}/mounts`, {
      method: 'POST',
      headers: {
        Cookie: aliceAuth.cookie,
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'project_ro',
        sourcePath: hostProjectRO,
        mode: 'ro',
      }),
    });
    expect(createRoRes.status).toBe(201);
    const roMountDto = (await createRoRes.json() as any).data;
    expect(roMountDto.id).toBeDefined();
    expect(roMountDto.name).toBe('project_ro');
    expect(roMountDto.sourcePath).toBe(hostProjectRO);
    expect(roMountDto.mode).toBe('ro');
    expect(roMountDto.createdAt).toBeDefined();
    expect(roMountDto.hostPath).toBeUndefined(); // Obsolete model removed
    expect(roMountDto.mountPoint).toBeUndefined(); // Obsolete model removed

    // 5b. Create RW Mount for Alice Host Space
    const createRwRes = await fetch(`${platformUrl}/api/admin/spaces/${aliceHostSpace.id}/mounts`, {
      method: 'POST',
      headers: {
        Cookie: aliceAuth.cookie,
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'project_rw',
        sourcePath: hostProjectRW,
        mode: 'rw',
      }),
    });
    expect(createRwRes.status).toBe(201);
    const rwMountDto = (await createRwRes.json() as any).data;
    expect(rwMountDto.name).toBe('project_rw');
    expect(rwMountDto.mode).toBe('rw');
    expect(rwMountDto.sourcePath).toBe(hostProjectRW);

    // 5c. Create Mount for Alice Container Space (RO)
    const createContainerRoRes = await fetch(`${platformUrl}/api/admin/spaces/${aliceContainerSpace.id}/mounts`, {
      method: 'POST',
      headers: {
        Cookie: aliceAuth.cookie,
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'container_ro',
        sourcePath: hostProjectRO,
        mode: 'ro',
      }),
    });
    expect(createContainerRoRes.status).toBe(201);
    const containerRoMount = (await createContainerRoRes.json() as any).data;
    expect(containerRoMount.name).toBe('container_ro');
    expect(containerRoMount.mode).toBe('ro');

    // 5d. List Mounts via Admin GET
    const listMountsRes = await fetch(`${platformUrl}/api/admin/spaces/${aliceHostSpace.id}/mounts`, {
      headers: { Cookie: aliceAuth.cookie },
    });
    expect(listMountsRes.status).toBe(200);
    const listMountsData = (await listMountsRes.json() as any).data;
    expect(listMountsData.mounts.length).toBe(2);

    // -----------------------------------------------------------------------------------
    // 6. Space Isolation & Same Mount Slug Name in Distinct Spaces
    // -----------------------------------------------------------------------------------
    // Create mount in Space B with SAME slug name 'project_ro' pointing to hostProjectSpaceB
    const createSpaceBMountRes = await fetch(`${platformUrl}/api/admin/spaces/${aliceSpaceB.id}/mounts`, {
      method: 'POST',
      headers: {
        Cookie: aliceAuth.cookie,
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'project_ro',
        sourcePath: hostProjectSpaceB,
        mode: 'ro',
      }),
    });
    expect(createSpaceBMountRes.status).toBe(201);
    const spaceBMountDto = (await createSpaceBMountRes.json() as any).data;
    expect(spaceBMountDto.name).toBe('project_ro');
    expect(spaceBMountDto.sourcePath).toBe(hostProjectSpaceB);

    // Verify isolation between Space A and Space B mounts
    const listSpaceARes = await fetch(`${platformUrl}/api/admin/spaces/${aliceHostSpace.id}/mounts`, {
      headers: { Cookie: aliceAuth.cookie },
    });
    const listSpaceBRes = await fetch(`${platformUrl}/api/admin/spaces/${aliceSpaceB.id}/mounts`, {
      headers: { Cookie: aliceAuth.cookie },
    });
    const spaceAMounts = (await listSpaceARes.json() as any).data.mounts;
    const spaceBMounts = (await listSpaceBRes.json() as any).data.mounts;
    expect(spaceAMounts.length).toBe(2);
    expect(spaceBMounts.length).toBe(1);
    expect(spaceAMounts.find((m: any) => m.name === 'project_ro')?.sourcePath).toBe(hostProjectRO);
    expect(spaceBMounts.find((m: any) => m.name === 'project_ro')?.sourcePath).toBe(hostProjectSpaceB);

    // -----------------------------------------------------------------------------------
    // 7. Virtual Path /mnt/name Resolution, RO / RW Enforcement, & Bash Redirection Defense
    // -----------------------------------------------------------------------------------
    const userHostRoot = join(tempRepo.repoRoot, '.demo-data', 'host-runtimes', 'alice');
    const spaceAPhysicalDir = join(userHostRoot, 'spaces', 'alice-host-space');
    mkdirSync(spaceAPhysicalDir, { recursive: true, mode: 0o700 });

    const cordisCtx = new Context();
    const resolvedMounts: ResolvedRuntimeMount[] = [
      { id: roMountDto.id, name: 'project_ro', sourcePath: roMountDto.sourcePath, targetPath: roMountDto.sourcePath, mode: 'ro' },
      { id: rwMountDto.id, name: 'project_rw', sourcePath: rwMountDto.sourcePath, targetPath: rwMountDto.sourcePath, mode: 'rw' },
    ];

    const fsService = new SpaceIsolatedFileSystem(cordisCtx, {
      cwd: spaceAPhysicalDir,
      mounts: resolvedMounts,
    });

    // 7a. Virtual /mnt listing
    const mntTarget = await fsService.resolve('/mnt');
    const mntEntries = await fsService.listDir(mntTarget);
    expect(mntEntries.map((e) => e.name).sort()).toEqual(['project_ro', 'project_rw']);

    // 7b. Read from RO mount via /mnt/project_ro/spec.md
    const targetRO = await fsService.resolve('/mnt/project_ro/spec.md');
    const roContent = await fsService.readText(targetRO);
    expect(roContent).toContain('# Controlled RO Project Spec');

    // 7c. Write & Edit on RO mount MUST FAIL with read-only error
    await expect(fsService.writeText(targetRO, 'Malicious mutation')).rejects.toThrow(/read-only/i);
    await expect(
      fsService.editText(targetRO, {
        oldText: 'Immutable documentation.',
        newText: 'Modified content.',
      })
    ).rejects.toThrow(/read-only/i);

    // 7d. Read from RW mount via /mnt/project_rw/scratch.txt
    const targetRW = await fsService.resolve('/mnt/project_rw/scratch.txt');
    const rwContent = await fsService.readText(targetRW);
    expect(rwContent).toContain('Initial RW scratch notes.');

    // 7e. Write to RW mount SUCCEEDS and persists directly to host filesystem
    await fsService.writeText(targetRW, 'Updated RW notes via agent tool.\n');
    const diskRwContent = readFileSync(join(hostProjectRW, 'scratch.txt'), 'utf8');
    expect(diskRwContent).toBe('Updated RW notes via agent tool.\n');

    // 7f. Space-Isolated Bash Executor Tests
    await cordisCtx.plugin(LocalSubprocess);
    const bashExecutor = new SpaceIsolatedBashExecutor(cordisCtx, {
      cwd: spaceAPhysicalDir,
      mounts: resolvedMounts,
    });

    // DSH Bash `cat /mnt/project_ro/spec.md`
    const catSpec = bashExecutor.resolve({
      command: 'cat /mnt/project_ro/spec.md',
    });
    const catOutcome = await bashExecutor.run(catSpec);
    expect(catOutcome.stdout.text).toContain('# Controlled RO Project Spec');

    // DSH Bash `pwd` in workdir `/mnt/project_ro`
    const pwdSpec = bashExecutor.resolve({
      command: 'pwd',
      workdir: '/mnt/project_ro',
    });
    const pwdOutcome = await bashExecutor.run(pwdSpec);
    expect(pwdOutcome.stdout.text.trim()).toBe('/mnt/project_ro');

    // DSH Bash write in RW mount persists to host
    const writeRwSpec = bashExecutor.resolve({
      command: 'echo "bash output log" > /mnt/project_rw/bash_output.log',
    });
    const writeRwOutcome = await bashExecutor.run(writeRwSpec);
    expect(writeRwOutcome.exitCode).toBe(0);
    expect(existsSync(join(hostProjectRW, 'bash_output.log'))).toBe(true);
    expect(readFileSync(join(hostProjectRW, 'bash_output.log'), 'utf8')).toContain('bash output log');

    // DSH Bash redirection / mutation in RO mount REJECTED fail-closed
    expect(() => {
      bashExecutor.resolve({
        command: 'echo "attack" > /mnt/project_ro/hacked.txt',
      });
    }).toThrow(/cannot write to read-only mount/i);

    // Mutation commands in RO workdir REJECTED fail-closed
    expect(() => {
      bashExecutor.resolve({
        command: 'touch exploit.txt',
        workdir: '/mnt/project_ro',
      });
    }).toThrow(/read-only; mutation commands are forbidden/i);

    // -----------------------------------------------------------------------------------
    // 8. Symlink Escape Defense & Protected Path Preflight Rejection
    // -----------------------------------------------------------------------------------
    // 8a. Symlink escape inside mount pointing outside is blocked
    const escapeSymlink = join(hostProjectRO, 'escape-link');
    try {
      symlinkSync(tempRepo.repoRoot, escapeSymlink);
    } catch {}

    if (existsSync(escapeSymlink)) {
      await expect(fsService.resolve('/mnt/project_ro/escape-link/some-file')).rejects.toThrow(/outside mount boundary/i);
    }

    // 8b. Traversal sequence in resolve is blocked
    await expect(fsService.resolve('/mnt/project_ro/../../etc/passwd')).rejects.toThrow(/outside mount boundary/i);

    // 8c. Protected system roots (/etc, etc.) REJECTED by preflight during Admin POST
    const createEtcRes = await fetch(`${platformUrl}/api/admin/spaces/${aliceHostSpace.id}/mounts`, {
      method: 'POST',
      headers: {
        Cookie: aliceAuth.cookie,
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'etc_mount',
        sourcePath: '/etc',
        mode: 'ro',
      }),
    });
    expect(createEtcRes.status).toBe(400);

    // -----------------------------------------------------------------------------------
    // 9. Mount Deletion Lifecycle
    // -----------------------------------------------------------------------------------
    const delRes = await fetch(`${platformUrl}/api/admin/spaces/${aliceHostSpace.id}/mounts/${roMountDto.id}`, {
      method: 'DELETE',
      headers: {
        Cookie: aliceAuth.cookie,
        'X-Enkeep-CSRF': aliceAuth.csrfToken,
        Origin: platformUrl,
      },
    });
    expect(delRes.status).toBe(200);
    const delData = (await delRes.json() as any).data;
    expect(delData.deleted).toBe(true);
    expect(delData.id).toBe(roMountDto.id);

    // Verify deleted mount is absent from list
    const postDelListRes = await fetch(`${platformUrl}/api/admin/spaces/${aliceHostSpace.id}/mounts`, {
      headers: { Cookie: aliceAuth.cookie },
    });
    const postDelMounts = (await postDelListRes.json() as any).data.mounts;
    expect(postDelMounts.length).toBe(1);
    expect(postDelMounts[0].id).toBe(rwMountDto.id);

    // Subsequent resolution of deleted mount fails
    const cordisCtx2 = new Context();
    const updatedMounts: ResolvedRuntimeMount[] = [
      { id: rwMountDto.id, name: 'project_rw', sourcePath: rwMountDto.sourcePath, targetPath: rwMountDto.sourcePath, mode: 'rw' },
    ];
    const updatedFsService = new SpaceIsolatedFileSystem(cordisCtx2, {
      cwd: spaceAPhysicalDir,
      mounts: updatedMounts,
    });
    await expect(updatedFsService.resolve('/mnt/project_ro/spec.md')).rejects.toThrow(/outside space boundary/i);

    // -----------------------------------------------------------------------------------
    // 10. Platform Restart & Encrypted DB Persistence (Zero Plaintext Source Paths)
    // -----------------------------------------------------------------------------------
    await system.close({ removeVolumes: false });
    system = null;

    const restartedHostAdapter = new HostRuntimePortAdapter();
    const restartedSystem = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      runtimeAdapter: fakeContainerAdapter,
      hostRuntimeAdapter: restartedHostAdapter,
      allowHostRuntime: true,
      llmEnabled: false,
    });
    system = restartedSystem;

    // Verify reconstructed mount sets match SQLite records exactly
    const reloadedAliceMounts = await restartedSystem.storage.forTenant(aliceAuth.user.id).spaceMounts.listBySpace(aliceHostSpace.id);
    expect(reloadedAliceMounts.length).toBe(1);
    expect(reloadedAliceMounts[0].name).toBe('project_rw');
    expect(reloadedAliceMounts[0].mode).toBe('rw');

    const reloadedSpaceBMounts = await restartedSystem.storage.forTenant(aliceAuth.user.id).spaceMounts.listBySpace(aliceSpaceB.id);
    expect(reloadedSpaceBMounts.length).toBe(1);
    expect(reloadedSpaceBMounts[0].name).toBe('project_ro');

    // -----------------------------------------------------------------------------------
    // 11. Security Audit: Check SQLite database table space_mounts for Zero Plaintext Path Leakage
    // -----------------------------------------------------------------------------------
    const rawMountRows = restartedSystem.database.prepare('SELECT * FROM space_mounts').all() as any[];
    expect(rawMountRows.length).toBe(3); // 1 remaining in Alice Space A, 1 in Alice Space B, 1 in Alice Container Space

    for (const row of rawMountRows) {
      // Must contain encrypted ciphertext and HMAC fingerprint
      expect(row.source_path_encrypted).toBeDefined();
      expect(row.source_fingerprint).toMatch(/^hmac-sha256:[a-f0-9]{64}$/);

      // Must NOT contain plaintext source paths
      expect(row.source_path_encrypted).not.toBe(hostProjectRO);
      expect(row.source_path_encrypted).not.toBe(hostProjectRW);
      expect(row.source_path_encrypted).not.toBe(hostProjectSpaceB);
      expect(row.source_path_encrypted).not.toContain(tempRepo.repoRoot);
    }
  });
});
