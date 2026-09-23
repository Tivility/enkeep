/**
 * Feishu / Lark CLI Scoped Binding Bridge & Verification
 *
 * Implements:
 * 1. Feishu CLI tool detection without affecting non-Feishu binaries.
 * 2. Strict prevention of user-supplied `--config` argument overriding bound identity.
 * 3. Resolution of host-mediated LarkScopedConfigProvider from options or Cordis context.
 * 4. Fail-closed tenant context and container mode validation.
 *
 * @module @enkeep/dsh-tool-cli/feishu-bridge
 */

import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionCliContributionActivation, LarkScopedConfigProvider } from './types.js';
import { ConfigOverrideProhibitedError } from './errors.js';

/**
 * Checks whether a contribution or registered tool represents a Feishu / Lark CLI command.
 */
export function isFeishuCliTool(
  contrib: ExtensionCliContributionActivation,
  toolName: string
): boolean {
  const name = (contrib.name ?? '').toLowerCase();
  const cmd = (contrib.command ?? '').toLowerCase();
  const key = (contrib.contributionKey ?? '').toLowerCase();
  const script = (contrib.script ?? '').toLowerCase();
  const rel = (contrib.artifactRelPath ?? '').toLowerCase();
  const tName = (toolName ?? '').toLowerCase();

  return (
    name === 'feishu-cli' ||
    name === 'feishu' ||
    name === 'lark-cli' ||
    name === 'lark' ||
    cmd === 'feishu-cli' ||
    cmd === 'feishu' ||
    key === 'feishu_cli' ||
    key === 'feishu-cli' ||
    key === 'lark-cli' ||
    key === 'lark' ||
    tName === 'cli__feishu_cli__run' ||
    tName === 'cli__feishu__run' ||
    tName === 'cli__lark_cli__run' ||
    tName === 'cli__lark__run' ||
    rel.includes('feishu-cli') ||
    script.includes('feishu-cli')
  );
}

/**
 * Ensures user/model supplied arguments do not contain `--config` or `-c`,
 * preventing any attempt to override the tenant's bound identity.
 */
export function assertNoConfigOverride(args: readonly string[]): void {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--config' || arg === '-c' || arg.startsWith('--config=')) {
      throw new ConfigOverrideProhibitedError(
        `User-supplied "${arg}" argument is forbidden on bound Feishu CLI tool to protect tenant binding identity`
      );
    }
  }
}

/**
 * Resolves the LarkScopedConfigProvider from options or Cordis context.
 */
export function resolveLarkScopedConfigProvider(
  ctx: Context,
  options?: { larkScopedConfigProvider?: LarkScopedConfigProvider }
): LarkScopedConfigProvider | undefined {
  if (options?.larkScopedConfigProvider) {
    return options.larkScopedConfigProvider;
  }

  if (ctx.get) {
    const p = ctx.get('larkScopedConfigProvider');
    if (typeof p === 'function') return p as LarkScopedConfigProvider;
    if (p && typeof (p as any).resolveScopedConfig === 'function') {
      return ((p as any).resolveScopedConfig.bind(p)) as LarkScopedConfigProvider;
    }
  }

  const ctxAny = ctx as any;
  if (typeof ctxAny.larkScopedConfigProvider === 'function') {
    return ctxAny.larkScopedConfigProvider;
  }
  if (ctxAny.larkScopedConfigProvider && typeof ctxAny.larkScopedConfigProvider.resolveScopedConfig === 'function') {
    return ctxAny.larkScopedConfigProvider.resolveScopedConfig.bind(ctxAny.larkScopedConfigProvider);
  }

  if (typeof ctxAny.root?.get === 'function') {
    const rootP = ctxAny.root.get('larkScopedConfigProvider');
    if (typeof rootP === 'function') return rootP as LarkScopedConfigProvider;
    if (rootP && typeof (rootP as any).resolveScopedConfig === 'function') {
      return ((rootP as any).resolveScopedConfig.bind(rootP)) as LarkScopedConfigProvider;
    }
  }

  if (typeof ctxAny.root?.larkScopedConfigProvider === 'function') {
    return ctxAny.root.larkScopedConfigProvider;
  }

  return undefined;
}
