/**
 * Type definitions for CLI Tool Subsystem
 *
 * @module @enkeep/dsh-tool-cli/types
 */

import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { ExtensionActivationPlan, ExtensionCliContributionActivation } from '@enkeep/protocol';

export type { ExtensionActivationPlan, ExtensionCliContributionActivation };

export interface CliPluginConfig {
  /** Default execution timeout in ms (default: 15000) */
  defaultTimeoutMs?: number;
  /** Max output buffer size in bytes (default: 1048576 = 1MB) */
  maxOutputBytes?: number;
}

export interface CliMountOptions {
  spacePath?: string;
  spaceId?: string;
  userId?: string;
  sessionId?: string;
  defaultTimeoutMs?: number;
  maxOutputBytes?: number;
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
