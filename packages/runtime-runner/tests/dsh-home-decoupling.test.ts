import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  loadDshDeploymentConfig,
  resolvePlatformDshHome,
  parseDshConfigFiles,
} from '../src/config/dsh-config-loader.js';
import { createLlmProxyHandler } from '../src/tunnel/llm-proxy.js';

const SYNTHETIC_CORDIS_PATCH_YML = `
- id: llm-pi-ai
  config:
    providers:
      synthetic-provider:
        api: openai-completions
        baseURL: https://synthetic-gw.example.com/v1
        apiKeyEnv: SYNTHETIC_TOKEN
        models:
          - id: synthetic-model-1
            name: Synthetic Model 1
- id: agent-default-model
  config:
    provider: synthetic-provider
    model: synthetic-model-1
`;

const SYNTHETIC_SETTINGS_YAML = `
agent-default-model:
  provider: synthetic-provider
  model: synthetic-model-1
`;

const SYNTHETIC_ENV = `SYNTHETIC_TOKEN=synthetic-secret-token-12345
`;

describe('DSH Home Decoupling & Fail-Closed Guardrails', () => {
  let tempBaseDir: string;
  let originalEnkeepDshHome: string | undefined;
  let originalDshHome: string | undefined;
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-dsh-decouple-test-'));
    originalEnkeepDshHome = process.env.ENKEEP_DSH_HOME;
    originalDshHome = process.env.DSH_HOME;
    originalNodeEnv = process.env.NODE_ENV;

    delete process.env.ENKEEP_DSH_HOME;
    delete process.env.DSH_HOME;
  });

  afterEach(() => {
    if (originalEnkeepDshHome !== undefined) {
      process.env.ENKEEP_DSH_HOME = originalEnkeepDshHome;
    } else {
      delete process.env.ENKEEP_DSH_HOME;
    }

    if (originalDshHome !== undefined) {
      process.env.DSH_HOME = originalDshHome;
    } else {
      delete process.env.DSH_HOME;
    }

    if (originalNodeEnv !== undefined) {
      process.env.NODE_ENV = originalNodeEnv;
    } else {
      delete process.env.NODE_ENV;
    }

    try {
      fs.rmSync(tempBaseDir, { recursive: true, force: true });
    } catch {}

    vi.restoreAllMocks();
  });

  function createValidDshHome(targetDir: string, useSubdir = false): string {
    const dir = useSubdir ? path.join(targetDir, 'profiles', 'web') : targetDir;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), SYNTHETIC_CORDIS_PATCH_YML, 'utf8');
    fs.writeFileSync(path.join(targetDir, 'settings.yaml'), SYNTHETIC_SETTINGS_YAML, 'utf8');
    fs.writeFileSync(path.join(targetDir, '.env'), SYNTHETIC_ENV, 'utf8');
    return targetDir;
  }

  describe('resolvePlatformDshHome', () => {
    it('uses explicit customDshHome parameter first', () => {
      process.env.ENKEEP_DSH_HOME = '/tmp/enkeep-home';
      process.env.DSH_HOME = '/tmp/dsh-home';
      const resolved = resolvePlatformDshHome('/tmp/explicit-custom-home');
      expect(resolved).toBe(path.resolve('/tmp/explicit-custom-home'));
    });

    it('prefers ENKEEP_DSH_HOME over DSH_HOME when both are set', () => {
      process.env.ENKEEP_DSH_HOME = '/tmp/preferred-enkeep-home';
      process.env.DSH_HOME = '/tmp/fallback-dsh-home';
      const resolved = resolvePlatformDshHome();
      expect(resolved).toBe(path.resolve('/tmp/preferred-enkeep-home'));
    });

    it('falls back to DSH_HOME when ENKEEP_DSH_HOME is unset', () => {
      process.env.DSH_HOME = '/tmp/fallback-dsh-home';
      const resolved = resolvePlatformDshHome();
      expect(resolved).toBe(path.resolve('/tmp/fallback-dsh-home'));
    });

    it('returns null when neither is set (never falls back to ~/.dsh)', () => {
      const resolved = resolvePlatformDshHome();
      expect(resolved).toBeNull();
    });
  });

  describe('loadDshDeploymentConfig - explicit dir used', () => {
    it('loads configuration successfully when passed explicit customDshHome temp dir', () => {
      const validHome = createValidDshHome(path.join(tempBaseDir, 'valid-home'));
      const config = loadDshDeploymentConfig(validHome);

      expect(config).not.toBeNull();
      expect(config?.dshHome).toBe(validHome);
      expect(config?.providers['synthetic-provider']).toBeDefined();
      expect(config?.tokens['SYNTHETIC_TOKEN']).toBe('synthetic-secret-token-12345');
    });

    it('loads configuration via ENKEEP_DSH_HOME environment variable', () => {
      const validHome = createValidDshHome(path.join(tempBaseDir, 'enkeep-home'), true);
      process.env.ENKEEP_DSH_HOME = validHome;

      const config = loadDshDeploymentConfig();
      expect(config).not.toBeNull();
      expect(config?.dshHome).toBe(validHome);
      expect(config?.providers['synthetic-provider']).toBeDefined();
    });

    it('loads configuration via fallback DSH_HOME when ENKEEP_DSH_HOME is unset', () => {
      const validHome = createValidDshHome(path.join(tempBaseDir, 'dsh-fallback-home'));
      process.env.DSH_HOME = validHome;

      const config = loadDshDeploymentConfig();
      expect(config).not.toBeNull();
      expect(config?.dshHome).toBe(validHome);
      expect(config?.providers['synthetic-provider']).toBeDefined();
    });
  });

  describe('loadDshDeploymentConfig - production fail-closed behavior', () => {
    it('fails loudly when neither ENKEEP_DSH_HOME nor DSH_HOME is set in production mode', () => {
      expect(() => {
        loadDshDeploymentConfig(undefined, { isProduction: true });
      }).toThrow(/FAIL-CLOSED: ENKEEP_DSH_HOME or DSH_HOME environment variable is mandatory in production mode/);

      process.env.NODE_ENV = 'production';
      expect(() => {
        loadDshDeploymentConfig();
      }).toThrow(/FAIL-CLOSED: ENKEEP_DSH_HOME or DSH_HOME environment variable is mandatory in production mode/);
    });

    it('fails loudly when configured directory does not exist in production mode', () => {
      const nonExistent = path.join(tempBaseDir, 'does-not-exist');
      process.env.ENKEEP_DSH_HOME = nonExistent;

      expect(() => {
        loadDshDeploymentConfig(undefined, { isProduction: true });
      }).toThrow(/FAIL-CLOSED: Configured DSH home directory does not exist/);
    });

    it('fails loudly when configured directory lacks required configuration files in production mode', () => {
      const emptyDir = path.join(tempBaseDir, 'empty-home');
      fs.mkdirSync(emptyDir, { recursive: true });
      process.env.ENKEEP_DSH_HOME = emptyDir;

      expect(() => {
        loadDshDeploymentConfig(undefined, { isProduction: true });
      }).toThrow(/FAIL-CLOSED: DSH home directory ".*" lacks required configuration files/);
    });
  });

  describe('loadDshDeploymentConfig - test/dev graceful behavior', () => {
    it('returns null when env is missing in test mode (NODE_ENV=test)', () => {
      process.env.NODE_ENV = 'test';
      const config = loadDshDeploymentConfig();
      expect(config).toBeNull();
    });

    it('returns null when directory is missing in test mode', () => {
      process.env.NODE_ENV = 'test';
      const config = loadDshDeploymentConfig(path.join(tempBaseDir, 'missing'));
      expect(config).toBeNull();
    });
  });

  describe('Zero read of os.homedir()/.dsh', () => {
    it('never invokes os.homedir() during resolvePlatformDshHome or loadDshDeploymentConfig', () => {
      const homedirSpy = vi.spyOn(os, 'homedir');

      // 1. resolvePlatformDshHome with no env
      resolvePlatformDshHome();
      expect(homedirSpy).not.toHaveBeenCalled();

      // 2. loadDshDeploymentConfig with no env in test mode
      process.env.NODE_ENV = 'test';
      const result = loadDshDeploymentConfig();
      expect(result).toBeNull();
      expect(homedirSpy).not.toHaveBeenCalled();

      // 3. parseDshConfigFiles without dshHome parameter
      const parsed = parseDshConfigFiles(SYNTHETIC_CORDIS_PATCH_YML);
      expect(parsed.dshHome).toBe('');
      expect(homedirSpy).not.toHaveBeenCalled();
    });

    it('never invokes os.homedir() in LlmProxyHandler getActiveConfig', () => {
      const homedirSpy = vi.spyOn(os, 'homedir');

      // Handler with customProviders and customTokens
      const handler = createLlmProxyHandler({
        providers: {
          'synthetic-provider': {
            api: 'openai-completions',
            baseURL: 'https://synthetic.example.com',
          },
        },
        tokens: {
          SYNTHETIC_TOKEN: 'token-abc',
        },
      });

      // Internal call to getActiveConfig
      const activeConfig = (handler as any).getActiveConfig();
      expect(activeConfig).toBeDefined();
      expect(activeConfig.dshHome).not.toContain('.dsh');
      expect(homedirSpy).not.toHaveBeenCalled();
    });
  });
});
