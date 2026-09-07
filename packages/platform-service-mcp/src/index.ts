/**
 * Enkeep Platform Service MCP Package
 *
 * Provides Host MCP Manager, Stdio/HTTP Transports, Security Policy Guards,
 * Process Pool, SSRF Guards, and PlatformProxy MCP StreamHandler for Tunnel kind: 'mcp'.
 *
 * @module @enkeep/platform-service-mcp
 */

// Types & Interfaces
export {
  DEFAULT_TOOL_TIMEOUT_MS,
  DEFAULT_INIT_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_CIRCUIT_FAILURE_THRESHOLD,
  DEFAULT_CIRCUIT_RESET_TIMEOUT_MS,
} from './types.js';

export type {
  McpServerTransportType,
  McpCredentialRef,
  McpResolvedCredentials,
  CredentialResolverPort,
  McpContributionSource,
  McpServerBaseDescriptor,
  McpStdioServerDescriptor,
  McpHttpServerDescriptor,
  McpServerDescriptor,
  McpStdioContributionManifest,
  McpHttpContributionManifest,
  McpContributionManifest,
  McpToolDefinition,
  McpToolContent,
  McpToolCallResult,
  McpContext,
  McpEffectivePlan,
  McpEffectivePlanProvider,
  McpCatalogProvider,
  McpServerHealth,
  McpGatewayPort,
  McpAuditEvent,
  McpAuditHook,
  McpUsageMetric,
  McpUsageMetricsCallback,
  McpManagerOptions,
} from './types.js';

// Error Hierarchy & Sanitizer
export {
  McpErrorCode,
  type McpErrorOptions,
  McpServiceError,
  isMcpServiceError,
  sanitizeMcpError,
} from './errors.js';

// Security Subsystem
export {
  InMemoryCredentialResolver,
  isSensitiveKey,
  redactSecret,
  redactObject,
} from './security/credential-resolver.js';

export {
  DEFAULT_ALLOWED_ENV_VARS,
  DANGEROUS_ENV_PREFIXES,
  isDangerousEnvVar,
  type EnvFilterOptions,
  filterChildEnvironment,
} from './security/env-filter.js';

export {
  DEFAULT_ALLOWED_EXECUTABLE_NAMES,
  FORBIDDEN_SHELL_NAMES,
  type ExecutableValidationOptions,
  type ManifestValidationOptions,
  validateExecutable,
  validateMcpContributionManifest,
} from './security/executable-guard.js';

export {
  FORBIDDEN_HTTP_HEADERS,
  isPrivateIPv4,
  isPrivateIPv6,
  validateSsrfTargetUrl,
  sanitizeHttpHeaders,
} from './security/ssrf-guard.js';

export {
  DEFAULT_MAX_IMAGE_BYTES,
  ALLOWED_IMAGE_MIME_TYPES,
  sanitizeString,
  sanitizeToolContent,
  sanitizeToolCallResult,
  normalizeInputSchema,
} from './security/sanitizer.js';

// Transport Subsystem
export {
  type SpawnerOptions,
  type SpawnedProcessInfo,
  spawnHardenedChildProcess,
} from './transport/stdio-spawner.js';

export {
  type HttpClientTransportOptions,
  createHardenedHttpTransport,
} from './transport/http-client.js';

// Pooling & Reliability
export {
  type CircuitState,
  type CircuitBreakerOptions,
  CircuitBreaker,
} from './pool/circuit-breaker.js';

export {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_PROCESSES_PER_TENANT,
  DEFAULT_MAX_TOTAL_PROCESSES,
  type PooledConnection,
  type ProcessPoolOptions,
  killProcessTree,
  McpProcessPool,
} from './pool/process-pool.js';

// Manager
export { HostMcpManager } from './manager.js';

// Canonical Tool Naming & Sanitization
export {
  CANONICAL_PREFIX,
  ALLOWED_SLUG_PATTERN,
  ALLOWED_RAW_TOOL_PATTERN,
  type ParsedCanonicalToolName,
  toContributionKeySlug,
  sanitizeRawToolName,
  buildCanonicalToolName,
  isValidCanonicalToolName,
  parseCanonicalToolName,
} from './naming.js';

