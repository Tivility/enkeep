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

export interface DshDeploymentConfig {
  dshHome: string;
  providers: Record<string, DshParsedProvider>;
  defaultModel: DshParsedDefaultModel;
  tokens: Record<string, string>;
  allowedHosts: string[];
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
  patchYmlContent: string,
  settingsYamlContent?: string,
  envContent?: string,
  dshHome = path.join(os.homedir(), '.dsh')
): DshDeploymentConfig {
  const patchParsed: unknown = YAML.parse(patchYmlContent);
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

  const providers: Record<string, DshParsedProvider> = {};
  const allowedHostsSet = new Set<string>();

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
  } else {
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

  return {
    dshHome,
    providers,
    defaultModel,
    tokens,
    allowedHosts: Array.from(allowedHostsSet),
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
    return null;
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
