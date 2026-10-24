/**
 * User-level assets: single host copy, read-only container mounts, proxied global memory writes.
 *
 * Covers:
 * 1. Mount resolution on the host (missing paths, symlinks, wrong types, Linux uid 1000 access).
 * 2. Spec validation (read-only only, fixed targets, one host DSH home, env flag coupling).
 * 3. `docker run` arguments (`--mount ...,readonly`) and ownership assertions.
 * 4. connectRuntime flags containers whose asset mounts differ for an idle rebuild.
 * 5. Platform proxy route that writes the host copy (etag CAS, identity, path traversal).
 *
 * Synthetic fixtures only.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Duplex } from 'node:stream';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SafeDockerClient,
  DockerRuntimeAdapter,
  DockerOwnershipError,
  validateContainerSpec,
  resolveUserAssetMounts,
  validateUserAssetMounts,
  isReadableByContainerUser,
  userAssetMountKindsEqual,
  readContainerUserAssetMounts,
  removeUnmountedUserAssetPlaceholders,
  readProcessMountPoints,
  CONTAINER_DSH_HOME,
  USER_ASSET_CONTAINER_TARGETS,
  USER_MEMORY_WRITE_ENV_KEY,
  type RuntimeUserAssetMount,
  type DockerContainerInfo,
  type OwnershipExpectation,
} from '../src/index.js';
import { PlatformProxyHandler, createPlatformProxyHandler } from '../src/tunnel/platform-proxy.js';
import http from 'node:http';
import { DshPlatformClient } from '@enkeep/dsh-platform-client';
import { createMemoryWriteTool, MemoryWriteConflictError } from '@enkeep/dsh-memory';

const ALICE_ID = '11111111-1111-4111-8111-111111111111';
const VALID_64_HEX_ID = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

function etagOf(content: string): string {
  return `"${crypto.createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16)}"`;
}

function assetMounts(home: string, kinds: Array<'memory' | 'skills' | 'agents_md'>): RuntimeUserAssetMount[] {
  const names = { memory: 'memory', skills: 'skills', agents_md: 'AGENTS.md' } as const;
  return kinds.map((kind) => ({
    kind,
    sourcePath: path.join(home, names[kind]),
    targetPath: USER_ASSET_CONTAINER_TARGETS[kind],
    readOnly: true as const,
  }));
}

describe('user assets: host mount resolution', () => {
  let tmp: string;
  let home: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-user-assets-')));
    home = path.join(tmp, 'host-runtimes', 'alice', '.dsh');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('creates missing memory/ and skills/ (0700), skips a missing AGENTS.md, all read-only at fixed targets', () => {
    const r = resolveUserAssetMounts(home, { hostPlatform: 'darwin' });
    expect(r.created.sort()).toEqual(['memory', 'skills']);
    expect(r.mounts.map((m) => m.kind)).toEqual(['memory', 'skills']);
    expect(r.skipped).toEqual([{ kind: 'agents_md', reason: 'missing' }]);
    for (const m of r.mounts) {
      expect(m.readOnly).toBe(true);
      expect(m.targetPath).toBe(USER_ASSET_CONTAINER_TARGETS[m.kind]);
      expect(fs.statSync(m.sourcePath).mode & 0o777).toBe(0o700);
    }
    expect(r.mounts[0].targetPath).toBe('/home/dsh/.dsh/memory');
    expect(r.mounts[1].targetPath).toBe('/home/dsh/.dsh/skills');
  });

  it('mounts an existing AGENTS.md as a single read-only file', () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'AGENTS.md'), '# rules\n');
    const r = resolveUserAssetMounts(home, { hostPlatform: 'darwin' });
    expect(r.mounts.find((m) => m.kind === 'agents_md')).toEqual({
      kind: 'agents_md',
      sourcePath: path.join(home, 'AGENTS.md'),
      targetPath: '/home/dsh/.dsh/AGENTS.md',
      readOnly: true,
    });
  });

  it('handles a missing host DSH home without creating anything when creation is disabled', () => {
    const r = resolveUserAssetMounts(home, { createMissingDirectories: false });
    expect(r.mounts).toEqual([]);
    expect(r.skipped.map((s) => s.reason)).toEqual(['missing', 'missing', 'missing']);
    expect(fs.existsSync(home)).toBe(false);
  });

  it('never follows symlinks and skips wrong entry types', () => {
    fs.mkdirSync(home, { recursive: true });
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(home, 'memory'));
    fs.writeFileSync(path.join(home, 'skills'), 'not a dir');
    fs.mkdirSync(path.join(home, 'AGENTS.md'));
    const r = resolveUserAssetMounts(home, { hostPlatform: 'darwin' });
    expect(r.mounts).toEqual([]);
    expect(r.skipped).toEqual([
      { kind: 'memory', reason: 'symlink' },
      { kind: 'skills', reason: 'not_a_directory' },
      { kind: 'agents_md', reason: 'not_a_file' },
    ]);
  });

  it('rejects a symlinked or relative host DSH home', () => {
    expect(() => resolveUserAssetMounts('relative/.dsh')).toThrow(/absolute/);
    const real = path.join(tmp, 'real-home');
    fs.mkdirSync(real);
    const link = path.join(tmp, 'link-home');
    fs.symlinkSync(real, link);
    expect(() => resolveUserAssetMounts(link)).toThrow(/real directory/);
  });

  it('on Linux hosts, skips entries the container user (uid 1000) cannot read', () => {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const gid = typeof process.getgid === 'function' ? process.getgid() : 0;
    // Simulate a host whose files belong to another uid/gid than the container user.
    const containerUid = uid + 1;
    const containerGid = gid + 1;
    fs.mkdirSync(path.join(home, 'memory'), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.join(home, 'memory'), 0o700);
    fs.mkdirSync(path.join(home, 'skills'), { mode: 0o755 });
    fs.chmodSync(path.join(home, 'skills'), 0o755);
    let r = resolveUserAssetMounts(home, { hostPlatform: 'linux', containerUid, containerGid });
    expect(r.mounts.map((m) => m.kind)).toEqual(['skills']);
    expect(r.skipped).toContainEqual({ kind: 'memory', reason: 'unreadable_by_container_user' });

    fs.chmodSync(path.join(home, 'memory'), 0o755);
    fs.writeFileSync(path.join(home, 'memory', 'global.md'), 'x', { mode: 0o600 });
    fs.chmodSync(path.join(home, 'memory', 'global.md'), 0o600);
    r = resolveUserAssetMounts(home, { hostPlatform: 'linux', containerUid, containerGid });
    expect(r.skipped).toContainEqual({ kind: 'memory', reason: 'unreadable_by_container_user' });

    fs.chmodSync(path.join(home, 'memory', 'global.md'), 0o644);
    r = resolveUserAssetMounts(home, { hostPlatform: 'linux', containerUid, containerGid });
    expect(r.mounts.map((m) => m.kind)).toEqual(['memory', 'skills']);

    // Owned by the container uid itself: owner bits apply.
    expect(isReadableByContainerUser({ uid: 1000, gid: 5, mode: 0o40700 }, 'directory')).toBe(true);
    expect(isReadableByContainerUser({ uid: 7, gid: 1000, mode: 0o40750 }, 'directory')).toBe(true);
    expect(isReadableByContainerUser({ uid: 7, gid: 7, mode: 0o100600 }, 'file')).toBe(false);
  });
});

describe('user assets: spec validation', () => {
  const home = '/srv/enkeep-data/host-runtimes/alice/.dsh';

  function spec(userAssetMounts: unknown, env: Record<string, string> = {}) {
    return {
      userId: 'alice',
      runId: 'run_test_123',
      containerName: 'enkeep-demo-alice',
      image: 'enkeep-demo-runtime:latest',
      user: '1000:1000',
      workingDir: '/home/dsh',
      volume: { volumeName: 'enkeep-demo-dsh-alice', volumeId: 'vol_0123456789abcdef0123456789abcdef', containerPath: '/home/dsh' },
      networkMode: 'none',
      userAssetMounts,
      labels: {
        app: 'enkeep-demo',
        'enkeep.user': 'alice',
        'enkeep.run-id': 'run_test_123',
        'enkeep.volume-id': 'vol_0123456789abcdef0123456789abcdef',
      },
      environment: { DSH_USER: 'alice', DSH_HOME: '/home/dsh/.dsh', DSH_SPACES: '/home/dsh/spaces', ...env },
    };
  }

  it('accepts read-only memory/skills/AGENTS.md mounts with the platform write flag', () => {
    const result = validateContainerSpec(
      spec(assetMounts(home, ['memory', 'skills', 'agents_md']), { [USER_MEMORY_WRITE_ENV_KEY]: 'platform' }) as any
    );
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('rejects writable, retargeted, misnamed, mixed-home and unsafe sources', () => {
    const base = assetMounts(home, ['memory'])[0];
    const cases: unknown[] = [
      [{ ...base, readOnly: false }],
      [{ ...base, targetPath: '/home/dsh/memory' }],
      [{ ...base, targetPath: '/home/dsh/.dsh/skills' }],
      [{ ...base, sourcePath: '/srv/enkeep-data/host-runtimes/alice/.dsh/notes' }],
      [{ ...base, sourcePath: '/srv/enkeep-data/host-runtimes/alice/.dsh/../bob/.dsh/memory' }],
      [{ ...base, sourcePath: 'host-runtimes/alice/.dsh/memory' }],
      [{ ...base, sourcePath: '/srv/a,b/.dsh/memory' }],
      [{ ...base, sourcePath: '/etc/memory' }],
      [base, { ...assetMounts('/srv/other/.dsh', ['skills'])[0] }],
      [base, base],
      [{ ...base, mode: 'rw' }],
      'not-an-array',
    ];
    for (const c of cases) {
      expect(validateUserAssetMounts(c).length).toBeGreaterThan(0);
      expect(validateContainerSpec(spec(c) as any).valid).toBe(false);
    }
  });

  it('couples ENKEEP_USER_MEMORY_WRITE=platform to a memory mount', () => {
    expect(validateContainerSpec(spec(undefined, { [USER_MEMORY_WRITE_ENV_KEY]: 'platform' }) as any).valid).toBe(false);
    expect(validateContainerSpec(spec(assetMounts(home, ['skills']), { [USER_MEMORY_WRITE_ENV_KEY]: 'platform' }) as any).valid).toBe(false);
    expect(validateContainerSpec(spec(assetMounts(home, ['memory']), { [USER_MEMORY_WRITE_ENV_KEY]: 'local' }) as any).valid).toBe(false);
    // Unchanged default: no user asset mounts, no flag
    expect(validateContainerSpec(spec(undefined) as any).valid).toBe(true);
  });

  it('keeps generic bindMounts forbidden', () => {
    const s = { ...spec(undefined), bindMounts: [{ source: home, target: '/home/dsh/.dsh' }] };
    expect(validateContainerSpec(s as any).valid).toBe(false);
  });
});

describe('user assets: docker run arguments and ownership', () => {
  let tmp: string;
  let home: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-user-assets-docker-')));
    home = path.join(tmp, 'host-runtimes', 'alice', '.dsh');
    fs.mkdirSync(path.join(home, 'memory'), { recursive: true });
    fs.mkdirSync(path.join(home, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(home, 'AGENTS.md'), '# rules\n');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function containerInfo(spec: any, binds: Array<{ destination: string; source: string; rw: boolean }>): DockerContainerInfo {
    return {
      id: VALID_64_HEX_ID,
      name: spec.containerName,
      image: spec.image,
      status: 'running',
      state: 'running',
      user: '1000:1000',
      networkMode: 'none',
      readonlyRootfs: true,
      capDrop: ['ALL'],
      securityOpt: ['no-new-privileges:true'],
      pidsLimit: 256,
      portBindings: null,
      tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=64m' },
      labels: { ...spec.labels },
      mounts: [
        { type: 'volume', name: spec.volume.volumeName, source: '/var/lib/docker/volumes/x/_data', destination: '/home/dsh', rw: true },
        ...binds.map((b) => ({ type: 'bind', name: '', ...b })),
      ],
    };
  }

  function expectation(spec: any, userAssetMounts?: RuntimeUserAssetMount[]): OwnershipExpectation {
    return {
      containerName: spec.containerName,
      userId: spec.userId,
      runId: spec.runId,
      containerId: VALID_64_HEX_ID,
      volumeName: spec.volume.volumeName,
      volumeId: spec.volume.volumeId,
      containerPath: '/home/dsh',
      userAssetMounts,
      networkMode: 'none',
    };
  }

  it('createDefaultUserSpec adds read-only mounts and the platform memory-write flag', () => {
    const adapter = new DockerRuntimeAdapter({ client: new SafeDockerClient() });
    const mounts = resolveUserAssetMounts(home, { hostPlatform: 'darwin' }).mounts;
    const spec = adapter.createDefaultUserSpec({ userId: 'alice', userAssetMounts: mounts });
    expect(spec.userAssetMounts).toEqual(mounts);
    expect(spec.environment[USER_MEMORY_WRITE_ENV_KEY]).toBe('platform');
    expect(validateContainerSpec(spec).valid).toBe(true);

    const plain = adapter.createDefaultUserSpec({ userId: 'alice' });
    expect(plain.userAssetMounts).toBeUndefined();
    expect(plain.environment[USER_MEMORY_WRITE_ENV_KEY]).toBeUndefined();

    const skillsOnly = adapter.createDefaultUserSpec({ userId: 'alice', userAssetMounts: mounts.filter((m) => m.kind === 'skills') });
    expect(skillsOnly.environment[USER_MEMORY_WRITE_ENV_KEY]).toBeUndefined();
  });

  it('passes each asset as `--mount type=bind,...,readonly` (never `-v`)', async () => {
    const argsFile = path.join(tmp, 'docker-args.txt');
    const fakeDocker = path.join(tmp, 'fake-docker.sh');
    fs.writeFileSync(fakeDocker, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${argsFile}"\necho ${VALID_64_HEX_ID}\n`, { mode: 0o755 });
    const client = new SafeDockerClient(fakeDocker);
    const adapter = new DockerRuntimeAdapter({ client });
    const mounts = resolveUserAssetMounts(home, { hostPlatform: 'darwin' }).mounts;
    const spec = adapter.createDefaultUserSpec({ userId: 'alice', userAssetMounts: mounts });
    await (client as any).executeDockerRun(spec);
    const args = fs.readFileSync(argsFile, 'utf8').trim().split('\n');
    const mountArgs = args.filter((_, i) => args[i - 1] === '--mount');
    expect(mountArgs).toEqual([
      `type=bind,source=${path.join(home, 'memory')},target=/home/dsh/.dsh/memory,readonly`,
      `type=bind,source=${path.join(home, 'skills')},target=/home/dsh/.dsh/skills,readonly`,
      `type=bind,source=${path.join(home, 'AGENTS.md')},target=/home/dsh/.dsh/AGENTS.md,readonly`,
    ]);
    const vArgs = args.filter((_, i) => args[i - 1] === '-v');
    expect(vArgs).toEqual([`${spec.volume.volumeName}:/home/dsh`]);
    expect(args).toContain(`${USER_MEMORY_WRITE_ENV_KEY}=platform`);
  });

  it('ownership accepts the expected read-only asset binds and rejects writable, unexpected or missing ones', () => {
    const client = new SafeDockerClient();
    const adapter = new DockerRuntimeAdapter({ client });
    const mounts = assetMounts(home, ['memory', 'skills']);
    const spec = adapter.createDefaultUserSpec({ userId: 'alice', userAssetMounts: mounts });
    const roBinds = mounts.map((m) => ({ destination: m.targetPath, source: m.sourcePath, rw: false }));

    expect(() => client.assertContainerOwnership(containerInfo(spec, roBinds), expectation(spec, mounts))).not.toThrow();

    const rw = roBinds.map((b, i) => (i === 0 ? { ...b, rw: true } : b));
    expect(() => client.assertContainerOwnership(containerInfo(spec, rw), expectation(spec, mounts))).toThrow(/read-only/);

    expect(() => client.assertContainerOwnership(containerInfo(spec, roBinds), expectation(spec, undefined))).toThrow(DockerOwnershipError);
    expect(() => client.assertContainerOwnership(containerInfo(spec, roBinds.slice(0, 1)), expectation(spec, mounts))).toThrow(DockerOwnershipError);

    const wrongTarget = [{ destination: '/home/dsh/.dsh', source: home, rw: false }];
    expect(() => client.assertContainerOwnership(containerInfo(spec, wrongTarget), expectation(spec, mounts.slice(0, 1)))).toThrow(DockerOwnershipError);

    // No assets expected and none present: unchanged single-volume rule
    const plain = adapter.createDefaultUserSpec({ userId: 'alice', runId: spec.runId, volumeId: spec.volume.volumeId });
    expect(() => client.assertContainerOwnership(containerInfo(plain, []), expectation(plain, undefined))).not.toThrow();
  });

  it('reads actual asset mounts from inspect output and compares by kind', () => {
    const adapter = new DockerRuntimeAdapter({ client: new SafeDockerClient() });
    const spec = adapter.createDefaultUserSpec({ userId: 'alice' });
    const info = containerInfo(spec, [
      { destination: '/home/dsh/.dsh/memory', source: '/run/vm-share/memory', rw: false },
      { destination: '/home/dsh/mounts/mnt_1', source: tmp, rw: false },
    ]);
    const actual = readContainerUserAssetMounts(info);
    expect(actual.map((m) => m.kind)).toEqual(['memory']);
    expect(userAssetMountKindsEqual(actual, assetMounts(home, ['memory']))).toBe(true);
    expect(userAssetMountKindsEqual(actual, assetMounts(home, ['memory', 'skills']))).toBe(false);
    expect(() =>
      readContainerUserAssetMounts(containerInfo(spec, [{ destination: '/home/dsh/.dsh/memory', source: tmp, rw: true }]))
    ).toThrow(/read-only/);
  });

  describe('connectRuntime', () => {
    function mockTransport(): any {
      return {
        checkHealth: vi.fn().mockResolvedValue({
          status: 'ok',
          userId: 'alice',
          uptimeSeconds: 1,
          version: '0.0.0-test',
          modelProvider: 'test',
          dshReady: true,
          enkeepBundleLoaded: true,
          toolsOperational: true,
          toolsCount: 1,
          plugins: { receiptStore: true, inbound: true, eventRelay: true, tools: true, externalInteraction: true, affinityPolicy: true, llmAffinity: true },
        }),
        isConnected: vi.fn().mockReturnValue(true),
        start: vi.fn().mockResolvedValue(undefined),
      };
    }

    async function connectWith(desired: RuntimeUserAssetMount[], actual: RuntimeUserAssetMount[]) {
      const client = new SafeDockerClient();
      const adapter = new DockerRuntimeAdapter({ client, daemonTransportFactory: () => mockTransport() });
      const spec = adapter.createDefaultUserSpec({ userId: 'alice', userAssetMounts: desired });
      vi.spyOn(client, 'connectVolume').mockResolvedValue(undefined as any);
      vi.spyOn(client, 'startContainer').mockResolvedValue(undefined as any);
      vi.spyOn(client, 'inspectContainer').mockResolvedValue(
        containerInfo(spec, actual.map((m) => ({ destination: m.targetPath, source: m.sourcePath, rw: false })))
      );
      return adapter.connectRuntime(
        spec,
        { containerId: VALID_64_HEX_ID, containerName: spec.containerName, userId: 'alice', runId: spec.runId, volumeId: spec.volume.volumeId },
        2000
      );
    }

    it('flags an existing container without the desired mounts for an idle rebuild, serving its actual mounts', async () => {
      const handle = await connectWith(assetMounts(home, ['memory', 'skills']), []);
      expect(handle.userAssetMountsPending).toBe(true);
      expect(handle.userAssetMounts).toEqual([]);
    });

    it('does not flag a container whose mounts already match', async () => {
      const mounts = assetMounts(home, ['memory', 'skills']);
      const handle = await connectWith(mounts, mounts);
      expect(handle.userAssetMountsPending).toBe(false);
      expect(handle.userAssetMounts?.map((m) => m.kind)).toEqual(['memory', 'skills']);
    });

    it('flags a mounted container when mounts are no longer desired (kill switch)', async () => {
      const handle = await connectWith([], assetMounts(home, ['memory']));
      expect(handle.userAssetMountsPending).toBe(true);
      expect(handle.userAssetMounts?.map((m) => m.kind)).toEqual(['memory']);
    });
  });
});

// ---------------------------------------------------------------------------
// Platform proxy: POST /api/user-assets/memory/write
// ---------------------------------------------------------------------------

class TestClientDuplex extends Duplex {
  public responseBuffer = Buffer.alloc(0);
  _write(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.responseBuffer = Buffer.concat([this.responseBuffer, buf]);
    callback();
  }
  _read(_size: number): void {}
}

async function send(
  handler: PlatformProxyHandler,
  method: string,
  urlPath: string,
  body?: unknown,
  runtimeAlias = 'alice'
): Promise<{ statusCode: number; body: any }> {
  const stream = new TestClientDuplex();
  const bodyBuffer = body === undefined ? Buffer.alloc(0) : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  const head = [
    `${method} ${urlPath} HTTP/1.1`,
    'Host: 127.0.0.1:8787',
    'Content-Type: application/json',
    `Content-Length: ${bodyBuffer.length}`,
    '',
    '',
  ].join('\r\n');
  stream.push(Buffer.concat([Buffer.from(head, 'utf8'), bodyBuffer]));
  stream.push(null);
  await handler.handle(stream, { kind: 'platform', userId: runtimeAlias });
  const raw = stream.responseBuffer.toString('utf8');
  const idx = raw.indexOf('\r\n\r\n');
  const statusCode = parseInt(raw.slice(0, idx).split('\r\n')[0].split(' ')[1], 10);
  const text = raw.slice(idx + 4);
  return { statusCode, body: text ? JSON.parse(text) : null };
}

describe('user assets: platform proxy writes the single host copy', () => {
  const ROUTE = '/platform/api/user-assets/memory/write';
  let tmp: string;
  let memoryRoot: string;
  let handler: PlatformProxyHandler;
  let written: Array<{ path: string; bytesWritten: number; etag: string }>;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-user-assets-proxy-')));
    memoryRoot = path.join(tmp, 'host-runtimes', 'alice', '.dsh', 'memory');
    fs.mkdirSync(memoryRoot, { recursive: true, mode: 0o700 });
    written = [];
    handler = createPlatformProxyHandler({
      platformUserId: ALICE_ID,
      runtimeIdentity: 'alice',
      userAssets: { memoryRoot, onMemoryWritten: (e) => written.push(e) },
    });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('writes global.md on the host and returns the new etag', async () => {
    const res = await send(handler, 'POST', ROUTE, { scope: 'global', path: 'global.md', content: '# Memory\nfact one\n', mode: 'overwrite' });
    expect(res.statusCode).toBe(200);
    expect(fs.readFileSync(path.join(memoryRoot, 'global.md'), 'utf8')).toBe('# Memory\nfact one\n');
    expect(res.body).toMatchObject({ success: true, path: 'global.md', scope: 'global', isNewFile: true, etag: etagOf('# Memory\nfact one\n') });
    expect(res.body.targetPath).toBeUndefined();
    expect(written).toEqual([{ path: 'global.md', bytesWritten: 18, etag: etagOf('# Memory\nfact one\n') }]);
  });

  it('defaults to global.md, supports append and nested topic files', async () => {
    fs.writeFileSync(path.join(memoryRoot, 'global.md'), 'a');
    const r1 = await send(handler, 'POST', ROUTE, { content: 'b', mode: 'append' });
    expect(r1.statusCode).toBe(200);
    expect(fs.readFileSync(path.join(memoryRoot, 'global.md'), 'utf8')).toBe('a\nb');
    expect(r1.body.previousEtag).toBe(etagOf('a'));

    const r2 = await send(handler, 'POST', ROUTE, { path: 'topics/ideas.md', content: 'idea' });
    expect(r2.statusCode).toBe(200);
    expect(fs.readFileSync(path.join(memoryRoot, 'topics', 'ideas.md'), 'utf8')).toBe('idea');
  });

  it('keeps expectedEtag semantics: match writes, mismatch is 409 and leaves the file untouched', async () => {
    fs.writeFileSync(path.join(memoryRoot, 'global.md'), 'v1');
    const ok = await send(handler, 'POST', ROUTE, { content: 'v2', expectedEtag: etagOf('v1') });
    expect(ok.statusCode).toBe(200);

    const conflict = await send(handler, 'POST', ROUTE, { content: 'v3', expectedEtag: etagOf('v1') });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.body.error.code).toBe('MEMORY_WRITE_CONFLICT');
    expect(fs.readFileSync(path.join(memoryRoot, 'global.md'), 'utf8')).toBe('v2');

    const absent = await send(handler, 'POST', ROUTE, { path: 'new.md', content: 'x', expectedEtag: etagOf('x') });
    expect(absent.statusCode).toBe(409);
    expect(fs.existsSync(path.join(memoryRoot, 'new.md'))).toBe(false);
  });

  it('rejects identity or location fields supplied by the container', async () => {
    for (const extra of [{ userId: 'bob' }, { user_id: 'bob' }, { spaceId: 'space-1' }, { dshHome: '/tmp/x' }, { memoryRoot: '/tmp/x' }]) {
      const res = await send(handler, 'POST', ROUTE, { content: 'x', ...extra });
      expect(res.statusCode).toBe(400);
      expect(res.body.error.code).toBe('FORBIDDEN_FIELD');
    }
    expect(fs.existsSync(path.join(memoryRoot, 'global.md'))).toBe(false);
  });

  it('rejects another runtime identity on the bound tunnel (cross-user)', async () => {
    const res = await send(handler, 'POST', ROUTE, { content: 'x' }, 'bob');
    expect(res.statusCode).toBe(403);
    expect(fs.existsSync(path.join(memoryRoot, 'global.md'))).toBe(false);
  });

  it('rejects path traversal, absolute paths and symlink escapes', async () => {
    const outside = path.join(tmp, 'outside.md');
    fs.writeFileSync(outside, 'secret');
    const bobRoot = path.join(tmp, 'host-runtimes', 'bob', '.dsh', 'memory');
    fs.mkdirSync(bobRoot, { recursive: true });
    for (const p of [
      '../outside.md',
      '../../../bob/.dsh/memory/global.md',
      'topics/../../outside.md',
      outside,
      '/etc/passwd',
      './global.md',
      'a\\..\\..\\outside.md',
      '',
      'x\u0000y',
    ]) {
      const res = await send(handler, 'POST', ROUTE, { path: p, content: 'pwned' });
      expect(res.statusCode, p).toBe(400);
    }
    fs.symlinkSync(outside, path.join(memoryRoot, 'link.md'));
    fs.symlinkSync(tmp, path.join(memoryRoot, 'linkdir'));
    expect((await send(handler, 'POST', ROUTE, { path: 'link.md', content: 'pwned' })).statusCode).toBe(400);
    expect((await send(handler, 'POST', ROUTE, { path: 'linkdir/outside.md', content: 'pwned' })).statusCode).toBe(400);
    expect(fs.readFileSync(outside, 'utf8')).toBe('secret');
    expect(fs.readdirSync(bobRoot)).toEqual([]);
  });

  it('only accepts global scope, string content and POST', async () => {
    expect((await send(handler, 'POST', ROUTE, { scope: 'space', content: 'x' })).statusCode).toBe(400);
    expect((await send(handler, 'POST', ROUTE, { content: 42 })).statusCode).toBe(400);
    expect((await send(handler, 'POST', ROUTE, { content: 'x', mode: 'replace' })).statusCode).toBe(400);
    expect((await send(handler, 'POST', ROUTE, '{not json')).statusCode).toBe(400);
    expect((await send(handler, 'GET', ROUTE)).statusCode).toBe(405);
  });

  it('is absent (404) when the platform did not bind host user assets (host mode, legacy containers)', async () => {
    const unbound = createPlatformProxyHandler({ platformUserId: ALICE_ID, runtimeIdentity: 'alice' });
    const res = await send(unbound, 'POST', ROUTE, { content: 'x' });
    expect(res.statusCode).toBe(404);
    expect(fs.existsSync(path.join(memoryRoot, 'global.md'))).toBe(false);
  });

  it('refuses a non-normalized memory root binding', () => {
    expect(() => createPlatformProxyHandler({ platformUserId: ALICE_ID, userAssets: { memoryRoot: 'relative/memory' } })).toThrow(/FAIL-CLOSED/);
    expect(() => createPlatformProxyHandler({ platformUserId: ALICE_ID, userAssets: { memoryRoot: `${memoryRoot}/../x` } })).toThrow(/FAIL-CLOSED/);
  });
});

describe('user assets: container memory_write -> platform client -> proxy -> host copy', () => {
  let tmp: string;
  let hostHome: string;
  let containerHome: string;
  let server: http.Server;
  let baseURL: string;

  beforeEach(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-user-assets-e2e-')));
    hostHome = path.join(tmp, 'host-runtimes', 'alice', '.dsh');
    // The container sees the host copy at its own DSH home; here a separate read-only view.
    containerHome = path.join(tmp, 'container-view', '.dsh');
    fs.mkdirSync(path.join(hostHome, 'memory'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(hostHome, 'memory', 'global.md'), 'host v1');
    fs.mkdirSync(path.dirname(containerHome), { recursive: true });
    fs.symlinkSync(hostHome, containerHome);
    const handler = createPlatformProxyHandler({
      platformUserId: ALICE_ID,
      runtimeIdentity: 'alice',
      userAssets: { memoryRoot: path.join(hostHome, 'memory') },
    });
    server = http.createServer((req, res) => void handler.handleHttpRequest(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address() as { port: number };
    baseURL = `http://127.0.0.1:${addr.port}/platform`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('writes the host copy and maps a stale etag to a conflict', async () => {
    const platformClient = new DshPlatformClient({ baseURL, timeoutMs: 5000 });
    const tool = createMemoryWriteTool({
      dshHome: containerHome,
      globalMemoryWrite: 'platform',
      getClient: () => platformClient as any,
    });

    const res = await tool.execute({ content: 'host v2', expectedEtag: etagOf('host v1') });
    expect(res).toMatchObject({ success: true, scope: 'global', etag: etagOf('host v2'), isNewFile: false });
    expect(fs.readFileSync(path.join(hostHome, 'memory', 'global.md'), 'utf8')).toBe('host v2');

    await expect(tool.execute({ content: 'host v3', expectedEtag: etagOf('host v1') })).rejects.toBeInstanceOf(MemoryWriteConflictError);
    expect(fs.readFileSync(path.join(hostHome, 'memory', 'global.md'), 'utf8')).toBe('host v2');

    await tool.execute({ content: 'line', mode: 'append', path: 'topics/t.md' });
    expect(fs.readFileSync(path.join(hostHome, 'memory', 'topics', 't.md'), 'utf8')).toBe('line');
  });
});

describe('user assets: kill switch / rollback leaves no root-owned placeholders in the way', () => {
  let tmp: string;
  let dshHome: string;
  const me = typeof process.getuid === 'function' ? process.getuid() : 0;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-ua-placeholders-')));
    dshHome = path.join(tmp, '.dsh');
    fs.mkdirSync(dshHome, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('removes empty mountpoint placeholders (memory/, skills/ dirs and empty AGENTS.md) owned by the placeholder owner', () => {
    fs.mkdirSync(path.join(dshHome, 'memory'));
    fs.mkdirSync(path.join(dshHome, 'skills'));
    fs.writeFileSync(path.join(dshHome, 'AGENTS.md'), '');
    const r = removeUnmountedUserAssetPlaceholders(dshHome, { placeholderUid: me, isMountPoint: () => false });
    expect(r.removed).toEqual(['memory', 'skills', 'agents_md']);
    expect(fs.existsSync(path.join(dshHome, 'memory'))).toBe(false);
    expect(fs.existsSync(path.join(dshHome, 'skills'))).toBe(false);
    expect(fs.existsSync(path.join(dshHome, 'AGENTS.md'))).toBe(false);
  });

  it('keeps anything with data, mounted paths and entries owned by someone else', () => {
    fs.mkdirSync(path.join(dshHome, 'memory'));
    fs.writeFileSync(path.join(dshHome, 'memory', 'global.md'), 'data');
    fs.mkdirSync(path.join(dshHome, 'skills'));
    fs.writeFileSync(path.join(dshHome, 'AGENTS.md'), 'instructions');
    const r = removeUnmountedUserAssetPlaceholders(dshHome, {
      placeholderUid: me,
      isMountPoint: (p) => p === path.join(dshHome, 'skills'),
    });
    expect(r.removed).toEqual([]);
    expect(r.kept).toEqual([
      { kind: 'memory', reason: 'not_empty' },
      { kind: 'skills', reason: 'mounted' },
      { kind: 'agents_md', reason: 'not_empty' },
    ]);
    // Default placeholder owner is root: the container user's own empty dirs are kept
    fs.rmSync(path.join(dshHome, 'memory'), { recursive: true });
    fs.mkdirSync(path.join(dshHome, 'memory'));
    if (me !== 0) {
      const d = removeUnmountedUserAssetPlaceholders(dshHome, { isMountPoint: () => false });
      expect(d.removed).toEqual([]);
      expect(d.kept.find((k) => k.kind === 'memory')?.reason).toBe('not_placeholder_owner');
    }
    // A wrong entry type is never removed
    fs.rmdirSync(path.join(dshHome, 'memory'));
    fs.writeFileSync(path.join(dshHome, 'memory'), '');
    const w = removeUnmountedUserAssetPlaceholders(dshHome, { placeholderUid: me, isMountPoint: () => false });
    expect(w.kept.find((k) => k.kind === 'memory')?.reason).toBe('wrong_type');
    expect(fs.existsSync(path.join(dshHome, 'memory'))).toBe(true);
  });

  it('reads mount points from mountinfo (octal escapes decoded)', () => {
    const info = path.join(tmp, 'mountinfo');
    fs.writeFileSync(
      info,
      [
        '36 35 98:0 / /home/dsh rw,relatime - ext4 /dev/vda1 rw',
        '40 36 0:50 /alice/.dsh/memory /home/dsh/.dsh/memory ro,relatime - virtiofs mac ro',
        '41 36 0:50 /x /home/dsh/with\\040space ro - virtiofs mac ro',
      ].join('\n')
    );
    const points = readProcessMountPoints(info)!;
    expect(points.has('/home/dsh/.dsh/memory')).toBe(true);
    expect(points.has('/home/dsh/with space')).toBe(true);
    expect(points.has('/home/dsh/.dsh/skills')).toBe(false);
    expect(readProcessMountPoints(path.join(tmp, 'missing'))).toBeUndefined();
  });

  it('the runtime boot only cleans placeholders for the container DSH home', () => {
    expect(CONTAINER_DSH_HOME).toBe('/home/dsh/.dsh');
    const boot = fs.readFileSync(path.join(__dirname, '..', 'src', 'runtime', 'dsh-boot.ts'), 'utf8');
    const cleanupAt = boot.indexOf('removeUnmountedUserAssetPlaceholders(dshHome)');
    const memoryAt = boot.indexOf('await ctx.plugin(MemoryService');
    expect(cleanupAt).toBeGreaterThan(0);
    expect(cleanupAt).toBeLessThan(memoryAt);
    expect(boot).toContain('if (dshHome === CONTAINER_DSH_HOME)');
  });
});
