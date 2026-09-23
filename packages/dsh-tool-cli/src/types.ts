/**
 * Type definitions for CLI Tool Subsystem
 *
 * @module @enkeep/dsh-tool-cli/types
 */

import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { ExtensionActivationPlan, ExtensionCliContributionActivation } from '@enkeep/protocol';

export type { ExtensionActivationPlan, ExtensionCliContributionActivation };

export interface LarkSafeAccountMetadata {
  readonly accountId: string;
  readonly credentialRef?: string;
  readonly displayName?: string;
  readonly appId?: string;
  readonly brand?: string;
  readonly boundSpaceId?: string;
  readonly status?: string;
}

export interface LarkScopedConfigHandle {
  readonly configPath: string;
  readonly dirPath?: string;
  readonly appId?: string;
  readonly domain?: string;
  readonly metadata?: LarkSafeAccountMetadata;
  dispose(): Promise<void>;
}

export interface LarkScopedConfigOptions {
  readonly userId: string;
  readonly spaceId?: string;
  readonly channelAccountId?: string;
  readonly trustedContext?: unknown;
  readonly channelBindingSource?: unknown;
  readonly channelRepo?: unknown;
  readonly db?: unknown;
  readonly resolver?: unknown;
  readonly scratchRoot?: string;
  readonly baseDir?: string;
  readonly strict?: boolean;
}

export type LarkScopedConfigProvider = (
  options: LarkScopedConfigOptions
) => Promise<LarkScopedConfigHandle | null>;

export interface CliPluginConfig {
  /** Default execution timeout in ms (default: 15000) */
  defaultTimeoutMs?: number;
  /** Max output buffer size in bytes (default: 1048576 = 1MB) */
  maxOutputBytes?: number;
  /** Host platform service provider for Lark/Feishu scoped CLI configurations */
  larkScopedConfigProvider?: LarkScopedConfigProvider;
  /** Minimal configuration toggle for bound Feishu CLI tool execution (default: true) */
  boundFeishuCli?: boolean;
}

export interface CliMountOptions {
  spacePath?: string;
  spaceId?: string;
  userId?: string;
  sessionId?: string;
  channelAccountId?: string;
  executionMode?: 'container' | 'host' | 'space';
  defaultTimeoutMs?: number;
  maxOutputBytes?: number;
  larkScopedConfigProvider?: LarkScopedConfigProvider;
  boundFeishuCli?: boolean;
}

export interface CliMountHandle {
  readonly registeredTools: ReadonlyMap<string, ToolDefinition>;
  dispose(): Promise<void>;
}

export interface CliToolCallInput {
  args?: string[];
}

export interface CliToolCallOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}
