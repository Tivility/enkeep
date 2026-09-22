/**
 * DSH Deployment Configuration Loader (Read-Only)
 *
 * Single source of truth for model and provider configurations:
 * Reads $DSH_HOME/profiles/web/cordis.patch.yml (or $DSH_HOME/cordis.patch.yml)
 * and $DSH_HOME/settings.yaml and $DSH_HOME/.env into memory.
 *
 * Invariants:
 * - Read-only: never modifies or writes back to disk.
 * - Zero secret leakage: tokens are loaded into memory only, never printed in logs,
 *   never exposed in health status or error envelopes.
 * - Fails gracefully with null if configuration files are missing.
 *
 * @module @enkeep/runtime-runner/config/dsh-config-loader
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import type { RuntimeNetworkMode } from '../spec/types.js';

export interface DshParsedModel {
  id: string;
  name?: string;
  description?: string;
  contextWindow?: number;
  maxTokens?: number;
  inputModalities?: string[];
  reasoningEfforts?: Record<string, string | null | undefined>;
  [key: string]: unknown;
}

export interface DshParsedProvider {
  displayName?: string;
  apiKeyEnv?: string;
  api: 'anthropic-messages' | 'openai-completions' | string;
  baseURL: string;
  defaultContextWindow?: number;
  defaultMaxTokens?: number;
  defaultInput?: string[];
  compat?: Record<string, unknown>;
  models?: DshParsedModel[];
  [key: string]: unknown;
}

export interface DshParsedDefaultModel {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface DshDeploymentBudgets {
  defaultExecutionBudgetMs?: number;
  defaultIdleTimeoutMs?: number;
}

export interface DshParsedWebSearchConfig {
  readonly apiKeyEnv?: string;
  readonly baseURL?: string;
  readonly model?: string;
  readonly maxUses?: number;
  readonly maxTokens?: number;
  readonly apiVersion?: string;
}

export interface DshParsedWebConfig {
  readonly search?: boolean;
  readonly fetch?: boolean;
  readonly searchProvider?: string;
  readonly fetchProvider?: string;
  readonly searchConfig?: DshParsedWebSearchConfig;
}

export interface DshDeploymentConfig {
  dshHome: string;
  providers: Record<string, DshParsedProvider>;
  defaultModel: DshParsedDefaultModel;
  tokens: Record<string, string>;
  allowedHosts: string[];
  budgets?: DshDeploymentBudgets;
  containerNetworkMode?: RuntimeNetworkMode;
  web?: DshParsedWebConfig;
}

/**
 * Parses a simple .env file text into key-value pairs without external dependencies.
 */
export function parseEnvContent(envText: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!envText || typeof envText !== 'string') {
    return result;
  }

  for (const line of envText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      result[key] = val;
    }
  }
  return result;
}

/**
 * Parses DSH deployment configuration files into typed in-memory structures.
 *
 * @param patchYmlContent - Content of cordis.patch.yml
 * @param settingsYamlContent - Optional content of settings.yaml
 * @param envContent - Optional content of .env file
 * @param dshHome - Path to DSH home directory
 */
export function parseDshConfigFiles(
  patchYmlContent?: string,
  settingsYamlContent?: string,
  envContent?: string,
  dshHome = path.join(os.homedir(), '.dsh')
): DshDeploymentConfig {
  const providers: Record<string, DshParsedProvider> = {};
  const allowedHostsSet = new Set<string>();
  let patchParsed: unknown = undefined;

  if (patchYmlContent && patchYmlContent.trim().length > 0) {
    patchParsed = YAML.parse(patchYmlContent);
    if (!Array.isArray(patchParsed)) {
      throw new Error('Invalid cordis.patch.yml: top-level must be an array of plugin configurations');
    }

    // Find id: llm-pi-ai entry
    const piAiEntry = patchParsed.find(
      (e: unknown): e is { id: string; config?: { providers?: Record<string, DshParsedProvider> } } =>
        typeof e === 'object' && e !== null && 'id' in e && (e as { id: string }).id === 'llm-pi-ai'
    );

    const rawProviders = piAiEntry?.config?.providers;
    if (!rawProviders || typeof rawProviders !== 'object') {
      throw new Error('Invalid cordis.patch.yml: missing id: llm-pi-ai with config.providers');
    }

    for (const [providerKey, providerVal] of Object.entries(rawProviders)) {
      if (!providerVal || typeof providerVal !== 'object') continue;
      const p = providerVal as DshParsedProvider;
      providers[providerKey] = {
        ...p,
        baseURL: p.baseURL,
        api: p.api || 'openai-completions',
      };

      if (p.baseURL && typeof p.baseURL === 'string') {
        try {
          const u = new URL(p.baseURL);
          allowedHostsSet.add(u.hostname.toLowerCase());
        } catch {}
      }
    }
  }

  // Parse default model: precedence settings.yaml > cordis.patch.yml (id: agent-default-model) > first provider
  let defaultModel: DshParsedDefaultModel = {
    provider: Object.keys(providers)[0] || 'cpa-claude',
    model: 'claude-fable-5',
  };

  if (settingsYamlContent) {
    try {
      const settingsParsed = YAML.parse(settingsYamlContent);
      if (
        settingsParsed &&
        typeof settingsParsed === 'object' &&
        'agent-default-model' in settingsParsed &&
        typeof settingsParsed['agent-default-model'] === 'object' &&
        settingsParsed['agent-default-model'] !== null
      ) {
        const adm = settingsParsed['agent-default-model'];
        if (adm.provider && adm.model) {
          defaultModel = {
            provider: String(adm.provider),
            model: String(adm.model),
            reasoningEffort: adm.reasoningEffort ? String(adm.reasoningEffort) : undefined,
          };
        }
      }
    } catch {}
  } else if (Array.isArray(patchParsed)) {
    // Check cordis.patch.yml for id: agent-default-model
    const defaultModelEntry = patchParsed.find(
      (e: unknown): e is { id: string; config?: { provider?: string; model?: string } } =>
        typeof e === 'object' && e !== null && 'id' in e && (e as { id: string }).id === 'agent-default-model'
    );
    if (defaultModelEntry?.config?.provider && defaultModelEntry?.config?.model) {
      defaultModel = {
        provider: String(defaultModelEntry.config.provider),
        model: String(defaultModelEntry.config.model),
      };
    }
  }

  const tokens = envContent ? parseEnvContent(envContent) : {};

  // Parse optional execution budgets from settings.yaml or environment variables
  let budgets: DshDeploymentBudgets | undefined;
  if (settingsYamlContent) {
    try {
      const settingsParsed = YAML.parse(settingsYamlContent);
      if (settingsParsed && typeof settingsParsed === 'object') {
        const eb = (settingsParsed as Record<string, unknown>)['execution-budget'] ||
          (settingsParsed as Record<string, unknown>)['executionBudget'];
        if (eb && typeof eb === 'object') {
          const ebObj = eb as Record<string, unknown>;
          const execBudget = typeof ebObj.defaultExecutionBudgetMs === 'number' ? ebObj.defaultExecutionBudgetMs : undefined;
          const idleTimeout = typeof ebObj.defaultIdleTimeoutMs === 'number' ? ebObj.defaultIdleTimeoutMs : undefined;
          if (execBudget !== undefined || idleTimeout !== undefined) {
            budgets = {
              defaultExecutionBudgetMs: execBudget,
              defaultIdleTimeoutMs: idleTimeout,
            };
          }
        }
      }
    } catch {}
  }

  const envExecBudget = process.env.DSH_DEFAULT_EXECUTION_BUDGET_MS;
  const envIdleTimeout = process.env.DSH_DEFAULT_IDLE_TIMEOUT_MS;
  if (envExecBudget || envIdleTimeout) {
    const parsedExec = envExecBudget ? parseInt(envExecBudget, 10) : undefined;
    const parsedIdle = envIdleTimeout ? parseInt(envIdleTimeout, 10) : undefined;
    budgets = {
      defaultExecutionBudgetMs: Number.isSafeInteger(parsedExec) && parsedExec! > 0 ? parsedExec : budgets?.defaultExecutionBudgetMs,
      defaultIdleTimeoutMs: Number.isSafeInteger(parsedIdle) && parsedIdle! > 0 ? parsedIdle : budgets?.defaultIdleTimeoutMs,
    };
  }

  // Parse optional container network mode from settings.yaml or environment variables
  let containerNetworkMode: RuntimeNetworkMode | undefined;
  if (settingsYamlContent) {
    try {
      const settingsParsed = YAML.parse(settingsYamlContent);
      if (settingsParsed && typeof settingsParsed === 'object') {
        const cnm =
          (settingsParsed as Record<string, unknown>)['container-network-mode'] ||
          (settingsParsed as Record<string, unknown>)['containerNetworkMode'] ||
          ((settingsParsed as Record<string, unknown>)['container-network'] as Record<string, unknown> | undefined)?.mode ||
          ((settingsParsed as Record<string, unknown>)['containerNetwork'] as Record<string, unknown> | undefined)?.mode;
        if (cnm === 'none' || cnm === 'bridge') {
          containerNetworkMode = cnm;
        } else if (cnm !== undefined && cnm !== null) {
          throw new Error(`Invalid container network mode "${String(cnm)}" in settings.yaml: must be "none" or "bridge"`);
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('Invalid container network mode')) {
        throw err;
      }
    }
  }

  const envNetworkMode = process.env.ENKEEP_CONTAINER_NETWORK_MODE || process.env.DSH_CONTAINER_NETWORK_MODE;
  if (envNetworkMode) {
    if (envNetworkMode === 'none' || envNetworkMode === 'bridge') {
      containerNetworkMode = envNetworkMode;
    } else {
      throw new Error(`Invalid container network mode "${envNetworkMode}" in environment: must be "none" or "bridge"`);
    }
  }

  // Parse optional web search & fetch configuration
  let webConfig: DshParsedWebConfig | undefined;

  // 1. settings.yaml (web and web-search-deepseek namespaces)
  if (settingsYamlContent) {
    try {
      const settingsParsed = YAML.parse(settingsYamlContent);
      if (settingsParsed && typeof settingsParsed === 'object') {
        const rawWeb = (settingsParsed as Record<string, unknown>)['web'];
        const rawDeepSeekSearch = (settingsParsed as Record<string, unknown>)['web-search-deepseek'];

        let searchProvider: string | undefined;
        let fetchProvider: string | undefined;
        let searchEnabled: boolean | undefined;
        let fetchEnabled: boolean | undefined;

        if (rawWeb && typeof rawWeb === 'object') {
          const wObj = rawWeb as Record<string, unknown>;
          if (typeof wObj.searchProvider === 'string') searchProvider = wObj.searchProvider;
          if (typeof wObj.fetchProvider === 'string') fetchProvider = wObj.fetchProvider;
          if (typeof wObj.search === 'boolean') searchEnabled = wObj.search;
          if (typeof wObj.fetch === 'boolean') fetchEnabled = wObj.fetch;
        }

        let searchConfig: DshParsedWebSearchConfig | undefined;
        if (rawDeepSeekSearch && typeof rawDeepSeekSearch === 'object') {
          const dsObj = rawDeepSeekSearch as Record<string, unknown>;
          searchConfig = {
            apiKeyEnv: typeof dsObj.apiKeyEnv === 'string' ? dsObj.apiKeyEnv : 'DEEPSEEK_API_KEY',
            baseURL: typeof dsObj.baseURL === 'string' ? dsObj.baseURL : undefined,
            model: typeof dsObj.model === 'string' ? dsObj.model : undefined,
            maxUses: typeof dsObj.maxUses === 'number' ? dsObj.maxUses : undefined,
            maxTokens: typeof dsObj.maxTokens === 'number' ? dsObj.maxTokens : undefined,
            apiVersion: typeof dsObj.apiVersion === 'string' ? dsObj.apiVersion : undefined,
          };
          if (searchConfig.baseURL) {
            try {
              allowedHostsSet.add(new URL(searchConfig.baseURL).hostname.toLowerCase());
            } catch {}
          }
        }

        if (searchProvider || fetchProvider || searchEnabled !== undefined || fetchEnabled !== undefined || searchConfig) {
          webConfig = {
            search: searchEnabled,
            fetch: fetchEnabled,
            searchProvider,
            fetchProvider,
            searchConfig,
          };
        }
      }
    } catch {}
  }

  // 2. cordis.patch.yml entries
  if (Array.isArray(patchParsed)) {
    const webSearchEntry = patchParsed.find(
      (e: unknown): e is { id: string; name?: string; config?: Record<string, unknown> } =>
        typeof e === 'object' && e !== null && 'id' in e && (e as { id: string }).id === 'web-search-deepseek'
    );
    if (webSearchEntry?.config) {
      const c = webSearchEntry.config;
      const deepseekConf: DshParsedWebSearchConfig = {
        apiKeyEnv: typeof c.apiKeyEnv === 'string' ? c.apiKeyEnv : (webConfig?.searchConfig?.apiKeyEnv ?? 'DEEPSEEK_API_KEY'),
        baseURL: typeof c.baseURL === 'string' ? c.baseURL : webConfig?.searchConfig?.baseURL,
        model: typeof c.model === 'string' ? c.model : webConfig?.searchConfig?.model,
        maxUses: typeof c.maxUses === 'number' ? c.maxUses : webConfig?.searchConfig?.maxUses,
        maxTokens: typeof c.maxTokens === 'number' ? c.maxTokens : webConfig?.searchConfig?.maxTokens,
        apiVersion: typeof c.apiVersion === 'string' ? c.apiVersion : webConfig?.searchConfig?.apiVersion,
      };
      if (deepseekConf.baseURL) {
        try {
          allowedHostsSet.add(new URL(deepseekConf.baseURL).hostname.toLowerCase());
        } catch {}
      }
      webConfig = {
        ...webConfig,
        searchProvider: webConfig?.searchProvider ?? 'deepseek-official',
        searchConfig: deepseekConf,
      };
    }

    const webEntry = patchParsed.find(
      (e: unknown): e is { id: string; name?: string; config?: Record<string, unknown> } =>
        typeof e === 'object' && e !== null && 'id' in e && (e as { id: string }).id === 'web'
    );
    if (webEntry?.config) {
      const c = webEntry.config;
      webConfig = {
        ...webConfig,
        searchProvider: typeof c.searchProvider === 'string' ? c.searchProvider : webConfig?.searchProvider,
        fetchProvider: typeof c.fetchProvider === 'string' ? c.fetchProvider : webConfig?.fetchProvider,
      };
    }
  }

  // 3. Operational environment overrides
  const envSearchProvider = process.env.DSH_WEB_SEARCH_PROVIDER;
  const envFetchProvider = process.env.DSH_WEB_FETCH_PROVIDER;
  const envSearchBaseUrl = process.env.DEEPSEEK_SEARCH_BASE_URL;

  if (envSearchProvider || envFetchProvider || envSearchBaseUrl) {
    let searchConfig = webConfig?.searchConfig;
    if (envSearchBaseUrl) {
      searchConfig = {
        ...searchConfig,
        apiKeyEnv: searchConfig?.apiKeyEnv ?? 'DEEPSEEK_API_KEY',
        baseURL: envSearchBaseUrl,
      };
      try {
        allowedHostsSet.add(new URL(envSearchBaseUrl).hostname.toLowerCase());
      } catch {}
    }
    webConfig = {
      ...webConfig,
      searchProvider: envSearchProvider ?? webConfig?.searchProvider,
      fetchProvider: envFetchProvider ?? webConfig?.fetchProvider,
      searchConfig,
    };
  }

  return {
    dshHome,
    providers,
    defaultModel,
    tokens,
    allowedHosts: Array.from(allowedHostsSet),
    budgets,
    containerNetworkMode,
    web: webConfig,
  };
}

/**
 * Loads DSH deployment configuration from filesystem ($DSH_HOME).
 * Read-only; returns null if files are missing or unparseable.
 *
 * @param customDshHome - Optional explicit DSH Home directory (default: process.env.DSH_HOME || '~/.dsh')
 */
export function loadDshDeploymentConfig(customDshHome?: string): DshDeploymentConfig | null {
  const dshHome = customDshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

  // Candidate patch file locations: $DSH_HOME/profiles/web/cordis.patch.yml or $DSH_HOME/cordis.patch.yml
  const candidatePatchPaths = [
    path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml'),
    path.join(dshHome, 'cordis.patch.yml'),
  ];

  let patchPath: string | null = null;
  for (const cp of candidatePatchPaths) {
    if (fs.existsSync(cp)) {
      patchPath = cp;
      break;
    }
  }

  if (!patchPath) {
    const settingsPath = path.join(dshHome, 'settings.yaml');
    const settingsContent = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : undefined;
    const envPath = path.join(dshHome, '.env');
    const envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : undefined;

    if (!settingsContent && !envContent) {
      return null;
    }
    try {
      return parseDshConfigFiles('', settingsContent, envContent, dshHome);
    } catch {
      return null;
    }
  }

  try {
    const patchContent = fs.readFileSync(patchPath, 'utf8');

    const settingsPath = path.join(dshHome, 'settings.yaml');
    const settingsContent = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : undefined;

    const envPath = path.join(dshHome, '.env');
    const envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : undefined;

    return parseDshConfigFiles(patchContent, settingsContent, envContent, dshHome);
  } catch (_err) {
    return null;
  }
}

/**
 * Transforms platform-parsed providers into in-container providers specification.
 * Each provider's baseURL is rewritten to `http://127.0.0.1:8787/llm/<providerKey>`
 * and apiKeyEnv points to placeholder 'IN_CONTAINER_PLACEHOLDER'.
 *
 * @param providers - Real providers table from platform memory
 * @param tunnelBaseUrl - In-container tunnel base URL (default: http://127.0.0.1:8787/llm)
 */
export function createInContainerProvidersSpec(
  providers: Record<string, DshParsedProvider>,
  tunnelBaseUrl = 'http://127.0.0.1:8787/llm'
): Record<string, DshParsedProvider> {
  const inContainerProviders: Record<string, DshParsedProvider> = {};

  for (const [providerKey, provider] of Object.entries(providers)) {
    inContainerProviders[providerKey] = {
      ...provider,
      baseURL: `${tunnelBaseUrl.replace(/\/+$/, '')}/${providerKey}`,
      apiKeyEnv: 'IN_CONTAINER_PLACEHOLDER',
    };
  }

  return inContainerProviders;
}
