/**
 * DSH Model Configuration Loader & Safe Projection
 *
 * Reads DSH deployment configuration from local $DSH_HOME (read-only).
 * Strictly guarantees:
 * - Read-only: never modifies, creates, or writes to ~/.dsh files.
 * - Zero credential leakage: baseURL, token, apiKey, and apiKeyEnv are completely excluded from safe projections.
 * - Credential status is exposed solely as boolean configured: true | false.
 * - Fail-safe: if DSH configuration is missing or malformed, falls back gracefully.
 *
 * @module @enkeep/platform-server/config/dsh-model-config
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import YAML from 'yaml';
import type {
  SafeDshModel,
  SafeDshProvider,
  ModelConfigSafeProjection,
  SafeModelOverride,
} from '../management/types.js';

export interface RawDshModelConfig {
  providers: Record<string, SafeDshProvider>;
  defaultModel: {
    provider: string;
    model: string;
    reasoningEffort?: string;
  };
}

/**
 * Parses simple .env text into key-value pairs without side effects.
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
 * Parses DSH deployment configuration files into safe in-memory provider and model descriptors.
 *
 * @param patchYmlContent - YAML content of cordis.patch.yml
 * @param settingsYamlContent - Optional YAML content of settings.yaml
 * @param envContent - Optional content of .env file
 */
export function parseDshConfigToSafeModels(
  patchYmlContent: string,
  settingsYamlContent?: string,
  envContent?: string
): RawDshModelConfig {
  let patchParsed: unknown;
  try {
    patchParsed = YAML.parse(patchYmlContent);
  } catch {
    return {
      providers: {},
      defaultModel: { provider: '', model: '' },
    };
  }

  if (!Array.isArray(patchParsed)) {
    return {
      providers: {},
      defaultModel: { provider: '', model: '' },
    };
  }

  // Parse env tokens
  const envTokens = envContent ? parseEnvContent(envContent) : {};

  // Find id: llm-pi-ai entry
  const piAiEntry = patchParsed.find(
    (e: unknown): e is { id: string; config?: { providers?: Record<string, Record<string, unknown>> } } =>
      typeof e === 'object' && e !== null && 'id' in e && (e as { id: string }).id === 'llm-pi-ai'
  );

  const rawProviders = piAiEntry?.config?.providers;
  const safeProviders: Record<string, SafeDshProvider> = {};

  if (rawProviders && typeof rawProviders === 'object') {
    for (const [providerKey, rawP] of Object.entries(rawProviders)) {
      if (!rawP || typeof rawP !== 'object') continue;

      const apiKeyEnv = typeof rawP.apiKeyEnv === 'string' ? rawP.apiKeyEnv : undefined;
      const directToken = typeof rawP.token === 'string' ? rawP.token : (typeof rawP.apiKey === 'string' ? rawP.apiKey : undefined);

      // Check if credentials are configured (WITHOUT leaking values or env names)
      let isConfigured = false;
      if (directToken && directToken.trim().length > 0) {
        isConfigured = true;
      } else if (apiKeyEnv) {
        const envVal = envTokens[apiKeyEnv] ?? process.env[apiKeyEnv];
        if (envVal && envVal.trim().length > 0) {
          isConfigured = true;
        }
      }

      // Safe models list
      const rawModels = Array.isArray(rawP.models) ? rawP.models : [];
      const safeModels: SafeDshModel[] = [];

      for (const m of rawModels) {
        if (!m || typeof m !== 'object' || !m.id || typeof m.id !== 'string') continue;
        safeModels.push({
          id: m.id,
          name: typeof m.name === 'string' ? m.name : undefined,
          description: typeof m.description === 'string' ? m.description : undefined,
          contextWindow: typeof m.contextWindow === 'number' ? m.contextWindow : undefined,
          maxTokens: typeof m.maxTokens === 'number' ? m.maxTokens : undefined,
          inputModalities: Array.isArray(m.inputModalities) ? m.inputModalities.filter((x: unknown) => typeof x === 'string') : undefined,
          reasoningEfforts: m.reasoningEfforts && typeof m.reasoningEfforts === 'object' ? (m.reasoningEfforts as Record<string, string | null | undefined>) : undefined,
        });
      }

      safeProviders[providerKey] = {
        id: providerKey,
        displayName: typeof rawP.displayName === 'string' ? rawP.displayName : providerKey,
        api: typeof rawP.api === 'string' ? rawP.api : 'openai-completions',
        configured: isConfigured,
        defaultContextWindow: typeof rawP.defaultContextWindow === 'number' ? rawP.defaultContextWindow : undefined,
        defaultMaxTokens: typeof rawP.defaultMaxTokens === 'number' ? rawP.defaultMaxTokens : undefined,
        defaultInput: Array.isArray(rawP.defaultInput) ? rawP.defaultInput.filter((x: unknown) => typeof x === 'string') : undefined,
        compat: rawP.compat && typeof rawP.compat === 'object' ? (rawP.compat as Record<string, unknown>) : undefined,
        models: safeModels,
      };
    }
  }

  // Parse default model: precedence settings.yaml > cordis.patch.yml (id: agent-default-model) > first provider
  const firstProviderKey = Object.keys(safeProviders)[0] || '';
  const firstModelId = safeProviders[firstProviderKey]?.models[0]?.id || '';

  let defaultModel = {
    provider: firstProviderKey,
    model: firstModelId,
    reasoningEffort: undefined as string | undefined,
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
    const defaultModelEntry = patchParsed.find(
      (e: unknown): e is { id: string; config?: { provider?: string; model?: string; reasoningEffort?: string } } =>
        typeof e === 'object' && e !== null && 'id' in e && (e as { id: string }).id === 'agent-default-model'
    );
    if (defaultModelEntry?.config?.provider && defaultModelEntry?.config?.model) {
      defaultModel = {
        provider: String(defaultModelEntry.config.provider),
        model: String(defaultModelEntry.config.model),
        reasoningEffort: defaultModelEntry.config.reasoningEffort ? String(defaultModelEntry.config.reasoningEffort) : undefined,
      };
    }
  }

  return {
    providers: safeProviders,
    defaultModel,
  };
}

/**
 * Loads DSH configuration from disk ($DSH_HOME) in a strictly read-only manner.
 *
 * @param customDshHome - Optional explicit directory override
 */
export function loadDshSafeModelConfig(customDshHome?: string): RawDshModelConfig {
  const dshHome = customDshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

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
    return {
      providers: {},
      defaultModel: { provider: '', model: '' },
    };
  }

  try {
    const patchContent = fs.readFileSync(patchPath, 'utf8');

    const settingsPath = path.join(dshHome, 'settings.yaml');
    let settingsContent: string | undefined;
    if (fs.existsSync(settingsPath)) {
      try {
        settingsContent = fs.readFileSync(settingsPath, 'utf8');
      } catch {}
    }

    const envPath = path.join(dshHome, '.env');
    let envContent: string | undefined;
    if (fs.existsSync(envPath)) {
      try {
        envContent = fs.readFileSync(envPath, 'utf8');
      } catch {}
    }

    return parseDshConfigToSafeModels(patchContent, settingsContent, envContent);
  } catch {
    return {
      providers: {},
      defaultModel: { provider: '', model: '' },
    };
  }
}

/**
 * Combines DSH configuration with platform database overrides to form the complete safe projection.
 */
export function buildSafeModelProjection(
  dshConfig: RawDshModelConfig,
  overrideRow: {
    provider: string | null;
    model: string | null;
    reasoning_effort: string | null;
    fallback_chain?: string | null;
    updated_by: string | null;
    updated_at: string | null;
  } | null | undefined,
  restartRequired?: boolean,
  healthSummaries?: any[]
): ModelConfigSafeProjection {
  const dshDefault = dshConfig.defaultModel;

  let safeOverride: SafeModelOverride | null = null;
  let effectiveDefault = { ...dshDefault };

  let parsedFallbackChain: any[] | null = null;
  if (overrideRow?.fallback_chain) {
    try {
      parsedFallbackChain = typeof overrideRow.fallback_chain === 'string' ? JSON.parse(overrideRow.fallback_chain) : overrideRow.fallback_chain;
    } catch {}
  }

  if (overrideRow && (overrideRow.provider || overrideRow.model)) {
    safeOverride = {
      provider: overrideRow.provider,
      model: overrideRow.model,
      reasoningEffort: overrideRow.reasoning_effort,
      fallbackChain: parsedFallbackChain,
      updatedBy: overrideRow.updated_by,
      updatedAt: overrideRow.updated_at,
    };

    if (overrideRow.provider && overrideRow.model) {
      effectiveDefault = {
        provider: overrideRow.provider,
        model: overrideRow.model,
        reasoningEffort: overrideRow.reasoning_effort || undefined,
      };
    }
  }

  const revisionPayload = JSON.stringify({
    provider: safeOverride?.provider ?? null,
    model: safeOverride?.model ?? null,
    reasoningEffort: safeOverride?.reasoningEffort ?? null,
    fallbackChain: safeOverride?.fallbackChain ?? null,
    updatedAt: safeOverride?.updatedAt ?? null,
  });
  const revision = crypto.createHash('sha256').update(revisionPayload, 'utf8').digest('hex');

  return {
    providers: dshConfig.providers,
    defaultModel: effectiveDefault,
    dshDefaultModel: dshDefault,
    override: safeOverride,
    healthSummaries: healthSummaries ?? [],
    revision,
    restartRequired: restartRequired ?? false,
  };
}
