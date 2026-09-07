/**
 * Typed Cordis Bundle Composition for Enkeep Runtime
 *
 * Provides typed bundle composition and entry factories for the 9 atomic Enkeep plugins:
 * 1. @enkeep/dsh-receipt-store-sqlite (receipt-store)
 * 2. @enkeep/dsh-inbound (inbound)
 * 3. @enkeep/dsh-event-relay (event-relay)
 * 4. @enkeep/dsh-tools (enkeep-tools)
 * 5. @enkeep/dsh-external-interaction (enkeep-external-interaction)
 * 6. @enkeep/dsh-affinity-policy (enkeep-affinity-policy)
 * 7. @tivility/dsh-llm-affinity (llm-affinity)
 * 8. @enkeep/dsh-tool-browser (browser-tools)
 * 9. @enkeep/dsh-mcp-governance (mcp-governance)
 *
 * @module @enkeep/dsh-enkeep-bundle
 */

import path from 'node:path';
import type { Context, Fiber } from '@deepseek-ai/cordis';

import * as receiptStorePlugin from '@enkeep/dsh-receipt-store-sqlite';
import * as inboundPlugin from '@enkeep/dsh-inbound';
import * as eventRelayPlugin from '@enkeep/dsh-event-relay';
import * as toolsPlugin from '@enkeep/dsh-tools';
import * as externalInteractionPlugin from '@enkeep/dsh-external-interaction';
import * as affinityPolicyPlugin from '@enkeep/dsh-affinity-policy';
import * as llmAffinityPlugin from '@tivility/dsh-llm-affinity';
import * as browserToolsPlugin from '@enkeep/dsh-tool-browser';
import * as mcpGovernancePlugin from '@enkeep/dsh-mcp-governance';
import * as cliToolsPlugin from '@enkeep/dsh-tool-cli';

// Re-export underlying plugin modules for consumer convenience
export {
  receiptStorePlugin,
  inboundPlugin,
  eventRelayPlugin,
  toolsPlugin,
  externalInteractionPlugin,
  affinityPolicyPlugin,
  llmAffinityPlugin,
  browserToolsPlugin,
  mcpGovernancePlugin,
  cliToolsPlugin,
};

export const USER_ID_PATTERN = /^[A-Za-z0-9_\-:.]{1,128}$/;
export const CONFIG_COMPONENT_ID_PATTERN = /^[A-Za-z0-9_\-:.]{1,128}$/;

/**
 * Options required to compose the typed Enkeep runtime bundle.
 */
export interface EnkeepRuntimeBundleOptions {
  /**
   * Root directory for DSH runtime state and data.
   * MUST be an absolute, normalized path.
   */
  readonly dshHome: string;
  /**
   * Explicit non-empty canonical user identifier.
   */
  readonly userId: string;
  /**
   * Working spaces directory.
   * MANDATORY, MUST be an absolute, normalized path that is a sibling of dshHome (e.g. /home/dsh/.dsh and /home/dsh/spaces).
   */
  readonly spacesDir: string;
}

/**
 * Common shape of a typed Cordis bundle plugin entry.
 */
export interface EnkeepBundleEntry<TId extends string, TPlugin, TConfig> {
  readonly id: TId;
  readonly name: string;
  readonly plugin: TPlugin;
  readonly config: TConfig;
}

export type ReceiptStoreEntry = EnkeepBundleEntry<'receipt-store', typeof receiptStorePlugin, receiptStorePlugin.Config>;
export type InboundEntry = EnkeepBundleEntry<'inbound', typeof inboundPlugin, inboundPlugin.Config>;
export type EventRelayEntry = EnkeepBundleEntry<'event-relay', typeof eventRelayPlugin, eventRelayPlugin.Config>;
export type ToolsEntry = EnkeepBundleEntry<'enkeep-tools', typeof toolsPlugin, toolsPlugin.Config>;
export type ExternalInteractionEntry = EnkeepBundleEntry<'enkeep-external-interaction', typeof externalInteractionPlugin, externalInteractionPlugin.Config>;
export type AffinityPolicyEntry = EnkeepBundleEntry<'enkeep-affinity-policy', typeof affinityPolicyPlugin, affinityPolicyPlugin.Config>;
export type LlmAffinityEntry = EnkeepBundleEntry<'llm-affinity', typeof llmAffinityPlugin, llmAffinityPlugin.Config>;
export type BrowserToolsEntry = EnkeepBundleEntry<'browser-tools', typeof browserToolsPlugin, browserToolsPlugin.Config>;
export type McpGovernanceEntry = EnkeepBundleEntry<'mcp-governance', typeof mcpGovernancePlugin, mcpGovernancePlugin.Config>;
export type CliToolsEntry = EnkeepBundleEntry<'cli-tools', typeof cliToolsPlugin, cliToolsPlugin.Config>;

/**
 * Exact discriminated union of all 10 atomic Enkeep bundle plugin entries.
 */
export type AnyEnkeepBundleEntry =
  | ReceiptStoreEntry
  | InboundEntry
  | EventRelayEntry
  | ToolsEntry
  | ExternalInteractionEntry
  | AffinityPolicyEntry
  | LlmAffinityEntry
  | BrowserToolsEntry
  | McpGovernanceEntry
  | CliToolsEntry;

/**
 * Exact ordered 10-tuple of Enkeep bundle plugin entries.
 */
export type EnkeepBundleEntriesTuple = readonly [
  ReceiptStoreEntry,
  InboundEntry,
  EventRelayEntry,
  ToolsEntry,
  ExternalInteractionEntry,
  AffinityPolicyEntry,
  LlmAffinityEntry,
  BrowserToolsEntry,
  McpGovernanceEntry,
  CliToolsEntry,
];

const ALLOWED_BUNDLE_OPTION_KEYS = new Set(['dshHome', 'userId', 'spacesDir']);

/**
 * Type guard for plain object records without `as any` casting.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates that a string is a strictly absolute and normalized path (no relative segments, no dot traversal).
 */
export function isNormalizedAbsolutePath(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0) {
    return false;
  }
  return path.isAbsolute(p) && path.normalize(p) === p;
}

/**
 * Validates and normalizes runtime bundle options.
 * Rejects relative paths, arbitrary non-sibling spaces directories, missing parameters, and unknown keys.
 */
export function validateEnkeepBundleOptions(options: unknown): {
  dshHome: string;
  userId: string;
  spacesDir: string;
} {
  if (!isRecord(options)) {
    throw new TypeError('EnkeepRuntimeBundle options must be a non-null plain object');
  }

  for (const key of Object.keys(options)) {
    if (!ALLOWED_BUNDLE_OPTION_KEYS.has(key)) {
      throw new TypeError(`Unexpected option key: "${key}". Allowed keys: dshHome, userId, spacesDir`);
    }
  }

  // 1. userId validation
  const rawUserId = options.userId;
  if (typeof rawUserId !== 'string' || rawUserId.length === 0 || rawUserId.length > 128 || !USER_ID_PATTERN.test(rawUserId)) {
    throw new TypeError(`Invalid or missing "userId": "${String(rawUserId)}". Must match pattern ${USER_ID_PATTERN}`);
  }
  const userId = rawUserId;

  // 2. dshHome validation (mandatory absolute normalized path)
  const rawDshHome = options.dshHome;
  if (typeof rawDshHome !== 'string' || !isNormalizedAbsolutePath(rawDshHome)) {
    throw new TypeError(`Invalid or missing "dshHome": "${String(rawDshHome)}". Must be a non-empty absolute normalized path`);
  }
  const dshHome = rawDshHome;

  // 3. spacesDir validation (mandatory absolute normalized path, must be sibling under common parent)
  const rawSpacesDir = options.spacesDir;
  if (typeof rawSpacesDir !== 'string' || !isNormalizedAbsolutePath(rawSpacesDir)) {
    throw new TypeError(`Invalid or missing "spacesDir": "${String(rawSpacesDir)}". Must be a non-empty absolute normalized path`);
  }
  const spacesDir = rawSpacesDir;

  const dshParent = path.dirname(dshHome);
  const spacesParent = path.dirname(spacesDir);
  if (dshParent !== spacesParent || path.basename(spacesDir) !== 'spaces') {
    throw new TypeError(
      `"spacesDir" ("${spacesDir}") must be a sibling directory under dirname(dshHome) ("${dshParent}") and named "spaces", got parent "${spacesParent}"`
    );
  }

  return { dshHome, userId, spacesDir };
}

/**
 * 1. Receipt Store Entry Factory
 */
export function createReceiptStoreEntry(dshHome: string, userId: string): ReceiptStoreEntry {
  if (!isNormalizedAbsolutePath(dshHome)) {
    throw new TypeError(`createReceiptStoreEntry requires an absolute normalized dshHome: got "${dshHome}"`);
  }
  return {
    id: 'receipt-store',
    name: '@enkeep/dsh-receipt-store-sqlite',
    plugin: receiptStorePlugin,
    config: {
      path: path.join(dshHome, 'data', 'receipts.db'),
      busyTimeoutMs: 5000,
      userId,
    },
  };
}

/**
 * 2. Inbound Entry Factory
 */
export function createInboundEntry(): InboundEntry {
  return {
    id: 'inbound',
    name: '@enkeep/dsh-inbound',
    plugin: inboundPlugin,
    config: {
      defaultTarget: 'followup',
    },
  };
}

/**
 * 3. Event Relay Entry Factory
 */
export function createEventRelayEntry(): EventRelayEntry {
  return {
    id: 'event-relay',
    name: '@enkeep/dsh-event-relay',
    plugin: eventRelayPlugin,
    config: {
      maxBufferSize: 1000,
    },
  };
}

/**
 * 4. Tools Entry Factory
 */
export function createToolsEntry(spacesDir: string): ToolsEntry {
  if (!isNormalizedAbsolutePath(spacesDir)) {
    throw new TypeError(`createToolsEntry requires an absolute normalized spacesDir: got "${spacesDir}"`);
  }
  return {
    id: 'enkeep-tools',
    name: '@enkeep/dsh-tools',
    plugin: toolsPlugin,
    config: {
      maxFileSizeBytes: 10485760, // 10MB
      workspaceBoundaryRoot: spacesDir,
      workspaceRoot: spacesDir,
    },
  };
}

/**
 * 5. External Interaction Entry Factory
 */
export function createExternalInteractionEntry(): ExternalInteractionEntry {
  return {
    id: 'enkeep-external-interaction',
    name: '@enkeep/dsh-external-interaction',
    plugin: externalInteractionPlugin,
    config: {
      defaultTimeoutMs: 60000,
    },
  };
}

/**
 * 6. Affinity Policy Entry Factory
 */
export function createAffinityPolicyEntry(): AffinityPolicyEntry {
  return {
    id: 'enkeep-affinity-policy',
    name: '@enkeep/dsh-affinity-policy',
    plugin: affinityPolicyPlugin,
    config: {
      strict: true,
      exemptAuxiliary: false,
    },
  };
}

/**
 * 7. LLM Affinity Entry Factory
 */
export function createLlmAffinityEntry(): LlmAffinityEntry {
  return {
    id: 'llm-affinity',
    name: '@tivility/dsh-llm-affinity',
    plugin: llmAffinityPlugin,
    config: {
      header: 'X-Session-ID',
    },
  };
}

/**
 * 8. Browser Tools Entry Factory
 */
export function createBrowserToolsEntry(): BrowserToolsEntry {
  return {
    id: 'browser-tools',
    name: '@enkeep/dsh-tool-browser',
    plugin: browserToolsPlugin,
    config: {
      maxSnapshotLength: 65536,
      defaultTimeoutMs: 30000,
    },
  };
}

/**
 * 9. MCP Governance Entry Factory
 */
export function createMcpGovernanceEntry(): McpGovernanceEntry {
  return {
    id: 'mcp-governance',
    name: '@enkeep/dsh-mcp-governance',
    plugin: mcpGovernancePlugin,
    config: {
      defaultTimeoutMs: 60000,
      maxInlineBytes: 65536,
    },
  };
}

/**
 * 10. CLI Tools Entry Factory
 */
export function createCliToolsEntry(): CliToolsEntry {
  return {
    id: 'cli-tools',
    name: '@enkeep/dsh-tool-cli',
    plugin: cliToolsPlugin,
    config: {
      defaultTimeoutMs: 15000,
      maxOutputBytes: 1048576,
    },
  };
}

/**
 * Composes the exact authoritative list of 10 typed Enkeep Cordis plugin entries
 * in mandatory composition order:
 * 1. receipt-store
 * 2. inbound
 * 3. event-relay
 * 4. enkeep-tools
 * 5. enkeep-external-interaction
 * 6. enkeep-affinity-policy
 * 7. llm-affinity
 * 8. browser-tools
 * 9. mcp-governance
 * 10. cli-tools
 *
 * @param options - Validated dshHome, userId, and spacesDir
 * @returns Readonly tuple of 10 typed plugin entries
 */
export function createEnkeepRuntimeBundle(
  options: EnkeepRuntimeBundleOptions
): EnkeepBundleEntriesTuple {
  const { dshHome, userId, spacesDir } = validateEnkeepBundleOptions(options);

  return [
    createReceiptStoreEntry(dshHome, userId),
    createInboundEntry(),
    createEventRelayEntry(),
    createToolsEntry(spacesDir),
    createExternalInteractionEntry(),
    createAffinityPolicyEntry(),
    createLlmAffinityEntry(),
    createBrowserToolsEntry(),
    createMcpGovernanceEntry(),
    createCliToolsEntry(),
  ] as const;
}

function assertNever(x: never): never {
  throw new Error(`Unexpected bundle entry: ${JSON.stringify(x)}`);
}

/**
 * Applies a single typed bundle entry to a Cordis context via a discriminated switch
 * calling exact module functions with zero `as any` casting.
 */
export function applyBundleEntry(
  ctx: Context,
  entry: AnyEnkeepBundleEntry
): Fiber & PromiseLike<Fiber> {
  switch (entry.id) {
    case 'receipt-store':
      return ctx.plugin(entry.plugin.apply, entry.config);
    case 'inbound':
      return ctx.plugin(entry.plugin.apply, entry.config);
    case 'event-relay':
      return ctx.plugin(entry.plugin.apply, entry.config);
    case 'enkeep-tools':
      return ctx.plugin(entry.plugin.apply, entry.config);
    case 'enkeep-external-interaction':
      return ctx.plugin(entry.plugin.apply, entry.config);
    case 'enkeep-affinity-policy':
      return ctx.plugin(entry.plugin.apply, entry.config);
    case 'llm-affinity':
      return ctx.plugin(entry.plugin.apply, entry.config);
    case 'browser-tools':
      return ctx.plugin(entry.plugin.apply, entry.config);
    case 'mcp-governance':
      return ctx.plugin(entry.plugin.apply, entry.config);
    case 'cli-tools':
      return ctx.plugin(entry.plugin.apply, entry.config);
    default:
      return assertNever(entry);
  }
}

/**
 * Applies all entries in an Enkeep bundle list to a Cordis context in order.
 * Returns the list of mounted fibers.
 * If any entry fails, disposes all previously mounted fibers in reverse order before propagating the error.
 */
export async function applyEnkeepBundle(
  ctx: Context,
  entries: readonly AnyEnkeepBundleEntry[]
): Promise<Fiber[]> {
  const mountedFibers: Fiber[] = [];

  try {
    for (const entry of entries) {
      const fiber = await applyBundleEntry(ctx, entry);
      mountedFibers.push(fiber);
    }
    return mountedFibers;
  } catch (err: unknown) {
    const rollbackErrors: Error[] = [];
    for (let i = mountedFibers.length - 1; i >= 0; i--) {
      try {
        const f = mountedFibers[i];
        if (f && typeof f.dispose === 'function') {
          await f.dispose();
        }
      } catch (disposeErr: unknown) {
        rollbackErrors.push(
          disposeErr instanceof Error ? disposeErr : new Error(String(disposeErr))
        );
      }
    }

    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [err, ...rollbackErrors],
        `Failed to mount bundle entry and encountered errors during rollback: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    throw err;
  }
}
