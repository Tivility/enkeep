/**
 * Core Types & Interfaces for Enkeep Demo Runner
 *
 * @module @enkeep/demo-runner/types
 */

import type { ExecutionMode, Space, User } from '@enkeep/platform-core';
import type { SafeDockerClient } from '@enkeep/runtime-runner';
import type { RuntimeContainerPort } from './ports/index.js';

export type DemoEnvironmentRole = 'admin' | 'user' | 'disabled';
export type DemoRunnerMode = 'production' | 'test';

export interface DemoUserConfig {
  userId: string;
  username: string;
  role: DemoEnvironmentRole;
  displayName: string;
  containerName: string;
  volumeName: string;
  defaultSpaceFolder: string;
}

export interface DemoCredentials {
  admin: { username: string; password: string };
  user: { username: string; password: string };
  disabledUser: { username: string; password: string };
}

export interface SignedProcessMetadata {
  schemaVersion: 1;
  service: string;
  pid: number;
  port?: number;
  url?: string;
  startedAt: string;
  owner: 'enkeep-demo';
  appTag?: string;
  commandToken: string;
  signature: string;
  runId: string;
  startTime: string;
  command: string;
  liveStartTimeToken?: string;
  ownershipNonce?: string;
  details?: Record<string, unknown>;
}

export interface SignedContainerMetadata {
  schemaVersion: 1;
  userId: string;
  containerName: string;
  containerId: string; // Mandatory full 64-hex SHA-256
  image: string;
  volumeName: string;
  volumeId: string; // Mandatory stable volume ID
  labels: Record<string, string>;
  startedAt: string;
  owner: 'enkeep-demo';
  appTag?: string;
  runId: string; // Mandatory runId
  commandToken?: string;
  signature: string;
  status?: 'running' | 'stopped' | 'unknown';
}

export interface SignedVolumeMetadata {
  schemaVersion: 1;
  userId: string;
  volumeName: string;
  volumeId: string; // Mandatory stable volume ID
  labels: Record<string, string>;
  createdAt: string;
  owner: 'enkeep-demo';
  appTag?: string;
  runId: string; // Mandatory runId
  signature: string;
}

export interface DemoPathConfig {
  repoRoot: string;
  dataRoot: string;
  demoDataDir: string;
  pidsDir: string;
  containersDir: string;
  volumesDir: string;
  dbPath: string;
  spacesDir: string;
  sessionsDir: string;
  importDir: string;
  fixturesDbPath: string;
  fixturesGroupsDir: string;
}

export interface DemoPathOptions {
  repoRoot?: string;
  dataRoot?: string;
  mode?: DemoRunnerMode;
  resourceSuffix?: string;
}

export interface DemoResetOptions extends DemoPathOptions {
  forceClean?: boolean;
  deterministicCreatedAt?: string;
  checkActiveResources?: boolean;
  rotateSecret?: boolean;
  dockerClient?: SafeDockerClient;
  processInspector?: ProcessInspector;
  processKiller?: ProcessKiller;
}

export interface DemoResetResult {
  ok: boolean;
  timestamp: string;
  demoDataDir: string;
  dbPath: string;
  credentials: DemoCredentials;
  users: {
    admin: User;
    user: User;
    disabledUser: User;
  };
  spaces: {
    aliceContainerSpace: Space | { id: string; name: string; folder: string; executionMode: ExecutionMode };
    bobContainerSpace: Space | { id: string; name: string; folder: string; executionMode: ExecutionMode };
  };
  importedChatsCount: number;
  importedMessagesCount: number;
  manifestPath: string;
}

export interface DemoUpOptions extends DemoPathOptions {
  platformPort?: number; // 0 or explicit safe loopback port
  runtimeImage?: string;
  timeoutMs?: number;
  runtimeAdapter?: RuntimeContainerPort;
  hostRuntimeAdapter?: RuntimeContainerPort;
  allowHostRuntime?: boolean;
  llmEnabled?: boolean;
  llmProvider?: string;
  llmModel?: string;
  autoRecover?: boolean;
  gitSourcePolicy?: import('@enkeep/platform-server').GitSourcePolicy;
  gitCredentialResolver?: import('@enkeep/platform-server').GitCredentialResolverPort;
  webhookSecurityOptions?: import('@enkeep/platform-server').WebhookSecurityOptions;
  spacesDir?: string;
  dshHome?: string;
  bundledSkillDir?: string;
  mountReconciler?: import('@enkeep/platform-core').RuntimeMountReconciler;
  spaceMountService?: import('@enkeep/platform-server').SpaceMountService;
  extensionService?: import('@enkeep/platform-server').ExtensionService;
  browserService?: import('@enkeep/platform-core').BrowserService;
  browserOptions?: import('@enkeep/platform-service-browser').BrowserServiceOptions | boolean;
  mcpService?: import('@enkeep/platform-core').PlatformProxyMcpService;
  externalInteractionService?: import('@enkeep/dsh-external-interaction').IExternalInteractionService;
  larkTestCredentialsFile?: string;
  larkCredentialResolver?: import('@enkeep/channel-lark').LarkCredentialResolver;
  larkTransportFactory?: import('@enkeep/platform-server').LarkTransportFactory;
  larkDefaultSpaceResolver?: import('@enkeep/platform-server').LarkDefaultSpaceResolver;
}

export interface DemoServiceEndpoint {
  name: string;
  role: string;
  endpoint: string;
  transport: 'http' | 'docker-exec' | 'uds' | 'host-process';
  url?: string;
  host?: string;
  port?: number;
  pid?: number;
  containerId?: string;
  status: 'healthy' | 'starting' | 'stopped' | 'error';
}

export interface DemoUpResult {
  ok: boolean;
  timestamp: string;
  platform: DemoServiceEndpoint;
  runtimes: {
    alice?: DemoServiceEndpoint;
    bob?: DemoServiceEndpoint;
    [key: string]: DemoServiceEndpoint | undefined;
  };
  endpoints: Record<string, string>;
  metadata: {
    processes: SignedProcessMetadata[];
    containers: SignedContainerMetadata[];
  };
  users?: Array<{
    username: string;
    userId: string;
    containerName: string;
  }>;
}

export interface ProcessInspector {
  getProcessInfo(pid: number): Promise<{
    exists: boolean;
    startTime?: string;
    command?: string;
    pid: number;
  }>;
}

export interface ProcessKiller {
  kill(pid: number, signal: NodeJS.Signals | number): void;
}

export interface DemoDownOptions extends DemoPathOptions {
  removeVolumes?: boolean;
  graceTimeoutMs?: number;
  dockerClient?: SafeDockerClient;
  processInspector?: ProcessInspector;
  processKiller?: ProcessKiller;
}

export interface TerminatedResource {
  type: 'process' | 'container' | 'volume';
  name: string;
  id?: string | number;
  status: 'terminated' | 'already_stopped' | 'failed';
  error?: string;
}

export interface DemoDownResult {
  ok: boolean;
  timestamp: string;
  terminatedProcesses: TerminatedResource[];
  terminatedContainers: TerminatedResource[];
  removedVolumes: TerminatedResource[];
  cleanedMetadataCount: number;
}

export interface ProbeSnapshot {
  target: string;
  port: number;
  reachable: boolean;
  httpStatus?: number;
  httpFingerprint?: string;
  listenerPid?: number;
  command?: string;
  timestamp: string;
}

export interface StepResult {
  stepId: string;
  name: string;
  passed: boolean;
  durationMs: number;
  details?: Record<string, unknown>;
  error?: string;
}

export interface DemoTestOptions extends DemoPathOptions {
  platformPort?: number;
  verbose?: boolean;
  runtimeAdapter?: RuntimeContainerPort;
  runtimeImage?: string;
}

export interface DemoTestReport {
  ok: boolean;
  timestamp: string;
  totalDurationMs: number;
  probeBefore: {
    port3000: ProbeSnapshot;
    port3080: ProbeSnapshot;
  };
  probeAfter: {
    port3000: ProbeSnapshot;
    port3080: ProbeSnapshot;
  };
  probesUnchanged: boolean;
  steps: StepResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
  };
}

export interface SanitizedProcessMetadata {
  service: string;
  pid: number;
  port?: number;
  url?: string;
  startedAt: string;
  owner: 'enkeep-demo';
  runId: string;
  command?: string;
}

export interface SanitizedContainerMetadata {
  userId: string;
  containerName: string;
  containerId: string;
  image: string;
  volumeName: string;
  volumeId: string;
  labels: Record<string, string>;
  startedAt: string;
  owner: 'enkeep-demo';
  runId: string;
  status?: 'running' | 'stopped' | 'unknown';
}

export interface DemoStatusOptions extends DemoPathOptions {}

export interface DemoStatusResult {
  ok: boolean;
  timestamp: string;
  platformRunning: boolean;
  platformEndpoint?: string;
  processes: SanitizedProcessMetadata[];
  containers: SanitizedContainerMetadata[];
  activePortBindings: number[];
}
