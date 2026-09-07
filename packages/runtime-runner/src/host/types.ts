/**
 * Host Runtime Types and Specifications
 *
 * Defines the contract boundaries for local OS process execution under Enkeep supervision.
 *
 * @module @enkeep/runtime-runner/host/types
 */

import type { RuntimeMountSpec } from '../spec/types.js';
import type { PlatformProxyHandler, PlatformProxyOptions } from '../tunnel/platform-proxy.js';
import type { BrowserService } from '@enkeep/platform-core';

export interface HostPlatformProxyPort {
  getBaseUrl(): string;
  getAuthToken?(): string;
  setHandler?(handler: PlatformProxyHandler | null): void;
  close?(): Promise<void>;
}

export interface HostRuntimeSpec {
  readonly executionMode: 'host';
  /** User identifier (e.g. 'alice', 'bob') */
  readonly userId: string;
  /** Random run identifier (e.g. 'run_...') */
  readonly runId: string;
  /** Storage identifier (e.g. 'vol_...') */
  readonly storageId: string;
  /** Root directory for Enkeep data */
  readonly dataRoot: string;
  /** Generated and isolated DSH_HOME directory (<dataRoot>/host-runtimes/<userId>/.dsh) */
  readonly dshHome: string;
  /** Generated and isolated spaces directory (<dataRoot>/host-runtimes/<userId>/spaces) */
  readonly spacesDir: string;
  /** Generated private run directory (<dataRoot>/host-runtimes/<userId>/run) mode 0700 */
  readonly runDir: string;
  /** Path to Unix domain socket (<runDir>/daemon.sock) */
  readonly socketPath: string;
  /** Controlled host mounts */
  readonly mounts?: readonly RuntimeMountSpec[];
  /** Base URL for platform LLM proxy */
  readonly llmBaseUrl?: string;
  /** Cryptographically random 32-byte authorization token for LLM proxy */
  readonly llmProxyToken?: string;
  /** Base URL for platform proxy */
  readonly platformBaseUrl?: string;
  /** Cryptographically random 32-byte authorization token for platform proxy */
  readonly platformProxyToken?: string;
  /** Optional platform proxy port/server instance or options */
  readonly platformProxyPort?: HostPlatformProxyPort;
  readonly platformProxyOptions?: PlatformProxyOptions;
  readonly platformProxyHandler?: PlatformProxyHandler;
  readonly browserService?: BrowserService;
  readonly platformUserId?: string;
  /** Filtered environment variables (strict allowlist with placeholders) */
  readonly environment: Record<string, string>;
  /** Whether real LLM is enabled */
  readonly llmEnabled?: boolean;
  /** LLM provider identifier (e.g. 'cpa-gemini') */
  readonly llmProvider?: string;
  /** LLM model identifier (e.g. 'gemini-3.7-flash-tiered') */
  readonly llmModel?: string;
  /** JSON string or record of provider configs */
  readonly llmProviders?: string | Record<string, unknown>;
  /** Max agents kept warm in daemon (default: 16) */
  readonly maxAgents?: number;
  /** Idle agent timeout in ms (default: 1,800,000 / 30m) */
  readonly idleAgentTimeoutMs?: number;
  /** Max concurrent session turns (default: 4) */
  readonly maxConcurrentSessions?: number;
}

export interface HostUserSpecOptions {
  userId: 'alice' | 'bob' | (string & {});
  dataRoot: string;
  runId?: string;
  storageId?: string;
  llmEnabled?: boolean;
  llmProvider?: string;
  llmModel?: string;
  llmProviders?: string | Record<string, unknown>;
  llmBaseUrl?: string;
  llmProxyToken?: string;
  platformBaseUrl?: string;
  platformProxyToken?: string;
  platformProxyPort?: HostPlatformProxyPort;
  platformProxyOptions?: PlatformProxyOptions;
  platformProxyHandler?: PlatformProxyHandler;
  browserService?: BrowserService;
  platformUserId?: string;
  maxAgents?: number;
  idleAgentTimeoutMs?: number;
  maxConcurrentSessions?: number;
  mounts?: readonly RuntimeMountSpec[];
  extraEnv?: Record<string, string>;
}

export interface HostProcessMetadata {
  readonly pid: number;
  readonly startTime: number;
  readonly nonce: string;
  readonly userId: string;
  readonly runId: string;
  readonly storageId: string;
  readonly paths: {
    readonly dshHome: string;
    readonly spacesDir: string;
    readonly runDir: string;
    readonly socketPath: string;
  };
  readonly createdAt: string;
  readonly signature: string;
}

export interface HostRuntimeAdapterOptions {
  daemonCliPath?: string;
  secretKey?: string;
}
