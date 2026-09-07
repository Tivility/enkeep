/**
 * Authoritative Compiled Trusted DSH Plugin Registry
 *
 * Implements:
 * 1. Strict compiled-in trusted plugin registry (no user-uploaded plugin code, no marketplace).
 * 2. Static mapping of trustedPluginId, version, and integrity hash.
 * 3. Standard built-in plugin `enkeep.echo` registering `plugin__trusted-echo__echo`.
 * 4. Test failing plugin `enkeep.test-failing` included only in test environment for error recovery testing.
 * 5. Deterministic validation helper for fail-closed runtime verification.
 *
 * @module @enkeep/dsh-enkeep-bundle/trusted-registry
 */

import { createHash } from 'node:crypto';
import type { Context, Fiber } from '@deepseek-ai/cordis';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';

export interface TrustedPluginManifest {
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly tool?: string;
  readonly [key: string]: unknown;
}

export interface TrustedPluginDefinition {
  readonly trustedPluginId: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly version: number;
  readonly integritySha256: string;
  readonly manifest: TrustedPluginManifest;
  readonly apply: (ctx: Context, config?: unknown) => void | Promise<void> | Fiber;
}

function computeManifestHash(manifest: Record<string, unknown>): string {
  const json = JSON.stringify(manifest, Object.keys(manifest).sort());
  return createHash('sha256').update(json, 'utf8').digest('hex');
}

/**
 * 1. Standard Built-in Plugin: enkeep.echo
 */
const ECHO_MANIFEST: TrustedPluginManifest = Object.freeze({
  name: 'Trusted Echo',
  description: 'Trusted DSH Plugin that echoes input text with PLUGIN: prefix',
  whenToUse: 'Use when instructed to echo text via trusted echo plugin',
  tool: 'plugin__trusted-echo__echo',
});

const ECHO_INTEGRITY = computeManifestHash(ECHO_MANIFEST as Record<string, unknown>);

export function applyTrustedEchoPlugin(ctx: Context): void {
  const toolDef: ToolDefinition = defineTool({
    name: 'plugin__trusted-echo__echo',
    description: 'Echoes input text prefixed with PLUGIN:',
    parameters: {
      text: {
        type: 'string',
        description: 'Text string to echo',
        required: true,
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          result: {
            type: 'string',
            required: true,
          },
        },
        additionalProperties: false,
      },
      render: (_args, value) => {
        return [{ type: 'text', text: value.result }];
      },
    },
    execute: async (args) => {
      if (!args || typeof args.text !== 'string') {
        throw new Error('Parameter "text" is required and must be a string');
      }
      return { result: `PLUGIN:${args.text}` };
    },
  });

  const toolsService = ctx.get('tools');
  if (!toolsService || typeof toolsService.register !== 'function') {
    throw new Error('Trusted echo plugin activation failed: "tools" registry service is unavailable on Context');
  }

  ctx.effect(() => toolsService.register(toolDef), 'enkeep.echo.tools()');
}

export const TRUSTED_ECHO_PLUGIN: TrustedPluginDefinition = Object.freeze({
  trustedPluginId: 'enkeep.echo',
  slug: 'trusted-echo',
  name: 'Trusted Echo',
  description: 'Trusted DSH Plugin that echoes input text with PLUGIN: prefix',
  version: 1,
  integritySha256: ECHO_INTEGRITY,
  manifest: ECHO_MANIFEST,
  apply: applyTrustedEchoPlugin,
});

/**
 * 2. Test Failing Plugin: enkeep.test-failing (Test environment only)
 */
const TEST_FAILING_MANIFEST: TrustedPluginManifest = Object.freeze({
  name: 'Test Failing Plugin',
  description: 'Test plugin that throws during activation for safety and error recovery testing',
  whenToUse: 'Internal testing only',
});

const TEST_FAILING_INTEGRITY = computeManifestHash(TEST_FAILING_MANIFEST as Record<string, unknown>);

export function applyTestFailingPlugin(_ctx: Context): void {
  throw new Error('Simulated plugin activation failure in enkeep.test-failing');
}

export const TRUSTED_TEST_FAILING_PLUGIN: TrustedPluginDefinition = Object.freeze({
  trustedPluginId: 'enkeep.test-failing',
  slug: 'test-failing',
  name: 'Test Failing Plugin',
  description: 'Test plugin that throws during activation for safety and error recovery testing',
  version: 1,
  integritySha256: TEST_FAILING_INTEGRITY,
  manifest: TEST_FAILING_MANIFEST,
  apply: applyTestFailingPlugin,
});

/**
 * Checks if current environment is a test environment.
 */
function isTestEnvironment(): boolean {
  return (
    process.env.NODE_ENV === 'test' ||
    process.env.VITEST === 'true' ||
    Boolean(process.env.TEST_INCLUDE_FAILING_PLUGIN)
  );
}

/**
 * Authoritative compiled list of trusted plugin definitions.
 */
export function getCompiledTrustedPluginRegistry(): readonly TrustedPluginDefinition[] {
  const plugins: TrustedPluginDefinition[] = [TRUSTED_ECHO_PLUGIN];
  if (isTestEnvironment()) {
    plugins.push(TRUSTED_TEST_FAILING_PLUGIN);
  }
  return Object.freeze(plugins);
}

/**
 * Retrieves a trusted plugin by ID or slug.
 */
export function getTrustedPlugin(idOrSlug: string): TrustedPluginDefinition | undefined {
  if (!idOrSlug || typeof idOrSlug !== 'string') return undefined;
  const registry = getCompiledTrustedPluginRegistry();
  return registry.find((p) => p.trustedPluginId === idOrSlug || p.slug === idOrSlug);
}

/**
 * Lists all compiled trusted plugin definitions.
 */
export function listTrustedPlugins(): readonly TrustedPluginDefinition[] {
  return getCompiledTrustedPluginRegistry();
}

/**
 * Strictly validates a plugin activation descriptor against the compiled registry.
 * Fails closed if the plugin is unknown, or if version / integrity hash mismatch.
 */
export function validateTrustedPluginDescriptor(descriptor: {
  trustedPluginId: string;
  version: number;
  integrity: string;
}): TrustedPluginDefinition {
  if (!descriptor || typeof descriptor !== 'object') {
    throw new Error('FAIL-CLOSED: Invalid plugin descriptor: must be a non-null object');
  }

  const plugin = getTrustedPlugin(descriptor.trustedPluginId);
  if (!plugin) {
    throw new Error(
      `FAIL-CLOSED: Unknown or unverified trusted plugin ID "${descriptor.trustedPluginId}". Only pre-compiled image plugins are permitted.`
    );
  }

  if (plugin.version !== descriptor.version) {
    throw new Error(
      `FAIL-CLOSED: Plugin version mismatch for "${descriptor.trustedPluginId}": expected version ${plugin.version}, got ${descriptor.version}.`
    );
  }

  if (plugin.integritySha256 !== descriptor.integrity) {
    throw new Error(
      `FAIL-CLOSED: Plugin integrity checksum mismatch for "${descriptor.trustedPluginId}": expected "${plugin.integritySha256}", got "${descriptor.integrity}".`
    );
  }

  return plugin;
}
