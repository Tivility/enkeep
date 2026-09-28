import { describe, it, expect, vi } from 'vitest';
import { parseContainerNetworkMode } from '../src/demo-runner.js';
import { DockerRuntimeContainerAdapter } from '../src/ports/index.js';
import { launchDemoSystem, loadAndVerifyFixedSeeds } from '../src/up/index.js';
import { resetDemo } from '../src/reset/index.js';
import { getDemoPathConfig } from '../src/config.js';
import { SafeDockerClient, NetworkModeMismatchError } from '@enkeep/runtime-runner';
import * as dshConfigLoader from '@enkeep/runtime-runner';
import {
  writeSignedVolumeMeta,
  writeSignedContainerMeta,
  readSignedVolumeMeta,
  readSignedContainerMeta,
} from '../src/utils/crypto-meta.js';
import { createTempRepo } from './support/temp-repo.js';

describe('Demo Runner Container Network Mode Configuration & Parser', () => {
  describe('parseContainerNetworkMode', () => {
    it('parses explicit network mode via CLI argument (--network-mode and --network)', () => {
      // Space-separated
      expect(parseContainerNetworkMode(['up', '--network-mode', 'bridge'])).toBe('bridge');
      expect(parseContainerNetworkMode(['up', '--network', 'bridge'])).toBe('bridge');
      expect(parseContainerNetworkMode(['up', '--network-mode', 'none'])).toBe('none');
      expect(parseContainerNetworkMode(['up', '--network', 'none'])).toBe('none');

      // Equals-separated
      expect(parseContainerNetworkMode(['up', '--network-mode=bridge'])).toBe('bridge');
      expect(parseContainerNetworkMode(['up', '--network=bridge'])).toBe('bridge');
      expect(parseContainerNetworkMode(['up', '--network-mode=none'])).toBe('none');
      expect(parseContainerNetworkMode(['up', '--network=none'])).toBe('none');

      // Embedded in other arguments
      expect(parseContainerNetworkMode(['up', '--json', '--network-mode', 'bridge', '--allow-host'])).toBe('bridge');
    });

    it('falls back to environment variable and prioritizes CLI over env', () => {
      // ENKEEP_CONTAINER_NETWORK_MODE
      expect(parseContainerNetworkMode(['up'], { ENKEEP_CONTAINER_NETWORK_MODE: 'bridge' })).toBe('bridge');
      expect(parseContainerNetworkMode(['up'], { ENKEEP_CONTAINER_NETWORK_MODE: 'none' })).toBe('none');

      // DSH_CONTAINER_NETWORK_MODE fallback
      expect(parseContainerNetworkMode(['up'], { DSH_CONTAINER_NETWORK_MODE: 'bridge' })).toBe('bridge');

      // CLI overrides env
      expect(
        parseContainerNetworkMode(['up', '--network-mode', 'none'], { ENKEEP_CONTAINER_NETWORK_MODE: 'bridge' })
      ).toBe('none');
      expect(
        parseContainerNetworkMode(['up', '--network-mode', 'bridge'], { ENKEEP_CONTAINER_NETWORK_MODE: 'none' })
      ).toBe('bridge');
    });

    it('obeys CLI > env > settings > default precedence', () => {
      const mockDshConfigBridge = { containerNetworkMode: 'bridge' } as any;
      const mockDshConfigNone = { containerNetworkMode: 'none' } as any;

      // Settings fallback when no CLI or env
      expect(parseContainerNetworkMode(['up'], {}, mockDshConfigBridge)).toBe('bridge');
      expect(parseContainerNetworkMode(['up'], {}, mockDshConfigNone)).toBe('none');

      // Env overrides settings
      expect(
        parseContainerNetworkMode(['up'], { ENKEEP_CONTAINER_NETWORK_MODE: 'none' }, mockDshConfigBridge)
      ).toBe('none');
      expect(
        parseContainerNetworkMode(['up'], { DSH_CONTAINER_NETWORK_MODE: 'bridge' }, mockDshConfigNone)
      ).toBe('bridge');

      // CLI overrides both env and settings
      expect(
        parseContainerNetworkMode(
          ['up', '--network-mode', 'bridge'],
          { ENKEEP_CONTAINER_NETWORK_MODE: 'none' },
          mockDshConfigNone
        )
      ).toBe('bridge');
      expect(
        parseContainerNetworkMode(
          ['up', '--network', 'none'],
          { ENKEEP_CONTAINER_NETWORK_MODE: 'bridge' },
          mockDshConfigBridge
        )
      ).toBe('none');

      // Default to none when settings has no containerNetworkMode
      expect(parseContainerNetworkMode(['up'], {}, {} as any)).toBe('none');
      expect(parseContainerNetworkMode(['up'], {}, null)).toBe('none');
    });

    it('defaults to backwards-compatible "none" when neither CLI flag nor env var is provided', () => {
      expect(parseContainerNetworkMode(['up'])).toBe('none');
      expect(parseContainerNetworkMode(['up'], {})).toBe('none');
      expect(parseContainerNetworkMode(['up'], { ENKEEP_CONTAINER_NETWORK_MODE: '' })).toBe('none');
      expect(parseContainerNetworkMode(['up', '--json'])).toBe('none');
    });

    it('strictly rejects invalid, unknown, or missing network mode values fail-closed', () => {
      // Missing value
      expect(() => parseContainerNetworkMode(['up', '--network-mode'])).toThrow(/requires a valid network mode/);
      expect(() => parseContainerNetworkMode(['up', '--network'])).toThrow(/requires a valid network mode/);
      expect(() => parseContainerNetworkMode(['up', '--network-mode', '--json'])).toThrow(/requires a valid network mode/);
      expect(() => parseContainerNetworkMode(['up', '--network-mode='])).toThrow(/requires a valid network mode/);
      expect(() => parseContainerNetworkMode(['up', '--network='])).toThrow(/requires a valid network mode/);

      // Unknown modes (e.g. host, overlay, macvlan)
      expect(() => parseContainerNetworkMode(['up', '--network-mode', 'host'])).toThrow(
        /Invalid container network mode "host"/
      );
      expect(() => parseContainerNetworkMode(['up', '--network', 'overlay'])).toThrow(
        /Invalid container network mode "overlay"/
      );
      expect(() => parseContainerNetworkMode(['up', '--network-mode', 'direct'])).toThrow(
        /Invalid container network mode "direct"/
      );

      // Invalid env values
      expect(() =>
        parseContainerNetworkMode(['up'], { ENKEEP_CONTAINER_NETWORK_MODE: 'host' })
      ).toThrow(/Invalid container network mode "host"/);
      expect(() =>
        parseContainerNetworkMode(['up'], { DSH_CONTAINER_NETWORK_MODE: 'invalid' })
      ).toThrow(/Invalid container network mode "invalid"/);
    });
  });

  describe('Startup Option Inheritance to DockerRuntimeContainerAdapter', () => {
    it('inherits defaultNetworkMode and propagates to container spec generation', async () => {
      const mockClient = new SafeDockerClient();
      vi.spyOn(mockClient, 'isDockerAvailable').mockResolvedValue(true);
      vi.spyOn(mockClient, 'inspectContainer').mockResolvedValue(null);

      // Adapter initialized with bridge mode
      const bridgeAdapter = new DockerRuntimeContainerAdapter(mockClient, {
        defaultNetworkMode: 'bridge',
      });

      let capturedSpec: any;
      const internalAdapter = (bridgeAdapter as any).adapter;
      const origCreate = internalAdapter.createDefaultUserSpec.bind(internalAdapter);
      vi.spyOn(internalAdapter, 'createDefaultUserSpec').mockImplementation((opts: any) => {
        const spec = origCreate(opts);
        capturedSpec = spec;
        return spec;
      });

      // Spy on startRuntime and startRuntimeWithOwnedVolume to avoid real Docker container execution
      const fakeHandle = {
        status: 'ok',
        userId: 'alice',
        runId: 'run_test_123',
        containerId: 'a'.repeat(64),
        teardown: vi.fn(),
      } as any;
      vi.spyOn(internalAdapter, 'startRuntime').mockResolvedValue(fakeHandle);
      vi.spyOn(internalAdapter, 'startRuntimeWithOwnedVolume').mockResolvedValue(fakeHandle);

      await bridgeAdapter.startUserRuntime({
        userId: 'alice',
        mode: 'test',
        resourceSuffix: 'nettest',
        llmEnabled: true,
      });

      expect(capturedSpec).toBeDefined();
      expect(capturedSpec.networkMode).toBe('bridge');
      // Loopback platform proxy address remains functional under bridge mode
      expect(capturedSpec.environment.ENKEEP_LLM_BASE_URL).toBe('http://127.0.0.1:8787/llm');
      // No published ports
      expect('publishedPorts' in capturedSpec).toBe(false);
    });

    it('allows explicit networkMode override in startUserRuntime', async () => {
      const mockClient = new SafeDockerClient();
      vi.spyOn(mockClient, 'isDockerAvailable').mockResolvedValue(true);
      vi.spyOn(mockClient, 'inspectContainer').mockResolvedValue(null);

      // Adapter defaults to none
      const adapter = new DockerRuntimeContainerAdapter(mockClient, {
        defaultNetworkMode: 'none',
      });

      let capturedSpec: any;
      const internalAdapter = (adapter as any).adapter;
      const origCreate = internalAdapter.createDefaultUserSpec.bind(internalAdapter);
      vi.spyOn(internalAdapter, 'createDefaultUserSpec').mockImplementation((opts: any) => {
        const spec = origCreate(opts);
        capturedSpec = spec;
        return spec;
      });

      const fakeHandle2 = {
        status: 'ok',
        userId: 'alice',
        runId: 'run_test_123',
        containerId: 'a'.repeat(64),
        teardown: vi.fn(),
      } as any;
      vi.spyOn(internalAdapter, 'startRuntime').mockResolvedValue(fakeHandle2);
      vi.spyOn(internalAdapter, 'startRuntimeWithOwnedVolume').mockResolvedValue(fakeHandle2);

      // Override with bridge
      await adapter.startUserRuntime({
        userId: 'alice',
        mode: 'test',
        resourceSuffix: 'nettest2',
        networkMode: 'bridge',
        llmEnabled: true,
      });

      expect(capturedSpec).toBeDefined();
      expect(capturedSpec.networkMode).toBe('bridge');
    });
  });

  describe('Container Network Mode Reconciliation & Mismatch Handling', () => {
    it('throws NetworkModeMismatchError without silently rebuilding when existing container has different networkMode', async () => {
      const tempRepo = await createTempRepo();
      try {
        const mockClient = new SafeDockerClient();
        vi.spyOn(mockClient, 'isDockerAvailable').mockResolvedValue(true);

        const containerId = 'c'.repeat(64);
        const volumeId = 'vol_' + 'a'.repeat(32);
        const resourceSuffix = 'mismatch1';

        // Write signed volume & container metadata with existing mode 'none'
        writeSignedVolumeMeta(
          {
            userId: 'alice',
            volumeName: `enkeep-demo-dsh-alice-${resourceSuffix}`,
            volumeId,
            runId: 'run_old_1',
          },
          { repoRoot: tempRepo.repoRoot, dataRoot: tempRepo.dataRoot, resourceSuffix }
        );

        writeSignedContainerMeta(
          {
            userId: 'alice',
            containerName: `enkeep-demo-alice-${resourceSuffix}`,
            containerId,
            runId: 'run_old_1',
            image: 'enkeep-demo-runtime:latest',
            volumeName: `enkeep-demo-dsh-alice-${resourceSuffix}`,
            volumeId,
            labels: {
              app: 'enkeep-demo',
              'enkeep.user': 'alice',
              'enkeep.run-id': 'run_old_1',
              'enkeep.volume-id': volumeId,
            },
          },
          { repoRoot: tempRepo.repoRoot, dataRoot: tempRepo.dataRoot, resourceSuffix }
        );

        // Host container inspection reports networkMode 'none'
        vi.spyOn(mockClient, 'inspectContainer').mockResolvedValue({
          id: containerId,
          name: `enkeep-demo-alice-${resourceSuffix}`,
          networkMode: 'none',
          status: 'running',
          user: '1000:1000',
          labels: {
            app: 'enkeep-demo',
            'enkeep.user': 'alice',
            'enkeep.run-id': 'run_old_1',
            'enkeep.volume-id': volumeId,
          },
          mounts: [],
          portBindings: null,
          readonlyRootfs: true,
          capDrop: ['ALL'],
          securityOpt: ['no-new-privileges:true'],
          pidsLimit: 256,
        } as any);

        const stopSpy = vi.spyOn(mockClient, 'stopContainer');
        const removeSpy = vi.spyOn(mockClient, 'removeContainer');

        const adapter = new DockerRuntimeContainerAdapter(mockClient);

        // Attempting to start with bridge mode when existing container has 'none' MUST fail-closed with NetworkModeMismatchError
        // and must NEVER invoke stopContainer or removeContainer (no self-stop)
        await expect(
          adapter.startUserRuntime({
            userId: 'alice',
            repoRoot: tempRepo.repoRoot,
            dataRoot: tempRepo.dataRoot,
            resourceSuffix,
            networkMode: 'bridge',
          })
        ).rejects.toThrow(NetworkModeMismatchError);

        expect(stopSpy).not.toHaveBeenCalled();
        expect(removeSpy).not.toHaveBeenCalled();

        try {
          await adapter.startUserRuntime({
            userId: 'alice',
            repoRoot: tempRepo.repoRoot,
            dataRoot: tempRepo.dataRoot,
            resourceSuffix,
            networkMode: 'bridge',
          });
        } catch (err: any) {
          expect(err).toBeInstanceOf(NetworkModeMismatchError);
          expect(err.name).toBe('NetworkModeMismatchError');
          expect(err.code).toBe('NETWORK_MODE_MISMATCH');
          expect(err.existingMode).toBe('none');
          expect(err.desiredMode).toBe('bridge');
          expect(err.message).toMatch(/Container networkMode mismatch/);
          expect(err.message).toMatch(/drain active turns/);
          expect(err.message).toMatch(/controlled deployer/);
          expect(stopSpy).not.toHaveBeenCalled();
          expect(removeSpy).not.toHaveBeenCalled();
        }
      } finally {
        await tempRepo.cleanup();
      }
    });

    it('reconnects without rebuild when networkMode matches existing container', async () => {
      const tempRepo = await createTempRepo();
      try {
        const mockClient = new SafeDockerClient();
        vi.spyOn(mockClient, 'isDockerAvailable').mockResolvedValue(true);

        const containerId = 'e'.repeat(64);
        const volumeId = 'vol_' + 'c'.repeat(32);
        const resourceSuffix = 'match1';

        writeSignedVolumeMeta(
          {
            userId: 'alice',
            volumeName: `enkeep-demo-dsh-alice-${resourceSuffix}`,
            volumeId,
            runId: 'run_matched',
          },
          { repoRoot: tempRepo.repoRoot, dataRoot: tempRepo.dataRoot, resourceSuffix }
        );

        writeSignedContainerMeta(
          {
            userId: 'alice',
            containerName: `enkeep-demo-alice-${resourceSuffix}`,
            containerId,
            runId: 'run_matched',
            image: 'enkeep-demo-runtime:latest',
            volumeName: `enkeep-demo-dsh-alice-${resourceSuffix}`,
            volumeId,
            labels: {
              app: 'enkeep-demo',
              'enkeep.user': 'alice',
              'enkeep.run-id': 'run_matched',
              'enkeep.volume-id': volumeId,
            },
          },
          { repoRoot: tempRepo.repoRoot, dataRoot: tempRepo.dataRoot, resourceSuffix }
        );

        vi.spyOn(mockClient, 'inspectContainer').mockResolvedValue({
          id: containerId,
          name: `enkeep-demo-alice-${resourceSuffix}`,
          networkMode: 'bridge',
          status: 'running',
          user: '1000:1000',
          labels: {
            app: 'enkeep-demo',
            'enkeep.user': 'alice',
            'enkeep.run-id': 'run_matched',
            'enkeep.volume-id': volumeId,
          },
          mounts: [],
          portBindings: null,
          readonlyRootfs: true,
          capDrop: ['ALL'],
          securityOpt: ['no-new-privileges:true'],
          pidsLimit: 256,
        } as any);

        const adapter = new DockerRuntimeContainerAdapter(mockClient);
        const internalAdapter = (adapter as any).adapter;

        const fakeHandle = {
          status: 'ok',
          userId: 'alice',
          runId: 'run_matched',
          containerId,
          teardown: vi.fn(),
        } as any;
        const connectSpy = vi.spyOn(internalAdapter, 'connectRuntime').mockResolvedValue(fakeHandle);

        const handle = await adapter.startUserRuntime({
          userId: 'alice',
          repoRoot: tempRepo.repoRoot,
          dataRoot: tempRepo.dataRoot,
          resourceSuffix,
          networkMode: 'bridge',
        });

        expect(connectSpy).toHaveBeenCalled();
      } finally {
        await tempRepo.cleanup();
      }
    });

    it('assertContainerOwnership in SafeDockerClient throws NetworkModeMismatchError on mode mismatch', () => {
      const client = new SafeDockerClient();
      const expectation = {
        containerName: 'enkeep-demo-alice',
        userId: 'alice',
        runId: 'run_123',
        containerId: 'f'.repeat(64),
        volumeName: 'enkeep-demo-dsh-alice',
        volumeId: 'vol_' + 'f'.repeat(32),
        containerPath: '/home/dsh',
        networkMode: 'bridge' as const,
      };

      const info = {
        id: 'f'.repeat(64),
        name: 'enkeep-demo-alice',
        user: '1000:1000',
        networkMode: 'none',
        readonlyRootfs: true,
        capDrop: ['ALL'],
        securityOpt: ['no-new-privileges:true'],
        pidsLimit: 256,
        portBindings: null,
        mounts: [
          {
            type: 'volume',
            name: 'enkeep-demo-dsh-alice',
            destination: '/home/dsh',
            rw: true,
            source: '/var/lib/docker/volumes/enkeep-demo-dsh-alice/_data',
          },
          {
            type: 'tmpfs',
            destination: '/tmp',
            options: 'rw,noexec,nosuid,size=67108864',
          },
        ],
        labels: {
          app: 'enkeep-demo',
          'enkeep.user': 'alice',
          'enkeep.run-id': 'run_123',
          'enkeep.volume-id': 'vol_' + 'f'.repeat(32),
        },
      };

      expect(() => client.assertContainerOwnership(info as any, expectation)).toThrow(NetworkModeMismatchError);
    });
  });

  describe('launchDemoSystem (up entry) Container Network Mode Resolution', () => {
    it('consumes dshDeploymentConfig.containerNetworkMode adhering to CLI > env > settings > default', async () => {
      const tempRepo = await createTempRepo();
      try {
        await resetDemo({ repoRoot: tempRepo.repoRoot });
        const paths = getDemoPathConfig({ repoRoot: tempRepo.repoRoot, dataRoot: tempRepo.dataRoot });
        let capturedStartOpts: any;
        const fakeAdapter: any = {
          startUserRuntime: vi.fn().mockImplementation(async (opts) => {
            capturedStartOpts = opts;
            return {
              status: 'ok',
              userId: opts.userId,
              runId: 'run_mock_1',
              containerId: 'c'.repeat(64),
              checkHealth: vi.fn().mockResolvedValue({ status: 'ok', dshReady: true, toolsOperational: true }),
              importSeed: vi.fn().mockImplementation(async (sid) => {
                const seeds = loadAndVerifyFixedSeeds(paths.importDir, {
                  repoRoot: tempRepo.repoRoot,
                  dataRoot: tempRepo.dataRoot,
                });
                const found = seeds.find((s: any) => s.sessionId === sid);
                return {
                  status: 'ok',
                  sessionId: sid,
                  persisted: true,
                  duplicate: false,
                  receipt: found?.receipt,
                };
              }),
              stop: vi.fn(),
              teardown: vi.fn(),
            };
          }),
        };

        // 1. Settings fallback: mock loadDshDeploymentConfig returning bridge
        const loadSpy = vi.spyOn(dshConfigLoader, 'loadDshDeploymentConfig').mockReturnValue({
          dshHome: '/dummy',
          providers: {},
          defaultModel: { provider: 'cpa-claude', model: 'claude-fable-5' },
          tokens: {},
          allowedHosts: [],
          containerNetworkMode: 'bridge',
        } as any);

        const system = await launchDemoSystem({
          repoRoot: tempRepo.repoRoot,
          dataRoot: tempRepo.dataRoot,
          runtimeAdapter: fakeAdapter,
        });

        expect(capturedStartOpts).toBeDefined();
        expect(capturedStartOpts.networkMode).toBe('bridge');
        await system.close();
        loadSpy.mockRestore();
      } finally {
        await tempRepo.cleanup();
      }
    });
  });
});
